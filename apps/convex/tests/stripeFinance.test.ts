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

/** Insert a legacy account in a chapter (raw). By default the account is
 *  already backfilled (`backfilledAt` set) so tests exercise the incremental
 *  path unless they explicitly opt into the first-connect backfill. */
async function seedAccount(
  s: ChapterSetup,
  chapterId: Id<"chapters">,
  opts: {
    defaultFundId?: Id<"funds">;
    stripeFcAccountId?: string;
    /** Pass `false` to leave `backfilledAt` unset (first-connect backfill). */
    backfilled?: boolean;
  } = {},
): Promise<Id<"legacyAccounts">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("legacyAccounts", {
      chapterId,
      stripeFcAccountId: opts.stripeFcAccountId ?? "fca_test_123",
      institutionName: "Test Bank",
      last4: "4242",
      type: "depository",
      defaultFundId: opts.defaultFundId,
      backfilledAt: opts.backfilled === false ? undefined : Date.now(),
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

describe("createFcSession provisions + caches a Stripe customer", () => {
  const realFetch = globalThis.fetch;
  const realKey = process.env.STRIPE_SECRET_KEY;
  const realPub = process.env.EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY;

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = realKey;
    if (realPub === undefined) delete process.env.EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY;
    else process.env.EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY = realPub;
  });

  test("sends account_holder[customer] + read-only permissions, returns publishableKey, and reuses the cached customer on the 2nd call", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_mock";
    process.env.EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY = "pk_test_mock";
    const s = await setupChapter(newT());
    await asManager(s);

    const bodies: string[] = [];
    let customerCalls = 0;
    globalThis.fetch = (async (url: string, init?: { body?: string }) => {
      const u = String(url);
      bodies.push(String(init?.body ?? ""));
      if (u.includes("/customers")) {
        customerCalls++;
        return jsonResponse({ id: "cus_test_1" });
      }
      // financial_connections/sessions
      return jsonResponse({ client_secret: "fcsess_secret_123" });
    }) as unknown as typeof fetch;

    const first = await s.as.action(api.stripeFinance.createFcSession, {});
    expect(first).toEqual({
      clientSecret: "fcsess_secret_123",
      publishableKey: "pk_test_mock",
    });

    // The FC session POST carried a `customer` account_holder + read-only perms.
    const sessionBody = decodeURIComponent(bodies[bodies.length - 1]);
    expect(sessionBody).toContain("account_holder[type]=customer");
    expect(sessionBody).toContain("account_holder[customer]=cus_test_1");
    expect(sessionBody).toContain("permissions[0]=transactions");
    expect(sessionBody).toContain("permissions[1]=balances");

    // Exactly one Stripe customer was created + cached.
    expect(customerCalls).toBe(1);
    const cached = await run(s.t, (ctx) =>
      ctx.db.query("financeStripeCustomers").collect(),
    );
    expect(cached).toHaveLength(1);
    expect(cached[0].stripeCustomerId).toBe("cus_test_1");

    // Second call reuses the cached customer — no second POST /customers, still
    // one cached row.
    const second = await s.as.action(api.stripeFinance.createFcSession, {});
    expect(second.clientSecret).toBe("fcsess_secret_123");
    expect(customerCalls).toBe(1);
    const cached2 = await run(s.t, (ctx) =>
      ctx.db.query("financeStripeCustomers").collect(),
    );
    expect(cached2).toHaveLength(1);
  });

  test("returns publishableKey:null when EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY is unset", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_mock";
    delete process.env.EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY;
    const s = await setupChapter(newT());
    await asManager(s);

    globalThis.fetch = (async (url: string) =>
      String(url).includes("/customers")
        ? jsonResponse({ id: "cus_test_2" })
        : jsonResponse({
            client_secret: "fcsess_secret_456",
          })) as unknown as typeof fetch;

    const res = await s.as.action(api.stripeFinance.createFcSession, {});
    expect(res).toEqual({
      clientSecret: "fcsess_secret_456",
      publishableKey: null,
    });
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

  test("a refreshed_transactions event re-syncs the account", async () => {
    // When Stripe finishes its async transaction fetch it fires this event; the
    // fan-out must schedule a sync so the freshly-pulled rows land.
    const s = await setupChapter(newT());
    await seedAccount(s, s.chapterId, { stripeFcAccountId: "fca_refreshed" });

    await s.t.mutation(internal.stripeFinance.onFcWebhookEvent, {
      stripeAccountId: "fca_refreshed",
      eventType: "financial_connections.account.refreshed_transactions",
    });
    const scheduled = await run(s.t, (ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].name).toContain("syncTransactions");
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

// ── First-connect FULL-HISTORY backfill (paginate until has_more:false) ───────

describe("syncTransactions first-connect backfill", () => {
  const realFetch = globalThis.fetch;
  const realKey = process.env.STRIPE_SECRET_KEY;

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = realKey;
  });

  /** A history longer than one invocation's page cap (MAX_SYNC_PAGES = 50):
   *  each fetch returns ONE txn with a unique id and `has_more` true until the
   *  very last page — so one invocation drains 50 pages (cap) and a second
   *  drains the remaining 10, mirroring the self-rescheduling drain. */
  function serveHistory(totalPages: number, seenUrls: string[]): number[] {
    const callCounter = [0];
    globalThis.fetch = (async (url: string) => {
      seenUrls.push(String(url));
      const n = callCounter[0]++;
      return jsonResponse({
        data: [fcObject(`bf_${n}`, -100 * (n + 1), "posted", 1_700_000_000 + n)],
        has_more: n < totalPages - 1,
      });
    }) as unknown as typeof fetch;
    return callCounter;
  }

  test("pages the ENTIRE history across multiple invocations, then stamps backfilledAt + clears syncCursor", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_mock";
    const s = await setupChapter(newT());
    // backfilled:false → the account starts in first-connect backfill mode.
    const accountId = await seedAccount(s, s.chapterId, {
      stripeFcAccountId: "fca_backfill",
      backfilled: false,
    });

    const urls: string[] = [];
    serveHistory(60, urls); // 60 pages of 1 txn each → 50 + 10 across two runs.

    // Invocation 1: drains the per-run page cap (50), sees more remaining, saves
    // a resume cursor, and schedules itself to continue.
    const res1 = await s.t.action(internal.stripeFinance.syncTransactions, {
      legacyAccountId: accountId,
    });
    expect(res1).toEqual({ skipped: false, inserted: 50, updated: 0 });

    const mid = await run(s.t, (ctx) => ctx.db.get(accountId));
    expect(mid?.backfilledAt).toBeUndefined(); // NOT done yet
    expect(mid?.syncCursor).toBe("bf_49"); // resume point persisted

    // A continuation sync was scheduled to keep draining.
    const scheduled = await run(s.t, (ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].name).toContain("syncTransactions");

    // Invocation 2 (what the scheduler would run): resumes from the cursor and
    // reaches the end of history.
    const res2 = await s.t.action(internal.stripeFinance.syncTransactions, {
      legacyAccountId: accountId,
    });
    expect(res2).toEqual({ skipped: false, inserted: 10, updated: 0 });

    // The whole 60-txn history landed exactly once.
    const rows = await run(s.t, (ctx) =>
      ctx.db
        .query("transactions")
        .withIndex("by_chapter", (q) => q.eq("chapterId", s.chapterId))
        .collect(),
    );
    expect(rows).toHaveLength(60);

    const done = await run(s.t, (ctx) => ctx.db.get(accountId));
    expect(typeof done?.backfilledAt).toBe("number"); // backfill complete
    expect(done?.syncCursor).toBeUndefined(); // cursor cleared

    // The resumed invocation forwarded the cursor as starting_after.
    expect(urls.some((u) => u.includes("starting_after=bf_49"))).toBe(true);
  });

  test("re-running the backfill is idempotent — dedup on externalId, no doubles", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_mock";
    const s = await setupChapter(newT());
    const accountId = await seedAccount(s, s.chapterId, {
      stripeFcAccountId: "fca_idem",
      backfilled: false,
    });

    // A short history that completes in a single invocation.
    const urls: string[] = [];
    serveHistory(3, urls);
    const first = await s.t.action(internal.stripeFinance.syncTransactions, {
      legacyAccountId: accountId,
    });
    expect(first).toEqual({ skipped: false, inserted: 3, updated: 0 });
    const afterFirst = await run(s.t, (ctx) => ctx.db.get(accountId));
    expect(typeof afterFirst?.backfilledAt).toBe("number");

    // Force the backfill to run AGAIN over the same history (clear the flag) —
    // dedup must absorb every row: zero new inserts, three updates, still 3 rows.
    await run(s.t, (ctx) =>
      ctx.db.patch(accountId, { backfilledAt: undefined }),
    );
    const urls2: string[] = [];
    serveHistory(3, urls2);
    const second = await s.t.action(internal.stripeFinance.syncTransactions, {
      legacyAccountId: accountId,
    });
    expect(second).toEqual({ skipped: false, inserted: 0, updated: 3 });

    const rows = await run(s.t, (ctx) =>
      ctx.db
        .query("transactions")
        .withIndex("by_chapter", (q) => q.eq("chapterId", s.chapterId))
        .collect(),
    );
    expect(rows).toHaveLength(3);
  });

  test("after backfill completes, a subsequent sync runs the incremental re-sweep (no re-backfill, cursor stays undefined)", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_mock";
    const s = await setupChapter(newT());
    // Already backfilled → incremental path.
    const accountId = await seedAccount(s, s.chapterId, {
      stripeFcAccountId: "fca_incr",
    });
    const before = await run(s.t, (ctx) => ctx.db.get(accountId));
    const backfilledAtBefore = before?.backfilledAt;
    expect(typeof backfilledAtBefore).toBe("number");

    // A single-page re-sweep with one new row.
    globalThis.fetch = (async () =>
      jsonResponse({
        data: [fcObject("incr_1", -4200, "posted", 1_700_300_000)],
        has_more: false,
      })) as unknown as typeof fetch;

    const res = await s.t.action(internal.stripeFinance.syncTransactions, {
      legacyAccountId: accountId,
    });
    expect(res).toEqual({ skipped: false, inserted: 1, updated: 0 });

    const after = await run(s.t, (ctx) => ctx.db.get(accountId));
    // Incremental mode keeps no cursor and doesn't re-stamp backfilledAt.
    expect(after?.syncCursor).toBeUndefined();
    expect(after?.backfilledAt).toBe(backfilledAtBefore);

    // No continuation was scheduled (incremental never chains).
    const scheduled = await run(s.t, (ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(scheduled).toHaveLength(0);
  });

  test("an empty-history account completes backfill in one run (backfilledAt set)", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_mock";
    const s = await setupChapter(newT());
    const accountId = await seedAccount(s, s.chapterId, {
      stripeFcAccountId: "fca_empty",
      backfilled: false,
    });
    globalThis.fetch = (async () =>
      jsonResponse({ data: [], has_more: false })) as unknown as typeof fetch;

    const res = await s.t.action(internal.stripeFinance.syncTransactions, {
      legacyAccountId: accountId,
    });
    expect(res).toEqual({ skipped: false, inserted: 0, updated: 0 });

    const done = await run(s.t, (ctx) => ctx.db.get(accountId));
    expect(typeof done?.backfilledAt).toBe("number");
    expect(done?.syncCursor).toBeUndefined();
  });
});

// ── refreshFcTransactions asks Stripe to fetch history, then re-syncs ─────────

describe("refreshFcTransactions", () => {
  const realFetch = globalThis.fetch;
  const realKey = process.env.STRIPE_SECRET_KEY;

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = realKey;
  });

  test("POSTs /accounts/{id}/refresh with features[]=transactions, then schedules two fallback re-syncs", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_mock";
    const s = await setupChapter(newT());
    const accountId = await seedAccount(s, s.chapterId, {
      stripeFcAccountId: "fca_refresh",
      backfilled: false,
    });

    const urls: string[] = [];
    const bodies: string[] = [];
    const methods: (string | undefined)[] = [];
    globalThis.fetch = (async (
      url: string,
      init?: { method?: string; body?: string },
    ) => {
      urls.push(String(url));
      bodies.push(String(init?.body ?? ""));
      methods.push(init?.method);
      return jsonResponse({ id: "fca_refresh", status: "active" });
    }) as unknown as typeof fetch;

    await s.t.action(internal.stripeFinance.refreshFcTransactions, {
      legacyAccountId: accountId,
      stripeFcAccountId: "fca_refresh",
    });

    // (a) exactly one POST, to the account's refresh endpoint, asking for the
    //     transactions feature.
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain(
      "/financial_connections/accounts/fca_refresh/refresh",
    );
    expect(methods[0]).toBe("POST");
    expect(decodeURIComponent(bodies[0])).toContain("features[]=transactions");

    // (b) two bounded, webhook-independent fallback re-syncs were scheduled.
    const scheduled = await run(s.t, (ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(scheduled).toHaveLength(2);
    expect(scheduled.every((f) => f.name.includes("syncTransactions"))).toBe(
      true,
    );
  });

  test("no key → no fetch, nothing scheduled (graceful degrade)", async () => {
    delete process.env.STRIPE_SECRET_KEY;
    const s = await setupChapter(newT());
    const accountId = await seedAccount(s, s.chapterId, {
      stripeFcAccountId: "fca_refresh_nokey",
    });
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return jsonResponse({});
    }) as unknown as typeof fetch;

    await s.t.action(internal.stripeFinance.refreshFcTransactions, {
      legacyAccountId: accountId,
      stripeFcAccountId: "fca_refresh_nokey",
    });
    expect(called).toBe(false);
    const scheduled = await run(s.t, (ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(scheduled).toHaveLength(0);
  });
});

// ── storeFcAccount kicks off the initial backfill on connect ──────────────────

describe("storeFcAccount initial sync scheduling", () => {
  const realKey = process.env.STRIPE_SECRET_KEY;

  afterEach(() => {
    if (realKey === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = realKey;
  });

  test("a fresh account schedules a Stripe transaction refresh when a key is set", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_mock";
    const s = await setupChapter(newT());
    await asManager(s);

    const accountId = await s.as.mutation(api.stripeFinance.storeFcAccount, {
      stripeFcAccountId: "fca_connect",
      institutionName: "Chase",
      last4: "1111",
      type: "depository",
    });
    // The new account starts un-backfilled and a transaction refresh is queued.
    // (Stripe fetches history asynchronously, so an immediate sync would be
    // empty — we ask Stripe to fetch first, then sync when it's ready.)
    const account = await run(s.t, (ctx) => ctx.db.get(accountId));
    expect(account?.backfilledAt).toBeUndefined();

    const scheduled = await run(s.t, (ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].name).toContain("refreshFcTransactions");
  });

  test("no key → connect is a no-op sync-wise (nothing scheduled)", async () => {
    delete process.env.STRIPE_SECRET_KEY;
    const s = await setupChapter(newT());
    await asManager(s);

    await s.as.mutation(api.stripeFinance.storeFcAccount, {
      stripeFcAccountId: "fca_nokey_connect",
    });
    const scheduled = await run(s.t, (ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(scheduled).toHaveLength(0);
  });

  test("re-connecting an existing account does NOT schedule another sync", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_mock";
    const s = await setupChapter(newT());
    await asManager(s);
    // Pre-existing (already-backfilled) account with the same Stripe id.
    await seedAccount(s, s.chapterId, { stripeFcAccountId: "fca_reconnect" });

    await s.as.mutation(api.stripeFinance.storeFcAccount, {
      stripeFcAccountId: "fca_reconnect",
      last4: "9999",
    });
    const scheduled = await run(s.t, (ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    // Re-connect refreshes metadata via the incremental path; no initial sync.
    expect(scheduled).toHaveLength(0);
  });

  test("RECONNECTING a disconnected account reactivates it AND schedules a refresh", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_mock";
    const s = await setupChapter(newT());
    await asManager(s);
    // A previously-connected account the user had disconnected.
    const accountId = await seedAccount(s, s.chapterId, {
      stripeFcAccountId: "fca_recon_disc",
    });
    await run(s.t, (ctx) =>
      ctx.db.patch(accountId, { status: "disconnected" }),
    );

    await s.as.mutation(api.stripeFinance.storeFcAccount, {
      stripeFcAccountId: "fca_recon_disc",
      last4: "9999",
    });

    // Reactivated…
    const account = await run(s.t, (ctx) => ctx.db.get(accountId));
    expect(account?.status).toBe("active");
    // …and a transaction refresh was queued so the history since disconnect lands.
    const scheduled = await run(s.t, (ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].name).toContain("refreshFcTransactions");
  });

  test("reconnecting a disconnected account with NO key reactivates but schedules nothing", async () => {
    delete process.env.STRIPE_SECRET_KEY;
    const s = await setupChapter(newT());
    await asManager(s);
    const accountId = await seedAccount(s, s.chapterId, {
      stripeFcAccountId: "fca_recon_disc_nokey",
    });
    await run(s.t, (ctx) =>
      ctx.db.patch(accountId, { status: "disconnected" }),
    );

    await s.as.mutation(api.stripeFinance.storeFcAccount, {
      stripeFcAccountId: "fca_recon_disc_nokey",
    });

    const account = await run(s.t, (ctx) => ctx.db.get(accountId));
    expect(account?.status).toBe("active");
    const scheduled = await run(s.t, (ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(scheduled).toHaveLength(0);
  });
});

describe("refreshFcAccount (manual refresh)", () => {
  const realKey = process.env.STRIPE_SECRET_KEY;

  afterEach(() => {
    if (realKey === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = realKey;
  });

  test("schedules a Stripe transaction refresh for an in-chapter account", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_mock";
    const s = await setupChapter(newT());
    await asManager(s);
    const accountId = await seedAccount(s, s.chapterId, {
      stripeFcAccountId: "fca_manual",
    });

    await s.as.mutation(api.stripeFinance.refreshFcAccount, {
      legacyAccountId: accountId,
    });

    const scheduled = await run(s.t, (ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].name).toContain("refreshFcTransactions");
  });

  test("rejects an account from another chapter", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_mock";
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);

    const other = await setupChapter(t, { email: "other@publicworship.life" });
    const foreignAccount = await seedAccount(other, other.chapterId, {
      stripeFcAccountId: "fca_foreign_refresh",
    });

    await expect(
      s.as.mutation(api.stripeFinance.refreshFcAccount, {
        legacyAccountId: foreignAccount,
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("no key → no-op (nothing scheduled, no throw)", async () => {
    delete process.env.STRIPE_SECRET_KEY;
    const s = await setupChapter(newT());
    await asManager(s);
    const accountId = await seedAccount(s, s.chapterId, {
      stripeFcAccountId: "fca_manual_nokey",
    });

    await s.as.mutation(api.stripeFinance.refreshFcAccount, {
      legacyAccountId: accountId,
    });
    const scheduled = await run(s.t, (ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(scheduled).toHaveLength(0);
  });
});
