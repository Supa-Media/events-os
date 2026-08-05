/**
 * Receipt exceptions — the ONE write path for the `receiptExceptions` table
 * and the denormalized `transactions.approvedReceiptExceptionId` pointer it
 * maintains.
 *
 * Same single-writer discipline as `lib/receiptLinks.ts`: nothing outside this
 * module inserts/patches a `receiptExceptions` row or touches that pointer.
 * That is the entire reason the pure predicates (`finances.needsDocumentation`,
 * `cards.isMissingReceiptCharge`) can read the pointer off a transaction and
 * trust it without a second db read — the pointer is set if and only if a
 * `status:"approved"` exception exists for that row.
 *
 * See `docs/plans/receipt-exceptions.md` for the design, and
 * `schema/finances.ts`'s `receiptExceptions` doc comment for the table shape.
 */
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { ConvexError } from "convex/values";
import {
  MIN_EXCEPTION_NOTE_LENGTH,
  MAX_EXCEPTION_NOTE_LENGTH,
  MAX_EXCEPTION_EVIDENCE,
  type ReceiptExceptionReason,
} from "@events-os/shared";
import type { FinanceScope } from "./finance";

/** Every exception ever filed against one transaction, newest first — the
 *  detail panel's history. Bounded by how many times one row has been filed
 *  on (a handful, by construction: only one can be pending at a time). */
export async function exceptionsForTransaction(
  ctx: QueryCtx,
  transactionId: Id<"transactions">,
): Promise<Doc<"receiptExceptions">[]> {
  const rows = await ctx.db
    .query("receiptExceptions")
    .withIndex("by_transaction", (q) => q.eq("transactionId", transactionId))
    .collect();
  return rows.sort((a, b) => b.attestedAt - a.attestedAt);
}

/** The OPEN attestation on a transaction, if any. At most one exists at a
 *  time — `attestException` refuses to file a second (see its doc). */
export async function pendingExceptionForTransaction(
  ctx: QueryCtx,
  transactionId: Id<"transactions">,
): Promise<Doc<"receiptExceptions"> | null> {
  const rows = await exceptionsForTransaction(ctx, transactionId);
  return rows.find((r) => r.status === "pending") ?? null;
}

/** Validate + normalize an attestation note. The note is the SUBSTITUTE for
 *  the document, so "" and "n/a" are the failure mode this guards: a blank
 *  note turns the feature back into an undocumented shrug. */
export function normalizeExceptionNote(note: string): string {
  const trimmed = note.trim();
  if (trimmed.length < MIN_EXCEPTION_NOTE_LENGTH) {
    throw new ConvexError({
      code: "NOTE_REQUIRED",
      message: `Say what this expense was for — at least ${MIN_EXCEPTION_NOTE_LENGTH} characters. This note is what stands in for the receipt when the ledger is published.`,
    });
  }
  if (trimmed.length > MAX_EXCEPTION_NOTE_LENGTH) {
    throw new ConvexError({
      code: "NOTE_TOO_LONG",
      message: `Keep the note under ${MAX_EXCEPTION_NOTE_LENGTH} characters.`,
    });
  }
  return trimmed;
}

/**
 * File a `pending` exception against one transaction. Refuses when the row
 * already has a receipt (nothing to except) or already carries an open
 * attestation — a second pending row would give an approver two claims to
 * decide between with no way to tell which is current.
 *
 * Does NOT touch `transactions.approvedReceiptExceptionId`: a pending
 * attestation is not documentation yet, and a row must not leave the chase
 * merely because somebody asked to be let off.
 */
export async function attestException(
  ctx: MutationCtx,
  args: {
    txn: Doc<"transactions">;
    scope: FinanceScope;
    reason: ReceiptExceptionReason;
    note: string;
    evidenceStorageIds?: Id<"_storage">[];
    attestedByPersonId: Id<"people"> | null;
    attestedByUserId: Id<"users">;
  },
): Promise<Id<"receiptExceptions">> {
  if (args.txn.receiptStorageId != null) {
    throw new ConvexError({
      code: "HAS_RECEIPT",
      message:
        "This transaction already has a receipt attached — no exception is needed.",
    });
  }
  if ((args.evidenceStorageIds?.length ?? 0) > MAX_EXCEPTION_EVIDENCE) {
    throw new ConvexError({
      code: "TOO_MUCH_EVIDENCE",
      message: `Attach at most ${MAX_EXCEPTION_EVIDENCE} files of evidence.`,
    });
  }
  const open = await pendingExceptionForTransaction(ctx, args.txn._id);
  if (open) {
    throw new ConvexError({
      code: "ALREADY_PENDING",
      message:
        "This transaction already has a receipt exception awaiting approval.",
    });
  }
  return ctx.db.insert("receiptExceptions", {
    transactionId: args.txn._id,
    chapterId: args.scope,
    amountCents: args.txn.amountCents,
    reason: args.reason,
    note: normalizeExceptionNote(args.note),
    ...(args.evidenceStorageIds?.length
      ? { evidenceStorageIds: args.evidenceStorageIds }
      : {}),
    status: "pending",
    ...(args.attestedByPersonId
      ? { attestedByPersonId: args.attestedByPersonId }
      : {}),
    attestedByUserId: args.attestedByUserId,
    attestedAt: Date.now(),
  });
}

/**
 * Record a decision on a pending exception and keep the transaction's pointer
 * in lock-step: an approval sets `approvedReceiptExceptionId`, a rejection
 * leaves it unset. Both write the decision fields exactly once — this refuses
 * to re-decide a row that has already left `pending`, so an approval can never
 * be quietly flipped to a rejection after the fact (re-filing means a NEW
 * row).
 */
export async function decideException(
  ctx: MutationCtx,
  args: {
    exception: Doc<"receiptExceptions">;
    approve: boolean;
    decisionNote?: string;
    decidedByPersonId: Id<"people"> | null;
    decidedByUserId: Id<"users">;
  },
): Promise<void> {
  if (args.exception.status !== "pending") {
    throw new ConvexError({
      code: "ALREADY_DECIDED",
      message: "This receipt exception has already been decided.",
    });
  }
  const decisionNote = args.decisionNote?.trim() || undefined;
  if (!args.approve && !decisionNote) {
    throw new ConvexError({
      code: "REASON_REQUIRED",
      message:
        "Rejecting a receipt exception requires a reason — the filer needs to know what would make it approvable.",
    });
  }
  await ctx.db.patch(args.exception._id, {
    status: args.approve ? "approved" : "rejected",
    ...(args.decidedByPersonId
      ? { decidedByPersonId: args.decidedByPersonId }
      : {}),
    decidedByUserId: args.decidedByUserId,
    decidedAt: Date.now(),
    ...(decisionNote ? { decisionNote } : {}),
  });
  if (args.approve) {
    await ctx.db.patch(args.exception.transactionId, {
      approvedReceiptExceptionId: args.exception._id,
      // An approved exception resolves the row the same way a receipt does,
      // so the nag timeline is moot from here — mirrors `attachReceipt`'s and
      // `setTransactionStatus`'s own clear. Leaving it would keep rendering
      // "Day 3 overdue" on a row nobody owes anything on.
      receiptReminderStage: undefined,
      lastReminderSentAt: undefined,
    });
  }
}

/**
 * Withdraw an exception — the filer pulling it, almost always because the
 * receipt turned up. Works on a `pending` OR an `approved` row, and clears the
 * transaction's pointer when it was the approved one, so documentation state
 * falls straight back to whatever the row can actually prove.
 */
export async function withdrawException(
  ctx: MutationCtx,
  exception: Doc<"receiptExceptions">,
): Promise<void> {
  if (exception.status === "rejected" || exception.status === "withdrawn") {
    throw new ConvexError({
      code: "ALREADY_CLOSED",
      message: "This receipt exception is already closed.",
    });
  }
  await ctx.db.patch(exception._id, { status: "withdrawn" });
  const txn = await ctx.db.get(exception.transactionId);
  if (txn?.approvedReceiptExceptionId === exception._id) {
    await ctx.db.patch(exception.transactionId, {
      approvedReceiptExceptionId: undefined,
    });
  }
}

/**
 * Retire any approved exception on a transaction because a real receipt just
 * landed. Called by the receipt-link write path: a receipt outranks an
 * exception (`documentationState`), and leaving a stale pointer behind would
 * keep the row reading "Documented exception" when it now has the document
 * itself. A no-op when there's no approved exception, so every attach path can
 * call it unconditionally.
 */
export async function supersedeApprovedExceptionOnReceipt(
  ctx: MutationCtx,
  transactionId: Id<"transactions">,
): Promise<void> {
  const txn = await ctx.db.get(transactionId);
  if (!txn?.approvedReceiptExceptionId) return;
  await ctx.db.patch(txn.approvedReceiptExceptionId, { status: "withdrawn" });
  await ctx.db.patch(transactionId, {
    approvedReceiptExceptionId: undefined,
  });
}
