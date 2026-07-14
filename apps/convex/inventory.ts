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
import {
  ASSET_CONDITIONS,
  INVENTORY_COLUMNS,
  CONTAINER_OPTIONS,
  optionLabel,
} from "@events-os/shared";

// ── Validators / guards ───────────────────────────────────────────────────────

/** Condition validator, derived from the single source of truth in `shared`. */
const conditionValidator = v.union(
  ...ASSET_CONDITIONS.map((c) => v.literal(c)),
);

/** Normalize a tags array: trim, drop empties, de-dupe, cap length. */
function cleanTags(tags: string[] | undefined): string[] {
  if (!tags) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const t = raw.trim();
    if (t && !seen.has(t.toLowerCase())) {
      seen.add(t.toLowerCase());
      out.push(t);
    }
  }
  return out.slice(0, 24);
}

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
    tags: v.optional(v.array(v.string())),
    quantity: v.number(),
    acquired: v.optional(v.boolean()),
    consumable: v.optional(v.boolean()),
    lowStockThreshold: v.optional(v.number()),
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
      tags: cleanTags(args.tags),
      quantity: args.quantity,
      acquired: args.acquired ?? true,
      consumable: args.consumable,
      lowStockThreshold: args.lowStockThreshold,
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
    tags: v.optional(v.array(v.string())),
    quantity: v.optional(v.number()),
    acquired: v.optional(v.boolean()),
    consumable: v.optional(v.boolean()),
    lowStockThreshold: v.optional(v.union(v.number(), v.null())),
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
    if (args.tags !== undefined) patch.tags = cleanTags(args.tags);
    if (args.quantity !== undefined) {
      assertNonNegInt(args.quantity);
      patch.quantity = args.quantity;
    }
    if (args.acquired !== undefined) patch.acquired = args.acquired;
    if (args.consumable !== undefined) patch.consumable = args.consumable;
    if (args.lowStockThreshold !== undefined) {
      patch.lowStockThreshold = args.lowStockThreshold ?? undefined;
    }
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
    // The reserving event's "Packed in" container, denormalized so other events
    // can read this asset's live location. `null` clears it.
    container: v.optional(v.union(v.string(), v.null())),
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
    const container =
      args.container === null ? undefined : args.container || undefined;

    const existing = await ctx.db
      .query("assetReservations")
      .withIndex("by_asset_event", (q) =>
        q.eq("assetId", args.assetId).eq("eventId", args.eventId),
      )
      .unique();

    if (existing) {
      // Only overwrite container when the caller supplied the arg at all.
      const patch: Record<string, unknown> = { quantity: args.quantity, note };
      if (args.container !== undefined) patch.container = container;
      await ctx.db.patch(existing._id, patch);
      return existing._id;
    }

    return await ctx.db.insert("assetReservations", {
      assetId: args.assetId,
      eventId: args.eventId,
      chapterId: asset.chapterId,
      quantity: args.quantity,
      container,
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
/** Shape of one enriched asset row (asset doc + computed reservation load). */
export type EnrichedAsset = Awaited<ReturnType<typeof loadAssetRows>>[number];

/**
 * Load the chapter's assets, each enriched with its live reservation load and
 * physical location. Shared by `listAssets` (the registry) and `listAssetsGrid`
 * (the database view) so they never drift. Reads the chapter's live events ONCE
 * into a Set + name map, then classifies each asset's reservations — no N+1.
 */
async function loadAssetRows(ctx: QueryCtx, chapterId: Id<"chapters">) {
  const assets = await ctx.db
    .query("assets")
    .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
    .collect();
  assets.sort((a, b) => a.order - b.order);

  const events = await ctx.db
    .query("events")
    .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
    .collect();
  const liveEventIds = new Set(
    events
      .filter((e) => LIVE_EVENT_STATUSES.has(e.status))
      .map((e) => e._id as Id<"events">),
  );
  const eventName = new Map(events.map((e) => [e._id, e.name] as const));

  return await Promise.all(
    assets.map(async (asset) => {
      const reservations = await ctx.db
        .query("assetReservations")
        .withIndex("by_asset", (q) => q.eq("assetId", asset._id))
        .collect();
      const live = reservations.filter((r) => liveEventIds.has(r.eventId));
      const reservedLive = live.reduce((sum, r) => sum + r.quantity, 0);
      const consumable = asset.consumable ?? false;
      const heldBy = live
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((r) => ({
          eventId: r.eventId,
          eventName: eventName.get(r.eventId) ?? "An event",
          container: r.container ?? null,
          quantity: r.quantity,
        }));
      return {
        ...asset,
        consumable,
        reservedLive,
        available: Math.max(0, asset.quantity - reservedLive),
        overbooked: reservedLive > asset.quantity,
        lowStock:
          consumable &&
          asset.lowStockThreshold !== undefined &&
          asset.quantity <= asset.lowStockThreshold,
        outOfStock: consumable && asset.quantity <= 0,
        heldBy,
        photoUrl: asset.photoStorageId
          ? await ctx.storage.getUrl(asset.photoStorageId)
          : null,
      };
    }),
  );
}

export const listAssets = query({
  args: {},
  handler: async (ctx: QueryCtx) => {
    const chapterId = await getChapterIdOrNull(ctx);
    if (!chapterId) return [];
    return await loadAssetRows(ctx, chapterId as Id<"chapters">);
  },
});

/**
 * The inventory registry as a GRID payload — the same `{ columns, items }` shape
 * the EditableGrid consumes for events/templates, so the chapter-mode grid
 * renders identically to Supplies. `title` is the asset name; every other cell
 * lives in the item's `fields` bag keyed by the INVENTORY_COLUMNS keys. The
 * `available` cell is a human-readable read-only summary (e.g. "3 of 5 · Green
 * luggage"); the adapter refuses writes to it.
 */
export const listAssetsGrid = query({
  args: {},
  handler: async (ctx: QueryCtx) => {
    const chapterId = await getChapterIdOrNull(ctx);
    if (!chapterId) return { columns: INVENTORY_COLUMNS, items: [], summary: undefined };

    const rows = await loadAssetRows(ctx, chapterId as Id<"chapters">);
    let complete = 0;
    const items = rows.map((a, i) => {
      if (a.acquired) complete += 1;
      // Available cell: reservation load + where it is, or a stock warning.
      let available: string;
      if (a.consumable) {
        available = a.outOfStock
          ? "Out of stock"
          : a.lowStock
            ? `${a.quantity} left · low`
            : `${a.quantity} in stock`;
      } else if (a.heldBy.length > 0) {
        const where = a.heldBy
          .map((h) =>
            h.container
              ? `${h.eventName} · ${optionLabel(CONTAINER_OPTIONS, h.container)}`
              : h.eventName,
          )
          .join(", ");
        available = `${a.available} of ${a.quantity} · ${a.overbooked ? "OVER — " : ""}${where}`;
      } else {
        available = `${a.available} of ${a.quantity}`;
      }
      return {
        _id: a._id as string,
        module: "inventory",
        title: a.name,
        order: a.order ?? i,
        status: null as string | null,
        fields: {
          tags: a.tags,
          quantity: a.quantity,
          available,
          consumable: a.consumable ? "yes" : "no",
          condition: a.condition ?? null,
          acquired: a.acquired ? "yes" : "no",
          photo: a.photoStorageId ?? null,
          photoUrl: a.photoUrl ?? null,
          notes: a.note ?? null,
        } as Record<string, any>,
      };
    });
    return {
      columns: INVENTORY_COLUMNS,
      items,
      summary: {
        total: rows.length,
        complete,
        readiness: rows.length ? complete / rows.length : 0,
      },
    };
  },
});

// ── Grid adapter mutations (chapter-mode EditableGrid) ────────────────────────
// The grid speaks one interface — add a row, patch a cell, remove a row — over a
// `fields` bag. These translate that vocabulary onto the typed `assets`
// mutations, so the frontend adapter stays thin. Chapter-gated like the rest.

/** Add a blank asset row (grid "Add row"); the user then edits cells. */
export const addAssetRow = mutation({
  args: {},
  handler: async (ctx): Promise<Id<"assets">> => {
    const chapterId = await requireChapterId(ctx);
    const userId = await requireUserId(ctx);
    const existing = await ctx.db
      .query("assets")
      .withIndex("by_chapter", (q) =>
        q.eq("chapterId", chapterId as Id<"chapters">),
      )
      .collect();
    const now = Date.now();
    return await ctx.db.insert("assets", {
      chapterId: chapterId as Id<"chapters">,
      name: "New item",
      tags: [],
      quantity: 1,
      acquired: true,
      order: existing.length,
      createdBy: userId as Id<"users">,
      createdAt: now,
      updatedAt: now,
    });
  },
});

/**
 * Patch one grid cell on an asset. `key` is an INVENTORY_COLUMNS key (or
 * "title"); the value shape follows the cell type. Read-only computed columns
 * (available) are ignored. `photo` maps to the storage id.
 */
export const updateAssetCell = mutation({
  args: {
    assetId: v.id("assets"),
    key: v.string(),
    value: v.any(),
  },
  handler: async (ctx, { assetId, key, value }) => {
    await requireOwned(ctx, "assets", assetId, "Asset");
    const patch: Record<string, unknown> = { updatedAt: Date.now() };
    switch (key) {
      case "title":
        patch.name = (typeof value === "string" && value.trim()) || "Untitled item";
        break;
      case "tags":
        patch.tags = cleanTags(Array.isArray(value) ? value : value ? [value] : []);
        break;
      case "quantity": {
        const q = Math.max(0, Math.trunc(Number(value) || 0));
        patch.quantity = q;
        break;
      }
      case "consumable":
        patch.consumable = value === "yes" || value === true;
        break;
      case "acquired":
        patch.acquired = value === "yes" || value === true;
        break;
      case "condition":
        patch.condition =
          value && (ASSET_CONDITIONS as readonly string[]).includes(value)
            ? value
            : undefined;
        break;
      case "notes":
        patch.note =
          typeof value === "string" && value.trim() ? value.trim() : undefined;
        break;
      case "photo":
        patch.photoStorageId = value ? (value as Id<"_storage">) : undefined;
        break;
      // "available" and any unknown key are read-only / no-ops.
      default:
        return null;
    }
    await ctx.db.patch(assetId, patch);
    return null;
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
            tags: asset.tags,
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
