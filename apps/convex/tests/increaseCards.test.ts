import { afterEach, describe, expect, test } from "vitest";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

/**
 * Increase CARD-charge ingestion tests (settled `transaction.created` events →
 * the `transactions` ledger):
 *  - a settled card_settlement webhook, end-to-end (mocked object fetch), inserts
 *    ONE `increase_card` transaction with the right flow/cents/merchant/cardLast4/
 *    cardId/personId/externalId/chapterId,
 *  - a card_refund posts as `inflow`,
 *  - a redelivered/duplicate webhook does NOT create a second row (dedup on
 *    `externalId` via `by_external_id`),
 *  - a card whose `card_id` matches no local card still records the txn with a
 *    null card/person (never throws),
 *  - a transaction for an account we don't own is skipped,
 *  - a non-card transaction (e.g. an inbound ACH) is skipped,
 *  - the ops backfill pages a full history and dedups.
 *
 * The real Increase API is grounded here: the webhook Event carries no inline
 * object, so the handler FETCHES `GET /transactions/{id}`; a card settlement's
 * `card_id` is NOT on the settlement object — it lives on the Card Payment, so
 * attribution FETCHES `GET /card_payments/{card_payment_id}`. Amounts are signed
 * minor units on the top-level Transaction (negative = a charge/outflow).
 */

// ── env + fetch snapshot/restore ─────────────────────────────────────────────

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

// ── seed helpers ─────────────────────────────────────────────────────────────

async function seedIncreaseAccount(
  s: ChapterSetup,
  increaseAccountId: string,
): Promise<void> {
  const now = Date.now();
  await run(s.t, (ctx) =>
    ctx.db.insert("increaseAccounts", {
      chapterId: s.chapterId,
      sandbox: increaseAccountId.startsWith("sandbox_"),
      onboardingStatus: "active",
      increaseEntityId: "entity_shared_org",
      increaseAccountId,
      createdAt: now,
      updatedAt: now,
    }),
  );
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
  opts: { increaseCardId: string; last4: string; holder: Id<"people"> },
): Promise<Id<"cards">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("cards", {
      chapterId: s.chapterId,
      cardholderPersonId: opts.holder,
      type: "virtual",
      status: "active",
      source: "increase",
      increaseCardId: opts.increaseCardId,
      last4: opts.last4,
      createdAt: Date.now(),
    }),
  );
}

async function increaseTxns(s: ChapterSetup) {
  return await run(s.t, (ctx) =>
    ctx.db
      .query("transactions")
      .withIndex("by_chapter", (q) => q.eq("chapterId", s.chapterId))
      .collect(),
  );
}

// ── Increase object builders (grounded against the real API) ─────────────────

function cardSettlementTxn(
  opts: {
    id: string;
    accountId: string;
    amount: number; // signed minor units (negative = a charge)
    cardPaymentId?: string;
    merchantName?: string;
    mcc?: string;
  },
): Record<string, unknown> {
  return {
    id: opts.id,
    account_id: opts.accountId,
    amount: opts.amount,
    created_at: "2026-07-15T12:00:00Z",
    currency: "USD",
    description: opts.merchantName ?? "PURCHASE",
    route_type: "card",
    source: {
      category: "card_settlement",
      card_settlement: {
        id: "card_settlement_" + opts.id,
        amount: Math.abs(opts.amount),
        card_payment_id: opts.cardPaymentId ?? "card_payment_1",
        currency: "USD",
        merchant_name: opts.merchantName ?? "Starbucks",
        merchant_category_code: opts.mcc ?? "5814",
        merchant_city: "New York",
        merchant_state: "NY",
      },
    },
    type: "transaction",
  };
}

function cardRefundTxn(opts: {
  id: string;
  accountId: string;
  amount: number; // positive minor units (a credit)
  cardPaymentId?: string;
}): Record<string, unknown> {
  return {
    id: opts.id,
    account_id: opts.accountId,
    amount: opts.amount,
    created_at: "2026-07-15T12:00:00Z",
    currency: "USD",
    description: "REFUND",
    route_type: "card",
    source: {
      category: "card_refund",
      card_refund: {
        id: "card_refund_" + opts.id,
        amount: Math.abs(opts.amount),
        card_payment_id: opts.cardPaymentId ?? "card_payment_1",
        currency: "USD",
        merchant_name: "Starbucks",
        merchant_category_code: "5814",
      },
    },
    type: "transaction",
  };
}

/**
 * Mock `GET /transactions/{id}` + `GET /card_payments/{id}`. `txns` maps a txn
 * id → the Transaction object; `payments` maps a card_payment id → its `card_id`
 * (or null to 404 the payment). Records each call.
 */
function mockIncreaseFetch(
  txns: Record<string, Record<string, unknown>>,
  payments: Record<string, string | null> = { card_payment_1: null },
) {
  const calls: Array<{ path: string; method: string }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    calls.push({ path, method });

    // GET /card_payments/{id}
    const cpMatch = path.match(/\/card_payments\/([^/?]+)/);
    if (cpMatch) {
      const cardId = payments[cpMatch[1]];
      if (cardId === undefined || cardId === null) {
        return new Response("not found", { status: 404 });
      }
      return new Response(
        JSON.stringify({ id: cpMatch[1], account_id: "account_x", card_id: cardId }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // GET /transactions/{id}
    const txMatch = path.match(/\/transactions\/([^/?]+)/);
    if (txMatch) {
      const txn = txns[txMatch[1]];
      if (!txn) return new Response("not found", { status: 404 });
      return new Response(JSON.stringify(txn), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    throw new Error(`unexpected fetch: ${method} ${path}`);
  }) as unknown as typeof fetch;
  return calls;
}

// ── card-settlement webhook, end-to-end ──────────────────────────────────────

describe("Increase card ingestion — transaction.created webhook", () => {
  test("a settled card_settlement inserts one increase_card outflow, fully attributed", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedIncreaseAccount(s, "account_x");
    const holder = await seedPerson(s, "Seyi");
    const cardId = await seedCard(s, {
      increaseCardId: "card_1",
      last4: "4242",
      holder,
    });

    process.env.INCREASE_API_KEY = "test_key";
    mockIncreaseFetch(
      { transaction_1: cardSettlementTxn({ id: "transaction_1", accountId: "account_x", amount: -6420, merchantName: "Starbucks", mcc: "5814" }) },
      { card_payment_1: "card_1" },
    );

    await t.action(internal.increase.handleIncreaseWebhook, {
      category: "transaction.created",
      associatedObjectId: "transaction_1",
    });

    const txns = await increaseTxns(s);
    expect(txns.length).toBe(1);
    const txn = txns[0];
    expect(txn.source).toBe("increase_card");
    expect(txn.flow).toBe("outflow");
    expect(txn.amountCents).toBe(6420);
    expect(txn.merchantName).toBe("Starbucks");
    expect(txn.merchantCategory).toBe("5814");
    expect(txn.cardLast4).toBe("4242");
    expect(txn.cardId).toBe(cardId);
    expect(txn.personId).toBe(holder);
    expect(txn.externalId).toBe("transaction_1");
    expect(txn.sourceAccountId).toBe("account_x");
    expect(txn.chapterId).toBe(s.chapterId);
    expect(txn.status).toBe("unreviewed");
    expect(txn.pending).toBe(false);
    expect(txn.postedAt).toBe(Date.parse("2026-07-15T12:00:00Z"));
  });

  test("a card_refund posts as an inflow", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedIncreaseAccount(s, "account_x");
    const holder = await seedPerson(s, "Seyi");
    await seedCard(s, { increaseCardId: "card_1", last4: "4242", holder });

    process.env.INCREASE_API_KEY = "test_key";
    mockIncreaseFetch(
      { transaction_2: cardRefundTxn({ id: "transaction_2", accountId: "account_x", amount: 1000 }) },
      { card_payment_1: "card_1" },
    );

    await t.action(internal.increase.handleIncreaseWebhook, {
      category: "transaction.created",
      associatedObjectId: "transaction_2",
    });

    const txns = await increaseTxns(s);
    expect(txns.length).toBe(1);
    expect(txns[0].flow).toBe("inflow");
    expect(txns[0].amountCents).toBe(1000);
    expect(txns[0].source).toBe("increase_card");
  });

  test("a redelivered webhook does NOT create a second row (idempotent)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedIncreaseAccount(s, "account_x");
    const holder = await seedPerson(s, "Seyi");
    await seedCard(s, { increaseCardId: "card_1", last4: "4242", holder });

    process.env.INCREASE_API_KEY = "test_key";
    mockIncreaseFetch(
      { transaction_1: cardSettlementTxn({ id: "transaction_1", accountId: "account_x", amount: -6420 }) },
      { card_payment_1: "card_1" },
    );

    await t.action(internal.increase.handleIncreaseWebhook, {
      category: "transaction.created",
      associatedObjectId: "transaction_1",
    });
    await t.action(internal.increase.handleIncreaseWebhook, {
      category: "transaction.created",
      associatedObjectId: "transaction_1",
    });

    expect((await increaseTxns(s)).length).toBe(1);
  });

  test("a card_id with no matching local card still records the txn (null card/person, no throw)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedIncreaseAccount(s, "account_x");
    // No card seeded for `card_ghost`.

    process.env.INCREASE_API_KEY = "test_key";
    mockIncreaseFetch(
      { transaction_3: cardSettlementTxn({ id: "transaction_3", accountId: "account_x", amount: -500 }) },
      { card_payment_1: "card_ghost" },
    );

    await expect(
      t.action(internal.increase.handleIncreaseWebhook, {
        category: "transaction.created",
        associatedObjectId: "transaction_3",
      }),
    ).resolves.toBeNull();

    const txns = await increaseTxns(s);
    expect(txns.length).toBe(1);
    expect(txns[0].amountCents).toBe(500);
    expect(txns[0].cardId).toBeUndefined();
    expect(txns[0].personId).toBeUndefined();
    expect(txns[0].cardLast4).toBeUndefined();
  });

  test("a missing card payment (404) still records the txn with null attribution", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedIncreaseAccount(s, "account_x");

    process.env.INCREASE_API_KEY = "test_key";
    // card_payment_1 → null → the mock 404s the card-payment fetch.
    mockIncreaseFetch(
      { transaction_4: cardSettlementTxn({ id: "transaction_4", accountId: "account_x", amount: -750 }) },
      { card_payment_1: null },
    );

    await t.action(internal.increase.handleIncreaseWebhook, {
      category: "transaction.created",
      associatedObjectId: "transaction_4",
    });

    const txns = await increaseTxns(s);
    expect(txns.length).toBe(1);
    expect(txns[0].amountCents).toBe(750);
    expect(txns[0].cardId).toBeUndefined();
  });

  test("a transaction for an account we don't own is skipped", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedIncreaseAccount(s, "account_x");

    process.env.INCREASE_API_KEY = "test_key";
    mockIncreaseFetch({
      transaction_5: cardSettlementTxn({ id: "transaction_5", accountId: "account_SOMEONE_ELSE", amount: -100 }),
    });

    await t.action(internal.increase.handleIncreaseWebhook, {
      category: "transaction.created",
      associatedObjectId: "transaction_5",
    });

    expect((await increaseTxns(s)).length).toBe(0);
  });

  test("a non-card transaction (inbound ACH) is skipped", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedIncreaseAccount(s, "account_x");

    process.env.INCREASE_API_KEY = "test_key";
    mockIncreaseFetch({
      transaction_6: {
        id: "transaction_6",
        account_id: "account_x",
        amount: 5000,
        created_at: "2026-07-15T12:00:00Z",
        currency: "USD",
        description: "ACH CREDIT",
        source: { category: "inbound_ach_transfer", inbound_ach_transfer: { amount: 5000 } },
        type: "transaction",
      },
    });

    await t.action(internal.increase.handleIncreaseWebhook, {
      category: "transaction.created",
      associatedObjectId: "transaction_6",
    });

    expect((await increaseTxns(s)).length).toBe(0);
  });

  test("degrades to a no-op when the environment's API key is unset", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedIncreaseAccount(s, "account_x");

    delete process.env.INCREASE_API_KEY;
    globalThis.fetch = (() => {
      throw new Error("fetch must not be called when the API key is unset");
    }) as unknown as typeof fetch;

    await expect(
      t.action(internal.increase.handleIncreaseWebhook, {
        category: "transaction.created",
        associatedObjectId: "transaction_1",
      }),
    ).resolves.toBeNull();
    expect((await increaseTxns(s)).length).toBe(0);
  });
});

// ── ops backfill ─────────────────────────────────────────────────────────────

describe("backfillIncreaseCardTransactions", () => {
  test("pages a full history for the chapter's account and dedups", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedIncreaseAccount(s, "account_x");
    const holder = await seedPerson(s, "Seyi");
    const cardId = await seedCard(s, {
      increaseCardId: "card_1",
      last4: "4242",
      holder,
    });

    process.env.INCREASE_API_KEY = "test_key";

    // Two pages of list results (page 1 has next_cursor, page 2 ends it), one
    // card charge + one non-card row that must be skipped, plus the per-txn
    // card-payment fetch for attribution.
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? "GET";
      const cpMatch = path.match(/\/card_payments\/([^/?]+)/);
      if (cpMatch) {
        return new Response(
          JSON.stringify({ id: cpMatch[1], account_id: "account_x", card_id: "card_1" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      // List: GET /transactions?account_id=...&cursor=...
      if (path.includes("/transactions") && method === "GET") {
        const url = new URL(path);
        const cursor = url.searchParams.get("cursor");
        if (!cursor) {
          return new Response(
            JSON.stringify({
              data: [
                cardSettlementTxn({ id: "transaction_a", accountId: "account_x", amount: -1000 }),
                { id: "transaction_ach", account_id: "account_x", amount: 200, created_at: "2026-07-15T12:00:00Z", currency: "USD", description: "ACH", source: { category: "inbound_ach_transfer" }, type: "transaction" },
              ],
              next_cursor: "CURSOR_2",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({
            data: [cardSettlementTxn({ id: "transaction_b", accountId: "account_x", amount: -2000 })],
            next_cursor: null,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`unexpected fetch: ${method} ${path}`);
    }) as unknown as typeof fetch;

    const result = await t.action(
      internal.increase.backfillIncreaseCardTransactions,
      {},
    );
    expect(result.inserted).toBe(2); // the two card charges, not the ACH row

    const txns = await increaseTxns(s);
    expect(txns.length).toBe(2);
    expect(txns.every((tx) => tx.source === "increase_card")).toBe(true);
    expect(txns.every((tx) => tx.cardId === cardId)).toBe(true);

    // Re-running dedups (no new rows).
    const again = await t.action(
      internal.increase.backfillIncreaseCardTransactions,
      {},
    );
    expect(again.inserted).toBe(0);
    expect((await increaseTxns(s)).length).toBe(2);
  });
});
