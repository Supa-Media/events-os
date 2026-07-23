/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

/**
 * R1b follow-up — the personal-charge flag made VISIBLE in the transaction
 * payloads (it used to live only in session-local UI state, so a reload — or
 * a flag made by the other party — showed nothing):
 *
 *  - every txn summary row (`listReconcile`, `personTransactions`, …) carries
 *    `isPersonal`;
 *  - `listReconcile` rows additionally resolve the linked repayment's LIVE
 *    `repaymentStatus` ("pending" until the cardholder pays it back, then
 *    "paid"), so the grid's Personal badge can read "Repaid".
 */

async function seedPerson(
  s: ChapterSetup,
  opts: { name: string; userId?: Id<"users"> },
): Promise<Id<"people">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: opts.name,
      userId: opts.userId,
      isTeamMember: true,
      createdAt: Date.now(),
    }),
  );
}

/** A manager caller + a cardholder with one card charge, ready to flag. */
async function seedFlaggableCharge(s: ChapterSetup): Promise<{
  holder: Id<"people">;
  transactionId: Id<"transactions">;
}> {
  const me = await seedPerson(s, { name: "FM", userId: s.userId });
  await run(s.t, (ctx) =>
    ctx.db.insert("financeRoles", {
      chapterId: s.chapterId,
      personId: me,
      role: "manager",
      scope: "chapter",
      createdAt: Date.now(),
    }),
  );
  const holder = await seedPerson(s, { name: "Cardholder Cara" });
  const cardId = await run(s.t, (ctx) =>
    ctx.db.insert("cards", {
      chapterId: s.chapterId,
      cardholderPersonId: holder,
      type: "virtual",
      status: "active",
      createdAt: Date.now(),
    }),
  );
  const transactionId = await run(s.t, (ctx) =>
    ctx.db.insert("transactions", {
      chapterId: s.chapterId,
      source: "manual",
      flow: "outflow",
      amountCents: 4200,
      postedAt: Date.now(),
      personId: holder,
      cardId,
      cardLast4: "4242",
      status: "unreviewed",
      createdAt: Date.now(),
    }),
  );
  return { holder, transactionId };
}

describe("personal flag + repayment status in transaction payloads", () => {
  test("an unflagged row reads isPersonal: false, repaymentStatus: null", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const { transactionId } = await seedFlaggableCharge(s);

    const { rows } = await s.as.query(api.finances.listReconcile, {});
    const row = rows.find((r) => r.id === transactionId)!;
    expect(row.isPersonal).toBe(false);
    expect(row.repaymentStatus).toBeNull();
  });

  test("flagging surfaces isPersonal + the live repayment status in listReconcile", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const { transactionId } = await seedFlaggableCharge(s);

    const repayment = await s.as.mutation(api.cards.flagPersonalCharge, {
      transactionId,
    });

    let { rows } = await s.as.query(api.finances.listReconcile, {});
    let row = rows.find((r) => r.id === transactionId)!;
    expect(row.isPersonal).toBe(true);
    expect(row.repaymentStatus).toBe("pending");

    // Once the repayment settles, the SAME row reads "paid" — the grid's
    // badge flips from "Personal" to "Repaid" with no client bookkeeping.
    await run(s.t, (ctx) =>
      ctx.db.patch(repayment.id, { status: "paid", updatedAt: Date.now() }),
    );
    ({ rows } = await s.as.query(api.finances.listReconcile, {}));
    row = rows.find((r) => r.id === transactionId)!;
    expect(row.isPersonal).toBe(true);
    expect(row.repaymentStatus).toBe("paid");
  });

  test("personTransactions rows carry isPersonal (the member's own view)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const { holder, transactionId } = await seedFlaggableCharge(s);

    await s.as.mutation(api.cards.flagPersonalCharge, { transactionId });

    // The finance-role audit path reads the cardholder's rows — the same
    // projection the cardholder's own "My transactions" tab renders.
    const rows = await s.as.query(api.finances.personTransactions, {
      personId: holder,
    });
    expect(rows.map((r) => r.id)).toEqual([transactionId]);
    expect(rows[0].isPersonal).toBe(true);
  });
});
