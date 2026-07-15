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
 * Env: INCREASE_API_KEY.
 */
import {
  action,
  mutation,
  query,
  internalMutation,
  internalAction,
} from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import {
  CARD_TYPES,
  CARD_STATUSES,
  REPAYMENT_METHODS,
  REPAYMENT_STATUSES,
  RECEIPT_GRACE_DAYS,
  easternParts,
  type CardType,
  type CardStatus,
  type RepaymentMethod,
  type RepaymentStatus,
} from "@events-os/shared";
import {
  requireChapterId,
  requireInChapter,
  getChapterIdOrNull,
} from "./lib/context";
import {
  requireFinanceRole,
  requireFinanceManager,
  getFinanceRole,
} from "./lib/finance";
import { viewerPerson } from "./lib/org";

const INCREASE_API = "https://api.increase.com";

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

// ── Enum validators (built from the shared tuples) ───────────────────────────
const cardTypeValidator = v.union(...CARD_TYPES.map((t) => v.literal(t)));
const cardStatusValidator = v.union(...CARD_STATUSES.map((s) => v.literal(s)));
const repaymentMethodValidator = v.union(
  ...REPAYMENT_METHODS.map((m) => v.literal(m)),
);
const repaymentStatusValidator = v.union(
  ...REPAYMENT_STATUSES.map((s) => v.literal(s)),
);

// ── Read-shape validators (what the UI renders) ──────────────────────────────
const cardSummaryValidator = v.object({
  id: v.id("cards"),
  cardholderPersonId: v.id("people"),
  cardholderName: v.union(v.string(), v.null()),
  type: cardTypeValidator,
  last4: v.union(v.string(), v.null()),
  status: cardStatusValidator,
  monthlyCapCents: v.union(v.number(), v.null()),
  validFrom: v.union(v.number(), v.null()),
  validUntil: v.union(v.number(), v.null()),
  receiptGraceEndsAt: v.union(v.number(), v.null()),
  spentThisMonthCents: v.number(),
});

const repaymentSummaryValidator = v.object({
  id: v.id("personalRepayments"),
  transactionId: v.id("transactions"),
  payerPersonId: v.id("people"),
  amountCents: v.number(),
  method: repaymentMethodValidator,
  status: repaymentStatusValidator,
  creditTransactionId: v.union(v.id("transactions"), v.null()),
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
  status: CardStatus;
  monthlyCapCents: number | null;
  validFrom: number | null;
  validUntil: number | null;
  receiptGraceEndsAt: number | null;
  spentThisMonthCents: number;
}

interface RepaymentSummary {
  id: Id<"personalRepayments">;
  transactionId: Id<"transactions">;
  payerPersonId: Id<"people">;
  amountCents: number;
  method: RepaymentMethod;
  status: RepaymentStatus;
  creditTransactionId: Id<"transactions"> | null;
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
      // The payer's linked Increase external account (their funding source) the
      // repayment debit pulls from. Null today — the app hasn't collected the
      // payer's routing+account, so `canCharge` is gated off and this stays
      // unreachable. Plumbed so the debit `initiateRepayment` sends is addressed.
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
  };
}

// ── Raw Increase fetch helper (default runtime `fetch`, no SDK) ───────────────
/** POST JSON to the Increase API. Throws ConvexError on a non-2xx so the caller
 *  can log + degrade. */
async function increasePost(
  key: string,
  path: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${INCREASE_API}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
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
  path: string,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${INCREASE_API}${path}`, {
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
    status: card.status,
    monthlyCapCents: card.monthlyCapCents ?? null,
    validFrom: card.validFrom ?? null,
    validUntil: card.validUntil ?? null,
    receiptGraceEndsAt: card.receiptGraceEndsAt ?? null,
    spentThisMonthCents,
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

    const account = await ctx.db
      .query("increaseAccounts")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
      .first();
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

    const key = process.env.INCREASE_API_KEY;
    if (!key || !prep.increaseAccountId) {
      console.warn(
        "[cards] issueCard degraded: INCREASE_API_KEY / active account not configured — card created without an Increase card id",
      );
      return prep.card;
    }

    try {
      const card = await increasePost(key, "/cards", {
        account_id: prep.increaseAccountId,
        description: prep.description,
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
    const cards = await ctx.db
      .query("cards")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
      .take(CARD_SCAN_LIMIT);
    return Promise.all(cards.map((c) => buildCardSummary(ctx, c)));
  },
});

/** The caller's own card(s) — the member card view. Any authed user; empty when
 *  they have no chapter / roster row yet. */
export const myCard = query({
  args: {},
  returns: v.array(cardSummaryValidator),
  handler: async (ctx): Promise<CardSummary[]> => {
    const chapterId = (await getChapterIdOrNull(ctx)) as Id<"chapters"> | null;
    if (!chapterId) return [];
    const self = await viewerPerson(ctx, chapterId);
    if (!self) return [];
    const cards = await ctx.db
      .query("cards")
      .withIndex("by_cardholder", (q) => q.eq("cardholderPersonId", self._id))
      .take(CARD_SCAN_LIMIT);
    return Promise.all(
      cards
        .filter((c) => c.chapterId === chapterId)
        .map((c) => buildCardSummary(ctx, c)),
    );
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
 *  uploaded / the block is resolved). */
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
 * `decideCardAuthorization` is idempotent on it). DEGRADES to a logged no-op
 * (never throws) when `INCREASE_API_KEY` is unset or the fetch fails — Increase
 * then applies the account's configured default action on timeout.
 */
export const handleIncreaseRealTimeDecision = internalAction({
  args: { realTimeDecisionId: v.string() },
  returns: v.null(),
  handler: async (ctx, { realTimeDecisionId }) => {
    const key = process.env.INCREASE_API_KEY;
    if (!key) {
      console.warn(
        "[cards] real-time decision skipped: INCREASE_API_KEY not configured",
      );
      return null;
    }

    let rtd: Record<string, unknown>;
    try {
      rtd = await increaseGet(
        key,
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
    return toRepaymentSummary((await ctx.db.get(repaymentId))!);
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

// ── initiateRepayment (action, the payer) ────────────────────────────────────

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

    const account = await ctx.db
      .query("increaseAccounts")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
      .first();
    const increaseAccountId =
      account && account.onboardingStatus === "active" && account.increaseAccountId
        ? account.increaseAccountId
        : null;

    // TODO(repayment go-live): charging the payer's OWN debit/ACH needs their
    // external-account details (routing+account) linked at Increase — the app
    // hasn't collected them, so a real charge can't be addressed yet. Until then
    // `canCharge` stays false and repayments settle via `markRepaymentPaid`;
    // once linked, set `payerExternalAccountId` to the payer's external account.
    const payerExternalAccountId: string | null = null;
    const hasPayerFundingSource = !!payerExternalAccountId;
    const canCharge =
      !!process.env.INCREASE_API_KEY && !!increaseAccountId && hasPayerFundingSource;

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
    if (!prep.canCharge || !prep.payerExternalAccountId) {
      return prep.repayment; // degrade: leave pending (no funding source linked)
    }

    const key = process.env.INCREASE_API_KEY!;
    try {
      const charge = await increasePost(key, "/ach_transfers", {
        account_id: prep.increaseAccountId,
        // The payer's linked external account is the counterparty; a NEGATIVE
        // amount originates a DEBIT that PULLS the repayment into the chapter's
        // account.
        external_account_id: prep.payerExternalAccountId,
        amount: -prep.amountCents,
        // Increase requires a statement descriptor, max 10 characters.
        statement_descriptor: "Repayment",
      });
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

/** A card charge whose receipt is overdue: an outflow older than the grace
 *  window, with no attached receipt, not intentionally excluded/reconciled. */
function isOverdueReceiptCharge(
  tr: Doc<"transactions">,
  card: Doc<"cards">,
  cutoff: number,
): boolean {
  return (
    tr.chapterId === card.chapterId &&
    tr.flow === "outflow" &&
    tr.status !== "excluded" &&
    tr.status !== "reconciled" &&
    !tr.receiptStorageId &&
    tr.postedAt < cutoff
  );
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
 *    the stamp. Self-healing: uploading a receipt unlocks within a day.
 *
 * A MANUAL lock (`lockCard`, no `receiptGraceEndsAt`) is never auto-unlocked.
 * Bounded; returns how many cards it locked / unlocked.
 *
 * TODO: immediate unlock-on-receipt-upload via attachReceipt (finances.ts).
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
