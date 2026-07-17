import type { MutationCtx } from "../_generated/server";
import type { Migration } from "./index";

/**
 * Owner decision (2026-07-16, verbatim): "Chapter Director does have
 * financial powers, they approve budgets, they can also see spending... they
 * should see how the money is spent as well. But they still need to get
 * their things reconciled by their treasurer or financial manager." —
 * `finance.viewer` was added to the `chapter_director` template seat
 * (`packages/shared/src/seats.ts`) to give this read-only "SEE" reach; this
 * migration is the backfill that carries that template edit onto the LIVE
 * `seatDefs` rows already stamped by `0022_seed_seat_defs` (seat defs are
 * DB-backed and runtime-editable — a template change alone never reaches an
 * already-seeded org/chapter; only a NEW org/chapter stamped after this PR
 * picks up the new template directly).
 *
 * `seatDefs` is a GLOBAL chart (see `schema/seats.ts`'s module doc: "the
 * CHAPTER chart is defined once and stamped identically onto every chapter —
 * same shape, same duties, same capabilities everywhere. Only OCCUPANCY...
 * varies per chapter") — so there's exactly ONE `chapter_director` row to
 * patch, not one per chapter. This migration still queries `by_slug` and
 * loops (rather than assuming exactly one match) so it stays correct even if
 * that global-chart invariant is ever relaxed.
 *
 * Idempotent by CONTENT, not just the ledger: patches the `chapter_director`
 * `seatDefs` row only if its `capabilities` array is missing
 * `"finance.viewer"`, and skips it if already present — belt-and-suspenders
 * alongside the `runPending` ledger, exactly like `0022_seed_seat_defs`'s own
 * per-row `by_slug` guard. Never touches any OTHER seat's capabilities (in
 * particular, never touches `treasurer` — the record/reconcile-write side
 * stays exactly as-is).
 */
export async function runAddCdFinanceViewer(ctx: MutationCtx) {
  let patched = 0;
  let skipped = 0;

  const rows = await ctx.db
    .query("seatDefs")
    .withIndex("by_slug", (q) => q.eq("slug", "chapter_director"))
    .collect();

  for (const row of rows) {
    if (row.capabilities.includes("finance.viewer")) {
      skipped++;
      continue;
    }
    await ctx.db.patch(row._id, {
      capabilities: [...row.capabilities, "finance.viewer"],
      updatedAt: Date.now(),
    });
    patched++;
  }

  return { patched, skipped };
}

export const addCdFinanceViewer: Migration = {
  name: "0024_add_cd_finance_viewer",
  run: runAddCdFinanceViewer,
};
