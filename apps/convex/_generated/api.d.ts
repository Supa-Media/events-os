/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as ai from "../ai.js";
import type * as aiActions from "../aiActions.js";
import type * as auth from "../auth.js";
import type * as columns from "../columns.js";
import type * as dashboard from "../dashboard.js";
import type * as engagements from "../engagements.js";
import type * as eventTypes from "../eventTypes.js";
import type * as events from "../events.js";
import type * as http from "../http.js";
import type * as items from "../items.js";
import type * as lib_access from "../lib/access.js";
import type * as lib_context from "../lib/context.js";
import type * as lib_people from "../lib/people.js";
import type * as lib_seed_helpers from "../lib/seed/helpers.js";
import type * as lib_seed_roster from "../lib/seed/roster.js";
import type * as lib_seed_templates from "../lib/seed/templates.js";
import type * as lib_superuser from "../lib/superuser.js";
import type * as lib_templates from "../lib/templates.js";
import type * as migrations from "../migrations.js";
import type * as people from "../people.js";
import type * as profiles from "../profiles.js";
import type * as roleAssignments from "../roleAssignments.js";
import type * as roles from "../roles.js";
import type * as schema_ai from "../schema/ai.js";
import type * as schema_chapters from "../schema/chapters.js";
import type * as schema_events from "../schema/events.js";
import type * as schema_people from "../schema/people.js";
import type * as schema_roles from "../schema/roles.js";
import type * as schema_shared from "../schema/shared.js";
import type * as schema_siteMap from "../schema/siteMap.js";
import type * as schema_templates from "../schema/templates.js";
import type * as seed from "../seed.js";
import type * as siteMap from "../siteMap.js";
import type * as storage from "../storage.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  ai: typeof ai;
  aiActions: typeof aiActions;
  auth: typeof auth;
  columns: typeof columns;
  dashboard: typeof dashboard;
  engagements: typeof engagements;
  eventTypes: typeof eventTypes;
  events: typeof events;
  http: typeof http;
  items: typeof items;
  "lib/access": typeof lib_access;
  "lib/context": typeof lib_context;
  "lib/people": typeof lib_people;
  "lib/seed/helpers": typeof lib_seed_helpers;
  "lib/seed/roster": typeof lib_seed_roster;
  "lib/seed/templates": typeof lib_seed_templates;
  "lib/superuser": typeof lib_superuser;
  "lib/templates": typeof lib_templates;
  migrations: typeof migrations;
  people: typeof people;
  profiles: typeof profiles;
  roleAssignments: typeof roleAssignments;
  roles: typeof roles;
  "schema/ai": typeof schema_ai;
  "schema/chapters": typeof schema_chapters;
  "schema/events": typeof schema_events;
  "schema/people": typeof schema_people;
  "schema/roles": typeof schema_roles;
  "schema/shared": typeof schema_shared;
  "schema/siteMap": typeof schema_siteMap;
  "schema/templates": typeof schema_templates;
  seed: typeof seed;
  siteMap: typeof siteMap;
  storage: typeof storage;
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
