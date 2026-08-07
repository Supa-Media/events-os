/**
 * ReceiptExceptionDecideModal — deciding a filed receipt exception from the
 * reconcile grid.
 *
 * The grid could already FILE an exception ("No receipt") but not decide one: a
 * pending row rendered "Awaiting approval" as inert text, and the approve/reject
 * controls existed only inside `TransactionDetailModal`, reached from the dashboard
 * drill-down. That is the exact asymmetry `ReconcileList` already calls out for
 * filing — "it existed only in the dashboard drill-down's detail panel, which is not
 * where anyone reconciles". A bookkeeper working the receipt chase would see the row
 * blocked and have nowhere to click.
 *
 * This wraps the SAME `ReceiptExceptionSection` the detail modal uses, so approve,
 * reject, withdraw, the evidence gallery and the separation-of-duties rules all come
 * from one implementation rather than a second copy that can drift from it.
 */
import { Modal, Pressable, ScrollView, Text, View } from "react-native";
import { Icon } from "../../ui";
import { colors } from "../../../lib/theme";
import { ReceiptExceptionSection } from "../reconcile/ReceiptExceptionSection";
import type { Id } from "@events-os/convex/_generated/dataModel";

export function ReceiptExceptionDecideModal({
  transactionId,
  amountCents,
  readOnly,
  onClose,
  onError,
}: {
  transactionId: Id<"transactions">;
  amountCents: number;
  /** Peek / below-bookkeeper: the history stays readable, the actions don't render. */
  readOnly: boolean;
  onClose: () => void;
  onError: (err: unknown) => void;
}) {
  return (
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
            <Text className="font-display text-lg text-ink">
              {readOnly ? "Receipt exception" : "Decide receipt exception"}
            </Text>
            <Pressable
              onPress={onClose}
              hitSlop={8}
              className="rounded-md p-1"
              accessibilityLabel="Close"
            >
              <Icon name="x" size={18} color={colors.muted} />
            </Pressable>
          </View>
          {/* Scrolls because an exception can carry several pieces of evidence and a
              long note; the modal must not grow past the viewport on a phone. */}
          <ScrollView
            className="max-h-[70vh] px-5 py-4"
            contentContainerClassName="pb-2"
          >
            <ReceiptExceptionSection
              transactionId={transactionId}
              amountCents={amountCents}
              // The grid only offers this control on rows that have no receipt, so a
              // receipt arriving mid-decision is the section's own business to react to.
              hasReceipt={false}
              readOnly={readOnly}
              onError={onError}
            />
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
