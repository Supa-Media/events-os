/**
 * reimbursementPrefill — WHAT a pristine coding form starts with on a
 * reimbursement payout, decided as data (pure, tested) rather than inline in
 * a component effect.
 *
 * OWNER DIRECTIVE (2026-08-12): "what was it for should auto populate with
 * request purpose notes that we already have, and then I can edit when
 * coding — remove a copy and paste step." This deliberately RELAXES the
 * 2026-08-08 "nothing pre-fills" rule for exactly one kind of text: the
 * CLAIMANT'S OWN authored words about this exact expense, already written
 * once on the reimbursement request (`reimbursementCodingContext`).
 * Machine-GENERATED text stays forbidden everywhere in coding — nothing here
 * composes a sentence; it only carries a human's existing testimony forward,
 * labeled with where it came from, fully editable, and never auto-submitted.
 *
 * The plan is conservative on purpose:
 *  - EXACTLY ONE line with a declared expense type and purpose → carry the
 *    whole substantiation (type, place/route, headcount, attendees, group) —
 *    the same payload an explicit "Use these answers" tap applies.
 *  - Anything else (several lines, or a line missing its type) → carry a
 *    PURPOSE alone into "What was it for?" and leave the per-line "Use these
 *    answers" buttons to say which line's details apply — the machine must
 *    not guess between lines.
 *  - No purpose anywhere → no plan; the form starts blank, exactly as every
 *    non-reimbursement charge always has.
 *
 * Applied ONLY to a pristine form (no existing coding, nothing typed yet) by
 * the hosts' fill-once effects — never over anything a human already wrote.
 */
import type { AttendeeAffiliation, ExpenseType } from "@events-os/shared";

/** The slice of `reimbursementContext` this plan reads — structural, so both
 *  hosts can pass the query's own return value straight through. */
export type PrefillContext = {
  purpose?: string | null;
  lines: {
    expenseType: string | null;
    businessPurpose: string | null;
    travelFrom: string | null;
    travelTo: string | null;
    headcount: number | null;
    attendees: { name: string; affiliation: string }[] | null;
    groupDescription: string | null;
  }[];
};

export type ReimbursementPrefillPlan =
  | {
      kind: "line";
      line: {
        expenseType: ExpenseType;
        businessPurpose: string;
        travelFrom?: string | null;
        travelTo?: string | null;
        headcount?: number | null;
        attendees?: { name: string; affiliation: AttendeeAffiliation }[] | null;
        groupDescription?: string | null;
      };
    }
  | { kind: "purpose"; purpose: string }
  | null;

export function reimbursementPrefillPlan(
  context: PrefillContext | null | undefined,
): ReimbursementPrefillPlan {
  if (!context) return null;
  const lines = context.lines ?? [];

  if (lines.length === 1) {
    const line = lines[0];
    const linePurpose = line.businessPurpose?.trim();
    if (line.expenseType && linePurpose) {
      return {
        kind: "line",
        line: {
          expenseType: line.expenseType as ExpenseType,
          businessPurpose: linePurpose,
          travelFrom: line.travelFrom,
          travelTo: line.travelTo,
          headcount: line.headcount,
          attendees: line.attendees?.map((a) => ({
            name: a.name,
            affiliation: a.affiliation as AttendeeAffiliation,
          })),
          groupDescription: line.groupDescription,
        },
      };
    }
  }

  const requestPurpose = context.purpose?.trim();
  if (requestPurpose) return { kind: "purpose", purpose: requestPurpose };

  // A lone line whose type never got declared still has usable words.
  if (lines.length === 1) {
    const linePurpose = lines[0].businessPurpose?.trim();
    if (linePurpose) return { kind: "purpose", purpose: linePurpose };
  }

  return null;
}
