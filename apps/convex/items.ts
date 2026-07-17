/**
 * Items — the unified rows behind every planning module (planning doc, supplies,
 * comms, run-of-show), on both templates and live events.
 *
 * The few fields the backend reasons about are promoted columns on each item
 * (title, offset, status, role, owner); everything else lives in the `fields`
 * bag keyed by custom-column key. Day-offset modules (planning_doc, comms) carry
 * a signed `offsetDays` and a back-calculated `dueDate`; run-of-show carries
 * `offsetMinutes`. Editing the event date re-derives every due date (see
 * events.reschedule).
 */
import { query, mutation, QueryCtx, MutationCtx } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { v, ConvexError } from "convex/values";
import {
  deleteEventPlacementsForRef,
  deleteTemplatePlacementsForRef,
} from "./lib/placements";
import {
  computeDueDate,
  computeReadiness,
  isCompleteStatus,
  deriveSupplyStatus,
  DAY_OFFSET_MODULES,
  type ModuleKey,
  type LinkedAssetState,
} from "@events-os/shared";
import {
  requireChapterId,
  requireEvent,
  requireManagedEventType,
  requireOwned,
  requireUserId,
} from "./lib/context";
import {
  bumpVersion,
  maxOrder,
  eventActiveModules,
  templateActiveModules,
} from "./lib/templates";

const fieldsValidator = v.optional(v.record(v.string(), v.any()));

function isDayOffsetModule(module: string): boolean {
  return DAY_OFFSET_MODULES.includes(module as ModuleKey);
}

/**
 * Assert `module` is one of the event's resolved ACTIVE modules — rejecting
 * arbitrary/disabled module strings so an item can't be written against a
 * surface the event doesn't have. Throws a ConvexError when it isn't.
 */
async function requireActiveEventModule(
  ctx: QueryCtx,
  event: Doc<"events">,
  module: string,
): Promise<void> {
  const active = await eventActiveModules(ctx, event);
  if (!active.some((m) => m.key === module)) {
    throw new ConvexError({
      code: "UNKNOWN_MODULE",
      message: `"${module}" is not an active module on this event.`,
    });
  }
}

/** Same as `requireActiveEventModule` but for a template's active modules. */
async function requireActiveTemplateModule(
  ctx: QueryCtx,
  eventType: Doc<"eventTypes">,
  module: string,
): Promise<void> {
  const active = await templateActiveModules(ctx, eventType);
  if (!active.some((m) => m.key === module)) {
    throw new ConvexError({
      code: "UNKNOWN_MODULE",
      message: `"${module}" is not an active module on this template.`,
    });
  }
}

/**
 * A `budgetCategoryId` override, if any, must belong to the CALLER's own
 * chapter (categories are always chapter-scoped) AND be active — mirrors
 * `budgetLines.ts#verifyCategory`, plus the active check the Money-page plan
 * view (a follow-up PR) needs: a row shouldn't silently point at a category a
 * chapter retired.
 */
async function verifyCategory(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
  categoryId: Id<"budgetCategories"> | null | undefined,
): Promise<void> {
  if (!categoryId) return;
  const category = await ctx.db.get(categoryId);
  if (!category || category.chapterId !== chapterId) {
    throw new ConvexError({
      code: "NOT_FOUND",
      message: "Category not found in your chapter.",
    });
  }
  if (category.isActive === false) {
    throw new ConvexError({
      code: "INACTIVE_CATEGORY",
      message: "This category is no longer active.",
    });
  }
}

/** Merge a `fields` patch into existing fields (so single-cell edits don't wipe). */
function mergeFields(
  existing: Record<string, any> | undefined,
  patch: Record<string, any> | undefined,
): Record<string, any> | undefined {
  if (patch === undefined) return existing;
  const merged = { ...(existing ?? {}) };
  for (const [k, val] of Object.entries(patch)) {
    if (val === null) delete merged[k];
    else merged[k] = val;
  }
  return merged;
}

/** The status column's options for a module's column set, if any. */
function statusOptions(columns: Array<any>): Array<any> | undefined {
  return columns.find((c) => c.key === "status" && c.type === "status")
    ?.options;
}

// ── Supplies ⇄ Inventory bridge ───────────────────────────────────────────────
// A supply row with Source = Chapter Storage links a chapter asset
// (fields.linkedAssetId). The link keeps an assetReservation in sync (so the
// registry and other events see the claim + its container), and the row's Status
// is DERIVED from Packed-in + Source + the linked asset's live state. See
// docs/plans/inventory-supplies-unification.md.

/** Event statuses that hold a live reservation on gear. */
const LIVE_EVENT_STATUSES = new Set(["planning", "ready"]);

/** Read `fields.qty` as a ≥1 integer (default 1). */
function supplyQty(fields: Record<string, any> | undefined): number {
  return Math.max(1, Math.trunc(Number(fields?.qty) || 1));
}

/** Delete this event's reservation on an asset, if any. */
async function releaseReservation(
  ctx: MutationCtx,
  assetId: Id<"assets">,
  eventId: Id<"events">,
): Promise<void> {
  const r = await ctx.db
    .query("assetReservations")
    .withIndex("by_asset_event", (q) =>
      q.eq("assetId", assetId).eq("eventId", eventId),
    )
    .unique();
  if (r) await ctx.db.delete(r._id);
}

/**
 * Reconcile the assetReservation a supplies row owns after an add/update.
 * `prevLinkedAssetId` is the link BEFORE this write (so a re-link or unlink can
 * release the stale claim). A row reserves only when Source = Chapter Storage
 * with a link; the reserved quantity is the row's qty, and its container is
 * denormalized onto the reservation so other events read its location.
 */
async function reconcileSupplyReservation(
  ctx: MutationCtx,
  event: Doc<"events">,
  item: Doc<"eventItems">,
  prevLinkedAssetId?: Id<"assets">,
): Promise<void> {
  if (item.module !== "supplies") return;
  const fields = item.fields ?? {};
  const linked =
    fields.source === "chapter_storage"
      ? (fields.linkedAssetId as Id<"assets"> | undefined)
      : undefined;

  if (prevLinkedAssetId && prevLinkedAssetId !== linked) {
    await releaseReservation(ctx, prevLinkedAssetId, event._id);
  }
  if (!linked) return;

  const asset = await ctx.db.get(linked);
  if (!asset || asset.chapterId !== event.chapterId) return;

  const quantity = supplyQty(fields);
  const container = (fields.container as string | undefined) || undefined;
  const existing = await ctx.db
    .query("assetReservations")
    .withIndex("by_asset_event", (q) =>
      q.eq("assetId", linked).eq("eventId", event._id),
    )
    .unique();
  if (existing) {
    await ctx.db.patch(existing._id, { quantity, container });
  } else {
    const userId = await requireUserId(ctx);
    await ctx.db.insert("assetReservations", {
      assetId: linked,
      eventId: event._id,
      chapterId: asset.chapterId,
      quantity,
      container,
      createdBy: userId as Id<"users">,
      createdAt: Date.now(),
    });
  }
}

/**
 * Resolve the live inventory state of the asset a supply row links to, from the
 * VIEWING event's perspective: on-hand, available after OTHER live events, and
 * whether another live event currently holds it (real-time location). Returns
 * null when the row isn't storage-linked.
 */
async function linkedAssetStateFor(
  ctx: QueryCtx,
  item: Doc<"eventItems">,
  liveEventIds: Set<string>,
  eventName: Map<string, string>,
): Promise<LinkedAssetState | null> {
  const fields = item.fields ?? {};
  if (fields.source !== "chapter_storage") return null;
  const linkedId = fields.linkedAssetId as Id<"assets"> | undefined;
  if (!linkedId) return null;
  const asset = await ctx.db.get(linkedId);
  if (!asset) return null;

  const reservations = await ctx.db
    .query("assetReservations")
    .withIndex("by_asset", (q) => q.eq("assetId", linkedId))
    .collect();
  const others = reservations.filter(
    (r) => r.eventId !== item.eventId && liveEventIds.has(String(r.eventId)),
  );
  const reservedElsewhere = others.reduce((s, r) => s + r.quantity, 0);
  const holder = others.sort((a, b) => a.createdAt - b.createdAt)[0];
  return {
    onHand: asset.quantity,
    available: Math.max(0, asset.quantity - reservedElsewhere),
    consumable: asset.consumable ?? false,
    committedElsewhere: holder
      ? {
          eventName: eventName.get(String(holder.eventId)) ?? "Another event",
          container: holder.container ?? null,
        }
      : null,
  };
}

// ── Template items ────────────────────────────────────────────────────────────
/** A template module: its ordered columns + items. */
export const listForTemplate = query({
  args: { eventTypeId: v.id("eventTypes"), module: v.string() },
  handler: async (ctx, { eventTypeId, module }) => {
    const chapterId = await requireChapterId(ctx);
    const et = await ctx.db.get(eventTypeId);
    if (!et || et.chapterId !== chapterId)
      return { columns: [], items: [] };
    const columns = (
      await ctx.db
        .query("templateColumns")
        .withIndex("by_eventType_module", (q) =>
          q.eq("eventTypeId", eventTypeId).eq("module", module),
        )
        .collect()
    ).sort((a, b) => a.order - b.order);
    const items = (
      await ctx.db
        .query("templateItems")
        .withIndex("by_eventType_module", (q) =>
          q.eq("eventTypeId", eventTypeId).eq("module", module),
        )
        .collect()
    ).sort((a, b) => a.order - b.order);
    return { columns, items };
  },
});

export const addTemplateItem = mutation({
  args: {
    eventTypeId: v.id("eventTypes"),
    module: v.string(),
    title: v.optional(v.string()),
    offsetDays: v.optional(v.number()),
    offsetMinutes: v.optional(v.number()),
    roleId: v.optional(v.id("templateRoles")),
    status: v.optional(v.string()),
    fields: fieldsValidator,
  },
  handler: async (ctx, args) => {
    const et = await requireManagedEventType(ctx, args.eventTypeId);
    await requireActiveTemplateModule(ctx, et, args.module);
    const items = await ctx.db
      .query("templateItems")
      .withIndex("by_eventType_module", (q) =>
        q.eq("eventTypeId", args.eventTypeId).eq("module", args.module),
      )
      .collect();
    const id = await ctx.db.insert("templateItems", {
      eventTypeId: args.eventTypeId,
      module: args.module,
      title: args.title ?? "",
      order: maxOrder(items) + 1,
      offsetDays: args.offsetDays,
      offsetMinutes: args.offsetMinutes,
      roleId: args.roleId,
      status: args.status,
      fields: args.fields,
    });
    await bumpVersion(ctx, args.eventTypeId);
    return id;
  },
});

export const updateTemplateItem = mutation({
  args: {
    itemId: v.id("templateItems"),
    title: v.optional(v.string()),
    offsetDays: v.optional(v.number()),
    offsetMinutes: v.optional(v.number()),
    roleId: v.optional(v.union(v.id("templateRoles"), v.null())),
    status: v.optional(v.union(v.string(), v.null())),
    // Manual row height (px); null resets the row back to auto-fit.
    rowHeight: v.optional(v.union(v.number(), v.null())),
    fields: fieldsValidator,
  },
  handler: async (ctx, { itemId, ...patch }) => {
    const item = await ctx.db.get(itemId);
    if (!item) return itemId;
    await requireManagedEventType(ctx, item.eventTypeId);
    const fields: Record<string, unknown> = {};
    if (patch.title !== undefined) fields.title = patch.title;
    if (patch.offsetDays !== undefined) fields.offsetDays = patch.offsetDays;
    if (patch.offsetMinutes !== undefined)
      fields.offsetMinutes = patch.offsetMinutes;
    if (patch.roleId !== undefined) fields.roleId = patch.roleId ?? undefined;
    if (patch.status !== undefined) fields.status = patch.status ?? undefined;
    if (patch.rowHeight !== undefined)
      fields.rowHeight = patch.rowHeight ?? undefined;
    if (patch.fields !== undefined)
      fields.fields = mergeFields(item.fields, patch.fields);
    await ctx.db.patch(itemId, fields);
    await bumpVersion(ctx, item.eventTypeId);
    return itemId;
  },
});

/**
 * Toggle whether a column on a template item is marked "pre-plan" (a cell that
 * needs explicit sign-off before the event). Marks live on the templateItem's
 * `prePlanColumns`; they clone onto every event spun up from the template.
 */
export const toggleTemplatePrePlan = mutation({
  args: { itemId: v.id("templateItems"), colKey: v.string() },
  handler: async (ctx, { itemId, colKey }) => {
    const item = await ctx.db.get(itemId);
    if (!item) return itemId;
    await requireManagedEventType(ctx, item.eventTypeId);
    const current = item.prePlanColumns ?? [];
    const next = current.includes(colKey)
      ? current.filter((k) => k !== colKey)
      : [...current, colKey];
    await ctx.db.patch(itemId, {
      prePlanColumns: next.length > 0 ? next : undefined,
    });
    await bumpVersion(ctx, item.eventTypeId);
    return itemId;
  },
});

export const removeTemplateItem = mutation({
  args: { itemId: v.id("templateItems") },
  handler: async (ctx, { itemId }) => {
    const item = await ctx.db.get(itemId);
    if (!item) return itemId;
    await requireManagedEventType(ctx, item.eventTypeId);
    // Cascade: drop any site-map chips pointing at this supply item.
    if (item.module === "supplies") {
      await deleteTemplatePlacementsForRef(
        ctx,
        String(item.eventTypeId),
        "supply",
        String(itemId),
      );
    }
    await ctx.db.delete(itemId);
    await bumpVersion(ctx, item.eventTypeId);
    return itemId;
  },
});

export const reorderTemplateItems = mutation({
  args: {
    eventTypeId: v.id("eventTypes"),
    module: v.string(),
    orderedIds: v.array(v.id("templateItems")),
  },
  handler: async (ctx, { eventTypeId, module, orderedIds }) => {
    await requireManagedEventType(ctx, eventTypeId);
    for (let i = 0; i < orderedIds.length; i++) {
      const item = await ctx.db.get(orderedIds[i]);
      if (item && item.eventTypeId === eventTypeId && item.module === module) {
        await ctx.db.patch(orderedIds[i], { order: i });
      }
    }
    await bumpVersion(ctx, eventTypeId);
    return eventTypeId;
  },
});

// ── Event items ───────────────────────────────────────────────────────────────
/** An event module: its cloned columns + items (with role/owner names) + readiness. */
export const listForEventModule = query({
  args: { eventId: v.id("events"), module: v.string() },
  handler: async (ctx, { eventId, module }) => {
    const chapterId = await requireChapterId(ctx);
    const event = await ctx.db.get(eventId);
    if (!event || event.chapterId !== chapterId)
      return { columns: [], items: [], summary: { total: 0, complete: 0, readiness: 0 } };

    const columns = (
      await ctx.db
        .query("eventColumns")
        .withIndex("by_event_module", (q) =>
          q.eq("eventId", eventId).eq("module", module),
        )
        .collect()
    ).sort((a, b) => a.order - b.order);

    const rawItems = (
      await ctx.db
        .query("eventItems")
        .withIndex("by_event_module", (q) =>
          q.eq("eventId", eventId).eq("module", module),
        )
        .collect()
    ).sort((a, b) => a.order - b.order);

    // Map each event role → its assigned person, so an item's owner can be
    // auto-derived from its role (with an explicit ownerPersonId as override).
    const assignments = await ctx.db
      .query("roleAssignments")
      .withIndex("by_event", (q) => q.eq("eventId", eventId))
      .collect();
    const roleToPerson = new Map<string, Id<"people">>(
      assignments.map((a) => [String(a.roleId), a.personId]),
    );

    const items = await Promise.all(
      rawItems.map(async (it) => {
        let roleLabel: string | null = null;
        if (it.roleId) {
          const role = await ctx.db.get(it.roleId as Id<"eventRoles">);
          roleLabel = role?.label ?? null;
        }
        // Explicit owner wins; otherwise inherit the person holding the role.
        const inheritedId = it.roleId
          ? roleToPerson.get(String(it.roleId))
          : undefined;
        const effectiveOwnerId = it.ownerPersonId ?? inheritedId;
        const ownerIsInherited = !it.ownerPersonId && !!inheritedId;
        let owner: { _id: Id<"people">; name: string } | null = null;
        if (effectiveOwnerId) {
          const person = await ctx.db.get(effectiveOwnerId as Id<"people">);
          if (person) owner = { _id: person._id, name: person.name };
        }
        return { ...it, roleLabel, owner, ownerIsInherited };
      }),
    );

    // Supplies: DERIVE each row's status from Packed-in + Source + the linked
    // asset's live state (with fields.statusOverride as the manual escape hatch),
    // and surface the "Event · Container" detail for cross-event holds. Only the
    // supplies module pays this cost.
    let displayItems: typeof items = items;
    if (module === "supplies") {
      const chapterEvents = await ctx.db
        .query("events")
        .withIndex("by_chapter", (q) =>
          q.eq("chapterId", chapterId as Id<"chapters">),
        )
        .collect();
      const liveEventIds = new Set(
        chapterEvents
          .filter((e) => LIVE_EVENT_STATUSES.has(e.status))
          .map((e) => String(e._id)),
      );
      const eventName = new Map(
        chapterEvents.map((e) => [String(e._id), e.name] as const),
      );
      displayItems = await Promise.all(
        items.map(async (it) => {
          const fields = it.fields ?? {};
          const asset = await linkedAssetStateFor(
            ctx,
            it as Doc<"eventItems">,
            liveEventIds,
            eventName,
          );
          const derived = deriveSupplyStatus({
            container: fields.container,
            source: fields.source,
            needed: supplyQty(fields),
            ordered: fields.ordered,
            override: fields.statusOverride,
            asset,
          });
          return {
            ...it,
            status: derived.value,
            statusDetail: derived.detail ?? null,
            statusIsDerived: !derived.isOverride,
          };
        }),
      );
    }

    const opts = statusOptions(columns);
    const total = rawItems.length;
    const complete = opts
      ? displayItems.filter((it) => isCompleteStatus(opts, it.status)).length
      : 0;

    return {
      columns,
      items: displayItems,
      summary: { total, complete, readiness: computeReadiness(total, complete) },
    };
  },
});

export const addEventItem = mutation({
  args: {
    eventId: v.id("events"),
    module: v.string(),
    title: v.optional(v.string()),
    offsetDays: v.optional(v.number()),
    offsetMinutes: v.optional(v.number()),
    roleId: v.optional(v.id("eventRoles")),
    ownerPersonId: v.optional(v.id("people")),
    status: v.optional(v.string()),
    fields: fieldsValidator,
  },
  handler: async (ctx, args) => {
    const event = await requireEvent(ctx, args.eventId);
    await requireActiveEventModule(ctx, event, args.module);
    const items = await ctx.db
      .query("eventItems")
      .withIndex("by_event_module", (q) =>
        q.eq("eventId", args.eventId).eq("module", args.module),
      )
      .collect();
    const dueDate =
      isDayOffsetModule(args.module) && args.offsetDays !== undefined
        ? computeDueDate(event.eventDate, args.offsetDays)
        : undefined;
    const itemId = await ctx.db.insert("eventItems", {
      eventId: args.eventId,
      chapterId: event.chapterId,
      module: args.module,
      title: args.title ?? "",
      order: maxOrder(items) + 1,
      offsetDays: args.offsetDays,
      offsetMinutes: args.offsetMinutes,
      dueDate,
      roleId: args.roleId,
      ownerPersonId: args.ownerPersonId,
      status: args.status,
      fields: args.fields,
    });
    // Keep the inventory reservation in sync if the new row links an asset.
    if (args.module === "supplies") {
      const created = await ctx.db.get(itemId);
      if (created) await reconcileSupplyReservation(ctx, event, created);
    }
    return itemId;
  },
});

export const updateEventItem = mutation({
  args: {
    itemId: v.id("eventItems"),
    title: v.optional(v.string()),
    // null unschedules the item (clears its offset and derived due date).
    offsetDays: v.optional(v.union(v.number(), v.null())),
    offsetMinutes: v.optional(v.number()),
    roleId: v.optional(v.union(v.id("eventRoles"), v.null())),
    ownerPersonId: v.optional(v.union(v.id("people"), v.null())),
    status: v.optional(v.union(v.string(), v.null())),
    // Manual row height (px); null resets the row back to auto-fit.
    rowHeight: v.optional(v.union(v.number(), v.null())),
    // Money-page category override; null clears back to the module default
    // mapping (`MODULE_DEFAULT_CATEGORY_NAMES`, applied at read time).
    budgetCategoryId: v.optional(v.union(v.id("budgetCategories"), v.null())),
    fields: fieldsValidator,
  },
  handler: async (ctx, { itemId, ...patch }) => {
    const item = await ctx.db.get(itemId);
    if (!item) return itemId;
    const event = await requireEvent(ctx, item.eventId);
    const isSupply = item.module === "supplies";
    const prevLinkedAssetId = isSupply
      ? (item.fields?.linkedAssetId as Id<"assets"> | undefined)
      : undefined;
    const fields: Record<string, unknown> = {};
    if (patch.title !== undefined) fields.title = patch.title;
    if (patch.offsetMinutes !== undefined)
      fields.offsetMinutes = patch.offsetMinutes;
    if (patch.roleId !== undefined) fields.roleId = patch.roleId ?? undefined;
    if (patch.ownerPersonId !== undefined)
      fields.ownerPersonId = patch.ownerPersonId ?? undefined;
    if (patch.status !== undefined) fields.status = patch.status ?? undefined;
    if (patch.rowHeight !== undefined)
      fields.rowHeight = patch.rowHeight ?? undefined;
    if (patch.budgetCategoryId !== undefined) {
      if (patch.budgetCategoryId !== null) {
        await verifyCategory(ctx, event.chapterId, patch.budgetCategoryId);
      }
      fields.budgetCategoryId = patch.budgetCategoryId ?? undefined;
    }
    // Supplies: a manual status pick from the grid becomes the derived-status
    // OVERRIDE (fields.statusOverride); clearing it (null) reverts to auto.
    let bagPatch = patch.fields;
    if (isSupply && patch.status !== undefined) {
      bagPatch = { ...(bagPatch ?? {}), statusOverride: patch.status ?? null };
    }
    if (bagPatch !== undefined)
      fields.fields = mergeFields(item.fields, bagPatch);
    if (patch.offsetDays !== undefined) {
      fields.offsetDays = patch.offsetDays ?? undefined;
      if (isDayOffsetModule(item.module)) {
        fields.dueDate =
          patch.offsetDays == null
            ? undefined
            : computeDueDate(event.eventDate, patch.offsetDays);
      }
    }
    await ctx.db.patch(itemId, fields);
    // Re-sync the inventory reservation when a supply row's link/qty/container
    // changed (or was cleared).
    if (isSupply) {
      const updated = await ctx.db.get(itemId);
      if (updated)
        await reconcileSupplyReservation(ctx, event, updated, prevLinkedAssetId);
    }
    return itemId;
  },
});

/** Set an item's status (the common one-tap edit). */
export const setStatus = mutation({
  args: { itemId: v.id("eventItems"), status: v.union(v.string(), v.null()) },
  handler: async (ctx, { itemId, status }) => {
    const item = await ctx.db.get(itemId);
    if (!item) return itemId;
    await requireEvent(ctx, item.eventId);
    // Supplies status is derived; a one-tap pick is a manual override (cleared
    // with null → back to auto).
    if (item.module === "supplies") {
      const fields = mergeFields(item.fields, { statusOverride: status ?? null });
      await ctx.db.patch(itemId, { status: status ?? undefined, fields });
      return itemId;
    }
    await ctx.db.patch(itemId, { status: status ?? undefined });
    return itemId;
  },
});

/**
 * Tick / untick a pre-plan cell on an event item. `colKey` must be one of the
 * item's `prePlanColumns` (the template author's marks). Toggling adds/removes
 * the key in `prePlanChecked`; pre-plan% = checked ÷ marked across the event.
 */
export const togglePrePlanChecked = mutation({
  args: { itemId: v.id("eventItems"), colKey: v.string() },
  handler: async (ctx, { itemId, colKey }) => {
    const item = await ctx.db.get(itemId);
    if (!item) return itemId;
    await requireEvent(ctx, item.eventId);
    // Only checkable if the cell was actually marked pre-plan on this row.
    const marked = item.prePlanColumns ?? [];
    if (!marked.includes(colKey)) return itemId;
    const current = item.prePlanChecked ?? [];
    const next = current.includes(colKey)
      ? current.filter((k) => k !== colKey)
      : [...current, colKey];
    await ctx.db.patch(itemId, {
      prePlanChecked: next.length > 0 ? next : undefined,
    });
    return itemId;
  },
});

/** Assign or clear an item's owner. */
export const assignOwner = mutation({
  args: {
    itemId: v.id("eventItems"),
    personId: v.optional(v.union(v.id("people"), v.null())),
  },
  handler: async (ctx, { itemId, personId }) => {
    const item = await ctx.db.get(itemId);
    if (!item) return itemId;
    await requireEvent(ctx, item.eventId);
    if (personId) {
      await requireOwned(ctx, "people", personId, "Person");
    }
    await ctx.db.patch(itemId, { ownerPersonId: personId ?? undefined });
    return itemId;
  },
});

export const removeEventItem = mutation({
  args: { itemId: v.id("eventItems") },
  handler: async (ctx, { itemId }) => {
    const item = await ctx.db.get(itemId);
    if (!item) return itemId;
    await requireEvent(ctx, item.eventId);
    // Cascade: drop any site-map chips pointing at this supply item, and release
    // the inventory reservation the row held (if it linked a Chapter-Storage asset).
    if (item.module === "supplies") {
      await deleteEventPlacementsForRef(
        ctx,
        String(item.eventId),
        "supply",
        String(itemId),
      );
      const linked = item.fields?.linkedAssetId as Id<"assets"> | undefined;
      if (linked) await releaseReservation(ctx, linked, item.eventId);
    }
    await ctx.db.delete(itemId);
    return itemId;
  },
});

export const reorderEventItems = mutation({
  args: {
    eventId: v.id("events"),
    module: v.string(),
    orderedIds: v.array(v.id("eventItems")),
  },
  handler: async (ctx, { eventId, module, orderedIds }) => {
    await requireEvent(ctx, eventId);
    for (let i = 0; i < orderedIds.length; i++) {
      const item = await ctx.db.get(orderedIds[i]);
      if (item && item.eventId === eventId && item.module === module) {
        await ctx.db.patch(orderedIds[i], { order: i });
      }
    }
    return eventId;
  },
});
