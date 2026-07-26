/**
 * ExcludeReasonModal — the client-side prompt for the server-enforced rule in
 * `finances.ts#setTransactionStatus`: setting `status:"excluded"` now REQUIRES
 * a non-blank `reason` (throws `ConvexError({code:"REASON_REQUIRED"})`
 * otherwise). Excluding a charge drops it out of `isSpend` and therefore every
 * budget/category/actuals total — the founder-flagged gap the whole
 * `financeAuditLog` trail exists to close (see that table's own schema doc
 * comment). Shared by both places a caller can flip a transaction to
 * "Excluded": `TransactionDetailModal`'s Status `SelectCell` and the Reconcile
 * grid's own Status column (`ReconcileList`).
 */
import { useState } from "react";
import { Modal, Pressable, Text, View } from "react-native";
import { Button, Icon, TextField } from "../../ui";
import { colors } from "../../../lib/theme";

export function ExcludeReasonModal({
  onConfirm,
  onCancel,
  submitting,
}: {
  onConfirm: (reason: string) => void;
  onCancel: () => void;
  /** Optional — shows the confirm button's loading state while the caller's
   *  own `setTransactionStatus` call is in flight. */
  submitting?: boolean;
}) {
  const [reason, setReason] = useState("");
  const trimmed = reason.trim();

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
            <Text className="font-display text-lg text-ink">Exclude transaction</Text>
            <Pressable onPress={onCancel} hitSlop={8} className="rounded-md p-1">
              <Icon name="x" size={18} color={colors.muted} />
            </Pressable>
          </View>

          <View className="px-5 py-4">
            <Text className="mb-3 text-xs text-muted">
              Excluding drops this charge out of every budget, category, and
              actuals total. A reason is required so the trail explains why,
              years from now.
            </Text>
            <TextField
              value={reason}
              onChangeText={setReason}
              placeholder="e.g. Duplicate charge, refunded by the vendor"
              multiline
              numberOfLines={3}
              autoFocus
            />
          </View>

          <View className="flex-row justify-end gap-2 border-t border-border px-5 py-4">
            <Button title="Cancel" variant="secondary" onPress={onCancel} />
            <Button
              title="Exclude"
              onPress={() => onConfirm(trimmed)}
              disabled={!trimmed}
              loading={submitting}
            />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
