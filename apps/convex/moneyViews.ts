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
import {
  BUDGET_REF_KINDS,
  BUDGET_APPROVAL_STATUSES,
  CENTRAL,
  countsAsSpend,
  effectiveBudgetApprovalStatus,
  financeRoleAtLeast,
  type BudgetRefKind,
} from "@events-os/shared";
import { getChapterIdOrNull } from "./lib/context";
import { requireFinanceRole, getFinanceRole, type FinanceAccess } from "./lib/finance";
import { effectiveCapCents } from "./finances";
import { callerHasEventEditRights } from "./lib/org";

// A generous bound on budgets-per-ref / lines-per-budget / txns-per-budget —
// human-authored plans and a single event/project's spend, never a synced
// feed. Mirrors the scan limits used throughout `finances.ts`.
const SCAN_LIMIT = 2000;

const refKindValidator = v.union(...BUDGET_REF_KINDS.map((k) => v.literal(k)));
const approvalStatusValidator = v.union(
  ...BUDGET_APPROVAL_STATUSES.map((s) => v.literal(s)),
);

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
 *
 * Also returns the caller's own `chapterId` + resolved `FinanceAccess` (not
 * just a pass/fail) so `refMoney` can compute a precise `canEditPlan` gate
 * once it knows which chapter/level the ref's budget actually lives at —
 * see that computation's own comment below for why a coarse "!isDrilldown"
 * gate (the dashboard's own "Edit budget" affordance) isn't safe to copy
 * verbatim here: a foreign ref's budget can still be chapter-owned (never
 * moved to central), which `budgetLines.ts#loadOwningBudget` would 404 on.
 */
async function resolveRefAuthz(
  ctx: QueryCtx,
  refKind: BudgetRefKind,
  refId: string,
): Promise<
  | { chapterId: Id<"chapters">; isTraining: boolean; ownChapterId: Id<"chapters">; access: FinanceAccess }
  | null
> {
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
  let access: FinanceAccess;
  if (refChapterId !== ownChapterId) {
    // Foreign chapter: central (org-wide) reach required, checked through the
    // CALLER'S OWN chapter (never the target ref's chapter — mirrors
    // `dashboardChapter`'s central drill-down gate exactly). Checked via
    // `getFinanceRole` (not `requireFinanceCentral`) so a failed check can
    // return the same quiet `null` as a nonexistent ref instead of throwing —
    // closes the existence oracle. Central-reach callers still get real data.
    access = await getFinanceRole(ctx, ownChapterId);
    if (!access.isCentral) return null;
  } else {
    access = await requireFinanceRole(ctx, ownChapterId, "viewer");
  }

  const isTraining =
    refKind === "event" ? (ref as Doc<"events">).isTraining === true : false;
  return { chapterId: refChapterId, isTraining, ownChapterId, access };
}

/**
 * Whether the caller can write this ref's budget PLAN (add/update/remove/
 * reorder `budgetLines`, or summon a first budget row) — mirrors
 * `budgetLines.ts#loadOwningBudget` + `#requireLineWriteAccess` EXACTLY so
 * the "Edit plan" affordance never appears for a caller whose first tap would
 * 403. Deliberately tighter than the finance dashboard's own "Edit budget"
 * button (gated there by a coarse `!isDrilldown`): unlike a dashboard budget
 * card — which a caller only ever reaches already scoped to their own chapter
 * or a genuine central desk — `refMoney` also serves a REF in a FOREIGN
 * chapter to a central-reach viewer, and that ref's budget can still be
 * chapter-owned by the FOREIGN chapter (never moved to central) — a case
 * `loadOwningBudget` 404s on regardless of the caller's central reach.
 *
 *  - No budget row yet: writable only when the ref is in the caller's OWN
 *    chapter (summon always lands there — `ensureBudgetForRef` inserts under
 *    `event.chapterId`, never central) and the caller is bookkeeper+.
 *  - A chapter-owned budget: writable only when that chapter IS the caller's
 *    own chapter (else `loadOwningBudget` 404s) and bookkeeper+.
 *  - A central-owned budget: writable when the caller holds central reach at
 *    bookkeeper+, regardless of whose ref it's attached to.
 */
function canEditBudgetPlan(
  authz: { ownChapterId: Id<"chapters">; chapterId: Id<"chapters">; access: FinanceAccess },
  budgetChapterId: Id<"chapters"> | "central" | null,
): boolean {
  const bookkeeperPlus = financeRoleAtLeast(authz.access.role, "bookkeeper");
  if (budgetChapterId === null) {
    // No budget row yet — summon-then-edit, only possible on the caller's own
    // chapter's own ref.
    return authz.chapterId === authz.ownChapterId && bookkeeperPlus;
  }
  if (budgetChapterId === CENTRAL) {
    return authz.access.isCentral && bookkeeperPlus;
  }
  return budgetChapterId === authz.ownChapterId && bookkeeperPlus;
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
  // Note/receipt state — surfaced so the Money tab's "Recent transactions"
  // section (a reconcile-lite view, owner decision 2026-07-17) can render
  // the current note + receipt status without a second round-trip. Mirrors
  // `finances.ts#toTxnSummary`'s own fields exactly.
  note: v.union(v.string(), v.null()),
  hasReceipt: v.boolean(),
  reminderStage: v.union(v.literal("none"), v.literal("flagged"), v.literal("escalated")),
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
    note: tr.note ?? null,
    hasReceipt: tr.receiptStorageId != null,
    reminderStage: tr.receiptReminderStage ?? ("none" as const),
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
        // The EFFECTIVE cap (`finances.ts#effectiveCapCents`, B1) — a budget
        // currently `"submitted"`/`"changes_requested"` WITH a recorded
        // `approvedCents` reports that still-in-force cap, never the pending
        // (not-yet-approved) `amountCents` increase. Every other case reports
        // the plain `amountCents`. Matches every other numeric budget surface
        // (dashboard cards, `finances.ts`'s own pct/remaining/status math).
        amountCents: v.number(),
        label: v.union(v.string(), v.null()),
        // Always the EFFECTIVE status (`effectiveBudgetApprovalStatus`) — a
        // grandfathered legacy row with no stored `approvalStatus` reads as
        // `"approved"`, never a bare `null` (WP-3.2 has merged; this is no
        // longer a "lights up later" placeholder).
        approvalStatus: approvalStatusValidator,
        // Alongside the effective cap above, for `BudgetApprovalChip`'s "approved
        // at $X, requested $Y" pending-increase copy (mirrors
        // `finances.ts#budgetApprovalCardFields` exactly).
        approvedCents: v.union(v.number(), v.null()),
        requestedCents: v.number(),
        reviewNote: v.union(v.string(), v.null()),
        // WP-wave4 (item 8): which SoD path the last approval decision took
        // (mirrors `finances.ts#budgetApprovalCardFields`).
        approvalParty: v.union(v.literal("single"), v.literal("two_party"), v.null()),
        // Whether the CALLER can write this budget's plan (`budgetLines`) —
        // see `canEditBudgetPlan`'s own doc comment for the exact gate.
        canEditPlan: v.boolean(),
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
    // Money IN (tickets + donations, from `eventPages`) — a summary-only
    // read alongside the spend-side view above. See the module doc's income
    // section for why this is a conscious, narrow addition (not a full
    // recreation of Budget v1's net-reconciliation math).
    incomeCents: v.number(),
    // Whether the caller can SUMMON a first ($0) budget row when none exists
    // yet — same gate as `canEditPlan`, exposed even in the `budget: null`
    // empty shape so the "Add budget" affordance can render before any
    // budget row is created.
    canSummonBudget: v.boolean(),
    // Whether the caller can act on `transactions` below — note/receipt/
    // category ONLY, never reattribution/amount/status (owner decision,
    // 2026-07-17). True for bookkeeper+ (mirrors `budget.canEditPlan`'s own
    // gate) OR — new — a caller with EVENT EDIT rights on THIS event
    // (`callerHasEventEditRights`, event refKind only; always `false` for a
    // project ref, which has no "lead" concept). A client-side DISPLAY hint
    // only — the real boundary is each mutation's own server-side gate
    // (`finances.ts#requireTxnNoteReceiptCategoryAccess`).
    canEditTransactions: v.boolean(),
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
      incomeCents: 0,
      canSummonBudget: false,
      canEditTransactions: false,
    };

    const authz = await resolveRefAuthz(ctx, args.refKind, args.refId);
    if (!authz) return empty;

    // Money IN — same reconciliation source Budget v1's `budgetSummary` read
    // (`eventPages.revenueCents` + `donationsCents`, one page per event).
    // Projects have no `eventPages` row, so this is 0 for `refKind:"project"`.
    const page =
      args.refKind === "event"
        ? await ctx.db
            .query("eventPages")
            .withIndex("by_event", (q) => q.eq("eventId", args.refId as Id<"events">))
            .unique()
        : null;
    const incomeCents = (page?.revenueCents ?? 0) + (page?.donationsCents ?? 0);

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
      return {
        ...empty,
        isTraining: authz.isTraining,
        incomeCents,
        canSummonBudget: canEditBudgetPlan(authz, null),
      };
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
    // SCOPE-AWARE (fixes a Central project under-reporting $0 actuals): filter
    // each budget's transactions down to THAT BUDGET's own current `chapterId`
    // — never `authz.chapterId` (the REF's home chapter, which never becomes
    // `"central"` — projects have no central union on the row itself, WP-2.2).
    // Once `transferProjectScope` moves a project's budget to `"central"`, its
    // linked transactions move with it (same patch); anchoring the filter to
    // each budget's OWN chapterId instead of the ref's fixed home chapter
    // means this view's actuals follow the money to wherever the "Belongs to"
    // row says it now lives, rather than silently zeroing out.
    //
    // This is DIFFERENT from `finances.ts#actualsForRef` (`projectActuals`/
    // `eventActuals`) on purpose: those are keyed to the CALLER'S OWN chapter
    // (a chapter-dashboard read — "how much does MY copy of this cost", which
    // correctly drops to zero once the money leaves), not to the ref. This
    // view answers "what does this project/event cost, period" for whoever is
    // already authorized to see it (visibility is unchanged — `resolveRefAuthz`
    // above still gates who gets here at all) — the ONE-HOME-PER-DOLLAR
    // invariant still holds: each transaction's `chapterId` is a single value,
    // so it's counted here (the ref's own money view) and, separately, in
    // whichever finance dashboard (chapter or central) currently owns it —
    // never both `refMoney` AND `actualsForRef` for the SAME level, and never
    // twice within `refMoney` itself, since a transaction belongs to exactly
    // one budget. Defense-in-depth is preserved too: a stale/duplicate
    // transaction whose `chapterId` doesn't match ITS OWN budget's current
    // scope is still dropped, just anchored to the right value.
    const refChapterTxns = budgets.flatMap((b, i) =>
      txnsByBudget[i].filter((tr) => tr.chapterId === b.chapterId),
    );
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

    // The EFFECTIVE cap (B1, `finances.ts#effectiveCapCents`) — a pending,
    // not-yet-approved increase never inflates the planned/remaining math a
    // step ahead of the actual approval. Summed across every by_ref budget,
    // same as the raw sum it replaces.
    const totalPlannedCents = budgets.reduce((sum, b) => sum + effectiveCapCents(b), 0);
    const totalActualCents = spendTxns.reduce((sum, tr) => sum + tr.amountCents, 0);

    // Planned but not yet broken into any category line — keeps the header
    // total and the sum of category rows visibly reconciling (see the
    // field's own doc comment on the return validator above).
    const totalLinesCents = lines.reduce((sum, l) => sum + l.plannedCents, 0);
    const unallocatedPlannedCents = Math.max(0, totalPlannedCents - totalLinesCents);

    const approvalStatus = effectiveBudgetApprovalStatus(primary.approvalStatus);

    const transactions = [...refChapterTxns]
      .sort((a, b) => b.postedAt - a.postedAt)
      .slice(0, 50)
      .map(toMoneyTxnSummary);

    const canEditPlanValue = canEditBudgetPlan(authz, primary.chapterId);
    // `canEditTransactions`: bookkeeper+ (same gate as the plan above) OR —
    // new, owner decision 2026-07-17 — event edit rights on THIS event. Only
    // resolved via the (extra) event-edit lookup when the finance-role gate
    // already failed, so a bookkeeper+ caller never pays for it.
    let canEditTransactions = canEditPlanValue;
    if (!canEditTransactions && args.refKind === "event") {
      const event = await ctx.db.get(args.refId as Id<"events">);
      if (event) canEditTransactions = await callerHasEventEditRights(ctx, event);
    }

    return {
      refKind: args.refKind,
      refId: args.refId,
      isTraining: authz.isTraining,
      budget: {
        id: primary._id,
        amountCents: effectiveCapCents(primary),
        label: primary.label ?? null,
        approvalStatus,
        approvedCents: primary.approvedCents ?? null,
        requestedCents: primary.amountCents,
        reviewNote: primary.reviewNote ?? null,
        approvalParty: primary.approvalParty ?? null,
        canEditPlan: canEditPlanValue,
      },
      categories,
      unplannedCents,
      unallocatedPlannedCents,
      transactions,
      totalPlannedCents,
      totalActualCents,
      totalRemainingCents: totalPlannedCents - totalActualCents,
      lineCount: lines.length,
      incomeCents,
      canSummonBudget: false,
      canEditTransactions,
    };
  },
});

// ── Event cost grid (phase 2 of "one money surface") ────────────────────────
/**
 * "Everything with a cost line item" — EVERY cost-bearing row on a single
 * event in ONE flat list, not just the finance plan (`budgetLines`) `refMoney`
 * above covers: `eventItems.fields[currencyColumnKey]` (Tasks/Supplies/
 * Comms/Permits/etc — ANY module with a `type:"currency"` column, built-in
 * or chapter-custom), paid-vendor `engagements.amountUsd`
 * (`engagements.ts#paidTotalForEvent`), and `budgetLines` (WP-3.1). Owner
 * spec: a database-style grid — Type / Label / Category / Planned $ /
 * Actual-or-status / source-link — editable in place, writing back to each
 * row's OWN home mutation (source of truth stays in the home table; this is
 * a rollup + inline-edit view, not a new ledger).
 *
 * THE MODEL (Opus review, PR #216, 2026-07-17):
 *   - Grid rows ARE the plan for anything with a home module (Task/Supply/
 *     Comms/any custom currency column, or a paid Vendor) — their cost lives
 *     on the module's own record, edited there or here, never duplicated
 *     into a `budgetLines` row.
 *   - `budgetLines` rows are for costs with NO home module (an AV rental
 *     that isn't a Task, a permit fee before Permits had a currency column,
 *     a category-level allocation) — the free-form finance-plan fallback.
 *   - LINKED pairs are MERGED, not summed: a `budgetLines` row with
 *     `sourceRef` pointing at the module row it represents contributes only
 *     its category (plan metadata the module side has no field for) — the
 *     module row's own cost/status/link still wins for display, and the
 *     line does NOT get a separate row or count toward the total twice.
 *     Nothing creates a link yet (no mutation sets `sourceRef` today) — this
 *     is forward-looking infrastructure for a future "plan this task's cost
 *     in Finances" flow.
 *   - UNLINKED duplicates are FLAGGED, not merged: since nothing proves two
 *     unlinked rows represent the same expense, a same-ish-label collision
 *     between a `budgetLines` row and a module row (e.g. Task "Sound tech"
 *     + budget line "Sound tech deposit") sets `possibleDuplicate` on BOTH
 *     rows — a human catches what the system can't yet prove, but neither
 *     row's amount is dropped from the total (silently hiding a real cost
 *     would be worse than a visible over-count warning).
 *
 * MODULE COVERAGE: dynamically swept from THIS EVENT's own `eventColumns`
 * (cloned per-event at instantiation, `lib/templates.ts` — includes every
 * custom `currency`-type column a chapter added via `columns.ts#addColumn`,
 * on ANY module, not a hardcoded 3-module allowlist). For the common case
 * (an unmodified template, only a `cost` key on Tasks/Supplies/Comms) this
 * sweep finds exactly those 3 modules — so the grid's per-item figures agree
 * with `events.ts#get`'s `budgetSpent` rollup (which sums `fields.cost`
 * across every module, key-oblivious) BY CONSTRUCTION whenever the item's
 * own module actually has a `cost`-keyed currency column. A currency column
 * with a DIFFERENT key (e.g. a custom Permits "fee" column) is invisible to
 * the OLD `budgetSpent` gauge (which only ever reads the literal `cost` key)
 * but IS captured here — a deliberate completeness improvement over the
 * header gauge, not a regression against it.
 *
 * MONEY UNIT NOTE: `eventItems.fields[key]` and `engagements.amountUsd` are
 * whole ESTIMATED USD DOLLARS (mirrors `events.budget`) — NOT integer cents
 * like every `finances.ts`/`budgetLines` figure. Every dollar figure here is
 * `Math.round(dollars * 100)` before it joins `plannedCents` so the grid's
 * rollup is apples-to-apples with the finance side.
 *
 * TYPE → CATEGORY: an unlinked module row's `categoryName` is its own
 * module's display label (Tasks / Supplies & Logistics / Permits / Vendors —
 * whatever `eventModules.label` says, built-in or chapter-custom), not a
 * real finance category id — none of `eventItems`/`engagements` carry a
 * `budgetCategories` link (no schema field exists on those tables). A
 * LINKED module row instead shows the linked line's REAL category. Giving
 * every module row a genuine `budgetCategories` link unconditionally (so
 * Reconcile/transactions could categorize against the same taxonomy even
 * unlinked) is a further follow-up, not attempted here.
 *
 * TWO TOTALS, ON PURPOSE: `refMoney` above stays a narrower "plan vs.
 * approved cap" view scoped to `budgetLines` only (unchanged by this
 * addition) — the finance PLAN measured against its approval cap. This
 * grid's total is "everything that costs money, full stop" — a different
 * axis. They are not merged into one number here; see the PR body.
 *
 * WRITE-BACK gating: each row is editable under its OWN home table's
 * EXISTING rule, never a new one — `eventItems`/`engagements` are editable by
 * any of the event's own chapter members today (`requireEvent` ==
 * `requireOwned`, no stronger role exists yet), `budgetLines` rows keep
 * `canEditBudgetPlan`'s bookkeeper+ gate from `refMoney` above. The READ
 * itself is gated the same as `refMoney` (finance viewer+ in the ref's own
 * chapter, or central reach for a foreign one) — so only someone who can
 * already see the Money tab sees the grid, but editability within it still
 * follows each row's native rule, not a finance role.
 */

const GRID_SCAN_LIMIT = 2000;

const gridSourceKindValidator = v.union(
  v.literal("event_item"),
  v.literal("vendor"),
  v.literal("budget_line"),
);

const gridRow = v.object({
  id: v.string(),
  sourceKind: gridSourceKindValidator,
  typeLabel: v.string(),
  label: v.string(),
  categoryName: v.string(),
  plannedCents: v.number(),
  // Vendors: the same figure once `paymentStatus === "paid"`, else null (not
  // yet actually spent). Tasks/Supplies/Comms/BudgetLines have no separate
  // actual concept — always null here (their `plannedCents` figure IS the
  // committed cost; `refMoney`'s `transactions`-based actuals are the real
  // "money that moved" side for the finance plan).
  actualCents: v.union(v.number(), v.null()),
  status: v.union(v.string(), v.null()),
  editable: v.boolean(),
  // Deep link to the row's home surface (`?tab=<module>` / `?tab=crew`) —
  // `null` for a `budget_line` row, which is edited right here via
  // `MoneyView`'s own "Edit plan" modal, not a separate screen.
  sourceLink: v.union(v.string(), v.null()),
  // True when this (module) row absorbed a `budgetLines` row's category via
  // `sourceRef` — the line itself never became a separate row (see the
  // module doc's "THE MODEL"). Always `false` on a `budget_line` row: a
  // TRULY linked line is folded away entirely, never surfaced as its own row.
  linked: v.boolean(),
  // True when this row's normalized label overlaps an UNLINKED row of a
  // DIFFERENT sourceKind (module vs. budget_line) — a possible same-expense
  // collision the system can't prove, flagged for a human. Never set on a
  // linked row (already provably not a duplicate — it's the SAME expense,
  // by construction, not a suspected one).
  possibleDuplicate: v.boolean(),
});

type WorkingRow = {
  id: string;
  sourceKind: "event_item" | "vendor" | "budget_line";
  typeLabel: string;
  label: string;
  categoryName: string;
  plannedCents: number;
  actualCents: number | null;
  status: string | null;
  editable: boolean;
  sourceLink: string | null;
  linked: boolean;
  possibleDuplicate: boolean;
  /** Transient (stripped before return) — the `eventItems`/`engagements` doc
   *  id this row was sourced from, for `sourceRef` link resolution. `null`
   *  for a `budget_line` row (which is never itself a link TARGET). */
  refId: string | null;
};

/** Round a whole-dollar figure (`eventItems.fields[key]` / `engagements.
 *  amountUsd`) to integer cents — mirrors `events.ts#budgetSpent`'s own
 *  `Number(...)` + finite guard, then converts to the finance side's unit. */
function dollarsToCents(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100);
}

// A short, generic English stopword list — enough to keep "the AV budget" and
// "the AV rental" from colliding on "the", without pulling in an NLP library.
const DUPLICATE_STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "this", "that", "cost", "cents", "fee",
]);

/** Normalize a row label into its SIGNIFICANT lowercase word-tokens (>= 4
 *  chars, not a stopword) — a deliberately simple, conservative "does this
 *  look like the same expense" signal: two labels are flagged as a possible
 *  duplicate when they share at least one significant token, never on a
 *  bare/short/common word alone. Reused consistently for every row (module
 *  and budget-line alike) so the comparison is symmetric. */
function significantTokens(label: string): Set<string> {
  return new Set(
    label
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 4 && !DUPLICATE_STOPWORDS.has(t)),
  );
}

function tokensOverlap(a: Set<string>, b: Set<string>): boolean {
  for (const t of a) if (b.has(t)) return true;
  return false;
}

export const eventCostGrid = query({
  args: { eventId: v.id("events") },
  returns: v.object({
    isTraining: v.boolean(),
    rows: v.array(gridRow),
    totalPlannedCents: v.number(),
  }),
  handler: async (ctx, args) => {
    const empty = { isTraining: false, rows: [] as never[], totalPlannedCents: 0 };
    const authz = await resolveRefAuthz(ctx, "event", args.eventId);
    if (!authz) return empty;
    if (authz.isTraining) return { ...empty, isTraining: true }; // #172

    const rows: WorkingRow[] = [];

    // ── Module label + currency-column sweep (dynamic, ALL modules) ────────
    // `eventColumns` is THIS event's own cloned column snapshot (every
    // module, built-in or chapter-custom) — see the module doc's "MODULE
    // COVERAGE" note for why this replaces a hardcoded module allowlist.
    const [eventColumnRows, eventModuleRows] = await Promise.all([
      ctx.db
        .query("eventColumns")
        .withIndex("by_event", (q) => q.eq("eventId", args.eventId))
        .take(GRID_SCAN_LIMIT),
      ctx.db
        .query("eventModules")
        .withIndex("by_event", (q) => q.eq("eventId", args.eventId))
        .take(GRID_SCAN_LIMIT),
    ]);
    const moduleLabel = new Map<string, string>(eventModuleRows.map((m) => [m.key, m.label]));
    const currencyColumnsByModule = new Map<string, { key: string; label: string }[]>();
    for (const col of eventColumnRows) {
      if (col.type !== "currency") continue;
      const entry = { key: col.key, label: col.label };
      const bucket = currencyColumnsByModule.get(col.module);
      if (bucket) bucket.push(entry);
      else currencyColumnsByModule.set(col.module, [entry]);
    }

    // ── eventItems (every module with a currency column) ───────────────────
    const items = await ctx.db
      .query("eventItems")
      .withIndex("by_event", (q) => q.eq("eventId", args.eventId))
      .take(GRID_SCAN_LIMIT);
    if (items.length === GRID_SCAN_LIMIT) {
      console.warn(
        `[moneyViews] eventCostGrid hit GRID_SCAN_LIMIT (${GRID_SCAN_LIMIT}) reading eventItems for event ${args.eventId}; rows may be truncated.`,
      );
    }
    for (const item of items) {
      const currencyCols = currencyColumnsByModule.get(item.module);
      if (!currencyCols || currencyCols.length === 0) continue;
      const typeLabel = moduleLabel.get(item.module) ?? item.module;
      const multiCol = currencyCols.length > 1;
      for (const col of currencyCols) {
        const cents = dollarsToCents(item.fields?.[col.key]);
        if (cents === null) continue;
        const title = item.title || "(untitled)";
        rows.push({
          id: `event_item:${item._id}:${col.key}`,
          sourceKind: "event_item",
          typeLabel,
          // Disambiguate only when a module genuinely has more than one
          // currency column (rare) — keeps the common case's label clean.
          label: multiCol ? `${title} — ${col.label}` : title,
          categoryName: typeLabel,
          plannedCents: cents,
          actualCents: null,
          status: item.status ?? null,
          editable: true, // same native chapter-member gate `items.ts` already enforces
          sourceLink: `/event/${args.eventId}?tab=${item.module}`,
          linked: false,
          possibleDuplicate: false,
          refId: String(item._id),
        });
      }
    }

    // ── Paid vendors (Crew & Duties) ────────────────────────────────────────
    const paidEngagements = await ctx.db
      .query("engagements")
      .withIndex("by_event_type", (q) =>
        q.eq("eventId", args.eventId).eq("type", "paid"),
      )
      .take(GRID_SCAN_LIMIT);
    const vendorPeople = await Promise.all(
      paidEngagements.map((e) => ctx.db.get(e.personId)),
    );
    paidEngagements.forEach((eng, i) => {
      const cents = dollarsToCents(eng.amountUsd);
      if (cents === null) return;
      const person = vendorPeople[i];
      rows.push({
        id: `vendor:${eng._id}`,
        sourceKind: "vendor",
        typeLabel: "Vendors",
        label: person?.name ?? "(unknown)",
        categoryName: "Vendors",
        plannedCents: cents,
        actualCents: eng.paymentStatus === "paid" ? cents : null,
        status: eng.paymentStatus ?? null,
        editable: true, // same native chapter-member gate `engagements.ts` already enforces
        sourceLink: `/event/${args.eventId}?tab=crew`,
        linked: false,
        possibleDuplicate: false,
        refId: String(eng._id),
      });
    });

    // ── Budget lines (the finance plan, WP-3.1) — merge linked, else a row ──
    const budgets = await ctx.db
      .query("budgets")
      .withIndex("by_ref", (q) => q.eq("refKind", "event").eq("scopeRefId", args.eventId))
      .take(GRID_SCAN_LIMIT);
    const budgetLineRows: WorkingRow[] = [];
    for (const budget of budgets) {
      const lines = await ctx.db
        .query("budgetLines")
        .withIndex("by_budget", (q) => q.eq("budgetId", budget._id))
        .take(GRID_SCAN_LIMIT);
      const categoryIds = [...new Set(lines.map((l) => l.categoryId).filter(Boolean))] as Id<"budgetCategories">[];
      const categoryDocs = await Promise.all(categoryIds.map((id) => ctx.db.get(id)));
      const categoryName = new Map<string, string>();
      categoryIds.forEach((id, i) => {
        const doc = categoryDocs[i];
        if (doc) categoryName.set(id, doc.name);
      });
      const canEdit = canEditBudgetPlan(authz, budget.chapterId);
      for (const line of lines) {
        const resolvedCategoryName = line.categoryId
          ? (categoryName.get(line.categoryId) ?? "Uncategorized")
          : "Uncategorized";

        // LINKED: fold this line's category into every module row sourced
        // from `sourceRef.id`, and don't give the line its own row at all —
        // "module row wins for display" (its cost/status/link are untouched;
        // only `categoryName` is upgraded to the line's REAL category).
        if (line.sourceRef) {
          const targets = rows.filter((r) => r.refId === line.sourceRef!.id);
          if (targets.length > 0) {
            for (const target of targets) {
              target.linked = true;
              target.categoryName = resolvedCategoryName;
            }
            continue; // merged — no separate budget_line row, no double count.
          }
          // Dangling sourceRef (the linked item/engagement isn't a grid row —
          // e.g. it was deleted, or its module lost its currency column) —
          // fall through and show the line as a normal unlinked row so its
          // plan data doesn't just vanish.
        }

        budgetLineRows.push({
          id: `budget_line:${line._id}`,
          sourceKind: "budget_line",
          typeLabel: "Budget lines",
          label: line.description,
          categoryName: resolvedCategoryName,
          plannedCents: line.plannedCents,
          actualCents: null,
          status: null,
          editable: canEdit,
          sourceLink: null,
          linked: false,
          possibleDuplicate: false,
          refId: null,
        });
      }
    }
    rows.push(...budgetLineRows);

    // ── Possible-duplicate flagging (unlinked rows only) ────────────────────
    // Conservative + symmetric: only compares a `budget_line` row against a
    // module row (`event_item`/`vendor`) — the double-count shape the review
    // actually flagged — never two rows of the SAME sourceKind (two Tasks
    // named similarly aren't a "same expense counted twice" concern).
    const moduleRows = rows.filter((r) => r.sourceKind !== "budget_line" && !r.linked);
    const moduleTokens = moduleRows.map((r) => significantTokens(r.label));
    for (const line of budgetLineRows) {
      if (line.linked) continue; // already provably the same expense, not "possible"
      const lineTokens = significantTokens(line.label);
      if (lineTokens.size === 0) continue;
      for (let i = 0; i < moduleRows.length; i++) {
        if (tokensOverlap(lineTokens, moduleTokens[i])) {
          line.possibleDuplicate = true;
          moduleRows[i].possibleDuplicate = true;
        }
      }
    }

    rows.sort((a, b) => {
      if (a.typeLabel !== b.typeLabel) return a.typeLabel.localeCompare(b.typeLabel);
      return a.label.localeCompare(b.label);
    });

    return {
      isTraining: false,
      rows: rows.map(({ refId: _refId, ...row }) => row),
      totalPlannedCents: rows.reduce((sum, r) => sum + r.plannedCents, 0),
    };
  },
});
