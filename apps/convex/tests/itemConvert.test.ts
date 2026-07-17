/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import {
  computeDueDate,
  TASK_STATUS_OPTIONS,
  COMMS_STATUS_OPTIONS,
} from "@events-os/shared";
import { api } from "../_generated/api";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import type { Id } from "../_generated/dataModel";

/**
 * `items.convertEventItemModule` (PR3 of the Money-page "change Type"
 * feature): moves an eventItem between modules, preserving title/cost/owner/
 * timing where they still make sense and clearing what doesn't. See the
 * side-effect table in the function's own doc comment for the full contract.
 */

const EVENT_DATE = new Date(2026, 6, 27, 17, 5).getTime(); // Jul 27 2026, 17:05

async function seedEvent(
  s: ChapterSetup,
  opts: { disabledCoreModules?: string[] } = {},
): Promise<Id<"events">> {
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
      disabledCoreModules: opts.disabledCoreModules ?? [],
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    });
  });
}

type ColSpec = {
  key: string;
  type: string;
  order: number;
  options?: { value: string; label: string; color?: string; isComplete?: boolean }[];
};

/** Insert eventColumns rows for a module — full control over key/type/order,
 *  so tests can construct exact currency/status layouts without depending on
 *  the shared DEFAULT_COLUMNS index positions. */
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
        options: c.options,
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
    offsetDays: number;
    offsetMinutes: number;
    status: string;
    roleId: Id<"eventRoles">;
    ownerPersonId: Id<"people">;
    sourceTemplateItemId: Id<"templateItems">;
    prePlanColumns: string[];
    prePlanChecked: string[];
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
      offsetDays: overrides.offsetDays,
      offsetMinutes: overrides.offsetMinutes,
      dueDate:
        overrides.offsetDays !== undefined
          ? computeDueDate(EVENT_DATE, overrides.offsetDays)
          : undefined,
      status: overrides.status,
      roleId: overrides.roleId,
      ownerPersonId: overrides.ownerPersonId,
      sourceTemplateItemId: overrides.sourceTemplateItemId,
      prePlanColumns: overrides.prePlanColumns,
      prePlanChecked: overrides.prePlanChecked,
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

async function getItem(s: ChapterSetup, itemId: Id<"eventItems">) {
  return await run(s.t, (ctx) => ctx.db.get(itemId));
}

async function convert(
  s: ChapterSetup,
  itemId: Id<"eventItems">,
  toModule: string,
) {
  return await s.as.mutation(api.items.convertEventItemModule, {
    itemId,
    toModule,
  });
}

describe("convertEventItemModule", () => {
  test("task → supply round trip preserves title/cost/owner/offsetDays", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    await seedColumns(s, eventId, "planning_doc", [
      { key: "cost", type: "currency", order: 0 },
    ]);
    await seedColumns(s, eventId, "supplies", [
      { key: "cost", type: "currency", order: 0 },
    ]);
    const owner = await seedPerson(s);
    const itemId = await seedItem(s, eventId, {
      module: "planning_doc",
      title: "Book DJ",
      offsetDays: -14,
      ownerPersonId: owner,
      fields: { cost: 500 },
    });

    const forward = await convert(s, itemId, "supplies");
    expect(forward.costColKey).toBe("cost");

    let item = await getItem(s, itemId);
    expect(item?.module).toBe("supplies");
    expect(item?.title).toBe("Book DJ");
    expect(item?.fields?.cost).toBe(500);
    expect(item?.ownerPersonId).toBe(owner);
    expect(item?.offsetDays).toBe(-14);
    // supplies is also a day-offset module, so the due date is recomputed
    // (same math, but freshly derived — not just carried over).
    expect(item?.dueDate).toBe(computeDueDate(EVENT_DATE, -14));

    const back = await convert(s, itemId, "planning_doc");
    expect(back.costColKey).toBe("cost");
    item = await getItem(s, itemId);
    expect(item?.module).toBe("planning_doc");
    expect(item?.title).toBe("Book DJ");
    expect(item?.fields?.cost).toBe(500);
    expect(item?.ownerPersonId).toBe(owner);
    expect(item?.offsetDays).toBe(-14);
    expect(item?.dueDate).toBe(computeDueDate(EVENT_DATE, -14));
  });

  test("leaving supplies releases the reservation, deletes placements, and clears bridge fields", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    const asset = (await s.as.mutation(api.inventory.addAsset, {
      name: "Speaker",
      quantity: 2,
    })) as Id<"assets">;
    const itemId = await seedItem(s, eventId, {
      module: "supplies",
      title: "Speaker rental",
      fields: {
        source: "chapter_storage",
        linkedAssetId: asset,
        qty: 1,
        statusOverride: "have_it",
      },
    });
    // Reconcile a reservation for this row (mirrors what addEventItem does —
    // this test seeds the item directly, so do it explicitly).
    await run(t, async (ctx) => {
      await ctx.db.insert("assetReservations", {
        assetId: asset,
        eventId,
        chapterId: s.chapterId,
        quantity: 1,
        createdBy: s.userId,
        createdAt: Date.now(),
      });
    });
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

    await convert(s, itemId, "planning_doc");

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

    const item = await getItem(s, itemId);
    expect(item?.fields?.linkedAssetId).toBeUndefined();
    expect(item?.fields?.source).toBeUndefined();
    expect(item?.fields?.statusOverride).toBeUndefined();
  });

  test("entering supplies clears status (it's derived at read time)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    const itemId = await seedItem(s, eventId, {
      module: "planning_doc",
      status: "in_progress",
    });

    await convert(s, itemId, "supplies");

    const item = await getItem(s, itemId);
    expect(item?.status).toBeUndefined();
  });

  test("status is kept when valid on the target's status column, cleared otherwise", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    await seedColumns(s, eventId, "comms", [
      { key: "status", type: "status", order: 0, options: COMMS_STATUS_OPTIONS },
    ]);

    // "not_started" exists in both TASK and COMMS status option sets → kept.
    const keptId = await seedItem(s, eventId, {
      module: "planning_doc",
      status: "not_started",
    });
    await convert(s, keptId, "comms");
    expect((await getItem(s, keptId))?.status).toBe("not_started");

    // "in_progress" only exists in TASK_STATUS_OPTIONS, not comms → cleared.
    const clearedId = await seedItem(s, eventId, {
      module: "planning_doc",
      status: "in_progress",
    });
    expect(TASK_STATUS_OPTIONS.some((o) => o.value === "in_progress")).toBe(true);
    await convert(s, clearedId, "comms");
    expect((await getItem(s, clearedId))?.status).toBeUndefined();
  });

  test("due date recomputes for a day-offset target and clears for a non-day-offset one", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    const itemId = await seedItem(s, eventId, {
      module: "planning_doc",
      offsetDays: -14,
    });

    // run_of_show schedules in MINUTES, not days — not a day-offset module.
    await convert(s, itemId, "run_of_show");
    let item = await getItem(s, itemId);
    expect(item?.dueDate).toBeUndefined();
    // offsetDays itself is left as-is even though it's no longer meaningful.
    expect(item?.offsetDays).toBe(-14);

    // Converting back onto a day-offset module recomputes it from the kept offset.
    await convert(s, itemId, "supplies");
    item = await getItem(s, itemId);
    expect(item?.dueDate).toBe(computeDueDate(EVENT_DATE, -14));
  });

  test("a single cost value remaps to the target's lowest-order currency column, deleting the old key", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    await seedColumns(s, eventId, "comms", [
      { key: "budget", type: "currency", order: 0 },
    ]);
    await seedColumns(s, eventId, "supplies", [
      { key: "cost", type: "currency", order: 9 },
      { key: "extraCost", type: "currency", order: 2 },
    ]);
    const itemId = await seedItem(s, eventId, {
      module: "comms",
      fields: { budget: 250 },
    });

    const result = await convert(s, itemId, "supplies");
    expect(result.costColKey).toBe("extraCost");

    const item = await getItem(s, itemId);
    expect(item?.fields?.extraCost).toBe(250);
    expect(item?.fields?.cost).toBeUndefined();
    expect(item?.fields?.budget).toBeUndefined();
  });

  test("a cost value whose key already exists on the target is kept as-is", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    await seedColumns(s, eventId, "planning_doc", [
      { key: "cost", type: "currency", order: 0 },
    ]);
    await seedColumns(s, eventId, "supplies", [
      { key: "cost", type: "currency", order: 0 },
    ]);
    const itemId = await seedItem(s, eventId, {
      module: "planning_doc",
      fields: { cost: 75 },
    });

    const result = await convert(s, itemId, "supplies");
    expect(result.costColKey).toBe("cost");
    expect((await getItem(s, itemId))?.fields?.cost).toBe(75);
  });

  test("MULTI_COST_CONVERSION: multiple cost values without matching target columns are refused", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    await seedColumns(s, eventId, "comms", [
      { key: "cost", type: "currency", order: 0 },
      { key: "fee", type: "currency", order: 1 },
    ]);
    await seedColumns(s, eventId, "planning_doc", [
      { key: "cost", type: "currency", order: 0 },
    ]);
    const itemId = await seedItem(s, eventId, {
      module: "comms",
      fields: { cost: 100, fee: 20 },
    });

    let caught: unknown;
    try {
      await convert(s, itemId, "planning_doc");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConvexError);
    expect((caught as ConvexError<{ code: string }>).data.code).toBe(
      "MULTI_COST_CONVERSION",
    );

    // Nothing was written.
    const item = await getItem(s, itemId);
    expect(item?.module).toBe("comms");
    expect(item?.fields?.cost).toBe(100);
    expect(item?.fields?.fee).toBe(20);
  });

  test("multiple cost values that ALL exist on the target convert without refusal (ambiguous costColKey → null)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    await seedColumns(s, eventId, "comms", [
      { key: "cost", type: "currency", order: 0 },
      { key: "fee", type: "currency", order: 1 },
    ]);
    await seedColumns(s, eventId, "planning_doc", [
      { key: "cost", type: "currency", order: 0 },
      { key: "fee", type: "currency", order: 1 },
    ]);
    const itemId = await seedItem(s, eventId, {
      module: "comms",
      fields: { cost: 100, fee: 20 },
    });

    const result = await convert(s, itemId, "planning_doc");
    expect(result.costColKey).toBeNull();
    const item = await getItem(s, itemId);
    expect(item?.fields?.cost).toBe(100);
    expect(item?.fields?.fee).toBe(20);
  });

  test("TARGET_HAS_NO_COST_COLUMN: converting onto a module with no currency column is refused", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    await seedColumns(s, eventId, "supplies", [
      { key: "cost", type: "currency", order: 0 },
    ]);
    // retro has no currency column at all (no seedColumns call for it).
    const itemId = await seedItem(s, eventId, {
      module: "supplies",
      fields: { cost: 40 },
    });

    let caught: unknown;
    try {
      await convert(s, itemId, "retro");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConvexError);
    expect((caught as ConvexError<{ code: string }>).data.code).toBe(
      "TARGET_HAS_NO_COST_COLUMN",
    );

    const item = await getItem(s, itemId);
    expect(item?.module).toBe("supplies");
    expect(item?.fields?.cost).toBe(40);
  });

  test("no-op when toModule === item.module — nothing is written", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    await seedColumns(s, eventId, "planning_doc", [
      { key: "cost", type: "currency", order: 0 },
    ]);
    const templateItemId = await run(t, async (ctx) => {
      const eventTypeId = await ctx.db.insert("eventTypes", {
        chapterId: s.chapterId,
        name: "T2",
        slug: "t2",
        version: 1,
        isArchived: false,
        createdBy: s.userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      return await ctx.db.insert("templateItems", {
        eventTypeId,
        module: "planning_doc",
        title: "Template row",
        order: 0,
      });
    });
    const itemId = await seedItem(s, eventId, {
      module: "planning_doc",
      order: 5,
      fields: { cost: 20 },
      sourceTemplateItemId: templateItemId,
      prePlanColumns: ["details"],
      prePlanChecked: ["details"],
    });

    const result = await convert(s, itemId, "planning_doc");
    expect(result.costColKey).toBe("cost");

    // No-op means the fields a real conversion would clear stay untouched.
    const item = await getItem(s, itemId);
    expect(item?.module).toBe("planning_doc");
    expect(item?.order).toBe(5);
    expect(item?.sourceTemplateItemId).toBe(templateItemId);
    expect(item?.prePlanColumns).toEqual(["details"]);
    expect(item?.prePlanChecked).toEqual(["details"]);
  });

  test("sourceTemplateItemId, prePlanColumns, and prePlanChecked are cleared on a real conversion", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    const templateItemId = await run(t, async (ctx) => {
      const eventTypeId = await ctx.db.insert("eventTypes", {
        chapterId: s.chapterId,
        name: "T3",
        slug: "t3",
        version: 1,
        isArchived: false,
        createdBy: s.userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      return await ctx.db.insert("templateItems", {
        eventTypeId,
        module: "planning_doc",
        title: "Template row",
        order: 0,
      });
    });
    const itemId = await seedItem(s, eventId, {
      module: "planning_doc",
      sourceTemplateItemId: templateItemId,
      prePlanColumns: ["details"],
      prePlanChecked: ["details"],
    });

    await convert(s, itemId, "comms");

    const item = await getItem(s, itemId);
    expect(item?.sourceTemplateItemId).toBeUndefined();
    expect(item?.prePlanColumns).toBeUndefined();
    expect(item?.prePlanChecked).toBeUndefined();
  });

  test("order is appended to the end of the target module", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    await seedItem(s, eventId, { module: "comms", order: 0, title: "Existing 1" });
    await seedItem(s, eventId, { module: "comms", order: 2, title: "Existing 2" });
    const itemId = await seedItem(s, eventId, { module: "planning_doc", order: 0 });

    await convert(s, itemId, "comms");

    const item = await getItem(s, itemId);
    expect(item?.order).toBe(3);
  });

  test("roleId and budgetCategoryId are kept across a conversion", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    const roleId = await run(t, (ctx) =>
      ctx.db.insert("eventRoles", {
        eventId,
        key: "event_lead",
        label: "Event Lead",
        order: 0,
      }),
    );
    const fundId = await run(t, (ctx) =>
      ctx.db.insert("funds", {
        chapterId: s.chapterId,
        name: "General",
        restriction: "unrestricted",
        sortOrder: 0,
        createdAt: Date.now(),
      }),
    );
    const categoryId = await run(t, (ctx) =>
      ctx.db.insert("budgetCategories", {
        chapterId: s.chapterId,
        fundId,
        name: "Ops",
        kind: "lineItem",
        isActive: true,
        createdAt: Date.now(),
      }),
    );
    const itemId = await seedItem(s, eventId, {
      module: "planning_doc",
      roleId,
      budgetCategoryId: categoryId,
    });

    await convert(s, itemId, "comms");

    const item = await getItem(s, itemId);
    expect(item?.roleId).toBe(roleId);
    expect(item?.budgetCategoryId).toBe(categoryId);
  });

  test("an unknown module string is rejected", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    const itemId = await seedItem(s, eventId, { module: "planning_doc" });

    let caught: unknown;
    try {
      await convert(s, itemId, "totally_made_up");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConvexError);
    expect((caught as ConvexError<{ code: string }>).data.code).toBe(
      "UNKNOWN_MODULE",
    );
  });

  test("a disabled (inactive) core module is rejected", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s, { disabledCoreModules: ["retro"] });
    const itemId = await seedItem(s, eventId, { module: "planning_doc" });

    let caught: unknown;
    try {
      await convert(s, itemId, "retro");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConvexError);
    expect((caught as ConvexError<{ code: string }>).data.code).toBe(
      "UNKNOWN_MODULE",
    );
  });

  test("a caller from a different chapter is rejected", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    const itemId = await seedItem(s, eventId, { module: "planning_doc" });

    const other = await setupChapter(t, {
      email: "other@publicworship.life",
      chapterName: "Boston",
    });

    await expect(
      other.as.mutation(api.items.convertEventItemModule, {
        itemId,
        toModule: "comms",
      }),
    ).rejects.toBeInstanceOf(ConvexError);

    const item = await getItem(s, itemId);
    expect(item?.module).toBe("planning_doc");
  });
});
