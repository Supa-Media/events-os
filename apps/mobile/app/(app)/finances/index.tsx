/**
 * FINANCES · Dashboard — the money home, rendered at the desk the caller
 * ACTUALLY sits at. `api.financeRoles.mySeats` resolves their real seats from
 * `financeRoles` grants (+ the superuser allowlist): a central seat renders the
 * org-wide roll-up, a chapter seat renders that chapter's dashboard. There is
 * no "Preview as" role simulation — nobody sees a desk they don't hold.
 *
 * No finance seat: the member tab bar (`_layout.tsx`, D3) doesn't even show
 * this Dashboard tab — a no-seat caller lands on My Card / My Transactions /
 * Reimbursements instead. This screen still degrades to a bare "My
 * reimbursements" `MemberView` for a no-seat caller who deep-links here
 * directly (e.g. an admin/lead-tier caller with no finance grant).
 *
 * Dual-hat holders (a central seat AND ≥1 chapter seat — a transition-period
 * state, e.g. ED + Chapter Director today) get a seat switcher listing their
 * real seats; everyone else gets none. Central seat holders can additionally
 * drill into any chapter's dashboard read-only from the "By chapter" roll-up
 * (#131) — the backend re-checks central reach on every such read.
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
import { ActivityIndicator, Text, View } from "react-native";
import { useQuery } from "convex/react";
import { useRouter } from "expo-router";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { Button, EmptyState, Narrow, Screen } from "../../../components/ui";
import { colors } from "../../../lib/theme";
import {
  FinanceBoundary,
  MonthStepper,
  PeriodSwitch,
  SeatSwitcher,
  seatKeyOf,
  type DashPeriodMode,
} from "../../../components/finance/dashboard/parts";
import { ChapterView } from "../../../components/finance/dashboard/ChapterView";
import { CentralView } from "../../../components/finance/dashboard/CentralView";
import { MemberView } from "../../../components/finance/dashboard/MemberView";
import { BudgetCreateModal } from "../../../components/finance/modals/BudgetCreateModal";
import { ManualTransactionModal } from "../../../components/finance/modals/ManualTransactionModal";

export default function FinancesScreen() {
  const org = useQuery(api.org.nav);

  // In-screen guard: finance is admin-or-lead for now (mirrors the nav gate).
  const tier = org?.tier;
  if (org !== undefined && tier !== "admin" && tier !== "lead") {
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

  if (org === undefined) return <Screen loading />;

  return <DashboardBody />;
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

function DashboardBody() {
  const router = useRouter();
  const now = new Date();
  const [ym, setYm] = useState({ year: now.getFullYear(), month: now.getMonth() + 1 });
  const [period, setPeriod] = useState<DashPeriodMode>("month");

  // The caller's REAL seats, central first. [] = member.
  const seats = useQuery(api.financeRoles.mySeats, {});

  // Which seat the caller is at, keyed by `seatKeyOf`. null = the default
  // seat (central when held, else their first chapter seat).
  const [seatKey, setSeatKey] = useState<string | null>(null);

  // Central → chapter drill-down (#131): viewing a DIFFERENT chapter's
  // dashboard than the caller's own (set via the "By chapter" row's tap in
  // Central; the backend re-checks central reach on every `dashboardChapter`
  // call). A central-seat feature — switching seats always clears it.
  const [drilldown, setDrilldown] = useState<{
    chapterId: Id<"chapters">;
    chapterName: string;
  } | null>(null);

  const [budgetModal, setBudgetModal] = useState<{
    open: boolean;
    id: Id<"budgets"> | null;
    // Opened from the CENTRAL desk's "New budget" action — preset + lock the
    // modal to the central scope (see `BudgetCreateModal`'s `forceCentral`).
    central: boolean;
  }>({ open: false, id: null, central: false });
  const [txnModalOpen, setTxnModalOpen] = useState(false);

  // Attention-row actions: all three kinds live on their own finance tab,
  // hard-scoped to the CALLER's own chapter — never call this while drilled
  // into a different chapter (ChapterView already hides the action in that
  // state; this is a defensive no-op, not the primary guard).
  function onAttentionAction(kind: string) {
    if (drilldown) return;
    if (kind === "reimbursements") router.navigate("/finances/reimbursements" as never);
    else if (kind === "cards") router.navigate("/finances/cards" as never);
    // Unattributed spend → Reconcile, which already defaults to the
    // `needs_budget` filter.
    else if (kind === "needs_budget") router.navigate("/finances/reconcile" as never);
  }

  if (seats === undefined) {
    return (
      <Screen>
        <Narrow>
          <LoadingBlock />
        </Narrow>
      </Screen>
    );
  }

  const centralSeat = seats.find((s) => s.scope === "central") ?? null;
  const chapterSeats = seats.filter((s) => s.scope === "chapter");
  // mySeats returns central first, so seats[0] is the default desk.
  const activeSeat = seats.find((s) => seatKeyOf(s) === seatKey) ?? seats[0] ?? null;
  // Dual-hat only: a central seat AND at least one chapter seat.
  const showSwitcher = centralSeat != null && chapterSeats.length > 0;

  function chooseSeat(key: string) {
    setDrilldown(null); // drill-down is central-desk state; a seat pick resets it
    setSeatKey(key);
  }

  function viewChapter(chapterId: Id<"chapters">, chapterName: string) {
    setDrilldown({ chapterId, chapterName });
  }

  function backToCentral() {
    setDrilldown(null);
  }

  const atCentralDesk = activeSeat?.scope === "central";

  return (
    <Screen>
      <Narrow>
        {/* Controls: month stepper + Month/YTD toggle + seat switcher (dual-hat only). */}
        <View className="mb-4 flex-row flex-wrap items-center justify-between gap-3">
          <View className="flex-row flex-wrap items-center gap-2">
            <MonthStepper year={ym.year} month={ym.month} period={period} onChange={setYm} />
            <PeriodSwitch value={period} onChange={setPeriod} />
          </View>
          {showSwitcher ? (
            <SeatSwitcher
              seats={seats}
              activeKey={activeSeat ? seatKeyOf(activeSeat) : "central"}
              onChange={chooseSeat}
            />
          ) : null}
        </View>

        {activeSeat === null ? (
          // No finance seat → the member view (my card / my transactions).
          <FinanceBoundary fallback={<NoFinanceAccess />}>
            <MemberSection />
          </FinanceBoundary>
        ) : atCentralDesk && drilldown === null ? (
          <FinanceBoundary fallback={<NoFinanceAccess />}>
            <CentralSection
              ym={ym}
              period={period}
              onViewChapter={viewChapter}
              onNewBudget={() => setBudgetModal({ open: true, id: null, central: true })}
            />
          </FinanceBoundary>
        ) : (
          // A chapter dashboard: the caller's own chapter seat, or a central
          // seat drilled into another chapter (read-only).
          <FinanceBoundary fallback={<NoFinanceAccess />}>
            {drilldown ? (
              <View className="mb-3 flex-row items-center justify-between gap-3 rounded-lg border border-border bg-raised px-4 py-2.5">
                <Text className="flex-1 text-sm text-ink" numberOfLines={1}>
                  Viewing {drilldown.chapterName}&rsquo;s dashboard
                </Text>
                <Button
                  title="Back to Central"
                  size="sm"
                  variant="ghost"
                  onPress={backToCentral}
                />
              </View>
            ) : null}
            <ChapterSection
              chapterId={
                drilldown?.chapterId ??
                (activeSeat.scope === "chapter" ? activeSeat.chapterId : undefined)
              }
              ym={ym}
              period={period}
              isDrilldown={drilldown != null}
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
    </Screen>
  );
}

// ── Query sections (each isolated so a finance-role throw is caught locally) ──

function CentralSection({
  ym,
  period,
  onViewChapter,
  onNewBudget,
}: {
  ym: { year: number; month: number };
  period: DashPeriodMode;
  onViewChapter: (chapterId: Id<"chapters">, chapterName: string) => void;
  onNewBudget: () => void;
}) {
  const data = useQuery(api.finances.dashboardCentral, { ...ym, period });
  if (data === undefined) return <LoadingBlock />;
  return <CentralView data={data} onViewChapter={onViewChapter} onNewBudget={onNewBudget} />;
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
  if (data === undefined) return <LoadingBlock />;
  return (
    <ChapterView
      data={data}
      onNewBudget={onNewBudget}
      onEditBudget={onEditBudget}
      onAddTransaction={onAddTransaction}
      onAttentionAction={onAttentionAction}
      isDrilldown={isDrilldown}
    />
  );
}

function MemberSection() {
  return <MemberView />;
}
