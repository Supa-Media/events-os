/**
 * Stripe Financial Connections browser handshake — WEB implementation.
 *
 * Metro resolves this `.web.ts` (not `fcClient.ts`) when bundling for web, so
 * `@stripe/stripe-js` — a pure browser SDK — only ships to the web bundle. The
 * import is dynamic so it's fetched lazily, only when the user actually starts a
 * connection. `ConnectPanel` first calls `createFcSession` (which returns the
 * `publishableKey` + `clientSecret`), then hands them here to run Stripe's
 * hosted account-collection UI and returns the linked accounts for
 * `storeFcAccount`.
 */

/** One bank/card account the user linked, mapped to `storeFcAccount`'s args. */
export type CollectedFcAccount = {
  stripeFcAccountId: string;
  institutionName?: string;
  last4?: string;
  type?: string;
};

/** Launch Stripe's Financial Connections collection UI for a session and return
 *  the accounts the user linked (empty when they cancel without linking any). */
export async function collectBankAccounts(
  publishableKey: string,
  clientSecret: string,
): Promise<CollectedFcAccount[]> {
  const { loadStripe } = await import("@stripe/stripe-js");
  const stripe = await loadStripe(publishableKey);
  if (!stripe) {
    throw new Error("Couldn't load Stripe. Check the publishable key.");
  }

  const result = await stripe.collectFinancialConnectionsAccounts({
    clientSecret,
  });
  if (result.error) {
    throw new Error(
      result.error.message ?? "Bank linking failed. Please try again.",
    );
  }

  const accounts = result.financialConnectionsSession?.accounts ?? [];
  return accounts.map((account) => ({
    stripeFcAccountId: account.id,
    institutionName: account.institution_name ?? undefined,
    last4: account.last4 ?? undefined,
    // A free-text label for the UI (e.g. "checking" / "credit_card").
    type: account.subcategory ?? account.category ?? undefined,
  }));
}
