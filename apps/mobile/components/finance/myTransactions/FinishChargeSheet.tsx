/**
 * One charge, one record: receipt first, expense details next, then submit.
 * `/code` embeds this in a desktop side panel; narrow screens use a full-screen
 * drawer. The same body also serves the finance workbench. Existing permissions,
 * human-authored testimony, category-write ordering, and exception rules apply.
 */
import { useEffect, useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
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
import { reimbursementPrefillPlan } from "../coding/reimbursementPrefill";
import { TransactionHistoryCompact } from "../coding/TransactionHistoryCompact";
import { ReimbursementContextBlock } from "../coding/ReimbursementContextBlock";
import { PriorCodingBlock } from "../coding/PriorCodingBlock";
import { CodingDocumentation } from "./CodingDocumentation";
import { PublicPurposeNotice } from "../coding/PublicPurposeEditor";
import {
  parseAmountToCents,
  receiptAmountMismatch,
} from "./receiptAmountCheck";
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

/** A visible section number becomes a check once that requirement is complete. */
function RequirementHeader({
  title,
  done,
  hint,
  optional = false,
  step,
}: {
  title: string;
  step?: number;
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
            <Text className="text-xs font-semibold text-muted">
              {step ?? "•"}
            </Text>
          )}
        </View>
        <Text className="text-base font-semibold text-ink">{title}</Text>
      </View>
      {hint ? <Text className="mt-1 text-xs text-muted">{hint}</Text> : null}
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
  contained = false,
}: {
  txn: MyTxnRow;
  /** Own the scroller and pinned submission bar inside a charge panel. */
  contained?: boolean;
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
   *  row's badge and its "Code it"/"View" button, so the sheet that opens
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
    /** This charge owes a budget and hasn't got one (`finances.needsBudget`)
     *  — the gate `transactionCodings.approve` refuses on. Passed through so
     *  the host's Approve affordance can say so BEFORE the tap; the budget
     *  picker that fixes it is in the form this slot sits inside. */
    budgetRequired: boolean;
    runAction: (
      fn: () => Promise<unknown>,
      errorTitle: string,
    ) => Promise<unknown>;
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
  // The one-tap second half of "Submit & approve" (founder, 2026-08-12: "as
  // super admin, I can 1 party approve coding, right now I only see 'Submit
  // for review' nothing else"). Only ever called when the server said
  // `canSelfApprove` — the solo-operator relaxation, which `approve` records
  // as `approvalParty: "single"` so the bypass stays re-reviewable.
  const approveCoding = useMutation(api.transactionCodings.approve);
  const submitOwnCharge = useMutation(api.finances.submitOwnCharge);
  // The bookkeeper-gated twin of `submitOwnCharge`'s category write — same
  // field, different access rule (`requireTxnNoteReceiptCategoryAccess`:
  // bookkeeper+, or event-edit rights), reachable on ANY chapter transaction
  // rather than only the caller's own card. See `planCategoryEdit`.
  const setTransactionCategory = useMutation(
    api.finances.setTransactionCategory,
  );
  const setTransactionNote = useMutation(api.finances.setTransactionNote);
  const { run, toast, dismiss } = useActionRunner();

  const [editing, setEditing] = useState(false);
  const [showExtras, setShowExtras] = useState(false);
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
      ? {
          name: selectedCategoryOption?.label ?? "",
          expenseTypeHint: selectedCategoryOption?.expenseTypeHint,
        }
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

  // OWNER DIRECTIVE (2026-08-12): auto-populate the PRISTINE form from the
  // claimant's own request words — once per row, the first time the query
  // lands, and only when there's no existing coding and nothing typed yet.
  // The attempt is recorded up front (even when it fills nothing) so a later
  // data refresh can never surprise-fill a form someone is mid-thought in.
  const prefillAttemptedFor = useRef<string | null>(null);
  useEffect(() => {
    if (data === undefined) return;
    if (prefillAttemptedFor.current === transactionId) return;
    prefillAttemptedFor.current = transactionId;
    // THE BUDGET IS ALREADY ANSWERED for most rows (founder, 2026-08-12: "I
    // already put most transactions into budgets in reconcile but it still
    // asks me") — `transactions.budgetId` is the same column Reconcile's
    // "For" picker writes, so the picker starts on that answer instead of
    // "Not sure yet". Seeded (not `applyPrefill`) because it applies with an
    // existing coding too, and never over a pick already made this open.
    if (data.currentBudgetId && form.budgetId === "") {
      form.setBudgetId(data.currentBudgetId);
    }
    if (data.coding != null || form.touched) return;
    form.applyPrefill(reimbursementPrefillPlan(data.reimbursementContext));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, transactionId]);

  // ALWAYS INLINE the moment there's nothing coded yet AND the cardholder is
  // on the hook for it — no button, no modal (founder's own complaint). Any
  // OTHER state (an existing coding, or a charge nobody's chasing) keeps the
  // pre-existing "click to reveal" posture; `editing` is that click.
  const alwaysInline = actionable && coding == null;
  const showForm = alwaysInline || editing;

  const blocking =
    data === undefined ||
    busy ||
    form.value == null ||
    form.fieldProblems.length > 0 ||
    !hasDocumentation;

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
    (showForm && (form.touched || catDraft !== txn.categoryId)) ||
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
    await guard(
      async () => {
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
          // ONE TAP, BOTH DECISIONS, when the server allows it: the coding just
          // submitted is immediately approved (solo-operator relaxation,
          // recorded single-party server-side). A failure here is ITS OWN
          // failure — the submission above already landed and must never read
          // as lost; a retry re-submits idempotently and approves again.
          if (data?.canSelfApprove) {
            try {
              await approveCoding({ transactionId });
            } catch (err) {
              throw new Error(
                `Submitted for review — but the one-tap approval didn't land. Approve it from the review queue, or try again. ${errorMessage(err)}`,
              );
            }
          }
        }

        const plan = planCategoryEdit({
          isCardCharge,
          ownCharge,
          draftCategoryId: (catDraft
            ? catDraft
            : null) as Id<"budgetCategories"> | null,
          currentCategoryId: (txn.categoryId ??
            null) as Id<"budgetCategories"> | null,
        });
        if (plan.kind !== "none") {
          try {
            if (plan.kind === "own") {
              await submitOwnCharge({
                transactionId,
                categoryId: plan.categoryId,
              });
            } else {
              await setTransactionCategory({
                transactionId,
                categoryId: plan.categoryId,
              });
            }
          } catch (err) {
            // The explanation above already saved — this is a SEPARATE
            // failure, and must never read as "nothing saved".
            throw new Error(
              `Explanation saved. Couldn't set the category: ${errorMessage(err)}`,
            );
          }
        }

        setEditing(false);
      },
      "Couldn't save this charge",
      () => {
        setJustSubmitted(true);
        setReceiptTotal("");
      },
    );
  }

  const content = (
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
            {data?.canSelfApprove
              ? "Submitted and approved ✓"
              : "Submitted for review ✓"}
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
          <Text className="text-sm text-ink">“{coding.reviewNote}”</Text>
          <Text className="mt-1 text-2xs text-muted">
            Fix what it asks for and resubmit — it goes straight back to review.
          </Text>
        </View>
      ) : null}

      <View className="gap-3">
        {actionable ? (
          <Text className="text-sm text-muted">
            Add the receipt and expense details, then submit them together for
            review.
          </Text>
        ) : null}

        {/* THE OTHER HALF. Same component the editor mounts, so the
                    upload / "is this the one?" / "there is no receipt" paths
                    are identical whether somebody starts here or in the
                    editor. */}
        <View className="rounded-xl border border-border bg-raised p-4">
          <RequirementHeader
            title={hasDocumentation ? "Receipt documented" : "Add a receipt"}
            step={1}
            done={hasDocumentation}
            hint={
              hasDocumentation
                ? undefined
                : "Upload a photo or PDF, or choose a receipt you already sent."
            }
          />
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
            showReceiptCheck ? (
              <View className="mt-2">
                <TextField
                  label="Receipt total (optional check)"
                  hint={`Check it against the charge — ${formatCents(Math.abs(txn.amountCents))}. A receipt for a different amount is the most common reason a charge gets sent back.`}
                  value={receiptTotal}
                  onChangeText={setReceiptTotal}
                  placeholder={formatCents(Math.abs(txn.amountCents))}
                  keyboardType="decimal-pad"
                />
                {mismatch ? (
                  <View className="mt-1.5 flex-row items-start gap-2 rounded-md border border-warn/40 bg-warn-bg px-3 py-2">
                    <Icon name="alert-triangle" size={13} color={colors.warn} />
                    <Text className="flex-1 text-2xs text-ink">
                      {mismatch} Attach the receipt that shows the whole charge,
                      or say in the business purpose why this one doesn&apos;t.
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

        <View className="rounded-xl border border-border bg-raised p-4">
          <RequirementHeader
            title="Explain the expense"
            step={2}
            done={coding != null && coding.status !== "changes_requested"}
            optional={data?.requiresCoding === false}
            hint={
              data?.requiresCoding === false
                ? "Not required for this row, but any spend can carry one."
                : "Tell us what you bought and how it supported Public Worship."
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
                  Coding is optional for this charge — add one if it needs
                  explaining.
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
                {/* FINDING 2: lodging is ONE place, not a route —
                            "Route: — → Chicago" would misread a stay as a
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
                {coding.portedFromReimbursementId ? (
                  <Text className="mt-1 text-2xs text-muted">
                    Ported from reimbursement request — the claimant's own
                    approved answers.
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

              {/* "You've coded this vendor before" — directly below
                          the claimant's own words, ANALOGY not testimony, and
                          only ever applied on an explicit tap. `null` for the
                          vast majority of charges, which have no prior
                          APPROVED coding at this merchant. */}
              <PriorCodingBlock
                priorCoding={data?.priorCoding}
                onUse={(coding) =>
                  form.applyExternalLine({
                    expenseType: coding.expenseType as ExpenseType,
                    businessPurpose: coding.businessPurpose,
                    travelFrom: coding.travelFrom,
                    travelTo: coding.travelTo,
                    headcount: coding.headcount,
                    attendees: coding.attendees?.map((a) => ({
                      name: a.name,
                      affiliation: a.affiliation as AttendeeAffiliation,
                    })),
                    groupDescription: coding.groupDescription,
                  })
                }
              />

              {/* PROVENANCE, said out loud: when the form started
                          from the claimant's words (the prefill above), the
                          person coding needs to know these answers came from
                          the request — not from a machine, and not from a
                          previous coder. */}
              {form.prefilled ? (
                <View className="flex-row items-start gap-1.5">
                  <Icon name="file-text" size={12} color={colors.muted} />
                  <Text className="flex-1 text-2xs italic text-muted">
                    The form below started from the claimant&apos;s own words on
                    the request — edit anything before you submit.
                  </Text>
                </View>
              ) : null}

              <ExpenseTypeChips form={form} category={category} />
              <CodingFieldSet
                form={form}
                transactionId={transactionId}
                minPurposeLength={data?.minPurposeLength ?? 20}
              />
              {isCardCharge ? (
                <Select
                  label="Category (optional)"
                  hint="Choose the closest match, or let finance set it."
                  value={catDraft ?? ""}
                  options={categoryOptions}
                  onChange={(v) => setCatDraft(v || null)}
                  placeholder="No category"
                />
              ) : null}
              {/* A prefilled-but-incomplete form shows its problems
                          even before a touch — otherwise the disabled submit
                          would have no visible reason. */}
              <CodingProblemsList
                problems={
                  form.touched || form.prefilled ? form.fieldProblems : []
                }
              />
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
              budgetRequired: data?.budgetRequired ?? false,
              runAction: guard,
            })
          : null}
      </View>

      <Pressable
        onPress={() => setShowExtras((shown) => !shown)}
        accessibilityRole="button"
        accessibilityState={{ expanded: showExtras }}
        className="flex-row items-center justify-between border-t border-border py-3"
      >
        <Text className="text-sm font-medium text-muted">Notes & activity</Text>
        <Icon
          name={showExtras ? "chevron-up" : "chevron-down"}
          size={16}
          color={colors.muted}
        />
      </Pressable>
      {showExtras ? (
        <View className="gap-4">
          {/* THE OPTIONAL EXTRAS — note + personal flag. Category moved up
                  into "What it was for" (2026-08-1x) since it now drives the
                  coding questions directly; what's left here is genuinely
                  optional either way. */}
          {isCardCharge ? (
            <View className="rounded-xl border border-border bg-raised p-4">
              <RequirementHeader
                title="Note for finance"
                done={false}
                optional
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
                                note: noteDraft.trim()
                                  ? noteDraft.trim()
                                  : null,
                              })
                            : setTransactionNote({
                                transactionId,
                                note: noteDraft.trim()
                                  ? noteDraft.trim()
                                  : null,
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
          {isCardCharge ? (
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
          ) : null}
          <TransactionHistoryCompact transactionId={transactionId} />
        </View>
      ) : null}

    </View>
  );
  const submitBar = showForm ? (
    <View className="gap-2 border-t border-border bg-raised px-5 py-4">
      <Text className="text-xs text-muted" accessibilityLiveRegion="polite">
        {data === undefined
          ? "Loading charge details…"
          : !hasDocumentation
            ? "Add a receipt or explain why there is no receipt before submitting."
            : form.value == null
              ? "Choose an expense type to continue."
              : form.fieldProblems.length > 0
                ? "Complete the expense details above to submit."
                : "Ready to submit. Your receipt and explanation will be sent together."}
      </Text>
      <View className="flex-row gap-2">
        <Button
          // "Submit & approve" says out loud that one tap is
          // both decisions — shown only when the server's
          // `canSelfApprove` says this caller may single-party
          // decide (founder, 2026-08-12).
          title={
            coding?.status === "changes_requested"
              ? data?.canSelfApprove
                ? "Resubmit & approve"
                : "Resubmit for review"
              : data?.canSelfApprove
                ? "Submit & approve"
                : "Submit for review"
          }
          size="sm"
          icon="check"
          loading={busy}
          disabled={blocking}
          className="flex-1"
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
  ) : null;
  return contained ? (
    <View className="min-h-0 flex-1">
      <ScrollView
        className="flex-1"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: 20 }}
      >
        {content}
      </ScrollView>
      {submitBar}
      <ToastView toast={toast} onDismiss={dismiss} />
    </View>
  ) : (
    <>
      {content}
      {submitBar}
      <ToastView toast={toast} onDismiss={dismiss} />
    </>
  );
}

/** A persistent desktop panel or a full-height drawer on smaller screens. */
export function FinishChargeSheet({
  txn,
  todo,
  categoryOptions,
  ownCharge,
  onClose,
  presentation = "drawer",
  onDirtyChange,
}: {
  txn: MyTxnRow;
  presentation?: "panel" | "drawer";
  onDirtyChange?: (dirty: boolean) => void;
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
  const desktop = useWindowDimensions().width >= 768;
  const actionable = todo === undefined ? true : todo.actionable;
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
  const [confirmClose, setConfirmClose] = useState(false);
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  function requestClose() {
    if (!dirty) {
      onClose();
      return;
    }
    setConfirmClose(true);
  }

  const panel = (
    <View
      className="min-h-0 flex-1 bg-raised"
      accessibilityLabel="Charge coding panel"
    >
      <View className="gap-3 border-b border-border px-5 py-5">
        <View className="flex-row items-center justify-between gap-3">
          <Text className="text-xs font-semibold uppercase tracking-wide text-muted">
            {actionable
              ? "Code this charge"
              : ((todo && SUMMARY_TITLE[todo.kind]) ?? "Charge details")}
          </Text>
          <Pressable
            onPress={requestClose}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Close charge panel"
            className="rounded-md p-2"
          >
            <Icon name="x" size={18} color={colors.muted} />
          </Pressable>
        </View>
        <View className="flex-row items-start justify-between gap-4">
          <View className="flex-1">
            <Text className="text-lg font-semibold text-ink">
              {displayMerchantName(txn, "—")}
            </Text>
            <Text className="mt-1 text-xs text-muted">
              {dateStr(txn.postedAt)}
              {txn.cardLast4 ? ` · Card ••${txn.cardLast4}` : ""}
            </Text>
            {rawLine ? (
              <Text className="mt-1 text-xs text-faint">{rawLine}</Text>
            ) : null}
          </View>
          <Text className="text-xl font-semibold text-ink">
            {formatCents(Math.abs(txn.amountCents))}
          </Text>
        </View>
      </View>
      {confirmClose ? (
        <View className="gap-2 border-b border-warn/40 bg-warn-bg px-5 py-3">
          <Text className="text-sm font-semibold text-ink">
            Discard unsaved changes?
          </Text>
          <Text className="text-xs text-muted">
            Your receipt uploads are saved. Unsubmitted expense details will be
            lost.
          </Text>
          <View className="flex-row flex-wrap gap-2">
            <Button
              title="Keep editing"
              variant="secondary"
              size="sm"
              onPress={() => setConfirmClose(false)}
            />
            <Button
              title="Discard & close"
              variant="danger"
              size="sm"
              onPress={onClose}
            />
          </View>
        </View>
      ) : null}
      <FinishChargeSheetBody
        key={txn.id}
        txn={txn}
        todo={todo}
        categoryOptions={categoryOptions}
        ownCharge={ownCharge}
        onClose={onClose}
        onDirtyChange={setDirty}
        contained
      />
    </View>
  );
  if (presentation === "panel") return panel;
  return (
    <Modal
      visible
      transparent
      animationType="slide"
      onRequestClose={requestClose}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        className="flex-1 flex-row"
      >
        {desktop ? (
          <Pressable
            onPress={requestClose}
            accessibilityRole="button"
            accessibilityLabel="Close charge panel"
            className="flex-1 bg-ink/20"
          />
        ) : null}
        <View
          style={{ width: desktop ? 560 : "100%", height: "100%" }}
          className="border-l border-border bg-raised shadow-pop"
        >
          {panel}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
