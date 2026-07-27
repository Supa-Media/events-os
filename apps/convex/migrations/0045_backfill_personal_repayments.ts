import type { MutationCtx } from "../_generated/server";
import type { Migration } from "./index";
import { internal } from "../_generated/api";
import { convertChargeToPersonalRepayment } from "../cards";

/**
 * Backfill `personalRepayments` rows for legacy `isPersonal:true` transactions
 * that have none.
 *
 * WHY. The now-deleted `finances.ts#flagPersonal` (a plain boolean setter —
 * see its removal note in `finances.ts`) used to be the ONLY marking path
 * some transactions ever went through: it patched `isPersonal:true` directly
 * and created no `personalRepayments` row, so nobody was ever actually
 * billed for the charge and no email ever went out. Every marking path now
 * routes through `cards.ts#flagPersonalCharge`, which always creates the
 * repayment via the shared `convertChargeToPersonalRepayment` core — this
 * migration is the one-time catch-up for whatever `flagPersonal` already
 * left behind in production.
 *
 * SCOPE. Only `isPersonal === true` transactions with `repaymentId == null`.
 * A row already carrying a `repaymentId` was flagged through the real
 * workflow (or already backfilled) and is skipped untouched.
 *
 * PAYEE RESOLUTION mirrors `flagPersonalCharge`'s own rule exactly: the
 * txn's `personId`, else its `cardId`'s `cardholderPersonId`. A row with
 * NEITHER can't be billed — counted (`skippedNoPayee`) and left as a plain
 * `isPersonal:true` row for a human to resolve by hand (attach a person, or
 * un-flag it); this migration never invents a payee or drops the flag.
 *
 * IDEMPOTENT: a re-run finds every backfilled row now carrying a
 * `repaymentId` and skips it (`skippedAlready`).
 *
 * ============================================================================
 * ONE `.paginate()` PER INVOCATION — same rule as every migration since 0040.
 * First page inside `runPending`'s transaction; the rest drains via
 * `internal.migrations.continueBackfillPersonalRepayments`.
 * ============================================================================
 */
const PAGE_SIZE = 100;

export type BackfillPersonalRepaymentsPageResult = {
  scanned: number;
  created: number;
  skippedAlready: number;
  skippedNotPersonal: number;
  skippedNoPayee: number;
  isDone: boolean;
  continueCursor: string | null;
};

/** Process exactly ONE page — exactly one `.paginate()` call. `pageSize` is a
 *  TEST-ONLY override, same convention as 0040-0044. */
export async function runBackfillPersonalRepaymentsPage(
  ctx: MutationCtx,
  cursor: string | null,
  pageSize?: number,
): Promise<BackfillPersonalRepaymentsPageResult> {
  const page = await ctx.db.query("transactions").paginate({
    numItems: pageSize ?? PAGE_SIZE,
    cursor,
  });

  const result = {
    scanned: 0,
    created: 0,
    skippedAlready: 0,
    skippedNotPersonal: 0,
    skippedNoPayee: 0,
  };
  for (const txn of page.page) {
    if (txn.isPersonal !== true) {
      result.skippedNotPersonal++;
      continue;
    }
    result.scanned++;
    if (txn.repaymentId != null) {
      result.skippedAlready++;
      continue;
    }
    let payerPersonId = txn.personId ?? null;
    if (!payerPersonId && txn.cardId) {
      const card = await ctx.db.get(txn.cardId);
      payerPersonId = card?.cardholderPersonId ?? null;
    }
    if (!payerPersonId) {
      result.skippedNoPayee++;
      continue;
    }
    await convertChargeToPersonalRepayment(ctx, txn, payerPersonId);
    result.created++;
  }

  if (!page.isDone) {
    await ctx.scheduler.runAfter(
      0,
      internal.migrations.continueBackfillPersonalRepayments,
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
 *  the rest (same shape as 0040-0044, safe for the same idempotence reason). */
export async function runBackfillPersonalRepayments(ctx: MutationCtx) {
  return await runBackfillPersonalRepaymentsPage(ctx, null);
}

export const backfillPersonalRepayments: Migration = {
  name: "0045_backfill_personal_repayments",
  run: runBackfillPersonalRepayments,
};
