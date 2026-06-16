import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { api } from "../_generated/api";
import { newT, run, setupChapter } from "./setup.helpers";
import type { Id } from "../_generated/dataModel";

/**
 * Characterization tests for input validation on the write mutations:
 *   - items.addEventItem / addTemplateItem reject modules that aren't an ACTIVE
 *     module on the scope (UNKNOWN_MODULE), but ACCEPT a custom active module.
 *   - columns.addColumn rejects unknown column types (INVALID_COLUMN_TYPE).
 */

async function seedTemplate(
  t: ReturnType<typeof newT>,
  chapterId: Id<"chapters">,
  userId: Id<"users">,
  customModuleKey?: string,
) {
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
    if (customModuleKey) {
      await ctx.db.insert("templateModules", {
        eventTypeId,
        key: customModuleKey,
        label: "Custom",
        order: 0,
        isActive: true,
      });
    }
    return { eventTypeId };
  });
}

async function seedEvent(
  t: ReturnType<typeof newT>,
  chapterId: Id<"chapters">,
  userId: Id<"users">,
  customModuleKey?: string,
) {
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
      name: "E",
      eventDate: now,
      status: "planning",
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    });
    if (customModuleKey) {
      await ctx.db.insert("eventModules", {
        eventId,
        key: customModuleKey,
        label: "Custom",
        order: 0,
      });
    }
    return { eventId };
  });
}

describe("items.addEventItem module validation", () => {
  test("a core active module (planning_doc) is allowed", async () => {
    const t = newT();
    const { as, chapterId, userId } = await setupChapter(t);
    const { eventId } = await seedEvent(t, chapterId, userId);
    const id = await as.mutation(api.items.addEventItem, {
      eventId,
      module: "planning_doc",
      title: "ok",
    });
    expect(id).toBeDefined();
  });

  test("an unknown module string is rejected (UNKNOWN_MODULE)", async () => {
    const t = newT();
    const { as, chapterId, userId } = await setupChapter(t);
    const { eventId } = await seedEvent(t, chapterId, userId);
    await expect(
      as.mutation(api.items.addEventItem, {
        eventId,
        module: "not_a_real_module",
        title: "nope",
      }),
    ).rejects.toThrow(ConvexError);
  });

  test("a CUSTOM active module is allowed (regression-risk case)", async () => {
    const t = newT();
    const { as, chapterId, userId } = await setupChapter(t);
    const { eventId } = await seedEvent(t, chapterId, userId, "custom_load_in");
    const id = await as.mutation(api.items.addEventItem, {
      eventId,
      module: "custom_load_in",
      title: "custom ok",
    });
    expect(id).toBeDefined();
  });
});

describe("items.addTemplateItem module validation", () => {
  test("unknown module rejected; custom active module allowed", async () => {
    const t = newT();
    const { as, chapterId, userId } = await setupChapter(t);
    const { eventTypeId } = await seedTemplate(
      t,
      chapterId,
      userId,
      "custom_x",
    );

    await expect(
      as.mutation(api.items.addTemplateItem, {
        eventTypeId,
        module: "bogus_module",
        title: "no",
      }),
    ).rejects.toThrow(ConvexError);

    const id = await as.mutation(api.items.addTemplateItem, {
      eventTypeId,
      module: "custom_x",
      title: "yes",
    });
    expect(id).toBeDefined();
  });
});

describe("columns.addColumn type validation", () => {
  test("a known column type (text) is accepted", async () => {
    const t = newT();
    const { as, chapterId, userId } = await setupChapter(t);
    const { eventTypeId } = await seedTemplate(t, chapterId, userId);
    const id = await as.mutation(api.columns.addColumn, {
      eventTypeId,
      module: "planning_doc",
      label: "Extra Field",
      type: "text",
    });
    expect(id).toBeDefined();
  });

  test("an unknown column type is rejected (INVALID_COLUMN_TYPE)", async () => {
    const t = newT();
    const { as, chapterId, userId } = await setupChapter(t);
    const { eventTypeId } = await seedTemplate(t, chapterId, userId);
    await expect(
      as.mutation(api.columns.addColumn, {
        eventTypeId,
        module: "planning_doc",
        label: "Bad Field",
        type: "not_a_column_type",
      }),
    ).rejects.toThrow(ConvexError);
  });
});
