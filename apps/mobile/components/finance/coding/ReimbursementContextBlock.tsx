/**
 * ReimbursementContextBlock — "What the claimant already wrote", for a
 * reimbursement payout transaction's coding form.
 *
 * FINDING 1 (HIGH, UX audit 2026-08-12), founder-framed: "does Seyi have all
 * the info he needs to code everything himself line by line easily,
 * including things he's already coded or comments he has already added
 * elsewhere." `postReimbursementSpend` books the payout with
 * `reimbursementId` set, but nothing that codes the resulting transaction
 * could see a word the claimant already wrote — a bookkeeper coding a
 * reimbursement payout was re-typing testimony that already exists,
 * verbatim, on `reimbursementLineItems` one table away.
 *
 * `transactionCodings.getForTransaction` now returns `reimbursementContext`
 * for exactly this transaction shape (`source:"reimbursement"`); this
 * renders it ABOVE the coding form and offers ONE explicit action per line.
 *
 * THE PRINCIPLE THIS GUARDS: this is the CLAIMANT'S OWN authored testimony
 * about THIS EXACT EXPENSE — the same person, the same charge, already
 * substantiated once on the request form. Carrying it into the coding form
 * is not machine authorship and not a guess; it is a human's existing words
 * about this exact spend, moved one screen over.
 *
 * OWNER DIRECTIVE (2026-08-12): "what was it for should auto populate with
 * request purpose notes that we already have, and then I can edit when
 * coding — remove a copy and paste step." So a PRISTINE coding form now
 * STARTS from these words (`reimbursementPrefill.ts` decides exactly what
 * carries; the hosts' fill-once effects apply it, with a provenance line,
 * everything editable, nothing auto-submitted). Machine-GENERATED text stays
 * forbidden everywhere in coding — the 2026-08-08 "no AI, no autofill" rule
 * still bans composing an answer; what changed is that the claimant's own
 * authored text is no longer treated as if a machine had written it.
 *
 * The per-line "Use these answers" button remains the explicit path for the
 * cases prefill deliberately won't touch: a multi-line request (the machine
 * must not guess which line this coding is about) and a form that already
 * has content. It fires `onUseLine` → `applyExternalLine`.
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

type ReimbursementContext = NonNullable<
  FunctionReturnType<typeof api.transactionCodings.getForTransaction>["reimbursementContext"]
>;
type ReimbursementLine = ReimbursementContext["lines"][number];

/** One line's place/route/headcount, phrased for a human reading it back —
 *  mirrors how `TransactionCodingSection` already renders a SUBMITTED
 *  coding's own extras, so "what the claimant wrote" and "what got coded"
 *  read as the same vocabulary. */
function lineDetailLine(line: ReimbursementLine): string | null {
  const type = line.expenseType as ExpenseType | null;
  if (type === "lodging" && line.travelTo) {
    return `Stayed in ${line.travelTo}`;
  }
  if (type === "travel" && (line.travelFrom || line.travelTo)) {
    return `Route: ${line.travelFrom ?? "—"} → ${line.travelTo ?? "—"}`;
  }
  if (type === "meal" && line.headcount != null) {
    const who =
      line.attendees && line.attendees.length > 0
        ? line.attendees
            .map(
              (a) =>
                `${a.name} (${ATTENDEE_AFFILIATION_LABELS[a.affiliation as AttendeeAffiliation].toLowerCase()})`,
            )
            .join(", ")
        : line.groupDescription
          ? line.groupDescription
          : null;
    return `${line.headcount} ${line.headcount === 1 ? "person" : "people"}${who ? ` — ${who}` : ""}`;
  }
  return null;
}

export function ReimbursementContextBlock({
  context,
  onUseLine,
}: {
  context: ReimbursementContext | null | undefined;
  /** Fires ONLY on an explicit tap of "Use these answers" — see this file's
   *  own module doc on why that matters. */
  onUseLine: (line: ReimbursementLine) => void;
}) {
  if (!context) return null;

  return (
    <View className="mb-4 gap-2.5 rounded-lg border border-accent/30 bg-accent/5 px-3 py-3">
      <View className="flex-row items-center gap-2">
        <Icon name="file-text" size={14} color={colors.accent} />
        <Text className="text-2xs font-bold uppercase tracking-wider text-accent">
          What the claimant already wrote
        </Text>
      </View>
      <Text className="text-2xs text-muted">
        {context.reference} · {context.payeeName} already answered these
        questions on the reimbursement request, so the form below starts from
        their words where it can. Everything stays editable, and nothing
        submits on its own — &quot;Use these answers&quot; copies a line in
        when the form didn&apos;t start from it.
      </Text>
      {context.purpose ? (
        <View className="rounded-md border border-border bg-raised px-2.5 py-2">
          <Text className="text-2xs font-semibold uppercase tracking-wide text-muted">
            Request purpose
          </Text>
          <Text className="mt-0.5 text-xs text-ink">{context.purpose}</Text>
        </View>
      ) : null}
      <View className="gap-2">
        {context.lines.map((line) => {
          const detail = lineDetailLine(line);
          return (
            <View
              key={line.id}
              className="rounded-md border border-border bg-raised px-2.5 py-2"
            >
              <View className="flex-row items-start justify-between gap-2">
                <Text className="flex-1 text-xs font-medium text-ink" numberOfLines={1}>
                  {line.description}
                </Text>
                <Text className="text-xs font-semibold text-ink">
                  {formatCents(line.amountCents)}
                </Text>
              </View>
              {line.expenseType ? (
                <Text className="mt-0.5 text-2xs text-muted">
                  {EXPENSE_TYPE_LABELS[line.expenseType as ExpenseType]}
                </Text>
              ) : null}
              {line.businessPurpose ? (
                <Text className="mt-1 text-xs text-ink">{line.businessPurpose}</Text>
              ) : null}
              {detail ? (
                <Text className="mt-1 text-2xs text-muted">{detail}</Text>
              ) : null}
              {/* `attendeesRedacted` (not `attendees === null`, review finding
                  2026-08-13): a group-description line (>15 heads) also has
                  `attendees === null`, but there was nothing to redact — that
                  must never read as "hidden from you" to a caller who
                  actually holds full names-view. */}
              {line.attendeesRedacted ? (
                <Text className="mt-1 text-2xs italic text-faint">
                  Names not shown to you on this transaction.
                </Text>
              ) : null}
              {/* A REAL BUTTON (founder, 2026-08-12: "I see there is a tap
                  but I don't see an actual button to tap") — this shipped as
                  a 2xs underlined text link and didn't read as tappable.
                  Shown whenever the line has ANYTHING copyable, not only
                  when both type and purpose are present: a partial line is
                  still a head start, and the host fills sensible fallbacks
                  (`onUseLine`'s mapping). */}
              {line.businessPurpose ||
              line.expenseType ||
              line.travelFrom ||
              line.travelTo ||
              line.headcount != null ||
              line.groupDescription ? (
                <View className="mt-2 flex-row">
                  <Button
                    title="Use these answers"
                    variant="secondary"
                    size="sm"
                    icon="copy"
                    onPress={() => onUseLine(line)}
                  />
                </View>
              ) : null}
            </View>
          );
        })}
      </View>
    </View>
  );
}
