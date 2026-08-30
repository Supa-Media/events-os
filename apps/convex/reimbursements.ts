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
 *     no-op without RESEND_API_KEY — same degrade pattern as `reminders.ts`),
 *     which also fires the ONE-SHOT planned-purchase receipt follow-up for
 *     `preapproved` requests whose planned purchase date has passed.
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
 *  - Every LINE carries its own §274(d) substantiation (expense type, business
 *    purpose, travel route, who ate) — required at submit, validated by the
 *    SHARED `codingFieldProblems` so the public page, the in-app form and the
 *    server can't drift. Per line, not per request, because one request
 *    routinely mixes kinds. Receipts stay HARD-required per line with no
 *    exception path (a reimbursement is a voluntary submission).
 *  - REVIEW IS A CONVERSATION, not a verdict: `requestChanges` sends a request
 *    back to its claimant with a required note (`changes_requested`), they
 *    revise their lines and resubmit (`resubmitPublicReimbursement` /
 *    `resubmitMyReimbursement`), and it lands in front of the reviewer again.
 *    `rejected` stays what it is — final.
 *  - The reimbursement PAYOUT (an `outflow` transaction — the expense itself,
 *    see `increase.ts#postReimbursementSpend`) is Phase 4 — this file NEVER
 *    creates transactions. A line's `matchedTransactionId` links it to an
 *    already-synced txn; nothing writes that field today, so a payout is the
 *    only ledger row a reimbursement ever produces. If a matcher is ever
 *    built, the payout must stop counting as spend for a MATCHED line, or the
 *    already-synced charge and the payout will both hit the budget.
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
  REIMBURSEMENT_TERMINAL_STATUSES,
  EXTERNAL_ACCOUNT_FUNDINGS,
  ATTENDEE_AFFILIATIONS,
  EXPENSE_TYPES,
  EXPENSE_TYPE_LABELS,
  MAX_PURPOSE_LENGTH,
  MIN_PURPOSE_LENGTH,
  formatCents,
  codingFieldProblems,
  type ReimbursementStatus,
  type ExternalAccountFunding,
  type BudgetCadence,
  type AttendeeAffiliation,
  type ExpenseType,
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
  listChapterFinanceManagerPersonIds,
} from "./lib/finance";
import { requireBooksRead } from "./lib/booksAccess";
import { assertRoutingNumber, assertAccountNumber } from "./increase";
import { sendEmail, emailShell } from "./ticketingEmails";
import { emailButtonRow, emailHeading, emailParagraph } from "./lib/emailShell";
import { escapeHtml } from "./lib/html";
import { buildApprovedNotice } from "./lib/reimbursementApprovedEmail";
import { buildPaidNotice } from "./lib/reimbursementPaidEmail";
import { appUrl, siteUrl } from "./lib/siteUrl";
import {
  gatherForPickerCandidates,
  budgetDisplayNameFor,
  effectiveBudgetType,
} from "./lib/forPickerCandidates";
import { ROLLUP_SCAN_LIMIT, isAttributableBudget } from "./finances";
import { codingPolicy } from "./lib/transactionCoding";

const externalAccountFundingValidator = v.union(
  ...EXTERNAL_ACCOUNT_FUNDINGS.map((f) => v.literal(f)),
);

// ── Enum validators (built from the shared tuple) ────────────────────────────
const reimbursementStatusValidator = v.union(
  ...REIMBURSEMENT_STATUSES.map((s) => v.literal(s)),
);

// ── Per-line substantiation (transaction-coding parity, phase 3) ─────────────
// A reimbursement line carries the SAME §274(d) elements a card charge's
// `transactionCodings` row does — expense type, a real business purpose, a
// travel route, who ate — but PER LINE, because one request routinely mixes
// kinds (a fare, a hotel night, and a team dinner). Validation is the SHARED
// `codingFieldProblems`, the same list the in-app form and the public token
// page render, so no surface can disagree with another about what complete
// substantiation is. See `docs/plans/transaction-coding.md` (phase 3).
//
// Reimbursements keep the HARD per-line receipt requirement — no exception
// path (open question 2, default kept): a reimbursement is a VOLUNTARY
// submission, unlike a card charge that already happened and has to be
// substantiated after the fact.

const attendeeValidator = v.object({
  personId: v.optional(v.id("people")),
  name: v.string(),
  affiliation: v.union(...ATTENDEE_AFFILIATIONS.map((a) => v.literal(a))),
});

/** The substantiation block, as a validator fragment — spread into BOTH the
 *  submit-line shape and the revision shape so the two can't drift. Every
 *  field is `v.optional` at the validator level for the same reason
 *  `receiptStorageId`/`transactionDate` are (below): an arg validator can't
 *  express "required, and required differently per expense type". The real
 *  gate is `normalizeLineCoding`, the one invariant owner. */
const lineCodingValidators = {
  expenseType: v.optional(v.union(...EXPENSE_TYPES.map((t) => v.literal(t)))),
  businessPurpose: v.optional(v.string()),
  travelFrom: v.optional(v.string()),
  travelTo: v.optional(v.string()),
  headcount: v.optional(v.number()),
  attendees: v.optional(v.array(attendeeValidator)),
  groupDescription: v.optional(v.string()),
};

type LineAttendee = {
  personId?: Id<"people">;
  name: string;
  affiliation: AttendeeAffiliation;
};

/** The substantiation a caller supplies for one line (untrusted, unvalidated). */
type LineCodingInput = {
  expenseType?: ExpenseType;
  businessPurpose?: string;
  travelFrom?: string;
  travelTo?: string;
  headcount?: number;
  attendees?: LineAttendee[];
  groupDescription?: string;
};

/** The substantiation as STORED on a line — every key always present so the
 *  same object works for an insert AND for a patch: a line retyped from
 *  "meal" to "general" must have its stale headcount/attendees CLEARED, and a
 *  patch only clears a field when the key is there with `undefined`. */
type StoredLineCoding = {
  expenseType: ExpenseType;
  businessPurpose: string;
  travelFrom: string | undefined;
  travelTo: string | undefined;
  headcount: number | undefined;
  attendees: LineAttendee[] | undefined;
  groupDescription: string | undefined;
};

/** The submitted line-item shape, shared by the public + in-app submit paths.
 *  Money is a raw `v.number()` here — the integer-cents check is enforced in
 *  `assertLineCents` (an arg validator can't reject a non-integer). Kept
 *  OPTIONAL at the validator level for `receiptStorageId`/`transactionDate`
 *  even though `createReimbursement` requires both for a NEW line — an arg
 *  validator can't express "required except on legacy rows"; the actual gate
 *  is `assertRequiredLineFields` below, the one invariant owner. Same posture
 *  for the substantiation block (see `lineCodingValidators`). */
const submitLineValidator = v.object({
  description: v.string(),
  amountCents: v.number(),
  categoryId: v.optional(v.id("budgetCategories")),
  fundId: v.optional(v.id("funds")),
  receiptStorageId: v.optional(v.id("_storage")),
  transactionDate: v.optional(v.number()),
  ...lineCodingValidators,
});
type SubmitLine = {
  description: string;
  amountCents: number;
  categoryId?: Id<"budgetCategories">;
  fundId?: Id<"funds">;
  receiptStorageId?: Id<"_storage">;
  transactionDate?: number;
} & LineCodingInput;

/** One line's revised substantiation, on the claimant's resubmission path. */
const reviseLineValidator = v.object({
  lineId: v.id("reimbursementLineItems"),
  ...lineCodingValidators,
});
type ReviseLine = { lineId: Id<"reimbursementLineItems"> } & LineCodingInput;

/**
 * Validate + normalize one line's substantiation. Delegates every REQUIRED
 * check to the shared `codingFieldProblems` and throws the FIRST problem with
 * its stable code — exactly what `lib/transactionCoding.ts#normalizeCodingFields`
 * does for a card charge — so the public page, the in-app form, and the server
 * can never disagree about what a complete coding is. Type-irrelevant fields
 * are dropped: a line retyped from "travel" to "general" must not keep a stale
 * route, and one retyped away from "meal" must not keep a stale attendee list.
 *
 * Deliberately NOT `normalizeCodingFields` itself: that one also carries
 * `travelers`, which `transactionCodings` has and a reimbursement line does
 * not. The VALIDATION — the part that must never drift — is the shared
 * function both call.
 */
function normalizeLineCoding(
  input: LineCodingInput,
  namesMaxHeadcount: number,
  label: string,
): StoredLineCoding {
  if (!input.expenseType) {
    throw new ConvexError({
      code: "EXPENSE_TYPE_REQUIRED",
      message: `${label} needs an expense type — it's what decides which details the IRS requires (a route for travel, who ate for a meal).`,
    });
  }
  const problems = codingFieldProblems(
    {
      expenseType: input.expenseType,
      businessPurpose: input.businessPurpose ?? "",
      travelFrom: input.travelFrom,
      travelTo: input.travelTo,
      headcount: input.headcount,
      attendees: input.attendees?.map((a) => ({
        ...(a.personId ? { personId: a.personId } : {}),
        name: a.name,
        affiliation: a.affiliation,
      })),
      groupDescription: input.groupDescription,
    },
    namesMaxHeadcount,
  );
  if (problems.length > 0) {
    throw new ConvexError({
      code: problems[0].code,
      // Prefixed with the line it belongs to — a request can carry 100 lines,
      // and "a meal needs a headcount" is useless without saying WHICH one.
      message: `${label} — ${problems[0].message}`,
    });
  }
  const isTravelish =
    input.expenseType === "travel" || input.expenseType === "lodging";
  const isMeal = input.expenseType === "meal";
  const attendees = isMeal
    ? input.attendees?.map((a) => ({
        ...(a.personId ? { personId: a.personId } : {}),
        name: a.name.trim(),
        affiliation: a.affiliation,
      }))
    : undefined;
  return {
    expenseType: input.expenseType,
    businessPurpose: input.businessPurpose!.trim(),
    travelFrom: isTravelish ? input.travelFrom?.trim() : undefined,
    travelTo: isTravelish ? input.travelTo?.trim() : undefined,
    headcount: isMeal ? input.headcount : undefined,
    attendees: attendees?.length ? attendees : undefined,
    groupDescription: isMeal
      ? input.groupDescription?.trim() || undefined
      : undefined,
  };
}

/** A short label for a line in an error message ("Snacks for the crew"). */
function lineLabel(description: string, index: number): string {
  const trimmed = description.trim();
  return trimmed ? `"${cap(trimmed, 60)}"` : `Line ${index + 1}`;
}

/**
 * Re-validate a STORED line's substantiation — used on the claimant's
 * resubmission, so a send-back can't be answered by resubmitting the same
 * incomplete record.
 *
 * LEGACY ROWS ARE SKIPPED: a line with no `expenseType` at all predates phase
 * 3 and never had a chance to carry one. That is the same posture
 * `receiptStorageId`/`transactionDate` already take (required for lines
 * created from now on, `v.optional` on the table so history still validates) —
 * the alternative is a revision loop a pre-existing request can never escape.
 */
function assertStoredLineCoding(
  line: Doc<"reimbursementLineItems">,
  namesMaxHeadcount: number,
  index: number,
): void {
  if (!line.expenseType) return;
  normalizeLineCoding(
    {
      expenseType: line.expenseType as ExpenseType,
      businessPurpose: line.businessPurpose,
      travelFrom: line.travelFrom,
      travelTo: line.travelTo,
      headcount: line.headcount,
      attendees: line.attendees as LineAttendee[] | undefined,
      groupDescription: line.groupDescription,
    },
    namesMaxHeadcount,
    lineLabel(line.description, index),
  );
}

// ── Status machine ───────────────────────────────────────────────────────────
/** Statuses a claimant / manager may still edit (add receipts, approve, etc.).
 *  Once past these the request is under final review or finished.
 *  `changes_requested` is the MOST editable of them all — the reviewer sent it
 *  back precisely so the claimant could fix something (see `requestChanges`). */
const EDITABLE_STATUSES: readonly ReimbursementStatus[] = [
  "pending_preapproval",
  "preapproved",
  "submitted",
  "changes_requested",
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
 *  (Phase 4) can't be desynced by a late reject/cancel. Includes
 *  `changes_requested`: a request sitting with its claimant is not payable, but
 *  it must stay cancelable (the claimant gave up / the reviewer killed it) —
 *  a state you can neither finish nor abandon is a leak. */
const PRE_PAYOUT_STATUSES: readonly ReimbursementStatus[] = [
  "pending_preapproval",
  "preapproved",
  "submitted",
  "changes_requested",
];

/** The states a reviewer may act on: approve, or send back for a fix. The
 *  same allowed-from set for both, so "send it back" is always available
 *  wherever "approve" is — the send-back exists to be the SOFTER of the two,
 *  and a reviewer who can only approve or reject reaches for reject.
 *  Deliberately NOT `changes_requested` itself: the ball is with the claimant,
 *  and approving a record its author is mid-revision would approve something
 *  nobody has read. */
const REVIEWABLE_STATUSES: readonly ReimbursementStatus[] = [
  "submitted",
  "preapproved",
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
 *  column needed — the id is stable and unguessable enough for a label).
 *  Exported for `transactionCodings.ts#getForTransaction`'s reimbursement
 *  context block (Finding 1, UX audit 2026-08-12) — the payout txn's own
 *  coding surface needs the SAME reference wording the reimbursement's own
 *  screens already use. */
export function referenceFor(id: Id<"reimbursementRequests">): string {
  return `RB-${String(id).slice(-6).toUpperCase()}`;
}

/**
 * Where to send a CLAIMANT to look at their own request — the one CTA-link
 * split every claimant-facing reimbursement email uses:
 *   - in-app member (`identityVerified`) → their own Reimbursements tab
 *     (`appUrl`, authenticated; null when APP_URL is unset).
 *   - accountless public-form claimant → the server-rendered, no-login status
 *     page at `/reimburse/<chapterSlug>?token=<token>` (`http.ts`'s
 *     `/reimburse/` route + `getPublicReimbursement`), via `siteUrl()` like
 *     every other guest-facing link in this codebase.
 * `null` when neither can be built (no APP_URL, or a chapter with no slug —
 * which shouldn't happen for a chapter that can take public submissions); the
 * callers degrade to a sentence rather than a dead button.
 *
 * Extracted because four separate emails (staleness nag, purchase follow-up,
 * send-back, and the approval notice) were each carrying their own copy of the
 * same conditional, and `reimbursementApprovedNoticeBackfill` needed a fifth.
 */
export function claimantStatusLink(row: {
  identityVerified: boolean;
  chapterSlug: string | null;
  token: string;
}): string | null {
  if (row.identityVerified) return appUrl("/finances/reimbursements");
  if (!row.chapterSlug) return null;
  return `${siteUrl()}/reimburse/${encodeURIComponent(row.chapterSlug)}?token=${encodeURIComponent(row.token)}`;
}

/** The claimant-facing fields the approval notice needs, projected off a
 *  request row + its chapter's slug. Shared by the LIVE payload query below
 *  and `reimbursementApprovedNoticeBackfill`'s paginated sweep, so the two
 *  senders read the same row the same way. Returns `null` for a request that
 *  was never approved — there is no notice to write about it. */
export function approvedNoticeRowFor(
  req: Doc<"reimbursementRequests">,
  chapterSlug: string | null,
) {
  if (req.approvedAt === undefined) return null;
  return {
    reimbursementId: req._id,
    payeeEmail: req.payeeEmail ?? null,
    payeeName: req.payeeName,
    reference: referenceFor(req._id),
    // `approvedCents` is written by `approve` alongside `approvedAt`; the
    // fallback only covers a legacy row approved before partial approval
    // existed, where the whole submitted total was what got approved.
    approvedCents: req.approvedCents ?? req.totalCents,
    totalCents: req.totalCents,
    approvedAt: req.approvedAt,
    status: req.status,
    paidAt: req.paidAt ?? null,
    bankAccountLast4: req.bankAccountLast4 ?? null,
    identityVerified: req.identityVerified === true,
    token: req.token,
    chapterSlug,
  };
}

/**
 * The `payouts` row that actually settled this reimbursement, or `null`.
 *
 * The paid notice quotes the money that MOVED, and the payout document is where
 * that number lives (`lib/reimbursementPaidEmail.ts` explains why the request's
 * own totals are the wrong thing to quote). `payoutId` is stamped by both settle
 * paths, so that is the cheap read; the index scan behind it only covers legacy
 * rows marked paid before `payoutId` was written — bounded, and it prefers a
 * `paid` payout so a stale `returned` attempt can never be mistaken for the one
 * that landed.
 *
 * Shared by the live payload query below and `reimbursementPaidNoticeBackfill`,
 * so both senders price the same email the same way.
 */
export async function settlingPayoutFor(
  ctx: { db: QueryCtx["db"] },
  req: Doc<"reimbursementRequests">,
): Promise<Doc<"payouts"> | null> {
  if (req.payoutId) {
    const byId = await ctx.db.get(req.payoutId);
    if (byId) return byId;
  }
  const candidates = await ctx.db
    .query("payouts")
    .withIndex("by_reimbursement", (q) => q.eq("reimbursementId", req._id))
    .take(20);
  return candidates.find((p) => p.status === "paid") ?? null;
}

/** The claimant-facing fields the PAID notice needs, projected off a request
 *  row + its chapter's slug + the payout that settled it. The twin of
 *  `approvedNoticeRowFor` above, shared by the live payload query and
 *  `reimbursementPaidNoticeBackfill`'s paginated sweep. Returns `null` unless
 *  the row is actually paid AND carries the date the notice is built around —
 *  there is nothing truthful to say otherwise. */
export function paidNoticeRowFor(
  req: Doc<"reimbursementRequests">,
  chapterSlug: string | null,
  payout: Doc<"payouts"> | null,
) {
  if (req.status !== "paid" || req.paidAt === undefined) return null;
  return {
    reimbursementId: req._id,
    payeeEmail: req.payeeEmail ?? null,
    payeeName: req.payeeName,
    reference: referenceFor(req._id),
    // What MOVED. The fallback covers only a legacy paid row with no payout
    // document; every row this app settles has one.
    paidCents: payout?.amountCents ?? req.approvedCents ?? req.totalCents,
    totalCents: req.totalCents,
    paidAt: req.paidAt,
    // `provider` is the honest answer to "how was this sent": an Increase
    // payout is a real ACH credit, `manual` is a treasurer moving money some
    // other way and recording it. `null` = a legacy row with no payout row,
    // where the copy claims nothing about the rail.
    method:
      payout === null
        ? null
        : payout.provider === "increase"
          ? ("ach" as const)
          : ("manual" as const),
    // The payout's own last-4 is where the money actually went; the request's
    // is what the claimant typed. Prefer the payout.
    bankAccountLast4: payout?.bankAccountLast4 ?? req.bankAccountLast4 ?? null,
    identityVerified: req.identityVerified === true,
    token: req.token,
    chapterSlug,
  };
}

/** A ms timestamp as a long human date for email copy (e.g. "July 25, 2026"),
 *  in the team's timezone — mirrors `reminders.ts`'s due-date formatting. */
function formatEmailDate(ts: number): string {
  return new Date(ts).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "America/New_York",
  });
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

/** A `plannedPurchaseDate` sanity window — it's a FORWARD-looking plan (the
 *  claimant hasn't bought yet), so the bounds run the other way from
 *  `transactionDate`'s: reject anything more than 48h in the PAST (clock-skew
 *  tolerance for "buying today", not a loophole for back-dating) or more than
 *  a year out (a plan that far off isn't a live pre-approval ask). */
const PLANNED_DATE_MAX_PAST_MS = 48 * 60 * 60 * 1000;
const PLANNED_DATE_MAX_FUTURE_MS = 365 * 24 * 60 * 60 * 1000;

/** Validate an OPTIONAL `plannedPurchaseDate`: when present, a finite ms
 *  timestamp within the sanity window above. Both submit surfaces funnel
 *  through `createReimbursement`, the single gate. */
function assertPlannedPurchaseDate(
  value: number | undefined,
  label = "Planned purchase date",
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value)) {
    throw new ConvexError({
      code: "INVALID_INPUT",
      message: `${label} isn't a valid date.`,
    });
  }
  const now = Date.now();
  if (value < now - PLANNED_DATE_MAX_PAST_MS) {
    throw new ConvexError({
      code: "INVALID_INPUT",
      message: `${label} can't be in the past.`,
    });
  }
  if (value > now + PLANNED_DATE_MAX_FUTURE_MS) {
    throw new ConvexError({
      code: "INVALID_INPUT",
      message: `${label} must be within the next year.`,
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
    // Sent back for a fix: the ball is with the CLAIMANT, not the reviewer, so
    // review is still the live step — the page's own send-back callout (which
    // carries the note and the revise form) is what says whose move it is.
    case "changes_requested":
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
 *  none were tagged.
 *
 *  `snapshot` is the name captured when a linked event/project was DELETED
 *  (`reimbursementRequests.forLabelSnapshot`). It is the LAST resort, never
 *  the first: a live ref is always re-read, so a rename still shows through
 *  the way it always has, and the snapshot only speaks once the row it
 *  described is gone. Without it a settled reimbursement's "For" went blank
 *  the moment somebody tidied up an old event. */
async function forLabel(
  ctx: QueryCtx,
  eventId: Id<"events"> | undefined,
  projectId: Id<"projects"> | undefined,
  budgetId: Id<"budgets"> | undefined,
  snapshot?: string | undefined,
): Promise<string | null> {
  if (eventId) {
    const event = await ctx.db.get(eventId);
    if (event) return event.name;
  } else if (projectId) {
    const project = await ctx.db.get(projectId);
    if (project) return project.name;
  } else if (budgetId) {
    const budget = await ctx.db.get(budgetId);
    if (budget) return budgetDisplayNameFor(budget);
  }
  return snapshot?.trim() || null;
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
  // Deliberately identity-matching, NOT filtered on `isContactOnly` (person-
  // centric audiences Phase 1): matching a contact-only claimant is SAFER
  // than leaving them unmatched — separation-of-duties binds to a personId,
  // so an unmatched claimant would escape that check entirely rather than
  // being (correctly) treated as a distinct, unprivileged party.
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
 * REQUIRED substantiation (`normalizeLineCoding`) +
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
    /** When the claimant PLANS to make the purchase (ms) — only legal
     *  alongside `requestPreApproval` (a normal submission is for money
     *  already spent). Sanity-checked by `assertPlannedPurchaseDate`; drives
     *  the reminder cron's one-shot receipt follow-up once the date passes. */
    plannedPurchaseDate?: number;
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

  // The org's meal-names threshold (owner decision: 15) — read ONCE for the
  // whole request rather than per line.
  const { namesMaxHeadcount } = await codingPolicy(ctx);

  // Validate every line: money, a non-blank description, a REQUIRED receipt,
  // a REQUIRED sanity-checked transaction date, the REQUIRED substantiation
  // block, + verify any fund/category belongs to this chapter (untrusted input
  // must never reference another chapter). Normalized codings are collected
  // in line order so the insert loop below writes exactly what was validated.
  const codings: StoredLineCoding[] = [];
  for (let i = 0; i < input.lines.length; i++) {
    const line = input.lines[i];
    assertLineCents(line.amountCents);
    if (!cap(line.description, 500)) {
      throw new ConvexError({
        code: "INVALID_INPUT",
        message: "Every line needs a description.",
      });
    }
    // HARD receipt requirement, per line, no exception path — see the
    // substantiation section's note at the top of this file.
    if (!line.receiptStorageId) {
      throw new ConvexError({
        code: "INVALID_INPUT",
        message: "Every line needs a receipt.",
      });
    }
    assertTransactionDate(line.transactionDate);
    codings.push(
      normalizeLineCoding(
        line,
        namesMaxHeadcount,
        lineLabel(line.description, i),
      ),
    );
    if (line.fundId) {
      const fund = await ctx.db.get(line.fundId);
      if (!fund || fund.chapterId !== chapterId) {
        throw new ConvexError({
          code: "INVALID_INPUT",
          message: "That fund isn't part of this chapter.",
        });
      }
    }
    // Categories are ORG-WIDE (2026-08-14) — every chapter's claimants pick
    // from the same list, so existence is the whole check. The FUND above
    // stays chapter-scoped: it's real, restricted money.
    if (line.categoryId) {
      const cat = await ctx.db.get(line.categoryId);
      if (!cat) {
        throw new ConvexError({
          code: "INVALID_INPUT",
          message: "That category doesn't exist.",
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

  // A planned purchase date only makes sense on a pre-approval ask — reject
  // (rather than silently drop) one on a plain submission so a confused
  // caller hears about it instead of losing the date.
  if (input.plannedPurchaseDate !== undefined && !input.requestPreApproval) {
    throw new ConvexError({
      code: "INVALID_INPUT",
      message: "A planned purchase date only applies when asking for pre-approval.",
    });
  }
  const plannedPurchaseDate = assertPlannedPurchaseDate(
    input.plannedPurchaseDate,
  );

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
    plannedPurchaseDate,
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

  // Best-effort "review this" nudge to the chapter's finance approvers — the
  // manager queue is otherwise pull-only, so nobody learns a request landed
  // until they happen to check. Covers BOTH new-request statuses this
  // function can produce: `submitted` (needs `approve`/`reject`) AND
  // `pending_preapproval` (needs `preApprove`, gated by the same
  // `requireFinanceManager` as the others — see `loadForManage`) — same
  // recipient set either way. Scheduled (not awaited inline) so a Resend
  // hiccup can never fail the submission itself; see
  // `sendReimbursementSubmittedEmail`'s own try/catch for the send-side half
  // of that guarantee.
  await ctx.scheduler.runAfter(
    0,
    internal.reimbursements.sendReimbursementSubmittedEmail,
    { reimbursementId },
  );

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
      // The §274(d) block, validated + normalized above (same index).
      ...codings[i],
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

/**
 * Sanitize a PUBLIC-page-supplied `categoryId`: keep it only if it's a real,
 * ACTIVE category belonging to THIS chapter; anything else — another
 * chapter's id, an inactive category, or a string that isn't even a valid id
 * — is dropped SILENTLY, never thrown.
 *
 * Founder decision (verbatim, 2026-08-1x): "i don't see an issue with
 * allowing them to see the buckets and then we can correct it on our end" —
 * the public form now offers a category picker (`chapterForReimburse`'s new
 * `categories` field) and the claimant's pick rides along. But it's a
 * SUGGESTION from an unauthenticated caller, not a decision: a finance
 * manager still corrects it at review if wrong (see `reimbursements.ts#get`'s
 * line projection, unchanged), and this function is what keeps a malformed or
 * retired id from ever reaching a write — SILENTLY, because an unauthenticated
 * form throwing a distinct error for "inactive" vs "not a real id" would make
 * it an oracle for probing category ids. `createReimbursement`'s own per-line
 * check (shared with the AUTHENTICATED path, which SHOULD throw on a bad id —
 * see its own doc) never sees an unsanitized id from this path, because this
 * runs first.
 *
 * The "wrong chapter" clause is gone: categories are org-wide as of
 * 2026-08-14, so every chapter's public form offers — and accepts — the same
 * list. Existence and ACTIVE are what's left.
 */
async function sanitizePublicCategoryId(
  ctx: MutationCtx,
  categoryId: Id<"budgetCategories"> | undefined,
): Promise<Id<"budgetCategories"> | undefined> {
  if (!categoryId) return undefined;
  try {
    const cat = await ctx.db.get(categoryId);
    if (!cat || cat.isActive === false) return undefined;
    return categoryId;
  } catch {
    // Not even a well-formed id for this deployment — same silent drop.
    return undefined;
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
  return await ctx.runAction(internal.increaseExternalAccounts.createExternalAccount, {
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
 * records one attempt per key that was checked.
 *
 * `categoryId` per line is now a SANITIZED SUGGESTION, not a stripped field
 * (founder reversal, 2026-08-1x — see `sanitizePublicCategoryId`'s own doc):
 * `chapterForReimburse` hands the public form the chapter's active
 * categories, and whichever one the claimant picks rides here, but only
 * survives if it's real, active, and belongs to THIS chapter — anything else
 * (another chapter's id, an inactive category, a raw API call trying to
 * smuggle something bogus through) is dropped SILENTLY. `fundId` is still
 * always stripped: there's still no fund picker on this page.
 */
export const submitPublicReimbursement = mutation({
  args: {
    chapterSlug: v.string(),
    payeeName: v.string(),
    payeeEmail: v.string(),
    payeePhone: v.optional(v.string()),
    purpose: v.string(),
    requestPreApproval: v.optional(v.boolean()),
    // When the claimant plans to buy (ms) — pre-approval asks only; see
    // `createReimbursement`'s doc.
    plannedPurchaseDate: v.optional(v.number()),
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

    // THE CATEGORY, SANITIZED — the founder's suggestion-not-decision call
    // (see `sanitizePublicCategoryId`'s own doc). `fundId` stays stripped
    // unconditionally: there's still no fund picker on this page, and funds
    // are backend-only regardless (WP-1.4).
    const sanitizedLines = await Promise.all(
      args.lines.map(async (l) => ({
        ...l,
        categoryId: await sanitizePublicCategoryId(ctx, l.categoryId),
        fundId: undefined,
      })),
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
      plannedPurchaseDate: args.plannedPurchaseDate,
      personId,
      lines: sanitizedLines,
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
    // When the claimant plans to buy (ms) — pre-approval asks only; see
    // `createReimbursement`'s doc.
    plannedPurchaseDate: v.optional(v.number()),
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
      plannedPurchaseDate: args.plannedPurchaseDate,
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
    // The org's coding policy is a RULE, not chapter data — so the form asks
    // for attendee names at exactly the headcount the server requires them
    // at, even on the degraded no-chapter path.
    const { namesMaxHeadcount } = await codingPolicy(ctx);
    if (!chapterId) {
      return {
        defaultPayeeName: "",
        defaultPayeeEmail: "",
        defaultPayeePhone: "",
        funds: [],
        forOptions: { events: [], projects: [], budgets: [] },
        namesMaxHeadcount,
        minPurposeLength: MIN_PURPOSE_LENGTH,
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
      namesMaxHeadcount,
      minPurposeLength: MIN_PURPOSE_LENGTH,
    };
  },
});

/**
 * The caller's own reimbursement requests (no finance role required) — backs
 * the "My reimbursements" list on the member dashboard. Scoped to the caller's
 * own roster person via `by_person`; NEVER returns another member's requests
 * or the secret `token`. Degrades to `[]` when the caller has no chapter or no
 * roster row yet, rather than throwing (this is a passive dashboard read).
 *
 * Carries the reviewer's send-back note + each line's substantiation: on a
 * `changes_requested` request THIS list is the claimant's revise surface (the
 * in-app twin of the public token page), so it has to show what was asked for
 * and what's currently on record.
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
    const { namesMaxHeadcount } = await codingPolicy(ctx);

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
            reviewNote: req.reviewNote ?? null,
            // Whether THIS caller may revise-and-resubmit in the app, decided
            // by the same rule `resubmitMyReimbursement` enforces
            // (`identityVerified`), so the screen can't offer an edit the
            // mutation will refuse.
            //
            // The gap is real and not hypothetical: this list is keyed by
            // `by_person`, and the PUBLIC form best-effort matches a
            // submission to a roster person by email/phone without verifying
            // anyone. Such a request is legitimately the caller's and shows up
            // here, but was never authenticated as theirs, so the resubmit
            // path refuses it. Without this flag the member got a fully
            // editable card whose Resubmit button always threw FORBIDDEN —
            // the worst version, because they'd have retyped everything
            // first. They revise it from the emailed link instead, where the
            // secret token is the proof of identity.
            canReviseInApp: req.identityVerified === true,
            namesMaxHeadcount,
            lines: lines.map((l) => ({
              _id: l._id,
              description: l.description,
              amountCents: l.amountCents,
              hasReceipt: !!l.receiptStorageId,
              expenseType: (l.expenseType as ExpenseType | undefined) ?? null,
              businessPurpose: l.businessPurpose ?? null,
              travelFrom: l.travelFrom ?? null,
              travelTo: l.travelTo ?? null,
              headcount: l.headcount ?? null,
              attendees: (l.attendees as LineAttendee[] | undefined) ?? null,
              groupDescription: l.groupDescription ?? null,
            })),
          };
        }),
    );
  },
});

/**
 * The claimant's status view for the public page — keyed by the secret token,
 * NO secrets returned (never the token). Null when the token is unknown.
 *
 * Carries each line's own substantiation (and its id), because on a
 * `changes_requested` request the page IS the revise form: the accountless
 * claimant has no other surface on which to answer the reviewer's note. Line
 * ids are already token-scoped (`lib/reimburseApiRoutes.ts#linesForToken`
 * hands the same ids to the receipt-attach flow), and everything here is the
 * claimant's own writing.
 */
export const getPublicReimbursement = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const req = await byToken(ctx, token);
    if (!req) return null;
    const lines = await linesFor(ctx, req._id);
    const { namesMaxHeadcount } = await codingPolicy(ctx);
    return {
      reference: referenceFor(req._id),
      status: req.status,
      statusLabel: REIMBURSEMENT_STATUS_LABELS[req.status],
      // The reviewer's send-back note — what the claimant has to fix.
      reviewNote: req.reviewNote ?? null,
      // The org's meal-names threshold, so the form's attendee rows appear at
      // exactly the headcount the SERVER will require them at.
      namesMaxHeadcount,
      minPurposeLength: MIN_PURPOSE_LENGTH,
      payeeName: req.payeeName,
      totalCents: req.totalCents,
      approvedCents: req.approvedCents,
      lines: await Promise.all(
        lines.map(async (l) => ({
          lineId: l._id,
          description: l.description,
          amountCents: l.amountCents,
          category: await categoryName(ctx, l.categoryId),
          hasReceipt: !!l.receiptStorageId,
          // The claimant's own substantiation — null/absent on a legacy line
          // (see `assertStoredLineCoding`'s doc).
          expenseType: (l.expenseType as ExpenseType | undefined) ?? null,
          businessPurpose: l.businessPurpose ?? null,
          travelFrom: l.travelFrom ?? null,
          travelTo: l.travelTo ?? null,
          headcount: l.headcount ?? null,
          attendees: (l.attendees as LineAttendee[] | undefined) ?? null,
          groupDescription: l.groupDescription ?? null,
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

// ── The revision loop (a claimant's answer to a send-back) ───────────────────

/**
 * Apply a claimant's revised substantiation and put the request back in front
 * of the reviewer — the other half of `requestChanges`.
 *
 * WHY only the substantiation is editable here: a send-back says "this record
 * doesn't yet justify the money" ("say which event this served", "receipt must
 * show exact amount"). The claimant answers by rewriting the coding, or by
 * replacing a receipt (the existing attach path, which `changes_requested`
 * keeps open via `EDITABLE_STATUSES`). Amounts and lines deliberately CAN'T
 * move: a resubmission must never silently change what's being claimed under a
 * reviewer who has already seen a number. A wrong amount is a `reject` and a
 * fresh request.
 *
 * Every line is re-validated, not just the edited ones — otherwise a request
 * could be resubmitted with a still-incomplete line the claimant never
 * touched. Legacy lines are skipped (see `assertStoredLineCoding`).
 *
 * Returns to `preapproved` when the request had been pre-approved, else to
 * `submitted` — a pre-approval decision already made isn't undone by a
 * substantiation fix. `submittedAt` deliberately keeps the ORIGINAL submission
 * date: it's when the claimant first asked, and the staleness sweep counts
 * from it.
 */
async function applyRevisionAndResubmit(
  ctx: MutationCtx,
  req: Doc<"reimbursementRequests">,
  edits: ReviseLine[],
): Promise<{ status: ReimbursementStatus }> {
  assertTransition(req.status, ["changes_requested"], "resubmit");

  const lines = await linesFor(ctx, req._id);
  const byId = new Map(lines.map((l) => [String(l._id), l]));
  const { namesMaxHeadcount } = await codingPolicy(ctx);

  for (const edit of edits) {
    const line = byId.get(String(edit.lineId));
    if (!line) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "That line item isn't part of this reimbursement.",
      });
    }
    const coding = normalizeLineCoding(
      edit,
      namesMaxHeadcount,
      lineLabel(line.description, line.order),
    );
    // Every key is present (some `undefined`) so a retype CLEARS what no
    // longer applies — see `StoredLineCoding`.
    await ctx.db.patch(line._id, coding);
    byId.set(String(line._id), { ...line, ...coding });
  }

  const revised = [...byId.values()].sort((a, b) => a.order - b.order);
  revised.forEach((line, i) => assertStoredLineCoding(line, namesMaxHeadcount, i));

  const status: ReimbursementStatus = req.preApprovedByPersonId
    ? "preapproved"
    : "submitted";
  await ctx.db.patch(req._id, {
    status,
    // The note answered is a note gone — the round-by-round history lives in
    // `approvals`, not in a field the claimant now sees stale copy from.
    reviewNote: undefined,
    updatedAt: Date.now(),
  });
  // Tell the approvers it's back: the queue is pull-only, so without this a
  // revision sits exactly as long as the original submission would have.
  await ctx.scheduler.runAfter(
    0,
    internal.reimbursements.sendReimbursementSubmittedEmail,
    { reimbursementId: req._id },
  );
  return { status };
}

/**
 * Resubmit an accountless claimant's sent-back request (token-scoped, the same
 * trust boundary as `attachPublicReceipt`) with their revised per-line
 * substantiation. Backs the public token page's revise form.
 */
export const resubmitPublicReimbursement = mutation({
  args: { token: v.string(), lines: v.array(reviseLineValidator) },
  handler: async (ctx, { token, lines }) => {
    const req = await byToken(ctx, token);
    if (!req) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "We couldn't find that reimbursement.",
      });
    }
    return await applyRevisionAndResubmit(ctx, req, lines);
  },
});

/**
 * The AUTHENTICATED twin: an in-app member resubmitting their OWN sent-back
 * request. Ownership is the same verified-identity check `beginLinkBankAccount`
 * uses — a member may only revise a request that is genuinely theirs, never
 * one whose `personId` was a public-path best-effort match.
 */
export const resubmitMyReimbursement = mutation({
  args: {
    reimbursementId: v.id("reimbursementRequests"),
    lines: v.array(reviseLineValidator),
  },
  handler: async (ctx, { reimbursementId, lines }) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    const callerPersonId = await resolveCallerPersonId(ctx, chapterId);
    const req = await ctx.db.get(reimbursementId);
    await requireInChapter(ctx, chapterId, req, "Reimbursement");
    const request = req!;
    if (!request.identityVerified || request.personId !== callerPersonId) {
      throw new ConvexError({
        code: "FORBIDDEN",
        message: "You can only resubmit your own reimbursement.",
      });
    }
    return await applyRevisionAndResubmit(ctx, request, lines);
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
 *
 * READABLE BY THE WHOLE TEAM since 2026-08-30 (founder decision — the books
 * open to every member). Deciding on a request is untouched and still needs a
 * finance MANAGER plus separation of duties (`loadForManage`); this is the
 * list, not the verdict, and the manager UI's action affordances are gated
 * separately from it.
 *
 * The payload was checked against that widening rather than assumed: it
 * carries a name, an amount, a status, dates, and a receipts-state summary —
 * no bank account, no `externalAccountId`, no last4, and never the secret
 * token. It is therefore no more than the public ledger already prints of a
 * paid reimbursement ("Reimbursement to <name>", with the amount), which is
 * what makes it safe to show the person standing next to the claimant.
 *
 * The individual request (`get`) deliberately did NOT widen with it: that one
 * opens receipts, line items, and the payout trail. A member reads their own
 * through `myReimbursements`.
 */
export const list = query({
  args: { status: v.optional(reimbursementStatusValidator) },
  handler: async (ctx, { status }) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireBooksRead(ctx, chapterId);

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
          // When the claimant plans to buy (pre-approval asks only) — the
          // queue shows it on a pending pre-approval so an approver knows how
          // urgent the decision is.
          plannedPurchaseDate: req.plannedPurchaseDate ?? null,
        };
      }),
    );
  },
});

/**
 * Whether the manager UI should auto-initiate the ACH payout right after
 * `approve` succeeds (`approvalPolicy.autoPayOnApproval`, chapter-scoped).
 * Defaults to ON (`true`) when no policy row exists or the flag is unset — a
 * chapter opts OUT by explicitly setting it `false`. Read by the manager
 * queue (`index.tsx`'s `handleApprove`) to decide whether to follow a
 * successful `approve`/`approve({approvedLineIds})` with
 * `api.increasePayouts.payReimbursement`; the payout call itself stays fully gated
 * (manager role + disbursement SoD) regardless of this flag.
 */
export const autoPayEnabled = query({
  args: {},
  handler: async (ctx) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireFinanceRole(ctx, chapterId, "viewer");
    const policy = await ctx.db
      .query("approvalPolicy")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
      .first();
    return policy?.autoPayOnApproval !== false;
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
      // When the claimant plans to buy (pre-approval asks only; see `list`).
      plannedPurchaseDate: request.plannedPurchaseDate ?? null,
      forLabel: await forLabel(
        ctx,
        request.eventId,
        request.projectId,
        request.budgetId,
        request.forLabelSnapshot,
      ),
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
      // The latest send-back note, while the request is with its claimant —
      // shown to the reviewer too, so a second manager can see what was
      // already asked for rather than asking again.
      reviewNote: request.reviewNote ?? null,
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
          // The §274(d) substantiation this line carries — what the reviewer
          // is actually reviewing (null on a legacy line). Attendee NAMES are
          // internal-only forever (owner decision, 2026-08-08): this read is
          // finance-role gated, and a public ledger renders the headcount +
          // affiliation breakdown in their place, never the names.
          expenseType: (l.expenseType as ExpenseType | undefined) ?? null,
          expenseTypeLabel: l.expenseType
            ? EXPENSE_TYPE_LABELS[l.expenseType as ExpenseType]
            : null,
          businessPurpose: l.businessPurpose ?? null,
          travelFrom: l.travelFrom ?? null,
          travelTo: l.travelTo ?? null,
          headcount: l.headcount ?? null,
          attendees: (l.attendees as LineAttendee[] | undefined) ?? null,
          groupDescription: l.groupDescription ?? null,
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
  // `edit` = a reviewer sending the request BACK for revision — see
  // `requestChanges` for why that literal carries it.
  action: "preapprove" | "approve" | "reject" | "cancel" | "edit",
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
    assertTransition(req.status, REVIEWABLE_STATUSES, "approve");
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
    // Tell the CLAIMANT their money was approved. Until this shipped, approval
    // was the one decision in this whole state machine that reached the person
    // waiting on it through no channel at all: submitting emails the approvers,
    // a send-back emails the claimant, the staleness cron emails the claimant —
    // and the good news, the one they actually want, was silent (founder,
    // 2026-08-14: "we need to make sure people know that their money is coming
    // once it's approved").
    //
    // Scheduled rather than sent inline for the same reason every other notice
    // in this file is: a mutation must not do network I/O, and a Resend hiccup
    // must never fail an approval that has already committed. The send-side
    // half of that guarantee is `sendReimbursementApprovedEmail`'s own
    // try/catch. Deliberately NOT scheduled from `preApprove` (pre-approval is
    // permission to SPEND, not money owed), `reject`, or `cancel`.
    await ctx.scheduler.runAfter(
      0,
      internal.reimbursements.sendReimbursementApprovedEmail,
      { reimbursementId: req._id },
    );
    return { approvedCents };
  },
});

/**
 * Send a request BACK to its claimant with a required note — "receipt must
 * show exact amount", "say which event this served".
 *
 * WHY this exists: until now the only send-back was `reject`, which is
 * terminal and reads as "you lost your money" — so a reviewer facing "almost,
 * fix this one thing" either rejected (harsh, and the claimant has to re-file
 * everything) or approved something under-substantiated. This is the third
 * door, and the same door `transactionCodings.requestChanges` opens for a card
 * charge (`docs/plans/transaction-coding.md`, phase 3).
 *
 * Same authorization bar and same separation of duties as `approve`: a
 * reviewer who can't approve a request can't send it back either, and nobody
 * reviews their own. The note is REQUIRED — "sent back, no explanation" is how
 * a policy stops being followed, and it's the entire content of the email the
 * claimant receives.
 */
export const requestChanges = mutation({
  args: {
    reimbursementId: v.id("reimbursementRequests"),
    note: v.string(),
  },
  handler: async (ctx, { reimbursementId, note }) => {
    const { chapterId, req, callerPersonId, callerEmail } =
      await loadForManage(ctx, reimbursementId);
    assertTransition(req.status, REVIEWABLE_STATUSES, "send back");
    assertApprovalSoD(callerPersonId, callerEmail, req);
    const reviewNote = cap(note, MAX_PURPOSE_LENGTH);
    if (!reviewNote) {
      throw new ConvexError({
        code: "REASON_REQUIRED",
        message:
          "Sending a request back requires a note — the claimant needs to know what would make it approvable.",
      });
    }
    await ctx.db.patch(req._id, {
      status: "changes_requested",
      reviewNote,
      updatedAt: Date.now(),
    });
    // `approvals` has no `request_changes` literal (its schema predates this
    // loop and belongs to the finance foundation, not this file) — `edit` is
    // the one reserved-but-unwired action, and "go edit this" is exactly what
    // a send-back says. The note rides along, so the trail reads round by
    // round. A claimant's RESUBMISSION logs nothing here on purpose: an
    // accountless payee has no `people` row, and `approvals.actorPersonId` is
    // required — a trail that silently skips half its rows would be worse
    // than one that only records decisions.
    await recordApproval(
      ctx,
      chapterId,
      req._id,
      "edit",
      callerPersonId,
      reviewNote,
    );
    await ctx.scheduler.runAfter(
      0,
      internal.reimbursements.sendReimbursementChangesRequestedEmail,
      { reimbursementId: req._id },
    );
    return null;
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
    // `changes_requested` joins the sweep on the SAME staleness window: a
    // request sitting with its claimant is the most stallable state there is
    // (nobody is waiting on it but the person who stopped thinking about it),
    // and the nudge carries the reviewer's note back to them.
    for (const status of ["submitted", "preapproved", "changes_requested"] as const) {
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
      /** The reviewer's send-back note, on a `changes_requested` request —
       *  the nudge repeats what to fix rather than just saying "it's open". */
      reviewNote: string | null;
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
        reviewNote: req.reviewNote ?? null,
        identityVerified: req.identityVerified === true,
        token: req.token,
        chapterSlug: chapter?.slug ?? null,
      });
    }
    return stale;
  },
});

/**
 * `preapproved` requests in one chapter due the ONE-SHOT receipt follow-up:
 * the planned purchase date has passed, NO line has a receipt yet (the
 * claimant hasn't come back with proof of the spend), and the follow-up
 * hasn't already been sent (`purchaseFollowUpSentAt` unset — the exactly-once
 * guard). Same claimant-contact shape as `listStaleReimbursements` above,
 * plus the id so the caller can stamp the send. Bounded reads, scoped to the
 * chapter + status index.
 */
export const listPlannedPurchaseFollowUps = internalQuery({
  args: { chapterId: v.id("chapters"), now: v.number() },
  handler: async (ctx, { chapterId, now }) => {
    // Same one-read-per-chapter slug resolution as `listStaleReimbursements`.
    const chapter = await ctx.db.get(chapterId);
    const rows = await ctx.db
      .query("reimbursementRequests")
      .withIndex("by_chapter_and_status", (q) =>
        q.eq("chapterId", chapterId).eq("status", "preapproved"),
      )
      .take(200);
    const due: Array<{
      reimbursementId: Id<"reimbursementRequests">;
      reference: string;
      payeeName: string;
      payeeEmail: string | null;
      totalCents: number;
      plannedPurchaseDate: number;
      // See `listStaleReimbursements`'s field docs — the same in-app vs
      // accountless CTA-link split.
      identityVerified: boolean;
      token: string;
      chapterSlug: string | null;
    }> = [];
    for (const req of rows) {
      if (req.plannedPurchaseDate === undefined) continue;
      if (req.plannedPurchaseDate >= now) continue;
      if (req.purchaseFollowUpSentAt !== undefined) continue;
      const lines = await linesFor(ctx, req._id);
      // A receipt on ANY line means the claimant is already submitting proof
      // — the follow-up would be noise (the staleness nag still covers a
      // half-receipted request via `missingReceipts` above).
      if (lines.some((l) => l.receiptStorageId)) continue;
      due.push({
        reimbursementId: req._id,
        reference: referenceFor(req._id),
        payeeName: req.payeeName,
        payeeEmail: req.payeeEmail ?? null,
        totalCents: req.totalCents,
        plannedPurchaseDate: req.plannedPurchaseDate,
        identityVerified: req.identityVerified === true,
        token: req.token,
        chapterSlug: chapter?.slug ?? null,
      });
    }
    return due;
  },
});

/** Stamp `purchaseFollowUpSentAt` so the receipt follow-up fires exactly once.
 *  Deliberately does NOT touch `updatedAt` — a cron send isn't a claimant/
 *  manager edit. No-ops (rather than throws) when the request has since moved
 *  on or is already stamped, so a race with a concurrent status change can't
 *  fail the sweep. */
export const markPurchaseFollowUpSent = internalMutation({
  args: { reimbursementId: v.id("reimbursementRequests") },
  handler: async (ctx, { reimbursementId }) => {
    const req = await ctx.db.get(reimbursementId);
    if (!req || req.status !== "preapproved" || req.purchaseFollowUpSentAt !== undefined) {
      return null;
    }
    await ctx.db.patch(reimbursementId, { purchaseFollowUpSentAt: Date.now() });
    return null;
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
 *
 * ALSO runs the ONE-SHOT planned-purchase receipt follow-up per chapter
 * (`listPlannedPurchaseFollowUps`): a `preapproved` request whose planned
 * purchase date has passed with no receipt on any line yet gets a single
 * "submit your receipts" email — stamped (`markPurchaseFollowUpSent`) BEFORE
 * the send, the same at-most-once ordering as `cards.advanceReceiptReminders`,
 * so a crash mid-run can't re-email tomorrow (a lost email is recoverable —
 * the recurring staleness nag above keeps applying afterwards; a double
 * "one-time" nag isn't). Same claimant-only recipient + CTA-link rules.
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
        const reason =
          r.status === "changes_requested"
            ? `A reviewer sent it back for one fix: ${r.reviewNote ?? "open it to see what's needed"}`
            : r.missingReceipts
              ? "We're still waiting on a receipt for one or more line items."
              : "It's still waiting on a manager to review it.";
        const link = claimantStatusLink(r);
        await sendEmail(ctx, {
          to: r.payeeEmail,
          subject: `Your reimbursement ${r.reference} is still pending`,
          html: emailShell(`
          ${emailHeading(`Reimbursement ${escapeHtml(r.reference)}`)}
          ${emailParagraph(`Hi ${escapeHtml(r.payeeName)} — your ${escapeHtml(dollars)} reimbursement is still open. ${reason}`)}
          ${link ? emailButtonRow(link, "View request →") : ""}`),
        });
      }

      // The one-shot planned-purchase receipt follow-up (see the doc above).
      const followUps = await ctx.runQuery(
        internal.reimbursements.listPlannedPurchaseFollowUps,
        { chapterId, now },
      );
      for (const r of followUps) {
        // Stamp FIRST — even a contact-less request is marked, so it can't
        // resurface daily waiting on an email that will never send.
        await ctx.runMutation(
          internal.reimbursements.markPurchaseFollowUpSent,
          { reimbursementId: r.reimbursementId },
        );
        if (!r.payeeEmail) continue;
        const dollars = `$${(r.totalCents / 100).toFixed(2)}`;
        const link = claimantStatusLink(r);
        await sendEmail(ctx, {
          to: r.payeeEmail,
          subject: `Your reimbursement ${r.reference} — time to submit your receipts`,
          html: emailShell(`
          ${emailHeading(`Reimbursement ${escapeHtml(r.reference)}`)}
          ${emailParagraph(`Hi ${escapeHtml(r.payeeName)} — your planned purchase date (${escapeHtml(formatEmailDate(r.plannedPurchaseDate))}) has passed, and your ${escapeHtml(dollars)} pre-approved reimbursement is still waiting on receipts. Submit your receipts to complete the reimbursement.`)}
          ${link ? emailButtonRow(link, "Add receipts →") : ""}`),
        });
      }
    }
    return null;
  },
});

// ── INTERNAL: submission notice to finance approvers ─────────────────────────

/**
 * The recipients + display fields `sendReimbursementSubmittedEmail` needs, or
 * `null` if the request no longer exists (a scheduled job racing a since-
 * canceled/deleted row — shouldn't happen in practice, but the action should
 * degrade rather than throw).
 *
 * Recipients = everyone `listChapterFinanceManagerPersonIds` says can approve
 * in this chapter, MINUS the requester — excluded by BOTH signals
 * `assertApprovalSoD` uses (the roster link `req.personId`, AND a normalized-
 * email match against `req.payeeEmail`), so a manager who also happens to be
 * the claimant is never told to review their own request. Deduped by
 * normalized email (a person could otherwise appear once per qualifying
 * grant/seat, or two roster rows could share one inbox).
 */
export const getReimbursementSubmittedEmailPayload = internalQuery({
  args: { reimbursementId: v.id("reimbursementRequests") },
  handler: async (ctx, { reimbursementId }) => {
    const req = await ctx.db.get(reimbursementId);
    if (!req) return null;
    const chapter = await ctx.db.get(req.chapterId);

    const approverIds = await listChapterFinanceManagerPersonIds(
      ctx,
      req.chapterId,
    );
    if (req.personId) approverIds.delete(req.personId);

    const requesterEmail = normalizeEmail(req.payeeEmail);
    const seenEmails = new Set<string>();
    const recipients: string[] = [];
    for (const personId of approverIds) {
      const person = await ctx.db.get(personId);
      if (!person || person.isPlaceholder === true) continue;
      const email = normalizeEmail(person.email);
      if (!email) continue;
      // Mirrors `assertApprovalSoD`'s second signal: an email match catches
      // "the manager IS the claimant" even when the roster link above missed
      // it (e.g. a public-form submission whose best-effort person-match
      // landed on a different row than the manager's own).
      if (requesterEmail && email === requesterEmail) continue;
      if (seenEmails.has(email)) continue;
      seenEmails.add(email);
      recipients.push(email);
    }

    return {
      recipients,
      reference: referenceFor(req._id),
      payeeName: req.payeeName,
      purpose: req.purpose ?? "",
      totalCents: req.totalCents,
      chapterName: chapter?.name ?? "your chapter",
      // Pre-approval asks only — lets the notice say WHEN the claimant plans
      // to buy, so an approver can gauge how urgent the decision is.
      plannedPurchaseDate: req.plannedPurchaseDate ?? null,
    };
  },
});

/**
 * "New reimbursement to review" — best-effort Resend to every finance
 * approver in the chapter (see `getReimbursementSubmittedEmailPayload`'s
 * recipient logic), scheduled by `createReimbursement` right after a request
 * lands in `submitted` or `pending_preapproval`. The manager queue is
 * otherwise pull-only, so this is the only signal an approver gets that
 * something is waiting on them.
 *
 * Wrapped in a try/catch (mirrors `cards.notifyPersonalChargeFlagged`): this
 * runs off `ctx.scheduler.runAfter(0, …)`, AFTER the submission already
 * committed, so a thrown error here can't undo the submission either way —
 * but letting it throw would still surface as a failed scheduled job in the
 * dashboard for something that's meant to degrade silently (no
 * RESEND_API_KEY in dev, a transient Resend/network failure, zero
 * recipients), so it's swallowed here the same way the sibling does.
 */
export const sendReimbursementSubmittedEmail = internalAction({
  args: { reimbursementId: v.id("reimbursementRequests") },
  handler: async (ctx, { reimbursementId }) => {
    try {
      const payload = await ctx.runQuery(
        internal.reimbursements.getReimbursementSubmittedEmailPayload,
        { reimbursementId },
      );
      if (!payload || payload.recipients.length === 0) return null;

      const dollars = `$${(payload.totalCents / 100).toFixed(2)}`;
      const subject = `New reimbursement to review: ${payload.reference} (${dollars})`;
      const link = appUrl("/finances/reimbursements");
      const forPurpose = payload.purpose
        ? ` for <b>${escapeHtml(payload.purpose)}</b>`
        : "";
      // A pre-approval ask's planned purchase date — tells the approver when
      // the claimant intends to buy, i.e. how urgent the decision is.
      const planned = payload.plannedPurchaseDate
        ? ` They plan to make the purchase on <b>${escapeHtml(formatEmailDate(payload.plannedPurchaseDate))}</b>.`
        : "";
      const html = emailShell(`
        ${emailHeading(`Reimbursement ${escapeHtml(payload.reference)}`)}
        ${emailParagraph(`${escapeHtml(payload.payeeName)} submitted a ${escapeHtml(dollars)} reimbursement${forPurpose} at ${escapeHtml(payload.chapterName)}. It's waiting on your review.${planned}`)}
        ${
          link
            ? emailButtonRow(link, "Review it →")
            : emailParagraph("Review it from the Reimbursements tab in the app.", {
                size: 12,
                margin: "0",
              })
        }`);

      for (const email of payload.recipients) {
        // Per-recipient: `sendEmail` already swallows HTTP-level Resend
        // failures, but a fetch-level exception (DNS, timeout) would
        // otherwise abort the loop and silently skip the remaining
        // recipients. Isolate each send so one bad address can't cost the
        // others their notification.
        try {
          await sendEmail(ctx, { to: email, subject, html });
        } catch (err) {
          console.error(
            "sendReimbursementSubmittedEmail: recipient send failed",
            reimbursementId,
            err,
          );
        }
      }
    } catch (err) {
      console.error(
        "sendReimbursementSubmittedEmail: failed",
        reimbursementId,
        err,
      );
    }
    return null;
  },
});

// ── INTERNAL: send-back notice to the claimant ───────────────────────────────

/**
 * Everything `sendReimbursementChangesRequestedEmail` needs, or `null` when
 * the request no longer exists / has already moved on (a scheduled job racing
 * a resubmission — it should degrade, not throw).
 *
 * The recipient is the CLAIMANT and only the claimant: this email is the whole
 * reason the send-back is softer than a rejection, and it's useless if it
 * doesn't reach the person who has to act. The CTA-link split is the same one
 * `listStaleReimbursements` documents — an in-app member goes to their
 * Reimbursements tab, an accountless payee to their own token status page,
 * which is where the revise form lives.
 */
export const getReimbursementChangesRequestedEmailPayload = internalQuery({
  args: { reimbursementId: v.id("reimbursementRequests") },
  handler: async (ctx, { reimbursementId }) => {
    const req = await ctx.db.get(reimbursementId);
    if (!req || req.status !== "changes_requested") return null;
    const chapter = await ctx.db.get(req.chapterId);
    return {
      payeeEmail: req.payeeEmail ?? null,
      payeeName: req.payeeName,
      reference: referenceFor(req._id),
      totalCents: req.totalCents,
      reviewNote: req.reviewNote ?? "",
      identityVerified: req.identityVerified === true,
      token: req.token,
      chapterSlug: chapter?.slug ?? null,
    };
  },
});

/**
 * "Your reimbursement needs one fix" — best-effort Resend to the claimant,
 * scheduled by `requestChanges`. Wrapped in a try/catch for the same reason
 * `sendReimbursementSubmittedEmail` is: it runs after the decision has already
 * committed, and a missing RESEND_API_KEY (dev/CI) or a transient Resend
 * failure must degrade silently rather than surface as a failed scheduled job.
 */
export const sendReimbursementChangesRequestedEmail = internalAction({
  args: { reimbursementId: v.id("reimbursementRequests") },
  handler: async (ctx, { reimbursementId }) => {
    try {
      const payload = await ctx.runQuery(
        internal.reimbursements.getReimbursementChangesRequestedEmailPayload,
        { reimbursementId },
      );
      if (!payload?.payeeEmail) return null;
      const dollars = `$${(payload.totalCents / 100).toFixed(2)}`;
      const link = claimantStatusLink(payload);
      await sendEmail(ctx, {
        to: payload.payeeEmail,
        subject: `Your reimbursement ${payload.reference} needs a small fix`,
        html: emailShell(`
        ${emailHeading(`Reimbursement ${escapeHtml(payload.reference)}`)}
        ${emailParagraph(`Hi ${escapeHtml(payload.payeeName)} — your ${escapeHtml(dollars)} reimbursement isn't rejected: a reviewer just needs one thing fixed before it can be approved and paid.`)}
        ${emailParagraph(`<b>What to fix:</b> ${escapeHtml(payload.reviewNote)}`)}
        ${
          link
            ? emailButtonRow(link, "Update and resubmit →")
            : emailParagraph(
                "Open your reimbursement to update it and send it back for review.",
                { size: 12, margin: "0" },
              )
        }`),
      });
    } catch (err) {
      console.error(
        "sendReimbursementChangesRequestedEmail: failed",
        reimbursementId,
        err,
      );
    }
    return null;
  },
});

// ── INTERNAL: approval notice to the claimant ────────────────────────────────

/**
 * Everything `sendReimbursementApprovedEmail` needs, or `null` when the request
 * no longer exists / was never approved (a scheduled job racing a deletion —
 * it should degrade, not throw).
 *
 * The recipient is the CLAIMANT and only the claimant, at the address THEY put
 * on the request (`payeeEmail`) — the founder was explicit that this notice
 * goes to "the emails they put in for the reimbursement requests", and that is
 * also the only address an accountless claimant has ever given us.
 * `createReimbursement` requires and format-validates it on both submit
 * surfaces, so a request written by this app always carries one; the schema
 * keeps it optional only for legacy rows, which is why the senders still guard.
 */
export const getReimbursementApprovedEmailPayload = internalQuery({
  args: { reimbursementId: v.id("reimbursementRequests") },
  handler: async (ctx, { reimbursementId }) => {
    const req = await ctx.db.get(reimbursementId);
    if (!req) return null;
    const chapter = await ctx.db.get(req.chapterId);
    return approvedNoticeRowFor(req, chapter?.slug ?? null);
  },
});

/**
 * CLAIM this request's one approval notice, returning whether the claim was
 * ours. `true` is returned at most ONCE in the lifetime of a row.
 *
 * This is the entire idempotency mechanism, and it is a mutation (a Convex
 * transaction) precisely so the read-then-write can't interleave: two senders
 * racing the same row — the live `approve` schedule and an operator running the
 * catch-up backfill in the same minute — both call this first, exactly one gets
 * `true`, and only that one sends. A re-run of the backfill gets `false` for
 * every row it already touched, which is what makes a second execute run a
 * no-op rather than a second mailing.
 *
 * Stamped BEFORE the send, deliberately: the same at-most-once ordering
 * `markPurchaseFollowUpSent` / `cards.advanceReceiptReminders` already use. A
 * crash between the stamp and the send costs one email; the other ordering
 * risks telling somebody twice that their money was approved, which reads as
 * "it was approved twice" and starts a conversation with a treasurer.
 *
 * Refuses a request that was never approved (`approvedAt` unset), so nothing
 * can stamp a row this notice doesn't apply to. Deliberately does NOT touch
 * `updatedAt` — sending a notice isn't a claimant/manager edit.
 */
export const markApprovedNoticeSent = internalMutation({
  args: { reimbursementId: v.id("reimbursementRequests") },
  returns: v.boolean(),
  handler: async (ctx, { reimbursementId }) => {
    const req = await ctx.db.get(reimbursementId);
    if (!req) return false;
    if (req.approvedAt === undefined) return false;
    if (req.approvedNoticeSentAt !== undefined) return false;
    await ctx.db.patch(reimbursementId, { approvedNoticeSentAt: Date.now() });
    return true;
  },
});

/**
 * "Your reimbursement was approved" — best-effort Resend to the claimant,
 * scheduled by `approve`. The copy (and the hard rule that it must not claim
 * money has moved) lives in `lib/reimbursementApprovedEmail.ts`.
 *
 * Claims the send first (`markApprovedNoticeSent`) and returns without mailing
 * when the claim isn't ours, so a re-delivered scheduled job and the catch-up
 * backfill can't both write to the same claimant.
 *
 * Wrapped in a try/catch for the same reason its two siblings are: it runs
 * after the approval has already committed, and a missing RESEND_API_KEY
 * (dev/CI) or a transient Resend failure must degrade silently rather than
 * surface as a failed scheduled job.
 */
export const sendReimbursementApprovedEmail = internalAction({
  args: { reimbursementId: v.id("reimbursementRequests") },
  handler: async (ctx, { reimbursementId }) => {
    try {
      const payload = await ctx.runQuery(
        internal.reimbursements.getReimbursementApprovedEmailPayload,
        { reimbursementId },
      );
      if (!payload) return null;
      // Claim even when there's no address to mail: a contact-less legacy row
      // must not sit in the backfill's backlog forever waiting on an email
      // that can never be written.
      const claimed: boolean = await ctx.runMutation(
        internal.reimbursements.markApprovedNoticeSent,
        { reimbursementId },
      );
      if (!claimed || !payload.payeeEmail) return null;

      const notice = buildApprovedNotice({
        kind: "live",
        payeeName: payload.payeeName,
        reference: payload.reference,
        approvedCents: payload.approvedCents,
        totalCents: payload.totalCents,
        approvedAt: payload.approvedAt,
        status: payload.status,
        paidAt: payload.paidAt,
        bankAccountLast4: payload.bankAccountLast4,
        link: claimantStatusLink(payload),
      });
      await sendEmail(ctx, {
        to: payload.payeeEmail,
        subject: notice.subject,
        html: notice.html,
      });
    } catch (err) {
      console.error(
        "sendReimbursementApprovedEmail: failed",
        reimbursementId,
        err,
      );
    }
    return null;
  },
});

// ── INTERNAL: paid notice to the claimant ────────────────────────────────────

/**
 * Everything `sendReimbursementPaidEmail` needs, or `null` when the request no
 * longer exists / isn't paid (a scheduled job racing a deletion, or racing
 * `reverseSettledPayout`'s walk-back — it should degrade, not throw).
 *
 * Recipient rules are the approval notice's, verbatim: the CLAIMANT only, at
 * `payeeEmail` — the address they typed on the request. See
 * `getReimbursementApprovedEmailPayload` above for why that is the right
 * address and why the senders still guard against it being absent.
 */
export const getReimbursementPaidEmailPayload = internalQuery({
  args: { reimbursementId: v.id("reimbursementRequests") },
  handler: async (ctx, { reimbursementId }) => {
    const req = await ctx.db.get(reimbursementId);
    if (!req) return null;
    const chapter = await ctx.db.get(req.chapterId);
    const payout = await settlingPayoutFor(ctx, req);
    return paidNoticeRowFor(req, chapter?.slug ?? null, payout);
  },
});

/**
 * CLAIM this request's paid notice, returning whether the claim was ours.
 *
 * The identical mechanism as `markApprovedNoticeSent` above — one Convex
 * transaction around the read-then-write, claimed BEFORE the send, so two
 * senders racing a row (the live settle and an operator running the catch-up
 * sweep in the same minute) can't both mail it. That function's header is the
 * argument for all of it, including why the stamp landing before the send is
 * the ordering we want; nothing about it is different here and it is not
 * restated.
 *
 * Refuses a row that isn't currently `paid` with a `paidAt`, so nothing can
 * stamp a request this notice doesn't apply to. Deliberately does NOT touch
 * `updatedAt` — sending a notice isn't a claimant/manager edit.
 *
 * WHERE IT DIVERGES: `reverseSettledPayout` CLEARS this stamp when an ACH
 * credit bounces, so the retry that actually pays the claimant can claim it
 * again. That is the only route to a second paid notice on one reimbursement,
 * and it is the right one — see `lib/reimbursementPaidEmail.ts`'s header.
 */
export const markPaidNoticeSent = internalMutation({
  args: { reimbursementId: v.id("reimbursementRequests") },
  returns: v.boolean(),
  handler: async (ctx, { reimbursementId }) => {
    const req = await ctx.db.get(reimbursementId);
    if (!req) return false;
    if (req.status !== "paid" || req.paidAt === undefined) return false;
    if (req.paidNoticeSentAt !== undefined) return false;
    await ctx.db.patch(reimbursementId, { paidNoticeSentAt: Date.now() });
    return true;
  },
});

/**
 * "Your reimbursement was paid" — best-effort Resend to the claimant,
 * scheduled by `lib/increasePayoutMachine.ts`'s `settleReimbursementPaid`, the
 * single place a reimbursement becomes `paid` (both the ACH webhook and the
 * treasurer's `markPaidManually` funnel through it). The copy — and the rule
 * that it must not hedge about money that has already moved — lives in
 * `lib/reimbursementPaidEmail.ts`.
 *
 * Claims the send first (`markPaidNoticeSent`) and returns without mailing when
 * the claim isn't ours, and swallows everything, both for the same reasons
 * `sendReimbursementApprovedEmail` above does: it runs after the payout has
 * already committed, and a missing RESEND_API_KEY (dev/CI) or a transient
 * Resend failure must never surface as a failed scheduled job.
 */
export const sendReimbursementPaidEmail = internalAction({
  args: { reimbursementId: v.id("reimbursementRequests") },
  handler: async (ctx, { reimbursementId }) => {
    try {
      const payload = await ctx.runQuery(
        internal.reimbursements.getReimbursementPaidEmailPayload,
        { reimbursementId },
      );
      if (!payload) return null;
      // Claim even when there's no address to mail: a contact-less legacy row
      // must not sit in the backfill's backlog forever waiting on an email
      // that can never be written.
      const claimed: boolean = await ctx.runMutation(
        internal.reimbursements.markPaidNoticeSent,
        { reimbursementId },
      );
      if (!claimed || !payload.payeeEmail) return null;

      const notice = buildPaidNotice({
        kind: "live",
        payeeName: payload.payeeName,
        reference: payload.reference,
        paidCents: payload.paidCents,
        totalCents: payload.totalCents,
        paidAt: payload.paidAt,
        method: payload.method,
        bankAccountLast4: payload.bankAccountLast4,
        link: claimantStatusLink(payload),
      });
      await sendEmail(ctx, {
        to: payload.payeeEmail,
        subject: notice.subject,
        html: notice.html,
      });
    } catch (err) {
      console.error("sendReimbursementPaidEmail: failed", reimbursementId, err);
    }
    return null;
  },
});

// ── A ref (event/project) is being deleted ──────────────────────────────────
/**
 * Settle this event's/project's reimbursements before it disappears: REFUSE
 * the deletion while any of them is still live, and preserve the "For" answer
 * on the ones that are finished.
 *
 * ── WHY THE LIVE ONES BLOCK ─────────────────────────────────────────────────
 * A non-terminal reimbursement is money the org still owes someone, and its
 * ref is the justification a manager approves against. `forLabel` resolves
 * that ref LIVE, so deleting the event turned an in-flight $40.64 request's
 * "For" into a blank — no name, no marker, nothing to say it ever had one —
 * and left an approver deciding on money with the reason silently removed.
 * Same principle as `releaseBudgetsForDeletedRef` (`finances.ts`): deleting an
 * event is not a decision about money, and the person tidying up an old event
 * is not usually the person who can answer for it.
 *
 * ── WHY THE FINISHED ONES DON'T ─────────────────────────────────────────────
 * Blocking on a settled request would mean an event could never be deleted
 * once anyone had ever been paid for it — the ledger would pin the calendar
 * forever. `paid`/`rejected`/`canceled` (`REIMBURSEMENT_TERMINAL_STATUSES` —
 * note `failed` is NOT among them; a failed payout can be retried, so that
 * money is still live) are history, and history should stay readable rather
 * than stay linked. So the name is snapshotted onto the row and the link
 * cleared, which is strictly better than either alternative: leaving the
 * pointer dangling keeps a lie, and unlinking without the snapshot makes the
 * blank permanent and honest instead of just permanent.
 *
 * The line items of a released request get the same treatment — a per-line
 * `eventId` would dangle exactly as loudly, and they are read through the same
 * request.
 *
 * No finance gate here, deliberately, unlike its budget sibling: this path
 * never deletes anything and never moves money. It rewrites a dead pointer
 * into the words it used to resolve to, which is strictly information-
 * preserving — and the alternative (refusing until a finance manager arrives)
 * would block ordinary event cleanup to protect a row nobody can act on.
 */
export async function releaseReimbursementsForDeletedRef(
  ctx: MutationCtx,
  ref: { kind: "event"; id: Id<"events"> } | { kind: "project"; id: Id<"projects"> },
  refName: string,
): Promise<void> {
  // Both sides go through an index (`by_event`, and `by_project` added for this
  // in the same change). The project side originally scanned the chapter and
  // filtered, which TRUNCATES at the scan cap — and a truncation here silently
  // leaves behind the exact dangling ref this function exists to prevent, so
  // the ceiling had to go rather than be warned about.
  const candidates =
    ref.kind === "event"
      ? await ctx.db
          .query("reimbursementRequests")
          .withIndex("by_event", (q) => q.eq("eventId", ref.id))
          .collect()
      : await ctx.db
          .query("reimbursementRequests")
          .withIndex("by_project", (q) => q.eq("projectId", ref.id))
          .collect();
  if (candidates.length === 0) return;

  const live = candidates.filter(
    (r) => !REIMBURSEMENT_TERMINAL_STATUSES.includes(r.status),
  );
  if (live.length > 0) {
    const total = live.reduce((sum, r) => sum + r.totalCents, 0);
    const first = live[0];
    const who = `${first.payeeName}'s ${formatCents(first.totalCents)} reimbursement`;
    const subject =
      live.length === 1
        ? `${who} (${REIMBURSEMENT_STATUS_LABELS[first.status].toLowerCase()})`
        : `${live.length} reimbursements totalling ${formatCents(total)}`;
    throw new ConvexError({
      code: "REIMBURSEMENT_IN_FLIGHT",
      message:
        `Can't delete this ${ref.kind} — ${subject} ${live.length === 1 ? "says it was" : "say they were"} ` +
        `for it, and ${live.length === 1 ? "hasn't" : "haven't"} been settled yet. Deleting it now would ` +
        `blank out what the money was for while someone still has to approve or pay it. ` +
        `Finish paying ${live.length === 1 ? "it" : "them"} (or reject ${live.length === 1 ? "it" : "them"} if ` +
        `${live.length === 1 ? "it's" : "they're"} not owed), then delete this ${ref.kind}.`,
    });
  }

  for (const request of candidates) {
    await ctx.db.patch(request._id, {
      ...(ref.kind === "event" ? { eventId: undefined } : { projectId: undefined }),
      // Unconditional. A request carries exactly ONE ref
      // (`createReimbursement`'s mutual-exclusivity check) and nothing re-tags
      // it afterwards, so the ref being released here is the only one this
      // request ever had — there is no older snapshot to protect. An earlier
      // draft guarded this with `request.forLabelSnapshot ? {} : …`; that
      // branch was unreachable, and worse, if a re-tag path is ever added the
      // rule inverts (the stored snapshot would then be the STALE tag, and the
      // one being released the current one). Better to state the invariant
      // than to encode a guess about a future that would need revisiting here
      // anyway.
      forLabelSnapshot: refName,
      updatedAt: Date.now(),
    });
    const lines = await ctx.db
      .query("reimbursementLineItems")
      .withIndex("by_reimbursement", (q) => q.eq("reimbursementId", request._id))
      .take(ROLLUP_SCAN_LIMIT);
    for (const line of lines) {
      if (ref.kind === "event" && line.eventId === ref.id) {
        await ctx.db.patch(line._id, { eventId: undefined });
      } else if (ref.kind === "project" && line.projectId === ref.id) {
        await ctx.db.patch(line._id, { projectId: undefined });
      }
    }
  }

  // THE PAYOUT TRANSACTION CARRIES THE SAME REF, and nothing above touches it.
  // `lib/reimbursementTxnFields.ts#deriveReimbursementTxnFields` writes
  // `budgetId` OR `eventId` OR `projectId` — an else-if chain — so an
  // EVENT-tagged reimbursement's payout row carries `eventId` and NO
  // `budgetId`. `releaseBudgetsForDeletedRef` only ever finds transactions
  // through `by_budget`, so it is structurally blind to exactly these rows:
  // paying an event-tagged reimbursement and then deleting the event left a
  // `transactions` row pointing at a row that no longer exists, in the `paid`
  // case this whole terminal branch exists to serve.
  //
  // That dangle is not merely cosmetic — `migrateLinksToBudgets`
  // (`finances.ts`) walks transactions carrying `eventId`/`projectId` and calls
  // `ensureBudgetForRef` on each, which would MINT a fresh budget against the
  // deleted ref: the precise orphan #736 was written to eliminate.
  //
  // Clearing the link loses nothing. The row keeps `reimbursementId`, and the
  // request it points at now carries `forLabelSnapshot`, so "what was this
  // payout for" is still answerable — through one more hop, in words rather
  // than a dead pointer.
  const payoutTxns =
    ref.kind === "event"
      ? await ctx.db
          .query("transactions")
          .withIndex("by_event", (q) => q.eq("eventId", ref.id))
          .collect()
      : await ctx.db
          .query("transactions")
          .withIndex("by_project", (q) => q.eq("projectId", ref.id))
          .collect();
  for (const tr of payoutTxns) {
    await ctx.db.patch(tr._id, {
      ...(ref.kind === "event" ? { eventId: undefined } : { projectId: undefined }),
    });
  }
}
