/**
 * CorrectTransactionModal — fixing a manually-entered row's amount, date,
 * merchant or description.
 *
 * Only reachable for rows the SERVER said are correctable (`row.correctable`,
 * `manual` source only). A synced row never shows the affordance, and would be
 * refused with `NOT_CORRECTABLE` if it somehow did — see
 * `apps/convex/lib/financeEditAccess.ts`.
 *
 * The reason field is required and is not decoration: these rows get published,
 * and the audit trail is what makes "we corrected our history" different from
 * "we quietly changed our history". The copy says so, because a required field
 * whose purpose isn't obvious gets filled with "fix".
 */
import { useState } from "react";
import { Modal, Pressable, ScrollView, Text, View } from "react-native";
import { formatCents } from "@events-os/shared";
import { Button, Icon, TextField } from "../../ui";
import { colors } from "../../../lib/theme";

/** `YYYY-MM-DD` in Eastern time — the spelling the date input round-trips. */
function toDateInput(ms: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "America/New_York",
  }).format(new Date(ms));
  return parts;
}

/** Parse `YYYY-MM-DD` back to a timestamp at NOON Eastern. Noon, not midnight,
 *  so a DST shift or a viewer in another zone can't roll the date backwards a
 *  day — the same trap that makes "off by one day" the classic date bug. */
function fromDateInput(value: string): number | null {
  const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const [, y, m, d] = match;
  const ms = Date.parse(`${y}-${m}-${d}T12:00:00-05:00`);
  return Number.isFinite(ms) ? ms : null;
}

export function CorrectTransactionModal({
  current,
  onConfirm,
  onCancel,
  submitting,
}: {
  current: {
    amountCents: number;
    postedAt: number;
    merchantName: string | null;
    description: string | null;
    isReconstructed: boolean;
  };
  onConfirm: (args: {
    amountCents?: number;
    postedAt?: number;
    merchantName?: string | null;
    description?: string | null;
    reason: string;
  }) => void;
  onCancel: () => void;
  submitting?: boolean;
}) {
  // Dollars as typed, not cents — the field a human edits is the one they read.
  const [amount, setAmount] = useState(
    (current.amountCents / 100).toFixed(2),
  );
  const [date, setDate] = useState(toDateInput(current.postedAt));
  const [merchant, setMerchant] = useState(current.merchantName ?? "");
  const [description, setDescription] = useState(current.description ?? "");
  const [reason, setReason] = useState("");

  const parsedAmount = Math.round(Number(amount.replace(/[$,\s]/g, "")) * 100);
  const amountOk = Number.isFinite(parsedAmount) && parsedAmount >= 0;
  const parsedDate = fromDateInput(date);
  const dateOk = parsedDate != null;
  const reasonOk = reason.trim().length > 0;

  const changed =
    (amountOk && parsedAmount !== current.amountCents) ||
    (dateOk && parsedDate !== current.postedAt) ||
    merchant.trim() !== (current.merchantName ?? "") ||
    description.trim() !== (current.description ?? "");

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
              Correct this transaction
            </Text>
            <Pressable onPress={onCancel} hitSlop={8} className="rounded-md p-1">
              <Icon name="x" size={18} color={colors.muted} />
            </Pressable>
          </View>

          <ScrollView className="max-h-[440px]">
            <View className="gap-3 px-5 py-4">
              {current.isReconstructed ? (
                <View className="flex-row items-start gap-2 rounded-md border border-border bg-sunken px-3 py-2">
                  <Icon name="clock" size={13} color={colors.muted} />
                  <Text className="flex-1 text-2xs text-muted">
                    This row is reconstructed history — it was loaded from a
                    spreadsheet or document, not observed as it happened. That
                    is exactly the kind of row worth correcting.
                  </Text>
                </View>
              ) : null}

              <View>
                <Text className="mb-1 text-2xs font-semibold uppercase tracking-wide text-muted">
                  Amount
                </Text>
                <TextField
                  value={amount}
                  onChangeText={setAmount}
                  placeholder="0.00"
                  keyboardType="decimal-pad"
                />
                <Text className="mt-1 text-2xs text-muted">
                  Currently {formatCents(current.amountCents)}. Enter a positive
                  number — whether it&apos;s money in or out is the row&apos;s
                  direction, not a minus sign.
                </Text>
                {!amountOk ? (
                  <Text className="mt-1 text-2xs text-danger">
                    That isn&apos;t a valid amount.
                  </Text>
                ) : null}
              </View>

              <View>
                <Text className="mb-1 text-2xs font-semibold uppercase tracking-wide text-muted">
                  Date
                </Text>
                <TextField
                  value={date}
                  onChangeText={setDate}
                  placeholder="YYYY-MM-DD"
                  autoCapitalize="none"
                />
                {!dateOk ? (
                  <Text className="mt-1 text-2xs text-danger">
                    Use YYYY-MM-DD.
                  </Text>
                ) : null}
              </View>

              <View>
                <Text className="mb-1 text-2xs font-semibold uppercase tracking-wide text-muted">
                  Merchant
                </Text>
                <TextField
                  value={merchant}
                  onChangeText={setMerchant}
                  placeholder="Who was paid"
                />
              </View>

              <View>
                <Text className="mb-1 text-2xs font-semibold uppercase tracking-wide text-muted">
                  Description
                </Text>
                <TextField
                  value={description}
                  onChangeText={setDescription}
                  placeholder="What it was"
                  multiline
                  numberOfLines={2}
                />
              </View>

              <View>
                <Text className="mb-1 text-2xs font-semibold uppercase tracking-wide text-muted">
                  Why are you correcting it?
                </Text>
                <TextField
                  value={reason}
                  onChangeText={setReason}
                  placeholder="e.g. Imported from the Notion export with the wrong amount — the original invoice says $455"
                  multiline
                  numberOfLines={2}
                />
                <Text className="mt-1 text-2xs text-muted">
                  Recorded against every field you changed, under your name. We
                  publish these transactions, so a correction has to be
                  distinguishable from a quiet edit.
                </Text>
              </View>
            </View>
          </ScrollView>

          <View className="flex-row justify-end gap-2 border-t border-border px-5 py-4">
            <Button title="Cancel" variant="secondary" onPress={onCancel} />
            <Button
              title="Save correction"
              onPress={() => {
                if (!amountOk || !dateOk || !reasonOk || !changed) return;
                onConfirm({
                  amountCents: parsedAmount,
                  postedAt: parsedDate,
                  merchantName: merchant.trim() || null,
                  description: description.trim() || null,
                  reason: reason.trim(),
                });
              }}
              disabled={!amountOk || !dateOk || !reasonOk || !changed}
              loading={submitting}
            />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
