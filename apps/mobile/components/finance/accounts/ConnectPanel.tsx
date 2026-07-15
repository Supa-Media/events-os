/**
 * "Connect a bank (read-only)" control + result notices.
 *
 * WEB: creates an FC session (`createFcSession`), loads Stripe.js, runs Stripe's
 * hosted Financial Connections collection (see `fcClient.web.ts`), and stores
 * each linked account (`storeFcAccount`, which kicks off the read-only backfill/
 * sync). Notices:
 *  - success        → accounts linked; they appear in the list below.
 *  - none           → the linking UI closed without linking an account.
 *  - not_configured → the finance vendor / publishable key isn't wired up yet.
 *  - error          → surfaced inline.
 *
 * NATIVE: Stripe.js is browser-only (and we don't ship `@stripe/stripe-react-
 * native`), so this shows a "connect from the web dashboard" notice instead.
 */
import { useState } from "react";
import { Platform, Text, View } from "react-native";
import { ConvexError } from "convex/values";
import { useAction, useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import { Button, Icon } from "../../ui";
import { colors } from "../../../lib/theme";
import { errorMessage } from "../../../lib/errors";
import { collectBankAccounts } from "./fcClient";

type Notice =
  | { kind: "success"; count: number }
  | { kind: "none" }
  | { kind: "native" }
  | { kind: "not_configured" }
  | { kind: "error"; message: string };

/** Pull a ConvexError `code` (the app throws `{ code, message }`). */
function errorCode(err: unknown): string | undefined {
  if (err instanceof ConvexError) {
    return (err.data as { code?: string } | undefined)?.code;
  }
  return undefined;
}

export function ConnectPanel() {
  const createFcSession = useAction(api.stripeFinance.createFcSession);
  const storeFcAccount = useMutation(api.stripeFinance.storeFcAccount);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  async function handleConnect() {
    // Stripe.js is browser-only; hosted linking runs on the web dashboard.
    if (Platform.OS !== "web") {
      setNotice({ kind: "native" });
      return;
    }

    setBusy(true);
    setNotice(null);
    try {
      const { clientSecret, publishableKey } = await createFcSession({});
      if (!publishableKey) {
        // Session created, but no publishable key to init Stripe.js with.
        setNotice({ kind: "not_configured" });
        return;
      }

      const accounts = await collectBankAccounts(publishableKey, clientSecret);
      if (accounts.length === 0) {
        setNotice({ kind: "none" });
        return;
      }

      for (const account of accounts) {
        await storeFcAccount({
          stripeFcAccountId: account.stripeFcAccountId,
          institutionName: account.institutionName,
          last4: account.last4,
          type: account.type,
        });
      }
      setNotice({ kind: "success", count: accounts.length });
    } catch (err) {
      if (errorCode(err) === "NOT_CONFIGURED") {
        setNotice({ kind: "not_configured" });
      } else {
        setNotice({ kind: "error", message: errorMessage(err) });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <View className="gap-3">
      <View className="flex-row">
        <Button
          title="Connect a bank (read-only)"
          icon="link"
          loading={busy}
          onPress={handleConnect}
        />
      </View>
      {notice ? <NoticeBanner notice={notice} /> : null}
    </View>
  );
}

function NoticeBanner({ notice }: { notice: Notice }) {
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
