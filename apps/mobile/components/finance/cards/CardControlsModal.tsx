/**
 * CardControlsModal — a finance manager edits the ONLY two hard controls on a
 * card: the monthly safety cap and the validity window. Nothing else about a
 * card is settable (off-pattern spend is caught in reconciliation, not by the
 * card). Backed by `api.cards.setCardControls`; `null` clears a control. Failures
 * surface via the action runner.
 */
import { useState } from "react";
import { Modal, Pressable, ScrollView, Text, View } from "react-native";
import { useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import {
  Button,
  DateTimeField,
  Field,
  Icon,
  TextField,
  ToastView,
} from "../../ui";
import { colors } from "../../../lib/theme";
import { useActionRunner } from "../../../lib/useActionToast";
import type { CardSummary } from "./helpers";

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

export function CardControlsModal({
  card,
  onClose,
}: {
  card: CardSummary;
  onClose: () => void;
}) {
  const setControls = useMutation(api.cards.setCardControls);
  const { run, toast, dismiss } = useActionRunner();

  const [cap, setCap] = useState(
    card.monthlyCapCents != null ? (card.monthlyCapCents / 100).toString() : "",
  );
  const [limitValidity, setLimitValidity] = useState(
    card.validFrom != null || card.validUntil != null,
  );
  const [validFrom, setValidFrom] = useState(card.validFrom ?? Date.now());
  const [validUntil, setValidUntil] = useState(
    card.validUntil ?? Date.now() + YEAR_MS,
  );
  const [saving, setSaving] = useState(false);

  async function submit() {
    let monthlyCapCents: number | null = null;
    if (cap.trim()) {
      const dollars = parseFloat(cap);
      if (!Number.isFinite(dollars) || dollars < 0) {
        run(() => Promise.reject(new Error("Enter a valid monthly cap.")), {
          errorTitle: "Invalid cap",
        });
        return;
      }
      monthlyCapCents = Math.round(dollars * 100);
    }
    if (limitValidity && validUntil <= validFrom) {
      run(() => Promise.reject(new Error("Valid-until must be after valid-from.")), {
        errorTitle: "Invalid validity window",
      });
      return;
    }

    setSaving(true);
    // Send explicit nulls so clearing a field actually removes the control.
    const res = await run(
      () =>
        setControls({
          cardId: card.id as Id<"cards">,
          monthlyCapCents,
          validFrom: limitValidity ? validFrom : null,
          validUntil: limitValidity ? validUntil : null,
        }),
      { errorTitle: "Couldn't update controls" },
    );
    setSaving(false);
    if (res !== undefined) onClose();
  }

  return (
    <>
      <Modal visible transparent animationType="fade" onRequestClose={onClose}>
        <Pressable
          onPress={onClose}
          className="flex-1 items-center justify-center bg-ink/30 p-6"
        >
          <Pressable
            onPress={() => {}}
            className="w-full max-w-lg overflow-hidden rounded-xl border border-border bg-raised shadow-pop"
          >
            <View className="flex-row items-center justify-between border-b border-border px-5 py-4">
              <View>
                <Text className="font-display text-lg text-ink">Card controls</Text>
                {card.cardholderName ? (
                  <Text className="text-xs text-muted">{card.cardholderName}</Text>
                ) : null}
              </View>
              <Pressable onPress={onClose} hitSlop={8} className="rounded-md p-1">
                <Icon name="x" size={18} color={colors.muted} />
              </Pressable>
            </View>

            <ScrollView className="max-h-[520px] px-5 py-4">
              <TextField
                label="Monthly cap"
                value={cap}
                onChangeText={setCap}
                keyboardType="decimal-pad"
                placeholder="No cap"
                hint="A monthly safety ceiling. Leave blank to remove the cap."
              />

              <Pressable
                onPress={() => setLimitValidity((v) => !v)}
                className="mb-3 flex-row items-center gap-2"
              >
                <View
                  className={`h-5 w-5 items-center justify-center rounded border ${
                    limitValidity
                      ? "border-accent bg-accent"
                      : "border-border-strong bg-raised"
                  }`}
                >
                  {limitValidity ? (
                    <Icon name="check" size={13} color="#FFFFFF" />
                  ) : null}
                </View>
                <Text className="text-sm font-semibold text-ink">
                  Limit when this card can be used
                </Text>
              </Pressable>

              {limitValidity ? (
                <View className="flex-row gap-3">
                  <View className="flex-1">
                    <Field label="Valid from">
                      <DateTimeField value={validFrom} onChange={setValidFrom} />
                    </Field>
                  </View>
                  <View className="flex-1">
                    <Field label="Valid until">
                      <DateTimeField value={validUntil} onChange={setValidUntil} />
                    </Field>
                  </View>
                </View>
              ) : null}
            </ScrollView>

            <View className="flex-row justify-end gap-2 border-t border-border px-5 py-4">
              <Button title="Cancel" variant="secondary" onPress={onClose} />
              <Button title="Save controls" onPress={submit} loading={saving} />
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      <ToastView toast={toast} onDismiss={dismiss} />
    </>
  );
}
