/**
 * Member perspective of the Cards tab — the caller's OWN card. Real data from
 * `api.cards.myCard` + `api.finances.personTransactions`: the red virtual-card
 * art, a status/spend summary with a receipt-due warning, the two hard controls
 * shown READ-ONLY (a member can't change their own cap/validity — that's a
 * manager action), the shared "You owe" banner (`OwedBanner`), and the ability
 * to flag one of their charges as a personal expense and pay it back.
 *
 * Personal-repayment flow (member side): Flag → `flagPersonalCharge` (returns the
 * repayment) → "Pay by card / bank" → `initiateRepayment({ repaymentId, method })`.
 * A member may only INITIATE a repayment — they can't post the offsetting credit
 * themselves (that's a manager-only "confirm money received" via
 * `markRepaymentPaid`). Since Increase isn't wired up yet, `initiateRepayment`
 * DEGRADES to a still-`pending` repayment (no money moves, no credit), so we show
 * "Repayment initiated · pending" rather than "Repaid".
 *
 * The aggregate owe banner (amount + "Pay by card"/"Pay by bank") lives in
 * `OwedBanner` — shared with the Reimbursements screen's "You owe" section
 * (D4) so the pay-back flow exists in exactly one place. THIS file still owns
 * the per-charge "My charges" list (flag a charge / pay back ONE charge),
 * sourced from the SAME `api.cards.myPersonalRepayments` query (a manager can
 * flag a charge on this member's behalf, so the source of truth can't be
 * session-local state anymore — see the query's doc comment).
 */
import { useMemo, useState } from "react";
import { Alert, Text, View } from "react-native";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { formatCents } from "@events-os/shared";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  SectionHeader,
  TextField,
  ToastView,
} from "../../ui";
import { useActionRunner } from "../../../lib/useActionToast";
import { VirtualCardArt } from "./VirtualCardArt";
import { CardPhilosophy } from "./CardPhilosophy";
import { OwedBanner } from "./OwedBanner";
import {
  cardStatusBadge,
  cardTypeLabel,
  expLabel,
  maskedNumber,
  shortDate,
  type CardSummary,
  type MyRepayment,
} from "./helpers";

export function MemberCardsView() {
  const myCard = useQuery(api.cards.myCard, {});
  const cards = myCard?.cards;
  const lastCanceled = myCard?.lastCanceled;
  const txns = useQuery(api.finances.personTransactions, {});
  const myRepayments = useQuery(api.cards.myPersonalRepayments, {});
  const myRequest = useQuery(api.cards.myCardRequest, {});
  const flag = useMutation(api.cards.flagPersonalCharge);
  // A member may only INITIATE a repayment (choose a method + kick it off) — the
  // offsetting credit is posted by a manager confirming receipt, never here.
  const initiateRepayment = useAction(api.cards.initiateRepayment);
  // Self-serve freeze/unfreeze — instant, reversible ONLY by this same holder
  // (distinct from a manager's lock / the receipt auto-lock).
  const freezeCard = useAction(api.cards.freezeCard);
  const unfreezeCard = useAction(api.cards.unfreezeCard);
  const requestCard = useMutation(api.cards.requestCard);
  const { run, toast, dismiss } = useActionRunner();

  const [freezing, setFreezing] = useState(false);
  const [requestNote, setRequestNote] = useState("");
  const [requesting, setRequesting] = useState(false);

  // Transaction ids the member has already kicked off a SINGLE-row repayment
  // for (so that row shows the pending state rather than "Pay back" again).
  // Session-local: the real debit is gated off, so `status` never flips away
  // from "pending" for us to key off instead.
  const [initiated, setInitiated] = useState<Record<string, boolean>>({});

  // Outstanding repayments keyed by their charge's transaction id — drives the
  // "personal" badge + "Pay back $X" action per row in "My charges" below.
  const repByTxn = useMemo(() => {
    const m = new Map<string, MyRepayment>();
    for (const r of myRepayments ?? []) m.set(r.transactionId, r);
    return m;
  }, [myRepayments]);

  const card: CardSummary | undefined = cards?.[0];

  async function handleFlag(transactionId: string) {
    // No local state to update on success — `myPersonalRepayments` is a live
    // query, so the new row (and this row's badge/button) appear as soon as
    // the mutation commits.
    await run(() => flag({ transactionId: transactionId as Id<"transactions"> }), {
      errorTitle: "Couldn't flag charge",
    });
  }

  async function handleInitiate(repaymentId: Id<"personalRepayments">, transactionId: string) {
    const res = await run(
      () => initiateRepayment({ repaymentId, method: "card" }),
      { errorTitle: "Couldn't start repayment" },
    );
    if (res) setInitiated((m) => ({ ...m, [transactionId]: true }));
  }

  async function handleFreeze(cardId: Id<"cards">) {
    setFreezing(true);
    await run(() => freezeCard({ cardId }), { errorTitle: "Couldn't freeze card" });
    setFreezing(false);
  }

  async function handleUnfreeze(cardId: Id<"cards">) {
    setFreezing(true);
    const result = await run(() => unfreezeCard({ cardId }), {
      errorTitle: "Couldn't unfreeze card",
    });
    // The receipt lock-eligibility re-check landed the card locked again
    // instead of active — the "receipt-due" banner below already explains
    // the lock, but a one-time heads-up avoids the freeze button silently
    // doing "nothing" from the holder's perspective.
    if (result?.kind === "receipt_locked") {
      Alert.alert(
        "Card unfrozen but locked",
        "Card unfrozen but locked for overdue receipts — upload to unlock.",
      );
    }
    setFreezing(false);
  }

  async function handleRequestCard() {
    setRequesting(true);
    await run(
      () => requestCard({ note: requestNote.trim() || undefined }),
      { errorTitle: "Couldn't submit request" },
    );
    setRequesting(false);
    setRequestNote("");
  }

  if (myCard === undefined) {
    return <EmptyState title="Loading your card…" />;
  }

  if (!card) {
    return (
      <View>
        <View className="mb-1">
          <Text className="font-display text-2xl text-ink">Your card</Text>
        </View>
        {lastCanceled ? (
          <View className="mb-3 rounded-md border border-border bg-sunken px-3 py-2">
            <Text className="text-xs text-muted">
              Your previous card was canceled — request a replacement below.
            </Text>
          </View>
        ) : null}
        {myRequest?.status === "requested" ? (
          <EmptyState
            icon="clock"
            title="Request pending"
            message="Your card request is waiting on a finance manager to approve it."
          />
        ) : (
          <View className="gap-3">
            <EmptyState
              icon="credit-card"
              title="No card yet"
              message="You don't have a card on this chapter's account. Every team member gets their own — request one below, or ask a finance manager to issue it directly."
            />
            {myRequest?.status === "denied" ? (
              <View className="rounded-md border border-warn bg-warn-bg px-3 py-2">
                <Text className="text-xs text-warn">
                  Your last request was denied. You can request again below.
                </Text>
              </View>
            ) : null}
            <TextField
              label="Note (optional)"
              hint="Why you need a card — helps the finance manager decide."
              value={requestNote}
              onChangeText={setRequestNote}
              placeholder="e.g. New hire, needs supplies budget"
            />
            <Button
              title="Request a card"
              icon="send"
              onPress={handleRequestCard}
              loading={requesting}
            />
          </View>
        )}
        <SectionHeader title="How cards work" />
        <CardPhilosophy />
        <ToastView toast={toast} onDismiss={dismiss} />
      </View>
    );
  }

  const status = cardStatusBadge(card.status, card.frozenByHolder);
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

              {/* Self-serve freeze — suspected foul play, instant + reversible
                  only by this holder. A card locked for another reason
                  (manager lock / receipt auto-lock) has no self-serve button
                  here — the banners above already explain why it's locked. */}
              {card.status === "active" ? (
                <Button
                  title="Freeze card"
                  variant="secondary"
                  icon="shield-off"
                  loading={freezing}
                  onPress={() => handleFreeze(card.id)}
                />
              ) : card.status === "locked" && card.frozenByHolder ? (
                <Button
                  title="Unfreeze card"
                  variant="secondary"
                  icon="shield"
                  loading={freezing}
                  onPress={() => handleUnfreeze(card.id)}
                />
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

      {/* Shared "You owe Public Worship" banner — see `OwedBanner`'s doc
          comment. The member starts the repayment by their own card or bank;
          a manager confirms the money landed (posts the offsetting credit) —
          nothing clears here. */}
      <View className="mt-4">
        <OwedBanner />
      </View>

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
            const rep = repByTxn.get(t.id);
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
                      onPress={() => handleInitiate(rep.id, t.id)}
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
