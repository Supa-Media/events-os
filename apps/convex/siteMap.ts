/**
 * Site map — a venue layout for an event: a background image plus labelled,
 * categorized markers placed at normalized (x,y) positions. Used to plan where
 * teams set up, where equipment drops, where stations and the stage go.
 */
import { query, mutation } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { v } from "convex/values";
import {
  requireChapterId,
  requireInChapter,
  getChapterIdOrNull,
} from "./lib/context";

const isHttpUrl = (v: unknown) =>
  typeof v === "string" && /^https?:\/\//i.test(v);

/**
 * Scope for site-map reads/writes: a live EVENT or a reusable TEMPLATE.
 * Markers/shapes/image work on either; placements (which reference per-event
 * rows) stay event-only and don't accept a scope.
 */
const scopeArg = v.union(
  v.object({ kind: v.literal("event"), eventId: v.id("events") }),
  v.object({ kind: v.literal("template"), eventTypeId: v.id("eventTypes") }),
);
type Scope =
  | { kind: "event"; eventId: Id<"events"> }
  | { kind: "template"; eventTypeId: Id<"eventTypes"> };

/**
 * Load the parent (event or eventType) for a scope and assert it's in the
 * caller's chapter. Returns the parent doc so callers can read its image field.
 * Throws (via requireInChapter) when the parent is missing or cross-chapter.
 */
async function requireScopeParent(ctx: any, chapterId: string, scope: Scope) {
  if (scope.kind === "event") {
    const event = await ctx.db.get(scope.eventId);
    await requireInChapter(ctx, chapterId, event, "Event");
    return event;
  }
  const eventType = await ctx.db.get(scope.eventTypeId);
  await requireInChapter(ctx, chapterId, eventType, "Template");
  return eventType;
}

/** Collect a scope's markers via the right index (by_event / by_template). */
async function markersForScope(ctx: any, scope: Scope) {
  return scope.kind === "event"
    ? ctx.db
        .query("siteMarkers")
        .withIndex("by_event", (q: any) => q.eq("eventId", scope.eventId))
        .collect()
    : ctx.db
        .query("siteMarkers")
        .withIndex("by_template", (q: any) =>
          q.eq("eventTypeId", scope.eventTypeId),
        )
        .collect();
}

/** Collect a scope's shapes via the right index (by_event / by_template). */
async function shapesForScope(ctx: any, scope: Scope) {
  return scope.kind === "event"
    ? ctx.db
        .query("siteShapes")
        .withIndex("by_event", (q: any) => q.eq("eventId", scope.eventId))
        .collect()
    : ctx.db
        .query("siteShapes")
        .withIndex("by_template", (q: any) =>
          q.eq("eventTypeId", scope.eventTypeId),
        )
        .collect();
}

/** The map image URL (resolved) + every marker and shape for a scope. */
export const get = query({
  args: { scope: scopeArg },
  handler: async (ctx, { scope }) => {
    const chapterId = await getChapterIdOrNull(ctx);
    if (!chapterId) return { imageUrl: null, markers: [], shapes: [] };
    const parent = await ctx.db.get(
      scope.kind === "event" ? scope.eventId : scope.eventTypeId,
    );
    if (!parent || (parent as any).chapterId !== chapterId)
      return { imageUrl: null, markers: [], shapes: [] };

    let imageUrl: string | null = null;
    const img = (parent as any).siteMapImage;
    if (img) {
      imageUrl = isHttpUrl(img)
        ? img
        : await ctx.storage.getUrl(img as Id<"_storage">);
    }

    const markers = (await markersForScope(ctx, scope))
      .sort((a: any, b: any) => a.createdAt - b.createdAt)
      .map((m: any) => ({
        _id: m._id,
        x: m.x,
        y: m.y,
        label: m.label,
        color: m.color ?? null,
        category: m.category ?? null,
      }));

    const shapes = (await shapesForScope(ctx, scope))
      .sort((a: any, b: any) => a.createdAt - b.createdAt)
      .map((s: any) => ({
        _id: s._id,
        type: s.type,
        x: s.x,
        y: s.y,
        w: s.w ?? null,
        h: s.h ?? null,
        x2: s.x2 ?? null,
        y2: s.y2 ?? null,
        color: s.color ?? null,
        label: s.label ?? null,
      }));

    return { imageUrl, markers, shapes };
  },
});

/** Set (or replace) the venue map background image. Pass null to clear. */
export const setImage = mutation({
  args: {
    scope: scopeArg,
    storageId: v.union(v.id("_storage"), v.string(), v.null()),
  },
  handler: async (ctx, { scope, storageId }) => {
    const chapterId = await requireChapterId(ctx);
    await requireScopeParent(ctx, chapterId, scope);
    const parentId =
      scope.kind === "event" ? scope.eventId : scope.eventTypeId;
    await ctx.db.patch(parentId, {
      siteMapImage: storageId ?? undefined,
      updatedAt: Date.now(),
    });
    return parentId;
  },
});

/** The scope-keyed parent field set on a new marker/shape row. */
function scopeFields(scope: Scope) {
  return scope.kind === "event"
    ? { eventId: scope.eventId }
    : { eventTypeId: scope.eventTypeId };
}

/** Drop a new labelled point on the map (free color + label). */
export const addMarker = mutation({
  args: {
    scope: scopeArg,
    x: v.number(),
    y: v.number(),
    label: v.optional(v.string()),
    color: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const chapterId = await requireChapterId(ctx);
    await requireScopeParent(ctx, chapterId, args.scope);
    return await ctx.db.insert("siteMarkers", {
      chapterId: chapterId as Id<"chapters">,
      ...scopeFields(args.scope),
      x: Math.max(0, Math.min(1, args.x)),
      y: Math.max(0, Math.min(1, args.y)),
      label: args.label ?? "",
      color: args.color ?? "red",
      createdAt: Date.now(),
    });
  },
});

/** Move / relabel / recolor a marker. */
export const updateMarker = mutation({
  args: {
    markerId: v.id("siteMarkers"),
    x: v.optional(v.number()),
    y: v.optional(v.number()),
    label: v.optional(v.string()),
    color: v.optional(v.string()),
  },
  handler: async (ctx, { markerId, ...patch }) => {
    const chapterId = await requireChapterId(ctx);
    const marker = await ctx.db.get(markerId);
    await requireInChapter(ctx, chapterId, marker, "Marker");
    const fields: Record<string, unknown> = {};
    if (patch.x !== undefined) fields.x = Math.max(0, Math.min(1, patch.x));
    if (patch.y !== undefined) fields.y = Math.max(0, Math.min(1, patch.y));
    if (patch.label !== undefined) fields.label = patch.label;
    if (patch.color !== undefined) fields.color = patch.color;
    await ctx.db.patch(markerId, fields);
    return markerId;
  },
});

/** Remove a marker. */
export const removeMarker = mutation({
  args: { markerId: v.id("siteMarkers") },
  handler: async (ctx, { markerId }) => {
    const chapterId = await requireChapterId(ctx);
    const marker = await ctx.db.get(markerId);
    await requireInChapter(ctx, chapterId, marker, "Marker");
    await ctx.db.delete(markerId);
    return markerId;
  },
});

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/** Add a basic shape (rect / circle / line) — lets you sketch with no image. */
export const addShape = mutation({
  args: {
    scope: scopeArg,
    type: v.union(v.literal("rect"), v.literal("circle"), v.literal("line")),
    x: v.number(),
    y: v.number(),
    w: v.optional(v.number()),
    h: v.optional(v.number()),
    x2: v.optional(v.number()),
    y2: v.optional(v.number()),
    color: v.optional(v.string()),
    label: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const chapterId = await requireChapterId(ctx);
    await requireScopeParent(ctx, chapterId, args.scope);
    return await ctx.db.insert("siteShapes", {
      chapterId: chapterId as Id<"chapters">,
      ...scopeFields(args.scope),
      type: args.type,
      x: clamp01(args.x),
      y: clamp01(args.y),
      w: args.w,
      h: args.h,
      x2: args.x2,
      y2: args.y2,
      color: args.color,
      label: args.label,
      createdAt: Date.now(),
    });
  },
});

/** Move / resize / relabel a shape. */
export const updateShape = mutation({
  args: {
    shapeId: v.id("siteShapes"),
    x: v.optional(v.number()),
    y: v.optional(v.number()),
    w: v.optional(v.number()),
    h: v.optional(v.number()),
    x2: v.optional(v.number()),
    y2: v.optional(v.number()),
    color: v.optional(v.string()),
    label: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, { shapeId, ...patch }) => {
    const chapterId = await requireChapterId(ctx);
    const shape = await ctx.db.get(shapeId);
    await requireInChapter(ctx, chapterId, shape, "Shape");
    const fields: Record<string, unknown> = {};
    if (patch.x !== undefined) fields.x = clamp01(patch.x);
    if (patch.y !== undefined) fields.y = clamp01(patch.y);
    if (patch.w !== undefined) fields.w = patch.w;
    if (patch.h !== undefined) fields.h = patch.h;
    if (patch.x2 !== undefined) fields.x2 = clamp01(patch.x2);
    if (patch.y2 !== undefined) fields.y2 = clamp01(patch.y2);
    if (patch.color !== undefined) fields.color = patch.color;
    if (patch.label !== undefined) fields.label = patch.label ?? undefined;
    await ctx.db.patch(shapeId, fields);
    return shapeId;
  },
});

/** Remove a shape. */
export const removeShape = mutation({
  args: { shapeId: v.id("siteShapes") },
  handler: async (ctx, { shapeId }) => {
    const chapterId = await requireChapterId(ctx);
    const shape = await ctx.db.get(shapeId);
    await requireInChapter(ctx, chapterId, shape, "Shape");
    await ctx.db.delete(shapeId);
    return shapeId;
  },
});

const placementKind = v.union(v.literal("supply"), v.literal("volunteer"));

/**
 * The droppable SUPPLIES for a scope (the catalog the tray reads).
 *   - EVENT scope    → the event's supplies eventItems (refId = eventItem id)
 *   - TEMPLATE scope → the template's supplies templateItems (refId = templateItem id)
 * Rich fields (status/source/photo) are resolved for events; templates expose
 * just the title (templates don't carry per-event acquisition state/photos).
 */
async function suppliesForScope(ctx: any, scope: Scope) {
  if (scope.kind === "template") {
    const rows = await ctx.db
      .query("templateItems")
      .withIndex("by_eventType_module", (q: any) =>
        q.eq("eventTypeId", scope.eventTypeId).eq("module", "supplies"),
      )
      .collect();
    return rows
      .sort((a: any, b: any) => a.order - b.order)
      .map((it: any) => ({
        refId: it._id as string,
        title: it.title as string,
        photoUrl: null,
        status: null,
        packedIn: null,
        source: null,
        link: it.fields?.link ?? null,
        qty: it.fields?.qty ?? null,
        cost: it.fields?.cost ?? null,
        notes: it.fields?.notes ?? null,
      }));
  }

  const eventId = scope.eventId;
  // Supplies columns → map of columnKey → (optionValue → label), so option
  // values stored on items (status/container/source) resolve to human labels.
  const supplyColumns = await ctx.db
    .query("eventColumns")
    .withIndex("by_event_module", (q: any) =>
      q.eq("eventId", eventId).eq("module", "supplies"),
    )
    .collect();
  const optionLabelsByKey = new Map<string, Map<string, string>>();
  for (const col of supplyColumns as any[]) {
    const byValue = new Map<string, string>();
    for (const opt of (col.options ?? []) as any[]) {
      byValue.set(opt.value, opt.label);
    }
    optionLabelsByKey.set(col.key, byValue);
  }
  const labelFor = (key: string, value: unknown): string | null => {
    if (value == null || value === "") return null;
    const raw = String(value);
    return optionLabelsByKey.get(key)?.get(raw) ?? raw;
  };

  const supplyRows = await ctx.db
    .query("eventItems")
    .withIndex("by_event_module", (q: any) =>
      q.eq("eventId", eventId).eq("module", "supplies"),
    )
    .collect();
  return await Promise.all(
    supplyRows.map(async (it: any) => {
      const f = it.fields ?? {};
      let photoUrl: string | null = null;
      if (f.photo) {
        photoUrl = isHttpUrl(f.photo)
          ? (f.photo as string)
          : await ctx.storage.getUrl(f.photo as Id<"_storage">);
      }
      return {
        refId: it._id as string,
        title: it.title as string,
        photoUrl,
        status: labelFor("status", f.status),
        packedIn: labelFor("container", f.container),
        source: labelFor("source", f.source),
        link: f.link ?? null,
        qty: f.qty ?? null,
        cost: f.cost ?? null,
        notes: f.notes ?? null,
      };
    }),
  );
}

/**
 * The droppable VOLUNTEERS for a scope (the tray's people).
 *   - EVENT scope    → volunteer engagements (refId = engagement id; name from
 *     the engagement's current person, so replacing a placeholder flows through)
 *   - TEMPLATE scope → placeholder crew templatePeople (refId = templatePerson id)
 */
async function volunteersForScope(ctx: any, scope: Scope) {
  if (scope.kind === "template") {
    const rows = await ctx.db
      .query("templatePeople")
      .withIndex("by_template", (q: any) =>
        q.eq("eventTypeId", scope.eventTypeId),
      )
      .collect();
    return rows
      .sort((a: any, b: any) => a.order - b.order)
      .map((r: any) => {
        const teams: string[] = r.teams ?? (r.team ? [r.team] : []);
        return {
          refId: r._id as string,
          name: r.name as string,
          phone: null,
          email: null,
          team: teams.length ? teams.join(", ") : null,
          status: null,
          service: r.role ?? null,
        };
      });
  }

  const volunteerRows = await ctx.db
    .query("engagements")
    .withIndex("by_event_type", (q: any) =>
      q.eq("eventId", scope.eventId).eq("type", "volunteer"),
    )
    .collect();
  return await Promise.all(
    volunteerRows.map(async (e: any) => {
      const person = await ctx.db.get(e.personId as Id<"people">);
      return {
        refId: e._id as string,
        name: person?.name ?? "Unknown",
        phone: person?.phone ?? null,
        email: person?.email ?? null,
        team:
          Array.isArray(e.teams) && e.teams.length ? e.teams.join(", ") : null,
        status: e.status ?? null,
        service: e.service ?? null,
      };
    }),
  );
}

/** Collect a scope's placements via the right index (by_event / by_template). */
async function placementsForScope(ctx: any, scope: Scope) {
  return scope.kind === "event"
    ? ctx.db
        .query("siteMapPlacements")
        .withIndex("by_event", (q: any) => q.eq("eventId", scope.eventId))
        .collect()
    : ctx.db
        .query("siteMapPlacements")
        .withIndex("by_template", (q: any) =>
          q.eq("eventTypeId", scope.eventTypeId),
        )
        .collect();
}

/**
 * Everything the site-map overlay UI needs for a scope: the catalog of supplies
 * and volunteers available to drop, plus every existing placement (with a
 * resolved display label). Works on both EVENT and TEMPLATE scope. Auth mirrors
 * `get` — empty arrays if there's no chapter or the parent isn't in it.
 */
export const overlays = query({
  args: { scope: scopeArg },
  handler: async (ctx, { scope }) => {
    const chapterId = await getChapterIdOrNull(ctx);
    if (!chapterId) return { supplies: [], volunteers: [], placements: [] };
    const parent = await ctx.db.get(
      scope.kind === "event" ? scope.eventId : scope.eventTypeId,
    );
    if (!parent || (parent as any).chapterId !== chapterId)
      return { supplies: [], volunteers: [], placements: [] };

    const supplies = await suppliesForScope(ctx, scope);
    const volunteers = await volunteersForScope(ctx, scope);

    const supplyTitleByRef = new Map(supplies.map((s: any) => [s.refId, s.title]));
    const volunteerNameByRef = new Map(
      volunteers.map((vv: any) => [vv.refId, vv.name]),
    );

    const placementRows = await placementsForScope(ctx, scope);
    const placements = placementRows.map((p: any) => ({
      _id: p._id,
      kind: p.kind,
      refId: p.refId as string,
      x: p.x,
      y: p.y,
      label:
        p.kind === "supply"
          ? (supplyTitleByRef.get(p.refId) ?? "")
          : (volunteerNameByRef.get(p.refId) ?? ""),
    }));

    return { supplies, volunteers, placements };
  },
});

/**
 * PUBLIC, NO-AUTH read-only site map for an event — mirrors `publicCrew`.
 *
 * Looks the event up by id and derives its chapter internally; it never reads
 * (or requires) the caller's chapter, so the public `/share/<eventId>` page can
 * render the venue without a session. Returns the resolved image URL plus every
 * marker, shape, and resolved placement. Empty arrays / null image if there's
 * no event or no map content.
 */
export const publicSiteMap = query({
  args: { eventId: v.id("events") },
  handler: async (ctx, { eventId }) => {
    const empty = {
      imageUrl: null as string | null,
      markers: [] as { x: number; y: number; label: string; color?: string | null }[],
      shapes: [] as {
        type: "rect" | "circle" | "line";
        x: number;
        y: number;
        w?: number | null;
        h?: number | null;
        x2?: number | null;
        y2?: number | null;
        color?: string | null;
        label?: string | null;
      }[],
      placements: [] as {
        x: number;
        y: number;
        label: string;
        kind: "supply" | "volunteer";
        photoUrl: string | null;
      }[],
    };

    const event = await ctx.db.get(eventId);
    if (!event) return empty;

    // Image — same resolution as `get`: storageId → signed URL, else raw URL.
    let imageUrl: string | null = null;
    const img = event.siteMapImage;
    if (img) {
      imageUrl = isHttpUrl(img)
        ? (img as string)
        : await ctx.storage.getUrl(img as Id<"_storage">);
    }

    const markers = (
      await ctx.db
        .query("siteMarkers")
        .withIndex("by_event", (q: any) => q.eq("eventId", eventId))
        .collect()
    )
      .sort((a: any, b: any) => a.createdAt - b.createdAt)
      .map((m: any) => ({
        x: m.x,
        y: m.y,
        label: m.label ?? "",
        color: m.color ?? null,
      }));

    const shapes = (
      await ctx.db
        .query("siteShapes")
        .withIndex("by_event", (q: any) => q.eq("eventId", eventId))
        .collect()
    )
      .sort((a: any, b: any) => a.createdAt - b.createdAt)
      .map((s: any) => ({
        type: s.type as "rect" | "circle" | "line",
        x: s.x,
        y: s.y,
        w: s.w ?? null,
        h: s.h ?? null,
        x2: s.x2 ?? null,
        y2: s.y2 ?? null,
        color: s.color ?? null,
        label: s.label ?? null,
      }));

    // Resolve placement labels — same logic as `overlays`: supply → eventItem
    // title; volunteer → engagement's person name.
    const placementRows = await ctx.db
      .query("siteMapPlacements")
      .withIndex("by_event", (q: any) => q.eq("eventId", eventId))
      .collect();

    const placements = await Promise.all(
      placementRows.map(async (p: any) => {
        let label = "";
        let photoUrl: string | null = null;
        if (p.kind === "supply") {
          const item = await ctx.db.get(p.refId as Id<"eventItems">);
          label = (item as any)?.title ?? "";
          // Resolve the supply's photo — same logic as `overlays`: a storageId
          // becomes a signed URL, a raw http(s) URL passes through. This lets the
          // public share map render the actual product photo, not just a glyph.
          const photo = (item as any)?.fields?.photo;
          if (photo) {
            photoUrl = isHttpUrl(photo)
              ? (photo as string)
              : await ctx.storage.getUrl(photo as Id<"_storage">);
          }
        } else {
          const engagement = await ctx.db.get(p.refId as Id<"engagements">);
          if (engagement) {
            const person = await ctx.db.get(
              (engagement as any).personId as Id<"people">,
            );
            label = person?.name ?? "";
          }
        }
        return {
          x: p.x,
          y: p.y,
          label,
          kind: p.kind as "supply" | "volunteer",
          photoUrl,
        };
      }),
    );

    return { imageUrl, markers, shapes, placements };
  },
});

/**
 * Drop a supply/volunteer onto the map, or move it if it's already placed.
 * Works on both EVENT and TEMPLATE scope. Idempotent per (scope, kind, refId):
 * patches the existing placement's position, otherwise inserts a new one. In
 * template scope `refId` is a templateItems / templatePeople id; in event scope
 * it's an eventItems / engagements id. Returns the placement id.
 */
export const placeOrMove = mutation({
  args: {
    scope: scopeArg,
    kind: placementKind,
    refId: v.string(),
    x: v.number(),
    y: v.number(),
  },
  handler: async (ctx, args) => {
    const chapterId = await requireChapterId(ctx);
    const scope = args.scope;
    await requireScopeParent(ctx, chapterId, scope);

    const x = clamp01(args.x);
    const y = clamp01(args.y);

    const existingRows =
      scope.kind === "event"
        ? await ctx.db
            .query("siteMapPlacements")
            .withIndex("by_event_kind", (q: any) =>
              q.eq("eventId", scope.eventId).eq("kind", args.kind),
            )
            .collect()
        : await ctx.db
            .query("siteMapPlacements")
            .withIndex("by_template_kind", (q: any) =>
              q.eq("eventTypeId", scope.eventTypeId).eq("kind", args.kind),
            )
            .collect();
    const existing = existingRows.find((p: any) => p.refId === args.refId);

    if (existing) {
      await ctx.db.patch(existing._id, { x, y });
      return existing._id;
    }
    return await ctx.db.insert("siteMapPlacements", {
      chapterId: chapterId as Id<"chapters">,
      ...scopeFields(scope),
      kind: args.kind,
      refId: args.refId,
      x,
      y,
      createdAt: Date.now(),
    });
  },
});

/**
 * Split ONE unit out of a multi-quantity supply placement (EVENT scope only).
 *
 * A supply placed on the map carries a `qty` (e.g. "5 × Shure SM58 Mics") but is
 * a single chip. Right-clicking a chip calls this to peel off one unit: it
 * decrements the original supply's `qty` by one and creates a NEW supplies item
 * (qty 1, same title/photo, fresh packing state) placed just beside the original
 * so it can be dragged somewhere else. No-op (returns the original placement)
 * when the supply has only one unit. The new item flows through to the supplies
 * grid and the packing checklist like any other supply.
 */
export const splitSupplyPlacement = mutation({
  args: { placementId: v.id("siteMapPlacements") },
  handler: async (ctx, { placementId }) => {
    const chapterId = await requireChapterId(ctx);
    const placement = await ctx.db.get(placementId);
    await requireInChapter(ctx, chapterId, placement, "Placement");
    const p = placement as any;
    // Only supplies carry quantities; volunteers are individuals.
    if (p.kind !== "supply" || !p.eventId) return placementId;

    const item = await ctx.db.get(p.refId as Id<"eventItems">);
    if (!item) return placementId;
    const it = item as any;
    const fields = it.fields ?? {};
    const qty = Number(fields.qty);
    // Nothing to split when there's a single (or unspecified) unit.
    if (!Number.isFinite(qty) || qty <= 1) return placementId;

    // Decrement the original, leaving the rest of its quantity in place.
    await ctx.db.patch(it._id, {
      fields: { ...fields, qty: qty - 1 },
    });

    // The peeled-off unit: a fresh supplies item with qty 1, same title/photo,
    // but reset packing state (a separated unit hasn't been packed yet).
    const supplyItems = await ctx.db
      .query("eventItems")
      .withIndex("by_event_module", (q: any) =>
        q.eq("eventId", p.eventId).eq("module", "supplies"),
      )
      .collect();
    const maxOrder = supplyItems.reduce(
      (m: number, r: any) => Math.max(m, r.order ?? 0),
      0,
    );
    const newItemId = await ctx.db.insert("eventItems", {
      eventId: p.eventId,
      chapterId: chapterId as Id<"chapters">,
      module: "supplies",
      title: it.title ?? "",
      order: maxOrder + 1,
      status: it.status,
      // Supplies carry a have-it-by deadline now — the peeled unit keeps the
      // original's timing so it doesn't fall off the due-date radar.
      offsetDays: it.offsetDays,
      dueDate: it.dueDate,
      roleId: it.roleId,
      ownerPersonId: it.ownerPersonId,
      fields: { ...fields, qty: 1, packedIn: false, packedOut: false },
    });

    // Place the new unit just below-right of the original so it's visible.
    const nx = clamp01(p.x + 0.05);
    const ny = clamp01(p.y + 0.05);
    return await ctx.db.insert("siteMapPlacements", {
      chapterId: chapterId as Id<"chapters">,
      eventId: p.eventId,
      kind: "supply",
      refId: newItemId,
      x: nx,
      y: ny,
      createdAt: Date.now(),
    });
  },
});

/** Remove a placement (take a chip off the map). */
export const removePlacement = mutation({
  args: { placementId: v.id("siteMapPlacements") },
  handler: async (ctx, { placementId }) => {
    const chapterId = await requireChapterId(ctx);
    const placement = await ctx.db.get(placementId);
    await requireInChapter(ctx, chapterId, placement, "Placement");
    await ctx.db.delete(placementId);
    return placementId;
  },
});
