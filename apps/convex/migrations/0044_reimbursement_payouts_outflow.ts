import type { MutationCtx } from "../_generated/server";
import type { Migration } from "./index";
import { internal } from "../_generated/api";

/**
 * Reimbursement payouts become real spend (founder report, 2026-07-26): flip
 * every historical payout transaction from `flow:"transfer"` to
 * `flow:"outflow"` so reimbursed purchases finally land in the budget and
 * category totals they're already coded to.
 *
 * WHY. `postReimbursementSpend` (increase.ts) used to write the payout as a
 * `transfer` — excluded from every SPEND total by `countsAsSpend` — on the
 * theory that the underlying expense was already booked against its category
 * from the reimbursement's line items. Nothing ever booked it:
 * `reimbursementLineItems` is read by no spend rollup, and the
 * `matchedTransactionId` that was supposed to tie a line to an already-synced
 * charge is never written. So a paid reimbursement showed a budget, a
 * category, and an amount in the UI while contributing $0 to both bars — the
 * "$303.86 Dig Inn charge that doesn't register" the founder hit. The live
 * insert path now writes `outflow`; this brings the existing rows with it.
 *
 * SCOPE. Only `source:"reimbursement"` rows still sitting at
 * `flow:"transfer"`. Every other transfer — skim / launch grant / settlement
 * legs (transfers.ts) and personal-charge repayment credits (cards.ts) —
 * stays a transfer: those genuinely have a matching leg or charge already in
 * the ledger, and flipping them WOULD double-count.
 *
 * REACHED VIA `reimbursementRequests`, not a scan of `transactions`: the
 * payout is keyed by `by_reimbursement`, the requests table is small, and this
 * mirrors `reimbursementBackfill.ts`'s own traversal exactly.
 *
 * IDEMPOTENT: a row already at `outflow` is skipped (`skippedAlready`), so a
 * re-run patches nothing — including a row a bookkeeper has since re-coded.
 * Rows whose flow is neither `transfer` nor `outflow` (an `inflow` someone
 * corrected by hand) are left alone and counted (`skippedOther`).
 *
 * ============================================================================
 * ONE `.paginate()` PER INVOCATION — same rule as 0040-0043. First page inside
 * `runPending`'s transaction; the rest drains via
 * `internal.migrations.continueReimbursementPayoutsOutflow`. One indexed read
 * per row, so a smaller page than 0043's: reads(page) ≤ 100 + 100.
 * Writes(page) ≤ 100.
 * ============================================================================
 */
const PAGE_SIZE = 100;

export type ReimbursementPayoutsOutflowPageResult = {
  scanned: number;
  flipped: number;
  skippedAlready: number;
  skippedOther: number;
  isDone: boolean;
  continueCursor: string | null;
};

/** Process exactly ONE page — exactly one `.paginate()` call. `pageSize` is a
 *  TEST-ONLY override, same convention as 0040-0043. */
export async function runReimbursementPayoutsOutflowPage(
  ctx: MutationCtx,
  cursor: string | null,
  pageSize?: number,
): Promise<ReimbursementPayoutsOutflowPageResult> {
  const page = await ctx.db
    .query("reimbursementRequests")
    .paginate({ numItems: pageSize ?? PAGE_SIZE, cursor });

  const result = { scanned: 0, flipped: 0, skippedAlready: 0, skippedOther: 0 };
  for (const req of page.page) {
    const txn = await ctx.db
      .query("transactions")
      .withIndex("by_reimbursement", (q) => q.eq("reimbursementId", req._id))
      .first();
    // `source` guard mirrors `reimbursementBackfill.ts`: only ever touch a row
    // this system wrote as a payout.
    if (!txn || txn.source !== "reimbursement") continue;
    result.scanned++;
    if (txn.flow === "outflow") {
      result.skippedAlready++;
      continue;
    }
    if (txn.flow !== "transfer") {
      result.skippedOther++;
      continue;
    }
    await ctx.db.patch(txn._id, { flow: "outflow" });
    result.flipped++;
  }

  if (!page.isDone) {
    await ctx.scheduler.runAfter(
      0,
      internal.migrations.continueReimbursementPayoutsOutflow,
      { cursor: page.continueCursor },
    );
  }

  return {
    ...result,
    isDone: page.isDone,
    continueCursor: page.isDone ? null : page.continueCursor,
  };
}

/** Registry entry point — first page only; the scheduled continuation drains
 *  the rest (same shape as 0040-0043, safe for the same idempotence reason). */
export async function runReimbursementPayoutsOutflow(ctx: MutationCtx) {
  return await runReimbursementPayoutsOutflowPage(ctx, null);
}

export const reimbursementPayoutsOutflow: Migration = {
  name: "0044_reimbursement_payouts_outflow",
  run: runReimbursementPayoutsOutflow,
};
