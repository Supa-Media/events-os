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
import type { FunctionReturnType } from "convex/server";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { formatCents } from "@events-os/shared";
import { Badge, Button, Icon, SectionHeader } from "../../ui";
import { colors } from "../../../lib/theme";
import { Money, SignedMoney, Tile, TileRow, type DashPeriodMode } from "./parts";
import { SparkLine } from "./SparkLine";
import { MonthBars } from "./MonthBars";
import { monthlyOperatingCapCents } from "./capLine";
import { categoryRollup } from "./categoryRollup";
import { CategoryBars } from "./CategoryBars";
import { AttentionRail } from "./AttentionRail";
import { BudgetTableGroup, type BudgetTableRow } from "./BudgetTable";

type ChapterDash = FunctionReturnType<typeof api.finances.dashboardChapter>;
type RecentTxn = ChapterDash["recentTransactions"][number];
type Affordability = FunctionReturnType<typeof api.finances.chapterAffordability>;
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
    () => categoryRollup([...data.oneTimeBudgets, ...data.recurringBudgets], periodSpendCents),
    [data.oneTimeBudgets, data.recurringBudgets, periodSpendCents],
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
  }));

  const cadenceLabel = { monthly: "Monthly", quarterly: "Quarterly", yearly: "Yearly" } as const;
  const recurringRows: BudgetTableRow[] = data.recurringBudgets.map((b) => ({
    id: b.id,
    name: b.name,
    meta: [cadenceLabel[b.cadence], b.note].filter(Boolean).join(" · ") || null,
    spentCents: b.spentCents,
    budgetCents: b.budgetCents,
    pct: b.pct,
    categories: b.categories,
    approvalStatus: b.approvalStatus,
    approvedCents: b.approvedCents,
    requestedCents: b.requestedCents,
    reviewNote: b.reviewNote,
  }));

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
          />

          <BudgetTableGroup
            title="Recurring buckets"
            rows={recurringRows}
            isDrilldown={isDrilldown}
            collapsible
            emptyTitle="No recurring buckets"
            emptyMessage="Create a monthly, quarterly, or yearly budget for a team or category."
            onPressRow={onEditBudget}
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
          />
        </View>
      </View>
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
function RecentDigest({ rows, onViewAll }: { rows: RecentTxn[]; onViewAll?: () => void }) {
  if (rows.length === 0) return null;
  const shown = rows.slice(0, 5);
  return (
    <View>
      <SectionHeader title="Recent transactions" />
      <View className="overflow-hidden rounded-lg border border-border bg-raised shadow-card">
        {shown.map((t, i) => (
          <View
            key={t.id}
            className={`flex-row items-center justify-between gap-2 px-3 py-2 ${
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
          </View>
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
    </View>
  );
}
