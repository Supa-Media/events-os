import { Doc, Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";
import { CENTRAL, BUDGET_TAG_KINDS, type BudgetRefKind } from "@events-os/shared";
import { budgetApprovalCardFields, effectiveType, effectiveRefKind } from "./budgetCore";
import { needsBudget, isSpend } from "./txnGuards";
import { ROLLUP_SCAN_LIMIT } from "./constants";

export function toCategorySummary(c: Doc<"budgetCategories">) {
  return {
    id: c._id,
    fundId: c.fundId,
    parentCategoryId: c.parentCategoryId ?? null,
    name: c.name,
    kind: c.kind,
    sortOrder: c.sortOrder ?? 0,
    isActive: c.isActive ?? true,
  };
}

export function toTeamSummary(tm: Doc<"financeTeams">) {
  return {
    id: tm._id,
    name: tm.name,
    sortOrder: tm.sortOrder,
    isActive: tm.isActive ?? true,
  };
}

export function toBudgetSummary(
  b: Doc<"budgets">,
  tags: { id: Id<"budgetTags">; name: string; kind: (typeof BUDGET_TAG_KINDS)[number] | null }[],
) {
  return {
    id: b._id,
    amountCents: b.amountCents,
    label: b.label ?? null,
    type: effectiveType(b),
    refKind: effectiveRefKind(b),
    scope: b.scope ?? null,
    scopeRefId: b.scopeRefId ?? null,
    cadence: b.cadence,
    year: b.year,
    month: b.month ?? null,
    quarter: b.quarter ?? null,
    fundId: b.fundId ?? null,
    categoryId: b.categoryId ?? null,
    teamId: b.teamId ?? null,
    tags,
    level: b.chapterId === CENTRAL ? ("central" as const) : ("chapter" as const),
    ...budgetApprovalCardFields(b),
  };
}

export function toTxnSummary(tr: Doc<"transactions">) {
  return {
    id: tr._id,
    postedAt: tr.postedAt,
    amountCents: tr.amountCents,
    flow: tr.flow,
    status: tr.status,
    description: tr.description ?? null,
    merchantName: tr.merchantName ?? null,
    note: tr.note ?? null,
    fundId: tr.fundId ?? null,
    categoryId: tr.categoryId ?? null,
    budgetId: tr.budgetId ?? null,
    needsBudget: needsBudget(tr),
    hasReceipt: tr.receiptStorageId != null,
    cardLast4: tr.cardLast4 ?? null,
    reminderStage: tr.receiptReminderStage ?? ("none" as const),
  };
}

/**
 * `personTransactions`'s per-row projection: `toTxnSummary`, with `note`
 * nulled out UNLESS `tr` belongs to the viewer's own person. `viewerPersonId`
 * is the CALLER's own resolved person (`self._id`), not the `personId` being
 * queried — `personTransactions` also serves the finance-role "look up a
 * different person's transactions" audit path (see its doc comment), and
 * that path must never leak the bookkeeper's note through this endpoint even
 * though every row in a given call shares one `personId`. Checked per-row
 * (not once for the whole response) so this stays correct if the query is
 * ever broadened to return rows for more than one person at a time.
 */
export function toMemberTxnSummary(
  tr: Doc<"transactions">,
  viewerPersonId: Id<"people"> | null,
) {
  const summary = toTxnSummary(tr);
  const isOwn = viewerPersonId != null && tr.personId === viewerPersonId;
  return { ...summary, note: isOwn ? summary.note : null };
}

export function toBudgetTagSummary(t: Doc<"budgetTags">) {
  return {
    id: t._id,
    name: t.name,
    kind: t.kind ?? null,
    refId: t.refId ?? null,
    level: t.chapterId === CENTRAL ? ("central" as const) : ("chapter" as const),
  };
}

/**
 * Actual spend for an event/project ref, BUDGET-FIRST (WP-U: one home per
 * dollar) — found via `by_ref` (EVERY one_time budget for this ref, wherever
 * each currently lives) then summed via `by_budget` across ALL of them,
 * exactly like the dashboard's `txnCountsTowardBudget*` rollups. A ref should
 * only ever have one budget (the D8 invariant, now enforced at creation by
 * `createBudget`'s dedup guard), but `by_ref` still unions every matching
 * budget rather than taking the first — legacy data can carry a duplicate
 * from before that guard existed (see `migrateLinksToBudgets`'s conflict
 * path), and undercounting a ref's actuals because of a stale duplicate is
 * worse than the extra bounded read. A ref with no budget yet reports zero
 * spend and no rows — it's never been attributed to (the "For" picker summons
 * a budget the first time a caller attributes a transaction to it).
 */
export async function actualsForRef(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
  refKind: BudgetRefKind,
  scopeRefId: string,
): Promise<{ totalCents: number; transactions: ReturnType<typeof toTxnSummary>[] }> {
  const budgets = await ctx.db
    .query("budgets")
    .withIndex("by_ref", (q) => q.eq("refKind", refKind).eq("scopeRefId", scopeRefId))
    .take(ROLLUP_SCAN_LIMIT);
  if (budgets.length === 0) return { totalCents: 0, transactions: [] };
  const rowsByBudget = await Promise.all(
    budgets.map((b) =>
      ctx.db
        .query("transactions")
        .withIndex("by_budget", (q) => q.eq("budgetId", b._id))
        .take(ROLLUP_SCAN_LIMIT),
    ),
  );
  const raw = rowsByBudget.flat();
  // Defense-in-depth: never sum a row from another chapter even if a future
  // link slipped through. A chapter caller only ever sees actuals scoped to
  // ITS OWN chapter — once `transferProjectScope` moves a project's budget AND
  // linked transactions to central together, they drop out of the origin
  // chapter's actuals here exactly as they would have before this PR.
  const rows = raw.filter((tr) => tr.chapterId === chapterId);
  const totalCents = rows.reduce((s, tr) => (isSpend(tr) ? s + tr.amountCents : s), 0);
  return { totalCents, transactions: rows.map(toTxnSummary) };
}
