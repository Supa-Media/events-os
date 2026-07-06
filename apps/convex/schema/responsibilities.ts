import { defineTable } from "convex/server";
import { v } from "convex/values";
import { RESPONSIBILITY_CADENCES, CHECKIN_ACTIONS } from "@events-os/shared";

/**
 * Responsibility — ongoing, recurring org work ("Meet with directs", "Create
 * event flyers"), distinct from projects (which finish).
 *
 * One row FANS OUT: assigned to roles (`assigneeRoles`, matched against
 * people.role case-insensitively) so "all Directors" is a single row that
 * shows up as an individual responsibility for every person holding the role,
 * and/or to specific people (`assigneePersonIds`) when no role fits. The
 * how-to column documents how the work is actually done, so a handoff doesn't
 * need a meeting.
 */
export const responsibilities = defineTable({
  chapterId: v.id("chapters"),
  title: v.string(),
  description: v.optional(v.string()),
  // How to actually do this (steps, links, tools) — the handoff documentation.
  howTo: v.optional(v.string()),
  cadence: v.union(...RESPONSIBILITY_CADENCES.map((c) => v.literal(c))),
  // Role titles this fans out to (normalized match against people.role).
  assigneeRoles: v.optional(v.array(v.string())),
  // Direct person assignments, for work no existing role covers.
  assigneePersonIds: v.optional(v.array(v.id("people"))),
  notes: v.optional(v.string()),
  createdBy: v.id("users"),
  createdAt: v.number(),
  updatedAt: v.number(),
}).index("by_chapter", ["chapterId"]);

/**
 * Check-in — one logged 1:1 between a manager and a direct report (or the
 * record that it was skipped). Captures whether each responsibility is being
 * fulfilled and the follow-up decided when it isn't, prayer/personal updates
 * the reporting chain should know, and two 1-10 pulse scores (workload:
 * 1 = far too little, 10 = far too much; interest: is this the right work).
 * Readable by anyone whose subtree contains the report (the chain up).
 */
export const checkIns = defineTable({
  chapterId: v.id("chapters"),
  // The direct report the 1:1 is about.
  personId: v.id("people"),
  // The manager who logged it (their roster row).
  managerPersonId: v.id("people"),
  type: v.union(v.literal("checkin"), v.literal("skip")),
  // Per-responsibility fulfillment at the time of the 1:1. Title is
  // snapshotted so history survives edits/deletes of the responsibility row.
  responsibilities: v.optional(
    v.array(
      v.object({
        responsibilityId: v.optional(v.id("responsibilities")),
        title: v.string(),
        fulfilling: v.boolean(),
        action: v.optional(
          v.union(...CHECKIN_ACTIONS.map((a) => v.literal(a))),
        ),
        note: v.optional(v.string()),
      }),
    ),
  ),
  // Prayer requests / personal updates for the reporting chain.
  personalUpdate: v.optional(v.string()),
  // Workload pulse: 1 = far too little, 10 = far too much (5-6 ≈ right).
  workloadScore: v.optional(v.number()),
  workloadNote: v.optional(v.string()),
  // Right-work pulse: 1 = wrong/boring work, 10 = exactly the right work.
  interestScore: v.optional(v.number()),
  interestNote: v.optional(v.string()),
  notes: v.optional(v.string()),
  createdBy: v.id("users"),
  createdAt: v.number(),
})
  .index("by_person", ["personId"])
  .index("by_chapter", ["chapterId"]);
