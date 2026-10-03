/**
 * Goals — changing a plan's content. Every part of a plan is editable at any
 * time, whatever its status (founder ask, 2026-10-02: "objectives, teams,
 * seats, OKRs etc can all change in a moment's notice"). Content edits go
 * through `requireGoalsEdit`; posting a status update on a key result goes
 * through `requireGoalsUpdate`. See `lib/goalsAccess.ts`.
 */
import { mutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { ConvexError, v } from "convex/values";
import {
  GOAL_PLAN_STATUSES,
  GOAL_UNITS,
  KEY_RESULT_MEASURE_KINDS,
  KEY_RESULT_STATUSES,
} from "@events-os/shared";
import { requireGoalsEdit, requireGoalsUpdate } from "./lib/goalsAccess";
import { requireUserId } from "./lib/context";
import { callerPersonIds } from "./lib/seatStructure";

const planStatus = v.union(...GOAL_PLAN_STATUSES.map((s) => v.literal(s)));
const krStatus = v.union(...KEY_RESULT_STATUSES.map((s) => v.literal(s)));
const measureKind = v.union(...KEY_RESULT_MEASURE_KINDS.map((k) => v.literal(k)));
const unit = v.union(...GOAL_UNITS.map((u) => v.literal(u)));
const direction = v.union(v.literal("up"), v.literal("down"));

function cleanTitle(s: string, what: string): string {
  const t = s.trim();
  if (!t) throw new ConvexError({ code: "INVALID", message: `${what} can't be empty.` });
  return t;
}

/** `null` in a patch clears the field; `undefined` leaves it alone. */
function nullToUndefined(patch: Record<string, unknown>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, val] of Object.entries(patch)) {
    if (val !== undefined) out[k] = val === null ? undefined : val;
  }
  return out;
}

async function requireRow<T extends "goalPlans" | "goalTargets" | "goalObjectives" | "goalKeyResults">(
  ctx: MutationCtx,
  id: Id<T>,
  label: string,
) {
  const row = await ctx.db.get(id);
  if (!row) throw new ConvexError({ code: "NOT_FOUND", message: `${label} not found.` });
  return row;
}

/** Swap a row's `sortOrder` with its neighbour in `siblings`. */
async function swapWithNeighbour<T extends "goalTargets" | "goalObjectives" | "goalKeyResults">(
  ctx: MutationCtx,
  siblings: { _id: Id<T>; sortOrder: number }[],
  id: Id<T>,
  dir: "up" | "down",
) {
  const sorted = [...siblings].sort((a, b) => a.sortOrder - b.sortOrder);
  const i = sorted.findIndex((s) => s._id === id);
  const j = dir === "up" ? i - 1 : i + 1;
  if (i < 0 || j < 0 || j >= sorted.length) return;
  // Renumber the whole list so ties from older rows can't stall a move.
  const order = sorted.map((s) => s._id);
  [order[i], order[j]] = [order[j], order[i]];
  const now = Date.now();
  for (const [n, rowId] of order.entries()) {
    await ctx.db.patch(rowId as Id<T>, { sortOrder: n, updatedAt: now } as never);
  }
}

// ── Plans ────────────────────────────────────────────────────────────────────

export const createPlan = mutation({
  args: { year: v.number(), title: v.optional(v.string()) },
  handler: async (ctx, { year, title }) => {
    await requireGoalsEdit(ctx);
    const existing = await ctx.db
      .query("goalPlans")
      .withIndex("by_year", (q) => q.eq("year", year))
      .first();
    if (existing) {
      throw new ConvexError({ code: "CONFLICT", message: `There is already a ${year} plan.` });
    }
    const userId = (await requireUserId(ctx)) as Id<"users">;
    const now = Date.now();
    return await ctx.db.insert("goalPlans", {
      year,
      title: title?.trim() || `${year} plan`,
      retroWins: [],
      retroGaps: [],
      status: "draft",
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const updatePlan = mutation({
  args: {
    planId: v.id("goalPlans"),
    title: v.optional(v.string()),
    mission: v.optional(v.union(v.string(), v.null())),
    retroWins: v.optional(v.array(v.string())),
    retroGaps: v.optional(v.array(v.string())),
    status: v.optional(planStatus),
  },
  handler: async (ctx, { planId, title, ...rest }) => {
    await requireGoalsEdit(ctx);
    await requireRow(ctx, planId, "Plan");
    const patch = nullToUndefined({
      ...rest,
      retroWins: rest.retroWins?.map((s) => s.trim()).filter(Boolean),
      retroGaps: rest.retroGaps?.map((s) => s.trim()).filter(Boolean),
    });
    if (title !== undefined) patch.title = cleanTitle(title, "The plan's name");
    await ctx.db.patch(planId, { ...patch, updatedAt: Date.now() });
  },
});

/** Delete a plan and everything in it. Projects linked to its key results
 *  are unlinked, never deleted. */
export const deletePlan = mutation({
  args: { planId: v.id("goalPlans") },
  handler: async (ctx, { planId }) => {
    await requireGoalsEdit(ctx);
    await requireRow(ctx, planId, "Plan");
    const krs = await ctx.db
      .query("goalKeyResults")
      .withIndex("by_plan", (q) => q.eq("planId", planId))
      .take(500);
    for (const kr of krs) await deleteKeyResultRow(ctx, kr._id);
    for (const table of ["goalObjectives", "goalTargets"] as const) {
      const rows = await ctx.db
        .query(table)
        .withIndex("by_plan", (q) => q.eq("planId", planId))
        .take(500);
      for (const r of rows) await ctx.db.delete(r._id);
    }
    await ctx.db.delete(planId);
  },
});

// ── Targets ──────────────────────────────────────────────────────────────────

export const createTarget = mutation({
  args: {
    planId: v.id("goalPlans"),
    label: v.string(),
    target: v.number(),
    unit,
    parentTargetId: v.optional(v.id("goalTargets")),
  },
  handler: async (ctx, { planId, label, target, unit, parentTargetId }) => {
    await requireGoalsEdit(ctx);
    await requireRow(ctx, planId, "Plan");
    const siblings = await ctx.db
      .query("goalTargets")
      .withIndex("by_plan", (q) => q.eq("planId", planId))
      .take(100);
    return await ctx.db.insert("goalTargets", {
      planId,
      label: cleanTitle(label, "A target's name"),
      target,
      unit,
      parentTargetId,
      sortOrder: siblings.length,
      updatedAt: Date.now(),
    });
  },
});

export const updateTarget = mutation({
  args: {
    targetId: v.id("goalTargets"),
    label: v.optional(v.string()),
    target: v.optional(v.number()),
    unit: v.optional(unit),
    current: v.optional(v.union(v.number(), v.null())),
  },
  handler: async (ctx, { targetId, label, ...rest }) => {
    await requireGoalsEdit(ctx);
    await requireRow(ctx, targetId, "Target");
    const patch = nullToUndefined(rest);
    if (label !== undefined) patch.label = cleanTitle(label, "A target's name");
    await ctx.db.patch(targetId, { ...patch, updatedAt: Date.now() });
  },
});

export const deleteTarget = mutation({
  args: { targetId: v.id("goalTargets") },
  handler: async (ctx, { targetId }) => {
    await requireGoalsEdit(ctx);
    const t = await requireRow(ctx, targetId, "Target");
    const all = await ctx.db
      .query("goalTargets")
      .withIndex("by_plan", (q) => q.eq("planId", t.planId))
      .take(100);
    for (const c of all) if (c.parentTargetId === targetId) await ctx.db.delete(c._id);
    await ctx.db.delete(targetId);
  },
});

export const moveTarget = mutation({
  args: { targetId: v.id("goalTargets"), direction },
  handler: async (ctx, { targetId, direction }) => {
    await requireGoalsEdit(ctx);
    const t = await requireRow(ctx, targetId, "Target");
    const all = await ctx.db
      .query("goalTargets")
      .withIndex("by_plan", (q) => q.eq("planId", t.planId))
      .take(100);
    await swapWithNeighbour(ctx, all.filter((s) => s.parentTargetId === t.parentTargetId), targetId, direction);
  },
});

// ── Objectives ───────────────────────────────────────────────────────────────

export const createObjective = mutation({
  args: { planId: v.id("goalPlans"), title: v.string(), ownerTeamId: v.optional(v.id("orgTeams")) },
  handler: async (ctx, { planId, title, ownerTeamId }) => {
    await requireGoalsEdit(ctx);
    await requireRow(ctx, planId, "Plan");
    const siblings = await ctx.db
      .query("goalObjectives")
      .withIndex("by_plan", (q) => q.eq("planId", planId))
      .take(50);
    const max = siblings.reduce((m, s) => Math.max(m, s.sortOrder), -1);
    return await ctx.db.insert("goalObjectives", {
      planId,
      title: cleanTitle(title, "An objective"),
      ownerTeamId,
      sortOrder: max + 1,
      updatedAt: Date.now(),
    });
  },
});

export const updateObjective = mutation({
  args: {
    objectiveId: v.id("goalObjectives"),
    title: v.optional(v.string()),
    ownerTeamId: v.optional(v.union(v.id("orgTeams"), v.null())),
  },
  handler: async (ctx, { objectiveId, title, ...rest }) => {
    await requireGoalsEdit(ctx);
    await requireRow(ctx, objectiveId, "Objective");
    const patch = nullToUndefined(rest);
    if (title !== undefined) patch.title = cleanTitle(title, "An objective");
    await ctx.db.patch(objectiveId, { ...patch, updatedAt: Date.now() });
  },
});

export const deleteObjective = mutation({
  args: { objectiveId: v.id("goalObjectives") },
  handler: async (ctx, { objectiveId }) => {
    await requireGoalsEdit(ctx);
    await requireRow(ctx, objectiveId, "Objective");
    const krs = await ctx.db
      .query("goalKeyResults")
      .withIndex("by_objective", (q) => q.eq("objectiveId", objectiveId))
      .take(200);
    for (const kr of krs) await deleteKeyResultRow(ctx, kr._id);
    await ctx.db.delete(objectiveId);
  },
});

export const moveObjective = mutation({
  args: { objectiveId: v.id("goalObjectives"), direction },
  handler: async (ctx, { objectiveId, direction }) => {
    await requireGoalsEdit(ctx);
    const o = await requireRow(ctx, objectiveId, "Objective");
    const siblings = await ctx.db
      .query("goalObjectives")
      .withIndex("by_plan", (q) => q.eq("planId", o.planId))
      .take(50);
    await swapWithNeighbour(ctx, siblings, objectiveId, direction);
  },
});

// ── Key results ──────────────────────────────────────────────────────────────

const keyResultFields = {
  title: v.optional(v.string()),
  ownerTeamId: v.optional(v.union(v.id("orgTeams"), v.null())),
  ownerSeatSlug: v.optional(v.union(v.string(), v.null())),
  contributorTeamIds: v.optional(v.array(v.id("orgTeams"))),
  timing: v.optional(v.union(v.string(), v.null())),
  dueDate: v.optional(v.union(v.number(), v.null())),
  measureKind: v.optional(measureKind),
  target: v.optional(v.union(v.number(), v.null())),
  current: v.optional(v.union(v.number(), v.null())),
  unit: v.optional(v.union(unit, v.null())),
  seatSlug: v.optional(v.union(v.string(), v.null())),
  seatScope: v.optional(v.union(v.id("chapters"), v.literal("central"), v.null())),
  eventTypeIds: v.optional(v.array(v.id("eventTypes"))),
  eventChapterId: v.optional(v.union(v.id("chapters"), v.null())),
};

export const createKeyResult = mutation({
  args: { objectiveId: v.id("goalObjectives"), title: v.string() },
  handler: async (ctx, { objectiveId, title }) => {
    await requireGoalsEdit(ctx);
    const o = await requireRow(ctx, objectiveId, "Objective");
    const siblings = await ctx.db
      .query("goalKeyResults")
      .withIndex("by_objective", (q) => q.eq("objectiveId", objectiveId))
      .take(200);
    const max = siblings.reduce((m, s) => Math.max(m, s.sortOrder), -1);
    return await ctx.db.insert("goalKeyResults", {
      planId: o.planId,
      objectiveId,
      title: cleanTitle(title, "A key result"),
      sortOrder: max + 1,
      ownerTeamId: o.ownerTeamId,
      contributorTeamIds: [],
      status: "not_started",
      measureKind: "manual",
      updatedAt: Date.now(),
    });
  },
});

/** Change anything about a key result, including moving it to another
 *  objective in the same plan (it lands at the end). */
export const updateKeyResult = mutation({
  args: {
    keyResultId: v.id("goalKeyResults"),
    objectiveId: v.optional(v.id("goalObjectives")),
    ...keyResultFields,
  },
  handler: async (ctx, { keyResultId, objectiveId, title, ...rest }) => {
    await requireGoalsEdit(ctx);
    const kr = await requireRow(ctx, keyResultId, "Key result");
    const patch = nullToUndefined(rest);
    if (title !== undefined) patch.title = cleanTitle(title, "A key result");
    if (objectiveId && objectiveId !== kr.objectiveId) {
      const target = await requireRow(ctx, objectiveId, "Objective");
      if (target.planId !== kr.planId) {
        throw new ConvexError({ code: "INVALID", message: "A key result can only move within its plan." });
      }
      const siblings = await ctx.db
        .query("goalKeyResults")
        .withIndex("by_objective", (q) => q.eq("objectiveId", objectiveId))
        .take(200);
      patch.objectiveId = objectiveId;
      patch.sortOrder = siblings.reduce((m, s) => Math.max(m, s.sortOrder), -1) + 1;
    }
    // One accountable owner: picking a team clears a seat owner and back.
    if (rest.ownerTeamId) patch.ownerSeatSlug = undefined;
    if (rest.ownerSeatSlug) patch.ownerTeamId = undefined;
    // Pointing a key result at a seat starts counting from now: whoever
    // already holds that seat isn't progress on it.
    const kind = rest.measureKind ?? kr.measureKind;
    const seatChanged =
      (rest.seatSlug !== undefined && rest.seatSlug !== kr.seatSlug) ||
      (rest.seatScope !== undefined && rest.seatScope !== kr.seatScope) ||
      (rest.measureKind !== undefined && rest.measureKind !== kr.measureKind);
    if (kind === "seat_filled" && seatChanged) patch.seatWatchSince = Date.now();
    await ctx.db.patch(keyResultId, { ...patch, updatedAt: Date.now() });
  },
});

async function deleteKeyResultRow(ctx: MutationCtx, keyResultId: Id<"goalKeyResults">) {
  const updates = await ctx.db
    .query("goalUpdates")
    .withIndex("by_key_result", (q) => q.eq("keyResultId", keyResultId))
    .take(1000);
  for (const u of updates) await ctx.db.delete(u._id);
  const linked = await ctx.db
    .query("projects")
    .withIndex("by_keyResultId", (q) => q.eq("keyResultId", keyResultId))
    .take(500);
  for (const p of linked) await ctx.db.patch(p._id, { keyResultId: undefined });
  await ctx.db.delete(keyResultId);
}

export const deleteKeyResult = mutation({
  args: { keyResultId: v.id("goalKeyResults") },
  handler: async (ctx, { keyResultId }) => {
    await requireGoalsEdit(ctx);
    await requireRow(ctx, keyResultId, "Key result");
    await deleteKeyResultRow(ctx, keyResultId);
  },
});

export const moveKeyResult = mutation({
  args: { keyResultId: v.id("goalKeyResults"), direction },
  handler: async (ctx, { keyResultId, direction }) => {
    await requireGoalsEdit(ctx);
    const kr = await requireRow(ctx, keyResultId, "Key result");
    const siblings = await ctx.db
      .query("goalKeyResults")
      .withIndex("by_objective", (q) => q.eq("objectiveId", kr.objectiveId))
      .take(200);
    await swapWithNeighbour(ctx, siblings, keyResultId, direction);
  },
});

/** Say how a key result is going: a status, optionally a number (manual
 *  measures) and a note. Appends to its history and sets its status. */
export const postUpdate = mutation({
  args: {
    keyResultId: v.id("goalKeyResults"),
    status: krStatus,
    current: v.optional(v.number()),
    note: v.optional(v.string()),
  },
  handler: async (ctx, { keyResultId, status, current, note }) => {
    await requireGoalsUpdate(ctx);
    const kr = await requireRow(ctx, keyResultId, "Key result");
    const userId = (await requireUserId(ctx)) as Id<"users">;
    const [authorPersonId] = await callerPersonIds(ctx, userId);
    const now = Date.now();
    const trimmed = note?.trim() || undefined;
    const typed = kr.measureKind === "manual" ? current : undefined;
    await ctx.db.insert("goalUpdates", {
      planId: kr.planId,
      keyResultId,
      status,
      current: typed,
      note: trimmed,
      authorUserId: userId,
      authorPersonId,
      createdAt: now,
    });
    await ctx.db.patch(keyResultId, {
      status,
      ...(typed !== undefined ? { current: typed } : {}),
      lastUpdateAt: now,
      updatedAt: now,
    });
  },
});
