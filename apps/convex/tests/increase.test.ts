import { afterEach, describe, expect, test } from "vitest";
import { createHmac } from "node:crypto";
import { ConvexError } from "convex/values";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { verifyIncreaseSignature } from "../increase";

/**
 * Phase 4 Increase money-layer tests (ACH reimbursement payouts + the payout
 * webhook state machine):
 *  - `payReimbursement` refuses a non-approved request, and is idempotent
 *    (twice → ONE payout, never double-pays),
 *  - `markPaidManually` sets the reimbursement `paid` + posts exactly one
 *    `flow:"transfer"` ledger row (excluded from spend), idempotently,
 *  - `onIncreaseWebhookEvent` paid→paid + transfer, failed/returned→not paid,
 *    unknown transfer no-ops, and a `paid` payout ignores a later `failed`,
 *  - `provisionChapterAccount` degrades when a required env is unset, opens an
 *    Account under the shared org Entity auto-resolving the sole Program (active),
 *    degrades on an ambiguous (>1) Program, and honors an explicit Program override,
 *  - `verifyIncreaseSignature` accepts a valid signature, rejects forgeries.
 *
 * All money is integer cents; the network side never runs (no `INCREASE_API_KEY`
 * in the test env) so the state machine is exercised through the DB apply.
 */

// ── Seed helpers ─────────────────────────────────────────────────────────────

/** Seed a roster person (optionally linked to a user). */
async function seedPerson(
  s: ChapterSetup,
  opts: { name: string; userId?: Id<"users">; isTeamMember?: boolean } = {
    name: "Person",
  },
): Promise<Id<"people">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: opts.name,
      userId: opts.userId,
      isTeamMember: opts.isTeamMember ?? false,
      createdAt: Date.now(),
    }),
  );
}

/** Make the seeded caller a finance manager (person linked to the user + role). */
async function seedManager(s: ChapterSetup): Promise<Id<"people">> {
  const personId = await seedPerson(s, {
    name: "Manny Manager",
    userId: s.userId,
    isTeamMember: true,
  });
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

/** Insert a reimbursement request in a given status. Payee is a distinct person. */
async function seedReimbursement(
  s: ChapterSetup,
  opts: {
    status: "submitted" | "approved" | "paying";
    payeePersonId?: Id<"people">;
    totalCents?: number;
    approvedCents?: number;
  },
): Promise<Id<"reimbursementRequests">> {
  const now = Date.now();
  return await run(s.t, (ctx) =>
    ctx.db.insert("reimbursementRequests", {
      chapterId: s.chapterId,
      token: crypto.randomUUID(),
      status: opts.status,
      payeeName: "Vera Volunteer",
      payeeEmail: "vera@example.com",
      personId: opts.payeePersonId,
      totalCents: opts.totalCents ?? 2000,
      approvedCents:
        opts.status === "submitted" ? undefined : opts.approvedCents ?? 1800,
      bankAccountLast4: "1234",
      submittedAt: now,
      approvedAt: opts.status === "submitted" ? undefined : now,
      createdAt: now,
      updatedAt: now,
    }),
  );
}

/** Count the `transfer`-flow transactions linked to a reimbursement. */
async function transferTxns(
  s: ChapterSetup,
  reimbursementId: Id<"reimbursementRequests">,
) {
  return await run(s.t, (ctx) =>
    ctx.db
      .query("transactions")
      .withIndex("by_reimbursement", (q) =>
        q.eq("reimbursementId", reimbursementId),
      )
      .collect(),
  );
}

async function payoutsFor(
  s: ChapterSetup,
  reimbursementId: Id<"reimbursementRequests">,
) {
  return await run(s.t, (ctx) =>
    ctx.db
      .query("payouts")
      .withIndex("by_reimbursement", (q) =>
        q.eq("reimbursementId", reimbursementId),
      )
      .collect(),
  );
}

// ── payReimbursement ─────────────────────────────────────────────────────────

describe("payReimbursement", () => {
  test("throws on a non-approved (submitted) request", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    const payee = await seedPerson(s, { name: "Vera" });
    const reimbursementId = await seedReimbursement(s, {
      status: "submitted",
      payeePersonId: payee,
    });
    await expect(
      s.as.action(api.increase.payReimbursement, { reimbursementId }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("is idempotent — twice yields ONE payout (never double-pays)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    const payee = await seedPerson(s, { name: "Vera" });
    const reimbursementId = await seedReimbursement(s, {
      status: "approved",
      payeePersonId: payee,
      approvedCents: 1800,
    });

    // No INCREASE_API_KEY in the test env → degrades to a manual/pending payout.
    const first = await s.as.action(api.increase.payReimbursement, {
      reimbursementId,
    });
    expect(first.provider).toBe("manual");
    expect(first.status).toBe("pending");
    expect(first.amountCents).toBe(1800); // approvedCents wins over totalCents

    const second = await s.as.action(api.increase.payReimbursement, {
      reimbursementId,
    });
    expect(second.id).toBe(first.id);

    const payouts = await payoutsFor(s, reimbursementId);
    expect(payouts.length).toBe(1);
  });
});

// ── markPaidManually ─────────────────────────────────────────────────────────

describe("markPaidManually", () => {
  test("sets reimbursement paid + posts exactly one transfer txn, idempotently", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    const payee = await seedPerson(s, { name: "Vera" });
    const reimbursementId = await seedReimbursement(s, {
      status: "approved",
      payeePersonId: payee,
      approvedCents: 1800,
    });

    const payout = await s.as.mutation(api.increase.markPaidManually, {
      reimbursementId,
    });
    expect(payout.provider).toBe("manual");
    expect(payout.status).toBe("paid");
    expect(payout.amountCents).toBe(1800);

    const req = await run(s.t, (ctx) => ctx.db.get(reimbursementId));
    expect(req?.status).toBe("paid");
    expect(req?.paidAt).toBeTruthy();

    const txns = await transferTxns(s, reimbursementId);
    expect(txns.length).toBe(1);
    expect(txns[0].flow).toBe("transfer"); // excluded from category spend
    expect(txns[0].source).toBe("reimbursement");
    expect(txns[0].status).toBe("reconciled");
    expect(txns[0].amountCents).toBe(1800);
    expect(txns[0].personId).toBe(payee);

    // A `pay` audit row was appended.
    const audit = await run(s.t, (ctx) =>
      ctx.db
        .query("approvals")
        .withIndex("by_subject", (q) =>
          q.eq("subjectType", "payout").eq("subjectId", String(payout.id)),
        )
        .collect(),
    );
    expect(audit.some((a) => a.action === "pay")).toBe(true);

    // Idempotent: a re-call posts no second transaction.
    const again = await s.as.mutation(api.increase.markPaidManually, {
      reimbursementId,
    });
    expect(again.id).toBe(payout.id);
    const txnsAfter = await transferTxns(s, reimbursementId);
    expect(txnsAfter.length).toBe(1);
  });

  test("completes a manual payout that payReimbursement left pending", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    const payee = await seedPerson(s, { name: "Vera" });
    const reimbursementId = await seedReimbursement(s, {
      status: "approved",
      payeePersonId: payee,
      approvedCents: 1800,
    });
    const pending = await s.as.action(api.increase.payReimbursement, {
      reimbursementId,
    });
    const paid = await s.as.mutation(api.increase.markPaidManually, {
      reimbursementId,
    });
    // Same payout row is completed, not duplicated.
    expect(paid.id).toBe(pending.id);
    expect(paid.status).toBe("paid");
    const payouts = await payoutsFor(s, reimbursementId);
    expect(payouts.length).toBe(1);
  });
});

// ── disbursement guards ($0 amount, SoD, in-flight ACH) ──────────────────────

describe("disbursement guards", () => {
  test("a $0 approved reimbursement can't be paid (markPaidManually + payReimbursement)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    const payee = await seedPerson(s, { name: "Vera" });
    const reimbursementId = await seedReimbursement(s, {
      status: "approved",
      payeePersonId: payee,
      totalCents: 0,
      approvedCents: 0,
    });
    await expect(
      s.as.mutation(api.increase.markPaidManually, { reimbursementId }),
    ).rejects.toBeInstanceOf(ConvexError);
    await expect(
      s.as.action(api.increase.payReimbursement, { reimbursementId }),
    ).rejects.toBeInstanceOf(ConvexError);
    // No payout + no transfer was minted.
    expect((await payoutsFor(s, reimbursementId)).length).toBe(0);
    expect((await transferTxns(s, reimbursementId)).length).toBe(0);
  });

  test("the payee (as a manager) is blocked from releasing their own payout", async () => {
    const t = newT();
    const s = await setupChapter(t);
    // The caller is a manager AND the payee (roster-linked to the request).
    const managerId = await seedManager(s);
    const reimbursementId = await seedReimbursement(s, {
      status: "approved",
      payeePersonId: managerId,
      approvedCents: 1800,
    });
    await expect(
      s.as.mutation(api.increase.markPaidManually, { reimbursementId }),
    ).rejects.toBeInstanceOf(ConvexError);
    await expect(
      s.as.action(api.increase.payReimbursement, { reimbursementId }),
    ).rejects.toBeInstanceOf(ConvexError);
    expect((await payoutsFor(s, reimbursementId)).length).toBe(0);
  });

  test("a different manager (not the payee) can release the payout", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s); // caller = a manager, not the payee
    const payee = await seedPerson(s, { name: "Vera" });
    const reimbursementId = await seedReimbursement(s, {
      status: "approved",
      payeePersonId: payee,
      approvedCents: 1800,
    });
    const payout = await s.as.mutation(api.increase.markPaidManually, {
      reimbursementId,
    });
    expect(payout.status).toBe("paid");
  });

  test("markPaidManually refuses when a live increase-provider payout is in flight", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    const payee = await seedPerson(s, { name: "Vera" });
    const reimbursementId = await seedReimbursement(s, {
      status: "paying",
      payeePersonId: payee,
      approvedCents: 1800,
    });
    // A real ACH payout is already moving money at Increase.
    const now = Date.now();
    await run(s.t, (ctx) =>
      ctx.db.insert("payouts", {
        chapterId: s.chapterId,
        reimbursementId,
        payeePersonId: payee,
        amountCents: 1800,
        provider: "increase",
        status: "processing",
        increaseTransferId: "ach_in_flight",
        createdAt: now,
        updatedAt: now,
      }),
    );
    await expect(
      s.as.mutation(api.increase.markPaidManually, { reimbursementId }),
    ).rejects.toBeInstanceOf(ConvexError);
    // The in-flight payout wasn't clobbered + no transfer was posted.
    const payouts = await payoutsFor(s, reimbursementId);
    expect(payouts.length).toBe(1);
    expect(payouts[0].status).toBe("processing");
    expect((await transferTxns(s, reimbursementId)).length).toBe(0);
  });
});

// ── onIncreaseWebhookEvent (the state machine) ───────────────────────────────

/** Seed a `processing` Increase payout + its `paying` reimbursement. */
async function seedProcessingPayout(
  s: ChapterSetup,
  transferId: string,
): Promise<{
  reimbursementId: Id<"reimbursementRequests">;
  payoutId: Id<"payouts">;
  payee: Id<"people">;
}> {
  const payee = await seedPerson(s, { name: "Vera" });
  const reimbursementId = await seedReimbursement(s, {
    status: "paying",
    payeePersonId: payee,
    approvedCents: 1800,
  });
  const now = Date.now();
  const payoutId = await run(s.t, (ctx) =>
    ctx.db.insert("payouts", {
      chapterId: s.chapterId,
      reimbursementId,
      payeePersonId: payee,
      amountCents: 1800,
      provider: "increase",
      status: "processing",
      increaseTransferId: transferId,
      createdAt: now,
      updatedAt: now,
    }),
  );
  return { reimbursementId, payoutId, payee };
}

describe("onIncreaseWebhookEvent", () => {
  test("submitted (Increase's terminal success) → reimbursement paid + one transfer txn", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const { reimbursementId, payoutId } = await seedProcessingPayout(
      s,
      "ach_paid_1",
    );

    // Real Increase: an ACH credit is irrevocably sent at `status:"submitted"`
    // (there is NO later "settled" event), carried on an `ach_transfer.updated`.
    await s.t.mutation(internal.increase.onIncreaseWebhookEvent, {
      eventType: "ach_transfer.updated",
      transferId: "ach_paid_1",
      status: "submitted",
    });

    const payout = await run(s.t, (ctx) => ctx.db.get(payoutId));
    expect(payout?.status).toBe("paid");
    const req = await run(s.t, (ctx) => ctx.db.get(reimbursementId));
    expect(req?.status).toBe("paid");
    const txns = await transferTxns(s, reimbursementId);
    expect(txns.length).toBe(1);
    expect(txns[0].flow).toBe("transfer");
    expect(txns[0].amountCents).toBe(1800);
  });

  test("failed → reimbursement NOT paid (walks back to approved)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const { reimbursementId, payoutId } = await seedProcessingPayout(
      s,
      "ach_fail_1",
    );

    await s.t.mutation(internal.increase.onIncreaseWebhookEvent, {
      eventType: "ach_transfer.updated",
      transferId: "ach_fail_1",
      status: "rejected",
    });

    const payout = await run(s.t, (ctx) => ctx.db.get(payoutId));
    expect(payout?.status).toBe("failed");
    const req = await run(s.t, (ctx) => ctx.db.get(reimbursementId));
    expect(req?.status).toBe("approved");
    expect(req?.status).not.toBe("paid");
    expect((await transferTxns(s, reimbursementId)).length).toBe(0);
  });

  test("returned → reimbursement NOT paid", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const { reimbursementId, payoutId } = await seedProcessingPayout(
      s,
      "ach_ret_1",
    );

    await s.t.mutation(internal.increase.onIncreaseWebhookEvent, {
      eventType: "ach_transfer.returned",
      transferId: "ach_ret_1",
      status: "returned",
    });

    const payout = await run(s.t, (ctx) => ctx.db.get(payoutId));
    expect(payout?.status).toBe("returned");
    const req = await run(s.t, (ctx) => ctx.db.get(reimbursementId));
    expect(req?.status).not.toBe("paid");
    expect((await transferTxns(s, reimbursementId)).length).toBe(0);
  });

  test("unknown transfer id is a no-op (never throws)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedProcessingPayout(s, "ach_known");
    await expect(
      s.t.mutation(internal.increase.onIncreaseWebhookEvent, {
        eventType: "ach_transfer.updated",
        transferId: "ach_does_not_exist",
        status: "submitted",
      }),
    ).resolves.toBeNull();
  });

  test("a paid payout ignores a later failed", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const { reimbursementId, payoutId } = await seedProcessingPayout(
      s,
      "ach_race",
    );
    // Settle it (submitted = Increase's terminal success for an ACH credit).
    await s.t.mutation(internal.increase.onIncreaseWebhookEvent, {
      eventType: "ach_transfer.updated",
      transferId: "ach_race",
      status: "submitted",
    });
    // A late failure event (a real `rejected` status) must be ignored.
    await s.t.mutation(internal.increase.onIncreaseWebhookEvent, {
      eventType: "ach_transfer.updated",
      transferId: "ach_race",
      status: "rejected",
    });

    const payout = await run(s.t, (ctx) => ctx.db.get(payoutId));
    expect(payout?.status).toBe("paid");
    const req = await run(s.t, (ctx) => ctx.db.get(reimbursementId));
    expect(req?.status).toBe("paid");
    expect((await transferTxns(s, reimbursementId)).length).toBe(1);
  });
});

// ── provisionChapterAccount ──────────────────────────────────────────────────

describe("provisionChapterAccount", () => {
  // The three env vars provisioning reads + the runtime `fetch` — snapshot and
  // restore around every test so a mocked call never leaks into another test.
  const PROVISION_ENV = [
    "INCREASE_API_KEY",
    "INCREASE_ENTITY_ID",
    "INCREASE_PROGRAM_ID",
  ] as const;
  const originalFetch = globalThis.fetch;
  const originalEnv: Partial<Record<(typeof PROVISION_ENV)[number], string>> =
    {};
  for (const k of PROVISION_ENV) originalEnv[k] = process.env[k];

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const k of PROVISION_ENV) {
      if (originalEnv[k] === undefined) delete process.env[k];
      else process.env[k] = originalEnv[k];
    }
  });

  test("degrades when INCREASE_ENTITY_ID is unset (onboardingStatus pending, no throw)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);

    // Key present but the shared org Entity id is missing → degrade. The missing
    // required env short-circuits BEFORE program resolution, so `/programs` is
    // never fetched (PROGRAM_ID is also unset here to prove the short-circuit, not
    // an override, is what keeps us off the network).
    process.env.INCREASE_API_KEY = "test_key";
    delete process.env.INCREASE_ENTITY_ID;
    delete process.env.INCREASE_PROGRAM_ID;
    // Provisioning must never touch the network on the degrade path.
    globalThis.fetch = (() => {
      throw new Error("fetch must not be called when a required env is unset");
    }) as unknown as typeof fetch;

    const account = await s.as.action(
      api.increase.provisionChapterAccount,
      {},
    );
    expect(account.onboardingStatus).toBe("pending");
    expect(account.increaseAccountId).toBeNull();

    // Exactly one row for the chapter (idempotent upsert).
    const rows = await run(s.t, (ctx) =>
      ctx.db
        .query("increaseAccounts")
        .withIndex("by_chapter", (q) => q.eq("chapterId", s.chapterId))
        .collect(),
    );
    expect(rows.length).toBe(1);
    expect(rows[0].onboardingStatus).toBe("pending");
  });

  /** A `fetch` mock dispatching by URL path, recording each call. `programs`
   *  seeds the `GET /programs` list; `/accounts` always returns an open account. */
  function mockIncreaseFetch(programs: Array<{ id: string }>) {
    const calls: Array<{
      path: string;
      method: string;
      body: Record<string, unknown> | null;
    }> = [];
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const path = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ path, method, body });
      if (path.includes("/programs")) {
        return new Response(JSON.stringify({ data: programs }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (path.includes("/accounts")) {
        return new Response(
          JSON.stringify({ id: "sandbox_account_x", status: "open" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`unexpected fetch: ${method} ${path}`);
    }) as unknown as typeof fetch;
    return calls;
  }

  test("opens an Account under the shared Entity, auto-resolving the sole Program", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);

    const ENTITY_ID = "entity_shared_org";
    process.env.INCREASE_API_KEY = "test_key";
    process.env.INCREASE_ENTITY_ID = ENTITY_ID;
    // No override — the Program is auto-resolved from the sole `GET /programs`.
    delete process.env.INCREASE_PROGRAM_ID;

    const calls = mockIncreaseFetch([{ id: "program_auto" }]);

    const account = await s.as.action(
      api.increase.provisionChapterAccount,
      {},
    );

    // Provisioned active under the SHARED entity — account id from the response,
    // entity id from the env (never minted).
    expect(account.onboardingStatus).toBe("active");
    expect(account.increaseAccountId).toBe("sandbox_account_x");
    expect(account.increaseEntityId).toBe(ENTITY_ID);

    // `GET /programs` was consulted, then `POST /accounts` (NOT `/entities`) with
    // `entity_id` from env + the auto-resolved `program_id`.
    expect(calls.some((c) => c.path.includes("/programs"))).toBe(true);
    const post = calls.find((c) => c.path.includes("/accounts"));
    expect(post).toBeTruthy();
    expect(post!.method).toBe("POST");
    expect(post!.path).not.toContain("/entities");
    expect(post!.body?.entity_id).toBe(ENTITY_ID);
    expect(post!.body?.program_id).toBe("program_auto");

    const rows = await run(s.t, (ctx) =>
      ctx.db
        .query("increaseAccounts")
        .withIndex("by_chapter", (q) => q.eq("chapterId", s.chapterId))
        .collect(),
    );
    expect(rows.length).toBe(1);
    expect(rows[0].onboardingStatus).toBe("active");
    expect(rows[0].increaseEntityId).toBe(ENTITY_ID);
    expect(rows[0].increaseAccountId).toBe("sandbox_account_x");
  });

  test("degrades to pending when `GET /programs` returns more than one Program", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);

    process.env.INCREASE_API_KEY = "test_key";
    process.env.INCREASE_ENTITY_ID = "entity_shared_org";
    delete process.env.INCREASE_PROGRAM_ID;

    // Two programs → ambiguous, can't auto-resolve → degrade, no `/accounts` POST.
    const calls = mockIncreaseFetch([
      { id: "program_a" },
      { id: "program_b" },
    ]);

    const account = await s.as.action(
      api.increase.provisionChapterAccount,
      {},
    );
    expect(account.onboardingStatus).toBe("pending");
    expect(account.increaseAccountId).toBeNull();

    expect(calls.some((c) => c.path.includes("/programs"))).toBe(true);
    expect(calls.some((c) => c.path.includes("/accounts"))).toBe(false);
  });

  test("`INCREASE_PROGRAM_ID` override skips the `/programs` fetch", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);

    const ENTITY_ID = "entity_shared_org";
    process.env.INCREASE_API_KEY = "test_key";
    process.env.INCREASE_ENTITY_ID = ENTITY_ID;
    process.env.INCREASE_PROGRAM_ID = "program_override";

    // If `/programs` were ever fetched the mock would record it — assert it isn't.
    const calls = mockIncreaseFetch([{ id: "program_should_not_be_used" }]);

    const account = await s.as.action(
      api.increase.provisionChapterAccount,
      {},
    );
    expect(account.onboardingStatus).toBe("active");
    expect(account.increaseAccountId).toBe("sandbox_account_x");

    // Only `/accounts` is hit, carrying the explicit override program id.
    expect(calls.some((c) => c.path.includes("/programs"))).toBe(false);
    const post = calls.find((c) => c.path.includes("/accounts"));
    expect(post).toBeTruthy();
    expect(post!.body?.program_id).toBe("program_override");
    expect(post!.body?.entity_id).toBe(ENTITY_ID);
  });

  test("a non-manager cannot provision", async () => {
    const t = newT();
    const s = await setupChapter(t);
    // A viewer-only caller.
    const personId = await seedPerson(s, { name: "Viewer", userId: s.userId });
    await run(s.t, (ctx) =>
      ctx.db.insert("financeRoles", {
        chapterId: s.chapterId,
        personId,
        role: "viewer",
        scope: "chapter",
        createdAt: Date.now(),
      }),
    );
    await expect(
      s.as.action(api.increase.provisionChapterAccount, {}),
    ).rejects.toBeInstanceOf(ConvexError);
  });
});

// ── listPayouts ──────────────────────────────────────────────────────────────

describe("listPayouts", () => {
  test("returns the chapter's payouts for a viewer", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    const payee = await seedPerson(s, { name: "Vera" });
    const reimbursementId = await seedReimbursement(s, {
      status: "approved",
      payeePersonId: payee,
    });
    await s.as.mutation(api.increase.markPaidManually, { reimbursementId });

    const rows = await s.as.query(api.increase.listPayouts, {});
    expect(rows.length).toBe(1);
    expect(rows[0].reimbursementId).toBe(reimbursementId);
    expect(rows[0].provider).toBe("manual");
    expect(rows[0].status).toBe("paid");
    expect(rows[0].payeePersonId).toBe(payee);
  });
});

// ── getChapterAccount ────────────────────────────────────────────────────────

describe("getChapterAccount", () => {
  test("returns null before provisioning, then the row after one is inserted", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);

    // Unprovisioned → null.
    expect(await s.as.query(api.increase.getChapterAccount, {})).toBeNull();

    // Insert an Increase account row for the chapter.
    const now = Date.now();
    const accountId = await run(s.t, (ctx) =>
      ctx.db.insert("increaseAccounts", {
        chapterId: s.chapterId,
        onboardingStatus: "active",
        increaseEntityId: "entity_shared_org",
        increaseAccountId: "sandbox_account_x",
        createdAt: now,
        updatedAt: now,
      }),
    );

    const account = await s.as.query(api.increase.getChapterAccount, {});
    expect(account).not.toBeNull();
    expect(account!.id).toBe(accountId);
    expect(account!.chapterId).toBe(s.chapterId);
    expect(account!.onboardingStatus).toBe("active");
    expect(account!.increaseEntityId).toBe("entity_shared_org");
    expect(account!.increaseAccountId).toBe("sandbox_account_x");
  });

  test("a caller without a finance role is rejected (viewer-gated)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    // The caller has NO financeRoles row → below viewer.
    await expect(
      s.as.query(api.increase.getChapterAccount, {}),
    ).rejects.toBeInstanceOf(ConvexError);
  });
});

// ── removeChapterAccount ─────────────────────────────────────────────────────

describe("removeChapterAccount", () => {
  /** Insert an Increase account row for the chapter and return its id. */
  async function seedIncreaseAccount(
    s: ChapterSetup,
    opts: {
      onboardingStatus: "active" | "pending" | "not_started";
      increaseAccountId?: string;
      increaseEntityId?: string;
    },
  ): Promise<Id<"increaseAccounts">> {
    const now = Date.now();
    return await run(s.t, (ctx) =>
      ctx.db.insert("increaseAccounts", {
        chapterId: s.chapterId,
        onboardingStatus: opts.onboardingStatus,
        increaseAccountId: opts.increaseAccountId,
        increaseEntityId: opts.increaseEntityId,
        createdAt: now,
        updatedAt: now,
      }),
    );
  }

  async function accountRows(s: ChapterSetup) {
    return await run(s.t, (ctx) =>
      ctx.db
        .query("increaseAccounts")
        .withIndex("by_chapter", (q) => q.eq("chapterId", s.chapterId))
        .collect(),
    );
  }

  test("removes a stale sandbox test account (active, `sandbox_` id)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    await seedIncreaseAccount(s, {
      onboardingStatus: "active",
      increaseAccountId: "sandbox_account_x",
      increaseEntityId: "sandbox_entity",
    });

    await s.as.mutation(api.increase.removeChapterAccount, {});
    expect((await accountRows(s)).length).toBe(0);
    // After removal the chapter reads as unprovisioned again.
    expect(await s.as.query(api.increase.getChapterAccount, {})).toBeNull();
  });

  test("removes a pending (never fully provisioned) account", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    await seedIncreaseAccount(s, { onboardingStatus: "pending" });

    await s.as.mutation(api.increase.removeChapterAccount, {});
    expect((await accountRows(s)).length).toBe(0);
  });

  test("refuses to remove a LIVE production account (active, non-sandbox id)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    await seedIncreaseAccount(s, {
      onboardingStatus: "active",
      increaseAccountId: "account_prod_1",
      increaseEntityId: "entity_prod",
    });

    await expect(
      s.as.mutation(api.increase.removeChapterAccount, {}),
    ).rejects.toBeInstanceOf(ConvexError);
    // The production row is left intact.
    expect((await accountRows(s)).length).toBe(1);
  });

  test("is a no-op when there's no account row (idempotent)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);

    await expect(
      s.as.mutation(api.increase.removeChapterAccount, {}),
    ).resolves.toBeNull();
    expect((await accountRows(s)).length).toBe(0);
  });

  test("a non-manager cannot remove the account", async () => {
    const t = newT();
    const s = await setupChapter(t);
    // A viewer-only caller.
    const personId = await seedPerson(s, { name: "Viewer", userId: s.userId });
    await run(s.t, (ctx) =>
      ctx.db.insert("financeRoles", {
        chapterId: s.chapterId,
        personId,
        role: "viewer",
        scope: "chapter",
        createdAt: Date.now(),
      }),
    );
    await seedIncreaseAccount(s, {
      onboardingStatus: "active",
      increaseAccountId: "sandbox_account_x",
    });

    await expect(
      s.as.mutation(api.increase.removeChapterAccount, {}),
    ).rejects.toBeInstanceOf(ConvexError);
    expect((await accountRows(s)).length).toBe(1);
  });
});

// ── verifyIncreaseSignature ──────────────────────────────────────────────────

// Standard Webhooks secrets are `whsec_<base64key>`; the HMAC key is the DECODED
// bytes. Use a real base64 body so the decode step exercises the true path.
const SECRET = "whsec_" + Buffer.from("increase-webhook-secret").toString("base64");
const WRONG_SECRET =
  "whsec_" + Buffer.from("some-other-secret").toString("base64");

/** Build a valid Standard Webhooks `webhook-signature` value for a payload,
 *  using the secret base64-DECODED as the HMAC key (the `whsec_` convention). */
function signStandardWebhook(
  payload: string,
  secret: string,
  id: string,
  tSeconds: number,
): string {
  const raw = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  const keyBytes = Buffer.from(raw, "base64");
  const sig = createHmac("sha256", keyBytes)
    .update(`${id}.${tSeconds}.${payload}`)
    .digest("base64");
  return `v1,${sig}`;
}

/** Build a signature using the secret's RAW UTF-8 bytes as the HMAC key (the
 *  other way Increase may treat a webhook Shared Secret). */
function signStandardWebhookRaw(
  payload: string,
  keyString: string,
  id: string,
  tSeconds: number,
): string {
  const sig = createHmac("sha256", Buffer.from(keyString, "utf8"))
    .update(`${id}.${tSeconds}.${payload}`)
    .digest("base64");
  return `v1,${sig}`;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

describe("verifyIncreaseSignature (Standard Webhooks)", () => {
  test("accepts a correctly signed, recent payload", async () => {
    const payload = JSON.stringify({ category: "ach_transfer.updated" });
    const id = "msg_123";
    const ts = nowSeconds();
    const sig = signStandardWebhook(payload, SECRET, id, ts);
    expect(
      await verifyIncreaseSignature(
        payload,
        { webhookId: id, webhookTimestamp: String(ts), webhookSignature: sig },
        SECRET,
      ),
    ).toBe(true);
  });

  test("accepts a signature produced with the RAW-string key (no whsec_ prefix)", async () => {
    // Increase may use the Shared Secret's raw UTF-8 bytes as the HMAC key.
    const rawSecret = "increase-raw-shared-secret";
    const payload = JSON.stringify({ category: "ach_transfer.updated" });
    const id = "msg_raw";
    const ts = nowSeconds();
    const sig = signStandardWebhookRaw(payload, rawSecret, id, ts);
    expect(
      await verifyIncreaseSignature(
        payload,
        { webhookId: id, webhookTimestamp: String(ts), webhookSignature: sig },
        rawSecret,
      ),
    ).toBe(true);
  });

  test("accepts a RAW-key signature over a whsec_-prefixed secret (prefix stripped)", async () => {
    // The candidate keys include the raw bytes AFTER stripping `whsec_`.
    const payload = JSON.stringify({ id: "evt_raw_prefixed" });
    const id = "msg_raw_prefixed";
    const ts = nowSeconds();
    const stripped = SECRET.slice(6); // the raw text after `whsec_`
    const sig = signStandardWebhookRaw(payload, stripped, id, ts);
    expect(
      await verifyIncreaseSignature(
        payload,
        { webhookId: id, webhookTimestamp: String(ts), webhookSignature: sig },
        SECRET,
      ),
    ).toBe(true);
  });

  test("accepts a signature produced with the base64-DECODED key", async () => {
    const payload = JSON.stringify({ category: "ach_transfer.created" });
    const id = "msg_b64";
    const ts = nowSeconds();
    // `signStandardWebhook` base64-decodes the secret for the key.
    const sig = signStandardWebhook(payload, SECRET, id, ts);
    expect(
      await verifyIncreaseSignature(
        payload,
        { webhookId: id, webhookTimestamp: String(ts), webhookSignature: sig },
        SECRET,
      ),
    ).toBe(true);
  });

  test("accepts one of several space-separated v1 tokens (key rotation)", async () => {
    const payload = JSON.stringify({ id: "evt_rot" });
    const id = "msg_rot";
    const ts = nowSeconds();
    const bogus = `v1,${Buffer.alloc(32).toString("base64")}`;
    const good = signStandardWebhook(payload, SECRET, id, ts);
    expect(
      await verifyIncreaseSignature(
        payload,
        {
          webhookId: id,
          webhookTimestamp: String(ts),
          webhookSignature: `${bogus} ${good}`,
        },
        SECRET,
      ),
    ).toBe(true);
  });

  test("rejects a tampered payload", async () => {
    const original = JSON.stringify({ id: "at_real" });
    const id = "msg_tamper";
    const ts = nowSeconds();
    const sig = signStandardWebhook(original, SECRET, id, ts);
    const forged = JSON.stringify({ id: "at_attacker" });
    expect(
      await verifyIncreaseSignature(
        forged,
        { webhookId: id, webhookTimestamp: String(ts), webhookSignature: sig },
        SECRET,
      ),
    ).toBe(false);
  });

  test("rejects the wrong secret + a stale timestamp + missing headers", async () => {
    const payload = JSON.stringify({ id: "at_real" });
    const id = "msg_neg";
    const ts = nowSeconds();

    // Signed with a different secret.
    expect(
      await verifyIncreaseSignature(
        payload,
        {
          webhookId: id,
          webhookTimestamp: String(ts),
          webhookSignature: signStandardWebhook(payload, WRONG_SECRET, id, ts),
        },
        SECRET,
      ),
    ).toBe(false);

    // A stale timestamp (outside the 5-minute tolerance).
    const stale = ts - 600;
    expect(
      await verifyIncreaseSignature(
        payload,
        {
          webhookId: id,
          webhookTimestamp: String(stale),
          webhookSignature: signStandardWebhook(payload, SECRET, id, stale),
        },
        SECRET,
      ),
    ).toBe(false);

    // Missing any of the three headers.
    expect(
      await verifyIncreaseSignature(
        payload,
        { webhookId: null, webhookTimestamp: String(ts), webhookSignature: "v1,x" },
        SECRET,
      ),
    ).toBe(false);
  });
});

// ── provisionChapterAccount sandbox mode ─────────────────────────────────────

/** A recording `fetch` mock dispatching by URL path — captures each call's host,
 *  auth header, and body. `/programs` returns the seeded list; `/accounts`
 *  returns an account whose id echoes the requested host's environment. */
function mockProvisionFetch(
  programs: Array<{ id: string }>,
  accountId: string,
) {
  const calls: Array<{
    url: string;
    method: string;
    auth: string | null;
    body: Record<string, unknown> | null;
  }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const auth = new Headers(init?.headers).get("authorization");
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, method, auth, body });
    if (url.includes("/programs")) {
      return new Response(JSON.stringify({ data: programs }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/accounts")) {
      return new Response(JSON.stringify({ id: accountId, status: "open" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  }) as unknown as typeof fetch;
  return calls;
}

describe("provisionChapterAccount sandbox mode", () => {
  const ENV = [
    "INCREASE_API_KEY",
    "INCREASE_ENTITY_ID",
    "INCREASE_SANDBOX_API_KEY",
    "INCREASE_SANDBOX_ENTITY_ID",
    "INCREASE_PROGRAM_ID",
    "INCREASE_SANDBOX_PROGRAM_ID",
    "INCREASE_API_BASE",
  ] as const;
  const originalFetch = globalThis.fetch;
  const originalEnv: Partial<Record<(typeof ENV)[number], string>> = {};
  for (const k of ENV) originalEnv[k] = process.env[k];

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const k of ENV) {
      if (originalEnv[k] === undefined) delete process.env[k];
      else process.env[k] = originalEnv[k];
    }
  });

  /** Turn the deployment-wide sandbox toggle on by inserting the singleton. */
  async function setSandbox(s: ChapterSetup, sandboxMode: boolean) {
    await run(s.t, (ctx) =>
      ctx.db.insert("financeSettings", { sandboxMode, updatedAt: Date.now() }),
    );
  }

  test("sandboxMode:true opens the account against the sandbox with sandbox creds + entity", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    await setSandbox(s, true);

    // BOTH environments wired — the toggle (not mere presence) must pick sandbox.
    process.env.INCREASE_API_KEY = "prod_key";
    process.env.INCREASE_ENTITY_ID = "entity_prod";
    process.env.INCREASE_SANDBOX_API_KEY = "sandbox_key";
    process.env.INCREASE_SANDBOX_ENTITY_ID = "entity_sandbox";
    delete process.env.INCREASE_PROGRAM_ID;
    delete process.env.INCREASE_API_BASE;

    const calls = mockProvisionFetch(
      [{ id: "sandbox_program" }],
      "sandbox_account_1",
    );

    const account = await s.as.action(
      api.increase.provisionChapterAccount,
      {},
    );
    expect(account.onboardingStatus).toBe("active");
    expect(account.increaseAccountId).toBe("sandbox_account_1");
    expect(account.increaseEntityId).toBe("entity_sandbox");

    // Both the `/programs` GET and the `/accounts` POST hit the SANDBOX host with
    // the SANDBOX key; the account is opened under the sandbox entity + program.
    const programsGet = calls.find((c) => c.url.includes("/programs"));
    expect(programsGet).toBeTruthy();
    expect(new URL(programsGet!.url).host).toBe("sandbox.increase.com");
    expect(programsGet!.auth).toBe("Bearer sandbox_key");

    const post = calls.find((c) => c.url.includes("/accounts"));
    expect(post).toBeTruthy();
    expect(post!.method).toBe("POST");
    expect(new URL(post!.url).host).toBe("sandbox.increase.com");
    expect(post!.auth).toBe("Bearer sandbox_key");
    expect(post!.body?.entity_id).toBe("entity_sandbox");
    expect(post!.body?.program_id).toBe("sandbox_program");
  });

  test("sandboxMode:true IGNORES the prod INCREASE_PROGRAM_ID override (no cross-env program leak)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    await setSandbox(s, true);

    process.env.INCREASE_API_KEY = "prod_key";
    process.env.INCREASE_ENTITY_ID = "entity_prod";
    process.env.INCREASE_SANDBOX_API_KEY = "sandbox_key";
    process.env.INCREASE_SANDBOX_ENTITY_ID = "entity_sandbox";
    // The prod program override IS set — it must NOT leak into the sandbox call
    // (a prod program id is rejected by the sandbox API → the real-world bug).
    process.env.INCREASE_PROGRAM_ID = "program_prod_only";
    delete process.env.INCREASE_SANDBOX_PROGRAM_ID;
    delete process.env.INCREASE_API_BASE;

    const calls = mockProvisionFetch(
      [{ id: "sandbox_program" }],
      "sandbox_account_2",
    );

    const account = await s.as.action(
      api.increase.provisionChapterAccount,
      {},
    );
    expect(account.onboardingStatus).toBe("active");

    // The sandbox `/programs` was consulted (prod override ignored) and the
    // account opened under the SANDBOX program, never the prod override.
    expect(calls.some((c) => c.url.includes("/programs"))).toBe(true);
    const post = calls.find((c) => c.url.includes("/accounts"));
    expect(post!.body?.program_id).toBe("sandbox_program");
    expect(post!.body?.program_id).not.toBe("program_prod_only");
  });

  test("sandboxMode:false opens the account against prod with prod creds + entity", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    await setSandbox(s, false);

    process.env.INCREASE_API_KEY = "prod_key";
    process.env.INCREASE_ENTITY_ID = "entity_prod";
    process.env.INCREASE_SANDBOX_API_KEY = "sandbox_key";
    process.env.INCREASE_SANDBOX_ENTITY_ID = "entity_sandbox";
    delete process.env.INCREASE_PROGRAM_ID;
    delete process.env.INCREASE_API_BASE; // default → api.increase.com

    const calls = mockProvisionFetch([{ id: "prod_program" }], "account_1");

    const account = await s.as.action(
      api.increase.provisionChapterAccount,
      {},
    );
    expect(account.onboardingStatus).toBe("active");
    expect(account.increaseAccountId).toBe("account_1");
    expect(account.increaseEntityId).toBe("entity_prod");

    const post = calls.find((c) => c.url.includes("/accounts"));
    expect(post).toBeTruthy();
    expect(new URL(post!.url).host).toBe("api.increase.com");
    expect(post!.auth).toBe("Bearer prod_key");
    expect(post!.body?.entity_id).toBe("entity_prod");
    expect(post!.body?.program_id).toBe("prod_program");
  });

  test("sandboxMode:true degrades to pending when the sandbox entity id is unset", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    await setSandbox(s, true);

    // Sandbox key present but no sandbox entity → degrade (never falls back to
    // prod creds). Prod is fully wired to prove the toggle isolates envs.
    process.env.INCREASE_API_KEY = "prod_key";
    process.env.INCREASE_ENTITY_ID = "entity_prod";
    process.env.INCREASE_SANDBOX_API_KEY = "sandbox_key";
    delete process.env.INCREASE_SANDBOX_ENTITY_ID;
    delete process.env.INCREASE_PROGRAM_ID;
    globalThis.fetch = (() => {
      throw new Error("fetch must not be called on the degrade path");
    }) as unknown as typeof fetch;

    const account = await s.as.action(
      api.increase.provisionChapterAccount,
      {},
    );
    expect(account.onboardingStatus).toBe("pending");
    expect(account.increaseAccountId).toBeNull();
  });
});

// ── handleIncreaseWebhook env routing (sandbox vs production) ─────────────────

/** A recording `fetch` mock: captures each request's URL + Authorization header
 *  and returns the given JSON. */
function mockRecordingFetch(json: Record<string, unknown>) {
  const calls: Array<{ url: string; method: string; auth: string | null }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const auth = new Headers(init?.headers).get("authorization");
    calls.push({ url, method, auth });
    return new Response(JSON.stringify(json), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return calls;
}

describe("handleIncreaseWebhook env routing", () => {
  const ENV = [
    "INCREASE_API_KEY",
    "INCREASE_SANDBOX_API_KEY",
    "INCREASE_API_BASE",
  ] as const;
  const originalFetch = globalThis.fetch;
  const originalEnv: Partial<Record<(typeof ENV)[number], string>> = {};
  for (const k of ENV) originalEnv[k] = process.env[k];

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const k of ENV) {
      if (originalEnv[k] === undefined) delete process.env[k];
      else process.env[k] = originalEnv[k];
    }
  });

  test("a sandbox_ object id fetches the sandbox with INCREASE_SANDBOX_API_KEY", async () => {
    const t = newT();
    // Both keys present — the `sandbox_` PREFIX (not mere presence) chooses env.
    process.env.INCREASE_API_KEY = "prod_key";
    process.env.INCREASE_SANDBOX_API_KEY = "sandbox_key";
    const calls = mockRecordingFetch({ id: "sandbox_ach_1", status: "submitted" });

    await t.action(internal.increase.handleIncreaseWebhook, {
      category: "ach_transfer.updated",
      associatedObjectId: "sandbox_ach_1",
    });

    const get = calls.find((c) => c.url.includes("/ach_transfers/"));
    expect(get).toBeTruthy();
    expect(new URL(get!.url).host).toBe("sandbox.increase.com");
    expect(get!.auth).toBe("Bearer sandbox_key");
  });

  test("a non-prefixed object id fetches the prod base with INCREASE_API_KEY", async () => {
    const t = newT();
    process.env.INCREASE_API_KEY = "prod_key";
    process.env.INCREASE_SANDBOX_API_KEY = "sandbox_key";
    delete process.env.INCREASE_API_BASE; // default → api.increase.com
    const calls = mockRecordingFetch({ id: "ach_1", status: "submitted" });

    await t.action(internal.increase.handleIncreaseWebhook, {
      category: "ach_transfer.updated",
      associatedObjectId: "ach_1",
    });

    const get = calls.find((c) => c.url.includes("/ach_transfers/"));
    expect(get).toBeTruthy();
    expect(new URL(get!.url).host).toBe("api.increase.com");
    expect(get!.auth).toBe("Bearer prod_key");
  });
});
