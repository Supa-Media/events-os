/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as auth from "../auth.js";
import type * as columns from "../columns.js";
import type * as dashboard from "../dashboard.js";
import type * as eventTypes from "../eventTypes.js";
import type * as events from "../events.js";
import type * as http from "../http.js";
import type * as items from "../items.js";
import type * as lib_context from "../lib/context.js";
import type * as lib_templates from "../lib/templates.js";
import type * as people from "../people.js";
import type * as roleAssignments from "../roleAssignments.js";
import type * as roles from "../roles.js";
import type * as seed from "../seed.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  auth: typeof auth;
  columns: typeof columns;
  dashboard: typeof dashboard;
  eventTypes: typeof eventTypes;
  events: typeof events;
  http: typeof http;
  items: typeof items;
  "lib/context": typeof lib_context;
  "lib/templates": typeof lib_templates;
  people: typeof people;
  roleAssignments: typeof roleAssignments;
  roles: typeof roles;
  seed: typeof seed;
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
