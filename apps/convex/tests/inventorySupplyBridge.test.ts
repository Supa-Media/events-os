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

async function reservedLive(
  s: ChapterSetup,
  assetId: Id<"assets">,
): Promise<number> {
  const a = (await s.as.query(api.inventory.listAssets, {})).find(
    (x) => x._id === assetId,
  );
  return a?.reservedLive ?? 0;
}

async function supplyFields(
  s: ChapterSetup,
  itemId: Id<"eventItems">,
): Promise<Record<string, any>> {
  return await run(s.t, async (ctx) => (await ctx.db.get(itemId))?.fields ?? {});
}

describe("linkSupplyToAsset", () => {
  test("links + reserves, and sets Source when the row had none", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s, "Worship Night");
    const mixer = (await s.as.mutation(api.inventory.addAsset, {
      name: "Mixer",
      tags: ["audio"],
      quantity: 1,
    })) as Id<"assets">;
    const item = await addSupply(s, eventId, { qty: 1 }, "Mixer");

    await s.as.mutation(api.items.linkSupplyToAsset, {
      itemId: item,
      assetId: mixer,
    });
    expect(await reservedLive(s, mixer)).toBe(1);
    const fields = await supplyFields(s, item);
    expect(fields.linkedAssetId).toBe(mixer);
    expect(fields.source).toBe("chapter_storage");
    expect((await supplyStatus(s, eventId, item)).status).toBe(
      "pull_from_storage",
    );
  });

  test("legacy 'storage' source stays untouched but still reserves", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s, "Legacy Night");
    const cable = (await s.as.mutation(api.inventory.addAsset, {
      name: "XLR Cabling",
      tags: ["cabling"],
      quantity: 4,
    })) as Id<"assets">;
    // A pre-cutover row: its cloned option set still uses the retired value.
    const item = await addSupply(s, eventId, { source: "storage", qty: 4 });

    await s.as.mutation(api.items.linkSupplyToAsset, {
      itemId: item,
      assetId: cable,
    });
    const fields = await supplyFields(s, item);
    expect(fields.source).toBe("storage");
    expect(fields.linkedAssetId).toBe(cable);
    expect(await reservedLive(s, cable)).toBe(4);
    expect((await supplyStatus(s, eventId, item)).status).toBe(
      "pull_from_storage",
    );
  });

  test("re-link moves the reservation; null unlinks and releases", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s, "Gala");
    const a1 = (await s.as.mutation(api.inventory.addAsset, {
      name: "Speaker A",
      quantity: 1,
    })) as Id<"assets">;
    const a2 = (await s.as.mutation(api.inventory.addAsset, {
      name: "Speaker B",
      quantity: 1,
    })) as Id<"assets">;
    const item = await addSupply(s, eventId, {
      source: "chapter_storage",
      linkedAssetId: a1,
      qty: 1,
    });
    expect(await reservedLive(s, a1)).toBe(1);

    await s.as.mutation(api.items.linkSupplyToAsset, {
      itemId: item,
      assetId: a2,
    });
    expect(await reservedLive(s, a1)).toBe(0);
    expect(await reservedLive(s, a2)).toBe(1);

    await s.as.mutation(api.items.linkSupplyToAsset, {
      itemId: item,
      assetId: null,
    });
    expect(await reservedLive(s, a2)).toBe(0);
    expect((await supplyFields(s, item)).linkedAssetId).toBeUndefined();
  });

  test("rejects an asset from another chapter", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const other = await setupChapter(t, {
      email: "other@publicworship.life",
      chapterName: "Chicago",
    });
    const eventId = await seedEvent(s, "Retreat");
    const foreign = (await other.as.mutation(api.inventory.addAsset, {
      name: "Their speaker",
      quantity: 1,
    })) as Id<"assets">;
    const item = await addSupply(s, eventId, { qty: 1 });

    await expect(
      s.as.mutation(api.items.linkSupplyToAsset, {
        itemId: item,
        assetId: foreign,
      }),
    ).rejects.toThrow(/not found/i);
  });
});

describe("createAssetFromSupply", () => {
  test("defaults name/qty/photo from the row, links + reserves", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s, "Concert");
    const photo = await storeBlob(t);
    const item = await addSupply(
      s,
      eventId,
      { source: "buy_in_store", qty: 2, photo },
      "Battery Charger",
    );

    const { assetId } = await s.as.mutation(api.items.createAssetFromSupply, {
      itemId: item,
    });
    const asset = await run(s.t, (ctx) => ctx.db.get(assetId));
    expect(asset).toMatchObject({
      name: "Battery Charger",
      quantity: 2,
      acquired: true,
      consumable: false,
      photoStorageId: photo,
    });
    const fields = await supplyFields(s, item);
    expect(fields.linkedAssetId).toBe(assetId);
    // Promotion flips an acquired row onto the inventory-backed source.
    expect(fields.source).toBe("chapter_storage");
    // This event immediately holds its own copy.
    expect(await reservedLive(s, assetId)).toBe(2);
  });

  test("explicit args win; a legacy http photo URL is not copied", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s, "Picnic");
    const item = await addSupply(
      s,
      eventId,
      { qty: 1, photo: "https://example.com/pic.png" },
      "Cups",
    );

    const { assetId } = await s.as.mutation(api.items.createAssetFromSupply, {
      itemId: item,
      name: "Paper cups",
      quantity: 200,
      tags: ["consumables"],
      consumable: true,
    });
    const asset = await run(s.t, (ctx) => ctx.db.get(assetId));
    expect(asset).toMatchObject({
      name: "Paper cups",
      quantity: 200,
      consumable: true,
      tags: ["consumables"],
    });
    expect(asset?.photoStorageId).toBeUndefined();
  });

  test("blank name throws", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s, "Setup");
    const item = await addSupply(s, eventId, { qty: 1 }, "");
    await expect(
      s.as.mutation(api.items.createAssetFromSupply, { itemId: item }),
    ).rejects.toThrow(/needs a name/i);
  });
});

describe("source switch-away clears the link", () => {
  test("leaving chapter_storage releases the reservation AND drops the link", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s, "Worship Night");
    const speaker = (await s.as.mutation(api.inventory.addAsset, {
      name: "ALTO Speaker",
      quantity: 1,
    })) as Id<"assets">;
    const item = await addSupply(s, eventId, {
      source: "chapter_storage",
      linkedAssetId: speaker,
      qty: 1,
    });
    expect(await reservedLive(s, speaker)).toBe(1);

    await s.as.mutation(api.items.updateEventItem, {
      itemId: item,
      fields: { source: "buy_in_store" },
    });
    expect(await reservedLive(s, speaker)).toBe(0);
    expect((await supplyFields(s, item)).linkedAssetId).toBeUndefined();

    // Switching back does NOT silently re-reserve the old asset.
    await s.as.mutation(api.items.updateEventItem, {
      itemId: item,
      fields: { source: "chapter_storage" },
    });
    expect(await reservedLive(s, speaker)).toBe(0);
  });
});

describe("listForEventModule linkedAsset payload", () => {
  test("linked rows expose the asset identity + availability; others null", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s, "Worship Night");
    const mic = (await s.as.mutation(api.inventory.addAsset, {
      name: "SM58",
      quantity: 4,
    })) as Id<"assets">;
    const linked = await addSupply(s, eventId, {
      source: "chapter_storage",
      linkedAssetId: mic,
      qty: 2,
    });
    const plain = await addSupply(s, eventId, { source: "buy_in_store" }, "Ice");

    const res = await s.as.query(api.items.listForEventModule, {
      eventId,
      module: "supplies",
    });
    const linkedRow = res.items.find((i: any) => i._id === linked) as any;
    expect(linkedRow.linkedAsset).toMatchObject({
      _id: mic,
      name: "SM58",
      onHand: 4,
      available: 4, // other events hold nothing
      consumable: false,
    });
    const plainRow = res.items.find((i: any) => i._id === plain) as any;
    expect(plainRow.linkedAsset).toBeNull();
  });
});
