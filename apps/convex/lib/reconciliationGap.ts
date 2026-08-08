/**
 * DOES IT ADD UP? — the org-wide reconciliation gap.
 *
 * The accounts page has always had every number a treasurer needs and has never
 * answered the only question they came to ask. The founder, 2026-08-08:
 *
 *   "the whole point of this section is to see whether our books match what's
 *    in the bank account. So I just want things put in a format that shows me —
 *    hey, if we take all the pending, all the stuff in payout, and all the
 *    stuff in Stripe, and all the stuff in the account, we're still missing
 *    $50. […] But right now it's just very abstract to get that information."
 *
 * This file is the arithmetic that answers it, pulled out of the query so it
 * can be unit-tested without a database and read without one either.
 *
 * ── WHY THIS IS AN ORG TOTAL AND NOT A PER-BOOK ONE ──────────────────────────
 * Per-book "book vs bank" is NOT a reconciliation and must never be presented
 * as one. Every processor payout lands in CENTRAL's account, so central
 * perpetually holds cash the chapters earned; a chapter's book legitimately
 * exceeds its bank until the morning settlement moves the difference, and
 * central's bank legitimately exceeds its book for exactly as long. Subtracting
 * those two per book produces a number that is large, always non-zero, and
 * means nothing.
 *
 * Summed across every book those two distortions cancel exactly — the dollar
 * central holds for New York is one dollar in one Increase account either way.
 * The org total is the only level at which the difference is a finding.
 *
 * ── THE TWO SIDES, AND WHY EACH TERM SITS WHERE IT DOES ──────────────────────
 *
 * BOOKS SAY  = Σ book value over every book
 *              (revenue earned − what the ledger says went out; see
 *              `lib/bookBalance.ts` for exactly what counts and what is
 *              deliberately zero).
 *
 * MONEY WE CAN POINT AT = bank available + held against pending + at Stripe
 *
 *   · BANK AVAILABLE — Increase's `available_balance` per account. This is
 *     what `increaseAccounts.balanceCents` caches.
 *
 *   · HELD AGAINST PENDING — Increase's `current_balance − available_balance`.
 *     It belongs on the CASH side, added back, and getting this backwards is
 *     the single easiest way to write a wrong gap.
 *
 *     A pending item (a card authorization, an outbound transfer in flight, a
 *     hold on an inbound ACH debit) has been deducted from `available_balance`
 *     ALREADY but has not posted, so it has not reached the reconcile ledger
 *     and book value has NOT deducted it. Comparing book value against
 *     `available_balance` alone therefore charges the org for that money twice
 *     over — once on the cash side, never on the books side — and reports a
 *     shortfall that is purely an artifact of the two figures being on
 *     different bases.
 *
 *     Adding it back puts both sides on the same basis: neither has recognized
 *     the pending item yet. (Subtracting it from BOTH sides is the same
 *     equation and gives the same difference — this way round just keeps every
 *     displayed line a real, findable pile of money.)
 *
 *   · AT STRIPE — Stripe's `available` + `pending` balance. Revenue is counted
 *     at the gift/ticket/sale, which happens days before the payout, so money
 *     still sitting at the processor is already IN book value and is not yet in
 *     any bank account. Without this line it looks like it evaporated.
 *
 * ── WHAT IS DELIBERATELY *NOT* ADJUSTED FOR ──────────────────────────────────
 *
 * IN-KIND GIFTS. Someone buying $500 of gear for the org is $500 of revenue and
 * $500 of expense; no cash ever exists. That pair nets to zero INSIDE book
 * value already (`reconciliation.ts#computeBookBalances` phase 1 counts the
 * gift, the ledger carries the expense), so netting it out here a second time
 * would move the gap by the whole in-kind total in the wrong direction.
 *
 * It is reported alongside the gap instead, as context — because the netting
 * holds only when the offsetting expense was actually recorded. An in-kind gift
 * entered without its expense inflates book value by its full amount and lands
 * in this gap looking like missing cash. That is a REAL finding, and hiding it
 * behind an adjustment would be the one thing worse than not answering the
 * question at all.
 *
 * PROCESSOR FEES need no term here. Revenue is gross, payouts are net, and the
 * difference is booked as a real monthly expense row by `processorFees.ts` —
 * so it is already inside "what the ledger says went out".
 *
 * ── THE SIGN CONVENTION ──────────────────────────────────────────────────────
 * `differenceCents = located − books`, and the SIGN is the diagnosis, so it is
 * never shown as a bare absolute value:
 *
 *   · positive → more cash exists than the books explain. Money came in that
 *     was never recorded as revenue, or an expense was recorded that never
 *     actually left. (This deployment's Givebutter deposits are the standing
 *     example — see `processorFees.ts`.)
 *   · negative → the books claim money that is nowhere. Revenue counted twice
 *     (a gift AND the bank credit that delivered it), an in-kind gift without
 *     its expense, or spend that was never actually made.
 *
 * No tolerance band. Every figure on both sides is an integer number of cents,
 * so a difference of one cent is a real difference and saying otherwise would
 * be inventing slack the data does not have. What legitimately makes the number
 * move is snapshot STALENESS, and the honest fix for that is the "as of"
 * timestamp and the refresh the page now performs — not a fudge factor.
 */

/** Everything the gap is computed from. All fields are integer cents. */
export type ReconciliationInput = {
  /** Σ book value across every book (central + active chapters). */
  bookValueCents: number;
  /** Σ Increase `available_balance` across the org's accounts. */
  bankAvailableCents: number;
  /** Σ (`current_balance` − `available_balance`) — see the doc above. */
  bankPendingCents: number;
  /** Stripe's `available` balance; null until the first snapshot lands. */
  stripeAvailableCents: number | null;
  /** Stripe's `pending` balance; null until the first snapshot lands. */
  stripePendingCents: number | null;
};

export type ReconciliationVerdict =
  /** Books and cash agree to the cent. */
  | "balanced"
  /** More cash than the books explain — look for unrecorded income. */
  | "cash_exceeds_books"
  /** The books claim money that is not anywhere — look for a double count. */
  | "books_exceed_cash";

export type ReconciliationResult = {
  /** bank available + pending held + everything at Stripe. */
  locatedCents: number;
  /** `locatedCents − bookValueCents`. Sign carries the diagnosis. */
  differenceCents: number;
  verdict: ReconciliationVerdict;
  /** Stripe's two balances added, or null when no snapshot has ever landed. */
  stripeTotalCents: number | null;
  /**
   * True when a term the total depends on has never been fetched, so the
   * "located" side is knowably incomplete and the gap must not be presented as
   * a finding. Only Stripe can be missing here — a bank balance that has never
   * synced reads as 0 and is reported separately, by book name, because a
   * missing account is a different problem from a missing processor.
   */
  incomplete: boolean;
};

export function reconcileOrgMoney(
  input: ReconciliationInput,
): ReconciliationResult {
  const {
    bookValueCents,
    bankAvailableCents,
    bankPendingCents,
    stripeAvailableCents,
    stripePendingCents,
  } = input;

  // Null means "never fetched", which is NOT the same as zero and must not be
  // silently coerced to it — a zero would quietly manufacture a gap the size of
  // whatever is actually sitting at Stripe. Treated as 0 for the arithmetic so
  // the page still shows something, and flagged `incomplete` so the copy can
  // say the total is provisional.
  const stripeTotalCents =
    stripeAvailableCents == null && stripePendingCents == null
      ? null
      : (stripeAvailableCents ?? 0) + (stripePendingCents ?? 0);

  const locatedCents =
    bankAvailableCents + bankPendingCents + (stripeTotalCents ?? 0);
  const differenceCents = locatedCents - bookValueCents;

  return {
    locatedCents,
    differenceCents,
    verdict:
      differenceCents === 0
        ? "balanced"
        : differenceCents > 0
          ? "cash_exceeds_books"
          : "books_exceed_cash",
    stripeTotalCents,
    incomplete: stripeTotalCents == null,
  };
}
