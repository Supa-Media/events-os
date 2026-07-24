import { describe, expect, test } from "vitest";

import { api } from "../_generated/api";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import type { Id } from "../_generated/dataModel";
import { isScanTruncated, SPEND_SCAN_LIMIT } from "../smsUsage";

/**
 * SMS usage/cost ledger (Attendance F) — `smsUsage.getSmsSpendSummary`, the
 * monthly rollup behind `TwilioUsageSummary.tsx`:
 *  - central ED/FM-only (same gate as `aiCodingData.getUsageSummary`), a
 *    superuser passes it too (the gate's short-circuit).
 *  - current vs previous UTC-calendar-month totals, split by purpose.
 *  - only `outcome:"sent"` rows count toward spend (failed/opted_out never
 *    actually billed).
 *  - per-chapter breakdown for the current month, "central" included.
 */

const SUPERUSER_EMAIL = "seyi@publicworship.life";

async function insertUsageRow(
  s: ChapterSetup,
  overrides: Partial<{
    chapterId: Id<"chapters"> | "central";
    purpose: "blast" | "verification";
    segments: number;
    costUsdMicros: number;
    outcome: "sent" | "failed" | "opted_out";
    createdAt: number;
  }> = {},
) {
  await run(s.t, (ctx) =>
    ctx.db.insert("smsUsageEvents", {
      chapterId: overrides.chapterId ?? s.chapterId,
      purpose: overrides.purpose ?? "blast",
      phoneLast4: "1234",
      segments: overrides.segments ?? 1,
      costUsdMicros: overrides.costUsdMicros ?? 10_000,
      outcome: overrides.outcome ?? "sent",
      createdAt: overrides.createdAt ?? Date.now(),
    }),
  );
}

describe("getSmsSpendSummary gate", () => {
  test("a plain chapter admin gets null (soft gate, never a throw)", async () => {
    const t = newT();
    const s = await setupChapter(t); // leader@ — not ED/FM, not superuser
    const result = await s.as.query(api.smsUsage.getSmsSpendSummary, {});
    expect(result).toBeNull();
  });

  test("a superuser passes (the gate's short-circuit)", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: SUPERUSER_EMAIL });
    const result = await s.as.query(api.smsUsage.getSmsSpendSummary, {});
    expect(result).not.toBeNull();
    expect(result!.currentMonth.segments).toBe(0);
    // Nowhere near SPEND_SCAN_LIMIT rows in a fresh test chapter.
    expect(result!.truncated).toBe(false);
  });
});

describe("isScanTruncated (the truncation-detection boundary)", () => {
  // Reproducing SPEND_SCAN_LIMIT (20k) real rows in a test is prohibitively
  // slow, so the arithmetic itself is unit-tested directly instead.
  test("false below the cap, true exactly at the cap", () => {
    expect(isScanTruncated(0)).toBe(false);
    expect(isScanTruncated(SPEND_SCAN_LIMIT - 1)).toBe(false);
    expect(isScanTruncated(SPEND_SCAN_LIMIT)).toBe(true);
  });
});

describe("getSmsSpendSummary rollup", () => {
  test("splits current vs previous month, and by purpose — only 'sent' rows count", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: SUPERUSER_EMAIL });

    const now = Date.now();
    const currentMonthStart = Date.UTC(
      new Date(now).getUTCFullYear(),
      new Date(now).getUTCMonth(),
      1,
    );
    const lastMonthTs = currentMonthStart - 5 * 24 * 60 * 60 * 1000; // safely in the previous month

    // Current month: 2 blast sends + 1 verification send + 1 failed + 1 opted_out.
    await insertUsageRow(s, { purpose: "blast", segments: 1, costUsdMicros: 10_000, outcome: "sent" });
    await insertUsageRow(s, { purpose: "blast", segments: 2, costUsdMicros: 20_000, outcome: "sent" });
    await insertUsageRow(s, { purpose: "verification", segments: 1, costUsdMicros: 10_000, outcome: "sent" });
    await insertUsageRow(s, { purpose: "blast", segments: 1, costUsdMicros: 0, outcome: "failed" });
    await insertUsageRow(s, { purpose: "blast", segments: 0, costUsdMicros: 0, outcome: "opted_out" });
    // Previous month: 1 sent blast — must NOT bleed into currentMonth.
    await insertUsageRow(s, {
      purpose: "blast",
      segments: 3,
      costUsdMicros: 30_000,
      outcome: "sent",
      createdAt: lastMonthTs,
    });
    // Well before the previous month — outside the query's index range
    // entirely (FIX 4: `by_time` is now bounded with `.gte(previousStart)`,
    // not scanned unbounded from "now" backwards). Must not appear anywhere.
    await insertUsageRow(s, {
      purpose: "blast",
      segments: 99,
      costUsdMicros: 990_000,
      outcome: "sent",
      createdAt: lastMonthTs - 90 * 24 * 60 * 60 * 1000,
    });

    const result = (await s.as.query(api.smsUsage.getSmsSpendSummary, {}))!;

    expect(result.currentMonth.segments).toBe(4); // 1 + 2 + 1 (sent only)
    expect(result.currentMonth.costUsdMicros).toBe(40_000);
    expect(result.currentMonth.byPurpose.blast).toEqual({
      segments: 3,
      costUsdMicros: 30_000,
    });
    expect(result.currentMonth.byPurpose.verification).toEqual({
      segments: 1,
      costUsdMicros: 10_000,
    });

    expect(result.previousMonth.segments).toBe(3);
    expect(result.previousMonth.costUsdMicros).toBe(30_000);
    expect(result.truncated).toBe(false);
  });

  test("per-chapter breakdown groups the current month's sent spend by chapter, 'central' included", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: SUPERUSER_EMAIL, chapterName: "New York" });
    const s2 = await run(t, async (ctx) => {
      return ctx.db.insert("chapters", {
        name: "Austin",
        isActive: true,
        createdAt: Date.now(),
      });
    });

    await insertUsageRow(s, { chapterId: s.chapterId, costUsdMicros: 10_000 });
    await insertUsageRow(s, { chapterId: s.chapterId, costUsdMicros: 5_000 });
    await insertUsageRow(s, { chapterId: s2 as Id<"chapters">, costUsdMicros: 20_000 });
    await insertUsageRow(s, { chapterId: "central", costUsdMicros: 1_000 });
    // A failed/opted_out row must not appear in any chapter's total.
    await insertUsageRow(s, { chapterId: s.chapterId, costUsdMicros: 0, outcome: "failed" });

    const result = (await s.as.query(api.smsUsage.getSmsSpendSummary, {}))!;
    const byId = new Map(result.byChapter.map((c) => [c.chapterId, c]));

    expect(byId.get(s.chapterId)).toMatchObject({
      chapterName: "New York",
      costUsdMicros: 15_000,
    });
    expect(byId.get(s2 as Id<"chapters">)).toMatchObject({
      chapterName: "Austin",
      costUsdMicros: 20_000,
    });
    expect(byId.get("central")).toMatchObject({
      chapterName: "Central",
      costUsdMicros: 1_000,
    });
    // Sorted by cost, highest first.
    expect(result.byChapter[0].chapterId).toBe(s2);
  });
});
