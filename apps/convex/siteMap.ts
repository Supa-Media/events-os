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

/** The map image URL (resolved) + every marker and shape for an event. */
export const get = query({
  args: { eventId: v.id("events") },
  handler: async (ctx, { eventId }) => {
    const chapterId = await getChapterIdOrNull(ctx);
    if (!chapterId) return { imageUrl: null, markers: [], shapes: [] };
    const event = await ctx.db.get(eventId);
    if (!event || event.chapterId !== chapterId)
      return { imageUrl: null, markers: [], shapes: [] };

    let imageUrl: string | null = null;
    const img = event.siteMapImage;
    if (img) {
      imageUrl = isHttpUrl(img)
        ? img
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
        _id: m._id,
        x: m.x,
        y: m.y,
        label: m.label,
        color: m.color ?? null,
        category: m.category ?? null,
      }));

    const shapes = (
      await ctx.db
        .query("siteShapes")
        .withIndex("by_event", (q: any) => q.eq("eventId", eventId))
        .collect()
    )
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
    eventId: v.id("events"),
    storageId: v.union(v.id("_storage"), v.string(), v.null()),
  },
  handler: async (ctx, { eventId, storageId }) => {
    const chapterId = await requireChapterId(ctx);
    const event = await ctx.db.get(eventId);
    await requireInChapter(ctx, chapterId, event, "Event");
    await ctx.db.patch(eventId, {
      siteMapImage: storageId ?? undefined,
      updatedAt: Date.now(),
    });
    return eventId;
  },
});

/** Drop a new labelled point on the map (free color + label). */
export const addMarker = mutation({
  args: {
    eventId: v.id("events"),
    x: v.number(),
    y: v.number(),
    label: v.optional(v.string()),
    color: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const chapterId = await requireChapterId(ctx);
    const event = await ctx.db.get(args.eventId);
    await requireInChapter(ctx, chapterId, event, "Event");
    return await ctx.db.insert("siteMarkers", {
      chapterId: chapterId as Id<"chapters">,
      eventId: args.eventId,
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
    eventId: v.id("events"),
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
    const event = await ctx.db.get(args.eventId);
    await requireInChapter(ctx, chapterId, event, "Event");
    return await ctx.db.insert("siteShapes", {
      chapterId: chapterId as Id<"chapters">,
      eventId: args.eventId,
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
 * Everything the site-map overlay UI needs for an event: the catalog of
 * supplies and volunteers available to drop, plus every existing placement
 * (with a resolved display label). Auth mirrors `get` — empty arrays if there's
 * no chapter or the event isn't in it.
 */
export const overlays = query({
  args: { eventId: v.id("events") },
  handler: async (ctx, { eventId }) => {
    const chapterId = await getChapterIdOrNull(ctx);
    if (!chapterId) return { supplies: [], volunteers: [], placements: [] };
    const event = await ctx.db.get(eventId);
    if (!event || event.chapterId !== chapterId)
      return { supplies: [], volunteers: [], placements: [] };

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
    const supplies = await Promise.all(
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

    const volunteerRows = await ctx.db
      .query("engagements")
      .withIndex("by_event_type", (q: any) =>
        q.eq("eventId", eventId).eq("type", "volunteer"),
      )
      .collect();
    const volunteers = await Promise.all(
      volunteerRows.map(async (e: any) => {
        const person = await ctx.db.get(e.personId as Id<"people">);
        return {
          refId: e._id as string,
          name: person?.name ?? "Unknown",
          phone: person?.phone ?? null,
          email: person?.email ?? null,
          team: Array.isArray(e.teams) && e.teams.length ? e.teams.join(", ") : null,
          status: e.status ?? null,
          service: e.service ?? null,
        };
      }),
    );

    const supplyTitleByRef = new Map(supplies.map((s) => [s.refId, s.title]));
    const volunteerNameByRef = new Map(volunteers.map((v) => [v.refId, v.name]));

    const placementRows = await ctx.db
      .query("siteMapPlacements")
      .withIndex("by_event", (q: any) => q.eq("eventId", eventId))
      .collect();
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
 * Drop a supply/volunteer onto the map, or move it if it's already placed.
 * Idempotent per (eventId, kind, refId): patches the existing placement's
 * position, otherwise inserts a new one. Returns the placement id.
 */
export const placeOrMove = mutation({
  args: {
    eventId: v.id("events"),
    kind: placementKind,
    refId: v.string(),
    x: v.number(),
    y: v.number(),
  },
  handler: async (ctx, args) => {
    const chapterId = await requireChapterId(ctx);
    const event = await ctx.db.get(args.eventId);
    await requireInChapter(ctx, chapterId, event, "Event");

    const x = clamp01(args.x);
    const y = clamp01(args.y);

    const existing = (
      await ctx.db
        .query("siteMapPlacements")
        .withIndex("by_event_kind", (q: any) =>
          q.eq("eventId", args.eventId).eq("kind", args.kind),
        )
        .collect()
    ).find((p: any) => p.refId === args.refId);

    if (existing) {
      await ctx.db.patch(existing._id, { x, y });
      return existing._id;
    }
    return await ctx.db.insert("siteMapPlacements", {
      chapterId: chapterId as Id<"chapters">,
      eventId: args.eventId,
      kind: args.kind,
      refId: args.refId,
      x,
      y,
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
