import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import { newT, run, setupChapter, storeBlob, type ChapterSetup } from "./setup.helpers";
import { runSeedSeatDefs } from "../migrations/0022_seed_seat_defs";
import {
  recordGiftForDonor,
  editGiftRow,
  matchOrCreateDonor,
} from "../lib/givingDonors";
import type { Id } from "../_generated/dataModel";

/**
 * Territories P4 — gift editing / sources / receipts:
 *   - amount edit moves donor rollup, scope rollup, AND the launch pot by the
 *     same delta exactly once (flagged gift, pre-launch) and NOT the pot once
 *     the territory has launched (freeze),
 *   - receivedAt edit recomputes the donor bookends + re-derives status,
 *   - GIFT_LOCKED on money fields for a system-written (Stripe/donation) gift,
 *     while note + receipts still succeed,
 *   - receipts bounded at 10,
 *   - the widened-source record path persists a new source literal.
 *
 * (Migration 0031's relabel-`imported` coverage lived here too, until
 * Territories Deploy B removed the literal it depended on — see the note by
 * the old "Migration 0031" section below.)
 */

const NINETY_ONE_DAYS_MS = 91 * 24 * 60 * 60 * 1000;

/** Seat the caller as development director at central (full giving.manage). */
async function seatDevDirector(s: ChapterSetup): Promise<void> {
  await run(s.t, async (ctx) => {
    const personId = await ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Seated Caller",
      userId: s.userId,
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
  });
}

async function devDirectorSetup(): Promise<ChapterSetup> {
  const t = newT();
  await run(t, (ctx) => runSeedSeatDefs(ctx));
  const s = await setupChapter(t);
  await seatDevDirector(s);
  return s;
}

/** Create a territory linked to the setup's chapter at the given stage. */
async function createTerritory(
  s: ChapterSetup,
  stage: "prospect" | "raising" | "launched",
): Promise<Id<"territories">> {
  return run(s.t, async (ctx) => {
    const now = Date.now();
    return ctx.db.insert("territories", {
      chapterId: s.chapterId,
      name: "Test Territory",
      region: "NY",
      lat: 40.7,
      lng: -74,
      slug: `terr-${Math.random().toString(36).slice(2, 8)}`,
      stage,
      targetBackers: 20,
      publiclyVisible: true,
      launchFundCents: 0,
      launchFundTargetCents: 100000,
      createdAt: now,
      createdBy: s.userId,
      updatedAt: now,
    });
  });
}

async function giftRow(s: ChapterSetup, giftId: Id<"gifts">) {
  return run(s.t, (ctx) => ctx.db.get(giftId));
}

/** Seed a minimal event + its `eventPages` row (externalGiftsCents starts
 *  unset) — the gift→event attach rollup's target. */
async function seedEventWithPage(
  s: ChapterSetup,
): Promise<{ eventId: Id<"events">; pageId: Id<"eventPages"> }> {
  return run(s.t, async (ctx) => {
    const now = Date.now();
    const eventTypeId = await ctx.db.insert("eventTypes", {
      chapterId: s.chapterId,
      name: "Gala",
      slug: "gala",
      version: 1,
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
    });
    const eventId = await ctx.db.insert("events", {
      chapterId: s.chapterId,
      eventTypeId,
      templateVersion: 1,
      name: "Gala",
      eventDate: now + 14 * 24 * 60 * 60 * 1000,
      status: "planning",
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
    });
    const pageId = await ctx.db.insert("eventPages", {
      eventId,
      chapterId: s.chapterId,
      slug: "gala",
      published: true,
      goingCount: 0,
      maybeCount: 0,
      notGoingCount: 0,
      ticketsSoldCount: 0,
      revenueCents: 0,
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
    });
    return { eventId, pageId };
  });
}

async function eventPageRow(s: ChapterSetup, pageId: Id<"eventPages">) {
  return run(s.t, (ctx) => ctx.db.get(pageId));
}
async function donorRow(s: ChapterSetup, donorId: Id<"donors">) {
  return run(s.t, (ctx) => ctx.db.get(donorId));
}
async function territoryRow(s: ChapterSetup, territoryId: Id<"territories">) {
  return run(s.t, (ctx) => ctx.db.get(territoryId));
}
async function scopeRollup(s: ChapterSetup, scope: Id<"chapters"> | "central") {
  return run(s.t, (ctx) =>
    ctx.db
      .query("givingScopeRollups")
      .withIndex("by_scope", (q) => q.eq("scope", scope))
      .unique(),
  );
}

// ── Amount edit: donor + scope + pot all move by the delta, once each ─────────

describe("editGiftRow — amount delta", () => {
  test("moves donor, scope, and the launch pot by the same delta (pre-launch)", async () => {
    const s = await setupChapter(newT());
    const territoryId = await createTerritory(s, "raising");

    const { donorId, giftId } = await run(s.t, async (ctx) => {
      const donorId = await matchOrCreateDonor(ctx, {
        scope: s.chapterId,
        name: "Chapter Backer",
      });
      const giftId = await recordGiftForDonor(ctx, {
        donorId,
        amountCents: 5000,
        receivedAt: Date.now(),
        method: "cash",
        recordedBy: s.userId,
      });
      return { donorId, giftId };
    });

    // Recorded: flagged, and the pot accrued the full amount.
    expect((await giftRow(s, giftId))?.countedInLaunchFund).toBe(true);
    expect((await territoryRow(s, territoryId))?.launchFundCents).toBe(5000);
    expect((await donorRow(s, donorId))?.lifetimeCents).toBe(5000);
    expect((await scopeRollup(s, s.chapterId))?.lifetimeCents).toBe(5000);

    // Edit up by +3000 → everything lands on 8000, once.
    await run(s.t, (ctx) =>
      editGiftRow(ctx, { giftId, amountCents: 8000, editedBy: s.userId }),
    );
    let gift = await giftRow(s, giftId);
    expect(gift?.amountCents).toBe(8000);
    expect(gift?.countedInLaunchFund).toBe(true); // flag never cleared by an edit
    expect(gift?.editedAt).toBeGreaterThan(0);
    expect(gift?.editedBy).toBe(s.userId);
    expect((await donorRow(s, donorId))?.lifetimeCents).toBe(8000);
    expect((await scopeRollup(s, s.chapterId))?.lifetimeCents).toBe(8000);
    expect((await territoryRow(s, territoryId))?.launchFundCents).toBe(8000);

    // Edit down by -2000 → 6000 everywhere.
    await run(s.t, (ctx) =>
      editGiftRow(ctx, { giftId, amountCents: 6000, editedBy: s.userId }),
    );
    expect((await donorRow(s, donorId))?.lifetimeCents).toBe(6000);
    expect((await scopeRollup(s, s.chapterId))?.lifetimeCents).toBe(6000);
    expect((await territoryRow(s, territoryId))?.launchFundCents).toBe(6000);
  });

  test("does NOT move the pot once the territory has launched (freeze)", async () => {
    const s = await setupChapter(newT());
    const territoryId = await createTerritory(s, "raising");

    const { donorId, giftId } = await run(s.t, async (ctx) => {
      const donorId = await matchOrCreateDonor(ctx, {
        scope: s.chapterId,
        name: "Pre-launch Backer",
      });
      const giftId = await recordGiftForDonor(ctx, {
        donorId,
        amountCents: 5000,
        receivedAt: Date.now(),
        method: "cash",
        recordedBy: s.userId,
      });
      return { donorId, giftId };
    });
    expect((await territoryRow(s, territoryId))?.launchFundCents).toBe(5000);

    // Territory launches — the pot freezes at 5000.
    await run(s.t, (ctx) =>
      ctx.db.patch(territoryId, { stage: "launched", launchedAt: Date.now() }),
    );

    // A post-launch amount correction moves donor + scope, but NOT the pot.
    await run(s.t, (ctx) =>
      editGiftRow(ctx, { giftId, amountCents: 9000, editedBy: s.userId }),
    );
    expect((await donorRow(s, donorId))?.lifetimeCents).toBe(9000);
    expect((await scopeRollup(s, s.chapterId))?.lifetimeCents).toBe(9000);
    expect((await territoryRow(s, territoryId))?.launchFundCents).toBe(5000); // frozen
    // The flag stays on the row's history even though the pot didn't move.
    expect((await giftRow(s, giftId))?.countedInLaunchFund).toBe(true);
  });
});

// ── receivedAt edit: bookends + status ────────────────────────────────────────

describe("editGiftRow — receivedAt", () => {
  test("recomputes bookends and re-derives status across the lapse window", async () => {
    const s = await setupChapter(newT());
    const { donorId, giftId } = await run(s.t, async (ctx) => {
      const donorId = await matchOrCreateDonor(ctx, {
        scope: "central",
        name: "Window Mover",
      });
      const giftId = await recordGiftForDonor(ctx, {
        donorId,
        amountCents: 4000,
        receivedAt: Date.now(),
        method: "check",
        recordedBy: s.userId,
      });
      return { donorId, giftId };
    });
    expect((await donorRow(s, donorId))?.status).toBe("active");
    expect((await scopeRollup(s, "central"))?.activeCount).toBe(1);

    // Move the (only) gift to 91 days ago → bookends follow, status → lapsed.
    const oldDate = Date.now() - NINETY_ONE_DAYS_MS;
    await run(s.t, (ctx) =>
      editGiftRow(ctx, { giftId, receivedAt: oldDate, editedBy: s.userId }),
    );
    let donor = await donorRow(s, donorId);
    expect(donor?.status).toBe("lapsed");
    expect(donor?.lastGiftAt).toBe(oldDate);
    expect(donor?.firstGiftAt).toBe(oldDate);
    let rollup = await scopeRollup(s, "central");
    expect(rollup?.lapsedCount).toBe(1);
    expect(rollup?.activeCount).toBe(0);

    // Move it back to now → active again.
    const now = Date.now();
    await run(s.t, (ctx) =>
      editGiftRow(ctx, { giftId, receivedAt: now, editedBy: s.userId }),
    );
    donor = await donorRow(s, donorId);
    expect(donor?.status).toBe("active");
    expect(donor?.lastGiftAt).toBe(now);
    rollup = await scopeRollup(s, "central");
    expect(rollup?.activeCount).toBe(1);
    expect(rollup?.lapsedCount).toBe(0);
  });
});

// ── GIFT_LOCKED: system-written gifts are note/receipt-only ────────────────────

describe("editGift — GIFT_LOCKED", () => {
  test("a Stripe/donation gift rejects money edits but allows note + receipts", async () => {
    const s = await devDirectorSetup();
    const donorId = (await s.as.mutation(api.givingPlatform.upsertDonor, {
      scope: "central",
      name: "Locked Gift Donor",
      email: "locked@example.com",
    })) as Id<"donors">;
    const giftId = (await s.as.mutation(api.givingPlatform.recordGift, {
      donorId,
      amountCents: 5000,
      method: "stripe",
    })) as Id<"gifts">;

    // Make it system-written (a recurring Stripe billing cycle).
    await run(s.t, (ctx) =>
      ctx.db.patch(giftId, { stripeInvoiceId: "in_test_lock" }),
    );

    // Amount / date / source edits are all refused.
    await expect(
      s.as.mutation(api.givingPlatform.editGift, { giftId, amountCents: 9999 }),
    ).rejects.toThrow(/GIFT_LOCKED/);
    await expect(
      s.as.mutation(api.givingPlatform.editGift, {
        giftId,
        receivedAt: Date.now() - 1000,
      }),
    ).rejects.toThrow(/GIFT_LOCKED/);
    await expect(
      s.as.mutation(api.givingPlatform.editGift, { giftId, method: "cash" }),
    ).rejects.toThrow(/GIFT_LOCKED/);

    // Note + receipts still succeed, and the money fields are untouched.
    const receiptId = await storeBlob(s.t);
    await s.as.mutation(api.givingPlatform.editGift, {
      giftId,
      note: "Matched by finance",
      receiptStorageIds: [receiptId],
    });
    const gift = await giftRow(s, giftId);
    expect(gift?.note).toBe("Matched by finance");
    expect(gift?.receiptStorageIds).toEqual([receiptId]);
    expect(gift?.amountCents).toBe(5000);
    expect(gift?.method).toBe("stripe");
  });

  test("a donation-linked gift is also money-locked", async () => {
    const s = await devDirectorSetup();
    const donorId = (await s.as.mutation(api.givingPlatform.upsertDonor, {
      scope: "central",
      name: "Donation Gift Donor",
    })) as Id<"donors">;
    const giftId = (await s.as.mutation(api.givingPlatform.recordGift, {
      donorId,
      amountCents: 3000,
      method: "stripe",
    })) as Id<"gifts">;
    // Stamp a donation link (the value need only be present for the lock check).
    await run(s.t, async (ctx) => {
      const donationId = await ctx.db.insert("donations", {
        chapterId: s.chapterId,
        eventId: (await ctx.db.insert("events", {
          chapterId: s.chapterId,
          eventTypeId: await ctx.db.insert("eventTypes", {
            chapterId: s.chapterId,
            name: "T",
            slug: "t",
            version: 1,
            createdBy: s.userId,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          }),
          templateVersion: 1,
          name: "E",
          eventDate: Date.now(),
          status: "planning",
          createdBy: s.userId,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        })) as Id<"events">,
        name: "X",
        amountCents: 3000,
        currency: "usd",
        method: "card",
        status: "paid",
        createdAt: Date.now(),
      });
      await ctx.db.patch(giftId, { donationId });
    });

    await expect(
      s.as.mutation(api.givingPlatform.editGift, { giftId, amountCents: 4000 }),
    ).rejects.toThrow(/GIFT_LOCKED/);
    // Note-only still fine.
    await s.as.mutation(api.givingPlatform.editGift, { giftId, note: "ok" });
    expect((await giftRow(s, giftId))?.note).toBe("ok");
  });
});

// ── Receipts bounded at 10 ────────────────────────────────────────────────────

describe("receipts bound", () => {
  test("recordGift and editGift reject more than 10 receipts", async () => {
    const s = await devDirectorSetup();
    const donorId = (await s.as.mutation(api.givingPlatform.upsertDonor, {
      scope: "central",
      name: "Receipt Donor",
    })) as Id<"donors">;

    // Eleven real storage ids.
    const ids: Id<"_storage">[] = [];
    for (let i = 0; i < 11; i++) ids.push(await storeBlob(s.t));

    await expect(
      s.as.mutation(api.givingPlatform.recordGift, {
        donorId,
        amountCents: 1000,
        method: "cash",
        receiptStorageIds: ids,
      }),
    ).rejects.toThrow(/TOO_MANY_RECEIPTS/);

    // Ten is fine; then editing to eleven is rejected.
    const giftId = (await s.as.mutation(api.givingPlatform.recordGift, {
      donorId,
      amountCents: 1000,
      method: "cash",
      receiptStorageIds: ids.slice(0, 10),
    })) as Id<"gifts">;
    expect((await giftRow(s, giftId))?.receiptStorageIds).toHaveLength(10);

    await expect(
      s.as.mutation(api.givingPlatform.editGift, {
        giftId,
        receiptStorageIds: ids,
      }),
    ).rejects.toThrow(/TOO_MANY_RECEIPTS/);
  });
});

// ── Migration 0031 ───────────────────────────────────────────────────────────
//
// This block used to seed `method: "imported"` gift rows and assert 0031's
// both-branch relabel (externalRef/donor-source → `givebutter`, else `other`)
// was idempotent. Territories Deploy B dropped `"imported"` from
// `GIFT_METHODS` — unlike the undeclared-TABLE precedent elsewhere in this
// registry (e.g. `0026_migrate_budget_v1_lines.test.ts`'s `(ctx.db as any)`
// seeding), `gifts` is still a real, schema-validated table, and Convex
// enforces its `method` union on every write regardless of TypeScript casts.
// So a gift row with `method: "imported"` can no longer be constructed at
// all, in a test or otherwise — there's nothing left this block could
// exercise. See `migrations/0031_gift_method_sources.ts`'s module doc for how
// the migration itself stays compiling (a `string` cast on read, since the
// comparison can now never match).

// ── Gift→event attach (fundraiser attribution) ──────────────────────────────
//
// `attachGiftToEvent` tags an EXTERNAL gift (no `donationId`) with an event so
// it counts toward that event's `externalGiftsCents`/`externalGiftsCount` —
// kept strictly separate from `donationsCents` (the on-page giving flow's own
// rollup) so the same dollar never counts twice (see
// `schema/ticketing.ts`'s `externalGiftsCents` doc + the CONTRACT).

describe("attachGiftToEvent", () => {
  test("attach bumps externalGiftsCents/Count; detach reverses them", async () => {
    const s = await devDirectorSetup();
    const { eventId, pageId } = await seedEventWithPage(s);
    const donorId = (await s.as.mutation(api.givingPlatform.upsertDonor, {
      scope: "central",
      name: "External Gift Donor",
    })) as Id<"donors">;
    const giftId = (await s.as.mutation(api.givingPlatform.recordGift, {
      donorId,
      amountCents: 7500,
      method: "wire",
    })) as Id<"gifts">;

    // Unattached to start — no rollup yet.
    let page = await eventPageRow(s, pageId);
    expect(page?.externalGiftsCents ?? 0).toBe(0);
    expect(page?.externalGiftsCount ?? 0).toBe(0);

    // Attach — the event's external-gifts rollup bumps by the gift's amount.
    await s.as.mutation(api.givingPlatform.attachGiftToEvent, {
      giftId,
      eventId,
    });
    page = await eventPageRow(s, pageId);
    expect(page?.externalGiftsCents).toBe(7500);
    expect(page?.externalGiftsCount).toBe(1);
    const gift = await giftRow(s, giftId);
    expect(gift?.eventId).toBe(eventId);
    expect(gift?.editedAt).toBeGreaterThan(0);

    // Detach (`eventId: null`) — the rollup un-bumps back to zero, clamped.
    await s.as.mutation(api.givingPlatform.attachGiftToEvent, {
      giftId,
      eventId: null,
    });
    page = await eventPageRow(s, pageId);
    expect(page?.externalGiftsCents).toBe(0);
    expect(page?.externalGiftsCount).toBe(0);
    expect((await giftRow(s, giftId))?.eventId).toBeUndefined();
  });

  test("re-attaching to a different event moves the rollup, not double-counts it", async () => {
    const s = await devDirectorSetup();
    const { eventId: eventA, pageId: pageA } = await seedEventWithPage(s);
    const { eventId: eventB, pageId: pageB } = await seedEventWithPage(s);
    const donorId = (await s.as.mutation(api.givingPlatform.upsertDonor, {
      scope: "central",
      name: "Re-attach Donor",
    })) as Id<"donors">;
    const giftId = (await s.as.mutation(api.givingPlatform.recordGift, {
      donorId,
      amountCents: 2000,
      method: "check",
    })) as Id<"gifts">;

    await s.as.mutation(api.givingPlatform.attachGiftToEvent, {
      giftId,
      eventId: eventA,
    });
    await s.as.mutation(api.givingPlatform.attachGiftToEvent, {
      giftId,
      eventId: eventB,
    });

    expect((await eventPageRow(s, pageA))?.externalGiftsCents).toBe(0);
    expect((await eventPageRow(s, pageB))?.externalGiftsCents).toBe(2000);
    expect((await giftRow(s, giftId))?.eventId).toBe(eventB);
  });

  test("removing an attached external gift reverses the event rollup", async () => {
    const s = await devDirectorSetup();
    const { eventId, pageId } = await seedEventWithPage(s);
    const donorId = (await s.as.mutation(api.givingPlatform.upsertDonor, {
      scope: "central",
      name: "Removed Gift Donor",
    })) as Id<"donors">;
    const giftId = (await s.as.mutation(api.givingPlatform.recordGift, {
      donorId,
      amountCents: 1200,
      method: "cash",
    })) as Id<"gifts">;
    await s.as.mutation(api.givingPlatform.attachGiftToEvent, {
      giftId,
      eventId,
    });
    expect((await eventPageRow(s, pageId))?.externalGiftsCents).toBe(1200);

    await s.as.mutation(api.givingPlatform.removeGift, {
      giftId,
      why: "Duplicate entry",
    });
    expect((await eventPageRow(s, pageId))?.externalGiftsCents).toBe(0);
    expect((await eventPageRow(s, pageId))?.externalGiftsCount).toBe(0);
  });

  test("editing the amount of an attached gift keeps externalGiftsCents in lockstep", async () => {
    const s = await devDirectorSetup();
    const { eventId, pageId } = await seedEventWithPage(s);
    const donorId = (await s.as.mutation(api.givingPlatform.upsertDonor, {
      scope: "central",
      name: "Amount-Edit Donor",
    })) as Id<"donors">;
    const giftId = (await s.as.mutation(api.givingPlatform.recordGift, {
      donorId,
      amountCents: 7500,
      method: "wire",
    })) as Id<"gifts">;
    await s.as.mutation(api.givingPlatform.attachGiftToEvent, { giftId, eventId });
    expect((await eventPageRow(s, pageId))?.externalGiftsCents).toBe(7500);

    // Correcting the amount UP must move the event rollup with it...
    await s.as.mutation(api.givingPlatform.editGift, { giftId, amountCents: 15000 });
    expect((await eventPageRow(s, pageId))?.externalGiftsCents).toBe(15000);
    // ...and DOWN.
    await s.as.mutation(api.givingPlatform.editGift, { giftId, amountCents: 5000 });
    expect((await eventPageRow(s, pageId))?.externalGiftsCents).toBe(5000);
    expect((await eventPageRow(s, pageId))?.externalGiftsCount).toBe(1);

    // Detaching now reverses the CURRENT amount exactly, back to zero.
    await s.as.mutation(api.givingPlatform.attachGiftToEvent, { giftId, eventId: null });
    expect((await eventPageRow(s, pageId))?.externalGiftsCents).toBe(0);
    expect((await eventPageRow(s, pageId))?.externalGiftsCount).toBe(0);
  });

  test("a donation-linked gift is refused with GIFT_HAS_EVENT_SOURCE (double-count guard)", async () => {
    const s = await devDirectorSetup();
    const { eventId } = await seedEventWithPage(s);
    const donorId = (await s.as.mutation(api.givingPlatform.upsertDonor, {
      scope: "central",
      name: "On-page Donor",
    })) as Id<"donors">;
    const giftId = (await s.as.mutation(api.givingPlatform.recordGift, {
      donorId,
      amountCents: 3300,
      method: "stripe",
    })) as Id<"gifts">;

    // Simulate the on-page donation dual-write: `donationId` set (already
    // counted in `donationsCents` elsewhere) — this is the exact case
    // `attachGiftToEvent` must never let into `externalGiftsCents` too.
    await run(s.t, async (ctx) => {
      const donationId = await ctx.db.insert("donations", {
        chapterId: s.chapterId,
        eventId,
        name: "X",
        amountCents: 3300,
        currency: "usd",
        method: "card",
        status: "paid",
        createdAt: Date.now(),
      });
      await ctx.db.patch(giftId, { donationId, eventId });
    });

    await expect(
      s.as.mutation(api.givingPlatform.attachGiftToEvent, {
        giftId,
        eventId,
      }),
    ).rejects.toThrow(/GIFT_HAS_EVENT_SOURCE/);
  });
});

// ── recordGiftForDonor event "Given" rollup (the closed rollup gap) ──────────
//
// A gift BORN with an `eventId` (manual recordGift, the Givebutter donation
// sync) must roll into that event's externalGiftsCents/Count immediately —
// UNLESS it also carries a `donationId` (a native on-page donation, already
// counted in donationsCents), which is the double-count firewall.

describe("recordGiftForDonor event rollup gap", () => {
  test("a gift with eventId and no donationId bumps externalGiftsCents/Count", async () => {
    const s = await devDirectorSetup();
    const { eventId, pageId } = await seedEventWithPage(s);
    await run(s.t, async (ctx) => {
      const donorId = await matchOrCreateDonor(ctx, {
        scope: s.chapterId,
        name: "Direct Event Giver",
      });
      await recordGiftForDonor(ctx, {
        donorId,
        amountCents: 4200,
        receivedAt: Date.now(),
        method: "givebutter",
        eventId,
      });
    });
    const page = await eventPageRow(s, pageId);
    expect(page?.externalGiftsCents).toBe(4200);
    expect(page?.externalGiftsCount).toBe(1);
  });

  test("a gift with a donationId does NOT bump externalGiftsCents (double-count guard)", async () => {
    const s = await devDirectorSetup();
    const { eventId, pageId } = await seedEventWithPage(s);
    await run(s.t, async (ctx) => {
      const donationId = await ctx.db.insert("donations", {
        chapterId: s.chapterId,
        eventId,
        name: "On-page Giver",
        amountCents: 4200,
        currency: "usd",
        method: "card",
        status: "paid",
        createdAt: Date.now(),
      });
      const donorId = await matchOrCreateDonor(ctx, {
        scope: s.chapterId,
        name: "On-page Giver",
      });
      await recordGiftForDonor(ctx, {
        donorId,
        amountCents: 4200,
        receivedAt: Date.now(),
        method: "stripe",
        eventId,
        donationId,
      });
    });
    const page = await eventPageRow(s, pageId);
    expect(page?.externalGiftsCents ?? 0).toBe(0);
    expect(page?.externalGiftsCount ?? 0).toBe(0);
  });

  test("removing an eventId gift reverses the externalGiftsCents bump", async () => {
    const s = await devDirectorSetup();
    const { eventId, pageId } = await seedEventWithPage(s);
    const giftId = await run(s.t, async (ctx) => {
      const donorId = await matchOrCreateDonor(ctx, {
        scope: s.chapterId,
        name: "Reversible Giver",
      });
      return recordGiftForDonor(ctx, {
        donorId,
        amountCents: 3000,
        receivedAt: Date.now(),
        method: "givebutter",
        eventId,
      });
    });
    expect((await eventPageRow(s, pageId))?.externalGiftsCents).toBe(3000);

    await s.as.mutation(api.givingPlatform.removeGift, {
      giftId,
      why: "Test reversal",
    });
    expect((await eventPageRow(s, pageId))?.externalGiftsCents).toBe(0);
    expect((await eventPageRow(s, pageId))?.externalGiftsCount).toBe(0);
  });
});

// ── Widened-source record path ────────────────────────────────────────────────

describe("widened source union", () => {
  test("recordGift persists each newly-added source literal", async () => {
    const s = await devDirectorSetup();
    const donorId = (await s.as.mutation(api.givingPlatform.upsertDonor, {
      scope: "central",
      name: "Source Donor",
    })) as Id<"donors">;

    for (const method of ["zelle", "venmo", "givebutter", "other"] as const) {
      const giftId = (await s.as.mutation(api.givingPlatform.recordGift, {
        donorId,
        amountCents: 1500,
        method,
      })) as Id<"gifts">;
      expect((await giftRow(s, giftId))?.method).toBe(method);
    }
  });
});
