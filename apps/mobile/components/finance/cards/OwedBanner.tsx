/**
 * "You owe Public Worship" banner — the SHARED personal-charge summary used on
 * BOTH the Cards tab (`MemberCardsView`) and the Reimbursements screen's "You
 * owe" section (D4, bidirectional owe surface). Single data source:
 * `api.cards.myPersonalRepayments` — the caller's own personal-charge
 * repayments (every status; this component filters to non-`paid`), whoever
 * flagged them (the cardholder themselves OR a finance manager).
 *
 * ── IT IS A POINTER NOW, NOT THE PAY FLOW (founder, 2026-08-14) ──────────────
 * This component used to BE the repayment flow: one "Pay by card" button that
 * bundled every outstanding charge into a single Stripe Checkout, plus an
 * inline routing/account form for an ACH rail. The founder's objection was
 * that paying is not an all-or-nothing act —
 *
 *   "It shouldn't be all at once, because for some things it's like 'oh, I
 *    accidentally paid for a company expense with this'… but then another one,
 *    'oh, that's a personal charge'. I want people to be able to break up what
 *    card they use per transaction. So allow people to multi-select."
 *
 * — and a banner is the wrong surface for a list you select from. The flow
 * moved to `/finances/repayments`, which shows the charges individually, lets
 * you pick a subset, and quotes the Stripe fee the org would otherwise eat.
 * This banner keeps what a banner is good at: saying that you owe something,
 * how much, and where to go. Two things went away with the move:
 *
 *  · The local "initiated this session" state (and its `onEmptyChange`
 *    reporting). It existed because the ACH rail below never changed a row's
 *    status, so the button had to remember what it had already done. With one
 *    real rail whose settlement is a webhook, the query IS the truth and a
 *    banner that hid itself on a click that hadn't paid anything was lying.
 *    Callers now hide their own section on the plain query result.
 *  · The inline ACH form. It collected real routing and account numbers into
 *    a debit rail that is feature-gated OFF (`cards.ts`'s
 *    `REPAYMENT_DEBIT_ENABLED = false`, documented there as awaiting a bounce
 *    state machine). Asking a volunteer for their bank details so that nothing
 *    can happen with them is worse than not offering the option. The backend
 *    (`linkRepaymentBankAccount` / `initiateRepayment`) is untouched and ready
 *    for the day that gate flips.
 */
import { Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import { formatCents } from "@events-os/shared";
import { Button, Icon } from "../../ui";
import { colors } from "../../../lib/theme";

export function OwedBanner() {
  const router = useRouter();
  const repayments = useQuery(api.cards.myPersonalRepayments, {});

  const toRepay = (repayments ?? []).filter((r) => r.status !== "paid");
  const owedCents = toRepay.reduce((sum, r) => sum + r.amountCents, 0);

  if (repayments === undefined || toRepay.length === 0) return null;

  return (
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
              personal. Pick the ones you&apos;re ready to settle and pay them
              with your own card — no reimbursement paperwork.
            </Text>
          </View>
        </View>
        <Button
          title="Review & pay"
          size="sm"
          icon="credit-card"
          onPress={() => router.navigate("/finances/repayments" as never)}
        />
      </View>
    </View>
  );
}
