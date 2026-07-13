/**
 * "Mine" — the signed-in person's own open work, for the Work tab's leading
 * digest and any personal dashboard. `myOpenWork` reuses the reminder digest's
 * collection + partition machinery (`collectOpenWorkForChapter` scoped to one
 * person, `partitionForDigest`) so the in-app view and the weekly email stay
 * in lock-step, then adds the events this person owns or holds a role on.
 *
 * Returns `null` for a caller with no roster row (unlinked / brand-new): the UI
 * renders nothing, so admins and unlinked accounts see today's screen unchanged.
 */
import { query } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { v } from "convex/values";
import {
  EVENT_STATUSES,
  PROJECT_STATUSES,
  isOperationalEvent,
} from "@events-os/shared";
import { getChapterIdOrNull, requireUserId } from "./lib/context";
import { getPersonForUser } from "./lib/templates";
import { collectOpenWorkForChapter, partitionForDigest } from "./reminders";

/** One dated piece of open work — mirrors `reminders.WorkEntry`. */
const workEntryValidator = v.object({
  kind: v.union(v.literal("project"), v.literal("task")),
  name: v.string(),
  context: v.union(v.string(), v.null()),
  dueDate: v.number(),
  projectId: v.optional(v.id("projects")),
  status: v.optional(v.union(...PROJECT_STATUSES.map((s) => v.literal(s)))),
  purpose: v.optional(v.union(v.string(), v.null())),
  blocker: v.optional(v.union(v.string(), v.null())),
  lastComment: v.optional(
    v.union(
      v.object({
        body: v.string(),
        authorName: v.union(v.string(), v.null()),
      }),
      v.null(),
    ),
  ),
});

const myEventValidator = v.object({
  eventId: v.id("events"),
  name: v.string(),
  eventDate: v.number(),
  status: v.union(...EVENT_STATUSES.map((s) => v.literal(s))),
});

export const myOpenWork = query({
  args: {},
  returns: v.union(
    v.null(),
    v.object({
      overdue: v.array(workEntryValidator),
      dueThisWeek: v.array(workEntryValidator),
      myEvents: v.array(myEventValidator),
    }),
  ),
  handler: async (ctx) => {
    const chapterId = await getChapterIdOrNull(ctx);
    if (!chapterId) return null;
    const userId = await requireUserId(ctx);
    const me = await getPersonForUser(
      ctx,
      chapterId as Id<"chapters">,
      userId as Id<"users">,
    );
    if (!me) return null;

    const now = Date.now();
    // The digest's collection, scoped to just this person's own effective work.
    const recipients = await collectOpenWorkForChapter(
      ctx,
      chapterId as Id<"chapters">,
      now,
      me,
    );
    const entries = recipients[0]?.entries ?? [];
    const { overdue, dueThisWeek } = partitionForDigest(entries, now);

    // Events I own (precise index) ∪ events where I hold a role.
    const ownedEvents = await ctx.db
      .query("events")
      .withIndex("by_chapter_and_ownerPersonId", (q) =>
        q.eq("chapterId", chapterId as Id<"chapters">).eq("ownerPersonId", me),
      )
      .take(200);
    const assignments = await ctx.db
      .query("roleAssignments")
      .withIndex("by_person", (q) => q.eq("personId", me))
      .take(200);
    const byId = new Map<Id<"events">, (typeof ownedEvents)[number]>();
    for (const e of ownedEvents) {
      if (isOperationalEvent(e)) byId.set(e._id, e);
    }
    for (const a of assignments) {
      if (byId.has(a.eventId)) continue;
      const e = await ctx.db.get(a.eventId);
      if (e && e.chapterId === chapterId && isOperationalEvent(e)) {
        byId.set(e._id, e);
      }
    }
    const myEvents = Array.from(byId.values())
      .sort((a, b) => b.eventDate - a.eventDate)
      .map((e) => ({
        eventId: e._id,
        name: e.name,
        eventDate: e.eventDate,
        status: e.status,
      }));

    return { overdue, dueThisWeek, myEvents };
  },
});
