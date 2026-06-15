/**
 * Event Types / Templates.
 *
 * The reusable blueprint for a kind of event: an active roles set + active
 * components, each list-backed component holding its own configurable columns
 * (`templateColumns`) and base items (`templateItems`). `version` bumps on every
 * structural edit; events clone the template's columns AND items at creation so
 * in-flight events are never disrupted by later edits.
 */
import { query, mutation } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { DEFAULT_ROLES, GRID_CORE_MODULE_KEYS } from "@events-os/shared";
import {
  requireUserId,
  requireChapterId,
  requireInChapter,
  getChapterIdOrNull,
} from "./lib/context";
import {
  toSlug,
  seedModuleColumns,
  seedTemplateRoles,
  templateActiveModules,
} from "./lib/templates";

/** A template's roles ({ _id, label }), ordered. */
async function templateRoles(ctx: any, eventTypeId: Id<"eventTypes">) {
  const roles = await ctx.db
    .query("templateRoles")
    .withIndex("by_template", (q: any) => q.eq("eventTypeId", eventTypeId))
    .collect();
  return roles
    .filter((r: any) => r.isArchived !== true)
    .sort((a: any, b: any) => a.order - b.order)
    .map((r: any) => ({ _id: r._id, label: r.label }));
}

/** List the chapter's active event types with a planning-task count + roles. */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const chapterId = await getChapterIdOrNull(ctx);
    if (!chapterId) return [];
    const types = await ctx.db
      .query("eventTypes")
      .withIndex("by_chapter", (q: any) => q.eq("chapterId", chapterId))
      .collect();
    const active = types.filter((t: any) => t.isArchived !== true);
    const withMeta = await Promise.all(
      active.map(async (t: any) => {
        const tasks = await ctx.db
          .query("templateItems")
          .withIndex("by_eventType_module", (q: any) =>
            q.eq("eventTypeId", t._id).eq("module", "planning_doc"),
          )
          .collect();
        const roles = await templateRoles(ctx, t._id);
        const modules = await templateActiveModules(ctx, t);
        return {
          _id: t._id,
          name: t.name,
          slug: t.slug,
          description: t.description,
          modules,
          roles,
          version: t.version,
          taskCount: tasks.length,
        };
      }),
    );
    return withMeta.sort((a, b) => a.name.localeCompare(b.name));
  },
});

/** Like `list`, but archived-only — backs the "Archived templates" section. */
export const listArchived = query({
  args: {},
  handler: async (ctx) => {
    const chapterId = await getChapterIdOrNull(ctx);
    if (!chapterId) return [];
    const types = await ctx.db
      .query("eventTypes")
      .withIndex("by_chapter", (q: any) => q.eq("chapterId", chapterId))
      .collect();
    const archived = types.filter((t: any) => t.isArchived === true);
    const withMeta = await Promise.all(
      archived.map(async (t: any) => {
        const tasks = await ctx.db
          .query("templateItems")
          .withIndex("by_eventType_module", (q: any) =>
            q.eq("eventTypeId", t._id).eq("module", "planning_doc"),
          )
          .collect();
        const roles = await templateRoles(ctx, t._id);
        const modules = await templateActiveModules(ctx, t);
        return {
          _id: t._id,
          name: t.name,
          slug: t.slug,
          description: t.description,
          modules,
          roles,
          version: t.version,
          taskCount: tasks.length,
        };
      }),
    );
    return withMeta.sort((a, b) => a.name.localeCompare(b.name));
  },
});

/** Template detail: the event type, its resolved active roles, and active modules. */
export const get = query({
  args: { eventTypeId: v.id("eventTypes") },
  handler: async (ctx, { eventTypeId }) => {
    const chapterId = await requireChapterId(ctx);
    const eventType = await ctx.db.get(eventTypeId);
    if (!eventType || eventType.chapterId !== chapterId) return null;
    return {
      eventType,
      roles: await templateRoles(ctx, eventTypeId),
      // Resolved active modules (core + custom, with deltas applied).
      modules: await templateActiveModules(ctx, eventType),
    };
  },
});

/**
 * Create a new template. If `deriveFromEventTypeId` is given, deep-copy that
 * parent's columns + items so a variant starts structurally aligned; otherwise
 * seed default columns for each active list-backed component.
 */
export const create = mutation({
  args: {
    name: v.string(),
    description: v.optional(v.string()),
    // Roles to seed on the new template; defaults to DEFAULT_ROLES.
    roleSeeds: v.optional(
      v.array(
        v.object({
          key: v.string(),
          label: v.string(),
          description: v.optional(v.string()),
        }),
      ),
    ),
    // Core module keys to start DISABLED (everything else is on by default).
    disabledCoreModules: v.optional(v.array(v.string())),
    deriveFromEventTypeId: v.optional(v.id("eventTypes")),
  },
  handler: async (ctx, args) => {
    const chapterId = await requireChapterId(ctx);
    const userId = await requireUserId(ctx);
    const now = Date.now();

    let disabledCoreModules = args.disabledCoreModules ?? [];
    let parent: any = null;
    if (args.deriveFromEventTypeId) {
      parent = await ctx.db.get(args.deriveFromEventTypeId);
      await requireInChapter(ctx, chapterId, parent, "Event type");
      if (!args.disabledCoreModules)
        disabledCoreModules = parent.disabledCoreModules ?? [];
    }

    const eventTypeId = (await ctx.db.insert("eventTypes", {
      chapterId: chapterId as Id<"chapters">,
      name: args.name,
      slug: toSlug(args.name),
      description: args.description,
      deriveFromEventTypeId: args.deriveFromEventTypeId,
      disabledCoreModules,
      coreModuleOverrides: args.deriveFromEventTypeId
        ? parent?.coreModuleOverrides
        : undefined,
      version: 1,
      isArchived: false,
      createdBy: userId as Id<"users">,
      createdAt: now,
      updatedAt: now,
    })) as Id<"eventTypes">;

    if (args.deriveFromEventTypeId) {
      // Deep-copy the parent's roles, columns + items. Item roleIds are remapped
      // from the parent's role ids to the new copies (by id) so they resolve.
      const parentRoles = await ctx.db
        .query("templateRoles")
        .withIndex("by_template", (q: any) =>
          q.eq("eventTypeId", args.deriveFromEventTypeId),
        )
        .collect();
      const roleIdMap = new Map<string, Id<"templateRoles">>();
      for (const r of parentRoles) {
        const { _id, _creationTime, eventTypeId: _e, ...rest } = r as any;
        const newId = (await ctx.db.insert("templateRoles", {
          eventTypeId,
          ...rest,
        })) as Id<"templateRoles">;
        roleIdMap.set(String(_id), newId);
      }
      const cols = await ctx.db
        .query("templateColumns")
        .withIndex("by_eventType", (q: any) =>
          q.eq("eventTypeId", args.deriveFromEventTypeId),
        )
        .collect();
      for (const c of cols) {
        const { _id, _creationTime, eventTypeId: _e, ...rest } = c as any;
        await ctx.db.insert("templateColumns", { eventTypeId, ...rest });
      }
      const items = await ctx.db
        .query("templateItems")
        .withIndex("by_eventType", (q: any) =>
          q.eq("eventTypeId", args.deriveFromEventTypeId),
        )
        .collect();
      for (const it of items) {
        const { _id, _creationTime, eventTypeId: _e, ...rest } = it as any;
        await ctx.db.insert("templateItems", {
          eventTypeId,
          ...rest,
          roleId: rest.roleId ? roleIdMap.get(String(rest.roleId)) : undefined,
        });
      }
      // Clone the parent's custom modules too.
      const parentModules = await ctx.db
        .query("templateModules")
        .withIndex("by_template", (q: any) =>
          q.eq("eventTypeId", args.deriveFromEventTypeId),
        )
        .collect();
      for (const m of parentModules) {
        const { _id, _creationTime, eventTypeId: _e, ...rest } = m as any;
        await ctx.db.insert("templateModules", { eventTypeId, ...rest });
      }
    } else {
      // Seed this template's roles + default columns for each active grid core.
      await seedTemplateRoles(ctx, eventTypeId, args.roleSeeds ?? DEFAULT_ROLES);
      const disabled = new Set(disabledCoreModules);
      for (const m of GRID_CORE_MODULE_KEYS) {
        if (disabled.has(m)) continue;
        await seedModuleColumns(ctx, eventTypeId, m);
      }
    }

    return eventTypeId;
  },
});

/** Edit a template's metadata (name/description); bumps version. */
export const update = mutation({
  args: {
    eventTypeId: v.id("eventTypes"),
    name: v.optional(v.string()),
    description: v.optional(v.string()),
  },
  handler: async (ctx, { eventTypeId, ...patch }) => {
    const chapterId = await requireChapterId(ctx);
    const et = await ctx.db.get(eventTypeId);
    await requireInChapter(ctx, chapterId, et, "Event type");
    const fields: Record<string, unknown> = {};
    if (patch.name !== undefined) {
      fields.name = patch.name;
      fields.slug = toSlug(patch.name);
    }
    if (patch.description !== undefined) fields.description = patch.description;
    fields.version = (et!.version ?? 1) + 1;
    fields.updatedAt = Date.now();
    await ctx.db.patch(eventTypeId, fields);
    return eventTypeId;
  },
});

/** A slug unique within a chapter, suffixing `-2`, `-3`, … on collision. */
async function uniqueSlug(
  ctx: any,
  chapterId: Id<"chapters">,
  base: string,
): Promise<string> {
  const existing = await ctx.db
    .query("eventTypes")
    .withIndex("by_chapter", (q: any) => q.eq("chapterId", chapterId))
    .collect();
  const taken = new Set(existing.map((t: any) => t.slug));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/**
 * Duplicate a template into an independent standalone copy (NOT a derive link):
 * deep-copies its roles, columns, items (with role remap) and custom modules.
 * Returns the new event type id.
 */
export const duplicate = mutation({
  args: { eventTypeId: v.id("eventTypes") },
  handler: async (ctx, { eventTypeId }) => {
    const chapterId = await requireChapterId(ctx);
    const userId = await requireUserId(ctx);
    const src = await ctx.db.get(eventTypeId);
    await requireInChapter(ctx, chapterId, src, "Event type");
    const now = Date.now();

    const newId = (await ctx.db.insert("eventTypes", {
      chapterId: chapterId as Id<"chapters">,
      name: `${src!.name} (copy)`,
      slug: await uniqueSlug(ctx, chapterId as Id<"chapters">, toSlug(src!.name)),
      description: src!.description,
      // Standalone copy — deliberately NOT linked back to the source.
      deriveFromEventTypeId: undefined,
      disabledCoreModules: src!.disabledCoreModules ?? [],
      coreModuleOverrides: src!.coreModuleOverrides,
      version: 1,
      isArchived: false,
      createdBy: userId as Id<"users">,
      createdAt: now,
      updatedAt: now,
    })) as Id<"eventTypes">;

    // Deep-copy roles (new ids), building a srcRoleId→newRoleId map.
    const srcRoles = await ctx.db
      .query("templateRoles")
      .withIndex("by_template", (q: any) => q.eq("eventTypeId", eventTypeId))
      .collect();
    const roleIdMap = new Map<string, Id<"templateRoles">>();
    for (const r of srcRoles) {
      const { _id, _creationTime, eventTypeId: _e, ...rest } = r as any;
      const id = (await ctx.db.insert("templateRoles", {
        eventTypeId: newId,
        ...rest,
      })) as Id<"templateRoles">;
      roleIdMap.set(String(_id), id);
    }

    // Copy columns verbatim under the new event type.
    const cols = await ctx.db
      .query("templateColumns")
      .withIndex("by_eventType", (q: any) => q.eq("eventTypeId", eventTypeId))
      .collect();
    for (const c of cols) {
      const { _id, _creationTime, eventTypeId: _e, ...rest } = c as any;
      await ctx.db.insert("templateColumns", { eventTypeId: newId, ...rest });
    }

    // Copy items, remapping each item's roleId through the role map.
    const items = await ctx.db
      .query("templateItems")
      .withIndex("by_eventType", (q: any) => q.eq("eventTypeId", eventTypeId))
      .collect();
    for (const it of items) {
      const { _id, _creationTime, eventTypeId: _e, ...rest } = it as any;
      await ctx.db.insert("templateItems", {
        eventTypeId: newId,
        ...rest,
        roleId: rest.roleId ? roleIdMap.get(String(rest.roleId)) : undefined,
      });
    }

    // Copy custom modules verbatim.
    const mods = await ctx.db
      .query("templateModules")
      .withIndex("by_template", (q: any) => q.eq("eventTypeId", eventTypeId))
      .collect();
    for (const m of mods) {
      const { _id, _creationTime, eventTypeId: _e, ...rest } = m as any;
      await ctx.db.insert("templateModules", { eventTypeId: newId, ...rest });
    }

    return newId;
  },
});

/** Archive a template (soft delete; hidden from `list`). */
export const archive = mutation({
  args: { eventTypeId: v.id("eventTypes") },
  handler: async (ctx, { eventTypeId }) => {
    const chapterId = await requireChapterId(ctx);
    const et = await ctx.db.get(eventTypeId);
    await requireInChapter(ctx, chapterId, et, "Event type");
    await ctx.db.patch(eventTypeId, { isArchived: true, updatedAt: Date.now() });
    return eventTypeId;
  },
});

/** Revive an archived template (restore to `list`). */
export const unarchive = mutation({
  args: { eventTypeId: v.id("eventTypes") },
  handler: async (ctx, { eventTypeId }) => {
    const chapterId = await requireChapterId(ctx);
    const et = await ctx.db.get(eventTypeId);
    await requireInChapter(ctx, chapterId, et, "Event type");
    await ctx.db.patch(eventTypeId, {
      isArchived: false,
      updatedAt: Date.now(),
    });
    return eventTypeId;
  },
});
