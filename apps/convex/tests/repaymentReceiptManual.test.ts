/// <reference types="vite/client" />
/**
 * MANUAL "SEND RECEIPT" — a manager (re)sending one settled repayment's
 * proof-of-payment email on demand.
 *
 * Founder: "add an email button for already paid reimbursements or whatever.
 * Allowing me to manually send a receipt to someone that needs it. Say they
 * forgot it, or they just need it resent. Or, you know, it's in the past. So
 * let me do that, because there's some payments that I want to send receipts
 * for, or repayments I want to send receipts for."
 *
 * Four things these tests pin down:
 *
 *  1. THE BACKLOG CASE — the whole reason this exists — a manual send
 *     succeeds even for a repayment that ALREADY has `receiptSentAt` set,
 *     which the automatic path (`claimRepaymentReceipts`) would silently
 *     skip.
 *  2. GATED — same rung as chasing a debt (`requireRepaymentsCollect`); a
 *     viewer is refused.
 *  3. A manual send records its outcome through the SAME
 *     `markRepaymentReceiptOutcome` machinery the automatic path uses, so
 *     `receiptDeliveredAt` / the failure fields stay meaningful either way.
 *  4. THE AUTOMATIC PATH'S AT-MOST-ONCE GUARANTEE IS UNCHANGED — a manual
 *     send does not make `claimRepaymentReceipts` claim a row twice.
 *
 * Plus: the row state a manual-send button needs (`receiptSentAt`,
 * `receiptDeliveredAt`, `receiptDeliveryFailedAt`, `lastReceiptError`) is
 * actually on `listPersonalRepayments`'s return shape.
 */
import { describe, expect, test, vi } from "vitest";
import { ConvexError } from "convex/values";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api, internal } from "../_generated/api";
import { sendOneRepaymentReceiptGroup } from "../cards";
import type { ActionCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";

async function seedManager(s: ChapterSetup): Promise<Id<"people">> {
  const personId = await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Manny Manager",
      userId: s.userId,
      isTeamMember: true,
      createdAt: Date.now(),
    }),
  );
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

async function seedViewer(s: ChapterSetup): Promise<Id<"people">> {
  const personId = await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Bookkeeper",
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
  return personId;
}

async function seedPayer(
  s: ChapterSetup,
  opts: { email?: string | null; name?: string } = {},
): Promise<Id<"people">> {
  const email = opts.email === undefined ? "pat@publicworship.life" : opts.email;
  return await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: opts.name ?? "Pat Payer",
      isTeamMember: true,
      ...(email !== null ? { pwEmail: email } : {}),
      createdAt: Date.now(),
    }),
  );
}

/** Seed a repayment already SETTLED (status "paid", a real credit
 *  transaction) — every test here is about the receipt on an already-paid
 *  debt, never an outstanding one. */
async function seedSettledRepayment(
  s: ChapterSetup,
  payerPersonId: Id<"people">,
  amountCents: number,
  opts: { merchantName?: string; receiptSentAt?: number } = {},
): Promise<Id<"personalRepayments">> {
  const now = Date.now();
  const transactionId = await run(s.t, (ctx) =>
    ctx.db.insert("transactions", {
      chapterId: s.chapterId,
      source: "manual",
      flow: "outflow",
      amountCents,
      currency: "usd",
      postedAt: now,
      personId: payerPersonId,
      merchantName: opts.merchantName ?? "Corner Store",
      status: "reconciled",
      createdAt: now,
    }),
  );
  const creditTransactionId = await run(s.t, (ctx) =>
    ctx.db.insert("transactions", {
      chapterId: s.chapterId,
      source: "repayment",
      flow: "transfer",
      amountCents,
      currency: "usd",
      postedAt: now,
      personId: payerPersonId,
      status: "reconciled",
      createdAt: now,
    }),
  );
  const repaymentId = await run(s.t, (ctx) =>
    ctx.db.insert("personalRepayments", {
      chapterId: s.chapterId,
      transactionId,
      payerPersonId,
      amountCents,
      method: "card",
      status: "paid",
      creditTransactionId,
      createdAt: now,
      updatedAt: now,
      ...(opts.receiptSentAt !== undefined
        ? { receiptSentAt: opts.receiptSentAt }
        : {}),
    }),
  );
  await run(s.t, (ctx) =>
    ctx.db.patch(transactionId, { isPersonal: true, repaymentId }),
  );
  return repaymentId;
}

function captureResend(opts: { fail?: boolean } = {}) {
  const calls: Array<{ to: string; subject: string; html: string }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.includes("api.resend.com/emails")) {
      if (opts.fail) return new Response("rate limited", { status: 429 });
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      calls.push({ to: body.to, subject: body.subject, html: body.html ?? "" });
      return new Response(JSON.stringify({ id: "email_1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch: ${path}`);
  }) as unknown as typeof fetch;
  return calls;
}

async function withEmailEnv(body: () => Promise<void>): Promise<void> {
  const prevApp = process.env.APP_URL;
  const prevResend = process.env.RESEND_API_KEY;
  const realFetch = globalThis.fetch;
  process.env.APP_URL = "https://app.publicworship.life";
  process.env.RESEND_API_KEY = "resend_test_key";
  try {
    await body();
  } finally {
    globalThis.fetch = realFetch;
    if (prevApp === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = prevApp;
    if (prevResend === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = prevResend;
  }
}

describe("manual receipt send — the backlog case", () => {
  test("succeeds for a repayment that ALREADY has receiptSentAt set", async () => {
    await withEmailEnv(async () => {
      const t = newT();
      const s = await setupChapter(t);
      await seedManager(s);
      const payer = await seedPayer(s, { email: "backlog@example.com" });
      // Settled with an OLD receiptSentAt — exactly the shape a repayment
      // that predates this feature (or already got its one automatic
      // receipt) has. `claimRepaymentReceipts` would refuse this outright.
      const a = await seedSettledRepayment(s, payer, 4_200, {
        receiptSentAt: Date.now() - 30 * 24 * 60 * 60 * 1000,
      });

      const calls = captureResend();
      await s.as.action(api.cards.sendRepaymentReceiptManually, {
        repaymentId: a,
      });

      expect(calls).toHaveLength(1);
      expect(calls[0].to).toBe("backlog@example.com");
      expect(calls[0].subject).toContain("Receipt:");

      const row = await run(s.t, (ctx) => ctx.db.get(a));
      expect(typeof row?.receiptDeliveredAt).toBe("number");
    });
  });

  test("can be pressed more than once, minutes apart — genuine resending is the feature", async () => {
    vi.useFakeTimers();
    try {
      await withEmailEnv(async () => {
        const t = newT();
        const s = await setupChapter(t);
        await seedManager(s);
        const payer = await seedPayer(s, { email: "twice@example.com" });
        const a = await seedSettledRepayment(s, payer, 1_000);

        const calls = captureResend();
        await s.as.action(api.cards.sendRepaymentReceiptManually, { repaymentId: a });
        // Past the manual cooldown (`MANUAL_RECEIPT_RESEND_COOLDOWN_MS`, 60s)
        // — a genuinely later press must still go through in full.
        vi.advanceTimersByTime(90 * 1000);
        await s.as.action(api.cards.sendRepaymentReceiptManually, { repaymentId: a });

        expect(calls).toHaveLength(2);
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("manual receipt send — the cooldown (finding 2: no bound on repeated sends)", () => {
  test("an immediate second press is refused with a clear, honest wait time — never a silent no-op", async () => {
    vi.useFakeTimers();
    try {
      await withEmailEnv(async () => {
        const t = newT();
        const s = await setupChapter(t);
        await seedManager(s);
        const payer = await seedPayer(s, { email: "cooldown@example.com" });
        const a = await seedSettledRepayment(s, payer, 1_000);

        const calls = captureResend();
        await s.as.action(api.cards.sendRepaymentReceiptManually, { repaymentId: a });
        expect(calls).toHaveLength(1);

        // Immediately again — a runaway loop or a fat-fingered double-tap.
        await expect(
          s.as.action(api.cards.sendRepaymentReceiptManually, { repaymentId: a }),
        ).rejects.toThrow(/try again in \d+s/i);
        // No second network call — the refusal happened before any send was
        // attempted, not after a wasted one.
        expect(calls).toHaveLength(1);

        const row = await run(s.t, (ctx) => ctx.db.get(a));
        // The FIRST send's delivery is untouched by the refused second press.
        expect(typeof row?.receiptDeliveredAt).toBe("number");
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test("a runaway loop of 10 presses inside the cooldown produces exactly ONE send", async () => {
    vi.useFakeTimers();
    try {
      await withEmailEnv(async () => {
        const t = newT();
        const s = await setupChapter(t);
        await seedManager(s);
        const payer = await seedPayer(s, { email: "loop@example.com" });
        const a = await seedSettledRepayment(s, payer, 1_000);

        const calls = captureResend();
        let succeeded = 0;
        let refused = 0;
        for (let i = 0; i < 10; i++) {
          try {
            await s.as.action(api.cards.sendRepaymentReceiptManually, { repaymentId: a });
            succeeded += 1;
          } catch (err) {
            expect(err).toBeInstanceOf(ConvexError);
            refused += 1;
          }
        }
        expect(succeeded).toBe(1);
        expect(refused).toBe(9);
        expect(calls).toHaveLength(1);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test("the cooldown never applies to the automatic path — an automatic send is unaffected by a manual send moments earlier", async () => {
    vi.useFakeTimers();
    try {
      await withEmailEnv(async () => {
        const t = newT();
        const s = await setupChapter(t);
        await seedManager(s);
        const payer = await seedPayer(s, { email: "auto-unaffected@example.com" });
        // Two DIFFERENT repayments — manually receipt one, then prove the
        // automatic claim on the OTHER, moments later, is untouched by the
        // first row's cooldown (the cooldown is per-row anyway, but this also
        // pins that automatic claims never even read
        // `lastManualReceiptSendAt`).
        const manual = await seedSettledRepayment(s, payer, 1_000);
        const other = await seedSettledRepayment(s, payer, 500);

        const calls = captureResend();
        await s.as.action(api.cards.sendRepaymentReceiptManually, {
          repaymentId: manual,
        });
        expect(calls).toHaveLength(1);

        // Immediately after — well inside the 60s manual cooldown window —
        // the automatic claim on the OTHER row must still succeed.
        const claimed = await t.mutation(internal.cards.claimRepaymentReceipts, {
          repaymentIds: [other],
        });
        expect(claimed).toHaveLength(1);
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("manual receipt send — concurrency (finding 1: races an in-flight send)", () => {
  test("backfill claims a stale row, a manual send races it mid-flight and is refused, then the backfill's own send completes — exactly one email", async () => {
    await withEmailEnv(async () => {
      const t = newT();
      const s = await setupChapter(t);
      await seedManager(s);
      const payer = await seedPayer(s, { email: "race-backfill@example.com" });
      // Settled long enough ago (and never confirmed delivered) to be
      // eligible for the backfill's retry claim.
      const a = await seedSettledRepayment(s, payer, 2_000, {
        receiptSentAt: Date.now() - 20 * 60 * 1000,
      });

      // STEP 1 — the backfill's retry claim commits. Its own send hasn't
      // been issued yet — exactly the reviewer's proven window.
      const claim = await t.mutation(internal.cards.claimRepaymentReceiptForRetry, {
        repaymentId: a,
      });
      expect(claim).not.toBeNull();

      // STEP 2 — a manual send races the in-flight claim: refused outright,
      // no email, no silent no-op.
      const calls = captureResend();
      await expect(
        s.as.action(api.cards.sendRepaymentReceiptManually, { repaymentId: a }),
      ).rejects.toThrow(/already being sent/i);
      expect(calls).toHaveLength(0);

      // STEP 3 — the backfill's own claimed send completes normally, through
      // the SAME `sendOneRepaymentReceiptGroup` every path shares.
      await t.action(async (rawCtx) => {
        await sendOneRepaymentReceiptGroup(rawCtx as unknown as ActionCtx, [a], 0);
      });

      expect(calls).toHaveLength(1);
      const row = await run(s.t, (ctx) => ctx.db.get(a));
      expect(typeof row?.receiptDeliveredAt).toBe("number");
    });
  });

  test("automatic claims (settlement scheduling), a manual send races it mid-flight and is refused, then automatic's own send completes — exactly one email", async () => {
    await withEmailEnv(async () => {
      const t = newT();
      const s = await setupChapter(t);
      await seedManager(s);
      const payer = await seedPayer(s, { email: "race-automatic@example.com" });
      const a = await seedSettledRepayment(s, payer, 1_800);

      // STEP 1 — automatic's claim commits (this is exactly what
      // `sendRepaymentReceiptEmail` does before it sends).
      const claimed = await t.mutation(internal.cards.claimRepaymentReceipts, {
        repaymentIds: [a],
      });
      expect(claimed).toHaveLength(1);

      // STEP 2 — a manual send races the in-flight automatic claim: refused.
      const calls = captureResend();
      await expect(
        s.as.action(api.cards.sendRepaymentReceiptManually, { repaymentId: a }),
      ).rejects.toThrow(/already being sent/i);
      expect(calls).toHaveLength(0);

      // STEP 3 — automatic's own claimed send completes normally.
      await t.action(async (rawCtx) => {
        await sendOneRepaymentReceiptGroup(rawCtx as unknown as ActionCtx, [a], 0);
      });

      expect(calls).toHaveLength(1);
      const row = await run(s.t, (ctx) => ctx.db.get(a));
      expect(typeof row?.receiptDeliveredAt).toBe("number");
    });
  });

  test("automatic claims, a backfill retry races it mid-flight and finds nothing to claim, then automatic's own send completes — exactly one email", async () => {
    await withEmailEnv(async () => {
      const t = newT();
      const s = await setupChapter(t);
      await seedManager(s);
      const payer = await seedPayer(s, { email: "race-both@example.com" });
      const a = await seedSettledRepayment(s, payer, 1_500);

      // STEP 1 — automatic's claim commits.
      const claimed = await t.mutation(internal.cards.claimRepaymentReceipts, {
        repaymentIds: [a],
      });
      expect(claimed).toHaveLength(1);

      // STEP 2 — a backfill retry races the in-flight automatic claim: finds
      // nothing to claim (returns `null`, the same graceful skip it gives
      // any other ineligible row — no throw, since the backfill sweeps many
      // rows and one being mid-flight is routine, not exceptional).
      const retryClaim = await t.mutation(
        internal.cards.claimRepaymentReceiptForRetry,
        { repaymentId: a },
      );
      expect(retryClaim).toBeNull();

      // STEP 3 — automatic's own claimed send completes normally.
      const calls = captureResend();
      await t.action(async (rawCtx) => {
        await sendOneRepaymentReceiptGroup(rawCtx as unknown as ActionCtx, [a], 0);
      });

      expect(calls).toHaveLength(1);
      const row = await run(s.t, (ctx) => ctx.db.get(a));
      expect(typeof row?.receiptDeliveredAt).toBe("number");
    });
  });

  test("the in-flight lock isn't permanent — once RECEIPT_RETRY_STALE_MS has passed with no recorded outcome, a manual send may proceed", async () => {
    vi.useFakeTimers();
    try {
      await withEmailEnv(async () => {
        const t = newT();
        const s = await setupChapter(t);
        await seedManager(s);
        const payer = await seedPayer(s, { email: "crashed@example.com" });
        const a = await seedSettledRepayment(s, payer, 1_200);

        // A claim commits and then the process holding it is presumed dead —
        // `markRepaymentReceiptOutcome` never runs, so the lock is never
        // released the normal way.
        const claimed = await t.mutation(internal.cards.claimRepaymentReceipts, {
          repaymentIds: [a],
        });
        expect(claimed).toHaveLength(1);

        // Still inside the grace window — refused.
        const calls = captureResend();
        await expect(
          s.as.action(api.cards.sendRepaymentReceiptManually, { repaymentId: a }),
        ).rejects.toThrow(/already being sent/i);
        expect(calls).toHaveLength(0);

        // Past `RECEIPT_RETRY_STALE_MS` (15 minutes) — the lock is presumed
        // abandoned and a fresh claim may proceed.
        vi.advanceTimersByTime(16 * 60 * 1000);
        await s.as.action(api.cards.sendRepaymentReceiptManually, { repaymentId: a });
        expect(calls).toHaveLength(1);
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("manual receipt send — access", () => {
  test("a viewer cannot send a receipt — collecting/receipting is a rung above reading", async () => {
    await withEmailEnv(async () => {
      const t = newT();
      const s = await setupChapter(t);
      await seedViewer(s);
      const payer = await seedPayer(s, { email: "alice@publicworship.life" });
      const a = await seedSettledRepayment(s, payer, 1_400);

      const calls = captureResend();
      await expect(
        s.as.action(api.cards.sendRepaymentReceiptManually, { repaymentId: a }),
      ).rejects.toBeInstanceOf(ConvexError);
      expect(calls).toHaveLength(0);
    });
  });

  test("refuses a repayment that hasn't actually been paid yet", async () => {
    await withEmailEnv(async () => {
      const t = newT();
      const s = await setupChapter(t);
      await seedManager(s);
      const payer = await seedPayer(s, { email: "alice@publicworship.life" });
      const now = Date.now();
      const transactionId = await run(s.t, (ctx) =>
        ctx.db.insert("transactions", {
          chapterId: s.chapterId,
          source: "manual",
          flow: "outflow",
          amountCents: 1_000,
          currency: "usd",
          postedAt: now,
          personId: payer,
          status: "reconciled",
          createdAt: now,
        }),
      );
      const a = await run(s.t, (ctx) =>
        ctx.db.insert("personalRepayments", {
          chapterId: s.chapterId,
          transactionId,
          payerPersonId: payer,
          amountCents: 1_000,
          method: "card",
          status: "pending", // NOT paid
          createdAt: now,
          updatedAt: now,
        }),
      );

      const calls = captureResend();
      await expect(
        s.as.action(api.cards.sendRepaymentReceiptManually, { repaymentId: a }),
      ).rejects.toBeInstanceOf(ConvexError);
      expect(calls).toHaveLength(0);
    });
  });
});

describe("manual receipt send — outcome recording", () => {
  test("records receiptDeliveredAt through the same markRepaymentReceiptOutcome machinery", async () => {
    await withEmailEnv(async () => {
      const t = newT();
      const s = await setupChapter(t);
      await seedManager(s);
      const payer = await seedPayer(s, { email: "delivered@example.com" });
      const a = await seedSettledRepayment(s, payer, 900);

      captureResend();
      await s.as.action(api.cards.sendRepaymentReceiptManually, { repaymentId: a });

      const row = await run(s.t, (ctx) => ctx.db.get(a));
      expect(typeof row?.receiptDeliveredAt).toBe("number");
      expect(row?.receiptDeliveryFailedAt).toBeUndefined();
      expect(row?.lastReceiptError).toBeUndefined();
    });
  });

  test("a REJECTED send is recorded as a failure and surfaces a real error, never a silent success", async () => {
    await withEmailEnv(async () => {
      const t = newT();
      const s = await setupChapter(t);
      await seedManager(s);
      const payer = await seedPayer(s, { email: "rejected@example.com" });
      const a = await seedSettledRepayment(s, payer, 700);

      captureResend({ fail: true });
      await expect(
        s.as.action(api.cards.sendRepaymentReceiptManually, { repaymentId: a }),
      ).rejects.toBeInstanceOf(ConvexError);

      const row = await run(s.t, (ctx) => ctx.db.get(a));
      expect(row?.receiptDeliveredAt).toBeUndefined();
      expect(typeof row?.receiptDeliveryFailedAt).toBe("number");
      expect(row?.lastReceiptError).toMatch(/resend/i);
    });
  });

  test("no email on file: fails loudly rather than claiming success", async () => {
    await withEmailEnv(async () => {
      const t = newT();
      const s = await setupChapter(t);
      await seedManager(s);
      const payer = await seedPayer(s, { email: null });
      const a = await seedSettledRepayment(s, payer, 500);

      const calls = captureResend();
      await expect(
        s.as.action(api.cards.sendRepaymentReceiptManually, { repaymentId: a }),
      ).rejects.toThrow(/no email/i);
      expect(calls).toHaveLength(0);

      const row = await run(s.t, (ctx) => ctx.db.get(a));
      expect(typeof row?.receiptDeliveryFailedAt).toBe("number");
    });
  });
});

describe("manual receipt send — the automatic path's at-most-once guarantee is unchanged", () => {
  test("claimRepaymentReceipts still refuses a row a manual send already stamped", async () => {
    await withEmailEnv(async () => {
      const t = newT();
      const s = await setupChapter(t);
      await seedManager(s);
      const payer = await seedPayer(s, { email: "regression@example.com" });
      const a = await seedSettledRepayment(s, payer, 1_100);

      captureResend();
      await s.as.action(api.cards.sendRepaymentReceiptManually, { repaymentId: a });

      // The automatic claim must still see this as already-sent — a manual
      // send must never re-open the automatic path's exactly-once door.
      const claimed = await t.mutation(internal.cards.claimRepaymentReceipts, {
        repaymentIds: [a],
      });
      expect(claimed).toHaveLength(0);
    });
  });

  test("a row the automatic path already claimed is untouched by that claim a second time", async () => {
    await withEmailEnv(async () => {
      const t = newT();
      const s = await setupChapter(t);
      await seedManager(s);
      const payer = await seedPayer(s, { email: "auto@example.com" });
      const a = await seedSettledRepayment(s, payer, 1_100);

      const first = await t.mutation(internal.cards.claimRepaymentReceipts, {
        repaymentIds: [a],
      });
      expect(first).toHaveLength(1);
      const second = await t.mutation(internal.cards.claimRepaymentReceipts, {
        repaymentIds: [a],
      });
      expect(second).toHaveLength(0);
    });
  });
});

describe("manual receipt send — the row state the UI needs", () => {
  test("listPersonalRepayments returns the receipt fields a manual-send button reads", async () => {
    await withEmailEnv(async () => {
      const t = newT();
      const s = await setupChapter(t);
      await seedManager(s);
      const payer = await seedPayer(s, { email: "rowstate@example.com" });
      const neverSent = await seedSettledRepayment(s, payer, 300, {
        merchantName: "Never Sent Co",
      });
      const delivered = await seedSettledRepayment(s, payer, 400, {
        merchantName: "Delivered Co",
      });

      captureResend();
      await s.as.action(api.cards.sendRepaymentReceiptManually, {
        repaymentId: delivered,
      });

      const rows = await s.as.query(api.cards.listPersonalRepayments, {});
      const neverSentRow = rows.find((r) => r.id === neverSent)!;
      const deliveredRow = rows.find((r) => r.id === delivered)!;

      expect(neverSentRow.receiptSentAt).toBeNull();
      expect(neverSentRow.receiptDeliveredAt).toBeNull();
      expect(neverSentRow.receiptDeliveryFailedAt).toBeNull();

      expect(typeof deliveredRow.receiptSentAt).toBe("number");
      expect(typeof deliveredRow.receiptDeliveredAt).toBe("number");
      expect(deliveredRow.receiptDeliveryFailedAt).toBeNull();
    });
  });
});
