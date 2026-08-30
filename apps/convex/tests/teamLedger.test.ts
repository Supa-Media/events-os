/**
 * THE BOOKS, OPEN TO THE TEAM (founder decision, 2026-08-30).
 *
 * "They can see the ledger too. They can see the full thing because ... it's
 * publicly set anyways, um, but they just can't edit."
 *
 * These tests pin both halves of that sentence: a plain roster member — no
 * `financeRoles` grant, no finance seat — READS the org's money, and still
 * cannot write it or reach the surfaces that deliberately stayed narrow.
 */
import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

const AUG_2026 = Date.UTC(2026, 7, 14, 16);
const AUG_KEY = "2026-08";

/** A signed-in user linked to a roster person, holding NOTHING else: no
 *  finance grant, no seat, not a chapter admin. The persona this change is
 *  for. */
async function addMember(
  s: ChapterSetup,
  email: string,
  opts: { isTeamMember?: boolean } = {},
) {
  const personId = await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Member",
      isTeamMember: opts.isTeamMember ?? true,
      createdAt: Date.now(),
    }),
  );
  const userId = await run(s.t, async (ctx) => {
    const userId = await ctx.db.insert("users", { email });
    await ctx.db.insert("userChapters", {
      userId,
      chapterId: s.chapterId,
      role: "member",
      isActive: true,
      joinedAt: Date.now(),
    });
    await ctx.db.patch(personId, { userId });
    return userId;
  });
  return {
    as: s.t.withIdentity({ subject: `${userId}|session`, issuer: "test" }),
    personId,
    userId,
  };
}

async function insertTxn(
  s: ChapterSetup,
  f: { merchantName?: string; amountCents?: number } = {},
): Promise<Id<"transactions">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("transactions", {
      chapterId: s.chapterId,
      source: "manual",
      flow: "outflow",
      amountCents: f.amountCents ?? 4_200,
      postedAt: AUG_2026,
      status: "reconciled",
      merchantName: f.merchantName ?? "Costco",
      createdAt: Date.now(),
    }),
  );
}

describe("publicLedger.teamStatement — a member reads the books", () => {
  test("a plain member with no finance role reads their chapter's month", async () => {
    const s = await setupChapter(newT());
    await insertTxn(s, { merchantName: "Guitar Center", amountCents: 12_500 });
    const { as } = await addMember(s, "member@publicworship.life");

    const statement = await as.query(api.publicLedger.teamStatement, {
      periodKey: AUG_KEY,
    });

    expect(statement.entryCount).toBe(1);
    expect(statement.expenseCents).toBe(12_500);
    expect(statement.entries[0].counterparty).toBe("Guitar Center");
    // The month is not published — the team reads it anyway, which is the
    // whole point (they see it BEFORE the public does).
    expect(statement.books).toEqual([]);
  });

  test("someone with no roster profile in the chapter is refused", async () => {
    const s = await setupChapter(newT());
    await insertTxn(s);
    const userId = await run(s.t, async (ctx) => {
      const userId = await ctx.db.insert("users", {
        email: "stranger@publicworship.life",
      });
      await ctx.db.insert("userChapters", {
        userId,
        chapterId: s.chapterId,
        role: "member",
        isActive: true,
        joinedAt: Date.now(),
      });
      return userId;
    });
    const as = s.t.withIdentity({
      subject: `${userId}|session`,
      issuer: "test",
    });

    await expect(
      as.query(api.publicLedger.teamStatement, { periodKey: AUG_KEY }),
    ).rejects.toThrow(ConvexError);
  });

  test("a placeholder roster row is not a member", async () => {
    const s = await setupChapter(newT());
    await insertTxn(s);
    const personId = await run(s.t, (ctx) =>
      ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Stand-in",
        isPlaceholder: true,
        createdAt: Date.now(),
      }),
    );
    const userId = await run(s.t, async (ctx) => {
      const userId = await ctx.db.insert("users", {
        email: "placeholder@publicworship.life",
      });
      await ctx.db.insert("userChapters", {
        userId,
        chapterId: s.chapterId,
        role: "member",
        isActive: true,
        joinedAt: Date.now(),
      });
      await ctx.db.patch(personId, { userId });
      return userId;
    });
    const as = s.t.withIdentity({
      subject: `${userId}|session`,
      issuer: "test",
    });

    await expect(
      as.query(api.publicLedger.teamStatement, { periodKey: AUG_KEY }),
    ).rejects.toThrow(ConvexError);
  });

  test("the month picker reaches back to the book's earliest transaction", async () => {
    const s = await setupChapter(newT());
    // A transaction well outside any fixed window — the bug a fixed window
    // reintroduces (founder, 2026-08-12: "coding publish only goes back March
    // 2025" when the data reached into 2024).
    await run(s.t, (ctx) =>
      ctx.db.insert("transactions", {
        chapterId: s.chapterId,
        source: "manual",
        flow: "outflow",
        amountCents: 1_000,
        postedAt: Date.UTC(2024, 0, 15, 16),
        status: "reconciled",
        merchantName: "Old Vendor",
        createdAt: Date.now(),
      }),
    );
    const { as } = await addMember(s, "picker@publicworship.life");

    const months = await as.query(api.publicLedger.teamLedgerMonths, {});
    expect(months.some((m) => m.periodKey === "2024-01")).toBe(true);
    // Newest first, and never past the ceiling.
    expect(months.length).toBeLessThanOrEqual(60);
    expect(months[0].periodKey > months[months.length - 1].periodKey).toBe(true);
  });
});

describe("a member reads but cannot write", () => {
  test("recording a transaction is still refused", async () => {
    const s = await setupChapter(newT());
    const { as } = await addMember(s, "nowrite@publicworship.life");

    await expect(
      as.mutation(api.finances.createManualTransaction, {
        amountCents: 500,
        flow: "outflow",
        postedAt: AUG_2026,
        merchantName: "Nope",
      }),
    ).rejects.toThrow(ConvexError);
  });

  test("the reconcile grid is still refused", async () => {
    const s = await setupChapter(newT());
    await insertTxn(s);
    const { as } = await addMember(s, "nogrid@publicworship.life");

    await expect(
      as.query(api.finances.listReconcile, {}),
    ).rejects.toThrow(ConvexError);
  });

  test("contractor payments stayed narrow", async () => {
    const s = await setupChapter(newT());
    const { as } = await addMember(s, "nocontractors@publicworship.life");

    await expect(
      as.query(api.contractorPayments.list, {}),
    ).rejects.toThrow(ConvexError);
  });

  test("the publish console stayed narrow", async () => {
    const s = await setupChapter(newT());
    const { as } = await addMember(s, "noconsole@publicworship.life");

    await expect(
      as.query(api.publicLedger.console_, {}),
    ).rejects.toThrow(ConvexError);
  });

  test("the roster's personal charges stayed narrow", async () => {
    const s = await setupChapter(newT());
    const { as } = await addMember(s, "nocharges@publicworship.life");

    await expect(
      as.query(api.cards.listPersonalRepayments, {}),
    ).rejects.toThrow(ConvexError);
  });
});

describe("the surfaces that opened with the books", () => {
  test("a member reads the chapter's reimbursement queue", async () => {
    const s = await setupChapter(newT());
    const { as, personId } = await addMember(s, "reimb@publicworship.life");
    await run(s.t, (ctx) =>
      ctx.db.insert("reimbursementRequests", {
        chapterId: s.chapterId,
        personId,
        payeeName: "Member",
        payeeEmail: "reimb@publicworship.life",
        token: `tok-reimb-${Date.now()}`,
        status: "submitted",
        totalCents: 2_500,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        submittedAt: Date.now(),
      }),
    );

    const queue = await as.query(api.reimbursements.list, {});
    expect(queue).toHaveLength(1);
    expect(queue[0].totalCents).toBe(2_500);
    // The payload a member may read carries no banking detail — the check
    // that made widening this safe.
    expect(queue[0]).not.toHaveProperty("externalAccountId");
    expect(queue[0]).not.toHaveProperty("bankLast4");
    expect(queue[0]).not.toHaveProperty("token");
  });

  test("but deciding one is still refused", async () => {
    const s = await setupChapter(newT());
    const { as, personId } = await addMember(s, "nodecide@publicworship.life");
    const reimbursementId = await run(s.t, (ctx) =>
      ctx.db.insert("reimbursementRequests", {
        chapterId: s.chapterId,
        personId,
        payeeName: "Member",
        payeeEmail: "nodecide@publicworship.life",
        token: `tok-nodecide-${Date.now()}`,
        status: "submitted",
        totalCents: 2_500,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        submittedAt: Date.now(),
      }),
    );

    await expect(
      as.mutation(api.reimbursements.approve, { reimbursementId }),
    ).rejects.toThrow(ConvexError);
  });
});

describe("budget detail: read yes, act no", () => {
  test("a member reads line detail but is offered no write affordance", async () => {
    const s = await setupChapter(newT());
    const { as } = await addMember(s, "budgets@publicworship.life");
    const budgetId = await run(s.t, (ctx) =>
      ctx.db.insert("budgets", {
        chapterId: s.chapterId,
        label: "Sound gear",
        amountCents: 50_000,
        type: "one_time",
        cadence: "per_instance",
        year: 2026,
        // Sitting in the one state whose buttons rendered off status alone.
        approvalStatus: "submitted",
        createdAt: Date.now(),
      }),
    );

    const detail = await as.query(api.budgetDetail.getBudgetDetail, { budgetId });
    expect(detail).not.toBeNull();
    expect(detail!.transactionTotalCount).toBe(0);
    // The three flags the page renders its buttons from. All false: this is
    // what stops a member being shown "Approve" and then refused on tap.
    expect(detail!.canEdit).toBe(false);
    expect(detail!.canSubmit).toBe(false);
    expect(detail!.canDecide).toBe(false);
  });

  test("and approving it is refused at the mutation too", async () => {
    const s = await setupChapter(newT());
    const { as } = await addMember(s, "noapprove@publicworship.life");
    const budgetId = await run(s.t, (ctx) =>
      ctx.db.insert("budgets", {
        chapterId: s.chapterId,
        label: "Sound gear",
        amountCents: 50_000,
        type: "one_time",
        cadence: "per_instance",
        year: 2026,
        approvalStatus: "submitted",
        createdAt: Date.now(),
      }),
    );

    await expect(
      as.mutation(api.finances.approveBudget, { budgetId }),
    ).rejects.toThrow(ConvexError);
  });
});
