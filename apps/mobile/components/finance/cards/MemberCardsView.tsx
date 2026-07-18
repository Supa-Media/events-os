/**
 * Member perspective of the Cards tab — the caller's OWN card. The red
 * virtual-card art, status/spend summary, receipt-due warning, self-serve
 * freeze/unfreeze, reveal, and billing address (the two hard controls shown
 * READ-ONLY — a member can't change their own cap/validity, that's a manager
 * action) live in the shared `MyCardSection`. This file adds what's specific
 * to the member perspective: the "no card yet" request flow, the shared
 * "You owe" banner (`OwedBanner`), and the ability to flag one of their
 * charges (from `api.finances.personTransactions`) as a personal expense and
 * pay it back.
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
 *
 * CARD VISUAL (owner report item 1): the red virtual-card art, reveal modal,
 * and billing address live in the shared `MyCardSection` — used here AND at
 * the top of `ManagerCardsView` (a manager is a cardholder too). This file
 * keeps only what's specific to the member perspective: the "no card yet"
 * request flow (`lastCanceled`/`myRequest`), the shared "You owe" banner, and
 * the per-charge flag/pay-back list.
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
  EmptyState,
  SectionHeader,
  TextField,
  ToastView,
} from "../../ui";
import { useActionRunner } from "../../../lib/useActionToast";
import { CardPhilosophy } from "./CardPhilosophy";
import { OwedBanner } from "./OwedBanner";
import { MyCardSection } from "./MyCardSection";
import { shortDate, type MyRepayment } from "./helpers";

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
  const requestCard = useMutation(api.cards.requestCard);
  const { run, toast, dismiss } = useActionRunner();

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

  // Only used for the top-level "no card at all" branch below — the visual
  // card block itself (art/reveal/billing-address/quiet-note) lives entirely
  // in `MyCardSection`, which resolves the same `increaseCards`/`onlyLegacyCard`
  // split off its OWN `myCard` query.
  const increaseCards = useMemo(
    () => (cards ?? []).filter((c) => c.source !== "legacy"),
    [cards],
  );
  const onlyLegacyCard =
    increaseCards.length === 0 && (cards ?? []).some((c) => c.source === "legacy");
  const card = increaseCards[0];

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

  // Truly no card at all (neither Increase nor Relay) — the existing
  // request-a-card flow. A holder with ONLY a Relay card falls through
  // instead: they DO have a card, so the request flow doesn't apply — see
  // the `onlyLegacyCard` branch further down.
  if (!card && !onlyLegacyCard) {
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

      {/* Card art + summary (art/reveal/billing-address/quiet-note) — shared
          with the top of `ManagerCardsView` (owner report item 1). */}
      <MyCardSection />

      {/* Shared "You owe Public Worship" banner — see `OwedBanner`'s doc
          comment. The member starts the repayment by their own card or bank;
          a manager confirms the money landed (posts the offsetting credit) —
          nothing clears here. `MyCardSection` already carries its own
          bottom margin, so no extra `mt` here. */}
      <OwedBanner />

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
