/**
 * FINANCES · Dashboard — the money home for a chapter, rendered in one of three
 * perspectives (central / chapter / member) matched to the `finances.html`
 * prototype. Perspective resolves from the caller's finance capability: we probe
 * `api.finances.dashboardCentral` and, if it succeeds, the viewer is central
 * (they get the org-wide roll-up and a "Preview as" switch to peek at the
 * chapter/member views); otherwise they land on the chapter view. A month
 * stepper drives the `{year, month}` args of every read.
 *
 * Kept behind an admin-or-lead nav gate AND this in-screen tier guard; the real
 * capability check is the backend `financeRoles` ladder, so each query is
 * wrapped in a boundary that degrades to a friendly "access needed" state if the
 * viewer lacks a finance grant (the read throws a `ConvexError`).
 *
 * Sub-nav tabs + the app chrome come from the finances `_layout`; this screen
 * renders only the Dashboard body.
 */
import { useEffect, useRef, useState } from "react";
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
  PerspectiveSwitch,
  type DashPeriodMode,
  type Perspective,
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
  const [perspective, setPerspective] = useState<Perspective>("chapter");
  // null = still probing, true/false = whether the caller is central.
  const [centralAvailable, setCentralAvailable] = useState<boolean | null>(null);
  const touchedRef = useRef(false);

  // Central → chapter drill-down: viewing a DIFFERENT chapter's dashboard than
  // the caller's own (set via the "By chapter" row's tap in Central; the
  // backend re-checks central reach on every `dashboardChapter` call).
  const [drilldown, setDrilldown] = useState<{
    chapterId: Id<"chapters">;
    chapterName: string;
  } | null>(null);

  const [budgetModal, setBudgetModal] = useState<{
    open: boolean;
    id: Id<"budgets"> | null;
  }>({ open: false, id: null });
  const [txnModalOpen, setTxnModalOpen] = useState(false);

  // Default to the central view the moment we learn the caller is central —
  // unless they've already picked a perspective from the switch.
  useEffect(() => {
    if (centralAvailable === true && !touchedRef.current) setPerspective("central");
  }, [centralAvailable]);

  function choose(p: Perspective) {
    touchedRef.current = true;
    setDrilldown(null); // a manual perspective pick always means "my own chapter"
    setPerspective(p);
  }

  function viewChapter(chapterId: Id<"chapters">, chapterName: string) {
    touchedRef.current = true;
    setDrilldown({ chapterId, chapterName });
    setPerspective("chapter");
  }

  function backToCentral() {
    setDrilldown(null);
    setPerspective("central");
  }

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

  const options: { key: Perspective; label: string }[] = [
    ...(centralAvailable ? [{ key: "central" as const, label: "Central" }] : []),
    { key: "chapter", label: "Chapter" },
    { key: "member", label: "Member" },
  ];

  return (
    <Screen>
      <Narrow>
        {/* Controls: month stepper + Month/YTD toggle + "Preview as" switch. */}
        <View className="mb-4 flex-row flex-wrap items-center justify-between gap-3">
          <View className="flex-row flex-wrap items-center gap-2">
            <MonthStepper year={ym.year} month={ym.month} period={period} onChange={setYm} />
            <PeriodSwitch value={period} onChange={setPeriod} />
          </View>
          <PerspectiveSwitch value={perspective} options={options} onChange={choose} />
        </View>

        {/* Central probe / view — kept mounted (invisibly) while probing or
            available so the "Central" option and default stay in sync. */}
        {centralAvailable !== false ? (
          <FinanceBoundary onError={() => setCentralAvailable(false)}>
            <CentralSection
              ym={ym}
              period={period}
              show={perspective === "central"}
              onAvailable={() => setCentralAvailable(true)}
              onViewChapter={viewChapter}
            />
          </FinanceBoundary>
        ) : null}

        {perspective === "chapter" ? (
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
              chapterId={drilldown?.chapterId}
              ym={ym}
              period={period}
              isDrilldown={drilldown != null}
              onNewBudget={() => setBudgetModal({ open: true, id: null })}
              onEditBudget={(id) =>
                setBudgetModal({ open: true, id: id as Id<"budgets"> })
              }
              onAddTransaction={() => setTxnModalOpen(true)}
              onAttentionAction={onAttentionAction}
            />
          </FinanceBoundary>
        ) : null}

        {perspective === "member" ? (
          <FinanceBoundary fallback={<NoFinanceAccess />}>
            <MemberSection />
          </FinanceBoundary>
        ) : null}
      </Narrow>

      {budgetModal.open ? (
        <BudgetCreateModal
          budgetId={budgetModal.id}
          defaultYear={ym.year}
          defaultMonth={ym.month}
          canCentral={centralAvailable === true}
          onClose={() => setBudgetModal({ open: false, id: null })}
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
  show,
  onAvailable,
  onViewChapter,
}: {
  ym: { year: number; month: number };
  period: DashPeriodMode;
  show: boolean;
  onAvailable: () => void;
  onViewChapter: (chapterId: Id<"chapters">, chapterName: string) => void;
}) {
  const data = useQuery(api.finances.dashboardCentral, { ...ym, period });
  useEffect(() => {
    if (data !== undefined) onAvailable();
  }, [data, onAvailable]);
  if (!show) return null;
  if (data === undefined) return <LoadingBlock />;
  return <CentralView data={data} onViewChapter={onViewChapter} />;
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
  const transactions = useQuery(api.finances.personTransactions, {});
  if (transactions === undefined) return <LoadingBlock />;
  return <MemberView transactions={transactions} />;
}
