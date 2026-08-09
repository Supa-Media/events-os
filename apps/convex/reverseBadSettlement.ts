/**
 * One-time: void the auto-settlement pair the feedback loop produced.
 *
 * ── WHAT WENT WRONG ─────────────────────────────────────────────────────────
 * `balance_settlement` (added in #553) books a central↔chapter pair moving a
 * chapter the cash its book says it is owed. `chapterInterScopeRows` reads
 * central↔chapter legs as SETTLING cross-book card debt, and did not exclude
 * that new origin — so a $2,003.95 central→New York balance settlement read as
 * "central has already paid the chapter $2,003.95", flipped the cross-book net,
 * and `runAutoSettlement` booked an opposing $2,003.95 New York→central pair to
 * clear a debt that never existed.
 *
 * The asymmetry is what made it damaging: a balance settlement contributes ZERO
 * to book value, an auto settlement is SIGNED. So the bogus pair moved $2,003.95
 * of real book value — Central up, New York down — with no spending behind it.
 *
 * #566 stopped it recurring. This clears what already landed.
 *
 * ── WHY EXCLUDE RATHER THAN OFFSET ──────────────────────────────────────────
 * `status: "excluded"` is this codebase's own idiom for "this row is real but
 * must not count" — `signedBookCents` checks it before anything else. An
 * offsetting pair would have worked too, but it adds two more transfer rows to
 * a ledger the owner is actively trying to make legible, and a reader six
 * months out would have to reconstruct that the four rows are two mistakes
 * cancelling. Excluding leaves exactly the two rows that happened, marked as
 * void, with the reason on them.
 *
 * Deleting was never an option: they were really booked, and the audit trail of
 * a money-path mistake is worth more than a tidy table.
 *
 * ── SAFE BECAUSE NO CASH MOVED ──────────────────────────────────────────────
 * Both legs carry no `externalId`, which is the stamp an executed Increase
 * transfer leaves. Real cash movement is off, so this pair was ledger-only.
 * Voiding it therefore needs no counter-payment — had cash actually moved, the
 * correct fix would be an offsetting transfer, not an exclusion.
 *
 * The group id (`autosettle-<chapter>-<date>`) is deterministic and
 * `recordTransferPair` refuses a duplicate, so today's run cannot re-book it;
 * tomorrow's has a different date and, with #566 in, computes a net of zero.
 *
 * Delete this module once run.
 */
import { internalMutation } from "./_generated/server";
import { v } from "convex/values";

const GROUP_ID = "autosettle-kh73xrr66rxt2wzr3ny5c2c4kh88n06n-2026-08-09";
const EXPECTED_CENTS = 200395;
const VOID_NOTE =
  "VOID — booked by a feedback loop between the two settlement mechanisms, not by any real " +
  "cross-book card spend. A $2,003.95 balance settlement was misread as having already paid " +
  "down card debt, so this pair was booked to 'correct' a debt that never existed. Excluded " +
  "2026-08-09; no cash ever moved (neither leg carries an externalId). Cause fixed in #566.";

export const reverseBadSettlement = internalMutation({
  args: { execute: v.optional(v.boolean()) },
  returns: v.object({
    dryRun: v.boolean(),
    voided: v.number(),
    alreadyVoided: v.number(),
    bookValueRestoredCents: v.number(),
    problems: v.array(v.string()),
  }),
  handler: async (ctx, { execute }) => {
    const write = execute ?? false;
    const problems: string[] = [];

    const legs = await ctx.db
      .query("transactions")
      .withIndex("by_transfer_group", (q) => q.eq("transferGroupId", GROUP_ID))
      .collect();

    if (legs.length !== 2) {
      problems.push(`expected 2 legs for ${GROUP_ID}, found ${legs.length} — SKIPPED`);
      return {
        dryRun: !write,
        voided: 0,
        alreadyVoided: 0,
        bookValueRestoredCents: 0,
        problems,
      };
    }
    for (const leg of legs) {
      if (leg.amountCents !== EXPECTED_CENTS) {
        problems.push(
          `leg ${leg._id} is ${leg.amountCents}¢, expected ${EXPECTED_CENTS}¢ — SKIPPED`,
        );
      }
      // The whole justification for excluding rather than offsetting. If cash
      // HAD moved, voiding the ledger entry would leave the books claiming
      // money is somewhere it isn't.
      if (leg.externalId != null) {
        problems.push(
          `leg ${leg._id} carries externalId ${leg.externalId} — real cash moved, needs an offsetting transfer, not an exclusion — SKIPPED`,
        );
      }
    }
    if (problems.length > 0) {
      return {
        dryRun: !write,
        voided: 0,
        alreadyVoided: 0,
        bookValueRestoredCents: 0,
        problems,
      };
    }

    let voided = 0;
    let alreadyVoided = 0;
    for (const leg of legs) {
      if (leg.status === "excluded") {
        alreadyVoided += 1;
        continue;
      }
      if (write) {
        await ctx.db.patch(leg._id, { status: "excluded", note: VOID_NOTE });
      }
      voided += 1;
    }

    return {
      dryRun: !write,
      voided,
      alreadyVoided,
      // Central was credited and New York debited by the same amount; voiding
      // returns exactly that to each book, in opposite directions.
      bookValueRestoredCents: EXPECTED_CENTS,
      problems,
    };
  },
});
