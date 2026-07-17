import { describe, expect, test, vi } from "vitest";
import { ConvexError } from "convex/values";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  newT,
  run,
  setupChapter,
  type ChapterSetup,
  type TestConvex,
} from "./setup.helpers";
import { runSeedSeatDefs } from "../migrations/0022_seed_seat_defs";
import { CENTRAL } from "@events-os/shared";

/**
 * WP-wave4 (item 3) — explicit send-for-review, owner decision (verbatim):
 * a new or increased budget no longer auto-submits; it sits in DRAFT (fully
 * editable) until a deliberate "Send for review" action
 * (`submitBudgetForApproval`), which also notifies the scope's approvers.
 *
 * Covers:
 *  - create → draft, not submitted (regression — `createBudget` already
 *    inserted new rows at "draft"; this pins it explicitly for item 3).
 *  - send → submitted + the notification context resolves the right
 *    approvers (chapter: Treasurer + Chapter Director; central: ED + FM),
 *    found via EITHER the seat chart OR the legacy `specializedRoles` title
 *    (`finances.ts#getBudgetSubmissionContext`) — the scheduled
 *    `notifyBudgetApprovers` action itself only logs/emails, so this drains
 *    it (must never throw, even with no RESEND_API_KEY) and asserts the
 *    CONTENT it would have used, mirroring `cards.test.ts`'s own
 *    "degrades without RESEND_API_KEY, never throws" pattern.
 *  - increase → a DRAFT INCREASE (still "draft"), old cap still drives
 *    `effectiveCapCents`, deliberate send required before it can be decided
 *    on (see `financeBudgetApproval.test.ts`'s own retrigger-rule coverage
 *    for the exhaustive cap-math cases — this file only pins the item-3
 *    "requires an explicit send" shape once more, end-to-end with a real
 *    dashboard read).
 *  - approve/request-changes flows unchanged post-submit.
 */

async function seatSetup(
  opts: { email?: string; chapterName?: string } = {},
): Promise<ChapterSetup> {
  const t = newT();
  await run(t, (ctx) => runSeedSeatDefs(ctx));
  return setupChapter(t, opts);
}

async function seedSelfPerson(s: ChapterSetup, name = "Caller"): Promise<Id<"people">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name,
      email: `${name.toLowerCase().replace(/\s+/g, ".")}@publicworship.life`,
      userId: s.userId,
      isTeamMember: true,
      createdAt: Date.now(),
    }),
  );
}

async function grantRole(
  s: ChapterSetup,
  personId: Id<"people">,
  role: "viewer" | "bookkeeper" | "manager",
  scope: "chapter" | "central" = "chapter",
): Promise<void> {
  await run(s.t, (ctx) =>
    ctx.db.insert("financeRoles", {
      chapterId: s.chapterId,
      personId,
      role,
      scope,
      createdAt: Date.now(),
    }),
  );
}

async function addMember(
  s: ChapterSetup,
  opts: { email: string; name: string },
): Promise<{
  as: ReturnType<TestConvex["withIdentity"]>;
  userId: Id<"users">;
  personId: Id<"people">;
}> {
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
      email: opts.email,
      userId,
      isTeamMember: true,
      createdAt: Date.now(),
    }),
  );
  const as = s.t.withIdentity({ subject: `${userId}|session`, issuer: "test" });
  return { as, userId, personId };
}

async function defBySlug(s: ChapterSetup, slug: string) {
  const def = await run(s.t, (ctx) =>
    ctx.db
      .query("seatDefs")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .unique(),
  );
  if (!def) throw new Error(`${slug} not seeded`);
  return def;
}

async function assignSeatDirect(
  s: ChapterSetup,
  personId: Id<"people">,
  slug: string,
  scope: Id<"chapters"> | "central",
): Promise<void> {
  const def = await defBySlug(s, slug);
  await run(s.t, (ctx) =>
    ctx.db.insert("seatAssignments", {
      seatDefId: def._id,
      scope,
      personId,
      createdAt: Date.now(),
    }),
  );
}

async function grantCentralTitle(
  s: ChapterSetup,
  personId: Id<"people">,
  title: "executive_director" | "finance_manager",
): Promise<void> {
  await run(s.t, (ctx) =>
    ctx.db.insert("specializedRoles", {
      personId,
      scope: "central",
      title,
      roleKind: title === "executive_director" ? "leadership" : "finance",
      createdAt: Date.now(),
    }),
  );
}

async function grantChapterTitle(
  s: ChapterSetup,
  personId: Id<"people">,
  title: "president" | "finance_manager",
): Promise<void> {
  await run(s.t, (ctx) =>
    ctx.db.insert("specializedRoles", {
      personId,
      scope: s.chapterId,
      title,
      roleKind: title === "president" ? "leadership" : "finance",
      createdAt: Date.now(),
    }),
  );
}

async function getBudget(s: ChapterSetup, budgetId: Id<"budgets">) {
  return run(s.t, (ctx) => ctx.db.get(budgetId));
}

describe("create → draft, never auto-submitted (WP-wave4 item 3)", () => {
  test("a brand-new chapter budget starts at draft", async () => {
    const s = await seatSetup();
    const manager = await seedSelfPerson(s, "Manager");
    await grantRole(s, manager, "manager", "chapter");

    const budgetId = await s.as.mutation(api.finances.createBudget, {
      amountCents: 50000,
      type: "recurring",
      cadence: "monthly",
      year: 2026,
      label: "Ops",
    });
    const doc = await getBudget(s, budgetId);
    expect(doc?.approvalStatus).toBe("draft");
    expect(doc?.submittedAt).toBeUndefined();
    expect(doc?.submittedByPersonId).toBeUndefined();
  });

  test("a brand-new central budget also starts at draft", async () => {
    const s = await seatSetup();
    const manager = await seedSelfPerson(s, "Manager");
    await grantRole(s, manager, "manager", "central");

    const budgetId = await s.as.mutation(api.finances.createBudget, {
      amountCents: 200000,
      type: "recurring",
      cadence: "yearly",
      year: 2026,
      central: true,
      label: "Central Ops",
    });
    const doc = await getBudget(s, budgetId);
    expect(doc?.approvalStatus).toBe("draft");
  });
});

describe("send → submitted + notifies the scope's approvers (WP-wave4 item 3)", () => {
  test("chapter: sending a draft resolves Treasurer + Chapter Director via the SEAT chart", async () => {
    vi.useFakeTimers();
    const prevResendKey = process.env.RESEND_API_KEY;
    delete process.env.RESEND_API_KEY;
    try {
      const s = await seatSetup();
      const manager = await seedSelfPerson(s, "Manager");
      await grantRole(s, manager, "manager", "chapter");

      const treasurer = await addMember(s, { email: "treasurer@publicworship.life", name: "Treasurer" });
      await assignSeatDirect(s, treasurer.personId, "treasurer", s.chapterId);
      const cd = await addMember(s, { email: "cd@publicworship.life", name: "CD" });
      await assignSeatDirect(s, cd.personId, "chapter_director", s.chapterId);

      const budgetId = await s.as.mutation(api.finances.createBudget, {
        amountCents: 60000,
        type: "recurring",
        cadence: "monthly",
        year: 2026,
        label: "Fall Retreat",
      });

      // Never throws, even though Resend degrades (no key in test env) — the
      // mutation itself only SCHEDULES the notify action.
      await s.as.mutation(api.finances.submitBudgetForApproval, { budgetId });
      await s.t.finishAllScheduledFunctions(vi.runAllTimers);

      const doc = await getBudget(s, budgetId);
      expect(doc?.approvalStatus).toBe("submitted");
      expect(doc?.submittedAt).toBeTypeOf("number");

      // The notification context the scheduled action used — proves the
      // right approver SET was resolved (mirrors cards.test.ts's own
      // "drains the scheduled job, asserts the resolver's content" pattern).
      const submission = await s.t.query(internal.finances.getBudgetSubmissionContext, {
        budgetId,
      });
      expect(submission?.level).toBe("chapter");
      expect(submission?.budgetName).toBe("Fall Retreat");
      const emails = submission?.approvers.map((a) => a.email).sort();
      expect(emails).toEqual(["cd@publicworship.life", "treasurer@publicworship.life"]);
    } finally {
      vi.useRealTimers();
      if (prevResendKey === undefined) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = prevResendKey;
    }
  });

  test("chapter: the legacy specializedRoles TITLE path resolves the same two approvers (union, not a replacement)", async () => {
    const s = await seatSetup();
    const manager = await seedSelfPerson(s, "Manager");
    await grantRole(s, manager, "manager", "chapter");

    const treasurer = await addMember(s, { email: "treasurer@publicworship.life", name: "Treasurer" });
    await grantChapterTitle(s, treasurer.personId, "finance_manager");
    const cd = await addMember(s, { email: "cd@publicworship.life", name: "CD" });
    await grantChapterTitle(s, cd.personId, "president");

    const budgetId = await s.as.mutation(api.finances.createBudget, {
      amountCents: 60000,
      type: "recurring",
      cadence: "monthly",
      year: 2026,
      label: "Fall Retreat",
    });

    const submission = await s.t.query(internal.finances.getBudgetSubmissionContext, {
      budgetId,
    });
    const emails = submission?.approvers.map((a) => a.email).sort();
    expect(emails).toEqual(["cd@publicworship.life", "treasurer@publicworship.life"]);
  });

  test("central: resolves ED + FM via the seat chart", async () => {
    const s = await seatSetup();
    const manager = await seedSelfPerson(s, "Manager");
    await grantRole(s, manager, "manager", "central");

    const ed = await addMember(s, { email: "ed@publicworship.life", name: "ED" });
    await assignSeatDirect(s, ed.personId, "executive_director", CENTRAL);
    const fm = await addMember(s, { email: "fm@publicworship.life", name: "FM" });
    await assignSeatDirect(s, fm.personId, "financial_manager", CENTRAL);

    const budgetId = await s.as.mutation(api.finances.createBudget, {
      amountCents: 300000,
      type: "recurring",
      cadence: "yearly",
      year: 2026,
      central: true,
      label: "City Launch Fund",
    });

    const submission = await s.t.query(internal.finances.getBudgetSubmissionContext, {
      budgetId,
    });
    expect(submission?.level).toBe("central");
    const emails = submission?.approvers.map((a) => a.email).sort();
    expect(emails).toEqual(["ed@publicworship.life", "fm@publicworship.life"]);
  });

  test("no seated/titled approver at all → an empty approver list, never a throw", async () => {
    const s = await seatSetup();
    const manager = await seedSelfPerson(s, "Manager");
    await grantRole(s, manager, "manager", "chapter");

    const budgetId = await s.as.mutation(api.finances.createBudget, {
      amountCents: 10000,
      type: "recurring",
      cadence: "monthly",
      year: 2026,
      label: "Lonely Budget",
    });

    const submission = await s.t.query(internal.finances.getBudgetSubmissionContext, {
      budgetId,
    });
    expect(submission?.approvers).toEqual([]);
  });
});

describe("increase → a DRAFT INCREASE, not an auto-submit (WP-wave4 item 3)", () => {
  test("raising an approved budget's amount lands back at draft; dashboard keeps reporting the OLD cap until sent + re-approved", async () => {
    const s = await seatSetup();
    const submitterPerson = await seedSelfPerson(s, "Submitter");
    await grantRole(s, submitterPerson, "manager", "chapter");

    const budgetId = await s.as.mutation(api.finances.createBudget, {
      amountCents: 100000,
      type: "recurring",
      cadence: "monthly",
      year: 2026,
      month: 6,
      label: "Ops",
    });
    await s.as.mutation(api.finances.submitBudgetForApproval, { budgetId });
    const approver = await addMember(s, { email: "approver@publicworship.life", name: "Approver" });
    await grantRole(s, approver.personId, "manager", "chapter");
    await approver.as.mutation(api.finances.approveBudget, { budgetId });

    // Raise the amount — retriggers to a DRAFT increase, not "submitted".
    await s.as.mutation(api.finances.updateBudget, {
      budgetId,
      patch: { amountCents: 180000 },
    });
    let doc = await getBudget(s, budgetId);
    expect(doc?.approvalStatus).toBe("draft");
    expect(doc?.approvedCents).toBe(100000); // the OLD cap, untouched

    // The dashboard card keeps reporting the OLD $1,000/mo cap.
    const dash = await s.as.query(api.finances.dashboardChapter, { year: 2026, month: 6 });
    const card = dash.recurringBudgets.find((r) => r.id === budgetId);
    expect(card?.budgetCents).toBe(100000);

    // Approving directly (skipping the send) is illegal.
    await expect(
      approver.as.mutation(api.finances.approveBudget, { budgetId }),
    ).rejects.toBeInstanceOf(ConvexError);

    // Explicit send required.
    await s.as.mutation(api.finances.submitBudgetForApproval, { budgetId });
    doc = await getBudget(s, budgetId);
    expect(doc?.approvalStatus).toBe("submitted");

    await approver.as.mutation(api.finances.approveBudget, { budgetId });
    doc = await getBudget(s, budgetId);
    expect(doc?.approvalStatus).toBe("approved");
    expect(doc?.approvedCents).toBe(180000);
  });
});

describe("approve/request-changes flows unchanged post-submit (WP-wave4 item 3 regression)", () => {
  test("a manager approves a submitted budget exactly as before", async () => {
    const s = await seatSetup();
    const submitterPerson = await seedSelfPerson(s, "Submitter");
    await grantRole(s, submitterPerson, "manager", "chapter");
    const budgetId = await s.as.mutation(api.finances.createBudget, {
      amountCents: 40000,
      type: "recurring",
      cadence: "monthly",
      year: 2026,
      label: "Ops",
    });
    await s.as.mutation(api.finances.submitBudgetForApproval, { budgetId });

    const approver = await addMember(s, { email: "approver@publicworship.life", name: "Approver" });
    await grantRole(s, approver.personId, "manager", "chapter");
    await approver.as.mutation(api.finances.approveBudget, { budgetId, note: "LGTM" });

    const doc = await getBudget(s, budgetId);
    expect(doc?.approvalStatus).toBe("approved");
    expect(doc?.reviewNote).toBe("LGTM");
  });

  test("a manager requests changes on a submitted budget exactly as before", async () => {
    const s = await seatSetup();
    const submitterPerson = await seedSelfPerson(s, "Submitter");
    await grantRole(s, submitterPerson, "manager", "chapter");
    const budgetId = await s.as.mutation(api.finances.createBudget, {
      amountCents: 40000,
      type: "recurring",
      cadence: "monthly",
      year: 2026,
      label: "Ops",
    });
    await s.as.mutation(api.finances.submitBudgetForApproval, { budgetId });

    const approver = await addMember(s, { email: "approver@publicworship.life", name: "Approver" });
    await grantRole(s, approver.personId, "manager", "chapter");
    await approver.as.mutation(api.finances.requestBudgetChanges, {
      budgetId,
      note: "Break out line items",
    });

    const doc = await getBudget(s, budgetId);
    expect(doc?.approvalStatus).toBe("changes_requested");
    expect(doc?.reviewNote).toBe("Break out line items");

    // Changes-requested is also a valid re-send source.
    await s.as.mutation(api.finances.submitBudgetForApproval, { budgetId });
    expect((await getBudget(s, budgetId))?.approvalStatus).toBe("submitted");
  });
});
