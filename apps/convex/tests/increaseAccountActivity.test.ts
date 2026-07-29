import { afterEach, describe, expect, test } from "vitest";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  extractAccountActivity,
  extractCardCharge,
} from "../lib/increaseExtract";

/**
 * Increase ACCOUNT-activity ingestion tests (the non-card lane —
 * `increaseLedger.applyIncreaseAccountTransaction` + the shared webhook
 * entry). The founding bug: an inbound transfer (Relay → the chapter's
 * Increase account) never reached the ledger, so it couldn't be selected in
 * Reconcile and marked as a transfer. Covered here:
 *  - extraction (pure): non-card categories extract with flow/cents/
 *    description/counterparty/transfer_id; card categories and $0 rows don't,
 *  - an inbound ACH webhook posts ONE `increase_ach` inflow row, idempotently,
 *  - an entry that settles a reimbursement PAYOUT is skipped (the expense
 *    already posts as `source:"reimbursement"`),
 *  - an entry that settles a personal-repayment ACH debit is skipped (the
 *    offsetting credit posts as `source:"repayment"`),
 *  - an entry whose transfer is already booked as a ledger transfer leg
 *    (historical skim/launch-grant/settlement `externalId` stamping) is
 *    skipped,
 *  - a dashboard-initiated ACH with NO matching app record IS ingested
 *    (outflow),
 *  - activity on the CENTRAL account posts as a central-owned row,
 *  - an account we don't hold is skipped.
 */

// ── env + fetch snapshot/restore (mirrors increaseCards.test.ts) ─────────────

const ENV_KEYS = ["INCREASE_API_KEY", "INCREASE_SANDBOX_API_KEY"] as const;
const originalFetch = globalThis.fetch;
const originalEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};
for (const k of ENV_KEYS) originalEnv[k] = process.env[k];

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const k of ENV_KEYS) {
    if (originalEnv[k] === undefined) delete process.env[k];
    else process.env[k] = originalEnv[k];
  }
});

// ── seed + mock helpers ──────────────────────────────────────────────────────

async function seedIncreaseAccount(
  s: ChapterSetup,
  increaseAccountId: string,
  scope?: "central",
): Promise<void> {
  const now = Date.now();
  await run(s.t, (ctx) =>
    ctx.db.insert("increaseAccounts", {
      chapterId: scope ?? s.chapterId,
      sandbox: increaseAccountId.startsWith("sandbox_"),
      onboardingStatus: "active",
      increaseEntityId: "entity_shared_org",
      increaseAccountId,
      createdAt: now,
      updatedAt: now,
    }),
  );
}

async function chapterTxns(s: ChapterSetup, scope?: "central") {
  return await run(s.t, (ctx) =>
    ctx.db
      .query("transactions")
      .withIndex("by_chapter", (q) => q.eq("chapterId", scope ?? s.chapterId))
      .collect(),
  );
}

/** An inbound ACH transfer Transaction object (grounded against the real
 *  Increase API: signed top-level amount, `source.category` naming the ONE
 *  populated sub-object). */
function inboundAchTxn(opts: {
  id: string;
  accountId: string;
  amount: number;
  originator?: string;
  description?: string;
}): Record<string, unknown> {
  return {
    id: opts.id,
    account_id: opts.accountId,
    amount: opts.amount,
    created_at: "2026-07-17T12:00:00Z",
    currency: "USD",
    description: opts.description ?? "ACH CREDIT",
    type: "transaction",
    source: {
      category: "inbound_ach_transfer",
      inbound_ach_transfer: {
        id: "inbound_ach_transfer_" + opts.id,
        amount: Math.abs(opts.amount),
        originator_company_name: opts.originator ?? "RELAY",
      },
    },
  };
}

/** An `ach_transfer_intention` Transaction (an ACH transfer WE — or someone in
 *  the Increase dashboard — initiated; carries the transfer's own id). */
function achIntentionTxn(opts: {
  id: string;
  accountId: string;
  amount: number;
  transferId: string;
}): Record<string, unknown> {
  return {
    id: opts.id,
    account_id: opts.accountId,
    amount: opts.amount,
    created_at: "2026-07-17T12:00:00Z",
    currency: "USD",
    description: "ACH TRANSFER",
    type: "transaction",
    source: {
      category: "ach_transfer_intention",
      ach_transfer_intention: {
        amount: Math.abs(opts.amount),
        transfer_id: opts.transferId,
        statement_descriptor: "Reimburse",
      },
    },
  };
}

/** Mock `GET /transactions/{id}` for the webhook fetch. */
function mockIncreaseFetch(txns: Record<string, Record<string, unknown>>) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    const txMatch = path.match(/\/transactions\/([^/?]+)/);
    if (txMatch && method === "GET") {
      const txn = txns[txMatch[1]];
      if (!txn) return new Response("not found", { status: 404 });
      return new Response(JSON.stringify(txn), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch: ${method} ${path}`);
  }) as unknown as typeof fetch;
}

async function ingestViaWebhook(s: ChapterSetup, transactionId: string) {
  await s.t.action(internal.increase.handleIncreaseWebhook, {
    category: "transaction.created",
    associatedObjectId: transactionId,
  });
}

/** Minimal approved reimbursement (mirrors reimbursementSpend.test.ts). */
async function seedReimbursement(
  s: ChapterSetup,
  amountCents: number,
): Promise<Id<"reimbursementRequests">> {
  const now = Date.now();
  return await run(s.t, (ctx) =>
    ctx.db.insert("reimbursementRequests", {
      chapterId: s.chapterId,
      token: crypto.randomUUID(),
      status: "paying",
      payeeName: "Sarah",
      totalCents: amountCents,
      approvedCents: amountCents,
      submittedAt: now,
      createdAt: now,
      updatedAt: now,
    }),
  );
}

// ── extraction (pure) ────────────────────────────────────────────────────────

describe("extractAccountActivity", () => {
  test("an inbound ACH extracts flow/cents/counterparty/description", () => {
    const out = extractAccountActivity(
      inboundAchTxn({ id: "transaction_1", accountId: "account_x", amount: 100_000 }),
    );
    expect(out).toMatchObject({
      externalId: "transaction_1",
      accountId: "account_x",
      flow: "inflow",
      amountCents: 100_000,
      category: "inbound_ach_transfer",
      counterpartyName: "RELAY",
      description: "ACH CREDIT",
    });
    // extractCardCharge must NOT claim the same object (one lane per row).
    expect(
      extractCardCharge(
        inboundAchTxn({ id: "transaction_1", accountId: "account_x", amount: 100_000 }),
      ),
    ).toBeNull();
  });

  test("an ach_transfer_intention carries its transfer_id (negative amount → outflow)", () => {
    const out = extractAccountActivity(
      achIntentionTxn({
        id: "transaction_2",
        accountId: "account_x",
        amount: -5000,
        transferId: "ach_transfer_abc",
      }),
    );
    expect(out).toMatchObject({
      flow: "outflow",
      amountCents: 5000,
      transferId: "ach_transfer_abc",
    });
  });

  test("card categories, $0 rows, and id-less rows extract to null", () => {
    expect(
      extractAccountActivity({
        id: "transaction_3",
        account_id: "account_x",
        amount: -100,
        source: { category: "card_settlement", card_settlement: {} },
      }),
    ).toBeNull();
    expect(
      extractAccountActivity(
        inboundAchTxn({ id: "transaction_4", accountId: "account_x", amount: 0 }),
      ),
    ).toBeNull();
    expect(
      extractAccountActivity({ amount: 100, source: { category: "wire_transfer" } }),
    ).toBeNull();
  });
});

// ── webhook ingestion + guards ───────────────────────────────────────────────

describe("Increase account-activity ingestion", () => {
  test("an inbound ACH posts ONE increase_ach inflow row, idempotently", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedIncreaseAccount(s, "account_x");

    process.env.INCREASE_API_KEY = "test_key";
    mockIncreaseFetch({
      transaction_relay: inboundAchTxn({
        id: "transaction_relay",
        accountId: "account_x",
        amount: 100_000, // the missing $1,000.00 Relay → Increase leg
      }),
    });

    await ingestViaWebhook(s, "transaction_relay");
    // Redelivered webhook → no second row (dedup on externalId).
    await ingestViaWebhook(s, "transaction_relay");

    const rows = await chapterTxns(s);
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({
      source: "increase_ach",
      flow: "inflow",
      amountCents: 100_000,
      externalId: "transaction_relay",
      sourceAccountId: "account_x",
      merchantName: "RELAY",
      description: "ACH CREDIT",
      status: "unreviewed",
      pending: false,
    });
  });

  test("an entry settling a reimbursement payout is SKIPPED (already booked)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedIncreaseAccount(s, "account_x");
    const reimbursementId = await seedReimbursement(s, 5000);
    await run(s.t, (ctx) =>
      ctx.db.insert("payouts", {
        chapterId: s.chapterId,
        reimbursementId,
        provider: "increase",
        status: "processing",
        amountCents: 5000,
        increaseTransferId: "ach_transfer_payout_1",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );

    process.env.INCREASE_API_KEY = "test_key";
    mockIncreaseFetch({
      transaction_payout: achIntentionTxn({
        id: "transaction_payout",
        accountId: "account_x",
        amount: -5000,
        transferId: "ach_transfer_payout_1",
      }),
    });

    await ingestViaWebhook(s, "transaction_payout");
    expect((await chapterTxns(s)).length).toBe(0);
  });

  test("an entry settling a personal-repayment ACH debit is SKIPPED (already booked)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedIncreaseAccount(s, "account_x");
    // The flagged personal charge + its repayment carrying the debit's ref.
    const person = await run(s.t, (ctx) =>
      ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Holder",
        isTeamMember: true,
        createdAt: Date.now(),
      }),
    );
    const txnId = await run(s.t, (ctx) =>
      ctx.db.insert("transactions", {
        chapterId: s.chapterId,
        source: "increase_card",
        flow: "outflow",
        amountCents: 2500,
        postedAt: Date.now(),
        status: "unreviewed",
        isPersonal: true,
        createdAt: Date.now(),
      }),
    );
    await run(s.t, (ctx) =>
      ctx.db.insert("personalRepayments", {
        chapterId: s.chapterId,
        transactionId: txnId,
        payerPersonId: person,
        amountCents: 2500,
        method: "ach",
        status: "pending",
        increaseRef: "ach_transfer_repay_1",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );

    process.env.INCREASE_API_KEY = "test_key";
    mockIncreaseFetch({
      transaction_repay: achIntentionTxn({
        id: "transaction_repay",
        accountId: "account_x",
        amount: 2500, // a debit PULLS money in → positive on our account
        transferId: "ach_transfer_repay_1",
      }),
    });

    await ingestViaWebhook(s, "transaction_repay");
    // Only the seeded personal charge remains — no new increase_ach row.
    const rows = await chapterTxns(s);
    expect(rows.length).toBe(1);
    expect(rows[0]._id).toBe(txnId);
  });

  test("an entry whose transfer is already a booked transfer leg is SKIPPED", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedIncreaseAccount(s, "account_x");
    // A historical auto-initiated transfer leg, `externalId` stamped with the
    // Increase transfer id (the retired skim/launch-grant/settlement flows).
    await run(s.t, (ctx) =>
      ctx.db.insert("transactions", {
        chapterId: s.chapterId,
        source: "skim",
        flow: "transfer",
        amountCents: 7500,
        postedAt: Date.now(),
        status: "reconciled",
        externalId: "account_transfer_hist_1",
        createdAt: Date.now(),
      }),
    );

    process.env.INCREASE_API_KEY = "test_key";
    mockIncreaseFetch({
      transaction_hist: {
        id: "transaction_hist",
        account_id: "account_x",
        amount: -7500,
        created_at: "2026-07-17T12:00:00Z",
        currency: "USD",
        description: "ACCOUNT TRANSFER",
        type: "transaction",
        source: {
          category: "account_transfer_intention",
          account_transfer_intention: {
            amount: 7500,
            transfer_id: "account_transfer_hist_1",
          },
        },
      },
    });

    await ingestViaWebhook(s, "transaction_hist");
    const rows = await chapterTxns(s);
    expect(rows.length).toBe(1);
    expect(rows[0].source).toBe("skim");
  });

  test("a dashboard-initiated ACH with no matching app record IS ingested", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedIncreaseAccount(s, "account_x");

    process.env.INCREASE_API_KEY = "test_key";
    mockIncreaseFetch({
      transaction_vendor: achIntentionTxn({
        id: "transaction_vendor",
        accountId: "account_x",
        amount: -12_000,
        transferId: "ach_transfer_unknown_9",
      }),
    });

    await ingestViaWebhook(s, "transaction_vendor");
    const rows = await chapterTxns(s);
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({
      source: "increase_ach",
      flow: "outflow",
      amountCents: 12_000,
      status: "unreviewed",
    });
  });

  test("activity on the CENTRAL account posts as a central-owned row", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedIncreaseAccount(s, "account_central", "central");

    process.env.INCREASE_API_KEY = "test_key";
    mockIncreaseFetch({
      transaction_c: inboundAchTxn({
        id: "transaction_c",
        accountId: "account_central",
        amount: 33_300,
      }),
    });

    await ingestViaWebhook(s, "transaction_c");
    const central = await chapterTxns(s, "central");
    expect(central.length).toBe(1);
    expect(central[0].chapterId).toBe("central");
    expect(central[0].source).toBe("increase_ach");
    // Central has no funds — the row stays fund-less for the central desk.
    expect(central[0].fundId).toBeUndefined();
    // Nothing leaked into the chapter's own queue.
    expect((await chapterTxns(s)).length).toBe(0);
  });

  test("an account we don't hold is skipped", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedIncreaseAccount(s, "account_x");

    process.env.INCREASE_API_KEY = "test_key";
    mockIncreaseFetch({
      transaction_other: inboundAchTxn({
        id: "transaction_other",
        accountId: "account_not_ours",
        amount: 100,
      }),
    });

    await ingestViaWebhook(s, "transaction_other");
    expect((await chapterTxns(s)).length).toBe(0);
  });
});
