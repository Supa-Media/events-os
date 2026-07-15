/**
 * IssueCardModal — a finance manager issues a person-owned card on the chapter's
 * Increase account. Pick the cardholder (via the shared {@link PersonPicker}),
 * the card type, an optional monthly safety cap (dollars → integer cents), and an
 * optional validity window. Backed by the `api.cards.issueCard` action, which
 * degrades to a dev card row when Increase isn't wired up. Failures surface via
 * the action runner.
 */
import { useMemo, useState } from "react";
import { Modal, Pressable, ScrollView, Text, View } from "react-native";
import { useAction, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import type { CardType } from "@events-os/shared";
import {
  Avatar,
  Button,
  DateTimeField,
  Field,
  Icon,
  PersonPicker,
  Select,
  TextField,
  ToastView,
} from "../../ui";
import { colors } from "../../../lib/theme";
import { useActionRunner } from "../../../lib/useActionToast";

const TYPE_OPTIONS = [
  { value: "virtual", label: "Virtual" },
  { value: "physical", label: "Physical" },
];

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

export function IssueCardModal({ onClose }: { onClose: () => void }) {
  const issue = useAction(api.cards.issueCard);
  // Cards are restricted to Public Worship staff — only card-eligible people.
  const people = useQuery(api.people.cardEligible, {});
  const { run, toast, dismiss } = useActionRunner();

  const [pickerOpen, setPickerOpen] = useState(false);
  const [personId, setPersonId] = useState<string | null>(null);
  const [type, setType] = useState<CardType>("virtual");
  const [cap, setCap] = useState("");
  const [limitValidity, setLimitValidity] = useState(false);
  const [validFrom, setValidFrom] = useState(Date.now());
  const [validUntil, setValidUntil] = useState(Date.now() + YEAR_MS);
  const [saving, setSaving] = useState(false);

  // Resolve the picked id → display name (the picker only returns the id).
  const personName = useMemo(
    () => (people ?? []).find((p: any) => p._id === personId)?.name ?? null,
    [people, personId],
  );

  async function submit() {
    if (!personId) {
      run(() => Promise.reject(new Error("Pick a cardholder first.")), {
        errorTitle: "Choose a person",
      });
      return;
    }
    let monthlyCapCents: number | undefined;
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
    const res = await run(
      () =>
        issue({
          cardholderPersonId: personId as Id<"people">,
          type,
          ...(monthlyCapCents != null ? { monthlyCapCents } : {}),
          ...(limitValidity ? { validFrom, validUntil } : {}),
        }),
      { errorTitle: "Couldn't issue card" },
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
              <Text className="font-display text-lg text-ink">Issue a card</Text>
              <Pressable onPress={onClose} hitSlop={8} className="rounded-md p-1">
                <Icon name="x" size={18} color={colors.muted} />
              </Pressable>
            </View>

            <ScrollView className="max-h-[520px] px-5 py-4">
              {/* Cardholder — a person, not a budget. */}
              <Field
                label="Cardholder"
                hint="Cards are person-owned, and only for people with a @publicworship.life email — the holder keeps their own receipts."
              >
                <Pressable
                  onPress={() => setPickerOpen(true)}
                  className="flex-row items-center justify-between rounded-md border border-border-strong bg-raised px-3 py-2.5"
                >
                  {personName ? (
                    <View className="flex-row items-center gap-2">
                      <Avatar name={personName} size={24} />
                      <Text className="text-base text-ink">{personName}</Text>
                    </View>
                  ) : (
                    <Text className="text-base text-faint">Choose a person…</Text>
                  )}
                  <Icon name="chevron-down" size={16} color={colors.muted} />
                </Pressable>
              </Field>

              <Select
                label="Card type"
                value={type}
                options={TYPE_OPTIONS}
                onChange={(v) => setType(v as CardType)}
              />

              <TextField
                label="Monthly cap (optional)"
                value={cap}
                onChangeText={setCap}
                keyboardType="decimal-pad"
                placeholder="No cap"
                hint="A monthly safety ceiling. Leave blank for no cap."
              />

              {/* Validity window — optional; off by default (open-ended). */}
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
              <Button title="Issue card" onPress={submit} loading={saving} />
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      <PersonPicker
        visible={pickerOpen}
        title="Choose a cardholder"
        source="cardEligible"
        selectedId={personId}
        onPick={(id) => {
          setPersonId(id);
          setPickerOpen(false);
        }}
        onClose={() => setPickerOpen(false)}
      />

      <ToastView toast={toast} onDismiss={dismiss} />
    </>
  );
}
