/**
 * Transaction codings — the ONE write path for the `transactionCodings` table
 * and the denormalized `transactions.codingState` it maintains.
 *
 * Same single-writer discipline as `lib/receiptExceptions.ts` /
 * `lib/receiptLinks.ts`: nothing outside this module inserts/patches a
 * `transactionCodings` row or touches that denorm. That is why the reconcile
 * grid's `uncoded`/`coding_review` facets and the `CODING_REQUIRED` gate
 * (`finances.setTransactionStatus`) can read `codingState` off a transaction
 * and trust it without a join — it mirrors the at-most-one coding row's
 * `status` exactly.
 *
 * Unlike exceptions (append-mostly, re-filed on rejection) a coding is ONE
 * row per transaction, revised in place: the send-back loop is an edit
 * conversation, and the revision history lives in `financeAuditLog`
 * (`coding_submit` per round, `coding_decide` per decision — logged by the
 * public surface in `transactionCodings.ts`, not here).
 *
 * See `docs/plans/transaction-coding.md` for the design and
 * `schema/finances.ts`'s `transactionCodings` doc comment for the shape.
 */
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { ConvexError } from "convex/values";
import {
  codingFieldProblems,
  DEFAULT_CODING_REQUIRED_SINCE_MS,
  DEFAULT_MEAL_ATTENDEE_NAMES_MAX_HEADCOUNT,
  MAX_PURPOSE_LENGTH,
  type AttendeeAffiliation,
  type ExpenseType,
} from "@events-os/shared";
import type { FinanceScope } from "./finance";

/** The org's coding policy, falling back to the shared owner-decided defaults
 *  (2026-09-01 policy date, names threshold 15). Deliberately has no "off"
 *  value — the policy arms itself on the date; moving it is a deliberate
 *  central-finance act on `financeSettings`. */
export async function codingPolicy(
  ctx: QueryCtx,
): Promise<{ sinceMs: number; namesMaxHeadcount: number }> {
  const settings = await ctx.db.query("financeSettings").first();
  return {
    sinceMs:
      settings?.codingRequiredSinceMs ?? DEFAULT_CODING_REQUIRED_SINCE_MS,
    namesMaxHeadcount:
      settings?.mealAttendeeNamesMaxHeadcount ??
      DEFAULT_MEAL_ATTENDEE_NAMES_MAX_HEADCOUNT,
  };
}

/** The author-editable substance of a coding, server-side (typed person ids —
 *  the shared `TransactionCodingFields` keeps them as strings so the package
 *  stays server-agnostic). */
export interface CodingWriteFields {
  expenseType: ExpenseType;
  businessPurpose: string;
  travelFrom?: string;
  travelTo?: string;
  travelers?: {
    personId?: Id<"people">;
    name: string;
    affiliation: AttendeeAffiliation;
  }[];
  headcount?: number;
  attendees?: {
    personId?: Id<"people">;
    name: string;
    affiliation: AttendeeAffiliation;
  }[];
  groupDescription?: string;
}

/** The at-most-one coding on a transaction. Single-writer discipline is what
 *  makes `.unique()` safe here. */
export async function codingForTransaction(
  ctx: QueryCtx,
  transactionId: Id<"transactions">,
): Promise<Doc<"transactionCodings"> | null> {
  return ctx.db
    .query("transactionCodings")
    .withIndex("by_transaction", (q) => q.eq("transactionId", transactionId))
    .unique();
}

/**
 * Validate + normalize a coding's fields against the org's meal-names
 * threshold. Throws the FIRST problem as a `ConvexError` with the shared
 * problem code, so the form (which renders the same `codingFieldProblems`
 * list client-side) and the server can never disagree about what a complete
 * coding is. Returns the trimmed fields, with type-irrelevant ones dropped —
 * a coding retyped from "travel" to "general" must not keep a stale route.
 */
export function normalizeCodingFields(
  fields: CodingWriteFields,
  namesMaxHeadcount: number,
): CodingWriteFields {
  const problems = codingFieldProblems(
    {
      ...fields,
      attendees: fields.attendees?.map((a) => ({
        ...(a.personId ? { personId: a.personId } : {}),
        name: a.name,
        affiliation: a.affiliation,
      })),
    },
    namesMaxHeadcount,
  );
  if (problems.length > 0) {
    throw new ConvexError({
      code: problems[0].code,
      message: problems[0].message,
    });
  }
  const trimPeople = (
    list?: CodingWriteFields["attendees"],
  ): CodingWriteFields["attendees"] =>
    list?.map((a) => ({
      ...(a.personId ? { personId: a.personId } : {}),
      name: a.name.trim(),
      affiliation: a.affiliation,
    }));
  const isTravelish =
    fields.expenseType === "travel" || fields.expenseType === "lodging";
  const isMeal = fields.expenseType === "meal";
  const attendees = isMeal ? trimPeople(fields.attendees) : undefined;
  const travelers = isTravelish ? trimPeople(fields.travelers) : undefined;
  const groupDescription = isMeal
    ? fields.groupDescription?.trim() || undefined
    : undefined;
  // `travelers`/`groupDescription` above are optional context —
  // `codingFieldProblems` owns the REQUIRED checks; this only bounds them.
  if ((travelers?.length ?? 0) > 50) {
    throw new ConvexError({
      code: "TOO_MANY_TRAVELERS",
      message: "List at most 50 travelers.",
    });
  }
  return {
    expenseType: fields.expenseType,
    businessPurpose: fields.businessPurpose.trim(),
    ...(isTravelish
      ? {
          travelFrom: fields.travelFrom?.trim(),
          travelTo: fields.travelTo?.trim(),
        }
      : {}),
    ...(travelers?.length ? { travelers } : {}),
    ...(isMeal ? { headcount: fields.headcount } : {}),
    ...(attendees?.length ? { attendees } : {}),
    ...(groupDescription ? { groupDescription } : {}),
  };
}

/**
 * Submit (or resubmit) the coding on one transaction — upsert into the
 * at-most-one row, status → `submitted`, denorm in lock-step.
 *
 * An `approved` coding is refused: the substantiation of record doesn't get
 * silently rewritten under the reviewer who approved it. The path to amend
 * one is a reviewer reopening it (`requestChanges` works on an approved row),
 * which is itself an audited decision.
 */
export async function submitCoding(
  ctx: MutationCtx,
  args: {
    txn: Doc<"transactions">;
    scope: FinanceScope;
    fields: CodingWriteFields;
    namesMaxHeadcount: number;
    codedByPersonId: Id<"people"> | null;
    codedByUserId: Id<"users">;
  },
): Promise<{ codingId: Id<"transactionCodings">; resubmission: boolean }> {
  const fields = normalizeCodingFields(args.fields, args.namesMaxHeadcount);
  // THE OTHER HALF OF THE LODGING RULE. `lib/receiptExceptions.ts` refuses a
  // `bank_record_only` exception on a charge already coded `lodging` — but
  // the two facts arrive in either order, and nothing stopped the cheaper
  // sequence: file the bank-record exception on an uncoded charge (where the
  // guard reads no `expenseType` and passes), let it auto-approve under the
  // small-dollar threshold, and only then code it as lodging. The rule would
  // be enforced or not depending purely on which button someone pressed
  // first, which is not a rule.
  //
  // So typing a charge as lodging is refused while a bank-record exception
  // stands on it. Withdrawing the exception is one tap and is the honest
  // move: the folio either exists or a different reason is the true one.
  if (fields.expenseType === "lodging") {
    const exceptions = await ctx.db
      .query("receiptExceptions")
      .withIndex("by_transaction", (q) => q.eq("transactionId", args.txn._id))
      .collect();
    const bankRecord = exceptions.find(
      (e) =>
        e.reason === "bank_record_only" &&
        (e.status === "approved" || e.status === "pending"),
    );
    if (bankRecord) {
      throw new ConvexError({
        code: "LODGING_RECEIPT_REQUIRED",
        message:
          "This charge is documented by a bank record only, which the IRS doesn't accept for lodging at any amount — a statement line can't show what the stay covered. Withdraw that receipt exception and attach the hotel's itemized folio, or code this as something other than lodging if that's what it really was.",
      });
    }
  }
  const existing = await codingForTransaction(ctx, args.txn._id);
  const now = Date.now();
  if (existing) {
    if (existing.status === "approved") {
      throw new ConvexError({
        code: "CODING_APPROVED",
        message:
          "This transaction's coding is already approved. Ask a reviewer to reopen it if something needs to change.",
      });
    }
    await ctx.db.replace(existing._id, {
      transactionId: existing.transactionId,
      chapterId: existing.chapterId,
      ...fields,
      status: "submitted",
      ...(args.codedByPersonId
        ? { codedByPersonId: args.codedByPersonId }
        : {}),
      codedByUserId: args.codedByUserId,
      submittedAt: existing.submittedAt,
      updatedAt: now,
      // A resubmission answers the send-back — the stale note and decision
      // must not keep rendering against the new content.
    });
    await ctx.db.patch(args.txn._id, { codingState: "submitted" });
    return { codingId: existing._id, resubmission: true };
  }
  const codingId = await ctx.db.insert("transactionCodings", {
    transactionId: args.txn._id,
    chapterId: args.scope,
    ...fields,
    status: "submitted",
    ...(args.codedByPersonId ? { codedByPersonId: args.codedByPersonId } : {}),
    codedByUserId: args.codedByUserId,
    submittedAt: now,
    updatedAt: now,
  });
  await ctx.db.patch(args.txn._id, { codingState: "submitted" });
  return { codingId, resubmission: false };
}

/**
 * Record a decision and keep the denorm in lock-step.
 *
 *  - APPROVE: only a `submitted` coding; clears any send-back note.
 *  - REQUEST CHANGES: a `submitted` OR `approved` coding (reopening an
 *    approved one is the audited amendment path), note REQUIRED — "rejected,
 *    no explanation" is how a policy stops being followed.
 */
export async function decideCoding(
  ctx: MutationCtx,
  args: {
    coding: Doc<"transactionCodings">;
    approve: boolean;
    reviewNote?: string;
    decidedByPersonId: Id<"people"> | null;
    decidedByUserId: Id<"users">;
  },
): Promise<void> {
  const reviewNote = args.reviewNote?.trim() || undefined;
  if (args.approve) {
    if (args.coding.status !== "submitted") {
      throw new ConvexError({
        code: "NOT_SUBMITTED",
        message: "Only a coding awaiting review can be approved.",
      });
    }
  } else {
    if (args.coding.status === "changes_requested") {
      throw new ConvexError({
        code: "ALREADY_SENT_BACK",
        message: "This coding is already back with its author.",
      });
    }
    if (!reviewNote) {
      throw new ConvexError({
        code: "REASON_REQUIRED",
        message:
          "Sending a coding back requires a note — the author needs to know what would make it approvable.",
      });
    }
    if (reviewNote.length > MAX_PURPOSE_LENGTH) {
      throw new ConvexError({
        code: "NOTE_TOO_LONG",
        message: `Keep the note under ${MAX_PURPOSE_LENGTH} characters.`,
      });
    }
  }
  const status = args.approve ? "approved" : "changes_requested";
  await ctx.db.patch(args.coding._id, {
    status,
    ...(args.decidedByPersonId
      ? { decidedByPersonId: args.decidedByPersonId }
      : {}),
    decidedByUserId: args.decidedByUserId,
    decidedAt: Date.now(),
    reviewNote: args.approve ? undefined : reviewNote,
  });
  await ctx.db.patch(args.coding.transactionId, { codingState: status });
}
