import type { MutationCtx } from "../_generated/server";
import type { Migration } from "./index";

/**
 * DRAIN the legacy fields superseded by the Chapter-OS cutover, so a later
 * Deploy C can drop them from the schema (Convex validates the schema against
 * existing data at push time, so every row must be free of the legacy field
 * BEFORE the field is removed — this migration ships in Deploy B, whose schema
 * still tolerates them).
 *
 * Fields cleared (each patched to `undefined`):
 *   - people.skills            → superseded by `services`   (0009 backfill)
 *   - people.isActive          → superseded by `status`     (0011 backfill)
 *   - templatePeople.team      → superseded by `teams`       (0010 backfill)
 *   - responsibilities.howTo   → superseded by `howToDocId`  (0012 materialize)
 *   - projects.statusNote      → folded into `projectComments` (0013 fold)
 *   - projects.nextSteps       → folded into `projectComments` (0013 fold)
 *   - docs.seedHash            → retired provenance marker
 *   - siteMarkers.category     → retired (markers use free `color` now)
 *
 * The paired backfills (0009–0013) run BEFORE this in the registry, so on a
 * fresh DB the copy-then-clear nets to new-fields-populated + legacy-empty.
 *
 * Idempotent: a row whose legacy field is already `undefined` is a no-op, so a
 * second run clears nothing. Reads each table in a single pass (roster / config
 * scale), consistent with the sibling backfills; if any table outgrew a single
 * transaction it would move to the `.take(n)` + `scheduler.runAfter` pattern.
 */
export async function runClearLegacyFields(ctx: MutationCtx) {
  let cleared = 0;

  const clear = async <T extends { _id: any }>(
    row: T,
    keys: (keyof T)[],
  ): Promise<void> => {
    const patch: Record<string, undefined> = {};
    for (const k of keys) {
      if (row[k] !== undefined) patch[k as string] = undefined;
    }
    if (Object.keys(patch).length > 0) {
      await ctx.db.patch(row._id, patch);
      cleared++;
    }
  };

  for (const row of await ctx.db.query("people").collect()) {
    await clear(row, ["skills", "isActive"]);
  }
  for (const row of await ctx.db.query("templatePeople").collect()) {
    await clear(row, ["team"]);
  }
  for (const row of await ctx.db.query("responsibilities").collect()) {
    await clear(row, ["howTo"]);
  }
  for (const row of await ctx.db.query("projects").collect()) {
    await clear(row, ["statusNote", "nextSteps"]);
  }
  for (const row of await ctx.db.query("docs").collect()) {
    await clear(row, ["seedHash"]);
  }
  for (const row of await ctx.db.query("siteMarkers").collect()) {
    await clear(row, ["category"]);
  }

  return { cleared };
}

export const clearLegacyFields: Migration = {
  name: "0016_clear_legacy_fields",
  run: runClearLegacyFields,
};
