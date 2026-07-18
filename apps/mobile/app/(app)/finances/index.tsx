/**
 * FINANCES · Dashboard — the money home, rendered at the desk the caller
 * ACTUALLY sits at. `api.financeRoles.mySeats` resolves their real seats from
 * `financeRoles` grants (+ the superuser allowlist): a central seat renders the
 * org-wide roll-up, a chapter seat renders that chapter's dashboard. There is
 * no "Preview as" role simulation — nobody sees a desk they don't hold.
 *
 * No finance seat: the member tab bar (`_layout.tsx`, D3) doesn't even show
 * this Dashboard tab — a no-seat caller lands on My Card / My Transactions /
 * Reimbursements instead. A no-seat caller who deep-links (or double-taps
 * back) onto this index route anyway is redirected to `/finances/cards` (My
 * Card) so they always land on a tab the member bar actually highlights,
 * rather than an orphaned `MemberView` with no active tab.
 *
 * WP-S: which desk is active — and the central → chapter drill-down (#131) —
 * is now the APP-WIDE `ChapterContext`, not local state. Dual-hat holders (a
 * central seat AND ≥1 chapter seat) switch desks from the shell's context
 * pill, not a switcher on this screen; a central seat holder's drill-down
 * from the "By chapter" roll-up is the same thing as entering the shell's
 * read-only Peek mode, so `onViewChapter` sets that global state directly —
 * the persistent shell banner (with its own Exit) replaces the old inline
 * "Viewing X's dashboard / Back to Central" box this screen used to render.
 *
 * Kept behind an admin-or-lead nav gate AND this in-screen tier guard; the real
 * capability check is the backend `financeRoles` ladder, so each query is
 * wrapped in a boundary that degrades to a friendly "access needed" state if
 * the viewer lacks a finance grant (the read throws a `ConvexError`).
 *
 * Sub-nav tabs + the app chrome come from the finances `_layout`; this screen
 * renders only the Dashboard body.
 */
import { useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { useQuery } from "convex/react";
import { Redirect, useRouter } from "expo-router";
import type { FunctionReturnType } from "convex/server";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { CENTRAL } from "@events-os/shared";
import { Button, EmptyState, Narrow, Screen } from "../../../components/ui";
import { colors } from "../../../lib/theme";
import { useChapterContext } from "../../../lib/ChapterContext";
import {
  FinanceBoundary,
  MonthStepper,
  PeriodSwitch,
  type DashPeriodMode,
} from "../../../components/finance/dashboard/parts";
import { ChapterView } from "../../../components/finance/dashboard/ChapterView";
import { CentralView } from "../../../components/finance/dashboard/CentralView";
import { BudgetCreateModal } from "../../../components/finance/modals/BudgetCreateModal";
import { ManualTransactionModal } from "../../../components/finance/modals/ManualTransactionModal";
import { BackerCountModal } from "../../../components/finance/modals/BackerCountModal";
import { TransferRecordModal } from "../../../components/finance/modals/TransferRecordModal";
import { MilestoneLadderModal } from "../../../components/finance/modals/MilestoneLadderModal";

type Seats = FunctionReturnType<typeof api.financeRoles.mySeats>;

export default function FinancesScreen() {
  const org = useQuery(api.org.nav);
  // The caller's REAL seats, central first. [] = member. Queried here (rather
  // than in DashboardBody) so the no-seat redirect below can run BEFORE the
  // tier gate — a plain-member caller with no finance seat must be routed to
  // My Card, not shown "Finances is restricted" (that message is for staff
  // below the finance tier, not a no-seat member who deep-links here).
  const seats = useQuery(api.financeRoles.mySeats, {});

  if (org === undefined || seats === undefined) return <Screen loading />;

  // No finance seat → send them to My Card, their actual entry point in the
  // member tab bar, instead of an orphaned MemberView with no active tab here.
  if (seats.length === 0) {
    return <Redirect href="/finances/cards" />;
  }

  // In-screen guard: finance is admin-or-lead for now (mirrors the nav gate).
  const tier = org.tier;
  if (tier !== "admin" && tier !== "lead") {
    return (
      <Screen>
        <Narrow>
          <EmptyState
            title="Finances is restricted"
            message="Only chapter admins and leads can access finances."
          />
        </Narrow>
      </Screen>
    );
  }

  return <DashboardBody seats={seats} />;
}

function LoadingBlock() {
  return (
    <View className="items-center justify-center py-16">
      <ActivityIndicator color={colors.accent} />
    </View>
  );
}

function NoFinanceAccess() {
  return (
    <EmptyState
      icon="lock"
      title="Finance access needed"
      message="Ask a finance manager to grant you access to see this dashboard."
    />
  );
}

function DashboardBody({ seats }: { seats: Seats }) {
  const router = useRouter();
  const now = new Date();
  const [ym, setYm] = useState({ year: now.getFullYear(), month: now.getMonth() + 1 });
  const [period, setPeriod] = useState<DashPeriodMode>("month");

  // WP-S: the desk the caller is at, app-wide — the shell's context pill sets
  // this, not a control on this screen. `context` is guaranteed non-null here:
  // `FinancesScreen` already confirmed `seats.length > 0` before mounting
  // `DashboardBody`, and `ChapterContext` only returns null for a no-seat
  // caller (or while `mySeats` is still loading, which resolved above too).
  const { context, enterPeek } = useChapterContext();

  const [budgetModal, setBudgetModal] = useState<{
    open: boolean;
    id: Id<"budgets"> | null;
    // Opened from the CENTRAL desk's "New budget" action — preset + lock the
    // modal to the central scope (see `BudgetCreateModal`'s `forceCentral`).
    central: boolean;
  }>({ open: false, id: null, central: false });
  const [txnModalOpen, setTxnModalOpen] = useState(false);
  // Backer milestone ladder editor (giving-platform PRD §3), central desk only.
  const [milestoneModalOpen, setMilestoneModalOpen] = useState(false);
  // City Launch Fund transfer modal (central desk). Carries the real chapters
  // money can move to/from (from the central dashboard's rollup). `preset`
  // (WP-4.5) is set when opened from the "Inter-chapter balances" section's
  // "Settle" affordance — presets the modal straight to that settlement.
  const [transferModal, setTransferModal] = useState<{
    open: boolean;
    chapters: Array<{ chapterId: Id<"chapters">; chapterName: string }>;
    preset?: {
      chapterId: Id<"chapters">;
      year: number;
      month: number;
      amountCents: number;
      settlementDirection: "central_to_chapter" | "chapter_to_central";
    };
  }>({ open: false, chapters: [] });

  const isPeeking = context?.kind === "peek";

  // Attention-row actions: all three kinds live on their own finance tab,
  // hard-scoped to the CALLER's own chapter — never call this while peeking
  // into a different chapter (ChapterView already hides the action in that
  // state; this is a defensive no-op, not the primary guard).
  function onAttentionAction(kind: string) {
    if (isPeeking) return;
    if (kind === "reimbursements") router.navigate("/finances/reimbursements" as never);
    else if (kind === "cards") router.navigate("/finances/cards" as never);
    // Unattributed spend → Reconcile, which already defaults to the
    // `needs_budget` filter.
    else if (kind === "needs_budget") router.navigate("/finances/reconcile" as never);
  }

  // Defensive no-op mirroring `onAttentionAction` above — `ChapterView`
  // already hides every "Edit budget" affordance while peeking
  // (`isDrilldown`), so this shouldn't fire, but the modal's save resolves
  // the CALLER's own chapter server-side regardless of which budget id it's
  // opened with, so opening it here while peeking would still set up a
  // guaranteed-to-fail edit.
  function onEditBudget(id: string) {
    if (isPeeking) return;
    setBudgetModal({ open: true, id: id as Id<"budgets">, central: false });
  }

  // WP-wave4 (item 1): the central desk's own "Edit budget" — `central: true`
  // so `BudgetCreateModal` locks the level field the same way `onNewBudget`
  // (central) does; the modal already handles edit-vs-create via `id`.
  function onEditCentralBudget(id: string) {
    setBudgetModal({ open: true, id: id as Id<"budgets">, central: true });
  }

  // `seats` is guaranteed defined and non-empty here — FinancesScreen already
  // resolved the loading state and redirected a no-seat caller before
  // DashboardBody ever mounts.
  const centralSeat = seats.find((s) => s.scope === "central") ?? null;

  // The chapter dashboard's chapterId: the peeked chapter, or the caller's
  // own chapter seat (undefined when the desk isn't a chapter seat — e.g. a
  // central-only holder before they've entered Peek — `dashboardChapter`
  // falls back to the caller's own chapter server-side in that case).
  const chapterId: Id<"chapters"> | undefined =
    context?.kind === "peek"
      ? context.chapterId
      : context?.kind === "seat" && context.scope !== "central"
        ? context.scope
        : undefined;

  const atCentralDesk = context?.kind === "seat" && context.scope === "central";

  // DASH-3: the SAME {year, month, period} setter both dashboards' own
  // click-to-filter bar charts drive (`ChapterView`'s spend-by-month bars,
  // `CentralView`'s org-wide ones) — one state, no second control.
  function handleChangePeriod(next: { year: number; month: number; period: DashPeriodMode }) {
    setYm({ year: next.year, month: next.month });
    setPeriod(next.period);
  }

  return (
    <Screen>
      <Narrow>
        {/* Controls: month stepper + Month/YTD toggle, plus — at the central
            desk only — "New budget" (DASH-3: moved out of mid-page into this
            header row). Which desk you're at is the shell's context pill
            now, not a control on this screen. */}
        <View className="mb-4 flex-row flex-wrap items-center justify-between gap-3">
          <View className="flex-row flex-wrap items-center gap-2">
            <MonthStepper year={ym.year} month={ym.month} period={period} onChange={setYm} />
            <PeriodSwitch value={period} onChange={setPeriod} />
          </View>
          {atCentralDesk ? (
            <View className="flex-row flex-wrap items-center gap-2">
              {/* Giving-platform PRD §3: central finance-manager rank only
                  (the backend re-checks via `requireCentralFinanceRole` on
                  save regardless of this affordance). */}
              {centralSeat?.role === "manager" ? (
                <Button
                  title="Milestone ladder"
                  icon="list"
                  size="sm"
                  variant="secondary"
                  onPress={() => setMilestoneModalOpen(true)}
                />
              ) : null}
              <Button
                title="New budget"
                icon="plus"
                size="sm"
                onPress={() => setBudgetModal({ open: true, id: null, central: true })}
              />
            </View>
          ) : null}
        </View>

        {atCentralDesk ? (
          <FinanceBoundary fallback={<NoFinanceAccess />}>
            <CentralSection
              ym={ym}
              period={period}
              onViewChapter={enterPeek}
              onEditBudget={onEditCentralBudget}
              onChangePeriod={handleChangePeriod}
              onRecordTransfer={(chapters) =>
                setTransferModal({ open: true, chapters })
              }
              onSettle={(chapters, chapterId, netCents) =>
                setTransferModal({
                  open: true,
                  chapters,
                  preset: {
                    chapterId,
                    year: ym.year,
                    month: ym.month,
                    amountCents: Math.abs(netCents),
                    settlementDirection:
                      netCents > 0 ? "central_to_chapter" : "chapter_to_central",
                  },
                })
              }
            />
          </FinanceBoundary>
        ) : (
          // A chapter dashboard: the caller's own chapter seat, or a central
          // seat peeking into another chapter (read-only — the shell banner
          // carries the "Viewing X (read-only)" messaging + Exit now).
          <FinanceBoundary fallback={<NoFinanceAccess />}>
            <ChapterSection
              chapterId={chapterId}
              ym={ym}
              period={period}
              isDrilldown={isPeeking}
              onNewBudget={() => setBudgetModal({ open: true, id: null, central: false })}
              onEditBudget={onEditBudget}
              onAddTransaction={() => setTxnModalOpen(true)}
              onAttentionAction={onAttentionAction}
              onChangePeriod={handleChangePeriod}
            />
          </FinanceBoundary>
        )}
      </Narrow>

      {budgetModal.open ? (
        <BudgetCreateModal
          budgetId={budgetModal.id}
          defaultYear={ym.year}
          defaultMonth={ym.month}
          canCentral={centralSeat != null}
          forceCentral={budgetModal.central}
          onClose={() => setBudgetModal({ open: false, id: null, central: false })}
        />
      ) : null}

      {txnModalOpen ? (
        <ManualTransactionModal onClose={() => setTxnModalOpen(false)} />
      ) : null}

      {milestoneModalOpen ? (
        <MilestoneLadderModal onClose={() => setMilestoneModalOpen(false)} />
      ) : null}

      {transferModal.open ? (
        <TransferRecordModal
          chapters={transferModal.chapters}
          preset={transferModal.preset}
          onClose={() => setTransferModal({ open: false, chapters: [] })}
        />
      ) : null}
    </Screen>
  );
}

// ── Query sections (each isolated so a finance-role throw is caught locally) ──

function CentralSection({
  ym,
  period,
  onViewChapter,
  onEditBudget,
  onChangePeriod,
  onRecordTransfer,
  onSettle,
}: {
  ym: { year: number; month: number };
  period: DashPeriodMode;
  onViewChapter: (chapterId: Id<"chapters">, chapterName: string) => void;
  onEditBudget: (budgetId: string) => void;
  /** DASH-3: a spend-by-month bar click sets this — the SAME state the
   *  page's ‹ › picker / Month-YTD toggle drive (mirrors `ChapterSection`). */
  onChangePeriod: (next: { year: number; month: number; period: DashPeriodMode }) => void;
  onRecordTransfer: (
    chapters: Array<{ chapterId: Id<"chapters">; chapterName: string }>,
  ) => void;
  onSettle: (
    chapters: Array<{ chapterId: Id<"chapters">; chapterName: string }>,
    chapterId: Id<"chapters">,
    netCents: number,
  ) => void;
}) {
  const data = useQuery(api.finances.dashboardCentral, { ...ym, period });
  // DASH-3: the org-wide bar chart + KPI sparkline (the SAME query result
  // backs both — see `CentralView`'s module doc).
  const monthly = useQuery(api.dashboardCharts.spendByMonth, { scope: "org", year: ym.year });
  // DASH-3: the "Chapters at a glance" fleet panel.
  const chapterHealth = useQuery(api.dashboardCharts.chapterHealth, {});
  if (data === undefined) return <LoadingBlock />;
  // The "By chapter" rollup leads with the Central row (chapterId === CENTRAL);
  // the transfer picker only wants the real chapters.
  const realChapters = data.chapterRollup
    .filter(
      (c): c is (typeof c) & { chapterId: Id<"chapters"> } =>
        c.chapterId !== CENTRAL,
    )
    .map((c) => ({ chapterId: c.chapterId, chapterName: c.chapterName }));
  return (
    <CentralView
      data={data}
      monthly={monthly}
      chapterHealth={chapterHealth}
      year={ym.year}
      month={ym.month}
      period={period}
      onViewChapter={onViewChapter}
      onEditBudget={onEditBudget}
      onChangePeriod={onChangePeriod}
      onRecordTransfer={() => onRecordTransfer(realChapters)}
      onSettle={(chapterId, _chapterName, netCents) =>
        onSettle(realChapters, chapterId, netCents)
      }
    />
  );
}

function ChapterSection({
  chapterId,
  ym,
  period,
  isDrilldown,
  onNewBudget,
  onEditBudget,
  onAddTransaction,
  onAttentionAction,
  onChangePeriod,
}: {
  chapterId: Id<"chapters"> | undefined;
  ym: { year: number; month: number };
  period: DashPeriodMode;
  isDrilldown: boolean;
  onNewBudget: () => void;
  onEditBudget: (budgetId: string) => void;
  onAddTransaction: () => void;
  onAttentionAction: (kind: string) => void;
  /** DASH-2: a spend-by-month bar click sets this — the SAME state the
   *  page's ‹ › picker / Month-YTD toggle drive. */
  onChangePeriod: (next: { year: number; month: number; period: DashPeriodMode }) => void;
}) {
  const data = useQuery(api.finances.dashboardChapter, { chapterId, ...ym, period });
  // Separate query (WP-4.3): its own loading state never blocks the rest of
  // the dashboard — `ChapterView`/`AffordabilityHeader` renders nothing until
  // it resolves.
  const affordability = useQuery(api.finances.chapterAffordability, { chapterId });
  // DASH-2: the spend-by-month chart + KPI sparkline. Skipped until
  // `chapterId` resolves (a central-only holder before entering Peek has no
  // chapter scope to chart — `dashboardChapter`/`chapterAffordability` fall
  // back to the caller's own chapter server-side, but `spendByMonth` takes a
  // required `scope` arg with no such fallback).
  const monthly = useQuery(
    api.dashboardCharts.spendByMonth,
    chapterId ? { scope: chapterId, year: ym.year } : "skip",
  );
  const [editingBackerCount, setEditingBackerCount] = useState(false);

  if (data === undefined) return <LoadingBlock />;
  return (
    <>
      <ChapterView
        data={data}
        affordability={affordability}
        monthly={monthly}
        year={ym.year}
        month={ym.month}
        period={period}
        onNewBudget={onNewBudget}
        onEditBudget={onEditBudget}
        onAddTransaction={onAddTransaction}
        onAttentionAction={onAttentionAction}
        onEditBackerCount={() => setEditingBackerCount(true)}
        onChangePeriod={onChangePeriod}
        isDrilldown={isDrilldown}
      />
      {editingBackerCount ? (
        <BackerCountModal
          currentCount={affordability?.backerCount ?? 0}
          onClose={() => setEditingBackerCount(false)}
        />
      ) : null}
    </>
  );
}
