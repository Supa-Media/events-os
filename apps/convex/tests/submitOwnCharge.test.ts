/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

/**
 * `finances.submitOwnCharge` — the cardholder's "Concur-style" self-service
 * pre-fill on their OWN card charge (NOT bookkeeper-gated; additive to
 * `categorizeTransaction`):
 *
 *  - the cardholder can set `categoryId` + `note` on a charge on THEIR card,
 *    which also advances an `unreviewed` row to `categorized` (the SAME status
 *    move the reconcile paths make — never any other reattribution);
 *  - a NON-owner (another member, or nobody's-person caller) is FORBIDDEN;
 *  - a category from ANOTHER chapter is rejected (NOT_FOUND — the same
 *    `requireInCallerChapter` tenancy the reconcile paths enforce);
 *  - a non-card txn is NOT_A_CARD_CHARGE;
 *  - a `reconciled` row is refused (RECONCILED_LOCKED — the Treasurer closed it);
 *  - the personal flag creates exactly one pending `personalRepayments` row
 *    (via the shared `convertChargeToPersonalRepayment` — idempotent).
 *
 * The caller is always `setupChapter`'s seeded user; a `people` row carrying
 * that `userId` (`seedCaller`) is what `getFinanceRole` resolves to
 * `access.personId`, so making that person the card's `cardholderPersonId`
 * makes the caller the owner.
 */

async function seedPerson(
  s: ChapterSetup,
  opts: { name: string; userId?: Id<"users">; chapterId?: Id<"chapters"> },
): Promise<Id<"people">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: opts.chapterId ?? s.chapterId,
      name: opts.name,
      userId: opts.userId,
      isTeamMember: true,
      createdAt: Date.now(),
    }),
  );
}

/** The caller's own roster person (carries the setup user's `userId`). */
async function seedCaller(s: ChapterSetup): Promise<Id<"people">> {
  return seedPerson(s, { name: "Me", userId: s.userId });
}

async function seedCard(
  s: ChapterSetup,
  cardholderPersonId: Id<"people">,
  chapterId?: Id<"chapters">,
): Promise<Id<"cards">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("cards", {
      chapterId: chapterId ?? s.chapterId,
      cardholderPersonId,
      type: "virtual",
      status: "active",
      createdAt: Date.now(),
    }),
  );
}

async function seedCardTxn(
  s: ChapterSetup,
  opts: {
    cardId: Id<"cards">;
    personId: Id<"people">;
    status?: "unreviewed" | "categorized" | "reconciled";
  },
): Promise<Id<"transactions">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("transactions", {
      chapterId: s.chapterId,
      source: "increase_card",
      flow: "outflow",
      amountCents: 4200,
      postedAt: Date.now(),
      cardId: opts.cardId,
      personId: opts.personId,
      cardLast4: "4242",
      status: opts.status ?? "unreviewed",
      createdAt: Date.now(),
    }),
  );
}

/** Seed an ORG-WIDE spend category (no chapter, no fund — 2026-08-14). */
async function seedCategory(
  s: ChapterSetup,
  name = "Supplies",
): Promise<Id<"budgetCategories">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("budgetCategories", {
      name,
      kind: "lineItem",
      sortOrder: 0,
      createdAt: Date.now(),
    }),
  );
}

async function getTxn(s: ChapterSetup, id: Id<"transactions">) {
  return await run(s.t, (ctx) => ctx.db.get(id));
}

describe("finances.submitOwnCharge", () => {
  test("cardholder sets category + note; unreviewed advances to categorized", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const me = await seedCaller(s);
    const card = await seedCard(s, me);
    const txnId = await seedCardTxn(s, { cardId: card, personId: me });
    const categoryId = await seedCategory(s);

    await s.as.mutation(api.finances.submitOwnCharge, {
      transactionId: txnId,
      categoryId,
      note: "  Snacks for the youth night  ",
    });

    const txn = await getTxn(s, txnId);
    expect(txn?.categoryId).toBe(categoryId);
    // Note is trimmed + stored.
    expect(txn?.note).toBe("Snacks for the youth night");
    // Advanced unreviewed → categorized (the only status move this path makes).
    expect(txn?.status).toBe("categorized");
    // Never touched by this path.
    expect(txn?.fundId).toBeUndefined();
    expect(txn?.budgetId).toBeUndefined();
    expect(txn?.isPersonal).not.toBe(true);
  });

  test("a non-owner member is FORBIDDEN", async () => {
    const t = newT();
    const s = await setupChapter(t);
    // Caller has a roster person, but the card belongs to SOMEONE ELSE.
    await seedCaller(s);
    const other = await seedPerson(s, { name: "Other" });
    const card = await seedCard(s, other);
    const txnId = await seedCardTxn(s, { cardId: card, personId: other });
    const categoryId = await seedCategory(s);

    await expect(
      s.as.mutation(api.finances.submitOwnCharge, {
        transactionId: txnId,
        categoryId,
      }),
    ).rejects.toThrow(ConvexError);
  });

  test("a caller with no roster person is FORBIDDEN (random member)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    // No `seedCaller` — the setup user has no `people` row, so
    // `access.personId` is null and can never equal the cardholder.
    const holder = await seedPerson(s, { name: "Holder" });
    const card = await seedCard(s, holder);
    const txnId = await seedCardTxn(s, { cardId: card, personId: holder });

    await expect(
      s.as.mutation(api.finances.submitOwnCharge, {
        transactionId: txnId,
        note: "trying to touch someone else's charge",
      }),
    ).rejects.toThrow(ConvexError);
  });

  // Was "a category from ANOTHER chapter is rejected". There is one org list
  // now, and it is the SAME list `myChargeCategories` hands the cardholder — so
  // a picker option can no longer be refused by the mutation behind it. What is
  // still refused is an id with no category behind it.
  test("a category that no longer exists is rejected", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const me = await seedCaller(s);
    const card = await seedCard(s, me);
    const txnId = await seedCardTxn(s, { cardId: card, personId: me });
    const goneCategory = await seedCategory(s, "Deleted");
    await run(s.t, (ctx) => ctx.db.delete(goneCategory));

    await expect(
      s.as.mutation(api.finances.submitOwnCharge, {
        transactionId: txnId,
        categoryId: goneCategory,
      }),
    ).rejects.toThrow(ConvexError);
  });

  test("a non-card txn is NOT_A_CARD_CHARGE", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const me = await seedCaller(s);
    // A plain (non-card) txn attributed to the caller.
    const txnId = await run(s.t, (ctx) =>
      ctx.db.insert("transactions", {
        chapterId: s.chapterId,
        source: "manual",
        flow: "outflow",
        amountCents: 1000,
        postedAt: Date.now(),
        personId: me,
        status: "unreviewed",
        createdAt: Date.now(),
      }),
    );

    await expect(
      s.as.mutation(api.finances.submitOwnCharge, {
        transactionId: txnId,
        note: "no card here",
      }),
    ).rejects.toThrow(ConvexError);
  });

  test("a reconciled row is refused (RECONCILED_LOCKED)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const me = await seedCaller(s);
    const card = await seedCard(s, me);
    const txnId = await seedCardTxn(s, {
      cardId: card,
      personId: me,
      status: "reconciled",
    });
    const categoryId = await seedCategory(s);

    await expect(
      s.as.mutation(api.finances.submitOwnCharge, {
        transactionId: txnId,
        categoryId,
      }),
    ).rejects.toThrow(ConvexError);
  });

  test("the personal flag creates exactly one pending repayment (idempotent)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const me = await seedCaller(s);
    const card = await seedCard(s, me);
    const txnId = await seedCardTxn(s, { cardId: card, personId: me });

    await s.as.mutation(api.finances.submitOwnCharge, {
      transactionId: txnId,
      note: "personal, will pay back",
      flagPersonal: true,
    });

    const txn = await getTxn(s, txnId);
    expect(txn?.isPersonal).toBe(true);
    expect(txn?.repaymentId).toBeTruthy();

    const reps = await run(s.t, (ctx) =>
      ctx.db
        .query("personalRepayments")
        .withIndex("by_transaction", (q) => q.eq("transactionId", txnId))
        .collect(),
    );
    expect(reps.length).toBe(1);
    expect(reps[0].status).toBe("pending");
    expect(reps[0].payerPersonId).toBe(me);
    expect(reps[0].amountCents).toBe(4200);

    // A second submit with the flag is a no-op — still exactly one repayment.
    await s.as.mutation(api.finances.submitOwnCharge, {
      transactionId: txnId,
      flagPersonal: true,
    });
    const reps2 = await run(s.t, (ctx) =>
      ctx.db
        .query("personalRepayments")
        .withIndex("by_transaction", (q) => q.eq("transactionId", txnId))
        .collect(),
    );
    expect(reps2.length).toBe(1);
  });

  test("myChargeCategories is member-visible (no finance seat) and chapter-scoped", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedCaller(s);
    const categoryId = await seedCategory(s);

    const cats = await s.as.query(api.finances.myChargeCategories, {});
    expect(cats.map((c) => c.id)).toContain(categoryId);
    expect(cats.find((c) => c.id === categoryId)?.name).toBe("Supplies");
  });

  test("myChargeCategories surfaces expenseTypeHint verbatim, and omits it when unset", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedCaller(s);
    const hinted = await seedCategory(s);
    await run(s.t, (ctx) => ctx.db.patch(hinted, { expenseType: "travel" }));
    // A second, hint-less category — the common case — must NOT surface a
    // stray `expenseTypeHint` key (the client reads its absence as "nothing
    // picks it for you").
    const unhinted = await run(s.t, (ctx) =>
      ctx.db.insert("budgetCategories", {
        name: "Other",
        kind: "category",
        sortOrder: 1,
        createdAt: Date.now(),
      }),
    );

    const cats = await s.as.query(api.finances.myChargeCategories, {});
    expect(cats.find((c) => c.id === hinted)?.expenseTypeHint).toBe("travel");
    expect(
      Object.prototype.hasOwnProperty.call(
        cats.find((c) => c.id === unhinted) ?? {},
        "expenseTypeHint",
      ),
    ).toBe(false);
  });
});
