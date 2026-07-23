/**
 * One-shot backfill: port each ALREADY-PAID reimbursement's descriptive +
 * attribution data onto its payout transaction (the `flow:"transfer"` row
 * `postReimbursementTransfer` created). Before the fix in `increase.ts`, those
 * rows were written bare, so historical reimbursements show up in Reconcile as
 * "Unlabeled charge / Uncategorized / For: None / missing receipt" even though
 * every field exists on the reimbursement.
 *
 * Internal only, invoked manually (the `financeGenesisBackfill` precedent — the
 * orchestrator runs it via the run-convex-function workflow after a dry run).
 * Nothing here is on the public API, nothing runs on a cron, there is no UI.
 *
 * SAFE + IDEMPOTENT: dry-run by default (`execute:false` writes NOTHING and
 * returns the counts a real run would produce). Fill-BLANKS-ONLY — it never
 * overwrites a field a human already set, and a "For" (event/project/budget) is
 * only added when the row has none, so a second execute run patches nothing new.
 * Paginates the (small) `reimbursementRequests` table and self-reschedules until
 * done when executing.
 */
import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { deriveReimbursementTxnFields } from "./lib/reimbursementTxnFields";

const PAGE_SIZE = 100;

/** The fill-blanks patch for one payout txn: only the derived fields the txn is
 *  currently missing. Returns an empty object when the row is already complete. */
function fillBlanksPatch(
  txn: Doc<"transactions">,
  ported: Awaited<ReturnType<typeof deriveReimbursementTxnFields>>,
): Partial<Doc<"transactions">> {
  const patch: Partial<Doc<"transactions">> = {};
  if (txn.merchantName == null && ported.merchantName != null) patch.merchantName = ported.merchantName;
  if (txn.description == null && ported.description != null) patch.description = ported.description;
  if (txn.note == null && ported.note != null) patch.note = ported.note;
  if (txn.categoryId == null && ported.categoryId != null) patch.categoryId = ported.categoryId;
  if (txn.fundId == null && ported.fundId != null) patch.fundId = ported.fundId;
  if (txn.receiptStorageId == null && ported.receiptStorageId != null) {
    patch.receiptStorageId = ported.receiptStorageId;
  }
  // "For" is a single slot — only add one, and only if the row has none.
  if (txn.budgetId == null && txn.eventId == null && txn.projectId == null) {
    if (ported.budgetId != null) patch.budgetId = ported.budgetId;
    else if (ported.eventId != null) patch.eventId = ported.eventId;
    else if (ported.projectId != null) patch.projectId = ported.projectId;
  }
  return patch;
}

export const backfillReimbursementTxnData = internalMutation({
  args: {
    execute: v.optional(v.boolean()),
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  returns: v.object({
    scanned: v.number(),
    patched: v.number(),
    isDone: v.boolean(),
    continueCursor: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args) => {
    const execute = args.execute ?? false;
    const page = await ctx.db
      .query("reimbursementRequests")
      .paginate({ numItems: PAGE_SIZE, cursor: args.cursor ?? null });

    let scanned = 0;
    let patched = 0;

    for (const req of page.page) {
      // The single transfer row this reimbursement's payout posted (if any).
      const txn = await ctx.db
        .query("transactions")
        .withIndex("by_reimbursement", (q) => q.eq("reimbursementId", req._id))
        .first();
      if (!txn || txn.source !== "reimbursement") continue;
      scanned++;

      const ported = await deriveReimbursementTxnFields(ctx, req);
      const patch = fillBlanksPatch(txn, ported);
      if (Object.keys(patch).length === 0) continue;
      patched++;
      if (execute) await ctx.db.patch(txn._id, patch);
    }

    const continueCursor = page.isDone ? null : page.continueCursor;
    // Drain the rest of the table on a real run so one invocation finishes it.
    if (execute && !page.isDone) {
      await ctx.scheduler.runAfter(0, internal.reimbursementBackfill.backfillReimbursementTxnData, {
        execute: true,
        cursor: continueCursor,
      });
    }

    return { scanned, patched, isDone: page.isDone, continueCursor };
  },
});
