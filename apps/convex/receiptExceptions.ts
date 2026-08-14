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
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { v, ConvexError, type Infer } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import {
  RECEIPT_EXCEPTION_REASONS,
  RECEIPT_EXCEPTION_STATUSES,
  RECEIPT_EXCEPTION_REASON_LABELS,
  financeAuditValueLabel,
  receiptExceptionApprovedKey,
  receiptExceptionFiledKey,
  DEFAULT_EXCEPTION_APPROVAL_THRESHOLD_CENTS,
  exceptionNeedsSecondApprover,
  formatCents,
  lostReceiptBlocker,
  type ReceiptExceptionReason,
} from "@events-os/shared";
import { requireUserId } from "./lib/context";
import { assertSeparationOfDuties, type FinanceScope } from "./lib/finance";
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

/** One recorded yes/no, with the question it answered — see the schema's
 *  `attestations` doc for why the prompt is stored rather than just the key. */
const attestationValidator = v.array(
  v.object({ key: v.string(), prompt: v.string(), answer: v.boolean() }),
);
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
  // Evidence of the purchase — photos of what was bought, a statement line, a
  // confirmation email. Resolved to urls for display; a file whose url can't
  // be resolved is dropped rather than rendered as a broken thumbnail.
  //
  // The CONTENT TYPE rides along because the viewer needs it. This used to be
  // a bare `string[]`, and the UI guessed the file kind with
  // `url.toLowerCase().includes(".pdf")` — which can NEVER be true, because a
  // Convex storage url is `/api/storage/<uuid>` with no extension anywhere in
  // it. Every PDF filed as evidence therefore rendered as a blank box, 100% of
  // the time. Evidence carries no filename (it is stored as bare `_storage`
  // ids, not `receipts` rows), so the content type is the only signal there
  // is — and it has to come from the server.
  evidence: v.array(
    v.object({
      url: v.string(),
      contentType: v.union(v.string(), v.null()),
    }),
  ),
  /** What the filer said they tried, question by question — the thing that
   *  lets an approver understand the situation without asking anyone. Always
   *  an array (empty for rows filed before this existed), and always rendered
   *  as ATTESTED: nobody verified any of it. */
  attestations: v.array(
    v.object({ key: v.string(), prompt: v.string(), answer: v.boolean() }),
  ),
  attestedByName: v.union(v.string(), v.null()),
  attestedAt: v.number(),
  decidedByName: v.union(v.string(), v.null()),
  decidedAt: v.union(v.number(), v.null()),
  decisionNote: v.union(v.string(), v.null()),
});

/** Project one row for display, resolving the two person names + signed urls
 *  for every evidence file. */
async function projectException(
  ctx: QueryCtx,
  row: Doc<"receiptExceptions">,
): Promise<Infer<typeof exceptionRow>> {
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
    evidence: (
      await Promise.all(
        (row.evidenceStorageIds ?? []).map(async (id) => {
          const url = await ctx.storage.getUrl(id);
          if (url == null) return null;
          const meta = await ctx.db.system.get("_storage", id);
          return { url, contentType: meta?.contentType ?? null };
        }),
      )
    ).filter((e): e is { url: string; contentType: string | null } => e != null),
    // `[]` for the 36 exceptions decided before this existed — they're
    // historical rows, not incomplete ones, and an empty list renders as
    // "nothing recorded" rather than as three unanswered questions.
    attestations: row.attestations ?? [],
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
 * `evidenceStorageIds` is the optional proof of the purchase — photos of what
 * was bought (the owner's case: flowers at the event, no receipt), a bank
 * statement line, a confirmation email. Deliberately NOT written to
 * `transactions.receiptStorageId` and never inserted into the receipts
 * library: evidence isn't a receipt and must never be counted as one or
 * auto-matched to another charge.
 *
 * One reason is refused outright: `bank_record_only` on a row coded as
 * LODGING (`LODGING_RECEIPT_REQUIRED` — the IRS wants an itemized folio at any
 * amount). The rule lives in the single writer
 * (`lib/receiptExceptions.ts#attestException`) so this path and the bulk one
 * below can't drift on it.
 */
export const attest = mutation({
  args: {
    transactionId: v.id("transactions"),
    reason: reasonValidator,
    note: v.string(),
    evidenceStorageIds: v.optional(v.array(v.id("_storage"))),
    // What they said they tried, question by question — required in practice
    // for `lost` (the server refuses one without all three), recorded for
    // every reason. See `LOST_RECEIPT_CHECKS` / `NOT_ISSUED_CHECKS`.
    attestations: v.optional(attestationValidator),
  },
  returns: v.id("receiptExceptions"),
  handler: async (ctx, args) => {
    const { txn, scope, actorPersonId } = await requireAttestReceiptException(
      ctx,
      args.transactionId,
    );
    // THE GAUNTLET, and only for `lost` — the reason branches first (owner,
    // 2026-08-09: "this should only be if they say the receipt was lost; if
    // they say no receipt issued, then it's just no receipt issued"), because
    // chasing a receipt that cannot exist is pure friction with no yield.
    //
    // Enforced server-side and not only in the form: the block is meant to be
    // real, and a check that lives only in the client is one anybody can skip.
    // Uniform at every amount — the $75 line governs who APPROVES and is not a
    // friction dial.
    //
    // DELIBERATELY HERE rather than in the shared `attestException` writer.
    // This is the ONE interactive path — a person filing one exception about
    // their own charge, which is exactly the act the owner is describing. The
    // writer is also used by `attestBulk` (a bookkeeper acknowledging historical
    // rows) and by `genesisCleanup` (a backfill of imported history), and
    // asking either of those "did you email the merchant?" would be asking
    // about a purchase nobody present was there for. Putting it in the writer
    // broke exactly those two paths, which is how this boundary got found.
    if (args.reason === "lost") {
      const blocker = lostReceiptBlocker(args.attestations);
      if (blocker) {
        throw new ConvexError({
          code: "LOST_RECEIPT_CHECKS_REQUIRED",
          message: `Before a receipt counts as lost: ${blocker.prompt} ${blocker.blockedHint}`,
        });
      }
    }
    const userId = (await requireUserId(ctx)) as Id<"users">;
    const exceptionId = await attestException(ctx, {
      txn,
      scope,
      reason: args.reason,
      note: args.note,
      ...(args.evidenceStorageIds?.length
        ? { evidenceStorageIds: args.evidenceStorageIds }
        : {}),
      ...(args.attestations?.length ? { attestations: args.attestations } : {}),
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
      afterKey: receiptExceptionFiledKey(args.reason),
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
 * one, outside the caller's scope, or — for `bank_record_only` — coded as
 * LODGING, which the IRS says needs an itemized receipt at any amount) is
 * SKIPPED and counted rather than failing the batch: a backfill selection
 * routinely contains a few of each, and throwing would make the caller
 * re-derive which ones were fine.
 */
export const attestBulk = mutation({
  args: {
    transactionIds: v.array(v.id("transactions")),
    reason: reasonValidator,
    note: v.string(),
  },
  returns: v.object({
    filed: v.number(),
    approved: v.number(),
    pendingApproval: v.number(),
    skipped: v.number(),
  }),
  handler: async (ctx, args) => {
    const userId = (await requireUserId(ctx)) as Id<"users">;
    const threshold = await approvalThresholdCents(ctx);
    let filed = 0;
    let approved = 0;
    let skipped = 0;
    for (const transactionId of args.transactionIds) {
      try {
        const { txn, scope, actorPersonId } =
          await requireAttestReceiptException(ctx, transactionId);
        const exceptionId = await attestException(ctx, {
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
          afterKey: receiptExceptionFiledKey(args.reason),
          reason: args.note.trim(),
          amountCents: txn.amountCents,
        });
        filed += 1;

        // ACKNOWLEDGE-AND-MOVE-ON. Filing 200 transit fares that each then sit
        // in an approval queue is the clutter this flow exists to remove, and
        // the queue would be rubber-stamped anyway. So when the caller could
        // legitimately approve this row on its own — manager rank, and under
        // the org threshold where separation of duties doesn't apply — do it
        // in the same pass. Above the threshold it stays PENDING and still
        // needs a second name, which is the whole point of the threshold.
        if (!exceptionNeedsSecondApprover(txn.amountCents, threshold)) {
          try {
            await requireApproveReceiptException(ctx, transactionId);
            const filedRow = (await ctx.db.get(
              exceptionId,
            )) as Doc<"receiptExceptions"> | null;
            if (filedRow) {
              await decideException(ctx, {
                exception: filedRow,
                approve: true,
                decidedByPersonId: actorPersonId,
                decidedByUserId: userId,
              });
              await logFinanceAudit(ctx, {
                chapterId: scope,
                subjectType: "transaction",
                subjectId: transactionId,
                action: "receipt_exception_decide",
                actorPersonId,
                field: "receiptException",
                before: financeAuditValueLabel(
                  "receipt_exception",
                  "pending",
                  null,
                ),
                after: `Approved — ${RECEIPT_EXCEPTION_REASON_LABELS[args.reason]}`,
                beforeKey: "pending",
                afterKey: receiptExceptionApprovedKey(args.reason),
                amountCents: txn.amountCents,
              });
              approved += 1;
            }
          } catch {
            // Not a manager — the attestation stands and waits for one.
          }
        }
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
    return { filed, approved, pendingApproval: filed - approved, skipped };
  },
});

/** Load a pending exception + authorize a decision on it. Shared by
 *  approve/reject so the two can't drift on scope or rank. */
async function loadForDecision(
  ctx: MutationCtx,
  exceptionId: Id<"receiptExceptions">,
): Promise<{
  exception: Doc<"receiptExceptions">;
  scope: FinanceScope;
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
      chapterId: scope,
      subjectType: "transaction",
      subjectId: exception.transactionId,
      action: "receipt_exception_decide",
      actorPersonId,
      field: "receiptException",
      before: financeAuditValueLabel("receipt_exception", "pending", null),
      after: `Approved — ${RECEIPT_EXCEPTION_REASON_LABELS[exception.reason as ReceiptExceptionReason]}`,
      beforeKey: "pending",
      afterKey: receiptExceptionApprovedKey(
        exception.reason as ReceiptExceptionReason,
      ),
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
      chapterId: scope,
      subjectType: "transaction",
      subjectId: exception.transactionId,
      action: "receipt_exception_decide",
      actorPersonId,
      field: "receiptException",
      before: financeAuditValueLabel("receipt_exception", "pending", null),
      after: financeAuditValueLabel("receipt_exception", "rejected", null),
      beforeKey: "pending",
      afterKey: "rejected",
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
      after: financeAuditValueLabel("receipt_exception", "withdrawn", null),
      beforeKey: receiptExceptionFiledKey(
        exception.reason as ReceiptExceptionReason,
      ),
      afterKey: "withdrawn",
      amountCents: exception.amountCents,
    });
    return null;
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
