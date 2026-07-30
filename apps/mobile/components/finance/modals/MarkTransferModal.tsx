/**
 * MarkTransferModal — the confirm step for `finances.markAsTransfer`.
 *
 * Marking is a PAIR operation by design (founder: "yes lets require marking
 * the other leg"), so this modal's whole job is to show the two legs side by
 * side and make the bookkeeper look at them before committing. Marking one
 * side alone would leave the other half of the movement sitting in the ledger
 * as unexplained income, which is the problem the pairing rule exists to stop
 * — so there is deliberately no single-row "mark as transfer" affordance
 * anywhere in the UI, and the bulk bar only offers this at exactly two rows.
 *
 * Confirm-first mirrors `MarkPersonalModal` / `ExcludeReasonModal`: this moves
 * real money out of every spend total, so it must never fire off a stray tap.
 * The optional note is the "why" (`transactions.note`), applied only to a leg
 * that doesn't already have one — server-side, so this modal never overwrites
 * a bookkeeper's existing note.
 */
import { useState } from "react";
import { Modal, Pressable, Text, View } from "react-native";
import { formatCents } from "@events-os/shared";
import { Button, Icon, TextField } from "../../ui";
import { colors } from "../../../lib/theme";
import { shortDate } from "../reconcile/helpers";

export type TransferLegPreview = {
  id: string;
  postedAt: number;
  amountCents: number;
  flow: "outflow" | "inflow" | "transfer";
  /** `finances.markAsTransfer` marked this row (as opposed to a transfer the
   *  app RECORDED — a recorded central↔chapter movement, a repayment credit,
   *  a reimbursement). Both read `flow:"transfer"` and neither is a plain
   *  inflow, but only the marked one can be un-marked and re-paired, so the
   *  warning below has to tell them apart. */
  isMarkedTransfer: boolean;
  label: string;
};

export function MarkTransferModal({
  legs,
  onConfirm,
  onCancel,
  submitting,
}: {
  /** Exactly the two selected rows, in selection order. The server re-checks
   *  everything that matters (one out / one in, equal amounts, same books) —
   *  this preview exists so a human catches a mis-pick before that. */
  legs: [TransferLegPreview, TransferLegPreview];
  onConfirm: (note: string | null) => void;
  onCancel: () => void;
  submitting?: boolean;
}) {
  const [note, setNote] = useState("");
  const [a, b] = legs;
  // Surfaced as a warning, not a block — the server is the real gate
  // (`AMOUNT_MISMATCH` / `NOT_A_PAIR` / `ALREADY_TRANSFER` / …). Showing it
  // here just turns a rejected write into an obvious mis-pick the bookkeeper
  // can fix before submitting.
  //
  // ALREADY-A-TRANSFER FIRST, and that order is the bug fix: a row carrying
  // `flow:"transfer"` is neither an outflow nor an inflow, so it used to fail
  // the out/in test and get reported as "these two move the same way" — a
  // diagnosis that sent the founder looking for a direction problem on a pair
  // whose directions were fine. Name the row and say what to do with it.
  const alreadyTransfer = legs.find((l) => l.flow === "transfer") ?? null;
  const amountsMatch = a.amountCents === b.amountCents;
  const oppositeFlows =
    (a.flow === "outflow" && b.flow === "inflow") ||
    (a.flow === "inflow" && b.flow === "outflow");
  const problem = alreadyTransfer
    ? alreadyTransfer.isMarkedTransfer
      ? `${alreadyTransfer.label} is already marked as a transfer. Un-mark it first (the ✕ next to its Transfer badge) — unless its other leg is gone, in which case marking again re-pairs it.`
      : `${alreadyTransfer.label} is already a transfer the app recorded, so it can't be marked. Undo it from the Transfers tool if it's wrong.`
    : !oppositeFlows
      ? "A transfer is one row leaving an account and one arriving. These two move the same way."
      : !amountsMatch
        ? "These two amounts don't match. Check you've picked both sides of the same movement."
        : null;
  // A RECORDED transfer is a certain refusal, so don't offer the button at
  // all. Everything else stays submittable — the warnings above are advisory
  // and the server has the last word (a marked ORPHAN really does re-pair).
  const blocked = alreadyTransfer != null && !alreadyTransfer.isMarkedTransfer;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onCancel}>
      <Pressable
        onPress={onCancel}
        className="flex-1 items-center justify-center bg-ink/30 p-6"
      >
        <Pressable
          onPress={() => {}}
          className="w-full max-w-md overflow-hidden rounded-xl border border-border bg-raised shadow-pop"
        >
          <View className="flex-row items-center justify-between border-b border-border px-5 py-4">
            <Text className="font-display text-lg text-ink">
              Mark as internal transfer
            </Text>
            <Pressable onPress={onCancel} hitSlop={8} className="rounded-md p-1">
              <Icon name="x" size={18} color={colors.muted} />
            </Pressable>
          </View>

          <View className="gap-3 px-5 py-4">
            <Text className="text-xs text-muted">
              Money moving between your own accounts. Both rows drop out of
              spend and budget totals, so the same dollars aren&apos;t counted
              twice — they&apos;ll still be asked for a statement.
            </Text>

            <View className="gap-2 rounded-lg border border-border px-3 py-2.5">
              {legs.map((leg) => (
                <View
                  key={leg.id}
                  className="flex-row items-center justify-between gap-3"
                >
                  <View className="flex-1">
                    <Text className="text-xs text-ink" numberOfLines={1}>
                      {leg.label}
                    </Text>
                    <Text className="text-[11px] text-faint">
                      {shortDate(leg.postedAt)}
                      {/* Say it on the row itself, not just in the warning —
                          this is the state the grid's Transfer badge shows,
                          and the reason the pair can't be marked. */}
                      {leg.flow === "transfer"
                        ? leg.isMarkedTransfer
                          ? " · already marked as a transfer"
                          : " · already a recorded transfer"
                        : ""}
                    </Text>
                  </View>
                  <Text
                    className={`text-xs font-semibold ${
                      leg.flow === "outflow"
                        ? "text-ink"
                        : leg.flow === "inflow"
                          ? "text-success"
                          : "text-muted"
                    }`}
                  >
                    {leg.flow === "outflow" ? "−" : leg.flow === "inflow" ? "+" : ""}
                    {formatCents(leg.amountCents)}
                  </Text>
                </View>
              ))}
            </View>

            {problem ? (
              <View className="flex-row items-start gap-2 rounded-lg border border-danger bg-danger-soft px-3 py-2">
                <Icon name="alert-triangle" size={14} color={colors.danger} />
                <Text className="flex-1 text-[11px] text-danger">{problem}</Text>
              </View>
            ) : null}

            <TextField
              label="Why (optional)"
              value={note}
              onChangeText={setNote}
              placeholder="e.g. moved to the operating account"
            />
          </View>

          <View className="flex-row justify-end gap-2 border-t border-border px-5 py-4">
            <Button title="Cancel" variant="secondary" onPress={onCancel} />
            <Button
              title="Mark as transfer"
              onPress={() => onConfirm(note.trim() || null)}
              loading={submitting}
              disabled={blocked}
            />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
