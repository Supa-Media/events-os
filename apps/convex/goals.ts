/**
 * Goals — reading the org's year plans. Writes live in `goalsEdit.ts` (plan
 * content), `goalTeams.ts` (teams), `goalsImport.ts` (the One Pager seed) and
 * `projectGoals.ts` (linking a project to the key result it moves).
 *
 * Plans are org-wide: everyone reads the same plan whichever chapter they're
 * in. Every gate goes through `lib/goalsAccess.ts` / `lib/teamsAccess.ts`.
 */
import { query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { keyResultCode } from "@events-os/shared";
import {
  hasGoalsEdit,
  hasGoalsUpdate,
  hasGoalsView,
  requireGoalsView,
} from "./lib/goalsAccess";
import { hasTeamsEdit } from "./lib/teamsAccess";
import { keyResultProgress } from "./lib/goalsProgress";
import { listActiveChapters } from "./lib/chapters";
import { getChapterIdOrNull } from "./lib/context";

/** Seat slug → title, for labelling owners. */
async function seatTitles(ctx: QueryCtx): Promise<Map<string, string>> {
  const defs = await ctx.db.query("seatDefs").take(500);
  return new Map(defs.map((d) => [d.slug, d.title]));
}

async function teamsById(ctx: QueryCtx): Promise<Map<Id<"orgTeams">, Doc<"orgTeams">>> {
  const teams = await ctx.db.query("orgTeams").withIndex("by_sortOrder").take(300);
  return new Map(teams.map((t) => [t._id, t]));
}

/** Everything the Goals screen needs before it picks a plan: who may do what,
 *  and which years have plans. `null` for a caller without access. */
export const overview = query({
  args: {},
  handler: async (ctx) => {
    if (!(await hasGoalsView(ctx))) return null;
    const plans = await ctx.db.query("goalPlans").withIndex("by_year").take(50);
    return {
      canEdit: await hasGoalsEdit(ctx),
      canEditTeams: await hasTeamsEdit(ctx),
      canUpdate: await hasGoalsUpdate(ctx),
      plans: plans.map((p) => ({ _id: p._id, year: p.year, title: p.title, status: p.status })),
    };
  },
});

/** One plan in full: mission, retro, targets, objectives and their key
 *  results with live progress. */
export const plan = query({
  args: { planId: v.id("goalPlans") },
  handler: async (ctx, { planId }) => {
    await requireGoalsView(ctx);
    const plan = await ctx.db.get(planId);
    if (!plan) return null;

    const [targets, objectives, keyResults, seats, teams] = await Promise.all([
      ctx.db.query("goalTargets").withIndex("by_plan", (q) => q.eq("planId", planId)).take(100),
      ctx.db.query("goalObjectives").withIndex("by_plan", (q) => q.eq("planId", planId)).take(50),
      ctx.db.query("goalKeyResults").withIndex("by_plan", (q) => q.eq("planId", planId)).take(500),
      seatTitles(ctx),
      teamsById(ctx),
    ]);
    const teamName = (id: Id<"orgTeams"> | undefined) => (id ? (teams.get(id)?.name ?? null) : null);

    const bySort = <T extends { sortOrder: number }>(a: T, b: T) => a.sortOrder - b.sortOrder;
    const topTargets = targets.filter((t) => !t.parentTargetId).sort(bySort);

    const sortedObjectives = objectives.sort(bySort);
    const outObjectives = [];
    for (const [oi, o] of sortedObjectives.entries()) {
      const krs = keyResults.filter((k) => k.objectiveId === o._id).sort(bySort);
      const outKrs = [];
      for (const [ki, k] of krs.entries()) {
        const linked = await ctx.db
          .query("projects")
          .withIndex("by_keyResultId", (q) => q.eq("keyResultId", k._id))
          .take(50);
        outKrs.push({
          ...k,
          // Legacy seat_filled rows read as manual until migration 0088 runs.
          measureKind: k.measureKind === "seat_filled" ? ("manual" as const) : k.measureKind,
          code: keyResultCode(oi, ki),
          ownerLabel:
            teamName(k.ownerTeamId) ??
            (k.ownerSeatSlug ? (seats.get(k.ownerSeatSlug) ?? k.ownerSeatSlug) : null),
          contributorNames: k.contributorTeamIds
            .map((id) => teams.get(id)?.name)
            .filter((n): n is string => !!n),
          progress: await keyResultProgress(ctx, k, plan.year),
          linkedProjectCount: linked.length,
        });
      }
      outObjectives.push({
        ...o,
        number: oi + 1,
        ownerTeamName: teamName(o.ownerTeamId),
        keyResults: outKrs,
      });
    }

    return {
      plan,
      targets: topTargets.map((t) => ({
        ...t,
        children: targets.filter((c) => c.parentTargetId === t._id).sort(bySort),
      })),
      objectives: outObjectives,
    };
  },
});

/** One key result's history and the work linked to it. Linked projects are
 *  listed for the caller's own chapter; others are only counted, since
 *  project visibility is chapter-scoped. */
export const keyResult = query({
  args: { keyResultId: v.id("goalKeyResults") },
  handler: async (ctx, { keyResultId }) => {
    await requireGoalsView(ctx);
    const kr = await ctx.db.get(keyResultId);
    if (!kr) return null;
    const updates = await ctx.db
      .query("goalUpdates")
      .withIndex("by_key_result", (q) => q.eq("keyResultId", keyResultId))
      .order("desc")
      .take(50);
    const outUpdates = [];
    for (const u of updates) {
      const person = u.authorPersonId ? await ctx.db.get(u.authorPersonId) : null;
      outUpdates.push({ ...u, authorName: person?.name ?? null });
    }
    const ownChapterId = (await getChapterIdOrNull(ctx)) as Id<"chapters"> | null;
    const linked = await ctx.db
      .query("projects")
      .withIndex("by_keyResultId", (q) => q.eq("keyResultId", keyResultId))
      .take(100);
    const mine = linked.filter((p) => p.chapterId === ownChapterId);
    return {
      updates: outUpdates,
      projects: mine.map((p) => ({ _id: p._id, name: p.name, status: p.status })),
      otherChapterProjectCount: linked.length - mine.length,
    };
  },
});

/** The choices the editors offer: teams, seats, chapters and templates. */
export const editorOptions = query({
  args: {},
  handler: async (ctx) => {
    await requireGoalsView(ctx);
    const [teams, seats, chapters] = await Promise.all([
      ctx.db.query("orgTeams").withIndex("by_sortOrder").take(300),
      ctx.db.query("seatDefs").take(500),
      listActiveChapters(ctx),
    ]);
    const chapterName = new Map(chapters.map((c) => [c._id, c.name]));
    const eventTypes = [];
    for (const c of chapters) {
      const rows = await ctx.db
        .query("eventTypes")
        .withIndex("by_chapter", (q) => q.eq("chapterId", c._id))
        .take(100);
      for (const t of rows) {
        if (t.isArchived) continue;
        eventTypes.push({ _id: t._id, name: t.name, chapterName: c.name });
      }
    }
    return {
      teams: teams
        .filter((t) => !t.isArchived)
        .map((t) => ({
          _id: t._id,
          name: t.name,
          chapterName: t.chapterId ? (chapterName.get(t.chapterId) ?? null) : null,
        })),
      seats: seats
        .filter((s) => !s.derived)
        .sort((a, b) => a.chart.localeCompare(b.chart) || a.sortOrder - b.sortOrder)
        .map((s) => ({ slug: s.slug, title: s.title, chart: s.chart })),
      chapters: chapters.map((c) => ({ _id: c._id, name: c.name })),
      eventTypes,
    };
  },
});

/** Key results a project can be linked to: every objective's results in
 *  plans that aren't closed, labelled "2027 · 2.4 Title". */
export const keyResultOptions = query({
  args: {},
  handler: async (ctx) => {
    if (!(await hasGoalsView(ctx))) return [];
    const plans = await ctx.db.query("goalPlans").withIndex("by_year").order("desc").take(10);
    const out: { _id: Id<"goalKeyResults">; label: string }[] = [];
    for (const p of plans) {
      if (p.status === "closed") continue;
      const objectives = (
        await ctx.db.query("goalObjectives").withIndex("by_plan", (q) => q.eq("planId", p._id)).take(50)
      ).sort((a, b) => a.sortOrder - b.sortOrder);
      for (const [oi, o] of objectives.entries()) {
        const krs = (
          await ctx.db
            .query("goalKeyResults")
            .withIndex("by_objective", (q) => q.eq("objectiveId", o._id))
            .take(100)
        ).sort((a, b) => a.sortOrder - b.sortOrder);
        for (const [ki, k] of krs.entries()) {
          out.push({ _id: k._id, label: `${p.year} · ${keyResultCode(oi, ki)} ${k.title}` });
        }
      }
    }
    return out;
  },
});

/** Every team, archived ones last, for the Teams editor. */
export const teams = query({
  args: {},
  handler: async (ctx) => {
    await requireGoalsView(ctx);
    const [rows, seats, chapters] = await Promise.all([
      ctx.db.query("orgTeams").withIndex("by_sortOrder").take(300),
      seatTitles(ctx),
      listActiveChapters(ctx),
    ]);
    const chapterName = new Map(chapters.map((c) => [c._id, c.name]));
    const byId = new Map(rows.map((t) => [t._id, t]));
    return {
      canEdit: await hasTeamsEdit(ctx),
      teams: rows
        .sort((a, b) => Number(!!a.isArchived) - Number(!!b.isArchived) || a.sortOrder - b.sortOrder)
        .map((t) => ({
          ...t,
          chapterName: t.chapterId ? (chapterName.get(t.chapterId) ?? null) : null,
          leadSeatTitle: t.leadSeatSlug ? (seats.get(t.leadSeatSlug) ?? t.leadSeatSlug) : null,
          seatTitles: t.seatSlugs.map((s) => seats.get(s) ?? s),
          parentName: t.parentTeamId ? (byId.get(t.parentTeamId)?.name ?? null) : null,
        })),
    };
  },
});
