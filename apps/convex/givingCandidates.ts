/**
 * Territories P7 — bank-credit ↔ gift matching (docs/plans/giving-territories.md
 * §D10).
 *
 * Some giving arrives as a direct bank credit (Zelle/wire straight to the
 * account) that never touches Stripe, so it never becomes a `gifts` row on its
 * own. The development team needs to SEE those credits ("possible external
 * gifts") and either confirm one into a real gift (linked to the transaction
 * as evidence) or dismiss it as not-a-gift. `transactions` stays the only
 * actuals ledger — the `gifts.transactionId` link is evidence, not money
 * movement, so nothing here ever double-counts a dollar.
 *
 * ## The exclusion rule (candidate = an inflow credit that ISN'T…)
 *
 *  1. **A card refund.** `cardId` set on the transaction means Increase (or the
 *     legacy sync) already attributed the credit to a specific card purchase —
 *     the owner's heuristic: "a credit WITH an associated card is a refund of a
 *     card purchase, NOT a gift."
 *  2. **A transfer-flow leg.** `flow !== "inflow"` drops every skim /
 *     launch_grant / settlement / reimbursement / repayment leg outright — by
 *     schema convention (see `schema/finances.ts`) every one of those sources is
 *     ALWAYS written `flow:"transfer"`, so the plain inflow filter already
 *     excludes the whole category; the `source` check below is a defensive
 *     second layer in case that convention ever drifts.
 *  3. **A provider lump-sum payout (Stripe or Givebutter).** Neither provider
 *     writes a dedicated `transactions.source` for "payout" today — Stripe
 *     proceeds and Givebutter deposits land in the ledger exactly like any
 *     other bank credit, via `stripe_fc` (Financial Connections sync of a
 *     legacy account) or `relay_csv` (a Relay monthly-statement import) — see
 *     `stripeFinance.ts#applyFcTransactions`/`applyRelayImport`. Both stash the
 *     bank's own statement text in `merchantName` (and `relay_csv` also in
 *     `description`). A lump payout's descriptor names its processor — the
 *     account literally can't NOT say "STRIPE" or "GIVEBUTTER" the way a
 *     person's Zelle/wire memo would — so `looksLikeProviderPayout` matches
 *     `merchantName`/`description` case-insensitively against those two
 *     markers. This is a description-convention heuristic (not a structural
 *     guarantee); it is deliberately narrow (two literal processor names, not a
 *     general "looks batchy" classifier) so a legitimately-named individual
 *     donor is never swept in by coincidence.
 *  4. **Already gift-linked.** A transaction with a row in `gifts.by_transaction`
 *     was already confirmed (possibly via a different call) — never re-offered.
 *  5. **Already dismissed.** A transaction with a row in
 *     `dismissedGiftCandidates.by_transaction` was already reviewed and judged
 *     not-a-gift — stays dismissed until someone deletes that row directly (no
 *     "un-dismiss" surface in v1; the dismissal is a durable decision).
 *
 * Bounded reads throughout (`.take`, never `.collect()`): the candidate window
 * is the last `CANDIDATE_WINDOW_DAYS` days of a scope's inflow transactions,
 * capped at `CANDIDATE_TXN_SCAN_LIMIT` rows before in-memory refinement — the
 * house pattern (`finances.ts#loadPeriodTxns`) for "no `.filter()` on an
 * index-backed query, but bounded in-memory refinement within a `.take()`
 * window is fine."
 */
import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { financeRoleAtLeast } from "@events-os/shared";
import {
  requireGivingManage,
  resolveGivingAccess,
  type GivingScope,
} from "./lib/givingAccess";
import { getFinanceRole } from "./lib/finance";
import { getChapterIdOrNull, requireUserId } from "./lib/context";
import {
  assertReceiptsBound,
  matchOrCreateDonor,
  recordGiftForDonor,
} from "./lib/givingDonors";
import { DONOR_KINDS, GIFT_METHODS } from "./schema/givingPlatform";

const scopeValidator = v.union(v.id("chapters"), v.literal("central"));
const donorKindValidator = v.union(...DONOR_KINDS.map((k) => v.literal(k)));
const giftMethodValidator = v.union(...GIFT_METHODS.map((m) => v.literal(m)));

/** How far back the candidate window looks — a "recent, actionable" list, not
 *  a historical archive (old unmatched credits are a bookkeeping backlog
 *  problem, not this screen's job). */
const CANDIDATE_WINDOW_DAYS = 90;
const CANDIDATE_WINDOW_MS = CANDIDATE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
/** Bounded read cap on the raw (pre-filter) window scan — mirrors
 *  `finances.ts#ROLLUP_SCAN_LIMIT`'s "generous but bounded" sizing for a
 *  single scope's transactions over a period. */
const CANDIDATE_TXN_SCAN_LIMIT = 2000;
/** Cap on how many surviving candidates a single call returns — the desk
 *  shows a short, actionable list, not every unmatched credit ever synced. */
const CANDIDATE_RESULT_LIMIT = 200;

/** The two settlement processors whose lump-sum bank deposits should NEVER
 *  surface as an individual donor's gift — see the module doc's rule #3. */
const PROVIDER_PAYOUT_MARKERS = ["stripe", "givebutter"];

/** Transfer-leg sources — belt-and-suspenders alongside the `flow` filter (see
 *  the module doc's rule #2). */
const TRANSFER_LEG_SOURCES = new Set([
  "skim",
  "launch_grant",
  "settlement",
  "reimbursement",
  "repayment",
]);

/** True iff a transaction's own description text names a settlement
 *  processor — the provider-lump-payout exclusion (rule #3). Case-insensitive,
 *  checks both `merchantName` (where the FC/Relay sync stashes the bank's
 *  descriptor) and `description` (Relay's reference field). */
function looksLikeProviderPayout(txn: Doc<"transactions">): boolean {
  const haystack = `${txn.merchantName ?? ""} ${txn.description ?? ""}`.toLowerCase();
  return PROVIDER_PAYOUT_MARKERS.some((marker) => haystack.includes(marker));
}

/** True iff a transaction still qualifies as an external-gift candidate on its
 *  own merits (rules #1–#3) — NOT the linked/dismissed checks (#4–#5), which
 *  need a DB read per candidate and are applied separately. Shared by the list
 *  query and `confirmExternalGift`'s revalidation. */
function isCandidateShaped(txn: Doc<"transactions">): boolean {
  if (txn.flow !== "inflow") return false;
  if (txn.cardId !== undefined) return false;
  if (TRANSFER_LEG_SOURCES.has(txn.source)) return false;
  if (looksLikeProviderPayout(txn)) return false;
  return true;
}

/**
 * Resolve whether the caller may READ candidate rows at `scope` — the dual
 * gate `territories.ts#prelaunchReadiness` uses: `giving.manage` at `scope`
 * (the normal write-capable desk user) OR central finance viewer rank,
 * resolved through the caller's own chapter (a finance auditor with no
 * giving seat at all still gets visibility into what the development team is
 * about to confirm as revenue). Neither hat → false (the caller throws
 * FORBIDDEN, mirroring every other gated read in `givingPlatform.ts`).
 */
async function canReadCandidates(
  ctx: QueryCtx,
  scope: GivingScope,
): Promise<boolean> {
  const giving = await resolveGivingAccess(ctx);
  if (giving.isSuperuser) return true;
  const givingManage =
    giving.centralManage ||
    (scope !== "central" && giving.manageChapters.has(scope));
  if (givingManage) return true;

  const ownChapterId = await getChapterIdOrNull(ctx);
  if (!ownChapterId) return false;
  const fin = await getFinanceRole(ctx, ownChapterId as Id<"chapters">);
  return fin.isCentral && financeRoleAtLeast(fin.role, "viewer");
}

const candidateRow = v.object({
  transactionId: v.id("transactions"),
  postedAt: v.number(),
  amountCents: v.number(),
  description: v.union(v.string(), v.null()),
  merchantName: v.union(v.string(), v.null()),
  source: v.string(),
  // Best-effort "which bank account did this land in" context, resolved from
  // the linked `legacyAccounts` row when the transaction carries one
  // (`stripe_fc`/`relay_csv` rows do; `manual` rows don't) — enough to
  // recognize the credit alongside its amount/date/description.
  accountLabel: v.union(v.string(), v.null()),
});

/**
 * Recent inflow credits that LOOK like external giving — the candidate list
 * the development desk works through (confirm into a gift, or dismiss).
 * Gated by `canReadCandidates` (dual gate, see its doc); throws FORBIDDEN for
 * anyone else, matching every other gated read in `givingPlatform.ts`.
 *
 * Bounded read: the last `CANDIDATE_WINDOW_DAYS` days of `scope`'s
 * transactions via `by_chapter_and_postedAt` (capped at
 * `CANDIDATE_TXN_SCAN_LIMIT`), then in-memory refinement (the house pattern —
 * no index exists for "inflow AND no card AND not a known payout description",
 * so the cheap `isCandidateShaped` filters run first, and only the survivors
 * pay for a `gifts.by_transaction` + `dismissedGiftCandidates.by_transaction`
 * lookup each). Newest first; capped at `CANDIDATE_RESULT_LIMIT`.
 */
export const candidateExternalGifts = query({
  args: { scope: scopeValidator },
  returns: v.array(candidateRow),
  handler: async (ctx, { scope }) => {
    const givingScope = scope as GivingScope;
    if (!(await canReadCandidates(ctx, givingScope))) {
      throw new ConvexError({
        code: "FORBIDDEN",
        message:
          "You don't have access to possible-gift candidates for this scope.",
      });
    }

    const cutoff = Date.now() - CANDIDATE_WINDOW_MS;
    const window = await ctx.db
      .query("transactions")
      .withIndex("by_chapter_and_postedAt", (q) =>
        q.eq("chapterId", scope).gte("postedAt", cutoff),
      )
      .order("desc")
      .take(CANDIDATE_TXN_SCAN_LIMIT);

    const out: Array<typeof candidateRow.type> = [];
    for (const txn of window) {
      if (out.length >= CANDIDATE_RESULT_LIMIT) break;
      if (!isCandidateShaped(txn)) continue;

      const linked = await ctx.db
        .query("gifts")
        .withIndex("by_transaction", (q) => q.eq("transactionId", txn._id))
        .first();
      if (linked) continue;

      const dismissed = await ctx.db
        .query("dismissedGiftCandidates")
        .withIndex("by_transaction", (q) => q.eq("transactionId", txn._id))
        .first();
      if (dismissed) continue;

      let accountLabel: string | null = null;
      if (txn.sourceAccountId) {
        const account = await ctx.db
          .query("legacyAccounts")
          .withIndex("by_stripe_fc_account", (q) =>
            q.eq("stripeFcAccountId", txn.sourceAccountId as string),
          )
          .first();
        accountLabel =
          account?.institutionName ??
          (account?.last4 ? `Account ···${account.last4}` : null);
      }

      out.push({
        transactionId: txn._id,
        postedAt: txn.postedAt,
        amountCents: txn.amountCents,
        description: txn.description ?? null,
        merchantName: txn.merchantName ?? null,
        source: txn.source,
        accountLabel,
      });
    }
    return out;
  },
});

const newDonorValidator = v.object({
  name: v.string(),
  email: v.optional(v.string()),
  phone: v.optional(v.string()),
  kind: v.optional(donorKindValidator),
});

/** The default gift source for a confirmed bank-credit candidate — direct
 *  transfers into the account are overwhelmingly Zelle in practice; the
 *  confirm form lets a manager pick `wire` (or any other source) instead. */
const DEFAULT_EXTERNAL_GIFT_METHOD = "zelle" as const;

/**
 * Confirm a candidate transaction into a real gift: match-or-create the donor,
 * then record the gift via the shared `recordGiftForDonor` primitive with
 * `transactionId` set (the evidence link) and amount/date taken from the
 * TRANSACTION, never the client. Manage-gated at the transaction's own scope
 * (`chapterId`).
 *
 * Revalidates the transaction still qualifies (`isCandidateShaped` — inflow,
 * no card, not a transfer leg/provider payout) and is still unlinked
 * (idempotency: a transaction already carrying a `gifts.by_transaction` row
 * throws `ALREADY_CONFIRMED` rather than minting a second gift for the same
 * dollar — a retry/double-tap is a safe no-op-with-explanation, not a
 * double-count).
 */
export const confirmExternalGift = mutation({
  args: {
    transactionId: v.id("transactions"),
    donorId: v.optional(v.id("donors")),
    newDonor: v.optional(newDonorValidator),
    method: v.optional(giftMethodValidator),
    note: v.optional(v.string()),
    receiptStorageIds: v.optional(v.array(v.id("_storage"))),
  },
  returns: v.id("gifts"),
  handler: async (ctx, args) => {
    const txn = await ctx.db.get(args.transactionId);
    if (!txn) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Transaction not found.",
      });
    }
    const scope = txn.chapterId as GivingScope;
    await requireGivingManage(ctx, scope);

    if (!isCandidateShaped(txn)) {
      throw new ConvexError({
        code: "NOT_A_CANDIDATE",
        message:
          "This transaction no longer qualifies as a possible gift (it's a card refund, a transfer, or a provider payout).",
      });
    }
    const alreadyLinked = await ctx.db
      .query("gifts")
      .withIndex("by_transaction", (q) => q.eq("transactionId", txn._id))
      .first();
    if (alreadyLinked) {
      throw new ConvexError({
        code: "ALREADY_CONFIRMED",
        message: "This transaction is already linked to a gift.",
      });
    }
    assertReceiptsBound(args.receiptStorageIds);

    if (!args.donorId && !args.newDonor) {
      throw new ConvexError({
        code: "INVALID_INPUT",
        message: "Pick an existing donor or provide a new donor's name.",
      });
    }

    const userId = (await requireUserId(ctx)) as Id<"users">;

    let donorId: Id<"donors">;
    if (args.donorId) {
      const donor = await ctx.db.get(args.donorId);
      if (!donor || donor.scope !== scope) {
        throw new ConvexError({
          code: "NOT_FOUND",
          message: "That donor isn't in this scope.",
        });
      }
      donorId = args.donorId;
    } else {
      const nd = args.newDonor!;
      donorId = await matchOrCreateDonor(ctx, {
        scope,
        name: nd.name,
        email: nd.email,
        kind: nd.kind,
        source: "manual",
      });
    }

    return await recordGiftForDonor(ctx, {
      donorId,
      amountCents: txn.amountCents,
      receivedAt: txn.postedAt,
      method: args.method ?? DEFAULT_EXTERNAL_GIFT_METHOD,
      note: args.note?.trim() || undefined,
      receiptStorageIds: args.receiptStorageIds,
      recordedBy: userId,
      transactionId: txn._id,
    });
  },
});

/**
 * Dismiss a candidate transaction — a human decision that it's NOT a gift
 * (an unrecognized deposit, a refund the heuristic missed, a payout the
 * description didn't match). Manage-gated at the transaction's own scope.
 * Idempotent: a second dismiss of the same transaction no-ops rather than
 * inserting a duplicate row (mirrors `dualWriteGiftForDonation`'s idempotency
 * shape).
 */
export const dismissGiftCandidate = mutation({
  args: { transactionId: v.id("transactions") },
  returns: v.null(),
  handler: async (ctx, { transactionId }) => {
    const txn = await ctx.db.get(transactionId);
    if (!txn) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Transaction not found.",
      });
    }
    await requireGivingManage(ctx, txn.chapterId as GivingScope);

    const existing = await ctx.db
      .query("dismissedGiftCandidates")
      .withIndex("by_transaction", (q) => q.eq("transactionId", transactionId))
      .first();
    if (existing) return null; // already dismissed — idempotent no-op

    const userId = (await requireUserId(ctx)) as Id<"users">;
    await ctx.db.insert("dismissedGiftCandidates", {
      transactionId,
      dismissedBy: userId,
      dismissedAt: Date.now(),
    });
    return null;
  },
});
