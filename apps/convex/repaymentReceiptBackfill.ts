/**
 * ON-DEMAND recovery sweep: re-send the "you paid this off" payment-receipt
 * email for every repayment whose receipt was CLAIMED but never CONFIRMED
 * delivered — including the row that used to leave no trace at all.
 *
 * WHY IT EXISTS. `cards.ts#claimRepaymentReceipts` stamps `receiptSentAt`
 * BEFORE the send is attempted (prevents double-sends if the process dies
 * mid-send — see that file's "AT MOST ONE RECEIPT PER REPAYMENT, EVER"
 * doc). That is the right call, but it means a claimed row whose delivery
 * then fails — no email on file for the payer, Resend rejected the send, a
 * transport throw, `RESEND_API_KEY` unset in production — used to look
 * IDENTICAL to a delivered one: `receiptSentAt` was the only field, and it
 * was set either way. `cards.ts#markRepaymentReceiptOutcome` now records the
 * real outcome (`receiptDeliveredAt` on success, `receiptDeliveryFailedAt` +
 * `lastReceiptError` on failure) on every send this codebase makes — this
 * file is what actually DOES something with that record: a maintainer-
 * dispatched sweep that finds every row still missing a confirmed delivery
 * and tries again.
 *
 * This is a PAYMENT RECEIPT, not an FYI (contrast
 * `reimbursementApprovedNoticeBackfill.ts`, which this file otherwise
 * mirrors closely) — it is evidence a payer may need to prove they settled
 * a debt, so losing one silently is a materially worse outcome than losing
 * an approval notice. That is why this sweep exists when the precedent it
 * copies shipped without an ongoing equivalent (the approved-notice
 * backfill is explicitly ONE-SHOT; this one is meant to be re-run whenever
 * the delivery-failure count looks worth chasing).
 *
 * ────────────────────────────────────────────────────────────────────────────
 * HOW IT IS RUN — deliberately, by a maintainer, never by a deploy. Same
 * dispatch shape as `reimbursementApprovedNoticeBackfill.ts` — read that
 * file's header for the full reasoning; the short version:
 *
 *   gh workflow run run-convex-function.yml \
 *     -f function=repaymentReceiptBackfill:backfillRepaymentReceipts \
 *     -f args='{}'                      # DRY RUN — sends nothing, claims nothing
 *
 *   gh workflow run run-convex-function.yml \
 *     -f function=repaymentReceiptBackfill:backfillRepaymentReceipts \
 *     -f args='{"execute":true}'        # the real re-send
 *
 * Not a cron, not scheduled, not called from any deploy-time path — a mass
 * re-mailing must never be something a merge triggers. ON ACCESS: this is an
 * `internalAction` reached only with the deployment's admin key (the
 * workflow's maintainer-only dispatch + production-environment approval IS
 * the gate — see the sibling backfill's header for why a seat-capability
 * resolver has no caller to gate here).
 *
 * IDEMPOTENT. Every retry is CLAIMED first by
 * `cards.ts#claimRepaymentReceiptForRetry`, which re-stamps `receiptSentAt`
 * inside the SAME transaction that checks eligibility — so two overlapping
 * runs (or this sweep racing the live send path) can claim a given row at
 * most once per staleness window. A row already `receiptDeliveredAt`-stamped
 * is never eligible in the first place (`listReceiptDeliveryBacklog`
 * excludes it), and a successful retry clears the failure fields
 * (`markRepaymentReceiptOutcome`), so a second run of this sweep finds
 * nothing left to do for it.
 *
 * BOUNDED, same shape as the sibling backfill: `personalRepayments` has no
 * index for "claimed but not confirmed delivered" (a rare, transient state
 * by design — most rows resolve to delivered within seconds), so this pages
 * the table with `.paginate()` at `PAGE_SIZE` rows per invocation and
 * filters in JS. Self-reschedules with the continue cursor until the table
 * is drained; a running `progress` tally rides along so the final log line
 * reports the whole run.
 *
 * NOT THE STALE-BUT-STILL-IN-FLIGHT WINDOW. A row with its IN-FLIGHT LOCK
 * (`receiptSendingAt`) still fresh is probably just a send genuinely in
 * progress right now — automatic, another run of this sweep, or (an
 * adversarial review proved, 2026-08-14) a MANUAL send — and re-claiming it
 * would risk a duplicate delivery. `RECEIPT_RETRY_STALE_MS` (`cards.ts`) is
 * the same threshold this sweep's eligibility scan, the retry-claim itself,
 * AND the manual claim's own in-flight refusal all check, so no two of the
 * three claimers can ever disagree about what's "stuck" long enough to
 * retry.
 *
 * DELIBERATELY NOT KEYED ON "HOW LONG SINCE THE LAST ATTEMPT". An earlier
 * version of this eligibility check read `receiptSentAt`'s age instead of
 * `receiptSendingAt`'s — which meant a manager's FAILED manual retry
 * (`cards.ts#claimRepaymentReceiptManual`, which re-stamps `receiptSentAt` on
 * every attempt, live or not) silently evicted the row from this backlog for
 * another full `RECEIPT_RETRY_STALE_MS`, every single time it was retried.
 * A manager repeatedly retrying during a real outage could keep a
 * never-delivered row permanently just out of this sweep's reach. Keying on
 * `receiptSendingAt` instead fixes that: `markRepaymentReceiptOutcome`
 * clears it the instant an attempt's outcome (delivered OR failed) is
 * recorded, so a row a manual retry just failed on is reachable again
 * immediately, not 15 more minutes later.
 *
 * ONE RECEIPT LINE PER RETRY, not the original bundle. The live path groups
 * every repayment ONE payment settled into a single email
 * (`cards.ts`'s "THE SEAM" doc) — but that grouping only exists transiently
 * as the scheduler args of the original `sendRepaymentReceiptEmail` call
 * and is never persisted on the rows themselves, so this sweep has no way
 * to reconstruct which stale rows were originally bundled together. Each
 * retried row is therefore claimed and mailed on its OWN, one complete
 * receipt per repayment (`buildRepaymentReceipt` already renders a full,
 * standalone receipt for any single charge — see that file's header). A
 * payer whose bundled payment partially failed may therefore receive
 * several single-charge receipts instead of the one bundled email they'd
 * have gotten on a clean first attempt — strictly better than the silent
 * loss this replaces, and the same tradeoff for `feeCoveredCents`: that
 * figure also isn't persisted per row, so a retried receipt never repeats
 * the original "you also covered the processing fee" note even if one was
 * genuinely due. Both are documented gaps, not bugs — the alternative is no
 * receipt at all.
 */
import { v } from "convex/values";
import { internalAction, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { RECEIPT_RETRY_STALE_MS, sendOneRepaymentReceiptGroup } from "./cards";

/** Rows read per invocation. Small enough that a page's worth of retries is
 *  a bounded unit of work and a failure loses at most this many retries. */
const PAGE_SIZE = 50;

/** `listReceiptDeliveryBacklog`'s shape. Written out (rather than inferred
 *  at the `ctx.runQuery` call site) for the same reason
 *  `reimbursementApprovedNoticeBackfill.ts`'s `BacklogPage` is — it breaks
 *  the `internal.*` type cycle this module would otherwise sit in. A
 *  backlog row is JUST the id: whether the prior attempt recorded an
 *  explicit failure or never recorded any outcome at all (the pre-fix
 *  silent case) is treated identically here — both mean "not confirmed
 *  delivered", and `claimRepaymentReceiptForRetry` re-derives eligibility
 *  from the row itself anyway. */
interface BacklogPage {
  due: Id<"personalRepayments">[];
  scanned: number;
  isDone: boolean;
  continueCursor: string | null;
}

/** The running tally carried across self-reschedules. */
interface Progress {
  scanned: number;
  eligible: number;
  claimed: number;
  delivered: number;
  stillFailed: number;
}

const progressValidator = v.object({
  /** Repayment rows read. */
  scanned: v.number(),
  /** Rows claimed-but-not-confirmed-delivered and past the in-flight grace
   *  window — what a dry run is really reporting. */
  eligible: v.number(),
  /** Eligible rows this run actually claimed for retry (a live send or an
   *  overlapping run can beat this sweep to a row, which is fine). */
  claimed: v.number(),
  /** Claimed rows this run confirmed delivered. */
  delivered: v.number(),
  /** Claimed rows that failed AGAIN this run — still recorded, still
   *  visible to the next dispatch of this same sweep. */
  stillFailed: v.number(),
});

/**
 * One page of repayments claimed for a receipt but not yet confirmed
 * delivered, filtered to rows old enough that the original attempt has
 * almost certainly finished one way or the other.
 */
export const listReceiptDeliveryBacklog = internalQuery({
  args: {
    cursor: v.union(v.string(), v.null()),
    numItems: v.number(),
  },
  handler: async (ctx, { cursor, numItems }): Promise<BacklogPage> => {
    const page = await ctx.db
      .query("personalRepayments")
      .paginate({ numItems, cursor });

    const now = Date.now();
    const due: Id<"personalRepayments">[] = [];
    for (const r of page.page) {
      // Never even claimed — not this sweep's concern (the row hasn't
      // reached a settled payment yet, or never will).
      if (r.receiptSentAt === undefined) continue;
      // Already confirmed delivered — done, nothing to retry.
      if (r.receiptDeliveredAt !== undefined) continue;
      // A send is genuinely in flight for this row right now (fresh
      // `receiptSendingAt`) — see this file's header on why this is keyed on
      // the in-flight lock rather than on how long ago the last attempt was.
      if (
        r.receiptSendingAt !== undefined &&
        now - r.receiptSendingAt < RECEIPT_RETRY_STALE_MS
      ) {
        continue;
      }
      due.push(r._id);
    }

    return {
      due,
      scanned: page.page.length,
      isDone: page.isDone,
      continueCursor: page.isDone ? null : page.continueCursor,
    };
  },
});

/**
 * Sweep the table and retry every stale, unconfirmed receipt. DRY RUN BY
 * DEFAULT: with `execute` omitted or false it claims nothing, sends
 * nothing, and returns exactly the counts a real run would produce
 * (`eligible` is the backlog).
 *
 * Both modes drain the whole table via self-reschedule. The value returned
 * to `npx convex run` is the FIRST page plus its tally; the run's total is
 * the `[repayment-receipt-backfill]` log line where `isDone` is true.
 */
export const backfillRepaymentReceipts = internalAction({
  args: {
    execute: v.optional(v.boolean()),
    cursor: v.optional(v.union(v.string(), v.null())),
    progress: v.optional(progressValidator),
  },
  handler: async (
    ctx,
    args,
  ): Promise<Progress & { isDone: boolean; continueCursor: string | null }> => {
    const execute = args.execute ?? false;
    const page: BacklogPage = await ctx.runQuery(
      internal.repaymentReceiptBackfill.listReceiptDeliveryBacklog,
      { cursor: args.cursor ?? null, numItems: PAGE_SIZE },
    );

    const total: Progress = {
      scanned: (args.progress?.scanned ?? 0) + page.scanned,
      eligible: (args.progress?.eligible ?? 0) + page.due.length,
      claimed: args.progress?.claimed ?? 0,
      delivered: args.progress?.delivered ?? 0,
      stillFailed: args.progress?.stillFailed ?? 0,
    };

    if (execute) {
      for (const repaymentId of page.due) {
        // CLAIM FIRST — see this file's header. `null` means the live path
        // (or an overlapping run of this sweep) already resolved this row,
        // or it's still inside the in-flight grace window: either way,
        // must not attempt a second send.
        const claim = await ctx.runMutation(
          internal.cards.claimRepaymentReceiptForRetry,
          { repaymentId },
        );
        if (!claim) continue;
        total.claimed += 1;

        // Never re-attribute a fee note on retry — see this file's header
        // on why that figure isn't recoverable per row.
        const outcome = await sendOneRepaymentReceiptGroup(
          ctx,
          [claim.repaymentId],
          0,
        );
        if (outcome === "delivered") total.delivered += 1;
        else total.stillFailed += 1;
      }
    }

    console.log(
      `[repayment-receipt-backfill] ${execute ? "EXECUTE" : "DRY RUN"} ` +
        `scanned=${total.scanned} eligible=${total.eligible} claimed=${total.claimed} ` +
        `delivered=${total.delivered} stillFailed=${total.stillFailed} done=${page.isDone}`,
    );

    if (!page.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.repaymentReceiptBackfill.backfillRepaymentReceipts,
        { execute, cursor: page.continueCursor, progress: total },
      );
    }

    return { ...total, isDone: page.isDone, continueCursor: page.continueCursor };
  },
});
