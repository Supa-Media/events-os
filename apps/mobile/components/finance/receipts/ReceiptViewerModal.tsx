/**
 * RECEIPT VIEWER — opened by tapping the "Attached" chip anywhere `ReceiptCell`
 * renders it (Reconcile grid, `TransactionDetailModal`, "My transactions").
 * Shows every receipt linked to ONE transaction (`api.receipts.listForTransaction`
 * — a txn can carry more than one, split-bill/shared-card cases), with:
 *
 *  - a preview that OPENS IN PLACE (`FileViewer`) — zoomable and pannable for
 *    a photo, paged for a multi-page PDF, and identical for both. It used to
 *    be an `<Image>` whose press called `Linking.openURL`, i.e. a new browser
 *    tab for every file including a plain photo, and a broken-image box first
 *    for anything that wasn't one. The row DOES carry a stored content type
 *    (`receipts.ts#receiptSummary`) — this file simply never read it; that
 *    stale claim is what the four rival PDF detectors were built around.
 *  - the CANONICAL amount/date/merchant, with an "OCR read" subtext line only
 *    when the immutable `ocr*` provenance actually disagrees with it (a human
 *    correction, or nothing to compare — never shown for agreement).
 *  - source/sender-class badges, a "Duplicate" flag (confirmed —
 *    `duplicateOfReceiptId` set), an "Archived" flag, and a "linked to N
 *    charges" note when the SAME receipt document backs more than one
 *    transaction.
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
import { useMemo, useState } from "react";
import { Alert, Modal, Platform, Pressable, ScrollView, Text, View } from "react-native";
import {
  useMutation,
  useQueries,
  type RequestForQueries,
} from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
// expo-image-picker is Expo Go-safe (classified `core`); only used on native.
import * as ImagePicker from "expo-image-picker";
import { formatCents, type ReceiptSenderClass, type ReceiptSource } from "@events-os/shared";
import { Badge, type BadgeTone, Button, FileThumbnail, FileViewer, Icon, ToastView } from "../../ui";
import { colors } from "../../../lib/theme";
import { useActionRunner } from "../../../lib/useActionToast";
import { shortDate } from "../reconcile/helpers";
import { ReceiptAttachPicker } from "./ReceiptAttachPicker";

const TABULAR = { fontVariant: ["tabular-nums" as const] };

/** One file the human picked, on the way to storage. `filename` is `null` only
 *  when there genuinely isn't one (a native camera-roll pick). */
type Picked = { blob: Blob; contentType: string; filename: string | null };

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
  // READ THROUGH `useQueries`, NEVER `useQuery`. `useQuery` THROWS a refusal
  // during render, which React treats as a failed component rather than a
  // failed read: it unwinds to the root `ErrorBoundary` and replaces the whole
  // page. That is not hypothetical here — it is this component's own bug
  // report (2026-08-31, a cardholder on `/code`: "it opens and then
  // immediately changes to this", with a full-page "Something went wrong").
  // The server side of that is fixed (`receipts.listForTransaction` now admits
  // the charge's own spender), but the SHAPE of the failure is the part worth
  // keeping fixed: this modal is opened from surfaces whose audience holds no
  // finance seat, so a future gate it cannot satisfy must cost it its own
  // contents and nothing more. Same idiom, same reason, as
  // `receiptSuggestions.ts`.
  const request = useMemo<RequestForQueries>(
    () => ({
      receipts: {
        query: api.receipts.listForTransaction,
        args: { transactionId },
      },
    }),
    [transactionId],
  );
  const results = useQueries(request);
  const raw = results.receipts;
  const refused = raw instanceof Error;
  const receipts = (Array.isArray(raw) ? raw : undefined) as
    | ReceiptRow[]
    | undefined;
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
  function pickWeb(onPicked: (picked: Picked) => void) {
    if (typeof document === "undefined") return;
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*,application/pdf";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      // ONE PICKED FILE = ONE RECEIPT — upload exactly what was picked. This
      // used to rasterize a scanned PDF client-side and then take
      // `expanded[0]`, which silently threw away pages 2..N of a multi-page
      // receipt. Rasterization is the server's job now (see `UploadZone`'s
      // module doc for the full reasoning).
      onPicked({
        blob: file as Blob,
        contentType: file.type || "application/octet-stream",
        filename: file.name || null,
      });
    };
    input.click();
  }

  async function pickNative(onPicked: (picked: Picked) => void) {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.9,
    });
    if (result.canceled || !result.assets?.length) return;
    const asset = result.assets[0];
    const resp = await fetch(asset.uri);
    const blob = await resp.blob();
    onPicked({
      blob,
      contentType: asset.mimeType || blob.type || "image/jpeg",
      filename: asset.fileName ?? null,
    });
  }

  function pickFile(onPicked: (picked: Picked) => void) {
    if (Platform.OS === "web") pickWeb(onPicked);
    else void pickNative(onPicked);
  }

  async function uploadReceipt({
    blob,
    contentType,
    filename,
  }: Picked): Promise<Id<"receipts"> | undefined> {
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
          // The picked file's real name. Both callers used to omit it, so this
          // always sent `[null]` — every receipt uploaded from this modal
          // landed nameless.
          filenames: [filename],
        });
        return outcome.receiptId;
      },
      { errorTitle: "Couldn't upload receipt" },
    );
  }

  function handleUploadNew() {
    pickFile(async (picked) => {
      setUploadingNew(true);
      const receiptId = await uploadReceipt(picked);
      if (receiptId) {
        await run(() => linkReceipt({ receiptId, transactionId }), {
          errorTitle: "Couldn't attach receipt",
        });
      }
      setUploadingNew(false);
    });
  }

  function handleReplace(oldReceiptId: Id<"receipts">) {
    pickFile(async (picked) => {
      setReplacingId(oldReceiptId);
      const newReceiptId = await uploadReceipt(picked);
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
            {refused ? (
              // The modal's own contents, and nothing else — the page behind
              // it survives. Said plainly rather than as an error code: from
              // here the useful next step is asking the person who keeps the
              // books, not retrying.
              <Text className="py-6 text-center text-sm text-muted">
                You don&apos;t have access to the receipt files on this
                charge. Ask a bookkeeper if you need to see them.
              </Text>
            ) : receipts === undefined ? (
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
      <ReceiptPreview url={r.url} contentType={r.contentType} filename={r.filename} />

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
          // BUG FIX: `duplicateOfReceiptId` set means CONFIRMED (derived
          // sha256 match OR a human's `markAsDuplicate`) — this used to read
          // "Possible duplicate", the SOFT-signal label, which is wrong here;
          // "possible" is `receipts.ts#computeSoftDuplicates`' output, a
          // different, weaker signal this row doesn't even carry.
          <Badge label="Duplicate" tone="danger" icon="copy" />
        ) : null}
        {r.archived ? <Badge label="Archived" tone="neutral" icon="archive" /> : null}
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

/**
 * The receipt's preview, and the thing a reviewer actually presses.
 *
 * This used to be an `<Image>` in a `Pressable` whose press called
 * `Linking.openURL` — a NEW BROWSER TAB, for every file, including a plain
 * photo. That is the "having to open up in another site" complaint, and it is
 * why reviewing a screen of charges meant a screen of orphaned tabs. It now
 * opens `FileViewer` in place: same modal stack, zoomable, and paged for a
 * multi-page PDF. `FileThumbnail` draws the preview itself (a PDF shows its
 * first page and, in doing so, pre-renders what the viewer will open).
 */
function ReceiptPreview({
  url,
  contentType,
  filename,
}: {
  url: string | null;
  contentType: string | null;
  filename: string | null;
}) {
  const [open, setOpen] = useState(false);

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

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={`View ${filename ?? "receipt"}`}
        className="w-full overflow-hidden rounded-md border border-border bg-sunken active:opacity-90"
        style={{ aspectRatio: 4 / 3 }}
      >
        <FileThumbnail
          uri={url}
          contentType={contentType}
          filename={filename}
          resizeMode="contain"
        />
        <View className="absolute bottom-1.5 right-1.5 rounded-md bg-ink/60 px-1.5 py-0.5">
          <Icon name="maximize-2" size={12} color={colors.raised} />
        </View>
      </Pressable>
      <FileViewer
        uri={url}
        visible={open}
        onClose={() => setOpen(false)}
        contentType={contentType}
        filename={filename}
        caption={filename ?? undefined}
      />
    </>
  );
}
