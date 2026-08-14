/// <reference types="vite/client" />
/**
 * THE PAYMENT RECEIPT — "thanks for paying this off, this is your receipt".
 *
 * Founder, 2026-08-14: "When people pay what they owe, we need to make sure
 * we send them an email saying, like, hey, thanks for paying this off. This
 * is your receipt, and then just send them the stripe receipt, and then the
 * line item, just so that they have that for their records … just in case
 * they need a receipt for showing that they did the payment."
 *
 * Three things these tests pin down:
 *
 *  1. ONE EMAIL PER PAYMENT. A single Checkout can settle SEVERAL repayments
 *     at once — the email itemizes every charge that payment cleared, and it
 *     is sent exactly once no matter how many rails or retries touch the
 *     underlying settlement.
 *  2. RAIL 3 (Increase ACH direct debit) HAS NO STRIPE CHARGE, and a live
 *     Stripe expand call can fail even on the two rails that do have one —
 *     either way the email is a COMPLETE, standalone receipt; the Stripe
 *     button is purely additive.
 *  3. AT MOST ONE RECEIPT PER REPAYMENT, EVER — `claimRepaymentReceipts`'
 *     per-row stamp survives a webhook retry and a direct re-run of the
 *     sender action.
 */
import { describe, expect, test, vi } from "vitest";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { buildRepaymentReceipt } from "../lib/personalRepaymentReceiptEmail";

async function seedPayer(
  s: ChapterSetup,
  opts: { email?: string; name?: string } = {},
): Promise<Id<"people">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: opts.name ?? "Pat Payer",
      userId: s.userId,
      isTeamMember: true,
      pwEmail: opts.email ?? "pat@publicworship.life",
      createdAt: Date.now(),
    }),
  );
}

async function seedRepayment(
  s: ChapterSetup,
  payerPersonId: Id<"people">,
  amountCents: number,
  opts: { merchantName?: string; postedAt?: number } = {},
): Promise<Id<"personalRepayments">> {
  const now = Date.now();
  const transactionId = await run(s.t, (ctx) =>
    ctx.db.insert("transactions", {
      chapterId: s.chapterId,
      source: "manual",
      flow: "outflow",
      amountCents,
      currency: "usd",
      postedAt: opts.postedAt ?? now,
      personId: payerPersonId,
      merchantName: opts.merchantName ?? "Corner Store",
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
      status: "pending",
      createdAt: now,
      updatedAt: now,
    }),
  );
  await run(s.t, (ctx) =>
    ctx.db.patch(transactionId, { isPersonal: true, repaymentId }),
  );
  return repaymentId;
}

/** Mock BOTH the Stripe PaymentIntent expand call AND
 *  `POST https://api.resend.com/emails`, recording every Resend send so the
 *  copy itself can be asserted. Mirrors `reimbursements.test.ts`'s
 *  `mockIncreaseAndResend`. */
function mockStripeAndResend(
  opts: { receiptUrl?: string | null; stripeStatus?: number } = {},
): Array<{ to: string; subject: string; html: string }> {
  const resendCalls: Array<{ to: string; subject: string; html: string }> = [];
  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const path = String(input);
    if (path.includes("/v1/payment_intents/")) {
      if (opts.stripeStatus && opts.stripeStatus !== 200) {
        return new Response("stripe error", { status: opts.stripeStatus });
      }
      const receiptUrl =
        opts.receiptUrl === undefined
          ? "https://pay.stripe.com/receipts/abc123"
          : opts.receiptUrl;
      return new Response(
        JSON.stringify({ latest_charge: { receipt_url: receiptUrl } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (path.includes("api.resend.com/emails")) {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      resendCalls.push({
        to: body.to,
        subject: body.subject,
        html: body.html ?? "",
      });
      return new Response(JSON.stringify({ id: "email_1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch: ${path}`);
  }) as unknown as typeof fetch;
  return resendCalls;
}

const realFetch = globalThis.fetch;

/** Snapshot every env var these tests touch, and restore it verbatim in
 *  `finally` — the same discipline `doorAccess.test.ts` uses for `APP_URL`. */
function snapshotEnv() {
  return {
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
    APP_URL: process.env.APP_URL,
  };
}
function restoreEnv(prev: ReturnType<typeof snapshotEnv>) {
  for (const [key, value] of Object.entries(prev)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  globalThis.fetch = realFetch;
}

describe("payment receipt — one email per payment", () => {
  test("a payment settling TWO repayments sends ONE email itemizing both charges, to the payer", async () => {
    vi.useFakeTimers();
    const prev = snapshotEnv();
    try {
      process.env.RESEND_API_KEY = "test_key";
      process.env.STRIPE_SECRET_KEY = "sk_test_123";
      process.env.APP_URL = "https://app.publicworship.life";
      const resendCalls = mockStripeAndResend();

      const t = newT();
      const s = await setupChapter(t);
      const payer = await seedPayer(s, { email: "pat@example.com", name: "Pat Payer" });
      const a = await seedRepayment(s, payer, 5_000, { merchantName: "Coffee Shop" });
      const b = await seedRepayment(s, payer, 3_000, { merchantName: "Hardware Store" });

      await t.mutation(internal.cards.applyRepaymentPaidFromStripe, {
        repaymentIds: [a, b],
        sessionId: "cs_bundle_1",
        paymentIntentId: "pi_bundle_1",
        amountTotalCents: 8_000,
      });
      await s.t.finishAllScheduledFunctions(vi.runAllTimers);

      const receipts = resendCalls.filter((c) => c.subject.startsWith("Receipt:"));
      expect(receipts).toHaveLength(1);
      expect(receipts[0].to).toBe("pat@example.com");
      expect(receipts[0].subject).toContain("$80.00");
      expect(receipts[0].html).toContain("Coffee Shop");
      expect(receipts[0].html).toContain("$50.00");
      expect(receipts[0].html).toContain("Hardware Store");
      expect(receipts[0].html).toContain("$30.00");
      // The Stripe receipt is purely additive when one is genuinely available.
      expect(receipts[0].html).toContain("https://pay.stripe.com/receipts/abc123");
      expect(receipts[0].html).toContain("View your Stripe receipt");
      // Never donation/tax language.
      expect(receipts[0].html.toLowerCase()).not.toContain("tax-deductible");
      expect(receipts[0].html.toLowerCase()).not.toContain("donation");

      // Both repayments are stamped, and both point at the SAME credit
      // machinery already asserted elsewhere — here we only need the receipt
      // side: neither is left unclaimed.
      const rows = await run(s.t, (ctx) => Promise.all([ctx.db.get(a), ctx.db.get(b)]));
      expect(typeof rows[0]?.receiptSentAt).toBe("number");
      expect(typeof rows[1]?.receiptSentAt).toBe("number");
    } finally {
      vi.useRealTimers();
      restoreEnv(prev);
    }
  });

  test("a REPEATED webhook delivery for the same session mails no second receipt", async () => {
    vi.useFakeTimers();
    const prev = snapshotEnv();
    try {
      process.env.RESEND_API_KEY = "test_key";
      process.env.APP_URL = "https://app.publicworship.life";
      const resendCalls = mockStripeAndResend({ receiptUrl: null });

      const t = newT();
      const s = await setupChapter(t);
      const payer = await seedPayer(s);
      const a = await seedRepayment(s, payer, 4_000);

      const settle = () =>
        t.mutation(internal.cards.applyRepaymentPaidFromStripe, {
          repaymentIds: [a],
          sessionId: "cs_retry_1",
          amountTotalCents: 4_000,
        });

      await settle();
      await s.t.finishAllScheduledFunctions(vi.runAllTimers);
      expect(
        resendCalls.filter((c) => c.subject.startsWith("Receipt:")).length,
      ).toBe(1);

      // Stripe redelivers the SAME event. `settleRepayment`'s guard means
      // nothing is newly outstanding, so the settlement caller schedules
      // nothing at all — see `applyRepaymentPaidFromStripe`'s doc.
      resendCalls.length = 0;
      await settle();
      await s.t.finishAllScheduledFunctions(vi.runAllTimers);
      expect(resendCalls.length).toBe(0);
    } finally {
      vi.useRealTimers();
      restoreEnv(prev);
    }
  });

  test("re-running the send action directly after the claim mails nobody twice", async () => {
    vi.useFakeTimers();
    const prev = snapshotEnv();
    try {
      process.env.RESEND_API_KEY = "test_key";
      process.env.APP_URL = "https://app.publicworship.life";
      const resendCalls = mockStripeAndResend({ receiptUrl: null });

      const t = newT();
      const s = await setupChapter(t);
      const payer = await seedPayer(s);
      const a = await seedRepayment(s, payer, 2_500);

      await t.mutation(internal.cards.applyRepaymentPaidFromStripe, {
        repaymentIds: [a],
        sessionId: "cs_direct_1",
        amountTotalCents: 2_500,
      });
      await s.t.finishAllScheduledFunctions(vi.runAllTimers);
      expect(
        resendCalls.filter((c) => c.subject.startsWith("Receipt:")).length,
      ).toBe(1);

      const stamped = await run(s.t, (ctx) => ctx.db.get(a));
      expect(typeof stamped?.receiptSentAt).toBe("number");

      resendCalls.length = 0;
      await t.action(internal.cards.sendRepaymentReceiptEmail, {
        repaymentIds: [a],
      });
      expect(resendCalls.length).toBe(0);
    } finally {
      vi.useRealTimers();
      restoreEnv(prev);
    }
  });
});

describe("payment receipt — the Increase rail (no Stripe charge)", () => {
  test("still renders a COMPLETE, standalone receipt — no Stripe button, no dangling copy", async () => {
    vi.useFakeTimers();
    const prev = snapshotEnv();
    try {
      process.env.RESEND_API_KEY = "test_key";
      process.env.APP_URL = "https://app.publicworship.life";
      // No STRIPE_SECRET_KEY at all — this rail never has a Stripe charge to
      // look up, so the fetch must never even need one.
      const resendCalls = mockStripeAndResend();

      const t = newT();
      const s = await setupChapter(t);
      const payer = await seedPayer(s, { email: "increase-payer@example.com" });
      const a = await seedRepayment(s, payer, 6_600, { merchantName: "Gas Station" });

      await t.mutation(internal.cards.applyRepaymentPaid, {
        repaymentId: a,
        increaseRef: "ach_transfer_xyz",
      });
      await s.t.finishAllScheduledFunctions(vi.runAllTimers);

      const receipts = resendCalls.filter((c) => c.subject.startsWith("Receipt:"));
      expect(receipts).toHaveLength(1);
      expect(receipts[0].to).toBe("increase-payer@example.com");
      expect(receipts[0].html).toContain("Gas Station");
      expect(receipts[0].html).toContain("$66.00");
      expect(receipts[0].html).toContain("Payment received");
      // No Stripe charge exists on this rail — no button, no dead link.
      expect(receipts[0].html).not.toContain("View your Stripe receipt");
    } finally {
      vi.useRealTimers();
      restoreEnv(prev);
    }
  });

  test("a FAILED Stripe fetch degrades to the same rail-3 shape rather than failing the send", async () => {
    vi.useFakeTimers();
    const prev = snapshotEnv();
    try {
      process.env.RESEND_API_KEY = "test_key";
      process.env.STRIPE_SECRET_KEY = "sk_test_down";
      process.env.APP_URL = "https://app.publicworship.life";
      const resendCalls = mockStripeAndResend({ stripeStatus: 500 });

      const t = newT();
      const s = await setupChapter(t);
      const payer = await seedPayer(s);
      const a = await seedRepayment(s, payer, 1_200);

      await expect(
        t.mutation(internal.cards.applyRepaymentPaidFromStripe, {
          repaymentIds: [a],
          sessionId: "cs_stripe_down",
          paymentIntentId: "pi_stripe_down",
          amountTotalCents: 1_200,
        }),
      ).resolves.toBeNull();
      // Draining must not throw even though the Stripe lookup inside the
      // scheduled action failed — the send itself still has to go out.
      await expect(
        s.t.finishAllScheduledFunctions(vi.runAllTimers),
      ).resolves.toBeUndefined();

      const receipts = resendCalls.filter((c) => c.subject.startsWith("Receipt:"));
      expect(receipts).toHaveLength(1);
      expect(receipts[0].html).not.toContain("View your Stripe receipt");
    } finally {
      vi.useRealTimers();
      restoreEnv(prev);
    }
  });
});

describe("payment receipt — fee coverage is named, never folded in", () => {
  test("a payer-covered Stripe fee is called out separately from the total", async () => {
    vi.useFakeTimers();
    const prev = snapshotEnv();
    try {
      process.env.RESEND_API_KEY = "test_key";
      process.env.APP_URL = "https://app.publicworship.life";
      const resendCalls = mockStripeAndResend({ receiptUrl: null });

      const t = newT();
      const s = await setupChapter(t);
      const payer = await seedPayer(s);
      const a = await seedRepayment(s, payer, 10_000);

      await t.mutation(internal.cards.applyRepaymentPaidFromStripe, {
        repaymentIds: [a],
        sessionId: "cs_fee_covered",
        amountTotalCents: 10_330, // debt + fee coverage
        feeCoverageCents: 330,
      });
      await s.t.finishAllScheduledFunctions(vi.runAllTimers);

      const receipts = resendCalls.filter((c) => c.subject.startsWith("Receipt:"));
      expect(receipts).toHaveLength(1);
      // The TOTAL named as "paid back" is the debt, not debt+fee.
      expect(receipts[0].subject).toContain("$100.00");
      expect(receipts[0].html).toContain("$3.30");
      expect(receipts[0].html).toContain("processing fees");
    } finally {
      vi.useRealTimers();
      restoreEnv(prev);
    }
  });
});

describe("payment receipt — the repayments link (APP_URL)", () => {
  test("with APP_URL set, the receipt's button links into the payer's repayments page", async () => {
    vi.useFakeTimers();
    const prev = snapshotEnv();
    try {
      process.env.RESEND_API_KEY = "test_key";
      process.env.APP_URL = "https://app.publicworship.life";
      const resendCalls = mockStripeAndResend({ receiptUrl: null });

      const t = newT();
      const s = await setupChapter(t);
      const payer = await seedPayer(s);
      const a = await seedRepayment(s, payer, 900);

      await t.mutation(internal.cards.applyRepaymentPaid, {
        repaymentId: a,
        increaseRef: "ach_xyz_2",
      });
      await s.t.finishAllScheduledFunctions(vi.runAllTimers);

      const receipts = resendCalls.filter((c) => c.subject.startsWith("Receipt:"));
      expect(receipts).toHaveLength(1);
      expect(receipts[0].html).toMatch(
        /<a[^>]*href="https:\/\/app\.publicworship\.life\/finances\/repayments"[^>]*>/,
      );
    } finally {
      vi.useRealTimers();
      restoreEnv(prev);
    }
  });

  test("with APP_URL unset, the receipt still sends (no dead link) and degrades LOUDLY via console.error", async () => {
    vi.useFakeTimers();
    const prev = snapshotEnv();
    try {
      process.env.RESEND_API_KEY = "test_key";
      delete process.env.APP_URL;
      // No Stripe charge on this rail either, so there is genuinely no
      // anchor tag anywhere in the email once APP_URL is gone.
      const resendCalls = mockStripeAndResend();
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const t = newT();
      const s = await setupChapter(t);
      const payer = await seedPayer(s);
      const a = await seedRepayment(s, payer, 1_500);

      await t.mutation(internal.cards.applyRepaymentPaid, {
        repaymentId: a,
        increaseRef: "ach_xyz_3",
      });
      await s.t.finishAllScheduledFunctions(vi.runAllTimers);

      const receipts = resendCalls.filter((c) => c.subject.startsWith("Receipt:"));
      expect(receipts).toHaveLength(1); // transactional — still sends
      expect(receipts[0].html).not.toMatch(/<a[^>]*href=/);
      expect(receipts[0].html).toContain("Finances");
      expect(
        errorSpy.mock.calls.some((c) => String(c[0]).includes("APP_URL is unset")),
      ).toBe(true);
      errorSpy.mockRestore();
    } finally {
      vi.useRealTimers();
      restoreEnv(prev);
    }
  });
});

describe("payment receipt — a lost delivery is recorded, not silent", () => {
  test("no email on file: recorded as a failure and logged, never silent", async () => {
    vi.useFakeTimers();
    const prev = snapshotEnv();
    try {
      process.env.RESEND_API_KEY = "test_key";
      process.env.APP_URL = "https://app.publicworship.life";
      mockStripeAndResend({ receiptUrl: null });
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const t = newT();
      const s = await setupChapter(t);
      // No `email` opt — `seedPayer` still needs SOME identity, so patch it
      // away after seeding rather than at insert time.
      const payer = await seedPayer(s, { email: "temp@example.com" });
      await run(s.t, (ctx) => ctx.db.patch(payer, { pwEmail: undefined, email: undefined }));
      const a = await seedRepayment(s, payer, 1_000);

      await t.mutation(internal.cards.applyRepaymentPaid, {
        repaymentId: a,
        increaseRef: "ach_no_email",
      });
      await s.t.finishAllScheduledFunctions(vi.runAllTimers);

      const row = await run(s.t, (ctx) => ctx.db.get(a));
      expect(typeof row?.receiptSentAt).toBe("number"); // claimed
      expect(row?.receiptDeliveredAt).toBeUndefined();
      expect(typeof row?.receiptDeliveryFailedAt).toBe("number");
      expect(row?.lastReceiptError).toMatch(/no email/i);

      // The no-email branch used to log NOTHING — now it must correlate
      // back to the repayment.
      expect(
        errorSpy.mock.calls.some(
          (c) =>
            String(c[0]).includes("no email on file") &&
            JSON.stringify(c).includes(a),
        ),
      ).toBe(true);
      errorSpy.mockRestore();
    } finally {
      vi.useRealTimers();
      restoreEnv(prev);
    }
  });

  test("Resend rejects the send: recorded as a failure, never marked delivered", async () => {
    vi.useFakeTimers();
    const prev = snapshotEnv();
    try {
      process.env.RESEND_API_KEY = "test_key";
      process.env.APP_URL = "https://app.publicworship.life";
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        if (String(input).includes("api.resend.com")) {
          return new Response("rate limited", { status: 429 });
        }
        throw new Error(`unexpected fetch: ${String(input)}`);
      }) as unknown as typeof fetch;
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const t = newT();
      const s = await setupChapter(t);
      const payer = await seedPayer(s, { email: "rejected@example.com" });
      const a = await seedRepayment(s, payer, 2_200);

      await t.mutation(internal.cards.applyRepaymentPaid, {
        repaymentId: a,
        increaseRef: "ach_rejected",
      });
      await s.t.finishAllScheduledFunctions(vi.runAllTimers);

      const row = await run(s.t, (ctx) => ctx.db.get(a));
      expect(row?.receiptDeliveredAt).toBeUndefined();
      expect(typeof row?.receiptDeliveryFailedAt).toBe("number");
      expect(row?.lastReceiptError).toMatch(/resend/i);
      expect(
        errorSpy.mock.calls.some((c) =>
          String(c[0]).includes("Resend did not accept the send"),
        ),
      ).toBe(true);
      errorSpy.mockRestore();
    } finally {
      vi.useRealTimers();
      restoreEnv(prev);
    }
  });

  test("a confirmed successful send stamps receiptDeliveredAt (never a failure field)", async () => {
    vi.useFakeTimers();
    const prev = snapshotEnv();
    try {
      process.env.RESEND_API_KEY = "test_key";
      process.env.APP_URL = "https://app.publicworship.life";
      mockStripeAndResend({ receiptUrl: null });

      const t = newT();
      const s = await setupChapter(t);
      const payer = await seedPayer(s, { email: "delivered@example.com" });
      const a = await seedRepayment(s, payer, 500);

      await t.mutation(internal.cards.applyRepaymentPaid, {
        repaymentId: a,
        increaseRef: "ach_delivered",
      });
      await s.t.finishAllScheduledFunctions(vi.runAllTimers);

      const row = await run(s.t, (ctx) => ctx.db.get(a));
      expect(typeof row?.receiptDeliveredAt).toBe("number");
      expect(row?.receiptDeliveryFailedAt).toBeUndefined();
      expect(row?.lastReceiptError).toBeUndefined();
    } finally {
      vi.useRealTimers();
      restoreEnv(prev);
    }
  });
});

describe("payment receipt — cross-payer batch is refused, not merged", () => {
  test("getRepaymentReceiptPayload throws rather than silently attributing a mixed batch", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const payerA = await seedPayer(s, { email: "a@example.com", name: "Payer A" });
    const payerB = await seedPayer(s, { email: "b@example.com", name: "Payer B" });
    const a = await seedRepayment(s, payerA, 1_000);
    const b = await seedRepayment(s, payerB, 2_000);

    await expect(
      t.query(internal.cards.getRepaymentReceiptPayload, { repaymentIds: [a, b] }),
    ).rejects.toThrow(/more than one payer/i);
  });
});

describe("payment receipt — stripe receipt URL is escaped and scheme-validated", () => {
  const baseInput = {
    payerName: "Pat Payer",
    paidAt: Date.UTC(2026, 7, 1),
    lines: [{ merchantName: "Coffee Shop", description: null, chargeDate: null, amountCents: 500 }],
    totalCents: 500,
    method: "card" as const,
    feeCoveredCents: null,
    link: "https://app.publicworship.life/finances/repayments",
  };

  test("an embedded quote + <script> in an https:// receipt URL cannot break out of the href", () => {
    const hostile =
      'https://evil.example.com/receipt"><script>alert(document.cookie)</script><a href="';
    const receipt = buildRepaymentReceipt({ ...baseInput, stripeReceiptUrl: hostile });

    // The quote must be escaped, so the payload can never close the
    // attribute and open a live tag.
    expect(receipt.html).not.toContain('"><script>');
    expect(receipt.html).not.toContain("<script>alert(document.cookie)</script>");
    // The escaped form is present instead — proof the URL was rendered, not
    // silently dropped, just neutralized.
    expect(receipt.html).toContain("&quot;&gt;&lt;script&gt;");
  });

  test("a javascript: scheme is dropped entirely — no button, no dangerous href", () => {
    const receipt = buildRepaymentReceipt({
      ...baseInput,
      stripeReceiptUrl: "javascript:alert(1)",
    });

    expect(receipt.html.toLowerCase()).not.toContain("javascript:");
    expect(receipt.html).not.toContain("View your Stripe receipt");
  });

  test("a plain http:// (non-https) receipt URL is also dropped", () => {
    const receipt = buildRepaymentReceipt({
      ...baseInput,
      stripeReceiptUrl: "http://not-secure.example.com/receipt",
    });

    expect(receipt.html).not.toContain("http://not-secure.example.com");
    expect(receipt.html).not.toContain("View your Stripe receipt");
  });

  test("a genuine https:// receipt URL still renders the button", () => {
    const receipt = buildRepaymentReceipt({
      ...baseInput,
      stripeReceiptUrl: "https://pay.stripe.com/receipts/abc123",
    });

    expect(receipt.html).toContain("https://pay.stripe.com/receipts/abc123");
    expect(receipt.html).toContain("View your Stripe receipt");
  });
});

/**
 * Settle a repayment for real (so `status`/`creditTransactionId` are
 * genuine, not fabricated) and let its live receipt attempt run to
 * completion, then hand back the row so a test can rewrite its
 * delivery-outcome fields to simulate "stale and never confirmed" without
 * inventing an invalid `creditTransactionId`.
 */
async function settleAndDrain(
  s: ChapterSetup,
  repaymentId: Id<"personalRepayments">,
  increaseRef: string,
) {
  await s.t.mutation(internal.cards.applyRepaymentPaid, { repaymentId, increaseRef });
  await s.t.finishAllScheduledFunctions(vi.runAllTimers);
}

describe("payment receipt backfill — recovers a lost delivery", () => {
  test("dry run reports the backlog but sends and claims nothing", async () => {
    vi.useFakeTimers();
    const prev = snapshotEnv();
    try {
      // Settle with NO Resend key configured — a realistic "delivery
      // failed" row, no email actually sent.
      const t = newT();
      const s = await setupChapter(t);
      const payer = await seedPayer(s, { email: "backlog@example.com" });
      const a = await seedRepayment(s, payer, 1_500);
      await settleAndDrain(s, a, "ach_backlog_1");

      const stamped = await run(s.t, (ctx) => ctx.db.get(a));
      expect(typeof stamped?.receiptDeliveryFailedAt).toBe("number"); // no key → failed

      // Age the claim past the in-flight grace window so the backlog picks
      // it up.
      await run(s.t, (ctx) =>
        ctx.db.patch(a, { receiptSentAt: Date.now() - 20 * 60 * 1000 }),
      );

      const result = await t.action(
        internal.repaymentReceiptBackfill.backfillRepaymentReceipts,
        {},
      );
      expect(result.eligible).toBeGreaterThanOrEqual(1);
      expect(result.claimed).toBe(0);

      const row = await run(s.t, (ctx) => ctx.db.get(a));
      expect(row?.receiptDeliveredAt).toBeUndefined();
      expect(row?.lastReceiptError).toBeDefined();
    } finally {
      vi.useRealTimers();
      restoreEnv(prev);
    }
  });

  test("execute re-sends a stale, never-confirmed receipt and clears the failure fields", async () => {
    vi.useFakeTimers();
    const prev = snapshotEnv();
    try {
      // Settle with NO Resend key first — the original attempt fails.
      const t = newT();
      const s = await setupChapter(t);
      const payer = await seedPayer(s, { email: "recovered@example.com" });
      const a = await seedRepayment(s, payer, 4_400, { merchantName: "Print Shop" });
      await settleAndDrain(s, a, "ach_recovered_1");

      const failed = await run(s.t, (ctx) => ctx.db.get(a));
      expect(typeof failed?.receiptDeliveryFailedAt).toBe("number");

      // Age the claim past the grace window, THEN configure Resend for the
      // retry — mirrors "the outage that caused the original failure is
      // over by the time a maintainer runs the backfill".
      await run(s.t, (ctx) =>
        ctx.db.patch(a, { receiptSentAt: Date.now() - 20 * 60 * 1000 }),
      );
      process.env.RESEND_API_KEY = "test_key";
      process.env.APP_URL = "https://app.publicworship.life";
      const resendCalls = mockStripeAndResend({ receiptUrl: null });

      const result = await t.action(
        internal.repaymentReceiptBackfill.backfillRepaymentReceipts,
        { execute: true },
      );
      expect(result.claimed).toBe(1);
      expect(result.delivered).toBe(1);

      const receipts = resendCalls.filter((c) => c.subject.startsWith("Receipt:"));
      expect(receipts).toHaveLength(1);
      expect(receipts[0].to).toBe("recovered@example.com");
      expect(receipts[0].html).toContain("Print Shop");

      const row = await run(s.t, (ctx) => ctx.db.get(a));
      expect(typeof row?.receiptDeliveredAt).toBe("number");
      expect(row?.receiptDeliveryFailedAt).toBeUndefined();
      expect(row?.lastReceiptError).toBeUndefined();

      // A SECOND run must not re-send — the row now reads as delivered.
      resendCalls.length = 0;
      const second = await t.action(
        internal.repaymentReceiptBackfill.backfillRepaymentReceipts,
        { execute: true },
      );
      expect(second.eligible).toBe(0);
      expect(resendCalls.length).toBe(0);
    } finally {
      vi.useRealTimers();
      restoreEnv(prev);
    }
  });

  test("a freshly-claimed row still inside the in-flight grace window is left alone", async () => {
    vi.useFakeTimers();
    const prev = snapshotEnv();
    try {
      const t = newT();
      const s = await setupChapter(t);
      const payer = await seedPayer(s, { email: "inflight@example.com" });
      const a = await seedRepayment(s, payer, 900);
      await settleAndDrain(s, a, "ach_inflight_1");

      // Simulate "claimed, outcome not yet resolved" — a state the live
      // code always resolves out of by the time its action returns, but
      // the row can transiently look like this, and the backfill must not
      // treat it as ready.
      await run(s.t, (ctx) =>
        ctx.db.patch(a, {
          receiptSentAt: Date.now(), // just claimed
          receiptDeliveredAt: undefined,
          receiptDeliveryFailedAt: undefined,
          lastReceiptError: undefined,
        }),
      );

      const result = await t.action(
        internal.repaymentReceiptBackfill.backfillRepaymentReceipts,
        { execute: true },
      );
      expect(result.eligible).toBe(0);
      expect(result.claimed).toBe(0);
    } finally {
      vi.useRealTimers();
      restoreEnv(prev);
    }
  });
});

describe("payment receipt — degrades without RESEND_API_KEY", () => {
  test("settlement still succeeds and draining doesn't throw with no Resend key configured", async () => {
    vi.useFakeTimers();
    const prev = snapshotEnv();
    try {
      delete process.env.RESEND_API_KEY;
      globalThis.fetch = (async () => {
        throw new Error("no network calls expected");
      }) as unknown as typeof fetch;

      const t = newT();
      const s = await setupChapter(t);
      const payer = await seedPayer(s);
      const a = await seedRepayment(s, payer, 750);

      await expect(
        t.mutation(internal.cards.applyRepaymentPaidFromStripe, {
          repaymentIds: [a],
          sessionId: "cs_no_key",
          amountTotalCents: 750,
        }),
      ).resolves.toBeNull();
      await expect(
        s.t.finishAllScheduledFunctions(vi.runAllTimers),
      ).resolves.toBeUndefined();

      // Claimed anyway (see `claimRepaymentReceipts`'s doc) — a contact-less
      // or key-less row must not sit in a backlog forever waiting for an
      // email that can never be written.
      const stamped = await run(s.t, (ctx) => ctx.db.get(a));
      expect(typeof stamped?.receiptSentAt).toBe("number");
    } finally {
      vi.useRealTimers();
      restoreEnv(prev);
    }
  });
});
