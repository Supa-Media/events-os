/// <reference types="vite/client" />
import { describe, expect, test, vi } from "vitest";
import { DAY_MS } from "@events-os/shared";
import { newT, run, setupChapter, storeBlob, type ChapterSetup } from "./setup.helpers";
import { api, internal } from "../_generated/api";
import {
  chargeOutstanding,
  isUncodedCharge,
  outstandingLabel,
} from "../lib/codingReminders";
import type { Id } from "../_generated/dataModel";
import { LOST_RECEIPT_CHECKS } from "@events-os/shared";
/** Every lost-receipt check answered yes — since 2026-08-09 the interactive
 *  `receiptExceptions.attest` refuses a `lost` exception without them (the
 *  staged "did you actually look?" gauntlet). Bulk/backfill paths are
 *  deliberately exempt, so only fixtures that go through `attest` need this. */
const LOST_CHECKS = LOST_RECEIPT_CHECKS.map((c) => ({
  key: c.key,
  prompt: c.prompt,
  answer: true,
}));


/**
 * Phase 2 of `docs/plans/transaction-coding.md`: the cardholder chase rekeyed
 * from RECEIPTS onto CODINGS (owner decision, 2026-08-08 — "we shouldn't send
 * reminders for receipts, we should send reminders to code transactions"), the
 * send-back notification that closes the review loop, and the 60-day
 * accountable-plan clock that ends an uncoded charge as a personal repayment.
 *
 * These suites deliberately ARM the policy — `codingRequiredSinceMs` is pushed
 * into the past so a `Date.now()`-aged fixture is post-policy, which is what
 * every chapter's data looks like from September 1 onward. (Suites that are
 * NOT about coding do the opposite via `disarmCodingPolicy`.)
 */

/**
 * Arm the coding policy for this test database.
 *
 * BOTH dates, because there are two (see
 * `DEFAULT_CODING_CONVERSION_SINCE_MS`): `codingRequiredSinceMs` says a charge
 * owes a coding, `codingConversionSinceMs` says it can be billed back for not
 * having one. `conversionSinceDaysAgo` defaults to `sinceDaysAgo` so "armed"
 * means fully armed, which is what every pre-existing caller here meant —
 * leaving the conversion date on its real-world default (2026-09-01, still in
 * the future) would silently stop these fixtures converting and read as a
 * regression in the sweep rather than an unset setting. Tests that care about
 * the GAP between the two dates pass them separately.
 */
async function armCodingPolicy(
  s: ChapterSetup,
  opts: {
    sinceDaysAgo?: number;
    conversionSinceDaysAgo?: number;
    overdueDays?: number;
    noReceiptDays?: number;
  } = {},
): Promise<void> {
  const sinceDaysAgo = opts.sinceDaysAgo ?? 365;
  const patch = {
    codingRequiredSinceMs: Date.now() - sinceDaysAgo * DAY_MS,
    codingConversionSinceMs:
      Date.now() - (opts.conversionSinceDaysAgo ?? sinceDaysAgo) * DAY_MS,
    codingOverdueDays: opts.overdueDays,
    noReceiptAutoConvertDays: opts.noReceiptDays,
    updatedAt: Date.now(),
  };
  await run(s.t, async (ctx) => {
    const existing = await ctx.db.query("financeSettings").first();
    if (existing) await ctx.db.patch(existing._id, patch);
    else await ctx.db.insert("financeSettings", { sandboxMode: false, ...patch });
  });
}

async function seedPerson(
  s: ChapterSetup,
  name: string,
  opts: { pwEmail?: string; self?: boolean } = {},
): Promise<Id<"people">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name,
      pwEmail: opts.pwEmail,
      userId: opts.self ? s.userId : undefined,
      isTeamMember: true,
      createdAt: Date.now(),
    }),
  );
}

async function asManager(s: ChapterSetup, name = "Manager Mo"): Promise<Id<"people">> {
  const personId = await seedPerson(s, name, { pwEmail: "mo@publicworship.life", self: true });
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

interface ChapterMember {
  as: ReturnType<ChapterSetup["t"]["withIdentity"]>;
  personId: Id<"people">;
}

/** A second authenticated member — their own `users`/`userChapters`/`people`
 *  rows — so a test can have a real cardholder who is NOT the manager. */
async function addCardholder(
  s: ChapterSetup,
  opts: { email: string; name: string },
): Promise<ChapterMember> {
  const userId = await run(s.t, (ctx) =>
    ctx.db.insert("users", { email: opts.email }),
  );
  await run(s.t, (ctx) =>
    ctx.db.insert("userChapters", {
      userId,
      chapterId: s.chapterId,
      role: "member",
      isActive: true,
      joinedAt: Date.now(),
    }),
  );
  const personId = await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: opts.name,
      pwEmail: opts.email,
      userId,
      isTeamMember: true,
      createdAt: Date.now(),
    }),
  );
  return {
    as: s.t.withIdentity({ subject: `${userId}|session`, issuer: "test" }),
    personId,
  };
}

async function seedCard(
  s: ChapterSetup,
  cardholderPersonId: Id<"people">,
): Promise<Id<"cards">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("cards", {
      chapterId: s.chapterId,
      cardholderPersonId,
      type: "virtual",
      status: "active",
      createdAt: Date.now(),
    }),
  );
}

async function seedCharge(
  s: ChapterSetup,
  opts: {
    cardId?: Id<"cards">;
    personId?: Id<"people">;
    ageDays?: number;
    amountCents?: number;
    merchantName?: string;
    receiptStorageId?: Id<"_storage">;
    // `undefined` IS "uncoded" — the denorm only carries the states a coding
    // row can be in (`TRANSACTION_CODING_STATUSES`).
    codingState?: "submitted" | "changes_requested" | "approved";
    /** The processor-fee marker `processorFees.ts` stamps. Its presence — not
     *  the category the row is coded to — is what exempts a row from the
     *  chase. */
    feeOrigin?: "stripe_processing" | "givebutter_processing";
    status?: "unreviewed" | "categorized" | "reconciled" | "excluded";
  },
): Promise<Id<"transactions">> {
  const now = Date.now();
  return await run(s.t, (ctx) =>
    ctx.db.insert("transactions", {
      chapterId: s.chapterId,
      source: "manual",
      flow: "outflow",
      amountCents: opts.amountCents ?? 4200,
      postedAt: now - (opts.ageDays ?? 0) * DAY_MS,
      merchantName: opts.merchantName ?? "Delta",
      cardId: opts.cardId,
      personId: opts.personId,
      receiptStorageId: opts.receiptStorageId,
      codingState: opts.codingState,
      feeOrigin: opts.feeOrigin,
      status: opts.status ?? "unreviewed",
      createdAt: now,
    }),
  );
}

// ── The fee carve-out, at the predicate itself ───────────────────────────────

/**
 * `chargeOutstanding` / `isUncodedCharge` are the predicates every reminder
 * surface reads. They exempted nothing for `feeOrigin` while
 * `finances.needsDocumentation` and `finances.requiresCoding` both did, so a
 * processor fee row answered "needs coding and a receipt" — for a receipt that
 * does not exist and a decision nobody made.
 *
 * Asserted here at the function, not only through a query, because the
 * exemption now comes from ONE shared place (`@events-os/shared#isNonDiscretionaryFee`,
 * via `chaseEligible`) and this is the level a future copy would drift at.
 */
describe("chargeOutstanding — a processor fee owes nothing, a chosen purchase still does", () => {
  async function outstandingFor(
    s: ChapterSetup,
    txnId: Id<"transactions">,
  ): Promise<string | null> {
    const txn = await run(s.t, (ctx) => ctx.db.get(txnId));
    const settings = await run(s.t, (ctx) =>
      ctx.db.query("financeSettings").first(),
    );
    return chargeOutstanding(txn!, settings!.codingRequiredSinceMs!);
  }

  test("a POST-policy fee row is not chased; a discretionary subscription is", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await armCodingPolicy(s);
    // Both rows land in "Bank & Fees" in real books. Only one was a decision.
    const fee = await seedCharge(s, {
      ageDays: 10,
      amountCents: 289,
      merchantName: "Stripe processing fees",
      feeOrigin: "stripe_processing",
      status: "categorized",
    });
    const subscription = await seedCharge(s, {
      ageDays: 10,
      amountCents: 4200,
      merchantName: "Givebutter Plus",
      status: "categorized",
    });

    expect(await outstandingFor(s, fee)).toBeNull();
    expect(await outstandingFor(s, subscription)).toBe(
      "needs coding and a receipt",
    );
  });

  test("a PRE-policy fee row is not chased for a receipt either", async () => {
    const t = newT();
    const s = await setupChapter(t);
    // Policy armed only 30 days back; both rows posted 200 days ago, so the
    // coding half is off and "needs a receipt" is the whole question. The
    // date was never the reason a fee is exempt — the origin is.
    await armCodingPolicy(s, { sinceDaysAgo: 30 });
    const fee = await seedCharge(s, {
      ageDays: 200,
      merchantName: "Givebutter processing fees",
      feeOrigin: "givebutter_processing",
      status: "categorized",
    });
    const subscription = await seedCharge(s, {
      ageDays: 200,
      merchantName: "Givebutter Plus",
      status: "categorized",
    });

    expect(await outstandingFor(s, fee)).toBeNull();
    expect(await outstandingFor(s, subscription)).toBe("needs a receipt");
  });

  test("isUncodedCharge — the 60-day accountable-plan clock never runs on a fee", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await armCodingPolicy(s);
    const fee = await seedCharge(s, {
      ageDays: 90,
      feeOrigin: "stripe_processing",
      status: "categorized",
    });
    const subscription = await seedCharge(s, { ageDays: 90, status: "categorized" });
    const settings = await run(s.t, (ctx) =>
      ctx.db.query("financeSettings").first(),
    );
    const sinceMs = settings!.codingRequiredSinceMs!;
    const feeDoc = await run(s.t, (ctx) => ctx.db.get(fee));
    const subDoc = await run(s.t, (ctx) => ctx.db.get(subscription));

    // A fee billed back to a cardholder as a personal repayment for "not being
    // coded" is the worst version of this bug, and this is the gate.
    expect(isUncodedCharge(feeDoc!, sinceMs)).toBe(false);
    expect(isUncodedCharge(subDoc!, sinceMs)).toBe(true);
  });
});

// ── The chase is about codings now, not receipts ─────────────────────────────

describe("advanceReceiptReminders — rekeyed onto codings", () => {
  test("chases a post-policy charge that HAS a receipt but no coding", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await armCodingPolicy(s);
    const holder = await seedPerson(s, "Holder");
    const cardId = await seedCard(s, holder);
    const receiptId = await storeBlob(s.t);
    const txnId = await seedCharge(s, { cardId, ageDays: 4, receiptStorageId: receiptId });

    const r = await s.t.mutation(internal.cards.advanceReceiptReminders, {});
    expect(r.escalated).toEqual([txnId]);
    expect(
      (await run(s.t, (ctx) => ctx.db.get(txnId)))?.receiptReminderStage,
    ).toBe("escalated");
  });

  test("leaves a receipted + APPROVED charge alone — nothing left to ask for", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await armCodingPolicy(s);
    const holder = await seedPerson(s, "Holder");
    const cardId = await seedCard(s, holder);
    const receiptId = await storeBlob(s.t);
    await seedCharge(s, {
      cardId,
      ageDays: 4,
      receiptStorageId: receiptId,
      codingState: "approved",
    });

    const r = await s.t.mutation(internal.cards.advanceReceiptReminders, {});
    expect(r.flagged).toEqual([]);
    expect(r.escalated).toEqual([]);
  });

  test("a coding sitting in review is NOT chased; one sent back IS", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await armCodingPolicy(s);
    const holder = await seedPerson(s, "Holder");
    const cardId = await seedCard(s, holder);
    const receiptId = await storeBlob(s.t);
    const inReview = await seedCharge(s, {
      cardId,
      ageDays: 4,
      receiptStorageId: receiptId,
      codingState: "submitted",
    });
    const sentBack = await seedCharge(s, {
      cardId,
      ageDays: 5,
      receiptStorageId: await storeBlob(s.t),
      codingState: "changes_requested",
    });

    const r = await s.t.mutation(internal.cards.advanceReceiptReminders, {});
    expect(r.escalated).toEqual([sentBack]);
    expect(
      (await run(s.t, (ctx) => ctx.db.get(inReview)))?.receiptReminderStage,
    ).toBeUndefined();
  });

  test("GRANDFATHERING — a pre-policy receipted charge is never chased for coding", async () => {
    const t = newT();
    const s = await setupChapter(t);
    // Policy armed only 3 days ago; the charge posted 10 days ago.
    await armCodingPolicy(s, { sinceDaysAgo: 3 });
    const holder = await seedPerson(s, "Holder");
    const cardId = await seedCard(s, holder);
    const receiptId = await storeBlob(s.t);
    await seedCharge(s, { cardId, ageDays: 10, receiptStorageId: receiptId });

    const r = await s.t.mutation(internal.cards.advanceReceiptReminders, {});
    expect(r.flagged).toEqual([]);
    expect(r.escalated).toEqual([]);
  });
});

describe("getReceiptReminderDigests — one email, per-line debts", () => {
  test("labels each charge with what IT owes and flags which are lockable", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await armCodingPolicy(s);
    const holder = await seedPerson(s, "Ada", { pwEmail: "ada@publicworship.life" });
    const cardId = await seedCard(s, holder);
    const noReceipt = await seedCharge(s, { cardId, ageDays: 4, amountCents: 1500 });
    const codingOnly = await seedCharge(s, {
      cardId,
      ageDays: 4,
      amountCents: 2500,
      receiptStorageId: await storeBlob(s.t),
    });
    const sentBack = await seedCharge(s, {
      cardId,
      ageDays: 4,
      amountCents: 3500,
      receiptStorageId: await storeBlob(s.t),
      codingState: "changes_requested",
    });

    const digests = await s.t.query(internal.cards.getReceiptReminderDigests, {
      flagged: [noReceipt, codingOnly, sentBack],
      escalated: [],
    });
    expect(digests).toHaveLength(1);
    const byAmount = new Map(digests[0].charges.map((c) => [c.amountCents, c]));
    expect(byAmount.get(1500)?.outstanding).toBe("needs coding and a receipt");
    expect(byAmount.get(1500)?.missingReceipt).toBe(true);
    expect(byAmount.get(2500)?.outstanding).toBe("needs coding");
    expect(byAmount.get(2500)?.missingReceipt).toBe(false);
    expect(byAmount.get(3500)?.outstanding).toBe("sent back — needs your edit");
    expect(byAmount.get(3500)?.needsCoding).toBe(true);
  });

  test("drops a charge that settled between the sweep and the send", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await armCodingPolicy(s);
    const holder = await seedPerson(s, "Ada", { pwEmail: "ada@publicworship.life" });
    const cardId = await seedCard(s, holder);
    const settled = await seedCharge(s, {
      cardId,
      ageDays: 4,
      receiptStorageId: await storeBlob(s.t),
      codingState: "approved",
    });

    const digests = await s.t.query(internal.cards.getReceiptReminderDigests, {
      flagged: [settled],
      escalated: [],
    });
    expect(digests).toEqual([]);
  });
});

describe("getCodingChaseTargets — the FM's on-demand chase", () => {
  test("picks up a coding-only debt, labelled, alongside a missing receipt", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await armCodingPolicy(s);
    await asManager(s);
    const holder = await seedPerson(s, "Holder", {
      pwEmail: "holder@publicworship.life",
    });
    const cardId = await seedCard(s, holder);
    await seedCharge(s, {
      cardId,
      ageDays: 4,
      amountCents: 2500,
      receiptStorageId: await storeBlob(s.t),
    });
    await seedCharge(s, { cardId, ageDays: 4, amountCents: 900 });

    const targets = await s.as.query(internal.finances.getCodingChaseTargets, {});
    const holderTarget = targets.find((x) => x.personId === holder)!;
    expect(holderTarget.charges).toHaveLength(2);
    const byAmount = new Map(holderTarget.charges.map((c) => [c.amountCents, c]));
    expect(byAmount.get(2500)?.outstanding).toBe("needs coding");
    expect(byAmount.get(900)?.outstanding).toBe("needs coding and a receipt");
  });
});

describe("the digest email itself", () => {
  const realFetch = globalThis.fetch;

  test('says "N charges to code" and links at My Transactions', async () => {
    const prevAppUrl = process.env.APP_URL;
    const prevResendKey = process.env.RESEND_API_KEY;
    process.env.APP_URL = "https://app.publicworship.life";
    process.env.RESEND_API_KEY = "resend_test_key";
    try {
      const t = newT();
      const s = await setupChapter(t);
      await armCodingPolicy(s);
      const holder = await seedPerson(s, "Ada", { pwEmail: "ada@publicworship.life" });
      const cardId = await seedCard(s, holder);
      await seedCharge(s, { cardId, ageDays: 4, amountCents: 1500 });
      await seedCharge(s, {
        cardId,
        ageDays: 4,
        amountCents: 2500,
        receiptStorageId: await storeBlob(s.t),
      });

      const sent: { to: string; subject: string; html: string }[] = [];
      globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
        const body = init?.body ? JSON.parse(init.body) : {};
        sent.push({ to: body.to, subject: body.subject, html: body.html });
        return { ok: true, status: 200, text: async () => "{}" };
      }) as unknown as typeof fetch;

      const out = await s.t.action(internal.cards.sendReceiptReminders, {});
      expect(out.escalatedCount).toBe(2);
      expect(sent).toHaveLength(1);
      expect(sent[0].to).toBe("ada@publicworship.life");
      expect(sent[0].subject).toContain("2 charges to code");
      expect(sent[0].html).toMatch(
        // `/code`, not the finance tab: a cardholder's nudge lands on their
        // own charges with no app chrome and no finance seat required.
        /href="https:\/\/app\.publicworship\.life\/code\?filter=uncoded"/,
      );
      // The plain-words reason the deadline exists, and the honest lock
      // warning — only the un-receipted charge can actually lock the card.
      expect(sent[0].html).toContain("taxable income");
      expect(sent[0].html).toContain("locks your card");
    } finally {
      globalThis.fetch = realFetch;
      if (prevAppUrl === undefined) delete process.env.APP_URL;
      else process.env.APP_URL = prevAppUrl;
      if (prevResendKey === undefined) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = prevResendKey;
    }
  });

  test("never threatens a card lock when only the coding is missing", async () => {
    const prevAppUrl = process.env.APP_URL;
    const prevResendKey = process.env.RESEND_API_KEY;
    process.env.APP_URL = "https://app.publicworship.life";
    process.env.RESEND_API_KEY = "resend_test_key";
    try {
      const t = newT();
      const s = await setupChapter(t);
      await armCodingPolicy(s);
      const holder = await seedPerson(s, "Ada", { pwEmail: "ada@publicworship.life" });
      const cardId = await seedCard(s, holder);
      await seedCharge(s, {
        cardId,
        ageDays: 4,
        amountCents: 2500,
        receiptStorageId: await storeBlob(s.t),
      });

      const sent: { subject: string; html: string }[] = [];
      globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
        const body = init?.body ? JSON.parse(init.body) : {};
        sent.push({ subject: body.subject, html: body.html });
        return { ok: true, status: 200, text: async () => "{}" };
      }) as unknown as typeof fetch;

      await s.t.action(internal.cards.sendReceiptReminders, {});
      expect(sent).toHaveLength(1);
      expect(sent[0].html).not.toContain("locks your card");
      expect(sent[0].html).toContain("taxable income");
    } finally {
      globalThis.fetch = realFetch;
      if (prevAppUrl === undefined) delete process.env.APP_URL;
      else process.env.APP_URL = prevAppUrl;
      if (prevResendKey === undefined) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = prevResendKey;
    }
  });
});

// ── The 60-day accountable-plan clock ────────────────────────────────────────

describe("autoConvertOverdueReceipts — the coding clock", () => {
  async function repaymentsFor(s: ChapterSetup, txnId: Id<"transactions">) {
    return await run(s.t, (ctx) =>
      ctx.db
        .query("personalRepayments")
        .withIndex("by_transaction", (q) => q.eq("transactionId", txnId))
        .collect(),
    );
  }

  test("converts a charge still uncoded past the deadline — even with the no-receipt policy OFF", async () => {
    vi.useFakeTimers();
    try {
      const t = newT();
      const s = await setupChapter(t);
      // No `noReceiptAutoConvertDays` at all: the accountable-plan clock is
      // not a preference, it's the IRS safe harbor.
      await armCodingPolicy(s);
      const holder = await seedPerson(s, "Holder");
      const cardId = await seedCard(s, holder);
      const txnId = await seedCharge(s, {
        cardId,
        ageDays: 70,
        receiptStorageId: await storeBlob(s.t),
      });

      const r = await s.t.mutation(internal.cards.autoConvertOverdueReceipts, {});
      await s.t.finishAllScheduledFunctions(vi.runAllTimers);
      expect(r.convertedCount).toBe(1);
      const txn = await run(s.t, (ctx) => ctx.db.get(txnId));
      expect(txn?.isPersonal).toBe(true);
      expect((await repaymentsFor(s, txnId))[0]?.payerPersonId).toBe(holder);
    } finally {
      vi.useRealTimers();
    }
  });

  test("leaves an APPROVED coding, and a charge still inside the window, alone", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await armCodingPolicy(s);
    const holder = await seedPerson(s, "Holder");
    const cardId = await seedCard(s, holder);
    const approved = await seedCharge(s, {
      cardId,
      ageDays: 70,
      receiptStorageId: await storeBlob(s.t),
      codingState: "approved",
    });
    const young = await seedCharge(s, {
      cardId,
      ageDays: 30,
      receiptStorageId: await storeBlob(s.t),
    });

    const r = await s.t.mutation(internal.cards.autoConvertOverdueReceipts, {});
    expect(r.convertedCount).toBe(0);
    expect((await repaymentsFor(s, approved)).length).toBe(0);
    expect((await repaymentsFor(s, young)).length).toBe(0);
  });

  test("honors a shortened codingOverdueDays", async () => {
    vi.useFakeTimers();
    try {
      const t = newT();
      const s = await setupChapter(t);
      await armCodingPolicy(s, { overdueDays: 10 });
      const holder = await seedPerson(s, "Holder");
      const cardId = await seedCard(s, holder);
      const txnId = await seedCharge(s, {
        cardId,
        ageDays: 14,
        receiptStorageId: await storeBlob(s.t),
      });

      const r = await s.t.mutation(internal.cards.autoConvertOverdueReceipts, {});
      await s.t.finishAllScheduledFunctions(vi.runAllTimers);
      expect(r.convertedCount).toBe(1);
      expect((await repaymentsFor(s, txnId)).length).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a PRE-policy uncoded charge never converts, however old", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await armCodingPolicy(s, { sinceDaysAgo: 30 });
    const holder = await seedPerson(s, "Holder");
    const cardId = await seedCard(s, holder);
    const txnId = await seedCharge(s, {
      cardId,
      ageDays: 200,
      receiptStorageId: await storeBlob(s.t),
    });

    const r = await s.t.mutation(internal.cards.autoConvertOverdueReceipts, {});
    expect(r.convertedCount).toBe(0);
    expect((await repaymentsFor(s, txnId)).length).toBe(0);
  });

  // ── The two dates are two gates ────────────────────────────────────────────
  // The owner asked for the requirement to be live NOW while the consequence
  // waits for September 1 ("only implement the non-coded results in personal
  // payments after Sept 1st"). Both shipped on one constant, so "live now"
  // would have billed people a month early. These pin the gap.

  test("a charge that OWES a coding is still not billed back before the conversion date", async () => {
    const t = newT();
    const s = await setupChapter(t);
    // Requirement armed a year ago; the consequence only 90 days ago. The
    // charge sits in between: chased, but not billable.
    await armCodingPolicy(s, { sinceDaysAgo: 365, conversionSinceDaysAgo: 90 });
    const holder = await seedPerson(s, "Holder");
    const cardId = await seedCard(s, holder);
    const txnId = await seedCharge(s, {
      cardId,
      ageDays: 200,
      receiptStorageId: await storeBlob(s.t),
    });

    // It genuinely owes a coding — this is not a charge that fell out of scope.
    const txnBefore = await run(s.t, (ctx) => ctx.db.get(txnId));
    expect(txnBefore?.codingState).toBeUndefined();

    const r = await s.t.mutation(internal.cards.autoConvertOverdueReceipts, {});
    expect(r.convertedCount).toBe(0);
    expect((await repaymentsFor(s, txnId)).length).toBe(0);
    // And it is NOT quietly marked personal either — nothing was taken.
    const txn = await run(s.t, (ctx) => ctx.db.get(txnId));
    expect(txn?.isPersonal).not.toBe(true);
  });

  test("the same charge DOES convert once it posts after the conversion date", async () => {
    vi.useFakeTimers();
    try {
      const t = newT();
      const s = await setupChapter(t);
      await armCodingPolicy(s, { sinceDaysAgo: 365, conversionSinceDaysAgo: 90 });
      const holder = await seedPerson(s, "Holder");
      const cardId = await seedCard(s, holder);
      // Past the 60-day substantiation clock AND after the conversion date.
      const txnId = await seedCharge(s, {
        cardId,
        ageDays: 70,
        receiptStorageId: await storeBlob(s.t),
      });

      const r = await s.t.mutation(internal.cards.autoConvertOverdueReceipts, {});
      await s.t.finishAllScheduledFunctions(vi.runAllTimers);
      expect(r.convertedCount).toBe(1);
      expect((await repaymentsFor(s, txnId)).length).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("the conversion date alone can't bill a charge the policy never required a coding for", async () => {
    const t = newT();
    const s = await setupChapter(t);
    // The mirror image: the consequence is armed further back than the
    // requirement. A charge older than the requirement date owes nothing, so
    // being inside the conversion window must not be enough on its own.
    await armCodingPolicy(s, { sinceDaysAgo: 90, conversionSinceDaysAgo: 365 });
    const holder = await seedPerson(s, "Holder");
    const cardId = await seedCard(s, holder);
    const txnId = await seedCharge(s, {
      cardId,
      ageDays: 200,
      receiptStorageId: await storeBlob(s.t),
    });

    const r = await s.t.mutation(internal.cards.autoConvertOverdueReceipts, {});
    expect(r.convertedCount).toBe(0);
    expect((await repaymentsFor(s, txnId)).length).toBe(0);
  });

  test("a charge below the conversion date is still CHASED — it just isn't billed", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await armCodingPolicy(s, { sinceDaysAgo: 365, conversionSinceDaysAgo: 1 });
    const holder = await seedPerson(s, "Holder");
    const cardId = await seedCard(s, holder);
    const txnId = await seedCharge(s, {
      cardId,
      ageDays: 200,
      receiptStorageId: await storeBlob(s.t),
    });

    // Not convertible…
    const r = await s.t.mutation(internal.cards.autoConvertOverdueReceipts, {});
    expect(r.convertedCount).toBe(0);
    // …but the chase still names what it owes. This is the whole point of
    // splitting the dates: the ask stays live while the bill waits.
    const txn = await run(s.t, (ctx) => ctx.db.get(txnId));
    const settings = await run(s.t, (ctx) =>
      ctx.db.query("financeSettings").first(),
    );
    expect(
      chargeOutstanding(txn!, settings!.codingRequiredSinceMs!),
    ).toBe("needs coding");
  });

  test("the escalation email explains the accountable-plan rule in plain words", async () => {
    const realFetch = globalThis.fetch;
    const prevAppUrl = process.env.APP_URL;
    const prevResendKey = process.env.RESEND_API_KEY;
    process.env.APP_URL = "https://app.publicworship.life";
    process.env.RESEND_API_KEY = "resend_test_key";
    vi.useFakeTimers();
    try {
      const t = newT();
      const s = await setupChapter(t);
      await armCodingPolicy(s);
      const holder = await seedPerson(s, "Holder", {
        pwEmail: "holder@publicworship.life",
      });
      const cardId = await seedCard(s, holder);
      await seedCharge(s, {
        cardId,
        ageDays: 70,
        amountCents: 8800,
        merchantName: "Hilton Garden Inn",
        receiptStorageId: await storeBlob(s.t),
      });

      const sent: { to: string; subject: string; html: string }[] = [];
      globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
        const body = init?.body ? JSON.parse(init.body) : {};
        sent.push({ to: body.to, subject: body.subject, html: body.html });
        return { ok: true, status: 200, text: async () => "{}" };
      }) as unknown as typeof fetch;

      await s.t.mutation(internal.cards.autoConvertOverdueReceipts, {});
      await s.t.finishAllScheduledFunctions(vi.runAllTimers);

      expect(sent).toHaveLength(1);
      expect(sent[0].to).toBe("holder@publicworship.life");
      expect(sent[0].subject).toContain("nobody coded");
      expect(sent[0].html).toContain("taxable income");
      expect(sent[0].html).toContain("accountable-plan");
    } finally {
      globalThis.fetch = realFetch;
      vi.useRealTimers();
      if (prevAppUrl === undefined) delete process.env.APP_URL;
      else process.env.APP_URL = prevAppUrl;
      if (prevResendKey === undefined) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = prevResendKey;
    }
  });
});

// ── The send-back notification ───────────────────────────────────────────────

describe("notifyCodingSentBack", () => {
  const realFetch = globalThis.fetch;
  const GOOD_PURPOSE = "Travel to NY to film the Eden event with the team";

  /**
   * A cardholder-authored coding, ready for a manager to send back — two
   * DIFFERENT people, which is what the helper always claimed to build and
   * what send-back now requires (deciding on a coding, either way, is
   * separation-of-duties-bound).
   *
   * Splitting them also makes these tests mean what they say: the thing
   * `notifyCodingSentBack` has to get right is that the note reaches the
   * AUTHOR, and a fixture where the author and the reviewer are one person
   * cannot tell a correct implementation from one that mails the reviewer.
   * Mo stays the manager (so `reviewerName` is still "Manager Mo"); Casey is
   * the cardholder whose charge it is, and the recipient under test.
   */
  async function sentBackCoding(
    s: ChapterSetup,
  ): Promise<{ transactionId: Id<"transactions">; author: ChapterMember }> {
    await asManager(s);
    const author = await addCardholder(s, {
      email: "casey@publicworship.life",
      name: "Casey Cardholder",
    });
    const txnId = await seedCharge(s, {
      ageDays: 2,
      personId: author.personId,
      receiptStorageId: await storeBlob(s.t),
    });
    await author.as.mutation(api.transactionCodings.submit, {
      transactionId: txnId,
      expenseType: "travel",
      businessPurpose: GOOD_PURPOSE,
      travelFrom: "Boston",
      travelTo: "New York",
    });
    return { transactionId: txnId, author };
  }

  test("emails the AUTHOR the reviewer's note plus a deep link", async () => {
    const prevAppUrl = process.env.APP_URL;
    const prevResendKey = process.env.RESEND_API_KEY;
    process.env.APP_URL = "https://app.publicworship.life";
    process.env.RESEND_API_KEY = "resend_test_key";
    vi.useFakeTimers();
    try {
      const t = newT();
      const s = await setupChapter(t);
      await armCodingPolicy(s);
      const { transactionId: txnId } = await sentBackCoding(s);

      const sent: { to: string; subject: string; html: string }[] = [];
      globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
        const body = init?.body ? JSON.parse(init.body) : {};
        sent.push({ to: body.to, subject: body.subject, html: body.html });
        return { ok: true, status: 200, text: async () => "{}" };
      }) as unknown as typeof fetch;

      await s.as.mutation(api.transactionCodings.requestChanges, {
        transactionId: txnId,
        reviewNote: "The receipt must show the exact amount.",
      });
      await s.t.finishAllScheduledFunctions(vi.runAllTimers);

      expect(sent).toHaveLength(1);
      // The AUTHOR, not the reviewer — the whole point of the notification.
      expect(sent[0].to).toBe("casey@publicworship.life");
      expect(sent[0].html).toContain("The receipt must show the exact amount.");
      expect(sent[0].html).toMatch(
        // `/code`, not the finance tab: a cardholder's nudge lands on their
        // own charges with no app chrome and no finance seat required.
        /href="https:\/\/app\.publicworship\.life\/code\?filter=uncoded"/,
      );
    } finally {
      globalThis.fetch = realFetch;
      vi.useRealTimers();
      if (prevAppUrl === undefined) delete process.env.APP_URL;
      else process.env.APP_URL = prevAppUrl;
      if (prevResendKey === undefined) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = prevResendKey;
    }
  });

  test("the contact resolver goes quiet once the author has answered", async () => {
    vi.useFakeTimers();
    try {
      const t = newT();
      const s = await setupChapter(t);
      await armCodingPolicy(s);
      const { transactionId: txnId, author } = await sentBackCoding(s);
      await s.as.mutation(api.transactionCodings.requestChanges, {
        transactionId: txnId,
        reviewNote: "Say which event this trip served.",
      });
      await s.t.finishAllScheduledFunctions(vi.runAllTimers);

      const before = await s.t.query(internal.cards.getCodingSendBackContact, {
        transactionId: txnId,
      });
      expect(before?.reviewNote).toBe("Say which event this trip served.");
      expect(before?.reviewerName).toBe("Manager Mo");

      await author.as.mutation(api.transactionCodings.submit, {
        transactionId: txnId,
        expenseType: "travel",
        businessPurpose: "Travel to NY to film the Eden event, night two",
        travelFrom: "Boston",
        travelTo: "New York",
      });
      expect(
        await s.t.query(internal.cards.getCodingSendBackContact, {
          transactionId: txnId,
        }),
      ).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  test("degrades to a no-op without RESEND_API_KEY", async () => {
    const prevResendKey = process.env.RESEND_API_KEY;
    delete process.env.RESEND_API_KEY;
    vi.useFakeTimers();
    try {
      const t = newT();
      const s = await setupChapter(t);
      await armCodingPolicy(s);
      const { transactionId: txnId } = await sentBackCoding(s);
      await s.as.mutation(api.transactionCodings.requestChanges, {
        transactionId: txnId,
        reviewNote: "Attach the itemized folio, not the card slip.",
      });
      await expect(
        s.t.finishAllScheduledFunctions(vi.runAllTimers),
      ).resolves.not.toThrow();
    } finally {
      vi.useRealTimers();
      if (prevResendKey === undefined) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = prevResendKey;
    }
  });
});

// ── Lodging needs an itemized receipt at any amount ──────────────────────────

describe("outstandingLabel — the email and the screen must say the same thing", () => {
  // The label is shared on purpose: `chargeTodo` on the member's own screen
  // renders these exact strings, so a divergence here is a user reading one
  // thing in their inbox and a different thing on the page it links to.
  test("sent back outranks the combined debt", () => {
    // The most common send-back is "your receipt is wrong" — which means the
    // row is BOTH sent back and still undocumented. Ordered the other way,
    // the email said "needs coding and a receipt" while the screen said
    // "sent back", for the same charge, in the single most likely case.
    expect(
      outstandingLabel({
        hasDocumentation: false,
        codingState: "changes_requested",
        requiresCoding: true,
      }),
    ).toBe("sent back — needs your edit");
  });

  test("the other combinations are unchanged", () => {
    expect(
      outstandingLabel({
        hasDocumentation: false,
        codingState: undefined,
        requiresCoding: true,
      }),
    ).toBe("needs coding and a receipt");
    expect(
      outstandingLabel({
        hasDocumentation: true,
        codingState: undefined,
        requiresCoding: true,
      }),
    ).toBe("needs coding");
    expect(
      outstandingLabel({
        hasDocumentation: false,
        codingState: "approved",
        requiresCoding: true,
      }),
    ).toBe("needs a receipt");
    // Pre-policy: a receipt is the whole obligation.
    expect(
      outstandingLabel({
        hasDocumentation: false,
        codingState: undefined,
        requiresCoding: false,
      }),
    ).toBe("needs a receipt");
    // Nothing left to ask for.
    expect(
      outstandingLabel({
        hasDocumentation: true,
        codingState: "approved",
        requiresCoding: true,
      }),
    ).toBeNull();
  });
});

describe("receiptExceptions — the lodging rule", () => {
  const LODGING_PURPOSE = "Two nights in NY for the Eden event shoot crew";
  const EXCEPTION_NOTE =
    "The hotel folio never arrived and the front desk cannot reproduce it.";

  /**
   * A charge already CODED as `expenseType` and currently carrying no
   * documentation — the only state in which the attest-side lodging guard is
   * still reachable.
   *
   * Since receipt-at-coding, a coding can't be submitted at all without
   * documentation, so the naive "code it, then try to except it" sequence
   * can't happen forwards any more. What CAN happen — and what this
   * reconstructs — is the receipt going away AFTER the coding was written: a
   * bookkeeper unlinks a receipt attached to the wrong charge, or the row
   * predates the rule. The guard is defence in depth for exactly those, so
   * the fixture reproduces them rather than pretending the forward path is
   * still open.
   */
  async function codedCharge(
    s: ChapterSetup,
    expenseType: "lodging" | "meal",
  ): Promise<Id<"transactions">> {
    const txnId = await seedCharge(s, {
      ageDays: 2,
      receiptStorageId: await storeBlob(s.t),
    });
    await s.as.mutation(api.transactionCodings.submit, {
      transactionId: txnId,
      expenseType,
      businessPurpose: LODGING_PURPOSE,
      ...(expenseType === "lodging"
        ? { travelFrom: "Boston", travelTo: "New York" }
        : { headcount: 3, attendees: [
            { name: "Ada", affiliation: "team" as const },
            { name: "Ben", affiliation: "volunteer" as const },
            { name: "Cy", affiliation: "contractor" as const },
          ] }),
    });
    // The receipt goes away after the fact (unlinked as misfiled).
    await run(s.t, (ctx) =>
      ctx.db.patch(txnId, { receiptStorageId: undefined }),
    );
    return txnId;
  }

  test("refuses a bank_record_only exception on a lodging coding", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await armCodingPolicy(s);
    await asManager(s);
    const txnId = await codedCharge(s, "lodging");

    await expect(
      s.as.mutation(api.receiptExceptions.attest, {
        transactionId: txnId,
        reason: "bank_record_only",
        note: EXCEPTION_NOTE,
      }),
    ).rejects.toMatchObject({ data: { code: "LODGING_RECEIPT_REQUIRED" } });
  });

  test("the rule holds in the OTHER order too — exception first, lodging coding second", async () => {
    // The cheap way around a one-sided guard: file the bank-record exception
    // while the charge is still uncoded (nothing says "lodging" yet, so the
    // attest-side check reads no expenseType and passes), then type it as
    // lodging afterwards. Enforcement can't depend on which button someone
    // pressed first.
    const t = newT();
    const s = await setupChapter(t);
    await armCodingPolicy(s);
    await asManager(s);
    const txnId = await seedCharge(s, { ageDays: 2 });

    // Uncoded: the exception is accepted, exactly as before.
    await s.as.mutation(api.receiptExceptions.attest, {
      transactionId: txnId,
      reason: "bank_record_only",
      note: EXCEPTION_NOTE,
    });

    // Now typing it as lodging is refused while that exception stands.
    await expect(
      s.as.mutation(api.transactionCodings.submit, {
        transactionId: txnId,
        expenseType: "lodging",
        businessPurpose: LODGING_PURPOSE,
        travelFrom: "Boston",
        travelTo: "New York",
      }),
    ).rejects.toMatchObject({ data: { code: "LODGING_RECEIPT_REQUIRED" } });

    // Withdrawing it and producing the folio is the way through — which is
    // the entire point of the rule. (Withdrawing ALONE isn't enough any more:
    // a coding needs documentation of some kind, so the charge has to end up
    // with the actual itemized receipt attached.)
    const filed = await run(s.t, async (ctx) =>
      (await ctx.db.query("receiptExceptions").collect())[0],
    );
    await s.as.mutation(api.receiptExceptions.withdraw, {
      exceptionId: filed._id,
    });
    const folio = await storeBlob(s.t);
    await run(s.t, (ctx) => ctx.db.patch(txnId, { receiptStorageId: folio }));
    await s.as.mutation(api.transactionCodings.submit, {
      transactionId: txnId,
      expenseType: "lodging",
      businessPurpose: LODGING_PURPOSE,
      travelFrom: "Boston",
      travelTo: "New York",
    });
    const txn = await run(s.t, (ctx) => ctx.db.get(txnId));
    expect(txn?.codingState).toBe("submitted");
  });

  test("a non-lodging coding is unaffected by a standing bank-record exception", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await armCodingPolicy(s);
    await asManager(s);
    const txnId = await seedCharge(s, { ageDays: 2 });
    await s.as.mutation(api.receiptExceptions.attest, {
      transactionId: txnId,
      reason: "bank_record_only",
      note: EXCEPTION_NOTE,
    });
    await s.as.mutation(api.transactionCodings.submit, {
      transactionId: txnId,
      expenseType: "general",
      businessPurpose: "Gaffer tape and sandbags for the Eden event shoot",
    });
    const txn = await run(s.t, (ctx) => ctx.db.get(txnId));
    expect(txn?.codingState).toBe("submitted");
  });

  test("every other reason still works on lodging — a lost folio is a judgment call", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await armCodingPolicy(s);
    await asManager(s);
    const txnId = await codedCharge(s, "lodging");

    await expect(
      s.as.mutation(api.receiptExceptions.attest, {
        transactionId: txnId,
        reason: "lost",
        attestations: LOST_CHECKS,
        note: EXCEPTION_NOTE,
      }),
    ).resolves.toBeDefined();
  });

  test("a meal coding is unaffected — the $75 line still governs it", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await armCodingPolicy(s);
    await asManager(s);
    const txnId = await codedCharge(s, "meal");

    await expect(
      s.as.mutation(api.receiptExceptions.attest, {
        transactionId: txnId,
        reason: "bank_record_only",
        note: EXCEPTION_NOTE,
      }),
    ).resolves.toBeDefined();
  });

  test("the bulk backfill SKIPS a lodging row instead of failing the batch", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await armCodingPolicy(s);
    await asManager(s);
    const lodging = await codedCharge(s, "lodging");
    const ordinary = await seedCharge(s, { ageDays: 2, amountCents: 900 });

    const out = await s.as.mutation(api.receiptExceptions.attestBulk, {
      transactionIds: [lodging, ordinary],
      reason: "bank_record_only",
      note: EXCEPTION_NOTE,
    });
    expect(out.filed).toBe(1);
    expect(out.skipped).toBe(1);
    const rows = await run(s.t, (ctx) =>
      ctx.db
        .query("receiptExceptions")
        .withIndex("by_transaction", (q) => q.eq("transactionId", lodging))
        .collect(),
    );
    expect(rows).toEqual([]);
    void ordinary;
  });
});
