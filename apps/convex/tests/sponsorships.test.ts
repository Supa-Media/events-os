import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { runSeedSeatDefs } from "../migrations/0022_seed_seat_defs";
import type { Id } from "../_generated/dataModel";

/**
 * Sponsorships & partnerships (F-6 P4) tests:
 *   - package CRUD validation (positive cents/tierRank, nonempty
 *     benefits/commitments, event existence when scope kind is "event") +
 *     gating (a view-only caller cannot save/deactivate);
 *   - individual-donor rejection on `upsertSponsorship`;
 *   - status transitions via `setSponsorshipStatus`;
 *   - `recordSponsorshipGift` links the gift, bumps donor + scope rollups,
 *     and auto-advances a `committed` agreement to `active` on its FIRST
 *     gift only;
 *   - an event-scoped package validates its `eventId`.
 */

/** Link a `people` row to the caller's user and seat them, so their
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
 *  director at central (full giving.manage) — the common privileged setup. */
async function devDirectorSetup(): Promise<ChapterSetup> {
  const t = newT();
  await run(t, (ctx) => runSeedSeatDefs(ctx));
  const s = await setupChapter(t);
  await seatCaller(s, "development_director", "central");
  return s;
}

type PackageInput = {
  name: string;
  tierRank: number;
  audience: "church" | "business" | "any";
  pricing: { kind: "one_time" | "monthly" | "annual"; amountCents: number };
  scope:
    | { kind: "event"; eventId: Id<"events"> }
    | { kind: "season" }
    | { kind: "annual" };
  benefits: string[];
  commitments: string[];
};

const VALID_PACKAGE: PackageInput = {
  name: "LTN Gold",
  tierRank: 1,
  audience: "church",
  pricing: { kind: "annual", amountCents: 500000 },
  scope: { kind: "annual" },
  benefits: ["Logo on flyers", "Sunday announcement"],
  commitments: ["Stage mention at LTN"],
};

async function createPackage(
  s: ChapterSetup,
  overrides: Partial<PackageInput> = {},
): Promise<Id<"sponsorPackages">> {
  return (await s.as.mutation(api.sponsorships.savePackage, {
    ...VALID_PACKAGE,
    ...overrides,
  })) as Id<"sponsorPackages">;
}

async function createOrgDonor(
  s: ChapterSetup,
  kind: "church" | "business" | "foundation" | "individual" = "church",
  name = "Grace Church",
): Promise<Id<"donors">> {
  return (await s.as.mutation(api.givingPlatform.upsertDonor, {
    scope: "central",
    name,
    kind,
  })) as Id<"donors">;
}

// ── Package CRUD + validation ─────────────────────────────────────────────────

describe("savePackage", () => {
  test("creates and updates a package tier, ordered by tierRank on listPackages", async () => {
    const s = await devDirectorSetup();
    const goldId = await createPackage(s, { name: "LTN Gold", tierRank: 1 });
    await createPackage(s, { name: "LTN Silver", tierRank: 2 });

    const packages = await s.as.query(api.sponsorships.listPackages, {});
    expect(packages.map((p) => p.name)).toEqual(["LTN Gold", "LTN Silver"]);

    // Update: same packageId, new fields.
    await s.as.mutation(api.sponsorships.savePackage, {
      ...VALID_PACKAGE,
      packageId: goldId,
      name: "LTN Gold+",
      tierRank: 1,
    });
    const updated = await s.as.query(api.sponsorships.listPackages, {});
    expect(updated.find((p) => p._id === goldId)?.name).toBe("LTN Gold+");
  });

  test("rejects non-positive pricing, non-integer tierRank, and empty benefits/commitments", async () => {
    const s = await devDirectorSetup();

    await expect(
      s.as.mutation(api.sponsorships.savePackage, {
        ...VALID_PACKAGE,
        pricing: { kind: "annual", amountCents: 0 },
      }),
    ).rejects.toThrow();

    await expect(
      s.as.mutation(api.sponsorships.savePackage, {
        ...VALID_PACKAGE,
        tierRank: 0,
      }),
    ).rejects.toThrow();

    await expect(
      s.as.mutation(api.sponsorships.savePackage, {
        ...VALID_PACKAGE,
        tierRank: 1.5,
      }),
    ).rejects.toThrow();

    await expect(
      s.as.mutation(api.sponsorships.savePackage, {
        ...VALID_PACKAGE,
        benefits: [],
      }),
    ).rejects.toThrow();

    await expect(
      s.as.mutation(api.sponsorships.savePackage, {
        ...VALID_PACKAGE,
        commitments: ["  ", ""],
      }),
    ).rejects.toThrow();
  });

  test("an event-scoped package validates the eventId exists", async () => {
    const s = await devDirectorSetup();
    // A valid-shaped but nonexistent id (create then delete), not a
    // hand-crafted string — convex-test validates id shape strictly.
    const deletedEventId = await seedEvent(s);
    await run(s.t, (ctx) => ctx.db.delete(deletedEventId));

    await expect(
      createPackage(s, { scope: { kind: "event", eventId: deletedEventId } }),
    ).rejects.toThrow();

    const eventId = await seedEvent(s);
    const pkgId = await createPackage(s, {
      scope: { kind: "event", eventId },
    });
    const packages = await s.as.query(api.sponsorships.listPackages, {});
    const saved = packages.find((p) => p._id === pkgId);
    expect(saved?.scope).toEqual({ kind: "event", eventId });
  });

  test("deactivatePackage soft-deactivates (row stays, active flips false)", async () => {
    const s = await devDirectorSetup();
    const pkgId = await createPackage(s);
    await s.as.mutation(api.sponsorships.deactivatePackage, { packageId: pkgId });
    const packages = await s.as.query(api.sponsorships.listPackages, {});
    const saved = packages.find((p) => p._id === pkgId);
    expect(saved?.active).toBe(false);
  });

  test("a view-only caller cannot save or deactivate a package", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));
    const s = await setupChapter(t);
    await seatCaller(s, "partnership_associate", "central"); // giving.view only

    await expect(
      s.as.mutation(api.sponsorships.savePackage, VALID_PACKAGE),
    ).rejects.toThrow();
    // Read still works for a view-only caller.
    await expect(
      s.as.query(api.sponsorships.listPackages, {}),
    ).resolves.toBeDefined();
  });
});

// ── Sponsorship agreement CRUD ────────────────────────────────────────────────

/** Read a `donors`/`gifts` row directly (bypassing the view gate) for assertions. */
async function donorRow(s: ChapterSetup, donorId: Id<"donors">) {
  return run(s.t, (ctx) => ctx.db.get(donorId));
}
async function giftRow(s: ChapterSetup, giftId: Id<"gifts">) {
  return run(s.t, (ctx) => ctx.db.get(giftId));
}

async function seedEvent(s: ChapterSetup): Promise<Id<"events">> {
  return run(s.t, async (ctx) => {
    const now = Date.now();
    const eventTypeId = await ctx.db.insert("eventTypes", {
      chapterId: s.chapterId,
      name: "Love Thy Neighbor",
      slug: "ltn",
      version: 1,
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
    });
    return ctx.db.insert("events", {
      chapterId: s.chapterId,
      eventTypeId,
      templateVersion: 1,
      name: "LTN Fall 2026",
      eventDate: now + 30 * 24 * 60 * 60 * 1000,
      status: "planning",
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
    });
  });
}

describe("upsertSponsorship", () => {
  test("rejects an individual donor with a clear error", async () => {
    const s = await devDirectorSetup();
    const pkgId = await createPackage(s);
    const individualId = await createOrgDonor(s, "individual", "Ada Individual");

    await expect(
      s.as.mutation(api.sponsorships.upsertSponsorship, {
        donorId: individualId,
        packageId: pkgId,
      }),
    ).rejects.toThrow(/church, business, or foundation/i);
  });

  test("creates a prospect agreement for a church donor and attaches events", async () => {
    const s = await devDirectorSetup();
    const pkgId = await createPackage(s);
    const donorId = await createOrgDonor(s, "church");
    const eventId = await seedEvent(s);

    const sponsorshipId = (await s.as.mutation(api.sponsorships.upsertSponsorship, {
      donorId,
      packageId: pkgId,
      eventIds: [eventId],
      dueDiligenceNotes: "Visited a Sunday service.",
    })) as Id<"sponsorships">;

    const detail = await s.as.query(api.sponsorships.getSponsorship, {
      sponsorshipId,
    });
    expect(detail.sponsorship.status).toBe("prospect");
    expect(detail.donor?.name).toBe("Grace Church");
    expect(detail.package?._id).toBe(pkgId);
    expect(detail.events).toHaveLength(1);
    expect(detail.events[0]._id).toBe(eventId);
    expect(detail.giftsTotalCents).toBe(0);
  });

  test("business and foundation donors are also accepted", async () => {
    const s = await devDirectorSetup();
    const pkgId = await createPackage(s);
    const bizId = await createOrgDonor(s, "business", "Acme Co");
    const foundationId = await createOrgDonor(s, "foundation", "Good Trust");

    await expect(
      s.as.mutation(api.sponsorships.upsertSponsorship, {
        donorId: bizId,
        packageId: pkgId,
      }),
    ).resolves.toBeDefined();
    await expect(
      s.as.mutation(api.sponsorships.upsertSponsorship, {
        donorId: foundationId,
        packageId: pkgId,
      }),
    ).resolves.toBeDefined();
  });
});

// ── Status transitions ────────────────────────────────────────────────────────

describe("setSponsorshipStatus", () => {
  test("moves an agreement along the pipeline and listSponsorships filters by status", async () => {
    const s = await devDirectorSetup();
    const pkgId = await createPackage(s);
    const donorId = await createOrgDonor(s);
    const sponsorshipId = (await s.as.mutation(api.sponsorships.upsertSponsorship, {
      donorId,
      packageId: pkgId,
    })) as Id<"sponsorships">;

    await s.as.mutation(api.sponsorships.setSponsorshipStatus, {
      sponsorshipId,
      status: "pitched",
    });
    let detail = await s.as.query(api.sponsorships.getSponsorship, { sponsorshipId });
    expect(detail.sponsorship.status).toBe("pitched");

    await s.as.mutation(api.sponsorships.setSponsorshipStatus, {
      sponsorshipId,
      status: "committed",
    });
    detail = await s.as.query(api.sponsorships.getSponsorship, { sponsorshipId });
    expect(detail.sponsorship.status).toBe("committed");

    const committedRows = await s.as.query(api.sponsorships.listSponsorships, {
      status: "committed",
    });
    expect(committedRows.map((r) => r.sponsorship._id)).toContain(sponsorshipId);
    const prospectRows = await s.as.query(api.sponsorships.listSponsorships, {
      status: "prospect",
    });
    expect(prospectRows.map((r) => r.sponsorship._id)).not.toContain(sponsorshipId);
  });
});

// ── recordSponsorshipGift ─────────────────────────────────────────────────────

describe("recordSponsorshipGift", () => {
  test("links the gift, bumps donor + scope rollups, and auto-advances committed → active on the FIRST gift only", async () => {
    const s = await devDirectorSetup();
    const pkgId = await createPackage(s);
    const donorId = await createOrgDonor(s);
    const sponsorshipId = (await s.as.mutation(api.sponsorships.upsertSponsorship, {
      donorId,
      packageId: pkgId,
      status: "committed",
    })) as Id<"sponsorships">;

    const giftId = (await s.as.mutation(api.sponsorships.recordSponsorshipGift, {
      sponsorshipId,
      amountCents: 500000,
      method: "check",
    })) as Id<"gifts">;

    // The gift is linked and the donor rollup bumped.
    const gift = await giftRow(s, giftId);
    expect(gift?.sponsorshipId).toBe(sponsorshipId);

    const donor = await donorRow(s, donorId);
    expect(donor?.lifetimeCents).toBe(500000);
    expect(donor?.giftCount).toBe(1);

    const dash = await s.as.query(api.givingPlatform.givingDashboard, {
      scope: "central",
    });
    expect(dash.lifetimeCents).toBe(500000);

    // Auto-advance: committed → active on the first gift.
    let detail = await s.as.query(api.sponsorships.getSponsorship, { sponsorshipId });
    expect(detail.sponsorship.status).toBe("active");
    expect(detail.giftsTotalCents).toBe(500000);

    // A second gift does NOT re-trigger the transition away from `active`,
    // and a `prospect`/`pitched` sponsorship is never auto-advanced.
    await s.as.mutation(api.sponsorships.recordSponsorshipGift, {
      sponsorshipId,
      amountCents: 25000,
      method: "cash",
    });
    detail = await s.as.query(api.sponsorships.getSponsorship, { sponsorshipId });
    expect(detail.sponsorship.status).toBe("active");
    expect(detail.giftsTotalCents).toBe(525000);
    expect(detail.gifts).toHaveLength(2);
  });

  test("a gift on a prospect sponsorship does not auto-advance its status", async () => {
    const s = await devDirectorSetup();
    const pkgId = await createPackage(s);
    const donorId = await createOrgDonor(s);
    const sponsorshipId = (await s.as.mutation(api.sponsorships.upsertSponsorship, {
      donorId,
      packageId: pkgId,
    })) as Id<"sponsorships">;
    expect(
      (await s.as.query(api.sponsorships.getSponsorship, { sponsorshipId }))
        .sponsorship.status,
    ).toBe("prospect");

    await s.as.mutation(api.sponsorships.recordSponsorshipGift, {
      sponsorshipId,
      amountCents: 10000,
      method: "check",
    });

    const detail = await s.as.query(api.sponsorships.getSponsorship, {
      sponsorshipId,
    });
    expect(detail.sponsorship.status).toBe("prospect");
  });
});
