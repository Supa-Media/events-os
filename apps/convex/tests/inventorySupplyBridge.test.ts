import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import type { Id } from "../_generated/dataModel";

/**
 * Supplies ⇄ Inventory bridge (docs/plans/inventory-supplies-unification.md):
 *   - a supply row with Source = Chapter Storage + linkedAssetId UPSERTs an
 *     assetReservation (qty + container) — reserving is a byproduct of listing,
 *   - Status is DERIVED: packed → Have it; storage+available → Pull from storage;
 *     consumable out of stock → Need to buy; borrowed → Need to pick up,
 *   - a shared asset held by ANOTHER live event shows as reserved_elsewhere with
 *     an "Event · Container" detail,
 *   - a manual status pick becomes the override (and reverts on null),
 *   - unlinking / deleting the row releases the reservation.
 */

async function seedEvent(
  s: ChapterSetup,
  name: string,
): Promise<Id<"events">> {
  return await run(s.t, async (ctx) => {
    const now = Date.now();
    const eventTypeId = await ctx.db.insert("eventTypes", {
      chapterId: s.chapterId,
      name: "T",
      slug: `t-${name}`,
      version: 1,
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
    });
    return await ctx.db.insert("events", {
      chapterId: s.chapterId,
      eventTypeId,
      templateVersion: 1,
      name,
      eventDate: now + 7 * 24 * 60 * 60 * 1000,
      status: "planning",
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
    });
  });
}

async function addSupply(
  s: ChapterSetup,
  eventId: Id<"events">,
  fields: Record<string, unknown>,
  title = "Speaker",
): Promise<Id<"eventItems">> {
  return (await s.as.mutation(api.items.addEventItem, {
    eventId,
    module: "supplies",
    title,
    fields,
  })) as Id<"eventItems">;
}

async function supplyStatus(
  s: ChapterSetup,
  eventId: Id<"events">,
  itemId: Id<"eventItems">,
): Promise<{ status?: string | null; statusDetail?: string | null }> {
  const res = await s.as.query(api.items.listForEventModule, {
    eventId,
    module: "supplies",
  });
  const it = res.items.find((i: any) => i._id === itemId) as any;
  return { status: it?.status, statusDetail: it?.statusDetail };
}

describe("supplies ⇄ inventory bridge", () => {
  test("Chapter-Storage link reserves the asset; status derives from availability", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s, "Worship Night");
    const speaker = (await s.as.mutation(api.inventory.addAsset, {
      name: "ALTO Speaker",
      tags: ["audio"],
      quantity: 1,
    })) as Id<"assets">;

    const item = await addSupply(s, eventId, {
      source: "chapter_storage",
      linkedAssetId: speaker,
      qty: 1,
    });

    // A reservation now exists on the asset (reserving is a byproduct).
    const assets = await s.as.query(api.inventory.listAssets, {});
    const a = assets.find((x) => x._id === speaker)!;
    expect(a.reservedLive).toBe(1);
    expect(a.available).toBe(0);
    expect(a.heldBy.map((h) => h.eventName)).toContain("Worship Night");

    // Not packed + available → Pull from storage.
    expect((await supplyStatus(s, eventId, item)).status).toBe("pull_from_storage");
  });

  test("packed → Have it (overrides the source-derived value)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s, "Gala");
    const mic = (await s.as.mutation(api.inventory.addAsset, {
      name: "SM58",
      tags: ["audio"],
      quantity: 4,
    })) as Id<"assets">;
    const item = await addSupply(s, eventId, {
      source: "chapter_storage",
      linkedAssetId: mic,
      qty: 2,
      container: "green_luggage",
    });
    expect((await supplyStatus(s, eventId, item)).status).toBe("have_it");
  });

  test("a shared asset held by another live event reads as reserved_elsewhere", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventA = await seedEvent(s, "Event One");
    const eventB = await seedEvent(s, "Event Two");
    const battery = (await s.as.mutation(api.inventory.addAsset, {
      name: "200W Battery",
      tags: ["power"],
      quantity: 1,
    })) as Id<"assets">;

    // Event One takes it and packs it in green luggage.
    await addSupply(s, eventA, {
      source: "chapter_storage",
      linkedAssetId: battery,
      qty: 1,
      container: "green_luggage",
    });
    // Event Two wants the same battery (not packed).
    const bItem = await addSupply(s, eventB, {
      source: "chapter_storage",
      linkedAssetId: battery,
      qty: 1,
    });

    const { status, statusDetail } = await supplyStatus(s, eventB, bItem);
    expect(status).toBe("reserved_elsewhere");
    expect(statusDetail).toContain("Event One");
    expect(statusDetail).toContain("Green luggage");
  });

  test("consumable out of stock → Need to buy; borrowed → Need to pick up", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s, "Picnic");
    const tape = (await s.as.mutation(api.inventory.addAsset, {
      name: "Gaffer tape",
      tags: ["staging"],
      quantity: 0,
      consumable: true,
    })) as Id<"assets">;
    const tapeItem = await addSupply(
      s,
      eventId,
      { source: "chapter_storage", linkedAssetId: tape, qty: 1 },
      "Tape",
    );
    expect((await supplyStatus(s, eventId, tapeItem)).status).toBe("need_to_buy");

    const borrowed = await addSupply(
      s,
      eventId,
      { source: "borrowed", lentBy: "Pastor Mike", qty: 1 },
      "Extension cord",
    );
    expect((await supplyStatus(s, eventId, borrowed)).status).toBe(
      "need_to_pick_up",
    );
  });

  test("manual status pick overrides derivation; null reverts to auto", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s, "Retreat");
    const stand = (await s.as.mutation(api.inventory.addAsset, {
      name: "Mic stand",
      tags: ["audio"],
      quantity: 3,
    })) as Id<"assets">;
    const item = await addSupply(s, eventId, {
      source: "chapter_storage",
      linkedAssetId: stand,
      qty: 1,
    });
    // Auto = pull_from_storage; force "have_it".
    await s.as.mutation(api.items.setStatus, { itemId: item, status: "have_it" });
    expect((await supplyStatus(s, eventId, item)).status).toBe("have_it");
    // Clear → back to auto.
    await s.as.mutation(api.items.setStatus, { itemId: item, status: null });
    expect((await supplyStatus(s, eventId, item)).status).toBe(
      "pull_from_storage",
    );
  });

  test("deleting the supply row releases its reservation", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s, "Concert");
    const sub = (await s.as.mutation(api.inventory.addAsset, {
      name: "Subwoofer",
      tags: ["audio"],
      quantity: 1,
    })) as Id<"assets">;
    const item = await addSupply(s, eventId, {
      source: "chapter_storage",
      linkedAssetId: sub,
      qty: 1,
    });
    let a = (await s.as.query(api.inventory.listAssets, {})).find(
      (x) => x._id === sub,
    )!;
    expect(a.reservedLive).toBe(1);

    await s.as.mutation(api.items.removeEventItem, { itemId: item });
    a = (await s.as.query(api.inventory.listAssets, {})).find(
      (x) => x._id === sub,
    )!;
    expect(a.reservedLive).toBe(0);
  });
});
