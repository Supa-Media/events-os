/// <reference types="vite/client" />
import { afterEach, describe, expect, test } from "vitest";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { internal, api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";

/**
 * Increase card-payment AUTO-PAIRING (founder-approved, 2026-08-13, via Opus
 * analysis): Increase groups a charge's settlement + refund under one Card
 * Payment object (`source.card_payment_id`) — a STRUCTURAL, provider-stated
 * link, not a text heuristic. When a `card_refund` and its `card_settlement`
 * share a `cardPaymentId` and there is EXACTLY one un-refunded settlement
 * candidate, `increaseLedger.ts#applyIncreaseCardTransaction` pairs them the
 * moment the second one lands — running the SAME guards + writes as a human
 * clicking `finances.markAsRefund` (`lib/refundPair.ts`, shared so the two
 * paths can never validate a pair differently).
 *
 * Covers: both arrival orders (settlement-then-refund, refund-then-settlement),
 * ambiguity (two settlement candidates → nobody paired), the PARTIAL_REFUND
 * refusal (amounts differ), the IS_TRANSFER/IS_PAYOUT refusals, the
 * `financeAuditLog` trail (`refund_mark_auto`, no `actorUserId` — no
 * authenticated caller exists in a webhook-triggered ingestion), and that a
 * paired pair drops out of `finances.monthCodingWorklist` (the existing
 * auto-explained machinery from #679/#681 needs zero further work once
 * `refundedByTransactionId`/`refundsTransactionId` are set).
 */

// ── env + fetch snapshot/restore (mirrors tests/increaseCards.test.ts) ──────

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

async function chapterTxns(s: ChapterSetup): Promise<Doc<"transactions">[]> {
  return await run(s.t, (ctx) =>
    ctx.db
      .query("transactions")
      .withIndex("by_chapter", (q) => q.eq("chapterId", s.chapterId))
      .collect(),
  );
}

const auditRowsFor = (s: ChapterSetup, id: Id<"transactions">) =>
  run(s.t, async (ctx) =>
    (await ctx.db.query("financeAuditLog").collect()).filter(
      (e) => e.subjectId === (id as string),
    ),
  );

/** A finance viewer (the floor `monthCodingWorklist` needs for a chapter-owned
 *  book) who can query the console for this chapter. */
async function setupViewer(s: ChapterSetup): Promise<void> {
  const personId = await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Reader",
      userId: s.userId,
      isTeamMember: true,
      createdAt: Date.now(),
    }),
  );
  await run(s.t, (ctx) =>
    ctx.db.insert("financeRoles", {
      chapterId: s.chapterId,
      personId,
      role: "viewer",
      scope: "chapter",
      createdAt: Date.now(),
    }),
  );
}

// ── Increase object builders (grounded against the real API, same shape as
//    tests/increaseCards.test.ts) ────────────────────────────────────────────

function cardSettlementTxn(opts: {
  id: string;
  accountId: string;
  amount: number; // signed minor units (negative = a charge)
  cardPaymentId: string;
  merchantName?: string;
  postedAt?: string;
}): Record<string, unknown> {
  return {
    id: opts.id,
    account_id: opts.accountId,
    amount: opts.amount,
    created_at: opts.postedAt ?? "2026-08-05T12:00:00Z",
    currency: "USD",
    description: opts.merchantName ?? "PURCHASE",
    route_type: "card",
    source: {
      category: "card_settlement",
      card_settlement: {
        id: "card_settlement_" + opts.id,
        amount: Math.abs(opts.amount),
        card_payment_id: opts.cardPaymentId,
        currency: "USD",
        merchant_name: opts.merchantName ?? "Starbucks",
        merchant_category_code: "5814",
      },
    },
    type: "transaction",
  };
}

function cardRefundTxn(opts: {
  id: string;
  accountId: string;
  amount: number; // positive minor units (a credit)
  cardPaymentId: string;
  postedAt?: string;
}): Record<string, unknown> {
  return {
    id: opts.id,
    account_id: opts.accountId,
    amount: opts.amount,
    created_at: opts.postedAt ?? "2026-08-06T12:00:00Z",
    currency: "USD",
    description: "REFUND",
    route_type: "card",
    source: {
      category: "card_refund",
      card_refund: {
        id: "card_refund_" + opts.id,
        amount: Math.abs(opts.amount),
        card_payment_id: opts.cardPaymentId,
        currency: "USD",
        merchant_name: "Starbucks",
        merchant_category_code: "5814",
      },
    },
    type: "transaction",
  };
}

/** Mocks `GET /transactions/{id}` only — no card attribution fetch needed
 *  since no card is seeded in these tests (attribution is orthogonal to
 *  pairing). */
function mockIncreaseFetch(txns: Record<string, Record<string, unknown>>) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    const cpMatch = path.match(/\/card_payments\/([^/?]+)/);
    if (cpMatch) return new Response("not found", { status: 404 });
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
}

// ── (a) settlement then refund ────────────────────────────────────────────

describe("Increase card-payment auto-pairing", () => {
  test("(a) settlement then refund, ingested via webhook → paired both directions, audited", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedIncreaseAccount(s, "account_x");
    process.env.INCREASE_API_KEY = "test_key";

    mockIncreaseFetch({
      settle_a: cardSettlementTxn({
        id: "settle_a",
        accountId: "account_x",
        amount: -6420,
        cardPaymentId: "cp_a",
      }),
    });
    await t.action(internal.increase.handleIncreaseWebhook, {
      category: "transaction.created",
      associatedObjectId: "settle_a",
    });

    // Not paired yet — only one half has landed.
    let rows = await chapterTxns(s);
    expect(rows).toHaveLength(1);
    expect(rows[0].refundedByTransactionId).toBeUndefined();

    mockIncreaseFetch({
      refund_a: cardRefundTxn({
        id: "refund_a",
        accountId: "account_x",
        amount: 6420,
        cardPaymentId: "cp_a",
      }),
    });
    await t.action(internal.increase.handleIncreaseWebhook, {
      category: "transaction.created",
      associatedObjectId: "refund_a",
    });

    rows = await chapterTxns(s);
    expect(rows).toHaveLength(2);
    const settlement = rows.find((r) => r.flow === "outflow")!;
    const refund = rows.find((r) => r.flow === "inflow")!;
    expect(settlement.refundedByTransactionId).toBe(refund._id);
    expect(refund.refundsTransactionId).toBe(settlement._id);
    expect(settlement.cardPaymentId).toBe("cp_a");
    expect(refund.cardPaymentId).toBe("cp_a");
    expect(settlement.sourceCategory).toBe("card_settlement");
    expect(refund.sourceCategory).toBe("card_refund");

    // Both legs logged, distinguishably automatic, no human actor.
    for (const leg of [settlement, refund]) {
      const audits = await auditRowsFor(s, leg._id);
      const pairAudit = audits.find((a) => a.action === "refund_mark_auto");
      expect(pairAudit).toBeDefined();
      expect(pairAudit!.actorUserId).toBeUndefined();
      expect(pairAudit!.actorPersonId).toBeUndefined();
    }
  });

  // ── (b) refund first, settlement second ────────────────────────────────

  test("(b) refund arrives FIRST, settlement second → still pairs", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedIncreaseAccount(s, "account_x");
    process.env.INCREASE_API_KEY = "test_key";

    mockIncreaseFetch({
      refund_b: cardRefundTxn({
        id: "refund_b",
        accountId: "account_x",
        amount: 3000,
        cardPaymentId: "cp_b",
      }),
    });
    await t.action(internal.increase.handleIncreaseWebhook, {
      category: "transaction.created",
      associatedObjectId: "refund_b",
    });

    let rows = await chapterTxns(s);
    expect(rows).toHaveLength(1);
    expect(rows[0].refundsTransactionId).toBeUndefined();

    mockIncreaseFetch({
      settle_b: cardSettlementTxn({
        id: "settle_b",
        accountId: "account_x",
        amount: -3000,
        cardPaymentId: "cp_b",
      }),
    });
    await t.action(internal.increase.handleIncreaseWebhook, {
      category: "transaction.created",
      associatedObjectId: "settle_b",
    });

    rows = await chapterTxns(s);
    expect(rows).toHaveLength(2);
    const settlement = rows.find((r) => r.flow === "outflow")!;
    const refund = rows.find((r) => r.flow === "inflow")!;
    expect(settlement.refundedByTransactionId).toBe(refund._id);
    expect(refund.refundsTransactionId).toBe(settlement._id);
  });

  // ── (c) ambiguous: two settlement candidates ───────────────────────────

  test("(c) two same-amount settlements under one cardPaymentId → NOT paired (ambiguous)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedIncreaseAccount(s, "account_x");

    await t.mutation(internal.increaseLedger.applyIncreaseCardTransaction, {
      externalId: "settle_c1",
      accountId: "account_x",
      flow: "outflow",
      amountCents: 5000,
      postedAt: Date.now(),
      sourceCategory: "card_settlement",
      cardPaymentId: "cp_c",
    });
    await t.mutation(internal.increaseLedger.applyIncreaseCardTransaction, {
      externalId: "settle_c2",
      accountId: "account_x",
      flow: "outflow",
      amountCents: 5000,
      postedAt: Date.now(),
      sourceCategory: "card_settlement",
      cardPaymentId: "cp_c",
    });
    await t.mutation(internal.increaseLedger.applyIncreaseCardTransaction, {
      externalId: "refund_c",
      accountId: "account_x",
      flow: "inflow",
      amountCents: 5000,
      postedAt: Date.now(),
      sourceCategory: "card_refund",
      cardPaymentId: "cp_c",
    });

    const rows = await chapterTxns(s);
    expect(rows).toHaveLength(3);
    // Fields are stored on every row regardless, but nothing paired.
    for (const r of rows) {
      expect(r.cardPaymentId).toBe("cp_c");
      expect(r.refundedByTransactionId).toBeUndefined();
      expect(r.refundsTransactionId).toBeUndefined();
    }
  });

  // ── (d) partial refund ─────────────────────────────────────────────────

  test("(d) a partial refund (different amount) → NOT paired", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedIncreaseAccount(s, "account_x");

    const settleId = "settle_d";
    await t.mutation(internal.increaseLedger.applyIncreaseCardTransaction, {
      externalId: settleId,
      accountId: "account_x",
      flow: "outflow",
      amountCents: 10_000,
      postedAt: Date.now(),
      sourceCategory: "card_settlement",
      cardPaymentId: "cp_d",
    });
    await t.mutation(internal.increaseLedger.applyIncreaseCardTransaction, {
      externalId: "refund_d",
      accountId: "account_x",
      flow: "inflow",
      amountCents: 4_000, // partial
      postedAt: Date.now(),
      sourceCategory: "card_refund",
      cardPaymentId: "cp_d",
    });

    const rows = await chapterTxns(s);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.refundedByTransactionId == null)).toBe(true);
    expect(rows.every((r) => r.refundsTransactionId == null)).toBe(true);
  });

  // ── (e) guard refusals: transfer leg / payout mark ─────────────────────

  test("(e1) a settlement already marked as a transfer leg → NOT paired", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedIncreaseAccount(s, "account_x");

    // Seed the settlement directly as an already-marked transfer leg sharing
    // a cardPaymentId — a data situation the real world can produce (a
    // bookkeeper marked it before the refund ever landed).
    await run(s.t, (ctx) =>
      ctx.db.insert("transactions", {
        chapterId: s.chapterId,
        source: "increase_card",
        flow: "transfer",
        amountCents: 2_500,
        postedAt: Date.now(),
        cardPaymentId: "cp_e1",
        sourceCategory: "card_settlement",
        transferGroupId: "tg_1",
        preMarkFlow: "outflow",
        status: "reconciled",
        createdAt: Date.now(),
      }),
    );

    await t.mutation(internal.increaseLedger.applyIncreaseCardTransaction, {
      externalId: "refund_e1",
      accountId: "account_x",
      flow: "inflow",
      amountCents: 2_500,
      postedAt: Date.now(),
      sourceCategory: "card_refund",
      cardPaymentId: "cp_e1",
    });

    const refund = await run(s.t, (ctx) =>
      ctx.db
        .query("transactions")
        .withIndex("by_external_id", (q) => q.eq("externalId", "refund_e1"))
        .first(),
    );
    expect(refund!.refundsTransactionId).toBeUndefined();
  });

  test("(e2) a settlement matched to a processor payout → NOT paired", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedIncreaseAccount(s, "account_x");

    await run(s.t, (ctx) =>
      ctx.db.insert("transactions", {
        chapterId: s.chapterId,
        source: "increase_card",
        flow: "outflow",
        amountCents: 1_800,
        postedAt: Date.now(),
        cardPaymentId: "cp_e2",
        sourceCategory: "card_settlement",
        payoutProcessor: "stripe",
        status: "reconciled",
        createdAt: Date.now(),
      }),
    );

    await t.mutation(internal.increaseLedger.applyIncreaseCardTransaction, {
      externalId: "refund_e2",
      accountId: "account_x",
      flow: "inflow",
      amountCents: 1_800,
      postedAt: Date.now(),
      sourceCategory: "card_refund",
      cardPaymentId: "cp_e2",
    });

    const refund = await run(s.t, (ctx) =>
      ctx.db
        .query("transactions")
        .withIndex("by_external_id", (q) => q.eq("externalId", "refund_e2"))
        .first(),
    );
    expect(refund!.refundsTransactionId).toBeUndefined();
  });

  // ── (f) an auto-paired pair drops out of the coding worklist ───────────

  test("(f) an auto-paired pair leaves finances.monthCodingWorklist", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await setupViewer(s);
    await seedIncreaseAccount(s, "account_x");

    // An unrelated, still-uncoded charge stays on the worklist as a control.
    await run(s.t, (ctx) =>
      ctx.db.insert("transactions", {
        chapterId: s.chapterId,
        source: "manual",
        flow: "outflow",
        amountCents: 1_200,
        postedAt: Date.UTC(2026, 7, 10, 16),
        merchantName: "Office Depot",
        status: "reconciled",
        createdAt: Date.now(),
      }),
    );

    const postedAt = Date.UTC(2026, 7, 12, 16);
    await t.mutation(internal.increaseLedger.applyIncreaseCardTransaction, {
      externalId: "settle_f",
      accountId: "account_x",
      flow: "outflow",
      amountCents: 9_900,
      postedAt,
      sourceCategory: "card_settlement",
      cardPaymentId: "cp_f",
      merchantName: "Peerspace",
    });
    await t.mutation(internal.increaseLedger.applyIncreaseCardTransaction, {
      externalId: "refund_f",
      accountId: "account_x",
      flow: "inflow",
      amountCents: 9_900,
      postedAt,
      sourceCategory: "card_refund",
      cardPaymentId: "cp_f",
      merchantName: "Peerspace",
    });

    const rows = await chapterTxns(s);
    const settlement = rows.find((r) => r.externalId === "settle_f")!;
    expect(settlement.refundedByTransactionId).toBeDefined();

    const list = (await s.as.query(api.finances.monthCodingWorklist, {
      periodKey: "2026-08",
    }))!;
    expect(list).not.toBeNull();
    // Only the unrelated Office Depot charge remains — both auto-paired legs
    // are excluded (`autoExplainedKind` reads `refundedByTransactionId` /
    // `refundsTransactionId` directly, no further work needed).
    expect(list.rows.map((r) => r.merchantName)).toEqual(["Office Depot"]);
    expect(list.totalCount).toBe(1);
  });
});
