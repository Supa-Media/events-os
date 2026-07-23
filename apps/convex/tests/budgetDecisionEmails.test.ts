/// <reference types="vite/client" />
import { describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";

/**
 * Founder feedback review: `approveBudget`/`requestBudgetChanges`
 * (`finances.ts`) each schedule `budgetDecisionEmails.notifyBudgetSubmitter`
 * — the SUBMITTER's half of the budget-approval notification loop.
 * (`notifyBudgetApprovers`, the approvers' half, is already covered by
 * `budgetDraftLifecycle.test.ts`.)
 *
 * Mirrors that file's own "drains the scheduled job, asserts the resolver's
 * content" pattern: the notify ACTION itself only logs/emails (never throws,
 * even without RESEND_API_KEY in test env), so these tests drain it and
 * assert the CONTEXT `getBudgetDecisionContext` resolved instead of trying
 * to observe an outbound Resend call.
 */

async function seedSelfPerson(s: ChapterSetup, name = "Submitter"): Promise<Id<"people">> {
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
  as: ReturnType<ChapterSetup["t"]["withIdentity"]>;
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

async function createChapterBudget(s: ChapterSetup, label: string): Promise<Id<"budgets">> {
  return await s.as.mutation(api.finances.createBudget, {
    amountCents: 60000,
    type: "recurring",
    cadence: "monthly",
    year: 2026,
    label,
  });
}

describe("approveBudget notifies the submitter back", () => {
  test("schedules notifyBudgetSubmitter — context resolves the submitter, the decider, and the note", async () => {
    vi.useFakeTimers();
    const prevResendKey = process.env.RESEND_API_KEY;
    delete process.env.RESEND_API_KEY;
    try {
      const t = newT();
      const s = await setupChapter(t);
      const submitterPersonId = await seedSelfPerson(s, "Submitter");
      await grantRole(s, submitterPersonId, "manager", "chapter");

      const budgetId = await createChapterBudget(s, "Fall Retreat");
      await s.as.mutation(api.finances.submitBudgetForApproval, { budgetId });

      const approver = await addMember(s, {
        email: "approver@publicworship.life",
        name: "Approver",
      });
      await grantRole(s, approver.personId, "manager", "chapter");
      await approver.as.mutation(api.finances.approveBudget, {
        budgetId,
        note: "Looks good, thanks!",
      });
      // Never throws — the mutation only SCHEDULES the notify action.
      await t.finishAllScheduledFunctions(vi.runAllTimers);

      const decision = await t.query(internal.budgetDecisionEmails.getBudgetDecisionContext, {
        budgetId,
      });
      expect(decision?.decision).toBe("approved");
      expect(decision?.budgetName).toBe("Fall Retreat");
      expect(decision?.submitterEmail).toBe("submitter@publicworship.life");
      expect(decision?.submitterName).toBe("Submitter");
      expect(decision?.reviewNote).toBe("Looks good, thanks!");
      expect(decision?.decidedByName).toBe("Approver");
    } finally {
      vi.useRealTimers();
      if (prevResendKey === undefined) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = prevResendKey;
    }
  });

  test("approving with no note leaves reviewNote null", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const submitterPersonId = await seedSelfPerson(s, "Submitter");
    await grantRole(s, submitterPersonId, "manager", "chapter");

    const budgetId = await createChapterBudget(s, "Ops");
    await s.as.mutation(api.finances.submitBudgetForApproval, { budgetId });

    const approver = await addMember(s, {
      email: "approver@publicworship.life",
      name: "Approver",
    });
    await grantRole(s, approver.personId, "manager", "chapter");
    await approver.as.mutation(api.finances.approveBudget, { budgetId });

    const decision = await t.query(internal.budgetDecisionEmails.getBudgetDecisionContext, {
      budgetId,
    });
    expect(decision?.decision).toBe("approved");
    expect(decision?.reviewNote).toBeNull();
  });
});

describe("requestBudgetChanges notifies the submitter back", () => {
  test("the reviewer's note carries through, decision is changes_requested", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const submitterPersonId = await seedSelfPerson(s, "Submitter");
    await grantRole(s, submitterPersonId, "manager", "chapter");

    const budgetId = await createChapterBudget(s, "Fall Retreat");
    await s.as.mutation(api.finances.submitBudgetForApproval, { budgetId });

    const approver = await addMember(s, {
      email: "approver@publicworship.life",
      name: "Approver",
    });
    await grantRole(s, approver.personId, "manager", "chapter");
    await approver.as.mutation(api.finances.requestBudgetChanges, {
      budgetId,
      note: "Please break out the venue cost separately.",
    });

    const decision = await t.query(internal.budgetDecisionEmails.getBudgetDecisionContext, {
      budgetId,
    });
    expect(decision?.decision).toBe("changes_requested");
    expect(decision?.reviewNote).toBe("Please break out the venue cost separately.");
    expect(decision?.decidedByName).toBe("Approver");
  });
});

describe("getBudgetDecisionContext degrades to null (never throws)", () => {
  test("before any decision (still submitted)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const submitterPersonId = await seedSelfPerson(s, "Submitter");
    await grantRole(s, submitterPersonId, "manager", "chapter");

    const budgetId = await createChapterBudget(s, "Ops");
    await s.as.mutation(api.finances.submitBudgetForApproval, { budgetId });

    const decision = await t.query(internal.budgetDecisionEmails.getBudgetDecisionContext, {
      budgetId,
    });
    expect(decision).toBeNull();
  });

  test("a still-draft budget", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const submitterPersonId = await seedSelfPerson(s, "Submitter");
    await grantRole(s, submitterPersonId, "manager", "chapter");

    const budgetId = await createChapterBudget(s, "Ops");

    const decision = await t.query(internal.budgetDecisionEmails.getBudgetDecisionContext, {
      budgetId,
    });
    expect(decision).toBeNull();
  });

  test("a nonexistent budget id", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const submitterPersonId = await seedSelfPerson(s, "Submitter");
    await grantRole(s, submitterPersonId, "manager", "chapter");

    const budgetId = await createChapterBudget(s, "Ops");
    await run(s.t, (ctx) => ctx.db.delete(budgetId));

    const decision = await t.query(internal.budgetDecisionEmails.getBudgetDecisionContext, {
      budgetId,
    });
    expect(decision).toBeNull();
  });
});
