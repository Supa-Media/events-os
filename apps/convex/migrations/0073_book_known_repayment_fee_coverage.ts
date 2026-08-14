import type { MutationCtx } from "../_generated/server";
import type { Migration } from "./index";
import type { Doc } from "../_generated/dataModel";
import { postRepaymentFeeCoverage } from "../cards";

/**
 * Book the fee coverage on the repayments that settled before there was a row
 * to put it in — BY NAME, not by search.
 *
 * ── WHAT WENT WRONG ─────────────────────────────────────────────────────────
 * `settleRepayment` posted a credit for the DEBT while the payer had sent the
 * debt PLUS the processor's fee, and the monthly fee sweep booked that fee as
 * an expense regardless. So the expense had nothing funding it and book value
 * sank by the coverage. Founder, 2026-08-14: "the charge was $6… the payback
 * on the charge was $6.49. And then all of a sudden, the unaccounted for in
 * our banking was 49 cents." The sibling change posts the row going forward;
 * this puts it on the payment that already happened.
 *
 * ── WHY A PINNED LIST ───────────────────────────────────────────────────────
 * The first version of this read Stripe and derived each coverage from
 * `amount_total − the debts the session settled`, because `processorFees.ts`'s
 * rule is that a fee schedule "never re-derives what one DID cost". That is the
 * right instinct for a rule that has to hold at any scale — and the wrong shape
 * for a population of ONE known payment, a day old, whose numbers the founder
 * read off the screen and handed over. It bought a Stripe round-trip, a
 * `STRIPE_SECRET_KEY` dependency, an action outside the registry and a manual
 * step after every deploy, to rediscover a figure already known.
 *
 * So the expectation is written down instead, the same way `genesisGiftSync`
 * pins each row it corrects with its own `why`. Nothing here is derived: the
 * coverage is stated, and the row it belongs to has to match the stated debt.
 *
 * ── IT REFUSES RATHER THAN GUESSES ──────────────────────────────────────────
 * The hazard a search would have carried is a repayment of the same amount that
 * settled at FACE VALUE, before fee coverage existed — crediting it 49¢ invents
 * money nobody sent, which is this bug pointed the other way. Three guards, and
 * the third is the one that matters:
 *
 *   · only repayments settled through Stripe (`stripeCheckoutSessionId`, and
 *     actually `paid`) are candidates at all;
 *   · only those settled at or after fee coverage reached the repayment
 *     checkout (#708, merged 2026-08-13 22:19 ET) — before that, nobody was
 *     charged a coverage line;
 *   · the candidate count must be EXACTLY what the entry expects. A second
 *     $6.00 repayment appearing means the assumption behind the pin is no
 *     longer true, and the entry is SKIPPED whole rather than applied to a
 *     coin-flip. Loudly, so it gets looked at rather than silently dropped.
 *
 * Idempotent twice over: the ledger skips a second run, and the writer itself
 * dedupes on `externalId` (`cards.ts#postRepaymentFeeCoverage`), which is the
 * same guard the live webhook path leans on.
 */

/** When fee coverage first reached a repayment checkout — #708's merge,
 *  2026-08-13 22:19:56 ET. A repayment settled before this was billed at face
 *  value and has no coverage to book. Deliberately the MERGE and not the
 *  deploy: the earlier bound is the permissive one, and the exact-count guard
 *  below is what actually keeps a pre-feature row out. */
const FEE_COVERAGE_SHIPPED_MS = Date.parse("2026-08-14T02:19:56Z");

/**
 * The payments this corrects, each with the numbers it was reported with.
 *
 * `coverageCents` is STATED, never recomputed — it is what the payer was
 * actually charged over the debt, per the founder reading it off Stripe. It
 * happens to equal `grossUpCents(600, card) - 600`, and that agreement is a
 * useful sanity check, but the arithmetic is not the source: a rate row edited
 * next month must not silently change what this migration books.
 */
const KNOWN_COVERAGE: ReadonlyArray<{
  debtCents: number;
  coverageCents: number;
  expectedRows: number;
  why: string;
}> = [
  {
    debtCents: 600,
    coverageCents: 49,
    expectedRows: 1,
    why:
      "Founder, 2026-08-14: a $6.00 accidental personal charge repaid by card as " +
      "$6.49. The 49¢ was the fee the payer covered; with no row for it the fee " +
      "sweep's expense went unfunded and the 49¢ read as unaccounted-for cash.",
  },
];

export async function runBookKnownRepaymentFeeCoverage(
  ctx: MutationCtx,
): Promise<{ booked: number; centsBooked: number; refused: number }> {
  let booked = 0;
  let centsBooked = 0;
  let refused = 0;

  const all = await ctx.db.query("personalRepayments").collect();
  const settledViaStripe = all.filter(
    (r) =>
      r.status === "paid" &&
      r.creditTransactionId != null &&
      r.stripeCheckoutSessionId != null &&
      r.updatedAt >= FEE_COVERAGE_SHIPPED_MS,
  );

  for (const entry of KNOWN_COVERAGE) {
    const matches = settledViaStripe.filter(
      (r) => r.amountCents === entry.debtCents,
    );
    if (matches.length !== entry.expectedRows) {
      console.error(
        `[0073] expected ${entry.expectedRows} settled Stripe repayment(s) of ` +
          `${entry.debtCents}c since fee coverage shipped, found ${matches.length}. ` +
          `REFUSING this entry rather than guessing which row the ` +
          `${entry.coverageCents}c belongs to. ${entry.why}`,
      );
      refused += 1;
      continue;
    }

    // One session may have settled several debts; group so the coverage is
    // posted once per PAYMENT, which is what the payer was charged.
    const bySession = new Map<string, Doc<"personalRepayments">[]>();
    for (const r of matches) {
      const key = r.stripeCheckoutSessionId!;
      bySession.set(key, [...(bySession.get(key) ?? []), r]);
    }

    for (const [sessionId, repayments] of bySession) {
      // `postRepaymentFeeCoverage` is the SAME writer the live webhook uses —
      // dedup key, book choice, note, flow and status all come from there, so a
      // row written by this migration is indistinguishable from one written by
      // a payment, which is the point.
      await postRepaymentFeeCoverage(ctx, {
        sessionId,
        coverageCents: entry.coverageCents,
        repayments,
      });
      console.log(
        `[0073] booked ${entry.coverageCents}c of fee coverage on session ` +
          `${sessionId} (debt ${entry.debtCents}c). ${entry.why}`,
      );
      booked += 1;
      centsBooked += entry.coverageCents;
    }
  }

  console.log(
    `[0073] booked ${booked} coverage row(s) totalling ${centsBooked}c; ` +
      `${refused} entr(ies) refused.`,
  );
  return { booked, centsBooked, refused };
}

export const bookKnownRepaymentFeeCoverage: Migration = {
  name: "0073_book_known_repayment_fee_coverage",
  run: runBookKnownRepaymentFeeCoverage,
};
