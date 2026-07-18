/**
 * DASH-3 "Command center" — the central perspective of the finance
 * dashboard, redesigned to match DASH-2's chapter command-center pattern
 * (owner-approved mockup, top to bottom):
 *  1. a page-header period picker (unchanged — lives in `finances/index.tsx`)
 *     with "+ New budget" now IN that same header row, not mid-page;
 *  2. a 4-tile KPI band (Spent·YTD with an org-wide sparkline, the existing
 *     top-tag tile unchanged, "To review N ›" styled as a link, City Launch
 *     Fund — the old standalone "Active chapters" tile retires; its number
 *     still lives in the Spent tile's own meta line);
 *  3. a two-column grid — LEFT: the org-wide spend-by-month bar chart
 *     (clicking a bar IS the page's period filter, the SAME wiring pattern
 *     `ChapterView`/DASH-2 uses) + ONE dense budgets table (central budgets,
 *     then chapter rollup rows, then tag rollup rows — replacing the old
 *     CENTRAL BUDGETS / BY TAG / BY CHAPTER card sections); RIGHT: a
 *     restyled attention rail (pending approvals, org-wide unattributed,
 *     inter-chapter balances, a quiet City Launch Fund row) + a "Where it
 *     went" org-wide panel;
 *  4. "Chapters at a glance" — `ChapterFleet`, full-width below the grid.
 *
 * Figures come from `api.finances.dashboardCentral` (the bulk of the view),
 * `api.dashboardCharts.spendByMonth({scope:"org"})` (the bar chart + KPI
 * sparkline), `api.dashboardCharts.chapterHealth` (the fleet panel),
 * `api.dashboardDrill.*` (the two drilldown lists), and `api.transfers.*`
 * (inter-chapter balances) — this view stays pure presentation over those
 * contracts, plus a few CLIENT-SIDE derivations documented in
 * `fleetHealth.ts` / `compactCents.ts` / `tagRollupCategoryBars.ts` (this
 * PR's ownership excludes adding new Convex queries — see
 * `tagRollupCategoryBars`'s doc comment for the one deliberate substitution
 * that follows from that: there's no org-wide spend-CATEGORY breakdown
 * anywhere in the backend, so "Where it went" reuses the org-wide TAG
 * rollup `dashboardCentral` already returns instead).
 */
import { useMemo, useState } from "react";
import { Pressable, Text, useWindowDimensions, View } from "react-native";
import { useQuery } from "convex/react";
import { useRouter, type Router } from "expo-router";
import type { FunctionReturnType } from "convex/server";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { BUDGET_CADENCE_LABELS, CENTRAL, formatCents } from "@events-os/shared";
import { Icon, SectionHeader } from "../../ui";
import { colors } from "../../../lib/theme";
import { Money, Tile, TileRow, type DashPeriodMode } from "./parts";
import { SparkLine } from "./SparkLine";
import { MonthBars } from "./MonthBars";
import { CategoryBars } from "./CategoryBars";
import { RailRow } from "./AttentionRail";
import { BudgetTableGroup, type BudgetTableRow } from "./BudgetTable";
import { BudgetApprovalActions } from "./BudgetApprovalActions";
import { TagDetailModal, type TagRollup } from "./TagRollup";
import { ChapterFleet } from "./ChapterFleet";
import { tagRollupCategoryBars } from "./tagRollupCategoryBars";

type CentralDash = FunctionReturnType<typeof api.finances.dashboardCentral>;
type ChapterRollup = CentralDash["chapterRollup"][number];
type MonthlySpend = FunctionReturnType<typeof api.dashboardCharts.spendByMonth>;
type ChapterHealthRows = FunctionReturnType<typeof api.dashboardCharts.chapterHealth>;

/** Below this width the two-column grid stacks to one column — same
 *  breakpoint DASH-2's `ChapterView` uses. */
const STACK_WIDTH = 900;

export function CentralView({
  data,
  monthly,
  chapterHealth,
  year,
  month,
  period,
  onViewChapter,
  onEditBudget,
  onChangePeriod,
  onRecordTransfer,
  onSettle,
}: {
  data: CentralDash;
  /** `api.dashboardCharts.spendByMonth({scope:"org", year})` — the bar chart
   *  + KPI sparkline. `undefined` while loading (its own query; both render
   *  nothing/an empty year until it resolves). */
  monthly: MonthlySpend | undefined;
  /** `api.dashboardCharts.chapterHealth` — the "Chapters at a glance" fleet
   *  panel. `undefined` while loading; the panel renders nothing until then. */
  chapterHealth: ChapterHealthRows | undefined;
  /** The dashboard's currently-selected year/(through-)month/mode. */
  year: number;
  month: number;
  period: DashPeriodMode;
  /** Drill into one chapter's chapter-perspective dashboard (peek — the
   *  backend re-checks central reach via `dashboardChapter({chapterId})`). */
  onViewChapter: (chapterId: Id<"chapters">, chapterName: string) => void;
  /** Open `BudgetCreateModal` on an existing central budget for editing. */
  onEditBudget: (budgetId: string) => void;
  /** Clicking a spend-by-month bar sets the SAME period state the page's
   *  ‹ › picker uses — one state, no second control (mirrors `ChapterView`). */
  onChangePeriod: (next: { year: number; month: number; period: DashPeriodMode }) => void;
  /** Open `TransferRecordModal` (record/initiate a skim in or a grant out). */
  onRecordTransfer: () => void;
  /** Open `TransferRecordModal` PRESET to a settlement for this chapter. */
  onSettle: (chapterId: Id<"chapters">, chapterName: string, netCents: number) => void;
}) {
  const router = useRouter();
  const { width } = useWindowDimensions();
  const stacked = width < STACK_WIDTH;

  const selectedMonth = period === "month" ? month : null;
  function handleSelectMonth(m: number) {
    if (period === "month" && month === m) {
      onChangePeriod({ year, month, period: "ytd" });
    } else {
      onChangePeriod({ year, month: m, period: "month" });
    }
  }

  const emptyMonths = useMemo(
    () => Array.from({ length: 12 }, (_, i) => ({ month: i + 1, spendCents: 0 })),
    [],
  );

  // The "By chapter" rollup's Central row (chapterId === CENTRAL) is
  // redundant with the individual central-budget rows already in the dense
  // table below — unlike the old card layout, it isn't rendered separately.
  const chapterRows = data.chapterRollup.filter(
    (c): c is ChapterRollup & { chapterId: Id<"chapters"> } => c.chapterId !== CENTRAL,
  );

  // The tag-detail sheet's open/selected tag — CONTROLLED here so its
  // `tagDrilldown` query only runs while the sheet is actually open.
  const [selectedTag, setSelectedTag] = useState<TagRollup | null>(null);

  const centralBudgetRows: BudgetTableRow[] = useMemo(
    () =>
      data.centralBudgets.map((b) => ({
        id: b.id,
        name: b.name,
        meta: b.dateLabel ?? BUDGET_CADENCE_LABELS[b.cadence],
        spentCents: b.spentCents,
        budgetCents: b.budgetCents,
        pct: b.pct,
        approvalStatus: b.approvalStatus,
        approvedCents: b.approvedCents,
        requestedCents: b.requestedCents,
        reviewNote: b.reviewNote,
      })),
    [data.centralBudgets],
  );

  const chapterRollupRows: BudgetTableRow[] = useMemo(
    () =>
      chapterRows.map((c) => ({
        id: fakeRowId(`chapter:${c.chapterId}`),
        name: c.chapterName,
        meta: null,
        spentCents: c.spentCents,
        budgetCents: c.budgetCents,
        // `barPct` (clamped 0-100) — `chapterRollupRow` has no raw uncapped
        // pct like `centralBudgetCard`/`tagRollupRow` do, so a chapter
        // over 100% never trips the dense row's ">100% Over" chip. Accepted:
        // the meter/dot still reads red past 100 via `status`-independent
        // `meterTone`, this only affects the rare exact-over-cap OverChip.
        pct: c.barPct,
        approvalStatus: "approved",
        approvedCents: null,
        requestedCents: 0,
        reviewNote: null,
        chip: "chapter",
        disableRowPress: true,
        onChevronPress: () => onViewChapter(c.chapterId, c.chapterName),
      })),
    [chapterRows, onViewChapter],
  );

  const tagRollupTableRows: BudgetTableRow[] = useMemo(
    () =>
      data.tagRollups.map((r, i) => ({
        id: fakeRowId(`tag:${r.tagName}:${i}`),
        name: r.tagName,
        meta: null,
        spentCents: r.spentCents,
        budgetCents: r.budgetCents,
        pct: r.pct,
        approvalStatus: "approved",
        approvedCents: null,
        requestedCents: 0,
        reviewNote: null,
        chip: "tag",
        disableRowPress: true,
        onChevronPress: () => setSelectedTag(r),
      })),
    [data.tagRollups],
  );

  const tableRows: BudgetTableRow[] = [
    ...centralBudgetRows,
    ...chapterRollupRows,
    ...tagRollupTableRows,
  ];

  const spentTile = data.tiles.find((t) => t.label.startsWith("Spent"));
  const reviewTile = data.tiles.find((t) => t.label === "To review · org");
  // The old "Active chapters" tile retires (its count still lives in the
  // Spent tile's own meta line, unchanged); everything else that isn't
  // Spent/To-review is the top-tag tile — kept as-is (see module doc).
  const otherTiles = data.tiles.filter(
    (t) => t !== spentTile && t !== reviewTile && t.label !== "Active chapters",
  );

  const orgCategoryRollup = useMemo(
    () => tagRollupCategoryBars(data.tagRollups, data.totalMonthSpendCents, period),
    [data.tagRollups, data.totalMonthSpendCents, period],
  );

  return (
    <View>
      {/* 1. KPI band */}
      <TileRow>
        {spentTile ? (
          <SpentTile label={spentTile.label} value={spentTile.value} meta={spentTile.meta} monthly={monthly} />
        ) : null}
        {otherTiles.map((t, i) => (
          <Tile key={i} label={t.label} value={t.value} meta={t.meta} />
        ))}
        {reviewTile ? (
          <ReviewLinkTile
            tile={reviewTile}
            onPress={() =>
              router.navigate("/finances/reconcile?scope=central&filter=needs_budget" as never)
            }
          />
        ) : null}
        <CityLaunchFundTile fund={data.cityLaunchFund} />
      </TileRow>

      {/* 2. Two-column grid — ~1.6fr/1fr, stacks under STACK_WIDTH. */}
      <View className={stacked ? "mt-2 gap-4" : "mt-2 flex-row gap-4"}>
        {/* LEFT */}
        <View style={stacked ? undefined : { flex: 1.6 }}>
          <SectionHeader title="Spend by month" />
          <View className="rounded-lg border border-border bg-raised p-4 shadow-card">
            <MonthBars
              months={monthly?.months ?? emptyMonths}
              partialMonth={monthly?.partialMonth ?? null}
              // Org level has no single operating cap to draw a reference
              // line against (unlike a chapter's own monthly cap) — no line.
              capCentsPerMonth={null}
              selectedMonth={selectedMonth}
              onSelectMonth={handleSelectMonth}
            />
          </View>

          <BudgetTableGroup
            title="Budgets"
            rows={tableRows}
            isDrilldown={false}
            foldAfter={20}
            emptyTitle="No budgets yet"
            emptyMessage="Create a central budget, or budget from a chapter, to see it here."
            onPressRow={onEditBudget}
          />
        </View>

        {/* RIGHT */}
        <View style={stacked ? undefined : { flex: 1 }} className="gap-4">
          <View>
            <SectionHeader title="Needs your attention" />
            <View className="gap-2">
              <PendingApprovalsRail
                count={data.pendingBudgetApprovalsCount}
                onViewChapter={onViewChapter}
              />
              <UnattributedRail
                cents={data.orgUnattributedCents}
                year={year}
                month={month}
                period={period}
                onViewChapter={onViewChapter}
              />
              <InterScopeBalancesRail year={year} month={month} onSettle={onSettle} />
              <CityLaunchFundRail fund={data.cityLaunchFund} onRecordTransfer={onRecordTransfer} />
            </View>
          </View>

          <View>
            <SectionHeader title="Where it went" />
            <View className="rounded-lg border border-border bg-raised p-4 shadow-card">
              <CategoryBars rollup={orgCategoryRollup} />
            </View>
          </View>
        </View>
      </View>

      {/* 3. Pre-launch readiness — the financial manager's launch-decision
          surface (dual-gated central finance viewer OR central giving.view;
          renders only when there are prospect/raising territories). */}
      <PrelaunchReadinessCard />

      {/* 4. Chapters at a glance — full-width, below the grid. */}
      {chapterHealth ? <ChapterFleet rows={chapterHealth} onViewChapter={onViewChapter} /> : null}

      {selectedTag ? (
        <TagDetailModal
          rollup={selectedTag}
          scope="central"
          year={year}
          month={month}
          period={period}
          onClose={() => setSelectedTag(null)}
        />
      ) : null}
    </View>
  );
}

// ── Pre-launch readiness ─────────────────────────────────────────────────────
type PrelaunchRow = FunctionReturnType<typeof api.territories.prelaunchReadiness>[number];

/** Days since a territory was created (for the "raising for N days" line). */
function ageDays(ageMs: number): number {
  return Math.max(0, Math.floor(ageMs / (24 * 60 * 60 * 1000)));
}

/**
 * "Pre-launch readiness" — one row per prospect/raising territory with the
 * numbers a financial manager weighs before launching: the launch pot (raised
 * vs the ~$8k grant target + what central would still cover), backers (live vs
 * goal), the active monthly pledge run-rate, the tier the chapter would start
 * at, and how long it's been raising. Dual-gated in the backend
 * (`prelaunchReadiness`); an empty result (no territories, or no access) simply
 * renders nothing.
 */
function PrelaunchReadinessCard() {
  const rows = useQuery(api.territories.prelaunchReadiness, {});
  if (!rows || rows.length === 0) return null;
  return (
    <View className="mt-4">
      <SectionHeader title="Pre-launch readiness" />
      <View className="rounded-lg border border-border bg-raised shadow-card">
        {rows.map((r, i) => (
          <PrelaunchReadinessRow key={r.territoryId} row={r} first={i === 0} />
        ))}
      </View>
    </View>
  );
}

function PrelaunchReadinessRow({ row, first }: { row: PrelaunchRow; first: boolean }) {
  const potPct =
    row.potTargetCents > 0
      ? Math.min(100, Math.round((row.potCents / row.potTargetCents) * 100))
      : 0;
  return (
    <View className={`p-4${first ? "" : " border-t border-border"}`}>
      <View className="flex-row items-center justify-between gap-2">
        <Text className="flex-1 text-sm font-semibold text-ink" numberOfLines={1}>
          {row.name}, {row.region}
        </Text>
        <Text className="text-2xs uppercase tracking-wider text-muted">
          {row.stage} · {ageDays(row.ageMs)}d
        </Text>
      </View>

      {/* Launch pot */}
      <View className="mt-2 flex-row items-center justify-between gap-2">
        <Text className="text-xs text-muted">Launch fund</Text>
        <Text className="text-xs font-semibold text-ink" style={{ fontVariant: ["tabular-nums"] }}>
          {formatCents(row.potCents)} of {formatCents(row.potTargetCents)}
        </Text>
      </View>
      <View className="mt-1 h-1.5 overflow-hidden rounded-pill bg-sunken">
        <View className="h-full rounded-pill bg-accent" style={{ width: `${potPct}%` }} />
      </View>

      {/* Numbers row */}
      <View className="mt-2 flex-row flex-wrap gap-x-4 gap-y-1">
        <ReadinessStat
          label="Central still covers"
          value={formatCents(row.remainingCentralBurdenCents)}
        />
        <ReadinessStat label="Backers" value={`${row.backerCount} / ${row.targetBackers}`} />
        <ReadinessStat label="Active monthly" value={formatCents(row.activeMonthlyCents)} />
        <ReadinessStat label="Starting tier" value={row.tierLabel} />
      </View>
    </View>
  );
}

function ReadinessStat({ label, value }: { label: string; value: string }) {
  return (
    <View>
      <Text className="text-2xs uppercase tracking-wider text-faint">{label}</Text>
      <Text className="text-xs font-semibold text-ink" style={{ fontVariant: ["tabular-nums"] }}>
        {value}
      </Text>
    </View>
  );
}

// A chapter/tag rollup row isn't a real budget, but `BudgetTableRow.id` is
// typed `Id<"budgets">` (a branded string) for every other row — widening
// that type would loosen it for every real budget row too. This documented
// cast is safe: every synthetic row also sets `disableRowPress: true` and an
// `approvalStatus` that's never `"submitted"`, so this id is only ever used
// as a React `key` — never passed to `onPressRow` or `BudgetApprovalActions`
// (mirrors the "Safe cast" precedent already in this file's predecessor).
function fakeRowId(key: string): Id<"budgets"> {
  return key as unknown as Id<"budgets">;
}

// ── KPI tile variants ────────────────────────────────────────────────────────
type CentralTile = CentralDash["tiles"][number];

/** The "Spent · …" tile with its own org-wide sparkline in the top-right
 *  corner — mirrors `ChapterView`'s own `SpentTile` (not exported from
 *  there, so reimplemented here rather than reaching into that file). */
function SpentTile({
  label,
  value,
  meta,
  monthly,
}: {
  label: string;
  value: string;
  meta: string;
  monthly: MonthlySpend | undefined;
}) {
  return (
    <View className="min-w-[150px] flex-1 gap-1.5 rounded-lg border border-border bg-raised p-4 shadow-card">
      <View className="flex-row items-start justify-between gap-2">
        <Text className="text-2xs font-bold uppercase tracking-wider text-muted">{label}</Text>
        {monthly ? <SparkLine months={monthly.months} partialMonth={monthly.partialMonth} /> : null}
      </View>
      <Text className="font-display text-2xl text-ink" style={{ fontVariant: ["tabular-nums"] }}>
        {value}
      </Text>
      {meta ? <Text className="text-xs text-muted">{meta}</Text> : null}
    </View>
  );
}

/** The "To review N" tile, styled as a link ("To review N ›") into central
 *  Reconcile — mirrors `ChapterView`'s own `ReviewLinkTile`. */
function ReviewLinkTile({ tile, onPress }: { tile: CentralTile; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      className="min-w-[150px] flex-1 gap-1.5 rounded-lg border border-border bg-raised p-4 shadow-card web:hover:border-accent"
    >
      <View className="flex-row items-center justify-between gap-2">
        <Text className="text-2xs font-bold uppercase tracking-wider text-muted">{tile.label}</Text>
        <Icon name="chevron-right" size={12} color={colors.accent} />
      </View>
      <Text className="font-display text-2xl text-accent" style={{ fontVariant: ["tabular-nums"] }}>
        {tile.value}
      </Text>
      {tile.meta ? <Text className="text-xs text-muted">{tile.meta}</Text> : null}
    </Pressable>
  );
}

type CityLaunchFund = CentralDash["cityLaunchFund"];

function CityLaunchFundTile({ fund }: { fund: CityLaunchFund }) {
  const neverActive =
    fund.positionCents === 0 && fund.skimsReceivedCents === 0 && fund.launchGrantsMadeCents === 0;
  const meta = neverActive
    ? "15% skim · no activity yet"
    : fund.periodNetCents !== 0
      ? `${fund.periodNetCents > 0 ? "+" : ""}${formatCents(fund.periodNetCents)} this period`
      : "15% skim of chapter revenue";
  return <Tile label="City Launch Fund" value={formatCents(fund.positionCents)} meta={meta} />;
}

// ── Right-column attention rail sections ─────────────────────────────────────
// Same underlying signals the old (pre-DASH-3) `CentralView`'s inert banners
// showed (WP-3.2/WP-dashboard-drill/WP-4.5/WP-4.1), restyled onto DASH-2's
// `RailRow` primitive (amber stripe, count chip, one line, one action) —
// each section's own expanded detail renders as an indented list below its
// `RailRow` header, mirroring DASH-2's own `ApprovalRow`/`InterScopeContributorsList`.

type PendingApprovalRow = FunctionReturnType<typeof api.dashboardDrill.pendingBudgetApprovals>[number];

/**
 * WP-3.2 FM/ED oversight, restyled: budgets awaiting a decision, across
 * every chapter + central. A central row's decision happens right here,
 * inline (`BudgetApprovalActions` — the "central ones approve inline" rule);
 * a chapter row's decision happens on that chapter's own dashboard, so its
 * row is a peek link ("Open on chapter ›") instead.
 */
function PendingApprovalsRail({
  count,
  onViewChapter,
}: {
  count: number;
  onViewChapter: (chapterId: Id<"chapters">, chapterName: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const rows = useQuery(api.dashboardDrill.pendingBudgetApprovals, expanded ? {} : "skip");
  if (count <= 0) return null;
  return (
    <View>
      <RailRow
        count={count}
        title={count === 1 ? "1 budget awaiting approval" : `${count} budgets awaiting approval`}
        detail="Across every chapter + central"
        actionLabel={expanded ? "Hide" : "Review"}
        onPress={() => setExpanded((e) => !e)}
      />
      {expanded ? (
        <View className="ml-2 mt-2 gap-3 border-l border-border pl-3">
          {rows === undefined ? (
            <Text className="text-2xs text-muted">Loading…</Text>
          ) : rows.length === 0 ? (
            <Text className="text-2xs text-muted">Nothing awaiting approval.</Text>
          ) : (
            rows.map((row) => <PendingApprovalRowView key={row.budgetId} row={row} onViewChapter={onViewChapter} />)
          )}
        </View>
      ) : null}
    </View>
  );
}

function PendingApprovalRowView({
  row,
  onViewChapter,
}: {
  row: PendingApprovalRow;
  onViewChapter: (chapterId: Id<"chapters">, chapterName: string) => void;
}) {
  if (row.chapterId === CENTRAL) {
    return (
      <View className="gap-1.5">
        <View className="flex-row items-center justify-between gap-2">
          <Text className="flex-1 text-xs font-semibold text-ink" numberOfLines={1}>
            {row.name}
          </Text>
          <Money cents={row.amountCents} className="text-xs text-muted" />
        </View>
        {/* This drilldown only ever returns `approvalStatus === "submitted"`
         *  rows (see `dashboardDrill.pendingBudgetApprovals`'s own index
         *  filter) — safe to hardcode rather than thread an unused field. */}
        <BudgetApprovalActions budgetId={row.budgetId} status="submitted" />
      </View>
    );
  }
  return (
    <Pressable
      // Safe cast: this branch only runs when `row.chapterId !== CENTRAL`
      // above, but that narrowing doesn't persist into a nested callback (a
      // TS limitation, not a runtime one — same precedent as this file's
      // `UnattributedTxnRowView` below).
      onPress={() => onViewChapter(row.chapterId as Id<"chapters">, row.chapterName)}
      accessibilityRole="button"
      className="flex-row items-center justify-between gap-2"
    >
      <Text className="flex-1 text-xs text-ink" numberOfLines={1}>
        {row.name} · {row.chapterName}
      </Text>
      <Text className="text-2xs font-semibold text-accent">Open on chapter ›</Text>
    </Pressable>
  );
}

type UnattributedTxnRow =
  FunctionReturnType<typeof api.dashboardDrill.orgUnattributedTransactions>["rows"][number];

/**
 * Org-wide Unattributed: this period's spend across every chapter (+ central
 * itself) with no explicit budget link — every central budget row above is
 * BLIND to it (no derive-matching fallback exists — see WP-0.1).
 */
function UnattributedRail({
  cents,
  year,
  month,
  period,
  onViewChapter,
}: {
  cents: number;
  year: number;
  month: number;
  period: DashPeriodMode;
  onViewChapter: (chapterId: Id<"chapters">, chapterName: string) => void;
}) {
  const router = useRouter();
  const [expanded, setExpanded] = useState(false);
  // Unlike DASH-2's chapter-scoped `unattributedCount` (returned directly by
  // `dashboardChapter`), `dashboardCentral` has no org-wide COUNT field —
  // only the dollar total (`orgUnattributedCents`, the `cents` prop). Rather
  // than approximate one from `chapterHealth` (a DIFFERENT, always-YTD
  // window that could disagree with this rail's own Month/YTD toggle), this
  // rail runs `orgUnattributedTransactions` UNCONDITIONALLY (unlike the old
  // pre-DASH-3 `CentralView`'s lazy, expand-gated version of the same query)
  // so its own period-scoped `totalCount` can back the rail's count chip
  // honestly — the same query result is then reused for the expanded list,
  // no second fetch.
  const detail = useQuery(api.dashboardDrill.orgUnattributedTransactions, { year, month, period });
  if (cents <= 0) return null;
  return (
    <View>
      <RailRow
        count={detail?.totalCount ?? 0}
        title="Unattributed"
        detail={<Money cents={cents} className="text-2xs font-semibold text-ink" />}
        actionLabel={expanded ? "Hide" : "Review"}
        onPress={() => setExpanded((e) => !e)}
      />
      {expanded ? (
        <View className="ml-2 mt-2 gap-2 border-l border-border pl-3">
          {detail === undefined ? (
            <Text className="text-2xs text-muted">Loading…</Text>
          ) : detail.rows.length === 0 ? (
            <Text className="text-2xs text-muted">Nothing unattributed.</Text>
          ) : (
            <>
              {detail.rows.map((row) => (
                <UnattributedTxnRowView key={row.id} row={row} router={router} onViewChapter={onViewChapter} />
              ))}
              {detail.totalCount > detail.rows.length ? (
                <Text className="text-2xs text-faint">
                  Showing {detail.rows.length} of {detail.totalCount}.
                </Text>
              ) : null}
            </>
          )}
        </View>
      ) : null}
    </View>
  );
}

function UnattributedTxnRowView({
  row,
  router,
  onViewChapter,
}: {
  row: UnattributedTxnRow;
  router: Router;
  onViewChapter: (chapterId: Id<"chapters">, chapterName: string) => void;
}) {
  const label = row.description ?? row.merchantName ?? "Unlabeled charge";
  return (
    <View className="flex-row items-center justify-between gap-3">
      <Text className="flex-1 text-2xs text-ink" numberOfLines={1}>
        {row.chapterName} · {row.date} · {label} · {formatCents(row.amountCents)}
      </Text>
      {row.chapterId === CENTRAL ? (
        <Pressable
          onPress={() =>
            router.navigate("/finances/reconcile?scope=central&filter=needs_budget" as never)
          }
          hitSlop={8}
          accessibilityRole="button"
        >
          <Text className="text-2xs font-semibold text-accent">Reconcile centrally →</Text>
        </Pressable>
      ) : (
        // Safe cast: this branch only runs when `row.chapterId !== CENTRAL`
        // above, but that narrowing doesn't persist into this closure.
        <Pressable
          onPress={() => {
            onViewChapter(row.chapterId as Id<"chapters">, row.chapterName);
            router.navigate("/finances/reconcile?filter=needs_budget" as never);
          }}
          hitSlop={8}
          accessibilityRole="button"
        >
          <Text className="text-2xs font-semibold text-accent">
            Reconcile in {row.chapterName} →
          </Text>
        </Pressable>
      )}
    </View>
  );
}

const CONTRIBUTOR_DIRECTION_LABEL: Record<
  FunctionReturnType<typeof api.transfers.interScopeBalanceContributors>[number]["direction"],
  string
> = {
  central_owes_chapter: "chapter spend → central budget",
  chapter_owes_central: "central spend → chapter budget",
  settlement_central_to_chapter: "settled — central paid",
  settlement_chapter_to_central: "settled — chapter paid",
};

/**
 * WP-4.5: "Your card determines whose account paid; reconcile determines
 * whose budget it was; Central settles the difference monthly alongside the
 * skim." Only chapters with a NONZERO net render a row. Each row expands
 * into the actual transactions/settlement legs behind the number, via
 * `transfers.interScopeBalanceContributors`, and carries its own Settle
 * button (a sibling of the toggle, never nested — a Button nested inside a
 * Pressable double-fires on RN Web).
 */
function InterScopeBalancesRail({
  year,
  month,
  onSettle,
}: {
  year: number;
  month: number;
  onSettle: (chapterId: Id<"chapters">, chapterName: string, netCents: number) => void;
}) {
  const balances = useQuery(api.transfers.interScopeBalances, { year, month }) ?? [];
  const owed = balances.filter((b) => b.netCents !== 0);
  const [expandedChapterId, setExpandedChapterId] = useState<Id<"chapters"> | null>(null);
  if (owed.length === 0) return null;
  return (
    <View className="gap-2">
      {owed.map((b) => {
        const expanded = expandedChapterId === b.chapterId;
        return (
          <View key={b.chapterId}>
            <View className="flex-row items-center gap-2 overflow-hidden rounded-lg border border-warn/40 bg-warn-bg/60 py-2 pr-3">
              <View className="w-1 self-stretch rounded-pill bg-warn" />
              <Pressable
                onPress={() => setExpandedChapterId(expanded ? null : b.chapterId)}
                accessibilityRole="button"
                className="min-w-0 flex-1"
              >
                <Text className="text-xs font-semibold text-ink" numberOfLines={2}>
                  {b.netCents > 0
                    ? `Central owes ${b.chapterName} ${formatCents(b.netCents)}`
                    : `${b.chapterName} owes central ${formatCents(Math.abs(b.netCents))}`}
                </Text>
                <Text className="text-2xs text-muted">{expanded ? "Hide details" : "Tap for details"}</Text>
              </Pressable>
              <Pressable
                onPress={() => onSettle(b.chapterId, b.chapterName, b.netCents)}
                accessibilityRole="button"
                hitSlop={8}
              >
                <Text className="text-2xs font-semibold text-accent">Settle</Text>
              </Pressable>
            </View>
            {expanded ? <InterScopeContributorsList chapterId={b.chapterId} /> : null}
          </View>
        );
      })}
    </View>
  );
}

function InterScopeContributorsList({ chapterId }: { chapterId: Id<"chapters"> }) {
  const contributors = useQuery(api.transfers.interScopeBalanceContributors, { chapterId });
  return (
    <View className="ml-2 mt-2 gap-1.5 border-l border-border pl-3">
      {contributors === undefined ? (
        <Text className="text-2xs text-muted">Loading…</Text>
      ) : contributors.length === 0 ? (
        <Text className="text-2xs text-muted">Nothing contributing yet.</Text>
      ) : (
        contributors.map((row) => (
          <View key={row.id} className="flex-row items-center justify-between gap-3">
            <Text className="flex-1 text-2xs text-muted" numberOfLines={1}>
              {row.date} · {row.description ?? row.merchantName ?? "Unlabeled"} ·{" "}
              {CONTRIBUTOR_DIRECTION_LABEL[row.direction]}
            </Text>
            <Text className="text-2xs text-muted" style={{ fontVariant: ["tabular-nums"] }}>
              {formatCents(row.amountCents)}
            </Text>
          </View>
        ))
      )}
    </View>
  );
}

/** City Launch Fund, quiet row — the KPI tile above already carries the
 *  headline number + subline; this is just the "Record transfer" entry
 *  point, restyled to sit in the rail rather than as its own big card. */
function CityLaunchFundRail({
  fund,
  onRecordTransfer,
}: {
  fund: CityLaunchFund;
  onRecordTransfer: () => void;
}) {
  return (
    <View className="flex-row items-center justify-between gap-3 rounded-lg border border-border bg-raised px-3 py-2">
      <Text className="text-xs text-muted">
        City Launch Fund ·{" "}
        <Money cents={fund.positionCents} className="text-xs font-semibold text-ink" />
      </Text>
      <Pressable onPress={onRecordTransfer} hitSlop={8} accessibilityRole="button">
        <Text className="text-2xs font-semibold text-accent">Record transfer</Text>
      </Pressable>
    </View>
  );
}
