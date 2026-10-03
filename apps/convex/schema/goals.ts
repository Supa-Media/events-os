import { defineTable } from "convex/server";
import { v } from "convex/values";
import {
  GOAL_PLAN_STATUSES,
  GOAL_UNITS,
  KEY_RESULT_MEASURE_KINDS,
  KEY_RESULT_STATUSES,
} from "@events-os/shared";

/**
 * Goals — the org's year plans. See `@events-os/shared`'s goals.ts for the
 * vocabulary and the boundary this feature teaches (a key result is the score
 * and never holds tasks; the work lives in a project, event or duty).
 *
 * Every row here is ORG-WIDE, not chapter-scoped: one plan covers Central and
 * every chapter, and a key result can be owned by a chapter's team. Nothing
 * about a plan's content is fixed — titles, owners, targets, order and the
 * teams themselves are all edited in the app (founder ask, 2026-10-02).
 */
const unitValidator = v.union(...GOAL_UNITS.map((u) => v.literal(u)));

/** One year's plan: its mission and the retrospective that led to it. */
export const goalPlans = defineTable({
  year: v.number(),
  title: v.string(),
  mission: v.optional(v.string()),
  retroWins: v.array(v.string()),
  retroGaps: v.array(v.string()),
  status: v.union(...GOAL_PLAN_STATUSES.map((s) => v.literal(s))),
  createdBy: v.id("users"),
  createdAt: v.number(),
  updatedAt: v.number(),
}).index("by_year", ["year"]);

/** A headline number for the year ("26 events", "$30,000"). A child row
 *  (`parentTargetId`) breaks its parent down ("$12k sponsorships"). Progress
 *  is typed in by hand for now. */
export const goalTargets = defineTable({
  planId: v.id("goalPlans"),
  label: v.string(),
  target: v.number(),
  unit: unitValidator,
  current: v.optional(v.number()),
  parentTargetId: v.optional(v.id("goalTargets")),
  sortOrder: v.number(),
  updatedAt: v.number(),
}).index("by_plan", ["planId"]);

/** One objective. Owned by a team; numbered by `sortOrder`. */
export const goalObjectives = defineTable({
  planId: v.id("goalPlans"),
  title: v.string(),
  ownerTeamId: v.optional(v.id("orgTeams")),
  sortOrder: v.number(),
  updatedAt: v.number(),
}).index("by_plan", ["planId"]);

/**
 * One key result. The accountable owner is a team OR a seat (some results,
 * like "hold monthly chapter meetings", belong to every holder of a seat).
 * `measureKind` decides where progress comes from; for the automatic kinds
 * `current` is ignored and progress is computed at read time from seats or
 * events, so it can never drift from the real record.
 */
export const goalKeyResults = defineTable({
  planId: v.id("goalPlans"),
  objectiveId: v.id("goalObjectives"),
  title: v.string(),
  sortOrder: v.number(),
  ownerTeamId: v.optional(v.id("orgTeams")),
  ownerSeatSlug: v.optional(v.string()),
  contributorTeamIds: v.array(v.id("orgTeams")),
  // Free text as the plan says it ("Q1", "Every event", "Monthly").
  timing: v.optional(v.string()),
  // The hard deadline, when there is one (epoch ms). Drives Deadlines.
  dueDate: v.optional(v.number()),
  status: v.union(...KEY_RESULT_STATUSES.map((s) => v.literal(s))),
  measureKind: v.union(...KEY_RESULT_MEASURE_KINDS.map((k) => v.literal(k))),
  target: v.optional(v.number()),
  current: v.optional(v.number()),
  unit: v.optional(unitValidator),
  // seat_filled: which seat, at which scope. Only holders seated at or after
  // `seatWatchSince` count (unset = the key result's creation), so someone
  // already in the seat doesn't read as a recruit the plan still asks for.
  seatSlug: v.optional(v.string()),
  seatScope: v.optional(v.union(v.id("chapters"), v.literal("central"))),
  seatWatchSince: v.optional(v.number()),
  // event_count: which templates count, optionally in one chapter only.
  eventTypeIds: v.optional(v.array(v.id("eventTypes"))),
  eventChapterId: v.optional(v.id("chapters")),
  lastUpdateAt: v.optional(v.number()),
  updatedAt: v.number(),
})
  .index("by_plan", ["planId"])
  .index("by_objective", ["objectiveId"]);

/** A dated note on a key result: the status it was given and why. The
 *  append-only history behind the key result's current status. */
export const goalUpdates = defineTable({
  planId: v.id("goalPlans"),
  keyResultId: v.id("goalKeyResults"),
  status: v.union(...KEY_RESULT_STATUSES.map((s) => v.literal(s))),
  current: v.optional(v.number()),
  note: v.optional(v.string()),
  authorUserId: v.id("users"),
  authorPersonId: v.optional(v.id("people")),
  createdAt: v.number(),
}).index("by_key_result", ["keyResultId"]);

/**
 * A team: a named group of seats with a lead seat, at Central or in one
 * chapter. Teams carry NO powers — seats still do; a team is only how the
 * plan says who owns what. Named `orgTeams` because `financeTeams` and
 * `guestTeams` already exist and mean other things.
 */
export const orgTeams = defineTable({
  name: v.string(),
  // Absent = Central.
  chapterId: v.optional(v.id("chapters")),
  leadSeatSlug: v.optional(v.string()),
  seatSlugs: v.array(v.string()),
  parentTeamId: v.optional(v.id("orgTeams")),
  description: v.optional(v.string()),
  sortOrder: v.number(),
  isArchived: v.optional(v.boolean()),
  createdAt: v.number(),
  updatedAt: v.number(),
}).index("by_sortOrder", ["sortOrder"]);
