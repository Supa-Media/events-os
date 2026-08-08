/**
 * FinishChargeSheet — everything one charge still needs, in one place.
 *
 * The owner ask (2026-08-08): a cardholder who gets the "you have 3 charges to
 * code" email should be able to finish all three without leaving the screen
 * and without a finance role. So this sheet carries the whole job in the order
 * a person actually does it:
 *
 *   1. What the reviewer said, if they sent it back — first, biggest, and
 *      quoted verbatim. It is the only thing on this screen that already
 *      tells them exactly what to do.
 *   2. The substantiation record (`TransactionCodingModal` — the same editor
 *      the treasurer uses in Reconcile, not a second one that could drift).
 *   3. The receipt: the same `ReceiptCell` upload affordance as everywhere
 *      else, an amount check at attach time, and — when no receipt exists —
 *      the existing `ReceiptExceptionModal`, verbatim. Nothing new to build:
 *      the ask ("proof you bought the thing, why there's no receipt") IS
 *      `receiptExceptions`; this just puts it in the cardholder's path
 *      instead of the treasurer's.
 *   4. The optional extras the member could already set (category, a note for
 *      the finance team, "this was personal") — kept, but demoted below the
 *      things the accountable plan actually requires.
 *
 * NOTHING IS PRE-FILLED (owner decision, 2026-08-08: no AI anywhere in
 * coding). Merchant, amount and date are shown as context because a person
 * can't substantiate what they can't see — but every answer is typed by the
 * human whose testimony it is.
 */
import { useState } from "react";
import { Modal, Pressable, ScrollView, Text, View } from "react-native";
import { useMutation, useQuery } from "convex/react";
import {
  ATTENDEE_AFFILIATION_LABELS,
  displayMerchantName,
  documentationState,
  formatCents,
  type AttendeeAffiliation,
  type ReceiptExceptionReason,
} from "@events-os/shared";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import {
  Badge,
  Button,
  Icon,
  Select,
  TextField,
  ToastView,
  type BadgeTone,
} from "../../ui";
import { colors } from "../../../lib/theme";
import { useActionRunner } from "../../../lib/useActionToast";
import { ReceiptCell } from "../reconcile/ReconcileList";
import { ReceiptExceptionModal } from "../modals/ReceiptExceptionModal";
import {
  TransactionCodingModal,
  type CodingFormValue,
} from "../modals/TransactionCodingModal";
import { parseAmountToCents, receiptAmountMismatch } from "./receiptAmountCheck";
import type { MyTxnRow } from "./chargeTodo";

const CODING_TONE: Record<string, BadgeTone> = {
  submitted: "warn",
  changes_requested: "danger",
  approved: "success",
};

/** `YYYY-MM-DD` in the finance timezone (the screen's own `dateStr`). */
function dateStr(ts: number): string {
  return new Date(ts).toLocaleDateString("en-CA", {
    timeZone: "America/New_York",
  });
}

/** A step's heading — a number, a title, and a done/outstanding marker, so
 *  "what's left" is readable at a glance instead of inferred from which
 *  buttons happen to be enabled. */
function StepHeader({
  index,
  title,
  done,
  hint,
}: {
  index: number;
  title: string;
  done: boolean;
  hint?: string;
}) {
  return (
    <View className="mb-1.5">
      <View className="flex-row items-center gap-2">
        <View
          className={`h-5 w-5 items-center justify-center rounded-full ${
            done ? "bg-success-bg" : "bg-sunken"
          }`}
        >
          {done ? (
            <Icon name="check" size={12} color={colors.success} />
          ) : (
            <Text className="text-2xs font-bold text-muted">{index}</Text>
          )}
        </View>
        <Text className="text-2xs font-semibold uppercase tracking-wide text-muted">
          {title}
        </Text>
      </View>
      {hint ? <Text className="mt-1 text-2xs text-muted">{hint}</Text> : null}
    </View>
  );
}

export function FinishChargeSheet({
  txn,
  categoryOptions,
  onClose,
}: {
  txn: MyTxnRow;
  categoryOptions: { value: string; label: string }[];
  onClose: () => void;
}) {
  const transactionId = txn.id as Id<"transactions">;
  const data = useQuery(api.transactionCodings.getForTransaction, {
    transactionId,
  });
  const exceptions = useQuery(
    api.receiptExceptions.listForTransaction,
    txn.hasReceipt ? "skip" : { transactionId },
  );
  const submitCoding = useMutation(api.transactionCodings.submit);
  const attestException = useMutation(api.receiptExceptions.attest);
  const attachReceipt = useMutation(api.finances.attachReceipt);
  const generateUploadUrl = useMutation(api.storage.generateUploadUrl);
  const submitOwnCharge = useMutation(api.finances.submitOwnCharge);
  const { run, toast, dismiss } = useActionRunner();

  const [editing, setEditing] = useState(false);
  const [filing, setFiling] = useState(false);
  const [busy, setBusy] = useState(false);
  // The attach-time amount check (see `receiptAmountCheck.ts` for why the
  // human types the number instead of OCR handing it to us).
  const [receiptTotal, setReceiptTotal] = useState("");
  const [catDraft, setCatDraft] = useState<string | null>(txn.categoryId);
  const [noteDraft, setNoteDraft] = useState(txn.note ?? "");
  const [personalDraft, setPersonalDraft] = useState(txn.isPersonal);

  const coding = data?.coding ?? null;
  const pendingException =
    exceptions?.find((e) => e.status === "pending") ?? null;
  const approvedException =
    exceptions?.find((e) => e.status === "approved") ?? null;
  // The step's done/not-done marker comes off the ROW (`hasReceipt` +
  // `hasApprovedException`, both denormalized) so it's right on first paint;
  // the exception list is only read for the reason label and the "filed but
  // not decided" wording, which nobody needs until this sheet is open.
  const documented =
    documentationState(txn.hasReceipt, txn.hasApprovedException) !==
    "undocumented";
  const merchantLine = `${displayMerchantName(txn, "—")} · ${dateStr(txn.postedAt)}`;
  // A person-attributed txn only ever gets `cardId` + `cardLast4` together, so
  // this is the reliable "the cardholder can self-service this" signal
  // (`submitOwnCharge` / `flagPersonalCharge` both refuse a non-card txn).
  const isCardCharge = txn.cardLast4 != null;

  const receiptCents = parseAmountToCents(receiptTotal);
  const mismatch =
    receiptCents == null
      ? null
      : receiptAmountMismatch(receiptCents, txn.amountCents);

  async function guard(fn: () => Promise<unknown>, errorTitle: string) {
    setBusy(true);
    const res = await run(fn, { errorTitle });
    setBusy(false);
    return res;
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
          <View className="flex-row items-start justify-between border-b border-border px-5 py-4">
            <View className="flex-1 pr-3">
              <Text className="font-display text-lg text-ink">
                Finish this charge
              </Text>
              <Text className="text-2xs text-muted" numberOfLines={1}>
                {merchantLine} · {formatCents(Math.abs(txn.amountCents))}
                {txn.cardLast4 ? ` · card ••${txn.cardLast4}` : ""}
              </Text>
            </View>
            <Pressable onPress={onClose} hitSlop={8} className="rounded-md p-1">
              <Icon name="x" size={18} color={colors.muted} />
            </Pressable>
          </View>

          <ScrollView className="max-h-[520px]">
            <View className="gap-5 px-5 py-4">
              {/* THE SEND-BACK, FIRST. For the person who has to act on it,
                  this is the single most important thing on the screen — a
                  reviewer already told them exactly what would make this
                  approvable, and burying it under form fields wastes the one
                  piece of certainty in the whole flow. */}
              {coding?.status === "changes_requested" && coding.reviewNote ? (
                <View className="rounded-lg border border-danger/40 bg-danger-bg px-3 py-2.5">
                  <View className="mb-1 flex-row items-center gap-1.5">
                    <Icon name="corner-up-left" size={13} color={colors.danger} />
                    <Text className="text-2xs font-semibold uppercase tracking-wide text-danger">
                      Sent back by {coding.decidedByName ?? "a reviewer"}
                    </Text>
                  </View>
                  <Text className="text-sm text-ink">
                    “{coding.reviewNote}”
                  </Text>
                  <Text className="mt-1 text-2xs text-muted">
                    Fix what it asks for and resubmit — it goes straight back to
                    review.
                  </Text>
                </View>
              ) : null}

              {/* STEP 1 — SUBSTANTIATION. */}
              <View>
                <StepHeader
                  index={1}
                  title="What it was for"
                  done={coding != null && coding.status !== "changes_requested"}
                  hint={
                    data?.requiresCoding === false
                      ? "Not required for this row, but any spend can carry one."
                      : "The IRS calls this substantiation: what the money bought, which org work it served, and who was involved."
                  }
                />
                {coding == null ? (
                  <View className="gap-2">
                    <Text className="text-xs text-muted">
                      Not coded yet. This is the part only you can do — you were
                      there.
                    </Text>
                    <Button
                      title="Code this charge"
                      size="sm"
                      icon="edit-3"
                      disabled={data === undefined}
                      onPress={() => setEditing(true)}
                    />
                  </View>
                ) : (
                  <View className="rounded-lg border border-border bg-sunken px-3 py-2.5">
                    <View className="mb-1 flex-row items-center gap-2">
                      <Badge
                        label={coding.statusLabel}
                        tone={CODING_TONE[coding.status] ?? "neutral"}
                      />
                      <Text className="text-xs font-medium text-ink">
                        {coding.expenseTypeLabel}
                      </Text>
                    </View>
                    <Text className="text-xs text-ink">
                      {coding.businessPurpose}
                    </Text>
                    {coding.travelFrom || coding.travelTo ? (
                      <Text className="mt-1 text-2xs text-muted">
                        Route: {coding.travelFrom ?? "—"} →{" "}
                        {coding.travelTo ?? "—"}
                      </Text>
                    ) : null}
                    {coding.headcount != null ? (
                      <Text className="mt-1 text-2xs text-muted">
                        {coding.headcount}{" "}
                        {coding.headcount === 1 ? "person" : "people"}
                        {coding.groupDescription
                          ? ` — ${coding.groupDescription}`
                          : ""}
                      </Text>
                    ) : null}
                    {coding.attendees != null && coding.attendees.length > 0 ? (
                      <Text className="mt-1 text-2xs text-muted">
                        {coding.attendees
                          .map(
                            (a) =>
                              `${a.name} (${ATTENDEE_AFFILIATION_LABELS[
                                a.affiliation as AttendeeAffiliation
                              ].toLowerCase()})`,
                          )
                          .join(", ")}
                      </Text>
                    ) : null}
                    {coding.status !== "approved" ? (
                      <View className="mt-2 flex-row">
                        <Button
                          title={
                            coding.status === "changes_requested"
                              ? "Edit and resubmit"
                              : "Edit"
                          }
                          variant="secondary"
                          size="sm"
                          onPress={() => setEditing(true)}
                        />
                      </View>
                    ) : null}
                  </View>
                )}
              </View>

              {/* STEP 2 — THE DOCUMENT. */}
              <View>
                <StepHeader
                  index={2}
                  title="Receipt"
                  done={documented}
                  hint="Our policy is stricter than the IRS's: no receipt, no coverage, every expense, any amount."
                />
                <View className="flex-row items-center gap-3">
                  <ReceiptCell
                    hasReceipt={txn.hasReceipt}
                    reminderStage={txn.reminderStage}
                    transactionId={transactionId}
                    onUpload={async (storageId) => {
                      await guard(
                        () => attachReceipt({ transactionId, storageId }),
                        "Couldn't attach receipt",
                      );
                    }}
                    generateUploadUrl={generateUploadUrl}
                  />
                </View>

                {/* AMOUNT PRE-CHECK, at attach time. "Receipt must show exact
                    amount" is the send-back this replaces — asking the
                    question here costs one glance and saves a whole review
                    round trip. See `receiptAmountCheck.ts` on why the number
                    is typed rather than read from OCR. */}
                {txn.hasReceipt ? (
                  <View className="mt-2">
                    <TextField
                      label="What total does the receipt show?"
                      hint={`Check it against the charge — ${formatCents(Math.abs(txn.amountCents))}. A receipt for a different amount is the most common reason a charge gets sent back.`}
                      value={receiptTotal}
                      onChangeText={setReceiptTotal}
                      placeholder={formatCents(Math.abs(txn.amountCents))}
                      keyboardType="decimal-pad"
                    />
                    {mismatch ? (
                      <View className="mt-1.5 flex-row items-start gap-2 rounded-md border border-warn/40 bg-warn-bg px-3 py-2">
                        <Icon
                          name="alert-triangle"
                          size={13}
                          color={colors.warn}
                        />
                        <Text className="flex-1 text-2xs text-ink">
                          {mismatch} Attach the receipt that shows the whole
                          charge, or say in the business purpose why this one
                          doesn&apos;t.
                        </Text>
                      </View>
                    ) : null}
                  </View>
                ) : txn.hasApprovedException ? (
                  <View className="flex-row items-start gap-2">
                    <Icon name="check-circle" size={13} color={colors.success} />
                    <Text className="flex-1 text-2xs text-muted">
                      Documented by an approved exception
                      {approvedException
                        ? ` — ${approvedException.reasonLabel.toLowerCase()}`
                        : ""}
                      . Attach a receipt any time and it takes over.
                    </Text>
                  </View>
                ) : pendingException != null ? (
                  <View className="flex-row items-start gap-2">
                    <Icon name="clock" size={13} color={colors.warn} />
                    <Text className="flex-1 text-2xs text-muted">
                      Exception filed ({pendingException.reasonLabel.toLowerCase()})
                      — a Finance manager still has to approve it. Asking to be
                      let off isn&apos;t being let off yet.
                    </Text>
                  </View>
                ) : (
                  <Pressable
                    onPress={() => setFiling(true)}
                    accessibilityRole="button"
                    className="mt-1 self-start active:opacity-70"
                  >
                    <Text className="text-xs font-medium text-accent">
                      There is no receipt for this
                    </Text>
                  </Pressable>
                )}
              </View>

              {/* STEP 3 — the pre-existing member affordances, kept but
                  demoted: none of this is required by the accountable plan,
                  it just saves the bookkeeper a guess. */}
              {isCardCharge ? (
                <View>
                  <StepHeader
                    index={3}
                    title="Anything else (optional)"
                    done={false}
                    hint="Helps the finance team file it. The business purpose above is the one that publishes."
                  />
                  <View className="gap-3">
                    <Select
                      label="Category"
                      hint="What kind of spend was this? The finance team can change it later."
                      value={catDraft ?? ""}
                      options={categoryOptions}
                      onChange={(v) => setCatDraft(v || null)}
                      placeholder="No category"
                    />
                    <TextField
                      label="A note for the finance team"
                      hint="Internal — unlike the business purpose, this never publishes."
                      value={noteDraft}
                      onChangeText={setNoteDraft}
                      placeholder="Anything they'd otherwise have to ask you about…"
                      multiline
                      numberOfLines={2}
                    />
                    {txn.isPersonal ? (
                      <View className="flex-row items-center gap-2">
                        <Icon
                          name="check-circle"
                          size={14}
                          color={colors.accent}
                        />
                        <Text className="text-xs text-muted">
                          Already flagged as a personal charge — pay it back
                          from the Cards tab.
                        </Text>
                      </View>
                    ) : (
                      <Pressable
                        onPress={() => setPersonalDraft((p) => !p)}
                        className="flex-row items-center gap-2 active:opacity-70"
                        accessibilityRole="checkbox"
                        accessibilityState={{ checked: personalDraft }}
                      >
                        <View
                          className={`h-5 w-5 items-center justify-center rounded border ${
                            personalDraft
                              ? "border-accent bg-accent"
                              : "border-border-strong bg-raised"
                          }`}
                        >
                          {personalDraft ? (
                            <Icon
                              name="check"
                              size={13}
                              color={colors.accentText}
                            />
                          ) : null}
                        </View>
                        <Text className="text-sm text-ink">
                          This was a personal charge — I&apos;ll pay it back
                        </Text>
                      </Pressable>
                    )}
                    <View className="flex-row">
                      <Button
                        title="Save these"
                        variant="secondary"
                        size="sm"
                        icon="check"
                        loading={busy}
                        onPress={() =>
                          void guard(
                            () =>
                              submitOwnCharge({
                                transactionId,
                                categoryId: (catDraft
                                  ? catDraft
                                  : null) as Id<"budgetCategories"> | null,
                                note: noteDraft.trim()
                                  ? noteDraft.trim()
                                  : null,
                                // The personal flag is one-way (it creates the
                                // repayment record and emails the payee), so
                                // only ever flag ON, and only when it wasn't
                                // already — same rule as the old inline editor.
                                flagPersonal:
                                  personalDraft && !txn.isPersonal
                                    ? true
                                    : undefined,
                              }),
                            "Couldn't save charge details",
                          )
                        }
                      />
                    </View>
                  </View>
                </View>
              ) : null}

              {toast ? <ToastView toast={toast} onDismiss={dismiss} /> : null}
            </View>
          </ScrollView>

          <View className="flex-row justify-end gap-2 border-t border-border px-5 py-4">
            <Button title="Done" variant="secondary" onPress={onClose} />
          </View>
        </Pressable>
      </Pressable>

      {editing && data != null ? (
        <TransactionCodingModal
          merchantLine={merchantLine}
          amountCents={txn.amountCents}
          namesMaxHeadcount={data.namesMaxHeadcount}
          minPurposeLength={data.minPurposeLength}
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
          submitting={busy}
          onCancel={() => setEditing(false)}
          onConfirm={(value: CodingFormValue) =>
            void guard(async () => {
              await submitCoding({ transactionId, ...value });
              setEditing(false);
            }, "Couldn't submit this coding")
          }
        />
      ) : null}

      {filing ? (
        <ReceiptExceptionModal
          amountCents={txn.amountCents}
          submitting={busy}
          onCancel={() => setFiling(false)}
          onConfirm={({
            reason,
            note,
            evidenceStorageIds,
          }: {
            reason: ReceiptExceptionReason;
            note: string;
            evidenceStorageIds: Id<"_storage">[];
          }) =>
            void guard(async () => {
              await attestException({
                transactionId,
                reason,
                note,
                ...(evidenceStorageIds.length ? { evidenceStorageIds } : {}),
              });
              setFiling(false);
            }, "Couldn't file that exception")
          }
        />
      ) : null}
    </Modal>
  );
}
