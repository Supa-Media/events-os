/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as academy from "../academy.js";
import type * as accessAllowlist from "../accessAllowlist.js";
import type * as ai from "../ai.js";
import type * as aiActions from "../aiActions.js";
import type * as aiCoding from "../aiCoding.js";
import type * as aiCodingData from "../aiCodingData.js";
import type * as auth from "../auth.js";
import type * as blasts from "../blasts.js";
import type * as budget from "../budget.js";
import type * as budgetLines from "../budgetLines.js";
import type * as cards from "../cards.js";
import type * as checkIns from "../checkIns.js";
import type * as columns from "../columns.js";
import type * as crons from "../crons.js";
import type * as dashboard from "../dashboard.js";
import type * as docs from "../docs.js";
import type * as engagements from "../engagements.js";
import type * as eventTypes from "../eventTypes.js";
import type * as events from "../events.js";
import type * as financeRoles from "../financeRoles.js";
import type * as financeSettings from "../financeSettings.js";
import type * as finances from "../finances.js";
import type * as giving from "../giving.js";
import type * as guests from "../guests.js";
import type * as http from "../http.js";
import type * as increase from "../increase.js";
import type * as inventory from "../inventory.js";
import type * as items from "../items.js";
import type * as legacyCards from "../legacyCards.js";
import type * as lib_access from "../lib/access.js";
import type * as lib_context from "../lib/context.js";
import type * as lib_emailCodes from "../lib/emailCodes.js";
import type * as lib_finance from "../lib/finance.js";
import type * as lib_guides from "../lib/guides.js";
import type * as lib_html from "../lib/html.js";
import type * as lib_landingPage from "../lib/landingPage.js";
import type * as lib_landingPageClient from "../lib/landingPageClient.js";
import type * as lib_landingPageStyles from "../lib/landingPageStyles.js";
import type * as lib_landingPageVerifyClient from "../lib/landingPageVerifyClient.js";
import type * as lib_org from "../lib/org.js";
import type * as lib_people from "../lib/people.js";
import type * as lib_placements from "../lib/placements.js";
import type * as lib_platformGuides from "../lib/platformGuides.js";
import type * as lib_projectActionPage from "../lib/projectActionPage.js";
import type * as lib_readiness from "../lib/readiness.js";
import type * as lib_reimburseApiRoutes from "../lib/reimburseApiRoutes.js";
import type * as lib_reimbursePage from "../lib/reimbursePage.js";
import type * as lib_seatStructure from "../lib/seatStructure.js";
import type * as lib_seed_fieldDay from "../lib/seed/fieldDay.js";
import type * as lib_seed_finance from "../lib/seed/finance.js";
import type * as lib_seed_helpers from "../lib/seed/helpers.js";
import type * as lib_seed_roster from "../lib/seed/roster.js";
import type * as lib_seed_templates from "../lib/seed/templates.js";
import type * as lib_sha256 from "../lib/sha256.js";
import type * as lib_siteUrl from "../lib/siteUrl.js";
import type * as lib_superuser from "../lib/superuser.js";
import type * as lib_templates from "../lib/templates.js";
import type * as lib_ticketApiRoutes from "../lib/ticketApiRoutes.js";
import type * as maintenance from "../maintenance.js";
import type * as migrations from "../migrations.js";
import type * as migrations_0000_seed_ledger from "../migrations/0000_seed_ledger.js";
import type * as migrations_0007_cleanup_renamed_guide_slugs from "../migrations/0007_cleanup_renamed_guide_slugs.js";
import type * as migrations_0008_cleanup_orphaned_placements from "../migrations/0008_cleanup_orphaned_placements.js";
import type * as migrations_0009_backfill_people_services from "../migrations/0009_backfill_people_services.js";
import type * as migrations_0010_backfill_template_people_teams from "../migrations/0010_backfill_template_people_teams.js";
import type * as migrations_0011_backfill_person_status from "../migrations/0011_backfill_person_status.js";
import type * as migrations_0012_materialize_how_to_docs from "../migrations/0012_materialize_how_to_docs.js";
import type * as migrations_0013_fold_project_status_notes from "../migrations/0013_fold_project_status_notes.js";
import type * as migrations_0014_copy_guest_allowlist from "../migrations/0014_copy_guest_allowlist.js";
import type * as migrations_0015_audit_column_types from "../migrations/0015_audit_column_types.js";
import type * as migrations_0016_clear_legacy_fields from "../migrations/0016_clear_legacy_fields.js";
import type * as migrations_0017_purge_guest_allowlist from "../migrations/0017_purge_guest_allowlist.js";
import type * as migrations_0018_backfill_course_completions from "../migrations/0018_backfill_course_completions.js";
import type * as migrations_0019_backfill_run_of_show_duration from "../migrations/0019_backfill_run_of_show_duration.js";
import type * as migrations_0020_permits_states_and_fallback from "../migrations/0020_permits_states_and_fallback.js";
import type * as migrations_0021_inventory_category_to_tags from "../migrations/0021_inventory_category_to_tags.js";
import type * as migrations_0022_seed_seat_defs from "../migrations/0022_seed_seat_defs.js";
import type * as migrations_index from "../migrations/index.js";
import type * as modules from "../modules.js";
import type * as moneyViews from "../moneyViews.js";
import type * as org from "../org.js";
import type * as people from "../people.js";
import type * as places from "../places.js";
import type * as profiles from "../profiles.js";
import type * as projectActions from "../projectActions.js";
import type * as projects from "../projects.js";
import type * as reimbursements from "../reimbursements.js";
import type * as reminders from "../reminders.js";
import type * as responsibilities from "../responsibilities.js";
import type * as roleAssignments from "../roleAssignments.js";
import type * as roles from "../roles.js";
import type * as schema_academy from "../schema/academy.js";
import type * as schema_accessAllowlist from "../schema/accessAllowlist.js";
import type * as schema_ai from "../schema/ai.js";
import type * as schema_budget from "../schema/budget.js";
import type * as schema_chapters from "../schema/chapters.js";
import type * as schema_docs from "../schema/docs.js";
import type * as schema_events from "../schema/events.js";
import type * as schema_finances from "../schema/finances.js";
import type * as schema_inventory from "../schema/inventory.js";
import type * as schema_migrations from "../schema/migrations.js";
import type * as schema_modules from "../schema/modules.js";
import type * as schema_people from "../schema/people.js";
import type * as schema_projects from "../schema/projects.js";
import type * as schema_responsibilities from "../schema/responsibilities.js";
import type * as schema_roles from "../schema/roles.js";
import type * as schema_shared from "../schema/shared.js";
import type * as schema_siteMap from "../schema/siteMap.js";
import type * as schema_songs from "../schema/songs.js";
import type * as schema_templates from "../schema/templates.js";
import type * as schema_ticketing from "../schema/ticketing.js";
import type * as seatStructure from "../seatStructure.js";
import type * as seats from "../seats.js";
import type * as seed from "../seed.js";
import type * as seedTicketing from "../seedTicketing.js";
import type * as setlists from "../setlists.js";
import type * as siteMap from "../siteMap.js";
import type * as songs from "../songs.js";
import type * as specializedRoles from "../specializedRoles.js";
import type * as storage from "../storage.js";
import type * as stripe from "../stripe.js";
import type * as stripeFinance from "../stripeFinance.js";
import type * as templatePeople from "../templatePeople.js";
import type * as templateSync from "../templateSync.js";
import type * as templates from "../templates.js";
import type * as ticketing from "../ticketing.js";
import type * as ticketingEmails from "../ticketingEmails.js";
import type * as ticketingVerification from "../ticketingVerification.js";
import type * as transfers from "../transfers.js";
import type * as webhooks from "../webhooks.js";
import type * as work from "../work.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  academy: typeof academy;
  accessAllowlist: typeof accessAllowlist;
  ai: typeof ai;
  aiActions: typeof aiActions;
  aiCoding: typeof aiCoding;
  aiCodingData: typeof aiCodingData;
  auth: typeof auth;
  blasts: typeof blasts;
  budget: typeof budget;
  budgetLines: typeof budgetLines;
  cards: typeof cards;
  checkIns: typeof checkIns;
  columns: typeof columns;
  crons: typeof crons;
  dashboard: typeof dashboard;
  docs: typeof docs;
  engagements: typeof engagements;
  eventTypes: typeof eventTypes;
  events: typeof events;
  financeRoles: typeof financeRoles;
  financeSettings: typeof financeSettings;
  finances: typeof finances;
  giving: typeof giving;
  guests: typeof guests;
  http: typeof http;
  increase: typeof increase;
  inventory: typeof inventory;
  items: typeof items;
  legacyCards: typeof legacyCards;
  "lib/access": typeof lib_access;
  "lib/context": typeof lib_context;
  "lib/emailCodes": typeof lib_emailCodes;
  "lib/finance": typeof lib_finance;
  "lib/guides": typeof lib_guides;
  "lib/html": typeof lib_html;
  "lib/landingPage": typeof lib_landingPage;
  "lib/landingPageClient": typeof lib_landingPageClient;
  "lib/landingPageStyles": typeof lib_landingPageStyles;
  "lib/landingPageVerifyClient": typeof lib_landingPageVerifyClient;
  "lib/org": typeof lib_org;
  "lib/people": typeof lib_people;
  "lib/placements": typeof lib_placements;
  "lib/platformGuides": typeof lib_platformGuides;
  "lib/projectActionPage": typeof lib_projectActionPage;
  "lib/readiness": typeof lib_readiness;
  "lib/reimburseApiRoutes": typeof lib_reimburseApiRoutes;
  "lib/reimbursePage": typeof lib_reimbursePage;
  "lib/seatStructure": typeof lib_seatStructure;
  "lib/seed/fieldDay": typeof lib_seed_fieldDay;
  "lib/seed/finance": typeof lib_seed_finance;
  "lib/seed/helpers": typeof lib_seed_helpers;
  "lib/seed/roster": typeof lib_seed_roster;
  "lib/seed/templates": typeof lib_seed_templates;
  "lib/sha256": typeof lib_sha256;
  "lib/siteUrl": typeof lib_siteUrl;
  "lib/superuser": typeof lib_superuser;
  "lib/templates": typeof lib_templates;
  "lib/ticketApiRoutes": typeof lib_ticketApiRoutes;
  maintenance: typeof maintenance;
  migrations: typeof migrations;
  "migrations/0000_seed_ledger": typeof migrations_0000_seed_ledger;
  "migrations/0007_cleanup_renamed_guide_slugs": typeof migrations_0007_cleanup_renamed_guide_slugs;
  "migrations/0008_cleanup_orphaned_placements": typeof migrations_0008_cleanup_orphaned_placements;
  "migrations/0009_backfill_people_services": typeof migrations_0009_backfill_people_services;
  "migrations/0010_backfill_template_people_teams": typeof migrations_0010_backfill_template_people_teams;
  "migrations/0011_backfill_person_status": typeof migrations_0011_backfill_person_status;
  "migrations/0012_materialize_how_to_docs": typeof migrations_0012_materialize_how_to_docs;
  "migrations/0013_fold_project_status_notes": typeof migrations_0013_fold_project_status_notes;
  "migrations/0014_copy_guest_allowlist": typeof migrations_0014_copy_guest_allowlist;
  "migrations/0015_audit_column_types": typeof migrations_0015_audit_column_types;
  "migrations/0016_clear_legacy_fields": typeof migrations_0016_clear_legacy_fields;
  "migrations/0017_purge_guest_allowlist": typeof migrations_0017_purge_guest_allowlist;
  "migrations/0018_backfill_course_completions": typeof migrations_0018_backfill_course_completions;
  "migrations/0019_backfill_run_of_show_duration": typeof migrations_0019_backfill_run_of_show_duration;
  "migrations/0020_permits_states_and_fallback": typeof migrations_0020_permits_states_and_fallback;
  "migrations/0021_inventory_category_to_tags": typeof migrations_0021_inventory_category_to_tags;
  "migrations/0022_seed_seat_defs": typeof migrations_0022_seed_seat_defs;
  "migrations/index": typeof migrations_index;
  modules: typeof modules;
  moneyViews: typeof moneyViews;
  org: typeof org;
  people: typeof people;
  places: typeof places;
  profiles: typeof profiles;
  projectActions: typeof projectActions;
  projects: typeof projects;
  reimbursements: typeof reimbursements;
  reminders: typeof reminders;
  responsibilities: typeof responsibilities;
  roleAssignments: typeof roleAssignments;
  roles: typeof roles;
  "schema/academy": typeof schema_academy;
  "schema/accessAllowlist": typeof schema_accessAllowlist;
  "schema/ai": typeof schema_ai;
  "schema/budget": typeof schema_budget;
  "schema/chapters": typeof schema_chapters;
  "schema/docs": typeof schema_docs;
  "schema/events": typeof schema_events;
  "schema/finances": typeof schema_finances;
  "schema/inventory": typeof schema_inventory;
  "schema/migrations": typeof schema_migrations;
  "schema/modules": typeof schema_modules;
  "schema/people": typeof schema_people;
  "schema/projects": typeof schema_projects;
  "schema/responsibilities": typeof schema_responsibilities;
  "schema/roles": typeof schema_roles;
  "schema/shared": typeof schema_shared;
  "schema/siteMap": typeof schema_siteMap;
  "schema/songs": typeof schema_songs;
  "schema/templates": typeof schema_templates;
  "schema/ticketing": typeof schema_ticketing;
  seatStructure: typeof seatStructure;
  seats: typeof seats;
  seed: typeof seed;
  seedTicketing: typeof seedTicketing;
  setlists: typeof setlists;
  siteMap: typeof siteMap;
  songs: typeof songs;
  specializedRoles: typeof specializedRoles;
  storage: typeof storage;
  stripe: typeof stripe;
  stripeFinance: typeof stripeFinance;
  templatePeople: typeof templatePeople;
  templateSync: typeof templateSync;
  templates: typeof templates;
  ticketing: typeof ticketing;
  ticketingEmails: typeof ticketingEmails;
  ticketingVerification: typeof ticketingVerification;
  transfers: typeof transfers;
  webhooks: typeof webhooks;
  work: typeof work;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
