/**
 * Finance public API — Phase 1A (no-vendor core).
 *
 * The real backend behind `api.finances.*`: funds / categories / teams CRUD,
 * budgets (scope × cadence × category), the unified `transactions` record
 * (create / categorize / reconcile / receipt / flag-personal), and the read
 * rollups (chapter + central dashboards, budget-vs-actual, event / project /
 * team / person actuals).
 *
 * Gating (finance-role ladder viewer < bookkeeper < manager):
 *  - reads                          → requireFinanceRole(..., "viewer")
 *  - transaction writes             → requireFinanceRole(..., "bookkeeper")
 *  - fund/category/team/budget CRUD → requireFinanceManager
 *  - central roll-up                → requireFinanceCentral
 *
 * INVARIANTS:
 *  - Money is ALWAYS a non-negative INTEGER number of cents. Direction is carried
 *    by `flow` (outflow/inflow/transfer), never a sign. `createManualTransaction`
 *    throws on floats/negatives (the arg validator can't).
 *  - Every function is chapter-scoped; every client-supplied id is verified to
 *    belong to the caller's chapter before use.
 *  - ANTI-DOUBLE-COUNT: `transfer`-flow rows (and `excluded`/personal rows) are
 *    excluded from all category/budget/actual SPEND totals (`countsAsSpend`).
 *    ESTIMATED money (budgets) is never summed with ACTUAL money (transactions).
 *  - Reads are bounded (`.take()` / paginate); rollups scope the index read to
 *    the period + chapter.
 */
import { query, mutation, internalMutation } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { Doc, Id } from "./_generated/dataModel";
import {
  FUND_RESTRICTIONS,
  BUDGET_CATEGORY_KINDS,
  BUDGET_SCOPES,
  BUDGET_TYPES,
  BUDGET_REF_KINDS,
  BUDGET_TAG_KINDS,
  BUDGET_CADENCES,
  TRANSACTION_SOURCES,
  TRANSACTION_FLOWS,
  TRANSACTION_STATUSES,
  BUDGET_SCOPE_LABELS,
  CENTRAL,
  countsAsSpend,
  easternParts,
  quarterOfMonth,
  formatCents,
  matchesMode,
  type BudgetType,
  type BudgetRefKind,
} from "@events-os/shared";
import { readSandbox } from "./financeSettings";
import {
  getChapterIdOrNull,
  requireChapterId,
  requireUserId,
} from "./lib/context";
import {
  requireFinanceRole,
  requireFinanceManager,
  requireFinanceCentral,
} from "./lib/finance";
import { requireSuperuser } from "./lib/superuser";
import { viewerPerson } from "./lib/org";
import {
  ensureDefaultFunds,
  insertDefaultExpenseCategories,
} from "./lib/seed/finance";

// ── Enum validators (built from the shared tuples) ───────────────────────────
const restrictionValidator = v.union(
  ...FUND_RESTRICTIONS.map((r) => v.literal(r)),
);
const categoryKindValidator = v.union(
  ...BUDGET_CATEGORY_KINDS.map((k) => v.literal(k)),
);
const scopeValidator = v.union(...BUDGET_SCOPES.map((s) => v.literal(s)));
const typeValidator = v.union(...BUDGET_TYPES.map((t) => v.literal(t)));
const refKindValidator = v.union(...BUDGET_REF_KINDS.map((k) => v.literal(k)));
const tagKindValidator = v.union(...BUDGET_TAG_KINDS.map((k) => v.literal(k)));
const cadenceValidator = v.union(...BUDGET_CADENCES.map((c) => v.literal(c)));
const sourceValidator = v.union(...TRANSACTION_SOURCES.map((s) => v.literal(s)));
const flowValidator = v.union(...TRANSACTION_FLOWS.map((f) => v.literal(f)));
const statusValidator = v.union(
  ...TRANSACTION_STATUSES.map((s) => v.literal(s)),
);

// ── Row-shape validators (the read projections) ──────────────────────────────
const fundSummary = v.object({
  id: v.id("funds"),
  name: v.string(),
  restriction: restrictionValidator,
  code: v.union(v.string(), v.null()),
  color: v.union(v.string(), v.null()),
  sortOrder: v.number(),
  isActive: v.boolean(),
});

const categorySummary = v.object({
  id: v.id("budgetCategories"),
  fundId: v.id("funds"),
  parentCategoryId: v.union(v.id("budgetCategories"), v.null()),
  name: v.string(),
  kind: categoryKindValidator,
  sortOrder: v.number(),
  isActive: v.boolean(),
});

const teamSummary = v.object({
  id: v.id("financeTeams"),
  name: v.string(),
  sortOrder: v.number(),
  isActive: v.boolean(),
});

// A tag as attached to a budget row (from its `budgetTagLinks`).
const budgetTagRef = v.object({
  id: v.id("budgetTags"),
  name: v.string(),
  kind: v.union(tagKindValidator, v.null()),
});

const budgetSummary = v.object({
  id: v.id("budgets"),
  amountCents: v.number(),
  label: v.union(v.string(), v.null()),
  // v2 source of truth. `scope` is a nullable legacy column (absent on v2-native
  // budgets); prefer `type`.
  type: v.union(typeValidator, v.null()),
  refKind: v.union(refKindValidator, v.null()),
  scope: v.union(scopeValidator, v.null()),
  scopeRefId: v.union(v.string(), v.null()),
  cadence: cadenceValidator,
  year: v.number(),
  month: v.union(v.number(), v.null()),
  quarter: v.union(v.number(), v.null()),
  fundId: v.union(v.id("funds"), v.null()),
  categoryId: v.union(v.id("budgetCategories"), v.null()),
  teamId: v.union(v.id("financeTeams"), v.null()),
  // The budget's managed tags (many-to-many via `budgetTagLinks`).
  tags: v.array(budgetTagRef),
  // Whether this is a chapter budget or an org-level (central) budget. Feeds the
  // reconcile Budget picker's Chapter / Central grouping.
  level: v.union(v.literal("chapter"), v.literal("central")),
});

// A per-tag rollup row (chapter dashboard carries `tagId`; central aggregates
// same-named tags across chapters and leaves `tagId` null).
const tagRollupRow = v.object({
  tagId: v.union(v.id("budgetTags"), v.null()),
  tagName: v.string(),
  kind: v.union(tagKindValidator, v.null()),
  budgetCents: v.number(),
  spentCents: v.number(),
  pct: v.number(),
  status: v.union(v.literal("ok"), v.literal("warn")),
});

// Shared field map so the reconcile row can extend the summary without drift.
const txnSummaryFields = {
  id: v.id("transactions"),
  postedAt: v.number(),
  amountCents: v.number(),
  flow: flowValidator,
  status: statusValidator,
  description: v.union(v.string(), v.null()),
  merchantName: v.union(v.string(), v.null()),
  fundId: v.union(v.id("funds"), v.null()),
  categoryId: v.union(v.id("budgetCategories"), v.null()),
  budgetId: v.union(v.id("budgets"), v.null()),
  // SOFT attribution warning: a spend txn with no budget still needs to be
  // rolled up. True iff `isSpend(tr) && budgetId == null` (transfers / excluded /
  // personal / inflow are never flagged). Drives the reconcile "needs budget"
  // badge + warning strip — never a hard block.
  needsBudget: v.boolean(),
  // True iff a receipt is attached (`receiptStorageId != null`) — the truthful
  // signal behind the reconcile "Missing receipt" filter + Receipt column.
  hasReceipt: v.boolean(),
  // The card's last-4 (parsed out of the sync description), for display.
  cardLast4: v.union(v.string(), v.null()),
};
const txnSummary = v.object(txnSummaryFields);

// The resolved cardholder behind a charge: the `personId` on the txn, else the
// person who owns the `cardId`. Powers the reconcile Cardholder column.
const cardholderRef = v.object({
  personId: v.id("people"),
  name: v.string(),
  imageUrl: v.union(v.string(), v.null()),
});

// One reconcile-grid row: the txn summary plus the resolved cardholder.
const reconcileRow = v.object({
  ...txnSummaryFields,
  cardholder: v.union(cardholderRef, v.null()),
});

// The reconcile filter pills (server-side, correct across ALL rows).
const reconcileFilterValidator = v.union(
  v.literal("all"),
  v.literal("needs_budget"),
  v.literal("missing_receipt"),
  v.literal("uncategorized"),
  v.literal("ready"),
);

// Per-filter counts returned alongside the rows so each pill shows its number.
const reconcileCounts = v.object({
  all: v.number(),
  needs_budget: v.number(),
  missing_receipt: v.number(),
  uncategorized: v.number(),
  ready: v.number(),
});

// Per-fund SPEND for the dashboard period (period reads are naturally bounded;
// all-time balance is deferred to the Increase sync in Phase 4).
const fundPeriodSpend = v.object({
  id: v.id("funds"),
  name: v.string(),
  spentCents: v.number(),
});

// ── Enriched dashboard projections (prototype shapes) ────────────────────────
const okWarnValidator = v.union(v.literal("ok"), v.literal("warn"));

const categoryBreakdown = v.object({
  name: v.string(),
  spentCents: v.number(),
  barPct: v.number(),
});

const chapterTile = v.object({
  label: v.string(),
  value: v.string(),
  subValueCents: v.optional(v.number()),
  meta: v.string(),
});

const centralTile = v.object({
  label: v.string(),
  value: v.string(),
  meta: v.string(),
});

// An org-level (central) budget rolled up org-wide: its allocation + its actual
// spend summed from EVERY chapter's transactions explicitly linked to it.
const centralBudgetCard = v.object({
  id: v.id("budgets"),
  label: v.union(v.string(), v.null()),
  // Legacy scope (nullable on v2-native central budgets).
  scope: v.union(scopeValidator, v.null()),
  cadence: cadenceValidator,
  year: v.number(),
  budgetCents: v.number(),
  spentCents: v.number(),
  pct: v.number(),
  status: okWarnValidator,
});

const projectBudgetCard = v.object({
  id: v.id("budgets"),
  name: v.string(),
  cadence: v.union(v.literal("per_instance"), v.literal("one_off")),
  sourceBadge: v.optional(v.union(v.string(), v.null())),
  dateLabel: v.optional(v.union(v.string(), v.null())),
  subtitle: v.optional(v.union(v.string(), v.null())),
  spentCents: v.number(),
  budgetCents: v.number(),
  pct: v.number(),
  remainingCents: v.number(),
  status: okWarnValidator,
  categories: v.array(categoryBreakdown),
});

const recurringBudgetCard = v.object({
  id: v.id("budgets"),
  name: v.string(),
  cadence: v.union(
    v.literal("monthly"),
    v.literal("quarterly"),
    v.literal("yearly"),
  ),
  spentCents: v.number(),
  budgetCents: v.number(),
  pct: v.number(),
  status: okWarnValidator,
  categories: v.optional(v.array(categoryBreakdown)),
  note: v.optional(v.union(v.string(), v.null())),
});

const recentTxnCard = v.object({
  id: v.id("transactions"),
  date: v.string(),
  merchant: v.union(v.string(), v.null()),
  cardLast4: v.optional(v.union(v.string(), v.null())),
  spenderName: v.optional(v.union(v.string(), v.null())),
  timeOrNote: v.optional(v.union(v.string(), v.null())),
  codedTo: v.optional(
    v.union(
      v.object({ fundOrProject: v.string(), category: v.string() }),
      v.null(),
    ),
  ),
  aiSuggestion: v.optional(
    v.union(v.object({ fund: v.string(), category: v.string() }), v.null()),
  ),
  amountCents: v.number(),
  flow: flowValidator,
  status: statusValidator,
});

const attentionItem = v.object({
  kind: v.string(),
  title: v.string(),
  badgeCount: v.number(),
  detail: v.string(),
  actionLabel: v.string(),
});

const chapterRollupRow = v.object({
  chapterId: v.id("chapters"),
  chapterName: v.string(),
  subtitle: v.optional(v.union(v.string(), v.null())),
  spentCents: v.number(),
  budgetCents: v.number(),
  barPct: v.number(),
  status: okWarnValidator,
});

// ── Bounds (keep every read + rollup bounded) ────────────────────────────────
const ROLLUP_SCAN_LIMIT = 5000;
const RECENT_TXN_COUNT = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

// ── Projection helpers ───────────────────────────────────────────────────────
function toFundSummary(f: Doc<"funds">) {
  return {
    id: f._id,
    name: f.name,
    restriction: f.restriction,
    code: f.code ?? null,
    color: f.color ?? null,
    sortOrder: f.sortOrder,
    isActive: f.isActive ?? true,
  };
}

function toCategorySummary(c: Doc<"budgetCategories">) {
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

function toTeamSummary(tm: Doc<"financeTeams">) {
  return {
    id: tm._id,
    name: tm.name,
    sortOrder: tm.sortOrder,
    isActive: tm.isActive ?? true,
  };
}

function toBudgetSummary(
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
  };
}

function toTxnSummary(tr: Doc<"transactions">) {
  return {
    id: tr._id,
    postedAt: tr.postedAt,
    amountCents: tr.amountCents,
    flow: tr.flow,
    status: tr.status,
    description: tr.description ?? null,
    merchantName: tr.merchantName ?? null,
    fundId: tr.fundId ?? null,
    categoryId: tr.categoryId ?? null,
    budgetId: tr.budgetId ?? null,
    needsBudget: isSpend(tr) && tr.budgetId == null,
    hasReceipt: tr.receiptStorageId != null,
    cardLast4: tr.cardLast4 ?? null,
  };
}

// ── Money / tenancy guards ───────────────────────────────────────────────────
/** Enforce the non-negative-integer-cents invariant the validator can't. */
function assertIntegerCents(amountCents: number, label = "Amount"): void {
  if (!Number.isInteger(amountCents) || amountCents < 0) {
    throw new ConvexError({
      code: "INVALID_AMOUNT",
      message: `${label} must be a non-negative whole number of cents.`,
    });
  }
}

/**
 * Load a document by id and assert it belongs to the caller's chapter. When
 * `allowCentral`, an org-level doc passes too: a central budget (`chapterId ===
 * "central"`, the CENTRAL sentinel) or a central finance team (absent
 * `chapterId`, the legacy financeTeams convention, kept until its own PR).
 */
async function requireInCallerChapter<T extends "funds" | "budgetCategories" | "financeTeams" | "budgets" | "budgetTags" | "transactions" | "events" | "projects" | "people">(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
  table: T,
  id: Id<T>,
  label: string,
  opts: { allowCentral?: boolean } = {},
): Promise<Doc<T>> {
  const doc = await ctx.db.get(id);
  const docChapter = (doc as { chapterId?: Id<"chapters"> | typeof CENTRAL } | null)?.chapterId;
  const isCentralDoc = docChapter === CENTRAL || docChapter === undefined;
  if (!doc || (docChapter !== chapterId && !(opts.allowCentral && isCentralDoc))) {
    throw new ConvexError({
      code: "NOT_FOUND",
      message: `${label} not found in your chapter.`,
    });
  }
  return doc as Doc<T>;
}

/** True iff a transaction contributes to category / budget / actual SPEND. */
function isSpend(tr: Doc<"transactions">): boolean {
  return (
    tr.flow === "outflow" &&
    countsAsSpend(tr.flow) &&
    tr.status !== "excluded" &&
    tr.isPersonal !== true
  );
}

// ── Period helpers (Eastern-time bucketing) ──────────────────────────────────
/** True iff a timestamp falls in the given Eastern year (+ optional month/quarter). */
function inPeriod(
  postedAt: number,
  year: number,
  month?: number,
  quarter?: number,
): boolean {
  const p = easternParts(postedAt);
  if (p.year !== year) return false;
  if (month != null && p.month !== month) return false;
  if (quarter != null && quarterOfMonth(p.month) !== quarter) return false;
  return true;
}

/**
 * Read the chapter's transactions for a year (optionally a single month),
 * bounded via the `by_chapter_and_postedAt` range. The UTC window is padded a
 * day on each side to cover the Eastern offset; callers narrow precisely with
 * `inPeriod`.
 *
 * NOTE (scale): the read is capped at `ROLLUP_SCAN_LIMIT`. Past that many
 * transactions in one period the aggregate is truncated (a non-silent
 * `console.warn` fires). Accurate aggregation at high sync volume lands with the
 * Increase/Stripe sync phases (denormalized counters), not now.
 */
async function loadPeriodTxns(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
  year: number,
  sandboxMode: boolean,
  month?: number,
): Promise<Doc<"transactions">[]> {
  const startUtc =
    (month != null ? Date.UTC(year, month - 1, 1) : Date.UTC(year, 0, 1)) -
    DAY_MS;
  const endUtc =
    (month != null ? Date.UTC(year, month, 1) : Date.UTC(year + 1, 0, 1)) +
    DAY_MS;
  const rows = await ctx.db
    .query("transactions")
    .withIndex("by_chapter_and_postedAt", (q) =>
      q.eq("chapterId", chapterId).gte("postedAt", startUtc).lt("postedAt", endUtc),
    )
    .take(ROLLUP_SCAN_LIMIT);
  if (rows.length === ROLLUP_SCAN_LIMIT) {
    console.warn(
      `[finances] period read hit ROLLUP_SCAN_LIMIT (${ROLLUP_SCAN_LIMIT}) for chapter ${chapterId} ${year}${month ? `-${month}` : ""}; aggregate truncated until sync-volume counters land.`,
    );
  }
  return rows.filter((tr) => txnMatchesMode(tr, sandboxMode));
}

/**
 * Defensive environment filter for transaction reads. Drops `increase_card` /
 * `increase_ach` txns whose Increase external/source id belongs to the OTHER
 * environment than the current mode (a `sandbox_` id while in production, or
 * vice-versa). A null id, or any non-Increase source (manual / reimbursement /
 * repayment / stripe_fc), is environment-NEUTRAL and always kept.
 *
 * NOTE: no code inserts `increase_*` transactions yet, so this is a LATENT-leak
 * guard — a no-op today, in place before the Increase sync phase lands.
 */
function txnMatchesMode(tr: Doc<"transactions">, sandboxMode: boolean): boolean {
  if (tr.source !== "increase_card" && tr.source !== "increase_ach") return true;
  return matchesMode(tr.externalId ?? tr.sourceAccountId ?? null, sandboxMode);
}

/**
 * The period a budget's spend is measured over, resolved against the dashboard's
 * `contextMonth`. A MONTHLY budget stored as "$2,000/mo" carries no `month`, so
 * without this it would (wrongly) match all 12 months — its spend is scoped to
 * the queried month. Quarterly → the quarter of the queried month; yearly → the
 * whole year; per-instance / one-off use the budget's OWN declared period.
 */
function budgetEffectivePeriod(
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
    default:
      return { year, month: b.month ?? undefined, quarter: b.quarter ?? undefined };
  }
}

/**
 * A budget's v2 `type`, tolerant of un-migrated legacy rows: a row without a
 * `type` yet derives one from its legacy `scope` (event/project → one_time,
 * everything else → recurring), so dashboards keep working before the backfill.
 */
function effectiveType(b: Doc<"budgets">): BudgetType {
  if (b.type) return b.type;
  return b.scope === "event" || b.scope === "project" ? "one_time" : "recurring";
}

/** A one_time budget's ref kind, deriving from legacy `scope` when unset. */
function effectiveRefKind(b: Doc<"budgets">): BudgetRefKind | null {
  if (b.refKind) return b.refKind;
  if (b.scope === "event") return "event";
  if (b.scope === "project") return "project";
  return null;
}

/**
 * Does a spend transaction fall within a budget's period + narrowers, and (for
 * one_time budgets) its event/project instance? Switches on `type`: a one_time
 * budget matches only its `scopeRefId` instance; a recurring budget matches on
 * period + fund/category alone. Tags are NOT a match dimension. `contextMonth`
 * scopes recurring budgets to the dashboard's month (see `budgetEffectivePeriod`).
 */
function matchesBudget(
  tr: Doc<"transactions">,
  b: Doc<"budgets">,
  contextMonth?: number,
): boolean {
  if (!isSpend(tr)) return false;
  const period = budgetEffectivePeriod(b, contextMonth);
  if (!inPeriod(tr.postedAt, period.year, period.month, period.quarter)) return false;
  return matchesBudgetNarrowers(tr, b);
}

/**
 * The NON-PERIOD half of derived budget matching: a spend txn's fund / category /
 * legacy-team narrowers and (for one_time budgets) its event/project instance.
 * Split out so the YTD path can reuse the exact same narrowers with a widened
 * period window (see `txnCountsTowardBudgetDash`). Tags are NOT a match dimension.
 */
function matchesBudgetNarrowers(tr: Doc<"transactions">, b: Doc<"budgets">): boolean {
  if (b.categoryId && tr.categoryId !== b.categoryId) return false;
  if (b.fundId && tr.fundId !== b.fundId) return false;
  // Legacy team narrower still honored when present (migrated team budgets keep
  // `teamId` as a legacy column; new recurring budgets don't set it).
  if (b.teamId && tr.teamId !== b.teamId) return false;
  if (effectiveType(b) === "one_time" && b.scopeRefId) {
    if (effectiveRefKind(b) === "project") {
      if (tr.projectId !== b.scopeRefId) return false;
    } else {
      // Default (event) instance link.
      if (tr.eventId !== b.scopeRefId) return false;
    }
  }
  // recurring: no extra instance link beyond fund/category/team.
  return true;
}

/**
 * The single budget-attribution rule, used by EVERY actuals sum so a dollar is
 * counted the same way everywhere:
 *   - an EXPLICITLY-linked txn (`budgetId` set) counts toward EXACTLY that
 *     budget and no other — it never also derive-matches a different budget
 *     (the anti-double-count guarantee). The link resolves WHICH budget
 *     (central-vs-chapter disambiguation), but the budget's own cadence still
 *     determines the period window, exactly like `matchesBudget`: a March
 *     purchase linked to a MONTHLY budget lands in March (not every month), a
 *     project / one_off budget counts over its declared period, and an event /
 *     per_instance budget only within that instance. Without this the central
 *     roll-up (read across all time via `by_budget`) would sum lifetime spend
 *     instead of the queried period.
 *   - an UNLINKED txn keeps the existing derived matching (scope/period/fund…).
 *
 * The `isSpend` gate applies to BOTH paths, so `transfer` / `excluded` /
 * personal rows stay out of every budget total even when explicitly linked
 * (the flow-carries-direction + transfer-excluded invariants hold regardless of
 * an explicit link).
 */
function txnCountsTowardBudget(
  tr: Doc<"transactions">,
  b: Doc<"budgets">,
  contextMonth?: number,
): boolean {
  if (tr.budgetId != null) {
    if (!isSpend(tr) || tr.budgetId !== b._id) return false;
    const period = budgetEffectivePeriod(b, contextMonth);
    return inPeriod(tr.postedAt, period.year, period.month, period.quarter);
  }
  return matchesBudget(tr, b, contextMonth);
}

// ── Dashboard period (Month ↔ Year-to-date) ──────────────────────────────────
/**
 * The dashboard's selected period. `month` is always the THROUGH-month (the one
 * the stepper selects). In `"month"` mode the dashboard reports only that month;
 * in `"ytd"` mode it reports the cumulative Jan..throughMonth range of the year.
 * Every spend/actual aggregation reads this so the two modes stay in lock-step.
 */
type PeriodMode = "month" | "ytd";
type DashPeriod = { year: number; month: number; ytd: boolean };

/** True iff a timestamp falls in the dashboard's period: one month, or Jan..throughMonth (YTD). */
function inDashRange(postedAt: number, dp: DashPeriod): boolean {
  const p = easternParts(postedAt);
  if (p.year !== dp.year) return false;
  if (!dp.ytd) return p.month === dp.month;
  return p.month >= 1 && p.month <= dp.month;
}

/**
 * The YTD window for a budget's spend: the txn is in the budget's year, on or
 * before the through-month, and honors the budget's OWN fixed narrowers (a
 * fixed-month or fixed-quarter budget only matches its month/quarter). This
 * widens the single-month/quarter window that `budgetEffectivePeriod` +
 * `inPeriod` apply in month mode to the cumulative 1..throughMonth range for
 * period-scoped (month-null / quarter-null / yearly) budgets, without ever
 * double-counting a fixed-period budget.
 */
function inYtdBudgetWindow(postedAt: number, b: Doc<"budgets">, throughMonth: number): boolean {
  const p = easternParts(postedAt);
  if (p.year !== b.year) return false;
  if (p.month > throughMonth) return false;
  if (b.month != null && p.month !== b.month) return false;
  if (b.quarter != null && quarterOfMonth(p.month) !== b.quarter) return false;
  return true;
}

/**
 * The single budget-attribution rule, period-aware for the dashboard: in
 * `"month"` mode it defers to `txnCountsTowardBudget` (unchanged); in `"ytd"`
 * mode it keeps the exact same `isSpend` gate + linked/derived narrowers but
 * widens the period window to Jan..throughMonth (`inYtdBudgetWindow`).
 */
function txnCountsTowardBudgetDash(
  tr: Doc<"transactions">,
  b: Doc<"budgets">,
  dp: DashPeriod,
): boolean {
  if (!dp.ytd) return txnCountsTowardBudget(tr, b, dp.month);
  if (!isSpend(tr)) return false;
  if (tr.budgetId != null) {
    if (tr.budgetId !== b._id) return false;
  } else if (!matchesBudgetNarrowers(tr, b)) {
    return false;
  }
  return inYtdBudgetWindow(tr.postedAt, b, dp.month);
}

/** Is a recurring budget active anywhere in the dashboard period (any month for YTD)? */
function recurringAppliesToDash(b: Doc<"budgets">, dp: DashPeriod): boolean {
  if (!dp.ytd) return recurringAppliesToMonth(b, dp.year, dp.month);
  for (let m = 1; m <= dp.month; m++) {
    if (recurringAppliesToMonth(b, dp.year, m)) return true;
  }
  return false;
}

/**
 * A budget's month-equivalent allocation for the dashboard period: one month in
 * `"month"` mode (identical to `monthEquivalentBudgetCents`), or the sum across
 * months 1..throughMonth in `"ytd"` mode — so "spent vs allocated" stays
 * comparable when spend is accumulated YTD.
 */
function monthEquivForDash(b: Doc<"budgets">, dp: DashPeriod): number {
  if (!dp.ytd) return monthEquivalentBudgetCents(b, dp.year, dp.month);
  let sum = 0;
  for (let m = 1; m <= dp.month; m++) sum += monthEquivalentBudgetCents(b, dp.year, m);
  return sum;
}

/**
 * A recurring/tag budget's ALLOCATION for the dashboard period. Month mode keeps
 * the existing full stored amount; YTD sums the per-month allocation across
 * months 1..throughMonth (per-period budgets scale, a fixed one_time lump does
 * not). Feeds the recurring cards' + tag rollups' `budgetCents`.
 */
function budgetAllocationForDash(b: Doc<"budgets">, dp: DashPeriod): number {
  if (!dp.ytd) return b.amountCents;
  if (effectiveType(b) !== "recurring") return b.amountCents;
  return monthEquivForDash(b, dp);
}

/** Translate a client patch: `null` clears the field, `undefined` is untouched. */
function cleanPatch(patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(patch)) {
    if (val === undefined) continue;
    out[k] = val === null ? undefined : val;
  }
  return out;
}

/** Resolve the caller's chapter for a READ (null → empty result, no throw). */
async function readChapterId(
  ctx: QueryCtx,
): Promise<Id<"chapters"> | null> {
  const id = await getChapterIdOrNull(ctx);
  return (id as Id<"chapters"> | null) ?? null;
}

/** The next sort order for a chapter-scoped list (max existing + 1). */
async function nextSortOrder(
  ctx: MutationCtx,
  rows: { sortOrder?: number }[],
): Promise<number> {
  let max = -1;
  for (const r of rows) if ((r.sortOrder ?? 0) > max) max = r.sortOrder ?? 0;
  return max + 1;
}

// ── Budget tags (managed, level-scoped) ──────────────────────────────────────
/** A budget's LEVEL: a real chapter id, or the CENTRAL sentinel. */
type BudgetLevel = Id<"chapters"> | typeof CENTRAL;

/**
 * True iff a tag at `tagLevel` may be attached to a budget at `budgetLevel`:
 * a chapter budget accepts its own chapter's tags OR central tags; a central
 * budget accepts only central tags.
 */
function tagLevelAllowed(tagLevel: BudgetLevel, budgetLevel: BudgetLevel): boolean {
  if (budgetLevel === CENTRAL) return tagLevel === CENTRAL;
  return tagLevel === budgetLevel || tagLevel === CENTRAL;
}

/** Load a tag and assert it's usable at the budget's level, else throw. */
async function requireTagInLevel(
  ctx: QueryCtx,
  budgetLevel: BudgetLevel,
  tagId: Id<"budgetTags">,
): Promise<Doc<"budgetTags">> {
  const tag = await ctx.db.get(tagId);
  if (!tag || !tagLevelAllowed(tag.chapterId, budgetLevel)) {
    throw new ConvexError({
      code: "NOT_FOUND",
      message: "Tag not found at this budget's level.",
    });
  }
  return tag;
}

/**
 * Find-or-create a managed tag at a level. Dedups by (level, kind, refId) via
 * `by_chapter_and_ref` when a `refId` is given, else by (name, kind) within the
 * level. Used by the event auto-tag on create + the scope→type migration.
 */
export async function ensureTag(
  ctx: MutationCtx,
  args: {
    chapterId: BudgetLevel;
    name: string;
    kind: (typeof BUDGET_TAG_KINDS)[number];
    refId?: string;
    createdBy?: Id<"users">;
  },
): Promise<Id<"budgetTags">> {
  if (args.refId) {
    const byRef = await ctx.db
      .query("budgetTags")
      .withIndex("by_chapter_and_ref", (q) =>
        q.eq("chapterId", args.chapterId).eq("kind", args.kind).eq("refId", args.refId),
      )
      .first();
    if (byRef) return byRef._id;
  }
  const byName = (
    await ctx.db
      .query("budgetTags")
      .withIndex("by_chapter", (q) => q.eq("chapterId", args.chapterId))
      .take(ROLLUP_SCAN_LIMIT)
  ).find((t) => t.name === args.name && t.kind === args.kind);
  if (byName) return byName._id;
  return await ctx.db.insert("budgetTags", {
    chapterId: args.chapterId,
    name: args.name,
    kind: args.kind,
    refId: args.refId,
    createdBy: args.createdBy,
    createdAt: Date.now(),
  });
}

/** Insert a budget↔tag link unless one already exists in `seen`. */
async function linkBudgetTag(
  ctx: MutationCtx,
  budgetId: Id<"budgets">,
  budgetLevel: BudgetLevel,
  tagId: Id<"budgetTags">,
  seen: Set<string>,
): Promise<void> {
  if (seen.has(tagId)) return;
  seen.add(tagId);
  await ctx.db.insert("budgetTagLinks", {
    budgetId,
    tagId,
    chapterId: budgetLevel,
    createdAt: Date.now(),
  });
}

/**
 * Auto-tag a one_time EVENT budget: ensure + link the event's eventType
 * `template` tag AND a catch-all `events` tag. No-op if `scopeRefId` doesn't
 * resolve to an event. Shared by `createBudget` and the migration.
 */
async function autoTagEventBudget(
  ctx: MutationCtx,
  budgetId: Id<"budgets">,
  budgetLevel: BudgetLevel,
  scopeRefId: string | undefined,
  seen: Set<string>,
  createdBy?: Id<"users">,
): Promise<void> {
  const eventsTag = await ensureTag(ctx, {
    chapterId: budgetLevel,
    name: "Events",
    kind: "events",
    createdBy,
  });
  await linkBudgetTag(ctx, budgetId, budgetLevel, eventsTag, seen);
  if (!scopeRefId) return;
  const ev = await ctx.db.get(scopeRefId as Id<"events">);
  if (!ev || !("eventTypeId" in ev)) return;
  const et = await ctx.db.get((ev as Doc<"events">).eventTypeId);
  if (!et) return;
  const templateTag = await ensureTag(ctx, {
    chapterId: budgetLevel,
    name: (et as Doc<"eventTypes">).name,
    kind: "template",
    refId: (ev as Doc<"events">).eventTypeId,
    createdBy,
  });
  await linkBudgetTag(ctx, budgetId, budgetLevel, templateTag, seen);
}

/** Load a budget's linked tags as `{ id, name, kind }`, via `by_budget`. */
async function loadBudgetTags(
  ctx: QueryCtx,
  budgetId: Id<"budgets">,
  tagCache: Map<string, Doc<"budgetTags"> | null>,
): Promise<{ id: Id<"budgetTags">; name: string; kind: (typeof BUDGET_TAG_KINDS)[number] | null }[]> {
  const links = await ctx.db
    .query("budgetTagLinks")
    .withIndex("by_budget", (q) => q.eq("budgetId", budgetId))
    .take(ROLLUP_SCAN_LIMIT);
  const out: { id: Id<"budgetTags">; name: string; kind: (typeof BUDGET_TAG_KINDS)[number] | null }[] = [];
  for (const link of links) {
    let tag = tagCache.get(link.tagId);
    if (tag === undefined) {
      tag = await ctx.db.get(link.tagId);
      tagCache.set(link.tagId, tag);
    }
    if (tag) out.push({ id: tag._id, name: tag.name, kind: tag.kind ?? null });
  }
  return out;
}

// ── Dashboard math + name resolution ─────────────────────────────────────────
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/** `YYYY-MM-DD` in America/New_York (the finance timezone). */
function easternDateStr(ts: number): string {
  return new Date(ts).toLocaleDateString("en-CA", {
    timeZone: "America/New_York",
  });
}

/** Integer percent spent-of-budget (0 when the budget is 0). */
function pctOf(spent: number, budget: number): number {
  if (budget <= 0) return 0;
  return Math.round((spent / budget) * 100);
}

/** A budget is "warn" once ≥80% spent, else "ok". */
function statusFor(pct: number): "ok" | "warn" {
  return pct >= 80 ? "warn" : "ok";
}

/** A capped 0–100 bar percentage for a part of a whole. */
function barPctOf(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.min(100, Math.round((part / whole) * 100));
}

/** Sum the SPEND amount of a list of transactions. */
function sumSpend(txns: Doc<"transactions">[]): number {
  return txns.reduce((s, tr) => (isSpend(tr) ? s + tr.amountCents : s), 0);
}

/**
 * The spent total + per-category breakdown for one budget, from an already-
 * loaded year of transactions. `catName` resolves category ids to names. `dp`
 * scopes recurring (monthly/quarterly) budgets to the dashboard's period: a
 * single month (so a "$2,000/mo" budget reports one month's spend) in month
 * mode, or the cumulative Jan..throughMonth range in YTD mode.
 */
function budgetSpendBreakdown(
  b: Doc<"budgets">,
  yearTxns: Doc<"transactions">[],
  catName: Map<Id<"budgetCategories">, string>,
  dp: DashPeriod,
): {
  spentCents: number;
  categories: { name: string; spentCents: number; barPct: number }[];
} {
  const matching = yearTxns.filter((tr) => txnCountsTowardBudgetDash(tr, b, dp));
  const spentCents = matching.reduce((s, tr) => s + tr.amountCents, 0);
  const byCat = new Map<string, number>();
  for (const tr of matching) {
    const key = tr.categoryId ? catName.get(tr.categoryId) ?? "Uncategorized" : "Uncategorized";
    byCat.set(key, (byCat.get(key) ?? 0) + tr.amountCents);
  }
  const denom = b.amountCents > 0 ? b.amountCents : spentCents;
  const categories = [...byCat.entries()]
    .sort((a, c) => c[1] - a[1])
    .map(([name, cents]) => ({
      name,
      spentCents: cents,
      barPct: barPctOf(cents, denom),
    }));
  return { spentCents, categories };
}

/** Is a recurring budget active for the dashboard's {year, month}? */
function recurringAppliesToMonth(
  b: Doc<"budgets">,
  year: number,
  month: number,
): boolean {
  if (b.year !== year) return false;
  if (b.month != null && b.month !== month) return false;
  if (b.quarter != null && quarterOfMonth(month) !== b.quarter) return false;
  return true;
}

/**
 * A budget's allocation NORMALIZED to one month, so a single month of actual
 * spend compares apples-to-apples: monthly → full amount, quarterly → ÷3,
 * yearly → ÷12, per-instance / one-off → the full amount only when the budget's
 * own period includes this month (else 0). Used by the central chapter roll-up
 * to avoid comparing one month of spend against a full year of mixed budgets.
 */
function monthEquivalentBudgetCents(
  b: Doc<"budgets">,
  year: number,
  month: number,
): number {
  if (b.year !== year) return 0;
  if (b.quarter != null && quarterOfMonth(month) !== b.quarter) return 0;
  switch (b.cadence) {
    case "monthly":
      if (b.month != null && b.month !== month) return 0;
      return b.amountCents;
    case "quarterly":
      return Math.round(b.amountCents / 3);
    case "yearly":
      return Math.round(b.amountCents / 12);
    case "per_instance":
    case "one_off":
    default:
      if (b.month != null && b.month !== month) return 0;
      return b.amountCents;
  }
}

/** A tiny read-through name cache for a table's display name. */
function nameCache<T extends "events" | "projects" | "people" | "cards" | "eventTypes">(
  ctx: QueryCtx,
  table: T,
) {
  const cache = new Map<string, Doc<T> | null>();
  return async (id: Id<T>): Promise<Doc<T> | null> => {
    const hit = cache.get(id);
    if (hit !== undefined) return hit;
    const doc = (await ctx.db.get(id)) as Doc<T> | null;
    cache.set(id, doc);
    return doc;
  };
}

// ── Dashboards ───────────────────────────────────────────────────────────────

/**
 * The chapter finance dashboard (prototype shape): month tiles, project /
 * recurring budget cards joined to actual spend, enriched recent transactions,
 * an attention queue (empty until Phases 3+5), plus the fund balances.
 *
 * `{year, month}` default to the current Eastern month so the UI's month
 * stepper can page through history. `period` toggles between the selected month
 * (`"month"`, default) and the cumulative year-to-date range through that month
 * (`"ytd"`); `month` is always the through-month.
 */
export const dashboardChapter = query({
  args: {
    year: v.optional(v.number()),
    month: v.optional(v.number()),
    period: v.optional(v.union(v.literal("month"), v.literal("ytd"))),
  },
  returns: v.object({
    tiles: v.array(chapterTile),
    oneTimeBudgets: v.array(projectBudgetCard),
    recurringBudgets: v.array(recurringBudgetCard),
    tagRollups: v.array(tagRollupRow),
    recentTransactions: v.array(recentTxnCard),
    attention: v.array(attentionItem),
    funds: v.array(fundPeriodSpend),
    // Count of spend txns with no budget attributed (bounded scan). Drives the
    // "N transactions need a budget" attention item — a SOFT warning, never a block.
    toBudgetCount: v.number(),
  }),
  handler: async (ctx, args) => {
    const now = easternParts(Date.now());
    const year = args.year ?? now.year;
    const month = args.month ?? now.month;
    const ytd = (args.period ?? "month") === "ytd";
    const dp: DashPeriod = { year, month, ytd };
    // The tile meta: the month name for month mode; a "year-to-date" label for YTD.
    const periodMeta = ytd
      ? `Jan–${MONTH_NAMES[month - 1]} ${year} · year-to-date`
      : `${MONTH_NAMES[month - 1]} ${year}`;
    // The Spent tile's period label suffix.
    const spentSuffix = ytd ? "YTD" : MONTH_NAMES[month - 1];

    const empty = {
      tiles: [] as never[],
      oneTimeBudgets: [] as never[],
      recurringBudgets: [] as never[],
      tagRollups: [] as never[],
      recentTransactions: [] as never[],
      attention: [] as never[],
      funds: [] as never[],
      toBudgetCount: 0,
    };
    const chapterId = await readChapterId(ctx);
    if (!chapterId) return empty;
    await requireFinanceRole(ctx, chapterId, "viewer");

    // One period read for the year drives every budget's actual + the period tile.
    const sandboxMode = await readSandbox(ctx);
    const yearTxns = await loadPeriodTxns(ctx, chapterId, year, sandboxMode);
    // The dashboard period's txns: the selected month, or Jan..throughMonth (YTD).
    const periodTxns = yearTxns.filter((tr) => inDashRange(tr.postedAt, dp));
    const periodSpendCents = sumSpend(periodTxns);

    // Category-name map (chapter-wide, bounded) for budget breakdowns.
    const categoryDocs = await ctx.db
      .query("budgetCategories")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
      .take(ROLLUP_SCAN_LIMIT);
    const catName = new Map(categoryDocs.map((c) => [c._id, c.name] as const));
    const getEvent = nameCache(ctx, "events");
    const getProject = nameCache(ctx, "projects");

    const budgets = await ctx.db
      .query("budgets")
      .withIndex("by_chapter_and_period", (q) =>
        q.eq("chapterId", chapterId).eq("year", year),
      )
      .take(ROLLUP_SCAN_LIMIT);

    // One-time (event / project) budget cards (per-instance / one-off).
    const oneTimeBudgets: (typeof projectBudgetCard.type)[] = [];
    for (const b of budgets) {
      if (effectiveType(b) !== "one_time") continue;
      const refKind = effectiveRefKind(b);
      const { spentCents, categories } = budgetSpendBreakdown(b, yearTxns, catName, dp);
      let name = b.label ?? "One-time";
      let dateLabel: string | null = null;
      if (refKind === "event" && b.scopeRefId) {
        const ev = await getEvent(b.scopeRefId as Id<"events">);
        if (ev) {
          name = ev.name;
          dateLabel = easternDateStr(ev.eventDate);
        }
      } else if (refKind === "project" && b.scopeRefId) {
        const pr = await getProject(b.scopeRefId as Id<"projects">);
        if (pr) {
          name = pr.name;
          dateLabel = pr.deadline ? easternDateStr(pr.deadline) : null;
        }
      }
      const pct = pctOf(spentCents, b.amountCents);
      oneTimeBudgets.push({
        id: b._id,
        name,
        cadence: b.cadence === "per_instance" ? "per_instance" : "one_off",
        sourceBadge: null,
        dateLabel,
        subtitle: null,
        spentCents,
        budgetCents: b.amountCents,
        pct,
        remainingCents: b.amountCents - spentCents,
        status: statusFor(pct),
        categories,
      });
    }

    // Recurring bucket / team / chapter budget cards active this month.
    const teamDocs = await ctx.db
      .query("financeTeams")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
      .take(ROLLUP_SCAN_LIMIT);
    const teamName = new Map(teamDocs.map((t) => [t._id, t.name] as const));
    const recurringBudgets: (typeof recurringBudgetCard.type)[] = [];
    for (const b of budgets) {
      const isRecurringCadence =
        b.cadence === "monthly" || b.cadence === "quarterly" || b.cadence === "yearly";
      if (effectiveType(b) !== "recurring" || !isRecurringCadence) continue;
      if (!recurringAppliesToDash(b, dp)) continue;
      // Scope recurring spend to the dashboard period: THIS month (fixes
      // "$2,000/mo" showing YTD in month mode), or Jan..throughMonth in YTD mode.
      const { spentCents, categories } = budgetSpendBreakdown(b, yearTxns, catName, dp);
      // Prefer an author label; fall back to a legacy team name, then a generic.
      let name = b.label ?? (b.teamId ? teamName.get(b.teamId) : undefined) ?? "Recurring";
      // Allocation scales with the period in YTD (sum of month-equivalents).
      const budgetCents = budgetAllocationForDash(b, dp);
      const pct = pctOf(spentCents, budgetCents);
      recurringBudgets.push({
        id: b._id,
        name,
        cadence: b.cadence as "monthly" | "quarterly" | "yearly",
        spentCents,
        budgetCents,
        pct,
        status: statusFor(pct),
        categories: categories.length ? categories : undefined,
        note: null,
      });
    }

    // Per-tag rollups: for each chapter tag, sum the linked-txn actuals of every
    // one of THIS year's budgets carrying it (a budget appears in each of its
    // tags' rollups). Reached via `budgetTagLinks` `by_tag`; `budgetById`
    // restricts to this chapter+year so a link to another year/level is skipped.
    const budgetById = new Map(budgets.map((b) => [b._id, b] as const));
    const chapterTags = await ctx.db
      .query("budgetTags")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
      .take(ROLLUP_SCAN_LIMIT);
    const tagRollups: (typeof tagRollupRow.type)[] = [];
    for (const tag of chapterTags) {
      const links = await ctx.db
        .query("budgetTagLinks")
        .withIndex("by_tag", (q) => q.eq("tagId", tag._id))
        .take(ROLLUP_SCAN_LIMIT);
      // The DISTINCT budgets of this chapter+year carrying the tag.
      const tagBudgets = new Map<Id<"budgets">, Doc<"budgets">>();
      for (const link of links) {
        const b = budgetById.get(link.budgetId);
        if (b) tagBudgets.set(b._id, b);
      }
      if (tagBudgets.size === 0) continue;
      let budgetCents = 0;
      for (const b of tagBudgets.values()) budgetCents += budgetAllocationForDash(b, dp);
      // Tag totals are LINKED-ONLY: count only txns EXPLICITLY linked
      // (`budgetId`) to a budget carrying the tag — NO derived matching. A linked
      // txn has exactly one `budgetId`, so it's counted once (no dedup needed).
      // `txnCountsTowardBudgetDash` still applies the `isSpend` gate + the linked
      // budget's period window (widened to Jan..throughMonth in YTD).
      let spentCents = 0;
      for (const tr of yearTxns) {
        if (tr.budgetId == null) continue;
        const b = tagBudgets.get(tr.budgetId);
        if (b && txnCountsTowardBudgetDash(tr, b, dp)) spentCents += tr.amountCents;
      }
      const pct = pctOf(spentCents, budgetCents);
      tagRollups.push({
        tagId: tag._id,
        tagName: tag.name,
        kind: tag.kind ?? null,
        budgetCents,
        spentCents,
        pct,
        status: statusFor(pct),
      });
    }
    tagRollups.sort((a, b) => b.spentCents - a.spentCents);

    // Per-fund SPEND for the month (period-bounded; all-time balance is deferred
    // to the Increase sync — an all-time scan silently truncates and isn't in
    // the prototype).
    const fundSpend = new Map<Id<"funds">, number>();
    for (const tr of periodTxns) {
      if (!isSpend(tr) || !tr.fundId) continue;
      fundSpend.set(tr.fundId, (fundSpend.get(tr.fundId) ?? 0) + tr.amountCents);
    }
    const fundDocs = await ctx.db
      .query("funds")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
      .take(ROLLUP_SCAN_LIMIT);
    const funds = fundDocs
      .filter((f) => f.isActive !== false)
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((f) => ({
        id: f._id,
        name: f.name,
        spentCents: fundSpend.get(f._id) ?? 0,
      }));

    // Enriched recent-transaction cards — a small newest-first read (top N only).
    const recent = await ctx.db
      .query("transactions")
      .withIndex("by_chapter_and_postedAt", (q) => q.eq("chapterId", chapterId))
      .order("desc")
      .take(RECENT_TXN_COUNT);
    const fundName = new Map(fundDocs.map((f) => [f._id, f.name] as const));
    const getPerson = nameCache(ctx, "people");
    const recentTransactions: (typeof recentTxnCard.type)[] = [];
    for (const tr of recent) {
      const projName = tr.projectId ? (await getProject(tr.projectId))?.name : undefined;
      const evName = tr.eventId ? (await getEvent(tr.eventId))?.name : undefined;
      const fundOrProject =
        projName ?? evName ?? (tr.fundId ? fundName.get(tr.fundId) : undefined);
      const categoryName = tr.categoryId ? catName.get(tr.categoryId) : undefined;
      const codedTo =
        fundOrProject || categoryName
          ? { fundOrProject: fundOrProject ?? "", category: categoryName ?? "" }
          : null;
      const ai =
        tr.aiSuggestion && (tr.aiSuggestion.fundId || tr.aiSuggestion.categoryId)
          ? {
              fund: tr.aiSuggestion.fundId
                ? fundName.get(tr.aiSuggestion.fundId) ?? ""
                : "",
              category: tr.aiSuggestion.categoryId
                ? catName.get(tr.aiSuggestion.categoryId) ?? ""
                : "",
            }
          : null;
      const spenderName = tr.personId ? (await getPerson(tr.personId))?.name ?? null : null;
      recentTransactions.push({
        id: tr._id,
        date: easternDateStr(tr.postedAt),
        merchant: tr.merchantName ?? null,
        cardLast4: null,
        spenderName,
        timeOrNote: tr.description ?? null,
        codedTo,
        aiSuggestion: ai,
        amountCents: tr.amountCents,
        flow: tr.flow,
        status: tr.status,
      });
    }

    const unreviewed = await ctx.db
      .query("transactions")
      .withIndex("by_chapter_and_status", (q) =>
        q.eq("chapterId", chapterId).eq("status", "unreviewed"),
      )
      .take(ROLLUP_SCAN_LIMIT);

    // Tiles: period spend, a headline project + monthly bucket, and to-review.
    const tiles: (typeof chapterTile.type)[] = [
      {
        label: `Spent · ${spentSuffix}`,
        value: formatCents(periodSpendCents),
        subValueCents: periodSpendCents,
        meta: periodMeta,
      },
    ];
    const topProject = oneTimeBudgets[0];
    if (topProject) {
      tiles.push({
        label: topProject.name,
        value: `${formatCents(topProject.spentCents)} / ${formatCents(topProject.budgetCents)}`,
        subValueCents: topProject.spentCents,
        meta: `per instance · ${topProject.pct}%`,
      });
    }
    const topBucket = recurringBudgets.find((r) => r.cadence === "monthly");
    if (topBucket) {
      tiles.push({
        label: topBucket.name,
        value: `${formatCents(topBucket.spentCents)} / ${formatCents(topBucket.budgetCents)}`,
        subValueCents: topBucket.spentCents,
        meta: `monthly · ${topBucket.pct}%`,
      });
    }
    tiles.push({
      label: "To review",
      value: String(unreviewed.length),
      meta: "transactions",
    });

    // SOFT attribution attention: count the chapter's spend txns with no budget
    // attributed (a bounded, all-time-capped scan — a txn from any period still
    // needs a budget). Powers the "N transactions need a budget" attention row.
    const chapterTxns = await ctx.db
      .query("transactions")
      .withIndex("by_chapter_and_postedAt", (q) => q.eq("chapterId", chapterId))
      .take(ROLLUP_SCAN_LIMIT);
    const toBudgetCount = chapterTxns.reduce(
      (n, tr) => (isSpend(tr) && tr.budgetId == null ? n + 1 : n),
      0,
    );

    return {
      tiles,
      oneTimeBudgets,
      recurringBudgets,
      tagRollups,
      recentTransactions,
      attention: [],
      funds,
      toBudgetCount,
    };
  },
});

/**
 * The org-wide roll-up (prototype shape, central finance only): global tiles, a
 * by-TAG rollup across chapters, and a by-chapter rollup — all for the
 * given `{year, month}` (default current Eastern month). Member data stays out.
 */
export const dashboardCentral = query({
  args: {
    year: v.optional(v.number()),
    month: v.optional(v.number()),
    period: v.optional(v.union(v.literal("month"), v.literal("ytd"))),
  },
  returns: v.object({
    tiles: v.array(centralTile),
    tagRollups: v.array(tagRollupRow),
    chapterRollup: v.array(chapterRollupRow),
    centralBudgets: v.array(centralBudgetCard),
    // The org-wide SPEND total for the dashboard period: the selected month, or
    // the cumulative Jan..throughMonth range in YTD mode.
    totalMonthSpendCents: v.number(),
  }),
  handler: async (ctx, args) => {
    const now = easternParts(Date.now());
    const year = args.year ?? now.year;
    const month = args.month ?? now.month;
    const ytd = (args.period ?? "month") === "ytd";
    const dp: DashPeriod = { year, month, ytd };
    const spentSuffix = ytd ? "YTD" : MONTH_NAMES[month - 1];

    const empty = {
      tiles: [] as never[],
      tagRollups: [] as never[],
      chapterRollup: [] as never[],
      centralBudgets: [] as never[],
      totalMonthSpendCents: 0,
    };
    const chapterId = await readChapterId(ctx);
    if (!chapterId) return empty;
    await requireFinanceCentral(ctx, chapterId);

    const chapters = await ctx.db.query("chapters").take(ROLLUP_SCAN_LIMIT);
    // Read the env flag once for the whole cross-chapter rollup.
    const sandboxMode = await readSandbox(ctx);

    let totalMonthSpendCents = 0;
    let activeChapters = 0;
    let toReviewOrg = 0;

    const chapterRollup: (typeof chapterRollupRow.type)[] = [];
    // Across-chapter by-tag aggregation, keyed by (kind, name) so same-named
    // tags in different chapters merge into one org rollup row.
    const tagAgg = new Map<
      string,
      {
        name: string;
        kind: (typeof BUDGET_TAG_KINDS)[number] | null;
        spentCents: number;
        budgetCents: number;
      }
    >();

    for (const chapter of chapters) {
      if (chapter.isActive !== false) activeChapters++;

      // Period-bounded read (this year), narrowed to the dashboard period (the
      // selected month, or Jan..throughMonth in YTD).
      const periodTxns = await loadPeriodTxns(ctx, chapter._id, year, sandboxMode);
      const dashTxns = periodTxns.filter((tr) => inDashRange(tr.postedAt, dp));
      const chapterPeriodSpend = sumSpend(dashTxns);
      totalMonthSpendCents += chapterPeriodSpend;

      // Month-equivalent budget allocation (monthly→amount, quarterly→÷3,
      // yearly→÷12, per-instance→in-period only) — comparable to one month of
      // actual spend, unlike a raw full-year sum of mixed cadences. In YTD it's
      // summed across months 1..throughMonth to match the accumulated spend.
      const chBudgets = await ctx.db
        .query("budgets")
        .withIndex("by_chapter_and_period", (q) =>
          q.eq("chapterId", chapter._id).eq("year", year),
        )
        .take(ROLLUP_SCAN_LIMIT);
      const budgetCents = chBudgets.reduce(
        (s, b) => s + monthEquivForDash(b, dp),
        0,
      );

      // Tag attribution: for each of this chapter's tags, sum the linked-txn
      // actuals of its year budgets, then merge into the org-wide by-tag agg.
      const chBudgetById = new Map(chBudgets.map((b) => [b._id, b] as const));
      const chTags = await ctx.db
        .query("budgetTags")
        .withIndex("by_chapter", (q) => q.eq("chapterId", chapter._id))
        .take(ROLLUP_SCAN_LIMIT);
      for (const tag of chTags) {
        const links = await ctx.db
          .query("budgetTagLinks")
          .withIndex("by_tag", (q) => q.eq("tagId", tag._id))
          .take(ROLLUP_SCAN_LIMIT);
        const tagBudgets = new Map<Id<"budgets">, Doc<"budgets">>();
        for (const link of links) {
          const b = chBudgetById.get(link.budgetId);
          if (b) tagBudgets.set(b._id, b);
        }
        if (tagBudgets.size === 0) continue;
        let budget = 0;
        for (const b of tagBudgets.values()) budget += budgetAllocationForDash(b, dp);
        // Tag totals are LINKED-ONLY (see dashboardChapter): only txns
        // explicitly linked to a budget carrying the tag count — no derived
        // matching. One `budgetId` per txn → counted once, no dedup.
        let spent = 0;
        for (const tr of periodTxns) {
          if (tr.budgetId == null) continue;
          const b = tagBudgets.get(tr.budgetId);
          if (b && txnCountsTowardBudgetDash(tr, b, dp)) spent += tr.amountCents;
        }
        const key = `${tag.kind ?? ""}::${tag.name}`;
        const agg =
          tagAgg.get(key) ??
          { name: tag.name, kind: tag.kind ?? null, spentCents: 0, budgetCents: 0 };
        agg.spentCents += spent;
        agg.budgetCents += budget;
        tagAgg.set(key, agg);
      }

      // Unreviewed count for the org "to review" tile.
      const unreviewed = await ctx.db
        .query("transactions")
        .withIndex("by_chapter_and_status", (q) =>
          q.eq("chapterId", chapter._id).eq("status", "unreviewed"),
        )
        .take(ROLLUP_SCAN_LIMIT);
      toReviewOrg += unreviewed.length;

      const barPct = barPctOf(chapterPeriodSpend, budgetCents);
      chapterRollup.push({
        chapterId: chapter._id,
        chapterName: chapter.name,
        subtitle: null,
        spentCents: chapterPeriodSpend,
        budgetCents,
        barPct,
        status: statusFor(pctOf(chapterPeriodSpend, budgetCents)),
      });
    }

    // Org-level (central) budgets roll up across EVERY chapter: their actual is
    // the sum of all chapters' transactions explicitly linked to them (by
    // `budgetId`). Read via the `by_chapter_and_period` index at the CENTRAL
    // sentinel for this year. Per-chapter rollups above never see these budgets
    // (they query by real chapterId), so their allocation isn't double-counted.
    const centralBudgetDocs = await ctx.db
      .query("budgets")
      .withIndex("by_chapter_and_period", (q) =>
        q.eq("chapterId", CENTRAL).eq("year", year),
      )
      .take(ROLLUP_SCAN_LIMIT);
    const centralBudgetById = new Map(centralBudgetDocs.map((b) => [b._id, b] as const));
    const centralSpentById = new Map<Id<"budgets">, number>();
    const centralBudgets: (typeof centralBudgetCard.type)[] = [];
    for (const cb of centralBudgetDocs) {
      const linked = await ctx.db
        .query("transactions")
        .withIndex("by_budget", (q) => q.eq("budgetId", cb._id))
        .take(ROLLUP_SCAN_LIMIT);
      const spentCents = linked.reduce(
        (s, tr) => (txnCountsTowardBudgetDash(tr, cb, dp) ? s + tr.amountCents : s),
        0,
      );
      centralSpentById.set(cb._id, spentCents);
      // Allocation scales with the period in YTD so spent-vs-allocated stays comparable.
      const budgetCents = budgetAllocationForDash(cb, dp);
      const pct = pctOf(spentCents, budgetCents);
      centralBudgets.push({
        id: cb._id,
        label: cb.label ?? null,
        scope: cb.scope ?? null,
        cadence: cb.cadence,
        year: cb.year,
        budgetCents,
        spentCents,
        pct,
        status: statusFor(pct),
      });
    }

    // Central-level tags roll up too: aggregate central budgets by their tags
    // and merge into the same by-(kind,name) agg as the per-chapter tags. A
    // central budget's actual is its explicitly-linked txns only (already unique
    // per budget, since a txn carries one `budgetId`), so no cross-budget dedup
    // is needed here. Per-chapter tags never see central budgets (chBudgetById
    // is keyed by real chapterId), so there's no double-count.
    const centralTags = await ctx.db
      .query("budgetTags")
      .withIndex("by_chapter", (q) => q.eq("chapterId", CENTRAL))
      .take(ROLLUP_SCAN_LIMIT);
    for (const tag of centralTags) {
      const links = await ctx.db
        .query("budgetTagLinks")
        .withIndex("by_tag", (q) => q.eq("tagId", tag._id))
        .take(ROLLUP_SCAN_LIMIT);
      const tagBudgets = new Map<Id<"budgets">, Doc<"budgets">>();
      for (const link of links) {
        const b = centralBudgetById.get(link.budgetId);
        if (b) tagBudgets.set(b._id, b);
      }
      if (tagBudgets.size === 0) continue;
      let spent = 0;
      let budget = 0;
      for (const b of tagBudgets.values()) {
        spent += centralSpentById.get(b._id) ?? 0;
        budget += budgetAllocationForDash(b, dp);
      }
      const key = `${tag.kind ?? ""}::${tag.name}`;
      const agg =
        tagAgg.get(key) ??
        { name: tag.name, kind: tag.kind ?? null, spentCents: 0, budgetCents: 0 };
      agg.spentCents += spent;
      agg.budgetCents += budget;
      tagAgg.set(key, agg);
    }

    const tagRollups: (typeof tagRollupRow.type)[] = [...tagAgg.values()]
      .sort((a, b) => b.spentCents - a.spentCents)
      .map((agg) => {
        const pct = pctOf(agg.spentCents, agg.budgetCents);
        return {
          tagId: null,
          tagName: agg.name,
          kind: agg.kind,
          budgetCents: agg.budgetCents,
          spentCents: agg.spentCents,
          pct,
          status: statusFor(pct),
        };
      });

    const tiles: (typeof centralTile.type)[] = [
      {
        label: `Spent · ${spentSuffix} · all chapters`,
        value: formatCents(totalMonthSpendCents),
        meta: `${activeChapters} chapters`,
      },
    ];
    const topTag = tagRollups[0];
    if (topTag) {
      tiles.push({
        label: topTag.tagName,
        value: formatCents(topTag.spentCents),
        meta: "across chapters",
      });
    }
    tiles.push({
      label: "Active chapters",
      value: String(activeChapters),
      meta: "org-wide",
    });
    tiles.push({
      label: "To review · org",
      value: String(toReviewOrg),
      meta: "transactions",
    });

    return {
      tiles,
      tagRollups,
      chapterRollup,
      centralBudgets,
      totalMonthSpendCents,
    };
  },
});

/** Budget-vs-actual for a period (year, optionally narrowed to a month). */
export const budgetVsActual = query({
  args: { year: v.number(), month: v.optional(v.number()) },
  returns: v.array(
    v.object({
      budgetId: v.union(v.id("budgets"), v.null()),
      label: v.string(),
      type: v.union(typeValidator, v.null()),
      scope: v.union(scopeValidator, v.null()),
      allocatedCents: v.number(),
      actualCents: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const chapterId = await readChapterId(ctx);
    if (!chapterId) return [];
    await requireFinanceRole(ctx, chapterId, "viewer");

    const budgets = await ctx.db
      .query("budgets")
      .withIndex("by_chapter_and_period", (q) =>
        q.eq("chapterId", chapterId).eq("year", args.year),
      )
      .take(ROLLUP_SCAN_LIMIT);

    // When a month is given, keep month-specific budgets for that month plus
    // year/quarter-level budgets (which have no `month`).
    const relevant =
      args.month == null
        ? budgets
        : budgets.filter((b) => b.month == null || b.month === args.month);

    // One period read (whole year) feeds every budget's actual — ESTIMATED
    // (budget.amountCents) is reported separately, never summed with ACTUAL.
    const sandboxMode = await readSandbox(ctx);
    const periodTxns = await loadPeriodTxns(
      ctx,
      chapterId,
      args.year,
      sandboxMode,
    );

    return relevant.map((b) => {
      // `args.month` scopes recurring budgets to that month (a "$/mo" budget
      // with no stored month otherwise matches all 12 months → YTD spend).
      const actualCents = periodTxns.reduce(
        (sum, tr) =>
          txnCountsTowardBudget(tr, b, args.month ?? undefined) ? sum + tr.amountCents : sum,
        0,
      );
      return {
        budgetId: b._id,
        label: b.label ?? (b.scope ? BUDGET_SCOPE_LABELS[b.scope] : "Budget"),
        type: effectiveType(b),
        scope: b.scope ?? null,
        allocatedCents: b.amountCents,
        actualCents,
      };
    });
  },
});

/** Sum SPEND transactions reachable through a single-column index. */
async function actualsByIndex<
  IndexName extends "by_event" | "by_project" | "by_person",
>(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
  indexName: IndexName,
  field: "eventId" | "projectId" | "personId",
  id: Id<"events"> | Id<"projects"> | Id<"people">,
): Promise<{ totalCents: number; transactions: ReturnType<typeof toTxnSummary>[] }> {
  const raw = await ctx.db
    .query("transactions")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .withIndex(indexName, (q: any) => q.eq(field, id))
    .take(ROLLUP_SCAN_LIMIT);
  // Defense-in-depth: verifyTxnRefs already keeps links same-chapter, but never
  // sum a row from another chapter even if a future link slipped through.
  const rows = raw.filter((tr) => tr.chapterId === chapterId);
  const totalCents = rows.reduce((s, tr) => (isSpend(tr) ? s + tr.amountCents : s), 0);
  return { totalCents, transactions: rows.map(toTxnSummary) };
}

/** Actual spend attached to a single event. */
export const eventActuals = query({
  args: { eventId: v.id("events") },
  returns: v.object({
    totalCents: v.number(),
    transactions: v.array(txnSummary),
  }),
  handler: async (ctx, args) => {
    const chapterId = await readChapterId(ctx);
    if (!chapterId) return { totalCents: 0, transactions: [] };
    await requireFinanceRole(ctx, chapterId, "viewer");
    await requireInCallerChapter(ctx, chapterId, "events", args.eventId, "Event");
    return actualsByIndex(ctx, chapterId, "by_event", "eventId", args.eventId);
  },
});

/** Actual spend attached to a single project. */
export const projectActuals = query({
  args: { projectId: v.id("projects") },
  returns: v.object({
    totalCents: v.number(),
    transactions: v.array(txnSummary),
  }),
  handler: async (ctx, args) => {
    const chapterId = await readChapterId(ctx);
    if (!chapterId) return { totalCents: 0, transactions: [] };
    await requireFinanceRole(ctx, chapterId, "viewer");
    await requireInCallerChapter(ctx, chapterId, "projects", args.projectId, "Project");
    return actualsByIndex(ctx, chapterId, "by_project", "projectId", args.projectId);
  },
});

/** Actual spend attached to a single finance team. */
export const teamActuals = query({
  args: { teamId: v.id("financeTeams") },
  returns: v.object({
    totalCents: v.number(),
    transactions: v.array(txnSummary),
  }),
  handler: async (ctx, args) => {
    const chapterId = await readChapterId(ctx);
    if (!chapterId) return { totalCents: 0, transactions: [] };
    await requireFinanceRole(ctx, chapterId, "viewer");
    // Chapter or central team.
    await requireInCallerChapter(ctx, chapterId, "financeTeams", args.teamId, "Team", {
      allowCentral: true,
    });
    // No dedicated team index on transactions — scan the chapter (bounded) and
    // filter by team.
    const rows = await ctx.db
      .query("transactions")
      .withIndex("by_chapter_and_postedAt", (q) => q.eq("chapterId", chapterId))
      .order("desc")
      .take(ROLLUP_SCAN_LIMIT);
    const forTeam = rows.filter((tr) => tr.teamId === args.teamId);
    const totalCents = forTeam.reduce(
      (s, tr) => (isSpend(tr) ? s + tr.amountCents : s),
      0,
    );
    return { totalCents, transactions: forTeam.map(toTxnSummary) };
  },
});

/** Transactions attached to a person (defaults to the caller when omitted). */
export const personTransactions = query({
  args: { personId: v.optional(v.id("people")) },
  returns: v.array(txnSummary),
  handler: async (ctx, args) => {
    const chapterId = await readChapterId(ctx);
    if (!chapterId) return [];
    await requireFinanceRole(ctx, chapterId, "viewer");

    let personId = args.personId ?? null;
    if (personId) {
      await requireInCallerChapter(ctx, chapterId, "people", personId, "Person");
    } else {
      const self = await viewerPerson(ctx, chapterId);
      personId = self?._id ?? null;
    }
    if (!personId) return [];
    const rows = await ctx.db
      .query("transactions")
      .withIndex("by_person", (q) => q.eq("personId", personId!))
      .take(ROLLUP_SCAN_LIMIT);
    // Defense-in-depth: never leak a row linked from another chapter.
    return rows
      .filter((tr) => tr.chapterId === chapterId)
      .map(toTxnSummary);
  },
});

// ── Funds ────────────────────────────────────────────────────────────────────

export const listFunds = query({
  args: {},
  returns: v.array(fundSummary),
  handler: async (ctx) => {
    const chapterId = await readChapterId(ctx);
    if (!chapterId) return [];
    await requireFinanceRole(ctx, chapterId, "viewer");
    const funds = await ctx.db
      .query("funds")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
      .take(ROLLUP_SCAN_LIMIT);
    return funds
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map(toFundSummary);
  },
});

export const createFund = mutation({
  args: {
    name: v.string(),
    restriction: restrictionValidator,
    code: v.optional(v.string()),
    color: v.optional(v.string()),
    sortOrder: v.optional(v.number()),
  },
  returns: v.id("funds"),
  handler: async (ctx, args) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireFinanceManager(ctx, chapterId);
    const existing = await ctx.db
      .query("funds")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
      .take(ROLLUP_SCAN_LIMIT);
    return await ctx.db.insert("funds", {
      chapterId,
      name: args.name,
      restriction: args.restriction,
      code: args.code,
      color: args.color,
      sortOrder: args.sortOrder ?? (await nextSortOrder(ctx, existing)),
      isActive: true,
      createdAt: Date.now(),
    });
  },
});

export const updateFund = mutation({
  args: {
    fundId: v.id("funds"),
    patch: v.object({
      name: v.optional(v.string()),
      restriction: v.optional(restrictionValidator),
      code: v.optional(v.union(v.string(), v.null())),
      color: v.optional(v.union(v.string(), v.null())),
      sortOrder: v.optional(v.number()),
      isActive: v.optional(v.boolean()),
    }),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireFinanceManager(ctx, chapterId);
    await requireInCallerChapter(ctx, chapterId, "funds", args.fundId, "Fund");
    await ctx.db.patch(args.fundId, cleanPatch(args.patch));
    return null;
  },
});

// ── Categories ────────────────────────────────────────────────────────────────

export const listCategories = query({
  args: { fundId: v.optional(v.id("funds")) },
  returns: v.array(categorySummary),
  handler: async (ctx, args) => {
    const chapterId = await readChapterId(ctx);
    if (!chapterId) return [];
    await requireFinanceRole(ctx, chapterId, "viewer");
    let categories: Doc<"budgetCategories">[];
    if (args.fundId) {
      await requireInCallerChapter(ctx, chapterId, "funds", args.fundId, "Fund");
      categories = await ctx.db
        .query("budgetCategories")
        .withIndex("by_fund", (q) => q.eq("fundId", args.fundId!))
        .take(ROLLUP_SCAN_LIMIT);
    } else {
      categories = await ctx.db
        .query("budgetCategories")
        .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
        .take(ROLLUP_SCAN_LIMIT);
    }
    return categories
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
      .map(toCategorySummary);
  },
});

export const createCategory = mutation({
  args: {
    fundId: v.id("funds"),
    name: v.string(),
    kind: categoryKindValidator,
    parentCategoryId: v.optional(v.id("budgetCategories")),
    sortOrder: v.optional(v.number()),
  },
  returns: v.id("budgetCategories"),
  handler: async (ctx, args) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireFinanceManager(ctx, chapterId);
    await requireInCallerChapter(ctx, chapterId, "funds", args.fundId, "Fund");
    if (args.parentCategoryId) {
      const parent = await requireInCallerChapter(
        ctx,
        chapterId,
        "budgetCategories",
        args.parentCategoryId,
        "Parent category",
      );
      if (parent.fundId !== args.fundId) {
        throw new ConvexError({
          code: "INVALID_PARENT",
          message: "A category's parent must be in the same fund.",
        });
      }
    }
    const existing = await ctx.db
      .query("budgetCategories")
      .withIndex("by_fund", (q) => q.eq("fundId", args.fundId))
      .take(ROLLUP_SCAN_LIMIT);
    return await ctx.db.insert("budgetCategories", {
      chapterId,
      fundId: args.fundId,
      parentCategoryId: args.parentCategoryId,
      name: args.name,
      kind: args.kind,
      sortOrder: args.sortOrder ?? (await nextSortOrder(ctx, existing)),
      isActive: true,
      createdAt: Date.now(),
    });
  },
});

/**
 * Resolve a chapter's General Fund to hang the default categories off of: prefer
 * the "General Fund" by name, else the lowest-sortOrder unrestricted fund, else
 * the lowest-sortOrder fund. Returns `null` for a fund-less chapter.
 */
async function findGeneralFundId(
  ctx: MutationCtx,
  chapterId: Id<"chapters">,
): Promise<Id<"funds"> | null> {
  const funds = await ctx.db
    .query("funds")
    .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
    .take(ROLLUP_SCAN_LIMIT);
  if (funds.length === 0) return null;
  const byName = funds.find((f) => f.name === "General Fund");
  if (byName) return byName._id;
  const byOrder = [...funds].sort((a, b) => a.sortOrder - b.sortOrder);
  const unrestricted = byOrder.find((f) => f.restriction === "unrestricted");
  return (unrestricted ?? byOrder[0])._id;
}

/**
 * The chapter's default operating fund for auto-coding: the unrestricted "General
 * Fund" by name, else the lowest-sortOrder UNRESTRICTED fund, else `null`. Unlike
 * {@link findGeneralFundId} this never falls back to a restricted fund — spend is
 * never silently defaulted into an earmarked bucket. Lets the reconcile grid hide
 * the fund selector while still leaving every coded txn attached to a real fund.
 */
async function defaultFundId(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
): Promise<Id<"funds"> | null> {
  const funds = await ctx.db
    .query("funds")
    .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
    .take(ROLLUP_SCAN_LIMIT);
  const unrestricted = funds
    .filter((f) => f.restriction === "unrestricted")
    .sort((a, b) => a.sortOrder - b.sortOrder);
  if (unrestricted.length === 0) return null;
  return (unrestricted.find((f) => f.name === "General Fund") ?? unrestricted[0])._id;
}

/**
 * Shared: seed one chapter's default funds + expense categories. First ensures
 * the chapter's default funds exist (General Fund + Designated) — so a chapter
 * created before the finance seed (zero funds) is fixed in one shot — then seeds
 * the default categories under its General Fund. Idempotent (skips funds /
 * categories whose names already exist). Returns the count of categories
 * inserted (0 if, unexpectedly, no General Fund can be resolved).
 */
async function seedDefaultCategoriesForChapter(
  ctx: MutationCtx,
  chapterId: Id<"chapters">,
  now: number,
): Promise<number> {
  await ensureDefaultFunds(ctx, chapterId, now);
  const fundId = await findGeneralFundId(ctx, chapterId);
  if (!fundId) return 0;
  return await insertDefaultExpenseCategories(ctx, chapterId, fundId, now);
}

/**
 * Superuser-gated backfill: seed the default expense categories for ONE chapter
 * (the caller's, or an explicit `chapterId` — lets central admins fix existing /
 * prod chapters). Idempotent: names that already exist are skipped, so a chapter
 * that already has the set is a no-op. Reuses {@link seedDefaultCategoriesForChapter}.
 */
export const seedDefaultExpenseCategories = mutation({
  args: { chapterId: v.optional(v.id("chapters")) },
  returns: v.object({ inserted: v.number() }),
  handler: async (ctx, args) => {
    await requireSuperuser(ctx);
    const chapterId =
      args.chapterId ?? ((await requireChapterId(ctx)) as Id<"chapters">);
    const chapter = await ctx.db.get(chapterId);
    if (!chapter) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Chapter not found." });
    }
    const inserted = await seedDefaultCategoriesForChapter(
      ctx,
      chapterId,
      Date.now(),
    );
    return { inserted };
  },
});

/**
 * CLI-runnable (no auth) sibling of {@link seedDefaultExpenseCategories}: seed
 * the defaults for EVERY chapter that currently has no categories. Bounded +
 * idempotent — re-runs skip already-seeded chapters.
 *
 * Run locally:  npx convex run finances:runSeedDefaultExpenseCategories
 * Run on prod:  npx convex run --prod finances:runSeedDefaultExpenseCategories
 */
export const runSeedDefaultExpenseCategories = internalMutation({
  args: {},
  returns: v.object({ chaptersSeeded: v.number(), inserted: v.number() }),
  handler: async (ctx) => {
    const now = Date.now();
    const chapters = await ctx.db.query("chapters").take(ROLLUP_SCAN_LIMIT);
    let chaptersSeeded = 0;
    let inserted = 0;
    for (const c of chapters) {
      const existing = await ctx.db
        .query("budgetCategories")
        .withIndex("by_chapter", (q) => q.eq("chapterId", c._id))
        .take(1);
      if (existing.length > 0) continue;
      const n = await seedDefaultCategoriesForChapter(ctx, c._id, now);
      if (n > 0) {
        chaptersSeeded++;
        inserted += n;
      }
    }
    return { chaptersSeeded, inserted };
  },
});

/** Walk up from `startId`; true iff `targetId` is reachable (would form a cycle). */
async function categoryAncestorHits(
  ctx: QueryCtx,
  startId: Id<"budgetCategories"> | undefined,
  targetId: Id<"budgetCategories">,
): Promise<boolean> {
  let cursor = startId;
  let guard = 0;
  while (cursor && guard < 1000) {
    if (cursor === targetId) return true;
    const node: Doc<"budgetCategories"> | null = await ctx.db.get(cursor);
    cursor = node?.parentCategoryId;
    guard++;
  }
  return false;
}

export const updateCategory = mutation({
  args: {
    categoryId: v.id("budgetCategories"),
    patch: v.object({
      name: v.optional(v.string()),
      kind: v.optional(categoryKindValidator),
      parentCategoryId: v.optional(v.union(v.id("budgetCategories"), v.null())),
      sortOrder: v.optional(v.number()),
      isActive: v.optional(v.boolean()),
    }),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireFinanceManager(ctx, chapterId);
    const category = await requireInCallerChapter(
      ctx,
      chapterId,
      "budgetCategories",
      args.categoryId,
      "Category",
    );
    const newParent = args.patch.parentCategoryId;
    if (newParent) {
      if (newParent === args.categoryId) {
        throw new ConvexError({
          code: "INVALID_PARENT",
          message: "A category cannot be its own parent.",
        });
      }
      const parent = await requireInCallerChapter(
        ctx,
        chapterId,
        "budgetCategories",
        newParent,
        "Parent category",
      );
      if (parent.fundId !== category.fundId) {
        throw new ConvexError({
          code: "INVALID_PARENT",
          message: "A category's parent must be in the same fund.",
        });
      }
      // Reject a parent that is itself a descendant of this category (a cycle).
      if (await categoryAncestorHits(ctx, newParent, args.categoryId)) {
        throw new ConvexError({
          code: "CYCLE",
          message: "That parent would create a category cycle.",
        });
      }
    }
    await ctx.db.patch(args.categoryId, cleanPatch(args.patch));
    return null;
  },
});

// ── Teams ─────────────────────────────────────────────────────────────────────

export const listTeams = query({
  args: {},
  returns: v.array(teamSummary),
  handler: async (ctx) => {
    const chapterId = await readChapterId(ctx);
    if (!chapterId) return [];
    await requireFinanceRole(ctx, chapterId, "viewer");
    const chapterTeams = await ctx.db
      .query("financeTeams")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
      .take(ROLLUP_SCAN_LIMIT);
    const centralTeams = await ctx.db
      .query("financeTeams")
      .withIndex("by_chapter", (q) => q.eq("chapterId", undefined))
      .take(ROLLUP_SCAN_LIMIT);
    return [...chapterTeams, ...centralTeams]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map(toTeamSummary);
  },
});

export const createTeam = mutation({
  args: { name: v.string(), sortOrder: v.optional(v.number()) },
  returns: v.id("financeTeams"),
  handler: async (ctx, args) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireFinanceManager(ctx, chapterId);
    const existing = await ctx.db
      .query("financeTeams")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
      .take(ROLLUP_SCAN_LIMIT);
    return await ctx.db.insert("financeTeams", {
      chapterId,
      name: args.name,
      sortOrder: args.sortOrder ?? (await nextSortOrder(ctx, existing)),
      isActive: true,
      createdAt: Date.now(),
    });
  },
});

export const updateTeam = mutation({
  args: {
    teamId: v.id("financeTeams"),
    patch: v.object({
      name: v.optional(v.string()),
      sortOrder: v.optional(v.number()),
      isActive: v.optional(v.boolean()),
    }),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireFinanceManager(ctx, chapterId);
    await requireInCallerChapter(ctx, chapterId, "financeTeams", args.teamId, "Team");
    await ctx.db.patch(args.teamId, cleanPatch(args.patch));
    return null;
  },
});

// ── Budgets ────────────────────────────────────────────────────────────────────

export const listBudgets = query({
  args: {},
  returns: v.array(budgetSummary),
  handler: async (ctx) => {
    const chapterId = await readChapterId(ctx);
    if (!chapterId) return [];
    await requireFinanceRole(ctx, chapterId, "viewer");
    // The caller's chapter budgets PLUS every org-level (central) budget, each
    // tagged with its `level` so the reconcile picker can group them, and with
    // its managed tags resolved from `budgetTagLinks`.
    const chapterBudgets = await ctx.db
      .query("budgets")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
      .take(ROLLUP_SCAN_LIMIT);
    const centralBudgets = await ctx.db
      .query("budgets")
      .withIndex("by_chapter", (q) => q.eq("chapterId", CENTRAL))
      .take(ROLLUP_SCAN_LIMIT);
    const tagCache = new Map<string, Doc<"budgetTags"> | null>();
    const rows: (typeof budgetSummary.type)[] = [];
    for (const b of [...chapterBudgets, ...centralBudgets]) {
      const tags = await loadBudgetTags(ctx, b._id, tagCache);
      rows.push(toBudgetSummary(b, tags));
    }
    return rows;
  },
});

/**
 * Validate + verify tenancy of the optional narrowers on a budget write. The
 * one_time instance ref is verified against `events`/`projects` per `refKind`.
 */
async function verifyBudgetRefs(
  ctx: MutationCtx,
  chapterId: Id<"chapters">,
  b: {
    refKind?: BudgetRefKind | null;
    scopeRefId?: string | null;
    fundId?: Id<"funds"> | null;
    categoryId?: Id<"budgetCategories"> | null;
    month?: number | null;
    quarter?: number | null;
  },
): Promise<void> {
  if (b.month != null && (b.month < 1 || b.month > 12)) {
    throw new ConvexError({ code: "INVALID_PERIOD", message: "Month must be 1–12." });
  }
  if (b.quarter != null && (b.quarter < 1 || b.quarter > 4)) {
    throw new ConvexError({ code: "INVALID_PERIOD", message: "Quarter must be 1–4." });
  }
  if (b.fundId) await requireInCallerChapter(ctx, chapterId, "funds", b.fundId, "Fund");
  if (b.categoryId)
    await requireInCallerChapter(ctx, chapterId, "budgetCategories", b.categoryId, "Category");
  if (b.scopeRefId) {
    if (b.refKind === "project") {
      await requireInCallerChapter(
        ctx,
        chapterId,
        "projects",
        b.scopeRefId as Id<"projects">,
        "Project",
      );
    } else {
      await requireInCallerChapter(ctx, chapterId, "events", b.scopeRefId as Id<"events">, "Event");
    }
  }
}

export const createBudget = mutation({
  args: {
    amountCents: v.number(),
    // v2: one_time (a specific event/project) vs recurring.
    type: typeValidator,
    cadence: cadenceValidator,
    year: v.number(),
    label: v.optional(v.string()),
    // one_time: which instance table `scopeRefId` points at + the id.
    refKind: v.optional(refKindValidator),
    scopeRefId: v.optional(v.string()),
    month: v.optional(v.number()),
    quarter: v.optional(v.number()),
    fundId: v.optional(v.id("funds")),
    categoryId: v.optional(v.id("budgetCategories")),
    // Managed tags to attach (many-to-many); verified in-tenant.
    tagIds: v.optional(v.array(v.id("budgetTags"))),
    // When true, create an org-level (central) budget instead of a chapter one:
    // it stores `chapterId: "central"` and requires central finance access.
    central: v.optional(v.boolean()),
  },
  returns: v.id("budgets"),
  handler: async (ctx, args) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    // Central budgets are gated on org-wide reach; chapter budgets on manager.
    if (args.central) {
      await requireFinanceCentral(ctx, chapterId);
    } else {
      await requireFinanceManager(ctx, chapterId);
    }
    assertIntegerCents(args.amountCents, "Budget amount");
    // `refKind`/`scopeRefId` only make sense on a one_time budget.
    const refKind = args.type === "one_time" ? args.refKind ?? undefined : undefined;
    const scopeRefId = args.type === "one_time" ? args.scopeRefId : undefined;
    await verifyBudgetRefs(ctx, chapterId, {
      refKind,
      scopeRefId,
      fundId: args.fundId,
      categoryId: args.categoryId,
      month: args.month,
      quarter: args.quarter,
    });
    const level: BudgetLevel = args.central ? CENTRAL : chapterId;
    // Verify each explicit tag is usable at this budget's level BEFORE inserting.
    for (const tagId of args.tagIds ?? []) {
      await requireTagInLevel(ctx, level, tagId);
    }
    const userId = (await requireUserId(ctx)) as Id<"users">;
    const budgetId = await ctx.db.insert("budgets", {
      chapterId: level,
      amountCents: args.amountCents,
      label: args.label,
      type: args.type,
      refKind,
      scopeRefId,
      cadence: args.cadence,
      year: args.year,
      month: args.month,
      quarter: args.quarter,
      fundId: args.fundId,
      categoryId: args.categoryId,
      createdBy: userId,
      createdAt: Date.now(),
    });
    const seen = new Set<string>();
    for (const tagId of args.tagIds ?? []) {
      await linkBudgetTag(ctx, budgetId, level, tagId, seen);
    }
    // Auto-tag one_time EVENT budgets with the eventType template tag + an
    // "events" tag (idempotent + deduped against any explicit tags above).
    if (args.type === "one_time" && refKind === "event") {
      await autoTagEventBudget(ctx, budgetId, level, scopeRefId ?? undefined, seen, userId);
    }
    return budgetId;
  },
});

export const updateBudget = mutation({
  args: {
    budgetId: v.id("budgets"),
    patch: v.object({
      amountCents: v.optional(v.number()),
      label: v.optional(v.union(v.string(), v.null())),
      type: v.optional(typeValidator),
      refKind: v.optional(v.union(refKindValidator, v.null())),
      scopeRefId: v.optional(v.union(v.string(), v.null())),
      cadence: v.optional(cadenceValidator),
      year: v.optional(v.number()),
      month: v.optional(v.union(v.number(), v.null())),
      quarter: v.optional(v.union(v.number(), v.null())),
      fundId: v.optional(v.union(v.id("funds"), v.null())),
      categoryId: v.optional(v.union(v.id("budgetCategories"), v.null())),
    }),
    // When provided, REPLACE the budget's whole tag set (diff the links). Omit
    // to leave the existing tags untouched.
    tagIds: v.optional(v.array(v.id("budgetTags"))),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    // Load first (central budgets are visible to the caller's chapter), then gate
    // the WRITE: central budgets are mutated only by central users, chapter
    // budgets by a manager.
    const budget = await requireInCallerChapter(
      ctx,
      chapterId,
      "budgets",
      args.budgetId,
      "Budget",
      { allowCentral: true },
    );
    const level = budget.chapterId as BudgetLevel;
    if (level === CENTRAL) {
      await requireFinanceCentral(ctx, chapterId);
    } else {
      await requireFinanceManager(ctx, chapterId);
    }
    if (args.patch.amountCents != null) {
      assertIntegerCents(args.patch.amountCents, "Budget amount");
    }
    const patch = { ...args.patch };
    const newType = patch.type ?? effectiveType(budget);
    // A recurring budget carries no instance ref: clear a stale event/project.
    if (newType === "recurring") {
      if (patch.refKind === undefined) patch.refKind = null;
      if (patch.scopeRefId === undefined) patch.scopeRefId = null;
    }
    const currentRefKind = effectiveRefKind(budget) ?? undefined;
    const newRefKind =
      newType === "one_time"
        ? (patch.refKind ?? budget.refKind ?? effectiveRefKind(budget) ?? undefined)
        : undefined;
    // The EFFECTIVE instance ref: a patch value (set OR cleared) wins, else the
    // budget's stored one. `matchesBudget` compares against `scopeRefId` per
    // `refKind`, so the two must stay consistent — verify the effective pair, not
    // just a freshly-patched `scopeRefId`.
    const scopeRefIdProvided = patch.scopeRefId !== undefined;
    const effScopeRefId = scopeRefIdProvided ? patch.scopeRefId : budget.scopeRefId ?? null;
    // Changing `refKind` while keeping a stale `scopeRefId` would silently make
    // the budget match nothing (an event id compared as a project id, or vice
    // versa). Reject rather than persist a mismatched ref.
    if (
      newType === "one_time" &&
      newRefKind !== currentRefKind &&
      !scopeRefIdProvided &&
      budget.scopeRefId != null
    ) {
      throw new ConvexError({
        code: "REF_KIND_MISMATCH",
        message: "Changing a budget's link type requires a matching reference.",
      });
    }
    await verifyBudgetRefs(ctx, chapterId, {
      refKind: newRefKind,
      scopeRefId: effScopeRefId,
      fundId: patch.fundId,
      categoryId: patch.categoryId,
      month: patch.month,
      quarter: patch.quarter,
    });
    await ctx.db.patch(args.budgetId, cleanPatch(patch));

    // Replace the tag set when `tagIds` was provided (diff the link rows).
    if (args.tagIds !== undefined) {
      const want = new Set(args.tagIds);
      for (const tagId of want) await requireTagInLevel(ctx, level, tagId);
      const existing = await ctx.db
        .query("budgetTagLinks")
        .withIndex("by_budget", (q) => q.eq("budgetId", args.budgetId))
        .take(ROLLUP_SCAN_LIMIT);
      const have = new Set(existing.map((l) => l.tagId as string));
      for (const link of existing) {
        if (!want.has(link.tagId)) await ctx.db.delete(link._id);
      }
      for (const tagId of want) {
        if (!have.has(tagId)) {
          await ctx.db.insert("budgetTagLinks", {
            budgetId: args.budgetId,
            tagId,
            chapterId: level,
            createdAt: Date.now(),
          });
        }
      }
    }

    // Auto-tag on CONVERSION to a one_time EVENT budget (consistent with
    // `createBudget`): ensure + link the eventType `template` tag + an `events`
    // tag, only when it wasn't already a one_time event budget. Runs AFTER the
    // tagIds replacement so its links aren't diffed away; idempotent because the
    // existing links seed `seen`, so ensureTag/linkBudgetTag never duplicate.
    const wasEventOneTime =
      effectiveType(budget) === "one_time" && currentRefKind === "event";
    if (newType === "one_time" && newRefKind === "event" && !wasEventOneTime) {
      const userId = (await requireUserId(ctx)) as Id<"users">;
      const existingLinks = await ctx.db
        .query("budgetTagLinks")
        .withIndex("by_budget", (q) => q.eq("budgetId", args.budgetId))
        .take(ROLLUP_SCAN_LIMIT);
      const seen = new Set<string>(existingLinks.map((l) => l.tagId as string));
      await autoTagEventBudget(
        ctx,
        args.budgetId,
        level,
        effScopeRefId ?? undefined,
        seen,
        userId,
      );
    }
    return null;
  },
});

export const deleteBudget = mutation({
  args: { budgetId: v.id("budgets") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    const budget = await requireInCallerChapter(
      ctx,
      chapterId,
      "budgets",
      args.budgetId,
      "Budget",
      { allowCentral: true },
    );
    if (budget.chapterId === CENTRAL) {
      await requireFinanceCentral(ctx, chapterId);
    } else {
      await requireFinanceManager(ctx, chapterId);
    }
    // Remove its tag links, then the budget.
    const links = await ctx.db
      .query("budgetTagLinks")
      .withIndex("by_budget", (q) => q.eq("budgetId", args.budgetId))
      .take(ROLLUP_SCAN_LIMIT);
    for (const link of links) await ctx.db.delete(link._id);
    await ctx.db.delete(args.budgetId);
    return null;
  },
});

// ── Budget tags (managed CRUD) ───────────────────────────────────────────────
// Gated: chapter tags need a chapter finance manager; central tags need central
// reach. TODO(PR3): also allow president/ED once the specialized-roles system
// lands (do NOT build those role checks here — they don't exist yet).

const budgetTagSummary = v.object({
  id: v.id("budgetTags"),
  name: v.string(),
  kind: v.union(tagKindValidator, v.null()),
  refId: v.union(v.string(), v.null()),
  level: v.union(v.literal("chapter"), v.literal("central")),
});

function toBudgetTagSummary(t: Doc<"budgetTags">) {
  return {
    id: t._id,
    name: t.name,
    kind: t.kind ?? null,
    refId: t.refId ?? null,
    level: t.chapterId === CENTRAL ? ("central" as const) : ("chapter" as const),
  };
}

export const listBudgetTags = query({
  args: {},
  returns: v.array(budgetTagSummary),
  handler: async (ctx) => {
    const chapterId = await readChapterId(ctx);
    if (!chapterId) return [];
    await requireFinanceRole(ctx, chapterId, "viewer");
    const chapterTags = await ctx.db
      .query("budgetTags")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
      .take(ROLLUP_SCAN_LIMIT);
    const centralTags = await ctx.db
      .query("budgetTags")
      .withIndex("by_chapter", (q) => q.eq("chapterId", CENTRAL))
      .take(ROLLUP_SCAN_LIMIT);
    return [...chapterTags, ...centralTags]
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
      .map(toBudgetTagSummary);
  },
});

export const createBudgetTag = mutation({
  args: {
    name: v.string(),
    kind: v.optional(tagKindValidator),
    refId: v.optional(v.string()),
    sortOrder: v.optional(v.number()),
    // Org-level (central) tag; requires central finance reach.
    central: v.optional(v.boolean()),
  },
  returns: v.id("budgetTags"),
  handler: async (ctx, args) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    if (args.central) {
      await requireFinanceCentral(ctx, chapterId);
    } else {
      await requireFinanceManager(ctx, chapterId);
    }
    const level: BudgetLevel = args.central ? CENTRAL : chapterId;
    // Tenancy-check a ref-carrying tag: a `team`/`template` `refId` must point at
    // a doc in THIS tag's level (the caller's chapter, or central), else a tag
    // could reference another chapter's financeTeam / eventType.
    if (args.refId && (args.kind === "team" || args.kind === "template")) {
      const refDoc = await ctx.db.get(
        args.refId as Id<"financeTeams"> | Id<"eventTypes">,
      );
      const refChapter = (refDoc as { chapterId?: Id<"chapters"> | typeof CENTRAL } | null)
        ?.chapterId;
      const inLevel =
        !!refDoc &&
        (refChapter === level ||
          (level === CENTRAL && (refChapter === CENTRAL || refChapter === undefined)));
      if (!inLevel) {
        throw new ConvexError({
          code: "NOT_FOUND",
          message: `Referenced ${args.kind === "team" ? "team" : "template"} not found at this tag's level.`,
        });
      }
    }
    const userId = (await requireUserId(ctx)) as Id<"users">;
    return await ctx.db.insert("budgetTags", {
      chapterId: level,
      name: args.name,
      kind: args.kind,
      refId: args.refId,
      sortOrder: args.sortOrder,
      createdBy: userId,
      createdAt: Date.now(),
    });
  },
});

export const updateBudgetTag = mutation({
  args: {
    tagId: v.id("budgetTags"),
    patch: v.object({
      name: v.optional(v.string()),
      kind: v.optional(v.union(tagKindValidator, v.null())),
      refId: v.optional(v.union(v.string(), v.null())),
      sortOrder: v.optional(v.number()),
    }),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    const tag = await requireInCallerChapter(
      ctx,
      chapterId,
      "budgetTags",
      args.tagId,
      "Tag",
      { allowCentral: true },
    );
    if (tag.chapterId === CENTRAL) {
      await requireFinanceCentral(ctx, chapterId);
    } else {
      await requireFinanceManager(ctx, chapterId);
    }
    await ctx.db.patch(args.tagId, cleanPatch(args.patch));
    return null;
  },
});

export const deleteBudgetTag = mutation({
  args: { tagId: v.id("budgetTags") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    const tag = await requireInCallerChapter(
      ctx,
      chapterId,
      "budgetTags",
      args.tagId,
      "Tag",
      { allowCentral: true },
    );
    if (tag.chapterId === CENTRAL) {
      await requireFinanceCentral(ctx, chapterId);
    } else {
      await requireFinanceManager(ctx, chapterId);
    }
    // Blocked while any budget still carries the tag.
    const inUse = await ctx.db
      .query("budgetTagLinks")
      .withIndex("by_tag", (q) => q.eq("tagId", args.tagId))
      .first();
    if (inUse) {
      throw new ConvexError({
        code: "TAG_IN_USE",
        message: "This tag is still used by one or more budgets.",
      });
    }
    await ctx.db.delete(args.tagId);
    return null;
  },
});

// ── Migration: legacy `scope` → v2 `type` + tags ─────────────────────────────
const budgetScopeMigrationResult = v.object({
  migrated: v.number(),
  skipped: v.number(),
  tagsLinked: v.number(),
});

/**
 * Backfill every legacy budget onto the v2 `type` + tag model. Shared body for
 * the superuser-gated public mutation and the no-auth CLI internal wrapper.
 * Idempotent: a budget that already has `type` set is skipped, so re-runs are
 * no-ops.
 *
 * Per-scope mapping:
 *  - event    → one_time, refKind=event; auto-tag the eventType template tag + an "events" tag
 *  - project  → one_time, refKind=project
 *  - team     → recurring; ensure/link a `team` tag (refId=teamId, name=financeTeams.name)
 *  - template → recurring; ensure/link a `template` tag when scopeRefId resolves to an eventType
 *  - bucket   → recurring (no tags)
 *  - chapter  → recurring (no tags)
 */
async function runBudgetScopeMigration(
  ctx: MutationCtx,
): Promise<{ migrated: number; skipped: number; tagsLinked: number }> {
    let migrated = 0;
    let skipped = 0;
    let tagsLinked = 0;

    const all = await ctx.db.query("budgets").collect();
    for (const b of all) {
      // Idempotent: a budget already on the v2 model is left untouched.
      if (b.type != null) {
        skipped++;
        continue;
      }
      const level = b.chapterId as BudgetLevel;
      const seen = new Set<string>();
      let type: BudgetType = "recurring";
      let refKind: BudgetRefKind | undefined;

      switch (b.scope) {
        case "event": {
          type = "one_time";
          refKind = "event";
          break;
        }
        case "project": {
          type = "one_time";
          refKind = "project";
          break;
        }
        case "team": {
          type = "recurring";
          const teamId = (b.teamId ?? b.scopeRefId) as Id<"financeTeams"> | undefined;
          if (teamId) {
            const team = await ctx.db.get(teamId);
            if (team && "name" in team) {
              const tagId = await ensureTag(ctx, {
                chapterId: level,
                name: (team as Doc<"financeTeams">).name,
                kind: "team",
                refId: teamId,
              });
              await linkBudgetTag(ctx, b._id, level, tagId, seen);
              tagsLinked++;
            }
          }
          break;
        }
        case "template": {
          type = "recurring";
          if (b.scopeRefId) {
            const et = await ctx.db.get(b.scopeRefId as Id<"eventTypes">);
            if (et && "name" in et) {
              const tagId = await ensureTag(ctx, {
                chapterId: level,
                name: (et as Doc<"eventTypes">).name,
                kind: "template",
                refId: b.scopeRefId,
              });
              await linkBudgetTag(ctx, b._id, level, tagId, seen);
              tagsLinked++;
            }
          }
          break;
        }
        // bucket / chapter / undefined → recurring, no tags.
        default:
          type = "recurring";
          break;
      }

      await ctx.db.patch(b._id, { type, refKind });

      // Event budgets also get the auto template + events tags.
      if (type === "one_time" && refKind === "event") {
        const before = seen.size;
        await autoTagEventBudget(ctx, b._id, level, b.scopeRefId ?? undefined, seen);
        tagsLinked += seen.size - before;
      }
      migrated++;
    }

    return { migrated, skipped, tagsLinked };
}

/**
 * Superuser-gated public wrapper (invoke manually — NOT in the auto-run
 * registry). Idempotent.
 *
 * Run locally:  npx convex run finances:migrateBudgetScopesToTypes
 * Run on prod:  npx convex run --prod finances:migrateBudgetScopesToTypes
 */
export const migrateBudgetScopesToTypes = mutation({
  args: {},
  returns: budgetScopeMigrationResult,
  handler: async (ctx) => {
    await requireSuperuser(ctx);
    return await runBudgetScopeMigration(ctx);
  },
});

/**
 * CLI-runnable (no auth) sibling of {@link migrateBudgetScopesToTypes} — an
 * internalMutation is safe to run without the superuser gate. Same idempotent
 * backfill.
 *
 * Run locally:  npx convex run finances:runMigrateBudgetScopesToTypes
 * Run on prod:  npx convex run --prod finances:runMigrateBudgetScopesToTypes
 */
export const runMigrateBudgetScopesToTypes = internalMutation({
  args: {},
  returns: budgetScopeMigrationResult,
  handler: async (ctx) => await runBudgetScopeMigration(ctx),
});

// ── Transactions ───────────────────────────────────────────────────────────────

export const listTransactions = query({
  args: { paginationOpts: paginationOptsValidator },
  returns: v.object({
    page: v.array(txnSummary),
    isDone: v.boolean(),
    continueCursor: v.string(),
    splitCursor: v.optional(v.union(v.string(), v.null())),
    pageStatus: v.optional(
      v.union(
        v.literal("SplitRecommended"),
        v.literal("SplitRequired"),
        v.null(),
      ),
    ),
  }),
  handler: async (ctx, args) => {
    const emptyPage = { page: [], isDone: true, continueCursor: "" };
    const chapterId = await readChapterId(ctx);
    if (!chapterId) return emptyPage;
    await requireFinanceRole(ctx, chapterId, "viewer");
    // Defensively drop cross-environment increase_* txns (latent-leak guard —
    // no code writes them yet). A null-id / non-Increase txn is env-neutral.
    const sandboxMode = await readSandbox(ctx);
    const result = await ctx.db
      .query("transactions")
      .withIndex("by_chapter_and_postedAt", (q) => q.eq("chapterId", chapterId))
      .order("desc")
      .paginate(args.paginationOpts);
    return {
      ...result,
      page: result.page
        .filter((tr) => txnMatchesMode(tr, sandboxMode))
        .map(toTxnSummary),
    };
  },
});

/**
 * RECONCILE LIST — the bookkeeper grid's data source. Unlike the paginated
 * {@link listTransactions} (50/page, so filters only ever saw one page), this
 * loads the chapter's transactions bounded (`ROLLUP_SCAN_LIMIT`, a bounded admin
 * set) and filters SERVER-SIDE across ALL rows, so every filter pill is truthful.
 * Returns the filtered `rows` (newest-first, cardholder resolved) plus per-filter
 * `counts` for the pill badges.
 *
 * Filters (the `excluded` status is always dropped first — an intentional
 * exclusion never belongs in the inbox):
 *   - `all`            every non-excluded row
 *   - `needs_budget`   a spend row with no budget yet (`isSpend && budgetId == null`)
 *   - `missing_receipt` a chargeable (spend) row with no receipt attached
 *   - `uncategorized`  status `unreviewed`
 *   - `ready`          status `reconciled`
 *
 * Kept to a SINGLE bounded scan over `by_chapter_and_postedAt`: that one desc
 * read yields both the newest-first ordering the grid wants AND every pill's
 * count in one pass, cheaper than a separate `by_chapter_and_status` query per
 * pill.
 */
export const listReconcile = query({
  args: { filter: v.optional(reconcileFilterValidator) },
  returns: v.object({ rows: v.array(reconcileRow), counts: reconcileCounts }),
  handler: async (ctx, args) => {
    const filter = args.filter ?? "all";
    const zero = {
      all: 0,
      needs_budget: 0,
      missing_receipt: 0,
      uncategorized: 0,
      ready: 0,
    };
    const chapterId = await readChapterId(ctx);
    if (!chapterId) return { rows: [], counts: zero };
    await requireFinanceRole(ctx, chapterId, "viewer");

    const sandboxMode = await readSandbox(ctx);
    const all = (
      await ctx.db
        .query("transactions")
        .withIndex("by_chapter_and_postedAt", (q) => q.eq("chapterId", chapterId))
        .order("desc")
        .take(ROLLUP_SCAN_LIMIT)
    )
      .filter((tr) => txnMatchesMode(tr, sandboxMode))
      // An intentionally-excluded charge is never part of the reconcile inbox.
      .filter((tr) => tr.status !== "excluded");

    // Per-filter counts in the same pass (spend/receipt/status predicates).
    const counts = { ...zero, all: all.length };
    for (const tr of all) {
      if (isSpend(tr) && tr.budgetId == null) counts.needs_budget += 1;
      if (isSpend(tr) && tr.receiptStorageId == null) counts.missing_receipt += 1;
      if (tr.status === "unreviewed") counts.uncategorized += 1;
      if (tr.status === "reconciled") counts.ready += 1;
    }

    const predicates: Record<string, (tr: Doc<"transactions">) => boolean> = {
      all: () => true,
      needs_budget: (tr) => isSpend(tr) && tr.budgetId == null,
      missing_receipt: (tr) => isSpend(tr) && tr.receiptStorageId == null,
      uncategorized: (tr) => tr.status === "unreviewed",
      ready: (tr) => tr.status === "reconciled",
    };
    const selected = all.filter(predicates[filter]);

    // Resolve the cardholder only for the rows we actually return (bounded
    // `storage.getUrl` calls), caching people / cards / image urls across rows.
    const getPerson = nameCache(ctx, "people");
    const getCard = nameCache(ctx, "cards");
    const imageUrlCache = new Map<Id<"_storage">, string | null>();
    const resolveCardholder = async (tr: Doc<"transactions">) => {
      let personId = tr.personId ?? null;
      if (!personId && tr.cardId) {
        const card = await getCard(tr.cardId);
        personId = card?.cardholderPersonId ?? null;
      }
      if (!personId) return null;
      const person = await getPerson(personId);
      if (!person) return null;
      let imageUrl: string | null = null;
      if (person.image) {
        if (imageUrlCache.has(person.image)) {
          imageUrl = imageUrlCache.get(person.image)!;
        } else {
          imageUrl = await ctx.storage.getUrl(person.image);
          imageUrlCache.set(person.image, imageUrl);
        }
      }
      return { personId, name: person.name, imageUrl };
    };

    const rows: (typeof reconcileRow.type)[] = [];
    for (const tr of selected) {
      rows.push({ ...toTxnSummary(tr), cardholder: await resolveCardholder(tr) });
    }
    return { rows, counts };
  },
});

/** Verify the optional operational-link ids on a transaction write. */
async function verifyTxnRefs(
  ctx: MutationCtx,
  chapterId: Id<"chapters">,
  refs: {
    fundId?: Id<"funds"> | null;
    categoryId?: Id<"budgetCategories"> | null;
    projectId?: Id<"projects"> | null;
    eventId?: Id<"events"> | null;
    teamId?: Id<"financeTeams"> | null;
    personId?: Id<"people"> | null;
  },
): Promise<void> {
  if (refs.fundId) await requireInCallerChapter(ctx, chapterId, "funds", refs.fundId, "Fund");
  if (refs.categoryId)
    await requireInCallerChapter(ctx, chapterId, "budgetCategories", refs.categoryId, "Category");
  if (refs.projectId)
    await requireInCallerChapter(ctx, chapterId, "projects", refs.projectId, "Project");
  if (refs.eventId)
    await requireInCallerChapter(ctx, chapterId, "events", refs.eventId, "Event");
  if (refs.teamId)
    await requireInCallerChapter(ctx, chapterId, "financeTeams", refs.teamId, "Team", {
      allowCentral: true,
    });
  if (refs.personId)
    await requireInCallerChapter(ctx, chapterId, "people", refs.personId, "Person");
}

export const createManualTransaction = mutation({
  args: {
    flow: flowValidator,
    amountCents: v.number(),
    postedAt: v.number(),
    source: v.optional(sourceValidator),
    description: v.optional(v.string()),
    merchantName: v.optional(v.string()),
    fundId: v.optional(v.id("funds")),
    categoryId: v.optional(v.id("budgetCategories")),
    projectId: v.optional(v.id("projects")),
    eventId: v.optional(v.id("events")),
    teamId: v.optional(v.id("financeTeams")),
    personId: v.optional(v.id("people")),
  },
  returns: v.id("transactions"),
  handler: async (ctx, args) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireFinanceRole(ctx, chapterId, "bookkeeper");
    assertIntegerCents(args.amountCents);
    await verifyTxnRefs(ctx, chapterId, args);
    const userId = (await requireUserId(ctx)) as Id<"users">;
    // Categorized on entry when a fund/category was supplied, else unreviewed.
    const status = args.fundId || args.categoryId ? "categorized" : "unreviewed";
    return await ctx.db.insert("transactions", {
      chapterId,
      source: args.source ?? "manual",
      flow: args.flow,
      amountCents: args.amountCents,
      currency: "usd",
      postedAt: args.postedAt,
      description: args.description,
      merchantName: args.merchantName,
      fundId: args.fundId,
      categoryId: args.categoryId,
      projectId: args.projectId,
      eventId: args.eventId,
      teamId: args.teamId,
      personId: args.personId,
      status,
      createdBy: userId,
      createdAt: Date.now(),
    });
  },
});

export const categorizeTransaction = mutation({
  args: {
    transactionId: v.id("transactions"),
    fundId: v.optional(v.union(v.id("funds"), v.null())),
    categoryId: v.optional(v.union(v.id("budgetCategories"), v.null())),
    projectId: v.optional(v.union(v.id("projects"), v.null())),
    eventId: v.optional(v.union(v.id("events"), v.null())),
    teamId: v.optional(v.union(v.id("financeTeams"), v.null())),
    // Explicit budget attribution. A chapter txn may point at its OWN chapter
    // budget or a central budget (never another chapter's). `null` clears it.
    budgetId: v.optional(v.union(v.id("budgets"), v.null())),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireFinanceRole(ctx, chapterId, "bookkeeper");
    const txn = await requireInCallerChapter(
      ctx,
      chapterId,
      "transactions",
      args.transactionId,
      "Transaction",
    );
    await verifyTxnRefs(ctx, chapterId, {
      fundId: args.fundId ?? undefined,
      categoryId: args.categoryId ?? undefined,
      projectId: args.projectId ?? undefined,
      eventId: args.eventId ?? undefined,
      teamId: args.teamId ?? undefined,
    });
    if (args.budgetId) {
      await requireInCallerChapter(ctx, chapterId, "budgets", args.budgetId, "Budget", {
        allowCentral: true,
      });
    }
    const patch = cleanPatch({
      fundId: args.fundId,
      categoryId: args.categoryId,
      projectId: args.projectId,
      eventId: args.eventId,
      teamId: args.teamId,
      budgetId: args.budgetId,
    });
    // Default the fund to the chapter's General Fund when the client omits it and
    // the txn isn't already coded to one. The reconcile grid hides the fund
    // selector (coding = category + budget only), so this keeps every coded txn
    // attached to a real fund without the UI having to pass it.
    if (args.fundId === undefined && txn.fundId == null) {
      const def = await defaultFundId(ctx, chapterId);
      if (def) patch.fundId = def;
    }
    // Advance an unreviewed transaction to categorized once coded.
    const nowCoded = (patch.fundId ?? txn.fundId) || (patch.categoryId ?? txn.categoryId);
    if (nowCoded && txn.status === "unreviewed") patch.status = "categorized";
    await ctx.db.patch(args.transactionId, patch);
    return null;
  },
});

export const bulkCategorize = mutation({
  args: {
    transactionIds: v.array(v.id("transactions")),
    fundId: v.optional(v.union(v.id("funds"), v.null())),
    categoryId: v.optional(v.union(v.id("budgetCategories"), v.null())),
    // Explicit budget attribution (chapter or central); `null` clears it.
    budgetId: v.optional(v.union(v.id("budgets"), v.null())),
  },
  returns: v.object({ updated: v.number() }),
  handler: async (ctx, args) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireFinanceRole(ctx, chapterId, "bookkeeper");
    await verifyTxnRefs(ctx, chapterId, {
      fundId: args.fundId ?? undefined,
      categoryId: args.categoryId ?? undefined,
    });
    if (args.budgetId) {
      await requireInCallerChapter(ctx, chapterId, "budgets", args.budgetId, "Budget", {
        allowCentral: true,
      });
    }
    let updated = 0;
    for (const id of args.transactionIds) {
      const txn = await requireInCallerChapter(
        ctx,
        chapterId,
        "transactions",
        id,
        "Transaction",
      );
      const patch = cleanPatch({
        fundId: args.fundId,
        categoryId: args.categoryId,
        budgetId: args.budgetId,
      });
      const nowCoded =
        (patch.fundId ?? txn.fundId) || (patch.categoryId ?? txn.categoryId);
      if (nowCoded && txn.status === "unreviewed") patch.status = "categorized";
      await ctx.db.patch(id, patch);
      updated++;
    }
    return { updated };
  },
});

export const setTransactionStatus = mutation({
  args: { transactionId: v.id("transactions"), status: statusValidator },
  returns: v.null(),
  handler: async (ctx, args) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireFinanceRole(ctx, chapterId, "bookkeeper");
    await requireInCallerChapter(
      ctx,
      chapterId,
      "transactions",
      args.transactionId,
      "Transaction",
    );
    await ctx.db.patch(args.transactionId, { status: args.status });
    return null;
  },
});

export const attachReceipt = mutation({
  args: {
    transactionId: v.id("transactions"),
    storageId: v.id("_storage"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireFinanceRole(ctx, chapterId, "bookkeeper");
    await requireInCallerChapter(
      ctx,
      chapterId,
      "transactions",
      args.transactionId,
      "Transaction",
    );
    await ctx.db.patch(args.transactionId, { receiptStorageId: args.storageId });
    return null;
  },
});

export const flagPersonal = mutation({
  args: { transactionId: v.id("transactions"), isPersonal: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireFinanceRole(ctx, chapterId, "bookkeeper");
    await requireInCallerChapter(
      ctx,
      chapterId,
      "transactions",
      args.transactionId,
      "Transaction",
    );
    // A personal charge is excluded from spend until repaid (`isPersonal`
    // already drops it from SPEND totals; no status change needed).
    await ctx.db.patch(args.transactionId, { isPersonal: args.isPersonal });
    return null;
  },
});
