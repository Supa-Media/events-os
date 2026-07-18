import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";

// Stripe REST + env stubs are per-test (the recovery suite below); make sure
// they never leak into the mutation-only tests in this file.
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
import { runSeedSeatDefs } from "../migrations/0022_seed_seat_defs";
import type { Id } from "../_generated/dataModel";

/**
 * Giving Platform (F-6 P2) — recurring backer billing tests:
 *   - checkout prep inserts an incomplete pledge + donor,
 *   - checkout.session.completed activates (and no-ops on an unrelated session),
 *   - invoice.paid writes exactly one gift per invoice (idempotent on redelivery),
 *     bumps the donor/scope rollups, and schedules a receipt,
 *   - payment_failed / subscription.deleted status transitions,
 *   - derived `chapters.backerCount` recompute on transitions ($20 excluded,
 *     $50 counted),
 *   - Givebutter recurring import dedup,
 *   - access gating on the admin surface.
 */

/** Link a `people` row to the caller's user + seat them, so their seat-derived
 *  giving capability resolves. Requires seeded seatDefs. */
async function seatCaller(
  s: ChapterSetup,
  slug: string,
  scope: Id<"chapters"> | "central",
): Promise<void> {
  await run(s.t, async (ctx) => {
    const personId = await ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Seated Caller",
      userId: s.userId,
      createdAt: Date.now(),
    });
    const def = await ctx.db
      .query("seatDefs")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .unique();
    if (!def) throw new Error(`${slug} not seeded`);
    await ctx.db.insert("seatAssignments", {
      seatDefId: def._id,
      scope,
      personId,
      createdAt: Date.now(),
    });
  });
}

/** A chapter with the caller seated as development director at central (full
 *  giving.manage over central AND every chapter). */
async function devDirectorSetup(): Promise<ChapterSetup> {
  const t = newT();
  await run(t, (ctx) => runSeedSeatDefs(ctx));
  const s = await setupChapter(t);
  await seatCaller(s, "development_director", "central");
  return s;
}

/** Prepare a pledge (incomplete) and activate it with a subscription id. */
async function prepareAndActivate(
  s: ChapterSetup,
  amountCents: number,
  subscriptionId: string,
  email: string,
): Promise<Id<"pledges">> {
  const prepared = await s.t.mutation(internal.givingPledges.preparePledge, {
    chapterId: s.chapterId,
    amountCents,
    name: "Backer " + subscriptionId,
    email,
  });
  await s.t.mutation(internal.givingPledges.activatePledgeFromCheckout, {
    pledgeId: String(prepared.pledgeId),
    stripeCustomerId: "cus_" + subscriptionId,
    stripeSubscriptionId: subscriptionId,
  });
  return prepared.pledgeId as Id<"pledges">;
}

async function pledgeRow(s: ChapterSetup, pledgeId: Id<"pledges">) {
  return run(s.t, (ctx) => ctx.db.get(pledgeId));
}

async function chapterBackerCount(s: ChapterSetup): Promise<number> {
  const chapter = await run(s.t, (ctx) => ctx.db.get(s.chapterId));
  return chapter?.backerCount ?? 0;
}

async function chapterGifts(s: ChapterSetup) {
  return run(s.t, (ctx) =>
    ctx.db
      .query("gifts")
      .withIndex("by_scope", (q) => q.eq("scope", s.chapterId))
      .collect(),
  );
}

// ── Checkout prep ─────────────────────────────────────────────────────────────

describe("preparePledge", () => {
  test("inserts an incomplete pledge + matches-or-creates the donor", async () => {
    const t = newT();
    const s = await setupChapter(t);

    const prepared = await t.mutation(internal.givingPledges.preparePledge, {
      chapterId: s.chapterId,
      amountCents: 5000,
      name: "Ada Backer",
      email: "Ada@Example.com",
    });

    const pledge = await pledgeRow(s, prepared.pledgeId as Id<"pledges">);
    expect(pledge?.status).toBe("incomplete");
    expect(pledge?.origin).toBe("stripe");
    expect(pledge?.amountCents).toBe(5000);
    expect(pledge?.scope).toBe(s.chapterId);

    const donor = await run(s.t, (ctx) => ctx.db.get(pledge!.donorId));
    expect(donor?.email).toBe("ada@example.com");

    // Below the $20 floor is rejected.
    await expect(
      t.mutation(internal.givingPledges.preparePledge, {
        chapterId: s.chapterId,
        amountCents: 1000,
        name: "Too Small",
        email: "small@example.com",
      }),
    ).rejects.toThrow();
  });
});

// ── Activation ────────────────────────────────────────────────────────────────

describe("activatePledgeFromCheckout", () => {
  test("activates + links the subscription; a bogus session no-ops; idempotent", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const pledgeId = await prepareAndActivate(s, 5000, "sub_activate", "b@example.com");

    let pledge = await pledgeRow(s, pledgeId);
    expect(pledge?.status).toBe("active");
    expect(pledge?.stripeSubscriptionId).toBe("sub_activate");
    expect(pledge?.stripeCustomerId).toBe("cus_sub_activate");
    expect(pledge?.startedAt).toBeGreaterThan(0);

    // An unrelated session (a bogus pledge id) is a safe no-op.
    const bogus = await t.mutation(
      internal.givingPledges.activatePledgeFromCheckout,
      { pledgeId: "not-a-real-pledge-id" },
    );
    expect(bogus).toBe(false);

    // Redelivery is idempotent.
    const again = await t.mutation(
      internal.givingPledges.activatePledgeFromCheckout,
      {
        pledgeId: String(pledgeId),
        stripeSubscriptionId: "sub_activate",
      },
    );
    expect(again).toBe(true);
    pledge = await pledgeRow(s, pledgeId);
    expect(pledge?.status).toBe("active");
    expect(await chapterBackerCount(s)).toBe(1);
  });
});

// ── invoice.paid → cycle gifts ────────────────────────────────────────────────

describe("recordPledgeInvoice", () => {
  test("writes one gift per invoice, idempotent on redelivery, bumps rollups, schedules a receipt", async () => {
    vi.useFakeTimers();
    try {
      const t = newT();
      const s = await setupChapter(t);
      const pledgeId = await prepareAndActivate(s, 5000, "sub_inv", "cyc@example.com");

      const first = await t.mutation(internal.givingPledges.recordPledgeInvoice, {
        subscriptionId: "sub_inv",
        invoiceId: "in_1",
        amountPaidCents: 5000,
      });
      expect(first).toBe(true);

      let gifts = await chapterGifts(s);
      expect(gifts).toHaveLength(1);
      expect(gifts[0]).toMatchObject({
        method: "stripe",
        amountCents: 5000,
        pledgeId,
        stripeInvoiceId: "in_1",
      });

      // Donor rollups bumped by the shared primitive.
      const pledge = await pledgeRow(s, pledgeId);
      const donor = await run(s.t, (ctx) => ctx.db.get(pledge!.donorId));
      expect(donor?.lifetimeCents).toBe(5000);
      expect(donor?.giftCount).toBe(1);
      expect(donor?.status).toBe("active");

      // Redelivery of the SAME invoice inserts nothing new.
      const dup = await t.mutation(internal.givingPledges.recordPledgeInvoice, {
        subscriptionId: "sub_inv",
        invoiceId: "in_1",
        amountPaidCents: 5000,
      });
      expect(dup).toBe(true);
      gifts = await chapterGifts(s);
      expect(gifts).toHaveLength(1);

      // A NEW invoice (next cycle) writes a second gift.
      await t.mutation(internal.givingPledges.recordPledgeInvoice, {
        subscriptionId: "sub_inv",
        invoiceId: "in_2",
        amountPaidCents: 5000,
      });
      gifts = await chapterGifts(s);
      expect(gifts).toHaveLength(2);

      // Drain the scheduled receipt emails (no RESEND key → they log + return).
      await t.finishAllScheduledFunctions(vi.runAllTimers);

      // An invoice for an unknown subscription is a safe no-op.
      const orphan = await t.mutation(
        internal.givingPledges.recordPledgeInvoice,
        { subscriptionId: "sub_unknown", invoiceId: "in_x", amountPaidCents: 5000 },
      );
      expect(orphan).toBe(false);
      expect(await chapterGifts(s)).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a paid invoice recovers a past_due pledge to active", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const pledgeId = await prepareAndActivate(s, 5000, "sub_recover", "r@example.com");

    await t.mutation(internal.givingPledges.markPledgePastDue, {
      subscriptionId: "sub_recover",
    });
    expect((await pledgeRow(s, pledgeId))?.status).toBe("past_due");
    expect(await chapterBackerCount(s)).toBe(0);

    await t.mutation(internal.givingPledges.recordPledgeInvoice, {
      subscriptionId: "sub_recover",
      invoiceId: "in_recover",
      amountPaidCents: 5000,
    });
    expect((await pledgeRow(s, pledgeId))?.status).toBe("active");
    expect(await chapterBackerCount(s)).toBe(1);
  });
});

// ── invoice.paid out-of-order recovery (finding A) ────────────────────────────

describe("recordPledgeInvoice out-of-order recovery (finding A)", () => {
  const SUB = "sub_race";
  const KEY = "sk_test_recovery";

  /** Stub Stripe's subscription-retrieve endpoint. `pledgeId` undefined models a
   *  FOREIGN (non-pledge) subscription — its metadata carries no pledgeId. */
  function stubSubscriptionFetch(pledgeId: string | undefined) {
    const fetchMock = vi.fn(async (_url: string) => ({
      ok: true,
      status: 200,
      text: async () => "",
      json: async () => ({
        id: SUB,
        customer: "cus_race",
        current_period_end: 1_900_000_000, // unix seconds
        metadata: pledgeId ? { pledgeId } : {},
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  test("invoice.paid BEFORE session-completed recovers via metadata; exactly one gift; late session + redelivery no-op", async () => {
    vi.useFakeTimers();
    vi.stubEnv("STRIPE_SECRET_KEY", KEY);
    try {
      const t = newT();
      const s = await setupChapter(t);
      // A prepared-but-NOT-activated pledge — no stripeSubscriptionId linked yet.
      const prepared = await t.mutation(internal.givingPledges.preparePledge, {
        chapterId: s.chapterId,
        amountCents: 5000,
        name: "Racer",
        email: "race@example.com",
      });
      const pledgeId = prepared.pledgeId as Id<"pledges">;
      const fetchMock = stubSubscriptionFetch(String(pledgeId));

      // invoice.paid arrives FIRST — nothing resolves by subscription id, so the
      // gift is deferred to the scheduled recovery rather than dropped.
      const early = await t.mutation(internal.givingPledges.recordPledgeInvoice, {
        subscriptionId: SUB,
        invoiceId: "in_race",
        amountPaidCents: 5000,
      });
      expect(early).toBe(false);
      expect(await chapterGifts(s)).toHaveLength(0);

      // Drain the recovery: fetch subscription → link/activate → re-record.
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      expect(fetchMock).toHaveBeenCalledOnce();

      // Exactly one gift, pledge now active + linked + counted as a backer.
      let gifts = await chapterGifts(s);
      expect(gifts).toHaveLength(1);
      expect(gifts[0]).toMatchObject({
        pledgeId,
        stripeInvoiceId: "in_race",
        amountCents: 5000,
        method: "stripe",
      });
      const pledge = await pledgeRow(s, pledgeId);
      expect(pledge?.status).toBe("active");
      expect(pledge?.stripeSubscriptionId).toBe(SUB);
      expect(await chapterBackerCount(s)).toBe(1);

      // The LATE checkout.session.completed for the same pledge is a clean no-op.
      const late = await t.mutation(
        internal.givingPledges.activatePledgeFromCheckout,
        {
          pledgeId: String(pledgeId),
          stripeCustomerId: "cus_race",
          stripeSubscriptionId: SUB,
        },
      );
      expect(late).toBe(true);
      expect(await chapterGifts(s)).toHaveLength(1);
      expect(await chapterBackerCount(s)).toBe(1);

      // (b) Redelivery of the SAME invoice after recovery stays idempotent.
      const redelivered = await t.mutation(
        internal.givingPledges.recordPledgeInvoice,
        { subscriptionId: SUB, invoiceId: "in_race", amountPaidCents: 5000 },
      );
      expect(redelivered).toBe(true);
      gifts = await chapterGifts(s);
      expect(gifts).toHaveLength(1);

      await t.finishAllScheduledFunctions(vi.runAllTimers);
    } finally {
      vi.useRealTimers();
    }
  });

  test("(c) a foreign subscription (no pledgeId metadata) still no-ops — no gift, no pledge", async () => {
    vi.useFakeTimers();
    vi.stubEnv("STRIPE_SECRET_KEY", KEY);
    try {
      const t = newT();
      const s = await setupChapter(t);
      const fetchMock = stubSubscriptionFetch(undefined); // metadata has no pledgeId

      const res = await t.mutation(internal.givingPledges.recordPledgeInvoice, {
        subscriptionId: "sub_foreign",
        invoiceId: "in_foreign",
        amountPaidCents: 9900,
      });
      expect(res).toBe(false);

      await t.finishAllScheduledFunctions(vi.runAllTimers);
      expect(fetchMock).toHaveBeenCalledOnce();
      // Not our subscription — nothing created.
      expect(await chapterGifts(s)).toHaveLength(0);
      const pledges = await run(s.t, (ctx) =>
        ctx.db.query("pledges").collect(),
      );
      expect(pledges).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── Status transitions ────────────────────────────────────────────────────────

describe("pledge status transitions", () => {
  test("payment_failed → past_due; subscription.deleted → canceled", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const pledgeId = await prepareAndActivate(s, 5000, "sub_txn", "x@example.com");
    expect(await chapterBackerCount(s)).toBe(1);

    await t.mutation(internal.givingPledges.markPledgePastDue, {
      subscriptionId: "sub_txn",
    });
    expect((await pledgeRow(s, pledgeId))?.status).toBe("past_due");
    expect(await chapterBackerCount(s)).toBe(0);

    const canceled = await t.mutation(
      internal.givingPledges.cancelPledgeSubscription,
      { subscriptionId: "sub_txn" },
    );
    expect(canceled).toBe(true);
    const pledge = await pledgeRow(s, pledgeId);
    expect(pledge?.status).toBe("canceled");
    expect(pledge?.canceledAt).toBeGreaterThan(0);

    // No-ops for a subscription that isn't a pledge's.
    expect(
      await t.mutation(internal.givingPledges.cancelPledgeSubscription, {
        subscriptionId: "sub_missing",
      }),
    ).toBe(false);
  });

  test("customer.subscription.updated syncs status + amount", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const pledgeId = await prepareAndActivate(s, 5000, "sub_sync", "s@example.com");

    await t.mutation(internal.givingPledges.syncPledgeSubscription, {
      subscriptionId: "sub_sync",
      stripeStatus: "past_due",
      currentPeriodEnd: 1_800_000_000_000,
      amountCents: 10000,
    });
    const pledge = await pledgeRow(s, pledgeId);
    expect(pledge?.status).toBe("past_due");
    expect(pledge?.amountCents).toBe(10000);
    expect(pledge?.currentPeriodEnd).toBe(1_800_000_000_000);
    expect(await chapterBackerCount(s)).toBe(0);
  });
});

// ── Derived backer count ──────────────────────────────────────────────────────

describe("derived chapters.backerCount", () => {
  test("$50 pledges count as backers; a $20 pledge does not; transitions recount", async () => {
    const t = newT();
    const s = await setupChapter(t);

    await prepareAndActivate(s, 5000, "sub_a", "a@example.com");
    expect(await chapterBackerCount(s)).toBe(1);

    // A $20 pledge is a donor but NOT a backer (below BACKER_UNIT_CENTS).
    await prepareAndActivate(s, 2000, "sub_b", "b@example.com");
    expect(await chapterBackerCount(s)).toBe(1);

    await prepareAndActivate(s, 5000, "sub_c", "c@example.com");
    expect(await chapterBackerCount(s)).toBe(2);

    // Canceling one active $50 pledge drops the count.
    await t.mutation(internal.givingPledges.cancelPledgeSubscription, {
      subscriptionId: "sub_a",
    });
    expect(await chapterBackerCount(s)).toBe(1);

    // Past-due on the other $50 drops it to zero.
    await t.mutation(internal.givingPledges.markPledgePastDue, {
      subscriptionId: "sub_c",
    });
    expect(await chapterBackerCount(s)).toBe(0);
  });
});

// ── Givebutter recurring import ───────────────────────────────────────────────

describe("importGivebutterRecurring", () => {
  test("imports past_due imported pledges, dedups on externalRef, skips sub-floor", async () => {
    const s = await devDirectorSetup();
    const rows = [
      { email: "gina@example.com", name: "Gina Giver", amountCents: 5000, externalRef: "gb_rec_1" },
      { email: "gina@example.com", name: "Gina Giver", amountCents: 5000, externalRef: "gb_rec_2" },
      { email: "tiny@example.com", name: "Tiny", amountCents: 1000, externalRef: "gb_rec_3" },
    ];

    const first = await s.as.mutation(
      api.givingPledges.importGivebutterRecurring,
      { scope: s.chapterId, rows },
    );
    expect(first.imported).toBe(2);
    expect(first.skipped).toBe(1); // the sub-floor $10 row

    const pledges = await run(s.t, (ctx) =>
      ctx.db
        .query("pledges")
        .withIndex("by_scope_and_status", (q) => q.eq("scope", s.chapterId))
        .collect(),
    );
    expect(pledges).toHaveLength(2);
    expect(pledges.every((p) => p.status === "past_due")).toBe(true);
    expect(pledges.every((p) => p.origin === "imported")).toBe(true);
    // Imported rows are NOT backers (past_due).
    expect(await chapterBackerCount(s)).toBe(0);

    // Re-run the SAME export → both dedup on externalRef, nothing new.
    const second = await s.as.mutation(
      api.givingPledges.importGivebutterRecurring,
      { scope: s.chapterId, rows },
    );
    expect(second.imported).toBe(0);
    expect(second.skipped).toBe(3);
  });
});

// ── Access gating ─────────────────────────────────────────────────────────────

describe("pledge access gating", () => {
  test("no giving seat is rejected; view-only can't import; a director passes", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));
    const s = await setupChapter(t); // plain chapter admin, no giving seat

    await expect(
      s.as.query(api.givingPledges.listPledges, { scope: s.chapterId }),
    ).rejects.toThrow();
    await expect(
      s.as.mutation(api.givingPledges.importGivebutterRecurring, {
        scope: s.chapterId,
        rows: [{ name: "X", amountCents: 5000, externalRef: "gb_x" }],
      }),
    ).rejects.toThrow();

    // A chapter treasurer sees (view) but cannot import (manage).
    await seatCaller(s, "treasurer", s.chapterId);
    await expect(
      s.as.query(api.givingPledges.listPledges, { scope: s.chapterId }),
    ).resolves.toBeDefined();
    await expect(
      s.as.mutation(api.givingPledges.importGivebutterRecurring, {
        scope: s.chapterId,
        rows: [{ name: "X", amountCents: 5000, externalRef: "gb_x" }],
      }),
    ).rejects.toThrow();

    // A development director (central manage) can both view + import.
    await seatCaller(s, "development_director", "central");
    const imported = await s.as.mutation(
      api.givingPledges.importGivebutterRecurring,
      {
        scope: s.chapterId,
        rows: [{ name: "Y", amountCents: 5000, externalRef: "gb_y" }],
      },
    );
    expect(imported.imported).toBe(1);
  });
});
