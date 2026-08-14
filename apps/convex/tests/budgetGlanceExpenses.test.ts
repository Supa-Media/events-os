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
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
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
    expect(detail!.name).toBe("Genesis LTN");

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
