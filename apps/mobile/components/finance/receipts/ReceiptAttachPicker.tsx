/**
 * ATTACH AN EXISTING RECEIPT — the sub-picker `ReceiptViewerModal`'s "Attach
 * existing" button opens. Lists the chapter's UNLINKED receipts
 * (`api.receipts.listReceipts({filter:"unlinked"})` — the bookkeeper's real
 * worklist, per that query's own doc comment) as a tap-to-link list; tapping
 * a row calls `api.receipts.linkReceipt` and closes on success. Same hand-
 * rolled modal shape as its parent (nested — RN supports stacked `Modal`s).
 */
import { useState } from "react";
import { ActivityIndicator, Image, Modal, Pressable, ScrollView, Text, View } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { formatCents } from "@events-os/shared";
import { Icon, ToastView } from "../../ui";
import { colors } from "../../../lib/theme";
import { useActionRunner } from "../../../lib/useActionToast";
import { shortDate } from "../reconcile/helpers";

export function ReceiptAttachPicker({
  transactionId,
  onClose,
}: {
  transactionId: Id<"transactions">;
  onClose: () => void;
}) {
  const unlinked = useQuery(api.receipts.listReceipts, { filter: "unlinked" });
  const linkReceipt = useMutation(api.receipts.linkReceipt);
  const { run, toast, dismiss } = useActionRunner();
  const [linkingId, setLinkingId] = useState<Id<"receipts"> | null>(null);

  async function handlePick(receiptId: Id<"receipts">) {
    setLinkingId(receiptId);
    const res = await run(() => linkReceipt({ receiptId, transactionId }), {
      errorTitle: "Couldn't attach receipt",
    });
    if (res !== undefined) {
      onClose();
    } else {
      setLinkingId(null);
    }
  }

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable onPress={onClose} className="flex-1 items-center justify-center bg-ink/30 p-6">
        <Pressable
          onPress={() => {}}
          className="w-full max-w-md overflow-hidden rounded-xl border border-border bg-raised shadow-pop"
        >
          <View className="flex-row items-center justify-between border-b border-border px-5 py-4">
            <Text className="font-display text-lg text-ink">Attach an existing receipt</Text>
            <Pressable onPress={onClose} hitSlop={8} className="rounded-md p-1">
              <Icon name="x" size={18} color={colors.muted} />
            </Pressable>
          </View>

          <ScrollView className="max-h-[420px] px-5 py-4">
            {unlinked === undefined ? (
              <Text className="py-6 text-center text-sm text-muted">Loading…</Text>
            ) : unlinked.length === 0 ? (
              <Text className="py-6 text-center text-sm text-muted">
                No unattached receipts in your library.
              </Text>
            ) : (
              <View className="gap-2">
                {unlinked.map((r) => (
                  <Pressable
                    key={r._id}
                    onPress={() => void handlePick(r._id)}
                    disabled={linkingId != null}
                    className="flex-row items-center gap-3 rounded-md border border-border bg-sunken px-3 py-2 active:opacity-70 web:hover:opacity-90"
                  >
                    <Thumb url={r.url} />
                    <View className="flex-1">
                      <Text className="text-sm font-semibold text-ink" numberOfLines={1}>
                        {r.merchant ?? "Unknown merchant"}
                      </Text>
                      <Text className="text-xs text-muted" numberOfLines={1}>
                        {[
                          r.amountCents != null ? formatCents(r.amountCents) : "No amount read",
                          r.receiptDate != null ? shortDate(r.receiptDate) : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </Text>
                    </View>
                    {linkingId === r._id ? (
                      <ActivityIndicator size="small" color={colors.accent} />
                    ) : (
                      <Icon name="chevron-right" size={16} color={colors.faint} />
                    )}
                  </Pressable>
                ))}
              </View>
            )}

            {toast ? (
              <View className="mt-4">
                <ToastView toast={toast} onDismiss={dismiss} />
              </View>
            ) : null}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

/** Small 48px thumbnail — same fail-to-icon fallback idea as the viewer's own
 *  `ReceiptPreview`, sized for a list row rather than a full preview. */
function Thumb({ url }: { url: string | null }) {
  const [failed, setFailed] = useState(false);
  return (
    <View className="h-12 w-12 items-center justify-center overflow-hidden rounded-md border border-border bg-raised">
      {url && !failed ? (
        <Image
          source={{ uri: url }}
          style={{ width: "100%", height: "100%" }}
          resizeMode="cover"
          onError={() => setFailed(true)}
        />
      ) : (
        <Icon name="file" size={16} color={colors.faint} />
      )}
    </View>
  );
}
