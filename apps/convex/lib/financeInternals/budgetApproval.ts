import { ConvexError } from "convex/values";
import { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import {
  CENTRAL,
  BUDGET_APPROVAL_STATUS_LABELS,
  type BudgetApprovalStatus,
} from "@events-os/shared";
import { requireInCallerChapter } from "./txnGuards";
import { requireChapterId } from "../context";
import {
  requireFinanceManager,
  requireCentralEdOrFm,
  resolveCallerPersonId,
} from "../finance";
import { holdsApprovalSeatAt } from "../seats";

/** Assert a budget's EFFECTIVE approval status permits `action`. */
export function assertBudgetTransition(
  current: BudgetApprovalStatus,
  allowedFrom: readonly BudgetApprovalStatus[],
  action: string,
): void {
  if (!allowedFrom.includes(current)) {
    throw new ConvexError({
      code: "ILLEGAL_TRANSITION",
      message: `Can't ${action} a budget that's ${BUDGET_APPROVAL_STATUS_LABELS[current]}.`,
    });
  }
}

/**
 * WP-wave4 (item 8-LOW, opus review 2026-07-17): append one durable row to
 * `budgetApprovalLog` — the permanent record `budgets`' own last-decision-only
 * fields (`approvalParty`, `approvedByPersonId`/`approvedAt`,
 * `submittedByPersonId`/`submittedAt`) can never be (each gets overwritten by
 * the next decision, and `moveBudgetScope` resets them on a scope move).
 * Called from `submitBudgetForApproval`/`approveBudget`/`requestBudgetChanges`
 * ONLY — never updated or deleted afterward by anything, including
 * `moveBudgetScope`/`deleteBudget` (a budget's history outlives the row).
 */
export async function logBudgetDecision(
  ctx: MutationCtx,
  budgetId: Id<"budgets">,
  action: "sent" | "approved" | "changes_requested",
  decidedByPersonId: Id<"people">,
  extra: { party?: "single" | "two_party"; note?: string } = {},
): Promise<void> {
  await ctx.db.insert("budgetApprovalLog", {
    budgetId,
    action,
    decidedByPersonId,
    decidedAt: Date.now(),
    ...extra,
  });
}

/** Load a budget for an approve/request-changes decision: resolve the
 *  caller's chapter + identity, verify the budget is visible to them, and
 *  gate on the APPROVER capability for its scope (chapter manager rank OR a
 *  chapter `finance.approve` seat, or central ED/FM). Shared by
 *  `approveBudget` + `requestBudgetChanges` so the two decisions can never
 *  gate differently. */
export async function loadBudgetForApprovalDecision(
  ctx: MutationCtx,
  budgetId: Id<"budgets">,
): Promise<{ budget: Doc<"budgets">; callerPersonId: Id<"people"> }> {
  const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
  const budget = await requireInCallerChapter(
    ctx,
    chapterId,
    "budgets",
    budgetId,
    "Budget",
    { allowCentral: true },
  );
  const callerPersonId = await resolveCallerPersonId(ctx, chapterId);
  if (budget.chapterId === CENTRAL) {
    await requireCentralEdOrFm(ctx);
  } else {
    // `requireInCallerChapter` above already proved `budget.chapterId ===
    // chapterId` (the caller's OWN chapter) or threw NOT_FOUND — so a
    // Chapter Director seated at a DIFFERENT chapter never reaches this
    // branch with a matching scope to check. EITHER path clears the gate:
    // manager rank (Treasurer, unchanged) OR a `finance.approve` seat here
    // (Chapter Director — the owner-mandated fix).
    const hasApprovalSeat = await holdsApprovalSeatAt(
      ctx,
      callerPersonId,
      chapterId,
    );
    if (!hasApprovalSeat) {
      await requireFinanceManager(ctx, chapterId);
    }
  }
  return { budget, callerPersonId };
}
