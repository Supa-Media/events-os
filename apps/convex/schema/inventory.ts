import { defineTable } from "convex/server";
import { v } from "convex/values";
import { ASSET_CONDITIONS } from "@events-os/shared";

/**
 * Inventory (M5.5) — the chapter's gear registry + per-event reservations.
 *
 * Inventory is the FIRST chapter-level typed entity: the green luggage lives in
 * Brooklyn, not in one event. An `asset` is a durable chapter-owned record
 * (mixer, SM58, 200W battery, A-frame sign); an `assetReservation` is one
 * event's claim on N of an asset. Two overlapping events can't both "have" the
 * one battery — the registry query COMPUTES that conflict (overbooking) from the
 * live reservations rather than storing it (see docs/plans/inventory.md).
 *
 * Everything is chapter-scoped from day one (multi-city is V3). A reservation
 * copies its `chapterId` from the asset server-side (never client-supplied) so
 * cross-chapter claims are impossible.
 */

/**
 * A chapter-owned asset — the durable gear record. `quantity` is the total OWNED
 * count (a non-negative integer; 0 is allowed for a Chapter-Kit item you're
 * targeting but don't own yet, flagged `acquired: false`). `stateNote` carries
 * freeform prep state ("charge the battery (VERY IMPORTANT)") as asset state,
 * not a re-materialized task row.
 */
export const assets = defineTable({
  chapterId: v.id("chapters"),
  name: v.string(),
  // Free-form classification tags (an asset can be both "audio" and "cable").
  // Replaces the old fixed category enum; the filter pill bar derives from these.
  tags: v.array(v.string()),
  // Total OWNED count (non-negative integer; 0 allowed for not-yet-acquired Kit,
  // or a consumable that's been used up / out of stock).
  quantity: v.number(),
  // false = "on the list, not yet acquired" (a Chapter Kit target).
  acquired: v.boolean(),
  // Consumable (used up, permanently decremented) vs. durable (reserved, then
  // returned). Optional/absent reads as durable (false).
  consumable: v.optional(v.boolean()),
  // Consumables at or below this on-hand count surface a "low stock" badge.
  lowStockThreshold: v.optional(v.number()),
  // Physical condition (optional).
  condition: v.optional(v.union(...ASSET_CONDITIONS.map((c) => v.literal(c)))),
  // Freeform prep state ("charge the battery"), surfaced day-of.
  stateNote: v.optional(v.string()),
  photoStorageId: v.optional(v.id("_storage")),
  note: v.optional(v.string()),
  // Append order for a stable list.
  order: v.number(),
  createdBy: v.id("users"),
  createdAt: v.number(),
  updatedAt: v.number(),
}).index("by_chapter", ["chapterId"]);

/**
 * An event's claim on N of an asset. `quantity` is a ≥1 integer. `chapterId` is
 * copied from `asset.chapterId` (never trusted from the client). One row per
 * (asset, event) — a second reserve of the same asset by the same event UPSERTS
 * (updates the quantity), never duplicates (see `by_asset_event`).
 */
export const assetReservations = defineTable({
  assetId: v.id("assets"),
  eventId: v.id("events"),
  chapterId: v.id("chapters"),
  // How many this event claims (≥1 integer).
  quantity: v.number(),
  // Denormalized "Packed in" container from the linked supply row, so the
  // registry can show another event "Worship With Strangers · Green luggage"
  // without joining back through eventItems. Optional/absent = no container yet.
  container: v.optional(v.string()),
  note: v.optional(v.string()),
  createdBy: v.id("users"),
  createdAt: v.number(),
})
  .index("by_asset", ["assetId"])
  .index("by_event", ["eventId"])
  .index("by_asset_event", ["assetId", "eventId"]);
