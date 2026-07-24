/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { easternParts } from "@events-os/shared";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";

/**
 * `finances.budgetsGlance` — "budgets at a glance", the read-only
 * spend-vs-room-left view open to EVERY signed-in team member (deliberately
 * NOT finance-role gated — the FM's top ask: cardholders shouldn't have to
 * ask her):
 *
 *  - a caller with NO finance seat reads it (no throw, real rows);
 *  - one_time budgets report LIFETIME linked spend, recurring budgets their
 *    CURRENT cadence window (monthly → this month only), both against the
 *    EFFECTIVE cap — the same rules the FM's dashboard computes;
 *  - non-spend rows (personal / excluded / transfer) never count;
 *  - a never-approved draft is hidden; a previously-approved budget with an
 *    increase mid-review stays visible at its OLD (still-in-force) cap;
 *  - zero-cap zero-spend stragglers are hidden (the item-9 belt).
 */

const now = easternParts(Date.now());
// A mid-month noon-UTC timestamp inside the current Eastern year but a
// DIFFERENT month than today (previous month; February when today is
// January) — Eastern offset can't shift noon UTC across a mid-month day
// boundary, so the Eastern month/year are exactly as constructed.
const otherMonth = now.month === 1 ? 2 : now.month - 1;
const otherMonthTs = Date.UTC(now.year, otherMonth - 1, 15, 12);

async function seedBudget(
  s: ChapterSetup,
  opts: {
    amountCents: number;
    type: "one_time" | "recurring";
    cadence: Doc<"budgets">["cadence"];
    label?: string;
    approvalStatus?: Doc<"budgets">["approvalStatus"];
    approvedCents?: number;
  },
): Promise<Id<"budgets">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("budgets", {
      chapterId: s.chapterId,
      amountCents: opts.amountCents,
      label: opts.label,
      type: opts.type,
      cadence: opts.cadence,
      year: now.year,
      approvalStatus: opts.approvalStatus,
      approvedCents: opts.approvedCents,
      createdAt: Date.now(),
    }),
  );
}

async function seedTxn(
  s: ChapterSetup,
  opts: {
    amountCents: number;
    budgetId?: Id<"budgets">;
    postedAt?: number;
    flow?: Doc<"transactions">["flow"];
    status?: Doc<"transactions">["status"];
    isPersonal?: boolean;
  },
): Promise<Id<"transactions">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("transactions", {
      chapterId: s.chapterId,
      source: "manual",
      flow: opts.flow ?? "outflow",
      amountCents: opts.amountCents,
      postedAt: opts.postedAt ?? Date.now(),
      budgetId: opts.budgetId,
      isPersonal: opts.isPersonal,
      status: opts.status ?? "categorized",
      createdAt: Date.now(),
    }),
  );
}

describe("finances.budgetsGlance", () => {
  test("a caller with NO finance seat reads real spent-vs-remaining rows", async () => {
    const t = newT();
    const s = await setupChapter(t);
    // No `people` row, no financeRoles grant — the barest signed-in member.
    const budgetId = await seedBudget(s, {
      amountCents: 100_000,
      type: "one_time",
      cadence: "one_off",
      label: "Fall Retreat",
    });
    await seedTxn(s, { budgetId, amountCents: 25_000 });

    const glance = await s.as.query(api.finances.budgetsGlance, {});
    expect(glance.year).toBe(now.year);
    expect(glance.oneTime).toHaveLength(1);
    expect(glance.oneTime[0]).toMatchObject({
      id: budgetId,
      name: "Fall Retreat",
      capCents: 100_000,
      spentCents: 25_000,
      remainingCents: 75_000,
      pct: 25,
      status: "ok",
    });
  });

  test("one_time = lifetime linked spend; recurring monthly = this month only", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const oneTime = await seedBudget(s, {
      amountCents: 50_000,
      type: "one_time",
      cadence: "one_off",
      label: "Block Party",
    });
    // A one-time budget's spend accumulates across months (lifetime).
    await seedTxn(s, { budgetId: oneTime, amountCents: 10_000 });
    await seedTxn(s, { budgetId: oneTime, amountCents: 5_000, postedAt: otherMonthTs });

    const monthly = await seedBudget(s, {
      amountCents: 20_000,
      type: "recurring",
      cadence: "monthly",
      label: "Groceries",
    });
    // Only THIS month's spend counts toward a monthly bucket's window.
    await seedTxn(s, { budgetId: monthly, amountCents: 8_000 });
    await seedTxn(s, { budgetId: monthly, amountCents: 6_000, postedAt: otherMonthTs });

    const glance = await s.as.query(api.finances.budgetsGlance, {});
    expect(glance.oneTime[0]).toMatchObject({
      id: oneTime,
      spentCents: 15_000,
      remainingCents: 35_000,
    });
    expect(glance.recurring[0]).toMatchObject({
      id: monthly,
      spentCents: 8_000,
      remainingCents: 12_000,
    });
  });

  test("personal / excluded / transfer rows never count as spend", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const budgetId = await seedBudget(s, {
      amountCents: 30_000,
      type: "one_time",
      cadence: "one_off",
      label: "Gear",
    });
    await seedTxn(s, { budgetId, amountCents: 4_000 });
    await seedTxn(s, { budgetId, amountCents: 9_000, isPersonal: true });
    await seedTxn(s, { budgetId, amountCents: 9_000, status: "excluded" });
    await seedTxn(s, { budgetId, amountCents: 9_000, flow: "transfer" });

    const glance = await s.as.query(api.finances.budgetsGlance, {});
    expect(glance.oneTime[0].spentCents).toBe(4_000);
    expect(glance.oneTime[0].remainingCents).toBe(26_000);
  });

  test("hides never-approved drafts + zero-cap stragglers; a mid-review increase keeps its old cap", async () => {
    const t = newT();
    const s = await setupChapter(t);
    // A never-approved draft: not spendable, never advertised.
    await seedBudget(s, {
      amountCents: 40_000,
      type: "recurring",
      cadence: "monthly",
      label: "Draft bucket",
      approvalStatus: "draft",
    });
    // A "$0.00 / $0.00" straggler (the item-9 shape): hidden.
    await seedBudget(s, {
      amountCents: 0,
      type: "one_time",
      cadence: "one_off",
      label: "Empty summon",
    });
    // Approved at $500, increase to $800 mid-review: visible at the OLD cap.
    const midIncrease = await seedBudget(s, {
      amountCents: 80_000,
      type: "recurring",
      cadence: "monthly",
      label: "Snacks",
      approvalStatus: "submitted",
      approvedCents: 50_000,
    });
    await seedTxn(s, { budgetId: midIncrease, amountCents: 10_000 });

    const glance = await s.as.query(api.finances.budgetsGlance, {});
    expect(glance.oneTime).toHaveLength(0);
    expect(glance.recurring).toHaveLength(1);
    expect(glance.recurring[0]).toMatchObject({
      id: midIncrease,
      capCents: 50_000,
      spentCents: 10_000,
      remainingCents: 40_000,
    });
  });
});
