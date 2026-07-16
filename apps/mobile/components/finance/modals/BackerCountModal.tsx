/**
 * BackerCountModal — WP-4.3's manual backer-count edit.
 *
 * Backer count feeds the affordability header (`api.finances.chapterAffordability`)
 * and is the chapter's own manual entry until the Giving page (F-6) exists to
 * report it directly (§0.1). Chapter finance-manager rank only (Chapter
 * Director/Treasurer) — `setBackerCount` re-checks this server-side regardless
 * of whether the affordance is shown, so this modal only opens when
 * `ChapterView` already knows `canEdit` is true.
 */
import { useState } from "react";
import { Modal, Pressable, Text, View } from "react-native";
import { useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import { Button, Icon, TextField } from "../../ui";
import { colors } from "../../../lib/theme";
import { alertError } from "../../../lib/errors";

export function BackerCountModal({
  currentCount,
  onClose,
}: {
  currentCount: number;
  onClose: () => void;
}) {
  const setBackerCount = useMutation(api.finances.setBackerCount);
  const [value, setValue] = useState(String(currentCount));
  const [saving, setSaving] = useState(false);

  async function submit() {
    const parsed = parseInt(value, 10);
    if (!Number.isInteger(parsed) || parsed < 0 || String(parsed) !== value.trim()) {
      alertError(new Error("Enter a whole, non-negative number of backers."));
      return;
    }
    setSaving(true);
    try {
      await setBackerCount({ backerCount: parsed });
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
          className="w-full max-w-sm overflow-hidden rounded-xl border border-border bg-raised shadow-pop"
        >
          <View className="flex-row items-center justify-between border-b border-border px-5 py-4">
            <Text className="font-display text-lg text-ink">Backer count</Text>
            <Pressable onPress={onClose} hitSlop={8} className="rounded-md p-1">
              <Icon name="x" size={18} color={colors.muted} />
            </Pressable>
          </View>

          <View className="px-5 py-4">
            <Text className="mb-3 text-xs text-muted">
              Manual for now — the Giving page will report this directly once
              it exists. Backer count drives the tier and monthly revenue on
              the affordability header.
            </Text>
            <TextField
              label="Backers"
              value={value}
              onChangeText={setValue}
              keyboardType="number-pad"
              placeholder="0"
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
