/**
 * The daily / weekly giving digests.
 *
 * ── HOW A RUN WORKS ────────────────────────────────────────────────────────
 * The cron fires HOURLY, on the hour (`crons.ts`), because a rule names the
 * hour it wants in the org's timezone and a single fixed UTC cron can't serve
 * both an 08:00 and an 18:00 subscriber. Each run:
 *
 *   1. `dueDigestRuleIds` (a QUERY) — which rules' moment has arrived. Reads
 *      only the rules table; touches no gifts.
 *   2. `claimDigest` (a MUTATION, ONE PER RULE) — reads that rule's window,
 *      decides whether it sends, moves the marks, and returns the finished
 *      payload.
 *   3. `sendGivingDigests` (the ACTION) — renders and mails, per rule and then
 *      per recipient.
 *
 * ── ONE TRANSACTION PER RULE, AND ONE TRY PER RULE ─────────────────────────
 * Both of those are load-bearing, and both were wrong in the first cut.
 *
 * Claiming every due rule in ONE mutation put every rule's window read in one
 * transaction. The default send hour is 8, so in practice that is *every*
 * daily and weekly rule at once, and Convex caps a transaction at 16,384
 * documents read — nine rules against a full window and the mutation throws,
 * taking down every digest for an hour that will not come round again until
 * tomorrow. Per-rule transactions have no such cliff.
 *
 * Isolating only the `sendEmailReporting` call was the same mistake one level
 * down. A throw in `claimDigest`, or in `renderDigestEmail`, aborted the whole
 * action — and the rules already claimed had moved their watermark and were
 * never mailed. Convex does not retry a failed scheduled action, so that is
 * permanent, silent data loss for every rule after the first failure. Each
 * rule now gets its own `try`, so one bad rule costs exactly itself.
 *
 * ── THE WINDOW IS FILTERED BEFORE IT IS CAPPED ─────────────────────────────
 * `collectWindowGifts` streams the `by_created` range and applies
 * `ruleMatchesGift` as it goes, so the cap bounds MATCHED gifts, not scanned
 * rows. Capping first was a money bug and a wedge at once: a 5,000-row import
 * made a digest mail a total 60% short, stamp the watermark, and lose the
 * remainder forever — and a chapter-scoped rule whose prefix was all other
 * books matched zero, skipped, declined to stamp, and re-read the same prefix
 * every day thereafter, silently, forever.
 *
 * A cut window is handled honestly rather than hidden: the watermark advances
 * only to the last gift actually read (so the remainder is the NEXT window,
 * not lost), the cut lands on a whole-millisecond boundary (so no gift sharing
 * that instant is skipped or double-counted), the digest SENDS regardless of
 * what it matched (breaking the wedge), and the email says its total is a
 * floor.
 *
 * ── A WEEKLY DIGEST COVERS A WEEK ──────────────────────────────────────────
 * The window opens at `min(now − period, watermark)`, so it is never shorter
 * than the cadence promises and never shorter than the un-reported tail. The
 * first digest off a rule created this morning still reports the trailing seven
 * days; a rule that missed a fortnight of runs reports the fortnight. The one
 * exception is a drain in progress — full reasoning on `digestWindowStart` and
 * on `lastWindowTruncated` in the schema.
 *
 * ── THE ASYMMETRY ──────────────────────────────────────────────────────────
 * An empty DAILY digest is skipped and leaves the WATERMARK alone (it still
 * marks itself run for the day). An empty WEEKLY digest is SENT — "nothing
 * came in this week" is real signal to a fundraising team, and it doubles as
 * proof the pipeline is alive. Reasoning in full in
 * `lib/givingNotificationRules.ts`.
 */
import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { GIFT_TYPE_LABELS, giftMethodLabel, giftType } from "./lib/giftLabels";
import {
  DIGEST_LAG_MS,
  MAX_DIGEST_GIFT_ROWS,
  MAX_RULES,
  digestWindowStart,
  isDigestDue,
  ruleMatchesGift,
  runDayKey,
  shouldSendDigest,
} from "./lib/givingNotificationRules";
import {
  buildNotificationGift,
  ruleScopeLabel,
  scopeLabel,
} from "./lib/givingNotificationContext";
import {
  renderDigestEmail,
  type DigestBreakdownRow,
  type NotificationGift,
} from "./lib/givingNotificationEmails";
import { sendEmailReporting } from "./ticketingEmails";
import { resolveResendSettings } from "./lib/resend";

/**
 * How many MATCHING gifts one digest window will collect before it cuts the
 * window short. Generous against any real period (the whole ledger is in the
 * hundreds) and far below Convex's 16,384-document transaction read limit even
 * with a scan that matches nothing.
 */
export const MAX_DIGEST_MATCHES = 750;

/** Hard bound on rows READ per window, so a rule that matches almost nothing
 *  still can't walk an unbounded range inside one transaction. */
export const MAX_DIGEST_SCAN = 4000;

/** Injectable bounds, so the cut-window machinery — the most intricate code
 *  here — can be tested at its real boundaries without writing thousands of
 *  fixture rows. Production always uses the defaults. */
export type WindowCaps = { maxMatches: number; maxScan: number };
const DEFAULT_CAPS: WindowCaps = {
  maxMatches: MAX_DIGEST_MATCHES,
  maxScan: MAX_DIGEST_SCAN,
};

/** How many rules one hourly sweep will claim. A second sweep an hour later
 *  picks up any remainder — no rule is dropped, the work is just spread. */
const MAX_CLAIMS_PER_RUN = 50;

const DIGEST_CADENCES = ["daily", "weekly"] as const;

type WindowResult = {
  /** Gifts in the window that this rule matches, oldest first. */
  gifts: Doc<"gifts">[];
  /** The read stopped early — totals are a FLOOR and the window was cut. */
  truncated: boolean;
  /** Where the window actually closed. Equals the requested `until` on a
   *  complete read; the last-read gift's `createdAt` on a cut one. */
  until: number;
};

/**
 * The gifts in `(since, until]` that `rule` matches, on `createdAt` — when the
 * ledger LEARNED of the gift, not when the money changed hands. `receivedAt`
 * is freely backdatable, so a window on it would silently drop a gift entered
 * after its own period closed; `createdAt` only moves forward, which makes the
 * range a partition.
 *
 * FILTERS AS IT STREAMS, so both caps bound something meaningful: matches, and
 * rows read. When either is hit the read keeps going to the end of the current
 * MILLISECOND before stopping — several gifts can share a `createdAt` during
 * an import, and cutting mid-millisecond would either skip them (the next
 * window opens strictly after the watermark) or re-report them (if the
 * watermark were nudged back). Draining the instant is the only cut that does
 * neither.
 */
export async function collectWindowGifts(
  ctx: Pick<MutationCtx, "db">,
  rule: Pick<Doc<"givingNotificationRules">, "isActive" | "scope" | "minAmountCents">,
  since: number,
  until: number,
  caps: WindowCaps = DEFAULT_CAPS,
): Promise<WindowResult> {
  // A SCOPED rule reads only its own book. On the global index a quiet
  // chapter's rule walked every other book's gifts and tripped its scan cap on
  // them, mailing a "cut short" that was true about the read and false about
  // that chapter's giving.
  const stream =
    rule.scope === "all"
      ? ctx.db
          .query("gifts")
          .withIndex("by_created", (q) =>
            q.gt("createdAt", since).lte("createdAt", until),
          )
      : ctx.db
          .query("gifts")
          .withIndex("by_scope_and_created", (q) =>
            q
              .eq("scope", rule.scope as Doc<"gifts">["scope"])
              .gt("createdAt", since)
              .lte("createdAt", until),
          );

  const gifts: Doc<"gifts">[] = [];
  let scanned = 0;
  let capped = false;
  let boundaryTs = until;
  // TRUNCATION IS "WE STOPPED EARLY", NOT "WE HIT THE CAP". Hitting the cap on
  // the very last row of the range means the window was read in full — calling
  // that truncated mailed a false "cut short" and needlessly held the watermark
  // back.
  let stoppedEarly = false;

  for await (const gift of stream) {
    // Past a cap: keep taking rows that share the boundary instant, then stop.
    // Several gifts can share a `createdAt` during an import, and the next
    // window opens strictly AFTER the watermark — cutting mid-instant would
    // skip them, and nudging the watermark back would re-report them.
    if (capped && gift.createdAt !== boundaryTs) {
      stoppedEarly = true;
      break;
    }

    scanned++;
    if (ruleMatchesGift(rule, gift)) gifts.push(gift);

    if (!capped && (gifts.length >= caps.maxMatches || scanned >= caps.maxScan)) {
      capped = true;
      boundaryTs = gift.createdAt;
    }
  }

  return {
    gifts,
    truncated: stoppedEarly,
    until: stoppedEarly ? boundaryTs : until,
  };
}

/** Which rules' moment has arrived. Rules only — no gift reads, so this can
 *  never approach a transaction limit however many rules exist. */
export const dueDigestRuleIds = internalQuery({
  args: { now: v.optional(v.number()) },
  returns: v.array(v.id("givingNotificationRules")),
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    const due: Id<"givingNotificationRules">[] = [];
    for (const cadence of DIGEST_CADENCES) {
      const rules = await ctx.db
        .query("givingNotificationRules")
        .withIndex("by_cadence", (q) => q.eq("cadence", cadence))
        .take(MAX_RULES);
      for (const rule of rules) {
        if (isDigestDue(rule, now)) due.push(rule._id);
      }
    }
    return due.slice(0, MAX_CLAIMS_PER_RUN);
  },
});

function addTo(
  rows: Map<string, DigestBreakdownRow>,
  label: string,
  cents: number,
): void {
  const row = rows.get(label) ?? { label, cents: 0, count: 0 };
  row.cents += cents;
  row.count += 1;
  rows.set(label, row);
}

function sortedRows(rows: Map<string, DigestBreakdownRow>): DigestBreakdownRow[] {
  return [...rows.values()].sort((a, b) => b.cents - a.cents);
}

/**
 * Claim ONE rule's digest: read its window, decide, move its marks, and build
 * the payload — all in a single transaction, so what is mailed is exactly what
 * was claimed and a crash before the mail costs at most this one rule's digest
 * rather than repeating it every hour.
 *
 * Returns `null` when the rule is no longer due, or when it's an empty daily
 * (which still marks itself RUN for the day, but deliberately does not move
 * the watermark — the window carries forward).
 */
export const claimDigest = internalMutation({
  args: {
    ruleId: v.id("givingNotificationRules"),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    const rule = await ctx.db.get(args.ruleId);
    if (!rule) return null;
    if (!isDigestDue(rule, now)) return null;
    if (rule.cadence !== "daily" && rule.cadence !== "weekly") return null;

    // Marked as RUN for the day whatever happens below — including the empty
    // daily that sends nothing. Without this, `>=`-hour matching would re-read
    // the window on every remaining hour of the day.
    const dayKey = runDayKey(now);

    const since = digestWindowStart(rule, now);
    // The window closes a minute behind `now`, so a gift whose transaction
    // started before this run but commits after it lands in the NEXT window
    // rather than behind the watermark. See `DIGEST_LAG_MS`.
    const requestedUntil = Math.max(since, now - DIGEST_LAG_MS);
    const window = await collectWindowGifts(ctx, rule, since, requestedUntil);

    if (!shouldSendDigest(rule.cadence, window.gifts.length, window.truncated)) {
      await ctx.db.patch(rule._id, { lastRunDayKey: dayKey });
      return null;
    }

    // Newest first — a digest is read top-down and the freshest gift is the
    // one most likely to still be worth a phone call today.
    const gifts = [...window.gifts].sort((a, b) => b.createdAt - a.createdAt);

    const chapterNames = new Map<string, string>();
    const byScope = new Map<string, DigestBreakdownRow>();
    const byMethod = new Map<string, DigestBreakdownRow>();
    const byType = new Map<string, DigestBreakdownRow>();
    let totalCents = 0;
    let largestRow: Doc<"gifts"> | null = null;

    for (const gift of gifts) {
      totalCents += gift.amountCents;
      addTo(byMethod, giftMethodLabel(gift.method), gift.amountCents);
      // EVERY gift, matched or listed or not — `giftType` returns exactly one
      // bucket per gift (see `lib/giftLabels.ts`), which is what makes this cut
      // add up to `totalCents` rather than approximately to it.
      addTo(byType, GIFT_TYPE_LABELS[giftType(gift)], gift.amountCents);
      if (!largestRow || gift.amountCents > largestRow.amountCents) {
        largestRow = gift;
      }
    }

    const listed: NotificationGift[] = [];
    for (const gift of gifts.slice(0, MAX_DIGEST_GIFT_ROWS)) {
      const built = await buildNotificationGift(ctx, gift, chapterNames, now);
      if (built) listed.push(built);
    }
    // The scope breakdown needs a label for EVERY gift, listed or not, so what
    // it shows adds up to the total above.
    for (const gift of gifts) {
      const key = gift.scope as string;
      let label = chapterNames.get(key);
      if (label === undefined) {
        label = await scopeLabel(ctx, gift.scope);
        chapterNames.set(key, label);
      }
      addTo(byScope, label, gift.amountCents);
    }

    const largest = largestRow
      ? await buildNotificationGift(ctx, largestRow, chapterNames, now)
      : null;

    // The watermark moves to where the window ACTUALLY closed. On a cut window
    // that is the last gift read, so the remainder is the next window's
    // problem rather than nobody's.
    //
    // A CUT WINDOW CLEARS the run mark instead of stamping it, so the drain
    // continues on the next hourly tick rather than waiting for tomorrow. A
    // 5,000-gift import otherwise took a week of cut-short digests to report,
    // with every later gift queued behind it. Hourly ticks catch up the same
    // day, and the drain stops on its own the moment a run completes the window
    // (which stamps the mark normally).
    //
    // `lastWindowTruncated` rides along because the NEXT window's start depends
    // on which kind of mark this is: a completed window's watermark gets the
    // trailing-period floor, a cut one's must not (it would re-read the gifts
    // that cut it and cut again in the same place, hourly). See the schema doc.
    await ctx.db.patch(rule._id, {
      lastSentAt: window.until,
      lastRunDayKey: window.truncated ? undefined : dayKey,
      lastWindowTruncated: window.truncated ? true : undefined,
      updatedAt: now,
    });

    return {
      // What this claim CHANGED, so the action can put it back if not one
      // recipient could be reached — see `releaseDigest`.
      previousMarks: {
        lastSentAt: rule.lastSentAt,
        lastRunDayKey: rule.lastRunDayKey,
        lastWindowTruncated: rule.lastWindowTruncated,
      },
      claimedUntil: window.until,
      recipients: rule.recipients,
      payload: {
        ruleName: rule.name,
        cadence: rule.cadence,
        scopeLabel: await ruleScopeLabel(ctx, rule.scope),
        periodStart: since,
        periodEnd: window.until,
        totalCents,
        giftCount: gifts.length,
        largest,
        byScope: sortedRows(byScope),
        byMethod: sortedRows(byMethod),
        byType: sortedRows(byType),
        gifts: listed,
        omittedCount: Math.max(0, gifts.length - listed.length),
        countTruncated: window.truncated,
      },
    };
  },
});

/**
 * Put a claim's marks back, because not one recipient could be reached.
 *
 * A WINDOW MAY ONLY BE CONSUMED BY A DIGEST THAT ACTUALLY GOT OUT. Delivery
 * failure is caught per recipient so one bad address can't cost a team their
 * digest — but when EVERY recipient fails, the whole point of moving the
 * watermark has gone, and leaving it moved means those gifts are never reported
 * by any digest, ever. Convex does not retry a failed scheduled action, so
 * there is no second chance to lean on.
 *
 * Guarded against clobbering: it only restores while `lastSentAt` is still
 * exactly what this claim set, so a later run (or a human edit) that has
 * already moved on is never rolled backwards.
 */
export const releaseDigest = internalMutation({
  args: {
    ruleId: v.id("givingNotificationRules"),
    claimedUntil: v.number(),
    previousLastSentAt: v.optional(v.number()),
    previousLastRunDayKey: v.optional(v.string()),
    previousLastWindowTruncated: v.optional(v.boolean()),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const rule = await ctx.db.get(args.ruleId);
    if (!rule) return false;
    if (rule.lastSentAt !== args.claimedUntil) return false;
    await ctx.db.patch(args.ruleId, {
      lastSentAt: args.previousLastSentAt,
      lastRunDayKey: args.previousLastRunDayKey,
      // ALL THREE marks, or none. Restoring the watermark while leaving a cut
      // run's `true` behind would strip the re-read of its trailing-period
      // floor; leaving a `true` off a restored mid-drain mark would re-wedge
      // the drain. They only mean anything together.
      lastWindowTruncated: args.previousLastWindowTruncated,
    });
    return true;
  },
});

/**
 * The hourly sweep. Claims, renders, sends — with a `try` around EACH rule, so
 * a rule that throws while being claimed or rendered costs itself and nothing
 * else, and a `try` around each recipient inside that, so one bad address
 * can't cost the rest of a fundraising team their digest.
 *
 * ── NOTHING IS CLAIMED THAT CANNOT BE MAILED ───────────────────────────────
 * Two ways the sweep used to eat a window and deliver nothing, both silent:
 *
 *  1. NO RESEND KEY. `sendEmailReporting` returns `false` rather than throwing
 *     when no key resolves, so a deployment that had never configured one
 *     advanced every watermark daily and mailed nothing — and the day someone
 *     configured the key, every gift behind those watermarks was permanently
 *     un-digested. Resolved up front now, and the sweep returns BEFORE claiming
 *     anything. Nothing has been consumed, so the backlog is simply still there
 *     when a key appears.
 *  2. A RESEND OUTAGE. Every recipient throws, each is caught per-recipient,
 *     and the window was consumed anyway. Now a claim where NOT ONE recipient
 *     was reached is released (`releaseDigest`) and counted in `failedRules`,
 *     so the next tick re-reads the same window.
 */
export const sendGivingDigests = internalAction({
  args: {},
  returns: v.object({
    digestsSent: v.number(),
    emailsSent: v.number(),
    failedRules: v.number(),
    skippedNoMailer: v.boolean(),
  }),
  handler: async (
    ctx,
  ): Promise<{
    digestsSent: number;
    emailsSent: number;
    failedRules: number;
    skippedNoMailer: boolean;
  }> => {
    // BEFORE anything is claimed. See the module doc — this ordering is the
    // whole fix, and it has no duplicate-email trade-off because no window has
    // been consumed yet.
    const mailer = await resolveResendSettings(ctx);
    if (!mailer) {
      console.log(
        "[givingNotifications] digest sweep skipped: no Resend key configured. " +
          "No watermark advanced, so nothing is lost — the backlog will be sent " +
          "once a key is set.",
      );
      return {
        digestsSent: 0,
        emailsSent: 0,
        failedRules: 0,
        skippedNoMailer: true,
      };
    }

    const ruleIds = await ctx.runQuery(
      internal.givingNotificationDigests.dueDigestRuleIds,
      {},
    );
    let digestsSent = 0;
    let emailsSent = 0;
    let failedRules = 0;

    for (const ruleId of ruleIds) {
      try {
        const built = await ctx.runMutation(
          internal.givingNotificationDigests.claimDigest,
          { ruleId },
        );
        if (!built) continue;
        const { subject, html } = renderDigestEmail(built.payload);

        let delivered = 0;
        for (const to of built.recipients) {
          try {
            // Counts DELIVERIES, not attempts — see `notifyGiftRecorded`.
            if (await sendEmailReporting(ctx, { to, subject, html })) {
              delivered++;
            }
          } catch (err) {
            console.error(
              `[givingNotifications] digest send failed for ${to}`,
              err,
            );
          }
        }

        if (delivered === 0) {
          // Not one recipient reached — give the window back.
          failedRules++;
          console.error(
            `[givingNotifications] digest for rule ${ruleId} reached nobody; ` +
              "releasing its window so the next run re-reads it",
          );
          await ctx.runMutation(
            internal.givingNotificationDigests.releaseDigest,
            {
              ruleId,
              claimedUntil: built.claimedUntil,
              previousLastSentAt: built.previousMarks.lastSentAt,
              previousLastRunDayKey: built.previousMarks.lastRunDayKey,
              previousLastWindowTruncated:
                built.previousMarks.lastWindowTruncated,
            },
          );
          continue;
        }

        digestsSent++;
        emailsSent += delivered;
        // Only now, and only because somebody was actually reached. The marks
        // `claimDigest` moved are decided before the mail is attempted and are
        // put back by `releaseDigest` when it fails; this one can only be
        // written after the fact, and is never rolled back. Wrapped, because a
        // digest that went out and failed to record that it went out is a
        // cosmetic problem and must not be counted as a failed rule.
        try {
          await ctx.runMutation(
            internal.givingNotifications.markRulesDelivered,
            { ruleIds: [ruleId], at: Date.now() },
          );
        } catch (err) {
          console.error(
            `[givingNotifications] digest for rule ${ruleId} was delivered, ` +
              "but couldn't stamp lastDeliveredAt",
            err,
          );
        }
      } catch (err) {
        // LOUD, and names the rule — a lost digest that nothing in the logs
        // ties back to a rule is the failure mode this catch exists to avoid.
        failedRules++;
        console.error(
          `[givingNotifications] digest failed for rule ${ruleId}`,
          err,
        );
      }
    }
    return { digestsSent, emailsSent, failedRules, skippedNoMailer: false };
  },
});
