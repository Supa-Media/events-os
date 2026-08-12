/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { newT, run, setupChapter, storeBlob, type ChapterSetup } from "./setup.helpers";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";

// ── Increase mock plumbing (every submission resolves a real ACH destination),
// same shape as `reimbursementCoding.test.ts`'s own setup. ───────────────────
const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_INCREASE_KEY = process.env.INCREASE_API_KEY;
let extAcctSeq = 0;

beforeEach(() => {
  process.env.INCREASE_API_KEY = "test_key";
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.includes("/external_accounts")) {
      extAcctSeq += 1;
      return new Response(JSON.stringify({ id: `extacct_hint_${extAcctSeq}` }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch: ${path}`);
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_INCREASE_KEY === undefined) delete process.env.INCREASE_API_KEY;
  else process.env.INCREASE_API_KEY = ORIGINAL_INCREASE_KEY;
});

/**
 * Reimbursements — the founder's scope expansion: a per-line CATEGORY, sent
 * by the AUTHENTICATED in-app form only. See `apps/mobile/components/finance/
 * reimbursements/CodingFields.tsx`'s own module doc for the full design
 * argument; this pins the server-side half of it:
 *
 *  1. `submitReimbursement` (authed) accepts + PERSISTS a line's `categoryId`
 *     verbatim — it always could (`submitLineValidator`), the in-app form just
 *     never sent one before.
 *  2. `submitPublicReimbursement` (accountless) still STRIPS any client-
 *     supplied `categoryId`, even a raw API call trying to smuggle one
 *     through — a deliberate privacy/security posture
 *     (`reimbursements.ts`'s own doc on `submitPublicReimbursement`), not
 *     merely absent UI. Pinned here so a future refactor can't quietly drop
 *     the strip.
 *  3. The booked payout transaction ports a line category ONLY when every
 *     line agrees (`deriveReimbursementTxnFields#unanimous`) — an agreeing
 *     multi-line request books its shared category; a mixed one leaves the
 *     payout uncategorized for a bookkeeper, exactly like an ambiguous fund.
 */

const PURPOSE = "Supplies for the Worship with Strangers shoot in July";

async function setSlug(s: ChapterSetup, slug: string): Promise<void> {
  await run(s.t, (ctx) => ctx.db.patch(s.chapterId, { slug }));
}

async function seedPerson(
  s: ChapterSetup,
  opts: { name: string; email?: string; userId?: Id<"users"> },
): Promise<Id<"people">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: opts.name,
      email: opts.email,
      userId: opts.userId,
      isTeamMember: true,
      createdAt: Date.now(),
    }),
  );
}

async function seedCategory(s: ChapterSetup, name: string): Promise<Id<"budgetCategories">> {
  const fundId = await run(s.t, (ctx) =>
    ctx.db.insert("funds", {
      chapterId: s.chapterId,
      name: "General Fund",
      restriction: "unrestricted",
      sortOrder: 0,
      createdAt: Date.now(),
    }),
  );
  return await run(s.t, (ctx) =>
    ctx.db.insert("budgetCategories", {
      chapterId: s.chapterId,
      fundId,
      name,
      kind: "category",
      sortOrder: 0,
      createdAt: Date.now(),
    }),
  );
}

type LineArg = Record<string, unknown>;

async function line(s: ChapterSetup, overrides: LineArg = {}): Promise<LineArg> {
  return {
    description: "Gaffer tape",
    amountCents: 1200,
    transactionDate: Date.now(),
    expenseType: "general",
    businessPurpose: PURPOSE,
    receiptStorageId: await storeBlob(s.t),
    ...overrides,
  };
}

async function linesOf(
  s: ChapterSetup,
  reimbursementId: Id<"reimbursementRequests">,
): Promise<Doc<"reimbursementLineItems">[]> {
  const rows = await run(s.t, (ctx) =>
    ctx.db
      .query("reimbursementLineItems")
      .withIndex("by_reimbursement", (q) => q.eq("reimbursementId", reimbursementId))
      .collect(),
  );
  return rows.sort((a, b) => a.order - b.order);
}

async function publicBank(s: ChapterSetup): Promise<{ externalAccountId: string; last4?: string }> {
  const result = await s.t.action(api.reimbursements.linkPublicBankAccount, {
    routingNumber: "011000015",
    accountNumber: "555000111",
  });
  if (!result.linked || !result.externalAccountId) {
    throw new Error("bank link failed in fixture");
  }
  return { externalAccountId: result.externalAccountId, last4: result.last4 };
}

describe("submitReimbursement (authed, in-app) persists a line's categoryId", () => {
  test("a category picked in-app lands on the stored line verbatim", async () => {
    const s = await setupChapter(newT());
    await seedPerson(s, { name: "Dana Rivers", email: "dana@example.com", userId: s.userId });
    const categoryId = await seedCategory(s, "Transportation");
    const bank = await s.as.action(api.reimbursements.linkBankAccount, {
      routingNumber: "011000015",
      accountNumber: "0987654321",
    });

    const { reimbursementId } = await s.as.mutation(api.reimbursements.submitReimbursement, {
      purpose: "Event supplies",
      externalAccountId: bank.externalAccountId!,
      lines: [await line(s, { categoryId, expenseType: "travel", travelFrom: "Boston", travelTo: "NY" })] as never,
    });

    const [stored] = await linesOf(s, reimbursementId);
    expect(stored.categoryId).toBe(categoryId);
  });

  test("a category from ANOTHER chapter is rejected (untrusted input)", async () => {
    const s = await setupChapter(newT());
    await seedPerson(s, { name: "Dana Rivers", email: "dana@example.com", userId: s.userId });
    const otherChapterId = await run(s.t, (ctx) =>
      ctx.db.insert("chapters", { name: "Other", isActive: true, createdAt: Date.now() }),
    );
    const otherFundId = await run(s.t, (ctx) =>
      ctx.db.insert("funds", {
        chapterId: otherChapterId,
        name: "General Fund",
        restriction: "unrestricted",
        sortOrder: 0,
        createdAt: Date.now(),
      }),
    );
    const foreignCategoryId = await run(s.t, (ctx) =>
      ctx.db.insert("budgetCategories", {
        chapterId: otherChapterId,
        fundId: otherFundId,
        name: "Not Yours",
        kind: "category",
        sortOrder: 0,
        createdAt: Date.now(),
      }),
    );
    const bank = await s.as.action(api.reimbursements.linkBankAccount, {
      routingNumber: "011000015",
      accountNumber: "0987654321",
    });

    await expect(
      s.as.mutation(api.reimbursements.submitReimbursement, {
        purpose: "Event supplies",
        externalAccountId: bank.externalAccountId!,
        lines: [await line(s, { categoryId: foreignCategoryId })] as never,
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });
});

describe("submitPublicReimbursement strips a smuggled categoryId (pinned)", () => {
  test("a categoryId on a public-path line is dropped even though the validator accepts it", async () => {
    const s = await setupChapter(newT());
    await setSlug(s, "nyc");
    const categoryId = await seedCategory(s, "Transportation");
    const bank = await publicBank(s);

    const { token } = await s.t.mutation(api.reimbursements.submitPublicReimbursement, {
      chapterSlug: "nyc",
      payeeName: "Vera Volunteer",
      payeeEmail: "vera@example.com",
      purpose: "Event supplies",
      externalAccountId: bank.externalAccountId,
      bankAccountLast4: bank.last4,
      // A raw API call TRYING to smuggle a categoryId through — the public
      // form itself never renders a picker, but the server is the real gate.
      lines: [await line(s, { categoryId })] as never,
    });

    const req = await run(s.t, (ctx) =>
      ctx.db
        .query("reimbursementRequests")
        .withIndex("by_token", (q) => q.eq("token", token))
        .unique(),
    );
    const [stored] = await linesOf(s, req!._id);
    expect(stored.categoryId).toBeUndefined();
  });
});

describe("the payout ports a line category only when every line agrees (unanimous)", () => {
  async function seedApprovedRequest(
    s: ChapterSetup,
    payeePersonId: Id<"people">,
    lineCategoryIds: (Id<"budgetCategories"> | undefined)[],
  ): Promise<Id<"reimbursementRequests">> {
    const now = Date.now();
    const reimbursementId = await run(s.t, (ctx) =>
      ctx.db.insert("reimbursementRequests", {
        chapterId: s.chapterId,
        token: crypto.randomUUID(),
        status: "approved",
        payeeName: "Sarah",
        payeeEmail: "sarah@example.com",
        personId: payeePersonId,
        totalCents: lineCategoryIds.length * 1000,
        approvedCents: lineCategoryIds.length * 1000,
        bankAccountLast4: "1234",
        submittedAt: now,
        approvedAt: now,
        createdAt: now,
        updatedAt: now,
      }),
    );
    for (let i = 0; i < lineCategoryIds.length; i++) {
      await run(s.t, (ctx) =>
        ctx.db.insert("reimbursementLineItems", {
          chapterId: s.chapterId,
          reimbursementId,
          description: `Line ${i}`,
          amountCents: 1000,
          categoryId: lineCategoryIds[i],
          order: i,
          createdAt: now,
        }),
      );
    }
    return reimbursementId;
  }

  async function seedManager(s: ChapterSetup): Promise<void> {
    const personId = await seedPerson(s, { name: "Treasurer", userId: s.userId });
    await run(s.t, (ctx) =>
      ctx.db.insert("financeRoles", {
        chapterId: s.chapterId,
        personId,
        role: "manager",
        scope: "chapter",
        createdAt: Date.now(),
      }),
    );
  }

  async function payoutTxn(s: ChapterSetup, reimbursementId: Id<"reimbursementRequests">) {
    return run(s.t, (ctx) =>
      ctx.db
        .query("transactions")
        .withIndex("by_reimbursement", (q) => q.eq("reimbursementId", reimbursementId))
        .first(),
    );
  }

  test("AGREEING lines (same category) port it to the booked payout", async () => {
    const s = await setupChapter(newT());
    await seedManager(s);
    const sarah = await seedPerson(s, { name: "Sarah" });
    const categoryId = await seedCategory(s, "Food & Meals");

    const reimbursementId = await seedApprovedRequest(s, sarah, [categoryId, categoryId]);
    await s.as.mutation(api.increasePayouts.markPaidManually, { reimbursementId });

    const txn = await payoutTxn(s, reimbursementId);
    expect(txn?.categoryId).toBe(categoryId);
  });

  test("MIXED lines (disagreeing categories) leave the payout uncategorized", async () => {
    const s = await setupChapter(newT());
    await seedManager(s);
    const sarah = await seedPerson(s, { name: "Sarah" });
    const meals = await seedCategory(s, "Food & Meals");
    const transport = await seedCategory(s, "Transportation");

    const reimbursementId = await seedApprovedRequest(s, sarah, [meals, transport]);
    await s.as.mutation(api.increasePayouts.markPaidManually, { reimbursementId });

    const txn = await payoutTxn(s, reimbursementId);
    expect(txn?.categoryId).toBeUndefined();
  });
});
