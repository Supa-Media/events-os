/// <reference types="vite/client" />
/**
 * ONE ANSWER TO "WHAT HAS THIS BUDGET SPENT".
 *
 * The same budget reported three different figures depending on which screen
 * you opened it from, and every one of them called itself "spent of cap":
 *
 *  · `finances.budgetsGlance` (the Budgets tab) and `finances.dashboardChapter`
 *    (the treasurer's cards) both summed from a CURRENT-YEAR scan, so a
 *    one-time budget spent against across a year boundary silently under-
 *    reported — even though `oneTimeCardBreakdown`'s own doc has always said
 *    its numbers are "genuinely LIFETIME";
 *  · `budgetDetail.getBudgetDetail` read `by_budget` with no window at all,
 *    so a RECURRING bucket reported its lifetime spend against a monthly cap
 *    ("$900 of $500" — reads as 180% over rather than as a different
 *    question);
 *  · and once the drop-down shipped (`budgetGlance.expenses`, lifetime for
 *    one-time budgets) it disagreed with the card it was expanding.
 *
 * The rule was never in dispute, only the data feeding it: a one-time
 * (event/project) budget's cap is its WHOLE plan, so its actuals are lifetime;
 * a recurring bucket's cap governs a cadence window, so its actuals are that
 * window. These tests assert the surfaces agree — across a year boundary,
 * which is the case that exposed it — rather than re-testing each in isolation,
 * because agreement is the property that kept breaking.
 */
import { describe, expect, test } from "vitest";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api } from "../_generated/api";
import { easternParts } from "@events-os/shared";
import type { Id } from "../_generated/dataModel";

/** Eastern-noon on a day — period bucketing is Eastern, so noon keeps the day
 *  unambiguous either side of DST. */
function tsOn(year: number, month: number, day: number): number {
  return Date.parse(
    `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T16:00:00Z`,
  );
}

const NOW = new Date();
// EASTERN, not the runner's clock. `budgetGlance` decides which month a
// recurring bucket's window covers with `easternParts`, and a test that asks
// `Date` instead disagrees with it for the four hours between 00:00 UTC and
// 00:00 Eastern on the 1st of every month — which is a red main once a month,
// for nobody's change. See the sibling fix in `budgetGlanceExpenses.test.ts`.
const THIS_YEAR = easternParts(NOW.getTime()).year;
const THIS_MONTH = easternParts(NOW.getTime()).month;
const LAST_YEAR = THIS_YEAR - 1;

async function seedFinanceViewer(s: ChapterSetup): Promise<void> {
  const personId = await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Treasurer",
      userId: s.userId,
      isTeamMember: true,
      createdAt: Date.now(),
    }),
  );
  await run(s.t, (ctx) =>
    ctx.db.insert("financeRoles", {
      chapterId: s.chapterId,
      personId,
      role: "manager",
      scope: "chapter",
      createdAt: Date.now(),
    }),
  );
}

async function seedBudget(
  s: ChapterSetup,
  fields: {
    amountCents: number;
    year: number;
    cadence: "monthly" | "one_off";
    type: "one_time" | "recurring";
    label: string;
  },
): Promise<Id<"budgets">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("budgets", {
      chapterId: s.chapterId,
      amountCents: fields.amountCents,
      year: fields.year,
      cadence: fields.cadence,
      type: fields.type,
      scope: "chapter",
      label: fields.label,
      approvalStatus: "approved",
      createdAt: Date.now(),
    }),
  );
}

async function seedCharge(
  s: ChapterSetup,
  budgetId: Id<"budgets">,
  amountCents: number,
  postedAt: number,
): Promise<void> {
  await run(s.t, (ctx) =>
    ctx.db.insert("transactions", {
      chapterId: s.chapterId,
      source: "manual",
      flow: "outflow",
      amountCents,
      currency: "usd",
      postedAt,
      budgetId,
      merchantName: "Supplier",
      status: "reconciled",
      createdAt: Date.now(),
    }),
  );
}

describe("what a budget has spent — every surface agrees", () => {
  test("a one-time budget spanning a year boundary reads the same everywhere", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedFinanceViewer(s);
    // Genesis: a budget for THIS year's event, with a deposit paid in
    // December. This is the exact shape that under-reported — the year scan
    // every card was built from could only ever see the charges on this side
    // of New Year, so the deposit vanished from the number.
    const budgetId = await seedBudget(s, {
      amountCents: 150_000,
      year: THIS_YEAR,
      cadence: "one_off",
      type: "one_time",
      label: "Genesis",
    });
    await seedCharge(s, budgetId, 70_000, tsOn(LAST_YEAR, 11, 20));
    await seedCharge(s, budgetId, 45_000, tsOn(THIS_YEAR, 1, 8));
    const LIFETIME = 115_000;

    const glance = await s.as.query(api.finances.budgetsGlance, {});
    const card = glance.oneTime.find((r) => r.id === budgetId);
    const drilldown = await s.as.query(api.budgetGlance.expenses, { budgetId });
    const detail = await s.as.query(api.budgetDetail.getBudgetDetail, { budgetId });

    expect(card?.spentCents).toBe(LIFETIME);
    expect(drilldown?.spentCents).toBe(LIFETIME);
    expect(detail?.spentCents).toBe(LIFETIME);
    // And the lines the reader can count add up to the headline they sit under.
    expect(drilldown?.lines.reduce((sum, l) => sum + l.amountCents, 0)).toBe(
      LIFETIME,
    );
  });

  test("the treasurer's dashboard card reports that same lifetime figure", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedFinanceViewer(s);
    const budgetId = await seedBudget(s, {
      amountCents: 150_000,
      year: THIS_YEAR,
      cadence: "one_off",
      type: "one_time",
      label: "Genesis",
    });
    await seedCharge(s, budgetId, 70_000, tsOn(LAST_YEAR, 11, 20));
    await seedCharge(s, budgetId, 45_000, tsOn(THIS_YEAR, 1, 8));

    // YTD so the card is visible regardless of which month the suite runs in
    // (`oneTimeCardAppliesToDash` month-gates VISIBILITY, never the numbers).
    const dash = await s.as.query(api.finances.dashboardChapter, {
      year: THIS_YEAR,
      month: THIS_MONTH,
      period: "ytd",
    });
    const card = dash.oneTimeBudgets.find((b) => b.id === budgetId);
    expect(card?.spentCents).toBe(115_000);
  });

  test("a recurring bucket reads its CADENCE window everywhere, not its lifetime", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedFinanceViewer(s);
    const budgetId = await seedBudget(s, {
      amountCents: 50_000,
      year: THIS_YEAR,
      cadence: "monthly",
      type: "recurring",
      label: "Coffee",
    });
    await seedCharge(s, budgetId, 2_500, tsOn(THIS_YEAR, THIS_MONTH, 4));
    // A charge from a month the cap doesn't govern. Counting it would make a
    // $500 monthly bucket read as though it had blown through its cap.
    const otherMonth = THIS_MONTH === 1 ? 12 : THIS_MONTH - 1;
    const otherYear = THIS_MONTH === 1 ? THIS_YEAR - 1 : THIS_YEAR;
    await seedCharge(s, budgetId, 90_000, tsOn(otherYear, otherMonth, 4));

    const glance = await s.as.query(api.finances.budgetsGlance, {});
    const card = glance.recurring.find((r) => r.id === budgetId);
    const drilldown = await s.as.query(api.budgetGlance.expenses, { budgetId });
    const detail = await s.as.query(api.budgetDetail.getBudgetDetail, { budgetId });

    expect(card?.spentCents).toBe(2_500);
    expect(drilldown?.spentCents).toBe(2_500);
    // The one that used to say 92,500 against a 50,000 cap.
    expect(detail?.spentCents).toBe(2_500);
    // …and it now SAYS which period that covers, so the figure can't be read
    // as something it isn't.
    expect(detail?.spendWindowLabel).toBe("this month");
  });

  test("a one-time budget's figure carries no window label — its window is its life", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedFinanceViewer(s);
    const budgetId = await seedBudget(s, {
      amountCents: 10_000,
      year: THIS_YEAR,
      cadence: "one_off",
      type: "one_time",
      label: "Gear",
    });
    const detail = await s.as.query(api.budgetDetail.getBudgetDetail, { budgetId });
    expect(detail?.spendWindowLabel).toBeNull();
  });

  test("the detail page still lists EVERY charge, whichever window the headline uses", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedFinanceViewer(s);
    const budgetId = await seedBudget(s, {
      amountCents: 50_000,
      year: THIS_YEAR,
      cadence: "monthly",
      type: "recurring",
      label: "Coffee",
    });
    await seedCharge(s, budgetId, 2_500, tsOn(THIS_YEAR, THIS_MONTH, 4));
    const otherMonth = THIS_MONTH === 1 ? 12 : THIS_MONTH - 1;
    const otherYear = THIS_MONTH === 1 ? THIS_YEAR - 1 : THIS_YEAR;
    await seedCharge(s, budgetId, 9_000, tsOn(otherYear, otherMonth, 4));

    const detail = await s.as.query(api.budgetDetail.getBudgetDetail, { budgetId });
    // Narrowing the HEADLINE must not narrow the record. "Every charge ever"
    // is genuinely useful on this page — it just isn't the thing to divide by
    // a monthly cap.
    expect(detail?.transactionTotalCount).toBe(2);
  });
});
