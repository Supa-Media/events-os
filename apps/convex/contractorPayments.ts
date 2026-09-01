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
  summarizeContractorSchedule,
  CENTRAL,
  type ContractorPaymentStatus,
  type ContractorPaymentOrigin,
  type ContractorTaxDocKind,
} from "@events-os/shared";
import {
  EXTERNAL_ACCOUNT_FUNDINGS,
  type ExternalAccountFunding,
} from "@events-os/shared";
import { normalizeEmail, getUserEmail } from "./lib/access";
import { personSendAddress } from "./lib/personEmails";
import { requireChapterId, requireInChapter } from "./lib/context";
import { requireBudgetCategory } from "./lib/budgetCategoryAccess";
import { assertRoutingNumber, assertAccountNumber } from "./increase";
import { sendEmail, emailShell } from "./ticketingEmails";
import { appUrl, siteUrl } from "./lib/siteUrl";
import {
  buildAgreementInvite,
  buildSubmittedReceipt,
  buildChangesRequestedNotice,
  buildApprovedNotice,
  buildPaidNotice,
  buildInstallmentPaidNotice,
  buildReviewTask,
} from "./lib/contractorPaymentEmails";
import {
  resolveCallerPersonId,
  resolveActorPersonId,
  assertSeparationOfDuties,
  defaultFundId,
  listChapterFinanceManagerPersonIds,
  type FinanceScope,
} from "./lib/finance";
import {
  profileFor,
  latestTaxDocFor,
  matchPersonByEmail,
  touchUnpaidTaxDoc,
} from "./contractorProfiles";
import { loadSchedule, hasSchedule } from "./lib/contractorSchedule";
import {
  gatherForPickerCandidates,
  budgetDisplayNameFor,
} from "./lib/forPickerCandidates";
import { ROLLUP_SCAN_LIMIT } from "./finances";
import {
  scopePublicName,
  scopeInternalName,
  scopePublicSlug,
  resolveContractScope,
  CENTRAL_PUBLIC_SLUG,
} from "./lib/financeScope";
import {
  writeSchedule,
  installmentDraftValidator,
} from "./contractorInstallments";
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

/**
 * Did the proposed schedule actually differ from the one on file?
 *
 * Compared field by field rather than by identity because the detail screen
 * re-sends the whole schedule on every terms save, unchanged or not. Treating
 * that as a change would void a contractor's signature — and email them asking
 * them to sign again — because a bookkeeper fixed a typo in the notes.
 */
function scheduleChanged(
  before: readonly Doc<"contractorPaymentInstallments">[],
  after: readonly {
    label: string;
    amountCents: number;
    trigger: string;
    dueDate?: number;
    milestoneNote?: string;
  }[],
): boolean {
  if (before.length !== after.length) return true;
  return before.some((b, i) => {
    const a = after[i];
    return (
      b.label !== a.label.trim() ||
      b.amountCents !== a.amountCents ||
      b.trigger !== a.trigger ||
      (b.dueDate ?? null) !== (a.dueDate ?? null) ||
      (b.milestoneNote ?? "") !== (a.milestoneNote?.trim() ?? "")
    );
  });
}

/**
 * THE BUDGET BEHIND A CODING TARGET, and the scope that budget belongs to.
 *
 * An event or a project is coded by NAME, but the money behind it lives in a
 * `one_time` budget attached to that ref — and that budget may sit at the org
 * level even when the event itself belongs to a chapter (see
 * `lib/forPickerCandidates.ts`, which deliberately surfaces central project
 * budgets in a chapter's picker). So "which chapter is this event in" is not
 * the same question as "whose money pays for it", and only the second one
 * decides where the spend books.
 */
async function fundingScopeFor(
  ctx: QueryCtx,
  args: {
    eventId?: Id<"events">;
    projectId?: Id<"projects">;
    budgetId?: Id<"budgets">;
  },
): Promise<FinanceScope | null> {
  if (args.budgetId) {
    const budget = await ctx.db.get(args.budgetId);
    return budget?.chapterId ?? null;
  }
  const ref = args.eventId ?? args.projectId;
  if (!ref) return null;
  const refKind = args.eventId ? "event" : "project";
  const budgets = await ctx.db
    .query("budgets")
    .withIndex("by_ref", (q) =>
      q.eq("refKind", refKind).eq("scopeRefId", String(ref)),
    )
    .take(10);
  if (budgets.length === 0) return null;
  // Oldest wins, matching `gatherForPickerCandidates`' own duplicate rule, so
  // the picker and this check can never disagree about which budget is meant.
  const oldest = budgets.reduce((a, b) => (a.createdAt <= b.createdAt ? a : b));
  return oldest.chapterId;
}

/**
 * THE SPEND MUST BOOK WHERE THE MONEY COMES FROM.
 *
 * Founder, 2026-08-28: "I literally chose a budget that was a central budget…
 * and it says it's gonna be in New York's books." Exactly so, and it was wrong
 * in both directions at once — central's budget showed no spend against it,
 * and a chapter's books carried an expense central had agreed to pay.
 *
 * REFUSED, NOT SILENTLY RESCOPED. Moving the agreement to central on the
 * author's behalf would change who reviews it, who may approve it, and which
 * bank account sends the money — three decisions nobody made. The message says
 * where to compose it instead.
 *
 * Coding to nothing at all stays legal here: a `self_serve` request arrives
 * uncoded by design, and `approve` is what refuses to release money until a
 * human has said where it belongs.
 */
async function assertCodingMatchesScope(
  ctx: QueryCtx,
  scope: FinanceScope,
  args: {
    eventId?: Id<"events">;
    projectId?: Id<"projects">;
    budgetId?: Id<"budgets">;
  },
): Promise<void> {
  const funding = await fundingScopeFor(ctx, args);
  if (funding == null || funding === scope) return;
  const fundingName = await scopeInternalName(ctx, funding);
  const scopeName = await scopeInternalName(ctx, scope);
  throw new ConvexError({
    code: "SCOPE_MISMATCH",
    message:
      funding === CENTRAL
        ? `That's funded by a ${fundingName} budget, so it has to be paid from ${fundingName} — compose it at the ${fundingName} desk, not ${scopeName}'s.`
        : `That's funded by ${fundingName}'s budget, so it can't be paid from ${scopeName}'s books.`,
  });
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
  chapterId: FinanceScope;
  row: Doc<"contractorPayments">;
  callerPersonId: Id<"people">;
  callerEmail: string | null;
}> {
  const row = await ctx.db.get(contractorPaymentId);
  if (!row) {
    throw new ConvexError({
      code: "NOT_FOUND",
      message: "Contractor payment not found.",
    });
  }
  // AUTHORIZE AT THE RECORD'S OWN SCOPE, not at the caller's home chapter.
  //
  // This used to resolve the caller's roster chapter and demand the row match
  // it, which quietly meant two things: a central agreement was unreachable by
  // ANYONE (no roster person lives in "central", so the check could not pass),
  // and which desk you were sitting at was irrelevant — the row's chapter had
  // to equal your membership's. Asking the row whose money it is, then asking
  // whether the caller has finance rights THERE, is both the correct gate and
  // the one that lets a central desk open its own payments.
  //
  // Nothing is loosened: a New York viewer holds no finance role at Chicago's
  // scope, so `requireContractorPaymentsApprove` refuses exactly as the old
  // chapter comparison did — and a chapter grant deliberately does not reach
  // central (see `getFinanceRoleAtScope`).
  const scope = row.chapterId;
  await requireContractorPaymentsApprove(ctx, scope);
  const callerPersonId = await resolveActorPersonId(ctx, scope);
  const callerEmail = await getUserEmail(ctx);
  return { chapterId: scope, row, callerPersonId, callerEmail };
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
  chapterId: FinanceScope,
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

/**
 * The tax document substantiating a payment.
 *
 * `taxDocumentId` FIRST, because a reused document belongs to an earlier
 * payment and the `by_payment` index will never find it. Resolving it the old
 * way made a returning contractor's payment report "no tax document on file"
 * on the detail screen and refuse to open the form that actually substantiates
 * it — while `approve`, which only checked whether a document existed, waved it
 * through unexamined.
 *
 * The `by_payment` fallback is for rows written before citations existed.
 */
async function taxDocFor(
  ctx: QueryCtx,
  row: Doc<"contractorPayments">,
): Promise<Doc<"contractorTaxDocuments"> | null> {
  if (row.taxDocumentId) {
    const cited = await ctx.db.get(row.taxDocumentId);
    if (cited) return cited;
  }
  return await ctx.db
    .query("contractorTaxDocuments")
    .withIndex("by_payment", (q) => q.eq("contractorPaymentId", row._id))
    .order("desc")
    .first();
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
    chapterId: FinanceScope;
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
    additionalTerms?: string;
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
  //
  // CATEGORY is deliberately NOT in this loop. It is an org-wide label as of
  // 2026-08-14 (`schema/finances.ts#budgetCategories`) and carries no
  // `chapterId` for `requireInChapter` to compare, so running it through here
  // would reject EVERY category — the one shape of bug this loop's own
  // tightening was meant to prevent, inverted. Its check is existence, via the
  // resolver every other category call site uses.
  for (const [id, table, label] of [
    [args.eventId, "events", "Event"],
    [args.projectId, "projects", "Project"],
    [args.budgetId, "budgets", "Budget"],
    [args.fundId, "funds", "Fund"],
  ] as const) {
    if (!id) continue;
    const doc = await ctx.db.get(id as Id<"events">);
    await requireInChapter(ctx, args.chapterId, doc, label);
  }
  if (args.categoryId) await requireBudgetCategory(ctx, args.categoryId);
  // The spend books where the money comes from — see `assertCodingMatchesScope`.
  await assertCodingMatchesScope(ctx, args.chapterId, args);

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
    ...(capOptional(args.additionalTerms, 4000)
      ? { additionalTerms: capOptional(args.additionalTerms, 4000) }
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
    // Extra AGREED terms, shown to the contractor and covered by their
    // signature — unlike `agreementNotes`, which stays finance-private.
    additionalTerms: v.optional(v.string()),
    eventId: v.optional(v.id("events")),
    projectId: v.optional(v.id("projects")),
    budgetId: v.optional(v.id("budgets")),
    categoryId: v.optional(v.id("budgetCategories")),
    fundId: v.optional(v.id("funds")),
    // WHOSE BOOKS PAY, and therefore whose bank account sends. Defaults to the
    // caller's home chapter, so nothing about an existing chapter flow moves.
    //
    // Passing `"central"` composes an ORG-LEVEL agreement: reviewed by central
    // finance, paid from central's Increase account, booked to central's
    // ledger, and served at `/contract/central`. Before this the scope was
    // always the composer's roster chapter, so an agreement funded by a central
    // budget still told the contractor it came from New York's books — and did.
    scope: v.optional(v.union(v.id("chapters"), v.literal(CENTRAL))),
  },
  handler: async (ctx, { scope, ...args }) => {
    const chapterId: FinanceScope =
      scope ?? ((await requireChapterId(ctx)) as Id<"chapters">);
    await requireContractorPaymentsCompose(ctx, chapterId);
    const callerPersonId = await resolveActorPersonId(ctx, chapterId);
    if (args.personId) {
      const person = await ctx.db.get(args.personId);
      if (!person) {
        throw new ConvexError({ code: "NOT_FOUND", message: "Person not found." });
      }
      // A central agreement's payee may be on ANY chapter's roster — people
      // belong to chapters, central does not have one — so the roster link is
      // checked for existence rather than for membership of the paying scope.
      // For a chapter agreement the old rule stands.
      if (chapterId !== CENTRAL) {
        await requireInChapter(ctx, chapterId, person, "Person");
      }
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
    const row = await ctx.db.get(contractorPaymentId);
    if (!row) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Contractor payment not found.",
      });
    }
    // At the RECORD's own scope — see `loadForManage`. Resolving the caller's
    // roster chapter instead made every central agreement unreachable.
    const chapterId: FinanceScope = row.chapterId;
    await requireContractorPaymentsCompose(ctx, chapterId);
    assertTransition(row.status, ["draft", "sent"], "send");

    // The link is addressed by the CHAPTER SLUG, and `chapters.slug` is
    // optional. Without one the URL degrades to `/contract/?token=…`, which the
    // route 404s — so `send` would succeed, staff would copy a dead link into a
    // text message, and the contractor would never be able to get paid, with
    // nothing anywhere reporting a failure. Refuse loudly instead: this is the
    // one moment someone can still fix it.
    // Central always has one (the reserved `central` segment), so this only
    // ever fires for a chapter that has no slug set.
    const slug = await scopePublicSlug(ctx, chapterId);
    if (!slug) {
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
    // An AGREED term (see the schema) — an empty string clears it, and a real
    // change voids an acceptance exactly as changing the amount does.
    additionalTerms: v.optional(v.string()),
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
    // The payment SCHEDULE, when this edit changes one. Absent means "leave it
    // alone"; an empty array means "pay this in one go after all".
    //
    // It rides on this mutation, rather than only on `setSchedule`, because the
    // agreed total and the plan that splits it constrain each other: the plan
    // must sum to the total, and the total may not move while a plan pins it.
    // From outside a transaction there is no order to change both in — either
    // call fails first. Inside one, the new plan is simply checked against the
    // new total.
    installments: v.optional(v.array(installmentDraftValidator)),
  },
  handler: async (ctx, args) => {
    const {
      contractorPaymentId,
      clearAttribution,
      clearServiceDate,
      clearCategory,
      installments,
      ...rest
    } = args;
    const row = await ctx.db.get(contractorPaymentId);
    if (!row) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Contractor payment not found.",
      });
    }
    // At the RECORD's own scope — see `loadForManage`. Resolving the caller's
    // roster chapter instead made every central agreement unreachable.
    const chapterId: FinanceScope = row.chapterId;
    await requireContractorPaymentsCompose(ctx, chapterId);
    assertTransition(row.status, TERMS_EDITABLE_STATUSES, "edit");
    const callerPersonId = await resolveActorPersonId(ctx, chapterId);

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
        // A SCHEDULE IS PINNED TO THE TOTAL IT SPLITS. Letting the total move
        // out from under it would leave tranches that no longer add up —
        // silently, since nothing re-runs the sum after the fact — and the
        // agreement would pay out a number nobody chose. Refused here rather
        // than auto-adjusted: which tranche absorbs a $500 increase is a
        // decision about the deal, and the app does not get to make it.
        //
        // Unless the caller is re-cutting the schedule in this same edit, which
        // is exactly how that decision gets made — see the `installments` arg.
        if (installments === undefined && (await hasSchedule(ctx, contractorPaymentId))) {
          throw new ConvexError({
            code: "SCHEDULE_LOCKED",
            message:
              "This agreement pays on a schedule. Change the schedule to the new total — the payments have to add up to it.",
          });
        }
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
    if (rest.additionalTerms !== undefined) {
      // The contractor reads and signs these on their page, so a change here is
      // a change to the agreed terms — compared by value like the rest of the
      // bucket, and an empty string is an explicit clear (also a change).
      const next = capOptional(rest.additionalTerms, 4000);
      if ((next ?? null) !== (row!.additionalTerms ?? null)) {
        patch.additionalTerms = next;
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
      // Existence only — a category is org-wide and has no chapter to match
      // against (see the create path's own note, and
      // `lib/budgetCategoryAccess.ts`). The FUND below stays chapter-checked.
      await requireBudgetCategory(ctx, rest.categoryId);
      patch.categoryId = rest.categoryId;
    }
    if (rest.fundId !== undefined) {
      const doc = await ctx.db.get(rest.fundId);
      await requireInChapter(ctx, chapterId, doc, "Fund");
      patch.fundId = rest.fundId;
    }

    // Re-coding faces the same rule the create path does: an edit that points
    // the payment at a differently-funded budget would otherwise book a
    // chapter's spend against central's money, or the reverse.
    await assertCodingMatchesScope(ctx, row!.chapterId, {
      eventId: patch.eventId ?? (clearAttribution ? undefined : row!.eventId),
      projectId: patch.projectId ?? (clearAttribution ? undefined : row!.projectId),
      budgetId: patch.budgetId ?? (clearAttribution ? undefined : row!.budgetId),
    });

    // The schedule, against the total this edit LANDS on — which is the whole
    // reason it is written here rather than through a second mutation.
    if (installments !== undefined) {
      const nextAmount = patch.agreedAmountCents ?? row!.agreedAmountCents;
      const before = await loadSchedule(ctx, contractorPaymentId);
      await writeSchedule(ctx, chapterId, row!, installments, nextAmount);
      // A plan is a term, so a plan that MOVED voids an acceptance exactly as a
      // changed amount does. Compared by value so re-saving an unchanged
      // schedule — which the detail screen does on every terms save — does not
      // cost somebody their signature for nothing.
      if (scheduleChanged(before, installments)) termsChanged = true;
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
    // WHOSE QUEUE — a chapter, or the org level. Defaults to the caller's home
    // chapter so every existing caller is unchanged; the app passes the active
    // desk's scope, which is what makes a central desk show central's payments
    // instead of silently showing the operator's home chapter's.
    //
    // Same shape as `finances.ts`'s own scope argument, deliberately.
    scope: v.optional(v.union(v.id("chapters"), v.literal(CENTRAL))),
  },
  handler: async (ctx, { status, limit, scope }) => {
    const chapterId: FinanceScope =
      scope ?? ((await requireChapterId(ctx)) as Id<"chapters">);
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
    const row = await ctx.db.get(contractorPaymentId);
    if (!row) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Contractor payment not found.",
      });
    }
    // At the RECORD's scope — see `loadForManage` for the full reasoning. This
    // is what lets a central desk open a central agreement, and what lets any
    // desk open a payment it has finance rights over.
    const chapterId: FinanceScope = row.chapterId;
    await requireContractorPaymentsView(ctx, chapterId);

    const canCompose = await hasContractorPaymentsCompose(ctx, chapterId);
    const canApprove = await hasContractorPaymentsApprove(ctx, chapterId);
    const canViewTaxDoc = await hasContractorTaxDocView(ctx, chapterId);

    const taxDoc = await taxDocFor(ctx, row!);

    const payout = row!.payoutId ? await ctx.db.get(row!.payoutId) : null;

    // THE SCOPE'S OWN PUBLIC SLUG, so the app can build the contractor's link
    // without guessing. Before this it derived a CANDIDATE slug from whichever
    // desk you happened to be sitting at and verified it — which meant the copy
    // button died on any desk that wasn't the payment's chapter, and at a
    // central desk reported that "a central desk has no public page of its
    // own". It has one now (`/contract/central`), and either way the record is
    // the thing that knows where its own page lives.
    const scopeSlug = await scopePublicSlug(ctx, chapterId);

    return {
      _id: row!._id,
      reference: contractorReferenceFor(row!._id),
      // Whose money this is. `scope` drives the app's own labelling ("Central"
      // vs the chapter), `scopeSlug` builds the public link, and `scopeName` is
      // what the CONTRACTOR would see — kept apart because "Central" is
      // internal vocabulary that must never reach a payee.
      scope: chapterId,
      scopeSlug,
      scopeName: await scopeInternalName(ctx, chapterId),
      isCentral: chapterId === CENTRAL,
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
      additionalTerms: row!.additionalTerms,
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
      // The contractor's own invoice, when they attached one. Metadata only,
      // same posture as the tax document — opening it is `viewInvoice`.
      invoice: row!.invoiceStorageId
        ? {
            fileName: row!.invoiceFileName,
            uploadedAt: row!.invoiceUploadedAt,
          }
        : null,
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

    const taxDoc = await taxDocFor(ctx, row);
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
    // A SCHEDULE IS APPROVED AS WRITTEN. Its tranches sum to the agreed total by
    // construction, so approving a different number would leave the plan and
    // the approval disagreeing about how much the org owes — and every tranche
    // would still pay its own full amount, quietly ignoring the reduction. The
    // way to pay a scheduled agreement less is to re-cut the schedule, which
    // re-asks the contractor, which is the correct thing to happen when the
    // money changes.
    const scheduleRows = await loadSchedule(ctx, contractorPaymentId);
    if (scheduleRows.length > 0 && amount !== row.agreedAmountCents) {
      throw new ConvexError({
        code: "INVALID_INPUT",
        message:
          "This agreement pays on a schedule, so it's approved for the full agreed amount. Change the schedule instead — that re-asks the contractor.",
      });
    }
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
    // Take the schedule down with the agreement. Nothing could pay these — the
    // payout rail refuses any agreement that isn't `approved` — but a tranche
    // left `scheduled` still reads as owed everywhere a schedule is counted,
    // which would leave a canceled agreement reporting an outstanding balance
    // forever. Tranches already paid are untouched: that money did leave.
    for (const inst of await loadSchedule(ctx, contractorPaymentId)) {
      if (inst.status !== "scheduled") continue;
      await ctx.db.patch(inst._id, {
        status: "canceled",
        canceledAt: now,
        canceledByPersonId: callerPersonId,
        canceledReason: "The agreement was canceled.",
        updatedAt: now,
      });
    }
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
    const row = await ctx.db.get(contractorPaymentId);
    if (!row) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Contractor payment not found.",
      });
    }
    // At the RECORD's own scope — see `loadForManage`. Resolving the caller's
    // roster chapter instead made every central agreement unreachable.
    const chapterId: FinanceScope = row.chapterId;
    await requireContractorTaxDocView(ctx, chapterId);
    const callerPersonId = await resolveActorPersonId(ctx, chapterId);

    const taxDoc = await taxDocFor(ctx, row!);
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

/**
 * Open the invoice the contractor attached. A MUTATION like `viewTaxDocument`
 * and for the same reason: the URL only exists after an audit row says who
 * asked for it. Gated at VIEW rank rather than the tax-document power — an
 * invoice is billing paper, not a form with a tax ID on it — but it rides the
 * same per-caller rate budget, because "legitimate power, dangerous in bulk"
 * is about the scrape, not the document kind.
 */
export const viewInvoice = mutation({
  args: { contractorPaymentId: v.id("contractorPayments") },
  handler: async (ctx, { contractorPaymentId }) => {
    const row = await ctx.db.get(contractorPaymentId);
    if (!row) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Contractor payment not found.",
      });
    }
    const chapterId: FinanceScope = row.chapterId;
    await requireContractorPaymentsView(ctx, chapterId);
    const callerPersonId = await resolveActorPersonId(ctx, chapterId);

    if (!row.invoiceStorageId) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "No invoice has been attached to this payment.",
      });
    }

    await assertContractNotRateLimited(
      ctx,
      `invoice_view:${String(callerPersonId)}`,
      TAX_DOC_VIEW_MAX_PER_HOUR,
    );

    await ctx.db.insert("approvals", {
      chapterId,
      subjectType: "contractor_payment",
      subjectId: String(contractorPaymentId),
      action: "edit",
      actorPersonId: callerPersonId,
      note: "Viewed the invoice on file.",
      createdAt: Date.now(),
    });

    const url = await ctx.storage.getUrl(row.invoiceStorageId);
    if (!url) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "That invoice is no longer stored.",
      });
    }
    return { url, fileName: row.invoiceFileName };
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
      // Same rule as `reimbursements.ts`'s approver notice: a treasurer's
      // send address is `personSendAddress`, not their personal `email`.
      const email = normalizeEmail(await personSendAddress(ctx, person));
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
        // A reviewer approving a schedule is approving a payment CYCLE, not
        // one transfer — the task email says so from this count.
        installmentCount: (await loadSchedule(ctx, row._id)).filter(
          (i) => i.status !== "canceled",
        ).length,
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
 * WHAT AN AGREEMENT AT THIS SCOPE MAY BE CODED TO.
 *
 * `reimbursements.newRequestOptions` answers this for a chapter, and its
 * `forRequestOptions` deliberately drops central recurring budgets from the
 * list — right for a reimbursement, which is always a chapter's, and wrong the
 * moment an agreement can be central's. A central desk composing against that
 * list would be offered its operator's home chapter's budgets and NOTHING of
 * central's, so a central agreement could never be coded, and `approve` refuses
 * an uncoded payment — an agreement you can create and never pay.
 *
 * Its own query rather than a `scope` argument bolted onto the reimbursement
 * one: that function is the reimbursement composer's contract, and widening it
 * would make every reimbursement caller's payload depend on a concept
 * reimbursements do not have.
 */
export const codingOptionsForScope = query({
  args: { scope: v.union(v.id("chapters"), v.literal(CENTRAL)) },
  handler: async (ctx, { scope }) => {
    await requireContractorPaymentsView(ctx, scope);
    const { candidates } = await gatherForPickerCandidates(
      ctx,
      // The picker scans a chapter's events/projects; at the org level there is
      // no chapter of events to scan, so central offers its recurring budgets
      // and nothing else. A central ONE-TIME budget is attached to a chapter's
      // project and is already reachable from that chapter's own picker.
      scope === CENTRAL ? null : (scope as Id<"chapters">),
      ROLLUP_SCAN_LIMIT,
    );
    const wanted = scope === CENTRAL ? "central" : "chapter";
    return {
      // An event or project is offered only when the budget BEHIND it belongs to
      // this scope. That filter is the picker-side half of
      // `assertCodingMatchesScope`: a chapter's event funded by a central budget
      // is central's to pay, and offering it here is exactly how an agreement
      // came to say "New York's books" over central's money.
      events:
        scope === CENTRAL
          ? []
          : candidates.flatMap((c) =>
              c.refKind === "event" && c.budget?.chapterId === scope
                ? [{ id: c.refId, label: c.label }]
                : [],
            ),
      projects:
        scope === CENTRAL
          ? []
          : candidates.flatMap((c) =>
              c.refKind === "project" && c.budget?.chapterId === scope
                ? [{ id: c.refId, label: c.label }]
                : [],
            ),
      budgets: candidates.flatMap((c) =>
        c.refKind === "recurring" && c.level === wanted && c.budget
          ? [
              {
                id: c.budget._id,
                label: budgetDisplayNameFor(c.budget),
                cadence: c.budget.cadence,
              },
            ]
          : [],
      ),
    };
  },
});

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
    // `central` resolves here too, and is checked BEFORE any chapter lookup —
    // it is a reserved segment, so a chapter that somehow claimed the slug
    // could never shadow the org's own page. See `lib/financeScope.ts`.
    const resolved = await resolveContractScope(ctx, chapterSlug);
    if (!resolved) return null;
    return {
      chapterId: resolved.scope,
      name: resolved.name,
      slug: resolved.slug,
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
    // The scope's PUBLIC name — "Public Worship" for a central agreement, the
    // chapter's own name otherwise. Never `ctx.db.get(row.chapterId)`: central
    // is a sentinel, not a `chapters` row.
    const scopeName = await scopePublicName(ctx, row.chapterId);
    const taxDoc = await taxDocFor(ctx, row);

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

    // THE SCHEDULE IS A TERM, so it belongs on the page where they read the
    // terms — a contractor asked to sign for $10,000 is entitled to see that it
    // arrives in two halves before they agree, not to discover it when the
    // first one is smaller than they expected. On the status page it is also
    // the honest answer to "have you paid me yet?".
    //
    // Projected field by field like everything else here: `releaseNote` and
    // `canceledReason` are internal staff writing and deliberately stay off it.
    const schedule = await loadSchedule(ctx, row._id);

    return {
      reference: contractorReferenceFor(row._id),
      chapterName: scopeName,
      status: row.status,
      statusLabel: CONTRACTOR_PAYMENT_STATUS_LABELS[row.status],
      installments: schedule.map((i) => ({
        seq: i.seq,
        label: i.label,
        amountCents: i.amountCents,
        trigger: i.trigger,
        dueDate: i.dueDate,
        milestoneNote: i.milestoneNote,
        status: i.status,
        paidAt: i.paidAt,
      })),
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
      // The extra agreed terms they sign, NOT `agreementNotes`: the file note
      // is the finance team's own writing, promised private by the composer
      // ("never shown to the contractor or published"), and until 2026-08-28
      // this projection broke that promise by feeding it to the terms card.
      additionalTerms: row.additionalTerms,
      // Their own invoice's filename, so the page can confirm we hold it.
      invoiceFileName: row.invoiceFileName,
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
  // A W-8 EXPIRES, so its signing date is what decides when. Three comments in
  // this file claimed the server required it and nothing did, which meant a
  // direct POST could store an undated W-8 — read as permanently expired by
  // `taxDocIsCurrent`, so the payee is re-asked forever and can never reuse.
  // Enforced here, at the single place documents are created.
  if (isForeignTaxDoc(kind) && signedAt == null) {
    throw new ConvexError({
      code: "INVALID_INPUT",
      message:
        "Tell us the date you signed this form — a W-8 is only valid for three years after signing.",
    });
  }
  if (signedAt != null && signedAt > Date.now() + 24 * 60 * 60 * 1000) {
    throw new ConvexError({
      code: "INVALID_INPUT",
      message: "That signing date is in the future.",
    });
  }

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

  // Supersede the previous one, file and all — but ONLY when nothing else
  // relies on it.
  //
  // Documents are shared now. A form first collected for payment A can be cited
  // by payments B and C; re-completing A after a send-back would otherwise
  // destroy the file and the row out from under them, leaving B and C with a
  // dangling id, no `taxDocPurgedAt` to say what happened, and — because
  // `approve` only asks whether a document exists — a clear path to being paid
  // against no form at all.
  const previous = await ctx.db
    .query("contractorTaxDocuments")
    .withIndex("by_payment", (q) => q.eq("contractorPaymentId", row._id))
    .take(10);
  for (const old of previous) {
    const citedElsewhere = await ctx.db
      .query("contractorPayments")
      .withIndex("by_tax_document", (q) => q.eq("taxDocumentId", old._id))
      .take(5);
    if (citedElsewhere.some((p) => p._id !== row._id)) {
      // Another payment stands on it. Leave it entirely — the retention sweep
      // owns its lifetime now, not this supersede.
      continue;
    }
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
 * Attach the contractor's own INVOICE to their payment. Optional on both
 * public submit paths — an invoice is the contractor's bill, not the org's
 * substantiation (that is the agreement itself), so nothing requires one.
 *
 * Same validation posture as `attachTaxDocument` and for the same reason: the
 * `_storage` system row is the file's REAL type and size, not the browser's
 * claim. Same shapes and the same ceiling, because "a PDF or a photo of a
 * document, under 20MB" is what both of these are.
 *
 * Supersedes a previous invoice, file and all — unlike tax documents an
 * invoice is never shared between payments, so the old file has no other
 * dependents and can simply go.
 */
async function attachInvoice(
  ctx: MutationCtx,
  row: Doc<"contractorPayments">,
  storageId: Id<"_storage">,
  fileName?: string,
): Promise<void> {
  const meta = await ctx.db.system.get(storageId);
  if (!meta) {
    throw new ConvexError({
      code: "INVALID_INPUT",
      message:
        "Your invoice upload didn't finish — please try attaching it again.",
    });
  }
  if (meta.contentType && !TAX_DOC_CONTENT_TYPES.includes(meta.contentType)) {
    await ctx.storage.delete(storageId);
    throw new ConvexError({
      code: "INVALID_INPUT",
      message: "Upload the invoice as a PDF or a photo.",
    });
  }
  if (meta.size > TAX_DOC_MAX_BYTES) {
    await ctx.storage.delete(storageId);
    throw new ConvexError({
      code: "INVALID_INPUT",
      message: "That invoice is too large — keep it under 20MB.",
    });
  }
  if (row.invoiceStorageId && row.invoiceStorageId !== storageId) {
    try {
      await ctx.storage.delete(row.invoiceStorageId);
    } catch {
      // Already gone — the new one still replaces it.
    }
  }
  await ctx.db.patch(row._id, {
    invoiceStorageId: storageId,
    invoiceFileName: fileName ? cap(fileName, 200) : undefined,
    invoiceUploadedAt: Date.now(),
    updatedAt: Date.now(),
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
    // Their own invoice, optional — validated and attached by `attachInvoice`.
    invoiceStorageId: v.optional(v.id("_storage")),
    invoiceFileName: v.optional(v.string()),
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

    if (args.invoiceStorageId) {
      await attachInvoice(ctx, row, args.invoiceStorageId, args.invoiceFileName);
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

    // Keep an UNPAID document's short window alive while a live payment is
    // still waiting on a decision. Without this, a submission that sits in the
    // queue past the unpaid window is purged mid-flight and the treasurer opens
    // a payment whose form has evaporated.
    const citedDoc = (await ctx.db.get(row._id))?.taxDocumentId;
    if (citedDoc) await touchUnpaidTaxDoc(ctx, citedDoc);

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
    // Their own invoice, optional — validated and attached by `attachInvoice`.
    invoiceStorageId: v.optional(v.id("_storage")),
    invoiceFileName: v.optional(v.string()),
    externalAccountId: v.string(),
    bankAccountLast4: v.string(),
    signature: v.string(),
    clientIp: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // `central` resolves here exactly as a chapter slug does, so a self-serve
    // request filed from `/contract/central` lands in central's queue rather
    // than 404ing on a page that renders perfectly well.
    const resolved = await resolveContractScope(ctx, args.chapterSlug);
    if (!resolved) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "We couldn't find that page.",
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
    // For a CHAPTER request the roster match must be that chapter's own person.
    // For a CENTRAL one there is no roster to match against, so any roster row
    // with this email is the best available link — still a convenience for the
    // reviewer, still never an identity claim.
    const personId =
      personMatch &&
      (resolved.scope === CENTRAL || personMatch.chapterId === resolved.scope)
        ? personMatch._id
        : undefined;

    const { id } = await createContractorPayment(ctx, {
      chapterId: resolved.scope,
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
    if (args.invoiceStorageId) {
      await attachInvoice(ctx, row, args.invoiceStorageId, args.invoiceFileName);
    }
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
    const resolved = await resolveContractScope(ctx, chapterSlug);
    if (!resolved) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "We couldn't find that page.",
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
    // Both come from the scope, so a CENTRAL agreement's invitation says
    // "Public Worship" and links to `/contract/central` — before this, the
    // `ctx.db.get` here returned nothing for central and the email went out
    // naming no one, linking nowhere.
    const scopeName = await scopePublicName(ctx, row.chapterId);
    const slug = await scopePublicSlug(ctx, row.chapterId);
    return {
      reference: contractorReferenceFor(row._id),
      chapterName: scopeName,
      chapterSlug: slug ?? "",
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
      // The agreed schedule, for the emails' "How you'll be paid" panel —
      // canceled tranches are dropped because the panel states what WILL be
      // paid, and the cancel's own story lives on the schedule card in-app.
      installments: (await loadSchedule(ctx, row._id))
        .filter((i) => i.status !== "canceled")
        .map((i) => ({
          label: i.label,
          amountCents: i.amountCents,
          trigger: i.trigger,
          dueDate: i.dueDate,
          milestoneNote: i.milestoneNote,
        })),
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
        installments: p.installments,
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
          installments: p.installments,
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
        installmentCount: payment.installmentCount,
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
        installments: p.installments,
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

/** Claim THIS tranche's paid notice, exactly as `markPaidNoticeSent` claims the
 *  agreement's. Per tranche because a contractor owed three payments has to be
 *  told three times — and told which one. */
export const markInstallmentPaidNoticeSent = internalMutation({
  args: { installmentId: v.id("contractorPaymentInstallments") },
  handler: async (ctx, { installmentId }) => {
    const row = await ctx.db.get(installmentId);
    if (!row || row.paidNoticeSentAt != null) return false;
    await ctx.db.patch(installmentId, {
      paidNoticeSentAt: Date.now(),
      updatedAt: Date.now(),
    });
    return true;
  },
});

/** Everything the tranche notice needs — the agreement's identity plus this
 *  tranche's place in the schedule and what is left after it. */
export const installmentNoticePayload = internalQuery({
  args: { installmentId: v.id("contractorPaymentInstallments") },
  handler: async (ctx, { installmentId }) => {
    const inst = await ctx.db.get(installmentId);
    if (!inst) return null;
    const row = await ctx.db.get(inst.contractorPaymentId);
    if (!row) return null;
    const scopeName = await scopePublicName(ctx, row.chapterId);
    const schedule = await loadSchedule(ctx, row._id);
    const summary = summarizeContractorSchedule(schedule);
    return {
      reference: contractorReferenceFor(row._id),
      chapterName: scopeName,
      payeeName: row.payeeName,
      payeeEmail: row.payeeEmail,
      bankAccountLast4: row.bankAccountLast4,
      installmentLabel: inst.label,
      installmentSeq: inst.seq,
      installmentCount: schedule.length,
      amountCents: inst.amountCents,
      remainingCents: summary.remainingCents,
      paidAt: inst.paidAt ?? Date.now(),
    };
  },
});

/** "One of your scheduled payments has been sent." Scheduled by
 *  `settleContractorPaid` when a tranche settles and the schedule is NOT yet
 *  finished — the final one gets `sendPaidNotice` instead, so a contractor is
 *  never told the engagement is complete while money is still owed. */
export const sendInstallmentPaidNotice = internalAction({
  args: { installmentId: v.id("contractorPaymentInstallments") },
  handler: async (ctx, { installmentId }) => {
    try {
      const claimed = await ctx.runMutation(
        internal.contractorPayments.markInstallmentPaidNoticeSent,
        { installmentId },
      );
      if (!claimed) return null;
      const p = await ctx.runQuery(
        internal.contractorPayments.installmentNoticePayload,
        { installmentId },
      );
      if (!p?.payeeEmail) return null;
      const { subject, html } = buildInstallmentPaidNotice({
        payeeName: p.payeeName,
        chapterName: p.chapterName,
        reference: p.reference,
        installmentLabel: p.installmentLabel,
        installmentSeq: p.installmentSeq,
        installmentCount: p.installmentCount,
        amountCents: p.amountCents,
        remainingCents: p.remainingCents,
        bankAccountLast4: p.bankAccountLast4,
        paidAt: p.paidAt,
      });
      await sendEmail(ctx, { to: p.payeeEmail, subject, html: emailShell(html) });
    } catch (err) {
      console.error("[contractorPayments] installment paid notice failed", err);
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
      chapterId: FinanceScope;
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
        .withIndex("by_tax_document", (q) => q.eq("taxDocumentId", doc._id))
        .take(100);
      for (const payment of citing) {
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
