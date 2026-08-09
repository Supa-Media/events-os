/**
 * BulkNoDocumentationModal — acknowledging that a whole selection has no
 * receipts, in one pass.
 *
 * Owner framing (2026-08-05): *"I know there's a lot of subway transactions
 * that I'm just going to have to mark as not receiptable… as long as we
 * acknowledge there's no documentation, we move forward doing better."*
 *
 * The design point is that the HONEST option has to be the cheap one. A
 * per-row-only path means acknowledging 200 transit fares costs 200 modals
 * while marking them Reconciled document-less costs one click — so the
 * dishonest option wins on effort, which is exactly how a ledger becomes
 * unpublishable. This makes the two cost the same.
 *
 * It is still per-row underneath: `receiptExceptions.attestBulk` writes one
 * attestation per transaction, each with its own amount and its own audit
 * entry. Nothing is waived anonymously or in aggregate.
 */
import { useState } from "react";
import { Modal, Pressable, ScrollView, Text, View } from "react-native";
import { useQuery } from "convex/react";
import {
  RECEIPT_EXCEPTION_REASONS,
  RECEIPT_EXCEPTION_REASON_LABELS,
  RECEIPT_EXCEPTION_REASON_HINTS,
  MIN_EXCEPTION_NOTE_LENGTH,
  type ReceiptExceptionReason,
} from "@events-os/shared";
import { api } from "@events-os/convex/_generated/api";
import { Button, Icon, Radio, RadioGroup, TextField } from "../../ui";
import { colors } from "../../../lib/theme";

export function BulkNoDocumentationModal({
  count,
  onConfirm,
  onCancel,
  submitting,
}: {
  /** How many transactions are selected — stated plainly, because this is the
   *  one control in the app that writes an attestation to many rows at once. */
  count: number;
  onConfirm: (args: { reason: ReceiptExceptionReason; note: string }) => void;
  onCancel: () => void;
  submitting?: boolean;
}) {
  // `no_receipt_issued` is the honest default for the case that drives this
  // flow — transit fares, meters, cash tips. Still changeable: defaulting is a
  // convenience, not an assumption about what happened.
  const [reason, setReason] =
    useState<ReceiptExceptionReason>("no_receipt_issued");
  const [note, setNote] = useState("");
  const threshold = useQuery(api.receiptExceptions.approvalThreshold, {});
  const trimmed = note.trim();
  const noteOk = trimmed.length >= MIN_EXCEPTION_NOTE_LENGTH;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onCancel}>
      <Pressable
        onPress={onCancel}
        className="flex-1 items-center justify-center bg-ink/30 p-6"
      >
        <Pressable
          onPress={() => {}}
          className="w-full max-w-lg overflow-hidden rounded-xl border border-border bg-raised shadow-pop"
        >
          <View className="flex-row items-center justify-between border-b border-border px-5 py-4">
            <Text className="font-display text-lg text-ink">
              No documentation for {count} {count === 1 ? "charge" : "charges"}
            </Text>
            <Pressable onPress={onCancel} hitSlop={8} className="rounded-md p-1">
              <Icon name="x" size={18} color={colors.muted} />
            </Pressable>
          </View>

          <ScrollView className="max-h-[400px]">
            <View className="px-5 py-4">
              <Text className="mb-4 text-xs text-muted">
                One record is written per charge — same reason, same note, its
                own attestation and audit entry under your name. Nothing is
                waived in bulk; it&apos;s just filed in bulk.
              </Text>

              <Text className="mb-2 text-2xs font-semibold uppercase tracking-wide text-muted">
                Why is there no receipt?
              </Text>
              <RadioGroup
                accessibilityLabel="Why is there no receipt?"
                className="mb-4 gap-2"
              >
                {RECEIPT_EXCEPTION_REASONS.map((r) => {
                  const selected = reason === r;
                  return (
                    <Radio
                      key={r}
                      checked={selected}
                      onSelect={() => setReason(r)}
                      accessibilityLabel={RECEIPT_EXCEPTION_REASON_LABELS[r]}
                      className={`rounded-lg border px-3 py-2.5 active:opacity-70 ${
                        selected
                          ? "border-accent bg-accent/5"
                          : "border-border bg-sunken"
                      }`}
                    >
                      <Text className="text-sm font-medium text-ink">
                        {RECEIPT_EXCEPTION_REASON_LABELS[r]}
                      </Text>
                      <Text className="mt-0.5 text-2xs text-muted">
                        {RECEIPT_EXCEPTION_REASON_HINTS[r]}
                      </Text>
                    </Radio>
                  );
                })}
              </RadioGroup>

              <Text className="mb-2 text-2xs font-semibold uppercase tracking-wide text-muted">
                What were they for?
              </Text>
              <TextField
                value={note}
                onChangeText={setNote}
                placeholder="e.g. Subway fares travelling between outreach sites — OMNY taps, no itemised receipt is issued"
                multiline
                numberOfLines={3}
              />
              {!noteOk && trimmed.length > 0 ? (
                <Text className="mt-1 text-2xs text-muted">
                  A little more detail — at least {MIN_EXCEPTION_NOTE_LENGTH}{" "}
                  characters.
                </Text>
              ) : null}
              <Text className="mt-1 text-2xs text-muted">
                This note is published against every charge in the selection, so
                write one that&apos;s true of all of them. Charges that need
                different explanations want separate passes.
              </Text>

              {threshold != null ? (
                <View className="mt-4 flex-row items-start gap-2 rounded-md border border-border bg-sunken px-3 py-2">
                  <Icon name="info" size={13} color={colors.muted} />
                  <Text className="flex-1 text-2xs text-muted">
                    Charges under {threshold.label} are approved as you file
                    them, if you&apos;re a Finance manager. Anything at or above{" "}
                    {threshold.label} still needs a second person, and waits.
                  </Text>
                </View>
              ) : null}
            </View>
          </ScrollView>

          <View className="flex-row justify-end gap-2 border-t border-border px-5 py-4">
            <Button title="Cancel" variant="secondary" onPress={onCancel} />
            <Button
              title={`Acknowledge ${count}`}
              onPress={() => {
                if (noteOk) onConfirm({ reason, note: trimmed });
              }}
              disabled={!noteOk}
              loading={submitting}
            />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
