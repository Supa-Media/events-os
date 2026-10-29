import type { MutationCtx } from "../_generated/server";
import type { Migration } from "./index";

/**
 * Founder ask (2026-10-29): "Make it so that only the financial manager,
 * treasurer of chapters and the founder can publish financials publicly."
 *
 * The seat template (`packages/shared/src/seats.ts`) now grants
 * `finance.ledger.publish` to the Financial Manager (unchanged) and the
 * chapter Treasurer, and no longer to the Executive Director or the Chapter
 * Director. The founder publishes through the superuser short-circuit in
 * `lib/publicLedgerAccess.ts#hasLedgerPublish`, not through a seat.
 *
 * A template change never reaches an org already stamped by
 * `0022_seed_seat_defs`, so this carries it onto the live `seatDefs` rows.
 * Unlike the purely additive power migrations (`0089`), this one also
 * REMOVES the power from two seats, because the ask is a restriction: leaving
 * it on the ED's live row would leave a second way to publish that the
 * founder said shouldn't exist. Only this one power is touched, so any other
 * power an editor has set on these seats since is left alone. The legacy
 * spelling `finance.publish` is removed too, since `expandPowers` reads it as
 * the same power. Idempotent: a second run finds nothing to change.
 */
const PUBLISH = "finance.ledger.publish";
const PUBLISH_SPELLINGS = new Set([PUBLISH, "finance.publish"]);

const GRANT_SLUGS = ["treasurer"] as const;
const REVOKE_SLUGS = ["executive_director", "chapter_director"] as const;

export async function runLedgerPublishToTreasurers(ctx: MutationCtx) {
  let granted = 0;
  let revoked = 0;
  for (const slug of GRANT_SLUGS) {
    const rows = await ctx.db
      .query("seatDefs")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .collect();
    for (const row of rows) {
      if (row.capabilities.some((c) => PUBLISH_SPELLINGS.has(c))) continue;
      await ctx.db.patch(row._id, {
        capabilities: [...row.capabilities, PUBLISH],
        updatedAt: Date.now(),
      });
      granted++;
    }
  }
  for (const slug of REVOKE_SLUGS) {
    const rows = await ctx.db
      .query("seatDefs")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .collect();
    for (const row of rows) {
      const kept = row.capabilities.filter((c) => !PUBLISH_SPELLINGS.has(c));
      if (kept.length === row.capabilities.length) continue;
      await ctx.db.patch(row._id, { capabilities: kept, updatedAt: Date.now() });
      revoked++;
    }
  }
  return { granted, revoked };
}

export const ledgerPublishToTreasurers: Migration = {
  name: "0097_ledger_publish_to_treasurers",
  run: runLedgerPublishToTreasurers,
};
