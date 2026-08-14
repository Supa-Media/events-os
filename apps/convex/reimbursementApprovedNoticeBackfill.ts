/**
 * ONE-SHOT catch-up: email every claimant whose reimbursement was already
 * approved BEFORE the approval notice existed, saying so plainly.
 *
 * WHY IT EXISTS. Until 2026-08-14, `reimbursements.approve` told the claimant
 * nothing: submitting emailed the approvers, a send-back emailed the claimant,
 * the staleness cron emailed the claimant — and the one message people actually
 * wanted, "your money was approved", was sent through no channel at all.
 * Founder: "we should even backfill to everybody that has had an approved
 * thing, and if it was a while ago, just say 'hey, just so you know, we forgot
 * to send the email, but this was approved, you should have seen it by this
 * date. If not, contact your treasurer.'" That is exactly the copy the
 * `catch_up` notice in `lib/reimbursementApprovedEmail.ts` writes.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * HOW IT IS RUN — deliberately, by a maintainer, never by a deploy.
 *
 * Nothing here is on the public API, nothing is wired to a cron, and there is
 * no UI. It is dispatched through the `run-convex-function.yml` workflow (the
 * `financeGenesisBackfill` / `reimbursementBackfill` precedent), which is
 * `workflow_dispatch`-only behind the `production` environment gate:
 *
 *   gh workflow run run-convex-function.yml \
 *     -f function=reimbursementApprovedNoticeBackfill:backfillApprovedNotices \
 *     -f args='{}'                      # DRY RUN — sends nothing, writes nothing
 *
 *   gh workflow run run-convex-function.yml \
 *     -f function=reimbursementApprovedNoticeBackfill:backfillApprovedNotices \
 *     -f args='{"execute":true}'        # the real mailing
 *
 * A mass mailing must never be something a merge can trigger, so it is not
 * scheduled, not a cron, and not called from any deploy-time path. On ACCESS:
 * this is an `internalAction` reached only with the deployment's admin key, so
 * there is no `ctx.auth` identity to resolve and no seat capability to check —
 * a `require…` resolver (CLAUDE.md, "Gate It Behind a Power") would have no
 * caller to gate. The gate that actually exists is the one the sibling
 * backfills rely on: the deploy key plus the workflow's maintainer-only
 * dispatch and production-environment approval. Should this ever grow an
 * in-app trigger, THAT call site is where a named resolver belongs, and the
 * capability it should carry is a finance-manager-level power over claimant
 * correspondence — see `lib/finance.ts`'s ladder.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * IDEMPOTENT, and here is precisely why. Every send is CLAIMED first by
 * `reimbursements.markApprovedNoticeSent`, a mutation that stamps
 * `approvedNoticeSentAt` and returns `true` only if the field was previously
 * unset. Because that read-and-write happens inside one Convex transaction, the
 * claim returns `true` at most once in a row's lifetime — no matter how many
 * times this sweep is run, how many pages overlap, or whether the live
 * `approve` path fires for the same row in the same minute. This sweep sends
 * ONLY on a `true`, so:
 *   - a second `execute` run claims nothing and therefore sends nothing;
 *   - a run that dies mid-table and is restarted from the beginning re-scans
 *     rows it already mailed and skips every one of them;
 *   - a row approved between two runs is picked up by the LIVE path, claimed
 *     there, and skipped here.
 * The stamp lands BEFORE the send (the ordering `markPurchaseFollowUpSent`
 * documents): a crash in between costs one email, which is recoverable by a
 * human; the other ordering risks telling somebody twice that their money was
 * approved, which is not.
 *
 * BOUNDED. `reimbursementRequests` has no index for "approved and never
 * noticed" (`approvedNoticeSentAt` is sparse by design), so the sweep pages the
 * table with `.paginate()` at `PAGE_SIZE` rows per invocation and filters in
 * JS — the same shape `reimbursementBackfill.ts` uses on the same table. Each
 * invocation therefore reads a fixed, small number of documents and sends at
 * most `PAGE_SIZE` emails, well inside a Convex transaction's limits, and
 * self-reschedules with the continue cursor until the table is drained. A
 * running `progress` tally rides along the reschedules so the final log line
 * reports the whole run rather than just its last page.
 *
 * ALREADY-PAID CLAIMS ARE INCLUDED, on purpose. It would be easy to argue a
 * settled claim is "done" and needs no notice, but that gets the founder's ask
 * backwards: the "you should have seen it by this date — if not, contact your
 * treasurer" line only has teeth for money that was supposed to arrive a while
 * ago, and a claimant who never actually received a settled payout is exactly
 * the person this sweep should reach. So a `paid` row is mailed too, with copy
 * that names the payment date and asks them to speak up if nothing landed —
 * it never tells a settled claimant their money is "coming". A row that was
 * approved and then bounced back from `paid` (`reverseSettledPayout`) is
 * likewise mailed once, as `approved`.
 */
import { v } from "convex/values";
import { internalAction, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  approvedNoticeRowFor,
  claimantStatusLink,
} from "./reimbursements";
import { buildApprovedNotice } from "./lib/reimbursementApprovedEmail";
import { sendEmailReporting } from "./ticketingEmails";

/** Rows read per invocation. Small enough that a page's worth of sends is a
 *  bounded unit of work and a failure loses at most this many notices. */
const PAGE_SIZE = 50;

/** One backlog row — the projection `approvedNoticeRowFor` produces. */
type BacklogRow = NonNullable<ReturnType<typeof approvedNoticeRowFor>>;

/** `listApprovedNoticeBacklog`'s shape. Written out (rather than inferred at
 *  the `ctx.runQuery` call site) to break the `internal.*` type cycle this
 *  module would otherwise sit in — the guidelines' documented remedy for a
 *  function that references its own module through `internal`. */
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
  /** Rows approved and not yet noticed — what a dry run is really reporting. */
  eligible: v.number(),
  /** Eligible rows this run claimed (i.e. would send / did send). */
  claimed: v.number(),
  /** Claimed rows with no address on the request — nothing could be sent. */
  noEmail: v.number(),
  /** Claimed + addressed rows Resend actually accepted. */
  delivered: v.number(),
});

/**
 * One page of requests that are approved and have never had their notice.
 * Reads the chapter once per distinct chapter in the page (slug feeds the
 * accountless CTA link), not once per row.
 */
export const listApprovedNoticeBacklog = internalQuery({
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
      if (req.approvedNoticeSentAt !== undefined) continue;
      const key = String(req.chapterId);
      if (!slugs.has(key)) {
        const chapter = await ctx.db.get(req.chapterId);
        slugs.set(key, chapter?.slug ?? null);
      }
      // `null` for a request that was never approved — nothing to say.
      const row = approvedNoticeRowFor(req, slugs.get(key) ?? null);
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
 * total is the `[approved-notice-backfill]` log line where `isDone` is true.
 */
export const backfillApprovedNotices = internalAction({
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
      internal.reimbursementApprovedNoticeBackfill.listApprovedNoticeBacklog,
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
        // CLAIM FIRST — see this file's header. A `false` here means the live
        // `approve` path (or an overlapping run) already owns this row's one
        // notice, so we must not write a second one.
        const claimed: boolean = await ctx.runMutation(
          internal.reimbursements.markApprovedNoticeSent,
          { reimbursementId: row.reimbursementId as Id<"reimbursementRequests"> },
        );
        if (!claimed) continue;
        total.claimed += 1;
        if (!row.payeeEmail) {
          // Claimed anyway (the header explains why): a legacy row with no
          // address can never be mailed, and leaving it unclaimed would make
          // every future run re-examine it forever.
          total.noEmail += 1;
          continue;
        }

        const notice = buildApprovedNotice({
          kind: "catch_up",
          payeeName: row.payeeName,
          reference: row.reference,
          approvedCents: row.approvedCents,
          totalCents: row.totalCents,
          approvedAt: row.approvedAt,
          status: row.status,
          paidAt: row.paidAt,
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
          // Isolate each recipient: a transport-level throw on one address
          // must not abandon the rest of the page (the same per-recipient
          // guard `sendReimbursementSubmittedEmail` uses). The row stays
          // claimed — one lost notice, never a duplicated one.
          console.error(
            "[approved-notice-backfill] send failed",
            row.reference,
            err,
          );
        }
      }
    }

    console.log(
      `[approved-notice-backfill] ${execute ? "EXECUTE" : "DRY RUN"} scanned=${total.scanned} eligible=${total.eligible} claimed=${total.claimed} noEmail=${total.noEmail} delivered=${total.delivered} done=${page.isDone}`,
    );

    if (!page.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.reimbursementApprovedNoticeBackfill.backfillApprovedNotices,
        { execute, cursor: page.continueCursor, progress: total },
      );
    }

    return { ...total, isDone: page.isDone, continueCursor: page.continueCursor };
  },
});
