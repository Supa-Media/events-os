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
import type * as auth from "../auth.js";
import type * as blasts from "../blasts.js";
import type * as budget from "../budget.js";
import type * as checkIns from "../checkIns.js";
import type * as columns from "../columns.js";
import type * as crons from "../crons.js";
import type * as dashboard from "../dashboard.js";
import type * as docs from "../docs.js";
import type * as engagements from "../engagements.js";
import type * as eventTypes from "../eventTypes.js";
import type * as events from "../events.js";
import type * as giving from "../giving.js";
import type * as guests from "../guests.js";
import type * as http from "../http.js";
import type * as inventory from "../inventory.js";
import type * as items from "../items.js";
import type * as lib_access from "../lib/access.js";
import type * as lib_context from "../lib/context.js";
import type * as lib_emailCodes from "../lib/emailCodes.js";
import type * as lib_html from "../lib/html.js";
import type * as lib_landingPage from "../lib/landingPage.js";
import type * as lib_landingPageClient from "../lib/landingPageClient.js";
import type * as lib_landingPageStyles from "../lib/landingPageStyles.js";
import type * as lib_landingPageVerifyClient from "../lib/landingPageVerifyClient.js";
import type * as lib_people from "../lib/people.js";
import type * as lib_projectActionPage from "../lib/projectActionPage.js";
import type * as lib_readiness from "../lib/readiness.js";
import type * as lib_seed_fieldDay from "../lib/seed/fieldDay.js";
import type * as lib_seed_helpers from "../lib/seed/helpers.js";
import type * as lib_seed_roster from "../lib/seed/roster.js";
import type * as lib_seed_templates from "../lib/seed/templates.js";
import type * as lib_sha256 from "../lib/sha256.js";
import type * as lib_superuser from "../lib/superuser.js";
import type * as lib_templates from "../lib/templates.js";
import type * as lib_ticketApiRoutes from "../lib/ticketApiRoutes.js";
import type * as migrations from "../migrations.js";
import type * as modules from "../modules.js";
import type * as org from "../org.js";
import type * as people from "../people.js";
import type * as places from "../places.js";
import type * as profiles from "../profiles.js";
import type * as projectActions from "../projectActions.js";
import type * as projects from "../projects.js";
import type * as reminders from "../reminders.js";
import type * as responsibilities from "../responsibilities.js";
import type * as roleAssignments from "../roleAssignments.js";
import type * as roles from "../roles.js";
import type * as schema_academy from "../schema/academy.js";
import type * as schema_ai from "../schema/ai.js";
import type * as schema_chapters from "../schema/chapters.js";
import type * as schema_docs from "../schema/docs.js";
import type * as schema_events from "../schema/events.js";
import type * as schema_guests from "../schema/guests.js";
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
import type * as seed from "../seed.js";
import type * as seedTicketing from "../seedTicketing.js";
import type * as setlists from "../setlists.js";
import type * as siteMap from "../siteMap.js";
import type * as songs from "../songs.js";
import type * as storage from "../storage.js";
import type * as stripe from "../stripe.js";
import type * as templatePeople from "../templatePeople.js";
import type * as templateSync from "../templateSync.js";
import type * as templates from "../templates.js";
import type * as ticketing from "../ticketing.js";
import type * as ticketingEmails from "../ticketingEmails.js";
import type * as ticketingVerification from "../ticketingVerification.js";
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
  auth: typeof auth;
  blasts: typeof blasts;
  budget: typeof budget;
  checkIns: typeof checkIns;
  columns: typeof columns;
  crons: typeof crons;
  dashboard: typeof dashboard;
  docs: typeof docs;
  engagements: typeof engagements;
  eventTypes: typeof eventTypes;
  events: typeof events;
  giving: typeof giving;
  guests: typeof guests;
  http: typeof http;
  inventory: typeof inventory;
  items: typeof items;
  "lib/access": typeof lib_access;
  "lib/context": typeof lib_context;
  "lib/emailCodes": typeof lib_emailCodes;
  "lib/html": typeof lib_html;
  "lib/landingPage": typeof lib_landingPage;
  "lib/landingPageClient": typeof lib_landingPageClient;
  "lib/landingPageStyles": typeof lib_landingPageStyles;
  "lib/landingPageVerifyClient": typeof lib_landingPageVerifyClient;
  "lib/people": typeof lib_people;
  "lib/projectActionPage": typeof lib_projectActionPage;
  "lib/readiness": typeof lib_readiness;
  "lib/seed/fieldDay": typeof lib_seed_fieldDay;
  "lib/seed/helpers": typeof lib_seed_helpers;
  "lib/seed/roster": typeof lib_seed_roster;
  "lib/seed/templates": typeof lib_seed_templates;
  "lib/sha256": typeof lib_sha256;
  "lib/superuser": typeof lib_superuser;
  "lib/templates": typeof lib_templates;
  "lib/ticketApiRoutes": typeof lib_ticketApiRoutes;
  migrations: typeof migrations;
  modules: typeof modules;
  org: typeof org;
  people: typeof people;
  places: typeof places;
  profiles: typeof profiles;
  projectActions: typeof projectActions;
  projects: typeof projects;
  reminders: typeof reminders;
  responsibilities: typeof responsibilities;
  roleAssignments: typeof roleAssignments;
  roles: typeof roles;
  "schema/academy": typeof schema_academy;
  "schema/ai": typeof schema_ai;
  "schema/chapters": typeof schema_chapters;
  "schema/docs": typeof schema_docs;
  "schema/events": typeof schema_events;
  "schema/guests": typeof schema_guests;
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
  seed: typeof seed;
  seedTicketing: typeof seedTicketing;
  setlists: typeof setlists;
  siteMap: typeof siteMap;
  songs: typeof songs;
  storage: typeof storage;
  stripe: typeof stripe;
  templatePeople: typeof templatePeople;
  templateSync: typeof templateSync;
  templates: typeof templates;
  ticketing: typeof ticketing;
  ticketingEmails: typeof ticketingEmails;
  ticketingVerification: typeof ticketingVerification;
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
