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
import { MODULE_KEYS, type ModuleKey } from "@events-os/shared";
import {
  requireUserId,
  requireChapterId,
  requireInChapter,
  getChapterIdOrNull,
} from "./lib/context";
import { toSlug, seedModuleColumns } from "./lib/templates";

/** The active modules (list-backed components) for a template. */
function activeModules(activeComponents: string[]): ModuleKey[] {
  return MODULE_KEYS.filter((m) => activeComponents.includes(m));
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
        const roles = await Promise.all(
          (t.activeRoleIds ?? []).map(async (rid: Id<"roles">) => {
            const r = await ctx.db.get(rid);
            return r ? { _id: r._id, label: r.label } : null;
          }),
        );
        return {
          _id: t._id,
          name: t.name,
          slug: t.slug,
          description: t.description,
          activeComponents: t.activeComponents,
          roles: roles.filter(Boolean),
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
    const roles = await Promise.all(
      (eventType.activeRoleIds ?? []).map(async (rid: Id<"roles">) => {
        const r = await ctx.db.get(rid);
        return r ? { _id: r._id, label: r.label } : null;
      }),
    );
    return {
      eventType,
      roles: roles.filter(Boolean),
      modules: activeModules(eventType.activeComponents),
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
    activeRoleIds: v.array(v.id("roles")),
    activeComponents: v.array(v.string()),
    deriveFromEventTypeId: v.optional(v.id("eventTypes")),
  },
  handler: async (ctx, args) => {
    const chapterId = await requireChapterId(ctx);
    const userId = await requireUserId(ctx);
    const now = Date.now();

    let activeRoleIds = args.activeRoleIds;
    let activeComponents = args.activeComponents;
    if (args.deriveFromEventTypeId) {
      const parent = await ctx.db.get(args.deriveFromEventTypeId);
      await requireInChapter(ctx, chapterId, parent, "Event type");
      if (activeRoleIds.length === 0) activeRoleIds = parent!.activeRoleIds;
      if (activeComponents.length === 0)
        activeComponents = parent!.activeComponents;
    }

    const eventTypeId = (await ctx.db.insert("eventTypes", {
      chapterId: chapterId as Id<"chapters">,
      name: args.name,
      slug: toSlug(args.name),
      description: args.description,
      deriveFromEventTypeId: args.deriveFromEventTypeId,
      activeRoleIds,
      activeComponents,
      version: 1,
      isArchived: false,
      createdBy: userId as Id<"users">,
      createdAt: now,
      updatedAt: now,
    })) as Id<"eventTypes">;

    if (args.deriveFromEventTypeId) {
      // Deep-copy the parent's columns + items.
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
        await ctx.db.insert("templateItems", { eventTypeId, ...rest });
      }
    } else {
      // Seed default columns for each active list-backed module.
      for (const m of activeModules(activeComponents)) {
        await seedModuleColumns(ctx, eventTypeId, m);
      }
    }

    return eventTypeId;
  },
});

/** Edit a template's metadata / active roles / active components; bumps version. */
export const update = mutation({
  args: {
    eventTypeId: v.id("eventTypes"),
    name: v.optional(v.string()),
    description: v.optional(v.string()),
    activeRoleIds: v.optional(v.array(v.id("roles"))),
    activeComponents: v.optional(v.array(v.string())),
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
    if (patch.activeRoleIds !== undefined)
      fields.activeRoleIds = patch.activeRoleIds;

    if (patch.activeComponents !== undefined) {
      fields.activeComponents = patch.activeComponents;
      // Newly-activated list modules with no columns yet get default columns.
      const before = activeModules(et!.activeComponents);
      const after = activeModules(patch.activeComponents);
      for (const m of after) {
        if (before.includes(m)) continue;
        const existing = await ctx.db
          .query("templateColumns")
          .withIndex("by_eventType_module", (q: any) =>
            q.eq("eventTypeId", eventTypeId).eq("module", m),
          )
          .first();
        if (!existing) await seedModuleColumns(ctx, eventTypeId, m);
      }
    }
    fields.version = (et!.version ?? 1) + 1;
    fields.updatedAt = Date.now();
    await ctx.db.patch(eventTypeId, fields);
    return eventTypeId;
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
