/**
 * BUDGET DETAIL — the shareable, deep-linkable "open one budget" surface
 * (`apps/mobile/app/(app)/finances/budgets/[id].tsx`). Tapping a budget row's
 * body on the finance dashboard now navigates HERE instead of straight into
 * `BudgetCreateModal` — this page is the read surface (header, plan-vs-
 * actuals, category breakdown, linked transactions, approval history); the
 * modal is reached from this page's own "Edit" button.
 *
 * Deliberately a NEW file, not an addition to `finances.ts` (that file is
 * mid-refactor in a concurrent PR) — mirrors `dashboardCharts.ts`'s own
 * precedent of a sibling file built from `finances.ts`'s EXPORTED primitives
 * (`isSpend`, `txnMatchesMode`, `effectiveCapCents`, `effectiveType`,
 * `effectiveRefKind`, `ROLLUP_SCAN_LIMIT`) rather than re-deriving semantics
 * or reaching for anything unexported there.
 *
 * ACTUALS ARE LIFETIME, not period-scoped: unlike the dashboard's cards
 * (which narrow a recurring budget to its current cadence window), this
 * detail page is a durable record of ONE budget, so `spentCents`/the
 * category breakdown/the transactions list sum EVERY transaction ever
 * explicitly linked via `budgetId` — the same lifetime rule
 * `finances.ts#oneTimeCardBreakdown` already applies to one-time budgets,
 * extended here to recurring budgets too (a deliberate simplification for a
 * "the whole story of this budget" page, not a bug — see the PR description).
 *
 * Gate: the SAME tenancy + role check every other single-budget read in this
 * codebase uses (`dashboardCharts.budgetTransactions`'s own doc comment) —
 * the budget's own chapter at `viewer` rank, or central reach through the
 * caller's own home chapter for a budget owned by a different chapter or by
 * `"central"`.
 */
import { ConvexError, v } from "convex/values";
import { query } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import {
  CENTRAL,
  BUDGET_TYPE_LABELS,
  BUDGET_CADENCES,
  BUDGET_TYPES,
  BUDGET_REF_KINDS,
  BUDGET_APPROVAL_STATUSES,
  TRANSACTION_FLOWS,
  TRANSACTION_STATUSES,
  effectiveBudgetApprovalStatus,
} from "@events-os/shared";
import { getChapterIdOrNull } from "./lib/context";
import { requireFinanceRole, requireFinanceCentral, type FinanceAccess } from "./lib/finance";
import { readSandbox } from "./financeSettings";
import {
  isSpend,
  txnMatchesMode,
  effectiveCapCents,
  effectiveType,
  effectiveRefKind,
  ROLLUP_SCAN_LIMIT,
} from "./finances";

const typeValidator = v.union(...BUDGET_TYPES.map((t) => v.literal(t)));
const cadenceValidator = v.union(...BUDGET_CADENCES.map((c) => v.literal(c)));
const refKindValidator = v.union(...BUDGET_REF_KINDS.map((k) => v.literal(k)));
const approvalStatusValidator = v.union(
  ...BUDGET_APPROVAL_STATUSES.map((s) => v.literal(s)),
);

/** `YYYY-MM-DD` in America/New_York — mirrors `finances.ts#easternDateStr`
 *  (unexported there; this is a deliberate, tiny, one-line duplicate rather
 *  than reaching into that file's private surface). */
function easternDateStr(ts: number): string {
  return new Date(ts).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

/** Integer percent spent-of-cap — mirrors `finances.ts#pctOf` (unexported). */
function pctOf(spent: number, cap: number): number {
  if (cap <= 0) return spent > 0 ? 100 : 0;
  return Math.round((spent / cap) * 100);
}

const categoryBreakdownRow = v.object({
  name: v.string(),
  spentCents: v.number(),
  barPct: v.number(),
});

const txnFlowValidator = v.union(...TRANSACTION_FLOWS.map((f) => v.literal(f)));
const txnStatusValidator = v.union(...TRANSACTION_STATUSES.map((s) => v.literal(s)));

const txnRow = v.object({
  id: v.id("transactions"),
  date: v.number(),
  description: v.union(v.string(), v.null()),
  merchantName: v.union(v.string(), v.null()),
  amountCents: v.number(),
  flow: txnFlowValidator,
  categoryName: v.union(v.string(), v.null()),
  personName: v.union(v.string(), v.null()),
  hasReceipt: v.boolean(),
  status: txnStatusValidator,
});

// A UI list, not a report — mirrors `dashboardCharts.ts#BUDGET_TXN_DRILLDOWN_CAP`.
const TXN_PAGE_CAP = 200;

const budgetDetailResult = v.object({
  id: v.id("budgets"),
  // The display name: the linked event/project's name when live, else the
  // budget's own label, else a generic type word — same fallback chain
  // `finances.ts#resolveBudgetRef`/`budgetDisplayName` use.
  name: v.string(),
  label: v.union(v.string(), v.null()),
  level: v.union(v.literal("chapter"), v.literal("central")),
  type: typeValidator,
  cadence: cadenceValidator,
  refKind: v.union(refKindValidator, v.null()),
  scopeRefId: v.union(v.string(), v.null()),
  // False when the ref id no longer resolves (a deleted event/project) — the
  // client never renders an "open ref" link in that case.
  refLive: v.boolean(),
  refDateLabel: v.union(v.string(), v.null()),
  year: v.number(),
  month: v.union(v.number(), v.null()),
  quarter: v.union(v.number(), v.null()),
  categoryId: v.union(v.id("budgetCategories"), v.null()),
  categoryName: v.union(v.string(), v.null()),
  approvalStatus: approvalStatusValidator,
  approvedCents: v.union(v.number(), v.null()),
  requestedCents: v.number(),
  reviewNote: v.union(v.string(), v.null()),
  // THE cap every number below is computed against — `effectiveCapCents`
  // (B1): a pending increase is never advertised as already-spendable room.
  capCents: v.number(),
  spentCents: v.number(),
  remainingCents: v.number(),
  pct: v.number(),
  status: v.union(v.literal("ok"), v.literal("warn")),
  categories: v.array(categoryBreakdownRow),
  transactions: v.array(txnRow),
  transactionTotalCount: v.number(),
  // Whether the CALLER may open this budget for editing — `BudgetCreateModal`'s
  // own mutations re-gate regardless; this only decides whether the page shows
  // the "Edit" button at all.
  canEdit: v.boolean(),
});

export const getBudgetDetail = query({
  args: { budgetId: v.id("budgets") },
  returns: v.union(budgetDetailResult, v.null()),
  handler: async (ctx, { budgetId }) => {
    const budget = await ctx.db.get(budgetId);
    if (!budget) return null;

    // Tenancy + role gate — mirrors `dashboardCharts.budgetTransactions`'s own
    // doc comment: the budget's own chapter at viewer rank, or central reach
    // through the caller's own home chapter for a budget owned by a
    // different chapter or by `"central"`.
    const ownChapterId = (await getChapterIdOrNull(ctx)) as Id<"chapters"> | null;
    let access: FinanceAccess;
    if (budget.chapterId !== ownChapterId) {
      if (!ownChapterId) {
        throw new ConvexError({
          code: "NO_CHAPTER",
          message: "You don't belong to a chapter yet.",
        });
      }
      access = await requireFinanceCentral(ctx, ownChapterId);
    } else {
      access = await requireFinanceRole(ctx, ownChapterId, "viewer");
    }
    // `access` above already asserts at least viewer/central reach for the
    // gate; `canEdit` mirrors `updateBudget`'s own write gate (manager rank
    // at a chapter budget's own chapter, central reach for a central one) so
    // the page only offers "Edit" when the mutation would actually succeed.
    const level = budget.chapterId === CENTRAL ? ("central" as const) : ("chapter" as const);
    const canEdit =
      level === "central"
        ? access.isCentral
        : budget.chapterId === ownChapterId
          ? access.isManager
          : false;

    const type = effectiveType(budget);
    const refKind = effectiveRefKind(budget);

    let refName: string | null = null;
    let refDateLabel: string | null = null;
    let refLive = false;
    if (refKind === "event" && budget.scopeRefId) {
      const ev = await ctx.db.get(budget.scopeRefId as Id<"events">);
      if (ev) {
        refName = ev.name;
        refDateLabel = easternDateStr(ev.eventDate);
        refLive = true;
      }
    } else if (refKind === "project" && budget.scopeRefId) {
      const pr = await ctx.db.get(budget.scopeRefId as Id<"projects">);
      if (pr) {
        refName = pr.name;
        refDateLabel = pr.deadline ? easternDateStr(pr.deadline) : null;
        refLive = true;
      }
    }
    const name = refName ?? (budget.label?.trim() || BUDGET_TYPE_LABELS[type]);

    // Category names, resolved through the budget's OWN chapter — bounded
    // chapter-wide read, same convention `finances.ts` rollups use.
    // `budgetCategories.chapterId` is a real chapter id ONLY (never the
    // `"central"` sentinel — categories, like funds, are chapter-scoped), so
    // a central budget has no categories table to read; `categoryChapterId`
    // is captured into its own `const` (rather than narrowing `budget.
    // chapterId` inline) because TypeScript doesn't retain a narrowed member
    // expression's type inside the nested `withIndex` callback closure below.
    const categoryChapterId = budget.chapterId;
    const categoryDocs =
      categoryChapterId === CENTRAL
        ? []
        : await ctx.db
            .query("budgetCategories")
            .withIndex("by_chapter", (q) => q.eq("chapterId", categoryChapterId))
            .take(ROLLUP_SCAN_LIMIT);
    const catName = new Map(categoryDocs.map((c) => [c._id, c.name] as const));

    const sandboxMode = await readSandbox(ctx);
    const linked = await ctx.db
      .query("transactions")
      .withIndex("by_budget", (q) => q.eq("budgetId", budgetId))
      .take(ROLLUP_SCAN_LIMIT);
    if (linked.length === ROLLUP_SCAN_LIMIT) {
      console.warn(
        `[budgetDetail] getBudgetDetail hit ROLLUP_SCAN_LIMIT (${ROLLUP_SCAN_LIMIT}) for budget ${budgetId}; totals truncated.`,
      );
    }
    const inMode = linked.filter((tr) => txnMatchesMode(tr, sandboxMode));
    // LIFETIME spend + category breakdown — see this file's own module doc
    // for why the detail page doesn't narrow to a cadence window the way the
    // dashboard's cards do.
    const spendRows = inMode.filter((tr) => isSpend(tr));
    const spentCents = spendRows.reduce((sum, tr) => sum + tr.amountCents, 0);
    const capCents = effectiveCapCents(budget);
    const byCat = new Map<string, number>();
    for (const tr of spendRows) {
      const key = tr.categoryId ? catName.get(tr.categoryId) ?? "Uncategorized" : "Uncategorized";
      byCat.set(key, (byCat.get(key) ?? 0) + tr.amountCents);
    }
    const denom = capCents > 0 ? capCents : spentCents;
    const categories = [...byCat.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([catNameKey, cents]) => ({
        name: catNameKey,
        spentCents: cents,
        barPct: denom > 0 ? Math.min(100, Math.round((cents / denom) * 100)) : 0,
      }));
    const pct = pctOf(spentCents, capCents);

    // The linked-transactions list — every transaction ever explicitly
    // attributed to this budget (spend AND non-spend, e.g. a transfer leg),
    // newest first, bounded for display (`TXN_PAGE_CAP`).
    inMode.sort((a, b) => b.postedAt - a.postedAt);
    const totalCount = inMode.length;
    const page = inMode.slice(0, TXN_PAGE_CAP);

    const personCache = new Map<Id<"people">, string | null>();
    const cardCache = new Map<Id<"cards">, Doc<"cards"> | null>();
    const transactions: (typeof txnRow.type)[] = [];
    for (const tr of page) {
      let personId = tr.personId ?? null;
      if (!personId && tr.cardId) {
        if (!cardCache.has(tr.cardId)) {
          cardCache.set(tr.cardId, await ctx.db.get(tr.cardId));
        }
        personId = cardCache.get(tr.cardId)?.cardholderPersonId ?? null;
      }
      let personName: string | null = null;
      if (personId) {
        if (!personCache.has(personId)) {
          const person = await ctx.db.get(personId);
          personCache.set(personId, person?.name ?? null);
        }
        personName = personCache.get(personId) ?? null;
      }
      transactions.push({
        id: tr._id,
        date: tr.postedAt,
        description: tr.description ?? null,
        merchantName: tr.merchantName ?? null,
        amountCents: tr.amountCents,
        flow: tr.flow,
        categoryName: tr.categoryId ? catName.get(tr.categoryId) ?? "Uncategorized" : null,
        personName,
        hasReceipt: tr.receiptStorageId != null,
        status: tr.status,
      });
    }

    return {
      id: budget._id,
      name,
      label: budget.label ?? null,
      level,
      type,
      cadence: budget.cadence,
      refKind,
      scopeRefId: budget.scopeRefId ?? null,
      refLive,
      refDateLabel,
      year: budget.year,
      month: budget.month ?? null,
      quarter: budget.quarter ?? null,
      categoryId: budget.categoryId ?? null,
      categoryName: budget.categoryId ? catName.get(budget.categoryId) ?? null : null,
      approvalStatus: effectiveBudgetApprovalStatus(budget.approvalStatus),
      approvedCents: budget.approvedCents ?? null,
      requestedCents: budget.amountCents,
      reviewNote: budget.reviewNote ?? null,
      capCents,
      spentCents,
      remainingCents: capCents - spentCents,
      pct,
      status: pct >= 80 ? ("warn" as const) : ("ok" as const),
      categories,
      transactions,
      transactionTotalCount: totalCount,
      canEdit,
    };
  },
});
