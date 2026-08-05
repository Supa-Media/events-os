/**
 * ReceiptExceptionModal — filing the documentation of record for a
 * transaction that can never carry a receipt.
 *
 * The form deliberately asks for two things and refuses to proceed without
 * either: WHY there's no receipt (a reason, not free text — see
 * `RECEIPT_EXCEPTION_REASONS`) and WHAT the money was for (the note, which is
 * the actual substitute for the document once the ledger is published). The
 * server enforces both (`lib/receiptExceptions.ts#normalizeExceptionNote`);
 * this mirrors the floor so a filer finds out before they submit, not after.
 *
 * The threshold hint is live from `receiptExceptions.approvalThreshold` rather
 * than hardcoded — a filer should know up front whether this one needs a
 * second person, because that's the difference between "done" and "waiting on
 * the Treasurer".
 */
import { useState } from "react";
import { Modal, Pressable, ScrollView, Text, View } from "react-native";
import { useQuery } from "convex/react";
import {
  RECEIPT_EXCEPTION_REASONS,
  RECEIPT_EXCEPTION_REASON_LABELS,
  RECEIPT_EXCEPTION_REASON_HINTS,
  MIN_EXCEPTION_NOTE_LENGTH,
  exceptionNeedsSecondApprover,
  type ReceiptExceptionReason,
} from "@events-os/shared";
import { api } from "@events-os/convex/_generated/api";
import { Button, Icon, TextField } from "../../ui";
import { colors } from "../../../lib/theme";

export function ReceiptExceptionModal({
  amountCents,
  onConfirm,
  onCancel,
  submitting,
}: {
  /** The transaction's amount — drives the "needs a second approver" hint. */
  amountCents: number;
  onConfirm: (args: { reason: ReceiptExceptionReason; note: string }) => void;
  onCancel: () => void;
  submitting?: boolean;
}) {
  const [reason, setReason] = useState<ReceiptExceptionReason | null>(null);
  const [note, setNote] = useState("");
  const threshold = useQuery(api.receiptExceptions.approvalThreshold, {});
  const trimmed = note.trim();
  const noteOk = trimmed.length >= MIN_EXCEPTION_NOTE_LENGTH;
  // Undefined while the threshold query is in flight — don't guess a number,
  // just hold the hint back until it lands.
  const needsSecond =
    threshold != null
      ? exceptionNeedsSecondApprover(amountCents, threshold.cents)
      : null;

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
              No receipt for this
            </Text>
            <Pressable onPress={onCancel} hitSlop={8} className="rounded-md p-1">
              <Icon name="x" size={18} color={colors.muted} />
            </Pressable>
          </View>

          <ScrollView className="max-h-[420px]">
            <View className="px-5 py-4">
              <Text className="mb-4 text-xs text-muted">
                We publish every transaction. When no receipt exists, what gets
                published instead is this: your name, the reason, and what the
                money was for. It stands in for the document — so write it the
                way you&apos;d want a backer to read it.
              </Text>

              <Text className="mb-2 text-2xs font-semibold uppercase tracking-wide text-muted">
                Why is there no receipt?
              </Text>
              <View className="mb-4 gap-2">
                {RECEIPT_EXCEPTION_REASONS.map((r) => {
                  const selected = reason === r;
                  return (
                    <Pressable
                      key={r}
                      onPress={() => setReason(r)}
                      accessibilityRole="radio"
                      accessibilityState={{ selected }}
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
                    </Pressable>
                  );
                })}
              </View>

              <Text className="mb-2 text-2xs font-semibold uppercase tracking-wide text-muted">
                What was it for?
              </Text>
              <TextField
                value={note}
                onChangeText={setNote}
                placeholder="e.g. Cash tip for the sound engineer at the Aug 2 outdoor service — $40, agreed with Kansi beforehand"
                multiline
                numberOfLines={3}
              />
              {!noteOk && trimmed.length > 0 ? (
                <Text className="mt-1 text-2xs text-muted">
                  A little more detail — at least {MIN_EXCEPTION_NOTE_LENGTH}{" "}
                  characters.
                </Text>
              ) : null}

              {needsSecond != null ? (
                <View className="mt-4 flex-row items-start gap-2 rounded-md border border-border bg-sunken px-3 py-2">
                  <Icon name="info" size={13} color={colors.muted} />
                  <Text className="flex-1 text-2xs text-muted">
                    {needsSecond
                      ? `Over ${threshold?.label} — someone other than you has to approve this before it counts as documentation.`
                      : `Under ${threshold?.label} — a Finance manager can approve this in one step.`}
                  </Text>
                </View>
              ) : null}
            </View>
          </ScrollView>

          <View className="flex-row justify-end gap-2 border-t border-border px-5 py-4">
            <Button title="Cancel" variant="secondary" onPress={onCancel} />
            <Button
              title="File exception"
              onPress={() => {
                if (reason && noteOk) onConfirm({ reason, note: trimmed });
              }}
              disabled={!reason || !noteOk}
              loading={submitting}
            />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
