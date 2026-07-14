/**
 * Finance public API — Phase 0 CONTRACT STUBS.
 *
 * Every function below has REAL `args` + `returns` validators and REAL auth
 * gating (via `lib/finance.ts`), but a PLACEHOLDER handler body that returns a
 * typed empty/zero result. This is the API contract the Expo app compiles
 * against (`api.finances.*`) before Phase 1A fills in the business logic — the
 * handlers here are intentionally hollow and will be REPLACED wholesale.
 *
 * Gating (per the finance-role ladder viewer < bookkeeper < manager):
 *  - reads                          → requireFinanceRole(..., "viewer")
 *  - transaction writes             → requireFinanceRole(..., "bookkeeper")
 *  - fund/category/team/budget CRUD → requireFinanceManager
 *  - central roll-up                → requireFinanceCentral
 *
 * Money is ALWAYS integer cents. All functions are chapter-scoped. Reads use
 * `getChapterIdOrNull` so a pre-onboarding user gets empty results instead of a
 * thrown error; writes use `requireChapterId`.
 */
import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { Id } from "./_generated/dataModel";
import {
  FUND_RESTRICTIONS,
  BUDGET_CATEGORY_KINDS,
  BUDGET_SCOPES,
  BUDGET_CADENCES,
  BUDGET_ROLLOVER_POLICIES,
  TRANSACTION_SOURCES,
  TRANSACTION_FLOWS,
  TRANSACTION_STATUSES,
} from "@events-os/shared";
import { getChapterIdOrNull, requireChapterId } from "./lib/context";
import {
  requireFinanceRole,
  requireFinanceManager,
  requireFinanceCentral,
} from "./lib/finance";

// ── Enum validators (built from the shared tuples) ───────────────────────────
const restrictionValidator = v.union(
  ...FUND_RESTRICTIONS.map((r) => v.literal(r)),
);
const categoryKindValidator = v.union(
  ...BUDGET_CATEGORY_KINDS.map((k) => v.literal(k)),
);
const scopeValidator = v.union(...BUDGET_SCOPES.map((s) => v.literal(s)));
const cadenceValidator = v.union(...BUDGET_CADENCES.map((c) => v.literal(c)));
const rolloverValidator = v.union(
  ...BUDGET_ROLLOVER_POLICIES.map((p) => v.literal(p)),
);
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

const budgetSummary = v.object({
  id: v.id("budgets"),
  amountCents: v.number(),
  label: v.union(v.string(), v.null()),
  scope: scopeValidator,
  scopeRefId: v.union(v.string(), v.null()),
  cadence: cadenceValidator,
  year: v.number(),
  month: v.union(v.number(), v.null()),
  quarter: v.union(v.number(), v.null()),
  fundId: v.union(v.id("funds"), v.null()),
  categoryId: v.union(v.id("budgetCategories"), v.null()),
  teamId: v.union(v.id("financeTeams"), v.null()),
});

const txnSummary = v.object({
  id: v.id("transactions"),
  postedAt: v.number(),
  amountCents: v.number(),
  flow: flowValidator,
  status: statusValidator,
  description: v.union(v.string(), v.null()),
  merchantName: v.union(v.string(), v.null()),
  fundId: v.union(v.id("funds"), v.null()),
  categoryId: v.union(v.id("budgetCategories"), v.null()),
});

const fundBalance = v.object({
  id: v.id("funds"),
  name: v.string(),
  balanceCents: v.number(),
});

/** Resolve the caller's chapter for a READ, typed for the finance helpers. */
async function readChapterId(
  ctx: Parameters<typeof getChapterIdOrNull>[0],
): Promise<Id<"chapters"> | null> {
  const id = await getChapterIdOrNull(ctx);
  return (id as Id<"chapters"> | null) ?? null;
}

// A Phase-0 placeholder id. Never actually returned in practice — Phase 1A
// implements these handlers before the create paths are exercised for real.
const STUB_ID = null as unknown;

// ── Dashboards ───────────────────────────────────────────────────────────────

/** The chapter finance dashboard: balance, flows, unreviewed count, rollups. */
export const dashboardChapter = query({
  args: {},
  returns: v.object({
    balanceCents: v.number(),
    inflowCents: v.number(),
    outflowCents: v.number(),
    unreviewedCount: v.number(),
    funds: v.array(fundBalance),
    recentTransactions: v.array(txnSummary),
  }),
  handler: async (ctx) => {
    const empty = {
      balanceCents: 0,
      inflowCents: 0,
      outflowCents: 0,
      unreviewedCount: 0,
      funds: [],
      recentTransactions: [],
    };
    const chapterId = await readChapterId(ctx);
    if (!chapterId) return empty;
    await requireFinanceRole(ctx, chapterId, "viewer");
    return empty; // Phase 0 stub
  },
});

/** The org-wide roll-up across every chapter (central finance only). */
export const dashboardCentral = query({
  args: {},
  returns: v.object({
    totalBalanceCents: v.number(),
    totalInflowCents: v.number(),
    totalOutflowCents: v.number(),
    chapters: v.array(
      v.object({
        chapterId: v.id("chapters"),
        name: v.string(),
        balanceCents: v.number(),
      }),
    ),
  }),
  handler: async (ctx) => {
    const empty = {
      totalBalanceCents: 0,
      totalInflowCents: 0,
      totalOutflowCents: 0,
      chapters: [],
    };
    const chapterId = await readChapterId(ctx);
    if (!chapterId) return empty;
    await requireFinanceCentral(ctx, chapterId);
    return empty; // Phase 0 stub
  },
});

/** Budget-vs-actual for a period (year, optionally narrowed to a month). */
export const budgetVsActual = query({
  args: { year: v.number(), month: v.optional(v.number()) },
  returns: v.array(
    v.object({
      budgetId: v.union(v.id("budgets"), v.null()),
      label: v.string(),
      scope: scopeValidator,
      allocatedCents: v.number(),
      actualCents: v.number(),
    }),
  ),
  handler: async (ctx) => {
    const chapterId = await readChapterId(ctx);
    if (!chapterId) return [];
    await requireFinanceRole(ctx, chapterId, "viewer");
    return []; // Phase 0 stub
  },
});

/** Actual spend attached to a single event. */
export const eventActuals = query({
  args: { eventId: v.id("events") },
  returns: v.object({
    totalCents: v.number(),
    transactions: v.array(txnSummary),
  }),
  handler: async (ctx) => {
    const chapterId = await readChapterId(ctx);
    if (!chapterId) return { totalCents: 0, transactions: [] };
    await requireFinanceRole(ctx, chapterId, "viewer");
    return { totalCents: 0, transactions: [] }; // Phase 0 stub
  },
});

/** Actual spend attached to a single project. */
export const projectActuals = query({
  args: { projectId: v.id("projects") },
  returns: v.object({
    totalCents: v.number(),
    transactions: v.array(txnSummary),
  }),
  handler: async (ctx) => {
    const chapterId = await readChapterId(ctx);
    if (!chapterId) return { totalCents: 0, transactions: [] };
    await requireFinanceRole(ctx, chapterId, "viewer");
    return { totalCents: 0, transactions: [] }; // Phase 0 stub
  },
});

/** Actual spend attached to a single finance team. */
export const teamActuals = query({
  args: { teamId: v.id("financeTeams") },
  returns: v.object({
    totalCents: v.number(),
    transactions: v.array(txnSummary),
  }),
  handler: async (ctx) => {
    const chapterId = await readChapterId(ctx);
    if (!chapterId) return { totalCents: 0, transactions: [] };
    await requireFinanceRole(ctx, chapterId, "viewer");
    return { totalCents: 0, transactions: [] }; // Phase 0 stub
  },
});

/** Transactions attached to a person (defaults to the caller when omitted). */
export const personTransactions = query({
  args: { personId: v.optional(v.id("people")) },
  returns: v.array(txnSummary),
  handler: async (ctx) => {
    const chapterId = await readChapterId(ctx);
    if (!chapterId) return [];
    await requireFinanceRole(ctx, chapterId, "viewer");
    return []; // Phase 0 stub
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
    return []; // Phase 0 stub
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
  handler: async (ctx) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireFinanceManager(ctx, chapterId);
    return STUB_ID as Id<"funds">; // Phase 0 stub
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
  handler: async (ctx) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireFinanceManager(ctx, chapterId);
    return null; // Phase 0 stub
  },
});

// ── Categories ────────────────────────────────────────────────────────────────

export const listCategories = query({
  args: { fundId: v.optional(v.id("funds")) },
  returns: v.array(categorySummary),
  handler: async (ctx) => {
    const chapterId = await readChapterId(ctx);
    if (!chapterId) return [];
    await requireFinanceRole(ctx, chapterId, "viewer");
    return []; // Phase 0 stub
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
  handler: async (ctx) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireFinanceManager(ctx, chapterId);
    return STUB_ID as Id<"budgetCategories">; // Phase 0 stub
  },
});

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
  handler: async (ctx) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireFinanceManager(ctx, chapterId);
    return null; // Phase 0 stub
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
    return []; // Phase 0 stub
  },
});

export const createTeam = mutation({
  args: { name: v.string(), sortOrder: v.optional(v.number()) },
  returns: v.id("financeTeams"),
  handler: async (ctx) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireFinanceManager(ctx, chapterId);
    return STUB_ID as Id<"financeTeams">; // Phase 0 stub
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
  handler: async (ctx) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireFinanceManager(ctx, chapterId);
    return null; // Phase 0 stub
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
    return []; // Phase 0 stub
  },
});

export const createBudget = mutation({
  args: {
    amountCents: v.number(),
    scope: scopeValidator,
    cadence: cadenceValidator,
    year: v.number(),
    label: v.optional(v.string()),
    scopeRefId: v.optional(v.string()),
    month: v.optional(v.number()),
    quarter: v.optional(v.number()),
    fundId: v.optional(v.id("funds")),
    categoryId: v.optional(v.id("budgetCategories")),
    teamId: v.optional(v.id("financeTeams")),
    rolloverPolicy: v.optional(rolloverValidator),
  },
  returns: v.id("budgets"),
  handler: async (ctx) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireFinanceManager(ctx, chapterId);
    return STUB_ID as Id<"budgets">; // Phase 0 stub
  },
});

export const updateBudget = mutation({
  args: {
    budgetId: v.id("budgets"),
    patch: v.object({
      amountCents: v.optional(v.number()),
      label: v.optional(v.union(v.string(), v.null())),
      scope: v.optional(scopeValidator),
      scopeRefId: v.optional(v.union(v.string(), v.null())),
      cadence: v.optional(cadenceValidator),
      year: v.optional(v.number()),
      month: v.optional(v.union(v.number(), v.null())),
      quarter: v.optional(v.union(v.number(), v.null())),
      fundId: v.optional(v.union(v.id("funds"), v.null())),
      categoryId: v.optional(v.union(v.id("budgetCategories"), v.null())),
      teamId: v.optional(v.union(v.id("financeTeams"), v.null())),
      rolloverPolicy: v.optional(rolloverValidator),
    }),
  },
  returns: v.null(),
  handler: async (ctx) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireFinanceManager(ctx, chapterId);
    return null; // Phase 0 stub
  },
});

export const deleteBudget = mutation({
  args: { budgetId: v.id("budgets") },
  returns: v.null(),
  handler: async (ctx) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireFinanceManager(ctx, chapterId);
    return null; // Phase 0 stub
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
  handler: async (ctx) => {
    const emptyPage = { page: [], isDone: true, continueCursor: "" };
    const chapterId = await readChapterId(ctx);
    if (!chapterId) return emptyPage;
    await requireFinanceRole(ctx, chapterId, "viewer");
    return emptyPage; // Phase 0 stub
  },
});

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
  handler: async (ctx) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireFinanceRole(ctx, chapterId, "bookkeeper");
    return STUB_ID as Id<"transactions">; // Phase 0 stub
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
  },
  returns: v.null(),
  handler: async (ctx) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireFinanceRole(ctx, chapterId, "bookkeeper");
    return null; // Phase 0 stub
  },
});

export const bulkCategorize = mutation({
  args: {
    transactionIds: v.array(v.id("transactions")),
    fundId: v.optional(v.union(v.id("funds"), v.null())),
    categoryId: v.optional(v.union(v.id("budgetCategories"), v.null())),
  },
  returns: v.object({ updated: v.number() }),
  handler: async (ctx) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireFinanceRole(ctx, chapterId, "bookkeeper");
    return { updated: 0 }; // Phase 0 stub
  },
});

export const setTransactionStatus = mutation({
  args: { transactionId: v.id("transactions"), status: statusValidator },
  returns: v.null(),
  handler: async (ctx) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireFinanceRole(ctx, chapterId, "bookkeeper");
    return null; // Phase 0 stub
  },
});

export const attachReceipt = mutation({
  args: {
    transactionId: v.id("transactions"),
    storageId: v.id("_storage"),
  },
  returns: v.null(),
  handler: async (ctx) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireFinanceRole(ctx, chapterId, "bookkeeper");
    return null; // Phase 0 stub
  },
});

export const flagPersonal = mutation({
  args: { transactionId: v.id("transactions"), isPersonal: v.boolean() },
  returns: v.null(),
  handler: async (ctx) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireFinanceRole(ctx, chapterId, "bookkeeper");
    return null; // Phase 0 stub
  },
});
