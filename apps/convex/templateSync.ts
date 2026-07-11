/**
 * Event → template sync (the debrief loop behind P1: "the template is the
 * institutional memory").
 *
 * `diffEventAgainstTemplate` compares a live event to the template it was spun
 * up from and returns a structured divergence list; `promoteFromEvent` applies
 * a selected batch of those divergences back onto the template.
 *
 * Promotion carries STRUCTURE and never STATE: titles, details/notes, offsets,
 * roles (remapped template↔event by stable key), quantities/config, how-to doc
 * references, and column definitions flow up — person owners, statuses,
 * pre-plan ticks, photos-of-this-event, and cost actuals are stripped (template
 * rows get the module's default status). Items link template↔event via
 * `eventItems.sourceTemplateItemId` (stamped at clone, backfilled on promote);
 * modules and roles match by stable `key`; columns by `(module, key)`.
 */
import { query, mutation, QueryCtx } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { v, ConvexError } from "convex/values";
import {
  DAY_OFFSET_MODULES,
  defaultStatusValue,
  offsetDaysBetween,
  type ModuleKey,
} from "@events-os/shared";
import { requireEvent } from "./lib/context";
import { bumpVersion, maxOrder } from "./lib/templates";

/**
 * Column types whose cell VALUES are event state, not template structure:
 * photos of this event, cost actuals, and concrete people. Their column
 * DEFINITIONS are still promotable structure (templates ship cost/photo
 * columns); only the per-item values are stripped from diffs and promotions.
 */
const STATE_VALUE_COLUMN_TYPES = new Set(["photo", "currency", "person"]);

function isDayOffsetModule(module: string): boolean {
  return DAY_OFFSET_MODULES.includes(module as ModuleKey);
}

/**
 * The event item's effective signed day offset: the explicit `offsetDays`, or —
 * for a day-offset module row that was scheduled by picking a date — the offset
 * derived from its dueDate relative to the event date.
 */
function effectiveOffsetDays(
  item: Doc<"eventItems">,
  eventDate: number,
): number | undefined {
  if (item.offsetDays !== undefined) return item.offsetDays;
  if (isDayOffsetModule(item.module) && item.dueDate !== undefined)
    return offsetDaysBetween(eventDate, item.dueDate);
  return undefined;
}

/** Loose value equality for `fields` bag cells (arrays/objects included). */
function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** Load an event AND its template, both asserted into the caller's chapter. */
async function requireEventAndTemplate(
  ctx: QueryCtx,
  eventId: Id<"events">,
): Promise<{ event: Doc<"events">; eventType: Doc<"eventTypes"> }> {
  const event = await requireEvent(ctx, eventId);
  const eventType = await ctx.db.get(event.eventTypeId);
  if (!eventType || eventType.chapterId !== event.chapterId) {
    throw new ConvexError({
      code: "NOT_FOUND",
      message: "This event's template no longer exists in your chapter.",
    });
  }
  return { event, eventType };
}

/** Everything both the diff and the promote need to reason about a pair. */
async function loadSyncContext(
  ctx: QueryCtx,
  event: Doc<"events">,
  eventType: Doc<"eventTypes">,
) {
  const [
    eventItems,
    templateItems,
    eventRoles,
    templateRoles,
    eventColumns,
    templateColumns,
    eventModules,
    templateModules,
  ] = await Promise.all([
    ctx.db
      .query("eventItems")
      .withIndex("by_event", (q) => q.eq("eventId", event._id))
      .collect(),
    ctx.db
      .query("templateItems")
      .withIndex("by_eventType", (q) => q.eq("eventTypeId", eventType._id))
      .collect(),
    ctx.db
      .query("eventRoles")
      .withIndex("by_event", (q) => q.eq("eventId", event._id))
      .collect(),
    ctx.db
      .query("templateRoles")
      .withIndex("by_template", (q) => q.eq("eventTypeId", eventType._id))
      .collect(),
    ctx.db
      .query("eventColumns")
      .withIndex("by_event", (q) => q.eq("eventId", event._id))
      .collect(),
    ctx.db
      .query("templateColumns")
      .withIndex("by_eventType", (q) => q.eq("eventTypeId", eventType._id))
      .collect(),
    ctx.db
      .query("eventModules")
      .withIndex("by_event", (q) => q.eq("eventId", event._id))
      .collect(),
    ctx.db
      .query("templateModules")
      .withIndex("by_template", (q) => q.eq("eventTypeId", eventType._id))
      .collect(),
  ]);
  return {
    eventItems,
    templateItems,
    eventRoleById: new Map(eventRoles.map((r) => [String(r._id), r])),
    templateRoleById: new Map(templateRoles.map((r) => [String(r._id), r])),
    templateRoles,
    eventColumns,
    templateColumns,
    eventModules,
    templateModules,
  };
}

type SyncContext = Awaited<ReturnType<typeof loadSyncContext>>;

/** A single per-field divergence on a matched item (before = template side). */
type FieldChange = { field: string; before: unknown; after: unknown };

/**
 * Per-field divergences between a matched event item and its template source,
 * over PROMOTABLE fields only: title, offsets, role (compared by stable key),
 * and custom `fields` values for columns that exist on the template. Event
 * state (status, owner, prePlanChecked, dueDate, photo/cost/person cells) is
 * excluded by construction. `field` names ("title", "offsetDays",
 * "offsetMinutes", "role", "fields.<key>") double as the selection vocabulary
 * for `promoteFromEvent`'s update_item `fields` filter.
 */
function itemChanges(
  sync: SyncContext,
  eventDate: number,
  eventItem: Doc<"eventItems">,
  templateItem: Doc<"templateItems">,
): FieldChange[] {
  const changes: FieldChange[] = [];
  if (eventItem.title !== templateItem.title) {
    changes.push({
      field: "title",
      before: templateItem.title,
      after: eventItem.title,
    });
  }
  const offsetDays = effectiveOffsetDays(eventItem, eventDate);
  if (offsetDays !== templateItem.offsetDays) {
    changes.push({
      field: "offsetDays",
      before: templateItem.offsetDays ?? null,
      after: offsetDays ?? null,
    });
  }
  if (eventItem.offsetMinutes !== templateItem.offsetMinutes) {
    changes.push({
      field: "offsetMinutes",
      before: templateItem.offsetMinutes ?? null,
      after: eventItem.offsetMinutes ?? null,
    });
  }
  // Roles are compared by stable KEY (ids live in different scopes).
  const eventRoleKey = eventItem.roleId
    ? sync.eventRoleById.get(String(eventItem.roleId))?.key ?? null
    : null;
  const templateRoleKey = templateItem.roleId
    ? sync.templateRoleById.get(String(templateItem.roleId))?.key ?? null
    : null;
  if (eventRoleKey !== templateRoleKey) {
    changes.push({ field: "role", before: templateRoleKey, after: eventRoleKey });
  }
  // Custom fields — only for columns that EXIST ON THE TEMPLATE for this
  // module, and only structure-valued types.
  for (const col of sync.templateColumns) {
    if (col.module !== eventItem.module || col.kind !== "custom") continue;
    if (STATE_VALUE_COLUMN_TYPES.has(col.type)) continue;
    const before = templateItem.fields?.[col.key];
    const after = eventItem.fields?.[col.key];
    if (!sameValue(before, after)) {
      changes.push({
        field: `fields.${col.key}`,
        before: before ?? null,
        after: after ?? null,
      });
    }
  }
  return changes;
}

/**
 * Pair the event's items with the template's: exact matches via the
 * `sourceTemplateItemId` provenance link, then a lower-confidence
 * (module, title) fallback for unlinked rows (pre-provenance events,
 * hand-added items). Returns the pairs plus the leftovers on each side.
 */
function matchItems(sync: SyncContext) {
  const templateItemById = new Map(
    sync.templateItems.map((ti) => [String(ti._id), ti]),
  );
  const matchedTemplateIds = new Set<string>();
  const pairs: Array<{
    eventItem: Doc<"eventItems">;
    templateItem: Doc<"templateItems">;
    confidence: "exact" | "low";
  }> = [];
  const unmatchedEventItems: Doc<"eventItems">[] = [];

  // Pass 1 — exact provenance links (template row must still exist here).
  const needFallback: Doc<"eventItems">[] = [];
  for (const it of sync.eventItems) {
    const source = it.sourceTemplateItemId
      ? templateItemById.get(String(it.sourceTemplateItemId))
      : undefined;
    if (source) {
      matchedTemplateIds.add(String(source._id));
      pairs.push({ eventItem: it, templateItem: source, confidence: "exact" });
    } else {
      needFallback.push(it);
    }
  }
  // Pass 2 — (module, title) fallback against still-unmatched template items.
  for (const it of needFallback) {
    const candidate = sync.templateItems.find(
      (ti) =>
        !matchedTemplateIds.has(String(ti._id)) &&
        ti.module === it.module &&
        ti.title === it.title,
    );
    if (candidate) {
      matchedTemplateIds.add(String(candidate._id));
      pairs.push({ eventItem: it, templateItem: candidate, confidence: "low" });
    } else {
      unmatchedEventItems.push(it);
    }
  }
  const unmatchedTemplateItems = sync.templateItems.filter(
    (ti) => !matchedTemplateIds.has(String(ti._id)),
  );
  return { pairs, unmatchedEventItems, unmatchedTemplateItems };
}

/**
 * Diff an event against the template it was created from: which items were
 * added / structurally modified / removed on the event, which custom modules
 * (workstreams) the event added, and which column definitions diverged. This
 * is the read half of the promote flow — every entry maps 1:1 onto a
 * `promoteFromEvent` promotion.
 */
export const diffEventAgainstTemplate = query({
  args: { eventId: v.id("events") },
  handler: async (ctx, { eventId }) => {
    const { event, eventType } = await requireEventAndTemplate(ctx, eventId);
    const sync = await loadSyncContext(ctx, event, eventType);
    const { pairs, unmatchedEventItems, unmatchedTemplateItems } =
      matchItems(sync);

    const items: Array<
      | {
          kind: "new_in_event";
          eventItemId: Id<"eventItems">;
          module: string;
          title: string;
        }
      | {
          kind: "modified";
          eventItemId: Id<"eventItems">;
          templateItemId: Id<"templateItems">;
          module: string;
          title: string;
          confidence: "exact" | "low";
          changes: FieldChange[];
        }
      | {
          kind: "removed_in_event";
          templateItemId: Id<"templateItems">;
          module: string;
          title: string;
        }
    > = [];

    for (const { eventItem, templateItem, confidence } of pairs) {
      const changes = itemChanges(sync, event.eventDate, eventItem, templateItem);
      if (changes.length > 0) {
        items.push({
          kind: "modified",
          eventItemId: eventItem._id,
          templateItemId: templateItem._id,
          module: eventItem.module,
          title: eventItem.title,
          confidence,
          changes,
        });
      }
    }
    for (const it of unmatchedEventItems) {
      items.push({
        kind: "new_in_event",
        eventItemId: it._id,
        module: it.module,
        title: it.title,
      });
    }
    for (const ti of unmatchedTemplateItems) {
      items.push({
        kind: "removed_in_event",
        templateItemId: ti._id,
        module: ti.module,
        title: ti.title,
      });
    }

    // Custom modules (workstreams) present on the event but not the template —
    // matched by stable key.
    const templateModuleKeys = new Set(sync.templateModules.map((m) => m.key));
    const modules = sync.eventModules
      .filter((m) => !templateModuleKeys.has(m.key))
      .map((m) => ({
        kind: "new_workstream" as const,
        moduleKey: m.key,
        label: m.label,
      }));
    const newModuleKeys = new Set(modules.map((m) => m.moduleKey));

    // Column definitions: event columns missing from the template or diverging
    // on label/options. Columns of a brand-new workstream are skipped — they
    // ride along with its add_module promotion.
    const templateColByKey = new Map(
      sync.templateColumns.map((c) => [`${c.module}\u0000${c.key}`, c]),
    );
    const columns: Array<{
      kind: "column_change";
      change: "added" | "modified";
      module: string;
      key: string;
      label: string;
      before?: { label: string; options: unknown };
      after?: { label: string; options: unknown };
    }> = [];
    for (const c of sync.eventColumns) {
      if (newModuleKeys.has(c.module)) continue;
      const tc = templateColByKey.get(`${c.module}\u0000${c.key}`);
      if (!tc) {
        columns.push({
          kind: "column_change",
          change: "added",
          module: c.module,
          key: c.key,
          label: c.label,
        });
      } else if (
        tc.label !== c.label ||
        !sameValue(tc.options, c.options)
      ) {
        columns.push({
          kind: "column_change",
          change: "modified",
          module: c.module,
          key: c.key,
          label: c.label,
          before: { label: tc.label, options: tc.options ?? null },
          after: { label: c.label, options: c.options ?? null },
        });
      }
    }

    return {
      eventTypeId: eventType._id,
      // Current template version vs. the version this event was cloned from
      // (the existing drift display pairs these).
      templateVersion: eventType.version,
      eventTemplateVersion: event.templateVersion,
      items,
      modules,
      columns,
    };
  },
});

/** One entry in a `promoteFromEvent` batch. */
const promotionValidator = v.union(
  // Promote an event-only item into a new templateItems row (state stripped);
  // backfills the event item's sourceTemplateItemId so future diffs are exact.
  v.object({ kind: v.literal("add_item"), eventItemId: v.id("eventItems") }),
  // Patch an item's template source with its structural changes. `fields`
  // optionally restricts the patch to the named diff fields ("title",
  // "offsetDays", "offsetMinutes", "role", "fields.<key>"); omitted = all.
  // `templateItemId` pins the target explicitly (needed for low-confidence
  // matches); otherwise the provenance link / (module, title) fallback is used.
  v.object({
    kind: v.literal("update_item"),
    eventItemId: v.id("eventItems"),
    fields: v.optional(v.array(v.string())),
    templateItemId: v.optional(v.id("templateItems")),
  }),
  // Delete a template item whose clone was removed from the event.
  v.object({
    kind: v.literal("remove_item"),
    templateItemId: v.id("templateItems"),
  }),
  // Copy an event-only custom module (workstream) + its columns to the template.
  v.object({ kind: v.literal("add_module"), moduleKey: v.string() }),
  // Copy/patch one column definition (label/options/config) onto the template.
  v.object({ kind: v.literal("column"), module: v.string(), key: v.string() }),
);

/**
 * Apply a reviewed batch of event→template promotions. Structure only, never
 * state (see module doc). The whole batch is one transaction and bumps the
 * template's version exactly once — and only when at least one promotion
 * actually wrote (no-op entries neither appear in `applied` nor bump). Returns
 * the applied entries with the template-side ids they created or updated.
 */
export const promoteFromEvent = mutation({
  args: {
    eventId: v.id("events"),
    promotions: v.array(promotionValidator),
  },
  handler: async (ctx, { eventId, promotions }) => {
    const { event, eventType } = await requireEventAndTemplate(ctx, eventId);
    const sync = await loadSyncContext(ctx, event, eventType);

    // Event column types by (module, key) — used to strip state-valued cells
    // (photos, costs, people) out of promoted `fields` bags.
    const eventColType = new Map(
      sync.eventColumns.map((c) => [`${c.module}\u0000${c.key}`, c.type]),
    );

    /** The event item's fields bag reduced to structure-valued cells. */
    const promotableFields = (
      item: Doc<"eventItems">,
    ): Record<string, unknown> | undefined => {
      if (!item.fields) return undefined;
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(item.fields)) {
        const type = eventColType.get(`${item.module}\u0000${key}`);
        if (!type || STATE_VALUE_COLUMN_TYPES.has(type)) continue;
        out[key] = value;
      }
      return Object.keys(out).length > 0 ? out : undefined;
    };

    // Template roles by stable key. `ensureTemplateRole` remaps an event role
    // onto the template, creating (or reviving) the template role when the
    // event added one the template doesn't have.
    const templateRoleIdByKey = new Map(
      sync.templateRoles.map((r) => [r.key, r._id]),
    );
    const archivedRoleKeys = new Set(
      sync.templateRoles.filter((r) => r.isArchived === true).map((r) => r.key),
    );
    let nextRoleOrder = maxOrder(sync.templateRoles) + 1;

    // Next `order` per module, seeded lazily from the preloaded template items
    // (mirrors `nextRoleOrder`) and bumped in memory per insert — so several
    // add_items into the same module within one batch keep appending after each
    // other without re-collecting the module every time.
    const nextItemOrderByModule = new Map<string, number>();
    const nextItemOrder = (module: string): number => {
      const next =
        nextItemOrderByModule.get(module) ??
        maxOrder(sync.templateItems.filter((ti) => ti.module === module)) + 1;
      nextItemOrderByModule.set(module, next + 1);
      return next;
    };

    const ensureTemplateRole = async (
      eventRoleId: Id<"eventRoles"> | undefined,
    ): Promise<Id<"templateRoles"> | undefined> => {
      if (!eventRoleId) return undefined;
      const eventRole = sync.eventRoleById.get(String(eventRoleId));
      if (!eventRole) return undefined;
      const existing = templateRoleIdByKey.get(eventRole.key);
      if (existing) {
        // An archived role with this key would drop off future event clones —
        // promoting an item that uses it revives it.
        if (archivedRoleKeys.delete(eventRole.key))
          await ctx.db.patch(existing, { isArchived: false });
        return existing;
      }
      const newId = await ctx.db.insert("templateRoles", {
        eventTypeId: eventType._id,
        key: eventRole.key,
        label: eventRole.label,
        description: eventRole.description,
        order: nextRoleOrder++,
        isArchived: false,
      });
      templateRoleIdByKey.set(eventRole.key, newId);
      return newId;
    };

    /** Default status for a template row in `module` (state is never promoted). */
    const templateDefaultStatus = (module: string): string | undefined => {
      const statusCol = sync.templateColumns.find(
        (c) => c.module === module && c.key === "status" && c.type === "status",
      );
      return statusCol?.options?.[0]?.value ?? defaultStatusValue(module as ModuleKey);
    };

    /** Load + tenant-check an event item belonging to THIS event. */
    const requireEventItemOnEvent = async (
      eventItemId: Id<"eventItems">,
    ): Promise<Doc<"eventItems">> => {
      const item = await ctx.db.get(eventItemId);
      if (!item || item.eventId !== event._id) {
        throw new ConvexError({
          code: "NOT_FOUND",
          message: "Event item not found on this event.",
        });
      }
      return item;
    };

    const applied: Array<Record<string, unknown>> = [];

    for (const promo of promotions) {
      if (promo.kind === "add_item") {
        const item = await requireEventItemOnEvent(promo.eventItemId);
        const templateItemId = await ctx.db.insert("templateItems", {
          eventTypeId: eventType._id,
          module: item.module,
          title: item.title,
          order: nextItemOrder(item.module),
          offsetDays: effectiveOffsetDays(item, event.eventDate),
          offsetMinutes: item.offsetMinutes,
          roleId: await ensureTemplateRole(item.roleId),
          // Structure only: the template row starts at the module's default
          // status; owner / prePlanChecked / photos / costs are stripped.
          status: templateDefaultStatus(item.module),
          prePlanColumns: item.prePlanColumns,
          rowHeight: item.rowHeight,
          fields: promotableFields(item),
        });
        // Backfill provenance so future diffs match this pair exactly.
        await ctx.db.patch(item._id, { sourceTemplateItemId: templateItemId });
        applied.push({ kind: promo.kind, eventItemId: item._id, templateItemId });
      } else if (promo.kind === "update_item") {
        const item = await requireEventItemOnEvent(promo.eventItemId);
        // Resolve the template target: explicit id → provenance link →
        // (module, title) fallback.
        let target: Doc<"templateItems"> | null = null;
        if (promo.templateItemId) {
          target = await ctx.db.get(promo.templateItemId);
        } else if (item.sourceTemplateItemId) {
          target = await ctx.db.get(item.sourceTemplateItemId);
        } else {
          target =
            sync.templateItems.find(
              (ti) => ti.module === item.module && ti.title === item.title,
            ) ?? null;
        }
        if (!target || target.eventTypeId !== eventType._id) {
          throw new ConvexError({
            code: "NO_TEMPLATE_MATCH",
            message: `No template item matches "${item.title}" — promote it as a new item instead.`,
          });
        }
        const changes = itemChanges(sync, event.eventDate, item, target);
        const wanted = promo.fields ? new Set(promo.fields) : null;
        const patch: Record<string, unknown> = {};
        let fieldsPatch: Record<string, unknown> | null = null;
        for (const change of changes) {
          if (wanted && !wanted.has(change.field)) continue;
          if (change.field === "title") patch.title = item.title;
          else if (change.field === "offsetDays")
            patch.offsetDays = effectiveOffsetDays(item, event.eventDate);
          else if (change.field === "offsetMinutes")
            patch.offsetMinutes = item.offsetMinutes;
          else if (change.field === "role")
            patch.roleId = await ensureTemplateRole(item.roleId);
          else if (change.field.startsWith("fields.")) {
            const key = change.field.slice("fields.".length);
            fieldsPatch = fieldsPatch ?? { ...(target.fields ?? {}) };
            const value = item.fields?.[key];
            if (value === undefined || value === null) delete fieldsPatch[key];
            else fieldsPatch[key] = value;
          } else {
            // itemChanges() and this chain must stay in lockstep: a diff field
            // added there without a promote arm here should fail loudly, not
            // silently drop an approved change.
            throw new ConvexError({
              code: "PROMOTE_UNSUPPORTED_FIELD",
              message: `Promotion doesn't know how to apply field "${change.field}".`,
            });
          }
        }
        if (fieldsPatch) {
          patch.fields =
            Object.keys(fieldsPatch).length > 0 ? fieldsPatch : undefined;
        }
        // Backfill/repair provenance so future diffs match this pair exactly.
        // (An event-item link fix alone is not a template edit — it doesn't
        // count as an applied promotion or bump the version.)
        if (item.sourceTemplateItemId !== target._id)
          await ctx.db.patch(item._id, { sourceTemplateItemId: target._id });
        if (Object.keys(patch).length > 0) {
          await ctx.db.patch(target._id, patch);
          applied.push({
            kind: promo.kind,
            eventItemId: item._id,
            templateItemId: target._id,
            fields: Object.keys(patch),
          });
        }
      } else if (promo.kind === "remove_item") {
        const target = await ctx.db.get(promo.templateItemId);
        if (!target || target.eventTypeId !== eventType._id) {
          throw new ConvexError({
            code: "NOT_FOUND",
            message: "Template item not found on this event's template.",
          });
        }
        await ctx.db.delete(target._id);
        applied.push({ kind: promo.kind, templateItemId: target._id });
      } else if (promo.kind === "add_module") {
        const eventModule = sync.eventModules.find(
          (m) => m.key === promo.moduleKey,
        );
        if (!eventModule) {
          throw new ConvexError({
            code: "NOT_FOUND",
            message: `"${promo.moduleKey}" is not a custom module on this event.`,
          });
        }
        // Idempotent: the template already has this workstream (by key) — a
        // no-op, so it's not an applied write and mustn't bump the version.
        const existing = sync.templateModules.find(
          (m) => m.key === promo.moduleKey,
        );
        if (existing) continue;
        const templateModuleId = await ctx.db.insert("templateModules", {
          eventTypeId: eventType._id,
          key: eventModule.key,
          label: eventModule.label,
          ownerRoleKey: eventModule.ownerRoleKey,
          offsetMode: eventModule.offsetMode,
          order: maxOrder(sync.templateModules) + 1,
          isActive: true,
        });
        // Bring the workstream's column set along so its promoted items render.
        for (const c of sync.eventColumns.filter(
          (col) => col.module === eventModule.key,
        )) {
          const { _id, _creationTime, eventId: _e, ...rest } = c;
          await ctx.db.insert("templateColumns", {
            eventTypeId: eventType._id,
            ...rest,
          });
        }
        applied.push({ kind: promo.kind, moduleKey: promo.moduleKey, templateModuleId });
      } else {
        // promo.kind === "column"
        const eventCol = sync.eventColumns.find(
          (c) => c.module === promo.module && c.key === promo.key,
        );
        if (!eventCol) {
          throw new ConvexError({
            code: "NOT_FOUND",
            message: `Column "${promo.key}" not found on this event's "${promo.module}" module.`,
          });
        }
        const templateCol = sync.templateColumns.find(
          (c) => c.module === promo.module && c.key === promo.key,
        );
        let templateColumnId: Id<"templateColumns">;
        if (templateCol) {
          await ctx.db.patch(templateCol._id, {
            label: eventCol.label,
            options: eventCol.options,
            config: eventCol.config,
          });
          templateColumnId = templateCol._id;
        } else {
          const siblings = sync.templateColumns.filter(
            (c) => c.module === promo.module,
          );
          templateColumnId = await ctx.db.insert("templateColumns", {
            eventTypeId: eventType._id,
            module: eventCol.module,
            key: eventCol.key,
            label: eventCol.label,
            kind: eventCol.kind,
            type: eventCol.type,
            options: eventCol.options,
            config: eventCol.config,
            isVisible: eventCol.isVisible,
            order: maxOrder(siblings) + 1,
          });
        }
        applied.push({
          kind: promo.kind,
          module: promo.module,
          key: promo.key,
          templateColumnId,
        });
      }
    }

    // One batch with ≥1 structural edit → exactly one version bump, so the
    // existing `events.templateVersion` drift display keeps working. `applied`
    // only collects entries that actually wrote, so an all-no-op batch (e.g. an
    // update_item whose patch ended empty) leaves the version untouched.
    if (applied.length > 0) await bumpVersion(ctx, eventType._id);

    return { eventTypeId: eventType._id, applied };
  },
});
