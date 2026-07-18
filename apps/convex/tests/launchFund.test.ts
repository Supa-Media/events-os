import { describe, expect, test } from "vitest";
import {
  affordabilityTierLabel,
  launchTemplateTotalCents,
} from "@events-os/shared";
import { api } from "../_generated/api";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { runSeedSeatDefs } from "../migrations/0022_seed_seat_defs";
import { runBackfillLaunchFund } from "../migrations/0030_backfill_launch_fund";
import {
  matchOrCreateDonor,
  recordGiftForDonor,
  removeGiftRow,
} from "../lib/givingDonors";
import type { Doc, Id } from "../_generated/dataModel";

/**
 * Territories launch pot (docs/plans/giving-territories.md §D3) — the accrual/
 * freeze wiring, the 0030 backfill, the public pot series, and the pre-launch
 * readiness surface + its dual access gate.
 *
 * Pot rules under test:
 *  - 100% accrual: a gift on a `prospect`/`raising` territory's chapter bumps
 *    that territory's `launchFundCents` and stamps `gifts.countedInLaunchFund`;
 *  - a gift on a launched (or territory-less) chapter does NOT (no flag);
 *  - removal reverses ONLY a flagged gift, exactly once;
 *  - FREEZE: once launched, a delete of a pre-launch gift never un-bumps.
 */

/** Link a `people` row to the caller's user + seat them (needs seatDefs). */
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

/** A caller seated as development director at central (full central giving). */
async function devDirectorSetup(): Promise<ChapterSetup> {
  const t = newT();
  await run(t, (ctx) => runSeedSeatDefs(ctx));
  const s = await setupChapter(t);
  await seatCaller(s, "development_director", "central");
  return s;
}

/** Create a prospect territory (+ its shadow chapter) via the product flow. */
async function createTerritory(
  s: ChapterSetup,
  opts: { slug: string; targetBackers?: number; publiclyVisible?: boolean },
): Promise<{ territoryId: Id<"territories">; chapterId: Id<"chapters"> }> {
  const territoryId = await s.as.mutation(api.territories.saveTerritory, {
    name: opts.slug,
    region: "NY",
    lat: 40.7,
    lng: -73.9,
    slug: opts.slug,
    publiclyVisible: opts.publiclyVisible ?? true,
    ...(opts.targetBackers ? { targetBackers: opts.targetBackers } : {}),
  });
  const territory = await run(s.t, (ctx) => ctx.db.get(territoryId));
  return { territoryId, chapterId: territory!.chapterId };
}

/** Record a gift on `scope` through the money choke point (primitive). */
async function recordGift(
  s: ChapterSetup,
  scope: Id<"chapters">,
  amountCents: number,
  receivedAt = Date.now(),
  email = `d${Math.random()}@example.com`,
): Promise<Id<"gifts">> {
  return run(s.t, async (ctx) => {
    const donorId = await matchOrCreateDonor(ctx, {
      scope,
      name: "Backer",
      email,
    });
    return recordGiftForDonor(ctx, {
      donorId,
      amountCents,
      receivedAt,
      method: "stripe",
    });
  });
}

const potCents = (s: ChapterSetup, id: Id<"territories">) =>
  run(s.t, async (ctx) => (await ctx.db.get(id))!.launchFundCents);
const giftFlag = (s: ChapterSetup, id: Id<"gifts">) =>
  run(s.t, async (ctx) => (await ctx.db.get(id))?.countedInLaunchFund);

// ── Accrual ──────────────────────────────────────────────────────────────────

describe("launch pot accrual", () => {
  test("a gift on a prospect territory's chapter bumps the pot + stamps the flag", async () => {
    const s = await devDirectorSetup();
    const { territoryId, chapterId } = await createTerritory(s, { slug: "queens" });

    const giftId = await recordGift(s, chapterId, 5000);
    expect(await potCents(s, territoryId)).toBe(5000);
    expect(await giftFlag(s, giftId)).toBe(true);

    // A second pre-launch gift accrues 100% too.
    const giftId2 = await recordGift(s, chapterId, 2500);
    expect(await potCents(s, territoryId)).toBe(7500);
    expect(await giftFlag(s, giftId2)).toBe(true);
  });

  test("raising stage accrues too", async () => {
    const s = await devDirectorSetup();
    const { territoryId, chapterId } = await createTerritory(s, { slug: "columbus" });
    await s.as.mutation(api.territories.setTerritoryStage, {
      territoryId,
      stage: "raising",
    });
    await recordGift(s, chapterId, 4200);
    expect(await potCents(s, territoryId)).toBe(4200);
  });

  test("a gift on a LAUNCHED chapter does NOT bump (no flag) — the freeze", async () => {
    const s = await devDirectorSetup();
    const { territoryId, chapterId } = await createTerritory(s, { slug: "brooklyn" });
    await s.as.mutation(api.territories.setTerritoryStage, {
      territoryId,
      stage: "launched",
    });
    const giftId = await recordGift(s, chapterId, 5000);
    expect(await potCents(s, territoryId)).toBe(0); // frozen at 0
    expect(await giftFlag(s, giftId)).not.toBe(true);
  });

  test("a gift on a chapter with NO territory does NOT bump (no flag)", async () => {
    const s = await devDirectorSetup();
    // `s.chapterId` is a bare active chapter with no territory.
    const giftId = await recordGift(s, s.chapterId, 9000);
    expect(await giftFlag(s, giftId)).not.toBe(true);
  });
});

// ── Reversal ───────────────────────────────────────────────────────────────

describe("launch pot reversal", () => {
  test("removing a flagged gift reverses the pot exactly once", async () => {
    const s = await devDirectorSetup();
    const { territoryId, chapterId } = await createTerritory(s, { slug: "austin" });
    const g1 = await recordGift(s, chapterId, 5000);
    await recordGift(s, chapterId, 3000);
    expect(await potCents(s, territoryId)).toBe(8000);

    // g1 (5000) reverses by exactly 5000: 8000 → 3000 (the remaining 3000 gift).
    await run(s.t, (ctx) => removeGiftRow(ctx, g1));
    expect(await potCents(s, territoryId)).toBe(3000);
  });

  test("removing an UNFLAGGED gift never touches a pot", async () => {
    const s = await devDirectorSetup();
    const { territoryId, chapterId } = await createTerritory(s, { slug: "denver" });
    await recordGift(s, chapterId, 5000); // flagged, pot 5000
    // A gift on the territory-less bare chapter — unflagged.
    const bareGift = await recordGift(s, s.chapterId, 9000);

    await run(s.t, (ctx) => removeGiftRow(ctx, bareGift));
    expect(await potCents(s, territoryId)).toBe(5000); // untouched
  });

  test("FREEZE: a post-launch delete of a pre-launch gift does NOT un-bump", async () => {
    const s = await devDirectorSetup();
    const { territoryId, chapterId } = await createTerritory(s, { slug: "miami" });
    const g1 = await recordGift(s, chapterId, 5000);
    expect(await potCents(s, territoryId)).toBe(5000);

    // Launch freezes the pot at 5000 (setTerritoryStage never touches it).
    await s.as.mutation(api.territories.setTerritoryStage, {
      territoryId,
      stage: "launched",
    });
    expect(await potCents(s, territoryId)).toBe(5000);

    // Deleting the (still-flagged) pre-launch gift must NOT un-bump the frozen pot.
    await run(s.t, (ctx) => removeGiftRow(ctx, g1));
    expect(await potCents(s, territoryId)).toBe(5000);
    // The row is gone; nothing else to reverse.
    expect(await run(s.t, (ctx) => ctx.db.get(g1))).toBeNull();
  });
});

// ── Migration 0030 ───────────────────────────────────────────────────────────

describe("0030 backfill launch fund", () => {
  /** Insert an UNcounted gift row directly (pre-wiring history). */
  async function seedRawGift(
    s: ChapterSetup,
    scope: Id<"chapters">,
    amountCents: number,
  ): Promise<void> {
    await run(s.t, async (ctx) => {
      const donorId = await ctx.db.insert("donors", {
        scope,
        kind: "individual",
        name: "Legacy",
        status: "prospect",
        lifetimeCents: amountCents,
        giftCount: 1,
        createdAt: Date.now(),
      });
      await ctx.db.insert("gifts", {
        donorId,
        scope,
        amountCents,
        currency: "usd",
        receivedAt: Date.now(),
        method: "other",
        createdAt: Date.now(),
      });
    });
  }

  test("sums chapter gifts into the pot + stamps flags; idempotent", async () => {
    const s = await devDirectorSetup();
    const { territoryId, chapterId } = await createTerritory(s, { slug: "raleigh" });
    // Two pre-existing, uncounted gifts (pot still 0).
    await seedRawGift(s, chapterId, 5000);
    await seedRawGift(s, chapterId, 3000);
    expect(await potCents(s, territoryId)).toBe(0);

    const r1 = await run(s.t, (ctx) => runBackfillLaunchFund(ctx));
    expect(r1.giftsStamped).toBe(2);
    expect(await potCents(s, territoryId)).toBe(8000);
    // Every gift now flagged.
    const flags = await run(s.t, (ctx) =>
      ctx.db
        .query("gifts")
        .withIndex("by_scope", (q) => q.eq("scope", chapterId))
        .collect(),
    );
    expect(flags.every((g) => g.countedInLaunchFund === true)).toBe(true);

    // Idempotent: recompute-style, so a re-run neither doubles the pot nor
    // re-stamps anything.
    const r2 = await run(s.t, (ctx) => runBackfillLaunchFund(ctx));
    expect(r2.giftsStamped).toBe(0);
    expect(await potCents(s, territoryId)).toBe(8000);
  });

  test("leaves a launched territory's pot frozen (skips it)", async () => {
    const s = await devDirectorSetup();
    const { territoryId, chapterId } = await createTerritory(s, { slug: "tampa" });
    // Seed a raw gift, then launch — the backfill must not process it.
    await seedRawGift(s, chapterId, 5000);
    await run(s.t, (ctx) =>
      ctx.db.patch(territoryId, { launchFundCents: 7777 }),
    );
    await s.as.mutation(api.territories.setTerritoryStage, {
      territoryId,
      stage: "launched",
    });

    await run(s.t, (ctx) => runBackfillLaunchFund(ctx));
    expect(await potCents(s, territoryId)).toBe(7777); // untouched (frozen)
  });
});

// ── Public pot series ─────────────────────────────────────────────────────────

describe("getPublicTerritory launch fund", () => {
  test("months series is 12 long, current month carries the gift; pot + target present", async () => {
    const s = await devDirectorSetup();
    const { territoryId, chapterId } = await createTerritory(s, { slug: "boston" });
    await recordGift(s, chapterId, 5000);
    await recordGift(s, chapterId, 1000);

    const data = await s.t.query(api.territories.getPublicTerritory, {
      slug: "boston",
    });
    expect(data!.launchFund).not.toBeNull();
    const lf = data!.launchFund!;
    expect(lf.cents).toBe(6000);
    expect(lf.targetCents).toBe(launchTemplateTotalCents());
    expect(lf.months).toHaveLength(12);
    // Both gifts landed this (Eastern) month → the last bucket.
    expect(lf.months[11].cents).toBe(6000);
    // Total across the window equals the two gifts.
    expect(lf.months.reduce((sum, m) => sum + m.cents, 0)).toBe(6000);

    // After launch the pot freezes and the public field is null.
    await s.as.mutation(api.territories.setTerritoryStage, {
      territoryId,
      stage: "launched",
    });
    const launched = await s.t.query(api.territories.getPublicTerritory, {
      slug: "boston",
    });
    expect(launched!.launchFund).toBeNull();
  });
});

// ── Pre-launch readiness ─────────────────────────────────────────────────────

/** Insert a prospect territory + shadow chapter directly (no product flow),
 *  for access tests that don't seat a dev director. */
async function insertProspectTerritory(
  s: ChapterSetup,
  slug: string,
): Promise<{ territoryId: Id<"territories">; chapterId: Id<"chapters"> }> {
  return run(s.t, async (ctx) => {
    const chapterId = (await ctx.db.insert("chapters", {
      name: slug,
      slug,
      isActive: false,
      backerCount: 0,
      createdAt: Date.now(),
    })) as Id<"chapters">;
    const territoryId = (await ctx.db.insert("territories", {
      chapterId,
      name: slug,
      region: "NY",
      lat: 40.7,
      lng: -73.9,
      slug,
      stage: "prospect",
      targetBackers: 20,
      publiclyVisible: true,
      launchFundCents: 0,
      launchFundTargetCents: launchTemplateTotalCents(),
      createdAt: Date.now(),
      createdBy: s.userId,
      updatedAt: Date.now(),
    })) as Id<"territories">;
    return { territoryId, chapterId };
  });
}

describe("prelaunchReadiness", () => {
  test("numbers: pot, remaining burden, backers, active monthly, tier", async () => {
    const s = await devDirectorSetup();
    const { territoryId, chapterId } = await createTerritory(s, {
      slug: "sacramento",
      targetBackers: 20,
    });
    // Live derived backerCount on the chapter.
    await run(s.t, (ctx) => ctx.db.patch(chapterId, { backerCount: 6 }));
    // Two active pledges (run-rate 10000) + one canceled that must NOT count.
    await run(s.t, async (ctx) => {
      const donorId = await ctx.db.insert("donors", {
        scope: chapterId,
        kind: "individual",
        name: "P",
        status: "active",
        lifetimeCents: 0,
        giftCount: 0,
        createdAt: Date.now(),
      });
      for (const [amt, status] of [
        [5000, "active"],
        [5000, "active"],
        [9999, "canceled"],
      ] as const) {
        await ctx.db.insert("pledges", {
          donorId,
          scope: chapterId,
          amountCents: amt,
          status,
          origin: "stripe",
          createdAt: Date.now(),
        });
      }
    });
    await recordGift(s, chapterId, 5000);
    await recordGift(s, chapterId, 5000); // pot 10000

    const rows = await s.as.query(api.territories.prelaunchReadiness, {});
    const row = rows.find((r) => r.territoryId === territoryId)!;
    expect(row).toBeDefined();
    expect(row.potCents).toBe(10000);
    expect(row.potTargetCents).toBe(launchTemplateTotalCents());
    expect(row.remainingCentralBurdenCents).toBe(
      launchTemplateTotalCents() - 10000,
    );
    expect(row.backerCount).toBe(6);
    expect(row.targetBackers).toBe(20);
    expect(row.activeMonthlyCents).toBe(10000);
    expect(row.tierLabel).toBe(affordabilityTierLabel(6));
    // Launched territories never appear.
    expect(rows.every((r) => r.stage !== "launched")).toBe(true);
  });

  test("access: central finance viewer passes", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));
    const s = await setupChapter(t);
    await insertProspectTerritory(s, "reno");
    // Central finance VIEWER, no giving access at all.
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
    const rows = await s.as.query(api.territories.prelaunchReadiness, {});
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  test("access: central giving.view passes", async () => {
    const s = await devDirectorSetup();
    await createTerritory(s, { slug: "eugene" });
    const rows = await s.as.query(api.territories.prelaunchReadiness, {});
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  test("access: a chapter-scope-only caller gets an empty list", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));
    const s = await setupChapter(t);
    await insertProspectTerritory(s, "fresno");
    // Chapter-scope giving.view + chapter finance viewer — never central.
    await seatCaller(s, "chapter_director", s.chapterId);
    const rows = await s.as.query(api.territories.prelaunchReadiness, {});
    expect(rows).toEqual([]);
  });
});
