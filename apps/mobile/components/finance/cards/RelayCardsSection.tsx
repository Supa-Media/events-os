/**
 * Relay cards — external (Relay) bank cards whose charges arrive via the Stripe
 * FC sync. Each distinct card last-4 seen on the chapter's synced transactions
 * is a candidate: link its last-4 to a cardholder (a `@publicworship.life`
 * person) so those charges become that person's responsibility, or unlink to
 * clear the attribution. Backed by `api.legacyCards.*`.
 *
 * Card issuance/lifecycle controls (caps, validity, lock) are Increase-only and
 * don't apply here — a Relay card is just a last-4 ↔ person binding.
 */
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { formatCents } from "@events-os/shared";
import {
  Avatar,
  Button,
  Cell,
  EmptyState,
  Icon,
  PersonPicker,
  Row,
  SectionHeader,
  Table,
  ToastView,
} from "../../ui";
import { colors } from "../../../lib/theme";
import { useActionRunner } from "../../../lib/useActionToast";

export function RelayCardsSection() {
  const candidates = useQuery(api.legacyCards.listRelayCardCandidates, {});
  const linkCard = useMutation(api.legacyCards.linkRelayCard);
  const unlinkCard = useMutation(api.legacyCards.unlinkRelayCard);
  const { run, toast, dismiss } = useActionRunner();

  // The last-4 currently having a cardholder picked (drives the PersonPicker).
  const [linkingLast4, setLinkingLast4] = useState<string | null>(null);

  const loading = candidates === undefined;

  const handleLink = (last4: string, personId: string) =>
    run(
      () => linkCard({ last4, personId: personId as Id<"people"> }),
      { errorTitle: "Couldn't link card" },
    );
  const handleUnlink = (cardId: string) =>
    run(() => unlinkCard({ cardId: cardId as Id<"cards"> }), {
      errorTitle: "Couldn't unlink card",
    });

  return (
    <View>
      <SectionHeader
        title="Relay cards"
        count={loading ? undefined : `${candidates.length}`}
      />
      <Text className="mb-3 text-sm text-muted">
        Link each external card's last-4 to its cardholder so their charges
        become their responsibility.
      </Text>

      {loading ? (
        <EmptyState title="Loading Relay cards…" />
      ) : candidates.length === 0 ? (
        <EmptyState
          icon="credit-card"
          title="No external cards seen"
          message="Relay card charges show up here once they sync in from the chapter's bank feed."
        />
      ) : (
        <Table>
          {candidates.map((c, i) => (
            <Row key={c.last4} last={i === candidates.length - 1}>
              <Cell flex={2}>
                <Text
                  className="text-sm font-semibold text-ink"
                  style={{ fontVariant: ["tabular-nums"] }}
                >
                  •••• {c.last4}
                </Text>
                <Text className="text-xs text-faint" numberOfLines={1}>
                  {c.txnCount} {c.txnCount === 1 ? "charge" : "charges"} ·{" "}
                  {formatCents(c.spentCents)}
                </Text>
              </Cell>

              <Cell flex={2} align="right">
                {c.linkedCard ? (
                  <View className="flex-row items-center gap-2">
                    <Avatar name={c.linkedCard.personName ?? "?"} size={26} />
                    <Text
                      className="text-sm font-semibold text-ink"
                      numberOfLines={1}
                    >
                      {c.linkedCard.personName ?? "Unknown"}
                    </Text>
                    <Pressable
                      onPress={() => handleUnlink(c.linkedCard!.cardId)}
                      hitSlop={6}
                      accessibilityLabel="Unlink card"
                      className="rounded-md p-1 active:bg-sunken web:hover:bg-sunken"
                    >
                      <Icon name="x" size={16} color={colors.muted} />
                    </Pressable>
                  </View>
                ) : (
                  <Button
                    title="Link to person"
                    icon="link-2"
                    size="sm"
                    variant="secondary"
                    onPress={() => setLinkingLast4(c.last4)}
                  />
                )}
              </Cell>
            </Row>
          ))}
        </Table>
      )}

      <PersonPicker
        visible={linkingLast4 !== null}
        title="Link card to person"
        source="cardEligible"
        onPick={(personId) => {
          const last4 = linkingLast4;
          setLinkingLast4(null);
          if (last4) void handleLink(last4, personId);
        }}
        onClose={() => setLinkingLast4(null)}
      />

      <ToastView toast={toast} onDismiss={dismiss} />
    </View>
  );
}
