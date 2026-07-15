/**
 * Shared Stripe Financial Connections connect/reconnect flow.
 *
 * The hosted linking is identical whether the user is connecting a NEW bank or
 * RECONNECTING a previously-disconnected one: create an FC session
 * (`createFcSession`), run Stripe's browser collection UI (`collectBankAccounts`,
 * web-only), then `storeFcAccount` each linked account — which dedups on the
 * Stripe account id, so a reconnect REACTIVATES the existing row and (via
 * `storeFcAccount`) kicks off a fresh transaction fetch. Extracted from
 * `ConnectPanel` so a per-row "Reconnect" can reuse the exact same flow.
 *
 * WEB only: Stripe.js is browser-only (and we don't ship
 * `@stripe/stripe-react-native`); on native this sets a `native` notice telling
 * the user to connect from the web dashboard, so no native Stripe dep is pulled
 * in (Metro resolves the native `fcClient.ts` stub for the import).
 */
import { useCallback, useState } from "react";
import { Platform } from "react-native";
import { ConvexError } from "convex/values";
import { useAction, useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import { errorMessage } from "../../../lib/errors";
import { collectBankAccounts } from "./fcClient";

/** The outcome of a connect/reconnect attempt, surfaced as an inline banner. */
export type FcConnectNotice =
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

export type FcConnect = {
  /** Run the hosted connect/reconnect flow; sets `notice` with the outcome. */
  connect: () => Promise<void>;
  /** True while the flow is in progress (drive a button's loading state). */
  busy: boolean;
  /** The last outcome (null when none yet). */
  notice: FcConnectNotice | null;
  /** Clear the current notice. */
  clearNotice: () => void;
};

export function useFcConnect(): FcConnect {
  const createFcSession = useAction(api.stripeFinance.createFcSession);
  const storeFcAccount = useMutation(api.stripeFinance.storeFcAccount);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<FcConnectNotice | null>(null);

  const connect = useCallback(async () => {
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
  }, [createFcSession, storeFcAccount]);

  const clearNotice = useCallback(() => setNotice(null), []);

  return { connect, busy, notice, clearNotice };
}
