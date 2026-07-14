/**
 * Inventory (M5.5) — the chapter's gear registry + per-event reservations.
 *
 * Assets are chapter-owned durable records; events RESERVE N of an asset. The
 * headline promise — "two overlapping events can't both have the one battery" —
 * is COMPUTED, not stored: `listAssets` reads the chapter's live events once and
 * sums each asset's reservations from live events (status ∈ {planning, ready})
 * to derive `reservedLive` / `available` / `overbooked`. Completed/cancelled
 * events drop out of the sum automatically, releasing their hold.
 *
 * Access mirrors Budget/Songs exactly: asset calls are chapter-gated
 * (`requireChapterId` / `requireOwned("assets")`); reservation calls go through
 * the EVENT first (`requireEvent`) so a cross-chapter event is rejected before
 * any asset read, then the asset's chapter is asserted to match. `chapterId` is
 * always copied server-side, never trusted from the client.
 *
 * Quantities are non-negative integers (money is not involved here): an asset's
 * owned `quantity` allows 0 (a not-yet-acquired Kit item); a reservation's
 * `quantity` must be ≥1.
 *
 * NOTE: NOT a `"use node"` file — plain queries + mutations only.
 */
import { mutation, query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { Id } from "./_generated/dataModel";
import {
  getChapterIdOrNull,
  requireChapterId,
  requireEvent,
  requireOwned,
  requireUserId,
} from "./lib/context";
import { ASSET_CONDITIONS, INVENTORY_CATEGORIES } from "@events-os/shared";

// ── Validators / guards ───────────────────────────────────────────────────────

/** Category validator, derived from the single source of truth in `shared`. */
const categoryValidator = v.union(
  ...INVENTORY_CATEGORIES.map((c) => v.literal(c)),
);

/** Condition validator, derived from the single source of truth in `shared`. */
const conditionValidator = v.union(
  ...ASSET_CONDITIONS.map((c) => v.literal(c)),
);

/**
 * Guard: an asset's owned quantity is a whole number that is NOT negative. 0 IS
 * allowed — a Chapter-Kit item you're targeting but don't own yet sits at 0.
 * Mirrors budget's `assertNonNegativeCents`.
 */
function assertNonNegInt(quantity: number): void {
  if (quantity < 0 || !Number.isInteger(quantity)) {
    throw new ConvexError({
      code: "INVALID_QUANTITY",
      message: "Quantity must be a whole number (zero or more).",
    });
  }
}

/**
 * Guard: a reservation's quantity is a whole number that is at least 1 — you
 * can't reserve zero (or a fraction) of an asset. Mirrors giving's
 * `assertPositiveCents` shape.
 */
function assertPosInt(quantity: number): void {
  if (quantity < 1 || !Number.isInteger(quantity)) {
    throw new ConvexError({
      code: "INVALID_QUANTITY",
      message: "Reserve quantity must be a whole number of at least 1.",
    });
  }
}

// ── Asset mutations (chapter-gated) ───────────────────────────────────────────

/** Add an asset to the chapter registry. `order` appends to the end. */
export const addAsset = mutation({
  args: {
    name: v.string(),
    category: categoryValidator,
    quantity: v.number(),
    acquired: v.optional(v.boolean()),
    condition: v.optional(conditionValidator),
    stateNote: v.optional(v.string()),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const chapterId = await requireChapterId(ctx);
    const userId = await requireUserId(ctx);
    assertNonNegInt(args.quantity);
    const name = args.name.trim();
    if (!name) {
      throw new ConvexError({
        code: "INVALID_INPUT",
        message: "An asset needs a name.",
      });
    }

    // Append: order = current count. Bounded read (a chapter's gear list is a
    // handful of rows, never unbounded).
    const existing = await ctx.db
      .query("assets")
      .withIndex("by_chapter", (q) =>
        q.eq("chapterId", chapterId as Id<"chapters">),
      )
      .collect();

    const now = Date.now();
    return await ctx.db.insert("assets", {
      chapterId: chapterId as Id<"chapters">,
      name,
      category: args.category,
      quantity: args.quantity,
      acquired: args.acquired ?? true,
      condition: args.condition,
      stateNote: args.stateNote?.trim() || undefined,
      note: args.note?.trim() || undefined,
      order: existing.length,
      createdBy: userId as Id<"users">,
      createdAt: now,
      updatedAt: now,
    });
  },
});

/**
 * Edit an asset. Every field is optional; `condition`, `stateNote`, and `note`
 * accept an explicit `null` to CLEAR them (distinct from "leave unchanged" =
 * omit). Any quantity present is re-validated non-negative int. `updatedAt` is
 * always bumped.
 */
export const updateAsset = mutation({
  args: {
    assetId: v.id("assets"),
    name: v.optional(v.string()),
    category: v.optional(categoryValidator),
    quantity: v.optional(v.number()),
    acquired: v.optional(v.boolean()),
    condition: v.optional(v.union(conditionValidator, v.null())),
    stateNote: v.optional(v.union(v.string(), v.null())),
    note: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    await requireOwned(ctx, "assets", args.assetId, "Asset");

    const patch: Record<string, unknown> = { updatedAt: Date.now() };
    if (args.name !== undefined) {
      const name = args.name.trim();
      if (!name) {
        throw new ConvexError({
          code: "INVALID_INPUT",
          message: "An asset needs a name.",
        });
      }
      patch.name = name;
    }
    if (args.category !== undefined) patch.category = args.category;
    if (args.quantity !== undefined) {
      assertNonNegInt(args.quantity);
      patch.quantity = args.quantity;
    }
    if (args.acquired !== undefined) patch.acquired = args.acquired;
    if (args.condition !== undefined) {
      patch.condition = args.condition ?? undefined;
    }
    if (args.stateNote !== undefined) {
      patch.stateNote =
        args.stateNote === null ? undefined : args.stateNote.trim() || undefined;
    }
    if (args.note !== undefined) {
      patch.note = args.note === null ? undefined : args.note.trim() || undefined;
    }

    await ctx.db.patch(args.assetId, patch);
    return null;
  },
});

/** Attach (or clear, with null) a photo on an asset. Mirrors budget setReceipt. */
export const setAssetPhoto = mutation({
  args: {
    assetId: v.id("assets"),
    photoStorageId: v.union(v.id("_storage"), v.null()),
  },
  handler: async (ctx, { assetId, photoStorageId }) => {
    await requireOwned(ctx, "assets", assetId, "Asset");
    await ctx.db.patch(assetId, {
      photoStorageId: photoStorageId ?? undefined,
      updatedAt: Date.now(),
    });
    return null;
  },
});

/**
 * Remove an asset. Cascade-deletes its reservations (via `by_asset`) so no
 * orphan claims survive, then deletes the asset itself.
 */
export const removeAsset = mutation({
  args: { assetId: v.id("assets") },
  handler: async (ctx, { assetId }) => {
    await requireOwned(ctx, "assets", assetId, "Asset");
    const reservations = await ctx.db
      .query("assetReservations")
      .withIndex("by_asset", (q) => q.eq("assetId", assetId))
      .collect();
    for (const r of reservations) await ctx.db.delete(r._id);
    await ctx.db.delete(assetId);
    return null;
  },
});

// ── Reservation mutations (gated through the EVENT first) ──────────────────────

/**
 * Reserve N of an asset for an event. `requireEvent` runs FIRST (so a
 * cross-chapter event is rejected before any asset read); then the asset is
 * loaded and asserted same-chapter (no cross-chapter reservation);
 * `assertPosInt(quantity)`; then UPSERT on `by_asset_event` — a second reserve
 * of the same asset by the same event updates the quantity/note rather than
 * creating a duplicate row.
 */
export const reserveAsset = mutation({
  args: {
    eventId: v.id("events"),
    assetId: v.id("assets"),
    quantity: v.number(),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const event = await requireEvent(ctx, args.eventId);
    const userId = await requireUserId(ctx);

    const asset = await ctx.db.get(args.assetId);
    if (!asset || asset.chapterId !== event.chapterId) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Asset not found in your chapter.",
      });
    }
    assertPosInt(args.quantity);
    const note = args.note?.trim() || undefined;

    const existing = await ctx.db
      .query("assetReservations")
      .withIndex("by_asset_event", (q) =>
        q.eq("assetId", args.assetId).eq("eventId", args.eventId),
      )
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, { quantity: args.quantity, note });
      return existing._id;
    }

    return await ctx.db.insert("assetReservations", {
      assetId: args.assetId,
      eventId: args.eventId,
      chapterId: asset.chapterId,
      quantity: args.quantity,
      note,
      createdBy: userId as Id<"users">,
      createdAt: Date.now(),
    });
  },
});

/**
 * Edit a reservation's quantity / note. `note` accepts `null` to clear it. Any
 * quantity present is re-validated ≥1 integer.
 */
export const updateReservation = mutation({
  args: {
    reservationId: v.id("assetReservations"),
    quantity: v.optional(v.number()),
    note: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    await requireOwned(
      ctx,
      "assetReservations",
      args.reservationId,
      "Reservation",
    );
    const patch: Record<string, unknown> = {};
    if (args.quantity !== undefined) {
      assertPosInt(args.quantity);
      patch.quantity = args.quantity;
    }
    if (args.note !== undefined) {
      patch.note = args.note === null ? undefined : args.note.trim() || undefined;
    }
    await ctx.db.patch(args.reservationId, patch);
    return null;
  },
});

/** Remove a reservation (release the event's hold on the asset). */
export const removeReservation = mutation({
  args: { reservationId: v.id("assetReservations") },
  handler: async (ctx, { reservationId }) => {
    await requireOwned(ctx, "assetReservations", reservationId, "Reservation");
    await ctx.db.delete(reservationId);
    return null;
  },
});

// ── Queries ───────────────────────────────────────────────────────────────────

/** Which event statuses hold a live reservation on gear. */
const LIVE_EVENT_STATUSES = new Set(["planning", "ready"]);

/**
 * The chapter's asset registry, each row with its computed reservation load:
 *   reservedLive = Σ reservation.quantity over reservations whose EVENT is live
 *   available    = max(0, quantity - reservedLive)
 *   overbooked   = reservedLive > quantity
 * plus a resolved `photoUrl`. Reads the chapter's live events ONCE into a Set,
 * then classifies each asset's reservations against it — no per-reservation
 * event fetch (no N+1), no `.filter()`.
 *
 * Chapter-gated via `getChapterIdOrNull` (a pre-onboarding user gets [] instead
 * of a thrown error), mirroring `songs.list`.
 */
export const listAssets = query({
  args: {},
  handler: async (ctx: QueryCtx) => {
    const chapterId = await getChapterIdOrNull(ctx);
    if (!chapterId) return [];

    const assets = await ctx.db
      .query("assets")
      .withIndex("by_chapter", (q) =>
        q.eq("chapterId", chapterId as Id<"chapters">),
      )
      .collect();
    assets.sort((a, b) => a.order - b.order);

    // Live events for the chapter, read ONCE → a Set of live event ids.
    const events = await ctx.db
      .query("events")
      .withIndex("by_chapter", (q) =>
        q.eq("chapterId", chapterId as Id<"chapters">),
      )
      .collect();
    const liveEventIds = new Set(
      events
        .filter((e) => LIVE_EVENT_STATUSES.has(e.status))
        .map((e) => e._id as Id<"events">),
    );

    return await Promise.all(
      assets.map(async (asset) => {
        const reservations = await ctx.db
          .query("assetReservations")
          .withIndex("by_asset", (q) => q.eq("assetId", asset._id))
          .collect();
        const reservedLive = reservations.reduce(
          (sum, r) => (liveEventIds.has(r.eventId) ? sum + r.quantity : sum),
          0,
        );
        return {
          ...asset,
          reservedLive,
          available: Math.max(0, asset.quantity - reservedLive),
          overbooked: reservedLive > asset.quantity,
          photoUrl: asset.photoStorageId
            ? await ctx.storage.getUrl(asset.photoStorageId)
            : null,
        };
      }),
    );
  },
});

/**
 * One event's reservations, each joined to its asset (name, category, the
 * asset's chapter-wide `available` + `overbooked` flag) so the event view can
 * warn when the shared gear is oversubscribed across events. `requireEvent`
 * gates it. The asset's chapter-wide load is computed the same way `listAssets`
 * does: sum its reservations from the chapter's live events.
 */
export const listEventReservations = query({
  args: { eventId: v.id("events") },
  handler: async (ctx: QueryCtx, { eventId }) => {
    const event = await requireEvent(ctx, eventId);

    const reservations = await ctx.db
      .query("assetReservations")
      .withIndex("by_event", (q) => q.eq("eventId", eventId))
      .collect();
    reservations.sort((a, b) => a.createdAt - b.createdAt);

    // Live events for the chapter, read ONCE → a Set of live event ids.
    const events = await ctx.db
      .query("events")
      .withIndex("by_chapter", (q) => q.eq("chapterId", event.chapterId))
      .collect();
    const liveEventIds = new Set(
      events
        .filter((e) => LIVE_EVENT_STATUSES.has(e.status))
        .map((e) => e._id as Id<"events">),
    );

    return await Promise.all(
      reservations.map(async (r) => {
        const asset = await ctx.db.get(r.assetId);
        let assetInfo = null;
        if (asset) {
          const assetReservations = await ctx.db
            .query("assetReservations")
            .withIndex("by_asset", (q) => q.eq("assetId", asset._id))
            .collect();
          const reservedLive = assetReservations.reduce(
            (sum, ar) =>
              liveEventIds.has(ar.eventId) ? sum + ar.quantity : sum,
            0,
          );
          assetInfo = {
            name: asset.name,
            category: asset.category,
            quantity: asset.quantity,
            available: Math.max(0, asset.quantity - reservedLive),
            overbooked: reservedLive > asset.quantity,
          };
        }
        return { ...r, asset: assetInfo };
      }),
    );
  },
});
