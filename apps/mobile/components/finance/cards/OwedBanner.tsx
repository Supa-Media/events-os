/**
 * "You owe Public Worship" banner — the SHARED personal-charge-repayment CTA
 * used on BOTH the Cards tab (`MemberCardsView`) and the Reimbursements
 * screen's "You owe" section (D4, bidirectional owe surface). Single data
 * source: `api.cards.myPersonalRepayments` — the caller's own personal-charge
 * repayments (every status; this component filters to non-`paid`), whoever
 * flagged them (the cardholder themselves OR a finance manager). Previously
 * the Cards-tab banner only tracked charges
 * flagged THIS session (local React state, see PR #94's note); a
 * manager-flagged charge never showed up there. Now both surfaces read the
 * same live query, so this file is the ONE place the pay-back flow lives —
 * don't duplicate it into either screen.
 *
 * Renders nothing while loading or once there's nothing owed — including
 * once every remaining repayment has been INITIATED this session (`initiated`
 * below), a state the banner tracks locally that no query alone reflects.
 * `onEmptyChange` reports that effective emptiness (whenever it changes) so a
 * caller with its own adjacent header/count (the Reimbursements screen's "You
 * owe Public Worship" section) can hide/collapse in lockstep instead of
 * showing a stale count over a banner that just went blank.
 *
 * Pay by card / Pay by bank (ACH) pay ALL outstanding repayments at once via
 * `initiateRepayment`. The real ACH debit is feature-gated OFF
 * (`REPAYMENT_DEBIT_ENABLED` in cards.ts) — every call degrades to a `pending`
 * repayment, so a manager confirms receipt manually (`markRepaymentPaid`).
 * That gate is untouched here; this component only ever calls the existing
 * degrade-safe actions.
 */
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { useAction, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import { formatCents } from "@events-os/shared";
import { Button, Icon, Select, TextField, ToastView } from "../../ui";
import { colors } from "../../../lib/theme";
import { useActionRunner } from "../../../lib/useActionToast";

export function OwedBanner({
  onEmptyChange,
}: {
  /** Fires with the banner's effective emptiness (loading counts as NOT
   *  empty, so a caller doesn't hide its section before data arrives). */
  onEmptyChange?: (empty: boolean) => void;
} = {}) {
  const repayments = useQuery(api.cards.myPersonalRepayments, {});
  // A member may only INITIATE a repayment (choose a method + kick it off) —
  // the offsetting credit is posted by a manager confirming receipt, never here.
  const initiateRepayment = useAction(api.cards.initiateRepayment);
  const linkRepaymentBankAccount = useAction(api.cards.linkRepaymentBankAccount);
  const { run, toast, dismiss } = useActionRunner();

  const [achFormOpen, setAchFormOpen] = useState(false);
  const [achRouting, setAchRouting] = useState("");
  const [achAccount, setAchAccount] = useState("");
  const [achFunding, setAchFunding] = useState<"checking" | "savings">("checking");
  const [achBusy, setAchBusy] = useState(false);
  // Repayments this session already kicked off — the real debit is gated off
  // (see file header), so `status` alone never flips away from "pending" here;
  // this is purely so the button doesn't invite a repeat click.
  const [initiated, setInitiated] = useState<Record<string, boolean>>({});

  const toRepay = (repayments ?? []).filter(
    (r) => r.status !== "paid" && !initiated[r.id],
  );
  const owedCents = toRepay.reduce((sum, r) => sum + r.amountCents, 0);

  // Report effective emptiness to the caller (see file header). Skipped while
  // still loading so a caller's section doesn't collapse before data arrives;
  // recomputes on every `toRepay` change, including one driven purely by
  // local `initiated` state (no query round-trip), so a caller's header stays
  // in lockstep even when the underlying repayment rows haven't changed.
  useEffect(() => {
    if (repayments === undefined) return;
    onEmptyChange?.(toRepay.length === 0);
  }, [repayments, toRepay.length, onEmptyChange]);

  async function payAll(method: "card" | "ach") {
    for (const r of toRepay) {
      const res = await run(
        () => initiateRepayment({ repaymentId: r.id, method }),
        { errorTitle: "Couldn't start repayment" },
      );
      if (res) setInitiated((m) => ({ ...m, [r.id]: true }));
    }
  }

  /** "Pay by bank (ACH)" — link a bank account first if any charge still
   *  needs one, else pay straight away. */
  function handlePayByBank() {
    const needsLink = toRepay.some((r) => !r.hasExternalAccount);
    if (needsLink) {
      setAchFormOpen(true);
      return;
    }
    void payAll("ach");
  }

  async function handleLinkAndPay() {
    setAchBusy(true);
    const toLink = toRepay.filter((r) => !r.hasExternalAccount);
    for (const r of toLink) {
      await run(
        () =>
          linkRepaymentBankAccount({
            repaymentId: r.id,
            routingNumber: achRouting.trim(),
            accountNumber: achAccount.trim(),
            funding: achFunding,
          }),
        { errorTitle: "Couldn't link bank account" },
      );
    }
    setAchBusy(false);
    setAchFormOpen(false);
    setAchRouting("");
    setAchAccount("");
    // Best-effort even if a link above failed — `initiateRepayment` just
    // degrades that one to pending, same as before this feature existed.
    await payAll("ach");
  }

  if (repayments === undefined || toRepay.length === 0) return null;

  return (
    <>
      <View
        className="rounded-lg border border-border bg-raised p-4 shadow-card"
        style={{ borderLeftWidth: 3, borderLeftColor: colors.accent }}
      >
        <View className="flex-row flex-wrap items-center justify-between gap-3">
          <View className="flex-1 flex-row items-start gap-3">
            <View className="mt-0.5 h-8 w-8 items-center justify-center rounded-pill bg-accent-soft">
              <Icon name="refresh-cw" size={16} color={colors.accent} />
            </View>
            <View className="flex-1">
              <Text className="font-semibold text-ink">
                You owe Public Worship {formatCents(owedCents)}
              </Text>
              <Text className="text-xs text-muted">
                {toRepay.length} charge{toRepay.length === 1 ? "" : "s"} flagged
                personal. Pay it back from your own debit card or bank (ACH) — a
                manager confirms receipt and it posts an offsetting credit, no
                reimbursement paperwork.
              </Text>
            </View>
          </View>
          <View className="flex-row items-center gap-2">
            <Button
              title="Pay by card"
              variant="secondary"
              size="sm"
              icon="credit-card"
              onPress={() => payAll("card")}
            />
            <Button
              title="Pay by bank (ACH)"
              size="sm"
              onPress={handlePayByBank}
            />
          </View>
        </View>

        {/* Inline ACH-destination capture — shown once, the first time a
            charge in this batch has no linked bank account yet. */}
        {achFormOpen ? (
          <View className="mt-3 gap-2 border-t border-border pt-3">
            <Text className="text-xs text-muted">
              Link your bank account to pay by ACH — securely, through our
              banking partner. We never store your full account number.
            </Text>
            <View className="flex-row gap-2">
              <View className="flex-1">
                <TextField
                  label="Routing number"
                  value={achRouting}
                  onChangeText={(v) => setAchRouting(v.replace(/[^0-9]/g, "").slice(0, 9))}
                  keyboardType="number-pad"
                  maxLength={9}
                  placeholder="9 digits"
                />
              </View>
              <View className="flex-1">
                <TextField
                  label="Account number"
                  value={achAccount}
                  onChangeText={(v) => setAchAccount(v.replace(/[^0-9]/g, "").slice(0, 17))}
                  keyboardType="number-pad"
                  placeholder="e.g. 000123456789"
                />
              </View>
              <View className="w-28">
                <Select
                  label="Type"
                  value={achFunding}
                  options={[
                    { value: "checking", label: "Checking" },
                    { value: "savings", label: "Savings" },
                  ]}
                  onChange={(v) => setAchFunding((v || "checking") as "checking" | "savings")}
                />
              </View>
            </View>
            <View className="flex-row justify-end gap-2">
              <Button
                title="Cancel"
                variant="ghost"
                size="sm"
                onPress={() => setAchFormOpen(false)}
              />
              <Button
                title="Link & pay"
                size="sm"
                loading={achBusy}
                disabled={achRouting.length !== 9 || achAccount.length < 4}
                onPress={handleLinkAndPay}
              />
            </View>
          </View>
        ) : null}
      </View>
      <ToastView toast={toast} onDismiss={dismiss} />
    </>
  );
}
