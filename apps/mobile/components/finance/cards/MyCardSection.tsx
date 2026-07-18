/**
 * MyCardSection — the caller's OWN card visual, shared by `MemberCardsView`
 * (member perspective) AND `ManagerCardsView` (owner report item 1: managers
 * are cardholders too, and previously had no card visual anywhere). Real data
 * from `api.cards.myCard`: the red virtual-card art, the status/spend summary
 * with the receipt-due warning, self-serve freeze/unfreeze, the HOLDER-ONLY
 * "Show card details / Add to wallet" reveal, the billing-address block, and
 * the two hard controls shown READ-ONLY (only a finance manager can change
 * someone's cap/validity — including their OWN, via the Cardholders table,
 * never from here).
 *
 * CONTEXT-INDEPENDENT BY DESIGN: `api.cards.myCard` resolves off the caller's
 * OWN `people` rows, never off the currently-selected `ChapterContext` desk
 * (Central / a specific chapter / peek) — see `myCard`'s doc comment in
 * `cards.ts`. This component takes no `chapterId`/scope prop for that reason;
 * it always shows the SAME card regardless of where the caller is "sitting."
 *
 * NO EMPTY SHELL: renders `null` when the caller holds no card anywhere
 * (neither Increase nor Relay) — `MemberCardsView` has its own full
 * request-a-card flow for that case; `ManagerCardsView` has no equivalent
 * (a manager without a card yet issues their own via "Issue card"), so
 * nothing is the correct empty state there. A holder with ONLY a legacy
 * (Relay) card gets the existing quiet note instead of the visual block —
 * a Relay card has no Increase object behind it, so none of the art/reveal/
 * billing-address/freeze machinery applies.
 */
import { useEffect, useState } from "react";
import { Alert, Text, View } from "react-native";
import { useAction, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { formatCents } from "@events-os/shared";
import {
  Badge,
  Button,
  Card,
  CopyButton,
  SectionHeader,
  ToastView,
} from "../../ui";
import { useActionRunner } from "../../../lib/useActionToast";
import { VirtualCardArt } from "./VirtualCardArt";
import {
  RevealCardDetailsModal,
  type RevealedCardDetails,
} from "./RevealCardDetailsModal";
import {
  cardStatusBadge,
  cardTypeLabel,
  expLabel,
  maskedNumber,
  shortDate,
  toFriendlyRevealError,
} from "./helpers";

/** `null` = no address / unavailable (never fetched, or the vendor call
 *  degraded); `undefined` = still loading. */
type BillingAddress = {
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  zip: string;
};

export function MyCardSection({ heading }: { heading?: string } = {}) {
  const myCard = useQuery(api.cards.myCard, {});
  const cards = myCard?.cards;
  // Self-serve freeze/unfreeze — instant, reversible ONLY by this same holder
  // (distinct from a manager's lock / the receipt auto-lock).
  const freezeCard = useAction(api.cards.freezeCard);
  const unfreezeCard = useAction(api.cards.unfreezeCard);
  // HOLDER-ONLY, rate-limited (see `cards.ts`) — the manual add-to-wallet
  // reveal. The response lives ONLY in this component's state; nothing is
  // ever written back to Convex.
  const revealCardDetails = useAction(api.cards.revealCardDetails);
  // HOLDER-ONLY, NOT rate-limited (decorative — see `cards.ts`'s doc comment).
  const fetchBillingAddress = useAction(api.cards.cardBillingAddress);
  const { run, toast, dismiss } = useActionRunner();

  const [freezing, setFreezing] = useState(false);
  const [revealing, setRevealing] = useState(false);
  const [revealed, setRevealed] = useState<RevealedCardDetails | null>(null);
  const [address, setAddress] = useState<BillingAddress | null | undefined>(
    undefined,
  );

  // Prefer an Increase-linked card for the visual/reveal/billing-address block
  // — a Relay (`source:"legacy"`) row has no Increase object behind it. A
  // holder can hold both (mid-migration) or only one.
  const increaseCards = (cards ?? []).filter((c) => c.source !== "legacy");
  const onlyLegacyCard =
    increaseCards.length === 0 &&
    (cards ?? []).some((c) => c.source === "legacy");
  const card = increaseCards[0];

  // Fetch the billing address once per Increase card — decorative info, not
  // gated behind the "Show card details" reveal. Degrades to `null` (no
  // block rendered) on any vendor/config failure; see `cardBillingAddress`'s
  // doc comment for why this never throws.
  useEffect(() => {
    if (!card) {
      setAddress(undefined);
      return;
    }
    let cancelled = false;
    setAddress(undefined);
    fetchBillingAddress({ cardId: card.id })
      .then((a) => {
        if (!cancelled) setAddress(a);
      })
      .catch(() => {
        if (!cancelled) setAddress(null);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-fetch only when the card itself changes
  }, [card?.id]);

  async function handleFreeze(cardId: Id<"cards">) {
    setFreezing(true);
    await run(() => freezeCard({ cardId }), {
      errorTitle: "Couldn't freeze card",
    });
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

  async function handleRevealDetails(cardId: Id<"cards">) {
    setRevealing(true);
    // Rewrite a RATE_LIMITED throw into a precise "try again in Xs/Xm"
    // message before it reaches `run`'s toast — every other failure
    // (FORBIDDEN, NOT_CONFIGURED, ILLEGAL_STATE, network) passes through as-is.
    const result = await run(
      () =>
        revealCardDetails({ cardId }).catch((err) => {
          throw toFriendlyRevealError(err);
        }),
      { errorTitle: "Couldn't show card details" },
    );
    if (result) setRevealed(result);
    setRevealing(false);
  }

  if (myCard === undefined) return null;

  // No card anywhere (neither Increase nor Relay) — no empty shell. Callers
  // that need a "request a card" / "no card yet" flow for this case (the
  // member view) implement it themselves before ever reaching this section.
  if (!card && !onlyLegacyCard) return null;

  if (!card) {
    // Only a legacy Relay card — quiet note, no art/reveal/billing-address.
    return (
      <View>
        {heading ? <SectionHeader title={heading} /> : null}
        <View className="mb-4 rounded-md border border-border bg-sunken px-3 py-2">
          <Text className="text-xs text-muted">
            Your card is a legacy Relay card — ask a finance manager if you have
            questions about it.
          </Text>
        </View>
      </View>
    );
  }

  const capLabel =
    card.monthlyCapCents != null ? formatCents(card.monthlyCapCents) : "No cap";
  const validityLabel =
    card.validFrom != null || card.validUntil != null
      ? `${card.validFrom != null ? shortDate(card.validFrom) : "Now"} – ${
          card.validUntil != null ? shortDate(card.validUntil) : "Open"
        }`
      : "No limit";
  const status = cardStatusBadge(card.status, card.frozenByHolder);
  const receiptOverdue =
    card.status === "locked" ||
    (card.receiptGraceEndsAt != null && card.receiptGraceEndsAt <= Date.now());

  return (
    <View>
      {heading ? <SectionHeader title={heading} /> : null}
      <View className="mb-4 flex-row flex-wrap gap-4">
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
                <Badge
                  label={status.label}
                  tone={status.tone}
                  icon={status.icon}
                />
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
              {card.receiptGraceEndsAt != null || card.status === "locked" ? (
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
                      : `Add a receipt by ${
                          card.receiptGraceEndsAt != null
                            ? shortDate(card.receiptGraceEndsAt)
                            : "soon"
                        } to avoid an auto-lock.`}
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

              {/* Manual add-to-wallet — HOLDER-ONLY + rate-limited server-side
                (see `cards.ts`'s `revealCardDetails`). Only offered while
                the card is usable; native push provisioning ("Add to Apple
                Wallet" one-tap) is explicitly deferred. */}
              {card.status === "active" ? (
                <Button
                  title="Show card details / Add to wallet"
                  variant="ghost"
                  icon="credit-card"
                  loading={revealing}
                  onPress={() => handleRevealDetails(card.id)}
                />
              ) : null}

              {/* Billing address — the shared org Entity's registered address
                at Increase (decorative, not gated behind the reveal). Shown
                only once fetched; silently omitted when unavailable (a
                degraded card, unconfigured environment, or a failed vendor
                call — see `cardBillingAddress`'s doc comment). */}
              {address ? (
                <View className="gap-1">
                  <Text className="text-xs font-semibold uppercase tracking-wider text-muted">
                    Billing address
                  </Text>
                  <View className="flex-row items-start justify-between gap-2">
                    <Text className="flex-1 text-sm text-ink">
                      {address.line1}
                      {address.line2 ? `, ${address.line2}` : ""}
                      {"\n"}
                      {address.city}, {address.state} {address.zip}
                    </Text>
                    <CopyButton
                      text={`${address.line1}${
                        address.line2 ? `, ${address.line2}` : ""
                      }, ${address.city}, ${address.state} ${address.zip}`}
                    />
                  </View>
                </View>
              ) : null}

              <View className="h-px bg-border" />

              {/* The two hard controls — read-only for the cardholder, even a
                manager viewing their OWN card here (changing them is a
                Cardholders-table action, not a My-card action). */}
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

      <RevealCardDetailsModal
        details={revealed}
        onClose={() => setRevealed(null)}
      />
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
      <Text
        className="text-sm text-ink"
        style={{ fontVariant: ["tabular-nums"] }}
      >
        {value}
      </Text>
    </View>
  );
}
