import { ConvexError } from "convex/values";
import { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { CENTRAL, financeRoleAtLeast, FINANCE_ROLE_LABELS } from "@events-os/shared";
import { requireInCallerChapter } from "./txnGuards";
import { isAttributableBudget, budgetDisplayName } from "./budgetCore";
import { callerHasEventEditRights } from "../org";
import { requireChapterId } from "../context";
import { requireFinanceCentral, requireFinanceRole, type FinanceScope } from "../finance";

/**
 * Assert `budgetId` is attributable (`isAttributableBudget`) — the WRITE-side
 * half of the item-5 gate. Every transaction-attribution mutation calls this
 * (`categorizeTransaction`, `bulkCategorize`, `createManualTransaction`) —
 * never a chapter/central-scope check (that's `requireInCallerChapter`'s job,
 * called separately at each site); this is purely the approval-status axis.
 * A rejected attribution leaves the transaction exactly where it was — still
 * in the loud "Needs budget" bucket (`unattributedCents`/`needs_budget`
 * filter), the intended holding state until its target budget clears review.
 */
export async function assertBudgetApprovedForAttribution(
  ctx: QueryCtx,
  budgetId: Id<"budgets">,
): Promise<void> {
  const budget = await ctx.db.get(budgetId);
  if (!budget) {
    throw new ConvexError({ code: "NOT_FOUND", message: "Budget not found." });
  }
  if (!isAttributableBudget(budget)) {
    throw new ConvexError({
      code: "BUDGET_NOT_APPROVED",
      message: `"${budgetDisplayName(budget)}" isn't approved yet — only approved budgets can have charges attached. It'll stay in Needs Budget until it's approved.`,
    });
  }
}

/** Verify the optional operational-link ids on a transaction write. */
export async function verifyTxnRefs(
  ctx: MutationCtx,
  chapterId: Id<"chapters">,
  refs: {
    fundId?: Id<"funds"> | null;
    categoryId?: Id<"budgetCategories"> | null;
    teamId?: Id<"financeTeams"> | null;
    personId?: Id<"people"> | null;
  },
): Promise<void> {
  if (refs.fundId) await requireInCallerChapter(ctx, chapterId, "funds", refs.fundId, "Fund");
  if (refs.categoryId)
    await requireInCallerChapter(ctx, chapterId, "budgetCategories", refs.categoryId, "Category");
  if (refs.teamId)
    await requireInCallerChapter(ctx, chapterId, "financeTeams", refs.teamId, "Team", {
      allowCentral: true,
    });
  if (refs.personId)
    await requireInCallerChapter(ctx, chapterId, "people", refs.personId, "Person");
}

/**
 * Load a transaction for a RECONCILE WRITE and authorize the caller at the
 * txn's own scope (WP-2.1). A chapter-owned txn requires the caller's `min`
 * finance role in that chapter (unchanged from `requireInCallerChapter`); a
 * CENTRAL-owned txn (`chapterId:"central"`) requires central reach
 * (`requireFinanceCentral`) AND the same `min` role rank — `requireFinanceCentral`
 * only checks central REACH (any central grant, including a viewer-only one),
 * so without the extra rank check a central-scoped VIEWER could perform
 * reconcile writes on central txns while a chapter viewer is correctly
 * blocked. Returns the txn, the caller's home chapter (for fund defaults
 * etc.), and the txn's `FinanceScope`. Mirrors how `dashboardChapter`'s
 * optional-chapterId drill-down re-checks central reach (#131).
 */
export async function requireReconcileTxn(
  ctx: MutationCtx,
  transactionId: Id<"transactions">,
  min: "viewer" | "bookkeeper" | "manager",
): Promise<{ txn: Doc<"transactions">; homeChapterId: Id<"chapters">; scope: FinanceScope }> {
  const homeChapterId = (await requireChapterId(ctx)) as Id<"chapters">;
  const txn = (await ctx.db.get(transactionId)) as Doc<"transactions"> | null;
  const notFound = () =>
    new ConvexError({ code: "NOT_FOUND", message: "Transaction not found in your chapter." });
  if (!txn) throw notFound();
  if (txn.chapterId === CENTRAL) {
    const access = await requireFinanceCentral(ctx, homeChapterId);
    if (!financeRoleAtLeast(access.role, min)) {
      throw new ConvexError({
        code: "FORBIDDEN",
        message: `This action needs at least the ${FINANCE_ROLE_LABELS[min]} finance role.`,
      });
    }
    return { txn, homeChapterId, scope: CENTRAL };
  }
  await requireFinanceRole(ctx, homeChapterId, min);
  if (txn.chapterId !== homeChapterId) throw notFound();
  return { txn, homeChapterId, scope: txn.chapterId };
}

/**
 * The single EVENT a transaction's budget is scoped to, if any — `null` for
 * a txn attributed to no budget, or one whose budget isn't a one_time EVENT
 * budget (a project/recurring/central budget has no single event to scope an
 * "event lead" gate to). Used ONLY by the note/receipt/category scoped
 * carve-out below — never widens what a project's or a recurring budget's
 * txns are reachable by. Checks `type === "one_time"` alongside
 * `refKind === "event"` — today every `refKind:"event"` budget is also
 * `type:"one_time"` (a real event has no OTHER reason to carry `refKind`),
 * so this is defensive belt-and-suspenders against that schema invariant
 * ever drifting, not a behavior change against current data (Opus review,
 * PR #218).
 */
export async function eventForTxn(
  ctx: MutationCtx,
  txn: Doc<"transactions">,
): Promise<Doc<"events"> | null> {
  if (!txn.budgetId) return null;
  const budget = await ctx.db.get(txn.budgetId);
  if (
    !budget ||
    budget.type !== "one_time" ||
    budget.refKind !== "event" ||
    !budget.scopeRefId
  ) {
    return null;
  }
  return await ctx.db.get(budget.scopeRefId as Id<"events">);
}

/**
 * NOTE / RECEIPT / CATEGORY scoped gate (owner decision, 2026-07-17,
 * verbatim: "they shouldn't be able to change the budget bucket, but they
 * should be able to do everything else like write notes, add receipts,
 * change the category etc"). A caller with EVENT EDIT rights
 * (`callerHasEventEditRights` — the event's owner/lead, or a chapter admin)
 * may act on a transaction attributed to THEIR OWN event's budget, for
 * note/receipt/category ONLY. Reattribution (`budgetId`/`fundId`/`teamId`),
 * amount, and status are NEVER reachable through this gate — those stay
 * `categorizeTransaction`'s/the reconcile grid's bookkeeper+-only territory,
 * completely untouched by this addition.
 *
 * PURE ADDITIVE — the existing finance-role path (`requireReconcileTxn`,
 * bookkeeper+, central-aware) is tried FIRST and, on success, returns
 * immediately with the finance rank's UNCHANGED existing power; the event-
 * lead carve-out is only ever consulted once that path has already failed,
 * so no finance-role caller's reach can shrink because of this gate.
 */
export async function requireTxnNoteReceiptCategoryAccess(
  ctx: MutationCtx,
  transactionId: Id<"transactions">,
): Promise<{ txn: Doc<"transactions">; viaFinance: boolean }> {
  try {
    const { txn } = await requireReconcileTxn(ctx, transactionId, "bookkeeper");
    return { txn, viaFinance: true };
  } catch (err) {
    if (!(err instanceof ConvexError)) throw err;
    // Fall through — the caller isn't bookkeeper+ (or has no home chapter at
    // all); try the event-lead scoped carve-out below before giving up.
  }
  const txn = (await ctx.db.get(transactionId)) as Doc<"transactions"> | null;
  if (!txn) {
    throw new ConvexError({ code: "NOT_FOUND", message: "Transaction not found." });
  }
  const event = await eventForTxn(ctx, txn);
  if (event && (await callerHasEventEditRights(ctx, event))) {
    return { txn, viaFinance: false };
  }
  throw new ConvexError({
    code: "FORBIDDEN",
    message:
      "This action needs a finance role, or edit rights on the event this transaction belongs to.",
  });
}
