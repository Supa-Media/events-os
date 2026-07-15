/**
 * FINANCES · ACCOUNTS — two DISTINCT things live here, kept clearly separate:
 *
 *  1. The chapter's INCREASE ACCOUNT — the native card + ACH-payout layer (issue
 *     member cards, send reimbursement payouts). This is NOT a linked bank; it's
 *     the money layer Chapter OS runs on. Provisioned via
 *     `api.increase.provisionChapterAccount`, removed (stale test rows only) via
 *     `api.increase.removeChapterAccount`.
 *  2. CONNECTED ACCOUNTS — external bank/card accounts linked READ-ONLY via
 *     Stripe Financial Connections. Stripe FC only *reads* them; their
 *     transactions sync in as `unreviewed` rows that land in the Reconcile queue,
 *     pre-coded to each account's default fund. Contract:
 *     `api.stripeFinance.{listAccounts,setAccountFund,disconnect,createFcSession}`.
 *
 * MODE-AWARE ACCOUNT: a chapter may hold BOTH a sandbox and a production Increase
 * account (up to one per environment). `api.increase.getChapterAccount` returns
 * ONLY the account matching the current `financeSettings.sandboxMode`, so the
 * off-mode account is simply hidden — in production you never see the sandbox
 * account and vice-versa. The shown account can be removed via
 * `api.increase.removeChapterAccount` (a live production account is protected).
 *
 * The SANDBOX-MODE toggle (developer/testing, superuser only) points NEW
 * provisioning at Increase's sandbox AND switches which environment's account
 * this page shows. Guarded admin-or-lead in-screen (mirrors the nav gate).
 * `api.finances.listFunds` supplies the default-fund options.
 */
import { useMemo, useState } from "react";
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
  TextField,
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
  const refreshFcAccount = useMutation(api.stripeFinance.refreshFcAccount);
  const setSandboxMode = useMutation(api.financeSettings.setSandboxMode);
  const provisionAccount = useAction(api.increase.provisionChapterAccount);
  const linkAccount = useAction(api.increase.linkIncreaseAccount);
  const removeChapterAccount = useMutation(api.increase.removeChapterAccount);
  const { run, toast, dismiss } = useActionRunner();

  const handleLink = (increaseAccountId: string) =>
    void run(() => linkAccount({ increaseAccountId }), {
      errorTitle: "Couldn't link the account",
    });

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

  // `getChapterAccount` only ever returns the account for the CURRENT mode, so
  // the shown account's environment is always the current one — no per-row
  // prefix check needed. A live PRODUCTION account is protected from removal
  // backend-side; while in sandbox mode the shown (sandbox/test) account is
  // freely removable.
  const canRemoveAccount =
    chapterAccount !== null &&
    (sandboxMode || chapterAccount.onboardingStatus !== "active");

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

        <SectionHeader title="Card & payout account (Increase)" />
        <Text className="mb-3 text-sm text-muted">
          The chapter's native account for issuing member cards and sending ACH
          reimbursement payouts. This is not a linked bank — it's the money layer
          Chapter OS runs on. You're viewing the{" "}
          {sandboxMode ? "SANDBOX" : "PRODUCTION"} account; switch modes below to
          manage the other environment.
        </Text>
        <Card>
          {chapterAccount === null ? (
            // No Increase account yet → offer to provision one in the current
            // mode, OR link an existing account by id (avoids a duplicate).
            <View className="gap-3">
              <View className="flex-row items-start justify-between gap-3">
                <View className="flex-1">
                  <Text className="font-display text-base text-ink">
                    No account yet
                  </Text>
                  <Text className="mt-1 text-sm text-muted">
                    Provision the chapter's Increase account to enable member
                    cards and ACH reimbursement payouts.
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
              <View className="border-t border-border-strong pt-3">
                <LinkExistingAccount onLink={handleLink} />
              </View>
            </View>
          ) : chapterAccount.onboardingStatus === "active" ? (
            // Active → show the account + entity ids for the CURRENT environment.
            // The shown account always matches the current mode (the off-mode
            // account is hidden), so the environment badge reflects `sandboxMode`.
            <View className="gap-2">
              <View className="flex-row flex-wrap items-center justify-between gap-2">
                <View className="flex-row flex-wrap items-center gap-2">
                  <Text className="font-display text-base text-ink">
                    Increase account
                  </Text>
                  <Badge label="Active" tone="success" icon="check-circle" />
                  <Badge
                    label={sandboxMode ? "SANDBOX" : "PRODUCTION"}
                    tone={sandboxMode ? "warn" : "neutral"}
                    icon={sandboxMode ? "alert-triangle" : "check-circle"}
                  />
                </View>
                {canRemoveAccount ? (
                  // Sandbox/test account → freely removable (cascades its sandbox
                  // cards/payouts/txns). A live production account is hidden here
                  // (backend also refuses to remove it).
                  <Button
                    title="Remove account"
                    variant="danger"
                    icon="trash-2"
                    onPress={() =>
                      void run(() => removeChapterAccount({}), {
                        errorTitle: "Couldn't remove the account",
                      })
                    }
                  />
                ) : null}
              </View>
              <Text className="text-sm text-muted">
                Account:{" "}
                <Text className="text-ink">
                  {chapterAccount.increaseAccountId}
                </Text>
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
            // Pending (or not fully provisioned) → explain + let the manager
            // retry auto-provision, link an existing account by id, or remove.
            <View className="gap-3">
              <View className="flex-row items-start justify-between gap-3">
                <View className="flex-1">
                  <View className="flex-row flex-wrap items-center gap-2">
                    <Text className="font-display text-base text-ink">
                      Increase account
                    </Text>
                    <Badge label="Pending" tone="warn" icon="alert-triangle" />
                  </View>
                  <Text className="mt-1 text-sm text-muted">
                    Provisioning didn't complete — the Increase environment may
                    not be fully configured, or the call failed. Retry to open
                    the account, or link an existing one by id.
                  </Text>
                  <View className="mt-2">
                    <Badge
                      label={`Will provision in ${sandboxMode ? "SANDBOX" : "PRODUCTION"} mode`}
                      tone={sandboxMode ? "warn" : "neutral"}
                      icon={sandboxMode ? "alert-triangle" : "check-circle"}
                    />
                  </View>
                </View>
                <View className="gap-2">
                  <Button
                    title="Retry"
                    icon="refresh-cw"
                    onPress={() =>
                      void run(() => provisionAccount({}), {
                        errorTitle: "Couldn't provision the account",
                      })
                    }
                  />
                  <Button
                    title="Remove"
                    variant="danger"
                    icon="trash-2"
                    onPress={() =>
                      void run(() => removeChapterAccount({}), {
                        errorTitle: "Couldn't remove the account",
                      })
                    }
                  />
                </View>
              </View>
              <View className="border-t border-border-strong pt-3">
                <LinkExistingAccount onLink={handleLink} />
              </View>
            </View>
          )}
        </Card>

        <SectionHeader title="Connected accounts" count={accounts.length} />
        <Text className="mb-3 text-sm text-muted">
          External bank &amp; card accounts linked read-only through Stripe. We
          pull in their transactions for reconciliation — we never move money in
          or out of them.
        </Text>
        <View className="mb-3">
          <ConnectPanel />
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
              onRefresh={() =>
                run(
                  () => refreshFcAccount({ legacyAccountId: account.id }),
                  { errorTitle: "Couldn't refresh the account" },
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

/**
 * Link an EXISTING Increase account by pasting its id — the reliable
 * counterpart to auto-provision when the owner already opened the chapter's
 * account in the Increase dashboard (or a provision got stuck). Collapsed to a
 * single button until tapped; on link it calls `api.increase.linkIncreaseAccount`
 * for the current mode via `onLink`.
 */
function LinkExistingAccount({
  onLink,
}: {
  onLink: (increaseAccountId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [accountId, setAccountId] = useState("");

  if (!expanded) {
    return (
      <Button
        title="Link existing account"
        variant="secondary"
        icon="link"
        onPress={() => setExpanded(true)}
      />
    );
  }

  const trimmed = accountId.trim();
  return (
    <View className="gap-2">
      <Text className="text-sm text-muted">
        Already have an Increase account? Paste its id to link it instead of
        creating a new one.
      </Text>
      <TextField
        label="Increase account id"
        hint="Copy the account id from your Increase dashboard."
        placeholder="account_…"
        autoCapitalize="none"
        autoCorrect={false}
        value={accountId}
        onChangeText={setAccountId}
      />
      <View className="flex-row gap-2">
        <Button
          title="Link account"
          icon="link"
          disabled={trimmed.length === 0}
          onPress={() => onLink(trimmed)}
        />
        <Button
          title="Cancel"
          variant="secondary"
          onPress={() => {
            setExpanded(false);
            setAccountId("");
          }}
        />
      </View>
    </View>
  );
}
