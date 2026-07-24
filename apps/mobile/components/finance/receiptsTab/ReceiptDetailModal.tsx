/**
 * RECEIPTS TAB — Receipt detail panel (item 4 of the receipt CRM UI plan):
 * the full record for one `receipts` document, backed by
 * `api.receipts.getReceipt`. House modal shape (mirrors
 * `TransactionNoteModal`/`TransactionDetailModal`).
 *
 *  - Image preview, or — for a PDF (inferred from the filename extension;
 *    the backend never surfaces a content-type) — an INLINE preview on web
 *    (an `<iframe>`, same RN-web-renders-raw-HTML pattern as
 *    `crew/BriefingView.tsx`'s video embed) since there's no RN PDF
 *    renderer; native keeps the "Open file" (`Linking.openURL`) fallback.
 *    A non-PDF file that fails to decode as an image also falls back to
 *    "Open file".
 *  - Editable CANONICAL fields (amount/date/merchant/note) via
 *    `updateReceiptFields` — the immutable OCR read renders as read-only
 *    subtext underneath, never editable.
 *  - Linked transactions, each unlinkable (`unlinkReceipt`).
 *  - A match picker off `suggestMatches` — a plain Convex query that re-runs
 *    automatically whenever the canonical amount/date/merchant change (no
 *    manual refetch needed after a save).
 *  - A `duplicateOf` callout when flagged, tapping through to the original
 *    (re-keys this same modal via the parent's `onOpenReceipt`).
 *  - Possible-duplicate MATCHES (the soft signal) as tappable rows + a "Not a
 *    duplicate" dismiss (`dismissDuplicateFlag`).
 */
import { useEffect, useState } from "react";
import { Image, Linking, Modal, Platform, Pressable, ScrollView, Text, View } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { Badge, Button, Field, Icon, TextField } from "../../ui";
import { colors } from "../../../lib/theme";
import { formatDate } from "../../../lib/format";
import { confirmAction } from "../../event/ticketing/helpers";
import { Calendar } from "../../ui/Calendar";
import type { ActionRunner } from "../../../lib/useActionToast";
import {
  centsToDollarsInput,
  formatCents,
  parseDollarsToCents,
  senderClassLabel,
  senderClassTone,
} from "./helpers";

export function ReceiptDetailModal({
  receiptId,
  onClose,
  onOpenReceipt,
  run,
}: {
  receiptId: Id<"receipts">;
  onClose: () => void;
  onOpenReceipt: (receiptId: Id<"receipts">) => void;
  run: ActionRunner["run"];
}) {
  const receipt = useQuery(api.receipts.getReceipt, { receiptId });
  const candidates = useQuery(api.receipts.suggestMatches, { receiptId });
  // Resolves `correctedByPersonId` to a display name — the existing
  // chapter-roster read every mention/picker surface already uses, not a new
  // backend query.
  const people = useQuery(api.people.list, {});

  const updateFields = useMutation(api.receipts.updateReceiptFields);
  const linkReceipt = useMutation(api.receipts.linkReceipt);
  const unlinkReceipt = useMutation(api.receipts.unlinkReceipt);
  const retryExtraction = useMutation(api.receipts.retryExtraction);
  const dismissDuplicateFlag = useMutation(api.receipts.dismissDuplicateFlag);
  const markAsDuplicate = useMutation(api.receipts.markAsDuplicate);
  const unmarkDuplicate = useMutation(api.receipts.unmarkDuplicate);

  const [amountText, setAmountText] = useState("");
  const [date, setDate] = useState<number | null>(null);
  const [merchant, setMerchant] = useState("");
  const [note, setNote] = useState("");
  const [seededFor, setSeededFor] = useState<Id<"receipts"> | null>(null);
  const [saving, setSaving] = useState(false);
  const [imgFailed, setImgFailed] = useState(false);
  const [showCalendar, setShowCalendar] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [showModelInput, setShowModelInput] = useState(false);
  const [modelOverride, setModelOverride] = useState("");
  const [dismissingDuplicate, setDismissingDuplicate] = useState(false);
  const [markingDuplicateId, setMarkingDuplicateId] = useState<Id<"receipts"> | null>(null);
  const [unmarkingDuplicate, setUnmarkingDuplicate] = useState(false);

  // Seed local edit state once per receipt (never stomps an in-progress edit
  // on a background live-query refresh of the SAME receipt).
  useEffect(() => {
    if (receipt && seededFor !== receipt._id) {
      setAmountText(centsToDollarsInput(receipt.amountCents));
      setDate(receipt.receiptDate);
      setMerchant(receipt.merchant ?? "");
      setNote(receipt.note ?? "");
      setImgFailed(false);
      setSeededFor(receipt._id);
    }
  }, [receipt, seededFor]);

  const amountCents = amountText.trim() === "" ? null : parseDollarsToCents(amountText);
  const amountInvalid = amountText.trim() !== "" && amountCents == null;
  // No content-type from the backend — infer PDF from the filename extension
  // (fix 5: inline PDF preview).
  const isPdfReceipt = /\.pdf$/i.test(receipt?.filename ?? "");

  async function save() {
    if (amountInvalid) return;
    setSaving(true);
    await run(
      () =>
        updateFields({
          receiptId,
          amountCents,
          receiptDate: date,
          merchant: merchant.trim() ? merchant.trim() : null,
          note: note.trim() ? note.trim() : null,
        }),
      { errorTitle: "Couldn't save receipt" },
    );
    setSaving(false);
  }

  function handleUnlink(transactionId: Id<"transactions">, label: string) {
    confirmAction({
      title: "Unlink this receipt?",
      message: `It stays in the library, just no longer attached to ${label}.`,
      confirmLabel: "Unlink",
      destructive: true,
      onConfirm: () => {
        void run(() => unlinkReceipt({ receiptId, transactionId }), {
          errorTitle: "Couldn't unlink",
        });
      },
    });
  }

  function handleLink(transactionId: Id<"transactions">) {
    void run(() => linkReceipt({ receiptId, transactionId }), {
      errorTitle: "Couldn't link receipt",
    });
  }

  async function handleRetry() {
    setRetrying(true);
    await run(
      () =>
        retryExtraction({
          receiptId,
          model: modelOverride.trim() ? modelOverride.trim() : undefined,
        }),
      { errorTitle: "Couldn't retry extraction" },
    );
    setRetrying(false);
  }

  async function handleDismissDuplicate() {
    setDismissingDuplicate(true);
    await run(() => dismissDuplicateFlag({ receiptId }), {
      errorTitle: "Couldn't dismiss the duplicate flag",
    });
    setDismissingDuplicate(false);
  }

  function handleMarkAsDuplicate(primaryReceiptId: Id<"receipts">) {
    confirmAction({
      title: "Mark as duplicate?",
      message:
        "This receipt stays in the library — it just gets hidden from the default view and points at the other receipt as the original.",
      confirmLabel: "Mark as duplicate",
      destructive: false,
      onConfirm: () => {
        setMarkingDuplicateId(primaryReceiptId);
        void run(() => markAsDuplicate({ receiptId, primaryReceiptId }), {
          errorTitle: "Couldn't mark as duplicate",
        }).finally(() => setMarkingDuplicateId(null));
      },
    });
  }

  async function handleUnmarkDuplicate() {
    setUnmarkingDuplicate(true);
    await run(() => unmarkDuplicate({ receiptId }), {
      errorTitle: "Couldn't un-mark this duplicate",
    });
    setUnmarkingDuplicate(false);
  }

  const correctedByName = receipt?.correctedByPersonId
    ? (people?.find((p) => p._id === receipt.correctedByPersonId)?.name ?? "a bookkeeper")
    : null;

  const linkedIds = new Set((receipt?.linkedTransactions ?? []).map((t) => t.id));
  // Suggestions that aren't already linked — a linked txn belongs in the
  // "Linked" list above, not offered again as a candidate.
  const openCandidates = (candidates ?? []).filter((c) => !linkedIds.has(c.transactionId));

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable onPress={onClose} className="flex-1 items-center justify-center bg-ink/30 p-6">
        <Pressable
          onPress={() => {}}
          className="w-full max-w-lg overflow-hidden rounded-xl border border-border bg-raised shadow-pop"
        >
          <View className="flex-row items-center justify-between border-b border-border px-5 py-4">
            <Text className="font-display text-lg text-ink">Receipt</Text>
            <Pressable onPress={onClose} hitSlop={8} className="rounded-md p-1">
              <Icon name="x" size={18} color={colors.muted} />
            </Pressable>
          </View>

          <ScrollView className="max-h-[600px] px-5 py-4">
            {receipt === undefined ? (
              <Text className="py-8 text-center text-sm text-muted">Loading…</Text>
            ) : receipt === null ? (
              <Text className="py-8 text-center text-sm text-muted">
                Couldn't load this receipt.
              </Text>
            ) : (
              <>
                {/* File preview: a PDF (inferred from the filename — no
                    content-type from the backend) gets an INLINE preview on
                    web; native has no RN PDF renderer, so it keeps the "Open
                    file" fallback. A non-PDF renders as an image, falling
                    back to "Open file" if it fails to decode. */}
                <View
                  className={`mb-4 w-full items-center justify-center overflow-hidden rounded-lg border border-border bg-sunken ${
                    isPdfReceipt && Platform.OS === "web" ? "h-96" : "h-48"
                  }`}
                >
                  {receipt.url && isPdfReceipt && Platform.OS === "web" ? (
                    // RN-web renders this iframe directly in the DOM (same
                    // pattern as `crew/BriefingView.tsx`'s video embed).
                    <iframe
                      src={receipt.url}
                      title={receipt.filename ?? "Receipt PDF"}
                      style={{ width: "100%", height: "100%", border: "0" }}
                    />
                  ) : receipt.url && isPdfReceipt ? (
                    <Pressable
                      onPress={() => receipt.url && Linking.openURL(receipt.url)}
                      className="items-center gap-2 px-6 py-4"
                    >
                      <Icon name="file-text" size={24} color={colors.faint} />
                      <Text className="text-sm font-semibold text-accent">Open PDF</Text>
                    </Pressable>
                  ) : receipt.url && !imgFailed ? (
                    <Image
                      source={{ uri: receipt.url }}
                      style={{ width: "100%", height: "100%" }}
                      resizeMode="contain"
                      onError={() => setImgFailed(true)}
                    />
                  ) : (
                    <Pressable
                      onPress={() => receipt.url && Linking.openURL(receipt.url)}
                      disabled={!receipt.url}
                      className="items-center gap-2 px-6 py-4"
                    >
                      <Icon name="file-text" size={24} color={colors.faint} />
                      <Text className="text-sm font-semibold text-accent">
                        {receipt.url ? "Open file" : "No file"}
                      </Text>
                    </Pressable>
                  )}
                </View>

                <View className="mb-1 flex-row flex-wrap items-center gap-1.5">
                  <Badge label={senderClassLabel(receipt.senderClass)} tone={senderClassTone(receipt.senderClass)} />
                  <Badge label={receipt.source === "email" ? "Emailed" : "Uploaded"} tone="neutral" />
                  {receipt.softDuplicate && !receipt.duplicateOfReceiptId ? (
                    <Badge label="Possible duplicate" tone="warn" icon="alert-triangle" />
                  ) : null}
                </View>
                <Text className="mb-3 text-2xs text-faint" numberOfLines={1}>
                  {receipt.filename ?? "Unknown source"}
                </Text>

                {/* Duplicate-of callout — shown for BOTH a derived exact-file
                    match and a human-confirmed one (`markAsDuplicate`); only
                    the latter (`duplicateConfirmedByPersonId` set) offers
                    "Undo" — an exact-file match isn't a human call to walk
                    back (see `unmarkDuplicate`'s doc). Hiding this receipt
                    from the default library ≠ deleting it — it's still right
                    here, one tap from the original. */}
                {receipt.duplicateOf ? (
                  <View className="mb-4 gap-2 rounded-md border border-danger bg-danger-bg px-3 py-2.5">
                    <Pressable
                      onPress={() => onOpenReceipt(receipt.duplicateOf!._id)}
                      className="flex-row items-center gap-3 active:opacity-80"
                    >
                      <Icon name="copy" size={16} color={colors.danger} />
                      <View className="flex-1">
                        <Text className="text-xs font-semibold text-danger">
                          Duplicate of an earlier receipt →
                        </Text>
                        <Text className="text-xs text-danger">
                          {receipt.duplicateOf.merchant ?? "Unknown merchant"} ·{" "}
                          {receipt.duplicateOf.amountCents != null
                            ? formatCents(receipt.duplicateOf.amountCents)
                            : "no amount"}{" "}
                          · tap to view the original
                        </Text>
                      </View>
                      <Icon name="chevron-right" size={16} color={colors.danger} />
                    </Pressable>
                    {receipt.duplicateConfirmedByPersonId ? (
                      <Button
                        title="Undo — not a duplicate"
                        variant="secondary"
                        size="sm"
                        loading={unmarkingDuplicate}
                        onPress={() => void handleUnmarkDuplicate()}
                        className="self-start"
                      />
                    ) : null}
                  </View>
                ) : null}

                {/* Possible-duplicate matches (soft signal — same amount+date,
                    a different file). Only shown when un-dismissed; an
                    exact-file dupe already has its own callout above and
                    never shows this too (see the `!receipt.duplicateOfReceiptId`
                    guard). */}
                {receipt.softDuplicate && !receipt.duplicateOfReceiptId ? (
                  <View className="mb-4 gap-2 rounded-md border border-warn bg-warn-bg px-3 py-2.5">
                    <View className="flex-row items-start gap-2">
                      <Icon name="alert-triangle" size={16} color={colors.warn} />
                      <Text className="flex-1 text-xs font-semibold text-warn">
                        Possible duplicate — matches the same amount and date as{" "}
                        {receipt.duplicateMatches.length}{" "}
                        other receipt{receipt.duplicateMatches.length === 1 ? "" : "s"}
                      </Text>
                    </View>
                    {receipt.duplicateMatches.length > 0 ? (
                      <View className="gap-1.5">
                        {receipt.duplicateMatches.map((m) => (
                          <View
                            key={m._id}
                            className="gap-1.5 rounded-md border border-border bg-raised px-2.5 py-2"
                          >
                            <Pressable
                              onPress={() => onOpenReceipt(m._id)}
                              className="flex-row items-center justify-between active:opacity-80"
                            >
                              <View className="flex-1">
                                <Text className="text-xs font-semibold text-ink" numberOfLines={1}>
                                  {m.merchant ?? "Unknown merchant"}
                                </Text>
                                <Text className="text-2xs text-muted">
                                  {m.amountCents != null ? formatCents(m.amountCents) : "no amount"}{" "}
                                  · {m.receiptDate != null ? formatDate(m.receiptDate) : "no date"}
                                </Text>
                              </View>
                              <Icon name="chevron-right" size={14} color={colors.muted} />
                            </Pressable>
                            <Button
                              title="This is a duplicate"
                              variant="secondary"
                              size="sm"
                              icon="copy"
                              loading={markingDuplicateId === m._id}
                              onPress={() => handleMarkAsDuplicate(m._id)}
                              className="self-start"
                            />
                          </View>
                        ))}
                      </View>
                    ) : null}
                    <Button
                      title="Not a duplicate"
                      variant="secondary"
                      size="sm"
                      loading={dismissingDuplicate}
                      onPress={() => void handleDismissDuplicate()}
                      className="self-start"
                    />
                  </View>
                ) : null}

                {/* Editable canonical fields */}
                <TextField
                  label="Amount"
                  value={amountText}
                  onChangeText={setAmountText}
                  placeholder="$0.00"
                  keyboardType="decimal-pad"
                />
                {amountInvalid ? (
                  <Text className="-mt-2 mb-3 text-2xs text-danger">Enter a valid dollar amount.</Text>
                ) : null}

                <Field label="Date">
                  <Pressable
                    onPress={() => setShowCalendar((v) => !v)}
                    className="flex-row items-center gap-1.5 rounded-md border border-border-strong bg-raised px-3 py-2.5"
                  >
                    <Icon name="calendar" size={14} color={colors.muted} />
                    <Text className={date != null ? "text-base text-ink" : "text-base text-faint"}>
                      {date != null ? formatDate(date) : "No date"}
                    </Text>
                    {date != null ? (
                      <Pressable
                        onPress={() => setDate(null)}
                        hitSlop={6}
                        accessibilityLabel="Clear date"
                        className="ml-auto"
                      >
                        <Icon name="x" size={13} color={colors.muted} />
                      </Pressable>
                    ) : null}
                  </Pressable>
                  {showCalendar ? (
                    <View className="mt-2 overflow-hidden rounded-md border border-border bg-raised">
                      <Calendar
                        selected={date}
                        seed={date ?? Date.now()}
                        onSelect={(dayMs) => {
                          setDate(dayMs);
                          setShowCalendar(false);
                        }}
                      />
                    </View>
                  ) : null}
                </Field>

                <TextField label="Merchant" value={merchant} onChangeText={setMerchant} placeholder="e.g. Home Depot" />
                <TextField
                  label="Note"
                  value={note}
                  onChangeText={setNote}
                  placeholder="Anything a bookkeeper should know"
                  multiline
                  numberOfLines={2}
                />

                {receipt.ocrError ? (
                  <View className="mb-2 -mt-1 flex-row items-start gap-2 rounded-md border border-danger bg-danger-bg px-3 py-2">
                    <Icon name="alert-triangle" size={14} color={colors.danger} />
                    <Text className="flex-1 text-xs text-danger">{receipt.ocrError}</Text>
                  </View>
                ) : (
                  <Text className="mb-1 -mt-1 text-2xs text-faint">
                    OCR read: {receipt.ocrAmountCents != null ? formatCents(receipt.ocrAmountCents) : "—"} ·{" "}
                    {receipt.ocrDate != null ? formatDate(receipt.ocrDate) : "—"} ·{" "}
                    {receipt.ocrMerchant ?? "—"}
                  </Text>
                )}
                {correctedByName ? (
                  <Text className="mb-2 text-2xs text-faint">
                    Corrected by {correctedByName}
                    {receipt.correctedAt ? ` · ${formatDate(receipt.correctedAt)}` : ""}
                  </Text>
                ) : null}

                {/* Retry extraction — re-runs OCR/PDF-text routing on the same
                    stored file. Never auto-attaches (see `receipts.retryExtraction`'s
                    doc) — the refreshed candidates below are for a human to pick. */}
                <View className="mb-4 gap-1.5">
                  <View className="flex-row flex-wrap items-center gap-2">
                    <Button
                      title="Retry extraction"
                      variant="secondary"
                      size="sm"
                      icon="refresh-cw"
                      loading={retrying}
                      onPress={() => void handleRetry()}
                    />
                    <Pressable onPress={() => setShowModelInput((v) => !v)} hitSlop={6}>
                      <Text className="text-2xs font-semibold text-muted">
                        {showModelInput ? "Hide model override" : "Model override…"}
                      </Text>
                    </Pressable>
                  </View>
                  {showModelInput ? (
                    <TextField
                      label="Model (advanced)"
                      value={modelOverride}
                      onChangeText={setModelOverride}
                      placeholder="Defaults to the configured model"
                    />
                  ) : null}
                </View>

                <Button
                  title="Save changes"
                  onPress={() => void save()}
                  loading={saving}
                  disabled={amountInvalid}
                  size="sm"
                  className="mb-5 self-start"
                />

                {/* Linked transactions */}
                <Text className="mb-2 text-2xs font-bold uppercase tracking-wider text-muted">
                  Linked transactions
                </Text>
                {receipt.linkedTransactions.length === 0 ? (
                  <Text className="mb-4 text-sm text-faint">Not linked to any transaction yet.</Text>
                ) : (
                  <View className="mb-4 gap-2">
                    {receipt.linkedTransactions.map((t) => (
                      <View
                        key={t.id}
                        className="flex-row items-center justify-between rounded-md border border-border bg-sunken px-3 py-2"
                      >
                        <View className="flex-1">
                          <Text className="text-sm font-semibold text-ink" numberOfLines={1}>
                            {t.merchantName ?? t.description ?? "Transaction"}
                          </Text>
                          <Text className="text-2xs text-muted">
                            {formatCents(t.amountCents)} · {formatDate(t.postedAt)} · {t.status}
                          </Text>
                        </View>
                        <Pressable
                          onPress={() => handleUnlink(t.id, t.merchantName ?? "this charge")}
                          hitSlop={6}
                        >
                          <Text className="text-xs font-semibold text-danger">Unlink</Text>
                        </Pressable>
                      </View>
                    ))}
                  </View>
                )}

                {/* Match picker */}
                <Text className="mb-2 text-2xs font-bold uppercase tracking-wider text-muted">
                  Suggested matches
                </Text>
                {openCandidates.length === 0 ? (
                  <Text className="mb-1 text-sm text-faint">
                    {receipt.amountCents == null
                      ? "Add an amount to see suggested matches."
                      : "No candidate transactions found."}
                  </Text>
                ) : (
                  <View className="gap-2">
                    {openCandidates.map((c) => (
                      <Pressable
                        key={c.transactionId}
                        onPress={() => handleLink(c.transactionId)}
                        className="flex-row items-center justify-between rounded-md border border-border bg-raised px-3 py-2 active:opacity-80"
                      >
                        <View className="flex-1">
                          <Text className="text-sm font-semibold text-ink" numberOfLines={1}>
                            {c.merchantName ?? c.description ?? "Transaction"}
                          </Text>
                          <Text className="text-2xs text-muted">
                            {formatCents(c.amountCents)} · {formatDate(c.postedAt)} · {c.status}
                            {c.merchantOverlap ? " · merchant match" : ""}
                          </Text>
                        </View>
                        <Badge label="Link" tone="accent" icon="link" />
                      </Pressable>
                    ))}
                  </View>
                )}
              </>
            )}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
