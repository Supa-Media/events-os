/// <reference types="vite/client" />
import { afterEach, describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

/**
 * Phase-2 finance tests — Stripe Financial Connections read-only legacy sync
 * (`stripeFinance.ts`).
 *
 * Covers the testable DB-apply core (`applyFcTransactions`) without hitting
 * Stripe: fresh insert (correct flow/amount/status/fund), idempotent re-apply
 * (dedup by `externalId`, zero duplicates), a pending→posted update in place,
 * lastSyncedAt stamp; the fetch/paginate path via a mocked `fetch` (two pages,
 * `starting_after` advances, pending→posted catches up on re-sweep); plus
 * tenancy on `listAccounts` / `setAccountFund`, the NOT_CONFIGURED session
 * degrade, and the webhook fan-out (unknown = no-op, known = schedules a sync,
 * disconnected event = marks the account disconnected).
 */

async function seedSelfPerson(s: ChapterSetup): Promise<Id<"people">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Caller",
      userId: s.userId,
      isTeamMember: true,
      createdAt: Date.now(),
    }),
  );
}

async function grantRole(
  s: ChapterSetup,
  personId: Id<"people">,
  role: "viewer" | "bookkeeper" | "manager",
  scope: "chapter" | "central" = "chapter",
): Promise<void> {
  await run(s.t, (ctx) =>
    ctx.db.insert("financeRoles", {
      chapterId: s.chapterId,
      personId,
      role,
      scope,
      createdAt: Date.now(),
    }),
  );
}

/** A manager-graded caller (person + manager grant). */
async function asManager(s: ChapterSetup): Promise<Id<"people">> {
  const personId = await seedSelfPerson(s);
  await grantRole(s, personId, "manager");
  return personId;
}

/** Insert a fund in a chapter (raw, no auth). */
async function seedFund(
  s: ChapterSetup,
  chapterId: Id<"chapters">,
  name = "General",
): Promise<Id<"funds">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("funds", {
      chapterId,
      name,
      restriction: "unrestricted",
      sortOrder: 0,
      isActive: true,
      createdAt: Date.now(),
    }),
  );
}

/** Insert a legacy account in a chapter (raw). */
async function seedAccount(
  s: ChapterSetup,
  chapterId: Id<"chapters">,
  opts: { defaultFundId?: Id<"funds">; stripeFcAccountId?: string } = {},
): Promise<Id<"legacyAccounts">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("legacyAccounts", {
      chapterId,
      stripeFcAccountId: opts.stripeFcAccountId ?? "fca_test_123",
      institutionName: "Test Bank",
      last4: "4242",
      type: "depository",
      defaultFundId: opts.defaultFundId,
      status: "active",
      createdAt: Date.now(),
    }),
  );
}

const BATCH = [
  // A debit (negative) → outflow, and a credit (positive) → inflow.
  { id: "fctxn_1", amountCents: -6420, postedAt: 1_700_000_000_000, description: "Office Depot", pending: false },
  { id: "fctxn_2", amountCents: 25000, postedAt: 1_700_100_000_000, description: "Refund", pending: false },
];

describe("applyFcTransactions (dedup / insert / update)", () => {
  test("a fresh batch inserts stripe_fc transactions with correct flow/amount/status/fund", async () => {
    const s = await setupChapter(newT());
    const fundId = await seedFund(s, s.chapterId);
    const accountId = await seedAccount(s, s.chapterId, { defaultFundId: fundId });

    const res = await s.t.mutation(internal.stripeFinance.applyFcTransactions, {
      legacyAccountId: accountId,
      transactions: BATCH,
    });
    expect(res).toEqual({ inserted: 2, updated: 0 });

    const rows = await run(s.t, (ctx) =>
      ctx.db
        .query("transactions")
        .withIndex("by_chapter", (q) => q.eq("chapterId", s.chapterId))
        .collect(),
    );
    expect(rows).toHaveLength(2);

    const debit = rows.find((r) => r.externalId === "stripe_fc:fctxn_1")!;
    expect(debit.source).toBe("stripe_fc");
    expect(debit.flow).toBe("outflow");
    expect(debit.amountCents).toBe(6420); // non-negative, sign carried by flow
    expect(debit.status).toBe("unreviewed");
    expect(debit.fundId).toBe(fundId);
    expect(debit.sourceAccountId).toBe("fca_test_123");
    expect(debit.merchantName).toBe("Office Depot");
    expect(debit.pending).toBe(false);

    const credit = rows.find((r) => r.externalId === "stripe_fc:fctxn_2")!;
    expect(credit.flow).toBe("inflow");
    expect(credit.amountCents).toBe(25000);
  });

  test("re-applying the SAME batch creates zero duplicates (dedup by externalId)", async () => {
    const s = await setupChapter(newT());
    const fundId = await seedFund(s, s.chapterId);
    const accountId = await seedAccount(s, s.chapterId, { defaultFundId: fundId });

    await s.t.mutation(internal.stripeFinance.applyFcTransactions, {
      legacyAccountId: accountId,
      transactions: BATCH,
    });
    const res2 = await s.t.mutation(internal.stripeFinance.applyFcTransactions, {
      legacyAccountId: accountId,
      transactions: BATCH,
    });
    expect(res2).toEqual({ inserted: 0, updated: 2 });

    const rows = await run(s.t, (ctx) =>
      ctx.db
        .query("transactions")
        .withIndex("by_chapter", (q) => q.eq("chapterId", s.chapterId))
        .collect(),
    );
    expect(rows).toHaveLength(2);
  });

  test("a previously-pending txn is UPDATED in place when it posts (still one row)", async () => {
    const s = await setupChapter(newT());
    const accountId = await seedAccount(s, s.chapterId);

    // First sync: pending authorization.
    await s.t.mutation(internal.stripeFinance.applyFcTransactions, {
      legacyAccountId: accountId,
      transactions: [
        { id: "fctxn_p", amountCents: -1000, postedAt: 1_700_000_000_000, description: "Cafe", pending: true },
      ],
    });
    // Second sync: the same id posts (pending:false), amount + date firmed up.
    const res = await s.t.mutation(internal.stripeFinance.applyFcTransactions, {
      legacyAccountId: accountId,
      transactions: [
        { id: "fctxn_p", amountCents: -1075, postedAt: 1_700_050_000_000, description: "Cafe", pending: false },
      ],
    });
    expect(res).toEqual({ inserted: 0, updated: 1 });

    const rows = await run(s.t, (ctx) =>
      ctx.db
        .query("transactions")
        .withIndex("by_external_id", (q) => q.eq("externalId", "stripe_fc:fctxn_p"))
        .collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].pending).toBe(false);
    expect(rows[0].amountCents).toBe(1075);
    expect(rows[0].postedAt).toBe(1_700_050_000_000);
  });

  test("stamps lastSyncedAt (no persistent walking cursor)", async () => {
    const s = await setupChapter(newT());
    const accountId = await seedAccount(s, s.chapterId);

    await s.t.mutation(internal.stripeFinance.applyFcTransactions, {
      legacyAccountId: accountId,
      transactions: BATCH,
    });
    const account = await run(s.t, (ctx) => ctx.db.get(accountId));
    expect(typeof account?.lastSyncedAt).toBe("number");
    // The incremental mechanism is a newest-first re-sweep, not a stored cursor.
    expect(account?.syncCursor).toBeUndefined();
  });
});

describe("listAccounts / setAccountFund tenancy", () => {
  test("listAccounts returns the caller's chapter accounts in the UI shape", async () => {
    const s = await setupChapter(newT());
    await asManager(s);
    const fundId = await seedFund(s, s.chapterId);
    const accountId = await seedAccount(s, s.chapterId, { defaultFundId: fundId });

    const accounts = await s.as.query(api.stripeFinance.listAccounts, {});
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      id: accountId,
      institutionName: "Test Bank",
      last4: "4242",
      type: "depository",
      status: "active",
      defaultFundId: fundId,
    });
    expect(accounts[0].lastSyncedAt).toBeNull();
  });

  test("setAccountFund rejects a fund from another chapter", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const accountId = await seedAccount(s, s.chapterId);

    // A fund living in a DIFFERENT chapter.
    const other = await setupChapter(t, { email: "other@publicworship.life" });
    const foreignFund = await seedFund(other, other.chapterId, "Foreign");

    await expect(
      s.as.mutation(api.stripeFinance.setAccountFund, {
        legacyAccountId: accountId,
        fundId: foreignFund,
      }),
    ).rejects.toBeInstanceOf(ConvexError);

    // A same-chapter fund is accepted.
    const ownFund = await seedFund(s, s.chapterId);
    await s.as.mutation(api.stripeFinance.setAccountFund, {
      legacyAccountId: accountId,
      fundId: ownFund,
    });
    const account = await run(s.t, (ctx) => ctx.db.get(accountId));
    expect(account?.defaultFundId).toBe(ownFund);
  });

  test("setAccountFund rejects an account from another chapter", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const ownFund = await seedFund(s, s.chapterId);

    const other = await setupChapter(t, { email: "other@publicworship.life" });
    const foreignAccount = await seedAccount(other, other.chapterId, {
      stripeFcAccountId: "fca_other",
    });

    await expect(
      s.as.mutation(api.stripeFinance.setAccountFund, {
        legacyAccountId: foreignAccount,
        fundId: ownFund,
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });
});

describe("createFcSession degrade", () => {
  test("throws NOT_CONFIGURED when STRIPE_SECRET_KEY is unset", async () => {
    const s = await setupChapter(newT());
    await asManager(s);
    // No STRIPE_SECRET_KEY in the test env → NOT_CONFIGURED (after the manager
    // gate passes).
    await expect(
      s.as.action(api.stripeFinance.createFcSession, {}),
    ).rejects.toBeInstanceOf(ConvexError);
  });
});

describe("onFcWebhookEvent fan-out", () => {
  test("an unknown stripe account is a no-op (no throw, nothing scheduled)", async () => {
    const s = await setupChapter(newT());
    await s.t.mutation(internal.stripeFinance.onFcWebhookEvent, {
      stripeAccountId: "fca_unknown",
    });
    const scheduled = await run(s.t, (ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(scheduled).toHaveLength(0);
  });

  test("a known stripe account schedules a sync", async () => {
    const s = await setupChapter(newT());
    await seedAccount(s, s.chapterId, { stripeFcAccountId: "fca_known" });

    await s.t.mutation(internal.stripeFinance.onFcWebhookEvent, {
      stripeAccountId: "fca_known",
    });
    const scheduled = await run(s.t, (ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(scheduled).toHaveLength(1);
  });

  test("a disconnected event marks the account disconnected (no sync scheduled)", async () => {
    const s = await setupChapter(newT());
    const accountId = await seedAccount(s, s.chapterId, {
      stripeFcAccountId: "fca_disc",
    });

    await s.t.mutation(internal.stripeFinance.onFcWebhookEvent, {
      stripeAccountId: "fca_disc",
      eventType: "financial_connections.account.disconnected",
    });

    const account = await run(s.t, (ctx) => ctx.db.get(accountId));
    expect(account?.status).toBe("disconnected");
    const scheduled = await run(s.t, (ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(scheduled).toHaveLength(0);
  });
});

// ── The network fetch / paginate path (mocked global fetch) ──────────────────

/** A Stripe FC transaction object, as the list endpoint returns it. */
function fcObject(
  id: string,
  amount: number,
  status: "pending" | "posted",
  postedAt: number,
): Record<string, unknown> {
  return {
    id,
    amount,
    description: `merchant ${id}`,
    status,
    transacted_at: postedAt - 100,
    status_transitions: status === "posted" ? { posted_at: postedAt } : {},
  };
}

/** A minimal fetch Response stand-in the action consumes (`ok`/`json`/`text`). */
function jsonResponse(body: unknown): unknown {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe("syncTransactions fetch + paginate (mocked fetch)", () => {
  const realFetch = globalThis.fetch;
  const realKey = process.env.STRIPE_SECRET_KEY;

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = realKey;
  });

  test("ingests BOTH pages, sends starting_after on page 2, then catches a pending→posted row", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_mock";
    const s = await setupChapter(newT());
    const accountId = await seedAccount(s, s.chapterId, {
      stripeFcAccountId: "fca_page",
    });

    // Page 1 (newest): a pending row + a posted row, has_more:true.
    // Page 2: one more posted row, has_more:false.
    const page1 = {
      data: [
        fcObject("fctxn_new", -1500, "pending", 1_700_200_000),
        fcObject("fctxn_mid", -2500, "posted", 1_700_100_000),
      ],
      has_more: true,
    };
    const page2 = {
      data: [fcObject("fctxn_old", 9000, "posted", 1_700_000_000)],
      has_more: false,
    };

    const urls: string[] = [];
    let call = 0;
    globalThis.fetch = (async (url: string) => {
      urls.push(String(url));
      return jsonResponse(call++ === 0 ? page1 : page2);
    }) as unknown as typeof fetch;

    const res = await s.t.action(internal.stripeFinance.syncTransactions, {
      legacyAccountId: accountId,
    });
    expect(res).toEqual({ skipped: false, inserted: 3, updated: 0 });

    // (a) BOTH pages ingested — pagination advanced, not the same page twice.
    const rows = await run(s.t, (ctx) =>
      ctx.db
        .query("transactions")
        .withIndex("by_chapter", (q) => q.eq("chapterId", s.chapterId))
        .collect(),
    );
    expect(rows.map((r) => r.externalId).sort()).toEqual([
      "stripe_fc:fctxn_mid",
      "stripe_fc:fctxn_new",
      "stripe_fc:fctxn_old",
    ]);
    // The pending row landed as pending; the posted rows as posted.
    const pendingRow = rows.find((r) => r.externalId === "stripe_fc:fctxn_new")!;
    expect(pendingRow.pending).toBe(true);

    // (b) exactly two requests; the SECOND carried starting_after=<last id of p1>.
    expect(urls).toHaveLength(2);
    expect(urls[0]).not.toContain("starting_after");
    expect(urls[1]).toContain("starting_after=fctxn_mid");
    // And never the wrong param.
    expect(urls[0]).not.toContain("after=fctxn");

    // (c) a follow-up sweep where the pending row has now POSTED updates it in
    //     place — one row, pending:false, still 3 rows total.
    const posted = {
      data: [fcObject("fctxn_new", -1500, "posted", 1_700_250_000)],
      has_more: false,
    };
    globalThis.fetch = (async (url: string) => {
      urls.push(String(url));
      return jsonResponse(posted);
    }) as unknown as typeof fetch;

    const res2 = await s.t.action(internal.stripeFinance.syncTransactions, {
      legacyAccountId: accountId,
    });
    expect(res2).toEqual({ skipped: false, inserted: 0, updated: 1 });

    const after = await run(s.t, (ctx) =>
      ctx.db
        .query("transactions")
        .withIndex("by_chapter", (q) => q.eq("chapterId", s.chapterId))
        .collect(),
    );
    expect(after).toHaveLength(3);
    const nowPosted = after.find((r) => r.externalId === "stripe_fc:fctxn_new")!;
    expect(nowPosted.pending).toBe(false);
    expect(nowPosted.postedAt).toBe(1_700_250_000 * 1000);
  });

  test("skips (no throw) when STRIPE_SECRET_KEY is unset", async () => {
    delete process.env.STRIPE_SECRET_KEY;
    const s = await setupChapter(newT());
    const accountId = await seedAccount(s, s.chapterId, {
      stripeFcAccountId: "fca_nokey",
    });
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return jsonResponse({ data: [], has_more: false });
    }) as unknown as typeof fetch;

    const res = await s.t.action(internal.stripeFinance.syncTransactions, {
      legacyAccountId: accountId,
    });
    expect(res).toEqual({ skipped: true, inserted: 0, updated: 0 });
    expect(called).toBe(false);
  });
});
