/**
 * Cards — the native member-card layer for Chapter OS (Phase 5: person-owned
 * Increase cards + the real-time authorization decision + personal-charge
 * repayment).
 *
 * Cards are PERSON-OWNED: a card belongs to ONE `cardholderPersonId`, who owns
 * its receipts + reconciliation. There are only TWO hard controls — a monthly
 * safety cap (`monthlyCapCents`) and a validity window (`validFrom`/`validUntil`)
 * — plus the receipt auto-lock (a charge whose receipt is >7 days late locks the
 * card; a manager/cardholder unlock clears the grace window). Personal charges
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
  type CardType,
  type CardStatus,
  type CardSource,
  type CardRequestStatus,
  type RepaymentMethod,
  type RepaymentStatus,
} from "@events-os/shared";
import { readSandbox } from "./financeSettings";
import {
  requireChapterId,
  requireInChapter,
  getChapterIdOrNull,
} from "./lib/context";
import {
  requireFinanceRole,
  requireFinanceManager,
  getFinanceRole,
  getChapterAccountForMode,
} from "./lib/finance";
import { viewerPerson } from "./lib/org";
import {
  increaseEnvForObjectId,
  assertRoutingNumber,
  assertAccountNumber,
} from "./increase";
import { sendEmail, emailShell } from "./ticketingEmails";
import { escapeHtml } from "./lib/html";

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

    // Idempotent-ish: don't mint a second ACTIVE card for the same person.
    const existing = await ctx.db
      .query("cards")
      .withIndex("by_cardholder", (q) =>
        q.eq("cardholderPersonId", args.cardholderPersonId),
      )
      .take(CARD_SCAN_LIMIT);
    const activeSame = existing.find(
      (c) => c.chapterId === chapterId && c.status === "active",
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
  returns: v.array(cardSummaryValidator),
  handler: async (ctx): Promise<CardSummary[]> => {
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
    return Promise.all(cards.map((c) => buildCardSummary(ctx, c)));
  },
});

const myCardValidator = v.object({
  cards: v.array(cardSummaryValidator),
  // The caller's most recently issued CANCELED card, when they hold no live
  // (non-canceled) one — surfaced so the member view can explain WHY they're
  // looking at the request-a-card flow instead of just a bare "No card yet"
  // as if they'd never had one. Null the moment a live card exists again
  // (re-issued or otherwise) — see `myCard`'s doc comment.
  lastCanceled: v.union(cardSummaryValidator, v.null()),
});

/** The caller's own card(s) — the member card view. Any authed user; empty when
 *  they have no chapter / roster row yet.
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
    const chapterId = (await getChapterIdOrNull(ctx)) as Id<"chapters"> | null;
    if (!chapterId) return { cards: [], lastCanceled: null };
    const self = await viewerPerson(ctx, chapterId);
    if (!self) return { cards: [], lastCanceled: null };
    const sandboxMode = await readSandbox(ctx);
    const cards = await ctx.db
      .query("cards")
      .withIndex("by_cardholder", (q) => q.eq("cardholderPersonId", self._id))
      .take(CARD_SCAN_LIMIT);
    const inScope = cards.filter(
      (c) =>
        c.chapterId === chapterId &&
        // Same environment filter as listCards: hide cross-env cards.
        matchesMode(c.increaseCardId ?? null, sandboxMode),
    );

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
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    const access = await getFinanceRole(ctx, chapterId);
    const card = await requireOwnedCard(ctx, chapterId, cardId);
    const isHolder =
      access.personId != null && access.personId === card.cardholderPersonId;
    if (!isHolder) {
      throw new ConvexError({
        code: "FORBIDDEN",
        message: "Only the cardholder can freeze their own card.",
      });
    }
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
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    const access = await getFinanceRole(ctx, chapterId);
    const card = await requireOwnedCard(ctx, chapterId, cardId);
    const isHolder =
      access.personId != null && access.personId === card.cardholderPersonId;
    if (!isHolder) {
      throw new ConvexError({
        code: "FORBIDDEN",
        message: "Only the cardholder can unfreeze their own card.",
      });
    }
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

    const existingCards = await ctx.db
      .query("cards")
      .withIndex("by_cardholder", (q) => q.eq("cardholderPersonId", person._id))
      .take(CARD_SCAN_LIMIT);
    if (
      existingCards.some(
        (c) => c.chapterId === chapterId && c.status !== "canceled",
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
  returns: v.union(cardRequestSummaryValidator, v.null()),
  handler: async (ctx): Promise<CardRequestSummary | null> => {
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
    return toCardRequestSummary(ctx, latest);
  },
});

/** The chapter's OPEN (`"requested"`) card requests — the manager Cards
 *  view's pending-requests list. Viewer+ gated (same floor as `listCards`);
 *  only a finance manager can actually decide one (`decideCardRequest`). */
export const listCardRequests = query({
  args: {},
  returns: v.array(cardRequestSummaryValidator),
  handler: async (ctx): Promise<CardRequestSummary[]> => {
    const chapterId = (await getChapterIdOrNull(ctx)) as Id<"chapters"> | null;
    if (!chapterId) return [];
    await requireFinanceRole(ctx, chapterId, "viewer");
    const rows = await ctx.db
      .query("cardRequests")
      .withIndex("by_chapter_and_status", (q) =>
        q.eq("chapterId", chapterId).eq("status", "requested"),
      )
      .take(CARD_REQUEST_SCAN_LIMIT);
    return Promise.all(rows.map((r) => toCardRequestSummary(ctx, r)));
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

/**
 * The real-time card-authorization decision. The orchestrator's Increase
 * webhook (`card_authorization` / `real_time_decision`) calls this synchronously
 * and responds to Increase with the result. Looks the card up by
 * `increaseCardId`, decides against the two controls + lock state, and logs a
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
      const decision = decideAgainstCard(
        card,
        args.amountCents,
        monthAuthorizedCents,
        now,
      );

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

    // IDEMPOTENT: one repayment per transaction.
    const existing = await ctx.db
      .query("personalRepayments")
      .withIndex("by_transaction", (q) => q.eq("transactionId", transactionId))
      .first();
    if (existing) {
      if (transaction.isPersonal !== true || transaction.repaymentId == null) {
        await ctx.db.patch(transactionId, {
          isPersonal: true,
          repaymentId: existing._id,
        });
      }
      return toRepaymentSummary(existing);
    }

    const now = Date.now();
    const repaymentId = await ctx.db.insert("personalRepayments", {
      chapterId,
      transactionId,
      payerPersonId: cardholderPersonId,
      amountCents: transaction.amountCents,
      // The method is chosen when the payer initiates repayment; default until.
      method: "ach",
      status: "pending",
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.patch(transactionId, { isPersonal: true, repaymentId });

    // Manager flagging SOMEONE ELSE's charge → notify the cardholder. Scheduled
    // (not awaited) so a slow/failing Resend call never blocks the flag itself;
    // the action below is best-effort and degrades silently without a key.
    if (!isCardholder) {
      await ctx.scheduler.runAfter(0, internal.cards.notifyPersonalChargeFlagged, {
        repaymentId,
      });
    }

    return toRepaymentSummary((await ctx.db.get(repaymentId))!);
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
 *  no-ops without `RESEND_API_KEY` (same degrade as `notifyReceiptReminder`).
 *  Never throws past itself (it's a scheduled fire-and-forget job off the
 *  flagging mutation, so a Resend failure here must not surface anywhere). */
export const notifyPersonalChargeFlagged = internalAction({
  args: { repaymentId: v.id("personalRepayments") },
  handler: async (ctx, { repaymentId }) => {
    try {
      const contact = await ctx.runQuery(
        internal.cards.getPersonalChargeFlagContact,
        { repaymentId },
      );
      if (!contact) return null;
      const dollars = `$${(contact.amountCents / 100).toFixed(2)}`;
      const merchant = contact.merchantName ?? "a charge on your card";
      const subject = `A charge on your card was marked personal — you owe ${dollars}`;
      await sendEmail(
        contact.email,
        subject,
        emailShell(`
          <h1 style="margin:0 0 12px;font-size:24px;line-height:1.2">${escapeHtml(subject)}</h1>
          <p style="margin:0 0 16px;font-family:-apple-system,'Segoe UI',Roboto,sans-serif;font-size:14px;line-height:1.6;color:#7A5A5A">Hi ${escapeHtml(contact.cardholderName)} — a finance manager marked ${escapeHtml(merchant)} (${escapeHtml(dollars)}) as a personal charge. Pay it back from the Reimbursements tab in the app.</p>`),
      );
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

/** The cardholder contact + charge details `sendReceiptReminders` needs to
 *  compose a reminder email for one transaction. Null when the charge isn't
 *  card-linked or the cardholder has no reachable email. */
export const getReceiptReminderContact = internalQuery({
  args: { transactionId: v.id("transactions") },
  returns: v.union(
    v.object({
      email: v.string(),
      cardholderName: v.string(),
      merchantName: v.union(v.string(), v.null()),
      amountCents: v.number(),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const tr = await ctx.db.get(args.transactionId);
    if (!tr?.cardId) return null;
    const card = await ctx.db.get(tr.cardId);
    if (!card) return null;
    const person = await ctx.db.get(card.cardholderPersonId);
    const email = person?.pwEmail ?? person?.email;
    if (!person || !email) return null;
    return {
      email,
      cardholderName: person.name,
      merchantName: tr.merchantName ?? null,
      amountCents: tr.amountCents,
    };
  },
});

/** Best-effort reminder email for one transitioned charge — logs + no-ops
 *  without `RESEND_API_KEY` (dev), same degrade as `sendReimbursementReminders`. */
async function notifyReceiptReminder(
  ctx: ActionCtx,
  transactionId: Id<"transactions">,
  isEscalation: boolean,
): Promise<void> {
  const contact = await ctx.runQuery(internal.cards.getReceiptReminderContact, {
    transactionId,
  });
  if (!contact) return;
  const dollars = `$${(contact.amountCents / 100).toFixed(2)}`;
  const merchant = contact.merchantName ?? "a charge";
  const subject = isEscalation
    ? `Still missing: receipt for your ${dollars} charge at ${merchant}`
    : `Add a receipt for your ${dollars} charge at ${merchant}`;
  const daysLeft = RECEIPT_GRACE_DAYS - RECEIPT_ESCALATE_DAYS;
  const message = isEscalation
    ? `It's been ${RECEIPT_ESCALATE_DAYS} days and your ${dollars} charge at ${merchant} still needs a receipt. Your card locks in ${daysLeft} more day${daysLeft === 1 ? "" : "s"} without one.`
    : `Don't forget to add a receipt for your ${dollars} charge at ${merchant}.`;
  await sendEmail(
    contact.email,
    subject,
    emailShell(`
      <h1 style="margin:0 0 12px;font-size:24px;line-height:1.2">${escapeHtml(subject)}</h1>
      <p style="margin:0 0 16px;font-family:-apple-system,'Segoe UI',Roboto,sans-serif;font-size:14px;line-height:1.6;color:#7A5A5A">Hi ${escapeHtml(contact.cardholderName)} — ${escapeHtml(message)}</p>`),
  );
}

/**
 * The daily receipt-reminder cron: advances every card's missing-receipt
 * charges through the day-1/day-3 timeline (`advanceReceiptReminders`), then
 * emails the cardholder for whichever charges just transitioned. Terminal
 * day-7 locking stays in `autoLockOverdueCards` — this action never locks a
 * card. No-ops per email when `RESEND_API_KEY` is unset (local/dev).
 *
 * Best-effort per email: a single rejected `notifyReceiptReminder` (e.g. a
 * Resend fetch failure) is logged and does NOT stop the loop — otherwise one
 * bad email mid-run would silently drop every remaining cardholder's
 * reminder for the day.
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
    for (const transactionId of flagged) {
      try {
        await notifyReceiptReminder(ctx, transactionId, false);
      } catch (err) {
        console.error(
          "sendReceiptReminders: flag reminder email failed",
          transactionId,
          err,
        );
      }
    }
    for (const transactionId of escalated) {
      try {
        await notifyReceiptReminder(ctx, transactionId, true);
      } catch (err) {
        console.error(
          "sendReceiptReminders: escalation reminder email failed",
          transactionId,
          err,
        );
      }
    }
    return { flaggedCount: flagged.length, escalatedCount: escalated.length };
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
