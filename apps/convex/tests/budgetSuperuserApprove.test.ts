import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";

/**
 * WP-wave4 (item 8, owner addendum 2026-07-17) — TEMPORARY governance
 * relaxation: while solo-building/backfilling history, a SUPERUSER may
 * approve a budget they themselves submitted (bypassing the normal SoD
 * identity block). Everyone else still gets the block, unconditionally.
 * `approveBudget` records which path a decision took — `approvalParty:
 * "single"` for the bypass, `"two_party"` for every normal approval — a
 * durable, re-reviewable trail for when the org grows past one person.
 *
 * `requestBudgetChanges` is DELIBERATELY untouched (the addendum only asked
 * to widen the approve path) — pinned here as a regression too.
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

async function getBudget(s: ChapterSetup, budgetId: Id<"budgets">) {
  return run(s.t, (ctx) => ctx.db.get(budgetId));
}

describe("superuser self-approve — the single-party bypass (WP-wave4 item 8)", () => {
  test("a superuser who submitted their own chapter budget CAN approve it — marked approvalParty:'single'", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: SUPER }); // superuser → implicit central manager
    // A superuser is an implicit CENTRAL manager, but this is a CHAPTER
    // budget — grant chapter manager explicitly so create/submit succeed
    // through the normal chapter path (isSuperuser only bootstraps CENTRAL).
    const selfPerson = await seedSelfPerson(s, "Solo Owner");
    await grantRole(s, selfPerson, "manager", "chapter");

    const budgetId = await s.as.mutation(api.finances.createBudget, {
      amountCents: 75000,
      type: "recurring",
      cadence: "yearly",
      year: 2026,
      label: "Solo Ops",
    });
    await s.as.mutation(api.finances.submitBudgetForApproval, { budgetId });

    // Same identity approves their own submission — allowed ONLY because
    // they're a superuser.
    await s.as.mutation(api.finances.approveBudget, { budgetId, note: "Solo-approved" });

    const doc = await getBudget(s, budgetId);
    expect(doc?.approvalStatus).toBe("approved");
    expect(doc?.approvedByPersonId).toBe(selfPerson);
    expect(doc?.approvalParty).toBe("single");
    expect(doc?.reviewNote).toBe("Solo-approved");
  });

  test("a superuser self-approving a CENTRAL budget also marks approvalParty:'single'", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: SUPER });
    const selfPerson = await seedSelfPerson(s, "Solo Owner");

    const budgetId = await s.as.mutation(api.finances.createBudget, {
      amountCents: 200000,
      type: "recurring",
      cadence: "yearly",
      year: 2026,
      central: true,
      label: "Central Solo Ops",
    });
    await s.as.mutation(api.finances.submitBudgetForApproval, { budgetId });
    await s.as.mutation(api.finances.approveBudget, { budgetId });

    const doc = await getBudget(s, budgetId);
    expect(doc?.approvalStatus).toBe("approved");
    expect(doc?.approvedByPersonId).toBe(selfPerson);
    expect(doc?.approvalParty).toBe("single");
  });
});

describe("non-superuser self-approve is still rejected — the block stays for everyone else (WP-wave4 item 8)", () => {
  test("a plain chapter manager who submitted their own budget still CANNOT approve it", async () => {
    const t = newT();
    const s = await setupChapter(t); // NOT the superuser email
    const selfPerson = await seedSelfPerson(s, "Manager");
    await grantRole(s, selfPerson, "manager", "chapter");

    const budgetId = await s.as.mutation(api.finances.createBudget, {
      amountCents: 50000,
      type: "recurring",
      cadence: "yearly",
      year: 2026,
      label: "Ops",
    });
    await s.as.mutation(api.finances.submitBudgetForApproval, { budgetId });

    await expect(
      s.as.mutation(api.finances.approveBudget, { budgetId }),
    ).rejects.toBeInstanceOf(ConvexError);

    const doc = await getBudget(s, budgetId);
    expect(doc?.approvalStatus).toBe("submitted");
    expect(doc?.approvalParty).toBeUndefined();
  });
});

describe("normal (different-identity) approvals stay labeled two_party (WP-wave4 item 8 regression)", () => {
  test("a DIFFERENT manager approving stays approvalParty:'two_party', even for a superuser caller", async () => {
    const t = newT();
    const s = await setupChapter(t);
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

    const approverUserId = await run(s.t, (ctx) =>
      ctx.db.insert("users", { email: SUPER }),
    );
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
        name: "Superuser Approver",
        userId: approverUserId,
        isTeamMember: true,
        createdAt: Date.now(),
      }),
    );
    const approverAs = s.t.withIdentity({ subject: `${approverUserId}|session`, issuer: "test" });

    await approverAs.mutation(api.finances.approveBudget, { budgetId });

    const doc = await getBudget(s, budgetId);
    expect(doc?.approvalStatus).toBe("approved");
    expect(doc?.approvedByPersonId).toBe(approverPersonId);
    expect(doc?.approvalParty).toBe("two_party");
  });

  test("requestBudgetChanges is UNTOUCHED — a superuser still cannot request changes on their own submission", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: SUPER });
    const selfPerson = await seedSelfPerson(s, "Solo Owner");
    await grantRole(s, selfPerson, "manager", "chapter");

    const budgetId = await s.as.mutation(api.finances.createBudget, {
      amountCents: 50000,
      type: "recurring",
      cadence: "yearly",
      year: 2026,
      label: "Solo Ops",
    });
    await s.as.mutation(api.finances.submitBudgetForApproval, { budgetId });

    await expect(
      s.as.mutation(api.finances.requestBudgetChanges, { budgetId, note: "hmm" }),
    ).rejects.toBeInstanceOf(ConvexError);

    const doc = await getBudget(s, budgetId);
    expect(doc?.approvalStatus).toBe("submitted");
  });
});
