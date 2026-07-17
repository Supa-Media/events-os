/**
 * DASHBOARD DRILLDOWNS — central-viewer+ reads that back three previously
 * inert `CentralView` banners (unattributed org-wide spend, budgets awaiting
 * approval) with tappable detail. `transfers.ts#interScopeBalanceContributors`
 * is the third drilldown (inter-chapter balance contributors) — it lives in
 * `transfers.ts` since it shares `interScopeBalances`' own row-computing
 * helper there.
 *
 * Lives in its own file rather than `finances.ts`: at the time this was
 * written, `finances.ts` was owned by a concurrent workstream (WP-A, branch
 * `fix/budget-identity-dates`) and off-limits to edit here. A few small
 * helpers below are DELIBERATE, COMMENTED duplicates of unexported helpers in
 * `finances.ts` (`loadPeriodTxns`, `inDashRange`, `resolveBudgetRef`,
 * `easternDateStr`) — they can't be imported because `finances.ts` doesn't
 * export them, and this file must not modify that one. If `finances.ts` later
 * exports the originals (or this file merges into it), these duplicates
 * should be deleted in favor of the shared versions — keep them in lockstep
 * with their originals until then.
 *
 * Gate: `requireFinanceCentral(ctx, home)` on both queries here — the EXACT
 * same gate `dashboardCentral` itself uses (central reach only, no graded-role
 * floor). Review fix (PR #231): this file originally gated on the stricter
 * `requireCentralFinanceRole(ctx, home, "viewer")` (central reach AND at
 * least the viewer graded role, matching `transfers.ts#interScopeBalances`
 * instead) — reasonable-looking since both were named as "the same gate" by
 * the task that wrote this file, but they're NOT identical: a caller with
 * central reach via a seat-derived capability alone (`isCentral: true`) and
 * no stored graded role (`role: null`) — e.g. a post-B10-flip
 * `executive_director` seat holder, see `lib/finance.ts`'s module doc — would
 * pass `dashboardCentral`'s banner but 403 out of these drilldowns, collapsing
 * the whole dashboard via `FinanceBoundary`. Matching `dashboardCentral`'s
 * actual gate closes that gap; see `dashboardDrill.test.ts`'s
 * "executive_director seat, no stored role" case.
 */
import { v } from "convex/values";
import { query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import {
  CENTRAL,
  easternParts,
  BUDGET_TYPE_LABELS,
  type BudgetType,
  type BudgetRefKind,
} from "@events-os/shared";
import { requireChapterId } from "./lib/context";
import { requireFinanceCentral } from "./lib/finance";
import { readSandbox } from "./financeSettings";
import { isSpend, txnMatchesMode, ROLLUP_SCAN_LIMIT } from "./finances";

// ── Local duplicates of unexported finances.ts helpers (see module doc) ──────

/** Duplicate of `finances.ts#easternDateStr` (unexported): `YYYY-MM-DD` in
 *  America/New_York, the finance timezone. */
function easternDateStrLocal(ts: number): string {
  return new Date(ts).toLocaleDateString("en-CA", {
    timeZone: "America/New_York",
  });
}

/** Duplicate of `finances.ts`'s private `DashPeriod` shape. */
type DashPeriodLocal = { year: number; month: number; ytd: boolean };

/** Duplicate of `finances.ts#inDashRange` (unexported): true iff a timestamp
 *  falls in the dashboard's period — one month, or Jan..throughMonth (YTD). */
function inDashRangeLocal(postedAt: number, dp: DashPeriodLocal): boolean {
  const p = easternParts(postedAt);
  if (p.year !== dp.year) return false;
  if (!dp.ytd) return p.month === dp.month;
  return p.month >= 1 && p.month <= dp.month;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Duplicate of `finances.ts#loadPeriodTxns` (unexported), narrowed to a
 *  whole-year read (no `month` arg) — callers narrow further with
 *  `inDashRangeLocal`, exactly like `dashboardCentral`'s own usage of the
 *  original. Bounded at `ROLLUP_SCAN_LIMIT`, same non-silent truncation
 *  warning as the original. */
async function loadChapterYearTxnsLocal(
  ctx: QueryCtx,
  chapterId: Id<"chapters"> | typeof CENTRAL,
  year: number,
): Promise<Doc<"transactions">[]> {
  const startUtc = Date.UTC(year, 0, 1) - DAY_MS;
  const endUtc = Date.UTC(year + 1, 0, 1) + DAY_MS;
  const rows = await ctx.db
    .query("transactions")
    .withIndex("by_chapter_and_postedAt", (q) =>
      q.eq("chapterId", chapterId).gte("postedAt", startUtc).lt("postedAt", endUtc),
    )
    .take(ROLLUP_SCAN_LIMIT);
  if (rows.length === ROLLUP_SCAN_LIMIT) {
    console.warn(
      `[dashboardDrill] loadChapterYearTxnsLocal hit ROLLUP_SCAN_LIMIT (${ROLLUP_SCAN_LIMIT}) for ${chapterId} ${year}; result truncated.`,
    );
  }
  return rows;
}

/** Duplicate of `finances.ts#resolveBudgetRef` (unexported), narrowed to just
 *  the display NAME (this file's callers don't need `dateLabel`/`refDate`):
 *  a one-time budget's LIVE linked event/project name, else the budget's own
 *  stored `label`/type-word fallback (mirrors `budgetDisplayName`). */
async function resolveBudgetNameLocal(
  ctx: QueryCtx,
  b: Doc<"budgets">,
): Promise<string> {
  const refKind: BudgetRefKind | null =
    b.refKind ?? (b.scope === "event" ? "event" : b.scope === "project" ? "project" : null);
  if (refKind === "event" && b.scopeRefId) {
    const ev = await ctx.db.get(b.scopeRefId as Id<"events">);
    if (ev) return ev.name;
  } else if (refKind === "project" && b.scopeRefId) {
    const pr = await ctx.db.get(b.scopeRefId as Id<"projects">);
    if (pr) return pr.name;
  }
  const type: BudgetType =
    b.type ?? (b.scope === "event" || b.scope === "project" ? "one_time" : "recurring");
  return b.label?.trim() || BUDGET_TYPE_LABELS[type];
}

// ── (a) Budgets awaiting approval, org-wide ──────────────────────────────────

const pendingBudgetApprovalRow = v.object({
  budgetId: v.id("budgets"),
  name: v.string(),
  chapterId: v.union(v.id("chapters"), v.literal(CENTRAL)),
  chapterName: v.string(),
  amountCents: v.number(),
  submittedAt: v.union(v.number(), v.null()),
});

/**
 * Every budget sitting `"submitted"` right now, across central + every
 * chapter — the same set `dashboardCentral`'s `pendingBudgetApprovalsCount`
 * counts (same index, same status literal, year-agnostic), so this
 * drilldown's row count always equals that banner's number. Sorted
 * oldest-submitted-first (FIFO triage order).
 */
export const pendingBudgetApprovals = query({
  args: {},
  returns: v.array(pendingBudgetApprovalRow),
  handler: async (ctx) => {
    const home = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireFinanceCentral(ctx, home);

    const chapters = await ctx.db.query("chapters").take(ROLLUP_SCAN_LIMIT);
    const chapterNameById = new Map(chapters.map((c) => [c._id, c.name] as const));

    const centralPending = await ctx.db
      .query("budgets")
      .withIndex("by_chapter_and_approval_status", (q) =>
        q.eq("chapterId", CENTRAL).eq("approvalStatus", "submitted"),
      )
      .take(ROLLUP_SCAN_LIMIT);

    const allPending: Doc<"budgets">[] = [...centralPending];
    for (const chapter of chapters) {
      const chapterPending = await ctx.db
        .query("budgets")
        .withIndex("by_chapter_and_approval_status", (q) =>
          q.eq("chapterId", chapter._id).eq("approvalStatus", "submitted"),
        )
        .take(ROLLUP_SCAN_LIMIT);
      allPending.push(...chapterPending);
    }

    const rows = await Promise.all(
      allPending.map(async (b) => ({
        budgetId: b._id,
        name: await resolveBudgetNameLocal(ctx, b),
        chapterId: b.chapterId,
        chapterName:
          b.chapterId === CENTRAL ? "Central" : chapterNameById.get(b.chapterId) ?? "Unknown chapter",
        amountCents: b.amountCents,
        submittedAt: b.submittedAt ?? null,
      })),
    );

    rows.sort((a, b) => (a.submittedAt ?? 0) - (b.submittedAt ?? 0));
    return rows;
  },
});

// ── (b) Org-wide unattributed spend, drilled down ────────────────────────────

const UNATTRIBUTED_ROW_CAP = 200;

const unattributedTxnRow = v.object({
  id: v.id("transactions"),
  date: v.string(),
  description: v.union(v.string(), v.null()),
  merchantName: v.union(v.string(), v.null()),
  amountCents: v.number(),
  chapterId: v.union(v.id("chapters"), v.literal(CENTRAL)),
  chapterName: v.string(),
});

/**
 * Every spend transaction (outflow, non-transfer, non-excluded/personal —
 * `isSpend`) with no `budgetId` link, in the given dashboard period, across
 * every chapter AND central itself. This is the row-level detail behind
 * `dashboardCentral.orgUnattributedCents`, which sums BOTH components
 * (per-chapter unattributed spend + central-owned unattributed spend) — so
 * this drilldown includes central-owned rows too, or its displayed total
 * wouldn't reconcile with the banner it backs.
 *
 * Bounded at `UNATTRIBUTED_ROW_CAP` rows (newest-first); `totalCount` is the
 * full matched-row count before the cap, so the UI can show "N of M."
 */
export const orgUnattributedTransactions = query({
  args: {
    year: v.optional(v.number()),
    month: v.optional(v.number()),
    period: v.optional(v.union(v.literal("month"), v.literal("ytd"))),
  },
  returns: v.object({
    rows: v.array(unattributedTxnRow),
    totalCount: v.number(),
  }),
  handler: async (ctx, args) => {
    const home = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireFinanceCentral(ctx, home);

    const now = easternParts(Date.now());
    const year = args.year ?? now.year;
    const month = args.month ?? now.month;
    const ytd = (args.period ?? "month") === "ytd";
    const dp: DashPeriodLocal = { year, month, ytd };
    const sandboxMode = await readSandbox(ctx);

    const chapters = await ctx.db.query("chapters").take(ROLLUP_SCAN_LIMIT);
    const chapterNameById = new Map(chapters.map((c) => [c._id, c.name] as const));

    type MatchedTxn = {
      id: Id<"transactions">;
      postedAt: number;
      description: string | null;
      merchantName: string | null;
      amountCents: number;
      chapterId: Id<"chapters"> | typeof CENTRAL;
      chapterName: string;
    };
    const matched: MatchedTxn[] = [];

    const scopes: Array<Id<"chapters"> | typeof CENTRAL> = [
      CENTRAL,
      ...chapters.map((c) => c._id),
    ];
    for (const scope of scopes) {
      const txns = await loadChapterYearTxnsLocal(ctx, scope, year);
      for (const tr of txns) {
        if (!isSpend(tr) || tr.budgetId != null) continue;
        if (!inDashRangeLocal(tr.postedAt, dp)) continue;
        if (!txnMatchesMode(tr, sandboxMode)) continue;
        matched.push({
          id: tr._id,
          postedAt: tr.postedAt,
          description: tr.description ?? null,
          merchantName: tr.merchantName ?? null,
          amountCents: tr.amountCents,
          chapterId: scope,
          chapterName: scope === CENTRAL ? "Central" : chapterNameById.get(scope) ?? "Unknown chapter",
        });
      }
    }

    matched.sort((a, b) => b.postedAt - a.postedAt);
    const totalCount = matched.length;
    const rows = matched.slice(0, UNATTRIBUTED_ROW_CAP).map((m) => ({
      id: m.id,
      date: easternDateStrLocal(m.postedAt),
      description: m.description,
      merchantName: m.merchantName,
      amountCents: m.amountCents,
      chapterId: m.chapterId,
      chapterName: m.chapterName,
    }));

    return { rows, totalCount };
  },
});
