/**
 * "Connect a bank (read-only)" control + result notices.
 *
 * WEB: creates an FC session (`createFcSession`), loads Stripe.js, runs Stripe's
 * hosted Financial Connections collection (see `fcClient.web.ts`), and stores
 * each linked account (`storeFcAccount`, which kicks off the read-only backfill/
 * sync). The connect flow lives in `useFcConnect` (shared with the per-row
 * "Reconnect" on a disconnected account). Notices:
 *  - success        → accounts linked; they appear in the list below.
 *  - none           → the linking UI closed without linking an account.
 *  - not_configured → the finance vendor / publishable key isn't wired up yet.
 *  - error          → surfaced inline.
 *
 * NATIVE: Stripe.js is browser-only (and we don't ship `@stripe/stripe-react-
 * native`), so this shows a "connect from the web dashboard" notice instead.
 *
 * CENTRAL-ONLY: connecting a NEW external account is gated server-side to
 * central/superuser finance access (`stripeFinance.createFcSession` /
 * `storeFcAccount` — see the "central vs chapter" model in
 * docs/plans/finance-handoff.md). `canConnect` mirrors that gate client-side
 * so a regular chapter manager sees why the control is unavailable instead of
 * hitting a server error after running the hosted Stripe flow.
 */
import { Text, View } from "react-native";
import { Button, Icon } from "../../ui";
import { colors } from "../../../lib/theme";
import { useFcConnect, type FcConnectNotice } from "./useFcConnect";

export function ConnectPanel({ canConnect }: { canConnect: boolean }) {
  const { connect, busy, notice } = useFcConnect();

  if (!canConnect) {
    return (
      <View className="flex-row gap-3 rounded-lg border border-border-strong bg-sunken px-4 py-3">
        <Icon name="lock" size={16} color={colors.muted} />
        <Text className="flex-1 text-xs text-muted">
          Connecting a bank is managed centrally. Ask a central finance admin to
          link a new account — you can still manage &amp; reconcile any accounts
          already connected below.
        </Text>
      </View>
    );
  }

  return (
    <View className="gap-2">
      <View className="flex-row">
        <Button
          title="Connect a bank (read-only)"
          icon="link"
          loading={busy}
          onPress={() => void connect()}
        />
      </View>
      <Text className="text-xs text-muted">
        Links an existing bank or card account through Stripe read-only — we can
        see its transactions but never move money. New transactions sync into
        Reconcile.
      </Text>
      {notice ? <NoticeBanner notice={notice} /> : null}
    </View>
  );
}

/** Inline result banner for a connect/reconnect attempt. Exported so the
 *  per-row "Reconnect" (AccountRow) renders the identical outcome states. */
export function NoticeBanner({ notice }: { notice: FcConnectNotice }) {
  if (notice.kind === "success") {
    return (
      <View className="flex-row gap-3 rounded-lg border border-success bg-success-bg px-4 py-3">
        <Icon name="check-circle" size={16} color={colors.success} />
        <Text className="flex-1 text-sm text-ink">
          <Text className="font-bold">
            {notice.count === 1 ? "Account linked." : "Accounts linked."}
          </Text>{" "}
          We&apos;re pulling in transactions read-only — they&apos;ll appear
          below and drop into the reconcile queue.
        </Text>
      </View>
    );
  }
  if (notice.kind === "none") {
    return (
      <View className="flex-row gap-3 rounded-lg border border-info bg-info-bg px-4 py-3">
        <Icon name="info" size={16} color={colors.info} />
        <Text className="flex-1 text-sm text-ink">
          <Text className="font-bold">No account linked.</Text> The linking
          window closed before an account was connected. Tap the button to try
          again.
        </Text>
      </View>
    );
  }
  if (notice.kind === "native") {
    return (
      <View className="flex-row gap-3 rounded-lg border border-info bg-info-bg px-4 py-3">
        <Icon name="info" size={16} color={colors.info} />
        <Text className="flex-1 text-sm text-ink">
          <Text className="font-bold">Connect from the web dashboard.</Text>{" "}
          Secure bank linking runs in your browser — open the finance dashboard
          on the web to connect an account.
        </Text>
      </View>
    );
  }
  if (notice.kind === "not_configured") {
    return (
      <View className="flex-row gap-3 rounded-lg border border-warn bg-warn-bg px-4 py-3">
        <Icon name="alert-circle" size={16} color={colors.warn} />
        <Text className="flex-1 text-sm text-ink">
          <Text className="font-bold">Payments aren&apos;t set up yet.</Text>{" "}
          Bank syncing turns on once the finance vendor is connected for your
          chapter.
        </Text>
      </View>
    );
  }
  return (
    <View className="flex-row gap-3 rounded-lg border border-danger bg-danger-bg px-4 py-3">
      <Icon name="alert-circle" size={16} color={colors.danger} />
      <Text className="flex-1 text-sm text-ink">
        <Text className="font-bold">Couldn&apos;t start the connection.</Text>{" "}
        {notice.message}
      </Text>
    </View>
  );
}
