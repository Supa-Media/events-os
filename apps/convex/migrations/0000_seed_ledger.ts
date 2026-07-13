import type { MutationCtx } from "../_generated/server";
import type { Migration } from "./index";

/**
 * Names of migrations that were applied by hand (via `npx convex run --prod`)
 * against prod BEFORE the ledger existed. Their bodies still live in
 * `migrations.ts` as manual internalMutations for fresh-environment / re-run
 * use, but on an established deployment they're already done — so this migration
 * seeds their ledger rows as pre-applied without executing them, and the runner
 * skips them forever after.
 *
 * NEW Phase-1+ migrations are NOT listed here (they should actually run).
 */
const ALREADY_APPLIED = [
  "backfillMissingDefaultColumns",
  "migrateRolesToScoped",
  "cleanupLegacyRoles",
  "retireSuppliesPackedStatus",
  "showSuppliesQty",
  "migrateModulesToDeltas",
];

/** Insert a pre-applied ledger row for each historical migration (idempotent). */
export async function runSeedLedger(ctx: MutationCtx) {
  let seeded = 0;
  for (const name of ALREADY_APPLIED) {
    const existing = await ctx.db
      .query("schemaMigrations")
      .withIndex("by_name", (q) => q.eq("name", name))
      .unique();
    if (existing) continue;
    await ctx.db.insert("schemaMigrations", {
      name,
      ranAt: Date.now(),
      result: "seeded as pre-applied (ran by hand before the ledger existed)",
    });
    seeded++;
  }
  return { seeded };
}

export const seedLedger: Migration = {
  name: "0000_seed_ledger",
  run: runSeedLedger,
};
