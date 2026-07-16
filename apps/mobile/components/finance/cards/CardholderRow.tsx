/**
 * One row of the manager cardholders table: avatar + name, type + masked number,
 * the receipts status, this-month spend, the lifecycle badge, and a ⋯ menu with
 * the manager actions (lock / unlock / edit controls). Pure presentation — the
 * mutations live in the parent so a single toast surfaces every failure.
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

  // Legacy (Relay) cards are external — Increase-only controls (caps/validity,
  // lock/unlock) don't apply, so they carry no ⋯ actions. Manage them from the
  // "Relay cards" section instead.
  const isLegacy = card.source === "legacy";
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

  const actions: ContextMenuAction[] =
    isLegacy || isCanceled
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
      <Cell flex={2}>
        <View className="flex-row items-center gap-2.5">
          <Avatar name={card.cardholderName ?? "?"} size={30} />
          <View className="flex-1">
            <View className="flex-row items-center gap-1.5">
              <Text className="text-sm font-semibold text-ink" numberOfLines={1}>
                {card.cardholderName ?? "Unknown"}
              </Text>
              {isLegacy ? <Badge label="Relay" tone="neutral" /> : null}
            </View>
            <Text className="text-xs text-faint" numberOfLines={1}>
              {cardTypeLabel(card.type)} ···{card.last4 ?? "••••"}
            </Text>
          </View>
        </View>
      </Cell>

      <Cell flex={1.6}>
        <Badge label={receipts.label} tone={receipts.tone} icon={receipts.icon} />
      </Cell>

      <Cell width={110} align="right">
        <Text
          className="text-sm text-ink"
          style={{ fontVariant: ["tabular-nums"] }}
        >
          {formatCents(card.spentThisMonthCents)}
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
