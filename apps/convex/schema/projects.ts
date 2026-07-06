import { defineTable } from "convex/server";
import { v } from "convex/values";
import { PROJECT_STATUSES } from "@events-os/shared";

/**
 * Project — a unit of work the team is driving, beyond (or wrapping) events.
 *
 * Projects exist so a manager can track the state of everything their team is
 * working on — status, deadline, blocker, next steps — without meeting the
 * owner. They nest: a big effort ("Music recording") can contain sub-projects
 * ("Pitch to artists") via `parentProjectId`, and an event-shaped project can
 * point at its `events` row so the full event data is one tap away.
 *
 * Ownership is a roster person (`ownerPersonId`), not a user — matching how
 * events assign owners — so work can be tracked for people who never log in.
 */
export const projects = defineTable({
  chapterId: v.id("chapters"),
  name: v.string(),
  // Why this project exists / what outcome is expected (the brief's "purpose").
  purpose: v.optional(v.string()),
  status: v.union(...PROJECT_STATUSES.map((s) => v.literal(s))),
  // The person accountable for this project (rolls up to their manager chain).
  ownerPersonId: v.optional(v.id("people")),
  // Parent project when this is a sub-project. Kept acyclic by `projects.update`.
  parentProjectId: v.optional(v.id("projects")),
  // Set when this project IS an event — links through to the event's full data.
  eventId: v.optional(v.id("events")),
  startDate: v.optional(v.number()),
  deadline: v.optional(v.number()),
  budgetUsd: v.optional(v.number()),
  // The manager-facing "state of the world" mini note (updated as things move).
  statusNote: v.optional(v.string()),
  // What's currently in the way, if anything.
  blocker: v.optional(v.string()),
  // What's coming next.
  nextSteps: v.optional(v.string()),
  createdBy: v.id("users"),
  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index("by_chapter", ["chapterId"])
  .index("by_owner", ["ownerPersonId"])
  .index("by_parent", ["parentProjectId"])
  .index("by_event", ["eventId"]);
