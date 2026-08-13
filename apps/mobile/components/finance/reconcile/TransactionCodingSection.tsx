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
 *
 * THE SAME DOCUMENTATION GATE AS THE CARDHOLDER'S SHEET. `submitCoding`
 * refuses a coding on a charge that can't prove itself
 * (`DOCUMENTATION_REQUIRED`), and a bookkeeper coding on someone's behalf hits
 * it identically — so the editor launched from here carries the same
 * `CodingDocumentation` slot (attach, confirm a suggested receipt, or file
 * "there is no receipt"), and this panel says the requirement out loud before
 * anybody opens the editor.
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
import { Badge, Button, Icon, TextField, type BadgeTone } from "../../ui";
import { colors } from "../../../lib/theme";
import {
  PublicPurposeEditor,
  PublicPurposeNotice,
} from "../coding/PublicPurposeEditor";
import {
  TransactionCodingModal,
  type CodingFormValue,
} from "../modals/TransactionCodingModal";
// Lives under `myTransactions/` because that's where it was first needed, but
// it is deliberately host-agnostic — the receipt half of a coding is the same
// three affordances wherever coding happens.
import { CodingDocumentation } from "../myTransactions/CodingDocumentation";
// "5 volunteers, 3 community members, 2 contractors" — the redacted (and
// public) rendering of who was there. Shared with the Coding tab's review
// queue (`coding/queueDisplay.ts`) so the two never drift apart.
import { breakdownLine } from "../coding/queueDisplay";

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
  const {
    coding,
    requiresCoding,
    hasDocumentation,
    canReview,
    namesMaxHeadcount,
    minPurposeLength,
    categoryName,
    categoryExpenseTypeHint,
    reimbursementContext,
    priorCoding,
  } = data;
  // The chip row's category context — `null` (not `undefined`) when the
  // charge is simply uncategorized, so the chips still get the "nothing
  // picks it for you" copy rather than the "no category context at all"
  // wording (see `CodingCategoryContext`).
  const category = categoryName ? { name: categoryName, expenseTypeHint: categoryExpenseTypeHint } : null;

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

  const breakdown = coding
    ? breakdownLine(coding.affiliationBreakdown, ATTENDEE_AFFILIATION_LABELS)
    : "";

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
        <View>
          <Text className="text-xs text-muted">
            {requiresCoding
              ? "Uncoded. This charge can't be reconciled until what it was for — and who was involved — is on the record and approved."
              : "Uncoded. Not required for this row, but any spend can carry one."}
          </Text>
          {/* SAID BEFORE THE EDITOR OPENS, not after somebody types into it.
              The submit gate wants documentation too, and a bookkeeper coding
              on someone's behalf is refused exactly as the cardholder is. */}
          {!hasDocumentation ? (
            <View className="mt-1 flex-row items-start gap-2">
              <Icon name="alert-triangle" size={12} color={colors.warn} />
              <Text className="flex-1 text-2xs text-muted">
                It has no receipt and no filed exception either — a coding
                can&apos;t be submitted without one. Both halves go in the same
                editor.
              </Text>
            </View>
          ) : null}
        </View>
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

          {/* The redaction pass, for whoever may decide this row — the same
              control the Coding tab's queue carries, so an approver who
              reaches a coding from Reconcile isn't offered less. */}
          {canReview ? (
            <PublicPurposeEditor
              transactionId={transactionId}
              state={coding}
              runAction={async (action) => {
                try {
                  return await action();
                } catch (err) {
                  onError(err);
                  return undefined;
                }
              }}
            />
          ) : (
            <PublicPurposeNotice state={coding} />
          )}

          {/* FINDING 2 (UX audit, 2026-08-12): lodging is ONE place, not a
              route — "Route: — → Chicago" would misread a stay as a
              half-known trip. */}
          {coding.expenseType === "lodging" ? (
            coding.travelTo ? (
              <Text className="mt-1 text-2xs text-muted">
                Stayed in {coding.travelTo}
              </Text>
            ) : null
          ) : coding.travelFrom || coding.travelTo ? (
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

          {coding.portedFromReimbursementId ? (
            <Text className="mt-1 text-2xs text-muted">
              Ported from reimbursement request — the claimant's own approved
              answers.
            </Text>
          ) : null}

          {coding.reviewNote ? (
            <Text className="mt-1 text-2xs italic text-danger">
              Sent back: “{coding.reviewNote}”
            </Text>
          ) : null}

          {/* DECIDING and AUTHORING are different powers, and used to share one
              gate. `readOnly` is a bookkeeper-or-better flag; Approve and Send
              back need finance MANAGER plus separation of duties (you cannot
              approve your own testimony). So a bookkeeper — or a manager
              looking at a coding they wrote themselves — was shown a working
              Approve button that threw FORBIDDEN on every press. `canReview`
              comes from the server, computed by the same resolver and the same
              SoD rule the mutation enforces, so the button can no longer
              promise something the backend will refuse. */}
          {!readOnly ? (
            <View className="mt-2 flex-row flex-wrap gap-2">
              {canReview && coding.status === "submitted" ? (
                <Button
                  title="Approve"
                  onPress={() => void run(() => approve({ transactionId }))}
                  loading={submitting}
                />
              ) : null}
              {canReview && coding.status !== "changes_requested" ? (
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

          {/* Say WHY there are no decide buttons, but only to someone who could
              plausibly expect them — the author of a coding that's sitting in
              review. Silence there reads as "nothing is happening"; everyone
              else would just be told about a power they never had. */}
          {!readOnly && !canReview && coding.status === "submitted" ? (
            <Text className="mt-2 text-2xs text-muted">
              Waiting on a Finance manager. Approving your own coding isn&apos;t
              something you can do — a second person is the point.
            </Text>
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
          transactionId={transactionId}
          merchantLine={merchantLine}
          amountCents={amountCents}
          namesMaxHeadcount={namesMaxHeadcount}
          minPurposeLength={minPurposeLength}
          // The receipt requirement, and the ways out of it, inside the
          // editor. `detail` is deliberately omitted here: this panel is
          // handed the transaction id and nothing about its receipt, so the
          // block says what it knows for certain (`hasDocumentation`) rather
          // than guessing which of a receipt or an exception documents it.
          hasDocumentation={hasDocumentation}
          reimbursementContext={reimbursementContext}
          priorCoding={priorCoding}
          documentationSlot={
            <CodingDocumentation
              transactionId={transactionId}
              amountCents={amountCents}
              hasDocumentation={hasDocumentation}
              runAction={(fn) => run(fn)}
              busy={submitting}
            />
          }
          category={category}
          // The budget Reconcile's "For" picker already set — the picker
          // opens on the existing answer instead of re-asking (founder,
          // 2026-08-12; same column, `transactions.budgetId`).
          initialBudgetId={data.currentBudgetId}
          // A revision is a conversation: the note that sent it back belongs
          // next to the fields it's about, not one panel away behind the
          // editor that's covering it.
          reviewNote={
            coding?.status === "changes_requested" ? coding.reviewNote : null
          }
          // "Submit & approve": one tap is both decisions when the server's
          // `canSelfApprove` allows single-party deciding (founder,
          // 2026-08-12; recorded as `approvalParty: "single"` server-side).
          submitLabel={
            coding?.status === "changes_requested"
              ? data.canSelfApprove
                ? "Resubmit & approve"
                : "Resubmit for review"
              : data.canSelfApprove
                ? "Submit & approve"
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
          onConfirm={({ budgetId, ...value }: CodingFormValue) =>
            void run(async () => {
              await submit({
                transactionId,
                ...value,
                ...(budgetId ? { budgetId: budgetId as Id<"budgets"> } : {}),
              });
              // The approve half of "Submit & approve" — same one-tap rule
              // as `FinishChargeSheetBody.submitBoth`, same server gate.
              if (data.canSelfApprove) {
                await approve({ transactionId });
              }
              setEditing(false);
            })
          }
        />
      ) : null}
    </View>
  );
}
