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
 *
 * NOT EVERY NUMBERED FILE IS IN THE REGISTRY. Some are numbered purely for
 * discoverability and run by other means — a `MutationCtx` can't `fetch` or
 * touch the filesystem, so anything that needs to must be an action:
 *  - `0037` / `0048` are human-run (`npx convex run`), by design.
 *  - `0050` is human-run and self-reschedules in batches.
 *  - `0052` is driven by an HOURLY CRON (`crons.ts` → "newsletter artwork
 *    import"), because its source is a dying CDN and the run therefore has to
 *    be retryable — which is the one thing the ledger guarantees it isn't.
 *    Its own header spells the reasoning out.
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
import { backfillLaunchFund } from "./0030_backfill_launch_fund";
import { giftMethodSources } from "./0031_gift_method_sources";
import { linkDonorPeople } from "./0032_link_donor_people";
import { addGivingPowerDefaults } from "./0033_add_giving_power_defaults";
import { mergeDuplicateGbGuests } from "./0034_merge_duplicate_gb_guests";
import { backfillReceiptDocuments } from "./0035_backfill_receipt_documents";
import { addCampaignPowerDefaults } from "./0036_add_campaign_power_defaults";
import { backfillContactOnlyPeople } from "./0038_backfill_contact_only_people";
import { backfillPersonEmails } from "./0039_backfill_person_emails";
import { migrateLegacyAudiences } from "./0040_migrate_legacy_audiences";
import { migrateGuestAudiences } from "./0041_migrate_guest_audiences";
import { wrapTargeting } from "./0042_wrap_targeting";
import { splitPersonNames } from "./0043_split_person_names";
import { reimbursementPayoutsOutflow } from "./0044_reimbursement_payouts_outflow";
import { backfillPersonalRepayments } from "./0045_backfill_personal_repayments";
import { seedServiceCatalog } from "./0046_seed_service_catalog";
import { serviceConditionsToIds } from "./0047_service_conditions_to_ids";
import { seedBuiltInCampaignTemplates } from "./0049_seed_builtin_campaign_templates";
import { backfillPeoplePersona } from "./0051_backfill_people_persona";
import { addCampaignDesignDefaults } from "./0053_add_campaign_design_defaults";
import { seedOrgMailingAddress } from "./0054_seed_org_mailing_address";
import { mergeCampaignTemplatesIntoCampaigns } from "./0055_merge_campaign_templates_into_campaigns";
import { upgradeBuiltInNewsletterTiptap } from "./0056_upgrade_builtin_newsletter_tiptap";
import { backfillIncreaseAccountActivity } from "./0057_backfill_increase_transactions";
import { addDataExportDefaults } from "./0058_add_data_export_defaults";
import { splitLegacyIncreaseCards } from "./0059_split_legacy_increase_cards";
import { addEventsCheckinDefaults } from "./0060_add_events_checkin_defaults";
import { stampDigestWatermarkProvenance } from "./0061_stamp_digest_watermark_provenance";
import { standardizePowers } from "./0062_standardize_powers";
import { fixGenesisUtcMidnight } from "./0063_fix_genesis_utc_midnight";
import { releaseLegacyCardAutolocks } from "./0064_release_legacy_card_autolocks";
import { stampDefaultCategoryExpenseHints } from "./0065_stamp_default_category_expense_hints";
import { stampCashbackSourceCategory } from "./0066_stamp_cashback_source_category";
import { renameReimbursementPayoutRows } from "./0067_rename_reimbursement_payout_rows";
import { materializeReimbursementCodings } from "./0068_materialize_reimbursement_codings";
import { materializeReimbursementReceiptsMigration } from "./0069_materialize_reimbursement_receipts";
import { linkWireGiftsToTheirDeposit } from "./0070_link_wire_gifts_to_their_deposit";
import { removeUnexecutedBalanceSettlementsMigration } from "./0071_remove_unexecuted_balance_settlements";
import { foldFeeCoverageIntoGifts } from "./0072_fold_fee_coverage_into_gifts";
import { bookKnownRepaymentFeeCoverage } from "./0073_book_known_repayment_fee_coverage";
import { bookRepaymentCoverageBySession } from "./0074_book_repayment_coverage_by_session";
import { labelFeeCoverageRows } from "./0075_label_fee_coverage_rows";
import { orgWideBudgetCategories } from "./0076_org_wide_budget_categories";

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
  // Territories launch pot — stamp `gifts.countedInLaunchFund` + set each
  // pre-launch territory's `launchFundCents` from its chapter-scope gift sum
  // (recompute-style, idempotent; launched pots left frozen). See 0030.
  backfillLaunchFund,
  // Gift sources cutover — relabel every deprecated-legacy `imported` gift onto
  // the merged/widened source vocabulary (`givebutter` when Givebutter-sourced,
  // else `other`). Pure relabel, no rollup/pot change; idempotent. See 0031.
  giftMethodSources,
  // Donor↔People link backfill — stamp `donors.personId` for every existing
  // chapter-scope donor via the same matching primitive new writes use
  // (`linkDonorToPerson`); central-scope donors stay unlinked by design.
  // Idempotent (already-linked donors skipped). See 0032.
  linkDonorPeople,
  // Giving desk as an assignable per-role power (owner decision 2026-07-19) —
  // add the default giving.view + nav.giving to expansion_director &
  // financial_manager's live seatDefs rows so already-seeded orgs pick up the
  // two seats the owner's default-access list was missing. Additive-only, so
  // it never clobbers a runtime giving-power edit (see 0033's doc). Idempotent.
  addGivingPowerDefaults,
  // Field Day duplicate-guest merge — 4 buyers whose live Givebutter email
  // differs from their CSV-backfill email ended up with two guest rows each
  // on that event; merge the stale backfilled row into the live synced row
  // (phone/note folded over, stale deleted) and decrement goingCount by 4.
  // One-time, hardcoded pairs; idempotent (already-merged pairs are
  // `skippedMissing` on re-run). See 0034.
  mergeDuplicateGbGuests,
  // Receipts foundation — backfill the first-class `receipts` + `receiptLinks`
  // layer from the legacy `transactions.receiptStorageId` cache (one document +
  // one `backfill` link per receipted txn; email-matched txns get their inbound
  // provenance + OCR read seeded into canonical). Idempotent (already-linked
  // txns skipped); batched with scheduler continuation. See 0035.
  backfillReceiptDocuments,
  // Two-party campaign approval (founder requirement, 2026-07-24) — add
  // campaigns.approve + campaigns.compose to executive_director/
  // financial_manager/marketing_director's live seatDefs rows so
  // already-seeded orgs pick up the same default campaign-approval access
  // the template now grants a brand-new org automatically. Additive-only
  // (see 0036's doc). Idempotent.
  addCampaignPowerDefaults,
  // Person-centric audiences Phase 1 — flag every EXISTING donor/import
  // auto-created roster row (`isTeamMember: false`, notes "Added from
  // Giving"/"Added from import") as `isContactOnly: true` so roster-facing
  // surfaces (People tab default view, org-chart, manager derivation,
  // reminder digests) stop showing them as phantom volunteers. New rows get
  // the flag directly at insert time; this is the one-time catch-up for what
  // already exists. Idempotent (already-flagged rows skipped). See 0038.
  // NB: the SIBLING backfill for guest→people linkage (`rsvps.personId`,
  // Phase 1 item 2/3) is `migrations/0037_link_rsvp_people.ts` — deliberately
  // NOT in this registry (it needs a human dry-run first; see its own doc).
  backfillContactOnlyPeople,
  // Person-centric audiences Phase 2 — populate `personEmails` from every
  // pre-existing signal (`people.email`/`pwEmail`, linked donors' emails,
  // linked rsvps' emails), deduped by (person, email) keeping the
  // highest-trust source. New signals get a row for free at write time via
  // `lib/personEmails.ts#recordPersonEmail`; this is the one-time catch-up
  // for what already exists. Idempotent (already-present pairs skipped). See
  // 0039.
  backfillPersonEmails,
  // Person-centric audiences Phase 3 — repoint existing "people"/"donors"
  // sourced audiences onto the new `person_filters` model (equivalent
  // filters, same resolved recipients); "guests" rows are deliberately left
  // on the legacy source (see 0040's own doc for why). Idempotent (rows
  // already `person_filters`, and every "guests" row, are skipped). See 0040.
  migrateLegacyAudiences,
  // Person-centric audiences Phase 3 (cont'd) — 0037's rsvp→people backfill
  // has now run in prod, so this repoints "guests"-sourced audiences that
  // carry a specific `filters.eventId` onto `person_filters`
  // {attendedEventId}; a "guests" row with no `eventId` ("attended anything,
  // ever") has no faithful person_filters equivalent today and stays on the
  // legacy source (see 0041's own doc). Idempotent (already-migrated rows,
  // unscoped "guests" rows, and non-"guests" rows are all skipped). See 0041.
  migrateGuestAudiences,
  // Targeting v2 (specs/audience-targeting-v2.md) — stamp a translated
  // `targeting` block onto every audience row that lacks one (person_filters
  // criteria → one include group; effective excludeFilters → one exclude
  // group; unscoped "guests" rows → the new attended_any primitive). Legacy
  // fields stay in place; audiences referenced by an in-flight approval are
  // skipped (hash-drift protection) for a later manual re-run. Idempotent
  // (wrapped rows skipped). See 0042.
  wrapTargeting,
  // Structured names — stamp firstName/lastName onto every people row whose
  // display `name` splits unambiguously (exactly two tokens, the ONE rule in
  // @events-os/shared#names); ambiguous names stay unsplit and counted. `name`
  // itself never changes. Idempotent (already-split rows skipped, so a
  // hand-corrected split is never overwritten). See 0043.
  splitPersonNames,
  // Reimbursement payouts are spend — flip every historical payout txn from
  // `flow:"transfer"` (excluded from every budget/category total) to
  // `flow:"outflow"`, so reimbursed purchases finally count against the
  // budget they're already coded to. Only `source:"reimbursement"` rows;
  // skim/launch-grant/settlement legs and personal-charge repayment credits
  // stay transfers. Idempotent (rows already `outflow` are skipped). See 0044.
  reimbursementPayoutsOutflow,
  // Personal-expense flag/repayment (founder ask, reconcile flow) — backfill
  // `personalRepayments` rows for legacy `isPersonal:true` transactions that
  // the now-deleted `finances.ts#flagPersonal` boolean setter left with no
  // repayment (no payee to bill, no email ever sent). Idempotent (a row
  // already carrying `repaymentId` is skipped); a row resolving no payee
  // (no personId, no card) is left for a human to resolve by hand. See 0045.
  backfillPersonalRepayments,
  // Service Catalog: seed the canonical catalog ONCE, ORG-WIDE (shared by
  // every chapter — a Tenor is a Tenor in any chapter), then backfill
  // `people.serviceIds` for every chapter's roster from each person's legacy
  // free-text `services` strings via the audited 13-entry mapping. Unmapped
  // strings are left out and reported, never guessed. Idempotent
  // (already-seeded org-wide rows and already-backfilled people are
  // skipped). See 0046.
  seedServiceCatalog,
  // Convert saved `has_service` audience conditions from the pre-catalog
  // `{ service: string }` shape to `{ serviceId }`, by case-insensitive name
  // match against the now-seeded org-wide catalog (0046 must run first —
  // filename order guarantees it). A condition that doesn't resolve to
  // EXACTLY ONE catalog row (no match, or ambiguous) is left untouched and
  // reported — never silently widened to "everyone" or dropped. Idempotent
  // (conditions already carrying `serviceId` are skipped). See 0047.
  serviceConditionsToIds,
  // Built-in campaign templates — seed the Public Worship monthly newsletter
  // into the central scope so "start from a template" isn't empty in prod.
  // `ensureBuiltInTemplates` shipped with no production caller, so the
  // template existed only in tests. Central-only (campaigns is a central-only
  // surface). Idempotent: keyed on isBuiltIn+name, refreshes in place only
  // when the shipped content changed, and never resurrects an archived row.
  // See 0049.
  seedBuiltInCampaignTemplates,
  // People-counts Aggregate (`lib/peopleAggregate.ts`) — backfill
  // `people.persona` for every existing roster row AND populate the new
  // `peopleByPersona` TableAggregate from scratch, so `people.ts#counts`
  // starts returning correct numbers the moment this deploys instead of
  // reading an empty aggregate. Idempotent (already-stamped rows skip the
  // recompute; aggregate inserts are `insertIfDoesNotExist`, safe to
  // repeat). See 0051.
  backfillPeoplePersona,
  // The `campaigns.design` rung — grant it to `graphic_designer` /
  // `social_media_manager` (the seats that actually build the newsletter and
  // held NO campaign capability, so couldn't open the desk at all), and top
  // it up on any row already carrying compose/approve, where it's implied and
  // therefore changes no access. Never grants it to a seat an ED deliberately
  // set to "none". Idempotent. See 0053.
  addCampaignDesignDefaults,
  // Seeds the org's CAN-SPAM postal address, which the same release made a
  // hard requirement for every bulk send. Without it the deploy would refuse
  // every newsletter and event announcement until a superuser set the field
  // by hand. Never overwrites an address a human already entered. See 0054.
  seedOrgMailingAddress,
  // Templates merge (founder decision, 2026-07-29) — copy every
  // `campaignTemplates` row into `campaigns` as a `kind: "template"` row, so
  // "start from a template" and every design-rung write retarget onto ONE
  // table (see `schema/campaigns.ts`'s `kind` doc). The source table is left
  // untouched — writes to it are frozen elsewhere in this same PR
  // (`campaignTemplates.ts`), and it's dropped in a LATER PR once the
  // rollback window has passed. Idempotent, keyed on `mergedFromTemplateId`
  // provenance. See 0055.
  mergeCampaignTemplatesIntoCampaigns,
  // Built-in newsletter → tiptap (WS4 acceptance artefact) — 0049 already ran
  // and is ledgered, so it will never re-fire now that
  // `seedBuiltInTemplates`'s body ships the tiptap doc instead of the legacy
  // blocks one. This registered entry is the deploy-time guarantee that an
  // EXISTING deployment's built-in "Monthly newsletter" row actually flips,
  // rather than relying on the next `createCampaign` call or an artwork-cron
  // re-seed that self-disables once the import is already complete. See
  // 0056.
  upgradeBuiltInNewsletterTiptap,
  // First full-ledger Increase pull: non-card account activity (inbound ACH,
  // wires, fees, interest) is now ingested as `increase_ach`; the settled
  // history predating that only exists at Increase, so schedule ONE backfill
  // sweep (the daily cron then backstops). See 0057.
  backfillIncreaseAccountActivity,
  // Data Export as an assignable per-role power (founder grant, 2026-07-31) —
  // add data.export to executive_director/financial_manager/
  // development_director/expansion_director/marketing_director/
  // chapter_director's live seatDefs rows so already-seeded orgs pick up the
  // same default export access the template now grants a brand-new org
  // automatically. Additive-only (see 0058's doc). Idempotent. See 0058.
  addDataExportDefaults,
  // Cards-vs-Relay fusion repair — `issueCard`'s source-blind dedup used to
  // patch a freshly-minted Increase card's vendor id + last-4 onto the
  // holder's linked legacy (Relay) row, so the new card never appeared in the
  // app and the Relay attribution last-4 was overwritten. Splits every fused
  // row back into an increase-source card (keeps the vendor identity and
  // everything hanging off the row id) + a fresh legacy row carrying the
  // Relay last-4 recovered from its own attributed bank-feed transactions,
  // which are re-pointed onto it. Idempotent (repaired rows stop matching).
  // See 0059.
  splitLegacyIncreaseCards,
  // Door check-in as an assignable per-role power (events.checkin, 2026-08-06)
  // — add it to chapter_director/event_lead/event_organizers/
  // production_coordinator's live seatDefs rows so already-seeded orgs pick
  // up the same default door-check-in access the template now grants a
  // brand-new org automatically. Additive-only (see 0060's doc). Idempotent.
  addEventsCheckinDefaults,
  // Giving digests — label every EXISTING rule's watermark as a digest run's,
  // because that is where all of them came from. Absent reads as a synthetic
  // boundary, which would give a rule caught mid-drain the trailing-period
  // floor for one tick and mail a byte-identical duplicate digest before its
  // next claim re-stamps the flag. Self-healing either way, never skips a
  // gift — but one patch per rule is cheaper than one duplicate email to a
  // fundraising team. Additive-only, idempotent. See 0061.
  stampDigestWatermarkProvenance,
  // Standardize the power vocabulary (2026-08-12) — rewrite every seatDefs
  // row's capabilities into `<domain>[.<area>].<action>` and drop the three
  // strings that were never powers (`finance.central` was a scope,
  // `finance.record` was read by nothing, `nav.*` is derived now). Every gate
  // asks the new names, and seatDefs rows are runtime data, so without this an
  // already-seeded org loses every power at once. Access-preserving and
  // idempotent — see 0062's doc for the per-deletion argument.
  standardizePowers,
  // Genesis-imported history was stamped at UTC-midnight, which is the
  // PREVIOUS Eastern calendar day — every such row shifts to noon UTC (same
  // ET date year-round), so it lands in ITS OWN month's worklist/totals
  // instead of the prior one's. Live books only; a published month keeps its
  // old bucketing (frozen by design — corrections are revisions). Idempotent
  // (the shift moves a row off the exact-midnight boundary it's keyed on).
  // See 0063.
  fixGenesisUtcMidnight,
  // A lock only stops a swipe when Increase asks us about the authorization,
  // and it only asks about cards it issued — so the receipt auto-lock sweep was
  // stamping `status:"locked"` on linked Relay rows that went on working. The
  // sweep now skips them; this releases the ones it already marked, so no
  // surface keeps reporting an enforcement that never happened. The receipts
  // stay owed. See 0064.
  releaseLegacyCardAutolocks,
  // Coding categories vs. proof-question categories looked unrelated because
  // they WERE unrelated — `budgetCategories.expenseType` links a chapter's
  // spend categories to the §274(d) branch their coding form should default
  // to. New chapters get the hint from `insertDefaultExpenseCategories`
  // itself; this backfills it onto every already-seeded chapter's existing
  // default-named rows (exact name match, additive-only, idempotent). See
  // 0065's own doc.
  stampDefaultCategoryExpenseHints,
  // 0066: stamp `sourceCategory:"cashback_payment"` on pre-field Increase
  // cashback rows so `autoExplainedKind` covers history too — see the file.
  stampCashbackSourceCategory,
  // A multi-line reimbursement's payout row was titled after the payee
  // ("Reimbursement to Adam") rather than what was bought, and the
  // fill-blanks-only backfill will never overwrite a title that is already
  // set — so the derivation fix alone leaves every existing row wrong.
  // Rewrites ONLY rows still carrying the exact auto-generated payee label,
  // which is what keeps a bookkeeper's own wording safe. See 0067.
  renameReimbursementPayoutRows,
  // 0068: materialize a coding — ported verbatim, `status:"approved"` — for
  // every existing reimbursement payout whose request has exactly one
  // complete line, so historical payouts pick up the same auto-coding the
  // live path now applies. See the file.
  materializeReimbursementCodings,
  // A reimbursement's receipt was cached onto the payout row without the
  // `receipts`/`receiptLinks` rows behind it, so the charge said "attached"
  // while the Receipts library could never find the document. The live path
  // is fixed; this materializes the ones already in the books. Skips any row
  // a human already linked a receipt to. See 0069.
  materializeReimbursementReceiptsMigration,
  // A wire is money that hit the bank directly, so it sits in the books twice
  // until a human links the gift to the credit — and until #696 the rule made
  // the founder's split ($5,000 central + $2,000 chapter, one $7,000 wire)
  // impossible to state at all. This matches unlinked wire gifts to their
  // deposit by day and exact total, and only when exactly one deposit fits.
  // See 0070.
  linkWireGiftsToTheirDeposit,
  // The morning engine wrote a near-duplicate `balance_settlement` transfer
  // pair every day for months, because the settlement is worth $0 to the
  // book (`lib/bookBalance.ts`'s deliberate zero for that origin) and so
  // never closes the gap it measures — a sibling change stops new ones being
  // written, this clears the backlog. Founder ask: "can't you run a
  // migration to delete the rows" — yes, and this is it: same guarded core
  // as the human-run `removeUnexecutedBalanceSettlements` mutation
  // (`lib/removeUnexecutedBalanceSettlements.ts`), invoked here with
  // `execute: true` under deploy-admin privileges instead of waiting on a
  // signed-in ED/FM session. Refuses the WHOLE run rather than partially
  // cleaning up if any candidate anywhere fails any precondition — and,
  // unlike the mutation, THROWS on a refusal instead of returning it, since
  // `runPending` ledgers whatever `run` returns unconditionally; a returned
  // refusal would be recorded as permanently applied and never retried. See
  // 0071.
  removeUnexecutedBalanceSettlementsMigration,
  // A donor who covered the processing fee was booked for the amount they
  // typed, with the extra they actually paid parked outside every giving
  // total — so a $309.27 charge reported as a $300.00 gift, and the donor's
  // own receipt disagreed with the ledger. The gift is the gross; the
  // processor's cut is the org's expense. This folds the coverage back in and
  // moves the donor / scope / identity / launch-pot rollups by the same
  // delta. Raises book value by exactly the coverage that was invisible,
  // which CLOSES the sliver `reconciliation.ts` already worked around on the
  // in-flight side. Flags each row it corrects, because folding twice would
  // overstate every covered gift and nothing in the data itself could tell.
  // See 0072.
  foldFeeCoverageIntoGifts,
  // The same bug on the repayment side, and the mirror image of the fix: a
  // payer who covered the processing fee had only their DEBT booked, while the
  // fee sweep booked the whole cut Stripe took — so the expense went unfunded
  // and the coverage read as unaccounted-for cash ("the payback on the charge
  // was $6.49… the unaccounted for in our banking was 49 cents"). A sibling
  // change posts the row going forward; this books the payment that already
  // happened, from a PINNED list rather than a search, and refuses an entry
  // outright if the rows it finds are not the ones it was told to expect.
  // See 0073.
  bookKnownRepaymentFeeCoverage,
  // 0073 refused on deploy: it looked for one settled repayment of $6.00 and
  // found none, because THE $6.00 WAS NEVER A ROW — it was two $3.00 charges
  // bundled into one checkout, and a fee is quoted once on their total. This
  // pins the SESSION instead, which names the exact payment rather than an
  // amount two rows could share, and verifies the debts still sum to what was
  // recorded before booking anything. See 0074.
  bookRepaymentCoverageBySession,
  // …and 0074's rows landed in Reconcile as "Unlabeled charge / Uncategorized
  // / For: None", which is the shape two other modules already exist to
  // prevent. Names them and files them under the same category as the fees
  // they offset. Moves no money, so unlike its neighbours it can take every
  // row carrying the marker rather than pinning one — and it only ever fills
  // an absence, never overwrites a human's choice. See 0075.
  labelFeeCoverageRows,
  // Every chapter kept its own copy of the same thirteen category names, so
  // "Supplies" was N rows meaning one thing — and a CENTRAL charge could carry
  // no category at all, because central owned none. That put a Public Worship
  // card's New York spend in an "Uncategorized" bar nobody could close: the
  // central FM was refused, and New York's treasurer can't write a row in
  // central's book. Owner: "the category should be the same across all
  // chapters." This collapses same-named categories (trimmed,
  // case-insensitive) into one, repoints EVERY reference to the survivor —
  // transactions, budgets, budget lines, reimbursement lines, event items,
  // engagements, the reattribution undo snapshots, and the nesting link
  // itself — then deletes the duplicates and clears the now-dead
  // `chapterId`/`fundId`. Funds are deliberately untouched: a fund is real,
  // restricted, chapter-owned money; a category is a word. Idempotent by
  // construction (its output is a fixed point), so no flag. See 0076.
  orgWideBudgetCategories,
];
