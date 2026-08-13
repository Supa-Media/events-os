import type { MutationCtx } from "../_generated/server";
import type { Migration } from "./index";
import {
  codingPolicy,
  materializePortedReimbursementCoding,
} from "../lib/transactionCoding";
import { deriveReimbursementCodingMaterialization } from "../lib/reimbursementTxnFields";

/**
 * Backfill: materialize a coding for every EXISTING reimbursement payout
 * transaction whose request meets the same deliberately narrow bar the live
 * path (`increasePayoutMachine.ts#postReimbursementSpend`) now applies going
 * forward (founder directive, 2026-08-13) — exactly one line item, that
 * line's own §274(d) answer complete per the shared `codingFieldProblems`
 * validator. PORTED VERBATIM, never composed: see
 * `lib/reimbursementTxnFields.ts#deriveReimbursementCodingMaterialization`
 * for the eligibility rule and `lib/transactionCoding.ts
 * #materializePortedReimbursementCoding` for the write, both shared with the
 * live path so this can never drift from what a fresh payout gets.
 *
 * REACHED VIA `reimbursementRequests`, not a scan of `transactions` — same
 * traversal as `0044_reimbursement_payouts_outflow` and the same reasoning:
 * the requests table is small, and every payout transaction is reachable
 * from its request via the `by_reimbursement` index. SINGLE INVOCATION, no
 * scheduler continuation (mirrors `0066_stamp_cashback_source_category`'s
 * shape) — capped at `SCAN_LIMIT`, a backstop this deployment's row count
 * doesn't approach; `truncated` reports if a re-run is ever needed.
 *
 * NUMBERED 0068 (not 0067) — a sibling workstream's
 * `0067_rename_reimbursement_payout_rows` landed on `main` first; this stays
 * append-only after it.
 *
 * SKIPS, each counted:
 *  - no payout transaction yet, or a payout not `source:"reimbursement"`
 *    (`skippedNoTxn`) — nothing to code.
 *  - a coding row already exists on the transaction, human-authored or
 *    already ported (`skippedAlreadyCoded`) — NEVER clobbered; this is what
 *    makes a re-run of this migration, and its overlap with the live path,
 *    idempotent.
 *  - the request doesn't clear the eligibility bar — multi-line, an
 *    incomplete line, or no recorded decision (`skippedIneligible`) — left
 *    for the normal human coding flow (the `reimbursementContext` prefill).
 *
 * IDEMPOTENT: every write path here is gated by `codingForTransaction`
 * inside `materializePortedReimbursementCoding` itself.
 */
const SCAN_LIMIT = 5000;

export type MaterializeReimbursementCodingsResult = {
  scanned: number;
  materialized: number;
  skippedNoTxn: number;
  skippedAlreadyCoded: number;
  skippedIneligible: number;
  /** The scan cap bit — requests past it were not examined; re-run to
   *  continue (this deployment's row counts don't approach `SCAN_LIMIT`). */
  truncated: boolean;
};

export async function runMaterializeReimbursementCodings(
  ctx: MutationCtx,
): Promise<MaterializeReimbursementCodingsResult> {
  const requests = await ctx.db.query("reimbursementRequests").take(SCAN_LIMIT);
  const { namesMaxHeadcount } = await codingPolicy(ctx);

  const result: MaterializeReimbursementCodingsResult = {
    scanned: 0,
    materialized: 0,
    skippedNoTxn: 0,
    skippedAlreadyCoded: 0,
    skippedIneligible: 0,
    truncated: requests.length === SCAN_LIMIT,
  };

  for (const req of requests) {
    const txn = await ctx.db
      .query("transactions")
      .withIndex("by_reimbursement", (q) => q.eq("reimbursementId", req._id))
      .first();
    // `source` guard mirrors `0044`: only ever touch a row this system wrote
    // as a payout.
    if (!txn || txn.source !== "reimbursement") {
      result.skippedNoTxn++;
      continue;
    }
    result.scanned++;

    const materialization = await deriveReimbursementCodingMaterialization(
      ctx,
      req,
      namesMaxHeadcount,
    );
    if (!materialization.eligible) {
      result.skippedIneligible++;
      continue;
    }

    const codingId = await materializePortedReimbursementCoding(ctx, {
      transactionId: txn._id,
      scope: txn.chapterId,
      fields: materialization.fields,
      namesMaxHeadcount,
      codedByPersonId: materialization.codedByPersonId,
      codedByUserId: materialization.codedByUserId,
      decidedByPersonId: materialization.decidedByPersonId,
      decidedByUserId: materialization.decidedByUserId,
      decidedAt: materialization.decidedAt,
      submittedAt: materialization.submittedAt,
      approvalParty: materialization.approvalParty,
      portedFromReimbursementId: req._id,
    });
    if (codingId == null) {
      result.skippedAlreadyCoded++;
    } else {
      result.materialized++;
    }
  }

  return result;
}

export const materializeReimbursementCodings: Migration = {
  name: "0068_materialize_reimbursement_codings",
  run: runMaterializeReimbursementCodings,
};
