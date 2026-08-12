/**
 * Transaction codings — the public surface for authoring and reviewing the
 * structured substantiation record on a transaction: what it was, why it
 * served the org's work, and who was involved (travel route, meal attendees).
 * The §274(d) elements a receipt alone doesn't carry. See
 * `docs/plans/transaction-coding.md`.
 *
 * HUMAN-AUTHORED, end to end (owner decision, 2026-08-08): nothing here
 * drafts or AI-suggests any field — every answer is a human's own words,
 * which is what makes the record the spender's testimony rather than a
 * rubber-stamped guess. The reviewer-side AI budget/category hints that once
 * sat beside this in the Reconcile grid were a separate feature, never
 * touched these rows, and were removed outright shortly after this shipped.
 * ONE deliberate carve-out (owner directive, 2026-08-12): a reimbursement
 * payout's coding form may START from the claimant's own request text
 * (`reimbursementContext` below) — existing human testimony carried forward,
 * editable, never machine-composed. Machine-GENERATED text stays forbidden.
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
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  ATTENDEE_AFFILIATIONS,
  CENTRAL,
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
import { referenceFor } from "./reimbursements";
import { assertSeparationOfDuties } from "./lib/finance";
import { logFinanceAudit } from "./lib/financeAuditLog";
import {
  hasCodingNamesView,
  hasReviewCoding,
  maySelfDecideCoding,
  requireReviewCoding,
  requireSubmitCoding,
  requireViewCoding,
} from "./lib/transactionCodingAccess";
import {
  codingForTransaction,
  codingPolicy,
  decideCoding,
  submitCoding,
} from "./lib/transactionCoding";
import { codingReviewReach } from "./lib/transactionCodingAccess";
import { isUncodedCharge } from "./lib/codingReminders";
import { listActiveChapters } from "./lib/chapters";
import { getChapterIdOrNull, requireChapterId } from "./lib/context";
import {
  assertBudgetAttributable,
  isAttributableBudget,
} from "./finances";
import { gatherForPickerCandidates } from "./lib/forPickerCandidates";
import { viewerPerson } from "./lib/org";

/** Generous bounds for the Coding tab's scans — a chapter's open coding work
 *  runs to dozens, never near this (mirrors `FUND_SCAN_LIMIT`'s reasoning in
 *  `lib/finance.ts`). */
const CODING_SCAN_LIMIT = 5000;
/** One page of the reviewer's queue. Deliberately small: this is a screen
 *  someone works down, not a report they scroll. */
const CODING_PAGE_SIZE = 100;

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
  /** The APPROVER's public-facing rewrite, when one exists. Null means the
   *  author's own `businessPurpose` is what publishes. Both are always sent
   *  to internal surfaces — redaction is not falsification, so the record
   *  shows what was written and what will be published, side by side. */
  publicPurpose: v.union(v.string(), v.null()),
  publicPurposeByName: v.union(v.string(), v.null()),
  publicPurposeAt: v.union(v.number(), v.null()),
  status: statusValidator,
  statusLabel: v.string(),
  codedByName: v.union(v.string(), v.null()),
  submittedAt: v.number(),
  updatedAt: v.number(),
  decidedByName: v.union(v.string(), v.null()),
  decidedAt: v.union(v.number(), v.null()),
  reviewNote: v.union(v.string(), v.null()),
});

/** One reimbursement line's already-authored substantiation, as surfaced to
 *  a coder of the payout transaction (Finding 1, UX audit 2026-08-12). Same
 *  shape as a coding's own fields — the claimant answered the identical
 *  §274(d) questions on the request form (`CodingFields.tsx` /
 *  `reimbursePage.ts`), so it maps onto the SAME form via "Use these
 *  answers" with no translation. `attendees` is `null` for a caller without
 *  names-view — the SAME redaction `codingRow.attendees` gets, never a
 *  separate rule for this surface. */
const reimbursementLineContext = v.object({
  id: v.id("reimbursementLineItems"),
  description: v.string(),
  amountCents: v.number(),
  expenseType: v.union(expenseTypeValidator, v.null()),
  businessPurpose: v.union(v.string(), v.null()),
  travelFrom: v.union(v.string(), v.null()),
  travelTo: v.union(v.string(), v.null()),
  headcount: v.union(v.number(), v.null()),
  attendees: v.union(v.array(attendeeValidator), v.null()),
  groupDescription: v.union(v.string(), v.null()),
});

/**
 * "What the claimant already wrote" — the originating reimbursement request's
 * purpose + every line's own substantiation, for a payout transaction
 * (`source:"reimbursement"`). `null` for anything else (the vast majority of
 * codings, which have no reimbursement behind them at all).
 *
 * WHY THIS EXISTS (Finding 1, UX audit 2026-08-12, founder-framed): "does
 * Seyi have all the info he needs to code everything himself line by line
 * easily, including things he's already coded or comments he has already
 * added elsewhere." `postReimbursementSpend` books the payout with
 * `reimbursementId` set, but until this, nothing that codes the resulting
 * transaction could see a word the claimant wrote — a bookkeeper coding a
 * reimbursement payout was re-typing testimony that already exists, verbatim,
 * one table away.
 *
 * ACCESS: the SAME bar as reading the coding itself — `canSeeNames` is
 * `hasCodingNamesView` on this exact transaction, the identical redaction a
 * coding's own `attendees` field gets. This is the same charge's record, so
 * whoever may view the coding may see this.
 */
async function reimbursementCodingContext(
  ctx: QueryCtx,
  txn: Doc<"transactions">,
  canSeeNames: boolean,
): Promise<{
  requestId: Id<"reimbursementRequests">;
  reference: string;
  purpose: string | null;
  payeeName: string;
  lines: Infer<typeof reimbursementLineContext>[];
} | null> {
  if (txn.source !== "reimbursement" || !txn.reimbursementId) return null;
  const req = await ctx.db.get(txn.reimbursementId);
  if (!req) return null;
  // Bounded exactly like `deriveReimbursementTxnFields` — a reimbursement
  // has a handful of lines, never an unbounded list.
  const lines = await ctx.db
    .query("reimbursementLineItems")
    .withIndex("by_reimbursement", (q) => q.eq("reimbursementId", req._id))
    .take(200);
  return {
    requestId: req._id,
    reference: referenceFor(req._id),
    purpose: req.purpose?.trim() || null,
    payeeName: req.payeeName,
    lines: lines.map((l) => ({
      id: l._id,
      description: l.description,
      amountCents: l.amountCents,
      expenseType: (l.expenseType as ExpenseType | undefined) ?? null,
      businessPurpose: l.businessPurpose ?? null,
      travelFrom: l.travelFrom ?? null,
      travelTo: l.travelTo ?? null,
      headcount: l.headcount ?? null,
      // NAMES ARE THE CLAIMANT'S OWN TESTIMONY about who was there — same
      // internal-only rule as a coding's own attendee list. Redacted (never
      // just omitted) so the shape always tells the client WHY it's empty.
      attendees:
        canSeeNames && l.attendees
          ? l.attendees.map((a) => ({
              personId: a.personId,
              name: a.name,
              affiliation: a.affiliation,
            }))
          : null,
      groupDescription: l.groupDescription ?? null,
    })),
  };
}

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
    publicPurpose: row.publicPurpose ?? null,
    publicPurposeByName: await name(row.publicPurposeByPersonId),
    publicPurposeAt: row.publicPurposeAt ?? null,
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
 * be coded before it can reconcile. Read-gated by the VIEW resolver — whoever
 * may author on a row OR decide it may read what's on it. The author half
 * keeps a cardholder able to read the send-back note explaining what to fix;
 * the reviewer half is what lets a central reviewer open a row in a book they
 * don't author in, instead of being able to approve it from the queue and not
 * read it (see `lib/transactionCodingAccess.ts#requireViewCoding`).
 */
export const getForTransaction = query({
  args: { transactionId: v.id("transactions") },
  returns: v.object({
    coding: v.union(codingRow, v.null()),
    requiresCoding: v.boolean(),
    /** True iff this charge can prove itself — a receipt, or a filed
     *  exception (pending counts; see `submitCoding`'s gate). Submitting a
     *  coding is refused without it, so the form has to be able to say so
     *  BEFORE someone types three fields they can't submit. */
    hasDocumentation: v.boolean(),
    /** True iff THIS caller could actually approve or send back THIS coding —
     *  finance MANAGER rank in scope (`requireReviewCoding`) and not the person
     *  who wrote it (`approve`'s separation-of-duties rule).
     *
     *  It exists because the UI was gating those two buttons on `readOnly`,
     *  which is a bookkeeper-or-better flag. A bookkeeper, or a manager
     *  reviewing their OWN coding, was shown a working Approve button that
     *  threw `FORBIDDEN` every time. The server has always been the authority;
     *  this just lets the client ask it instead of guessing a weaker rule.
     *
     *  Deliberately includes the SoD half rather than leaving that to the
     *  client: "who wrote this" is a fact the row has and the caller shouldn't
     *  have to reconstruct, and splitting the check across two places is how
     *  the two drift. False when there's no coding to decide on. */
    canReview: v.boolean(),
    namesMaxHeadcount: v.number(),
    minPurposeLength: v.number(),
    /** The charge's OWN category name, or `null` when uncategorized — what
     *  the editor's expense-type chips follow (`categoryExpenseTypeHint`)
     *  until the person overrides them. See `CodingCategoryContext`. */
    categoryName: v.union(v.string(), v.null()),
    categoryExpenseTypeHint: v.optional(
      v.union(...EXPENSE_TYPES.map((t) => v.literal(t))),
    ),
    /** The budget the charge is ALREADY attributed to (`transactions.budgetId`
     *  — the same column Reconcile's "For" picker and this form's own budget
     *  picker both land on), or `null`. Founder report, 2026-08-12: "I
     *  already put most transactions into budgets in reconcile but it still
     *  asks me" — the form's picker started at "Not sure yet" because nothing
     *  carried this answer in, so work done in Reconcile looked ignored. */
    currentBudgetId: v.union(v.id("budgets"), v.null()),
    /** "What the claimant already wrote" — see `reimbursementCodingContext`'s
     *  own doc (Finding 1, UX audit 2026-08-12). `null` unless this txn is a
     *  reimbursement payout. */
    reimbursementContext: v.union(
      v.object({
        requestId: v.id("reimbursementRequests"),
        reference: v.string(),
        purpose: v.union(v.string(), v.null()),
        payeeName: v.string(),
        lines: v.array(reimbursementLineContext),
      }),
      v.null(),
    ),
  }),
  handler: async (ctx, args) => {
    const { txn, actorPersonId } = await requireViewCoding(
      ctx,
      args.transactionId,
    );
    const { sinceMs, namesMaxHeadcount } = await codingPolicy(ctx);
    const category = txn.categoryId ? await ctx.db.get(txn.categoryId) : null;
    const row = await codingForTransaction(ctx, args.transactionId);
    const exceptions = await ctx.db
      .query("receiptExceptions")
      .withIndex("by_transaction", (q) =>
        q.eq("transactionId", args.transactionId),
      )
      .collect();
    const hasDocumentation =
      txn.receiptStorageId != null ||
      exceptions.some((e) => e.status === "approved" || e.status === "pending");
    // Read UNCONDITIONALLY now (not gated on `row` existing) — the
    // reimbursement context below needs the same answer even when there's no
    // coding yet at all, which is the whole point: surfacing this BEFORE the
    // first coding is authored. `requireViewCoding` already ran above, so
    // this is one more permission check on an already-authorized caller, not
    // an extra document read.
    const canSeeNames = await hasCodingNamesView(ctx, args.transactionId);
    const reimbursementContext = await reimbursementCodingContext(
      ctx,
      txn,
      canSeeNames,
    );
    // Mirrors `finances.requiresCoding` — spend posted at/after the policy
    // date. Kept inline (three fields) rather than importing the whole
    // finances module into this one.
    const requiresCoding =
      txn.postedAt >= sinceMs &&
      txn.flow === "outflow" &&
      txn.status !== "excluded" &&
      txn.isPersonal !== true;
    // The same two conditions `approve` enforces, asked in the same order.
    // A superuser with no roster row (`actorPersonId == null`) skips the SoD
    // half exactly as the mutation does — see `approve`'s own comment — and
    // the solo-operator relaxation (`maySelfDecideCoding`) mirrors the
    // mutation's own-coding bypass so this flag never promises less than the
    // server allows.
    const canReview =
      row != null &&
      (await hasReviewCoding(ctx, args.transactionId)) &&
      (actorPersonId == null ||
        actorPersonId !== row.codedByPersonId ||
        (await maySelfDecideCoding(ctx)));
    return {
      coding: row ? await projectCoding(ctx, row, canSeeNames) : null,
      requiresCoding,
      hasDocumentation,
      canReview,
      namesMaxHeadcount,
      minPurposeLength: MIN_PURPOSE_LENGTH,
      categoryName: category?.name ?? null,
      ...(category?.expenseType ? { categoryExpenseTypeHint: category.expenseType } : {}),
      currentBudgetId: txn.budgetId ?? null,
      reimbursementContext,
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
    /**
     * WHICH BUDGET THIS CAME OUT OF — set by the person coding it (owner,
     * 2026-08-09: "when coding, I hope people can select budgets for things").
     *
     * Lands on `transactions.budgetId`, the same column the Reconcile "For"
     * picker writes, through the SAME three guards `categorizeTransaction`
     * applies — the book rule and the approved-budget rule are properties of
     * the attribution, not of who happens to be doing it, so they are
     * re-asserted here rather than assumed.
     *
     * `undefined` leaves it alone. This deliberately does NOT clear: a
     * cardholder resubmitting a coding shouldn't be able to silently detach a
     * budget a bookkeeper attached, and "none" is already the state of a
     * charge nobody has attributed.
     */
    budgetId: v.optional(v.id("budgets")),
  },
  returns: v.id("transactionCodings"),
  handler: async (ctx, args) => {
    const { txn, scope, actorPersonId } = await requireSubmitCoding(
      ctx,
      args.transactionId,
    );
    if (args.budgetId) {
      // THE SAME gate `finances.categorizeTransaction` runs before writing the
      // same field — shared, not copied, so a cardholder may attribute their
      // own charge but never to a book they can't reach or a budget nobody
      // approved.
      const homeChapterId = (await requireChapterId(ctx)) as Id<"chapters">;
      await assertBudgetAttributable(ctx, scope, homeChapterId, args.budgetId);
      await ctx.db.patch(args.transactionId, { budgetId: args.budgetId });
    }
    const userId = (await requireUserId(ctx)) as Id<"users">;
    const { namesMaxHeadcount, sinceMs } = await codingPolicy(ctx);
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
      codingRequiredSinceMs: sinceMs,
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
    // Self-decision: allowed ONLY through the solo-operator relaxation
    // (`maySelfDecideCoding` — superuser while the owner is a one-person
    // finance team), and recorded as `approvalParty: "single"` so the bypass
    // leaves a durable, re-reviewable trace. Everyone else keeps the absolute
    // SoD block. The no-roster-row superuser (`actorPersonId == null`) skips
    // the compare exactly as before.
    const selfDecision =
      actorPersonId != null && actorPersonId === coding.codedByPersonId;
    if (selfDecision && !(await maySelfDecideCoding(ctx))) {
      assertSeparationOfDuties(actorPersonId, coding.codedByPersonId);
    }
    const userId = (await requireUserId(ctx)) as Id<"users">;
    await decideCoding(ctx, {
      coding,
      approve: true,
      decidedByPersonId: actorPersonId,
      decidedByUserId: userId,
      selfApproved: selfDecision,
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
 *
 * SEPARATION OF DUTIES applies here too, and it didn't used to. `canReview`
 * has always reported `false` to the author of a coding — so the client
 * already hid both buttons from them — while this mutation checked only rank.
 * That's the same class of client/server disagreement `canReview` was
 * introduced to end, just pointing the other way: the server was the LAXER
 * of the two, which is the direction that actually matters. It also left a
 * real hole, because this mutation reopens an APPROVED coding: an
 * author who was also a manager could undo somebody else's decision about
 * their own testimony, single-handed. Deciding on your own coding is
 * deciding on your own coding whichever way the decision goes. (Matches
 * `finances.ts#requestBudgetChanges`, which has always asserted it.)
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
    if (
      actorPersonId != null &&
      actorPersonId === coding.codedByPersonId &&
      !(await maySelfDecideCoding(ctx))
    ) {
      // Same no-roster-row escape hatch as `approve` above, plus the same
      // solo-operator self-decision relaxation — sending your own coding back
      // is the harmless half of the power that approving it is.
      assertSeparationOfDuties(actorPersonId, coding.codedByPersonId);
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
    // TELL THE AUTHOR. A send-back nobody hears about is a note in a row
    // nobody re-opens — the loop only closes if "the receipt must show the
    // exact amount" reaches the person who can act on it. Scheduled (not
    // awaited) so a slow or failing Resend never blocks the review itself;
    // degrades to a logged no-op without `RESEND_API_KEY`, like every other
    // send in the app.
    await ctx.scheduler.runAfter(0, internal.cards.notifyCodingSentBack, {
      transactionId: args.transactionId,
    });
    return null;
  },
});

/**
 * Every budget this charge could legitimately land in, grouped, for the
 * cardholder coding it.
 *
 * Owner, 2026-08-09: *"When coding, I hope people can select budgets for
 * things… You should just show them all the budgets."* Until now nobody could
 * — `submitOwnCharge` is deliberately narrow (category and note only) and
 * `categorizeTransaction` is bookkeeper-gated, so the budget on a cardholder's
 * charge could only ever be set later, by somebody who wasn't there.
 *
 * DELIBERATELY NOT FINANCE-ROLE GATED, the same posture as
 * `finances.myChargeCategories` and `budgetsGlance`: a cardholder with no
 * finance seat has to be able to answer "which budget was this?" about their
 * own spending, and membership is the only gate that makes sense for it. It
 * returns names and ids — no amounts, no spend-to-date, nothing about how full
 * a budget is. That stays on the Budgets tab.
 *
 * SHOW THEM ALL, don't guess. The list is every attributable (approved) budget
 * reachable from the caller's chapter plus central — the same set the
 * Reconcile "For" picker offers, built from the same
 * `gatherForPickerCandidates` scan so the two can't drift. Nothing is
 * pre-selected and nothing is ranked by merchant or text: per decision 5 no
 * part of coding infers an answer, and a pre-selection that quietly sticks is
 * exactly the rubber stamp that decision exists to prevent. The guidance is
 * copy next to the choices, not a filter over them.
 */
export const budgetOptions = query({
  args: {},
  returns: v.object({
    events: v.array(v.object({ budgetId: v.id("budgets"), label: v.string() })),
    projects: v.array(
      v.object({ budgetId: v.id("budgets"), label: v.string() }),
    ),
    recurring: v.array(
      v.object({
        budgetId: v.id("budgets"),
        label: v.string(),
        level: v.union(v.literal("chapter"), v.literal("central")),
      }),
    ),
  }),
  handler: async (ctx) => {
    const empty = { events: [], projects: [], recurring: [] };
    const chapterId = (await getChapterIdOrNull(ctx)) as Id<"chapters"> | null;
    if (!chapterId) return empty;
    const { candidates } = await gatherForPickerCandidates(
      ctx,
      chapterId,
      CODING_SCAN_LIMIT,
    );
    return {
      events: candidates.flatMap((c) =>
        c.refKind === "event" && isAttributableBudget(c.budget)
          ? [{ budgetId: c.budget._id, label: c.label }]
          : [],
      ),
      projects: candidates.flatMap((c) =>
        c.refKind === "project" && isAttributableBudget(c.budget)
          ? [{ budgetId: c.budget._id, label: c.label }]
          : [],
      ),
      recurring: candidates.flatMap((c) =>
        c.refKind === "recurring" && isAttributableBudget(c.budget)
          ? [
              {
                budgetId: c.budget._id,
                label: c.label,
                level: c.level as "chapter" | "central",
              },
            ]
          : [],
      ),
    };
  },
});

/**
 * Rewrite the PUBLISHED wording of a coding — the approver's redaction pass.
 *
 * Owner, 2026-08-09: *"That should be part of the financial manager or whoever
 * is approving's role — to see if they could just edit things to get it ready
 * for public viewing… since they know that, they should be able to go in and
 * edit it, or highlight something and redact it."*
 *
 * ## Redaction is not falsification
 *
 * This is a substantiation record for an IRS accountable plan. What actually
 * happened has to survive, so the author's `businessPurpose` is NEVER touched
 * — not by this mutation, not by anything. The approver's version is stored
 * beside it in `publicPurpose`, the ledger renders `publicPurpose ??
 * businessPurpose`, and every internal surface shows both, labelled. An
 * auditor reading this row can still see the sentence the spender wrote.
 *
 * The hole it closes: structured attendee names are protected forever and
 * render internal-only, but a name typed into the free-text purpose bypasses
 * that entirely. Real production text reads "Travel with Michael Reid from all
 * team meeting in Manhattan to LIRR in Rosedale". Before this, an approver's
 * only options were to publish the name or bounce the whole coding back over a
 * wording nit — so the likely outcome was publishing the name.
 *
 * ## What it is NOT
 *
 * Not a rich-text range-redaction UI. The owner floated "highlight something
 * and redact it" as a thought; a plain editable field with the original shown
 * beneath satisfies every requirement above, and three similar lines beat a
 * premature abstraction (CLAUDE.md). Not an inference engine either — nothing
 * scans the prose for things that look like names (decision 5).
 *
 * SEPARATION OF DUTIES applies. Rewriting the published sentence is part of
 * deciding, so it is gated by `requireReviewCoding` and refused on your own
 * coding — otherwise "I can't approve my own, but I can rewrite what mine
 * says before somebody else does" would be a way around it.
 *
 * Passing `null` clears the redaction and restores the author's words as the
 * published version. That path is audited exactly like a rewrite: taking a
 * redaction OFF is as much of a publishing decision as putting one on.
 */
export const setPublicPurpose = mutation({
  args: {
    transactionId: v.id("transactions"),
    publicPurpose: v.union(v.string(), v.null()),
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
        message: "This transaction has no coding to edit.",
      });
    }
    if (
      actorPersonId != null &&
      actorPersonId === coding.codedByPersonId &&
      !(await maySelfDecideCoding(ctx))
    ) {
      // Redaction is part of the deciding power, so it takes the same
      // solo-operator relaxation as `approve` — a solo operator approving
      // their own coding must also be able to strip a name from its public
      // wording first.
      assertSeparationOfDuties(actorPersonId, coding.codedByPersonId);
    }
    const next = args.publicPurpose?.trim() ?? null;
    if (next != null && next.length < MIN_PURPOSE_LENGTH) {
      // The published sentence has to clear the same bar the author's did —
      // a redaction that guts it into "travel" is a worse public record than
      // the name it removed.
      throw new ConvexError({
        code: "PURPOSE_TOO_SHORT",
        message: `The published wording still has to say what the money was for — at least ${MIN_PURPOSE_LENGTH} characters.`,
      });
    }
    const userId = (await requireUserId(ctx)) as Id<"users">;
    const before = coding.publicPurpose ?? coding.businessPurpose;
    // A no-op rewrite writes nothing and logs nothing: an approver who opens
    // the field, changes their mind, and saves shouldn't leave an audit row
    // claiming they redacted something.
    if ((next ?? coding.businessPurpose) === before) return null;

    await ctx.db.patch(coding._id, {
      publicPurpose: next ?? undefined,
      publicPurposeByPersonId: next ? (actorPersonId ?? undefined) : undefined,
      publicPurposeByUserId: next ? userId : undefined,
      publicPurposeAt: next ? Date.now() : undefined,
    });
    await logFinanceAudit(ctx, {
      chapterId: scope,
      subjectType: "transaction",
      subjectId: args.transactionId,
      action: "coding_redact",
      actorPersonId,
      field: "publicPurpose",
      before,
      after: next ?? coding.businessPurpose,
      // WHY it reads as a redaction rather than an edit: the author's own
      // sentence is still on the row, and this names what replaced it.
      reason:
        next == null
          ? "Restored the author's wording as the published version"
          : "Edited the wording that publishes; the author's original is retained",
      amountCents: txn.amountCents,
    });
    return null;
  },
});

// ── The Coding tab's two queues ──────────────────────────────────────────────
//
// One screen, two audiences, both first-class (owner, 2026-08-09):
//
//  - the CARDHOLDER's own charges still owing a coding — served by the
//    existing `finances.personTransactions`, which needs no finance seat at
//    all and is what `/finances/my-transactions` already read. Nothing new is
//    needed for that half; it's named here so the split is obvious.
//  - the REVIEWER's queue of submitted codings — `reviewQueue` below, with
//    enough substantiation on each row to decide WITHOUT opening it.
//
// `workload` is the third piece: the per-chapter roll-up a central reviewer
// needs to see which book is falling behind, and the same numbers the tab
// uses to decide whether to show itself at all.

/** One row of the reviewer's queue: the coding, plus the charge it explains
 *  and the book it belongs to. */
const reviewQueueRow = v.object({
  transactionId: v.id("transactions"),
  book: v.object({
    id: v.union(v.id("chapters"), v.literal("central")),
    name: v.string(),
  }),
  merchantName: v.union(v.string(), v.null()),
  amountCents: v.number(),
  postedAt: v.number(),
  coding: codingRow,
  /** How this charge proves itself, for the reviewer to read against the
   *  purpose. `"none"` should be unreachable on a SUBMITTED coding (the
   *  documentation gate refuses it), so seeing one is a signal, not noise. */
  documentation: v.union(
    v.literal("receipt"),
    v.literal("exception_approved"),
    v.literal("exception_pending"),
    v.literal("none"),
  ),
  /** True iff THIS caller could decide THIS row — authority AND separation of
   *  duties, the same two questions `approve` asks, so the grid never renders
   *  a button that would throw. Rows they can't decide come back `false`
   *  rather than hidden (the Reconcile `canEdit` posture): a reviewer who
   *  wrote one of the codings in their own queue should still see it sitting
   *  there waiting on somebody else. */
  canReview: v.boolean(),
});

/**
 * The reviewer's queue: every SUBMITTED coding in the books this caller may
 * decide in, oldest first — the ones that have waited longest are the ones the
 * accountable-plan clock is running against.
 *
 * Scope args mirror `finances.listReconcile` exactly — `scope: "central" |
 * "all"` plus a `chapterId` drill-down — because it is the same question asked
 * of the same books by the same people. A second vocabulary for it would be a
 * second thing to learn and a second thing to get wrong.
 */
export const reviewQueue = query({
  args: {
    scope: v.optional(v.union(v.literal("central"), v.literal("all"))),
    chapterId: v.optional(v.id("chapters")),
    limit: v.optional(v.number()),
  },
  returns: v.object({
    rows: v.array(reviewQueueRow),
    hasMore: v.boolean(),
    /** True iff the caller may decide in books beyond their own — drives the
     *  All books / Central / <chapter> pills and the roll-up. */
    orgWide: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const reach = await codingReviewReach(ctx);
    if (!reach.orgWide && !reach.ownChapter) {
      return { rows: [], hasMore: false, orgWide: false };
    }

    // Which books to read. A caller WITHOUT org-wide reach is pinned to their
    // own chapter whatever they ask for — the same deliberate containment
    // `requireReviewCoding` enforces per row, applied once here so a crafted
    // `scope: "all"` can't widen a Treasurer's queue.
    let books: (Id<"chapters"> | typeof CENTRAL)[];
    if (!reach.orgWide) {
      books = [reach.homeChapterId];
    } else if (args.scope === "central") {
      books = [CENTRAL];
    } else if (args.chapterId != null) {
      books = [args.chapterId];
    } else if (args.scope === "all") {
      books = [
        CENTRAL,
        ...(await listActiveChapters(ctx, CODING_SCAN_LIMIT)).map((c) => c._id),
      ];
    } else {
      books = [reach.homeChapterId];
    }

    // Computed once for the whole queue, not per row — it is a fact about the
    // caller. See `maySelfDecideCoding`: the solo-operator relaxation that
    // lets a superuser's own submissions carry live Approve buttons instead
    // of "waiting on somebody else".
    const selfDecide = await maySelfDecideCoding(ctx);

    const bookNames = new Map<string, string>([[CENTRAL, "Central"]]);
    for (const b of books) {
      if (b === CENTRAL) continue;
      bookNames.set(b, (await ctx.db.get(b))?.name ?? "Chapter");
    }

    const limit = Math.min(args.limit ?? CODING_PAGE_SIZE, CODING_PAGE_SIZE);
    const pending: Doc<"transactionCodings">[] = [];
    for (const book of books) {
      const rows = await ctx.db
        .query("transactionCodings")
        .withIndex("by_chapter_and_status", (q) =>
          q.eq("chapterId", book).eq("status", "submitted"),
        )
        .take(CODING_SCAN_LIMIT);
      pending.push(...rows);
    }
    // Oldest submission first: this queue is a clock, not an inbox.
    pending.sort((a, b) => a.submittedAt - b.submittedAt);
    const page = pending.slice(0, limit);

    const rows: Infer<typeof reviewQueueRow>[] = [];
    for (const coding of page) {
      const txn = await ctx.db.get(coding.transactionId);
      if (!txn) continue;
      const exceptions = await ctx.db
        .query("receiptExceptions")
        .withIndex("by_transaction", (q) =>
          q.eq("transactionId", coding.transactionId),
        )
        .collect();
      const documentation =
        txn.receiptStorageId != null
          ? ("receipt" as const)
          : exceptions.some((e) => e.status === "approved")
            ? ("exception_approved" as const)
            : exceptions.some((e) => e.status === "pending")
              ? ("exception_pending" as const)
              : ("none" as const);
      // Authority first — org-wide reaches every book, otherwise their own
      // only — then SoD, the same second question `approve` asks.
      const hasAuthority =
        reach.orgWide ||
        (coding.chapterId !== CENTRAL &&
          coding.chapterId === reach.homeChapterId);
      const canReview =
        hasAuthority &&
        (reach.actorPersonId == null ||
          reach.actorPersonId !== coding.codedByPersonId ||
          selfDecide);
      rows.push({
        transactionId: coding.transactionId,
        book: {
          id: coding.chapterId,
          name: bookNames.get(coding.chapterId) ?? "Chapter",
        },
        merchantName: txn.merchantName ?? null,
        amountCents: txn.amountCents,
        postedAt: txn.postedAt,
        // A reviewer has to weigh WHO WAS THERE, so the queue shows names to
        // whoever may decide the row — the same bar `hasCodingNamesView`
        // applies. Names still never publish.
        coding: await projectCoding(ctx, coding, hasAuthority),
        documentation,
        canReview,
      });
    }
    return {
      rows,
      hasMore: pending.length > page.length,
      orgWide: reach.orgWide,
    };
  },
});

/**
 * How much coding work is outstanding, and where.
 *
 * Two jobs. It tells the tab whether to show itself — somebody with nothing to
 * code and no review authority gets no tab rather than a dead one. And for a
 * central reviewer it carries the per-chapter roll-up: how many charges are
 * still waiting on their author, and how many codings are waiting on a
 * reviewer, in each book.
 *
 * The roll-up is a WORKLOAD reading, not a scoreboard. It answers "where is
 * the work" so an FM can help the book that's behind; the copy that renders it
 * says so, and there is deliberately no ranking, no trend and no target here
 * to turn it into anything else.
 *
 * Separate from `reviewQueue` on purpose: drilling into one chapter must not
 * empty the roll-up you're navigating with.
 */
export const workload = query({
  args: {},
  returns: v.object({
    /** The caller's OWN charges still owing a coding — the cardholder half,
     *  and the reason someone with no finance seat gets this tab at all. */
    mineToCode: v.number(),
    /** Submitted codings this caller may decide, across their whole reach. */
    awaitingMyReview: v.number(),
    orgWide: v.boolean(),
    /** Empty unless `orgWide` — one row per book, central first. */
    byChapter: v.array(
      v.object({
        id: v.union(v.id("chapters"), v.literal("central")),
        name: v.string(),
        toCode: v.number(),
        awaitingReview: v.number(),
      }),
    ),
  }),
  handler: async (ctx) => {
    const empty = {
      mineToCode: 0,
      awaitingMyReview: 0,
      orgWide: false,
      byChapter: [],
    };
    // A READ resolve (null → empty result, never a throw): this query decides
    // whether a tab renders, so a signed-in member with no chapter yet must
    // get "nothing to do", not an error boundary.
    const chapterId = (await getChapterIdOrNull(ctx)) as Id<"chapters"> | null;
    if (!chapterId) return empty;
    const { sinceMs } = await codingPolicy(ctx);

    // ── The cardholder half. No finance seat required, by design. ──────────
    const self = await viewerPerson(ctx, chapterId);
    let mineToCode = 0;
    if (self) {
      const mine = await ctx.db
        .query("transactions")
        .withIndex("by_person", (q) => q.eq("personId", self._id))
        .take(CODING_SCAN_LIMIT);
      mineToCode = mine.filter(
        (tr) => tr.chapterId === chapterId && isUncodedCharge(tr, sinceMs),
      ).length;
    }

    // ── The reviewer half. ─────────────────────────────────────────────────
    const reach = await codingReviewReach(ctx);
    if (!reach.orgWide && !reach.ownChapter) {
      return { ...empty, mineToCode };
    }

    const countSubmitted = async (
      book: Id<"chapters"> | typeof CENTRAL,
    ): Promise<number> =>
      (
        await ctx.db
          .query("transactionCodings")
          .withIndex("by_chapter_and_status", (q) =>
            q.eq("chapterId", book).eq("status", "submitted"),
          )
          .take(CODING_SCAN_LIMIT)
      ).length;

    const countUncoded = async (
      book: Id<"chapters"> | typeof CENTRAL,
    ): Promise<number> =>
      (
        await ctx.db
          .query("transactions")
          .withIndex("by_chapter", (q) => q.eq("chapterId", book))
          .take(CODING_SCAN_LIMIT)
      ).filter((tr) => isUncodedCharge(tr, sinceMs)).length;

    if (!reach.orgWide) {
      return {
        mineToCode,
        awaitingMyReview: await countSubmitted(reach.homeChapterId),
        orgWide: false,
        byChapter: [],
      };
    }

    const books: (Id<"chapters"> | typeof CENTRAL)[] = [
      CENTRAL,
      ...(await listActiveChapters(ctx, CODING_SCAN_LIMIT)).map((c) => c._id),
    ];
    const byChapter: {
      id: Id<"chapters"> | typeof CENTRAL;
      name: string;
      toCode: number;
      awaitingReview: number;
    }[] = [];
    let awaitingMyReview = 0;
    for (const book of books) {
      const awaitingReview = await countSubmitted(book);
      awaitingMyReview += awaitingReview;
      byChapter.push({
        id: book,
        name:
          book === CENTRAL
            ? "Central"
            : ((await ctx.db.get(book))?.name ?? "Chapter"),
        toCode: await countUncoded(book),
        awaitingReview,
      });
    }
    return { mineToCode, awaitingMyReview, orgWide: true, byChapter };
  },
});
