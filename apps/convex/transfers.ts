/**
 * Central↔chapter money movement — ONE generic manual transfer.
 *
 * HISTORY. This file used to run three near-identical, semi-automated money
 * flows: WP-4.1 the monthly ~15% SKIM (chapter → central City Launch Fund),
 * WP-4.2 a one-time LAUNCH GRANT (central → a new chapter, which also
 * stamped a launch budget on it), and WP-4.5 a SETTLEMENT (either direction,
 * true-ing up the cash imbalance `interScopeBalances` computes). Each had its
 * own `record*` mutation, `prepare*`/`*FromIncrease` internal mutations, and
 * an `initiate*` action that could fire a REAL Increase account-to-account
 * transfer.
 *
 * RETIRED (founder decision, 2026-07-26): "Remove the whole skim concept for
 * now — while it is the desired state, we just have 1 chapter and not a lot
 * of backers, it feels unnecessarily complex, and when we do want to do it,
 * it could be just a manual transfer." Told to choose, the founder collapsed
 * ALL THREE variants into the one `recordTransfer` mutation below, and kept
 * the donor-facing give-page language (the 15% promise) exactly as-is — see
 * `packages/shared/src/finance.ts`'s `CENTRAL_SKIM_PCT` doc comment and
 * `lib/givePage.ts` / `lib/givePageSections.ts`, UNCHANGED by this PR.
 *
 * The Increase auto-initiate ACTIONS (`initiateSkimTransfer`,
 * `initiateLaunchGrant`, `initiateSettlementTransfer`) and their
 * `prepare*`/`*FromIncrease` internal-mutation plumbing are DELETED, not
 * just unused — they were never webhook-reachable (checked `http.ts` and
 * `increase.ts`'s webhook routing: neither the Increase webhook handler nor
 * any cron ever called into this file), only client-invoked from the mobile
 * `TransferRecordModal`. So deleting them removes a code path, not a live
 * integration. `stampLaunchBudget` (auto-creating a launch chapter's budget
 * the moment a grant was recorded) is deleted with the launch-grant kind
 * that triggered it — a chapter's launch budgets are now created the normal
 * manual way, same as any other budget.
 *
 * `transactions.source` KEEPS the historical `"skim"`/`"launch_grant"`/
 * `"settlement"` literals (see `packages/shared/src/finance.ts`) so old prod
 * rows still validate — nothing is migrated or rewritten. Every NEW transfer
 * writes `source:"transfer"` instead; `interScopeBalances` (below) nets both
 * the historical and the new source the same way, so old settlement history
 * and new manual transfers combine into one honest balance.
 *
 * LEDGER MODEL (unchanged). Every transfer is still a PAIR of
 * `flow:"transfer"` transactions — an outflow leg on the source scope + an
 * inflow leg on the destination scope — linked by a shared
 * `transactions.transferGroupId`, booked by the same `recordTransferPair`
 * helper as before. `transferDirection` (`"central_to_chapter"` |
 * `"chapter_to_central"`) names which way the pair moved — the exact same
 * field WP-4.5's settlement used, just now the ONLY way any transfer states
 * its direction (a skim/launch-grant used to leave it unset, since their
 * direction was implied by kind; a generic transfer always sets it).
 * Transfers never count as spend (`countsAsSpend`), so no budget/category
 * rollup is distorted.
 *
 * TRANSFER GROUP ID. The old kinds each had a natural deterministic key —
 * `skim-<chapter>-<yyyy>-<mm>` (one per month), `launch-<chapter>` (one per
 * chapter, ever), `settle-<chapter>-<yyyy>-<mm>` (one per month) — which
 * doubled as BOTH the Increase Idempotency-Key and the "don't record the
 * same period twice" guard. A generic manual transfer has no such natural
 * key: a treasurer can record as many of them as they like, any day, for any
 * reason (the skim commitment, a settlement, a launch grant, or anything
 * else — the free-text `note` says why). So `genericTransferGroupId` below
 * is EXPLICIT-AND-RANDOM instead of deterministic: `transfer-<chapterId>-
 * <postedAt-ms>-<8 hex chars>`. The chapter + timestamp keep it
 * human-scannable in a raw table dump (which chapter, roughly when); the
 * random suffix (`crypto.randomUUID()`, already used this way for
 * `reimbursements.ts`'s token) makes it collision-safe without a natural key
 * to hang determinism on. `recordTransferPair`'s `ALREADY_RECORDED` guard
 * still runs (defense in depth against a genuine collision), but it's no
 * longer the mechanism preventing a double-record of "this month's X" — that
 * concept doesn't exist anymore; every transfer is its own independent,
 * explicitly-dated event, so recording two transfers for the same chapter on
 * the same day is normal, not a duplicate.
 *
 * GATING IS DIRECTIONAL — see `recordTransfer`'s own doc comment. Collapsing
 * three mutations into one must not quietly weaken the strongest control any
 * of them had, so money ARRIVING at central (`chapter_to_central`) needs
 * central bookkeeper+ as the skim/settlement always did, while money LEAVING
 * central (`central_to_chapter`) still needs central ED/FM — preserving the
 * launch grant's #149 gate even though the launch-grant KIND is gone.
 */
import { mutation, query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { Doc, Id } from "./_generated/dataModel";
import {
  CENTRAL,
  easternParts,
  matchesMode,
} from "@events-os/shared";
import { requireChapterId, requireUserId } from "./lib/context";
import {
  requireCentralEdOrFm,
  requireCentralFinanceRole,
  getChapterAccountForMode,
} from "./lib/finance";
import {
  TRANSFER_DIRECTIONS,
  assertPositiveCents,
  recordTransferPair,
  transferScopes,
  type TransferDirection,
} from "./lib/transferPair";
import { readSandbox } from "./financeSettings";
import { ROLLUP_SCAN_LIMIT, isSpend, inPeriod, txnMatchesMode } from "./finances";

// ── The pair machinery lives in `lib/transferPair.ts` ────────────────────────
// (factored out so `finances.ts` — which this file imports from — and
// `reconciliation.ts` can book pairs through the same choke point without an
// import cycle). This file re-exports the pieces its own consumers use.
export {
  recordTransferPair,
  transferScopes,
  transferPairLegs,
  type TransferDirection,
} from "./lib/transferPair";

/** `postedAt` must be a real epoch-ms timestamp — the caller states the date
 *  the money actually moved (it can be in the past; this is a truth record
 *  for a movement that already happened outside the app). */
function assertValidPostedAt(postedAt: number): void {
  if (!Number.isFinite(postedAt) || postedAt <= 0) {
    throw new ConvexError({
      code: "INVALID_PERIOD",
      message: "Posted date must be a valid date.",
    });
  }
}

/** Assert a client-supplied chapter id points at a real, existing chapter (a
 *  transfer's chapter-side counterpart is always a real chapter, never the
 *  central sentinel). */
async function loadRealChapter(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
): Promise<Doc<"chapters">> {
  const chapter = await ctx.db.get(chapterId);
  if (!chapter) {
    throw new ConvexError({ code: "NOT_FOUND", message: "Chapter not found." });
  }
  return chapter;
}

// ── Return validators ────────────────────────────────────────────────────────

const recordResult = v.object({
  outflowId: v.id("transactions"),
  inflowId: v.id("transactions"),
  amountCents: v.number(),
  transferGroupId: v.string(),
});

// ── The generic manual transfer ───────────────────────────────────────────────

const transferDirectionValidator = v.union(
  ...TRANSFER_DIRECTIONS.map((d) => v.literal(d)),
);

const transferArgs = {
  direction: transferDirectionValidator,
  chapterId: v.id("chapters"),
  amountCents: v.number(),
  // The date the money actually moved (epoch ms) — this mutation records a
  // movement that already happened outside the app, so the caller states
  // when, not "now" implicitly.
  postedAt: v.number(),
  note: v.optional(v.string()),
};

/** See this file's header comment for the collision-safety rationale. */
function genericTransferGroupId(
  chapterId: Id<"chapters">,
  postedAt: number,
): string {
  return `transfer-${chapterId}-${postedAt}-${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * Record a manual central↔chapter transfer for money that moved OUTSIDE the
 * app — the one entry point that replaces the retired skim/launch-grant/
 * settlement mutations. Books the ledger pair (an outflow leg on whichever
 * scope `direction` says paid, an inflow leg on the other) exactly like those
 * did; the `note` is where "what this was for" (the skim commitment, a launch
 * grant, a settlement, or anything else) lives now, since the app itself no
 * longer distinguishes those reasons structurally.
 *
 * GATING IS DIRECTIONAL, and deliberately so. Collapsing three mutations into
 * one must not quietly weaken the strongest control any of them had. The
 * retired launch grant (central → chapter — the single largest movement in
 * the system, a new city's ~$7,800–8,300 equipment + training cost) was
 * gated on `requireCentralEdOrFm` (#149, PRD seat table §0.2); the skim and
 * settlement were bookkeeper+. A flat bookkeeper+ gate here would have let a
 * central bookkeeper move money OUT of central on their own, which no retired
 * variant allowed. So:
 *   - `chapter_to_central` (money arriving at central — the skim commitment,
 *     a chapter-owes-central settlement): central bookkeeper+, as before.
 *   - `central_to_chapter` (money LEAVING central — a launch grant, a
 *     central-owes-chapter settlement): central ED/FM, preserving #149.
 * One mutation, one form, one ledger shape — the seat requirement is the only
 * thing that varies, and it varies with which way the money actually moves.
 */
export const recordTransfer = mutation({
  args: transferArgs,
  returns: recordResult,
  handler: async (ctx, args) => {
    const home = (await requireChapterId(ctx)) as Id<"chapters">;
    if (args.direction === "central_to_chapter") {
      await requireCentralEdOrFm(
        ctx,
        "Moving money out of central requires the Executive Director or Financial Manager.",
      );
    } else {
      await requireCentralFinanceRole(ctx, home, "bookkeeper");
    }
    const userId = (await requireUserId(ctx)) as Id<"users">;
    assertPositiveCents(args.amountCents);
    assertValidPostedAt(args.postedAt);
    await loadRealChapter(ctx, args.chapterId);
    const { sourceScope, destScope } = transferScopes(
      args.chapterId,
      args.direction,
    );
    const transferGroupId = genericTransferGroupId(args.chapterId, args.postedAt);
    const pair = await recordTransferPair(ctx, {
      sourceScope,
      destScope,
      amountCents: args.amountCents,
      transferGroupId,
      postedAt: args.postedAt,
      note: args.note,
      transferDirection: args.direction,
      userId,
    });
    return { ...pair, amountCents: args.amountCents, transferGroupId };
  },
});

// ── Inter-scope balances (the "why do we owe each other money" read) ─────────

const interScopeBalanceRow = v.object({
  chapterId: v.id("chapters"),
  chapterName: v.string(),
  // Ledger-derived, ALL-TIME net owed between central and this chapter, net
  // of every settling transfer already recorded. Positive = CENTRAL owes the
  // chapter; negative = the CHAPTER owes central (display `Math.abs`).
  netCents: v.number(),
  // Same computation, narrowed to the given {year, month} only (not
  // cumulative) — "how much moved this month."
  periodNetCents: v.number(),
});

/**
 * The net cash imbalance between central and each chapter, created by
 * cross-scope BUDGET attribution on account-scoped CARDS. Owner policy: "Your
 * card determines whose account paid; reconcile determines whose budget it
 * was; Central settles the difference." A treasurer settles it by recording a
 * generic `recordTransfer` in whichever direction pays it down.
 *
 * Two directions, summed all-time then netted against recorded transfers:
 *
 *  (a) CENTRAL OWES CHAPTER: a txn OWNED by a real chapter (its card/account
 *      paid) whose `budgetId` resolves to a CENTRAL budget — the chapter
 *      fronted money for a central line item. This is the common case and
 *      mirrors `dashboardChapter`'s existing `centralLinkedCents` split
 *      (WP-0.1) — same rule, summed all-time instead of one dashboard period.
 *
 *  (b) CHAPTER OWES CENTRAL: a txn OWNED by central whose `budgetId` resolves
 *      to a CHAPTER budget — central fronted money for a chapter's line item.
 *      NOW LIVE (2026-08-05, founder request: "if I spent something using a
 *      public worship card, if it's attached to a local budget it's part of
 *      the local book, and then we can calculate in the backend what transfers
 *      need to be made"). `categorizeTransaction` and
 *      `createManualTransaction`'s central path route the budget through
 *      `finances.ts#requireBudgetForCentralTxn`, which admits a chapter budget
 *      behind `requireCrossBookAttribution` (`lib/finance.ts`).
 *
 *      This term was previously ALWAYS 0 — the old gate
 *      (`requireInCallerChapter(ctx, CENTRAL, "budgets", …, { allowCentral:
 *      true })`) only ever admitted a budget whose own `chapterId` was also
 *      CENTRAL. It was computed generically here anyway rather than assumed
 *      zero, precisely so the balance would stay correct if that restriction
 *      were ever relaxed. It has been, and this query needed NO math change:
 *      the direction simply started producing rows.
 *
 * SETTLED LEGS ALREADY RECORDED are netted out. `source:"transfer"` (every
 * NEW transfer) and the historical `source:"settlement"` (rows written
 * before the 2026-07-26 collapse) are BOTH treated as a settling leg here —
 * a chapter's card fronting central money and a chapter later paying central
 * back are the same kind of ledger fact whether the row that pays it down
 * calls itself a "settlement" or a plain "transfer". Both legs of a pair
 * share `flow:"transfer"` (excluded from spend, like every transfer leg), so
 * the pair's `transferDirection` field is what distinguishes it:
 * `"central_to_chapter"` means central paid THIS chapter (pays down (a));
 * `"chapter_to_central"` means this chapter paid central (pays down (b)).
 * `netCents = (a - settled_a) - (b - settled_b)`.
 *
 * CONSENT SEMANTICS (revised 2026-08-07, owner request — "instead of
 * surfacing that transfers need to be made, the engine does the necessary
 * internal transfers"): the morning reconciliation engine
 * (`reconciliation.ts#runAutoSettlement`) now books an `auto_settlement`
 * transfer pair daily for any nonzero net, so this balance normally reads 0
 * by morning and the settlement history is the audit trail. The query itself
 * is unchanged: still a pure ledger read, no accrual write, no separate
 * balances table — the engine just became one more writer of settling legs
 * (which the FM can flag and offset, exactly like a manual one). Pausing the
 * engine restores the old visible-but-unsettled behavior.
 *
 * Mode-filtered like the City Launch Fund position (#163's IMPORTANT-1 fix):
 * the underlying card/ACH spend is filtered via `txnMatchesMode`, and a
 * settling leg's `externalId` via `matchesMode` — every NEW transfer leg has
 * no `externalId` (there's no more Increase auto-initiate path — see this
 * file's header comment), so it's env-neutral and counts in both modes; a
 * HISTORICAL real-movement settlement leg keeps working exactly as before.
 *
 * Gate: central VIEWER+ reach (a read, not a write) — a chapter manager with
 * no central grant is FORBIDDEN.
 *
 * The per-chapter row-computing logic below is factored into
 * `loadInterScopeContext` / `loadChapterOwesCentralRows` / `chapterInterScopeRows`
 * so `interScopeBalanceContributors` (dashboard-drilldown work) can show the
 * exact transactions/settling legs behind a chapter's `netCents` without
 * re-deriving the same predicates — see those helpers' own doc comments.
 */
export const interScopeBalances = query({
  args: { year: v.optional(v.number()), month: v.optional(v.number()) },
  returns: v.array(interScopeBalanceRow),
  handler: async (ctx, args) => {
    const home = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireCentralFinanceRole(ctx, home, "viewer");
    const now = easternParts(Date.now());
    const year = args.year ?? now.year;
    const month = args.month ?? now.month;
    const sandboxMode = await readSandbox(ctx);

    const { centralBudgetIds, chapters } = await loadInterScopeContext(ctx);
    const chapterOwesCentralRowsByChapter = await loadChapterOwesCentralRows(
      ctx,
      centralBudgetIds,
      sandboxMode,
    );

    const rows: (typeof interScopeBalanceRow.type)[] = [];
    for (const chapter of chapters) {
      const chapterTxns = await ctx.db
        .query("transactions")
        .withIndex("by_chapter", (q) => q.eq("chapterId", chapter._id))
        .take(ROLLUP_SCAN_LIMIT);
      if (chapterTxns.length === ROLLUP_SCAN_LIMIT) {
        console.warn(
          `[transfers] interScopeBalances hit ROLLUP_SCAN_LIMIT (${ROLLUP_SCAN_LIMIT}) reading transactions for chapter ${chapter._id}; balance truncated.`,
        );
      }
      const grouped = chapterInterScopeRows(
        chapterTxns,
        centralBudgetIds,
        chapterOwesCentralRowsByChapter.get(chapter._id) ?? [],
        sandboxMode,
      );

      const netCents =
        sumAllCents(grouped.centralOwesChapterRows) -
        sumAllCents(grouped.settledCentralToChapterRows) -
        (sumAllCents(grouped.chapterOwesCentralRows) -
          sumAllCents(grouped.settledChapterToCentralRows));
      const periodNetCents =
        sumInPeriodCents(grouped.centralOwesChapterRows, year, month) -
        sumInPeriodCents(grouped.settledCentralToChapterRows, year, month) -
        (sumInPeriodCents(grouped.chapterOwesCentralRows, year, month) -
          sumInPeriodCents(grouped.settledChapterToCentralRows, year, month));

      rows.push({
        chapterId: chapter._id,
        chapterName: chapter.name,
        netCents,
        periodNetCents,
      });
    }
    return rows;
  },
});

// ── WP-dashboard-drill: `interScopeBalances`' shared row-computing helpers ──

/** Direction (a)'s target set (every CENTRAL budget, any year) + every ACTIVE
 *  chapter (shadow/pre-launch territory rows excluded — see
 *  `lib/chapters.ts#listActiveChapters`) — the context both
 *  `interScopeBalances` and `interScopeBalanceContributors` need before they
 *  can compute anything. Inlines the same `isActive !== false` filter
 *  `listActiveChapters` applies (rather than calling it directly) because the
 *  truncation warning needs the RAW pre-filter scan length. */
export async function loadInterScopeContext(
  ctx: QueryCtx,
): Promise<{ centralBudgetIds: Set<Id<"budgets">>; chapters: Doc<"chapters">[] }> {
  const centralBudgetDocs = await ctx.db
    .query("budgets")
    .withIndex("by_chapter", (q) => q.eq("chapterId", CENTRAL))
    .take(ROLLUP_SCAN_LIMIT);
  if (centralBudgetDocs.length === ROLLUP_SCAN_LIMIT) {
    console.warn(
      `[transfers] interScopeBalances hit ROLLUP_SCAN_LIMIT (${ROLLUP_SCAN_LIMIT}) reading central budgets; direction (a) target set truncated.`,
    );
  }
  const rawChapters = await ctx.db.query("chapters").take(ROLLUP_SCAN_LIMIT);
  if (rawChapters.length === ROLLUP_SCAN_LIMIT) {
    console.warn(
      `[transfers] interScopeBalances hit ROLLUP_SCAN_LIMIT (${ROLLUP_SCAN_LIMIT}) reading chapters; result rows truncated.`,
    );
  }
  const chapters = rawChapters.filter((c) => c.isActive !== false);
  return { centralBudgetIds: new Set(centralBudgetDocs.map((b) => b._id)), chapters };
}

/** Direction (b)'s raw rows (see `interScopeBalances`' doc comment — verified
 *  unattributable through every write path today, computed generically
 *  anyway), grouped by the chapter whose budget absorbed the spend. Read once
 *  (central-owned txns are low-volume, like the City Launch Fund scan);
 *  mode-filtered inline via `txnMatchesMode`. */
export async function loadChapterOwesCentralRows(
  ctx: QueryCtx,
  centralBudgetIds: Set<Id<"budgets">>,
  sandboxMode: boolean,
): Promise<Map<Id<"chapters">, Doc<"transactions">[]>> {
  const centralTxns = await ctx.db
    .query("transactions")
    .withIndex("by_chapter", (q) => q.eq("chapterId", CENTRAL))
    .take(ROLLUP_SCAN_LIMIT);
  if (centralTxns.length === ROLLUP_SCAN_LIMIT) {
    console.warn(
      `[transfers] interScopeBalances hit ROLLUP_SCAN_LIMIT (${ROLLUP_SCAN_LIMIT}) reading central-owned transactions; direction (b) truncated.`,
    );
  }
  const budgetCache = new Map<Id<"budgets">, Doc<"budgets"> | null>();
  async function resolveBudget(id: Id<"budgets">): Promise<Doc<"budgets"> | null> {
    if (!budgetCache.has(id)) budgetCache.set(id, await ctx.db.get(id));
    return budgetCache.get(id) ?? null;
  }
  const byChapter = new Map<Id<"chapters">, Doc<"transactions">[]>();
  for (const tr of centralTxns) {
    if (!isSpend(tr) || tr.budgetId == null || centralBudgetIds.has(tr.budgetId)) continue;
    if (!txnMatchesMode(tr, sandboxMode)) continue;
    const linked = await resolveBudget(tr.budgetId);
    if (!linked || linked.chapterId === CENTRAL) continue; // dangling, or (shouldn't happen) central
    const chId = linked.chapterId as Id<"chapters">;
    const rows = byChapter.get(chId) ?? [];
    rows.push(tr);
    byChapter.set(chId, rows);
  }
  return byChapter;
}

/**
 * ONE chapter's four row groups behind its `interScopeBalances` net figures:
 * direction (a) rows (this chapter's spend linked to a central budget),
 * direction (b) rows (passed in, pre-scanned by `loadChapterOwesCentralRows`),
 * and the two settling-leg directions already recorded (`source:"transfer"`,
 * every new one, OR the historical `source:"settlement"` — see this file's
 * header comment on why old prod rows keep the old source literal). Every
 * group is mode-filtered, and every group drops `status:"excluded"` rows — the
 * spend sides via `isSpend`, the settling sides via their own test (see the
 * filter below for why the two sides agreeing is load-bearing).
 * `interScopeBalances` sums each group (all-time, and
 * `inPeriod`-filtered for the period figure); `interScopeBalanceContributors`
 * returns them directly as the "why" behind a chapter's balance.
 */
export function chapterInterScopeRows(
  chapterTxns: Doc<"transactions">[],
  centralBudgetIds: Set<Id<"budgets">>,
  chapterOwesCentralRows: Doc<"transactions">[],
  sandboxMode: boolean,
): {
  centralOwesChapterRows: Doc<"transactions">[];
  chapterOwesCentralRows: Doc<"transactions">[];
  settledCentralToChapterRows: Doc<"transactions">[];
  settledChapterToCentralRows: Doc<"transactions">[];
} {
  const modeFiltered = chapterTxns.filter((tr) => txnMatchesMode(tr, sandboxMode));

  const centralOwesChapterRows = modeFiltered.filter(
    (tr) => isSpend(tr) && tr.budgetId != null && centralBudgetIds.has(tr.budgetId),
  );

  const settlingRows = modeFiltered.filter(
    (tr) =>
      (tr.source === "transfer" || tr.source === "settlement") &&
      // A payout-allocation pair distributes Stripe REVENUE to the book that
      // earned it — it never pays down a card-spend imbalance, so counting it
      // as a settling leg would let every payout silently erase real
      // central↔chapter debt. `auto_settlement` pairs are the engine legs
      // that DO settle this balance (that's their whole job), and manual
      // transfers (origin absent) keep counting exactly as before.
      tr.transferOrigin !== "payout_allocation" &&
      // `balance_settlement` is excluded for the SAME reason, and leaving it in
      // created a feedback loop that shifted real book value every morning.
      //
      // Those pairs move a chapter the cash its book says it is owed; they pay
      // down no card-spend debt. Counted as settling legs, a $2,003.95
      // central→chapter balance settlement read as "central has already paid
      // the chapter $2,003.95", which flipped the cross-book net — so
      // `runAutoSettlement` booked a $2,003.95 chapter→central pair to
      // "correct" it. A balance settlement contributes ZERO to book value by
      // design; an auto settlement is SIGNED. So each round moved $2,003.95 of
      // book value that no real spending justified, and the next run would
      // have done it again in the other direction, for ever.
      tr.transferOrigin !== "balance_settlement" &&
      // AN EXCLUDED LEG IS NOT A SETTLEMENT — and the same loop proves it.
      //
      // The two sides of this net MUST agree on what counts. The spend sides
      // above (and `loadChapterOwesCentralRows`) go through `isSpend`, which
      // drops `status:"excluded"` (`finances.ts`); this side filtered on
      // `source`/`transferOrigin`/mode and never looked at `status`. So the one
      // move a human has to neutralise a bad row — mark it Excluded — took it
      // out of the spend side while leaving it standing on the settled side.
      //
      // That completed the very loop the `balance_settlement` filter above was
      // added to break. The bogus $2,003.95 `chapter_to_central` pair booked on
      // 2026-08-09 was set to `excluded` to kill it; the next morning's run read
      // it as "New York has already paid central $2,003.95" and booked a NEW
      // `central_to_chapter` pair for $2,003.95 against a $0.00 base — its own
      // note reads "central's spend on New York's cards $0.00 (0 rows) less
      // $2,003.95 already settled." An `auto_settlement` leg is SIGNED
      // (`lib/bookBalance.ts`), so that moved $2,003.95 of book value from
      // central to New York for spending that does not exist, and — being
      // itself a live settling leg on the opposite side — would have ping-ponged
      // the same $2,003.95 back every morning after. It nets to zero org-wide,
      // which is exactly why the reconciliation panel kept saying "it adds up".
      //
      // `"excluded"` is the ONLY status that means "out of all totals" —
      // `unreviewed`/`categorized`/`reconciled` are all live rows at different
      // stages of review, and a leg that has settled real debt settles it
      // whether or not a bookkeeper has got to it yet. This is deliberately the
      // same single test `signedBookCents` opens with, so a row that moves book
      // value and a row that counts as settled are never two different sets.
      //
      // The rest of `isSpend` stays off this side on purpose: `isPersonal` is
      // NOT excluded because `signedBookCents` keeps personal charges too ("the
      // money really left"), and `refundedByTransactionId` cannot appear here at
      // all — `finances.markAsRefund` refuses any row carrying a
      // `transferGroupId`, which every settling leg has.
      tr.status !== "excluded" &&
      matchesMode(tr.externalId ?? null, sandboxMode),
  );
  const settledCentralToChapterRows = settlingRows.filter(
    (tr) => tr.transferDirection === "central_to_chapter",
  );
  const settledChapterToCentralRows = settlingRows.filter(
    (tr) => tr.transferDirection === "chapter_to_central",
  );

  return {
    centralOwesChapterRows,
    chapterOwesCentralRows,
    settledCentralToChapterRows,
    settledChapterToCentralRows,
  };
}

export function sumAllCents(rows: Doc<"transactions">[]): number {
  return rows.reduce((s, tr) => s + tr.amountCents, 0);
}

function sumInPeriodCents(rows: Doc<"transactions">[], year: number, month: number): number {
  return rows.reduce((s, tr) => (inPeriod(tr.postedAt, year, month) ? s + tr.amountCents : s), 0);
}

/** `YYYY-MM-DD` in America/New_York — the same one-liner as
 *  `finances.ts#easternDateStr` (unexported there); duplicated here rather
 *  than importing across an off-limits file for a single date formatter. */
function easternDateStrLocal(ts: number): string {
  return new Date(ts).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

type InterScopeContributorDirection =
  | "central_owes_chapter"
  | "chapter_owes_central"
  | "settlement_central_to_chapter"
  | "settlement_chapter_to_central";

const interScopeContributorRow = v.object({
  id: v.id("transactions"),
  date: v.string(),
  amountCents: v.number(),
  description: v.union(v.string(), v.null()),
  merchantName: v.union(v.string(), v.null()),
  direction: v.union(
    v.literal("central_owes_chapter"),
    v.literal("chapter_owes_central"),
    v.literal("settlement_central_to_chapter"),
    v.literal("settlement_chapter_to_central"),
  ),
});

/**
 * WP-dashboard-drill: the raw transactions/settling legs composing ONE
 * chapter's `interScopeBalances` row — "why does Central owe NY $160.20?"
 * Reuses `chapterInterScopeRows`, the EXACT same predicates `interScopeBalances`
 * itself sums, so the signed sum of these rows' `amountCents` (central_owes -
 * settlement_central_to_chapter - (chapter_owes - settlement_chapter_to_central))
 * always equals that query's `netCents` for the same chapter. ALL-TIME (no
 * year/month arg) — `netCents` itself is all-time, not `periodNetCents`. The
 * `direction` labels keep their historical `settlement_*` names even though a
 * settling leg may now be `source:"transfer"` — the label describes the
 * ROLE the leg plays in this balance, not its literal `source` value.
 *
 * Gate: central VIEWER+ reach, same as `interScopeBalances`.
 */
export const interScopeBalanceContributors = query({
  args: { chapterId: v.id("chapters") },
  returns: v.array(interScopeContributorRow),
  handler: async (ctx, { chapterId }) => {
    const home = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireCentralFinanceRole(ctx, home, "viewer");
    const sandboxMode = await readSandbox(ctx);

    const { centralBudgetIds } = await loadInterScopeContext(ctx);
    const chapterOwesCentralRowsByChapter = await loadChapterOwesCentralRows(
      ctx,
      centralBudgetIds,
      sandboxMode,
    );
    const chapterTxns = await ctx.db
      .query("transactions")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
      .take(ROLLUP_SCAN_LIMIT);

    const grouped = chapterInterScopeRows(
      chapterTxns,
      centralBudgetIds,
      chapterOwesCentralRowsByChapter.get(chapterId) ?? [],
      sandboxMode,
    );

    const tagged: Array<Doc<"transactions"> & { direction: InterScopeContributorDirection }> = [
      ...grouped.centralOwesChapterRows.map((tr) => ({ ...tr, direction: "central_owes_chapter" as const })),
      ...grouped.chapterOwesCentralRows.map((tr) => ({ ...tr, direction: "chapter_owes_central" as const })),
      ...grouped.settledCentralToChapterRows.map((tr) => ({
        ...tr,
        direction: "settlement_central_to_chapter" as const,
      })),
      ...grouped.settledChapterToCentralRows.map((tr) => ({
        ...tr,
        direction: "settlement_chapter_to_central" as const,
      })),
    ];
    tagged.sort((a, b) => b.postedAt - a.postedAt);

    return tagged.map((tr) => ({
      id: tr._id,
      date: easternDateStrLocal(tr.postedAt),
      amountCents: tr.amountCents,
      description: tr.description ?? null,
      merchantName: tr.merchantName ?? null,
      direction: tr.direction,
    }));
  },
});

// ── UI readiness (kept for a future real-movement path) ──────────────────────

/**
 * Whether a real Increase movement WOULD be possible for a chapter's
 * transfers right now: both the chapter's AND central's accounts are
 * `active` in the current mode with an Increase account id. No code in this
 * file acts on this today — the `initiate*` Increase actions that used to
 * consume it were deleted with the rest of the automation (see this file's
 * header comment) — but the underlying account-readiness fact is still a
 * legitimate, cheap read (e.g. for a future "you could wire this up"
 * affordance), so the query stays. Central reach required to read it.
 */
export const transferReadiness = query({
  args: { chapterId: v.id("chapters") },
  returns: v.object({ canMoveReal: v.boolean() }),
  handler: async (ctx, { chapterId }) => {
    const home = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireCentralFinanceRole(ctx, home, "bookkeeper");
    const sandboxMode = await readSandbox(ctx);
    const chapterAccount = await getChapterAccountForMode(ctx, chapterId, sandboxMode);
    const centralAccount = await getChapterAccountForMode(ctx, CENTRAL, sandboxMode);
    const ready = (a: Doc<"increaseAccounts"> | null): boolean =>
      a != null && a.onboardingStatus === "active" && !!a.increaseAccountId;
    return { canMoveReal: ready(chapterAccount) && ready(centralAccount) };
  },
});
