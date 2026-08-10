/**
 * The daily / weekly giving digests.
 *
 * ── HOW A RUN WORKS ────────────────────────────────────────────────────────
 * The cron fires HOURLY, on the hour (`crons.ts`), because a rule names the
 * hour it wants in the org's timezone and a single fixed UTC cron can't serve
 * both an 08:00 and an 18:00 subscriber. Each run:
 *
 *   1. `claimDueDigests` (a MUTATION) finds the active daily/weekly rules
 *      whose local send hour is now and that haven't already gone out today,
 *      works out each one's window, checks whether it has anything to say,
 *      STAMPS `lastSentAt`, and returns the claims.
 *   2. `digestPayload` (a QUERY) assembles each claim's totals, breakdowns and
 *      gift list.
 *   3. `sendGivingDigests` (the ACTION) mails them, per-recipient best effort.
 *
 * Claim-before-send, the posture `cards.ts#advanceCodingReviewReminders`
 * established: the stamp lands in the same transaction as the selection, so a
 * crash between claiming and sending costs at most ONE digest rather than
 * repeating it every hour. Running the sweep twice in the same local hour is
 * safe — the second pass finds the watermark already stamped for today and
 * claims nothing.
 *
 * ── THE ASYMMETRY ──────────────────────────────────────────────────────────
 * An empty DAILY digest is skipped AND leaves the watermark alone, so the next
 * one covers everything since the last mail that actually went out. An empty
 * WEEKLY digest is SENT — "nothing came in this week" is real signal to a
 * fundraising team, and it doubles as proof the pipeline is alive. The
 * reasoning is written out in full in `lib/givingNotificationRules.ts`.
 */
import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { giftMethodLabel } from "./lib/giftLabels";
import {
  MAX_DIGEST_GIFT_ROWS,
  MAX_RULES,
  digestWindowStart,
  isDigestDue,
  ruleMatchesGift,
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
 * How many gifts one digest window will read. Generous against any real
 * period (the whole ledger is in the hundreds), and a hard stop so an
 * accidental bulk import can't turn one cron tick into an unbounded read. Past
 * it, the totals under-count and the email says so.
 */
const MAX_DIGEST_SCAN = 2000;

const DIGEST_CADENCES = ["daily", "weekly"] as const;

/**
 * The gifts in a window, on `createdAt` — when the ledger LEARNED of the gift,
 * not when the money changed hands. `receivedAt` is freely backdatable, so a
 * window on it would silently drop a gift entered after its own period closed;
 * `createdAt` only moves forward, which makes `(since, until]` a partition.
 * See `lib/givingNotificationRules.ts`.
 */
async function windowGifts(
  ctx: Pick<QueryCtx, "db">,
  since: number,
  until: number,
): Promise<Doc<"gifts">[]> {
  return await ctx.db
    .query("gifts")
    .withIndex("by_created", (q) =>
      q.gt("createdAt", since).lte("createdAt", until),
    )
    .take(MAX_DIGEST_SCAN);
}

/**
 * Claim the digests that are due right now, stamping each one's watermark in
 * the same transaction that selected it. Returns what to send.
 */
export const claimDueDigests = internalMutation({
  args: { now: v.optional(v.number()) },
  returns: v.array(
    v.object({
      ruleId: v.id("givingNotificationRules"),
      since: v.number(),
      until: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    const claims: Array<{
      ruleId: Id<"givingNotificationRules">;
      since: number;
      until: number;
    }> = [];

    for (const cadence of DIGEST_CADENCES) {
      const rules = await ctx.db
        .query("givingNotificationRules")
        .withIndex("by_cadence", (q) => q.eq("cadence", cadence))
        .take(MAX_RULES);

      for (const rule of rules) {
        if (!isDigestDue(rule, now)) continue;
        const since = digestWindowStart(rule, now);
        const gifts = await windowGifts(ctx, since, now);
        const matching = gifts.filter((g) => ruleMatchesGift(rule, g));
        if (!shouldSendDigest(rule.cadence, matching.length)) {
          // Deliberately NOT stamped — the window carries forward so nothing
          // can fall between two runs. See the module doc.
          continue;
        }
        await ctx.db.patch(rule._id, { lastSentAt: now });
        claims.push({ ruleId: rule._id, since, until: now });
      }
    }
    return claims;
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

/** Everything one digest email needs. `null` when the rule vanished. */
export const digestPayload = internalQuery({
  args: {
    ruleId: v.id("givingNotificationRules"),
    since: v.number(),
    until: v.number(),
  },
  handler: async (ctx, { ruleId, since, until }) => {
    const rule = await ctx.db.get(ruleId);
    if (!rule) return null;
    if (rule.cadence !== "daily" && rule.cadence !== "weekly") return null;

    const gifts = (await windowGifts(ctx, since, until)).filter((g) =>
      ruleMatchesGift(rule, g),
    );
    // Newest first — a digest is read top-down and the freshest gift is the
    // one most likely to still be worth a phone call today.
    gifts.sort((a, b) => b.createdAt - a.createdAt);

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
      const built = await buildNotificationGift(ctx, gift, chapterNames);
      if (built) listed.push(built);
    }
    // The scope breakdown needs a label for EVERY gift, listed or not, so the
    // totals it shows agree with the total above.
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
      ? await buildNotificationGift(ctx, largestRow, chapterNames)
      : null;

    return {
      recipients: rule.recipients,
      payload: {
        ruleName: rule.name,
        cadence: rule.cadence,
        scopeLabel: await ruleScopeLabel(ctx, rule.scope),
        periodStart: since,
        periodEnd: until,
        totalCents,
        giftCount: gifts.length,
        largest,
        byScope: sortedRows(byScope),
        byMethod: sortedRows(byMethod),
        gifts: listed,
        omittedCount: Math.max(0, gifts.length - listed.length),
      },
    };
  },
});

/**
 * The hourly sweep. Claims, renders, sends. Per-recipient best effort — one
 * bad address can't cost the rest of a fundraising team their digest — and a
 * deployment with no Resend key degrades to a logged no-op inside `sendEmailReporting`.
 */
export const sendGivingDigests = internalAction({
  args: {},
  returns: v.object({ digestsSent: v.number(), emailsSent: v.number() }),
  handler: async (ctx): Promise<{ digestsSent: number; emailsSent: number }> => {
    const claims = await ctx.runMutation(
      internal.givingNotificationDigests.claimDueDigests,
      {},
    );
    let digestsSent = 0;
    let emailsSent = 0;

    for (const claim of claims) {
      const built = await ctx.runQuery(
        internal.givingNotificationDigests.digestPayload,
        claim,
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
    }
    return { digestsSent, emailsSent };
  },
});
