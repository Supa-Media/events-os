/// <reference types="vite/client" />
/**
 * THE BUDGET DROP-DOWN — the charges behind a "budgets at a glance" number.
 *
 * Founder, 2026-08-14: "the budgeting section leaves a lot to be desired. It
 * just gives an amount. Doesn't give details… we should just be able to drop
 * down and see the different expenses per budget."
 *
 * The thing that makes this feature either trustworthy or worthless is whether
 * the lines ADD UP to the number two pixels above them. `budgetsGlance` windows
 * a one-time budget over its whole life and a recurring bucket over its current
 * cadence window; `budgetDetail` (the finance-gated page) deliberately uses a
 * different, lifetime-only rule. `budgetGlance.expenses` is the expansion of a
 * GLANCE CARD, so it has to match the card — and that is exactly the kind of
 * agreement that holds until someone edits one of the two. Hence these tests.
 *
 * Also pinned: the ref links the founder asked for by name resolve only for a
 * LIVE event/project (a deleted one must produce no link rather than a 404),
 * and the member-visible gate (`lib/budgetGlanceAccess.ts`) degrades to `null`
 * rather than throwing a permission wall at a cardholder.
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

async function seedBudget(
  s: ChapterSetup,
  fields: {
    amountCents: number;
    year: number;
    month?: number;
    quarter?: number;
    cadence: "monthly" | "quarterly" | "yearly" | "per_instance" | "one_off";
    /** Set EXPLICITLY in every seed below. `effectiveType` only infers
     *  "one_time" from a legacy event/project `scope`, so a chapter-scoped
     *  one-off with no `type` silently reads as recurring — and then windows
     *  its charges to the current month, which is not what any of these tests
     *  are about. */
    type: "one_time" | "recurring";
    scope?: "event" | "project" | "chapter";
    refKind?: "event" | "project";
    scopeRefId?: string;
    label?: string;
    approved?: boolean;
  },
): Promise<Id<"budgets">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("budgets", {
      chapterId: s.chapterId,
      amountCents: fields.amountCents,
      year: fields.year,
      month: fields.month,
      quarter: fields.quarter,
      cadence: fields.cadence,
      type: fields.type,
      scope: fields.scope ?? "chapter",
      refKind: fields.refKind,
      scopeRefId: fields.scopeRefId,
      label: fields.label,
      approvalStatus: fields.approved === false ? "draft" : "approved",
      createdAt: Date.now(),
    }),
  );
}

async function seedEvent(
  s: ChapterSetup,
  opts: { name: string; eventDate: number },
): Promise<Id<"events">> {
  return await run(s.t, async (ctx) => {
    const eventTypeId = await ctx.db.insert("eventTypes", {
      chapterId: s.chapterId,
      name: "Service",
      slug: `service-${opts.name.toLowerCase().replace(/\W+/g, "-")}`,
      version: 1,
      createdBy: s.userId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    return await ctx.db.insert("events", {
      chapterId: s.chapterId,
      eventTypeId,
      templateVersion: 1,
      name: opts.name,
      eventDate: opts.eventDate,
      status: "planning",
      createdBy: s.userId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
}

async function seedCharge(
  s: ChapterSetup,
  opts: {
    budgetId: Id<"budgets">;
    amountCents: number;
    postedAt: number;
    merchantName?: string;
    personId?: Id<"people">;
    flow?: "outflow" | "transfer";
  },
): Promise<Id<"transactions">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("transactions", {
      chapterId: s.chapterId,
      source: "manual",
      flow: opts.flow ?? "outflow",
      amountCents: opts.amountCents,
      currency: "usd",
      postedAt: opts.postedAt,
      budgetId: opts.budgetId,
      merchantName: opts.merchantName,
      personId: opts.personId,
      status: "reconciled",
      createdAt: Date.now(),
    }),
  );
}

describe("the Budgets tab lists every budget worth listing", () => {
  test("a budget stamped to a PAST year is REACHABLE — on that year's page, and that year is offered", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const lastYear = new Date().getFullYear() - 1;
    // The founder's complaint: a budget created last November for a January
    // event simply wasn't on the tab. Not zeroed, not greyed — absent, so the
    // person looking for it concluded the app had lost it.
    const budgetId = await seedBudget(s, {
      amountCents: 50_000,
      year: lastYear,
      cadence: "one_off",
      type: "one_time",
      label: "Last year's Genesis",
    });
    await seedCharge(s, {
      budgetId,
      amountCents: 12_000,
      postedAt: tsOn(lastYear, 11, 20),
    });

    // The tab is now a YEAR AT A TIME ("every year is a new page"), so the fix
    // for "it's missing" is no longer "it's in the default list" — it's that
    // the year picker OFFERS the year it lives on. Both halves are the
    // contract, and the second is what makes the first discoverable.
    const current = await s.as.query(api.finances.budgetsGlance, {});
    expect(current.oneTime.find((r) => r.id === budgetId)).toBeUndefined();
    expect(current.availableYears).toContain(lastYear);

    const past = await s.as.query(api.finances.budgetsGlance, { year: lastYear });
    const card = past.oneTime.find((r) => r.id === budgetId);
    expect(card).toBeDefined();
    // …and it reports its real lifetime spend, not a hopeful zero.
    expect(card?.spentCents).toBe(12_000);
  });

  test("a PAST-YEAR recurring bucket stays off — its cap governs a window that has ended", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const lastYear = new Date().getFullYear() - 1;
    const budgetId = await seedBudget(s, {
      amountCents: 50_000,
      year: lastYear,
      cadence: "monthly",
      type: "recurring",
      label: "Last year's coffee",
    });
    await seedCharge(s, {
      budgetId,
      amountCents: 2_000,
      postedAt: tsOn(lastYear, 6, 4),
    });

    const glance = await s.as.query(api.finances.budgetsGlance, {});
    // A monthly bucket from a year that's over has no live window to report
    // against; it would read "$0.00 of $500.00" forever, which looks like a
    // budget nobody is using rather than one that ended.
    expect(glance.recurring.find((r) => r.id === budgetId)).toBeUndefined();
  });

  test("THIS year's recurring bucket is still listed", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const budgetId = await seedBudget(s, {
      amountCents: 50_000,
      year: new Date().getFullYear(),
      cadence: "monthly",
      type: "recurring",
      label: "Coffee",
    });
    await seedCharge(s, {
      budgetId,
      amountCents: 2_000,
      postedAt: Date.now(),
    });
    const glance = await s.as.query(api.finances.budgetsGlance, {});
    expect(glance.recurring.find((r) => r.id === budgetId)).toBeDefined();
  });

  test("a BLANK-template event keeps the name someone actually typed", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const thisYear = new Date().getFullYear();
    // The chapter's synthesized "start from scratch" template. Titling a
    // budget "Blank event" tells a reader strictly less than the name its
    // creator typed — and titling THREE of them that is worse still (founder,
    // 2026-08-14, looking at "Blank event Dec 2025" twice on one screen).
    const eventTypeId = await run(s.t, (ctx) =>
      ctx.db.insert("eventTypes", {
        chapterId: s.chapterId,
        name: "Blank event",
        slug: "blank-event",
        isBlank: true,
        version: 1,
        createdBy: s.userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    const eventId = await run(s.t, (ctx) =>
      ctx.db.insert("events", {
        chapterId: s.chapterId,
        eventTypeId,
        templateVersion: 1,
        name: "Christmas Outreach",
        eventDate: tsOn(thisYear, 12, 20),
        status: "planning",
        createdBy: s.userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    const budgetId = await seedBudget(s, {
      amountCents: 50_000,
      year: thisYear,
      cadence: "per_instance",
      type: "one_time",
      scope: "event",
      refKind: "event",
      scopeRefId: eventId,
    });

    const glance = await s.as.query(api.finances.budgetsGlance, {});
    const card = glance.oneTime.find((r) => r.id === budgetId);
    expect(card?.name).toBe("Christmas Outreach");
    // And no date is appended — a blank template lends no name, so there is
    // no collision to disambiguate in the first place.
    expect(card?.name).not.toContain("Blank event");
  });

  test("two blank-template events don't collapse into one another", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const thisYear = new Date().getFullYear();
    const eventTypeId = await run(s.t, (ctx) =>
      ctx.db.insert("eventTypes", {
        chapterId: s.chapterId,
        name: "Blank event",
        slug: "blank-event",
        isBlank: true,
        version: 1,
        createdBy: s.userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    const mk = async (name: string, month: number) => {
      const eventId = await run(s.t, (ctx) =>
        ctx.db.insert("events", {
          chapterId: s.chapterId,
          eventTypeId,
          templateVersion: 1,
          name,
          eventDate: tsOn(thisYear, month, 12),
          status: "planning",
          createdBy: s.userId,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }),
      );
      return await seedBudget(s, {
        amountCents: 50_000,
        year: thisYear,
        cadence: "per_instance",
        type: "one_time",
        scope: "event",
        refKind: "event",
        scopeRefId: eventId,
      });
    };
    const a = await mk("Christmas Outreach", 12);
    const b = await mk("Volunteer Dinner", 6);

    const glance = await s.as.query(api.finances.budgetsGlance, {});
    const byId = new Map(glance.oneTime.map((r) => [r.id, r.name]));
    // Two budgets on the SAME blank template: each keeps its own event name
    // rather than becoming "Blank event Dec" and "Blank event Jun".
    expect(byId.get(a)).toBe("Christmas Outreach");
    expect(byId.get(b)).toBe("Volunteer Dinner");
  });

  test("budgets on one template are told apart by year, and by month within a year", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const thisYear = new Date().getFullYear();
    const lastYear = thisYear - 1;
    // Three events on the SAME template: one last year, two this year.
    const mk = async (name: string, year: number, month: number) => {
      const eventId = await seedEvent(s, { name, eventDate: tsOn(year, month, 12) });
      return await seedBudget(s, {
        amountCents: 50_000,
        year,
        cadence: "per_instance",
        type: "one_time",
        scope: "event",
        refKind: "event",
        scopeRefId: eventId,
      });
    };
    const older = await mk("Genesis A", lastYear, 5);
    const springId = await mk("Genesis B", thisYear, 3);
    const autumnId = await mk("Genesis C", thisYear, 10);

    // Titles resolve against the WHOLE chapter, not against one year's page —
    // which is the point of `resolveTitlesForBudgets` loading every sibling.
    // So last year's budget is still told apart by year even though it renders
    // on a page where it is the only "Service", and this year's two still need
    // their months even though last year's isn't beside them.
    const thisYearGlance = await s.as.query(api.finances.budgetsGlance, {});
    const lastYearGlance = await s.as.query(api.finances.budgetsGlance, {
      year: lastYear,
    });
    const byId = new Map(
      [...thisYearGlance.oneTime, ...lastYearGlance.oneTime].map((r) => [
        r.id,
        r.name,
      ]),
    );
    // Grouping is by template NAME, not by template row id — `seedEvent`
    // inserts a separate "Service" eventTypes row per event, and three things
    // a reader would call "Service" must still be told apart. That is the
    // founder's rule exactly: year where a year is enough, month where it
    // isn't, and nothing at all when there's nothing to disambiguate.
    expect(byId.get(older)).toBe(`Service ${lastYear}`);
    expect(byId.get(springId)).toBe(`Service Mar ${thisYear}`);
    expect(byId.get(autumnId)).toBe(`Service Oct ${thisYear}`);
  });
});

describe("budgetGlance.expenses", () => {
  test("the lines add up to the card's own spent figure (one-time, lifetime)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const budgetId = await seedBudget(s, {
      amountCents: 100_000,
      year: new Date().getFullYear(),
      cadence: "one_off",
      type: "one_time",
      label: "Genesis",
    });
    // Two charges in DIFFERENT months of the current year. A one-time budget
    // counts both; a window that narrowed to "this month" would drop one and
    // the drawer would visibly fail to add up to its own header.
    const year = new Date().getFullYear();
    await seedCharge(s, { budgetId, amountCents: 4_000, postedAt: tsOn(year, 1, 15) });
    await seedCharge(s, { budgetId, amountCents: 6_000, postedAt: tsOn(year, 6, 15) });

    const detail = await s.as.query(api.budgetGlance.expenses, { budgetId });
    expect(detail).not.toBeNull();
    expect(detail!.spentCents).toBe(10_000);
    expect(detail!.lines).toHaveLength(2);
    expect(detail!.lines.reduce((sum, l) => sum + l.amountCents, 0)).toBe(10_000);

    // And the glance CARD agrees — the whole point.
    const glance = await s.as.query(api.finances.budgetsGlance, {});
    const card = [...glance.oneTime, ...glance.recurring].find((r) => r.id === budgetId);
    expect(card?.spentCents).toBe(detail!.spentCents);
    expect(card?.capCents).toBe(detail!.capCents);
  });

  test("a recurring bucket's drawer shows THIS month, matching its card", async () => {
    const t = newT();
    const s = await setupChapter(t);
    // EASTERN, not the runner's clock — `budgetGlance.expenses` picks its
    // window with `easternParts`, so a test that asks `Date` seeds its "this
    // month" charge into next month for the four hours between 00:00 UTC and
    // 00:00 Eastern on the 1st, and then asserts the previous month's charge
    // shouldn't count while the code correctly counts it.
    const { year, month } = easternParts(Date.now());
    const budgetId = await seedBudget(s, {
      amountCents: 50_000,
      year,
      cadence: "monthly",
      type: "recurring",
      label: "Coffee",
    });
    await seedCharge(s, { budgetId, amountCents: 2_500, postedAt: tsOn(year, month, 5) });
    // A charge in a DIFFERENT month of the same year — outside the current
    // cadence window, so neither the card nor the drawer counts it.
    const otherMonth = month === 1 ? 12 : month - 1;
    const otherYear = month === 1 ? year - 1 : year;
    await seedCharge(s, {
      budgetId,
      amountCents: 9_999,
      postedAt: tsOn(otherYear, otherMonth, 5),
    });

    const detail = await s.as.query(api.budgetGlance.expenses, { budgetId });
    expect(detail!.spentCents).toBe(2_500);
    expect(detail!.lines).toHaveLength(1);
    expect(detail!.windowLabel).toBe("this month");

    const glance = await s.as.query(api.finances.budgetsGlance, {});
    const card = glance.recurring.find((r) => r.id === budgetId);
    expect(card?.spentCents).toBe(2_500);
  });

  test("transfers never count as spend, in the lines or the total", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const year = new Date().getFullYear();
    const budgetId = await seedBudget(s, {
      amountCents: 10_000,
      year,
      cadence: "one_off",
      type: "one_time",
      label: "Gear",
    });
    await seedCharge(s, { budgetId, amountCents: 3_000, postedAt: tsOn(year, 3, 1) });
    await seedCharge(s, {
      budgetId,
      amountCents: 7_000,
      postedAt: tsOn(year, 3, 2),
      flow: "transfer", // e.g. a personal-charge repayment credit
    });

    const detail = await s.as.query(api.budgetGlance.expenses, { budgetId });
    expect(detail!.spentCents).toBe(3_000);
    expect(detail!.lines).toHaveLength(1);
  });

  test("an event budget carries the ref the card links to", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const year = new Date().getFullYear();
    const eventId = await seedEvent(s, { name: "Genesis LTN", eventDate: tsOn(year, 5, 20) });
    const budgetId = await seedBudget(s, {
      amountCents: 20_000,
      year,
      cadence: "per_instance",
      type: "one_time",
      scope: "event",
      refKind: "event",
      scopeRefId: eventId,
    });

    const detail = await s.as.query(api.budgetGlance.expenses, { budgetId });
    expect(detail!.refKind).toBe("event");
    expect(detail!.scopeRefId).toBe(eventId);
    // The TEMPLATE's name (`seedEvent` uses "Service"), not the event
    // instance's — see `lib/budgetTitles.ts` in shared.
    expect(detail!.name).toBe("Service");

    const glance = await s.as.query(api.finances.budgetsGlance, {});
    const card = glance.oneTime.find((r) => r.id === budgetId);
    expect(card?.refKind).toBe("event");
    expect(card?.scopeRefId).toBe(eventId);
  });

  test("a DELETED event produces no link rather than one that 404s", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const year = new Date().getFullYear();
    const eventId = await seedEvent(s, {
      name: "Cancelled Night",
      eventDate: tsOn(year, 5, 20),
    });
    const budgetId = await seedBudget(s, {
      amountCents: 20_000,
      year,
      cadence: "per_instance",
      type: "one_time",
      scope: "event",
      refKind: "event",
      scopeRefId: eventId,
      label: "Cancelled Night budget",
    });
    // `events.remove` does not cascade to a linked budget — the dangling
    // `scopeRefId` stays forever, which is exactly the case the link has to
    // survive.
    await run(s.t, (ctx) => ctx.db.delete(eventId));

    const detail = await s.as.query(api.budgetGlance.expenses, { budgetId });
    expect(detail!.refKind).toBeNull();
    expect(detail!.scopeRefId).toBeNull();

    const glance = await s.as.query(api.finances.budgetsGlance, {});
    const card = glance.oneTime.find((r) => r.id === budgetId);
    expect(card?.refKind ?? null).toBeNull();
    expect(card?.scopeRefId ?? null).toBeNull();
  });

  test("a never-approved draft has no drop-down, because it has no card", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const year = new Date().getFullYear();
    const budgetId = await seedBudget(s, {
      amountCents: 5_000,
      year,
      cadence: "one_off",
      type: "one_time",
      label: "Someday",
      approved: false,
    });

    expect(await s.as.query(api.budgetGlance.expenses, { budgetId })).toBeNull();
    const glance = await s.as.query(api.finances.budgetsGlance, {});
    expect(
      [...glance.oneTime, ...glance.recurring].some((r) => r.id === budgetId),
    ).toBe(false);
  });

  test("another chapter's budget returns null — quietly, never a thrown wall", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const other = await run(s.t, (ctx) =>
      ctx.db.insert("chapters", { name: "Elsewhere", isActive: true, createdAt: Date.now() }),
    );
    const budgetId = await run(s.t, (ctx) =>
      ctx.db.insert("budgets", {
        chapterId: other,
        amountCents: 5_000,
        year: new Date().getFullYear(),
        cadence: "one_off",
        type: "one_time",
        scope: "chapter",
        approvalStatus: "approved",
        label: "Not yours",
        createdAt: Date.now(),
      }),
    );

    // No throw — the budgets screen must never show a member a permission
    // wall (see `lib/budgetGlanceAccess.ts`'s quiet-degradation contract).
    expect(await s.as.query(api.budgetGlance.expenses, { budgetId })).toBeNull();
  });

  test("a member with no finance seat gets the charges AND no dead 'Full detail' link", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const year = new Date().getFullYear();
    const budgetId = await seedBudget(s, {
      amountCents: 10_000,
      year,
      cadence: "one_off",
      type: "one_time",
      label: "Gear",
    });
    await seedCharge(s, {
      budgetId,
      amountCents: 2_000,
      postedAt: tsOn(year, 4, 1),
      merchantName: "Guitar Center",
    });

    // `setupChapter`'s caller holds no `financeRoles` grant.
    const detail = await s.as.query(api.budgetGlance.expenses, { budgetId });
    expect(detail).not.toBeNull();
    expect(detail!.lines[0].merchantName).toBe("Guitar Center");
    // The detail page is finance-viewer gated, so the link must not be
    // offered — a link into a permission wall is worse than no link.
    expect(detail!.canOpenDetail).toBe(false);
  });

  test("a finance viewer IS offered the full detail page", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const year = new Date().getFullYear();
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
        role: "viewer",
        scope: "chapter",
        createdAt: Date.now(),
      }),
    );
    const budgetId = await seedBudget(s, {
      amountCents: 10_000,
      year,
      cadence: "one_off",
      type: "one_time",
      label: "Gear",
    });

    const detail = await s.as.query(api.budgetGlance.expenses, { budgetId });
    expect(detail!.canOpenDetail).toBe(true);
  });
});

/**
 * A RECURRING BUCKET'S YEAR, WINDOW BY WINDOW.
 *
 * Founder, 2026-08-14: "for the recurring budgets, I want to see smaller
 * chunks with all the past budgets — since we are in Q3, show me Q1 and Q2 and
 * Q3 for the quarterly; if we are in the 7th month, show me all past months;
 * maybe even show all and predict how much we will spend based on previous
 * spending. For the yearly budgets it's fine because obviously each page is a
 * year."
 *
 * These tests are written against the CURRENT month rather than a frozen one —
 * `budgetsGlance` returns its own `month`, so every assertion is derived from
 * the same clock the query used. A test that hard-codes "we are in Q3" passes
 * for eleven weeks and then fails for forty-one.
 */
describe("a recurring bucket is broken into its own windows", () => {
  test("monthly: every elapsed month, then a projection from the completed ones", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const thisYear = new Date().getFullYear();
    const budgetId = await seedBudget(s, {
      amountCents: 50_000,
      year: thisYear,
      cadence: "monthly",
      type: "recurring",
      label: "Operating Expenses",
    });
    const nowMonth = (await s.as.query(api.finances.budgetsGlance, {})).month;
    await seedCharge(s, {
      budgetId,
      amountCents: 10_000,
      postedAt: tsOn(thisYear, 1, 15),
    });
    if (nowMonth !== 1) {
      await seedCharge(s, {
        budgetId,
        amountCents: 30_000,
        postedAt: tsOn(thisYear, nowMonth, 5),
      });
    }

    const glance = await s.as.query(api.finances.budgetsGlance, {});
    const row = glance.recurring.find((r) => r.id === budgetId);
    const periods = row?.periods ?? [];
    const elapsed = periods.filter((p) => p.state !== "projected");
    const projected = periods.filter((p) => p.state === "projected");

    // Every month up to and including this one, in order, exactly once.
    expect(elapsed.map((p) => p.key)).toEqual(
      Array.from({ length: nowMonth }, (_, i) => `m${i + 1}`),
    );
    expect(elapsed[0].label).toBe("Jan");
    // Exactly one window is "current", and it's the last elapsed one.
    expect(elapsed.filter((p) => p.state === "current")).toHaveLength(1);
    expect(elapsed[elapsed.length - 1].state).toBe("current");
    // Each window reports ITS OWN spend, not the year's running total — the
    // whole point of the strip. January holds January's charge and nothing
    // else, and the cap is the cadence cap in every window.
    expect(elapsed[0].spentCents).toBe(nowMonth === 1 ? 40_000 : 10_000);
    expect(periods.every((p) => p.capCents === 50_000)).toBe(true);
    if (nowMonth !== 1) {
      expect(elapsed[elapsed.length - 1].spentCents).toBe(30_000);
    }

    if (nowMonth === 1) {
      // Nothing has COMPLETED yet, so there is nothing honest to predict —
      // and a strip of eleven projected zeroes would be a prediction.
      expect(projected).toHaveLength(0);
    } else {
      const completed = elapsed.slice(0, -1);
      const avg = Math.round(
        completed.reduce((sum, p) => sum + p.spentCents, 0) / completed.length,
      );
      expect(projected.map((p) => p.key)).toEqual(
        Array.from({ length: 12 - nowMonth }, (_, i) => `m${nowMonth + i + 1}`),
      );
      // The projection averages COMPLETED windows only. The current month is
      // partial by definition — folding it in would predict a collapse in
      // spending that is really just the calendar.
      expect(projected.every((p) => p.spentCents === avg)).toBe(true);
    }
  });

  test("quarterly: Q1 through the current quarter, labelled as quarters", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const thisYear = new Date().getFullYear();
    const budgetId = await seedBudget(s, {
      amountCents: 40_000,
      year: thisYear,
      cadence: "quarterly",
      type: "recurring",
      label: "Culture Fund",
    });
    const nowMonth = (await s.as.query(api.finances.budgetsGlance, {})).month;
    const nowQuarter = Math.ceil(nowMonth / 3);
    await seedCharge(s, {
      budgetId,
      amountCents: 12_000,
      postedAt: tsOn(thisYear, 2, 10),
    });

    const glance = await s.as.query(api.finances.budgetsGlance, {});
    const periods = glance.recurring.find((r) => r.id === budgetId)?.periods ?? [];
    const elapsed = periods.filter((p) => p.state !== "projected");

    expect(elapsed.map((p) => p.label)).toEqual(
      Array.from({ length: nowQuarter }, (_, i) => `Q${i + 1}`),
    );
    // February's charge lands in Q1 and only Q1 — the quarter window is three
    // months wide, not the whole year to date.
    expect(elapsed[0].spentCents).toBe(12_000);
    if (nowQuarter > 1) {
      expect(elapsed.slice(1).every((p) => p.spentCents === 0)).toBe(true);
    }
    expect(periods.filter((p) => p.state === "projected")).toHaveLength(
      nowQuarter === 1 ? 0 : 4 - nowQuarter,
    );
  });

  test("a yearly bucket has no windows — the page already IS its window", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const thisYear = new Date().getFullYear();
    const budgetId = await seedBudget(s, {
      amountCents: 50_000,
      year: thisYear,
      cadence: "yearly",
      type: "recurring",
      label: "Education & Growth",
    });
    await seedCharge(s, {
      budgetId,
      amountCents: 1_636,
      postedAt: tsOn(thisYear, 2, 3),
    });

    const glance = await s.as.query(api.finances.budgetsGlance, {});
    const row = glance.recurring.find((r) => r.id === budgetId);
    // Omitted, not an empty array: the field's absence is what an older client
    // bundle safely ignores.
    expect(row?.periods).toBeUndefined();
    // …and the headline number is untouched by any of this.
    expect(row?.spentCents).toBe(1_636);
  });

  test("a stray `month` does NOT freeze a monthly bucket to one window", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const thisYear = new Date().getFullYear();
    // "Monthly, but only February" is a contradiction — a repeating cadence
    // whose window never moves. `budgetEffectivePeriod`'s own doc assumes a
    // monthly budget carries no `month`; when one does anyway (stamped at
    // creation), honoring it froze the bucket to a single window forever.
    const budgetId = await seedBudget(s, {
      amountCents: 20_000,
      year: thisYear,
      month: 2,
      cadence: "monthly",
      type: "recurring",
      label: "Operating Expenses",
    });
    await seedCharge(s, {
      budgetId,
      amountCents: 5_000,
      postedAt: tsOn(thisYear, 2, 14),
    });

    const glance = await s.as.query(api.finances.budgetsGlance, {});
    const row = glance.recurring.find((r) => r.id === budgetId)!;
    const byLabel = new Map(row.periods!.map((p) => [p.label, p.spentCents]));
    // Every elapsed month is charted, and February's charge sits in FEBRUARY
    // rather than being repeated into every window.
    expect(row.periods!.length).toBeGreaterThan(1);
    expect(byLabel.get("Feb")).toBe(5_000);
    expect(byLabel.get("Jan")).toBe(0);
    // …and the headline reports the CURRENT month, which is what its "this
    // month" label has always claimed. Before the fix it reported February's
    // spend under that label whatever month you opened it in.
    if (glance.month !== 2) expect(row.spentCents).toBe(0);
  });

  test("a one-time budget never carries windows", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const thisYear = new Date().getFullYear();
    const budgetId = await seedBudget(s, {
      amountCents: 50_000,
      year: thisYear,
      cadence: "one_off",
      type: "one_time",
      label: "Genesis",
    });
    await seedCharge(s, {
      budgetId,
      amountCents: 9_000,
      postedAt: tsOn(thisYear, 3, 3),
    });

    const glance = await s.as.query(api.finances.budgetsGlance, {});
    expect(glance.oneTime.find((r) => r.id === budgetId)?.periods).toBeUndefined();
  });
});

/**
 * ONE YEAR PER PAGE, ONE BOOK AT A TIME — the `year` and `scope` args.
 *
 * `scope` is the one that has teeth: `budgetsGlance` is DELIBERATELY the one
 * finance read any team member can make, so a widening argument on it is a
 * widening argument on the least-gated surface in the domain. It has to be
 * refused by the server, not hidden by the client.
 */
describe("budgetsGlance's year and book arguments", () => {
  test("availableYears offers every year that has a budget, plus this one", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const thisYear = new Date().getFullYear();
    for (const year of [thisYear - 2, thisYear - 1]) {
      const budgetId = await seedBudget(s, {
        amountCents: 50_000,
        year,
        cadence: "one_off",
        type: "one_time",
        label: `Genesis ${year}`,
      });
      await seedCharge(s, {
        budgetId,
        amountCents: 1_000,
        postedAt: tsOn(year, 6, 1),
      });
    }

    const glance = await s.as.query(api.finances.budgetsGlance, {});
    // Newest first, and the current year is always offered even though nothing
    // files under it — a picker must never sit on a year it won't offer.
    expect(glance.availableYears).toEqual([thisYear, thisYear - 1, thisYear - 2]);
    expect(glance.year).toBe(thisYear);
    expect(glance.oneTime).toHaveLength(0);

    const older = await s.as.query(api.finances.budgetsGlance, {
      year: thisYear - 2,
    });
    expect(older.year).toBe(thisYear - 2);
    expect(older.oneTime).toHaveLength(1);
    // The picker's options don't shrink to the page you're on.
    expect(older.availableYears).toEqual([thisYear, thisYear - 1, thisYear - 2]);
  });

  test("a caller without central reach cannot widen the scope by URL", async () => {
    const t = newT();
    const s = await setupChapter(t);
    // A chapter admin is not a central finance holder. Asking for every book
    // has to THROW — silently answering with their own chapter would teach the
    // client that the argument works.
    await expect(
      s.as.query(api.finances.budgetsGlance, { scope: "all" }),
    ).rejects.toThrow(/central/i);
    await expect(
      s.as.query(api.finances.budgetsGlance, { scope: "central" }),
    ).rejects.toThrow(/central/i);
    // Their own book needs nothing beyond membership.
    await expect(
      s.as.query(api.finances.budgetsGlance, { scope: s.chapterId }),
    ).resolves.toBeDefined();
  });

  test("the book picker offers a plain member exactly one book — their own", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const scopes = await s.as.query(api.finances.budgetsGlanceScopes, {});
    // One option means the client renders no picker at all, which is the
    // whole point: a member's screen is unchanged by this feature.
    expect(scopes).toHaveLength(1);
    expect(scopes[0].key).toBe(s.chapterId);
  });
});

/**
 * TAPPING A BAR — `budgetGlance.expenses`'s `month` argument.
 *
 * Founder, 2026-08-14: "when expanding make the graph interactive."
 *
 * The charges behind March cannot be filtered client-side. Which txns fall in
 * a budget's window is `txnCountsTowardBudget`'s decision — it depends on the
 * budget's cadence and its own month/quarter narrowers — and a client
 * re-implementing that as a date comparison would drift from the card above it
 * the first time either rule changed.
 */
describe("the drop-down can report a window other than today's", () => {
  test("a monthly bucket's chosen month returns THAT month's charges", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const thisYear = new Date().getFullYear();
    const budgetId = await seedBudget(s, {
      amountCents: 50_000,
      year: thisYear,
      cadence: "monthly",
      type: "recurring",
      label: "Operating Expenses",
    });
    await seedCharge(s, {
      budgetId,
      amountCents: 7_000,
      postedAt: tsOn(thisYear, 2, 4),
      merchantName: "February store",
    });
    await seedCharge(s, {
      budgetId,
      amountCents: 3_000,
      postedAt: tsOn(thisYear, 3, 9),
      merchantName: "March store",
    });

    const feb = await s.as.query(api.budgetGlance.expenses, { budgetId, month: 2 });
    expect(feb!.spentCents).toBe(7_000);
    expect(feb!.lines.map((l) => l.merchantName)).toEqual(["February store"]);
    // …and it says which window it's reporting, in words that aren't "this
    // month" — the reader tapped a bar precisely to leave today.
    expect(feb!.windowLabel).toBe("in Feb");

    const mar = await s.as.query(api.budgetGlance.expenses, { budgetId, month: 3 });
    expect(mar!.spentCents).toBe(3_000);
    expect(mar!.windowLabel).toBe("in Mar");
  });

  test("a quarterly bucket takes any month OF the quarter and reports the quarter", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const thisYear = new Date().getFullYear();
    const budgetId = await seedBudget(s, {
      amountCents: 40_000,
      year: thisYear,
      cadence: "quarterly",
      type: "recurring",
      label: "Culture Fund",
    });
    // Two charges in different MONTHS of the same quarter — both belong to Q1.
    await seedCharge(s, { budgetId, amountCents: 5_000, postedAt: tsOn(thisYear, 1, 8) });
    await seedCharge(s, { budgetId, amountCents: 6_000, postedAt: tsOn(thisYear, 3, 20) });
    await seedCharge(s, { budgetId, amountCents: 9_000, postedAt: tsOn(thisYear, 5, 2) });

    const q1 = await s.as.query(api.budgetGlance.expenses, { budgetId, month: 1 });
    expect(q1!.spentCents).toBe(11_000);
    expect(q1!.windowLabel).toBe("in Q1");
    const q2 = await s.as.query(api.budgetGlance.expenses, { budgetId, month: 4 });
    expect(q2!.spentCents).toBe(9_000);
    expect(q2!.windowLabel).toBe("in Q2");
  });

  test("an out-of-range month falls back to today rather than widening the window", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const thisYear = new Date().getFullYear();
    const budgetId = await seedBudget(s, {
      amountCents: 50_000,
      year: thisYear,
      cadence: "monthly",
      type: "recurring",
      label: "Operating Expenses",
    });
    await seedCharge(s, { budgetId, amountCents: 7_000, postedAt: tsOn(thisYear, 2, 4) });

    // A month of 0 or 13 would reach `budgetEffectivePeriod` as a value it
    // can't resolve, which silently widens the window to the WHOLE YEAR — the
    // one outcome that makes a per-window number wrong rather than empty.
    const bad = await s.as.query(api.budgetGlance.expenses, { budgetId, month: 99 });
    const today = await s.as.query(api.budgetGlance.expenses, { budgetId });
    expect(bad!.spentCents).toBe(today!.spentCents);
    expect(bad!.windowLabel).toBe(today!.windowLabel);
  });

  test("THE CULTURE FUND BUG: a stray `quarter` no longer hides a quarterly bucket's year", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const thisYear = new Date().getFullYear();
    // Founder, 2026-08-14: "Culture Fund does not show anything even though
    // there are Q1 and Q3 spendings." A $400-a-quarter bucket carrying a
    // `quarter` from the day it was created reported "$0.00 of $400.00 THIS
    // QUARTER" — the pin froze its window to Q1 while the label kept naming
    // the current quarter, so real spend in later quarters was invisible and
    // the bucket looked unused.
    const budgetId = await seedBudget(s, {
      amountCents: 40_000,
      year: thisYear,
      quarter: 1,
      cadence: "quarterly",
      type: "recurring",
      label: "Culture Fund",
    });
    // Spend in Q1 and in Q2 — neither of which is the current quarter for most
    // of the year.
    await seedCharge(s, { budgetId, amountCents: 15_000, postedAt: tsOn(thisYear, 2, 10) });
    await seedCharge(s, { budgetId, amountCents: 9_000, postedAt: tsOn(thisYear, 5, 4) });

    const glance = await s.as.query(api.finances.budgetsGlance, {});
    const row = glance.recurring.find((r) => r.id === budgetId)!;
    const byLabel = new Map(row.periods!.map((p) => [p.label, p.spentCents]));
    const nowQuarter = Math.ceil(glance.month / 3);
    // The whole year is charted, and each charge sits in the quarter it was
    // posted in rather than all of them landing in Q1.
    expect(row.periods!.length).toBeGreaterThan(1);
    expect(byLabel.get("Q1")).toBe(15_000);
    expect(byLabel.get("Q2")).toBe(nowQuarter >= 2 ? 9_000 : undefined);
    // The headline now means what it says: the CURRENT quarter's spend.
    const expectedNow =
      nowQuarter === 1 ? 15_000 : nowQuarter === 2 ? 9_000 : 0;
    expect(row.spentCents).toBe(expectedNow);
  });

  test("every window carries the month the drop-down needs to ask for it", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const thisYear = new Date().getFullYear();
    const monthlyId = await seedBudget(s, {
      amountCents: 50_000,
      year: thisYear,
      cadence: "monthly",
      type: "recurring",
      label: "Operating",
    });
    await seedCharge(s, { budgetId: monthlyId, amountCents: 1_000, postedAt: tsOn(thisYear, 1, 3) });
    const quarterlyId = await seedBudget(s, {
      amountCents: 40_000,
      year: thisYear,
      cadence: "quarterly",
      type: "recurring",
      label: "Culture",
    });
    await seedCharge(s, { budgetId: quarterlyId, amountCents: 1_000, postedAt: tsOn(thisYear, 1, 3) });

    const glance = await s.as.query(api.finances.budgetsGlance, {});
    const monthly = glance.recurring.find((r) => r.id === monthlyId)!.periods!;
    const quarterly = glance.recurring.find((r) => r.id === quarterlyId)!.periods!;
    // Monthly: the window's own month. Quarterly: the quarter's FIRST month,
    // which is what makes `expenses({month})` resolve back to the same window.
    expect(monthly.slice(0, 3).map((p) => p.month)).toEqual([1, 2, 3]);
    expect(quarterly.slice(0, 3).map((p) => p.month)).toEqual([1, 4, 7]);
  });
});

/**
 * THE OTHER HALF OF THE PIN RULE.
 *
 * Making a repeating cadence ignore `month`/`quarter` is only right because a
 * NON-repeating one still honors it. "The May retreat's budget" is May's
 * whatever month you open it in, and that is what `per_instance` / `one_off`
 * cadences are for. Without this test the fix reads as "pins don't work",
 * which is a much bigger and wrong change.
 */
describe("a one-off budget still owns its declared window", () => {
  test("a one_off budget pinned to a month counts only that month's charges", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const thisYear = new Date().getFullYear();
    const budgetId = await seedBudget(s, {
      amountCents: 30_000,
      year: thisYear,
      month: 3,
      cadence: "one_off",
      type: "recurring", // legacy shape: cadence is what pins it, not `type`
      label: "March mailing",
    });
    await seedCharge(s, { budgetId, amountCents: 4_000, postedAt: tsOn(thisYear, 3, 12) });
    await seedCharge(s, { budgetId, amountCents: 8_000, postedAt: tsOn(thisYear, 6, 12) });

    const detail = await s.as.query(api.budgetGlance.expenses, { budgetId });
    // March's charge only — the June one is outside the budget's own window,
    // and asking in August doesn't move that window to August.
    expect(detail!.spentCents).toBe(4_000);
  });
});
