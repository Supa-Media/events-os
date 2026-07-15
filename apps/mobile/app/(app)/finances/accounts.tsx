/**
 * FINANCES · ACCOUNTS — legacy external bank/card accounts, connected READ-ONLY
 * via Stripe Financial Connections.
 *
 * Stripe FC only *reads* accounts the chapter already has elsewhere; their
 * transactions sync in as `unreviewed` rows that land in the Reconcile queue,
 * pre-coded to each account's default fund. Increase (the card + payout layer)
 * comes later. This screen lists the connected accounts (status, default fund,
 * last-synced, disconnect) and offers a connect action that degrades honestly
 * when the hosted linking / vendor isn't wired up yet (see ConnectPanel).
 *
 * Guarded admin-or-lead in-screen (mirrors the nav gate) so a member who
 * deep-links lands on a friendly restricted state. Contract:
 * `api.stripeFinance.{listAccounts,setAccountFund,disconnect,createFcSession}`
 * + `api.finances.listFunds`.
 */
import { useMemo } from "react";
import { Text, View } from "react-native";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Narrow,
  Screen,
  SectionHeader,
  ToastView,
} from "../../../components/ui";
import { useActionRunner } from "../../../lib/useActionToast";
import {
  AccountRow,
  type FundOption,
} from "../../../components/finance/accounts/AccountRow";
import { ConnectPanel } from "../../../components/finance/accounts/ConnectPanel";

export default function AccountsScreen() {
  const org = useQuery(api.org.nav);
  const accounts = useQuery(api.stripeFinance.listAccounts, {});
  const funds = useQuery(api.finances.listFunds, {});
  const financeSettings = useQuery(api.financeSettings.getFinanceSettings);
  const chapterAccount = useQuery(api.increase.getChapterAccount);

  const setAccountFund = useMutation(api.stripeFinance.setAccountFund);
  const disconnect = useMutation(api.stripeFinance.disconnect);
  const setSandboxMode = useMutation(api.financeSettings.setSandboxMode);
  const provisionAccount = useAction(api.increase.provisionChapterAccount);
  const { run, toast, dismiss } = useActionRunner();

  const fundOptions = useMemo<FundOption[]>(
    () => (funds ?? []).map((f) => ({ value: f.id, label: f.name })),
    [funds],
  );

  // In-screen guard: Accounts is a finance-manager surface (admin or lead for
  // now, mirroring the nav gate).
  const tier = org?.tier;
  if (org !== undefined && tier !== "admin" && tier !== "lead") {
    return (
      <Screen>
        <Narrow>
          <EmptyState
            title="Finances is restricted"
            message="Only chapter admins and finance managers can manage connected accounts."
          />
        </Narrow>
      </Screen>
    );
  }

  if (
    org === undefined ||
    accounts === undefined ||
    funds === undefined ||
    financeSettings === undefined ||
    chapterAccount === undefined
  ) {
    return <Screen loading />;
  }

  const sandboxMode = financeSettings.sandboxMode;

  // The chapter's Increase account is provisioned in whichever environment the
  // account id is prefixed for (`sandbox_…` = sandbox), independent of the
  // current sandbox toggle.
  const accountIsSandbox =
    chapterAccount?.increaseAccountId?.startsWith("sandbox_") ?? false;

  return (
    <Screen>
      <Narrow>
        <Text className="mb-1 font-display text-2xl text-ink">Accounts</Text>
        <Text className="mb-4 text-sm text-muted">
          Connect existing bank & card accounts read-only. Their transactions
          flow into Reconcile. Increase (the card + payout layer) comes later.
        </Text>

        <View className="mb-1">
          <ToastView toast={toast} onDismiss={dismiss} />
        </View>

        <SectionHeader title="Chapter bank account" />
        <Card>
          {chapterAccount === null ? (
            // No Increase account yet → offer to provision one in the current mode.
            <View className="flex-row items-start justify-between gap-3">
              <View className="flex-1">
                <Text className="font-display text-base text-ink">
                  No Increase account yet
                </Text>
                <Text className="mt-1 text-sm text-muted">
                  Provision the chapter's Increase bank account to enable ACH
                  reimbursement payouts.
                </Text>
                <View className="mt-2">
                  <Badge
                    label={`Will provision in ${sandboxMode ? "SANDBOX" : "PRODUCTION"} mode`}
                    tone={sandboxMode ? "warn" : "neutral"}
                    icon={sandboxMode ? "alert-triangle" : "check-circle"}
                  />
                </View>
              </View>
              <Button
                title="Provision account"
                icon="plus"
                onPress={() =>
                  void run(() => provisionAccount({}), {
                    errorTitle: "Couldn't provision the account",
                  })
                }
              />
            </View>
          ) : chapterAccount.onboardingStatus === "active" ? (
            // Active → show the account + entity ids and which environment it lives in.
            <View className="gap-2">
              <View className="flex-row flex-wrap items-center gap-2">
                <Text className="font-display text-base text-ink">
                  Increase account
                </Text>
                <Badge label="Active" tone="success" icon="check-circle" />
                <Badge
                  label={accountIsSandbox ? "SANDBOX" : "PRODUCTION"}
                  tone={accountIsSandbox ? "warn" : "neutral"}
                  icon={accountIsSandbox ? "alert-triangle" : "check-circle"}
                />
              </View>
              <Text className="text-sm text-muted">
                Account:{" "}
                <Text className="text-ink">{chapterAccount.increaseAccountId}</Text>
              </Text>
              {chapterAccount.increaseEntityId ? (
                <Text className="text-sm text-muted">
                  Entity:{" "}
                  <Text className="text-ink">
                    {chapterAccount.increaseEntityId}
                  </Text>
                </Text>
              ) : null}
            </View>
          ) : (
            // Pending (or not fully provisioned) → explain + let the manager retry.
            <View className="flex-row items-start justify-between gap-3">
              <View className="flex-1">
                <View className="flex-row flex-wrap items-center gap-2">
                  <Text className="font-display text-base text-ink">
                    Increase account
                  </Text>
                  <Badge label="Pending" tone="warn" icon="alert-triangle" />
                </View>
                <Text className="mt-1 text-sm text-muted">
                  Provisioning didn't complete — the Increase environment may not
                  be fully configured, or the call failed. Retry to open the
                  account.
                </Text>
                <View className="mt-2">
                  <Badge
                    label={`Will provision in ${sandboxMode ? "SANDBOX" : "PRODUCTION"} mode`}
                    tone={sandboxMode ? "warn" : "neutral"}
                    icon={sandboxMode ? "alert-triangle" : "check-circle"}
                  />
                </View>
              </View>
              <Button
                title="Retry"
                icon="refresh-cw"
                onPress={() =>
                  void run(() => provisionAccount({}), {
                    errorTitle: "Couldn't provision the account",
                  })
                }
              />
            </View>
          )}
        </Card>

        <ConnectPanel />

        <SectionHeader title="Connected accounts" count={accounts.length} />
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
              funds={fundOptions}
              onSetFund={(fundId: Id<"funds">) =>
                void run(
                  () =>
                    setAccountFund({
                      legacyAccountId: account.id,
                      fundId,
                    }),
                  { errorTitle: "Couldn't set the default fund" },
                )
              }
              onDisconnect={() =>
                void run(
                  () => disconnect({ legacyAccountId: account.id }),
                  { errorTitle: "Couldn't disconnect the account" },
                )
              }
            />
          ))
        )}

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
              </View>
              <Text className="mt-1 text-sm text-muted">
                Points NEWLY provisioned accounts at the Increase sandbox for
                testing — no real money moves. Existing accounts keep their
                current environment. Superuser only.
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
