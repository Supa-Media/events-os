/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
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
 * cursor + lastSyncedAt advance; plus tenancy on `listAccounts` / `setAccountFund`,
 * the NOT_CONFIGURED session degrade, and the webhook fan-out (unknown = no-op,
 * known = schedules a sync).
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

  test("advances syncCursor to the last id and stamps lastSyncedAt", async () => {
    const s = await setupChapter(newT());
    const accountId = await seedAccount(s, s.chapterId);

    await s.t.mutation(internal.stripeFinance.applyFcTransactions, {
      legacyAccountId: accountId,
      transactions: BATCH,
    });
    const account = await run(s.t, (ctx) => ctx.db.get(accountId));
    expect(account?.syncCursor).toBe("fctxn_2");
    expect(typeof account?.lastSyncedAt).toBe("number");
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
});
