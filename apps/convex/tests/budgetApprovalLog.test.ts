import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { newT, run, setupChapter, type ChapterSetup, type TestConvex } from "./setup.helpers";

/**
 * WP-wave4 (item 8-LOW, opus review 2026-07-17) — "keep a record of
 * approvers" (owner). `budgets.approvalParty`/`approvedByPersonId`/
 * `submittedByPersonId` etc. are LAST-DECISION-ONLY (overwritten by the next
 * send/approve/request-changes, or reset by a scope move) — `budgetApprovalLog`
 * is the append-only PERMANENT record: one row per decision, written by
 * `submitBudgetForApproval` ("sent"), `approveBudget` ("approved"), and
 * `requestBudgetChanges` ("changes_requested"), never updated or deleted.
 */

const SUPER = "seyi@publicworship.life";

async function seedSelfPerson(s: ChapterSetup, name = "Caller"): Promise<Id<"people">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name,
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
      userId,
      isTeamMember: true,
      createdAt: Date.now(),
    }),
  );
  const as = s.t.withIdentity({ subject: `${userId}|session`, issuer: "test" });
  return { as, userId, personId };
}

async function createChapterBudget(s: ChapterSetup, amountCents = 50000): Promise<Id<"budgets">> {
  return s.as.mutation(api.finances.createBudget, {
    amountCents,
    type: "recurring",
    cadence: "yearly",
    year: 2026,
    label: "Ops",
  });
}

describe("budgetApprovalLog — one durable row per decision (WP-wave4 item 8-LOW)", () => {
  test("send → approve (two-party) writes 'sent' then 'approved' rows, newest first", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const submitterPerson = await seedSelfPerson(s, "Submitter");
    await grantRole(s, submitterPerson, "manager", "chapter");
    const budgetId = await createChapterBudget(s);

    await s.as.mutation(api.finances.submitBudgetForApproval, { budgetId });

    const approver = await addMember(s, { email: "approver@publicworship.life", name: "Approver" });
    await grantRole(s, approver.personId, "manager", "chapter");
    await approver.as.mutation(api.finances.approveBudget, { budgetId, note: "LGTM" });

    const log = await s.as.query(api.finances.listBudgetApprovalLog, { budgetId });
    expect(log).toHaveLength(2);
    // Newest first.
    expect(log[0].action).toBe("approved");
    expect(log[0].party).toBe("two_party");
    expect(log[0].decidedByName).toBe("Approver");
    expect(log[0].note).toBe("LGTM");
    expect(log[1].action).toBe("sent");
    expect(log[1].decidedByName).toBe("Submitter");
    expect(log[1].party).toBeNull();
  });

  test("a superuser self-approve writes an 'approved' row with party:'single'", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: SUPER });
    const selfPerson = await seedSelfPerson(s, "Solo Owner");
    await grantRole(s, selfPerson, "manager", "chapter");
    const budgetId = await createChapterBudget(s);
    await s.as.mutation(api.finances.submitBudgetForApproval, { budgetId });
    await s.as.mutation(api.finances.approveBudget, { budgetId });

    const log = await s.as.query(api.finances.listBudgetApprovalLog, { budgetId });
    const approvedRow = log.find((r) => r.action === "approved");
    expect(approvedRow?.party).toBe("single");
    expect(approvedRow?.decidedByName).toBe("Solo Owner");
  });

  test("requestBudgetChanges writes a 'changes_requested' row, always party:'two_party'", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const submitterPerson = await seedSelfPerson(s, "Submitter");
    await grantRole(s, submitterPerson, "manager", "chapter");
    const budgetId = await createChapterBudget(s);
    await s.as.mutation(api.finances.submitBudgetForApproval, { budgetId });

    const approver = await addMember(s, { email: "approver@publicworship.life", name: "Approver" });
    await grantRole(s, approver.personId, "manager", "chapter");
    await approver.as.mutation(api.finances.requestBudgetChanges, {
      budgetId,
      note: "Break out line items",
    });

    const log = await s.as.query(api.finances.listBudgetApprovalLog, { budgetId });
    const row = log.find((r) => r.action === "changes_requested");
    expect(row?.party).toBe("two_party");
    expect(row?.note).toBe("Break out line items");
  });

  test("the log accumulates across multiple rounds — draft → send → changes-requested → re-send → approve", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const submitterPerson = await seedSelfPerson(s, "Submitter");
    await grantRole(s, submitterPerson, "manager", "chapter");
    const budgetId = await createChapterBudget(s);
    const approver = await addMember(s, { email: "approver@publicworship.life", name: "Approver" });
    await grantRole(s, approver.personId, "manager", "chapter");

    await s.as.mutation(api.finances.submitBudgetForApproval, { budgetId }); // 1: sent
    await approver.as.mutation(api.finances.requestBudgetChanges, {
      budgetId,
      note: "not yet",
    }); // 2: changes_requested
    await s.as.mutation(api.finances.submitBudgetForApproval, { budgetId }); // 3: sent
    await approver.as.mutation(api.finances.approveBudget, { budgetId }); // 4: approved

    const log = await s.as.query(api.finances.listBudgetApprovalLog, { budgetId });
    expect(log.map((r) => r.action)).toEqual([
      "approved",
      "sent",
      "changes_requested",
      "sent",
    ]);
  });

  test("the CHIP-facing field (approvalParty) is last-decision-only, but the LOG keeps every prior decision", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: SUPER });
    const selfPerson = await seedSelfPerson(s, "Solo Owner");
    await grantRole(s, selfPerson, "manager", "chapter");
    const budgetId = await createChapterBudget(s, 50000);
    await s.as.mutation(api.finances.submitBudgetForApproval, { budgetId });
    await s.as.mutation(api.finances.approveBudget, { budgetId }); // single-party

    // Raise the amount — retriggers to a draft increase, requiring a fresh
    // send + decision.
    await s.as.mutation(api.finances.updateBudget, {
      budgetId,
      patch: { amountCents: 80000 },
    });
    await s.as.mutation(api.finances.submitBudgetForApproval, { budgetId });

    const approver = await addMember(s, { email: "approver2@publicworship.life", name: "Approver2" });
    await grantRole(s, approver.personId, "manager", "chapter");
    await approver.as.mutation(api.finances.approveBudget, { budgetId }); // two-party this time

    // The CURRENT field reflects only the LATEST decision.
    const doc = await run(s.t, (ctx) => ctx.db.get(budgetId));
    expect(doc?.approvalParty).toBe("two_party");

    // The LOG still remembers the earlier single-party decision too.
    const log = await s.as.query(api.finances.listBudgetApprovalLog, { budgetId });
    const approvedRows = log.filter((r) => r.action === "approved");
    expect(approvedRows).toHaveLength(2);
    expect(approvedRows.map((r) => r.party).sort()).toEqual(["single", "two_party"]);
  });
});

describe("moveBudgetScope clears the CURRENT party field but the log survives (WP-wave4 item 8-LOW)", () => {
  test("transferring an approved project's budget to central resets approvalParty on the row; the log keeps the old decision", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: SUPER });
    // `resolveCallerPersonId` (submit/approve/transferProjectScope all use
    // it) requires a roster row even for a superuser — superuser status
    // only bootstraps the RANK check, not the identity resolution.
    await seedSelfPerson(s, "Solo Owner");
    const projectId = await run(s.t, (ctx) =>
      ctx.db.insert("projects", {
        chapterId: s.chapterId,
        name: "Music Recording",
        status: "in_progress",
        createdBy: s.userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    const budgetId = await s.as.mutation(api.finances.createBudget, {
      amountCents: 30000,
      type: "one_time",
      refKind: "project",
      cadence: "per_instance",
      year: 2026,
      scopeRefId: projectId,
    });
    await s.as.mutation(api.finances.submitBudgetForApproval, { budgetId });
    await s.as.mutation(api.finances.approveBudget, { budgetId }); // single-party (superuser)

    let doc = await run(s.t, (ctx) => ctx.db.get(budgetId));
    expect(doc?.approvalParty).toBe("single");

    await s.as.mutation(api.finances.transferProjectScope, {
      projectId,
      target: "central",
    });

    doc = await run(s.t, (ctx) => ctx.db.get(budgetId));
    expect(doc?.approvalStatus).toBe("submitted"); // reset, needs re-approval
    expect(doc?.approvalParty).toBeUndefined(); // the CURRENT field is cleared

    // The PERMANENT log still remembers the original single-party approval —
    // never rewritten by the scope move.
    const log = await s.as.query(api.finances.listBudgetApprovalLog, { budgetId });
    expect(log.some((r) => r.action === "approved" && r.party === "single")).toBe(true);
  });
});

describe("listBudgetApprovalLog is gated like a budget's own plan (WP-wave4 item 8-LOW)", () => {
  test("a plain member with no finance role at all cannot read the log", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const submitterPerson = await seedSelfPerson(s, "Submitter");
    await grantRole(s, submitterPerson, "manager", "chapter");
    const budgetId = await createChapterBudget(s);
    await s.as.mutation(api.finances.submitBudgetForApproval, { budgetId });

    const plain = await addMember(s, { email: "plain@publicworship.life", name: "Plain" });
    await expect(
      plain.as.query(api.finances.listBudgetApprovalLog, { budgetId }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("a chapter VIEWER can read the log (read-only, same as the budget's own plan)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const submitterPerson = await seedSelfPerson(s, "Submitter");
    await grantRole(s, submitterPerson, "manager", "chapter");
    const budgetId = await createChapterBudget(s);
    await s.as.mutation(api.finances.submitBudgetForApproval, { budgetId });

    const viewer = await addMember(s, { email: "viewer@publicworship.life", name: "Viewer" });
    await grantRole(s, viewer.personId, "viewer", "chapter");
    const log = await viewer.as.query(api.finances.listBudgetApprovalLog, { budgetId });
    expect(log.length).toBeGreaterThan(0);
  });

  test("a budget with no decisions yet returns an empty log", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s, "Manager");
    await grantRole(s, personId, "manager", "chapter");
    const budgetId = await createChapterBudget(s);

    const log = await s.as.query(api.finances.listBudgetApprovalLog, { budgetId });
    expect(log).toEqual([]);
  });
});
