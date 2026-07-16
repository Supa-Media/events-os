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
  BUDGET_TYPE_LABELS,
  CENTRAL,
  RECEIPT_GRACE_DAYS,
  MAX_NOTE_LENGTH,
  countsAsSpend,
  easternParts,
  quarterOfMonth,
  formatCents,
  matchesMode,
  financeRoleAtLeast,
  FINANCE_ROLE_LABELS,
  CENTRAL_MERCHANT_KEYWORDS,
  CENTRAL_PROJECT_KEYWORDS,
  matchesAnyKeyword,
  REASSIGN_BATCH_CAP,
  chapterAffordability as chapterAffordabilityCalc,
  type BudgetType,
  type BudgetRefKind,
} from "@events-os/shared";
import { readSandbox } from "./financeSettings";
import { isMissingReceiptCharge, unlockCardIfReceiptsResolved } from "./cards";
import {
  getChapterIdOrNull,
  requireChapterId,
  requireUserId,
} from "./lib/context";
import {
  requireFinanceRole,
  requireFinanceManager,
  requireFinanceCentral,
  getFinanceRole,
  defaultFundId,
  type FinanceScope,
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
  // R1a: the bookkeeper's own freeform note ("who was this for and why") —
  // distinct from `description` (provider-sourced). Null until set.
  note: v.union(v.string(), v.null()),
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
  // Receipt-reminder timeline stage ("none" until a day-1/day-3 nudge fires;
  // see `cards.advanceReceiptReminders`). Drives the Reconcile grid's Receipt
  // column past the plain "missing" state.
  reminderStage: v.union(
    v.literal("none"),
    v.literal("flagged"),
    v.literal("escalated"),
  ),
};
const txnSummary = v.object(txnSummaryFields);

// `personTransactions`'s projection (the member's own "My transactions" view):
// same shape as `txnSummary`, minus `note`. DELIBERATE privacy default — `note`
// is the bookkeeper's internal finance annotation ("who was this for and why"),
// not something written for the cardholder to read. `listReconcile` (the
// bookkeeper surface) still carries it in full; only the member-facing
// projection strips it. Flip consciously (i.e. re-add `note` here) if member
// transparency into bookkeeper notes is ever wanted.
const { note: _personTxnOmittedNote, ...personTxnSummaryFields } = txnSummaryFields;
const personTxnSummary = v.object(personTxnSummaryFields);

// The resolved cardholder behind a charge: the `personId` on the txn, else the
// person who owns the `cardId`. Powers the reconcile Cardholder column.
const cardholderRef = v.object({
  personId: v.id("people"),
  name: v.string(),
  imageUrl: v.union(v.string(), v.null()),
});

// The AI auto-coding proposal, resolved to display names — only ever populated
// (non-null) for a row that's still `unreviewed` AND carries at least one
// proposed link, so the Reconcile grid only ever shows an actionable suggestion.
// WP-U (one home per dollar): the model proposes a BUDGET directly instead of
// a separate project/event link — `budgetId` subsumes both.
const reconcileAiSuggestion = v.object({
  fundId: v.union(v.id("funds"), v.null()),
  categoryId: v.union(v.id("budgetCategories"), v.null()),
  budgetId: v.union(v.id("budgets"), v.null()),
  fundName: v.union(v.string(), v.null()),
  categoryName: v.union(v.string(), v.null()),
  budgetName: v.union(v.string(), v.null()),
  confidence: v.union(v.number(), v.null()),
  rationale: v.union(v.string(), v.null()),
});

// One reconcile-grid row: the txn summary (which already carries `budgetId` —
// the "For" picker's current value) plus the resolved cardholder and any
// pending AI proposal. No separate project/event link field (WP-U).
const reconcileRow = v.object({
  ...txnSummaryFields,
  cardholder: v.union(cardholderRef, v.null()),
  aiSuggestion: v.union(reconcileAiSuggestion, v.null()),
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
      v.object({ projectOrEvent: v.string(), category: v.string() }),
      v.null(),
    ),
  ),
  aiSuggestion: v.optional(
    v.union(v.object({ category: v.string() }), v.null()),
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
  // A real chapter, or the CENTRAL sentinel for the "Central" row (WP-0.3) —
  // central-scoped spend rolled up alongside the chapter rows.
  chapterId: v.union(v.id("chapters"), v.literal(CENTRAL)),
  chapterName: v.string(),
  subtitle: v.optional(v.union(v.string(), v.null())),
  spentCents: v.number(),
  budgetCents: v.number(),
  barPct: v.number(),
  status: okWarnValidator,
});

// ── Bounds (keep every read + rollup bounded) ────────────────────────────────
export const ROLLUP_SCAN_LIMIT = 5000;
const RECENT_TXN_COUNT = 10;
// R1a: `MAX_NOTE_LENGTH` (a transaction note is a short "who/why"
// justification, not a document) is shared from `@events-os/shared` — the
// mobile `TransactionNoteModal` imports the same constant for its `maxLength`.
const DAY_MS = 24 * 60 * 60 * 1000;

// ── Projection helpers ───────────────────────────────────────────────────────
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

/** A budget's display name: its own label, else its type word — the same
 *  fallback the mobile `budgetName()` helper uses (kept as one twinned rule,
 *  not two). Used by the "For" picker's Recurring group + the AI suggestion's
 *  resolved budget name. */
function budgetDisplayName(b: Doc<"budgets">): string {
  return b.label?.trim() || BUDGET_TYPE_LABELS[effectiveType(b)];
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
    note: tr.note ?? null,
    fundId: tr.fundId ?? null,
    categoryId: tr.categoryId ?? null,
    budgetId: tr.budgetId ?? null,
    needsBudget: isSpend(tr) && tr.budgetId == null,
    hasReceipt: tr.receiptStorageId != null,
    cardLast4: tr.cardLast4 ?? null,
    reminderStage: tr.receiptReminderStage ?? ("none" as const),
  };
}

/**
 * `personTransactions`'s projection — `toTxnSummary` minus `note`. Destructures
 * the key off entirely (not `note: null`) so a member's own-transactions
 * response never carries a `note` field at all, even when the bookkeeper has
 * set one. See `personTxnSummary`'s doc comment for why this is deliberate.
 */
function toPersonTxnSummary(tr: Doc<"transactions">) {
  const { note: _omittedNote, ...rest } = toTxnSummary(tr);
  return rest;
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
  // A real chapter, or the org level (`"central"`) for a central-scoped verify
  // (e.g. attributing a central-owned txn to a central budget) — WP-2.1.
  chapterId: FinanceScope,
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
  // A real chapter, or `"central"` to read CENTRAL-owned txns (WP-2.1). The
  // `by_chapter_and_postedAt` index keys on the string, so the sentinel reads
  // back exactly the central-owned rows and nothing else.
  chapterId: FinanceScope,
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
function txnCountsTowardBudget(
  tr: Doc<"transactions">,
  b: Doc<"budgets">,
  contextMonth?: number,
): boolean {
  if (!isSpend(tr) || tr.budgetId !== b._id) return false;
  const period = budgetEffectivePeriod(b, contextMonth);
  return inPeriod(tr.postedAt, period.year, period.month, period.quarter);
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
 * mode it keeps the exact same `isSpend` gate + explicit `budgetId` link but
 * widens the period window to Jan..throughMonth (`inYtdBudgetWindow`).
 */
function txnCountsTowardBudgetDash(
  tr: Doc<"transactions">,
  b: Doc<"budgets">,
  dp: DashPeriod,
): boolean {
  if (!dp.ytd) return txnCountsTowardBudget(tr, b, dp.month);
  if (!isSpend(tr) || tr.budgetId !== b._id) return false;
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
export async function autoTagEventBudget(
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

/**
 * Auto-tag a one_time PROJECT budget with a catch-all "Projects" tag (kind
 * `"custom"` — projects get no dedicated tag kind; WP-3.4: "keep tags as-is,
 * no new tag investment"). Mirrors `autoTagEventBudget`'s "Events" catch-all;
 * unlike an event, a project has no per-instance "template" to also tag.
 * Shared by `projects.create` (the create-time hook) and `backfillProjectBudgets`.
 */
export async function autoTagProjectBudget(
  ctx: MutationCtx,
  budgetId: Id<"budgets">,
  budgetLevel: BudgetLevel,
  seen: Set<string>,
  createdBy?: Id<"users">,
): Promise<void> {
  const projectsTag = await ensureTag(ctx, {
    chapterId: budgetLevel,
    name: "Projects",
    kind: "custom",
    createdBy,
  });
  await linkBudgetTag(ctx, budgetId, budgetLevel, projectsTag, seen);
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

/**
 * The display label for an EVENT budget, disambiguating repeated event names so
 * two events called the same thing don't both read as "Field Day" in the picker:
 *  - unique name in the chapter        → just the name          (`Field Day`)
 *  - same name in DIFFERENT months     → name + month + year    (`Field Day · March 2026`)
 *  - same name in the SAME month       → name + full date       (`Field Day · Mar 15, 2026`)
 *
 * `nameCount` = how many of the chapter's (non-training) events share this exact
 * name (INCLUDING this one); `sameMonthCount` = how many of those also fall in
 * this event's Eastern year+month (INCLUDING this one). `parts` is the event's
 * `easternParts(eventDate)`. Shared by `createBudget` and the backfill.
 */
export function eventBudgetLabel(
  name: string,
  parts: { year: number; month: number; day: number },
  nameCount: number,
  sameMonthCount: number,
): string {
  if (nameCount <= 1) return name;
  const monthName = MONTH_NAMES[parts.month - 1];
  if (sameMonthCount > 1) {
    // Same name, same month → the full date pins down which occurrence.
    return `${name} · ${monthName.slice(0, 3)} ${parts.day}, ${parts.year}`;
  }
  return `${name} · ${monthName} ${parts.year}`;
}

/**
 * Create a one_time EVENT budget for a single event — mirrors what
 * `runBackfillEventBudgets` writes (`type:"one_time"`, `refKind:"event"`,
 * `cadence:"per_instance"`) and reuses `eventBudgetLabel` (sibling
 * disambiguation against LIVE events, a single bounded query — same split
 * `createBudget`/`runBackfillEventBudgets` use) + `autoTagEventBudget` (the
 * eventType template tag + the catch-all "events" tag).
 *
 * Callers gate the "only when there's money" owner rule THEMSELVES (budgets
 * only exist when money does — see `instantiateEvent`'s create-time hook and
 * `events.updateDetails`'s edit-path trigger, both of which only call this
 * when `!isTraining && budget > 0`); this function always creates.
 */
export async function createEventBudget(
  ctx: MutationCtx,
  event: {
    _id: Id<"events">;
    chapterId: Id<"chapters">;
    name: string;
    eventDate: number;
    budget?: number;
  },
  // Optional — absent for a no-auth caller (the WP-U `migrateLinksToBudgets`
  // migration summons a budget with no authenticated user; mirrors
  // `autoTagEventBudget`'s already-optional `createdBy`).
  userId: Id<"users"> | undefined,
): Promise<void> {
  const parts = easternParts(event.eventDate);
  // Sibling (non-training) events sharing this exact name in the chapter
  // decide whether the bare name is ambiguous.
  const siblings = (
    await ctx.db
      .query("events")
      .withIndex("by_chapter", (q) => q.eq("chapterId", event.chapterId))
      .take(ROLLUP_SCAN_LIMIT)
  ).filter((e) => !e.isTraining && e.name === event.name);
  const sameMonthCount = siblings.filter((e) => {
    const ep = easternParts(e.eventDate);
    return ep.year === parts.year && ep.month === parts.month;
  }).length;
  const label = eventBudgetLabel(event.name, parts, siblings.length, sameMonthCount);

  // event.budget is ESTIMATED dollars; finance money is integer cents.
  const amountCents = event.budget != null ? Math.round(event.budget * 100) : 0;
  const budgetId = await ctx.db.insert("budgets", {
    chapterId: event.chapterId,
    amountCents,
    label,
    type: "one_time",
    refKind: "event",
    scopeRefId: event._id,
    cadence: "per_instance",
    year: parts.year,
    month: parts.month,
    createdBy: userId,
    createdAt: Date.now(),
  });
  const seen = new Set<string>();
  await autoTagEventBudget(ctx, budgetId, event.chapterId, event._id as string, seen, userId);
}

/**
 * Whether a one_time budget already exists for this event/project ref, via the
 * `by_ref` index — independent of which chapter/central level currently owns
 * it (a project's/event's own `chapterId` never changes, but its BUDGET can
 * move scope; `by_ref` finds it either way — see the schema comment on
 * `budgets.by_ref`). Used by the create-time hooks' edit-path triggers
 * (`projects.update`, `events.updateDetails`) to avoid summoning a duplicate
 * budget when one already exists (from the create-time hook or a backfill run).
 */
export async function hasBudgetForRef(
  ctx: QueryCtx,
  refKind: BudgetRefKind,
  scopeRefId: string,
): Promise<boolean> {
  const existing = await ctx.db
    .query("budgets")
    .withIndex("by_ref", (q) => q.eq("refKind", refKind).eq("scopeRefId", scopeRefId))
    .first();
  return existing != null;
}

/**
 * The display label for a PROJECT budget — same disambiguation shape as
 * `eventBudgetLabel`, keyed off the project's `startDate` (callers fall back
 * to `createdAt` when unset, since a project has no required instance date
 * the way an event has `eventDate`):
 *  - unique name in the chapter        → just the name        (`Merch Drop`)
 *  - same name in DIFFERENT months     → name + month + year  (`Merch Drop · March 2026`)
 *  - same name in the SAME month       → name + full date     (`Merch Drop · Mar 15, 2026`)
 *
 * `nameCount`/`sameMonthCount` are INCLUSIVE of this project, like the event
 * version. Shared by `projects.create` (the create-time hook) and the backfill.
 */
export function projectBudgetLabel(
  name: string,
  parts: { year: number; month: number; day: number },
  nameCount: number,
  sameMonthCount: number,
): string {
  if (nameCount <= 1) return name;
  const monthName = MONTH_NAMES[parts.month - 1];
  if (sameMonthCount > 1) {
    return `${name} · ${monthName.slice(0, 3)} ${parts.day}, ${parts.year}`;
  }
  return `${name} · ${monthName} ${parts.year}`;
}

/**
 * Create a one_time PROJECT budget for a single project — mirrors
 * `createEventBudget` (same shape: `type:"one_time"`, `cadence:"per_instance"`,
 * `autoTagProjectBudget`'s catch-all "Projects" tag), disambiguating the label
 * against LIVE sibling projects (a single bounded query). Relocated here from
 * `projects.ts` (WP-U) so BOTH "D8 creation helpers" live together in
 * `finances.ts` — `events.ts` already imports `createEventBudget` from here;
 * `projects.ts` now imports this instead of defining it locally, and the new
 * `ensureBudgetForRef`/`summonBudgetForRef` (WP-U's "For" picker summon-on-pick)
 * can call both without a circular import between `finances.ts`/`projects.ts`.
 *
 * Callers gate the "only when there's money" owner rule THEMSELVES (see
 * `projects.create`'s create-time hook and `projects.update`'s edit-path
 * trigger); this function always creates. `budget` is left `undefined` for a
 * $0 "plan" budget (the WP-U summon flow) — `amountCents` is then 0.
 */
export async function createProjectBudget(
  ctx: MutationCtx,
  project: {
    _id: Id<"projects">;
    chapterId: Id<"chapters">;
    name: string;
    startDate?: number;
    createdAt: number;
    budgetUsd?: number;
  },
  // Optional — see `createEventBudget`'s twin comment.
  userId: Id<"users"> | undefined,
): Promise<void> {
  const parts = easternParts(project.startDate ?? project.createdAt);
  // Sibling projects sharing this exact name in the chapter (includes the
  // project just inserted, since this runs after that write in the same
  // transaction) decide whether the bare name is ambiguous.
  const siblings = (
    await ctx.db
      .query("projects")
      .withIndex("by_chapter", (q) => q.eq("chapterId", project.chapterId))
      .take(ROLLUP_SCAN_LIMIT)
  ).filter((p) => p.name === project.name);
  const sameMonthCount = siblings.filter((p) => {
    const sp = easternParts(p.startDate ?? p.createdAt);
    return sp.year === parts.year && sp.month === parts.month;
  }).length;
  const label = projectBudgetLabel(project.name, parts, siblings.length, sameMonthCount);

  // budgetUsd is ESTIMATED dollars; finance money is integer cents. Callers
  // only reach here when budgetUsd > 0 (the owner rule's gate) — EXCEPT the
  // WP-U summon flow, which always wants a $0 "plan" budget.
  const amountCents =
    project.budgetUsd != null ? Math.round(project.budgetUsd * 100) : 0;
  const budgetId = await ctx.db.insert("budgets", {
    chapterId: project.chapterId,
    amountCents,
    label,
    type: "one_time",
    refKind: "project",
    scopeRefId: project._id,
    cadence: "per_instance",
    year: parts.year,
    month: parts.month,
    createdBy: userId,
    createdAt: Date.now(),
  });
  const seen = new Set<string>();
  await autoTagProjectBudget(ctx, budgetId, project.chapterId, seen, userId);
}

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
function nameCache<
  T extends
    | "events"
    | "projects"
    | "people"
    | "cards"
    | "eventTypes"
    | "funds"
    | "budgetCategories"
    | "budgets",
>(
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

/** Reimbursement statuses awaiting a manager decision — mirrors the exact set
 *  `listStaleReimbursements` (reimbursements.ts) treats as "awaiting a
 *  manager", so the two queues never drift on what counts as approvable. */
const APPROVABLE_REIMBURSEMENT_STATUSES = ["submitted", "preapproved"] as const;

/**
 * The chapter "Needs attention" queue: (a) reimbursements awaiting a manager
 * decision (submitted / preapproved — NOT pre-approval-pending, approved, or
 * terminal), and (b) cards with a missing-receipt charge still inside the
 * `RECEIPT_GRACE_DAYS` grace window (nearing the auto-lock sweep, not yet past
 * it — those are already locked by the cron). Each active card is checked
 * against its own recent charges via `isMissingReceiptCharge`, the exact same
 * predicate `autoLockOverdueCards` (cards.ts) uses, so "nearing" and "overdue"
 * can never disagree on what counts as a missing receipt.
 */
async function chapterAttentionQueue(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
): Promise<(typeof attentionItem.type)[]> {
  const items: (typeof attentionItem.type)[] = [];

  // (a) Reimbursements to approve.
  let reimbCount = 0;
  let reimbCents = 0;
  for (const status of APPROVABLE_REIMBURSEMENT_STATUSES) {
    const rows = await ctx.db
      .query("reimbursementRequests")
      .withIndex("by_chapter_and_status", (q) =>
        q.eq("chapterId", chapterId).eq("status", status),
      )
      .take(ROLLUP_SCAN_LIMIT);
    if (rows.length === ROLLUP_SCAN_LIMIT) {
      console.warn(
        `[finances] attention queue hit ROLLUP_SCAN_LIMIT (${ROLLUP_SCAN_LIMIT}) reading "${status}" reimbursements for chapter ${chapterId}; count/total truncated.`,
      );
    }
    for (const r of rows) {
      reimbCount++;
      reimbCents += r.totalCents;
    }
  }
  if (reimbCount > 0) {
    items.push({
      kind: "reimbursements",
      title: "Reimbursements to approve",
      badgeCount: reimbCount,
      detail: `${formatCents(reimbCents)} awaiting approval`,
      actionLabel: "Review",
    });
  }

  // (b) Cards nearing the receipt auto-lock — count distinct CARDHOLDERS (a
  // person with two nearing charges is one attention row, not two).
  const cutoff = Date.now() - RECEIPT_GRACE_DAYS * DAY_MS;
  const chapterCards = await ctx.db
    .query("cards")
    .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
    .take(ROLLUP_SCAN_LIMIT);
  if (chapterCards.length === ROLLUP_SCAN_LIMIT) {
    console.warn(
      `[finances] attention queue hit ROLLUP_SCAN_LIMIT (${ROLLUP_SCAN_LIMIT}) reading cards for chapter ${chapterId}; nearing-lock scan truncated.`,
    );
  }
  const nearingCardholders = new Set<Id<"people">>();
  for (const card of chapterCards) {
    // Only ACTIVE cards can still be "nearing" — a locked card already tipped
    // over (the auto-lock cron caught it) or was manually locked/canceled.
    if (card.status !== "active") continue;
    const charges = await ctx.db
      .query("transactions")
      .withIndex("by_card", (q) => q.eq("cardId", card._id))
      .take(ROLLUP_SCAN_LIMIT);
    if (charges.length === ROLLUP_SCAN_LIMIT) {
      console.warn(
        `[finances] attention queue hit ROLLUP_SCAN_LIMIT (${ROLLUP_SCAN_LIMIT}) reading charges for card ${card._id}; nearing-lock check truncated.`,
      );
    }
    const nearing = charges.some(
      (tr) => isMissingReceiptCharge(tr, card) && tr.postedAt >= cutoff,
    );
    if (nearing) nearingCardholders.add(card.cardholderPersonId);
  }
  if (nearingCardholders.size > 0) {
    items.push({
      kind: "cards",
      title: "Cards nearing receipt lock",
      badgeCount: nearingCardholders.size,
      detail:
        nearingCardholders.size === 1
          ? "1 cardholder has a receipt due before the auto-lock"
          : `${nearingCardholders.size} cardholders have a receipt due before the auto-lock`,
      actionLabel: "Review",
    });
  }

  return items;
}

/**
 * The chapter finance dashboard (prototype shape): month tiles, project /
 * recurring budget cards joined to actual spend, enriched recent transactions,
 * an attention queue, plus the fund balances.
 *
 * `{year, month}` default to the current Eastern month so the UI's month
 * stepper can page through history. `period` toggles between the selected month
 * (`"month"`, default) and the cumulative year-to-date range through that month
 * (`"ytd"`); `month` is always the through-month.
 *
 * `chapterId` optionally drills into a DIFFERENT chapter than the caller's own
 * (central-only — see the authz check in the handler); absent (or the
 * caller's own chapter) behaves exactly as before.
 */
export const dashboardChapter = query({
  args: {
    // Central drill-down: view a DIFFERENT chapter's dashboard (see the authz
    // note below). Absent (or the caller's own chapter) is unchanged.
    chapterId: v.optional(v.id("chapters")),
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
    // Count of spend txns with no budget attributed (bounded, all-time-capped
    // scan — a txn from any period still needs a budget). Kept all-time for
    // whatever else consumes it; the dashboard card uses `unattributedCount`
    // (below) instead so its "N transactions" copy matches its period scope.
    toBudgetCount: v.number(),
    // Explicit-only attribution gap, scoped to THIS dashboard period: spend
    // (countsAsSpend — outflow, non-transfer, non-excluded/personal) with no
    // `budgetId` link. Every dollar here is invisible to every budget card
    // above (no derive-matching fallback) — surfaced loudly so it's never
    // silently missing. Taps through to Reconcile's `needs_budget` filter.
    unattributedCents: v.number(),
    // Same period scope + predicate as `unattributedCents`, but a transaction
    // COUNT rather than a dollar figure. Drives the "N transactions need a
    // budget THIS PERIOD" attention card — a SOFT warning, never a block.
    // (`toBudgetCount` above is all-time-scoped, so it undercounts/overcounts
    // relative to this period's copy; don't use it for that card.)
    unattributedCount: v.number(),
    // Chapter spend explicitly linked to a CENTRAL budget (legal — central may
    // fund something a chapter incurred) for THIS dashboard period. Excluded
    // from `unattributedCents` (it has a `budgetId`) but also absent from every
    // chapter budget card above (the linked budget isn't a chapter budget) —
    // without this field the identity `period spend = Σ(cards) + unattributed`
    // silently breaks. An info-tier row, not a warning.
    centralLinkedCents: v.number(),
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
      unattributedCents: 0,
      unattributedCount: 0,
      centralLinkedCents: 0,
    };
    const ownChapterId = await readChapterId(ctx);
    const chapterId = args.chapterId ?? ownChapterId;
    if (!chapterId) return empty;
    // Drilling into a DIFFERENT chapter than the caller's own needs central
    // (org-wide) reach — the same gate `dashboardCentral` uses. The central
    // check resolves the caller's finance capability through their OWN
    // chapter (a central grant is scope-wide regardless of which chapterId
    // it's checked against, but `viewerPerson` only finds a roster row in the
    // chapter passed in, so we must pass the caller's home chapter, not the
    // target one — mirroring `dashboardCentral` below). Otherwise this is the
    // normal same-chapter viewer gate.
    if (args.chapterId != null && args.chapterId !== ownChapterId) {
      // A caller with no chapter of their own has no home to check central
      // reach through — never fall back to the TARGET chapter for this (that
      // would check central-ness against the chapter being drilled into,
      // not the caller's own standing). Throw the same NO_CHAPTER shape
      // `requireChapterId` uses elsewhere.
      if (!ownChapterId) {
        throw new ConvexError({
          code: "NO_CHAPTER",
          message: "You don't belong to a chapter yet.",
        });
      }
      await requireFinanceCentral(ctx, ownChapterId);
    } else {
      await requireFinanceRole(ctx, chapterId, "viewer");
    }

    // One period read for the year drives every budget's actual + the period tile.
    const sandboxMode = await readSandbox(ctx);
    const yearTxns = await loadPeriodTxns(ctx, chapterId, year, sandboxMode);
    // The dashboard period's txns: the selected month, or Jan..throughMonth (YTD).
    const periodTxns = yearTxns.filter((tr) => inDashRange(tr.postedAt, dp));
    const periodSpendCents = sumSpend(periodTxns);
    // Unattributed: this period's spend with no explicit budget link — the
    // dollar amount every budget card above is BLIND to (no derive-matching
    // fallback exists anymore). `isSpend` already excludes transfers/excluded/
    // personal rows, matching invariant #3. `unattributedCount` is the same
    // predicate + period scope as a transaction count (drives the "N
    // transactions" copy on the attention card — see `unattributedCount` above).
    let unattributedCents = 0;
    let unattributedCount = 0;
    for (const tr of periodTxns) {
      if (isSpend(tr) && tr.budgetId == null) {
        unattributedCents += tr.amountCents;
        unattributedCount += 1;
      }
    }

    // Category-name map (chapter-wide, bounded) for budget breakdowns.
    const categoryDocs = await ctx.db
      .query("budgetCategories")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
      .take(ROLLUP_SCAN_LIMIT);
    const catName = new Map(categoryDocs.map((c) => [c._id, c.name] as const));
    const getEvent = nameCache(ctx, "events");
    const getProject = nameCache(ctx, "projects");
    const getCard = nameCache(ctx, "cards");
    const getBudget = nameCache(ctx, "budgets");

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

    // Central-linked: this period's chapter spend explicitly linked to a
    // budget that ISN'T one of this chapter's own (`budgetById` only holds
    // this chapter+year's budgets) — i.e. a central budget (the only other
    // tenancy `categorizeTransaction` allows, see its doc comment). Such a
    // txn has a `budgetId` (so `unattributedCents` correctly excludes it) but
    // appears in no card above (the linked budget isn't a chapter budget),
    // so surface it separately: period spend = Σ(cards) + centralLinkedCents
    // + unattributedCents must hold.
    const externalBudgetCache = new Map<Id<"budgets">, Doc<"budgets"> | null>();
    let centralLinkedCents = 0;
    for (const tr of periodTxns) {
      if (!isSpend(tr) || tr.budgetId == null || budgetById.has(tr.budgetId)) continue;
      let linked = externalBudgetCache.get(tr.budgetId);
      if (linked === undefined) {
        linked = await ctx.db.get(tr.budgetId);
        externalBudgetCache.set(tr.budgetId, linked);
      }
      if (linked && linked.chapterId === CENTRAL) centralLinkedCents += tr.amountCents;
    }

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
      // Only surface a tag rollup once it has an actual charge in the shown
      // period (month or YTD): a budgeted-but-unspent tag is noise on the
      // dashboard, so drop zero-spend entries before returning.
      if (spentCents <= 0) continue;
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
    const getPerson = nameCache(ctx, "people");
    const recentTransactions: (typeof recentTxnCard.type)[] = [];
    for (const tr of recent) {
      // WP-U (one home per dollar): "what this is coded to" is resolved from
      // the txn's BUDGET (never the vestigial `projectId`/`eventId` FKs) — a
      // one_time budget resolves to its event's/project's own name (same
      // display the old FK-based lookup gave); any OTHER budget (recurring,
      // or a one_time budget whose ref has since vanished) falls back to the
      // budget's own display name, so a recurring-budget-coded txn is no
      // longer silently blank here.
      let projectOrEvent: string | undefined;
      if (tr.budgetId) {
        const budget = await getBudget(tr.budgetId);
        if (budget) {
          if (budget.refKind === "event" && budget.scopeRefId) {
            projectOrEvent = (await getEvent(budget.scopeRefId as Id<"events">))?.name;
          } else if (budget.refKind === "project" && budget.scopeRefId) {
            projectOrEvent = (await getProject(budget.scopeRefId as Id<"projects">))?.name;
          }
          projectOrEvent ??= budgetDisplayName(budget);
        }
      }
      // Funds are backend-only (WP-1.4) — every chapter has exactly one, so a
      // fund-name fallback here would just repeat "General Fund" on every
      // uncoded-to-budget row.
      const categoryName = tr.categoryId ? catName.get(tr.categoryId) : undefined;
      const codedTo =
        projectOrEvent || categoryName
          ? { projectOrEvent: projectOrEvent ?? "", category: categoryName ?? "" }
          : null;
      const ai =
        tr.aiSuggestion && tr.aiSuggestion.categoryId
          ? {
              category: catName.get(tr.aiSuggestion.categoryId) ?? "",
            }
          : null;
      // Mirrors `resolveCardholder` (Reconcile): a reassigned central card
      // charge has its `personId` cleared (chapter-scoped link) but keeps its
      // `cardId` (provenance is never touched by reassignment) — fall back to
      // the card's cardholder so the spender still shows up here too.
      let spenderPersonId = tr.personId ?? null;
      if (!spenderPersonId && tr.cardId) {
        const card = await getCard(tr.cardId);
        spenderPersonId = card?.cardholderPersonId ?? null;
      }
      const spenderName = spenderPersonId
        ? (await getPerson(spenderPersonId))?.name ?? null
        : null;
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

    const attention = await chapterAttentionQueue(ctx, chapterId);

    return {
      tiles,
      oneTimeBudgets,
      recurringBudgets,
      tagRollups,
      recentTransactions,
      attention,
      funds,
      toBudgetCount,
      unattributedCents,
      unattributedCount,
      centralLinkedCents,
    };
  },
});

/**
 * WP-4.3 "can we afford this?" — the chapter dashboard's affordability header.
 * Backers (manual entry, §0.1) → monthly revenue → tier → operating floor →
 * central skim → discretionary. All arithmetic lives in
 * `chapterAffordability` (`@events-os/shared`) — this query only resolves the
 * two inputs (backer count, teammate count) and the caller's edit capability.
 *
 * Supports the same central drill-down as `dashboardChapter` (viewing a
 * DIFFERENT chapter's header, read-only) so the two stay consistent on the
 * same dashboard render — an FM drilled into a chapter must see THAT
 * chapter's affordability, not their own.
 */
export const chapterAffordability = query({
  args: {
    chapterId: v.optional(v.id("chapters")),
  },
  returns: v.object({
    backerCount: v.number(),
    // The chapter's active team-member headcount — the honest queryable
    // stand-in for the playbook's "teammate" (there's no separate roster of
    // "funded seats" yet). Counts `people` rows in this chapter where
    // `isSamplePerson !== true` (Academy sandbox bench, never real) and EITHER
    // `isTeamMember === true` OR the row is linked to a real user account —
    // the exact predicate `people.teamMembers` already uses as this app's one
    // definition of "team member", so this doesn't invent a second one.
    // Placeholder crew (`isPlaceholder`) are excluded: they're a stand-in
    // slot, not a funded seat drawing the $50/mo operating-floor add-on.
    teammateCount: v.number(),
    monthlyRevenueCents: v.number(),
    tierLabel: v.string(),
    floorCents: v.number(),
    skimCents: v.number(),
    discretionaryCents: v.number(),
    // True iff the caller may edit THIS chapter's backer count (chapter
    // finance-manager rank at the chapter being viewed — false during
    // central drill-down, mirroring every other write action `ChapterView`
    // hides in that state).
    canEdit: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const ownChapterId = await readChapterId(ctx);
    const chapterId = args.chapterId ?? ownChapterId;
    if (!chapterId) {
      throw new ConvexError({
        code: "NO_CHAPTER",
        message: "You don't belong to a chapter yet.",
      });
    }

    let access;
    if (args.chapterId != null && args.chapterId !== ownChapterId) {
      // Drilling into a different chapter than the caller's own needs central
      // reach, checked through the caller's OWN chapter — mirrors
      // `dashboardChapter`'s identical drill-down gate.
      if (!ownChapterId) {
        throw new ConvexError({
          code: "NO_CHAPTER",
          message: "You don't belong to a chapter yet.",
        });
      }
      access = await requireFinanceCentral(ctx, ownChapterId);
    } else {
      access = await requireFinanceRole(ctx, chapterId, "viewer");
    }

    const chapter = await ctx.db.get(chapterId);
    const backerCount = chapter?.backerCount ?? 0;

    const roster = await ctx.db
      .query("people")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
      .collect();
    const teammateCount = roster.filter(
      (p) =>
        p.isSamplePerson !== true &&
        p.isPlaceholder !== true &&
        (p.isTeamMember === true || p.userId != null),
    ).length;

    const computed = chapterAffordabilityCalc(backerCount, teammateCount);
    const canEdit = chapterId === ownChapterId && access.isManager;

    return { backerCount, teammateCount, ...computed, canEdit };
  },
});

/**
 * Set the chapter's manual backer count (WP-4.3). Chapter finance-manager
 * rank only (Chapter Director/Treasurer — the seats the PRD names for this;
 * `requireFinanceManager` is the graded ladder's manager gate, which the
 * `finance_manager`-title bridge and superusers already satisfy). Always the
 * CALLER's own chapter (`requireChapterId`) — there is no chapterId arg,
 * mirroring every other write in this file (a central drill-down viewer never
 * gets a write path here; the UI hides the edit affordance via `canEdit`).
 */
export const setBackerCount = mutation({
  args: { backerCount: v.number() },
  returns: v.object({ backerCount: v.number() }),
  handler: async (ctx, { backerCount }) => {
    if (!Number.isInteger(backerCount) || backerCount < 0) {
      throw new ConvexError({
        code: "INVALID_BACKER_COUNT",
        message: "Backer count must be a non-negative whole number.",
      });
    }
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireFinanceManager(ctx, chapterId);
    const updatedBy = (await requireUserId(ctx)) as Id<"users">;
    await ctx.db.patch(chapterId, {
      backerCount,
      backerCountUpdatedAt: Date.now(),
      backerCountUpdatedBy: updatedBy,
    });
    return { backerCount };
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
    // Org-wide Unattributed: the sum, across every chapter, of this period's
    // spend with no explicit `budgetId` link (see `dashboardChapter`'s field
    // of the same name — central has no txns of its own yet, so this is purely
    // the cross-chapter sum).
    orgUnattributedCents: v.number(),
    // The City Launch Fund position (WP-4.1/4.2), derived from the central legs
    // of skim (inflow) + launch-grant (outflow) transfer pairs. `positionCents`
    // = all-time skims received − launch grants made; the `period*` figures are
    // the same, bounded to the dashboard period.
    cityLaunchFund: v.object({
      skimsReceivedCents: v.number(),
      launchGrantsMadeCents: v.number(),
      positionCents: v.number(),
      periodSkimsReceivedCents: v.number(),
      periodLaunchGrantsMadeCents: v.number(),
      periodNetCents: v.number(),
    }),
  }),
  handler: async (ctx, args) => {
    const now = easternParts(Date.now());
    const year = args.year ?? now.year;
    const month = args.month ?? now.month;
    const ytd = (args.period ?? "month") === "ytd";
    const dp: DashPeriod = { year, month, ytd };
    const spentSuffix = ytd ? "YTD" : MONTH_NAMES[month - 1];

    const emptyFund = {
      skimsReceivedCents: 0,
      launchGrantsMadeCents: 0,
      positionCents: 0,
      periodSkimsReceivedCents: 0,
      periodLaunchGrantsMadeCents: 0,
      periodNetCents: 0,
    };
    const empty = {
      tiles: [] as never[],
      tagRollups: [] as never[],
      chapterRollup: [] as never[],
      centralBudgets: [] as never[],
      totalMonthSpendCents: 0,
      orgUnattributedCents: 0,
      cityLaunchFund: emptyFund,
    };
    const chapterId = await readChapterId(ctx);
    if (!chapterId) return empty;
    await requireFinanceCentral(ctx, chapterId);

    const chapters = await ctx.db.query("chapters").take(ROLLUP_SCAN_LIMIT);
    // Read the env flag once for the whole cross-chapter rollup.
    const sandboxMode = await readSandbox(ctx);

    // Central budgets, loaded once up front (not just for the "Central" row
    // built below, but also to PARTITION each chapter row's spend): a txn
    // whose `budgetId` resolves to one of these belongs to the Central row,
    // not its posting chapter's row — otherwise the same dollar is counted in
    // both (mirrors `dashboardChapter`'s `centralLinkedCents` split, WP-0.1).
    const centralBudgetDocs = await ctx.db
      .query("budgets")
      .withIndex("by_chapter_and_period", (q) =>
        q.eq("chapterId", CENTRAL).eq("year", year),
      )
      .take(ROLLUP_SCAN_LIMIT);
    const centralBudgetById = new Map(centralBudgetDocs.map((b) => [b._id, b] as const));
    const centralBudgetIds = new Set(centralBudgetDocs.map((b) => b._id));

    let totalMonthSpendCents = 0;
    let orgUnattributedCents = 0;
    let activeChapters = 0;
    let toReviewOrg = 0;
    // Running sum of CHAPTER spend explicitly linked to a central budget — the
    // amount partitioned OUT of each chapter's own row (below) and INTO the
    // Central row. Kept disjoint from central-OWNED spend (a real chapter's
    // txns can never be `chapterId:"central"`), so the Central row never
    // double-counts (WP-2.1).
    let chapterLinkedToCentralCents = 0;

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
      // Full chapter spend (drives the org-wide "Spent" tile below, where
      // each real dollar — central-linked or not — is counted exactly once
      // under whichever chapter it was posted in).
      const chapterPeriodSpend = sumSpend(dashTxns);
      totalMonthSpendCents += chapterPeriodSpend;
      orgUnattributedCents += dashTxns.reduce(
        (s, tr) => (isSpend(tr) && tr.budgetId == null ? s + tr.amountCents : s),
        0,
      );
      // This chapter ROW's spend excludes central-linked txns — those are
      // surfaced only in the "Central" row below (see the partition comment
      // where `centralBudgetIds` is built). Without this exclusion the same
      // txn is double-counted: once here, once in the Central row.
      const linkedToCentralThisChapter = dashTxns.reduce(
        (s, tr) =>
          isSpend(tr) && tr.budgetId != null && centralBudgetIds.has(tr.budgetId)
            ? s + tr.amountCents
            : s,
        0,
      );
      chapterLinkedToCentralCents += linkedToCentralThisChapter;
      const chapterOwnSpendCents = chapterPeriodSpend - linkedToCentralThisChapter;

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

      const barPct = barPctOf(chapterOwnSpendCents, budgetCents);
      chapterRollup.push({
        chapterId: chapter._id,
        chapterName: chapter.name,
        subtitle: null,
        spentCents: chapterOwnSpendCents,
        budgetCents,
        barPct,
        status: statusFor(pctOf(chapterOwnSpendCents, budgetCents)),
      });
    }

    // Org-level (central) budgets roll up across EVERY chapter: their actual is
    // the sum of all chapters' transactions explicitly linked to them (by
    // `budgetId`). `centralBudgetDocs`/`centralBudgetById` were already loaded
    // above (before the chapter loop, to build `centralBudgetIds` for the
    // per-row partition) — reused here, no second scan. Per-chapter rollups
    // above never see these budgets in their OWN allocation (they query
    // budgets by real chapterId) and now exclude their linked spend too, so
    // nothing here is double-counted.
    const centralSpentById = new Map<Id<"budgets">, number>();
    const centralBudgets: (typeof centralBudgetCard.type)[] = [];
    for (const cb of centralBudgetDocs) {
      const linked = await ctx.db
        .query("transactions")
        .withIndex("by_budget", (q) => q.eq("budgetId", cb._id))
        .take(ROLLUP_SCAN_LIMIT);
      // Unlike yearTxns/periodTxns (already mode-filtered via loadPeriodTxns),
      // this is a raw by-budget scan — filter sandbox vs prod explicitly so
      // central budget cards don't mix modes (#151).
      const spentCents = linked.reduce(
        (s, tr) =>
          txnMatchesMode(tr, sandboxMode) && txnCountsTowardBudgetDash(tr, cb, dp)
            ? s + tr.amountCents
            : s,
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

    // CENTRAL-OWNED transactions (WP-2.1): txns whose `chapterId` IS the
    // `"central"` sentinel — money that belongs to central directly, not to any
    // chapter. Read once via the same period index (keyed on the string), then
    // narrowed to the dashboard period. These are DISJOINT from every chapter's
    // txns (a real chapter's rows can never carry `chapterId:"central"`), so
    // adding them double-counts nothing.
    const centralOwnedPeriodTxns = await loadPeriodTxns(ctx, CENTRAL, year, sandboxMode);
    const centralOwnedDashTxns = centralOwnedPeriodTxns.filter((tr) =>
      inDashRange(tr.postedAt, dp),
    );
    const centralOwnedSpendCents = sumSpend(centralOwnedDashTxns);
    // Central-owned spend is real money — it belongs in the org-wide "Spent"
    // tile and the org Unattributed sum, exactly like a chapter's spend does.
    totalMonthSpendCents += centralOwnedSpendCents;
    orgUnattributedCents += centralOwnedDashTxns.reduce(
      (s, tr) => (isSpend(tr) && tr.budgetId == null ? s + tr.amountCents : s),
      0,
    );
    // Central-owned unreviewed txns count toward the org "to review" tile too —
    // they are reconcilable at the central desk (see `listReconcile`).
    const centralUnreviewed = await ctx.db
      .query("transactions")
      .withIndex("by_chapter_and_status", (q) =>
        q.eq("chapterId", CENTRAL).eq("status", "unreviewed"),
      )
      .take(ROLLUP_SCAN_LIMIT);
    toReviewOrg += centralUnreviewed.length;

    // "Central" row (WP-0.3 + WP-2.1): the spend that BELONGS to central. Two
    // disjoint parts, summed with no double-count:
    //   (1) central-OWNED spend — every `chapterId:"central"` txn's spend,
    //       whether or not it's linked to a central budget; PLUS
    //   (2) chapter spend LINKED to a central budget — the amount partitioned
    //       out of each chapter row above (`chapterLinkedToCentralCents`).
    // (1) and (2) can never overlap: (1) is central-owned rows, (2) is
    // real-chapter rows. NOTE: this is NOT `Σ centralBudgets[].spentCents` —
    // that sum omits central-owned txns with no budget link and would drop a
    // central-owned txn that IS linked (already inside (1)), so it's replaced.
    const centralRowSpentCents = centralOwnedSpendCents + chapterLinkedToCentralCents;
    const centralRowBudgetCents = centralBudgets.reduce((s, b) => s + b.budgetCents, 0);
    const centralRow: (typeof chapterRollupRow.type) = {
      chapterId: CENTRAL,
      chapterName: "Central",
      subtitle: null,
      spentCents: centralRowSpentCents,
      budgetCents: centralRowBudgetCents,
      barPct: barPctOf(centralRowSpentCents, centralRowBudgetCents),
      status: statusFor(pctOf(centralRowSpentCents, centralRowBudgetCents)),
    };
    chapterRollup.unshift(centralRow);

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
      // Only surface a tag rollup once it has an actual charge in the shown
      // period: drop zero-spend (budgeted-but-unspent) tags before returning.
      .filter((agg) => agg.spentCents > 0)
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

    // City Launch Fund position (WP-4.1/4.2): the CENTRAL legs of skim (money
    // into the fund) + launch-grant (money out) transfer pairs. Read all central
    // rows once (bounded) — transfer legs are low-volume (≤1 skim/chapter/month,
    // ≤1 launch/chapter ever) — and sum by `source`. All-time drives the fund
    // balance; the `period*` figures narrow the same legs to the dashboard period.
    const allCentralTxns = await ctx.db
      .query("transactions")
      .withIndex("by_chapter", (q) => q.eq("chapterId", CENTRAL))
      .take(ROLLUP_SCAN_LIMIT);
    if (allCentralTxns.length === ROLLUP_SCAN_LIMIT) {
      console.warn(
        `[finances] City Launch Fund scan hit ROLLUP_SCAN_LIMIT (${ROLLUP_SCAN_LIMIT}) reading central transactions; fund position may be truncated.`,
      );
    }
    let skimsReceivedCents = 0;
    let launchGrantsMadeCents = 0;
    let periodSkimsReceivedCents = 0;
    let periodLaunchGrantsMadeCents = 0;
    for (const tr of allCentralTxns) {
      // NOT `txnMatchesMode` — that helper short-circuits `true` for any
      // source other than `increase_card`/`increase_ach`, which would let a
      // sandbox-initiated transfer leg (externalId `sandbox_account_transfer_
      // …`) count toward the PRODUCTION fund position forever. A transfer leg
      // carries its own env in `externalId` when it's a real Increase
      // movement, so check that directly; a manual leg (no externalId) has
      // none and stays env-neutral (`matchesMode` returns `true` for a
      // falsy id either way).
      if (!matchesMode(tr.externalId ?? null, sandboxMode)) continue;
      const inPeriod = inDashRange(tr.postedAt, dp);
      if (tr.source === "skim") {
        skimsReceivedCents += tr.amountCents;
        if (inPeriod) periodSkimsReceivedCents += tr.amountCents;
      } else if (tr.source === "launch_grant") {
        launchGrantsMadeCents += tr.amountCents;
        if (inPeriod) periodLaunchGrantsMadeCents += tr.amountCents;
      }
    }
    const cityLaunchFund = {
      skimsReceivedCents,
      launchGrantsMadeCents,
      positionCents: skimsReceivedCents - launchGrantsMadeCents,
      periodSkimsReceivedCents,
      periodLaunchGrantsMadeCents,
      periodNetCents: periodSkimsReceivedCents - periodLaunchGrantsMadeCents,
    };

    return {
      tiles,
      tagRollups,
      chapterRollup,
      centralBudgets,
      totalMonthSpendCents,
      orgUnattributedCents,
      cityLaunchFund,
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
async function actualsForRef(
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
    return actualsForRef(ctx, chapterId, "event", args.eventId);
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
    return actualsForRef(ctx, chapterId, "project", args.projectId);
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

/**
 * Transactions attached to a person (defaults to the caller when omitted).
 *
 * A caller with NO finance seat (the member/cardholder case) may always read
 * their OWN transactions here — this is their "My transactions" surface, not a
 * finance-role read. Looking up a DIFFERENT person's transactions (the
 * manager/bookkeeper audit path) still requires at least the viewer role.
 *
 * Privacy default: the projection omits `note` entirely (see
 * `personTxnSummary`) — a member's own transactions never surface the
 * bookkeeper's internal annotation.
 */
export const personTransactions = query({
  args: { personId: v.optional(v.id("people")) },
  returns: v.array(personTxnSummary),
  handler: async (ctx, args) => {
    const chapterId = await readChapterId(ctx);
    if (!chapterId) return [];
    const self = await viewerPerson(ctx, chapterId);

    let personId = args.personId ?? null;
    if (personId) {
      if (self == null || personId !== self._id) {
        await requireFinanceRole(ctx, chapterId, "viewer");
      }
      await requireInCallerChapter(ctx, chapterId, "people", personId, "Person");
    } else {
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
      .map(toPersonTxnSummary);
  },
});

// ── Funds ────────────────────────────────────────────────────────────────────
// No `listFunds` query — the funds UI was removed in WP-1.4/#145 (funds are
// backend-only; see `lib/finance.ts#defaultFundId`'s doc comment).

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
 *
 * NOT the same resolver as `lib/finance.ts#defaultFundId` (#145) — that one
 * auto-codes NEW spend and must never fall back to a restricted fund, so it
 * stops at `null` instead of picking one. This one is a migration/merge-target
 * picker (seeding default categories, merging funds into "General") where any
 * existing fund is an acceptable keeper, restricted or not.
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
 * Shared: seed one chapter's default fund + expense categories. First ensures
 * the chapter's default fund exists (General Fund — the only fund, see
 * WP-1.4) — so a chapter created before the finance seed (zero funds) is fixed
 * in one shot — then seeds the default categories under its General Fund.
 * Idempotent (skips funds / categories whose names already exist). Returns the
 * count of categories inserted (0 if, unexpectedly, no General Fund can be
 * resolved).
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

// ── The "For" picker (WP-U: one home per dollar) ─────────────────────────────
/** `name + date` — the "For" picker's row label, always dated (unlike
 *  `eventBudgetLabel`/`projectBudgetLabel`'s conditional disambiguation) so a
 *  budget-less summon-candidate reads exactly like a budgeted one. */
function pickerRefLabel(name: string, ts: number): string {
  const p = easternParts(ts);
  const monthName = MONTH_NAMES[p.month - 1].slice(0, 3);
  return `${name} · ${monthName} ${p.day}, ${p.year}`;
}

const forPickerRefRow = v.object({
  label: v.string(),
  // Present when a budget already exists for this event/project (the one_time
  // budget created by the D8 create-time hook or a backfill); `null` marks a
  // SUMMON-CANDIDATE — the picker still offers it (grouped the same way), and
  // choosing it calls `summonBudgetForRef` first to create its $0 budget.
  budgetId: v.union(v.id("budgets"), v.null()),
});

export const forPickerOptions = query({
  args: {},
  returns: v.object({
    // The chapter's own (non-training) events — always chapter-scoped (events
    // never transfer to central, unlike project budgets — WP-2.2 finding).
    events: v.array(v.object({ eventId: v.id("events"), ...forPickerRefRow.fields })),
    // The chapter's own projects. A project's BUDGET may have moved to central
    // (`transferProjectScope`) while the project row stays put — `budgetId`
    // reflects wherever the budget currently lives, found via `by_ref` (same
    // discovery `transferProjectScope` itself relies on).
    projects: v.array(v.object({ projectId: v.id("projects"), ...forPickerRefRow.fields })),
    // Every budget that ISN'T a one_time event/project budget — recurring
    // budgets (chapter or central) plus any legacy/odd budget shape, so
    // nothing silently disappears from the picker. Grouped by `level` in the
    // UI (mirrors the old Budget picker's Chapter/Central split).
    recurring: v.array(
      v.object({
        budgetId: v.id("budgets"),
        label: v.string(),
        level: v.union(v.literal("chapter"), v.literal("central")),
      }),
    ),
  }),
  handler: async (ctx) => {
    const empty = { events: [], projects: [], recurring: [] };
    const chapterId = await readChapterId(ctx);
    if (!chapterId) return empty;
    await requireFinanceRole(ctx, chapterId, "viewer");

    const [events, projects, chapterBudgets, centralBudgets] = await Promise.all([
      ctx.db
        .query("events")
        .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
        .take(ROLLUP_SCAN_LIMIT),
      ctx.db
        .query("projects")
        .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
        .take(ROLLUP_SCAN_LIMIT),
      ctx.db
        .query("budgets")
        .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
        .take(ROLLUP_SCAN_LIMIT),
      ctx.db
        .query("budgets")
        .withIndex("by_chapter", (q) => q.eq("chapterId", CENTRAL))
        .take(ROLLUP_SCAN_LIMIT),
    ]);
    const projectIds = new Set(projects.map((p) => p._id as string));

    const eventBudgetByRef = new Map<string, Doc<"budgets">>();
    const projectBudgetByRef = new Map<string, Doc<"budgets">>();
    const recurring: { budgetId: Id<"budgets">; label: string; level: "chapter" | "central" }[] = [];

    // A ref should only ever have one budget (the D8 invariant, enforced at
    // creation by `createBudget`'s dedup guard), but legacy data can still
    // carry a duplicate one_time budget for the same ref. Rule: keep the
    // OLDEST (lowest `createdAt`) — the auto-created/backfilled one, not
    // whichever happened to sort last in the scan — so the picker shows ONE
    // deterministic entry per ref instead of flapping between duplicates.
    const setPreferOldest = (
      map: Map<string, Doc<"budgets">>,
      key: string,
      candidate: Doc<"budgets">,
    ) => {
      const existing = map.get(key);
      if (!existing || candidate.createdAt < existing.createdAt) {
        map.set(key, candidate);
      }
    };

    for (const b of chapterBudgets) {
      if (b.type === "one_time" && b.refKind === "event" && b.scopeRefId) {
        setPreferOldest(eventBudgetByRef, b.scopeRefId, b);
      } else if (b.type === "one_time" && b.refKind === "project" && b.scopeRefId) {
        setPreferOldest(projectBudgetByRef, b.scopeRefId, b);
      } else {
        recurring.push({ budgetId: b._id, label: budgetDisplayName(b), level: "chapter" });
      }
    }
    for (const b of centralBudgets) {
      // A central one_time PROJECT budget only belongs in this chapter's
      // groups when it's THIS chapter's project (post-`transferProjectScope`)
      // — a central budget for some other chapter's project stays invisible
      // here (events never carry a central budget — see the schema doc).
      if (
        b.type === "one_time" &&
        b.refKind === "project" &&
        b.scopeRefId &&
        projectIds.has(b.scopeRefId)
      ) {
        setPreferOldest(projectBudgetByRef, b.scopeRefId, b);
      } else {
        recurring.push({ budgetId: b._id, label: budgetDisplayName(b), level: "central" });
      }
    }

    const eventRows = events
      .filter((e) => !e.isTraining)
      .map((e) => ({
        eventId: e._id,
        label: pickerRefLabel(e.name, e.eventDate),
        budgetId: eventBudgetByRef.get(e._id as string)?._id ?? null,
      }));
    const projectRows = projects.map((p) => ({
      projectId: p._id,
      label: pickerRefLabel(p.name, p.startDate ?? p.createdAt),
      budgetId: projectBudgetByRef.get(p._id as string)?._id ?? null,
    }));

    return { events: eventRows, projects: projectRows, recurring };
  },
});

/**
 * Get-or-create the one_time budget for an event/project ref — the "For"
 * picker's summon-on-pick (WP-U): choosing a budget-less event/project
 * SUMMONS its budget at $0 (a real "plan $0" budget, not clutter — it
 * immediately has linked spend once the caller attributes a transaction to
 * it, which keeps `removeEmptyAutoBudgets` from ever touching it). Reuses the
 * exact D8 creation helpers (`createEventBudget`/`createProjectBudget`) so a
 * summoned budget is indistinguishable from one the create-time hook or a
 * backfill made. Idempotent: a second call for the same ref returns the
 * existing budget instead of creating a duplicate. `userId` is optional so
 * the no-auth `migrateLinksToBudgets` migration can reuse this too.
 */
async function ensureBudgetForRef(
  ctx: MutationCtx,
  chapterId: Id<"chapters">,
  refKind: BudgetRefKind,
  scopeRefId: string,
  userId: Id<"users"> | undefined,
): Promise<Id<"budgets">> {
  const existing = await ctx.db
    .query("budgets")
    .withIndex("by_ref", (q) => q.eq("refKind", refKind).eq("scopeRefId", scopeRefId))
    .first();
  if (existing) return existing._id;

  if (refKind === "event") {
    const event = await requireInCallerChapter(
      ctx,
      chapterId,
      "events",
      scopeRefId as Id<"events">,
      "Event",
    );
    await createEventBudget(ctx, event, userId);
  } else {
    const project = await requireInCallerChapter(
      ctx,
      chapterId,
      "projects",
      scopeRefId as Id<"projects">,
      "Project",
    );
    // Summon at $0 — never the project's own `budgetUsd` — this path is ONLY
    // reached when no budget exists yet, i.e. `budgetUsd` was never positive
    // (the owner rule's create-time hook would have already made one).
    await createProjectBudget(ctx, { ...project, budgetUsd: undefined }, userId);
  }
  const created = await ctx.db
    .query("budgets")
    .withIndex("by_ref", (q) => q.eq("refKind", refKind).eq("scopeRefId", scopeRefId))
    .first();
  if (!created) {
    throw new ConvexError({
      code: "INTERNAL",
      message: "Failed to summon a budget for this ref.",
    });
  }
  return created._id;
}

export const summonBudgetForRef = mutation({
  args: {
    refKind: refKindValidator,
    scopeRefId: v.string(),
  },
  returns: v.id("budgets"),
  handler: async (ctx, args) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    const userId = (await requireUserId(ctx)) as Id<"users">;
    await requireFinanceRole(ctx, chapterId, "bookkeeper");
    return await ensureBudgetForRef(ctx, chapterId, args.refKind, args.scopeRefId, userId);
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
    // D8 invariant: every money-carrying event/project has EXACTLY one
    // budget. `by_ref` finds a match regardless of which scope currently
    // owns it (a project's budget can live at central post-transfer — same
    // reasoning as `hasBudgetForRef`/`ensureBudgetForRef`) — reject rather
    // than silently create a second home for the same ref, which would make
    // `actualsForRef`'s sum-across-duplicates the norm instead of a legacy
    // fallback.
    if (refKind && scopeRefId) {
      const existingForRef = await ctx.db
        .query("budgets")
        .withIndex("by_ref", (q) => q.eq("refKind", refKind).eq("scopeRefId", scopeRefId))
        .first();
      if (existingForRef) {
        throw new ConvexError({
          code: "REF_ALREADY_BUDGETED",
          message: `This ${refKind} already has a budget ("${budgetDisplayName(existingForRef)}") — every event/project gets exactly one budget. Edit the existing budget (${existingForRef._id}) instead of creating another.`,
        });
      }
    }
    const level: BudgetLevel = args.central ? CENTRAL : chapterId;
    // Verify each explicit tag is usable at this budget's level BEFORE inserting.
    for (const tagId of args.tagIds ?? []) {
      await requireTagInLevel(ctx, level, tagId);
    }
    const userId = (await requireUserId(ctx)) as Id<"users">;
    // Default an event budget's label to the linked event's name when none was
    // given, so the picker/tag-detail shows the event name instead of the
    // "One-time" type word. Disambiguate repeated event names (see
    // `eventBudgetLabel`). Non-event or explicitly-labeled budgets are untouched.
    let label = args.label;
    if (label == null && args.type === "one_time" && refKind === "event" && scopeRefId) {
      const ev = await ctx.db.get(scopeRefId as Id<"events">);
      if (ev && "name" in ev) {
        const event = ev as Doc<"events">;
        const parts = easternParts(event.eventDate);
        // Sibling events sharing this name in the SAME chapter decide whether the
        // bare name is ambiguous (bounded scan; training events don't get budgets).
        const siblings = (
          await ctx.db
            .query("events")
            .withIndex("by_chapter", (q) => q.eq("chapterId", event.chapterId))
            .take(ROLLUP_SCAN_LIMIT)
        ).filter((e) => !e.isTraining && e.name === event.name);
        const sameMonthCount = siblings.filter((e) => {
          const ep = easternParts(e.eventDate);
          return ep.year === parts.year && ep.month === parts.month;
        }).length;
        label = eventBudgetLabel(event.name, parts, siblings.length, sameMonthCount);
      }
    }
    // Silently default a CHAPTER budget to its General Fund when the client
    // omits a fund (no UI ever sends one — funds are backend-only, see
    // WP-1.4). Central budgets have no chapter to resolve a fund from — the
    // "central" sentinel isn't a `funds`-scoping chapter — so they stay
    // fund-less, same as today.
    const fundId =
      args.fundId ??
      (args.central ? undefined : (await defaultFundId(ctx, chapterId)) ?? undefined);
    const budgetId = await ctx.db.insert("budgets", {
      chapterId: level,
      amountCents: args.amountCents,
      label,
      type: args.type,
      refKind,
      scopeRefId,
      cadence: args.cadence,
      year: args.year,
      month: args.month,
      quarter: args.quarter,
      fundId,
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
    // budget's stored one. `refKind` and `scopeRefId` must stay consistent (an
    // event id compared as a project id, or vice versa, is meaningless) — verify
    // the effective pair, not just a freshly-patched `scopeRefId`.
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

/**
 * Cascade-delete a budget's own dependent rows — its `budgetTagLinks` and its
 * WP-3.1 `budgetLines` plan breakdown — then the budget itself. Shared by
 * `deleteBudget` and `removeEmptyAutoBudgets` so the ops cleanup can't drift
 * from the user-facing delete and orphan `budgetLines` rows behind a budget
 * that no longer exists (a bug this fixed: the cleanup used to delete budgets
 * inline without this cascade). Does NOT touch `transactions` — callers that
 * need to unlink spend do that themselves first (only `deleteBudget` does;
 * `removeEmptyAutoBudgets` only ever reaches a budget with zero linked txns).
 */
async function cascadeDeleteBudget(ctx: MutationCtx, budgetId: Id<"budgets">): Promise<void> {
  const links = await ctx.db
    .query("budgetTagLinks")
    .withIndex("by_budget", (q) => q.eq("budgetId", budgetId))
    .take(ROLLUP_SCAN_LIMIT);
  for (const link of links) await ctx.db.delete(link._id);

  const lines = await ctx.db
    .query("budgetLines")
    .withIndex("by_budget", (q) => q.eq("budgetId", budgetId))
    .take(ROLLUP_SCAN_LIMIT);
  for (const line of lines) await ctx.db.delete(line._id);

  await ctx.db.delete(budgetId);
}

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
    // Clear the explicit link on every txn attributed to this budget FIRST —
    // otherwise a linked txn's `budgetId` points at a deleted doc: invisible
    // to every budget card (it's no one's budget anymore), to
    // `unattributedCents` (its `budgetId` is still non-null), and to
    // `listReconcile`'s `needs_budget` filter (same reason) — the dollar
    // vanishes from every surface. Dropping the link sends it loudly back
    // into Unattributed instead.
    const linkedTxns = await ctx.db
      .query("transactions")
      .withIndex("by_budget", (q) => q.eq("budgetId", args.budgetId))
      .take(ROLLUP_SCAN_LIMIT);
    if (linkedTxns.length === ROLLUP_SCAN_LIMIT) {
      console.warn(
        `[finances] deleteBudget hit ROLLUP_SCAN_LIMIT (${ROLLUP_SCAN_LIMIT}) unlinking transactions from budget ${args.budgetId}; some linked transactions may still reference the deleted budget.`,
      );
    }
    for (const tr of linkedTxns) await ctx.db.patch(tr._id, { budgetId: undefined });

    // Remove its tag links + WP-3.1 `budgetLines` plan, then the budget.
    await cascadeDeleteBudget(ctx, args.budgetId);
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

// ── Event-budget backfill (populate the dashboard's Events & Projects) ───────
const eventBudgetBackfillResult = v.object({
  created: v.number(),
  skipped: v.number(),
  // How many already-existing event budgets had a null/empty label patched to
  // the event's name on this run (a subset of `skipped`; 0 on a settled re-run).
  relabeled: v.number(),
  tagsLinked: v.number(),
});

/**
 * Backfill body: give every existing EVENT a one_time budget so it appears in
 * the finance dashboard's "Events & Projects" section and charges can roll up
 * per event. Mirrors what `createBudget` writes for a one_time event budget
 * (`type:"one_time"`, `refKind:"event"`, `scopeRefId:<eventId>`,
 * `cadence:"per_instance"`) and reuses `autoTagEventBudget` for the eventType
 * `template` tag + the catch-all "events" tag.
 *
 * Bounded + idempotent:
 *  - Scans one chapter's events (via `by_chapter`) or a bounded slice of all
 *    events when `chapterId` is omitted.
 *  - SKIPS an event that already has an attached budget — v2 (`type:"one_time"`)
 *    OR legacy (`scope:"event"`) — with a matching `scopeRefId`, so re-runs are
 *    no-ops.
 *  - SKIPS `isTraining` events: training events must never pollute finance
 *    rollups (same invariant that excludes them from dashboard rollups).
 *  - Owner rule ("budgets only exist when money does"): SKIPS an event with no
 *    positive `budget` (unset, 0, or negative) — a budget object with nothing
 *    in it is dashboard clutter, not a useful planning row. `amountCents` =
 *    the event's `budget` (dollars) × 100 as an integer for the events this
 *    creates a budget for. `year`/`month` come from the event's `eventDate` in
 *    Eastern time so the budget lands in the event's month on the dashboard.
 */
async function runBackfillEventBudgets(
  ctx: MutationCtx,
  chapterId?: Id<"chapters">,
): Promise<{ created: number; skipped: number; relabeled: number; tagsLinked: number }> {
  let created = 0;
  let skipped = 0;
  let relabeled = 0;
  let tagsLinked = 0;

  // Guard: a passed chapter must exist (ConvexError, not a silent no-op).
  if (chapterId) {
    const chapter = await ctx.db.get(chapterId);
    if (!chapter) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Chapter not found." });
    }
  }

  // Bounded event scan: one chapter via index, else a bounded full slice.
  const events = chapterId
    ? await ctx.db
        .query("events")
        .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
        .take(ROLLUP_SCAN_LIMIT)
    : await ctx.db.query("events").take(ROLLUP_SCAN_LIMIT);

  // Disambiguation counts over the scanned (non-training) events, keyed by
  // chapter so a name is only "repeated" within its own chapter: how many events
  // share a name, and how many share a name AND an Eastern year+month. Drives
  // `eventBudgetLabel` on both the create and the relabel path.
  const nameCounts = new Map<string, number>();
  const nameMonthCounts = new Map<string, number>();
  const NUL = " ";
  for (const ev of events) {
    if (ev.isTraining) continue; // training events never get a budget
    if (ev.budget == null || ev.budget <= 0) continue; // owner rule: no money, no budget
    const p = easternParts(ev.eventDate);
    const nk = `${ev.chapterId}${NUL}${ev.name}`;
    const mk = `${nk}${NUL}${p.year}-${p.month}`;
    nameCounts.set(nk, (nameCounts.get(nk) ?? 0) + 1);
    nameMonthCounts.set(mk, (nameMonthCounts.get(mk) ?? 0) + 1);
  }

  // Per-chapter cache of the existing event budget keyed by `scopeRefId`, so
  // dedup costs one bounded read per chapter instead of one per event. Holding
  // the doc (not just the id) lets the dedup path relabel an unlabeled budget.
  const eventBudgetByRefByChapter = new Map<string, Map<string, Doc<"budgets">>>();
  const eventBudgetsByRef = async (
    cid: Id<"chapters">,
  ): Promise<Map<string, Doc<"budgets">>> => {
    const key = cid as string;
    const cached = eventBudgetByRefByChapter.get(key);
    if (cached) return cached;
    const map = new Map<string, Doc<"budgets">>();
    const rows = await ctx.db
      .query("budgets")
      .withIndex("by_chapter", (q) => q.eq("chapterId", cid))
      .take(ROLLUP_SCAN_LIMIT);
    for (const b of rows) {
      // Already attached to an event: v2 one_time OR legacy scope:"event".
      if ((b.type === "one_time" || b.scope === "event") && b.scopeRefId && !map.has(b.scopeRefId)) {
        map.set(b.scopeRefId, b);
      }
    }
    eventBudgetByRefByChapter.set(key, map);
    return map;
  };

  for (const ev of events) {
    // Training events never pollute finance rollups (schema invariant).
    if (ev.isTraining) {
      skipped++;
      continue;
    }
    // Owner rule: no positive budget → no budget object. Existing zero-amount
    // budgets from before this rule aren't touched here — see
    // `removeEmptyAutoBudgets` for that cleanup.
    if (ev.budget == null || ev.budget <= 0) {
      skipped++;
      continue;
    }
    const cid = ev.chapterId;
    const existing = await eventBudgetsByRef(cid);
    // The disambiguated label for this event (name, name+month, or name+date).
    const parts = easternParts(ev.eventDate);
    const nk = `${cid}${NUL}${ev.name}`;
    const mk = `${nk}${NUL}${parts.year}-${parts.month}`;
    const label = eventBudgetLabel(
      ev.name,
      parts,
      nameCounts.get(nk) ?? 1,
      nameMonthCounts.get(mk) ?? 1,
    );
    // Dedup: skip if this event already has a budget. Backfill re-run: if that
    // existing budget has no label, name it after the event so the budgets
    // created before this fix get labeled (idempotent — a settled re-run finds
    // labels already set and relabels nothing).
    const existingBudget = existing.get(ev._id as string);
    if (existingBudget) {
      if (!existingBudget.label) {
        await ctx.db.patch(existingBudget._id, { label });
        relabeled++;
      }
      skipped++;
      continue;
    }

    // events.budget is ESTIMATED dollars; finance money is integer cents.
    const amountCents = ev.budget != null ? Math.round(ev.budget * 100) : 0;

    const budgetId = await ctx.db.insert("budgets", {
      chapterId: cid,
      amountCents,
      // Name the budget after its event (disambiguated) so the picker/tag-detail
      // shows the event name rather than falling back to the "One-time" type word.
      label,
      type: "one_time",
      refKind: "event",
      scopeRefId: ev._id,
      cadence: "per_instance",
      year: parts.year,
      month: parts.month,
      createdAt: Date.now(),
    });
    // Guard against a duplicate event id within the same run re-creating.
    existing.set(ev._id as string, (await ctx.db.get(budgetId))!);

    // Auto-tag: the eventType `template` tag + the catch-all "events" tag.
    const seen = new Set<string>();
    await autoTagEventBudget(ctx, budgetId, cid, ev._id as string, seen);
    tagsLinked += seen.size;
    created++;
  }

  return { created, skipped, relabeled, tagsLinked };
}

/**
 * CLI-runnable (no auth) event-budget backfill — an internalMutation is safe to
 * run without an auth gate, and runnable via `run-convex-function.yml`. Bounded
 * + idempotent (see {@link runBackfillEventBudgets}).
 *
 * Run locally:  npx convex run finances:backfillEventBudgets
 * Run on prod:  npx convex run --prod finances:backfillEventBudgets '{"chapterId":"..."}'
 */
export const backfillEventBudgets = internalMutation({
  args: { chapterId: v.optional(v.id("chapters")) },
  returns: eventBudgetBackfillResult,
  handler: async (ctx, args) =>
    await runBackfillEventBudgets(ctx, args.chapterId),
});

// ── Project budgets (WP-3.4 — mirrors the event budget backfill above) ──────
const projectBudgetBackfillResult = v.object({
  created: v.number(),
  skipped: v.number(),
  // How many already-existing project budgets had a null/empty label patched
  // to the project's name on this run (a subset of `skipped`; 0 on a settled
  // re-run).
  relabeled: v.number(),
  tagsLinked: v.number(),
});

/**
 * Backfill body: give every existing PROJECT a one_time budget so it appears
 * in the finance dashboard's "Events & Projects" section and charges can roll
 * up per project. Mirrors what `runBackfillEventBudgets` writes for an event
 * (`type:"one_time"`, `cadence:"per_instance"`), swapping `refKind:"project"`
 * + `scopeRefId:<projectId>` and reusing `autoTagProjectBudget` for the
 * catch-all "Projects" tag instead of the event's template + "events" tags.
 *
 * Bounded + idempotent, same shape as the event backfill:
 *  - Scans one chapter's projects (via `by_chapter`) or a bounded slice of all
 *    projects when `chapterId` is omitted.
 *  - SKIPS a project that already has an attached budget — v2
 *    (`type:"one_time"`) OR legacy (`scope:"project"`) — with a matching
 *    `scopeRefId`, so re-runs are no-ops.
 *  - Projects have no `isTraining` flag (that's event-only), so there's no
 *    training skip here.
 *  - Owner rule ("budgets only exist when money does"): SKIPS a project with
 *    no positive `budgetUsd` (unset, 0, or negative) — many projects are
 *    work-tracking only and a budget object with nothing in it is dashboard
 *    clutter, not a useful planning row. `amountCents` = the project's
 *    `budgetUsd` (dollars, Estimated) × 100 as an integer for the projects
 *    this creates a budget for — `projects.budgetUsd` itself is left untouched
 *    (Estimated-vs-Actual invariant; the budgets table is the planning object
 *    going forward, but the legacy field isn't deleted in this PR). `year`/
 *    `month` come from the project's `startDate` (falling back to `createdAt`
 *    when unset — a project has no required instance date the way an event's
 *    `eventDate` is required) in Eastern time.
 *  - A project's budget always lands at the project's OWN chapter — projects
 *    can't be central yet (WP-2.2 finding). If `transferProjectScope` later
 *    moves the project's money to central, it discovers this budget via the
 *    `by_ref` index (`refKind:"project"` + `scopeRefId`), independent of which
 *    chapter currently owns it — see that mutation's comment.
 */
async function runBackfillProjectBudgets(
  ctx: MutationCtx,
  chapterId?: Id<"chapters">,
): Promise<{ created: number; skipped: number; relabeled: number; tagsLinked: number }> {
  let created = 0;
  let skipped = 0;
  let relabeled = 0;
  let tagsLinked = 0;

  // Guard: a passed chapter must exist (ConvexError, not a silent no-op).
  if (chapterId) {
    const chapter = await ctx.db.get(chapterId);
    if (!chapter) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Chapter not found." });
    }
  }

  // Bounded project scan: one chapter via index, else a bounded full slice.
  const projects = chapterId
    ? await ctx.db
        .query("projects")
        .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
        .take(ROLLUP_SCAN_LIMIT)
    : await ctx.db.query("projects").take(ROLLUP_SCAN_LIMIT);

  // Disambiguation counts over the scanned projects, keyed by chapter so a
  // name is only "repeated" within its own chapter — mirrors the event
  // backfill's `nameCounts`/`nameMonthCounts`.
  const nameCounts = new Map<string, number>();
  const nameMonthCounts = new Map<string, number>();
  const NUL = " ";
  for (const p of projects) {
    if (p.budgetUsd == null || p.budgetUsd <= 0) continue; // owner rule: no money, no budget
    const parts = easternParts(p.startDate ?? p.createdAt);
    const nk = `${p.chapterId}${NUL}${p.name}`;
    const mk = `${nk}${NUL}${parts.year}-${parts.month}`;
    nameCounts.set(nk, (nameCounts.get(nk) ?? 0) + 1);
    nameMonthCounts.set(mk, (nameMonthCounts.get(mk) ?? 0) + 1);
  }

  // Per-chapter cache of the existing project budget keyed by `scopeRefId`,
  // so dedup costs one bounded read per chapter instead of one per project.
  const projectBudgetByRefByChapter = new Map<string, Map<string, Doc<"budgets">>>();
  const projectBudgetsByRef = async (
    cid: Id<"chapters">,
  ): Promise<Map<string, Doc<"budgets">>> => {
    const key = cid as string;
    const cached = projectBudgetByRefByChapter.get(key);
    if (cached) return cached;
    const map = new Map<string, Doc<"budgets">>();
    const rows = await ctx.db
      .query("budgets")
      .withIndex("by_chapter", (q) => q.eq("chapterId", cid))
      .take(ROLLUP_SCAN_LIMIT);
    for (const b of rows) {
      // Already attached to a project: v2 one_time OR legacy scope:"project".
      if ((b.type === "one_time" || b.scope === "project") && b.scopeRefId && !map.has(b.scopeRefId)) {
        map.set(b.scopeRefId, b);
      }
    }
    projectBudgetByRefByChapter.set(key, map);
    return map;
  };

  for (const p of projects) {
    // Owner rule: no positive budgetUsd → no budget object. Existing
    // zero-amount budgets from before this rule aren't touched here — see
    // `removeEmptyAutoBudgets` for that cleanup.
    if (p.budgetUsd == null || p.budgetUsd <= 0) {
      skipped++;
      continue;
    }
    const cid = p.chapterId;
    const existing = await projectBudgetsByRef(cid);
    const parts = easternParts(p.startDate ?? p.createdAt);
    const nk = `${cid}${NUL}${p.name}`;
    const mk = `${nk}${NUL}${parts.year}-${parts.month}`;
    const label = projectBudgetLabel(
      p.name,
      parts,
      nameCounts.get(nk) ?? 1,
      nameMonthCounts.get(mk) ?? 1,
    );

    // Dedup: skip if this project already has a budget. Backfill re-run: if
    // that existing budget has no label, name it after the project.
    const existingBudget = existing.get(p._id as string);
    if (existingBudget) {
      if (!existingBudget.label) {
        await ctx.db.patch(existingBudget._id, { label });
        relabeled++;
      }
      skipped++;
      continue;
    }

    // projects.budgetUsd is ESTIMATED dollars; finance money is integer cents.
    const amountCents = p.budgetUsd != null ? Math.round(p.budgetUsd * 100) : 0;

    const budgetId = await ctx.db.insert("budgets", {
      chapterId: cid,
      amountCents,
      label,
      type: "one_time",
      refKind: "project",
      scopeRefId: p._id,
      cadence: "per_instance",
      year: parts.year,
      month: parts.month,
      createdAt: Date.now(),
    });
    // Guard against a duplicate project id within the same run re-creating.
    existing.set(p._id as string, (await ctx.db.get(budgetId))!);

    const seen = new Set<string>();
    await autoTagProjectBudget(ctx, budgetId, cid, seen);
    tagsLinked += seen.size;
    created++;
  }

  return { created, skipped, relabeled, tagsLinked };
}

/**
 * CLI-runnable (no auth) project-budget backfill — mirrors
 * `backfillEventBudgets`. Bounded + idempotent (see
 * {@link runBackfillProjectBudgets}).
 *
 * Run locally:  npx convex run finances:backfillProjectBudgets
 * Run on prod:  npx convex run --prod finances:backfillProjectBudgets '{"chapterId":"..."}'
 */
export const backfillProjectBudgets = internalMutation({
  args: { chapterId: v.optional(v.id("chapters")) },
  returns: projectBudgetBackfillResult,
  handler: async (ctx, args) =>
    await runBackfillProjectBudgets(ctx, args.chapterId),
});

// ── Cleanup: empty auto-created budgets (owner rule retrofit) ────────────────
const removeEmptyAutoBudgetsResult = v.object({
  scanned: v.number(),
  deleted: v.number(),
  // Kept because a nonzero txn is already linked to it (real spend).
  keptWithSpend: v.number(),
  // Kept because `amountCents` isn't 0 (a real, filled-in budget).
  keptNonzero: v.number(),
  // Kept because there's already line-item planning content on it: EITHER the
  // event still carries legacy `budgetLineItems` rows (event refKind only —
  // that pre-v2 feature has no direct link to a `budgets` row), OR the budget
  // itself has WP-3.1 `budgetLines` rows (event OR project refKind — a v2
  // plan breakdown). Either way, someone's already using budgeting on it, so
  // its budget object — and, for `budgetLines`, the planning work IN it —
  // shouldn't quietly disappear.
  keptWithLineItems: v.number(),
});

/**
 * Ops cleanup (workflow-callable, no-auth internalMutation): delete
 * auto-created one_time budgets (`refKind` "event" OR "project") that are
 * EMPTY — before the owner rule ("budgets only exist when money does")
 * landed, `backfillEventBudgets` (#125) and `backfillProjectBudgets`/
 * `projects.create`'s create-time hook (this PR, pre-fix) both created a
 * zero-amount budget for every budget-less event/project, which is dashboard
 * clutter the owner flagged. This retroactively removes those.
 *
 * A budget is deleted ONLY when ALL of:
 *  - `type === "one_time"` and `refKind` is `"event"` or `"project"` (never
 *    touches a recurring or legacy-scope budget).
 *  - `amountCents === 0` — NEVER deletes a budget with a nonzero amount, even
 *    if it's otherwise unused.
 *  - Zero linked transactions (`transactions.by_budget`) — NEVER deletes a
 *    budget with linked spend; its actuals still need somewhere to roll up.
 *  - For an EVENT ref only: the event has no legacy `budgetLineItems` rows
 *    (`by_event`) — that pre-v2 feature has no direct link to a `budgets` row,
 *    so this is a conservative "someone's already using budgeting on this
 *    event" signal that blocks the delete.
 *  - For EITHER ref kind: the budget has no WP-3.1 `budgetLines` rows
 *    (`by_budget`) — a $0 budget can still carry a real v2 plan breakdown (the
 *    amount just hasn't been filled in yet), so deleting it would silently
 *    destroy someone's planning work.
 *
 * Deletes via the shared {@link cascadeDeleteBudget} helper (also used by
 * `deleteBudget`) so its `budgetTagLinks` AND any `budgetLines` rows are
 * removed too — no orphan survives the budget. Bounded + idempotent — a
 * settled re-run deletes nothing.
 *
 * Run locally:  npx convex run finances:removeEmptyAutoBudgets
 * Run on prod:  npx convex run --prod finances:removeEmptyAutoBudgets '{"chapterId":"..."}'
 */
export const removeEmptyAutoBudgets = internalMutation({
  args: { chapterId: v.optional(v.id("chapters")) },
  returns: removeEmptyAutoBudgetsResult,
  handler: async (ctx, args) => {
    let scanned = 0;
    let deleted = 0;
    let keptWithSpend = 0;
    let keptNonzero = 0;
    let keptWithLineItems = 0;

    // Guard: a passed chapter must exist (ConvexError, not a silent no-op).
    if (args.chapterId) {
      const chapter = await ctx.db.get(args.chapterId);
      if (!chapter) {
        throw new ConvexError({ code: "NOT_FOUND", message: "Chapter not found." });
      }
    }

    const budgets = args.chapterId
      ? await ctx.db
          .query("budgets")
          .withIndex("by_chapter", (q) => q.eq("chapterId", args.chapterId!))
          .take(ROLLUP_SCAN_LIMIT)
      : await ctx.db.query("budgets").take(ROLLUP_SCAN_LIMIT);

    for (const b of budgets) {
      if (b.type !== "one_time" || !b.scopeRefId) continue;
      if (b.refKind !== "event" && b.refKind !== "project") continue;
      scanned++;

      if (b.amountCents !== 0) {
        keptNonzero++;
        continue;
      }

      const linkedTxn = await ctx.db
        .query("transactions")
        .withIndex("by_budget", (q) => q.eq("budgetId", b._id))
        .first();
      if (linkedTxn) {
        keptWithSpend++;
        continue;
      }

      if (b.refKind === "event") {
        const lineItem = await ctx.db
          .query("budgetLineItems")
          .withIndex("by_event", (q) => q.eq("eventId", b.scopeRefId as Id<"events">))
          .first();
        if (lineItem) {
          keptWithLineItems++;
          continue;
        }
      }

      // v2 plan guard — covers BOTH event and project refKinds: a $0 budget
      // that already has `budgetLines` planning is real work, not clutter.
      const planLine = await ctx.db
        .query("budgetLines")
        .withIndex("by_budget", (q) => q.eq("budgetId", b._id))
        .first();
      if (planLine) {
        keptWithLineItems++;
        continue;
      }

      await cascadeDeleteBudget(ctx, b._id);
      deleted++;
    }

    console.log(
      `[finances] removeEmptyAutoBudgets: scanned ${scanned}, deleted ${deleted}, ` +
        `kept ${keptWithSpend} (linked spend), ${keptNonzero} (nonzero), ` +
        `${keptWithLineItems} (event has budget line items).`,
    );

    return { scanned, deleted, keptWithSpend, keptNonzero, keptWithLineItems };
  },
});

// ── Links → budgets migration (WP-U phase A: one home per dollar) ───────────
// Default page size for the migration's own `.paginate()` call (independent
// of `ROLLUP_SCAN_LIMIT`, which bounds ONE-SHOT reads elsewhere in this file —
// a migration needs to PROVE completeness across the whole table, not just
// read a bounded slice and log a "may be truncated" warning). Small enough
// that `ensureBudgetForRef`'s per-row lookups (and occasional budget insert)
// stay comfortably under a mutation's execution budget even on the slowest
// page.
const MIGRATION_PAGE_SIZE = 500;

// One flagged conflict: `budgetId` was already set to something OTHER than
// the ref's budget when the migration examined this row — a human explicitly
// re-coded it since the FK was written, so the migration keeps their choice
// and reports it here instead of silently reconciling. Structured (not a bare
// id) so a reviewer can act on the CLI/log output alone, without a follow-up
// query per conflict.
const migrateLinksToBudgetsConflict = v.object({
  transactionId: v.id("transactions"),
  merchantName: v.union(v.string(), v.null()),
  postedAt: v.number(),
  amountCents: v.number(),
  refKind: refKindValidator,
  refId: v.string(),
  // The event/project's own name (e.g. "Fall Retreat Worship"), so a reviewer
  // doesn't have to look the ref up separately.
  refName: v.string(),
  // The budget the FK points at — what this txn WOULD have been attributed
  // to had the migration not deferred to the human's later re-code.
  refBudgetId: v.id("budgets"),
  refBudgetLabel: v.string(),
  // The budget the txn is CURRENTLY (and remains) attributed to.
  currentBudgetId: v.id("budgets"),
  currentBudgetLabel: v.string(),
  // Sentence-level implication, ready to paste into a review thread.
  message: v.string(),
});

const migrateLinksToBudgetsResult = v.object({
  // Transactions examined THIS PAGE that carry a legacy `eventId`/`projectId`
  // (i.e. excludes rows with neither FK, which the page may also contain).
  scanned: v.number(),
  // `budgetId` was absent → resolved/summoned the ref's budget and set it.
  backfilled: v.number(),
  // `budgetId` was already exactly the ref's budget — a settled re-run no-op.
  alreadySet: v.number(),
  // Count of `conflicts` below, kept alongside it for a one-line CLI summary
  // without having to count the array.
  conflictCount: v.number(),
  conflicts: v.array(migrateLinksToBudgetsConflict),
  // How many NEW $0 "plan" budgets this run had to summon along the way.
  budgetsSummoned: v.number(),
  // Carried a legacy FK pointing at a ref that's central-owned, deleted, or
  // otherwise unresolvable — skipped rather than guessed at.
  skipped: v.number(),
  // Convex's own pagination cursor state — `isDone: false` means there is
  // MORE of the table left; re-invoke with `{ paginationOpts: { numItems,
  // cursor: continueCursor } }` (same `chapterId`, if any) until `isDone` is
  // `true`. This is the operator's proof of completeness — see
  // `docs/plans/link-migration-runbook.md`.
  isDone: v.boolean(),
  continueCursor: v.string(),
});

/** One flagged conflict row — see {@link migrateLinksToBudgetsConflict}'s doc
 *  comment for what each field means and why. */
type MigrationConflict = {
  transactionId: Id<"transactions">;
  merchantName: string | null;
  postedAt: number;
  amountCents: number;
  refKind: BudgetRefKind;
  refId: string;
  refName: string;
  refBudgetId: Id<"budgets">;
  refBudgetLabel: string;
  currentBudgetId: Id<"budgets">;
  currentBudgetLabel: string;
  message: string;
};

/** The event/project's own display name for a conflict row — falls back to a
 *  placeholder for the rare case the ref itself was deleted after the FK was
 *  written (the migration still resolves+reports the conflict; it just can't
 *  name the ref). */
async function refDisplayName(
  ctx: MutationCtx,
  refKind: BudgetRefKind,
  scopeRefId: string,
): Promise<string> {
  if (refKind === "event") {
    const ev = await ctx.db.get(scopeRefId as Id<"events">);
    return ev && "name" in ev ? (ev as Doc<"events">).name : "(deleted event)";
  }
  const project = await ctx.db.get(scopeRefId as Id<"projects">);
  return project && "name" in project ? (project as Doc<"projects">).name : "(deleted project)";
}

/**
 * Migration body (WP-U phase A): backfill `transactions.budgetId` from the
 * vestigial `eventId`/`projectId` FKs — "one home per dollar" only holds once
 * every pre-existing transaction has its budget set, not just new ones. Reuses
 * `ensureBudgetForRef` (the SAME get-or-create the "For" picker's summon-on-
 * pick calls), so a migrated row's budget is indistinguishable from one a
 * human picked. Idempotent + PAGINATED (native `.paginate()`, one chapter via
 * `by_chapter` or the whole table) — unlike the other backfills in this file,
 * a migration can't settle for a bounded `.take()` that silently truncates;
 * the caller re-invokes with `continueCursor` until `isDone` to prove every
 * row was examined (see `docs/plans/link-migration-runbook.md`).
 * CLEARS NOTHING — the FKs stay put for the phase-B column drop; this phase
 * only ever ADDS a `budgetId` a transaction didn't already have.
 */
async function runMigrateLinksToBudgets(
  ctx: MutationCtx,
  chapterId: Id<"chapters"> | undefined,
  paginationOpts: { cursor: string | null; numItems: number },
): Promise<{
  scanned: number;
  backfilled: number;
  alreadySet: number;
  conflictCount: number;
  conflicts: MigrationConflict[];
  budgetsSummoned: number;
  skipped: number;
  isDone: boolean;
  continueCursor: string;
}> {
  if (chapterId) {
    const chapter = await ctx.db.get(chapterId);
    if (!chapter) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Chapter not found." });
    }
  }

  const page = await (chapterId
    ? ctx.db.query("transactions").withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
    : ctx.db.query("transactions")
  ).paginate(paginationOpts);

  let scanned = 0;
  let backfilled = 0;
  let alreadySet = 0;
  const conflicts: MigrationConflict[] = [];
  let budgetsSummoned = 0;
  let skipped = 0;

  for (const tr of page.page) {
    if (!tr.eventId && !tr.projectId) continue;
    scanned++;
    // A central-owned txn never carries these FKs in practice
    // (`createManualTransaction`/`categorizeTransaction` always rejected the
    // combination) — skip defensively rather than assume.
    if (tr.chapterId === CENTRAL) {
      skipped++;
      continue;
    }
    const refKind: BudgetRefKind = tr.projectId ? "project" : "event";
    const scopeRefId = String(tr.projectId ?? tr.eventId);

    const before = await ctx.db
      .query("budgets")
      .withIndex("by_ref", (q) => q.eq("refKind", refKind).eq("scopeRefId", scopeRefId))
      .first();
    let refBudgetId: Id<"budgets">;
    try {
      refBudgetId = await ensureBudgetForRef(
        ctx,
        tr.chapterId,
        refKind,
        scopeRefId,
        undefined,
      );
    } catch {
      // The ref no longer exists / doesn't belong to the txn's chapter — the
      // FK is stale beyond repair. Skip rather than guess.
      skipped++;
      continue;
    }
    if (!before) budgetsSummoned++;

    if (tr.budgetId == null) {
      await ctx.db.patch(tr._id, { budgetId: refBudgetId });
      backfilled++;
    } else if (tr.budgetId === refBudgetId) {
      alreadySet++;
    } else {
      // A human already explicitly attributed this txn to a DIFFERENT budget
      // since the FK was written — keep their explicit choice, never clobber.
      // Report everything a reviewer needs to judge the conflict without a
      // follow-up query.
      const [refBudget, currentBudget, refName] = await Promise.all([
        ctx.db.get(refBudgetId),
        ctx.db.get(tr.budgetId),
        refDisplayName(ctx, refKind, scopeRefId),
      ]);
      const refBudgetLabel = refBudget ? budgetDisplayName(refBudget) : "(deleted budget)";
      const currentBudgetLabel = currentBudget
        ? budgetDisplayName(currentBudget)
        : "(deleted budget)";
      const dollars = (tr.amountCents / 100).toFixed(2);
      const merchant = tr.merchantName ? ` at ${tr.merchantName}` : "";
      const conflict = {
        transactionId: tr._id,
        merchantName: tr.merchantName ?? null,
        postedAt: tr.postedAt,
        amountCents: tr.amountCents,
        refKind,
        refId: scopeRefId,
        refName,
        refBudgetId,
        refBudgetLabel,
        currentBudgetId: tr.budgetId,
        currentBudgetLabel,
        message:
          `$${dollars}${merchant} (${new Date(tr.postedAt).toISOString().slice(0, 10)}) will ` +
          `no longer appear in ${refName}'s actuals — it's already attributed to ` +
          `"${currentBudgetLabel}" instead of "${refBudgetLabel}".`,
      };
      conflicts.push(conflict);
      console.log(`[finances] migrateLinksToBudgets conflict: ${JSON.stringify(conflict)}`);
    }
  }

  console.log(
    `[finances] migrateLinksToBudgets: scanned ${scanned}, backfilled ${backfilled}, ` +
      `already set ${alreadySet}, conflicts ${conflicts.length} (kept, not overwritten), ` +
      `budgets summoned ${budgetsSummoned}, skipped ${skipped}, isDone ${page.isDone}.`,
  );

  return {
    scanned,
    backfilled,
    alreadySet,
    conflictCount: conflicts.length,
    conflicts,
    budgetsSummoned,
    skipped,
    isDone: page.isDone,
    continueCursor: page.continueCursor,
  };
}

/**
 * CLI-runnable (no auth) migration — mirrors `backfillEventBudgets`. Paginated
 * + idempotent (see {@link runMigrateLinksToBudgets}); re-invoke with the
 * returned `continueCursor` until `isDone` to cover the whole table. See
 * `docs/plans/link-migration-runbook.md` for the full deploy + verify + review
 * procedure — do NOT run this ad hoc against production.
 *
 * Run locally:  npx convex run finances:migrateLinksToBudgets
 * Run on prod (first page):     npx convex run --prod finances:migrateLinksToBudgets '{}'
 * Run on prod (next page):      npx convex run --prod finances:migrateLinksToBudgets '{"paginationOpts":{"numItems":500,"cursor":"<continueCursor>"}}'
 * Run on prod (one chapter):    npx convex run --prod finances:migrateLinksToBudgets '{"chapterId":"..."}'
 */
export const migrateLinksToBudgets = internalMutation({
  args: {
    chapterId: v.optional(v.id("chapters")),
    paginationOpts: v.optional(paginationOptsValidator),
  },
  returns: migrateLinksToBudgetsResult,
  handler: async (ctx, args) =>
    await runMigrateLinksToBudgets(
      ctx,
      args.chapterId,
      args.paginationOpts ?? { cursor: null, numItems: MIGRATION_PAGE_SIZE },
    ),
});

// ── Fund merge (WP-1.4 "defund the UI" — one General Fund, zero fund UI) ────
const fundMergeResult = v.object({
  chaptersScanned: v.number(),
  // Chapters that actually had >1 fund and got merged this run (0 on a
  // settled re-run — the whole migration is a no-op once every chapter is
  // down to its General Fund).
  chaptersMerged: v.number(),
  fundsDeleted: v.number(),
  categoriesRepointed: v.number(),
  budgetsRepointed: v.number(),
  transactionsRepointed: v.number(),
  reimbursementLineItemsRepointed: v.number(),
  legacyAccountsRepointed: v.number(),
});

/**
 * Merge every extra fund in ONE chapter into its General Fund (resolved via
 * {@link findGeneralFundId} — by name, else lowest-sortOrder unrestricted,
 * else lowest-sortOrder). Repoints every `fundId`/`defaultFundId` reference
 * (`budgetCategories` — required field, so a dangling extra-fund reference
 * would otherwise break category display; `budgets`; `transactions`;
 * `reimbursementLineItems`; `legacyAccounts.defaultFundId`), then deletes the
 * now-empty extra fund docs.
 *
 * Also fixes a stale `transactions.aiSuggestion.fundId` pointing at the extra
 * fund, via TWO passes: the `by_fund`-indexed transactions scan above repoints
 * a suggestion in the same patch as a coded txn's top-level `fundId`; a
 * second, cached chapter-wide scan (reusing the same pattern as `budgets`/
 * `reimbursementLineItems`) catches an UNCODED txn — top-level `fundId` unset
 * — whose stored suggestion still points at the extra fund, which the
 * `by_fund` index alone would miss. Left uncaught, that dangling suggestion
 * id would survive the fund's deletion below and could later be copied onto
 * the transaction by `acceptSuggestion`.
 *
 * A chapter with 0 or 1 funds is a no-op (nothing to merge) — this is what
 * makes a re-run of the whole migration idempotent.
 */
async function runMergeFundsIntoGeneralForChapter(
  ctx: MutationCtx,
  chapterId: Id<"chapters">,
): Promise<{
  merged: boolean;
  fundsDeleted: number;
  categoriesRepointed: number;
  budgetsRepointed: number;
  transactionsRepointed: number;
  reimbursementLineItemsRepointed: number;
  legacyAccountsRepointed: number;
}> {
  const zero = {
    merged: false,
    fundsDeleted: 0,
    categoriesRepointed: 0,
    budgetsRepointed: 0,
    transactionsRepointed: 0,
    reimbursementLineItemsRepointed: 0,
    legacyAccountsRepointed: 0,
  };
  const keeperId = await findGeneralFundId(ctx, chapterId);
  if (!keeperId) return zero; // fund-less chapter — nothing to merge

  const funds = await ctx.db
    .query("funds")
    .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
    .take(ROLLUP_SCAN_LIMIT);
  const extras = funds.filter((f) => f._id !== keeperId);
  if (extras.length === 0) return zero; // already down to one fund

  let categoriesRepointed = 0;
  let budgetsRepointed = 0;
  let transactionsRepointed = 0;
  let reimbursementLineItemsRepointed = 0;
  let legacyAccountsRepointed = 0;

  // Cache the chapter-wide scans that lack a `by_fund` index — one bounded
  // read per table, reused across every extra fund instead of per-fund.
  const chapterBudgets = await ctx.db
    .query("budgets")
    .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
    .take(ROLLUP_SCAN_LIMIT);
  const chapterLines = await ctx.db
    .query("reimbursementLineItems")
    .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
    .take(ROLLUP_SCAN_LIMIT);
  const chapterAccounts = await ctx.db
    .query("legacyAccounts")
    .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
    .take(ROLLUP_SCAN_LIMIT);
  // Chapter-wide, so it also catches a dangling `aiSuggestion.fundId` on an
  // uncoded txn (top-level `fundId` unset) — see the docstring above.
  const chapterTransactions = await ctx.db
    .query("transactions")
    .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
    .take(ROLLUP_SCAN_LIMIT);

  for (const extra of extras) {
    // budgetCategories.fundId is REQUIRED — a dangling reference here would
    // break category display/grouping the instant the fund doc is deleted.
    const categories = await ctx.db
      .query("budgetCategories")
      .withIndex("by_fund", (q) => q.eq("fundId", extra._id))
      .take(ROLLUP_SCAN_LIMIT);
    for (const c of categories) {
      await ctx.db.patch(c._id, { fundId: keeperId });
      categoriesRepointed++;
    }

    for (const b of chapterBudgets) {
      if (b.fundId === extra._id) {
        await ctx.db.patch(b._id, { fundId: keeperId });
        budgetsRepointed++;
      }
    }

    const transactions = await ctx.db
      .query("transactions")
      .withIndex("by_fund", (q) => q.eq("fundId", extra._id))
      .take(ROLLUP_SCAN_LIMIT);
    for (const tr of transactions) {
      await ctx.db.patch(tr._id, {
        fundId: keeperId,
        // Fix a stale AI suggestion on the SAME row while we're already here.
        ...(tr.aiSuggestion?.fundId === extra._id
          ? { aiSuggestion: { ...tr.aiSuggestion, fundId: keeperId } }
          : {}),
      });
      transactionsRepointed++;
    }

    // The `by_fund` scan above only finds txns whose TOP-LEVEL fundId is the
    // extra fund. An uncoded txn (no top-level fundId) whose stored AI
    // suggestion picked the extra fund would otherwise escape — repoint its
    // suggestion too, from the cached chapter-wide scan. Skip rows already
    // handled above (top-level fundId === extra) to avoid a double count.
    for (const tr of chapterTransactions) {
      if (tr.fundId === extra._id) continue;
      if (tr.aiSuggestion?.fundId === extra._id) {
        await ctx.db.patch(tr._id, {
          aiSuggestion: { ...tr.aiSuggestion, fundId: keeperId },
        });
        transactionsRepointed++;
      }
    }

    for (const l of chapterLines) {
      if (l.fundId === extra._id) {
        await ctx.db.patch(l._id, { fundId: keeperId });
        reimbursementLineItemsRepointed++;
      }
    }

    for (const a of chapterAccounts) {
      if (a.defaultFundId === extra._id) {
        await ctx.db.patch(a._id, { defaultFundId: keeperId });
        legacyAccountsRepointed++;
      }
    }

    await ctx.db.delete(extra._id);
  }

  return {
    merged: true,
    fundsDeleted: extras.length,
    categoriesRepointed,
    budgetsRepointed,
    transactionsRepointed,
    reimbursementLineItemsRepointed,
    legacyAccountsRepointed,
  };
}

/**
 * CLI-runnable (no auth) fund-merge migration for WP-1.4 ("defund the UI"):
 * every chapter with more than one fund gets its extras merged into its
 * General Fund (see {@link runMergeFundsIntoGeneralForChapter}). Bounded +
 * idempotent — a settled re-run finds every chapter already at one fund and
 * reports `chaptersMerged: 0`. Pass `chapterId` to merge just one chapter;
 * omit to sweep every chapter.
 *
 * Run locally:  npx convex run finances:runMergeFundsIntoGeneral
 * Run on prod:  npx convex run --prod finances:runMergeFundsIntoGeneral
 */
export const runMergeFundsIntoGeneral = internalMutation({
  args: { chapterId: v.optional(v.id("chapters")) },
  returns: fundMergeResult,
  handler: async (ctx, args) => {
    const chapters = args.chapterId
      ? [await ctx.db.get(args.chapterId)].filter(
          (c): c is Doc<"chapters"> => c !== null,
        )
      : await ctx.db.query("chapters").take(ROLLUP_SCAN_LIMIT);

    let chaptersMerged = 0;
    let fundsDeleted = 0;
    let categoriesRepointed = 0;
    let budgetsRepointed = 0;
    let transactionsRepointed = 0;
    let reimbursementLineItemsRepointed = 0;
    let legacyAccountsRepointed = 0;

    for (const chapter of chapters) {
      const result = await runMergeFundsIntoGeneralForChapter(ctx, chapter._id);
      if (result.merged) {
        chaptersMerged++;
        fundsDeleted += result.fundsDeleted;
        categoriesRepointed += result.categoriesRepointed;
        budgetsRepointed += result.budgetsRepointed;
        transactionsRepointed += result.transactionsRepointed;
        reimbursementLineItemsRepointed += result.reimbursementLineItemsRepointed;
        legacyAccountsRepointed += result.legacyAccountsRepointed;
        console.log(
          `[runMergeFundsIntoGeneral] chapter ${chapter._id}: deleted ${result.fundsDeleted} fund(s); ` +
            `repointed ${result.categoriesRepointed} categories, ${result.budgetsRepointed} budgets, ` +
            `${result.transactionsRepointed} transactions, ${result.reimbursementLineItemsRepointed} reimbursement lines, ` +
            `${result.legacyAccountsRepointed} legacy accounts.`,
        );
      }
    }

    const summary = {
      chaptersScanned: chapters.length,
      chaptersMerged,
      fundsDeleted,
      categoriesRepointed,
      budgetsRepointed,
      transactionsRepointed,
      reimbursementLineItemsRepointed,
      legacyAccountsRepointed,
    };
    console.log(`[runMergeFundsIntoGeneral] done: ${JSON.stringify(summary)}`);
    return summary;
  },
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
  args: {
    filter: v.optional(reconcileFilterValidator),
    // WP-2.1: `scope:"central"` reconciles CENTRAL-owned txns instead of the
    // caller's chapter — the central desk's Reconcile. Requires central reach
    // (mirrors `dashboardChapter`'s optional-chapterId central drill-down).
    // Absent → the caller's own chapter, exactly as before.
    scope: v.optional(v.literal("central")),
  },
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
    const homeChapterId = await readChapterId(ctx);
    if (!homeChapterId) return { rows: [], counts: zero };
    // Resolve the reconcile scope: central (org-wide reach) or the caller's
    // own chapter (viewer). Central-owned txns key on the `"central"` sentinel.
    let scope: FinanceScope;
    if (args.scope === "central") {
      await requireFinanceCentral(ctx, homeChapterId);
      scope = CENTRAL;
    } else {
      await requireFinanceRole(ctx, homeChapterId, "viewer");
      scope = homeChapterId;
    }

    const sandboxMode = await readSandbox(ctx);
    const all = (
      await ctx.db
        .query("transactions")
        .withIndex("by_chapter_and_postedAt", (q) => q.eq("chapterId", scope))
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
    // Same read-through caching for the AI suggestion's resolved display names.
    const getFund = nameCache(ctx, "funds");
    const getCategory = nameCache(ctx, "budgetCategories");
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

    // The AI suggestion, resolved to display names — only for a still-unreviewed
    // row whose proposal actually carries at least one link (a confidence/
    // rationale-only proposal has nothing actionable to show or Accept).
    // WP-U: the model proposes a BUDGET directly (one home per dollar) —
    // `ai.projectId`/`ai.eventId` are dead schema-only fields nothing writes
    // anymore (see `aiCodingData.writeSuggestion`).
    const getBudget = nameCache(ctx, "budgets");
    const resolveAiSuggestion = async (tr: Doc<"transactions">) => {
      const ai = tr.aiSuggestion;
      if (tr.status !== "unreviewed" || !ai) return null;
      if (!ai.fundId && !ai.categoryId && !ai.budgetId) return null;
      const [fund, category, budget] = await Promise.all([
        ai.fundId ? getFund(ai.fundId) : null,
        ai.categoryId ? getCategory(ai.categoryId) : null,
        ai.budgetId ? getBudget(ai.budgetId) : null,
      ]);
      return {
        fundId: ai.fundId ?? null,
        categoryId: ai.categoryId ?? null,
        budgetId: ai.budgetId ?? null,
        fundName: fund?.name ?? null,
        categoryName: category?.name ?? null,
        budgetName: budget ? budgetDisplayName(budget) : null,
        confidence: ai.confidence ?? null,
        rationale: ai.rationale ?? null,
      };
    };

    const rows: (typeof reconcileRow.type)[] = [];
    for (const tr of selected) {
      rows.push({
        ...toTxnSummary(tr),
        cardholder: await resolveCardholder(tr),
        aiSuggestion: await resolveAiSuggestion(tr),
      });
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
async function requireReconcileTxn(
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
    // WP-U: one home per dollar — a manual entry attributes to a BUDGET
    // directly (the "For" picker), never a separate event/project link.
    budgetId: v.optional(v.id("budgets")),
    teamId: v.optional(v.id("financeTeams")),
    personId: v.optional(v.id("people")),
    // WP-2.1: create a CENTRAL-owned txn (`chapterId:"central"`) instead of a
    // chapter one — requires central reach. Mirrors `createBudget`'s `central`
    // flag. Central txns carry no chapter-scoped links (funds/categories/
    // teams/person are chapter-only; a central budget IS allowed), so those
    // args are rejected but `budgetId` isn't.
    central: v.optional(v.boolean()),
  },
  returns: v.id("transactions"),
  handler: async (ctx, args) => {
    const homeChapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    assertIntegerCents(args.amountCents);
    const userId = (await requireUserId(ctx)) as Id<"users">;
    if (args.central) {
      // Central desk: org-wide reach, and NONE of the chapter-scoped links
      // apply (central has no funds/categories/teams; a person is a chapter
      // roster row). Reject them loudly rather than silently drop.
      await requireFinanceCentral(ctx, homeChapterId);
      if (args.fundId || args.categoryId || args.teamId || args.personId) {
        throw new ConvexError({
          code: "UNSUPPORTED",
          message:
            "A central transaction can't carry chapter-scoped links (fund/category/team/person).",
        });
      }
      if (args.budgetId) {
        // A central txn may only attribute to a CENTRAL budget.
        await requireInCallerChapter(ctx, CENTRAL, "budgets", args.budgetId, "Budget");
      }
      return await ctx.db.insert("transactions", {
        chapterId: CENTRAL,
        source: args.source ?? "manual",
        flow: args.flow,
        amountCents: args.amountCents,
        currency: "usd",
        postedAt: args.postedAt,
        description: args.description,
        merchantName: args.merchantName,
        budgetId: args.budgetId,
        // Central has no funds (WP-1.4/2.1) — stays fund-less. Coded on entry
        // when a budget was explicitly given, else unreviewed.
        status: args.budgetId ? "categorized" : "unreviewed",
        createdBy: userId,
        createdAt: Date.now(),
      });
    }
    const chapterId = homeChapterId;
    await requireFinanceRole(ctx, chapterId, "bookkeeper");
    await verifyTxnRefs(ctx, chapterId, args);
    if (args.budgetId) {
      // A chapter txn may point at its OWN chapter budget or a central one.
      await requireInCallerChapter(ctx, chapterId, "budgets", args.budgetId, "Budget", {
        allowCentral: true,
      });
    }
    // Categorized on entry when a fund/category/budget was EXPLICITLY
    // supplied, else unreviewed — computed before the silent fund default
    // below so the fund auto-fill (no UI ever sends one) never fakes a real
    // categorization.
    const status =
      args.fundId || args.categoryId || args.budgetId ? "categorized" : "unreviewed";
    // Silently default to the chapter's General Fund when the client omits a
    // fund (every UI now does — funds are backend-only, see WP-1.4).
    const fundId = args.fundId ?? (await defaultFundId(ctx, chapterId)) ?? undefined;
    return await ctx.db.insert("transactions", {
      chapterId,
      source: args.source ?? "manual",
      flow: args.flow,
      amountCents: args.amountCents,
      currency: "usd",
      postedAt: args.postedAt,
      description: args.description,
      merchantName: args.merchantName,
      fundId,
      categoryId: args.categoryId,
      budgetId: args.budgetId,
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
    teamId: v.optional(v.union(v.id("financeTeams"), v.null())),
    // Explicit budget attribution — the "For" picker's ONLY link (WP-U: one
    // home per dollar; the old separate eventId/projectId args are gone —
    // `budgetId` subsumes them both). A chapter txn may point at its OWN
    // chapter budget or a central budget (never another chapter's). `null`
    // clears it.
    budgetId: v.optional(v.union(v.id("budgets"), v.null())),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    // Scope-aware (WP-2.1): a central-owned txn is authorized at central reach,
    // a chapter txn at the caller's bookkeeper role in its chapter.
    const { txn, scope } = await requireReconcileTxn(ctx, args.transactionId, "bookkeeper");
    if (scope === CENTRAL) {
      // Central txns carry no chapter-scoped links — only a central budget.
      if (args.fundId || args.categoryId || args.teamId) {
        throw new ConvexError({
          code: "UNSUPPORTED",
          message:
            "A central transaction can only be attributed to a central budget, not chapter-scoped links.",
        });
      }
    } else {
      await verifyTxnRefs(ctx, scope, {
        fundId: args.fundId ?? undefined,
        categoryId: args.categoryId ?? undefined,
        teamId: args.teamId ?? undefined,
      });
    }
    if (args.budgetId) {
      // Verify against the txn's OWN scope: a central budget for a central txn;
      // the chapter's own or a central budget for a chapter txn (allowCentral).
      await requireInCallerChapter(ctx, scope, "budgets", args.budgetId, "Budget", {
        allowCentral: true,
      });
    }
    const patch = cleanPatch({
      fundId: args.fundId,
      categoryId: args.categoryId,
      teamId: args.teamId,
      budgetId: args.budgetId,
    });
    // Default the fund to the chapter's General Fund when the client omits it and
    // the txn isn't already coded to one. The reconcile grid hides the fund
    // selector (coding = category + budget only), so this keeps every coded txn
    // attached to a real fund without the UI having to pass it. Central txns have
    // no fund (WP-2.1) — skip the default for them.
    if (scope !== CENTRAL && args.fundId === undefined && txn.fundId == null) {
      const def = await defaultFundId(ctx, scope);
      if (def) patch.fundId = def;
    }
    // Advance an unreviewed transaction to categorized once coded. For a chapter
    // txn "coded" = fund/category; a central txn is coded by its central budget
    // link (its only attribution).
    const nowCoded =
      (patch.fundId ?? txn.fundId) ||
      (patch.categoryId ?? txn.categoryId) ||
      (scope === CENTRAL && args.budgetId != null);
    if (nowCoded && txn.status === "unreviewed") patch.status = "categorized";
    // A human just categorized this manually — clear any stored AI suggestion
    // so it can never later resurface via `acceptSuggestion` and clobber this.
    patch.aiSuggestion = undefined;
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
    // Per-row scope resolution (WP-2.1): a bulk selection is normally all one
    // scope, but resolving each row's scope keeps mixed selections correct — a
    // central row authorizes at central reach, a chapter row at bookkeeper.
    // Fund defaults are memoized per scope (central → none).
    const fundDefaultByScope = new Map<FinanceScope, Id<"funds"> | null>();
    const resolveFundDefault = async (scope: FinanceScope) => {
      if (fundDefaultByScope.has(scope)) return fundDefaultByScope.get(scope)!;
      const def = await defaultFundId(ctx, scope);
      fundDefaultByScope.set(scope, def);
      return def;
    };
    let updated = 0;
    for (const id of args.transactionIds) {
      const { txn, scope } = await requireReconcileTxn(ctx, id, "bookkeeper");
      if (scope === CENTRAL && (args.fundId || args.categoryId)) {
        throw new ConvexError({
          code: "UNSUPPORTED",
          message:
            "A central transaction can't take a chapter fund/category — only a central budget.",
        });
      } else if (scope !== CENTRAL) {
        await verifyTxnRefs(ctx, scope, {
          fundId: args.fundId ?? undefined,
          categoryId: args.categoryId ?? undefined,
        });
      }
      if (args.budgetId) {
        // Verify against the row's OWN scope (a central budget for a central
        // row; the chapter's own or a central budget for a chapter row).
        await requireInCallerChapter(ctx, scope, "budgets", args.budgetId, "Budget", {
          allowCentral: true,
        });
      }
      const patch = cleanPatch({
        fundId: args.fundId,
        categoryId: args.categoryId,
        budgetId: args.budgetId,
      });
      if (scope !== CENTRAL && args.fundId === undefined && txn.fundId == null) {
        const fallbackFundId = await resolveFundDefault(scope);
        if (fallbackFundId) patch.fundId = fallbackFundId;
      }
      const nowCoded =
        (patch.fundId ?? txn.fundId) ||
        (patch.categoryId ?? txn.categoryId) ||
        (scope === CENTRAL && args.budgetId != null);
      if (nowCoded && txn.status === "unreviewed") patch.status = "categorized";
      // A human just categorized this manually — clear any stored AI suggestion
      // so it can never later resurface via `acceptSuggestion` and clobber this.
      patch.aiSuggestion = undefined;
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
    // Scope-aware (WP-2.1): central-owned txns are reconcilable at central reach.
    await requireReconcileTxn(ctx, args.transactionId, "bookkeeper");
    // A human just acted on this transaction's status manually — clear any
    // stored AI suggestion so it can never later resurface via
    // `acceptSuggestion` and clobber whatever state this call put it in.
    await ctx.db.patch(args.transactionId, {
      status: args.status,
      aiSuggestion: undefined,
      // A manager just resolved this txn — the receipt-reminder timeline is
      // moot from here on, so clear it too (mirrors `attachReceipt`'s clear).
      // Otherwise the "Day 3 overdue" badge keeps rendering forever on a row
      // the manager already reconciled or intentionally excluded.
      ...(args.status === "reconciled" || args.status === "excluded"
        ? { receiptReminderStage: undefined, lastReminderSentAt: undefined }
        : {}),
    });
    return null;
  },
});

/**
 * Attach a receipt to a transaction. Bookkeeper-or-above may attach to ANY
 * transaction in the chapter (the reconcile-grid path); a caller with no
 * finance seat may still attach to their OWN transaction (the member "My
 * transactions" path) — a cardholder chasing their own receipt shouldn't need
 * a finance grant to do it.
 */
export const attachReceipt = mutation({
  args: {
    transactionId: v.id("transactions"),
    storageId: v.id("_storage"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    const txn = (await ctx.db.get(args.transactionId)) as Doc<"transactions"> | null;
    if (!txn) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Transaction not found in your chapter.",
      });
    }
    if (txn.chapterId === CENTRAL) {
      // A central-owned txn's receipt is central-desk territory (no cardholder
      // "own txn" path — central issues no cards). Gate on central reach AND
      // the bookkeeper rank (requireFinanceCentral alone only checks reach,
      // not role — see requireReconcileTxn for the same fix).
      const access = await requireFinanceCentral(ctx, chapterId);
      if (!financeRoleAtLeast(access.role, "bookkeeper")) {
        throw new ConvexError({
          code: "FORBIDDEN",
          message: `This action needs at least the ${FINANCE_ROLE_LABELS.bookkeeper} finance role.`,
        });
      }
    } else {
      if (txn.chapterId !== chapterId) {
        throw new ConvexError({
          code: "NOT_FOUND",
          message: "Transaction not found in your chapter.",
        });
      }
      const access = await getFinanceRole(ctx, chapterId);
      const isOwnTxn = access.personId != null && access.personId === txn.personId;
      if (!isOwnTxn && !financeRoleAtLeast(access.role, "bookkeeper")) {
        throw new ConvexError({
          code: "FORBIDDEN",
          message:
            "Only the transaction's own person or a bookkeeper can attach a receipt.",
        });
      }
    }
    await ctx.db.patch(args.transactionId, {
      receiptStorageId: args.storageId,
      // The reminder timeline is moot once a receipt is attached.
      receiptReminderStage: undefined,
      lastReminderSentAt: undefined,
    });
    // If this charge was the (or a) reason the card auto-locked, re-check
    // eligibility right away — don't wait for the next daily cron sweep.
    if (txn.cardId) {
      await unlockCardIfReceiptsResolved(ctx, txn.cardId);
    }
    return null;
  },
});

export const flagPersonal = mutation({
  args: { transactionId: v.id("transactions"), isPersonal: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    // Scope-aware (WP-2.1): keeps central-owned txns writable at central reach
    // rather than dead-ending; personal-charge flagging is really a chapter/
    // cardholder concern, but the scope gate must not leave central txns
    // untouchable by the central desk.
    await requireReconcileTxn(ctx, args.transactionId, "bookkeeper");
    // A personal charge is excluded from spend until repaid (`isPersonal`
    // already drops it from SPEND totals; no status change needed).
    await ctx.db.patch(args.transactionId, { isPersonal: args.isPersonal });
    return null;
  },
});

/**
 * R1a — set (or clear) a transaction's freeform note: "who was this for and
 * why" (the business/mission justification budget + category alone don't
 * capture). Same authz as `categorizeTransaction` (scope-aware
 * `requireReconcileTxn`, bookkeeper rank) — coding a charge and annotating it
 * are the same reconcile-grid privilege. `null` (or an all-whitespace string)
 * clears the note; anything else is trimmed and capped at `MAX_NOTE_LENGTH`.
 */
export const setTransactionNote = mutation({
  args: { transactionId: v.id("transactions"), note: v.union(v.string(), v.null()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireReconcileTxn(ctx, args.transactionId, "bookkeeper");
    const trimmed = args.note?.trim() || null;
    if (trimmed && trimmed.length > MAX_NOTE_LENGTH) {
      throw new ConvexError({
        code: "NOTE_TOO_LONG",
        message: `A note can't be longer than ${MAX_NOTE_LENGTH} characters.`,
      });
    }
    await ctx.db.patch(args.transactionId, { note: trimmed ?? undefined });
    return null;
  },
});

// ═══════════════════════════════════════════════════════════════════════════
// WP-2.2 — Bulk reattribution + audit trail (the split's execution tool)
//
// The retroactive split (Phase 2) moves ~239 historical transactions — and the
// music/recording project's whole money loop — across the central boundary. The
// tools below EXECUTE that division: `reassignTransactions` moves a human-
// confirmed batch of txns; `transferProjectScope` moves a project's budgets +
// txns as one unit; `suggestSplitAssignments` buckets a chapter's history per
// the playbook boundary rules (SUGGESTIONS ONLY — a human confirms the ids);
// every bulk write appends one `reattributionAudit` row.
//
// INVARIANTS held here: reassignment never touches `amountCents`/`flow` (money
// is unchanged — only WHERE it belongs); attribution is explicit-only (we clear
// links, never derive new ones); central power is gated (central reach + the
// bookkeeper WRITE rank — a central viewer is blocked like a chapter viewer);
// every bulk write is audited; failures are `ConvexError`.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Gate a CENTRAL bulk-write operation: central reach AND at least the `min`
 * write rank. `requireFinanceCentral` alone only checks REACH (any central
 * grant, including a viewer-only one), so — exactly like `requireReconcileTxn`
 * (#151) — we additionally clear the role rank so a central VIEWER can't perform
 * a write that a chapter viewer is correctly blocked from. Returns the caller's
 * roster person (may be null for a superuser without a `people` row) + userId.
 */
async function requireCentralWrite(
  ctx: MutationCtx,
  min: "viewer" | "bookkeeper" | "manager",
): Promise<{ personId: Id<"people"> | null; userId: Id<"users"> }> {
  const homeChapterId = (await requireChapterId(ctx)) as Id<"chapters">;
  const userId = (await requireUserId(ctx)) as Id<"users">;
  const access = await requireFinanceCentral(ctx, homeChapterId);
  if (!financeRoleAtLeast(access.role, min)) {
    throw new ConvexError({
      code: "FORBIDDEN",
      message: `This action needs at least the ${FINANCE_ROLE_LABELS[min]} finance role.`,
    });
  }
  return { personId: access.personId, userId };
}

/** One `reattributionAudit.priorStates` entry — a txn's exact attribution
 *  right before a bulk move patches it. See the schema doc comment for why
 *  this exists (true undo vs. a swapped-target re-run). */
type ReattributionPriorState = {
  transactionId: Id<"transactions">;
  chapterId: FinanceScope;
  budgetId?: Id<"budgets">;
  fundId?: Id<"funds">;
  categoryId?: Id<"budgetCategories">;
  projectId?: Id<"projects">;
  eventId?: Id<"events">;
  eventItemId?: Id<"eventItems">;
  teamId?: Id<"financeTeams">;
  personId?: Id<"people">;
};

/** Snapshot a txn's CURRENT attribution — called before its reassignment patch
 *  is computed/applied, so the audit row remembers exactly what to restore. */
function snapshotPriorState(txn: Doc<"transactions">): ReattributionPriorState {
  return {
    transactionId: txn._id,
    chapterId: txn.chapterId as FinanceScope,
    budgetId: txn.budgetId,
    fundId: txn.fundId,
    categoryId: txn.categoryId,
    projectId: txn.projectId,
    eventId: txn.eventId,
    eventItemId: txn.eventItemId,
    teamId: txn.teamId,
    personId: txn.personId,
  };
}

/**
 * A chapter-only PERSON link survives a cross-boundary move ONLY when the
 * roster row belongs to the TARGET chapter. Moving to central always clears it
 * (a central txn carries no person link at all — `createManualTransaction`
 * enforces the same invariant at creation). Returns the id to keep, or
 * `undefined` to clear the field (a `patch` with an `undefined` value unsets it).
 */
async function keepTargetOwnedPerson(
  ctx: QueryCtx,
  id: Id<"people"> | undefined,
  target: FinanceScope,
): Promise<Id<"people"> | undefined> {
  if (id == null) return undefined;
  if (target === CENTRAL) return undefined;
  const person = (await ctx.db.get(id)) as { chapterId?: Id<"chapters"> } | null;
  return person && person.chapterId === target ? id : undefined;
}

/**
 * The field patch that moves ONE transaction to `target`, clearing every
 * chapter-scoped attribution that no longer makes sense across the boundary.
 * A same-scope "move" (`target` already owns the txn) is a no-op — attributions
 * are left untouched. Per-field rules (documented so the split is auditable):
 *
 *  - `chapterId`  → always set to `target` (the whole point).
 *  - `budgetId`   → KEEP only if the linked budget is owned by `target` (budgets
 *                   carry the same chapter|central union); a source-scope budget
 *                   no longer applies → clear.
 *  - `fundId`     → funds are chapter-scoped (NO central funds): → central clears
 *                   it; → chapter reassigns the TARGET chapter's General Fund
 *                   (never inherit the source chapter's fund).
 *  - `categoryId` → categories are chapter-scoped (source chapter's fund tree) →
 *                   ALWAYS clear (the receiving treasurer recodes).
 *  - `teamId`     → financeTeams MAY be central (absent chapterId): keep a
 *                   central team or a target-owned team; clear a source-chapter
 *                   team (a central txn carries no chapter-scoped link — the same
 *                   invariant `createManualTransaction` enforces at creation).
 *  - `personId`   → a roster person is chapter-scoped and a central txn carries
 *                   none (`createManualTransaction` rejects it): → central clears;
 *                   → chapter keeps only a target-roster person.
 *
 *  WP-U (one home per dollar): `projectId`/`eventId`/`eventItemId` are NEVER
 *  touched here anymore — those FKs are vestigial (`budgetId` is the only real
 *  attribution; actuals are budget-first), so a reassignment leaves whatever
 *  stale value was already on the row alone rather than clearing it. This also
 *  means `transferProjectScope` no longer needs a `preserveProjectId` escape
 *  hatch to keep a whole-project move's project link — nothing here ever
 *  touches `projectId`, so there's nothing to preserve.
 *
 *  Deliberately UNTOUCHED (provenance/reality of where the money physically
 *  moved — reassignment must never rewrite it): `externalId`, `sourceAccountId`,
 *  `cardId`, `cardLast4`, `reimbursementId`, `engagementId`, `repaymentId`,
 *  receipt, amount/flow/status.
 */
async function computeReassignmentPatch(
  ctx: MutationCtx,
  txn: Doc<"transactions">,
  target: FinanceScope,
): Promise<Record<string, unknown>> {
  const patch: Record<string, unknown> = { chapterId: target };
  // Same-scope "move": nothing crossed the boundary — leave attributions as-is.
  if (txn.chapterId === target) return patch;

  if (txn.budgetId != null) {
    const budget = await ctx.db.get(txn.budgetId);
    patch.budgetId = budget && budget.chapterId === target ? txn.budgetId : undefined;
  }

  patch.fundId =
    target === CENTRAL ? undefined : ((await defaultFundId(ctx, target)) ?? undefined);

  patch.categoryId = undefined;

  if (txn.teamId != null) {
    const team = (await ctx.db.get(txn.teamId)) as { chapterId?: Id<"chapters"> } | null;
    const teamChapter = team?.chapterId; // undefined = a central/org team
    const keep = team != null && (teamChapter === undefined || teamChapter === target);
    patch.teamId = keep ? txn.teamId : undefined;
  }

  patch.personId = await keepTargetOwnedPerson(ctx, txn.personId, target);

  return patch;
}

/** A finance scope's display name ("Central" for the sentinel, else the
 *  chapter's name) — used to build the human-readable audit summary. */
async function financeScopeName(ctx: QueryCtx, scope: FinanceScope): Promise<string> {
  if (scope === CENTRAL) return "Central";
  const chapter = await ctx.db.get(scope);
  return chapter?.name ?? "Unknown chapter";
}

/** A `"New York (12), Central (1) → Central"` from→to summary for the audit. */
async function buildReassignSummary(
  ctx: QueryCtx,
  sourceCounts: Map<FinanceScope, number>,
  target: FinanceScope,
): Promise<string> {
  const parts: string[] = [];
  for (const [scope, count] of sourceCounts) {
    parts.push(`${await financeScopeName(ctx, scope)} (${count})`);
  }
  parts.sort();
  return `${parts.join(", ")} → ${await financeScopeName(ctx, target)}`;
}

const reattributionTargetValidator = v.union(v.id("chapters"), v.literal(CENTRAL));

export const reassignTransactions = mutation({
  args: {
    transactionIds: v.array(v.id("transactions")),
    // The destination scope: a real chapter, or the central sentinel.
    target: reattributionTargetValidator,
    note: v.optional(v.string()),
  },
  returns: v.object({
    updated: v.number(),
    // Selected txns already at `target` — real no-ops, excluded from `updated`
    // and the audit row so summaries reflect only actual reattributions.
    skippedSameScope: v.number(),
    auditId: v.id("reattributionAudit"),
  }),
  handler: async (ctx, args) => {
    // Reassignment across the central boundary is a CENTRAL power.
    const { personId, userId } = await requireCentralWrite(ctx, "bookkeeper");

    if (args.transactionIds.length === 0) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "Select at least one transaction to reassign.",
      });
    }
    if (args.transactionIds.length > REASSIGN_BATCH_CAP) {
      throw new ConvexError({
        code: "BATCH_TOO_LARGE",
        message: `Reassign at most ${REASSIGN_BATCH_CAP} transactions per call — the grid paginates larger runs.`,
      });
    }
    // De-dup so a doubled selection can't be counted or patched twice.
    const ids = [...new Set(args.transactionIds)];

    if (args.target !== CENTRAL) {
      const chapter = await ctx.db.get(args.target);
      if (!chapter) {
        throw new ConvexError({ code: "NOT_FOUND", message: "Target chapter not found." });
      }
    }

    const sourceCounts = new Map<FinanceScope, number>();
    const priorStates: ReattributionPriorState[] = [];
    const movedIds: Id<"transactions">[] = [];
    let updated = 0;
    let skippedSameScope = 0;
    for (const id of ids) {
      const txn = (await ctx.db.get(id)) as Doc<"transactions"> | null;
      if (!txn) {
        throw new ConvexError({
          code: "NOT_FOUND",
          message: "One of the selected transactions no longer exists.",
        });
      }
      if (txn.chapterId === args.target) {
        // Already at the destination — not a real move; keep it out of the
        // audit trail (it never crossed a boundary, so there's nothing to undo).
        skippedSameScope++;
        continue;
      }
      const from = txn.chapterId as FinanceScope;
      sourceCounts.set(from, (sourceCounts.get(from) ?? 0) + 1);
      priorStates.push(snapshotPriorState(txn));
      const patch = await computeReassignmentPatch(ctx, txn, args.target);
      await ctx.db.patch(id, patch);
      movedIds.push(id);
      updated++;
    }

    const summary = await buildReassignSummary(ctx, sourceCounts, args.target);
    const auditId = await ctx.db.insert("reattributionAudit", {
      kind: "bulk_reassign",
      actorUserId: userId,
      ...(personId ? { actorPersonId: personId } : {}),
      transactionIds: movedIds,
      target: args.target,
      summary,
      priorStates,
      ...(args.note ? { note: args.note } : {}),
      createdAt: Date.now(),
    });
    return { updated, skippedSameScope, auditId };
  },
});

/**
 * Move a budget's scope as part of a project transfer. Central budgets carry no
 * chapter-scoped narrowers, so → central clears fund/category/team; → chapter
 * rebases the fund default and drops the source category/team. The budget↔tag
 * links get their denormalized `chapterId` updated, and a link whose tag is
 * invalid at the new level (a chapter tag on a central budget) is dropped.
 *
 * A WP-3.1 `budgetLines` row's own `categoryId` is chapter-scoped the same way
 * the budget's is (`budgetLines.ts#verifyCategory`) — a category from the
 * source chapter's tree is meaningless (or invalid) at the new scope, so it's
 * cleared on every line too. `description`/`plannedCents` are untouched — the
 * PLAN survives the move, only the stale chapter-scoped ref does not.
 */
async function moveBudgetScope(
  ctx: MutationCtx,
  budget: Doc<"budgets">,
  target: FinanceScope,
): Promise<void> {
  await ctx.db.patch(budget._id, {
    chapterId: target,
    fundId: target === CENTRAL ? undefined : ((await defaultFundId(ctx, target)) ?? undefined),
    // Category + team belong to the source chapter's tree — clear on any move.
    categoryId: undefined,
    teamId: undefined,
  });
  const links = await ctx.db
    .query("budgetTagLinks")
    .withIndex("by_budget", (q) => q.eq("budgetId", budget._id))
    .collect();
  for (const link of links) {
    const tag = await ctx.db.get(link.tagId);
    const valid = tag != null && tagLevelAllowed(tag.chapterId, target);
    if (!valid) {
      await ctx.db.delete(link._id);
      continue;
    }
    if (link.chapterId !== target) await ctx.db.patch(link._id, { chapterId: target });
  }

  const lines = await ctx.db
    .query("budgetLines")
    .withIndex("by_budget", (q) => q.eq("budgetId", budget._id))
    .take(ROLLUP_SCAN_LIMIT);
  for (const line of lines) {
    if (line.categoryId !== undefined) await ctx.db.patch(line._id, { categoryId: undefined });
  }
}

export const transferProjectScope = mutation({
  args: {
    projectId: v.id("projects"),
    target: reattributionTargetValidator,
    note: v.optional(v.string()),
  },
  returns: v.object({
    budgetsMoved: v.number(),
    txnsMoved: v.number(),
    auditId: v.id("reattributionAudit"),
    // The projects table has no central scope / chapterId union yet (WP-2.2
    // finding): the project ROW stays chapter-scoped — only its money moved.
    projectScopeDeferred: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const { personId, userId } = await requireCentralWrite(ctx, "bookkeeper");
    const project = await ctx.db.get(args.projectId);
    if (!project) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Project not found." });
    }
    if (args.target !== CENTRAL) {
      const chapter = await ctx.db.get(args.target);
      if (!chapter) {
        throw new ConvexError({ code: "NOT_FOUND", message: "Target chapter not found." });
      }
    }
    const sourceScope = project.chapterId as FinanceScope;

    // 1. Move the project's BUDGETS (one_time budgets whose refKind:"project"
    //    scopeRefId points at this project). Found via `by_ref` — NOT scoped to
    //    `sourceScope` — because `project.chapterId` never changes (WP-2.2
    //    finding). Scoping this lookup to the project's home chapter meant a
    //    REVERSE transfer (chapter → central → back to chapter) couldn't find
    //    budgets that already moved to central: it queried the chapter, but the
    //    budgets lived at central by then, so they were silently stranded.
    //    `by_ref` finds them regardless of which scope currently owns them.
    const projectBudgets = await ctx.db
      .query("budgets")
      .withIndex("by_ref", (q) =>
        q.eq("refKind", "project").eq("scopeRefId", args.projectId),
      )
      .take(ROLLUP_SCAN_LIMIT);
    let budgetsMoved = 0;
    for (const b of projectBudgets) {
      if (b.chapterId === args.target) continue;
      await moveBudgetScope(ctx, b, args.target);
      budgetsMoved++;
    }

    // 2. Move the transactions ATTACHED TO those budgets (WP-U: one home per
    //    dollar — the money follows the BUDGET, discovered via `by_budget`,
    //    not the txn's own `projectId` FK, which is now vestigial and untouched
    //    by `computeReassignmentPatch`). A project can carry more than one
    //    one_time budget over its life (rare, but possible), so this unions
    //    every budget's linked transactions.
    const linked: Doc<"transactions">[] = [];
    for (const b of projectBudgets) {
      const rows = await ctx.db
        .query("transactions")
        .withIndex("by_budget", (q) => q.eq("budgetId", b._id))
        .take(ROLLUP_SCAN_LIMIT);
      if (rows.length === ROLLUP_SCAN_LIMIT) {
        console.warn(
          `[finances] transferProjectScope hit ROLLUP_SCAN_LIMIT (${ROLLUP_SCAN_LIMIT}) reading transactions for budget ${b._id}; some linked transactions may not have moved.`,
        );
      }
      linked.push(...rows);
    }
    const priorStates: ReattributionPriorState[] = [];
    const movedTxnIds: Id<"transactions">[] = [];
    for (const txn of linked) {
      if (txn.chapterId === args.target) continue;
      priorStates.push(snapshotPriorState(txn));
      const patch = await computeReassignmentPatch(ctx, txn, args.target);
      await ctx.db.patch(txn._id, patch);
      movedTxnIds.push(txn._id);
    }

    const summary = `Project "${project.name}": ${await financeScopeName(
      ctx,
      sourceScope,
    )} → ${await financeScopeName(ctx, args.target)} (${budgetsMoved} budget(s), ${
      movedTxnIds.length
    } txn(s))`;
    const auditId = await ctx.db.insert("reattributionAudit", {
      kind: "project_transfer",
      actorUserId: userId,
      ...(personId ? { actorPersonId: personId } : {}),
      transactionIds: movedTxnIds,
      target: args.target,
      summary,
      priorStates,
      projectId: args.projectId,
      budgetsMoved,
      ...(args.note ? { note: args.note } : {}),
      createdAt: Date.now(),
    });
    return {
      budgetsMoved,
      txnsMoved: movedTxnIds.length,
      auditId,
      projectScopeDeferred: true,
    };
  },
});

// ── Rule-assisted split suggestions (central-gated; SUGGESTIONS ONLY) ─────────
const splitSuggestionRow = v.object({
  id: v.id("transactions"),
  amountCents: v.number(),
  flow: flowValidator,
  postedAt: v.number(),
  description: v.union(v.string(), v.null()),
  merchantName: v.union(v.string(), v.null()),
  // Why the rules bucketed this txn where they did (shown to the human).
  reason: v.string(),
});

export const suggestSplitAssignments = query({
  args: { chapterId: v.id("chapters") },
  returns: v.object({
    central: v.array(splitSuggestionRow),
    chapter: v.array(splitSuggestionRow),
    unassigned: v.array(splitSuggestionRow),
    // The chapter's projects with a per-project scope suggestion, so the UI can
    // let a human override the music-project-is-central heuristic per project.
    projects: v.array(
      v.object({
        id: v.id("projects"),
        name: v.string(),
        suggested: v.union(v.literal("central"), v.literal("chapter")),
        txnCount: v.number(),
      }),
    ),
    counts: v.object({
      central: v.number(),
      chapter: v.number(),
      unassigned: v.number(),
    }),
  }),
  handler: async (ctx, args) => {
    const empty = {
      central: [] as (typeof splitSuggestionRow.type)[],
      chapter: [] as (typeof splitSuggestionRow.type)[],
      unassigned: [] as (typeof splitSuggestionRow.type)[],
      projects: [] as {
        id: Id<"projects">;
        name: string;
        suggested: "central" | "chapter";
        txnCount: number;
      }[],
      counts: { central: 0, chapter: 0, unassigned: 0 },
    };
    const homeChapterId = await readChapterId(ctx);
    if (!homeChapterId) return empty;
    // Bucketing the chapter's money for the split is a central power.
    await requireFinanceCentral(ctx, homeChapterId);

    const sandboxMode = await readSandbox(ctx);
    const txns = (
      await ctx.db
        .query("transactions")
        .withIndex("by_chapter", (q) => q.eq("chapterId", args.chapterId))
        .take(ROLLUP_SCAN_LIMIT)
    ).filter((tr) => txnMatchesMode(tr, sandboxMode));

    const projectCache = new Map<Id<"projects">, Doc<"projects"> | null>();
    const getProject = async (id: Id<"projects">) => {
      if (projectCache.has(id)) return projectCache.get(id)!;
      const p = await ctx.db.get(id);
      projectCache.set(id, p);
      return p;
    };
    // WP-U (one home per dollar): the split heuristic reads a txn's BUDGET ref
    // (`refKind`/`scopeRefId`) instead of its own `eventId`/`projectId` FKs —
    // those are vestigial now (nothing new writes them; only `budgetId` is a
    // real attribution).
    const budgetCache = new Map<Id<"budgets">, Doc<"budgets"> | null>();
    const getBudget = async (id: Id<"budgets">) => {
      if (budgetCache.has(id)) return budgetCache.get(id)!;
      const b = await ctx.db.get(id);
      budgetCache.set(id, b);
      return b;
    };

    const central: (typeof splitSuggestionRow.type)[] = [];
    const chapter: (typeof splitSuggestionRow.type)[] = [];
    const unassigned: (typeof splitSuggestionRow.type)[] = [];
    const projectTxnCounts = new Map<Id<"projects">, number>();

    const toRow = (tr: Doc<"transactions">, reason: string) => ({
      id: tr._id,
      amountCents: tr.amountCents,
      flow: tr.flow,
      postedAt: tr.postedAt,
      description: tr.description ?? null,
      merchantName: tr.merchantName ?? null,
      reason,
    });

    for (const tr of txns) {
      const budget = tr.budgetId ? await getBudget(tr.budgetId) : null;
      if (budget?.refKind === "event") {
        // Event-linked → chapter: canon events are local (playbook boundary).
        chapter.push(toRow(tr, "Event-linked — canon events stay with the chapter"));
      } else if (budget?.refKind === "project" && budget.scopeRefId) {
        const projectId = budget.scopeRefId as Id<"projects">;
        projectTxnCounts.set(projectId, (projectTxnCounts.get(projectId) ?? 0) + 1);
        const project = await getProject(projectId);
        const isCentralProject = matchesAnyKeyword(project?.name, CENTRAL_PROJECT_KEYWORDS);
        if (isCentralProject) {
          central.push(
            toRow(tr, `Project "${project?.name ?? "?"}" is central-owned (music/recording)`),
          );
        } else {
          chapter.push(toRow(tr, `Project "${project?.name ?? "?"}" stays with the chapter`));
        }
      } else if (
        matchesAnyKeyword(tr.merchantName, CENTRAL_MERCHANT_KEYWORDS) ||
        matchesAnyKeyword(tr.description, CENTRAL_MERCHANT_KEYWORDS)
      ) {
        central.push(toRow(tr, "Merchant looks central (expansion / conference / brand)"));
      } else {
        unassigned.push(toRow(tr, "No rule matched — a human decides"));
      }
    }

    const projects: {
      id: Id<"projects">;
      name: string;
      suggested: "central" | "chapter";
      txnCount: number;
    }[] = [];
    for (const [pid, count] of projectTxnCounts) {
      const project = await getProject(pid);
      if (!project) continue;
      projects.push({
        id: pid,
        name: project.name,
        suggested: matchesAnyKeyword(project.name, CENTRAL_PROJECT_KEYWORDS)
          ? "central"
          : "chapter",
        txnCount: count,
      });
    }
    projects.sort((a, b) => a.name.localeCompare(b.name));

    return {
      central,
      chapter,
      unassigned,
      projects,
      counts: {
        central: central.length,
        chapter: chapter.length,
        unassigned: unassigned.length,
      },
    };
  },
});

// ── Restore (true undo) ───────────────────────────────────────────────────────
/**
 * Ops escape hatch — NOT exposed in any UI, callable only via the
 * `run-convex-function` workflow (same pattern as `linkIncreaseAccount`'s
 * demotion in WP-1.2) by an operator who has the audit row id in hand (from
 * `listReattributionAudit` or the dashboard). Restores every txn snapshotted
 * in `audit.priorStates` to EXACTLY its pre-move attribution — the true undo
 * that a swapped-target re-run of `reassignTransactions` /
 * `transferProjectScope` can't provide (that only restores `chapterId`; it
 * would recompute a FRESH reassignment patch, clearing category/fund/links all
 * over again instead of putting them back).
 *
 * Idempotent-ish: a txn deleted since the original move is skipped (not an
 * error) rather than failing the whole restore. Safe to re-run — re-patching
 * the same prior values twice is a no-op the second time.
 *
 * Does NOT re-open a `project_transfer`'s budget move — those round-trip
 * correctly via a second `transferProjectScope` call to the original scope
 * (the `by_ref`-based discovery fix means budgets are never stranded either
 * direction); this restores the TRANSACTION side, including whatever coding
 * the transfer or bulk reassign cleared along the way.
 */
export const restoreReattribution = internalMutation({
  args: { auditId: v.id("reattributionAudit") },
  returns: v.object({ restored: v.number(), skipped: v.number() }),
  handler: async (ctx, args) => {
    const audit = await ctx.db.get(args.auditId);
    if (!audit) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Audit row not found." });
    }
    let restored = 0;
    let skipped = 0;
    for (const prior of audit.priorStates) {
      const txn = await ctx.db.get(prior.transactionId);
      if (!txn) {
        skipped++;
        continue;
      }
      await ctx.db.patch(prior.transactionId, {
        chapterId: prior.chapterId,
        budgetId: prior.budgetId,
        fundId: prior.fundId,
        categoryId: prior.categoryId,
        projectId: prior.projectId,
        eventId: prior.eventId,
        eventItemId: prior.eventItemId,
        teamId: prior.teamId,
        personId: prior.personId,
      });
      restored++;
    }
    return { restored, skipped };
  },
});

// ── Audit read (central-gated) + reassign target list (for the bulk bar) ─────
export const listReattributionAudit = query({
  args: { limit: v.optional(v.number()) },
  returns: v.array(
    v.object({
      id: v.id("reattributionAudit"),
      kind: v.union(v.literal("bulk_reassign"), v.literal("project_transfer")),
      actorName: v.union(v.string(), v.null()),
      txnCount: v.number(),
      target: reattributionTargetValidator,
      summary: v.string(),
      note: v.union(v.string(), v.null()),
      budgetsMoved: v.union(v.number(), v.null()),
      createdAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const homeChapterId = await readChapterId(ctx);
    if (!homeChapterId) return [];
    await requireFinanceCentral(ctx, homeChapterId);
    const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
    const rows = await ctx.db
      .query("reattributionAudit")
      .withIndex("by_created")
      .order("desc")
      .take(limit);
    const out: {
      id: Id<"reattributionAudit">;
      kind: "bulk_reassign" | "project_transfer";
      actorName: string | null;
      txnCount: number;
      target: FinanceScope;
      summary: string;
      note: string | null;
      budgetsMoved: number | null;
      createdAt: number;
    }[] = [];
    for (const r of rows) {
      let actorName: string | null = null;
      if (r.actorPersonId) {
        const person = await ctx.db.get(r.actorPersonId);
        actorName = person?.name ?? null;
      }
      out.push({
        id: r._id,
        kind: r.kind,
        actorName,
        txnCount: r.transactionIds.length,
        target: r.target,
        summary: r.summary,
        note: r.note ?? null,
        budgetsMoved: r.budgetsMoved ?? null,
        createdAt: r.createdAt,
      });
    }
    return out;
  },
});

/** The chapters a central caller may reassign money to/from — powers the
 *  Reconcile bulk bar's "Reassign to" picker (the UI prepends "Central"). */
export const reassignTargets = query({
  args: {},
  returns: v.array(v.object({ id: v.id("chapters"), name: v.string() })),
  handler: async (ctx) => {
    const homeChapterId = await readChapterId(ctx);
    if (!homeChapterId) return [];
    await requireFinanceCentral(ctx, homeChapterId);
    const chapters = await ctx.db.query("chapters").take(ROLLUP_SCAN_LIMIT);
    return chapters
      .filter((c) => c.isActive !== false)
      .map((c) => ({ id: c._id, name: c.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  },
});
