/**
 * ONE-SHOT catch-up: thank every backer who signed up BEFORE the welcome email
 * existed, and tell them their page is there.
 *
 * WHY IT EXISTS. Until 2026-08-14, becoming a backer produced exactly one piece
 * of mail — the ordinary monthly receipt, the same one that lands on cycle 24.
 * Everybody backing before that date was never actually thanked for the
 * decision, and none of them knows `/backer` exists. Owner: "can you backfill
 * the emails to backers already signed up."
 *
 * ── IT IS NOT THE WELCOME EMAIL, AND THAT IS THE POINT ─────────────────────
 * The live welcome says "you just became a backer", "starting today", "your
 * first month has been received". Sent to somebody who has given every month
 * for a year, all three are false, and an email that gets the recipient's own
 * history wrong is worse than the silence it was meant to fix. So this sweep
 * sends the `catch_up` variant (`lib/backerWelcomeEmail.ts`), which says out
 * loud that we are late — the same register, and the same discriminated-kind
 * shape, as `reimbursementApprovedNoticeBackfill.ts`'s notice.
 *
 * ── AND IT NEVER TELLS THE DESK ────────────────────────────────────────────
 * The live path fans a signup out to the giving notification rules
 * (`givingNotifications.notifyBackerSignup`). This sweep deliberately does not.
 * Two hundred "New backer!" emails about people who signed up in 2024 is not a
 * notification, it is an incident — the same reasoning `recordGiftForDonor`'s
 * `notify: false` exists for.
 *
 * ── HOW IT IS RUN — deliberately, by a maintainer, never by a deploy ───────
 * Nothing here is on the public API, nothing is wired to a cron, and there is
 * no UI. It is dispatched through `run-convex-function.yml`, which is
 * `workflow_dispatch`-only behind the `production` environment gate:
 *
 *   gh workflow run run-convex-function.yml \
 *     -f function=backerCatchUpBackfill:backfillBackerCatchUp \
 *     -f args='{}'                   # DRY RUN — sends nothing, writes nothing
 *
 *   gh workflow run run-convex-function.yml \
 *     -f function=backerCatchUpBackfill:backfillBackerCatchUp \
 *     -f args='{"execute":true}'     # the real mailing
 *
 * A mass mailing to donors must never be something a merge can trigger, so it
 * is not scheduled and is not called from any deploy-time path. On ACCESS: an
 * `internalAction` reached only with the deployment's admin key has no
 * `ctx.auth` identity to resolve, so there is no seat capability to check and a
 * `require…` resolver (CLAUDE.md) would have no caller to gate. The gate that
 * exists is the deploy key plus the workflow's maintainer-only dispatch. If
 * this ever grows an in-app trigger, THAT call site is where a named resolver
 * belongs, and the power it should carry is `giving.portal.edit`
 * (`lib/backerAccess.ts#requirePortalAdmin`).
 *
 * IDEMPOTENT. Every send is CLAIMED first by `markBackerCatchUpSent`, which
 * stamps `pledges.catchUpSentAt` and returns `true` only if the field was
 * previously unset. Read-and-write in one transaction means the claim returns
 * `true` at most once in a row's lifetime, so a second run mails nobody, a run
 * that dies mid-table and restarts skips everyone it already reached, and two
 * overlapping runs cannot both take the same row. The stamp lands BEFORE the
 * send, deliberately: a crash between them costs one email, which a human can
 * fix, where the other ordering risks thanking somebody twice.
 *
 * BOUNDED. `pledges` has no index for "never caught up" (`catchUpSentAt` is
 * sparse by design), so the sweep pages the table with `.paginate()` and
 * filters in JS — the shape `reimbursementApprovedNoticeBackfill` uses on its
 * own table — self-rescheduling with the continue cursor until it drains.
 */
import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { BACKER_UNIT_CENTS } from "@events-os/shared";
import { renderBackerWelcomeEmail } from "./lib/backerWelcomeEmail";
import { sendEmailReporting } from "./ticketingEmails";
import { backerPortalUrl, givePageUrl } from "./lib/siteUrl";
import { territoryForChapter } from "./territories";
import type { Id } from "./_generated/dataModel";

/** Rows read per invocation. Small enough that a page's worth of sends is a
 *  bounded unit of work and a failure loses at most this many emails. */
const PAGE_SIZE = 50;

/** One backer owed a catch-up, with everything the email needs. */
type CatchUpRow = {
  pledgeId: Id<"pledges">;
  email: string;
  name: string;
  monthlyCents: number;
  backingSince: number;
  chapterName: string | null;
  territorySlug: string | null;
  isBacker: boolean;
};

interface BacklogPage {
  due: CatchUpRow[];
  scanned: number;
  isDone: boolean;
  continueCursor: string | null;
}

interface Progress {
  scanned: number;
  eligible: number;
  claimed: number;
  delivered: number;
}

/** The running tally carried across self-reschedules. */
const progressValidator = v.object({
  /** Pledge rows read. */
  scanned: v.number(),
  /** Rows owed a catch-up — what a dry run is really reporting. */
  eligible: v.number(),
  /** Eligible rows this run claimed (i.e. did send). */
  claimed: v.number(),
  /** Claimed rows Resend actually accepted. */
  delivered: v.number(),
});

/**
 * Claim one pledge's catch-up. Returns `true` to exactly one caller, ever.
 *
 * Refuses a pledge that already has `announcedAt` — that person got the live
 * welcome when they signed up and must not be thanked a second time as though
 * we'd forgotten them.
 */
export const markBackerCatchUpSent = internalMutation({
  args: { pledgeId: v.id("pledges") },
  returns: v.boolean(),
  handler: async (ctx, { pledgeId }) => {
    const pledge = await ctx.db.get(pledgeId);
    if (!pledge) return false;
    if (pledge.announcedAt !== undefined) return false;
    if (pledge.catchUpSentAt !== undefined) return false;
    await ctx.db.patch(pledgeId, { catchUpSentAt: Date.now() });
    return true;
  },
});

/**
 * One page of pledges owed a catch-up.
 *
 * WHO IS ELIGIBLE, and the two exclusions worth arguing about:
 *
 *  · `active` and `past_due` ONLY. A `canceled` pledge gets nothing: "thank you
 *    for backing this work" landing on somebody who stopped six months ago
 *    reads as a system that hasn't noticed they left, which is the opposite of
 *    the point. An `incomplete` one never became anything. A `paused` pledge is
 *    a deliberate hold and is left alone for the same reason as `canceled`.
 *    (`past_due` IS included: their card failed, they haven't gone anywhere,
 *    and they are exactly the person worth thanking.)
 *  · NO `announcedAt`. That field means the live welcome already went out.
 *
 * IMPORTED pledges are included on purpose — somebody whose monthly gift still
 * bills on the old platform has been giving just as long, and the portal has
 * honest copy for a pledge it can't manage. They are thanked; nothing is
 * promised.
 *
 * Chapters and territories are read once per distinct chapter in the page, not
 * once per row.
 */
export const listCatchUpBacklog = internalQuery({
  args: { cursor: v.union(v.string(), v.null()), numItems: v.number() },
  handler: async (ctx, { cursor, numItems }): Promise<BacklogPage> => {
    const page = await ctx.db.query("pledges").paginate({ numItems, cursor });

    const chapters = new Map<
      string,
      { name: string | null; slug: string | null }
    >();
    const due: CatchUpRow[] = [];

    for (const pledge of page.page) {
      if (pledge.status !== "active" && pledge.status !== "past_due") continue;
      if (pledge.announcedAt !== undefined) continue;
      if (pledge.catchUpSentAt !== undefined) continue;

      const donor = await ctx.db.get(pledge.donorId);
      // No address, nothing to send. Deliberately NOT claimed — a donor who
      // gains an email later should still be reachable by a re-run, and unlike
      // the reimbursement sweep this table is small enough that re-examining
      // them costs nothing.
      if (!donor?.email) continue;

      const key = String(pledge.scope);
      if (!chapters.has(key)) {
        if (pledge.scope === "central") {
          chapters.set(key, { name: null, slug: null });
        } else {
          const chapterId = pledge.scope as Id<"chapters">;
          const chapter = await ctx.db.get(chapterId);
          const territory = await territoryForChapter(ctx, chapterId);
          chapters.set(key, {
            name: chapter?.name ?? null,
            slug:
              territory && territory.publiclyVisible ? territory.slug : null,
          });
        }
      }
      const chapter = chapters.get(key) as {
        name: string | null;
        slug: string | null;
      };

      due.push({
        pledgeId: pledge._id,
        email: donor.email,
        name: donor.name,
        monthlyCents: pledge.amountCents,
        // `startedAt` is the honest "backing since" date and is exactly right
        // here — this email is ABOUT how long they've been giving, and the
        // reason that field is unfit as a digest axis (it is backdatable) is
        // the reason it is the right one to print.
        backingSince: pledge.startedAt ?? pledge.createdAt,
        chapterName: chapter.name,
        territorySlug: chapter.slug,
        isBacker: pledge.amountCents >= BACKER_UNIT_CENTS,
      });
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
 * Sweep the table and send the catch-up. DRY RUN BY DEFAULT: with `execute`
 * omitted or false it claims nothing, sends nothing, and returns exactly the
 * counts a real run would produce (`eligible` is the backlog).
 *
 * Both modes drain the whole table via self-reschedule, so a dry run's final
 * log line is a true backlog count rather than one page of it. The value
 * returned to the caller is the FIRST page plus its tally; the run's total is
 * the `[backer-catch-up]` log line where `done=true`.
 */
export const backfillBackerCatchUp = internalAction({
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
      internal.backerCatchUpBackfill.listCatchUpBacklog,
      { cursor: args.cursor ?? null, numItems: PAGE_SIZE },
    );

    const total: Progress = {
      scanned: (args.progress?.scanned ?? 0) + page.scanned,
      eligible: (args.progress?.eligible ?? 0) + page.due.length,
      claimed: args.progress?.claimed ?? 0,
      delivered: args.progress?.delivered ?? 0,
    };

    if (execute) {
      for (const row of page.due) {
        // CLAIM FIRST — see this file's header. A `false` means an overlapping
        // run, or the live welcome path, already owns this person's email.
        const claimed: boolean = await ctx.runMutation(
          internal.backerCatchUpBackfill.markBackerCatchUpSent,
          { pledgeId: row.pledgeId },
        );
        if (!claimed) continue;
        total.claimed += 1;

        const { subject, html } = renderBackerWelcomeEmail({
          kind: "catch_up",
          name: row.name,
          monthlyCents: row.monthlyCents,
          chapterName: row.chapterName,
          isBacker: row.isBacker,
          backingSince: row.backingSince,
          givePageUrl: row.territorySlug ? givePageUrl(row.territorySlug) : null,
          portalUrl: backerPortalUrl(),
        });
        try {
          const ok = await sendEmailReporting(ctx, {
            to: row.email,
            subject,
            html,
          });
          if (ok) total.delivered += 1;
        } catch (err) {
          // Isolate each recipient: one bad address must not abandon the rest
          // of the page. The row stays claimed — one lost thank-you, never a
          // duplicated one.
          console.error("[backer-catch-up] send failed", row.pledgeId, err);
        }
      }
    }

    console.log(
      `[backer-catch-up] ${execute ? "EXECUTE" : "DRY RUN"} scanned=${total.scanned} eligible=${total.eligible} claimed=${total.claimed} delivered=${total.delivered} done=${page.isDone}`,
    );

    if (!page.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.backerCatchUpBackfill.backfillBackerCatchUp,
        { execute, cursor: page.continueCursor, progress: total },
      );
    }

    return { ...total, isDone: page.isDone, continueCursor: page.continueCursor };
  },
});
