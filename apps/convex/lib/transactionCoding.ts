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
  DEFAULT_CODING_CONVERSION_SINCE_MS,
  DEFAULT_CODING_REQUIRED_SINCE_MS,
  DEFAULT_MEAL_ATTENDEE_NAMES_MAX_HEADCOUNT,
  MAX_PURPOSE_LENGTH,
  type AttendeeAffiliation,
  type ExpenseType,
} from "@events-os/shared";
import type { FinanceScope } from "./finance";

/** The org's coding policy, falling back to the shared owner-decided defaults
 *  (2026-08-08 requirement date, 2026-09-01 conversion date, names threshold
 *  15). Deliberately has no "off" value — the policy arms itself on the dates;
 *  moving either is a deliberate central-finance act on `financeSettings`.
 *
 *  TWO DATES, READ TOGETHER, USED SEPARATELY. `sinceMs` says a charge owes a
 *  coding; `conversionSinceMs` says a charge that owes one may be BILLED BACK
 *  for it. Every chase surface (facets, digest, reconcile gate) reads only
 *  `sinceMs`. The single sweep that takes money — `cards
 *  .autoConvertOverdueReceipts` — must satisfy both. Returning them from one
 *  place, rather than letting the sweep read its own setting, is what keeps a
 *  future reader from re-collapsing them by reaching for the nearer constant. */
export async function codingPolicy(
  ctx: QueryCtx,
): Promise<{
  sinceMs: number;
  conversionSinceMs: number;
  namesMaxHeadcount: number;
}> {
  const settings = await ctx.db.query("financeSettings").first();
  return {
    sinceMs:
      settings?.codingRequiredSinceMs ?? DEFAULT_CODING_REQUIRED_SINCE_MS,
    conversionSinceMs:
      settings?.codingConversionSinceMs ?? DEFAULT_CODING_CONVERSION_SINCE_MS,
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

/**
 * READ A STORED CODING BACK AS THE FIELDS THAT WROTE IT.
 *
 * ## Why this has to exist
 *
 * `submitCoding` writes with `ctx.db.replace(..., ...fields)`, deliberately —
 * a coding retyped from "travel" to "general" must not keep a stale route, and
 * `replace` is what guarantees that. The consequence is that ANY caller
 * submitting a partial field set silently DELETES everything it omitted.
 *
 * That is fine for the full form, which always sends every field it collected.
 * It is a trap for `transactionCodings.setPurpose` — the grid's inline "what
 * it was for" cell — whose whole job is to change one sentence and touch
 * nothing else. Sending `{ expenseType: "general", businessPurpose }` there
 * would erase a meal's attendee list, a trip's route and a stay's place, and
 * would do it silently, on the one record the IRS asks about.
 *
 * So the edit round-trips through here: the stored coding becomes the fields
 * that produced it, the caller replaces exactly the one it means to, and the
 * same `submitCoding` writes it back with the same validation. Nothing about
 * the write path is relaxed to make the narrow edit possible, which is the
 * only version of this worth having.
 *
 * Type-irrelevant fields are simply absent on the doc (that is what
 * `normalizeCodingFields` guarantees on the way in), so copying whatever is
 * present cannot resurrect a field the type doesn't own.
 */
export function codingWriteFieldsFrom(
  coding: Doc<"transactionCodings">,
): CodingWriteFields {
  return {
    expenseType: coding.expenseType as ExpenseType,
    businessPurpose: coding.businessPurpose,
    ...(coding.travelFrom != null ? { travelFrom: coding.travelFrom } : {}),
    ...(coding.travelTo != null ? { travelTo: coding.travelTo } : {}),
    ...(coding.travelers ? { travelers: coding.travelers } : {}),
    ...(coding.headcount != null ? { headcount: coding.headcount } : {}),
    ...(coding.attendees ? { attendees: coding.attendees } : {}),
    ...(coding.groupDescription != null
      ? { groupDescription: coding.groupDescription }
      : {}),
  };
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
 * THE OTHER HALF OF THE LODGING RULE. `lib/receiptExceptions.ts` refuses a
 * `bank_record_only` exception on a charge already coded `lodging` — but the
 * two facts arrive in either order, and nothing stopped the cheaper sequence:
 * file the bank-record exception on an uncoded charge (where the guard reads
 * no `expenseType` and passes), let it auto-approve under the small-dollar
 * threshold, and only then code it as lodging. The rule would be enforced or
 * not depending purely on which button someone pressed first, which is not a
 * rule.
 *
 * So typing a charge as lodging is refused while a bank-record exception
 * stands on it. Withdrawing the exception is one tap and is the honest move:
 * the folio either exists or a different reason is the true one.
 *
 * Extracted from `submitCoding` when `reviseCodingUnderReview` arrived, for
 * the identical reason the rule exists at all: a REVIEWER retyping a charge
 * to `lodging` from the review record reaches the same column by a different
 * button, and a guard that lived inside one write path would have been
 * enforced or not depending on who did the typing.
 */
async function assertLodgingFolioAvailable(
  ctx: MutationCtx,
  transactionId: Id<"transactions">,
  expenseType: ExpenseType,
): Promise<void> {
  if (expenseType !== "lodging") return;
  const exceptions = await ctx.db
    .query("receiptExceptions")
    .withIndex("by_transaction", (q) => q.eq("transactionId", transactionId))
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
    /** The coding policy date, so the documentation gate below can tell a
     *  REQUIRED coding from a voluntary one. */
    codingRequiredSinceMs: number;
    codedByPersonId: Id<"people"> | null;
    codedByUserId: Id<"users">;
  },
): Promise<{ codingId: Id<"transactionCodings">; resubmission: boolean }> {
  const fields = normalizeCodingFields(args.fields, args.namesMaxHeadcount);

  // A CODING CARRIES ITS OWN DOCUMENTATION (owner decision, 2026-08-08:
  // "they should just upload the receipt when coding").
  //
  // Documentation and coding used to be two independent obligations that
  // merely happened to share a sheet, which meant two nags, two backlogs and
  // two chances to half-finish a charge. They're now one act: you cannot put
  // "here's what this was for" on the record without also saying how it can
  // be proved. Everything else about the two axes is unchanged — they stay
  // separate on the row, because a receipt can be superseded or an exception
  // withdrawn long after the coding was written, and the publishing predicate
  // has to keep seeing that independently.
  //
  // A PENDING exception counts here, deliberately. The gate asks whether the
  // AUTHOR has done their part, and filing an attestation is their part; the
  // approver's decision is a different person's work and blocking submission
  // on it would leave the charge stuck in the author's queue for something
  // they cannot do. The `reconciled` gate in `finances.setTransactionStatus`
  // is where documentation has to be actually RESOLVED (`isUndocumented`
  // counts only approved exceptions) — so nothing publishes on the strength
  // of an unapproved claim.
  //
  // SCOPED TO ROWS THAT OWE A CODING AT ALL — post-policy outflow spend, the
  // same population `finances.requiresCoding` gates on. Unscoped, this
  // punished the only people doing more than they had to: a voluntary coding
  // on a donation inflow, an `excluded` duplicate, a personal charge, or a
  // pre-policy historical row would be refused for want of documentation
  // those rows never owed, and the only way through would have been filing a
  // spurious receipt exception for a manager to adjudicate. A coding nobody
  // required is strictly better than no coding; it must never be harder to
  // give than the required one.
  const codingRequired =
    args.txn.postedAt >= args.codingRequiredSinceMs &&
    args.txn.flow === "outflow" &&
    args.txn.status !== "excluded" &&
    args.txn.isPersonal !== true;
  const hasReceipt = args.txn.receiptStorageId != null;
  if (codingRequired && !hasReceipt) {
    const exceptions = await ctx.db
      .query("receiptExceptions")
      .withIndex("by_transaction", (q) => q.eq("transactionId", args.txn._id))
      .collect();
    const standing = exceptions.some(
      (e) => e.status === "approved" || e.status === "pending",
    );
    if (!standing) {
      throw new ConvexError({
        code: "DOCUMENTATION_REQUIRED",
        message:
          "Attach the receipt before submitting this coding — or, if no receipt exists, say why in the same sheet. What the money was for and how it can be proved are one record, not two errands.",
      });
    }
  }

  await assertLodgingFolioAvailable(ctx, args.txn._id, fields.expenseType);
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

/** Deep value equality over a coding's field set, key-order-independent. The
 *  two sides come from different places — one read off a stored document, one
 *  built by `normalizeCodingFields` — so a plain `JSON.stringify` compare
 *  would report an attendee list as "changed" purely because the stored
 *  object happens to serialize `name` before `personId`. */
function sameCodingFields(a: CodingWriteFields, b: CodingWriteFields): boolean {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") {
      return Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
        .map(([k, v]) => [k, canonical(v)]);
    }
    return value;
  };
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

/**
 * CORRECT A SUBMITTED CODING IN PLACE — the reviewer's "fix it rather than
 * bounce it" write (`transactionCodings.reviseUnderReview`).
 *
 * ## Why this is not `submitCoding`
 *
 * `submitCoding` stamps `codedByPersonId`/`codedByUserId` with the caller and
 * `db.replace`s the row. Routing a reviewer's correction through it would do
 * three wrong things at once: rewrite WHOSE testimony this is (the author's
 * name would be replaced by the person checking their work), hand that
 * reviewer a separation-of-duties pass on their own subsequent approval —
 * because the SoD compare would then find their own id on both sides and, for
 * anyone but a superuser, refuse the approval outright, stranding the row —
 * and silently drop the `publicPurpose` redaction, `reviewerRemindedAt` and
 * the `portedFrom*` provenance that `replace` does not carry.
 *
 * So this is a PATCH of exactly the fields a reviewer may touch, and it says
 * so by construction: `businessPurpose` is not in the argument list at all.
 * The author's sentence is the substantiation of record for an accountable
 * plan; the reviewer's channel for the PUBLISHED wording is `publicPurpose`
 * (`transactionCodings.setPublicPurpose`), which stores the rewrite beside the
 * original rather than over it. Do not "simplify" the two into one editable
 * string — that is the exact falsification the schema's own comment forbids.
 *
 * `undefined` on a type-irrelevant field is a DELETION in Convex's patch
 * semantics, which is what makes retyping honest: a charge retyped from
 * `travel` to `general` loses its route rather than keeping a stale one, the
 * same guarantee `submitCoding`'s `replace` gives. That is why the whole
 * normalized field set is written every time rather than only what changed.
 *
 * ## What it refuses
 *
 * An APPROVED coding. That row is the record, and amending it is a decision
 * with its own audited path — a reviewer reopens it (`requestChanges`), which
 * tells the author. A `changes_requested` row is refused for the mirror
 * reason: it is back with its author, mid-conversation, and a reviewer
 * editing underneath them would answer their own send-back.
 *
 * A NO-OP writes nothing and stamps nothing, and returns `false`. The review
 * record renders "Amended during review by …" off that stamp, and a reviewer
 * who opens the panel to set a BUDGET (the common case — the whole reason the
 * panel exists) posts the unchanged field set back with it. Stamping that
 * would put a claim on the record that nobody made, on most of the rows that
 * ever go through here.
 */
export async function reviseCodingUnderReview(
  ctx: MutationCtx,
  args: {
    coding: Doc<"transactionCodings">;
    txn: Doc<"transactions">;
    /** The merged field set — the stored coding read back through
     *  `codingWriteFieldsFrom`, with the reviewer's corrections applied over
     *  it. Validated by the SAME `normalizeCodingFields` the author's own
     *  submit runs, so a correction can never leave a record the author
     *  could not have submitted. */
    fields: CodingWriteFields;
    namesMaxHeadcount: number;
    revisedByPersonId: Id<"people"> | null;
    revisedByUserId: Id<"users">;
  },
  /** True iff anything actually changed — see the no-op note above. */
): Promise<boolean> {
  if (args.coding.status !== "submitted") {
    throw new ConvexError({
      code: "NOT_SUBMITTED",
      message:
        args.coding.status === "approved"
          ? "This coding is already approved, so it is the record. Send it back if it needs to change — reopening an approved coding is itself an audited decision."
          : "This coding is back with its author. Wait for them to resubmit rather than editing it underneath them.",
    });
  }
  const fields = normalizeCodingFields(args.fields, args.namesMaxHeadcount);
  // Compared against the STORED row read back through the same projection the
  // caller built its input from, so "unchanged" means the same thing on both
  // sides. Validation still runs first: a correction that would leave the
  // record incomplete is refused whether or not it changes anything.
  const before = codingWriteFieldsFrom(args.coding);
  if (sameCodingFields(before, fields)) return false;
  await assertLodgingFolioAvailable(ctx, args.txn._id, fields.expenseType);
  await ctx.db.patch(args.coding._id, {
    expenseType: fields.expenseType,
    // Every type-specific field written every time — present ones set, absent
    // ones cleared. See the doc above on why `undefined` is load-bearing here.
    travelFrom: fields.travelFrom,
    travelTo: fields.travelTo,
    travelers: fields.travelers,
    headcount: fields.headcount,
    attendees: fields.attendees,
    groupDescription: fields.groupDescription,
    updatedAt: Date.now(),
    ...(args.revisedByPersonId
      ? { revisedByPersonId: args.revisedByPersonId }
      : {}),
    revisedByUserId: args.revisedByUserId,
    revisedAt: Date.now(),
  });
  return true;
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
    /** The decider is the coding's own author, allowed through the
     *  solo-operator relaxation (`maySelfDecideCoding`). Recorded on the row
     *  as `approvalParty: "single"` — the bypass must leave a durable trace,
     *  exactly as `budgets.approvalParty` does. */
    selfApproved?: boolean;
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
    // Only an APPROVAL records its party — a send-back decides nothing final.
    // "single" = the solo-operator self-approval bypass; "two_party" = a
    // different identity decided, the normal case. See the schema doc.
    ...(args.approve
      ? {
          approvalParty: args.selfApproved
            ? ("single" as const)
            : ("two_party" as const),
        }
      : {}),
  });
  await ctx.db.patch(args.coding.transactionId, { codingState: status });
}

/**
 * UNDO AN APPROVAL — put the coding back exactly where it was a moment ago.
 *
 * ## Why this is not `decideCoding({ approve: false })`
 *
 * The undo affordance originally called `requestChanges`, and that was wrong
 * in two ways that only look cosmetic:
 *
 *  1. IT LANDED IN THE WRONG STATE. `changes_requested` means "the AUTHOR must
 *     act" — it moves the row into the spender's queue and asks them to fix
 *     something. But an undo says the APPROVER mis-tapped. Nobody found
 *     anything wrong with the coding; it was awaiting review, and it should be
 *     awaiting review again. Reusing the send-back silently converted "waiting
 *     on a reviewer" into "waiting on the person who wrote it".
 *  2. IT TOLD THE AUTHOR. `requestChanges` schedules
 *     `cards.notifyCodingSentBack`, which carries the review note. The author
 *     never saw the approval, so they would get a notification about a state
 *     that never existed from their side — with "Undone by the approver"
 *     rendered to them as if it were feedback on their work.
 *
 * The fix is NOT a `silent` flag on `requestChanges`. That notification exists
 * precisely because a send-back nobody hears about is a note in a row nobody
 * reopens (see `transactionCodings.requestChanges`); an off switch on the
 * general path would be a worse trade than the bug. So this is its own act,
 * with its own narrow rules, enforced by its caller
 * (`transactionCodings.undoApproval`): only the identity that made the
 * approval, and only inside `UNDO_APPROVAL_WINDOW_MS`.
 *
 * ## What it clears, and why all of it
 *
 * Everything `decideCoding` stamped on the way in — `decidedByPersonId`,
 * `decidedByUserId`, `decidedAt`, `approvalParty`. A row carrying "approved by
 * X, single-party" while sitting in `submitted` would be a decision record for
 * a decision that no longer stands, and `approvalParty` in particular is the
 * durable trace of the solo-operator bypass, which must describe a LIVE
 * approval or nothing at all.
 *
 * `reviewNote` is deliberately untouched: it belongs to whatever send-back
 * preceded this coding's last submission, and an approver's mis-tap is no
 * reason to erase the author's outstanding instructions.
 *
 * The audit entry is the caller's job, as with every other decision in this
 * module, and it must read as an UNDO — an auditor must never find a
 * send-back that never happened.
 */
export async function undoCodingApproval(
  ctx: MutationCtx,
  args: { coding: Doc<"transactionCodings"> },
): Promise<void> {
  if (args.coding.status !== "approved") {
    throw new ConvexError({
      code: "NOT_APPROVED",
      message: "There is no approval on this coding to undo.",
    });
  }
  await ctx.db.patch(args.coding._id, {
    status: "submitted",
    decidedByPersonId: undefined,
    decidedByUserId: undefined,
    decidedAt: undefined,
    approvalParty: undefined,
  });
  await ctx.db.patch(args.coding.transactionId, { codingState: "submitted" });
}

/**
 * Materialize a coding row PORTED verbatim from an approved reimbursement
 * line — never composed, never re-typed (founder directive, 2026-08-13). The
 * caller (`increasePayoutMachine.ts#postReimbursementSpend`, live path; the
 * `0068` migration, historical backfill) has already decided the request is
 * eligible — exactly one line, that line's own §274(d) answer passes
 * `codingFieldProblems` unmodified — via
 * `reimbursementTxnFields.ts#deriveReimbursementCodingMaterialization`. This
 * function is the single WRITE for that decision, keeping the same
 * single-writer discipline every other coding write in this module holds:
 * nothing outside `lib/transactionCoding.ts` inserts a `transactionCodings`
 * row or touches `codingState`.
 *
 * Differs from `submitCoding` deliberately:
 *  - status lands `"approved"` directly — the request's own review WAS the
 *    coding review (the founder directive's framing: "don't re-stage it").
 *  - skips the `DOCUMENTATION_REQUIRED` gate entirely. The payout row's
 *    documentation is the REQUEST's own receipt trail (see
 *    `deriveReimbursementTxnFields`) — this function must never fabricate a
 *    documentation state the row doesn't have, so it simply doesn't touch
 *    that axis at all.
 *  - NEVER clobbers an existing coding (human or already-ported) — returns
 *    `null` and does nothing. This is what makes the live path AND the
 *    migration both idempotent for free.
 */
export async function materializePortedReimbursementCoding(
  ctx: MutationCtx,
  args: {
    transactionId: Id<"transactions">;
    scope: FinanceScope;
    fields: CodingWriteFields;
    namesMaxHeadcount: number;
    /** AUTHORSHIP — the claimant's testimony. Both optional: an accountless
     *  public submitter has neither a roster link nor a `users` row, and
     *  authorship must never fall back to the approver (see the schema
     *  doc on `codedByUserId`). */
    codedByPersonId?: Id<"people">;
    codedByUserId?: Id<"users">;
    /** DECISION — whoever approved the reimbursement request; the request
     *  review WAS the coding review. */
    decidedByPersonId?: Id<"people">;
    decidedByUserId?: Id<"users">;
    decidedAt: number;
    /** The claimant's own first-submission time, ported through rather than
     *  stamped "now" — this is when the testimony was actually written. */
    submittedAt: number;
    approvalParty: "single" | "two_party";
    /** PROVENANCE — exactly one of these, naming the rail the testimony came
     *  from. Both are optional in the signature (a caller supplies whichever
     *  applies) but a caller supplying NEITHER is a bug: the whole point of
     *  this function over the normal editor is that the row can say where its
     *  words came from. */
    portedFromReimbursementId?: Id<"reimbursementRequests">;
    portedFromContractorPaymentId?: Id<"contractorPayments">;
  },
): Promise<Id<"transactionCodings"> | null> {
  const existing = await codingForTransaction(ctx, args.transactionId);
  if (existing) return null;
  const fields = normalizeCodingFields(args.fields, args.namesMaxHeadcount);
  const codingId = await ctx.db.insert("transactionCodings", {
    transactionId: args.transactionId,
    chapterId: args.scope,
    ...fields,
    status: "approved",
    ...(args.codedByPersonId ? { codedByPersonId: args.codedByPersonId } : {}),
    ...(args.codedByUserId ? { codedByUserId: args.codedByUserId } : {}),
    submittedAt: args.submittedAt,
    updatedAt: args.decidedAt,
    ...(args.decidedByPersonId
      ? { decidedByPersonId: args.decidedByPersonId }
      : {}),
    ...(args.decidedByUserId ? { decidedByUserId: args.decidedByUserId } : {}),
    decidedAt: args.decidedAt,
    approvalParty: args.approvalParty,
    ...(args.portedFromReimbursementId
      ? { portedFromReimbursementId: args.portedFromReimbursementId }
      : {}),
    ...(args.portedFromContractorPaymentId
      ? { portedFromContractorPaymentId: args.portedFromContractorPaymentId }
      : {}),
  });
  await ctx.db.patch(args.transactionId, { codingState: "approved" });
  return codingId;
}
