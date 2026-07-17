/**
 * MoneyView (WP-3.3) — "what's this thing costing?" One component shared by
 * the event Money tab and the project Money section (`moneyViews.refMoney`
 * assembles the same shape for either `refKind`): budget header (amount +
 * approval chip + tap-through to the budget in Finances), planned-vs-actual
 * by category, the unplanned-spend bucket, and a recent linked-transactions
 * list. Entirely READ-ONLY — every write happens in Finances (the budget's
 * amount/plan/approval) or Reconcile (attributing a transaction to a budget);
 * this view just answers "what's this costing" at a glance.
 */
import { Pressable, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@events-os/convex/_generated/api";
import { formatCents } from "@events-os/shared";
import { Badge, Card, EmptyState, Icon, SectionHeader } from "../ui";
import { Money, BudgetBar, txnStatusTone } from "../finance/dashboard/parts";
import { colors } from "../../lib/theme";
import { formatDate } from "../../lib/format";

type MoneyData = FunctionReturnType<typeof api.moneyViews.refMoney>;
type CategoryRowData = MoneyData["categories"][number];
type TxnRowData = MoneyData["transactions"][number];

export function MoneyView({
  refKind,
  refId,
}: {
  refKind: "event" | "project";
  refId: string;
}) {
  const router = useRouter();
  const data = useQuery(api.moneyViews.refMoney, { refKind, refId });

  function openFinances() {
    router.navigate("/finances" as never);
  }

  if (data === undefined) {
    return (
      <View className="py-10">
        <Text className="text-base text-muted">Loading money…</Text>
      </View>
    );
  }

  const {
    budget,
    categories,
    unplannedCents,
    transactions,
    totalPlannedCents,
    totalActualCents,
    totalRemainingCents,
    lineCount,
  } = data;

  if (!budget) {
    return (
      <EmptyState
        icon="dollar-sign"
        title="No budget yet"
        message="Add a budget amount to start planning — enter it in the budget field above (or on the project card)."
      />
    );
  }

  const pct =
    totalPlannedCents > 0
      ? Math.round((totalActualCents / totalPlannedCents) * 100)
      : 0;

  return (
    <View>
      {/* ── Budget header ─────────────────────────────────────────────────── */}
      <Card>
        <View className="flex-row items-start justify-between gap-3">
          <View className="flex-1">
            <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
              Budget
            </Text>
            <Money
              cents={budget.amountCents}
              className="mt-0.5 font-display text-2xl text-ink"
            />
            {budget.label ? (
              <Text className="mt-0.5 text-sm text-muted" numberOfLines={1}>
                {budget.label}
              </Text>
            ) : null}
          </View>
          <View className="items-end gap-2">
            {budget.approvalState ? (
              <Badge
                label={budget.approvalState === "approved" ? "Approved" : "Rejected"}
                tone={budget.approvalState === "approved" ? "success" : "danger"}
                icon={budget.approvalState === "approved" ? "check" : "x"}
              />
            ) : null}
            <Pressable
              onPress={openFinances}
              className="flex-row items-center gap-1 active:opacity-70"
            >
              <Text className="text-sm font-medium text-accent">View in Finances</Text>
              <Icon name="chevron-right" size={14} color={colors.accent} />
            </Pressable>
          </View>
        </View>

        <View className="mt-3">
          <BudgetBar pct={pct} status={pct >= 80 ? "warn" : "ok"} />
          <View className="mt-1.5 flex-row items-center justify-between">
            <Text className="text-xs text-muted">
              <Money cents={totalActualCents} className="text-xs text-muted" /> spent of{" "}
              <Money cents={totalPlannedCents} className="text-xs text-muted" />
            </Text>
            <Text
              className={`text-xs font-semibold ${
                totalRemainingCents < 0 ? "text-danger" : "text-muted"
              }`}
            >
              {totalRemainingCents < 0
                ? `Over by ${formatCents(-totalRemainingCents)}`
                : `${formatCents(totalRemainingCents)} remaining`}
            </Text>
          </View>
        </View>
      </Card>

      {/* ── Plan: planned-vs-actual by category ──────────────────────────── */}
      {lineCount === 0 ? (
        <View className="mt-4">
          <EmptyState
            icon="list"
            title="No plan yet"
            message="Break this budget down by category (people, location, gear…) in Finances so this view can show planned vs. actual."
            action={
              <Pressable onPress={openFinances} className="active:opacity-70">
                <Text className="text-sm font-semibold text-accent">
                  Plan it in Finances →
                </Text>
              </Pressable>
            }
          />
        </View>
      ) : (
        <>
          <SectionHeader title="Planned vs actual" count={categories.length} />
          <View className="gap-3">
            {categories.map((c) => (
              <CategoryRow key={c.categoryId ?? "uncategorized"} row={c} />
            ))}
          </View>
        </>
      )}

      {/* ── Unplanned-spend bucket ────────────────────────────────────────── */}
      {unplannedCents > 0 ? (
        <Pressable
          onPress={() => router.navigate("/finances/reconcile" as never)}
          className="mt-4 flex-row items-center gap-3 rounded-lg border border-warn bg-warn-bg p-4 shadow-card active:opacity-90"
        >
          <Icon name="alert-triangle" size={18} color={colors.warn} />
          <View className="flex-1">
            <Text className="text-sm font-semibold text-ink">
              Unplanned spend:{" "}
              <Money cents={unplannedCents} className="text-sm font-semibold text-ink" />
            </Text>
            <Text className="text-xs text-muted">
              Spend in categories with no planned line — not counted toward any
              category above.
            </Text>
          </View>
          <Icon name="chevron-right" size={16} color={colors.muted} />
        </Pressable>
      ) : null}

      {/* ── Recent linked transactions ────────────────────────────────────── */}
      {transactions.length > 0 ? (
        <>
          <SectionHeader title="Recent transactions" count={transactions.length} />
          <Card padding="none">
            {transactions.slice(0, 10).map((tr, i) => (
              <TxnRow key={tr.id} tr={tr} first={i === 0} />
            ))}
          </Card>
        </>
      ) : totalActualCents === 0 && lineCount > 0 ? (
        <Text className="mt-4 text-sm text-muted">
          No spend yet — this is the plan so far.
        </Text>
      ) : null}
    </View>
  );
}

function CategoryRow({ row }: { row: CategoryRowData }) {
  const pct =
    row.plannedCents > 0 ? Math.round((row.actualCents / row.plannedCents) * 100) : 0;
  return (
    <View className="gap-1.5 rounded-lg border border-border bg-raised p-4 shadow-card">
      <View className="flex-row items-center justify-between gap-3">
        <Text className="flex-1 text-sm font-medium text-ink" numberOfLines={1}>
          {row.categoryName}
        </Text>
        <Text className="text-sm text-muted" style={{ fontVariant: ["tabular-nums"] }}>
          {formatCents(row.actualCents)} / {formatCents(row.plannedCents)}
        </Text>
      </View>
      <BudgetBar pct={pct} status={pct >= 80 ? "warn" : "ok"} />
    </View>
  );
}

function TxnRow({ tr, first }: { tr: TxnRowData; first: boolean }) {
  const { tone, label } = txnStatusTone(tr.status);
  return (
    <View
      className={`flex-row items-center justify-between gap-3 px-4 py-3 ${
        first ? "" : "border-t border-border"
      }`}
    >
      <View className="flex-1">
        <Text className="text-sm text-ink" numberOfLines={1}>
          {tr.merchantName ?? tr.description ?? "Transaction"}
        </Text>
        <Text className="text-xs text-muted">{formatDate(tr.postedAt)}</Text>
      </View>
      <View className="items-end gap-1">
        <Text className="text-sm font-semibold text-ink" style={{ fontVariant: ["tabular-nums"] }}>
          {formatCents(tr.amountCents)}
        </Text>
        <Badge label={label} tone={tone} />
      </View>
    </View>
  );
}
