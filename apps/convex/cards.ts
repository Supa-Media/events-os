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
import { ConvexError, v } from "convex/values";
import { api, internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import {
  CARD_TYPES,
  CARD_STATUSES,
  CARD_SOURCES,
  CARD_REQUEST_STATUSES,
  REPAYMENT_METHODS,
  REPAYMENT_STATUSES,
  RECEIPT_GRACE_DAYS,
  RECEIPT_ESCALATE_DAYS,
  EXTERNAL_ACCOUNT_FUNDINGS,
  easternParts,
  matchesMode,
  isSandboxObjectId,
  isCardEligible,
  getAcademyCourse,
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
} from "./lib/finance";
import { viewerPerson } from "./lib/org";
import {
  increaseEnvForObjectId,
  assertRoutingNumber,
  assertAccountNumber,
} from "./increase";
import { sendEmail, sendEmailReporting, emailShell } from "./ticketingEmails";
import { escapeHtml } from "./lib/html";
import { appUrl } from "./lib/siteUrl";
import { normalizePhone, resolveTwilioCredentials, sendSms } from "./lib/twilio";

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
      internal.increase.getCardArtProfileId,
      { sandbox: isSandboxObjectId(prep.increaseAccountId) },
    );

    try {
      const card = await increasePost(key, base, "/cards", {
        account_id: prep.increaseAccountId,
        description: prep.description,
        ...(cardArtProfileId
          ? { digital_wallet: { digital_card_profile_id: cardArtProfileId } }
          : {}),
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

/** Lock a card (manager). No new authorizations approve while locked. */
export const lockCard = mutation({
  args: { cardId: v.id("cards") },
  returns: cardSummaryValidator,
  handler: async (ctx, { cardId }): Promise<CardSummary> => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireFinanceManager(ctx, chapterId);
    const card = await requireOwnedCard(ctx, chapterId, cardId);
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
                <h1 style="margin:0 0 12px;font-size:24px;line-height:1.2">Your wallet verification code</h1>
                <p style="margin:0 0 16px;font-family:-apple-system,'Segoe UI',Roboto,sans-serif;font-size:14px;line-height:1.6;color:#7A5A5A">Enter this code to finish adding your card to your digital wallet:</p>
                <p style="margin:0;font-family:-apple-system,'Segoe UI',Roboto,sans-serif;font-size:32px;font-weight:700;letter-spacing:0.08em;color:#210909">${escapeHtml(auth.one_time_passcode)}</p>`),
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
  await ctx.db.patch(txn._id, { isPersonal: true, repaymentId });
  return { repayment: (await ctx.db.get(repaymentId))!, created: true };
}

// ── flagPersonalCharge (cardholder or manager) ───────────────────────────────

/**
 * Flag a card charge as an accidental personal charge. The cardholder OR a
 * finance manager may flag it. Marks the transaction `isPersonal` (removing it
 * from category spend) and creates a `pending` `personalRepayments` row owned by
 * the card's cardholder. IDEMPOTENT: one repayment per transaction.
 *
 * MANAGER-INITIATED (D4): when a MANAGER flags someone ELSE's charge, the
 * cardholder is notified by best-effort email (`notifyPersonalChargeFlagged`,
 * scheduled so the mutation never blocks on Resend) — they otherwise have no
 * way to learn a charge on THEIR card was just marked personal. A cardholder
 * flagging their own charge needs no such email (they already know).
 */
export const flagPersonalCharge = mutation({
  args: { transactionId: v.id("transactions") },
  returns: repaymentSummaryValidator,
  handler: async (ctx, { transactionId }): Promise<RepaymentSummary> => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    const access = await getFinanceRole(ctx, chapterId);

    const txn = await ctx.db.get(transactionId);
    await requireInChapter(ctx, chapterId, txn, "Transaction");
    const transaction = txn!;

    if (!transaction.cardId) {
      throw new ConvexError({
        code: "NOT_A_CARD_CHARGE",
        message: "Only a card charge can be flagged as personal.",
      });
    }
    const card = await ctx.db.get(transaction.cardId);
    await requireInChapter(ctx, chapterId, card, "Card");
    const cardholderPersonId = card!.cardholderPersonId;

    // Authorization: the cardholder themselves, or a finance manager.
    const isCardholder =
      access.personId != null && access.personId === cardholderPersonId;
    if (!isCardholder && !access.isManager) {
      throw new ConvexError({
        code: "FORBIDDEN",
        message: "Only the cardholder or a finance manager can flag this charge.",
      });
    }

    // IDEMPOTENT: one repayment per transaction — the shared conversion core
    // (also used by the no-receipt sweep) handles the insert + back-link.
    const { repayment, created } = await convertChargeToPersonalRepayment(
      ctx,
      transaction,
      cardholderPersonId,
    );

    // Manager flagging SOMEONE ELSE's charge → notify the cardholder, but ONLY
    // on the FIRST conversion (`created`) — a repeat flag of an already-personal
    // charge is a no-op and must not re-email. Scheduled (not awaited) so a
    // slow/failing Resend call never blocks the flag itself; the action is
    // best-effort and degrades silently without a key.
    if (created && !isCardholder) {
      await ctx.scheduler.runAfter(0, internal.cards.notifyPersonalChargeFlagged, {
        repaymentId: repayment._id,
      });
    }

    return toRepaymentSummary(repayment);
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
    };
  },
});

/** Best-effort "a charge on your card was marked personal" email — logs +
 *  no-ops without `RESEND_API_KEY` (same degrade as `notifyReceiptDigest`).
 *  Never throws past itself (it's a scheduled fire-and-forget job off the
 *  flagging mutation, so a Resend failure here must not surface anywhere). */
export const notifyPersonalChargeFlagged = internalAction({
  // `auto` distinguishes the no-receipt sweep's auto-conversion
  // (`autoConvertOverdueReceipts`) from a manager's manual flag — same email
  // machinery, different reason copy.
  args: { repaymentId: v.id("personalRepayments"), auto: v.optional(v.boolean()) },
  handler: async (ctx, { repaymentId, auto }) => {
    try {
      const contact = await ctx.runQuery(
        internal.cards.getPersonalChargeFlagContact,
        { repaymentId },
      );
      if (!contact) return null;
      const dollars = `$${(contact.amountCents / 100).toFixed(2)}`;
      const merchant = contact.merchantName ?? "a charge on your card";
      const subject = auto
        ? `A charge with no receipt became a personal charge — you owe ${dollars}`
        : `A charge on your card was marked personal — you owe ${dollars}`;
      const reason = auto
        ? `${escapeHtml(merchant)} (${escapeHtml(dollars)}) passed the receipt deadline with no receipt attached, so it was automatically converted to a personal charge.`
        : `a finance manager marked ${escapeHtml(merchant)} (${escapeHtml(dollars)}) as a personal charge.`;
      // The Cards tab's member view (`MemberCardsView`) owns the per-charge
      // flag/pay-back list this charge lives in — not Reimbursements (which
      // only shows the aggregate "you owe" total). Null when APP_URL is unset.
      const link = appUrl("/finances/cards");
      await sendEmail(ctx, {
        to: contact.email,
        subject,
        html: emailShell(`
          <h1 style="margin:0 0 12px;font-size:24px;line-height:1.2">${escapeHtml(subject)}</h1>
          <p style="margin:0 0 16px;font-family:-apple-system,'Segoe UI',Roboto,sans-serif;font-size:14px;line-height:1.6;color:#7A5A5A">Hi ${escapeHtml(contact.cardholderName)} — ${reason} Pay it back from the Cards tab in the app.</p>
          ${
            link
              ? `<div style="font-family:-apple-system,'Segoe UI',Roboto,sans-serif;font-size:12px;font-weight:600"><a href="${link}" style="color:#fff;background:#D23B3A;text-decoration:none;border:1px solid #D23B3A;border-radius:999px;padding:6px 12px;display:inline-block">Pay it back →</a></div>`
              : ""
          }`),
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
  postedAt: v.number(),
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
          postedAt: txn?.postedAt ?? r.createdAt,
          hasExternalAccount: !!r.payerExternalAccountId,
        };
      }),
    );
  },
});

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

// ── Personal-repayment settlement (the testable core) ────────────────────────

/**
 * Settle a repayment: mark it `paid` and post the single OFFSETTING credit — a
 * positive `flow:"transfer"` transaction (EXCLUDED from category spend, so it
 * nets the personal charge without counting as income) owned by the payer and
 * linked back to the repayment. IDEMPOTENT via `creditTransactionId`.
 */
async function settleRepayment(
  ctx: MutationCtx,
  repayment: Doc<"personalRepayments">,
  increaseRef?: string,
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
    increaseRef: increaseRef ?? repayment.increaseRef,
    updatedAt: now,
  });
  return (await ctx.db.get(repayment._id))!;
}

/**
 * Confirm a personal repayment was RECEIVED and post the offsetting
 * `flow:"transfer"` credit (the working / degraded path, mirroring
 * `increase.markPaidManually`). MANAGER-ONLY on purpose: this is the manual
 * "the money arrived" confirmation, NOT self-serve — a member must not be able
 * to flag their own charge personal and then zero it out here without actually
 * paying. The member's own path is `initiateRepayment` (a real card/ACH charge).
 * IDEMPOTENT: a re-call posts no second credit.
 */
export const markRepaymentPaid = mutation({
  args: { repaymentId: v.id("personalRepayments") },
  returns: repaymentSummaryValidator,
  handler: async (ctx, { repaymentId }): Promise<RepaymentSummary> => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireFinanceManager(ctx, chapterId);
    const repayment = await ctx.db.get(repaymentId);
    await requireInChapter(ctx, chapterId, repayment, "Repayment");
    return toRepaymentSummary(await settleRepayment(ctx, repayment!));
  },
});

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

    const created = await ctx.runAction(internal.increase.createExternalAccount, {
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
    return toRepaymentSummary(
      await settleRepayment(ctx, repayment, args.increaseRef),
    );
  },
});

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
    !tr.receiptStorageId
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

// ── autoConvertOverdueReceipts (no-receipt → personal repayment) ─────────────

/**
 * The org-wide no-receipt auto-conversion sweep the daily cron calls — the
 * TERMINAL step past the day-1/day-3 receipt reminders and the day-7 auto-lock.
 *
 * Reads the org-wide deadline (`financeSettings.noReceiptAutoConvertDays` via
 * `readNoReceiptAutoConvertDays`). `null` (the default — central finance never
 * picked a number) → NO-OP. Otherwise every card charge still missing its
 * receipt PAST that many days is converted into a `pending` personal repayment
 * the cardholder owes back (via the shared `convertChargeToPersonalRepayment`,
 * so the flag/pay-back machinery is identical to a manual flag).
 *
 * Same age basis (`postedAt`) and eligibility predicate as the auto-lock sweep:
 * `isOverdueReceiptCharge`, which (since this WP excludes `isPersonal`) also
 * skips an already-converted charge — so a converted charge is never re-swept
 * and, critically, no longer keeps its card auto-locked. Bounded + idempotent
 * like the reminder sweep: at most `REMINDER_BATCH_LIMIT` conversions per run,
 * globally oldest-first, so a backlog drains gradually instead of converting
 * (and emailing) everyone in one burst. Each first-time conversion best-effort
 * emails the cardholder (scheduled, degrades without a Resend key).
 */
export const autoConvertOverdueReceipts = internalMutation({
  args: {},
  returns: v.object({ convertedCount: v.number() }),
  handler: async (ctx): Promise<{ convertedCount: number }> => {
    const days = await readNoReceiptAutoConvertDays(ctx);
    // Policy OFF (the default) — nothing auto-converts.
    if (days == null) return { convertedCount: 0 };
    const now = Date.now();
    const cutoff = now - days * DAY_MS;
    const cards = await ctx.db.query("cards").take(AUTOLOCK_LIMIT);

    // Gather every eligible charge across ALL cards first, so the batch cap
    // below picks the globally oldest — mirrors `advanceReceiptReminders`.
    const candidates: { tr: Doc<"transactions">; card: Doc<"cards"> }[] = [];
    for (const card of cards) {
      if (card.status === "canceled") continue;
      const txns = await ctx.db
        .query("transactions")
        .withIndex("by_card", (q) => q.eq("cardId", card._id))
        .order("desc")
        .take(CARD_TXN_LIMIT);
      for (const tr of txns) {
        if (isOverdueReceiptCharge(tr, card, cutoff)) {
          candidates.push({ tr, card });
        }
      }
    }
    candidates.sort((a, b) => a.tr.postedAt - b.tr.postedAt);
    const batch = candidates.slice(0, REMINDER_BATCH_LIMIT);

    let convertedCount = 0;
    for (const { tr, card } of batch) {
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
      });
    }
    return { convertedCount };
  },
});

// ── advanceReceiptReminders (day-1 flag / day-3 escalate) ────────────────────

/**
 * Advances the receipt-reminder TIMELINE for every card's missing-receipt
 * charges — the steps ahead of the terminal day-7 auto-lock above:
 *
 *  - a charge that's crossed one full day still missing its receipt, with no
 *    stage yet → `receiptReminderStage: "flagged"` (the "end of purchase day"
 *    nudge);
 *  - a charge that's crossed `RECEIPT_ESCALATE_DAYS` (3) still missing its
 *    receipt, not yet escalated → `receiptReminderStage: "escalated"`.
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
 * (`isPersonal`) are skipped entirely — the cardholder already flagged +
 * is repaying it, so a receipt nag on top is redundant.
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
    const flagCutoff = now - DAY_MS;
    const escalateCutoff = now - RECEIPT_ESCALATE_DAYS * DAY_MS;
    const seedOnlyCutoff = now - REMINDER_SEED_ONLY_DAYS * DAY_MS;
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
        if (!isMissingReceiptCharge(tr, card)) continue;
        // Personal charges are already flagged + being repaid by the
        // cardholder directly — don't pile a receipt-reminder nag on top.
        if (tr.isPersonal === true) continue;
        if (
          tr.postedAt < escalateCutoff &&
          tr.receiptReminderStage !== "escalated"
        ) {
          candidates.push({ tr, stage: "escalated" });
        } else if (
          tr.postedAt < flagCutoff &&
          tr.receiptReminderStage == null
        ) {
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

/** One line per missing-receipt charge in a cardholder's reminder digest. */
const reminderChargeValidator = v.object({
  amountCents: v.number(),
  merchantName: v.union(v.string(), v.null()),
  escalated: v.boolean(),
});

/**
 * Group the charges that transitioned a reminder stage THIS pass by cardholder,
 * so `sendReceiptReminders` sends ONE digest email per person listing all their
 * still-missing receipts — never one email per charge (a cardholder with five
 * un-receipted charges was getting five separate emails). A cardholder with no
 * reachable email is dropped. `flagged`/`escalated` are disjoint per pass; a
 * charge is tagged `escalated` when it hit the day-3 step.
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
    const escalatedSet = new Set(args.escalated.map((id) => id as string));
    const seen = new Set<string>();
    const byPerson = new Map<
      string,
      {
        email: string;
        cardholderName: string;
        charges: Array<{ amountCents: number; merchantName: string | null; escalated: boolean }>;
      }
    >();
    for (const txnId of [...args.flagged, ...args.escalated]) {
      if (seen.has(txnId as string)) continue;
      seen.add(txnId as string);
      const tr = await ctx.db.get(txnId);
      if (!tr?.cardId) continue;
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
      });
      byPerson.set(key, entry);
    }
    return [...byPerson.values()].map((e) => ({
      ...e,
      anyEscalated: e.charges.some((c) => c.escalated),
    }));
  },
});

/** Best-effort digest email for ONE cardholder listing all their charges still
 *  missing a receipt — logs + no-ops without `RESEND_API_KEY` (dev). */
async function notifyReceiptDigest(
  ctx: ActionCtx,
  digest: {
    email: string;
    cardholderName: string;
    anyEscalated: boolean;
    charges: Array<{ amountCents: number; merchantName: string | null; escalated: boolean }>;
  },
): Promise<void> {
  const count = digest.charges.length;
  if (count === 0) return;
  const fmt = (c: { amountCents: number; merchantName: string | null }) =>
    `$${(c.amountCents / 100).toFixed(2)} at ${c.merchantName ?? "a charge"}`;
  const subject =
    count === 1
      ? `${digest.anyEscalated ? "Still missing" : "Add"} a receipt for your ${fmt(digest.charges[0])}`
      : `${count} charges still need receipts`;
  const daysLeft = RECEIPT_GRACE_DAYS - RECEIPT_ESCALATE_DAYS;
  const intro =
    count === 1
      ? `You still need to add a receipt for your ${escapeHtml(fmt(digest.charges[0]))}.`
      : `You have ${count} card charges still missing receipts:`;
  const list =
    count === 1
      ? ""
      : `<ul style="margin:0 0 16px;padding-left:18px;font-family:-apple-system,'Segoe UI',Roboto,sans-serif;font-size:14px;line-height:1.7;color:#7A5A5A">${digest.charges
          .map(
            (c) =>
              `<li>${escapeHtml(fmt(c))}${c.escalated ? " — <b>locks soon</b>" : ""}</li>`,
          )
          .join("")}</ul>`;
  const lockNote = digest.anyEscalated
    ? `<p style="margin:0 0 16px;font-family:-apple-system,'Segoe UI',Roboto,sans-serif;font-size:14px;line-height:1.6;color:#7A5A5A">Add ${count === 1 ? "it" : "them"} soon — a charge still missing its receipt after ${RECEIPT_GRACE_DAYS} days locks your card (${daysLeft} more day${daysLeft === 1 ? "" : "s"} for the escalated one${count === 1 ? "" : "s"}).</p>`
    : "";
  // The bookkeeper's missing-receipt queue — same filter pill the Reconcile
  // grid's "Missing receipt" pill drives. Null (omitted) when APP_URL is unset.
  const link = appUrl("/finances/reconcile?filter=missing_receipt");
  await sendEmail(ctx, {
    to: digest.email,
    subject,
    html: emailShell(`
      <h1 style="margin:0 0 12px;font-size:24px;line-height:1.2">${escapeHtml(count === 1 ? subject : "Receipts still needed")}</h1>
      <p style="margin:0 0 ${count === 1 ? 16 : 8}px;font-family:-apple-system,'Segoe UI',Roboto,sans-serif;font-size:14px;line-height:1.6;color:#7A5A5A">Hi ${escapeHtml(digest.cardholderName)} — ${intro}</p>
      ${list}
      ${lockNote}
      ${
        link
          ? `<div style="font-family:-apple-system,'Segoe UI',Roboto,sans-serif;font-size:12px;font-weight:600"><a href="${link}" style="color:#fff;background:#D23B3A;text-decoration:none;border:1px solid #D23B3A;border-radius:999px;padding:6px 12px;display:inline-block">Add receipt${count === 1 ? "" : "s"} →</a></div>`
          : ""
      }`),
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

// ── Manual receipt nudge (Chase Receipts "Send reminder" / "Remind all") ────
//
// The tester-requested on-demand counterpart to the automated day-1/day-3
// digest above: an FM/Treasurer viewing `/finances/receipt-chase` can nudge
// ONE cardholder's group ("Send reminder") or every group at once ("Remind
// all") without waiting for the next cron pass. Reuses `notifyReceiptDigest`
// verbatim for the email (same subject/body shape the automated reminder
// sends) and adds a best-effort SMS pointing at the text-to-receipt number
// (`smsReceipts.ts`) — email is the required channel; SMS never blocks it.
//
// Manager-gated (`requireFinanceManager`, same floor as `lockCard`/
// `cancelCard`) and RATE-LIMITED to one nudge per cardholder per
// `MANUAL_NUDGE_WINDOW_MS` (24h) via `receiptNudgeAttempts` — the same
// checked-and-recorded-atomically pattern `beginRevealCardDetails` uses for
// its own rate limit, just with a "skip, don't error" outcome instead of a
// thrown `RATE_LIMITED`: a second click inside the window comes back
// `outcome:"already_nudged"` so the UI can show "Nudged today" instead of an
// error toast.

// Mirrors finances.ts's `ROLLUP_SCAN_LIMIT` (currently 5000) — duplicated as
// a literal rather than imported: finances.ts already imports several
// helpers FROM this file (`isMissingReceiptCharge` etc.), and importing back
// from it here would add a second edge to that same cycle. Keep in sync by
// hand if that constant's value ever changes.
const RECEIPT_NUDGE_SCAN_LIMIT = 5000;
// At most one manual nudge per cardholder per this window.
const MANUAL_NUDGE_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours
// A Chase Receipts page realistically has, at most, a few dozen cardholder
// groups — bounds the per-group nudge-status lookup defensively.
const CHASE_NUDGE_STATUS_LIMIT = 200;

/**
 * MIRRORS finances.ts's `txnMatchesMode` (line ~855) exactly — duplicated for
 * the same reason as `RECEIPT_NUDGE_SCAN_LIMIT` above (avoiding a fresh
 * cards.ts↔finances.ts import edge). Any change to the mode-matching rule
 * must be mirrored in both places.
 */
function chaseTxnMatchesMode(tr: Doc<"transactions">, sandboxMode: boolean): boolean {
  if (tr.source !== "increase_card" && tr.source !== "increase_ach") return true;
  return matchesMode(tr.externalId ?? tr.sourceAccountId ?? null, sandboxMode);
}

/**
 * MIRRORS finances.ts's `receiptChase`/`isSpend` "still owed a receipt"
 * predicate exactly (a SPEND charge — outflow, not excluded/personal — with
 * no receipt attached and not yet reconciled). Duplicated rather than
 * imported for the same reason as above; the two must be kept in sync.
 */
function isReceiptChaseOwing(tr: Doc<"transactions">): boolean {
  return (
    tr.flow === "outflow" &&
    tr.status !== "excluded" &&
    tr.isPersonal !== true &&
    tr.status !== "reconciled" &&
    tr.receiptStorageId == null
  );
}

/**
 * MIRRORS finances.ts's `makeCardholderResolver`: the txn's own `personId`,
 * else the person who owns its `cardId`. Duplicated rather than imported for
 * the same reason as the two helpers above.
 */
async function resolveChaseCardholderId(
  ctx: QueryCtx,
  tr: Doc<"transactions">,
): Promise<Id<"people"> | null> {
  if (tr.personId) return tr.personId;
  if (!tr.cardId) return null;
  const card = await ctx.db.get(tr.cardId);
  return card?.cardholderPersonId ?? null;
}

/** One cardholder's current missing-receipt bundle, resolved for a manual
 *  nudge — the SAME shape `getReceiptReminderDigests` builds for the
 *  automated digest, plus `personId`/`phone` so the caller can rate-limit and
 *  SMS. */
type ManualNudgeTarget = {
  personId: Id<"people">;
  email: string | null;
  phone: string | null;
  cardholderName: string;
  anyEscalated: boolean;
  charges: Array<{ amountCents: number; merchantName: string | null; escalated: boolean }>;
};

const manualNudgeTargetValidator = v.object({
  personId: v.id("people"),
  email: v.union(v.string(), v.null()),
  phone: v.union(v.string(), v.null()),
  cardholderName: v.string(),
  anyEscalated: v.boolean(),
  charges: v.array(reminderChargeValidator),
});

/**
 * Resolve who to nudge + what they currently owe: EVERY cardholder (or just
 * `personId`, when given) with at least one charge still missing a receipt
 * RIGHT NOW — the exact same "owing" set `finances.receiptChase` renders, so
 * a manual nudge can never disagree with the list the FM is looking at. The
 * "Unattributed" bucket (no resolvable cardholder) is silently skipped —
 * mirrors `receiptChase`'s own doc comment: there's no one to chase for it.
 *
 * `scope`/`chapterId` are the SAME pair `receiptChase` takes (#383) — a
 * manager nudging from a central/peeked-chapter Chase Receipts view must
 * nudge THAT scope's cardholders, never silently the caller's own chapter.
 * The branch structure below is `receiptChase`'s byte-for-byte, upgraded from
 * its viewer floor to a MANAGER floor at every branch (nudging is a write,
 * not a read) — `requireFinanceManager`/`requireCentralFinanceRole` resolve
 * the caller's role via their OWN home chapter (which already unions in any
 * central grant), never the peeked scope itself, exactly like
 * `receiptChase`'s `requireFinanceCentral(ctx, homeChapterId)` calls.
 *
 * Manager-gated. Internal — only `sendReceiptNudge` (the public action)
 * calls this.
 */
export const getManualNudgeTargets = internalQuery({
  args: {
    personId: v.optional(v.id("people")),
    scope: v.optional(v.literal("central")),
    chapterId: v.optional(v.id("chapters")),
  },
  returns: v.array(manualNudgeTargetValidator),
  handler: async (
    ctx,
    { personId, scope: scopeArg, chapterId: chapterIdArg },
  ): Promise<ManualNudgeTarget[]> => {
    const homeChapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    let scope: Id<"chapters"> | "central";
    if (scopeArg === "central") {
      await requireCentralFinanceRole(ctx, homeChapterId, "manager");
      scope = "central";
    } else if (chapterIdArg != null && chapterIdArg !== homeChapterId) {
      await requireCentralFinanceRole(ctx, homeChapterId, "manager");
      scope = chapterIdArg;
    } else {
      await requireFinanceManager(ctx, homeChapterId);
      scope = chapterIdArg ?? homeChapterId;
    }

    const sandboxMode = await readSandbox(ctx);
    const owing = (
      await ctx.db
        .query("transactions")
        .withIndex("by_chapter_and_postedAt", (q) => q.eq("chapterId", scope))
        .order("desc")
        .take(RECEIPT_NUDGE_SCAN_LIMIT)
    )
      .filter((tr) => chaseTxnMatchesMode(tr, sandboxMode))
      .filter(isReceiptChaseOwing);

    const byPerson = new Map<string, ManualNudgeTarget>();
    for (const tr of owing) {
      const holderId = await resolveChaseCardholderId(ctx, tr);
      if (!holderId) continue; // Unattributed — nobody to nudge.
      if (personId && holderId !== personId) continue;
      const key = holderId as string;
      let entry = byPerson.get(key);
      if (!entry) {
        const person = await ctx.db.get(holderId);
        if (!person) continue;
        entry = {
          personId: holderId,
          email: person.pwEmail ?? person.email ?? null,
          phone: person.phone ?? null,
          cardholderName: person.name,
          anyEscalated: false,
          charges: [],
        };
        byPerson.set(key, entry);
      }
      entry.charges.push({
        amountCents: tr.amountCents,
        merchantName: tr.merchantName ?? null,
        escalated: tr.receiptReminderStage === "escalated",
      });
    }
    return [...byPerson.values()].map((e) => ({
      ...e,
      anyEscalated: e.charges.some((c) => c.escalated),
    }));
  },
});

/**
 * Checks-and-records the manual-nudge rate limit ATOMICALLY for ONE
 * cardholder (same one-mutation check+insert shape as
 * `beginRevealCardDetails`'s own rate limiter): returns `true` (and inserts
 * the attempt row) iff no manual nudge was recorded for them in the last
 * `MANUAL_NUDGE_WINDOW_MS`; returns `false` (no insert) otherwise, so the
 * caller skips sending and reports `outcome:"already_nudged"` instead of
 * throwing. Re-asserts the manager gate itself (defense in depth — mirrors
 * every other `beginX` internal mutation in this file, e.g. `beginCancelCard`)
 * even though its only caller already checked via `getManualNudgeTargets`.
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

/** The Chase Receipts page's per-cardholder "already nudged" state: every
 *  `personId` (from `personIds`) currently inside its 24h manual-nudge
 *  window, with the timestamp of that nudge — lets the UI render "Nudged
 *  today" for a group without the caller having to attempt (and get told
 *  "already_nudged" by) `sendReceiptNudge` first. Manager-gated, same floor
 *  as the nudge action itself; bounded to a page's worth of groups. */
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

/** Best-effort SMS nudge pointing at the text-to-receipt number
 *  (`smsReceipts.ts`) — mirrors `replyToSmsSender`'s shape (no-op without
 *  Twilio configured, swallows its own failures, never throws). Returns
 *  whether it actually attempted (and didn't error on) a send. */
async function sendManualNudgeSms(
  ctx: ActionCtx,
  phone: string,
  charges: Array<{ amountCents: number; merchantName: string | null }>,
): Promise<boolean> {
  const creds = await resolveTwilioCredentials(ctx);
  if (!creds) return false;
  const to = normalizePhone(phone);
  if (!to) return false;

  const count = charges.length;
  const fmt = (c: { amountCents: number; merchantName: string | null }) =>
    `$${(c.amountCents / 100).toFixed(2)}${c.merchantName ? ` at ${c.merchantName}` : ""}`;
  const body =
    count === 1
      ? `Reminder: you still owe a receipt for ${fmt(charges[0])}. Reply here with a photo to file it.`
      : `Reminder: you still owe receipts for ${count} card charges (starting with ${fmt(charges[0])}). Reply here with a photo of each to file it.`;
  try {
    await sendSms(creds, { to, body });
    return true;
  } catch (err) {
    console.log(`[cards] sendReceiptNudge: SMS failed: ${String(err)}`);
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
});
type NudgeResult = typeof nudgeResultValidator.type;

/**
 * Manual, on-demand receipt nudge — the Chase Receipts page's "Send
 * reminder" (`personId` set, one cardholder) and "Remind all" (`personId`
 * omitted, every cardholder currently owing a receipt) buttons both call
 * this SAME action.
 *
 * Per target cardholder:
 *  1. Skip with `outcome:"no_email"` if they have no reachable email at all
 *     — email is the required channel (mirrors `getReceiptReminderDigests`
 *     dropping an unreachable cardholder from the automated digest); nothing
 *     is sent and the 24h rate-limit slot is NOT consumed.
 *  2. Otherwise check-and-record the 24h rate limit
 *     (`beginManualNudgeAttempt`); `outcome:"already_nudged"` (no send) if
 *     one was already recorded.
 *  3. Send the SAME digest email `notifyReceiptDigest` sends for the
 *     automated reminder (best-effort — a failed send still counts as
 *     "sent" for rate-limiting purposes, matching how the automated digest
 *     treats its own failures: logged, never thrown).
 *  4. Best-effort SMS if a phone is on file + Twilio resolves
 *     (`sendManualNudgeSms`) — never blocks or fails the email path.
 *
 * Manager-gated: `getManualNudgeTargets` (step 0) throws `FORBIDDEN` for a
 * non-manager caller before anything else runs. `scope`/`chapterId` are
 * forwarded straight through to it — the SAME pair the Chase Receipts page
 * passes to `finances.receiptChase` (#383), so a nudge from a central/
 * peeked-chapter view targets that scope, not the caller's own chapter.
 */
export const sendReceiptNudge = action({
  args: {
    personId: v.optional(v.id("people")),
    scope: v.optional(v.literal("central")),
    chapterId: v.optional(v.id("chapters")),
  },
  returns: v.object({ results: v.array(nudgeResultValidator) }),
  handler: async (ctx, { personId, scope, chapterId }): Promise<{ results: NudgeResult[] }> => {
    const targets: ManualNudgeTarget[] = await ctx.runQuery(
      internal.cards.getManualNudgeTargets,
      { personId, scope, chapterId },
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
        });
        continue;
      }

      let emailSent = false;
      try {
        await notifyReceiptDigest(ctx, {
          email: target.email,
          cardholderName: target.cardholderName,
          anyEscalated: target.anyEscalated,
          charges: target.charges,
        });
        emailSent = true;
      } catch (err) {
        console.error("[cards] sendReceiptNudge: email failed", target.email, err);
      }

      const smsSent = target.phone
        ? await sendManualNudgeSms(ctx, target.phone, target.charges)
        : false;

      results.push({
        personId: target.personId,
        cardholderName: target.cardholderName,
        outcome: "sent",
        emailSent,
        smsSent,
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
