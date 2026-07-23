/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import {
  newT,
  run,
  setupChapter,
  storeBlob,
  type ChapterSetup,
} from "./setup.helpers";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

const DAY_MS = 24 * 60 * 60 * 1000;
// Mirrors `cards.ts`'s REMINDER_BATCH_LIMIT (per-run conversion cap).
const BATCH_LIMIT = 25;

/**
 * `cards.autoConvertOverdueReceipts` — the daily no-receipt → personal
 * repayment sweep (the terminal step past the day-1/day-3 reminders and the
 * day-7 auto-lock):
 *
 *  - NO-OP when the org policy is off (`noReceiptAutoConvertDays == null`);
 *  - converts a card charge older than N days still missing its receipt into a
 *    pending `personalRepayments` row (+ marks it `isPersonal`);
 *  - does NOT convert one WITH a receipt, one already personal, or one younger
 *    than N days;
 *  - idempotent on a second run (one repayment per charge);
 *  - batch-bounded (≤ REMINDER_BATCH_LIMIT per run, oldest-first);
 *  - INTERACTION: once converted, a charge no longer counts as an overdue
 *    missing-receipt charge, so it neither locks an active card nor keeps an
 *    auto-locked one locked (`isMissingReceiptCharge` now excludes
 *    `isPersonal`).
 */

/** Upsert the org-wide no-receipt deadline (days); `null` clears it (policy off). */
async function setPolicy(s: ChapterSetup, days: number | null): Promise<void> {
  await run(s.t, async (ctx) => {
    const existing = await ctx.db.query("financeSettings").first();
    const patch = { noReceiptAutoConvertDays: days ?? undefined, updatedAt: Date.now() };
    if (existing) {
      await ctx.db.patch(existing._id, patch);
    } else {
      await ctx.db.insert("financeSettings", { sandboxMode: false, ...patch });
    }
  });
}

async function seedPerson(s: ChapterSetup, name: string): Promise<Id<"people">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name,
      isTeamMember: true,
      createdAt: Date.now(),
    }),
  );
}

async function seedCard(
  s: ChapterSetup,
  cardholderPersonId: Id<"people">,
  opts: { status?: "active" | "locked"; receiptGraceEndsAt?: number } = {},
): Promise<Id<"cards">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("cards", {
      chapterId: s.chapterId,
      cardholderPersonId,
      type: "virtual",
      status: opts.status ?? "active",
      receiptGraceEndsAt: opts.receiptGraceEndsAt,
      createdAt: Date.now(),
    }),
  );
}

async function seedCardTxn(
  s: ChapterSetup,
  opts: {
    cardId: Id<"cards">;
    personId: Id<"people">;
    ageDays?: number;
    receiptStorageId?: Id<"_storage">;
    isPersonal?: boolean;
    amountCents?: number;
  },
): Promise<Id<"transactions">> {
  const now = Date.now();
  return await run(s.t, (ctx) =>
    ctx.db.insert("transactions", {
      chapterId: s.chapterId,
      source: "increase_card",
      flow: "outflow",
      amountCents: opts.amountCents ?? 4200,
      postedAt: now - (opts.ageDays ?? 0) * DAY_MS,
      cardId: opts.cardId,
      personId: opts.personId,
      receiptStorageId: opts.receiptStorageId,
      isPersonal: opts.isPersonal,
      status: "unreviewed",
      createdAt: now,
    }),
  );
}

async function repaymentsFor(s: ChapterSetup, txnId: Id<"transactions">) {
  return await run(s.t, (ctx) =>
    ctx.db
      .query("personalRepayments")
      .withIndex("by_transaction", (q) => q.eq("transactionId", txnId))
      .collect(),
  );
}

async function getDoc<T extends "transactions" | "cards">(
  s: ChapterSetup,
  id: Id<T>,
) {
  return await run(s.t, (ctx) => ctx.db.get(id));
}

describe("cards.autoConvertOverdueReceipts", () => {
  test("NO-OP when the policy is off (null)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const holder = await seedPerson(s, "Holder");
    const card = await seedCard(s, holder);
    const txnId = await seedCardTxn(s, { cardId: card, personId: holder, ageDays: 30 });
    // policy left unset (null)

    const r = await s.t.mutation(internal.cards.autoConvertOverdueReceipts, {});
    expect(r.convertedCount).toBe(0);
    const txn = await getDoc(s, txnId);
    expect(txn?.isPersonal).not.toBe(true);
    expect((await repaymentsFor(s, txnId)).length).toBe(0);
  });

  test("converts a charge older than N days with no receipt", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setPolicy(s, 7);
    const holder = await seedPerson(s, "Holder");
    const card = await seedCard(s, holder);
    const txnId = await seedCardTxn(s, { cardId: card, personId: holder, ageDays: 30 });

    const r = await s.t.mutation(internal.cards.autoConvertOverdueReceipts, {});
    expect(r.convertedCount).toBe(1);

    const txn = await getDoc(s, txnId);
    expect(txn?.isPersonal).toBe(true);
    expect(txn?.repaymentId).toBeTruthy();
    const reps = await repaymentsFor(s, txnId);
    expect(reps.length).toBe(1);
    expect(reps[0].status).toBe("pending");
    expect(reps[0].payerPersonId).toBe(holder);
    expect(reps[0].amountCents).toBe(4200);
  });

  test("does NOT convert a charge with a receipt, one already personal, or a young one", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setPolicy(s, 7);
    const holder = await seedPerson(s, "Holder");
    const card = await seedCard(s, holder);
    const receipt = await storeBlob(s.t);
    const receipted = await seedCardTxn(s, {
      cardId: card,
      personId: holder,
      ageDays: 30,
      receiptStorageId: receipt,
    });
    const alreadyPersonal = await seedCardTxn(s, {
      cardId: card,
      personId: holder,
      ageDays: 30,
      isPersonal: true,
    });
    const young = await seedCardTxn(s, { cardId: card, personId: holder, ageDays: 1 });

    const r = await s.t.mutation(internal.cards.autoConvertOverdueReceipts, {});
    expect(r.convertedCount).toBe(0);

    // None got a NEW repayment row.
    expect((await repaymentsFor(s, receipted)).length).toBe(0);
    expect((await repaymentsFor(s, alreadyPersonal)).length).toBe(0);
    expect((await repaymentsFor(s, young)).length).toBe(0);
    // The young charge is untouched.
    expect((await getDoc(s, young))?.isPersonal).not.toBe(true);
  });

  test("idempotent on a second run", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setPolicy(s, 7);
    const holder = await seedPerson(s, "Holder");
    const card = await seedCard(s, holder);
    const txnId = await seedCardTxn(s, { cardId: card, personId: holder, ageDays: 30 });

    const r1 = await s.t.mutation(internal.cards.autoConvertOverdueReceipts, {});
    expect(r1.convertedCount).toBe(1);
    const r2 = await s.t.mutation(internal.cards.autoConvertOverdueReceipts, {});
    expect(r2.convertedCount).toBe(0);
    expect((await repaymentsFor(s, txnId)).length).toBe(1);
  });

  test("respects the per-run batch limit (oldest-first)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setPolicy(s, 7);
    const holder = await seedPerson(s, "Holder");
    const card = await seedCard(s, holder);
    // BATCH_LIMIT + 1 eligible charges, each older than the deadline.
    for (let i = 0; i < BATCH_LIMIT + 1; i++) {
      await seedCardTxn(s, { cardId: card, personId: holder, ageDays: 30 + i });
    }

    const r1 = await s.t.mutation(internal.cards.autoConvertOverdueReceipts, {});
    expect(r1.convertedCount).toBe(BATCH_LIMIT);
    // The remaining one drains on the next run.
    const r2 = await s.t.mutation(internal.cards.autoConvertOverdueReceipts, {});
    expect(r2.convertedCount).toBe(1);
    const r3 = await s.t.mutation(internal.cards.autoConvertOverdueReceipts, {});
    expect(r3.convertedCount).toBe(0);
  });

  test("a converted charge no longer LOCKS an active card", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setPolicy(s, 7);
    const holder = await seedPerson(s, "Holder");
    const card = await seedCard(s, holder);
    await seedCardTxn(s, { cardId: card, personId: holder, ageDays: 30 });

    // Convert first, then run the auto-lock sweep: the charge is now a personal
    // repayment (excluded from the missing-receipt set), so the card stays active.
    await s.t.mutation(internal.cards.autoConvertOverdueReceipts, {});
    const lock = await s.t.mutation(internal.cards.autoLockOverdueCards, {});
    expect(lock.lockedCount).toBe(0);
    expect((await getDoc(s, card))?.status).toBe("active");
  });

  test("converting the last overdue charge lets an auto-locked card unlock", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setPolicy(s, 7);
    const holder = await seedPerson(s, "Holder");
    const overdueTxn = { ageDays: 30 } as const;
    // A card already auto-locked (locked WITH a grace stamp) for its one overdue
    // no-receipt charge.
    const card = await seedCard(s, holder, {
      status: "locked",
      receiptGraceEndsAt: Date.now() - DAY_MS,
    });
    await seedCardTxn(s, { cardId: card, personId: holder, ...overdueTxn });

    await s.t.mutation(internal.cards.autoConvertOverdueReceipts, {});
    // The self-heal sweep now finds no overdue missing-receipt charge → unlocks.
    const lock = await s.t.mutation(internal.cards.autoLockOverdueCards, {});
    expect(lock.unlockedCount).toBe(1);
    expect((await getDoc(s, card))?.status).toBe("active");
  });
});
