/**
 * One connected legacy account (Stripe Financial Connections, READ-ONLY sync).
 * Renders the institution + masked number + type, a live status Badge, the
 * last-synced relative time, and a two-step Disconnect (`disconnect`). Matches
 * the finance visual system (see `cards.tsx`).
 *
 * Synced transactions from this account flow into the Reconcile queue as
 * `unreviewed` rows, silently pre-coded to the chapter's General Fund
 * server-side — funds are backend-only (WP-1.4, "defund the UI"), so there's
 * no default-fund control here. Increase (the card + payout layer) is a later
 * phase.
 */
import { useState } from "react";
import { Text, View } from "react-native";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { Badge, Button, Card, Icon, type BadgeTone } from "../../ui";
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
  canConnect,
  onDisconnect,
  onRefresh,
}: {
  account: LegacyAccount;
  /** Central/superuser only (mirrors `stripeFinance.canConnectAccount`) —
   *  reconnecting a disconnected row calls `storeFcAccount`, the SAME
   *  central-gated write as a fresh connect, so the per-row "Reconnect" is
   *  hidden for a regular chapter manager too. */
  canConnect: boolean;
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

        {/* Last-synced */}
        <View className="flex-row items-center gap-1.5">
          <Icon name="clock" size={13} color={colors.faint} />
          <Text className="text-xs text-faint">
            {isDisconnected ? "Sync stopped" : syncedAgo(account.lastSyncedAt)}
          </Text>
        </View>

        {isDisconnected ? (
          /* Disconnected → offer a per-row Reconnect (reruns the hosted connect
             flow; the reconnect reactivates the row AND re-pulls transactions).
             Central-only — reconnecting calls `storeFcAccount`, the same
             central-gated write as a fresh connect (see `canConnect` above). */
          <View className="gap-2">
            <Text className="text-xs text-muted">
              {canConnect
                ? "Syncing is stopped. Reconnect to resume — we'll re-pull any transactions from while it was disconnected into Reconcile."
                : "Syncing is stopped. Reconnecting is managed centrally — ask a central finance admin to reconnect this account."}
            </Text>
            {canConnect ? (
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
            ) : null}
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
