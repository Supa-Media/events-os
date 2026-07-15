/**
 * Member perspective of the Cards tab — the caller's OWN card. Real data from
 * `api.cards.myCard` + `api.finances.personTransactions`: the red virtual-card
 * art, a status/spend summary with a receipt-due warning, the two hard controls
 * shown READ-ONLY (a member can't change their own cap/validity — that's a
 * manager action), a personal-repayment banner, and the ability to flag one of
 * their charges as a personal expense and pay it back.
 *
 * Personal-repayment flow (member side): Flag → `flagPersonalCharge` (returns the
 * repayment) → "Pay by card / bank" → `initiateRepayment({ repaymentId, method })`.
 * A member may only INITIATE a repayment — they can't post the offsetting credit
 * themselves (that's a manager-only "confirm money received" via
 * `markRepaymentPaid`). Since Increase isn't wired up yet, `initiateRepayment`
 * DEGRADES to a still-`pending` repayment (no money moves, no credit), so we show
 * "Repayment initiated · pending" rather than "Repaid".
 *
 * Note: the Phase-5 card contract has no query that lists a member's pending
 * repayments, so a flagged charge is tracked in local state for the session it
 * was flagged in.
 */
import { useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { formatCents } from "@events-os/shared";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Icon,
  SectionHeader,
  ToastView,
} from "../../ui";
import { colors } from "../../../lib/theme";
import { useActionRunner } from "../../../lib/useActionToast";
import { VirtualCardArt } from "./VirtualCardArt";
import { CardPhilosophy } from "./CardPhilosophy";
import {
  cardStatusBadge,
  cardTypeLabel,
  expLabel,
  maskedNumber,
  shortDate,
  type CardSummary,
  type RepaymentSummary,
} from "./helpers";

export function MemberCardsView() {
  const cards = useQuery(api.cards.myCard, {});
  const txns = useQuery(api.finances.personTransactions, {});
  const flag = useMutation(api.cards.flagPersonalCharge);
  // A member may only INITIATE a repayment (choose a method + kick it off) — the
  // offsetting credit is posted by a manager confirming receipt, never here.
  const initiateRepayment = useAction(api.cards.initiateRepayment);
  const { run, toast, dismiss } = useActionRunner();

  // Repayments flagged this session, keyed by their transaction id.
  const [repayments, setRepayments] = useState<Record<string, RepaymentSummary>>(
    {},
  );
  // Transaction ids the member has already kicked off a repayment for (so the
  // row shows the pending state rather than the "Pay back" action again).
  const [initiated, setInitiated] = useState<Record<string, boolean>>({});

  // Charges the member still needs to act on: flagged, not yet initiated.
  const toRepay = useMemo(
    () =>
      Object.values(repayments).filter(
        (r) => r.status !== "paid" && !initiated[r.transactionId],
      ),
    [repayments, initiated],
  );
  const owedCents = toRepay.reduce((sum, r) => sum + r.amountCents, 0);

  const card: CardSummary | undefined = cards?.[0];

  async function handleFlag(transactionId: string) {
    const res = await run(
      () => flag({ transactionId: transactionId as Id<"transactions"> }),
      { errorTitle: "Couldn't flag charge" },
    );
    if (res) setRepayments((m) => ({ ...m, [res.transactionId]: res }));
  }

  async function handleInitiate(
    repaymentId: string,
    transactionId: string,
    method: "card" | "ach",
  ) {
    const res = await run(
      () =>
        initiateRepayment({
          repaymentId: repaymentId as Id<"personalRepayments">,
          method,
        }),
      { errorTitle: "Couldn't start repayment" },
    );
    if (res) {
      setRepayments((m) => ({ ...m, [transactionId]: res }));
      setInitiated((m) => ({ ...m, [transactionId]: true }));
    }
  }

  async function payAll(method: "card" | "ach") {
    for (const r of toRepay) {
      await handleInitiate(r.id, r.transactionId, method);
    }
  }

  if (cards === undefined) {
    return <EmptyState title="Loading your card…" />;
  }

  if (!card) {
    return (
      <View>
        <View className="mb-1">
          <Text className="font-display text-2xl text-ink">Your card</Text>
        </View>
        <EmptyState
          icon="credit-card"
          title="No card yet"
          message="You don't have a card on this chapter's account. Ask a finance manager to issue you one — every team member gets their own."
        />
        <SectionHeader title="How cards work" />
        <CardPhilosophy />
      </View>
    );
  }

  const status = cardStatusBadge(card.status);
  const grace = card.receiptGraceEndsAt;
  const receiptOverdue = card.status === "locked" || (grace != null && grace <= Date.now());
  const capLabel =
    card.monthlyCapCents != null ? formatCents(card.monthlyCapCents) : "No cap";
  const validityLabel =
    card.validFrom != null || card.validUntil != null
      ? `${card.validFrom != null ? shortDate(card.validFrom) : "Now"} – ${
          card.validUntil != null ? shortDate(card.validUntil) : "Open"
        }`
      : "No limit";

  // A member can only flag their own CARD charges. `personTransactions` doesn't
  // expose the card link, so we offer the action on outflows and let the backend
  // reject a non-card charge (surfaced via the toast).
  const charges = (txns ?? []).filter((t) => t.flow === "outflow");

  return (
    <View>
      <View className="mb-1">
        <Text className="font-display text-2xl text-ink">Your card</Text>
      </View>
      <Text className="mb-4 text-sm text-muted">
        Your own card on the chapter's Increase account — no budget limit, just
        keep every charge's receipt current.
      </Text>

      {/* Card art + summary. */}
      <View className="flex-row flex-wrap gap-4">
        <View className="min-w-[260px] flex-1">
          <VirtualCardArt
            last4={card.last4 ?? "••••"}
            holderName={(card.cardholderName ?? "Cardholder").toUpperCase()}
            expLabel={expLabel(card.validUntil)}
            typeLabel={`Increase ${cardTypeLabel(card.type).toLowerCase()}`}
          />
        </View>

        <View className="min-w-[260px] flex-1">
          <Card>
            <View className="gap-3">
              <View className="flex-row items-center justify-between">
                <Text className="font-semibold text-ink">Your card</Text>
                <Badge label={status.label} tone={status.tone} icon={status.icon} />
              </View>

              <View className="flex-row items-end justify-between">
                <View>
                  <Text
                    className="font-display text-2xl text-ink"
                    style={{ fontVariant: ["tabular-nums"] }}
                  >
                    {formatCents(card.spentThisMonthCents)}
                  </Text>
                  <Text className="text-xs text-muted">spent this month</Text>
                </View>
                <Text className="text-xs text-faint">
                  {maskedNumber(card.last4)}
                </Text>
              </View>

              {/* Receipt-due warning. */}
              {grace != null || card.status === "locked" ? (
                <View
                  className={`rounded-md border px-3 py-2 ${
                    receiptOverdue
                      ? "border-danger bg-danger-bg"
                      : "border-warn bg-warn-bg"
                  }`}
                >
                  <Text
                    className={`text-xs ${receiptOverdue ? "text-danger" : "text-warn"}`}
                  >
                    {receiptOverdue
                      ? "A receipt is overdue — your card locks until you add it."
                      : `Add a receipt by ${grace != null ? shortDate(grace) : "soon"} to avoid an auto-lock.`}
                  </Text>
                </View>
              ) : null}

              <View className="h-px bg-border" />

              {/* The two hard controls — read-only for the cardholder. */}
              <View className="gap-2">
                <ControlRow label="Monthly cap" value={capLabel} />
                <ControlRow label="Validity" value={validityLabel} />
                <Text className="text-2xs text-faint">
                  Only a finance manager can change these.
                </Text>
              </View>
            </View>
          </Card>
        </View>
      </View>

      {/* Personal-repayment banner (a charge flagged this session). The member
          starts the repayment by their own card or bank; a manager confirms the
          money landed (posts the offsetting credit) — nothing clears here. */}
      {toRepay.length > 0 ? (
        <View
          className="mt-4 rounded-lg border border-border bg-raised p-4 shadow-card"
          style={{ borderLeftWidth: 3, borderLeftColor: colors.accent }}
        >
          <View className="flex-row flex-wrap items-center justify-between gap-3">
            <View className="flex-1 flex-row items-start gap-3">
              <View className="mt-0.5 h-8 w-8 items-center justify-center rounded-pill bg-accent-soft">
                <Icon name="refresh-cw" size={16} color={colors.accent} />
              </View>
              <View className="flex-1">
                <Text className="font-semibold text-ink">
                  You owe the church {formatCents(owedCents)}
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
                onPress={() => payAll("ach")}
              />
            </View>
          </View>
        </View>
      ) : null}

      {/* My card charges — flag personal / pay back. */}
      <SectionHeader
        title="My charges"
        count={charges.length || undefined}
      />
      {txns === undefined ? (
        <EmptyState title="Loading charges…" />
      ) : charges.length === 0 ? (
        <EmptyState
          title="No charges yet"
          message="Charges on your card show up here to receipt and reconcile."
        />
      ) : (
        <View className="overflow-hidden rounded-lg border border-border bg-raised shadow-card">
          {charges.map((t, i) => {
            const rep = repayments[t.id];
            const isLast = i === charges.length - 1;
            return (
              <View
                key={t.id}
                className={`flex-row items-center gap-3 px-4 py-3 ${
                  isLast ? "" : "border-b border-border"
                }`}
              >
                <View className="flex-1">
                  <Text className="text-sm font-semibold text-ink" numberOfLines={1}>
                    {t.merchantName ?? t.description ?? "Charge"}
                  </Text>
                  <View className="flex-row items-center gap-1.5">
                    {rep ? (
                      <Badge
                        label="personal"
                        tone="accent"
                      />
                    ) : null}
                    <Text className="text-xs text-faint" numberOfLines={1}>
                      {shortDate(t.postedAt)}
                    </Text>
                  </View>
                </View>

                <Text
                  className="w-24 text-right text-sm font-semibold text-ink"
                  style={{ fontVariant: ["tabular-nums"] }}
                >
                  −{formatCents(t.amountCents)}
                </Text>

                <View className="w-[168px] items-end">
                  {rep && rep.status === "paid" ? (
                    <Badge label="Repaid" tone="info" icon="check" />
                  ) : rep && initiated[t.id] ? (
                    <Badge
                      label="Initiated · pending"
                      tone="warn"
                      icon="clock"
                    />
                  ) : rep ? (
                    <Button
                      title={`Pay back ${formatCents(rep.amountCents)}`}
                      variant="secondary"
                      size="sm"
                      icon="refresh-cw"
                      onPress={() => handleInitiate(rep.id, t.id, "card")}
                    />
                  ) : (
                    <Button
                      title="Flag personal"
                      variant="ghost"
                      size="sm"
                      icon="flag"
                      onPress={() => handleFlag(t.id)}
                    />
                  )}
                </View>
              </View>
            );
          })}
        </View>
      )}

      {/* Static philosophy + pay-it-back explainers. */}
      <SectionHeader title="How cards work" />
      <CardPhilosophy />

      <ToastView toast={toast} onDismiss={dismiss} />
    </View>
  );
}

function ControlRow({ label, value }: { label: string; value: string }) {
  return (
    <View className="flex-row items-center justify-between">
      <Text className="text-xs font-semibold uppercase tracking-wider text-muted">
        {label}
      </Text>
      <Text className="text-sm text-ink" style={{ fontVariant: ["tabular-nums"] }}>
        {value}
      </Text>
    </View>
  );
}
