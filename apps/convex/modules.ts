/**
 * Modules — the configurable planning surfaces of a template/event.
 *
 * Core modules are platform-wide constants (CORE_MODULES in @events-os/shared),
 * available to every template/event and toggleable but never deletable. A
 * template/event stores only DELTAS against them (`disabledCoreModules` +
 * `coreModuleOverrides`) and owns its CUSTOM modules as rows (`templateModules`/
 * `eventModules`), cloned template→event on creation. The shared
 * `resolveActiveModules` helper folds both into one ordered active list.
 *
 * Authorization mirrors roles.ts: every op is scoped through the chapter of the
 * parent eventType/event.
 */
import { query, mutation } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { v } from "convex/values";
import {
  CORE_MODULES,
  DEFAULT_COLUMNS,
  DEFAULT_CUSTOM_COLUMNS,
  resolveActiveModules,
  disabledCoreModules as resolveDisabledCore,
  type ModuleKey,
  type ModuleOverride,
} from "@events-os/shared";
import { requireUserId, requireChapterId, requireInChapter } from "./lib/context";
import { toKey } from "./roles";
import {
  maxOrder,
  bumpVersion,
  seedModuleColumns,
  templateModuleState,
  eventModuleState,
  getPersonForUser,
} from "./lib/templates";

// ── Template modules ──────────────────────────────────────────────────────────

/**
 * A template's modules: the resolved ACTIVE list (core + custom, ordered) plus
 * the DISABLED core modules (so the editor can offer re-enable), and the raw
 * custom rows (so the editor has their ids for rename/delete).
 */
export const listForTemplate = query({
  args: { eventTypeId: v.id("eventTypes") },
  handler: async (ctx, { eventTypeId }) => {
    const chapterId = await requireChapterId(ctx);
    const et = await ctx.db.get(eventTypeId);
    if (!et || et.chapterId !== chapterId)
      return { active: [], disabledCore: [], customRows: [] };
    const state = await templateModuleState(ctx, et);
    const customRows = await ctx.db
      .query("templateModules")
      .withIndex("by_template", (q: any) => q.eq("eventTypeId", eventTypeId))
      .collect();
    return {
      active: resolveActiveModules(state),
      disabledCore: resolveDisabledCore(state),
      customRows: customRows.sort((a: any, b: any) => a.order - b.order),
    };
  },
});

/** Create a custom module on a template + seed its default columns. */
export const createCustomForTemplate = mutation({
  args: {
    eventTypeId: v.id("eventTypes"),
    label: v.string(),
    ownerRoleKey: v.optional(v.string()),
  },
  handler: async (ctx, { eventTypeId, label, ownerRoleKey }) => {
    const chapterId = await requireChapterId(ctx);
    const et = await ctx.db.get(eventTypeId);
    await requireInChapter(ctx, chapterId, et, "Event type");
    const rows = await ctx.db
      .query("templateModules")
      .withIndex("by_template", (q: any) => q.eq("eventTypeId", eventTypeId))
      .collect();
    const key = uniqueKey(toKey(label) || "module", rows);
    const id = await ctx.db.insert("templateModules", {
      eventTypeId,
      key,
      label,
      ownerRoleKey,
      offsetMode: "none",
      order: maxOrder(rows) + 1,
      isActive: true,
    });
    await seedModuleColumns(ctx, eventTypeId, key, DEFAULT_CUSTOM_COLUMNS);
    await bumpVersion(ctx, eventTypeId);
    return id;
  },
});

/** Rename / toggle a custom template module (key stays stable). */
export const updateCustomForTemplate = mutation({
  args: {
    moduleId: v.id("templateModules"),
    label: v.optional(v.string()),
    isActive: v.optional(v.boolean()),
  },
  handler: async (ctx, { moduleId, ...patch }) => {
    const chapterId = await requireChapterId(ctx);
    const row = await ctx.db.get(moduleId);
    if (!row) return moduleId;
    const et = await ctx.db.get(row.eventTypeId);
    await requireInChapter(ctx, chapterId, et, "Event type");
    const fields: Record<string, unknown> = {};
    if (patch.label !== undefined) fields.label = patch.label;
    if (patch.isActive !== undefined) fields.isActive = patch.isActive;
    await ctx.db.patch(moduleId, fields);
    await bumpVersion(ctx, row.eventTypeId);
    return moduleId;
  },
});

/** Delete a custom template module + its columns/items. */
export const deleteCustomForTemplate = mutation({
  args: { moduleId: v.id("templateModules") },
  handler: async (ctx, { moduleId }) => {
    const chapterId = await requireChapterId(ctx);
    const row = await ctx.db.get(moduleId);
    if (!row) return moduleId;
    const et = await ctx.db.get(row.eventTypeId);
    await requireInChapter(ctx, chapterId, et, "Event type");
    await deleteTemplateModuleData(ctx, row.eventTypeId, row.key);
    await ctx.db.delete(moduleId);
    await bumpVersion(ctx, row.eventTypeId);
    return moduleId;
  },
});

/** Toggle a CORE module on/off for a template (writes disabledCoreModules). */
export const toggleCoreForTemplate = mutation({
  args: {
    eventTypeId: v.id("eventTypes"),
    key: v.string(),
    enabled: v.boolean(),
  },
  handler: async (ctx, { eventTypeId, key, enabled }) => {
    const chapterId = await requireChapterId(ctx);
    const et = await ctx.db.get(eventTypeId);
    await requireInChapter(ctx, chapterId, et, "Event type");
    if (!isCoreKey(key)) return eventTypeId;
    const disabled = new Set(et!.disabledCoreModules ?? []);
    if (enabled) disabled.delete(key);
    else disabled.add(key);
    await ctx.db.patch(eventTypeId, {
      disabledCoreModules: Array.from(disabled),
    });
    // Re-enabling a grid core with no columns yet seeds its defaults.
    if (enabled) await ensureTemplateCoreColumns(ctx, eventTypeId, key);
    await bumpVersion(ctx, eventTypeId);
    return eventTypeId;
  },
});

/** Set a module's owner role for a template (override for core, field for custom). */
export const setOwnerForTemplate = mutation({
  args: {
    eventTypeId: v.id("eventTypes"),
    key: v.string(),
    ownerRoleKey: v.union(v.string(), v.null()),
  },
  handler: async (ctx, { eventTypeId, key, ownerRoleKey }) => {
    const chapterId = await requireChapterId(ctx);
    const et = await ctx.db.get(eventTypeId);
    await requireInChapter(ctx, chapterId, et, "Event type");
    const next = ownerRoleKey ?? undefined;
    if (isCoreKey(key)) {
      await ctx.db.patch(eventTypeId, {
        coreModuleOverrides: setOverrideOwner(
          et!.coreModuleOverrides,
          key,
          next,
        ),
      });
    } else {
      const row = await ctx.db
        .query("templateModules")
        .withIndex("by_template_key", (q: any) =>
          q.eq("eventTypeId", eventTypeId).eq("key", key),
        )
        .first();
      if (row) await ctx.db.patch(row._id, { ownerRoleKey: next });
    }
    await bumpVersion(ctx, eventTypeId);
    return eventTypeId;
  },
});

/** Rename a CORE module for a template (override; key stays stable). */
export const renameCoreForTemplate = mutation({
  args: {
    eventTypeId: v.id("eventTypes"),
    key: v.string(),
    label: v.union(v.string(), v.null()),
  },
  handler: async (ctx, { eventTypeId, key, label }) => {
    const chapterId = await requireChapterId(ctx);
    const et = await ctx.db.get(eventTypeId);
    await requireInChapter(ctx, chapterId, et, "Event type");
    if (!isCoreKey(key)) return eventTypeId;
    await ctx.db.patch(eventTypeId, {
      coreModuleOverrides: setOverrideLabel(
        et!.coreModuleOverrides,
        key,
        label ?? undefined,
      ),
    });
    await bumpVersion(ctx, eventTypeId);
    return eventTypeId;
  },
});

// ── Event modules ─────────────────────────────────────────────────────────────

/** An event's modules (same shape as listForTemplate) + readiness. */
export const listForEvent = query({
  args: { eventId: v.id("events") },
  handler: async (ctx, { eventId }) => {
    const chapterId = await requireChapterId(ctx);
    const event = await ctx.db.get(eventId);
    if (!event || event.chapterId !== chapterId)
      return { active: [], disabledCore: [], customRows: [], readiness: [] };
    const state = await eventModuleState(ctx, event);
    const customRows = await ctx.db
      .query("eventModules")
      .withIndex("by_event", (q: any) => q.eq("eventId", eventId))
      .collect();
    return {
      active: resolveActiveModules(state),
      disabledCore: resolveDisabledCore(state),
      customRows: customRows.sort((a: any, b: any) => a.order - b.order),
      readiness: event.moduleReadiness ?? [],
    };
  },
});

/** Create a custom module on an event + seed its default columns. */
export const createCustomForEvent = mutation({
  args: {
    eventId: v.id("events"),
    label: v.string(),
    ownerRoleKey: v.optional(v.string()),
  },
  handler: async (ctx, { eventId, label, ownerRoleKey }) => {
    const chapterId = await requireChapterId(ctx);
    const event = await ctx.db.get(eventId);
    await requireInChapter(ctx, chapterId, event, "Event");
    const rows = await ctx.db
      .query("eventModules")
      .withIndex("by_event", (q: any) => q.eq("eventId", eventId))
      .collect();
    const key = uniqueKey(toKey(label) || "module", rows);
    const id = await ctx.db.insert("eventModules", {
      eventId,
      key,
      label,
      ownerRoleKey,
      offsetMode: "none",
      order: maxOrder(rows) + 1,
    });
    // Custom event modules get their columns directly on the event.
    for (let i = 0; i < DEFAULT_CUSTOM_COLUMNS.length; i++) {
      const c = DEFAULT_CUSTOM_COLUMNS[i];
      await ctx.db.insert("eventColumns", {
        eventId,
        module: key,
        key: c.key,
        label: c.label,
        kind: c.kind,
        type: c.type,
        options: c.options,
        config: c.config,
        isVisible: c.isVisible,
        order: i,
      });
    }
    return id;
  },
});

/** Rename a custom event module. */
export const updateCustomForEvent = mutation({
  args: { moduleId: v.id("eventModules"), label: v.optional(v.string()) },
  handler: async (ctx, { moduleId, label }) => {
    const chapterId = await requireChapterId(ctx);
    const row = await ctx.db.get(moduleId);
    if (!row) return moduleId;
    const event = await ctx.db.get(row.eventId);
    await requireInChapter(ctx, chapterId, event, "Event");
    if (label !== undefined) await ctx.db.patch(moduleId, { label });
    return moduleId;
  },
});

/** Delete a custom event module + its columns/items. */
export const deleteCustomForEvent = mutation({
  args: { moduleId: v.id("eventModules") },
  handler: async (ctx, { moduleId }) => {
    const chapterId = await requireChapterId(ctx);
    const row = await ctx.db.get(moduleId);
    if (!row) return moduleId;
    const event = await ctx.db.get(row.eventId);
    await requireInChapter(ctx, chapterId, event, "Event");
    await deleteEventModuleData(ctx, row.eventId, row.key);
    await ctx.db.delete(moduleId);
    return moduleId;
  },
});

/** Toggle a CORE module on/off for an event (e.g. re-enable one the template disabled). */
export const toggleCoreForEvent = mutation({
  args: { eventId: v.id("events"), key: v.string(), enabled: v.boolean() },
  handler: async (ctx, { eventId, key, enabled }) => {
    const chapterId = await requireChapterId(ctx);
    const event = await ctx.db.get(eventId);
    await requireInChapter(ctx, chapterId, event, "Event");
    if (!isCoreKey(key)) return eventId;
    const disabled = new Set(event!.disabledCoreModules ?? []);
    if (enabled) disabled.delete(key);
    else disabled.add(key);
    await ctx.db.patch(eventId, { disabledCoreModules: Array.from(disabled) });
    if (enabled) await ensureEventCoreColumns(ctx, eventId, key);
    return eventId;
  },
});

/** Set a module's owner role for an event. */
export const setOwnerForEvent = mutation({
  args: {
    eventId: v.id("events"),
    key: v.string(),
    ownerRoleKey: v.union(v.string(), v.null()),
  },
  handler: async (ctx, { eventId, key, ownerRoleKey }) => {
    const chapterId = await requireChapterId(ctx);
    const event = await ctx.db.get(eventId);
    await requireInChapter(ctx, chapterId, event, "Event");
    const next = ownerRoleKey ?? undefined;
    if (isCoreKey(key)) {
      await ctx.db.patch(eventId, {
        coreModuleOverrides: setOverrideOwner(
          event!.coreModuleOverrides,
          key,
          next,
        ),
      });
    } else {
      const row = await ctx.db
        .query("eventModules")
        .withIndex("by_event_key", (q: any) =>
          q.eq("eventId", eventId).eq("key", key),
        )
        .first();
      if (row) await ctx.db.patch(row._id, { ownerRoleKey: next });
    }
    return eventId;
  },
});

/** Mark a module ready / not-ready on an event (per-module readiness flag). */
export const setReady = mutation({
  args: { eventId: v.id("events"), key: v.string(), ready: v.boolean() },
  handler: async (ctx, { eventId, key, ready }) => {
    const chapterId = await requireChapterId(ctx);
    const userId = await requireUserId(ctx);
    const event = await ctx.db.get(eventId);
    await requireInChapter(ctx, chapterId, event, "Event");
    const markedBy = await getPersonForUser(
      ctx,
      chapterId as Id<"chapters">,
      userId as Id<"users">,
    );
    const next = [...(event!.moduleReadiness ?? [])];
    const idx = next.findIndex((r) => r.key === key);
    const entry = {
      key,
      ready,
      markedBy: markedBy ?? undefined,
      markedAt: Date.now(),
    };
    if (idx >= 0) next[idx] = entry;
    else next.push(entry);
    await ctx.db.patch(eventId, { moduleReadiness: next });
    return eventId;
  },
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function isCoreKey(key: string): boolean {
  return CORE_MODULES.some((m) => m.key === key);
}

/** A key not already used by a custom row in the scope. */
function uniqueKey(base: string, rows: Array<{ key: string }>): string {
  const used = new Set(rows.map((r) => r.key));
  if (isCoreKey(base)) used.add(base); // never collide with a core key
  if (!used.has(base)) return base;
  let i = 2;
  while (used.has(`${base}_${i}`)) i++;
  return `${base}_${i}`;
}

/** Upsert a core override's ownerRoleKey (dropping empty overrides). */
function setOverrideOwner(
  overrides: ModuleOverride[] | undefined,
  key: string,
  ownerRoleKey: string | undefined,
): ModuleOverride[] {
  return upsertOverride(overrides, key, (o) => ({ ...o, ownerRoleKey }));
}

/** Upsert a core override's label (dropping empty overrides). */
function setOverrideLabel(
  overrides: ModuleOverride[] | undefined,
  key: string,
  label: string | undefined,
): ModuleOverride[] {
  return upsertOverride(overrides, key, (o) => ({ ...o, label }));
}

function upsertOverride(
  overrides: ModuleOverride[] | undefined,
  key: string,
  edit: (o: ModuleOverride) => ModuleOverride,
): ModuleOverride[] {
  const list = [...(overrides ?? [])];
  const idx = list.findIndex((o) => o.key === key);
  const base = idx >= 0 ? list[idx] : { key };
  const next = edit(base);
  // Drop an override that no longer carries any value.
  const isEmpty =
    next.label === undefined && next.ownerRoleKey === undefined;
  if (idx >= 0) {
    if (isEmpty) list.splice(idx, 1);
    else list[idx] = next;
  } else if (!isEmpty) {
    list.push(next);
  }
  return list;
}

async function ensureTemplateCoreColumns(
  ctx: any,
  eventTypeId: Id<"eventTypes">,
  key: string,
) {
  const def = CORE_MODULES.find((m) => m.key === key);
  if (!def || def.surface !== "grid") return;
  const existing = await ctx.db
    .query("templateColumns")
    .withIndex("by_eventType_module", (q: any) =>
      q.eq("eventTypeId", eventTypeId).eq("module", key),
    )
    .first();
  if (!existing) await seedModuleColumns(ctx, eventTypeId, key);
}

async function ensureEventCoreColumns(
  ctx: any,
  eventId: Id<"events">,
  key: string,
) {
  const def = CORE_MODULES.find((m) => m.key === key);
  if (!def || def.surface !== "grid") return;
  const existing = await ctx.db
    .query("eventColumns")
    .withIndex("by_event_module", (q: any) =>
      q.eq("eventId", eventId).eq("module", key),
    )
    .first();
  if (existing) return;
  const defaults = DEFAULT_COLUMNS[key as ModuleKey] ?? [];
  for (let i = 0; i < defaults.length; i++) {
    const c = defaults[i];
    await ctx.db.insert("eventColumns", {
      eventId,
      module: key,
      key: c.key,
      label: c.label,
      kind: c.kind,
      type: c.type,
      options: c.options,
      config: c.config,
      isVisible: c.isVisible,
      order: i,
    });
  }
}

/** Delete a template module's columns + items by key. */
async function deleteTemplateModuleData(
  ctx: any,
  eventTypeId: Id<"eventTypes">,
  key: string,
) {
  for (const c of await ctx.db
    .query("templateColumns")
    .withIndex("by_eventType_module", (q: any) =>
      q.eq("eventTypeId", eventTypeId).eq("module", key),
    )
    .collect())
    await ctx.db.delete(c._id);
  for (const it of await ctx.db
    .query("templateItems")
    .withIndex("by_eventType_module", (q: any) =>
      q.eq("eventTypeId", eventTypeId).eq("module", key),
    )
    .collect())
    await ctx.db.delete(it._id);
}

/** Delete an event module's columns + items by key. */
async function deleteEventModuleData(
  ctx: any,
  eventId: Id<"events">,
  key: string,
) {
  for (const c of await ctx.db
    .query("eventColumns")
    .withIndex("by_event_module", (q: any) =>
      q.eq("eventId", eventId).eq("module", key),
    )
    .collect())
    await ctx.db.delete(c._id);
  for (const it of await ctx.db
    .query("eventItems")
    .withIndex("by_event_module", (q: any) =>
      q.eq("eventId", eventId).eq("module", key),
    )
    .collect())
    await ctx.db.delete(it._id);
}
