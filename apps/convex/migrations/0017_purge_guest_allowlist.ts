import type { MutationCtx } from "../_generated/server";
import type { Migration } from "./index";

/**
 * PURGE the legacy `guestAllowlist` table: delete every row so a later Deploy C
 * can remove the table from the schema (Convex requires a table be empty before
 * its definition is dropped). The rows were already copied into the new
 * `accessAllowlist` table by `copyGuestAllowlist` (0014), and all reads/writes
 * now target `accessAllowlist` only (Deploy B), so nothing depends on these rows
 * anymore. Precedent: `cleanupLegacyRoles` in `migrations.ts`.
 *
 * Idempotent: an already-empty table is a no-op. Deletes in bounded batches
 * (`.take(n)` then delete) so a large table can't blow the mutation's document
 * limits; the allowlist is small (individually seeded emails), so it drains in
 * one pass.
 */
export async function runPurgeGuestAllowlist(ctx: MutationCtx) {
  let deleted = 0;
  for (;;) {
    const batch = await ctx.db.query("guestAllowlist").take(200);
    if (batch.length === 0) break;
    for (const row of batch) {
      await ctx.db.delete(row._id);
      deleted++;
    }
    if (batch.length < 200) break;
  }
  return { deleted };
}

export const purgeGuestAllowlist: Migration = {
  name: "0017_purge_guest_allowlist",
  run: runPurgeGuestAllowlist,
};
