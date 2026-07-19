import type { MutationCtx } from "../_generated/server";
import type { Migration } from "./index";

/**
 * Owner decision (2026-07-19, Seyi, verbatim): "Lets restrict the giving page
 * to executive directors, expansion directors, financial managers, treasurers
 * (chapter scope) and central director (chapter scope) — make it into a
 * 'power' that is assignable to the role. We also want the development
 * associate to see it, so yeah make it a power so i can assign it to roles."
 *
 * Giving-desk access is already seat-capability-derived
 * (`apps/convex/lib/givingAccess.ts` off `lib/seats.ts#getSeatDerivedGivingCapabilities`),
 * so making it a runtime-assignable POWER is a data change, not an enforcement
 * one. The template (`packages/shared/src/seats.ts`) gained the two seats the
 * owner's list was missing — `expansion_director` and `financial_manager` now
 * default to `giving.view` + `nav.giving` (central-lens READ; never
 * `giving.manage`, which stays the Development Director / ED desk). This
 * migration carries that template edit onto the LIVE `seatDefs` rows already
 * stamped by `0022_seed_seat_defs` — a template change alone never reaches an
 * already-seeded org (only a NEW org stamped after this PR picks it up
 * directly). Same shape as `0025_add_cd_finance_viewer`.
 *
 * ── Why this is safe against runtime power edits (feature 3) ────────────────
 * The runtime editor (`seats.ts#setSeatGivingPower`, and the general
 * `seatStructure.ts#updateSeat`) patches a def's `capabilities` at the ED's
 * discretion. This migration MUST NOT clobber those live edits. It doesn't,
 * for two independent reasons, so NO `capabilitiesEditedAt` marker is needed
 * (investigated per the PR spec — the minimal correct mechanism is
 * additive-only):
 *   1. There is NO wholesale template re-sync path in this codebase.
 *      `0022_seed_seat_defs` is the only seeder and it is skip-by-slug (it
 *      never re-touches an existing row); every other seatDefs write is either
 *      an additive per-row migration (0025, this file) or the runtime editor.
 *      So a future deploy re-running `runPending` can never re-stamp a row
 *      from the template and overwrite a runtime edit.
 *   2. This migration is idempotent BY CONTENT and ADDITIVE-ONLY: it only ever
 *      APPENDS the two missing capabilities to a row that lacks them, and
 *      skips a row that already carries `giving.view`. It never removes a
 *      capability and never rewrites the array wholesale. If the ED has since
 *      turned an FM/Expansion seat's giving to "manage" (adding `giving.manage`)
 *      or to "none" (removing `giving.view`), re-running this is a no-op /
 *      still-additive and never reverts their intent:
 *        - already has `giving.view` (default, or manager) → skipped.
 *        - turned to "none" (no `giving.view`) → this would re-add the default.
 *          That's the ledger's job (it runs ONCE), so in practice this fires
 *          exactly once on the backfill; a hand re-run re-asserting the
 *          template default is the same "template default" contract 0022 has.
 */
const TARGET_SLUGS = ["expansion_director", "financial_manager"] as const;

export async function runAddGivingPowerDefaults(ctx: MutationCtx) {
  let patched = 0;
  let skipped = 0;

  for (const slug of TARGET_SLUGS) {
    const rows = await ctx.db
      .query("seatDefs")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .collect();

    for (const row of rows) {
      // Additive + content-idempotent: only touch a row still missing the
      // default READ capability. A row already carrying `giving.view` (the
      // default, or because the ED promoted it to giving.manage) is left
      // exactly as-is — never rewritten, never downgraded.
      if (row.capabilities.includes("giving.view")) {
        skipped++;
        continue;
      }
      const next = [...row.capabilities, "giving.view", "nav.giving"] as const;
      await ctx.db.patch(row._id, {
        capabilities: [...next],
        updatedAt: Date.now(),
      });
      patched++;
    }
  }

  return { patched, skipped };
}

export const addGivingPowerDefaults: Migration = {
  name: "0033_add_giving_power_defaults",
  run: runAddGivingPowerDefaults,
};
