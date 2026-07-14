import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import {
  newT,
  run,
  setupChapter,
  storeBlob,
  type ChapterSetup,
} from "./setup.helpers";
import type { Id } from "../_generated/dataModel";
import type { EventStatus } from "@events-os/shared";

/**
 * Inventory (M5.5) tests — the chapter asset registry + per-event reservations:
 *   - addAsset + quantity validation (reject negative / non-integer, allow 0),
 *   - listAssets computes reservedLive / available / overbooked,
 *   - reserveAsset UPSERT (a second reserve of the same asset by the same event
 *     updates the quantity, never duplicates the row),
 *   - overbooking counts only LIVE events (planning/ready) — a completed event
 *     releases its hold and the overbooked flag clears,
 *   - cross-chapter reservation is rejected,
 *   - removeAsset cascade-deletes its reservations,
 *   - reservation quantity validation (reject 0 / negative / non-integer),
 *   - access gating rejects a cross-chapter admin and an unauthenticated caller.
 */

/** Minimal template + event so chapter-scoped functions have a target. */
async function seedEvent(
  s: ChapterSetup,
  status: EventStatus = "planning",
): Promise<Id<"events">> {
  return await run(s.t, async (ctx) => {
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
    return await ctx.db.insert("events", {
      chapterId: s.chapterId,
      eventTypeId,
      templateVersion: 1,
      name: "Worship Night on the Pier",
      eventDate: now + 14 * 24 * 60 * 60 * 1000,
      status,
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
    });
  });
}

/** Force an event's status (to test live-vs-dead reservation classification). */
async function setEventStatus(
  s: ChapterSetup,
  eventId: Id<"events">,
  status: EventStatus,
) {
  await run(s.t, async (ctx) => {
    await ctx.db.patch(eventId, { status });
  });
}

describe("assets", () => {
  test("addAsset appends in order; updateAsset patches; removeAsset deletes", async () => {
    const t = newT();
    const s = await setupChapter(t);

    const battery = (await s.as.mutation(api.inventory.addAsset, {
      name: "200W battery",
      category: "power",
      quantity: 2,
    })) as Id<"assets">;
    await s.as.mutation(api.inventory.addAsset, {
      name: "SM58 mic",
      category: "audio",
      quantity: 4,
      acquired: true,
    });

    let assets = await s.as.query(api.inventory.listAssets, {});
    expect(assets).toHaveLength(2);
    expect(assets.map((a) => a.name)).toEqual(["200W battery", "SM58 mic"]);
    // A freshly-added asset with no reservations is fully available.
    const bat = assets.find((a) => a._id === battery)!;
    expect(bat.reservedLive).toBe(0);
    expect(bat.available).toBe(2);
    expect(bat.overbooked).toBe(false);
    expect(bat.acquired).toBe(true);

    // Update name/quantity/condition/stateNote, then clear stateNote with null.
    await s.as.mutation(api.inventory.updateAsset, {
      assetId: battery,
      name: "200W power station",
      quantity: 3,
      condition: "needs_attention",
      stateNote: "charge the battery (VERY IMPORTANT)",
      acquired: false,
    });
    assets = await s.as.query(api.inventory.listAssets, {});
    const updated = assets.find((a) => a._id === battery)!;
    expect(updated.name).toBe("200W power station");
    expect(updated.quantity).toBe(3);
    expect(updated.available).toBe(3);
    expect(updated.condition).toBe("needs_attention");
    expect(updated.stateNote).toBe("charge the battery (VERY IMPORTANT)");
    expect(updated.acquired).toBe(false);

    await s.as.mutation(api.inventory.updateAsset, {
      assetId: battery,
      stateNote: null,
    });
    assets = await s.as.query(api.inventory.listAssets, {});
    expect(assets.find((a) => a._id === battery)!.stateNote).toBeUndefined();

    await s.as.mutation(api.inventory.removeAsset, { assetId: battery });
    assets = await s.as.query(api.inventory.listAssets, {});
    expect(assets).toHaveLength(1);
    expect(assets[0].name).toBe("SM58 mic");
  });

  test("addAsset rejects negative / non-integer quantity; allows 0", async () => {
    const t = newT();
    const s = await setupChapter(t);

    await expect(
      s.as.mutation(api.inventory.addAsset, {
        name: "Bad",
        category: "other",
        quantity: -1,
      }),
    ).rejects.toThrow();
    await expect(
      s.as.mutation(api.inventory.addAsset, {
        name: "Bad",
        category: "other",
        quantity: 2.5,
      }),
    ).rejects.toThrow();
    await expect(
      s.as.mutation(api.inventory.addAsset, {
        name: "   ",
        category: "other",
        quantity: 1,
      }),
    ).rejects.toThrow();

    // Zero IS allowed — a Chapter-Kit item targeted but not yet acquired.
    await s.as.mutation(api.inventory.addAsset, {
      name: "A-frame sign",
      category: "signage",
      quantity: 0,
      acquired: false,
    });
    const assets = await s.as.query(api.inventory.listAssets, {});
    expect(assets).toHaveLength(1);
    expect(assets[0].quantity).toBe(0);
    expect(assets[0].available).toBe(0);
    expect(assets[0].acquired).toBe(false);
  });

  test("updateAsset rejects negative / non-integer quantity", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const assetId = (await s.as.mutation(api.inventory.addAsset, {
      name: "Mixer",
      category: "audio",
      quantity: 1,
    })) as Id<"assets">;

    await expect(
      s.as.mutation(api.inventory.updateAsset, { assetId, quantity: -3 }),
    ).rejects.toThrow();
    await expect(
      s.as.mutation(api.inventory.updateAsset, { assetId, quantity: 1.5 }),
    ).rejects.toThrow();
    // Unchanged.
    const assets = await s.as.query(api.inventory.listAssets, {});
    expect(assets[0].quantity).toBe(1);
  });

  test("setAssetPhoto attaches a storageId (resolved to URL) and clears with null", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const assetId = (await s.as.mutation(api.inventory.addAsset, {
      name: "Green luggage",
      category: "transport",
      quantity: 1,
    })) as Id<"assets">;

    const storageId = await storeBlob(t);
    await s.as.mutation(api.inventory.setAssetPhoto, {
      assetId,
      photoStorageId: storageId,
    });
    let asset = (await s.as.query(api.inventory.listAssets, {}))[0];
    expect(asset.photoStorageId).toBe(storageId);
    expect(asset.photoUrl).toBeTruthy();

    await s.as.mutation(api.inventory.setAssetPhoto, {
      assetId,
      photoStorageId: null,
    });
    asset = (await s.as.query(api.inventory.listAssets, {}))[0];
    expect(asset.photoStorageId).toBeUndefined();
    expect(asset.photoUrl).toBeNull();
  });
});

describe("reservations", () => {
  test("listAssets computes available + overbooked across events", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventA = await seedEvent(s);
    const eventB = await seedEvent(s);
    const assetId = (await s.as.mutation(api.inventory.addAsset, {
      name: "SM58 mic",
      category: "audio",
      quantity: 5,
    })) as Id<"assets">;

    // Event A claims 2 of 5 → available 3, not overbooked.
    await s.as.mutation(api.inventory.reserveAsset, {
      eventId: eventA,
      assetId,
      quantity: 2,
    });
    let asset = (await s.as.query(api.inventory.listAssets, {}))[0];
    expect(asset.reservedLive).toBe(2);
    expect(asset.available).toBe(3);
    expect(asset.overbooked).toBe(false);

    // Event B claims 4 more → 6 > 5 → overbooked, available floored at 0.
    await s.as.mutation(api.inventory.reserveAsset, {
      eventId: eventB,
      assetId,
      quantity: 4,
    });
    asset = (await s.as.query(api.inventory.listAssets, {}))[0];
    expect(asset.reservedLive).toBe(6);
    expect(asset.available).toBe(0);
    expect(asset.overbooked).toBe(true);
  });

  test("reserveAsset UPSERTS — second reserve of same asset+event updates, no duplicate", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    const assetId = (await s.as.mutation(api.inventory.addAsset, {
      name: "Cable",
      category: "cabling",
      quantity: 10,
    })) as Id<"assets">;

    await s.as.mutation(api.inventory.reserveAsset, {
      eventId,
      assetId,
      quantity: 3,
      note: "XLR",
    });
    await s.as.mutation(api.inventory.reserveAsset, {
      eventId,
      assetId,
      quantity: 7,
      note: "XLR + quarter-inch",
    });

    // One reservation row for this (asset, event), updated to the latest values.
    const rows = await s.as.query(api.inventory.listEventReservations, {
      eventId,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].quantity).toBe(7);
    expect(rows[0].note).toBe("XLR + quarter-inch");

    const asset = (await s.as.query(api.inventory.listAssets, {}))[0];
    expect(asset.reservedLive).toBe(7);
    expect(asset.available).toBe(3);
  });

  test("overbooking counts only LIVE events; a completed event releases its hold", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventA = await seedEvent(s, "planning");
    const eventB = await seedEvent(s, "planning");
    const assetId = (await s.as.mutation(api.inventory.addAsset, {
      name: "200W battery",
      category: "power",
      quantity: 1,
    })) as Id<"assets">;

    await s.as.mutation(api.inventory.reserveAsset, {
      eventId: eventA,
      assetId,
      quantity: 1,
    });
    await s.as.mutation(api.inventory.reserveAsset, {
      eventId: eventB,
      assetId,
      quantity: 1,
    });

    // Two live (planning) events both hold the one battery → overbooked.
    let asset = (await s.as.query(api.inventory.listAssets, {}))[0];
    expect(asset.reservedLive).toBe(2);
    expect(asset.overbooked).toBe(true);

    // Complete event B → its reservation drops out of the live sum.
    await setEventStatus(s, eventB, "completed");
    asset = (await s.as.query(api.inventory.listAssets, {}))[0];
    expect(asset.reservedLive).toBe(1);
    expect(asset.overbooked).toBe(false);
    expect(asset.available).toBe(0);

    // Cancelling the other one too releases the last hold.
    await setEventStatus(s, eventA, "cancelled");
    asset = (await s.as.query(api.inventory.listAssets, {}))[0];
    expect(asset.reservedLive).toBe(0);
    expect(asset.available).toBe(1);
  });

  test("listEventReservations joins asset info incl. chapter-wide overbooked", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventA = await seedEvent(s);
    const eventB = await seedEvent(s);
    const assetId = (await s.as.mutation(api.inventory.addAsset, {
      name: "200W battery",
      category: "power",
      quantity: 1,
    })) as Id<"assets">;
    await s.as.mutation(api.inventory.reserveAsset, {
      eventId: eventA,
      assetId,
      quantity: 1,
    });
    await s.as.mutation(api.inventory.reserveAsset, {
      eventId: eventB,
      assetId,
      quantity: 1,
    });

    const rows = await s.as.query(api.inventory.listEventReservations, {
      eventId: eventA,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].asset).not.toBeNull();
    expect(rows[0].asset!.name).toBe("200W battery");
    expect(rows[0].asset!.category).toBe("power");
    // Chapter-wide: two events want the one battery → overbooked flagged here too.
    expect(rows[0].asset!.overbooked).toBe(true);
    expect(rows[0].asset!.available).toBe(0);
  });

  test("updateReservation + removeReservation", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    const assetId = (await s.as.mutation(api.inventory.addAsset, {
      name: "Cable",
      category: "cabling",
      quantity: 10,
    })) as Id<"assets">;
    const reservationId = (await s.as.mutation(api.inventory.reserveAsset, {
      eventId,
      assetId,
      quantity: 2,
    })) as Id<"assetReservations">;

    await s.as.mutation(api.inventory.updateReservation, {
      reservationId,
      quantity: 5,
      note: "day-of",
    });
    let rows = await s.as.query(api.inventory.listEventReservations, {
      eventId,
    });
    expect(rows[0].quantity).toBe(5);
    expect(rows[0].note).toBe("day-of");

    await s.as.mutation(api.inventory.removeReservation, { reservationId });
    rows = await s.as.query(api.inventory.listEventReservations, { eventId });
    expect(rows).toHaveLength(0);
  });

  test("reserveAsset rejects 0 / negative / non-integer quantity", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    const assetId = (await s.as.mutation(api.inventory.addAsset, {
      name: "Mixer",
      category: "audio",
      quantity: 5,
    })) as Id<"assets">;

    for (const quantity of [0, -2, 1.5]) {
      await expect(
        s.as.mutation(api.inventory.reserveAsset, {
          eventId,
          assetId,
          quantity,
        }),
      ).rejects.toThrow();
    }
    // updateReservation validates too.
    const reservationId = (await s.as.mutation(api.inventory.reserveAsset, {
      eventId,
      assetId,
      quantity: 1,
    })) as Id<"assetReservations">;
    await expect(
      s.as.mutation(api.inventory.updateReservation, {
        reservationId,
        quantity: 0,
      }),
    ).rejects.toThrow();
  });

  test("removeAsset cascade-deletes its reservations", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    const assetId = (await s.as.mutation(api.inventory.addAsset, {
      name: "200W battery",
      category: "power",
      quantity: 2,
    })) as Id<"assets">;
    await s.as.mutation(api.inventory.reserveAsset, {
      eventId,
      assetId,
      quantity: 1,
    });

    expect(
      await s.as.query(api.inventory.listEventReservations, { eventId }),
    ).toHaveLength(1);

    await s.as.mutation(api.inventory.removeAsset, { assetId });

    // Asset gone; its reservation cascaded away (no orphan on the event view).
    expect(await s.as.query(api.inventory.listAssets, {})).toHaveLength(0);
    expect(
      await s.as.query(api.inventory.listEventReservations, { eventId }),
    ).toHaveLength(0);
  });
});

describe("cross-chapter + access gating", () => {
  test("cross-chapter reservation is rejected (own event, other chapter's asset)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const assetId = (await s.as.mutation(api.inventory.addAsset, {
      name: "200W battery",
      category: "power",
      quantity: 2,
    })) as Id<"assets">;

    // A second chapter with its own event tries to reserve OUR asset.
    const other = await setupChapter(t, {
      email: "outsider@publicworship.life",
      chapterName: "Boston",
    });
    const otherEvent = await seedEvent(other);
    await expect(
      other.as.mutation(api.inventory.reserveAsset, {
        eventId: otherEvent,
        assetId,
        quantity: 1,
      }),
    ).rejects.toThrow();
  });

  test("rejects a cross-chapter admin and an unauthenticated caller", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    const assetId = (await s.as.mutation(api.inventory.addAsset, {
      name: "Mixer",
      category: "audio",
      quantity: 3,
    })) as Id<"assets">;
    const reservationId = (await s.as.mutation(api.inventory.reserveAsset, {
      eventId,
      assetId,
      quantity: 1,
    })) as Id<"assetReservations">;

    const other = await setupChapter(t, {
      email: "outsider@publicworship.life",
      chapterName: "Boston",
    });
    // Cross-chapter admin can't touch our asset, reservation, or event view.
    await expect(
      other.as.mutation(api.inventory.updateAsset, {
        assetId,
        name: "Hijacked",
      }),
    ).rejects.toThrow();
    await expect(
      other.as.mutation(api.inventory.setAssetPhoto, {
        assetId,
        photoStorageId: null,
      }),
    ).rejects.toThrow();
    await expect(
      other.as.mutation(api.inventory.removeAsset, { assetId }),
    ).rejects.toThrow();
    await expect(
      other.as.mutation(api.inventory.reserveAsset, {
        eventId,
        assetId,
        quantity: 1,
      }),
    ).rejects.toThrow();
    await expect(
      other.as.mutation(api.inventory.updateReservation, {
        reservationId,
        quantity: 2,
      }),
    ).rejects.toThrow();
    await expect(
      other.as.mutation(api.inventory.removeReservation, { reservationId }),
    ).rejects.toThrow();
    await expect(
      other.as.query(api.inventory.listEventReservations, { eventId }),
    ).rejects.toThrow();
    // The cross-chapter admin sees their OWN (empty) registry, never ours.
    expect(await other.as.query(api.inventory.listAssets, {})).toHaveLength(0);

    // Unauthenticated is rejected on queries + mutations.
    await expect(t.query(api.inventory.listAssets, {})).rejects.toThrow();
    await expect(
      t.query(api.inventory.listEventReservations, { eventId }),
    ).rejects.toThrow();
    await expect(
      t.mutation(api.inventory.addAsset, {
        name: "Anon",
        category: "other",
        quantity: 1,
      }),
    ).rejects.toThrow();
    await expect(
      t.mutation(api.inventory.reserveAsset, {
        eventId,
        assetId,
        quantity: 1,
      }),
    ).rejects.toThrow();

    // Everything still intact.
    const assets = await s.as.query(api.inventory.listAssets, {});
    expect(assets).toHaveLength(1);
    expect(assets[0].name).toBe("Mixer");
    const rows = await s.as.query(api.inventory.listEventReservations, {
      eventId,
    });
    expect(rows).toHaveLength(1);
  });
});
