/**
 * Budget tab helpers — the category vocabulary (mirrors the `v.union` literals
 * in `apps/convex/schema/budget.ts`) and its display labels. Kept local to the
 * mobile side so the component tree doesn't reach into the Convex package for a
 * runtime constant; the two lists must stay in lock-step.
 */
import type { Doc } from "@events-os/convex/_generated/dataModel";

/** A budget line as returned by `budget.budgetSummary` (row + resolved receipt). */
export type BudgetLine = Doc<"budgetLineItems"> & { receiptUrl: string | null };

export type BudgetCategory = Doc<"budgetLineItems">["category"];

/** Category values, in display order — mirrors BUDGET_CATEGORIES in the schema. */
export const BUDGET_CATEGORY_VALUES: BudgetCategory[] = [
  "venue",
  "production",
  "food",
  "marketing",
  "permits",
  "transport",
  "other",
];

export const BUDGET_CATEGORY_LABELS: Record<BudgetCategory, string> = {
  venue: "Venue",
  production: "Production",
  food: "Food",
  marketing: "Marketing",
  permits: "Permits",
  transport: "Transport",
  other: "Other",
};

/** {value,label} options for the category `Select`. */
export const BUDGET_CATEGORY_OPTIONS = BUDGET_CATEGORY_VALUES.map((value) => ({
  value,
  label: BUDGET_CATEGORY_LABELS[value],
}));
