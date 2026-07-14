/**
 * One budget line row: label + category, its planned amount, an inline
 * dollar-edit for the ACTUAL spend (parseDollars → cents; invalid rejected via
 * a toast; empty clears it), the receipt attach thumbnail, and a remove button.
 */
import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import { Badge, Icon } from "../../ui";
import { colors } from "../../../lib/theme";
import type { ActionRunner } from "../../../lib/useActionToast";
import { confirmAction, formatMoney, parseDollars } from "../ticketing/helpers";
import { ReceiptButton } from "./ReceiptButton";
import { BUDGET_CATEGORY_LABELS, type BudgetLine } from "./helpers";

type Props = {
  line: BudgetLine;
  run: ActionRunner["run"];
};

export function BudgetLineRow({ line, run }: Props) {
  const updateLineItem = useMutation(api.budget.updateLineItem);
  const removeLineItem = useMutation(api.budget.removeLineItem);

  // Inline "actual" edit buffer — null while not editing (mirror the server).
  const [actualInput, setActualInput] = useState<string | null>(null);
  const actualValue =
    actualInput !== null
      ? actualInput
      : line.actualCents != null
        ? formatMoney(line.actualCents).replace("$", "")
        : "";

  async function saveActual() {
    const trimmed = actualValue.trim();
    // Empty → clear the actual.
    if (trimmed === "") {
      if (line.actualCents != null) {
        await run(
          () => updateLineItem({ lineItemId: line._id, actualCents: null }),
          { errorTitle: "Couldn't clear actual" },
        );
      }
      setActualInput(null);
      return;
    }
    const cents = parseDollars(trimmed);
    if (cents === null) {
      await run(
        () => Promise.reject(new Error("Enter a valid dollar amount.")),
        { errorTitle: "Couldn't save actual" },
      );
      setActualInput(null);
      return;
    }
    if (cents !== line.actualCents) {
      await run(
        () => updateLineItem({ lineItemId: line._id, actualCents: cents }),
        { errorTitle: "Couldn't save actual" },
      );
    }
    setActualInput(null);
  }

  function handleRemove() {
    confirmAction({
      title: "Remove line?",
      message: `"${line.label}" (${formatMoney(line.plannedCents)} planned) will be deleted.`,
      confirmLabel: "Remove",
      onConfirm: () =>
        void run(() => removeLineItem({ lineItemId: line._id }), {
          errorTitle: "Couldn't remove line",
        }),
      destructive: true,
    });
  }

  return (
    <View className="flex-row items-center gap-3 border-t border-border py-3">
      <ReceiptButton
        lineItemId={line._id}
        receiptUrl={line.receiptUrl}
        run={run}
      />

      <View className="flex-1">
        <Text className="text-base font-semibold text-ink" numberOfLines={1}>
          {line.label}
        </Text>
        <View className="mt-1 flex-row items-center gap-2">
          <Badge label={BUDGET_CATEGORY_LABELS[line.category]} tone="neutral" />
          <Text className="text-sm text-muted">
            {formatMoney(line.plannedCents)} planned
          </Text>
        </View>
        {line.note ? (
          <Text className="mt-1 text-sm text-muted" numberOfLines={1}>
            {line.note}
          </Text>
        ) : null}
      </View>

      {/* Inline ACTUAL dollar edit */}
      <View className="w-24">
        <Text className="mb-1 text-2xs font-bold uppercase tracking-wider text-muted">
          Actual
        </Text>
        <View className="flex-row items-center rounded-md border border-border-strong bg-raised px-2">
          <Text className="text-base text-faint">$</Text>
          <TextInput
            value={actualValue}
            onChangeText={setActualInput}
            onBlur={() => void saveActual()}
            onSubmitEditing={() => void saveActual()}
            placeholder="0"
            placeholderTextColor={colors.faint}
            keyboardType="numeric"
            className="flex-1 py-2 text-base text-ink"
          />
        </View>
      </View>

      <Pressable
        onPress={handleRemove}
        hitSlop={6}
        accessibilityLabel={`Remove ${line.label}`}
        className="active:opacity-70"
      >
        <Icon name="x" size={15} color={colors.muted} />
      </Pressable>
    </View>
  );
}
