/**
 * Cards — the native member-card layer for Chapter OS (Phase 5: person-owned
 * Increase cards + the real-time authorization decision + personal-charge
 * repayment).
 *
 * Cards are PERSON-OWNED: a card belongs to ONE `cardholderPersonId`, who owns
 * its receipts + reconciliation. There are only TWO hard controls — a monthly
 * safety cap (`monthlyCapCents`) and a validity window (`validFrom`/`validUntil`)
 * — plus the receipt auto-lock (a charge whose receipt is >7 days late locks the
 * card; a manager/cardholder unlock clears the grace window). The one
 * CHAPTER-LEVEL control is the merchant allow-list (`cardMerchantPolicy`, one
 * row per chapter): when ENFORCED and NON-EMPTY, the real-time decision also
 * declines any authorization whose merchant matches no allowed name substring
 * or MCC — see `decideAgainstMerchantPolicy`. Personal charges
 * are flagged + repaid via the cardholder's own debit/ACH, which posts an
 * OFFSETTING `flow:"transfer"` credit — no reimbursement paperwork.
 *
 * WP-C.1 (Cards v2 lifecycle) layers three more transitions onto
 * `status:"locked"`/`"canceled"`, all still gated in this file:
 *  - `freezeCard`/`unfreezeCard` — the CARDHOLDER self-serve locks/unlocks
 *    their OWN card (suspected foul play), marked `frozenByHolder` so it's
 *    distinguishable from a manager `lockCard` or the receipt auto-lock and
 *    can ONLY be reversed by that same holder (or a manager's `unlockCard`,
 *    which lifts every lock reason). `beginFreezeCard` only ever transitions
 *    an ACTIVE card, so a card already locked for another reason is never
 *    mis-marked `frozenByHolder` — see its doc comment for why that keeps
 *    `unfreezeCard` safe to act on. `unfreezeCard` itself re-runs the receipt
 *    auto-lock's eligibility check before reactivating — an overdue charge
 *    accrued while frozen lands the card `"locked"` for the receipt instead
 *    of `"active"`, so the holder can't dodge it for a day waiting on the
 *    cron.
 *  - `cancelCard` — FM/Treasurer ONLY (`requireFinanceManager`), permanently
 *    terminal; never self-serve.
 *  - `requestCard`/`decideCardRequest` — a member requests a card
 *    (`cardRequests`, one open request at a time); an FM/Treasurer
 *    approves (→ the existing `issueCard` action) or denies.
 *
 * WP-C.3 (digital wallet — Apple/Google/Samsung Pay) adds two more real-time
 * decisions (`handleIncreaseDigitalWalletTokenRequested` /
 * `...AuthenticationRequested`, see their section doc comment for the full
 * two-step flow) plus a HOLDER-ONLY, rate-limited `revealCardDetails` for
 * manual add-to-wallet (PAN/CVC never persisted or logged — see its own doc
 * comment; native push provisioning is explicitly deferred, needs the Apple
 * PassKit entitlement).
 *
 * DESIGN (mirrors `increase.ts`): the network fetch is separated from the DB
 * apply so the authorization decision + repayment state machine are testable
 * WITHOUT hitting Increase. Actions FETCH (raw `fetch`, no SDK); internal
 * mutations APPLY against `ctx.db`. `decideCardAuthorization` is a pure internal
 * mutation the orchestrator's `/increase/webhook` real-time-decision branch
 * calls synchronously and responds to Increase with.
 *
 * INVARIANTS:
 *  - Money is ALWAYS a non-negative INTEGER number of cents; direction lives in
 *    `transactions.flow`, never a sign.
 *  - Every table is chapter-scoped; every client id is verified in the caller's
 *    chapter before use.
 *  - The offsetting repayment credit posts as `flow:"transfer"` → EXCLUDED from
 *    category/budget spend (it nets the personal charge without counting as
 *    income). IDEMPOTENT: at most one credit per repayment.
 *  - `decideCardAuthorization` NEVER throws (a thrown decision would wrongly
 *    decline/hang the card network) — on any internal error it defaults to a
 *    logged DECLINE.
 *  - Degrade to a logged no-op (never throw) when `INCREASE_API_KEY` is unset:
 *    `issueCard` still creates the `cards` row so the app works in dev.
 *  - All failures throw `ConvexError` (never a plain `Error`).
 *
 * Env: INCREASE_API_KEY, INCREASE_API_BASE (sandbox URL for dev/staging;
 * defaults to production). INCREASE_SANDBOX_API_KEY (OPTIONAL) lets the single
 * prod `/increase/webhook` endpoint also serve sandbox real-time decisions —
 * follow-up calls about a `sandbox_`-prefixed decision are routed to the sandbox
 * with this key (see `increaseEnvForObjectId`).
 */
import {
  action,
  mutation,
  query,
  internalMutation,
  internalQuery,
  internalAction,
} from "./_generated/server";
import type { ActionCtx, MutationCtx, QueryCtx } from "./_generated/server";
import { ConvexError, v, type Infer } from "convex/values";
import { api, internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import {
  CARD_TYPES,
  CARD_STATUSES,
  CARD_SOURCES,
  CARD_REQUEST_STATUSES,
  REPAYMENT_METHODS,
  REPAYMENT_STATUSES,
  CENTRAL,
  RECEIPT_GRACE_DAYS,
  RECEIPT_ESCALATE_DAYS,
  EXTERNAL_ACCOUNT_FUNDINGS,
  easternParts,
  matchesMode,
  isSandboxObjectId,
  isCardEligible,
  getAcademyCourse,
  formatCents,
  REPAYMENT_NUDGE_COOLDOWN_MS,
  PAYER_ATTRIBUTION_LABELS,
  PERSONAL_FLAG_LABELS,
  type CardType,
  type CardStatus,
  type CardSource,
  type CardRequestStatus,
  type RepaymentMethod,
  type RepaymentStatus,
} from "@events-os/shared";
import {
  readSandbox,
  readNoReceiptAutoConvertDays,
  readCardPrerequisiteCourseSlug,
} from "./financeSettings";
import { hasCompletedCourse } from "./academy";
import {
  requireChapterId,
  requireInChapter,
  getChapterIdOrNull,
  requireAccess,
  requireUserId,
} from "./lib/context";
import {
  requireFinanceRole,
  requireFinanceManager,
  requireCentralFinanceRole,
  getFinanceRole,
  getChapterAccountForMode,
  resolveCallerPersonId,
  type FinanceScope,
} from "./lib/finance";
import { viewerPerson } from "./lib/org";
import {
  increaseEnvForObjectId,
  assertRoutingNumber,
  assertAccountNumber,
} from "./increase";
import { buildDigitalWallet } from "./lib/increaseApi";
import { sendEmail, sendEmailReporting, emailShell } from "./ticketingEmails";
import {
  emailButtonRow,
  emailCode,
  emailHeading,
  emailList,
  emailPanel,
  emailParagraph,
  emailTextStyle,
} from "./lib/emailShell";
import {
  chargeOutstanding,
  codingOverdueMs,
  isDocumented,
  isUncodedCharge,
  reminderChargeValidator,
  stageForAge,
  type ChaseTarget,
  type ReminderCharge,
} from "./lib/codingReminders";
import { reconcileFilterValidator } from "./lib/reconcileArgs";
import { listCodingReviewerPersonIds } from "./lib/transactionCodingAccess";
import { listActiveChapters } from "./lib/chapters";
import { codingForTransaction, codingPolicy } from "./lib/transactionCoding";
import { escapeHtml } from "./lib/html";
import { appUrl } from "./lib/siteUrl";
import { normalizePhone, resolveTwilioCredentials, sendSms } from "./lib/twilio";
import { logFinanceAudit } from "./lib/financeAuditLog";
import {
  repaymentFeeQuoteFor,
  repaymentRailQuote,
  stripePaymentMethodTypes,
} from "./lib/repaymentFees";
import { markPublicationsStale } from "./lib/publicLedgerStale";
import { requireRepaymentsCollect } from "./lib/repaymentsAccess";
import { buildRepaymentReceipt } from "./lib/personalRepaymentReceiptEmail";

const externalAccountFundingValidator = v.union(
  ...EXTERNAL_ACCOUNT_FUNDINGS.map((f) => v.literal(f)),
);

/** Increase API base URL. Env-overridable so dev/staging point at the sandbox
 *  (`INCREASE_API_BASE=https://sandbox.increase.com`); defaults to production. */
function increaseApiBase(): string {
  return process.env.INCREASE_API_BASE ?? "https://api.increase.com";
}

// ── Bounds ───────────────────────────────────────────────────────────────────
const CARD_SCAN_LIMIT = 2000;
// Per-card, per-month charge count is naturally small; bound the read anyway.
const CARD_TXN_LIMIT = 2000;
// Bound the newest-first authorization read for the cap check. A month of
// authorizations on one card is small; reading the most recent N and filtering
// to the current month avoids the ascending-`take` under-count on long-lived
// cards.
const AUTH_SCAN_LIMIT = 5000;
// Bound the auto-lock cron sweep (cards is a small table).
const AUTOLOCK_LIMIT = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
// Cap how many charges `advanceReceiptReminders` transitions (and therefore
// how many emails `sendReceiptReminders` sends) in a single run. Without this,
// the FIRST cron run after deploy would advance — and email — every
// historical missing-receipt charge at once (a chapter can have months of
// un-receipted backlog with no reminder feature to have caught it earlier).
// Oldest-first (see the sort in `advanceReceiptReminders`) so the backlog
// drains gradually over multiple days instead of bursting on day one.
const REMINDER_BATCH_LIMIT = 25;
// Charges posted before this horizon are SEED-ONLY: `advanceReceiptReminders`
// still sets their stage (so the grid reflects reality), but
// `sendReceiptReminders` never emails for them. A charge that's been sitting
// for months predates the reminder feature entirely — a sudden "still
// missing" nag about it is noise, not a useful reminder.
const REMINDER_SEED_ONLY_DAYS = 30;

// ── Enum validators (built from the shared tuples) ───────────────────────────
const cardTypeValidator = v.union(...CARD_TYPES.map((t) => v.literal(t)));
const cardStatusValidator = v.union(...CARD_STATUSES.map((s) => v.literal(s)));
const cardSourceValidator = v.union(...CARD_SOURCES.map((s) => v.literal(s)));
const repaymentMethodValidator = v.union(
  ...REPAYMENT_METHODS.map((m) => v.literal(m)),
);
const repaymentStatusValidator = v.union(
  ...REPAYMENT_STATUSES.map((s) => v.literal(s)),
);
const cardRequestStatusValidator = v.union(
  ...CARD_REQUEST_STATUSES.map((s) => v.literal(s)),
);

// ── Read-shape validators (what the UI renders) ──────────────────────────────
const cardSummaryValidator = v.object({
  id: v.id("cards"),
  cardholderPersonId: v.id("people"),
  cardholderName: v.union(v.string(), v.null()),
  type: cardTypeValidator,
  last4: v.union(v.string(), v.null()),
  // Provenance so the UI can badge legacy (Relay) cards + hide Increase controls.
  source: cardSourceValidator,
  status: cardStatusValidator,
  monthlyCapCents: v.union(v.number(), v.null()),
  validFrom: v.union(v.number(), v.null()),
  validUntil: v.union(v.number(), v.null()),
  receiptGraceEndsAt: v.union(v.number(), v.null()),
  // True iff the card is locked because the CARDHOLDER self-serve froze it
  // (distinct from a manager lock / the receipt auto-lock — see the schema
  // field's doc comment).
  frozenByHolder: v.boolean(),
  spentThisMonthCents: v.number(),
});

const cardRequestSummaryValidator = v.object({
  id: v.id("cardRequests"),
  personId: v.id("people"),
  personName: v.union(v.string(), v.null()),
  status: cardRequestStatusValidator,
  note: v.union(v.string(), v.null()),
  requestedAt: v.number(),
  decidedAt: v.union(v.number(), v.null()),
  // Set once approved — the card `issueCard` created for this request.
  cardId: v.union(v.id("cards"), v.null()),
});

// The org-wide card-prerequisite state, `null` when no gate is configured:
//  - `prerequisiteMet` on a row: `null` when no prerequisite is configured OR
//    the configured course isn't in the catalog (fail-open — no effective
//    gate); otherwise whether that person has completed it.
// The list rows below reuse the base card/request validators + this one field
// so the manager UI can badge Trained ✓ / Needs training per row.
const prerequisiteMetValidator = v.union(v.boolean(), v.null());

const cardRowValidator = v.object({
  ...cardSummaryValidator.fields,
  prerequisiteMet: prerequisiteMetValidator,
});

const cardRequestRowValidator = v.object({
  ...cardRequestSummaryValidator.fields,
  prerequisiteMet: prerequisiteMetValidator,
});

const repaymentSummaryValidator = v.object({
  id: v.id("personalRepayments"),
  transactionId: v.id("transactions"),
  payerPersonId: v.id("people"),
  amountCents: v.number(),
  method: repaymentMethodValidator,
  status: repaymentStatusValidator,
  creditTransactionId: v.union(v.id("transactions"), v.null()),
  // Whether the payer has a linked Increase External Account (a real ACH
  // charge is addressable) — never the raw id itself.
  hasExternalAccount: v.boolean(),
  payerAccountLast4: v.union(v.string(), v.null()),
});

const authDecisionValidator = v.object({
  approved: v.boolean(),
  reason: v.optional(v.string()),
});

const merchantPolicyValidator = v.object({
  enforced: v.boolean(),
  allowedMerchantNames: v.array(v.string()),
  allowedMerchantCategories: v.array(v.string()),
});

// ── TS shapes (for action ↔ internal-mutation typing) ────────────────────────
interface CardSummary {
  id: Id<"cards">;
  cardholderPersonId: Id<"people">;
  cardholderName: string | null;
  type: CardType;
  last4: string | null;
  source: CardSource;
  status: CardStatus;
  monthlyCapCents: number | null;
  validFrom: number | null;
  validUntil: number | null;
  receiptGraceEndsAt: number | null;
  frozenByHolder: boolean;
  spentThisMonthCents: number;
}

interface CardRequestSummary {
  id: Id<"cardRequests">;
  personId: Id<"people">;
  personName: string | null;
  status: CardRequestStatus;
  note: string | null;
  requestedAt: number;
  decidedAt: number | null;
  cardId: Id<"cards"> | null;
}

// A `null` `prerequisiteMet` means "no effective card-prerequisite gate" (none
// configured, or the configured course isn't in the catalog → fail-open); a
// boolean is that person's completion of the configured course.
type CardRow = CardSummary & { prerequisiteMet: boolean | null };
type CardRequestRow = CardRequestSummary & { prerequisiteMet: boolean | null };

interface RepaymentSummary {
  id: Id<"personalRepayments">;
  transactionId: Id<"transactions">;
  payerPersonId: Id<"people">;
  amountCents: number;
  method: RepaymentMethod;
  status: RepaymentStatus;
  creditTransactionId: Id<"transactions"> | null;
  hasExternalAccount: boolean;
  payerAccountLast4: string | null;
}

interface MerchantPolicySummary {
  enforced: boolean;
  allowedMerchantNames: string[];
  allowedMerchantCategories: string[];
}

interface UnfreezeCardResult {
  card: CardSummary;
  kind: "active" | "receipt_locked";
}

type IssueCardResult =
  | { kind: "existing"; card: CardSummary }
  | {
      kind: "created";
      card: CardSummary;
      cardId: Id<"cards">;
      increaseAccountId: string | null;
      description: string;
      // The cardholder's `@publicworship.life` address, for the new card's
      // `digital_wallet.email` (see `issueCard`). Always present: issuance
      // already rejects a holder without one (`isCardEligible`).
      cardholderEmail: string;
    };

type BeginRepaymentResult =
  | { kind: "paid"; repayment: RepaymentSummary }
  | {
      kind: "pending";
      repayment: RepaymentSummary;
      canCharge: boolean;
      increaseAccountId: string | null;
      amountCents: number;
      // The payer's linked Increase External Account (their funding source) the
      // repayment debit pulls from, captured via `linkRepaymentBankAccount`.
      // Null until linked — `canCharge` gates the ACH branch off until then.
      payerExternalAccountId: string | null;
    };

function toRepaymentSummary(r: Doc<"personalRepayments">): RepaymentSummary {
  return {
    id: r._id,
    transactionId: r.transactionId,
    payerPersonId: r.payerPersonId,
    amountCents: r.amountCents,
    method: r.method,
    status: r.status,
    creditTransactionId: r.creditTransactionId ?? null,
    hasExternalAccount: !!r.payerExternalAccountId,
    payerAccountLast4: r.payerAccountLast4 ?? null,
  };
}

// ── Raw Increase fetch helper (default runtime `fetch`, no SDK) ───────────────
/** POST JSON to the Increase API. `idempotencyKey` sets the `Idempotency-Key`
 *  header so a retried request never creates a second transfer (same contract
 *  as `increase.ts`'s twin). Throws ConvexError on a non-2xx so the caller can
 *  log + degrade. */
async function increasePost(
  key: string,
  base: string,
  path: string,
  body: Record<string, unknown>,
  idempotencyKey?: string,
): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.error(`[cards] POST ${path} failed:`, await res.text());
    throw new ConvexError({
      code: "INCREASE_ERROR",
      message: "The Increase request failed. Please try again.",
    });
  }
  return (await res.json()) as Record<string, unknown>;
}

/** GET JSON from the Increase API. A real-time-decision webhook carries only the
 *  decision id, so its card-authorization details are read by FETCHING the object
 *  (GET /real_time_decisions/{id}). Throws ConvexError on a non-2xx. */
async function increaseGet(
  key: string,
  base: string,
  path: string,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${base}${path}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!res.ok) {
    console.error(`[cards] GET ${path} failed:`, await res.text());
    throw new ConvexError({
      code: "INCREASE_ERROR",
      message: "The Increase request failed. Please try again.",
    });
  }
  return (await res.json()) as Record<string, unknown>;
}

/** PATCH JSON to the Increase API — used to sync a card's `status` (freeze /
 *  unfreeze / cancel) onto Increase's own Card object. Throws ConvexError on a
 *  non-2xx (the caller degrades this to a logged no-op; see
 *  `setIncreaseCardStatus`). */
async function increasePatch(
  key: string,
  base: string,
  path: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${base}${path}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.error(`[cards] PATCH ${path} failed:`, await res.text());
    throw new ConvexError({
      code: "INCREASE_ERROR",
      message: "The Increase request failed. Please try again.",
    });
  }
  return (await res.json()) as Record<string, unknown>;
}

/**
 * Best-effort sync of a LOCAL freeze/unfreeze/cancel to Increase's own Card
 * `status` (`active` | `disabled` | `canceled` — PATCH /cards/{id}, grounded
 * against the Increase Card resource). This is belt-and-suspenders alongside
 * `decideCardAuthorization`'s LOCAL check, which already declines a
 * non-active card regardless of what Increase's own record says — so this
 * must never block or reverse the local state change it follows. Degrades to
 * a logged no-op (never throws) without a vendor card id or that
 * environment's API key.
 */
async function setIncreaseCardStatus(
  increaseCardId: string | null,
  status: "active" | "disabled" | "canceled",
): Promise<void> {
  if (!increaseCardId) return;
  const { key, base } = increaseEnvForObjectId(increaseCardId);
  if (!key) {
    console.warn(
      `[cards] setIncreaseCardStatus(${status}) skipped: Increase API key not configured for this card's environment`,
    );
    return;
  }
  try {
    await increasePatch(key, base, `/cards/${increaseCardId}`, { status });
  } catch (err) {
    // Distinctive, greppable prefix — this is the freeze/unfreeze/cancel sync
    // to Increase's OWN Card object failing (the LOCAL state change already
    // took effect either way; RTD declines non-active anyway, defense in
    // depth). Includes the card id + intended status so a future alert on
    // this string can page without re-deriving context from a stack trace.
    console.error(
      `[increase][ALERT] card status sync FAILED — cardId=${increaseCardId} intendedStatus=${status}:`,
      err,
    );
  }
}

// ── Card-spend math (the testable core) ──────────────────────────────────────

/** A transaction that consumes a card's monthly cap: an outflow charged on the
 *  card that hasn't been intentionally excluded. The offsetting repayment credit
 *  is `flow:"transfer"` (not an outflow), so it never counts here. */
function isCardCharge(tr: Doc<"transactions">): boolean {
  return tr.flow === "outflow" && tr.status !== "excluded";
}

/**
 * This-Eastern-month spend on a card, summed from its `by_card` transactions.
 * Bucketed in America/New_York so a late-night charge lands in the right month.
 */
async function cardMonthSpendCents(
  ctx: QueryCtx,
  card: Doc<"cards">,
  now: number,
): Promise<number> {
  const { year, month } = easternParts(now);
  const rows = await ctx.db
    .query("transactions")
    .withIndex("by_card", (q) => q.eq("cardId", card._id))
    .take(CARD_TXN_LIMIT);
  let total = 0;
  for (const tr of rows) {
    // Defense-in-depth: never sum a row linked from another chapter.
    if (tr.chapterId !== card.chapterId) continue;
    if (!isCardCharge(tr)) continue;
    const p = easternParts(tr.postedAt);
    if (p.year === year && p.month === month) total += tr.amountCents;
  }
  return total;
}

/**
 * This-Eastern-month AUTHORIZED spend on a card, summed from its APPROVED
 * `cardAuthorizations`. This is the figure the cap decision uses (NOT settled
 * `transactions`): it counts in-flight authorizations, so a cardholder can't
 * fire ten $400 charges the same afternoon against a $500 cap before any of them
 * settle. Reads newest-first + filters to the current month by `createdAt`,
 * avoiding the ascending-`take` under-count on a long-lived card.
 */
async function cardMonthAuthorizedCents(
  ctx: QueryCtx,
  card: Doc<"cards">,
  now: number,
): Promise<number> {
  const { year, month } = easternParts(now);
  const rows = await ctx.db
    .query("cardAuthorizations")
    .withIndex("by_card", (q) => q.eq("cardId", card._id))
    .order("desc")
    .take(AUTH_SCAN_LIMIT);
  let total = 0;
  for (const a of rows) {
    if (!a.approved) continue;
    const p = easternParts(a.createdAt);
    if (p.year === year && p.month === month) total += a.amountCents;
  }
  return total;
}

/** The read projection the card UIs render (member + manager). Resolves the
 *  cardholder's name + this-month spend. */
async function buildCardSummary(
  ctx: QueryCtx,
  card: Doc<"cards">,
): Promise<CardSummary> {
  const holder = await ctx.db.get(card.cardholderPersonId);
  const spentThisMonthCents = await cardMonthSpendCents(ctx, card, Date.now());
  return {
    id: card._id,
    cardholderPersonId: card.cardholderPersonId,
    cardholderName: holder?.name ?? null,
    type: card.type,
    last4: card.last4 ?? null,
    source: card.source ?? "increase",
    status: card.status,
    monthlyCapCents: card.monthlyCapCents ?? null,
    validFrom: card.validFrom ?? null,
    validUntil: card.validUntil ?? null,
    receiptGraceEndsAt: card.receiptGraceEndsAt ?? null,
    frozenByHolder: card.frozenByHolder === true,
    spentThisMonthCents,
  };
}

/** The read projection both the member "Request a card" status + the manager
 *  pending-requests list render. Resolves the requester's display name. */
async function toCardRequestSummary(
  ctx: QueryCtx,
  r: Doc<"cardRequests">,
): Promise<CardRequestSummary> {
  const person = await ctx.db.get(r.personId);
  return {
    id: r._id,
    personId: r.personId,
    personName: person?.name ?? null,
    status: r.status,
    note: r.note ?? null,
    requestedAt: r.requestedAt,
    decidedAt: r.decidedAt ?? null,
    cardId: r.cardId ?? null,
  };
}

/**
 * The org-wide card-prerequisite course resolved to its catalog entry, or
 * `null` when there is NO EFFECTIVE gate — either none is configured, or the
 * configured slug isn't a real `ACADEMY_COURSES` course (fail-open, exactly
 * like `beginIssueCard`: an unknown course can never be completed, so it can't
 * be allowed to read as "everyone needs training"). Shared by the list queries
 * and `cardPrerequisiteStatus` so they all agree on when a gate is in effect.
 */
async function effectivePrerequisiteCourse(
  ctx: QueryCtx,
): Promise<{ slug: string; title: string } | null> {
  const slug = await readCardPrerequisiteCourseSlug(ctx);
  if (slug === null) return null;
  const course = getAcademyCourse(slug);
  return course ? { slug: course.slug, title: course.title } : null;
}

// ── issueCard (action, manager) ──────────────────────────────────────────────

/**
 * Gate + verify the cardholder + find-or-create the `cards` row. Manager-only.
 * Idempotent-ish: an existing ACTIVE card for the same person is returned as-is
 * (never duplicated). Otherwise a `cards` row is inserted (status "active", no
 * `increaseCardId` yet); the action fills in the Increase card id + last4, or
 * degrades and leaves the row as the dev/no-vendor card.
 */
export const beginIssueCard = internalMutation({
  args: {
    cardholderPersonId: v.id("people"),
    type: cardTypeValidator,
    monthlyCapCents: v.optional(v.number()),
    validFrom: v.optional(v.number()),
    validUntil: v.optional(v.number()),
  },
  returns: v.union(
    v.object({ kind: v.literal("existing"), card: cardSummaryValidator }),
    v.object({
      kind: v.literal("created"),
      card: cardSummaryValidator,
      cardId: v.id("cards"),
      increaseAccountId: v.union(v.string(), v.null()),
      description: v.string(),
      cardholderEmail: v.string(),
    }),
  ),
  handler: async (ctx, args): Promise<IssueCardResult> => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireFinanceManager(ctx, chapterId);

    if (args.monthlyCapCents != null) assertIntegerCents(args.monthlyCapCents);

    const holder = await ctx.db.get(args.cardholderPersonId);
    await requireInChapter(ctx, chapterId, holder, "Cardholder");

    // Cards are restricted to Public Worship staff — reject a cardholder without
    // an `@publicworship.life` email before minting anything.
    if (!isCardEligible(holder!.pwEmail)) {
      throw new ConvexError({
        code: "NOT_CARD_ELIGIBLE",
        message:
          "Cards can only be issued to people with a @publicworship.life email.",
      });
    }

    // Academy-course prerequisite (org-wide, OFF by default). The single hard
    // gate for BOTH issuance paths: `issueCard` (direct) and
    // `decideCardRequest → issueCard` (approved request) both funnel here.
    const prerequisiteSlug = await readCardPrerequisiteCourseSlug(ctx);
    if (prerequisiteSlug !== null) {
      const course = getAcademyCourse(prerequisiteSlug);
      if (course === undefined) {
        // FAIL-OPEN: an unknown / not-yet-authored course can NEVER be
        // completed, so gating on it would brick ALL issuance for the whole
        // org. The settings UI already warns about this misconfiguration, so
        // we skip the gate rather than block everyone.
      } else if (
        !(await hasCompletedCourse(
          ctx,
          chapterId,
          args.cardholderPersonId,
          prerequisiteSlug,
        ))
      ) {
        throw new ConvexError({
          code: "CARD_PREREQUISITE_INCOMPLETE",
          message: `${course.title} must be completed before a card can be issued.`,
        });
      }
    }

    // Mode-aware: issue on the chapter's CURRENT-environment account (never
    // `.first()`, which would arbitrarily pick sandbox-or-prod once both exist).
    const sandboxMode = await readSandbox(ctx);
    const account = await getChapterAccountForMode(ctx, chapterId, sandboxMode);

    // Env-mismatch guard (now a safety net): mode-aware selection already picks
    // the right-environment account, so this only fires on an inconsistent row
    // (e.g. `sandbox:false` but a `sandbox_` id). A null id is env-neutral
    // (degraded/no vendor), so this never blocks the dev path.
    if (account && !matchesMode(account.increaseAccountId ?? null, sandboxMode)) {
      throw new ConvexError({
        code: "ACCOUNT_ENV_MISMATCH",
        message:
          "This chapter's Increase account is a sandbox/test account; remove it and provision a production account before issuing cards.",
      });
    }

    const increaseAccountId =
      account && account.onboardingStatus === "active" && account.increaseAccountId
        ? account.increaseAccountId
        : null;
    const hasKey = !!process.env.INCREASE_API_KEY;

    // Idempotent-ish: don't mint a second ACTIVE card for the same person — but
    // only when the existing active card is in the CURRENT Increase environment.
    // A leftover SANDBOX card (issued while `sandboxMode` was on) must NOT block
    // minting a real PRODUCTION card once the deployment flips to prod: without
    // this the mode-blind match returns the off-mode card as `existing`, no prod
    // card is ever minted, and `listCards`/`myCard` then HIDE that sandbox card
    // (`matchesMode`) — so the holder is left seeing no card at all and issuance
    // silently "fails". A null-id degraded card is env-neutral (`matchesMode` →
    // true), so it still dedups AND still reaches the vendor-retry branch below.
    //
    // INCREASE-SOURCE ONLY: a legacy (Relay) card (`source:"legacy"`, linked by
    // `legacyCards.linkRelayCard`) must NEVER match here. It also has no
    // `increaseCardId`, so before this filter it satisfied the vendor-retry
    // branch below, which then minted a real Increase card and patched the
    // vendor id + Increase last4 ONTO THE RELAY ROW — the new card never
    // appeared in the app (the UI treats a `source:"legacy"` row as
    // Relay-only), and the row's Relay last-4 (the transaction-attribution
    // key) was overwritten. Legacy and Increase cards are meant to coexist as
    // separate rows mid-migration; migration 0059 splits rows this bug fused.
    const existing = await ctx.db
      .query("cards")
      .withIndex("by_cardholder", (q) =>
        q.eq("cardholderPersonId", args.cardholderPersonId),
      )
      .take(CARD_SCAN_LIMIT);
    const activeSame = existing.find(
      (c) =>
        c.chapterId === chapterId &&
        c.status === "active" &&
        (c.source ?? "increase") === "increase" &&
        matchesMode(c.increaseCardId ?? null, sandboxMode),
    );
    if (activeSame) {
      // A previously-degraded row (no `increaseCardId`) is NOT permanently
      // stranded: if the vendor is now reachable (key + active account), RETRY
      // the Increase card creation on the SAME row instead of returning it
      // vendorless forever (it could never authorize otherwise).
      if (!activeSame.increaseCardId && hasKey && increaseAccountId) {
        return {
          kind: "created",
          card: await buildCardSummary(ctx, activeSame),
          cardId: activeSame._id,
          increaseAccountId,
          description: holder!.name,
          cardholderEmail: holder!.pwEmail!,
        };
      }
      return { kind: "existing", card: await buildCardSummary(ctx, activeSame) };
    }

    const now = Date.now();
    const cardId = await ctx.db.insert("cards", {
      chapterId,
      cardholderPersonId: args.cardholderPersonId,
      type: args.type,
      source: "increase",
      status: "active",
      monthlyCapCents: args.monthlyCapCents,
      validFrom: args.validFrom,
      validUntil: args.validUntil,
      createdAt: now,
    });

    const card = (await ctx.db.get(cardId))!;
    return {
      kind: "created",
      card: await buildCardSummary(ctx, card),
      cardId,
      increaseAccountId,
      description: holder!.name,
      cardholderEmail: holder!.pwEmail!,
    };
  },
});

/** Patch the newly-created card with its Increase id + last4. */
export const finishIssueCard = internalMutation({
  args: {
    cardId: v.id("cards"),
    increaseCardId: v.string(),
    last4: v.optional(v.string()),
  },
  returns: cardSummaryValidator,
  handler: async (ctx, args): Promise<CardSummary> => {
    const patch: Partial<Doc<"cards">> = { increaseCardId: args.increaseCardId };
    if (args.last4) patch.last4 = args.last4;
    await ctx.db.patch(args.cardId, patch);
    const card = await ctx.db.get(args.cardId);
    if (!card) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Card row vanished." });
    }
    return buildCardSummary(ctx, card);
  },
});

/**
 * Issue a person-owned card on the chapter's Increase account. Manager-only.
 * DEGRADES (logs + returns, never throws) to a `cards` row WITHOUT an
 * `increaseCardId` when `INCREASE_API_KEY` is unset or the chapter's account
 * isn't active — so the app works in dev without the vendor wired up.
 */
export const issueCard = action({
  args: {
    cardholderPersonId: v.id("people"),
    type: cardTypeValidator,
    monthlyCapCents: v.optional(v.number()),
    validFrom: v.optional(v.number()),
    validUntil: v.optional(v.number()),
  },
  returns: cardSummaryValidator,
  handler: async (ctx, args): Promise<CardSummary> => {
    const prep: IssueCardResult = await ctx.runMutation(
      internal.cards.beginIssueCard,
      args,
    );
    if (prep.kind === "existing") return prep.card;

    // Self-select the Increase env from the chapter account's id prefix: a
    // sandbox-provisioned account (`sandbox_...`) uses the sandbox key + base, a
    // prod account the prod ones — so a card is always issued in the same
    // environment its account lives in.
    const { key, base } = prep.increaseAccountId
      ? increaseEnvForObjectId(prep.increaseAccountId)
      : { key: undefined as string | undefined, base: increaseApiBase() };
    if (!key || !prep.increaseAccountId) {
      console.warn(
        "[cards] issueCard degraded: Increase key for this account's environment / active account not configured — card created without an Increase card id",
      );
      return prep.card;
    }

    // WP-C.2: attach the Digital Card Profile (PW card art) for THIS account's
    // environment, if one has been minted (`increase.ts`'s
    // `createDigitalCardProfile`) — omitted entirely when unconfigured, which
    // is the common case until the pipeline has been run at least once.
    // Increase nests this under `digital_wallet` (grounded against the Cards
    // resource's create body), not at the top level.
    const cardArtProfileId: string | null = await ctx.runQuery(
      internal.increaseCardArt.getCardArtProfileId,
      { sandbox: isSandboxObjectId(prep.increaseAccountId) },
    );

    try {
      const card = await increasePost(key, base, "/cards", {
        account_id: prep.increaseAccountId,
        description: prep.description,
        digital_wallet: buildDigitalWallet(
          prep.cardholderEmail,
          cardArtProfileId,
        ),
      });
      return await ctx.runMutation(internal.cards.finishIssueCard, {
        cardId: prep.cardId,
        increaseCardId: String(card.id),
        last4: card.last4 != null ? String(card.last4) : undefined,
      });
    } catch (err) {
      console.error("[cards] issueCard: Increase card create failed:", err);
      // The `cards` row already exists — leave it as the degraded card.
      return prep.card;
    }
  },
});

// ── listCards / myCard (reads) ───────────────────────────────────────────────

/** The chapter's cards (viewer+) — the manager card view. */
export const listCards = query({
  args: {},
  returns: v.array(cardRowValidator),
  handler: async (ctx): Promise<CardRow[]> => {
    const chapterId = (await getChapterIdOrNull(ctx)) as Id<"chapters"> | null;
    if (!chapterId) return [];
    await requireFinanceRole(ctx, chapterId, "viewer");
    // Filter to the current environment: hide `sandbox_`-issued cards in
    // production mode (and vice-versa); a null-id degraded card is env-neutral
    // and always shows. This is also what keeps card-spend KPI tiles — summed
    // from this filtered list — from counting cross-environment spend.
    const sandboxMode = await readSandbox(ctx);
    const cards = (
      await ctx.db
        .query("cards")
        .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
        .take(CARD_SCAN_LIMIT)
    ).filter((c) => matchesMode(c.increaseCardId ?? null, sandboxMode));
    // Per-cardholder training status for the manager roster's Trained ✓ /
    // Needs training badge — `null` on every row when there's no effective
    // gate. `hasCompletedCourse` is a couple of indexed reads per card; the
    // list is already bounded by CARD_SCAN_LIMIT.
    const course = await effectivePrerequisiteCourse(ctx);
    return Promise.all(
      cards.map(async (c) => ({
        ...(await buildCardSummary(ctx, c)),
        prerequisiteMet: course
          ? await hasCompletedCourse(ctx, chapterId, c.cardholderPersonId, course.slug)
          : null,
      })),
    );
  },
});

/**
 * The caller's own real (non-placeholder) `people` row ids, across EVERY
 * chapter — the same `people.by_user` scan `financeRoles.mySeats` uses for
 * seat resolution. Deliberately NOT scoped to `requireChapterId`/
 * `getChapterIdOrNull`'s single "first `userChapters` membership" home
 * chapter — see `myCard`'s doc comment for why. Also enforces the app's
 * domain-access gate (`requireAccess`), so every caller of this (or of
 * `requireCallerIsHolder` below) gets it for free instead of each site
 * re-deriving it.
 *
 * SHARED by `myCard`'s own card lookup and `requireCallerIsHolder` (every
 * HOLDER-ONLY card action: freeze/unfreeze/reveal/billing-address) so the two
 * can never drift apart again — a card `myCard` surfaces must always be one
 * these same holder-action gates agree the caller owns.
 */
async function callerPersonIds(ctx: QueryCtx): Promise<Id<"people">[]> {
  await requireAccess(ctx);
  const userId = await requireUserId(ctx);
  const people = await ctx.db
    .query("people")
    .withIndex("by_user", (q) => q.eq("userId", userId as Id<"users">))
    .collect();
  return people.filter((p) => p.isPlaceholder !== true).map((p) => p._id);
}

/** Load a card by id, asserting it exists — the holder-action counterpart to
 *  `requireOwnedCard` below (which is the MANAGER flow, chapter-scoped to the
 *  manager's own desk). Ownership for a holder action is checked separately,
 *  via `requireCallerIsHolder`. */
async function requireCard(
  ctx: QueryCtx,
  cardId: Id<"cards">,
): Promise<Doc<"cards">> {
  const card = await ctx.db.get(cardId);
  if (!card) {
    throw new ConvexError({ code: "NOT_FOUND", message: "Card not found." });
  }
  return card;
}

/**
 * Assert the caller is a card's OWN holder — resolved via `callerPersonIds`
 * (the SAME scan `myCard` uses), NEVER via `requireChapterId`'s single "first
 * membership" home chapter. Every HOLDER-ONLY card action gates through this
 * so a card `myCard` surfaces from OUTSIDE the caller's home chapter is still
 * actionable by its real holder — before this helper, `beginFreezeCard`/
 * `beginUnfreezeCard`/`beginRevealCardDetails`/`holderIncreaseEnvForCard`
 * independently re-derived "is the caller the holder" off `getFinanceRole`'s
 * HOME-chapter-scoped `personId`, so a card surfaced from a non-home chapter
 * rendered Freeze/Reveal actions that threw FORBIDDEN when the real holder
 * tapped them. Throws FORBIDDEN for anyone else — including a chapter/central
 * MANAGER (those have their own separate, still chapter-scoped gates:
 * `lockCard`/`unlockCard`/`setCardControls`/`cancelCard`/`requireOwnedCard`
 * below — this never widens who may act, only fixes WHERE the holder is
 * looked up).
 */
async function requireCallerIsHolder(
  ctx: QueryCtx,
  card: Doc<"cards">,
  message = "Only the cardholder can do this.",
): Promise<void> {
  const personIds = await callerPersonIds(ctx);
  if (!personIds.includes(card.cardholderPersonId)) {
    throw new ConvexError({ code: "FORBIDDEN", message });
  }
}

const myCardValidator = v.object({
  cards: v.array(cardSummaryValidator),
  // The caller's most recently issued CANCELED card, when they hold no live
  // (non-canceled) one — surfaced so the member view can explain WHY they're
  // looking at the request-a-card flow instead of just a bare "No card yet"
  // as if they'd never had one. Null the moment a live card exists again
  // (re-issued or otherwise) — see `myCard`'s doc comment.
  lastCanceled: v.union(cardSummaryValidator, v.null()),
});

/** The caller's own card(s) — the member card view (also surfaced at the top
 *  of the manager view — a manager is a cardholder too). Any authed user;
 *  empty when they have no roster row anywhere yet.
 *
 *  DELIBERATELY context-independent: resolved off the caller's OWN `people`
 *  rows (`by_user`, same scan `financeRoles.mySeats` uses for seat
 *  resolution), never off `requireChapterId`/`getChapterIdOrNull`'s "first
 *  `userChapters` membership" home chapter. Two reasons that matters here:
 *   1. The Cards screen doesn't thread `ChapterContext` at all (no `chapterId`
 *      arg) — a manager sitting at a Central desk, or peeking another
 *      chapter, must still see THEIR OWN card, not nothing / not the peeked
 *      chapter's.
 *   2. `requireChapterId`'s single-membership limitation (see its own TODO)
 *      would silently miss a genuinely multi-chapter person's card if their
 *      roster row happens to live outside the "first" membership. Scanning
 *      every real `people` row sidesteps that entirely.
 *  `cardholderPersonId` already pins each card to one person's one chapter,
 *  so no extra chapter filter is needed once scoped by person id.
 *
 *  A CANCELED card is never returned in `cards` (the primary pick) — a
 *  cardholder whose only card is canceled must reach the request-a-card
 *  flow, not stare at a dead card with no explanation. Its replacement is
 *  `lastCanceled`: set ONLY when there's no live card to show instead, so a
 *  canceled-then-reissued holder just sees their active card as normal. */
export const myCard = query({
  args: {},
  returns: myCardValidator,
  handler: async (ctx) => {
    const personIds = await callerPersonIds(ctx);
    if (personIds.length === 0) return { cards: [], lastCanceled: null };

    const sandboxMode = await readSandbox(ctx);
    const cardsByPerson = await Promise.all(
      personIds.map((personId) =>
        ctx.db
          .query("cards")
          .withIndex("by_cardholder", (q) => q.eq("cardholderPersonId", personId))
          .take(CARD_SCAN_LIMIT),
      ),
    );
    // Same environment filter as listCards: hide cross-env cards.
    const inScope = cardsByPerson
      .flat()
      .filter((c) => matchesMode(c.increaseCardId ?? null, sandboxMode));

    const live = inScope.filter((c) => c.status !== "canceled");
    if (live.length > 0) {
      return {
        cards: await Promise.all(live.map((c) => buildCardSummary(ctx, c))),
        lastCanceled: null,
      };
    }

    const canceled = inScope.filter((c) => c.status === "canceled");
    if (canceled.length === 0) return { cards: [], lastCanceled: null };
    // No `canceledAt` timestamp exists on the row; `createdAt` is the closest
    // proxy for "most recent" across repeated issue/cancel cycles.
    const mostRecent = canceled.reduce((a, b) =>
      b.createdAt > a.createdAt ? b : a,
    );
    return { cards: [], lastCanceled: await buildCardSummary(ctx, mostRecent) };
  },
});

// ── lockCard / unlockCard / setCardControls (manager mutations) ──────────────

async function requireOwnedCard(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
  cardId: Id<"cards">,
): Promise<Doc<"cards">> {
  const card = await ctx.db.get(cardId);
  await requireInChapter(ctx, chapterId, card, "Card");
  return card!;
}

/** Lock a card (manager). No new authorizations approve while locked.
 *  Rejects a legacy (Relay) card: we have no way to stop its authorizations,
 *  so "locked" there would be a claim rather than a control
 *  (`canEnforceCardLock`). The manager card list already hides these rows, so
 *  this is a server-side backstop, not a reachable UI path. */
export const lockCard = mutation({
  args: { cardId: v.id("cards") },
  returns: cardSummaryValidator,
  handler: async (ctx, { cardId }): Promise<CardSummary> => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireFinanceManager(ctx, chapterId);
    const card = await requireOwnedCard(ctx, chapterId, cardId);
    if (!canEnforceCardLock(card)) {
      throw new ConvexError({
        code: "CARD_NOT_LOCKABLE",
        message:
          "This is a linked Relay card — Public Worship doesn't issue it, so it can't be locked from here. Lock it in Relay instead.",
      });
    }
    await ctx.db.patch(card._id, { status: "locked" });
    return buildCardSummary(ctx, (await ctx.db.get(card._id))!);
  },
});

/** Unlock a card (manager). Clears the receipt grace window (the receipt was
 *  uploaded / the block is resolved) AND any holder self-freeze — a manager's
 *  unlock is the superset power that lifts EVERY lock reason at once. */
export const unlockCard = mutation({
  args: { cardId: v.id("cards") },
  returns: cardSummaryValidator,
  handler: async (ctx, { cardId }): Promise<CardSummary> => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireFinanceManager(ctx, chapterId);
    const card = await requireOwnedCard(ctx, chapterId, cardId);
    await ctx.db.patch(card._id, {
      status: "active",
      receiptGraceEndsAt: undefined,
      frozenByHolder: undefined,
    });
    return buildCardSummary(ctx, (await ctx.db.get(card._id))!);
  },
});

/** Update the TWO card controls: the monthly cap + the validity window
 *  (manager). Nothing else on a card is settable here. `null` clears a control. */
export const setCardControls = mutation({
  args: {
    cardId: v.id("cards"),
    monthlyCapCents: v.optional(v.union(v.number(), v.null())),
    validFrom: v.optional(v.union(v.number(), v.null())),
    validUntil: v.optional(v.union(v.number(), v.null())),
  },
  returns: cardSummaryValidator,
  handler: async (ctx, args): Promise<CardSummary> => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireFinanceManager(ctx, chapterId);
    const card = await requireOwnedCard(ctx, chapterId, args.cardId);
    if (typeof args.monthlyCapCents === "number") {
      assertIntegerCents(args.monthlyCapCents, "Monthly cap");
    }
    const patch: Partial<Doc<"cards">> = {};
    if (args.monthlyCapCents !== undefined) {
      patch.monthlyCapCents = args.monthlyCapCents ?? undefined;
    }
    if (args.validFrom !== undefined) patch.validFrom = args.validFrom ?? undefined;
    if (args.validUntil !== undefined) {
      patch.validUntil = args.validUntil ?? undefined;
    }
    await ctx.db.patch(card._id, patch);
    return buildCardSummary(ctx, (await ctx.db.get(card._id))!);
  },
});

// ── Merchant allow-list (chapter policy) ─────────────────────────────────────

// Bound the allow-list config doc: a modest, single-doc policy — the entry
// count + per-entry length caps keep the arrays far from any document limit.
const MERCHANT_ALLOWLIST_MAX_ENTRIES = 100;
const MERCHANT_ALLOWLIST_ENTRY_MAX = 100;
// Category entries are exactly the 4-digit MCC Increase sends on an
// authorization (`merchant_category_code`).
const MCC_RE = /^\d{4}$/;

/** The chapter's merchant allow-list row, or null before one's ever been set. */
async function readMerchantPolicy(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
): Promise<Doc<"cardMerchantPolicy"> | null> {
  return await ctx.db
    .query("cardMerchantPolicy")
    .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
    .first();
}

/** The read projection the allow-list UI renders. A missing row reads as the
 *  safe default: enforcement off, nothing listed. */
function toMerchantPolicySummary(
  policy: Doc<"cardMerchantPolicy"> | null,
): MerchantPolicySummary {
  return {
    enforced: policy?.enforced ?? false,
    allowedMerchantNames: policy?.allowedMerchantNames ?? [],
    allowedMerchantCategories: policy?.allowedMerchantCategories ?? [],
  };
}

/** Trim, drop empties, enforce the per-entry length cap, and de-duplicate
 *  case-insensitively (first casing wins — matching is case-insensitive
 *  anyway, so "Costco" + "COSTCO" would be the same entry twice). */
function normalizeAllowlistEntries(entries: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of entries) {
    const entry = raw.trim();
    if (!entry) continue;
    if (entry.length > MERCHANT_ALLOWLIST_ENTRY_MAX) {
      throw new ConvexError({
        code: "ALLOWLIST_ENTRY_TOO_LONG",
        message: `Allow-list entries are capped at ${MERCHANT_ALLOWLIST_ENTRY_MAX} characters.`,
      });
    }
    const key = entry.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

/** The chapter's merchant allow-list (viewer+ — the same floor as `listCards`,
 *  so the Cards tab can show the policy state). Safe defaults (enforcement
 *  off, empty lists) before a manager ever saves one. */
export const getMerchantPolicy = query({
  args: {},
  returns: merchantPolicyValidator,
  handler: async (ctx): Promise<MerchantPolicySummary> => {
    const chapterId = (await getChapterIdOrNull(ctx)) as Id<"chapters"> | null;
    if (!chapterId) return toMerchantPolicySummary(null);
    await requireFinanceRole(ctx, chapterId, "viewer");
    return toMerchantPolicySummary(await readMerchantPolicy(ctx, chapterId));
  },
});

/**
 * Replace the chapter's merchant allow-list + enforcement toggle (manager).
 * Entries are normalized (trimmed, de-duplicated case-insensitively) and
 * BOUNDED; category entries must be 4-digit MCCs — the finance manager pastes
 * codes off the card network's list, and a malformed one would silently never
 * match anything. Enforcement only bites when the list is non-empty (see
 * `decideAgainstMerchantPolicy`), so flipping the toggle on an empty list can
 * never brick every card at once.
 */
export const setMerchantPolicy = mutation({
  args: {
    enforced: v.boolean(),
    allowedMerchantNames: v.array(v.string()),
    allowedMerchantCategories: v.array(v.string()),
  },
  returns: merchantPolicyValidator,
  handler: async (ctx, args): Promise<MerchantPolicySummary> => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    const access = await requireFinanceManager(ctx, chapterId);

    const names = normalizeAllowlistEntries(args.allowedMerchantNames);
    const categories = normalizeAllowlistEntries(args.allowedMerchantCategories);
    for (const code of categories) {
      if (!MCC_RE.test(code)) {
        throw new ConvexError({
          code: "INVALID_MERCHANT_CATEGORY",
          message: `"${code}" isn't a merchant category code — use the 4-digit MCC (e.g. 5411 for grocery stores).`,
        });
      }
    }
    if (names.length + categories.length > MERCHANT_ALLOWLIST_MAX_ENTRIES) {
      throw new ConvexError({
        code: "ALLOWLIST_TOO_LARGE",
        message: `The allow-list is capped at ${MERCHANT_ALLOWLIST_MAX_ENTRIES} entries.`,
      });
    }

    const existing = await readMerchantPolicy(ctx, chapterId);
    const fields = {
      enforced: args.enforced,
      allowedMerchantNames: names,
      allowedMerchantCategories: categories,
      updatedByPersonId: access.personId ?? undefined,
      updatedAt: Date.now(),
    };
    if (existing) {
      await ctx.db.patch(existing._id, fields);
    } else {
      await ctx.db.insert("cardMerchantPolicy", { chapterId, ...fields });
    }
    return toMerchantPolicySummary(await readMerchantPolicy(ctx, chapterId));
  },
});

// ── freezeCard / unfreezeCard (HOLDER-ONLY self-serve) ───────────────────────

/**
 * Gate + flip local state for a self-serve freeze. HOLDER-ONLY (never a
 * manager — managers keep the separate `lockCard`, which stays untouched).
 * Only transitions an ACTIVE card to `locked` + `frozenByHolder:true`; a card
 * already locked for ANY other reason (a manager lock, or the receipt
 * auto-lock) is left exactly as-is — freezing on top of it is redundant (the
 * card is already declining authorizations) and must NOT claim
 * `frozenByHolder`, which would let a later self-`unfreezeCard` wrongly lift a
 * lock reason the holder didn't create. Idempotent re-freeze of an
 * already-holder-frozen card is a no-op.
 */
export const beginFreezeCard = internalMutation({
  args: { cardId: v.id("cards") },
  returns: v.object({
    summary: cardSummaryValidator,
    increaseCardId: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, { cardId }) => {
    const card = await requireCard(ctx, cardId);
    await requireCallerIsHolder(
      ctx,
      card,
      "Only the cardholder can freeze their own card.",
    );
    if (card.status === "canceled") {
      throw new ConvexError({
        code: "ILLEGAL_TRANSITION",
        message: "A canceled card can't be frozen.",
      });
    }
    // A legacy (Relay) card can't be frozen for the same reason it can't be
    // auto-locked (`canEnforceCardLock`) — and here the false claim would be
    // the most dangerous one in the app: a holder who thinks a lost card is
    // frozen stops treating it as lost. Refuse, and say where the real freeze
    // button is. `MyCardSection` never surfaces a legacy row as the freezable
    // card, so this is a backstop rather than a reachable path — but it also
    // closes the receipt re-lock branch in `finishUnfreezeCard`, which can only
    // be reached through a freeze.
    if (!canEnforceCardLock(card)) {
      throw new ConvexError({
        code: "CARD_NOT_LOCKABLE",
        message:
          "This is a linked Relay card — Public Worship doesn't issue it and can't freeze it. If it's lost or stolen, freeze it in Relay and tell your finance manager now.",
      });
    }
    if (card.status === "active") {
      await ctx.db.patch(card._id, { status: "locked", frozenByHolder: true });
    }
    const fresh = (await ctx.db.get(card._id))!;
    return {
      summary: await buildCardSummary(ctx, fresh),
      increaseCardId: fresh.increaseCardId ?? null,
    };
  },
});

/**
 * Self-serve freeze: the cardholder locks their OWN card instantly (suspected
 * foul play) — instant + reversible by them, distinct from the receipt
 * auto-lock. Declines real-time authorizations immediately (`status:"locked"`
 * is what `decideCardAuthorization` checks). Best-effort syncs the freeze to
 * Increase's own Card `status:"disabled"` when a vendor card id + key are
 * present (degrades to a logged no-op otherwise — the local freeze always
 * takes effect either way).
 */
export const freezeCard = action({
  args: { cardId: v.id("cards") },
  returns: cardSummaryValidator,
  handler: async (ctx, { cardId }): Promise<CardSummary> => {
    const prep = await ctx.runMutation(internal.cards.beginFreezeCard, {
      cardId,
    });
    await setIncreaseCardStatus(prep.increaseCardId, "disabled");
    return prep.summary;
  },
});

/**
 * Gate + flip local state for a self-serve unfreeze. HOLDER-ONLY, and ONLY
 * reverses the HOLDER'S OWN freeze (`frozenByHolder`) — it must NOT be able to
 * lift a manager lock or the receipt auto-lock (those need `unlockCard` / a
 * fresh receipt respectively). Because `beginFreezeCard` never sets
 * `frozenByHolder` on a card that's locked for another reason, a card that
 * reaches here with `frozenByHolder:true` is GUARANTEED to have no
 * independent lock reason underneath.
 *
 * Reactivating isn't unconditional, though: an overdue missing-receipt charge
 * could have accrued WHILE the card sat frozen, and the daily
 * `autoLockOverdueCards` sweep won't see it again until it next runs — up to
 * ~24h during which the card would authorize despite the overdue receipt.
 * So before reactivating, this re-runs the EXACT SAME eligibility check the
 * cron uses (`isOverdueReceiptCharge`, same `RECEIPT_GRACE_DAYS` cutoff): if
 * an overdue charge remains, land on `"locked"` + a freshly stamped
 * `receiptGraceEndsAt` (identical shape to the cron's own stamp) instead of
 * `"active"` — never `frozenByHolder`, since the lock reason is now the
 * receipt, not the holder's freeze. The caller gets back which branch it took
 * (`kind`) so the UI can explain the outcome.
 */
export const beginUnfreezeCard = internalMutation({
  args: { cardId: v.id("cards") },
  returns: v.object({
    summary: cardSummaryValidator,
    increaseCardId: v.union(v.string(), v.null()),
    kind: v.union(v.literal("active"), v.literal("receipt_locked")),
  }),
  handler: async (ctx, { cardId }) => {
    const card = await requireCard(ctx, cardId);
    await requireCallerIsHolder(
      ctx,
      card,
      "Only the cardholder can unfreeze their own card.",
    );
    if (card.status !== "locked" || !card.frozenByHolder) {
      throw new ConvexError({
        code: "ILLEGAL_TRANSITION",
        message:
          "This card isn't frozen by you — ask a finance manager to unlock it.",
      });
    }

    // Same predicate + cutoff as `autoLockOverdueCards` — reuse, don't
    // duplicate the grace-window threshold.
    const cutoff = Date.now() - RECEIPT_GRACE_DAYS * DAY_MS;
    const txns = await ctx.db
      .query("transactions")
      .withIndex("by_card", (q) => q.eq("cardId", cardId))
      .order("desc")
      .take(CARD_TXN_LIMIT);
    const overdue = txns.filter((tr) => isOverdueReceiptCharge(tr, card, cutoff));

    if (overdue.length > 0) {
      const earliest = Math.min(...overdue.map((tr) => tr.postedAt));
      await ctx.db.patch(card._id, {
        status: "locked",
        frozenByHolder: undefined,
        receiptGraceEndsAt: earliest + RECEIPT_GRACE_DAYS * DAY_MS,
      });
      const fresh = (await ctx.db.get(card._id))!;
      return {
        summary: await buildCardSummary(ctx, fresh),
        increaseCardId: fresh.increaseCardId ?? null,
        kind: "receipt_locked" as const,
      };
    }

    await ctx.db.patch(card._id, {
      status: "active",
      frozenByHolder: undefined,
    });
    const fresh = (await ctx.db.get(card._id))!;
    return {
      summary: await buildCardSummary(ctx, fresh),
      increaseCardId: fresh.increaseCardId ?? null,
      kind: "active" as const,
    };
  },
});

/** Self-serve unfreeze: reverses the holder's OWN `freezeCard` — UNLESS an
 *  overdue missing-receipt charge accrued while frozen, in which case the
 *  card lands `"locked"` for the receipt instead (see `beginUnfreezeCard`).
 *  Best-effort syncs to Increase's own `status`: `"active"` on a full
 *  reactivation, `"disabled"` when it lands receipt-locked instead (same
 *  degrade as `freezeCard` either way). */
export const unfreezeCard = action({
  args: { cardId: v.id("cards") },
  returns: v.object({
    card: cardSummaryValidator,
    kind: v.union(v.literal("active"), v.literal("receipt_locked")),
  }),
  handler: async (ctx, { cardId }): Promise<UnfreezeCardResult> => {
    const prep = await ctx.runMutation(internal.cards.beginUnfreezeCard, {
      cardId,
    });
    await setIncreaseCardStatus(
      prep.increaseCardId,
      prep.kind === "active" ? "active" : "disabled",
    );
    return { card: prep.summary, kind: prep.kind };
  },
});

// ── cancelCard (FM + Treasurer ONLY — never self-serve) ──────────────────────

/**
 * Gate + flip local state for a permanent cancel. FM + Treasurer ONLY
 * (`requireFinanceManager` — chapter finance-manager rank; a central FM grant
 * satisfies it too). Terminal: `status:"canceled"` clears every other lock
 * marker and is excluded from `decideCardAuthorization` (any non-"active"
 * status declines) and the receipt auto-lock / reminder sweeps (both already
 * skip a canceled card). Idempotent: canceling an already-canceled card is a
 * no-op.
 */
export const beginCancelCard = internalMutation({
  args: { cardId: v.id("cards") },
  returns: v.object({
    summary: cardSummaryValidator,
    increaseCardId: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, { cardId }) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireFinanceManager(ctx, chapterId);
    const card = await requireOwnedCard(ctx, chapterId, cardId);
    if (card.status !== "canceled") {
      await ctx.db.patch(card._id, {
        status: "canceled",
        frozenByHolder: undefined,
        receiptGraceEndsAt: undefined,
      });
    }
    const fresh = (await ctx.db.get(card._id))!;
    return {
      summary: await buildCardSummary(ctx, fresh),
      increaseCardId: fresh.increaseCardId ?? null,
    };
  },
});

/**
 * Cancel/close a card PERMANENTLY. FM + Treasurer only — NOT self-serve (a
 * cardholder can only freeze/unfreeze, never cancel their own card). Best-
 * effort syncs to Increase's `status:"canceled"` when a vendor card id + key
 * are present (degrades to a logged no-op otherwise — the local cancel always
 * takes effect).
 */
export const cancelCard = action({
  args: { cardId: v.id("cards") },
  returns: cardSummaryValidator,
  handler: async (ctx, { cardId }): Promise<CardSummary> => {
    const prep = await ctx.runMutation(internal.cards.beginCancelCard, {
      cardId,
    });
    await setIncreaseCardStatus(prep.increaseCardId, "canceled");
    return prep.summary;
  },
});

// ── Request-a-card (member requests → FM/Treasurer approves/denies) ──────────

// Bounds a chapter's card requests (a small table, mirrors the other small-
// table scan limits in this file).
const CARD_REQUEST_SCAN_LIMIT = 2000;
// A request note is a short "why I need this" — bounded defensively (never
// escaped/emailed, but still capped so a pasted essay can't bloat the row).
const CARD_REQUEST_NOTE_MAX = 500;

/**
 * Submit a request for a card. Self-serve (any roster person — no finance-role
 * gate), but the eligibility gate matches `issueCard`'s: only people with a
 * `@publicworship.life` email may request one. At most ONE open
 * (`"requested"`) request per person at a time; a second attempt while one is
 * pending throws. Also refuses a request while the person already holds a
 * live (non-canceled) card on this chapter — approving it would just replay
 * `issueCard`'s own "existing active card" idempotency, which is confusing to
 * surface as a fresh "requested" row.
 */
export const requestCard = mutation({
  args: { note: v.optional(v.string()) },
  returns: cardRequestSummaryValidator,
  handler: async (ctx, { note }): Promise<CardRequestSummary> => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    const person = await viewerPerson(ctx, chapterId);
    if (!person) {
      throw new ConvexError({
        code: "NO_PERSON",
        message: "You don't have a roster profile in this chapter yet.",
      });
    }
    if (!isCardEligible(person.pwEmail)) {
      throw new ConvexError({
        code: "NOT_CARD_ELIGIBLE",
        message:
          "Cards can only be issued to people with a @publicworship.life email.",
      });
    }

    const existingRequests = await ctx.db
      .query("cardRequests")
      .withIndex("by_person", (q) => q.eq("personId", person._id))
      .take(CARD_REQUEST_SCAN_LIMIT);
    const openSame = existingRequests.find(
      (r) => r.chapterId === chapterId && r.status === "requested",
    );
    if (openSame) {
      throw new ConvexError({
        code: "ALREADY_REQUESTED",
        message: "You already have a pending card request.",
      });
    }

    // Mirror `beginIssueCard`'s environment-aware idempotency: only a live card
    // IN THE CURRENT Increase environment blocks a new request. A leftover
    // off-mode (e.g. sandbox) card must not strand a `@publicworship.life`
    // staffer on "You already have a card" once the deployment flips to prod.
    // Increase-source only, same as `beginIssueCard`'s dedup: a legacy (Relay)
    // card is exactly what a member mid-migration is requesting a REAL card to
    // replace — it must not read as "already has a card".
    const sandboxMode = await readSandbox(ctx);
    const existingCards = await ctx.db
      .query("cards")
      .withIndex("by_cardholder", (q) => q.eq("cardholderPersonId", person._id))
      .take(CARD_SCAN_LIMIT);
    if (
      existingCards.some(
        (c) =>
          c.chapterId === chapterId &&
          c.status !== "canceled" &&
          (c.source ?? "increase") === "increase" &&
          matchesMode(c.increaseCardId ?? null, sandboxMode),
      )
    ) {
      throw new ConvexError({
        code: "ALREADY_HAS_CARD",
        message: "You already have a card on this chapter.",
      });
    }

    const requestId = await ctx.db.insert("cardRequests", {
      chapterId,
      personId: person._id,
      status: "requested",
      note: note?.trim() ? note.trim().slice(0, CARD_REQUEST_NOTE_MAX) : undefined,
      requestedAt: Date.now(),
    });
    return toCardRequestSummary(ctx, (await ctx.db.get(requestId))!);
  },
});

/** The caller's own most recent card request — the "My card" status surface.
 *  Returns `null` once it's been APPROVED (the resulting card, via `myCard`,
 *  is the source of truth from then on — showing a stale "approved" banner
 *  forever would be noise) or when there's none/no chapter/roster row yet. */
export const myCardRequest = query({
  args: {},
  returns: v.union(cardRequestRowValidator, v.null()),
  handler: async (ctx): Promise<CardRequestRow | null> => {
    const chapterId = await getChapterIdOrNull(ctx);
    if (!chapterId) return null;
    const person = await viewerPerson(ctx, chapterId as Id<"chapters">);
    if (!person) return null;
    const rows = await ctx.db
      .query("cardRequests")
      .withIndex("by_person", (q) => q.eq("personId", person._id))
      .order("desc")
      .take(CARD_REQUEST_SCAN_LIMIT);
    const mine = rows.filter((r) => r.chapterId === chapterId);
    const latest = mine[0];
    if (!latest || latest.status === "approved") return null;
    const course = await effectivePrerequisiteCourse(ctx);
    return {
      ...(await toCardRequestSummary(ctx, latest)),
      prerequisiteMet: course
        ? await hasCompletedCourse(ctx, chapterId as Id<"chapters">, person._id, course.slug)
        : null,
    };
  },
});

/** The chapter's OPEN (`"requested"`) card requests — the manager Cards
 *  view's pending-requests list. Viewer+ gated (same floor as `listCards`);
 *  only a finance manager can actually decide one (`decideCardRequest`). */
export const listCardRequests = query({
  args: {},
  returns: v.array(cardRequestRowValidator),
  handler: async (ctx): Promise<CardRequestRow[]> => {
    const chapterId = (await getChapterIdOrNull(ctx)) as Id<"chapters"> | null;
    if (!chapterId) return [];
    await requireFinanceRole(ctx, chapterId, "viewer");
    const rows = await ctx.db
      .query("cardRequests")
      .withIndex("by_chapter_and_status", (q) =>
        q.eq("chapterId", chapterId).eq("status", "requested"),
      )
      .take(CARD_REQUEST_SCAN_LIMIT);
    // Whether each requester has finished the org's card-prerequisite course —
    // so a manager sees Trained ✓ / Needs training before approving. `null`
    // on every row when there's no effective gate.
    const course = await effectivePrerequisiteCourse(ctx);
    return Promise.all(
      rows.map(async (r) => ({
        ...(await toCardRequestSummary(ctx, r)),
        prerequisiteMet: course
          ? await hasCompletedCourse(ctx, chapterId, r.personId, course.slug)
          : null,
      })),
    );
  },
});

/**
 * The org-wide card-prerequisite course + whether a person has completed it —
 * the read behind the "Complete <course> to get a card" member note and the
 * "Trained ✓ / Needs training" hint in the Issue-card flow. Returns `null`
 * whenever there's NO EFFECTIVE gate (none configured, or the configured slug
 * isn't a real course → fail-open, matching `beginIssueCard`).
 *
 * `personId` OMITTED → the CALLER's own status (any member, no finance role).
 * `personId` GIVEN → that person's status; viewer+ gated and chapter-scoped,
 * for the manager Issue-card flow inspecting a pickable cardholder. Card
 * completion is already chapter-visible (see `courseCompleters`), so this
 * exposes nothing new.
 */
export const cardPrerequisiteStatus = query({
  args: { personId: v.optional(v.id("people")) },
  returns: v.union(
    v.object({ slug: v.string(), title: v.string(), met: v.boolean() }),
    v.null(),
  ),
  handler: async (
    ctx,
    { personId },
  ): Promise<{ slug: string; title: string; met: boolean } | null> => {
    const chapterId = (await getChapterIdOrNull(ctx)) as Id<"chapters"> | null;
    if (!chapterId) return null;
    const course = await effectivePrerequisiteCourse(ctx);
    if (!course) return null;

    let target: Id<"people">;
    if (personId) {
      await requireFinanceRole(ctx, chapterId, "viewer");
      const person = await ctx.db.get(personId);
      await requireInChapter(ctx, chapterId, person, "Person");
      target = personId;
    } else {
      const me = await viewerPerson(ctx, chapterId);
      if (!me) return null;
      target = me._id;
    }
    return {
      slug: course.slug,
      title: course.title,
      met: await hasCompletedCourse(ctx, chapterId, target, course.slug),
    };
  },
});

/** Gate + verify a pending request the caller (an FM/Treasurer) is about to
 *  decide. Returns the decider's own resolved person id (to stamp
 *  `decidedBy`) alongside the request's target person. */
export const beginDecideCardRequest = internalMutation({
  args: { requestId: v.id("cardRequests") },
  returns: v.object({
    personId: v.id("people"),
    deciderPersonId: v.union(v.id("people"), v.null()),
  }),
  handler: async (ctx, { requestId }) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    const access = await requireFinanceManager(ctx, chapterId);
    const request = await ctx.db.get(requestId);
    await requireInChapter(ctx, chapterId, request, "Card request");
    if (request!.status !== "requested") {
      throw new ConvexError({
        code: "ILLEGAL_TRANSITION",
        message: "This request has already been decided.",
      });
    }
    return {
      personId: request!.personId,
      deciderPersonId: access.personId,
    };
  },
});

/** Patch a decided request's terminal state. */
export const finishDecideCardRequest = internalMutation({
  args: {
    requestId: v.id("cardRequests"),
    status: v.union(v.literal("approved"), v.literal("denied")),
    cardId: v.optional(v.id("cards")),
    decidedByPersonId: v.union(v.id("people"), v.null()),
  },
  returns: cardRequestSummaryValidator,
  handler: async (ctx, args): Promise<CardRequestSummary> => {
    await ctx.db.patch(args.requestId, {
      status: args.status,
      cardId: args.cardId,
      decidedBy: args.decidedByPersonId ?? undefined,
      decidedAt: Date.now(),
    });
    return toCardRequestSummary(ctx, (await ctx.db.get(args.requestId))!);
  },
});

/**
 * Approve or deny a pending card request. FM/Treasurer only
 * (`requireFinanceManager`, enforced in `beginDecideCardRequest`). Approving
 * triggers the EXISTING `issueCard` flow (digital/virtual only — Cards v2 is
 * digital-only, see the Phase 3.5 PRD intro) for the requester, so issuance
 * keeps its one code path (dedup, env selection, degrade) rather than a
 * second copy here; denying just records the decision.
 */
export const decideCardRequest = action({
  args: {
    requestId: v.id("cardRequests"),
    decision: v.union(v.literal("approve"), v.literal("deny")),
  },
  returns: cardRequestSummaryValidator,
  handler: async (ctx, args): Promise<CardRequestSummary> => {
    const prep = await ctx.runMutation(internal.cards.beginDecideCardRequest, {
      requestId: args.requestId,
    });

    if (args.decision === "deny") {
      return await ctx.runMutation(internal.cards.finishDecideCardRequest, {
        requestId: args.requestId,
        status: "denied",
        decidedByPersonId: prep.deciderPersonId,
      });
    }

    const card = await ctx.runAction(api.cards.issueCard, {
      cardholderPersonId: prep.personId,
      type: "virtual",
    });
    return await ctx.runMutation(internal.cards.finishDecideCardRequest, {
      requestId: args.requestId,
      status: "approved",
      cardId: card.id,
      decidedByPersonId: prep.deciderPersonId,
    });
  },
});

// ── decideCardAuthorization (INTERNAL — the real-time decision) ──────────────

/** The pure decision: DECLINE when the card is missing / not active, out of the
 *  validity window, or the charge would exceed the monthly cap; else APPROVE. */
function decideAgainstCard(
  card: Doc<"cards">,
  amountCents: number,
  monthSpendCents: number,
  now: number,
): { approved: boolean; reason?: string } {
  if (card.status !== "active") {
    return { approved: false, reason: `card ${card.status}` };
  }
  if (card.validFrom != null && now < card.validFrom) {
    return { approved: false, reason: "before validity window" };
  }
  if (card.validUntil != null && now > card.validUntil) {
    return { approved: false, reason: "after validity window" };
  }
  if (
    card.monthlyCapCents != null &&
    monthSpendCents + amountCents > card.monthlyCapCents
  ) {
    return { approved: false, reason: "monthly cap exceeded" };
  }
  return { approved: true };
}

/** The pure merchant decision: DECLINE when the chapter's allow-list is
 *  ENFORCED and NON-EMPTY and the merchant matches no entry — name entries
 *  are case-insensitive substrings of the merchant descriptor, category
 *  entries exact 4-digit MCC matches; ANY one match approves. No policy row,
 *  enforcement off, or an empty list never declines, so behavior without a
 *  configured allow-list is exactly as before it existed. An authorization
 *  carrying NO merchant data can't match an entry, so under an enforced
 *  non-empty list it declines. */
function decideAgainstMerchantPolicy(
  policy: Doc<"cardMerchantPolicy"> | null,
  merchantName: string | undefined,
  merchantCategory: string | undefined,
): { approved: boolean; reason?: string } {
  if (!policy || !policy.enforced) return { approved: true };
  const names = policy.allowedMerchantNames;
  const categories = policy.allowedMerchantCategories;
  if (names.length + categories.length === 0) return { approved: true };
  const descriptor = (merchantName ?? "").toLowerCase();
  if (descriptor && names.some((n) => descriptor.includes(n.toLowerCase()))) {
    return { approved: true };
  }
  if (merchantCategory != null && categories.includes(merchantCategory)) {
    return { approved: true };
  }
  return { approved: false, reason: "merchant not on allow-list" };
}

/**
 * The real-time card-authorization decision. The orchestrator's Increase
 * webhook (`card_authorization` / `real_time_decision`) calls this synchronously
 * and responds to Increase with the result. Looks the card up by
 * `increaseCardId`, decides against the two controls + lock state + the
 * chapter's merchant allow-list (`decideAgainstMerchantPolicy`), and logs a
 * `cardAuthorizations` row every time. NEVER throws — a thrown decision would
 * wrongly decline/hang the network — so any internal error defaults to DECLINE.
 * Idempotent per `increaseAuthId`: a retried authorization returns the same
 * recorded decision without a second log row.
 */
export const decideCardAuthorization = internalMutation({
  args: {
    increaseCardId: v.string(),
    increaseAuthId: v.string(),
    amountCents: v.number(),
    merchantName: v.optional(v.string()),
    merchantCategory: v.optional(v.string()),
  },
  returns: authDecisionValidator,
  handler: async (
    ctx,
    args,
  ): Promise<{ approved: boolean; reason?: string }> => {
    try {
      // Idempotent: replay the recorded decision for a retried authorization.
      const prior = await ctx.db
        .query("cardAuthorizations")
        .withIndex("by_increase_auth", (q) =>
          q.eq("increaseAuthId", args.increaseAuthId),
        )
        .first();
      if (prior) {
        return prior.reason
          ? { approved: prior.approved, reason: prior.reason }
          : { approved: prior.approved };
      }

      const card = await ctx.db
        .query("cards")
        .withIndex("by_increase_card", (q) =>
          q.eq("increaseCardId", args.increaseCardId),
        )
        .first();
      if (!card) {
        // No card row to attach a log to (cardAuthorizations requires a cardId).
        return { approved: false, reason: "unknown card" };
      }

      const now = Date.now();
      // Cap check counts APPROVED authorizations this month (in-flight +
      // settled), NOT just settled transactions — otherwise a burst of
      // unsettled charges blows through the cap before any transaction posts.
      const monthAuthorizedCents = await cardMonthAuthorizedCents(ctx, card, now);
      let decision = decideAgainstCard(
        card,
        args.amountCents,
        monthAuthorizedCents,
        now,
      );
      // Chapter merchant allow-list — checked only once the card itself would
      // approve, so a lock/validity/cap decline keeps its more specific reason.
      if (decision.approved) {
        const policy = await readMerchantPolicy(ctx, card.chapterId);
        decision = decideAgainstMerchantPolicy(
          policy,
          args.merchantName,
          args.merchantCategory,
        );
      }

      await ctx.db.insert("cardAuthorizations", {
        chapterId: card.chapterId,
        cardId: card._id,
        increaseAuthId: args.increaseAuthId,
        amountCents: args.amountCents,
        merchantName: args.merchantName,
        merchantCategory: args.merchantCategory,
        approved: decision.approved,
        reason: decision.reason,
        createdAt: now,
      });
      return decision;
    } catch (err) {
      // A thrown decision would wrongly decline/hang — default to DECLINE.
      console.error("[cards] decideCardAuthorization error:", err);
      return { approved: false, reason: "internal error" };
    }
  },
});

/** The `card_authorization` shape on a fetched Increase RealTimeDecision object
 *  (GET /real_time_decisions/{id}). `settlement_amount` is the cents to check
 *  against the card's cap. */
interface RtdCardAuthorization {
  card_id?: string;
  settlement_amount?: number;
  merchant_descriptor?: string;
  merchant_category_code?: string;
}

/**
 * Handle a `real_time_decision.card_authorization_requested` webhook END-TO-END.
 * The Standard-Webhooks event carries only the decision id, so this FETCHES the
 * RealTimeDecision object (GET /real_time_decisions/{id}), runs the pure
 * `decideCardAuthorization` against its `card_authorization` (card_id +
 * settlement_amount), then SUBMITS the verdict (POST
 * /real_time_decisions/{id}/action with `{ card_authorization: { decision } }`).
 * The orchestrator's `/increase/webhook` route awaits this synchronously (the
 * card network is holding the authorization). Uses the decision id as the
 * idempotency key (Increase retries the same id until actioned;
 * `decideCardAuthorization` is idempotent on it). ONE endpoint serves BOTH
 * environments: the fetch + action POST are routed by the decision id's
 * `sandbox_` prefix (`increaseEnvForObjectId`) — sandbox decisions hit the
 * sandbox with `INCREASE_SANDBOX_API_KEY`, production ones the deployment's own
 * key. DEGRADES to a logged no-op (never throws) when that environment's API key
 * is unset or the fetch fails — Increase then applies the account's configured
 * default action on timeout.
 */
export const handleIncreaseRealTimeDecision = internalAction({
  args: { realTimeDecisionId: v.string() },
  returns: v.null(),
  handler: async (ctx, { realTimeDecisionId }) => {
    const { key, base } = increaseEnvForObjectId(realTimeDecisionId);
    if (!key) {
      console.warn(
        "[cards] real-time decision skipped: Increase API key not configured for this environment",
      );
      return null;
    }

    let rtd: Record<string, unknown>;
    try {
      rtd = await increaseGet(
        key,
        base,
        `/real_time_decisions/${realTimeDecisionId}`,
      );
    } catch (err) {
      console.error("[cards] RTD: failed to fetch real_time_decision", err);
      return null;
    }

    const auth = rtd.card_authorization as RtdCardAuthorization | undefined;
    if (!auth?.card_id) {
      // Not a card authorization (or malformed) — nothing to decide.
      return null;
    }

    const decision = await ctx.runMutation(
      internal.cards.decideCardAuthorization,
      {
        increaseCardId: auth.card_id,
        // The decision id is the idempotency key: Increase retries the same id.
        increaseAuthId: realTimeDecisionId,
        // `settlement_amount` is the cents to check against the monthly cap.
        amountCents: Math.abs(Math.round(auth.settlement_amount ?? 0)),
        merchantName: auth.merchant_descriptor,
        merchantCategory: auth.merchant_category_code,
      },
    );

    try {
      await increasePost(
        key,
        base,
        `/real_time_decisions/${realTimeDecisionId}/action`,
        {
          card_authorization: {
            decision: decision.approved ? "approve" : "decline",
          },
        },
      );
    } catch (err) {
      // The decision is already recorded; a failed submit is logged (Increase
      // retries the webhook, and the idempotent decision replays).
      console.error("[cards] RTD: failed to submit decision action", err);
    }
    return null;
  },
});

// ── Digital wallet tokenization (WP-C.3) ─────────────────────────────────────
//
// Apple/Google/Samsung Pay "add card to wallet" is TWO real-time decisions, in
// order:
//  1. `digital_wallet_token_requested` — "should this card be allowed into a
//     wallet at all, and if so, which contact method(s) can verify the
//     cardholder?" We approve/decline based on the SAME card-status source of
//     truth `decideAgainstCard` uses (`"active"` only — covers a manager lock
//     AND a holder's own freeze) and supply a contact for step 2.
//  2. `digital_wallet_authentication_requested` — Increase already generated a
//     one-time passcode and picked one of the contacts we offered in step 1;
//     OUR job is to actually deliver it (over that channel) and report back
//     whether delivery succeeded.
//
// EMAIL ONLY: this deployment has no SMS provider wired up (`blasts.ts`'s
// `sendBlast` refuses `channel:"sms"` with `SMS_NOT_CONNECTED` until Twilio is
// connected — see its doc comment). Offering the cardholder's phone as a
// step-1 contact would let the wallet pick SMS for step 2, which we could
// never deliver — so step 1 below NEVER offers `phone`, only `email`. Step 2
// declines defensively (never throws) if a `"sms"` channel somehow comes back
// anyway. Revisit both once Twilio lands.

const walletCardContactValidator = v.union(
  v.object({
    status: v.union(...CARD_STATUSES.map((s) => v.literal(s))),
    cardholderEmail: v.union(v.string(), v.null()),
  }),
  v.null(),
);

/**
 * Fetch a card's status + its cardholder's contact email by Increase card id,
 * for both digital-wallet real-time decisions below. Returns `null` when the
 * card (or its cardholder `people` row) doesn't exist — `decideDigitalWalletToken`
 * treats that as a decline. `cardholderEmail` prefers `pwEmail` (the org
 * address) over the personal `email`, same ordering as
 * `getPersonalChargeFlagContact`. Deliberately does NOT read `phone` — see the
 * EMAIL ONLY note above.
 */
export const getCardWalletContact = internalQuery({
  args: { increaseCardId: v.string() },
  returns: walletCardContactValidator,
  handler: async (ctx, { increaseCardId }) => {
    const card = await ctx.db
      .query("cards")
      .withIndex("by_increase_card", (q) =>
        q.eq("increaseCardId", increaseCardId),
      )
      .first();
    if (!card) return null;
    const person = await ctx.db.get(card.cardholderPersonId);
    if (!person) return null;
    return {
      status: card.status,
      cardholderEmail: person.pwEmail ?? person.email ?? null,
    };
  },
});

/** Pure: APPROVE digital-wallet tokenization iff the card is `"active"`
 *  (declines a manager lock, a holder's own freeze, AND a cancellation — all
 *  represented by `status`, same single source of truth `decideAgainstCard`
 *  checks) and its cardholder has an email on file to verify with. DECLINE
 *  otherwise, always with a `reason` (Increase logs it; never shown to the
 *  end-user). */
function decideDigitalWalletToken(
  contact: { status: CardStatus; cardholderEmail: string | null } | null,
): { approved: boolean; reason?: string; email?: string } {
  if (!contact) return { approved: false, reason: "unknown card or cardholder" };
  if (contact.status !== "active") {
    return { approved: false, reason: `card ${contact.status}` };
  }
  if (!contact.cardholderEmail) {
    return { approved: false, reason: "no contact method on file" };
  }
  return { approved: true, email: contact.cardholderEmail };
}

/** The `digital_wallet_token` shape on a fetched Increase RealTimeDecision
 *  object (GET /real_time_decisions/{id}) that this handler needs — just the
 *  card id to decide against (grounded against the `increase` npm SDK's
 *  `RealTimeDecision.DigitalWalletToken`: `card_id`, `decision`, `device`,
 *  `digital_wallet`). */
interface RtdDigitalWalletToken {
  card_id?: string;
}

/**
 * Handle a `real_time_decision.digital_wallet_token_requested` webhook
 * END-TO-END (WP-C.3, step 1 of 2 — see the section doc comment above).
 * Fetches the RealTimeDecision, decides via `decideDigitalWalletToken`, then
 * submits the verdict to `/real_time_decisions/{id}/action`:
 *   `{ digital_wallet_token: { approval: { email } } }` to approve (grounded:
 *   `RealTimeDecisionActionParams.DigitalWalletToken.Approval` — `email?` /
 *   `phone?`, we only ever send `email`), or
 *   `{ digital_wallet_token: { decline: { reason } } }` to decline (grounded:
 *   `...DigitalWalletToken.Decline` — `reason?`, logging-only per Increase's
 *   docs, never shown to the end-user).
 * Mirrors `handleIncreaseRealTimeDecision`'s shape exactly: sandbox/production
 * routing via `increaseEnvForObjectId`, NEVER throws (a thrown decision would
 * wrongly hang the wallet-add flow — any internal error is caught and
 * defaults to a logged no-op), degrades to a logged no-op without that
 * environment's API key.
 */
export const handleIncreaseDigitalWalletTokenRequested = internalAction({
  args: { realTimeDecisionId: v.string() },
  returns: v.null(),
  handler: async (ctx, { realTimeDecisionId }) => {
    try {
      const { key, base } = increaseEnvForObjectId(realTimeDecisionId);
      if (!key) {
        console.warn(
          "[cards] wallet-token RTD skipped: Increase API key not configured for this environment",
        );
        return null;
      }

      let rtd: Record<string, unknown>;
      try {
        rtd = await increaseGet(
          key,
          base,
          `/real_time_decisions/${realTimeDecisionId}`,
        );
      } catch (err) {
        console.error("[cards] wallet-token RTD: failed to fetch real_time_decision", err);
        return null;
      }

      const tokenReq = rtd.digital_wallet_token as
        | RtdDigitalWalletToken
        | undefined;
      const decision = tokenReq?.card_id
        ? decideDigitalWalletToken(
            await ctx.runQuery(internal.cards.getCardWalletContact, {
              increaseCardId: tokenReq.card_id,
            }),
          )
        : { approved: false, reason: "malformed payload" };

      try {
        await increasePost(
          key,
          base,
          `/real_time_decisions/${realTimeDecisionId}/action`,
          {
            digital_wallet_token: decision.approved
              ? { approval: { email: decision.email } }
              : { decline: { reason: decision.reason } },
          },
        );
      } catch (err) {
        console.error(
          "[cards] wallet-token RTD: failed to submit decision action",
          err,
        );
      }
    } catch (err) {
      // Belt-and-suspenders: NEVER throw out of a webhook handler.
      console.error("[cards] wallet-token RTD: unexpected error", err);
    }
    return null;
  },
});

/** The `digital_wallet_authentication` shape on a fetched RealTimeDecision
 *  object that this handler needs (grounded against the `increase` npm SDK's
 *  `RealTimeDecision.DigitalWalletAuthentication`): Increase has ALREADY
 *  generated the one-time passcode and picked a `channel` (+ matching
 *  `email`/`phone`) from what step 1 offered — our job is only to deliver it
 *  and report back. */
interface RtdDigitalWalletAuthentication {
  card_id?: string;
  channel?: "sms" | "email";
  email?: string | null;
  phone?: string | null;
  one_time_passcode?: string;
}

/**
 * Handle a `real_time_decision.digital_wallet_authentication_requested`
 * webhook END-TO-END (WP-C.3, step 2 of 2). Delivers the ALREADY-GENERATED
 * `one_time_passcode` to the cardholder over email (Resend, via the shared
 * `sendEmailReporting`/`emailShell` helpers already used elsewhere in this
 * codebase), then submits the delivery result to
 * `/real_time_decisions/{id}/action`:
 * `{ digital_wallet_authentication: { result: "success", success: { email } } }`
 * or `{ result: "failure" }` (grounded:
 * `RealTimeDecisionActionParams.DigitalWalletAuthentication` —
 * `result: "success"|"failure"`, `success?: { email?, phone? }`, exactly one of
 * `phone`/`email` on `success`).
 *
 * `channel` should always be `"email"` here (see the section doc comment —
 * step 1 never offers a `phone` contact), but a `"sms"` channel or a missing
 * `email` reports `failure` defensively rather than silently dropping the
 * code. We use `sendEmailReporting` (not the fire-and-forget `sendEmail`)
 * specifically because it tells us whether Resend actually accepted the
 * message — `sendEmail` resolves successfully even when `RESEND_API_KEY` is
 * unset or Resend rejects the request, which would otherwise report a false
 * `"success"` to Increase and leave the holder stuck with no retry. The
 * passcode is NEVER logged — only delivery success/failure and the
 * (non-secret) address it was sent to ever reach `console.error`. Like every
 * other RTD handler in this file, this NEVER throws.
 */
export const handleIncreaseDigitalWalletAuthenticationRequested = internalAction(
  {
    args: { realTimeDecisionId: v.string() },
    returns: v.null(),
    handler: async (ctx, { realTimeDecisionId }) => {
      try {
        const { key, base } = increaseEnvForObjectId(realTimeDecisionId);
        if (!key) {
          console.warn(
            "[cards] wallet-auth RTD skipped: Increase API key not configured for this environment",
          );
          return null;
        }

        let rtd: Record<string, unknown>;
        try {
          rtd = await increaseGet(
            key,
            base,
            `/real_time_decisions/${realTimeDecisionId}`,
          );
        } catch (err) {
          console.error("[cards] wallet-auth RTD: failed to fetch real_time_decision", err);
          return null;
        }

        const auth = rtd.digital_wallet_authentication as
          | RtdDigitalWalletAuthentication
          | undefined;

        let actionBody: Record<string, unknown>;
        if (!auth?.one_time_passcode || auth.channel !== "email" || !auth.email) {
          actionBody = { digital_wallet_authentication: { result: "failure" } };
        } else {
          try {
            const delivered = await sendEmailReporting(ctx, {
              to: auth.email,
              subject: "Your Public Worship wallet verification code",
              html: emailShell(`
                ${emailHeading("Your wallet verification code")}
                ${emailParagraph("Enter this code to finish adding your card to your digital wallet:")}
                ${emailPanel(
                  emailCode(escapeHtml(auth.one_time_passcode), {
                    size: 32,
                    letterSpacing: "0.08em",
                  }),
                  { dashed: true, center: true, margin: "0" },
                )}`),
            });
            if (delivered) {
              actionBody = {
                digital_wallet_authentication: {
                  result: "success",
                  success: { email: auth.email },
                },
              };
            } else {
              console.error(
                "[cards] wallet-auth RTD: one-time passcode email did not deliver",
                { email: auth.email },
              );
              actionBody = { digital_wallet_authentication: { result: "failure" } };
            }
          } catch (err) {
            console.error(
              "[cards] wallet-auth RTD: failed to deliver one-time passcode",
              err,
            );
            actionBody = { digital_wallet_authentication: { result: "failure" } };
          }
        }

        try {
          await increasePost(
            key,
            base,
            `/real_time_decisions/${realTimeDecisionId}/action`,
            actionBody,
          );
        } catch (err) {
          console.error(
            "[cards] wallet-auth RTD: failed to submit decision action",
            err,
          );
        }
      } catch (err) {
        // Belt-and-suspenders: NEVER throw out of a webhook handler.
        console.error("[cards] wallet-auth RTD: unexpected error", err);
      }
      return null;
    },
  },
);

// ── revealCardDetails (HOLDER-ONLY, rate-limited add-to-wallet) ──────────────

// Threshold: 5 reveals / rolling hour / card. Mirrors the anonymous-submit
// rate limit (#134) — generous enough for a holder legitimately retrying
// "Add to wallet" across a couple of devices in one sitting, while making a
// compromised session's attempt to repeatedly pull the PAN/CVC from Increase
// meaningfully throttled. Tune here if real usage disagrees.
const CARD_DETAILS_REVEAL_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const CARD_DETAILS_REVEAL_MAX = 5;

/**
 * Gate + rate-limit `revealCardDetails`. HOLDER-ONLY: the SAME check as
 * `beginFreezeCard`/`beginUnfreezeCard` — a manager, FM, or superuser who
 * ISN'T the card's own cardholder is FORBIDDEN, full stop (there is no
 * manager override for viewing someone else's PAN/CVC). Checks-and-records
 * the rate limit atomically in ONE mutation (query + insert in the same
 * transaction) so two concurrent reveal attempts can't both slip through
 * under the cap. Returns ONLY the vendor card id — nothing sensitive is ever
 * written to `cardDetailsRevealAttempts` or returned from this mutation.
 */
export const beginRevealCardDetails = internalMutation({
  args: { cardId: v.id("cards") },
  returns: v.object({ increaseCardId: v.string() }),
  handler: async (ctx, { cardId }) => {
    const card = await requireCard(ctx, cardId);
    await requireCallerIsHolder(
      ctx,
      card,
      "Only the cardholder can view their own card details.",
    );
    if (!card.increaseCardId) {
      throw new ConvexError({
        code: "NOT_CONFIGURED",
        message: "This card isn't linked to Increase yet.",
      });
    }
    if (card.status !== "active") {
      throw new ConvexError({
        code: "ILLEGAL_STATE",
        message: "Card details aren't available while the card isn't active.",
      });
    }

    const key = `card:${cardId}`;
    const windowStart = Date.now() - CARD_DETAILS_REVEAL_WINDOW_MS;
    const recent = await ctx.db
      .query("cardDetailsRevealAttempts")
      .withIndex("by_key_and_time", (q) =>
        q.eq("key", key).gte("createdAt", windowStart),
      )
      .take(CARD_DETAILS_REVEAL_MAX);
    if (recent.length >= CARD_DETAILS_REVEAL_MAX) {
      // `recent` is ordered ascending by the `by_key_and_time` index, so
      // `recent[0]` is the OLDEST attempt still inside the window — the one
      // that ages out first and frees the next slot. Surfaced as
      // `retryAfterSeconds` so the client can show a precise "try again in
      // Xs" instead of the generic message alone.
      const oldest = recent[0];
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil(
          (oldest.createdAt + CARD_DETAILS_REVEAL_WINDOW_MS - Date.now()) / 1000,
        ),
      );
      throw new ConvexError({
        code: "RATE_LIMITED",
        message: "Too many attempts to view card details — try again in a bit.",
        retryAfterSeconds,
      });
    }
    // Swept daily by maintenance.sweepRateLimitAttempts (crons.ts) once older
    // than CARD_DETAILS_REVEAL_WINDOW_MS.
    await ctx.db.insert("cardDetailsRevealAttempts", {
      key,
      createdAt: Date.now(),
    });

    return { increaseCardId: card.increaseCardId };
  },
});

/**
 * Reveal a card's sensitive details (PAN + expiry + CVC) for manual add-to-
 * wallet. THE MOST SENSITIVE READ IN THE APP — three layers of defense:
 *  1. HOLDER-ONLY (`beginRevealCardDetails` above — never a manager/FM/
 *     superuser who isn't the cardholder themselves; code-asserted, not just
 *     UI-hidden).
 *  2. RATE-LIMITED to 5/hour/card (checked + recorded atomically in the same
 *     mutation, before any network call).
 *  3. NEVER PERSISTED OR LOGGED: the Increase response is mapped straight into
 *     this action's return value and discarded — no `ctx.db.insert`/`.patch`
 *     ever touches it, and neither this action nor `increaseGet` logs the
 *     response body (a failed fetch logs Increase's error text, which by
 *     definition never contains card data). The client renders it in an
 *     auto-hiding modal; this action holds no session state to expire.
 *
 * Push provisioning (a one-tap "Add to Apple Wallet" button) is EXPLICITLY
 * DEFERRED — it needs the Apple PassKit entitlement, out of scope for WP-C.3.
 * This manual reveal ("type it into Wallet yourself") is the day-one path.
 */
export const revealCardDetails = action({
  args: { cardId: v.id("cards") },
  returns: v.object({
    primaryAccountNumber: v.string(),
    expirationMonth: v.number(),
    expirationYear: v.number(),
    verificationCode: v.string(),
  }),
  handler: async (ctx, { cardId }) => {
    const { increaseCardId } = await ctx.runMutation(
      internal.cards.beginRevealCardDetails,
      { cardId },
    );
    const { key, base } = increaseEnvForObjectId(increaseCardId);
    if (!key) {
      throw new ConvexError({
        code: "NOT_CONFIGURED",
        message: "Card details aren't available in this environment.",
      });
    }
    const details = await increaseGet(
      key,
      base,
      `/cards/${increaseCardId}/details`,
    );
    return {
      primaryAccountNumber: String(details.primary_account_number ?? ""),
      expirationMonth: Number(details.expiration_month ?? 0),
      expirationYear: Number(details.expiration_year ?? 0),
      verificationCode: String(details.verification_code ?? ""),
    };
  },
});

// ── cardBillingAddress (HOLDER-ONLY, decorative, never throws) ───────────────

const billingAddressValidator = v.object({
  line1: v.string(),
  line2: v.union(v.string(), v.null()),
  city: v.string(),
  state: v.string(),
  zip: v.string(),
});

/**
 * Holder-only lookup of the Increase identifiers needed to fetch a card's
 * billing address — the SAME holder-only gate as `beginRevealCardDetails`
 * (a manager/FM/superuser who isn't the cardholder is FORBIDDEN), but NO rate
 * limit: unlike PAN/CVC, a mailing address isn't the kind of secret worth
 * throttling repeated reads of. Returns nulls (never throws) when the card
 * isn't linked to Increase or the chapter's Increase account for the current
 * mode isn't provisioned — the caller degrades to "address unavailable".
 */
export const holderIncreaseEnvForCard = internalQuery({
  args: { cardId: v.id("cards") },
  returns: v.object({
    increaseCardId: v.union(v.string(), v.null()),
    increaseEntityId: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, { cardId }) => {
    const card = await requireCard(ctx, cardId);
    await requireCallerIsHolder(
      ctx,
      card,
      "Only the cardholder can view their own card details.",
    );
    if (!card.increaseCardId) {
      // Legacy (Relay) / degraded card — no Increase object to ask.
      return { increaseCardId: null, increaseEntityId: null };
    }
    // The CARD's own chapter's account, not the caller's home chapter — a
    // holder's card can now be surfaced (via `myCard`) from a chapter other
    // than their `userChapters` home one, and the billing address always
    // belongs to the account the card was actually issued under.
    const sandboxMode = await readSandbox(ctx);
    const account = await getChapterAccountForMode(
      ctx,
      card.chapterId,
      sandboxMode,
    );
    return {
      increaseCardId: card.increaseCardId,
      increaseEntityId: account?.increaseEntityId ?? null,
    };
  },
});

/**
 * Parse a billing address out of an Increase Entity object. Increase nests the
 * address under the structure-specific bucket (`corporation.address`,
 * `natural_person.address`, `trust.address`, `government_authority.address`,
 * `joint.address`) rather than at the top level; try the bucket named by
 * `structure` first, falling back to a top-level `address` for safety. Returns
 * null on any shape that doesn't match — this is decorative display info, not
 * worth failing the card view over.
 */
function extractEntityAddress(
  entity: Record<string, unknown>,
): { line1: string; line2: string | null; city: string; state: string; zip: string } | null {
  const structure = entity.structure;
  const bucket =
    typeof structure === "string"
      ? (entity[structure] as Record<string, unknown> | null | undefined)
      : null;
  const address = (bucket?.address ?? entity.address) as
    | Record<string, unknown>
    | null
    | undefined;
  if (!address || typeof address !== "object") return null;
  const { line1, line2, city, state, zip } = address;
  if (!line1 || !city || !state || !zip) return null;
  return {
    line1: String(line1),
    line2: line2 ? String(line2) : null,
    city: String(city),
    state: String(state),
    zip: String(zip),
  };
}

/**
 * The billing address on a card — the shared org Entity's registered address at
 * Increase (this app never collects or stores an org address locally; see
 * `increase.ts`'s SHARED-ENTITY MODEL doc comment — the Entity was created by
 * hand in the Increase dashboard). HOLDER-ONLY (`holderIncreaseEnvForCard`
 * above), NOT rate-limited (see its doc comment). DEGRADES to `null` — never
 * throws on a vendor failure — when the card isn't Increase-linked, the
 * chapter's account for this mode isn't provisioned, the API key is
 * unconfigured, or the fetch/parse fails.
 */
export const cardBillingAddress = action({
  args: { cardId: v.id("cards") },
  returns: v.union(billingAddressValidator, v.null()),
  handler: async (ctx, { cardId }) => {
    const { increaseCardId, increaseEntityId } = await ctx.runQuery(
      internal.cards.holderIncreaseEnvForCard,
      { cardId },
    );
    if (!increaseCardId || !increaseEntityId) return null;
    const { key, base } = increaseEnvForObjectId(increaseCardId);
    if (!key) return null;
    try {
      const entity = await increaseGet(key, base, `/entities/${increaseEntityId}`);
      return extractEntityAddress(entity);
    } catch (err) {
      console.error(
        "[cards] cardBillingAddress: Increase entity fetch failed:",
        err,
      );
      return null;
    }
  },
});

/**
 * SHARED conversion core: turn a card charge into a `pending` personal
 * repayment owned by the cardholder, and back-link the txn
 * (`isPersonal`/`repaymentId`). IDEMPOTENT — one repayment per transaction: if
 * the charge already carries a `personalRepayments` row it's reused (healing
 * the txn's back-links if they ever drifted), and `created:false` is returned
 * so a caller can skip first-time-only side effects (the flag notification;
 * the sweep's converted-count).
 *
 * Extracted so the insert-`personalRepayments` + patch core lives in ONE place
 * and is shared by BOTH `flagPersonalCharge` (manual — cardholder or manager)
 * and `autoConvertOverdueReceipts` (the no-receipt sweep). The CALLER owns
 * authorization, chapter verification, and any notification — this helper only
 * touches the two rows. Exported so the member-facing `finances.submitOwnCharge`
 * can flag-personal through the same core without duplicating the insert.
 */
export async function convertChargeToPersonalRepayment(
  ctx: MutationCtx,
  txn: Doc<"transactions">,
  cardholderPersonId: Id<"people">,
): Promise<{ repayment: Doc<"personalRepayments">; created: boolean }> {
  const existing = await ctx.db
    .query("personalRepayments")
    .withIndex("by_transaction", (q) => q.eq("transactionId", txn._id))
    .first();
  if (existing) {
    if (txn.isPersonal !== true || txn.repaymentId == null) {
      await ctx.db.patch(txn._id, {
        isPersonal: true,
        repaymentId: existing._id,
        // The charge just left "cardholder must produce a receipt" territory —
        // clear the reminder timeline too (mirrors `finances.ts#setTransactionStatus`'s
        // reconciled/excluded clear, same reasoning). Otherwise a charge that
        // was already flagged/escalated before somebody realized it was
        // personal keeps rendering "Day N overdue" forever — nobody is ever
        // going to attach a receipt to a charge that isn't ours.
        receiptReminderStage: undefined,
        lastReminderSentAt: undefined,
      });
    }
    return { repayment: existing, created: false };
  }
  const now = Date.now();
  const repaymentId = await ctx.db.insert("personalRepayments", {
    // A card charge is always chapter-scoped (central issues no cards).
    chapterId: txn.chapterId as Id<"chapters">,
    transactionId: txn._id,
    payerPersonId: cardholderPersonId,
    amountCents: txn.amountCents,
    // The method is chosen when the payer initiates repayment; default until.
    method: "ach",
    status: "pending",
    createdAt: now,
    updatedAt: now,
  });
  await ctx.db.patch(txn._id, {
    isPersonal: true,
    repaymentId,
    // Same clear as the healing branch above — see the comment there. This is
    // the path a fresh flag actually takes, so it's the one the founder's
    // "[Personal] Nothing needed · Day 3 overdue" screenshot came through.
    receiptReminderStage: undefined,
    lastReminderSentAt: undefined,
  });
  return { repayment: (await ctx.db.get(repaymentId))!, created: true };
}

// ── flagPersonalCharge (payer or manager) ────────────────────────────────────

/**
 * Flag a transaction as an accidental personal charge — the ONE marking entry
 * point (Reconcile grid, Cards tab, "My transactions") funnels through this,
 * per the founder's explicit direction not to leave a second divergent path
 * (see the now-deleted `finances.ts#flagPersonal` boolean setter this
 * replaced). The payer OR a finance manager may flag it. Marks the
 * transaction `isPersonal` (removing it from category spend — see
 * `finances.ts#isSpend`) and creates a `pending` `personalRepayments` row.
 * IDEMPOTENT: one repayment per transaction.
 *
 * PAYEE RESOLUTION: the transaction's own `personId` if set, else the
 * cardholder of its `cardId`. A transaction with NEITHER (a bank/ACH entry, a
 * Relay CSV row whose last-4 was never linked, a hand-entered row) can still
 * be flagged — but only by a MANAGER, and only by NAMING who owes it via the
 * optional `payerPersonId` arg, which is then written onto the transaction so
 * every other surface (the Reconcile Cardholder column,
 * `unflagPersonalCharge`, the repayment list) resolves the same answer. With
 * no resolvable payee and no named one it still throws `PAYEE_REQUIRED`
 * (mirrors `finances.ts`'s `REASON_REQUIRED` shape for excluding a
 * transaction) — a repayment nobody can be billed for is never created.
 *
 * `payerPersonId` is IGNORED when the transaction already resolves a payee:
 * re-attributing a real cardholder's charge to someone else isn't a flagging
 * decision, it's a reassignment, and it would let a manager bill person B for
 * person A's card swipe.
 *
 * MANAGER-INITIATED (D4): when a MANAGER flags someone ELSE's charge, the
 * payer is notified by best-effort email (`notifyPersonalChargeFlagged`,
 * scheduled so the mutation never blocks on Resend) — they otherwise have no
 * way to learn a charge was just marked personal. A payer flagging their own
 * charge needs no such email (they already know).
 */
export const flagPersonalCharge = mutation({
  args: {
    transactionId: v.id("transactions"),
    // Manager-only, and only honored when the txn resolves no payee of its own
    // — see PAYEE RESOLUTION above.
    payerPersonId: v.optional(v.id("people")),
  },
  returns: repaymentSummaryValidator,
  handler: async (
    ctx,
    { transactionId, payerPersonId: namedPayerPersonId },
  ): Promise<RepaymentSummary> => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    const access = await getFinanceRole(ctx, chapterId);

    const txn = await ctx.db.get(transactionId);
    await requireInChapter(ctx, chapterId, txn, "Transaction");
    const transaction = txn!;

    // Resolve who owes: the txn's own `personId` if set, else the cardholder
    // of its `cardId` (mirrors `finances.ts#makeCardholderResolver`, kept as a
    // one-off resolve here rather than importing the per-query cached version
    // built to amortize across a whole grid of rows).
    let payerPersonId: Id<"people"> | null = transaction.personId ?? null;
    if (!payerPersonId && transaction.cardId) {
      const card = await ctx.db.get(transaction.cardId);
      await requireInChapter(ctx, chapterId, card, "Card");
      payerPersonId = card!.cardholderPersonId;
    }
    // Nobody resolvable — accept a MANAGER's explicit "bill this person", and
    // persist it as the txn's attribution so the rest of the app agrees.
    let attributedByName = false;
    if (!payerPersonId && namedPayerPersonId) {
      if (!access.isManager) {
        throw new ConvexError({
          code: "FORBIDDEN",
          message:
            "Only a finance manager can say who owes a charge that isn't on anyone's card.",
        });
      }
      const person = await ctx.db.get(namedPayerPersonId);
      await requireInChapter(ctx, chapterId, person, "Person");
      payerPersonId = namedPayerPersonId;
      attributedByName = true;
    }
    if (!payerPersonId) {
      throw new ConvexError({
        code: "PAYEE_REQUIRED",
        message:
          "Can't mark this as personal — there's no cardholder or assigned person to bill. Pick who owes it.",
      });
    }

    // Authorization: the identified payer themselves, or a finance manager.
    const isPayer = access.personId != null && access.personId === payerPersonId;
    if (!isPayer && !access.isManager) {
      throw new ConvexError({
        code: "FORBIDDEN",
        message: "Only the payer or a finance manager can flag this charge.",
      });
    }

    // A manager named the payer for an otherwise unattributed charge — write it
    // onto the transaction BEFORE converting, so the Reconcile Cardholder
    // column, `unflagPersonalCharge`'s own payer resolution, and the repayment
    // list all read the same person instead of only the repayment row knowing.
    if (attributedByName) {
      await ctx.db.patch(transactionId, { personId: payerPersonId });
      await logFinanceAudit(ctx, {
        chapterId: transaction.chapterId,
        subjectType: "transaction",
        subjectId: transactionId,
        action: "personal_flag",
        actorPersonId: access.personId ?? null,
        field: "personId",
        before: PAYER_ATTRIBUTION_LABELS.unattributed,
        after: PAYER_ATTRIBUTION_LABELS.billed_to_payer,
        beforeKey: "unattributed",
        afterKey: "billed_to_payer",
        amountCents: transaction.amountCents,
      });
    }

    // IDEMPOTENT: one repayment per transaction — the shared conversion core
    // (also used by the no-receipt sweep) handles the insert + back-link.
    const { repayment, created } = await convertChargeToPersonalRepayment(
      ctx,
      transaction,
      payerPersonId,
    );

    // financeAuditLog (personal_flag) — only on the FIRST conversion; a
    // repeat flag of an already-personal charge is a true no-op and shouldn't
    // add a redundant trail entry.
    if (created) {
      await logFinanceAudit(ctx, {
        chapterId: transaction.chapterId,
        subjectType: "transaction",
        subjectId: transactionId,
        action: "personal_flag",
        actorPersonId: access.personId ?? null,
        field: "isPersonal",
        before: PERSONAL_FLAG_LABELS.not_personal,
        after: PERSONAL_FLAG_LABELS.personal,
        beforeKey: "not_personal",
        afterKey: "personal",
        amountCents: transaction.amountCents,
      });
    }

    // Manager flagging SOMEONE ELSE's charge → notify the payer, but ONLY
    // on the FIRST conversion (`created`) — a repeat flag of an already-personal
    // charge is a no-op and must not re-email. Scheduled (not awaited) so a
    // slow/failing Resend call never blocks the flag itself; the action is
    // best-effort and degrades silently without a key.
    if (created && !isPayer) {
      await ctx.scheduler.runAfter(0, internal.cards.notifyPersonalChargeFlagged, {
        repaymentId: repayment._id,
      });
    }

    return toRepaymentSummary(repayment);
  },
});

// ── unflagPersonalCharge (payer or manager) ──────────────────────────────────

/**
 * Un-flag a transaction someone mis-marked as personal. Same payer-or-manager
 * OR-gate as `flagPersonalCharge`. BLOCKED once the repayment has SETTLED
 * (`status === "paid"`) — real money already moved, so undoing the flag at
 * that point would hide a debt that was actually collected; that needs a
 * manual accounting correction, not a toggle.
 *
 * DELETES the (never-settled) `personalRepayments` row rather than leaving it
 * in some "canceled" state — nothing was added to `REPAYMENT_STATUSES` for
 * this, so there's no state for an orphaned row to sit in. A later re-flag
 * creates a FRESH repayment (and, correctly, a fresh email — it's a new
 * flagging event, so re-notifying is not a duplicate).
 *
 * OUTSTANDING STRIPE SESSION: if a Stripe Checkout session was already
 * created for this repayment (`stripe.ts#createRepaymentCheckout`) and the
 * payer completes it anyway AFTER this unflag, the webhook
 * (`applyRepaymentPaidFromStripe`) finds no matching repayment row for that
 * id and no-ops with a loud `console.error` — real money would have moved
 * with no debt left to apply it to. That's a rare edge (the payer would have
 * to complete an abandoned checkout after being un-flagged) and is
 * DELIBERATELY surfaced for manual reconciliation rather than silently
 * swallowed or, worse, guessed at by resurrecting a deleted row.
 */
export const unflagPersonalCharge = mutation({
  args: { transactionId: v.id("transactions") },
  returns: v.null(),
  handler: async (ctx, { transactionId }) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    const access = await getFinanceRole(ctx, chapterId);

    const txn = await ctx.db.get(transactionId);
    await requireInChapter(ctx, chapterId, txn, "Transaction");
    const transaction = txn!;

    if (transaction.isPersonal !== true) return null; // already not personal

    let payerPersonId: Id<"people"> | null = transaction.personId ?? null;
    if (!payerPersonId && transaction.cardId) {
      const card = await ctx.db.get(transaction.cardId);
      payerPersonId = card?.cardholderPersonId ?? null;
    }
    const isPayer = access.personId != null && access.personId === payerPersonId;
    if (!isPayer && !access.isManager) {
      throw new ConvexError({
        code: "FORBIDDEN",
        message: "Only the payer or a finance manager can un-flag this charge.",
      });
    }

    const repayment = transaction.repaymentId
      ? await ctx.db.get(transaction.repaymentId)
      : null;
    if (repayment && (repayment.status === "paid" || repayment.creditTransactionId)) {
      throw new ConvexError({
        code: "ILLEGAL_TRANSITION",
        message:
          "This charge has already been repaid — un-flagging it now would hide a settled debt. Correct it by hand instead.",
      });
    }

    if (repayment) await ctx.db.delete(repayment._id);

    // RESTORE THE REMINDER TIMELINE TO WHAT THE CHARGE'S AGE ALREADY
    // IMPLIES — don't just leave it cleared. `convertChargeToPersonalRepayment`
    // clears `receiptReminderStage` the moment a charge is flagged personal
    // (nobody chases a receipt on money that isn't the org's), but a charge
    // un-flagged as a correction is exactly as old as it was a moment ago.
    // Leaving the stage blank makes the next sweep treat it as BRAND NEW —
    // re-transitioning it (and re-emailing the cardholder) purely because of
    // the flag/unflag round trip, not because any time actually passed.
    // `stageForAge` is the sweep's own day-threshold arithmetic, not a copy
    // of it, so the two can never drift. No email is sent for this
    // re-stamp — `lastReminderSentAt` is deliberately left untouched, same
    // as the sweep's own "seed only" branch does for a stage it sets
    // silently. Gated on `chargeOutstanding` too: a charge that's already
    // fully documented/coded by the time it's un-flagged owes nothing, and
    // stamping a stage on it would just be a different stale badge.
    const now = Date.now();
    const { sinceMs } = await codingPolicy(ctx);
    const impliedStage = stageForAge(transaction.postedAt, now);
    const stillOutstanding =
      chargeOutstanding({ ...transaction, isPersonal: false }, sinceMs) !=
      null;
    await ctx.db.patch(transactionId, {
      isPersonal: false,
      repaymentId: undefined,
      ...(stillOutstanding && impliedStage !== "none"
        ? { receiptReminderStage: impliedStage }
        : {}),
    });

    await logFinanceAudit(ctx, {
      chapterId: transaction.chapterId,
      subjectType: "transaction",
      subjectId: transactionId,
      action: "personal_flag",
      actorPersonId: access.personId ?? null,
      field: "isPersonal",
      before: PERSONAL_FLAG_LABELS.personal,
      after: PERSONAL_FLAG_LABELS.not_personal,
      beforeKey: "personal",
      afterKey: "not_personal",
      amountCents: transaction.amountCents,
    });
    return null;
  },
});

/** The cardholder contact + charge details `notifyPersonalChargeFlagged` needs.
 *  Null when the payer has no reachable email (mirrors
 *  `getReceiptReminderContact`'s degrade). */
export const getPersonalChargeFlagContact = internalQuery({
  args: { repaymentId: v.id("personalRepayments") },
  returns: v.union(
    v.object({
      email: v.string(),
      cardholderName: v.string(),
      merchantName: v.union(v.string(), v.null()),
      amountCents: v.number(),
      postedAt: v.union(v.number(), v.null()),
    }),
    v.null(),
  ),
  handler: async (ctx, { repaymentId }) => {
    const rep = await ctx.db.get(repaymentId);
    if (!rep) return null;
    const person = await ctx.db.get(rep.payerPersonId);
    const email = person?.pwEmail ?? person?.email;
    if (!person || !email) return null;
    const txn = await ctx.db.get(rep.transactionId);
    return {
      email,
      cardholderName: person.name,
      merchantName: txn?.merchantName ?? null,
      amountCents: rep.amountCents,
      postedAt: txn?.postedAt ?? null,
    };
  },
});

/** Best-effort "a charge on your card was marked personal" email — logs +
 *  no-ops without `RESEND_API_KEY` (same degrade as `notifyReceiptDigest`).
 *  Never throws past itself (it's a scheduled fire-and-forget job off the
 *  flagging mutation, so a Resend failure here must not surface anywhere). */
export const notifyPersonalChargeFlagged = internalAction({
  // `auto` distinguishes the daily sweep's auto-conversion
  // (`autoConvertOverdueReceipts`) from a manager's manual flag — same email
  // machinery, different reason copy. `cause` says WHICH sweep clock ran out
  // (defaults to the no-receipt one, the only clock that existed before
  // coding): the two endings need genuinely different explanations, and the
  // uncoded one has to teach the accountable-plan rule it's enforcing.
  args: {
    repaymentId: v.id("personalRepayments"),
    auto: v.optional(v.boolean()),
    cause: v.optional(
      v.union(v.literal("no_receipt"), v.literal("uncoded")),
    ),
  },
  handler: async (ctx, { repaymentId, auto, cause }) => {
    try {
      const contact = await ctx.runQuery(
        internal.cards.getPersonalChargeFlagContact,
        { repaymentId },
      );
      if (!contact) return null;
      const dollars = `$${(contact.amountCents / 100).toFixed(2)}`;
      const merchant = contact.merchantName ?? "a charge on your card";
      const when = contact.postedAt
        ? new Date(contact.postedAt).toLocaleDateString("en-US", {
            month: "long",
            day: "numeric",
            year: "numeric",
            timeZone: "America/New_York",
          })
        : null;
      const uncoded = auto === true && cause === "uncoded";
      const what = `${escapeHtml(merchant)} (${escapeHtml(dollars)}${when ? `, ${escapeHtml(when)}` : ""})`;
      const subject = uncoded
        ? `A charge nobody coded became a personal charge — you owe ${dollars}`
        : auto
          ? `A charge with no receipt became a personal charge — you owe ${dollars}`
          : `A charge on your card was marked personal — you owe ${dollars}`;
      // THE WHOLE ENFORCEMENT STORY, in plain words (owner ask, 2026-08-08 —
      // and docs/plans/transaction-coding.md §D). Under IRS accountable-plan
      // rules (Treas. Reg. §1.62-2) spending the org can't substantiate inside
      // the safe-harbor window is taxable income to the person who spent it.
      // Saying that outright is the point: this is not a punishment the app
      // invented, it's the choice between paying it back and having it show up
      // on a W-2 — and coding it is still the better ending than either.
      const reason = uncoded
        ? `${what} was never coded — the record of what it was for, and why it served the org's work, was never written. Under IRS accountable-plan rules, spending we can't substantiate becomes taxable income to the person who spent it, so it was converted to a personal charge instead. If you can still say what it was for, code it and ask a finance manager to reverse this.`
        : auto
          ? `${what} passed the receipt deadline with no receipt attached, so it was automatically converted to a personal charge.`
          : `a finance manager marked ${what} as a personal charge.`;
      // The repayments page owns the per-charge pay-back list this charge
      // lives in (2026-08-14). It used to be the Cards tab's member view,
      // which showed a single "pay everything" button; the payer can now pick
      // which charges to settle, and the page they land on from this email
      // should be the one with their charge on it and a checkbox next to it.
      const link = appUrl("/finances/repayments");
      // KNOWN REPO TRAP: a `link ? <a> : ""` pattern here would silently ship
      // a CTA-less transactional email whenever APP_URL is unset — the
      // recipient would read "you owe $X" with no way to act on it and no
      // signal anything was wrong. Degrade LOUDLY instead: log so the gap is
      // visible in production logs/alerts, and always render SOME actionable
      // text (a plain path when there's no absolute URL to link).
      if (!link) {
        console.error(
          "[cards] notifyPersonalChargeFlagged: APP_URL is unset — sending WITHOUT a clickable pay-back link",
          repaymentId,
        );
      }
      const ctaHtml = link
        ? emailButtonRow(link, "Pay it back →")
        : emailParagraph("Open the app and go to Finances → Reimbursements → Review & pay to pay it back.", {
            size: 12,
            margin: "0",
          });
      await sendEmail(ctx, {
        to: contact.email,
        subject,
        html: emailShell(`
          ${emailHeading(escapeHtml(subject))}
          ${emailParagraph(`Hi ${escapeHtml(contact.cardholderName)} — ${reason} Pay it back from Reimbursements in the app — pick the charges you're ready to settle.`)}
          ${ctaHtml}`),
      });
    } catch (err) {
      console.error(
        "notifyPersonalChargeFlagged: email failed",
        repaymentId,
        err,
      );
    }
    return null;
  },
});

// ── Coding sent back (the review loop's other half) ──────────────────────────

/** Who to tell that their coding came back, and what the reviewer said. Null
 *  when the author has no reachable email (same degrade as
 *  `getPersonalChargeFlagContact`) or the row is no longer in
 *  `changes_requested` — a coding resubmitted before this scheduled job ran
 *  must not re-open a conversation the author already answered. */
export const getCodingSendBackContact = internalQuery({
  args: { transactionId: v.id("transactions") },
  returns: v.union(
    v.object({
      email: v.string(),
      authorName: v.string(),
      reviewerName: v.union(v.string(), v.null()),
      reviewNote: v.string(),
      merchantName: v.union(v.string(), v.null()),
      amountCents: v.number(),
      postedAt: v.union(v.number(), v.null()),
    }),
    v.null(),
  ),
  handler: async (ctx, { transactionId }) => {
    const coding = await codingForTransaction(ctx, transactionId);
    if (!coding || coding.status !== "changes_requested") return null;
    if (!coding.reviewNote) return null;
    // The AUTHOR is who owes the edit — not the cardholder, since a bookkeeper
    // may have coded on someone's behalf and it's the typist who knows what
    // they wrote. `codedByUserId` is the fallback for a superuser with no
    // roster row (the same escape hatch the coding gates already allow).
    const person = coding.codedByPersonId
      ? await ctx.db.get(coding.codedByPersonId)
      : null;
    const user = coding.codedByUserId
      ? await ctx.db.get(coding.codedByUserId)
      : null;
    const email = person?.pwEmail ?? person?.email ?? user?.email ?? null;
    if (!email) return null;
    const reviewer = coding.decidedByPersonId
      ? await ctx.db.get(coding.decidedByPersonId)
      : null;
    const txn = await ctx.db.get(transactionId);
    return {
      email,
      authorName: person?.name ?? user?.name ?? "there",
      reviewerName: reviewer?.name ?? null,
      reviewNote: coding.reviewNote,
      merchantName: txn?.merchantName ?? null,
      amountCents: txn?.amountCents ?? 0,
      postedAt: txn?.postedAt ?? null,
    };
  },
});

/**
 * Best-effort "your coding came back with a note" email — logs + no-ops
 * without `RESEND_API_KEY` (same degrade as every other send in this file),
 * and never throws past itself: it's a scheduled fire-and-forget job off
 * `transactionCodings.requestChanges`, so a Resend failure must not surface as
 * a failed review.
 *
 * WHY IT EXISTS: a send-back with no email is a note filed in a row nobody
 * re-opens. The reviewer's whole job here is to say what would make the
 * substantiation approvable ("the receipt must show the exact amount") — if
 * that sentence doesn't reach the person who wrote the coding, the review loop
 * is a queue that only ever grows.
 */
export const notifyCodingSentBack = internalAction({
  args: { transactionId: v.id("transactions") },
  returns: v.null(),
  handler: async (ctx, { transactionId }) => {
    try {
      const contact = await ctx.runQuery(
        internal.cards.getCodingSendBackContact,
        { transactionId },
      );
      if (!contact) return null;
      const dollars = `$${(contact.amountCents / 100).toFixed(2)}`;
      const merchant = contact.merchantName ?? "a charge on your card";
      const when = contact.postedAt
        ? new Date(contact.postedAt).toLocaleDateString("en-US", {
            month: "long",
            day: "numeric",
            year: "numeric",
            timeZone: "America/New_York",
          })
        : null;
      const subject = `Your coding for ${merchant} (${dollars}) needs a change`;
      const byBit = contact.reviewerName
        ? ` by ${escapeHtml(contact.reviewerName)}`
        : "";
      const lead = `your coding for ${escapeHtml(merchant)} (${escapeHtml(dollars)}${when ? `, ${escapeHtml(when)}` : ""}) was sent back${byBit}.`;
      // The reviewer's words, verbatim and set apart — this is the entire
      // actionable content of the email.
      const noteBlock = emailPanel(
        `<div style="${emailTextStyle({ strong: true })}"><b>What to change:</b> ${escapeHtml(contact.reviewNote)}</div>`,
        { dashed: true },
      );
      // `/code` — the spender's own page, no app chrome and no finance seat
      // required. The recipient of a send-back is a cardholder, not a
      // reviewer; they should land on their charges, not next to a queue of
      // other people's.
      const link = appUrl("/code?filter=uncoded");
      await sendEmail(ctx, {
        to: contact.email,
        subject,
        html: emailShell(`
          ${emailHeading("Your coding needs a change")}
          ${emailParagraph(`Hi ${escapeHtml(contact.authorName)} — ${lead}`)}
          ${noteBlock}
          ${emailParagraph("Edit it and resubmit — the charge stays on the substantiation clock until the coding is approved.")}
          ${link ? emailButtonRow(link, "Fix the coding →") : ""}`),
      });
    } catch (err) {
      console.error("notifyCodingSentBack: email failed", transactionId, err);
    }
    return null;
  },
});

// ── myPersonalRepayments (self-service, no finance-role gate) ────────────────

// Bounds a single person's personal-charge repayments (naturally small —
// mirrors the other small-table scan limits in this file).
const MY_REPAYMENTS_LIMIT = 500;
// Bounds a chapter's outstanding personal-charge repayments for the manager
// aggregate below.
const CHAPTER_REPAYMENTS_LIMIT = 5000;

const myRepaymentValidator = v.object({
  id: v.id("personalRepayments"),
  transactionId: v.id("transactions"),
  amountCents: v.number(),
  status: repaymentStatusValidator,
  merchantName: v.union(v.string(), v.null()),
  // The charge's own description — the fallback line when a bank feed gave a
  // transaction no merchant name. Without it the repayments page showed rows
  // reading only "personal charge", which is not enough to decide whether a
  // charge really WAS personal before paying for it.
  description: v.union(v.string(), v.null()),
  postedAt: v.number(),
  // When the charge was flagged personal (the repayment row's own creation) —
  // distinct from `postedAt`, and the honest answer to "how long have I owed
  // this?" on a charge flagged weeks after it posted.
  flaggedAt: v.number(),
  // Whether the payer already linked a real Increase External Account (used to
  // decide whether "Pay by bank" needs the inline ACH-linking form first).
  hasExternalAccount: v.boolean(),
});

/**
 * The caller's OWN personal-charge repayments (every status) — the single
 * source for the "You owe Public Worship" surface, shared by the Cards-tab owe
 * banner (`OwedBanner`, used from `MemberCardsView`) and the Reimbursements
 * screen's owe section (D4). Covers a charge flagged by EITHER the cardholder
 * themselves OR a finance manager — unlike the old Cards-tab banner
 * (session-state only, see the PR-94 note it replaces), this is a real query
 * so a manager-flagged charge shows up even though the member never clicked
 * "Flag personal" themselves.
 *
 * Returns EVERY status (mirrors `reimbursements.myReimbursements` — the caller
 * groups/filters), not just outstanding ones: a consumer that only reads
 * "pending" rows would make an already-`paid` charge look never-flagged again
 * (its row would just vanish), inviting a re-flag. No finance-role gate
 * (self-service) — scoped to the caller's own roster person via `by_person`.
 * Degrades to `[]` without a chapter/roster row.
 */
export const myPersonalRepayments = query({
  args: {},
  returns: v.array(myRepaymentValidator),
  handler: async (ctx) => {
    const chapterId = await getChapterIdOrNull(ctx);
    if (!chapterId) return [];
    const person = await viewerPerson(ctx, chapterId as Id<"chapters">);
    if (!person) return [];
    const reps = await ctx.db
      .query("personalRepayments")
      .withIndex("by_person", (q) => q.eq("payerPersonId", person._id))
      .order("desc")
      .take(MY_REPAYMENTS_LIMIT);
    const mine = reps.filter((r) => r.chapterId === chapterId);
    return await Promise.all(
      mine.map(async (r) => {
        const txn = await ctx.db.get(r.transactionId);
        return {
          id: r._id,
          transactionId: r.transactionId,
          amountCents: r.amountCents,
          status: r.status,
          merchantName: txn?.merchantName ?? null,
          description: txn?.description ?? null,
          postedAt: txn?.postedAt ?? r.createdAt,
          flaggedAt: r.createdAt,
          hasExternalAccount: !!r.payerExternalAccountId,
        };
      }),
    );
  },
});

/**
 * WHAT WOULD I BE CHARGED IF I PAID THESE? — the quote the payer sees BEFORE
 * committing, so the fee is a number they agreed to rather than a surprise on
 * Stripe's page.
 *
 * Founder, 2026-08-14: repayments shouldn't be all-or-nothing — "for some
 * things it's like, oh, I accidentally paid for a company expense with this…
 * but then on another, oh, that's a personal charge. I want people to be able
 * to break up what card they use per transaction. So just allow people to
 * multiselect: okay, I'm ready to pay these off."
 *
 * So the quote takes the SELECTION, not the whole debt, and recomputes as the
 * checkboxes change. Same `lib/repaymentFees` the checkout itself uses (and
 * the no-login pay link — see `repaymentLinks.ts`), so the
 * number quoted here is the number billed — including the one-fee-per-batch
 * rule, which is exactly what makes "pay these three now, that one later" cost
 * more in total than paying all four at once. The client says so out loud.
 *
 * Self-service (no finance-role gate, mirroring `myPersonalRepayments`): every
 * id is verified to be the CALLER'S OWN outstanding repayment, and anything
 * else — someone else's, an unknown id, one already settled — is silently
 * dropped rather than throwing, so a stale checkbox can't wedge the page.
 * A manager paying on a member's behalf uses the checkout path's own OR-gate;
 * this read deliberately answers only for yourself.
 */
const railQuoteValidator = v.object({
  /** What covering Stripe's cut adds on this rail. */
  feeCents: v.number(),
  /** What the payer is charged: the debt plus the fee. */
  chargeCents: v.number(),
  /** "2.9% + $0.30" / "0.8% capped at $5.00" — the rate as a person reads it. */
  rateLabel: v.union(v.string(), v.null()),
});

export const quoteRepayment = query({
  args: { repaymentIds: v.array(v.id("personalRepayments")) },
  returns: v.object({
    /** How many of the submitted ids were actually billable. */
    count: v.number(),
    /** The debt — what the org nets, whichever rail is used. */
    totalCents: v.number(),
    /** BOTH rails, always. The payer's page shows them side by side, and a
     *  quote-per-toggle would mean a round-trip (and a flash of stale
     *  arithmetic) every time they compare. */
    card: railQuoteValidator,
    ach: railQuoteValidator,

    // ── WIRE COMPATIBILITY, and why it's here ───────────────────────────────
    // These three ARE `card`'s fields, repeated at the top level. They were
    // the original shape of this query; splitting the quote into two rails
    // moved them, and moving them broke every client that hadn't reloaded.
    //
    // A Convex query's return shape is a WIRE CONTRACT with clients this repo
    // does not deploy in lockstep: the backend ships the moment main merges,
    // while a browser tab holds its bundle until it reloads and a native app
    // until its update lands. For the window between, an old client asked for
    // `chargeCents`, got `undefined`, and rendered `formatCents(undefined)` —
    // which is the string "$NaN", on the screen where somebody was about to
    // pay money. That is exactly what the founder saw (2026-08-14: "it's
    // saying your card is charged not a number").
    //
    // So: removals from a query's return are BREAKING, and this is what the
    // fix looks like — put them back, additively, and let them age out. New
    // code reads `card`/`ach`; nothing new should read these.
    //
    // @deprecated Read `card` instead. Kept so pre-2026-08-14 clients render
    // a real number until they reload.
    feeCents: v.number(),
    /** @deprecated Read `card.chargeCents`. */
    chargeCents: v.number(),
    /** @deprecated Read `card.rateLabel`. */
    feeRateLabel: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, { repaymentIds }) => {
    const noRail = { feeCents: 0, chargeCents: 0, rateLabel: null };
    const none = {
      count: 0,
      totalCents: 0,
      card: noRail,
      ach: noRail,
      // Deprecated mirrors of `card` — see the validator's own note.
      feeCents: 0,
      chargeCents: 0,
      feeRateLabel: null,
    };
    const chapterId = await getChapterIdOrNull(ctx);
    if (!chapterId) return none;
    const person = await viewerPerson(ctx, chapterId as Id<"chapters">);
    if (!person) return none;

    let totalCents = 0;
    let count = 0;
    const seen = new Set<string>();
    for (const id of repaymentIds) {
      if (seen.has(id)) continue; // a duplicated id must not double the quote
      seen.add(id);
      const repayment = await ctx.db.get(id);
      if (!repayment) continue;
      if (repayment.chapterId !== chapterId) continue;
      if (repayment.payerPersonId !== person._id) continue;
      if (!isBillableRepayment(repayment)) continue;
      totalCents += repayment.amountCents;
      count += 1;
    }
    const card = await railQuote(ctx, totalCents, "card");
    return {
      count,
      totalCents,
      card,
      ach: await railQuote(ctx, totalCents, "ach"),
      // Deprecated mirrors of `card` — see the validator's own note. Derived
      // from `card` rather than recomputed, so they cannot drift from it.
      feeCents: card.feeCents,
      chargeCents: card.chargeCents,
      feeRateLabel: card.rateLabel,
    };
  },
});

const railQuote = repaymentRailQuote;

/**
 * Can this repayment be put into a NEW checkout?
 *
 * Settled ones obviously not. `processing` ones also not, and that is the
 * clause worth having a name for: a bank debit takes about four business days,
 * during which the debt is genuinely still outstanding — so every "do they owe
 * this?" check says yes — while a SECOND checkout for it would collect the
 * money twice. "Outstanding" and "billable" are different questions, and
 * conflating them is how you double-charge a volunteer.
 */
function isBillableRepayment(repayment: Doc<"personalRepayments">): boolean {
  if (repayment.status === "paid" || repayment.creditTransactionId) return false;
  if (repayment.status === "processing") return false;
  return true;
}

/**
 * Chapter-scope aggregate of OUTSTANDING (not yet paid) personal-charge
 * repayments — backs the "Personal to repay" KPI tile on the manager Cards
 * view (blank since #94 for lack of exactly this read) and the matching tile
 * on the Reimbursements manager queue (D4). Viewer+ gated, the same floor as
 * every other manager-facing finance read.
 */
export const personalRepaymentsOutstanding = query({
  args: {},
  returns: v.object({ count: v.number(), totalCents: v.number() }),
  handler: async (ctx) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireFinanceRole(ctx, chapterId, "viewer");
    const reps = await ctx.db
      .query("personalRepayments")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
      .take(CHAPTER_REPAYMENTS_LIMIT);
    const outstanding = reps.filter((r) => r.status !== "paid");
    return {
      count: outstanding.length,
      totalCents: outstanding.reduce((sum, r) => sum + r.amountCents, 0),
    };
  },
});

const chapterRepaymentValidator = v.object({
  id: v.id("personalRepayments"),
  transactionId: v.id("transactions"),
  payerPersonId: v.id("people"),
  payerName: v.string(),
  payerImageUrl: v.union(v.string(), v.null()),
  amountCents: v.number(),
  status: repaymentStatusValidator,
  method: repaymentMethodValidator,
  // The charge itself — what a manager needs to recognize the line without
  // leaving for the Reconcile grid.
  merchantName: v.union(v.string(), v.null()),
  description: v.union(v.string(), v.null()),
  postedAt: v.number(),
  flaggedAt: v.number(),
  // Whether the payer linked a bank account for the ACH rail (a "they've
  // started" signal — the debit itself is still feature-gated off).
  hasExternalAccount: v.boolean(),
  // Set once settled — the offsetting credit `settleRepayment` posted.
  creditTransactionId: v.union(v.id("transactions"), v.null()),
  // When this person was last emailed about this debt. Shown on the row so a
  // manager can see they already chased it — the alternative is sending a
  // second reminder because nothing on screen said the first one went.
  lastNudgedAt: v.union(v.number(), v.null()),
  // Receipt state, for the "Send receipt" / "Resend receipt" row action on a
  // settled repayment (`PersonalChargesView.tsx`'s Repaid section) — a
  // manager needs to see "did this person ever actually get one?" at a
  // glance, not guess. `receiptSentAt` alone means an attempt was made, not
  // that it landed; `receiptDeliveredAt` is the one that means delivered.
  receiptSentAt: v.union(v.number(), v.null()),
  receiptDeliveredAt: v.union(v.number(), v.null()),
  receiptDeliveryFailedAt: v.union(v.number(), v.null()),
  lastReceiptError: v.union(v.string(), v.null()),
});

/**
 * Every personal-charge repayment in the chapter, newest flag first — the ROW
 * DETAIL behind `personalRepaymentsOutstanding`'s aggregate, so the "Personal
 * charges outstanding" tiles on the Cards and Reimbursements tabs have
 * somewhere to drill into: who owes it, which charge, and (for a manager) a
 * "Mark repaid" confirmation. Before this, both tiles were dead numbers —
 * the count was visible but the underlying rows were reachable only through
 * the Reconcile grid's `personal_unpaid` pill, which has no way to settle one.
 *
 * Returns EVERY status (the caller splits outstanding vs. repaid, same
 * contract as `myPersonalRepayments`) — a manager confirming a payment needs
 * to see it land in the repaid list, not watch the row vanish.
 *
 * Viewer+ gated, the same floor as the aggregate it details; the mutations a
 * row offers (`markRepaymentPaid`, `unflagPersonalCharge`) carry their own
 * manager gates server-side.
 */
export const listPersonalRepayments = query({
  args: {},
  returns: v.array(chapterRepaymentValidator),
  handler: async (ctx) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireFinanceRole(ctx, chapterId, "viewer");
    const reps = await ctx.db
      .query("personalRepayments")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
      .take(CHAPTER_REPAYMENTS_LIMIT);
    // Newest flag first — an outstanding debt is chased in the order it
    // appeared, and the repaid list reads as a reverse-chronological receipt.
    reps.sort((a, b) => b.createdAt - a.createdAt);

    // Read-through caches: several charges commonly belong to ONE payer (the
    // cardholder who had a bad week), so resolving the person + their avatar
    // once per payer keeps this linear in distinct people, not rows.
    const people = new Map<Id<"people">, Doc<"people"> | null>();
    const avatars = new Map<Id<"_storage">, string | null>();
    return await Promise.all(
      reps.map(async (r) => {
        if (!people.has(r.payerPersonId)) {
          people.set(r.payerPersonId, await ctx.db.get(r.payerPersonId));
        }
        const person = people.get(r.payerPersonId) ?? null;
        let payerImageUrl: string | null = null;
        if (person?.image) {
          if (!avatars.has(person.image)) {
            avatars.set(person.image, await ctx.storage.getUrl(person.image));
          }
          payerImageUrl = avatars.get(person.image) ?? null;
        }
        const txn = await ctx.db.get(r.transactionId);
        return {
          id: r._id,
          transactionId: r.transactionId,
          payerPersonId: r.payerPersonId,
          payerName: person?.name ?? "Unknown person",
          payerImageUrl,
          amountCents: r.amountCents,
          status: r.status,
          method: r.method,
          merchantName: txn?.merchantName ?? null,
          description: txn?.description ?? null,
          postedAt: txn?.postedAt ?? r.createdAt,
          flaggedAt: r.createdAt,
          hasExternalAccount: !!r.payerExternalAccountId,
          creditTransactionId: r.creditTransactionId ?? null,
          lastNudgedAt: r.lastNudgedAt ?? null,
          receiptSentAt: r.receiptSentAt ?? null,
          receiptDeliveredAt: r.receiptDeliveredAt ?? null,
          receiptDeliveryFailedAt: r.receiptDeliveryFailedAt ?? null,
          lastReceiptError: r.lastReceiptError ?? null,
        };
      }),
    );
  },
});

// ── Personal-repayment settlement (the testable core) ────────────────────────

/**
 * Settle a repayment: mark it `paid` and post the single OFFSETTING credit — a
 * positive `flow:"transfer"` transaction (EXCLUDED from category spend, so it
 * nets the personal charge without counting as income) owned by the payer and
 * linked back to the repayment. IDEMPOTENT via `creditTransactionId` — this is
 * the ONE settlement core every repayment rail (manager manual confirm,
 * Increase ACH, Stripe Checkout) goes through, so "at most one credit per
 * repayment" is a single, already-tested guarantee instead of being
 * re-implemented per rail.
 */
async function settleRepayment(
  ctx: MutationCtx,
  repayment: Doc<"personalRepayments">,
  ref?: { increaseRef?: string; stripePaymentIntentId?: string },
): Promise<Doc<"personalRepayments">> {
  // Already settled → return as-is (no second credit).
  if (repayment.creditTransactionId) {
    if (repayment.status !== "paid") {
      await ctx.db.patch(repayment._id, {
        status: "paid",
        updatedAt: Date.now(),
      });
    }
    return (await ctx.db.get(repayment._id))!;
  }

  const now = Date.now();
  const creditTransactionId = await ctx.db.insert("transactions", {
    chapterId: repayment.chapterId,
    source: "repayment",
    flow: "transfer", // EXCLUDED from category/budget spend (nets the charge)
    amountCents: repayment.amountCents,
    currency: "usd",
    postedAt: now,
    personId: repayment.payerPersonId,
    repaymentId: repayment._id,
    status: "reconciled",
    createdAt: now,
  });
  await ctx.db.patch(repayment._id, {
    status: "paid",
    creditTransactionId,
    increaseRef: ref?.increaseRef ?? repayment.increaseRef,
    stripePaymentIntentId: ref?.stripePaymentIntentId ?? repayment.stripePaymentIntentId,
    updatedAt: now,
  });

  // ── ASK TO REPUBLISH (founder, 2026-08-14) ────────────────────────────────
  // "Once it's paid off, that should clear it out… and then it should update
  // the things. It should probably ask to republish the public ledgers and
  // statements if they're already published."
  //
  // Settling moves TWO months' published statements: the month the charge
  // posted in (whose public line said "awaiting repayment" and now says "paid
  // back" — `lib/publicLedgerSnapshot.ts`) and the month this credit posts in,
  // which gains a line it didn't have. Both are marked; already-equal months
  // dedupe, unpublished ones no-op. This ASKS — the publish console shows the
  // prompt — it never republishes on its own, because an amendment carries a
  // human's sentence explaining it (see `lib/publicLedgerStale.ts`).
  const charge = await ctx.db.get(repayment.transactionId);
  await markPublicationsStale(
    ctx,
    repayment.chapterId,
    [charge?.postedAt ?? now, now],
    "A personal charge was paid back",
  );

  return (await ctx.db.get(repayment._id))!;
}

// ── Payment receipt (the payer's proof-of-payment email) ─────────────────────
//
// Founder, 2026-08-14: "When people pay what they owe, we need to make sure
// we send them an email saying, like, hey, thanks for paying this off. This
// is your receipt … just in case they need a receipt for showing that they
// did the payment." The copy itself — and the hard rule that it must never
// read as a donation or a tax deduction — lives in
// `lib/personalRepaymentReceiptEmail.ts`.
//
// ── THE SEAM: one email per PAYMENT, not per debt ────────────────────────────
// A single Checkout can settle SEVERAL repayments at once (`repaymentIds` is
// comma-joined in Stripe metadata). Scheduling from inside `settleRepayment`
// itself — the per-row core — would therefore send N emails for one payment.
// Instead each SETTLEMENT CALLER schedules exactly once, after it has
// finished settling everything the current payment event covers:
//  - `applyRepaymentPaidFromStripe` runs once per settling webhook
//    (`checkout.session.completed` for a card, `async_payment_succeeded` for
//    a bank debit) and covers BOTH Stripe rails from one seam — it schedules
//    once with every repayment it just settled in THIS call.
//  - `applyRepaymentPaid` (the Increase ACH direct-debit rail) always settles
//    one repayment at a time, so its single schedule call already has
//    exactly the shape the other rail's batch degenerates to.
// A retried/redelivered webhook re-derives "what's still outstanding" before
// scheduling, so a duplicate delivery that settled nothing new schedules
// nothing — see `claimRepaymentReceipts` below for the second, row-level
// guarantee that makes this exactly-once regardless.
//
// ── AT MOST ONE RECEIPT PER REPAYMENT, EVER ──────────────────────────────────
// `claimRepaymentReceipts` stamps `receiptSentAt` on each row in ONE
// transaction — the same "stamp before send, in a mutation, so the read and
// the write can't interleave" idempotency `reimbursements.markApprovedNoticeSent`
// uses. Because one email can cover SEVERAL repayments, the claim is
// PER-ROW, not all-or-nothing across the batch: it returns only the ids that
// were actually unclaimed, and the sender includes ONLY those in the email.
// If it claims nothing — every id in the batch already has a receipt —
// nothing is sent. That is what makes a webhook retry, or
// `checkout.session.completed` racing `async_payment_succeeded` for the same
// session, safe: `settleRepayment`'s own guard means a retry's "outstanding"
// list is already empty by the time it would schedule, and even in the
// pathological case where it schedules anyway, the claim finds nothing left
// to stamp.

const repaymentReceiptLineValidator = v.object({
  merchantName: v.union(v.string(), v.null()),
  description: v.union(v.string(), v.null()),
  chargeDate: v.union(v.number(), v.null()),
  amountCents: v.number(),
});

/**
 * CLAIM the receipt for every listed repayment, returning only the ones this
 * call actually claimed (previously un-sent, and genuinely settled — the
 * second check is defensive; every real caller only ever passes ids it just
 * settled itself). One transaction, so two schedules racing the same row —
 * a webhook retry landing beside the original call — can never both claim
 * it.
 *
 * Returns each claimed id's `payerPersonId` alongside it so the sender can
 * GROUP by payer without a second round trip: a batch is normally one
 * payer's own charges, but `prepareRepaymentCheckout` doesn't itself refuse a
 * manager bundling charges from DIFFERENT payers into one Checkout, so this
 * treats that as first-class rather than mailing one payer a receipt that
 * quietly includes somebody else's charges.
 *
 * ALSO claims the IN-FLIGHT LOCK (`receiptSendingAt`) alongside `receiptSentAt`
 * — this row's automatic exactly-once guard above still needs no other
 * change (a second automatic claim is already refused by `receiptSentAt`
 * alone), but stamping the lock here is what lets a MANUAL send that races
 * this send while it's still in flight refuse itself instead of double-
 * mailing the payer — see `receiptSendingAt`'s schema doc and
 * `claimRepaymentReceiptManual` below.
 */
export const claimRepaymentReceipts = internalMutation({
  args: { repaymentIds: v.array(v.id("personalRepayments")) },
  returns: v.array(
    v.object({
      repaymentId: v.id("personalRepayments"),
      payerPersonId: v.id("people"),
    }),
  ),
  handler: async (ctx, { repaymentIds }) => {
    const claimed: Array<{
      repaymentId: Id<"personalRepayments">;
      payerPersonId: Id<"people">;
    }> = [];
    for (const id of repaymentIds) {
      const r = await ctx.db.get(id);
      if (!r) continue;
      if (!r.creditTransactionId || r.status !== "paid") continue;
      // UNCHANGED, deliberately as strict as ever — pinned by
      // `repaymentReceiptManual.test.ts`'s "at-most-once guarantee is
      // unchanged" suite. Nothing added ABOVE this line; only the stamp
      // below grew a second field.
      if (r.receiptSentAt !== undefined) continue;
      const now = Date.now();
      await ctx.db.patch(id, {
        receiptSentAt: now,
        receiptSendingAt: now,
        lastReceiptSendSource: "automatic",
      });
      claimed.push({ repaymentId: id, payerPersonId: r.payerPersonId });
    }
    return claimed;
  },
});

/** How long a claimed receipt's IN-FLIGHT LOCK (`receiptSendingAt`) is
 *  honored before a second claimer is allowed to assume the original attempt
 *  died mid-flight and try again. A `sendOneRepaymentReceiptGroup` call is
 *  one HTTP round trip to Resend, resolved (successfully or not) in
 *  milliseconds — `markRepaymentReceiptOutcome` clears the lock the instant
 *  that resolves — so in the OVERWHELMING majority of cases this bound is
 *  never actually waited out; it exists purely for the process-died-mid-send
 *  case, where nothing ever clears the lock. Exported so the backfill's
 *  eligibility scan, this file's retry-claim, and the manual claim's
 *  in-flight refusal all agree on the same threshold — three independent
 *  claimers can never disagree about what "stuck" means. */
export const RECEIPT_RETRY_STALE_MS = 15 * 60 * 1000;

/** How long ONE manual send silences a second one for the SAME repayment —
 *  the MANUAL path's own cooldown, deliberately separate from (and far
 *  shorter than) `REPAYMENT_NUDGE_COOLDOWN_MS`'s three days. That cooldown
 *  protects a DEBTOR from being pestered about money they haven't paid yet;
 *  this one protects the SYSTEM (and Resend's rate limits) from a runaway
 *  loop or a fat-fingered double-tap on a "Resend receipt" button — an
 *  un-throttled probe of this exact action produced 50 Resend calls for 50
 *  presses with nothing stopping it. The founder's stated use case is
 *  on-demand resending ("say they forgot it, or they just need it resent")
 *  minutes-to-days later, which 60 seconds never touches; it only ever
 *  refuses a press that lands while the previous one is still settling.
 *  Exported so the manual claim and its tests agree on one number. */
export const MANUAL_RECEIPT_RESEND_COOLDOWN_MS = 60 * 1000;

/** Is a receipt send CURRENTLY in flight for this row — the shared check
 *  every claimer (automatic, backfill retry, manual) runs before claiming.
 *  `receiptSendingAt` unset means nothing is happening; set-but-stale (past
 *  `RECEIPT_RETRY_STALE_MS`) means the original attempt is presumed dead and
 *  the lock no longer blocks a new claim — see that field's schema doc. */
function isReceiptSendInFlight(
  r: Pick<Doc<"personalRepayments">, "receiptSendingAt">,
  now: number,
): boolean {
  return (
    r.receiptSendingAt !== undefined &&
    now - r.receiptSendingAt < RECEIPT_RETRY_STALE_MS
  );
}

/**
 * Re-claim ONE repayment's receipt for a RETRY send, for the backfill only
 * (`repaymentReceiptBackfill.ts`). Unlike `claimRepaymentReceipts` (which
 * claims a never-attempted row), this claims a row that was ALREADY
 * attempted and never confirmed delivered — re-stamping `receiptSentAt` (and
 * the in-flight lock, `receiptSendingAt`) to `now` is what makes the claim
 * atomic (read-and-write in one transaction, same trick `claimRepaymentReceipts`
 * uses).
 *
 * Returns `null` (nothing to do) when: the row is gone, was never settled,
 * was never claimed in the first place (`receiptSentAt` absent — not this
 * mutation's job), already has a CONFIRMED delivery, or a send is CURRENTLY
 * in flight for it — either this sweep's own prior claim not yet resolved,
 * or (the race an adversarial review proved: 2026-08-14) a MANUAL send that
 * is mid-flight right now. `isReceiptSendInFlight` is what decides "in
 * flight": it is keyed on `receiptSendingAt`, not on how long ago
 * `receiptSentAt` was last stamped, precisely so a manager's earlier FAILED
 * manual retry — which used to re-stamp `receiptSentAt` and silently evict
 * this row from the backlog for another `RECEIPT_RETRY_STALE_MS` — no longer
 * does: `markRepaymentReceiptOutcome` clears `receiptSendingAt` the instant
 * that failure is recorded, so this row is reachable again immediately, not
 * 15 more minutes later.
 */
export const claimRepaymentReceiptForRetry = internalMutation({
  args: { repaymentId: v.id("personalRepayments") },
  returns: v.union(
    v.object({
      repaymentId: v.id("personalRepayments"),
      payerPersonId: v.id("people"),
    }),
    v.null(),
  ),
  handler: async (ctx, { repaymentId }) => {
    const r = await ctx.db.get(repaymentId);
    if (!r) return null;
    if (!r.creditTransactionId || r.status !== "paid") return null;
    if (r.receiptSentAt === undefined) return null;
    if (r.receiptDeliveredAt !== undefined) return null;
    const now = Date.now();
    if (isReceiptSendInFlight(r, now)) return null;
    await ctx.db.patch(repaymentId, {
      receiptSentAt: now,
      receiptSendingAt: now,
      lastReceiptSendSource: "backfill",
    });
    return { repaymentId: r._id, payerPersonId: r.payerPersonId };
  },
});

/**
 * Record what actually happened to a claimed receipt send — the piece that
 * was entirely missing before: a lost receipt used to leave `receiptSentAt`
 * as the only trace, indistinguishable from a delivered one. Called by
 * `sendOneRepaymentReceiptGroup` after every attempt, live or retried.
 *
 * `"delivered"` is the ONLY outcome that means the payer actually has this
 * receipt — it stamps `receiptDeliveredAt` and CLEARS both failure fields,
 * so a retry that finally succeeds erases the trail that would otherwise
 * make the backfill re-scan a now-fine row forever. `"failed"` stamps
 * `receiptDeliveryFailedAt` + a short, bounded reason (never an unbounded
 * provider payload) and leaves `receiptDeliveredAt` untouched.
 *
 * EITHER outcome also CLEARS the in-flight lock (`receiptSendingAt`) — this
 * is the release side of the claim every claimer takes before sending. A
 * send that reaches this mutation at all (success or failure) is, by
 * definition, no longer in flight; leaving the lock set would wedge the row
 * against every other claimer for no reason until `RECEIPT_RETRY_STALE_MS`
 * expired on its own. Only a process that dies BEFORE reaching this mutation
 * leaves the lock standing — which is exactly the case the staleness bound
 * exists for.
 */
export const markRepaymentReceiptOutcome = internalMutation({
  args: {
    repaymentIds: v.array(v.id("personalRepayments")),
    outcome: v.union(v.literal("delivered"), v.literal("failed")),
    error: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { repaymentIds, outcome, error }) => {
    const now = Date.now();
    for (const id of repaymentIds) {
      const r = await ctx.db.get(id);
      if (!r) continue;
      if (outcome === "delivered") {
        await ctx.db.patch(id, {
          receiptDeliveredAt: now,
          receiptDeliveryFailedAt: undefined,
          lastReceiptError: undefined,
          receiptSendingAt: undefined,
        });
      } else {
        await ctx.db.patch(id, {
          receiptDeliveryFailedAt: now,
          // Bounded: this is a triage string, never a dumped provider body.
          lastReceiptError: (error ?? "unknown error").slice(0, 300),
          receiptSendingAt: undefined,
        });
      }
    }
    return null;
  },
});

/**
 * Everything `sendRepaymentReceiptEmail` needs for ONE payer's slice of a
 * claimed batch — `null` only when every id resolves to nothing (a race with
 * a deletion), which the sender treats as "nothing to mail".
 *
 * `paidAt` is the LATEST `updatedAt` across the rows rather than any single
 * one: `settleRepayment` stamps each row with its own `Date.now()` inside the
 * settlement loop, so a multi-line batch's rows can differ by a few
 * milliseconds — irrelevant at the day-level granularity the receipt prints,
 * but "latest" is the more honest answer to "when did this payment settle"
 * than "whichever row happened first".
 */
export const getRepaymentReceiptPayload = internalQuery({
  args: { repaymentIds: v.array(v.id("personalRepayments")) },
  returns: v.union(
    v.object({
      payerEmail: v.union(v.string(), v.null()),
      payerName: v.string(),
      paidAt: v.number(),
      totalCents: v.number(),
      method: repaymentMethodValidator,
      stripePaymentIntentId: v.union(v.string(), v.null()),
      lines: v.array(repaymentReceiptLineValidator),
    }),
    v.null(),
  ),
  handler: async (ctx, { repaymentIds }) => {
    const rows = (
      await Promise.all(repaymentIds.map((id) => ctx.db.get(id)))
    ).filter((r): r is Doc<"personalRepayments"> => r !== null);
    if (rows.length === 0) return null;

    // GUARD, LOCAL RATHER THAN REMOTE: today's only caller
    // (`sendOneRepaymentReceiptGroup`) always pre-groups ids by
    // `payerPersonId` before calling this, so every real batch already
    // shares one payer — but nothing here enforced that, which made it a
    // landmine for a future caller passing a mixed batch: it would have
    // silently put one payer's charges on another payer's receipt. Refuse
    // outright instead of guessing whose receipt this is.
    const payerPersonId = rows[0].payerPersonId;
    if (rows.some((r) => r.payerPersonId !== payerPersonId)) {
      throw new Error(
        `getRepaymentReceiptPayload: repaymentIds span more than one payer ` +
          `(${repaymentIds.join(", ")}) — every caller must pre-group by payer.`,
      );
    }

    const payer = await ctx.db.get(payerPersonId);
    const lines = await Promise.all(
      rows.map(async (r) => {
        const txn = await ctx.db.get(r.transactionId);
        return {
          merchantName: txn?.merchantNameOverride ?? txn?.merchantName ?? null,
          description: txn?.description ?? null,
          chargeDate: txn?.postedAt ?? null,
          amountCents: r.amountCents,
        };
      }),
    );

    return {
      payerEmail: payer?.pwEmail ?? payer?.email ?? null,
      payerName: payer?.name ?? "there",
      paidAt: Math.max(...rows.map((r) => r.updatedAt)),
      totalCents: rows.reduce((sum, r) => sum + r.amountCents, 0),
      method: rows[0].method,
      stripePaymentIntentId: rows[0].stripePaymentIntentId ?? null,
      lines,
    };
  },
});

const STRIPE_RECEIPT_API = "https://api.stripe.com/v1";

/**
 * Stripe's own hosted receipt for a settled repayment charge — the LIVE
 * expand call rule D calls for, mirroring `givingComms.ts#fetchAchFailureCode`'s
 * pattern but reached through the PaymentIntent directly: a repayment row
 * already persists `stripePaymentIntentId` (`settleRepayment`), so there's no
 * reason to detour through the Checkout Session the way the giving-comms
 * failure lookup does. `GET /payment_intents/{id}?expand[]=latest_charge` —
 * the receipt lives on the CHARGE, one level below the PaymentIntent, so an
 * unexpanded read never carries it.
 *
 * Best-effort by design, mirroring `fetchAchFailureCode`: `null` on ANY
 * problem — no `STRIPE_SECRET_KEY` configured, a non-2xx response, a network
 * throw, no charge yet, a charge with no `receipt_url`, or a `receipt_url`
 * that isn't `https://`. Nothing here is allowed to be the reason the
 * receipt email fails to send — see `lib/personalRepaymentReceiptEmail.ts`'s
 * doc for why a missing Stripe receipt DEGRADES the email rather than
 * blocking it.
 */
async function fetchStripeReceiptUrl(
  paymentIntentId: string,
): Promise<string | null> {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) return null;
  try {
    const response = await fetch(
      `${STRIPE_RECEIPT_API}/payment_intents/${encodeURIComponent(paymentIntentId)}` +
        `?expand[]=latest_charge`,
      { headers: { Authorization: `Bearer ${secretKey}` } },
    );
    if (!response.ok) return null;
    const intent = (await response.json()) as {
      latest_charge?: { receipt_url?: string | null } | string | null;
    };
    const charge = intent.latest_charge;
    // Unexpanded (a bare `ch_…`/`py_…` string) or absent — nothing to read.
    if (!charge || typeof charge === "string") return null;
    const url = charge.receipt_url;
    return typeof url === "string" && url.startsWith("https://") ? url : null;
  } catch (err) {
    console.error("[cards] fetchStripeReceiptUrl failed", paymentIntentId, err);
    return null;
  }
}

/**
 * Build and send ONE payer's receipt for a batch of repayment ids that are
 * ALREADY claimed (`receiptSentAt` stamped), then record what happened
 * (`markRepaymentReceiptOutcome`) so a lost send is traceable and
 * recoverable rather than silent — see this section's header ("a lost
 * receipt is silent AND permanent" was the bug; this function is the fix).
 *
 * Shared by the live send path (`sendRepaymentReceiptEmail`, one payer-group
 * per settlement event) and the backfill's per-row retry
 * (`repaymentReceiptBackfill.ts`) — both callers already own the claim
 * (`claimRepaymentReceipts` / `claimRepaymentReceiptForRetry`); this
 * function only knows "these ids were just claimed, mail them and record
 * the outcome."
 *
 * EVERY exit records an outcome — the four proven-silent failure paths this
 * fixes are all represented below:
 *  - the claimed rows vanished before send (a race with a deletion),
 *  - the payer has no email on file (used to be a bare `continue`, logging
 *    nothing at all — the worst of the four),
 *  - Resend didn't accept the send (no key configured, or a non-2xx
 *    response — `sendEmailReporting` swallows this into a `false`, so it's
 *    logged HERE with the repayment ids + address, which the underlying
 *    `[resend]`/`[ticketing]` logs never carried),
 *  - a genuine throw (a `fetch` transport failure, or `getRepaymentReceiptPayload`'s
 *    cross-payer guard) — caught locally so ONE payer group's failure can
 *    never abort a sibling group's send in the same batch.
 *
 * Returns the outcome so a caller that wants to tally results (the backfill)
 * doesn't need a second round trip to re-read the row.
 */
export async function sendOneRepaymentReceiptGroup(
  ctx: ActionCtx,
  repaymentIds: Id<"personalRepayments">[],
  feeCoveredCents: number,
): Promise<"delivered" | "failed"> {
  const fail = async (reason: string): Promise<"failed"> => {
    await ctx.runMutation(internal.cards.markRepaymentReceiptOutcome, {
      repaymentIds,
      outcome: "failed",
      error: reason,
    });
    return "failed";
  };

  try {
    const payload = await ctx.runQuery(
      internal.cards.getRepaymentReceiptPayload,
      { repaymentIds },
    );
    if (!payload) {
      console.error(
        "[cards] sendRepaymentReceiptEmail: claimed repayment rows vanished before send",
        repaymentIds,
      );
      return await fail("repayment rows were gone by send time");
    }
    if (!payload.payerEmail) {
      console.error(
        "[cards] sendRepaymentReceiptEmail: payer has no email on file — receipt claimed but never sent",
        repaymentIds,
      );
      return await fail("payer has no email on file");
    }

    const stripeReceiptUrl = payload.stripePaymentIntentId
      ? await fetchStripeReceiptUrl(payload.stripePaymentIntentId)
      : null;

    const link = appUrl("/finances/repayments");
    // KNOWN REPO TRAP: a `link ? <a> : ""` pattern here would silently
    // ship a CTA-less transactional email whenever APP_URL is unset.
    // Degrade LOUDLY instead — see `notifyPersonalChargeFlagged`.
    if (!link) {
      console.error(
        "[cards] sendRepaymentReceiptEmail: APP_URL is unset — sending WITHOUT a clickable repayments link",
        repaymentIds,
      );
    }

    const receipt = buildRepaymentReceipt({
      payerName: payload.payerName,
      paidAt: payload.paidAt,
      lines: payload.lines,
      totalCents: payload.totalCents,
      method: payload.method,
      feeCoveredCents: feeCoveredCents > 0 ? feeCoveredCents : null,
      stripeReceiptUrl,
      link,
    });

    // `sendEmailReporting`, not the fire-and-forget `sendEmail`: this is
    // exactly the caller `sendEmailReporting`'s own doc names as needing the
    // real delivery outcome. A rejected/non-2xx response resolves `false`
    // here (never thrown); a genuine transport failure still throws, which
    // the outer catch below turns into a recorded failure too.
    const delivered = await sendEmailReporting(ctx, {
      to: payload.payerEmail,
      subject: receipt.subject,
      html: receipt.html,
    });

    if (!delivered) {
      console.error(
        "[cards] sendRepaymentReceiptEmail: Resend did not accept the send",
        { repaymentIds, to: payload.payerEmail },
      );
      return await fail(
        "Resend rejected the send (no key configured, or a non-2xx response)",
      );
    }

    await ctx.runMutation(internal.cards.markRepaymentReceiptOutcome, {
      repaymentIds,
      outcome: "delivered",
    });
    return "delivered";
  } catch (err) {
    console.error(
      "[cards] sendRepaymentReceiptEmail: send failed for payer group",
      repaymentIds,
      err,
    );
    try {
      return await fail(
        (err instanceof Error ? err.message : String(err)).slice(0, 300),
      );
    } catch (innerErr) {
      // The failure record itself couldn't be written — still don't let
      // this throw escape and abort a sibling payer group's send.
      console.error(
        "[cards] sendRepaymentReceiptEmail: failed to record failure outcome",
        repaymentIds,
        innerErr,
      );
      return "failed";
    }
  }
}

/**
 * "You paid this off — here's your receipt", scheduled by whichever
 * settlement caller just cleared one or more repayments in a single payment
 * event. See this section's header for the seam and the exactly-once story.
 *
 * Claims first (`claimRepaymentReceipts`), then GROUPS the claimed ids by
 * payer — normally one group, since a batch is normally one person's own
 * charges — and mails each payer their OWN itemized receipt, never another
 * payer's charges. `feeCoveredCents` is attributed to a group only when the
 * WHOLE claimed batch is that one group: split across payers with no
 * per-line record of who agreed to cover what, it would be a guess, so a
 * genuinely multi-payer batch drops the fee note and logs loudly instead of
 * mis-attributing it.
 *
 * Each payer group is sent (and its outcome recorded) by
 * `sendOneRepaymentReceiptGroup`, which catches its OWN failures — so one
 * payer's send failing can never abort a sibling payer's send in the same
 * batch. The outer try/catch here is a last-resort net for a throw outside
 * that per-group boundary (e.g. the initial claim itself), for the same
 * reason `notifyPersonalChargeFlagged` wraps its own body: this runs after
 * the payment has already committed, and must never surface as a failed
 * scheduled job.
 */
export const sendRepaymentReceiptEmail = internalAction({
  args: {
    repaymentIds: v.array(v.id("personalRepayments")),
    feeCoveredCents: v.optional(v.number()),
  },
  handler: async (ctx, { repaymentIds, feeCoveredCents }) => {
    try {
      if (repaymentIds.length === 0) return null;
      const claimed: Array<{
        repaymentId: Id<"personalRepayments">;
        payerPersonId: Id<"people">;
      }> = await ctx.runMutation(internal.cards.claimRepaymentReceipts, {
        repaymentIds,
      });
      if (claimed.length === 0) return null;

      const groups = new Map<Id<"people">, Id<"personalRepayments">[]>();
      for (const c of claimed) {
        const list = groups.get(c.payerPersonId) ?? [];
        list.push(c.repaymentId);
        groups.set(c.payerPersonId, list);
      }
      if (groups.size > 1 && (feeCoveredCents ?? 0) > 0) {
        console.error(
          "[cards] sendRepaymentReceiptEmail: fee coverage on a batch spanning " +
            "multiple payers — omitting the fee note rather than guessing an " +
            "attribution",
          repaymentIds,
        );
      }
      const feeForSingleGroup = groups.size === 1 ? (feeCoveredCents ?? 0) : 0;

      for (const ids of groups.values()) {
        await sendOneRepaymentReceiptGroup(ctx, ids, feeForSingleGroup);
      }
    } catch (err) {
      console.error("sendRepaymentReceiptEmail: failed", repaymentIds, err);
    }
    return null;
  },
});

// ── Manual "Send receipt" (a manager, on demand) ──────────────────────────────
//
// Founder: "add an email button for already paid reimbursements or whatever.
// Allowing me to manually send a receipt to someone that needs it. Say they
// forgot it, or they just need it resent. Or, you know, it's in the past. So
// let me do that, because there's some payments that I want to send receipts
// for, or repayments I want to send receipts for."
//
// The automatic path above is deliberately AT MOST ONCE, and that guarantee
// stays exactly as strict as it was — `claimRepaymentReceipts` still refuses
// anything with `receiptSentAt` set. This is a SEPARATE path that deliberately
// does NOT carry that same restriction: a manager choosing to (re)send is the
// whole feature, including for a repayment that settled long before receipts
// existed at all (`receiptSentAt` already set from that era) or one whose one
// automatic attempt simply failed. It reuses every piece of the automatic
// path's send machinery — `getRepaymentReceiptPayload`, `buildRepaymentReceipt`,
// `sendOneRepaymentReceiptGroup`, `markRepaymentReceiptOutcome` — so there is
// still exactly one composer and one sender, just three ways to reach them.
//
// "NOT RESTRICTED BY THE AUTOMATIC GUARD" IS NOT THE SAME AS "UNGUARDED"
// (adversarial review, 2026-08-14 — two proven findings fixed here):
//
//  1. CONCURRENCY. A manual send used to claim unconditionally, with no idea
//     whether an automatic or backfill send was ALREADY in flight for the
//     same row — proven sequence: the backfill claims a stale row (claim
//     commits, send not yet issued), a manual send runs to completion (one
//     email), then the backfill's own send finishes (a second email). Fixed
//     by the shared in-flight lock, `receiptSendingAt` (see its schema doc):
//     every claimer — this one included — checks it before claiming and
//     refuses with a clear `RECEIPT_SEND_IN_FLIGHT` error rather than racing
//     whoever holds it. The lock has its own staleness escape hatch
//     (`RECEIPT_RETRY_STALE_MS`) so a crashed process can never wedge a row
//     shut forever.
//  2. VOLUME. Nothing bounded how often a manager (or a bug, or a runaway
//     loop) could press this — a 50-call probe against this exact action
//     produced 50 Resend sends. Fixed by `MANUAL_RECEIPT_RESEND_COOLDOWN_MS`
//     (60s, this path ONLY — see that constant's doc for why the automatic
//     and backfill paths get none): a second manual claim inside the window
//     is refused with a clear `RECEIPT_SEND_COOLDOWN` error naming when to
//     retry, never a silent no-op.
//
// WHAT `receiptSentAt` MEANS AFTER A MANUAL SEND: "the most recent attempt",
// not "the first attempt ever" — the same meaning `claimRepaymentReceiptForRetry`
// already gives it when the backfill retries a stale send. It is re-stamped
// to `Date.now()` on every CLAIMED manual send, live or not (a REFUSED one —
// in-flight or cooled-down — claims nothing and stamps nothing).
// `receiptDeliveredAt` / `receiptDeliveryFailedAt` are still the fields that
// answer "did the payer actually get one" — those come only from
// `markRepaymentReceiptOutcome`, exactly as before.
//
// AUDIT (the other proven finding: no record of who sent what, or how often).
// `lastReceiptSentBy` (this path only — automatic/backfill have no human to
// name) and `lastReceiptSendSource` (every path) are stamped on every claim,
// so "was this manual or automatic, and who pressed it" is answerable from
// the row itself — see both fields' schema docs.

/**
 * The mutation half of a manual send: gate, verify the repayment is genuinely
 * settled and in the caller's chapter, check the in-flight lock and the
 * cooldown, and — only once both pass — stamp the claim (`receiptSentAt`,
 * `receiptSendingAt`, `lastManualReceiptSendAt`, `lastReceiptSentBy`,
 * `lastReceiptSendSource`) — all in ONE transaction, the same shape
 * `claimRepaymentReceipts` uses. Deliberately does NOT check `receiptSentAt`
 * on its own (a prior automatic/backfill/manual attempt, successful or not,
 * is never by itself a reason to refuse) — see this section's header for why
 * re-sending on purpose is the point; only a send that's genuinely happening
 * RIGHT NOW, or one that JUST happened seconds ago, is refused.
 */
export const claimRepaymentReceiptManual = internalMutation({
  args: { repaymentId: v.id("personalRepayments") },
  returns: v.object({
    repaymentId: v.id("personalRepayments"),
    payerPersonId: v.id("people"),
  }),
  handler: async (ctx, { repaymentId }) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireRepaymentsCollect(ctx, chapterId);
    const callerPersonId = await resolveCallerPersonId(ctx, chapterId);

    const r = await ctx.db.get(repaymentId);
    await requireInChapter(ctx, chapterId, r, "Repayment");
    if (!r!.creditTransactionId || r!.status !== "paid") {
      throw new ConvexError({
        code: "NOT_SETTLED",
        message:
          "This repayment hasn't been paid yet — there's nothing to email a receipt for.",
      });
    }

    const now = Date.now();
    // GUARD 1 — concurrency. A send genuinely in flight for this row right
    // now (automatic, backfill, or another manual press) must never be
    // raced — see `receiptSendingAt`'s schema doc.
    if (isReceiptSendInFlight(r!, now)) {
      throw new ConvexError({
        code: "RECEIPT_SEND_IN_FLIGHT",
        message:
          "A receipt for this repayment is already being sent — try again in a moment.",
      });
    }
    // GUARD 2 — volume. A manual send within the cooldown of the LAST manual
    // send is refused with a clear, honest wait time — never a silent no-op.
    // Automatic/backfill claims never set `lastManualReceiptSendAt`, so
    // neither of those paths can ever trip this.
    if (r!.lastManualReceiptSendAt !== undefined) {
      const elapsed = now - r!.lastManualReceiptSendAt;
      if (elapsed < MANUAL_RECEIPT_RESEND_COOLDOWN_MS) {
        const retryInSeconds = Math.ceil(
          (MANUAL_RECEIPT_RESEND_COOLDOWN_MS - elapsed) / 1000,
        );
        throw new ConvexError({
          code: "RECEIPT_SEND_COOLDOWN",
          message: `A receipt was just sent for this repayment — try again in ${retryInSeconds}s.`,
        });
      }
    }

    await ctx.db.patch(repaymentId, {
      receiptSentAt: now,
      receiptSendingAt: now,
      lastManualReceiptSendAt: now,
      lastReceiptSentBy: callerPersonId,
      lastReceiptSendSource: "manual",
    });
    return { repaymentId: r!._id, payerPersonId: r!.payerPersonId };
  },
});

/** The claimed row's most recent failure reason, so a manual send's failure
 *  can tell a manager something real ("payer has no email on file") instead
 *  of a generic "try again" — the backlog's most common actual cause is
 *  exactly that, and it's actionable. */
export const getRepaymentReceiptFailureReason = internalQuery({
  args: { repaymentId: v.id("personalRepayments") },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, { repaymentId }) => {
    const r = await ctx.db.get(repaymentId);
    return r?.lastReceiptError ?? null;
  },
});

/**
 * "Send receipt" / "Resend receipt" — the manual, per-row action behind the
 * Repaid section's button (`PersonalChargesView.tsx`). Manager-gated
 * (`requireRepaymentsCollect`, re-checked inside the claim mutation — the
 * same rung `nudgeOutstandingRepayments` uses, because this is also an
 * outbound email with somebody's name and an amount on it, just to the
 * person who already paid instead of the person who still owes).
 *
 * Synchronous, unlike the automatic path (which schedules and returns
 * immediately): a manager pressing this button is watching for the outcome,
 * so it sends inline and THROWS on failure — never reports success either
 * way. `useActionRunner` on the client turns that throw into a real error
 * toast instead of a silent no-op that leaves a manager believing an email
 * went out when it didn't.
 */
export const sendRepaymentReceiptManually = action({
  args: { repaymentId: v.id("personalRepayments") },
  returns: v.null(),
  handler: async (ctx, { repaymentId }) => {
    const claimed: {
      repaymentId: Id<"personalRepayments">;
      payerPersonId: Id<"people">;
    } = await ctx.runMutation(internal.cards.claimRepaymentReceiptManual, {
      repaymentId,
    });

    const outcome = await sendOneRepaymentReceiptGroup(
      ctx,
      [claimed.repaymentId],
      0,
    );
    if (outcome === "failed") {
      const reason: string | null = await ctx.runQuery(
        internal.cards.getRepaymentReceiptFailureReason,
        { repaymentId: claimed.repaymentId },
      );
      throw new ConvexError({
        code: "SEND_FAILED",
        message: reason
          ? `Couldn't send the receipt: ${reason}`
          : "Couldn't send the receipt — try again in a moment.",
      });
    }
    return null;
  },
});

// ── THERE IS NO MANUAL "MARK REPAID" (founder, 2026-08-14) ───────────────────
// "We should only mark repaid when you actually pay through the platform. No
// manual mark as paid."
//
// `markRepaymentPaid` used to live here: a manager-only mutation that posted
// the offsetting credit on a human's say-so, for the case where somebody
// handed over cash or sent a Venmo. It is deleted, and the deletion is the
// feature. Three things it was quietly costing:
//
//  · A DOUBLE-PAY RACE. A manager clicking it while the payer sat in Stripe
//    Checkout meant the payer paid for a debt that no longer existed. The
//    webhook could only log the discrepancy loudly and leave a human to sort
//    out a refund. With settlement reachable ONLY through a rail this app
//    itself started, that race cannot be constructed.
//  · AN UNPROVABLE LEDGER. A `paid` repayment now always has a payment behind
//    it — a Stripe PaymentIntent or an Increase transfer — so "was this
//    actually repaid?" is answerable from the row rather than from whoever
//    remembers the conversation. That is the same standard the public ledger
//    is published against.
//  · A TEMPTING SHORTCUT. It was the fastest way to make an awkward row go
//    away, which is exactly what you do not want the fastest way to be.
//
// What replaces it depends on which thing is true:
//  · They owe it → they pay through the app (`/finances/repayments`), by card
//    or by bank debit. That is the only path to `paid`.
//  · It was never a personal charge → `unflagPersonalCharge` reverses the
//    flag and the charge goes back to being org spend, which is the honest
//    correction for a mis-flag and still refuses once a repayment has settled.
//
// A charge somebody genuinely paid back in cash last month has no button. That
// is deliberate: the answer is to run it through the app, or to unflag it and
// record the cash as its own ledger entry — not to assert a settlement the
// books cannot show.

// ── linkRepaymentBankAccount (action, the payer) — ACH destination capture ───

/** Gate a bank-account link: PAYER-ONLY (never a manager). Linking supplies raw
 *  routing + account numbers that originate an ACH DEBIT against that account — a
 *  manager must never be able to enter SOMEONE ELSE's bank numbers and pull from
 *  an arbitrary account the victim never touched. Managers keep the manual
 *  `markRepaymentPaid` confirmation instead. Only before the repayment settles. */
export const beginLinkRepaymentBankAccount = internalMutation({
  args: { repaymentId: v.id("personalRepayments") },
  handler: async (ctx, { repaymentId }) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    const access = await getFinanceRole(ctx, chapterId);
    const repayment = await ctx.db.get(repaymentId);
    await requireInChapter(ctx, chapterId, repayment, "Repayment");

    const isPayer =
      access.personId != null && access.personId === repayment!.payerPersonId;
    if (!isPayer) {
      throw new ConvexError({
        code: "FORBIDDEN",
        message: "Only the payer can link a bank account for this repayment.",
      });
    }
    if (repayment!.status === "paid" || repayment!.creditTransactionId) {
      throw new ConvexError({
        code: "ILLEGAL_TRANSITION",
        message: "This repayment has already been settled.",
      });
    }
    const payer = await ctx.db.get(repayment!.payerPersonId);
    return { repaymentId: repayment!._id, payerName: payer?.name ?? "Repayment payer" };
  },
});

/** Patch a repayment's linked funding source once the Increase External
 *  Account exists. A re-link replaces the prior one. */
export const attachRepaymentExternalAccount = internalMutation({
  args: {
    repaymentId: v.id("personalRepayments"),
    externalAccountId: v.string(),
    last4: v.string(),
  },
  handler: async (ctx, { repaymentId, externalAccountId, last4 }) => {
    // TOCTOU re-check: the link gate verified the repayment wasn't settled, then
    // a slow Increase `createExternalAccount` ran. Re-verify before patching, so
    // a repayment settled in the meantime (e.g. a manager's `markRepaymentPaid`)
    // never has a funding source stamped onto it after the fact. No-op cleanly.
    const repayment = await ctx.db.get(repaymentId);
    if (
      !repayment ||
      repayment.status === "paid" ||
      repayment.creditTransactionId
    ) {
      return null;
    }
    await ctx.db.patch(repaymentId, {
      payerExternalAccountId: externalAccountId,
      payerAccountLast4: last4,
      updatedAt: Date.now(),
    });
    return null;
  },
});

/**
 * Link the PAYER's own bank account (routing + account number) to a personal-
 * charge repayment, so `initiateRepayment` can pull a real ACH debit instead of
 * degrading to a manager's manual `markRepaymentPaid` confirmation. Creates an
 * Increase External Account (`increase.createExternalAccount`) — the raw
 * account number is NEVER persisted, only the returned reference id + a
 * last-4 for display. Only the payer (or a manager acting for them) may link
 * it, and only before the repayment has settled.
 *
 * BEST-EFFORT: if the Increase call fails or isn't configured, the repayment
 * is left exactly as it was — `linked:false` tells the UI the link didn't take
 * (the member can retry, or a manager confirms receipt by hand instead).
 */
export const linkRepaymentBankAccount = action({
  args: {
    repaymentId: v.id("personalRepayments"),
    routingNumber: v.string(),
    accountNumber: v.string(),
    accountHolderName: v.optional(v.string()),
    funding: v.optional(externalAccountFundingValidator),
  },
  handler: async (ctx, args): Promise<{ linked: boolean }> => {
    const routingNumber = assertRoutingNumber(args.routingNumber);
    const accountNumber = assertAccountNumber(args.accountNumber);

    const prep = await ctx.runMutation(
      internal.cards.beginLinkRepaymentBankAccount,
      { repaymentId: args.repaymentId },
    );

    const created = await ctx.runAction(internal.increaseExternalAccounts.createExternalAccount, {
      routingNumber,
      accountNumber,
      accountHolderName: (args.accountHolderName?.trim() || prep.payerName).slice(
        0,
        200,
      ),
      funding: args.funding ?? "checking",
    });
    if (!created) return { linked: false };

    await ctx.runMutation(internal.cards.attachRepaymentExternalAccount, {
      repaymentId: prep.repaymentId,
      externalAccountId: created.externalAccountId,
      last4: created.last4,
    });
    return { linked: true };
  },
});

// ── initiateRepayment (action, the payer) ────────────────────────────────────

/**
 * KILL-SWITCH for the real ACH DEBIT pull. Deliberately `false`.
 *
 * `initiateRepayment` originates an ACH DEBIT (a `-amount` pull from the payer's
 * linked account). Unlike an outbound CREDIT — irrevocably sent at `submitted` —
 * an ACH debit routinely BOUNCES days later (R01 NSF, etc.), and this PR ships NO
 * state machine for the debit's `ach_transfer.*` webhooks: a 201 from
 * `POST /ach_transfers` is treated as settled and the debt-clearing credit is
 * posted IMMEDIATELY, so a later bounce would silently forgive the member's debt
 * forever. Until that state machine exists, keep the debit OFF: `canCharge` stays
 * false, so `initiateRepayment` degrades to the manual `markRepaymentPaid` path
 * exactly as before this PR. All the bank-linking / external-account plumbing is
 * KEPT and becomes reachable the moment this flips true.
 *
 * TODO(repayment-debit): the follow-up WP that flips this true MUST:
 *   1. Track the debit's Increase transfer id on `personalRepayments` (a new
 *      `debitTransferId` field) at origination — do NOT settle on the 201.
 *   2. Settle (post the offsetting credit) only when the debit reaches
 *      `submitted` via an `ach_transfer.*` webhook — NOT at creation.
 *   3. On a later `returned` webhook, REVERSE the settlement (delete/void the
 *      offsetting credit and re-open the repayment to `pending`), mirroring
 *      `reverseSettledPayout` on the payout side.
 *   4. See the adversarial review on PR #137 (BLOCKER 2).
 */
const REPAYMENT_DEBIT_ENABLED = false;

/** Reject a non-positive ACH debit amount before origination — mirrors
 *  `increase.assertPositivePayout`. Defense in depth even while the debit is
 *  gated off: a $0 (or non-integer) pull must never be sent. */
function assertPositiveRepayment(amountCents: number): void {
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new ConvexError({
      code: "INVALID_AMOUNT",
      message: "A repayment must be a positive whole number of cents.",
    });
  }
}

/** Gate the payer + set the chosen method + decide if a real Increase charge is
 *  addressable. Returns the paid summary if already settled (idempotent). */
export const beginRepayment = internalMutation({
  args: {
    repaymentId: v.id("personalRepayments"),
    method: repaymentMethodValidator,
  },
  returns: v.union(
    v.object({ kind: v.literal("paid"), repayment: repaymentSummaryValidator }),
    v.object({
      kind: v.literal("pending"),
      repayment: repaymentSummaryValidator,
      canCharge: v.boolean(),
      increaseAccountId: v.union(v.string(), v.null()),
      amountCents: v.number(),
      payerExternalAccountId: v.union(v.string(), v.null()),
    }),
  ),
  handler: async (ctx, args): Promise<BeginRepaymentResult> => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    const access = await getFinanceRole(ctx, chapterId);
    const repayment = await ctx.db.get(args.repaymentId);
    await requireInChapter(ctx, chapterId, repayment, "Repayment");

    // Only the payer (or a manager acting for them) initiates their repayment.
    const isPayer =
      access.personId != null && access.personId === repayment!.payerPersonId;
    if (!isPayer && !access.isManager) {
      throw new ConvexError({
        code: "FORBIDDEN",
        message: "Only the payer can initiate this repayment.",
      });
    }

    if (repayment!.status === "paid" || repayment!.creditTransactionId) {
      return { kind: "paid", repayment: toRepaymentSummary(repayment!) };
    }

    // Record the chosen method.
    if (repayment!.method !== args.method) {
      await ctx.db.patch(args.repaymentId, {
        method: args.method,
        updatedAt: Date.now(),
      });
    }
    const fresh = (await ctx.db.get(args.repaymentId))!;

    // Mode-aware: charge into the chapter's CURRENT-environment account.
    const sandboxMode = await readSandbox(ctx);
    const account = await getChapterAccountForMode(ctx, chapterId, sandboxMode);
    const increaseAccountId =
      account && account.onboardingStatus === "active" && account.increaseAccountId
        ? account.increaseAccountId
        : null;

    // Charging the payer's OWN debit/ACH needs their Increase External Account
    // (routing+account), linked via `linkRepaymentBankAccount`. Until that's
    // done `canCharge` stays false and the repayment settles via the manager's
    // `markRepaymentPaid` confirmation instead.
    const payerExternalAccountId = fresh.payerExternalAccountId ?? null;
    const hasPayerFundingSource = !!payerExternalAccountId;
    // The key that will ACTUALLY charge the debit is resolved from the
    // ACCOUNT's own id prefix (`increaseEnvForObjectId`), not the plain
    // `INCREASE_API_KEY` — a sandbox-provisioned account needs
    // `INCREASE_SANDBOX_API_KEY` even while the deployment is in production
    // mode. Checking the wrong env var here would silently degrade every
    // sandbox repayment charge to pending.
    const accountEnvKey = increaseAccountId
      ? increaseEnvForObjectId(increaseAccountId).key
      : undefined;
    // REPAYMENT_DEBIT_ENABLED gates the real ACH debit off until a debit-bounce
    // state machine ships (see the constant's doc). While false, `canCharge` is
    // always false → degrade to the manual `markRepaymentPaid` confirmation.
    const canCharge =
      REPAYMENT_DEBIT_ENABLED &&
      !!accountEnvKey &&
      !!increaseAccountId &&
      hasPayerFundingSource;

    return {
      kind: "pending",
      repayment: toRepaymentSummary(fresh),
      canCharge,
      increaseAccountId,
      amountCents: fresh.amountCents,
      payerExternalAccountId,
    };
  },
});

/** Apply a successful Increase repayment charge: settle + record the ref. */
export const applyRepaymentPaid = internalMutation({
  args: {
    repaymentId: v.id("personalRepayments"),
    increaseRef: v.string(),
  },
  returns: repaymentSummaryValidator,
  handler: async (ctx, args): Promise<RepaymentSummary> => {
    const repayment = await ctx.db.get(args.repaymentId);
    if (!repayment) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Repayment not found.",
      });
    }
    // TOCTOU / double-collection guard: a manager may have confirmed receipt via
    // `markRepaymentPaid` between `beginRepayment` and this settle. If the
    // offsetting credit is already posted, DO NOT post a second one — but the real
    // Increase debit DID pull funds, so the member was effectively charged twice;
    // flag the transfer for MANUAL REVIEW / REFUND rather than silently settling.
    if (repayment.creditTransactionId) {
      console.error(
        `[cards] applyRepaymentPaid: repayment ${args.repaymentId} already settled ` +
          `(credit ${repayment.creditTransactionId}); the Increase debit ${args.increaseRef} ` +
          `needs MANUAL REVIEW / REFUND (possible double collection).`,
      );
      return toRepaymentSummary(repayment);
    }
    const settled = await settleRepayment(ctx, repayment, {
      increaseRef: args.increaseRef,
    });
    // ONE repayment settles per call on this rail, so the batch this
    // schedules IS the payment event — see this file's "Payment receipt"
    // section for why the seam lives at each settlement CALLER rather than
    // inside `settleRepayment` itself. No Stripe fee coverage exists on this
    // rail (that option only ever appears in Stripe Checkout metadata).
    await ctx.scheduler.runAfter(0, internal.cards.sendRepaymentReceiptEmail, {
      repaymentIds: [settled._id],
      feeCoveredCents: 0,
    });
    return toRepaymentSummary(settled);
  },
});

// ── Stripe repayment (the "card" method — Stripe Checkout) ───────────────────
// `initiateRepayment`'s `method:"card"` used to be indistinguishable from
// `"ach"` at the backend (both funneled through the Increase-only
// `beginRepayment`, which is entirely gated off by `REPAYMENT_DEBIT_ENABLED`)
// — a payer's "Pay by card" tap silently did nothing but record the chosen
// method. This section gives "card" a REAL rail: Stripe Checkout, mirroring
// `stripe.ts#createCheckout` / `createDonationCheckout` exactly — an action
// does the Stripe `fetch`, an internal mutation validates + applies. The
// webhook settles through the SAME `settleRepayment` core every other
// repayment rail uses, so idempotency is one guarantee, not one per rail.

/** One line a bundled Checkout will bill — a single outstanding repayment. */
interface RepaymentCheckoutLine {
  repaymentId: Id<"personalRepayments">;
  amountCents: number;
  merchantName: string | null;
}

/**
 * Validate + prepare a Stripe Checkout for one or more repayments. Same
 * payer-or-manager OR-gate as `beginRepayment`. An id that's already SETTLED
 * is silently skipped (not an error) — a stale button click that raced a
 * manager's `markRepaymentPaid` degrades to "bill whatever's still owed"
 * instead of failing outright; this throws only when NOTHING is left to bill.
 *
 * ── THE PAYER COVERS STRIPE'S CUT (founder, 2026-08-14) ──────────────────────
 * "Make sure that we add any Stripe fees that are associated with that,
 * because they're reimbursing — we have to get back whatever Stripe fees we
 * lose from that transaction."
 *
 * Before this, a $100 personal charge was billed at exactly $100.00 and the
 * org netted $96.71: the volunteer's mistake cost the ministry $3.29 to
 * correct. The debt is now grossed up so the org nets the debt WHOLE, using
 * the same `grossUpCents` algebra and the same live rate the giving page's
 * "cover the fees" option uses (`lib/feeSchedule.ts` → the stored override, or
 * the published 2.9% + 30¢).
 *
 * ONE GROSS-UP PER BATCH, NOT PER LINE. Stripe's 30¢ is charged per PAYMENT,
 * not per line item, so grossing up each charge separately would over-collect
 * 30¢ for every charge past the first — on a five-charge batch, $1.20 of
 * over-collection that nobody agreed to. `feeCoverageCents` is therefore
 * computed once, over the batch total, and billed as a single extra line.
 * `financeRepaymentFee.test.ts` asserts exactly this.
 */
export const prepareRepaymentCheckout = internalMutation({
  args: {
    repaymentIds: v.array(v.id("personalRepayments")),
    method: repaymentMethodValidator,
  },
  returns: v.object({
    lines: v.array(
      v.object({
        repaymentId: v.id("personalRepayments"),
        amountCents: v.number(),
        merchantName: v.union(v.string(), v.null()),
      }),
    ),
    /** The debt itself — what the org must NET. */
    totalCents: v.number(),
    /** What covering Stripe's cut adds on top, on the CHOSEN rail. 0 when
     *  that rail has no configured rate, in which case the org simply eats
     *  the fee as it did before — never a blocked repayment over a missing
     *  rate row. */
    feeCents: v.number(),
    /** `totalCents + feeCents` — what Stripe actually charges. */
    chargeCents: v.number(),
    /** "2.9% + $0.30" / "0.8% capped at $5.00" — the rate as a person reads
     *  it, for the fee line item's own label so the payer sees WHY on
     *  Stripe's page, not just how much. */
    feeRateLabel: v.union(v.string(), v.null()),
    /** Stripe Checkout's `payment_method_types`, or null to take Stripe's
     *  default (card + whatever wallets the account accepts). */
    paymentMethodTypes: v.union(v.array(v.string()), v.null()),
    payerEmail: v.union(v.string(), v.null()),
    payerName: v.string(),
  }),
  handler: async (ctx, { repaymentIds, method }) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    const access = await getFinanceRole(ctx, chapterId);

    const lines: RepaymentCheckoutLine[] = [];
    let payerPersonId: Id<"people"> | null = null;
    for (const id of repaymentIds) {
      const repayment = await ctx.db.get(id);
      if (!repayment || repayment.chapterId !== chapterId) continue;
      const isPayer =
        access.personId != null && access.personId === repayment.payerPersonId;
      if (!isPayer && !access.isManager) {
        throw new ConvexError({
          code: "FORBIDDEN",
          message: "Only the payer or a finance manager can pay back this charge.",
        });
      }
      payerPersonId = repayment.payerPersonId;
      // Skips settled rows AND ones with a bank debit already in flight — see
      // `isBillableRepayment`. A stale button click that raced another
      // checkout degrades to "bill whatever is still billable" rather than
      // collecting the same debt twice.
      if (!isBillableRepayment(repayment)) continue;
      const txn = await ctx.db.get(repayment.transactionId);
      lines.push({
        repaymentId: repayment._id,
        amountCents: repayment.amountCents,
        merchantName: txn?.merchantName ?? null,
      });
    }
    if (lines.length === 0) {
      throw new ConvexError({
        code: "NOTHING_OWED",
        message: "Nothing outstanding to pay back.",
      });
    }
    const payer = payerPersonId ? await ctx.db.get(payerPersonId) : null;
    const totalCents = lines.reduce((sum, l) => sum + l.amountCents, 0);
    const { feeCents, rateLabel: feeRateLabel } = await repaymentFeeQuoteFor(
      ctx,
      totalCents,
      method,
    );
    // The chosen method is stamped on every row NOW, not at settlement: it is
    // what the payer picked, and a repayment whose stored `method` still said
    // "card" while a bank debit cleared against it would misdescribe the one
    // record anybody looks at afterwards.
    for (const line of lines) {
      await ctx.db.patch(line.repaymentId, { method, updatedAt: Date.now() });
    }
    return {
      lines,
      totalCents,
      feeCents,
      chargeCents: totalCents + feeCents,
      feeRateLabel,
      paymentMethodTypes: stripePaymentMethodTypes(method),
      payerEmail: payer?.pwEmail ?? payer?.email ?? null,
      payerName: payer?.name ?? "Repayment",
    };
  },
});


/** Stamp the Checkout Session id onto every repayment it bundled — best
 *  effort per row (a repayment settled in the TOCTOU gap between
 *  `prepareRepaymentCheckout` and the Stripe round-trip is simply skipped). */
export const attachRepaymentStripeSession = internalMutation({
  args: {
    repaymentIds: v.array(v.id("personalRepayments")),
    sessionId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, { repaymentIds, sessionId }) => {
    for (const id of repaymentIds) {
      const repayment = await ctx.db.get(id);
      if (!repayment || repayment.status === "paid") continue;
      await ctx.db.patch(id, {
        stripeCheckoutSessionId: sessionId,
        updatedAt: Date.now(),
      });
    }
    return null;
  },
});

/**
 * A BANK DEBIT IS ON ITS WAY — move every repayment in the session to
 * `processing`.
 *
 * Called from `http.ts` when `checkout.session.completed` arrives with the
 * money NOT yet settled (`checkoutSessionHasSettled` false), which today means
 * ACH direct debit: the payer authorised it, and about four business days
 * later one of `async_payment_succeeded` / `async_payment_failed` says what
 * actually happened.
 *
 * The state exists for exactly one reason. Left `pending`, the payer opens
 * their repayments page the next morning, reads "you owe $248", and pays it
 * again — a real double-collection caused by telling the truth badly. Marked
 * `paid`, the org would be clearing a debt against money that may never
 * arrive, which is the failure the giving side already refuses to ship. So:
 * still outstanding for every accounting purpose (`personalExpenseState`,
 * `isRepaymentOutstanding`), not billable again (`isBillableRepayment`), and
 * visibly in flight on screen.
 *
 * No credit is posted here. Nothing about the ledger moves until the money
 * does. Idempotent, and it never touches a repayment that has already settled
 * through another rail.
 */
export const markRepaymentsProcessing = internalMutation({
  args: {
    repaymentIds: v.array(v.id("personalRepayments")),
    sessionId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, { repaymentIds, sessionId }) => {
    for (const id of repaymentIds) {
      const repayment = await ctx.db.get(id);
      if (!repayment) continue;
      if (repayment.status === "paid" || repayment.creditTransactionId) continue;
      await ctx.db.patch(id, {
        status: "processing",
        stripeCheckoutSessionId: sessionId,
        updatedAt: Date.now(),
      });
    }
    return null;
  },
});

/**
 * NO MONEY IS COMING FROM THIS SESSION — put the debt back where it was.
 *
 * Shared by `checkout.session.async_payment_failed` (the bank refused the
 * debit) and `checkout.session.expired` (the payer walked away), mirroring
 * `http.ts#cancelCheckoutSession`'s own pairing of those two events: both mean
 * the same thing, and writing them as two paths is how they drift.
 *
 * A REFUSED debit lands on `failed`, not back on `pending`. The distinction is
 * the payer's, not the ledger's — `personalExpenseState` reads both as unpaid
 * and `isRepaymentOutstanding` covers both — but "your bank refused this"
 * needs saying, and a row that quietly reverted to `pending` would leave
 * somebody wondering why a payment they made never happened. An EXPIRED
 * session never charged anything, so it goes back to `pending` with nothing
 * to report.
 *
 * Scoped by `stripeCheckoutSessionId`: only rows this exact session is holding
 * are released. A repayment that was re-checked-out under a newer session in
 * the meantime keeps that newer session's state, so a late failure event for
 * an abandoned session cannot knock a live payment back to pending.
 *
 * Never touches a settled repayment. Idempotent.
 */
export const releaseRepaymentCheckout = internalMutation({
  args: {
    sessionId: v.string(),
    outcome: v.union(v.literal("failed"), v.literal("expired")),
  },
  returns: v.null(),
  handler: async (ctx, { sessionId, outcome }) => {
    const held = await ctx.db
      .query("personalRepayments")
      .withIndex("by_stripe_session", (q) =>
        q.eq("stripeCheckoutSessionId", sessionId),
      )
      .take(CHAPTER_REPAYMENTS_LIMIT);
    for (const repayment of held) {
      if (repayment.status === "paid" || repayment.creditTransactionId) continue;
      await ctx.db.patch(repayment._id, {
        status: outcome === "failed" ? "failed" : "pending",
        updatedAt: Date.now(),
      });
    }
    return null;
  },
});

/**
 * Settle every listed repayment from a PAID Stripe Checkout session
 * (`checkout.session.completed`, called from `http.ts`'s webhook). IDEMPOTENT
 * via `settleRepayment`'s own `creditTransactionId` guard — safe under
 * Stripe's at-least-once, possibly OUT-OF-ORDER redelivery (a duplicate or
 * late-arriving event just re-finds every repayment already settled and
 * no-ops on each).
 *
 * AMOUNT RECONCILIATION: sums the repayments that are STILL outstanding at
 * webhook time (one settled by another rail — e.g. a manager's
 * `markRepaymentPaid` — in the gap between checkout creation and this webhook
 * is simply skipped, never double-settled) and compares against the session's
 * own `amountTotalCents`. A mismatch is NOT silently accepted: Stripe already
 * captured the money, so refusing to credit the payer would leave the org
 * holding funds against no debt — worse than a logged discrepancy. Every
 * still-outstanding repayment is settled anyway, each at ITS OWN stored
 * `amountCents` (never at a share of Stripe's total), and the mismatch is
 * logged loudly for manual review — mirroring `applyRepaymentPaid`'s own
 * double-collection guard.
 *
 * `feeCoverageCents` is the fee-coverage line the checkout added on top of the
 * debt (`prepareRepaymentCheckout`, 2026-08-14) and is SUBTRACTED before that
 * comparison. It has to be: Stripe's `amount_total` now includes it, so
 * comparing the raw total against the sum of debts would fire the
 * discrepancy alarm above on every single fee-covered payment — the loudest
 * possible false positive, on the exact path it exists to police. Absent on
 * sessions created before the fee line shipped, where it correctly reads 0.
 *
 * The coverage itself is NOT credited to the payer's debt: it is money that
 * passes straight through to Stripe, and crediting it would make the org's
 * books claim income it never received. The org's real Stripe fees are booked
 * from the fee ledger as they always were.
 */
export const applyRepaymentPaidFromStripe = internalMutation({
  args: {
    repaymentIds: v.array(v.id("personalRepayments")),
    sessionId: v.string(),
    paymentIntentId: v.optional(v.string()),
    amountTotalCents: v.number(),
    feeCoverageCents: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (
    ctx,
    { repaymentIds, sessionId, paymentIntentId, amountTotalCents, feeCoverageCents },
  ) => {
    const outstanding: Doc<"personalRepayments">[] = [];
    for (const id of repaymentIds) {
      const repayment = await ctx.db.get(id);
      if (!repayment) {
        console.error(
          `[cards] applyRepaymentPaidFromStripe: repayment ${id} not found ` +
            `(session ${sessionId}) — possibly un-flagged after the checkout was ` +
            `created; the Stripe payment needs MANUAL REVIEW.`,
        );
        continue;
      }
      if (repayment.status !== "paid" && !repayment.creditTransactionId) {
        outstanding.push(repayment);
      }
    }
    const expectedCents = outstanding.reduce((sum, r) => sum + r.amountCents, 0);
    // The fee-coverage line is Stripe's, not the payer's debt — see the doc.
    const debtPaidCents = amountTotalCents - (feeCoverageCents ?? 0);
    if (outstanding.length > 0 && expectedCents !== debtPaidCents) {
      console.error(
        `[cards] applyRepaymentPaidFromStripe: amount mismatch for session ${sessionId} — ` +
          `Stripe reports ${amountTotalCents}c paid (${feeCoverageCents ?? 0}c of it fee ` +
          `coverage, leaving ${debtPaidCents}c against the debt), still-outstanding ` +
          `repayments sum to ${expectedCents}c. Settling each at its OWN stored amount ` +
          `anyway; flag for manual review.`,
      );
    }
    for (const repayment of outstanding) {
      await settleRepayment(ctx, repayment, { stripePaymentIntentId: paymentIntentId });
    }
    await postRepaymentFeeCoverage(ctx, {
      sessionId,
      coverageCents: feeCoverageCents ?? 0,
      // The chapter that owned the debt. Where a bundled session spans books
      // this takes the first — see the helper's own note.
      repayments: outstanding,
    });
    // ONE schedule per call, covering every repayment THIS call settled —
    // see this file's "Payment receipt" section. A redelivered/duplicate
    // webhook for the same session re-derives `outstanding` as empty (every
    // row it lists is already `paid`), so a retry schedules nothing rather
    // than a second receipt. Scheduled AFTER the fee-coverage posting so the
    // books already carry that entry by the time the receipt naming the same
    // covered fee goes out.
    if (outstanding.length > 0) {
      await ctx.scheduler.runAfter(0, internal.cards.sendRepaymentReceiptEmail, {
        repaymentIds: outstanding.map((r) => r._id),
        feeCoveredCents: feeCoverageCents ?? 0,
      });
    }

    // ── BOOK THE OTHER HALF NOW, NOT TOMORROW MORNING ────────────────────────
    // The coverage above is income the instant this webhook lands; the fee it
    // offsets is booked by the Stripe sweep inside the morning engine, once a
    // day at 09:30 UTC. Between the two, book value runs HIGH by the coverage
    // — and that is not a theoretical window. A $101.74 repayment settled at
    // 15:32, its coverage was booked, and the accounts page read $3.35 off for
    // the rest of the day (founder: "lo and behold, there's $3.35 not accounted
    // for"). Every fee-covered repayment would do it again.
    //
    // So the sweep is asked to run now. It is the SAME sweep, reading Stripe's
    // own ledger — this schedules the ACTUAL, it does not derive one, and
    // `processorFees.ts`'s rule that a fee is never inferred from our own
    // arithmetic is untouched. Idempotent by construction (it re-reads the
    // whole ledger and replaces each month wholesale), so an extra run costs a
    // few pages of Stripe API and changes nothing else.
    //
    // ONLY WHEN THERE IS COVERAGE. A repayment billed at face value creates no
    // imbalance to close, and this must not become a Stripe round-trip on
    // every payment the org takes.
    //
    // Scheduled rather than awaited: a webhook's job is to answer 200, and if
    // the sweep fails — or Stripe has not published the balance transaction
    // yet — the morning engine still books it on its own schedule. This moves
    // the moment, never the mechanism.
    if ((feeCoverageCents ?? 0) > 0) {
      await ctx.scheduler.runAfter(0, internal.processorFees.syncStripeFeesOps, {
        execute: true,
      });
    }
    return null;
  },
});

/**
 * Book the fee the PAYER covered, as its own inflow row.
 *
 * WHY A ROW AT ALL — the bug this closes. The monthly processor-fee sweep
 * (`processorFees.ts`) books every cent Stripe took, the cut on a repayment
 * included, as an expense against book value. But `settleRepayment` posts a
 * credit for the DEBT, and the payer sent the debt PLUS the fee. So the
 * expense had nothing funding it: a $6.00 personal charge repaid as $6.49
 * moved Stripe's balance by $6.00 and the books by $6.00 − $0.49, leaving
 * exactly 49¢ of the org's own money reading as unexplained cash in
 * `reconciliationGap.ts` (founder, 2026-08-14: "the unaccounted for in our
 * banking was 49 cents"). The coverage is real money that really arrived and
 * it belongs in the books; this is where it goes.
 *
 * The identical bug on the GIVING side was fixed differently, and the
 * difference is not an inconsistency: a gift's coverage folds into the gift
 * because the donor genuinely gave the larger amount (`gifts.feeCoverageCents`).
 * A debt cannot be overpaid — the payer owes $6.00 and owes $6.00 after
 * covering — so the coverage cannot be credited to it without inventing debt
 * repayment that never happened. Beside it, not inside it.
 *
 * IDEMPOTENT ON THE SESSION, via `externalId`. Stripe redelivers, and a second
 * delivery finds every repayment already settled (so `outstanding` is empty)
 * but would otherwise still reach this — a duplicate coverage row would credit
 * the org money nobody sent.
 */
/** What the coverage row calls itself, everywhere it appears. */
export const FEE_COVERAGE_LABEL = "Processing fee covered by payer";

/** The category the processor's own fees are booked to (`processorFees.ts`) —
 *  the coverage joins them there so a book's fee line and the money that
 *  funded it are read together. */
const FEE_CATEGORY_NAME = "Bank & Fees";

export async function postRepaymentFeeCoverage(
  ctx: MutationCtx,
  args: {
    sessionId: string;
    coverageCents: number;
    repayments: Doc<"personalRepayments">[];
  },
): Promise<void> {
  if (args.coverageCents <= 0 || !Number.isInteger(args.coverageCents)) return;
  // No repayment settled on this delivery ⇒ either a redelivery (the row is
  // already there, and the guard below would catch it anyway) or a session
  // whose debts were paid by another rail. Either way there is nothing here
  // this row could belong to.
  const first = args.repayments[0];
  if (!first) return;

  const externalId = `stripe_repayment_fee_coverage:${args.sessionId}`;
  const existing = await ctx.db
    .query("transactions")
    .withIndex("by_external_id", (q) => q.eq("externalId", externalId))
    .first();
  if (existing) return;

  // A bundled session can in principle span books (one payer, cards on two
  // chapters). The coverage is ONE payment and is booked whole to the first
  // debt's book rather than split — splitting invents a rounding rule for a
  // case that has never occurred, and a note nobody can follow is worse than a
  // few cents on the wrong book. Logged so it stops being invisible if it does.
  const books = new Set(args.repayments.map((r) => String(r.chapterId)));
  if (books.size > 1) {
    console.warn(
      `[cards] repayment session ${args.sessionId} spans ${books.size} books; ` +
        `booking its ${args.coverageCents}c of fee coverage entirely to ${first.chapterId}.`,
    );
  }

  // ── IT HAS TO SAY WHAT IT IS ──────────────────────────────────────────────
  // A machine-posted row with no merchant, no category and no budget lands in
  // Reconcile as "Unlabeled charge / Uncategorized / For: None" — the exact
  // shape `lib/reimbursementTxnFields.ts` and `lib/increasePayoutMachine.ts`
  // were both written to stop, and the founder found these two rows reading it
  // ("will it always read unlabeled charge?"). A 49¢ row nobody can identify is
  // worse than no row: it reads as a mystery on a page whose whole job is that
  // nothing is a mystery.
  //
  // `merchantName` rather than `description`, deliberately — the two grids
  // disagree about precedence (`displayMerchantName` prefers merchantName; the
  // mobile list prefers description), so setting ONE of them is what makes the
  // label identical everywhere instead of subtly different per screen.
  //
  // The CATEGORY is the same one the fee it offsets is booked to, so the cost
  // and the money that covered it land together rather than the funding
  // appearing as uncategorised income beside a categorised expense. Looked up
  // by name on the row's own book and simply left unset if that book has no
  // such category — a missing category must not cost the row.
  const feeCategory = (
    await ctx.db
      .query("budgetCategories")
      .withIndex("by_chapter", (q) => q.eq("chapterId", first.chapterId))
      .collect()
  ).find((c) => c.name === FEE_CATEGORY_NAME);

  const now = Date.now();
  await ctx.db.insert("transactions", {
    chapterId: first.chapterId,
    merchantName: FEE_COVERAGE_LABEL,
    ...(feeCategory ? { categoryId: feeCategory._id } : {}),
    source: "repayment",
    // INFLOW, not `transfer`. The repayment credit beside it is a transfer —
    // it moves a receivable back into cash and nets the charge. This is not
    // that: nobody owed it, it arrived from outside the org, and it has to
    // carry positive signed value or it cannot offset the fee expense it
    // exists to offset (`lib/bookBalance.ts`).
    flow: "inflow",
    amountCents: args.coverageCents,
    currency: "usd",
    postedAt: now,
    personId: first.payerPersonId,
    feeCoverageOrigin: "repayment",
    externalId,
    // Nothing left to reconcile: the amount came from the settled session and
    // the row explains itself (`autoExplanationLine("fee_coverage")`). Left
    // open it would sit in the coding queue and the receipt chase forever as a
    // 49¢ chore nobody can action — the same reasoning the zeroed fee rows in
    // `processorFees.ts` are closed under.
    status: "reconciled",
    note:
      `Processing fee covered by the payer on their personal-charge repayment ` +
      `(Stripe session ${args.sessionId}). Offsets the processor fee on the same ` +
      `payment, which the monthly fee sweep books as an expense.`,
    createdAt: now,
  });
}

/**
 * Initiate a personal-charge repayment via the payer's chosen method. The payer
 * pays the org back; on success the offsetting `flow:"transfer"` credit is
 * posted. DEGRADES to a `pending` repayment (never throws) when `INCREASE_API_KEY`
 * is unset / the payer's funding source isn't linked — a manager then confirms
 * receipt via `markRepaymentPaid`. IDEMPOTENT: never posts a double credit.
 */
export const initiateRepayment = action({
  args: {
    repaymentId: v.id("personalRepayments"),
    method: repaymentMethodValidator,
  },
  returns: repaymentSummaryValidator,
  handler: async (ctx, args): Promise<RepaymentSummary> => {
    const prep: BeginRepaymentResult = await ctx.runMutation(
      internal.cards.beginRepayment,
      args,
    );
    if (prep.kind === "paid") return prep.repayment;
    if (
      !prep.canCharge ||
      !prep.payerExternalAccountId ||
      !prep.increaseAccountId
    ) {
      return prep.repayment; // degrade: leave pending (no funding source linked)
    }

    // Self-select the Increase env from the chapter account's id prefix (sandbox
    // account → sandbox creds, prod account → prod). Env not wired for that
    // environment → degrade (leave pending; recoverable via markRepaymentPaid).
    const { key, base } = increaseEnvForObjectId(prep.increaseAccountId);
    if (!key) return prep.repayment;
    // Defense in depth: never originate a $0 / non-integer ACH debit pull.
    assertPositiveRepayment(prep.amountCents);
    try {
      const charge = await increasePost(
        key,
        base,
        "/ach_transfers",
        {
          account_id: prep.increaseAccountId,
          // The payer's linked external account is the counterparty; a NEGATIVE
          // amount originates a DEBIT that PULLS the repayment into the chapter's
          // account.
          external_account_id: prep.payerExternalAccountId,
          amount: -prep.amountCents,
          // Increase requires a statement descriptor, max 10 characters.
          statement_descriptor: "Repayment",
        },
        // Idempotency-Key = repaymentId (mirrors `payReimbursement`'s
        // reimbursementId key): a retry after a network blip whose first charge
        // actually landed must get THAT transfer back, never debit the payer a
        // second time.
        String(args.repaymentId),
      );
      return await ctx.runMutation(internal.cards.applyRepaymentPaid, {
        repaymentId: args.repaymentId,
        increaseRef: String(charge.id),
      });
    } catch (err) {
      console.error("[cards] initiateRepayment charge failed:", err);
      return prep.repayment; // leave pending — recoverable via markRepaymentPaid
    }
  },
});

// ── autoLockOverdueCards (INTERNAL — the 7-day receipt auto-lock cron) ────────

/**
 * A card charge still MISSING its receipt: an outflow with no attached receipt,
 * not intentionally excluded/reconciled, belonging to the card's chapter.
 * Exported so the chapter dashboard's "cards nearing auto-lock" queue reuses the
 * exact same predicate as this auto-lock sweep — only the grace-window
 * comparison differs (nearing = still within grace, overdue = past it).
 *
 * A PERSONAL charge (`isPersonal` — flagged or auto-converted to a personal
 * repayment) is EXCLUDED: it's no longer an org expense awaiting a receipt but
 * money the cardholder owes back, so it must not keep a card auto-locked or
 * surface as "missing receipt" anywhere. This is the single predicate the
 * lock/unlock/nearing paths all read, so excluding it here removes converted
 * charges from every one of them at once.
 */
export function isMissingReceiptCharge(
  tr: Doc<"transactions">,
  card: Doc<"cards">,
): boolean {
  return (
    tr.chapterId === card.chapterId &&
    tr.flow === "outflow" &&
    tr.status !== "excluded" &&
    tr.status !== "reconciled" &&
    tr.isPersonal !== true &&
    !tr.receiptStorageId &&
    // THE ESCAPE VALVE (receipt-exceptions PR). An approved exception stops
    // BOTH clocks this predicate drives: the day-7 card auto-lock and the
    // no-receipt→personal-charge auto-convert. Without it, turning on
    // `noReceiptAutoConvertDays` would make the first cash tip at a venue
    // somebody's personal debt — punishing a cardholder for a vendor's
    // behavior rather than their own, which is not the policy anyone wants.
    //
    // It can't be self-served: approving an exception is manager-gated, and at
    // or above the org threshold the approver must be a different person than
    // the filer (`receiptExceptions.approve`). A PENDING exception
    // deliberately does not stop either clock — see
    // `docs/plans/receipt-exceptions.md`.
    tr.approvedReceiptExceptionId == null
  );
}

/** A card charge whose receipt is overdue: a missing-receipt charge older than
 *  the grace window (the cutoff). Exported so `attachReceipt` (finances.ts)
 *  can re-run this same predicate to unlock a card immediately on upload,
 *  instead of waiting for the next `autoLockOverdueCards` sweep. */
export function isOverdueReceiptCharge(
  tr: Doc<"transactions">,
  card: Doc<"cards">,
  cutoff: number,
): boolean {
  return isMissingReceiptCharge(tr, card) && tr.postedAt < cutoff;
}

/**
 * Whether a `status:"locked"` row on this card would actually STOP A SWIPE.
 *
 * A lock in this app is not a property of the card row — it is a decision
 * `decideCardAuthorization` makes when Increase asks us, in real time, whether
 * to approve an authorization. Increase finds the row by `increaseCardId`
 * (`by_increase_card`), so the whole mechanism only reaches cards Increase
 * issued.
 *
 * A `source:"legacy"` card is a Relay card linked to this chapter by its
 * last-4 (`legacyCards.linkRelayCard`). It has no Increase object and no
 * controls — nobody asks us anything before it authorizes. Patching such a row
 * to `"locked"` therefore changes nothing except what the app CLAIMS: the
 * cardholder is told they're locked out, the manager is told the receipt rule
 * was enforced, and the card keeps working. A control that reports enforcement
 * it cannot deliver is worse than an absent one, so every lock path checks
 * this first and legacy cards are simply left alone — their overdue charges
 * still escalate, via the reminders and the 60-day accountable-plan conversion
 * in `autoConvertOverdueReceipts`, both of which act on the CHARGE and need no
 * cooperation from the issuer.
 *
 * The mirror of `ManagerCardsView`/`MyCardSection`'s `source !== "legacy"`
 * filters, which have always hidden the controls UI for these rows — this is
 * the same rule, finally applied on the server too.
 */
export function canEnforceCardLock(card: Doc<"cards">): boolean {
  return card.source !== "legacy";
}

/**
 * Re-run the receipt lock-eligibility check for ONE card and unlock it right
 * away if no overdue missing-receipt charge remains — called synchronously by
 * `attachReceipt` (finances.ts) immediately after a receipt attaches, so the
 * cardholder doesn't wait for the next daily `autoLockOverdueCards` sweep.
 *
 * Only acts on an AUTO-locked card (`status:"locked"` WITH a
 * `receiptGraceEndsAt` stamp) — a MANUAL lock (`lockCard`, no stamp) is left
 * untouched, exactly matching the cron's own unlock condition. Returns
 * whether it unlocked the card.
 */
export async function unlockCardIfReceiptsResolved(
  ctx: MutationCtx,
  cardId: Id<"cards">,
): Promise<boolean> {
  const card = await ctx.db.get(cardId);
  if (!card || card.status !== "locked" || card.receiptGraceEndsAt == null) {
    return false;
  }
  const cutoff = Date.now() - RECEIPT_GRACE_DAYS * DAY_MS;
  const txns = await ctx.db
    .query("transactions")
    .withIndex("by_card", (q) => q.eq("cardId", cardId))
    .order("desc")
    .take(CARD_TXN_LIMIT);
  const stillOverdue = txns.some((tr) =>
    isOverdueReceiptCharge(tr, card, cutoff),
  );
  if (stillOverdue) return false;
  await ctx.db.patch(cardId, { status: "active", receiptGraceEndsAt: undefined });
  return true;
}

/**
 * The deployment-wide 7-day receipt auto-lock sweep the cron calls. Derives
 * overdue-ness ITSELF from each card's charges (no field elsewhere writes
 * `receiptGraceEndsAt`, so it can't be read as the source of truth):
 *
 *  - an ACTIVE card with a charge older than `RECEIPT_GRACE_DAYS` days that
 *    still has NO receipt → LOCK it + stamp `receiptGraceEndsAt` (for display);
 *  - a previously AUTO-locked card (locked WITH a `receiptGraceEndsAt` stamp)
 *    whose overdue missing-receipt charges are all resolved → UNLOCK it + clear
 *    the stamp. This is the BACKSTOP self-heal (in case the immediate path
 *    below was missed) — `attachReceipt` (finances.ts) calls
 *    `unlockCardIfReceiptsResolved` synchronously on upload, so a card usually
 *    unlocks immediately rather than waiting for this daily sweep.
 *
 * A MANUAL lock (`lockCard`, no `receiptGraceEndsAt`) is never auto-unlocked.
 * Bounded; returns how many cards it locked / unlocked.
 */
export const autoLockOverdueCards = internalMutation({
  args: {},
  returns: v.object({ lockedCount: v.number(), unlockedCount: v.number() }),
  handler: async (
    ctx,
  ): Promise<{ lockedCount: number; unlockedCount: number }> => {
    const now = Date.now();
    const cutoff = now - RECEIPT_GRACE_DAYS * DAY_MS;
    const cards = await ctx.db.query("cards").take(AUTOLOCK_LIMIT);
    let lockedCount = 0;
    let unlockedCount = 0;
    for (const card of cards) {
      if (card.status === "canceled") continue;
      // A legacy (Relay) card cannot be locked at all — see
      // `canEnforceCardLock`. Skipping it here is what keeps the app from
      // reporting an enforcement it can't perform; the charge-level
      // escalations still run.
      if (!canEnforceCardLock(card)) continue;
      // A manual lock (no grace stamp) is left untouched.
      const isAutoLocked =
        card.status === "locked" && card.receiptGraceEndsAt != null;
      if (card.status !== "active" && !isAutoLocked) continue;

      const txns = await ctx.db
        .query("transactions")
        .withIndex("by_card", (q) => q.eq("cardId", card._id))
        .order("desc")
        .take(CARD_TXN_LIMIT);
      const overdue = txns.filter((tr) =>
        isOverdueReceiptCharge(tr, card, cutoff),
      );

      if (card.status === "active" && overdue.length > 0) {
        const earliest = Math.min(...overdue.map((tr) => tr.postedAt));
        await ctx.db.patch(card._id, {
          status: "locked",
          receiptGraceEndsAt: earliest + RECEIPT_GRACE_DAYS * DAY_MS,
        });
        lockedCount++;
      } else if (isAutoLocked && overdue.length === 0) {
        await ctx.db.patch(card._id, {
          status: "active",
          receiptGraceEndsAt: undefined,
        });
        unlockedCount++;
      }
    }
    return { lockedCount, unlockedCount };
  },
});

// ── autoConvertOverdueReceipts (unsubstantiated → personal repayment) ────────

/**
 * The org-wide auto-conversion sweep the daily cron calls — the TERMINAL step
 * past the day-1/day-3 reminders and the day-7 auto-lock. TWO clocks run here,
 * both ending the same way (the charge becomes money the cardholder owes back)
 * and both reusing the shared `convertChargeToPersonalRepayment`, so the
 * flag/pay-back machinery is identical to a manual flag:
 *
 *  1. NO RECEIPT — `financeSettings.noReceiptAutoConvertDays` (via
 *     `readNoReceiptAutoConvertDays`). `null` (the default — central finance
 *     never picked a number) turns this clock OFF. Eligibility is
 *     `isOverdueReceiptCharge`, the auto-lock sweep's own predicate.
 *  2. NOT CODED — the 60-day ACCOUNTABLE-PLAN clock (`codingOverdueDays`,
 *     default `DEFAULT_CODING_OVERDUE_DAYS`), running on any charge the coding
 *     policy covers that is still `isUncodedCharge` that long after posting.
 *     This one has no "off" value, exactly like the policy dates themselves: it
 *     is the IRS's safe harbor, not a preference. Treas. Reg. §1.62-2 is blunt
 *     — spending the org can't substantiate in a reasonable period is WAGES to
 *     the person who spent it. Billing it back is the kinder ending, and the
 *     escalation email says so in plain words.
 *
 *     TWO GATES, NOT ONE. Converting also requires `postedAt >=
 *     codingConversionSinceMs` — the CONSEQUENCE date, deliberately later than
 *     the REQUIREMENT date the rest of the coding surfaces read. A charge can
 *     owe a coding (chased, facet-counted, blocked from `reconciled`) for
 *     months without ever being billable, and that asymmetry is the point:
 *     asking for an account of the money is fair immediately, billing someone
 *     for spending that predates the ask is not. See
 *     `DEFAULT_CODING_CONVERSION_SINCE_MS`. Under the defaults the earliest a
 *     charge can convert on this clock is 2026-10-31 (2026-09-01 + 60 days).
 *
 * A charge overdue on BOTH is reported as the receipt case: that clock is
 * usually the shorter one and it's the one the cardholder has already been
 * warned about twice.
 *
 * Age basis is `postedAt` for both. Already-personal charges are excluded by
 * both predicates, so a converted charge is never re-swept and, critically, no
 * longer keeps its card auto-locked. Bounded + idempotent like the reminder
 * sweep: at most `REMINDER_BATCH_LIMIT` conversions per run, globally
 * oldest-first, so a backlog drains gradually instead of converting (and
 * emailing) everyone in one burst. Each first-time conversion best-effort
 * emails the cardholder (scheduled, degrades without a Resend key).
 */
export const autoConvertOverdueReceipts = internalMutation({
  args: {},
  returns: v.object({ convertedCount: v.number() }),
  handler: async (ctx): Promise<{ convertedCount: number }> => {
    const now = Date.now();
    const days = await readNoReceiptAutoConvertDays(ctx);
    // `null` = the no-receipt clock is OFF (the default). The coding clock
    // below still runs — it's the accountable-plan deadline, not a setting.
    const receiptCutoff = days == null ? null : now - days * DAY_MS;
    const { sinceMs, conversionSinceMs } = await codingPolicy(ctx);
    const codingCutoff = now - (await codingOverdueMs(ctx));
    const cards = await ctx.db.query("cards").take(AUTOLOCK_LIMIT);

    // Gather every eligible charge across ALL cards first, so the batch cap
    // below picks the globally oldest — mirrors `advanceReceiptReminders`.
    const candidates: {
      tr: Doc<"transactions">;
      card: Doc<"cards">;
      cause: "no_receipt" | "uncoded";
    }[] = [];
    for (const card of cards) {
      if (card.status === "canceled") continue;
      const txns = await ctx.db
        .query("transactions")
        .withIndex("by_card", (q) => q.eq("cardId", card._id))
        .order("desc")
        .take(CARD_TXN_LIMIT);
      for (const tr of txns) {
        if (
          receiptCutoff != null &&
          isOverdueReceiptCharge(tr, card, receiptCutoff)
        ) {
          candidates.push({ tr, card, cause: "no_receipt" });
        } else if (
          tr.chapterId === card.chapterId &&
          tr.postedAt < codingCutoff &&
          // BOTH coding gates, tested independently. `isUncodedCharge(tr,
          // sinceMs)` asks whether this charge OWES a coding; the line below
          // asks whether it is old enough in POLICY terms to be billed back for
          // not having one. They were one constant, which meant arming the
          // requirement also armed the billing — see
          // `DEFAULT_CODING_CONVERSION_SINCE_MS`. Do not collapse them again:
          // a charge that owes a coding but posted before the conversion date
          // stays chased forever and converted never, which is the intent.
          tr.postedAt >= conversionSinceMs &&
          isUncodedCharge(tr, sinceMs)
        ) {
          candidates.push({ tr, card, cause: "uncoded" });
        }
      }
    }
    candidates.sort((a, b) => a.tr.postedAt - b.tr.postedAt);
    const batch = candidates.slice(0, REMINDER_BATCH_LIMIT);

    let convertedCount = 0;
    for (const { tr, card, cause } of batch) {
      const { repayment, created } = await convertChargeToPersonalRepayment(
        ctx,
        tr,
        card.cardholderPersonId,
      );
      // Idempotent: a charge already converted (created:false) isn't recounted
      // or re-emailed on a later run.
      if (!created) continue;
      convertedCount++;
      await ctx.scheduler.runAfter(0, internal.cards.notifyPersonalChargeFlagged, {
        repaymentId: repayment._id,
        auto: true,
        cause,
      });
    }
    return { convertedCount };
  },
});

// ── advanceReceiptReminders (day-1 flag / day-3 escalate) ────────────────────

/**
 * Advances the reminder TIMELINE for every card charge that still OWES its
 * cardholder something — the steps ahead of the terminal day-7 auto-lock
 * above:
 *
 *  - a charge that's crossed one full day still owing, with no stage yet →
 *    `receiptReminderStage: "flagged"` (the "end of purchase day" nudge);
 *  - a charge that's crossed `RECEIPT_ESCALATE_DAYS` (3) still owing, not yet
 *    escalated → `receiptReminderStage: "escalated"`.
 *
 * "OWES" is `chargeOutstanding` (`lib/codingReminders.ts`), not "has no
 * receipt": since the chase rekeyed onto CODINGS (owner decision, 2026-08-08)
 * a charge with a perfect receipt and no business purpose is exactly as
 * overdue as one with neither, and a charge a reviewer sent back is overdue
 * again from the author's side. The field keeps its `receiptReminderStage`
 * name — it is the same timeline, and renaming a stamped column mid-flight
 * would strand every row already on it.
 *
 * Purely a state transition (mirrors `autoLockOverdueCards`'s DB-apply shape,
 * kept a `mutation` so it's directly testable); it does NOT lock anything and
 * does NOT send email itself — it returns the transactions that just
 * transitioned THIS pass so the caller (`sendReceiptReminders`, an action) can
 * notify their cardholder. Idempotent: a charge already at a stage is never
 * re-returned until it advances to the next one, so a cardholder isn't
 * re-emailed on every daily sweep.
 *
 * Capped at `REMINDER_BATCH_LIMIT` transitions per run, oldest charge first
 * (across ALL cards, not per-card) — see the constant's comment. Charges
 * older than `REMINDER_SEED_ONLY_DAYS` still get their stage set (within that
 * cap) but are never included in the returned `flagged`/`escalated` arrays,
 * so `sendReceiptReminders` never emails for them. Personal charges
 * (`isPersonal`) are skipped by `chargeOutstanding` itself — the cardholder
 * already flagged + is repaying it, so a nag on top is redundant.
 */
export const advanceReceiptReminders = internalMutation({
  args: {},
  returns: v.object({
    flagged: v.array(v.id("transactions")),
    escalated: v.array(v.id("transactions")),
  }),
  handler: async (
    ctx,
  ): Promise<{
    flagged: Id<"transactions">[];
    escalated: Id<"transactions">[];
  }> => {
    const now = Date.now();
    const seedOnlyCutoff = now - REMINDER_SEED_ONLY_DAYS * DAY_MS;
    const { sinceMs } = await codingPolicy(ctx);
    const cards = await ctx.db.query("cards").take(AUTOLOCK_LIMIT);

    // Gather every charge due to advance a stage THIS pass, across ALL cards,
    // before writing anything — so the batch cap below can pick the globally
    // oldest charges first rather than just the oldest per card.
    const candidates: {
      tr: Doc<"transactions">;
      stage: "flagged" | "escalated";
    }[] = [];
    for (const card of cards) {
      if (card.status === "canceled") continue;
      const txns = await ctx.db
        .query("transactions")
        .withIndex("by_card", (q) => q.eq("cardId", card._id))
        .order("desc")
        .take(CARD_TXN_LIMIT);
      for (const tr of txns) {
        // Defensive: `by_card` can only return this card's rows, but every
        // other sweep in this file re-checks the chapter, so this one does too.
        if (tr.chapterId !== card.chapterId) continue;
        if (chargeOutstanding(tr, sinceMs) == null) continue;
        // `stageForAge` is THE shared day-threshold arithmetic — also read
        // by `unflagPersonalCharge` to re-stamp a stage without emailing.
        // Only ever candidate a FORWARD transition: escalated is skipped if
        // already escalated, flagged only fires from a blank stage (a
        // charge already at "flagged" waits for the next age threshold, not
        // a re-transition into the same stage).
        const implied = stageForAge(tr.postedAt, now);
        if (implied === "escalated" && tr.receiptReminderStage !== "escalated") {
          candidates.push({ tr, stage: "escalated" });
        } else if (implied === "flagged" && tr.receiptReminderStage == null) {
          candidates.push({ tr, stage: "flagged" });
        }
      }
    }

    // Oldest posted-at first, capped — a historical backlog (e.g. months of
    // un-receipted charges present the day this feature deploys) drains
    // REMINDER_BATCH_LIMIT charges per run instead of transitioning (and
    // emailing) everyone in one burst.
    candidates.sort((a, b) => a.tr.postedAt - b.tr.postedAt);
    const batch = candidates.slice(0, REMINDER_BATCH_LIMIT);

    const flagged: Id<"transactions">[] = [];
    const escalated: Id<"transactions">[] = [];
    for (const { tr, stage } of batch) {
      // Ancient charges predate the reminder feature entirely — set the
      // stage so the grid reflects reality, but skip the email (and the
      // `lastReminderSentAt` stamp, since none was sent) so a 3-month-old
      // charge doesn't surface as a fresh nag.
      const seedOnly = tr.postedAt < seedOnlyCutoff;
      await ctx.db.patch(tr._id, {
        receiptReminderStage: stage,
        ...(seedOnly ? {} : { lastReminderSentAt: now }),
      });
      if (seedOnly) continue;
      if (stage === "escalated") escalated.push(tr._id);
      else flagged.push(tr._id);
    }
    return { flagged, escalated };
  },
});

/**
 * Group the charges that transitioned a reminder stage THIS pass by cardholder,
 * so `sendReceiptReminders` sends ONE digest email per person listing
 * everything they still owe — never one email per charge (a cardholder with
 * five open charges was getting five separate emails). A cardholder with no
 * reachable email is dropped. `flagged`/`escalated` are disjoint per pass; a
 * charge is tagged `escalated` when it hit the day-3 step.
 *
 * Each line carries its OWN debt (`chargeOutstanding`), because since the
 * chase rekeyed onto codings the answer differs per row: one charge needs a
 * receipt, the next needs its purpose written, the next was sent back by a
 * reviewer. A row that settled between the sweep and this read is dropped
 * rather than nagged about.
 */
export const getReceiptReminderDigests = internalQuery({
  args: {
    flagged: v.array(v.id("transactions")),
    escalated: v.array(v.id("transactions")),
  },
  returns: v.array(
    v.object({
      email: v.string(),
      cardholderName: v.string(),
      anyEscalated: v.boolean(),
      charges: v.array(reminderChargeValidator),
    }),
  ),
  handler: async (ctx, args) => {
    const { sinceMs } = await codingPolicy(ctx);
    const escalatedSet = new Set(args.escalated.map((id) => id as string));
    const seen = new Set<string>();
    const byPerson = new Map<
      string,
      {
        email: string;
        cardholderName: string;
        charges: Array<Infer<typeof reminderChargeValidator>>;
      }
    >();
    for (const txnId of [...args.flagged, ...args.escalated]) {
      if (seen.has(txnId as string)) continue;
      seen.add(txnId as string);
      const tr = await ctx.db.get(txnId);
      if (!tr?.cardId) continue;
      const outstanding = chargeOutstanding(tr, sinceMs);
      if (!outstanding) continue;
      const card = await ctx.db.get(tr.cardId);
      if (!card) continue;
      const person = await ctx.db.get(card.cardholderPersonId);
      const email = person?.pwEmail ?? person?.email;
      if (!person || !email) continue;
      const key = card.cardholderPersonId as string;
      const entry =
        byPerson.get(key) ?? { email, cardholderName: person.name, charges: [] };
      entry.charges.push({
        amountCents: tr.amountCents,
        merchantName: tr.merchantName ?? null,
        escalated: escalatedSet.has(txnId as string),
        outstanding,
        missingReceipt: !isDocumented(tr),
        needsCoding: isUncodedCharge(tr, sinceMs),
      });
      byPerson.set(key, entry);
    }
    return [...byPerson.values()].map((e) => ({
      ...e,
      anyEscalated: e.charges.some((c) => c.escalated),
    }));
  },
});

/**
 * Best-effort digest email for ONE cardholder listing everything still open on
 * their charges — logs + no-ops without `RESEND_API_KEY` (dev).
 *
 * ONE EMAIL, ONE UNIT: "you have N charges to code" (owner decision,
 * 2026-08-08). A charge needing a receipt, a charge needing its purpose
 * written, and a charge a reviewer sent back are all the same debt to the
 * cardholder — the person who spent the money still owes an account of it —
 * so they share one message with a per-line label
 * (`lib/codingReminders.ts#outstandingLabel`) saying exactly what each one
 * needs. Splitting them back into separate streams is what produced five
 * emails a day and taught people to filter the sender.
 */
async function notifyReceiptDigest(
  ctx: ActionCtx,
  digest: {
    email: string;
    cardholderName: string;
    anyEscalated: boolean;
    charges: Array<Infer<typeof reminderChargeValidator>>;
  },
): Promise<void> {
  const count = digest.charges.length;
  if (count === 0) return;
  const fmt = (c: { amountCents: number; merchantName: string | null }) =>
    `$${(c.amountCents / 100).toFixed(2)} at ${c.merchantName ?? "a charge"}`;
  const headline = count === 1 ? "1 charge to code" : `${count} charges to code`;
  const subject =
    count === 1
      ? `${digest.anyEscalated ? "Still open: " : ""}code your ${fmt(digest.charges[0])} charge`
      : `${digest.anyEscalated ? "Still open: " : ""}${count} charges to code`;
  const daysLeft = RECEIPT_GRACE_DAYS - RECEIPT_ESCALATE_DAYS;
  const intro =
    count === 1
      ? `your ${escapeHtml(fmt(digest.charges[0]))} charge ${escapeHtml(digest.charges[0].outstanding)}.`
      : `you have ${count} card charges waiting on you:`;
  const list =
    count === 1
      ? ""
      : emailList(
          digest.charges.map(
            (c) =>
              `${escapeHtml(fmt(c))} — ${escapeHtml(c.outstanding)}${c.escalated && c.missingReceipt ? " (<b>locks soon</b>)" : ""}`,
          ),
        );
  // WHY it matters, in plain words — the sentence the whole enforcement story
  // rests on (docs/plans/transaction-coding.md §D). Printed only when a coding
  // is genuinely part of what's missing; a digest that's purely "upload the
  // receipt" gets the lock warning below and nothing about taxable income,
  // because a rule quoted where it doesn't apply stops being read.
  const anyNeedsCoding = digest.charges.some((c) => c.needsCoding);
  // (No day count here on purpose: `codingOverdueDays` is an org setting, and
  // an email that hard-codes "60 days" is one settings change away from
  // lying.)
  const whyNote = anyNeedsCoding
    ? emailParagraph(
        `Coding a charge means saying what it was, why it served the org's work, and who was there. Under IRS rules, spending we can't substantiate in time counts as taxable income to the person who spent it — so a charge left uncoded eventually gets billed back to you instead.`,
      )
    : "";
  // The day-7 auto-lock acts on the RECEIPT alone — never warn about it for a
  // charge whose only debt is its coding.
  const anyLockable = digest.charges.some((c) => c.escalated && c.missingReceipt);
  const lockNote = anyLockable
    ? emailParagraph(
        `Add the receipt${count === 1 ? "" : "s"} soon — a charge still missing its receipt after ${RECEIPT_GRACE_DAYS} days locks your card (${daysLeft} more day${daysLeft === 1 ? "" : "s"} for the escalated one${count === 1 ? "" : "s"}).`,
      )
    : "";
  // The cardholder's OWN list, pre-filtered to what they owe — where the
  // coding sheet (purpose, people, receipt) lives. Null (omitted) when APP_URL
  // is unset.
  const link = appUrl("/code?filter=uncoded");
  await sendEmail(ctx, {
    to: digest.email,
    subject,
    html: emailShell(`
      ${emailHeading(headline)}
      ${emailParagraph(`Hi ${escapeHtml(digest.cardholderName)} — ${intro}`, {
        margin: `0 0 ${count === 1 ? 16 : 8}px`,
      })}
      ${list}
      ${whyNote}
      ${lockNote}
      ${link ? emailButtonRow(link, `Code ${count === 1 ? "it" : "them"} →`) : ""}`),
  });
}

/**
 * The daily receipt-reminder cron: advances every card's missing-receipt
 * charges through the day-1/day-3 timeline (`advanceReceiptReminders`), then
 * sends each cardholder ONE digest email listing all of their charges that
 * transitioned this pass — not one email per charge (a cardholder with several
 * un-receipted charges used to get one email each). Terminal day-7 locking
 * stays in `autoLockOverdueCards` — this action never locks a card. No-ops per
 * email when `RESEND_API_KEY` is unset (local/dev).
 *
 * Best-effort per email: a single rejected digest (e.g. a Resend fetch failure)
 * is logged and does NOT stop the loop, so one bad email can't drop every
 * remaining cardholder's reminder for the day.
 */
export const sendReceiptReminders = internalAction({
  args: {},
  returns: v.object({ flaggedCount: v.number(), escalatedCount: v.number() }),
  handler: async (
    ctx,
  ): Promise<{ flaggedCount: number; escalatedCount: number }> => {
    const { flagged, escalated } = await ctx.runMutation(
      internal.cards.advanceReceiptReminders,
      {},
    );
    const digests = await ctx.runQuery(internal.cards.getReceiptReminderDigests, {
      flagged,
      escalated,
    });
    for (const digest of digests) {
      try {
        await notifyReceiptDigest(ctx, digest);
      } catch (err) {
        console.error(
          "sendReceiptReminders: digest email failed",
          digest.email,
          err,
        );
      }
    }
    return { flaggedCount: flagged.length, escalatedCount: escalated.length };
  },
});

// ── The OTHER half of the loop: telling a REVIEWER something is waiting ──────
//
// Everything above chases the cardholder. Nothing, until now, chased the
// reviewer: `notifyCodingSentBack` emails the author when a coding comes back,
// and that was the entire notification surface. A submitted coding sat in a
// queue nobody was told about, which is exactly what happened — six of them,
// submitted and never once looked at, with zero approvals in `financeAuditLog`
// since the feature shipped.
//
// Built to the same shape as the receipt digest above (advance-and-mark →
// group by recipient → one email each), and to the same safety rules, because
// the failure mode here is worse: the receipt digest mails ONE cardholder
// about their own charges, while this one mails a small group about everybody
// else's. Three guards, all of them load-bearing:
//
//   1. BATCHED. One email per reviewer per run listing every coding waiting on
//      them — never one per submission.
//   2. CAPPED at `REMINDER_BATCH_LIMIT` codings per run, oldest-submitted
//      first, exactly like `advanceReceiptReminders`.
//   3. SEED-ONLY on first touch. A coding that has been waiting longer than
//      `REMINDER_SEED_ONLY_DAYS` when this feature first sees it gets its
//      `reviewerRemindedAt` stamped SILENTLY — arming this must not mail
//      anybody about months of history. After that first touch it behaves
//      normally, so a genuinely stale queue is still chased; what's suppressed
//      is the one-time backlog, not the follow-up.

/** Wait this long after submission before the first nudge. A coding submitted
 *  an hour ago isn't late, and a reviewer who gets mail the moment anyone
 *  submits learns to ignore the mail. Mirrors the receipt sweep's day-1
 *  `flagCutoff`. */
const CODING_REVIEW_GRACE_DAYS = 1;
/** And no more often than this once nudged. A queue somebody is deliberately
 *  leaving alone shouldn't generate a daily email. */
const CODING_REVIEW_RENUDGE_DAYS = 7;

/**
 * Select the codings whose reviewers should be nudged this pass and stamp
 * them, returning only what was actually stamped-and-mailable.
 *
 * The stamp happens in the same transaction as the selection, so a crash
 * between here and the send costs at most one nudge rather than repeating it
 * every morning — the `receiptReplyBatches` claim-before-send posture, applied
 * to a field instead of a table.
 */
export const advanceCodingReviewReminders = internalMutation({
  args: {},
  returns: v.array(v.id("transactionCodings")),
  handler: async (ctx): Promise<Id<"transactionCodings">[]> => {
    const now = Date.now();
    const graceCutoff = now - CODING_REVIEW_GRACE_DAYS * DAY_MS;
    const renudgeCutoff = now - CODING_REVIEW_RENUDGE_DAYS * DAY_MS;
    const seedOnlyCutoff = now - REMINDER_SEED_ONLY_DAYS * DAY_MS;

    const books: FinanceScope[] = [
      CENTRAL,
      ...(await listActiveChapters(ctx, AUTOLOCK_LIMIT)).map((c) => c._id),
    ];
    const candidates: Doc<"transactionCodings">[] = [];
    for (const book of books) {
      const rows = await ctx.db
        .query("transactionCodings")
        .withIndex("by_chapter_and_status", (q) =>
          q.eq("chapterId", book).eq("status", "submitted"),
        )
        .take(AUTOLOCK_LIMIT);
      for (const row of rows) {
        if (row.submittedAt > graceCutoff) continue;
        if (row.reviewerRemindedAt != null && row.reviewerRemindedAt > renudgeCutoff) {
          continue;
        }
        candidates.push(row);
      }
    }

    // Oldest submission first — the ones the accountable-plan clock has been
    // running longest against are the ones worth a reviewer's attention.
    candidates.sort((a, b) => a.submittedAt - b.submittedAt);
    const batch = candidates.slice(0, REMINDER_BATCH_LIMIT);

    const mailable: Id<"transactionCodings">[] = [];
    for (const row of batch) {
      // FIRST TOUCH on a coding older than the horizon: stamp it so it joins
      // the normal cadence from here, but don't mail about it. This is what
      // makes arming the feature safe on a backlog.
      const seedOnly =
        row.reviewerRemindedAt == null && row.submittedAt < seedOnlyCutoff;
      await ctx.db.patch(row._id, { reviewerRemindedAt: now });
      if (!seedOnly) mailable.push(row._id);
    }
    return mailable;
  },
});

const reviewDigestItemValidator = v.object({
  amountCents: v.number(),
  merchantName: v.union(v.string(), v.null()),
  bookName: v.string(),
  purpose: v.string(),
  codedByName: v.union(v.string(), v.null()),
  daysWaiting: v.number(),
});

/**
 * Group the nudged codings by REVIEWER — one digest per person, listing every
 * coding waiting on them.
 *
 * Two rules the grouping enforces that a naive fan-out wouldn't:
 *
 *  - RECIPIENTS COME FROM THE APPROVAL SEATS, not from the manager ladder.
 *    `listCodingReviewerPersonIds` mirrors `requireReviewCoding`'s own arms,
 *    so the ED and the Chapter Director — who carry `finance.approve` and not
 *    `finance.manager` — are actually told. Mailing the manager set would skip
 *    exactly the people who were just given the power.
 *  - SEPARATION OF DUTIES. A reviewer is never told about a coding they wrote,
 *    because they cannot decide it; if that's the only one in their book they
 *    get no email at all rather than one they can do nothing about.
 */
export const getCodingReviewDigests = internalQuery({
  args: { codingIds: v.array(v.id("transactionCodings")) },
  returns: v.array(
    v.object({
      email: v.string(),
      reviewerName: v.string(),
      items: v.array(reviewDigestItemValidator),
    }),
  ),
  handler: async (ctx, args) => {
    const now = Date.now();
    const byPerson = new Map<
      string,
      {
        email: string;
        reviewerName: string;
        items: Array<Infer<typeof reviewDigestItemValidator>>;
      }
    >();
    // One reviewer-set read per BOOK, not per coding — a chapter's queue
    // resolves the same recipients every time.
    const reviewersByBook = new Map<string, Set<Id<"people">>>();

    for (const codingId of args.codingIds) {
      const coding = await ctx.db.get(codingId);
      // Decided between the sweep and this read → nothing left to nudge.
      if (!coding || coding.status !== "submitted") continue;
      const txn = await ctx.db.get(coding.transactionId);
      if (!txn) continue;

      const bookKey = String(coding.chapterId);
      let reviewers = reviewersByBook.get(bookKey);
      if (!reviewers) {
        reviewers = await listCodingReviewerPersonIds(ctx, coding.chapterId);
        reviewersByBook.set(bookKey, reviewers);
      }
      const bookName =
        coding.chapterId === CENTRAL
          ? "Central"
          : ((await ctx.db.get(coding.chapterId as Id<"chapters">))?.name ??
            "Chapter");
      const author = coding.codedByPersonId
        ? await ctx.db.get(coding.codedByPersonId)
        : null;

      for (const reviewerId of reviewers) {
        // SoD: never tell somebody about their own coding.
        if (coding.codedByPersonId && reviewerId === coding.codedByPersonId) {
          continue;
        }
        const person = await ctx.db.get(reviewerId);
        if (!person || person.isPlaceholder === true) continue;
        const email = person.pwEmail ?? person.email;
        if (!email) continue;
        const key = String(reviewerId);
        const entry =
          byPerson.get(key) ??
          { email, reviewerName: person.name, items: [] };
        entry.items.push({
          amountCents: txn.amountCents,
          merchantName: txn.merchantName ?? null,
          bookName,
          purpose: coding.businessPurpose,
          codedByName: author?.name ?? null,
          daysWaiting: Math.max(
            0,
            Math.floor((now - coding.submittedAt) / DAY_MS),
          ),
        });
        byPerson.set(key, entry);
      }
    }
    return [...byPerson.values()].filter((e) => e.items.length > 0);
  },
});

/** One reviewer's digest email. Best-effort like every other send here. */
async function notifyCodingReviewDigest(
  ctx: Pick<ActionCtx, "runQuery">,
  digest: {
    email: string;
    reviewerName: string;
    items: Infer<typeof reviewDigestItemValidator>[];
  },
): Promise<void> {
  const count = digest.items.length;
  const oldest = Math.max(...digest.items.map((i) => i.daysWaiting));
  const subject =
    count === 1
      ? "1 coding is waiting on your review"
      : `${count} codings are waiting on your review`;
  // The purpose IS the thing being reviewed, so it rides in the list — a
  // reviewer can tell from the email alone which ones will be quick.
  const list = emailList(
    digest.items.map(
      (i) =>
        `<b>${escapeHtml(`$${(Math.abs(i.amountCents) / 100).toFixed(2)}`)}</b> ${escapeHtml(
          i.merchantName ?? "a charge",
        )}${i.bookName ? ` · ${escapeHtml(i.bookName)}` : ""}${
          i.codedByName ? ` · ${escapeHtml(i.codedByName)}` : ""
        } — “${escapeHtml(i.purpose)}”${
          i.daysWaiting > 0
            ? ` (waiting ${i.daysWaiting} day${i.daysWaiting === 1 ? "" : "s"})`
            : ""
        }`,
    ),
  );
  const link = appUrl("/finances/coding");
  await sendEmail(ctx, {
    to: digest.email,
    subject,
    html: emailShell(`
      ${emailHeading(count === 1 ? "A coding needs your review" : "Codings need your review")}
      ${emailParagraph(
        `Hi ${escapeHtml(digest.reviewerName)} — ${count === 1 ? "one coding is" : `${count} codings are`} waiting on somebody to approve ${count === 1 ? "it" : "them"} or send ${count === 1 ? "it" : "them"} back with a note.`,
      )}
      ${list}
      ${emailParagraph(
        `Approve one only when it would satisfy a stranger reading Public Worship's public ledger; otherwise send it back saying exactly what would make it approvable. Until a coding is approved its charge can't be reconciled, and the spender is still on the 60-day accountable-plan clock${oldest > 0 ? ` — the oldest of these has been waiting ${oldest} day${oldest === 1 ? "" : "s"}` : ""}.`,
      )}
      ${link ? emailButtonRow(link, count === 1 ? "Review it →" : "Review them →") : ""}`),
  });
}

/**
 * The daily reviewer sweep: stamp the codings due a nudge, group them by
 * reviewer, send one digest each. Best-effort per email — one bad address
 * can't drop the rest, same as `sendReceiptReminders`.
 */
export const sendCodingReviewReminders = internalAction({
  args: {},
  returns: v.object({ nudgedCodings: v.number(), reviewersEmailed: v.number() }),
  handler: async (
    ctx,
  ): Promise<{ nudgedCodings: number; reviewersEmailed: number }> => {
    const codingIds = await ctx.runMutation(
      internal.cards.advanceCodingReviewReminders,
      {},
    );
    if (codingIds.length === 0) {
      return { nudgedCodings: 0, reviewersEmailed: 0 };
    }
    const digests = await ctx.runQuery(internal.cards.getCodingReviewDigests, {
      codingIds,
    });
    for (const digest of digests) {
      try {
        await notifyCodingReviewDigest(ctx, digest);
      } catch (err) {
        console.error(
          "sendCodingReviewReminders: digest email failed",
          digest.email,
          err,
        );
      }
    }
    return {
      nudgedCodings: codingIds.length,
      reviewersEmailed: digests.length,
    };
  },
});

// ── The coding chase (the grid's "Chase" / "Chase everyone") ────────────────
//
// The manager's on-demand counterpart to the automated day-1/day-3 digest
// above: an FM/Treasurer looking at Transactions grouped by Person can chase
// ONE cardholder's band, or every band at once, without waiting for the next
// cron pass.
//
// ONE CHASE, AND IT IS THE CODING ONE (founder, 2026-08-14: *"Instead of
// receipt chase, I want a coding chase, because coding includes receipts"*).
// This used to be `sendReceiptNudge`, and the rename is not cosmetic:
// `transactionCodings.submitCoding` REFUSES TO SUBMIT WITHOUT A RECEIPT OR A
// FILED EXCEPTION, so nobody can finish coding a charge without documenting it
// — a coding chase therefore subsumes a receipt chase and there is no longer a
// second one to keep in step. `/finances/receipt-chase` redirects into the grid
// grouped by person.
//
// WHO AND WHAT IT CHASES IS THE SERVER'S CALL; WHICH ROWS IS THE SCREEN'S.
// `finances.getCodingChaseTargets` owns the population (the union — everything
// owing a coding PLUS anything owing only a receipt), the scoping precedence
// (selection > filters+search > everything owed) and the gate
// (`lib/chaseAccess.ts#requireCodingChase`). Read its doc comment before
// changing anything here; this file's job is only to MAIL what it resolves.
//
// RATE-LIMITED to one chase per cardholder per `MANUAL_NUDGE_WINDOW_MS` (24h)
// via `receiptNudgeAttempts` — the same checked-and-recorded-atomically pattern
// `beginRevealCardDetails` uses, just with a "skip, don't error" outcome
// instead of a thrown `RATE_LIMITED`: a second click inside the window comes
// back `outcome:"already_nudged"` so the UI can show "Chased today" instead of
// an error toast.
//
// ── WHY THE LIMIT IS PER PERSON AND NOT PER PERSON-PER-SCOPE ────────────────
// The chase is scoped now, so the obvious question is whether a manager who
// chases three of somebody's rows should be free to chase the other two
// minutes later — i.e. whether the window should key on the SET of rows as well
// as the person.
//
// It should not, for a reason that is about the key and not about the policy:
// the chaseable set is a function of DATA THE MANAGER DOES NOT CONTROL. A
// cardholder who codes one of five charges changes it. So a per-scope key would
// let the window be reopened by the cardholder being responsive — chase five,
// they code one, chase again, they code another — which is not a weaker rate
// limit, it is no rate limit at all, aimed precisely at the person who is
// already cooperating.
//
// The limit exists to protect an INBOX, and an inbox belongs to a person, not
// to a filter set. So: one email per cardholder per day, whatever the scope,
// and the narrowing is something the manager does BEFORE they press the button
// (which is exactly what the scoping is for). The cost is real and accepted —
// a manager who chases everything and then wants to chase a different subset an
// hour later is told the person was already chased today, by name, rather than
// silently sending nothing.

// At most one chase email per cardholder per this window.
const MANUAL_NUDGE_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours
// A person-banded grid realistically has, at most, a few dozen cardholder
// bands — bounds the per-band chase-status lookup defensively.
const CHASE_NUDGE_STATUS_LIMIT = 200;

/**
 * Checks-and-records the manual-nudge rate limit ATOMICALLY for ONE
 * cardholder (same one-mutation check+insert shape as
 * `beginRevealCardDetails`'s own rate limiter): returns `true` (and inserts
 * the attempt row) iff no manual nudge was recorded for them in the last
 * `MANUAL_NUDGE_WINDOW_MS`; returns `false` (no insert) otherwise, so the
 * caller skips sending and reports `outcome:"already_nudged"` instead of
 * throwing. Re-asserts the manager gate itself (defense in depth — mirrors
 * every other `beginX` internal mutation in this file, e.g. `beginCancelCard`)
 * even though its only caller already checked via
 * `finances.getCodingChaseTargets`.
 *
 * KEYED ON THE PERSON ALONE (`person:<id>`), deliberately, now that the chase
 * is scoped — see the section header above for why a per-scope key would be no
 * rate limit at all.
 */
export const beginManualNudgeAttempt = internalMutation({
  args: { personId: v.id("people") },
  returns: v.boolean(),
  handler: async (ctx, { personId }): Promise<boolean> => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireFinanceManager(ctx, chapterId);

    const key = `person:${personId}`;
    const windowStart = Date.now() - MANUAL_NUDGE_WINDOW_MS;
    const recent = await ctx.db
      .query("receiptNudgeAttempts")
      .withIndex("by_key_and_time", (q) => q.eq("key", key).gte("createdAt", windowStart))
      .first();
    if (recent) return false;
    // Swept daily by maintenance.sweepRateLimitAttempts (crons.ts) once older
    // than MANUAL_NUDGE_WINDOW_MS.
    await ctx.db.insert("receiptNudgeAttempts", { key, createdAt: Date.now() });
    return true;
  },
});

/** The grid's per-cardholder "already chased" state: every `personId` (from
 *  `personIds`) currently inside its 24h chase window, with the timestamp of
 *  that chase — lets the UI render "Chased today" for a band without the caller
 *  having to press the button and be told `already_nudged`. Manager-gated, same
 *  floor as the chase action itself; bounded to a page's worth of bands.
 *
 *  Scope-blind, and correct that way: the window is per PERSON, so "has this
 *  person been chased today" has one answer regardless of which rows the
 *  manager is currently looking at. */
export const getManualNudgeStatus = query({
  args: { personIds: v.array(v.id("people")) },
  returns: v.array(v.object({ personId: v.id("people"), lastManualNudgeAt: v.number() })),
  handler: async (ctx, { personIds }) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireFinanceManager(ctx, chapterId);

    const windowStart = Date.now() - MANUAL_NUDGE_WINDOW_MS;
    const out: Array<{ personId: Id<"people">; lastManualNudgeAt: number }> = [];
    for (const personId of personIds.slice(0, CHASE_NUDGE_STATUS_LIMIT)) {
      const key = `person:${personId}`;
      const recent = await ctx.db
        .query("receiptNudgeAttempts")
        .withIndex("by_key_and_time", (q) => q.eq("key", key).gte("createdAt", windowStart))
        .order("desc")
        .first();
      if (recent) out.push({ personId, lastManualNudgeAt: recent.createdAt });
    }
    return out;
  },
});

/** Best-effort SMS alongside the chase email, pointing at the text-to-receipt
 *  number (`smsReceipts.ts`) — mirrors `replyToSmsSender`'s shape (no-op
 *  without Twilio configured, swallows its own failures, never throws).
 *  Returns whether it actually attempted (and didn't error on) a send.
 *
 *  The reply-with-a-photo instruction is only appended when a RECEIPT is
 *  actually part of what's missing: texting a photo can't write a business
 *  purpose, and telling someone it will is how a channel loses its
 *  credibility. Coding-only debts point at the app instead. */
async function sendCodingChaseSms(
  ctx: ActionCtx,
  phone: string,
  charges: ReminderCharge[],
): Promise<boolean> {
  const creds = await resolveTwilioCredentials(ctx);
  if (!creds) return false;
  const to = normalizePhone(phone);
  if (!to) return false;

  const count = charges.length;
  const fmt = (c: { amountCents: number; merchantName: string | null }) =>
    `$${(c.amountCents / 100).toFixed(2)}${c.merchantName ? ` at ${c.merchantName}` : ""}`;
  const closer = charges.some((c) => c.missingReceipt)
    ? "Reply here with a photo to file a receipt, or open Finances → My Transactions in the app to finish the coding."
    : "Open Finances → My Transactions in the app to finish the coding.";
  const body =
    count === 1
      ? `Reminder: ${fmt(charges[0])} ${charges[0].outstanding}. ${closer}`
      : `Reminder: ${count} of your card charges still need coding (starting with ${fmt(charges[0])} — ${charges[0].outstanding}). ${closer}`;
  try {
    await sendSms(creds, { to, body });
    return true;
  } catch (err) {
    console.log(`[cards] sendCodingChase: SMS failed: ${String(err)}`);
    return false;
  }
}

const nudgeResultValidator = v.object({
  personId: v.id("people"),
  cardholderName: v.string(),
  outcome: v.union(
    v.literal("sent"),
    v.literal("already_nudged"),
    v.literal("no_email"),
  ),
  emailSent: v.boolean(),
  smsSent: v.boolean(),
  /** How many charges this person was chased about — what the manager scoped
   *  the chase down to, echoed back so the UI can say "Chased Ada (3)" rather
   *  than leaving them to trust that the narrowing took. */
  chargeCount: v.number(),
});
type NudgeResult = typeof nudgeResultValidator.type;

/**
 * THE CHASE EMAIL — "click this button to code your charges."
 *
 * Founder, 2026-08-14, on what it has to say: *"sends an email like 'hey, click
 * this button to code all your charges, tell us what it was for, so we can
 * comply with IRS guidelines and also publish this in the public ledger for our
 * donors.'"* All three beats are here, in that order, and none of them is
 * decoration:
 *
 *  · THE BUTTON. One link, to `/code` — the cardholder's own list, no finance
 *    seat required, no app chrome. The ask is a tap, not a navigation.
 *  · WHAT WE WANT. "What it was for" is the whole job in the words a volunteer
 *    uses, ahead of any rule.
 *  · WHY. TWO reasons, and the second is the one this org actually runs on: the
 *    IRS substantiation rule (spending we can't account for in time becomes
 *    taxable income to the person who spent it), and the PUBLIC LEDGER — every
 *    dollar published for donors to read. A compliance-only email says "or
 *    you'll be taxed"; this one says "and it goes on the page our donors read",
 *    which is the sentence that makes coding feel like the point rather than
 *    the paperwork.
 *
 * NOT the automated digest (`notifyReceiptDigest`), and deliberately a separate
 * composer. That one is a TIMELINE artifact — it leads with the day-1/day-3
 * stage, warns about the day-7 card lock, and lists only what transitioned this
 * pass. This one is a PERSON asking, about a set that person chose, and it must
 * not inherit the lock threat for rows whose only debt is a coding. They share
 * the per-charge shape (`reminderChargeValidator`) and the shell helpers, which
 * is the part worth sharing.
 *
 * Best-effort like every other sender here: logs + no-ops without
 * `RESEND_API_KEY` (dev), and never sends an EMPTY chase — a zero-charge target
 * cannot reach this, and it returns early if one somehow does.
 */
async function notifyCodingChase(
  ctx: ActionCtx,
  chase: {
    email: string;
    cardholderName: string;
    charges: ReminderCharge[];
  },
): Promise<void> {
  const count = chase.charges.length;
  if (count === 0) return;
  const fmt = (c: { amountCents: number; merchantName: string | null }) =>
    `$${(c.amountCents / 100).toFixed(2)}${c.merchantName ? ` at ${c.merchantName}` : ""}`;
  const headline = count === 1 ? "1 charge to code" : `${count} charges to code`;
  const subject =
    count === 1
      ? `Code your ${fmt(chase.charges[0])} charge`
      : `Code your ${count} card charges`;
  const intro =
    count === 1
      ? `your ${escapeHtml(fmt(chase.charges[0]))} charge ${escapeHtml(chase.charges[0].outstanding)}. Tell us what it was for and it's done.`
      : `${count} of your card charges are waiting on you. Tell us what each one was for and they're done:`;
  const list =
    count === 1
      ? ""
      : emailList(
          chase.charges.map(
            (c) => `${escapeHtml(fmt(c))} — ${escapeHtml(c.outstanding)}`,
          ),
        );
  // THE TWO REASONS, in one paragraph, always — unlike the automated digest's
  // `whyNote`, which prints the tax rule only when a coding is part of what's
  // missing. A chase asks for the CODING by name whatever each row currently
  // owes (a receipt with no purpose written is still a charge nobody can
  // publish), so both reasons apply to every chase that gets sent.
  //
  // No day count on purpose: `codingOverdueDays` is an org setting, and an
  // email that hard-codes "60 days" is one settings change away from lying.
  const whyNote = emailParagraph(
    `Two reasons we ask. Under IRS rules, spending we can't substantiate in time counts as taxable income to the person who spent it — so a charge left uncoded eventually gets billed back to you. And every dollar we spend gets published in our public ledger for our donors to read: your sentence is what goes on that page, so a blank one is a line our donors can't see the point of.`,
  );
  // Same destination the automated digest uses — the cardholder's own list,
  // pre-filtered to what they owe. Null (the row is omitted) when APP_URL is
  // unset, which is the dev default.
  const link = appUrl("/code?filter=uncoded");
  await sendEmail(ctx, {
    to: chase.email,
    subject,
    html: emailShell(`
      ${emailHeading(headline)}
      ${emailParagraph(`Hi ${escapeHtml(chase.cardholderName)} — ${intro}`, {
        margin: `0 0 ${count === 1 ? 16 : 8}px`,
      })}
      ${list}
      ${whyNote}
      ${link ? emailButtonRow(link, `Code ${count === 1 ? "it" : "them"} →`) : ""}`),
  });
}

/**
 * THE CODING CHASE — the grid's per-person "Chase" (`personId` set) and
 * page-level "Chase everyone" (`personId` omitted) buttons, both calling this
 * SAME action with the SAME view arguments.
 *
 * That sameness is the point of the shape: "Chase everyone" is exactly "Chase"
 * with the person left off, so the two can never describe different
 * populations. Whatever the manager has narrowed to — filters, search, ticked
 * rows, the period window — is what BOTH buttons act on.
 *
 * Every argument except `personId` is forwarded verbatim to
 * `finances.getCodingChaseTargets`, which owns the gate, the population and the
 * scoping precedence (selection > filters+search > everything owed) and does
 * NOT trust the id list it is handed. Read its doc comment first.
 *
 * Per target cardholder:
 *  1. Skip with `outcome:"no_email"` if they have no reachable email at all —
 *     email is the required channel (mirrors `getReceiptReminderDigests`
 *     dropping an unreachable cardholder from the automated digest). REPORTED,
 *     never silent: the manager gets their name back so they can go find an
 *     address, and the 24h rate-limit slot is NOT consumed.
 *  2. Otherwise check-and-record the 24h rate limit
 *     (`beginManualNudgeAttempt`); `outcome:"already_nudged"` (no send) if one
 *     was already recorded. Per PERSON — see the section header.
 *  3. Send the chase email (`notifyCodingChase`) — best-effort: a failed send
 *     still counts as "sent" for rate-limiting purposes, matching how the
 *     automated digest treats its own failures (logged, never thrown).
 *  4. Best-effort SMS if a phone is on file + Twilio resolves
 *     (`sendCodingChaseSms`) — never blocks or fails the email path.
 *
 * NOTHING TO CHASE SENDS NOTHING. A target with zero chaseable charges cannot
 * be produced by the query, and the guard below is belt-and-braces; a scope
 * that resolves to no targets at all comes back `results: []`, which the grid
 * renders as "Nothing in this view is waiting on a cardholder" rather than an
 * email nobody needed.
 */
export const sendCodingChase = action({
  args: {
    personId: v.optional(v.id("people")),
    scope: v.optional(v.literal("central")),
    chapterId: v.optional(v.id("chapters")),
    // THE VIEW, forwarded verbatim — see `finances.getCodingChaseTargets`.
    filters: v.optional(v.array(reconcileFilterValidator)),
    search: v.optional(v.string()),
    year: v.optional(v.number()),
    month: v.optional(v.number()),
    period: v.optional(v.union(v.literal("month"), v.literal("ytd"))),
    selectedIds: v.optional(v.array(v.id("transactions"))),
  },
  returns: v.object({ results: v.array(nudgeResultValidator) }),
  handler: async (ctx, args): Promise<{ results: NudgeResult[] }> => {
    const targets: ChaseTarget[] = await ctx.runQuery(
      internal.finances.getCodingChaseTargets,
      args,
    );

    const results: NudgeResult[] = [];
    for (const target of targets) {
      if (target.charges.length === 0) continue;

      if (!target.email) {
        results.push({
          personId: target.personId,
          cardholderName: target.cardholderName,
          outcome: "no_email",
          emailSent: false,
          smsSent: false,
          chargeCount: target.charges.length,
        });
        continue;
      }

      const ok: boolean = await ctx.runMutation(internal.cards.beginManualNudgeAttempt, {
        personId: target.personId,
      });
      if (!ok) {
        results.push({
          personId: target.personId,
          cardholderName: target.cardholderName,
          outcome: "already_nudged",
          emailSent: false,
          smsSent: false,
          chargeCount: target.charges.length,
        });
        continue;
      }

      let emailSent = false;
      try {
        await notifyCodingChase(ctx, {
          email: target.email,
          cardholderName: target.cardholderName,
          charges: target.charges,
        });
        emailSent = true;
      } catch (err) {
        console.error("[cards] sendCodingChase: email failed", target.email, err);
      }

      const smsSent = target.phone
        ? await sendCodingChaseSms(ctx, target.phone, target.charges)
        : false;

      results.push({
        personId: target.personId,
        cardholderName: target.cardholderName,
        outcome: "sent",
        emailSent,
        smsSent,
        chargeCount: target.charges.length,
      });
    }
    return { results };
  },
});

// ── guards ───────────────────────────────────────────────────────────────────
/** Enforce the non-negative-integer-cents invariant the arg validator can't. */
function assertIntegerCents(amountCents: number, label = "Amount"): void {
  if (!Number.isInteger(amountCents) || amountCents < 0) {
    throw new ConvexError({
      code: "INVALID_AMOUNT",
      message: `${label} must be a non-negative whole number of cents.`,
    });
  }
}

// ── Chasing a debt: "you still owe this" reminders ───────────────────────────
/**
 * Founder, 2026-08-14: "there are a bunch of people with personal charges. I
 * want to be able to send them to reimbursements, and then they see 'hey, you
 * owe this amount'."
 *
 * Until now the ONLY email anyone got about a personal charge was the one sent
 * the moment it was flagged. After that the debt sat on a collections desk
 * nobody outside finance ever opens, and the only chasing mechanism was a
 * treasurer remembering to mention it in person — which, for a volunteer org,
 * means the awkward ones never get mentioned at all.
 *
 * Three properties this deliberately has:
 *
 *  · ONE EMAIL PER PERSON, not per charge. Somebody with four flagged charges
 *    gets a single message listing all four and one total. Four separate
 *    emails about $14 each is how a helpful reminder becomes harassment.
 *  · IT NEVER CHASES MONEY THAT IS ALREADY MOVING. A charge whose bank debit
 *    is `processing` is excluded (`isBillableRepayment`), so the person who
 *    did the right thing three days ago is not asked again — the single most
 *    corrosive thing a collections tool can do.
 *  · IT REMEMBERS. `lastNudgedAt` is stamped per repayment and enforced as a
 *    cooldown (`REPAYMENT_NUDGE_COOLDOWN_MS`), so pressing the button twice
 *    sends one email.
 */

/** One person's outstanding debt, assembled for a reminder email. */
const nudgeTargetValidator = v.object({
  payerPersonId: v.id("people"),
  name: v.string(),
  email: v.string(),
  totalCents: v.number(),
  repaymentIds: v.array(v.id("personalRepayments")),
  charges: v.array(
    v.object({
      merchantName: v.union(v.string(), v.null()),
      amountCents: v.number(),
      postedAt: v.union(v.number(), v.null()),
    }),
  ),
});

/**
 * Who is due a reminder, grouped by person and already filtered by the
 * cooldown. A person with SOME charges inside the cooldown and some outside is
 * emailed about all of their outstanding ones — the email is "here is what you
 * owe", and an email that listed three of somebody's four charges would be
 * worse than either alternative.
 *
 * Skips anyone with no reachable email address rather than failing the batch:
 * a roster row without one is a data gap for someone else to fix, not a reason
 * the other eleven people don't get reminded.
 */
/**
 * WHICH SETTLED REPAYMENTS ARE STILL MISSING THEIR FEE-COVERAGE ROW.
 *
 * Read-only, and it exists because the correction could not be written blind.
 * Migration `0073` was pinned to "one settled Stripe repayment of $6.00" — the
 * founder's own reading of the payment — and REFUSED on deploy, finding none.
 * The refusal was the guard working (booking 49¢ against the wrong row invents
 * money nobody sent), but it left the question open, and this deployment's data
 * is not readable from a laptop: the Convex MCP resolves this project to a
 * different deployment entirely, and every list query on repayments requires a
 * signed-in finance identity that a deploy key does not have.
 *
 * So: an INTERNAL query, callable by the deploy key through
 * `run-convex-function.yml`, that answers exactly the question a pinned
 * migration has to be able to answer.
 *
 *   gh workflow run run-convex-function.yml -f function=cards:repaymentFeeCoverageAudit
 *
 * IT NAMES NOBODY. A payer's identity is not part of the question — the pin
 * needs an amount, a rail, a settle time and a session — and this output goes
 * into a CI log, which is a worse place to put a person's name than any screen
 * in the app.
 *
 * KEPT after the correction rather than deleted with it. "Did any fee coverage
 * go unbooked?" stops being a one-off the moment the answer can drift again —
 * a rail added, a settle path that forgets the row — and the same reading that
 * sizes a migration is the one that audits it afterwards.
 */
export const repaymentFeeCoverageAudit = internalQuery({
  args: {},
  returns: v.object({
    settledViaStripe: v.number(),
    missingCoverageRow: v.array(
      v.object({
        amountCents: v.number(),
        method: v.string(),
        settledAt: v.string(),
        sessionId: v.string(),
        chapterId: v.string(),
      }),
    ),
    withCoverageRow: v.number(),
    /**
     * THE OTHER HALF, and the reason this query grew.
     *
     * Coverage income is booked the instant a repayment settles; the fee it
     * offsets is booked by the daily 09:30 UTC sweep inside the morning
     * engine. Between the two, book value runs HIGH by the coverage — which is
     * a real, visible wobble on the accounts page, and the founder hit it
     * within the hour ("now, when I go to accounts, lo and behold, there's
     * $3.35 not accounted for").
     *
     * So the audit reports both sides: every coverage row booked, and when the
     * Stripe fee expense was last refreshed. A coverage row posted AFTER that
     * refresh has no expense against it yet, and its amount is exactly the
     * temporary gap.
     */
    coverageRows: v.array(
      v.object({
        amountCents: v.number(),
        bookedAt: v.string(),
        merchantName: v.union(v.string(), v.null()),
        categorised: v.boolean(),
      }),
    ),
    stripeFeeRows: v.array(
      v.object({
        month: v.string(),
        amountCents: v.number(),
        postedAt: v.string(),
      }),
    ),
    /** Coverage booked with no fee sweep since — the size of the wobble. */
    awaitingFeeSweepCents: v.number(),
  }),
  handler: async (ctx) => {
    const all = await ctx.db.query("personalRepayments").collect();
    const settled = all.filter(
      (r) =>
        r.status === "paid" &&
        r.creditTransactionId != null &&
        r.stripeCheckoutSessionId != null,
    );

    const missing: {
      amountCents: number;
      method: string;
      settledAt: string;
      sessionId: string;
      chapterId: string;
    }[] = [];
    let withRow = 0;
    for (const r of settled) {
      const sessionId = r.stripeCheckoutSessionId!;
      const coverage = await ctx.db
        .query("transactions")
        .withIndex("by_external_id", (q) =>
          q.eq("externalId", `stripe_repayment_fee_coverage:${sessionId}`),
        )
        .first();
      if (coverage) {
        withRow += 1;
        continue;
      }
      missing.push({
        amountCents: r.amountCents,
        method: r.method,
        settledAt: new Date(r.updatedAt).toISOString(),
        sessionId,
        chapterId: String(r.chapterId),
      });
    }
    // ── THE PAIRING ───────────────────────────────────────────────────────
    // Every coverage row, and every Stripe fee row it could be offset by. The
    // fee rows are the monthly rollups `processorFees.ts` writes, found by the
    // marker it stamps rather than by name or merchant.
    const allTxns = await ctx.db.query("transactions").collect();
    const coverage = allTxns.filter((t) => t.feeCoverageOrigin != null);
    const feeRows = allTxns.filter((t) => t.feeOrigin === "stripe_processing");

    // The most recent moment the Stripe fee expense was refreshed.
    const lastFeeRefresh = feeRows.reduce(
      (latest, t) => Math.max(latest, t.postedAt),
      0,
    );
    // WHEN THE PAYMENT SETTLED, NOT WHEN THE ROW WAS WRITTEN. The first
    // version of this compared the coverage row's `createdAt`, and got the
    // wrong answer on the only data that existed: both rows were written by a
    // migration at 16:59, after the 09:30 sweep, so it reported 384¢ awaiting
    // — when the 49¢ payment had settled at 04:37 and its fee was already in
    // that morning's rollup. What decides whether a fee has been swept is when
    // STRIPE saw the charge, which is the repayment's settle time.
    let awaitingFeeSweepCents = 0;
    for (const row of coverage) {
      const sessionId = (row.externalId ?? "").replace(
        "stripe_repayment_fee_coverage:",
        "",
      );
      const settledAt = all
        .filter((r) => r.stripeCheckoutSessionId === sessionId)
        .reduce((latest, r) => Math.max(latest, r.updatedAt), 0);
      // No settle time to read ⇒ cannot claim it is covered. Counted, so this
      // errs toward reporting a wobble that is not there rather than hiding
      // one that is.
      if (settledAt === 0 || settledAt > lastFeeRefresh) {
        awaitingFeeSweepCents += row.amountCents;
      }
    }

    return {
      settledViaStripe: settled.length,
      missingCoverageRow: missing,
      withCoverageRow: withRow,
      coverageRows: coverage.map((t) => ({
        amountCents: t.amountCents,
        bookedAt: new Date(t.createdAt).toISOString(),
        merchantName: t.merchantName ?? null,
        categorised: t.categoryId != null,
      })),
      stripeFeeRows: feeRows.map((t) => ({
        month: new Date(t.postedAt).toISOString().slice(0, 7),
        amountCents: t.amountCents,
        postedAt: new Date(t.postedAt).toISOString(),
      })),
      awaitingFeeSweepCents,
    };
  },
});

export const gatherRepaymentNudges = internalQuery({
  args: { payerPersonId: v.optional(v.id("people")) },
  returns: v.object({
    targets: v.array(nudgeTargetValidator),
    /** Owed-something people held back by the cooldown — reported so the UI
     *  can say "3 reminded, 2 skipped (reminded recently)" instead of
     *  silently doing less than the button implied. */
    cooledDown: v.number(),
    /** People with an outstanding debt and no email address on file. */
    unreachable: v.number(),
  }),
  handler: async (ctx, { payerPersonId }) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireRepaymentsCollect(ctx, chapterId);

    const rows = await ctx.db
      .query("personalRepayments")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
      .take(CHAPTER_REPAYMENTS_LIMIT);

    const cutoff = Date.now() - REPAYMENT_NUDGE_COOLDOWN_MS;
    const byPerson = new Map<Id<"people">, Doc<"personalRepayments">[]>();
    for (const row of rows) {
      if (payerPersonId && row.payerPersonId !== payerPersonId) continue;
      // Billable, not merely outstanding: never chase a debit that's clearing.
      if (!isBillableRepayment(row)) continue;
      const list = byPerson.get(row.payerPersonId) ?? [];
      list.push(row);
      byPerson.set(row.payerPersonId, list);
    }

    const targets: (typeof nudgeTargetValidator.type)[] = [];
    let cooledDown = 0;
    let unreachable = 0;
    for (const [personId, list] of byPerson) {
      // One recent reminder silences the whole person, not just the charge it
      // covered — the email was "here is what you owe" and already named them.
      const recentlyNudged = list.some(
        (r) => (r.lastNudgedAt ?? 0) > cutoff,
      );
      if (recentlyNudged) {
        cooledDown += 1;
        continue;
      }
      const person = await ctx.db.get(personId);
      const email = person?.pwEmail ?? person?.email;
      if (!person || !email) {
        unreachable += 1;
        continue;
      }
      const charges: { merchantName: string | null; amountCents: number; postedAt: number | null }[] =
        [];
      for (const r of list) {
        const txn = await ctx.db.get(r.transactionId);
        charges.push({
          merchantName: txn?.merchantName ?? null,
          amountCents: r.amountCents,
          postedAt: txn?.postedAt ?? null,
        });
      }
      charges.sort((a, b) => (b.postedAt ?? 0) - (a.postedAt ?? 0));
      targets.push({
        payerPersonId: personId,
        name: person.name,
        email,
        totalCents: list.reduce((sum, r) => sum + r.amountCents, 0),
        repaymentIds: list.map((r) => r._id),
        charges,
      });
    }
    // Biggest debt first: if a batch is ever truncated or a manager reads the
    // toast and stops, the money that matters most has already gone out.
    targets.sort((a, b) => b.totalCents - a.totalCents);
    return { targets, cooledDown, unreachable };
  },
});

/** Stamp `lastNudgedAt` on everything one reminder covered. Separate from the
 *  gather so the mark happens only for an email that actually SENT — a Resend
 *  failure must not silence the next attempt for three days. */
export const markRepaymentsNudged = internalMutation({
  args: { repaymentIds: v.array(v.id("personalRepayments")) },
  returns: v.null(),
  handler: async (ctx, { repaymentIds }) => {
    const now = Date.now();
    for (const id of repaymentIds) {
      const row = await ctx.db.get(id);
      if (!row) continue;
      await ctx.db.patch(id, { lastNudgedAt: now, updatedAt: now });
    }
    return null;
  },
});

/**
 * Send the reminders. Manager-gated (`requireRepaymentsCollect`, re-checked
 * inside `gatherRepaymentNudges`).
 *
 * Returns counts rather than throwing on a partial failure: eleven emails out
 * and one Resend error is a good outcome to report honestly, not a reason to
 * fail the whole action. Each person's `lastNudgedAt` is stamped only after
 * THEIR email is accepted, so a failure leaves them eligible tomorrow.
 */
export const nudgeOutstandingRepayments = action({
  args: { payerPersonId: v.optional(v.id("people")) },
  returns: v.object({
    notified: v.number(),
    cooledDown: v.number(),
    unreachable: v.number(),
    failed: v.number(),
  }),
  handler: async (
    ctx,
    { payerPersonId },
  ): Promise<{
    notified: number;
    cooledDown: number;
    unreachable: number;
    failed: number;
  }> => {
    const { targets, cooledDown, unreachable } = await ctx.runQuery(
      internal.cards.gatherRepaymentNudges,
      payerPersonId ? { payerPersonId } : {},
    );

    const link = appUrl("/finances/repayments");
    if (!link) {
      // Degrade LOUDLY rather than send a "you owe $248" email with nowhere to
      // pay it — the same rule `notifyPersonalChargeFlagged` follows.
      console.error(
        "[cards] nudgeOutstandingRepayments: APP_URL is unset — refusing to send reminders with no pay-back link",
      );
      throw new ConvexError({
        code: "NOT_CONFIGURED",
        message:
          "Reminders aren't available yet — the app's public URL isn't configured.",
      });
    }

    let notified = 0;
    let failed = 0;
    for (const target of targets) {
      const dollars = formatCents(target.totalCents);
      const lines = target.charges
        .map((c) => {
          const when = c.postedAt
            ? new Date(c.postedAt).toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
                timeZone: "America/New_York",
              })
            : null;
          return `<div>${escapeHtml(c.merchantName ?? "Card charge")}${
            when ? ` · ${escapeHtml(when)}` : ""
          } — <strong>${escapeHtml(formatCents(c.amountCents))}</strong></div>`;
        })
        .join("");
      try {
        await sendEmail(ctx, {
          to: target.email,
          subject: `A reminder: you owe Public Worship ${dollars}`,
          html: emailShell(`
            ${emailHeading(`You owe Public Worship ${escapeHtml(dollars)}`)}
            ${emailParagraph(
              `Hi ${escapeHtml(target.name)} — ${
                target.charges.length === 1
                  ? "a charge on your card was"
                  : `${target.charges.length} charges on your card were`
              } flagged as personal, so ${
                target.charges.length === 1 ? "it's" : "they're"
              } yours to pay back rather than the ministry's to cover. No paperwork — open the app, pick what you're ready to settle, and pay by card or bank transfer.`,
            )}
            ${emailPanel(lines)}
            ${emailParagraph(
              "You'll cover the payment processor's fee on top, so Public Worship gets the full amount back — the exact figure is shown before you confirm, and paying by bank transfer costs a good deal less than by card.",
              { size: 12, margin: "16px 0 0" },
            )}
            ${emailButtonRow(link, "Pay it back →")}
            ${emailParagraph(
              "If you think one of these isn't actually a personal charge, reply and tell your Treasurer — they can un-flag it.",
              { size: 12, margin: "16px 0 0" },
            )}`),
        });
        await ctx.runMutation(internal.cards.markRepaymentsNudged, {
          repaymentIds: target.repaymentIds,
        });
        notified += 1;
      } catch (err) {
        // Their `lastNudgedAt` stays untouched, so tomorrow's press reaches
        // them. Logged, never thrown past here: one bad address must not stop
        // the rest of the batch.
        console.error(
          "[cards] nudgeOutstandingRepayments: send failed",
          target.payerPersonId,
          err,
        );
        failed += 1;
      }
    }
    return { notified, cooledDown, unreachable, failed };
  },
});
