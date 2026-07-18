import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { AFFORDABILITY_TIERS } from "@events-os/shared";
import { api, internal } from "../_generated/api";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { runSeedSeatDefs } from "../migrations/0022_seed_seat_defs";
import type { Id } from "../_generated/dataModel";

/**
 * Giving Platform (F-6 P3) — the City Launch map's backend tests
 * (`cityCampaigns.ts`, docs/plans/giving-platform.md §5):
 *  - `saveCampaign` validation (slug format/uniqueness, lat/lng bounds) + the
 *    central `giving.manage` gate,
 *  - `setCampaignStatus`'s launch-requires-a-chapter rule,
 *  - public queries (`getPublicMapData`/`getPublicCampaign`) return ONLY
 *    `publiclyVisible` campaigns and never a donor field,
 *  - a `cityCampaignId` pledge is central-scoped + campaign-linked, and is
 *    rejected for a hidden/unavailable campaign,
 *  - the campaign's derived `backerCount` recomputes on pledge transitions
 *    ($20 excluded, $50 counted — mirrors `givingPledges.test.ts`),
 *  - `getPublicCampaign`'s milestone ladder + next-milestone progress math,
 *    both with a configured ladder and the `AFFORDABILITY_TIERS` fallback.
 */

/** Link a `people` row to the caller's user + seat them (requires seeded
 *  seatDefs) — copied from `givingPledges.test.ts` (each test file keeps its
 *  own copy, matching that file's established convention). */
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
 *  `giving.manage` over central — the gate every admin mutation here uses). */
async function devDirectorSetup(): Promise<ChapterSetup> {
  const t = newT();
  await run(t, (ctx) => runSeedSeatDefs(ctx));
  const s = await setupChapter(t);
  await seatCaller(s, "development_director", "central");
  return s;
}

async function insertCampaign(
  s: ChapterSetup,
  overrides: Partial<{
    name: string;
    region: string;
    lat: number;
    lng: number;
    slug: string;
    status: "prospect" | "raising" | "launched";
    chapterId: Id<"chapters">;
    targetBackers: number;
    story: string;
    publiclyVisible: boolean;
    backerCount: number;
  }> = {},
): Promise<Id<"cityCampaigns">> {
  const now = Date.now();
  return run(s.t, (ctx) =>
    ctx.db.insert("cityCampaigns", {
      name: "Columbus",
      region: "OH",
      lat: 39.9612,
      lng: -82.9988,
      slug: "columbus-oh",
      status: "prospect",
      targetBackers: 20,
      publiclyVisible: true,
      backerCount: 0,
      createdAt: now,
      createdBy: s.userId,
      updatedAt: now,
      ...overrides,
    }),
  );
}

async function campaignRow(s: ChapterSetup, id: Id<"cityCampaigns">) {
  return run(s.t, (ctx) => ctx.db.get(id));
}

async function seedConfiguredLadder(s: ChapterSetup): Promise<void> {
  const now = Date.now();
  await run(s.t, async (ctx) => {
    await ctx.db.insert("backerMilestones", {
      minBackers: 5,
      label: "WWS",
      commitment: "Worship With Strangers, monthly",
      sortOrder: 0,
      updatedAt: now,
    });
    await ctx.db.insert("backerMilestones", {
      minBackers: 10,
      label: "+Eden",
      commitment: "Eden",
      description: "A second monthly gathering.",
      sortOrder: 1,
      updatedAt: now,
    });
  });
}

// ── saveCampaign ─────────────────────────────────────────────────────────────

describe("saveCampaign", () => {
  test("creates a campaign, defaulting targetBackers from the ladder fallback", async () => {
    const s = await devDirectorSetup();
    const id = await s.as.mutation(api.cityCampaigns.saveCampaign, {
      name: "Columbus",
      region: "OH",
      lat: 39.9612,
      lng: -82.9988,
      slug: "columbus-oh",
      publiclyVisible: false,
    });
    const row = await campaignRow(s, id);
    expect(row?.status).toBe("prospect");
    expect(row?.backerCount).toBe(0);
    // No configured ladder → falls back to AFFORDABILITY_TIERS' lowest rung.
    const lowest = [...AFFORDABILITY_TIERS].sort(
      (a, b) => a.minBackers - b.minBackers,
    )[0];
    expect(row?.targetBackers).toBe(lowest.minBackers);
  });

  test("rejects an invalid slug, and a duplicate slug on another campaign", async () => {
    const s = await devDirectorSetup();
    await expect(
      s.as.mutation(api.cityCampaigns.saveCampaign, {
        name: "Columbus",
        region: "OH",
        lat: 39.9612,
        lng: -82.9988,
        slug: "Columbus OH!",
        publiclyVisible: false,
      }),
    ).rejects.toThrow();

    const first = await s.as.mutation(api.cityCampaigns.saveCampaign, {
      name: "Columbus",
      region: "OH",
      lat: 39.9612,
      lng: -82.9988,
      slug: "columbus-oh",
      publiclyVisible: false,
    });
    expect(first).toBeDefined();

    await expect(
      s.as.mutation(api.cityCampaigns.saveCampaign, {
        name: "Cbus Take Two",
        region: "OH",
        lat: 40.0,
        lng: -83.0,
        slug: "columbus-oh",
        publiclyVisible: false,
      }),
    ).rejects.toThrow();

    // But re-saving the SAME campaign under its own slug is fine.
    await expect(
      s.as.mutation(api.cityCampaigns.saveCampaign, {
        campaignId: first,
        name: "Columbus",
        region: "OH",
        lat: 39.9612,
        lng: -82.9988,
        slug: "columbus-oh",
        publiclyVisible: true,
      }),
    ).resolves.toBe(first);
  });

  test("rejects out-of-range lat/lng and a non-positive targetBackers", async () => {
    const s = await devDirectorSetup();
    await expect(
      s.as.mutation(api.cityCampaigns.saveCampaign, {
        name: "Nowhere",
        region: "XX",
        lat: 95, // out of range
        lng: -82.9988,
        slug: "nowhere",
        publiclyVisible: false,
      }),
    ).rejects.toThrow();

    await expect(
      s.as.mutation(api.cityCampaigns.saveCampaign, {
        name: "Nowhere",
        region: "XX",
        lat: 39.9612,
        lng: -190, // out of range
        slug: "nowhere",
        publiclyVisible: false,
      }),
    ).rejects.toThrow();

    await expect(
      s.as.mutation(api.cityCampaigns.saveCampaign, {
        name: "Nowhere",
        region: "XX",
        lat: 39.9612,
        lng: -82.9988,
        slug: "nowhere",
        targetBackers: 0,
        publiclyVisible: false,
      }),
    ).rejects.toThrow();
  });

  test("gating: a plain chapter admin is rejected; a development director passes", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));
    const s = await setupChapter(t);

    await expect(
      s.as.mutation(api.cityCampaigns.saveCampaign, {
        name: "Columbus",
        region: "OH",
        lat: 39.9612,
        lng: -82.9988,
        slug: "columbus-oh",
        publiclyVisible: false,
      }),
    ).rejects.toBeInstanceOf(ConvexError);
    await expect(
      s.as.query(api.cityCampaigns.listCampaignsAdmin, {}),
    ).rejects.toBeInstanceOf(ConvexError);

    // A CHAPTER-scope giving.manage seat still isn't enough — the map gates
    // on CENTRAL manage only.
    await seatCaller(s, "chapter_director", s.chapterId);
    await expect(
      s.as.mutation(api.cityCampaigns.saveCampaign, {
        name: "Columbus",
        region: "OH",
        lat: 39.9612,
        lng: -82.9988,
        slug: "columbus-oh",
        publiclyVisible: false,
      }),
    ).rejects.toBeInstanceOf(ConvexError);

    await seatCaller(s, "development_director", "central");
    await expect(
      s.as.mutation(api.cityCampaigns.saveCampaign, {
        name: "Columbus",
        region: "OH",
        lat: 39.9612,
        lng: -82.9988,
        slug: "columbus-oh",
        publiclyVisible: false,
      }),
    ).resolves.toBeDefined();
  });
});

// ── setCampaignStatus ──────────────────────────────────────────────────────

describe("setCampaignStatus", () => {
  test("launching requires a chapterId; succeeds once one is given", async () => {
    const s = await devDirectorSetup();
    const id = await insertCampaign(s);

    await expect(
      s.as.mutation(api.cityCampaigns.setCampaignStatus, {
        campaignId: id,
        status: "launched",
      }),
    ).rejects.toBeInstanceOf(ConvexError);

    await s.as.mutation(api.cityCampaigns.setCampaignStatus, {
      campaignId: id,
      status: "launched",
      chapterId: s.chapterId,
    });
    const row = await campaignRow(s, id);
    expect(row?.status).toBe("launched");
    expect(row?.chapterId).toBe(s.chapterId);
  });

  test("raising doesn't require a chapter", async () => {
    const s = await devDirectorSetup();
    const id = await insertCampaign(s);
    await s.as.mutation(api.cityCampaigns.setCampaignStatus, {
      campaignId: id,
      status: "raising",
    });
    expect((await campaignRow(s, id))?.status).toBe("raising");
  });
});

// ── Public reads ─────────────────────────────────────────────────────────────

describe("getPublicMapData", () => {
  test("returns only publiclyVisible campaigns, and only map aggregates", async () => {
    const s = await devDirectorSetup();
    await insertCampaign(s, {
      slug: "visible-1",
      name: "Visible City",
      publiclyVisible: true,
      backerCount: 7,
    });
    await insertCampaign(s, {
      slug: "hidden-1",
      name: "Hidden City",
      publiclyVisible: false,
    });

    const rows = await s.as.query(api.cityCampaigns.getPublicMapData, {});
    expect(rows).toHaveLength(1);
    expect(rows[0].slug).toBe("visible-1");
    expect(rows[0].backerCount).toBe(7);
    // Only the documented aggregate fields — no donor/pledge/PII leakage.
    expect(Object.keys(rows[0]).sort()).toEqual(
      [
        "backerCount",
        "lat",
        "lng",
        "name",
        "region",
        "slug",
        "status",
        "targetBackers",
      ].sort(),
    );
  });

  test("a launched campaign's backerCount reads the linked chapter's live count", async () => {
    const s = await devDirectorSetup();
    await run(s.t, (ctx) => ctx.db.patch(s.chapterId, { backerCount: 42 }));
    await insertCampaign(s, {
      slug: "launched-1",
      status: "launched",
      chapterId: s.chapterId,
      publiclyVisible: true,
      backerCount: 3, // stale campaign-scoped counter — the chapter's wins
    });

    const rows = await s.as.query(api.cityCampaigns.getPublicMapData, {});
    expect(rows[0].backerCount).toBe(42);
  });

  test("an anonymous (no-auth) caller can read the public map", async () => {
    const s = await devDirectorSetup();
    await insertCampaign(s, { slug: "anon-visible", publiclyVisible: true });
    const rows = await s.t.query(api.cityCampaigns.getPublicMapData, {});
    expect(rows).toHaveLength(1);
  });
});

describe("getPublicCampaign", () => {
  test("returns null for a hidden or unknown slug", async () => {
    const s = await devDirectorSetup();
    await insertCampaign(s, { slug: "hidden-camp", publiclyVisible: false });
    expect(
      await s.t.query(api.cityCampaigns.getPublicCampaign, {
        slug: "hidden-camp",
      }),
    ).toBeNull();
    expect(
      await s.t.query(api.cityCampaigns.getPublicCampaign, {
        slug: "does-not-exist",
      }),
    ).toBeNull();
  });

  test("milestone ladder + next-milestone progress: configured ladder wins over the fallback", async () => {
    const s = await devDirectorSetup();
    await seedConfiguredLadder(s);
    const id = await insertCampaign(s, {
      slug: "ladder-camp",
      publiclyVisible: true,
      backerCount: 6,
    });

    const data = await s.t.query(api.cityCampaigns.getPublicCampaign, {
      slug: "ladder-camp",
    });
    expect(data).not.toBeNull();
    expect(data!.milestones).toEqual([
      {
        minBackers: 5,
        label: "WWS",
        commitment: "Worship With Strangers, monthly",
        description: undefined,
      },
      {
        minBackers: 10,
        label: "+Eden",
        commitment: "Eden",
        description: "A second monthly gathering.",
      },
    ]);
    // 6 backers: past the 5-rung, short of the 10-rung.
    expect(data!.nextMilestone).toEqual({
      minBackers: 10,
      label: "+Eden",
      commitment: "Eden",
      description: "A second monthly gathering.",
    });
    void id;
  });

  test("falls back to AFFORDABILITY_TIERS when no ladder is configured; null nextMilestone past the top rung", async () => {
    const s = await devDirectorSetup();
    const top = Math.max(...AFFORDABILITY_TIERS.map((t) => t.minBackers));
    await insertCampaign(s, {
      slug: "fallback-camp",
      publiclyVisible: true,
      backerCount: top + 5,
    });

    const data = await s.t.query(api.cityCampaigns.getPublicCampaign, {
      slug: "fallback-camp",
    });
    expect(data!.milestones).toHaveLength(AFFORDABILITY_TIERS.length);
    const sorted = [...AFFORDABILITY_TIERS].sort(
      (a, b) => a.minBackers - b.minBackers,
    );
    expect(data!.milestones.map((m) => m.minBackers)).toEqual(
      sorted.map((t) => t.minBackers),
    );
    // Past every rung → no next milestone.
    expect(data!.nextMilestone).toBeNull();
  });
});

// ── cityCampaignId pledges ─────────────────────────────────────────────────

describe("preparePledge with cityCampaignId", () => {
  test("creates a central-scoped pledge linked to the campaign", async () => {
    const s = await devDirectorSetup();
    const id = await insertCampaign(s, {
      slug: "prep-camp",
      status: "raising",
      publiclyVisible: true,
    });

    const prepared = await s.t.mutation(internal.givingPledges.preparePledge, {
      cityCampaignId: id,
      amountCents: 5000,
      name: "City Backer",
      email: "backer@example.com",
    });
    const pledge = await run(s.t, (ctx) =>
      ctx.db.get(prepared.pledgeId as Id<"pledges">),
    );
    expect(pledge?.scope).toBe("central");
    expect(pledge?.cityCampaignId).toBe(id);
    expect(pledge?.status).toBe("incomplete");
    expect(prepared.campaignSlug).toBe("prep-camp");

    const donor = await run(s.t, (ctx) => ctx.db.get(pledge!.donorId));
    expect(donor?.scope).toBe("central");
    expect(donor?.source).toBe("map");
  });

  test("rejects a hidden campaign", async () => {
    const s = await devDirectorSetup();
    const id = await insertCampaign(s, {
      slug: "hidden-prep",
      status: "raising",
      publiclyVisible: false,
    });
    await expect(
      s.t.mutation(internal.givingPledges.preparePledge, {
        cityCampaignId: id,
        amountCents: 5000,
        name: "X",
        email: "x@example.com",
      }),
    ).rejects.toThrow();
  });

  test("rejects a launched campaign (checkout should target the chapter instead)", async () => {
    const s = await devDirectorSetup();
    const id = await insertCampaign(s, {
      slug: "launched-prep",
      status: "launched",
      chapterId: s.chapterId,
      publiclyVisible: true,
    });
    await expect(
      s.t.mutation(internal.givingPledges.preparePledge, {
        cityCampaignId: id,
        amountCents: 5000,
        name: "X",
        email: "x@example.com",
      }),
    ).rejects.toThrow();
  });

  test("rejects when both chapterId and cityCampaignId (or neither) are given", async () => {
    const s = await devDirectorSetup();
    const id = await insertCampaign(s, { status: "raising" });
    await expect(
      s.t.mutation(internal.givingPledges.preparePledge, {
        chapterId: s.chapterId,
        cityCampaignId: id,
        amountCents: 5000,
        name: "X",
        email: "x@example.com",
      }),
    ).rejects.toThrow();
    await expect(
      s.t.mutation(internal.givingPledges.preparePledge, {
        amountCents: 5000,
        name: "X",
        email: "x@example.com",
      }),
    ).rejects.toThrow();
  });
});

describe("resolveCampaignForCheckout", () => {
  test("routes a raising campaign to itself, and a launched one to its chapter", async () => {
    const s = await devDirectorSetup();
    const raisingId = await insertCampaign(s, {
      slug: "route-raising",
      status: "raising",
      publiclyVisible: true,
    });
    const launchedId = await insertCampaign(s, {
      slug: "route-launched",
      status: "launched",
      chapterId: s.chapterId,
      publiclyVisible: true,
    });

    const raisingResolved = await run(s.t, (ctx) =>
      ctx.runQuery(internal.cityCampaigns.resolveCampaignForCheckout, {
        slug: "route-raising",
      }),
    );
    expect(raisingResolved).toEqual({ kind: "campaign", cityCampaignId: raisingId });

    const launchedResolved = await run(s.t, (ctx) =>
      ctx.runQuery(internal.cityCampaigns.resolveCampaignForCheckout, {
        slug: "route-launched",
      }),
    );
    expect(launchedResolved).toEqual({ kind: "chapter", chapterId: s.chapterId });

    expect(
      await run(s.t, (ctx) =>
        ctx.runQuery(internal.cityCampaigns.resolveCampaignForCheckout, {
          slug: "does-not-exist",
        }),
      ),
    ).toBeNull();
    void launchedId;
  });
});

// ── Derived campaign backerCount ────────────────────────────────────────────

describe("campaign backerCount recompute on pledge transitions", () => {
  test("$50 counts, $20 doesn't; cancel decrements", async () => {
    const s = await devDirectorSetup();
    const id = await insertCampaign(s, {
      slug: "count-camp",
      status: "raising",
      publiclyVisible: true,
    });

    async function prepareAndActivate(
      amountCents: number,
      subscriptionId: string,
      email: string,
    ) {
      const prepared = await s.t.mutation(internal.givingPledges.preparePledge, {
        cityCampaignId: id,
        amountCents,
        name: "Backer " + subscriptionId,
        email,
      });
      await s.t.mutation(internal.givingPledges.activatePledgeFromCheckout, {
        pledgeId: String(prepared.pledgeId),
        stripeSubscriptionId: subscriptionId,
      });
      return prepared.pledgeId as Id<"pledges">;
    }

    await prepareAndActivate(5000, "sub_camp_a", "a@example.com");
    expect((await campaignRow(s, id))?.backerCount).toBe(1);

    // Below BACKER_UNIT_CENTS: a donor, not a backer.
    await prepareAndActivate(2000, "sub_camp_b", "b@example.com");
    expect((await campaignRow(s, id))?.backerCount).toBe(1);

    const pledgeC = await prepareAndActivate(5000, "sub_camp_c", "c@example.com");
    expect((await campaignRow(s, id))?.backerCount).toBe(2);

    await s.t.mutation(internal.givingPledges.cancelPledgeSubscription, {
      subscriptionId: "sub_camp_c",
    });
    expect((await campaignRow(s, id))?.backerCount).toBe(1);
    void pledgeC;

    // The plain chapter's own backerCount is untouched by campaign pledges.
    const chapter = await run(s.t, (ctx) => ctx.db.get(s.chapterId));
    expect(chapter?.backerCount ?? 0).toBe(0);
  });
});
