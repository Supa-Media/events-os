/**
 * Shared core: delete the historical backlog of never-executed morning-engine
 * BALANCE SETTLEMENT pairs.
 *
 * ── WHAT WENT WRONG ─────────────────────────────────────────────────────────
 * The morning reconciliation engine books a `balance_settlement` transfer PAIR
 * every morning for each chapter whose book value differs from its bank
 * balance by >= $5 (`reconciliation.ts#settleChapterBalances`, run inside
 * `runAutoSettlement`). `signedBookCents` (`lib/bookBalance.ts:68`) returns 0
 * for `transferOrigin === "balance_settlement"` — DELIBERATELY, per that
 * file's own comment: crediting a chapter's book for the top-up would raise
 * the very number the top-up is aiming at, so the engine would never
 * converge if it signed its own correction. But that same zero means the
 * settlement it books never actually closes the book/bank gap it measured,
 * so the SAME gap is still there the next morning, and the engine books a
 * near-identical pair again. And again. "Real cash movement" has never been
 * switched on (`financeSettings.autoTransferRealMovement`), so NONE of these
 * pairs was ever executed against Increase — they are pure ledger noise, not
 * a record of anything that happened. Production carries roughly 7-9 such
 * pairs for the New York chapter, August 2026. A sibling change adds the gate
 * that stops NEW ones from being booked; this module is the backlog cleanup.
 *
 * ── WHY DELETE, NOT EXCLUDE, NOT OFFSET (the founder's explicit call) ───────
 * `docs/plans/transfers-ops-notes.md`'s "Correcting a mis-recorded transfer"
 * section ranks the two remedies: an offsetting entry is PREFERRED; raw row
 * deletion is the LAST RESORT, for "a genuine mis-entry ... that hasn't
 * settled anything downstream yet." This module is that last-resort path,
 * and it fits it exactly:
 *
 *   - An OFFSETTING ENTRY corrects a WRONG NUMBER by adding a right one next
 *     to it. These rows were never wrong in amount — they are categorically
 *     inert: `signedBookCents` returns 0 for `balance_settlement` no matter
 *     what the amount says, so there is no book value to true up. Adding an
 *     offsetting pair would just be two MORE zero-value `balance_settlement`-
 *     shaped rows layered onto the very backlog this module exists to clear,
 *     and they would need this exact same review to ever get removed too.
 *   - `reverseExcludedSettlementLoop.ts` chose EXCLUDE over delete for its
 *     own cleanup, and its reasoning was "these rows were really booked, and
 *     the audit trail of a money-path mistake is worth more than a tidy
 *     table" — but that was for an `auto_settlement` pair, which IS signed
 *     and DID move book value between Central and a chapter; the excluded
 *     status preserved evidence of a real re-attribution mistake. A
 *     `balance_settlement` leg moves nothing (book value OR cash — see the
 *     `externalId` guard below) — there is no fact for `excluded` to
 *     preserve, only a target number the engine will recompute fresh
 *     tomorrow regardless of whether today's copy is excluded or deleted.
 *     Leaving 14-18 dead `excluded` rows sitting in the ledger forever, still
 *     enumerable in every balance-settlement listing, buys zero audit value
 *     over a clean delete plus this file (and the PR it ships in) as the
 *     external record `transfers-ops-notes.md` requires for a raw deletion.
 *
 * Deletion is authorized because it is unambiguously reversible-in-spirit:
 * nothing downstream ever settled against these rows (they moved no book
 * value and, per the `externalId` guard, no cash), so there is nothing to
 * unwind by removing them — the ledger simply stops listing an instruction
 * that was never going to be carried out.
 *
 * ── PRECONDITIONS ENFORCED — a pair qualifies ONLY if ALL hold ─────────────
 *   1. Both legs share one `transferGroupId`, and that id starts with
 *      `"balsettle-"`.
 *   2. `transferOrigin === "balance_settlement"` on BOTH legs.
 *   3. NEITHER leg carries an `externalId`. An `externalId` is the stamp a
 *      real Increase transfer leaves — it means cash actually moved, and
 *      such a pair must NEVER be deleted (the correct fix then would be an
 *      offsetting transfer, same as the "real cash moved" guard in
 *      `reverseExcludedSettlementLoop.ts`). Found → reported, refused.
 *   4. Exactly TWO legs exist for the group id. One or 3+ is an anomaly this
 *      module refuses to guess about.
 *   Plus one defensive check beyond the founder's four: both legs must carry
 *   the SAME `amountCents` — that agreement is what makes two rows a PAIR
 *   rather than two coincidentally-grouped ones, and a mismatch is exactly
 *   the "doesn't look like what I expected" shape this style of runner stops
 *   on rather than forces through.
 *
 * ANY failure — on ANY candidate group — is appended to `problems: string[]`
 * in the result, and a non-empty `problems` BLOCKS `execute` for the ENTIRE
 * run, not just the offending group. This module does not do a "delete what
 * it can, skip the rest" partial run: a production data cleanup that leaves
 * a human unsure what was silently skipped and why is worse than one that
 * stops cold and hands back the exact reason.
 *
 * ── THE SAFETY ARGUMENT IS ENFORCED, NOT JUST WRITTEN DOWN ─────────────────
 * `signedBookCents` (imported, never edited, from `lib/bookBalance.ts`) is
 * the ACTUAL function the app uses to compute a book's value, and it returns
 * 0 unconditionally for `transferOrigin === "balance_settlement"`. Every leg
 * this module is about to delete has that origin (precondition #2), so the
 * SUM of `signedBookCents` across every leg about to be deleted must read
 * exactly 0 before a single row is touched — this run REFUSES (appends to
 * `problems`, same as any other failure) if it doesn't. That turns "deleting
 * these rows changes no book's value" from a claim in this comment into a
 * precondition the code checks: if `lib/bookBalance.ts` is ever refactored so
 * the `balance_settlement` branch stops returning 0 unconditionally, THIS
 * GUARD — not this paragraph — is what stops a later run of this module from
 * quietly moving real value out from under a chapter's book.
 *
 * ── BOUNDED READS, AND REFUSING RATHER THAN GUESSING ON TRUNCATION ─────────
 * Chapters (`ctx.db.query("chapters").take(ROLLUP_SCAN_LIMIT)`) and each
 * chapter's transactions (`by_chapter`, `.order("desc")`,
 * `.take(ROLLUP_SCAN_LIMIT)`) are read through an index with an explicit
 * bound — the same `ROLLUP_SCAN_LIMIT` convention `reconciliation.ts`/
 * `finances.ts`/`dashboardDrill.ts` use, not an unbounded `.collect()`. The
 * transaction scan reads NEWEST-first (see `discoverCandidateGroupIds`'s own
 * doc): the pairs this module cleans up are recent by construction, so a
 * newest-first scan finds them long before a busy chapter's full history
 * could approach the cap. Each candidate group's two legs are then loaded
 * by exact `transferGroupId` match (`by_transfer_group`), which is bounded by
 * construction (a pair is two rows). Production carries a low double-digit
 * number of chapters, each with a transaction history far under the 5000-row
 * cap, so one call reads the WHOLE backlog in a single transaction — the same
 * bound this module shipped with as a human-run mutation before this file
 * existed. If a scan ever DOES hit the cap (a chapter, or the chapter list
 * itself, has >= `ROLLUP_SCAN_LIMIT` rows), that means this run cannot prove
 * it saw every candidate — so it refuses the WHOLE run (appends to
 * `problems`) exactly like any other precondition failure, rather than
 * silently deleting a partial, unverifiable subset. That is a deliberate
 * choice over adding scheduler-continuation paging: this module's job is a
 * one-time backlog clear of a low-double-digit-pairs problem, not a
 * general-purpose bulk deleter, and refusing on truncation is strictly safer
 * than guessing at completeness.
 *
 * ── DRY RUN BY DEFAULT ──────────────────────────────────────────────────────
 * `execute` omitted / `false` performs the full scan + every precondition
 * above and returns exactly what a real run WOULD delete — group id,
 * chapter, posted date, amount, leg count — plus `problems` and the total
 * signed-book-cents check. It writes nothing. `execute: true` deletes, but
 * only when `problems` is empty AND the total is exactly 0; otherwise it
 * behaves exactly like a dry run (reports, writes nothing) and says so.
 *
 * ── SCOPE ─────────────────────────────────────────────────────────────────
 * Defaults to every qualifying pair, every chapter. `chapterId` and/or
 * `fromDateMs`/`toDateMs` (inclusive, matched against each pair's own
 * `postedAt`) narrow the scan — e.g. "New York, August 2026 only".
 *
 * ── IDEMPOTENT ────────────────────────────────────────────────────────────
 * A deleted pair's rows are gone, so re-running (even with `execute: true`)
 * finds no candidates, changes nothing, and returns a clean empty result —
 * never an error. Safe to run twice by accident.
 *
 * ── TWO ENTRY POINTS, ONE IMPLEMENTATION ────────────────────────────────────
 * `runRemoveUnexecutedBalanceSettlements` below is the ENTIRE guarded core —
 * candidate discovery, every precondition, the delete. It has no notion of
 * who is calling it or how it is authorized; that is deliberately the
 * caller's job:
 *
 *   - `../removeUnexecutedBalanceSettlements.ts` — the human-run public
 *     `mutation`, gated by `requireReconciliationAudit` (an authenticated
 *     ED/FM session), dry-run by default. Use this to inspect the backlog
 *     before it ships, or to clear a hand-reviewed slice by `chapterId`/date.
 *   - `../migrations/0071_remove_unexecuted_balance_settlements.ts` — the
 *     automatic entry, run by `migrations:runPending` post-deploy with no
 *     signed-in identity (deploy-admin privileges), unattended, `execute:
 *     true`, unscoped.
 *
 * Neither entry point re-implements a single precondition. If they could ever
 * disagree about what is safe to delete, this file is the bug — not either
 * caller.
 */
import type { MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { ROLLUP_SCAN_LIMIT } from "../finances";
import { signedBookCents } from "./bookBalance";

const GROUP_PREFIX = "balsettle-";

/** A group that passed EVERY precondition — the actual rows this run would
 *  (or did) delete, plus enough context for a human to recognize it. */
type CandidatePair = {
  transferGroupId: string;
  chapterId: Id<"chapters">;
  postedAt: number;
  amountCents: number;
  legs: Doc<"transactions">[];
};

export type CandidateSummary = {
  transferGroupId: string;
  chapterId: Id<"chapters">;
  postedAt: number;
  amountCents: number;
  legCount: number;
};

export type RemoveUnexecutedBalanceSettlementsArgs = {
  /** Defaults to `false` — a dry run that writes nothing. */
  execute?: boolean;
  /** Narrow to one chapter's pairs. Default: every chapter. */
  chapterId?: Id<"chapters">;
  /** Inclusive lower bound on each pair's `postedAt`. Default: unbounded. */
  fromDateMs?: number;
  /** Inclusive upper bound on each pair's `postedAt`. Default: unbounded. */
  toDateMs?: number;
};

export type RemoveUnexecutedBalanceSettlementsResult = {
  /** `true` iff this call did NOT delete anything — either because
   *  `execute` was omitted/false, or because the run refused. */
  dryRun: boolean;
  /** Every pair that passed all preconditions — what WAS (or would be)
   *  deleted. Empty on a clean re-run after a successful execute. */
  candidates: CandidateSummary[];
  /** Sum of `signedBookCents` across every leg in `candidates`. MUST be 0
   *  for `execute: true` to actually delete anything. */
  totalSignedBookCents: number;
  /** Rows actually deleted by THIS call. 0 on a dry run or a refused run. */
  deletedLegs: number;
  /** Every precondition failure found, across every candidate group. Any
   *  entry here blocks `execute` for the WHOLE run. */
  problems: string[];
  /** `true` iff `problems` is non-empty OR the book-value guard tripped —
   *  i.e. `execute: true` was requested but refused. */
  refused: boolean;
};

/**
 * Every `transferGroupId` touched by a row that LOOKS like a balance-
 * settlement leg — matched on EITHER signal (the `balsettle-` prefix, or
 * `transferOrigin === "balance_settlement"`) alone, because a row carrying
 * one signal without the other is exactly the kind of anomaly `validateGroup`
 * must report rather than this discovery step silently dropping.
 *
 * Scans only REAL chapters' own transactions (never the `"central"`
 * sentinel scope directly) — a `balance_settlement` pair always has exactly
 * one non-central leg, so iterating every chapter finds every group exactly
 * once without ever needing to scan central's (much larger) transaction set.
 *
 * If a chapter's own scan (or the chapter list itself) hits
 * `ROLLUP_SCAN_LIMIT`, this run cannot prove it saw every candidate leg, so
 * it reports that as a problem — refusing the WHOLE run rather than deleting
 * an unverifiable partial set (see the module doc's "refusing rather than
 * guessing on truncation" section). Scanned NEWEST-FIRST (`.order("desc")`,
 * the same bounded-scan-plus-recency pattern `reconciliation.ts` and
 * `lib/audienceResolve.ts` use elsewhere): the pairs this module exists to
 * clean up are recent by construction (the morning engine wrote them daily,
 * and the sibling change that stops new ones being written just shipped), so
 * scanning newest-first finds them well before a busy chapter's history could
 * ever approach the cap — making the truncation refusal above a rare
 * last-resort rather than something this module's own read order provokes.
 */
async function discoverCandidateGroupIds(
  ctx: MutationCtx,
  chapterIds: Id<"chapters">[],
  chapterListTruncated: boolean,
  fromDateMs: number | undefined,
  toDateMs: number | undefined,
  problems: string[],
): Promise<Set<string>> {
  if (chapterListTruncated) {
    problems.push(
      `the chapter list hit the ${ROLLUP_SCAN_LIMIT}-row scan cap — cannot ` +
        `prove every chapter was considered, REFUSING the whole run`,
    );
  }
  const groupIds = new Set<string>();
  for (const chapterId of chapterIds) {
    const rows = await ctx.db
      .query("transactions")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
      .order("desc")
      .take(ROLLUP_SCAN_LIMIT);
    if (rows.length === ROLLUP_SCAN_LIMIT) {
      problems.push(
        `chapter ${chapterId}'s transactions hit the ${ROLLUP_SCAN_LIMIT}-row ` +
          `scan cap — cannot prove every candidate leg was seen, REFUSING the ` +
          `whole run`,
      );
    }
    for (const tr of rows) {
      const looksLikeOrigin = tr.transferOrigin === "balance_settlement";
      const looksLikePrefix = tr.transferGroupId?.startsWith(GROUP_PREFIX) ?? false;
      if (!looksLikeOrigin && !looksLikePrefix) continue;
      if (tr.transferGroupId == null) {
        problems.push(
          `row ${tr._id} has transferOrigin "balance_settlement" but no ` +
            `transferGroupId — cannot be paired, SKIPPED`,
        );
        continue;
      }
      if (fromDateMs != null && tr.postedAt < fromDateMs) continue;
      if (toDateMs != null && tr.postedAt > toDateMs) continue;
      groupIds.add(tr.transferGroupId);
    }
  }
  return groupIds;
}

/**
 * Validate one candidate group against every precondition in the module
 * header. Returns the pair (both legs, ready to delete) if — and only if —
 * every guard passes; otherwise appends the exact reason(s) to `problems`
 * and returns `null`. Never guesses: a group that isn't EXACTLY right is
 * reported, not force-fit into "close enough."
 */
async function validateGroup(
  ctx: MutationCtx,
  transferGroupId: string,
  problems: string[],
): Promise<CandidatePair | null> {
  if (!transferGroupId.startsWith(GROUP_PREFIX)) {
    problems.push(
      `group ${transferGroupId} was found via transferOrigin but its id does ` +
        `not start with "${GROUP_PREFIX}" — SKIPPED`,
    );
    return null;
  }

  const legs: Doc<"transactions">[] = await ctx.db
    .query("transactions")
    .withIndex("by_transfer_group", (q) => q.eq("transferGroupId", transferGroupId))
    .collect();

  if (legs.length !== 2) {
    problems.push(
      `group ${transferGroupId} has ${legs.length} legs, expected exactly 2 — ` +
        `SKIPPED (refusing to guess which to touch)`,
    );
    return null;
  }

  let ok = true;
  for (const leg of legs) {
    if (leg.transferOrigin !== "balance_settlement") {
      problems.push(
        `leg ${leg._id} in group ${transferGroupId} has transferOrigin ` +
          `${String(leg.transferOrigin)}, expected "balance_settlement" — SKIPPED`,
      );
      ok = false;
    }
    // THE precondition that can never be relaxed. An externalId is the stamp
    // a real Increase transfer leaves — deleting this row would make the
    // ledger disagree with the bank about money that actually moved.
    if (leg.externalId != null) {
      problems.push(
        `leg ${leg._id} in group ${transferGroupId} carries externalId ` +
          `"${leg.externalId}" — real cash moved, this pair must NEVER be ` +
          `deleted (an offsetting transfer is the only correct fix) — SKIPPED`,
      );
      ok = false;
    }
  }
  if (legs[0].amountCents !== legs[1].amountCents) {
    problems.push(
      `group ${transferGroupId}'s legs disagree on amount ` +
        `(${legs[0].amountCents}¢ vs ${legs[1].amountCents}¢) — not a clean ` +
        `pair, SKIPPED`,
    );
    ok = false;
  }
  if (!ok) return null;

  const chapterLeg = legs.find((l) => l.chapterId !== "central");
  if (chapterLeg == null) {
    problems.push(`group ${transferGroupId} has no non-central leg — SKIPPED`);
    return null;
  }

  return {
    transferGroupId,
    chapterId: chapterLeg.chapterId as Id<"chapters">,
    postedAt: chapterLeg.postedAt,
    amountCents: chapterLeg.amountCents,
    legs,
  };
}

/**
 * The guarded core (see module doc). BOTH entry points call this and only
 * this — neither re-implements, narrows, or relaxes a single precondition.
 * Callers own authorization (or the lack of it, for the deploy-admin
 * migration path) and nothing else.
 */
export async function runRemoveUnexecutedBalanceSettlements(
  ctx: MutationCtx,
  args: RemoveUnexecutedBalanceSettlementsArgs,
): Promise<RemoveUnexecutedBalanceSettlementsResult> {
  const { execute, chapterId, fromDateMs, toDateMs } = args;

  const allChapters = chapterId
    ? null
    : await ctx.db.query("chapters").take(ROLLUP_SCAN_LIMIT);
  const chapterIds: Id<"chapters">[] = chapterId
    ? [chapterId]
    : allChapters!.map((c) => c._id);
  const chapterListTruncated =
    allChapters != null && allChapters.length === ROLLUP_SCAN_LIMIT;

  const problems: string[] = [];
  const groupIds = await discoverCandidateGroupIds(
    ctx,
    chapterIds,
    chapterListTruncated,
    fromDateMs,
    toDateMs,
    problems,
  );

  const pairs: CandidatePair[] = [];
  for (const groupId of groupIds) {
    const pair = await validateGroup(ctx, groupId, problems);
    if (pair != null) pairs.push(pair);
  }

  // THE ENFORCED SAFETY ARGUMENT (see module doc). Every leg here already
  // has `transferOrigin === "balance_settlement"` (validateGroup checked),
  // so this MUST read 0 today — it stays a live check, not a comment, so a
  // future change to `lib/bookBalance.ts` can't silently make this module
  // move real value.
  let totalSignedBookCents = 0;
  for (const pair of pairs) {
    for (const leg of pair.legs) {
      totalSignedBookCents += signedBookCents(leg);
    }
  }
  if (totalSignedBookCents !== 0) {
    problems.push(
      `deleting the ${pairs.length} qualifying pair(s) would change total ` +
        `book value by ${totalSignedBookCents}¢, not 0 — REFUSING. Something ` +
        `about these rows no longer matches what a balance_settlement leg is ` +
        `supposed to be; re-derive before doing anything`,
    );
  }

  const refused = problems.length > 0;
  const write = (execute ?? false) && !refused;

  let deletedLegs = 0;
  if (write) {
    for (const pair of pairs) {
      for (const leg of pair.legs) {
        await ctx.db.delete(leg._id);
        deletedLegs += 1;
      }
    }
  }

  const candidates: CandidateSummary[] = pairs.map((p) => ({
    transferGroupId: p.transferGroupId,
    chapterId: p.chapterId,
    postedAt: p.postedAt,
    amountCents: p.amountCents,
    legCount: p.legs.length,
  }));

  return {
    dryRun: !write,
    candidates,
    totalSignedBookCents,
    deletedLegs,
    problems,
    refused,
  };
}
