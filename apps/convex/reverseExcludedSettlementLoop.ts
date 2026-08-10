/**
 * One-time: void the third round of the settlement feedback loop, and the
 * balance settlement whose target it inflated.
 *
 * ── WHAT WENT WRONG ─────────────────────────────────────────────────────────
 * #566 stopped `chapterInterScopeRows` reading a `balance_settlement` pair as a
 * settling leg, and the now-deleted `reverseBadSettlement` voided the bogus
 * $2,003.95 New York→central `auto_settlement` pair that loop had produced. It
 * voided it the way this codebase voids things: `status:"excluded"`.
 *
 * The settling-leg filter never looked at `status`. Both SPEND sides of the same
 * net go through `isSpend`, which drops `status:"excluded"`; the SETTLED side
 * filtered on `source`, `transferOrigin` and mode and nothing else. So the very
 * act of neutralising the bad pair left it standing as "already settled", and on
 * 2026-08-10 at 05:30 ET the morning engine booked a THIRD pair — $2,003.95
 * central→New York, `reconciled` — off a $0.00 base. Its own note says so:
 *
 *   "central's spend on New York's cards $0.00 (0 rows) less $2,003.95 already
 *    settled. Net $2,003.95 central → New York."
 *
 * An `auto_settlement` leg is SIGNED (`lib/bookBalance.ts`), so that moved
 * $2,003.95 of book value from Central to New York for spending that does not
 * exist. It nets to zero org-wide, which is why the reconciliation panel kept
 * reporting that everything adds up.
 *
 * ── IT IS NOT OSCILLATING, AND THAT CHANGES THE RUNBOOK ─────────────────────
 * Rounds two (excluded) and three cancel on the settled side, so the net came
 * back to 0 and the engine stopped. Production is sitting at a WRONG but STABLE
 * fixed point — $2,003.95 on the wrong book, nothing new booked each morning.
 * Read from the live rows:
 *
 *   without the filter fix:  (22453 − 222848) − (0 − 200395) =      $0.00
 *   with it, nothing voided: (22453 − 222848) − (0 −      0) = −$2,003.95
 *   with it, this run done:  (22453 −  22453) − (0 −      0) =      $0.00
 *
 * So THE FILTER FIX ALONE DOES NOT RESTORE THE BOOKS. It removes round two from
 * the settled side, takes the net to −$2,003.95, and the next cron books round
 * four. The fix and this cleanup are one change in two files; the deploy is only
 * finished when both have landed.
 *
 * ── THE RUNNER DEFENDS ITSELF; DO NOT RELY ON RUNNING IT IN TIME ────────────
 * The obvious runbook — merge, then run this before 09:30 UTC — is a human doing
 * two things in sequence under a deadline, and getting it wrong is worse than
 * doing nothing. If round four is booked first, every precondition the old
 * version of this module checked still passes (leg count, amount, origin, no
 * `externalId` — none of which can see a NEWER `autosettle-` group), so it would
 * cheerfully void the 08-10 pair while round four's counter-pair stands, leaving
 * Central $6,324.59 and New York $2,490.14 — both wrong by $2,003.95 in the
 * OPPOSITE direction.
 *
 * So the precondition is not "is this the pair I expected" but "does voiding it
 * leave the books settled": `netAfterVoiding` recomputes the chapter's
 * cross-book net through `chapterInterScopeRows` — the SAME predicate the engine
 * uses, so it cannot drift — with the target legs treated as excluded, and the
 * runner SKIPs unless that net is exactly 0. Merge order then stops mattering: a
 * late cron makes the net nonzero, the runner refuses, and a human looks at it.
 *
 * ── TWO RUNNERS, ORDERED ────────────────────────────────────────────────────
 *   1. `voidLoopedAutoSettlement` — voids the 2026-08-10 $2,003.95
 *      central→New York `auto_settlement` pair. This is the one moving book
 *      value: Central $2,316.69 → $4,320.64, New York $6,498.04 → $4,494.09,
 *      org-wide total unchanged at $8,814.73. It is a re-attribution between
 *      books, not a change in what the org is worth.
 *   2. `voidInflatedBalanceSettlement` — voids the 2026-08-10 $4,616.90
 *      balance settlement, whose target was computed off the poisoned book.
 *      SEPARATE runner, and deliberately so: it changes no book value at all
 *      (`signedBookCents` returns 0 for a `balance_settlement` whether excluded
 *      or not) and is purely about not leaving a wrong instruction in the
 *      ledger. It refuses to run until the chapter's net is already 0 — i.e.
 *      until runner 1 has landed and nothing has re-broken since.
 *
 * ── WHY THE $4,616.90 IS WRONG ──────────────────────────────────────────────
 * `settleChapterBalances` computes `owed = book − bank`, and step 4 of the
 * morning run (`runAutoSettlement`) executes BEFORE it — so the 09:30:25 UTC
 * balance settlement read the book the 09:30:01 UTC bogus pair had just
 * inflated. Its own note records both figures: "Book $6,636.59 against
 * $2,019.69 in the bank = $4,616.90 owed to it." Take the phantom $2,003.95 out
 * and the honest figure at that moment was $2,612.95.
 *
 * VOIDED WHOLE RATHER THAN REPRICED. The engine books one balance settlement
 * per chapter per Eastern day off live figures; by the time anyone acts on this
 * the right number is whatever the NEXT run computes, not $2,612.95. Patching
 * `amountCents` would also leave the row's note narrating a book-vs-bank
 * comparison that never happened. Voiding it and letting the engine re-book is
 * the honest correction. Note the deterministic group id
 * (`balsettle-<chapter>-<date>`) still occupies 2026-08-10 after the void, so
 * the replacement lands on the next Eastern day, not the same one.
 *
 * ── WHY EXCLUDE RATHER THAN DELETE OR OFFSET ────────────────────────────────
 * Same reasoning `reverseBadSettlement` gave, and it still holds: `excluded` is
 * this codebase's idiom for "real, but must not count", `signedBookCents` checks
 * it first, and an offsetting pair would add four more transfer rows to a ledger
 * the owner is trying to keep legible. Deleting was never an option — these rows
 * were really booked, and the audit trail of a money-path mistake is worth more
 * than a tidy table.
 *
 * The irony is not lost: excluding is exactly what produced round three. It is
 * safe NOW only because the settling-leg filter in this same PR finally agrees
 * with `isSpend` about what an excluded row is worth — and because
 * `listUnexecutedEnginePairs` now skips excluded pairs, so a void can no longer
 * leave a retracted booking wired to Increase.
 *
 * ── SAFE BECAUSE NO CASH MOVED ──────────────────────────────────────────────
 * Verified in `vivid-rhinoceros-688`: no leg of either pair carries an
 * `externalId`, which is the stamp an executed Increase transfer leaves. Real
 * movement has never been switched on (`financeSettings` carries no
 * `autoTransferRealMovementSinceMs`, so `listUnexecutedEnginePairs` returns
 * early), and a `balsettle-…` group is not even one of the shapes that function
 * will execute. Both runners assert the `externalId` precondition anyway and
 * SKIP rather than write if it is ever false — had cash actually moved, the
 * correct fix would be an offsetting transfer, not an exclusion.
 *
 * Delete this module once run.
 */
import { internalMutation } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { ROLLUP_SCAN_LIMIT } from "./finances";
import {
  chapterInterScopeRows,
  loadChapterOwesCentralRows,
  loadInterScopeContext,
  sumAllCents,
} from "./transfers";

const CHAPTER = "kh73xrr66rxt2wzr3ny5c2c4kh88n06n" as Id<"chapters">; // New York

/** Round three of the loop: the pair that is moving book value right now. */
const AUTO_GROUP_ID = `autosettle-${CHAPTER}-2026-08-10`;
const AUTO_EXPECTED_CENTS = 200_395;
const AUTO_VOID_NOTE =
  "VOID — booked by the settlement feedback loop, not by any real cross-book card spend. " +
  "The bogus 2026-08-09 pair was neutralised with status:\"excluded\", but the settling-leg " +
  "filter in transfers.ts#chapterInterScopeRows did not check status, so the excluded leg " +
  "still counted as \"New York already paid central $2,003.95\" and this pair was booked to " +
  "\"correct\" a $0.00 base. Excluded 2026-08-10; no cash ever moved (neither leg carries an " +
  "externalId). Cause fixed by adding the status filter to chapterInterScopeRows.";

/** The balance settlement that priced itself off the poisoned book. */
const BALANCE_GROUP_ID = `balsettle-${CHAPTER}-2026-08-10`;
const BALANCE_EXPECTED_CENTS = 461_690;
/** What the same computation would have produced without the phantom pair:
 *  book $6,636.59 − $2,003.95 = $4,632.64, less $2,019.69 in the bank. */
const BALANCE_HONEST_CENTS = 261_295;
const BALANCE_VOID_NOTE =
  "VOID — this target was computed off an inflated book. settleChapterBalances takes " +
  "owed = book − bank, and runAutoSettlement runs before it in the same morning pass, so the " +
  "$6,636.59 book quoted in the original note already contained the phantom $2,003.95 the " +
  "feedback loop had just credited to New York. The honest figure at that moment was " +
  "$2,612.95. Voided whole rather than repriced — the engine books a fresh settlement off " +
  "live figures on the next Eastern day. Excluded 2026-08-10; no cash ever moved (neither leg " +
  "carries an externalId, and a balsettle- group is never executed as a real transfer).";

/**
 * The chapter's cross-book net as it WOULD read with `voidedLegIds` excluded.
 *
 * THE GUARD THAT MAKES MERGE ORDER IRRELEVANT. Computed through the engine's own
 * `chapterInterScopeRows` rather than by re-deriving the predicates here, so it
 * cannot disagree with what `runAutoSettlement` will do on the next cron: if
 * this returns 0, the next run books nothing; if it doesn't, voiding would leave
 * the books mid-correction and the runner must refuse.
 *
 * `sandboxMode: false` mirrors `runAutoSettlement` — ALWAYS the live balance,
 * never the current demo toggle.
 *
 * Exported for its test, which is the only way to exercise this module's guard
 * (the runners themselves address production rows by hard-coded id).
 */
export async function netAfterVoiding(
  ctx: MutationCtx,
  chapterId: Id<"chapters">,
  voidedLegIds: Set<Id<"transactions">>,
): Promise<number> {
  const sandboxMode = false;
  const { centralBudgetIds } = await loadInterScopeContext(ctx);
  const owesCentralByChapter = await loadChapterOwesCentralRows(
    ctx,
    centralBudgetIds,
    sandboxMode,
  );
  const chapterTxns = (
    await ctx.db
      .query("transactions")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
      .take(ROLLUP_SCAN_LIMIT)
  ).map((tr) =>
    voidedLegIds.has(tr._id) ? { ...tr, status: "excluded" as const } : tr,
  );

  const grouped = chapterInterScopeRows(
    chapterTxns,
    centralBudgetIds,
    owesCentralByChapter.get(chapterId) ?? [],
    sandboxMode,
  );
  return (
    sumAllCents(grouped.centralOwesChapterRows) -
    sumAllCents(grouped.settledCentralToChapterRows) -
    (sumAllCents(grouped.chapterOwesCentralRows) -
      sumAllCents(grouped.settledChapterToCentralRows))
  );
}

type VoidOutcome = {
  dryRun: boolean;
  voided: number;
  alreadyVoided: number;
  netAfterCents: number;
  problems: string[];
};

/**
 * Load a transfer pair, assert it is the pair this module was written against
 * AND that voiding it leaves the chapter's cross-book net at 0, then mark both
 * legs `excluded` with `note`. Writes NOTHING and reports every mismatch in
 * `problems` if the ledger is not in the expected shape — a one-off that guesses
 * is worse than one that stops.
 */
async function voidPair(
  ctx: MutationCtx,
  args: {
    write: boolean;
    transferGroupId: string;
    expectedCents: number;
    expectedOrigin: "auto_settlement" | "balance_settlement";
    note: string;
  },
): Promise<VoidOutcome> {
  const problems: string[] = [];
  const skip = (netAfterCents: number): VoidOutcome => ({
    dryRun: !args.write,
    voided: 0,
    alreadyVoided: 0,
    netAfterCents,
    problems,
  });

  const legs: Doc<"transactions">[] = await ctx.db
    .query("transactions")
    .withIndex("by_transfer_group", (q) =>
      q.eq("transferGroupId", args.transferGroupId),
    )
    .collect();

  if (legs.length !== 2) {
    problems.push(
      `expected 2 legs for ${args.transferGroupId}, found ${legs.length} — SKIPPED`,
    );
    return skip(0);
  }
  for (const leg of legs) {
    if (leg.amountCents !== args.expectedCents) {
      problems.push(
        `leg ${leg._id} is ${leg.amountCents}¢, expected ${args.expectedCents}¢ — SKIPPED`,
      );
    }
    if (leg.transferOrigin !== args.expectedOrigin) {
      problems.push(
        `leg ${leg._id} has transferOrigin ${String(leg.transferOrigin)}, expected ` +
          `${args.expectedOrigin} — SKIPPED`,
      );
    }
    // The whole justification for excluding rather than offsetting. If cash HAD
    // moved, voiding the ledger entry would leave the books claiming money is
    // somewhere it isn't.
    if (leg.externalId != null) {
      problems.push(
        `leg ${leg._id} carries externalId ${leg.externalId} — real cash moved, needs an ` +
          `offsetting transfer, not an exclusion — SKIPPED`,
      );
    }
  }

  // THE RACE GUARD. Every check above passes just as happily after the engine
  // has booked a counter-pair, which is exactly when voiding would be wrong.
  const netAfterCents = await netAfterVoiding(
    ctx,
    CHAPTER,
    new Set(legs.map((l) => l._id)),
  );
  if (netAfterCents !== 0) {
    problems.push(
      `voiding ${args.transferGroupId} would leave the chapter's cross-book net at ` +
        `${netAfterCents}¢, not 0 — the engine has moved since this module was written ` +
        `(most likely it booked a further settlement). Voiding now would push the books ` +
        `wrong in the other direction. Re-derive before doing anything — SKIPPED`,
    );
  }

  if (problems.length > 0) return skip(netAfterCents);

  let voided = 0;
  let alreadyVoided = 0;
  for (const leg of legs) {
    if (leg.status === "excluded") {
      alreadyVoided += 1;
      continue;
    }
    if (args.write) {
      await ctx.db.patch(leg._id, { status: "excluded", note: args.note });
    }
    voided += 1;
  }
  return { dryRun: !args.write, voided, alreadyVoided, netAfterCents, problems };
}

/**
 * RUNNER 1 — void the 2026-08-10 `auto_settlement` pair the excluded leg caused.
 *
 * `execute` omitted / false = a zero-write dry run reporting exactly what a real
 * run would do. Idempotent: a second run reports `alreadyVoided: 2`.
 *
 * `bookValueRestoredCents` is what returns to each book, in opposite directions:
 * Central was debited and New York credited by the same $2,003.95, so voiding
 * gives Central $2,003.95 back and takes the same off New York. The ORG-WIDE
 * total does not move — it never did; that is why nothing flagged this.
 *
 * `netAfterCents` MUST read 0. If it doesn't, `problems` says so and nothing was
 * written — see the race guard in `voidPair`.
 */
export const voidLoopedAutoSettlement = internalMutation({
  args: { execute: v.optional(v.boolean()) },
  returns: v.object({
    dryRun: v.boolean(),
    voided: v.number(),
    alreadyVoided: v.number(),
    bookValueRestoredCents: v.number(),
    netAfterCents: v.number(),
    problems: v.array(v.string()),
  }),
  handler: async (ctx, { execute }) => {
    const outcome = await voidPair(ctx, {
      write: execute ?? false,
      transferGroupId: AUTO_GROUP_ID,
      expectedCents: AUTO_EXPECTED_CENTS,
      expectedOrigin: "auto_settlement",
      note: AUTO_VOID_NOTE,
    });
    return { ...outcome, bookValueRestoredCents: AUTO_EXPECTED_CENTS };
  },
});

/**
 * RUNNER 2 — void the 2026-08-10 balance settlement priced off the poisoned book.
 *
 * Run this ONLY AFTER runner 1, and only if the owner agrees the row should go
 * rather than stand. It moves NO book value (`signedBookCents` returns 0 for a
 * `balance_settlement` either way) and moves no cash (none ever moved); its only
 * effect is that the ledger stops carrying an instruction to send New York
 * $4,616.90 that was $2,003.95 too large the moment it was written.
 *
 * The ordering is ENFORCED, not documented: a `balance_settlement` is not a
 * settling leg, so voiding it leaves the cross-book net exactly as it found it —
 * which means the guard in `voidPair` reads the CURRENT net, and that is only 0
 * once runner 1 has landed and nothing has re-broken since.
 *
 * `overstatedByCents` is the phantom component; `honestTargetAtBookingCents` is
 * what the same computation would have produced without it — reported for the
 * record, NOT written anywhere. The replacement figure is whatever the next
 * morning run computes off live books.
 */
export const voidInflatedBalanceSettlement = internalMutation({
  args: { execute: v.optional(v.boolean()) },
  returns: v.object({
    dryRun: v.boolean(),
    voided: v.number(),
    alreadyVoided: v.number(),
    bookedTargetCents: v.number(),
    honestTargetAtBookingCents: v.number(),
    overstatedByCents: v.number(),
    netAfterCents: v.number(),
    problems: v.array(v.string()),
  }),
  handler: async (ctx, { execute }) => {
    const outcome = await voidPair(ctx, {
      write: execute ?? false,
      transferGroupId: BALANCE_GROUP_ID,
      expectedCents: BALANCE_EXPECTED_CENTS,
      expectedOrigin: "balance_settlement",
      note: BALANCE_VOID_NOTE,
    });
    return {
      ...outcome,
      bookedTargetCents: BALANCE_EXPECTED_CENTS,
      honestTargetAtBookingCents: BALANCE_HONEST_CENTS,
      overstatedByCents: BALANCE_EXPECTED_CENTS - BALANCE_HONEST_CENTS,
    };
  },
});
