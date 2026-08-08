/**
 * MerchantHistoryModal — "what has this row been called, and who called it
 * that."
 *
 * Owner ask (finance owner, 2026-08-08): "once I edit it, there should be a
 * history icon next to it — I can click on it and see the history: it's
 * initially named this, then renamed to this by this person."
 *
 * It reads `finances.financeAuditTrail` — the SHARED finance audit table every
 * other field change on a transaction already writes to — and narrows it to
 * this row's `merchant_rename` entries. Deliberately not a bespoke history
 * store: one trail that every finance surface writes to is worth more than a
 * per-feature one, and the transaction detail modal's own History section is
 * already reading the same query.
 *
 * READ ORDER IS OLDEST-FIRST here, inverted from the query's newest-first, so
 * the panel reads as the sentence the owner asked for — it started as X, then
 * became Y, then Z. The first entry's `before` is the PROVIDER's own name (see
 * `finances.renameMerchant`), which is why the original always has a line of
 * its own at the top rather than being inferred.
 *
 * The trail is bookkeeper+ / scope gated server-side, so a caller below that
 * bar sees an empty list rather than an error — matching how the detail
 * modal's History section already behaves.
 */
import { useState } from "react";
import { Modal, Pressable, ScrollView, Text, View } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { Button, Icon } from "../../ui";
import { colors } from "../../../lib/theme";
import { alertError } from "../../../lib/errors";
import { shortDate } from "../reconcile/helpers";

export function MerchantHistoryModal({
  transactionId,
  /** The provider's own name for this row — what the bank/processor sent, or
   *  the engine wrote. Shown as the "what the statement says" anchor even
   *  while the trail is still loading. */
  providerName,
  /** The bookkeeper's current rename, or null when the provider's own name is
   *  what's showing. There has to BE a rename for un-naming to mean anything. */
  currentOverride,
  /** Whether this caller may un-name the row. False on a read-only row (a
   *  foreign book in the merged queue, or a peek), where the trail is still
   *  readable — reading is not writing — but the server would refuse the
   *  clear. Both conditions gate the button; neither is the real authority,
   *  which is `clearMerchantRename`'s own gate. */
  canClear,
  onClose,
}: {
  transactionId: Id<"transactions">;
  providerName: string;
  currentOverride: string | null;
  canClear: boolean;
  onClose: () => void;
}) {
  const trail = useQuery(api.finances.financeAuditTrail, {
    subjectType: "transaction",
    subjectId: transactionId,
  });
  const clearRename = useMutation(api.finances.clearMerchantRename);
  const [clearing, setClearing] = useState(false);

  // Newest-first from the server; this panel tells the story forwards.
  const renames = (trail ?? [])
    .filter((r) => r.action === "merchant_rename")
    .slice()
    .reverse();

  async function revertToProviderName() {
    setClearing(true);
    try {
      await clearRename({ transactionId });
      onClose();
    } catch (err) {
      alertError(err);
    } finally {
      setClearing(false);
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
            <Text className="font-display text-lg text-ink">Name history</Text>
            <Pressable onPress={onClose} hitSlop={8} className="rounded-md p-1">
              <Icon name="x" size={18} color={colors.muted} />
            </Pressable>
          </View>

          <ScrollView className="max-h-96 px-5 py-4">
            {/* The provider's value, always first and always present. Renaming
                never overwrote it, so this is the row as the statement has it
                — not a reconstruction from the trail. */}
            <View className="border-l-2 border-border pl-3">
              <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
                From the bank
              </Text>
              <Text className="text-sm text-ink">{providerName}</Text>
            </View>

            {trail === undefined ? (
              <Text className="mt-3 text-xs text-muted">Loading…</Text>
            ) : renames.length === 0 ? (
              <Text className="mt-3 text-xs text-muted">
                This row hasn&apos;t been renamed.
              </Text>
            ) : (
              <View className="mt-3 gap-3">
                {renames.map((r) => (
                  <View key={r.id} className="border-l-2 border-accent pl-3">
                    <Text className="text-sm text-ink">{r.after ?? "—"}</Text>
                    <Text className="text-2xs text-faint">
                      was &ldquo;{r.before ?? "—"}&rdquo;
                    </Text>
                    <Text className="text-2xs text-faint">
                      {r.actorName ?? "Unknown"} · {shortDate(r.createdAt)}
                    </Text>
                  </View>
                ))}
              </View>
            )}
          </ScrollView>

          <View className="flex-row justify-end gap-2 border-t border-border px-5 py-4">
            {canClear && currentOverride != null ? (
              <Button
                title="Use the original name"
                variant="secondary"
                loading={clearing}
                onPress={() => void revertToProviderName()}
              />
            ) : null}
            <Button title="Done" onPress={onClose} />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
