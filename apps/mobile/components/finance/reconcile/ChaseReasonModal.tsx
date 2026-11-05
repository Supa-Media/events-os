/**
 * ChaseReasonModal — say WHY before a chase goes out.
 *
 * Founder, 2026-11-05: "I also need options to explain why I'm chasing them."
 * Every Chase button on the Book opens this first. The manager ticks any of the
 * preset reasons and can add a note; both go into the email and text
 * (`cards.sendCodingChase`'s `reasons` / `note`). Neither is required: a plain
 * reminder is still a reminder.
 */
import { useState } from "react";
import { Modal, Pressable, ScrollView, Text, View } from "react-native";
import {
  CHASE_NOTE_MAX_LENGTH,
  CHASE_REASONS,
  CHASE_REASON_LABELS,
  CHASE_REASON_SENTENCES,
  type ChaseReason,
} from "@events-os/shared";
import { Button, CheckboxRow, Icon, TextField } from "../../ui";
import { colors } from "../../../lib/theme";

export function ChaseReasonModal({
  title,
  onSend,
  onCancel,
}: {
  /** What is being chased, e.g. "Chase Ada" or "Chase everyone". */
  title: string;
  onSend: (why: { reasons: ChaseReason[]; note: string }) => void;
  onCancel: () => void;
}) {
  const [reasons, setReasons] = useState<ChaseReason[]>([]);
  const [note, setNote] = useState("");

  const toggle = (r: ChaseReason) =>
    setReasons((cur) =>
      cur.includes(r) ? cur.filter((x) => x !== r) : [...cur, r],
    );

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onCancel}>
      <Pressable
        onPress={onCancel}
        className="flex-1 items-center justify-center bg-ink/30 p-6"
      >
        <Pressable
          onPress={() => {}}
          className="w-full max-w-lg overflow-hidden rounded-xl border border-border bg-raised shadow-pop"
        >
          <View className="flex-row items-center justify-between border-b border-border px-5 py-4">
            <Text className="font-display text-lg text-ink">{title}</Text>
            <Pressable onPress={onCancel} hitSlop={8} className="rounded-md p-1">
              <Icon name="x" size={18} color={colors.muted} />
            </Pressable>
          </View>

          <ScrollView className="max-h-[440px]">
            <View className="px-5 py-4">
              <Text className="mb-3 text-xs text-muted">
                They&apos;ll get an email (and a text if their phone is on
                file) asking them to finish their charges. Say why, so they know
                what would settle it.
              </Text>

              <Text className="mb-2 text-2xs font-semibold uppercase tracking-wide text-muted">
                Why are you chasing?
              </Text>
              {CHASE_REASONS.map((r) => (
                <View key={r} className="mb-2">
                  <CheckboxRow
                    checked={reasons.includes(r)}
                    onPress={() => toggle(r)}
                    label={CHASE_REASON_LABELS[r]}
                    className="mb-0"
                  />
                  <Text className="ml-7 text-2xs text-muted">
                    {CHASE_REASON_SENTENCES[r]}
                  </Text>
                </View>
              ))}

              <Text className="mb-2 mt-3 text-2xs font-semibold uppercase tracking-wide text-muted">
                Add a note (optional)
              </Text>
              <TextField
                value={note}
                onChangeText={(t) => setNote(t.slice(0, CHASE_NOTE_MAX_LENGTH))}
                placeholder="e.g. The Uber on Sep 5 needs who rode and why."
                multiline
                numberOfLines={3}
              />
            </View>
          </ScrollView>

          <View className="flex-row justify-end gap-2 border-t border-border px-5 py-4">
            <Button title="Cancel" variant="secondary" onPress={onCancel} />
            <Button
              title="Send reminder"
              icon="send"
              onPress={() => onSend({ reasons, note: note.trim() })}
            />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
