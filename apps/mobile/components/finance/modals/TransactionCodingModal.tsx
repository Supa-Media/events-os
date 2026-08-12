/**
 * TransactionCodingModal — authoring the substantiation record on a charge:
 * what it was, why it served the org's work, and who was involved. See
 * `docs/plans/transaction-coding.md`.
 *
 * NO MACHINE EVER WRITES AN ANSWER (owner decision, 2026-08-08: no AI in
 * coding). The transaction's merchant/amount/date are DISPLAYED as context,
 * and the answers are a human's own words — which is what an accountable
 * plan needs. ONE deliberate carve-out (owner directive, 2026-08-12): a
 * reimbursement payout's PRISTINE form starts from the CLAIMANT's own words
 * off the request (`reimbursementPrefill.ts` — existing human testimony
 * carried forward with a provenance line, fully editable, never composed by
 * a machine and never auto-submitted).
 *
 * THE FIELDS THEMSELVES live in `../coding/CodingFieldSet` — purpose, the
 * type-driven extras, and the budget picker — shared verbatim with
 * `FinishChargeSheetBody`'s inline flow so Reconcile's editor and the
 * cardholder's own sheet can never drift into two different ideas of what a
 * complete coding is. This file supplies the MODAL FRAME + the two things
 * that are this host's own: the receipt requirement (`documentationSlot`) and
 * the missing-pieces list's documentation line.
 *
 * CATEGORY-AWARE (founder, scope expansion): the expense-type chips now
 * follow whichever category the charge is ALREADY coded to (`category`
 * prop) — a bookkeeper reaching this editor from Reconcile no longer answers
 * "what kind of expense?" from scratch when the row already says
 * "Transportation". Still just a QUESTION-SET hint: it decides which extra
 * fields appear, never what goes in them, and a tap on any chip overrides it
 * for good (see `deriveExpenseType.ts`).
 *
 * Validation is the shared `codingFieldProblems` — the same list the server
 * throws from — rendered in place, with submit disabled until it's empty.
 *
 * THE RECEIPT IS ONE OF THOSE REQUIREMENTS NOW (owner decision, 2026-08-08:
 * "they should just upload the receipt when coding"). `submitCoding` refuses a
 * coding on a charge that can't prove itself (`DOCUMENTATION_REQUIRED`), so
 * the requirement is stated at the TOP of the editor, in the same "Still
 * needed before you can submit" register as every field problem, and the ways
 * out of it live in `documentationSlot` — attach, confirm a suggested receipt,
 * or say there is no receipt — all reachable without closing this editor.
 * Nobody may fill in three fields and only then be told no.
 */
import { useEffect, useRef, type ReactNode } from "react";
import { Modal, Pressable, ScrollView, Text, View } from "react-native";
import { formatCents, type AttendeeAffiliation, type ExpenseType } from "@events-os/shared";
import type { FunctionReturnType } from "convex/server";
import type { api } from "@events-os/convex/_generated/api";
import { Button, Icon } from "../../ui";
import { colors } from "../../../lib/theme";
import {
  CodingFieldSet,
  CodingProblemsList,
  ExpenseTypeChips,
  PersonalChargeEscape,
  useCodingFormState,
  type CodingCategoryContext,
  type CodingFormState,
  type CodingFormValue,
} from "../coding/CodingFieldSet";
import { ReimbursementContextBlock } from "../coding/ReimbursementContextBlock";
import { reimbursementPrefillPlan } from "../coding/reimbursementPrefill";

export type { CodingFormValue };

/** The receipt requirement, worded as one of the missing pieces rather than as
 *  an error — it belongs in the same list as "say what this was for". Its code
 *  is the server's (`submitCoding` throws exactly this one). */
const DOCUMENTATION_PROBLEM = {
  code: "DOCUMENTATION_REQUIRED",
  message:
    "Attach the receipt for this charge — or, if there is no receipt, say why right here. A coding can't be submitted without one; proving it and explaining it are the same act.",
};

export function TransactionCodingModal({
  merchantLine,
  amountCents,
  namesMaxHeadcount,
  minPurposeLength,
  hasDocumentation,
  documentationSlot,
  initial,
  initialBudgetId,
  category,
  reimbursementContext,
  reviewNote,
  personalCharge,
  submitLabel = "Submit for review",
  submitting,
  onConfirm,
  onCancel,
}: {
  /** Context line shown at the top — merchant + date, never editable here. */
  merchantLine: string;
  amountCents: number;
  namesMaxHeadcount: number;
  minPurposeLength: number;
  /** `getForTransaction().hasDocumentation` — a receipt, or a filed receipt
   *  exception (pending counts). False disables submit and puts the reason in
   *  the missing-pieces list, because the server would refuse anyway. */
  hasDocumentation: boolean;
  /** How to FIX that without leaving the editor — the host's
   *  `CodingDocumentation` (upload, confirm a suggested receipt, or file "there
   *  is no receipt"). A slot rather than the widget itself so this modal stays
   *  presentational and both hosts keep their own toast/error plumbing. */
  documentationSlot?: ReactNode;
  /** Present when revising after a send-back — the author's own prior words. */
  initial?: CodingFormValue | null;
  /** The budget the charge is already attributed to, if any — so re-opening
   *  the editor shows the current answer instead of an empty picker. */
  initialBudgetId?: string | null;
  /** The charge's OWN category, if any (`getForTransaction`'s
   *  `categoryName`/`categoryExpenseTypeHint`) — what the expense-type chips
   *  follow until overridden. `undefined` when the host has no category
   *  context; `null` when the charge is simply uncategorized. See
   *  `CodingCategoryContext`. */
  category?: CodingCategoryContext;
  /** FINDING 1 (UX audit, 2026-08-12): "What the claimant already wrote" —
   *  `getForTransaction().reimbursementContext`, passed through verbatim by
   *  `TransactionCodingSection` (the only caller with it). `undefined`/`null`
   *  renders nothing (the vast majority of codings, which aren't
   *  reimbursement payouts). */
  reimbursementContext?: NonNullable<
    FunctionReturnType<typeof api.transactionCodings.getForTransaction>["reimbursementContext"]
  > | null;
  /** The reviewer's send-back note, when this is a revision. Shown INSIDE the
   *  editor: "what would make this approvable" is useless one screen away from
   *  the fields it's about. */
  reviewNote?: string | null;
  /**
   * THE ESCAPE HATCH, next to the field people were escaping into.
   *
   * The personal-charge checkbox has always existed — under "Anything else
   * (optional)" on the sheet BEHIND this modal, which this modal covers while
   * the purpose is being typed. So the one moment a person realises "this
   * wasn't Public Worship's money" is the one moment they cannot see it, and
   * what they do instead is type the realisation into the business purpose:
   * *"Charged in error, ride from home to work"* — a personal charge that
   * publishes as org spend with no `isPersonal` flag and no repayment row.
   *
   * This is not a second flag. It calls the same `submitOwnCharge({
   * flagPersonal: true })` the checkbox always did; the only thing that
   * changes is that it is reachable from where the sentence is being written.
   * Nothing infers it — the spec forbids inference here, and rightly: a human
   * declares a charge personal, no heuristic reads their prose and guesses.
   *
   * Omitted by the reviewer-side host: a reviewer can't declare somebody
   * else's charge personal from the coding editor (that's the grid's
   * manager-gated "mark personal" action, which names who owes it).
   */
  personalCharge?: {
    /** Already flagged — show it settled rather than offering it twice. */
    alreadyFlagged: boolean;
    /** Flag it and leave; one-way, so the host confirms and closes. */
    onFlag: () => Promise<unknown>;
  };
  /** "Resubmit for review" when revising — a button that says the same thing
   *  on the first pass and the fourth hides which one you're on. */
  submitLabel?: string;
  submitting?: boolean;
  onConfirm: (value: CodingFormValue) => void;
  onCancel: () => void;
}) {
  const form: CodingFormState = useCodingFormState({
    initial,
    initialBudgetId,
    namesMaxHeadcount,
    category,
  });

  // OWNER DIRECTIVE (2026-08-12): auto-populate the PRISTINE form from the
  // claimant's own request words — once, at most, per open of this modal
  // (the modal mounts fresh each open), and only when it's a first coding
  // with nothing typed. `undefined` context means the host is still loading
  // it, so hold the attempt; `null` means there's genuinely none.
  const prefillAttempted = useRef(false);
  useEffect(() => {
    if (prefillAttempted.current || reimbursementContext === undefined) return;
    prefillAttempted.current = true;
    if (initial != null || form.touched) return;
    form.applyPrefill(reimbursementPrefillPlan(reimbursementContext));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reimbursementContext]);

  // The missing receipt is the ONE problem shown before anything is touched:
  // it isn't a field somebody hasn't reached yet, it's a precondition they
  // need to know about while they still have the receipt in their hand. A
  // prefilled form also shows its field problems untouched — a disabled
  // submit needs a visible reason.
  const missingDocumentation = hasDocumentation ? [] : [DOCUMENTATION_PROBLEM];
  const blocking = [...missingDocumentation, ...form.fieldProblems];
  const shown = [
    ...missingDocumentation,
    ...(form.touched || form.prefilled ? form.fieldProblems : []),
  ];

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onCancel}>
      <Pressable
        onPress={onCancel}
        className="flex-1 items-center justify-center bg-ink/30 p-6"
      >
        <Pressable
          onPress={() => {}}
          className="w-full max-w-lg overflow-hidden rounded-xl border border-border bg-raised shadow-pop"
        >
          <View className="flex-row items-center justify-between border-b border-border px-5 py-4">
            <View className="flex-1 pr-3">
              <Text className="font-display text-lg text-ink">
                Code this charge
              </Text>
              <Text className="text-2xs text-muted" numberOfLines={1}>
                {merchantLine} · {formatCents(Math.abs(amountCents))}
              </Text>
            </View>
            <Pressable onPress={onCancel} hitSlop={8} className="rounded-md p-1">
              <Icon name="x" size={18} color={colors.muted} />
            </Pressable>
          </View>

          <ScrollView className="max-h-[460px]">
            <View className="px-5 py-4">
              {reviewNote ? (
                <View className="mb-4 rounded-lg border border-danger/40 bg-danger-bg px-3 py-2.5">
                  <Text className="text-2xs font-semibold uppercase tracking-wide text-danger">
                    What the reviewer asked for
                  </Text>
                  <Text className="mt-0.5 text-sm text-ink">“{reviewNote}”</Text>
                </View>
              ) : null}

              {/* THE RECEIPT, FIRST AND IN HERE. Coding used to be step one
                  and the receipt step two, in that order, on a different
                  screen — which is exactly how somebody ended up typing a
                  complete substantiation record and then being refused. The
                  proof and the words go in together, so the proof is asked for
                  where the words are typed. */}
              {documentationSlot ? (
                <View
                  className={`mb-4 rounded-lg border px-3 py-2.5 ${
                    hasDocumentation
                      ? "border-border bg-sunken"
                      : "border-warn/40 bg-warn-bg"
                  }`}
                >
                  <Text className="mb-1 text-2xs font-semibold uppercase tracking-wide text-muted">
                    The receipt that proves it
                  </Text>
                  {documentationSlot}
                </View>
              ) : null}

              {/* FINDING 1: ABOVE the form, so it's seen before typing
                  starts. */}
              <ReimbursementContextBlock
                context={reimbursementContext}
                onUseLine={(line) =>
                  form.applyExternalLine({
                    expenseType: (line.expenseType as ExpenseType | null) ?? "general",
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

              {/* PROVENANCE, said out loud — same line as
                  `FinishChargeSheetBody`'s: these answers came from the
                  request, not from a machine. */}
              {form.prefilled ? (
                <View className="mb-3 flex-row items-start gap-1.5">
                  <Icon name="file-text" size={12} color={colors.muted} />
                  <Text className="flex-1 text-2xs italic text-muted">
                    The form below started from the claimant&apos;s own words
                    on the request — edit anything before you submit.
                  </Text>
                </View>
              ) : null}

              <ExpenseTypeChips form={form} category={category} />

              <CodingFieldSet
                form={form}
                minPurposeLength={minPurposeLength}
                personalChargeSlot={
                  personalCharge ? <PersonalChargeEscape {...personalCharge} /> : null
                }
              />

              <CodingProblemsList problems={shown} />
            </View>
          </ScrollView>

          <View className="flex-row justify-end gap-2 border-t border-border px-5 py-4">
            <Button title="Cancel" variant="secondary" onPress={onCancel} />
            <Button
              title={submitLabel}
              onPress={() => {
                if (form.value != null && blocking.length === 0) onConfirm(form.value);
              }}
              disabled={form.value == null || blocking.length > 0}
              loading={submitting}
            />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
