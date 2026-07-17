/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { CORE_MODULES } from "@events-os/shared";

/**
 * Money views (WP-3.3) — `moneyViews.refMoney`, the event/project "what's
 * this thing costing?" rollup: budget header + planned-vs-actual by category
 * + the unplanned-spend bucket + multi-budget summing (#171) + authz that
 * mirrors `finances.dashboardChapter`'s central drill-down /
 * `events.ts#resolvePeekChapterId` (own-chapter viewer OK, foreign
 * non-central gets the quiet empty shape — NOT a throw, matching
 * `events.get`'s uniform not-found pattern so an existence oracle can't leak
 * cross-chapter record existence — central OK for foreign).
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

  test("a chapter-scoped manager reading a different chapter's event gets the quiet empty shape (existence oracle closed, not FORBIDDEN)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    const boston = await makeChapter(s, "Boston");
    const eventId = await seedEvent(s, boston, { name: "Boston Event" });

    // Same shape as a NONEXISTENT ref (see the "nonexistent ref" test below) —
    // a caller without central reach must not be able to tell "doesn't exist"
    // apart from "exists in a chapter I can't see".
    const result = await s.as.query(api.moneyViews.refMoney, {
      refKind: "event",
      refId: eventId,
    });
    expect(result.budget).toBeNull();
    expect(result.categories).toEqual([]);
    expect(result.transactions).toEqual([]);
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
    expect(result.unallocatedPlannedCents).toBe(0);
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
      // No `approvalStatus` was ever stamped on this budget → grandfathered,
      // reads as the EFFECTIVE `"approved"` (`effectiveBudgetApprovalStatus`).
      approvalStatus: "approved",
      approvedCents: null,
      requestedCents: 50000,
      reviewNote: null,
      // A plain chapter VIEWER (not bookkeeper+) — can read the plan, can't
      // write it.
      canEditPlan: false,
    });
    expect(result.categories).toEqual([]);
    expect(result.lineCount).toBe(0);
    expect(result.totalPlannedCents).toBe(50000);
    expect(result.totalActualCents).toBe(0);
    expect(result.totalRemainingCents).toBe(50000);
    // No lines at all → the entire budget is unallocated.
    expect(result.unallocatedPlannedCents).toBe(50000);
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
    // Lines sum to 40000 + 20000 + 10000 + 5000 = 75000 against a 100000
    // budget → 25000 still unallocated to any category.
    expect(result.unallocatedPlannedCents).toBe(25000);
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
    // No lines seeded on either budget → the full 40000 is unallocated.
    expect(result.unallocatedPlannedCents).toBe(40000);
  });

  test("a project's budget that moved to central sums BOTH its planned total AND its actual spend — the view follows the money, not the ref's fixed home chapter (fixes a Central project under-reporting $0 actuals)", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: "seyi@publicworship.life" }); // superuser = central
    const projectId = await seedProject(s, s.chapterId, "Music Recording");
    const budgetId = await seedOneTimeBudget(s, "central", "project", projectId, {
      amountCents: 300000,
      label: "Central music budget",
    });
    // This transaction's chapterId is "central" (it moved with the budget),
    // NOT the project's own chapterId (`s.chapterId`, which never changes —
    // WP-2.2: projects have no central union on the row itself).
    const txnId = await seedTxn(s, "central", budgetId, { amountCents: 15000 });

    const result = await s.as.query(api.moneyViews.refMoney, {
      refKind: "project",
      refId: projectId,
    });
    expect(result.budget?.id).toBe(budgetId);
    // Planned total still sums every by_ref budget regardless of level.
    expect(result.totalPlannedCents).toBe(300000);
    // Actual spend is filtered to THIS BUDGET's own current chapterId
    // (central), NOT the ref's fixed home chapter — so the Money view keeps
    // reporting the project's actuals once `transferProjectScope` has moved
    // it, matching the "Belongs to: Central" label on the project page
    // instead of silently zeroing out. `finances.ts#actualsForRef`
    // (`projectActuals`/`eventActuals`) is intentionally DIFFERENT — it's
    // keyed to the CALLER'S OWN chapter (a chapter-dashboard read), so it
    // correctly still drops this once the money leaves that chapter; this
    // view answers "what does this project cost" for whoever can already see
    // it, regardless of level.
    expect(result.totalActualCents).toBe(15000);
    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0].id).toBe(txnId);
    // No lines seeded → the full 300000 is unallocated.
    expect(result.unallocatedPlannedCents).toBe(300000);
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

// NOTE: there used to be an "approval state" describe block here, seeding
// fake `approvals` rows with `subjectType:"budget"` and asserting a derived
// `approvalState`. Nothing in the codebase actually writes an approvals row
// with that subjectType (verified codebase-wide) — the derivation was dead
// code exercised only by its own fake-seeded tests. Deleted along with the
// derivation itself: `refMoney` now reads the REAL `budgets.approvalStatus`
// (WP-3.2, merged) through `effectiveBudgetApprovalStatus`/`effectiveCapCents`
// — see the "approval-aware cap + canEditPlan" block below for live coverage.

// ── Approval-aware cap + "Edit plan" write gate ──────────────────────────────

describe("moneyViews.refMoney: approval-aware cap + canEditPlan", () => {
  test("a budget with a pending, not-yet-approved increase reports the OLD approved cap, not the raw amountCents", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    const eventId = await seedEvent(s, s.chapterId, { name: "Retreat" });
    const budgetId = await seedOneTimeBudget(s, s.chapterId, "event", eventId, {
      amountCents: 80000, // the pending, not-yet-approved increase
    });
    await run(s.t, (ctx) =>
      ctx.db.patch(budgetId, {
        approvalStatus: "submitted",
        approvedCents: 50000, // the still-in-force cap
      }),
    );

    const result = await s.as.query(api.moneyViews.refMoney, {
      refKind: "event",
      refId: eventId,
    });
    expect(result.budget?.amountCents).toBe(50000); // effective cap, not 80000
    expect(result.budget?.approvalStatus).toBe("submitted");
    expect(result.budget?.approvedCents).toBe(50000);
    expect(result.budget?.requestedCents).toBe(80000); // raw amountCents
    expect(result.totalPlannedCents).toBe(50000); // sums the effective cap too
    expect(result.totalRemainingCents).toBe(50000);
  });

  test("canEditPlan: a chapter BOOKKEEPER on their own chapter's event CAN edit; a VIEWER cannot", async () => {
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
    const eventId = await seedEvent(s, s.chapterId, { name: "Retreat" });
    await seedOneTimeBudget(s, s.chapterId, "event", eventId, { amountCents: 10000 });

    const result = await s.as.query(api.moneyViews.refMoney, {
      refKind: "event",
      refId: eventId,
    });
    expect(result.budget?.canEditPlan).toBe(true);
  });

  test("canEditPlan: a central-reach caller peeking a FOREIGN chapter's chapter-owned (not central) budget CANNOT edit — loadOwningBudget would 404", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentralManager(s);
    const boston = await makeChapter(s, "Boston");
    const eventId = await seedEvent(s, boston, { name: "Boston Event" });
    // Chapter-owned by Boston, NEVER moved to central — the caller's central
    // reach doesn't help here; only Boston's own bookkeeper+ can write it.
    await seedOneTimeBudget(s, boston, "event", eventId, { amountCents: 10000 });

    const result = await s.as.query(api.moneyViews.refMoney, {
      refKind: "event",
      refId: eventId,
    });
    expect(result.budget).not.toBeNull();
    expect(result.budget?.canEditPlan).toBe(false);
  });

  test("canEditPlan: a central bookkeeper+ CAN edit a CENTRAL-owned budget on a foreign ref", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentralManager(s); // central + manager (>= bookkeeper)
    const boston = await makeChapter(s, "Boston");
    const eventId = await seedEvent(s, boston, { name: "Boston Event" });
    await seedOneTimeBudget(s, "central", "event", eventId, { amountCents: 10000 });

    const result = await s.as.query(api.moneyViews.refMoney, {
      refKind: "event",
      refId: eventId,
    });
    expect(result.budget?.canEditPlan).toBe(true);
  });

  test("canSummonBudget: true for a bookkeeper+ on their own budget-less event, false for a viewer", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s); // manager >= bookkeeper
    const eventId = await seedEvent(s, s.chapterId, { name: "Bare Event" });

    const result = await s.as.query(api.moneyViews.refMoney, {
      refKind: "event",
      refId: eventId,
    });
    expect(result.budget).toBeNull();
    expect(result.canSummonBudget).toBe(true);
  });

  test("incomeCents: sums eventPages revenueCents + donationsCents for the event", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterViewer(s);
    const eventId = await seedEvent(s, s.chapterId, { name: "Ticketed Night" });
    await run(s.t, (ctx) =>
      ctx.db.insert("eventPages", {
        eventId,
        chapterId: s.chapterId,
        slug: `ticketed-night-${Date.now()}`,
        published: true,
        goingCount: 0,
        maybeCount: 0,
        notGoingCount: 0,
        ticketsSoldCount: 0,
        revenueCents: 12000,
        donationsCents: 3000,
        createdBy: s.userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );

    const result = await s.as.query(api.moneyViews.refMoney, {
      refKind: "event",
      refId: eventId,
    });
    expect(result.incomeCents).toBe(15000);
  });
});

// ── Event cost grid (phase 2) ────────────────────────────────────────────────

async function seedEventItem(
  s: ChapterSetup,
  eventId: Id<"events">,
  module: string,
  opts: { title?: string; status?: string; cost?: number; fields?: Record<string, unknown> } = {},
): Promise<Id<"eventItems">> {
  const fields = {
    ...(opts.cost !== undefined ? { cost: opts.cost } : {}),
    ...(opts.fields ?? {}),
  };
  return await run(s.t, (ctx) =>
    ctx.db.insert("eventItems", {
      eventId,
      chapterId: s.chapterId,
      module,
      title: opts.title ?? "Item",
      order: 0,
      status: opts.status,
      fields: Object.keys(fields).length > 0 ? fields : undefined,
    }),
  );
}

/** Clone an `eventModules` row — display label for a module, exactly like
 *  `lib/templates.ts#instantiateEvent` clones one per active module at event
 *  creation. Defaults to the module's REAL `CORE_MODULES` label when known,
 *  so grid `typeLabel` assertions match real production copy. */
async function seedEventModule(
  s: ChapterSetup,
  eventId: Id<"events">,
  module: string,
  opts: { label?: string; order?: number } = {},
): Promise<Id<"eventModules">> {
  const coreLabel = CORE_MODULES.find((m) => m.key === module)?.label;
  return await run(s.t, (ctx) =>
    ctx.db.insert("eventModules", {
      eventId,
      key: module,
      label: opts.label ?? coreLabel ?? module,
      order: opts.order ?? 0,
    }),
  );
}

/** Clone an `eventColumns` row — exactly like `instantiateEvent` clones the
 *  template's columns per-event. Defaults to a `currency` column (the type
 *  `eventCostGrid` sweeps for). */
async function seedEventColumn(
  s: ChapterSetup,
  eventId: Id<"events">,
  module: string,
  key: string,
  opts: { label?: string; type?: "currency" | "text" | "number"; order?: number } = {},
): Promise<Id<"eventColumns">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("eventColumns", {
      eventId,
      module,
      key,
      label: opts.label ?? key,
      kind: "custom",
      type: opts.type ?? "currency",
      isVisible: true,
      order: opts.order ?? 0,
    }),
  );
}

/** Clone the DEFAULT cost-bearing setup — a `cost`-keyed currency column
 *  (+ its module's real label) on each of the given modules. Mirrors what a
 *  real event gets from an unmodified template for Tasks/Supplies/Comms. */
async function seedDefaultCostSetup(
  s: ChapterSetup,
  eventId: Id<"events">,
  modules: string[],
): Promise<void> {
  for (const module of modules) {
    await seedEventModule(s, eventId, module);
    await seedEventColumn(s, eventId, module, "cost", { label: "Cost" });
  }
}

async function seedPerson(s: ChapterSetup, name: string): Promise<Id<"people">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name,
      isTeamMember: true,
      createdAt: Date.now(),
    }),
  );
}

async function seedPaidEngagement(
  s: ChapterSetup,
  eventId: Id<"events">,
  personId: Id<"people">,
  opts: { amountUsd?: number; paymentStatus?: "unpaid" | "invoiced" | "paid" } = {},
): Promise<Id<"engagements">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("engagements", {
      chapterId: s.chapterId,
      eventId,
      personId,
      type: "paid",
      status: "confirmed",
      amountUsd: opts.amountUsd,
      paymentStatus: opts.paymentStatus ?? "unpaid",
      createdAt: Date.now(),
    }),
  );
}

describe("moneyViews.eventCostGrid", () => {
  test("collects Tasks/Supplies/Comms costs, paid vendors, and budget lines into one flat list", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    const eventId = await seedEvent(s, s.chapterId, { name: "Big Night" });
    await seedDefaultCostSetup(s, eventId, ["planning_doc", "supplies", "comms"]);

    await seedEventItem(s, eventId, "planning_doc", { title: "Sound tech", cost: 150, status: "in_progress" });
    await seedEventItem(s, eventId, "supplies", { title: "Coffee", cost: 40 });
    await seedEventItem(s, eventId, "comms", { title: "Flyer print", cost: 25 });
    // run_of_show has NO currency column cloned onto this event — a dead end.
    await seedEventItem(s, eventId, "run_of_show", { title: "Segment", cost: 999 });

    const person = await seedPerson(s, "DJ Sam");
    await seedPaidEngagement(s, eventId, person, { amountUsd: 300, paymentStatus: "paid" });

    const fundId = await seedFund(s, s.chapterId);
    const cat = await seedCategory(s, s.chapterId, fundId, "Venue");
    const budgetId = await seedOneTimeBudget(s, s.chapterId, "event", eventId, { amountCents: 100000 });
    await seedLine(s, budgetId, 20000, cat, 0);

    const result = await s.as.query(api.moneyViews.eventCostGrid, { eventId });
    expect(result.isTraining).toBe(false);
    expect(result.rows).toHaveLength(5); // NOT the run_of_show row

    const byId = new Map(result.rows.map((r) => [r.label, r]));
    expect(byId.get("Sound tech")).toMatchObject({
      sourceKind: "event_item",
      typeLabel: "Tasks", // the real CORE_MODULES label, not a hand-picked short form
      categoryName: "Tasks",
      plannedCents: 15000, // $150 -> cents
      status: "in_progress",
      sourceLink: `/event/${eventId}?tab=planning_doc`,
      linked: false,
      possibleDuplicate: false,
    });
    expect(byId.get("Coffee")).toMatchObject({
      typeLabel: "Supplies & Logistics",
      categoryName: "Supplies & Logistics",
      plannedCents: 4000,
    });
    expect(byId.get("Flyer print")).toMatchObject({
      typeLabel: "Comms Schedule",
      categoryName: "Comms Schedule",
      plannedCents: 2500,
    });
    expect(byId.get("DJ Sam")).toMatchObject({
      sourceKind: "vendor",
      typeLabel: "Vendors",
      categoryName: "Vendors",
      plannedCents: 30000, // $300 -> cents
      actualCents: 30000, // paid
      status: "paid",
      sourceLink: `/event/${eventId}?tab=crew`,
    });
    const lineRow = [...result.rows].find((r) => r.sourceKind === "budget_line")!;
    expect(lineRow).toMatchObject({
      typeLabel: "Budget lines",
      categoryName: "Venue",
      plannedCents: 20000,
      sourceLink: null,
      editable: true, // asChapterManager is bookkeeper+
      linked: false,
      possibleDuplicate: false,
    });

    expect(result.totalPlannedCents).toBe(15000 + 4000 + 2500 + 30000 + 20000);
  });

  test("excludes zero/negative/missing costs — a $0 or uncosted item never appears", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterViewer(s);
    const eventId = await seedEvent(s, s.chapterId);
    await seedDefaultCostSetup(s, eventId, ["planning_doc"]);
    await seedEventItem(s, eventId, "planning_doc", { title: "No cost set" });
    await seedEventItem(s, eventId, "planning_doc", { title: "Zero cost", cost: 0 });
    await seedEventItem(s, eventId, "planning_doc", { title: "Negative (bad data)", cost: -5 });

    const result = await s.as.query(api.moneyViews.eventCostGrid, { eventId });
    expect(result.rows).toHaveLength(0);
    expect(result.totalPlannedCents).toBe(0);
  });

  // ── Opus review follow-ups (PR #216): dynamic module sweep ────────────────

  test("a custom currency column on Permits (OUTSIDE the old 3-module allowlist) appears in the grid, and — keyed 'cost' — its figure agrees EXACTLY with events.get's budgetSpent", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    const eventId = await seedEvent(s, s.chapterId, { name: "Permit Night" });
    // A chapter customized Permits with a "Cost" column keyed "cost" —
    // columns.ts#addColumn's toKey("Cost") === "cost", the SAME key
    // events.ts#get's budgetSpent always reads regardless of module.
    await seedEventModule(s, eventId, "permits", { label: "Permits" });
    await seedEventColumn(s, eventId, "permits", "cost", { label: "Cost" });
    await seedEventItem(s, eventId, "permits", { title: "Noise permit", cost: 75 });

    const result = await s.as.query(api.moneyViews.eventCostGrid, { eventId });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      sourceKind: "event_item",
      typeLabel: "Permits",
      categoryName: "Permits",
      label: "Noise permit",
      plannedCents: 7500,
      sourceLink: `/event/${eventId}?tab=permits`,
    });

    // Both totals agree BY CONSTRUCTION: the grid's cents figure / 100 equals
    // the header's whole-dollar figure, since both ultimately read the SAME
    // `fields.cost` value on the SAME item.
    const eventData = await s.as.query(api.events.get, { eventId });
    expect(eventData?.budgetSpent).toBe(75);
    expect(result.totalPlannedCents / 100).toBe(eventData?.budgetSpent);
  });

  test("a custom currency column with a NON-'cost' key (e.g. Permits 'fee') is captured by the grid — a completeness improvement over budgetSpent, which stays key-blind to it", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    const eventId = await seedEvent(s, s.chapterId, { name: "Permit Night" });
    await seedEventModule(s, eventId, "permits", { label: "Permits" });
    await seedEventColumn(s, eventId, "permits", "fee", { label: "Fee" });
    await seedEventItem(s, eventId, "permits", { title: "Noise permit", fields: { fee: 40 } });

    const result = await s.as.query(api.moneyViews.eventCostGrid, { eventId });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ label: "Noise permit", plannedCents: 4000 });

    // budgetSpent NEVER sees this — it only ever reads the literal `cost`
    // key, so this row is a genuine grid-only completeness win, not a bug.
    const eventData = await s.as.query(api.events.get, { eventId });
    expect(eventData?.budgetSpent).toBe(0);
  });

  test("a module with MULTIPLE currency columns produces one row PER column, disambiguated by the column's own label", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    const eventId = await seedEvent(s, s.chapterId);
    await seedEventModule(s, eventId, "supplies", { label: "Supplies & Logistics" });
    await seedEventColumn(s, eventId, "supplies", "cost", { label: "Cost" });
    await seedEventColumn(s, eventId, "supplies", "deposit", { label: "Deposit" });
    await seedEventItem(s, eventId, "supplies", {
      title: "Tent rental",
      fields: { cost: 200, deposit: 50 },
    });

    const result = await s.as.query(api.moneyViews.eventCostGrid, { eventId });
    expect(result.rows).toHaveLength(2);
    const labels = result.rows.map((r) => r.label).sort();
    expect(labels).toEqual(["Tent rental — Cost", "Tent rental — Deposit"]);
    expect(result.totalPlannedCents).toBe(20000 + 5000);
  });

  test("a module with NO currency column contributes nothing, even with a real cost value in fields.cost (mirrors budgetSpent's key, not its module-blindness)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    const eventId = await seedEvent(s, s.chapterId);
    // run_of_show module cloned WITHOUT a currency column.
    await seedEventModule(s, eventId, "run_of_show", { label: "Run of Show" });
    await seedEventItem(s, eventId, "run_of_show", { title: "Segment", cost: 999 });

    const result = await s.as.query(api.moneyViews.eventCostGrid, { eventId });
    expect(result.rows).toHaveLength(0);
  });

  // ── Opus review follow-ups (PR #216): double-counting — linked merges,
  //    unlinked duplicates flagged ──────────────────────────────────────────

  test("a LINKED budget line (sourceRef -> the event item) MERGES into that item's row — no separate row, no double-count, category upgraded from the line", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    const eventId = await seedEvent(s, s.chapterId, { name: "Linked Test" });
    await seedDefaultCostSetup(s, eventId, ["planning_doc"]);
    const itemId = await seedEventItem(s, eventId, "planning_doc", {
      title: "Sound tech",
      cost: 150,
      status: "in_progress",
    });

    const fundId = await seedFund(s, s.chapterId);
    const cat = await seedCategory(s, s.chapterId, fundId, "Production");
    const budgetId = await seedOneTimeBudget(s, s.chapterId, "event", eventId, { amountCents: 100000 });
    // Directly seeded with sourceRef — no mutation sets this today (forward-
    // looking infra); this is exactly how a future "plan this task's cost in
    // Finances" flow would write it.
    await run(s.t, (ctx) =>
      ctx.db.insert("budgetLines", {
        budgetId,
        description: "Sound tech (finance plan copy)",
        categoryId: cat,
        plannedCents: 15000,
        sortOrder: 0,
        createdBy: s.userId,
        createdAt: Date.now(),
        sourceRef: { kind: "eventItem", id: String(itemId) },
      }),
    );

    const result = await s.as.query(api.moneyViews.eventCostGrid, { eventId });
    // ONE row (the module row), not two — the line never became its own row.
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      sourceKind: "event_item",
      label: "Sound tech", // module row's own label wins, not the line's
      plannedCents: 15000, // module row's own cost wins, not summed with the line
      categoryName: "Production", // upgraded from the linked line's REAL category
      linked: true,
      possibleDuplicate: false,
    });
    // No double-count: total is the module row's figure ONCE, not +15000 again.
    expect(result.totalPlannedCents).toBe(15000);
  });

  test("a DANGLING sourceRef (target not in the grid) falls back to a normal unlinked row — the line's plan data doesn't vanish", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    const eventId = await seedEvent(s, s.chapterId);
    const budgetId = await seedOneTimeBudget(s, s.chapterId, "event", eventId, { amountCents: 100000 });
    await run(s.t, (ctx) =>
      ctx.db.insert("budgetLines", {
        budgetId,
        description: "Orphaned link",
        plannedCents: 5000,
        sortOrder: 0,
        createdBy: s.userId,
        createdAt: Date.now(),
        // Points at an eventItem id that was never seeded (or has no
        // qualifying currency column) — nothing in the grid to merge into.
        sourceRef: { kind: "eventItem", id: "nonexistent_item_id" },
      }),
    );

    const result = await s.as.query(api.moneyViews.eventCostGrid, { eventId });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      sourceKind: "budget_line",
      label: "Orphaned link",
      plannedCents: 5000,
      linked: false,
    });
  });

  test("an UNLINKED budget line whose label overlaps a module row's is flagged possibleDuplicate on BOTH sides — and BOTH still count toward the total (nothing silently dropped)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    const eventId = await seedEvent(s, s.chapterId, { name: "Duplicate Risk" });
    await seedDefaultCostSetup(s, eventId, ["planning_doc"]);
    await seedEventItem(s, eventId, "planning_doc", { title: "Sound tech", cost: 150 });

    const budgetId = await seedOneTimeBudget(s, s.chapterId, "event", eventId, { amountCents: 100000 });
    // A realistically-colliding label — seeded directly (not via `seedLine`,
    // whose default description is a generic "Line") so the token overlap
    // with the Task above ("Sound tech") is deliberate and legible here.
    await run(s.t, (ctx) =>
      ctx.db.insert("budgetLines", {
        budgetId,
        description: "Sound tech deposit",
        plannedCents: 15000,
        sortOrder: 0,
        createdBy: s.userId,
        createdAt: Date.now(),
      }),
    );

    const result = await s.as.query(api.moneyViews.eventCostGrid, { eventId });
    expect(result.rows).toHaveLength(2); // NOT merged — nothing proves they're the same expense
    const task = result.rows.find((r) => r.sourceKind === "event_item")!;
    const line = result.rows.find((r) => r.sourceKind === "budget_line")!;
    expect(task.possibleDuplicate).toBe(true);
    expect(line.possibleDuplicate).toBe(true);
    expect(task.linked).toBe(false);
    expect(line.linked).toBe(false);
    // Both amounts still count — a visible over-count warning beats a
    // silent under-count.
    expect(result.totalPlannedCents).toBe(15000 + 15000);
  });

  test("DISTINCT labels never trigger a false-positive duplicate flag", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    const eventId = await seedEvent(s, s.chapterId);
    await seedDefaultCostSetup(s, eventId, ["planning_doc"]);
    await seedEventItem(s, eventId, "planning_doc", { title: "Sound tech", cost: 150 });
    const budgetId = await seedOneTimeBudget(s, s.chapterId, "event", eventId, { amountCents: 100000 });
    await seedLine(s, budgetId, 5000, undefined, 0);

    const result = await s.as.query(api.moneyViews.eventCostGrid, { eventId });
    expect(result.rows).toHaveLength(2);
    expect(result.rows.every((r) => r.possibleDuplicate === false)).toBe(true);
  });

  test("an UNPAID vendor has a null actualCents (committed, not yet spent)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterViewer(s);
    const eventId = await seedEvent(s, s.chapterId);
    const person = await seedPerson(s, "Caterer Co");
    await seedPaidEngagement(s, eventId, person, { amountUsd: 500, paymentStatus: "unpaid" });

    const result = await s.as.query(api.moneyViews.eventCostGrid, { eventId });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].actualCents).toBeNull();
    expect(result.rows[0].status).toBe("unpaid");
  });

  test("a budget-line row's editable flag mirrors canEditPlan — false for a plain viewer", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterViewer(s);
    const eventId = await seedEvent(s, s.chapterId);
    const budgetId = await seedOneTimeBudget(s, s.chapterId, "event", eventId, { amountCents: 10000 });
    await seedLine(s, budgetId, 5000);

    const result = await s.as.query(api.moneyViews.eventCostGrid, { eventId });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].editable).toBe(false);
  });

  test("a training event returns an empty grid (#172) even if it somehow has cost rows", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterViewer(s);
    const eventId = await seedEvent(s, s.chapterId, { isTraining: true });
    await seedEventItem(s, eventId, "planning_doc", { title: "Should not show", cost: 100 });

    const result = await s.as.query(api.moneyViews.eventCostGrid, { eventId });
    expect(result.isTraining).toBe(true);
    expect(result.rows).toHaveLength(0);
  });

  test("a nonexistent event returns the quiet empty shape (no throw)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterViewer(s);
    const eventId = await seedEvent(s, s.chapterId);
    await run(s.t, (ctx) => ctx.db.delete(eventId));

    const result = await s.as.query(api.moneyViews.eventCostGrid, { eventId });
    expect(result.rows).toEqual([]);
    expect(result.totalPlannedCents).toBe(0);
  });

  test("a foreign chapter's event with no central reach gets the quiet empty shape", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    const boston = await makeChapter(s, "Boston");
    const eventId = await seedEvent(s, boston);
    await seedEventItem(s, eventId, "planning_doc", { title: "Boston cost", cost: 50 });

    const result = await s.as.query(api.moneyViews.eventCostGrid, { eventId });
    expect(result.rows).toEqual([]);
  });
});
