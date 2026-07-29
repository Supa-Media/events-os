import type { MutationCtx } from "../_generated/server";
import type { Migration } from "./index";
import { internal } from "../_generated/api";

/**
 * Kick off the FIRST full-ledger Increase transaction backfill (2026-07-29):
 * `increaseLedger.backfillIncreaseTransactions` now ingests ALL account
 * activity — inbound/outbound ACH, wires, fees, interest — where the previous
 * card-only ingestion silently skipped everything but `card_settlement`/
 * `card_refund`. Any non-card entry that already settled (e.g. the Jul 17
 * Relay → Increase transfer a bookkeeper couldn't mark as a transfer because
 * its Increase leg never appeared in Reconcile) exists only at Increase, so
 * the history has to be pulled once; after that the webhook keeps the ledger
 * live and the daily 08:00 UTC cron backstops drops.
 *
 * The migration itself only SCHEDULES the backfill action (a `MutationCtx`
 * can't `fetch`; the action degrades per account when its environment's key
 * is unset, exactly like the cron run). Ledgered so it fires once per
 * deployment — and independently harmless if re-run by hand, since the
 * backfill dedups on `by_external_id`.
 */
export const backfillIncreaseAccountActivity: Migration = {
  name: "0057_backfill_increase_transactions",
  run: async (ctx: MutationCtx) => {
    await ctx.scheduler.runAfter(
      0,
      internal.increaseLedger.backfillIncreaseTransactions,
      {},
    );
    return { scheduled: true };
  },
};
