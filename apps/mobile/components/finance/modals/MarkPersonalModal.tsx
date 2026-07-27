/**
 * MarkPersonalModal — the confirm-first prompt for `cards.flagPersonalCharge`
 * / `cards.unflagPersonalCharge`. Mirrors `ExcludeReasonModal`'s pattern
 * (confirm before committing, never fire on a stray click) rather than the
 * old Reconcile-row behavior of flagging on the first tap: marking personal
 * schedules a real email to a real person (the payer), so a mis-tap shouldn't
 * silently notify someone their charge was flagged.
 *
 * No free-text reason field (unlike Exclude) — there's nothing for a human to
 * explain here; the confirm step exists purely to prevent an accidental
 * send, not to collect a justification.
 */
import { Modal, Pressable, Text, View } from "react-native";
import { Button, Icon } from "../../ui";
import { colors } from "../../../lib/theme";

export function MarkPersonalModal({
  mode,
  onConfirm,
  onCancel,
  submitting,
}: {
  /** "mark" flags a charge personal (schedules the payer's repayment email);
   *  "unmark" undoes a mis-flag (no email, no confirmation copy needed beyond
   *  "are you sure"). */
  mode: "mark" | "unmark";
  onConfirm: () => void;
  onCancel: () => void;
  submitting?: boolean;
}) {
  const isMark = mode === "mark";
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onCancel}>
      <Pressable
        onPress={onCancel}
        className="flex-1 items-center justify-center bg-ink/30 p-6"
      >
        <Pressable
          onPress={() => {}}
          className="w-full max-w-md overflow-hidden rounded-xl border border-border bg-raised shadow-pop"
        >
          <View className="flex-row items-center justify-between border-b border-border px-5 py-4">
            <Text className="font-display text-lg text-ink">
              {isMark ? "Mark as personal" : "Un-mark personal"}
            </Text>
            <Pressable onPress={onCancel} hitSlop={8} className="rounded-md p-1">
              <Icon name="x" size={18} color={colors.muted} />
            </Pressable>
          </View>

          <View className="px-5 py-4">
            <Text className="text-xs text-muted">
              {isMark
                ? "This drops the charge out of budget/category spend and emails the cardholder a link to pay it back — from your card, our bank, or another provider. This can be undone before it's repaid."
                : "This clears the personal flag and cancels the outstanding repayment. Only possible before the cardholder has paid it back."}
            </Text>
          </View>

          <View className="flex-row justify-end gap-2 border-t border-border px-5 py-4">
            <Button title="Cancel" variant="secondary" onPress={onCancel} />
            <Button
              title={isMark ? "Mark personal" : "Un-mark"}
              onPress={onConfirm}
              loading={submitting}
            />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
