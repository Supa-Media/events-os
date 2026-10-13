import type { MutationCtx } from "../_generated/server";
import type { Migration } from "./index";

/**
 * Founder ask (2026-10-13): "There needs to also be an easy way to edit
 * academy courses, make it a power under people, so I can give people the
 * power to edit easily."
 *
 * The power is `people.academy.edit` (`packages/shared/src/powers.ts`), and the
 * seat template (`packages/shared/src/seats.ts`) now grants it to the
 * Executive Director, the Expansion Director (who owns the training pipeline)
 * and the Training Associate. A template change alone never reaches an org
 * already stamped by `0022_seed_seat_defs`, so this carries it onto the live
 * `seatDefs` rows — the same additive, content-idempotent shape as
 * `0033_add_giving_power_defaults`: it only ever APPENDS the power to a row
 * that lacks it and never rewrites or removes anything, so a power an editor
 * has set on these seats since is left alone.
 */
const TARGET_SLUGS = [
  "executive_director",
  "expansion_director",
  "training_associate",
] as const;

export async function runAddAcademyEditPowerDefaults(ctx: MutationCtx) {
  let patched = 0;
  let skipped = 0;
  for (const slug of TARGET_SLUGS) {
    const rows = await ctx.db
      .query("seatDefs")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .collect();
    for (const row of rows) {
      if (row.capabilities.includes("people.academy.edit")) {
        skipped++;
        continue;
      }
      await ctx.db.patch(row._id, {
        capabilities: [...row.capabilities, "people.academy.edit"],
        updatedAt: Date.now(),
      });
      patched++;
    }
  }
  return { patched, skipped };
}

export const addAcademyEditPowerDefaults: Migration = {
  name: "0089_add_academy_edit_power_defaults",
  run: runAddAcademyEditPowerDefaults,
};
