/**
 * Auto-migration registry.
 *
 * `MIGRATIONS` is the ordered list the runner (`migrations.runPending`) walks on
 * every deploy: for each entry it checks the `schemaMigrations` ledger by `name`
 * and, if absent, runs it then records the ledger row. Ordering is explicit and
 * lexicographic — the `NNNN` filename prefix is the sequence, so dependent
 * migrations sequence correctly.
 *
 * Each migration lives in its own `NNNN_description.ts` file exporting a
 * `{ name, run }` object; add new ones by creating the file and appending it
 * here in filename order. Keep every `run` INDEPENDENTLY idempotent (the ledger
 * skip is belt-and-suspenders, not the only guard).
 *
 * NB: `apps/convex/migrations.ts` (the sibling file) holds the historical
 * hand-run migration bodies + the `runPending` runner; this folder is the
 * registry. Both coexist exactly like `schema.ts` + `schema/` in this project.
 */
import type { MutationCtx } from "../_generated/server";

import { seedLedger } from "./0000_seed_ledger";
import { cleanupRenamedGuideSlugs } from "./0007_cleanup_renamed_guide_slugs";
import { cleanupOrphanedPlacements } from "./0008_cleanup_orphaned_placements";
import { backfillPeopleServices } from "./0009_backfill_people_services";
import { backfillTemplatePeopleTeams } from "./0010_backfill_template_people_teams";
import { backfillPersonStatus } from "./0011_backfill_person_status";
import { materializeHowToDocs } from "./0012_materialize_how_to_docs";
import { foldProjectStatusNotes } from "./0013_fold_project_status_notes";
import { copyGuestAllowlist } from "./0014_copy_guest_allowlist";
import { auditColumnTypes } from "./0015_audit_column_types";

/** One registered migration: a stable `name` (the ledger key) + its effect. */
export type Migration = {
  name: string;
  run: (ctx: MutationCtx) => Promise<unknown>;
};

/** Ordered registry. Runner applies these top-to-bottom, skipping ledgered ones. */
export const MIGRATIONS: Migration[] = [
  seedLedger,
  cleanupRenamedGuideSlugs,
  cleanupOrphanedPlacements,
  // Phase 3 Deploy A — additive backfills (copy old → new, never delete old).
  backfillPeopleServices,
  backfillTemplatePeopleTeams,
  backfillPersonStatus,
  materializeHowToDocs,
  foldProjectStatusNotes,
  copyGuestAllowlist,
  auditColumnTypes,
];
