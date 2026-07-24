import type { MutationCtx } from "../_generated/server";
import type { Migration } from "./index";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { normalizeEmail } from "../lib/access";
import { pickMoreTrustworthy, type PersonEmailSource } from "../lib/personEmails";

/**
 * Person Emails backfill (person-centric audiences Phase 2 item 1 —
 * specs/person-centric-audiences.md).
 *
 * `personEmails` shipped in the same deploy as this migration, so every
 * pre-existing email-bearing signal needs its ledger row stamped
 * retroactively — new signals get one for free at write time (`people.ts`'s
 * create/update, `lib/givingDonors.ts#linkDonorToPerson`,
 * `lib/rsvpPeople.ts#linkRsvpToPerson`, all via
 * `lib/personEmails.ts#recordPersonEmail`).
 *
 * FOUR SOURCES, ONE PASS EACH: this walks `people` (roster `email` +
 * `pwEmail`), `donors` (linked rows' `email`), and `rsvps` (linked rows'
 * `email`) — each its own full paginated scan, mirroring `0038`'s "the
 * dataset is small at this stage" assumption (same footing as `0032`/`0037`'s
 * own docs). `donors` has no `by_person` index (it's scoped by `by_scope*`
 * for its own CRM reads), so a full scan is the only way to find "every donor
 * linked to a person" — acceptable at this volume.
 *
 * ============================================================================
 * ONE `.paginate()` PER INVOCATION — hotfix 0039-single-paginate (prod
 * incident, 2026-07-24): Convex hard-fails a query/mutation that calls
 * `.paginate()` more than once during a SINGLE execution ("This query or
 * mutation function ran multiple paginated queries. Convex only supports a
 * single paginated query in each function.") — a RUNTIME rule the
 * `convex-test` harness used by this repo's vitest suite does NOT enforce, so
 * the original three-source, drain-each-table-with-a-`for(;;)`-loop version
 * of this file passed the full suite + CI green and then hard-failed on
 * `npx convex run migrations:runPending` in production. See
 * `tests/migrations0039.test.ts`'s "runner invocation pattern" test, which
 * exercises this the ONLY way that actually catches it: separate `t.run`
 * calls threading the cursor, never more than one `.paginate()` per call.
 *
 * So this file walks `people` → `donors` → `rsvps` as three STAGES, each
 * itself paginated across as many invocations as its table needs, encoding
 * "where we are" as `{ stage, cursor }` (`PersonEmailsCursor`) returned to
 * the caller and threaded back in on the next call — exactly the
 * scheduler-continuation shape `0035_backfill_receipt_documents.ts` already
 * established for a single table; this just generalizes it to advance
 * through MULTIPLE tables instead of looping one. `runBackfillPersonEmails`
 * (the registry entry point `migrations.runPending` calls) runs the FIRST
 * page only and schedules `internal.migrations.continuePersonEmailsBackfill`
 * for the rest — so, same as 0035, the ledger row is written after just that
 * first page, and the full backfill finishes asynchronously afterward.
 * ============================================================================
 *
 * DEDUPE BEFORE INSERT, ACROSS INVOCATIONS: with the scan spread across many
 * separate executions, there is no in-memory map to hold "every candidate
 * seen so far" the way a single-shot version could. Instead each candidate is
 * compared directly against whatever `personEmails` row is currently stored
 * for that (personId, email) pair via `lib/personEmails.ts#pickMoreTrustworthy`
 * (verified beats unverified first, then source rank pw > roster > donor >
 * rsvp, ties broken by earliest `addedAt`) — insert if absent, UPGRADE the
 * stored row in place if the new candidate wins, otherwise leave it alone.
 * Comparing against the durable row on every observation, regardless of which
 * stage/page/invocation produced it, converges to the exact same "highest
 * trust wins" outcome as the original single-pass in-memory version — a
 * running max is order-independent — while ALSO making this the same
 * additive/upgrade-only shape `personEmails.ts#recordPersonEmail` and
 * `schema/people.ts`'s own doc already require of every other write path.
 *
 * IDEMPOTENT FROM ANY PARTIAL STATE: because upgrades key off whatever's
 * actually stored, this is safe to re-run from scratch even after an earlier
 * run committed some pages and then failed or was interrupted partway
 * through (the exact prod scenario this hotfix responds to) — every
 * still-correct row is left untouched (a candidate that can't beat what's
 * already there is a no-op), every row a partial run left at a
 * lower-than-optimal trust level gets upgraded the next time a better
 * candidate for that address is observed, and nothing is ever duplicated
 * (one row per (personId, email) pair, by construction).
 */

/** Rows per page during each table's scan. */
const PAGE_SIZE = 500;

/** Stage order — the three source tables, walked in DECREASING worst-case
 *  trust: every `people`-sourced candidate is `verified: true` with source
 *  rank pw(4)/roster(3); every `donors`-sourced candidate is `verified: true`
 *  rank 2; `rsvps`-sourced candidates are rank 1 and only sometimes verified.
 *  Since `pickMoreTrustworthy` checks `verified` before rank, an EARLIER
 *  stage's candidate for a given key never loses to a LATER stage's — this
 *  order isn't load-bearing for correctness (the pairwise-max upgrade is
 *  order-independent by construction) but keeps the common case a single
 *  insert with no later upgrade needed. */
const STAGES = ["people", "donors", "rsvps"] as const;
export type PersonEmailsStage = (typeof STAGES)[number];

/** Where a multi-invocation scan currently is: which table, and that table's
 *  own `.paginate()` cursor (`null` = start of that stage). Threaded back in
 *  verbatim by the caller (the scheduler continuation, or a test simulating
 *  it) on the next invocation. */
export type PersonEmailsCursor = {
  stage: PersonEmailsStage;
  cursor: string | null;
};

function nextStage(stage: PersonEmailsStage): PersonEmailsStage | null {
  const i = STAGES.indexOf(stage);
  return i + 1 < STAGES.length ? STAGES[i + 1] : null;
}

type Candidate = {
  personId: Id<"people">;
  email: string; // normalized
  source: PersonEmailSource;
  verified: boolean;
  addedAt: number;
};

export type PersonEmailsPageResult = {
  stage: PersonEmailsStage;
  scanned: number;
  inserted: number;
  upgraded: number;
  unchanged: number;
  /** `true` only once the FINAL stage's FINAL page has been processed. */
  isDone: boolean;
  /** What to pass as the next invocation's cursor argument; `null` iff `isDone`. */
  next: PersonEmailsCursor | null;
};

/**
 * Insert-or-upgrade a single candidate against whatever `personEmails` row
 * (if any) already exists for its (personId, email) pair, using `cache` to
 * avoid a redundant `by_person` read when a page yields more than one
 * candidate for the same person (e.g. one people row's roster + pw emails,
 * or two donor rows linked to the same person). Returns which of the three
 * things happened, for the page-level tally.
 */
async function upsertCandidate(
  ctx: MutationCtx,
  cache: Map<string, Doc<"personEmails">[]>,
  candidate: Candidate,
): Promise<"inserted" | "upgraded" | "unchanged"> {
  const key = String(candidate.personId);
  let rows = cache.get(key);
  if (!rows) {
    rows = await ctx.db
      .query("personEmails")
      .withIndex("by_person", (q) => q.eq("personId", candidate.personId))
      .collect();
    cache.set(key, rows);
  }

  const idx = rows.findIndex((r) => r.email === candidate.email);
  if (idx === -1) {
    const insertedId = await ctx.db.insert("personEmails", {
      personId: candidate.personId,
      email: candidate.email,
      source: candidate.source,
      verified: candidate.verified,
      addedAt: candidate.addedAt,
    });
    const stored = await ctx.db.get(insertedId);
    if (stored) rows.push(stored);
    return "inserted";
  }

  const existing = rows[idx];
  // Explicit type argument: `existing` (`Doc<"personEmails">`) and
  // `candidate` (`Candidate`) are different concrete types that both
  // structurally satisfy the comparator's bound — pin `T` so inference
  // doesn't have to reconcile the two.
  const winner = pickMoreTrustworthy<{ verified: boolean; source: PersonEmailSource; addedAt: number }>(
    existing,
    candidate,
  );
  if (
    winner === existing ||
    (existing.source === candidate.source &&
      existing.verified === candidate.verified &&
      existing.addedAt === candidate.addedAt)
  ) {
    return "unchanged";
  }

  await ctx.db.patch(existing._id, {
    source: candidate.source,
    verified: candidate.verified,
    addedAt: candidate.addedAt,
  });
  rows[idx] = { ...existing, source: candidate.source, verified: candidate.verified, addedAt: candidate.addedAt };
  return "upgraded";
}

/**
 * Process exactly ONE page of exactly ONE stage — i.e. exactly one
 * `.paginate()` call — starting from `at` (or the very beginning, `{ stage:
 * "people", cursor: null }`, when `at` is `null`). Returns the page's tally
 * plus where the NEXT invocation should resume (`next`), or `isDone: true`
 * once `rsvps` (the last stage) has been fully drained.
 */
export async function runBackfillPersonEmailsPage(
  ctx: MutationCtx,
  at: PersonEmailsCursor | null,
): Promise<PersonEmailsPageResult> {
  const stage = at?.stage ?? "people";
  const cursor = at?.cursor ?? null;
  const cache = new Map<string, Doc<"personEmails">[]>();

  let scanned = 0;
  let inserted = 0;
  let upgraded = 0;
  let unchanged = 0;
  const tally = (r: "inserted" | "upgraded" | "unchanged") => {
    if (r === "inserted") inserted++;
    else if (r === "upgraded") upgraded++;
    else unchanged++;
  };

  let isDoneStage: boolean;
  let continueCursor: string | null;

  if (stage === "people") {
    const page = await ctx.db.query("people").paginate({ numItems: PAGE_SIZE, cursor });
    for (const p of page.page) {
      scanned++;
      const roster = normalizeEmail(p.email);
      if (roster) {
        tally(await upsertCandidate(ctx, cache, { personId: p._id, email: roster, source: "roster", verified: true, addedAt: p.createdAt }));
      }
      const pw = normalizeEmail(p.pwEmail);
      if (pw) {
        tally(await upsertCandidate(ctx, cache, { personId: p._id, email: pw, source: "pw", verified: true, addedAt: p.createdAt }));
      }
    }
    isDoneStage = page.isDone;
    continueCursor = page.continueCursor;
  } else if (stage === "donors") {
    const page = await ctx.db.query("donors").paginate({ numItems: PAGE_SIZE, cursor });
    for (const d of page.page) {
      scanned++;
      if (!d.personId) continue;
      const email = normalizeEmail(d.email);
      if (!email) continue;
      // CRM data is staff-entered or import-matched, never an anonymous
      // public-form capture — trusted at write time, same as the live
      // `linkDonorToPerson` write-through.
      tally(await upsertCandidate(ctx, cache, { personId: d.personId, email, source: "donor", verified: true, addedAt: d.createdAt }));
    }
    isDoneStage = page.isDone;
    continueCursor = page.continueCursor;
  } else {
    const page = await ctx.db.query("rsvps").paginate({ numItems: PAGE_SIZE, cursor });
    for (const r of page.page) {
      scanned++;
      if (!r.personId) continue;
      const email = normalizeEmail(r.email);
      if (!email) continue;
      // `false` = a pending unconfirmed code; `true`/`undefined` (legacy or
      // imported rows) reads as verified — the same `!== false` gate
      // `lib/audienceResolve.ts#resolveGuests` and the live rsvp write-through use.
      tally(
        await upsertCandidate(ctx, cache, {
          personId: r.personId,
          email,
          source: "rsvp",
          verified: r.emailVerified !== false,
          addedAt: r.createdAt,
        }),
      );
    }
    isDoneStage = page.isDone;
    continueCursor = page.continueCursor;
  }

  if (!isDoneStage) {
    return { stage, scanned, inserted, upgraded, unchanged, isDone: false, next: { stage, cursor: continueCursor } };
  }
  const following = nextStage(stage);
  if (following) {
    return { stage, scanned, inserted, upgraded, unchanged, isDone: false, next: { stage: following, cursor: null } };
  }
  return { stage, scanned, inserted, upgraded, unchanged, isDone: true, next: null };
}

/**
 * Registry entry point — runs ONLY the first page (stage `"people"`, from the
 * start) and, if more work remains, schedules
 * `internal.migrations.continuePersonEmailsBackfill` to drain the rest. Same
 * shape as `0035_backfill_receipt_documents.ts#runBackfillReceiptDocuments`:
 * `migrations.runPending` ledgers this migration as applied once THIS call
 * returns, not once the whole backfill finishes — the scheduled continuation
 * completes it afterward, and is itself idempotent/resumable (see the module
 * doc above), so that's safe even if a deploy's `runPending` invocation is
 * the last thing that runs before something else goes wrong.
 */
export async function runBackfillPersonEmails(ctx: MutationCtx) {
  const result = await runBackfillPersonEmailsPage(ctx, null);
  if (!result.isDone && result.next) {
    await ctx.scheduler.runAfter(0, internal.migrations.continuePersonEmailsBackfill, result.next);
  }
  return result;
}

export const backfillPersonEmails: Migration = {
  name: "0039_backfill_person_emails",
  run: runBackfillPersonEmails,
};
