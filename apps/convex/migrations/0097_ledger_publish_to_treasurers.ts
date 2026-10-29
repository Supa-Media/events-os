import type { MutationCtx } from "../_generated/server";
import type { Migration } from "./index";

/**
 * Founder ask (2026-10-29): chapter Treasurers may publish their chapter's
 * month. The seat template (`packages/shared/src/seats.ts`) grants
 * `finance.ledger.publish` to the Treasurer, and a template change never
 * reaches an org already stamped by `0022_seed_seat_defs`, so this carries it
 * onto the live `seatDefs` rows.
 *
 * HISTORY. As first shipped (events-os #884) this also REMOVED the power from
 * the Executive Director and Chapter Director rows, and it ran on production
 * that way. The founder corrected the ask the same evening, so the revoke
 * half was taken out of this body (a fresh database now only gets the grant)
 * and `0098_restore_ledger_publish_ed_cd` puts the power back on the rows
 * production had already lost it from.
 *
 * Additive and content-idempotent: it only APPENDS the power to a row that
 * lacks it (in either spelling — `expandPowers` reads the legacy
 * `finance.publish` as the same power) and never removes anything.
 */
const PUBLISH = "finance.ledger.publish";
const PUBLISH_SPELLINGS = new Set([PUBLISH, "finance.publish"]);

export async function runLedgerPublishToTreasurers(ctx: MutationCtx) {
  let granted = 0;
  let skipped = 0;
  const rows = await ctx.db
    .query("seatDefs")
    .withIndex("by_slug", (q) => q.eq("slug", "treasurer"))
    .collect();
  for (const row of rows) {
    if (row.capabilities.some((c) => PUBLISH_SPELLINGS.has(c))) {
      skipped++;
      continue;
    }
    await ctx.db.patch(row._id, {
      capabilities: [...row.capabilities, PUBLISH],
      updatedAt: Date.now(),
    });
    granted++;
  }
  return { granted, skipped };
}

export const ledgerPublishToTreasurers: Migration = {
  name: "0097_ledger_publish_to_treasurers",
  run: runLedgerPublishToTreasurers,
};
