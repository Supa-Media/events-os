/**
 * WHAT COVERING THE PROCESSOR'S FEE ADDS to a personal-charge repayment — the
 * ONE place that arithmetic happens.
 *
 * Extracted from `cards.ts` when the no-login pay-back link (`repaymentLinks.ts`)
 * needed the identical quote: the same debt, quoted two different ways
 * depending on whether the payer happened to be logged in, would be the exact
 * failure the fee work was done to prevent. Two implementations of a price
 * agree right up until somebody edits one.
 *
 * ── WHY GROSS UP RATHER THAN ADD ON TOP ─────────────────────────────────────
 * The rail charges its percentage on whatever it settles, including the part
 * that covers its own fee, so `intended + fee(intended)` nets less than
 * `intended`. `grossUpCents` solves for the charge that nets the debt whole.
 * See its own doc for the algebra and the cap case.
 *
 * ── WHICH RAIL MATTERS A LOT ────────────────────────────────────────────────
 * Card is 2.9% + 30¢; bank debit is 0.8% capped at $5.00. On a $248 charge
 * that is $7.72 against $2.00 — and since 2026-08-14 the fee is the PAYER'S,
 * so quietly pricing everyone at the card rate would be the org saving its own
 * inconvenience with a volunteer's money.
 *
 * Degrades to a zero fee when a rail has no resolvable rate: a missing rate row
 * must not block somebody from paying the org back, and absorbing the fee is
 * exactly what shipped before fee coverage existed. A quiet, recoverable loss,
 * not a broken page.
 */
import { describeFeeRate, feeCoverageCents } from "@events-os/shared";
import type { RepaymentMethod } from "@events-os/shared";
import type { QueryCtx } from "../_generated/server";
import { resolveFeeRate } from "./feeSchedule";

/** `personalRepayments.method` → the fee schedule's rail name. Two vocabularies
 *  for the same thing that are NOT the same string: `"ach"` is what repayments
 *  have stored since the Increase rail, `"ach_debit"` is what `FEE_METHODS`
 *  (and Stripe) call it. Mapped once rather than at each call site. */
export function feeMethodFor(method: RepaymentMethod): "card" | "ach_debit" {
  return method === "ach" ? "ach_debit" : "card";
}

/**
 * Stripe Checkout's `payment_method_types` for a repayment method.
 *
 * A card session deliberately passes NOTHING (Stripe's default), matching the
 * giving checkouts — pinning the list would silently switch off the wallets
 * (Apple/Google Pay) the account already accepts and that cost the same as a
 * card.
 */
export function stripePaymentMethodTypes(
  method: RepaymentMethod,
): string[] | null {
  return method === "ach" ? ["us_bank_account"] : null;
}

/** What covering the fee adds, and the rate that produced it. */
export async function repaymentFeeQuoteFor(
  ctx: QueryCtx,
  intendedCents: number,
  method: RepaymentMethod,
): Promise<{ feeCents: number; rateLabel: string | null }> {
  if (intendedCents <= 0) return { feeCents: 0, rateLabel: null };
  const feeMethod = feeMethodFor(method);
  const rate = await resolveFeeRate(ctx, "stripe", feeMethod);
  if (!rate) {
    console.warn(
      `[repaymentFees] no stripe:${feeMethod} rail resolved — billing the ` +
        "repayment at face value and absorbing the processing fee.",
    );
    return { feeCents: 0, rateLabel: null };
  }
  return {
    feeCents: feeCoverageCents(intendedCents, rate),
    rateLabel: describeFeeRate(rate),
  };
}

/** Both rails at once — what the payer is choosing between. */
export async function repaymentRailQuotes(
  ctx: QueryCtx,
  totalCents: number,
): Promise<{
  card: { feeCents: number; chargeCents: number; rateLabel: string | null };
  ach: { feeCents: number; chargeCents: number; rateLabel: string | null };
}> {
  return {
    card: await repaymentRailQuote(ctx, totalCents, "card"),
    ach: await repaymentRailQuote(ctx, totalCents, "ach"),
  };
}

/** One rail's quote, in the shape both pay pages render. */
export async function repaymentRailQuote(
  ctx: QueryCtx,
  totalCents: number,
  method: RepaymentMethod,
): Promise<{ feeCents: number; chargeCents: number; rateLabel: string | null }> {
  const { feeCents, rateLabel } = await repaymentFeeQuoteFor(
    ctx,
    totalCents,
    method,
  );
  return { feeCents, chargeCents: totalCents + feeCents, rateLabel };
}
