/**
 * Money views (WP-3.3) — "what's this thing costing?"
 *
 * A read-only rollup for a SINGLE event/project ref: its budget (the v2
 * `budgets` row, budget-first world per WP-U/WP-U2 — `budgetId` is the only
 * pointer; the row IS the plan), its planned lines (WP-3.1 `budgetLines`)
 * grouped by category, its actual spend (`transactions`, budget-first via
 * `by_ref` → `by_budget`, mirroring `finances.ts#actualsForRef`), and the
 * planned-vs-actual deltas that answer "what's this event/project costing?"
 * split by people / location / gear / whatever categories the plan uses.
 *
 * OWNERSHIP: this file is intentionally separate from `finances.ts` (whose
 * budget-mutation region + schema are owned by a parallel WP) — every read
 * here either re-derives its own bounded index scan or imports an already-
 * exported, stable READ helper (`getBudgetForRef` is NOT imported; we need
 * every by_ref budget, not just the first, mirroring `actualsForRef`'s own
 * multi-budget reasoning — see `#171`).
 *
 * AUTHZ mirrors `finances.dashboardChapter`'s central drill-down /
 * `events.ts#resolvePeekChapterId`: the caller needs at least a viewer
 * finance role in the REF's own chapter; a caller from a DIFFERENT chapter
 * needs central (org-wide) reach, checked through their OWN home chapter
 * (central is scope-wide regardless of which chapterId it's checked
 * against — `getFinanceRole`'s `viewerPerson` lookup just needs a chapter to
 * resolve the caller's roster row through). Unlike `events.ts`'s peek
 * queries, there's no separate `chapterId` arg here — the ref itself names
 * its own chapter, so "foreign" is detected by comparing it to the caller's
 * home chapter directly. A foreign ref WITHOUT central reach returns the same
 * quiet empty shape as a nonexistent ref — matching `events.get`'s uniform
 * not-found pattern — rather than throwing FORBIDDEN, which would let an
 * authenticated prober learn cross-chapter record existence just by
 * comparing throw-vs-empty across refIds.
 *
 * Training events NEVER get a budget row (the #172 invariant enforced by
 * every budget-creation path) — a training ref simply reads back a null
 * budget / all-zero totals, exactly like a real event that hasn't been
 * budgeted yet. `isTraining` is still surfaced so the client can skip
 * rendering the Money tab entirely rather than showing a permanently-empty one.
 */
import { query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { Doc, Id } from "./_generated/dataModel";
import { BUDGET_REF_KINDS, countsAsSpend, type BudgetRefKind } from "@events-os/shared";
import { getChapterIdOrNull } from "./lib/context";
import { requireFinanceRole, getFinanceRole } from "./lib/finance";

// A generous bound on budgets-per-ref / lines-per-budget / txns-per-budget —
// human-authored plans and a single event/project's spend, never a synced
// feed. Mirrors the scan limits used throughout `finances.ts`.
const SCAN_LIMIT = 2000;

const refKindValidator = v.union(...BUDGET_REF_KINDS.map((k) => v.literal(k)));

/**
 * Resolve + authorize a single event/project ref for a Money read. Returns
 * `null` when the ref doesn't exist (quiet 404, matching `events.get`'s /
 * `projects.get`'s "not found" shape) — AND when it exists in a foreign
 * chapter the caller can't see (no central reach). The two cases are
 * deliberately indistinguishable to the caller: an authenticated prober must
 * not be able to enumerate cross-chapter record existence by comparing
 * throw-vs-empty across refIds (see the module doc comment). A caller with NO
 * finance role at all in their OWN chapter still gets a genuine `ConvexError`
 * — that's an access denial on a ref they can already see exists (via every
 * other event/project surface), not an existence leak.
 */
async function resolveRefAuthz(
  ctx: QueryCtx,
  refKind: BudgetRefKind,
  refId: string,
): Promise<{ chapterId: Id<"chapters">; isTraining: boolean } | null> {
  let ref: Doc<"events"> | Doc<"projects"> | null = null;
  if (refKind === "event") {
    const id = ctx.db.normalizeId("events", refId);
    ref = id ? await ctx.db.get(id) : null;
  } else {
    const id = ctx.db.normalizeId("projects", refId);
    ref = id ? await ctx.db.get(id) : null;
  }
  if (!ref) return null;
  const refChapterId = ref.chapterId;

  const ownChapterId = (await getChapterIdOrNull(ctx)) as Id<"chapters"> | null;
  if (!ownChapterId) {
    throw new ConvexError({
      code: "NO_CHAPTER",
      message: "You don't belong to a chapter yet.",
    });
  }
  if (refChapterId !== ownChapterId) {
    // Foreign chapter: central (org-wide) reach required, checked through the
    // CALLER'S OWN chapter (never the target ref's chapter — mirrors
    // `dashboardChapter`'s central drill-down gate exactly). Checked via
    // `getFinanceRole` (not `requireFinanceCentral`) so a failed check can
    // return the same quiet `null` as a nonexistent ref instead of throwing —
    // closes the existence oracle. Central-reach callers still get real data.
    const access = await getFinanceRole(ctx, ownChapterId);
    if (!access.isCentral) return null;
  } else {
    await requireFinanceRole(ctx, ownChapterId, "viewer");
  }

  const isTraining =
    refKind === "event" ? (ref as Doc<"events">).isTraining === true : false;
  return { chapterId: refChapterId, isTraining };
}

/** True iff a transaction contributes to category/budget SPEND — mirrors
 *  `finances.ts#isSpend` exactly (kept local since that one isn't exported):
 *  outflow, non-transfer (`countsAsSpend`), not excluded, not a personal charge. */
function isSpend(tr: Doc<"transactions">): boolean {
  return (
    tr.flow === "outflow" &&
    countsAsSpend(tr.flow) &&
    tr.status !== "excluded" &&
    tr.isPersonal !== true
  );
}

const moneyTxnSummary = v.object({
  id: v.id("transactions"),
  postedAt: v.number(),
  amountCents: v.number(),
  flow: v.union(v.literal("outflow"), v.literal("inflow"), v.literal("transfer")),
  status: v.union(
    v.literal("unreviewed"),
    v.literal("categorized"),
    v.literal("reconciled"),
    v.literal("excluded"),
  ),
  merchantName: v.union(v.string(), v.null()),
  description: v.union(v.string(), v.null()),
  categoryId: v.union(v.id("budgetCategories"), v.null()),
});

function toMoneyTxnSummary(tr: Doc<"transactions">) {
  return {
    id: tr._id,
    postedAt: tr.postedAt,
    amountCents: tr.amountCents,
    flow: tr.flow,
    status: tr.status,
    merchantName: tr.merchantName ?? null,
    description: tr.description ?? null,
    categoryId: tr.categoryId ?? null,
  };
}

const moneyCategoryRow = v.object({
  categoryId: v.union(v.id("budgetCategories"), v.null()),
  categoryName: v.string(),
  plannedCents: v.number(),
  actualCents: v.number(),
});

/**
 * The event/project Money view: budget header + planned-vs-actual by
 * category + the unplanned-spend bucket + a recent linked-transactions list.
 * "What's this thing costing?" — people / location / gear / whatever
 * categories the plan breaks the budget into.
 */
export const refMoney = query({
  args: {
    refKind: refKindValidator,
    refId: v.string(),
  },
  returns: v.object({
    refKind: refKindValidator,
    refId: v.string(),
    isTraining: v.boolean(),
    budget: v.union(
      v.object({
        id: v.id("budgets"),
        amountCents: v.number(),
        label: v.union(v.string(), v.null()),
        // WP-3.2 (a parallel, not-yet-merged WP) lands `budgets.approvalStatus`
        // as a first-class field. Read dynamically/optionally below so THIS
        // PR doesn't couple to that schema change — `null` until WP-3.2
        // merges, then this lights up automatically with no further changes
        // here. Typed properly (imported from `@events-os/shared`) once
        // merged.
        approvalStatus: v.union(
          v.literal("draft"),
          v.literal("submitted"),
          v.literal("approved"),
          v.literal("changes_requested"),
          v.null(),
        ),
      }),
      v.null(),
    ),
    categories: v.array(moneyCategoryRow),
    unplannedCents: v.number(),
    // Planned but not broken into any category line yet — `budget.amountCents`
    // minus the sum of `budgetLines.plannedCents` across every by_ref budget,
    // floored at 0. Keeps the header total and the category-row sum visibly
    // reconciling: category rows alone can undercount the header amount when
    // a budget hasn't been fully allocated to lines.
    unallocatedPlannedCents: v.number(),
    transactions: v.array(moneyTxnSummary),
    totalPlannedCents: v.number(),
    totalActualCents: v.number(),
    totalRemainingCents: v.number(),
    lineCount: v.number(),
  }),
  handler: async (ctx, args) => {
    const empty = {
      refKind: args.refKind,
      refId: args.refId,
      isTraining: false,
      budget: null,
      categories: [] as never[],
      unplannedCents: 0,
      unallocatedPlannedCents: 0,
      transactions: [] as never[],
      totalPlannedCents: 0,
      totalActualCents: 0,
      totalRemainingCents: 0,
      lineCount: 0,
    };

    const authz = await resolveRefAuthz(ctx, args.refKind, args.refId);
    if (!authz) return empty;

    // Every one_time budget attached to this ref, wherever it currently
    // lives (a budget's LEVEL can move — WP-2.2's `transferProjectScope` —
    // while the ref's own `chapterId` never changes). The D8 invariant means
    // this is normally exactly one row; `by_ref` still unions every match so
    // a legacy duplicate never silently undercounts (mirrors
    // `finances.ts#actualsForRef`'s reasoning verbatim).
    const budgets = await ctx.db
      .query("budgets")
      .withIndex("by_ref", (q) =>
        q.eq("refKind", args.refKind).eq("scopeRefId", args.refId),
      )
      .take(SCAN_LIMIT);
    if (budgets.length === SCAN_LIMIT) {
      console.warn(
        `[moneyViews] refMoney hit SCAN_LIMIT (${SCAN_LIMIT}) reading budgets for ${args.refKind} ${args.refId}; sums may be truncated.`,
      );
    }

    if (budgets.length === 0) {
      return { ...empty, isTraining: authz.isTraining };
    }

    // The primary/header budget: earliest-created wins when a legacy
    // duplicate exists, so the header is stable across reloads.
    const primary = [...budgets].sort((a, b) => a.createdAt - b.createdAt)[0];

    const [linesByBudget, txnsByBudget] = await Promise.all([
      Promise.all(
        budgets.map(async (b) => {
          const rows = await ctx.db
            .query("budgetLines")
            .withIndex("by_budget", (q) => q.eq("budgetId", b._id))
            .take(SCAN_LIMIT);
          if (rows.length === SCAN_LIMIT) {
            console.warn(
              `[moneyViews] refMoney hit SCAN_LIMIT (${SCAN_LIMIT}) reading budgetLines for budget ${b._id}; planned totals may be truncated.`,
            );
          }
          return rows;
        }),
      ),
      Promise.all(
        budgets.map(async (b) => {
          const rows = await ctx.db
            .query("transactions")
            .withIndex("by_budget", (q) => q.eq("budgetId", b._id))
            .take(SCAN_LIMIT);
          if (rows.length === SCAN_LIMIT) {
            console.warn(
              `[moneyViews] refMoney hit SCAN_LIMIT (${SCAN_LIMIT}) reading transactions for budget ${b._id}; actuals may be truncated.`,
            );
          }
          return rows;
        }),
      ),
    ]);
    const lines = linesByBudget.flat();
    // Defense-in-depth + consistency with `finances.ts#actualsForRef`: never
    // sum/list a transaction from another chapter, even though `by_budget`
    // can't help but return one once a budget moves to central
    // (`transferProjectScope` moves the budget AND its linked transactions to
    // central together — the REF's own `chapterId` never changes, so
    // filtering back down to it here keeps this view in lockstep with
    // `projectActuals`/the dashboard for the same ref; the Central row
    // already reports that spend under its own roof — one home per dollar).
    const refChapterTxns = txnsByBudget.flat().filter((tr) => tr.chapterId === authz.chapterId);
    const spendTxns = refChapterTxns.filter(isSpend);

    // ── Plan (ESTIMATED-side, invariant #2 — never mixed with actuals below) ──
    type CatKey = Id<"budgetCategories"> | null;
    const plannedByCategory = new Map<CatKey, number>();
    for (const line of lines) {
      const key: CatKey = line.categoryId ?? null;
      plannedByCategory.set(key, (plannedByCategory.get(key) ?? 0) + line.plannedCents);
    }

    // ── Actual (the ONE table summed for actuals — transfers/excluded/
    //    personal already dropped by `isSpend`) ──
    const actualByCategory = new Map<CatKey, number>();
    for (const tr of spendTxns) {
      const key: CatKey = tr.categoryId ?? null;
      actualByCategory.set(key, (actualByCategory.get(key) ?? 0) + tr.amountCents);
    }

    // Resolve category names for every category that appears on EITHER side.
    const categoryIds = new Set<Id<"budgetCategories">>();
    for (const key of plannedByCategory.keys()) if (key) categoryIds.add(key);
    for (const key of actualByCategory.keys()) if (key) categoryIds.add(key);
    const categoryIdList = [...categoryIds];
    const categoryDocs = await Promise.all(
      categoryIdList.map((id) => ctx.db.get(id)),
    );
    const categoryName = new Map<Id<"budgetCategories">, string>();
    categoryIdList.forEach((id, i) => {
      const doc = categoryDocs[i];
      if (doc) categoryName.set(id, doc.name);
    });

    // Per-category planned-vs-actual: one row per PLANNED category (the plan
    // decides which categories exist here) plus its matching actual, if any.
    const categories = [...plannedByCategory.entries()].map(([key, plannedCents]) => ({
      categoryId: key,
      categoryName: key ? (categoryName.get(key) ?? "Uncategorized") : "Uncategorized",
      plannedCents,
      actualCents: actualByCategory.get(key) ?? 0,
    }));

    // Unplanned-spend bucket: actual spend in a category with NO planned
    // line at all — loud, never silently folded into a planned category's row.
    let unplannedCents = 0;
    for (const [key, cents] of actualByCategory.entries()) {
      if (!plannedByCategory.has(key)) unplannedCents += cents;
    }

    const totalPlannedCents = budgets.reduce((sum, b) => sum + b.amountCents, 0);
    const totalActualCents = spendTxns.reduce((sum, tr) => sum + tr.amountCents, 0);

    // Planned but not yet broken into any category line — keeps the header
    // total and the sum of category rows visibly reconciling (see the
    // field's own doc comment on the return validator above).
    const totalLinesCents = lines.reduce((sum, l) => sum + l.plannedCents, 0);
    const unallocatedPlannedCents = Math.max(0, totalPlannedCents - totalLinesCents);

    // WP-3.2 (a parallel, not-yet-merged WP) lands `budgets.approvalStatus`
    // as a first-class field — read it dynamically/optionally so this PR
    // doesn't couple to that schema change (see the return validator's own
    // doc comment above).
    const approvalStatus =
      (primary as { approvalStatus?: "draft" | "submitted" | "approved" | "changes_requested" })
        .approvalStatus ?? null;

    const transactions = [...refChapterTxns]
      .sort((a, b) => b.postedAt - a.postedAt)
      .slice(0, 50)
      .map(toMoneyTxnSummary);

    return {
      refKind: args.refKind,
      refId: args.refId,
      isTraining: authz.isTraining,
      budget: {
        id: primary._id,
        amountCents: primary.amountCents,
        label: primary.label ?? null,
        approvalStatus,
      },
      categories,
      unplannedCents,
      unallocatedPlannedCents,
      transactions,
      totalPlannedCents,
      totalActualCents,
      totalRemainingCents: totalPlannedCents - totalActualCents,
      lineCount: lines.length,
    };
  },
});
