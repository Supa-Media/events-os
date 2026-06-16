import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import { newT, run, setupChapter } from "./setup.helpers";
import type { Id } from "../_generated/dataModel";

/**
 * Characterization tests for `deepCopyTemplate` (the shared clone behind
 * `eventTypes.create` deriving-from-parent AND `eventTypes.duplicate`):
 * roles → columns → items → custom modules are copied under the new template,
 * with each item's `roleId` repointed to the cloned role (not the source role).
 */

/**
 * Build a source template directly in the DB with one role, one column, one
 * item pointing at that role, and one custom module. Returns the source ids.
 */
async function seedSourceTemplate(
  t: ReturnType<typeof newT>,
  chapterId: Id<"chapters">,
  userId: Id<"users">,
) {
  return await run(t, async (ctx) => {
    const now = Date.now();
    const sourceId = await ctx.db.insert("eventTypes", {
      chapterId,
      name: "Source Template",
      slug: "source-template",
      disabledCoreModules: [],
      version: 1,
      isArchived: false,
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    });
    const roleId = await ctx.db.insert("templateRoles", {
      eventTypeId: sourceId,
      key: "stage_lead",
      label: "Stage Lead",
      order: 0,
      isArchived: false,
    });
    const colId = await ctx.db.insert("templateColumns", {
      eventTypeId: sourceId,
      module: "planning_doc",
      key: "title",
      label: "Task",
      kind: "system",
      type: "text",
      isVisible: true,
      order: 0,
    });
    const itemId = await ctx.db.insert("templateItems", {
      eventTypeId: sourceId,
      module: "planning_doc",
      title: "Set up stage",
      order: 0,
      roleId,
      fields: { notes: "carry over" },
    });
    const moduleId = await ctx.db.insert("templateModules", {
      eventTypeId: sourceId,
      key: "custom_load_in",
      label: "Load In",
      order: 0,
      isActive: true,
    });
    return { sourceId, roleId, colId, itemId, moduleId };
  });
}

/** Read back the cloned roles/columns/items/modules for a target template. */
async function readTemplate(
  t: ReturnType<typeof newT>,
  eventTypeId: Id<"eventTypes">,
) {
  return await run(t, async (ctx) => {
    const roles = await ctx.db
      .query("templateRoles")
      .withIndex("by_template", (q) => q.eq("eventTypeId", eventTypeId))
      .collect();
    const columns = await ctx.db
      .query("templateColumns")
      .withIndex("by_eventType", (q) => q.eq("eventTypeId", eventTypeId))
      .collect();
    const items = await ctx.db
      .query("templateItems")
      .withIndex("by_eventType", (q) => q.eq("eventTypeId", eventTypeId))
      .collect();
    const modules = await ctx.db
      .query("templateModules")
      .withIndex("by_template", (q) => q.eq("eventTypeId", eventTypeId))
      .collect();
    return { roles, columns, items, modules };
  });
}

describe("eventTypes.duplicate (deepCopyTemplate)", () => {
  test("copies roles, columns, items + modules with roleId remapped to the clone", async () => {
    const t = newT();
    const { as, chapterId, userId } = await setupChapter(t);
    const src = await seedSourceTemplate(t, chapterId, userId);

    const newId = await as.mutation(api.eventTypes.duplicate, {
      eventTypeId: src.sourceId,
    });

    const cloned = await readTemplate(t, newId as Id<"eventTypes">);

    // One of each was copied.
    expect(cloned.roles).toHaveLength(1);
    expect(cloned.columns).toHaveLength(1);
    expect(cloned.items).toHaveLength(1);
    expect(cloned.modules).toHaveLength(1);

    // Role content preserved, but it's a NEW row (not the source role).
    const clonedRole = cloned.roles[0];
    expect(clonedRole.key).toBe("stage_lead");
    expect(clonedRole.label).toBe("Stage Lead");
    expect(clonedRole._id).not.toBe(src.roleId);

    // Item roleId is repointed to the cloned role, NOT the source role.
    const clonedItem = cloned.items[0];
    expect(clonedItem.title).toBe("Set up stage");
    expect(clonedItem.roleId).toBe(clonedRole._id);
    expect(clonedItem.roleId).not.toBe(src.roleId);
    // Custom fields carried verbatim.
    expect(clonedItem.fields).toEqual({ notes: "carry over" });

    // Column + module copied verbatim under the new template.
    expect(cloned.columns[0].key).toBe("title");
    expect(cloned.modules[0].key).toBe("custom_load_in");

    // Duplicate is standalone (no derive link).
    const copy = await run(t, (ctx) => ctx.db.get(newId as Id<"eventTypes">));
    expect(copy?.deriveFromEventTypeId).toBeUndefined();
  });
});

describe("eventTypes.create (deriveFromEventTypeId → deepCopyTemplate)", () => {
  test("deriving from a parent clones its contents with roleId remap, and links the parent", async () => {
    const t = newT();
    const { as, chapterId, userId } = await setupChapter(t);
    const src = await seedSourceTemplate(t, chapterId, userId);

    const newId = await as.mutation(api.eventTypes.create, {
      name: "Derived Variant",
      deriveFromEventTypeId: src.sourceId,
    });

    const cloned = await readTemplate(t, newId as Id<"eventTypes">);
    expect(cloned.roles).toHaveLength(1);
    expect(cloned.items).toHaveLength(1);

    const clonedRole = cloned.roles[0];
    const clonedItem = cloned.items[0];
    // The defining behavior: item.roleId points at the new role copy.
    expect(clonedItem.roleId).toBe(clonedRole._id);
    expect(clonedItem.roleId).not.toBe(src.roleId);

    // Derived templates DO keep the parent link (unlike duplicate).
    const derived = await run(t, (ctx) => ctx.db.get(newId as Id<"eventTypes">));
    expect(derived?.deriveFromEventTypeId).toBe(src.sourceId);
  });

  test("creating WITHOUT a parent seeds default roles + grid-module columns (no clone)", async () => {
    const t = newT();
    const { as } = await setupChapter(t);

    const newId = await as.mutation(api.eventTypes.create, {
      name: "Fresh Template",
    });

    const seeded = await readTemplate(t, newId as Id<"eventTypes">);
    // DEFAULT_ROLES has 4 entries.
    expect(seeded.roles.length).toBe(4);
    // Default columns seeded for each grid core module → many columns, no items.
    expect(seeded.columns.length).toBeGreaterThan(0);
    expect(seeded.items.length).toBe(0);
  });
});
