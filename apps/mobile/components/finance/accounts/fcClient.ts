/**
 * Stripe Financial Connections browser handshake — NATIVE stub.
 *
 * The hosted linking runs in Stripe.js (`@stripe/stripe-js`), a browser-only
 * SDK. Metro resolves `fcClient.web.ts` for the web bundle (the real flow) and
 * THIS file for native, so `@stripe/stripe-js` never lands in the native
 * bundle. `ConnectPanel` guards on `Platform.OS === "web"` and shows a
 * "connect from the web dashboard" notice on native, so this is never called —
 * it throws defensively if it ever is.
 */

/** One bank/card account the user linked, mapped to `storeFcAccount`'s args. */
export type CollectedFcAccount = {
  stripeFcAccountId: string;
  institutionName?: string;
  last4?: string;
  type?: string;
};

export async function collectBankAccounts(
  _publishableKey: string,
  _clientSecret: string,
): Promise<CollectedFcAccount[]> {
  throw new Error("Bank linking is available from the web dashboard only.");
}
