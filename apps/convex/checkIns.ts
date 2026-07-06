/**
 * 1:1 check-ins — a manager's log of each direct-report 1:1 (or its skip).
 *
 * Writing is manager-only: you can log a check-in about anyone in your
 * manager subtree (admins about anyone) except yourself. Reading follows the
 * same reach as `org.workload`, so the whole reporting chain above a person
 * can see their history — that's the point of logging prayer requests and
 * pulse scores here rather than in a private doc.
 */
import { query, mutation } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { v, ConvexError } from "convex/values";
import { CHECKIN_ACTIONS } from "@events-os/shared";
import { requireUserId, getChapterIdOrNull, requireOwned } from "./lib/context";
import {
  manageablePersonIds,
  chapterRoster,
  buildChildrenOf,
  subtreeIds,
  viewerFromRoster,
} from "./lib/org";

const checkInAction = v.union(...CHECKIN_ACTIONS.map((a) => v.literal(a)));

/** Log a 1:1 (or that it was skipped) about a direct report. */
export const log = mutation({
  args: {
    personId: v.id("people"),
    type: v.union(v.literal("checkin"), v.literal("skip")),
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
    const roster = await chapterRoster(ctx, person.chapterId);
    const viewer = await viewerFromRoster(ctx, roster);
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
    const manageable = await manageablePersonIds(
      ctx,
      person.chapterId,
      roster,
    );
    if (manageable !== null && !manageable.has(args.personId)) {
      throw new ConvexError({
        code: "FORBIDDEN",
        message: "You can only log check-ins for people on your team.",
      });
    }
    for (const score of [args.workloadScore, args.interestScore]) {
      if (score !== undefined && (score < 1 || score > 10)) {
        throw new ConvexError({
          code: "BAD_REQUEST",
          message: "Scores are on a 1-10 scale.",
        });
      }
    }
    return await ctx.db.insert("checkIns", {
      chapterId: person.chapterId,
      personId: args.personId,
      managerPersonId: viewer._id,
      type: args.type,
      responsibilities: args.responsibilities,
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

/**
 * Recent check-ins for every member of `personId`'s subtree (newest first,
 * bounded per member), for the workload page's 1:1 history. Access mirrors
 * `org.workload`: admins anywhere, others only within their own subtree.
 * Returns null when out of scope.
 */
export const listForSubtree = query({
  args: { personId: v.id("people") },
  handler: async (ctx, { personId }) => {
    const chapterId = await getChapterIdOrNull(ctx);
    if (!chapterId) return null;
    const person = await ctx.db.get(personId);
    if (!person || person.chapterId !== chapterId) return null;

    const roster = await chapterRoster(ctx, person.chapterId);
    const childrenOf = buildChildrenOf(roster);
    const manageable = await manageablePersonIds(
      ctx,
      person.chapterId,
      roster,
    );
    if (manageable !== null && !manageable.has(personId)) return null;

    const nameById = new Map(roster.map((p) => [p._id, p.name]));
    const members = subtreeIds(childrenOf, person);
    const results: Array<
      Doc<"checkIns"> & { managerName: string | null }
    > = [];
    for (const memberId of members) {
      const recent = await ctx.db
        .query("checkIns")
        .withIndex("by_person", (q) => q.eq("personId", memberId))
        .order("desc")
        .take(10);
      for (const c of recent) {
        results.push({
          ...c,
          managerName: nameById.get(c.managerPersonId) ?? null,
        });
      }
    }
    results.sort((a, b) => b.createdAt - a.createdAt);
    return results;
  },
});
