import type { MutationCtx } from "../_generated/server";
import { DEFAULT_COLUMNS, type ModuleKey } from "@events-os/shared";
import type { Id } from "../_generated/dataModel";
import type { Migration } from "./index";

/**
 * Backfill the new `duration` (segment length, minutes) column onto every
 * existing Run of Show grid — templates AND their cloned events.
 *
 * Columns are SNAPSHOTTED per scope (a template's are seeded from
 * DEFAULT_COLUMNS; an event clones the template's at instantiation), so a grid
 * created before `duration` existed permanently lacks it and there's no UI to
 * surface it. This walks each `run_of_show` (scope, module) group and INSERTS
 * the `duration` default column where its `key` is absent, sourcing the column
 * shape from `DEFAULT_COLUMNS.run_of_show` so it can never drift from the live
 * default. New column lands at the tail (max order + 1) — same as the generic
 * `backfillMissingDefaultColumns` precedent; authors reorder freely, and the
 * Day-of view reads the value regardless of column order.
 *
 * Idempotent: a group that already has `duration` is skipped, so a second run
 * inserts nothing. Single-pass over the grid columns (config scale).
 */
const MODULE: ModuleKey = "run_of_show";

/** The `duration` default column, sourced from shared so it can't drift. */
function durationColumnDef() {
  const def = (DEFAULT_COLUMNS[MODULE] ?? []).find((c) => c.key === "duration");
  if (!def) {
    throw new Error("run_of_show default columns are missing `duration`");
  }
  return def;
}

export async function runBackfillRunOfShowDuration(ctx: MutationCtx) {
  const def = durationColumnDef();
  let templateColumnsAdded = 0;
  let eventColumnsAdded = 0;

  // ── Templates ────────────────────────────────────────────────────────────
  const templateCols = (await ctx.db.query("templateColumns").collect()).filter(
    (c) => c.module === MODULE,
  );
  const byTemplate = new Map<string, typeof templateCols>();
  for (const c of templateCols) {
    const k = String(c.eventTypeId);
    (byTemplate.get(k) ?? byTemplate.set(k, []).get(k)!).push(c);
  }
  for (const [eventTypeId, cols] of byTemplate) {
    if (cols.some((c) => c.key === def.key)) continue;
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
    templateColumnsAdded++;
  }

  // ── Events ───────────────────────────────────────────────────────────────
  const eventCols = (await ctx.db.query("eventColumns").collect()).filter(
    (c) => c.module === MODULE,
  );
  const byEvent = new Map<string, typeof eventCols>();
  for (const c of eventCols) {
    const k = String(c.eventId);
    (byEvent.get(k) ?? byEvent.set(k, []).get(k)!).push(c);
  }
  for (const [eventId, cols] of byEvent) {
    if (cols.some((c) => c.key === def.key)) continue;
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
    eventColumnsAdded++;
  }

  return { templateColumnsAdded, eventColumnsAdded };
}

export const backfillRunOfShowDuration: Migration = {
  name: "0019_backfill_run_of_show_duration",
  run: runBackfillRunOfShowDuration,
};
