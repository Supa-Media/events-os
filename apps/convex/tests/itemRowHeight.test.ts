import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import type { Id } from "../_generated/dataModel";

/**
 * Characterization tests for the manual `rowHeight` field added to
 * `items.updateEventItem` / `items.updateTemplateItem` (backs drag-to-resize of
 * grid rows). The one subtle contract: passing `rowHeight: null` RESETS the row
 * to auto-fit by clearing the stored field (patch `undefined`), distinct from
 * OMITTING it (leave whatever was there). These pin:
 *   - a number persists,
 *   - null clears it back to undefined (auto),
 *   - omitting it leaves the existing value untouched,
 *   - the same semantics on both the event-item and template-item mutations.
 */

async function seedEventItem(setup: ChapterSetup): Promise<Id<"eventItems">> {
  const { t, chapterId, userId } = setup;
  return await run(t, async (ctx) => {
    const now = Date.now();
    const eventTypeId = await ctx.db.insert("eventTypes", {
      chapterId,
      name: "T",
      slug: "t",
      version: 1,
      isArchived: false,
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    });
    const eventId = await ctx.db.insert("events", {
      chapterId,
      eventTypeId,
      templateVersion: 1,
      name: "Gala",
      eventDate: now,
      status: "planning",
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    });
    return await ctx.db.insert("eventItems", {
      eventId,
      chapterId,
      module: "planning_doc",
      title: "Set up stage",
      order: 0,
    });
  });
}

async function seedTemplateItem(
  setup: ChapterSetup,
): Promise<Id<"templateItems">> {
  const { t, chapterId, userId } = setup;
  return await run(t, async (ctx) => {
    const now = Date.now();
    const eventTypeId = await ctx.db.insert("eventTypes", {
      chapterId,
      name: "T",
      slug: "t",
      version: 1,
      isArchived: false,
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    });
    return await ctx.db.insert("templateItems", {
      eventTypeId,
      module: "planning_doc",
      title: "Set up stage",
      order: 0,
    });
  });
}

describe("updateEventItem rowHeight", () => {
  test("persists a manual row height", async () => {
    const t = newT();
    const setup = await setupChapter(t);
    const itemId = await seedEventItem(setup);

    await setup.as.mutation(api.items.updateEventItem, {
      itemId,
      rowHeight: 120,
    });

    const item = await run(t, (ctx) => ctx.db.get(itemId));
    expect(item?.rowHeight).toBe(120);
  });

  test("null resets the height back to auto-fit (clears the field)", async () => {
    const t = newT();
    const setup = await setupChapter(t);
    const itemId = await seedEventItem(setup);

    await setup.as.mutation(api.items.updateEventItem, {
      itemId,
      rowHeight: 120,
    });
    await setup.as.mutation(api.items.updateEventItem, {
      itemId,
      rowHeight: null,
    });

    const item = await run(t, (ctx) => ctx.db.get(itemId));
    expect(item?.rowHeight).toBeUndefined();
  });

  test("omitting rowHeight leaves the existing value untouched", async () => {
    const t = newT();
    const setup = await setupChapter(t);
    const itemId = await seedEventItem(setup);

    await setup.as.mutation(api.items.updateEventItem, {
      itemId,
      rowHeight: 90,
    });
    // A later edit that touches only the title must not wipe the height.
    await setup.as.mutation(api.items.updateEventItem, {
      itemId,
      title: "Renamed",
    });

    const item = await run(t, (ctx) => ctx.db.get(itemId));
    expect(item?.rowHeight).toBe(90);
    expect(item?.title).toBe("Renamed");
  });
});

describe("updateTemplateItem rowHeight", () => {
  test("persists a manual row height", async () => {
    const t = newT();
    const setup = await setupChapter(t);
    const itemId = await seedTemplateItem(setup);

    await setup.as.mutation(api.items.updateTemplateItem, {
      itemId,
      rowHeight: 200,
    });

    const item = await run(t, (ctx) => ctx.db.get(itemId));
    expect(item?.rowHeight).toBe(200);
  });

  test("null resets the height back to auto-fit", async () => {
    const t = newT();
    const setup = await setupChapter(t);
    const itemId = await seedTemplateItem(setup);

    await setup.as.mutation(api.items.updateTemplateItem, {
      itemId,
      rowHeight: 200,
    });
    await setup.as.mutation(api.items.updateTemplateItem, {
      itemId,
      rowHeight: null,
    });

    const item = await run(t, (ctx) => ctx.db.get(itemId));
    expect(item?.rowHeight).toBeUndefined();
  });
});
