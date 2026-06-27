/**
 * Column-type registry — the SINGLE source of truth for per-column-type
 * behavior, so adding (or changing) a column type means editing one place.
 *
 * Two registries live here:
 *
 *  1. `COLUMN_TYPE_REGISTRY` — keyed by `ColumnType`. Owns the default column
 *     width and the text parse/format helpers for the inline-text cell types
 *     (text/longtext/number/currency/date/url). The cell component itself is
 *     dispatched in `cells.tsx` (it needs the component closures), but every
 *     other type-level decision is centralized here. cells.tsx and
 *     EditableGrid both consult this instead of re-switching on the type.
 *
 *  2. `SYSTEM_COLUMN_REGISTRY` — keyed by SYSTEM column key (title/status/role/
 *     owner/offset/due_date). Owns how a system column reads its logical value
 *     off an item (`get`) and how it maps a new value back to a mutation patch
 *     (`set`). `useGridData`'s `cellValue`/`buildPatch` consult this instead of
 *     duplicating the key switch. Custom columns (not in this map) fall back to
 *     the item's `fields` bag.
 *
 * Behavior is identical to the four switch sites this replaces.
 */
import {
  DAY_OFFSET_MODULES,
  offsetDaysBetween,
  type ColumnType,
  type ModuleKey,
} from "@events-os/shared";
import { parseDateInput, toDateInput } from "../../lib/format";
import type { GridColumn, GridItem, GridMode } from "./useGridData";
import { isTemplateOwnerCell } from "./useGridData";

// ── Grid chrome dimensions (px) ───────────────────────────────────────────────
// Drag grip lives in a LEFT gutter; delete in a small RIGHT gutter.
export const GRIP_W = 30;
export const DELETE_W = 38;
/** Minimum overall table width so an empty/narrow grid still looks like a table. */
export const MIN_TABLE_WIDTH = 320;
/** Width for the special `title` column (overrides its type's default width). */
export const TITLE_COL_WIDTH = 240;
/** Fallback width for any type not listed in the registry. */
export const DEFAULT_COL_WIDTH = 160;

/**
 * Per-type config for the inline-text editor family (text/longtext/number/
 * currency/date/url). When a type carries `inlineText`, `GridCell` renders a
 * single `InlineText` editor configured from it — no per-type component case.
 */
export interface InlineTextConfig {
  multiline?: boolean;
  numeric?: boolean;
  /** Placeholder; a function lets the `title` column override it by key. */
  placeholder?: string | ((column: GridColumn) => string);
  weight?: ((column: GridColumn) => "normal" | "medium") | "normal" | "medium";
  /** Parse the editor's raw string into the logical value. */
  parse?: (text: string, column: GridColumn) => unknown;
  /** Format the logical value into the editor's display string. */
  format?: (value: any) => string;
}

export interface ColumnTypeEntry {
  /** Default column width (px) for this type; overridden by `column.width`. */
  width: number;
  /** Present iff this type is edited via the shared inline-text cell. */
  inlineText?: InlineTextConfig;
}

export const COLUMN_TYPE_REGISTRY: Record<ColumnType, ColumnTypeEntry> = {
  text: {
    width: DEFAULT_COL_WIDTH,
    inlineText: {
      multiline: true,
      placeholder: (c) => (c.key === "title" ? "Untitled" : "—"),
      weight: (c) => (c.key === "title" ? "medium" : "normal"),
      parse: (t, c) => (c.key === "title" ? t : t.trim() ? t : null),
    },
  },
  longtext: {
    width: 280,
    inlineText: {
      multiline: true,
      placeholder: "—",
      parse: (t) => (t.trim() ? t : null),
    },
  },
  select: { width: 150 },
  multiselect: { width: 210 },
  status: { width: 150 },
  number: {
    width: 90,
    inlineText: {
      numeric: true,
      placeholder: "—",
      parse: (t) => {
        if (t.trim() === "") return null;
        const n = Number(t);
        return Number.isFinite(n) ? n : null;
      },
    },
  },
  currency: {
    width: 110,
    inlineText: {
      numeric: true,
      placeholder: "$—",
      format: (v) => (v != null ? `$${v}` : ""),
      parse: (t) => {
        const n = Number(t.replace(/[^0-9.]/g, ""));
        return t.trim() === "" ? null : Number.isFinite(n) ? n : null;
      },
    },
  },
  date: {
    width: 130,
    inlineText: {
      placeholder: "YYYY-MM-DD",
      format: (v) => (v != null ? toDateInput(v) : ""),
      parse: (t) => parseDateInput(t),
    },
  },
  url: {
    width: 180,
    inlineText: {
      placeholder: "Link",
      parse: (t) => (t.trim() ? t.trim() : null),
    },
  },
  photo: { width: 84 },
  person: { width: 170 },
  role: { width: 150 },
  offset_days: { width: 96 },
  offset_minutes: { width: 96 },
  due_date: { width: 130 },
  how_to: { width: 200 },
};

/** Sensible default column width (px) for a column; overridden by column.width. */
export function getColumnWidth(col: GridColumn): number {
  if (col.key === "title") return TITLE_COL_WIDTH;
  return (
    COLUMN_TYPE_REGISTRY[col.type as ColumnType]?.width ?? DEFAULT_COL_WIDTH
  );
}

// ── System columns (keyed by column key) ──────────────────────────────────────
/** How a system column reads/writes its backing promoted field on the item. */
export interface SystemColumnEntry {
  get: (item: GridItem, ctx: SystemColumnCtx) => unknown;
  set: (value: any, ctx: SystemColumnCtx) => Record<string, any>;
}

export interface SystemColumnCtx {
  column: GridColumn;
  module: ModuleKey;
  mode: GridMode;
  /** The parent event's start timestamp — needed to convert a picked DUE day
   *  back into the item's signed `offsetDays` (the source of truth). */
  eventDate?: number;
}

export const SYSTEM_COLUMN_REGISTRY: Record<string, SystemColumnEntry> = {
  title: {
    get: (item) => item.title,
    set: (value) => ({ title: value ?? "" }),
  },
  status: {
    get: (item) => item.status ?? null,
    set: (value) => ({ status: value ?? null }),
  },
  role: {
    get: (item) => item.roleId ?? null,
    set: (value) => ({ roleId: value ?? null }),
  },
  owner: {
    get: (item, { column, module, mode }) => {
      // Template placeholder owner lives in the fields bag (templatePerson id).
      if (isTemplateOwnerCell(column, module, mode))
        return item.fields?.templateOwnerId ?? null;
      return item.ownerPersonId ?? null;
    },
    set: (value, { column, module, mode }) => {
      // Template placeholder owner: store id + display name in the fields bag.
      // `value` is `{ id, name }` when picked, or null when cleared.
      if (isTemplateOwnerCell(column, module, mode)) {
        return {
          fields: {
            templateOwnerId: value?.id ?? null,
            templateOwnerName: value?.name ?? null,
          },
        };
      }
      return { ownerPersonId: value ?? null };
    },
  },
  offset: {
    get: (item, { module }) =>
      DAY_OFFSET_MODULES.includes(module)
        ? item.offsetDays
        : item.offsetMinutes,
    set: (value, { module }) =>
      DAY_OFFSET_MODULES.includes(module)
        ? { offsetDays: value }
        : { offsetMinutes: value },
  },
  due_date: {
    get: (item) => item.dueDate,
    // DUE is derived (eventDate + offsetDays), so picking a calendar day writes
    // back the SIGNED `offsetDays` instead — which reflows both the DUE date and
    // the TIMING (T-…) label together. Compare day-starts so the event's
    // time-of-day can't push the offset off by one.
    set: (value, { eventDate }) => {
      if (value == null || eventDate == null) return {};
      return { offsetDays: offsetDaysBetween(eventDate, value) };
    },
  },
};
