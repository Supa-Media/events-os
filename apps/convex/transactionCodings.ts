/**
 * Transaction codings — the public surface for authoring and reviewing the
 * structured substantiation record on a transaction: what it was, why it
 * served the org's work, and who was involved (travel route, meal attendees).
 * The §274(d) elements a receipt alone doesn't carry. See
 * `docs/plans/transaction-coding.md`.
 *
 * HUMAN-AUTHORED, end to end (owner decision, 2026-08-08): nothing here
 * pre-fills, drafts, or AI-suggests any field — every answer is the author's
 * own words, which is what makes the record the spender's testimony rather
 * than a rubber-stamped guess. The reviewer-side `transactions.aiSuggestion`
 * budget/category hints are a different feature and never touch these rows.
 *
 * Authored by the transaction's own person or a bookkeeper
 * (`lib/transactionCodingAccess.ts`), decided by a finance manager who is NOT
 * the author (separation of duties — every coding, no dollar threshold: the
 * second name is the point). All table + denorm writes go through
 * `lib/transactionCoding.ts`. This file owns validation delegation, SoD, the
 * audit trail, and the redaction of attendee NAMES for callers without
 * `hasCodingNamesView` — names are internal-only forever; the ledger renders
 * the affiliation breakdown instead.
 */
import { mutation, query } from "./_generated/server";
import { v, ConvexError, type Infer } from "convex/values";
import type { QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import {
  ATTENDEE_AFFILIATIONS,
  EXPENSE_TYPES,
  EXPENSE_TYPE_LABELS,
  MIN_PURPOSE_LENGTH,
  TRANSACTION_CODING_STATUSES,
  TRANSACTION_CODING_STATUS_LABELS,
  attendeeAffiliationBreakdown,
  type ExpenseType,
  type TransactionCodingStatus,
} from "@events-os/shared";
import { requireUserId } from "./lib/context";
import { assertSeparationOfDuties } from "./lib/finance";
import { logFinanceAudit } from "./lib/financeAuditLog";
import {
  hasCodingNamesView,
  requireReviewCoding,
  requireSubmitCoding,
} from "./lib/transactionCodingAccess";
import {
  codingForTransaction,
  codingPolicy,
  decideCoding,
  submitCoding,
} from "./lib/transactionCoding";

const expenseTypeValidator = v.union(
  ...EXPENSE_TYPES.map((t) => v.literal(t)),
);
const statusValidator = v.union(
  ...TRANSACTION_CODING_STATUSES.map((s) => v.literal(s)),
);
const attendeeValidator = v.object({
  personId: v.optional(v.id("people")),
  name: v.string(),
  affiliation: v.union(...ATTENDEE_AFFILIATIONS.map((a) => v.literal(a))),
});

const codingRow = v.object({
  _id: v.id("transactionCodings"),
  transactionId: v.id("transactions"),
  expenseType: expenseTypeValidator,
  expenseTypeLabel: v.string(),
  businessPurpose: v.string(),
  travelFrom: v.union(v.string(), v.null()),
  travelTo: v.union(v.string(), v.null()),
  // Attendees/travelers are NULL (not `[]`) for a caller without names-view —
  // the UI renders the breakdown instead and can tell "redacted" from "none".
  travelers: v.union(v.array(attendeeValidator), v.null()),
  headcount: v.union(v.number(), v.null()),
  attendees: v.union(v.array(attendeeValidator), v.null()),
  // What the public ledger renders in place of names — always present.
  affiliationBreakdown: v.record(v.string(), v.number()),
  groupDescription: v.union(v.string(), v.null()),
  status: statusValidator,
  statusLabel: v.string(),
  codedByName: v.union(v.string(), v.null()),
  submittedAt: v.number(),
  updatedAt: v.number(),
  decidedByName: v.union(v.string(), v.null()),
  decidedAt: v.union(v.number(), v.null()),
  reviewNote: v.union(v.string(), v.null()),
});

/** Project one coding for display, redacting names unless the caller holds
 *  names-view on the row. */
async function projectCoding(
  ctx: QueryCtx,
  row: Doc<"transactionCodings">,
  canSeeNames: boolean,
): Promise<Infer<typeof codingRow>> {
  const name = async (personId?: Id<"people">) => {
    if (!personId) return null;
    const person = await ctx.db.get(personId);
    return person?.name ?? null;
  };
  return {
    _id: row._id,
    transactionId: row.transactionId,
    expenseType: row.expenseType,
    expenseTypeLabel: EXPENSE_TYPE_LABELS[row.expenseType as ExpenseType],
    businessPurpose: row.businessPurpose,
    travelFrom: row.travelFrom ?? null,
    travelTo: row.travelTo ?? null,
    travelers: canSeeNames ? (row.travelers ?? null) : null,
    headcount: row.headcount ?? null,
    attendees: canSeeNames ? (row.attendees ?? null) : null,
    affiliationBreakdown: attendeeAffiliationBreakdown(row.attendees ?? []),
    groupDescription: row.groupDescription ?? null,
    status: row.status,
    statusLabel:
      TRANSACTION_CODING_STATUS_LABELS[row.status as TransactionCodingStatus],
    codedByName: await name(row.codedByPersonId),
    submittedAt: row.submittedAt,
    updatedAt: row.updatedAt,
    decidedByName: await name(row.decidedByPersonId),
    decidedAt: row.decidedAt ?? null,
    reviewNote: row.reviewNote ?? null,
  };
}

/** The org's coding policy, for the form: the meal-names threshold, the
 *  purpose length floor, and the policy start date (so the UI can say whether
 *  THIS row is gated or on the voluntary on-ramp). */
export const policy = query({
  args: {},
  returns: v.object({
    sinceMs: v.number(),
    namesMaxHeadcount: v.number(),
    minPurposeLength: v.number(),
  }),
  handler: async (ctx) => {
    const { sinceMs, namesMaxHeadcount } = await codingPolicy(ctx);
    return { sinceMs, namesMaxHeadcount, minPurposeLength: MIN_PURPOSE_LENGTH };
  },
});

/**
 * The coding on one transaction (or null), plus everything the editor needs
 * to render honestly: the policy numbers and whether this row is required to
 * be coded before it can reconcile. Read-gated by the SUBMIT resolver — whoever
 * may author on a row may read what's on it, which keeps a cardholder able to
 * read the send-back note explaining what to fix.
 */
export const getForTransaction = query({
  args: { transactionId: v.id("transactions") },
  returns: v.object({
    coding: v.union(codingRow, v.null()),
    requiresCoding: v.boolean(),
    namesMaxHeadcount: v.number(),
    minPurposeLength: v.number(),
  }),
  handler: async (ctx, args) => {
    const { txn } = await requireSubmitCoding(ctx, args.transactionId);
    const { sinceMs, namesMaxHeadcount } = await codingPolicy(ctx);
    const row = await codingForTransaction(ctx, args.transactionId);
    const canSeeNames = row
      ? await hasCodingNamesView(ctx, args.transactionId)
      : false;
    // Mirrors `finances.requiresCoding` — spend posted at/after the policy
    // date. Kept inline (three fields) rather than importing the whole
    // finances module into this one.
    const requiresCoding =
      txn.postedAt >= sinceMs &&
      txn.flow === "outflow" &&
      txn.status !== "excluded" &&
      txn.isPersonal !== true;
    return {
      coding: row ? await projectCoding(ctx, row, canSeeNames) : null,
      requiresCoding,
      namesMaxHeadcount,
      minPurposeLength: MIN_PURPOSE_LENGTH,
    };
  },
});

/**
 * Author (or revise-and-resubmit) the coding on one transaction. Validation
 * is the shared `codingFieldProblems` — the same list the form renders — so
 * client and server can never disagree about what a complete coding is:
 * purpose ≥ `MIN_PURPOSE_LENGTH`, travel/lodging need a route, meals need a
 * headcount plus names-with-affiliations at/below the org threshold or a
 * group description above it.
 */
export const submit = mutation({
  args: {
    transactionId: v.id("transactions"),
    expenseType: expenseTypeValidator,
    businessPurpose: v.string(),
    travelFrom: v.optional(v.string()),
    travelTo: v.optional(v.string()),
    travelers: v.optional(v.array(attendeeValidator)),
    headcount: v.optional(v.number()),
    attendees: v.optional(v.array(attendeeValidator)),
    groupDescription: v.optional(v.string()),
  },
  returns: v.id("transactionCodings"),
  handler: async (ctx, args) => {
    const { txn, scope, actorPersonId } = await requireSubmitCoding(
      ctx,
      args.transactionId,
    );
    const userId = (await requireUserId(ctx)) as Id<"users">;
    const { namesMaxHeadcount } = await codingPolicy(ctx);
    const existing = await codingForTransaction(ctx, args.transactionId);
    const { codingId, resubmission } = await submitCoding(ctx, {
      txn,
      scope,
      fields: {
        expenseType: args.expenseType,
        businessPurpose: args.businessPurpose,
        ...(args.travelFrom != null ? { travelFrom: args.travelFrom } : {}),
        ...(args.travelTo != null ? { travelTo: args.travelTo } : {}),
        ...(args.travelers ? { travelers: args.travelers } : {}),
        ...(args.headcount != null ? { headcount: args.headcount } : {}),
        ...(args.attendees ? { attendees: args.attendees } : {}),
        ...(args.groupDescription != null
          ? { groupDescription: args.groupDescription }
          : {}),
      },
      namesMaxHeadcount,
      codedByPersonId: actorPersonId,
      codedByUserId: userId,
    });
    await logFinanceAudit(ctx, {
      chapterId: scope,
      subjectType: "transaction",
      subjectId: args.transactionId,
      action: "coding_submit",
      actorPersonId,
      field: "coding",
      before: existing
        ? TRANSACTION_CODING_STATUS_LABELS[
            existing.status as TransactionCodingStatus
          ]
        : "Uncoded",
      after: resubmission ? "Resubmitted" : "Awaiting review",
      // The purpose IS the substance of the round — carrying it here is what
      // makes the audit trail a readable revision history.
      reason: args.businessPurpose.trim(),
      amountCents: txn.amountCents,
    });
    return codingId;
  },
});

/**
 * Approve a coding — it becomes this transaction's substantiation of record
 * and the row can reconcile (documentation permitting).
 *
 * SEPARATION OF DUTIES, every time (no dollar threshold, unlike receipt
 * exceptions): a coding is somebody's testimony about their own spending, and
 * the reviewer must be a different person than the author — including when a
 * manager coded on a cardholder's behalf.
 */
export const approve = mutation({
  args: { transactionId: v.id("transactions") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { scope, actorPersonId } = await requireReviewCoding(
      ctx,
      args.transactionId,
    );
    const coding = await codingForTransaction(ctx, args.transactionId);
    if (!coding) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "This transaction has no coding to approve.",
      });
    }
    if (actorPersonId != null) {
      // Same superuser-with-no-roster-row escape hatch as every other finance
      // approval (see `receiptExceptions.approve`'s comment).
      assertSeparationOfDuties(actorPersonId, coding.codedByPersonId);
    }
    const userId = (await requireUserId(ctx)) as Id<"users">;
    await decideCoding(ctx, {
      coding,
      approve: true,
      decidedByPersonId: actorPersonId,
      decidedByUserId: userId,
    });
    await logFinanceAudit(ctx, {
      chapterId: scope,
      subjectType: "transaction",
      subjectId: args.transactionId,
      action: "coding_decide",
      actorPersonId,
      field: "coding",
      before: TRANSACTION_CODING_STATUS_LABELS[
        coding.status as TransactionCodingStatus
      ],
      after: "Approved",
      amountCents: (await ctx.db.get(args.transactionId))?.amountCents ?? 0,
    });
    return null;
  },
});

/**
 * Send a coding back with a note — "receipt must show exact amount". Works on
 * a `submitted` coding (the everyday loop) and on an `approved` one (the
 * audited way to reopen the record when something turns out wrong). The note
 * is required: the author needs to know what would make it approvable.
 */
export const requestChanges = mutation({
  args: {
    transactionId: v.id("transactions"),
    reviewNote: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { txn, scope, actorPersonId } = await requireReviewCoding(
      ctx,
      args.transactionId,
    );
    const coding = await codingForTransaction(ctx, args.transactionId);
    if (!coding) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "This transaction has no coding to send back.",
      });
    }
    const userId = (await requireUserId(ctx)) as Id<"users">;
    await decideCoding(ctx, {
      coding,
      approve: false,
      reviewNote: args.reviewNote,
      decidedByPersonId: actorPersonId,
      decidedByUserId: userId,
    });
    await logFinanceAudit(ctx, {
      chapterId: scope,
      subjectType: "transaction",
      subjectId: args.transactionId,
      action: "coding_decide",
      actorPersonId,
      field: "coding",
      before: TRANSACTION_CODING_STATUS_LABELS[
        coding.status as TransactionCodingStatus
      ],
      after: "Changes requested",
      reason: args.reviewNote.trim(),
      amountCents: txn.amountCents,
    });
    return null;
  },
});
