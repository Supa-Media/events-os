/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import {
  disarmCodingPolicy,
  newT,
  run,
  setupChapter,
  storeBlob,
  type ChapterSetup,
} from "./setup.helpers";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { RepaymentStatus } from "@events-os/shared";

/**
 * A PERSONAL CHARGE AWAITING REPAYMENT CANNOT BE CLOSED.
 *
 * Founder, 2026-08-13: "make sure to have business logic so that no rows that
 * are personal expenses that need to be repaid can be closed." Closing is a
 * treasurer saying they're finished with a row, and a row somebody still owes
 * the chapter money for is not finished.
 *
 * ── WHAT THIS SUITE IS REALLY GUARDING ──────────────────────────────────────
 * The guard sits on the TRANSITION to `"reconciled"` and nowhere else, and the
 * difference matters enough that half the tests below exist to pin it. The
 * comment above `PERSONAL_EXPENSE_STATES` (`@events-os/shared`) records a
 * deliberate decision — a transaction must be able to be BOTH closed AND an
 * unpaid personal expense, which is why personal state is derived from two
 * fields instead of being a fifth status. That is an argument about what the
 * data model must be able to SAY, and it still stands: a row closed first and
 * flagged personal afterwards stays closed, stays flagged, and is never
 * rewritten. What is refused is the act of closing while the debt is live.
 *
 * The pure policy (`personalStateBlocksClose`) is pinned in
 * `packages/shared/src/finance.test.ts`; the derived state it reads has its own
 * invariant test in the same file. This suite is the wiring: that
 * `setTransactionStatus` actually asks, that it asks about the STATE rather
 * than the flag, and that a bulk close refuses row by row rather than dropping
 * rows on the floor.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

async function asManager(s: ChapterSetup): Promise<Id<"people">> {
  const personId = await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Manager Mo",
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

/**
 * A charge that is DOCUMENTED and needs no coding, so the only thing that can
 * stand between it and `reconciled` is the rule under test. Without the
 * receipt every case below would fail on `RECEIPT_REQUIRED` first and prove
 * nothing about repayment.
 */
async function seedClosableCharge(
  s: ChapterSetup,
  merchantName = "Street parking",
): Promise<Id<"transactions">> {
  await disarmCodingPolicy(s.t);
  const storageId = await storeBlob(s.t);
  return await run(s.t, (ctx) =>
    ctx.db.insert("transactions", {
      chapterId: s.chapterId,
      source: "manual",
      flow: "outflow",
      amountCents: 4200,
      postedAt: Date.now() - DAY_MS,
      merchantName,
      status: "categorized",
      receiptStorageId: storageId,
      createdAt: Date.now(),
    }),
  );
}

/** Flag a charge personal the way `cards.ts#convertChargeToPersonalRepayment`
 *  does — the two fields written together, since the derived state is only
 *  meaningful as a pair. */
async function flagPersonal(
  s: ChapterSetup,
  txnId: Id<"transactions">,
  payerPersonId: Id<"people">,
  status: RepaymentStatus,
): Promise<Id<"personalRepayments">> {
  const repaymentId = await run(s.t, (ctx) =>
    ctx.db.insert("personalRepayments", {
      chapterId: s.chapterId,
      transactionId: txnId,
      payerPersonId,
      amountCents: 4200,
      method: "card",
      status,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
  await run(s.t, (ctx) =>
    ctx.db.patch(txnId, { isPersonal: true, repaymentId }),
  );
  return repaymentId;
}

describe("closing a personal charge that hasn't been repaid", () => {
  test("is refused, and the refusal names both ways out", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await asManager(s);
    const txnId = await seedClosableCharge(s);
    await flagPersonal(s, txnId, personId, "pending");

    await expect(
      s.as.mutation(api.finances.setTransactionStatus, {
        transactionId: txnId,
        status: "reconciled",
      }),
    ).rejects.toMatchObject({ data: { code: "REPAYMENT_OUTSTANDING" } });

    // The two ways out are the whole content of the message — a treasurer
    // stuck on this row is stuck on which one applies to it.
    await expect(
      s.as.mutation(api.finances.setTransactionStatus, {
        transactionId: txnId,
        status: "reconciled",
      }),
    ).rejects.toMatchObject({
      data: { message: expect.stringMatching(/repaid through the app/i) },
    });
    expect((await run(s.t, (ctx) => ctx.db.get(txnId)))?.status).toBe(
      "categorized",
    );
  });

  test("a FAILED repayment attempt is still outstanding", async () => {
    // A refused card/bank debit doesn't settle anything — the money never
    // arrived. Reading `failed` as "done trying, close it" would clear a row
    // against money the chapter does not have.
    const t = newT();
    const s = await setupChapter(t);
    const personId = await asManager(s);
    const txnId = await seedClosableCharge(s);
    await flagPersonal(s, txnId, personId, "failed");

    await expect(
      s.as.mutation(api.finances.setTransactionStatus, {
        transactionId: txnId,
        status: "reconciled",
      }),
    ).rejects.toMatchObject({ data: { code: "REPAYMENT_OUTSTANDING" } });
  });

  test("an ACH debit still CLEARING is still outstanding", async () => {
    // `processing` is the ~4 business days between the payer authorising a
    // bank debit and the money landing. Authorised is not arrived, and a debit
    // can still be refused.
    const t = newT();
    const s = await setupChapter(t);
    const personId = await asManager(s);
    const txnId = await seedClosableCharge(s);
    await flagPersonal(s, txnId, personId, "processing");

    await expect(
      s.as.mutation(api.finances.setTransactionStatus, {
        transactionId: txnId,
        status: "reconciled",
      }),
    ).rejects.toMatchObject({ data: { code: "REPAYMENT_OUTSTANDING" } });
  });

  test("a flagged charge with NO repayment row at all is outstanding too", async () => {
    // The absent-link case is the one a "look up the repayment and read its
    // status" implementation gets wrong by defaulting to permissive.
    // `personalExpenseState` reads a missing repayment exactly as it reads an
    // unpaid one, which is why the guard asks it rather than the row.
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const txnId = await seedClosableCharge(s);
    await run(s.t, (ctx) => ctx.db.patch(txnId, { isPersonal: true }));

    await expect(
      s.as.mutation(api.finances.setTransactionStatus, {
        transactionId: txnId,
        status: "reconciled",
      }),
    ).rejects.toMatchObject({ data: { code: "REPAYMENT_OUTSTANDING" } });
  });
});

describe("what the rule deliberately does NOT block", () => {
  test("a REPAID personal charge closes — the flag was never what blocked", async () => {
    // The charge stays `isPersonal: true` forever. What blocked was the debt.
    const t = newT();
    const s = await setupChapter(t);
    const personId = await asManager(s);
    const txnId = await seedClosableCharge(s);
    await flagPersonal(s, txnId, personId, "paid");

    await s.as.mutation(api.finances.setTransactionStatus, {
      transactionId: txnId,
      status: "reconciled",
    });
    const row = await run(s.t, (ctx) => ctx.db.get(txnId));
    expect(row?.status).toBe("reconciled");
    expect(row?.isPersonal).toBe(true);
  });

  test("an ordinary charge closes exactly as before", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const txnId = await seedClosableCharge(s);

    await s.as.mutation(api.finances.setTransactionStatus, {
      transactionId: txnId,
      status: "reconciled",
    });
    expect((await run(s.t, (ctx) => ctx.db.get(txnId)))?.status).toBe(
      "reconciled",
    );
  });

  test("EXCLUDING an unpaid personal charge is still allowed", async () => {
    // The guard is on closing, not on every status write. Excluding says "this
    // row should never have counted", which is a different claim and keeps its
    // own required reason.
    const t = newT();
    const s = await setupChapter(t);
    const personId = await asManager(s);
    const txnId = await seedClosableCharge(s);
    await flagPersonal(s, txnId, personId, "pending");

    await s.as.mutation(api.finances.setTransactionStatus, {
      transactionId: txnId,
      status: "excluded",
      reason: "Duplicate of the Aug 2 charge",
    });
    expect((await run(s.t, (ctx) => ctx.db.get(txnId)))?.status).toBe(
      "excluded",
    );
  });

  test("a row CLOSED FIRST and flagged personal AFTERWARDS stays closed", async () => {
    // THE REPRESENTATION DECISION, pinned. The comment above
    // `PERSONAL_EXPENSE_STATES` says a transaction must be able to be BOTH
    // `reconciled` AND an unpaid personal expense — which is why the new rule
    // is a guard on the transition and NOT an invariant. Flagging never
    // re-opens the row, and the pair stays expressible and readable.
    const t = newT();
    const s = await setupChapter(t);
    const personId = await asManager(s);
    const txnId = await seedClosableCharge(s);

    await s.as.mutation(api.finances.setTransactionStatus, {
      transactionId: txnId,
      status: "reconciled",
    });
    await flagPersonal(s, txnId, personId, "pending");

    const row = await run(s.t, (ctx) => ctx.db.get(txnId));
    expect(row?.status).toBe("reconciled");
    expect(row?.isPersonal).toBe(true);
    // And it is still visible as an unpaid personal charge — the worklist
    // never loses it just because it was closed.
    const res = await s.as.query(api.finances.listReconcile, {
      filter: "personal_unpaid",
    });
    expect(res.rows.map((r) => r.id)).toEqual([txnId]);
  });

  test("re-closing an already-closed unpaid personal row is refused, not silently re-applied", async () => {
    // A row in the legacy both-at-once state is untouched by READS, but a
    // fresh write is a fresh close and gets the same answer as any other. The
    // alternative — letting the write through because the status already reads
    // `reconciled` — would hand anyone an obvious way around the rule (close
    // it once while clean, flag it, then re-close at will).
    const t = newT();
    const s = await setupChapter(t);
    const personId = await asManager(s);
    const txnId = await seedClosableCharge(s);
    await s.as.mutation(api.finances.setTransactionStatus, {
      transactionId: txnId,
      status: "reconciled",
    });
    await flagPersonal(s, txnId, personId, "pending");

    await expect(
      s.as.mutation(api.finances.setTransactionStatus, {
        transactionId: txnId,
        status: "reconciled",
      }),
    ).rejects.toMatchObject({ data: { code: "REPAYMENT_OUTSTANDING" } });
    // Unchanged either way — the refusal doesn't re-open it.
    expect((await run(s.t, (ctx) => ctx.db.get(txnId)))?.status).toBe(
      "reconciled",
    );
  });
});

describe("a bulk close refuses PER ROW", () => {
  test("the closable rows close and the unpaid one is left open, individually refused", async () => {
    // There is no bulk-status mutation — the grid loops over this same
    // idempotent per-row setter — so "per row" is a claim about the SERVER:
    // one row's refusal must not decide any other row's fate. The client's
    // half (settling every promise and naming the refused charges instead of
    // showing whichever error came back first) is
    // `bulkExplainOutcome.test.ts`.
    const t = newT();
    const s = await setupChapter(t);
    const personId = await asManager(s);
    const clean1 = await seedClosableCharge(s, "Costco");
    const unpaid = await seedClosableCharge(s, "Olive Garden");
    const clean2 = await seedClosableCharge(s, "MTA*NYCT");
    await flagPersonal(s, unpaid, personId, "pending");

    const settled = await Promise.allSettled(
      [clean1, unpaid, clean2].map((id) =>
        s.as.mutation(api.finances.setTransactionStatus, {
          transactionId: id,
          status: "reconciled",
        }),
      ),
    );
    expect(settled.map((r) => r.status)).toEqual([
      "fulfilled",
      "rejected",
      "fulfilled",
    ]);

    expect((await run(s.t, (ctx) => ctx.db.get(clean1)))?.status).toBe(
      "reconciled",
    );
    expect((await run(s.t, (ctx) => ctx.db.get(clean2)))?.status).toBe(
      "reconciled",
    );
    // Left exactly where it was — NOT quietly closed, and NOT silently
    // skipped: the caller was handed a refusal carrying this row's own code.
    expect((await run(s.t, (ctx) => ctx.db.get(unpaid)))?.status).toBe(
      "categorized",
    );
    const refusal = settled[1];
    expect(refusal.status).toBe("rejected");
    if (refusal.status === "rejected") {
      expect(refusal.reason).toMatchObject({
        data: { code: "REPAYMENT_OUTSTANDING" },
      });
    }
  });
});
