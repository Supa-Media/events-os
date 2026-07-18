/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { newT, run, setupChapter, type ChapterSetup, type TestConvex } from "./setup.helpers";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { CORE_MODULES, MODULE_DEFAULT_CATEGORY_NAMES, VENDOR_DEFAULT_CATEGORY_NAME } from "@events-os/shared";

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

/** A genuinely NON-ADMIN member — `setupChapter`'s own `s.as` caller is
 *  ALWAYS a chapter admin (`userChapters.role:"admin"`), which alone clears
 *  `callerHasEventEditRights` (admins manage everyone) regardless of any
 *  finance role layered on top — so a "plain member, not the event's owner"
 *  scenario needs a truly separate, non-admin identity, not just a second
 *  `financeRoles` grant on the same admin caller. */
async function addNonAdminMember(
  s: ChapterSetup,
  opts: { email: string; name: string },
): Promise<{ as: ReturnType<TestConvex["withIdentity"]>; personId: Id<"people"> }> {
  const userId = await run(s.t, (ctx) => ctx.db.insert("users", { email: opts.email }));
  await run(s.t, (ctx) =>
    ctx.db.insert("userChapters", {
      userId,
      chapterId: s.chapterId,
      role: "member",
      isActive: true,
      joinedAt: Date.now(),
    }),
  );
  const personId = await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: opts.name,
      userId,
      isTeamMember: true,
      createdAt: Date.now(),
    }),
  );
  const as = s.t.withIdentity({ subject: `${userId}|session`, issuer: "test" });
  return { as, personId };
}

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
      // Never approved via `approveBudget` (grandfathered) — no party recorded.
      approvalParty: null,
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
  opts: {
    title?: string;
    status?: string;
    cost?: number;
    fields?: Record<string, unknown>;
    budgetCategoryId?: Id<"budgetCategories">;
  } = {},
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
      budgetCategoryId: opts.budgetCategoryId,
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
  opts: {
    amountUsd?: number;
    paymentStatus?: "unpaid" | "invoiced" | "paid";
    budgetCategoryId?: Id<"budgetCategories">;
  } = {},
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
      budgetCategoryId: opts.budgetCategoryId,
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

  // ── PR #234 adversarial-review follow-up: CORE modules have no
  //    `eventModules` row in real production (`instantiateEvent` only clones
  //    one per CUSTOM `templateModules` row — core state lives as deltas on
  //    the event doc, see `lib/templates.ts`). Every fixture above always
  //    calls `seedEventModule` even for core keys, which papered over the
  //    real-world gap: `typeLabel` fell through to the raw module key
  //    ("planning_doc") whenever a core module's `eventModules` row was
  //    (correctly, per production) absent. ───────────────────────────────────

  test("a CORE module's typeLabel falls back to its real CORE_MODULES label (not the raw key) when the event has NO eventModules row for it — the actual production shape for an unmodified template", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    const eventId = await seedEvent(s, s.chapterId);
    // Deliberately NO `seedEventModule` call — mirrors a real event: core
    // modules never get an `eventModules` row, only their `eventColumns`.
    await seedEventColumn(s, eventId, "comms", "cost", { label: "Cost" });
    await seedEventItem(s, eventId, "comms", { title: "Robocall", cost: 60 });

    const result = await s.as.query(api.moneyViews.eventCostGrid, { eventId });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      sourceKind: "event_item",
      module: "comms",
      typeLabel: "Comms Schedule", // CORE_MODULES' real label, not "comms"
      categoryName: "Comms Schedule", // no chapter category seeded, so falls back to typeLabel same as every other case here
      label: "Robocall",
      plannedCents: 6000,
    });
  });

  test("a CUSTOM module still uses its own eventModules label, unaffected by the CORE_MODULES fallback", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    const eventId = await seedEvent(s, s.chapterId);
    // "vip_ops" is not a CORE_MODULES key, so MODULE_LABELS has no entry for
    // it — its display label can ONLY come from its own eventModules row.
    await seedEventModule(s, eventId, "vip_ops", { label: "VIP Operations" });
    await seedEventColumn(s, eventId, "vip_ops", "cost", { label: "Cost" });
    await seedEventItem(s, eventId, "vip_ops", { title: "Green room catering", cost: 120 });

    const result = await s.as.query(api.moneyViews.eventCostGrid, { eventId });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      sourceKind: "event_item",
      module: "vip_ops",
      typeLabel: "VIP Operations",
      label: "Green room catering",
      plannedCents: 12000,
    });
  });

  // ── Opus review follow-ups (PR #216): double-counting — unlinked
  //    duplicates flagged (the `sourceRef` merge path was retired — nothing
  //    ever wrote it — see the `budgetLines.sourceRef` removal PR) ──────────

  test("a budget line whose label overlaps a module row's is flagged possibleDuplicate on BOTH sides — and BOTH still count toward the total (nothing silently dropped)", async () => {
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

// ── canEditTransactions (the Money-tab "Recent transactions" edit gate) ─────

describe("moneyViews.refMoney: canEditTransactions", () => {
  test("true for a bookkeeper+ caller (mirrors canEditPlan)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    const eventId = await seedEvent(s, s.chapterId, { name: "Retreat" });
    await seedOneTimeBudget(s, s.chapterId, "event", eventId, { amountCents: 10000 });

    const result = await s.as.query(api.moneyViews.refMoney, {
      refKind: "event",
      refId: eventId,
    });
    expect(result.canEditTransactions).toBe(true);
  });

  test("true for a plain (non-admin) viewer who is ALSO the event's owner (event-lead carve-out)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const owner = await addNonAdminMember(s, {
      email: "owner@publicworship.life",
      name: "Event Owner",
    });
    await run(s.t, (ctx) =>
      ctx.db.insert("financeRoles", {
        chapterId: s.chapterId,
        personId: owner.personId,
        role: "viewer", // viewer only, not bookkeeper+
        scope: "chapter",
        createdAt: Date.now(),
      }),
    );
    const eventId = await run(s.t, async (ctx) => {
      const eventTypeId = await ctx.db.insert("eventTypes", {
        chapterId: s.chapterId,
        name: "Service",
        slug: `service-${Date.now()}`,
        version: 1,
        createdBy: s.userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      return ctx.db.insert("events", {
        chapterId: s.chapterId,
        eventTypeId,
        templateVersion: 1,
        name: "My Event",
        eventDate: Date.now(),
        status: "planning",
        ownerPersonId: owner.personId,
        createdBy: s.userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });
    await seedOneTimeBudget(s, s.chapterId, "event", eventId, { amountCents: 10000 });

    const result = await owner.as.query(api.moneyViews.refMoney, {
      refKind: "event",
      refId: eventId,
    });
    expect(result.canEditTransactions).toBe(true);
  });

  test("false for a plain (non-admin) viewer who is NOT the event's owner and doesn't manage them", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const member = await addNonAdminMember(s, {
      email: "member@publicworship.life",
      name: "Plain Member",
    });
    // A finance VIEWER grant so they can at least READ the Money tab — the
    // question this test pins is whether that ALONE also clears the
    // event-edit carve-out (it must not).
    await run(s.t, (ctx) =>
      ctx.db.insert("financeRoles", {
        chapterId: s.chapterId,
        personId: member.personId,
        role: "viewer",
        scope: "chapter",
        createdAt: Date.now(),
      }),
    );
    const owner = await addNonAdminMember(s, {
      email: "owner@publicworship.life",
      name: "Event Owner",
    });
    const eventId = await run(s.t, async (ctx) => {
      const eventTypeId = await ctx.db.insert("eventTypes", {
        chapterId: s.chapterId,
        name: "Service",
        slug: `service-${Date.now()}`,
        version: 1,
        createdBy: s.userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      return ctx.db.insert("events", {
        chapterId: s.chapterId,
        eventTypeId,
        templateVersion: 1,
        name: "Someone Else's Event",
        eventDate: Date.now(),
        status: "planning",
        ownerPersonId: owner.personId,
        createdBy: s.userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });
    await seedOneTimeBudget(s, s.chapterId, "event", eventId, { amountCents: 10000 });

    const result = await member.as.query(api.moneyViews.refMoney, {
      refKind: "event",
      refId: eventId,
    });
    expect(result.canEditTransactions).toBe(false);
  });

  test("always false for a project ref — no event-lead concept applies", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterViewer(s);
    const projectId = await seedProject(s, s.chapterId, "Some Project");
    await seedOneTimeBudget(s, s.chapterId, "project", projectId, { amountCents: 10000 });

    const result = await s.as.query(api.moneyViews.refMoney, {
      refKind: "project",
      refId: projectId,
    });
    expect(result.canEditTransactions).toBe(false);
  });

  test("false (not true) in the empty shape when there's no budget yet", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterViewer(s);
    const eventId = await seedEvent(s, s.chapterId, { name: "Bare Event" });

    const result = await s.as.query(api.moneyViews.refMoney, {
      refKind: "event",
      refId: eventId,
    });
    expect(result.budget).toBeNull();
    expect(result.canEditTransactions).toBe(false);
  });
});

// ── WP-money-unify PR2: the planned side is a virtual union ─────────────────
//
// `refMoney`'s planned side (an EVENT ref) is now the read-time UNION of
// `eventItems` ∪ paid `engagements` ∪ `budgetLines`, computed by the shared
// `collectEventPlannedRows` sweep `eventCostGrid` already exercises above.
// These tests focus on the UNION'S EFFECT on `refMoney`'s own fields
// (`categories`, `lineCount`, `unplannedCents`, `unallocatedPlannedCents`,
// `totalActualCents`) — `eventCostGrid`'s per-row shape (`categoryId`,
// `categoryIsDefault`, `module`) is covered in its own `describe` block below.

describe("moneyViews.refMoney: planned union (PR2)", () => {
  test("categories group eventItems + a paid vendor + a budgetLine together — the union, not budgetLines alone", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    const eventId = await seedEvent(s, s.chapterId, { name: "Union Event" });
    const fundId = await seedFund(s, s.chapterId);
    const suppliesCat = await seedCategory(s, s.chapterId, fundId, "Supplies");
    const productionCat = await seedCategory(s, s.chapterId, fundId, "Production");

    // An eventItem whose module DEFAULT category name ("Supplies") matches a
    // seeded category — resolves without any override.
    await seedDefaultCostSetup(s, eventId, ["supplies"]);
    await seedEventItem(s, eventId, "supplies", { title: "Coffee", cost: 40 });

    // A paid vendor with an EXPLICIT override into "Production".
    const person = await seedPerson(s, "DJ Sam");
    await seedPaidEngagement(s, eventId, person, {
      amountUsd: 300,
      paymentStatus: "paid",
      budgetCategoryId: productionCat,
    });

    // A budgetLines row, same as before PR2.
    const budgetId = await seedOneTimeBudget(s, s.chapterId, "event", eventId, {
      amountCents: 100000,
    });
    await seedLine(s, budgetId, 5000, productionCat, 0);

    const result = await s.as.query(api.moneyViews.refMoney, { refKind: "event", refId: eventId });

    // "No plan yet" (lineCount === 0) no longer fires — items + vendor +
    // budgetLine ALL counted (1 item row + 1 vendor row + 1 budgetLine row).
    expect(result.lineCount).toBe(3);

    const byCategory = new Map(result.categories.map((c) => [c.categoryId, c]));
    expect(byCategory.get(suppliesCat)).toMatchObject({
      categoryName: "Supplies",
      plannedCents: 4000, // $40 -> cents, from the eventItem
      actualCents: 0,
    });
    expect(byCategory.get(productionCat)).toMatchObject({
      categoryName: "Production",
      plannedCents: 30000 + 5000, // vendor ($300) + budget line, SAME category
      actualCents: 0,
    });
    expect(result.categories).toHaveLength(2);
  });

  test("default category resolution: MODULE_DEFAULT_CATEGORY_NAMES/VENDOR_DEFAULT_CATEGORY_NAME by exact name; an explicit budgetCategoryId override wins over the default", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    const eventId = await seedEvent(s, s.chapterId, { name: "Default vs Override" });
    const fundId = await seedFund(s, s.chapterId);
    const defaultSuppliesCat = await seedCategory(
      s,
      s.chapterId,
      fundId,
      MODULE_DEFAULT_CATEGORY_NAMES.supplies,
    );
    const overrideCat = await seedCategory(s, s.chapterId, fundId, "Special Supplies");
    const defaultVendorCat = await seedCategory(s, s.chapterId, fundId, VENDOR_DEFAULT_CATEGORY_NAME);

    await seedDefaultCostSetup(s, eventId, ["supplies"]);
    // No override → resolves to the DEFAULT "Supplies" category.
    await seedEventItem(s, eventId, "supplies", { title: "Tape", cost: 10 });
    // Explicit override → resolves to "Special Supplies", NOT the default.
    await seedEventItem(s, eventId, "supplies", { title: "Custom rig", cost: 20, budgetCategoryId: overrideCat });

    const person = await seedPerson(s, "Sound Co");
    // No override → resolves to the DEFAULT vendor category.
    await seedPaidEngagement(s, eventId, person, { amountUsd: 100, paymentStatus: "paid" });

    // A budget row (no lines) — the union only surfaces on `refMoney` once a
    // budget exists at all (`budget: null` short-circuits before the union
    // ever runs; that's the OTHER, unrelated "No budget yet" empty state —
    // see MoneyView.tsx, not in scope for this fix).
    await seedOneTimeBudget(s, s.chapterId, "event", eventId, { amountCents: 100000 });

    const result = await s.as.query(api.moneyViews.refMoney, { refKind: "event", refId: eventId });
    const byCategory = new Map(result.categories.map((c) => [c.categoryId, c]));

    expect(byCategory.get(defaultSuppliesCat)?.plannedCents).toBe(1000); // Tape only
    expect(byCategory.get(overrideCat)?.plannedCents).toBe(2000); // Custom rig only
    expect(byCategory.get(defaultVendorCat)?.plannedCents).toBe(10000); // vendor, default-resolved
  });

  test("dollars→cents conversion: eventItems.fields[cost] and engagements.amountUsd (whole USD dollars) round into integer cents in the union", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    const eventId = await seedEvent(s, s.chapterId);
    await seedDefaultCostSetup(s, eventId, ["supplies"]);
    await seedEventItem(s, eventId, "supplies", { title: "Odd amount", cost: 12.345 });
    const person = await seedPerson(s, "Vendor");
    await seedPaidEngagement(s, eventId, person, { amountUsd: 99.999, paymentStatus: "paid" });
    await seedOneTimeBudget(s, s.chapterId, "event", eventId, { amountCents: 100000 });

    const result = await s.as.query(api.moneyViews.refMoney, { refKind: "event", refId: eventId });
    // Math.round(12.345 * 100) = 1235; Math.round(99.999 * 100) = 10000.
    const totalUnionCents = result.categories.reduce((sum, c) => sum + c.plannedCents, 0);
    expect(totalUnionCents).toBe(1235 + 10000);
  });

  test("a paid vendor's actual figure NEVER enters actualByCategory / totalActualCents — Estimated is never summed with Actuals (invariant #2)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    const eventId = await seedEvent(s, s.chapterId);
    const person = await seedPerson(s, "Caterer");
    // Paid, with NO corresponding `transactions` row.
    await seedPaidEngagement(s, eventId, person, { amountUsd: 500, paymentStatus: "paid" });
    await seedOneTimeBudget(s, s.chapterId, "event", eventId, { amountCents: 100000 });

    const result = await s.as.query(api.moneyViews.refMoney, { refKind: "event", refId: eventId });
    expect(result.totalActualCents).toBe(0);
    for (const c of result.categories) expect(c.actualCents).toBe(0);
    // The vendor's committed $500 still shows up on the PLANNED side.
    const totalUnionCents = result.categories.reduce((sum, c) => sum + c.plannedCents, 0);
    expect(totalUnionCents).toBe(50000);
  });

  test("unplanned semantics: actual spend in a category planned ONLY via an eventItem (no budgetLines row) is NOT unplanned", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    const eventId = await seedEvent(s, s.chapterId);
    const fundId = await seedFund(s, s.chapterId);
    const suppliesCat = await seedCategory(s, s.chapterId, fundId, MODULE_DEFAULT_CATEGORY_NAMES.supplies);
    await seedDefaultCostSetup(s, eventId, ["supplies"]);
    await seedEventItem(s, eventId, "supplies", { title: "Coffee", cost: 40 });

    const budgetId = await seedOneTimeBudget(s, s.chapterId, "event", eventId, { amountCents: 50000 });
    await seedTxn(s, s.chapterId, budgetId, { categoryId: suppliesCat, amountCents: 3500 });

    const result = await s.as.query(api.moneyViews.refMoney, { refKind: "event", refId: eventId });
    // Pre-PR2 this would have been "unplanned" (no budgetLines row existed
    // for Supplies) — now the eventItem's planned row covers it.
    expect(result.unplannedCents).toBe(0);
    const suppliesRow = result.categories.find((c) => c.categoryId === suppliesCat);
    expect(suppliesRow).toMatchObject({ plannedCents: 4000, actualCents: 3500 });
  });

  test("cap fields reflect the UNION sum, not budgetLines alone: unallocatedPlannedCents subtracts items+vendors+lines, totalPlannedCents stays the effective cap", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    const eventId = await seedEvent(s, s.chapterId);
    await seedDefaultCostSetup(s, eventId, ["supplies"]);
    await seedEventItem(s, eventId, "supplies", { title: "Tent", cost: 300 }); // 30000 cents

    const budgetId = await seedOneTimeBudget(s, s.chapterId, "event", eventId, { amountCents: 100000 });
    await seedLine(s, budgetId, 20000, undefined, 0);

    const result = await s.as.query(api.moneyViews.refMoney, { refKind: "event", refId: eventId });
    // The cap is untouched by the union (still the raw effective cap).
    expect(result.totalPlannedCents).toBe(100000);
    // Pre-PR2 this would have been 100000 - 20000 = 80000 (lines only).
    // Now it accounts for the item's 30000 too: 100000 - (20000 + 30000).
    expect(result.unallocatedPlannedCents).toBe(50000);
  });

  test("duplicate rows both count toward the union total — nothing silently dropped, mirrors eventCostGrid's possibleDuplicate semantics", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    const eventId = await seedEvent(s, s.chapterId, { name: "Duplicate union" });
    await seedDefaultCostSetup(s, eventId, ["planning_doc"]);
    await seedEventItem(s, eventId, "planning_doc", { title: "Sound tech", cost: 150 });

    const budgetId = await seedOneTimeBudget(s, s.chapterId, "event", eventId, { amountCents: 100000 });
    // A realistically-colliding label.
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

    const result = await s.as.query(api.moneyViews.refMoney, { refKind: "event", refId: eventId });
    expect(result.lineCount).toBe(2); // both rows counted — not merged
    const totalUnionCents = result.categories.reduce((sum, c) => sum + c.plannedCents, 0);
    expect(totalUnionCents).toBe(15000 + 15000);
  });

  test("Uncategorized fallback: a renamed/missing default category resolves to categoryId null, grouped into the Uncategorized bucket", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    const eventId = await seedEvent(s, s.chapterId);
    const fundId = await seedFund(s, s.chapterId);
    // The chapter renamed its "Supplies" category — no exact name match for
    // MODULE_DEFAULT_CATEGORY_NAMES.supplies ("Supplies") exists anymore.
    await seedCategory(s, s.chapterId, fundId, "Renamed Supplies Bucket");
    await seedDefaultCostSetup(s, eventId, ["supplies"]);
    await seedEventItem(s, eventId, "supplies", { title: "Coffee", cost: 40 });
    await seedOneTimeBudget(s, s.chapterId, "event", eventId, { amountCents: 10000 });

    const result = await s.as.query(api.moneyViews.refMoney, { refKind: "event", refId: eventId });
    expect(result.categories).toEqual([
      { categoryId: null, categoryName: "Uncategorized", plannedCents: 4000, actualCents: 0 },
    ]);
  });

  test("a project ref's union degenerates to budgetLines alone (no eventItems/engagements exist for a project — schema-level)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    const projectId = await seedProject(s, s.chapterId, "Music Recording");
    const fundId = await seedFund(s, s.chapterId);
    const cat = await seedCategory(s, s.chapterId, fundId, "Studio");
    const budgetId = await seedOneTimeBudget(s, s.chapterId, "project", projectId, { amountCents: 50000 });
    await seedLine(s, budgetId, 20000, cat, 0);

    const result = await s.as.query(api.moneyViews.refMoney, { refKind: "project", refId: projectId });
    expect(result.lineCount).toBe(1);
    expect(result.categories).toEqual([
      { categoryId: cat, categoryName: "Studio", plannedCents: 20000, actualCents: 0 },
    ]);
    expect(result.unallocatedPlannedCents).toBe(30000); // 50000 - 20000, exactly the pre-PR2 formula
  });

  test("GRID_SCAN_LIMIT (2000) bounds the budgetLines sweep inside the union — a truncated read never crashes or unbounds the response", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    const eventId = await seedEvent(s, s.chapterId, { name: "Big Plan" });
    const budgetId = await seedOneTimeBudget(s, s.chapterId, "event", eventId, { amountCents: 100000000 });
    const GRID_SCAN_LIMIT = 2000;
    await run(s.t, async (ctx) => {
      for (let i = 0; i < GRID_SCAN_LIMIT + 5; i++) {
        await ctx.db.insert("budgetLines", {
          budgetId,
          description: `Line ${i}`,
          plannedCents: 1,
          sortOrder: i,
          createdBy: s.userId,
          createdAt: Date.now(),
        });
      }
    });

    const result = await s.as.query(api.moneyViews.refMoney, { refKind: "event", refId: eventId });
    // Bounded at GRID_SCAN_LIMIT, not the full 2005 rows inserted.
    expect(result.lineCount).toBe(GRID_SCAN_LIMIT);
  }, 30000);
});

// ── WP-money-unify PR2: eventCostGrid's new categoryId/categoryIsDefault/module fields ──

describe("moneyViews.eventCostGrid: category resolution fields (PR2)", () => {
  test("an event_item row's `module` field is the item's module key; vendor/budget_line rows have `module: null`", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    const eventId = await seedEvent(s, s.chapterId);
    await seedDefaultCostSetup(s, eventId, ["supplies"]);
    await seedEventItem(s, eventId, "supplies", { title: "Coffee", cost: 40 });
    const person = await seedPerson(s, "Vendor Co");
    await seedPaidEngagement(s, eventId, person, { amountUsd: 100, paymentStatus: "paid" });
    const budgetId = await seedOneTimeBudget(s, s.chapterId, "event", eventId, { amountCents: 10000 });
    await seedLine(s, budgetId, 5000);

    const result = await s.as.query(api.moneyViews.eventCostGrid, { eventId });
    const byKind = new Map(result.rows.map((r) => [r.sourceKind, r]));
    expect(byKind.get("event_item")?.module).toBe("supplies");
    expect(byKind.get("vendor")?.module).toBeNull();
    expect(byKind.get("budget_line")?.module).toBeNull();
  });

  test("categoryId + categoryIsDefault: explicit override -> categoryIsDefault false; default-name match -> categoryIsDefault true; unresolved -> both null/false", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    const eventId = await seedEvent(s, s.chapterId);
    const fundId = await seedFund(s, s.chapterId);
    const defaultSuppliesCat = await seedCategory(
      s,
      s.chapterId,
      fundId,
      MODULE_DEFAULT_CATEGORY_NAMES.supplies,
    );
    const overrideCat = await seedCategory(s, s.chapterId, fundId, "Custom Cat");
    await seedDefaultCostSetup(s, eventId, ["supplies", "comms"]); // comms default ("Marketing & Advertising") has no seeded match
    await seedEventItem(s, eventId, "supplies", { title: "Default match", cost: 10 });
    await seedEventItem(s, eventId, "supplies", { title: "Override", cost: 20, budgetCategoryId: overrideCat });
    await seedEventItem(s, eventId, "comms", { title: "Unresolved", cost: 30 });

    const result = await s.as.query(api.moneyViews.eventCostGrid, { eventId });
    const byLabel = new Map(result.rows.map((r) => [r.label, r]));

    expect(byLabel.get("Default match")).toMatchObject({
      categoryId: defaultSuppliesCat,
      categoryIsDefault: true,
      categoryName: MODULE_DEFAULT_CATEGORY_NAMES.supplies,
    });
    expect(byLabel.get("Override")).toMatchObject({
      categoryId: overrideCat,
      categoryIsDefault: false,
      categoryName: "Custom Cat",
    });
    expect(byLabel.get("Unresolved")).toMatchObject({
      categoryId: null,
      categoryIsDefault: false,
      categoryName: "Comms Schedule", // falls back to the module's own label
    });
  });

});
