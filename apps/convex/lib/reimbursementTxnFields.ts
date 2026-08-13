/**
 * The descriptive + attribution fields a reimbursement PAYOUT transaction should
 * inherit from the reimbursement it settles. Without this, `postReimbursementSpend`
 * (increase.ts) writes a bare row — no category, no "For", no purpose, no
 * receipt, no merchant — so every paid reimbursement lands in Reconcile as an
 * "Unlabeled charge / Uncategorized / For: None / missing receipt", inflating
 * the missing-receipt + uncategorized backlogs even though all of it is
 * already captured on the reimbursement.
 *
 * The payout row is `flow:"outflow"` — the reimbursed purchase IS the
 * chapter's expense, and this row is the only place it enters the ledger — so
 * these fields are the row's LIVE attribution: the category/fund/"For" ported
 * here are what the budget and category rollups actually read. Anything left
 * ambiguous (see `unanimous`) stays unset for a bookkeeper to code in
 * Reconcile rather than being guessed into the wrong budget.
 *
 * Shared by the live insert path (`increase.ts#postReimbursementSpend`) and
 * the one-shot backfill (`reimbursementBackfill.ts`).
 */
import type { QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { codingFieldProblems, type ExpenseType } from "@events-os/shared";
import type { CodingWriteFields } from "./transactionCoding";

export type ReimbursementTxnFields = {
  description?: string;
  merchantName?: string;
  note?: string;
  budgetId?: Id<"budgets">;
  eventId?: Id<"events">;
  projectId?: Id<"projects">;
  categoryId?: Id<"budgetCategories">;
  fundId?: Id<"funds">;
};

/** The single value shared by every element of `ids`, or `undefined` when the
 *  set is empty or the elements disagree — the "port only when unambiguous"
 *  rule for per-line category/fund. */
function unanimous<T>(ids: (T | undefined)[]): T | undefined {
  const present = ids.filter((x): x is T => x != null);
  if (present.length === 0) return undefined;
  const first = present[0];
  return present.every((x) => x === first) ? first : undefined;
}

/** How many line descriptions a merchant name spells out before it summarizes
 *  the rest. Two fits a Reconcile cell; past that the row stops being scannable
 *  and the count carries more than a truncated third title would. */
const MERCHANT_LINES_SHOWN = 2;

/**
 * The lines, as one merchant-name string: "Bus ticket + Parking" for two,
 * "Bus ticket + Parking +2 more" beyond that. `""` when no line carries a
 * description, which is the caller's cue to fall back to the payee label —
 * a row named after nothing is worse than one named after who was paid.
 */
function lineSummary(lines: Doc<"reimbursementLineItems">[]): string {
  const described = lines
    .map((l) => l.description?.trim())
    .filter((d): d is string => !!d);
  if (described.length === 0) return "";
  const shown = described.slice(0, MERCHANT_LINES_SHOWN);
  const rest = described.length - shown.length;
  return rest > 0 ? `${shown.join(" + ")} +${rest} more` : shown.join(" + ");
}

export async function deriveReimbursementTxnFields(
  ctx: QueryCtx,
  req: Doc<"reimbursementRequests">,
): Promise<ReimbursementTxnFields> {
  // Bounded like `reimbursements.ts#linesFor` — a reimbursement has a handful
  // of lines, never an unbounded list.
  const lines = await ctx.db
    .query("reimbursementLineItems")
    .withIndex("by_reimbursement", (q) => q.eq("reimbursementId", req._id))
    .take(200);

  const fields: ReimbursementTxnFields = {};

  // Purpose → the txn note (the "who/why" a bookkeeper would otherwise chase).
  const purpose = req.purpose?.trim();
  if (purpose) fields.note = purpose;

  // "For" — the reimbursement's mutually-exclusive event/project/budget target
  // (createReimbursement enforces at most one). Mirror it so the Reconcile "For"
  // column resolves instead of reading "None".
  if (req.budgetId) fields.budgetId = req.budgetId;
  else if (req.eventId) fields.eventId = req.eventId;
  else if (req.projectId) fields.projectId = req.projectId;

  // Merchant / description label.
  //
  // WHAT IT WAS, NOT WHO WE PAID (founder, 2026-08-12: "I hate that the line
  // item is reimbursed to Adam — the line item should read what it actually
  // was"). A single-line reimbursement already read correctly; a multi-line one
  // collapsed to the payee label, so a Reconcile row for a bus ticket and a
  // parking fee said only that Adam got money, which is the one fact the amount
  // and the payee column were already telling you.
  //
  // So the lines name the row, joined, and the payee label becomes the row's
  // `description` — where `displayMerchantName` uses it only as a fallback and
  // `rawBankLine` surfaces it BENEATH the merchant when the two differ. Both
  // facts stay on screen; only the billing order changes.
  const payeeLabel = `Reimbursement to ${req.payeeName}`;
  fields.merchantName = lineSummary(lines) || payeeLabel;
  fields.description = payeeLabel;

  // Category / fund live per line. Port only when UNAMBIGUOUS (one line, or all
  // lines agree), else leave it for the bookkeeper rather than guess.
  const categoryId = unanimous(lines.map((l) => l.categoryId));
  if (categoryId) fields.categoryId = categoryId;
  const fundId = unanimous(lines.map((l) => l.fundId));
  if (fundId) fields.fundId = fundId;

  // RECEIPTS ARE NOT PORTED HERE ANY MORE. This used to copy the first line's
  // `receiptStorageId` straight onto the transaction — but that field is a
  // denormalized CACHE of the first-linked receipt, and writing it without
  // creating the `receipts`/`receiptLinks` rows behind it left the row claiming
  // a receipt the library had never heard of. That is exactly the two-sided
  // symptom the founder hit: "there is no receipt, but it says attached … but
  // it's not in the file."
  //
  // `lib/reimbursementReceipts.ts#materializeReimbursementReceipts` now does it
  // properly — a real receipt per line, linked through the one write path,
  // which sets this same cache as a side effect. Callers run it right after
  // inserting/locating the payout transaction.

  return fields;
}

/**
 * The outcome of `deriveReimbursementCodingMaterialization`: either the
 * ported coding fields + authorship/decision facts a payout transaction may
 * be auto-coded with, or `{ eligible: false }` when this request doesn't meet
 * the deliberately narrow bar — a MACHINE must never merge or summarize
 * lines, so anything short of "exactly one line, completely answered" falls
 * back to today's flow (the `reimbursementContext` prefill in
 * `transactionCodings.ts`, edited and submitted by a human).
 */
export type ReimbursementCodingMaterialization =
  | { eligible: false }
  | {
      eligible: true;
      fields: CodingWriteFields;
      codedByPersonId?: Id<"people">;
      codedByUserId?: Id<"users">;
      decidedByPersonId?: Id<"people">;
      decidedByUserId?: Id<"users">;
      decidedAt: number;
      submittedAt: number;
      approvalParty: "single" | "two_party";
    };

/**
 * Decide whether a reimbursement request's own approved testimony can be
 * PORTED straight onto its payout transaction's coding, and if so, everything
 * `materializePortedReimbursementCoding` needs to write it (founder
 * directive, 2026-08-13): a payout transaction should never ask a human to
 * re-type testimony the claimant already wrote AND a reviewer already
 * approved.
 *
 * THE RULE (v1, deliberately narrow):
 *  - EXACTLY ONE line item — a multi-line request keeps today's flow; a
 *    machine must never merge or summarize several lines' testimony into one
 *    coding.
 *  - that line's own §274(d) answer, PORTED VERBATIM, reports NO problems
 *    from the shared `codingFieldProblems` validator — the SAME bar a human
 *    submission has to clear, run here instead of trusted blind. Travel
 *    needs its route, meals need a headcount + names-or-group, etc.
 *  - the REQUEST itself has to actually be decided — `reviewedByPersonId` +
 *    `approvedAt` both set. Without a real decision on record there is no
 *    review to "not re-stage"; ineligible rather than inventing one.
 *
 * AUTHORSHIP is the claimant (`req.personId`, when the request has a roster
 * link) — never the approver. DECISION is whoever approved the request
 * (`req.reviewedByPersonId`) at the time they approved it (`req.approvedAt`)
 * — the request review WAS the coding review. `approvalParty` mirrors the
 * request's own approval shape: "single" iff the approver was also the
 * claimant (the same self-approval bypass `transactionCodings.approve`
 * records — reimbursements enforce separation of duties absolutely today via
 * `assertApprovalSoD`, so this branch is not currently reachable through the
 * mutation layer, but the field is computed honestly from the request's own
 * records rather than hard-coded, in case that ever changes), else
 * "two_party".
 *
 * `codedByUserId`/`decidedByUserId` are resolved from `people.userId` when
 * the corresponding person has a linked account — an accountless public
 * claimant has neither, and both stay `undefined` rather than falling back to
 * whoever happened to trigger the payout (see `codedByUserId`'s schema doc).
 *
 * Pure read — `QueryCtx` only, no write. The caller
 * (`increasePayoutMachine.ts#postReimbursementSpend`, the `0068` migration)
 * decides whether/when to call `materializePortedReimbursementCoding` with
 * the result.
 */
export async function deriveReimbursementCodingMaterialization(
  ctx: QueryCtx,
  req: Doc<"reimbursementRequests">,
  namesMaxHeadcount: number,
): Promise<ReimbursementCodingMaterialization> {
  if (!req.reviewedByPersonId || req.approvedAt == null) {
    return { eligible: false };
  }
  // Bounded exactly like `deriveReimbursementTxnFields` above.
  const lines = await ctx.db
    .query("reimbursementLineItems")
    .withIndex("by_reimbursement", (q) => q.eq("reimbursementId", req._id))
    .take(200);
  if (lines.length !== 1) return { eligible: false };
  const line = lines[0];
  if (!line.expenseType) return { eligible: false };

  const fields: CodingWriteFields = {
    expenseType: line.expenseType as ExpenseType,
    businessPurpose: (line.businessPurpose ?? "").trim(),
    ...(line.travelFrom ? { travelFrom: line.travelFrom } : {}),
    ...(line.travelTo ? { travelTo: line.travelTo } : {}),
    ...(line.headcount != null ? { headcount: line.headcount } : {}),
    ...(line.attendees?.length
      ? {
          attendees: line.attendees.map((a) => ({
            ...(a.personId ? { personId: a.personId } : {}),
            name: a.name,
            affiliation: a.affiliation,
          })),
        }
      : {}),
    ...(line.groupDescription ? { groupDescription: line.groupDescription } : {}),
  };
  // THE SHARED VALIDATOR, run against the ported value — a machine porting a
  // line must clear the identical bar a human submission does, never a
  // looser one. Any problem (missing route, headcount/name mismatch, etc.)
  // means this line isn't actually complete and falls back to the human flow.
  if (codingFieldProblems(fields, namesMaxHeadcount).length > 0) {
    return { eligible: false };
  }

  const claimant = req.personId ? await ctx.db.get(req.personId) : null;
  const approver = await ctx.db.get(req.reviewedByPersonId);

  return {
    eligible: true,
    fields,
    ...(req.personId ? { codedByPersonId: req.personId } : {}),
    ...(claimant?.userId ? { codedByUserId: claimant.userId } : {}),
    decidedByPersonId: req.reviewedByPersonId,
    ...(approver?.userId ? { decidedByUserId: approver.userId } : {}),
    decidedAt: req.approvedAt,
    submittedAt: req.submittedAt ?? req.createdAt,
    approvalParty:
      req.personId != null && req.personId === req.reviewedByPersonId
        ? "single"
        : "two_party",
  };
}
