/**
 * Event Types / Templates.
 *
 * The reusable blueprint for a kind of event: an active roles set + active
 * components, each list-backed component holding its own configurable columns
 * (`templateColumns`) and base items (`templateItems`). `version` bumps on every
 * structural edit; events clone the template's columns AND items at creation so
 * in-flight events are never disrupted by later edits.
 */
import { query, mutation, QueryCtx } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { ConvexError, v } from "convex/values";
import { DEFAULT_ROLES, GRID_CORE_MODULE_KEYS } from "@events-os/shared";
import {
  requireUserId,
  requireChapterId,
  requireEventType,
  getChapterIdOrNull,
} from "./lib/context";
import {
  toSlug,
  seedModuleColumns,
  seedTemplateRoles,
  templateActiveModules,
  deepCopyTemplate,
} from "./lib/templates";

/**
 * Throw unless the template is user-managed. Platform templates (the Academy
 * training template) are seeded and owned by the platform — users can't edit
 * or archive them, and events are only spun up from them by the Academy.
 */
function requireUserManaged(eventType: Doc<"eventTypes">): void {
  if (eventType.isPlatform === true) {
    throw new ConvexError({
      code: "PLATFORM_TEMPLATE",
      message: "This template is managed by the platform and can't be changed.",
    });
  }
}

/** A template's roles ({ _id, label }), ordered. */
async function templateRoles(ctx: QueryCtx, eventTypeId: Id<"eventTypes">) {
  const roles = await ctx.db
    .query("templateRoles")
    .withIndex("by_template", (q) => q.eq("eventTypeId", eventTypeId))
    .collect();
  return roles
    .filter((r) => r.isArchived !== true)
    .sort((a, b) => a.order - b.order)
    .map((r) => ({ _id: r._id, label: r.label }));
}

/** List the chapter's active event types with a planning-task count + roles. */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const chapterId = await getChapterIdOrNull(ctx);
    if (!chapterId) return [];
    const types = await ctx.db
      .query("eventTypes")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId as Id<"chapters">))
      .collect();
    // Platform templates (the Academy training run) never surface in the
    // Templates tab or the New Event picker — the Academy owns that flow.
    const active = types.filter(
      (t) => t.isArchived !== true && t.isPlatform !== true,
    );
    const withMeta = await Promise.all(
      active.map(async (t) => {
        const tasks = await ctx.db
          .query("templateItems")
          .withIndex("by_eventType_module", (q) =>
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
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId as Id<"chapters">))
      .collect();
    const archived = types.filter((t) => t.isArchived === true);
    const withMeta = await Promise.all(
      archived.map(async (t) => {
        const tasks = await ctx.db
          .query("templateItems")
          .withIndex("by_eventType_module", (q) =>
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
    let parent: Doc<"eventTypes"> | null = null;
    if (args.deriveFromEventTypeId) {
      parent = await requireEventType(ctx, args.deriveFromEventTypeId);
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
      // Deep-copy the parent's roles, columns, items + custom modules (item
      // roleIds remapped to the new role copies). Shared with `duplicate`.
      await deepCopyTemplate(ctx, args.deriveFromEventTypeId, eventTypeId);
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
    const et = await requireEventType(ctx, eventTypeId);
    requireUserManaged(et);
    const fields: Record<string, unknown> = {};
    if (patch.name !== undefined) {
      fields.name = patch.name;
      fields.slug = toSlug(patch.name);
    }
    if (patch.description !== undefined) fields.description = patch.description;
    fields.version = (et.version ?? 1) + 1;
    fields.updatedAt = Date.now();
    await ctx.db.patch(eventTypeId, fields);
    return eventTypeId;
  },
});

/** A slug unique within a chapter, suffixing `-2`, `-3`, … on collision. */
async function uniqueSlug(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
  base: string,
): Promise<string> {
  const existing = await ctx.db
    .query("eventTypes")
    .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
    .collect();
  const taken = new Set(existing.map((t) => t.slug));
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
    const src = await requireEventType(ctx, eventTypeId);
    const now = Date.now();

    const newId = (await ctx.db.insert("eventTypes", {
      chapterId: chapterId as Id<"chapters">,
      name: `${src.name} (copy)`,
      slug: await uniqueSlug(ctx, chapterId as Id<"chapters">, toSlug(src.name)),
      description: src.description,
      // Standalone copy — deliberately NOT linked back to the source.
      deriveFromEventTypeId: undefined,
      disabledCoreModules: src.disabledCoreModules ?? [],
      coreModuleOverrides: src.coreModuleOverrides,
      version: 1,
      isArchived: false,
      createdBy: userId as Id<"users">,
      createdAt: now,
      updatedAt: now,
    })) as Id<"eventTypes">;

    // Deep-copy roles, columns, items (role-remapped) + custom modules. Same
    // routine `create` uses when deriving from a parent.
    await deepCopyTemplate(ctx, eventTypeId, newId);

    return newId;
  },
});

/** Archive a template (soft delete; hidden from `list`). */
export const archive = mutation({
  args: { eventTypeId: v.id("eventTypes") },
  handler: async (ctx, { eventTypeId }) => {
    requireUserManaged(await requireEventType(ctx, eventTypeId));
    await ctx.db.patch(eventTypeId, { isArchived: true, updatedAt: Date.now() });
    return eventTypeId;
  },
});

/** Revive an archived template (restore to `list`). */
export const unarchive = mutation({
  args: { eventTypeId: v.id("eventTypes") },
  handler: async (ctx, { eventTypeId }) => {
    await requireEventType(ctx, eventTypeId);
    await ctx.db.patch(eventTypeId, {
      isArchived: false,
      updatedAt: Date.now(),
    });
    return eventTypeId;
  },
});
