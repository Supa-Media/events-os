/**
 * DASH-2.1 UI — the category→transactions drill-down, one level below a
 * budget row's category mini-bars (`BudgetTable`'s `CategoryRow`). Reads
 * `api.dashboardCharts.budgetTransactions` (DASH-2.1 backend, #242) — the
 * SAME `isSpend` gate every budget/category total on this dashboard already
 * sums with, so this list always sums to exactly the mini-bar it drills into.
 *
 * Review fix (finding #1): `year`/`month`/`quarter` here are the SAME
 * widened effective period the mini-bar itself used (see
 * `ChapterView`'s `effectivePeriodFor` — monthly cadence → `month`,
 * quarterly → `quarter`, yearly → year-only), not always the dashboard's own
 * selected month — a quarterly/yearly recurring bucket's bar widens beyond
 * one month even in month mode (`finances.ts#budgetEffectivePeriod`), and a
 * single-month drill-down used to silently under-sum vs. that wider bar.
 *
 * Review fix (finding #2): filters by `categoryName` (the SAME name the
 * mini-bar grouped by — `finances.ts#spendBreakdownFor`), not `categoryId` —
 * two funds can share a category name, and a single id would miss the
 * other's transactions. See `dashboardCharts.budgetTransactions`'s own doc.
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
  categoryName,
  year,
  month,
  quarter,
  rangeNote,
  onOpenTransaction,
}: {
  budgetId: Id<"budgets">;
  /** Review fix (finding #2): the category's resolved NAME (the mini-bar's
   *  own grouping key — `finances.ts#spendBreakdownFor`), or the
   *  `"Uncategorized"` bucket. Never a raw `categoryId` — see this file's
   *  own module doc + `dashboardCharts.budgetTransactions`'s. */
  categoryName: string;
  year: number;
  /** Absent = a widened period (YTD mode, or a yearly-cadence bar's month-mode
   *  widening — see `quarter` below) — `budgetTransactions` reads the whole
   *  year in that case, matching the mini-bar it drills into. */
  month?: number;
  /** Review fix (finding #1): set for a quarterly-cadence bar viewed in month
   *  mode — the SAME quarter its mini-bar widened to
   *  (`finances.ts#budgetEffectivePeriod`). Mutually exclusive with `month`. */
  quarter?: number;
  /** Review fix (finding #1): a small note ("this quarter" / "this year")
   *  shown above the list when its period is WIDER than the dashboard's own
   *  selected month — so it's clear why a row from outside the visible month
   *  bar shows up here. `undefined` when the drill-down period equals the
   *  page's own period (monthly cadence, or YTD mode). */
  rangeNote?: string;
  onOpenTransaction: (txn: DrilldownTxn) => void;
}) {
  const router = useRouter();
  const result = useQuery(api.dashboardCharts.budgetTransactions, {
    budgetId,
    categoryName,
    year,
    month,
    quarter,
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
        {rangeNote ? (
          <Text className="pb-1 text-2xs text-faint">Showing {rangeNote}</Text>
        ) : null}
        <Text className="text-2xs text-faint">No transactions this period.</Text>
      </View>
    );
  }

  return (
    <View className="gap-0.5 border-t border-border/60 py-1.5 pl-3">
      {rangeNote ? (
        <Text className="px-1.5 pb-0.5 text-2xs text-faint">Showing {rangeNote}</Text>
      ) : null}
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
