import { describe, expect, test } from "vitest";
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
 *  - `provisionChapterAccount` degrades without `INCREASE_API_KEY`,
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
  test("paid → reimbursement paid + one transfer txn", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const { reimbursementId, payoutId } = await seedProcessingPayout(
      s,
      "ach_paid_1",
    );

    await s.t.mutation(internal.increase.onIncreaseWebhookEvent, {
      eventType: "ach_transfer.settled",
      transferId: "ach_paid_1",
      status: "settled",
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
        eventType: "ach_transfer.settled",
        transferId: "ach_does_not_exist",
        status: "settled",
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
    // Settle it.
    await s.t.mutation(internal.increase.onIncreaseWebhookEvent, {
      eventType: "ach_transfer.settled",
      transferId: "ach_race",
      status: "settled",
    });
    // A late failure event must be ignored.
    await s.t.mutation(internal.increase.onIncreaseWebhookEvent, {
      eventType: "ach_transfer.updated",
      transferId: "ach_race",
      status: "failed",
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
  test("degrades without INCREASE_API_KEY (onboardingStatus pending, no throw)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);

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

const SECRET = "whsec_increase_test";

function signedHeader(payload: string, secret: string, tSeconds: number): string {
  const v1 = createHmac("sha256", secret)
    .update(`${tSeconds}.${payload}`)
    .digest("hex");
  return `t=${tSeconds},v1=${v1}`;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

describe("verifyIncreaseSignature", () => {
  test("accepts a correctly signed, recent payload", async () => {
    const payload = JSON.stringify({ type: "ach_transfer.settled" });
    const header = signedHeader(payload, SECRET, nowSeconds());
    expect(await verifyIncreaseSignature(payload, header, SECRET)).toBe(true);
  });

  test("rejects a tampered payload", async () => {
    const original = JSON.stringify({ id: "at_real" });
    const header = signedHeader(original, SECRET, nowSeconds());
    const forged = JSON.stringify({ id: "at_attacker" });
    expect(await verifyIncreaseSignature(forged, header, SECRET)).toBe(false);
  });

  test("rejects the wrong secret + a stale timestamp + a missing header", async () => {
    const payload = JSON.stringify({ id: "at_real" });
    expect(
      await verifyIncreaseSignature(
        payload,
        signedHeader(payload, "whsec_wrong", nowSeconds()),
        SECRET,
      ),
    ).toBe(false);
    expect(
      await verifyIncreaseSignature(
        payload,
        signedHeader(payload, SECRET, nowSeconds() - 600),
        SECRET,
      ),
    ).toBe(false);
    expect(await verifyIncreaseSignature(payload, null, SECRET)).toBe(false);
  });
});
