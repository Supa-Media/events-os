import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Migration ledger — the source of truth for which data/schema migrations have
 * already been applied to THIS deployment.
 *
 * The auto-migration pipeline (`migrations.runPending`, `migrations/index.ts`)
 * iterates the ordered `MIGRATIONS` registry and, for each, checks this table by
 * `name`: a migration is "applied" iff a row with its `name` exists. Absent →
 * run it, then insert the row. Present → skip. This makes deploy-time migration
 * a no-op when nothing is pending and keeps already-run history from re-running
 * (see the `0000_seed_ledger` migration, which pre-seeds the names of the
 * hand-run historical migrations).
 */
export const schemaMigrations = defineTable({
  /** Registry name of the migration, e.g. "0007_cleanup_renamed_guide_slugs". */
  name: v.string(),
  /** When the migration finished (Date.now()). */
  ranAt: v.number(),
  /** Optional JSON-encoded result / note the runner recorded. */
  result: v.optional(v.string()),
}).index("by_name", ["name"]);
