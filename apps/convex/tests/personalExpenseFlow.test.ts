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
    });
    expect(prepared.lines).toHaveLength(1);
    expect(prepared.lines[0].repaymentId).toBe(outstanding.repaymentId);
    expect(prepared.totalCents).toBe(1000);

    // Nothing owed at all → NOTHING_OWED.
    let caught: unknown;
    try {
      await s.as.mutation(internal.cards.prepareRepaymentCheckout, {
        repaymentIds: [alreadyPaid.repaymentId],
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

  test("OUT-OF-ORDER delivery: a repayment already settled via markRepaymentPaid before the webhook arrives is skipped, not double-settled", async () => {
    const t = newT();
    const s = await setupChapter(t);
    // The caller (`s.as`) is the MANAGER here — `markRepaymentPaid` is
    // manager-only. `payer` is a separate, unlinked roster row (just who's
    // owed, not who's acting).
    await seedManager(s);
    const payer = await seedPerson(s, { name: "Payer" });
    const a = await seedRepayment(s, payer, 1000);

    // A manager confirms receipt manually BEFORE the (late/out-of-order)
    // Stripe webhook lands.
    await s.as.mutation(api.cards.markRepaymentPaid, { repaymentId: a.repaymentId });
    const afterManual = await run(s.t, (ctx) => ctx.db.get(a.repaymentId));
    const manualCredit = afterManual?.creditTransactionId;
    expect(manualCredit).toBeTruthy();

    await t.mutation(internal.cards.applyRepaymentPaidFromStripe, {
      repaymentIds: [a.repaymentId],
      sessionId: "cs_late",
      paymentIntentId: "pi_late",
      amountTotalCents: 1000,
    });

    const after = await run(s.t, (ctx) => ctx.db.get(a.repaymentId));
    // Same credit as before — the late webhook found it already settled and
    // skipped it (never a second credit).
    expect(after?.creditTransactionId).toBe(manualCredit);
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
      expect(sent[0].html).toMatch(
        /<a href="https:\/\/app\.publicworship\.life\/finances\/cards"[^>]*>Pay it back/,
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
      expect(sent[0].html).not.toContain("<a href=");
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
