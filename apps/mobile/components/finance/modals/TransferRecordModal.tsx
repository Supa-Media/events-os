/**
 * TransferRecordModal — record a manual central↔chapter transfer from the
 * central dashboard.
 *
 * RETIRED (owner decision 2026-07-26 — "it feels unnecessarily complex...
 * it could be just a manual transfer"): this used to be a three-way picker
 * (skim in / grant out / settlement) with a revenue-vs-amount toggle and a
 * live 15% preview, plus an "Initiate real transfer" action that could fire
 * an actual Increase account-to-account transfer. All of that is gone. This
 * is now the same shape as `ManualTransactionModal`: direction, chapter,
 * amount, date, an optional note — backed by the ONE generic
 * `api.transfers.recordTransfer` mutation. Money always moves outside the
 * app first (the owner's bank/Increase dashboard); this just records the
 * ledger truth for it. Use the note to say what it was for (the skim
 * commitment, a launch grant, a settlement, or anything else) — the app no
 * longer distinguishes those reasons structurally.
 *
 * The "Inter-chapter balances" section's "Settle" affordance still opens
 * this modal PRESET to the direction/amount it computed, so the treasurer
 * doesn't re-enter it — see `preset` below.
 */
import { useMemo, useState } from "react";
import { Modal, Pressable, ScrollView, Text, View } from "react-native";
import { useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { Button, DateTimeField, Field, Icon, Select, TextField } from "../../ui";
import { colors } from "../../../lib/theme";
import { alertError } from "../../../lib/errors";

type Direction = "chapter_to_central" | "central_to_chapter";

const DIRECTION_OPTIONS = [
  { value: "chapter_to_central", label: "Chapter → Central" },
  { value: "central_to_chapter", label: "Central → Chapter" },
];

function dollarsToCents(text: string): number | null {
  const dollars = parseFloat(text);
  if (!Number.isFinite(dollars) || dollars <= 0) return null;
  return Math.round(dollars * 100);
}

export function TransferRecordModal({
  chapters,
  onClose,
  preset,
}: {
  /** The real chapters money can move to/from (from `dashboardCentral`). */
  chapters: Array<{ chapterId: Id<"chapters">; chapterName: string }>;
  onClose: () => void;
  /** Opened from the "Inter-chapter balances" section's "Settle" affordance —
   *  presets the modal to the direction/amount that section computed, so the
   *  treasurer doesn't re-enter it. */
  preset?: {
    chapterId: Id<"chapters">;
    amountCents: number;
    direction: Direction;
  };
}) {
  const recordTransfer = useMutation(api.transfers.recordTransfer);

  const [direction, setDirection] = useState<Direction>(
    preset?.direction ?? "chapter_to_central",
  );
  const [chapterId, setChapterId] = useState<string | null>(
    preset?.chapterId ?? chapters[0]?.chapterId ?? null,
  );
  const [amount, setAmount] = useState(
    preset ? String(preset.amountCents / 100) : "",
  );
  const [postedAt, setPostedAt] = useState(Date.now());
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  const chapterOptions = useMemo(
    () => chapters.map((c) => ({ value: c.chapterId, label: c.chapterName })),
    [chapters],
  );

  async function submit() {
    if (!chapterId) {
      alertError(new Error("Pick a chapter."));
      return;
    }
    const amountCents = dollarsToCents(amount);
    if (amountCents == null) {
      alertError(new Error("Enter a valid amount."));
      return;
    }
    setSaving(true);
    try {
      await recordTransfer({
        direction,
        chapterId: chapterId as Id<"chapters">,
        amountCents,
        postedAt,
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      onClose();
    } catch (err) {
      alertError(err);
    } finally {
      setSaving(false);
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
          className="w-full max-w-lg overflow-hidden rounded-xl border border-border bg-raised shadow-pop"
        >
          <View className="flex-row items-center justify-between border-b border-border px-5 py-4">
            <Text className="font-display text-lg text-ink">Record transfer</Text>
            <Pressable onPress={onClose} hitSlop={8} className="rounded-md p-1">
              <Icon name="x" size={18} color={colors.muted} />
            </Pressable>
          </View>

          <ScrollView className="max-h-[520px] px-5 py-4">
            <Select
              label="Direction"
              value={direction}
              options={DIRECTION_OPTIONS}
              onChange={(v) => setDirection(v as Direction)}
            />
            <Select
              label="Chapter"
              value={chapterId}
              options={chapterOptions}
              onChange={(v) => setChapterId(v || null)}
              placeholder="Pick a chapter"
            />

            <TextField
              label="Amount (USD)"
              value={amount}
              onChangeText={setAmount}
              keyboardType="decimal-pad"
              placeholder="0.00"
            />

            <Field label="Date">
              <DateTimeField value={postedAt} onChange={setPostedAt} />
            </Field>

            <Field label="Note (optional)">
              <TextField
                label=""
                value={note}
                onChangeText={setNote}
                placeholder="What moved, and why (e.g. this month's skim commitment)"
              />
            </Field>
          </ScrollView>

          <View className="flex-row justify-end gap-2 border-t border-border px-5 py-4">
            <Button title="Cancel" variant="secondary" onPress={onClose} />
            <Button title="Record transfer" onPress={submit} loading={saving} />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
