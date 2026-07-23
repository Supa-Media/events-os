/**
 * RECEIPTS TAB — Receipt detail panel (item 4 of the receipt CRM UI plan):
 * the full record for one `receipts` document, backed by
 * `api.receipts.getReceipt`. House modal shape (mirrors
 * `TransactionNoteModal`/`TransactionDetailModal`).
 *
 *  - Image (falls back to "Open file" via `Linking` when it fails to decode
 *    — the backend never tells us content-type, so a PDF/HTML-sourced
 *    receipt is detected by the `<Image>` failing to render, not sniffed
 *    ahead of time).
 *  - Editable CANONICAL fields (amount/date/merchant/note) via
 *    `updateReceiptFields` — the immutable OCR read renders as read-only
 *    subtext underneath, never editable.
 *  - Linked transactions, each unlinkable (`unlinkReceipt`).
 *  - A match picker off `suggestMatches` — a plain Convex query that re-runs
 *    automatically whenever the canonical amount/date/merchant change (no
 *    manual refetch needed after a save).
 *  - A `duplicateOf` callout when flagged, tapping through to the original
 *    (re-keys this same modal via the parent's `onOpenReceipt`).
 */
import { useEffect, useState } from "react";
import { Image, Linking, Modal, Pressable, ScrollView, Text, View } from "react-native";
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

  const [amountText, setAmountText] = useState("");
  const [date, setDate] = useState<number | null>(null);
  const [merchant, setMerchant] = useState("");
  const [note, setNote] = useState("");
  const [seededFor, setSeededFor] = useState<Id<"receipts"> | null>(null);
  const [saving, setSaving] = useState(false);
  const [imgFailed, setImgFailed] = useState(false);
  const [showCalendar, setShowCalendar] = useState(false);

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
                {/* File preview */}
                <View className="mb-4 h-48 w-full items-center justify-center overflow-hidden rounded-lg border border-border bg-sunken">
                  {receipt.url && !imgFailed ? (
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

                <View className="mb-3 flex-row flex-wrap items-center gap-1.5">
                  <Badge label={senderClassLabel(receipt.senderClass)} tone={senderClassTone(receipt.senderClass)} />
                  <Badge label={receipt.source === "email" ? "Emailed" : "Uploaded"} tone="neutral" />
                  {receipt.softDuplicate && !receipt.duplicateOfReceiptId ? (
                    <Badge label="Possible duplicate" tone="warn" icon="alert-triangle" />
                  ) : null}
                </View>

                {/* Duplicate-of callout */}
                {receipt.duplicateOf ? (
                  <Pressable
                    onPress={() => onOpenReceipt(receipt.duplicateOf!._id)}
                    className="mb-4 flex-row items-center gap-3 rounded-md border border-danger bg-danger-bg px-3 py-2.5 active:opacity-80"
                  >
                    <Icon name="copy" size={16} color={colors.danger} />
                    <View className="flex-1">
                      <Text className="text-xs font-semibold text-danger">
                        Duplicate of an earlier receipt
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

                <Text className="mb-1 -mt-1 text-2xs text-faint">
                  OCR read: {receipt.ocrAmountCents != null ? formatCents(receipt.ocrAmountCents) : "—"} ·{" "}
                  {receipt.ocrDate != null ? formatDate(receipt.ocrDate) : "—"} ·{" "}
                  {receipt.ocrMerchant ?? "—"}
                </Text>
                {correctedByName ? (
                  <Text className="mb-3 text-2xs text-faint">
                    Corrected by {correctedByName}
                    {receipt.correctedAt ? ` · ${formatDate(receipt.correctedAt)}` : ""}
                  </Text>
                ) : null}

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
