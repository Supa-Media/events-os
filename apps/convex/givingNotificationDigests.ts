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
import { giftMethodLabel } from "./lib/giftLabels";
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

/**
 * How many MATCHING gifts one digest window will collect before it cuts the
 * window short. Generous against any real period (the whole ledger is in the
 * hundreds) and far below Convex's 16,384-document transaction read limit even
 * with a scan that matches nothing.
 */
const MAX_DIGEST_MATCHES = 750;

/** Hard bound on rows READ per window, so a rule that matches almost nothing
 *  still can't walk an unbounded range inside one transaction. */
const MAX_DIGEST_SCAN = 4000;

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
async function collectWindowGifts(
  ctx: Pick<MutationCtx, "db">,
  rule: Doc<"givingNotificationRules">,
  since: number,
  until: number,
): Promise<WindowResult> {
  const gifts: Doc<"gifts">[] = [];
  let scanned = 0;
  let capped = false;
  let boundaryTs = until;

  for await (const gift of ctx.db
    .query("gifts")
    .withIndex("by_created", (q) =>
      q.gt("createdAt", since).lte("createdAt", until),
    )) {
    // Past a cap: keep taking rows that share the boundary instant, then stop.
    if (capped && gift.createdAt !== boundaryTs) break;

    scanned++;
    if (ruleMatchesGift(rule, gift)) gifts.push(gift);

    if (!capped && (gifts.length >= MAX_DIGEST_MATCHES || scanned >= MAX_DIGEST_SCAN)) {
      capped = true;
      boundaryTs = gift.createdAt;
    }
  }

  return { gifts, truncated: capped, until: capped ? boundaryTs : until };
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
    let totalCents = 0;
    let largestRow: Doc<"gifts"> | null = null;

    for (const gift of gifts) {
      totalCents += gift.amountCents;
      addTo(byMethod, giftMethodLabel(gift.method), gift.amountCents);
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
    await ctx.db.patch(rule._id, {
      lastSentAt: window.until,
      lastRunDayKey: dayKey,
      updatedAt: now,
    });

    return {
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
        gifts: listed,
        omittedCount: Math.max(0, gifts.length - listed.length),
        countTruncated: window.truncated,
      },
    };
  },
});

/**
 * The hourly sweep. Claims, renders, sends — with a `try` around EACH rule, so
 * a rule that throws while being claimed or rendered costs itself and nothing
 * else, and a `try` around each recipient inside that, so one bad address
 * can't cost the rest of a fundraising team their digest.
 *
 * A deployment with no Resend key degrades to a logged no-op inside
 * `sendEmailReporting`.
 */
export const sendGivingDigests = internalAction({
  args: {},
  returns: v.object({
    digestsSent: v.number(),
    emailsSent: v.number(),
    failedRules: v.number(),
  }),
  handler: async (
    ctx,
  ): Promise<{
    digestsSent: number;
    emailsSent: number;
    failedRules: number;
  }> => {
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
        digestsSent++;
        for (const to of built.recipients) {
          try {
            // Counts DELIVERIES, not attempts — see `notifyGiftRecorded`.
            if (await sendEmailReporting(ctx, { to, subject, html })) {
              emailsSent++;
            }
          } catch (err) {
            console.error(
              `[givingNotifications] digest send failed for ${to}`,
              err,
            );
          }
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
    return { digestsSent, emailsSent, failedRules };
  },
});
