/**
 * Auto-link backfill for the SMALL slice of `rsvps` rows that already carry a
 * real identifier (email or a phone with enough digits to be a real number) —
 * the guest-identity project's automated half. The much larger slice of
 * name-only rsvps (no email, no usable phone) is deliberately OUT OF SCOPE
 * here — those need a human to decide "same person" vs "different", which is
 * `identity.ts`'s review queue (`schema/identity.ts#identityDecisions`
 * backs its suppression/resurfacing logic).
 *
 * Base/structure mirrors `migrations/0037_link_rsvp_people.ts` closely (read
 * that file's doc first): same idempotency guard (only rows with
 * `personId === undefined`), same "load one chapter's roster once, thread it
 * through `lib/rsvpPeople.ts#linkRsvpToPersonWithRoster`" shape, same
 * "ONE `.paginate()` PER INVOCATION" rule (hotfix 0037-single-paginate, prod
 * incident 2026-07-24 — Convex hard-fails a function that calls `.paginate()`
 * more than once in one execution; `convex-test` does NOT enforce this at
 * test time, so the ONLY test pattern that actually catches a regression is
 * separate `run()`/mutation calls, never a `for(;;)` loop of `.paginate()`s
 * inside one call).
 *
 * ONE DELIBERATE DIFFERENCE FROM 0037: 0037 requires a HUMAN to manually
 * re-invoke with `{ cursor }` after eyeballing each page's counts, because its
 * job (picking a "winning" name across a shared-inbox household) is exactly
 * the kind of judgment call a human should review before continuing. This
 * migration makes NO such judgment call — every row it touches already
 * carries a real identifier, so `lib/rsvpPeople.ts#findPersonMatch`'s
 * email/phone/name match order resolves it deterministically, with no
 * majority vote and no "leave the minority unlinked" branch. So it's safe to
 * let it run to completion unattended: `linkRsvpIdentifiersPage` self-schedules
 * its own next page via `ctx.scheduler.runAfter` (same continuation shape
 * `migrations.ts`'s `continueXxx` entries use for the auto-registered
 * migrations 0039-0045) whenever `execute: true` and more rows remain. A
 * single manual invocation kicks off the whole backfill; no repeated
 * re-invocation needed.
 *
 * STILL MANUAL / UNREGISTERED, though: this file is NOT imported into
 * `migrations/index.ts`'s `MIGRATIONS` registry, so it never runs
 * automatically via `runPending` on deploy — a human decides when to kick it
 * off, same as 0037. (Auto-continuation once started is a different thing
 * from auto-STARTING — see above.)
 *
 * IDEMPOTENT: a row already linked (`personId !== undefined`) is skipped by
 * construction (`isAutoLinkEligible` below); a re-run after a complete run
 * finds nothing left to link.
 *
 * ELIGIBILITY (never touches a name-only row): `personId === undefined` AND
 * (a non-empty `email`, OR a `phone` with >= 10 digits after stripping
 * non-digits — a loose "is this a real phone number, not a garbled partial"
 * bar). This mirrors `lib/givingDonors.ts#hasPersonIdentifier`'s "email or
 * phone, never name alone" rule but is STRICTER on phone (hasPersonIdentifier
 * accepts any non-empty phone) precisely so this migration's scope stays the
 * ~178-row slice with a genuinely usable identifier — not the wider
 * name-only population `identity.ts`'s human queue exists for.
 *
 * NO DIVERGENT-NAME / MAJORITY-VOTE LOGIC (unlike 0037): every eligible row
 * here has all IT needs to match/create deterministically via
 * `findPersonMatch`'s existing email → phone → name order, so two rows
 * sharing an identifier always converge on the SAME person regardless of
 * processing order — there's no "pick a winner" decision to get wrong.
 *
 * Run locally (dry run, no writes):
 *   npx convex run migrations/0050_link_rsvp_identifiers:backfillLinkRsvpIdentifiers
 * Run locally (execute — runs to completion via self-scheduling):
 *   npx convex run migrations/0050_link_rsvp_identifiers:backfillLinkRsvpIdentifiers '{"execute":true}'
 * Add `--prod` for production (do NOT run against prod without a founder
 * go-ahead — see the task doc this migration shipped with).
 */
import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import type { MutationCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import { linkRsvpToPersonWithRoster } from "../lib/rsvpPeople";
import { chapterRoster } from "../lib/org";

/** Rows read per (single) `.paginate()` call — see the module doc's "ONE
 *  `.paginate()` PER INVOCATION" note. Mirrors 0037's `PAGE_SIZE`. */
const PAGE_SIZE = 500;

/** Digits-only phone — mirrors `dataHygiene.ts#normPhone`. */
function phoneDigits(phone?: string | null): string {
  return (phone ?? "").replace(/\D/g, "");
}

/** True iff this row is in scope for the AUTOMATED backfill — see the module
 *  doc's "ELIGIBILITY" section. Exported so `identity.ts`'s human queue can
 *  define "name-only" as the exact complement of this, keeping the automated
 *  and human scopes from silently drifting apart. */
export function isAutoLinkEligible(r: Doc<"rsvps">): boolean {
  if (r.personId !== undefined) return false;
  if (r.email) return true;
  return phoneDigits(r.phone).length >= 10;
}

export type LinkRsvpIdentifiersStats = {
  scanned: number;
  eligible: number;
  linked: number;
  skipped: number;
  failed: number;
  isDone: boolean;
  continueCursor: string | null;
};

/**
 * Process exactly ONE page — exactly one `.paginate()` call. `pageSize` is a
 * TEST-ONLY override (not exposed on the public mutations below), same
 * convention as 0037/0040-0045.
 */
export async function linkRsvpIdentifiersPage(
  ctx: MutationCtx,
  args: { execute: boolean; cursor: string | null; pageSize?: number },
): Promise<LinkRsvpIdentifiersStats> {
  // ── Exactly ONE `.paginate()` call — see the module doc's banner. ──
  const page = await ctx.db
    .query("rsvps")
    .paginate({ numItems: args.pageSize ?? PAGE_SIZE, cursor: args.cursor });

  const eligible = page.page.filter(isAutoLinkEligible);

  // Group by chapter so each chapter's roster loads (and is mutated with any
  // newly-created contacts) exactly once per page — same read-budget
  // reasoning as 0037's `loadRoster` cache.
  const byChapter = new Map<string, Doc<"rsvps">[]>();
  for (const r of eligible) {
    const key = String(r.chapterId);
    (byChapter.get(key) ?? byChapter.set(key, []).get(key)!).push(r);
  }

  let linked = 0;
  let skipped = 0;
  let failed = 0;

  if (args.execute) {
    for (const rows of byChapter.values()) {
      const chapterId = rows[0].chapterId;
      const roster = await chapterRoster(ctx, chapterId);
      for (const r of rows) {
        // Sequential on purpose: a row that CREATES a contact appends it to
        // `roster` in place, so a later row in this same chapter/page sharing
        // that identifier matches it instead of racing to create a second one.
        const result = await linkRsvpToPersonWithRoster(
          ctx,
          { rsvpId: r._id, chapterId: r.chapterId, name: r.name, email: r.email, phone: r.phone },
          roster,
        );
        if (result.status === "linked") linked++;
        else if (result.status === "skipped") skipped++;
        else failed++;
      }
    }
    if (failed > 0) {
      console.error(
        `migrations/0050_link_rsvp_identifiers: ${failed} row(s) FAILED to link on this page ` +
          `(see individual errors above) — safe to re-run, this migration is idempotent`,
      );
    }
  } else {
    // Dry run: every eligible row has a real identifier
    // (`hasPersonIdentifier` is always true for it — see the module doc), so
    // it will always either match an existing person or create a new one;
    // either way it counts as "linked" in the preview. No writes.
    linked = eligible.length;
  }

  const isDone = page.isDone;
  const result: LinkRsvpIdentifiersStats = {
    scanned: page.page.length,
    eligible: eligible.length,
    linked,
    skipped,
    failed,
    isDone,
    continueCursor: isDone ? null : page.continueCursor,
  };

  // Self-schedule the next page (see the module doc's "ONE DELIBERATE
  // DIFFERENCE FROM 0037") — only on a real (`execute: true`) run; a dry run
  // is a per-invocation preview a human re-drives by hand, same as 0037.
  if (args.execute && !isDone) {
    await ctx.scheduler.runAfter(
      0,
      internal.migrations["0050_link_rsvp_identifiers"].continueLinkRsvpIdentifiers,
      { cursor: page.continueCursor },
    );
  }

  return result;
}

const statsValidator = v.object({
  scanned: v.number(),
  eligible: v.number(),
  linked: v.number(),
  skipped: v.number(),
  failed: v.number(),
  isDone: v.boolean(),
  continueCursor: v.union(v.string(), v.null()),
});

/**
 * Manual entry point — see the module doc for the exact invocation command.
 * Dry-run by default; pass `{ execute: true }` to actually write (and let it
 * self-schedule through to completion).
 */
export const backfillLinkRsvpIdentifiers = internalMutation({
  args: {
    execute: v.optional(v.boolean()),
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  returns: statsValidator,
  handler: async (ctx, args) => {
    return await linkRsvpIdentifiersPage(ctx, {
      execute: args.execute ?? false,
      cursor: args.cursor ?? null,
    });
  },
});

/** Scheduler continuation — drains the rest of the table one bounded page at
 *  a time once `backfillLinkRsvpIdentifiers` kicks it off. Idempotent, so a
 *  redundant fire is a no-op. */
export const continueLinkRsvpIdentifiers = internalMutation({
  args: { cursor: v.union(v.string(), v.null()) },
  returns: statsValidator,
  handler: async (ctx, { cursor }) => {
    return await linkRsvpIdentifiersPage(ctx, { execute: true, cursor });
  },
});
