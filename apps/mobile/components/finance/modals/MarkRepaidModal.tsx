/**
 * MarkRepaidModal — the confirm-first prompt for `cards.markRepaymentPaid`,
 * the manager's "the money actually arrived" confirmation on a personal
 * charge. Mirrors `MarkPersonalModal`/`ExcludeReasonModal`: never fire real
 * settlement off a stray tap.
 *
 * The body spells out what settling DOES, because it was the founder's own
 * open question ("after I pay it off, what happens — does it mark it as paid
 * and clear it from the ledger?"): nothing is deleted. The charge stays on the
 * books, an offsetting credit is posted against it, and the pair nets to zero
 * in category/budget spend. Keep this copy in sync with
 * `cards.ts#settleRepayment` and the Academy's personal-charge lesson.
 */
import { Modal, Pressable, Text, View } from "react-native";
import { Button, Icon } from "../../ui";
import { colors } from "../../../lib/theme";

export function MarkRepaidModal({
  payerName,
  amount,
  onConfirm,
  onCancel,
  submitting,
}: {
  payerName: string;
  /** Pre-formatted dollar string (the caller already has `formatCents`). */
  amount: string;
  onConfirm: () => void;
  onCancel: () => void;
  submitting?: boolean;
}) {
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
              Mark repaid
            </Text>
            <Pressable onPress={onCancel} hitSlop={8} className="rounded-md p-1">
              <Icon name="x" size={18} color={colors.muted} />
            </Pressable>
          </View>

          <View className="gap-3 px-5 py-4">
            <Text className="text-sm text-ink">
              Confirm that {payerName} actually paid back {amount}.
            </Text>
            <Text className="text-xs text-muted">
              Nothing is deleted. The original charge stays on the ledger and
              keeps its receipt and coding — settling posts an offsetting
              credit against it, so the pair nets to zero in category and
              budget spend. The charge shows as “Repaid” in Reconcile and drops
              off the outstanding total.
            </Text>
            <Text className="text-xs text-muted">
              Only do this once the money is really in the chapter's account —
              it can't be undone from here.
            </Text>
          </View>

          <View className="flex-row justify-end gap-2 border-t border-border px-5 py-4">
            <Button title="Cancel" variant="secondary" onPress={onCancel} />
            <Button
              title="Mark repaid"
              onPress={onConfirm}
              loading={submitting}
            />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
