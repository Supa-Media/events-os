/**
 * MarkPayoutModal — the processor picker + confirm step for
 * `finances.markAsPayout`.
 *
 * Single-sided, unlike `MarkTransferModal` (founder: "payouts have no other
 * leg to mark"). Givebutter/Stripe donations are recorded in `gifts`, never in
 * the transaction ledger, so the settlement deposit is the ONLY ledger record
 * of that income — there's nothing to pair it against and nothing to
 * double-count.
 *
 * That's also why the copy below says "stays in your income": marking a payout
 * is a LABEL, not a reclassification. Anyone reading this modal should come
 * away knowing it did NOT do what "mark as transfer" does — treating a payout
 * as a transfer would delete the org's revenue from every total. See
 * `PAYOUT_PROCESSORS` (`@events-os/shared`) for the full reasoning.
 */
import { useState } from "react";
import { Modal, Pressable, Text, View } from "react-native";
import { useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import {
  CENTRAL,
  PAYOUT_PROCESSORS,
  PAYOUT_PROCESSOR_LABELS,
  type PayoutProcessor,
} from "@events-os/shared";
import { Button, Icon } from "../../ui";
import { colors } from "../../../lib/theme";

/** The "whose money is this?" choice: keep = label only (money stays on the
 *  book it landed in); otherwise the stated book gets a whole-deposit
 *  allocation transfer (`finances.markAsPayout`'s `allocateToScope`). */
export type PayoutAllocationChoice =
  | { kind: "keep" }
  | { kind: "scope"; scope: Id<"chapters"> | typeof CENTRAL; label: string };

export function MarkPayoutModal({
  count,
  onConfirm,
  onCancel,
  submitting,
}: {
  /** How many selected rows this will label (the bulk bar allows more than
   *  one — a month of payouts from the same processor is one action). */
  count: number;
  onConfirm: (
    processor: PayoutProcessor,
    allocation: PayoutAllocationChoice,
  ) => void;
  onCancel: () => void;
  submitting?: boolean;
}) {
  const [processor, setProcessor] = useState<PayoutProcessor>("givebutter");
  const [allocation, setAllocation] = useState<PayoutAllocationChoice>({
    kind: "keep",
  });
  // Central-reach callers get the chapter list; a chapter-only treasurer gets
  // [] and sees only "Central" as an allocation target (their Givebutter
  // deposit may still be central's money).
  const chapters = useQuery(api.financeRoles.listChaptersForPeek, {}) ?? [];

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
              Mark as processor payout
            </Text>
            <Pressable onPress={onCancel} hitSlop={8} className="rounded-md p-1">
              <Icon name="x" size={18} color={colors.muted} />
            </Pressable>
          </View>

          <View className="gap-3 px-5 py-4">
            <Text className="text-xs text-muted">
              A settlement deposit — the processor paying out the donations it
              collected. This labels where the money came from; it stays in your
              income (it&apos;s real revenue, not money moving between your own
              accounts) and will still be asked for a settlement report.
            </Text>

            <View className="gap-1.5">
              <Text className="text-[11px] font-semibold uppercase tracking-wide text-faint">
                Where from
              </Text>
              <View className="flex-row flex-wrap gap-2">
                {PAYOUT_PROCESSORS.map((p) => {
                  const active = p === processor;
                  return (
                    <Pressable
                      key={p}
                      onPress={() => setProcessor(p)}
                      accessibilityRole="radio"
                      accessibilityState={{ selected: active }}
                      className={`rounded-full border px-3 py-1.5 active:opacity-70 ${
                        active
                          ? "border-accent bg-accent-soft"
                          : "border-border bg-raised"
                      }`}
                    >
                      <Text
                        className={`text-xs ${active ? "font-semibold text-accent" : "text-muted"}`}
                      >
                        {PAYOUT_PROCESSOR_LABELS[p]}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>

            <View className="gap-1.5">
              <Text className="text-[11px] font-semibold uppercase tracking-wide text-faint">
                Whose money is this?
              </Text>
              <Text className="text-2xs text-muted">
                Some payouts belong to a different book than the account they
                landed in. Picking a book records the transfer for you — it
                shows on the Accounts page, badged and flaggable. Changing it
                later takes an offsetting transfer.
              </Text>
              <View className="flex-row flex-wrap gap-2">
                {(
                  [
                    { key: "keep", label: "Leave where it landed", choice: { kind: "keep" } as PayoutAllocationChoice },
                    { key: "central", label: "Central", choice: { kind: "scope", scope: CENTRAL, label: "Central" } as PayoutAllocationChoice },
                    ...chapters.map((c) => ({
                      key: String(c.chapterId),
                      label: c.name,
                      choice: { kind: "scope", scope: c.chapterId, label: c.name } as PayoutAllocationChoice,
                    })),
                  ] as { key: string; label: string; choice: PayoutAllocationChoice }[]
                ).map((opt) => {
                  const active =
                    allocation.kind === "keep"
                      ? opt.choice.kind === "keep"
                      : opt.choice.kind === "scope" &&
                        opt.choice.scope === allocation.scope;
                  return (
                    <Pressable
                      key={opt.key}
                      onPress={() => setAllocation(opt.choice)}
                      accessibilityRole="radio"
                      accessibilityState={{ selected: active }}
                      className={`rounded-full border px-3 py-1.5 active:opacity-70 ${
                        active
                          ? "border-accent bg-accent-soft"
                          : "border-border bg-raised"
                      }`}
                    >
                      <Text
                        className={`text-xs ${active ? "font-semibold text-accent" : "text-muted"}`}
                      >
                        {opt.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
          </View>

          <View className="flex-row justify-end gap-2 border-t border-border px-5 py-4">
            <Button title="Cancel" variant="secondary" onPress={onCancel} />
            <Button
              title={count > 1 ? `Mark ${count} payouts` : "Mark as payout"}
              onPress={() => onConfirm(processor, allocation)}
              loading={submitting}
            />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
