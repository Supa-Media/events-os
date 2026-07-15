/**
 * The left pane of Reconcile: a compact inbox table of transactions. Each row
 * shows the merchant, a date · note meta line, a derived state badge, and the
 * right-aligned signed amount. The selected row is tinted; rows hover on web.
 *
 * Card last4 / spender aren't in the `listTransactions` projection yet, so the
 * meta line falls back to `date · description`.
 */
import { useState } from "react";
import { View, Text, Pressable } from "react-native";
import { Badge } from "../../ui";
import {
  STATE_BADGE,
  signedMoney,
  shortDate,
  stateForStatus,
  type TxnRow,
} from "./helpers";

const NUM = { fontVariant: ["tabular-nums" as const] };

export function ReconcileList({
  rows,
  selectedId,
  onSelect,
}: {
  rows: TxnRow[];
  selectedId: string | null;
  onSelect: (row: TxnRow) => void;
}) {
  return (
    <View className="overflow-hidden rounded-lg border border-border bg-raised shadow-card">
      {/* Column header. */}
      <View className="flex-row items-center gap-3 border-b border-border bg-sunken px-4 py-2.5">
        <Text className="flex-[2] text-2xs font-bold uppercase tracking-wider text-muted">
          Transaction
        </Text>
        <Text className="flex-[1.4] text-2xs font-bold uppercase tracking-wider text-muted">
          State
        </Text>
        <Text className="w-20 text-right text-2xs font-bold uppercase tracking-wider text-muted">
          Amount
        </Text>
      </View>
      {rows.map((row) => (
        <ReconcileRow
          key={row.id}
          row={row}
          selected={row.id === selectedId}
          onPress={() => onSelect(row)}
        />
      ))}
    </View>
  );
}

function ReconcileRow({
  row,
  selected,
  onPress,
}: {
  row: TxnRow;
  selected: boolean;
  onPress: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const badge = STATE_BADGE[stateForStatus(row.status)];
  const meta = [shortDate(row.postedAt), row.description]
    .filter(Boolean)
    .join(" · ");
  const bg = selected ? "bg-accent-soft" : hovered ? "bg-sunken" : "bg-raised";

  return (
    <Pressable
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      className={`flex-row items-center gap-3 border-b border-border px-4 py-3 ${bg}`}
    >
      <View className="flex-[2]">
        <Text className="text-sm font-semibold text-ink" numberOfLines={1}>
          {row.merchantName ?? "Unlabeled charge"}
        </Text>
        {meta ? (
          <Text className="mt-0.5 text-xs text-faint" numberOfLines={1}>
            {meta}
          </Text>
        ) : null}
      </View>
      <View className="flex-[1.4] gap-1">
        <Badge label={badge.label} tone={badge.tone} />
        {row.needsBudget ? (
          <Badge label="Needs a budget" tone="warn" icon="tag" />
        ) : null}
      </View>
      <Text
        className="w-20 text-right text-sm font-semibold text-ink"
        style={NUM}
      >
        {signedMoney(row.amountCents, row.flow)}
      </Text>
    </Pressable>
  );
}
