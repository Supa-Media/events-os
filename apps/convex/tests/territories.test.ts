import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { AFFORDABILITY_TIERS, launchTemplateTotalCents } from "@events-os/shared";
import { api, internal } from "../_generated/api";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { runSeedSeatDefs } from "../migrations/0022_seed_seat_defs";
import { runTerritoriesCutover } from "../migrations/0029_territories_cutover";
import type { Id } from "../_generated/dataModel";

/**
 * Territories (docs/plans/giving-territories.md) — replaces the retired
 * `cityCampaigns.test.ts` coverage:
 *  - `saveTerritory` validation + the central `giving.manage` gate, shadow-
 *    chapter creation, and dual slug uniqueness (territories AND chapters),
 *  - a prospect pledge scoping DIRECTLY to the shadow chapter (donor + the
 *    `invoice.paid` cycle gift too), and the shadow chapter's derived
 *    `backerCount` recompute,
 *  - the `preparePledge` guard (an inactive chapter with no visible, still-
 *    raising territory is NOT_FOUND),
 *  - `setTerritoryStage` launch flips `chapters.isActive` + is terminal,
 *  - migration 0029: seeds the launched New York territory (its only surviving
 *    responsibility post Territories Deploy B — see that migration's module
 *    doc for why its `cityCampaigns` re-scoping logic was retired, not just
 *    left untested),
 *  - public queries are PII-free and read the backer count from the chapter.
 */

/** Link a `people` row to the caller's user + seat them (requires seeded
 *  seatDefs) — copied from `givingPledges.test.ts` per that file's convention. */
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
 *  `giving.manage`/`giving.view` over central). */
async function devDirectorSetup(): Promise<ChapterSetup> {
  const t = newT();
  await run(t, (ctx) => runSeedSeatDefs(ctx));
  const s = await setupChapter(t);
  await seatCaller(s, "development_director", "central");
  return s;
}

async function territoryRow(s: ChapterSetup, id: Id<"territories">) {
  return run(s.t, (ctx) => ctx.db.get(id));
}

async function chapterRow(s: ChapterSetup, id: Id<"chapters">) {
  return run(s.t, (ctx) => ctx.db.get(id));
}

/** A published event page (fundraiser or not) on `chapterId` — mirrors the
 *  minimal-row pattern from `historicalBackfill.test.ts`'s `createEvent`. */
async function seedEventPage(
  s: ChapterSetup,
  chapterId: Id<"chapters">,
  opts: {
    name?: string;
    slug: string;
    eventDate: number;
    published?: boolean;
    goalCents?: number;
    revenueCents?: number;
    donationsCents?: number;
    externalGiftsCents?: number;
  },
): Promise<Id<"eventPages">> {
  return run(s.t, async (ctx) => {
    const now = Date.now();
    const eventTypeId = await ctx.db.insert("eventTypes", {
      chapterId,
      name: "Type",
      slug: `type-${opts.slug}`,
      version: 1,
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
    });
    const eventId = await ctx.db.insert("events", {
      chapterId,
      eventTypeId,
      templateVersion: 1,
      name: opts.name ?? "Worship Night",
      eventDate: opts.eventDate,
      status: "planning",
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
    });
    return await ctx.db.insert("eventPages", {
      eventId,
      chapterId,
      slug: opts.slug,
      published: opts.published ?? true,
      goingCount: 0,
      maybeCount: 0,
      notGoingCount: 0,
      ticketsSoldCount: 0,
      revenueCents: opts.revenueCents ?? 0,
      donationsCents: opts.donationsCents,
      externalGiftsCents: opts.externalGiftsCents,
      goalCents: opts.goalCents,
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
    });
  });
}

// ── saveTerritory ────────────────────────────────────────────────────────────

describe("saveTerritory", () => {
  test("creates a shadow chapter + territory in one mutation", async () => {
    const s = await devDirectorSetup();
    const id = await s.as.mutation(api.territories.saveTerritory, {
      name: "Queens",
      region: "NY",
      lat: 40.7282,
      lng: -73.7949,
      slug: "queens-ny",
      publiclyVisible: false,
    });
    const territory = await territoryRow(s, id);
    expect(territory?.stage).toBe("prospect");
    expect(territory?.launchFundCents).toBe(0);
    expect(territory?.launchFundTargetCents).toBe(launchTemplateTotalCents());
    // The shadow chapter exists, is inactive, and shares the slug.
    const chapter = await chapterRow(s, territory!.chapterId);
    expect(chapter?.isActive).toBe(false);
    expect(chapter?.slug).toBe("queens-ny");
    expect(chapter?.backerCount).toBe(0);
    // Default target = the ladder's lowest fallback rung.
    const lowest = [...AFFORDABILITY_TIERS].sort(
      (a, b) => a.minBackers - b.minBackers,
    )[0];
    expect(territory?.targetBackers).toBe(lowest.minBackers);
  });

  test("dual slug uniqueness: rejects a slug taken by another territory OR a chapter", async () => {
    const s = await devDirectorSetup();
    await s.as.mutation(api.territories.saveTerritory, {
      name: "Queens",
      region: "NY",
      lat: 40.7282,
      lng: -73.7949,
      slug: "queens-ny",
      publiclyVisible: false,
    });
    // Same slug as the first territory (and its shadow chapter).
    await expect(
      s.as.mutation(api.territories.saveTerritory, {
        name: "Queens Two",
        region: "NY",
        lat: 40.73,
        lng: -73.79,
        slug: "queens-ny",
        publiclyVisible: false,
      }),
    ).rejects.toBeInstanceOf(ConvexError);

    // A slug taken by a pre-existing REAL chapter is rejected too.
    await run(s.t, (ctx) =>
      ctx.db.insert("chapters", {
        name: "Brooklyn",
        slug: "brooklyn-ny",
        isActive: true,
        createdAt: Date.now(),
      }),
    );
    await expect(
      s.as.mutation(api.territories.saveTerritory, {
        name: "Brooklyn",
        region: "NY",
        lat: 40.6782,
        lng: -73.9442,
        slug: "brooklyn-ny",
        publiclyVisible: false,
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("rejects an invalid slug and out-of-range lat/lng", async () => {
    const s = await devDirectorSetup();
    await expect(
      s.as.mutation(api.territories.saveTerritory, {
        name: "Nope",
        region: "XX",
        lat: 40,
        lng: -73,
        slug: "Queens NY!",
        publiclyVisible: false,
      }),
    ).rejects.toBeInstanceOf(ConvexError);
    await expect(
      s.as.mutation(api.territories.saveTerritory, {
        name: "Nope",
        region: "XX",
        lat: 95,
        lng: -73,
        slug: "nope",
        publiclyVisible: false,
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("edit patches territory fields + the chapter name on rename", async () => {
    const s = await devDirectorSetup();
    const id = await s.as.mutation(api.territories.saveTerritory, {
      name: "Queens",
      region: "NY",
      lat: 40.7282,
      lng: -73.7949,
      slug: "queens-ny",
      publiclyVisible: false,
    });
    const before = await territoryRow(s, id);
    await s.as.mutation(api.territories.saveTerritory, {
      territoryId: id,
      name: "Queens Renamed",
      region: "NY",
      lat: 40.7282,
      lng: -73.7949,
      slug: "queens-ny",
      publiclyVisible: true,
    });
    const after = await territoryRow(s, id);
    expect(after?.name).toBe("Queens Renamed");
    expect(after?.publiclyVisible).toBe(true);
    const chapter = await chapterRow(s, before!.chapterId);
    expect(chapter?.name).toBe("Queens Renamed");
  });

  test("gating: a chapter admin is rejected; a central dev director passes", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));
    const s = await setupChapter(t);
    await expect(
      s.as.mutation(api.territories.saveTerritory, {
        name: "Queens",
        region: "NY",
        lat: 40.7282,
        lng: -73.7949,
        slug: "queens-ny",
        publiclyVisible: false,
      }),
    ).rejects.toBeInstanceOf(ConvexError);
    await expect(
      s.as.query(api.territories.listTerritoriesAdmin, {}),
    ).rejects.toBeInstanceOf(ConvexError);

    // A chapter-scope giving seat still isn't enough — the map is central-only.
    await seatCaller(s, "chapter_director", s.chapterId);
    await expect(
      s.as.mutation(api.territories.saveTerritory, {
        name: "Queens",
        region: "NY",
        lat: 40.7282,
        lng: -73.7949,
        slug: "queens-ny",
        publiclyVisible: false,
      }),
    ).rejects.toBeInstanceOf(ConvexError);

    await seatCaller(s, "development_director", "central");
    await expect(
      s.as.mutation(api.territories.saveTerritory, {
        name: "Queens",
        region: "NY",
        lat: 40.7282,
        lng: -73.7949,
        slug: "queens-ny",
        publiclyVisible: false,
      }),
    ).resolves.toBeDefined();
  });
});

// ── setTerritoryStage ──────────────────────────────────────────────────────

describe("setTerritoryStage", () => {
  test("launching flips the shadow chapter live, stamps launchedAt, and is terminal", async () => {
    const s = await devDirectorSetup();
    const id = await s.as.mutation(api.territories.saveTerritory, {
      name: "Queens",
      region: "NY",
      lat: 40.7282,
      lng: -73.7949,
      slug: "queens-ny",
      publiclyVisible: true,
    });
    const territory = await territoryRow(s, id);
    expect((await chapterRow(s, territory!.chapterId))?.isActive).toBe(false);

    await s.as.mutation(api.territories.setTerritoryStage, {
      territoryId: id,
      stage: "launched",
    });
    const launched = await territoryRow(s, id);
    expect(launched?.stage).toBe("launched");
    expect(typeof launched?.launchedAt).toBe("number");
    expect((await chapterRow(s, territory!.chapterId))?.isActive).toBe(true);

    // Terminal — no going back.
    await expect(
      s.as.mutation(api.territories.setTerritoryStage, {
        territoryId: id,
        stage: "prospect",
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("prospect ⇄ raising are free moves", async () => {
    const s = await devDirectorSetup();
    const id = await s.as.mutation(api.territories.saveTerritory, {
      name: "Queens",
      region: "NY",
      lat: 40.7282,
      lng: -73.7949,
      slug: "queens-ny",
      publiclyVisible: true,
    });
    await s.as.mutation(api.territories.setTerritoryStage, {
      territoryId: id,
      stage: "raising",
    });
    expect((await territoryRow(s, id))?.stage).toBe("raising");
    expect((await chapterRow(s, (await territoryRow(s, id))!.chapterId))?.isActive).toBe(
      false,
    );
  });
});

// ── preparePledge → shadow chapter scoping + the guard ───────────────────────

describe("preparePledge (territory-backed)", () => {
  test("a prospect pledge scopes the pledge, donor, and cycle gift to the shadow chapter", async () => {
    const s = await devDirectorSetup();
    const territoryId = await s.as.mutation(api.territories.saveTerritory, {
      name: "Queens",
      region: "NY",
      lat: 40.7282,
      lng: -73.7949,
      slug: "queens-ny",
      publiclyVisible: true,
    });
    const territory = await territoryRow(s, territoryId);
    const chapterId = territory!.chapterId;

    const prepared = await s.t.mutation(internal.givingPledges.preparePledge, {
      chapterId,
      amountCents: 5000,
      name: "Queens Backer",
      email: "backer@example.com",
    });
    const pledge = await run(s.t, (ctx) =>
      ctx.db.get(prepared.pledgeId as Id<"pledges">),
    );
    expect(pledge?.scope).toBe(chapterId);
    const donor = await run(s.t, (ctx) => ctx.db.get(pledge!.donorId));
    expect(donor?.scope).toBe(chapterId);
    expect(donor?.source).toBe("map");
    expect(prepared.territorySlug).toBe("queens-ny");

    // Activate + a paid cycle → one gift, scoped to the shadow chapter.
    await s.t.mutation(internal.givingPledges.activatePledgeFromCheckout, {
      pledgeId: String(prepared.pledgeId),
      stripeSubscriptionId: "sub_q1",
    });
    await s.t.mutation(internal.givingPledges.recordPledgeInvoice, {
      subscriptionId: "sub_q1",
      invoiceId: "inv_q1",
      amountPaidCents: 5000,
    });
    const gift = await run(s.t, (ctx) =>
      ctx.db
        .query("gifts")
        .withIndex("by_pledge", (q) => q.eq("pledgeId", pledge!._id))
        .first(),
    );
    expect(gift?.scope).toBe(chapterId);
    // The shadow chapter's derived backerCount recomputed to 1.
    expect((await chapterRow(s, chapterId))?.backerCount).toBe(1);
  });

  test("$50 counts, $20 doesn't; cancel decrements the shadow chapter's backerCount", async () => {
    const s = await devDirectorSetup();
    const territoryId = await s.as.mutation(api.territories.saveTerritory, {
      name: "Queens",
      region: "NY",
      lat: 40.7282,
      lng: -73.7949,
      slug: "queens-ny",
      publiclyVisible: true,
    });
    const chapterId = (await territoryRow(s, territoryId))!.chapterId;

    async function prepareAndActivate(
      amountCents: number,
      sub: string,
      email: string,
    ) {
      const prepared = await s.t.mutation(internal.givingPledges.preparePledge, {
        chapterId,
        amountCents,
        name: "B " + sub,
        email,
      });
      await s.t.mutation(internal.givingPledges.activatePledgeFromCheckout, {
        pledgeId: String(prepared.pledgeId),
        stripeSubscriptionId: sub,
      });
    }

    await prepareAndActivate(5000, "sub_a", "a@example.com");
    expect((await chapterRow(s, chapterId))?.backerCount).toBe(1);
    await prepareAndActivate(2000, "sub_b", "b@example.com"); // below unit
    expect((await chapterRow(s, chapterId))?.backerCount).toBe(1);
    await prepareAndActivate(5000, "sub_c", "c@example.com");
    expect((await chapterRow(s, chapterId))?.backerCount).toBe(2);

    await s.t.mutation(internal.givingPledges.cancelPledgeSubscription, {
      subscriptionId: "sub_c",
    });
    expect((await chapterRow(s, chapterId))?.backerCount).toBe(1);
  });

  test("guard: an inactive chapter with no visible/raising territory is rejected", async () => {
    const s = await devDirectorSetup();
    // A bare inactive chapter, no territory.
    const bare = await run(s.t, (ctx) =>
      ctx.db.insert("chapters", {
        name: "Ghost",
        slug: "ghost",
        isActive: false,
        backerCount: 0,
        createdAt: Date.now(),
      }),
    );
    await expect(
      s.t.mutation(internal.givingPledges.preparePledge, {
        chapterId: bare,
        amountCents: 5000,
        name: "X",
        email: "x@example.com",
      }),
    ).rejects.toThrow();

    // A HIDDEN territory's shadow chapter is not backable either.
    const hiddenId = await s.as.mutation(api.territories.saveTerritory, {
      name: "Hidden",
      region: "NY",
      lat: 40.7,
      lng: -73.8,
      slug: "hidden-ny",
      publiclyVisible: false,
    });
    const hiddenChapter = (await territoryRow(s, hiddenId))!.chapterId;
    await expect(
      s.t.mutation(internal.givingPledges.preparePledge, {
        chapterId: hiddenChapter,
        amountCents: 5000,
        name: "X",
        email: "x@example.com",
      }),
    ).rejects.toThrow();
  });

  test("a live (active) chapter backer is a direct signup (source manual)", async () => {
    const s = await devDirectorSetup();
    const prepared = await s.t.mutation(internal.givingPledges.preparePledge, {
      chapterId: s.chapterId, // setupChapter's chapter is active
      amountCents: 5000,
      name: "Direct Backer",
      email: "direct@example.com",
    });
    const pledge = await run(s.t, (ctx) =>
      ctx.db.get(prepared.pledgeId as Id<"pledges">),
    );
    expect(pledge?.scope).toBe(s.chapterId);
    const donor = await run(s.t, (ctx) => ctx.db.get(pledge!.donorId));
    expect(donor?.source).toBe("manual");
  });
});

// ── resolveTerritoryForCheckout ──────────────────────────────────────────────

describe("resolveTerritoryForCheckout", () => {
  test("resolves a visible territory to its chapter; null for hidden/unknown", async () => {
    const s = await devDirectorSetup();
    const id = await s.as.mutation(api.territories.saveTerritory, {
      name: "Queens",
      region: "NY",
      lat: 40.7282,
      lng: -73.7949,
      slug: "queens-ny",
      publiclyVisible: true,
    });
    const chapterId = (await territoryRow(s, id))!.chapterId;
    const resolved = await run(s.t, (ctx) =>
      ctx.runQuery(internal.territories.resolveTerritoryForCheckout, {
        slug: "queens-ny",
      }),
    );
    expect(resolved).toEqual({ chapterId });

    await s.as.mutation(api.territories.saveTerritory, {
      name: "Hidden",
      region: "NY",
      lat: 40.7,
      lng: -73.8,
      slug: "hidden-ny",
      publiclyVisible: false,
    });
    expect(
      await run(s.t, (ctx) =>
        ctx.runQuery(internal.territories.resolveTerritoryForCheckout, {
          slug: "hidden-ny",
        }),
      ),
    ).toBeNull();
    expect(
      await run(s.t, (ctx) =>
        ctx.runQuery(internal.territories.resolveTerritoryForCheckout, {
          slug: "does-not-exist",
        }),
      ),
    ).toBeNull();
  });
});

// ── Public reads ─────────────────────────────────────────────────────────────

describe("public territory reads", () => {
  test("getPublicMapData: only visible territories, only aggregates, count from chapter", async () => {
    const s = await devDirectorSetup();
    const visibleId = await s.as.mutation(api.territories.saveTerritory, {
      name: "Queens",
      region: "NY",
      lat: 40.7282,
      lng: -73.7949,
      slug: "queens-ny",
      publiclyVisible: true,
    });
    await s.as.mutation(api.territories.saveTerritory, {
      name: "Hidden",
      region: "NY",
      lat: 40.7,
      lng: -73.8,
      slug: "hidden-ny",
      publiclyVisible: false,
    });
    // The backer count comes from the linked chapter, not the territory.
    const chapterId = (await territoryRow(s, visibleId))!.chapterId;
    await run(s.t, (ctx) => ctx.db.patch(chapterId, { backerCount: 9 }));

    const rows = await s.t.query(api.territories.getPublicMapData, {});
    expect(rows).toHaveLength(1);
    expect(rows[0].slug).toBe("queens-ny");
    expect(rows[0].backerCount).toBe(9);
    expect(Object.keys(rows[0]).sort()).toEqual(
      [
        "backerCount",
        "lat",
        "lng",
        "name",
        "region",
        "slug",
        "stage",
        "targetBackers",
      ].sort(),
    );
  });

  test("getPublicTerritory: null for hidden/unknown; milestone ladder + next milestone", async () => {
    const s = await devDirectorSetup();
    // Configure a ladder so we don't depend on the fallback constants.
    await run(s.t, async (ctx) => {
      const now = Date.now();
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
        sortOrder: 1,
        updatedAt: now,
      });
    });
    const id = await s.as.mutation(api.territories.saveTerritory, {
      name: "Queens",
      region: "NY",
      lat: 40.7282,
      lng: -73.7949,
      slug: "queens-ny",
      publiclyVisible: true,
      targetBackers: 20,
    });
    const chapterId = (await territoryRow(s, id))!.chapterId;
    await run(s.t, (ctx) => ctx.db.patch(chapterId, { backerCount: 6 }));

    const data = await s.t.query(api.territories.getPublicTerritory, {
      slug: "queens-ny",
    });
    expect(data).not.toBeNull();
    expect(data!.backerCount).toBe(6);
    expect(data!.milestones.map((m) => m.minBackers)).toEqual([5, 10]);
    expect(data!.nextMilestone?.minBackers).toBe(10);

    await s.as.mutation(api.territories.saveTerritory, {
      name: "Hidden",
      region: "NY",
      lat: 40.7,
      lng: -73.8,
      slug: "hidden-ny",
      publiclyVisible: false,
    });
    expect(
      await s.t.query(api.territories.getPublicTerritory, { slug: "hidden-ny" }),
    ).toBeNull();
  });

  test("getPublicTerritory: upcomingFundraisers surfaces a published future goal event, soonest first", async () => {
    const s = await devDirectorSetup();
    const id = await s.as.mutation(api.territories.saveTerritory, {
      name: "Queens",
      region: "NY",
      lat: 40.7282,
      lng: -73.7949,
      slug: "queens-ny",
      publiclyVisible: true,
    });
    const chapterId = (await territoryRow(s, id))!.chapterId;
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;

    // A published, future fundraiser with a goal — should appear.
    await seedEventPage(s, chapterId, {
      name: "Eden Fundraiser",
      slug: "eden-fundraiser",
      eventDate: now + 10 * day,
      published: true,
      goalCents: 100000,
      revenueCents: 5000,
      donationsCents: 3000,
      externalGiftsCents: 2000,
    });
    // A sooner published fundraiser with a goal — should sort first.
    await seedEventPage(s, chapterId, {
      name: "Love Thy Neighbor Fundraiser",
      slug: "ltn-fundraiser",
      eventDate: now + 3 * day,
      published: true,
      goalCents: 50000,
      revenueCents: 1000,
    });

    const data = await s.t.query(api.territories.getPublicTerritory, {
      slug: "queens-ny",
    });
    expect(data!.upcomingFundraisers).toHaveLength(2);
    expect(data!.upcomingFundraisers.map((f) => f.slug)).toEqual([
      "ltn-fundraiser",
      "eden-fundraiser",
    ]);
    const eden = data!.upcomingFundraisers.find(
      (f) => f.slug === "eden-fundraiser",
    )!;
    expect(eden.goalCents).toBe(100000);
    // raisedCents mirrors the RSVP page's progress bar exactly: revenue +
    // on-page giving + externally-attached gifts.
    expect(eden.raisedCents).toBe(5000 + 3000 + 2000);
    expect(eden.name).toBe("Eden Fundraiser");
    expect(typeof eden.startDate).toBe("number");
  });

  test("getPublicTerritory: upcomingFundraisers is empty for an unpublished, past, or goal-less event", async () => {
    const s = await devDirectorSetup();
    const id = await s.as.mutation(api.territories.saveTerritory, {
      name: "Queens",
      region: "NY",
      lat: 40.7282,
      lng: -73.7949,
      slug: "queens-ny",
      publiclyVisible: true,
    });
    const chapterId = (await territoryRow(s, id))!.chapterId;
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;

    // Launched with no goal set — never counts as a fundraiser.
    await seedEventPage(s, chapterId, {
      slug: "no-goal-event",
      eventDate: now + 5 * day,
      published: true,
    });
    // Unpublished draft with a goal.
    await seedEventPage(s, chapterId, {
      slug: "unpublished-goal-event",
      eventDate: now + 5 * day,
      published: false,
      goalCents: 20000,
    });
    // Past event with a goal.
    await seedEventPage(s, chapterId, {
      slug: "past-goal-event",
      eventDate: now - 5 * day,
      published: true,
      goalCents: 20000,
    });

    const data = await s.t.query(api.territories.getPublicTerritory, {
      slug: "queens-ny",
    });
    expect(data!.upcomingFundraisers).toEqual([]);
  });

  test("getPublicTerritory: sponsorshipCount counts only committed/active sponsorships scoped to this chapter", async () => {
    const s = await devDirectorSetup();
    const id = await s.as.mutation(api.territories.saveTerritory, {
      name: "Queens",
      region: "NY",
      lat: 40.7282,
      lng: -73.7949,
      slug: "queens-ny",
      publiclyVisible: true,
    });
    const chapterId = (await territoryRow(s, id))!.chapterId;

    expect(
      (await s.t.query(api.territories.getPublicTerritory, {
        slug: "queens-ny",
      }))!.sponsorshipCount,
    ).toBe(0);

    await run(s.t, async (ctx) => {
      const now = Date.now();
      const pkgId = await ctx.db.insert("sponsorPackages", {
        name: "LTN Gold",
        tierRank: 1,
        audience: "church",
        pricing: { kind: "annual", amountCents: 500000 },
        scope: { kind: "annual" },
        benefits: ["Logo on flyers"],
        commitments: ["Stage mention"],
        active: true,
        createdAt: now,
        updatedAt: now,
        updatedBy: s.userId,
      });
      // A donor scoped to THIS chapter, committed — counts.
      const chapterDonorId = await ctx.db.insert("donors", {
        scope: chapterId,
        kind: "church",
        name: "Queens Church",
        status: "active",
        lifetimeCents: 0,
        giftCount: 0,
        createdAt: now,
      });
      await ctx.db.insert("sponsorships", {
        donorId: chapterDonorId,
        packageId: pkgId,
        status: "committed",
        createdAt: now,
        updatedAt: now,
      });
      // A donor scoped to THIS chapter, but only prospect — doesn't count.
      const prospectDonorId = await ctx.db.insert("donors", {
        scope: chapterId,
        kind: "business",
        name: "Queens Biz",
        status: "active",
        lifetimeCents: 0,
        giftCount: 0,
        createdAt: now,
      });
      await ctx.db.insert("sponsorships", {
        donorId: prospectDonorId,
        packageId: pkgId,
        status: "prospect",
        createdAt: now,
        updatedAt: now,
      });
      // A central-scoped donor, active — doesn't count for THIS chapter.
      const centralDonorId = await ctx.db.insert("donors", {
        scope: "central",
        kind: "foundation",
        name: "National Foundation",
        status: "active",
        lifetimeCents: 0,
        giftCount: 0,
        createdAt: now,
      });
      await ctx.db.insert("sponsorships", {
        donorId: centralDonorId,
        packageId: pkgId,
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
    });

    const data = await s.t.query(api.territories.getPublicTerritory, {
      slug: "queens-ny",
    });
    expect(data!.sponsorshipCount).toBe(1);
  });
});

// ── Migration 0029 ───────────────────────────────────────────────────────────
//
// The `cityCampaigns` re-scoping coverage this block used to carry (a
// campaign + its map donor/pledge/gift moving onto a shadow chapter with
// rollup deltas netting to zero; a non-map donor's pledge re-scoping while the
// donor itself stays central) tested migration 0029's parts (b)-(d). Those
// parts were removed in Territories Deploy B once `cityCampaigns` +
// `pledges.cityCampaignId` left the schema for good (0029 already ran to
// completion in prod before that deploy) — see the module doc atop
// `migrations/0029_territories_cutover.ts`. What's left below is part (a),
// New York seeding, which never depended on `cityCampaigns`.

describe("0029 territories cutover", () => {
  test("seeds a launched New York territory linked to the new-york chapter", async () => {
    const s = await devDirectorSetup();
    const nyChapterId = await run(s.t, (ctx) =>
      ctx.db.insert("chapters", {
        name: "The New York Chapter",
        slug: "new-york",
        isActive: true,
        backerCount: 12,
        createdAt: Date.now(),
      }),
    );
    const result = await run(s.t, (ctx) => runTerritoriesCutover(ctx));
    expect(result.nySeeded).toBe(true);
    const territory = await run(s.t, (ctx) =>
      ctx.db
        .query("territories")
        .withIndex("by_chapter", (q) => q.eq("chapterId", nyChapterId))
        .unique(),
    );
    expect(territory?.stage).toBe("launched");
    expect(territory?.slug).toBe("new-york");
    expect(territory?.publiclyVisible).toBe(true);
    // Public read shows the chapter's live count.
    const data = await s.t.query(api.territories.getPublicTerritory, {
      slug: "new-york",
    });
    expect(data!.backerCount).toBe(12);
  });
});
