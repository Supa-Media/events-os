/**
 * Central perspective of the finance dashboard — the org-wide roll-up: global
 * KPI tiles, central budgets, an interactive "By tag" breakdown (each tag's
 * org-wide spend, tappable to the contributing budgets), and a "By chapter"
 * list (each chapter's month spend against its budget). Pure presentation over
 * `api.finances.dashboardCentral`.
 */
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useQuery } from "convex/react";
import { useRouter } from "expo-router";
import type { FunctionReturnType } from "convex/server";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { BUDGET_CADENCE_LABELS, CENTRAL, formatCents } from "@events-os/shared";
import { Button, EmptyState, Icon, SectionHeader } from "../../ui";
import { colors } from "../../../lib/theme";
import { BudgetBar, Chip, Tile, TileRow, type DashPeriodMode } from "./parts";
import { awaitingApprovalZeroCapDisplay } from "./awaitingApproval";
import { TagRollupSection, type TagRollup } from "./TagRollup";
import { BudgetApprovalActions, BudgetApprovalChip } from "./BudgetApprovalActions";

type CentralDash = FunctionReturnType<typeof api.finances.dashboardCentral>;
type ChapterRollup = CentralDash["chapterRollup"][number];
type CentralBudget = CentralDash["centralBudgets"][number];

export function CentralView({
  data,
  year,
  month,
  period,
  onViewChapter,
  onNewBudget,
  onEditBudget,
  onRecordTransfer,
  onSettle,
}: {
  data: CentralDash;
  /** The dashboard's currently-selected year. */
  year: number;
  /** The dashboard's currently-selected (through-)month — WP-4.5's inter-scope
   *  balances section reads the same {year, month} the dashboard is showing. */
  month: number;
  /** The dashboard's currently-selected mode — passed straight through to the
   *  tag-detail sheet's `tagDrilldown` query so its numbers stay scoped to
   *  whatever `data` itself was fetched with. */
  period: DashPeriodMode;
  /** Drill into one chapter's chapter-perspective dashboard (central-only —
   *  the backend re-checks central reach via `dashboardChapter({chapterId})`). */
  onViewChapter: (chapterId: Id<"chapters">, chapterName: string) => void;
  /** Open `BudgetCreateModal` preset + locked to the central scope. */
  onNewBudget: () => void;
  /** WP-wave4 (item 1): open `BudgetCreateModal` on an EXISTING central
   *  budget, mirroring `ChapterView`'s "Edit budget". The server accepts the
   *  edit from a central manager (Treasurer/FM, unchanged) OR the ED's seat
   *  (`budgetLines.ts`/`lib/finance.ts#requireCentralFinanceRoleOrEdSeat`) —
   *  this button itself is unconditional (mirrors `ChapterView`'s always-shown
   *  affordance); a caller lacking either path gets a FORBIDDEN toast from
   *  the mutation, not a hidden button. */
  onEditBudget: (budgetId: string) => void;
  /** Open `TransferRecordModal` (record/initiate a skim in or a grant out). */
  onRecordTransfer: () => void;
  /** WP-4.5: open `TransferRecordModal` PRESET to a settlement for this
   *  chapter — `netCents` carries both the amount and direction (positive =
   *  central pays the chapter, negative = the chapter pays central). */
  onSettle: (chapterId: Id<"chapters">, chapterName: string, netCents: number) => void;
}) {
  // The "By chapter" rollup's Central row (chapterId === CENTRAL, always
  // present — see `dashboardCentral`) vs the real per-chapter rows.
  const centralRollupRow = data.chapterRollup.find((c) => c.chapterId === CENTRAL);
  const chapterRows = data.chapterRollup.filter(
    (c): c is ChapterRollup & { chapterId: Id<"chapters"> } => c.chapterId !== CENTRAL,
  );

  // The tag-detail sheet's open/selected tag — CONTROLLED here (not owned by
  // `TagRollupSection`) so its `tagDrilldown` query only runs while the sheet
  // is actually open.
  const [selectedTag, setSelectedTag] = useState<TagRollup | null>(null);

  return (
    <View>
      <TileRow>
        {data.tiles.map((t, i) => (
          <Tile key={i} label={t.label} value={t.value} meta={t.meta} />
        ))}
      </TileRow>

      {/* Org-wide Unattributed: this period's spend across every chapter with
          no explicit budget link — every central budget card below is BLIND
          to it (no derive-matching fallback exists — see WP-0.1). Read-only
          (no tap-through: Reconcile is chapter-scoped, and this sum spans
          every chapter, so there's no single destination to jump to). */}
      {data.orgUnattributedCents > 0 ? (
        <View className="mb-3 flex-row items-center gap-3 rounded-lg border border-warn bg-warn-bg p-4 shadow-card">
          <View className="flex-1">
            <Text className="text-sm font-semibold text-ink">
              Unattributed: {formatCents(data.orgUnattributedCents)}
            </Text>
            <Text className="text-xs text-muted">
              Org-wide spend this period with no budget attached — chase each
              chapter's Treasurer to code it in Reconcile.
            </Text>
          </View>
        </View>
      ) : null}

      {/* WP-3.2 FM/ED oversight: a read-only count of budgets awaiting a
          decision, across every chapter + central. The 85% principle keeps
          this a pure audit signal — chapter budgets are approved BY the
          Chapter Director, never gated from here; only a central budget's
          own card (below) offers a decision on THIS screen. */}
      {data.pendingBudgetApprovalsCount > 0 ? (
        <View className="mb-3 flex-row items-center gap-3 rounded-lg border border-accent bg-accent-soft p-4 shadow-card">
          <View className="flex-1">
            <Text className="text-sm font-semibold text-ink">
              {data.pendingBudgetApprovalsCount === 1
                ? "1 budget awaiting approval"
                : `${data.pendingBudgetApprovalsCount} budgets awaiting approval`}
            </Text>
            <Text className="text-xs text-muted">
              Across every chapter + central — chapter budgets are decided on
              their own chapter's dashboard; central budgets right below.
            </Text>
          </View>
        </View>
      ) : null}

      {/* City Launch Fund (WP-4.1/4.2): the chapter→central skim balance minus
          launch grants paid out, plus the affordance to record/initiate a
          transfer. Ledger-derived (skim inflow − launch outflow). */}
      <CityLaunchFundCard fund={data.cityLaunchFund} onRecordTransfer={onRecordTransfer} />

      {/* Inter-chapter balances (WP-4.5): the cash imbalance created when a
          chapter's card pays for a central budget line (or vice versa) —
          separate from the skim, "settle alongside" it. Read-only until a
          human taps Settle; visible-but-unsettled otherwise (owner policy). */}
      <InterScopeBalancesSection year={year} month={month} onSettle={onSettle} />

      {/* Org-wide (central) budgets — spend across every chapter. */}
      <SectionHeader
        title="Central budgets"
        count="org-wide"
        right={<Button title="New budget" icon="plus" size="sm" onPress={onNewBudget} />}
      />
      {data.centralBudgets.length === 0 ? (
        <EmptyState
          title="No central budgets yet"
          message="Create an org-wide budget to track spend across every chapter."
        />
      ) : (
        <View className="flex-row flex-wrap gap-3">
          {data.centralBudgets.map((b) => (
            <CentralBudgetCard key={b.id} b={b} onEdit={() => onEditBudget(b.id)} />
          ))}
        </View>
      )}

      {/* By tag, across chapters — interactive rollup */}
      <TagRollupSection
        rollups={data.tagRollups}
        scope="central"
        year={year}
        month={month}
        period={period}
        selected={selectedTag}
        onSelect={setSelectedTag}
      />

      {/* By chapter — the Central row (org-wide central-linked spend, from
          the central budgets above) always leads, followed by each real
          chapter. Central isn't drillable yet (no central-scoped detail view
          exists beyond the central-budget cards already on this screen), so
          it renders inert while chapter rows stay tappable. */}
      <SectionHeader title="By chapter" count={chapterRows.length} />
      <View className="gap-3">
        {centralRollupRow ? <CentralRollupRow c={centralRollupRow} /> : null}
        {chapterRows.length === 0 ? (
          <EmptyState title="No chapters yet" />
        ) : (
          chapterRows.map((c) => (
            <ChapterRollupCard
              key={c.chapterId}
              c={c}
              onView={() => onViewChapter(c.chapterId, c.chapterName)}
            />
          ))
        )}
      </View>
    </View>
  );
}

type CityLaunchFund = CentralDash["cityLaunchFund"];

// The City Launch Fund position + the "Record transfer" affordance (skim in /
// grant out). The balance is all-time (skims received − launch grants made);
// the period line reflects the dashboard's selected month/YTD.
function CityLaunchFundCard({
  fund,
  onRecordTransfer,
}: {
  fund: CityLaunchFund;
  onRecordTransfer: () => void;
}) {
  // WP-wave4 (item 7, owner addendum 2026-07-17): "$0 with no transfers ever
  // → hide until first activity" — but the "Record transfer" affordance is
  // the ONLY entry point to record the very FIRST skim/grant, so it can't
  // just vanish with the card; keep a compact standalone action in its place.
  const neverActive =
    fund.positionCents === 0 &&
    fund.skimsReceivedCents === 0 &&
    fund.launchGrantsMadeCents === 0;
  if (neverActive) {
    return (
      <View className="mb-3 flex-row items-center justify-between gap-3 rounded-lg border border-border bg-raised px-4 py-3">
        <Text className="flex-1 text-sm text-muted">
          No City Launch Fund activity yet.
        </Text>
        <Button
          title="Record transfer"
          icon="plus"
          size="sm"
          variant="secondary"
          onPress={onRecordTransfer}
        />
      </View>
    );
  }
  return (
    <View className="mb-3 rounded-lg border border-border bg-raised p-4 shadow-card">
      <View className="mb-2 flex-row items-start justify-between gap-3">
        <View className="flex-1">
          <Text className="font-display text-base text-ink">City Launch Fund</Text>
          <Text className="text-xs text-muted">
            Skims received {formatCents(fund.skimsReceivedCents)} − grants made{" "}
            {formatCents(fund.launchGrantsMadeCents)}
          </Text>
        </View>
        <Button
          title="Record transfer"
          icon="plus"
          size="sm"
          variant="secondary"
          onPress={onRecordTransfer}
        />
      </View>
      <Text
        className="font-display text-2xl text-ink"
        style={{ fontVariant: ["tabular-nums"] }}
      >
        {formatCents(fund.positionCents)}
      </Text>
      {fund.periodNetCents !== 0 ? (
        <Text className="mt-1 text-xs text-muted">
          {fund.periodNetCents > 0 ? "+" : ""}
          {formatCents(fund.periodNetCents)} this period
        </Text>
      ) : null}
    </View>
  );
}

// WP-4.5: "Your card determines whose account paid; reconcile determines
// whose budget it was; Central settles the difference monthly alongside the
// skim." Only chapters with a NONZERO net render a row — a zero balance is
// nothing to settle. Positive `netCents` = central owes the chapter; negative
// = the chapter owes central (displayed with `Math.abs`).
function InterScopeBalancesSection({
  year,
  month,
  onSettle,
}: {
  year: number;
  month: number;
  onSettle: (chapterId: Id<"chapters">, chapterName: string, netCents: number) => void;
}) {
  const balances =
    useQuery(api.transfers.interScopeBalances, { year, month }) ?? [];
  const owed = balances.filter((b) => b.netCents !== 0);
  if (owed.length === 0) return null;
  return (
    <View className="mb-3 rounded-lg border border-border bg-raised p-4 shadow-card">
      <Text className="font-display text-base text-ink">Inter-chapter balances</Text>
      <Text className="mb-3 text-xs text-muted">
        Settle alongside the monthly skim.
      </Text>
      <View className="gap-2">
        {owed.map((b) => (
          <View
            key={b.chapterId}
            className="flex-row items-center justify-between gap-3"
          >
            <Text className="flex-1 text-sm text-ink" numberOfLines={2}>
              {b.netCents > 0
                ? `Central owes ${b.chapterName} ${formatCents(b.netCents)}`
                : `${b.chapterName} owes central ${formatCents(Math.abs(b.netCents))}`}
            </Text>
            <Button
              title="Settle"
              size="sm"
              variant="secondary"
              onPress={() => onSettle(b.chapterId, b.chapterName, b.netCents)}
            />
          </View>
        ))}
      </View>
    </View>
  );
}

// Non-navigable summary row for the "Central" row in the by-chapter rollup —
// see the CentralView doc comment above for why it isn't drillable.
function CentralRollupRow({ c }: { c: ChapterRollup }) {
  return (
    <View className="rounded-lg border border-border bg-raised p-4 shadow-card">
      <View className="mb-2 flex-row items-start justify-between gap-3">
        <View className="flex-1">
          <Text className="font-display text-base text-ink" numberOfLines={1}>
            {c.chapterName}
          </Text>
          <Text className="text-xs text-muted">Org-wide — see central budgets above</Text>
        </View>
        <Text className="text-sm text-muted" style={{ fontVariant: ["tabular-nums"] }}>
          {formatCents(c.spentCents)} / {formatCents(c.budgetCents)}
        </Text>
      </View>
      <BudgetBar pct={c.barPct} status={c.status} />
    </View>
  );
}

function CentralBudgetCard({ b, onEdit }: { b: CentralBudget; onEdit: () => void }) {
  const router = useRouter();
  // WP-wave4 (item 6): see `ChapterView`'s `ProjectBudgetCard` for the full
  // reasoning — spend vs REQUESTED while awaiting a decision on a $0 cap.
  const display = awaitingApprovalZeroCapDisplay(b);
  return (
    <View className="min-w-[260px] flex-1 rounded-lg border border-border bg-raised p-4 shadow-card">
      <View className="mb-2 flex-row items-start justify-between gap-2">
        <View className="flex-1">
          <View className="flex-row flex-wrap items-center gap-2">
            <Text className="font-display text-base text-ink" numberOfLines={1}>
              {b.name}
            </Text>
            {/* WP-wave4 (item 4 — deep links): jump to the linked event/project. */}
            {b.refKind && b.scopeRefId ? (
              <Pressable
                onPress={() =>
                  router.push(`/${b.refKind}/${b.scopeRefId}` as never)
                }
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={`Open ${b.refKind}`}
              >
                <Icon name="external-link" size={14} color={colors.muted} />
              </Pressable>
            ) : null}
          </View>
          {b.dateLabel ? <Text className="mt-0.5 text-xs text-muted">{b.dateLabel}</Text> : null}
          <View className="mt-1 flex-row flex-wrap items-center gap-1.5">
            <Chip label={BUDGET_CADENCE_LABELS[b.cadence]} />
            <BudgetApprovalChip
              status={b.approvalStatus}
              approvedCents={b.approvedCents}
              requestedCents={b.requestedCents}
              approvalParty={b.approvalParty}
            />
          </View>
        </View>
        <Text
          className="text-sm text-muted"
          style={{ fontVariant: ["tabular-nums"] }}
        >
          {formatCents(b.spentCents)} / {formatCents(display.budgetCents)}
          {display.isAwaitingApproval ? " (requested)" : ""}
        </Text>
      </View>
      <BudgetBar pct={display.pct} status={display.status} />
      <Text className="mt-1.5 text-xs text-muted">
        {display.pct}% {display.isAwaitingApproval ? "of requested" : "spent"}
      </Text>
      {b.reviewNote && b.approvalStatus === "changes_requested" ? (
        <Text className="mt-2 text-xs text-danger">"{b.reviewNote}"</Text>
      ) : null}
      <View className="mt-3 flex-row items-center justify-between gap-2">
        <Button title="Edit budget" variant="ghost" size="sm" onPress={onEdit} />
        <BudgetApprovalActions budgetId={b.id} status={b.approvalStatus} />
      </View>
    </View>
  );
}

function ChapterRollupCard({ c, onView }: { c: ChapterRollup; onView: () => void }) {
  return (
    <Pressable
      onPress={onView}
      accessibilityRole="button"
      className="rounded-lg border border-border bg-raised p-4 shadow-card active:bg-sunken web:hover:border-border-strong"
    >
      <View className="mb-2 flex-row items-start justify-between gap-3">
        <View className="flex-1">
          <Text className="font-display text-base text-ink" numberOfLines={1}>
            {c.chapterName}
          </Text>
          {c.subtitle ? <Text className="text-xs text-muted">{c.subtitle}</Text> : null}
        </View>
        <View className="flex-row items-center gap-2">
          <Text className="text-sm text-muted" style={{ fontVariant: ["tabular-nums"] }}>
            {formatCents(c.spentCents)} / {formatCents(c.budgetCents)}
          </Text>
          <Icon name="chevron-right" size={16} color={colors.muted} />
        </View>
      </View>
      <BudgetBar pct={c.barPct} status={c.status} />
    </Pressable>
  );
}
