import type { MutationCtx } from "../_generated/server";
import {
  DEFAULT_COLUMNS,
  PERMIT_STATUS_OPTIONS,
  type ModuleKey,
  type SelectOption,
} from "@events-os/shared";
import type { Id } from "../_generated/dataModel";
import type { Migration } from "./index";

/**
 * Permits v1 — bring existing permit grids up to the new default:
 *
 *   1. Merge the two NEW status options (`denied`, `waived`) into every permit
 *      `status` column's option list. Columns are snapshotted per scope, so a
 *      grid created before these values existed permanently lacks them and the
 *      status cell can't offer them. We APPEND only what's missing (dedupe by
 *      `value`), preserving an author's existing options AND their order — the
 *      option shapes are sourced from PERMIT_STATUS_OPTIONS so they can't drift.
 *
 *   2. Add the new `jurisdiction` + `fallback` default columns to permit grids
 *      that lack them (same mechanism as 0019's duration backfill): source the
 *      col defs from DEFAULT_COLUMNS.permits, insert at the tail (max order + 1)
 *      when the key is absent, skip otherwise.
 *
 * Both steps cover templateColumns AND eventColumns. Idempotent: a second run
 * merges nothing new and inserts no columns. Single pass over the permit
 * columns (config scale).
 */
const MODULE: ModuleKey = "permits";

/** The status options to guarantee-present, sourced from shared so they can't drift. */
const NEW_STATUS_VALUES = ["denied", "waived"] as const;

/** The new-option shapes, pulled from PERMIT_STATUS_OPTIONS by value. */
function newStatusOptions(): SelectOption[] {
  return NEW_STATUS_VALUES.map((value) => {
    const opt = PERMIT_STATUS_OPTIONS.find((o) => o.value === value);
    if (!opt) {
      throw new Error(`PERMIT_STATUS_OPTIONS is missing \`${value}\``);
    }
    return opt;
  });
}

/** The permit default column def for a given key, sourced from shared. */
function permitColumnDef(key: string) {
  const def = (DEFAULT_COLUMNS[MODULE] ?? []).find((c) => c.key === key);
  if (!def) {
    throw new Error(`permits default columns are missing \`${key}\``);
  }
  return def;
}

/**
 * Append any missing NEW options to an existing option list, preserving the
 * author's options + order. Returns the merged list, or null when nothing
 * changed (so the caller can skip the patch).
 */
function mergeStatusOptions(existing: SelectOption[]): SelectOption[] | null {
  const present = new Set(existing.map((o) => o.value));
  const toAdd = newStatusOptions().filter((o) => !present.has(o.value));
  if (toAdd.length === 0) return null;
  return [...existing, ...toAdd];
}

const NEW_COLUMN_KEYS = ["jurisdiction", "fallback"] as const;

export async function runPermitsStatesAndFallback(ctx: MutationCtx) {
  let statusColumnsMerged = 0;
  let templateColumnsAdded = 0;
  let eventColumnsAdded = 0;

  // ── Templates ──────────────────────────────────────────────────────────────
  const templateCols = (await ctx.db.query("templateColumns").collect()).filter(
    (c) => c.module === MODULE,
  );
  const byTemplate = new Map<string, typeof templateCols>();
  for (const c of templateCols) {
    const k = String(c.eventTypeId);
    (byTemplate.get(k) ?? byTemplate.set(k, []).get(k)!).push(c);
  }
  for (const [eventTypeId, cols] of byTemplate) {
    // (1) merge status options
    const statusCol = cols.find((c) => c.key === "status");
    if (statusCol) {
      const merged = mergeStatusOptions(
        (statusCol.options as SelectOption[] | undefined) ?? [],
      );
      if (merged) {
        await ctx.db.patch(statusCol._id, { options: merged });
        statusColumnsMerged++;
      }
    }
    // (2) add missing default columns
    for (const key of NEW_COLUMN_KEYS) {
      if (cols.some((c) => c.key === key)) continue;
      const def = permitColumnDef(key);
      const order = cols.reduce((m, c) => (c.order > m ? c.order : m), -1) + 1;
      await ctx.db.insert("templateColumns", {
        eventTypeId: eventTypeId as Id<"eventTypes">,
        module: MODULE,
        key: def.key,
        label: def.label,
        kind: def.kind,
        type: def.type,
        options: def.options,
        config: def.config,
        isVisible: def.isVisible,
        order,
      });
      // Track locally so the second NEW_COLUMN_KEYS iteration tails past this
      // one (only key + order are read by the skip/tail logic above).
      cols.push({ key: def.key, order } as (typeof cols)[number]);
      templateColumnsAdded++;
    }
  }

  // ── Events ─────────────────────────────────────────────────────────────────
  const eventCols = (await ctx.db.query("eventColumns").collect()).filter(
    (c) => c.module === MODULE,
  );
  const byEvent = new Map<string, typeof eventCols>();
  for (const c of eventCols) {
    const k = String(c.eventId);
    (byEvent.get(k) ?? byEvent.set(k, []).get(k)!).push(c);
  }
  for (const [eventId, cols] of byEvent) {
    const statusCol = cols.find((c) => c.key === "status");
    if (statusCol) {
      const merged = mergeStatusOptions(
        (statusCol.options as SelectOption[] | undefined) ?? [],
      );
      if (merged) {
        await ctx.db.patch(statusCol._id, { options: merged });
        statusColumnsMerged++;
      }
    }
    for (const key of NEW_COLUMN_KEYS) {
      if (cols.some((c) => c.key === key)) continue;
      const def = permitColumnDef(key);
      const order = cols.reduce((m, c) => (c.order > m ? c.order : m), -1) + 1;
      await ctx.db.insert("eventColumns", {
        eventId: eventId as Id<"events">,
        module: MODULE,
        key: def.key,
        label: def.label,
        kind: def.kind,
        type: def.type,
        options: def.options,
        config: def.config,
        isVisible: def.isVisible,
        order,
      });
      cols.push({ key: def.key, order } as (typeof cols)[number]);
      eventColumnsAdded++;
    }
  }

  return {
    statusColumnsMerged,
    templateColumnsAdded,
    eventColumnsAdded,
  };
}

export const permitsStatesAndFallback: Migration = {
  name: "0020_permits_states_and_fallback",
  run: runPermitsStatesAndFallback,
};
