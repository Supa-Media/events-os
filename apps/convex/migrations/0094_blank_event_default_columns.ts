import type { MutationCtx } from "../_generated/server";
import type { Migration } from "./index";
import { GRID_CORE_MODULE_KEYS } from "@events-os/shared";
import {
  BLANK_TEMPLATE_SLUG,
  ensureBlankTemplateColumns,
  ensureEventModuleColumns,
} from "../lib/templates";

/**
 * Give blank events (and the per-chapter blank templates behind them) the
 * default columns of their active grid areas (2026-10-20).
 *
 * The blank template was created with zero columns, and an event clones its
 * template's columns. So a blank event's Tasks and Debrief areas, which are
 * active by default, had no columns at all: "+ Add tasks row" added a row with
 * nothing to type into. `getOrCreateBlankTemplate` now seeds them; this repairs
 * the templates and events made before that.
 *
 * Only a module with NO columns is touched (`ensure*` skips any module that has
 * even one), so a column someone added or hid is never overwritten.
 * Idempotent: a second run finds every active grid area already has columns.
 */
export async function runBlankEventDefaultColumns(ctx: MutationCtx) {
  let templates = 0;
  let events = 0;
  const types = await ctx.db.query("eventTypes").collect();
  for (const t of types) {
    if (t.isBlank !== true && t.slug !== BLANK_TEMPLATE_SLUG) continue;
    await ensureBlankTemplateColumns(ctx, t);
    templates++;
    const evs = await ctx.db
      .query("events")
      .withIndex("by_eventType", (q) => q.eq("eventTypeId", t._id))
      .collect();
    for (const e of evs) {
      const disabled = new Set(e.disabledCoreModules ?? []);
      let changed = false;
      for (const m of GRID_CORE_MODULE_KEYS) {
        if (disabled.has(m)) continue;
        if (await ensureEventModuleColumns(ctx, e._id, m)) changed = true;
      }
      if (changed) events++;
    }
  }
  return { templates, events };
}

export const blankEventDefaultColumns: Migration = {
  name: "0094_blank_event_default_columns",
  run: runBlankEventDefaultColumns,
};
