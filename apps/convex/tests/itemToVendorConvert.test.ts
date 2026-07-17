/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { api } from "../_generated/api";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import type { Id } from "../_generated/dataModel";

/**
 * `items.convertItemToVendor` (PR4.5a, backend half of the Money-page grid's
 * guided "change Type → Vendor" flow): converts an eventItem into a paid
 * vendor engagement — creating the engagement (cost carried into `amountUsd`,
 * title → `service`, `budgetCategoryId` carried) and deleting the item with
 * `removeEventItem`'s full side effects, in one transaction. Mirrors
 * `convertEventItemModule`'s (#229) cost-carry contract and refusal code.
 */

const EVENT_DATE = new Date(2026, 6, 27, 17, 5).getTime();

async function seedEvent(s: ChapterSetup): Promise<Id<"events">> {
  const { t, chapterId, userId } = s;
  return await run(t, async (ctx) => {
    const now = Date.now();
    const eventTypeId = await ctx.db.insert("eventTypes", {
      chapterId,
      name: "T",
      slug: `t-${Math.random().toString(36).slice(2)}`,
      version: 1,
      isArchived: false,
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    });
    return await ctx.db.insert("events", {
      chapterId,
      eventTypeId,
      templateVersion: 1,
      name: "Gala",
      eventDate: EVENT_DATE,
      status: "planning",
      disabledCoreModules: [],
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    });
  });
}

type ColSpec = { key: string; type: string; order: number };

async function seedColumns(
  s: ChapterSetup,
  eventId: Id<"events">,
  module: string,
  cols: ColSpec[],
): Promise<void> {
  await run(s.t, async (ctx) => {
    for (const c of cols) {
      await ctx.db.insert("eventColumns", {
        eventId,
        module,
        key: c.key,
        label: c.key,
        kind: "custom",
        type: c.type as any,
        isVisible: true,
        order: c.order,
      });
    }
  });
}

async function seedItem(
  s: ChapterSetup,
  eventId: Id<"events">,
  overrides: Partial<{
    module: string;
    title: string;
    order: number;
    budgetCategoryId: Id<"budgetCategories">;
    fields: Record<string, unknown>;
  }> = {},
): Promise<Id<"eventItems">> {
  const { t, chapterId } = s;
  return await run(t, async (ctx) => {
    return await ctx.db.insert("eventItems", {
      eventId,
      chapterId,
      module: overrides.module ?? "planning_doc",
      title: overrides.title ?? "Book DJ",
      order: overrides.order ?? 0,
      budgetCategoryId: overrides.budgetCategoryId,
      fields: overrides.fields,
    });
  });
}

async function seedPerson(s: ChapterSetup, name = "Alex"): Promise<Id<"people">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name,
      status: "active",
      createdAt: Date.now(),
    }),
  );
}

async function seedCategory(s: ChapterSetup): Promise<Id<"budgetCategories">> {
  const fundId = await run(s.t, (ctx) =>
    ctx.db.insert("funds", {
      chapterId: s.chapterId,
      name: "General",
      restriction: "unrestricted",
      sortOrder: 0,
      createdAt: Date.now(),
    }),
  );
  return await run(s.t, (ctx) =>
    ctx.db.insert("budgetCategories", {
      chapterId: s.chapterId,
      fundId,
      name: "Ops",
      kind: "lineItem",
      isActive: true,
      createdAt: Date.now(),
    }),
  );
}

async function getItem(s: ChapterSetup, itemId: Id<"eventItems">) {
  return await run(s.t, (ctx) => ctx.db.get(itemId));
}

async function engagementsForEvent(s: ChapterSetup, eventId: Id<"events">) {
  return await run(s.t, (ctx) =>
    ctx.db
      .query("engagements")
      .withIndex("by_event", (q) => q.eq("eventId", eventId))
      .collect(),
  );
}

async function convert(
  s: ChapterSetup,
  itemId: Id<"eventItems">,
  personId: Id<"people">,
) {
  return await s.as.mutation(api.items.convertItemToVendor, {
    itemId,
    personId,
  });
}

describe("convertItemToVendor", () => {
  test("happy path: title → service, cost → amountUsd, budgetCategoryId carried, item gone, engagement present", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    await seedColumns(s, eventId, "planning_doc", [
      { key: "cost", type: "currency", order: 0 },
    ]);
    const person = await seedPerson(s, "Sam the DJ");
    const categoryId = await seedCategory(s);
    const itemId = await seedItem(s, eventId, {
      module: "planning_doc",
      title: "Book DJ",
      budgetCategoryId: categoryId,
      fields: { cost: 500 },
    });

    const result = await convert(s, itemId, person);
    expect(result.engagementId).not.toBeNull();

    const engagement = await run(t, (ctx) =>
      ctx.db.get(result.engagementId as Id<"engagements">),
    );
    expect(engagement).toMatchObject({
      eventId,
      chapterId: s.chapterId,
      personId: person,
      type: "paid",
      service: "Book DJ",
      status: "invited",
      amountUsd: 500,
      paymentStatus: "unpaid",
      budgetCategoryId: categoryId,
    });

    expect(await getItem(s, itemId)).toBeNull();
  });

  test("supplies item: reservation released + placements deleted", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    const asset = (await s.as.mutation(api.inventory.addAsset, {
      name: "Speaker",
      quantity: 2,
    })) as Id<"assets">;
    const itemId = (await s.as.mutation(api.items.addEventItem, {
      eventId,
      module: "supplies",
      title: "Speaker rental",
      fields: { source: "chapter_storage", linkedAssetId: asset, qty: 1 },
    })) as Id<"eventItems">;
    await run(t, async (ctx) => {
      await ctx.db.insert("siteMapPlacements", {
        chapterId: s.chapterId,
        eventId,
        kind: "supply",
        refId: String(itemId),
        x: 0.5,
        y: 0.5,
        createdAt: Date.now(),
      });
    });

    const person = await seedPerson(s);
    const result = await convert(s, itemId, person);
    expect(result.engagementId).not.toBeNull();

    const reservation = await run(t, (ctx) =>
      ctx.db
        .query("assetReservations")
        .withIndex("by_asset_event", (q) =>
          q.eq("assetId", asset).eq("eventId", eventId),
        )
        .unique(),
    );
    expect(reservation).toBeNull();

    const placements = await run(t, (ctx) =>
      ctx.db
        .query("siteMapPlacements")
        .withIndex("by_event_kind", (q) =>
          q.eq("eventId", eventId).eq("kind", "supply"),
        )
        .collect(),
    );
    expect(placements.filter((p) => p.refId === String(itemId))).toHaveLength(0);
    expect(await getItem(s, itemId)).toBeNull();
  });

  test("cross-chapter person is rejected", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    const itemId = await seedItem(s, eventId);

    const other = await setupChapter(t, {
      email: "other@publicworship.life",
      chapterName: "Boston",
    });
    const otherPerson = await seedPerson(other, "Outsider");

    await expect(convert(s, itemId, otherPerson)).rejects.toBeInstanceOf(
      ConvexError,
    );

    expect(await getItem(s, itemId)).not.toBeNull();
    expect(await engagementsForEvent(s, eventId)).toHaveLength(0);
  });

  test("unauthorized caller (different chapter) is rejected", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    const itemId = await seedItem(s, eventId);
    const person = await seedPerson(s);

    const other = await setupChapter(t, {
      email: "other@publicworship.life",
      chapterName: "Boston",
    });

    await expect(
      other.as.mutation(api.items.convertItemToVendor, {
        itemId,
        personId: person,
      }),
    ).rejects.toBeInstanceOf(ConvexError);

    expect(await getItem(s, itemId)).not.toBeNull();
    expect(await engagementsForEvent(s, eventId)).toHaveLength(0);
  });

  test("MULTI_COST_CONVERSION: an item with more than one cost value is refused (atomic — item untouched, no engagement created)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    await seedColumns(s, eventId, "comms", [
      { key: "cost", type: "currency", order: 0 },
      { key: "fee", type: "currency", order: 1 },
    ]);
    const person = await seedPerson(s);
    const itemId = await seedItem(s, eventId, {
      module: "comms",
      fields: { cost: 100, fee: 20 },
    });

    let caught: unknown;
    try {
      await convert(s, itemId, person);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConvexError);
    expect((caught as ConvexError<{ code: string }>).data.code).toBe(
      "MULTI_COST_CONVERSION",
    );

    const item = await getItem(s, itemId);
    expect(item?.module).toBe("comms");
    expect(item?.fields?.cost).toBe(100);
    expect(item?.fields?.fee).toBe(20);
    expect(await engagementsForEvent(s, eventId)).toHaveLength(0);
  });

  test("no-cost item converts with amountUsd left undefined", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    const person = await seedPerson(s);
    const itemId = await seedItem(s, eventId, {
      module: "planning_doc",
      title: "Set up chairs",
      fields: {},
    });

    const result = await convert(s, itemId, person);
    const engagement = await run(t, (ctx) =>
      ctx.db.get(result.engagementId as Id<"engagements">),
    );
    expect(engagement?.amountUsd).toBeUndefined();
    expect(engagement?.type).toBe("paid");
    expect(await getItem(s, itemId)).toBeNull();
  });

  test("a missing item no-ops (matches convertEventItemModule's idiom): returns a null engagementId, doesn't throw", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    const itemId = await seedItem(s, eventId);
    const person = await seedPerson(s);
    // Delete the item out from under the mutation.
    await run(t, (ctx) => ctx.db.delete(itemId));

    const result = await convert(s, itemId, person);
    expect(result.engagementId).toBeNull();
    expect(await engagementsForEvent(s, eventId)).toHaveLength(0);
  });
});
