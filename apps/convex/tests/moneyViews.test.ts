/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

/**
 * Money views (WP-3.3) — `moneyViews.refMoney`, the event/project "what's
 * this thing costing?" rollup: budget header + planned-vs-actual by category
 * + the unplanned-spend bucket + multi-budget summing (#171) + authz that
 * mirrors `finances.dashboardChapter`'s central drill-down /
 * `events.ts#resolvePeekChapterId` (own-chapter viewer OK, foreign
 * non-central FORBIDDEN, central OK for foreign).
 */

async function seedSelfPerson(s: ChapterSetup): Promise<Id<"people">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Caller",
      userId: s.userId,
      isTeamMember: true,
      createdAt: Date.now(),
    }),
  );
}

async function asChapterViewer(s: ChapterSetup): Promise<Id<"people">> {
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

/** A PLAIN person (not the superuser short-circuit) with genuine central reach. */
async function asCentralManager(s: ChapterSetup): Promise<Id<"people">> {
  const personId = await seedSelfPerson(s);
  await run(s.t, (ctx) =>
    ctx.db.insert("financeRoles", {
      chapterId: s.chapterId,
      personId,
      role: "manager",
      scope: "central",
      createdAt: Date.now(),
    }),
  );
  return personId;
}

async function makeChapter(s: ChapterSetup, name: string): Promise<Id<"chapters">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("chapters", { name, isActive: true, createdAt: Date.now() }),
  );
}

async function seedEvent(
  s: ChapterSetup,
  chapterId: Id<"chapters">,
  opts: { name?: string; eventDate?: number; isTraining?: boolean } = {},
): Promise<Id<"events">> {
  return await run(s.t, async (ctx) => {
    const eventTypeId = await ctx.db.insert("eventTypes", {
      chapterId,
      name: "Service",
      slug: `service-${Date.now()}-${Math.random()}`,
      version: 1,
      createdBy: s.userId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    return await ctx.db.insert("events", {
      chapterId,
      eventTypeId,
      templateVersion: 1,
      name: opts.name ?? "Sunday Gathering",
      eventDate: opts.eventDate ?? Date.now(),
      status: "planning",
      isTraining: opts.isTraining,
      createdBy: s.userId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
}

async function seedProject(
  s: ChapterSetup,
  chapterId: Id<"chapters">,
  name: string,
): Promise<Id<"projects">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("projects", {
      chapterId,
      name,
      status: "in_progress",
      createdBy: s.userId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
}

/** A one_time budget attached to a ref via a raw insert (bypasses
 *  `createBudget`'s one-budget-per-ref guard so multi-budget tests can seed
 *  a legacy duplicate on purpose). */
async function seedOneTimeBudget(
  s: ChapterSetup,
  chapterId: Id<"chapters"> | "central",
  refKind: "event" | "project",
  scopeRefId: string,
  opts: { amountCents?: number; label?: string; createdAt?: number } = {},
): Promise<Id<"budgets">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("budgets", {
      chapterId,
      amountCents: opts.amountCents ?? 100000,
      label: opts.label,
      type: "one_time",
      refKind,
      scopeRefId,
      cadence: "per_instance",
      year: 2026,
      createdBy: s.userId,
      createdAt: opts.createdAt ?? Date.now(),
    }),
  );
}

async function seedFund(s: ChapterSetup, chapterId: Id<"chapters">): Promise<Id<"funds">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("funds", {
      chapterId,
      name: "General Fund",
      restriction: "unrestricted",
      sortOrder: 0,
      isActive: true,
      createdAt: Date.now(),
    }),
  );
}

async function seedCategory(
  s: ChapterSetup,
  chapterId: Id<"chapters">,
  fundId: Id<"funds">,
  name: string,
): Promise<Id<"budgetCategories">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("budgetCategories", {
      chapterId,
      fundId,
      name,
      kind: "lineItem",
      isActive: true,
      createdAt: Date.now(),
    }),
  );
}

async function seedLine(
  s: ChapterSetup,
  budgetId: Id<"budgets">,
  plannedCents: number,
  categoryId?: Id<"budgetCategories">,
  sortOrder = 0,
): Promise<Id<"budgetLines">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("budgetLines", {
      budgetId,
      description: "Line",
      categoryId,
      plannedCents,
      sortOrder,
      createdBy: s.userId,
      createdAt: Date.now(),
    }),
  );
}

async function seedTxn(
  s: ChapterSetup,
  chapterId: Id<"chapters"> | "central",
  budgetId: Id<"budgets">,
  fields: Record<string, unknown> = {},
): Promise<Id<"transactions">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("transactions", {
      chapterId,
      budgetId,
      source: "manual",
      flow: "outflow",
      amountCents: 5000,
      postedAt: Date.now(),
      status: "categorized",
      createdAt: Date.now(),
      ...fields,
    }),
  );
}

// ── Authz ─────────────────────────────────────────────────────────────────────

describe("moneyViews.refMoney: authz", () => {
  test("a chapter viewer CAN read their own chapter's event", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterViewer(s);
    const eventId = await seedEvent(s, s.chapterId, { name: "Home Event" });

    const result = await s.as.query(api.moneyViews.refMoney, {
      refKind: "event",
      refId: eventId,
    });
    expect(result.refId).toBe(eventId);
    expect(result.budget).toBeNull();
  });

  test("a chapter-scoped manager CANNOT read a different chapter's event (FORBIDDEN)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    const boston = await makeChapter(s, "Boston");
    const eventId = await seedEvent(s, boston, { name: "Boston Event" });

    await expect(
      s.as.query(api.moneyViews.refMoney, { refKind: "event", refId: eventId }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("a PLAIN person with a genuine scope:\"central\" grant CAN read a different chapter's event (not the superuser short-circuit)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentralManager(s);
    const boston = await makeChapter(s, "Boston");
    const eventId = await seedEvent(s, boston, { name: "Boston Event" });

    const result = await s.as.query(api.moneyViews.refMoney, {
      refKind: "event",
      refId: eventId,
    });
    expect(result.refId).toBe(eventId);
  });

  test("a superuser (implicit central) CAN read a different chapter's project", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: "seyi@publicworship.life" });
    const boston = await makeChapter(s, "Boston");
    const projectId = await seedProject(s, boston, "Boston Choir Retreat");

    const result = await s.as.query(api.moneyViews.refMoney, {
      refKind: "project",
      refId: projectId,
    });
    expect(result.refId).toBe(projectId);
  });

  test("a caller with no finance role at all CANNOT read their own chapter's event", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s, s.chapterId, { name: "Home Event" });

    await expect(
      s.as.query(api.moneyViews.refMoney, { refKind: "event", refId: eventId }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("a caller with no home chapter reading a real foreign event gets NO_CHAPTER", async () => {
    const t2 = newT();
    const userId = await run(t2, (ctx) => ctx.db.insert("users", { email: "nobody@publicworship.life" }));
    const as = t2.withIdentity({ subject: `${userId}|session`, issuer: "test" });
    const chapterId = await run(t2, (ctx) =>
      ctx.db.insert("chapters", { name: "Boston", isActive: true, createdAt: Date.now() }),
    );
    const eventTypeId = await run(t2, (ctx) =>
      ctx.db.insert("eventTypes", {
        chapterId,
        name: "Service",
        slug: "service",
        version: 1,
        createdBy: userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    const eventId = await run(t2, (ctx) =>
      ctx.db.insert("events", {
        chapterId,
        eventTypeId,
        templateVersion: 1,
        name: "Boston Event",
        eventDate: Date.now(),
        status: "planning",
        createdBy: userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );

    await expect(
      as.query(api.moneyViews.refMoney, { refKind: "event", refId: eventId }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("a nonexistent ref quietly returns the empty shape (no throw)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterViewer(s);
    const eventId = await seedEvent(s, s.chapterId, { name: "Real Event" });
    // Delete it, then query the now-dangling id.
    await run(s.t, (ctx) => ctx.db.delete(eventId));

    const result = await s.as.query(api.moneyViews.refMoney, {
      refKind: "event",
      refId: eventId,
    });
    expect(result.budget).toBeNull();
    expect(result.categories).toEqual([]);
  });
});

// ── Empty states ─────────────────────────────────────────────────────────────

describe("moneyViews.refMoney: empty states", () => {
  test("no budget yet → budget null, zero totals, empty categories/transactions", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterViewer(s);
    const eventId = await seedEvent(s, s.chapterId, { name: "Bare Event" });

    const result = await s.as.query(api.moneyViews.refMoney, {
      refKind: "event",
      refId: eventId,
    });
    expect(result.budget).toBeNull();
    expect(result.categories).toEqual([]);
    expect(result.unplannedCents).toBe(0);
    expect(result.transactions).toEqual([]);
    expect(result.totalPlannedCents).toBe(0);
    expect(result.totalActualCents).toBe(0);
    expect(result.totalRemainingCents).toBe(0);
    expect(result.lineCount).toBe(0);
  });

  test("budget with no lines and no spend → planned-only header, no category rows", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterViewer(s);
    const eventId = await seedEvent(s, s.chapterId, { name: "Planned Event" });
    const budgetId = await seedOneTimeBudget(s, s.chapterId, "event", eventId, {
      amountCents: 50000,
      label: "Sunday Gathering",
    });

    const result = await s.as.query(api.moneyViews.refMoney, {
      refKind: "event",
      refId: eventId,
    });
    expect(result.budget).toEqual({
      id: budgetId,
      amountCents: 50000,
      label: "Sunday Gathering",
      approvalState: null,
    });
    expect(result.categories).toEqual([]);
    expect(result.lineCount).toBe(0);
    expect(result.totalPlannedCents).toBe(50000);
    expect(result.totalActualCents).toBe(0);
    expect(result.totalRemainingCents).toBe(50000);
  });

  test("budget with lines but no spend → planned-only view (actualCents 0 per category)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterViewer(s);
    const eventId = await seedEvent(s, s.chapterId, { name: "Planned Event" });
    const fundId = await seedFund(s, s.chapterId);
    const peopleCat = await seedCategory(s, s.chapterId, fundId, "People");
    const budgetId = await seedOneTimeBudget(s, s.chapterId, "event", eventId, {
      amountCents: 30000,
    });
    await seedLine(s, budgetId, 20000, peopleCat);

    const result = await s.as.query(api.moneyViews.refMoney, {
      refKind: "event",
      refId: eventId,
    });
    expect(result.categories).toEqual([
      { categoryId: peopleCat, categoryName: "People", plannedCents: 20000, actualCents: 0 },
    ]);
    expect(result.unplannedCents).toBe(0);
    expect(result.transactions).toEqual([]);
  });
});

// ── Category grouping + unplanned bucket math ────────────────────────────────

describe("moneyViews.refMoney: category grouping + unplanned bucket", () => {
  test("planned-vs-actual per category, an uncategorized planned line, and an unplanned category bucket", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterViewer(s);
    const eventId = await seedEvent(s, s.chapterId, { name: "Big Event" });
    const fundId = await seedFund(s, s.chapterId);
    const peopleCat = await seedCategory(s, s.chapterId, fundId, "People");
    const locationCat = await seedCategory(s, s.chapterId, fundId, "Location");
    const gearCat = await seedCategory(s, s.chapterId, fundId, "Gear"); // planned, no spend
    const surpriseCat = await seedCategory(s, s.chapterId, fundId, "Surprise"); // spend, no plan

    const budgetId = await seedOneTimeBudget(s, s.chapterId, "event", eventId, {
      amountCents: 100000,
    });
    await seedLine(s, budgetId, 40000, peopleCat, 0);
    await seedLine(s, budgetId, 20000, locationCat, 1);
    await seedLine(s, budgetId, 10000, gearCat, 2);
    await seedLine(s, budgetId, 5000, undefined, 3); // uncategorized planned line

    // Actual spend: People 35000, Location 22000, Surprise (unplanned) 4000,
    // uncategorized (matches the uncategorized plan) 3000.
    await seedTxn(s, s.chapterId, budgetId, { categoryId: peopleCat, amountCents: 35000 });
    await seedTxn(s, s.chapterId, budgetId, { categoryId: locationCat, amountCents: 22000 });
    await seedTxn(s, s.chapterId, budgetId, { categoryId: surpriseCat, amountCents: 4000 });
    await seedTxn(s, s.chapterId, budgetId, { amountCents: 3000 }); // categoryId undefined

    // Excluded from every total: a transfer, an excluded-status row, and a
    // personal charge — integer-cents math must not include any of these.
    await seedTxn(s, s.chapterId, budgetId, {
      categoryId: peopleCat,
      amountCents: 99999,
      flow: "transfer",
    });
    await seedTxn(s, s.chapterId, budgetId, {
      categoryId: peopleCat,
      amountCents: 88888,
      status: "excluded",
    });
    await seedTxn(s, s.chapterId, budgetId, {
      categoryId: peopleCat,
      amountCents: 77777,
      isPersonal: true,
    });
    // An inflow (a refund) never counts as spend either.
    await seedTxn(s, s.chapterId, budgetId, {
      categoryId: peopleCat,
      amountCents: 12345,
      flow: "inflow",
    });

    const result = await s.as.query(api.moneyViews.refMoney, {
      refKind: "event",
      refId: eventId,
    });

    const byCategory = new Map(
      result.categories.map((c) => [c.categoryId, c]),
    );
    expect(byCategory.get(peopleCat)).toEqual({
      categoryId: peopleCat,
      categoryName: "People",
      plannedCents: 40000,
      actualCents: 35000,
    });
    expect(byCategory.get(locationCat)).toEqual({
      categoryId: locationCat,
      categoryName: "Location",
      plannedCents: 20000,
      actualCents: 22000,
    });
    expect(byCategory.get(gearCat)).toEqual({
      categoryId: gearCat,
      categoryName: "Gear",
      plannedCents: 10000,
      actualCents: 0,
    });
    expect(byCategory.get(null)).toEqual({
      categoryId: null,
      categoryName: "Uncategorized",
      plannedCents: 5000,
      actualCents: 3000,
    });
    // Surprise has actual spend but no planned line → not a category row.
    expect(byCategory.has(surpriseCat)).toBe(false);
    expect(result.categories).toHaveLength(4);

    expect(result.unplannedCents).toBe(4000);
    // Total actual = 35000 + 22000 + 4000 + 3000 = 64000 (excludes transfer/
    // excluded/personal/inflow entirely).
    expect(result.totalActualCents).toBe(64000);
    expect(result.totalPlannedCents).toBe(100000);
    expect(result.totalRemainingCents).toBe(100000 - 64000);
  });
});

// ── Multi-budget summing (#171) ──────────────────────────────────────────────

describe("moneyViews.refMoney: multi-budget summing", () => {
  test("sums allocated + actual across every by_ref budget, header uses the earliest-created", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    const projectId = await seedProject(s, s.chapterId, "Music Recording");

    const firstBudget = await seedOneTimeBudget(s, s.chapterId, "project", projectId, {
      amountCents: 30000,
      label: "Original",
      createdAt: 1000,
    });
    const secondBudget = await seedOneTimeBudget(s, s.chapterId, "project", projectId, {
      amountCents: 10000,
      label: "Legacy duplicate",
      createdAt: 2000,
    });
    await seedTxn(s, s.chapterId, firstBudget, { amountCents: 5000 });
    await seedTxn(s, s.chapterId, secondBudget, { amountCents: 2000 });

    const result = await s.as.query(api.moneyViews.refMoney, {
      refKind: "project",
      refId: projectId,
    });

    expect(result.budget?.id).toBe(firstBudget);
    expect(result.budget?.label).toBe("Original");
    expect(result.totalPlannedCents).toBe(40000); // 30000 + 10000
    expect(result.totalActualCents).toBe(7000); // 5000 + 2000
    expect(result.transactions).toHaveLength(2);
  });

  test("a project's budget that moved to central still sums via by_ref (WP-2.2 discovery)", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: "seyi@publicworship.life" }); // superuser = central
    const projectId = await seedProject(s, s.chapterId, "Music Recording");
    const budgetId = await seedOneTimeBudget(s, "central", "project", projectId, {
      amountCents: 300000,
      label: "Central music budget",
    });
    await seedTxn(s, "central", budgetId, { amountCents: 15000 });

    const result = await s.as.query(api.moneyViews.refMoney, {
      refKind: "project",
      refId: projectId,
    });
    expect(result.budget?.id).toBe(budgetId);
    expect(result.totalPlannedCents).toBe(300000);
    expect(result.totalActualCents).toBe(15000);
  });
});

// ── Training events (#172) ────────────────────────────────────────────────────

describe("moneyViews.refMoney: training events", () => {
  test("isTraining surfaces true for a training event (no finance rows expected)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterViewer(s);
    const eventId = await seedEvent(s, s.chapterId, {
      name: "Training Sandbox",
      isTraining: true,
    });

    const result = await s.as.query(api.moneyViews.refMoney, {
      refKind: "event",
      refId: eventId,
    });
    expect(result.isTraining).toBe(true);
    expect(result.budget).toBeNull();
  });

  test("isTraining is always false for a project ref", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterViewer(s);
    const projectId = await seedProject(s, s.chapterId, "Some Project");

    const result = await s.as.query(api.moneyViews.refMoney, {
      refKind: "project",
      refId: projectId,
    });
    expect(result.isTraining).toBe(false);
  });
});

// ── Approval state (best-effort, from the generic `approvals` audit trail) ───

describe("moneyViews.refMoney: approval state", () => {
  test("null with no approvals recorded; reflects the most recent approve/reject action", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await asChapterManager(s);
    const eventId = await seedEvent(s, s.chapterId, { name: "Approved Event" });
    const budgetId = await seedOneTimeBudget(s, s.chapterId, "event", eventId, {
      amountCents: 20000,
    });

    const before = await s.as.query(api.moneyViews.refMoney, {
      refKind: "event",
      refId: eventId,
    });
    expect(before.budget?.approvalState).toBeNull();

    await run(s.t, (ctx) =>
      ctx.db.insert("approvals", {
        chapterId: s.chapterId,
        subjectType: "budget",
        subjectId: budgetId,
        action: "approve",
        actorPersonId: personId,
        createdAt: 1000,
      }),
    );
    const afterApprove = await s.as.query(api.moneyViews.refMoney, {
      refKind: "event",
      refId: eventId,
    });
    expect(afterApprove.budget?.approvalState).toBe("approved");

    // A LATER reject supersedes the earlier approve.
    await run(s.t, (ctx) =>
      ctx.db.insert("approvals", {
        chapterId: s.chapterId,
        subjectType: "budget",
        subjectId: budgetId,
        action: "reject",
        actorPersonId: personId,
        createdAt: 2000,
      }),
    );
    const afterReject = await s.as.query(api.moneyViews.refMoney, {
      refKind: "event",
      refId: eventId,
    });
    expect(afterReject.budget?.approvalState).toBe("rejected");
  });
});
