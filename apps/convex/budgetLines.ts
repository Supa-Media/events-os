/**
 * Budget line items (WP-3.1) — the PLAN step of Plan → Approve → Spend →
 * Reconcile. "When a dollar amount is entered, a budget panel comes up: what
 * are you gonna spend this money on? break down and categorize it."
 *
 * A line is a categorized, described chunk of a v2 `budgets` row's
 * `amountCents` allocation. ESTIMATED-side only (invariant #2, PRD §1): a
 * line's `plannedCents` is NEVER summed with `transactions` actuals — it
 * exists purely to answer "what is this budget FOR" before a dollar is spent.
 * `budgetPlanSummary` compares the plan (sum of lines) against the budget's
 * `amountCents` allocation — an over/under-planned indicator, not a spend one.
 *
 * Distinct from the legacy PER-EVENT `budgetLineItems` table (`budget.ts` /
 * `schema/budget.ts`, Budget v1), which also tracks an `actualCents` per line
 * against a single event. This table (`budgetLines`) belongs to a v2 `budgets`
 * row — chapter OR central (WP-0.3's sentinel) — so it was named distinctly to
 * avoid colliding with the v1 table.
 *
 * GATING mirrors `finances.ts`'s budgets CRUD exactly: every read/write
 * resolves the caller's OWN chapter (`requireChapterId`), loads the PARENT
 * budget, and verifies tenancy — a real chapter budget must match the
 * caller's chapter; a central budget (`chapterId === CENTRAL`) is allowed
 * regardless of the caller's home chapter. The graded role check is then
 * picked by the parent budget's LEVEL, "at the budget's scope" (not the
 * caller's default chapter role):
 *  - list                 → viewer+ at the budget's level (chapter viewer, or
 *                            central reach + viewer for a central budget) —
 *                            OR (WP-wave4) the caller holding a central-chart
 *                            `finance.approve` seat (the ED — see
 *                            `requireCentralFinanceRoleOrEdSeat`).
 *  - add/update/remove/
 *    reorder               → bookkeeper+ at the budget's level (chapter
 *                            bookkeeper, or central reach + bookkeeper for a
 *                            central budget) — mirrors `requireCentralFinanceRole`'s
 *                            money-write gate (#151), since a plan is a
 *                            meaningful financial record even though it's
 *                            estimated-side. Central ALSO accepts the ED-seat
 *                            widening above, so the ED can plan a central
 *                            budget without a stored central rank grant.
 * This is intentionally TIGHTER than `listBudgets` (which lets any chapter
 * viewer read every central budget's headline) — a budget's line-by-line
 * breakdown is a more granular record, so central budgets' lines are gated on
 * genuine central reach, not just "some finance role somewhere."
 */
import { query, mutation } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { Doc, Id } from "./_generated/dataModel";
import { CENTRAL } from "@events-os/shared";
import {
  requireChapterId,
  requireUserId,
  getChapterIdOrNull,
  requireEvent,
} from "./lib/context";
import { requireFinanceRole, requireCentralFinanceRoleOrEdSeat } from "./lib/finance";

// A generous bound on lines-per-budget: a plan breakdown is a human-authored
// list of categories, not a synced feed, so this is far above any real usage.
const LINE_SCAN_LIMIT = 500;

/** Enforce the plan invariant: a planned amount is a POSITIVE integer number
 *  of cents (never zero or negative — a $0 line plans nothing). */
function assertPlannedCents(plannedCents: number): void {
  if (!Number.isInteger(plannedCents) || plannedCents <= 0) {
    throw new ConvexError({
      code: "INVALID_AMOUNT",
      message: "Planned amount must be a positive whole number of cents.",
    });
  }
}

/**
 * Load the parent budget and verify it belongs to the caller — a real chapter
 * budget must match the caller's own chapter; a central budget (the CENTRAL
 * sentinel) is reachable from any chapter, mirroring
 * `finances.ts#requireInCallerChapter`'s `{ allowCentral: true }` mode (not
 * exported, so this is a small parallel helper scoped to `budgets`).
 */
async function loadOwningBudget(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
  budgetId: Id<"budgets">,
): Promise<Doc<"budgets">> {
  const budget = await ctx.db.get(budgetId);
  if (!budget || (budget.chapterId !== CENTRAL && budget.chapterId !== chapterId)) {
    throw new ConvexError({
      code: "NOT_FOUND",
      message: "Budget not found in your chapter.",
    });
  }
  return budget;
}

/** viewer+ at the budget's own level (chapter viewer, or central reach —
 *  OR, WP-wave4, a central `finance.approve` seat: the ED). */
async function requireLineReadAccess(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
  budget: Doc<"budgets">,
): Promise<void> {
  if (budget.chapterId === CENTRAL) {
    await requireCentralFinanceRoleOrEdSeat(ctx, chapterId, "viewer");
  } else {
    await requireFinanceRole(ctx, chapterId, "viewer");
  }
}

/** bookkeeper+ at the budget's own level (chapter bookkeeper, or central reach —
 *  OR, WP-wave4, a central `finance.approve` seat: the ED). */
async function requireLineWriteAccess(
  ctx: MutationCtx,
  chapterId: Id<"chapters">,
  budget: Doc<"budgets">,
): Promise<void> {
  if (budget.chapterId === CENTRAL) {
    await requireCentralFinanceRoleOrEdSeat(ctx, chapterId, "bookkeeper");
  } else {
    await requireFinanceRole(ctx, chapterId, "bookkeeper");
  }
}

/**
 * A budget line's category, if any, must belong to the CALLER's own chapter —
 * categories are always chapter-scoped (no central categories exist), the
 * same rule `finances.ts#verifyBudgetRefs` applies to a BUDGET's own
 * `categoryId`, central or not (a central budget's caller still has a real
 * home chapter).
 */
async function verifyCategory(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
  categoryId: Id<"budgetCategories"> | null | undefined,
): Promise<void> {
  if (!categoryId) return;
  const category = await ctx.db.get(categoryId);
  if (!category || category.chapterId !== chapterId) {
    throw new ConvexError({
      code: "NOT_FOUND",
      message: "Category not found in your chapter.",
    });
  }
}

/** All of a budget's lines, ordered by `sortOrder` (bounded, see `LINE_SCAN_LIMIT`). */
async function loadLines(
  ctx: QueryCtx,
  budgetId: Id<"budgets">,
): Promise<Doc<"budgetLines">[]> {
  const rows = await ctx.db
    .query("budgetLines")
    .withIndex("by_budget", (q) => q.eq("budgetId", budgetId))
    .take(LINE_SCAN_LIMIT);
  if (rows.length === LINE_SCAN_LIMIT) {
    console.warn(
      `[budgetLines] hit LINE_SCAN_LIMIT (${LINE_SCAN_LIMIT}) for budget ${budgetId}; list truncated.`,
    );
  }
  return rows.sort((a, b) => a.sortOrder - b.sortOrder);
}

const lineSummary = v.object({
  id: v.id("budgetLines"),
  budgetId: v.id("budgets"),
  description: v.string(),
  categoryId: v.union(v.id("budgetCategories"), v.null()),
  plannedCents: v.number(),
  sortOrder: v.number(),
  createdBy: v.id("users"),
  createdAt: v.number(),
});

function toLineSummary(l: Doc<"budgetLines">) {
  return {
    id: l._id,
    budgetId: l.budgetId,
    description: l.description,
    categoryId: l.categoryId ?? null,
    plannedCents: l.plannedCents,
    sortOrder: l.sortOrder,
    createdBy: l.createdBy,
    createdAt: l.createdAt,
  };
}

// ── Reads ────────────────────────────────────────────────────────────────────

export const listLines = query({
  args: { budgetId: v.id("budgets") },
  returns: v.array(lineSummary),
  handler: async (ctx, args) => {
    const chapterId = (await getChapterIdOrNull(ctx)) as Id<"chapters"> | null;
    if (!chapterId) return [];
    const budget = await loadOwningBudget(ctx, chapterId, args.budgetId);
    await requireLineReadAccess(ctx, chapterId, budget);
    const lines = await loadLines(ctx, args.budgetId);
    return lines.map(toLineSummary);
  },
});

/**
 * The plan vs allocation indicator: sum of the budget's lines against its
 * `amountCents` allocation. Purely ESTIMATED-side (invariant #2) — never
 * mixes in `transactions` actuals; that comparison is `budgetVsActual`'s job.
 */
export const budgetPlanSummary = query({
  args: { budgetId: v.id("budgets") },
  returns: v.object({
    budgetId: v.id("budgets"),
    totalCents: v.number(),
    plannedCents: v.number(),
    remainingCents: v.number(),
    overPlanned: v.boolean(),
    lineCount: v.number(),
  }),
  handler: async (ctx, args) => {
    const chapterId = (await getChapterIdOrNull(ctx)) as Id<"chapters"> | null;
    if (!chapterId) {
      throw new ConvexError({
        code: "NO_CHAPTER",
        message: "You don't belong to a chapter yet.",
      });
    }
    const budget = await loadOwningBudget(ctx, chapterId, args.budgetId);
    await requireLineReadAccess(ctx, chapterId, budget);
    const lines = await loadLines(ctx, args.budgetId);
    const plannedCents = lines.reduce((sum, l) => sum + l.plannedCents, 0);
    return {
      budgetId: args.budgetId,
      totalCents: budget.amountCents,
      plannedCents,
      remainingCents: budget.amountCents - plannedCents,
      overPlanned: plannedCents > budget.amountCents,
      lineCount: lines.length,
    };
  },
});

// ── Writes ───────────────────────────────────────────────────────────────────

export const addLine = mutation({
  args: {
    budgetId: v.id("budgets"),
    description: v.string(),
    categoryId: v.optional(v.id("budgetCategories")),
    plannedCents: v.number(),
  },
  returns: v.id("budgetLines"),
  handler: async (ctx, args) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    const budget = await loadOwningBudget(ctx, chapterId, args.budgetId);
    await requireLineWriteAccess(ctx, chapterId, budget);
    const description = args.description.trim();
    if (!description) {
      throw new ConvexError({
        code: "INVALID_DESCRIPTION",
        message: "Enter what this line is for.",
      });
    }
    assertPlannedCents(args.plannedCents);
    await verifyCategory(ctx, chapterId, args.categoryId);
    const userId = (await requireUserId(ctx)) as Id<"users">;
    const existing = await loadLines(ctx, args.budgetId);
    const nextSortOrder =
      existing.length === 0 ? 0 : Math.max(...existing.map((l) => l.sortOrder)) + 1;
    return await ctx.db.insert("budgetLines", {
      budgetId: args.budgetId,
      description,
      categoryId: args.categoryId,
      plannedCents: args.plannedCents,
      sortOrder: nextSortOrder,
      createdBy: userId,
      createdAt: Date.now(),
    });
  },
});

export const updateLine = mutation({
  args: {
    lineId: v.id("budgetLines"),
    patch: v.object({
      description: v.optional(v.string()),
      categoryId: v.optional(v.union(v.id("budgetCategories"), v.null())),
      plannedCents: v.optional(v.number()),
    }),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    const line = await ctx.db.get(args.lineId);
    if (!line) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Budget line not found." });
    }
    const budget = await loadOwningBudget(ctx, chapterId, line.budgetId);
    await requireLineWriteAccess(ctx, chapterId, budget);

    const patch: Record<string, unknown> = {};
    if (args.patch.description !== undefined) {
      const description = args.patch.description.trim();
      if (!description) {
        throw new ConvexError({
          code: "INVALID_DESCRIPTION",
          message: "Enter what this line is for.",
        });
      }
      patch.description = description;
    }
    if (args.patch.plannedCents !== undefined) {
      assertPlannedCents(args.patch.plannedCents);
      patch.plannedCents = args.patch.plannedCents;
    }
    if (args.patch.categoryId !== undefined) {
      if (args.patch.categoryId !== null) {
        await verifyCategory(ctx, chapterId, args.patch.categoryId);
      }
      patch.categoryId = args.patch.categoryId ?? undefined;
    }
    await ctx.db.patch(args.lineId, patch);
    return null;
  },
});

export const removeLine = mutation({
  args: { lineId: v.id("budgetLines") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    const line = await ctx.db.get(args.lineId);
    if (!line) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Budget line not found." });
    }
    const budget = await loadOwningBudget(ctx, chapterId, line.budgetId);
    await requireLineWriteAccess(ctx, chapterId, budget);
    await ctx.db.delete(args.lineId);
    return null;
  },
});

/**
 * Reorder a budget's lines: the client sends the FULL set of line ids in the
 * new display order (a drag-reorder commit), and `sortOrder` is rewritten to
 * match the array index. Rejects a set that doesn't exactly match the
 * budget's current lines (no silent partial-reorder, no smuggling in another
 * budget's line).
 */
export const reorderLines = mutation({
  args: {
    budgetId: v.id("budgets"),
    orderedLineIds: v.array(v.id("budgetLines")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    const budget = await loadOwningBudget(ctx, chapterId, args.budgetId);
    await requireLineWriteAccess(ctx, chapterId, budget);

    const existing = await loadLines(ctx, args.budgetId);
    const existingIds = new Set(existing.map((l) => l._id as string));
    const wantIds = args.orderedLineIds.map((id) => id as string);
    const sameSet =
      wantIds.length === existing.length &&
      wantIds.every((id) => existingIds.has(id)) &&
      new Set(wantIds).size === wantIds.length;
    if (!sameSet) {
      throw new ConvexError({
        code: "INVALID_REORDER",
        message: "The reordered set must match this budget's current lines exactly.",
      });
    }
    for (let i = 0; i < args.orderedLineIds.length; i++) {
      const line = existing.find((l) => l._id === args.orderedLineIds[i]);
      if (line && line.sortOrder !== i) {
        await ctx.db.patch(line._id, { sortOrder: i });
      }
    }
    return null;
  },
});

/**
 * Human-confirmed dedup (PR6a): legacy data often contains a manual
 * `budgetLines` row that duplicates an `eventItems` cost row (the same
 * expense, entered twice to satisfy two different views before the event
 * cost grid unified them — `moneyViews.ts`'s `possibleDuplicate` heuristic
 * flags the collision but deliberately never auto-deletes; token overlap on a
 * label is too weak a signal to touch money rows unattended). This mutation
 * is the human's confirmation: fold ONE flagged line into the item it
 * duplicates.
 *
 * Effect is intentionally narrow — the item's own cost value (its module
 * `fields[costKey]`) is untouched and stays the planned amount; the line only
 * contributes its category (plan metadata the module side has no field for)
 * when the item doesn't already have one, then the line itself is deleted
 * (mirroring `removeLine`). No link is recorded anywhere — the `sourceRef`
 * link schema this mutation's own doc used to point at was retired (nothing
 * ever wrote it), so this mutation is the sole "same expense" reconciliation
 * mechanism, paired with the PlanGrid UI's "Merge into item" button.
 *
 * Gating requires BOTH: line-write access on the line's own budget
 * (`requireLineWriteAccess`, bookkeeper+ at the budget's scope — reused
 * as-is) AND event-edit access on the item's event (`requireEvent`, the same
 * gate `items.ts`'s own mutations call directly with no extra role check —
 * see `addEventItem`/`updateEventItem`). A caller who only clears one side is
 * rejected; a plan line and the item it's merging into can belong to
 * different roles' reach (a central-budget bookkeeper vs. a chapter's event
 * editor), so neither gate alone is sufficient.
 */
export const mergeLineIntoItem = mutation({
  args: {
    lineId: v.id("budgetLines"),
    itemId: v.id("eventItems"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;

    const line = await ctx.db.get(args.lineId);
    if (!line) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Budget line not found." });
    }
    const budget = await loadOwningBudget(ctx, chapterId, line.budgetId);
    await requireLineWriteAccess(ctx, chapterId, budget);

    const item = await ctx.db.get(args.itemId);
    if (!item) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Event item not found." });
    }
    const event = await requireEvent(ctx, item.eventId);

    // Sanity: a line can only merge into an item on ITS OWN event — the
    // line's budget must be a one_time EVENT budget scoped to this exact
    // event (rejects a recurring/central-category budget's line, a budget
    // scoped to a DIFFERENT event, and a project budget).
    if (budget.refKind !== "event" || budget.scopeRefId !== (event._id as string)) {
      throw new ConvexError({
        code: "EVENT_MISMATCH",
        message: "This plan line isn't on this item's event — it can't be merged here.",
      });
    }

    // The one cross-file write: patching eventItems' plan-view category from
    // budgetLines.ts is data, not code ownership (see PR6a scope note). Must
    // clear the SAME bar `items.ts#updateEventItem` enforces on this exact
    // field (tenancy AND active) — not just this file's own (tenancy-only)
    // `verifyCategory`, which governs a LINE's own categoryId, a looser
    // invariant than an ITEM's. Two proven exploit shapes without this:
    // (a) a central budget's line can carry a category from a DIFFERENT
    // chapter than the event's (verified against the CALLER's chapter at
    // add-time, not the event's), and (b) a category can be deactivated
    // after the line was created. Re-verify against the ITEM's own chapter
    // right here rather than trusting the line's stored categoryId.
    if (line.categoryId && !item.budgetCategoryId) {
      let categoryUsable = false;
      try {
        await verifyCategory(ctx, event.chapterId, line.categoryId);
        const category = await ctx.db.get(line.categoryId);
        categoryUsable = category?.isActive !== false;
      } catch {
        categoryUsable = false;
      }
      if (categoryUsable) {
        await ctx.db.patch(args.itemId, { budgetCategoryId: line.categoryId });
      }
      // A bad/foreign/inactive category shouldn't block the dedup — the
      // user's intent here is "merge this duplicate away", not "set this
      // category". Skip the copy, still delete the line below (matches
      // PR #232's drop-silently choice for an unusable category).
    }
    await ctx.db.delete(args.lineId);
    return null;
  },
});
