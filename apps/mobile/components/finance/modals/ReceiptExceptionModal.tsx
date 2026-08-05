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
import { Image, Modal, Platform, Pressable, ScrollView, Text, View } from "react-native";
import * as ImagePicker from "expo-image-picker";
import { useMutation, useQuery } from "convex/react";
import {
  RECEIPT_EXCEPTION_REASONS,
  RECEIPT_EXCEPTION_REASON_LABELS,
  RECEIPT_EXCEPTION_REASON_HINTS,
  MIN_EXCEPTION_NOTE_LENGTH,
  MAX_EXCEPTION_EVIDENCE,
  exceptionNeedsSecondApprover,
  type ReceiptExceptionReason,
} from "@events-os/shared";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
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
  onConfirm: (args: {
    reason: ReceiptExceptionReason;
    note: string;
    evidenceStorageIds: Id<"_storage">[];
  }) => void;
  onCancel: () => void;
  submitting?: boolean;
}) {
  const [reason, setReason] = useState<ReceiptExceptionReason | null>(null);
  const [note, setNote] = useState("");
  // Evidence is uploaded to storage as it's picked (so the confirm handler
  // stays a plain mutation call), holding onto a local preview uri for the
  // thumbnail — the signed url doesn't exist until the row is read back.
  const [evidence, setEvidence] = useState<
    { storageId: Id<"_storage">; previewUri: string }[]
  >([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const generateUploadUrl = useMutation(api.storage.generateUploadUrl);
  const threshold = useQuery(api.receiptExceptions.approvalThreshold, {});
  const trimmed = note.trim();
  const noteOk = trimmed.length >= MIN_EXCEPTION_NOTE_LENGTH;
  // Undefined while the threshold query is in flight — don't guess a number,
  // just hold the hint back until it lands.
  const needsSecond =
    threshold != null
      ? exceptionNeedsSecondApprover(amountCents, threshold.cents)
      : null;

  async function uploadBlob(blob: Blob, contentType: string, previewUri: string) {
    setUploading(true);
    setUploadError(null);
    try {
      const uploadUrl = await generateUploadUrl();
      const res = await fetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": contentType },
        body: blob,
      });
      const { storageId } = await res.json();
      setEvidence((prev) =>
        prev.length >= MAX_EXCEPTION_EVIDENCE
          ? prev
          : [...prev, { storageId: storageId as Id<"_storage">, previewUri }],
      );
    } catch {
      // A failed upload must not silently look attached — the whole point of
      // evidence is that it's really there when someone reads the ledger.
      setUploadError("That file didn't upload. Try again.");
    } finally {
      setUploading(false);
    }
  }

  // Same pick → blob → upload dance as `ReceiptCell`: a web file input (which
  // also takes PDFs, for a statement page) or the native image picker.
  function pickEvidence() {
    if (Platform.OS === "web") {
      if (typeof document === "undefined") return;
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/*,application/pdf";
      input.onchange = () => {
        const file = input.files?.[0];
        if (!file) return;
        void uploadBlob(
          file,
          file.type || "application/octet-stream",
          URL.createObjectURL(file),
        );
      };
      input.click();
      return;
    }
    void (async () => {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        quality: 0.9,
      });
      if (result.canceled || !result.assets?.length) return;
      const asset = result.assets[0];
      const resp = await fetch(asset.uri);
      const blob = await resp.blob();
      await uploadBlob(blob, asset.mimeType || blob.type || "image/jpeg", asset.uri);
    })();
  }

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

              {/* EVIDENCE. Optional, but asked for prominently and framed with
                  the case that actually comes up — you can't produce the
                  receipt but you can absolutely produce photos of what you
                  bought. An exception carrying proof is a far stronger public
                  artifact than one carrying only an assertion. */}
              <View className="mt-4 mb-2 flex-row items-center justify-between">
                <Text className="text-2xs font-semibold uppercase tracking-wide text-muted">
                  Proof it happened{" "}
                  <Text className="font-normal normal-case tracking-normal">
                    (optional, but do it)
                  </Text>
                </Text>
                {evidence.length < MAX_EXCEPTION_EVIDENCE ? (
                  <Pressable
                    onPress={pickEvidence}
                    accessibilityRole="button"
                    disabled={uploading}
                    className="active:opacity-70"
                  >
                    <Text className="text-xs font-medium text-accent">
                      {uploading ? "Uploading…" : "Add photo"}
                    </Text>
                  </Pressable>
                ) : null}
              </View>
              <Text className="mb-2 text-2xs text-muted">
                Bought flowers and never got a receipt? Photos of them at the
                event are proof. So is a bank statement line, an order
                confirmation email, or a picture of what you bought.
              </Text>
              {evidence.length > 0 ? (
                <View className="flex-row flex-wrap gap-2">
                  {evidence.map((item) => (
                    <View key={item.storageId} className="relative">
                      <Image
                        source={{ uri: item.previewUri }}
                        className="h-16 w-16 rounded-md border border-border"
                        resizeMode="cover"
                        accessibilityLabel="Attached evidence"
                      />
                      <Pressable
                        onPress={() =>
                          setEvidence((prev) =>
                            prev.filter((e) => e.storageId !== item.storageId),
                          )
                        }
                        hitSlop={6}
                        accessibilityRole="button"
                        accessibilityLabel="Remove this file"
                        className="absolute -right-1.5 -top-1.5 rounded-full bg-ink p-0.5"
                      >
                        <Icon name="x" size={11} color={colors.raised} />
                      </Pressable>
                    </View>
                  ))}
                </View>
              ) : null}
              {uploadError ? (
                <Text className="mt-1 text-2xs text-danger">{uploadError}</Text>
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
                if (reason && noteOk) {
                  onConfirm({
                    reason,
                    note: trimmed,
                    evidenceStorageIds: evidence.map((e) => e.storageId),
                  });
                }
              }}
              disabled={!reason || !noteOk || uploading}
              loading={submitting}
            />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
