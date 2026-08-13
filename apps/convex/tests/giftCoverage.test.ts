/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { api } from "../_generated/api";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { runSeedSeatDefs } from "../migrations/0022_seed_seat_defs";
import type { Id } from "../_generated/dataModel";

/**
 * ONE DEPOSIT, SEVERAL GIFTS — `lib/giftCoverage.ts` and the relaxed
 * `linkGiftToTransaction`.
 *
 * The case these exist for: a founder wires $7,000 that is $5,000 of central's
 * revenue and $2,000 of New York's. The old rule wanted one gift, of exactly
 * the deposit's amount, in the deposit's own book — so none of the three facts
 * could be stated, the wire stayed unlinked, and New York published $9,050 of
 * March income against a real $2,050.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The caller wears both hats this work needs: development director at central
 * (`giving.manage` everywhere, which a cross-book match requires) and central
 * ED + finance manager (the reconciliation audit gate on `bookValueBreakdown`).
 * One person, because in the org one person really does hold both.
 */
async function devDirectorSetup(): Promise<ChapterSetup> {
  const t = newT();
  await run(t, (ctx) => runSeedSeatDefs(ctx));
  const s = await setupChapter(t);
  await run(s.t, async (ctx) => {
    const personId = await ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Seated Caller",
      userId: s.userId,
      isTeamMember: true,
      createdAt: Date.now(),
    });
    const def = await ctx.db
      .query("seatDefs")
      .withIndex("by_slug", (q) => q.eq("slug", "development_director"))
      .unique();
    if (!def) throw new Error("development_director not seeded");
    await ctx.db.insert("seatAssignments", {
      seatDefId: def._id,
      scope: "central",
      personId,
      createdAt: Date.now(),
    });
    await ctx.db.insert("specializedRoles", {
      personId,
      title: "executive_director",
      roleKind: "leadership",
      scope: "central",
      createdAt: Date.now(),
    });
    await ctx.db.insert("financeRoles", {
      chapterId: s.chapterId,
      personId,
      role: "manager",
      scope: "central",
      createdAt: Date.now(),
    });
  });
  return s;
}

async function seedCredit(
  s: ChapterSetup,
  amountCents: number,
  opts: { postedAt?: number; flow?: "inflow" | "outflow" } = {},
): Promise<Id<"transactions">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("transactions", {
      chapterId: s.chapterId,
      source: "manual",
      flow: opts.flow ?? "inflow",
      amountCents,
      postedAt: opts.postedAt ?? Date.now() - DAY_MS,
      status: "unreviewed",
      createdAt: Date.now(),
    }),
  );
}

async function seedGift(
  s: ChapterSetup,
  amountCents: number,
  opts: { scope?: Id<"chapters"> | "central"; receivedAt?: number } = {},
): Promise<Id<"gifts">> {
  const scope = opts.scope ?? s.chapterId;
  return run(s.t, async (ctx) => {
    const donorId = await ctx.db.insert("donors", {
      scope,
      kind: "individual",
      name: "A Giver",
      status: "active",
      lifetimeCents: amountCents,
      giftCount: 1,
      createdAt: Date.now(),
    });
    return ctx.db.insert("gifts", {
      donorId,
      scope,
      amountCents,
      currency: "usd",
      receivedAt: opts.receivedAt ?? Date.now() - DAY_MS,
      method: "wire",
      createdAt: Date.now(),
    });
  });
}

function errCode(e: unknown): string {
  return (e as ConvexError<{ code: string }>).data.code;
}

describe("linkGiftToTransaction: a deposit is the SUM of its gifts", () => {
  test("two gifts settle one wire, and the deposit then contributes nothing", async () => {
    const s = await devDirectorSetup();
    const wire = await seedCredit(s, 700_000);
    const central = await seedGift(s, 500_000, { scope: "central" });
    const local = await seedGift(s, 200_000);

    await s.as.mutation(api.givingCandidates.linkGiftToTransaction, {
      giftId: central,
      transactionId: wire,
    });
    await s.as.mutation(api.givingCandidates.linkGiftToTransaction, {
      giftId: local,
      transactionId: wire,
    });

    const gifts = await run(s.t, (ctx) => ctx.db.query("gifts").collect());
    expect(gifts.every((g) => g.transactionId === wire)).toBe(true);

    // The book that HOLDS the wire counts only its own $2,000 gift — the
    // deposit itself is fully accounted for and adds nothing on top.
    const breakdown = await s.as.query(api.reconciliation.bookValueBreakdown, {
      scope: s.chapterId,
    });
    expect(breakdown.revenueCents).toBe(200_000);
    expect(breakdown.ledgerNetCents).toBe(0);
    expect(breakdown.zeroContributors.linkedGiftCredits).toBe(1);
  });

  test("matching only part of a wire leaves the rest counted and visible", async () => {
    const s = await devDirectorSetup();
    const wire = await seedCredit(s, 700_000);
    const local = await seedGift(s, 200_000);

    await s.as.mutation(api.givingCandidates.linkGiftToTransaction, {
      giftId: local,
      transactionId: wire,
    });

    const breakdown = await s.as.query(api.reconciliation.bookValueBreakdown, {
      scope: s.chapterId,
    });
    // $5,000 of the wire is still unexplained income, which is the honest
    // reading — half-done work should not read as finished.
    expect(breakdown.ledgerNetCents).toBe(500_000);
    expect(breakdown.zeroContributors.linkedGiftCredits).toBe(0);
    expect(breakdown.inflows.map((i) => i.amountCents)).toEqual([500_000]);
  });

  test("refuses a link that would make the gifts exceed the deposit", async () => {
    const s = await devDirectorSetup();
    const wire = await seedCredit(s, 700_000);
    const first = await seedGift(s, 500_000);
    const tooBig = await seedGift(s, 300_000);

    await s.as.mutation(api.givingCandidates.linkGiftToTransaction, {
      giftId: first,
      transactionId: wire,
    });
    await expect(
      s.as.mutation(api.givingCandidates.linkGiftToTransaction, {
        giftId: tooBig,
        transactionId: wire,
      }),
    ).rejects.toSatisfy((e) => errCode(e) === "OVER_COVERED");
  });

  test("still refuses an outflow and a gift that already points somewhere", async () => {
    const s = await devDirectorSetup();
    const debit = await seedCredit(s, 5_000, { flow: "outflow" });
    const credit = await seedCredit(s, 5_000);
    const gift = await seedGift(s, 5_000);

    await expect(
      s.as.mutation(api.givingCandidates.linkGiftToTransaction, {
        giftId: gift,
        transactionId: debit,
      }),
    ).rejects.toSatisfy((e) => errCode(e) === "NOT_AN_INFLOW");

    await s.as.mutation(api.givingCandidates.linkGiftToTransaction, {
      giftId: gift,
      transactionId: credit,
    });
    await expect(
      s.as.mutation(api.givingCandidates.linkGiftToTransaction, {
        giftId: gift,
        transactionId: credit,
      }),
    ).rejects.toSatisfy((e) => errCode(e) === "ALREADY_LINKED");
  });

  test("unlinking gives the deposit back, and is a safe no-op twice", async () => {
    const s = await devDirectorSetup();
    const wire = await seedCredit(s, 700_000);
    const gift = await seedGift(s, 700_000);

    await s.as.mutation(api.givingCandidates.linkGiftToTransaction, {
      giftId: gift,
      transactionId: wire,
    });
    await s.as.mutation(api.givingCandidates.unlinkGiftFromTransaction, {
      giftId: gift,
    });
    await s.as.mutation(api.givingCandidates.unlinkGiftFromTransaction, {
      giftId: gift,
    });

    const breakdown = await s.as.query(api.reconciliation.bookValueBreakdown, {
      scope: s.chapterId,
    });
    expect(breakdown.ledgerNetCents).toBe(700_000);
    // And it can be matched again — an unlink is a retraction, not a tombstone.
    await s.as.mutation(api.givingCandidates.linkGiftToTransaction, {
      giftId: gift,
      transactionId: wire,
    });
  });
});

describe("the detector offers the parts of a split", () => {
  test("a $7,000 wire proposes the $5,000 and the $2,000 gift, not neither", async () => {
    const s = await devDirectorSetup();
    const at = Date.now() - DAY_MS;
    const wire = await seedCredit(s, 700_000, { postedAt: at });
    await seedGift(s, 500_000, { scope: "central", receivedAt: at });
    await seedGift(s, 200_000, { receivedAt: at });

    const breakdown = await s.as.query(api.reconciliation.bookValueBreakdown, {
      scope: s.chapterId,
    });
    const offers = breakdown.suspectedDoubleCounts.filter(
      (d) => d.transactionId === wire,
    );
    expect(offers.map((o) => o.giftAmountCents).sort((a, b) => b - a)).toEqual([
      500_000, 200_000,
    ]);
    // The larger is offered first and names its book; the second is offered
    // against what the first would leave behind.
    expect(offers[0].giftBookLabel).toBe("Central");
    expect(offers[0].uncoveredCents).toBe(700_000);
    expect(offers[1].giftBookLabel).toBe(null);
    expect(offers[1].uncoveredCents).toBe(200_000);
  });

  test("a gift bigger than what is left is not offered", async () => {
    const s = await devDirectorSetup();
    const at = Date.now() - DAY_MS;
    const wire = await seedCredit(s, 100_000, { postedAt: at });
    await seedGift(s, 500_000, { receivedAt: at });

    const breakdown = await s.as.query(api.reconciliation.bookValueBreakdown, {
      scope: s.chapterId,
    });
    expect(
      breakdown.suspectedDoubleCounts.filter((d) => d.transactionId === wire),
    ).toHaveLength(0);
  });
});
