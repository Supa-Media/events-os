/**
 * 1:1 check-ins — a manager's log of each direct-report 1:1 (or its skip).
 *
 * Writing is manager-only: you can log a check-in about anyone in your
 * manager subtree (admins about anyone) except yourself. Reading is the chain
 * ABOVE a person — your manager, their manager, and admins — and explicitly
 * NOT the person themselves: candid follow-up plans and pulse notes are a
 * managerial record, so a report's own "my work" view never includes them.
 * The author (or an admin) can delete a mis-logged entry — prayer requests
 * attached to the wrong person shouldn't be permanent.
 */
import { query, mutation } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { v, ConvexError } from "convex/values";
import { CHECKIN_TYPES, CHECKIN_ACTIONS } from "@events-os/shared";
import {
  requireUserId,
  getChapterIdOrNull,
  requireOwned,
  requireInChapter,
} from "./lib/context";
import {
  isChapterAdmin,
  manageablePersonIds,
  chapterRoster,
  buildChildrenOf,
  subtreeIds,
  viewerPerson,
  viewerFromRoster,
  readableCheckInSubject,
} from "./lib/org";

const checkInType = v.union(...CHECKIN_TYPES.map((t) => v.literal(t)));
const checkInAction = v.union(...CHECKIN_ACTIONS.map((a) => v.literal(a)));

/** Log a 1:1 (or that it was skipped) about a direct report. */
export const log = mutation({
  args: {
    personId: v.id("people"),
    type: checkInType,
    responsibilities: v.optional(
      v.array(
        v.object({
          responsibilityId: v.optional(v.id("responsibilities")),
          title: v.string(),
          fulfilling: v.boolean(),
          action: v.optional(checkInAction),
          note: v.optional(v.string()),
        }),
      ),
    ),
    projects: v.optional(
      v.array(
        v.object({
          projectId: v.optional(v.id("projects")),
          name: v.string(),
          onTrack: v.boolean(),
          note: v.optional(v.string()),
        }),
      ),
    ),
    feedbackWell: v.optional(v.string()),
    feedbackImprove: v.optional(v.string()),
    feedbackAboveBeyond: v.optional(v.string()),
    personalUpdate: v.optional(v.string()),
    workloadScore: v.optional(v.number()),
    workloadNote: v.optional(v.string()),
    interestScore: v.optional(v.number()),
    interestNote: v.optional(v.string()),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const person = await requireOwned(ctx, "people", args.personId, "Person");
    const userId = await requireUserId(ctx);
    const viewer = await viewerPerson(ctx, person.chapterId);
    if (!viewer) {
      throw new ConvexError({
        code: "FORBIDDEN",
        message: "You need a roster profile to log check-ins.",
      });
    }
    if (viewer._id === args.personId) {
      throw new ConvexError({
        code: "FORBIDDEN",
        message: "Check-ins are logged by the manager, not on yourself.",
      });
    }
    const manageable = await manageablePersonIds(ctx, person.chapterId);
    if (manageable !== null && !manageable.has(args.personId)) {
      throw new ConvexError({
        code: "FORBIDDEN",
        message: "You can only log check-ins for people on your team.",
      });
    }
    for (const entry of args.responsibilities ?? []) {
      if (!entry.responsibilityId) continue;
      const doc = await ctx.db.get(entry.responsibilityId);
      // A SEAT-MAPPED duty is an ORG-WIDE expectation (owner decision — see
      // `responsibilities.ts`'s `orgWideCatalog`): it can show up on a
      // report's workload even though its `chapterId` is some OTHER
      // chapter's (whichever chapter happened to author it), so a 1:1
      // referencing it must not be rejected as "not in your chapter." A
      // PERSON/ROLE-scoped duty (no seats) keeps the strict same-chapter
      // check — those never travel.
      if ((doc?.assigneeSeatIds?.length ?? 0) > 0) {
        if (!doc) {
          throw new ConvexError({
            code: "NOT_FOUND",
            message: "Responsibility not found.",
          });
        }
      } else {
        await requireInChapter(ctx, person.chapterId, doc, "Responsibility");
      }
    }
    for (const entry of args.projects ?? []) {
      if (!entry.projectId) continue;
      const doc = await ctx.db.get(entry.projectId);
      await requireInChapter(ctx, person.chapterId, doc, "Project");
    }
    for (const score of [args.workloadScore, args.interestScore]) {
      if (score === undefined) continue;
      if (!Number.isInteger(score) || score < 1 || score > 10) {
        throw new ConvexError({
          code: "INVALID_SCORE",
          message: "Scores are whole numbers on a 1-10 scale.",
        });
      }
    }
    return await ctx.db.insert("checkIns", {
      chapterId: person.chapterId,
      personId: args.personId,
      managerPersonId: viewer._id,
      type: args.type,
      responsibilities: args.responsibilities,
      projects: args.projects,
      feedbackWell: args.feedbackWell,
      feedbackImprove: args.feedbackImprove,
      feedbackAboveBeyond: args.feedbackAboveBeyond,
      personalUpdate: args.personalUpdate,
      workloadScore: args.workloadScore,
      workloadNote: args.workloadNote,
      interestScore: args.interestScore,
      interestNote: args.interestNote,
      notes: args.notes,
      createdBy: userId as Id<"users">,
      createdAt: Date.now(),
    });
  },
});

/** Delete a mis-logged check-in — its author, or a chapter admin. */
export const remove = mutation({
  args: { checkInId: v.id("checkIns") },
  handler: async (ctx, { checkInId }) => {
    const checkIn = await requireOwned(ctx, "checkIns", checkInId, "Check-in");
    if (!(await isChapterAdmin(ctx, checkIn.chapterId))) {
      const viewer = await viewerPerson(ctx, checkIn.chapterId);
      if (!viewer || viewer._id !== checkIn.managerPersonId) {
        throw new ConvexError({
          code: "FORBIDDEN",
          message: "Only the manager who logged this (or an admin) can delete it.",
        });
      }
    }
    await ctx.db.delete(checkInId);
    return checkInId;
  },
});

/**
 * ONE person's complete 1:1 history, newest first — the "sense of progress"
 * view. Same read policy as `listForSubtree`: admins anywhere, otherwise the
 * person must be in the caller's subtree and must not BE the caller (the log
 * is the managerial record about them). Returns null when out of scope.
 * Bounded at 500 entries — ~20 years of bi-weekly 1:1s before truncation.
 */
export const historyForPerson = query({
  args: { personId: v.id("people") },
  handler: async (ctx, { personId }) => {
    const subject = await readableCheckInSubject(ctx, personId);
    if (!subject) return null;
    const { roster, viewer } = subject;

    const nameById = new Map(roster.map((p) => [p._id, p.name]));
    const rows = await ctx.db
      .query("checkIns")
      .withIndex("by_person", (q) => q.eq("personId", personId))
      .order("desc")
      .take(500);
    return {
      entries: rows.map((c) => ({
        ...c,
        managerName: nameById.get(c.managerPersonId) ?? null,
      })),
      callerPersonId: viewer?._id ?? null,
    };
  },
});

/**
 * Per-responsibility last-reviewed timestamps for ONE person — the input to
 * the 1:1 form's cadence gate (a quarterly duty reviewed recently shouldn't
 * clutter a weekly check-in). Reads the person's OWN full history (bounded at
 * 500, like historyForPerson) rather than the 10-capped subtree feed, so a
 * slow-cadence duty's last review isn't lost past the feed's window and
 * wrongly re-surfaced every time. Same read policy as historyForPerson;
 * returns null when out of scope. Only actual check-ins (not skips) count as
 * a review; the newest wins.
 */
export const reviewTimesForPerson = query({
  args: { personId: v.id("people") },
  handler: async (ctx, { personId }) => {
    const subject = await readableCheckInSubject(ctx, personId);
    if (!subject) return null;
    const rows = await ctx.db
      .query("checkIns")
      .withIndex("by_person", (q) => q.eq("personId", personId))
      .order("desc")
      .take(500);
    const lastReviewed: Record<Id<"responsibilities">, number> = {};
    for (const c of rows) {
      if (c.type !== "checkin") continue;
      for (const r of c.responsibilities ?? []) {
        if (!r.responsibilityId) continue;
        const prev = lastReviewed[r.responsibilityId] ?? 0;
        if (c.createdAt > prev) lastReviewed[r.responsibilityId] = c.createdAt;
      }
    }
    return lastReviewed;
  },
});

/**
 * Recent check-ins for the members of `personId`'s subtree the CALLER may
 * read (newest first, bounded per member — history beyond that is out of UI
 * reach for now). Access mirrors `org.workload` with one tightening: for
 * non-admins the caller's OWN entries are excluded — the 1:1 log is the
 * managerial record about a person, not readable by its subject. Returns
 * null when the whole page is out of scope. Also returns the caller's person
 * id so the client can gate author-only affordances (delete).
 */
export const listForSubtree = query({
  args: { personId: v.id("people") },
  handler: async (ctx, { personId }) => {
    // Deliberately NOT readableCheckInSubject: unlike historyForPerson, a
    // non-admin may target their own page here (their subtree root) — the
    // self-record exclusion is applied PER MEMBER below instead.
    const chapterId = await getChapterIdOrNull(ctx);
    if (!chapterId) return null;
    const person = await ctx.db.get(personId);
    if (!person || person.chapterId !== chapterId) return null;

    const roster = await chapterRoster(ctx, person.chapterId);
    const childrenOf = buildChildrenOf(roster);
    const viewer = await viewerFromRoster(ctx, roster);
    const manageable = await manageablePersonIds(
      ctx,
      person.chapterId,
      roster,
    );
    if (manageable !== null && !manageable.has(personId)) return null;

    const nameById = new Map(roster.map((p) => [p._id, p.name]));
    const members = [...subtreeIds(childrenOf, person)].filter(
      // Non-admins never read the record about themselves.
      (id) => manageable === null || id !== viewer?._id,
    );
    const perMember = await Promise.all(
      members.map((memberId) =>
        ctx.db
          .query("checkIns")
          .withIndex("by_person", (q) => q.eq("personId", memberId))
          .order("desc")
          .take(10),
      ),
    );
    const entries = perMember.flat().map((c) => ({
      ...c,
      managerName: nameById.get(c.managerPersonId) ?? null,
    }));
    entries.sort((a, b) => b.createdAt - a.createdAt);
    return { entries, callerPersonId: viewer?._id ?? null };
  },
});
