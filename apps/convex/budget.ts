/**
 * Budget — a typed, per-line budget for an event (Budget v1).
 *
 * All money is a non-negative integer number of CENTS (mirrors `giving.ts`).
 * Every function is chapter-scoped: `requireEvent` for event-addressed calls,
 * `requireOwned("budgetLineItems")` for by-id ones — so a non-member, a
 * logged-out caller, and a cross-chapter admin are all rejected before any I/O.
 *
 * This module is NON-DISRUPTIVE to the coarse `events.budget` header gauge: it
 * never reads or writes it. `budgetSummary` only READS the money-IN rollups
 * (`eventPages.revenueCents` + `donationsCents`) to reconcile spend vs income.
 *
 * NOTE: NOT a `"use node"` file — plain queries + mutations only.
 */
import { mutation, query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { Id } from "./_generated/dataModel";
import { requireEvent, requireOwned, requireUserId } from "./lib/context";
import { BUDGET_CATEGORIES } from "./schema/budget";

// ── Validators / guards ───────────────────────────────────────────────────────

/** Category validator, derived from the single source of truth in the schema. */
const categoryValidator = v.union(
  ...BUDGET_CATEGORIES.map((c) => v.literal(c)),
);

/**
 * Guard: a cents amount is a whole number of cents that is NOT negative. Unlike
 * giving's `assertPositiveCents`, 0 is allowed — a budget line can be planned at
 * $0 (a freebie held on the plan) or reconciled to an actual of $0.
 */
function assertNonNegativeCents(amountCents: number): void {
  if (amountCents < 0 || !Number.isInteger(amountCents)) {
    throw new ConvexError({
      code: "INVALID_AMOUNT",
      message: "Amount must be a whole number of cents (zero or more).",
    });
  }
}

// ── Mutations ─────────────────────────────────────────────────────────────────

/** Add a budget line to an event. `order` appends to the end of the list. */
export const addLineItem = mutation({
  args: {
    eventId: v.id("events"),
    label: v.string(),
    category: categoryValidator,
    plannedCents: v.number(),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const event = await requireEvent(ctx, args.eventId);
    const userId = await requireUserId(ctx);
    assertNonNegativeCents(args.plannedCents);
    const label = args.label.trim();
    if (!label) {
      throw new ConvexError({
        code: "INVALID_INPUT",
        message: "A budget line needs a label.",
      });
    }

    // Append: order = current count. Bounded read (a budget is a handful of
    // lines, never unbounded like a public ledger).
    const existing = await ctx.db
      .query("budgetLineItems")
      .withIndex("by_event", (q) => q.eq("eventId", args.eventId))
      .collect();

    return await ctx.db.insert("budgetLineItems", {
      eventId: args.eventId,
      chapterId: event.chapterId,
      label,
      category: args.category,
      plannedCents: args.plannedCents,
      note: args.note?.trim() || undefined,
      order: existing.length,
      createdBy: userId as Id<"users">,
      createdAt: Date.now(),
    });
  },
});

/**
 * Edit a budget line. Every field is optional; `actualCents` and `note` accept
 * an explicit `null` to CLEAR them (distinct from "leave unchanged" = omit).
 * Any cents present is validated non-negative int.
 */
export const updateLineItem = mutation({
  args: {
    lineItemId: v.id("budgetLineItems"),
    label: v.optional(v.string()),
    category: v.optional(categoryValidator),
    plannedCents: v.optional(v.number()),
    actualCents: v.optional(v.union(v.number(), v.null())),
    note: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    await requireOwned(ctx, "budgetLineItems", args.lineItemId, "Budget line");

    const patch: Record<string, unknown> = {};
    if (args.label !== undefined) {
      const label = args.label.trim();
      if (!label) {
        throw new ConvexError({
          code: "INVALID_INPUT",
          message: "A budget line needs a label.",
        });
      }
      patch.label = label;
    }
    if (args.category !== undefined) patch.category = args.category;
    if (args.plannedCents !== undefined) {
      assertNonNegativeCents(args.plannedCents);
      patch.plannedCents = args.plannedCents;
    }
    if (args.actualCents !== undefined) {
      if (args.actualCents !== null) assertNonNegativeCents(args.actualCents);
      patch.actualCents = args.actualCents ?? undefined;
    }
    if (args.note !== undefined) {
      patch.note = args.note === null ? undefined : args.note.trim() || undefined;
    }

    await ctx.db.patch(args.lineItemId, patch);
    return null;
  },
});

/** Attach (or clear, with null) a receipt on a budget line. */
export const setReceipt = mutation({
  args: {
    lineItemId: v.id("budgetLineItems"),
    receiptStorageId: v.union(v.id("_storage"), v.null()),
  },
  handler: async (ctx, { lineItemId, receiptStorageId }) => {
    await requireOwned(ctx, "budgetLineItems", lineItemId, "Budget line");
    await ctx.db.patch(lineItemId, {
      receiptStorageId: receiptStorageId ?? undefined,
    });
    return null;
  },
});

/** Remove a budget line. */
export const removeLineItem = mutation({
  args: { lineItemId: v.id("budgetLineItems") },
  handler: async (ctx, { lineItemId }) => {
    await requireOwned(ctx, "budgetLineItems", lineItemId, "Budget line");
    await ctx.db.delete(lineItemId);
    return null;
  },
});

// ── Query ─────────────────────────────────────────────────────────────────────

/**
 * The whole budget for an event: the line items (in order, each with its
 * receipt URL resolved) plus the rolled-up totals and the money-IN
 * reconciliation. One `budgetLineItems` read + one `eventPages` read.
 *
 *   plannedCents = Σ line.plannedCents
 *   actualCents  = Σ (line.actualCents ?? 0)
 *   incomeCents  = (page.revenueCents ?? 0) + (page.donationsCents ?? 0)   [0 if no page]
 *   netCents     = incomeCents - actualCents   (surplus > 0, over-budget < 0)
 */
export const budgetSummary = query({
  args: { eventId: v.id("events") },
  handler: async (ctx: QueryCtx, { eventId }) => {
    await requireEvent(ctx, eventId);

    const rows = await ctx.db
      .query("budgetLineItems")
      .withIndex("by_event", (q) => q.eq("eventId", eventId))
      .collect();
    rows.sort((a, b) => a.order - b.order);

    const lineItems = await Promise.all(
      rows.map(async (row) => ({
        ...row,
        receiptUrl: row.receiptStorageId
          ? await ctx.storage.getUrl(row.receiptStorageId)
          : null,
      })),
    );

    const plannedCents = rows.reduce((sum, r) => sum + r.plannedCents, 0);
    const actualCents = rows.reduce((sum, r) => sum + (r.actualCents ?? 0), 0);

    // Money IN — reconcile against ticket revenue + donations (one page/event).
    const page = await ctx.db
      .query("eventPages")
      .withIndex("by_event", (q) => q.eq("eventId", eventId))
      .unique();
    const incomeCents = (page?.revenueCents ?? 0) + (page?.donationsCents ?? 0);

    return {
      lineItems,
      plannedCents,
      actualCents,
      incomeCents,
      netCents: incomeCents - actualCents,
    };
  },
});
