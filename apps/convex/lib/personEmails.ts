/**
 * Person Emails write-through + send-address resolution (person-centric
 * audiences Phase 2 — specs/person-centric-audiences.md Phase 2 items 1/2).
 * See `schema/people.ts#personEmails`'s module doc for the table shape.
 *
 * `recordPersonEmail` is the ONE choke point every write-through call site
 * uses (mirrors `lib/givingDonors.ts`'s "one primitive, several callers"
 * shape) — additive/upgrade-only, so re-observing a lower-trust source or an
 * unverified flag never regresses an existing row. Every site that writes a
 * person's `email`/`pwEmail`, links a donor/rsvp to a person, or MERGES two
 * person rows must call either this or `repointPersonEmails` below — a
 * `personEmails` gap means a real address silently drops out of audience
 * resolution. Known call sites (audit this list when adding a new one):
 *  - `people.ts`'s `create`/`update` (roster/pw sources, direct edits),
 *  - `lib/givingDonors.ts#linkDonorToPerson` (donor source),
 *  - `lib/rsvpPeople.ts#linkRsvpToPerson` (rsvp source),
 *  - `ai.ts#addPerson` (roster source — the assistant's `add_person` tool),
 *  - `dataHygiene.ts#mergePeople` (blank-fill write-through + repoint),
 *  - `lib/people.ts#mergePersonInto`/`reconcilePersonForUser` (same two,
 *    the login-time roster-reconciliation merge path),
 *  - `personEmails.ts#setPrimaryEmail` (never writes a NEW row — only flips
 *    `isPrimary` on an existing one).
 */
import { Doc, Id } from "../_generated/dataModel";
import { MutationCtx } from "../_generated/server";
import { normalizeEmail } from "./access";
import { PERSON_EMAIL_SOURCES } from "../schema/people";

export type PersonEmailSource = (typeof PERSON_EMAIL_SOURCES)[number];

/** Provenance trust order (highest first) — mirrors `schema/people.ts`'s
 *  `PERSON_EMAIL_SOURCES` doc. `"manual"` outranks everything: a human
 *  explicitly attaching an address is more trustworthy than any automated
 *  match, even though nothing writes that source yet. Exported so
 *  `migrations/0039_backfill_person_emails.ts` picks a winner across MULTIPLE
 *  candidate sources with the exact same order this file's upgrade-only
 *  `recordPersonEmail` uses — one trust order, not two. */
export const SOURCE_RANK: Record<PersonEmailSource, number> = {
  manual: 5,
  pw: 4,
  roster: 3,
  donor: 2,
  rsvp: 1,
};

/**
 * Write-through upsert: record that `email` (normalized) belongs to
 * `personId`, learned from `source`. A no-op when `email` is blank/absent —
 * every call site passes an optional field straight through rather than
 * pre-checking it.
 *
 * UPGRADE-ONLY: if a `personEmails` row for this exact (person, email) pair
 * already exists, it's patched ONLY when the new observation is strictly more
 * trustworthy — `verified` flips false → true (never true → false) and
 * `source` moves to a HIGHER-ranked source (never lower). A later, weaker
 * observation of an address this table already trusts more is silently
 * accepted as a confirmation, not a downgrade. Never touches `isPrimary` —
 * that's exclusively `setPrimaryEmail`'s call.
 */
export async function recordPersonEmail(
  ctx: MutationCtx,
  args: {
    personId: Id<"people">;
    email?: string | null;
    source: PersonEmailSource;
    verified: boolean;
  },
): Promise<void> {
  const email = normalizeEmail(args.email);
  if (!email) return;

  const existing = await ctx.db
    .query("personEmails")
    .withIndex("by_person", (q) => q.eq("personId", args.personId))
    .collect();
  const match = existing.find((e) => e.email === email);

  if (match) {
    const patch: Partial<Doc<"personEmails">> = {};
    if (args.verified && !match.verified) patch.verified = true;
    if (SOURCE_RANK[args.source] > SOURCE_RANK[match.source]) {
      patch.source = args.source;
    }
    if (Object.keys(patch).length > 0) await ctx.db.patch(match._id, patch);
    return;
  }

  await ctx.db.insert("personEmails", {
    personId: args.personId,
    email,
    source: args.source,
    verified: args.verified,
    addedAt: Date.now(),
  });
}

/**
 * Send-address precedence (Phase 2 item 2): explicit `isPrimary` row >
 * `person.pwEmail` > `person.email` > the most-recently-added VERIFIED
 * `personEmails` row > `null` (nothing usable). Pure — no I/O — so preview
 * and send resolution (`lib/audienceResolve.ts`) and
 * `tests/personEmails.test.ts`'s precedence matrix share the exact same
 * decision.
 *
 * The first two tiers read `person`'s own fields directly rather than the
 * `personEmails` rows sourced FROM them, so a person with no `personEmails`
 * rows yet (pre-backfill, or a row inserted outside every write-through path)
 * still resolves correctly off `pwEmail ?? email` — the pre-Phase-2 fallback
 * `lib/audienceResolve.ts#resolvePeople` used to hardcode.
 */
export function resolveSendAddress(
  person: Pick<Doc<"people">, "email" | "pwEmail">,
  emails: Doc<"personEmails">[],
): string | null {
  const primary = emails.find((e) => e.isPrimary === true);
  if (primary) return primary.email;

  const pw = normalizeEmail(person.pwEmail);
  if (pw) return pw;

  const roster = normalizeEmail(person.email);
  if (roster) return roster;

  const verified = emails.filter((e) => e.verified === true);
  if (verified.length > 0) {
    const latest = verified.reduce((a, b) => (b.addedAt > a.addedAt ? b : a));
    return latest.email;
  }

  return null;
}

/**
 * Shared "which candidate is more trustworthy" comparator: `verified` beats
 * unverified FIRST, then higher `SOURCE_RANK`, then earliest `addedAt`
 * (deterministic). Two callers share this — ONE rule, not two:
 *  - `migrations/0039_backfill_person_emails.ts`, picking a winner among
 *    freshly-observed candidates that haven't been written yet;
 *  - `repointPersonEmails` below, picking a winner between two ALREADY-STORED
 *    rows that collide on the same address when two people merge.
 */
export function pickMoreTrustworthy<
  T extends { verified: boolean; source: PersonEmailSource; addedAt: number },
>(a: T, b: T): T {
  if (a.verified !== b.verified) return a.verified ? a : b;
  if (SOURCE_RANK[a.source] !== SOURCE_RANK[b.source]) {
    return SOURCE_RANK[a.source] > SOURCE_RANK[b.source] ? a : b;
  }
  return a.addedAt <= b.addedAt ? a : b;
}

/**
 * Re-point every `personEmails` row from `dup` onto `surv` when two person
 * rows are merged (`dataHygiene.ts#mergePeople`, `lib/people.ts#mergePersonInto`
 * via `reconcilePersonForUser`) — the shared fix for the SAME gap in both
 * merge implementations: neither used to touch this table at all, so a
 * deleted duplicate's ledger rows went orphaned (dangling `personId`) and any
 * address known ONLY through the duplicate (e.g. a donor/rsvp-sourced row
 * that never touched `people.email`) silently vanished from audience
 * resolution.
 *
 * A row whose email the SURVIVOR doesn't already know is simply re-pointed.
 * A row that COLLIDES with an address the survivor already has is resolved
 * with `pickMoreTrustworthy` (the same rule the 0039 backfill uses): the
 * losing row is deleted rather than left as a second row for one address.
 * Either way, `isPrimary` is ALWAYS cleared on whichever row lands on the
 * survivor via a repoint — a duplicate's (or the losing row's) primary pick
 * must never silently become the survivor's, and the survivor never ends up
 * with two `isPrimary: true` rows.
 */
export async function repointPersonEmails(
  ctx: MutationCtx,
  args: { dup: Id<"people">; surv: Id<"people"> },
): Promise<{ moved: number; merged: number }> {
  const dupRows = await ctx.db
    .query("personEmails")
    .withIndex("by_person", (q) => q.eq("personId", args.dup))
    .collect();
  if (dupRows.length === 0) return { moved: 0, merged: 0 };

  const survRows = await ctx.db
    .query("personEmails")
    .withIndex("by_person", (q) => q.eq("personId", args.surv))
    .collect();
  const survByEmail = new Map(survRows.map((r) => [r.email, r]));

  let moved = 0;
  let merged = 0;
  for (const row of dupRows) {
    const existing = survByEmail.get(row.email);
    if (!existing) {
      await ctx.db.patch(row._id, { personId: args.surv, isPrimary: undefined });
      survByEmail.set(row.email, { ...row, personId: args.surv, isPrimary: undefined });
      moved++;
      continue;
    }
    // Collision: the survivor already has a row for this exact address. Keep
    // whichever of the two is more trustworthy; delete the other outright
    // rather than carry two rows for one address.
    const winner = pickMoreTrustworthy(row, existing);
    if (winner === row) {
      await ctx.db.patch(row._id, { personId: args.surv, isPrimary: undefined });
      await ctx.db.delete(existing._id);
      survByEmail.set(row.email, { ...row, personId: args.surv, isPrimary: undefined });
    } else {
      await ctx.db.delete(row._id);
    }
    merged++;
  }
  return { moved, merged };
}
