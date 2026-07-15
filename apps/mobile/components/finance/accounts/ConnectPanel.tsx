/**
 * "Connect a bank (read-only)" control + honest degradation notice.
 *
 * Completing the hosted linking needs Stripe's browser SDK (Financial
 * Connections), which is intentionally NOT installed (no new native dep). So
 * this only creates the FC session (`createFcSession`) and then tells the truth
 * about what happens next:
 *  - success        → the session is created; a secure Stripe linking step is
 *    still required to finish (hosted linking is coming).
 *  - NOT_CONFIGURED → the finance vendor isn't wired up yet.
 *  - any other error → surfaced inline.
 */
import { useState } from "react";
import { Text, View } from "react-native";
import { ConvexError } from "convex/values";
import { useAction } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import { Button, Icon } from "../../ui";
import { colors } from "../../../lib/theme";
import { errorMessage } from "../../../lib/errors";

type Notice =
  | { kind: "linking" }
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
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  async function handleConnect() {
    setBusy(true);
    setNotice(null);
    try {
      // We only need the session to exist; the hosted linking that consumes the
      // clientSecret needs Stripe's browser SDK, which isn't installed.
      await createFcSession({});
      setNotice({ kind: "linking" });
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
  if (notice.kind === "linking") {
    return (
      <View className="flex-row gap-3 rounded-lg border border-info bg-info-bg px-4 py-3">
        <Icon name="info" size={16} color={colors.info} />
        <Text className="flex-1 text-sm text-ink">
          <Text className="font-bold">Secure linking coming.</Text> The bank
          connection was started with Stripe. Finishing it needs Stripe's hosted
          linking step, which lands in a later build — once it does, this button
          will hand off to it and your account will appear below.
        </Text>
      </View>
    );
  }
  if (notice.kind === "not_configured") {
    return (
      <View className="flex-row gap-3 rounded-lg border border-warn bg-warn-bg px-4 py-3">
        <Icon name="alert-circle" size={16} color={colors.warn} />
        <Text className="flex-1 text-sm text-ink">
          <Text className="font-bold">Payments aren't set up yet.</Text> Bank
          syncing turns on once the finance vendor is connected for your chapter.
        </Text>
      </View>
    );
  }
  return (
    <View className="flex-row gap-3 rounded-lg border border-danger bg-danger-bg px-4 py-3">
      <Icon name="alert-circle" size={16} color={colors.danger} />
      <Text className="flex-1 text-sm text-ink">
        <Text className="font-bold">Couldn't start the connection.</Text>{" "}
        {notice.message}
      </Text>
    </View>
  );
}
