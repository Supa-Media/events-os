/**
 * FIX IT HERE, DON'T SEND IT BACK — the reviewer's correction pass, inline in
 * the review record.
 *
 * Founder, 2026-09-02, looking at a merch invoice in the queue reading "Not
 * attributed to a budget": *"got to make sure the treasurer/financial manager
 * can edit details like the budget category for example, we shouldn't be
 * letting things go through without a budget, also allow them to edit any
 * other details they want instead of sending back and forth."*
 *
 * ## Why this exists rather than a note on a send-back
 *
 * The record showed the budget and the category as read-only FACTS, and the
 * row offered Approve or Send back. So the one person in the org who actually
 * knows which budget a charge belongs to had exactly one way to set it: bounce
 * the whole coding to the cardholder, asking them to answer a question the
 * coding form itself tells them to leave blank ("Not sure? Leave it — the
 * finance team will set it"). A round trip of days for a field the author was
 * never the right person to fill. The other option — approve it anyway — is
 * what actually happened, and it publishes a charge attributed to nothing.
 *
 * ## One form, two audiences
 *
 * This mounts the SAME `ExpenseTypeChips` + `CodingFieldSet` the author's own
 * coding sheet does, in `mode="review"`. Not a reviewer-shaped copy of them:
 * the §274(d) questions are the same questions about the same charge, and a
 * second set would drift within a release. What `mode="review"` changes is
 * exactly two things, both stated in `CodingFieldSet`'s own doc — the author's
 * sentence renders read-only, and the budget copy stops telling the finance
 * team that the finance team will handle it.
 *
 * ## What it will not let a reviewer do
 *
 * Rewrite `businessPurpose`. That is the author's testimony and the
 * substantiation of record; the reviewer's channel for the PUBLISHED wording
 * is "Edit what publishes" on the row (`PublicPurposeEditor` →
 * `setPublicPurpose`), which stores the rewrite BESIDE the original. The
 * server enforces it by construction — `transactionCodings.reviseUnderReview`
 * has no `businessPurpose` argument — and this panel does not render a box for
 * it, because a field that silently doesn't save is worse than no field.
 *
 * Separation of duties rides along: the panel only mounts when the server says
 * `canRevise`, which is authority AND not-your-own-coding AND a coding still
 * awaiting review.
 */
import { useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import {
  DEFAULT_MEAL_ATTENDEE_NAMES_MAX_HEADCOUNT,
  MIN_PURPOSE_LENGTH,
  type AttendeeAffiliation,
  type ExpenseType,
} from "@events-os/shared";
import { Button, Icon, Select } from "../../ui";
import { colors } from "../../../lib/theme";
import {
  CodingFieldSet,
  CodingProblemsList,
  ExpenseTypeChips,
  useCodingFormState,
} from "./CodingFieldSet";
import type { RunAction } from "./ReviewQueue";

/** The coding as the review record already read it — passed in rather than
 *  re-queried, so the panel can never open on a different revision than the
 *  record it sits inside. */
export interface ReviseSubject {
  expenseType: string;
  businessPurpose: string;
  travelFrom: string | null;
  travelTo: string | null;
  headcount: number | null;
  attendees: { name: string; affiliation: string }[] | null;
  groupDescription: string | null;
}

export function ReviseUnderReview({
  transactionId,
  coding,
  categoryId,
  budgetId,
  budgetRequired,
  runAction,
  onDone,
}: {
  transactionId: string;
  coding: ReviseSubject;
  categoryId: string | null;
  budgetId: string | null;
  /** Whether this charge owes a budget and hasn't got one — the same
   *  `finances.needsBudget` the approval gate reads. Drives the one line at
   *  the top saying why the panel is worth opening on this row. */
  budgetRequired: boolean;
  runAction: RunAction;
  onDone: () => void;
}) {
  const revise = useMutation(api.transactionCodings.reviseUnderReview);
  const policy = useQuery(api.transactionCodings.policy, {});
  // ORG-WIDE, so this is the right list for a charge in any book — the same
  // query every other category picker in finance reads.
  const categories = useQuery(api.finances.myChargeCategories, {});
  const [busy, setBusy] = useState(false);
  const [category, setCategory] = useState<string>(categoryId ?? "");

  const form = useCodingFormState({
    initial: {
      expenseType: coding.expenseType as ExpenseType,
      businessPurpose: coding.businessPurpose,
      ...(coding.travelFrom != null ? { travelFrom: coding.travelFrom } : {}),
      ...(coding.travelTo != null ? { travelTo: coding.travelTo } : {}),
      ...(coding.headcount != null ? { headcount: coding.headcount } : {}),
      // A caller without names-view never sees this panel's attendee editor
      // populated — but they hold `canRevise` only by holding review
      // authority, which is the same bar `hasCodingNamesView` applies, so in
      // practice `attendees` is never redacted out from under a reviser. The
      // `?? []` is the honest fallback rather than a claim either way.
      ...(coding.attendees
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
    },
    initialBudgetId: budgetId,
    namesMaxHeadcount:
      policy?.namesMaxHeadcount ?? DEFAULT_MEAL_ATTENDEE_NAMES_MAX_HEADCOUNT,
  });

  const categoryItems = useMemo(
    () => [
      { value: "", label: "Uncategorized" },
      ...(categories ?? []).map((c) => ({ value: c.id as string, label: c.name })),
    ],
    [categories],
  );

  const value = form.value;
  // The SAME problems list the author's form gates on. A correction that
  // leaves the record incomplete is not a correction, and the server would
  // refuse it anyway (`normalizeCodingFields`) — saying so here means the
  // reviewer reads it next to the field rather than as a toast.
  const problems = form.fieldProblems;
  const blocked = value == null || problems.length > 0;

  async function save() {
    if (!value) return;
    setBusy(true);
    try {
      await runAction(async () => {
        await revise({
          transactionId: transactionId as Id<"transactions">,
          // "" is the reviewer's explicit CLEAR — see the mutation's own arg
          // doc on why they may clear what a cardholder may not.
          budgetId: value.budgetId
            ? (value.budgetId as Id<"budgets">)
            : null,
          categoryId: category
            ? (category as Id<"budgetCategories">)
            : null,
          coding: {
            expenseType: value.expenseType,
            ...(value.travelFrom ? { travelFrom: value.travelFrom } : {}),
            ...(value.travelTo ? { travelTo: value.travelTo } : {}),
            ...(value.headcount != null ? { headcount: value.headcount } : {}),
            ...(value.attendees ? { attendees: value.attendees } : {}),
            ...(value.groupDescription
              ? { groupDescription: value.groupDescription }
              : {}),
          },
        });
        onDone();
      }, { errorTitle: "Couldn't save that correction" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <View className="gap-3 rounded-lg border border-accent/40 bg-accent/5 px-3 py-3">
      <View className="flex-row items-start gap-2">
        <Icon
          name={budgetRequired ? "alert-triangle" : "edit-3"}
          size={13}
          color={budgetRequired ? colors.warn : colors.muted}
        />
        <Text className="flex-1 text-xs text-ink">
          {budgetRequired ? (
            <>
              <Text className="font-semibold">
                This charge has no budget, so it can&apos;t be approved.
              </Text>{" "}
              Set it here — you don&apos;t have to send the coding back for it.
            </>
          ) : (
            <>
              <Text className="font-semibold">Fix it here.</Text> Anything you
              change is recorded against your name; the author&apos;s own
              sentence stays exactly as they wrote it.
            </>
          )}
        </Text>
      </View>

      <View>
        <Text className="mb-1.5 text-2xs font-semibold uppercase tracking-wide text-muted">
          Category
        </Text>
        <Select
          label="What kind of spend was this?"
          value={category}
          options={categoryItems}
          onChange={setCategory}
          placeholder="Uncategorized"
          searchable
        />
      </View>

      {/* Renders its own "Which proof questions apply?" heading and hint —
          deliberately not re-labelled here, so the reviewer reads the same
          words the author did about the same choice.

          NO `category` CONTEXT, unlike the author's form. There the chips
          FOLLOW the picked category until the person overrides them, which is
          a helpful default on a blank form. Here the chips already hold the
          author's own answer, and having a category change silently retype
          somebody else's testimony is the opposite of helpful. */}
      <ExpenseTypeChips form={form} />

      <CodingFieldSet
        form={form}
        mode="review"
        minPurposeLength={policy?.minPurposeLength ?? MIN_PURPOSE_LENGTH}
        transactionId={transactionId as Id<"transactions">}
      />

      {problems.length > 0 ? (
        <CodingProblemsList
          problems={problems}
          title="Still needed before you can save"
        />
      ) : null}

      <View className="flex-row gap-2">
        <Button
          title="Save corrections"
          size="sm"
          loading={busy}
          disabled={blocked}
          onPress={() => void save()}
        />
        <Button
          title="Cancel"
          size="sm"
          variant="secondary"
          onPress={onDone}
        />
      </View>
    </View>
  );
}
