/**
 * DASHBOARD CHART QUERIES (DASH-1) — backend for the chart-led dashboard
 * redesign: a spend-by-month bar chart (which doubles as the page's period
 * filter, with per-chapter sparklines) and a "Chapters at a glance" fleet
 * panel.
 *
 * Lives in its own file, mirroring `dashboardDrill.ts`'s precedent: this PR's
 * ownership is scoped to a NEW file only, and `finances.ts` must not be
 * touched. A handful of small helpers below are DELIBERATE, COMMENTED
 * duplicates of unexported `finances.ts` helpers (`loadPeriodTxns` →
 * `loadYearTxnsLocal`, `inDashRange` → `inYtdRangeLocal`,
 * `monthEquivalentBudgetCents`/`monthEquivForDash`/`budgetAllocationForDash`
 * → the `*Local` variants below, `sumSpend` → `sumSpendLocal`) — they can't be
 * imported because `finances.ts` doesn't export them, and this file must not
 * modify that one. Where possible they're built from EXPORTED primitives
 * (`isSpend`, `txnMatchesMode`, `effectiveCapCents`, `effectiveType`,
 * `ROLLUP_SCAN_LIMIT`) instead of re-deriving semantics; where a formula has
 * to be copied wholesale, the comment says so and `dashboardCharts.test.ts`
 * carries a PARITY test against the real `dashboardCentral`/`dashboardChapter`/
 * `dashboardDrill.pendingBudgetApprovals` numbers for the same fixture — the
 * PR #231 lesson (drill-down numbers MUST agree with the banners they sit
 * next to). If `finances.ts` ever exports the originals, delete these
 * duplicates in favor of them.
 *
 * Both queries are read-only and change no money invariant.
 */
import { ConvexError, v } from "convex/values";
import { query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import {
  CENTRAL,
  easternParts,
  quarterOfMonth,
  chapterAffordability as chapterAffordabilityCalc,
} from "@events-os/shared";
import { getChapterIdOrNull, requireChapterId } from "./lib/context";
import { requireFinanceRole, requireFinanceCentral } from "./lib/finance";
import { readSandbox } from "./financeSettings";
import {
  isSpend,
  txnMatchesMode,
  effectiveCapCents,
  effectiveType,
  ROLLUP_SCAN_LIMIT,
} from "./finances";

const DAY_MS = 24 * 60 * 60 * 1000;

// ── Local duplicates of unexported finances.ts helpers (see module doc) ──────

/**
 * Duplicate of `finances.ts`'s private `loadPeriodTxns` (unexported),
 * narrowed to a whole-year read (no `month` arg) — the same shape as
 * `dashboardDrill.ts`'s own documented duplicate (`loadChapterYearTxnsLocal`),
 * EXCEPT this one also applies `txnMatchesMode` (exported) internally,
 * matching the ORIGINAL `loadPeriodTxns`'s own internal filter exactly
 * (`dashboardDrill.ts`'s copy instead defers that filter to its callers).
 * Bounded at `ROLLUP_SCAN_LIMIT`, same non-silent truncation warning as the
 * original.
 */
async function loadYearTxnsLocal(
  ctx: QueryCtx,
  scope: Id<"chapters"> | typeof CENTRAL,
  year: number,
  sandboxMode: boolean,
): Promise<Doc<"transactions">[]> {
  const startUtc = Date.UTC(year, 0, 1) - DAY_MS;
  const endUtc = Date.UTC(year + 1, 0, 1) + DAY_MS;
  const rows = await ctx.db
    .query("transactions")
    .withIndex("by_chapter_and_postedAt", (q) =>
      q.eq("chapterId", scope).gte("postedAt", startUtc).lt("postedAt", endUtc),
    )
    .take(ROLLUP_SCAN_LIMIT);
  if (rows.length === ROLLUP_SCAN_LIMIT) {
    console.warn(
      `[dashboardCharts] loadYearTxnsLocal hit ROLLUP_SCAN_LIMIT (${ROLLUP_SCAN_LIMIT}) for ${scope} ${year}; result truncated.`,
    );
  }
  return rows.filter((tr) => txnMatchesMode(tr, sandboxMode));
}

/**
 * Duplicate of `finances.ts`'s private `inDashRange` (unexported), narrowed
 * to the YTD case only — every consumer in this file views YTD-through-the-
 * current-month, never a single month. True iff a timestamp's Eastern
 * (year, month) falls in Jan..throughMonth of `year`.
 */
function inYtdRangeLocal(postedAt: number, year: number, throughMonth: number): boolean {
  const p = easternParts(postedAt);
  return p.year === year && p.month >= 1 && p.month <= throughMonth;
}

/** Mirrors `finances.ts`'s private `sumSpend` (unexported) — trivially
 *  derived from the EXPORTED `isSpend`, so no separate parity test is
 *  warranted for this one. */
function sumSpendLocal(txns: Doc<"transactions">[]): number {
  return txns.reduce((s, tr) => (isSpend(tr) ? s + tr.amountCents : s), 0);
}

/**
 * Per-calendar-month (Eastern) SPEND totals for a year's worth of already
 * mode-filtered transactions — the ONE bucketing function both `spendByMonth`
 * and `chapterHealth`'s `monthlySpendCents` sparkline use, so the two stay in
 * lockstep (a fleet-panel sparkline must read identically to the chart it
 * sits next to). A timestamp outside `year` is dropped (possible because
 * `loadYearTxnsLocal` pads its UTC window a day on each side) — mirrors
 * `inPeriod`'s own year check.
 */
function bucketSpendByMonth(txns: Doc<"transactions">[], year: number): number[] {
  const months = new Array(12).fill(0) as number[];
  for (const tr of txns) {
    if (!isSpend(tr)) continue;
    const p = easternParts(tr.postedAt);
    if (p.year !== year) continue;
    months[p.month - 1] += tr.amountCents;
  }
  return months;
}

/**
 * Duplicate of `finances.ts`'s private `monthEquivalentBudgetCents`
 * (unexported) — BYTE-EQUIVALENT to the original (finances.ts, "A budget's
 * allocation NORMALIZED to one month" doc comment), built only from the
 * EXPORTED `effectiveCapCents` + `quarterOfMonth` (from `@events-os/shared`)
 * so `chapterHealth`'s by-chapter rollup total matches `dashboardCentral`'s
 * own by-chapter rollup exactly — see the parity test in
 * `dashboardCharts.test.ts`.
 */
function monthEquivalentBudgetCentsLocal(
  b: Doc<"budgets">,
  year: number,
  month: number,
): number {
  if (b.year !== year) return 0;
  if (b.quarter != null && quarterOfMonth(month) !== b.quarter) return 0;
  const capCents = effectiveCapCents(b);
  switch (b.cadence) {
    case "monthly":
      if (b.month != null && b.month !== month) return 0;
      return capCents;
    case "quarterly":
      return Math.round(capCents / 3);
    case "yearly":
      return Math.round(capCents / 12);
    case "per_instance":
    case "one_off":
    default:
      if (b.month != null && b.month !== month) return 0;
      return capCents;
  }
}

/**
 * Duplicate of `finances.ts`'s private `monthEquivForDash` (unexported),
 * narrowed to the YTD case only: sums `monthEquivalentBudgetCentsLocal`
 * across months 1..throughMonth. Applied uniformly to EVERY budget of a
 * chapter (one_time included) — mirrors `dashboardCentral`'s own by-chapter
 * rollup, which reduces `chBudgets` with `monthEquivForDash` regardless of
 * `effectiveType`, unlike the central-budget CARD computation below (which
 * treats one_time specially).
 */
function monthEquivForDashYtdLocal(
  b: Doc<"budgets">,
  year: number,
  throughMonth: number,
): number {
  let sum = 0;
  for (let m = 1; m <= throughMonth; m++) {
    sum += monthEquivalentBudgetCentsLocal(b, year, m);
  }
  return sum;
}

// ── (a) spendByMonth — the chart + period filter ─────────────────────────────

const monthSpendRow = v.object({
  month: v.number(),
  spendCents: v.number(),
});

/**
 * Per-calendar-month spend for a scope, across a whole year — powers the bar
 * chart that doubles as the dashboard's period filter, with per-chapter
 * sparklines.
 *
 * Scope semantics (deliberately distinct definitions per scope, each chosen
 * so it reconciles with an existing dashboard total):
 *  - a chapter id → that chapter's FULL spend (every txn it owns, including
 *    spend explicitly linked to a central budget) — the same figure
 *    `dashboardChapter`'s own "Spent" tile reports (`sumSpend(periodTxns)`,
 *    no central-link partition), so a chapter's own chart reconciles with
 *    its own dashboard banner.
 *  - `"central"` → CENTRAL-OWNED spend only (`chapterId === "central"` txns),
 *    NOT `dashboardCentral`'s broader "Central row" (which also folds in
 *    chapter spend linked to a central budget) — this scope answers "what did
 *    central itself spend," a narrower and more useful number for a chart.
 *  - `"org"` → every chapter's full spend + central-owned spend, summed —
 *    exactly `dashboardCentral`'s `totalMonthSpendCents` for the matching
 *    period (see the parity test), since a chapter's full spend already
 *    includes its central-linked portion exactly once.
 *
 * Gates mirror `dashboardChapter`'s own drill-down pattern exactly
 * (finances.ts's `dashboardChapter`, chapterId gate): the caller's own
 * chapter needs only the viewer role there; `"org"`, `"central"`, or any
 * OTHER chapter needs the caller's own central (org-wide) reach.
 */
export const spendByMonth = query({
  args: {
    scope: v.union(v.id("chapters"), v.literal(CENTRAL), v.literal("org")),
    year: v.number(),
  },
  returns: v.object({
    months: v.array(monthSpendRow),
    // The current month number, when `year` is the current year (the client
    // draws that bar hollow — an in-progress month, not a completed one).
    // `null` for any other year.
    partialMonth: v.union(v.number(), v.null()),
  }),
  handler: async (ctx, args) => {
    const ownChapterId = (await getChapterIdOrNull(ctx)) as Id<"chapters"> | null;
    const sandboxMode = await readSandbox(ctx);
    const now = easternParts(Date.now());
    const partialMonth = args.year === now.year ? now.month : null;

    if (args.scope === "org") {
      if (!ownChapterId) {
        throw new ConvexError({
          code: "NO_CHAPTER",
          message: "You don't belong to a chapter yet.",
        });
      }
      await requireFinanceCentral(ctx, ownChapterId);

      const chapters = await ctx.db.query("chapters").take(ROLLUP_SCAN_LIMIT);
      const months = new Array(12).fill(0) as number[];
      for (const chapter of chapters) {
        const txns = await loadYearTxnsLocal(ctx, chapter._id, args.year, sandboxMode);
        const chMonths = bucketSpendByMonth(txns, args.year);
        for (let i = 0; i < 12; i++) months[i] += chMonths[i];
      }
      const centralTxns = await loadYearTxnsLocal(ctx, CENTRAL, args.year, sandboxMode);
      const centralMonths = bucketSpendByMonth(centralTxns, args.year);
      for (let i = 0; i < 12; i++) months[i] += centralMonths[i];

      return {
        months: months.map((spendCents, i) => ({ month: i + 1, spendCents })),
        partialMonth,
      };
    }

    const scope = args.scope; // Id<"chapters"> | typeof CENTRAL
    // `scope !== ownChapterId` alone covers BOTH "central" (never equal to a
    // real chapter id) and "a different chapter than the caller's own" — the
    // exact same drill-down gate `dashboardChapter` applies (see module doc).
    if (scope !== ownChapterId) {
      if (!ownChapterId) {
        throw new ConvexError({
          code: "NO_CHAPTER",
          message: "You don't belong to a chapter yet.",
        });
      }
      await requireFinanceCentral(ctx, ownChapterId);
    } else {
      // `scope === ownChapterId` here, so it's necessarily a real chapter id
      // (never `"central"`, which never equals a real `Id<"chapters">`).
      await requireFinanceRole(ctx, scope as Id<"chapters">, "viewer");
    }

    const txns = await loadYearTxnsLocal(ctx, scope, args.year, sandboxMode);
    const months = bucketSpendByMonth(txns, args.year);
    return {
      months: months.map((spendCents, i) => ({ month: i + 1, spendCents })),
      partialMonth,
    };
  },
});

// ── (b) chapterHealth — the "Chapters at a glance" fleet panel ───────────────

const chapterHealthRow = v.object({
  chapterId: v.union(v.id("chapters"), v.literal(CENTRAL)),
  name: v.string(),
  // Manual-entry backer count (schema/chapters.ts: "Absent/0 = not yet set").
  // `null` — along with `tierLabel`/`underWaterCents` — until a chapter has
  // actually configured a nonzero backer count; central never has one.
  backers: v.union(v.number(), v.null()),
  tierLabel: v.union(v.string(), v.null()),
  // Positive = under water (spend commitments exceed backer revenue after the
  // operating floor + central skim); `null` when affordability isn't
  // configured. Never negative — a chapter comfortably in the black reports 0.
  underWaterCents: v.union(v.number(), v.null()),
  spendYtdCents: v.number(),
  budgetYtdCents: v.number(),
  unattributedCents: v.number(),
  unattributedCount: v.number(),
  toReviewCount: v.number(),
  pendingApprovalsCount: v.number(),
  // Current-year spend, one entry per calendar month (index 0 = January) —
  // the fleet row's sparkline. Same bucketing `spendByMonth` uses.
  monthlySpendCents: v.array(v.number()),
});

/**
 * One row per real chapter, PLUS a "Central" row — the org-wide "Chapters at
 * a glance" fleet panel. Central-gated (`requireFinanceCentral`), same as
 * `dashboardCentral`/`dashboardDrill`'s queries.
 *
 * Always views the current year, YTD-through-the-current-month (mirrors
 * calling `dashboardCentral({ period: "ytd" })` with default year/month) — a
 * fleet snapshot has no independent period selector; the chart's own period
 * filter (`spendByMonth`) drives drill-down elsewhere.
 *
 * Health VERDICT (e.g. "healthy" / "at risk" copy) stays entirely
 * CLIENT-side — this returns only the raw signals behind it.
 *
 * Numeric parity (see `dashboardCharts.test.ts`):
 *  - a chapter row's `spendYtdCents`/`budgetYtdCents` equal
 *    `dashboardCentral({ period: "ytd" }).chapterRollup`'s matching row
 *    (including the synthetic "Central" row).
 *  - `pendingApprovalsCount` equals `dashboardDrill.pendingBudgetApprovals`'s
 *    per-chapter/per-central submitted count.
 */
export const chapterHealth = query({
  args: {},
  returns: v.array(chapterHealthRow),
  handler: async (ctx) => {
    const home = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireFinanceCentral(ctx, home);

    const sandboxMode = await readSandbox(ctx);
    const now = easternParts(Date.now());
    const year = now.year;
    const throughMonth = now.month;

    const chapters = await ctx.db.query("chapters").take(ROLLUP_SCAN_LIMIT);

    // Central budgets for THIS year — needed to partition each chapter's
    // central-linked spend OUT of its own row, exactly mirroring
    // `dashboardCentral`'s `centralBudgetIds` partition.
    const centralBudgetDocs = await ctx.db
      .query("budgets")
      .withIndex("by_chapter_and_period", (q) =>
        q.eq("chapterId", CENTRAL).eq("year", year),
      )
      .take(ROLLUP_SCAN_LIMIT);
    const centralBudgetIds = new Set(centralBudgetDocs.map((b) => b._id));

    const rows: (typeof chapterHealthRow.type)[] = [];
    let chapterLinkedToCentralCents = 0;

    for (const chapter of chapters) {
      // ONE indexed range scan for the whole year, per chapter — reused for
      // BOTH the YTD partition below and the sparkline bucketing (no second
      // txn scan for this chapter).
      const yearTxns = await loadYearTxnsLocal(ctx, chapter._id, year, sandboxMode);
      const dashTxns = yearTxns.filter((tr) => inYtdRangeLocal(tr.postedAt, year, throughMonth));

      const chapterPeriodSpend = sumSpendLocal(dashTxns);
      const linkedToCentralThisChapter = dashTxns.reduce(
        (s, tr) =>
          isSpend(tr) && tr.budgetId != null && centralBudgetIds.has(tr.budgetId)
            ? s + tr.amountCents
            : s,
        0,
      );
      chapterLinkedToCentralCents += linkedToCentralThisChapter;
      const spendYtdCents = chapterPeriodSpend - linkedToCentralThisChapter;

      // Same predicate + period scope as `dashboardChapter.unattributedCents`.
      let unattributedCents = 0;
      let unattributedCount = 0;
      for (const tr of dashTxns) {
        if (isSpend(tr) && tr.budgetId == null) {
          unattributedCents += tr.amountCents;
          unattributedCount += 1;
        }
      }

      const chBudgets = await ctx.db
        .query("budgets")
        .withIndex("by_chapter_and_period", (q) =>
          q.eq("chapterId", chapter._id).eq("year", year),
        )
        .take(ROLLUP_SCAN_LIMIT);
      const budgetYtdCents = chBudgets.reduce(
        (s, b) => s + monthEquivForDashYtdLocal(b, year, throughMonth),
        0,
      );

      // Same "to review" definition as `dashboardChapter`'s tile / the
      // `dashboardCentral` `toReviewOrg` per-chapter component.
      const unreviewed = await ctx.db
        .query("transactions")
        .withIndex("by_chapter_and_status", (q) =>
          q.eq("chapterId", chapter._id).eq("status", "unreviewed"),
        )
        .take(ROLLUP_SCAN_LIMIT);

      // Same index/status literal as `dashboardDrill.pendingBudgetApprovals`'s
      // per-chapter component and `dashboardCentral`'s own seed — see the
      // parity test.
      const chapterPendingBudgets = await ctx.db
        .query("budgets")
        .withIndex("by_chapter_and_approval_status", (q) =>
          q.eq("chapterId", chapter._id).eq("approvalStatus", "submitted"),
        )
        .take(ROLLUP_SCAN_LIMIT);

      // The EXACT `teammateCount` predicate `finances.chapterAffordability`
      // uses (see its own doc comment there) — reused here so backer-based
      // affordability numbers never drift between the chapter's own header
      // and this fleet row.
      const roster = await ctx.db
        .query("people")
        .withIndex("by_chapter", (q) => q.eq("chapterId", chapter._id))
        .take(ROLLUP_SCAN_LIMIT);
      const teammateCount = roster.filter(
        (p) =>
          p.isSamplePerson !== true &&
          p.isPlaceholder !== true &&
          (p.isTeamMember === true || p.userId != null),
      ).length;

      // "Absent/0 = not yet set" — schema/chapters.ts's own doc comment on
      // `backerCount`. Affordability isn't configured until a real (nonzero)
      // count is entered, so every affordability-derived field stays null,
      // matching `finances.chapterAffordability`'s own "gentle prompt" case.
      const rawBackerCount = chapter.backerCount ?? 0;
      let backers: number | null = null;
      let tierLabel: string | null = null;
      let underWaterCents: number | null = null;
      if (rawBackerCount > 0) {
        backers = rawBackerCount;
        // `chapterAffordability` (`@events-os/shared`) — the SAME pure
        // computation `finances.chapterAffordability` calls, so this fleet
        // row's tier/under-water numbers can never drift from the chapter's
        // own affordability header.
        const computed = chapterAffordabilityCalc(rawBackerCount, teammateCount);
        tierLabel = computed.tierLabel;
        underWaterCents = Math.max(0, -computed.discretionaryCents);
      }

      rows.push({
        chapterId: chapter._id,
        name: chapter.name,
        backers,
        tierLabel,
        underWaterCents,
        spendYtdCents,
        budgetYtdCents,
        unattributedCents,
        unattributedCount,
        toReviewCount: unreviewed.length,
        pendingApprovalsCount: chapterPendingBudgets.length,
        monthlySpendCents: bucketSpendByMonth(yearTxns, year),
      });
    }

    // ── Central row ──────────────────────────────────────────────────────────
    const centralOwnedYearTxns = await loadYearTxnsLocal(ctx, CENTRAL, year, sandboxMode);
    const centralOwnedDashTxns = centralOwnedYearTxns.filter((tr) =>
      inYtdRangeLocal(tr.postedAt, year, throughMonth),
    );
    const centralOwnedSpendCents = sumSpendLocal(centralOwnedDashTxns);

    let centralUnattributedCents = 0;
    let centralUnattributedCount = 0;
    for (const tr of centralOwnedDashTxns) {
      if (isSpend(tr) && tr.budgetId == null) {
        centralUnattributedCents += tr.amountCents;
        centralUnattributedCount += 1;
      }
    }

    // Central budget CARDS' own allocation total — mirrors
    // `dashboardCentral`'s `centralBudgets[].budgetCents` sum
    // (its `centralRowBudgetCents`) exactly: a one_time central budget
    // contributes its full effective cap (never month-scaled) UNLESS it's a
    // zero-cap/zero-spend straggler (excluded, same as the dashboard card's
    // own visibility guard); a recurring one contributes its YTD
    // month-equivalent allocation, unconditionally — see
    // `monthEquivForDashYtdLocal`'s doc comment for why this differs from the
    // by-chapter rollup's uniform treatment above.
    let centralBudgetYtdCents = 0;
    for (const cb of centralBudgetDocs) {
      const linked = await ctx.db
        .query("transactions")
        .withIndex("by_budget", (q) => q.eq("budgetId", cb._id))
        .take(ROLLUP_SCAN_LIMIT);
      const modeMatched = linked.filter((tr) => txnMatchesMode(tr, sandboxMode));
      if (effectiveType(cb) === "one_time") {
        const capCents = effectiveCapCents(cb);
        const cardSpentCents = sumSpendLocal(modeMatched);
        if (capCents === 0 && cardSpentCents === 0) continue;
        centralBudgetYtdCents += capCents;
      } else {
        centralBudgetYtdCents += monthEquivForDashYtdLocal(cb, year, throughMonth);
      }
    }

    const centralUnreviewed = await ctx.db
      .query("transactions")
      .withIndex("by_chapter_and_status", (q) =>
        q.eq("chapterId", CENTRAL).eq("status", "unreviewed"),
      )
      .take(ROLLUP_SCAN_LIMIT);
    const centralPendingBudgets = await ctx.db
      .query("budgets")
      .withIndex("by_chapter_and_approval_status", (q) =>
        q.eq("chapterId", CENTRAL).eq("approvalStatus", "submitted"),
      )
      .take(ROLLUP_SCAN_LIMIT);

    rows.unshift({
      chapterId: CENTRAL,
      name: "Central",
      backers: null,
      tierLabel: null,
      underWaterCents: null,
      spendYtdCents: centralOwnedSpendCents + chapterLinkedToCentralCents,
      budgetYtdCents: centralBudgetYtdCents,
      unattributedCents: centralUnattributedCents,
      unattributedCount: centralUnattributedCount,
      toReviewCount: centralUnreviewed.length,
      pendingApprovalsCount: centralPendingBudgets.length,
      monthlySpendCents: bucketSpendByMonth(centralOwnedYearTxns, year),
    });

    return rows;
  },
});
