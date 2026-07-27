/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import type { Id } from "../_generated/dataModel";
import { runBackfillPersonalRepaymentsPage } from "../migrations/0045_backfill_personal_repayments";

/**
 * Migration 0045 — backfill `personalRepayments` rows for legacy
 * `isPersonal:true` transactions the now-deleted `finances.ts#flagPersonal`
 * boolean setter left with no repayment record (nobody billable, no email
 * ever sent). Guards that matter: only `isPersonal:true` + no `repaymentId`
 * rows are touched, a payee resolves the SAME way `flagPersonalCharge` does
 * (`personId`, else the card's cardholder), a row with neither is left alone
 * and counted rather than guessed at, and a re-run is a no-op.
 */

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

async function seedCard(s: ChapterSetup, cardholderPersonId: Id<"people">): Promise<Id<"cards">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("cards", {
      chapterId: s.chapterId,
      cardholderPersonId,
      type: "virtual",
      status: "active",
      createdAt: Date.now(),
    }),
  );
}

async function seedTxn(
  s: ChapterSetup,
  opts: {
    isPersonal?: boolean;
    repaymentId?: Id<"personalRepayments">;
    personId?: Id<"people">;
    cardId?: Id<"cards">;
    amountCents?: number;
  },
): Promise<Id<"transactions">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("transactions", {
      chapterId: s.chapterId,
      source: "manual",
      flow: "outflow",
      amountCents: opts.amountCents ?? 2500,
      postedAt: Date.now(),
      isPersonal: opts.isPersonal,
      repaymentId: opts.repaymentId,
      personId: opts.personId,
      cardId: opts.cardId,
      status: "unreviewed",
      createdAt: Date.now(),
    }),
  );
}

describe("0045 — backfill personalRepayments for legacy isPersonal rows", () => {
  test("creates a repayment for a personId-attributed legacy row", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const payer = await seedPerson(s, "Payer");
    const txnId = await seedTxn(s, { isPersonal: true, personId: payer, amountCents: 4200 });

    const result = await run(s.t, (ctx) => runBackfillPersonalRepaymentsPage(ctx, null));
    expect(result.created).toBe(1);
    expect(result.skippedNoPayee).toBe(0);

    const txn = await run(s.t, (ctx) => ctx.db.get(txnId));
    expect(txn?.repaymentId).toBeTruthy();
    const repayment = await run(s.t, (ctx) => ctx.db.get(txn!.repaymentId!));
    expect(repayment?.payerPersonId).toBe(payer);
    expect(repayment?.amountCents).toBe(4200);
    expect(repayment?.status).toBe("pending");
  });

  test("resolves payee via a card's cardholder when personId is absent", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const holder = await seedPerson(s, "Holder");
    const cardId = await seedCard(s, holder);
    const txnId = await seedTxn(s, { isPersonal: true, cardId, amountCents: 1500 });

    const result = await run(s.t, (ctx) => runBackfillPersonalRepaymentsPage(ctx, null));
    expect(result.created).toBe(1);

    const txn = await run(s.t, (ctx) => ctx.db.get(txnId));
    const repayment = await run(s.t, (ctx) => ctx.db.get(txn!.repaymentId!));
    expect(repayment?.payerPersonId).toBe(holder);
  });

  test("a row with NO resolvable payee is skipped, not guessed at", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const txnId = await seedTxn(s, { isPersonal: true });

    const result = await run(s.t, (ctx) => runBackfillPersonalRepaymentsPage(ctx, null));
    expect(result.created).toBe(0);
    expect(result.skippedNoPayee).toBe(1);

    const txn = await run(s.t, (ctx) => ctx.db.get(txnId));
    expect(txn?.repaymentId).toBeUndefined();
    expect(txn?.isPersonal).toBe(true); // flag left exactly as-is
  });

  test("a row already carrying a repaymentId is skipped (already flagged the real way)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const payer = await seedPerson(s, "Payer");
    const txnId = await seedTxn(s, { isPersonal: true, personId: payer });
    const now = Date.now();
    const repaymentId = await run(s.t, (ctx) =>
      ctx.db.insert("personalRepayments", {
        chapterId: s.chapterId,
        transactionId: txnId,
        payerPersonId: payer,
        amountCents: 100,
        method: "ach",
        status: "pending",
        createdAt: now,
        updatedAt: now,
      }),
    );
    await run(s.t, (ctx) => ctx.db.patch(txnId, { repaymentId }));

    const result = await run(s.t, (ctx) => runBackfillPersonalRepaymentsPage(ctx, null));
    expect(result.created).toBe(0);
    expect(result.skippedAlready).toBe(1);
  });

  test("a non-personal row is never touched", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedTxn(s, { isPersonal: false });
    await seedTxn(s, {});

    const result = await run(s.t, (ctx) => runBackfillPersonalRepaymentsPage(ctx, null));
    expect(result.created).toBe(0);
    expect(result.skippedNotPersonal).toBe(2);
  });

  test("idempotent: a second run creates nothing further", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const payer = await seedPerson(s, "Payer");
    await seedTxn(s, { isPersonal: true, personId: payer, amountCents: 900 });

    const first = await run(s.t, (ctx) => runBackfillPersonalRepaymentsPage(ctx, null));
    expect(first.created).toBe(1);

    const second = await run(s.t, (ctx) => runBackfillPersonalRepaymentsPage(ctx, null));
    expect(second.created).toBe(0);
    expect(second.skippedAlready).toBe(1);
  });
});
