/**
 * TransactionNoteModal — R1a's freeform transaction note editor.
 *
 * Owner feedback: "budget and category is not enough — who was this for and
 * why? business/mission justification." `note` is a bookkeeper-authored field
 * on the transaction, distinct from `description` (provider-sourced — the bank
 * / card network's own merchant string, never author-edited). Same authz as
 * categorizing a row (`finances.setTransactionNote` mirrors
 * `categorizeTransaction`'s scope-aware bookkeeper gate).
 */
import { useState } from "react";
import { Modal, Pressable, Text, View } from "react-native";
import { useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { Button, Icon, TextField } from "../../ui";
import { colors } from "../../../lib/theme";
import { alertError } from "../../../lib/errors";

const MAX_NOTE_LENGTH = 2000;

export function TransactionNoteModal({
  transactionId,
  currentNote,
  onClose,
}: {
  transactionId: Id<"transactions">;
  currentNote: string | null;
  onClose: () => void;
}) {
  const setNote = useMutation(api.finances.setTransactionNote);
  const [value, setValue] = useState(currentNote ?? "");
  const [saving, setSaving] = useState(false);

  async function submit() {
    setSaving(true);
    try {
      await setNote({ transactionId, note: value.trim() ? value : null });
      onClose();
    } catch (err) {
      alertError(err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        onPress={onClose}
        className="flex-1 items-center justify-center bg-ink/30 p-6"
      >
        <Pressable
          onPress={() => {}}
          className="w-full max-w-md overflow-hidden rounded-xl border border-border bg-raised shadow-pop"
        >
          <View className="flex-row items-center justify-between border-b border-border px-5 py-4">
            <Text className="font-display text-lg text-ink">Note</Text>
            <Pressable onPress={onClose} hitSlop={8} className="rounded-md p-1">
              <Icon name="x" size={18} color={colors.muted} />
            </Pressable>
          </View>

          <View className="px-5 py-4">
            <Text className="mb-3 text-xs text-muted">
              Who was this for, and why? Budget and category say WHERE the
              money went — this is the business/mission justification.
            </Text>
            <TextField
              value={value}
              onChangeText={setValue}
              placeholder="e.g. Coffee with a prospective donor after service"
              multiline
              numberOfLines={4}
              maxLength={MAX_NOTE_LENGTH}
              autoFocus
            />
          </View>

          <View className="flex-row justify-end gap-2 border-t border-border px-5 py-4">
            <Button title="Cancel" variant="secondary" onPress={onClose} />
            <Button title="Save" onPress={submit} loading={saving} />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
