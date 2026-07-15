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
 *  - `provisionChapterAccount` degrades when provisioning env is unset, and
 *    opens an Account under the shared org Entity when it's all set (active),
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

    // Key + program present but the shared org Entity id is missing → degrade.
    process.env.INCREASE_API_KEY = "test_key";
    process.env.INCREASE_PROGRAM_ID = "program_test";
    delete process.env.INCREASE_ENTITY_ID;
    // Provisioning must never touch the network on the degrade path.
    globalThis.fetch = (() => {
      throw new Error("fetch must not be called when env is unset");
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

  test("opens an Account under the shared Entity when all env is set (active)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);

    const ENTITY_ID = "entity_shared_org";
    process.env.INCREASE_API_KEY = "test_key";
    process.env.INCREASE_ENTITY_ID = ENTITY_ID;
    process.env.INCREASE_PROGRAM_ID = "program_test";

    // Mock the Increase sandbox: `POST /accounts` returns an open account.
    let calledPath: string | null = null;
    let calledBody: Record<string, unknown> | null = null;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      calledPath = String(input);
      calledBody = init?.body ? JSON.parse(String(init.body)) : null;
      return new Response(
        JSON.stringify({ id: "sandbox_account_x", status: "open" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const account = await s.as.action(
      api.increase.provisionChapterAccount,
      {},
    );

    // Provisioned active under the SHARED entity — account id from the response,
    // entity id from the env (never minted).
    expect(account.onboardingStatus).toBe("active");
    expect(account.increaseAccountId).toBe("sandbox_account_x");
    expect(account.increaseEntityId).toBe(ENTITY_ID);

    // Hit `/accounts` (NOT `/entities`) with `entity_id` = the shared env value.
    const body = calledBody as Record<string, unknown> | null;
    expect(String(calledPath)).toContain("/accounts");
    expect(String(calledPath)).not.toContain("/entities");
    expect(body?.entity_id).toBe(ENTITY_ID);
    expect(body?.program_id).toBe("program_test");

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

// ── verifyIncreaseSignature ──────────────────────────────────────────────────

// Standard Webhooks secrets are `whsec_<base64key>`; the HMAC key is the DECODED
// bytes. Use a real base64 body so the decode step exercises the true path.
const SECRET = "whsec_" + Buffer.from("increase-webhook-secret").toString("base64");
const WRONG_SECRET =
  "whsec_" + Buffer.from("some-other-secret").toString("base64");

/** Build a valid Standard Webhooks `webhook-signature` value for a payload. */
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
