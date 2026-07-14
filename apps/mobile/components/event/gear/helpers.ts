/**
 * Gear tab helpers — the shared inventory category vocabulary (from
 * `@events-os/shared`) plus the row types the Gear surfaces render. The category
 * list is the single source of truth used by the schema's `v.union` literals, so
 * the two can never drift.
 */
import type { Doc } from "@events-os/convex/_generated/dataModel";
import {
  INVENTORY_CATEGORIES,
  INVENTORY_CATEGORY_LABELS,
  type InventoryCategory,
} from "@events-os/shared";

export {
  INVENTORY_CATEGORIES,
  INVENTORY_CATEGORY_LABELS,
  type InventoryCategory,
};

/** {value,label} options for the category `Select`, in display order. */
export const INVENTORY_CATEGORY_OPTIONS = INVENTORY_CATEGORIES.map((value) => ({
  value,
  label: INVENTORY_CATEGORY_LABELS[value],
}));

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
  category: InventoryCategory;
  quantity: number;
  available: number;
  overbooked: boolean;
};

/** A reservation row as returned by `inventory.listEventReservations`. */
export type EventReservation = Doc<"assetReservations"> & {
  asset: ReservationAsset | null;
};
