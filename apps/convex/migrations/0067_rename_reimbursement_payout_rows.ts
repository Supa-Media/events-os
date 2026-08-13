import type { MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { Migration } from "./index";

/**
 * Rename reimbursement PAYOUT rows that are still titled after the payee.
 *
 * WHY. `deriveReimbursementTxnFields` used a line's own description as the
 * transaction's `merchantName` only when the reimbursement had exactly ONE
 * line; anything with two or more collapsed to "Reimbursement to <payee>". So a
 * Reconcile row covering a bus ticket and a parking fee said only that Adam got
 * money — the one fact the amount and payee columns were already showing.
 * (Founder, 2026-08-12: "I hate that the line item is reimbursed to Adam. The
 * line item should read what it actually was.")
 *
 * The derivation is fixed, but that only helps rows written from now on: the
 * one-shot backfill in `reimbursementBackfill.ts` is deliberately
 * fill-blanks-only and will never clobber a `merchantName` that is already set.
 * Every payout already in the books would keep its payee title forever.
 *
 * WHAT. For each `source:"reimbursement"` transaction carrying a
 * `reimbursementId`: recompute the line summary, and write it ONLY IF the row's
 * current `merchantName` is still exactly the auto-generated payee label for
 * that reimbursement. That equality check is the whole safety argument — it is
 * what tells an untouched auto-derived title apart from one a human typed, and
 * a bookkeeper's own wording is never overwritten.
 *
 * `description` already holds the payee label and is left alone, so who was
 * paid stays on the row; the grid shows it beneath the merchant name whenever
 * the two differ (`rawBankLine`).
 *
 * IDEMPOTENT: after the rewrite `merchantName` no longer equals the payee
 * label, so a second run matches nothing.
 */
const TXN_SCAN_LIMIT = 5000;
const LINE_SCAN_LIMIT = 200;
/** Mirrors `lib/reimbursementTxnFields.ts#MERCHANT_LINES_SHOWN` — the two must
 *  agree or a migrated row would read differently from a freshly written one. */
const MERCHANT_LINES_SHOWN = 2;

export type RenameReimbursementPayoutRowsResult = {
  /** Payout rows retitled from the payee label to what was actually bought. */
  renamed: number;
  /** Rows left alone because someone had already titled them by hand. */
  humanTitled: number;
  /** Rows whose lines carry no description at all — the payee label is still
   *  the best available title, so it stays. */
  noLineText: number;
};

function lineSummary(lines: Doc<"reimbursementLineItems">[]): string {
  const described = lines
    .map((l) => l.description?.trim())
    .filter((d): d is string => !!d);
  if (described.length === 0) return "";
  const shown = described.slice(0, MERCHANT_LINES_SHOWN);
  const rest = described.length - shown.length;
  return rest > 0 ? `${shown.join(" + ")} +${rest} more` : shown.join(" + ");
}

export async function runRenameReimbursementPayoutRows(
  ctx: MutationCtx,
): Promise<RenameReimbursementPayoutRowsResult> {
  const result: RenameReimbursementPayoutRowsResult = {
    renamed: 0,
    humanTitled: 0,
    noLineText: 0,
  };

  const txns = await ctx.db.query("transactions").take(TXN_SCAN_LIMIT);
  for (const tr of txns) {
    if (tr.source !== "reimbursement" || !tr.reimbursementId) continue;

    const req = await ctx.db.get(tr.reimbursementId as Id<"reimbursementRequests">);
    if (!req) continue;

    // The exact string the old derivation would have written. Anything else in
    // `merchantName` came from a human (or a later edit) and is left alone.
    const payeeLabel = `Reimbursement to ${req.payeeName}`;
    if (tr.merchantName !== payeeLabel) {
      if (tr.merchantName) result.humanTitled++;
      continue;
    }

    const lines = await ctx.db
      .query("reimbursementLineItems")
      .withIndex("by_reimbursement", (q) => q.eq("reimbursementId", req._id))
      .take(LINE_SCAN_LIMIT);
    const summary = lineSummary(lines);
    if (!summary) {
      result.noLineText++;
      continue;
    }

    await ctx.db.patch(tr._id, { merchantName: summary });
    result.renamed++;
  }

  return result;
}

export const renameReimbursementPayoutRows: Migration = {
  name: "0066_rename_reimbursement_payout_rows",
  run: runRenameReimbursementPayoutRows,
};
