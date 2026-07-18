/// <reference types="vite/client" />
import { afterEach, describe, expect, test, vi } from "vitest";
import { newT, run, setupChapter, storeBlob, type ChapterSetup } from "./setup.helpers";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { CENTRAL } from "@events-os/shared";

/**
 * `dashboardCharts.ts` — DASH-1's `spendByMonth` (the chart/period filter)
 * and `chapterHealth` (the "Chapters at a glance" fleet panel).
 *
 * The PR #231 lesson applies here too: every number this file returns MUST
 * agree with the existing dashboard banners it sits next to
 * (`finances.dashboardCentral`, `finances.dashboardChapter`,
 * `dashboardDrill.pendingBudgetApprovals`) — see the "parity" describe block.
 */

async function seedSelfPerson(s: ChapterSetup): Promise<Id<"people">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Caller",
      userId: s.userId,
      isTeamMember: true,
      createdAt: Date.now(),
    }),
  );
}

/** A central-scope finance role at a chosen rank (mirrors dashboardDrill.test.ts). */
async function asCentral(
  s: ChapterSetup,
  role: "viewer" | "bookkeeper" | "manager",
): Promise<Id<"people">> {
  const personId = await seedSelfPerson(s);
  await run(s.t, (ctx) =>
    ctx.db.insert("financeRoles", {
      chapterId: s.chapterId,
      personId,
      role,
      scope: "central",
      createdAt: Date.now(),
    }),
  );
  return personId;
}

async function asChapterManager(s: ChapterSetup): Promise<Id<"people">> {
  const personId = await seedSelfPerson(s);
  await run(s.t, (ctx) =>
    ctx.db.insert("financeRoles", {
      chapterId: s.chapterId,
      personId,
      role: "manager",
      scope: "chapter",
      createdAt: Date.now(),
    }),
  );
  return personId;
}

async function makeChapter(s: ChapterSetup, name: string): Promise<Id<"chapters">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("chapters", { name, isActive: true, createdAt: Date.now() }),
  );
}

async function insertTxn(
  s: ChapterSetup,
  fields: {
    chapterId: Id<"chapters"> | typeof CENTRAL;
    amountCents: number;
    postedAt: number;
    flow?: "outflow" | "inflow" | "transfer";
    status?: "unreviewed" | "categorized" | "reconciled" | "excluded";
    budgetId?: Id<"budgets">;
    isPersonal?: boolean;
  },
): Promise<Id<"transactions">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("transactions", {
      chapterId: fields.chapterId,
      source: "manual",
      flow: fields.flow ?? "outflow",
      amountCents: fields.amountCents,
      postedAt: fields.postedAt,
      status: fields.status ?? "unreviewed",
      budgetId: fields.budgetId,
      isPersonal: fields.isPersonal,
      createdAt: Date.now(),
    }),
  );
}

async function insertBudget(
  s: ChapterSetup,
  fields: {
    chapterId: Id<"chapters"> | typeof CENTRAL;
    amountCents: number;
    year: number;
    cadence?: "monthly" | "quarterly" | "yearly" | "per_instance" | "one_off";
    month?: number;
    type?: "one_time" | "recurring";
    approvalStatus?: "draft" | "submitted" | "approved" | "changes_requested";
    submittedAt?: number;
    label?: string;
  },
): Promise<Id<"budgets">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("budgets", {
      chapterId: fields.chapterId,
      amountCents: fields.amountCents,
      cadence: fields.cadence ?? "monthly",
      year: fields.year,
      month: fields.month,
      type: fields.type,
      createdAt: Date.now(),
      approvalStatus: fields.approvalStatus,
      submittedAt: fields.submittedAt,
      label: fields.label,
    }),
  );
}

/** Noon-ish ET on the given (year, 1-based month, day). */
function tsInMonth(year: number, month: number, day = 15): number {
  return Date.UTC(year, month - 1, day, 17, 0, 0);
}

const NOW_2026_07_17 = Date.UTC(2026, 6, 17, 16, 0, 0); // Jul 17 2026, noon ET

function freezeNow(ts: number = NOW_2026_07_17): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(ts));
}

afterEach(() => {
  vi.useRealTimers();
});

// ── spendByMonth: authz ───────────────────────────────────────────────────────

describe("spendByMonth: authz", () => {
  test("a chapter-scoped manager (no central reach) can read their OWN chapter's chart", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s); // chapter-scoped, no central reach at all
    const res = await s.as.query(api.dashboardCharts.spendByMonth, {
      scope: s.chapterId,
      year: 2026,
    });
    expect(res.months).toHaveLength(12);
  });

  test("a plain chapter manager (no central reach) is REJECTED from a foreign chapter", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    const otherChapter = await makeChapter(s, "Austin");
    await expect(
      s.as.query(api.dashboardCharts.spendByMonth, { scope: otherChapter, year: 2026 }),
    ).rejects.toThrow();
  });

  test("a plain chapter manager (no central reach) is REJECTED from 'org'", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    await expect(
      s.as.query(api.dashboardCharts.spendByMonth, { scope: "org", year: 2026 }),
    ).rejects.toThrow();
  });

  test("a plain chapter manager (no central reach) is REJECTED from 'central'", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    await expect(
      s.as.query(api.dashboardCharts.spendByMonth, { scope: CENTRAL, year: 2026 }),
    ).rejects.toThrow();
  });

  test("a central-reach caller CAN read a foreign chapter, 'org', and 'central'", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentral(s, "viewer");
    const otherChapter = await makeChapter(s, "Austin");

    await expect(
      s.as.query(api.dashboardCharts.spendByMonth, { scope: otherChapter, year: 2026 }),
    ).resolves.toBeDefined();
    await expect(
      s.as.query(api.dashboardCharts.spendByMonth, { scope: "org", year: 2026 }),
    ).resolves.toBeDefined();
    await expect(
      s.as.query(api.dashboardCharts.spendByMonth, { scope: CENTRAL, year: 2026 }),
    ).resolves.toBeDefined();
  });
});

// ── spendByMonth: bucketing ───────────────────────────────────────────────────

describe("spendByMonth: month bucketing", () => {
  test("buckets a txn by its EASTERN month, not its UTC month (year-boundary case)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    // Jan 31 2026, 11:30pm ET == Feb 1 2026, 04:30 UTC (EST = UTC-5 in January).
    // A naive UTC bucketing would put this in February; Eastern bucketing
    // (the finance timezone) must put it in January.
    const boundaryTs = Date.UTC(2026, 1, 1, 4, 30, 0);
    await insertTxn(s, { chapterId: s.chapterId, amountCents: 5_000, postedAt: boundaryTs });

    const res = await s.as.query(api.dashboardCharts.spendByMonth, {
      scope: s.chapterId,
      year: 2026,
    });
    expect(res.months[0]).toEqual({ month: 1, spendCents: 5_000 }); // January
    expect(res.months[1]).toEqual({ month: 2, spendCents: 0 }); // February
  });

  test("excludes transfer, excluded-status, and personal txns from spend", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    const marchTs = tsInMonth(2026, 3);
    await insertTxn(s, { chapterId: s.chapterId, amountCents: 10_000, postedAt: marchTs }); // real spend
    await insertTxn(s, {
      chapterId: s.chapterId,
      amountCents: 20_000,
      postedAt: marchTs,
      flow: "transfer",
    });
    await insertTxn(s, {
      chapterId: s.chapterId,
      amountCents: 30_000,
      postedAt: marchTs,
      status: "excluded",
    });
    await insertTxn(s, {
      chapterId: s.chapterId,
      amountCents: 40_000,
      postedAt: marchTs,
      isPersonal: true,
    });
    // An inflow (refund) must not count as spend either.
    await insertTxn(s, {
      chapterId: s.chapterId,
      amountCents: 50_000,
      postedAt: marchTs,
      flow: "inflow",
    });

    const res = await s.as.query(api.dashboardCharts.spendByMonth, {
      scope: s.chapterId,
      year: 2026,
    });
    expect(res.months[2]).toEqual({ month: 3, spendCents: 10_000 }); // March, only the real spend
  });

  test("'central' scope counts ONLY central-owned txns, not chapter spend linked to a central budget", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentral(s, "manager");
    const marchTs = tsInMonth(2026, 3);
    const centralBudgetId = await insertBudget(s, {
      chapterId: CENTRAL,
      amountCents: 100_000,
      year: 2026,
    });
    await insertTxn(s, { chapterId: CENTRAL, amountCents: 7_000, postedAt: marchTs }); // central-owned
    await insertTxn(s, {
      chapterId: s.chapterId,
      amountCents: 3_000,
      postedAt: marchTs,
      budgetId: centralBudgetId,
    }); // chapter spend linked to a central budget

    const centralRes = await s.as.query(api.dashboardCharts.spendByMonth, {
      scope: CENTRAL,
      year: 2026,
    });
    expect(centralRes.months[2].spendCents).toBe(7_000);

    const chapterRes = await s.as.query(api.dashboardCharts.spendByMonth, {
      scope: s.chapterId,
      year: 2026,
    });
    expect(chapterRes.months[2].spendCents).toBe(3_000);

    // "org" = every chapter's FULL spend + central-owned spend = 10,000.
    const orgRes = await s.as.query(api.dashboardCharts.spendByMonth, {
      scope: "org",
      year: 2026,
    });
    expect(orgRes.months[2].spendCents).toBe(10_000);
  });
});

// ── spendByMonth: partialMonth ────────────────────────────────────────────────

describe("spendByMonth: partialMonth", () => {
  test("reports the current month for the current year, null otherwise", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    freezeNow(); // Jul 17 2026

    const currentYear = await s.as.query(api.dashboardCharts.spendByMonth, {
      scope: s.chapterId,
      year: 2026,
    });
    expect(currentYear.partialMonth).toBe(7);

    const pastYear = await s.as.query(api.dashboardCharts.spendByMonth, {
      scope: s.chapterId,
      year: 2025,
    });
    expect(pastYear.partialMonth).toBeNull();
  });
});

// ── spendByMonth: canRecordTransactions (review finding #3) ──────────────────
// `TransactionDetailModal` gates its edit controls on this field, not just
// peek — a chapter finance VIEWER (below bookkeeper) reaches their own
// chapter's dashboard fine (`dashboardChapter` only requires `viewer`), but
// every reconcile mutation the modal fires requires `bookkeeper`+ and would
// throw. See `dashboardCharts.spendByMonth`'s own doc for the field.
describe("spendByMonth: canRecordTransactions (review finding #3)", () => {
  test("a chapter VIEWER (below bookkeeper) on their OWN chapter gets `canRecordTransactions: false`", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await run(s.t, (ctx) =>
      ctx.db.insert("financeRoles", {
        chapterId: s.chapterId,
        personId,
        role: "viewer",
        scope: "chapter",
        createdAt: Date.now(),
      }),
    );

    const res = await s.as.query(api.dashboardCharts.spendByMonth, {
      scope: s.chapterId,
      year: 2026,
    });
    expect(res.canRecordTransactions).toBe(false);
  });

  test("a chapter BOOKKEEPER on their OWN chapter gets `canRecordTransactions: true`", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await run(s.t, (ctx) =>
      ctx.db.insert("financeRoles", {
        chapterId: s.chapterId,
        personId,
        role: "bookkeeper",
        scope: "chapter",
        createdAt: Date.now(),
      }),
    );

    const res = await s.as.query(api.dashboardCharts.spendByMonth, {
      scope: s.chapterId,
      year: 2026,
    });
    expect(res.canRecordTransactions).toBe(true);
  });

  test("a chapter MANAGER on their OWN chapter gets `canRecordTransactions: true`", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);

    const res = await s.as.query(api.dashboardCharts.spendByMonth, {
      scope: s.chapterId,
      year: 2026,
    });
    expect(res.canRecordTransactions).toBe(true);
  });

  test("`canRecordTransactions` is FALSE for a foreign chapter / 'org' / 'central' — writes always resolve to the caller's OWN chapter, so a peek/drill-down scope never grants it even for a central manager", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentral(s, "manager");
    const otherChapter = await makeChapter(s, "Austin");

    const foreign = await s.as.query(api.dashboardCharts.spendByMonth, {
      scope: otherChapter,
      year: 2026,
    });
    expect(foreign.canRecordTransactions).toBe(false);

    const org = await s.as.query(api.dashboardCharts.spendByMonth, { scope: "org", year: 2026 });
    expect(org.canRecordTransactions).toBe(false);

    const central = await s.as.query(api.dashboardCharts.spendByMonth, {
      scope: CENTRAL,
      year: 2026,
    });
    expect(central.canRecordTransactions).toBe(false);
  });
});

// ── chapterHealth: authz ──────────────────────────────────────────────────────

describe("chapterHealth: authz", () => {
  test("a plain chapter manager (no central reach) is REJECTED", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    await expect(s.as.query(api.dashboardCharts.chapterHealth, {})).rejects.toThrow();
  });

  test("a central-reach caller CAN read the fleet panel", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentral(s, "viewer");
    const rows = await s.as.query(api.dashboardCharts.chapterHealth, {});
    expect(Array.isArray(rows)).toBe(true);
    // Central row + the caller's own chapter row.
    expect(rows.some((r) => r.chapterId === CENTRAL)).toBe(true);
    expect(rows.some((r) => r.chapterId === s.chapterId)).toBe(true);
  });
});

// ── chapterHealth: affordability fields ───────────────────────────────────────

describe("chapterHealth: affordability", () => {
  test("backers/tierLabel/underWaterCents are null when backerCount is absent or 0", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentral(s, "viewer");
    const rows = await s.as.query(api.dashboardCharts.chapterHealth, {});
    const own = rows.find((r) => r.chapterId === s.chapterId)!;
    expect(own.backers).toBeNull();
    expect(own.tierLabel).toBeNull();
    expect(own.underWaterCents).toBeNull();
  });

  test("the central row never carries affordability fields", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentral(s, "viewer");
    const rows = await s.as.query(api.dashboardCharts.chapterHealth, {});
    const central = rows.find((r) => r.chapterId === CENTRAL)!;
    expect(central.backers).toBeNull();
    expect(central.tierLabel).toBeNull();
    expect(central.underWaterCents).toBeNull();
  });

  test("a configured backerCount computes tier + under-water from the SAME shared formula", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentral(s, "viewer");
    // 10 backers => $500/mo revenue, well under the fixed $520 operating floor
    // alone (before even the per-teammate add-on or the skim) — guaranteed
    // under water with zero teammates.
    await run(s.t, (ctx) => ctx.db.patch(s.chapterId, { backerCount: 10 }));

    const rows = await s.as.query(api.dashboardCharts.chapterHealth, {});
    const own = rows.find((r) => r.chapterId === s.chapterId)!;
    expect(own.backers).toBe(10);
    expect(own.tierLabel).toBe("Pre-tier"); // below the lowest (20-backer) tier
    expect(own.underWaterCents).toBeGreaterThan(0);
  });
});

// ── chapterHealth: monthlySpendCents must partition the SAME way as spendYtdCents ──

describe("chapterHealth: monthlySpendCents partitions like spendYtdCents", () => {
  test("chapter spend linked to a central budget lands in the CENTRAL row's sparkline, not the chapter's own", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentral(s, "manager");
    const centralBudgetId = await insertBudget(s, {
      chapterId: CENTRAL,
      amountCents: 100_000,
      year: 2026,
    });

    freezeNow(); // Jul 17 2026 -> throughMonth = 7, year = 2026

    // Every txn below falls within Jan..throughMonth (2026), so a row's
    // full-12-month sparkline sum is directly comparable to its YTD headline.
    await insertTxn(s, { chapterId: s.chapterId, amountCents: 10_000, postedAt: tsInMonth(2026, 3) }); // chapter's own
    await insertTxn(s, {
      chapterId: s.chapterId,
      amountCents: 6_000,
      postedAt: tsInMonth(2026, 5),
      budgetId: centralBudgetId, // chapter spend explicitly linked to central
    });
    await insertTxn(s, { chapterId: CENTRAL, amountCents: 3_000, postedAt: tsInMonth(2026, 2) }); // central-owned

    const rows = await s.as.query(api.dashboardCharts.chapterHealth, {});
    const sum = (arr: number[]) => arr.reduce((a, b) => a + b, 0);
    const chapterRow = rows.find((r) => r.chapterId === s.chapterId)!;
    const centralRow = rows.find((r) => r.chapterId === CENTRAL)!;

    // The headline numbers themselves (the partition dashboardCentral uses).
    expect(chapterRow.spendYtdCents).toBe(10_000);
    expect(centralRow.spendYtdCents).toBe(3_000 + 6_000);

    // The sparkline must sum to EXACTLY the same partition, not the chapter's
    // FULL spend (which would wrongly include the linked $6,000).
    expect(sum(chapterRow.monthlySpendCents)).toBe(chapterRow.spendYtdCents);
    expect(sum(centralRow.monthlySpendCents)).toBe(centralRow.spendYtdCents);

    // And the linked $6,000 shows up in central's MAY bucket, not chapter's.
    expect(chapterRow.monthlySpendCents[4]).toBe(0); // May, chapter row
    expect(centralRow.monthlySpendCents[4]).toBe(6_000); // May, central row
    expect(centralRow.monthlySpendCents[1]).toBe(3_000); // Feb, central-owned
  });
});

// ── PARITY: numbers must agree with the dashboards they sit next to ──────────

describe("parity with dashboardCentral / dashboardChapter / dashboardDrill", () => {
  test("(a) sum of spendByMonth('org') Jan..throughMonth == dashboardCentral's YTD totalMonthSpendCents", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentral(s, "manager");
    const otherChapter = await makeChapter(s, "Austin");
    const centralBudgetId = await insertBudget(s, {
      chapterId: CENTRAL,
      amountCents: 500_000,
      year: 2026,
    });

    await insertTxn(s, { chapterId: s.chapterId, amountCents: 12_000, postedAt: tsInMonth(2026, 1) });
    await insertTxn(s, { chapterId: s.chapterId, amountCents: 8_000, postedAt: tsInMonth(2026, 3) });
    await insertTxn(s, {
      chapterId: s.chapterId,
      amountCents: 4_000,
      postedAt: tsInMonth(2026, 3),
      budgetId: centralBudgetId, // chapter spend linked to a central budget
    });
    await insertTxn(s, { chapterId: otherChapter, amountCents: 6_000, postedAt: tsInMonth(2026, 2) });
    await insertTxn(s, { chapterId: CENTRAL, amountCents: 3_000, postedAt: tsInMonth(2026, 3) });
    // Outside the through-month window (April) — must not count toward March YTD.
    await insertTxn(s, { chapterId: s.chapterId, amountCents: 99_000, postedAt: tsInMonth(2026, 4) });

    const orgRes = await s.as.query(api.dashboardCharts.spendByMonth, {
      scope: "org",
      year: 2026,
    });
    const throughMonth = 3;
    const summed = orgRes.months
      .filter((m) => m.month <= throughMonth)
      .reduce((sum, m) => sum + m.spendCents, 0);

    const centralDash = await s.as.query(api.finances.dashboardCentral, {
      year: 2026,
      month: throughMonth,
      period: "ytd",
    });
    expect(summed).toBe(centralDash.totalMonthSpendCents);
    expect(summed).toBe(12_000 + 8_000 + 4_000 + 6_000 + 3_000);
  });

  test("(a2) sum of spendByMonth(chapterId) Jan..throughMonth == dashboardChapter's YTD Spent tile", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    await insertTxn(s, { chapterId: s.chapterId, amountCents: 15_000, postedAt: tsInMonth(2026, 1) });
    await insertTxn(s, { chapterId: s.chapterId, amountCents: 25_000, postedAt: tsInMonth(2026, 2) });
    await insertTxn(s, { chapterId: s.chapterId, amountCents: 99_000, postedAt: tsInMonth(2026, 5) }); // outside window

    const chartRes = await s.as.query(api.dashboardCharts.spendByMonth, {
      scope: s.chapterId,
      year: 2026,
    });
    const throughMonth = 2;
    const summed = chartRes.months
      .filter((m) => m.month <= throughMonth)
      .reduce((sum, m) => sum + m.spendCents, 0);

    const chapterDash = await s.as.query(api.finances.dashboardChapter, {
      year: 2026,
      month: throughMonth,
      period: "ytd",
    });
    expect(summed).toBe(chapterDash.tiles[0].subValueCents);
    expect(summed).toBe(40_000);
  });

  test("(b) chapterHealth row's spendYtd/budgetYtd == dashboardCentral's by-chapter rollup row (chapter AND central)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentral(s, "manager");
    const otherChapter = await makeChapter(s, "Austin");

    freezeNow(); // Jul 17 2026 -> throughMonth = 7, year = 2026

    // Chapter budgets: a recurring MONTHLY budget (accumulates across
    // months) + a recurring QUARTERLY budget (review fix: exercises the
    // `monthEquivalentBudgetCentsLocal` quarterly branch, `capCents / 3`).
    await insertBudget(s, { chapterId: s.chapterId, amountCents: 10_000, year: 2026, cadence: "monthly" });
    await insertBudget(s, { chapterId: s.chapterId, amountCents: 9_000, year: 2026, cadence: "quarterly" });
    await insertBudget(s, { chapterId: otherChapter, amountCents: 5_000, year: 2026, cadence: "monthly" });
    // Central budgets: a recurring monthly budget, PLUS a ONE_TIME central
    // budget (review fix: exercises the central-budget-CARD branch —
    // `effectiveCapCents` counted in full, never month-scaled) that is also
    // GRANDFATHERED (no `approvalStatus` — review fix: exercises
    // `effectiveCapCents`'s "absent status falls back to `amountCents`"
    // branch, same as every other budget in this fixture, none of which sets
    // `approvalStatus`).
    await insertBudget(s, { chapterId: CENTRAL, amountCents: 60_000, year: 2026, cadence: "monthly" });
    const oneTimeCentralBudgetId = await insertBudget(s, {
      chapterId: CENTRAL,
      amountCents: 25_000,
      year: 2026,
      cadence: "one_off",
      type: "one_time",
    });

    await insertTxn(s, { chapterId: s.chapterId, amountCents: 12_000, postedAt: tsInMonth(2026, 3) });
    // Chapter spend explicitly linked to a CENTRAL budget (review fix: the
    // partition every number in this file must apply consistently) — must
    // count toward the CENTRAL row's spend, not the chapter's own.
    await insertTxn(s, {
      chapterId: s.chapterId,
      amountCents: 5_000,
      postedAt: tsInMonth(2026, 4),
      budgetId: oneTimeCentralBudgetId,
    });
    await insertTxn(s, { chapterId: otherChapter, amountCents: 4_000, postedAt: tsInMonth(2026, 5) });
    await insertTxn(s, { chapterId: CENTRAL, amountCents: 7_000, postedAt: tsInMonth(2026, 2) });
    // Some spend against the one_time central budget itself too, so its
    // `effectiveCapCents` contribution isn't a zero-spend straggler either
    // way (doesn't change the assertion, just exercises the realistic case).
    await insertTxn(s, {
      chapterId: CENTRAL,
      amountCents: 1_000,
      postedAt: tsInMonth(2026, 6),
      budgetId: oneTimeCentralBudgetId,
    });

    const [healthRows, centralDash] = await Promise.all([
      s.as.query(api.dashboardCharts.chapterHealth, {}),
      s.as.query(api.finances.dashboardCentral, { period: "ytd" }),
    ]);

    for (const rollupRow of centralDash.chapterRollup) {
      const healthRow = healthRows.find((r) => r.chapterId === rollupRow.chapterId);
      expect(healthRow).toBeDefined();
      expect(healthRow!.spendYtdCents).toBe(rollupRow.spentCents);
      expect(healthRow!.budgetYtdCents).toBe(rollupRow.budgetCents);
    }
    // Sanity: every dashboardCentral rollup row was actually checked (no
    // silent no-op if the rollup came back empty), AND the partition was
    // actually exercised (the chapter-linked-to-central txn moved real money
    // out of the chapter row and into the central row — this would have
    // caught the review-fix bug where `spendYtdCents` and `budgetYtdCents`
    // matched by coincidence on an unpartitioned fixture).
    expect(centralDash.chapterRollup.length).toBeGreaterThanOrEqual(3); // central + 2 chapters
    const chapterRow = healthRows.find((r) => r.chapterId === s.chapterId)!;
    const centralRow = healthRows.find((r) => r.chapterId === CENTRAL)!;
    expect(chapterRow.spendYtdCents).toBe(12_000); // excludes the linked $5,000
    expect(centralRow.spendYtdCents).toBe(7_000 + 1_000 + 5_000); // central-owned + linked
  });

  test("(c) chapterHealth's pendingApprovalsCount == dashboardDrill.pendingBudgetApprovals count per chapter", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentral(s, "viewer");
    const otherChapter = await makeChapter(s, "Austin");

    await insertBudget(s, {
      chapterId: s.chapterId,
      amountCents: 1_000,
      year: 2026,
      approvalStatus: "submitted",
      submittedAt: 100,
    });
    await insertBudget(s, {
      chapterId: s.chapterId,
      amountCents: 1_000,
      year: 2026,
      approvalStatus: "submitted",
      submittedAt: 200,
    });
    await insertBudget(s, {
      chapterId: otherChapter,
      amountCents: 1_000,
      year: 2026,
      approvalStatus: "submitted",
      submittedAt: 300,
    });
    await insertBudget(s, {
      chapterId: CENTRAL,
      amountCents: 1_000,
      year: 2026,
      approvalStatus: "submitted",
      submittedAt: 400,
    });
    // Must NOT count: draft/approved.
    await insertBudget(s, { chapterId: s.chapterId, amountCents: 1_000, year: 2026, approvalStatus: "draft" });

    const [healthRows, pendingRows] = await Promise.all([
      s.as.query(api.dashboardCharts.chapterHealth, {}),
      s.as.query(api.dashboardDrill.pendingBudgetApprovals, {}),
    ]);

    const countByChapter = new Map<string, number>();
    for (const row of pendingRows) {
      countByChapter.set(row.chapterId, (countByChapter.get(row.chapterId) ?? 0) + 1);
    }

    for (const healthRow of healthRows) {
      expect(healthRow.pendingApprovalsCount).toBe(countByChapter.get(healthRow.chapterId) ?? 0);
    }
    expect(healthRows.find((r) => r.chapterId === s.chapterId)!.pendingApprovalsCount).toBe(2);
    expect(healthRows.find((r) => r.chapterId === otherChapter)!.pendingApprovalsCount).toBe(1);
    expect(healthRows.find((r) => r.chapterId === CENTRAL)!.pendingApprovalsCount).toBe(1);
  });

  test("(d) DASH-2.1 bug 2 — chapterHealth's cadence-aware YTD denominator (`ytdCadenceAllocationCentsLocal`) matches dashboardCentral's own (`ytdCadenceAllocationCents` in finances.ts), pinned to exact values so the two implementations can't silently drift", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentral(s, "manager");

    freezeNow(Date.UTC(2026, 4, 17, 16, 0, 0)); // May 17 2026 -> throughMonth = 5

    // Yearly: full cap regardless of elapsed months (owner bug — was
    // prorated cap/12 × monthsElapsed).
    await insertBudget(s, {
      chapterId: s.chapterId,
      amountCents: 100_000,
      year: 2026,
      cadence: "yearly",
    });
    // Quarterly, no fixed quarter: cap × quarters elapsed. By May, Q1 is
    // complete and Q2 has started -> 2 quarters -> 9,000 × 2 = 18,000 (the
    // OLD per-month sum would have given 9,000/3 × 5 = 15,000).
    await insertBudget(s, {
      chapterId: s.chapterId,
      amountCents: 9_000,
      year: 2026,
      cadence: "quarterly",
    });

    const [healthRows, chapterDash] = await Promise.all([
      s.as.query(api.dashboardCharts.chapterHealth, {}),
      s.as.query(api.finances.dashboardChapter, { year: 2026, month: 5, period: "ytd" }),
    ]);

    const healthRow = healthRows.find((r) => r.chapterId === s.chapterId)!;
    // dashboardChapter's own recurring cards use the exact same
    // `monthEquivForDash`/`ytdCadenceAllocationCents` finances.ts pair.
    const yearlyCard = chapterDash.recurringBudgets.find((r) => r.cadence === "yearly")!;
    const quarterlyCard = chapterDash.recurringBudgets.find((r) => r.cadence === "quarterly")!;
    expect(yearlyCard.budgetCents).toBe(100_000);
    expect(quarterlyCard.budgetCents).toBe(18_000);

    // The by-chapter rollup (`chapterHealth.budgetYtdCents`, backed by the
    // LOCAL duplicate) sums EVERY chapter budget's YTD allocation -> the two
    // cards above, added together.
    expect(healthRow.budgetYtdCents).toBe(yearlyCard.budgetCents + quarterlyCard.budgetCents);
    expect(healthRow.budgetYtdCents).toBe(118_000);
  });
});

// ── budgetTransactions (DASH-2.1 bug 3) ───────────────────────────────────────

async function insertFund(s: ChapterSetup, chapterId: Id<"chapters">): Promise<Id<"funds">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("funds", {
      chapterId,
      name: "General",
      restriction: "unrestricted",
      sortOrder: 0,
      createdAt: Date.now(),
    }),
  );
}

async function insertCategory(
  s: ChapterSetup,
  chapterId: Id<"chapters">,
  fundId: Id<"funds">,
  name: string,
): Promise<Id<"budgetCategories">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("budgetCategories", {
      chapterId,
      fundId,
      name,
      kind: "lineItem",
      createdAt: Date.now(),
    }),
  );
}

async function insertPerson(
  s: ChapterSetup,
  chapterId: Id<"chapters">,
  name: string,
): Promise<Id<"people">> {
  return run(s.t, (ctx) => ctx.db.insert("people", { chapterId, name, createdAt: Date.now() }));
}

async function insertCard(
  s: ChapterSetup,
  chapterId: Id<"chapters">,
  cardholderPersonId: Id<"people">,
): Promise<Id<"cards">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("cards", {
      chapterId,
      cardholderPersonId,
      type: "virtual",
      status: "active",
      createdAt: Date.now(),
    }),
  );
}

describe("budgetTransactions", () => {
  test("filters to the budget + period + category, sorted newest-first", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    const budgetId = await insertBudget(s, {
      chapterId: s.chapterId,
      amountCents: 100_000,
      year: 2026,
      cadence: "yearly",
    });
    const fundId = await insertFund(s, s.chapterId);
    const catA = await insertCategory(s, s.chapterId, fundId, "Parts");
    const catB = await insertCategory(s, s.chapterId, fundId, "Labor");

    // In period + category A.
    const inPeriodA1 = await insertTxn(s, {
      chapterId: s.chapterId,
      amountCents: 3_000,
      postedAt: tsInMonth(2026, 3, 10),
      budgetId,
    });
    await run(s.t, (ctx) => ctx.db.patch(inPeriodA1, { categoryId: catA, status: "categorized" }));
    const inPeriodA2 = await insertTxn(s, {
      chapterId: s.chapterId,
      amountCents: 5_000,
      postedAt: tsInMonth(2026, 3, 20),
      budgetId,
    });
    await run(s.t, (ctx) => ctx.db.patch(inPeriodA2, { categoryId: catA, status: "categorized" }));
    // In period, different category — must be excluded by the categoryId filter.
    const inPeriodB = await insertTxn(s, {
      chapterId: s.chapterId,
      amountCents: 9_000,
      postedAt: tsInMonth(2026, 3, 15),
      budgetId,
    });
    await run(s.t, (ctx) => ctx.db.patch(inPeriodB, { categoryId: catB, status: "categorized" }));
    // Outside the period (April, category A) — must be excluded by the month filter.
    const outsidePeriod = await insertTxn(s, {
      chapterId: s.chapterId,
      amountCents: 7_000,
      postedAt: tsInMonth(2026, 4, 1),
      budgetId,
    });
    await run(s.t, (ctx) => ctx.db.patch(outsidePeriod, { categoryId: catA }));
    // Linked to the budget but NOT spend (a transfer leg) — must be excluded.
    await insertTxn(s, {
      chapterId: s.chapterId,
      amountCents: 99_000,
      postedAt: tsInMonth(2026, 3, 12),
      budgetId,
      flow: "transfer",
    });

    const res = await s.as.query(api.dashboardCharts.budgetTransactions, {
      budgetId,
      categoryId: catA,
      year: 2026,
      month: 3,
    });
    expect(res.totalCount).toBe(2);
    expect(res.rows.map((r) => r.id)).toEqual([inPeriodA2, inPeriodA1]); // newest first
    expect(res.rows.every((r) => r.categoryName === "Parts")).toBe(true);
  });

  test("'uncategorized' sentinel matches only rows with no categoryId", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    const budgetId = await insertBudget(s, {
      chapterId: s.chapterId,
      amountCents: 10_000,
      year: 2026,
    });
    const fundId = await insertFund(s, s.chapterId);
    const catA = await insertCategory(s, s.chapterId, fundId, "Parts");

    const uncategorizedTxn = await insertTxn(s, {
      chapterId: s.chapterId,
      amountCents: 1_000,
      postedAt: tsInMonth(2026, 6),
      budgetId,
    });
    const categorizedTxn = await insertTxn(s, {
      chapterId: s.chapterId,
      amountCents: 2_000,
      postedAt: tsInMonth(2026, 6),
      budgetId,
    });
    await run(s.t, (ctx) => ctx.db.patch(categorizedTxn, { categoryId: catA }));

    const res = await s.as.query(api.dashboardCharts.budgetTransactions, {
      budgetId,
      categoryId: "uncategorized",
      year: 2026,
      month: 6,
    });
    expect(res.rows.map((r) => r.id)).toEqual([uncategorizedTxn]);

    // No categoryId arg at all -> every row in the period, uncategorized AND categorized.
    const allRes = await s.as.query(api.dashboardCharts.budgetTransactions, {
      budgetId,
      year: 2026,
      month: 6,
    });
    expect(allRes.totalCount).toBe(2);
  });

  test("caps rows at 200 but reports the true totalCount", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    const budgetId = await insertBudget(s, {
      chapterId: s.chapterId,
      amountCents: 10_000_000,
      year: 2026,
      cadence: "yearly",
    });
    for (let i = 0; i < 210; i++) {
      await insertTxn(s, {
        chapterId: s.chapterId,
        amountCents: 100,
        postedAt: tsInMonth(2026, 1, 1) + i * 60_000,
        budgetId,
      });
    }
    const res = await s.as.query(api.dashboardCharts.budgetTransactions, {
      budgetId,
      year: 2026,
    });
    expect(res.rows).toHaveLength(200);
    expect(res.totalCount).toBe(210);
  });

  test("resolves receipt presence, category name, and person name (direct + card-cardholder fallback)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    const budgetId = await insertBudget(s, {
      chapterId: s.chapterId,
      amountCents: 10_000,
      year: 2026,
    });
    const fundId = await insertFund(s, s.chapterId);
    const catA = await insertCategory(s, s.chapterId, fundId, "Parts");
    const directPerson = await insertPerson(s, s.chapterId, "Direct Spender");
    const cardholder = await insertPerson(s, s.chapterId, "Cardholder Spender");
    const cardId = await insertCard(s, s.chapterId, cardholder);
    const storageId = await storeBlob(s.t);

    // Direct personId, WITH a receipt.
    const directTxnId = await insertTxn(s, {
      chapterId: s.chapterId,
      amountCents: 1_500,
      postedAt: tsInMonth(2026, 2),
      budgetId,
    });
    await run(s.t, (ctx) =>
      ctx.db.patch(directTxnId, {
        categoryId: catA,
        personId: directPerson,
        receiptStorageId: storageId,
        note: "Reimbursed via check",
      }),
    );
    // Card-only (no personId) — must resolve to the cardholder, NO receipt.
    const cardTxnId = await insertTxn(s, {
      chapterId: s.chapterId,
      amountCents: 2_500,
      postedAt: tsInMonth(2026, 2),
      budgetId,
    });
    await run(s.t, (ctx) => ctx.db.patch(cardTxnId, { cardId }));

    const res = await s.as.query(api.dashboardCharts.budgetTransactions, {
      budgetId,
      year: 2026,
      month: 2,
    });
    const directRow = res.rows.find((r) => r.id === directTxnId)!;
    const cardRow = res.rows.find((r) => r.id === cardTxnId)!;

    expect(directRow.personId).toBe(directPerson);
    expect(directRow.personName).toBe("Direct Spender");
    expect(directRow.categoryName).toBe("Parts");
    expect(directRow.hasReceipt).toBe(true);
    expect(directRow.note).toBe("Reimbursed via check");

    expect(cardRow.personId).toBe(cardholder);
    expect(cardRow.personName).toBe("Cardholder Spender");
    expect(cardRow.hasReceipt).toBe(false);
    expect(cardRow.categoryName).toBeNull();
  });

  test("authz: a plain chapter manager (no central reach) is REJECTED from a foreign chapter's budget", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    const otherChapter = await makeChapter(s, "Austin");
    const foreignBudgetId = await insertBudget(s, {
      chapterId: otherChapter,
      amountCents: 10_000,
      year: 2026,
    });

    await expect(
      s.as.query(api.dashboardCharts.budgetTransactions, {
        budgetId: foreignBudgetId,
        year: 2026,
      }),
    ).rejects.toThrow();
  });

  test("authz: a plain chapter manager (no central reach) is REJECTED from a CENTRAL budget", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    const centralBudgetId = await insertBudget(s, {
      chapterId: CENTRAL,
      amountCents: 10_000,
      year: 2026,
    });

    await expect(
      s.as.query(api.dashboardCharts.budgetTransactions, {
        budgetId: centralBudgetId,
        year: 2026,
      }),
    ).rejects.toThrow();
  });

  test("authz: a central-reach caller CAN read a foreign chapter's budget AND a CENTRAL budget", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentral(s, "viewer");
    const otherChapter = await makeChapter(s, "Austin");
    const foreignBudgetId = await insertBudget(s, {
      chapterId: otherChapter,
      amountCents: 10_000,
      year: 2026,
    });
    const centralBudgetId = await insertBudget(s, {
      chapterId: CENTRAL,
      amountCents: 10_000,
      year: 2026,
    });

    await expect(
      s.as.query(api.dashboardCharts.budgetTransactions, {
        budgetId: foreignBudgetId,
        year: 2026,
      }),
    ).resolves.toBeDefined();
    await expect(
      s.as.query(api.dashboardCharts.budgetTransactions, {
        budgetId: centralBudgetId,
        year: 2026,
      }),
    ).resolves.toBeDefined();
  });

  test("authz: a viewer role IS enough to read their own chapter's budget", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await run(s.t, (ctx) =>
      ctx.db.insert("financeRoles", {
        chapterId: s.chapterId,
        personId,
        role: "viewer",
        scope: "chapter",
        createdAt: Date.now(),
      }),
    );
    const budgetId = await insertBudget(s, {
      chapterId: s.chapterId,
      amountCents: 10_000,
      year: 2026,
    });

    await expect(
      s.as.query(api.dashboardCharts.budgetTransactions, { budgetId, year: 2026 }),
    ).resolves.toBeDefined();
  });

  test("throws NOT_FOUND for a nonexistent budget", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    const budgetId = await insertBudget(s, {
      chapterId: s.chapterId,
      amountCents: 10_000,
      year: 2026,
    });
    // Delete it out from under the query.
    await run(s.t, (ctx) => ctx.db.delete(budgetId));

    await expect(
      s.as.query(api.dashboardCharts.budgetTransactions, { budgetId, year: 2026 }),
    ).rejects.toThrow();
  });
});

// ── budgetTransactions: `quarter` widening (review finding #1) ───────────────
// A quarterly-cadence budget's category mini-bar widens to the WHOLE quarter
// in month mode (`finances.ts#budgetEffectivePeriod`, via
// `txnCountsTowardBudgetDash`) — the drill-down must be able to request that
// SAME widened period, or it silently under-sums vs. the bar it drilled into
// (the exact owner-reported bug the PR #252 review flagged).
describe("budgetTransactions: quarter widening (review finding #1)", () => {
  test("`quarter` widens the period filter to the whole quarter, not just one month", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    const budgetId = await insertBudget(s, {
      chapterId: s.chapterId,
      amountCents: 90_000,
      year: 2026,
      cadence: "quarterly",
    });
    // Q1 = Jan..Mar.
    const jan = await insertTxn(s, {
      chapterId: s.chapterId,
      amountCents: 1_000,
      postedAt: tsInMonth(2026, 1),
      budgetId,
    });
    const feb = await insertTxn(s, {
      chapterId: s.chapterId,
      amountCents: 2_000,
      postedAt: tsInMonth(2026, 2),
      budgetId,
    });
    const mar = await insertTxn(s, {
      chapterId: s.chapterId,
      amountCents: 3_000,
      postedAt: tsInMonth(2026, 3),
      budgetId,
    });
    // Q2 — must be excluded by `quarter: 1`.
    await insertTxn(s, {
      chapterId: s.chapterId,
      amountCents: 9_000,
      postedAt: tsInMonth(2026, 4),
      budgetId,
    });

    const res = await s.as.query(api.dashboardCharts.budgetTransactions, {
      budgetId,
      year: 2026,
      quarter: 1,
    });
    expect(res.rows.map((r) => r.id).sort()).toEqual([jan, feb, mar].sort());
    expect(res.rows.reduce((sum, r) => sum + r.amountCents, 0)).toBe(6_000);
  });

  test("a quarterly recurring budget's category mini-bar (dashboardChapter, month mode) equals the drill-down's total when the drill-down requests the SAME widened quarter — parity", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    const budgetId = await insertBudget(s, {
      chapterId: s.chapterId,
      amountCents: 90_000,
      year: 2026,
      cadence: "quarterly",
      label: "Travel",
    });
    const fundId = await insertFund(s, s.chapterId);
    const catA = await insertCategory(s, s.chapterId, fundId, "Flights");

    for (const [txnMonth, cents] of [
      [1, 1_000],
      [2, 2_000],
      [3, 3_000],
    ] as const) {
      const txnId = await insertTxn(s, {
        chapterId: s.chapterId,
        amountCents: cents,
        postedAt: tsInMonth(2026, txnMonth),
        budgetId,
      });
      await run(s.t, (ctx) => ctx.db.patch(txnId, { categoryId: catA, status: "categorized" }));
    }

    // Viewing FEBRUARY in month mode — a quarterly budget's own bar widens to
    // the whole quarter (Q1) regardless of the single selected month.
    const chapterDash = await s.as.query(api.finances.dashboardChapter, {
      year: 2026,
      month: 2,
      period: "month",
    });
    const row = chapterDash.recurringBudgets.find((r) => r.id === budgetId)!;
    const categoryBar = row.categories!.find((c) => c.name === "Flights")!;
    expect(categoryBar.spentCents).toBe(6_000); // Jan+Feb+Mar, not just Feb's 2,000

    // The drill-down, requesting the SAME widened quarter (Q1 — February is
    // in Q1) — must sum to EXACTLY the bar figure above.
    const drill = await s.as.query(api.dashboardCharts.budgetTransactions, {
      budgetId,
      categoryName: "Flights",
      year: 2026,
      quarter: 1,
    });
    expect(drill.rows).toHaveLength(3);
    expect(drill.rows.reduce((sum, r) => sum + r.amountCents, 0)).toBe(categoryBar.spentCents);

    // Sanity: the OLD single-month drill-down under-sums vs. the bar — the
    // exact bug review finding #1 flagged.
    const monthOnlyDrill = await s.as.query(api.dashboardCharts.budgetTransactions, {
      budgetId,
      categoryName: "Flights",
      year: 2026,
      month: 2,
    });
    expect(monthOnlyDrill.rows.reduce((sum, r) => sum + r.amountCents, 0)).toBe(2_000);
  });

  test("a yearly recurring budget's category mini-bar equals the drill-down's total when the drill-down requests year-only (no month/quarter)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    const budgetId = await insertBudget(s, {
      chapterId: s.chapterId,
      amountCents: 120_000,
      year: 2026,
      cadence: "yearly",
      label: "Insurance",
    });
    const fundId = await insertFund(s, s.chapterId);
    const catA = await insertCategory(s, s.chapterId, fundId, "Premiums");

    for (const [txnMonth, cents] of [
      [2, 5_000],
      [8, 7_000],
    ] as const) {
      const txnId = await insertTxn(s, {
        chapterId: s.chapterId,
        amountCents: cents,
        postedAt: tsInMonth(2026, txnMonth),
        budgetId,
      });
      await run(s.t, (ctx) => ctx.db.patch(txnId, { categoryId: catA, status: "categorized" }));
    }

    const chapterDash = await s.as.query(api.finances.dashboardChapter, {
      year: 2026,
      month: 2,
      period: "month",
    });
    const row = chapterDash.recurringBudgets.find((r) => r.id === budgetId)!;
    const categoryBar = row.categories!.find((c) => c.name === "Premiums")!;
    expect(categoryBar.spentCents).toBe(12_000); // both months, not just February's 5,000

    // Year-only (no `month`, no `quarter`) — the yearly-cadence widening.
    const drill = await s.as.query(api.dashboardCharts.budgetTransactions, {
      budgetId,
      categoryName: "Premiums",
      year: 2026,
    });
    expect(drill.rows).toHaveLength(2);
    expect(drill.rows.reduce((sum, r) => sum + r.amountCents, 0)).toBe(categoryBar.spentCents);
  });
});

// ── budgetTransactions: `categoryName` filter (review finding #2) ────────────
// The mini-bars group by category NAME (`finances.ts#spendBreakdownFor`), but
// categories are only unique PER FUND — two funds can each have a
// same-named category. The old client behavior (name -> id via a last-wins
// `Map`, then filtering by ONE `categoryId`) would silently drop the other
// fund's transactions from the drill-down.
describe("budgetTransactions: categoryName filter (review finding #2)", () => {
  test("categoryName matches every category sharing that name, across funds — the drill-down sums to the bar even with duplicate category names", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    const budgetId = await insertBudget(s, {
      chapterId: s.chapterId,
      amountCents: 50_000,
      year: 2026,
      cadence: "yearly",
    });
    const fundA = await insertFund(s, s.chapterId);
    const fundB = await run(s.t, (ctx) =>
      ctx.db.insert("funds", {
        chapterId: s.chapterId,
        name: "Building Fund",
        restriction: "unrestricted",
        sortOrder: 1,
        createdAt: Date.now(),
      }),
    );
    // Two DIFFERENT categories (different funds) that happen to share a name.
    const catA = await insertCategory(s, s.chapterId, fundA, "Supplies");
    const catB = await insertCategory(s, s.chapterId, fundB, "Supplies");
    expect(catA).not.toBe(catB);

    const txnA = await insertTxn(s, {
      chapterId: s.chapterId,
      amountCents: 1_000,
      postedAt: tsInMonth(2026, 5),
      budgetId,
    });
    await run(s.t, (ctx) => ctx.db.patch(txnA, { categoryId: catA, status: "categorized" }));
    const txnB = await insertTxn(s, {
      chapterId: s.chapterId,
      amountCents: 4_000,
      postedAt: tsInMonth(2026, 5),
      budgetId,
    });
    await run(s.t, (ctx) => ctx.db.patch(txnB, { categoryId: catB, status: "categorized" }));

    // The bar (`spendBreakdownFor` groups by NAME) sums BOTH categories.
    const chapterDash = await s.as.query(api.finances.dashboardChapter, {
      year: 2026,
      month: 5,
      period: "month",
    });
    const row = chapterDash.recurringBudgets.find((r) => r.id === budgetId)!;
    const categoryBar = row.categories!.find((c) => c.name === "Supplies")!;
    expect(categoryBar.spentCents).toBe(5_000);

    // `categoryName` (new) matches both — sums to EXACTLY the bar.
    const byName = await s.as.query(api.dashboardCharts.budgetTransactions, {
      budgetId,
      categoryName: "Supplies",
      year: 2026,
    });
    expect(byName.rows.map((r) => r.id).sort()).toEqual([txnA, txnB].sort());
    expect(byName.rows.reduce((sum, r) => sum + r.amountCents, 0)).toBe(categoryBar.spentCents);

    // Sanity: the OLD `categoryId`-only filter would have missed catB's txn —
    // the exact bug review finding #2 flagged.
    const byIdOnly = await s.as.query(api.dashboardCharts.budgetTransactions, {
      budgetId,
      categoryId: catA,
      year: 2026,
    });
    expect(byIdOnly.rows.map((r) => r.id)).toEqual([txnA]);
    expect(byIdOnly.rows.reduce((sum, r) => sum + r.amountCents, 0)).toBe(1_000);
  });

  test("categoryName: 'Uncategorized' matches rows with no categoryId, same as the `categoryId: 'uncategorized'` sentinel", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    const budgetId = await insertBudget(s, {
      chapterId: s.chapterId,
      amountCents: 10_000,
      year: 2026,
    });
    const fundId = await insertFund(s, s.chapterId);
    const catA = await insertCategory(s, s.chapterId, fundId, "Parts");

    const uncategorizedTxn = await insertTxn(s, {
      chapterId: s.chapterId,
      amountCents: 1_000,
      postedAt: tsInMonth(2026, 6),
      budgetId,
    });
    const categorizedTxn = await insertTxn(s, {
      chapterId: s.chapterId,
      amountCents: 2_000,
      postedAt: tsInMonth(2026, 6),
      budgetId,
    });
    await run(s.t, (ctx) => ctx.db.patch(categorizedTxn, { categoryId: catA }));

    const res = await s.as.query(api.dashboardCharts.budgetTransactions, {
      budgetId,
      categoryName: "Uncategorized",
      year: 2026,
      month: 6,
    });
    expect(res.rows.map((r) => r.id)).toEqual([uncategorizedTxn]);
  });
});
