/**
 * Contractor payments — paying somebody for work, when there is nothing to
 * reimburse and no portal to pay them through.
 *
 * Sibling of `reimbursements.ts`, and it borrows that file's plumbing on
 * purpose: the accountless secret-token public page, the Increase external
 * account, the separation-of-duties approval, the ACH payout rail. What it does
 * NOT borrow is the assumption underneath a reimbursement — that the money is
 * paying back a receipt. Here the AGREEMENT is the substantiation, the money is
 * reportable income to the person receiving it, and the ledger row must not say
 * "Reimbursement to <name>".
 *
 * Surfaces, mirroring `reimbursements.ts`:
 *   - PUBLIC, no auth: everything the /contract page needs. The contractor has
 *     no account — they are identified by the record's secret `token`, looked
 *     up via `by_token` and never returned by any in-app list query.
 *   - IN-APP (auth, finance-gated): compose terms + send a link, the review
 *     queue, approve/reject/send-back, and pay.
 *   - INTERNAL: the treasurer nudge/escalation sweep and the tax-document
 *     retention purge, both driven from `crons.ts`.
 *
 * TWO ENTRY POINTS, ONE RECORD (founder, 2026-08-14):
 *   staff pre-fills → `draft` → `sent` → contractor completes → `submitted`
 *   blank request   →                                           `submitted`
 * From `submitted` on there is one queue and one route. `origin` is what stays
 * different, and it buys exactly two enforced consequences: a `self_serve` row
 * arrives UNCODED and `approve` refuses until a human codes it, and a
 * `staff_prefilled` row's terms are read-only to the contractor (the server
 * ignores those keys on the public submit rather than trusting the page).
 *
 * INVARIANTS:
 *  - Money is ALWAYS a non-negative INTEGER number of cents, bounded by
 *    `CONTRACTOR_PAYMENT_MAX_CENTS` — a typo guard, not a policy limit.
 *  - Every row is chapter-scoped; every client-supplied id is verified to
 *    belong to the resolved chapter before use.
 *  - `token` is secret: looked up by `by_token`, never leaked in in-app lists.
 *  - RAW BANK DIGITS ARE NEVER PERSISTED. Routing + account numbers are
 *    validated, handed to Increase once, and only `externalAccountId` +
 *    `bankAccountLast4` come back. This is the same absolute rule
 *    `increaseExternalAccounts.ts` enforces four ways for reimbursements.
 *  - THE TAX DOCUMENT'S STORAGE ID IS NEVER RETURNED BY A QUERY. It lives in
 *    `contractorTaxDocuments` and is reachable only through
 *    `viewTaxDocument`, which gates on `requireContractorTaxDocView` and logs
 *    every view. `storage.getUrl` is gated only by `requireUserId`, so a
 *    leaked id is a leaked SSN.
 *  - `serviceDescription` PUBLISHES VERBATIM on the public ledger. Every write
 *    path runs it through the shared `publicTextProblems`, so the public page,
 *    the in-app form and the server refuse the same strings.
 *  - EDITING AGREED TERMS AFTER ACCEPTANCE VOIDS THE ACCEPTANCE. Amount,
 *    description, and service date are what the contractor signed; changing one
 *    bumps `agreementTermsVersion`, clears the acceptance, reverts to `sent`
 *    and re-notifies. Otherwise we hold a signature against terms nobody
 *    agreed to.
 *  - Separation of duties is TWO-LAYERED and each layer compares BOTH the
 *    roster link and the normalized email: `assertContractorApprovalSoD` at
 *    approve, and again at pay. A payee with no account is exactly who the
 *    email half is for.
 *  - All failures throw `ConvexError` (never a plain `Error`).
 */
import {
  query,
  mutation,
  action,
  internalQuery,
  internalMutation,
  internalAction,
} from "./_generated/server";
import type { ActionCtx, MutationCtx, QueryCtx } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import {
  CONTRACTOR_PAYMENT_STATUSES,
  CONTRACTOR_PAYMENT_STATUS_LABELS,
  CONTRACTOR_PAYMENT_ORIGINS,
  CONTRACTOR_TAX_DOC_KINDS,
  CONTRACTOR_SERVICE_DESCRIPTION_MAX,
  CONTRACTOR_PAYMENT_REVIEW_STATUSES,
  contractorAmountProblems,
  contractorCanEdit,
  publicTextProblems,
  contractorDescriptionProblems,
  isForeignTaxDoc,
  taxDocPurgeAfter,
  extendedTaxDocPurgeAfter,
  unpaidTaxDocPurgeAfter,
  taxDocIsCurrent,
  taxDocReuseProblem,
  type ContractorPaymentStatus,
  type ContractorPaymentOrigin,
  type ContractorTaxDocKind,
} from "@events-os/shared";
import {
  EXTERNAL_ACCOUNT_FUNDINGS,
  type ExternalAccountFunding,
} from "@events-os/shared";
import { normalizeEmail, getUserEmail } from "./lib/access";
import { requireChapterId, requireInChapter } from "./lib/context";
import { assertRoutingNumber, assertAccountNumber } from "./increase";
import { sendEmail, emailShell } from "./ticketingEmails";
import { appUrl, siteUrl } from "./lib/siteUrl";
import {
  buildAgreementInvite,
  buildSubmittedReceipt,
  buildChangesRequestedNotice,
  buildApprovedNotice,
  buildPaidNotice,
  buildReviewTask,
} from "./lib/contractorPaymentEmails";
import {
  resolveCallerPersonId,
  assertSeparationOfDuties,
  defaultFundId,
  listChapterFinanceManagerPersonIds,
} from "./lib/finance";
import {
  profileFor,
  latestTaxDocFor,
  matchPersonByEmail,
  touchUnpaidTaxDoc,
} from "./contractorProfiles";
import {
  requireContractorPaymentsView,
  requireContractorPaymentsCompose,
  requireContractorPaymentsApprove,
  requireContractorTaxDocView,
  hasContractorPaymentsCompose,
  hasContractorPaymentsApprove,
  hasContractorTaxDocView,
} from "./lib/contractorPaymentsAccess";

// ── Status sets the transitions are guarded against ─────────────────────────
/** A reviewer may decide a payment only from here. */
const REVIEWABLE_STATUSES: ContractorPaymentStatus[] = ["submitted"];
/** Terms may be edited while nothing has been promised OR while the contractor
 *  still holds the ball. Past `approved` the terms are what was approved. */
const TERMS_EDITABLE_STATUSES: ContractorPaymentStatus[] = [
  "draft",
  "sent",
  "submitted",
  "changes_requested",
];
/** Cancelling is legal until money is in motion. */
const CANCELABLE_STATUSES: ContractorPaymentStatus[] = [
  "draft",
  "sent",
  "submitted",
  "changes_requested",
  "approved",
];

function assertTransition(
  current: ContractorPaymentStatus,
  allowedFrom: readonly ContractorPaymentStatus[],
  action: string,
): void {
  if (!allowedFrom.includes(current)) {
    throw new ConvexError({
      code: "ILLEGAL_TRANSITION",
      message: `Can't ${action} a contractor payment that's ${CONTRACTOR_PAYMENT_STATUS_LABELS[current]}.`,
    });
  }
}

// ── Small helpers ───────────────────────────────────────────────────────────
/** A short, human-facing reference derived from the id, matching
 *  `reimbursements.ts#referenceFor`'s shape so the two read as siblings on a
 *  screen. `CP-` for contractor payment. */
export function contractorReferenceFor(id: Id<"contractorPayments">): string {
  return `CP-${String(id).slice(-6).toUpperCase()}`;
}

function cap(value: string, max: number): string {
  return value.trim().slice(0, max);
}

function capOptional(value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined;
  const out = cap(value, max);
  return out.length > 0 ? out : undefined;
}

/** Validate an integer-cents amount against the shared rule, so the public
 *  page, the in-app form and the server all refuse the same numbers. */
function assertAmount(amountCents: number): void {
  const problems = contractorAmountProblems(amountCents);
  if (problems.length > 0) {
    throw new ConvexError({ code: "INVALID_INPUT", message: problems[0] });
  }
}

/**
 * Validate the one string that becomes a permanent public statement.
 *
 * Runs the SHARED `publicTextProblems` — the identical check the public page
 * shows inline and the in-app form shows inline — so a description that the
 * page warned about cannot be forced through by posting directly. Length is
 * capped for the same reason the ledger row is a row: a paragraph is not a
 * description.
 */
function assertPublicDescription(text: string): string {
  const out = cap(text, CONTRACTOR_SERVICE_DESCRIPTION_MAX);
  // The SHARED rule — length and PII in one call, so the public page, the
  // in-app composer and this server all refuse the same strings. The length
  // half is the coding validator's own minimum: see
  // `CONTRACTOR_SERVICE_DESCRIPTION_MIN` for why accepting anything shorter
  // builds a payment that only fails at the moment somebody presses Pay.
  const problems = contractorDescriptionProblems(out);
  if (problems.length > 0) {
    const isPii = publicTextProblems(out).length > 0;
    throw new ConvexError({
      code: isPii ? "PUBLIC_PII" : "INVALID_INPUT",
      message: isPii
        ? `${problems[0]} This description is published publicly, so please reword it without personal details.`
        : problems[0],
    });
  }
  return out;
}

/** A service date sanity window, mirroring `assertTransactionDate`'s reasoning
 *  in `reimbursements.ts`: a little future tolerance for clock skew and
 *  genuinely scheduled work, and a hard floor so a three-year-old engagement
 *  isn't quietly booked into this year's budget. */
const SERVICE_DATE_MAX_FUTURE_MS = 365 * 24 * 60 * 60 * 1000;
const SERVICE_DATE_MAX_PAST_MS = 3 * 365 * 24 * 60 * 60 * 1000;

function assertServiceDate(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value)) {
    throw new ConvexError({
      code: "INVALID_INPUT",
      message: "That service date isn't a real date.",
    });
  }
  const now = Date.now();
  if (value > now + SERVICE_DATE_MAX_FUTURE_MS) {
    throw new ConvexError({
      code: "INVALID_INPUT",
      message: "That service date is more than a year out.",
    });
  }
  if (value < now - SERVICE_DATE_MAX_PAST_MS) {
    throw new ConvexError({
      code: "INVALID_INPUT",
      message: "That service date is more than three years ago.",
    });
  }
  return value;
}

/**
 * At most ONE of event/project/budget, exactly as `createReimbursement`
 * enforces it. Three ways to say "what this money is for" is a convenience;
 * two of them set at once is a rollup counting the same spend twice.
 */
function assertSingleAttribution(args: {
  eventId?: Id<"events">;
  projectId?: Id<"projects">;
  budgetId?: Id<"budgets">;
}): void {
  const set = [args.eventId, args.projectId, args.budgetId].filter(
    (x) => x != null,
  );
  if (set.length > 1) {
    throw new ConvexError({
      code: "INVALID_INPUT",
      message: "Pick one thing this is for — an event, a project, or a budget.",
    });
  }
}

/** Is this row coded enough to approve? A `self_serve` request arrives with
 *  whatever the requester claimed, which is not evidence — a human has to have
 *  said which budget it belongs to before the money can be released. */
function isCoded(row: Doc<"contractorPayments">): boolean {
  return row.eventId != null || row.projectId != null || row.budgetId != null;
}

/** The token every public link is addressed by. `crypto.randomUUID()` is what
 *  `createReimbursement` mints and it is unguessable; matching it keeps one
 *  answer to "how secret is a link in this app?". */
function mintToken(): string {
  return crypto.randomUUID();
}

async function paymentByToken(
  ctx: QueryCtx,
  token: string,
): Promise<Doc<"contractorPayments"> | null> {
  if (!token) return null;
  return await ctx.db
    .query("contractorPayments")
    .withIndex("by_token", (q) => q.eq("token", token))
    .unique();
}

/** Load a payment for a manager action: resolve the chapter, verify the row
 *  belongs to it, gate on approve rank, and hand back the caller's identity —
 *  the shape `reimbursements.ts#loadForManage` established. */
async function loadForManage(
  ctx: MutationCtx,
  contractorPaymentId: Id<"contractorPayments">,
): Promise<{
  chapterId: Id<"chapters">;
  row: Doc<"contractorPayments">;
  callerPersonId: Id<"people">;
  callerEmail: string | null;
}> {
  const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
  const row = await ctx.db.get(contractorPaymentId);
  await requireInChapter(ctx, chapterId, row, "Contractor payment");
  await requireContractorPaymentsApprove(ctx, chapterId);
  const callerPersonId = await resolveCallerPersonId(ctx, chapterId);
  const callerEmail = await getUserEmail(ctx);
  return { chapterId, row: row!, callerPersonId, callerEmail };
}

/**
 * Separation of duties for a contractor payment, enforced by THREE independent
 * signals rather than reimbursements' two — because this record has a third
 * party reimbursements don't have: whoever WROTE the terms.
 *
 *   - the roster link: the approver is the payee, or
 *   - the email: the approver's own auth email is the payee's email
 *     (case-insensitive) — the check that catches an accountless payee, which
 *     is the normal case here, and
 *   - authorship: the approver is the person who composed the agreement.
 *
 * That third one is the addition. A reimbursement's requester IS its payee, so
 * two signals cover it. Here a staffer can pre-fill an agreement naming
 * somebody else and then approve it themselves, which is the exact shape of
 * the fraud this control exists to stop: one person deciding both that the org
 * owes money and that it should be paid.
 *
 * RESIDUAL LIMITATION (accepted, same as reimbursements'): two colluding
 * insiders still pass. That is what the append-only `approvals` trail is for.
 */
function assertContractorApprovalSoD(
  callerPersonId: Id<"people">,
  callerEmail: string | null,
  row: Doc<"contractorPayments">,
): void {
  assertSeparationOfDuties(callerPersonId, row.personId);
  const approver = normalizeEmail(callerEmail);
  const payee = normalizeEmail(row.payeeEmail);
  if (approver && payee && approver === payee) {
    throw new ConvexError({
      code: "SOD_VIOLATION",
      message: "The approver must be different from the payee.",
    });
  }
  if (row.createdByPersonId && row.createdByPersonId === callerPersonId) {
    throw new ConvexError({
      code: "SOD_VIOLATION",
      message:
        "Someone else has to approve this — you wrote the agreement, so you can't also release the money.",
    });
  }
}

/** Append to the shared approval trail. Same table and shape reimbursements
 *  use; `contractor_payment` is its own subject type so the two histories are
 *  queryable apart. */
async function recordApproval(
  ctx: MutationCtx,
  chapterId: Id<"chapters">,
  contractorPaymentId: Id<"contractorPayments">,
  action: "approve" | "reject" | "cancel" | "edit" | "pay",
  actorPersonId: Id<"people">,
  note?: string,
): Promise<void> {
  await ctx.db.insert("approvals", {
    chapterId,
    subjectType: "contractor_payment",
    subjectId: String(contractorPaymentId),
    action,
    actorPersonId,
    ...(note ? { note } : {}),
    createdAt: Date.now(),
  });
}

// ── The one write path every create goes through ────────────────────────────
/**
 * Create a contractor payment. THE SINGLE INVARIANT OWNER — both entry points
 * (staff pre-fill and self-serve request) land here, so validation, the public-
 * text check, the attribution rule and the token mint cannot drift between the
 * two surfaces. `createReimbursement` plays the same role in its file and for
 * the same reason.
 */
async function createContractorPayment(
  ctx: MutationCtx,
  args: {
    chapterId: Id<"chapters">;
    origin: ContractorPaymentOrigin;
    status: ContractorPaymentStatus;
    payeeName: string;
    payeeEmail?: string;
    payeePhone?: string;
    payeeBusinessName?: string;
    personId?: Id<"people">;
    serviceDescription: string;
    serviceDate?: number;
    agreedAmountCents: number;
    agreementNotes?: string;
    eventId?: Id<"events">;
    projectId?: Id<"projects">;
    budgetId?: Id<"budgets">;
    categoryId?: Id<"budgetCategories">;
    fundId?: Id<"funds">;
    createdByPersonId?: Id<"people">;
  },
): Promise<{ id: Id<"contractorPayments">; token: string }> {
  const name = cap(args.payeeName, 200);
  if (name.length < 2) {
    throw new ConvexError({
      code: "INVALID_INPUT",
      message: "Who is being paid?",
    });
  }
  assertAmount(args.agreedAmountCents);
  const serviceDescription = assertPublicDescription(args.serviceDescription);
  const serviceDate = assertServiceDate(args.serviceDate);
  assertSingleAttribution(args);

  // Every client-supplied id must belong to THIS chapter — the rule that keeps
  // a crafted request from coding spend into somebody else's budget.
  for (const [id, table, label] of [
    [args.eventId, "events", "Event"],
    [args.projectId, "projects", "Project"],
    [args.budgetId, "budgets", "Budget"],
    [args.categoryId, "budgetCategories", "Category"],
    [args.fundId, "funds", "Fund"],
  ] as const) {
    if (!id) continue;
    const doc = await ctx.db.get(id as Id<"events">);
    await requireInChapter(ctx, args.chapterId, doc, label);
  }

  const now = Date.now();
  const token = mintToken();
  const fundId = args.fundId ?? (await defaultFundId(ctx, args.chapterId));

  const id = await ctx.db.insert("contractorPayments", {
    chapterId: args.chapterId,
    token,
    status: args.status,
    origin: args.origin,
    payeeName: name,
    ...(capOptional(args.payeeEmail, 200)
      ? { payeeEmail: normalizeEmail(args.payeeEmail) ?? undefined }
      : {}),
    ...(capOptional(args.payeePhone, 40)
      ? { payeePhone: capOptional(args.payeePhone, 40) }
      : {}),
    ...(capOptional(args.payeeBusinessName, 200)
      ? { payeeBusinessName: capOptional(args.payeeBusinessName, 200) }
      : {}),
    ...(args.personId ? { personId: args.personId } : {}),
    serviceDescription,
    ...(serviceDate != null ? { serviceDate } : {}),
    agreedAmountCents: args.agreedAmountCents,
    ...(capOptional(args.agreementNotes, 4000)
      ? { agreementNotes: capOptional(args.agreementNotes, 4000) }
      : {}),
    agreementTermsVersion: 1,
    ...(args.eventId ? { eventId: args.eventId } : {}),
    ...(args.projectId ? { projectId: args.projectId } : {}),
    ...(args.budgetId ? { budgetId: args.budgetId } : {}),
    ...(args.categoryId ? { categoryId: args.categoryId } : {}),
    ...(fundId ? { fundId } : {}),
    ...(args.createdByPersonId
      ? { createdByPersonId: args.createdByPersonId }
      : {}),
    ...(args.status === "submitted" ? { submittedAt: now } : {}),
    createdAt: now,
    updatedAt: now,
  });
  return { id, token };
}

// ── IN-APP: composing and sending an agreement ──────────────────────────────
/**
 * Pre-fill a contractor agreement and get back a link to send them.
 *
 * This is the founder's primary flow: "if I pre-do something, I'm able to copy
 * the link and send it to the contractor." Everything the org knows goes in
 * here — the service, the date, the amount, and the coding — and the
 * contractor's side is reduced to identity, tax form, and where the money goes.
 *
 * Lands in `draft`. Sending is a separate, deliberate step (`send`) so that
 * writing terms and committing them to a stranger are two different acts with
 * two different moments to change your mind.
 */
export const createAgreement = mutation({
  args: {
    payeeName: v.string(),
    payeeEmail: v.optional(v.string()),
    payeePhone: v.optional(v.string()),
    // The name they invoice under, when they invoice as an entity. Accepted
    // here so a remembered one carries from the roster picker — the internal
    // `createContractorPayment` always supported it and only the public path
    // could supply it, which meant picking a returning contractor silently
    // dropped the business name we already knew.
    payeeBusinessName: v.optional(v.string()),
    personId: v.optional(v.id("people")),
    serviceDescription: v.string(),
    serviceDate: v.optional(v.number()),
    agreedAmountCents: v.number(),
    agreementNotes: v.optional(v.string()),
    eventId: v.optional(v.id("events")),
    projectId: v.optional(v.id("projects")),
    budgetId: v.optional(v.id("budgets")),
    categoryId: v.optional(v.id("budgetCategories")),
    fundId: v.optional(v.id("funds")),
  },
  handler: async (ctx, args) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireContractorPaymentsCompose(ctx, chapterId);
    const callerPersonId = await resolveCallerPersonId(ctx, chapterId);
    if (args.personId) {
      const person = await ctx.db.get(args.personId);
      await requireInChapter(ctx, chapterId, person, "Person");
    }
    const { id, token } = await createContractorPayment(ctx, {
      ...args,
      chapterId,
      origin: "staff_prefilled",
      status: "draft",
      createdByPersonId: callerPersonId,
    });
    return { contractorPaymentId: id, token };
  },
});

/**
 * Mark a drafted agreement as sent and hand back the link.
 *
 * Emails the contractor when we have an address; the link is returned either
 * way, because the founder's stated workflow is copying it into whatever
 * channel they already talk to this person on. A send with no email address is
 * therefore normal, not a degraded case.
 */
export const send = mutation({
  args: { contractorPaymentId: v.id("contractorPayments") },
  handler: async (ctx, { contractorPaymentId }) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    const row = await ctx.db.get(contractorPaymentId);
    await requireInChapter(ctx, chapterId, row, "Contractor payment");
    await requireContractorPaymentsCompose(ctx, chapterId);
    assertTransition(row!.status, ["draft", "sent"], "send");

    // The link is addressed by the CHAPTER SLUG, and `chapters.slug` is
    // optional. Without one the URL degrades to `/contract/?token=…`, which the
    // route 404s — so `send` would succeed, staff would copy a dead link into a
    // text message, and the contractor would never be able to get paid, with
    // nothing anywhere reporting a failure. Refuse loudly instead: this is the
    // one moment someone can still fix it.
    const chapter = await ctx.db.get(chapterId);
    if (!chapter?.slug) {
      throw new ConvexError({
        code: "CHAPTER_SLUG_MISSING",
        message:
          "This chapter needs a public web address before you can send a contractor link. Set the chapter's slug in settings first.",
      });
    }

    const now = Date.now();
    await ctx.db.patch(contractorPaymentId, {
      status: "sent",
      sentAt: row!.sentAt ?? now,
      updatedAt: now,
    });
    if (row!.payeeEmail) {
      await ctx.scheduler.runAfter(
        0,
        internal.contractorPayments.sendAgreementInvite,
        { contractorPaymentId },
      );
    }
    return { token: row!.token };
  },
});

/**
 * Edit the terms of an agreement.
 *
 * THE RULE THIS FUNCTION EXISTS FOR: if an agreed term changes after the
 * contractor accepted, the acceptance is VOID. Amount, service description and
 * service date are what they signed; touching any of them bumps
 * `agreementTermsVersion`, clears `acceptedAt`/`acceptedTermsVersion`/
 * `acceptedSignature`, walks the row back to `sent`, and re-notifies them.
 *
 * The alternative — quietly editing the amount on a row that already carries
 * somebody's signature — produces a record that says a person agreed to terms
 * they never saw. That is the single worst thing this feature could do, so it
 * is not reachable through the mutation layer at all.
 *
 * Coding-only edits (budget/category/fund) do NOT bump the version: the
 * contractor never agreed to which budget line pays them, and re-asking for a
 * signature because a bookkeeper moved a category would train people to click
 * through acceptance without reading.
 */
export const updateTerms = mutation({
  args: {
    contractorPaymentId: v.id("contractorPayments"),
    payeeName: v.optional(v.string()),
    payeeEmail: v.optional(v.string()),
    serviceDescription: v.optional(v.string()),
    serviceDate: v.optional(v.number()),
    agreedAmountCents: v.optional(v.number()),
    agreementNotes: v.optional(v.string()),
    eventId: v.optional(v.id("events")),
    projectId: v.optional(v.id("projects")),
    budgetId: v.optional(v.id("budgets")),
    categoryId: v.optional(v.id("budgetCategories")),
    fundId: v.optional(v.id("funds")),
    // Explicitly clear the attribution rather than leaving it — an absent key
    // means "unchanged", so there has to be a way to say "none". The same
    // applies to every other optional field a human can empty out: without a
    // clear flag, a user who deletes the service date or the category watches
    // the form accept the change and the record keep the old value, which is
    // worse than refusing the edit.
    clearAttribution: v.optional(v.boolean()),
    clearServiceDate: v.optional(v.boolean()),
    clearCategory: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const {
      contractorPaymentId,
      clearAttribution,
      clearServiceDate,
      clearCategory,
      ...rest
    } = args;
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    const row = await ctx.db.get(contractorPaymentId);
    await requireInChapter(ctx, chapterId, row, "Contractor payment");
    await requireContractorPaymentsCompose(ctx, chapterId);
    assertTransition(row!.status, TERMS_EDITABLE_STATUSES, "edit");
    const callerPersonId = await resolveCallerPersonId(ctx, chapterId);

    const patch: Partial<Doc<"contractorPayments">> = {};
    // Which of the three AGREED terms actually changed — the set that voids an
    // acceptance. Compared by value, so a no-op save doesn't void anything.
    let termsChanged = false;

    if (rest.serviceDescription !== undefined) {
      const next = assertPublicDescription(rest.serviceDescription);
      if (next !== row!.serviceDescription) {
        patch.serviceDescription = next;
        termsChanged = true;
      }
    }
    if (rest.agreedAmountCents !== undefined) {
      assertAmount(rest.agreedAmountCents);
      if (rest.agreedAmountCents !== row!.agreedAmountCents) {
        patch.agreedAmountCents = rest.agreedAmountCents;
        termsChanged = true;
      }
    }
    if (clearServiceDate) {
      // Removing the date the work was done is as much a change to the agreed
      // terms as moving it, so it voids an acceptance the same way.
      if (row!.serviceDate !== undefined) {
        patch.serviceDate = undefined;
        termsChanged = true;
      }
    } else if (rest.serviceDate !== undefined) {
      const next = assertServiceDate(rest.serviceDate);
      if (next !== row!.serviceDate) {
        patch.serviceDate = next;
        termsChanged = true;
      }
    }

    // Non-agreed fields — editable without voiding anything.
    if (rest.payeeName !== undefined) {
      const name = cap(rest.payeeName, 200);
      if (name.length < 2) {
        throw new ConvexError({
          code: "INVALID_INPUT",
          message: "Who is being paid?",
        });
      }
      patch.payeeName = name;
    }
    if (rest.payeeEmail !== undefined) {
      patch.payeeEmail = normalizeEmail(rest.payeeEmail) ?? undefined;
    }
    if (rest.agreementNotes !== undefined) {
      patch.agreementNotes = capOptional(rest.agreementNotes, 4000);
    }

    // Coding. `clearAttribution` wipes all three; otherwise a provided id wins
    // and the other two are cleared, keeping the "at most one" invariant true
    // by construction rather than by validation.
    if (clearAttribution) {
      patch.eventId = undefined;
      patch.projectId = undefined;
      patch.budgetId = undefined;
    } else if (
      rest.eventId !== undefined ||
      rest.projectId !== undefined ||
      rest.budgetId !== undefined
    ) {
      assertSingleAttribution(rest);
      for (const [id, label] of [
        [rest.eventId, "Event"],
        [rest.projectId, "Project"],
        [rest.budgetId, "Budget"],
      ] as const) {
        if (!id) continue;
        const doc = await ctx.db.get(id as Id<"events">);
        await requireInChapter(ctx, chapterId, doc, label);
      }
      patch.eventId = rest.eventId;
      patch.projectId = rest.projectId;
      patch.budgetId = rest.budgetId;
    }
    if (clearCategory) {
      // Coding, not an agreed term — the contractor never agreed to which
      // category pays them, so this voids nothing.
      patch.categoryId = undefined;
    } else if (rest.categoryId !== undefined) {
      const doc = await ctx.db.get(rest.categoryId);
      await requireInChapter(ctx, chapterId, doc, "Category");
      patch.categoryId = rest.categoryId;
    }
    if (rest.fundId !== undefined) {
      const doc = await ctx.db.get(rest.fundId);
      await requireInChapter(ctx, chapterId, doc, "Fund");
      patch.fundId = rest.fundId;
    }

    const now = Date.now();
    // THE VOID. Only when a term actually moved AND somebody had accepted —
    // editing a draft nobody has seen is just editing.
    const voidsAcceptance = termsChanged && row!.acceptedAt != null;
    if (voidsAcceptance) {
      patch.agreementTermsVersion = row!.agreementTermsVersion + 1;
      patch.acceptedAt = undefined;
      patch.acceptedTermsVersion = undefined;
      patch.acceptedSignature = undefined;
      patch.acceptedIp = undefined;
      patch.status = "sent";
      patch.submittedAt = undefined;
    }

    await ctx.db.patch(contractorPaymentId, { ...patch, updatedAt: now });
    await recordApproval(
      ctx,
      chapterId,
      contractorPaymentId,
      "edit",
      callerPersonId,
      voidsAcceptance
        ? "Terms changed after acceptance — acceptance voided, contractor re-notified."
        : undefined,
    );
    if (voidsAcceptance && row!.payeeEmail) {
      await ctx.scheduler.runAfter(
        0,
        internal.contractorPayments.sendAgreementInvite,
        { contractorPaymentId },
      );
    }
    return { acceptanceVoided: voidsAcceptance };
  },
});

// ── IN-APP: the review queue ────────────────────────────────────────────────
/** The chapter's contractor payments, newest first. NEVER returns `token` — a
 *  list is the easiest place to leak a secret link, so the field is dropped
 *  here rather than trusted to every caller. */
export const list = query({
  args: {
    status: v.optional(
      v.union(...CONTRACTOR_PAYMENT_STATUSES.map((s) => v.literal(s))),
    ),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { status, limit }) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireContractorPaymentsView(ctx, chapterId);
    const take = Math.min(Math.max(limit ?? 100, 1), 200);

    const rows = status
      ? await ctx.db
          .query("contractorPayments")
          .withIndex("by_chapter_and_status", (q) =>
            q.eq("chapterId", chapterId).eq("status", status),
          )
          .order("desc")
          .take(take)
      : await ctx.db
          .query("contractorPayments")
          .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
          .order("desc")
          .take(take);

    const canCompose = await hasContractorPaymentsCompose(ctx, chapterId);
    const canApprove = await hasContractorPaymentsApprove(ctx, chapterId);

    return {
      canCompose,
      canApprove,
      payments: rows.map((r) => ({
        _id: r._id,
        reference: contractorReferenceFor(r._id),
        status: r.status,
        origin: r.origin,
        payeeName: r.payeeName,
        payeeBusinessName: r.payeeBusinessName,
        serviceDescription: r.serviceDescription,
        serviceDate: r.serviceDate,
        agreedAmountCents: r.agreedAmountCents,
        approvedCents: r.approvedCents,
        hasBankDestination: r.externalAccountId != null,
        bankAccountLast4: r.bankAccountLast4,
        acceptedAt: r.acceptedAt,
        submittedAt: r.submittedAt,
        approvedAt: r.approvedAt,
        paidAt: r.paidAt,
        createdAt: r.createdAt,
      })),
    };
  },
});

/**
 * One contractor payment in full, for the detail screen.
 *
 * Returns the tax document's METADATA (kind, filename, when it arrived) and
 * whether the caller may open it — but never the `storageId`. Opening is
 * `viewTaxDocument`, a separate, logged call. A detail query that carried the
 * id would put an SSN in the response of the screen everybody opens.
 *
 * `token` IS returned here, gated on compose rank: this is the screen with the
 * "copy link" button on it, which is the whole point of the feature.
 */
export const get = query({
  args: { contractorPaymentId: v.id("contractorPayments") },
  handler: async (ctx, { contractorPaymentId }) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    const row = await ctx.db.get(contractorPaymentId);
    await requireInChapter(ctx, chapterId, row, "Contractor payment");
    await requireContractorPaymentsView(ctx, chapterId);

    const canCompose = await hasContractorPaymentsCompose(ctx, chapterId);
    const canApprove = await hasContractorPaymentsApprove(ctx, chapterId);
    const canViewTaxDoc = await hasContractorTaxDocView(ctx, chapterId);

    const taxDoc = await ctx.db
      .query("contractorTaxDocuments")
      .withIndex("by_payment", (q) =>
        q.eq("contractorPaymentId", contractorPaymentId),
      )
      .order("desc")
      .first();

    const payout = row!.payoutId ? await ctx.db.get(row!.payoutId) : null;

    return {
      _id: row!._id,
      reference: contractorReferenceFor(row!._id),
      status: row!.status,
      origin: row!.origin,
      payeeName: row!.payeeName,
      payeeBusinessName: row!.payeeBusinessName,
      payeeEmail: row!.payeeEmail,
      payeePhone: row!.payeePhone,
      personId: row!.personId,
      serviceDescription: row!.serviceDescription,
      serviceDate: row!.serviceDate,
      agreedAmountCents: row!.agreedAmountCents,
      agreementNotes: row!.agreementNotes,
      agreementTermsVersion: row!.agreementTermsVersion,
      acceptedAt: row!.acceptedAt,
      acceptedTermsVersion: row!.acceptedTermsVersion,
      acceptedSignature: row!.acceptedSignature,
      eventId: row!.eventId,
      projectId: row!.projectId,
      budgetId: row!.budgetId,
      categoryId: row!.categoryId,
      fundId: row!.fundId,
      isCoded: isCoded(row!),
      reviewNote: row!.reviewNote,
      rejectedReason: row!.rejectedReason,
      approvedCents: row!.approvedCents,
      bankAccountLast4: row!.bankAccountLast4,
      hasBankDestination: row!.externalAccountId != null,
      submittedAt: row!.submittedAt,
      approvedAt: row!.approvedAt,
      paidAt: row!.paidAt,
      createdAt: row!.createdAt,
      // The secret link, only for someone who may send it.
      token: canCompose ? row!.token : undefined,
      canCompose,
      canApprove,
      canViewTaxDoc,
      // METADATA ONLY — never the storageId. See this function's doc.
      taxDocument: taxDoc
        ? {
            _id: taxDoc._id,
            kind: taxDoc.kind,
            fileName: taxDoc.fileName,
            uploadedAt: taxDoc.uploadedAt,
            taxYear: taxDoc.taxYear,
            isForeign: isForeignTaxDoc(taxDoc.kind),
          }
        : null,
      payout: payout
        ? {
            _id: payout._id,
            status: payout.status,
            provider: payout.provider,
            failureReason: payout.failureReason,
          }
        : null,
    };
  },
});

/**
 * Approve a contractor payment — the decision that makes an ACH legal.
 *
 * Three gates beyond rank, in the order a reviewer would hit them:
 *  1. SEPARATION OF DUTIES (`assertContractorApprovalSoD`) — including the
 *     authorship check that stops the person who wrote the terms approving
 *     them.
 *  2. CODED — a `self_serve` request arrives with whatever the requester
 *     claimed. Refusing here rather than letting it through uncoded is what
 *     keeps "who said this belongs to that budget?" answerable.
 *  3. NOT FOREIGN — a W-8 on file means the payee is not a US person, which can
 *     carry withholding obligations this system does not compute. Blocked
 *     explicitly with `FOREIGN_PAYEE_REVIEW` so it is handled off-platform
 *     rather than silently paid at 0% withholding.
 */
export const approve = mutation({
  args: {
    contractorPaymentId: v.id("contractorPayments"),
    approvedCents: v.optional(v.number()),
    note: v.optional(v.string()),
  },
  handler: async (ctx, { contractorPaymentId, approvedCents, note }) => {
    const { chapterId, row, callerPersonId, callerEmail } = await loadForManage(
      ctx,
      contractorPaymentId,
    );
    assertTransition(row.status, REVIEWABLE_STATUSES, "approve");
    assertContractorApprovalSoD(callerPersonId, callerEmail, row);

    if (!isCoded(row)) {
      throw new ConvexError({
        code: "NOT_CODED",
        message:
          "Say what this payment is for — pick an event, project, or budget — before approving it.",
      });
    }

    const taxDoc = row.taxDocumentId
      ? await ctx.db.get(row.taxDocumentId)
      : await ctx.db
          .query("contractorTaxDocuments")
          .withIndex("by_payment", (q) =>
            q.eq("contractorPaymentId", contractorPaymentId),
          )
          .order("desc")
          .first();
    // An EXPIRED form establishes nothing. A W-9 never expires, but a W-8 does,
    // and reuse makes a lapsed one reachable in a way it never was when every
    // payment collected its own — so the gate belongs here, not only at the
    // moment of collection.
    if (taxDoc) {
      const problem = taxDocReuseProblem(taxDoc);
      if (problem) {
        throw new ConvexError({
          code: "TAX_DOC_EXPIRED",
          message: `${problem} Ask them for a current form before approving.`,
        });
      }
    }
    if (taxDoc && isForeignTaxDoc(taxDoc.kind)) {
      throw new ConvexError({
        code: "FOREIGN_PAYEE_REVIEW",
        message:
          "This payee filed a W-8, so they're not a US person. Foreign payments can carry withholding — handle this one outside the app.",
      });
    }

    // Partial approval: approve less than was agreed, never more. Approving
    // MORE would be a new agreement the contractor never saw.
    const amount = approvedCents ?? row.agreedAmountCents;
    assertAmount(amount);
    if (amount > row.agreedAmountCents) {
      throw new ConvexError({
        code: "INVALID_INPUT",
        message:
          "You can't approve more than the agreed amount — change the terms instead, which re-asks the contractor to accept.",
      });
    }

    const now = Date.now();
    await ctx.db.patch(contractorPaymentId, {
      status: "approved",
      approvedCents: amount,
      reviewedByPersonId: callerPersonId,
      approvedAt: now,
      reviewNote: undefined,
      updatedAt: now,
    });
    await recordApproval(
      ctx,
      chapterId,
      contractorPaymentId,
      "approve",
      callerPersonId,
      note,
    );
    await ctx.scheduler.runAfter(
      0,
      internal.contractorPayments.sendApprovedNotice,
      { contractorPaymentId },
    );
    return null;
  },
});

/** Send it BACK for revision with a required note — the conversation, not the
 *  verdict. The contractor's link becomes editable again. */
export const requestChanges = mutation({
  args: {
    contractorPaymentId: v.id("contractorPayments"),
    note: v.string(),
  },
  handler: async (ctx, { contractorPaymentId, note }) => {
    const { chapterId, row, callerPersonId } = await loadForManage(
      ctx,
      contractorPaymentId,
    );
    assertTransition(row.status, REVIEWABLE_STATUSES, "send back");
    const trimmed = cap(note, 1000);
    if (trimmed.length < 3) {
      throw new ConvexError({
        code: "INVALID_INPUT",
        message: "Say what needs fixing — the contractor sees this note.",
      });
    }
    const now = Date.now();
    await ctx.db.patch(contractorPaymentId, {
      status: "changes_requested",
      reviewNote: trimmed,
      updatedAt: now,
    });
    await recordApproval(
      ctx,
      chapterId,
      contractorPaymentId,
      "edit",
      callerPersonId,
      trimmed,
    );
    if (row.payeeEmail) {
      await ctx.scheduler.runAfter(
        0,
        internal.contractorPayments.sendChangesRequestedNotice,
        { contractorPaymentId },
      );
    }
    return null;
  },
});

/** Terminal refusal, with a reason. */
export const reject = mutation({
  args: {
    contractorPaymentId: v.id("contractorPayments"),
    reason: v.string(),
  },
  handler: async (ctx, { contractorPaymentId, reason }) => {
    const { chapterId, row, callerPersonId, callerEmail } = await loadForManage(
      ctx,
      contractorPaymentId,
    );
    assertTransition(row.status, REVIEWABLE_STATUSES, "reject");
    assertContractorApprovalSoD(callerPersonId, callerEmail, row);
    const trimmed = cap(reason, 1000);
    if (trimmed.length < 3) {
      throw new ConvexError({
        code: "INVALID_INPUT",
        message: "Say why — this is a person waiting on money.",
      });
    }
    const now = Date.now();
    await ctx.db.patch(contractorPaymentId, {
      status: "rejected",
      rejectedReason: trimmed,
      reviewedByPersonId: callerPersonId,
      updatedAt: now,
    });
    await recordApproval(
      ctx,
      chapterId,
      contractorPaymentId,
      "reject",
      callerPersonId,
      trimmed,
    );
    return null;
  },
});

/** Withdraw a payment before money moves. */
export const cancel = mutation({
  args: {
    contractorPaymentId: v.id("contractorPayments"),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, { contractorPaymentId, reason }) => {
    const { chapterId, row, callerPersonId } = await loadForManage(
      ctx,
      contractorPaymentId,
    );
    assertTransition(row.status, CANCELABLE_STATUSES, "cancel");
    const now = Date.now();
    await ctx.db.patch(contractorPaymentId, {
      status: "canceled",
      updatedAt: now,
    });
    await recordApproval(
      ctx,
      chapterId,
      contractorPaymentId,
      "cancel",
      callerPersonId,
      capOptional(reason, 1000),
    );
    return null;
  },
});

// ── The tax document ────────────────────────────────────────────────────────
/**
 * Open a contractor's tax document — the ONE path to the file, gated and
 * logged.
 *
 * A MUTATION, not a query, and deliberately so: reading this file is an event
 * worth recording, and a query cannot write the audit row that makes the access
 * answerable later. The gate is a role rather than a named individual, so the
 * log is what stands between "the treasurer can see W-9s" and "nobody knows who
 * looked at whose SSN."
 *
 * Returns a short-lived signed URL from `ctx.storage.getUrl`.
 */
export const viewTaxDocument = mutation({
  args: { contractorPaymentId: v.id("contractorPayments") },
  handler: async (ctx, { contractorPaymentId }) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    const row = await ctx.db.get(contractorPaymentId);
    await requireInChapter(ctx, chapterId, row, "Contractor payment");
    await requireContractorTaxDocView(ctx, chapterId);
    const callerPersonId = await resolveCallerPersonId(ctx, chapterId);

    const taxDoc = await ctx.db
      .query("contractorTaxDocuments")
      .withIndex("by_payment", (q) =>
        q.eq("contractorPaymentId", contractorPaymentId),
      )
      .order("desc")
      .first();
    if (!taxDoc) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "No tax document has been filed for this payment.",
      });
    }

    // RATE-LIMITED, which the roster made necessary. When every tax document
    // was reachable only by opening its own payment, scraping the chapter's
    // forms meant hunting them down one at a time. A durable contractor list
    // turns that into a scroll and N taps — same permission, same log, wholly
    // different effort. The log says who looked; this bounds how many they can
    // look at before somebody notices.
    //
    // Modelled on `cardDetailsRevealAttempts`, the codebase's existing answer
    // to "a legitimate power that becomes dangerous in bulk", and keyed on the
    // CALLER rather than an IP: this endpoint is authenticated, so the person
    // is the thing worth limiting.
    await assertContractNotRateLimited(
      ctx,
      `taxdoc_view:${String(callerPersonId)}`,
      TAX_DOC_VIEW_MAX_PER_HOUR,
    );

    // EVERY VIEW IS LOGGED, before the URL is handed out.
    await ctx.db.insert("approvals", {
      chapterId,
      subjectType: "contractor_payment",
      subjectId: String(contractorPaymentId),
      action: "edit",
      actorPersonId: callerPersonId,
      note: `Viewed the ${taxDoc.kind.toUpperCase()} on file.`,
      createdAt: Date.now(),
    });

    const url = await ctx.storage.getUrl(taxDoc.storageId);
    if (!url) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "That document is no longer stored.",
      });
    }
    return { url, kind: taxDoc.kind, fileName: taxDoc.fileName };
  },
});

// ── INTERNAL: reads the emails and the payout rail need ─────────────────────
/** The row itself, for internal senders and the payout machine. */
export const getInternal = internalQuery({
  args: { contractorPaymentId: v.id("contractorPayments") },
  handler: async (ctx, { contractorPaymentId }) => {
    return await ctx.db.get(contractorPaymentId);
  },
});

/**
 * Claim the one-shot right to send the approved notice. Returns true only to
 * the FIRST caller — the exactly-once guard reimbursements use, copied
 * mechanism and all, so a retry or a backfill can never double-mail somebody.
 */
export const markApprovedNoticeSent = internalMutation({
  args: { contractorPaymentId: v.id("contractorPayments") },
  handler: async (ctx, { contractorPaymentId }) => {
    const row = await ctx.db.get(contractorPaymentId);
    if (!row || row.approvedNoticeSentAt != null) return false;
    await ctx.db.patch(contractorPaymentId, {
      approvedNoticeSentAt: Date.now(),
    });
    return true;
  },
});

/** The same claim for the paid notice. Cleared by a bounce walk-back, which is
 *  the only way one payment ever sends two — see the schema comment. */
export const markPaidNoticeSent = internalMutation({
  args: { contractorPaymentId: v.id("contractorPayments") },
  handler: async (ctx, { contractorPaymentId }) => {
    const row = await ctx.db.get(contractorPaymentId);
    if (!row || row.paidNoticeSentAt != null) return false;
    await ctx.db.patch(contractorPaymentId, { paidNoticeSentAt: Date.now() });
    return true;
  },
});

/**
 * Treasurers to email about a payment awaiting review, as addresses.
 *
 * Recipients are the chapter's finance managers unioned with central's
 * (`listChapterFinanceManagerPersonIds` already spans both scopes) — the
 * founder's "make sure we're emailing treasurers on what they need to do".
 * Placeholder rows and the submitter themselves are skipped: nobody needs a
 * task email telling them to review the thing they just filed.
 */
export const reviewerRecipients = internalQuery({
  args: { contractorPaymentId: v.id("contractorPayments") },
  handler: async (ctx, { contractorPaymentId }) => {
    const row = await ctx.db.get(contractorPaymentId);
    if (!row) return { emails: [], payment: null };
    const personIds = await listChapterFinanceManagerPersonIds(
      ctx,
      row.chapterId,
    );
    const emails: string[] = [];
    const seen = new Set<string>();
    for (const personId of personIds) {
      if (row.createdByPersonId && personId === row.createdByPersonId) continue;
      const person = await ctx.db.get(personId);
      if (!person || person.isPlaceholder === true) continue;
      const email = normalizeEmail(person.email);
      if (!email || seen.has(email)) continue;
      seen.add(email);
      emails.push(email);
    }
    return {
      emails,
      payment: {
        _id: row._id,
        reference: contractorReferenceFor(row._id),
        payeeName: row.payeeName,
        serviceDescription: row.serviceDescription,
        agreedAmountCents: row.agreedAmountCents,
        origin: row.origin,
        chapterId: row.chapterId,
      },
    };
  },
});

/** Payments still awaiting a decision, for the nudge/escalation sweep. */
export const pendingReview = internalQuery({
  args: { olderThanMs: v.number(), limit: v.optional(v.number()) },
  handler: async (ctx, { olderThanMs, limit }) => {
    const cutoff = Date.now() - olderThanMs;
    const rows: Doc<"contractorPayments">[] = [];
    const want = Math.min(limit ?? 200, 500);
    for (const status of CONTRACTOR_PAYMENT_REVIEW_STATUSES) {
      // Walk the index rather than `.take(n)` and filter afterwards. A fixed
      // window filled with rows that have ALREADY been nudged and escalated
      // starves the newer submissions behind them — the sweep would appear to
      // run every day while a growing tail of payments was never chased. The
      // iteration stops as soon as `want` ACTIONABLE rows are found, so the
      // cost is the same on the normal day when there are none.
      for await (const row of ctx.db
        .query("contractorPayments")
        .withIndex("by_status", (q) => q.eq("status", status))) {
        if ((row.submittedAt ?? row.createdAt) > cutoff) continue;
        // Nothing left to send for this row — don't let it hold a slot.
        if (row.reviewNudgeSentAt != null && row.reviewEscalatedAt != null) {
          continue;
        }
        rows.push(row);
        if (rows.length >= want) break;
      }
      if (rows.length >= want) break;
    }
    return rows.map((r) => ({
      _id: r._id,
      chapterId: r.chapterId,
      submittedAt: r.submittedAt ?? r.createdAt,
      reviewNudgeSentAt: r.reviewNudgeSentAt,
      reviewEscalatedAt: r.reviewEscalatedAt,
    }));
  },
});

/** Stamp a nudge/escalation so the daily sweep nags on a schedule rather than
 *  every single run. */
export const markReviewNudged = internalMutation({
  args: {
    contractorPaymentId: v.id("contractorPayments"),
    escalated: v.optional(v.boolean()),
  },
  handler: async (ctx, { contractorPaymentId, escalated }) => {
    const now = Date.now();
    await ctx.db.patch(contractorPaymentId, {
      ...(escalated ? { reviewEscalatedAt: now } : { reviewNudgeSentAt: now }),
      updatedAt: now,
    });
    return null;
  },
});

// ── PUBLIC: the contractor's own page (no auth, secret token) ───────────────
/**
 * Rate limits for the unauthenticated endpoints, on the SAME
 * `reimbursementSubmitAttempts` table and `by_key_and_time` mechanism the
 * reimburse page uses — one rate-limit store, already swept daily by
 * `maintenance.sweepRateLimitAttempts`, rather than a second table that would
 * need its own sweep and its own bug.
 *
 * Keys are prefixed per endpoint (`contract_submit_ip:`, `contract_upload_ip:`,
 * `contract_bank_ip:`) so uploading a W-9 can't burn the submit budget, and so
 * the most expensive call — a real Increase API round-trip — gets its own cap
 * rather than sharing one. Same reasoning as the reimburse limiters; see their
 * docs for the full argument.
 */
const CONTRACT_RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const CONTRACT_SUBMIT_MAX = 10;
const CONTRACT_UPLOAD_MAX = 20;
const CONTRACT_BANK_MAX = 20;
/** How many tax documents one person may open in an hour. Generous for the
 *  real job — a treasurer reconciling a month opens a handful — and far below
 *  what emptying the roster into a folder would take. */
const TAX_DOC_VIEW_MAX_PER_HOUR = 15;

async function assertContractNotRateLimited(
  ctx: MutationCtx,
  key: string,
  max: number,
): Promise<void> {
  const windowStart = Date.now() - CONTRACT_RATE_WINDOW_MS;
  const recent = await ctx.db
    .query("reimbursementSubmitAttempts")
    .withIndex("by_key_and_time", (q) =>
      q.eq("key", key).gte("createdAt", windowStart),
    )
    .take(max);
  if (recent.length >= max) {
    throw new ConvexError({
      code: "RATE_LIMITED",
      message: "Too many attempts recently. Please try again in a bit.",
    });
  }
  await ctx.db.insert("reimbursementSubmitAttempts", {
    key,
    createdAt: Date.now(),
  });
}

/**
 * The chapter behind a public /contract link, plus the coding vocabulary the
 * blank request form offers.
 *
 * THE ROSTER STAYS OFF THIS PAGE, exactly as it does on the reimburse page:
 * category names are already public via the ledger, but naming real people by
 * id to an unauthenticated stranger is a different kind of disclosure.
 */
export const chapterForContract = query({
  args: { chapterSlug: v.string() },
  handler: async (ctx, { chapterSlug }) => {
    const chapter = await ctx.db
      .query("chapters")
      .withIndex("by_slug", (q) => q.eq("slug", chapterSlug))
      .unique();
    if (!chapter) return null;
    return {
      chapterId: chapter._id,
      name: chapter.name,
      slug: chapter.slug,
    };
  },
});

/**
 * What the contractor sees when they open their link.
 *
 * Returns the AGREED TERMS (so they can read what they are accepting) and the
 * current status — and nothing else. No token echo, no internal notes, no
 * reviewer identity, no tax-document storage id, no bank details beyond the
 * last four they themselves typed. A public query is the easiest place in the
 * codebase to leak something, so the projection here is explicit and
 * allow-list shaped rather than a spread of the row.
 *
 * Returns `null` for an unknown token — never a distinguishable "wrong token"
 * versus "canceled payment" signal.
 */
export const publicByToken = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const row = await paymentByToken(ctx, token);
    if (!row) return null;
    const chapter = await ctx.db.get(row.chapterId);
    const taxDoc = row.taxDocumentId
      ? await ctx.db.get(row.taxDocumentId)
      : await ctx.db
          .query("contractorTaxDocuments")
          .withIndex("by_payment", (q) => q.eq("contractorPaymentId", row._id))
          .order("desc")
          .first();

    // What this PERSON already has with us, independent of this payment. Only
    // resolved when the payment is linked to a roster person — a payee we have
    // never paid before has nothing on file by definition.
    const profile = row.personId
      ? await profileFor(ctx, row.chapterId, row.personId)
      : null;
    const priorDoc = row.personId
      ? await latestTaxDocFor(ctx, row.chapterId, row.personId)
      : null;
    const onFile =
      profile || priorDoc
        ? {
            doc: priorDoc,
            bankAccountLast4: profile?.externalAccountId
              ? profile.bankAccountLast4
              : undefined,
            lastPaidAt: profile?.lastPaidAt,
          }
        : null;

    return {
      reference: contractorReferenceFor(row._id),
      chapterName: chapter?.name ?? "",
      status: row.status,
      statusLabel: CONTRACTOR_PAYMENT_STATUS_LABELS[row.status],
      canEdit: contractorCanEdit(row.status),
      origin: row.origin,
      payeeName: row.payeeName,
      payeeEmail: row.payeeEmail,
      payeeBusinessName: row.payeeBusinessName,
      serviceDescription: row.serviceDescription,
      serviceDate: row.serviceDate,
      agreedAmountCents: row.agreedAmountCents,
      // What was ACTUALLY approved, when it differs from what was agreed.
      // Partial approval is legal (approve for less, never more), and without
      // this the status page could only quote the agreed figure — telling a
      // contractor whose $1,200 was approved at $600 that "$1,200.00 was sent
      // to your bank". Null until somebody decides.
      approvedCents: row.approvedCents,
      agreementNotes: row.agreementNotes,
      agreementTermsVersion: row.agreementTermsVersion,
      acceptedAt: row.acceptedAt,
      // True only when the acceptance matches the CURRENT terms. A terms bump
      // makes this false again, which is what re-asks them to sign.
      acceptedCurrentTerms:
        row.acceptedAt != null &&
        row.acceptedTermsVersion === row.agreementTermsVersion,
      reviewNote: row.reviewNote,
      rejectedReason: row.rejectedReason,
      hasBankDestination: row.externalAccountId != null,
      bankAccountLast4: row.bankAccountLast4,
      hasTaxDocument: taxDoc != null,
      taxDocumentKind: taxDoc?.kind,
      // ── What we already hold for this person, so the page can offer
      // "welcome back" instead of the whole form again. METADATA ONLY: a kind,
      // a date, a last-four. Never a storage id, never an account reference.
      // A stranger with a guessed token learns nothing they could use.
      onFile: onFile
        ? {
            taxDocKind: onFile.doc?.kind ?? null,
            taxDocCollectedAt: onFile.doc?.uploadedAt ?? null,
            taxDocIsCurrent: onFile.doc ? taxDocIsCurrent(onFile.doc) : false,
            taxDocProblem: onFile.doc ? taxDocReuseProblem(onFile.doc) : null,
            bankAccountLast4: onFile.bankAccountLast4 ?? null,
            lastPaidAt: onFile.lastPaidAt ?? null,
          }
        : null,
      paidAt: row.paidAt,
    };
  },
});

/**
 * An upload URL for the contractor's tax document.
 *
 * PUBLIC AND UNAUTHENTICATED — the contractor has no account, which is the
 * whole premise. Scoped to a real token (so it is not an open upload endpoint
 * for the internet) and rate-limited by IP.
 *
 * Note what this does NOT do: it hands back a URL, and the browser PUTs the
 * file straight to Convex storage. The resulting `storageId` only becomes a
 * tax document when `completeAgreement` accepts it, which is where the
 * content-type and size are checked. An upload that never gets submitted is an
 * orphan blob, which the storage sweep handles — the same shape the reimburse
 * page's pre-submit upload already has.
 */
export const publicTaxDocUploadUrl = mutation({
  args: { token: v.string(), clientIp: v.optional(v.string()) },
  handler: async (ctx, { token, clientIp }) => {
    const row = await paymentByToken(ctx, token);
    if (!row || !contractorCanEdit(row.status)) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "This link isn't open for changes.",
      });
    }
    if (clientIp) {
      await assertContractNotRateLimited(
        ctx,
        `contract_upload_ip:${cap(clientIp, 100)}`,
        CONTRACT_UPLOAD_MAX,
      );
    }
    return await ctx.storage.generateUploadUrl();
  },
});

/** What a tax document may be. A W-9 is a PDF or a photo of one; anything else
 *  is either a mistake or someone probing the upload endpoint. Checked at
 *  ATTACH time (not upload) because that is the first moment the server has the
 *  file's real metadata rather than the browser's claim about it. */
const TAX_DOC_CONTENT_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/heic",
  "image/heif",
];
const TAX_DOC_MAX_BYTES = 20 * 1024 * 1024;

/**
 * Attach an uploaded file as this payment's tax document.
 *
 * Validates against the `_storage` system table — the file's REAL content type
 * and size, not what the form claimed. The reimburse upload path validates
 * neither, which is a known gap there; this one does, because the failure mode
 * is different: a tax document is a thing we promise to hold securely and then
 * destroy on a schedule, so accepting an arbitrary blob into that promise is
 * worse than accepting a junk receipt.
 *
 * Supersedes any previous document for the same payment (a contractor who
 * uploads the wrong year should be able to just upload the right one), and the
 * superseded file is deleted rather than left behind.
 */
async function attachTaxDocument(
  ctx: MutationCtx,
  row: Doc<"contractorPayments">,
  storageId: Id<"_storage">,
  kind: ContractorTaxDocKind,
  fileName?: string,
  signedAt?: number,
): Promise<void> {
  const meta = await ctx.db.system.get(storageId);
  if (!meta) {
    throw new ConvexError({
      code: "INVALID_INPUT",
      message: "That upload didn't finish — please try attaching the file again.",
    });
  }
  if (meta.contentType && !TAX_DOC_CONTENT_TYPES.includes(meta.contentType)) {
    await ctx.storage.delete(storageId);
    throw new ConvexError({
      code: "INVALID_INPUT",
      message: "Upload the form as a PDF or a photo.",
    });
  }
  if (meta.size > TAX_DOC_MAX_BYTES) {
    await ctx.storage.delete(storageId);
    throw new ConvexError({
      code: "INVALID_INPUT",
      message: "That file is too large — keep it under 20MB.",
    });
  }

  // Supersede the previous one, file and all.
  const previous = await ctx.db
    .query("contractorTaxDocuments")
    .withIndex("by_payment", (q) => q.eq("contractorPaymentId", row._id))
    .take(10);
  for (const old of previous) {
    try {
      await ctx.storage.delete(old.storageId);
    } catch {
      // Already gone — still drop the row.
    }
    await ctx.db.delete(old._id);
  }

  // The tax year is the SERVICE year, not today: a W-9 collected in January for
  // work done in December substantiates the prior year, and the retention clock
  // has to run from the year the money is reportable in.
  const taxYear = new Date(row.serviceDate ?? Date.now()).getUTCFullYear();
  const now = Date.now();
  const docId = await ctx.db.insert("contractorTaxDocuments", {
    chapterId: row.chapterId,
    contractorPaymentId: row._id,
    ...(row.personId ? { personId: row.personId } : {}),
    payeeName: row.payeeName,
    kind,
    ...(signedAt != null ? { signedAt } : {}),
    storageId,
    ...(fileName ? { fileName: cap(fileName, 200) } : {}),
    ...(meta.contentType ? { contentType: meta.contentType } : {}),
    sizeBytes: meta.size,
    taxYear,
    // A freshly collected document has substantiated nothing yet — no payment
    // using it has paid out. It gets the SHORT unpaid window until one does
    // (`contractorProfiles.rememberPaidContractor` hands it over to the
    // four-year rule). A form collected for a job that fell through is the one
    // we have least right to keep.
    purgeAfter: unpaidTaxDocPurgeAfter(now),
    lastUsedAt: now,
    uploadedAt: now,
  });
  // CITE IT from the payment. Before reuse a payment's document was found by
  // scanning `by_payment`; a reused document belongs to an earlier payment, so
  // the citation has to be explicit on the row that relies on it.
  await ctx.db.patch(row._id, { taxDocumentId: docId, updatedAt: now });
}

/**
 * Cite a tax document ALREADY on file for this payment, instead of collecting a
 * new one.
 *
 * The mechanism behind not re-asking. Three things happen, and each of them is
 * load-bearing:
 *
 *  1. The payment cites the document, so "is there a form on file?" stays
 *     answerable from the payment row.
 *  2. The document's `lastTaxYear` advances to THIS payment's service year, and
 *     `purgeAfter` is extended monotonically from it. Without this the sweep
 *     would destroy the document four years after the FIRST payment that used
 *     it, taking the substantiation for every later payment with it — silently,
 *     years later, with nothing to notice at the time.
 *  3. The reuse is recorded (`reusedFromProfile`), so the audit trail can say
 *     whether this person actually filled anything in for this job.
 *
 * Refuses an expired form. A W-9 never expires, but a W-8 does, and reusing a
 * lapsed one would mean paying a foreign contractor against a document that no
 * longer establishes anything.
 */
async function citeExistingTaxDocument(
  ctx: MutationCtx,
  row: Doc<"contractorPayments">,
  doc: Doc<"contractorTaxDocuments">,
): Promise<void> {
  const problem = taxDocReuseProblem(doc);
  if (problem) {
    throw new ConvexError({ code: "TAX_DOC_EXPIRED", message: problem });
  }
  const now = Date.now();
  const taxYear = new Date(row.serviceDate ?? now).getUTCFullYear();
  await ctx.db.patch(doc._id, {
    lastTaxYear: Math.max(doc.lastTaxYear ?? doc.taxYear, taxYear),
    purgeAfter: extendedTaxDocPurgeAfter(doc.purgeAfter, taxYear),
    lastUsedAt: now,
  });
  await ctx.db.patch(row._id, {
    taxDocumentId: doc._id,
    reusedFromProfile: true,
    updatedAt: now,
  });
}

/**
 * The contractor completes their half of a PRE-FILLED agreement: accept the
 * terms, say who they are, attach the tax form, and confirm where the money
 * goes.
 *
 * THE TERMS ARE NOT ARGUMENTS HERE. Amount, description and service date are
 * absent from this mutation's signature entirely — not accepted-and-ignored,
 * but unrepresentable. The contractor cannot change what they are agreeing to
 * by editing a form field, and a reviewer reading the row knows the terms are
 * the org's own testimony.
 *
 * `acceptedTermsVersion` is recorded against the version the row currently
 * carries, which is what makes a later terms edit detectable as "this
 * signature is stale" rather than silently inherited.
 */
export const completeAgreement = mutation({
  args: {
    token: v.string(),
    payeeName: v.string(),
    payeeEmail: v.string(),
    payeePhone: v.optional(v.string()),
    payeeBusinessName: v.optional(v.string()),
    // ── Either a NEW form, or a confirmation that the one on file still
    // stands. Exactly one of these two shapes; `reuseTaxDoc` is what a
    // returning contractor sends.
    taxDocStorageId: v.optional(v.id("_storage")),
    taxDocKind: v.optional(
      v.union(...CONTRACTOR_TAX_DOC_KINDS.map((k) => v.literal(k))),
    ),
    taxDocFileName: v.optional(v.string()),
    // When they signed it. Required for the W-8 kinds, which expire; a W-9
    // never does, so it is meaningless there.
    taxDocSignedAt: v.optional(v.number()),
    // "The form you have is still accurate." A W-9 stops being valid when the
    // FACTS change and only the payee knows that, so we ask rather than expire
    // it on a timer — and the asking is this flag, which the server requires
    // rather than infers.
    reuseTaxDoc: v.optional(v.boolean()),
    // Set by the orchestrating httpAction AFTER it linked the account with
    // Increase — never raw digits, which do not appear anywhere in this file.
    // OPTIONAL now: a returning contractor who confirms the account on file
    // sends `reuseBankDetails` instead, and no bank call is made at all.
    externalAccountId: v.optional(v.string()),
    bankAccountLast4: v.optional(v.string()),
    // "Yes, still the account ending 6789." Required to reuse — never inferred
    // from the absence of new details, because a blank bank section and an
    // affirmative "that account is still mine" are not the same statement, and
    // only one of them is a person taking responsibility for where their money
    // goes.
    reuseBankDetails: v.optional(v.boolean()),
    // The typed-name signature and the accepted-terms acknowledgement.
    signature: v.string(),
    clientIp: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const row = await paymentByToken(ctx, args.token);
    if (!row || !contractorCanEdit(row.status)) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "This link isn't open for changes.",
      });
    }
    if (args.clientIp) {
      await assertContractNotRateLimited(
        ctx,
        `contract_submit_ip:${cap(args.clientIp, 100)}`,
        CONTRACT_SUBMIT_MAX,
      );
    }
    const email = normalizeEmail(args.payeeEmail);
    if (!email) {
      throw new ConvexError({
        code: "INVALID_INPUT",
        message: "We need an email address to send your confirmation to.",
      });
    }
    const signature = cap(args.signature, 200);
    if (signature.length < 2) {
      throw new ConvexError({
        code: "INVALID_INPUT",
        message: "Type your name to accept the agreement.",
      });
    }

    // WHAT IS ON FILE, if anything. Resolved server-side rather than trusted
    // from the request: the page says what it believes, the server decides.
    const onFile = row.personId
      ? await latestTaxDocFor(ctx, row.chapterId, row.personId)
      : null;
    const profile = row.personId
      ? await profileFor(ctx, row.chapterId, row.personId)
      : null;

    if (args.reuseTaxDoc) {
      if (!onFile) {
        throw new ConvexError({
          code: "NO_TAX_DOC_ON_FILE",
          message:
            "We don't have a tax form on file for you — please upload one.",
        });
      }
      await citeExistingTaxDocument(ctx, row, onFile);
    } else {
      if (!args.taxDocStorageId || !args.taxDocKind) {
        throw new ConvexError({
          code: "INVALID_INPUT",
          message: "Attach your tax form.",
        });
      }
      await attachTaxDocument(
        ctx,
        row,
        args.taxDocStorageId,
        args.taxDocKind,
        args.taxDocFileName,
        args.taxDocSignedAt,
      );
    }

    // THE BANK. Reuse requires an explicit confirmation and a real account on
    // file; anything else needs freshly linked details.
    let externalAccountId: string;
    let bankAccountLast4: string;
    if (args.reuseBankDetails) {
      if (!profile?.externalAccountId) {
        throw new ConvexError({
          code: "NO_BANK_ON_FILE",
          message:
            "We don't have bank details on file for you — please enter them.",
        });
      }
      externalAccountId = profile.externalAccountId;
      bankAccountLast4 = profile.bankAccountLast4 ?? "";
    } else {
      if (!args.externalAccountId || !args.bankAccountLast4) {
        throw new ConvexError({
          code: "INVALID_INPUT",
          message: "Tell us where the money should go.",
        });
      }
      externalAccountId = args.externalAccountId;
      bankAccountLast4 = args.bankAccountLast4;
    }

    const now = Date.now();
    await ctx.db.patch(row._id, {
      status: "submitted",
      payeeName: cap(args.payeeName, 200) || row.payeeName,
      payeeEmail: email,
      ...(capOptional(args.payeePhone, 40)
        ? { payeePhone: capOptional(args.payeePhone, 40) }
        : {}),
      ...(capOptional(args.payeeBusinessName, 200)
        ? { payeeBusinessName: capOptional(args.payeeBusinessName, 200) }
        : {}),
      externalAccountId,
      bankAccountLast4: cap(bankAccountLast4, 4),
      acceptedAt: now,
      acceptedTermsVersion: row.agreementTermsVersion,
      acceptedSignature: signature,
      ...(args.clientIp ? { acceptedIp: cap(args.clientIp, 100) } : {}),
      submittedAt: now,
      // A resubmission after a send-back clears the note it is answering.
      reviewNote: undefined,
      // AND the nudge stamps. They mark "we have already chased the treasurer
      // about this submission"; a resubmission is a NEW submission, waiting
      // from now. Leaving them set meant the day-3 nudge and day-7 escalation
      // fired at most once in a payment's life, so any payment that went round
      // the send-back loop was never chased again — the exact payment most
      // likely to need chasing.
      reviewNudgeSentAt: undefined,
      reviewEscalatedAt: undefined,
      updatedAt: now,
    });

    await ctx.scheduler.runAfter(
      0,
      internal.contractorPayments.sendSubmittedNotices,
      { contractorPaymentId: row._id },
    );
    return { reference: contractorReferenceFor(row._id) };
  },
});

/**
 * A BLANK request: somebody asking to be paid, with nothing pre-approved.
 *
 * The founder's second mode — "a blank one that's not approved yet but goes
 * into a flow where we ask the treasurer." It lands `submitted` and UNCODED,
 * and `approve` refuses to release money until a human has said which budget
 * it belongs to. The requester's own claim about what it is for is a starting
 * point for that conversation, not evidence, so it goes in `agreementNotes`
 * rather than into the coding fields.
 */
export const submitPublicRequest = mutation({
  args: {
    chapterSlug: v.string(),
    payeeName: v.string(),
    payeeEmail: v.string(),
    payeePhone: v.optional(v.string()),
    payeeBusinessName: v.optional(v.string()),
    serviceDescription: v.string(),
    serviceDate: v.optional(v.number()),
    requestedAmountCents: v.number(),
    agreementNotes: v.optional(v.string()),
    taxDocStorageId: v.id("_storage"),
    taxDocKind: v.union(...CONTRACTOR_TAX_DOC_KINDS.map((k) => v.literal(k))),
    taxDocFileName: v.optional(v.string()),
    // When they signed it — required for the W-8 kinds, which expire, and
    // meaningless for a W-9, which doesn't. Present here for the same reason it
    // is on `completeAgreement`: without it a W-8 arriving through the blank
    // request form is stored undated, `taxDocIsCurrent` reads an undated W-8 as
    // expired, and the contractor is asked for a fresh form on their next
    // payment despite having given us a perfectly current one.
    taxDocSignedAt: v.optional(v.number()),
    externalAccountId: v.string(),
    bankAccountLast4: v.string(),
    signature: v.string(),
    clientIp: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const chapter = await ctx.db
      .query("chapters")
      .withIndex("by_slug", (q) => q.eq("slug", args.chapterSlug))
      .unique();
    if (!chapter) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "We couldn't find that chapter.",
      });
    }
    const email = normalizeEmail(args.payeeEmail);
    if (!email) {
      throw new ConvexError({
        code: "INVALID_INPUT",
        message: "We need an email address to send your confirmation to.",
      });
    }
    if (args.clientIp) {
      await assertContractNotRateLimited(
        ctx,
        `contract_submit_ip:${cap(args.clientIp, 100)}`,
        CONTRACT_SUBMIT_MAX,
      );
    }
    await assertContractNotRateLimited(
      ctx,
      `contract_submit_email:${email}`,
      CONTRACT_SUBMIT_MAX,
    );
    const signature = cap(args.signature, 200);
    if (signature.length < 2) {
      throw new ConvexError({
        code: "INVALID_INPUT",
        message: "Type your name to confirm this request.",
      });
    }

    // Best-effort roster link by email — the same "match if we can, carry on if
    // not" posture the public reimburse path takes. It is a convenience for the
    // reviewer, never an identity claim.
    const personMatch = await ctx.db
      .query("people")
      .withIndex("by_email", (q) => q.eq("email", email))
      .first();
    const personId =
      personMatch && personMatch.chapterId === chapter._id
        ? personMatch._id
        : undefined;

    const { id } = await createContractorPayment(ctx, {
      chapterId: chapter._id,
      origin: "self_serve",
      status: "submitted",
      payeeName: args.payeeName,
      payeeEmail: email,
      payeePhone: args.payeePhone,
      payeeBusinessName: args.payeeBusinessName,
      ...(personId ? { personId } : {}),
      serviceDescription: args.serviceDescription,
      serviceDate: args.serviceDate,
      agreedAmountCents: args.requestedAmountCents,
      agreementNotes: args.agreementNotes,
    });

    const row = (await ctx.db.get(id))!;
    await attachTaxDocument(
      ctx,
      row,
      args.taxDocStorageId,
      args.taxDocKind,
      args.taxDocFileName,
      args.taxDocSignedAt,
    );
    const now = Date.now();
    await ctx.db.patch(id, {
      externalAccountId: args.externalAccountId,
      bankAccountLast4: cap(args.bankAccountLast4, 4),
      acceptedAt: now,
      acceptedTermsVersion: 1,
      acceptedSignature: signature,
      ...(args.clientIp ? { acceptedIp: cap(args.clientIp, 100) } : {}),
      updatedAt: now,
    });

    await ctx.scheduler.runAfter(
      0,
      internal.contractorPayments.sendSubmittedNotices,
      { contractorPaymentId: id },
    );
    return { reference: contractorReferenceFor(id), token: row.token };
  },
});

/** An upload URL for the BLANK public request form, which has no token yet.
 *  Scoped to a real chapter slug and rate-limited by IP — the same bargain the
 *  reimburse page's `preSubmitUploadUrl` strikes. */
export const publicRequestUploadUrl = mutation({
  args: { chapterSlug: v.string(), clientIp: v.optional(v.string()) },
  handler: async (ctx, { chapterSlug, clientIp }) => {
    const chapter = await ctx.db
      .query("chapters")
      .withIndex("by_slug", (q) => q.eq("slug", chapterSlug))
      .unique();
    if (!chapter) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "We couldn't find that chapter.",
      });
    }
    if (clientIp) {
      await assertContractNotRateLimited(
        ctx,
        `contract_upload_ip:${cap(clientIp, 100)}`,
        CONTRACT_UPLOAD_MAX,
      );
    }
    return await ctx.storage.generateUploadUrl();
  },
});

/** Rate-limit gate for the bank-link action, which cannot query the DB itself.
 *  Split out for the same reason `assertBankLinkNotRateLimited` is in
 *  `reimbursements.ts`: an action has no `ctx.db`. */
export const assertBankLinkNotRateLimited = internalMutation({
  args: { clientIp: v.optional(v.string()) },
  handler: async (ctx, { clientIp }) => {
    if (!clientIp) return null;
    await assertContractNotRateLimited(
      ctx,
      `contract_bank_ip:${cap(clientIp, 100)}`,
      CONTRACT_BANK_MAX,
    );
    return null;
  },
});

/**
 * Turn the contractor's routing + account digits into an Increase External
 * Account, and hand back only the reference id and the last four.
 *
 * THE DIGITS STOP HERE. They are validated, passed to Increase once, and never
 * written to Convex — `increaseExternalAccounts.createExternalAccount` even
 * suppresses the response body in its logs because Increase echoes them back.
 * Every downstream caller in this file takes `externalAccountId` +
 * `bankAccountLast4` and has no way to ask for more.
 *
 * Validation runs BEFORE the rate-limit check and before any network call, so a
 * malformed number fails fast without spending either budget.
 */
export const linkPublicBankAccount = action({
  args: {
    routingNumber: v.string(),
    accountNumber: v.string(),
    accountHolderName: v.optional(v.string()),
    funding: v.optional(
      v.union(...EXTERNAL_ACCOUNT_FUNDINGS.map((f) => v.literal(f))),
    ),
    clientIp: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ linked: boolean; externalAccountId?: string; last4?: string }> => {
    const routingNumber = assertRoutingNumber(args.routingNumber);
    const accountNumber = assertAccountNumber(args.accountNumber);
    await ctx.runMutation(
      internal.contractorPayments.assertBankLinkNotRateLimited,
      { clientIp: args.clientIp },
    );
    const created = await ctx.runAction(
      internal.increaseExternalAccounts.createExternalAccount,
      {
        routingNumber,
        accountNumber,
        accountHolderName: (
          args.accountHolderName?.trim() || "Contractor"
        ).slice(0, 200),
        funding: (args.funding ?? "checking") as ExternalAccountFunding,
      },
    );
    // `createExternalAccount` returns null rather than throwing when Increase
    // isn't configured or refuses. Converting that to an explicit failure here
    // is deliberate: a silent null would produce a contractor payment with no
    // destination, which looks complete on the queue and can never be paid.
    if (!created) return { linked: false };
    return {
      linked: true,
      externalAccountId: created.externalAccountId,
      last4: created.last4,
    };
  },
});

// ── INTERNAL: the notices ───────────────────────────────────────────────────
/**
 * The contractor's own link. Built from `siteUrl()` and the same
 * `/contract/<slug>?token=` shape the HTTP route serves, so there is one answer
 * to "what is this person's URL" rather than one per email.
 */
export function contractUrl(chapterSlug: string, token: string): string {
  const base = siteUrl();
  // Both halves are required. A missing slug would build `/contract/?token=…`,
  // which the route 404s — `send` refuses that case up front, and this is the
  // belt to its braces: every caller already treats `""` as "don't send", so a
  // dead link never reaches an inbox.
  if (!base || !chapterSlug) return "";
  return `${base}/contract/${encodeURIComponent(chapterSlug)}?token=${encodeURIComponent(token)}`;
}

/** Everything a notice needs, projected in ONE query so a sender never makes
 *  four round-trips and never sees more of the row than it needs. */
export const noticePayload = internalQuery({
  args: { contractorPaymentId: v.id("contractorPayments") },
  handler: async (ctx, { contractorPaymentId }) => {
    const row = await ctx.db.get(contractorPaymentId);
    if (!row) return null;
    const chapter = await ctx.db.get(row.chapterId);
    return {
      reference: contractorReferenceFor(row._id),
      chapterName: chapter?.name ?? "",
      chapterSlug: chapter?.slug ?? "",
      token: row.token,
      status: row.status,
      origin: row.origin,
      payeeName: row.payeeName,
      payeeEmail: row.payeeEmail,
      serviceDescription: row.serviceDescription,
      serviceDate: row.serviceDate,
      agreedAmountCents: row.agreedAmountCents,
      approvedCents: row.approvedCents,
      bankAccountLast4: row.bankAccountLast4,
      reviewNote: row.reviewNote,
      paidAt: row.paidAt,
      agreementTermsVersion: row.agreementTermsVersion,
    };
  },
});

/**
 * Every notice below follows the established contract for transactional mail in
 * this codebase: scheduled from the mutation that caused it (a mutation must
 * not do network I/O), wrapped in a try/catch so a Resend hiccup can never fail
 * a state change that already committed, and a no-op when there is no address.
 */
export const sendAgreementInvite = internalAction({
  args: { contractorPaymentId: v.id("contractorPayments") },
  handler: async (ctx, { contractorPaymentId }) => {
    try {
      const p = await ctx.runQuery(internal.contractorPayments.noticePayload, {
        contractorPaymentId,
      });
      if (!p?.payeeEmail) return null;
      const url = contractUrl(p.chapterSlug, p.token);
      if (!url) return null;
      const { subject, html } = buildAgreementInvite({
        payeeName: p.payeeName,
        chapterName: p.chapterName,
        serviceDescription: p.serviceDescription,
        serviceDate: p.serviceDate,
        amountCents: p.agreedAmountCents,
        url,
        // A version past the first means these are re-issued terms, not a
        // first invitation — the email says so rather than looking like a
        // duplicate of one they already actioned.
        isResend: p.agreementTermsVersion > 1,
      });
      await sendEmail(ctx, { to: p.payeeEmail, subject, html: emailShell(html) });
    } catch (err) {
      console.error("[contractorPayments] agreement invite failed", err);
    }
    return null;
  },
});

/**
 * On submission: the payee's receipt (with the public-ledger disclosure) AND
 * the treasurers' task email. One action so the two can't drift apart — a
 * submission that told the contractor "it's with the treasurer" while telling
 * no treasurer is the failure this feature would be blamed for.
 */
export const sendSubmittedNotices = internalAction({
  args: { contractorPaymentId: v.id("contractorPayments") },
  handler: async (ctx, { contractorPaymentId }) => {
    try {
      const p = await ctx.runQuery(internal.contractorPayments.noticePayload, {
        contractorPaymentId,
      });
      if (!p) return null;
      if (p.payeeEmail) {
        const { subject, html } = buildSubmittedReceipt({
          payeeName: p.payeeName,
          chapterName: p.chapterName,
          reference: p.reference,
          serviceDescription: p.serviceDescription,
          serviceDate: p.serviceDate,
          amountCents: p.agreedAmountCents,
          bankAccountLast4: p.bankAccountLast4,
          origin: p.origin,
        });
        await sendEmail(ctx, {
          to: p.payeeEmail,
          subject,
          html: emailShell(html),
        });
      }
      await ctx.runAction(internal.contractorPayments.sendReviewTasks, {
        contractorPaymentId,
        escalated: false,
      });
    } catch (err) {
      console.error("[contractorPayments] submitted notices failed", err);
    }
    return null;
  },
});

/** The treasurer task email — the founder's "email treasurers on what they need
 *  to do". Per-recipient try/catch so one bad address doesn't cost the rest
 *  their notice. */
export const sendReviewTasks = internalAction({
  args: {
    contractorPaymentId: v.id("contractorPayments"),
    escalated: v.boolean(),
    waitingDays: v.optional(v.number()),
  },
  handler: async (ctx, { contractorPaymentId, escalated, waitingDays }) => {
    try {
      const { emails, payment } = await ctx.runQuery(
        internal.contractorPayments.reviewerRecipients,
        { contractorPaymentId },
      );
      if (!payment || emails.length === 0) return null;
      const url = appUrl(`/finances/payments/${contractorPaymentId}`);
      const { subject, html } = buildReviewTask({
        reference: payment.reference,
        payeeName: payment.payeeName,
        serviceDescription: payment.serviceDescription,
        amountCents: payment.agreedAmountCents,
        origin: payment.origin,
        url,
        escalated,
        waitingDays,
      });
      for (const to of emails) {
        try {
          await sendEmail(ctx, { to, subject, html: emailShell(html) });
        } catch (err) {
          console.error("[contractorPayments] review task failed", to, err);
        }
      }
    } catch (err) {
      console.error("[contractorPayments] review tasks failed", err);
    }
    return null;
  },
});

export const sendChangesRequestedNotice = internalAction({
  args: { contractorPaymentId: v.id("contractorPayments") },
  handler: async (ctx, { contractorPaymentId }) => {
    try {
      const p = await ctx.runQuery(internal.contractorPayments.noticePayload, {
        contractorPaymentId,
      });
      if (!p?.payeeEmail || !p.reviewNote) return null;
      const url = contractUrl(p.chapterSlug, p.token);
      if (!url) return null;
      const { subject, html } = buildChangesRequestedNotice({
        payeeName: p.payeeName,
        chapterName: p.chapterName,
        reference: p.reference,
        note: p.reviewNote,
        url,
      });
      await sendEmail(ctx, { to: p.payeeEmail, subject, html: emailShell(html) });
    } catch (err) {
      console.error("[contractorPayments] changes-requested notice failed", err);
    }
    return null;
  },
});

/** "Approved." Claims the one-shot send right FIRST — the claim is what makes
 *  this exactly-once across a retry, a backfill, and any future third caller. */
export const sendApprovedNotice = internalAction({
  args: { contractorPaymentId: v.id("contractorPayments") },
  handler: async (ctx, { contractorPaymentId }) => {
    try {
      const claimed = await ctx.runMutation(
        internal.contractorPayments.markApprovedNoticeSent,
        { contractorPaymentId },
      );
      if (!claimed) return null;
      const p = await ctx.runQuery(internal.contractorPayments.noticePayload, {
        contractorPaymentId,
      });
      if (!p?.payeeEmail) return null;
      const { subject, html } = buildApprovedNotice({
        payeeName: p.payeeName,
        chapterName: p.chapterName,
        reference: p.reference,
        amountCents: p.approvedCents ?? p.agreedAmountCents,
        bankAccountLast4: p.bankAccountLast4,
      });
      await sendEmail(ctx, { to: p.payeeEmail, subject, html: emailShell(html) });
    } catch (err) {
      console.error("[contractorPayments] approved notice failed", err);
    }
    return null;
  },
});

/** "The money went out." Same claim-first shape as the approved notice. */
export const sendPaidNotice = internalAction({
  args: { contractorPaymentId: v.id("contractorPayments") },
  handler: async (ctx, { contractorPaymentId }) => {
    try {
      const claimed = await ctx.runMutation(
        internal.contractorPayments.markPaidNoticeSent,
        { contractorPaymentId },
      );
      if (!claimed) return null;
      const p = await ctx.runQuery(internal.contractorPayments.noticePayload, {
        contractorPaymentId,
      });
      if (!p?.payeeEmail) return null;
      const { subject, html } = buildPaidNotice({
        payeeName: p.payeeName,
        chapterName: p.chapterName,
        reference: p.reference,
        amountCents: p.approvedCents ?? p.agreedAmountCents,
        bankAccountLast4: p.bankAccountLast4,
        paidAt: p.paidAt ?? Date.now(),
      });
      await sendEmail(ctx, { to: p.payeeEmail, subject, html: emailShell(html) });
    } catch (err) {
      console.error("[contractorPayments] paid notice failed", err);
    }
    return null;
  },
});

/**
 * The daily sweep that nags treasurers about payments waiting on a decision,
 * and escalates the ones nobody has touched.
 *
 * NO AUTO-CANCEL. A payment that has sat for a fortnight keeps sitting; the
 * sweep just gets louder. Silently killing somebody's payment because an
 * internal queue went unattended punishes the contractor for the org's delay,
 * which is exactly backwards.
 */
const REVIEW_NUDGE_AFTER_MS = 3 * 24 * 60 * 60 * 1000;
const REVIEW_ESCALATE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export const sweepPendingReviews = internalAction({
  args: {},
  handler: async (ctx): Promise<{ swept: number }> => {
    // Explicitly typed because this action calls back into its OWN module's
    // `internal` object; without the annotation TypeScript cannot close the
    // inference loop and silently degrades `internal` to `any` for every file
    // in the deployment. (Convex's own guideline calls this out for same-file
    // `ctx.runQuery`.)
    const rows: Array<{
      _id: Id<"contractorPayments">;
      chapterId: Id<"chapters">;
      submittedAt: number;
      reviewNudgeSentAt?: number;
      reviewEscalatedAt?: number;
    }> = await ctx.runQuery(internal.contractorPayments.pendingReview, {
      olderThanMs: REVIEW_NUDGE_AFTER_MS,
    });
    const now = Date.now();
    for (const row of rows) {
      const waited = now - row.submittedAt;
      const escalate =
        waited >= REVIEW_ESCALATE_AFTER_MS && row.reviewEscalatedAt == null;
      const nudge = !escalate && row.reviewNudgeSentAt == null;
      if (!escalate && !nudge) continue;
      await ctx.runAction(internal.contractorPayments.sendReviewTasks, {
        contractorPaymentId: row._id,
        escalated: escalate,
        waitingDays: Math.floor(waited / (24 * 60 * 60 * 1000)),
      });
      await ctx.runMutation(internal.contractorPayments.markReviewNudged, {
        contractorPaymentId: row._id,
        escalated: escalate,
      });
    }
    return { swept: rows.length };
  },
});

// ── INTERNAL: tax-document retention ────────────────────────────────────────
/**
 * Delete tax documents past their retention window — the FILE from storage and
 * then the row.
 *
 * This is the half of the retention promise that actually protects anybody. A
 * policy that says "we keep W-9s for four years" and never deletes one is just
 * an SSN sitting in a bucket forever. Batched and self-scheduling, per the
 * Convex guideline for bulk deletion.
 *
 * Storage delete FIRST, then the row: if the process dies between the two, the
 * row is a harmless dangling pointer that the next sweep retries. The other
 * order would lose the pointer and orphan the file permanently — the one
 * failure mode where the SSN is what survives.
 */
export const purgeExpiredTaxDocuments = internalMutation({
  args: { batchSize: v.optional(v.number()) },
  handler: async (ctx, { batchSize }) => {
    const take = Math.min(Math.max(batchSize ?? 50, 1), 200);
    const due = await ctx.db
      .query("contractorTaxDocuments")
      .withIndex("by_purge_after", (q) => q.lte("purgeAfter", Date.now()))
      .take(take);
    const now = Date.now();
    for (const doc of due) {
      try {
        await ctx.storage.delete(doc.storageId);
      } catch {
        // Already gone (a previous run died between the two deletes) — the row
        // still has to go, so this is not a reason to stop.
      }
      // STAMP EVERY PAYMENT THAT CITED IT before the row disappears. Otherwise
      // a payment whose document was destroyed on schedule reads exactly like
      // one where nobody ever collected a form — and the difference between
      // "we kept it for four years and then destroyed it as promised" and "we
      // never had it" is the whole of whether the org did its job. Bounded: a
      // document is cited by a handful of payments, never an unbounded list.
      const citing = await ctx.db
        .query("contractorPayments")
        .withIndex("by_chapter", (q) => q.eq("chapterId", doc.chapterId))
        .take(500);
      for (const payment of citing) {
        if (payment.taxDocumentId !== doc._id) continue;
        await ctx.db.patch(payment._id, {
          taxDocumentId: undefined,
          taxDocPurgedAt: now,
          updatedAt: now,
        });
      }
      await ctx.db.delete(doc._id);
    }
    if (due.length === take) {
      await ctx.scheduler.runAfter(
        0,
        internal.contractorPayments.purgeExpiredTaxDocuments,
        { batchSize: take },
      );
    }
    return { purged: due.length };
  },
});
