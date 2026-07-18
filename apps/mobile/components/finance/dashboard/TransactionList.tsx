/**
 * DASH-2.1 UI — the category→transactions drill-down, one level below a
 * budget row's category mini-bars (`BudgetTable`'s `CategoryRow`). Reads
 * `api.dashboardCharts.budgetTransactions` (DASH-2.1 backend, #242) — the
 * SAME `isSpend` gate every budget/category total on this dashboard already
 * sums with, so this list always sums to exactly the mini-bar it drills into.
 *
 * LAZY: this component only exists while its parent `CategoryRow` is
 * expanded (plain conditional mount — the "Convex skip until expanded" rule
 * the brief asks for), so a budget row full of unopened category bars costs
 * nothing beyond the mini-bars themselves.
 *
 * Bounded server-side at 200 rows (`totalCount` says when it's truncated) —
 * a drill-down is a UI list, not a full ledger; a truncated tail links out to
 * Reconcile (the full ledger) instead of paginating in place.
 */
import { Pressable, Text, View } from "react-native";
import { useQuery } from "convex/react";
import { useRouter } from "expo-router";
import type { FunctionReturnType } from "convex/server";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { Icon } from "../../ui";
import { colors } from "../../../lib/theme";
import { Money } from "./parts";
import { shortDate } from "../reconcile/helpers";

export type DrilldownTxn = FunctionReturnType<
  typeof api.dashboardCharts.budgetTransactions
>["rows"][number];

export function TransactionList({
  budgetId,
  categoryId,
  year,
  month,
  onOpenTransaction,
}: {
  budgetId: Id<"budgets">;
  categoryId: Id<"budgetCategories"> | "uncategorized";
  year: number;
  /** Absent = the dashboard's YTD mode (`budgetTransactions` reads the whole
   *  year in that case, matching the mini-bar it drills into). */
  month?: number;
  onOpenTransaction: (txn: DrilldownTxn) => void;
}) {
  const router = useRouter();
  const result = useQuery(api.dashboardCharts.budgetTransactions, {
    budgetId,
    categoryId,
    year,
    month,
  });

  if (result === undefined) {
    return (
      <View className="border-t border-border/60 py-2 pl-3">
        <Text className="text-2xs text-muted">Loading transactions…</Text>
      </View>
    );
  }

  if (result.rows.length === 0) {
    return (
      <View className="border-t border-border/60 py-2 pl-3">
        <Text className="text-2xs text-faint">No transactions this period.</Text>
      </View>
    );
  }

  return (
    <View className="gap-0.5 border-t border-border/60 py-1.5 pl-3">
      {result.rows.map((txn) => (
        <Pressable
          key={txn.id}
          onPress={() => onOpenTransaction(txn)}
          accessibilityRole="button"
          className="flex-row items-center gap-2 rounded px-1.5 py-1 active:opacity-70 web:hover:bg-sunken"
        >
          <Text
            className="w-11 text-2xs text-faint"
            style={{ fontVariant: ["tabular-nums"] }}
            numberOfLines={1}
          >
            {shortDate(txn.date)}
          </Text>
          <Text className="min-w-0 flex-1 text-2xs text-ink" numberOfLines={1}>
            {txn.description ?? txn.merchantName ?? "Unlabeled charge"}
          </Text>
          <Text className="w-20 text-2xs text-muted" numberOfLines={1}>
            {txn.personName ?? "—"}
          </Text>
          {txn.hasReceipt ? (
            <Icon name="check-circle" size={11} color={colors.success} />
          ) : (
            <View style={{ width: 11 }} />
          )}
          <Money cents={txn.amountCents} className="w-16 text-right text-2xs font-semibold" />
        </Pressable>
      ))}
      {result.totalCount > result.rows.length ? (
        <Pressable
          onPress={() => router.navigate("/finances/reconcile" as never)}
          accessibilityRole="button"
          className="flex-row items-center justify-center gap-1 py-1 web:hover:opacity-80"
        >
          <Text className="text-2xs font-semibold text-accent">
            {result.totalCount - result.rows.length} more — view in Reconcile
          </Text>
          <Icon name="chevron-right" size={10} color={colors.accent} />
        </Pressable>
      ) : null}
    </View>
  );
}
