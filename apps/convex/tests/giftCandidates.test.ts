/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { api } from "../_generated/api";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { runSeedSeatDefs } from "../migrations/0022_seed_seat_defs";
import type { Id } from "../_generated/dataModel";

/**
 * Territories P7 (bank-credit ↔ gift matching, docs/plans/giving-territories.md
 * §D10) — `givingCandidates.ts` tests:
 *   - the exclusion rule: a card-linked credit (refund heuristic), transfer-flow
 *     legs, and provider-payout-labeled credits never surface as candidates;
 *   - already-linked and already-dismissed transactions stay excluded;
 *   - `confirmExternalGift` creates exactly one gift with amount/date taken
 *     from the transaction, bumps rollups once, links via `gifts.transactionId`,
 *     and is idempotent (a second confirm on the same transaction throws);
 *   - `dismissGiftCandidate` persists (and is idempotent);
 *   - access gating: a giving manager passes, a central finance VIEWER can READ
 *     candidates (no giving seat at all), and an unprivileged caller is
 *     rejected.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Link a `people` row to the caller's user and seat them at `scope`, so their
 *  seat-derived giving capability resolves (`lib/givingAccess.ts`). Requires
 *  seeded seatDefs. */
async function seatCaller(
  s: ChapterSetup,
  slug: string,
  scope: Id<"chapters"> | "central",
): Promise<Id<"people">> {
  return run(s.t, async (ctx) => {
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
    return personId;
  });
}

/** A superuser-seat-seeded chapter with the caller seated as development
 *  director at central (full giving.manage everywhere). */
async function devDirectorSetup(): Promise<ChapterSetup> {
  const t = newT();
  await run(t, (ctx) => runSeedSeatDefs(ctx));
  const s = await setupChapter(t);
  await seatCaller(s, "development_director", "central");
  return s;
}

/** Seed one inflow (default) transaction on the caller's chapter, recent
 *  enough to fall inside the 90-day candidate window. */
async function seedTxn(
  s: ChapterSetup,
  fields: {
    amountCents: number;
    flow?: "inflow" | "outflow" | "transfer";
    source?:
      | "increase_card"
      | "increase_ach"
      | "stripe_fc"
      | "relay_csv"
      | "manual"
      | "reimbursement"
      | "repayment"
      | "skim"
      | "launch_grant"
      | "settlement";
    cardId?: Id<"cards">;
    merchantName?: string;
    description?: string;
    postedAt?: number;
  },
): Promise<Id<"transactions">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("transactions", {
      chapterId: s.chapterId,
      source: fields.source ?? "stripe_fc",
      flow: fields.flow ?? "inflow",
      amountCents: fields.amountCents,
      postedAt: fields.postedAt ?? Date.now() - DAY_MS,
      status: "unreviewed",
      cardId: fields.cardId,
      merchantName: fields.merchantName,
      description: fields.description,
      createdAt: Date.now(),
    }),
  );
}

async function seedCard(s: ChapterSetup): Promise<Id<"cards">> {
  return run(s.t, async (ctx) => {
    const personId = await ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Cardholder",
      createdAt: Date.now(),
    });
    return ctx.db.insert("cards", {
      chapterId: s.chapterId,
      cardholderPersonId: personId,
      type: "physical",
      status: "active",
      createdAt: Date.now(),
    });
  });
}

async function candidateIds(
  s: ChapterSetup,
): Promise<Id<"transactions">[]> {
  const rows = await s.as.query(api.givingCandidates.candidateExternalGifts, {
    scope: s.chapterId,
  });
  return rows.map((r) => r.transactionId);
}

// ── The exclusion rule ────────────────────────────────────────────────────────

describe("candidateExternalGifts: exclusion rule", () => {
  test("a card-linked credit is excluded (refund heuristic)", async () => {
    const s = await devDirectorSetup();
    const cardId = await seedCard(s);
    const cardCredit = await seedTxn(s, {
      amountCents: 5000,
      source: "increase_card",
      cardId,
    });
    const clean = await seedTxn(s, { amountCents: 2500, source: "manual" });

    const ids = await candidateIds(s);
    expect(ids).not.toContain(cardCredit);
    expect(ids).toContain(clean);
  });

  test("transfer-flow legs (skim/launch_grant/settlement) are excluded", async () => {
    const s = await devDirectorSetup();
    const skim = await seedTxn(s, {
      amountCents: 1000,
      flow: "transfer",
      source: "skim",
    });
    const grant = await seedTxn(s, {
      amountCents: 2000,
      flow: "transfer",
      source: "launch_grant",
    });
    const settlement = await seedTxn(s, {
      amountCents: 3000,
      flow: "transfer",
      source: "settlement",
    });
    const clean = await seedTxn(s, { amountCents: 4000, source: "manual" });

    const ids = await candidateIds(s);
    expect(ids).not.toContain(skim);
    expect(ids).not.toContain(grant);
    expect(ids).not.toContain(settlement);
    expect(ids).toContain(clean);
  });

  test("provider-payout-labeled credits (Stripe / Givebutter) are excluded", async () => {
    const s = await devDirectorSetup();
    const stripePayout = await seedTxn(s, {
      amountCents: 50000,
      source: "stripe_fc",
      merchantName: "STRIPE",
    });
    const givebutterPayout = await seedTxn(s, {
      amountCents: 30000,
      source: "relay_csv",
      merchantName: "GIVEBUTTER PAYOUTS INC",
      description: "givebutter payout",
    });
    // A genuine Zelle-style credit from an individual never mentions either
    // processor — stays a candidate.
    const zelleGift = await seedTxn(s, {
      amountCents: 10000,
      source: "stripe_fc",
      merchantName: "ZELLE FROM JANE DOE",
    });

    const ids = await candidateIds(s);
    expect(ids).not.toContain(stripePayout);
    expect(ids).not.toContain(givebutterPayout);
    expect(ids).toContain(zelleGift);
  });

  test("an outflow transaction is never a candidate", async () => {
    const s = await devDirectorSetup();
    const outflow = await seedTxn(s, { amountCents: 1200, flow: "outflow" });
    const ids = await candidateIds(s);
    expect(ids).not.toContain(outflow);
  });
});

// ── Already-linked / already-dismissed exclusion ───────────────────────────────

describe("candidateExternalGifts: linked + dismissed exclusion", () => {
  test("a transaction already confirmed into a gift never reappears", async () => {
    const s = await devDirectorSetup();
    const txnId = await seedTxn(s, { amountCents: 7500 });
    expect(await candidateIds(s)).toContain(txnId);

    await s.as.mutation(api.givingCandidates.confirmExternalGift, {
      transactionId: txnId,
      newDonor: { name: "External Giver" },
    });

    expect(await candidateIds(s)).not.toContain(txnId);
  });

  test("a dismissed transaction stays excluded", async () => {
    const s = await devDirectorSetup();
    const txnId = await seedTxn(s, { amountCents: 6000 });
    expect(await candidateIds(s)).toContain(txnId);

    await s.as.mutation(api.givingCandidates.dismissGiftCandidate, {
      transactionId: txnId,
    });

    expect(await candidateIds(s)).not.toContain(txnId);
  });
});

// ── confirmExternalGift ───────────────────────────────────────────────────────

describe("confirmExternalGift", () => {
  test("creates exactly one gift with the transaction's amount/date, bumps rollups once, and links by_transaction", async () => {
    const s = await devDirectorSetup();
    const postedAt = Date.now() - 2 * DAY_MS;
    const txnId = await seedTxn(s, { amountCents: 12345, postedAt });

    const giftId = await s.as.mutation(api.givingCandidates.confirmExternalGift, {
      transactionId: txnId,
      newDonor: { name: "Direct Depositor", email: "direct@example.com" },
      method: "wire",
      note: "Confirmed from a bank credit",
    });

    const gift = await run(s.t, (ctx) => ctx.db.get(giftId));
    expect(gift?.amountCents).toBe(12345);
    expect(gift?.receivedAt).toBe(postedAt);
    expect(gift?.method).toBe("wire");
    expect(gift?.transactionId).toBe(txnId);

    const dash = await s.as.query(api.givingPlatform.givingDashboard, {
      scope: s.chapterId,
    });
    expect(dash.giftCount).toBe(1);
    expect(dash.lifetimeCents).toBe(12345);

    // Idempotency: a second confirm on the same transaction throws, and never
    // mints a second gift or double-bumps the rollup.
    await expect(
      s.as.mutation(api.givingCandidates.confirmExternalGift, {
        transactionId: txnId,
        newDonor: { name: "Someone Else" },
      }),
    ).rejects.toThrow(ConvexError);

    const dashAfter = await s.as.query(api.givingPlatform.givingDashboard, {
      scope: s.chapterId,
    });
    expect(dashAfter.giftCount).toBe(1);
    expect(dashAfter.lifetimeCents).toBe(12345);
  });

  test("defaults to zelle when no method is given, and matches an existing donor by id", async () => {
    const s = await devDirectorSetup();
    const donorId = (await s.as.mutation(api.givingPlatform.upsertDonor, {
      scope: s.chapterId,
      name: "Existing Donor",
      email: "existing@example.com",
    })) as Id<"donors">;
    const txnId = await seedTxn(s, { amountCents: 4200 });

    const giftId = await s.as.mutation(api.givingCandidates.confirmExternalGift, {
      transactionId: txnId,
      donorId,
    });
    const gift = await run(s.t, (ctx) => ctx.db.get(giftId));
    expect(gift?.method).toBe("zelle");
    expect(gift?.donorId).toBe(donorId);
  });

  test("rejects a transaction that no longer qualifies (card-linked)", async () => {
    const s = await devDirectorSetup();
    const cardId = await seedCard(s);
    const txnId = await seedTxn(s, {
      amountCents: 900,
      source: "increase_card",
      cardId,
    });
    await expect(
      s.as.mutation(api.givingCandidates.confirmExternalGift, {
        transactionId: txnId,
        newDonor: { name: "Nope" },
      }),
    ).rejects.toThrow(ConvexError);
  });
});

// ── dismissGiftCandidate ─────────────────────────────────────────────────────

describe("dismissGiftCandidate", () => {
  test("persists a dismissal row and is idempotent on a repeat call", async () => {
    const s = await devDirectorSetup();
    const txnId = await seedTxn(s, { amountCents: 800 });

    await s.as.mutation(api.givingCandidates.dismissGiftCandidate, {
      transactionId: txnId,
    });
    await s.as.mutation(api.givingCandidates.dismissGiftCandidate, {
      transactionId: txnId,
    });

    const rows = await run(s.t, (ctx) =>
      ctx.db
        .query("dismissedGiftCandidates")
        .withIndex("by_transaction", (q) => q.eq("transactionId", txnId))
        .collect(),
    );
    expect(rows.length).toBe(1);
  });
});

// ── Access gating ─────────────────────────────────────────────────────────────

describe("access gating", () => {
  test("a giving manager passes", async () => {
    const s = await devDirectorSetup();
    await seedTxn(s, { amountCents: 100 });
    const rows = await s.as.query(api.givingCandidates.candidateExternalGifts, {
      scope: s.chapterId,
    });
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  test("a central finance VIEWER can READ candidates with no giving seat at all", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));
    const s = await setupChapter(t);
    await run(s.t, async (ctx) => {
      const personId = await ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "FM Viewer",
        userId: s.userId,
        createdAt: Date.now(),
      });
      await ctx.db.insert("financeRoles", {
        chapterId: "central",
        personId,
        role: "viewer",
        scope: "central",
        createdAt: Date.now(),
      });
    });
    await seedTxn(s, { amountCents: 555 });

    const rows = await s.as.query(api.givingCandidates.candidateExternalGifts, {
      scope: s.chapterId,
    });
    expect(rows.length).toBeGreaterThanOrEqual(1);

    // But a read-only finance viewer can't confirm/dismiss (manage-gated).
    const [txn] = rows;
    await expect(
      s.as.mutation(api.givingCandidates.dismissGiftCandidate, {
        transactionId: txn.transactionId,
      }),
    ).rejects.toThrow(ConvexError);
  });

  test("an unprivileged caller is rejected", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));
    const s = await setupChapter(t);
    await seedTxn(s, { amountCents: 100 });

    await expect(
      s.as.query(api.givingCandidates.candidateExternalGifts, {
        scope: s.chapterId,
      }),
    ).rejects.toThrow(ConvexError);
  });
});
