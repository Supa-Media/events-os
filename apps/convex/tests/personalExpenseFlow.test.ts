/// <reference types="vite/client" />
import { describe, expect, test, vi } from "vitest";
import { ConvexError } from "convex/values";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

/**
 * The personal-expense flag/repayment feature (founder ask: mark a charge as
 * a personal expense needing reimbursement, separate from `status`, so a
 * transaction can be BOTH `"reconciled"` AND an unpaid personal expense at
 * once). Covers what `reconcilePersonalStatus.test.ts` / `cards.test.ts`'s
 * existing `flagPersonalCharge` suite don't:
 *
 *  - payee resolution generalized past card-only (a `personId`-attributed
 *    manual entry, no card, can be flagged);
 *  - `PAYEE_REQUIRED` when neither `personId` nor `cardId` resolves anyone;
 *  - `unflagPersonalCharge`: undoes a mis-flag, is idempotent, refuses once
 *    settled, and a re-flag after unmarking creates a FRESH repayment;
 *  - the §2 invariant: a REIMBURSED personal charge is STILL excluded from
 *    `isSpend` — not just an unpaid one;
 *  - the Reconcile `personal_unpaid` filter/pill;
 *  - the Stripe repayment rail: prepare/attach/apply, idempotency under
 *    duplicate + out-of-order webhook delivery, and amount-mismatch handling;
 *  - the flagged email's link (`APP_URL` set vs unset — degrade loudly).
 */

async function seedPerson(
  s: ChapterSetup,
  opts: { name: string; userId?: Id<"users">; pwEmail?: string | null } = {
    name: "Person",
  },
): Promise<Id<"people">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: opts.name,
      userId: opts.userId,
      isTeamMember: true,
      pwEmail: opts.pwEmail === null ? undefined : (opts.pwEmail ?? "person@publicworship.life"),
      createdAt: Date.now(),
    }),
  );
}

async function grantRole(
  s: ChapterSetup,
  personId: Id<"people">,
  role: "viewer" | "bookkeeper" | "manager",
): Promise<void> {
  await run(s.t, (ctx) =>
    ctx.db.insert("financeRoles", {
      chapterId: s.chapterId,
      personId,
      role,
      scope: "chapter",
      createdAt: Date.now(),
    }),
  );
}

async function seedManager(s: ChapterSetup): Promise<Id<"people">> {
  const personId = await seedPerson(s, { name: "Manny Manager", userId: s.userId });
  await grantRole(s, personId, "manager");
  return personId;
}

/**
 * Body wrapper for a test whose mutation SCHEDULES something — for the flag
 * path that's `notifyPersonalChargeFlagged`, the "a manager marked your charge
 * personal" email. A job left pending doesn't stay inside its own test: it
 * flushes at whatever later await point comes along, which lands it in a LATER
 * test — and the email test at the bottom of this file stubs `globalThis.fetch`
 * to count exactly one send. Same fake-timers + `finishAllScheduledFunctions`
 * pattern `cards.test.ts` already uses around `flagPersonalCharge`; the drain
 * is the last thing the body does.
 */
async function withDrainedSchedule(body: () => Promise<void>): Promise<void> {
  vi.useFakeTimers();
  try {
    await body();
  } finally {
    vi.useRealTimers();
  }
}

async function seedManualTxn(
  s: ChapterSetup,
  opts: { personId?: Id<"people">; cardId?: Id<"cards">; amountCents?: number },
): Promise<Id<"transactions">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("transactions", {
      chapterId: s.chapterId,
      source: "manual",
      flow: "outflow",
      amountCents: opts.amountCents ?? 3000,
      postedAt: Date.now(),
      personId: opts.personId,
      cardId: opts.cardId,
      merchantName: "Test Merchant",
      status: "unreviewed",
      createdAt: Date.now(),
    }),
  );
}

// ── Payee resolution + generalization ────────────────────────────────────────

describe("flagPersonalCharge — generalized payee resolution", () => {
  test("flags a non-card, personId-attributed transaction (no cardId at all)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const payer = await seedPerson(s, { name: "Payer", userId: s.userId });
    const txnId = await seedManualTxn(s, { personId: payer, amountCents: 1234 });

    const rep = await s.as.mutation(api.cards.flagPersonalCharge, { transactionId: txnId });
    expect(rep.payerPersonId).toBe(payer);
    expect(rep.amountCents).toBe(1234);
    expect(rep.status).toBe("pending");

    const txn = await run(s.t, (ctx) => ctx.db.get(txnId));
    expect(txn?.isPersonal).toBe(true);
    expect(txn?.repaymentId).toBe(rep.id);
  });

  test("PAYEE_REQUIRED when neither personId nor cardId resolves anyone", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    const txnId = await seedManualTxn(s, {});

    let caught: unknown;
    try {
      await s.as.mutation(api.cards.flagPersonalCharge, { transactionId: txnId });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConvexError);
    expect((caught as ConvexError<{ code: string }>).data.code).toBe("PAYEE_REQUIRED");

    // Never created a repayment nobody can be billed for.
    const txn = await run(s.t, (ctx) => ctx.db.get(txnId));
    expect(txn?.isPersonal).toBeFalsy();
    expect(txn?.repaymentId).toBeUndefined();
  });
});

// ── Naming the payer on a no-payee charge (founder feedback: "in reconcile I
// can't mark everything as personal, some things it won't let me, the flag
// just doesn't exist") ───────────────────────────────────────────────────────

describe("flagPersonalCharge — manager names the payer (payerPersonId)", () => {
  test("a manager can flag a charge that resolves nobody, and it's attributed to the named person", async () =>
    withDrainedSchedule(async () => {
      const t = newT();
      const s = await setupChapter(t);
      await seedManager(s);
      const owes = await seedPerson(s, { name: "Owes Money" });
      const txnId = await seedManualTxn(s, { amountCents: 1874 });

      const rep = await s.as.mutation(api.cards.flagPersonalCharge, {
        transactionId: txnId,
        payerPersonId: owes,
      });
      expect(rep.payerPersonId).toBe(owes);
      expect(rep.amountCents).toBe(1874);
      expect(rep.status).toBe("pending");

      // Written onto the TRANSACTION too, so the Reconcile cardholder column,
      // `unflagPersonalCharge`'s payer resolution and the repayment list all
      // agree — not just the repayment row.
      const txn = await run(s.t, (ctx) => ctx.db.get(txnId));
      expect(txn?.personId).toBe(owes);
      expect(txn?.isPersonal).toBe(true);
      expect(txn?.repaymentId).toBe(rep.id);

      await s.t.finishAllScheduledFunctions(vi.runAllTimers);
    }));

  test("a non-manager can't name someone else as the payer", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const self = await seedPerson(s, { name: "Bookkeeper", userId: s.userId });
    await grantRole(s, self, "bookkeeper");
    const someoneElse = await seedPerson(s, { name: "Someone Else" });
    const txnId = await seedManualTxn(s, {});

    let caught: unknown;
    try {
      await s.as.mutation(api.cards.flagPersonalCharge, {
        transactionId: txnId,
        payerPersonId: someoneElse,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConvexError);
    expect((caught as ConvexError<{ code: string }>).data.code).toBe("FORBIDDEN");
    const txn = await run(s.t, (ctx) => ctx.db.get(txnId));
    expect(txn?.isPersonal).toBeFalsy();
    expect(txn?.personId).toBeUndefined();
  });

  test("ignored when the charge already resolves a payee — a manager can't re-bill someone else's card swipe", async () =>
    withDrainedSchedule(async () => {
      const t = newT();
      const s = await setupChapter(t);
      await seedManager(s);
      const realPayer = await seedPerson(s, { name: "Real Payer" });
      const innocent = await seedPerson(s, { name: "Innocent Bystander" });
      const txnId = await seedManualTxn(s, { personId: realPayer });

      const rep = await s.as.mutation(api.cards.flagPersonalCharge, {
        transactionId: txnId,
        payerPersonId: innocent,
      });
      expect(rep.payerPersonId).toBe(realPayer);
      const txn = await run(s.t, (ctx) => ctx.db.get(txnId));
      expect(txn?.personId).toBe(realPayer);

      await s.t.finishAllScheduledFunctions(vi.runAllTimers);
    }));

  test("a named payer from another chapter is rejected", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    const outsider = await run(s.t, async (ctx) => {
      const otherChapterId = await ctx.db.insert("chapters", {
        name: "Elsewhere",
        isActive: true,
        createdAt: Date.now(),
      });
      return await ctx.db.insert("people", {
        chapterId: otherChapterId,
        name: "Outsider",
        isTeamMember: true,
        createdAt: Date.now(),
      });
    });
    const txnId = await seedManualTxn(s, {});

    await expect(
      s.as.mutation(api.cards.flagPersonalCharge, {
        transactionId: txnId,
        payerPersonId: outsider,
      }),
    ).rejects.toThrow();
    expect((await run(s.t, (ctx) => ctx.db.get(txnId)))?.isPersonal).toBeFalsy();
  });
});

// ── listPersonalRepayments (the manager collection surface) ──────────────────

describe("listPersonalRepayments", () => {
  test("returns every repayment in the chapter with its payer + charge detail, newest first", async () =>
    withDrainedSchedule(async () => {
      const t = newT();
      const s = await setupChapter(t);
      await seedManager(s);
      const alice = await seedPerson(s, { name: "Alice" });
      const bob = await seedPerson(s, { name: "Bob" });
      const first = await seedManualTxn(s, { personId: alice, amountCents: 500 });
      const second = await seedManualTxn(s, { personId: bob, amountCents: 900 });

      await s.as.mutation(api.cards.flagPersonalCharge, { transactionId: first });
      // Fake timers freeze the clock, so without this both repayments share a
      // `createdAt` and "newest first" has nothing to order by. Moves the clock
      // WITHOUT firing pending timers (unlike `advanceTimersByTime`) — the
      // scheduled flag emails are drained deliberately at the end.
      vi.setSystemTime(Date.now() + 1000);
      const secondRep = await s.as.mutation(api.cards.flagPersonalCharge, {
        transactionId: second,
      });

      const rows = await s.as.query(api.cards.listPersonalRepayments, {});
      expect(rows).toHaveLength(2);
      // Newest flag first.
      expect(rows[0].payerName).toBe("Bob");
      expect(rows[0].amountCents).toBe(900);
      expect(rows[0].merchantName).toBe("Test Merchant");
      expect(rows[0].status).toBe("pending");
      expect(rows[0].creditTransactionId).toBeNull();
      expect(rows[1].payerName).toBe("Alice");

      // A settled row stays in the list (it moves to the "Repaid" section
      // rather than vanishing) and carries the offsetting credit. Settled
      // through the Stripe webhook, the only path to `paid` since the manual
      // "mark repaid" was removed (2026-08-14).
      await t.mutation(internal.cards.applyRepaymentPaidFromStripe, {
        repaymentIds: [secondRep.id],
        sessionId: "cs_list_settle",
        amountTotalCents: 900,
      });
      const after = await s.as.query(api.cards.listPersonalRepayments, {});
      const settled = after.find((r) => r.id === secondRep.id);
      expect(settled?.status).toBe("paid");
      expect(settled?.creditTransactionId).not.toBeNull();

      await s.t.finishAllScheduledFunctions(vi.runAllTimers);
    }));

  test("requires at least the viewer finance role", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedPerson(s, { name: "No Role", userId: s.userId });

    await expect(
      s.as.query(api.cards.listPersonalRepayments, {}),
    ).rejects.toThrow();
  });
});

// ── listReconcile.viewerIsManager — who the GRID may offer "Mark personal" to
// (founder feedback: rows that plainly have a cardholder still showed no flag)
// ─────────────────────────────────────────────────────────────────────────────

describe("listReconcile — viewerIsManager", () => {
  test("a CENTRAL-scope manager grant reads as a manager, even with no chapter seat", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedPerson(s, { name: "Central FM", userId: s.userId });
    // A central grant, exactly as `grantFinanceRole`/the specialized-roles
    // bridge writes one — manager everywhere server-side, but it produces NO
    // `scope:"chapter"` seat, which is what the grid used to look for. The
    // regression this pins: the grid hid every manager-only row action from an
    // Executive Director / Financial Manager sitting at Central.
    await run(s.t, (ctx) =>
      ctx.db.insert("financeRoles", {
        chapterId: "central" as unknown as Id<"chapters">,
        personId,
        role: "manager",
        scope: "central",
        createdAt: Date.now(),
      }),
    );

    const res = await s.as.query(api.finances.listReconcile, {});
    expect(res.viewerIsManager).toBe(true);
    expect(res.viewerPersonId).toBe(personId);

    // And the permission it advertises is real — the same caller can actually
    // flag someone else's charge.
    const holder = await seedPerson(s, { name: "Card Holder" });
    const txnId = await seedManualTxn(s, { personId: holder });
    const rep = await s.as.mutation(api.cards.flagPersonalCharge, {
      transactionId: txnId,
    });
    expect(rep.payerPersonId).toBe(holder);
  });

  test("a chapter-scope manager still reads as a manager", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);

    const res = await s.as.query(api.finances.listReconcile, {});
    expect(res.viewerIsManager).toBe(true);
  });

  test("a bookkeeper does NOT — full Reconcile access, but not this action", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedPerson(s, { name: "Books", userId: s.userId });
    await grantRole(s, personId, "bookkeeper");

    const res = await s.as.query(api.finances.listReconcile, {});
    expect(res.viewerIsManager).toBe(false);
    expect(res.viewerPersonId).toBe(personId);
  });
});

// ── unflagPersonalCharge ──────────────────────────────────────────────────────

describe("unflagPersonalCharge", () => {
  test("undoes a mis-flag: clears isPersonal, deletes the repayment row", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const payer = await seedPerson(s, { name: "Payer", userId: s.userId });
    const txnId = await seedManualTxn(s, { personId: payer });

    const rep = await s.as.mutation(api.cards.flagPersonalCharge, { transactionId: txnId });
    await s.as.mutation(api.cards.unflagPersonalCharge, { transactionId: txnId });

    const txn = await run(s.t, (ctx) => ctx.db.get(txnId));
    expect(txn?.isPersonal).toBe(false);
    expect(txn?.repaymentId).toBeUndefined();
    const repayment = await run(s.t, (ctx) => ctx.db.get(rep.id));
    expect(repayment).toBeNull();
  });

  test("idempotent: unflagging an already-unflagged (or never-flagged) transaction is a no-op", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const payer = await seedPerson(s, { name: "Payer", userId: s.userId });
    const txnId = await seedManualTxn(s, { personId: payer });

    // Never flagged at all.
    await s.as.mutation(api.cards.unflagPersonalCharge, { transactionId: txnId });
    expect((await run(s.t, (ctx) => ctx.db.get(txnId)))?.isPersonal).toBeFalsy();

    // Flag then unflag then unflag again.
    await s.as.mutation(api.cards.flagPersonalCharge, { transactionId: txnId });
    await s.as.mutation(api.cards.unflagPersonalCharge, { transactionId: txnId });
    await s.as.mutation(api.cards.unflagPersonalCharge, { transactionId: txnId });
    expect((await run(s.t, (ctx) => ctx.db.get(txnId)))?.isPersonal).toBe(false);
  });

  test("refuses once the repayment has settled (ILLEGAL_TRANSITION)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const payer = await seedPerson(s, { name: "Payer", userId: s.userId });
    const txnId = await seedManualTxn(s, { personId: payer });
    const rep = await s.as.mutation(api.cards.flagPersonalCharge, { transactionId: txnId });
    await run(s.t, (ctx) => ctx.db.patch(rep.id, { status: "paid" }));

    let caught: unknown;
    try {
      await s.as.mutation(api.cards.unflagPersonalCharge, { transactionId: txnId });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConvexError);
    expect((caught as ConvexError<{ code: string }>).data.code).toBe("ILLEGAL_TRANSITION");
    // Left exactly as it was — still personal, repayment untouched.
    const txn = await run(s.t, (ctx) => ctx.db.get(txnId));
    expect(txn?.isPersonal).toBe(true);
    expect(txn?.repaymentId).toBe(rep.id);
  });

  test("re-marking after a real unmark creates a FRESH repayment (not a resurrection)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const payer = await seedPerson(s, { name: "Payer", userId: s.userId });
    const txnId = await seedManualTxn(s, { personId: payer });

    const first = await s.as.mutation(api.cards.flagPersonalCharge, { transactionId: txnId });
    await s.as.mutation(api.cards.unflagPersonalCharge, { transactionId: txnId });
    const second = await s.as.mutation(api.cards.flagPersonalCharge, { transactionId: txnId });

    expect(second.id).not.toBe(first.id);
    const reps = await run(s.t, (ctx) =>
      ctx.db
        .query("personalRepayments")
        .withIndex("by_transaction", (q) => q.eq("transactionId", txnId))
        .collect(),
    );
    // The old one was deleted, not left behind — exactly one live row.
    expect(reps).toHaveLength(1);
    expect(reps[0]._id).toBe(second.id);
  });
});

// ── §2 invariant: reimbursed is STILL excluded from spend ────────────────────

describe("isPersonal invariant — a REIMBURSED personal charge stays out of spend", () => {
  test("both unpaid and reimbursed personal charges are excluded from the reconcile spend count", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const payer = await seedPerson(s, { name: "Payer", userId: s.userId });
    await grantRole(s, payer, "viewer");
    const unpaidTxn = await seedManualTxn(s, { personId: payer, amountCents: 500 });
    const reimbursedTxn = await seedManualTxn(s, { personId: payer, amountCents: 700 });
    const normalTxn = await seedManualTxn(s, { personId: payer, amountCents: 900 });

    const { counts: before } = await s.as.query(api.finances.listReconcile, {});
    // Baseline: all three count as spend before any flag.
    expect(before.spend).toBe(3);

    await s.as.mutation(api.cards.flagPersonalCharge, { transactionId: unpaidTxn });
    const reimbursedRep = await s.as.mutation(api.cards.flagPersonalCharge, {
      transactionId: reimbursedTxn,
    });
    await run(s.t, (ctx) =>
      ctx.db.patch(reimbursedRep.id, { status: "paid", updatedAt: Date.now() }),
    );

    const { rows, counts } = await s.as.query(api.finances.listReconcile, {});
    // Only the untouched transaction still counts as spend — BOTH the unpaid
    // AND the reimbursed personal charge are excluded.
    expect(counts.spend).toBe(1);
    const reimbursedRow = rows.find((r) => r.id === reimbursedTxn)!;
    expect(reimbursedRow.isPersonal).toBe(true);
    expect(reimbursedRow.repaymentStatus).toBe("paid");
    // Sanity: the untouched row is the one still counted.
    void normalTxn;
  });

  test("the personal_unpaid filter/pill counts only the unpaid one, not the reimbursed one", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const payer = await seedPerson(s, { name: "Payer", userId: s.userId });
    await grantRole(s, payer, "viewer");
    const unpaidTxn = await seedManualTxn(s, { personId: payer, amountCents: 500 });
    const reimbursedTxn = await seedManualTxn(s, { personId: payer, amountCents: 700 });

    await s.as.mutation(api.cards.flagPersonalCharge, { transactionId: unpaidTxn });
    const rep2 = await s.as.mutation(api.cards.flagPersonalCharge, {
      transactionId: reimbursedTxn,
    });
    await run(s.t, (ctx) => ctx.db.patch(rep2.id, { status: "paid", updatedAt: Date.now() }));

    const { rows, counts } = await s.as.query(api.finances.listReconcile, {
      filter: "personal_unpaid",
    });
    expect(counts.personal_unpaid).toBe(1);
    expect(rows.map((r) => r.id)).toEqual([unpaidTxn]);
  });
});

// ── Stripe repayment rail ─────────────────────────────────────────────────────

async function seedRepayment(
  s: ChapterSetup,
  payerPersonId: Id<"people">,
  amountCents: number,
): Promise<{ repaymentId: Id<"personalRepayments">; transactionId: Id<"transactions"> }> {
  const transactionId = await seedManualTxn(s, { personId: payerPersonId, amountCents });
  const now = Date.now();
  const repaymentId = await run(s.t, (ctx) =>
    ctx.db.insert("personalRepayments", {
      chapterId: s.chapterId,
      transactionId,
      payerPersonId,
      amountCents,
      method: "card",
      status: "pending",
      createdAt: now,
      updatedAt: now,
    }),
  );
  await run(s.t, (ctx) => ctx.db.patch(transactionId, { isPersonal: true, repaymentId }));
  return { repaymentId, transactionId };
}

describe("Stripe repayment — prepare / attach / apply", () => {
  test("prepareRepaymentCheckout bundles outstanding lines, skips already-paid ones, errors when nothing's owed", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const payer = await seedPerson(s, { name: "Payer", userId: s.userId });
    const outstanding = await seedRepayment(s, payer, 1000);
    const alreadyPaid = await seedRepayment(s, payer, 500);
    await run(s.t, (ctx) =>
      ctx.db.patch(alreadyPaid.repaymentId, { status: "paid", updatedAt: Date.now() }),
    );

    const prepared = await s.as.mutation(internal.cards.prepareRepaymentCheckout, {
      repaymentIds: [outstanding.repaymentId, alreadyPaid.repaymentId],
      method: "card",
    });
    expect(prepared.lines).toHaveLength(1);
    expect(prepared.lines[0].repaymentId).toBe(outstanding.repaymentId);
    expect(prepared.totalCents).toBe(1000);

    // Nothing owed at all → NOTHING_OWED.
    let caught: unknown;
    try {
      await s.as.mutation(internal.cards.prepareRepaymentCheckout, {
        repaymentIds: [alreadyPaid.repaymentId],
        method: "card",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConvexError);
    expect((caught as ConvexError<{ code: string }>).data.code).toBe("NOTHING_OWED");
  });

  test("applyRepaymentPaidFromStripe settles every listed repayment exactly once — idempotent under a DUPLICATE webhook delivery", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const payer = await seedPerson(s, { name: "Payer", userId: s.userId });
    const a = await seedRepayment(s, payer, 1000);
    const b = await seedRepayment(s, payer, 500);

    const args = {
      repaymentIds: [a.repaymentId, b.repaymentId],
      sessionId: "cs_test_bundle",
      paymentIntentId: "pi_test_1",
      amountTotalCents: 1500,
    };
    await t.mutation(internal.cards.applyRepaymentPaidFromStripe, args);
    const afterFirst = await run(s.t, (ctx) => Promise.all([
      ctx.db.get(a.repaymentId),
      ctx.db.get(b.repaymentId),
    ]));
    expect(afterFirst[0]?.status).toBe("paid");
    expect(afterFirst[1]?.status).toBe("paid");
    const creditA = afterFirst[0]?.creditTransactionId;
    const creditB = afterFirst[1]?.creditTransactionId;
    expect(creditA).toBeTruthy();
    expect(creditB).toBeTruthy();

    // Stripe redelivers the SAME event (duplicate) — must not post a second
    // offsetting credit for either repayment.
    await t.mutation(internal.cards.applyRepaymentPaidFromStripe, args);
    const afterSecond = await run(s.t, (ctx) => Promise.all([
      ctx.db.get(a.repaymentId),
      ctx.db.get(b.repaymentId),
    ]));
    expect(afterSecond[0]?.creditTransactionId).toBe(creditA);
    expect(afterSecond[1]?.creditTransactionId).toBe(creditB);

    const creditRows = await run(s.t, (ctx) =>
      ctx.db
        .query("transactions")
        .withIndex("by_chapter", (q) => q.eq("chapterId", s.chapterId))
        .collect(),
    );
    const credits = creditRows.filter((r) => r.source === "repayment");
    expect(credits).toHaveLength(2); // exactly one credit per repayment, never doubled
  });

  test("OUT-OF-ORDER delivery: a repayment already settled by another rail before the webhook arrives is skipped, not double-settled", async () => {
    const t = newT();
    const s = await setupChapter(t);
    // `payer` is a separate, unlinked roster row (just who's owed, not who's
    // acting) — both settlements below arrive from rails, not from a caller.
    await seedManager(s);
    const payer = await seedPerson(s, { name: "Payer" });
    const a = await seedRepayment(s, payer, 1000);

    // The Increase ACH debit lands BEFORE the (late/out-of-order) Stripe
    // webhook — two real rails racing, which is the case that survives now
    // that a manager cannot assert a settlement by hand.
    await t.mutation(internal.cards.applyRepaymentPaid, {
      repaymentId: a.repaymentId,
      increaseRef: "ach_first",
    });
    const afterFirstRail = await run(s.t, (ctx) => ctx.db.get(a.repaymentId));
    const firstCredit = afterFirstRail?.creditTransactionId;
    expect(firstCredit).toBeTruthy();

    await t.mutation(internal.cards.applyRepaymentPaidFromStripe, {
      repaymentIds: [a.repaymentId],
      sessionId: "cs_late",
      paymentIntentId: "pi_late",
      amountTotalCents: 1000,
    });

    const after = await run(s.t, (ctx) => ctx.db.get(a.repaymentId));
    // Same credit as before — the late webhook found it already settled and
    // skipped it (never a second credit).
    expect(after?.creditTransactionId).toBe(firstCredit);
    const creditRows = (
      await run(s.t, (ctx) =>
        ctx.db
          .query("transactions")
          .withIndex("by_chapter", (q) => q.eq("chapterId", s.chapterId))
          .collect(),
      )
    ).filter((r) => r.source === "repayment");
    expect(creditRows).toHaveLength(1);
  });

  test("AMOUNT MISMATCH: settles every still-outstanding repayment at its OWN amount and logs loudly, rather than silently accepting the Stripe total", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const payer = await seedPerson(s, { name: "Payer", userId: s.userId });
    const a = await seedRepayment(s, payer, 1000);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Stripe reports a DIFFERENT total than what's actually owed (1000).
    await t.mutation(internal.cards.applyRepaymentPaidFromStripe, {
      repaymentIds: [a.repaymentId],
      sessionId: "cs_mismatch",
      paymentIntentId: "pi_mismatch",
      amountTotalCents: 750,
    });

    const after = await run(s.t, (ctx) => ctx.db.get(a.repaymentId));
    // Still settled — at its OWN stored amount, never silently rewritten to
    // the mismatched Stripe total.
    expect(after?.status).toBe("paid");
    expect(after?.amountCents).toBe(1000);
    const credit = after?.creditTransactionId
      ? await run(s.t, (ctx) => ctx.db.get(after.creditTransactionId!))
      : null;
    expect(credit?.amountCents).toBe(1000);
    expect(
      errorSpy.mock.calls.some((c) => String(c[0]).includes("amount mismatch")),
    ).toBe(true);
    errorSpy.mockRestore();
  });

  test("a repayment id that no longer exists (un-flagged after the checkout was created) is skipped with a loud log, not thrown", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const payer = await seedPerson(s, { name: "Payer", userId: s.userId });
    const a = await seedRepayment(s, payer, 1000);
    await run(s.t, (ctx) => ctx.db.delete(a.repaymentId));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      t.mutation(internal.cards.applyRepaymentPaidFromStripe, {
        repaymentIds: [a.repaymentId],
        sessionId: "cs_gone",
        amountTotalCents: 1000,
      }),
    ).resolves.toBeNull();
    expect(
      errorSpy.mock.calls.some((c) => String(c[0]).includes("not found")),
    ).toBe(true);
    errorSpy.mockRestore();
  });
});

// ── The flagged email's pay-back link ────────────────────────────────────────

describe("notifyPersonalChargeFlagged — the pay-back link", () => {
  const realFetch = globalThis.fetch;

  test("with APP_URL set, the email carries a real clickable pay-back link", async () => {
    const prevAppUrl = process.env.APP_URL;
    const prevResendKey = process.env.RESEND_API_KEY;
    process.env.APP_URL = "https://app.publicworship.life";
    process.env.RESEND_API_KEY = "resend_test_key";
    try {
      const t = newT();
      const s = await setupChapter(t);
      const manager = await seedManager(s);
      void manager;
      const payer = await seedPerson(s, { name: "Payer", pwEmail: "payer@publicworship.life" });
      const rep = await seedRepayment(s, payer, 4200);

      const sent: { to: string; subject: string; html: string }[] = [];
      globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
        const body = init?.body ? JSON.parse(init.body) : {};
        sent.push({ to: body.to, subject: body.subject, html: body.html });
        return { ok: true, status: 200, text: async () => "{}" };
      }) as unknown as typeof fetch;

      await t.action(internal.cards.notifyPersonalChargeFlagged, {
        repaymentId: rep.repaymentId,
      });

      expect(sent).toHaveLength(1);
      expect(sent[0].to).toBe("payer@publicworship.life");
      // `[^>]*` before `href` too: the themed button helper
      // (`lib/emailShell.ts#emailButtonRow`) emits `class="pw-btn"` first, so
      // the anchor's attribute ORDER is not part of the contract — the link
      // target and its visible label are.
      //
      // The target moved from `/finances/cards` to `/finances/repayments`
      // (2026-08-14): the Cards tab's member view used to own the pay-back
      // flow as a single "pay everything" button, and the payer can now pick
      // which charges to settle. This email says "you owe $42.00" about ONE
      // charge, so it has to land on the page that has that charge on it with
      // a checkbox next to it.
      expect(sent[0].html).toMatch(
        /<a[^>]*href="https:\/\/app\.publicworship\.life\/finances\/repayments"[^>]*>Pay it back/,
      );
    } finally {
      globalThis.fetch = realFetch;
      if (prevAppUrl === undefined) delete process.env.APP_URL;
      else process.env.APP_URL = prevAppUrl;
      if (prevResendKey === undefined) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = prevResendKey;
    }
  });

  test("with APP_URL unset, the email still sends (no dead link) and degrades LOUDLY via console.error", async () => {
    const prevAppUrl = process.env.APP_URL;
    const prevResendKey = process.env.RESEND_API_KEY;
    delete process.env.APP_URL;
    process.env.RESEND_API_KEY = "resend_test_key";
    try {
      const t = newT();
      const s = await setupChapter(t);
      const manager = await seedManager(s);
      void manager;
      const payer = await seedPerson(s, { name: "Payer", pwEmail: "payer2@publicworship.life" });
      const rep = await seedRepayment(s, payer, 1500);

      const sent: { to: string; subject: string; html: string }[] = [];
      globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
        const body = init?.body ? JSON.parse(init.body) : {};
        sent.push({ to: body.to, subject: body.subject, html: body.html });
        return { ok: true, status: 200, text: async () => "{}" };
      }) as unknown as typeof fetch;
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      await t.action(internal.cards.notifyPersonalChargeFlagged, {
        repaymentId: rep.repaymentId,
      });

      expect(sent).toHaveLength(1); // transactional — still sends
      expect(sent[0].html).not.toMatch(/<a[^>]*href=/); // no anchor at all, in any attribute order
      expect(sent[0].html).toContain("Finances");
      expect(
        errorSpy.mock.calls.some((c) => String(c[0]).includes("APP_URL is unset")),
      ).toBe(true);
      errorSpy.mockRestore();
    } finally {
      globalThis.fetch = realFetch;
      if (prevAppUrl === undefined) delete process.env.APP_URL;
      else process.env.APP_URL = prevAppUrl;
      if (prevResendKey === undefined) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = prevResendKey;
    }
  });
});
