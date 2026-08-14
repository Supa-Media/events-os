import { describe, expect, test } from "vitest";
import { grossUpCents, DEFAULT_FEE_SCHEDULE, type FeeRate } from "@events-os/shared";
import { reconcileOrgMoney } from "../lib/reconciliationGap";

/**
 * THE 49¢ — why a repaid personal charge left the org's own money unexplained.
 *
 * Founder, 2026-08-14: "someone did that recently, and it looks like the charge
 * was $6… the payback on the charge was $6.49. And then all of a sudden, the
 * unaccounted for in our banking was 49 cents."
 *
 * Three pieces of correct-looking code produced it, and only together:
 *
 *   1. `cards.ts#settleRepayment` posts a credit for the DEBT. Right — a debt
 *      cannot be overpaid.
 *   2. `processorFees.ts` books every cent Stripe took as an expense against
 *      book value, this payment's cut included. Also right — it is a real cost,
 *      read from Stripe's own ledger.
 *   3. `reconciliationGap.ts` compares located cash against book value.
 *
 * The payer sent debt + fee. Only the debt was booked. So the fee expense had
 * nothing funding it, and the books came up short by exactly the coverage while
 * the cash did not — the definition of `cash_exceeds_books`.
 *
 * These are ARITHMETIC tests against the real gap function rather than a
 * database walk: the failure was never in one row, it was in the sum, and the
 * sum is what has to come out right.
 */

const CARD = DEFAULT_FEE_SCHEDULE.find(
  (r) => r.processor === "stripe" && r.method === "card",
)! as FeeRate;

/** The founder's case, to the cent. */
const DEBT = 600;
const CHARGE = grossUpCents(DEBT, CARD); // 649
const COVERAGE = CHARGE - DEBT; // 49
/** What Stripe actually takes on a $6.49 card charge — and it is exactly the
 *  coverage, which is what "grossed up" means. */
const STRIPE_FEE = Math.round((CHARGE * CARD.percentBps) / 10_000) + CARD.fixedCents;

/** Everything else about the org held flat, so the only moving part is the
 *  repayment. The personal charge itself already netted out: it took $6.00 off
 *  the book when it posted and the same $6.00 off the bank. */
function gapWith(bookValueCents: number, stripeBalanceCents: number) {
  return reconcileOrgMoney({
    bookValueCents,
    bankAvailableCents: 0,
    bankPendingCents: 0,
    stripeAvailableCents: stripeBalanceCents,
    stripePendingCents: 0,
    givebutterUndepositedCents: null,
    givebutterConfigured: false,
    relayBalanceCents: 0,
  });
}

describe("the arithmetic of a fee-covered repayment", () => {
  test("the gross-up is exact — the org nets the debt, Stripe takes the rest", () => {
    expect(CHARGE).toBe(649);
    expect(COVERAGE).toBe(49);
    expect(STRIPE_FEE).toBe(49);
    // Which is the reason nobody is out of pocket, and the reason the missing
    // 49¢ was never a pricing bug — only a bookkeeping one.
    expect(CHARGE - STRIPE_FEE).toBe(DEBT);
  });

  test("booking only the debt leaves the fee expense unfunded — the bug", () => {
    // What the books did BEFORE this change: the repayment credit, and the fee
    // sweep's expense. Stripe holds the charge less its own fee.
    const bookValue = DEBT - STRIPE_FEE; // 600 − 49 = 551
    const stripeBalance = CHARGE - STRIPE_FEE; // 649 − 49 = 600

    const gap = gapWith(bookValue, stripeBalance);

    expect(gap.verdict).toBe("cash_exceeds_books");
    expect(gap.differenceCents).toBe(COVERAGE);
    expect(gap.differenceCents).toBe(49);
  });

  test("booking the coverage beside it closes the gap exactly", () => {
    // What the books do NOW: the credit, the coverage row, and the same fee.
    const bookValue = DEBT + COVERAGE - STRIPE_FEE; // 600 + 49 − 49 = 600
    const stripeBalance = CHARGE - STRIPE_FEE; // 600

    const gap = gapWith(bookValue, stripeBalance);

    expect(gap.verdict).toBe("balanced");
    expect(gap.differenceCents).toBe(0);
  });

  test("it is not a rounding artefact — the gap scales with the debt", () => {
    // A $248 repayment on the card rail, the amount `repaymentFees.ts`'s own
    // doc uses. If the mechanism were a rounding quirk the gap would stay at a
    // cent or two; it tracks the coverage exactly, at every size.
    for (const debt of [600, 2_500, 24_800, 100_000]) {
      const charge = grossUpCents(debt, CARD);
      const coverage = charge - debt;
      const fee = Math.round((charge * CARD.percentBps) / 10_000) + CARD.fixedCents;

      const before = gapWith(debt - fee, charge - fee);
      expect(before.verdict).toBe("cash_exceeds_books");
      expect(before.differenceCents).toBe(coverage);

      const after = gapWith(debt + coverage - fee, charge - fee);
      expect(after.verdict).toBe("balanced");
    }
  });

  test("a repayment nobody covered was never affected", () => {
    // The regression guard for the other direction: where the payer paid face
    // value, the org ate the fee — which is a real cost, correctly booked, and
    // must keep showing up as one. Nothing here should have changed it.
    const charge = DEBT;
    const fee = Math.round((charge * CARD.percentBps) / 10_000) + CARD.fixedCents;
    const gap = gapWith(DEBT - fee, charge - fee);
    expect(gap.verdict).toBe("balanced");
  });
});
