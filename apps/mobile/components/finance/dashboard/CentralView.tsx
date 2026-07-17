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
import { useRouter, type Router } from "expo-router";
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

      {/* Org-wide Unattributed: this period's spend across every chapter (+
          central itself) with no explicit budget link — every central budget
          card below is BLIND to it (no derive-matching fallback exists — see
          WP-0.1). Tappable: expands into the actual rows (WP-dashboard-drill),
          backed by `dashboardDrill.orgUnattributedTransactions`. */}
      <UnattributedSection
        cents={data.orgUnattributedCents}
        year={year}
        month={month}
        period={period}
        onViewChapter={onViewChapter}
      />

      {/* WP-3.2 FM/ED oversight: a count of budgets awaiting a decision,
          across every chapter + central. Tappable: expands into the actual
          budgets (WP-dashboard-drill), backed by
          `dashboardDrill.pendingBudgetApprovals`. The 85% principle still
          holds — chapter budgets are approved BY the Chapter Director (a
          chapter row here peeks into that chapter's own dashboard, where the
          decision lives); only a central budget's own card (below, or via
          this list's central rows) offers a decision on THIS screen. */}
      <PendingApprovalsSection
        count={data.pendingBudgetApprovalsCount}
        onViewChapter={onViewChapter}
        onEditBudget={onEditBudget}
      />

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

// ── Unattributed banner, drilled down (WP-dashboard-drill) ──────────────────

type UnattributedTxnRow =
  FunctionReturnType<typeof api.dashboardDrill.orgUnattributedTransactions>["rows"][number];

// Org-wide Unattributed: this period's spend across every chapter (+ central
// itself) with no explicit budget link — every central budget card is BLIND
// to it (no derive-matching fallback exists — see WP-0.1). Tappable; the
// detail query only fires once expanded (`"skip"` otherwise).
function UnattributedSection({
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
  const detail = useQuery(
    api.dashboardDrill.orgUnattributedTransactions,
    expanded ? { year, month, period } : "skip",
  );
  if (cents <= 0) return null;
  return (
    <View className="mb-3 rounded-lg border border-warn bg-warn-bg p-4 shadow-card">
      <Pressable
        onPress={() => setExpanded((e) => !e)}
        accessibilityRole="button"
        className="flex-row items-center gap-3"
      >
        <View className="flex-1">
          <Text className="text-sm font-semibold text-ink">
            Unattributed: {formatCents(cents)}
          </Text>
          <Text className="text-xs text-muted">
            Org-wide spend this period with no budget attached — chase each
            chapter's Treasurer to code it in Reconcile.
          </Text>
        </View>
        <Icon
          name={expanded ? "chevron-up" : "chevron-down"}
          size={16}
          color={colors.muted}
        />
      </Pressable>
      {expanded ? (
        <View className="mt-3 gap-2 border-t border-border pt-3">
          {detail === undefined ? (
            <Text className="text-xs text-muted">Loading…</Text>
          ) : detail.rows.length === 0 ? (
            <Text className="text-xs text-muted">Nothing unattributed.</Text>
          ) : (
            <>
              {detail.rows.map((row) => (
                <UnattributedTxnRowView
                  key={row.id}
                  row={row}
                  router={router}
                  onViewChapter={onViewChapter}
                />
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
      <Text className="flex-1 text-xs text-ink" numberOfLines={1}>
        {row.chapterName} · {row.date} · {label} · {formatCents(row.amountCents)}
      </Text>
      {row.chapterId === CENTRAL ? (
        // Central-owned rows are fully correct today — any central-reach
        // caller already gets the right central-scoped Reconcile queue, no
        // peek needed (see `reconcile.tsx`'s new `scope`/`filter` params).
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
        // Real-chapter rows: PEEK, then navigate straight to Reconcile —
        // Phase 2 (WP-A/#228 shipped `listReconcile`'s central-gated
        // `chapterId` arg, mirroring `dashboardChapter`'s own drill-down).
        // `reconcile.tsx` reads the SAME `useChapterContext()` peek state
        // this `enterPeek` call sets and threads it into `listReconcile`, so
        // the screen that mounts after this navigation shows THIS chapter's
        // queue, not the caller's own home chapter's.
        <Pressable
          // Safe cast: this branch only renders when `row.chapterId !== CENTRAL`
          // above, but that narrowing doesn't persist into this closure (a TS
          // limitation, not a runtime one).
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

// ── Awaiting-approval banner, drilled down (WP-dashboard-drill) ─────────────

type PendingApprovalRow = FunctionReturnType<typeof api.dashboardDrill.pendingBudgetApprovals>[number];

// WP-3.2 FM/ED oversight: a count of budgets awaiting a decision, across
// every chapter + central. Tappable; the detail query only fires once
// expanded. A chapter row peeks into that chapter's own dashboard (where the
// decision is actually made — `dashboardChapter` is peek-aware, no gap here);
// a central row reuses the existing `onEditBudget` — the same "Edit budget"
// path `CentralBudgetCard` already opens, which surfaces
// `BudgetApprovalActions` (Approve / Request changes).
function PendingApprovalsSection({
  count,
  onViewChapter,
  onEditBudget,
}: {
  count: number;
  onViewChapter: (chapterId: Id<"chapters">, chapterName: string) => void;
  onEditBudget: (budgetId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const rows = useQuery(api.dashboardDrill.pendingBudgetApprovals, expanded ? {} : "skip");
  if (count <= 0) return null;
  return (
    <View className="mb-3 rounded-lg border border-accent bg-accent-soft p-4 shadow-card">
      <Pressable
        onPress={() => setExpanded((e) => !e)}
        accessibilityRole="button"
        className="flex-row items-center gap-3"
      >
        <View className="flex-1">
          <Text className="text-sm font-semibold text-ink">
            {count === 1 ? "1 budget awaiting approval" : `${count} budgets awaiting approval`}
          </Text>
          <Text className="text-xs text-muted">
            Across every chapter + central — chapter budgets are decided on
            their own chapter's dashboard; central budgets right below.
          </Text>
        </View>
        <Icon
          name={expanded ? "chevron-up" : "chevron-down"}
          size={16}
          color={colors.muted}
        />
      </Pressable>
      {expanded ? (
        <View className="mt-3 gap-2 border-t border-border pt-3">
          {rows === undefined ? (
            <Text className="text-xs text-muted">Loading…</Text>
          ) : (
            rows.map((b) => (
              <PendingApprovalRowView
                key={b.budgetId}
                row={b}
                onViewChapter={onViewChapter}
                onEditBudget={onEditBudget}
              />
            ))
          )}
        </View>
      ) : null}
    </View>
  );
}

function PendingApprovalRowView({
  row,
  onViewChapter,
  onEditBudget,
}: {
  row: PendingApprovalRow;
  onViewChapter: (chapterId: Id<"chapters">, chapterName: string) => void;
  onEditBudget: (budgetId: string) => void;
}) {
  return (
    <Pressable
      onPress={() =>
        row.chapterId === CENTRAL
          ? onEditBudget(row.budgetId)
          : onViewChapter(row.chapterId, row.chapterName)
      }
      accessibilityRole="button"
      className="flex-row items-center justify-between gap-3"
    >
      <Text className="flex-1 text-xs text-ink" numberOfLines={1}>
        {row.name} · {row.chapterName}
      </Text>
      <Text className="text-xs text-muted" style={{ fontVariant: ["tabular-nums"] }}>
        {formatCents(row.amountCents)}
      </Text>
      <Icon name="chevron-right" size={14} color={colors.muted} />
    </Pressable>
  );
}

type CityLaunchFund = CentralDash["cityLaunchFund"];

// WP-dashboard-drill (owner addendum 2026-07-17): the owner's actual
// confusion with this card isn't its size (the empty state is already
// compact) — it's WHAT the fund is. One quiet explainer line, present in
// BOTH the empty and active card, grounded in the City Launch Playbook model
// (see docs/plans/finance-v2-split-prd.md §0.1: "~15% skim, chapter → central
// City Launch Fund, monthly" UP, "one-time launch grant, central → new
// chapter (equipment + training trip)" DOWN).
const CITY_LAUNCH_FUND_EXPLAINER =
  "Collects the ~15% monthly skim from each chapter; pays out as a one-time grant when a new city launches.";

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
        <View className="flex-1">
          <Text className="text-sm text-muted">No City Launch Fund activity yet.</Text>
          <Text className="mt-0.5 text-2xs text-faint">{CITY_LAUNCH_FUND_EXPLAINER}</Text>
        </View>
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
          <Text className="mt-0.5 text-2xs text-faint">{CITY_LAUNCH_FUND_EXPLAINER}</Text>
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

const CONTRIBUTOR_DIRECTION_LABEL: Record<
  FunctionReturnType<typeof api.transfers.interScopeBalanceContributors>[number]["direction"],
  string
> = {
  central_owes_chapter: "chapter spend → central budget",
  chapter_owes_central: "central spend → chapter budget",
  settlement_central_to_chapter: "settled — central paid",
  settlement_chapter_to_central: "settled — chapter paid",
};

// WP-4.5: "Your card determines whose account paid; reconcile determines
// whose budget it was; Central settles the difference monthly alongside the
// skim." Only chapters with a NONZERO net render a row — a zero balance is
// nothing to settle. Positive `netCents` = central owes the chapter; negative
// = the chapter owes central (displayed with `Math.abs`). Each row expands
// (WP-dashboard-drill) into the actual transactions/settlement legs behind
// the number, via `transfers.interScopeBalanceContributors`.
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
  const [expandedChapterId, setExpandedChapterId] = useState<Id<"chapters"> | null>(null);
  if (owed.length === 0) return null;
  return (
    <View className="mb-3 rounded-lg border border-border bg-raised p-4 shadow-card">
      <Text className="font-display text-base text-ink">Inter-chapter balances</Text>
      <Text className="text-xs text-muted">Settle alongside the monthly skim.</Text>
      <Text className="mb-3 text-2xs text-faint">
        Settle opens a confirmation — record a transfer made outside the app, or
        initiate a real one.
      </Text>
      <View className="gap-2">
        {owed.map((b) => {
          const expanded = expandedChapterId === b.chapterId;
          return (
            <View key={b.chapterId}>
              {/* Toggle (Pressable) and Settle (Button) are SIBLINGS, not
                  nested — a Button nested inside a Pressable is a
                  double-touchable trap on RN Web (the DOM click bubbles to
                  BOTH handlers). */}
              <View className="flex-row items-center justify-between gap-3">
                <Pressable
                  onPress={() => setExpandedChapterId(expanded ? null : b.chapterId)}
                  accessibilityRole="button"
                  className="flex-1 flex-row items-center gap-1.5"
                >
                  <Icon
                    name={expanded ? "chevron-down" : "chevron-right"}
                    size={14}
                    color={colors.muted}
                  />
                  <Text className="flex-1 text-sm text-ink" numberOfLines={2}>
                    {b.netCents > 0
                      ? `Central owes ${b.chapterName} ${formatCents(b.netCents)}`
                      : `${b.chapterName} owes central ${formatCents(Math.abs(b.netCents))}`}
                  </Text>
                </Pressable>
                <Button
                  title="Settle"
                  size="sm"
                  variant="secondary"
                  onPress={() => onSettle(b.chapterId, b.chapterName, b.netCents)}
                />
              </View>
              {expanded ? (
                <InterScopeContributorsList chapterId={b.chapterId} />
              ) : null}
            </View>
          );
        })}
      </View>
    </View>
  );
}

function InterScopeContributorsList({ chapterId }: { chapterId: Id<"chapters"> }) {
  const contributors = useQuery(api.transfers.interScopeBalanceContributors, { chapterId });
  return (
    <View className="ml-5 mt-2 gap-1.5 border-l border-border pl-3">
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
            <Text
              className="text-2xs text-muted"
              style={{ fontVariant: ["tabular-nums"] }}
            >
              {formatCents(row.amountCents)}
            </Text>
          </View>
        ))
      )}
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
