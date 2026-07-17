/**
 * Central perspective of the finance dashboard — the org-wide roll-up: global
 * KPI tiles, central budgets, an interactive "By tag" breakdown (each tag's
 * org-wide spend, tappable to the contributing budgets), and a "By chapter"
 * list (each chapter's month spend against its budget). Pure presentation over
 * `api.finances.dashboardCentral`.
 */
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import {
  BUDGET_CADENCE_LABELS,
  BUDGET_SCOPE_LABELS,
  CENTRAL,
  formatCents,
} from "@events-os/shared";
import { Button, EmptyState, Icon, SectionHeader } from "../../ui";
import { colors } from "../../../lib/theme";
import { BudgetBar, Chip, Tile, TileRow } from "./parts";
import { TagRollupSection, type BudgetSpend, type TagRollup } from "./TagRollup";
import { BudgetApprovalActions, BudgetApprovalChip } from "./BudgetApprovalActions";

type CentralDash = FunctionReturnType<typeof api.finances.dashboardCentral>;
type ChapterRollup = CentralDash["chapterRollup"][number];
type CentralBudget = CentralDash["centralBudgets"][number];

export function CentralView({
  data,
  year,
  onViewChapter,
  onNewBudget,
  onRecordTransfer,
}: {
  data: CentralDash;
  /** The dashboard's currently-selected year (R1d — see `spentByBudgetId`). */
  year: number;
  /** Drill into one chapter's chapter-perspective dashboard (central-only —
   *  the backend re-checks central reach via `dashboardChapter({chapterId})`). */
  onViewChapter: (chapterId: Id<"chapters">, chapterName: string) => void;
  /** Open `BudgetCreateModal` preset + locked to the central scope. */
  onNewBudget: () => void;
  /** Open `TransferRecordModal` (record/initiate a skim in or a grant out). */
  onRecordTransfer: () => void;
}) {
  // The "By chapter" rollup's Central row (chapterId === CENTRAL, always
  // present — see `dashboardCentral`) vs the real per-chapter rows.
  const centralRollupRow = data.chapterRollup.find((c) => c.chapterId === CENTRAL);
  const chapterRows = data.chapterRollup.filter(
    (c): c is ChapterRollup & { chapterId: Id<"chapters"> } => c.chapterId !== CENTRAL,
  );

  // The tag-detail sheet's open/selected tag — CONTROLLED here (not owned by
  // `TagRollupSection`) so `budgetActuals` below can skip until it's actually
  // open (see that query's comment).
  const [selectedTag, setSelectedTag] = useState<TagRollup | null>(null);

  // R1d root cause: the tag-detail sheet's "carrying budgets" list
  // (`listBudgets`) includes the CALLER's OWN chapter budgets too (any
  // one_time/recurring budget sharing the tapped tag's name) — but this map
  // only ever tracked CENTRAL budgets, so a same-named-tag CHAPTER budget had
  // NO entry here at all (not conditional on period — always missing) and
  // `BudgetLine` rendered its spend as a bare "—" next to its real allocation.
  // Backfill from `budgetVsActual` (the caller's own chapter, this year,
  // unfiltered — a genuinely zero-spend budget correctly reports `0`, not
  // absent). Only fetched once the caller actually holds a chapter-scope seat
  // (`mySeats`, itself non-throwing) — `budgetVsActual` requires at least a
  // viewer role in the CALLER's own chapter, which a pure central-only seat
  // holder doesn't have, and this dashboard must never crash on it. Also
  // skipped until the tag-detail sheet is actually open — `spentByBudgetId`
  // (the only consumer of this query) only matters once a tag is tapped, so
  // there's no reason to keep an always-on subscription for the rest of the
  // dashboard's lifetime.
  const seats = useQuery(api.financeRoles.mySeats, {}) ?? [];
  const hasChapterSeat = seats.some((s) => s.scope === "chapter");
  const budgetActuals =
    useQuery(
      api.finances.budgetVsActual,
      hasChapterSeat && selectedTag ? { year } : "skip",
    ) ?? [];

  // Per-central-budget actuals for the tag-detail sheet, keyed by budget id.
  const spentByBudgetId = useMemo(() => {
    const m = new Map<string, BudgetSpend>();
    for (const b of data.centralBudgets)
      m.set(b.id, { spentCents: b.spentCents, budgetCents: b.budgetCents });
    for (const b of budgetActuals) {
      if (b.budgetId && !m.has(b.budgetId)) {
        m.set(b.budgetId, { spentCents: b.actualCents, budgetCents: b.allocatedCents });
      }
    }
    return m;
  }, [data.centralBudgets, budgetActuals]);

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
            <CentralBudgetCard key={b.id} b={b} />
          ))}
        </View>
      )}

      {/* By tag, across chapters — interactive rollup */}
      <TagRollupSection
        rollups={data.tagRollups}
        spentByBudgetId={spentByBudgetId}
        matchMode="name"
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

function CentralBudgetCard({ b }: { b: CentralBudget }) {
  // `scope` is a nullable legacy column on v2 budgets — fall back when absent.
  const name =
    b.label?.trim() || (b.scope ? BUDGET_SCOPE_LABELS[b.scope] : "Central budget");
  return (
    <View className="min-w-[260px] flex-1 rounded-lg border border-border bg-raised p-4 shadow-card">
      <View className="mb-2 flex-row items-start justify-between gap-2">
        <View className="flex-1">
          <Text className="font-display text-base text-ink" numberOfLines={1}>
            {name}
          </Text>
          <View className="mt-1 flex-row flex-wrap items-center gap-1.5">
            <Chip label={BUDGET_CADENCE_LABELS[b.cadence]} />
            <BudgetApprovalChip
              status={b.approvalStatus}
              approvedCents={b.approvedCents}
              amountCents={b.budgetCents}
            />
          </View>
        </View>
        <Text
          className="text-sm text-muted"
          style={{ fontVariant: ["tabular-nums"] }}
        >
          {formatCents(b.spentCents)} / {formatCents(b.budgetCents)}
        </Text>
      </View>
      <BudgetBar pct={b.pct} status={b.status} />
      <Text className="mt-1.5 text-xs text-muted">{b.pct}% spent</Text>
      {b.reviewNote && b.approvalStatus === "changes_requested" ? (
        <Text className="mt-2 text-xs text-danger">"{b.reviewNote}"</Text>
      ) : null}
      <View className="mt-3">
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
