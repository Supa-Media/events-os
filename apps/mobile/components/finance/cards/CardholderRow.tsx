/**
 * One CONDENSED row of the manager cardholders table (WP owner report item 2):
 * avatar + name · last4, this-month spend over the card's monthly cap, the
 * lifecycle status chip, and a ⋯
 * menu with the manager actions (lock / unlock / edit controls). Pure
 * presentation — the mutations live in the parent so a single toast surfaces
 * every failure.
 *
 * Increase cards ONLY — the parent (`ManagerCardsView`) filters out
 * `source:"legacy"` (Relay) rows before this ever renders, so every card here
 * has real Increase-issued controls (caps/validity/lock). A receipt overdue/
 * due-soon isn't a separate table column anymore (condensed); it's folded
 * into the name subtitle as a small inline flag instead.
 */
import { Alert, Pressable, Text, View } from "react-native";
import { formatCents } from "@events-os/shared";
import {
  Avatar,
  Badge,
  Cell,
  ContextMenu,
  Icon,
  Row,
  useAnchor,
  type ContextMenuAction,
} from "../../ui";
import { colors } from "../../../lib/theme";
import {
  cardStatusBadge,
  cardTypeLabel,
  receiptStatus,
  type CardSummary,
} from "./helpers";

export function CardholderRow({
  card,
  last,
  onLock,
  onUnlock,
  onEditControls,
  onCancel,
}: {
  card: CardSummary;
  last: boolean;
  onLock: () => void;
  onUnlock: () => void;
  onEditControls: () => void;
  onCancel: () => void;
}) {
  const { ref, anchor, visible, open, close } = useAnchor();
  const status = cardStatusBadge(card.status, card.frozenByHolder);
  const receipts = receiptStatus(card);
  const receiptDue = receipts.tone === "warn";
  const isCanceled = card.status === "canceled";

  // A card the HOLDER froze themselves (suspected foul play) — a manager's
  // unlock is the superset power that can still lift it (server behavior
  // unchanged), but silently clearing someone else's foul-play freeze is
  // surprising. Confirm before doing it; every other unlock reason (a plain
  // manager lock, the receipt auto-lock) unlocks immediately as before.
  function handleUnlockPress() {
    if (card.frozenByHolder) {
      Alert.alert(
        "Unlock this card?",
        "This card was frozen by its holder (suspected foul play). Unlock anyway?",
        [
          { text: "Cancel", style: "cancel" },
          { text: "Unlock", style: "destructive", onPress: onUnlock },
        ],
      );
    } else {
      onUnlock();
    }
  }

  const actions: ContextMenuAction[] = isCanceled
    ? []
    : [
        { label: "Edit controls…", icon: "sliders", onPress: onEditControls },
        ...(card.status === "locked"
          ? [
              {
                label: "Unlock card",
                icon: "unlock" as const,
                onPress: handleUnlockPress,
              },
            ]
          : card.status === "active"
            ? [
                {
                  label: "Lock card",
                  icon: "lock" as const,
                  onPress: onLock,
                  destructive: true,
                },
              ]
            : []),
        // FM/Treasurer-only server-side (`requireFinanceManager`) — same
        // convention as Lock/Unlock above: always shown here, the backend
        // gate is what actually enforces it.
        {
          label: "Cancel card…",
          icon: "x-circle",
          onPress: onCancel,
          destructive: true,
        },
      ];

  return (
    <Row last={last}>
      <Cell flex={2.2}>
        <View className="flex-row items-center gap-2.5">
          <Avatar name={card.cardholderName ?? "?"} size={28} />
          <View className="flex-1">
            <Text className="text-sm font-semibold text-ink" numberOfLines={1}>
              {card.cardholderName ?? "Unknown"}
            </Text>
            <View className="flex-row items-center gap-1">
              <Text className="text-xs text-faint" numberOfLines={1}>
                {cardTypeLabel(card.type)} ···{card.last4 ?? "••••"}
              </Text>
              {receiptDue ? (
                <Icon name="flag" size={10} color={colors.warn} />
              ) : null}
            </View>
          </View>
        </View>
      </Cell>

      <Cell width={96} align="right">
        <Text className="text-sm text-ink" style={{ fontVariant: ["tabular-nums"] }}>
          {formatCents(card.spentThisMonthCents)}
        </Text>
        {/* The card's monthly cap at a glance (edited via "Edit controls…"). */}
        <Text
          className="text-xs text-faint"
          style={{ fontVariant: ["tabular-nums"] }}
        >
          {card.monthlyCapCents != null
            ? `of ${formatCents(card.monthlyCapCents)}`
            : "no cap"}
        </Text>
      </Cell>

      <Cell width={132} align="right">
        <View className="flex-row items-center justify-end gap-1.5">
          <Badge label={status.label} tone={status.tone} icon={status.icon} />
          {actions.length > 0 ? (
            <Pressable
              ref={ref}
              onPress={open}
              hitSlop={6}
              className="rounded-md p-1 active:bg-sunken web:hover:bg-sunken"
            >
              <Icon name="more-horizontal" size={16} color={colors.muted} />
            </Pressable>
          ) : null}
        </View>
      </Cell>

      {actions.length > 0 ? (
        <ContextMenu
          anchor={visible ? anchor : undefined}
          actions={actions}
          onClose={close}
        />
      ) : null}
    </Row>
  );
}
