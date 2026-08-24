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
import { ConvexError, v, type Infer } from "convex/values";
import {
  MIN_EXCEPTION_NOTE_LENGTH,
  MAX_EXCEPTION_NOTE_LENGTH,
  MAX_EXCEPTION_EVIDENCE,
  RECEIPT_EXCEPTION_REASONS,
  RECEIPT_EXCEPTION_STATUSES,
  RECEIPT_EXCEPTION_REASON_LABELS,
  RECEIPT_EXCEPTION_STATUS_LABELS,
  type ExceptionAttestation,
  type ReceiptExceptionReason,
} from "@events-os/shared";
import type { FinanceScope } from "./finance";
import { codingForTransaction } from "./transactionCoding";

/**
 * ONE exception, projected for display — the shape every surface that renders
 * an exception reads.
 *
 * Lives here rather than in `receiptExceptions.ts` because there are now TWO
 * readers with two different gates: that file's `listForTransaction` (gated by
 * the ATTEST resolver — whoever may file may read what's been filed) and the
 * coding reviewer's record (`transactionCodings.reviewRecord`, gated by the
 * coding VIEW resolver — whoever may decide the coding may read the
 * documentation they are deciding against). Two projections of the same row
 * would drift on exactly the fields an audit needs to match: what was claimed,
 * what was attested, and who decided.
 */
export const exceptionRecord = v.object({
  _id: v.id("receiptExceptions"),
  transactionId: v.id("transactions"),
  amountCents: v.number(),
  reason: v.union(...RECEIPT_EXCEPTION_REASONS.map((r) => v.literal(r))),
  reasonLabel: v.string(),
  note: v.string(),
  status: v.union(...RECEIPT_EXCEPTION_STATUSES.map((s) => v.literal(s))),
  statusLabel: v.string(),
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

/** Project one exception row for display, resolving the two person names and
 *  a signed url + content type for every evidence file. */
export async function projectExceptionRecord(
  ctx: QueryCtx,
  row: Doc<"receiptExceptions">,
): Promise<Infer<typeof exceptionRecord>> {
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
    statusLabel: RECEIPT_EXCEPTION_STATUS_LABELS[row.status],
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
    // `[]` for the exceptions decided before this existed — they're historical
    // rows, not incomplete ones, and an empty list renders as "nothing
    // recorded" rather than as three unanswered questions.
    attestations: row.attestations ?? [],
    attestedByName: await name(row.attestedByPersonId),
    attestedAt: row.attestedAt,
    decidedByName: await name(row.decidedByPersonId),
    decidedAt: row.decidedAt ?? null,
    decisionNote: row.decisionNote ?? null,
  };
}

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
 * LODGING is refused a `bank_record_only` exception outright — see the guard
 * below. Enforced HERE, in the single writer, so `receiptExceptions.attest`,
 * the bulk backfill, and anything filed later all inherit the rule instead of
 * each remembering it.
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
    attestations?: ExceptionAttestation[];
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
  // LODGING NEEDS AN ITEMIZED RECEIPT AT ANY AMOUNT (IRS §274(d) — the $75
  // documentary-evidence line every other expense enjoys simply does not apply
  // to lodging). So "the bank statement line is the only evidence that exists"
  // is never an acceptable answer for a hotel: the statement proves an amount,
  // and what the rule wants is the folio showing what the amount was FOR
  // (room vs. meals vs. movies vs. someone else's room). The other four
  // reasons stay available — a lost folio with photo evidence is a judgment
  // call a manager may still accept.
  if (args.reason === "bank_record_only") {
    const coding = await codingForTransaction(ctx, args.txn._id);
    if (coding?.expenseType === "lodging") {
      throw new ConvexError({
        code: "LODGING_RECEIPT_REQUIRED",
        message:
          "Lodging needs an itemized receipt at any amount — the IRS's $75 documentary-evidence line doesn't apply to hotels, and a bank record can't show what the stay actually covered. Ask the hotel to re-send the folio (they keep them for years); if it truly can't be produced, file a different reason and attach what evidence you have.",
      });
    }
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
    // Recorded whatever the reason — the two "was one even issued?" answers
    // are as much a part of the story as the three lost-receipt ones.
    ...(args.attestations?.length ? { attestations: args.attestations } : {}),
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
 * Retire whatever approved exception a transaction currently carries, clearing
 * the denormalized pointer with it. Returns whether there was one.
 *
 * Two callers, for two different reasons — both cases where the approved
 * attestation has stopped describing the row it's attached to:
 *  - a real receipt landed (a document outranks an assertion),
 *  - the row's AMOUNT was corrected (see `retireApprovedExceptionOnAmountChange`).
 * A no-op when there's nothing approved, so callers can invoke it blind.
 */
export async function retireApprovedException(
  ctx: MutationCtx,
  transactionId: Id<"transactions">,
): Promise<boolean> {
  const txn = await ctx.db.get(transactionId);
  if (!txn?.approvedReceiptExceptionId) return false;
  await ctx.db.patch(txn.approvedReceiptExceptionId, { status: "withdrawn" });
  await ctx.db.patch(transactionId, {
    approvedReceiptExceptionId: undefined,
  });
  return true;
}

/**
 * Retire any approved exception on a transaction because a real receipt just
 * landed. A receipt outranks an exception (`documentationState`), and leaving
 * a stale pointer behind would keep the row reading "Documented exception"
 * when it now has the document itself.
 */
export async function supersedeApprovedExceptionOnReceipt(
  ctx: MutationCtx,
  transactionId: Id<"transactions">,
): Promise<void> {
  await retireApprovedException(ctx, transactionId);
}

/**
 * Retire any approved exception because the transaction's AMOUNT changed.
 *
 * This is a SECURITY fix, not tidiness. An exception snapshots the amount it
 * was filed against, and the separation-of-duties threshold is evaluated
 * against that snapshot (`receiptExceptions.approve`). Without this, a manager
 * could file a $5 exception, self-approve it legitimately (under the
 * threshold, where SOD doesn't apply), then correct the transaction to $5,000
 * — leaving a large charge documented by a self-approved attestation that
 * would have required a second person. Retiring it forces a re-file at the
 * true amount, which re-runs the threshold check.
 *
 * Matches what `schema/finances.ts` already promises about these rows: an
 * exception is re-filed, never patched, so "what was claimed, and against what
 * number" stays recoverable.
 */
export async function retireApprovedExceptionOnAmountChange(
  ctx: MutationCtx,
  transactionId: Id<"transactions">,
): Promise<boolean> {
  return retireApprovedException(ctx, transactionId);
}
