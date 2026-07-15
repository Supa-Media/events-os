/**
 * One connected legacy account (Stripe Financial Connections, READ-ONLY sync).
 * Renders the institution + masked number + type, a live status Badge, the
 * "default fund" the account's synced transactions land in (editable —
 * `setAccountFund`), the last-synced relative time, and a two-step Disconnect
 * (`disconnect`). Matches the finance visual system (see `cards.tsx`).
 *
 * Synced transactions from this account flow into the Reconcile queue as
 * `unreviewed` rows; the default fund pre-codes their fund so reconciliation is
 * a lighter lift. Increase (the card + payout layer) is a later phase.
 */
import { useState } from "react";
import { Text, View } from "react-native";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { Badge, Button, Card, Icon, Select, type BadgeTone } from "../../ui";
import { colors } from "../../../lib/theme";
import { useFcConnect } from "./useFcConnect";
import { NoticeBanner } from "./ConnectPanel";

/** The row shape from `api.stripeFinance.listAccounts`. */
export type LegacyAccount = {
  id: Id<"legacyAccounts">;
  institutionName: string | null;
  last4: string | null;
  type: string | null;
  status: "active" | "disconnected" | "error";
  defaultFundId: Id<"funds"> | null;
  lastSyncedAt: number | null;
};

/** A fund option for the default-fund Select. */
export type FundOption = { value: string; label: string };

const STATUS: Record<
  LegacyAccount["status"],
  { label: string; tone: BadgeTone }
> = {
  active: { label: "Active", tone: "success" },
  disconnected: { label: "Disconnected", tone: "neutral" },
  error: { label: "Sync error", tone: "danger" },
};

/** Compact "synced 3h ago" style relative time (past only). */
function syncedAgo(ts: number | null): string {
  if (ts == null) return "Never synced";
  const diff = Date.now() - ts;
  if (diff < 60_000) return "Synced just now";
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `Synced ${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `Synced ${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `Synced ${days}d ago`;
}

export function AccountRow({
  account,
  funds,
  onSetFund,
  onDisconnect,
  onRefresh,
}: {
  account: LegacyAccount;
  funds: FundOption[];
  onSetFund: (fundId: Id<"funds">) => void;
  onDisconnect: () => void;
  /** Manually re-pull this account's transactions ("Refresh"). Awaited so the
   *  button can show a "Syncing…" state until the schedule call resolves. */
  onRefresh: () => Promise<unknown>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // A disconnected row's "Reconnect" reuses the exact hosted connect flow.
  const reconnect = useFcConnect();
  const status = STATUS[account.status];
  const isDisconnected = account.status === "disconnected";

  async function handleRefresh() {
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  }
  const title = account.institutionName ?? "Bank account";
  const typeLabel = account.type
    ? account.type.charAt(0).toUpperCase() + account.type.slice(1)
    : null;

  return (
    <Card className="mb-3">
      <View className="gap-3">
        {/* Identity + status */}
        <View className="flex-row items-start justify-between gap-3">
          <View className="flex-1 flex-row items-center gap-3">
            <View className="h-9 w-9 items-center justify-center rounded-md bg-sunken">
              <Icon name="credit-card" size={16} color={colors.muted} />
            </View>
            <View className="flex-1">
              <Text className="font-semibold text-ink">{title}</Text>
              <Text className="text-xs text-muted">
                {account.last4 ? `•••• ${account.last4}` : "No account number"}
                {typeLabel ? ` · ${typeLabel}` : ""}
              </Text>
            </View>
          </View>
          <Badge label={status.label} tone={status.tone} />
        </View>

        {/* Default fund + last-synced */}
        <View>
          <View className="flex-row flex-wrap items-end justify-between gap-3">
            <View className="min-w-[220px] flex-1">
              <Select
                label="Default fund"
                value={account.defaultFundId}
                options={funds}
                placeholder={funds.length ? "Choose a fund…" : "No funds yet"}
                onChange={(value) => onSetFund(value as Id<"funds">)}
              />
            </View>
            <View className="mb-3 flex-row items-center gap-1.5">
              <Icon name="clock" size={13} color={colors.faint} />
              <Text className="text-xs text-faint">
                {isDisconnected
                  ? "Sync stopped"
                  : syncedAgo(account.lastSyncedAt)}
              </Text>
            </View>
          </View>
          {/* A fund is a pot of money (e.g. Operations, a ministry). */}
          <Text className="-mt-1 text-xs text-muted">
            Which fund this account's synced transactions are pre-coded to in
            Reconcile. A fund is a pot of money — e.g. Operations or a ministry.
          </Text>
        </View>

        {isDisconnected ? (
          /* Disconnected → offer a per-row Reconnect (reruns the hosted connect
             flow; the reconnect reactivates the row AND re-pulls transactions). */
          <View className="gap-2">
            <Text className="text-xs text-muted">
              Syncing is stopped. Reconnect to resume — we&apos;ll re-pull any
              transactions from while it was disconnected into Reconcile.
            </Text>
            <View className="flex-row justify-end">
              <Button
                title="Reconnect"
                variant="secondary"
                size="sm"
                icon="link"
                loading={reconnect.busy}
                onPress={() => void reconnect.connect()}
              />
            </View>
            {reconnect.notice ? (
              <NoticeBanner notice={reconnect.notice} />
            ) : null}
          </View>
        ) : confirming ? (
          /* Disconnect (two-step confirm). */
          <View className="flex-row items-center justify-end gap-2">
            <Text className="flex-1 text-xs text-muted">
              Stop syncing this account? Already-synced transactions stay.
            </Text>
            <Button
              title="Cancel"
              variant="ghost"
              size="sm"
              onPress={() => setConfirming(false)}
            />
            <Button
              title="Disconnect"
              variant="danger"
              size="sm"
              icon="x"
              onPress={() => {
                setConfirming(false);
                onDisconnect();
              }}
            />
          </View>
        ) : (
          /* Active → Refresh now (manual transaction re-pull) + Disconnect. */
          <View className="gap-1.5">
            <View className="flex-row justify-end gap-2">
              <Button
                title={refreshing ? "Syncing…" : "Refresh"}
                variant="secondary"
                size="sm"
                icon="refresh-cw"
                disabled={refreshing}
                onPress={() => void handleRefresh()}
              />
              <Button
                title="Disconnect"
                variant="secondary"
                size="sm"
                onPress={() => setConfirming(true)}
              />
            </View>
            <Text className="text-right text-xs text-muted">
              Refresh pulls the latest transactions from your bank into Reconcile.
            </Text>
          </View>
        )}
      </View>
    </Card>
  );
}
