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
import { CONTRACTOR_LEDGER_COUNTERPARTY, displayMerchantName } from "@events-os/shared";
import { buildInstallmentPaidNotice } from "../lib/contractorPaymentEmails";
import type { Id } from "../_generated/dataModel";

/**
 * Contractor payment SCHEDULES — "half now, half on delivery".
 *
 * Weighted, like its sibling suite, toward what is irreversible or invisible
 * rather than toward coverage. The five things that would actually hurt:
 *
 *  1. A TRANCHE MUST NOT CLOSE THE AGREEMENT. `paid` is terminal, so a deposit
 *     settling and stamping the parent `paid` would strand the balance in a
 *     state nothing can pay from — an agreement that silently stops owing
 *     somebody the other half of their money.
 *  2. THE SCHEDULE MUST SUM TO THE AGREED TOTAL. A schedule that sums to less
 *     looks finished on screen and under-pays the person who signed for the
 *     full number.
 *  3. EACH TRANCHE POSTS ITS OWN LEDGER ROW. Idempotency keyed on the agreement
 *     instead of the tranche would book a $10,000 engagement as its $5,000
 *     deposit, forever, with the budget under-spent by half.
 *  4. NO DOUBLE-PAY. One live payout per TRANCHE — and, because the Increase
 *     idempotency key is the subject id, the second tranche must not reuse the
 *     first's key or the bank hands back a dead transfer.
 *  5. A SCHEDULE IS A TERM. Writing one onto an accepted agreement voids the
 *     acceptance, exactly as changing the amount does.
 */

// ── Increase mock plumbing (mirrors contractorPayments.test.ts) ─────────────
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

async function grantManager(
  s: ChapterSetup,
  personId: Id<"people">,
): Promise<void> {
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

async function setup(): Promise<{
  s: ChapterSetup;
  budgetId: Id<"budgets">;
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
  await grantManager(s, composerPersonId);
  const budgetId = await run(t, (ctx) =>
    ctx.db.insert("budgets", {
      chapterId: s.chapterId,
      amountCents: 5_000_00,
      type: "recurring",
      cadence: "yearly",
      year: 2026,
      label: "Production",
      createdAt: Date.now(),
    }),
  );
  return { s, budgetId };
}

async function seedApprover(s: ChapterSetup): Promise<{
  as: ReturnType<ChapterSetup["t"]["withIdentity"]>;
  personId: Id<"people">;
}> {
  const email = "treasurer@publicworship.life";
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
  const personId = await seedPerson(s, { name: "Treasurer", email, userId });
  await grantManager(s, personId);
  return {
    as: s.t.withIdentity({ subject: `${userId}|session`, issuer: "test" }),
    personId,
  };
}

/** $1,000, split half now / half on delivery — the founder's example, and the
 *  shape nearly every test below wants. */
const AGREEMENT = {
  payeeName: "Jane Contractor",
  payeeEmail: "jane@example.com",
  serviceDescription: "Mixing and mastering the spring record",
  agreedAmountCents: 100_000,
};

const HALF_AND_HALF = [
  { label: "Deposit", amountCents: 50_000, trigger: "on_signing" as const },
  {
    label: "On delivery",
    amountCents: 50_000,
    trigger: "on_milestone" as const,
    milestoneNote: "the final master is delivered",
  },
];

/** An agreement with a schedule, driven to `submitted`. */
async function scheduledAndSubmitted(
  s: ChapterSetup,
  budgetId: Id<"budgets">,
  installments = HALF_AND_HALF,
): Promise<Id<"contractorPayments">> {
  const { contractorPaymentId } = await s.as.mutation(
    api.contractorPayments.createAgreement,
    { ...AGREEMENT, budgetId },
  );
  await s.as.mutation(api.contractorInstallments.setSchedule, {
    contractorPaymentId,
    installments,
  });
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
  return contractorPaymentId;
}

async function scheduleOf(
  s: ChapterSetup,
  contractorPaymentId: Id<"contractorPayments">,
) {
  return await run(s.t, (ctx) =>
    ctx.db
      .query("contractorPaymentInstallments")
      .withIndex("by_payment", (q) =>
        q.eq("contractorPaymentId", contractorPaymentId),
      )
      .collect(),
  );
}

// ── 1. A tranche settling must not close the agreement ──────────────────────
describe("paying one tranche does not end the agreement", () => {
  test("the deposit settles, the agreement stays payable, the balance follows", async () => {
    const { s, budgetId } = await setup();
    const id = await scheduledAndSubmitted(s, budgetId);
    const approver = await seedApprover(s);
    await approver.as.mutation(api.contractorPayments.approve, {
      contractorPaymentId: id,
    });

    const [deposit, balance] = await scheduleOf(s, id);
    await approver.as.mutation(api.contractorPayouts.markPaidManually, {
      contractorPaymentId: id,
      installmentId: deposit._id,
    });

    // THE POINT OF THE WHOLE FEATURE. `paid` is terminal; stamping it here
    // would leave the balance unpayable and the contractor short $500 with
    // nothing in the app able to say so.
    let row = await run(s.t, (ctx) => ctx.db.get(id));
    expect(row!.status).toBe("approved");
    expect(row!.paidAt).toBeUndefined();

    let sched = await scheduleOf(s, id);
    expect(sched.find((i) => i._id === deposit._id)!.status).toBe("paid");
    expect(sched.find((i) => i._id === balance._id)!.status).toBe("scheduled");

    // The balance goes, and NOW the agreement is finished.
    await approver.as.mutation(api.contractorPayouts.markPaidManually, {
      contractorPaymentId: id,
      installmentId: balance._id,
    });
    row = await run(s.t, (ctx) => ctx.db.get(id));
    expect(row!.status).toBe("paid");
    expect(row!.paidAt).toBeTypeOf("number");
    sched = await scheduleOf(s, id);
    expect(sched.every((i) => i.status === "paid")).toBe(true);
  });

  test("each tranche gets its own notice, naming what moved — never the total", async () => {
    const { s, budgetId } = await setup();
    const id = await scheduledAndSubmitted(s, budgetId);
    const approver = await seedApprover(s);
    await approver.as.mutation(api.contractorPayments.approve, {
      contractorPaymentId: id,
    });
    for (const inst of await scheduleOf(s, id)) {
      await approver.as.mutation(api.contractorPayouts.markPaidManually, {
        contractorPaymentId: id,
        installmentId: inst._id,
      });
    }

    // THE AGREEMENT-LEVEL NOTICE IS NEVER USED ON A SCHEDULE, the final tranche
    // included. `buildPaidNotice` states the full AGREED amount as the sum just
    // sent — true only when an agreement pays in one go. On the last tranche of
    // a schedule it would tell somebody who has just received $500 that $1,000
    // is on its way. Its exactly-once claim going unspent is the observable
    // proof it was never scheduled.
    const row = await run(s.t, (ctx) => ctx.db.get(id));
    expect(row!.status).toBe("paid");
    expect(row!.paidNoticeSentAt).toBeUndefined();

    // What the tranche notice says instead, asserted against the real builder:
    // the amount THAT MOVED, and — on the last one — that nothing is left.
    const last = (await scheduleOf(s, id))[1];
    const { subject, html } = buildInstallmentPaidNotice({
      payeeName: AGREEMENT.payeeName,
      chapterName: "New York",
      reference: "CP-TEST",
      installmentLabel: last.label,
      installmentSeq: last.seq,
      installmentCount: 2,
      amountCents: last.amountCents,
      remainingCents: 0,
      paidAt: Date.now(),
    });
    expect(subject).toContain("$500.00");
    expect(subject).not.toContain("$1,000.00");
    expect(html).toContain("payment 2 of 2");
    expect(html).toContain("settled");
  });

  test("the running total answers 'have we paid this halfway?'", async () => {
    const { s, budgetId } = await setup();
    const id = await scheduledAndSubmitted(s, budgetId);
    const approver = await seedApprover(s);
    await approver.as.mutation(api.contractorPayments.approve, {
      contractorPaymentId: id,
    });
    const [deposit] = await scheduleOf(s, id);
    await approver.as.mutation(api.contractorPayouts.markPaidManually, {
      contractorPaymentId: id,
      installmentId: deposit._id,
    });

    const view = await approver.as.query(
      api.contractorInstallments.listForPayment,
      { contractorPaymentId: id },
    );
    expect(view.scheduled).toBe(true);
    expect(view.summary.paidCents).toBe(50_000);
    expect(view.summary.remainingCents).toBe(50_000);
    expect(view.summary.paidCount).toBe(1);
  });

  test("cancelling the last open tranche closes the agreement without money moving", async () => {
    const { s, budgetId } = await setup();
    const id = await scheduledAndSubmitted(s, budgetId);
    const approver = await seedApprover(s);
    await approver.as.mutation(api.contractorPayments.approve, {
      contractorPaymentId: id,
    });
    const [deposit, balance] = await scheduleOf(s, id);
    await approver.as.mutation(api.contractorPayouts.markPaidManually, {
      contractorPaymentId: id,
      installmentId: deposit._id,
    });
    await approver.as.mutation(api.contractorInstallments.cancelInstallment, {
      installmentId: balance._id,
      reason: "The second session was cancelled",
    });

    // Nothing else will ever run to notice this, so the cancel path has to say
    // it: an agreement left in `approved` sits in a queue looking like it owes
    // somebody money it has decided not to send.
    const row = await run(s.t, (ctx) => ctx.db.get(id));
    expect(row!.status).toBe("paid");
    const view = await approver.as.query(
      api.contractorInstallments.listForPayment,
      { contractorPaymentId: id },
    );
    expect(view.summary.paidCents).toBe(50_000);
    expect(view.summary.canceledCents).toBe(50_000);
    expect(view.summary.remainingCents).toBe(0);
  });

  test("an agreement whose every tranche is canceled reads canceled, not paid", async () => {
    const { s, budgetId } = await setup();
    const id = await scheduledAndSubmitted(s, budgetId);
    const approver = await seedApprover(s);
    await approver.as.mutation(api.contractorPayments.approve, {
      contractorPaymentId: id,
    });
    for (const inst of await scheduleOf(s, id)) {
      await approver.as.mutation(api.contractorInstallments.cancelInstallment, {
        installmentId: inst._id,
        reason: "The project was shelved",
      });
    }
    // Stamping `paid` on an agreement under which the org sent nothing at all
    // would be plainly false.
    const row = await run(s.t, (ctx) => ctx.db.get(id));
    expect(row!.status).toBe("canceled");
  });
});

// ── 2. The schedule must sum to the agreed total ────────────────────────────
describe("a schedule has to add up", () => {
  test("a schedule summing to less than the agreed amount is refused", async () => {
    const { s, budgetId } = await setup();
    const { contractorPaymentId } = await s.as.mutation(
      api.contractorPayments.createAgreement,
      { ...AGREEMENT, budgetId },
    );
    await expect(
      s.as.mutation(api.contractorInstallments.setSchedule, {
        contractorPaymentId,
        installments: [
          { label: "Deposit", amountCents: 50_000, trigger: "on_signing" },
          { label: "Balance", amountCents: 40_000, trigger: "on_signing" },
        ],
      }),
    ).rejects.toThrow(ConvexError);
  });

  test("a schedule summing to more than the agreed amount is refused", async () => {
    const { s, budgetId } = await setup();
    const { contractorPaymentId } = await s.as.mutation(
      api.contractorPayments.createAgreement,
      { ...AGREEMENT, budgetId },
    );
    await expect(
      s.as.mutation(api.contractorInstallments.setSchedule, {
        contractorPaymentId,
        installments: [
          { label: "Deposit", amountCents: 60_000, trigger: "on_signing" },
          { label: "Balance", amountCents: 60_000, trigger: "on_signing" },
        ],
      }),
    ).rejects.toThrow(ConvexError);
  });

  test("a milestone tranche must say what has to happen", async () => {
    const { s, budgetId } = await setup();
    const { contractorPaymentId } = await s.as.mutation(
      api.contractorPayments.createAgreement,
      { ...AGREEMENT, budgetId },
    );
    await expect(
      s.as.mutation(api.contractorInstallments.setSchedule, {
        contractorPaymentId,
        installments: [
          { label: "Everything", amountCents: 100_000, trigger: "on_milestone" },
        ],
      }),
    ).rejects.toThrow(ConvexError);
  });

  test("the agreed total can't move out from under a schedule on its own", async () => {
    const { s, budgetId } = await setup();
    const id = await scheduledAndSubmitted(s, budgetId);
    await expect(
      s.as.mutation(api.contractorPayments.updateTerms, {
        contractorPaymentId: id,
        agreedAmountCents: 200_000,
      }),
    ).rejects.toThrow(ConvexError);
  });

  test("but the total and the schedule can move together, in one edit", async () => {
    const { s, budgetId } = await setup();
    const id = await scheduledAndSubmitted(s, budgetId);
    await s.as.mutation(api.contractorPayments.updateTerms, {
      contractorPaymentId: id,
      agreedAmountCents: 200_000,
      installments: [
        { label: "Deposit", amountCents: 100_000, trigger: "on_signing" },
        { label: "Balance", amountCents: 100_000, trigger: "on_signing" },
      ],
    });
    const row = await run(s.t, (ctx) => ctx.db.get(id));
    expect(row!.agreedAmountCents).toBe(200_000);
    const sched = await scheduleOf(s, id);
    expect(sched.reduce((n, i) => n + i.amountCents, 0)).toBe(200_000);
  });

  test("a scheduled agreement can't be approved for a different amount", async () => {
    const { s, budgetId } = await setup();
    const id = await scheduledAndSubmitted(s, budgetId);
    const approver = await seedApprover(s);
    await expect(
      approver.as.mutation(api.contractorPayments.approve, {
        contractorPaymentId: id,
        approvedCents: 60_000,
      }),
    ).rejects.toThrow(ConvexError);
  });
});

// ── 3. Each tranche is its own ledger row ───────────────────────────────────
describe("the ledger records every tranche", () => {
  test("two tranches post two outflow rows, for their own amounts", async () => {
    const { s, budgetId } = await setup();
    const id = await scheduledAndSubmitted(s, budgetId);
    const approver = await seedApprover(s);
    await approver.as.mutation(api.contractorPayments.approve, {
      contractorPaymentId: id,
    });
    for (const inst of await scheduleOf(s, id)) {
      await approver.as.mutation(api.contractorPayouts.markPaidManually, {
        contractorPaymentId: id,
        installmentId: inst._id,
      });
    }

    const txns = await run(s.t, (ctx) =>
      ctx.db
        .query("transactions")
        .withIndex("by_contractor_payment", (q) =>
          q.eq("contractorPaymentId", id),
        )
        .collect(),
    );
    // Keyed on the AGREEMENT, the second tranche would find the first row and
    // skip booking — a $1,000 engagement recorded as $500 of spend.
    expect(txns).toHaveLength(2);
    expect(txns.map((t) => t.amountCents).sort()).toEqual([50_000, 50_000]);
    expect(txns.every((t) => t.flow === "outflow")).toBe(true);
    expect(new Set(txns.map((t) => String(t.contractorInstallmentId))).size).toBe(2);
  });

  test("the payee's name still never reaches the public ledger", async () => {
    const { s, budgetId } = await setup();
    const id = await scheduledAndSubmitted(s, budgetId);
    const approver = await seedApprover(s);
    await approver.as.mutation(api.contractorPayments.approve, {
      contractorPaymentId: id,
    });
    const [deposit] = await scheduleOf(s, id);
    await approver.as.mutation(api.contractorPayouts.markPaidManually, {
      contractorPaymentId: id,
      installmentId: deposit._id,
    });

    const txn = await run(s.t, (ctx) =>
      ctx.db
        .query("transactions")
        .withIndex("by_contractor_payment", (q) =>
          q.eq("contractorPaymentId", id),
        )
        .first(),
    );
    // Naming the tranche in the description must not have opened a path to the
    // payee's name publishing — `merchantName` is still the constant, so the
    // resolver never falls through to `description`.
    const published = displayMerchantName(txn!);
    expect(published).toBe(CONTRACTOR_LEDGER_COUNTERPARTY);
    expect(published).not.toContain("Jane");
    expect(txn!.description).toContain("Deposit");
  });
});

// ── 4. No double-pay ────────────────────────────────────────────────────────
describe("a tranche can't be paid twice", () => {
  test("marking the same tranche paid again returns the same payout", async () => {
    const { s, budgetId } = await setup();
    const id = await scheduledAndSubmitted(s, budgetId);
    const approver = await seedApprover(s);
    await approver.as.mutation(api.contractorPayments.approve, {
      contractorPaymentId: id,
    });
    const [deposit] = await scheduleOf(s, id);
    const first = await approver.as.mutation(
      api.contractorPayouts.markPaidManually,
      { contractorPaymentId: id, installmentId: deposit._id },
    );
    const second = await approver.as.mutation(
      api.contractorPayouts.markPaidManually,
      { contractorPaymentId: id, installmentId: deposit._id },
    );
    // `id`, not `_id` — the payout SUMMARY's own field name. Comparing `_id`
    // here compared undefined to undefined and would have passed even if the
    // second call had minted a whole new payout, which is the one thing this
    // test exists to catch.
    expect(second.id).toBe(first.id);

    const payouts = await run(s.t, (ctx) =>
      ctx.db
        .query("payouts")
        .withIndex("by_contractor_payment", (q) =>
          q.eq("contractorPaymentId", id),
        )
        .collect(),
    );
    expect(payouts).toHaveLength(1);
  });

  test("paying a scheduled agreement without naming a tranche is refused", async () => {
    const { s, budgetId } = await setup();
    const id = await scheduledAndSubmitted(s, budgetId);
    const approver = await seedApprover(s);
    await approver.as.mutation(api.contractorPayments.approve, {
      contractorPaymentId: id,
    });
    // The pre-schedule "Pay" button's exact shape. It must fail loudly rather
    // than send the whole agreed total behind the schedule's back.
    await expect(
      approver.as.mutation(api.contractorPayouts.markPaidManually, {
        contractorPaymentId: id,
      }),
    ).rejects.toThrow(ConvexError);
  });

  test("a canceled tranche can't then be paid", async () => {
    const { s, budgetId } = await setup();
    const id = await scheduledAndSubmitted(s, budgetId);
    const approver = await seedApprover(s);
    await approver.as.mutation(api.contractorPayments.approve, {
      contractorPaymentId: id,
    });
    const [deposit] = await scheduleOf(s, id);
    await approver.as.mutation(api.contractorInstallments.cancelInstallment, {
      installmentId: deposit._id,
      reason: "Paid this one by check last month",
    });
    await expect(
      approver.as.mutation(api.contractorPayouts.markPaidManually, {
        contractorPaymentId: id,
        installmentId: deposit._id,
      }),
    ).rejects.toThrow(ConvexError);
  });

  test("the payee still can't release their own tranche", async () => {
    const { s, budgetId } = await setup();
    // The payee is a roster person here, which is what
    // `assertSeparationOfDuties` keys on.
    const payeePersonId = await seedPerson(s, {
      name: "Jane Contractor",
      email: AGREEMENT.payeeEmail,
    });
    const payeeUserId = await run(s.t, (ctx) =>
      ctx.db.insert("users", { email: AGREEMENT.payeeEmail }),
    );
    await run(s.t, (ctx) =>
      ctx.db.patch(payeePersonId, { userId: payeeUserId }),
    );
    await run(s.t, (ctx) =>
      ctx.db.insert("userChapters", {
        userId: payeeUserId,
        chapterId: s.chapterId,
        role: "admin",
        isActive: true,
        joinedAt: Date.now(),
      }),
    );
    await grantManager(s, payeePersonId);

    const id = await scheduledAndSubmitted(s, budgetId);
    await run(s.t, (ctx) => ctx.db.patch(id, { personId: payeePersonId }));
    const approver = await seedApprover(s);
    await approver.as.mutation(api.contractorPayments.approve, {
      contractorPaymentId: id,
    });
    const [deposit] = await scheduleOf(s, id);

    // Separation of duties is a property of the RAIL, not of unscheduled
    // agreements — a schedule must not become a way around it. (Note the
    // disbursement check deliberately does NOT include the authorship test the
    // APPROVAL check carries: approval is where authorship is gated, and a
    // composer releasing money somebody else approved is the normal case.)
    const asPayee = s.t.withIdentity({
      subject: `${payeeUserId}|session`,
      issuer: "test",
    });
    await expect(
      asPayee.mutation(api.contractorPayouts.markPaidManually, {
        contractorPaymentId: id,
        installmentId: deposit._id,
      }),
    ).rejects.toThrow(ConvexError);
  });
});

// ── 5. A schedule is a term ─────────────────────────────────────────────────
describe("a payment plan is part of the deal", () => {
  test("writing a schedule after acceptance voids the acceptance", async () => {
    const { s, budgetId } = await setup();
    // No schedule at first: accept, THEN add one.
    const { contractorPaymentId } = await s.as.mutation(
      api.contractorPayments.createAgreement,
      { ...AGREEMENT, budgetId },
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
    const before = await run(s.t, (ctx) => ctx.db.get(contractorPaymentId));
    expect(before!.acceptedAt).toBeTypeOf("number");

    const result = await s.as.mutation(api.contractorInstallments.setSchedule, {
      contractorPaymentId,
      installments: HALF_AND_HALF,
    });
    expect(result.acceptanceVoided).toBe(true);

    // Otherwise the record holds a signature against a payment plan the person
    // never saw — the single worst thing this feature could do.
    const after = await run(s.t, (ctx) => ctx.db.get(contractorPaymentId));
    expect(after!.acceptedAt).toBeUndefined();
    expect(after!.status).toBe("sent");
    expect(after!.agreementTermsVersion).toBe(before!.agreementTermsVersion + 1);
  });

  test("re-saving an unchanged schedule does not cost a signature", async () => {
    const { s, budgetId } = await setup();
    const id = await scheduledAndSubmitted(s, budgetId);
    const before = await run(s.t, (ctx) => ctx.db.get(id));

    // The detail screen re-sends the whole schedule on every terms save. If
    // that counted as a change, fixing a typo in the notes would email the
    // contractor asking them to sign again.
    const result = await s.as.mutation(api.contractorPayments.updateTerms, {
      contractorPaymentId: id,
      agreementNotes: "Studio time is included.",
      installments: HALF_AND_HALF,
    });
    expect(result.acceptanceVoided).toBe(false);
    const after = await run(s.t, (ctx) => ctx.db.get(id));
    expect(after!.acceptedAt).toBe(before!.acceptedAt);
    expect(after!.agreementTermsVersion).toBe(before!.agreementTermsVersion);
  });

  test("the contractor's own page shows the schedule before they sign", async () => {
    const { s, budgetId } = await setup();
    const { contractorPaymentId } = await s.as.mutation(
      api.contractorPayments.createAgreement,
      { ...AGREEMENT, budgetId },
    );
    await s.as.mutation(api.contractorInstallments.setSchedule, {
      contractorPaymentId,
      installments: HALF_AND_HALF,
    });
    await s.as.mutation(api.contractorPayments.send, { contractorPaymentId });
    const token = await run(s.t, async (ctx) => {
      const row = await ctx.db.get(contractorPaymentId);
      return row!.token;
    });

    const view = await s.t.query(api.contractorPayments.publicByToken, { token });
    // A person asked to sign for $1,000 is entitled to see that it arrives in
    // two halves BEFORE they agree, not to discover it when the first one is
    // smaller than they expected.
    expect(view!.installments).toHaveLength(2);
    expect(view!.installments[0].label).toBe("Deposit");
    expect(view!.installments[1].milestoneNote).toBe(
      "the final master is delivered",
    );
    // And nothing internal rides along on a public projection.
    for (const i of view!.installments) {
      expect(i).not.toHaveProperty("releaseNote");
      expect(i).not.toHaveProperty("canceledReason");
    }
  });

  test("a schedule can't be re-cut once the agreement is approved", async () => {
    const { s, budgetId } = await setup();
    const id = await scheduledAndSubmitted(s, budgetId);
    const approver = await seedApprover(s);
    await approver.as.mutation(api.contractorPayments.approve, {
      contractorPaymentId: id,
    });
    const [deposit] = await scheduleOf(s, id);
    await approver.as.mutation(api.contractorPayouts.markPaidManually, {
      contractorPaymentId: id,
      installmentId: deposit._id,
    });

    // The agreement is back in `approved` so the BALANCE can be released — and
    // that is exactly the window in which re-cutting the plan would rewrite the
    // half that has already been sent. Refused on the status, with
    // `writeSchedule`'s own paid-tranche check behind it.
    await expect(
      s.as.mutation(api.contractorInstallments.setSchedule, {
        contractorPaymentId: id,
        installments: [
          { label: "All of it", amountCents: 100_000, trigger: "on_signing" },
        ],
      }),
    ).rejects.toThrow(ConvexError);
    // The paid tranche is untouched.
    const sched = await scheduleOf(s, id);
    expect(sched).toHaveLength(2);
    expect(sched.find((i) => i._id === deposit._id)!.status).toBe("paid");
  });

  test("cancelling the agreement takes its unpaid schedule with it", async () => {
    const { s, budgetId } = await setup();
    const id = await scheduledAndSubmitted(s, budgetId);
    const approver = await seedApprover(s);
    await approver.as.mutation(api.contractorPayments.cancel, {
      contractorPaymentId: id,
      reason: "Booked someone else",
    });
    // A tranche left `scheduled` reads as owed everywhere a schedule is
    // counted, so a canceled agreement would report a balance forever.
    const sched = await scheduleOf(s, id);
    expect(sched.every((i) => i.status === "canceled")).toBe(true);
  });
});
