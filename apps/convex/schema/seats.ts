import { defineTable } from "convex/server";
import { v } from "convex/values";
import {
  SEAT_CHARTS,
  SEAT_CAPABILITIES,
  SPECIALIZED_ROLE_TITLES,
} from "@events-os/shared";

/**
 * Org chart (seats) schema for Chapter OS.
 *
 * The org chart is a TREE OF SEATS, shared by every chart it belongs to: the
 * CENTRAL chart is defined once (the org), and the CHAPTER chart is defined
 * once and stamped identically onto every chapter — same shape, same duties,
 * same capabilities everywhere. Only OCCUPANCY (who sits in a seat) varies
 * per chapter; the chart's SHAPE never forks per chapter.
 *
 * `seatDefs` holds the (runtime-editable, later PR) seat definitions,
 * seeded once from `SEAT_DEFS` in `@events-os/shared` (see
 * `migrations/0022_seed_seat_defs.ts`). `seatAssignments` holds WHO sits in a
 * seat, at a given scope (a real chapter, or the `"central"` sentinel this
 * repo always uses instead of null — see `finances.ts`'s `budgets.chapterId`
 * for the same pattern).
 *
 * This PR is schema + seed + READ queries only — no enforcement/permission
 * changes, no assignment mutations (a later PR). Every seat starts vacant.
 */

const seatChartValidator = v.union(...SEAT_CHARTS.map((c) => v.literal(c)));
const seatCapabilityValidator = v.union(
  ...SEAT_CAPABILITIES.map((c) => v.literal(c)),
);
const legacyTitleValidator = v.union(
  ...SPECIALIZED_ROLE_TITLES.map((t) => v.literal(t)),
);

/**
 * One seat in the org chart. Template seats are seeded with a `slug` drawn
 * from `SEAT_IDS` (`@events-os/shared`); runtime-added seats (a later PR's
 * ED-gated editor) get a generated slug — so `slug` is a plain string here,
 * not a literal union.
 *
 * `parentSlug` is `SEAT_ROOT` ("root") for a chart's root seat — this repo
 * never uses null/absent sentinels for "no parent" (see `SEAT_ROOT` in
 * `@events-os/shared/seats.ts`). Always another seat's slug in the SAME
 * chart.
 */
export const seatDefs = defineTable({
  slug: v.string(),
  title: v.string(),
  chart: seatChartValidator,
  parentSlug: v.string(),
  // 1 for a single-holder seat, or MULTI_HOLDER_CAP for a "*" seat.
  maxHolders: v.number(),
  duties: v.array(v.string()),
  capabilities: v.array(seatCapabilityValidator),
  // Append order within the chart — stable display ordering.
  sortOrder: v.number(),
  // True iff holders are COMPUTED (rolled up from another seat, e.g. the
  // central `chapter_directors` seat rolling up every chapter's
  // `chapter_director`) — never directly assigned. Absent/false otherwise.
  derived: v.optional(v.boolean()),
  // Bridge to the legacy `specializedRoles.title` this seat corresponds to
  // (see `SPECIALIZED_ROLE_TITLES` in `@events-os/shared`), where one exists.
  legacyTitle: v.optional(legacyTitleValidator),
  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index("by_slug", ["slug"])
  .index("by_chart", ["chart"]);

/**
 * One person occupying one seat, at one scope. `scope` is a real chapter id
 * for a chapter-chart seat's occupancy, or the `"central"` sentinel for a
 * central-chart seat's occupancy — mirroring `budgets.chapterId` /
 * `specializedRoles.scope`'s union so central is representable without a
 * null. A multi-holder seat (`maxHolders > 1`) has several rows sharing the
 * same (scope, seatDefId) pair.
 */
export const seatAssignments = defineTable({
  seatDefId: v.id("seatDefs"),
  scope: v.union(v.id("chapters"), v.literal("central")),
  personId: v.id("people"),
  grantedBy: v.optional(v.id("users")),
  createdAt: v.number(),
})
  .index("by_scope", ["scope"])
  .index("by_scope_and_seat", ["scope", "seatDefId"])
  .index("by_person", ["personId"]);
