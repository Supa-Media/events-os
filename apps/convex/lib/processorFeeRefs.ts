/**
 * How a processor-fee row and its budget are RECOGNISED.
 *
 * Extracted from `processorFees.ts` so `finances.listReconcile` can identify the
 * same rows for its fee-budget banner without importing that module (which
 * imports from `finances.ts` — the cycle is the reason this file exists rather
 * than an export over there).
 *
 * Both values are identity, not decoration: `FEE_REF_PREFIX` is what the sync
 * writes into `externalId` to make its rows idempotent, and `feeBudgetLabel` is
 * simultaneously what the sync names the budget it proposes and how a human
 * recognises it in the Budgets list. A second spelling of either in another file
 * would silently stop matching.
 */

/** `externalId` prefix on every row the Stripe fee sync creates. */
export const FEE_REF_PREFIX = "stripe-fees:";

/** The label the sync gives a budget it creates. Also how a human recognises it. */
export function feeBudgetLabel(year: number): string {
  return `Processor fees ${year}`;
}
