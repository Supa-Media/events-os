/**
 * RECEIPT VIEWER — opened by tapping the "Attached" chip anywhere `ReceiptCell`
 * renders it (Reconcile grid, `TransactionDetailModal`, "My transactions").
 * Shows every receipt linked to ONE transaction (`api.receipts.listForTransaction`
 * — a txn can carry more than one, split-bill/shared-card cases), with:
 *
 *  - an image preview (contain, fixed-aspect box) for an image file, falling
 *    back to a document icon + "Open" (`Linking.openURL`) the moment the
 *    `<Image>` itself fails to decode — the receipt row carries no stored
 *    content-type to branch on ahead of time (see `schema/finances.ts`'s
 *    `receipts` table), so "did this render as a photo" is the only signal
 *    available client-side. Mirrors `reimbursements/RequestCard.tsx`'s own
 *    `Linking.openURL(receiptUrl)` precedent for a non-previewable file.
 *  - the CANONICAL amount/date/merchant, with an "OCR read" subtext line only
 *    when the immutable `ocr*` provenance actually disagrees with it (a human
 *    correction, or nothing to compare — never shown for agreement).
 *  - source/sender-class badges, a "possible duplicate" flag, and a
 *    "linked to N charges" note when the SAME receipt document backs more
 *    than one transaction.
 *  - per-receipt Detach (confirm first, mirrors `CardholderRow`'s own
 *    destructive-confirm `Alert.alert` idiom) and Replace (upload a new file →
 *    `submitUploadedReceipts` → link the new one → detach the old one — a
 *    plain sequential handler, not a single backend call).
 *  - modal-level "Attach an existing receipt" (`ReceiptAttachPicker`) and
 *    "Upload a new receipt" — a transaction can always gain another link,
 *    even from an otherwise-empty state (every receipt just detached).
 *
 * `readOnly` (peek / below-bookkeeper role, mirrors `TransactionDetailModal`'s
 * own gate) hides every action below — viewing stays available, nothing here
 * ever renders a dead disabled button.
 */
import { useState } from "react";
import {
  Alert,
  Image,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
// expo-image-picker is Expo Go-safe (classified `core`); only used on native.
import * as ImagePicker from "expo-image-picker";
import { formatCents, type ReceiptSenderClass, type ReceiptSource } from "@events-os/shared";
import { Badge, type BadgeTone, Button, Icon, ToastView } from "../../ui";
import { colors } from "../../../lib/theme";
import { useActionRunner } from "../../../lib/useActionToast";
import { shortDate } from "../reconcile/helpers";
import { ReceiptAttachPicker } from "./ReceiptAttachPicker";
// Web-only pdfjs rasterization (native = passthrough stub): a scanned PDF is
// rendered to page images before upload so the server's image-OCR path reads it.
import { expandScannedPdfs } from "../../../lib/receiptPdfRasterize";

const TABULAR = { fontVariant: ["tabular-nums" as const] };

type ReceiptRow = FunctionReturnType<typeof api.receipts.listForTransaction>[number];

const SOURCE_LABEL: Record<ReceiptSource, string> = {
  email: "Email",
  upload: "Upload",
  sms: "Text",
};
const SOURCE_ICON: Record<ReceiptSource, "mail" | "upload" | "message-circle"> = {
  email: "mail",
  upload: "upload",
  sms: "message-circle",
};
const SENDER_CLASS_LABEL: Record<ReceiptSenderClass, string> = {
  team: "Team",
  roster: "Roster",
  internal: "Internal",
  external: "External",
};
const SENDER_CLASS_TONE: Record<ReceiptSenderClass, BadgeTone> = {
  team: "success",
  roster: "accent",
  internal: "info",
  external: "warn",
};

export function ReceiptViewerModal({
  transactionId,
  onClose,
  readOnly = false,
}: {
  transactionId: Id<"transactions">;
  onClose: () => void;
  /** Peek / below-bookkeeper role — see module doc. Hides every mutating
   *  action; the receipt list itself always renders. */
  readOnly?: boolean;
}) {
  const receipts = useQuery(api.receipts.listForTransaction, { transactionId });
  const unlinkReceipt = useMutation(api.receipts.unlinkReceipt);
  const linkReceipt = useMutation(api.receipts.linkReceipt);
  const submitUploadedReceipts = useMutation(api.receipts.submitUploadedReceipts);
  const generateUploadUrl = useMutation(api.storage.generateUploadUrl);
  const { run, toast, dismiss } = useActionRunner();

  const [detachingId, setDetachingId] = useState<Id<"receipts"> | null>(null);
  const [replacingId, setReplacingId] = useState<Id<"receipts"> | null>(null);
  const [uploadingNew, setUploadingNew] = useState(false);
  const [attachPickerOpen, setAttachPickerOpen] = useState(false);
  const busy = detachingId != null || replacingId != null || uploadingNew;

  // ── Upload plumbing — mirrors `CoverPhotoPicker`/`RequestForm`'s own
  // web-input / expo-image-picker split, then hands the resulting file to the
  // receipts pipeline (`submitUploadedReceipts`) rather than a bare attach —
  // a mass-upload-shaped receipt gets OCR'd/dup-checked like every other one. ──
  function pickWeb(onPicked: (blob: Blob, contentType: string) => void) {
    if (typeof document === "undefined") return;
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*,application/pdf";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      // A scanned PDF is rendered to page images first (a single receipt is
      // page 1); a digital PDF or an image passes through unchanged. This flow
      // attaches ONE receipt, so we take the first result.
      void expandScannedPdfs([
        { blob: file as Blob, contentType: file.type || "application/octet-stream", name: file.name },
      ]).then((expanded) => {
        const first = expanded[0];
        if (first) onPicked(first.blob, first.contentType);
      });
    };
    input.click();
  }

  async function pickNative(onPicked: (blob: Blob, contentType: string) => void) {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.9,
    });
    if (result.canceled || !result.assets?.length) return;
    const asset = result.assets[0];
    const resp = await fetch(asset.uri);
    const blob = await resp.blob();
    onPicked(blob, asset.mimeType || blob.type || "image/jpeg");
  }

  function pickFile(onPicked: (blob: Blob, contentType: string) => void) {
    if (Platform.OS === "web") pickWeb(onPicked);
    else void pickNative(onPicked);
  }

  async function uploadReceipt(
    blob: Blob,
    contentType: string,
    filename?: string,
  ): Promise<Id<"receipts"> | undefined> {
    return run(
      async () => {
        const uploadUrl = await generateUploadUrl();
        const res = await fetch(uploadUrl, {
          method: "POST",
          headers: { "Content-Type": contentType },
          body: blob,
        });
        const { storageId } = (await res.json()) as { storageId: Id<"_storage"> };
        const [outcome] = await submitUploadedReceipts({
          storageIds: [storageId],
          filenames: [filename ?? null],
        });
        return outcome.receiptId;
      },
      { errorTitle: "Couldn't upload receipt" },
    );
  }

  function handleUploadNew() {
    pickFile(async (blob, contentType) => {
      setUploadingNew(true);
      const receiptId = await uploadReceipt(blob, contentType);
      if (receiptId) {
        await run(() => linkReceipt({ receiptId, transactionId }), {
          errorTitle: "Couldn't attach receipt",
        });
      }
      setUploadingNew(false);
    });
  }

  function handleReplace(oldReceiptId: Id<"receipts">) {
    pickFile(async (blob, contentType) => {
      setReplacingId(oldReceiptId);
      const newReceiptId = await uploadReceipt(blob, contentType);
      if (newReceiptId) {
        const linked = await run(() => linkReceipt({ receiptId: newReceiptId, transactionId }), {
          errorTitle: "Couldn't attach the replacement",
        });
        if (linked !== undefined) {
          await run(() => unlinkReceipt({ receiptId: oldReceiptId, transactionId }), {
            errorTitle: "Attached the replacement, but couldn't detach the old receipt",
          });
        }
      }
      setReplacingId(null);
    });
  }

  function confirmDetach(receiptId: Id<"receipts">) {
    Alert.alert(
      "Detach this receipt?",
      "This removes it from this transaction — the receipt itself stays in the library and can be re-attached later.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Detach",
          style: "destructive",
          onPress: () => {
            setDetachingId(receiptId);
            void run(() => unlinkReceipt({ receiptId, transactionId }), {
              errorTitle: "Couldn't detach receipt",
            }).finally(() => setDetachingId(null));
          },
        },
      ],
    );
  }

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable onPress={onClose} className="flex-1 items-center justify-center bg-ink/30 p-6">
        <Pressable
          onPress={() => {}}
          className="w-full max-w-lg overflow-hidden rounded-xl border border-border bg-raised shadow-pop"
        >
          <View className="flex-row items-center justify-between border-b border-border px-5 py-4">
            <Text className="font-display text-lg text-ink">Receipts</Text>
            <Pressable onPress={onClose} hitSlop={8} className="rounded-md p-1">
              <Icon name="x" size={18} color={colors.muted} />
            </Pressable>
          </View>

          <ScrollView className="max-h-[520px] px-5 py-4">
            {receipts === undefined ? (
              <Text className="py-6 text-center text-sm text-muted">Loading…</Text>
            ) : receipts.length === 0 ? (
              <Text className="py-6 text-center text-sm text-muted">
                No receipts attached to this transaction.
              </Text>
            ) : (
              <View className="gap-4">
                {receipts.map((r, i) => (
                  <View key={r._id}>
                    <ReceiptDetail
                      receipt={r}
                      readOnly={readOnly}
                      busy={busy}
                      detaching={detachingId === r._id}
                      replacing={replacingId === r._id}
                      onDetach={() => confirmDetach(r._id)}
                      onReplace={() => handleReplace(r._id)}
                    />
                    {i < receipts.length - 1 ? (
                      <View className="mt-4 border-b border-border" />
                    ) : null}
                  </View>
                ))}
              </View>
            )}

            {toast ? (
              <View className="mt-4">
                <ToastView toast={toast} onDismiss={dismiss} />
              </View>
            ) : null}
          </ScrollView>

          {!readOnly ? (
            <View className="flex-row justify-end gap-2 border-t border-border px-5 py-4">
              <Button
                title="Attach existing"
                variant="secondary"
                size="sm"
                icon="link"
                disabled={busy}
                onPress={() => setAttachPickerOpen(true)}
              />
              <Button
                title="Upload new"
                size="sm"
                icon="upload"
                loading={uploadingNew}
                disabled={busy && !uploadingNew}
                onPress={handleUploadNew}
              />
            </View>
          ) : null}
        </Pressable>
      </Pressable>

      {attachPickerOpen ? (
        <ReceiptAttachPicker
          transactionId={transactionId}
          onClose={() => setAttachPickerOpen(false)}
        />
      ) : null}
    </Modal>
  );
}

/** One receipt's preview + fields + (non-readOnly) actions. */
function ReceiptDetail({
  receipt: r,
  readOnly,
  busy,
  detaching,
  replacing,
  onDetach,
  onReplace,
}: {
  receipt: ReceiptRow;
  readOnly: boolean;
  busy: boolean;
  detaching: boolean;
  replacing: boolean;
  onDetach: () => void;
  onReplace: () => void;
}) {
  const amtDiffers = r.ocrAmountCents != null && r.ocrAmountCents !== r.amountCents;
  const dateDiffers = r.ocrDate != null && r.ocrDate !== r.receiptDate;
  const merchDiffers =
    r.ocrMerchant != null &&
    (r.merchant ?? "").trim().toLowerCase() !== r.ocrMerchant.trim().toLowerCase();
  const ocrParts: string[] = [];
  if (amtDiffers) ocrParts.push(`amount ${formatCents(r.ocrAmountCents!)}`);
  if (dateDiffers) ocrParts.push(`date ${shortDate(r.ocrDate!)}`);
  if (merchDiffers) ocrParts.push(`merchant "${r.ocrMerchant}"`);

  return (
    <View className="gap-3">
      <ReceiptPreview url={r.url} />

      <View className="gap-1">
        <View className="flex-row items-start justify-between gap-2">
          <Text className="flex-1 text-sm font-semibold text-ink" numberOfLines={1}>
            {r.merchant ?? "Unknown merchant"}
          </Text>
          <Text className="text-sm font-semibold text-ink" style={TABULAR}>
            {r.amountCents != null ? formatCents(r.amountCents) : "—"}
          </Text>
        </View>
        <Text className="text-xs text-muted">
          {r.receiptDate != null ? shortDate(r.receiptDate) : "No date read"}
        </Text>
        {r.filename ? (
          <Text className="text-2xs text-faint" numberOfLines={1}>
            {r.filename}
          </Text>
        ) : null}
        {r.ocrError ? (
          <Text className="text-2xs text-danger">Extraction failed: {r.ocrError}</Text>
        ) : ocrParts.length > 0 ? (
          <Text className="text-2xs text-faint">OCR read: {ocrParts.join(" · ")}</Text>
        ) : null}
      </View>

      <View className="flex-row flex-wrap gap-1.5">
        <Badge label={SOURCE_LABEL[r.source]} tone="neutral" icon={SOURCE_ICON[r.source]} />
        {r.senderClass ? (
          <Badge label={SENDER_CLASS_LABEL[r.senderClass]} tone={SENDER_CLASS_TONE[r.senderClass]} />
        ) : null}
        {r.duplicateOfReceiptId ? (
          <Badge label="Possible duplicate" tone="warn" icon="alert-triangle" />
        ) : null}
        {r.linkCount > 1 ? <Badge label={`Linked to ${r.linkCount} charges`} tone="info" /> : null}
      </View>

      {!readOnly ? (
        <View className="flex-row justify-end gap-2">
          <Button
            title="Replace"
            size="sm"
            variant="secondary"
            icon="repeat"
            loading={replacing}
            disabled={busy && !replacing}
            onPress={onReplace}
          />
          <Button
            title="Detach"
            size="sm"
            variant="danger"
            icon="x-circle"
            loading={detaching}
            disabled={busy && !detaching}
            onPress={onDetach}
          />
        </View>
      ) : null}
    </View>
  );
}

/** Image preview, contain, fixed-aspect box — falls back to a document icon +
 *  "Open" the moment the `<Image>` itself fails to decode (no stored
 *  content-type to branch on ahead of time; see module doc). Tapping either
 *  state opens the file via `Linking.openURL` — there's no in-app lightbox
 *  (see mobile-recon notes), so "open" is the only way to see it full-size. */
function ReceiptPreview({ url }: { url: string | null }) {
  const [failed, setFailed] = useState(false);

  if (!url) {
    return (
      <View
        className="w-full items-center justify-center rounded-md border border-border bg-sunken"
        style={{ aspectRatio: 4 / 3 }}
      >
        <Icon name="file" size={22} color={colors.faint} />
        <Text className="mt-1 text-2xs text-faint">File unavailable</Text>
      </View>
    );
  }

  if (failed) {
    return (
      <Pressable
        onPress={() => void Linking.openURL(url)}
        className="w-full flex-row items-center justify-center gap-2 rounded-md border border-border bg-sunken active:opacity-80"
        style={{ aspectRatio: 4 / 3 }}
      >
        <Icon name="file-text" size={22} color={colors.muted} />
        <Text className="text-sm font-semibold text-accent">Open</Text>
      </Pressable>
    );
  }

  return (
    <Pressable
      onPress={() => void Linking.openURL(url)}
      className="w-full overflow-hidden rounded-md border border-border bg-sunken active:opacity-90"
      style={{ aspectRatio: 4 / 3 }}
    >
      <Image
        source={{ uri: url }}
        style={{ width: "100%", height: "100%" }}
        resizeMode="contain"
        onError={() => setFailed(true)}
      />
    </Pressable>
  );
}
