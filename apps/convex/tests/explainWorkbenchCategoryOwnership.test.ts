/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { newT, run, setupChapter, storeBlob, type ChapterSetup } from "./setup.helpers";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

/**
 * HIGH review finding (server-probed): the Explain workbench's core
 * population — historical Stripe-FC/Relay-CSV synced rows, which carry
 * `cardLast4` while unlinked (no `cardId`) or belonging to someone else — was
 * unreachable by `FinishChargeSheet`'s `submitBoth`. It called
 * `finances.submitOwnCharge` unconditionally for any `cardLast4` row and only
 * reached the coding submission on that call's success; `submitOwnCharge`
 * throws `NOT_A_CARD_CHARGE`/`FORBIDDEN` for exactly this population, so the
 * finance manager backfilling coding from `explain.tsx` could never submit
 * ANYTHING — not even the coding, the actual point of that screen.
 *
 * This pins the server side of the fix's shape: for a finance manager who is
 * NOT the row's cardholder, on a reconciled Stripe-FC row carrying
 * `cardLast4`,
 *  - `transactionCodings.submit` (the coding — unaffected by the bug, but
 *    worth pinning since it's now what the client calls FIRST) succeeds,
 *  - `finances.setTransactionCategory` (the bookkeeper-gated category path
 *    the client now calls for a not-owned row, via `planCategoryEdit`)
 *    succeeds too,
 *  - `finances.submitOwnCharge` (what the client used to call unconditionally)
 *    is confirmed to reject this exact caller/row pair, which is WHY the old
 *    code broke and the new routing exists.
 */

async function seedManager(s: ChapterSetup): Promise<Id<"people">> {
  const personId = await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Financial Manager",
      userId: s.userId,
      isTeamMember: true,
      createdAt: Date.now(),
    }),
  );
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

/** A DIFFERENT roster person than the caller — the row's real cardholder, or
 *  simply "somebody else" for the unlinked case. */
async function seedOtherPerson(s: ChapterSetup, name: string): Promise<Id<"people">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("people", { chapterId: s.chapterId, name, createdAt: Date.now() }),
  );
}

async function seedCategory(s: ChapterSetup): Promise<Id<"budgetCategories">> {
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
      name: "Transportation",
      kind: "category",
      sortOrder: 0,
      createdAt: Date.now(),
    }),
  );
}

/** A historical Stripe-FC row, reconciled, carrying `cardLast4` — the
 *  review's exact shape. `cardId` is left UNSET (the "unlinked" case named in
 *  the finding); a second test covers the "belongs to someone else" case by
 *  linking a card owned by a different person. */
async function seedHistoricalStripeFcRow(
  s: ChapterSetup,
  opts: { cardId?: Id<"cards"> } = {},
): Promise<Id<"transactions">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("transactions", {
      chapterId: s.chapterId,
      source: "stripe_fc",
      flow: "outflow",
      amountCents: 4200,
      postedAt: Date.now(),
      status: "reconciled",
      merchantName: "Peter Pan Bus Lines",
      cardLast4: "9911",
      cardId: opts.cardId,
      receiptStorageId: undefined,
      createdAt: Date.now(),
    } as Parameters<typeof ctx.db.insert<"transactions">>[1]),
  );
}

const GOOD_PURPOSE = "Travel to New York to film the Eden event";

describe("Explain workbench: finance manager, not the cardholder, on a reconciled Stripe-FC row", () => {
  test("submitOwnCharge is refused for this caller/row pair (unlinked card) — confirms WHY the old routing broke", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    const txnId = await seedHistoricalStripeFcRow(s);

    await expect(
      s.as.mutation(api.finances.submitOwnCharge, { transactionId: txnId, categoryId: null }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("submitOwnCharge is refused when the card belongs to someone else (FORBIDDEN)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    const otherCardholder = await seedOtherPerson(s, "Someone Else");
    const cardId = await run(s.t, (ctx) =>
      ctx.db.insert("cards", {
        chapterId: s.chapterId,
        cardholderPersonId: otherCardholder,
        type: "physical",
        last4: "9911",
        source: "legacy",
        status: "active",
        createdAt: Date.now(),
      }),
    );
    const txnId = await seedHistoricalStripeFcRow(s, { cardId });

    await expect(
      s.as.mutation(api.finances.submitOwnCharge, { transactionId: txnId, categoryId: null }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("the mutations the client NOW calls both succeed: setTransactionCategory + transactionCodings.submit", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    const categoryId = await seedCategory(s);
    const receiptStorageId = await storeBlob(s.t);
    const txnId = await seedHistoricalStripeFcRow(s);
    await run(s.t, (ctx) => ctx.db.patch(txnId, { receiptStorageId }));

    // THE CATEGORY HALF — the bookkeeper-gated path (`planCategoryEdit`'s
    // "bookkeeper" branch), reachable on a reconciled row precisely because
    // this caller is finance-manager-rank (`viaFinance: true` bypasses the
    // reconciled lock that would otherwise stop a mere event-lead).
    await s.as.mutation(api.finances.setTransactionCategory, {
      transactionId: txnId,
      categoryId,
    });
    const recategorized = await run(s.t, (ctx) => ctx.db.get(txnId));
    expect(recategorized?.categoryId).toBe(categoryId);

    // THE CODING HALF — always attempted first by the client now, and was
    // never actually blocked by this bug; pinned here because it's the whole
    // point of the screen.
    await s.as.mutation(api.transactionCodings.submit, {
      transactionId: txnId,
      expenseType: "travel",
      businessPurpose: GOOD_PURPOSE,
      travelFrom: "Boston",
      travelTo: "New York",
    });
    const coded = await run(s.t, (ctx) => ctx.db.get(txnId));
    expect(coded?.codingState).toBe("submitted");
  });
});
