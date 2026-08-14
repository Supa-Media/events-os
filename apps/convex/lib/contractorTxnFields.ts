/**
 * The descriptive + attribution fields a CONTRACTOR payout transaction inherits
 * from the payment it settles — the contractor-rail twin of
 * `lib/reimbursementTxnFields.ts`.
 *
 * THE ONE THING THIS FILE EXISTS TO GET RIGHT: the payee's name must not reach
 * the public ledger (founder decision, 2026-08-14).
 *
 * The mechanism is indirect enough to be worth spelling out, because a future
 * edit could undo it without looking wrong. `lib/publicLedgerSnapshot.ts` freezes
 * `counterparty: displayMerchantName(txn)` into every published entry, and
 * `displayMerchantName` (packages/shared/src/finance.ts) resolves in this order:
 *
 *     merchantNameOverride  →  payoutProcessor  →  merchantName  →  description
 *
 * So the payee's name is safe ONLY as long as `merchantName` is set to a
 * non-identifying label. If it were left blank, the resolver would fall through
 * to `description` and publish whatever that says — which is exactly the trap,
 * since `description` is the natural place to write who was paid.
 *
 * The split this file therefore makes:
 *   - `merchantName` = `CONTRACTOR_LEDGER_COUNTERPARTY`, a constant. PUBLISHES.
 *   - `description`  = "Contractor payment to <name>". Stays internal, and
 *     surfaces in Reconcile beneath the merchant via `rawBankLine`, which is
 *     what a treasurer reconciling the month actually needs to see.
 *
 * `tests/contractorPayments.test.ts` asserts the published counterparty is the
 * constant and contains no part of the payee's name. That test, not this
 * comment, is what will catch a regression.
 *
 * PURE HELPERS ONLY — nothing in `lib/` registers Convex functions.
 */
import type { QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { CONTRACTOR_LEDGER_COUNTERPARTY } from "@events-os/shared";
import type { CodingWriteFields } from "./transactionCoding";

export type ContractorTxnFields = {
  description?: string;
  merchantName?: string;
  note?: string;
  budgetId?: Id<"budgets">;
  eventId?: Id<"events">;
  projectId?: Id<"projects">;
  categoryId?: Id<"budgetCategories">;
  fundId?: Id<"funds">;
};

export function deriveContractorTxnFields(
  row: Doc<"contractorPayments">,
): ContractorTxnFields {
  const fields: ContractorTxnFields = {};

  // PUBLISHES. A constant, never anything derived from the payee — see the
  // module doc for why this must not be left unset.
  fields.merchantName = CONTRACTOR_LEDGER_COUNTERPARTY;
  // Internal only. Names who was paid so Reconcile is usable.
  fields.description = `Contractor payment to ${row.payeeName}`;

  // The agreement's own long-form terms become the txn note — the "who/why" a
  // bookkeeper would otherwise have to chase back through the payment record.
  const notes = row.agreementNotes?.trim();
  if (notes) fields.note = notes;

  // "For" — the mutually-exclusive event/project/budget target
  // (`createContractorPayment` enforces at most one). Mirrored so the Reconcile
  // "For" column resolves instead of reading "None".
  if (row.budgetId) fields.budgetId = row.budgetId;
  else if (row.eventId) fields.eventId = row.eventId;
  else if (row.projectId) fields.projectId = row.projectId;

  if (row.categoryId) fields.categoryId = row.categoryId;
  if (row.fundId) fields.fundId = row.fundId;

  return fields;
}

/**
 * The coding a contractor payout transaction can be auto-materialized with.
 *
 * Contractor payments materialize their coding UNCONDITIONALLY, where
 * reimbursements only do it for the narrow "exactly one fully-answered line"
 * case. The difference is structural, not a relaxation of the bar: a
 * reimbursement's coding is per-LINE testimony that a machine must never merge,
 * whereas a contractor payment has exactly one piece of work, one description,
 * and one amount — there is nothing to merge, and the description was approved
 * by a reviewer as part of approving the payment.
 *
 * `businessPurpose` IS the service description, which is deliberate and is what
 * makes the public ledger row readable: the published `purpose` column comes
 * from `publicPurpose ?? businessPurpose`, so the sentence the contractor
 * agreed to is the sentence the public sees. `publicPurpose` remains the
 * treasurer's audited redaction hatch if a description needs softening after
 * the fact.
 *
 * `expenseType: "general"`, because `EXPENSE_TYPES` has no `contractor` member
 * and this PR does not add one. Contract labour arguably deserves its own kind,
 * but adding one is not a rename: `codingFieldProblems` decides which §274(d)
 * follow-ups each type demands, the Academy teaches the list, and the public
 * ledger renders it — so it is its own change with its own review, not a
 * side effect of shipping payments. `general` demands only a business purpose,
 * which is exactly what a contractor payment has.
 *
 * AUTHORSHIP is the payee where they have a roster link (they wrote or accepted
 * the description); DECISION is the approver, at the time they approved. Both
 * mirror `deriveReimbursementCodingMaterialization`'s convention exactly.
 */
export type ContractorCodingMaterialization =
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

export async function deriveContractorCodingMaterialization(
  ctx: QueryCtx,
  row: Doc<"contractorPayments">,
): Promise<ContractorCodingMaterialization> {
  // No recorded decision means there is no review to port. Ineligible rather
  // than inventing one — the same bar the reimbursement twin sets.
  if (!row.reviewedByPersonId || row.approvedAt == null) {
    return { eligible: false };
  }

  const fields: CodingWriteFields = {
    expenseType: "general",
    businessPurpose: row.serviceDescription.trim(),
  };

  const payee = row.personId ? await ctx.db.get(row.personId) : null;
  const approver = await ctx.db.get(row.reviewedByPersonId);

  return {
    eligible: true,
    fields,
    ...(row.personId ? { codedByPersonId: row.personId } : {}),
    ...(payee?.userId ? { codedByUserId: payee.userId } : {}),
    decidedByPersonId: row.reviewedByPersonId,
    ...(approver?.userId ? { decidedByUserId: approver.userId } : {}),
    decidedAt: row.approvedAt,
    submittedAt: row.submittedAt ?? row.createdAt,
    // Computed honestly from the record rather than hard-coded, exactly as the
    // reimbursement twin does: `assertContractorApprovalSoD` makes "single"
    // unreachable through the mutation layer today, but the field should tell
    // the truth if that ever changes.
    approvalParty:
      row.personId != null && row.personId === row.reviewedByPersonId
        ? "single"
        : "two_party",
  };
}
