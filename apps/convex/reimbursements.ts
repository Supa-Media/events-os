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
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import {
  REIMBURSEMENT_STATUSES,
  REIMBURSEMENT_STATUS_LABELS,
  EXTERNAL_ACCOUNT_FUNDINGS,
  type ReimbursementStatus,
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
} from "./lib/finance";
import { assertRoutingNumber, assertAccountNumber } from "./increase";
import { sendEmail, emailShell } from "./ticketingEmails";
import { escapeHtml } from "./lib/html";

const externalAccountFundingValidator = v.union(
  ...EXTERNAL_ACCOUNT_FUNDINGS.map((f) => v.literal(f)),
);

// ── Enum validators (built from the shared tuple) ────────────────────────────
const reimbursementStatusValidator = v.union(
  ...REIMBURSEMENT_STATUSES.map((s) => v.literal(s)),
);

/** The submitted line-item shape, shared by the public + in-app submit paths.
 *  Money is a raw `v.number()` here — the integer-cents check is enforced in
 *  `assertLineCents` (an arg validator can't reject a non-integer). */
const submitLineValidator = v.object({
  description: v.string(),
  amountCents: v.number(),
  categoryId: v.optional(v.id("budgetCategories")),
  fundId: v.optional(v.id("funds")),
  receiptStorageId: v.optional(v.id("_storage")),
});
type SubmitLine = {
  description: string;
  amountCents: number;
  categoryId?: Id<"budgetCategories">;
  fundId?: Id<"funds">;
  receiptStorageId?: Id<"_storage">;
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

/** Reduce an untrusted "bank last 4" to its digits, keeping only the last 4 —
 *  so a full account number pasted here is never stored. Undefined when blank;
 *  throws when it contains no digits. */
function sanitizeLast4(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const digits = value.replace(/\D/g, "");
  if (digits.length === 0) {
    if (value.trim().length === 0) return undefined;
    throw new ConvexError({
      code: "INVALID_INPUT",
      message: "Bank account last 4 must be digits.",
    });
  }
  return digits.slice(-4);
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
 * authenticated caller's own roster person), then hands validated-but-untrusted
 * field values here. This single helper owns all the invariants — name/email
 * validation, per-line integer-cents + chapter-ownership checks, the total, the
 * `bankAccountLast4` reduction, the pre-approval status, and the request+lines
 * insert — so the two surfaces can never drift.
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
    purpose?: string;
    bankAccountLast4?: string;
    requestPreApproval?: boolean;
    personId: Id<"people"> | null;
    /** True only when `personId` is a server-verified identity (the
     *  authenticated in-app path) rather than the public path's best-effort
     *  phone/email match. Drives `identityVerified` on the row. */
    identityVerified?: boolean;
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
  const purpose = capOptional(input.purpose, 2000);
  const bankAccountLast4 = sanitizeLast4(input.bankAccountLast4);

  if (input.lines.length === 0 || input.lines.length > 100) {
    throw new ConvexError({
      code: "INVALID_INPUT",
      message: "Add between 1 and 100 line items.",
    });
  }

  // Validate every line's money + verify any fund/category belongs to this
  // chapter (untrusted input must never reference another chapter).
  for (const line of input.lines) {
    assertLineCents(line.amountCents);
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
    totalCents,
    bankAccountLast4,
    submittedAt: now,
    createdAt: now,
    updatedAt: now,
  });

  for (let i = 0; i < input.lines.length; i++) {
    const line = input.lines[i];
    await ctx.db.insert("reimbursementLineItems", {
      chapterId,
      reimbursementId,
      description: cap(line.description, 500),
      amountCents: line.amountCents,
      fundId: line.fundId,
      categoryId: line.categoryId,
      receiptStorageId: line.receiptStorageId,
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

/** Throw `RATE_LIMITED` if `key` already hit the cap within the window. Cheap:
 *  one indexed range query, bounded to `SUBMIT_RATE_LIMIT_MAX` rows. */
async function assertSubmitNotRateLimited(
  ctx: MutationCtx,
  key: string,
): Promise<void> {
  const windowStart = Date.now() - SUBMIT_RATE_LIMIT_WINDOW_MS;
  const recent = await ctx.db
    .query("reimbursementSubmitAttempts")
    .withIndex("by_key_and_time", (q) =>
      q.eq("key", key).gte("createdAt", windowStart),
    )
    .take(SUBMIT_RATE_LIMIT_MAX);
  if (recent.length >= SUBMIT_RATE_LIMIT_MAX) {
    throw new ConvexError({
      code: "RATE_LIMITED",
      message:
        "Too many reimbursement requests submitted recently. Please try again in a bit.",
    });
  }
}

/** Record one successful submission against a rate-limit key. */
async function recordSubmitAttempt(
  ctx: MutationCtx,
  key: string,
): Promise<void> {
  // TODO(rate-limit): rows are never deleted — this table only grows. A
  // scheduled TTL sweep (delete rows with createdAt older than
  // SUBMIT_RATE_LIMIT_WINDOW_MS) is a queued follow-up.
  await ctx.db.insert("reimbursementSubmitAttempts", {
    key,
    createdAt: Date.now(),
  });
}

/**
 * Submit a reimbursement from the public form. No auth — the chapter is
 * resolved by its `slug`. Generates a secret `token` (returned once) and a
 * short human reference. Inserts the request + its order-indexed line items.
 * Status is `pending_preapproval` when pre-approval is requested, else
 * `submitted`. `totalCents` is the integer-cents sum of the lines.
 *
 * `payeeEmail` is REQUIRED + format-validated: it's the claimant's contact for
 * the reminder cron, and (normalized) one half of the separation-of-duties
 * check the approval flow enforces (a manager can't approve a request bearing
 * their own email). All untrusted strings are trimmed + hard-capped, and
 * `bankAccountLast4` is reduced to its last 4 digits so a full account number
 * is never stored.
 *
 * RATE-LIMITED (see `assertSubmitNotRateLimited` above): checked by IP
 * (`clientIp`, forwarded from the public httpAction — undefined for the
 * authenticated in-app `submitReimbursement` twin, which never calls this
 * limiter) and by normalized email, BEFORE any write. A successful submission
 * records one attempt per key that was checked.
 */
export const submitPublicReimbursement = mutation({
  args: {
    chapterSlug: v.string(),
    payeeName: v.string(),
    payeeEmail: v.string(),
    payeePhone: v.optional(v.string()),
    purpose: v.optional(v.string()),
    bankAccountLast4: v.optional(v.string()),
    requestPreApproval: v.optional(v.boolean()),
    lines: v.array(submitLineValidator),
    /** The caller's IP, forwarded by the `/api/reimburse/submit` httpAction
     *  (read from the `x-forwarded-for` request header there — a plain
     *  mutation has no access to request headers itself). Undefined when
     *  called some other way (e.g. directly in tests); the email-keyed check
     *  still applies. */
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
      bankAccountLast4: args.bankAccountLast4,
      requestPreApproval: args.requestPreApproval,
      personId,
      lines: args.lines,
    });

    // Only record a key that was actually checked above.
    if (ipKey) await recordSubmitAttempt(ctx, `ip:${ipKey}`);
    if (normalizedEmail) {
      await recordSubmitAttempt(ctx, `email:${normalizedEmail}`);
    }

    return { token, reference };
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
 * Reuses the exact validation, line-item shape, receipt handling, and
 * pre-approval wiring as the public path via `createReimbursement` — the
 * reminder cron then sweeps it like any other request.
 */
export const submitReimbursement = mutation({
  args: {
    payeeName: v.optional(v.string()),
    payeeEmail: v.optional(v.string()),
    payeePhone: v.optional(v.string()),
    purpose: v.optional(v.string()),
    bankAccountLast4: v.optional(v.string()),
    requestPreApproval: v.optional(v.boolean()),
    lines: v.array(submitLineValidator),
  },
  handler: async (ctx, args) => {
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
      bankAccountLast4: args.bankAccountLast4,
      requestPreApproval: args.requestPreApproval,
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

/**
 * Display data for the in-app "Request a reimbursement" form: the caller's own
 * name/email/phone prefill (the SAME values `submitReimbursement` would default
 * to, so the form never shows something different from what actually gets
 * submitted) and the chapter's active funds for the fund picker. Deliberately
 * has NO finance-role gate (unlike `finances.listFunds`) — any authenticated
 * chapter member needs this to submit their own reimbursement, whether or not
 * they hold a finance grant. Degrades to empty/blank rather than throwing when
 * the caller has no chapter yet — `submitReimbursement` is the real gate.
 */
export const newRequestOptions = query({
  args: {},
  handler: async (ctx) => {
    const chapterId = await getChapterIdOrNull(ctx);
    if (!chapterId) {
      return { defaultPayeeName: "", defaultPayeeEmail: "", defaultPayeePhone: "", funds: [] };
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

/** Gate + resolve a PUBLIC (token-scoped) link target: must exist + still be
 *  editable. Returns the fields the action needs (id + a display-name default). */
export const beginLinkPublicBankAccount = internalQuery({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const request = assertLinkable(await byToken(ctx, token));
    return { reimbursementId: request._id, payeeName: request.payeeName };
  },
});

/**
 * Link a REAL bank account (routing + account number) to a PUBLIC, token-
 * scoped reimbursement so its payout can be addressed by an actual Increase
 * ACH transfer instead of degrading to a manual one. Creates an Increase
 * External Account (`increase.createExternalAccount`) — the raw account
 * number is NEVER persisted in Convex, only the returned reference id + a
 * last-4 (`attachExternalAccount`). Ownership is proven by the secret `token`
 * (the same precedent as `attachPublicReceipt`), never a client-supplied id.
 *
 * BEST-EFFORT: if the Increase call fails or isn't configured, the request is
 * left exactly as it was (still fully submitted) — `linked:false` tells the
 * form to show "we couldn't verify your bank details; a finance manager will
 * follow up" rather than blocking submission. Valid only while the request is
 * still editable (pre-payout).
 */
export const linkPublicBankAccount = action({
  args: { token: v.string(), ...linkBankAccountArgs },
  handler: async (ctx, args): Promise<{ linked: boolean }> => {
    const routingNumber = assertRoutingNumber(args.routingNumber);
    const accountNumber = assertAccountNumber(args.accountNumber);

    const prep = await ctx.runQuery(
      internal.reimbursements.beginLinkPublicBankAccount,
      { token: args.token },
    );

    const created = await ctx.runAction(internal.increase.createExternalAccount, {
      routingNumber,
      accountNumber,
      accountHolderName: (args.accountHolderName?.trim() || prep.payeeName).slice(
        0,
        200,
      ),
      funding: args.funding ?? "checking",
    });
    if (!created) return { linked: false };

    await ctx.runMutation(internal.reimbursements.attachExternalAccount, {
      reimbursementId: prep.reimbursementId,
      externalAccountId: created.externalAccountId,
      last4: created.last4,
    });
    return { linked: true };
  },
});

/** Gate + resolve an AUTHENTICATED in-app link target: the request must exist,
 *  still be editable, AND belong to the CALLER's own verified roster identity
 *  — never someone else's. Identity is server-derived, never client-supplied
 *  (mirrors `submitReimbursement`). */
export const beginLinkBankAccount = internalMutation({
  args: { reimbursementId: v.id("reimbursementRequests") },
  handler: async (ctx, { reimbursementId }) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    const req = await ctx.db.get(reimbursementId);
    await requireInChapter(ctx, chapterId, req, "Reimbursement");
    const request = assertLinkable(req);
    const callerPersonId = await resolveCallerPersonId(ctx, chapterId);
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
 * Link a REAL bank account to the CALLER'S OWN in-app reimbursement — the
 * authenticated twin of `linkPublicBankAccount`. Same Increase External
 * Account creation, same "never persist the raw account number" contract, and
 * the same best-effort `{linked}` degrade.
 */
export const linkBankAccount = action({
  args: { reimbursementId: v.id("reimbursementRequests"), ...linkBankAccountArgs },
  handler: async (ctx, args): Promise<{ linked: boolean }> => {
    const routingNumber = assertRoutingNumber(args.routingNumber);
    const accountNumber = assertAccountNumber(args.accountNumber);

    const prep = await ctx.runMutation(internal.reimbursements.beginLinkBankAccount, {
      reimbursementId: args.reimbursementId,
    });

    const created = await ctx.runAction(internal.increase.createExternalAccount, {
      routingNumber,
      accountNumber,
      accountHolderName: (args.accountHolderName?.trim() || prep.payeeName).slice(
        0,
        200,
      ),
      funding: args.funding ?? "checking",
    });
    if (!created) return { linked: false };

    await ctx.runMutation(internal.reimbursements.attachExternalAccount, {
      reimbursementId: args.reimbursementId,
      externalAccountId: created.externalAccountId,
      last4: created.last4,
    });
    return { linked: true };
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
          category: await categoryName(ctx, l.categoryId),
          fund: await fundName(ctx, l.fundId),
          hasReceipt: !!l.receiptStorageId,
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
      });
    }
    return stale;
  },
});

/**
 * Sweep every chapter's stale reimbursements and email the claimant a nudge.
 * Best-effort Resend — a no-op that only logs when RESEND_API_KEY is unset
 * (mirrors `reminders.ts` / the ticketing emails), so dev + CI never send.
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
        await sendEmail(
          r.payeeEmail,
          `Your reimbursement ${r.reference} is still pending`,
          emailShell(`
          <h1 style="margin:0 0 12px;font-size:24px;line-height:1.2">Reimbursement ${escapeHtml(r.reference)}</h1>
          <p style="margin:0 0 16px;font-family:-apple-system,'Segoe UI',Roboto,sans-serif;font-size:14px;line-height:1.6;color:#7A5A5A">Hi ${escapeHtml(r.payeeName)} — your ${escapeHtml(dollars)} reimbursement is still open. ${reason}</p>`),
        );
      }
    }
    return null;
  },
});
