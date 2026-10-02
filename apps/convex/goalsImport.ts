/**
 * Goals — copying the 2027 One Pager (`@events-os/shared#ONE_PAGER_2027`)
 * into rows, once. After the import nothing reads the seed again: the plan,
 * its teams and every key result are ordinary rows edited in the app.
 */
import { mutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { ConvexError } from "convex/values";
import { ONE_PAGER_2027, seedDueToMs, type SeedTeam } from "@events-os/shared";
import { requireGoalsEdit } from "./lib/goalsAccess";
import { requireTeamsEdit } from "./lib/teamsAccess";
import { requireUserId } from "./lib/context";
import { listActiveChapters } from "./lib/chapters";

const CHAPTER_PATTERNS: Record<Exclude<SeedTeam["scope"], "central">, RegExp> = {
  nyc: /\bnyc\b|new york/i,
  dmv: /\bdmv\b|washington|\bd\.?c\.?\b/i,
};

function matchChapter(
  chapters: Doc<"chapters">[],
  scope: SeedTeam["scope"],
): Id<"chapters"> | undefined {
  if (scope === "central") return undefined;
  const re = CHAPTER_PATTERNS[scope];
  return chapters.find((c) => re.test(c.name) || re.test(c.slug ?? ""))?._id;
}

/** Find a live team by name, or create it. */
async function ensureTeams(
  ctx: MutationCtx,
  chapters: Doc<"chapters">[],
): Promise<Map<string, Id<"orgTeams">>> {
  const existing = await ctx.db.query("orgTeams").withIndex("by_sortOrder").take(300);
  const byName = new Map<string, Id<"orgTeams">>();
  for (const t of existing) if (!t.isArchived) byName.set(t.name.toLowerCase(), t._id);
  let sortOrder = existing.reduce((m, t) => Math.max(m, t.sortOrder), -1) + 1;
  const now = Date.now();
  for (const seed of ONE_PAGER_2027.teams) {
    if (byName.has(seed.name.toLowerCase())) continue;
    const chapterId = matchChapter(chapters, seed.scope);
    const parentTeamId = seed.parent ? byName.get(seed.parent.toLowerCase()) : undefined;
    const id = await ctx.db.insert("orgTeams", {
      name: seed.name,
      chapterId,
      leadSeatSlug: seed.leadSeat,
      seatSlugs: seed.seats ?? [],
      parentTeamId,
      description:
        seed.scope !== "central" && !chapterId
          ? "This chapter isn't set up in Chapter OS yet. Pick it here once it is."
          : undefined,
      sortOrder: sortOrder++,
      createdAt: now,
      updatedAt: now,
    });
    byName.set(seed.name.toLowerCase(), id);
  }
  return byName;
}

/** Create the 2027 plan from the One Pager. Refuses if a 2027 plan exists,
 *  so it can never overwrite edits. */
export const importOnePager = mutation({
  args: {},
  handler: async (ctx) => {
    await requireGoalsEdit(ctx);
    await requireTeamsEdit(ctx);
    const seed = ONE_PAGER_2027;
    const clash = await ctx.db
      .query("goalPlans")
      .withIndex("by_year", (q) => q.eq("year", seed.year))
      .first();
    if (clash) {
      throw new ConvexError({
        code: "CONFLICT",
        message: `There is already a ${seed.year} plan. Edit it, or delete it first to start over.`,
      });
    }
    const userId = (await requireUserId(ctx)) as Id<"users">;
    const chapters = await listActiveChapters(ctx);
    const teams = await ensureTeams(ctx, chapters);
    const team = (name: string | undefined) => (name ? teams.get(name.toLowerCase()) : undefined);
    const now = Date.now();

    const planId = await ctx.db.insert("goalPlans", {
      year: seed.year,
      title: seed.title,
      mission: seed.mission,
      retroWins: seed.retroWins,
      retroGaps: seed.retroGaps,
      status: "active",
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    });

    let targetOrder = 0;
    for (const t of seed.targets) {
      const parentTargetId = await ctx.db.insert("goalTargets", {
        planId,
        label: t.label,
        target: t.target,
        unit: t.unit,
        sortOrder: targetOrder++,
        updatedAt: now,
      });
      for (const [i, c] of (t.children ?? []).entries()) {
        await ctx.db.insert("goalTargets", {
          planId,
          label: c.label,
          target: c.target,
          unit: t.unit,
          parentTargetId,
          sortOrder: i,
          updatedAt: now,
        });
      }
    }

    for (const [oi, o] of seed.objectives.entries()) {
      const objectiveId = await ctx.db.insert("goalObjectives", {
        planId,
        title: o.title,
        ownerTeamId: team(o.owner),
        sortOrder: oi,
        updatedAt: now,
      });
      for (const [ki, k] of o.keyResults.entries()) {
        const m = k.measure;
        let measure: Pick<Doc<"goalKeyResults">, "measureKind"> &
          Partial<Pick<Doc<"goalKeyResults">, "target" | "unit" | "seatSlug" | "seatScope">> = {
          measureKind: "manual",
        };
        if (m?.kind === "manual") {
          measure = { measureKind: "manual", target: m.target, unit: m.unit };
        } else if (m?.kind === "seat_filled") {
          const scope = m.scope === "central" ? "central" : matchChapter(chapters, m.scope);
          // A chapter that doesn't exist yet can't be counted; fall back to
          // a manual 0-of-1 the owner flips when the seat is filled.
          measure = scope
            ? { measureKind: "seat_filled", seatSlug: m.seat, seatScope: scope, target: m.target }
            : { measureKind: "manual", target: m.target ?? 1, unit: "people" };
        }
        await ctx.db.insert("goalKeyResults", {
          planId,
          objectiveId,
          title: k.title,
          sortOrder: ki,
          ownerTeamId: k.ownerSeat ? undefined : team(k.owner),
          ownerSeatSlug: k.ownerSeat,
          contributorTeamIds: (k.contributors ?? [])
            .map((c) => team(c))
            .filter((id): id is Id<"orgTeams"> => !!id),
          timing: k.timing,
          dueDate: k.due ? seedDueToMs(k.due) : undefined,
          status: "not_started",
          ...measure,
          updatedAt: now,
        });
      }
    }
    return planId;
  },
});
