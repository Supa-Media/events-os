import type { MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import type { Migration } from "./index";
import { materializeReimbursementReceipts } from "../lib/reimbursementReceipts";

/**
 * Give every already-paid reimbursement's receipt a real `receipts` row.
 *
 * WHY. The payout path used to copy a line's `receiptStorageId` straight onto
 * the transaction. That field is a denormalized cache of the first-LINKED
 * receipt, so the row ended up claiming a document that had no `receipts` row
 * and no `receiptLinks` row behind it: the charge read "receipt attached" —
 * truthfully, the file is in storage — while the Receipts library, which reads
 * `receipts`, could never list or find it. Two symptoms, one cause (founder,
 * 2026-08-12: "there is no receipt, but it says attached … but it's not in the
 * file").
 *
 * The live path is fixed, but that only helps payouts posted from now on.
 * Every reimbursement already in the books keeps a document nobody can find,
 * which is precisely the set the complaint was about.
 *
 * WHAT. For each `source:"reimbursement"` transaction carrying a
 * `reimbursementId`, run the same `materializeReimbursementReceipts` the live
 * path now runs: one receipt per line that has a file, each linked to the
 * payout row through the ordinary write path.
 *
 * SAFE ON ROWS A HUMAN HAS TOUCHED. The helper short-circuits on the
 * transaction's own `receiptLinks` — so a payout somebody already matched a
 * receipt to by hand is left completely alone, rather than gaining a second,
 * duplicate copy of the same document. That check is also what makes this
 * idempotent: a second run finds links everywhere it wrote them and does
 * nothing.
 *
 * The transaction's `receiptStorageId` is NOT cleared first. Where it already
 * points at the right file, linking leaves it as-is (the linker only writes the
 * cache when it is empty), so no row ever flickers to "missing receipt" — not
 * even for the instant this runs.
 *
 * BOUNDS: same transaction cap as `0067_rename_reimbursement_payout_rows`,
 * which walks the same table for the same population.
 */
const TXN_SCAN_LIMIT = 5000;

export type MaterializeReimbursementReceiptsResult = {
  /** Payout rows inspected. */
  scanned: number;
  /** `receipts` rows created and linked. */
  created: number;
  /** Payout rows skipped because they already carried links — a human had
   *  matched a receipt, or a previous run got there. */
  alreadyLinked: number;
};

export async function runMaterializeReimbursementReceipts(
  ctx: MutationCtx,
): Promise<MaterializeReimbursementReceiptsResult> {
  const result: MaterializeReimbursementReceiptsResult = {
    scanned: 0,
    created: 0,
    alreadyLinked: 0,
  };

  const txns = await ctx.db.query("transactions").take(TXN_SCAN_LIMIT);
  for (const tr of txns) {
    if (tr.source !== "reimbursement" || !tr.reimbursementId) continue;

    const req = await ctx.db.get(
      tr.reimbursementId as Id<"reimbursementRequests">,
    );
    if (!req) continue;
    result.scanned++;

    const res = await materializeReimbursementReceipts(ctx, {
      req,
      transactionId: tr._id,
      chapterId: tr.chapterId,
    });
    if (res.alreadyMaterialized) result.alreadyLinked++;
    result.created += res.created;
  }

  return result;
}

export const materializeReimbursementReceiptsMigration: Migration = {
  name: "0069_materialize_reimbursement_receipts",
  run: runMaterializeReimbursementReceipts,
};
