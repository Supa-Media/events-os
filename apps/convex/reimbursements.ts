/**
 * Reimbursements — the accountless public submission path, its in-app member
 * twin, + the in-app manager approval queue (Phase 3 of the Chapter OS finance
 * build).
 *
 * Surfaces, mirroring `ticketing.ts`:
 *   - PUBLIC, no auth: everything the public /reimburse page needs. A claimant
 *     has NO account — they're identified by their request's secret `token`
 *     (the `rsvps.token` precedent), returned once to their browser, looked up
 *     via `by_token`, and NEVER returned by any in-app list query.
 *   - IN-APP member self-service (auth, NO finance-role gate): a logged-in
 *     member submitting their OWN reimbursement (`submitReimbursement`) and
 *     reading their own history (`myReimbursements`, `newRequestOptions`).
 *     Shares all validation/line-item/receipt/SoD plumbing with the public
 *     path via `createReimbursement` so the two submit surfaces can't drift.
 *   - IN-APP (auth, finance-role gated): the manager approval queue with
 *     separation-of-duties (approver ≠ requester), partial approval, and the
 *     status state machine validated against the shared `REIMBURSEMENT_STATUSES`
 *     tuple.
 *   - INTERNAL: a stale-request reminder sweep for a cron (best-effort Resend,
 *     no-op without RESEND_API_KEY — same degrade pattern as `reminders.ts`).
 *
 * INVARIANTS:
 *  - Money is ALWAYS a non-negative INTEGER number of cents (validated here;
 *    the arg validator can't).
 *  - Every table is chapter-scoped; every client-supplied id is verified to
 *    belong to the resolved chapter before use.
 *  - `token` is secret: looked up by `by_token`, never leaked in in-app lists.
 *  - Status transitions are guarded against the current status via explicit
 *    allowed-from sets; reject/cancel are legal only before a payout is in
 *    motion, and approved/paying/terminal requests can't be walked back here.
 *  - ANTI-DOUBLE-COUNT: the reimbursement PAYOUT (a `transfer` transaction) is
 *    Phase 4 — this file NEVER creates transactions. A line's
 *    `matchedTransactionId` (set elsewhere) links it to an already-synced txn.
 *  - `payeeName`/`payeeEmail` are editable display fields, NOT the SoD anchor
 *    (`personId` is). On the authenticated in-app path `identityVerified` is
 *    set, so `list`/`get` also surface the real roster name behind the
 *    override (`verifiedRosterName`) — an approver always sees who's really
 *    asking, even if the display name doesn't match the roster.
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
  REIMBURSEMENT_STATUSES,
  REIMBURSEMENT_STATUS_LABELS,
  EXTERNAL_ACCOUNT_FUNDINGS,
  type ReimbursementStatus,
  type ExternalAccountFunding,
  type BudgetCadence,
} from "@events-os/shared";
import { normalizeEmail, getUserEmail } from "./lib/access";
import {
  requireChapterId,
  requireInChapter,
  getChapterIdOrNull,
} from "./lib/context";
import { viewerPerson } from "./lib/org";
import {
  requireFinanceRole,
  requireFinanceManager,
  resolveCallerPersonId,
  assertSeparationOfDuties,
  defaultFundId,
} from "./lib/finance";
import { assertRoutingNumber, assertAccountNumber } from "./increase";
import { sendEmail, emailShell } from "./ticketingEmails";
import { escapeHtml } from "./lib/html";
import { appUrl, siteUrl } from "./lib/siteUrl";
import {
  gatherForPickerCandidates,
  budgetDisplayNameFor,
  effectiveBudgetType,
} from "./lib/forPickerCandidates";
import { ROLLUP_SCAN_LIMIT, isAttributableBudget } from "./finances";

const externalAccountFundingValidator = v.union(
  ...EXTERNAL_ACCOUNT_FUNDINGS.map((f) => v.literal(f)),
);

// ── Enum validators (built from the shared tuple) ────────────────────────────
const reimbursementStatusValidator = v.union(
  ...REIMBURSEMENT_STATUSES.map((s) => v.literal(s)),
);

/** The submitted line-item shape, shared by the public + in-app submit paths.
 *  Money is a raw `v.number()` here — the integer-cents check is enforced in
 *  `assertLineCents` (an arg validator can't reject a non-integer). Kept
 *  OPTIONAL at the validator level for `receiptStorageId`/`transactionDate`
 *  even though `createReimbursement` requires both for a NEW line — an arg
 *  validator can't express "required except on legacy rows"; the actual gate
 *  is `assertRequiredLineFields` below, the one invariant owner. */
const submitLineValidator = v.object({
  description: v.string(),
  amountCents: v.number(),
  categoryId: v.optional(v.id("budgetCategories")),
  fundId: v.optional(v.id("funds")),
  receiptStorageId: v.optional(v.id("_storage")),
  transactionDate: v.optional(v.number()),
});
type SubmitLine = {
  description: string;
  amountCents: number;
  categoryId?: Id<"budgetCategories">;
  fundId?: Id<"funds">;
  receiptStorageId?: Id<"_storage">;
  transactionDate?: number;
};

// ── Status machine ───────────────────────────────────────────────────────────
/** Statuses a claimant / manager may still edit (add receipts, approve, etc.).
 *  Once past these the request is under final review or finished. */
const EDITABLE_STATUSES: readonly ReimbursementStatus[] = [
  "pending_preapproval",
  "preapproved",
  "submitted",
];

/** Statuses in which a bank DESTINATION may still be (re)linked. The editable
 *  set PLUS `approved`: after a paid→returned ACH bounce, `reverseSettledPayout`
 *  re-opens the reimbursement to `approved`, and most returns (R03/R04) are
 *  wrong-account — the claimant MUST be able to fix the bad bank details that
 *  caused the bounce. The destination is NOT part of what approval reviews
 *  (managers only ever see the last-4), so relinking here changes nothing a
 *  manager approved. Deliberately separate from `EDITABLE_STATUSES` so line-item
 *  edits stay locked once approved. */
const LINKABLE_STATUSES: readonly ReimbursementStatus[] = [
  ...EDITABLE_STATUSES,
  "approved",
];

/** The pre-approval / pre-payout states. `reject` and `cancel` are only legal
 *  from here — never from `approved`/`paying`/terminal, so an in-flight payout
 *  (Phase 4) can't be desynced by a late reject/cancel. */
const PRE_PAYOUT_STATUSES: readonly ReimbursementStatus[] = [
  "pending_preapproval",
  "preapproved",
  "submitted",
];

/** Guard a transition: `current` must be one of `allowedFrom`, else throw. */
function assertTransition(
  current: ReimbursementStatus,
  allowedFrom: readonly ReimbursementStatus[],
  action: string,
): void {
  if (!allowedFrom.includes(current)) {
    throw new ConvexError({
      code: "ILLEGAL_TRANSITION",
      message: `Can't ${action} a reimbursement that's ${REIMBURSEMENT_STATUS_LABELS[current]}.`,
    });
  }
}

// ── Small helpers ────────────────────────────────────────────────────────────

/** A short, human-facing reference derived from the request id (no schema
 *  column needed — the id is stable and unguessable enough for a label). */
function referenceFor(id: Id<"reimbursementRequests">): string {
  return `RB-${String(id).slice(-6).toUpperCase()}`;
}

/** Two-letter avatar initials from a display name. */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0][0] ?? "";
  const last = parts.length > 1 ? parts[parts.length - 1][0] : "";
  return (first + last).toUpperCase() || "?";
}

/** A single line — and the whole request — can't exceed this (integer cents).
 *  A guard against a fat-fingered / abusive amount, not a policy limit. */
const MAX_CENTS = 100_000_000; // $1,000,000

/** Validate a line money amount: a positive integer number of cents, capped. */
function assertLineCents(amountCents: number, label = "Line amount"): void {
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new ConvexError({
      code: "INVALID_AMOUNT",
      message: `${label} must be a whole number of cents greater than 0.`,
    });
  }
  if (amountCents > MAX_CENTS) {
    throw new ConvexError({
      code: "INVALID_AMOUNT",
      message: `${label} is too large.`,
    });
  }
}

/** Trim + hard-cap an untrusted string (anonymous input is unbounded otherwise). */
function cap(value: string, max: number): string {
  return value.trim().slice(0, max);
}

/** Optional trimmed + capped string, or undefined when blank. */
function capOptional(
  value: string | undefined,
  max: number,
): string | undefined {
  if (value === undefined) return undefined;
  const out = cap(value, max);
  return out.length > 0 ? out : undefined;
}

/** A `transactionDate` sanity window: reject anything more than 48h in the
 *  future (clock skew tolerance, not a loophole for post-dating) or older
 *  than 3 years (a receipt that stale isn't a live reimbursement claim). */
const TRANSACTION_DATE_MAX_FUTURE_MS = 48 * 60 * 60 * 1000;
const TRANSACTION_DATE_MAX_PAST_MS = 3 * 365 * 24 * 60 * 60 * 1000;

/** Validate a line's `transactionDate`: REQUIRED, a finite ms timestamp,
 *  within the sanity window above. Every line submitted through
 *  `createReimbursement` goes through this — the single gate for both the
 *  public and in-app surfaces. */
function assertTransactionDate(value: number | undefined, label = "Transaction date"): number {
  if (value === undefined || !Number.isFinite(value)) {
    throw new ConvexError({
      code: "INVALID_INPUT",
      message: `${label} is required.`,
    });
  }
  const now = Date.now();
  if (value > now + TRANSACTION_DATE_MAX_FUTURE_MS) {
    throw new ConvexError({
      code: "INVALID_INPUT",
      message: `${label} can't be in the future.`,
    });
  }
  if (value < now - TRANSACTION_DATE_MAX_PAST_MS) {
    throw new ConvexError({
      code: "INVALID_INPUT",
      message: `${label} is too old — it must be within the last 3 years.`,
    });
  }
  return value;
}

/** The claimant status-timeline for the public page:
 *  Submitted → Under review → Approved → Paid by ACH. */
const TIMELINE_STEPS = [
  { step: "submitted", label: "Submitted" },
  { step: "under_review", label: "Under review" },
  { step: "approved", label: "Approved" },
  { step: "paid", label: "Paid by ACH" },
] as const;

function timelineFor(
  status: ReimbursementStatus,
): Array<{ step: string; label: string; state: "done" | "now" | "todo" }> {
  // `doneThrough` = last step index that's complete; `nowIndex` = the step
  // currently in progress (-1 = none, i.e. finished or terminal-negative).
  let doneThrough = 0;
  let nowIndex = 1;
  switch (status) {
    case "pending_preapproval":
    case "preapproved":
    case "submitted":
      doneThrough = 0;
      nowIndex = 1;
      break;
    case "approved":
    case "paying":
      doneThrough = 2;
      nowIndex = 3;
      break;
    case "paid":
      doneThrough = 3;
      nowIndex = -1;
      break;
    case "rejected":
    case "failed":
    case "canceled":
      doneThrough = 1;
      nowIndex = -1;
      break;
  }
  return TIMELINE_STEPS.map(({ step, label }, i) => ({
    step,
    label,
    state: i <= doneThrough ? "done" : i === nowIndex ? "now" : "todo",
  }));
}

/** Load a request by its secret token (or null). */
async function byToken(
  ctx: QueryCtx,
  token: string,
): Promise<Doc<"reimbursementRequests"> | null> {
  return await ctx.db
    .query("reimbursementRequests")
    .withIndex("by_token", (q) => q.eq("token", token))
    .unique();
}

/** A request's line items, order-sorted. */
async function linesFor(
  ctx: QueryCtx,
  reimbursementId: Id<"reimbursementRequests">,
): Promise<Doc<"reimbursementLineItems">[]> {
  const lines = await ctx.db
    .query("reimbursementLineItems")
    .withIndex("by_reimbursement", (q) =>
      q.eq("reimbursementId", reimbursementId),
    )
    .take(200);
  return lines.sort((a, b) => a.order - b.order);
}

/** Receipts coverage for a set of lines. */
function receiptsState(
  lines: Doc<"reimbursementLineItems">[],
): "complete" | "partial" | "none" {
  if (lines.length === 0) return "none";
  const withReceipt = lines.filter((l) => l.receiptStorageId).length;
  if (withReceipt === 0) return "none";
  if (withReceipt === lines.length) return "complete";
  return "partial";
}

/** Whether the requester reads as core team or a volunteer (for the queue). */
async function requesterType(
  ctx: QueryCtx,
  personId: Id<"people"> | undefined,
): Promise<"team" | "volunteer"> {
  if (!personId) return "volunteer";
  const person = await ctx.db.get(personId);
  return person?.isTeamMember ? "team" : "volunteer";
}

/** A category's display name (or null). */
async function categoryName(
  ctx: QueryCtx,
  categoryId: Id<"budgetCategories"> | undefined,
): Promise<string | null> {
  if (!categoryId) return null;
  const cat = await ctx.db.get(categoryId);
  return cat?.name ?? null;
}

/** A fund's display name (or null). */
async function fundName(
  ctx: QueryCtx,
  fundId: Id<"funds"> | undefined,
): Promise<string | null> {
  if (!fundId) return null;
  const fund = await ctx.db.get(fundId);
  return fund?.name ?? null;
}

/** The request-level "For" tag's display name — the event's or project's own
 *  name, or (WP: recurring budgets) the recurring budget's own display name
 *  (`budgetDisplayNameFor`, e.g. "Education"). Exactly one of the three is
 *  ever set (`createReimbursement`'s mutual-exclusivity check); null when
 *  none were tagged. */
async function forLabel(
  ctx: QueryCtx,
  eventId: Id<"events"> | undefined,
  projectId: Id<"projects"> | undefined,
  budgetId: Id<"budgets"> | undefined,
): Promise<string | null> {
  if (eventId) {
    const event = await ctx.db.get(eventId);
    return event?.name ?? null;
  }
  if (projectId) {
    const project = await ctx.db.get(projectId);
    return project?.name ?? null;
  }
  if (budgetId) {
    const budget = await ctx.db.get(budgetId);
    return budget ? budgetDisplayNameFor(budget) : null;
  }
  return null;
}

/**
 * The real roster identity behind an in-app submission, or null. Only
 * populated when `identityVerified` is set (the authenticated `submitReimbursement`
 * path) — the public path's `personId` is a best-effort phone/email match, not
 * a verified identity, so it's deliberately never surfaced here. Lets the
 * approval queue show both "submitted as" (the editable `payeeName`) and the
 * real, server-derived requester, so an override can't misrepresent who's
 * asking.
 */
async function verifiedRosterName(
  ctx: QueryCtx,
  req: Doc<"reimbursementRequests">,
): Promise<string | null> {
  if (!req.identityVerified || !req.personId) return null;
  const person = await ctx.db.get(req.personId);
  return person?.name ?? null;
}

/** Best-effort match of a public claimant to a chapter roster person, so the
 *  approval flow can enforce separation of duties. Phone first, then email
 *  (the PCO-matching convention). Bounded read of the (small) roster. */
async function matchPerson(
  ctx: MutationCtx,
  chapterId: Id<"chapters">,
  email: string | undefined,
  phone: string | undefined,
): Promise<Id<"people"> | null> {
  if (!email && !phone) return null;
  const nemail = email ? normalizeEmail(email) : null;
  const people = await ctx.db
    .query("people")
    .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
    .take(2000);
  const found = people.find(
    (p) =>
      p.isPlaceholder !== true &&
      ((phone && p.phone && p.phone === phone) ||
        (nemail && p.email && normalizeEmail(p.email) === nemail)),
  );
  return found?._id ?? null;
}

/**
 * The shared create path behind BOTH submit surfaces (public /reimburse form and
 * the in-app member twin). The caller resolves the chapter + the claimant's
 * `personId` its own way (public: slug + best-effort roster match; in-app: the
 * authenticated caller's own roster person) AND a real ACH destination (the
 * `externalAccountId`/`bankAccountLast4` pair, resolved by the CLIENT linking
 * a real bank account BEFORE this ever runs — see `linkPublicBankAccount`/
 * `linkBankAccount` below, both callable with no existing request — then
 * passing the result into `submitPublicReimbursement`/`submitReimbursement`),
 * then hands validated-but-untrusted field values here. This single helper
 * owns EVERY invariant — name/email validation, the REQUIRED purpose, per-line integer-
 * cents + REQUIRED receipt + REQUIRED sanity-checked `transactionDate` +
 * chapter-ownership checks, the total, the REQUIRED bank destination, the
 * mutually-exclusive "For" tag (event XOR project XOR recurring budget), the
 * pre-approval status, and the request+lines insert — so the two surfaces can
 * never drift.
 *
 * `personId` is the SEPARATION-OF-DUTIES anchor: the approval flow compares an
 * approver against `req.personId`, so it must be the real claimant (server-
 * derived), never a client-supplied id.
 */
async function createReimbursement(
  ctx: MutationCtx,
  input: {
    chapterId: Id<"chapters">;
    payeeName: string;
    payeeEmail: string;
    payeePhone?: string;
    purpose: string;
    /** The Increase External Account id this request's payout is addressed
     *  to — resolved by linking a REAL bank account BEFORE this runs (the
     *  public/in-app submit surfaces both call `linkPublicBankAccount`/
     *  `linkBankAccount` first, then pass the resulting id here). REQUIRED:
     *  no request may be created without a full ACH destination (owner
     *  mandate — the last-4/manual path at submit is retired). */
    externalAccountId: string;
    /** The last-4 Increase derived from the SAME account-creation call, for
     *  display — optional (a caller that already has it should pass it, but
     *  its absence never blocks a submission; the real destination is
     *  `externalAccountId`). NEVER a client-typed last-4 (that path is
     *  retired) — this is only ever the digits Increase itself returned. */
    bankAccountLast4?: string;
    requestPreApproval?: boolean;
    personId: Id<"people"> | null;
    /** True only when `personId` is a server-verified identity (the
     *  authenticated in-app path) rather than the public path's best-effort
     *  phone/email match. Drives `identityVerified` on the row. */
    identityVerified?: boolean;
    /** Optional "what this was for" tag — an event, a project, OR a
     *  RECURRING budget, never more than one. Purely informational for
     *  event/project (unlike a transaction's `budgetId`, this never feeds
     *  budget-vs-actual math — see the file's ANTI-DOUBLE-COUNT invariant);
     *  `budgetId` similarly never posts spend against the budget by itself —
     *  it's a label until a finance manager attributes the actual payout. */
    eventId?: Id<"events">;
    projectId?: Id<"projects">;
    budgetId?: Id<"budgets">;
    lines: SubmitLine[];
  },
): Promise<{
  token: string;
  reference: string;
  reimbursementId: Id<"reimbursementRequests">;
}> {
  const { chapterId } = input;

  const payeeName = cap(input.payeeName, 120);
  if (!payeeName) {
    throw new ConvexError({
      code: "INVALID_INPUT",
      message: "A name is required.",
    });
  }
  // Required + format-validated email (mirrors ticketing's check).
  const payeeEmail = normalizeEmail(cap(input.payeeEmail, 254));
  if (!payeeEmail || !payeeEmail.includes("@")) {
    throw new ConvexError({
      code: "INVALID_INPUT",
      message: "A valid email is required.",
    });
  }
  const payeePhone = capOptional(input.payeePhone, 40);

  // The "why" — required, non-blank after trim.
  const purpose = cap(input.purpose, 2000);
  if (!purpose) {
    throw new ConvexError({
      code: "INVALID_INPUT",
      message: "Tell us what this reimbursement is for.",
    });
  }

  // Bank destination — REQUIRED. `createReimbursement` is the single
  // invariant owner: even if a future caller forgets to resolve one first,
  // no row can land without a real Increase External Account. The last-4 is
  // display-only and optional (never required — some callers already have it
  // from the same account-creation call, some don't bother threading it
  // through, and its absence blocks nothing).
  const externalAccountId = input.externalAccountId?.trim();
  const bankAccountLast4 = input.bankAccountLast4?.trim() || undefined;
  if (!externalAccountId) {
    throw new ConvexError({
      code: "BANK_REQUIRED",
      message: "A linked bank account is required to submit a reimbursement.",
    });
  }

  // "For" tag: an event, a project, OR a recurring budget — never more than
  // one. Verify whichever was supplied actually belongs to this chapter
  // (untrusted input must never reference another chapter's ref).
  const forTagCount =
    (input.eventId ? 1 : 0) + (input.projectId ? 1 : 0) + (input.budgetId ? 1 : 0);
  if (forTagCount > 1) {
    throw new ConvexError({
      code: "INVALID_INPUT",
      message: "Pick an event, a project, or a budget — not more than one.",
    });
  }
  if (input.eventId) {
    const event = await ctx.db.get(input.eventId);
    await requireInChapter(ctx, chapterId, event, "Event");
  }
  if (input.projectId) {
    const project = await ctx.db.get(input.projectId);
    await requireInChapter(ctx, chapterId, project, "Project");
  }
  if (input.budgetId) {
    const budget = await ctx.db.get(input.budgetId);
    await requireInChapter(ctx, chapterId, budget, "Budget");
    if (effectiveBudgetType(budget!) !== "recurring") {
      throw new ConvexError({
        code: "INVALID_INPUT",
        message: "That budget isn't a recurring budget.",
      });
    }
  }

  if (input.lines.length === 0 || input.lines.length > 100) {
    throw new ConvexError({
      code: "INVALID_INPUT",
      message: "Add between 1 and 100 line items.",
    });
  }

  // Validate every line: money, a non-blank description, a REQUIRED receipt,
  // a REQUIRED sanity-checked transaction date, + verify any fund/category
  // belongs to this chapter (untrusted input must never reference another
  // chapter).
  for (const line of input.lines) {
    assertLineCents(line.amountCents);
    if (!cap(line.description, 500)) {
      throw new ConvexError({
        code: "INVALID_INPUT",
        message: "Every line needs a description.",
      });
    }
    if (!line.receiptStorageId) {
      throw new ConvexError({
        code: "INVALID_INPUT",
        message: "Every line needs a receipt.",
      });
    }
    assertTransactionDate(line.transactionDate);
    if (line.fundId) {
      const fund = await ctx.db.get(line.fundId);
      if (!fund || fund.chapterId !== chapterId) {
        throw new ConvexError({
          code: "INVALID_INPUT",
          message: "That fund isn't part of this chapter.",
        });
      }
    }
    if (line.categoryId) {
      const cat = await ctx.db.get(line.categoryId);
      if (!cat || cat.chapterId !== chapterId) {
        throw new ConvexError({
          code: "INVALID_INPUT",
          message: "That category isn't part of this chapter.",
        });
      }
    }
  }

  const totalCents = input.lines.reduce((sum, l) => sum + l.amountCents, 0);
  if (totalCents > MAX_CENTS) {
    throw new ConvexError({
      code: "INVALID_AMOUNT",
      message: "That total is too large.",
    });
  }

  const now = Date.now();
  const token = crypto.randomUUID();
  const status: ReimbursementStatus = input.requestPreApproval
    ? "pending_preapproval"
    : "submitted";

  const reimbursementId = await ctx.db.insert("reimbursementRequests", {
    chapterId,
    token,
    status,
    payeeName,
    payeeEmail,
    payeePhone,
    personId: input.personId ?? undefined,
    identityVerified: input.identityVerified === true ? true : undefined,
    purpose,
    eventId: input.eventId,
    projectId: input.projectId,
    budgetId: input.budgetId,
    totalCents,
    externalAccountId,
    bankAccountLast4,
    submittedAt: now,
    createdAt: now,
    updatedAt: now,
  });

  // Silently default a line's fund to the chapter's General Fund when neither
  // the client nor the public reimburse page's category auto-fill (see
  // `reimbursePage.ts`) supplied one — funds are backend-only (see WP-1.4),
  // so no line should ever land fund-less. Resolved once; every fund-less
  // line in this request shares the chapter's one fund.
  const needsFallback = input.lines.some((l) => !l.fundId);
  const fallbackFundId = needsFallback
    ? (await defaultFundId(ctx, chapterId)) ?? undefined
    : undefined;

  for (let i = 0; i < input.lines.length; i++) {
    const line = input.lines[i];
    await ctx.db.insert("reimbursementLineItems", {
      chapterId,
      reimbursementId,
      description: cap(line.description, 500),
      amountCents: line.amountCents,
      fundId: line.fundId ?? fallbackFundId,
      categoryId: line.categoryId,
      receiptStorageId: line.receiptStorageId,
      transactionDate: line.transactionDate,
      order: i,
      createdAt: now,
    });
  }

  return { token, reference: referenceFor(reimbursementId), reimbursementId };
}

// ── PUBLIC: accountless submission + status (back the /reimburse page) ────────

/**
 * Rate limit for the anonymous `submitPublicReimbursement` write. It's an
 * unauthenticated, no-CAPTCHA endpoint (only reachable indirectly, via the
 * `/api/reimburse/submit` httpAction in `lib/reimburseApiRoutes.ts`, which
 * forwards the caller's IP), so absent a limiter it's spammable. Keyed
 * independently by IP (`"ip:<address>"`) and by the normalized payee email
 * (`"email:<address>"`) — either signal alone trips the limiter, so a script
 * rotating one but not the other still gets caught.
 *
 * THRESHOLD: 5 submissions / rolling hour / key. Chosen to comfortably cover a
 * legitimate claimant filing a few separate requests in one sitting (e.g.
 * splitting receipts across trips) while making a spam run economically
 * pointless — a bot would need to rotate BOTH a fresh IP and a fresh email
 * every 5 requests to keep writing. Tune here if real usage disagrees.
 */
const SUBMIT_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const SUBMIT_RATE_LIMIT_MAX = 5;

/**
 * Rate limit for the pre-submit public receipt-upload endpoint
 * (`preSubmitUploadUrl`, backing `/api/reimburse/pre-upload-url`) — the SAME
 * `reimbursementSubmitAttempts` table + `by_key_and_time` mechanism as the
 * submit limiter above, keyed independently (`"upload_ip:<address>"`) so
 * uploading several lines' receipts ahead of ONE submission doesn't burn the
 * submit budget. Threshold is looser than submit's (a single request can
 * carry up to 100 lines, each needing its own upload call) but still bounded
 * — an unauthenticated, no-CAPTCHA endpoint left unlimited is spammable.
 */
const UPLOAD_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const UPLOAD_RATE_LIMIT_MAX = 40;

/**
 * Rate limit for resolving a bank destination with NO existing reimbursement
 * (the public `linkPublicBankAccount` called with no `token` — the pre-submit
 * "link first" step the public reimburse page's httpAction now performs).
 * Same shared mechanism, its own key prefix (`"banklink_ip:<address>"`) so it
 * never competes with submit's own budget — a real Increase API call is the
 * most expensive thing this file does, so it gets its own (still generous)
 * cap rather than none at all.
 */
const BANK_LINK_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const BANK_LINK_RATE_LIMIT_MAX = 20;

/** Throw `RATE_LIMITED` if `key` already hit `max` within `windowMs`. Cheap:
 *  one indexed range query, bounded to `max` rows. */
async function assertNotRateLimited(
  ctx: MutationCtx,
  key: string,
  max: number,
  windowMs: number,
): Promise<void> {
  const windowStart = Date.now() - windowMs;
  const recent = await ctx.db
    .query("reimbursementSubmitAttempts")
    .withIndex("by_key_and_time", (q) =>
      q.eq("key", key).gte("createdAt", windowStart),
    )
    .take(max);
  if (recent.length >= max) {
    throw new ConvexError({
      code: "RATE_LIMITED",
      message:
        "Too many reimbursement requests submitted recently. Please try again in a bit.",
    });
  }
}

/** Record one successful attempt against a rate-limit key. */
async function recordAttempt(ctx: MutationCtx, key: string): Promise<void> {
  // Swept daily by maintenance.sweepRateLimitAttempts (crons.ts) once older
  // than the relevant window.
  await ctx.db.insert("reimbursementSubmitAttempts", {
    key,
    createdAt: Date.now(),
  });
}

/** The submit-specific rate limit (see `SUBMIT_RATE_LIMIT_MAX`'s doc). */
async function assertSubmitNotRateLimited(
  ctx: MutationCtx,
  key: string,
): Promise<void> {
  await assertNotRateLimited(ctx, key, SUBMIT_RATE_LIMIT_MAX, SUBMIT_RATE_LIMIT_WINDOW_MS);
}

/**
 * Create the ONE Increase External Account behind every "resolve a real ACH
 * destination" step in this file, from ALREADY-VALIDATED routing/account
 * digits (callers validate via `assertRoutingNumber`/`assertAccountNumber`
 * themselves — see `linkPublicBankAccount`/`linkBankAccount` below, which
 * validate up front, BEFORE any query/network call, so a malformed number
 * fails fast without touching either). Never persists the raw account number
 * — only the returned reference id + last-4 is the caller's job to store.
 */
async function createExternalAccountRaw(
  ctx: ActionCtx,
  args: {
    routingNumber: string;
    accountNumber: string;
    accountHolderName: string;
    funding?: ExternalAccountFunding;
  },
): Promise<{ externalAccountId: string; last4: string } | null> {
  return await ctx.runAction(internal.increase.createExternalAccount, {
    routingNumber: args.routingNumber,
    accountNumber: args.accountNumber,
    accountHolderName: (args.accountHolderName.trim() || "Reimbursement payee").slice(
      0,
      200,
    ),
    funding: args.funding ?? "checking",
  });
}

/**
 * Submit a reimbursement from the public form. No auth — the chapter is
 * resolved by its `slug`. Generates a secret `token` (returned once) and a
 * short human reference. Inserts the request + its order-indexed line items.
 * Status is `pending_preapproval` when pre-approval is requested, else
 * `submitted`. `totalCents` is the integer-cents sum of the lines.
 *
 * A plain MUTATION: the caller (the `/api/reimburse/submit` httpAction)
 * ORCHESTRATES — it calls `linkPublicBankAccount` (an action, no token) FIRST
 * to create a real Increase External Account from the posted routing/
 * account/type, THEN calls this mutation with the resulting
 * `externalAccountId`/last-4. `externalAccountId` is REQUIRED here —
 * `createReimbursement` is the single invariant owner and rejects a missing
 * one regardless of caller (owner mandate; the last-4/manual path at submit
 * is retired).
 *
 * `payeeEmail` is REQUIRED + format-validated: it's the claimant's contact for
 * the reminder cron, and (normalized) one half of the separation-of-duties
 * check the approval flow enforces (a manager can't approve a request bearing
 * their own email). All untrusted strings are trimmed + hard-capped.
 *
 * RATE-LIMITED (see `assertSubmitNotRateLimited` above): checked by IP
 * (`clientIp`, forwarded from the public httpAction — undefined for the
 * authenticated in-app `submitReimbursement` twin, which never calls this
 * limiter) and by normalized email, BEFORE any write. A successful submission
 * records one attempt per key that was checked. Strips any client-supplied
 * `categoryId`/`fundId` off every line — the public form no longer collects
 * either (categorization is a finance manager's review-time job), so a public
 * line is NEVER allowed to self-categorize even if a raw API call tries.
 */
export const submitPublicReimbursement = mutation({
  args: {
    chapterSlug: v.string(),
    payeeName: v.string(),
    payeeEmail: v.string(),
    payeePhone: v.optional(v.string()),
    purpose: v.string(),
    requestPreApproval: v.optional(v.boolean()),
    lines: v.array(submitLineValidator),
    // The ACH destination — resolved by `linkPublicBankAccount` BEFORE this
    // mutation runs (see the httpAction orchestration above). Only the
    // reference id + a display last-4 ever reach Convex — never the raw
    // routing/account numbers.
    externalAccountId: v.string(),
    bankAccountLast4: v.optional(v.string()),
    /** The caller's IP, forwarded by the `/api/reimburse/submit` httpAction
     *  (read from the `x-forwarded-for` request header there — a plain
     *  mutation has no access to request headers itself). Undefined when
     *  called some other way (e.g. directly in tests); the email-keyed check
     *  still applies. */
    clientIp: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ token: string; reference: string }> => {
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
    const chapterId = chapter._id;

    // Rate-limit BEFORE any write. `ipKey` is absent when the caller (or a
    // caller bypassing the httpAction) supplied no IP — the email-keyed check
    // still applies then.
    const ipKey = capOptional(args.clientIp, 100);
    const normalizedEmail = normalizeEmail(cap(args.payeeEmail, 254));
    if (ipKey) await assertSubmitNotRateLimited(ctx, `ip:${ipKey}`);
    if (normalizedEmail) {
      await assertSubmitNotRateLimited(ctx, `email:${normalizedEmail}`);
    }

    // Best-effort roster match anchors separation of duties later. Match on the
    // NORMALIZED email (the same value stored), so an approver whose roster row
    // carries the payee's email is caught.
    const personId = await matchPerson(
      ctx,
      chapterId,
      normalizedEmail ?? undefined,
      capOptional(args.payeePhone, 40),
    );

    const { token, reference } = await createReimbursement(ctx, {
      chapterId,
      payeeName: args.payeeName,
      payeeEmail: args.payeeEmail,
      payeePhone: args.payeePhone,
      purpose: args.purpose,
      externalAccountId: args.externalAccountId,
      bankAccountLast4: args.bankAccountLast4,
      requestPreApproval: args.requestPreApproval,
      personId,
      // Public-page privacy: never let a line self-categorize, even if a raw
      // API call tries to smuggle a categoryId/fundId through.
      lines: args.lines.map((l) => ({
        ...l,
        categoryId: undefined,
        fundId: undefined,
      })),
    });

    // Only record a key that was actually checked above.
    if (ipKey) await recordAttempt(ctx, `ip:${ipKey}`);
    if (normalizedEmail) {
      await recordAttempt(ctx, `email:${normalizedEmail}`);
    }

    return { token, reference };
  },
});

/**
 * Generate a pre-submit receipt-upload URL for the PUBLIC form — no token
 * (the request doesn't exist yet), scoped only by chapter slug. Rate-limited
 * by IP (see `UPLOAD_RATE_LIMIT_MAX`'s doc) so this unauthenticated endpoint
 * can't be hammered. Backs `/api/reimburse/pre-upload-url`: the client
 * uploads each line's receipt here BEFORE calling submit, then includes the
 * returned `storageId` as that line's `receiptStorageId` in the submit
 * payload (receipts now attach BEFORE submit on the public flow — the
 * post-submit, token-scoped `publicUploadUrl`/`attachPublicReceipt` pair below
 * stays for REPLACING a receipt on an already-editable request).
 */
export const preSubmitUploadUrl = mutation({
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
    const ipKey = capOptional(clientIp, 100);
    if (ipKey) {
      await assertNotRateLimited(
        ctx,
        `upload_ip:${ipKey}`,
        UPLOAD_RATE_LIMIT_MAX,
        UPLOAD_RATE_LIMIT_WINDOW_MS,
      );
      await recordAttempt(ctx, `upload_ip:${ipKey}`);
    }
    return await ctx.storage.generateUploadUrl();
  },
});

/** Rate-limit gate for `linkPublicBankAccount` called with NO `token` (see
 *  `BANK_LINK_RATE_LIMIT_MAX`'s doc) — checked + recorded atomically in one
 *  mutation, called from the action BEFORE it spends a real Increase call. */
export const assertBankLinkNotRateLimited = internalMutation({
  args: { clientIp: v.optional(v.string()) },
  handler: async (ctx, { clientIp }) => {
    const ipKey = capOptional(clientIp, 100);
    if (ipKey) {
      await assertNotRateLimited(
        ctx,
        `banklink_ip:${ipKey}`,
        BANK_LINK_RATE_LIMIT_MAX,
        BANK_LINK_RATE_LIMIT_WINDOW_MS,
      );
      await recordAttempt(ctx, `banklink_ip:${ipKey}`);
    }
    return null;
  },
});

/**
 * The AUTHENTICATED in-app twin of the public submit — a logged-in member
 * requesting their own reimbursement. Identity is server-derived: the claimant
 * is ALWAYS the caller's own roster person (`resolveCallerPersonId`), never a
 * client-supplied id, and name/email default to that person + the auth email.
 * `payeeName`/`payeeEmail` are accepted only as editable display overrides (the
 * form pre-fills them); they can't change WHO the request is attributed to, so
 * separation of duties still binds to the real caller.
 *
 * A plain MUTATION: the client LINKS FIRST — calls `linkBankAccount` (an
 * action, no `reimbursementId`) to create a real Increase External Account,
 * then calls this mutation with the resulting `externalAccountId`.
 * `externalAccountId` is REQUIRED here — `createReimbursement` is the single
 * invariant owner and rejects a missing one regardless of caller. Reuses the
 * exact validation, line-item shape, receipt handling, and pre-approval
 * wiring as the public path via `createReimbursement` so the two submit
 * surfaces can't drift.
 */
export const submitReimbursement = mutation({
  args: {
    payeeName: v.optional(v.string()),
    payeeEmail: v.optional(v.string()),
    payeePhone: v.optional(v.string()),
    purpose: v.string(),
    requestPreApproval: v.optional(v.boolean()),
    /** "What this was for" — an event, a project, or a recurring budget,
     *  never more than one. */
    eventId: v.optional(v.id("events")),
    projectId: v.optional(v.id("projects")),
    budgetId: v.optional(v.id("budgets")),
    lines: v.array(submitLineValidator),
    // The ACH destination — resolved by `linkBankAccount` BEFORE this
    // mutation runs. Only the reference id + an optional display last-4 ever
    // reach Convex — never the raw routing/account numbers.
    externalAccountId: v.string(),
    bankAccountLast4: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ reimbursementId: Id<"reimbursementRequests">; reference: string }> => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    // The claimant is the authenticated caller's own roster person (throws
    // NO_PERSON if they have no profile in this chapter yet).
    const personId = await resolveCallerPersonId(ctx, chapterId);
    const person = await ctx.db.get(personId);
    const authEmail = await getUserEmail(ctx);

    // Server-side prefill: a supplied override wins, else the person's own
    // name/email, else the auth email. Never trust the client for identity.
    const payeeName =
      capOptional(args.payeeName, 120) ?? person?.name ?? "";
    const payeeEmail =
      capOptional(args.payeeEmail, 254) ??
      person?.email ??
      authEmail ??
      "";

    const { reference, reimbursementId } = await createReimbursement(ctx, {
      chapterId,
      payeeName,
      payeeEmail,
      payeePhone: args.payeePhone ?? person?.phone,
      purpose: args.purpose,
      externalAccountId: args.externalAccountId,
      bankAccountLast4: args.bankAccountLast4,
      requestPreApproval: args.requestPreApproval,
      eventId: args.eventId,
      projectId: args.projectId,
      budgetId: args.budgetId,
      personId,
      // This IS the authenticated path — `personId` above came from
      // `resolveCallerPersonId`, the caller's own verified roster row.
      identityVerified: true,
      lines: args.lines,
    });
    // No token returned — an authenticated member tracks status in-app via
    // `myReimbursements`, so the public secret never needs to leave the server.
    return { reimbursementId, reference };
  },
});

/** One selectable event/project row for the "For" picker (request-level
 *  `eventId`/`projectId` — see `createReimbursement`'s doc). */
type ForOptionRow = { id: string; label: string };

/** One selectable RECURRING budget row for the "For" picker — display name +
 *  cadence (e.g. "Education" · "yearly") so the UI can render "Education ·
 *  Yearly". */
type ForBudgetOptionRow = { id: string; label: string; cadence: BudgetCadence };

/**
 * The chapter's BUDGET-BACKED events/projects + its own approved recurring
 * budgets, for the request form's optional "For" picker — request-level
 * `eventId`/`projectId`/`budgetId`, mutually exclusive (see
 * `createReimbursement`'s doc). NOT the `finances.forPickerOptions`
 * transaction-attribution picker (that one is finance-role-gated and also
 * includes central-level recurring budgets) — this one is open to any
 * chapter member tagging their OWN request, but still only offers a ref/
 * budget that's actually attributable (`isAttributableBudget`: has a real,
 * APPROVED budget) — an unbudgeted event/project is silently omitted, same
 * "no fabricated attribution" rule the transaction picker enforces. Recurring
 * budgets are scoped to `level === "chapter"` ONLY — a central-level
 * recurring budget (the org's own City Launch Fund line items) is never
 * offered here; a chapter member's reimbursement can only tag their OWN
 * chapter's recurring budget. Reuses `gatherForPickerCandidates`'s scan for
 * the same dated labels + one-budget-per-ref dedup.
 */
async function forRequestOptions(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
): Promise<{ events: ForOptionRow[]; projects: ForOptionRow[]; budgets: ForBudgetOptionRow[] }> {
  const { candidates } = await gatherForPickerCandidates(ctx, chapterId, ROLLUP_SCAN_LIMIT);
  return {
    events: candidates.flatMap((c) =>
      c.refKind === "event" && isAttributableBudget(c.budget)
        ? [{ id: c.refId, label: c.label }]
        : [],
    ),
    projects: candidates.flatMap((c) =>
      c.refKind === "project" && isAttributableBudget(c.budget)
        ? [{ id: c.refId, label: c.label }]
        : [],
    ),
    budgets: candidates.flatMap((c) => {
      if (c.refKind !== "recurring" || c.level !== "chapter") return [];
      if (!isAttributableBudget(c.budget)) return [];
      return [
        { id: c.budget._id, label: budgetDisplayNameFor(c.budget), cadence: c.budget.cadence },
      ];
    }),
  };
}

/**
 * Display data for the in-app "Request a reimbursement" form: the caller's own
 * name/email/phone prefill (the SAME values `submitReimbursement` would default
 * to, so the form never shows something different from what actually gets
 * submitted), the chapter's active funds for the fund picker, and its
 * events/projects for the optional "For" picker. Deliberately has NO
 * finance-role gate (unlike `finances.listFunds`/`forPickerOptions`) — any
 * authenticated chapter member needs this to submit their own reimbursement,
 * whether or not they hold a finance grant. Degrades to empty/blank rather
 * than throwing when the caller has no chapter yet — `submitReimbursement` is
 * the real gate.
 */
export const newRequestOptions = query({
  args: {},
  handler: async (ctx) => {
    const chapterId = await getChapterIdOrNull(ctx);
    if (!chapterId) {
      return {
        defaultPayeeName: "",
        defaultPayeeEmail: "",
        defaultPayeePhone: "",
        funds: [],
        forOptions: { events: [], projects: [], budgets: [] },
      };
    }
    const person = await viewerPerson(ctx, chapterId as Id<"chapters">);
    const authEmail = await getUserEmail(ctx);
    const funds = await ctx.db
      .query("funds")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId as Id<"chapters">))
      .take(200);
    return {
      defaultPayeeName: person?.name ?? "",
      defaultPayeeEmail: person?.email ?? authEmail ?? "",
      defaultPayeePhone: person?.phone ?? "",
      funds: funds
        .filter((f) => f.isActive !== false)
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((f) => ({ id: f._id, name: f.name })),
      forOptions: await forRequestOptions(ctx, chapterId as Id<"chapters">),
    };
  },
});

/**
 * The caller's own reimbursement requests (no finance role required) — backs
 * the "My reimbursements" list on the member dashboard. Scoped to the caller's
 * own roster person via `by_person`; NEVER returns another member's requests
 * or the secret `token`. Degrades to `[]` when the caller has no chapter or no
 * roster row yet, rather than throwing (this is a passive dashboard read).
 */
export const myReimbursements = query({
  args: {},
  handler: async (ctx) => {
    const chapterId = await getChapterIdOrNull(ctx);
    if (!chapterId) return [];
    const person = await viewerPerson(ctx, chapterId as Id<"chapters">);
    if (!person) return [];

    const requests = await ctx.db
      .query("reimbursementRequests")
      .withIndex("by_person", (q) => q.eq("personId", person._id))
      .order("desc")
      .take(50);

    return await Promise.all(
      requests
        .filter((r) => r.chapterId === chapterId)
        .map(async (req) => {
          const lines = await linesFor(ctx, req._id);
          return {
            _id: req._id,
            reference: referenceFor(req._id),
            submittedDate: req.submittedAt ?? req.createdAt,
            lineItemCount: lines.length,
            receiptsState: receiptsState(lines),
            status: req.status,
            statusBadge: REIMBURSEMENT_STATUS_LABELS[req.status],
            totalCents: req.totalCents,
            approvedCents: req.approvedCents,
          };
        }),
    );
  },
});

/**
 * The claimant's status view for the public page — keyed by the secret token,
 * NO secrets returned (never the token). Null when the token is unknown.
 */
export const getPublicReimbursement = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const req = await byToken(ctx, token);
    if (!req) return null;
    const lines = await linesFor(ctx, req._id);
    return {
      reference: referenceFor(req._id),
      status: req.status,
      statusLabel: REIMBURSEMENT_STATUS_LABELS[req.status],
      payeeName: req.payeeName,
      totalCents: req.totalCents,
      approvedCents: req.approvedCents,
      lines: await Promise.all(
        lines.map(async (l) => ({
          description: l.description,
          amountCents: l.amountCents,
          category: await categoryName(ctx, l.categoryId),
          hasReceipt: !!l.receiptStorageId,
        })),
      ),
      submittedAt: req.submittedAt ?? req.createdAt,
      timeline: timelineFor(req.status),
    };
  },
});

/**
 * Generate a receipt-upload URL for an accountless claimant. Valid only while
 * the request is still editable (pre-approval / submitted); rejected once it's
 * under final review, paid, or otherwise terminal.
 */
export const publicUploadUrl = mutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const req = await byToken(ctx, token);
    if (!req) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "We couldn't find that reimbursement.",
      });
    }
    if (!EDITABLE_STATUSES.includes(req.status)) {
      throw new ConvexError({
        code: "NOT_EDITABLE",
        message: "This reimbursement can no longer be edited.",
      });
    }
    return await ctx.storage.generateUploadUrl();
  },
});

/**
 * Attach an uploaded receipt to one of the claimant's own lines (token-scoped).
 * Valid only while the request is still editable.
 */
export const attachPublicReceipt = mutation({
  args: {
    token: v.string(),
    lineId: v.id("reimbursementLineItems"),
    receiptStorageId: v.id("_storage"),
  },
  handler: async (ctx, { token, lineId, receiptStorageId }) => {
    const req = await byToken(ctx, token);
    if (!req) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "We couldn't find that reimbursement.",
      });
    }
    if (!EDITABLE_STATUSES.includes(req.status)) {
      throw new ConvexError({
        code: "NOT_EDITABLE",
        message: "This reimbursement can no longer be edited.",
      });
    }
    const line = await ctx.db.get(lineId);
    if (!line || line.reimbursementId !== req._id) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "That line item isn't part of this reimbursement.",
      });
    }
    await ctx.db.patch(lineId, { receiptStorageId });
    await ctx.db.patch(req._id, { updatedAt: Date.now() });
    return null;
  },
});

// ── ACH destination capture (link a REAL bank account for payout) ────────────

/** Shared arg shape for linking a real bank account — full routing + account
 *  number (validated, never persisted raw) + an optional display name/funding
 *  type override. */
const linkBankAccountArgs = {
  routingNumber: v.string(),
  accountNumber: v.string(),
  accountHolderName: v.optional(v.string()),
  funding: v.optional(externalAccountFundingValidator),
};

/** A request must still be in a LINKABLE status (editable OR `approved`) to
 *  (re)link its destination — `approved` is included so a claimant can fix bad
 *  bank details after a bounce re-opens it. Throws when missing/not linkable. */
function assertLinkable(
  req: Doc<"reimbursementRequests"> | null,
): Doc<"reimbursementRequests"> {
  if (!req) {
    throw new ConvexError({
      code: "NOT_FOUND",
      message: "We couldn't find that reimbursement.",
    });
  }
  if (!LINKABLE_STATUSES.includes(req.status)) {
    throw new ConvexError({
      code: "NOT_EDITABLE",
      message: "This reimbursement can no longer be edited.",
    });
  }
  return req;
}

/** Patch a reimbursement's captured ACH destination once the Increase External
 *  Account exists. A re-link replaces the prior destination (the latest one
 *  wins) — e.g. a claimant fixing a typo'd account before it's paid. */
export const attachExternalAccount = internalMutation({
  args: {
    reimbursementId: v.id("reimbursementRequests"),
    externalAccountId: v.string(),
    last4: v.string(),
  },
  handler: async (ctx, { reimbursementId, externalAccountId, last4 }) => {
    // TOCTOU re-check: `begin*` verified the request was linkable, then a slow
    // `createExternalAccount` ran. Re-verify the request is STILL linkable before
    // stamping a destination — a concurrent pay could have advanced it to
    // `paying`/`paid`, where a late destination change must NOT take. No-op cleanly.
    const req = await ctx.db.get(reimbursementId);
    if (!req || !LINKABLE_STATUSES.includes(req.status)) {
      return null;
    }
    await ctx.db.patch(reimbursementId, {
      externalAccountId,
      bankAccountLast4: last4,
      updatedAt: Date.now(),
    });
    return null;
  },
});

/** Gate + resolve a PUBLIC link target. `token` is OPTIONAL:
 *  - present: must resolve to an existing, still-editable request (the RELINK
 *    path — fixing/replacing an already-submitted request's destination).
 *  - absent: the PRE-submit "no request exists yet" path — no gate beyond
 *    what the caller already validated, just a display-name default (empty,
 *    since there's no payee name to fall back to yet — the action's own
 *    `accountHolderName` argument, or Increase's own fallback, wins).
 *  Returns the fields the action needs (id-or-null + a display-name default). */
export const beginLinkPublicBankAccount = internalQuery({
  args: { token: v.optional(v.string()) },
  handler: async (
    ctx,
    { token },
  ): Promise<{ reimbursementId: Id<"reimbursementRequests"> | null; payeeName: string }> => {
    if (!token) return { reimbursementId: null, payeeName: "" };
    const request = assertLinkable(await byToken(ctx, token));
    return { reimbursementId: request._id, payeeName: request.payeeName };
  },
});

/**
 * Resolve a REAL bank account (routing + account number) as an Increase
 * External Account. `token` is OPTIONAL:
 *  - present: the RELINK path — attaches to that PUBLIC, token-scoped
 *    reimbursement so its payout can be addressed by an actual Increase ACH
 *    transfer. Ownership is proven by the secret `token` (the same precedent
 *    as `attachPublicReceipt`), never a client-supplied id.
 *  - absent: the PRE-submit path — the public reimburse page's
 *    `/api/reimburse/submit` httpAction calls this FIRST (no request exists
 *    yet), then hands the returned `externalAccountId`/`last4` to
 *    `submitPublicReimbursement`. Rate-limited by IP in this mode only (see
 *    `BANK_LINK_RATE_LIMIT_MAX`'s doc) — a real Increase API call is the most
 *    expensive thing this file does.
 *
 * Either way, the raw account number is NEVER persisted in Convex — only the
 * returned reference id + a last-4. BEST-EFFORT: if the Increase call fails
 * or isn't configured, `linked:false` (no `externalAccountId`/`last4`) tells
 * the caller to surface an error rather than proceed — a NEW submission can't
 * exist without this succeeding (owner mandate), while a RELINK attempt
 * simply leaves the request's existing destination untouched.
 */
export const linkPublicBankAccount = action({
  args: { token: v.optional(v.string()), clientIp: v.optional(v.string()), ...linkBankAccountArgs },
  handler: async (
    ctx,
    args,
  ): Promise<{ linked: boolean; externalAccountId?: string; last4?: string }> => {
    const routingNumber = assertRoutingNumber(args.routingNumber);
    const accountNumber = assertAccountNumber(args.accountNumber);

    const prep = await ctx.runQuery(
      internal.reimbursements.beginLinkPublicBankAccount,
      { token: args.token },
    );

    if (!args.token) {
      await ctx.runMutation(internal.reimbursements.assertBankLinkNotRateLimited, {
        clientIp: args.clientIp,
      });
    }

    const created = await createExternalAccountRaw(ctx, {
      routingNumber,
      accountNumber,
      accountHolderName: args.accountHolderName?.trim() || prep.payeeName,
      funding: args.funding,
    });
    if (!created) return { linked: false };

    if (prep.reimbursementId) {
      await ctx.runMutation(internal.reimbursements.attachExternalAccount, {
        reimbursementId: prep.reimbursementId,
        externalAccountId: created.externalAccountId,
        last4: created.last4,
      });
    }
    return { linked: true, externalAccountId: created.externalAccountId, last4: created.last4 };
  },
});

/** Gate + resolve an AUTHENTICATED in-app link target. `reimbursementId` is
 *  OPTIONAL:
 *  - present: the request must exist, still be editable, AND belong to the
 *    CALLER's own verified roster identity — never someone else's (mirrors
 *    `submitReimbursement`'s identity handling).
 *  - absent: the PRE-submit "no request exists yet" path — still requires
 *    auth (a roster person), just resolves a display-name default from it. */
export const beginLinkBankAccount = internalMutation({
  args: { reimbursementId: v.optional(v.id("reimbursementRequests")) },
  handler: async (
    ctx,
    { reimbursementId },
  ): Promise<{ reimbursementId: Id<"reimbursementRequests"> | null; payeeName: string }> => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    const callerPersonId = await resolveCallerPersonId(ctx, chapterId);
    if (!reimbursementId) {
      const person = await ctx.db.get(callerPersonId);
      return { reimbursementId: null, payeeName: person?.name ?? "" };
    }
    const req = await ctx.db.get(reimbursementId);
    await requireInChapter(ctx, chapterId, req, "Reimbursement");
    const request = assertLinkable(req);
    if (!request.identityVerified || request.personId !== callerPersonId) {
      throw new ConvexError({
        code: "FORBIDDEN",
        message: "You can only link a bank account to your own reimbursement.",
      });
    }
    return { reimbursementId: request._id, payeeName: request.payeeName };
  },
});

/**
 * Resolve a REAL bank account to (optionally) the CALLER'S OWN in-app
 * reimbursement — the authenticated twin of `linkPublicBankAccount`. Same
 * "either RELINK an existing request or PRE-resolve before one exists" split
 * (`reimbursementId` optional), same Increase External Account creation, same
 * "never persist the raw account number" contract, and the same best-effort
 * `{linked}` degrade — the CALLER (`submitReimbursement` on the pre-submit
 * path) decides whether a `linked:false` blocks a new submission.
 */
export const linkBankAccount = action({
  args: { reimbursementId: v.optional(v.id("reimbursementRequests")), ...linkBankAccountArgs },
  handler: async (
    ctx,
    args,
  ): Promise<{ linked: boolean; externalAccountId?: string; last4?: string }> => {
    const routingNumber = assertRoutingNumber(args.routingNumber);
    const accountNumber = assertAccountNumber(args.accountNumber);

    const prep = await ctx.runMutation(internal.reimbursements.beginLinkBankAccount, {
      reimbursementId: args.reimbursementId,
    });

    const created = await createExternalAccountRaw(ctx, {
      routingNumber,
      accountNumber,
      accountHolderName: args.accountHolderName?.trim() || prep.payeeName,
      funding: args.funding,
    });
    if (!created) return { linked: false };

    if (prep.reimbursementId) {
      await ctx.runMutation(internal.reimbursements.attachExternalAccount, {
        reimbursementId: prep.reimbursementId,
        externalAccountId: created.externalAccountId,
        last4: created.last4,
      });
    }
    return { linked: true, externalAccountId: created.externalAccountId, last4: created.last4 };
  },
});

// ── IN-APP: the manager approval queue (auth, chapter-scoped) ─────────────────

/**
 * The approval queue for the caller's chapter. Optional `status` filter uses
 * the `by_chapter_and_status` index. NEVER returns the secret token.
 */
export const list = query({
  args: { status: v.optional(reimbursementStatusValidator) },
  handler: async (ctx, { status }) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireFinanceRole(ctx, chapterId, "viewer");

    const requests = status
      ? await ctx.db
          .query("reimbursementRequests")
          .withIndex("by_chapter_and_status", (q) =>
            q.eq("chapterId", chapterId).eq("status", status),
          )
          .order("desc")
          .take(200)
      : await ctx.db
          .query("reimbursementRequests")
          .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
          .order("desc")
          .take(200);

    return await Promise.all(
      requests.map(async (req) => {
        const lines = await linesFor(ctx, req._id);
        return {
          _id: req._id,
          reference: referenceFor(req._id),
          requesterName: req.payeeName,
          // The real roster name behind an authenticated submission, when it
          // differs from an editable `payeeName` override — null on the
          // public path (no verified identity exists there). See Important #1.
          verifiedRosterName: await verifiedRosterName(ctx, req),
          requesterType: await requesterType(ctx, req.personId),
          avatarInitials: initials(req.payeeName),
          submittedDate: req.submittedAt ?? req.createdAt,
          lineItemCount: lines.length,
          receiptsState: receiptsState(lines),
          status: req.status,
          statusBadge: REIMBURSEMENT_STATUS_LABELS[req.status],
          totalCents: req.totalCents,
          approvedCents: req.approvedCents,
        };
      }),
    );
  },
});

/** One reimbursement + its lines for the detail panel. NO token returned. */
export const get = query({
  args: { reimbursementId: v.id("reimbursementRequests") },
  handler: async (ctx, { reimbursementId }) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    const req = await ctx.db.get(reimbursementId);
    await requireInChapter(ctx, chapterId, req, "Reimbursement");
    await requireFinanceRole(ctx, chapterId, "viewer");
    const request = req!;
    const lines = await linesFor(ctx, request._id);
    return {
      _id: request._id,
      reference: referenceFor(request._id),
      status: request.status,
      statusLabel: REIMBURSEMENT_STATUS_LABELS[request.status],
      payeeName: request.payeeName,
      payeeEmail: request.payeeEmail ?? null,
      payeePhone: request.payeePhone ?? null,
      // See `list` — the verified roster name behind an authenticated
      // submission, or null (including on the public path).
      verifiedRosterName: await verifiedRosterName(ctx, request),
      purpose: request.purpose ?? null,
      forLabel: await forLabel(ctx, request.eventId, request.projectId, request.budgetId),
      requesterType: await requesterType(ctx, request.personId),
      totalCents: request.totalCents,
      approvedCents: request.approvedCents,
      bankAccountLast4: request.bankAccountLast4 ?? null,
      // Whether a real bank account is linked (a real ACH payout is
      // addressable) vs only a bare last-4 (payout degrades to manual).
      hasExternalAccount: !!request.externalAccountId,
      submittedAt: request.submittedAt ?? request.createdAt,
      approvedAt: request.approvedAt ?? null,
      paidAt: request.paidAt ?? null,
      preApprovedByPersonId: request.preApprovedByPersonId ?? null,
      reviewedByPersonId: request.reviewedByPersonId ?? null,
      rejectedReason: request.rejectedReason ?? null,
      lines: await Promise.all(
        lines.map(async (l) => ({
          _id: l._id,
          description: l.description,
          amountCents: l.amountCents,
          // When the purchase happened (required at intake since the owner
          // mandate; null on legacy rows) — approvers read spend timing here.
          transactionDate: l.transactionDate ?? null,
          category: await categoryName(ctx, l.categoryId),
          fund: await fundName(ctx, l.fundId),
          hasReceipt: !!l.receiptStorageId,
          // A signed, servable URL for the stored receipt (image or PDF) — null
          // when there's no receipt OR the stored file has since been deleted.
          // Detail-only (see `list` above): resolving one URL per line here is
          // fine, but `list` covers the whole queue and must not fan out N
          // signed-URL lookups per request.
          receiptUrl: l.receiptStorageId
            ? await ctx.storage.getUrl(l.receiptStorageId)
            : null,
          approved: l.approved ?? null,
          order: l.order,
        })),
      ),
    };
  },
});

/**
 * Load a reimbursement for a manager write: assert it's in the caller's
 * chapter, the caller is a finance manager, and resolve the caller's roster
 * person + auth email (the approver identity SoD compares against the
 * requester, by both).
 */
async function loadForManage(
  ctx: MutationCtx,
  reimbursementId: Id<"reimbursementRequests">,
): Promise<{
  chapterId: Id<"chapters">;
  req: Doc<"reimbursementRequests">;
  callerPersonId: Id<"people">;
  callerEmail: string | null;
}> {
  const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
  const req = await ctx.db.get(reimbursementId);
  await requireInChapter(ctx, chapterId, req, "Reimbursement");
  await requireFinanceManager(ctx, chapterId);
  const callerPersonId = await resolveCallerPersonId(ctx, chapterId);
  const callerEmail = await getUserEmail(ctx);
  return { chapterId, req: req!, callerPersonId, callerEmail };
}

/**
 * Separation of duties for an approval, enforced by TWO independent signals so
 * the check can't be sidestepped:
 *   - the roster link: the approving person is the linked requester, AND
 *   - the email: the approver's own auth email equals the request's payeeEmail
 *     (case-insensitive), which catches "I submitted the public form under my
 *     own email but the roster match didn't link me".
 *
 * RESIDUAL LIMITATION (accepted, not fixed here): a determined insider who
 * submits under a THIRD party's email with their own bank details still passes
 * both checks. That's mitigated by the append-only `approvals` audit trail and
 * the existing `approvalPolicy.requireSecondApproverOverCents` threshold — a
 * second, distinct approver over a dollar amount. Enforcing that second
 * approver is deliberately NOT built now (a later phase); this note is the
 * breadcrumb for it.
 */
function assertApprovalSoD(
  callerPersonId: Id<"people">,
  callerEmail: string | null,
  req: Doc<"reimbursementRequests">,
): void {
  assertSeparationOfDuties(callerPersonId, req.personId);
  const approver = normalizeEmail(callerEmail);
  const payee = normalizeEmail(req.payeeEmail);
  if (approver && payee && approver === payee) {
    throw new ConvexError({
      code: "SOD_VIOLATION",
      message: "The approver must be different from the requester.",
    });
  }
}

/** Record an entry in the append-only approval/audit trail. */
async function recordApproval(
  ctx: MutationCtx,
  chapterId: Id<"chapters">,
  reimbursementId: Id<"reimbursementRequests">,
  action: "preapprove" | "approve" | "reject" | "cancel",
  actorPersonId: Id<"people">,
  note?: string,
): Promise<void> {
  await ctx.db.insert("approvals", {
    chapterId,
    subjectType: "reimbursement",
    subjectId: String(reimbursementId),
    action,
    actorPersonId,
    note,
    createdAt: Date.now(),
  });
}

/** Pre-approve a pending request (separation of duties enforced). */
export const preApprove = mutation({
  args: { reimbursementId: v.id("reimbursementRequests") },
  handler: async (ctx, { reimbursementId }) => {
    const { chapterId, req, callerPersonId, callerEmail } =
      await loadForManage(ctx, reimbursementId);
    assertTransition(req.status, ["pending_preapproval"], "pre-approve");
    assertApprovalSoD(callerPersonId, callerEmail, req);
    await ctx.db.patch(req._id, {
      status: "preapproved",
      preApprovedByPersonId: callerPersonId,
      updatedAt: Date.now(),
    });
    await recordApproval(ctx, chapterId, req._id, "preapprove", callerPersonId);
    return null;
  },
});

/**
 * Approve a submitted / pre-approved request. Supports PARTIAL approval:
 * `approvedLineIds` (default = all lines) flags exactly those lines approved,
 * the rest not, and `approvedCents` becomes the sum of the approved lines.
 * Records the reviewer + approval time. The actual ACH payout is Phase 4.
 */
export const approve = mutation({
  args: {
    reimbursementId: v.id("reimbursementRequests"),
    approvedLineIds: v.optional(v.array(v.id("reimbursementLineItems"))),
  },
  handler: async (ctx, { reimbursementId, approvedLineIds }) => {
    const { chapterId, req, callerPersonId, callerEmail } =
      await loadForManage(ctx, reimbursementId);
    assertTransition(req.status, ["submitted", "preapproved"], "approve");
    assertApprovalSoD(callerPersonId, callerEmail, req);

    const lines = await linesFor(ctx, req._id);
    let approvedSet: Set<string>;
    if (approvedLineIds === undefined) {
      approvedSet = new Set(lines.map((l) => String(l._id)));
    } else {
      // Every id must belong to this reimbursement.
      const lineIds = new Set(lines.map((l) => String(l._id)));
      for (const id of approvedLineIds) {
        if (!lineIds.has(String(id))) {
          throw new ConvexError({
            code: "INVALID_INPUT",
            message: "A line to approve isn't part of this reimbursement.",
          });
        }
      }
      approvedSet = new Set(approvedLineIds.map((id) => String(id)));
    }

    let approvedCents = 0;
    const now = Date.now();
    for (const line of lines) {
      const approved = approvedSet.has(String(line._id));
      await ctx.db.patch(line._id, { approved });
      if (approved) approvedCents += line.amountCents;
    }

    await ctx.db.patch(req._id, {
      status: "approved",
      approvedCents,
      reviewedByPersonId: callerPersonId,
      approvedAt: now,
      updatedAt: now,
    });
    await recordApproval(ctx, chapterId, req._id, "approve", callerPersonId);
    return { approvedCents };
  },
});

/** Reject a non-terminal request with a reason (separation of duties enforced). */
export const reject = mutation({
  args: {
    reimbursementId: v.id("reimbursementRequests"),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, { reimbursementId, reason }) => {
    const { chapterId, req, callerPersonId, callerEmail } =
      await loadForManage(ctx, reimbursementId);
    // Only legal before a payout is in motion — never from approved/paying/
    // terminal, so a Phase-4 ACH payout can't be desynced by a late reject.
    assertTransition(req.status, PRE_PAYOUT_STATUSES, "reject");
    assertApprovalSoD(callerPersonId, callerEmail, req);
    await ctx.db.patch(req._id, {
      status: "rejected",
      rejectedReason: reason,
      updatedAt: Date.now(),
    });
    await recordApproval(
      ctx,
      chapterId,
      req._id,
      "reject",
      callerPersonId,
      reason,
    );
    return null;
  },
});

/** Cancel a non-terminal request (an admin walking it back). */
export const cancel = mutation({
  args: { reimbursementId: v.id("reimbursementRequests") },
  handler: async (ctx, { reimbursementId }) => {
    const { chapterId, req, callerPersonId } = await loadForManage(
      ctx,
      reimbursementId,
    );
    // Same pre-payout window as reject (see above).
    assertTransition(req.status, PRE_PAYOUT_STATUSES, "cancel");
    await ctx.db.patch(req._id, {
      status: "canceled",
      updatedAt: Date.now(),
    });
    await recordApproval(ctx, chapterId, req._id, "cancel", callerPersonId);
    return null;
  },
});

// ── INTERNAL: stale-request reminder sweep (for a cron) ──────────────────────

/** Nudge a request this many days after it lands and still hasn't moved. */
const STALE_DAYS = 5;
const STALE_MS = STALE_DAYS * 24 * 60 * 60 * 1000;

/**
 * Requests in one chapter worth a nudge: still awaiting a manager
 * (`submitted` / `preapproved`) and either older than `olderThanMs` or missing
 * a receipt on a line. Bounded reads, scoped to the chapter + status index.
 */
export const listStaleReimbursements = internalQuery({
  args: {
    chapterId: v.id("chapters"),
    now: v.number(),
    olderThanMs: v.number(),
  },
  handler: async (ctx, { chapterId, now, olderThanMs }) => {
    // For the accountless public-form claimant (below), the reminder link is
    // the server-rendered `/reimburse/<slug>?token=` status page
    // (`http.ts`'s `/reimburse/` route) — needs the chapter's slug, one read
    // for the whole chapter rather than per request.
    const chapter = await ctx.db.get(chapterId);
    const candidates: Doc<"reimbursementRequests">[] = [];
    for (const status of ["submitted", "preapproved"] as const) {
      const rows = await ctx.db
        .query("reimbursementRequests")
        .withIndex("by_chapter_and_status", (q) =>
          q.eq("chapterId", chapterId).eq("status", status),
        )
        .take(200);
      candidates.push(...rows);
    }
    const stale: Array<{
      reference: string;
      payeeName: string;
      payeeEmail: string | null;
      totalCents: number;
      status: ReimbursementStatus;
      missingReceipts: boolean;
      // True only for the authenticated in-app submit path (`personId`
      // server-derived from the caller's own roster row — see the schema
      // doc on `reimbursementRequests.identityVerified`), i.e. the claimant
      // has an app account and can be sent to the in-app Reimbursements tab.
      identityVerified: boolean;
      // The claimant's secret status-page token (`reimburse/` http route) —
      // mailed only to that request's OWN `payeeEmail`, same trust boundary
      // as the token the public submit flow already hands the claimant's
      // browser once. Used for the non-`identityVerified` (accountless) case.
      token: string;
      chapterSlug: string | null;
    }> = [];
    for (const req of candidates) {
      const lines = await linesFor(ctx, req._id);
      const missingReceipts = lines.some((l) => !l.receiptStorageId);
      const isOld = (req.submittedAt ?? req.createdAt) < now - olderThanMs;
      if (!isOld && !missingReceipts) continue;
      stale.push({
        reference: referenceFor(req._id),
        payeeName: req.payeeName,
        payeeEmail: req.payeeEmail ?? null,
        totalCents: req.totalCents,
        status: req.status,
        missingReceipts,
        identityVerified: req.identityVerified === true,
        token: req.token,
        chapterSlug: chapter?.slug ?? null,
      });
    }
    return stale;
  },
});

/**
 * Sweep every chapter's stale reimbursements and email the claimant a nudge.
 * Best-effort Resend — a no-op that only logs when RESEND_API_KEY is unset
 * (mirrors `reminders.ts` / the ticketing emails), so dev + CI never send.
 *
 * The recipient is always the CLAIMANT (`payeeEmail`), never a finance
 * manager — this sweep only nudges the person waiting on their own money.
 * The CTA link is conditional on how they submitted:
 *   - in-app member (`identityVerified`) → their own Reimbursements tab
 *     (`appUrl`, authenticated; null when APP_URL is unset).
 *   - accountless public-form claimant → the server-rendered, no-login
 *     status page at `/reimburse/<chapterSlug>?token=<token>` (`http.ts`'s
 *     `/reimburse/` route + `getPublicReimbursement`), via `siteUrl()` same
 *     as every other guest-facing link in this codebase. Only omitted if the
 *     chapter's slug is somehow missing (shouldn't happen for a chapter that
 *     can receive public submissions in the first place).
 */
export const sendReimbursementReminders = internalAction({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const chapterIds: Id<"chapters">[] = await ctx.runQuery(
      internal.reminders.listChapterIds,
      {},
    );
    for (const chapterId of chapterIds) {
      const stale = await ctx.runQuery(
        internal.reimbursements.listStaleReimbursements,
        { chapterId, now, olderThanMs: STALE_MS },
      );
      for (const r of stale) {
        if (!r.payeeEmail) continue;
        const dollars = `$${(r.totalCents / 100).toFixed(2)}`;
        const reason = r.missingReceipts
          ? "We're still waiting on a receipt for one or more line items."
          : "It's still waiting on a manager to review it.";
        const link = r.identityVerified
          ? appUrl("/finances/reimbursements")
          : r.chapterSlug
            ? `${siteUrl()}/reimburse/${encodeURIComponent(r.chapterSlug)}?token=${encodeURIComponent(r.token)}`
            : null;
        await sendEmail(
          r.payeeEmail,
          `Your reimbursement ${r.reference} is still pending`,
          emailShell(`
          <h1 style="margin:0 0 12px;font-size:24px;line-height:1.2">Reimbursement ${escapeHtml(r.reference)}</h1>
          <p style="margin:0 0 16px;font-family:-apple-system,'Segoe UI',Roboto,sans-serif;font-size:14px;line-height:1.6;color:#7A5A5A">Hi ${escapeHtml(r.payeeName)} — your ${escapeHtml(dollars)} reimbursement is still open. ${reason}</p>
          ${
            link
              ? `<div style="font-family:-apple-system,'Segoe UI',Roboto,sans-serif;font-size:12px;font-weight:600"><a href="${link}" style="color:#fff;background:#D23B3A;text-decoration:none;border:1px solid #D23B3A;border-radius:999px;padding:6px 12px;display:inline-block">View request →</a></div>`
              : ""
          }`),
        );
      }
    }
    return null;
  },
});
