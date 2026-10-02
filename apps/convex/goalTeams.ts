/**
 * Teams — editing `orgTeams`, the named groups of seats a plan uses to say
 * who owns what. Teams carry no powers (seats do), so a team can be renamed,
 * re-led, regrouped or archived at any time without changing anyone's access.
 * Gated by `lib/teamsAccess.ts`. Reads are in `goals.ts#teams`.
 */
import { mutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { ConvexError, v } from "convex/values";
import { requireTeamsEdit } from "./lib/teamsAccess";

function cleanName(name: string): string {
  const t = name.trim();
  if (!t) throw new ConvexError({ code: "INVALID", message: "A team needs a name." });
  return t;
}

/** A team may not sit inside itself, directly or through its parents. */
async function assertNoCycle(
  ctx: MutationCtx,
  teamId: Id<"orgTeams">,
  parentTeamId: Id<"orgTeams">,
) {
  let cursor: Id<"orgTeams"> | undefined = parentTeamId;
  for (let hops = 0; cursor && hops < 50; hops++) {
    if (cursor === teamId) {
      throw new ConvexError({ code: "INVALID", message: "A team can't sit inside itself." });
    }
    const row: { parentTeamId?: Id<"orgTeams"> } | null = await ctx.db.get(cursor);
    cursor = row?.parentTeamId;
  }
}

export const createTeam = mutation({
  args: {
    name: v.string(),
    chapterId: v.optional(v.id("chapters")),
    leadSeatSlug: v.optional(v.string()),
    seatSlugs: v.optional(v.array(v.string())),
    parentTeamId: v.optional(v.id("orgTeams")),
    description: v.optional(v.string()),
  },
  handler: async (ctx, { name, seatSlugs, ...rest }) => {
    await requireTeamsEdit(ctx);
    const last = await ctx.db.query("orgTeams").withIndex("by_sortOrder").order("desc").first();
    const now = Date.now();
    return await ctx.db.insert("orgTeams", {
      ...rest,
      name: cleanName(name),
      seatSlugs: seatSlugs ?? [],
      sortOrder: (last?.sortOrder ?? -1) + 1,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const updateTeam = mutation({
  args: {
    teamId: v.id("orgTeams"),
    name: v.optional(v.string()),
    chapterId: v.optional(v.union(v.id("chapters"), v.null())),
    leadSeatSlug: v.optional(v.union(v.string(), v.null())),
    seatSlugs: v.optional(v.array(v.string())),
    parentTeamId: v.optional(v.union(v.id("orgTeams"), v.null())),
    description: v.optional(v.union(v.string(), v.null())),
    isArchived: v.optional(v.boolean()),
  },
  handler: async (ctx, { teamId, name, ...rest }) => {
    await requireTeamsEdit(ctx);
    const team = await ctx.db.get(teamId);
    if (!team) throw new ConvexError({ code: "NOT_FOUND", message: "Team not found." });
    if (rest.parentTeamId) await assertNoCycle(ctx, teamId, rest.parentTeamId);
    const patch: Record<string, any> = {};
    for (const [k, val] of Object.entries(rest)) {
      if (val !== undefined) patch[k] = val === null ? undefined : val;
    }
    if (name !== undefined) patch.name = cleanName(name);
    await ctx.db.patch(teamId, { ...patch, updatedAt: Date.now() });
  },
});

/** Move a team one place up or down the list. */
export const moveTeam = mutation({
  args: { teamId: v.id("orgTeams"), direction: v.union(v.literal("up"), v.literal("down")) },
  handler: async (ctx, { teamId, direction }) => {
    await requireTeamsEdit(ctx);
    const all = await ctx.db.query("orgTeams").withIndex("by_sortOrder").take(300);
    const i = all.findIndex((t) => t._id === teamId);
    const j = direction === "up" ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= all.length) return;
    const order = all.map((t) => t._id);
    [order[i], order[j]] = [order[j], order[i]];
    const now = Date.now();
    for (const [n, id] of order.entries()) await ctx.db.patch(id, { sortOrder: n, updatedAt: now });
  },
});

/** Delete a team outright. Objectives and key results it owned keep their
 *  place and simply lose that owner; child teams move up a level. Archiving
 *  (`updateTeam({isArchived: true})`) is the gentler option. */
export const deleteTeam = mutation({
  args: { teamId: v.id("orgTeams") },
  handler: async (ctx, { teamId }) => {
    await requireTeamsEdit(ctx);
    const team = await ctx.db.get(teamId);
    if (!team) return;
    const all = await ctx.db.query("orgTeams").withIndex("by_sortOrder").take(300);
    for (const t of all) {
      if (t.parentTeamId === teamId) await ctx.db.patch(t._id, { parentTeamId: team.parentTeamId });
    }
    const plans = await ctx.db.query("goalPlans").withIndex("by_year").take(50);
    for (const p of plans) {
      const objectives = await ctx.db
        .query("goalObjectives")
        .withIndex("by_plan", (q) => q.eq("planId", p._id))
        .take(50);
      for (const o of objectives) {
        if (o.ownerTeamId === teamId) await ctx.db.patch(o._id, { ownerTeamId: undefined });
      }
      const krs = await ctx.db
        .query("goalKeyResults")
        .withIndex("by_plan", (q) => q.eq("planId", p._id))
        .take(500);
      for (const k of krs) {
        const owned = k.ownerTeamId === teamId;
        const contributes = k.contributorTeamIds.includes(teamId);
        if (!owned && !contributes) continue;
        await ctx.db.patch(k._id, {
          ...(owned ? { ownerTeamId: undefined } : {}),
          contributorTeamIds: k.contributorTeamIds.filter((id) => id !== teamId),
        });
      }
    }
    await ctx.db.delete(teamId);
  },
});
