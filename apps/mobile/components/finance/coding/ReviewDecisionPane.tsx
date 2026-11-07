/**
 * ONE CODING, READ AND DECIDED IN ONE PLACE.
 *
 * Dev2, 2026-11-07, on the review queue reached from the "Codings need your
 * review" email: "UX for this is awful especially on mobile." It was. The row
 * was a five-column table whose Approve / Send back cell sat past the right
 * edge of a phone, so on mobile you could open a record and never act on it.
 *
 * This pane is the fix's centre. It holds the summary, the whole record
 * (`ReviewRecord`, unchanged) and the decision, with the decision PINNED to
 * the bottom so it is always on screen however long the record runs. The
 * same pane renders in two frames (`ReviewQueue` picks):
 *
 *  - a phone: a full-screen sheet over the queue (the app's floating dock is
 *    behind it, so nothing covers the buttons);
 *  - a wide screen: the right half of a list | record split.
 *
 * Deciding moves on. `ReviewQueue` owns which row is open and advances to
 * the next one when this row leaves the queue, and owns the Undo bar, because
 * the row an Undo is for is no longer the row on screen.
 *
 * What did NOT change: separation of duties (a row you can't decide says why
 * instead of offering buttons), no budget no approve (the reason sits by the
 * disabled button, and the record opens its edit panel for it), and every
 * mutation is the same one the old row called.
 */
import { useEffect, useState, type MutableRefObject, type ReactNode } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { ATTENDEE_AFFILIATION_LABELS } from "@events-os/shared";
import { Button, Icon, TextField } from "../../ui";
import { colors } from "../../../lib/theme";
import {
  applySendBackReason,
  daysWaiting,
  SEND_BACK_REASONS,
  substantiationLine,
} from "./queueDisplay";
import { PublicPurposeEditor, PublicPurposeNotice } from "./PublicPurposeEditor";
import { ReviewRecord } from "./ReviewRecord";
import {
  DOCUMENTATION_DISPLAY,
  money,
  shortDate,
  type ReviewQueueRow,
  type RunAction,
} from "./reviewQueueShared";

export type Decision = "approved" | "sent_back";

export function ReviewDecisionPane({
  row,
  runAction,
  position,
  onPrev,
  onNext,
  onClose,
  onDecided,
  banner,
  sendingBack,
  onSendingBackChange,
  approveRef,
}: {
  row: ReviewQueueRow;
  runAction: RunAction;
  position: { index: number; total: number } | null;
  onPrev: (() => void) | null;
  onNext: (() => void) | null;
  /** Phone frame only: back to the list. */
  onClose?: () => void;
  onDecided: (decision: Decision, row: ReviewQueueRow) => void;
  /** The Undo bar, when the previous decision can still be taken back. */
  banner?: ReactNode;
  /** Lifted so the wide screen's `S` shortcut can open the note. */
  sendingBack: boolean;
  onSendingBackChange: (open: boolean) => void;
  /** Set each render to this row's approve, for the wide screen's `A` key. */
  approveRef?: MutableRefObject<(() => void) | null>;
}) {
  const approve = useMutation(api.transactionCodings.approve);
  const requestChanges = useMutation(api.transactionCodings.requestChanges);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  const doc = DOCUMENTATION_DISPLAY[row.documentation];
  const substantiation = substantiationLine(row.coding, ATTENDEE_AFFILIATION_LABELS);
  const waited = daysWaiting(row.coding.submittedAt);
  const meta = [
    row.book.name,
    row.coding.codedByName,
    `posted ${shortDate(row.postedAt)}`,
    waited > 0 ? `waiting ${waited} day${waited === 1 ? "" : "s"}` : "submitted today",
  ]
    .filter(Boolean)
    .join(" · ");

  async function decide(decision: Decision, fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      const ok = await runAction(
        async () => {
          await fn();
          return true;
        },
        { errorTitle: "Couldn't record that decision" },
      );
      if (ok === true) {
        setNote("");
        onSendingBackChange(false);
        onDecided(decision, row);
      }
    } finally {
      setBusy(false);
    }
  }

  const doApprove = () =>
    void decide("approved", () =>
      approve({ transactionId: row.transactionId as Id<"transactions"> }),
    );
  useEffect(() => {
    if (!approveRef) return;
    approveRef.current = row.canReview && !busy ? doApprove : null;
    return () => {
      approveRef.current = null;
    };
  });
  const doSendBack = () =>
    void decide("sent_back", () =>
      requestChanges({
        transactionId: row.transactionId as Id<"transactions">,
        reviewNote: note.trim(),
      }),
    );

  return (
    <View className="min-h-0 flex-1 bg-raised">
      {/* ── header: back, position, prev / next ───────────────────────── */}
      <View className="flex-row items-center gap-1 border-b border-border px-2 py-1.5">
        {onClose ? (
          <Pressable
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Back to the queue"
            className="flex-row items-center gap-1 rounded-md px-2 py-2.5"
          >
            <Icon name="chevron-left" size={20} color={colors.ink} />
            <Text className="text-base font-semibold text-ink">Queue</Text>
          </Pressable>
        ) : null}
        <Text className="flex-1 px-2 text-sm text-muted" numberOfLines={1}>
          {position ? `${position.index} of ${position.total}` : ""}
        </Text>
        <NavButton icon="chevron-up" label="Previous coding" onPress={onPrev} />
        <NavButton icon="chevron-down" label="Next coding" onPress={onNext} />
      </View>

      <ScrollView
        className="min-h-0 flex-1"
        contentContainerStyle={{ padding: 16, paddingBottom: 24, gap: 16 }}
        keyboardShouldPersistTaps="handled"
      >
        {/* ── the charge, in one glance ───────────────────────────────── */}
        <View className="gap-0.5">
          <Text className="text-xs font-semibold uppercase tracking-wide text-muted" numberOfLines={1}>
            {row.merchantName ?? "Charge"}
          </Text>
          <Text className="font-display text-3xl text-ink">{money(row.amountCents)}</Text>
          <Text className="text-sm text-muted">{meta}</Text>
          <View className="mt-2 flex-row flex-wrap gap-1.5">
            <Chip icon={doc.icon} color={doc.color} label={doc.label} />
            <Chip icon="tag" color={colors.muted} label={row.coding.expenseTypeLabel} />
          </View>
        </View>

        {/* ── the claim being judged ──────────────────────────────────── */}
        <View className="gap-2 rounded-lg border border-border bg-surface p-4">
          <Text className="text-2xs font-semibold uppercase tracking-wide text-muted">
            Their purpose
          </Text>
          <Text className="text-base leading-6 text-ink">{row.coding.businessPurpose}</Text>
          {substantiation ? (
            <Text className="text-sm text-muted">{substantiation}</Text>
          ) : null}
          {row.canReview ? (
            <PublicPurposeEditor
              transactionId={row.transactionId}
              state={row.coding}
              runAction={runAction}
            />
          ) : (
            <PublicPurposeNotice state={row.coding} />
          )}
        </View>

        {/* ── the whole record: proof, fields, charge, trail ──────────── */}
        <ReviewRecord key={row.transactionId} transactionId={row.transactionId} runAction={runAction} />
      </ScrollView>

      {banner}

      {/* ── the decision, always on screen ────────────────────────────── */}
      <View className="gap-2 border-t border-border bg-raised px-4 pb-4 pt-3">
        {!row.canReview ? (
          <Text className="py-2 text-center text-sm italic text-muted">
            Yours — another reviewer decides it.
          </Text>
        ) : sendingBack ? (
          <>
            <Text className="text-sm font-semibold text-ink">
              Send back{row.coding.codedByName ? ` to ${row.coding.codedByName}` : ""}
            </Text>
            <View className="flex-row flex-wrap gap-1.5">
              {SEND_BACK_REASONS.map((r) => (
                <Pressable
                  key={r.label}
                  onPress={() => setNote((n) => applySendBackReason(n, r.note))}
                  accessibilityRole="button"
                  className="rounded-pill border border-border-strong bg-raised px-3 py-1.5"
                >
                  <Text className="text-xs font-medium text-ink">{r.label}</Text>
                </Pressable>
              ))}
            </View>
            <TextField
              label="What would make it approvable?"
              value={note}
              onChangeText={setNote}
              placeholder="They get an email with this note."
              multiline
              numberOfLines={3}
            />
            <View className="flex-row gap-2">
              <View className="flex-1">
                <Button
                  title="Cancel"
                  variant="secondary"
                  onPress={() => {
                    onSendingBackChange(false);
                    setNote("");
                  }}
                  className="w-full"
                />
              </View>
              <View className="flex-1">
                <Button
                  title="Send back"
                  loading={busy}
                  disabled={note.trim() === ""}
                  onPress={doSendBack}
                  className="w-full"
                />
              </View>
            </View>
          </>
        ) : (
          <>
            {row.budgetRequired ? (
              <Text className="text-center text-xs text-warn">
                Needs a budget before it can be approved. Set it in the record above.
              </Text>
            ) : null}
            <View className="flex-row gap-2">
              <View className="flex-1">
                <Button
                  title="Send back"
                  variant="secondary"
                  icon="corner-up-left"
                  onPress={() => onSendingBackChange(true)}
                  className="w-full"
                />
              </View>
              <View className="flex-1">
                <Button
                  title="Approve"
                  icon="check"
                  loading={busy}
                  disabled={row.budgetRequired}
                  onPress={doApprove}
                  className="w-full"
                />
              </View>
            </View>
          </>
        )}
      </View>
    </View>
  );
}

function NavButton({
  icon,
  label,
  onPress,
}: {
  icon: "chevron-up" | "chevron-down";
  label: string;
  onPress: (() => void) | null;
}) {
  return (
    <Pressable
      onPress={onPress ?? undefined}
      disabled={onPress == null}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: onPress == null }}
      className="rounded-md p-2.5"
    >
      <Icon name={icon} size={20} color={onPress ? colors.ink : colors.faint} />
    </Pressable>
  );
}

function Chip({
  icon,
  color,
  label,
}: {
  icon: "paperclip" | "file-text" | "clock" | "alert-triangle" | "tag";
  color: string;
  label: string;
}) {
  return (
    <View className="flex-row items-center gap-1 rounded-pill bg-sunken px-2 py-1">
      <Icon name={icon} size={12} color={color} />
      <Text className="text-2xs font-semibold text-ink">{label}</Text>
    </View>
  );
}
