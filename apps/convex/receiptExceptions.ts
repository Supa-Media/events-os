/**
 * Receipt exceptions — the public surface for "there is no receipt for this,
 * and here is why", the documentation of record when a receipt can't be
 * produced.
 *
 * Filed by the person who spent (or a bookkeeper), decided by a finance
 * manager, and — at or above the org's threshold — decided by a DIFFERENT
 * person than the one who filed it. That separation is what keeps the forward
 * "no receipt → the cardholder owes it" policy
 * (`financeSettings.noReceiptAutoConvertDays`) from being self-served into
 * irrelevance: without it, every cardholder simply excepts their own charges.
 *
 * Authorization lives in `lib/receiptExceptionAccess.ts` (attest vs. approve);
 * all table + pointer writes go through `lib/receiptExceptions.ts`. This file
 * owns validation, the separation-of-duties + threshold rules, and the audit
 * trail. See `docs/plans/receipt-exceptions.md`.
 */
import { mutation, query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import {
  RECEIPT_EXCEPTION_REASONS,
  RECEIPT_EXCEPTION_STATUSES,
  RECEIPT_EXCEPTION_REASON_LABELS,
  DEFAULT_EXCEPTION_APPROVAL_THRESHOLD_CENTS,
  exceptionNeedsSecondApprover,
  formatCents,
  type ReceiptExceptionReason,
} from "@events-os/shared";
import { requireUserId, getChapterIdOrNull } from "./lib/context";
import { assertSeparationOfDuties } from "./lib/finance";
import { logFinanceAudit } from "./lib/financeAuditLog";
import {
  requireAttestReceiptException,
  requireApproveReceiptException,
} from "./lib/receiptExceptionAccess";
import {
  attestException,
  decideException,
  withdrawException,
  exceptionsForTransaction,
} from "./lib/receiptExceptions";

const reasonValidator = v.union(
  ...RECEIPT_EXCEPTION_REASONS.map((r) => v.literal(r)),
);
const statusValidator = v.union(
  ...RECEIPT_EXCEPTION_STATUSES.map((s) => v.literal(s)),
);

/** The org's second-approver threshold, falling back to the shared default.
 *  Deliberately has no "off" value — see the schema field's doc comment. */
async function approvalThresholdCents(ctx: QueryCtx): Promise<number> {
  const settings = await ctx.db.query("financeSettings").first();
  return (
    settings?.receiptExceptionApprovalThresholdCents ??
    DEFAULT_EXCEPTION_APPROVAL_THRESHOLD_CENTS
  );
}

const exceptionRow = v.object({
  _id: v.id("receiptExceptions"),
  transactionId: v.id("transactions"),
  amountCents: v.number(),
  reason: reasonValidator,
  reasonLabel: v.string(),
  note: v.string(),
  status: statusValidator,
  hasSubstitute: v.boolean(),
  substituteUrl: v.union(v.string(), v.null()),
  attestedByName: v.union(v.string(), v.null()),
  attestedAt: v.number(),
  decidedByName: v.union(v.string(), v.null()),
  decidedAt: v.union(v.number(), v.null()),
  decisionNote: v.union(v.string(), v.null()),
});

/** Project one row for display, resolving the two person names + the
 *  substitute's signed url. */
async function projectException(
  ctx: any,
  row: Doc<"receiptExceptions">,
): Promise<any> {
  const name = async (personId?: Id<"people">) => {
    if (!personId) return null;
    const person = await ctx.db.get(personId);
    return person?.name ?? null;
  };
  return {
    _id: row._id,
    transactionId: row.transactionId,
    amountCents: row.amountCents,
    reason: row.reason,
    reasonLabel: RECEIPT_EXCEPTION_REASON_LABELS[row.reason],
    note: row.note,
    status: row.status,
    hasSubstitute: row.substituteStorageId != null,
    substituteUrl: row.substituteStorageId
      ? await ctx.storage.getUrl(row.substituteStorageId)
      : null,
    attestedByName: await name(row.attestedByPersonId),
    attestedAt: row.attestedAt,
    decidedByName: await name(row.decidedByPersonId),
    decidedAt: row.decidedAt ?? null,
    decisionNote: row.decisionNote ?? null,
  };
}

/**
 * Every exception ever filed against one transaction, newest first — the
 * detail panel's history, including rejected and withdrawn rows. Showing the
 * rejections is the point: "what was claimed, and who decided" is the audit
 * story a published ledger has to be able to answer.
 *
 * Read-gated by the ATTEST resolver rather than a viewer gate: anyone who may
 * file on this row may see what's already been filed on it, which keeps a
 * cardholder able to read the rejection note explaining what to fix.
 */
export const listForTransaction = query({
  args: { transactionId: v.id("transactions") },
  returns: v.array(exceptionRow),
  handler: async (ctx, args) => {
    await requireAttestReceiptException(ctx, args.transactionId);
    const rows = await exceptionsForTransaction(ctx, args.transactionId);
    return Promise.all(rows.map((r) => projectException(ctx, r)));
  },
});

/**
 * File an exception on one transaction. The note is required and
 * length-floored (`lib/receiptExceptions.ts#normalizeExceptionNote`) — it is
 * the substitute for the document, so a blank one defeats the feature.
 *
 * `substituteStorageId` is the optional supporting artifact (a statement line,
 * a confirmation email, a photo of the item). It is deliberately NOT written
 * to `transactions.receiptStorageId` or the shared receipts library: it isn't
 * a receipt, and must never be counted as one or auto-matched to another
 * charge.
 */
export const attest = mutation({
  args: {
    transactionId: v.id("transactions"),
    reason: reasonValidator,
    note: v.string(),
    substituteStorageId: v.optional(v.id("_storage")),
  },
  returns: v.id("receiptExceptions"),
  handler: async (ctx, args) => {
    const { txn, scope, actorPersonId } = await requireAttestReceiptException(
      ctx,
      args.transactionId,
    );
    const userId = (await requireUserId(ctx)) as Id<"users">;
    const exceptionId = await attestException(ctx, {
      txn,
      scope,
      reason: args.reason,
      note: args.note,
      ...(args.substituteStorageId
        ? { substituteStorageId: args.substituteStorageId }
        : {}),
      attestedByPersonId: actorPersonId,
      attestedByUserId: userId,
    });
    await logFinanceAudit(ctx, {
      chapterId: scope,
      subjectType: "transaction",
      subjectId: args.transactionId,
      action: "receipt_exception_attest",
      actorPersonId,
      field: "receiptException",
      after: RECEIPT_EXCEPTION_REASON_LABELS[args.reason],
      reason: args.note.trim(),
      amountCents: txn.amountCents,
    });
    return exceptionId;
  },
});

/**
 * BACKFILL PATH — file the SAME reason + note across an explicit list of
 * transactions, one exception row each. Nobody is clicking four hundred rows
 * to publish a historical ledger, and the alternative people actually reach
 * for is marking the lot `reconciled` document-less, which is the exact hole
 * this feature closes.
 *
 * Per-row, not blanket: every transaction still gets its own attestation with
 * its own amount and its own audit entry, so no row is anonymously waived. A
 * row that can't take an exception (already receipted, already has a pending
 * one, outside the caller's scope) is SKIPPED and counted rather than failing
 * the batch — a backfill selection routinely contains a few of each, and
 * throwing would make the caller re-derive which ones were fine.
 */
export const attestBulk = mutation({
  args: {
    transactionIds: v.array(v.id("transactions")),
    reason: reasonValidator,
    note: v.string(),
  },
  returns: v.object({ filed: v.number(), skipped: v.number() }),
  handler: async (ctx, args) => {
    const userId = (await requireUserId(ctx)) as Id<"users">;
    let filed = 0;
    let skipped = 0;
    for (const transactionId of args.transactionIds) {
      try {
        const { txn, scope, actorPersonId } =
          await requireAttestReceiptException(ctx, transactionId);
        await attestException(ctx, {
          txn,
          scope,
          reason: args.reason,
          note: args.note,
          attestedByPersonId: actorPersonId,
          attestedByUserId: userId,
        });
        await logFinanceAudit(ctx, {
          chapterId: scope,
          subjectType: "transaction",
          subjectId: transactionId,
          action: "receipt_exception_attest",
          actorPersonId,
          field: "receiptException",
          after: RECEIPT_EXCEPTION_REASON_LABELS[args.reason],
          reason: args.note.trim(),
          amountCents: txn.amountCents,
        });
        filed += 1;
      } catch (err) {
        // A malformed note is the caller's mistake on EVERY row, not a
        // per-row skip — rethrow it rather than silently reporting 400
        // skipped. Everything else (already receipted, already pending, out
        // of scope) is a legitimate per-row skip.
        if (
          err instanceof ConvexError &&
          (err.data as { code?: string })?.code?.startsWith("NOTE_")
        ) {
          throw err;
        }
        skipped += 1;
      }
    }
    return { filed, skipped };
  },
});

/** Load a pending exception + authorize a decision on it. Shared by
 *  approve/reject so the two can't drift on scope or rank. */
async function loadForDecision(
  ctx: any,
  exceptionId: Id<"receiptExceptions">,
): Promise<{
  exception: Doc<"receiptExceptions">;
  scope: string;
  actorPersonId: Id<"people"> | null;
}> {
  const exception = (await ctx.db.get(
    exceptionId,
  )) as Doc<"receiptExceptions"> | null;
  if (!exception) {
    throw new ConvexError({
      code: "NOT_FOUND",
      message: "Receipt exception not found.",
    });
  }
  const { scope, actorPersonId } = await requireApproveReceiptException(
    ctx,
    exception.transactionId,
  );
  return { exception, scope, actorPersonId };
}

/**
 * Approve an exception — it becomes this transaction's documentation of
 * record, the row leaves the receipt chase, and the no-receipt auto-convert
 * clock stops on it.
 *
 * SEPARATION OF DUTIES: at or above
 * `financeSettings.receiptExceptionApprovalThresholdCents` (default $75, the
 * IRS accountable-plan substantiation line), the approver must be a different
 * person than the filer. Below it a manager may approve their own attestation
 * — the small-dollar long tail is where a two-name ceremony buys nothing and
 * the backlog it creates is what makes people stop filing at all.
 */
export const approve = mutation({
  args: {
    exceptionId: v.id("receiptExceptions"),
    decisionNote: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { exception, scope, actorPersonId } = await loadForDecision(
      ctx,
      args.exceptionId,
    );
    const threshold = await approvalThresholdCents(ctx);
    if (
      exceptionNeedsSecondApprover(exception.amountCents, threshold) &&
      actorPersonId != null
    ) {
      // Reuses the reimbursement/budget/campaign SOD helper so the refusal
      // code (`SOD_VIOLATION`) and message match every other approval in the
      // app. A superuser with no roster row (`actorPersonId == null`) can't be
      // compared against the filer at all — that path is already the
      // deliberate bootstrap escape hatch elsewhere in finance, so it stays
      // consistent here rather than inventing a stricter rule in one corner.
      assertSeparationOfDuties(actorPersonId, exception.attestedByPersonId);
    }
    const userId = (await requireUserId(ctx)) as Id<"users">;
    await decideException(ctx, {
      exception,
      approve: true,
      ...(args.decisionNote ? { decisionNote: args.decisionNote } : {}),
      decidedByPersonId: actorPersonId,
      decidedByUserId: userId,
    });
    await logFinanceAudit(ctx, {
      chapterId: scope as Id<"chapters"> | "central",
      subjectType: "transaction",
      subjectId: exception.transactionId,
      action: "receipt_exception_decide",
      actorPersonId,
      field: "receiptException",
      before: "Awaiting approval",
      after: `Approved — ${RECEIPT_EXCEPTION_REASON_LABELS[exception.reason as ReceiptExceptionReason]}`,
      reason: args.decisionNote?.trim() ?? null,
      amountCents: exception.amountCents,
    });
    return null;
  },
});

/** Reject an exception — the transaction still owes a receipt (and stays on
 *  the auto-convert clock). A reason is required: the filer needs to know what
 *  would make it approvable, and "rejected, no explanation" is how a policy
 *  stops being followed. */
export const reject = mutation({
  args: {
    exceptionId: v.id("receiptExceptions"),
    decisionNote: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { exception, scope, actorPersonId } = await loadForDecision(
      ctx,
      args.exceptionId,
    );
    const userId = (await requireUserId(ctx)) as Id<"users">;
    await decideException(ctx, {
      exception,
      approve: false,
      decisionNote: args.decisionNote,
      decidedByPersonId: actorPersonId,
      decidedByUserId: userId,
    });
    await logFinanceAudit(ctx, {
      chapterId: scope as Id<"chapters"> | "central",
      subjectType: "transaction",
      subjectId: exception.transactionId,
      action: "receipt_exception_decide",
      actorPersonId,
      field: "receiptException",
      before: "Awaiting approval",
      after: "Rejected",
      reason: args.decisionNote.trim(),
      amountCents: exception.amountCents,
    });
    return null;
  },
});

/** Withdraw an exception — pending or approved. The everyday case is the
 *  receipt turning up, so this is deliberately available to whoever may FILE
 *  on the row (the cardholder included), not just to an approver. */
export const withdraw = mutation({
  args: { exceptionId: v.id("receiptExceptions") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const exception = (await ctx.db.get(
      args.exceptionId,
    )) as Doc<"receiptExceptions"> | null;
    if (!exception) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Receipt exception not found.",
      });
    }
    const { scope, actorPersonId } = await requireAttestReceiptException(
      ctx,
      exception.transactionId,
    );
    await withdrawException(ctx, exception);
    await logFinanceAudit(ctx, {
      chapterId: scope,
      subjectType: "transaction",
      subjectId: exception.transactionId,
      action: "receipt_exception_withdraw",
      actorPersonId,
      field: "receiptException",
      before: RECEIPT_EXCEPTION_REASON_LABELS[
        exception.reason as ReceiptExceptionReason
      ],
      after: "Withdrawn",
      amountCents: exception.amountCents,
    });
    return null;
  },
});

/**
 * The approval queue: pending exceptions for the caller's scope, oldest first
 * (an attestation waiting three weeks is the one holding up a close).
 * Manager-gated per row via the same resolver the decision itself uses, so the
 * queue can never show something the viewer couldn't act on.
 */
export const pendingQueue = query({
  args: { chapterId: v.optional(v.union(v.id("chapters"), v.literal("central"))) },
  returns: v.object({
    rows: v.array(exceptionRow),
    totalCents: v.number(),
    thresholdCents: v.number(),
  }),
  handler: async (ctx, args) => {
    const thresholdCents = await approvalThresholdCents(ctx);
    // An explicit scope (the central desk, or a central drill-down into one
    // chapter) else the caller's own chapter. Signed-out / chapterless callers
    // get an empty queue rather than a throw — same posture as the other
    // finance list queries.
    const scope =
      args.chapterId ??
      ((await getChapterIdOrNull(ctx)) as Id<"chapters"> | null);
    if (!scope) return { rows: [], totalCents: 0, thresholdCents };
    const pending = await ctx.db
      .query("receiptExceptions")
      .withIndex("by_chapter_and_status", (q) =>
        q.eq("chapterId", scope).eq("status", "pending"),
      )
      .collect();
    pending.sort((a, b) => a.attestedAt - b.attestedAt);
    const visible: Doc<"receiptExceptions">[] = [];
    for (const row of pending) {
      try {
        await requireApproveReceiptException(ctx, row.transactionId);
        visible.push(row);
      } catch {
        // Not this caller's to decide — omit rather than throw, so one
        // out-of-scope row can't blank the whole queue.
      }
    }
    return {
      rows: await Promise.all(visible.map((r) => projectException(ctx, r))),
      totalCents: visible.reduce((sum, r) => sum + Math.abs(r.amountCents), 0),
      thresholdCents,
    };
  },
});

/** Human-readable threshold for the attest form's "this will need a second
 *  approver" hint. */
export const approvalThreshold = query({
  args: {},
  returns: v.object({ cents: v.number(), label: v.string() }),
  handler: async (ctx) => {
    const cents = await approvalThresholdCents(ctx);
    return { cents, label: formatCents(cents) };
  },
});
