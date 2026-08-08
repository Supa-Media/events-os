/**
 * Publishability — what stands between a period and a public ledger.
 *
 * Public Worship is publishing every transaction. A period is publishable
 * only when all THREE axes are green for every row that owes anything:
 *
 *   documentation — a receipt, or an approved receipt exception
 *   coding        — an approved `transactionCodings` record (the what/why/who)
 *   review        — reconciled by a bookkeeper+
 *
 * This module reports the gap per period + book, so the close meeting has a
 * number instead of a feeling. See `docs/plans/transaction-coding.md`
 * (phase 4) and `docs/plans/receipt-exceptions.md`.
 */
import { query } from "./_generated/server";
import { v } from "convex/values";

/** Placeholder export so the module registers; the real report lands with
 *  phase 4. */
export const placeholder = query({
  args: {},
  returns: v.null(),
  handler: async () => null,
});
