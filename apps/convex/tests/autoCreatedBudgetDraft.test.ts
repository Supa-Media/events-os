import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";

/**
 * WP-wave4 (HIGH, opus review 2026-07-17) — "a budget with a real starting
 * amount must never be born approved." Auto-created budgets (an entity's
 * create-time hook, its edit-path "dollar entry summons a row" trigger, and
 * `healRowlessEntityBudgets`' sweep) now start in `"draft"` exactly like a
 * hand-created one via `finances.createBudget` — see
 * `finances.ts#autoCreatedBudgetApprovalStatus`, called from both
 * `createEventBudget` and `createProjectBudget`. Consequences pinned here:
 *  - item 5's attribution gate correctly blocks a charge until the budget
 *    is sent + approved (that's the whole point).
 *  - the owner's superuser one-party approve (item 8) makes a solo backfill
 *    workable: create → send → self-approve, three taps.
 *  - a `$0`/absent amount still gets NO budget row at all (unchanged).
 *  - EXISTING grandfathered budgets (already `undefined` before this PR)
 *    are untouched — this only changes what a NEW row starts as.
 */

const SUPER = "seyi@publicworship.life";

function tsInMonth(year: number, month: number): number {
  return Date.UTC(year, month - 1, 15, 17, 0, 0);
}

async function seedEventType(s: ChapterSetup): Promise<Id<"eventTypes">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("eventTypes", {
      chapterId: s.chapterId,
      name: "Service",
      slug: `service-${Date.now()}-${Math.random()}`,
      version: 1,
      createdBy: s.userId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
}

async function budgetForRef(
  s: ChapterSetup,
  refKind: "event" | "project",
  refId: string,
): Promise<Id<"budgets"> | null> {
  const row = await run(s.t, (ctx) =>
    ctx.db
      .query("budgets")
      .withIndex("by_ref", (q) => q.eq("refKind", refKind).eq("scopeRefId", refId))
      .first(),
  );
  return row?._id ?? null;
}

async function getBudget(s: ChapterSetup, budgetId: Id<"budgets">) {
  return run(s.t, (ctx) => ctx.db.get(budgetId));
}

/** Grant the setup user (`s.as`) a chapter finance role. */
async function grantSelfRole(
  s: ChapterSetup,
  role: "viewer" | "bookkeeper" | "manager",
): Promise<Id<"people">> {
  const personId = await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Caller",
      userId: s.userId,
      isTeamMember: true,
      createdAt: Date.now(),
    }),
  );
  await run(s.t, (ctx) =>
    ctx.db.insert("financeRoles", {
      chapterId: s.chapterId,
      personId,
      role,
      scope: "chapter",
      createdAt: Date.now(),
    }),
  );
  return personId;
}

describe("event created with a real amount starts in draft (WP-wave4 HIGH)", () => {
  test("createFromTemplate with budget>0 summons a DRAFT budget — unattributable until sent, then approvable by a different manager", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await grantSelfRole(s, "manager");
    const eventTypeId = await seedEventType(s);
    const eventId = (await s.as.mutation(api.events.createFromTemplate, {
      eventTypeId,
      name: "Funded Event",
      eventDate: tsInMonth(2026, 6),
      budget: 300,
    })) as Id<"events">;

    const budgetId = await budgetForRef(s, "event", eventId);
    expect(budgetId).not.toBeNull();
    let doc = await getBudget(s, budgetId!);
    expect(doc?.approvalStatus).toBe("draft");
    expect(doc?.amountCents).toBe(30000);

    // Unattributable: item 5's gate rejects a charge against a draft budget.
    await expect(
      s.as.mutation(api.finances.createManualTransaction, {
        flow: "outflow",
        amountCents: 5000,
        postedAt: Date.now(),
        budgetId: budgetId!,
      }),
    ).rejects.toBeInstanceOf(ConvexError);

    // Sendable: submitBudgetForApproval works from "draft".
    await s.as.mutation(api.finances.submitBudgetForApproval, { budgetId: budgetId! });
    doc = await getBudget(s, budgetId!);
    expect(doc?.approvalStatus).toBe("submitted");

    // A DIFFERENT manager approves — normal two-party path, SoD unaffected.
    const approverUserId = await run(s.t, (ctx) => ctx.db.insert("users", { email: "approver@publicworship.life" }));
    await run(s.t, (ctx) =>
      ctx.db.insert("userChapters", {
        userId: approverUserId,
        chapterId: s.chapterId,
        role: "member",
        isActive: true,
        joinedAt: Date.now(),
      }),
    );
    const approverPersonId = await run(s.t, (ctx) =>
      ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Approver",
        userId: approverUserId,
        isTeamMember: true,
        createdAt: Date.now(),
      }),
    );
    await run(s.t, (ctx) =>
      ctx.db.insert("financeRoles", {
        chapterId: s.chapterId,
        personId: approverPersonId,
        role: "manager",
        scope: "chapter",
        createdAt: Date.now(),
      }),
    );
    const approverAs = t.withIdentity({ subject: `${approverUserId}|session`, issuer: "test" });
    await approverAs.mutation(api.finances.approveBudget, { budgetId: budgetId! });

    doc = await getBudget(s, budgetId!);
    expect(doc?.approvalStatus).toBe("approved");
    expect(doc?.approvalParty).toBe("two_party");

    // Now attributable.
    const txnId = await s.as.mutation(api.finances.createManualTransaction, {
      flow: "outflow",
      amountCents: 5000,
      postedAt: Date.now(),
      budgetId: budgetId!,
    });
    expect(txnId).toBeDefined();
  });

  test("the owner's solo-backfill flow — SUPERUSER create → send → self-approve, three taps, records approvalParty:'single'", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: SUPER }); // superuser → implicit central manager
    // A superuser is implicit CENTRAL manager, but this is a CHAPTER event —
    // grant chapter manager explicitly so create/submit/approve all succeed
    // through the normal chapter path (isSuperuser only bootstraps CENTRAL).
    await grantSelfRole(s, "manager");
    const eventTypeId = await seedEventType(s);
    const eventId = (await s.as.mutation(api.events.createFromTemplate, {
      eventTypeId,
      name: "Solo-built Event",
      eventDate: tsInMonth(2026, 6),
      budget: 500,
    })) as Id<"events">;
    const budgetId = await budgetForRef(s, "event", eventId);
    expect((await getBudget(s, budgetId!))?.approvalStatus).toBe("draft");

    await s.as.mutation(api.finances.submitBudgetForApproval, { budgetId: budgetId! });
    await s.as.mutation(api.finances.approveBudget, { budgetId: budgetId! });

    const doc = await getBudget(s, budgetId!);
    expect(doc?.approvalStatus).toBe("approved");
    expect(doc?.approvalParty).toBe("single");
  });

  test("a $0/absent budget still gets NO budget row at all (unchanged)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventTypeId = await seedEventType(s);
    const eventId = (await s.as.mutation(api.events.createFromTemplate, {
      eventTypeId,
      name: "Unfunded Event",
      eventDate: tsInMonth(2026, 6),
      // no `budget` arg at all
    })) as Id<"events">;

    const budgetId = await budgetForRef(s, "event", eventId);
    expect(budgetId).toBeNull();
  });
});

describe("project created with a real amount starts in draft (WP-wave4 HIGH)", () => {
  test("projects.create with budgetUsd>0 summons a DRAFT budget — unattributable until approved", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await grantSelfRole(s, "manager");
    const projectId = (await s.as.mutation(api.projects.create, {
      name: "Album Recording",
      budgetUsd: 1200,
    })) as Id<"projects">;

    const budgetId = await budgetForRef(s, "project", projectId);
    expect(budgetId).not.toBeNull();
    const doc = await getBudget(s, budgetId!);
    expect(doc?.approvalStatus).toBe("draft");
    expect(doc?.amountCents).toBe(120000);

    await expect(
      s.as.mutation(api.finances.createManualTransaction, {
        flow: "outflow",
        amountCents: 10000,
        postedAt: Date.now(),
        budgetId: budgetId!,
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("a $0/absent budgetUsd still gets NO budget row at all (unchanged)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const projectId = (await s.as.mutation(api.projects.create, {
      name: "Time-only Project",
    })) as Id<"projects">;

    const budgetId = await budgetForRef(s, "project", projectId);
    expect(budgetId).toBeNull();
  });
});

describe("edit-path 'dollar entry summons a row' trigger also starts in draft (WP-wave4 HIGH)", () => {
  test("entering a positive amount on a budget-less event's own header summons a DRAFT row", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventTypeId = await seedEventType(s);
    // No `budget` at creation — a budget-less event.
    const eventId = (await s.as.mutation(api.events.createFromTemplate, {
      eventTypeId,
      name: "Grows a Budget Later",
      eventDate: tsInMonth(2026, 7),
    })) as Id<"events">;
    expect(await budgetForRef(s, "event", eventId)).toBeNull();

    // The header amount edit summons the row (D8 trigger, events.ts).
    await s.as.mutation(api.events.updateDetails, { eventId, budget: 250 });

    const budgetId = await budgetForRef(s, "event", eventId);
    expect(budgetId).not.toBeNull();
    const doc = await getBudget(s, budgetId!);
    expect(doc?.approvalStatus).toBe("draft");
    expect(doc?.amountCents).toBe(25000);
  });

  test("entering a positive amount on a budget-less project's own card summons a DRAFT row", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const projectId = (await s.as.mutation(api.projects.create, {
      name: "Grows a Budget Later",
    })) as Id<"projects">;
    expect(await budgetForRef(s, "project", projectId)).toBeNull();

    await s.as.mutation(api.projects.update, { projectId, budgetUsd: 400 });

    const budgetId = await budgetForRef(s, "project", projectId);
    expect(budgetId).not.toBeNull();
    const doc = await getBudget(s, budgetId!);
    expect(doc?.approvalStatus).toBe("draft");
  });
});

describe("existing (pre-PR) grandfathered budgets are untouched (WP-wave4 HIGH regression)", () => {
  test("a raw-inserted legacy budget with no approvalStatus reads as approved, unaffected by this fix — no migration, no backfill", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await grantSelfRole(s, "bookkeeper");
    const legacyBudgetId = await run(s.t, (ctx) =>
      ctx.db.insert("budgets", {
        chapterId: s.chapterId,
        amountCents: 40000,
        label: "Legacy Ops",
        type: "recurring",
        cadence: "yearly",
        year: 2026,
        createdAt: Date.now(),
      }),
    );
    const doc = await run(s.t, (ctx) => ctx.db.get(legacyBudgetId));
    expect(doc?.approvalStatus).toBeUndefined(); // still grandfathered, untouched

    const budgets = await s.as.query(api.finances.listBudgets, {});
    const listed = budgets.find((b) => b.id === legacyBudgetId);
    expect(listed?.approvalStatus).toBe("approved"); // effective status, unchanged

    // Still immediately attributable — the whole point of "existing rows
    // stay approved, no migration."
    const txnId = await s.as.mutation(api.finances.createManualTransaction, {
      flow: "outflow",
      amountCents: 1000,
      postedAt: Date.now(),
      budgetId: legacyBudgetId,
    });
    expect(txnId).toBeDefined();
  });

  test("the $0 SUMMON path (ensureBudgetForRef) stays grandfathered-shaped — the exception the HIGH fix explicitly carves out", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await grantSelfRole(s, "bookkeeper");
    const eventTypeId = await seedEventType(s);
    const eventId = (await s.as.mutation(api.events.createFromTemplate, {
      eventTypeId,
      name: "Bare Event",
      eventDate: tsInMonth(2026, 8),
    })) as Id<"events">;

    const budgetId = await s.as.mutation(api.finances.summonBudgetForRef, {
      refKind: "event",
      scopeRefId: eventId,
    });
    const doc = await getBudget(s, budgetId);
    expect(doc?.approvalStatus).toBeUndefined(); // NOT "draft" — $0, nothing to gate yet
    expect(doc?.amountCents).toBe(0);
  });
});
