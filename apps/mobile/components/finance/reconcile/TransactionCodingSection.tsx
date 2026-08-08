/**
 * TransactionCodingSection — the substantiation panel on a transaction: what
 * this charge was, why it served the org's work, who was involved, and where
 * that record sits in review. See `docs/plans/transaction-coding.md`.
 *
 * Three affordances, each gated server-side by its own resolver
 * (`lib/transactionCodingAccess.ts`) — this component only decides what to
 * SHOW, never what's allowed:
 *  - code / revise-and-resubmit (the transaction's own person, or
 *    bookkeeper+ — a bookkeeper may code on someone's behalf and the audit
 *    log shows who typed),
 *  - approve (a Finance manager who is NOT the author — every coding, no
 *    dollar threshold),
 *  - send back with a note ("receipt must show exact amount").
 *
 * Attendee names render only for callers the server projected them to
 * (`hasCodingNamesView`); everyone else sees the affiliation breakdown, which
 * is also all the public ledger will ever show.
 */
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useMutation, useQuery } from "convex/react";
import {
  ATTENDEE_AFFILIATION_LABELS,
  type AttendeeAffiliation,
} from "@events-os/shared";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { Badge, Button, TextField, type BadgeTone } from "../../ui";
import {
  TransactionCodingModal,
  type CodingFormValue,
} from "../modals/TransactionCodingModal";

const STATUS_TONE: Record<string, BadgeTone> = {
  submitted: "warn",
  changes_requested: "danger",
  approved: "success",
};

function when(ts: number): string {
  return new Date(ts).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "America/New_York",
  });
}

/** "5 volunteers, 3 community members, 2 contractors" — the redacted (and
 *  public) rendering of who was there. */
function breakdownLine(breakdown: Record<string, number>): string {
  const parts = Object.entries(breakdown).map(([affiliation, count]) => {
    const label =
      ATTENDEE_AFFILIATION_LABELS[affiliation as AttendeeAffiliation] ??
      affiliation;
    return `${count} ${label.toLowerCase()}${count === 1 ? "" : "s"}`;
  });
  return parts.join(", ");
}

export function TransactionCodingSection({
  transactionId,
  merchantLine,
  amountCents,
  readOnly,
  onError,
}: {
  transactionId: Id<"transactions">;
  /** Context line for the editor header — merchant + date. */
  merchantLine: string;
  amountCents: number;
  /** Peek / below-bookkeeper: the record stays visible, actions don't. */
  readOnly: boolean;
  onError: (err: unknown) => void;
}) {
  const data = useQuery(api.transactionCodings.getForTransaction, {
    transactionId,
  });
  const submit = useMutation(api.transactionCodings.submit);
  const approve = useMutation(api.transactionCodings.approve);
  const requestChanges = useMutation(api.transactionCodings.requestChanges);

  const [editing, setEditing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [sendingBack, setSendingBack] = useState(false);
  const [sendBackNote, setSendBackNote] = useState("");

  // FORBIDDEN (a caller who may not even read here) surfaces as undefined,
  // same as loading — render nothing either way (matches the exception
  // section's posture).
  if (data === undefined) return null;
  const { coding, requiresCoding, namesMaxHeadcount, minPurposeLength } = data;

  async function run(fn: () => Promise<unknown>) {
    setSubmitting(true);
    try {
      await fn();
    } catch (err) {
      onError(err);
    } finally {
      setSubmitting(false);
    }
  }

  const breakdown = coding ? breakdownLine(coding.affiliationBreakdown) : "";

  return (
    <View>
      <View className="mb-1.5 flex-row items-center justify-between">
        <Text className="text-2xs font-semibold uppercase tracking-wide text-muted">
          Coding
        </Text>
        {!readOnly && coding == null ? (
          <Pressable
            onPress={() => setEditing(true)}
            accessibilityRole="button"
            className="active:opacity-70"
          >
            <Text className="text-xs font-medium text-accent">
              Code this charge
            </Text>
          </Pressable>
        ) : null}
      </View>

      {coding == null ? (
        <Text className="text-xs text-muted">
          {requiresCoding
            ? "Uncoded. This charge can't be reconciled until what it was for — and who was involved — is on the record and approved."
            : "Uncoded. Not required for this row, but any spend can carry one."}
        </Text>
      ) : (
        <View className="rounded-lg border border-border bg-sunken px-3 py-2.5">
          <View className="mb-1 flex-row items-center gap-2">
            <Badge
              label={coding.statusLabel}
              tone={STATUS_TONE[coding.status] ?? "neutral"}
            />
            <Text className="text-xs font-medium text-ink">
              {coding.expenseTypeLabel}
            </Text>
          </View>

          <Text className="text-xs text-ink">{coding.businessPurpose}</Text>

          {coding.travelFrom || coding.travelTo ? (
            <Text className="mt-1 text-2xs text-muted">
              Route: {coding.travelFrom ?? "—"} → {coding.travelTo ?? "—"}
            </Text>
          ) : null}

          {coding.headcount != null ? (
            <Text className="mt-1 text-2xs text-muted">
              {coding.headcount} {coding.headcount === 1 ? "person" : "people"}
              {breakdown ? ` — ${breakdown}` : ""}
              {coding.groupDescription ? ` — ${coding.groupDescription}` : ""}
            </Text>
          ) : null}

          {coding.attendees != null && coding.attendees.length > 0 ? (
            <Text className="mt-1 text-2xs text-muted">
              {coding.attendees
                .map(
                  (a) =>
                    `${a.name} (${ATTENDEE_AFFILIATION_LABELS[a.affiliation as AttendeeAffiliation].toLowerCase()})`,
                )
                .join(", ")}{" "}
              — names stay internal; only the breakdown publishes.
            </Text>
          ) : null}

          <Text className="mt-1 text-2xs text-muted">
            Coded by {coding.codedByName ?? "someone no longer on the roster"} ·{" "}
            {when(coding.submittedAt)}
            {coding.decidedAt != null
              ? ` · decided by ${coding.decidedByName ?? "—"} · ${when(coding.decidedAt)}`
              : ""}
          </Text>

          {coding.reviewNote ? (
            <Text className="mt-1 text-2xs italic text-danger">
              Sent back: “{coding.reviewNote}”
            </Text>
          ) : null}

          {!readOnly ? (
            <View className="mt-2 flex-row flex-wrap gap-2">
              {coding.status === "submitted" ? (
                <Button
                  title="Approve"
                  onPress={() => void run(() => approve({ transactionId }))}
                  loading={submitting}
                />
              ) : null}
              {coding.status !== "changes_requested" ? (
                <Button
                  title={coding.status === "approved" ? "Reopen" : "Send back"}
                  variant="secondary"
                  onPress={() => {
                    setSendingBack(true);
                    setSendBackNote("");
                  }}
                />
              ) : null}
              {coding.status !== "approved" ? (
                <Button
                  title={
                    coding.status === "changes_requested"
                      ? "Edit and resubmit"
                      : "Edit"
                  }
                  variant="secondary"
                  onPress={() => setEditing(true)}
                />
              ) : null}
            </View>
          ) : null}

          {sendingBack ? (
            <View className="mt-2 gap-2">
              <TextField
                value={sendBackNote}
                onChangeText={setSendBackNote}
                placeholder='What would make it approvable? e.g. "Receipt must show exact amount"'
                multiline
                numberOfLines={2}
                autoFocus
              />
              <View className="flex-row gap-2">
                <Button
                  title="Send back"
                  onPress={() =>
                    void run(async () => {
                      await requestChanges({
                        transactionId,
                        reviewNote: sendBackNote.trim(),
                      });
                      setSendingBack(false);
                    })
                  }
                  disabled={!sendBackNote.trim()}
                  loading={submitting}
                />
                <Button
                  title="Cancel"
                  variant="secondary"
                  onPress={() => setSendingBack(false)}
                />
              </View>
            </View>
          ) : null}
        </View>
      )}

      {editing ? (
        <TransactionCodingModal
          merchantLine={merchantLine}
          amountCents={amountCents}
          namesMaxHeadcount={namesMaxHeadcount}
          minPurposeLength={minPurposeLength}
          // A revision is a conversation: the note that sent it back belongs
          // next to the fields it's about, not one panel away behind the
          // editor that's covering it.
          reviewNote={
            coding?.status === "changes_requested" ? coding.reviewNote : null
          }
          submitLabel={
            coding?.status === "changes_requested"
              ? "Resubmit for review"
              : "Submit for review"
          }
          initial={
            coding
              ? {
                  expenseType: coding.expenseType,
                  businessPurpose: coding.businessPurpose,
                  ...(coding.travelFrom != null
                    ? { travelFrom: coding.travelFrom }
                    : {}),
                  ...(coding.travelTo != null
                    ? { travelTo: coding.travelTo }
                    : {}),
                  ...(coding.headcount != null
                    ? { headcount: coding.headcount }
                    : {}),
                  ...(coding.attendees != null
                    ? {
                        attendees: coding.attendees.map((a) => ({
                          name: a.name,
                          affiliation: a.affiliation as AttendeeAffiliation,
                        })),
                      }
                    : {}),
                  ...(coding.groupDescription != null
                    ? { groupDescription: coding.groupDescription }
                    : {}),
                }
              : null
          }
          submitting={submitting}
          onCancel={() => setEditing(false)}
          onConfirm={(value: CodingFormValue) =>
            void run(async () => {
              await submit({ transactionId, ...value });
              setEditing(false);
            })
          }
        />
      ) : null}
    </View>
  );
}
