/**
 * One row of the manager cardholders table: avatar + name, type + masked number,
 * the receipts status, this-month spend, the lifecycle badge, and a ⋯ menu with
 * the manager actions (lock / unlock / edit controls). Pure presentation — the
 * mutations live in the parent so a single toast surfaces every failure.
 */
import { Pressable, Text, View } from "react-native";
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
}: {
  card: CardSummary;
  last: boolean;
  onLock: () => void;
  onUnlock: () => void;
  onEditControls: () => void;
}) {
  const { ref, anchor, visible, open, close } = useAnchor();
  const status = cardStatusBadge(card.status);
  const receipts = receiptStatus(card);

  // Legacy (Relay) cards are external — Increase-only controls (caps/validity,
  // lock/unlock) don't apply, so they carry no ⋯ actions. Manage them from the
  // "Relay cards" section instead.
  const isLegacy = card.source === "legacy";

  const actions: ContextMenuAction[] = isLegacy
    ? []
    : [
        { label: "Edit controls…", icon: "sliders", onPress: onEditControls },
        ...(card.status === "locked"
          ? [{ label: "Unlock card", icon: "unlock" as const, onPress: onUnlock }]
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
