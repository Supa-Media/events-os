/**
 * ONE-SHOT catch-up: email every claimant whose reimbursement was already PAID
 * before the paid notice existed, saying so plainly.
 *
 * WHY IT EXISTS. #727 shipped the approval half of the founder's ask and its
 * own catch-up sweep. This is the other half: "let's also send emails when we
 * actually pay people — this is really important to them. Email when approved
 * and email when paid" (2026-08-14). Until now, a claimant's last word from us
 * was that their request had been approved; the money arriving — or not
 * arriving — was something they had to notice on their own bank statement.
 * These people were paid and never told, which is exactly the register the
 * `catch_up` notice in `lib/reimbursementPaidEmail.ts` writes in.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * HOW IT IS RUN — deliberately, by a maintainer, never by a deploy.
 *
 *   gh workflow run run-convex-function.yml \
 *     -f function=reimbursementPaidNoticeBackfill:backfillPaidNotices \
 *     -f args='{}'                      # DRY RUN — sends nothing, writes nothing
 *
 *   gh workflow run run-convex-function.yml \
 *     -f function=reimbursementPaidNoticeBackfill:backfillPaidNotices \
 *     -f args='{"execute":true}'        # the real mailing
 *
 * Every word of `reimbursementApprovedNoticeBackfill.ts`'s "HOW IT IS RUN"
 * block applies here unchanged and is not restated: nothing on the public API,
 * no cron, no UI, no deploy-time caller, because a mass mailing must never be
 * something a merge can trigger — and the same reasoning for why an
 * `internalAction` reached only with the deployment's admin key has no
 * `ctx.auth` caller to resolve and therefore no seat capability to check
 * (CLAUDE.md, "Gate It Behind a Power"). Read it there; it is the sibling of
 * this file and they must not drift.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * IDEMPOTENT AND BOUNDED, by the same two mechanisms, also documented there:
 * every send is CLAIMED first by `reimbursements.markPaidNoticeSent` (one
 * transaction, `true` at most once per row per payment) and this sweep sends
 * only on a `true`; and it pages `reimbursementRequests` with `.paginate()` at
 * `PAGE_SIZE` rows per invocation, filtering in JS because `paidNoticeSentAt`
 * is sparse by design and there is no index for "paid and never noticed",
 * self-rescheduling with the continue cursor until the table is drained.
 *
 * WHAT IT SWEEPS FOR, and what it deliberately leaves alone:
 *  - `status:"paid"` with a `paidAt` and no `paidNoticeSentAt`. Nothing else.
 *    `paidNoticeRowFor` is the gate, so this sweep and the live path agree on
 *    what "paid" means down to the field.
 *  - An `approved`-but-unpaid row is NOT in scope. It has already had (or will
 *    have) the approval notice, and telling somebody about a payment that
 *    hasn't happened is the exact failure the approval notice's copy rules
 *    exist to prevent. This is the mirror of that sweep's decision to include
 *    already-paid rows: each catch-up mails the rows its own notice is TRUE
 *    for, and the two together cover the table.
 *  - A row whose payout bounced (`reverseSettledPayout` walked it back to
 *    `approved` and cleared the stamp) is likewise out of scope until a retry
 *    settles it — at which point the LIVE path claims it and this sweep never
 *    sees it.
 */
import { v } from "convex/values";
import { internalAction, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import {
  claimantStatusLink,
  paidNoticeRowFor,
  settlingPayoutFor,
} from "./reimbursements";
import { buildPaidNotice } from "./lib/reimbursementPaidEmail";
import { sendEmailReporting } from "./ticketingEmails";

/** Rows read per invocation. Small enough that a page's worth of sends is a
 *  bounded unit of work and a failure loses at most this many notices. */
const PAGE_SIZE = 50;

/** One backlog row — the projection `paidNoticeRowFor` produces. */
type BacklogRow = NonNullable<ReturnType<typeof paidNoticeRowFor>>;

/** `listPaidNoticeBacklog`'s shape. Written out (rather than inferred at the
 *  `ctx.runQuery` call site) to break the `internal.*` type cycle this module
 *  would otherwise sit in — the guidelines' documented remedy for a function
 *  that references its own module through `internal`. */
interface BacklogPage {
  due: BacklogRow[];
  scanned: number;
  isDone: boolean;
  continueCursor: string | null;
}

/** The running tally carried across self-reschedules (see `progressValidator`). */
interface Progress {
  scanned: number;
  eligible: number;
  claimed: number;
  noEmail: number;
  delivered: number;
}

/** The running tally carried across self-reschedules. */
const progressValidator = v.object({
  /** Request rows read. */
  scanned: v.number(),
  /** Rows paid and not yet noticed — what a dry run is really reporting. */
  eligible: v.number(),
  /** Eligible rows this run claimed (i.e. would send / did send). */
  claimed: v.number(),
  /** Claimed rows with no address on the request — nothing could be sent. */
  noEmail: v.number(),
  /** Claimed + addressed rows Resend actually accepted. */
  delivered: v.number(),
});

/**
 * One page of requests that are paid and have never had their notice.
 * Reads the chapter once per distinct chapter in the page (slug feeds the
 * accountless CTA link), not once per row; reads the settling payout only for
 * the rows that are actually due, so a page of already-noticed rows costs
 * nothing extra.
 */
export const listPaidNoticeBacklog = internalQuery({
  args: {
    cursor: v.union(v.string(), v.null()),
    numItems: v.number(),
  },
  handler: async (ctx, { cursor, numItems }): Promise<BacklogPage> => {
    const page = await ctx.db
      .query("reimbursementRequests")
      .paginate({ numItems, cursor });

    const slugs = new Map<string, string | null>();
    const due: BacklogRow[] = [];
    for (const req of page.page) {
      // Already claimed by the live path or an earlier run of this sweep.
      if (req.paidNoticeSentAt !== undefined) continue;
      // Cheap gate before the payout read — `paidNoticeRowFor` applies the same
      // test, but doing it here keeps the extra document read off every
      // unapproved/unpaid row in the table.
      if (req.status !== "paid" || req.paidAt === undefined) continue;
      const key = String(req.chapterId);
      if (!slugs.has(key)) {
        const chapter = await ctx.db.get(req.chapterId);
        slugs.set(key, chapter?.slug ?? null);
      }
      const payout = await settlingPayoutFor(ctx, req);
      const row = paidNoticeRowFor(req, slugs.get(key) ?? null, payout);
      if (row) due.push(row);
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
 * Sweep the table and send the catch-up notice. DRY RUN BY DEFAULT: with
 * `execute` omitted or false it claims nothing, sends nothing, and returns
 * exactly the counts a real run would produce (`eligible` is the backlog).
 *
 * Both modes drain the whole table via self-reschedule, so a dry run's final
 * log line is a true backlog count rather than one page of it. The value
 * returned to `npx convex run` is the FIRST page plus its tally; the run's
 * total is the `[paid-notice-backfill]` log line where `isDone` is true.
 */
export const backfillPaidNotices = internalAction({
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
      internal.reimbursementPaidNoticeBackfill.listPaidNoticeBacklog,
      { cursor: args.cursor ?? null, numItems: PAGE_SIZE },
    );

    const total: Progress = {
      scanned: (args.progress?.scanned ?? 0) + page.scanned,
      eligible: (args.progress?.eligible ?? 0) + page.due.length,
      claimed: args.progress?.claimed ?? 0,
      noEmail: args.progress?.noEmail ?? 0,
      delivered: args.progress?.delivered ?? 0,
    };

    if (execute) {
      for (const row of page.due) {
        // CLAIM FIRST — see this file's header and, for the full argument,
        // `reimbursements.markApprovedNoticeSent`'s. A `false` here means the
        // live settle path (or an overlapping run) already owns this row's
        // notice, so we must not write a second one.
        const claimed: boolean = await ctx.runMutation(
          internal.reimbursements.markPaidNoticeSent,
          { reimbursementId: row.reimbursementId },
        );
        if (!claimed) continue;
        total.claimed += 1;
        if (!row.payeeEmail) {
          // Claimed anyway: a legacy row with no address can never be mailed,
          // and leaving it unclaimed would make every future run re-examine it
          // forever.
          total.noEmail += 1;
          continue;
        }

        const notice = buildPaidNotice({
          kind: "catch_up",
          payeeName: row.payeeName,
          reference: row.reference,
          paidCents: row.paidCents,
          totalCents: row.totalCents,
          paidAt: row.paidAt,
          method: row.method,
          bankAccountLast4: row.bankAccountLast4,
          link: claimantStatusLink(row),
        });
        try {
          const ok = await sendEmailReporting(ctx, {
            to: row.payeeEmail,
            subject: notice.subject,
            html: notice.html,
          });
          if (ok) total.delivered += 1;
        } catch (err) {
          // Isolate each recipient: a transport-level throw on one address must
          // not abandon the rest of the page. The row stays claimed — one lost
          // notice, never a duplicated one.
          console.error("[paid-notice-backfill] send failed", row.reference, err);
        }
      }
    }

    console.log(
      `[paid-notice-backfill] ${execute ? "EXECUTE" : "DRY RUN"} scanned=${total.scanned} eligible=${total.eligible} claimed=${total.claimed} noEmail=${total.noEmail} delivered=${total.delivered} done=${page.isDone}`,
    );

    if (!page.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.reimbursementPaidNoticeBackfill.backfillPaidNotices,
        { execute, cursor: page.continueCursor, progress: total },
      );
    }

    return { ...total, isDone: page.isDone, continueCursor: page.continueCursor };
  },
});
