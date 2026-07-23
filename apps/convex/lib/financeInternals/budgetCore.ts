import { Doc, Id } from "../../_generated/dataModel";
import {
  CENTRAL,
  BUDGET_TYPE_LABELS,
  effectiveBudgetApprovalStatus,
  quarterOfMonth,
  type BudgetType,
  type BudgetRefKind,
} from "@events-os/shared";
import { isSpend, inPeriod } from "./txnGuards";

/**
 * WP-3.2: the approval-workflow fields shared by every budget card projection
 * (`toBudgetSummary` + the dashboard's project/recurring/central cards). Always
 * the EFFECTIVE status (grandfathered legacy rows read as `"approved"`) — see
 * `effectiveBudgetApprovalStatus`. `requestedCents` is the RAW `amountCents` —
 * kept alongside the (now cap-driven) `budgetCents` a card computes for its own
 * pct/remaining/status, so `BudgetApprovalChip` can still show BOTH numbers
 * ("approved at $X, requested $Y") while an increase is pending.
 */
export function budgetApprovalCardFields(b: Doc<"budgets">) {
  return {
    approvalStatus: effectiveBudgetApprovalStatus(b.approvalStatus),
    approvedCents: b.approvedCents ?? null,
    reviewNote: b.reviewNote ?? null,
    requestedCents: b.amountCents,
    approvalParty: b.approvalParty ?? null,
  };
}

/**
 * WP-3.2 review (B1): THE cap every numeric budget surface computes against —
 * pct, remaining, status, and every card/bar/rollup's `budgetCents`. A budget
 * currently `"submitted"`, `"changes_requested"`, OR (WP-wave4 item 3) a
 * DRAFT INCREASE (`"draft"` WITH a recorded `approvedCents` — see
 * `setBudgetAmount`'s retrigger doc) reports that still-in-force `approvedCents`
 * cap (an increase past it is pending review/send, never advertised as
 * already available); every other case (a brand-new draft with no prior
 * approval, plainly approved, or a grandfathered legacy row with no literal
 * status) reports the plain `amountCents`. A brand-new draft never has
 * `approvedCents` set (only `approveBudget`/the retrigger ever stamp it), so
 * the `b.approvedCents != null` guard is what tells the two `"draft"` cases
 * apart. Grandfathered rows need no special case here — they carry no
 * `approvalStatus` at all, so they never match until `setBudgetAmount`'s
 * retrigger rule (I1) stamps one explicitly on their first increase.
 *
 * Checks the RAW `approvalStatus` (not `effectiveBudgetApprovalStatus`) —
 * deliberately: the effective mapping only ever renames "absent" to
 * `"approved"`, so it can never itself equal `"submitted"`/`"changes_requested"`/
 * `"draft"`.
 */
export function effectiveCapCents(b: Doc<"budgets">): number {
  if (
    (b.approvalStatus === "submitted" ||
      b.approvalStatus === "changes_requested" ||
      b.approvalStatus === "draft") &&
    b.approvedCents != null
  ) {
    return b.approvedCents;
  }
  return b.amountCents;
}

/**
 * WP-wave4 (item 5 — owner addendum, 2026-07-17): "is there a reason why I
 * can attach a charge to a project with no budget yet? We should only be
 * able to add it for approved budgets." A budget is ATTRIBUTABLE — offerable
 * by the "For" picker (`forPickerOptions`, `reconcileSuggest.ts`'s
 * independent `rankForPicker` scan) and acceptable to
 * `categorizeTransaction`/`bulkCategorize`/`createManualTransaction` — only
 * once `effectiveBudgetApprovalStatus(b.approvalStatus) === "approved"`. A
 * GRANDFATHERED legacy budget (`approvalStatus` absent) counts as approved
 * per that function's own normalization (it maps "absent" to `"approved"`,
 * never anything else), so pre-WP-3.2 budgets attribute exactly as they
 * always could. A `"draft"`, `"submitted"`, or `"changes_requested"` budget —
 * including a DRAFT INCREASE (still `"draft"`, WP-wave4 item 3) — is NOT
 * attributable: draft → send → approve is now the only path to one.
 *
 * The SINGLE gate both the picker (read-side, filters silently) and the
 * write-side mutations (throw) share, so they can never drift on which refs
 * are offerable vs. acceptable.
 */
export function isAttributableBudget(b: Doc<"budgets"> | null | undefined): b is Doc<"budgets"> {
  return b != null && effectiveBudgetApprovalStatus(b.approvalStatus) === "approved";
}

/** A budget's display name: its own label, else its type word — the same
 *  fallback the mobile `budgetName()` helper uses (kept as one twinned rule,
 *  not two). Used by the "For" picker's Recurring group + the AI suggestion's
 *  resolved budget name. */
export function budgetDisplayName(b: Doc<"budgets">): string {
  return b.label?.trim() || BUDGET_TYPE_LABELS[effectiveType(b)];
}

/**
 * The period a budget's spend is measured over, resolved against the dashboard's
 * `contextMonth`. A MONTHLY budget stored as "$2,000/mo" carries no `month`, so
 * without this it would (wrongly) match all 12 months — its spend is scoped to
 * the queried month. Quarterly → the quarter of the queried month; yearly → the
 * whole year; per-instance / one-off use the budget's OWN declared month/quarter
 * when it has one — and otherwise ALSO fall back to `contextMonth`, exactly like
 * the monthly branch: a one-time budget with no stored `month` (a leader can
 * create one via `createBudget` without picking one) is not "every month, all
 * year" any more than a month-less recurring budget is — without this fallback
 * its spend would double-count into every month's aggregate (tag rollups,
 * `budgetVsActual`, central budget cards). NOT used at all for a one-time
 * dashboard CARD's own bar (chapter or central) — that's a genuinely lifetime
 * total, ignoring even the budget's OWN declared month/quarter; see
 * `oneTimeCardBreakdown`, which never calls this function.
 */
export function budgetEffectivePeriod(
  b: Doc<"budgets">,
  contextMonth?: number,
): { year: number; month?: number; quarter?: number } {
  const year = b.year;
  switch (b.cadence) {
    case "monthly": {
      const month = b.month ?? contextMonth;
      return month != null ? { year, month } : { year };
    }
    case "quarterly": {
      const quarter =
        b.quarter ?? (contextMonth != null ? quarterOfMonth(contextMonth) : undefined);
      return quarter != null ? { year, quarter } : { year };
    }
    case "yearly":
      return { year };
    case "per_instance":
    case "one_off":
    default: {
      const month = b.month ?? contextMonth;
      return { year, month: month ?? undefined, quarter: b.quarter ?? undefined };
    }
  }
}

/**
 * A budget's v2 `type`, tolerant of un-migrated legacy rows: a row without a
 * `type` yet derives one from its legacy `scope` (event/project → one_time,
 * everything else → recurring), so dashboards keep working before the backfill.
 */
export function effectiveType(b: Doc<"budgets">): BudgetType {
  if (b.type) return b.type;
  return b.scope === "event" || b.scope === "project" ? "one_time" : "recurring";
}

/** A one_time budget's ref kind, deriving from legacy `scope` when unset.
 *  Exported for the `0027_sync_linked_budget_identity` migration, which
 *  needs to find every effectively-linked budget, tolerant of un-migrated
 *  legacy rows the same way every other v2 reader is. */
export function effectiveRefKind(b: Doc<"budgets">): BudgetRefKind | null {
  if (b.refKind) return b.refKind;
  if (b.scope === "event") return "event";
  if (b.scope === "project") return "project";
  return null;
}

/**
 * The single budget-attribution rule, used by EVERY actuals sum so a dollar is
 * counted the same way everywhere: a txn counts toward a budget IFF it is
 * EXPLICITLY linked to it (`budgetId === b._id`) — no derived (fund/category/
 * team/event/project) matching. An unlinked txn counts toward NO budget; it
 * shows up as "Unattributed" instead (see `dashboardChapter.unattributedCents`).
 *
 * This is a straight port of the linked-only rule tag rollups already used —
 * made universal so a broad recurring budget with no narrowers can no longer
 * vacuum up every uncategorized txn in its period (the "Education & Growth
 * eats everything" bug).
 *
 * The budget's own cadence still determines the period window: a March
 * purchase linked to a MONTHLY budget lands in March (not every month), a
 * project/one-off budget counts over its declared period, and an event/
 * per_instance budget only within that instance. Without this the central
 * roll-up (read across all time via `by_budget`) would sum lifetime spend
 * instead of the queried period.
 *
 * The `isSpend` gate applies here too, so `transfer` / `excluded` / personal
 * rows stay out of every budget total even when explicitly linked (the
 * flow-carries-direction + transfer-excluded invariants hold regardless of an
 * explicit link).
 */
export function txnCountsTowardBudget(
  tr: Doc<"transactions">,
  b: Doc<"budgets">,
  contextMonth?: number,
): boolean {
  if (!isSpend(tr) || tr.budgetId !== b._id) return false;
  const period = budgetEffectivePeriod(b, contextMonth);
  return inPeriod(tr.postedAt, period.year, period.month, period.quarter);
}

/** A budget's LEVEL: a real chapter id, or the CENTRAL sentinel. */
export type BudgetLevel = Id<"chapters"> | typeof CENTRAL;

/**
 * True iff a tag at `tagLevel` may be attached to a budget at `budgetLevel`:
 * a chapter budget accepts its own chapter's tags OR central tags; a central
 * budget accepts only central tags.
 */
export function tagLevelAllowed(tagLevel: BudgetLevel, budgetLevel: BudgetLevel): boolean {
  if (budgetLevel === CENTRAL) return tagLevel === CENTRAL;
  return tagLevel === budgetLevel || tagLevel === CENTRAL;
}
