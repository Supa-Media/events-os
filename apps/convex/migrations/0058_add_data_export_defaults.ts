import type { MutationCtx } from "../_generated/server";
import type { Migration } from "./index";

/**
 * The `data.export` power (founder grant, 2026-07-31) — mirrors
 * `0033_add_giving_power_defaults.ts` / `0053_add_campaign_design_defaults.ts`
 * exactly, for the same reason: export access is seat-capability-derived
 * (`apps/convex/lib/dataExportAccess.ts` off `lib/seats.ts#
 * getSeatDerivedExportScopes`, which reads a seat def's `capabilities`
 * array), so making a NEW capability live on an already-seeded org's
 * `seatDefs` rows is a data change, not an enforcement one. Without this, the
 * template change in `packages/shared/src/seats.ts` (`data.export` appended
 * to six seats' default capabilities) only reaches BRAND-NEW orgs and the
 * export feature is dead on arrival everywhere else — every existing
 * deployment's seatDefs rows were stamped by `0022_seed_seat_defs` before
 * this capability existed, and `0022` is skip-by-slug (never re-touches an
 * existing row), so nothing else would ever carry it forward.
 *
 * Seats granted `data.export` (verbatim founder list, see `seats.ts`'s own
 * per-seat `2026-07-31` comments): executive_director, financial_manager,
 * development_director, expansion_director, marketing_director,
 * chapter_director.
 *
 * ADDITIVE-ONLY, same safety argument as 0033/0053: only appends
 * `data.export` to a row that lacks it; a row already carrying it (freshly
 * seeded orgs, or a re-run) is skipped untouched. Never removes a
 * capability, so an ED who has since revoked export access from one of these
 * seats at runtime (via the org chart's power control) is never silently
 * re-granted it by a later re-run — the ledger guarantees this migration
 * itself only ever fires once, but content-idempotency is the belt-and-
 * suspenders here exactly as it is in both precedents.
 *
 * Idempotent: a row already carrying `data.export` is skipped, so a re-run
 * touches nothing.
 */
const DATA_EXPORT_SLUGS = [
  "executive_director",
  "financial_manager",
  "development_director",
  "expansion_director",
  "marketing_director",
  "chapter_director",
] as const;

export async function runAddDataExportDefaults(ctx: MutationCtx) {
  let patched = 0;
  let skipped = 0;

  for (const slug of DATA_EXPORT_SLUGS) {
    const rows = await ctx.db
      .query("seatDefs")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .collect();

    for (const row of rows) {
      if (row.capabilities.includes("data.export")) {
        skipped++;
        continue;
      }
      await ctx.db.patch(row._id, {
        capabilities: [...row.capabilities, "data.export"],
        updatedAt: Date.now(),
      });
      patched++;
    }
  }

  return { patched, skipped };
}

export const addDataExportDefaults: Migration = {
  name: "0058_add_data_export_defaults",
  run: runAddDataExportDefaults,
};
