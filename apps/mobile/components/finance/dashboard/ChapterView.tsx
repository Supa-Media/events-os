/**
 * DASH-2 "Command center" — the chapter perspective of the finance
 * dashboard, redesigned around ONE chart that doubles as the page's period
 * filter (per the owner-approved mockup, top to bottom):
 *  1. the affordability strip (WP-4.3, restyled — the under-water figure is
 *     now a red PILL, not plain red text);
 *  2. a 4-tile KPI band (Spent·YTD with a sparkline, the two biggest budget
 *     tiles, "To review N ›" styled as a link);
 *  3. a two-column grid — LEFT: the spend-by-month bar chart (clicking a bar
 *     IS the page's period filter — no second control) + the dense "Events &
 *     projects" / "Recurring buckets" tables (awaiting-approval rows pinned,
 *     categories folded behind a row chevron); RIGHT: the restyled attention
 *     rail, a "Where it went" category panel, and a recent-transactions
 *     digest;
 *  4. one shared `Meter` component for spent-of-cap color everywhere (gold /
 *     amber / red — see `meterTone.ts`) — no more per-surface guessing.
 *
 * Figures come from `api.finances.dashboardChapter` (the bulk of the view),
 * `api.finances.chapterAffordability` (the header strip), and
 * `api.dashboardCharts.spendByMonth` (the bar chart + sparkline) — this view
 * stays pure presentation over those three contracts, plus a few CLIENT-SIDE
 * derivations documented in `capLine.ts` / `categoryRollup.ts` /
 * `rowOrdering.ts` (this PR's ownership excludes adding new Convex queries).
 */
import { useMemo, useState } from "react";
import { Pressable, Text, useWindowDimensions, View } from "react-native";
import { useRouter } from "expo-router";
import type { FunctionReturnType } from "convex/server";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { formatCents, quarterOfMonth, type BudgetRefKind } from "@events-os/shared";
import { Badge, Button, Icon, SectionHeader } from "../../ui";
import { colors } from "../../../lib/theme";
import { Money, SignedMoney, Tile, TileRow, type DashPeriodMode } from "./parts";
import { SparkLine } from "./SparkLine";
import { MonthBars } from "./MonthBars";
import { monthlyOperatingCapCents } from "./capLine";
import { categoryRollup } from "./categoryRollup";
import { extraApprovalsCount } from "./extraApprovals";
import { CategoryBars } from "./CategoryBars";
import { AttentionRail } from "./AttentionRail";
import { BudgetTableGroup, type BudgetTableRow } from "./BudgetTable";
import type { DrilldownTxn } from "./TransactionList";
import { TransactionDetailModal, type TransactionDetailSource } from "./TransactionDetailModal";

type ChapterDash = FunctionReturnType<typeof api.finances.dashboardChapter>;
type RecentTxn = ChapterDash["recentTransactions"][number];
type Affordability = FunctionReturnType<typeof api.finances.chapterAffordability>;
type RecurringBudget = ChapterDash["recurringBudgets"][number];

// DASH-2.1 UI (feature 1): a recurring bucket's cadence unit, for the
// "…this quarter"/"…this year" phrasing — monthly needs no phrasing (its
// `periodSpendCents` already equals `spentCents`, see `recurringBudgetCard`'s
// own doc comment in `finances.ts`).
const CADENCE_UNIT: Record<"quarterly" | "yearly", string> = {
  quarterly: "quarter",
  yearly: "year",
};

/**
 * DASH-2.1 UI (feature 1): month-honest recurring rows. In month mode, a
 * quarterly/yearly bucket's plain "$spent / $cap" reads as the SAME
 * cumulative figure in every month (the owner report this backend PR, #242,
 * fixed the denominators for) — this derives the composite label AND the
 * meter's own pct from the additive `periodSpendCents`/`fullCapCents`/
 * `cadenceSpendCents` fields (#242), never a prorated slice of the full cap.
 * `undefined`/`b.pct` (server's existing cadence-cumulative ratio, which
 * ALREADY equals `cadenceSpendCents/fullCapCents` — see those fields' own
 * doc comment) for every other case: monthly cadence (unchanged), YTD mode
 * (no change needed — #242 already fixed YTD's own denominators), or a
 * budget whose additive fields aren't populated (older data shape).
 */
function monthHonestRecurring(
  b: RecurringBudget,
  period: DashPeriodMode,
): { pct: number; capLabelOverride: string | undefined } {
  const eligible =
    period === "month" &&
    (b.cadence === "quarterly" || b.cadence === "yearly") &&
    b.periodSpendCents != null &&
    b.fullCapCents != null &&
    b.cadenceSpendCents != null;
  if (!eligible) return { pct: b.pct, capLabelOverride: undefined };
  const periodSpendCents = b.periodSpendCents!;
  const fullCapCents = b.fullCapCents!;
  const cadenceSpendCents = b.cadenceSpendCents!;
  const pct = fullCapCents > 0 ? Math.round((cadenceSpendCents / fullCapCents) * 100) : 0;
  const unit = CADENCE_UNIT[b.cadence as "quarterly" | "yearly"];
  const capLabelOverride = `${formatCents(periodSpendCents)} this month · ${formatCents(cadenceSpendCents)} of ${formatCents(fullCapCents)} this ${unit}`;
  return { pct, capLabelOverride };
}

/**
 * DASH-2.1 UI fix (review finding #1 — "drill must sum to the tapped bar"):
 * a recurring budget's own category mini-bars widen to the budget's effective
 * period in month mode (`finances.ts#budgetEffectivePeriod`, via
 * `txnCountsTowardBudgetDash`) — monthly cadence stays scoped to one month,
 * but quarterly widens to the whole quarter and yearly to the whole year,
 * regardless of which single month the dashboard is showing. A transactions
 * drill-down that only ever requested one month under-summed vs. that wider
 * bar. This returns the SAME widened period for `dashboardCharts.
 * budgetTransactions` to request (mirrors `budgetEffectivePeriod`'s own
 * switch, not re-deriving it — a budget with a FIXED `quarter` narrower than
 * `contextMonth`'s own quarter would only be VISIBLE on this dashboard when
 * they already agree — see that function's doc comment for why
 * `quarterOfMonth(month)` is always correct here). YTD mode already reads the
 * whole year for every cadence (`drilldownPeriod` below omits `month`
 * entirely there), so this only changes month-mode behavior.
 */
function recurringDrilldownPeriod(
  cadence: RecurringBudget["cadence"],
  year: number,
  month: number,
  mode: DashPeriodMode,
): { year: number; month?: number; quarter?: number; rangeNote?: string } {
  if (mode !== "month") return { year };
  switch (cadence) {
    case "quarterly":
      return { year, quarter: quarterOfMonth(month), rangeNote: "this quarter" };
    case "yearly":
      return { year, rangeNote: "this year" };
    case "monthly":
    default:
      return { year, month };
  }
}
type MonthlySpend = FunctionReturnType<typeof api.dashboardCharts.spendByMonth>;

/** Below this width the two-column grid stacks to one column. */
const STACK_WIDTH = 900;

export function ChapterView({
  data,
  affordability,
  monthly,
  year,
  month,
  period,
  onNewBudget,
  onEditBudget,
  onAddTransaction,
  onAttentionAction,
  onEditBackerCount,
  onChangePeriod,
  isDrilldown = false,
}: {
  data: ChapterDash;
  /** WP-4.3's affordability header data. `undefined` while its (separate)
   *  query is still loading — the header renders nothing until then rather
   *  than blocking the rest of the dashboard on it. */
  affordability: Affordability | undefined;
  /** `api.dashboardCharts.spendByMonth` for this chapter/year — the bar
   *  chart + KPI sparkline. `undefined` while loading (its own query; the
   *  chart/sparkline render nothing until it resolves). */
  monthly: MonthlySpend | undefined;
  /** The dashboard's currently-selected year/(through-)month/mode. */
  year: number;
  month: number;
  period: DashPeriodMode;
  onNewBudget: () => void;
  onEditBudget: (budgetId: string) => void;
  onAddTransaction: () => void;
  /** Navigate for an attention row's action (`a.kind`: "reimbursements" → the
   *  Reimbursements tab, "cards" → the Cards tab, "needs_budget" → Reconcile
   *  pre-filtered to unattributed spend). Also reused by the "To review" KPI
   *  tile and the recent-transactions digest's "View all" — Reconcile is the
   *  dashboard's one review surface; there's no separate destination for
   *  "unreviewed" generically. */
  onAttentionAction: (kind: string) => void;
  /** Open the backer-count edit modal. Only ever called when
   *  `affordability.canEdit` is true (the affordance is hidden otherwise). */
  onEditBackerCount: () => void;
  /** Clicking a spend-by-month bar sets the SAME period state the page's
   *  ‹ › picker uses — one state, no second control (see `MonthBars`). */
  onChangePeriod: (next: { year: number; month: number; period: DashPeriodMode }) => void;
  /**
   * True while a central viewer is drilled into a chapter that ISN'T their
   * own (see finances/index.tsx). Every write action here — "New budget",
   * "Add transaction", approvals — resolves to the CALLER's own chapter
   * server-side, so offering them while viewing a different chapter would
   * silently write to the wrong place. Drill-down is read-only.
   */
  isDrilldown?: boolean;
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

  const capCentsPerMonth = useMemo(
    () =>
      monthlyOperatingCapCents(
        data.recurringBudgets.map((b) => ({ cadence: b.cadence, budgetCents: b.budgetCents })),
        period,
        month,
      ),
    [data.recurringBudgets, period, month],
  );

  const spentTile = data.tiles.find((t) => t.label.startsWith("Spent"));
  const reviewTile = data.tiles.find((t) => t.label === "To review");
  const otherTiles = data.tiles.filter((t) => t !== spentTile && t !== reviewTile);
  const periodSpendCents = spentTile?.subValueCents ?? 0;

  const rollup = useMemo(
    () => categoryRollup(data.oneTimeBudgets, data.recurringBudgets, periodSpendCents, period),
    [data.oneTimeBudgets, data.recurringBudgets, periodSpendCents, period],
  );

  const pendingApprovals = useMemo(
    () =>
      [...data.oneTimeBudgets, ...data.recurringBudgets]
        .filter((b) => b.approvalStatus === "submitted")
        .map((b) => ({
          id: b.id,
          name: b.name,
          requestedCents: b.requestedCents,
          approvalStatus: b.approvalStatus,
        })),
    [data.oneTimeBudgets, data.recurringBudgets],
  );

  // Period-agnostic gap between the chapter-wide `budget_approvals` count
  // (`data.attention`, no year/month filter) and what's actually visible
  // above (`pendingApprovals`, period-scoped) — see `extraApprovals.ts`.
  const extraApprovals = useMemo(
    () => extraApprovalsCount(data.attention, pendingApprovals.length),
    [data.attention, pendingApprovals.length],
  );

  // DASH-2.1 UI: the drill-down's own detail modal (opened by drilling
  // through a category's transaction list, from either budget table below —
  // a SEPARATE piece of state from `RecentDigest`'s own modal, mirroring
  // `CentralView`'s `selectedTag` precedent for a locally-owned detail sheet).
  const [detailSource, setDetailSource] = useState<TransactionDetailSource | null>(null);
  function openDrilldownTxn(
    txn: DrilldownTxn,
    budgetName: string,
    refKind: BudgetRefKind | null,
    scopeRefId: string | null,
  ) {
    setDetailSource({ kind: "detail", txn, budgetName, refKind, scopeRefId });
  }
  const drilldownPeriod = { year, month: period === "month" ? month : undefined };
  // WP-wave4 (item 4 — deep links), restored: navigate to the row's linked
  // event/project page. Only wired OUTSIDE a peeked drilldown (`isDrilldown`)
  // — a peeked chapter's events/projects belong to THAT chapter, not the
  // caller's own, and `/event/[id]`/`/project/[id]` are hard-scoped to the
  // caller's own chapter via `requireOwned` (see `ChapterContext`'s own file
  // doc, "event DETAIL navigation is disabled while peeking" — same rule the
  // Events landing screen already follows for the identical reason).
  const onOpenRef = isDrilldown
    ? undefined
    : (refKind: BudgetRefKind, scopeRefId: string) =>
        router.push(`/${refKind}/${scopeRefId}` as never);
  // DASH-2.1 UI fix (review finding #3): whether the CALLER can actually
  // record a transaction edit here — `spendByMonth` (already fetched for
  // this chapter/year as `monthly`) resolves this against the SAME chapter
  // this view is showing, `false` while peeking/drilling a different one
  // (mirrors `TransactionDetailModal`'s own peek gate). Threaded into every
  // `TransactionDetailModal` instance below so it can lock edit controls for
  // a below-bookkeeper viewer, not just a peeking central caller.
  const canRecordTransactions = monthly?.canRecordTransactions ?? false;

  const oneTimeRows: BudgetTableRow[] = data.oneTimeBudgets.map((b) => ({
    id: b.id,
    name: b.name,
    meta: [b.dateLabel, b.subtitle].filter(Boolean).join(" · ") || null,
    spentCents: b.spentCents,
    budgetCents: b.budgetCents,
    pct: b.pct,
    categories: b.categories,
    approvalStatus: b.approvalStatus,
    approvedCents: b.approvedCents,
    requestedCents: b.requestedCents,
    reviewNote: b.reviewNote,
    refKind: b.refKind,
    scopeRefId: b.scopeRefId,
  }));

  const cadenceLabel = { monthly: "Monthly", quarterly: "Quarterly", yearly: "Yearly" } as const;
  const recurringRows: BudgetTableRow[] = data.recurringBudgets.map((b) => {
    const { pct, capLabelOverride } = monthHonestRecurring(b, period);
    return {
      id: b.id,
      name: b.name,
      meta: [cadenceLabel[b.cadence], b.note].filter(Boolean).join(" · ") || null,
      spentCents: b.spentCents,
      budgetCents: b.budgetCents,
      pct,
      categories: b.categories,
      approvalStatus: b.approvalStatus,
      approvedCents: b.approvedCents,
      requestedCents: b.requestedCents,
      reviewNote: b.reviewNote,
      capLabelOverride,
      // Review fix (finding #1): this row's OWN effective drill-down period,
      // overriding the group-level `drilldownPeriod` below (which stays
      // month-only — correct for the "Events & projects" one-time table).
      drilldownPeriod: recurringDrilldownPeriod(b.cadence, year, month, period),
    };
  });

  const emptyMonths = useMemo(
    () => Array.from({ length: 12 }, (_, i) => ({ month: i + 1, spendCents: 0 })),
    [],
  );

  return (
    <View>
      {/* 1. Affordability strip (WP-4.3): "can we afford this?" in one line. */}
      <AffordabilityHeader data={affordability} onEdit={onEditBackerCount} />

      {/* 2. KPI band */}
      <TileRow>
        {spentTile ? <SpentTile tile={spentTile} monthly={monthly} /> : null}
        {otherTiles.map((t, i) => (
          <Tile key={i} label={t.label} value={t.value} meta={t.meta} />
        ))}
        {reviewTile ? (
          <ReviewLinkTile
            tile={reviewTile}
            onPress={isDrilldown ? undefined : () => onAttentionAction("needs_budget")}
          />
        ) : null}
      </TileRow>

      {!isDrilldown ? (
        <View className="mb-1 flex-row justify-end">
          <Button
            title="Add transaction"
            icon="plus"
            size="sm"
            variant="secondary"
            onPress={onAddTransaction}
          />
        </View>
      ) : null}

      {/* 3. Two-column grid — ~1.6fr/1fr, stacks under STACK_WIDTH. */}
      <View className={stacked ? "mt-2 gap-4" : "mt-2 flex-row gap-4"}>
        {/* LEFT */}
        <View style={stacked ? undefined : { flex: 1.6 }}>
          <SectionHeader title="Spend by month" />
          <View className="rounded-lg border border-border bg-raised p-4 shadow-card">
            <MonthBars
              months={monthly?.months ?? emptyMonths}
              partialMonth={monthly?.partialMonth ?? null}
              capCentsPerMonth={capCentsPerMonth}
              selectedMonth={selectedMonth}
              onSelectMonth={handleSelectMonth}
            />
          </View>

          <BudgetTableGroup
            title="Events & projects"
            rows={oneTimeRows}
            isDrilldown={isDrilldown}
            emptyTitle="No event or project budgets yet"
            emptyMessage="Budget an event or project to track its spend against a plan."
            onPressRow={onEditBudget}
            drilldownPeriod={drilldownPeriod}
            onOpenTransaction={openDrilldownTxn}
            onOpenRef={onOpenRef}
          />

          <BudgetTableGroup
            title="Recurring buckets"
            rows={recurringRows}
            isDrilldown={isDrilldown}
            collapsible
            emptyTitle="No recurring buckets"
            emptyMessage="Create a monthly, quarterly, or yearly budget for a team or category."
            onPressRow={onEditBudget}
            drilldownPeriod={drilldownPeriod}
            onOpenTransaction={openDrilldownTxn}
          />

          {!isDrilldown ? (
            <View className="mt-2 flex-row justify-end">
              <Button title="New budget" icon="plus" size="sm" onPress={onNewBudget} />
            </View>
          ) : null}
        </View>

        {/* RIGHT */}
        <View style={stacked ? undefined : { flex: 1 }} className="gap-4">
          <View>
            <SectionHeader title="Needs your attention" />
            <AttentionRail
              attention={data.attention}
              unattributedCount={data.unattributedCount}
              unattributedCents={data.unattributedCents}
              centralLinkedCents={data.centralLinkedCents}
              pendingApprovals={pendingApprovals}
              extraApprovalsCount={extraApprovals}
              onViewOtherPeriods={
                period === "ytd" ? undefined : () => onChangePeriod({ year, month, period: "ytd" })
              }
              isDrilldown={isDrilldown}
              onAttentionAction={onAttentionAction}
            />
          </View>

          <View>
            <SectionHeader title="Where it went" />
            <View className="rounded-lg border border-border bg-raised p-4 shadow-card">
              <CategoryBars rollup={rollup} />
            </View>
          </View>

          <RecentDigest
            rows={data.recentTransactions}
            onViewAll={isDrilldown ? undefined : () => onAttentionAction("needs_budget")}
            canRecordTransactions={canRecordTransactions}
          />
        </View>
      </View>

      {/* DASH-2.1 UI: the drill-down's own detail modal (see `openDrilldownTxn`
          above) — `RecentDigest` owns a SEPARATE instance for its own rows. */}
      {detailSource ? (
        <TransactionDetailModal
          source={detailSource}
          onClose={() => setDetailSource(null)}
          canRecordTransactions={canRecordTransactions}
        />
      ) : null}
    </View>
  );
}

// ── Affordability header (WP-4.3) ────────────────────────────────────────────
// "Can we afford this event?" in one line: backers → tier → monthly revenue →
// floor + skim → discretionary. Zero/unset backers get a gentle prompt instead
// of a $0-everywhere row (a manager-only "Set backers" action; nothing at all
// for a plain viewer, so the row disappears rather than reading as broken).
function AffordabilityHeader({
  data,
  onEdit,
}: {
  data: Affordability | undefined;
  onEdit: () => void;
}) {
  if (!data) return null; // its own query — never blocks the rest of the dashboard

  if (data.backerCount === 0) {
    return (
      <View className="mb-3 flex-row flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-raised px-4 py-3">
        <Text className="text-sm text-muted">
          Set your backer count to see affordability.
        </Text>
        {data.canEdit ? (
          <Button title="Set backers" size="sm" variant="secondary" onPress={onEdit} />
        ) : null}
      </View>
    );
  }

  const underwater = data.discretionaryCents < 0;

  return (
    <View className="mb-3 flex-row flex-wrap items-center gap-x-1.5 gap-y-1 rounded-lg border border-border bg-raised px-4 py-3">
      <Text className="text-sm text-ink">
        <Text className="font-semibold">{data.backerCount}</Text>{" "}
        {data.backerCount === 1 ? "backer" : "backers"}
      </Text>
      <Text className="text-sm text-muted">·</Text>
      <Text className="text-sm text-ink">
        Tier: <Text className="font-semibold">{data.tierLabel}</Text>
      </Text>
      <Text className="text-sm text-muted">·</Text>
      <Money cents={data.monthlyRevenueCents} className="text-sm font-semibold text-ink" />
      <Text className="text-sm text-muted">/mo revenue →</Text>
      <Money cents={data.floorCents} className="text-sm text-ink" />
      <Text className="text-sm text-muted">floor +</Text>
      <Money cents={data.skimCents} className="text-sm text-ink" />
      <Text className="text-sm text-muted">skim</Text>
      <View className="ml-1">
        {underwater ? (
          <Badge label={`Under water by ${formatCents(-data.discretionaryCents)}`} tone="danger" />
        ) : (
          <Text className="text-sm font-semibold text-ink">
            <Money cents={data.discretionaryCents} className="text-sm font-semibold text-ink" />{" "}
            discretionary
          </Text>
        )}
      </View>
      {data.canEdit ? (
        <Pressable
          onPress={onEdit}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Edit backer count"
          className="ml-auto flex-row items-center gap-1 rounded-md px-1.5 py-0.5 active:bg-sunken"
        >
          <Icon name="edit-2" size={12} color={colors.muted} />
        </Pressable>
      ) : null}
    </View>
  );
}

// ── KPI tile variants ────────────────────────────────────────────────────────
type ChapterTile = ChapterDash["tiles"][number];

/** The "Spent · …" tile with its own sparkline in the top-right corner. */
function SpentTile({ tile, monthly }: { tile: ChapterTile; monthly: MonthlySpend | undefined }) {
  return (
    <View className="min-w-[150px] flex-1 gap-1.5 rounded-lg border border-border bg-raised p-4 shadow-card">
      <View className="flex-row items-start justify-between gap-2">
        <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
          {tile.label}
        </Text>
        {monthly ? <SparkLine months={monthly.months} partialMonth={monthly.partialMonth} /> : null}
      </View>
      <Text className="font-display text-2xl text-ink" style={{ fontVariant: ["tabular-nums"] }}>
        {tile.value}
      </Text>
      {tile.meta ? <Text className="text-xs text-muted">{tile.meta}</Text> : null}
    </View>
  );
}

/** The "To review N" tile, styled as a link ("To review N ›") into Reconcile. */
function ReviewLinkTile({ tile, onPress }: { tile: ChapterTile; onPress?: () => void }) {
  const content = (
    <>
      <View className="flex-row items-center justify-between gap-2">
        <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
          {tile.label}
        </Text>
        {onPress ? <Icon name="chevron-right" size={12} color={colors.accent} /> : null}
      </View>
      <Text
        className={`font-display text-2xl ${onPress ? "text-accent" : "text-ink"}`}
        style={{ fontVariant: ["tabular-nums"] }}
      >
        {tile.value}
      </Text>
      {tile.meta ? <Text className="text-xs text-muted">{tile.meta}</Text> : null}
    </>
  );
  if (!onPress) {
    return (
      <View className="min-w-[150px] flex-1 gap-1.5 rounded-lg border border-border bg-raised p-4 shadow-card">
        {content}
      </View>
    );
  }
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      className="min-w-[150px] flex-1 gap-1.5 rounded-lg border border-border bg-raised p-4 shadow-card web:hover:border-accent"
    >
      {content}
    </Pressable>
  );
}

// ── Recent transactions digest ───────────────────────────────────────────────
// 4-5 rows (merchant · budget shortname · amount) + "All N in Reconcile ›".
// `N` is the recent-window count `dashboardChapter` returns (capped at
// `RECENT_TXN_COUNT`), not a true period total — the dashboard doesn't fetch
// one (Reconcile itself is the full ledger).
//
// DASH-2.1 UI (feature 3/4): each row is now tappable, opening the SAME
// `TransactionDetailModal` the category drill-down uses via its "lookup"
// entry — `recentTxnCard` (this row's own shape) carries a real transaction
// id but not category id / receipt presence / a note (see
// `TransactionDetailModal`'s own module doc), so the modal lazily resolves
// those from `listReconcile`. `t.codedTo`'s own strings seed the modal's
// display the instant it opens (peek-safe — server-resolved for whichever
// chapter this digest belongs to) rather than showing blank fields while
// that lookup is in flight.
function RecentDigest({
  rows,
  onViewAll,
  canRecordTransactions,
}: {
  rows: RecentTxn[];
  onViewAll?: () => void;
  /** Review fix (finding #3) — see `ChapterView`'s own `canRecordTransactions`
   *  doc comment. */
  canRecordTransactions: boolean;
}) {
  const [openId, setOpenId] = useState<Id<"transactions"> | null>(null);
  const openRow = openId ? rows.find((r) => r.id === openId) : null;

  if (rows.length === 0) return null;
  const shown = rows.slice(0, 5);
  return (
    <View>
      <SectionHeader title="Recent transactions" />
      <View className="overflow-hidden rounded-lg border border-border bg-raised shadow-card">
        {shown.map((t, i) => (
          <Pressable
            key={t.id}
            onPress={() => setOpenId(t.id)}
            accessibilityRole="button"
            className={`flex-row items-center justify-between gap-2 px-3 py-2 active:opacity-70 web:hover:bg-sunken ${
              i === shown.length - 1 ? "" : "border-b border-border"
            }`}
          >
            <View className="min-w-0 flex-1">
              <Text className="text-xs font-semibold text-ink" numberOfLines={1}>
                {t.merchant ?? "—"}
              </Text>
              <Text className="text-2xs text-muted" numberOfLines={1}>
                {t.codedTo?.projectOrEvent || t.codedTo?.category || "Uncoded"}
              </Text>
            </View>
            <SignedMoney cents={t.amountCents} flow={t.flow} className="text-xs font-semibold" />
          </Pressable>
        ))}
        {onViewAll ? (
          <Pressable
            onPress={onViewAll}
            accessibilityRole="button"
            className="flex-row items-center justify-center gap-1.5 border-t border-border py-2 web:hover:bg-sunken"
          >
            <Text className="text-xs font-semibold text-accent">
              All {rows.length} in Reconcile
            </Text>
            <Icon name="chevron-right" size={12} color={colors.accent} />
          </Pressable>
        ) : null}
      </View>

      {openRow ? (
        <TransactionDetailModal
          source={{
            kind: "lookup",
            transactionId: openRow.id,
            fallback: {
              budgetName: openRow.codedTo?.projectOrEvent || null,
              categoryName: openRow.codedTo?.category || null,
              refKind: openRow.codedTo?.refKind ?? null,
              scopeRefId: openRow.codedTo?.scopeRefId ?? null,
            },
          }}
          onClose={() => setOpenId(null)}
          canRecordTransactions={canRecordTransactions}
        />
      ) : null}
    </View>
  );
}
