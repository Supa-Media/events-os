/**
 * One event-reservation row: the reserved asset's name + category, an inline
 * quantity edit (parsed to a positive integer; invalid rejected via a toast), an
 * optional note, a chapter-wide "Overbooked" warning when the shared gear is
 * oversubscribed across events, and a remove button.
 */
import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import { Badge, Icon, OptionTag } from "../../ui";
import { colors } from "../../../lib/theme";
import type { ActionRunner } from "../../../lib/useActionToast";
import { confirmAction } from "../ticketing/helpers";
import { type EventReservation } from "./helpers";

/** Parse a positive integer (≥1) from a string, or null if invalid. */
function parsePosInt(input: string): number | null {
  const n = Number(input.trim());
  if (!Number.isInteger(n) || n < 1) return null;
  return n;
}

type Props = {
  reservation: EventReservation;
  run: ActionRunner["run"];
};

export function GearRow({ reservation, run }: Props) {
  const updateReservation = useMutation(api.inventory.updateReservation);
  const removeReservation = useMutation(api.inventory.removeReservation);
  const asset = reservation.asset;

  const [qtyInput, setQtyInput] = useState<string | null>(null);
  const qtyValue = qtyInput !== null ? qtyInput : String(reservation.quantity);

  async function saveQty() {
    const parsed = parsePosInt(qtyValue);
    if (parsed === null) {
      await run(
        () => Promise.reject(new Error("Enter a whole number of at least 1.")),
        { errorTitle: "Couldn't save quantity" },
      );
      setQtyInput(null);
      return;
    }
    if (parsed !== reservation.quantity) {
      await run(
        () =>
          updateReservation({
            reservationId: reservation._id,
            quantity: parsed,
          }),
        { errorTitle: "Couldn't save quantity" },
      );
    }
    setQtyInput(null);
  }

  function handleRemove() {
    confirmAction({
      title: "Remove reservation?",
      message: `This event's claim on "${asset?.name ?? "this asset"}" will be released.`,
      confirmLabel: "Remove",
      onConfirm: () =>
        void run(
          () => removeReservation({ reservationId: reservation._id }),
          { errorTitle: "Couldn't remove reservation" },
        ),
      destructive: true,
    });
  }

  return (
    <View className="flex-row items-center gap-3 border-t border-border py-3">
      <View className="flex-1">
        <Text className="text-base font-semibold text-ink" numberOfLines={1}>
          {asset?.name ?? "Unknown asset"}
        </Text>
        <View className="mt-1 flex-row flex-wrap items-center gap-2">
          {asset?.tags.map((tag) => (
            <OptionTag key={tag} label={tag} />
          ))}
          {asset ? (
            <Text className="text-sm text-muted">
              {asset.available} of {asset.quantity} free
            </Text>
          ) : null}
          {asset?.overbooked ? (
            <Badge label="Overbooked" tone="danger" icon="alert-triangle" />
          ) : null}
        </View>
        {reservation.note ? (
          <Text className="mt-1 text-sm text-muted" numberOfLines={2}>
            {reservation.note}
          </Text>
        ) : null}
      </View>

      {/* Inline quantity edit */}
      <View className="w-16">
        <Text className="mb-1 text-2xs font-bold uppercase tracking-wider text-muted">
          Qty
        </Text>
        <View className="flex-row items-center rounded-md border border-border-strong bg-raised px-2">
          <TextInput
            value={qtyValue}
            onChangeText={setQtyInput}
            onBlur={() => void saveQty()}
            onSubmitEditing={() => void saveQty()}
            placeholder="1"
            placeholderTextColor={colors.faint}
            keyboardType="number-pad"
            className="flex-1 py-2 text-base text-ink"
          />
        </View>
      </View>

      <Pressable
        onPress={handleRemove}
        hitSlop={6}
        accessibilityLabel={`Remove ${asset?.name ?? "reservation"}`}
        className="active:opacity-70"
      >
        <Icon name="x" size={15} color={colors.muted} />
      </Pressable>
    </View>
  );
}
