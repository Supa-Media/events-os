/**
 * SMS usage/cost ledger — read/write surface for `schema/smsUsage.ts`
 * (`smsUsageEvents`), the Twilio analog of `aiCodingData.ts`'s
 * `aiUsageEvents` ledger. Written per send attempt by
 * `blasts.ts#deliverSmsBlast` (purpose "blast") and
 * `ticketingSms.ts#sendVerificationSms` (purpose "verification");
 * `getSmsSpendSummary` is the monthly rollup behind
 * `TwilioUsageSummary.tsx`. See docs/plans/sms-comms.md for the pricing
 * constant + the finance recipe (a recurring monthly "SMS / Texting" budget,
 * no per-text transactions).
 */
import { internalMutation, query } from "./_generated/server";
import { v } from "convex/values";
import { Doc, Id } from "./_generated/dataModel";
import { isCentralEdOrFm } from "./lib/finance";
import { isSuperuser } from "./lib/superuser";

/** Record one SMS send attempt (sent/failed/opted_out). Never passed a full
 *  phone number — callers pass only `phoneLast4`. */
export const recordUsageEvent = internalMutation({
  args: {
    chapterId: v.union(v.id("chapters"), v.literal("central")),
    purpose: v.union(v.literal("blast"), v.literal("verification")),
    blastId: v.optional(v.id("blasts")),
    eventId: v.optional(v.id("events")),
    phoneLast4: v.string(),
    segments: v.number(),
    costUsdMicros: v.number(),
    outcome: v.union(
      v.literal("sent"),
      v.literal("failed"),
      v.literal("opted_out"),
    ),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert("smsUsageEvents", { ...args, createdAt: Date.now() });
    return null;
  },
});

/** The UTC calendar-month boundary `ts` falls in — same "roughly right, not
 *  per-viewer-exact" convention as `aiCodingData.ts#startOfMonthUtc`; this is
 *  an org-wide spend rollup, not a per-chapter-timezone report. */
function startOfMonthUtc(ts: number): number {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

/** Bounded scan — a low-volume audit surface (same spirit as
 *  `aiCodingData.ts`'s `USAGE_SCAN_LIMIT`), not a paginated ledger. Two
 *  calendar months of SMS sends is comfortably under this cap for any
 *  realistic org SMS volume. Exported so tests can assert the boundary
 *  arithmetic (`isScanTruncated`) without inserting `SPEND_SCAN_LIMIT` rows. */
export const SPEND_SCAN_LIMIT = 20_000;

/** Whether the bounded scan below likely undercounts real spend:
 *  `rowCount` hitting the cap means the query's `.take` cut off rows that
 *  were still inside the requested window, not that there genuinely were
 *  exactly `SPEND_SCAN_LIMIT` of them. Pure arithmetic, extracted so the
 *  boundary is unit-testable directly — reproducing the cap with real rows
 *  in a test would be prohibitively slow. */
export function isScanTruncated(rowCount: number): boolean {
  return rowCount === SPEND_SCAN_LIMIT;
}

type PurposeTotals = { segments: number; costUsdMicros: number };
type MonthTotals = {
  segments: number;
  costUsdMicros: number;
  byPurpose: { blast: PurposeTotals; verification: PurposeTotals };
};

function emptyMonthTotals(): MonthTotals {
  return {
    segments: 0,
    costUsdMicros: 0,
    byPurpose: {
      blast: { segments: 0, costUsdMicros: 0 },
      verification: { segments: 0, costUsdMicros: 0 },
    },
  };
}

/** Fold `rows` (already scoped to a single month) into `MonthTotals`. Only
 *  `outcome:"sent"` rows count toward spend — a "failed" or "opted_out" row
 *  never actually billed (both are recorded with `costUsdMicros:0` already,
 *  but this keeps the SEGMENT total honest too: no carrier segment was
 *  consumed for a message that was never sent). */
function foldMonth(rows: Doc<"smsUsageEvents">[]): MonthTotals {
  const totals = emptyMonthTotals();
  for (const row of rows) {
    if (row.outcome !== "sent") continue;
    totals.segments += row.segments;
    totals.costUsdMicros += row.costUsdMicros;
    totals.byPurpose[row.purpose].segments += row.segments;
    totals.byPurpose[row.purpose].costUsdMicros += row.costUsdMicros;
  }
  return totals;
}

const monthTotalsValidator = v.object({
  segments: v.number(),
  costUsdMicros: v.number(),
  byPurpose: v.object({
    blast: v.object({ segments: v.number(), costUsdMicros: v.number() }),
    verification: v.object({ segments: v.number(), costUsdMicros: v.number() }),
  }),
});

/**
 * Monthly SMS spend rollup — current + previous calendar month totals (only
 * `outcome:"sent"` rows count), plus a per-chapter breakdown for the CURRENT
 * month (which chapter should carry its own "SMS / Texting" budget line —
 * see docs/plans/sms-comms.md). Same gate as the AI-usage audit trail
 * (`aiCodingData.getUsageSummary`) — central ED/FM only.
 */
export const getSmsSpendSummary = query({
  args: {},
  returns: v.union(
    v.null(),
    v.object({
      currentMonth: monthTotalsValidator,
      previousMonth: monthTotalsValidator,
      byChapter: v.array(
        v.object({
          chapterId: v.union(v.id("chapters"), v.literal("central")),
          chapterName: v.string(),
          segments: v.number(),
          costUsdMicros: v.number(),
        }),
      ),
      // True when the scan below hit SPEND_SCAN_LIMIT — the totals above may
      // be undercounting real spend (older rows inside the window got cut
      // off by `.take`), not that spend was actually zero past the cap.
      truncated: v.boolean(),
    }),
  ),
  handler: async (ctx) => {
    // Soft gate: this query backs a passive summary panel on the
    // superuser-only Integrations screen, so superusers count as viewers
    // alongside the Accounts-tab ED/FM gate. Returning null (instead of
    // throwing like `requireCentralEdOrFm`) lets the panel render nothing
    // for anyone else rather than crashing the screen.
    if (!(await isCentralEdOrFm(ctx)) && !(await isSuperuser(ctx))) {
      return null;
    }

    const now = Date.now();
    const currentStart = startOfMonthUtc(now);
    const previousStart = startOfMonthUtc(
      new Date(currentStart - 1).getTime(),
    );

    // Computed BEFORE the query so the index range itself excludes anything
    // older than the previous month's start — an unbounded `by_time` scan
    // could silently drop rows from the two months this rollup actually
    // reports on once total volume passed SPEND_SCAN_LIMIT (bounded only by
    // `.take`, from the newest row backwards, with no lower bound at all).
    const rows = await ctx.db
      .query("smsUsageEvents")
      .withIndex("by_time", (q) => q.gte("createdAt", previousStart))
      .order("desc")
      .take(SPEND_SCAN_LIMIT);
    const truncated = isScanTruncated(rows.length);

    const currentRows = rows.filter((r) => r.createdAt >= currentStart);
    const previousRows = rows.filter(
      (r) => r.createdAt >= previousStart && r.createdAt < currentStart,
    );

    const byChapterMap = new Map<
      Id<"chapters"> | "central",
      { segments: number; costUsdMicros: number }
    >();
    for (const row of currentRows) {
      if (row.outcome !== "sent") continue;
      const existing = byChapterMap.get(row.chapterId) ?? {
        segments: 0,
        costUsdMicros: 0,
      };
      existing.segments += row.segments;
      existing.costUsdMicros += row.costUsdMicros;
      byChapterMap.set(row.chapterId, existing);
    }
    const byChapter = await Promise.all(
      [...byChapterMap.entries()].map(async ([chapterId, totals]) => {
        const chapterName =
          chapterId === "central"
            ? "Central"
            : ((await ctx.db.get(chapterId))?.name ?? "Unknown chapter");
        return { chapterId, chapterName, ...totals };
      }),
    );
    byChapter.sort((a, b) => b.costUsdMicros - a.costUsdMicros);

    return {
      currentMonth: foldMonth(currentRows),
      previousMonth: foldMonth(previousRows),
      byChapter,
      truncated,
    };
  },
});
