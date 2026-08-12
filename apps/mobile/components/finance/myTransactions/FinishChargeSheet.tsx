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
 *   2. THE ONE REQUIRED ACT: category, then the substantiation record, then
 *      the receipt that proves it — one form, not three errands (see below).
 *   3. The optional extras (a note for the finance team, "this was personal")
 *      — kept, but demoted below the things the accountable plan requires.
 *
 * CATEGORY FIRST, INLINE, NO MODAL (founder, 2026-08-1x: "when I click to
 * view a transaction it shows category but it still shows 'Add coding
 * (optional)' when it should be an inline thing that already knows the
 * category and just asks for more information"). The Category picker now
 * opens "What it was for" — moved up from "Anything else (optional)" — and
 * the coding fields (`../coding/CodingFieldSet`, shared with
 * `TransactionCodingModal` so Reconcile and this sheet can never render two
 * different forms) sit directly beneath it, always visible once there's
 * something left to code. The expense-type chips FOLLOW whichever category is
 * picked (`categoryOptions[].expenseTypeHint` → `CodingCategoryContext`) —
 * "Transportation" lands on the travel questions with no second decision —
 * until the person taps a chip themselves, which sticks for good
 * (`deriveExpenseType.ts` owns that rule, tested on its own). A category with
 * no hint leaves the chips unselected exactly as the old standalone picker
 * did. DERIVING THE QUESTIONS is not the same act as ANSWERING them: purpose,
 * attendees, and headcount stay empty until the person types them, always —
 * see `CodingFieldSet`'s own module doc.
 *
 * ONE PRIMARY SUBMIT for the actionable case: CODING FIRST, ALWAYS
 * (`transactionCodings.submit`), then the category ONLY IF IT CHANGED
 * (`planCategoryEdit` — `submitOwnCharge` for the caller's own charge,
 * `finances.setTransactionCategory` for a bookkeeper reviewing someone
 * else's), off one button (`submitBoth`). Coding goes first on purpose: it's
 * the testimony, the actual point of the screen, and a category hiccup must
 * never block it (HIGH review finding, fixed 2026-08-1x — the old
 * category-then-coding order meant a bookkeeper coding a historical
 * Stripe-FC/Relay-CSV row from the Explain workbench, who doesn't own that
 * card, never got past `submitOwnCharge`'s `NOT_A_CARD_CHARGE`/`FORBIDDEN`,
 * so the coding never submitted at all). Both mutations stay independently
 * idempotent, so a retry after a partial failure never double-books
 * anything; the toast names exactly which half didn't land, and a category
 * failure after a successful coding reads as exactly that — the explanation
 * already saved — never as "nothing saved".
 *
 * SETTLED/SUMMARY ROWS (`todo.actionable === false`) keep the pre-existing
 * posture: a read-only summary card with an explicit "Edit" (or "Add a coding
 * (optional)") affordance — clicking it reveals this SAME inline field set,
 * never a modal. Only the "nothing coded yet, and the cardholder is on the
 * hook for it" case shows the fields with no click required at all.
 *
 * Everything about the receipt half — upload, confirming a receipt that was
 * emailed in, or saying there is no receipt — lives in `CodingDocumentation`,
 * mounted both here and via the section below, so the two can't drift.
 *
 * NOTHING IS PRE-FILLED (owner decision, 2026-08-08: no AI anywhere in
 * coding). Merchant, amount and date are shown as context because a person
 * can't substantiate what they can't see — but every answer is typed by the
 * human whose testimony it is.
 */
import { useEffect, useState } from "react";
import { Modal, Pressable, ScrollView, Text, View } from "react-native";
import { useMutation, useQuery } from "convex/react";
import {
  ATTENDEE_AFFILIATION_LABELS,
  displayMerchantName,
  documentationState,
  formatCents,
  rawBankLine,
  type AttendeeAffiliation,
  type ExpenseType,
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
import { errorMessage } from "../../../lib/errors";
import { confirmAction } from "../../../lib/confirmAction";
import {
  CodingFieldSet,
  CodingProblemsList,
  ExpenseTypeChips,
  PersonalChargeEscape,
  useCodingFormState,
  type CodingCategoryContext,
  type CodingFormValue,
} from "../coding/CodingFieldSet";
import { planCategoryEdit } from "../coding/categoryEditPlan";
import { TransactionHistoryCompact } from "../coding/TransactionHistoryCompact";
import { ReimbursementContextBlock } from "../coding/ReimbursementContextBlock";
import { CodingDocumentation } from "./CodingDocumentation";
import { PublicPurposeNotice } from "../coding/PublicPurposeEditor";
import { parseAmountToCents, receiptAmountMismatch } from "./receiptAmountCheck";
import type { ChargeTodo, ChargeTodoKind, MyTxnRow } from "./chargeTodo";

/** The category picker's own option shape — `myChargeCategories`' id/name
 *  plus the §274(d) hint the chips follow. Both hosts (`coding.tsx`,
 *  `explain.tsx`) build this from the same query; exported so they don't
 *  have to redeclare it. */
export type CategoryOption = {
  value: string;
  label: string;
  expenseTypeHint?: ExpenseType;
};

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
  optional = false,
}: {
  title: string;
  done: boolean;
  hint?: string;
  /** FINDING 11 (UX audit, 2026-08-12): a row where THIS requirement isn't
   *  actually required (e.g. coding on a charge `requiresCoding: false`)
   *  used to show the exact same hollow "outstanding" dot as a genuinely
   *  missing required field — reading as a to-do that isn't one. An optional,
   *  not-yet-done requirement gets a distinct neutral dash marker instead;
   *  DONE still reads identically either way (a completed optional coding is
   *  just as complete as a required one). */
  optional?: boolean;
}) {
  const outstandingOptional = !done && optional;
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
          ) : outstandingOptional ? (
            <Icon name="minus" size={10} color={colors.faint} />
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

/** What `getForTransaction` resolves to, once loaded — `FinishChargeSheetBody`
 *  hands this to `renderReview` so a host (the workbench panel) can put
 *  Approve/Send back next to the exact coding it read to decide. */
type CodingData = NonNullable<
  ReturnType<typeof useQuery<typeof api.transactionCodings.getForTransaction>>
>;

/**
 * THE CONTENT — everything `FinishChargeSheet` used to render inside its own
 * `Modal`, now free of that frame. One form, two frames: the modal below
 * mounts this unchanged for the narrow/sheet experience, and
 * `CodingWorkbenchPanel` (the wide-screen side panel, `explain.tsx`) mounts
 * the exact same component beside a big receipt instead of behind a click.
 * Neither host re-derives anything about the coding — both get it from this
 * one place, so they cannot drift the way a forked form would.
 */
export function FinishChargeSheetBody({
  txn,
  todo,
  categoryOptions,
  ownCharge,
  onClose,
  onDirtyChange,
  renderReview,
}: {
  txn: MyTxnRow;
  /** Does the CALLER own this row (they're its cardholder-of-record), or are
   *  they reaching it as a bookkeeper/finance-manager reviewing someone
   *  else's charge? Decides which mutation the category half calls
   *  (`planCategoryEdit` — `submitOwnCharge` vs the bookkeeper-gated
   *  `finances.setTransactionCategory`), because the server enforces the
   *  difference and guessing wrong throws.
   *
   *  THE HOST DECIDES, never a per-row guess: `personTransactions` rows (My
   *  Transactions, and `coding.tsx`'s "Yours to code" panel) are
   *  own-by-construction — pass `true`. `monthCodingWorklist` rows (the
   *  Explain workbench, `explain.tsx`) are the whole chapter's publishing
   *  population, not just the caller's own — pass `false`. */
  ownCharge: boolean;
  /** `chargeTodo`'s own verdict on this row — the SAME facts that picked the
   *  row's badge and its "Finish"/"View" button, so the sheet that opens
   *  never disagrees with what the row just said. Deliberately not
   *  re-derived from `txn` in here: two independent readings of "is this
   *  actionable" is exactly how the row and the sheet drifted apart before.
   *
   *  OPTIONAL, and that's deliberate too: `explain.tsx` (the backfill
   *  workbench) mounts this same content over `finances.monthCodingWorklist`
   *  rows, which are the PUBLISHING population, not the chase state
   *  machine — most of them are `reconciled`, which `chargeTodo` calls
   *  settled/non-actionable. Passing a `chargeTodo`-derived verdict there
   *  would silently drop every historical row into summary mode with the
   *  intake form hidden, defeating the screen's whole purpose (see its own
   *  module doc on why `chargeTodo` is the wrong lens for that surface).
   *  So `explain.tsx` passes nothing on purpose, and the content falls back
   *  to exactly its pre-`todo` behavior: always the full intake, as if every
   *  row were actionable. */
  todo?: ChargeTodo;
  categoryOptions: CategoryOption[];
  /** Called after an action that used to dismiss the whole sheet (flagging a
   *  charge personal). The Modal wrapper passes its own `onClose`; the panel
   *  host passes nothing — there is no sheet to close, so the row just stays
   *  selected and shows its new state (the "quick flow" contract: no
   *  auto-advance, ever). */
  onClose?: () => void;
  /** FINDING 10 (UX audit, 2026-08-12): reports whether this row currently
   *  has unsent typed input — an open coding form with something typed into
   *  it, a note draft that hasn't been saved, or a receipt-total check
   *  typed but not yet acted on. The Modal frame's "Done" button uses this
   *  to warn before discarding it; the panel host (no "Done" to guard) may
   *  simply omit this prop. */
  onDirtyChange?: (dirty: boolean) => void;
  /** The reviewer's Approve / Send back, rendered by the HOST (only the
   *  workbench panel passes this) right where the coding it decides is
   *  shown — same `approve`/`requestChanges` mutations `ReviewQueue` uses,
   *  same busy/toast plumbing as every other action on this form. Omitted
   *  entirely on the Modal path and inside `coding.tsx`'s own sheet: that
   *  reviewer's job stays `ReviewQueue`'s "scan many" flow. */
  renderReview?: (args: {
    transactionId: Id<"transactions">;
    coding: NonNullable<CodingData["coding"]>;
    canReview: boolean;
    runAction: (fn: () => Promise<unknown>, errorTitle: string) => Promise<unknown>;
  }) => React.ReactNode;
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
  // The bookkeeper-gated twin of `submitOwnCharge`'s category write — same
  // field, different access rule (`requireTxnNoteReceiptCategoryAccess`:
  // bookkeeper+, or event-edit rights), reachable on ANY chapter transaction
  // rather than only the caller's own card. See `planCategoryEdit`.
  const setTransactionCategory = useMutation(api.finances.setTransactionCategory);
  const setTransactionNote = useMutation(api.finances.setTransactionNote);
  const { run, toast, dismiss } = useActionRunner();

  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  // FINDING 3 (UX audit, 2026-08-12): `submitBoth` had no success feedback at
  // all — a failure toasts, but a SUCCESS just quietly returns to the summary
  // view, which reads as "did that work?" on both the modal sheet and the
  // wide-screen workbench panel (`CodingWorkbenchPanel` mounts this exact
  // body). The panel deliberately doesn't auto-advance to the next row — this
  // banner is what makes staying put read as intentional rather than stalled.
  // Cleared the moment editing reopens (a fresh edit makes the old
  // confirmation stale) or the row changes underneath this component.
  const [justSubmitted, setJustSubmitted] = useState(false);
  useEffect(() => {
    setJustSubmitted(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transactionId]);
  // The attach-time amount check (see `receiptAmountCheck.ts` for why the
  // human types the number instead of OCR handing it to us).
  const [receiptTotal, setReceiptTotal] = useState("");
  // On a non-actionable row, the amount-check question starts collapsed
  // behind an "Update receipt total" affordance rather than showing by
  // default — see the sheet's module doc and `SUMMARY_TITLE` above.
  const [showReceiptCheck, setShowReceiptCheck] = useState(false);
  const [catDraft, setCatDraft] = useState<string | null>(txn.categoryId);
  const [noteDraft, setNoteDraft] = useState(txn.note ?? "");

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

  async function guard(
    fn: () => Promise<unknown>,
    errorTitle: string,
    onSuccess?: () => void,
  ) {
    setBusy(true);
    const res = await run(fn, { errorTitle, onSuccess });
    setBusy(false);
    return res;
  }

  /** Opens the editor and clears a stale success banner from a previous
   *  submission on this row — every "Edit" / "Add a coding" affordance below
   *  calls this instead of a bare `setEditing(true)` (Finding 3). */
  function startEditing() {
    setJustSubmitted(false);
    setEditing(true);
  }

  // THE CATEGORY-DRIVEN CHIP CONTEXT. Only card charges reach `submitOwnCharge`
  // at all (server-enforced — see that mutation's own `NOT_A_CARD_CHARGE`
  // guard), so a non-card charge gets `undefined` here — "no category context
  // nearby" (`CodingCategoryContext`), which is exactly the old
  // standalone-picker copy. A card charge with nothing picked yet gets `null`
  // — "there IS a category, nothing chosen" — and a card charge WITH a pick
  // carries that option's `expenseTypeHint`, live, so switching categories
  // re-derives the chips (unless the person has already overridden them).
  const selectedCategoryOption = categoryOptions.find(
    (o) => o.value === (catDraft ?? ""),
  );
  const category: CodingCategoryContext = !isCardCharge
    ? undefined
    : catDraft
      ? { name: selectedCategoryOption?.label ?? "", expenseTypeHint: selectedCategoryOption?.expenseTypeHint }
      : null;

  const initialCodingValue: CodingFormValue | null = coding
    ? {
        expenseType: coding.expenseType,
        businessPurpose: coding.businessPurpose,
        ...(coding.travelFrom != null ? { travelFrom: coding.travelFrom } : {}),
        ...(coding.travelTo != null ? { travelTo: coding.travelTo } : {}),
        ...(coding.headcount != null ? { headcount: coding.headcount } : {}),
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
    : null;

  const form = useCodingFormState({
    initial: initialCodingValue,
    namesMaxHeadcount: data?.namesMaxHeadcount ?? 15,
    category,
  });

  // ALWAYS INLINE the moment there's nothing coded yet AND the cardholder is
  // on the hook for it — no button, no modal (founder's own complaint). Any
  // OTHER state (an existing coding, or a charge nobody's chasing) keeps the
  // pre-existing "click to reveal" posture; `editing` is that click.
  const alwaysInline = actionable && coding == null;
  const showForm = alwaysInline || editing;

  const blocking = form.value == null || form.fieldProblems.length > 0;

  // FINDING 8: the note is provenance-labeled when it's exactly the ported
  // reimbursement-request purpose (`deriveReimbursementTxnFields`'s own
  // `fields.note = purpose` write) — the cheap, honest signal available
  // without a full authorship trail. Compared against the SAVED note
  // (`txn.note`), never the unsaved `noteDraft` — this describes where the
  // note ON RECORD came from, not what's currently typed.
  const noteFromReimbursementRequest =
    data?.reimbursementContext != null &&
    !!txn.note?.trim() &&
    txn.note.trim() === (data.reimbursementContext.purpose ?? "").trim();

  // FINDING 10: "unsent typed input" — a coding form open with something
  // typed into it, a note edited but not saved, or a receipt-total check
  // typed but never acted on. Deliberately a SIMPLE check (not a deep
  // equality against every field) — the point is catching "I typed
  // something and tapped away", not modeling every possible edit.
  const hasUnsentInput =
    (showForm && form.touched) ||
    noteDraft.trim() !== (txn.note ?? "").trim() ||
    receiptTotal.trim().length > 0;
  useEffect(() => {
    onDirtyChange?.(hasUnsentInput);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasUnsentInput]);

  /** ONE PRIMARY SUBMIT — CODING FIRST, ALWAYS, then the category if it
   *  changed (HIGH review finding, fixed 2026-08-1x). The old order tried the
   *  category first and only reached the coding on success; for the Explain
   *  workbench's core population — a historical Stripe-FC/Relay-CSV card row
   *  the finance manager reviewing it doesn't personally own —
   *  `submitOwnCharge` throws `NOT_A_CARD_CHARGE`/`FORBIDDEN` every time, so
   *  the coding (the actual point of that screen) never submitted at all.
   *  The testimony is the point; a category hiccup must never block it.
   *
   *  The category half now: (a) runs only when `planCategoryEdit` says the
   *  category actually changed, never a same-value no-op write, and (b)
   *  calls `submitOwnCharge` or the bookkeeper-gated `setTransactionCategory`
   *  by OWNERSHIP (`ownCharge`, host-supplied), not by guessing. Both halves
   *  stay independently idempotent, so a retry after a partial failure never
   *  double-books anything, and a category failure AFTER a successful coding
   *  reports itself as exactly that — the explanation already saved. */
  async function submitBoth() {
    await guard(async () => {
      if (form.value != null) {
        const { budgetId, ...codingValue } = form.value;
        try {
          await submitCoding({
            transactionId,
            ...codingValue,
            ...(budgetId ? { budgetId: budgetId as Id<"budgets"> } : {}),
          });
        } catch (err) {
          throw new Error(
            `The explanation didn't submit — nothing was lost, just try again. ${errorMessage(err)}`,
          );
        }
      }

      const plan = planCategoryEdit({
        isCardCharge,
        ownCharge,
        draftCategoryId: (catDraft ? catDraft : null) as Id<"budgetCategories"> | null,
        currentCategoryId: (txn.categoryId ?? null) as Id<"budgetCategories"> | null,
      });
      if (plan.kind !== "none") {
        try {
          if (plan.kind === "own") {
            await submitOwnCharge({ transactionId, categoryId: plan.categoryId });
          } else {
            await setTransactionCategory({ transactionId, categoryId: plan.categoryId });
          }
        } catch (err) {
          // The explanation above already saved — this is a SEPARATE
          // failure, and must never read as "nothing saved".
          throw new Error(`Explanation saved. Couldn't set the category: ${errorMessage(err)}`);
        }
      }

      setEditing(false);
    }, "Couldn't save this charge", () => setJustSubmitted(true));
  }

  return (
    <>
      <View className="gap-5">
              {/* FINDING 3 (UX audit, 2026-08-12): an unmistakable success
                  state — the panel deliberately doesn't auto-advance to the
                  next row after a submit, so this is what makes staying put
                  read as "that worked" rather than "did anything happen?".
                  Only shown once the form has actually closed back to the
                  summary view (`!showForm`) — never layered under the form
                  itself. */}
              {justSubmitted && !showForm ? (
                <View className="flex-row items-center gap-2 rounded-lg border border-success/40 bg-success-bg px-3 py-2.5">
                  <Icon name="check-circle" size={16} color={colors.success} />
                  <Text className="text-sm font-semibold text-success">
                    Submitted for review ✓
                  </Text>
                </View>
              ) : null}

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
                    optional={data?.requiresCoding === false}
                    hint={
                      data?.requiresCoding === false
                        ? "Not required for this row, but any spend can carry one."
                        : "The IRS calls this substantiation: what the money bought, which org work it served, and who was involved."
                    }
                  />
                  {!showForm ? (
                    coding == null ? (
                      <View className="gap-2">
                        {/* SUMMARY MODE, NO CODING: this row is already
                            squared away without one (`chargeTodo` only calls a
                            row settled-and-uncoded when nothing required it —
                            otherwise it would have ranked "needs coding" and
                            `actionable` would be true, and `alwaysInline`
                            would have shown the form instead of this button). */}
                        <Text className="text-xs text-muted">
                          Coding is optional for this charge — add one if it
                          needs explaining.
                        </Text>
                        <Button
                          title="Add a coding (optional)"
                          variant="muted"
                          size="sm"
                          icon="edit-3"
                          disabled={data === undefined}
                          onPress={startEditing}
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
                          {selectedCategoryOption ? (
                            <Text className="text-2xs text-muted">
                              · {selectedCategoryOption.label}
                            </Text>
                          ) : null}
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
                              onPress={startEditing}
                            />
                          </View>
                        ) : null}
                      </View>
                    )
                  ) : (
                    <View className="gap-3">
                      {isCardCharge ? (
                        <Select
                          label="Category"
                          hint="What kind of spend was this? Picking one gets you the right proof questions below — the finance team can still change it later."
                          value={catDraft ?? ""}
                          options={categoryOptions}
                          onChange={(v) => setCatDraft(v || null)}
                          placeholder="No category"
                        />
                      ) : null}

                      {/* FINDING 1: "What the claimant already wrote" — ABOVE
                          the form, so it's seen before typing starts, not
                          discovered after. `null` (renders nothing) for the
                          vast majority of charges, which aren't reimbursement
                          payouts at all. */}
                      <ReimbursementContextBlock
                        context={data?.reimbursementContext}
                        onUseLine={(line) =>
                          form.applyExternalLine({
                            expenseType:
                              (line.expenseType as ExpenseType | null) ?? "general",
                            businessPurpose: line.businessPurpose ?? "",
                            travelFrom: line.travelFrom,
                            travelTo: line.travelTo,
                            headcount: line.headcount,
                            attendees: line.attendees?.map((a) => ({
                              name: a.name,
                              affiliation: a.affiliation as AttendeeAffiliation,
                            })),
                            groupDescription: line.groupDescription,
                          })
                        }
                      />

                      <ExpenseTypeChips form={form} category={category} />
                      <CodingFieldSet
                        form={form}
                        minPurposeLength={data?.minPurposeLength ?? 20}
                        personalChargeSlot={
                          isCardCharge ? (
                            <PersonalChargeEscape
                              alreadyFlagged={txn.isPersonal === true}
                              onFlag={() =>
                                guard(async () => {
                                  await submitOwnCharge({
                                    transactionId,
                                    categoryId: null,
                                    note: null,
                                    flagPersonal: true,
                                  });
                                  setEditing(false);
                                  onClose?.();
                                }, "Couldn't flag this as a personal charge")
                              }
                            />
                          ) : null
                        }
                      />
                      <CodingProblemsList
                        problems={form.touched ? form.fieldProblems : []}
                      />
                      <View className="flex-row gap-2">
                        <Button
                          title={
                            coding?.status === "changes_requested"
                              ? "Resubmit for review"
                              : "Submit for review"
                          }
                          size="sm"
                          icon="check"
                          loading={busy}
                          disabled={blocking}
                          onPress={() => void submitBoth()}
                        />
                        {!alwaysInline ? (
                          <Button
                            title="Cancel"
                            variant="secondary"
                            size="sm"
                            onPress={() => setEditing(false)}
                          />
                        ) : null}
                      </View>
                    </View>
                  )}
                </View>

                {/* THE REVIEWER'S DECISION — only when the host asked for it
                    (the workbench panel) AND there is a submitted coding to
                    decide. Right below what it decides, same as
                    `ReviewQueue`'s own ordering (purpose, then the verdict). */}
                {renderReview && coding && coding.status === "submitted"
                  ? renderReview({
                      transactionId,
                      coding,
                      canReview: data?.canReview ?? false,
                      runAction: guard,
                    })
                  : null}

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

              {/* THE OPTIONAL EXTRAS — note + personal flag. Category moved up
                  into "What it was for" (2026-08-1x) since it now drives the
                  coding questions directly; what's left here is genuinely
                  optional either way. */}
              {isCardCharge ? (
                <View>
                  <RequirementHeader
                    title="Anything else (optional)"
                    done={false}
                    hint="Helps the finance team file it. The business purpose above is the one that publishes."
                  />
                  <View className="gap-3">
                    <View className="gap-1">
                      {/* FINDING 8 (UX audit, 2026-08-12): the cheap, honest
                          version of note provenance — full author
                          attribution needs data this table doesn't store,
                          but "this note is literally the reimbursement
                          request's own purpose, ported over" is a fact we
                          DO have (`deriveReimbursementTxnFields`), so say
                          it rather than let it read as if a bookkeeper
                          typed it fresh. */}
                      {noteFromReimbursementRequest ? (
                        <View className="flex-row items-center gap-1">
                          <Icon name="file-text" size={11} color={colors.muted} />
                          <Text className="text-2xs italic text-muted">
                            From the reimbursement request
                          </Text>
                        </View>
                      ) : null}
                      <TextField
                        label="A note for the finance team"
                        hint="Internal — unlike the business purpose, this never publishes."
                        value={noteDraft}
                        onChangeText={setNoteDraft}
                        placeholder="Anything they'd otherwise have to ask you about…"
                        multiline
                        numberOfLines={2}
                      />
                    </View>
                    <View className="flex-row">
                      <Button
                        title="Save note"
                        variant="secondary"
                        size="sm"
                        icon="check"
                        loading={busy}
                        onPress={() =>
                          void guard(
                            // Same ownership split as the category half
                            // (`planCategoryEdit`'s reasoning): the
                            // cardholder writes their own note via
                            // `submitOwnCharge`; a bookkeeper reviewing
                            // someone else's row (the Explain workbench)
                            // needs the bookkeeper-gated twin instead, or
                            // this throws exactly like the category bug did.
                            () =>
                              ownCharge
                                ? submitOwnCharge({
                                    transactionId,
                                    note: noteDraft.trim() ? noteDraft.trim() : null,
                                  })
                                : setTransactionNote({
                                    transactionId,
                                    note: noteDraft.trim() ? noteDraft.trim() : null,
                                  }),
                            "Couldn't save that note",
                          )
                        }
                      />
                    </View>
                  </View>
                </View>
              ) : null}

              {/* FINDING 4: the audit trail existed but was invisible from
                  here — see `TransactionHistoryCompact`'s own module doc. */}
              <TransactionHistoryCompact transactionId={transactionId} />

              {toast ? <ToastView toast={toast} onDismiss={dismiss} /> : null}
      </View>
    </>
  );
}

/**
 * THE MODAL FRAME — narrow/mobile, and `coding.tsx`'s sheet (both keep the
 * exact pre-panel behavior: a click-in, click-out overlay). Wraps
 * `FinishChargeSheetBody` with the header/backdrop/footer chrome that used to
 * be inlined here; nothing about the content below changed.
 */
export function FinishChargeSheet({
  txn,
  todo,
  categoryOptions,
  ownCharge,
  onClose,
}: {
  txn: MyTxnRow;
  todo?: ChargeTodo;
  categoryOptions: CategoryOption[];
  /** Forwarded verbatim to `FinishChargeSheetBody` — see that prop's own
   *  doc, and `planCategoryEdit` for why it matters. `coding.tsx`'s
   *  narrow-screen sheet (`finances.personTransactions` rows) passes `true`;
   *  `explain.tsx`'s narrow-screen sheet (`finances.monthCodingWorklist`
   *  rows — the whole chapter's publishing population, not the caller's
   *  own) passes `false`. */
  ownCharge: boolean;
  onClose: () => void;
}) {
  const actionable = todo === undefined ? true : todo.actionable;
  const merchantLine = `${displayMerchantName(txn, "—")} · ${dateStr(txn.postedAt)}`;
  // FINDING 5 (UX audit, 2026-08-12): the raw bank/processor description —
  // shown beneath the cleaned name only when it actually says something
  // different (`null` when there's nothing to add).
  const rawLine = rawBankLine(txn);

  // FINDING 10 (UX audit, 2026-08-12): "Done" used to close unconditionally —
  // a person who typed a purpose, a receipt-total check, or a note and then
  // tapped Done lost it silently. `dirty` is reported up by the body (see its
  // own `onDirtyChange` prop doc); every explicit close affordance in this
  // frame (the header ✕ and the footer "Done") routes through this one
  // guarded closer instead of calling `onClose` directly.
  const [dirty, setDirty] = useState(false);
  function requestClose() {
    if (!dirty) {
      onClose();
      return;
    }
    confirmAction({
      title: "Discard unsaved changes?",
      message:
        "You've typed something here that hasn't been submitted or saved yet. Closing now discards it.",
      confirmLabel: "Discard",
      destructive: true,
      onConfirm: onClose,
    });
  }

  return (
    <Modal visible transparent animationType="fade" onRequestClose={requestClose}>
      <Pressable
        onPress={requestClose}
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
              {/* FINDING 5: the raw bank line, only when it differs. */}
              {rawLine ? (
                <Text className="text-2xs text-faint" numberOfLines={1}>
                  {rawLine}
                </Text>
              ) : null}
            </View>
            <Pressable onPress={requestClose} hitSlop={8} className="rounded-md p-1">
              <Icon name="x" size={18} color={colors.muted} />
            </Pressable>
          </View>

          <ScrollView className="max-h-[520px]">
            <View className="px-5 py-4">
              <FinishChargeSheetBody
                txn={txn}
                todo={todo}
                categoryOptions={categoryOptions}
                ownCharge={ownCharge}
                onClose={onClose}
                onDirtyChange={setDirty}
              />
            </View>
          </ScrollView>

          <View className="flex-row justify-end gap-2 border-t border-border px-5 py-4">
            <Button title="Done" variant="secondary" onPress={requestClose} />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
