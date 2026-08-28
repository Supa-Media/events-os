/// <reference types="vite/client" />
import { beforeEach, afterEach, describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import {
  newT,
  run,
  setupChapter,
  storeBlob,
  disarmCodingPolicy,
  type ChapterSetup,
} from "./setup.helpers";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

/**
 * CONTRACTOR PAYMENTS AT THE ORG LEVEL — central's own agreements.
 *
 * Founder, 2026-08-28: "why can't I send agreements or payments that are
 * central? I literally chose a budget that was a central budget… and it says
 * it's gonna be in New York's books. When it's a central budget. And when I
 * tried to get the contract link, it's like, switch to chapters desk to copy
 * contractors link, a central desk has no public page of his own."
 *
 * Three separate defects, and this suite pins each one:
 *
 *  1. THE SPEND BOOKED TO THE WRONG SET OF BOOKS. A payment funded by a central
 *     budget still posted its ledger row to the composer's chapter, so central's
 *     budget showed no spend and a chapter carried an expense it never agreed
 *     to. This is the one with lasting consequences — a ledger row is what a
 *     published month is built from.
 *  2. CENTRAL AGREEMENTS WERE UNREACHABLE. Authorization resolved the caller's
 *     ROSTER chapter, and nobody's roster row is in "central", so a central
 *     agreement could not be listed, opened, approved or paid by anyone.
 *  3. THE CONTRACTOR'S LINK COULD NOT BE BUILT. The slug came from the desk you
 *     were sitting at rather than from the record, and central had no public
 *     page at all. It has one now: `/contract/central`.
 */

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_INCREASE_KEY = process.env.INCREASE_API_KEY;
let seq = 0;

beforeEach(() => {
  process.env.INCREASE_API_KEY = "test_key";
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.includes("/external_accounts")) {
      seq += 1;
      return new Response(JSON.stringify({ id: `extacct_${seq}` }), {
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

// ── Fixtures ────────────────────────────────────────────────────────────────
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

/** A finance grant at a SCOPE — `"central"` for an org-level manager. */
async function grantManagerAt(
  s: ChapterSetup,
  personId: Id<"people">,
  scope: Id<"chapters"> | "central",
): Promise<void> {
  await run(s.t, (ctx) =>
    ctx.db.insert("financeRoles", {
      chapterId: scope,
      personId,
      role: scope === "central" ? "manager" : "manager",
      scope: scope === "central" ? "central" : "chapter",
      createdAt: Date.now(),
    }),
  );
}

async function setup(): Promise<{
  s: ChapterSetup;
  composerPersonId: Id<"people">;
  chapterBudgetId: Id<"budgets">;
  centralBudgetId: Id<"budgets">;
}> {
  const t = newT();
  const s = await setupChapter(t);
  await run(t, (ctx) => ctx.db.patch(s.chapterId, { slug: "new-york" }));
  await disarmCodingPolicy(t);
  const composerPersonId = await seedPerson(s, {
    name: "Composer",
    email: s.email,
    userId: s.userId,
  });
  // A CENTRAL grant — the whole point: this person may act on central's books.
  await grantManagerAt(s, composerPersonId, "central");
  await grantManagerAt(s, composerPersonId, s.chapterId);

  const chapterBudgetId = await run(t, (ctx) =>
    ctx.db.insert("budgets", {
      chapterId: s.chapterId,
      amountCents: 500_000,
      type: "recurring",
      cadence: "yearly",
      year: 2026,
      label: "Chapter production",
      createdAt: Date.now(),
    }),
  );
  const centralBudgetId = await run(t, (ctx) =>
    ctx.db.insert("budgets", {
      chapterId: "central",
      amountCents: 5_000_000,
      type: "recurring",
      cadence: "yearly",
      year: 2026,
      label: "City Launch Fund",
      createdAt: Date.now(),
    }),
  );
  return { s, composerPersonId, chapterBudgetId, centralBudgetId };
}

async function seedCentralApprover(s: ChapterSetup): Promise<{
  as: ReturnType<ChapterSetup["t"]["withIdentity"]>;
  personId: Id<"people">;
}> {
  const email = "fm@publicworship.life";
  const userId = await run(s.t, (ctx) => ctx.db.insert("users", { email }));
  await run(s.t, (ctx) =>
    ctx.db.insert("userChapters", {
      userId,
      chapterId: s.chapterId,
      role: "admin",
      isActive: true,
      joinedAt: Date.now(),
    }),
  );
  const personId = await seedPerson(s, {
    name: "Financial Manager",
    email,
    userId,
  });
  await grantManagerAt(s, personId, "central");
  return {
    as: s.t.withIdentity({ subject: `${userId}|session`, issuer: "test" }),
    personId,
  };
}

const AGREEMENT = {
  payeeName: "Jane Contractor",
  payeeEmail: "jane@example.com",
  serviceDescription: "Mixing and mastering the launch record",
  agreedAmountCents: 120_000,
};

// ── 1. Central agreements exist, and are reachable ──────────────────────────
describe("an agreement can belong to central", () => {
  test("composed at central, it is central's — books, queue and all", async () => {
    const { s, centralBudgetId } = await setup();
    const { contractorPaymentId } = await s.as.mutation(
      api.contractorPayments.createAgreement,
      { ...AGREEMENT, scope: "central", budgetId: centralBudgetId },
    );

    const row = await run(s.t, (ctx) => ctx.db.get(contractorPaymentId));
    expect(row!.chapterId).toBe("central");

    // Reachable — the defect was that NOBODY could open one, because
    // authorization looked for a roster person inside "central".
    const detail = await s.as.query(api.contractorPayments.get, {
      contractorPaymentId,
    });
    expect(detail.isCentral).toBe(true);
    expect(detail.scopeName).toBe("Central");

    // And it appears in CENTRAL's queue, not the composer's home chapter's.
    const centralQueue = await s.as.query(api.contractorPayments.list, {
      scope: "central",
    });
    expect(centralQueue.payments.map((p) => p._id)).toContain(
      contractorPaymentId,
    );
    const chapterQueue = await s.as.query(api.contractorPayments.list, {
      scope: s.chapterId,
    });
    expect(chapterQueue.payments.map((p) => p._id)).not.toContain(
      contractorPaymentId,
    );
  });

  test("a chapter-only manager cannot touch central's money", async () => {
    const { s, centralBudgetId } = await setup();
    const { contractorPaymentId } = await s.as.mutation(
      api.contractorPayments.createAgreement,
      { ...AGREEMENT, scope: "central", budgetId: centralBudgetId },
    );

    // A manager at New York and nowhere else. Reach flows DOWN from the org
    // level, never up from one chapter into it — otherwise any chapter
    // treasurer could spend the City Launch Fund.
    const email = "ny-only@publicworship.life";
    const userId = await run(s.t, (ctx) => ctx.db.insert("users", { email }));
    await run(s.t, (ctx) =>
      ctx.db.insert("userChapters", {
        userId,
        chapterId: s.chapterId,
        role: "admin",
        isActive: true,
        joinedAt: Date.now(),
      }),
    );
    const personId = await seedPerson(s, { name: "NY Treasurer", email, userId });
    await grantManagerAt(s, personId, s.chapterId);
    const asChapterOnly = s.t.withIdentity({
      subject: `${userId}|session`,
      issuer: "test",
    });

    await expect(
      asChapterOnly.query(api.contractorPayments.get, { contractorPaymentId }),
    ).rejects.toThrow(ConvexError);
    await expect(
      asChapterOnly.mutation(api.contractorPayments.approve, {
        contractorPaymentId,
      }),
    ).rejects.toThrow(ConvexError);
  });
});

// ── 2. The spend books where the money comes from ───────────────────────────
describe("the books follow the budget", () => {
  test("a central agreement posts its ledger row to CENTRAL", async () => {
    const { s, centralBudgetId } = await setup();
    const { contractorPaymentId } = await s.as.mutation(
      api.contractorPayments.createAgreement,
      { ...AGREEMENT, scope: "central", budgetId: centralBudgetId },
    );
    await s.as.mutation(api.contractorPayments.send, { contractorPaymentId });
    const token = await run(s.t, async (ctx) => {
      const row = await ctx.db.get(contractorPaymentId);
      return row!.token;
    });
    const storageId = await storeBlob(s.t);
    await s.t.mutation(api.contractorPayments.completeAgreement, {
      token,
      payeeName: AGREEMENT.payeeName,
      payeeEmail: AGREEMENT.payeeEmail,
      taxDocStorageId: storageId,
      taxDocKind: "w9",
      externalAccountId: "extacct_test",
      bankAccountLast4: "6789",
      signature: "Jane Contractor",
    });

    const approver = await seedCentralApprover(s);
    await approver.as.mutation(api.contractorPayments.approve, {
      contractorPaymentId,
    });
    await approver.as.mutation(api.contractorPayouts.markPaidManually, {
      contractorPaymentId,
    });

    const txn = await run(s.t, (ctx) =>
      ctx.db
        .query("transactions")
        .withIndex("by_contractor_payment", (q) =>
          q.eq("contractorPaymentId", contractorPaymentId),
        )
        .first(),
    );
    // THE HEADLINE FIX. Booked to a chapter, central's budget shows no spend
    // against money central agreed to pay — and a chapter's published month
    // carries an expense that was never its own.
    expect(txn!.chapterId).toBe("central");
    expect(txn!.budgetId).toBe(centralBudgetId);
    expect(txn!.flow).toBe("outflow");

    // The payout is central's too, so the account the money leaves and the
    // books it lands in are the same scope.
    const payout = await run(s.t, (ctx) =>
      ctx.db
        .query("payouts")
        .withIndex("by_contractor_payment", (q) =>
          q.eq("contractorPaymentId", contractorPaymentId),
        )
        .first(),
    );
    expect(payout!.chapterId).toBe("central");
  });

  test("a chapter agreement can't be coded to a central budget", async () => {
    const { s, centralBudgetId } = await setup();
    // The exact shape of the report: picking central money while composing in
    // a chapter. Refused rather than silently rescoped — moving it to central
    // would change who reviews it and which bank account sends.
    await expect(
      s.as.mutation(api.contractorPayments.createAgreement, {
        ...AGREEMENT,
        scope: s.chapterId,
        budgetId: centralBudgetId,
      }),
    ).rejects.toThrow(ConvexError);
  });

  test("a central agreement can't be coded to a chapter's budget either", async () => {
    const { s, chapterBudgetId } = await setup();
    await expect(
      s.as.mutation(api.contractorPayments.createAgreement, {
        ...AGREEMENT,
        scope: "central",
        budgetId: chapterBudgetId,
      }),
    ).rejects.toThrow(ConvexError);
  });

  test("re-coding across scopes is refused too, not just creation", async () => {
    const { s, chapterBudgetId, centralBudgetId } = await setup();
    const { contractorPaymentId } = await s.as.mutation(
      api.contractorPayments.createAgreement,
      { ...AGREEMENT, scope: s.chapterId, budgetId: chapterBudgetId },
    );
    await expect(
      s.as.mutation(api.contractorPayments.updateTerms, {
        contractorPaymentId,
        budgetId: centralBudgetId,
      }),
    ).rejects.toThrow(ConvexError);
  });

  test("central's picker offers central's budgets, and a chapter's offers its own", async () => {
    const { s, chapterBudgetId, centralBudgetId } = await setup();

    const central = await s.as.query(
      api.contractorPayments.codingOptionsForScope,
      { scope: "central" },
    );
    expect(central.budgets.map((b) => b.id)).toEqual([centralBudgetId]);

    const chapter = await s.as.query(
      api.contractorPayments.codingOptionsForScope,
      { scope: s.chapterId },
    );
    // A central budget in a chapter's picker is how the wrong coding got made
    // in the first place.
    expect(chapter.budgets.map((b) => b.id)).toEqual([chapterBudgetId]);
  });
});

// ── 3. Central has a public page ────────────────────────────────────────────
describe("the contractor's link works for central", () => {
  test("/contract/central resolves, and the record hands over its own slug", async () => {
    const { s, centralBudgetId } = await setup();
    const { contractorPaymentId } = await s.as.mutation(
      api.contractorPayments.createAgreement,
      { ...AGREEMENT, scope: "central", budgetId: centralBudgetId },
    );

    // The public resolver — this is what the `/contract/<slug>` route calls.
    const resolved = await s.t.query(api.contractorPayments.chapterForContract, {
      chapterSlug: "central",
    });
    expect(resolved).not.toBeNull();
    expect(resolved!.chapterId).toBe("central");
    expect(resolved!.name).toBe("Public Worship");

    // And the record itself knows where its page lives, so the app never has to
    // derive a slug from whichever desk the caller is sitting at.
    const detail = await s.as.query(api.contractorPayments.get, {
      contractorPaymentId,
    });
    expect(detail.scopeSlug).toBe("central");
  });

  test("the contractor is told the ORG's name, never the word 'Central'", async () => {
    const { s, centralBudgetId } = await setup();
    const { contractorPaymentId } = await s.as.mutation(
      api.contractorPayments.createAgreement,
      { ...AGREEMENT, scope: "central", budgetId: centralBudgetId },
    );
    await s.as.mutation(api.contractorPayments.send, { contractorPaymentId });
    const token = await run(s.t, async (ctx) => {
      const row = await ctx.db.get(contractorPaymentId);
      return row!.token;
    });

    const view = await s.t.query(api.contractorPayments.publicByToken, { token });
    // "Central" is internal vocabulary for a set of books. A stranger being
    // asked to sign an agreement is dealing with Public Worship.
    expect(view!.chapterName).toBe("Public Worship");
    expect(view!.chapterName).not.toContain("Central");
  });

  test("a chapter can't shadow central's page by claiming the slug", async () => {
    const { s } = await setup();
    await run(s.t, (ctx) => ctx.db.patch(s.chapterId, { slug: "central" }));
    const resolved = await s.t.query(api.contractorPayments.chapterForContract, {
      chapterSlug: "central",
    });
    // The reserved segment wins, so one scope's agreements can never be served
    // under another's name.
    expect(resolved!.chapterId).toBe("central");
  });
});
