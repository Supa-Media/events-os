import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Budget — a typed, per-line budget for an event (Budget v1). A first-class
 * successor to the single whole-USD `events.budget` headline: each row is a
 * named budget LINE with a planned amount, an eventual actual, an optional
 * receipt, and a category. All money is a non-negative integer number of CENTS
 * (mirrors `donations` / `revenueCents`). The coarse header budget is left
 * untouched — this table coexists beside it (see docs/plans/budget.md).
 *
 * One `eventPages` row per event already carries the money that came IN
 * (`revenueCents` + `donationsCents`); `budget.budgetSummary` reads those to
 * reconcile spend against income. Line items only ever track money OUT.
 */

/** The category a budget line falls under (drives grouping + labels). */
export const BUDGET_CATEGORIES = [
  "venue",
  "production",
  "food",
  "marketing",
  "permits",
  "transport",
  "other",
] as const;

/** One line in an event's budget. Money is always non-negative integer cents. */
export const budgetLineItems = defineTable({
  eventId: v.id("events"),
  chapterId: v.id("chapters"),
  // Human label for the line ("PA rental", "Flyers", "Coffee").
  label: v.string(),
  category: v.union(...BUDGET_CATEGORIES.map((c) => v.literal(c))),
  // Budgeted amount (non-negative integer cents; 0 allowed).
  plannedCents: v.number(),
  // What it actually cost, once known (non-negative integer cents).
  actualCents: v.optional(v.number()),
  // An attached receipt (image / PDF) in Convex file storage.
  receiptStorageId: v.optional(v.id("_storage")),
  note: v.optional(v.string()),
  // Append order for a stable list.
  order: v.number(),
  createdBy: v.id("users"),
  createdAt: v.number(),
}).index("by_event", ["eventId"]);
