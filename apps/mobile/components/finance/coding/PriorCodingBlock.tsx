/**
 * PriorCodingBlock — "You've coded this vendor before", for a charge whose
 * merchant already has an APPROVED coding on some other transaction.
 *
 * FOUNDER ASK (2026-08-12): "sometimes there are recurring charges, like
 * subscriptions same exact amount and vendor etc, when coding one it should
 * be smart to auto suggest the coding." `transactionCodings.getForTransaction`
 * now returns `priorCoding` for exactly that shape — the same merchant, same
 * chapter's book, newest APPROVED coding first — and this renders it ABOVE
 * the coding form with ONE explicit action.
 *
 * THE PRINCIPLE THIS GUARDS, same doctrine as `ReimbursementContextBlock` but
 * drawn at a DIFFERENT line: that block carries the CLAIMANT'S OWN testimony
 * about THIS EXACT charge forward (still, deliberately, allowed to prefill a
 * pristine form). This block carries a DIFFERENT charge's testimony — a
 * plausible analogy, not this charge's own words. A different charge's
 * coding is an ANALOGY, not this charge's testimony, so it is NEVER prefill
 * and NEVER auto-applied: the tap is the human deciding it actually fits.
 * `PriorCodingBlock` therefore has no `applyPrefill` counterpart and never
 * will — "Use this coding" (`onUse` → `applyExternalLine`) is the only path
 * in, exactly like a reimbursement line's "Use these answers".
 *
 * ONLY an APPROVED prior coding is ever passed in here (the query already
 * filters to that) — a second person's sign-off is what makes a past coding
 * safe to hold up as a precedent instead of copying one unreviewed guess into
 * another.
 */
import { Text, View } from "react-native";
import {
  ATTENDEE_AFFILIATION_LABELS,
  EXPENSE_TYPE_LABELS,
  formatCents,
  type AttendeeAffiliation,
  type ExpenseType,
} from "@events-os/shared";
import type { FunctionReturnType } from "convex/server";
import type { api } from "@events-os/convex/_generated/api";
import { Button, Icon } from "../../ui";
import { colors } from "../../../lib/theme";

export type PriorCoding = NonNullable<
  FunctionReturnType<typeof api.transactionCodings.getForTransaction>["priorCoding"]
>;

/** Same vocabulary as `ReimbursementContextBlock#lineDetailLine` — "what got
 *  coded" reads identically whether it's this charge's own record or a
 *  vendor precedent being offered as an analogy. */
function detailLine(coding: PriorCoding): string | null {
  const type = coding.expenseType as ExpenseType;
  if (type === "lodging" && coding.travelTo) {
    return `Stayed in ${coding.travelTo}`;
  }
  if (type === "travel" && (coding.travelFrom || coding.travelTo)) {
    return `Route: ${coding.travelFrom ?? "—"} → ${coding.travelTo ?? "—"}`;
  }
  if (type === "meal" && coding.headcount != null) {
    const who =
      coding.attendees && coding.attendees.length > 0
        ? coding.attendees
            .map(
              (a) =>
                `${a.name} (${ATTENDEE_AFFILIATION_LABELS[a.affiliation as AttendeeAffiliation].toLowerCase()})`,
            )
            .join(", ")
        : coding.groupDescription
          ? coding.groupDescription
          : null;
    return `${coding.headcount} ${coding.headcount === 1 ? "person" : "people"}${who ? ` — ${who}` : ""}`;
  }
  return null;
}

function formatWhen(postedAt: number): string {
  return new Date(postedAt).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function PriorCodingBlock({
  priorCoding,
  onUse,
}: {
  priorCoding: PriorCoding | null | undefined;
  /** Fires ONLY on an explicit tap of "Use this coding" — see this file's own
   *  module doc on why that matters. */
  onUse: (coding: PriorCoding) => void;
}) {
  if (!priorCoding) return null;

  const detail = detailLine(priorCoding);

  return (
    <View className="mb-4 gap-2 rounded-lg border border-accent/30 bg-accent/5 px-3 py-3">
      <View className="flex-row items-center gap-2">
        <Icon name="repeat" size={14} color={colors.accent} />
        <Text className="text-2xs font-bold uppercase tracking-wider text-accent">
          You&apos;ve coded this vendor before
        </Text>
      </View>
      <View className="rounded-md border border-border bg-raised px-2.5 py-2">
        <View className="flex-row items-start justify-between gap-2">
          <Text className="flex-1 text-xs font-medium text-ink">
            {priorCoding.merchantName} · {formatWhen(priorCoding.postedAt)}
          </Text>
          <View className="flex-row items-center gap-1.5">
            <Text className="text-xs font-semibold text-ink">
              {formatCents(priorCoding.amountCents)}
            </Text>
            {priorCoding.amountMatches ? (
              <View className="rounded-full bg-accent/15 px-1.5 py-0.5">
                <Text className="text-2xs font-bold uppercase tracking-wide text-accent">
                  Same amount
                </Text>
              </View>
            ) : null}
          </View>
        </View>
        <Text className="mt-0.5 text-2xs text-muted">
          {EXPENSE_TYPE_LABELS[priorCoding.expenseType as ExpenseType]}
        </Text>
        <Text className="mt-1 text-xs text-ink">{priorCoding.businessPurpose}</Text>
        {detail ? <Text className="mt-1 text-2xs text-muted">{detail}</Text> : null}
        {priorCoding.attendees === null && priorCoding.headcount != null ? (
          <Text className="mt-1 text-2xs italic text-faint">
            Names not shown to you on this transaction.
          </Text>
        ) : null}
        <View className="mt-2 flex-row">
          <Button
            title="Use this coding"
            variant="secondary"
            size="sm"
            icon="copy"
            onPress={() => onUse(priorCoding)}
          />
        </View>
      </View>
    </View>
  );
}
