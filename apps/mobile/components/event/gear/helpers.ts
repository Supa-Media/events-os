/**
 * Gear tab helpers — the row types the Gear surfaces render, plus the shared
 * inventory TAG vocabulary (from `@events-os/shared`). Assets are classified by
 * free-form tags (an asset can be both "audio" and "cable"), not a fixed
 * category enum; the tag suggestions seed the quick-add chips and filter bars.
 */
import type { Doc } from "@events-os/convex/_generated/dataModel";
import {
  INVENTORY_TAG_OPTIONS,
  INVENTORY_TAG_SUGGESTIONS,
  type InventoryTagSuggestion,
} from "@events-os/shared";

export {
  INVENTORY_TAG_OPTIONS,
  INVENTORY_TAG_SUGGESTIONS,
  type InventoryTagSuggestion,
};

/** An asset row as returned by `inventory.listAssets` (doc + computed load). */
export type AssetRowData = Doc<"assets"> & {
  reservedLive: number;
  available: number;
  overbooked: boolean;
  photoUrl: string | null;
};

/** The asset summary joined onto each event reservation. */
export type ReservationAsset = {
  name: string;
  tags: string[];
  quantity: number;
  available: number;
  overbooked: boolean;
};

/** A reservation row as returned by `inventory.listEventReservations`. */
export type EventReservation = Doc<"assetReservations"> & {
  asset: ReservationAsset | null;
};
