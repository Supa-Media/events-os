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
import { EmptyState, Narrow, Screen } from "../../../components/ui";
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
  // City Launch Fund transfer modal (central desk). Carries the real chapters
  // money can move to/from (from the central dashboard's rollup).
  const [transferModal, setTransferModal] = useState<{
    open: boolean;
    chapters: Array<{ chapterId: Id<"chapters">; chapterName: string }>;
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

  return (
    <Screen>
      <Narrow>
        {/* Controls: month stepper + Month/YTD toggle. Which desk you're at is
            the shell's context pill now, not a control on this screen. */}
        <View className="mb-4 flex-row flex-wrap items-center justify-between gap-3">
          <View className="flex-row flex-wrap items-center gap-2">
            <MonthStepper year={ym.year} month={ym.month} period={period} onChange={setYm} />
            <PeriodSwitch value={period} onChange={setPeriod} />
          </View>
        </View>

        {atCentralDesk ? (
          <FinanceBoundary fallback={<NoFinanceAccess />}>
            <CentralSection
              ym={ym}
              period={period}
              onViewChapter={enterPeek}
              onNewBudget={() => setBudgetModal({ open: true, id: null, central: true })}
              onRecordTransfer={(chapters) =>
                setTransferModal({ open: true, chapters })
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
              onEditBudget={(id) =>
                setBudgetModal({ open: true, id: id as Id<"budgets">, central: false })
              }
              onAddTransaction={() => setTxnModalOpen(true)}
              onAttentionAction={onAttentionAction}
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

      {transferModal.open ? (
        <TransferRecordModal
          chapters={transferModal.chapters}
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
  onNewBudget,
  onRecordTransfer,
}: {
  ym: { year: number; month: number };
  period: DashPeriodMode;
  onViewChapter: (chapterId: Id<"chapters">, chapterName: string) => void;
  onNewBudget: () => void;
  onRecordTransfer: (
    chapters: Array<{ chapterId: Id<"chapters">; chapterName: string }>,
  ) => void;
}) {
  const data = useQuery(api.finances.dashboardCentral, { ...ym, period });
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
      onViewChapter={onViewChapter}
      onNewBudget={onNewBudget}
      onRecordTransfer={() => onRecordTransfer(realChapters)}
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
}: {
  chapterId: Id<"chapters"> | undefined;
  ym: { year: number; month: number };
  period: DashPeriodMode;
  isDrilldown: boolean;
  onNewBudget: () => void;
  onEditBudget: (budgetId: string) => void;
  onAddTransaction: () => void;
  onAttentionAction: (kind: string) => void;
}) {
  const data = useQuery(api.finances.dashboardChapter, { chapterId, ...ym, period });
  // Separate query (WP-4.3): its own loading state never blocks the rest of
  // the dashboard — `ChapterView`/`AffordabilityHeader` renders nothing until
  // it resolves.
  const affordability = useQuery(api.finances.chapterAffordability, { chapterId });
  const [editingBackerCount, setEditingBackerCount] = useState(false);

  if (data === undefined) return <LoadingBlock />;
  return (
    <>
      <ChapterView
        data={data}
        affordability={affordability}
        onNewBudget={onNewBudget}
        onEditBudget={onEditBudget}
        onAddTransaction={onAddTransaction}
        onAttentionAction={onAttentionAction}
        onEditBackerCount={() => setEditingBackerCount(true)}
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
