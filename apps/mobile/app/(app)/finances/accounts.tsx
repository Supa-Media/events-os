/**
 * FINANCES · ACCOUNTS — two DISTINCT things live here, kept clearly separate:
 *
 *  1. The ORG'S INCREASE ACCOUNTS — the native card + ACH-payout layer (issue
 *     member cards, send reimbursement payouts), one per chapter PLUS central
 *     (the City Launch Fund's own account). WP-1.2 makes these fully OPAQUE +
 *     AUTOMATIC: provisioning is a backend sweep (`increase.
 *     backfillChapterAccounts` for existing chapters, scheduled at creation for
 *     new ones) — this screen is now a quiet, READ-ONLY status list
 *     (`api.increase.listAccountsStatus`), not a control panel. There's
 *     nothing to link, retry, or remove here anymore; those stay ops-only
 *     escape hatches (`provisionChapterAccount` / `linkIncreaseAccount`,
 *     workflow-callable, never exposed in the UI).
 *  2. CONNECTED ACCOUNTS — external bank/card accounts linked READ-ONLY via
 *     Stripe Financial Connections. Stripe FC only *reads* them; their
 *     transactions sync in as `unreviewed` rows that land in the Reconcile
 *     queue, silently pre-coded to the chapter's General Fund server-side
 *     (funds are backend-only — WP-1.4, "defund the UI"; there's no default-
 *     fund picker here anymore). Contract:
 *     `api.stripeFinance.{listAccounts,disconnect,createFcSession}`.
 *
 * ED/FM-ONLY (WP-1.2): the whole screen is gated on `api.financeRoles.
 * canViewAccounts` — the Executive Director + Financial Manager seats named in
 * the PRD (§0.2), tighter than the old admin/lead nav gate. Everyone else
 * (including a chapter finance manager) never lands here — the tab itself is
 * hidden for them too (`_layout.tsx`).
 *
 * The gate is a real component split (`AccountsScreen` → `AccountsBody`), not
 * just an in-render early return: `listAccountsStatus` (ED/FM-only) and
 * `stripeFinance.listAccounts` (finance-viewer) both THROW for anyone without
 * the role, and a `useQuery` fires as soon as its component mounts regardless
 * of a later conditional `return` in the same render — the [hotfix] crash
 * class. A no-seat member who deep-links straight to `/finances/accounts`
 * (the tab itself is hidden, but the route still exists) used to mount those
 * throwing queries anyway. `AccountsBody` — and its queries — now only mounts
 * once `canViewAccounts` (itself non-throwing) has resolved `true`.
 *
 * The SANDBOX-MODE toggle (developer/testing, superuser only) points NEW
 * provisioning at Increase's sandbox AND switches which environment's accounts
 * this page shows.
 */
import { Text, View } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Narrow,
  Screen,
  SectionHeader,
  ToastView,
  type BadgeTone,
} from "../../../components/ui";
import { useActionRunner } from "../../../lib/useActionToast";
import { AccountRow } from "../../../components/finance/accounts/AccountRow";
import { ConnectPanel } from "../../../components/finance/accounts/ConnectPanel";
import { AiUsageSection } from "../../../components/finance/accounts/AiUsageSection";

const ONBOARDING_BADGE: Record<
  "not_started" | "pending" | "active" | "disabled",
  { label: string; tone: BadgeTone }
> = {
  not_started: { label: "Not started", tone: "neutral" },
  pending: { label: "Pending", tone: "warn" },
  active: { label: "Active", tone: "success" },
  disabled: { label: "Disabled", tone: "danger" },
};

/** Real gate: `canViewAccounts` doesn't throw for a non-ED/FM caller, so it's
 *  safe to resolve here — `AccountsBody` (and its throwing, ED/FM-only reads)
 *  only mounts once it's confirmed `true`. */
export default function AccountsScreen() {
  const canViewAccounts = useQuery(api.financeRoles.canViewAccounts, {});

  if (canViewAccounts === undefined) return <Screen loading />;

  if (canViewAccounts === false) {
    return (
      <Screen>
        <Narrow>
          <EmptyState
            title="Accounts is restricted"
            message="Only the Executive Director and Financial Manager can view accounts."
          />
        </Narrow>
      </Screen>
    );
  }

  return <AccountsBody />;
}

function AccountsBody() {
  const accountsStatus = useQuery(api.increase.listAccountsStatus, {});
  const accounts = useQuery(api.stripeFinance.listAccounts, {});
  const financeSettings = useQuery(api.financeSettings.getFinanceSettings);
  // Central/superuser only — regular chapters get Increase accounts + cards
  // ONLY, never a NEW external Stripe FC connection (server-enforced in
  // `stripeFinance.createFcSession`/`storeFcAccount`; this mirrors it so the
  // control simply isn't offered instead of erroring after the hosted flow).
  const canConnectAccount = useQuery(api.stripeFinance.canConnectAccount, {});

  const disconnect = useMutation(api.stripeFinance.disconnect);
  const refreshFcAccount = useMutation(api.stripeFinance.refreshFcAccount);
  const setSandboxMode = useMutation(api.financeSettings.setSandboxMode);
  const { run, toast, dismiss } = useActionRunner();

  if (
    accountsStatus === undefined ||
    accounts === undefined ||
    financeSettings === undefined ||
    canConnectAccount === undefined
  ) {
    return <Screen loading />;
  }

  const sandboxMode = financeSettings.sandboxMode;

  return (
    <Screen>
      <Narrow>
        <Text className="mb-1 font-display text-2xl text-ink">Accounts</Text>
        <Text className="mb-4 text-sm text-muted">
          Two ways money connects here. The chapter's Increase account is the
          native card &amp; payout layer. Connected banks are external accounts
          linked read-only so their transactions flow into Reconcile.
        </Text>

        <View className="mb-1">
          <ToastView toast={toast} onDismiss={dismiss} />
        </View>

        <SectionHeader title="Card & payout accounts (Increase)" />
        <Text className="mb-3 text-sm text-muted">
          One native account per chapter, plus central (the City Launch Fund's
          own account) — issuing member cards and sending ACH reimbursement
          payouts. Provisioning is fully automatic; this is a status view, not
          a control panel. You're viewing the{" "}
          {sandboxMode ? "SANDBOX" : "PRODUCTION"} environment; switch modes
          below to see the other one.
        </Text>
        <Card>
          <View className="gap-2">
            {accountsStatus.map((row, i) => {
              const badge = row.account
                ? ONBOARDING_BADGE[row.account.onboardingStatus]
                : ONBOARDING_BADGE.not_started;
              return (
                <View
                  key={row.scope}
                  className={`flex-row items-center justify-between gap-3 py-2 ${
                    i > 0 ? "border-t border-border-strong" : ""
                  }`}
                >
                  <View className="flex-1">
                    <Text className="font-display text-base text-ink">
                      {row.scopeName}
                    </Text>
                    {row.account?.increaseAccountId ? (
                      <Text className="text-xs text-muted">
                        {row.account.increaseAccountId}
                      </Text>
                    ) : null}
                  </View>
                  <Badge label={badge.label} tone={badge.tone} />
                </View>
              );
            })}
          </View>
        </Card>

        <SectionHeader title="Connected accounts" count={accounts.length} />
        <Text className="mb-3 text-sm text-muted">
          External bank &amp; card accounts linked read-only through Stripe. We
          pull in their transactions for reconciliation — we never move money in
          or out of them.
        </Text>
        <View className="mb-3">
          <ConnectPanel canConnect={canConnectAccount} />
        </View>
        {accounts.length === 0 ? (
          <EmptyState
            icon="credit-card"
            title="No accounts connected yet"
            message="Connect a bank or card account above to start syncing its transactions into Reconcile."
          />
        ) : (
          accounts.map((account) => (
            <AccountRow
              key={account.id}
              account={account}
              canConnect={canConnectAccount}
              onDisconnect={() =>
                void run(
                  () => disconnect({ legacyAccountId: account.id }),
                  { errorTitle: "Couldn't disconnect the account" },
                )
              }
              onRefresh={() =>
                run(
                  () => refreshFcAccount({ legacyAccountId: account.id }),
                  { errorTitle: "Couldn't refresh the account" },
                )
              }
            />
          ))
        )}

        <AiUsageSection />

        <SectionHeader title="Developer / testing" />
        <Card>
          <View className="flex-row items-start justify-between gap-3">
            <View className="flex-1">
              <View className="flex-row flex-wrap items-center gap-2">
                <Text className="font-display text-base text-ink">
                  Sandbox mode
                </Text>
                <Badge
                  label={sandboxMode ? "SANDBOX" : "PRODUCTION"}
                  tone={sandboxMode ? "warn" : "neutral"}
                  icon={sandboxMode ? "alert-triangle" : "check-circle"}
                />
                <Badge label="Superuser only" tone="lavender" icon="lock" />
              </View>
              <Text className="mt-1 text-sm text-muted">
                Developer / testing only. Points NEWLY provisioned accounts at
                the Increase sandbox — no real money moves. Existing accounts
                keep their current environment. Leave this OFF in production.
              </Text>
            </View>
            <Button
              title={sandboxMode ? "Turn off" : "Turn on"}
              variant={sandboxMode ? "secondary" : "primary"}
              icon={sandboxMode ? "toggle-right" : "toggle-left"}
              onPress={() =>
                void run(
                  () => setSandboxMode({ sandboxMode: !sandboxMode }),
                  { errorTitle: "Couldn't change sandbox mode" },
                )
              }
            />
          </View>
        </Card>
      </Narrow>
    </Screen>
  );
}
