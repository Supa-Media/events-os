/**
 * MoveBookModal — the confirm step for `finances.reassignTransactions`.
 *
 * This action was labelled "Reassign to" and committed on the tap. Both were
 * wrong for what it actually does, and became actively dangerous once
 * cross-book attribution shipped: the grid now has TWO controls that both look
 * like "make this charge belong to another book", and they do opposite things.
 *
 *   - The "For" picker charges a transaction to another book's BUDGET. Custody
 *     is untouched — the money really did leave the paying account — and the
 *     difference becomes a receivable that `transfers.interScopeBalances` nets
 *     into a settlement. This is the everyday case: a Public Worship card
 *     bought something for New York.
 *
 *   - THIS action rewrites custody itself (`transactions.chapterId`). It says
 *     the paying account was recorded wrong. It is a DATA CORRECTION, not an
 *     accounting decision, and using it for the everyday case above quietly
 *     does real damage: the paying book stops matching its own bank statement,
 *     and the receivable vanishes because there is no longer a gap to settle.
 *
 * So the modal's job isn't to confirm a click — it's to make the reader notice
 * they may want the other control. It names what gets rewritten, names the
 * links that get dropped (the server clears category/fund, and a team that
 * doesn't survive the move), and points at the "For" column by name for the
 * case it's usually being reached for by mistake.
 *
 * Mirrors `MarkTransferModal` / `MarkPayoutModal`'s confirm-before-commit
 * shape — the established pattern here for an action that moves a row in or
 * out of somebody's totals.
 */
import { Modal, Pressable, Text, View } from "react-native";
import { Button, Icon } from "../../ui";
import { colors } from "../../../lib/theme";

export function MoveBookModal({
  count,
  targetName,
  onConfirm,
  onCancel,
  submitting,
}: {
  /** How many selected rows will move. */
  count: number;
  /** The destination book's display name ("Central", "New York"). */
  targetName: string;
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
              Move to {targetName}&apos;s books?
            </Text>
            <Pressable onPress={onCancel} hitSlop={8} className="rounded-md p-1">
              <Icon name="x" size={18} color={colors.muted} />
            </Pressable>
          </View>

          <View className="gap-3 px-5 py-4">
            <Text className="text-xs text-muted">
              This rewrites <Text className="font-semibold text-ink">who paid</Text> —
              it records that {targetName}&apos;s account was the one the money left.
              Use it only to correct a charge that landed in the wrong book, not to
              decide whose budget should carry the cost.
            </Text>

            <View className="gap-1.5 rounded-lg border border-warn-soft bg-warn-bg px-3 py-2.5">
              <View className="flex-row items-center gap-1.5">
                <Icon name="alert-triangle" size={13} color={colors.warn} />
                <Text className="text-[11px] font-semibold uppercase tracking-wide text-warn">
                  Wanted the other one?
                </Text>
              </View>
              <Text className="text-xs text-muted">
                If {targetName} is simply absorbing the cost of something another
                account paid for, close this and set the{" "}
                <Text className="font-semibold text-ink">For</Text> column to one of{" "}
                {targetName}&apos;s budgets instead. That keeps who paid accurate and
                books what&apos;s owed between the two.
              </Text>
            </View>

            <Text className="text-xs text-muted">
              Coding that doesn&apos;t survive the move is cleared — category and fund
              always, and the team unless it belongs to {targetName}. The move is
              recorded in the finance audit trail.
            </Text>
          </View>

          <View className="flex-row justify-end gap-2 border-t border-border px-5 py-4">
            <Button title="Cancel" variant="secondary" onPress={onCancel} />
            <Button
              title={count > 1 ? `Move ${count} charges` : "Move charge"}
              onPress={onConfirm}
              loading={submitting}
            />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
