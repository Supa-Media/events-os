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
import { clearLegacyFields } from "./0016_clear_legacy_fields";
import { purgeGuestAllowlist } from "./0017_purge_guest_allowlist";
import { backfillCourseCompletions } from "./0018_backfill_course_completions";
import { backfillRunOfShowDuration } from "./0019_backfill_run_of_show_duration";
import { permitsStatesAndFallback } from "./0020_permits_states_and_fallback";
import { inventoryCategoryToTags } from "./0021_inventory_category_to_tags";
import { seedSeatDefs } from "./0022_seed_seat_defs";
import { seedSeatAssignments } from "./0023_seed_seat_assignments";
import { repointDerivedSeatDuties } from "./0024_repoint_derived_seat_duties";
import { addCdFinanceViewer } from "./0025_add_cd_finance_viewer";
import { migrateBudgetV1Lines } from "./0026_migrate_budget_v1_lines";
import { syncLinkedBudgetIdentity } from "./0027_sync_linked_budget_identity";
import { reawardCourseCompletions } from "./0028_reaward_course_completions";
import { territoriesCutover } from "./0029_territories_cutover";

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
  // Phase 3 Deploy B — drain the legacy fields/table (reads now use new fields
  // only) so Deploy C can drop them from the schema. Run AFTER the backfills.
  clearLegacyFields,
  purgeGuestAllowlist,
  // Academy redesign — award course-completion badges from existing progress.
  backfillCourseCompletions,
  // Run of Show v1 — add the `duration` (segment length) column to existing grids.
  backfillRunOfShowDuration,
  // Permits v1 — merge denied/waived status options + add jurisdiction/fallback.
  permitsStatesAndFallback,
  // Inventory ⇄ Supplies — fold the retired `category` enum into free-form tags.
  inventoryCategoryToTags,
  // Org chart v1 — seed seatDefs from the shared SEAT_DEFS template.
  seedSeatDefs,
  // Org chart v1 — seed seatAssignments from legacy specializedRoles.
  seedSeatAssignments,
  // Derived-seat duty fix — repoint duties off the central chart's computed
  // `chapter_directors` mirror onto the real chapter-chart `chapter_director`
  // seat (one Chapter Director role everywhere).
  repointDerivedSeatDuties,
  // Chapter Director finance visibility (owner decision, 2026-07-16) — patch
  // the live chapter_director seatDefs row to add finance.viewer.
  addCdFinanceViewer,
  // One money surface per event: drain Budget v1's `budgetLineItems` into v2
  // `budgetLines` (get-or-create the event's finance budget row, migrate each
  // line, delete the drained v1 rows) so `schema/budget.ts` can be removed.
  migrateBudgetV1Lines,
  // Budget identity & dates — backfill the write-through sync
  // (`syncBudgetIdentityForRef`) onto every existing linked one_time budget
  // whose label/year/month already drifted from its live entity.
  syncLinkedBudgetIdentity,
  // Chapter money model reshape — re-run the course-completion award after
  // `finance-tiers-and-skim` moved out of `chapter-director` into the new
  // shared `chapter-money-model` course, so anyone who'd already passed both
  // of chapter-director's remaining modules picks up the badge.
  reawardCourseCompletions,
  // Territories cutover — replace `cityCampaigns` with `territories` (1:1 with
  // chapters), create shadow chapters for prospect/raising rows, and re-scope
  // campaign-linked pledges/donors/gifts DIRECTLY onto their chapters (deltas
  // net to zero). Idempotent; see 0029_territories_cutover.ts.
  territoriesCutover,
];
