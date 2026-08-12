/**
 * FinishChargeSheet — everything one charge still needs, in one place.
 *
 * The owner ask (2026-08-08): a cardholder who gets the "you have 3 charges to
 * code" email should be able to finish all three without leaving the screen
 * and without a finance role. So this sheet carries the whole job:
 *
 *   1. What the reviewer said, if they sent it back — first, biggest, and
 *      quoted verbatim. It is the only thing on this screen that already
 *      tells them exactly what to do.
 *   2. THE ONE REQUIRED ACT: the substantiation record and the receipt that
 *      proves it. Not two steps — one. `submitCoding` now refuses a coding on
 *      a charge that can't prove itself (`DOCUMENTATION_REQUIRED`, owner:
 *      "they should just upload the receipt when coding"), so the two are
 *      presented as halves of a single record, and the receipt is reachable
 *      from inside `TransactionCodingModal` itself (`documentationSlot`) as
 *      well as from here. The editor is the same one the treasurer uses in
 *      Reconcile, not a second one that could drift.
 *   3. The optional extras the member could already set (category, a note for
 *      the finance team, "this was personal") — kept, but demoted below the
 *      things the accountable plan actually requires.
 *
 * Everything about the receipt half — upload, confirming a receipt that was
 * emailed in, or saying there is no receipt — lives in `CodingDocumentation`,
 * mounted both here and inside the editor, so the two can't drift either.
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
import { spaceToggleProps } from "../../ui/spaceToggle";
import { colors } from "../../../lib/theme";
import { useActionRunner } from "../../../lib/useActionToast";
import {
  TransactionCodingModal,
  type CodingFormValue,
} from "../modals/TransactionCodingModal";
import { CodingDocumentation } from "./CodingDocumentation";
import { PublicPurposeNotice } from "../coding/PublicPurposeEditor";
import { parseAmountToCents, receiptAmountMismatch } from "./receiptAmountCheck";
import type { ChargeTodo, ChargeTodoKind, MyTxnRow } from "./chargeTodo";

const CODING_TONE: Record<string, BadgeTone> = {
  submitted: "warn",
  changes_requested: "danger",
  approved: "success",
};

/**
 * The header for a NON-actionable row (`!todo.actionable` — `in_review` or
 * `settled`, the only two `ChargeTodoKind`s that ever are). Founder feedback:
 * "it says receipt attached, but then Open — what is it for?" — the sheet
 * used to say "Finish this charge" and show the intake form no matter what
 * state the charge was actually in, which reads as a demand to re-do
 * something that's already done. `todo.kind` is `chargeTodo`'s own state, not
 * re-derived here, so this can never disagree with the badge the row itself
 * showed a second ago. Keyed by `kind` rather than a plain boolean because
 * "waiting on a reviewer" and "nothing left to do" are different enough
 * states to say differently, even though both are equally non-actionable.
 */
const SUMMARY_TITLE: Partial<Record<ChargeTodoKind, string>> = {
  in_review: "Submitted — waiting on a reviewer",
  settled: "This charge is squared away",
};

/** `YYYY-MM-DD` in the finance timezone (the screen's own `dateStr`). */
function dateStr(ts: number): string {
  return new Date(ts).toLocaleDateString("en-CA", {
    timeZone: "America/New_York",
  });
}

/** A requirement's heading — a title and a done/outstanding marker, so what's
 *  left is readable at a glance instead of inferred from which buttons happen
 *  to be enabled.
 *
 *  DELIBERATELY UNNUMBERED. These used to be steps 1, 2, 3, which said out
 *  loud that the receipt was a later, separate errand — the exact reading the
 *  server no longer allows. A dot and a check say "outstanding" and "done"
 *  without implying an order. */
function RequirementHeader({
  title,
  done,
  hint,
}: {
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
            <Icon name="circle" size={10} color={colors.muted} />
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
  todo,
  categoryOptions,
  onClose,
}: {
  txn: MyTxnRow;
  /** `chargeTodo`'s own verdict on this row — the SAME facts that picked the
   *  row's badge and its "Finish"/"View" button, so the sheet that opens
   *  never disagrees with what the row just said. Deliberately not
   *  re-derived from `txn` in here: two independent readings of "is this
   *  actionable" is exactly how the row and the sheet drifted apart before.
   *
   *  OPTIONAL, and that's deliberate too: `explain.tsx` (the backfill
   *  workbench) mounts this same sheet over `finances.monthCodingWorklist`
   *  rows, which are the PUBLISHING population, not the chase state
   *  machine — most of them are `reconciled`, which `chargeTodo` calls
   *  settled/non-actionable. Passing a `chargeTodo`-derived verdict there
   *  would silently drop every historical row into summary mode with the
   *  intake form hidden, defeating the screen's whole purpose (see its own
   *  module doc on why `chargeTodo` is the wrong lens for that surface).
   *  So `explain.tsx` passes nothing on purpose, and the sheet falls back to
   *  exactly its pre-`todo` behavior: always the full intake, as if every
   *  row were actionable. */
  todo?: ChargeTodo;
  categoryOptions: { value: string; label: string }[];
  onClose: () => void;
}) {
  // Absent `todo` (explain.tsx) reads as "actionable" — the sheet's original,
  // always-intake behavior. Every other read of "is this actionable" in this
  // file goes through this one local, never `todo.actionable` directly, so
  // there's exactly one place that encodes the fallback.
  const actionable = todo === undefined ? true : todo.actionable;
  const transactionId = txn.id as Id<"transactions">;
  const data = useQuery(api.transactionCodings.getForTransaction, {
    transactionId,
  });
  const exceptions = useQuery(
    api.receiptExceptions.listForTransaction,
    txn.hasReceipt ? "skip" : { transactionId },
  );
  const submitCoding = useMutation(api.transactionCodings.submit);
  const submitOwnCharge = useMutation(api.finances.submitOwnCharge);
  const { run, toast, dismiss } = useActionRunner();

  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  // The attach-time amount check (see `receiptAmountCheck.ts` for why the
  // human types the number instead of OCR handing it to us).
  const [receiptTotal, setReceiptTotal] = useState("");
  // On a non-actionable row, the amount-check question starts collapsed
  // behind an "Update receipt total" affordance rather than showing by
  // default — see the sheet's module doc and `SUMMARY_TITLE` above.
  const [showReceiptCheck, setShowReceiptCheck] = useState(false);
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
  // WHAT THE SUBMIT GATE ACTUALLY ASKS. `hasDocumentation` is the server's own
  // answer and counts a PENDING exception, because the gate asks whether the
  // AUTHOR finished their half — approving it is somebody else's work and
  // can't be a reason their charge stays stuck in their queue. Falls back to
  // the row's own facts until the query lands, so the first paint never
  // wrongly says "you can't submit this".
  const hasDocumentation =
    data?.hasDocumentation ?? (documented || pendingException != null);
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
                {actionable
                  ? "Finish this charge"
                  : ((todo && SUMMARY_TITLE[todo.kind]) ??
                    "This charge is squared away")}
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

              {/* THE ONE REQUIRED ACT — said as one thing, then shown as its
                  two halves. The sheet used to number these 1 and 2, which
                  read as "do the words now, chase the paper later"; the
                  server stopped allowing that (see the module doc). */}
              <View className="gap-3">
                {/* This rule matters while you're doing the work; a settled
                    row already did it, so restating "can't be submitted
                    without both" there would read as a fresh demand rather
                    than as the summary the module doc promises. */}
                {actionable ? (
                  <View className="rounded-lg border border-border bg-sunken px-3 py-2.5">
                    <Text className="text-xs font-semibold text-ink">
                      Coding a charge is one act, not two errands.
                    </Text>
                    <Text className="mt-0.5 text-2xs text-muted">
                      What the money was for, and the receipt that proves it,
                      go in together — a coding can&apos;t be submitted
                      without both. If there is genuinely no receipt, say so
                      in the same place and that counts. This is what keeps
                      what you spent from becoming taxable income to you.
                    </Text>
                  </View>
                ) : null}

                <View>
                  <RequirementHeader
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
                      {/* SUMMARY MODE, NO CODING: this row is already
                          squared away without one (`chargeTodo` only calls a
                          row settled-and-uncoded when nothing required it —
                          otherwise it would have ranked "needs coding" and
                          `actionable` would be true). Saying "not coded yet"
                          under a header that just said "squared away" is the
                          exact contradiction the founder called out, so the
                          copy and the button both read as optional here
                          instead of as a live ask. */}
                      <Text className="text-xs text-muted">
                        {actionable
                          ? "Not coded yet. This is the part only you can do — you were there. The receipt goes in with it, in the same editor."
                          : "Coding is optional for this charge — add one if it needs explaining."}
                      </Text>
                      <Button
                        title={actionable ? "Code this charge" : "Add a coding (optional)"}
                        variant={actionable ? "primary" : "muted"}
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
                      {/* THE AUTHOR HAS TO SEE IT. If a reviewer rewrote the
                          sentence that publishes — usually to take a name out
                          — saying nothing would leave the public record and the
                          author's memory of it silently disagreeing. Their own
                          words are still the ones above, untouched. */}
                      <PublicPurposeNotice state={coding} />
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

                {/* THE OTHER HALF. Same component the editor mounts, so the
                    upload / "is this the one?" / "there is no receipt" paths
                    are identical whether somebody starts here or in the
                    editor. */}
                <View>
                  <RequirementHeader
                    title="The receipt that proves it"
                    done={hasDocumentation}
                    hint="Our policy is stricter than the IRS's: no receipt, no coverage, every expense, any amount."
                  />
                  <CodingDocumentation
                    transactionId={transactionId}
                    amountCents={txn.amountCents}
                    hasDocumentation={hasDocumentation}
                    detail={{
                      hasReceipt: txn.hasReceipt,
                      hasApprovedException: txn.hasApprovedException,
                      approvedReasonLabel:
                        approvedException?.reasonLabel ?? null,
                      pendingReasonLabel: pendingException?.reasonLabel ?? null,
                      reminderStage: txn.reminderStage,
                    }}
                    runAction={guard}
                    busy={busy}
                  />

                  {/* AMOUNT PRE-CHECK, at attach time. "Receipt must show exact
                      amount" is the send-back this replaces — asking the
                      question here costs one glance and saves a whole review
                      round trip. See `receiptAmountCheck.ts` on why the number
                      is typed rather than read from OCR.

                      On an ACTIONABLE row this is still asked outright — it's
                      part of finishing the charge. On a row that's already
                      settled, asking it by default is the exact bug this
                      sheet shipped with (founder: "it says receipt attached,
                      but then Open — what is it for?"): a question posed to
                      someone who has nothing left to answer. So there it
                      starts as a STATEMENT (`CodingDocumentation`'s own
                      settled line, just above, already says "Receipt
                      attached") with an explicit "Update receipt total"
                      affordance that reopens the same question on request —
                      no capability lost, just not demanded up front. */}
                  {txn.hasReceipt ? (
                    actionable || showReceiptCheck ? (
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
                              {mismatch} Attach the receipt that shows the
                              whole charge, or say in the business purpose why
                              this one doesn&apos;t.
                            </Text>
                          </View>
                        ) : null}
                        {!actionable ? (
                          <Pressable
                            onPress={() => setShowReceiptCheck(false)}
                            accessibilityRole="button"
                            className="mt-1.5 self-start active:opacity-70"
                          >
                            <Text className="text-2xs font-medium text-muted">
                              Done checking
                            </Text>
                          </Pressable>
                        ) : null}
                      </View>
                    ) : (
                      <Pressable
                        onPress={() => setShowReceiptCheck(true)}
                        accessibilityRole="button"
                        className="mt-2 self-start active:opacity-70"
                      >
                        <Text className="text-xs font-medium text-accent">
                          Update receipt total
                        </Text>
                      </Pressable>
                    )
                  ) : null}
                </View>
              </View>

              {/* THE OPTIONAL EXTRAS — the pre-existing member affordances,
                  kept but demoted: none of this is required by the accountable
                  plan, it just saves the bookkeeper a guess. */}
              {isCardCharge ? (
                <View>
                  <RequirementHeader
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
                        {...spaceToggleProps(() => setPersonalDraft((p) => !p))}
                        onPress={() => setPersonalDraft((p) => !p)}
                        className="flex-row items-center gap-2 active:opacity-70"
                        accessibilityRole="checkbox"
                        aria-checked={personalDraft}
                        accessibilityState={{ checked: personalDraft }}
                        accessibilityLabel="This was a personal charge"
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
          // THE RECEIPT, INSIDE THE EDITOR. Submit stays disabled until this
          // charge can prove itself, and the slot is how it gets proved
          // without closing what's half-typed — the same component the sheet
          // shows behind this modal, sharing nothing but the transaction, so
          // whichever one somebody uses, the other reflects it.
          hasDocumentation={hasDocumentation}
          documentationSlot={
            <CodingDocumentation
              transactionId={transactionId}
              amountCents={txn.amountCents}
              hasDocumentation={hasDocumentation}
              detail={{
                hasReceipt: txn.hasReceipt,
                hasApprovedException: txn.hasApprovedException,
                approvedReasonLabel: approvedException?.reasonLabel ?? null,
                pendingReasonLabel: pendingException?.reasonLabel ?? null,
                reminderStage: txn.reminderStage,
              }}
              runAction={guard}
              busy={busy}
            />
          }
          reviewNote={
            coding?.status === "changes_requested" ? coding.reviewNote : null
          }
          // THE PERSONAL-CHARGE FLAG, WHERE THE SENTENCE GETS WRITTEN.
          // Same `submitOwnCharge({ flagPersonal: true })` the checkbox in
          // "Anything else (optional)" below has always called — not a second
          // mechanism. It's passed in here because that checkbox is on the
          // sheet this modal is covering, so the moment somebody realises a
          // charge was personal is the moment they can't see it, and what
          // they do instead is write it into the business purpose. One
          // production charge is sitting in Operating Expenses right now
          // saying "Charged in error, ride from home to work".
          personalCharge={{
            alreadyFlagged: txn.isPersonal === true,
            onFlag: () =>
              guard(async () => {
                await submitOwnCharge({
                  transactionId,
                  categoryId: null,
                  note: null,
                  flagPersonal: true,
                });
                setEditing(false);
                onClose();
              }, "Couldn't flag this as a personal charge"),
          }}
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
          onConfirm={({ budgetId, ...value }: CodingFormValue) =>
            void guard(async () => {
              await submitCoding({
                transactionId,
                ...value,
                // The picker deals in plain strings; the mutation validates
                // the id for real (book rule + approved-budget rule), so this
                // cast is the only thing standing between them.
                ...(budgetId
                  ? { budgetId: budgetId as Id<"budgets"> }
                  : {}),
              });
              setEditing(false);
            }, "Couldn't submit this coding")
          }
        />
      ) : null}
    </Modal>
  );
}
