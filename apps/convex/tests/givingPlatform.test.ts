import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { runSeedSeatDefs } from "../migrations/0022_seed_seat_defs";
import type { Doc, Id } from "../_generated/dataModel";

/**
 * Giving Platform (F-6 P1) — donor CRM tests:
 *   - donor upsert + dedup by email,
 *   - recordGift rollup bump + status transitions (active / lapsed / prospect),
 *   - removeGift decrement + clamp,
 *   - event-donation dual-write (card fulfill creates donor+gift; removeDonation
 *     cleans up),
 *   - access gating (non-privileged caller rejected; seat holder passes).
 *
 * Territories P6's canonical import (dedup / re-run safety, row-type
 * classification) has its own suite: `tests/canonicalImport.test.ts`.
 */

const NINETY_ONE_DAYS_MS = 91 * 24 * 60 * 60 * 1000;

/** Link a `people` row to the caller's user and seat them, so their seat-derived
 *  giving capability resolves (`lib/givingAccess.ts`). Requires seeded seatDefs. */
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

/** Read a donor row directly (bypassing the view gate) for assertions. */
async function donorRow(s: ChapterSetup, donorId: Id<"donors">) {
  return run(s.t, (ctx) => ctx.db.get(donorId));
}

// ── Donor upsert + dedup ──────────────────────────────────────────────────────

describe("upsertDonor", () => {
  test("creates a donor, then dedups a second upsert by lowercased email", async () => {
    const s = await devDirectorSetup();

    const id1 = await s.as.mutation(api.givingPlatform.upsertDonor, {
      scope: "central",
      name: "Ada Donor",
      email: "Ada@Example.com",
      kind: "individual",
    });
    // Same email (different case) + updated name → same row, name patched.
    const id2 = await s.as.mutation(api.givingPlatform.upsertDonor, {
      scope: "central",
      name: "Ada L. Donor",
      email: "ada@example.com",
    });
    expect(id2).toBe(id1);

    const donor = await donorRow(s, id1 as Id<"donors">);
    expect(donor?.name).toBe("Ada L. Donor");
    expect(donor?.email).toBe("ada@example.com");
    expect(donor?.status).toBe("prospect");

    // Dashboard donor count reflects ONE donor, not two.
    const dash = await s.as.query(api.givingPlatform.givingDashboard, {
      scope: "central",
    });
    expect(dash.donorCount).toBe(1);
    expect(dash.prospectCount).toBe(1);
  });
});

// ── recordGift rollups + status ───────────────────────────────────────────────

describe("recordGift", () => {
  test("bumps donor + scope rollups and derives active status", async () => {
    const s = await devDirectorSetup();
    const donorId = (await s.as.mutation(api.givingPlatform.upsertDonor, {
      scope: "central",
      name: "Ben Backer",
      email: "ben@example.com",
    })) as Id<"donors">;

    await s.as.mutation(api.givingPlatform.recordGift, {
      donorId,
      amountCents: 5000,
      method: "check",
    });
    await s.as.mutation(api.givingPlatform.recordGift, {
      donorId,
      amountCents: 2500,
      method: "cash",
    });

    const donor = await donorRow(s, donorId);
    expect(donor?.lifetimeCents).toBe(7500);
    expect(donor?.giftCount).toBe(2);
    expect(donor?.status).toBe("active");

    const dash = await s.as.query(api.givingPlatform.givingDashboard, {
      scope: "central",
    });
    expect(dash.lifetimeCents).toBe(7500);
    expect(dash.last30Cents).toBe(7500);
    expect(dash.activeCount).toBe(1);
    expect(dash.prospectCount).toBe(0);
  });

  test("an old gift derives lapsed; validation rejects non-positive cents", async () => {
    const s = await devDirectorSetup();
    const donorId = (await s.as.mutation(api.givingPlatform.upsertDonor, {
      scope: "central",
      name: "Cara Lapsed",
      email: "cara@example.com",
    })) as Id<"donors">;

    await s.as.mutation(api.givingPlatform.recordGift, {
      donorId,
      amountCents: 1000,
      method: "check",
      receivedAt: Date.now() - NINETY_ONE_DAYS_MS,
    });
    const donor = await donorRow(s, donorId);
    expect(donor?.status).toBe("lapsed");

    const dash = await s.as.query(api.givingPlatform.givingDashboard, {
      scope: "central",
    });
    expect(dash.lapsedCount).toBe(1);
    expect(dash.last30Cents).toBe(0); // the old gift is outside the window

    await expect(
      s.as.mutation(api.givingPlatform.recordGift, {
        donorId,
        amountCents: 0,
        method: "check",
      }),
    ).rejects.toThrow();
    await expect(
      s.as.mutation(api.givingPlatform.recordGift, {
        donorId,
        amountCents: 12.5,
        method: "check",
      }),
    ).rejects.toThrow();
  });
});

// ── removeGift decrement + clamp ──────────────────────────────────────────────

describe("removeGift", () => {
  test("reverses rollups and re-derives prospect when the last gift is removed", async () => {
    const s = await devDirectorSetup();
    const donorId = (await s.as.mutation(api.givingPlatform.upsertDonor, {
      scope: "central",
      name: "Removed Gift Donor",
      email: "rg@example.com",
    })) as Id<"donors">;

    const giftId = (await s.as.mutation(api.givingPlatform.recordGift, {
      donorId,
      amountCents: 4000,
      method: "check",
    })) as Id<"gifts">;

    await s.as.mutation(api.givingPlatform.removeGift, { giftId });

    const donor = await donorRow(s, donorId);
    expect(donor?.lifetimeCents).toBe(0);
    expect(donor?.giftCount).toBe(0);
    expect(donor?.lastGiftAt).toBeUndefined();
    expect(donor?.status).toBe("prospect");

    const dash = await s.as.query(api.givingPlatform.givingDashboard, {
      scope: "central",
    });
    expect(dash.lifetimeCents).toBe(0);
    expect(dash.giftCount).toBe(0);
    expect(dash.prospectCount).toBe(1);
    expect(dash.activeCount).toBe(0);
  });
});

// ── Event-donation dual-write ─────────────────────────────────────────────────

async function seedEvent(s: ChapterSetup): Promise<Id<"events">> {
  return run(s.t, async (ctx) => {
    const now = Date.now();
    const eventTypeId = await ctx.db.insert("eventTypes", {
      chapterId: s.chapterId,
      name: "Worship Night",
      slug: "worship-night",
      version: 1,
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
    });
    return ctx.db.insert("events", {
      chapterId: s.chapterId,
      eventTypeId,
      templateVersion: 1,
      name: "Worship Night on the Pier",
      eventDate: now + 14 * 24 * 60 * 60 * 1000,
      status: "planning",
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
    });
  });
}

async function givingSetup(s: ChapterSetup, eventId: Id<"events">) {
  const pageId = (await s.as.mutation(api.ticketing.createPage, {
    eventId,
  })) as Id<"eventPages">;
  const admin = await s.as.query(api.ticketing.getAdminPage, { eventId });
  await s.as.mutation(api.ticketing.updatePage, {
    pageId,
    patch: { published: true, givingEnabled: true },
  });
  return { pageId, slug: admin.page!.slug };
}

/** Count a chapter's donors + gifts directly. */
async function crmCounts(s: ChapterSetup) {
  return run(s.t, async (ctx) => {
    const donors = await ctx.db
      .query("donors")
      .withIndex("by_scope", (q) => q.eq("scope", s.chapterId))
      .collect();
    const gifts = await ctx.db
      .query("gifts")
      .withIndex("by_scope", (q) => q.eq("scope", s.chapterId))
      .collect();
    return { donors, gifts };
  });
}

describe("event-donation dual-write", () => {
  test("a fulfilled card donation creates a donor + linked gift; removeDonation cleans up", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    const { slug } = await givingSetup(s, eventId);

    const prepared = await t.mutation(internal.giving.prepareDonation, {
      slug,
      name: "Dana Donor",
      email: "dana@example.com",
      amountCents: 6000,
    });
    await t.mutation(internal.giving.attachDonationSession, {
      donationId: prepared.donationId,
      sessionId: "cs_dualwrite",
    });
    await t.mutation(internal.giving.markDonationPaid, {
      sessionId: "cs_dualwrite",
      paymentIntentId: "pi_dualwrite",
    });

    let counts = await crmCounts(s);
    expect(counts.donors).toHaveLength(1);
    expect(counts.gifts).toHaveLength(1);
    expect(counts.donors[0].email).toBe("dana@example.com");
    expect(counts.donors[0].lifetimeCents).toBe(6000);
    expect(counts.donors[0].source).toBe("event-donation");
    expect(counts.gifts[0].method).toBe("stripe");
    expect(counts.gifts[0].donationId).toBe(prepared.donationId);

    // The event rollup is untouched by the dual-write (existing behavior).
    const page = await s.as.query(api.ticketing.getAdminPage, { eventId });
    expect(page.page!.donationsCents).toBe(6000);

    // removeDonation reverses the linked gift + donor rollup.
    await s.as.mutation(api.giving.removeDonation, {
      donationId: prepared.donationId,
    });
    counts = await crmCounts(s);
    expect(counts.gifts).toHaveLength(0);
    expect(counts.donors[0].lifetimeCents).toBe(0);
    expect(counts.donors[0].giftCount).toBe(0);
    expect(counts.donors[0].status).toBe("prospect");
  });

  test("a manual cash donation dual-writes a gift (idempotent per donation)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    await givingSetup(s, eventId);

    await s.as.mutation(api.giving.recordDonation, {
      eventId,
      amountCents: 3000,
      method: "cash",
      name: "Manual Gift",
    });
    const counts = await crmCounts(s);
    expect(counts.donors).toHaveLength(1);
    expect(counts.gifts).toHaveLength(1);
    expect(counts.gifts[0].method).toBe("cash");
  });
});

// Territories P6: `importGivebutterCsv`'s dedup/re-run tests moved to
// `tests/canonicalImport.test.ts` (the `gift` row type there ports the exact
// same externalRef dedup — see `givingImport.ts`'s header comment).

// ── Access gating ─────────────────────────────────────────────────────────────

describe("access gating", () => {
  test("a caller with no giving seat is rejected; a development director passes", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));
    const s = await setupChapter(t); // plain chapter admin, no giving seat

    // No giving capability → both read and write are refused.
    await expect(
      s.as.query(api.givingPlatform.listDonors, { scope: "central" }),
    ).rejects.toThrow();
    await expect(
      s.as.mutation(api.givingPlatform.upsertDonor, {
        scope: "central",
        name: "Nope",
      }),
    ).rejects.toThrow();

    // myGivingAccess degrades quietly (no throw) to no access.
    const access = await s.as.query(api.givingPlatform.myGivingAccess, {});
    expect(access.canView).toBe(false);
    expect(access.scope).toBeNull();

    // Seat them as development director → central manage resolves.
    await seatCaller(s, "development_director", "central");
    const granted = await s.as.query(api.givingPlatform.myGivingAccess, {});
    expect(granted.canView).toBe(true);
    expect(granted.canManage).toBe(true);
    expect(granted.scope).toBe("central");
    await expect(
      s.as.query(api.givingPlatform.listDonors, { scope: "central" }),
    ).resolves.toBeDefined();
  });

  test("a chapter treasurer sees only their own chapter (view, not manage)", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));
    const s = await setupChapter(t);
    await seatCaller(s, "treasurer", s.chapterId);

    const access = await s.as.query(api.givingPlatform.myGivingAccess, {});
    expect(access.canView).toBe(true);
    expect(access.canManage).toBe(false);
    expect(access.scope).toBe(s.chapterId);

    // Chapter view resolves; central is out of reach.
    await expect(
      s.as.query(api.givingPlatform.listDonors, { scope: s.chapterId }),
    ).resolves.toBeDefined();
    await expect(
      s.as.query(api.givingPlatform.listDonors, { scope: "central" }),
    ).rejects.toThrow();
    // View-only: writing a donor is refused.
    await expect(
      s.as.mutation(api.givingPlatform.upsertDonor, {
        scope: s.chapterId,
        name: "Nope",
      }),
    ).rejects.toThrow();
  });
});

// ── Chapter lens (`chapterId` arg, WP-S follow-up) ──────────────────────────
//
// Before this arg existed, `myGivingAccess` hard-picked central for ANY
// caller with central reach, so the mobile giving desk always rendered
// central's book regardless of the app's chapter switcher (`ChapterContext`)
// — the "No donors yet" production bug (central's book can be empty while a
// switched-to chapter's isn't). These tests cover the new resolution:
// central holders follow the requested chapter; a chapter-only holder can
// never be steered into a chapter they don't hold, quietly falling back to
// their own; access is never widened by the arg (every downstream giving
// query still re-gates its own scope).
describe("myGivingAccess chapter lens (chapterId arg)", () => {
  test("a central holder + chapterId gets that chapter's scope, with correct canManage", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));
    const s = await setupChapter(t);
    await seatCaller(s, "development_director", "central"); // central giving.manage

    // No chapterId → unchanged default (central).
    const defaultAccess = await s.as.query(api.givingPlatform.myGivingAccess, {});
    expect(defaultAccess.scope).toBe("central");

    // The app's chapter lens wins: the central holder's book follows the
    // switcher instead of always defaulting to central's.
    const lensed = await s.as.query(api.givingPlatform.myGivingAccess, {
      chapterId: s.chapterId,
    });
    expect(lensed.canView).toBe(true);
    expect(lensed.canManage).toBe(true); // central manage = manage everywhere
    expect(lensed.scope).toBe(s.chapterId);
    expect(lensed.chapterName).toBe("New York"); // setupChapter's default name

    // The lens is honored end to end: the scope's own donor list resolves.
    await expect(
      s.as.query(api.givingPlatform.listDonors, { scope: s.chapterId }),
    ).resolves.toBeDefined();
  });

  test("a chapter-seat holder + their own chapterId sees their chapter (unchanged)", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));
    const s = await setupChapter(t);
    await seatCaller(s, "treasurer", s.chapterId); // chapter-scope giving.view

    const lensed = await s.as.query(api.givingPlatform.myGivingAccess, {
      chapterId: s.chapterId,
    });
    expect(lensed.canView).toBe(true);
    expect(lensed.scope).toBe(s.chapterId);
  });

  test("a chapter-seat holder + a FOREIGN chapterId falls back to their own chapter", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));
    const s = await setupChapter(t);
    await seatCaller(s, "treasurer", s.chapterId);

    // A second, unrelated chapter the caller holds no seat in.
    const foreignChapterId = await run(t, (ctx) =>
      ctx.db.insert("chapters", {
        name: "Los Angeles",
        isActive: true,
        createdAt: Date.now(),
      }),
    );

    const lensed = await s.as.query(api.givingPlatform.myGivingAccess, {
      chapterId: foreignChapterId,
    });
    expect(lensed.canView).toBe(true);
    // Never steered into the foreign chapter — falls back to their own.
    expect(lensed.scope).toBe(s.chapterId);
    expect(lensed.scope).not.toBe(foreignChapterId);
  });

  test("a signed-out/unprivileged caller + chapterId still degrades quietly (no throw, no access)", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));
    const s = await setupChapter(t); // plain chapter admin, no giving seat

    const lensed = await s.as.query(api.givingPlatform.myGivingAccess, {
      chapterId: s.chapterId,
    });
    expect(lensed.canView).toBe(false);
    expect(lensed.canManage).toBe(false);
    expect(lensed.scope).toBeNull();
  });

  test("omitting chapterId is unchanged (backward compat)", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));
    const s = await setupChapter(t);
    await seatCaller(s, "development_director", "central");

    const withNoArgs = await s.as.query(api.givingPlatform.myGivingAccess, {});
    expect(withNoArgs.scope).toBe("central");
    expect(withNoArgs.canView).toBe(true);
    expect(withNoArgs.canManage).toBe(true);
    expect(withNoArgs.isCentral).toBe(true);
  });

  test("isCentral is false for a chapter-only holder, true for a central holder", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));
    const s = await setupChapter(t);
    await seatCaller(s, "treasurer", s.chapterId); // chapter giving.view only
    const chapterAccess = await s.as.query(api.givingPlatform.myGivingAccess, {});
    expect(chapterAccess.isCentral).toBe(false);
    expect(chapterAccess.scope).toBe(s.chapterId);
  });
});

// ── Org-wide fleet (giving-dashboard v2) ────────────────────────────────────

/** Insert a scope's denormalized rollup directly (bypassing gift writes) so a
 *  fleet test controls each scope's totals precisely. */
async function seedRollup(
  s: ChapterSetup,
  scope: Id<"chapters"> | "central",
  totals: {
    lifetimeCents: number;
    giftCount: number;
    donorCount: number;
    activeCount: number;
    lapsedCount: number;
    prospectCount: number;
  },
) {
  await run(s.t, (ctx) =>
    ctx.db.insert("givingScopeRollups", { scope, ...totals, updatedAt: Date.now() }),
  );
}

describe("dashboardFleet (org-wide fleet)", () => {
  test("org totals sum every active scope's rollup; inactive chapters excluded; backer/target join", async () => {
    const s = await devDirectorSetup(); // central dev director; s.chapterId = "New York" (active)

    await seedRollup(s, "central", {
      lifetimeCents: 10000,
      giftCount: 2,
      donorCount: 2,
      activeCount: 1,
      lapsedCount: 1,
      prospectCount: 0,
    });
    await seedRollup(s, s.chapterId, {
      lifetimeCents: 5000,
      giftCount: 1,
      donorCount: 1,
      activeCount: 1,
      lapsedCount: 0,
      prospectCount: 0,
    });

    // Home chapter gets a backer count + a linked territory with a goal.
    const { boston, shadow } = await run(s.t, async (ctx) => {
      await ctx.db.patch(s.chapterId, { backerCount: 12 });
      await ctx.db.insert("territories", {
        chapterId: s.chapterId,
        name: "New York",
        region: "NY",
        lat: 0,
        lng: 0,
        slug: "new-york",
        stage: "raising",
        targetBackers: 20,
        publiclyVisible: true,
        launchFundCents: 0,
        launchFundTargetCents: 0,
        createdAt: Date.now(),
        createdBy: s.userId,
        updatedAt: Date.now(),
      });
      const boston = await ctx.db.insert("chapters", {
        name: "Boston",
        isActive: true,
        createdAt: Date.now(),
      });
      // A shadow/prospect chapter — must NEVER appear in the fleet.
      const shadow = await ctx.db.insert("chapters", {
        name: "Shadow",
        isActive: false,
        createdAt: Date.now(),
      });
      return { boston, shadow };
    });

    await seedRollup(s, boston, {
      lifetimeCents: 3000,
      giftCount: 1,
      donorCount: 1,
      activeCount: 0,
      lapsedCount: 1,
      prospectCount: 0,
    });
    // Shadow chapter has a (huge) rollup that must be excluded from the fleet.
    await seedRollup(s, shadow, {
      lifetimeCents: 99999,
      giftCount: 9,
      donorCount: 9,
      activeCount: 9,
      lapsedCount: 9,
      prospectCount: 9,
    });

    const fleet = await s.as.query(api.givingPlatform.dashboardFleet, {});

    // Central row leads; inactive chapter excluded.
    expect(fleet.scopes[0].scope).toBe("central");
    expect(fleet.scopes.some((r) => r.scope === shadow)).toBe(false);

    // Org totals = central + New York + Boston (NOT the shadow chapter).
    expect(fleet.org.lifetimeCents).toBe(10000 + 5000 + 3000);
    expect(fleet.org.donorCount).toBe(2 + 1 + 1);
    expect(fleet.org.lapsedCount).toBe(1 + 0 + 1);
    // Backer/target join: only New York has a backer count + territory goal.
    expect(fleet.org.backerCount).toBe(12);
    expect(fleet.org.targetBackers).toBe(20);

    const ny = fleet.scopes.find((r) => r.scope === s.chapterId)!;
    expect(ny.backerCount).toBe(12);
    expect(ny.targetBackers).toBe(20);
    expect(ny.backersBelowTarget).toBe(true); // 12 < 20
    expect(ny.hasLapsed).toBe(false);

    const bostonRow = fleet.scopes.find((r) => r.scope === boston)!;
    expect(bostonRow.backerCount).toBeNull(); // unset (absent/0)
    expect(bostonRow.targetBackers).toBeNull(); // no territory
    expect(bostonRow.backersBelowTarget).toBe(false);
    expect(bostonRow.hasLapsed).toBe(true);

    // Central's own row never carries a backer figure.
    expect(fleet.scopes[0].backerCount).toBeNull();
    expect(fleet.scopes[0].hasLapsed).toBe(true);
  });

  test("a chapter-only caller is rejected", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));
    const s = await setupChapter(t);
    await seatCaller(s, "treasurer", s.chapterId); // chapter giving.view only
    await expect(
      s.as.query(api.givingPlatform.dashboardFleet, {}),
    ).rejects.toThrow();
  });
});

// ── listDonors all-scopes (central) ─────────────────────────────────────────

describe("listDonors all-scopes mode", () => {
  test("merges every scope's donors, lifetime desc, with a chapter tag", async () => {
    const s = await devDirectorSetup(); // central dev director; s.chapterId = "New York"

    // Central donor — $70 lifetime.
    const centralDonor = (await s.as.mutation(api.givingPlatform.upsertDonor, {
      scope: "central",
      name: "Central Whale",
      email: "cw@example.com",
    })) as Id<"donors">;
    await s.as.mutation(api.givingPlatform.recordGift, {
      donorId: centralDonor,
      amountCents: 7000,
      method: "check",
    });

    // Home-chapter donor — $30 lifetime.
    const nyDonor = (await s.as.mutation(api.givingPlatform.upsertDonor, {
      scope: s.chapterId,
      name: "NY Donor",
      email: "ny@example.com",
    })) as Id<"donors">;
    await s.as.mutation(api.givingPlatform.recordGift, {
      donorId: nyDonor,
      amountCents: 3000,
      method: "check",
    });

    // A second active chapter + a $50 donor.
    const boston = await run(s.t, (ctx) =>
      ctx.db.insert("chapters", {
        name: "Boston",
        isActive: true,
        createdAt: Date.now(),
      }),
    );
    const bostonDonor = (await s.as.mutation(api.givingPlatform.upsertDonor, {
      scope: boston,
      name: "Boston Donor",
      email: "bo@example.com",
    })) as Id<"donors">;
    await s.as.mutation(api.givingPlatform.recordGift, {
      donorId: bostonDonor,
      amountCents: 5000,
      method: "check",
    });

    const all = (await s.as.query(api.givingPlatform.listDonors, {
      scope: "central",
      allScopes: true,
    })) as Array<Doc<"donors"> & { scopeLabel: string }>;

    // Merge order, strongest lifetime first: central($70) → boston($50) → ny($30).
    const known = all
      .map((d) => d._id)
      .filter((id) => [centralDonor, bostonDonor, nyDonor].includes(id));
    expect(known).toEqual([centralDonor, bostonDonor, nyDonor]);

    // Each row carries its scope's chapter tag.
    expect(all.find((d) => d._id === centralDonor)?.scopeLabel).toBe("Central");
    expect(all.find((d) => d._id === nyDonor)?.scopeLabel).toBe("New York");
    expect(all.find((d) => d._id === bostonDonor)?.scopeLabel).toBe("Boston");
  });

  test("all-scopes is central-gated (a chapter-only caller is rejected)", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));
    const s = await setupChapter(t);
    await seatCaller(s, "treasurer", s.chapterId); // chapter giving.view only
    await expect(
      s.as.query(api.givingPlatform.listDonors, {
        scope: s.chapterId,
        allScopes: true,
      }),
    ).rejects.toThrow();
  });
});
