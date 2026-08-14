/**
 * Building one book-month's statement — the snapshot that gets frozen.
 *
 * This module reads the LIVE books and produces a plain object. It writes
 * nothing. `publicLedger.ts` is what persists the result, and keeping the two
 * apart is what makes "show me what would publish" and "publish it" the same
 * computation rather than two implementations that drift.
 *
 * ── THE TOTALS ARE THE BOOK-VALUE MODEL, NOT A SECOND OPINION ────────────────
 * Income mirrors `reconciliation.ts#computeBookBalances` phase 1 exactly:
 * gifts, in-person sales, paid ticket orders, paid project registrations —
 * each counted ONCE at the layer that earned it — plus the ledger inflows
 * that are not the bank arrival of any of those. Expenses are the ledger's
 * outflows, by `signedBookCents`. This is deliberate and non-negotiable: the
 * public page and the internal accounts page must never be able to quote
 * different numbers for the same month, because the first person to notice
 * would be right to conclude that one of them is being managed.
 *
 * The one difference from `computeBookBalances` is the period bound — it
 * computes lifetime balances, this computes a month. Everything else is the
 * same rule applied to a narrower window.
 *
 * ── WHAT PUBLISHES, AND WHAT DOESN'T ─────────────────────────────────────────
 *  - EVERY non-`excluded` transaction in the window publishes as a line. The
 *    owner's ask was "literally all the transactions"; rows that must not be
 *    summed (internal transfers, payout deposits) publish as `internal` with
 *    `countsInTotals: false` rather than being dropped.
 *  - An `excluded` row does NOT publish. An intentional exclusion is a
 *    duplicate or a bank error — a row the org asserts is not a transaction —
 *    and republishing it as one would be the opposite of clarifying.
 *  - Gifts publish as an ANONYMOUS roll: amount, date, method, designation.
 *    No donor field is read, let alone written (`schema/publicLedger.ts`).
 *  - Ticket orders, sales and registrations publish only as INCOME TOTALS,
 *    not as lines. They are individually attributable to a named buyer
 *    through their own tables, and the transparency question they answer
 *    ("how much came in this way?") is fully answered by the total.
 *
 * ── LABELS ARE RESOLVED HERE, ONCE ───────────────────────────────────────────
 * Every id is turned into the string that will be frozen, through a small
 * per-build cache. A month touches a handful of funds/categories/projects
 * across hundreds of rows, so the cache turns an O(rows) read pattern into
 * O(distinct labels).
 */
import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import {
  autoExplainedKind,
  autoExplanationLine,
  personalExpenseState,
  CENTRAL,
  displayMerchantName,
  documentationState,
  easternParts,
  formatCents,
  INCOME_STREAMS,
  isNonDiscretionaryFee,
  isReconstructedHistory,
  MAX_PUBLISHED_ENTRIES,
  parsePeriodKey,
  publicGiftMethodLabel,
  type DocumentationState,
  type ExpenseType,
  type IncomeStream,
} from "@events-os/shared";
import {
  canCarryExplanation,
  effectiveCapCents,
  isUndocumented,
  requiresCoding,
  txnMatchesMode,
  ROLLUP_SCAN_LIMIT,
} from "../finances";
import { signedBookCents } from "./bookBalance";
import {
  coveredSignedBookCents,
  giftCoverageByTransaction,
} from "./giftCoverage";
import { codingPolicy } from "./transactionCoding";
import type { FinanceScope } from "./finance";

const DAY_MS = 24 * 60 * 60 * 1000;

/** What a category with no category is called. Named plainly rather than
 *  hidden — a transparency page that quietly drops what it can't classify is
 *  the wrong kind of tidy. */
const UNCATEGORIZED = "Uncategorized";
/** Ditto for spend that attached to no project or event. */
const UNASSIGNED_PROJECT = "General operations";
/** The catch-all bucket for spend carrying no budget. A sentinel key rather
 *  than `undefined` so it participates in the same Map as real budget ids. */
const NO_BUDGET_KEY = "__no_budget__";
const NO_BUDGET_LABEL = "Not attached to a budget";

// ── Draft shapes (what `publicLedger.ts` inserts) ────────────────────────────

/** One line, ready to freeze. Mirrors `financePublicationEntries` minus the
 *  parent keys, which only the writer knows. */
export type EntryDraft = {
  kind: "ledger" | "gift";
  occurredAt: number;
  amountCents: number;
  direction: "in" | "out" | "internal";
  countsInTotals: boolean;
  bookLabel: string;
  counterparty?: string;
  purpose?: string;
  categoryLabel?: string;
  fundLabel?: string;
  budgetLabel?: string;
  projectLabel?: string;
  eventLabel?: string;
  expenseType?: ExpenseType;
  travelFrom?: string;
  travelTo?: string;
  headcount?: number;
  affiliationMix?: Record<string, number>;
  groupDescription?: string;
  documentation?: DocumentationState;
  reconstructed?: boolean;
  nonDiscretionaryFee?: boolean;
  sourceTransactionId?: Id<"transactions">;
  method?: string;
  designation?: string;
};

export type Snapshot = {
  entries: EntryDraft[];
  incomeCents: number;
  expenseCents: number;
  netCents: number;
  incomeByStream: { stream: IncomeStream; cents: number; count: number }[];
  expenseByCategory: { label: string; cents: number; count: number }[];
  expenseByProject: { label: string; cents: number; count: number }[];
  /** What each budget was allowed and what it used. `allocatedCents` is
   *  absent on the catch-all row for spend that carried no budget — which is
   *  not a budget of zero and must never render as one. */
  spendByBudget: {
    label: string;
    allocatedCents?: number;
    spentCents: number;
    count: number;
  }[];
  entryCount: number;
  giftCount: number;
  /** DISTINCT people who gave, and how many of them gave through a recurring
   *  pledge. Counts here; the identities behind them are in `giverKeys`. */
  giverCount: number;
  backerCount: number;
  /** One entry per distinct giver — written to `financePublicationGiverKeys`,
   *  which NO public query reads. The only reason it exists is so a YEAR can
   *  union twelve months instead of adding twelve distinct counts together.
   *  See that table's doc comment. */
  giverKeys: { key: string; isBacker: boolean }[];
  reconstructedCount: number;
  reconstructedCents: number;
  undocumentedCount: number;
  undocumentedCents: number;
  uncodedCount: number;
  uncodedCents: number;
  /**
   * Lines that PUBLISH WITHOUT AN EXPLANATION — what a reader can actually
   * see, as distinct from `uncodedCount` above, which is what our own policy
   * required.
   *
   * The two diverge violently on historical months and that is exactly why
   * this exists. `requiresCoding` grandfathers everything posted before the
   * coding policy date, so a 2024 month has an uncoded count of ZERO while
   * every row on the page reads "No published explanation for this line." A
   * disclosure block that reported the policy number would have been silent
   * about the single most visible characteristic of the page — under-
   * disclosure by technicality, which is the same failure as overclaiming,
   * pointed the other way.
   *
   * Internal movements are excluded: a transfer between our own accounts has
   * no business purpose to give, and counting it as a missing explanation
   * would inflate the number with rows that are complete.
   */
  unexplainedCount: number;
  unexplainedCents: number;
  /** A source scan hit `ROLLUP_SCAN_LIMIT`, so these figures may be
   *  incomplete. `publish` refuses to publish a snapshot carrying this — see
   *  `publicLedger.ts`. */
  truncated: boolean;
  /** Set when the entry count exceeded `MAX_PUBLISHED_ENTRIES`. Like
   *  `truncated`, a hard refusal at publish time rather than a silent cap:
   *  a partial ledger presented as complete is worse than no ledger. */
  overCap: boolean;
};

// ── Label cache ──────────────────────────────────────────────────────────────

/**
 * Resolve ids to the strings that get frozen, memoized per build.
 *
 * A month touches a handful of distinct funds/categories/projects across
 * hundreds of rows, so this turns an O(rows) read pattern into O(distinct
 * labels). The cache stores `undefined` for a dangling id too — a deleted
 * project shouldn't be re-read once per row that pointed at it.
 */
class Labels {
  private cache = new Map<string, string | undefined>();
  private capCache = new Map<string, number | undefined>();
  constructor(private ctx: QueryCtx) {}

  private async memo(
    id: string,
    read: () => Promise<string | undefined>,
  ): Promise<string | undefined> {
    if (this.cache.has(id)) return this.cache.get(id);
    const value = await read();
    this.cache.set(id, value);
    return value;
  }

  async fund(id?: Id<"funds">): Promise<string | undefined> {
    if (!id) return undefined;
    return this.memo(id, async () => (await this.ctx.db.get(id))?.name);
  }
  async category(id?: Id<"budgetCategories">): Promise<string | undefined> {
    if (!id) return undefined;
    return this.memo(id, async () => (await this.ctx.db.get(id))?.name);
  }
  async project(id?: Id<"projects">): Promise<string | undefined> {
    if (!id) return undefined;
    return this.memo(id, async () => (await this.ctx.db.get(id))?.name);
  }
  async event(id?: Id<"events">): Promise<string | undefined> {
    if (!id) return undefined;
    return this.memo(id, async () => (await this.ctx.db.get(id))?.name);
  }
  /** A budget has no `name` — its human handle is `label`, and an unlabeled
   *  budget falls back to its own amount, which is at least identifying. */
  async budget(id?: Id<"budgets">): Promise<string | undefined> {
    if (!id) return undefined;
    return this.memo(id, async () => {
      const doc = await this.ctx.db.get(id);
      if (!doc) return undefined;
      return (
        doc.label ??
        `Budget · ${formatCents(doc.amountCents, { showCents: false })}`
      );
    });
  }

  /** The budget's cap IN FORCE — `effectiveCapCents`, not `amountCents`, so a
   *  budget mid-increase publishes what it was approved to spend rather than
   *  what somebody has asked for. Cached separately from the label because
   *  the two are looked up on different rows of the same read. */
  async budgetCap(id: Id<"budgets">): Promise<number | undefined> {
    const cacheKey = `cap:${id}`;
    if (this.capCache.has(cacheKey)) return this.capCache.get(cacheKey);
    const doc = await this.ctx.db.get(id);
    const cap = doc ? effectiveCapCents(doc) : undefined;
    this.capCache.set(cacheKey, cap);
    return cap;
  }
}

// ── Period window ────────────────────────────────────────────────────────────

/**
 * The UTC ms window covering one Eastern month, padded a day on each side.
 *
 * The padding is not slack — it is required. The index range is over UTC
 * `postedAt`, the month is defined in America/New_York, and the two disagree
 * by up to five hours at the boundary. The pad guarantees the range is a
 * SUPERSET of the month; `easternParts` then narrows it exactly. Same
 * arrangement as `publishability.ts#loadPeriodRows`.
 */
function periodWindow(year: number, month: number): { start: number; end: number } {
  return {
    start: Date.UTC(year, month - 1, 1) - DAY_MS,
    end: Date.UTC(year, month, 1) + DAY_MS,
  };
}

/** True iff `ts` falls in the Eastern month `(year, month)`. */
function inPeriod(ts: number, year: number, month: number): boolean {
  const p = easternParts(ts);
  return p.year === year && p.month === month;
}

// ── Accumulators ─────────────────────────────────────────────────────────────

type Bucket = { cents: number; count: number };

function bump(map: Map<string, Bucket>, key: string, cents: number): void {
  const b = map.get(key) ?? { cents: 0, count: 0 };
  b.cents += cents;
  b.count += 1;
  map.set(key, b);
}

/** Biggest first — a breakdown is read top-down, and the largest line is the
 *  one a reader is actually asking about. */
function toSortedRows(
  map: Map<string, Bucket>,
): { label: string; cents: number; count: number }[] {
  return [...map.entries()]
    .map(([label, b]) => ({ label, cents: b.cents, count: b.count }))
    .sort((a, b) => b.cents - a.cents);
}

// ── The build ────────────────────────────────────────────────────────────────

/**
 * Build one book's statement for one `YYYY-MM` period.
 *
 * `sandboxMode` comes from `financeSettings` and is threaded in rather than
 * read here so a caller that builds several books pays for it once. In
 * sandbox the revenue side reads zero, matching `computeBookBalances` — a
 * demo book stays a pure ledger book instead of quietly inventing income.
 */
export async function buildSnapshot(
  ctx: QueryCtx,
  book: FinanceScope,
  periodKey: string,
  sandboxMode: boolean,
): Promise<Snapshot> {
  const parsed = parsePeriodKey(periodKey);
  if (!parsed) {
    throw new Error(`buildSnapshot: "${periodKey}" is not a YYYY-MM period key`);
  }
  const { year, month } = parsed;
  const { start, end } = periodWindow(year, month);
  const labels = new Labels(ctx);
  const bookLabel =
    book === CENTRAL ? "Central" : ((await ctx.db.get(book))?.name ?? "Chapter");
  const { sinceMs: codingSinceMs } = await codingPolicy(ctx);

  let truncated = false;
  const entries: EntryDraft[] = [];
  const incomeByStream = new Map<IncomeStream, Bucket>();
  const expenseByCategory = new Map<string, Bucket>();
  const expenseByProject = new Map<string, Bucket>();
  // Keyed by budget id so two budgets that happen to share a label stay
  // distinct rows; the label is carried alongside for the frozen output. The
  // no-budget catch-all uses a sentinel key and carries no allocation.
  const byBudget = new Map<
    string,
    { label: string; allocatedCents?: number; spentCents: number; count: number }
  >();
  let expenseCents = 0;
  let reconstructedCount = 0;
  let reconstructedCents = 0;
  let undocumentedCount = 0;
  let undocumentedCents = 0;
  let uncodedCount = 0;
  let uncodedCents = 0;
  let unexplainedCount = 0;
  let unexplainedCents = 0;

  const addIncome = (stream: IncomeStream, cents: number) => {
    const b = incomeByStream.get(stream) ?? { cents: 0, count: 0 };
    b.cents += cents;
    b.count += 1;
    incomeByStream.set(stream, b);
  };

  // ── Ledger rows ───────────────────────────────────────────────────────────
  const rawTxns = await ctx.db
    .query("transactions")
    .withIndex("by_chapter_and_postedAt", (q) =>
      q.eq("chapterId", book).gte("postedAt", start).lt("postedAt", end),
    )
    .take(ROLLUP_SCAN_LIMIT);
  if (rawTxns.length === ROLLUP_SCAN_LIMIT) truncated = true;

  // BANK CREDITS THAT ARE ALREADY GIFTS. Some giving arrives as a direct wire
  // or Zelle into the account, so the same money exists twice: once as a
  // `gifts` row (where the org counts its revenue) and once as the bank credit
  // that delivered it. `givingCandidates.ts` is how a human confirms the
  // second IS the first, writing `gifts.transactionId`.
  //
  // `accountBalances` has always honoured that link — a gift-linked credit is
  // zeroed there exactly like a processor payout deposit. This snapshot did
  // not, because it reads `signedBookCents`, a pure function on the
  // transaction that cannot know about a row in another table. So the accounts
  // page and the PUBLISHED page disagreed about the same dollar: one counted
  // the gift, the other counted the gift AND the credit that carried it
  // (founder, 2026-08-13 — a $7,000 founder wire publishing as "Other income"
  // beside the very gifts it was already recorded as).
  //
  // One deposit is often SEVERAL gifts across books ($7,000 wired as $5,000
  // for central and $2,000 for New York), so this is a sum, not a flag: the
  // credit contributes whatever no gift has claimed. See `lib/giftCoverage.ts`
  // for why the lookup is per-transaction rather than by the period's gifts.
  const giftCoverage = await giftCoverageByTransaction(ctx, rawTxns);

  for (const tr of rawTxns) {
    if (!txnMatchesMode(tr, sandboxMode)) continue;
    // An intentional exclusion is the org asserting this is NOT a transaction
    // (a duplicate, a bank error). Publishing it as one would mislead.
    if (tr.status === "excluded") continue;
    if (!inPeriod(tr.postedAt, year, month)) continue;

    // A confirmed gift credit carries no value of its own — the gift does. It
    // still PUBLISHES (the bank really received it, and a reader following the
    // money should see it arrive); it simply contributes nothing, exactly like
    // the payout deposits `signedBookCents` already zeroes. A PARTLY matched
    // deposit keeps its unclaimed remainder, which is the honest reading:
    // that much really did arrive and nobody has said what it was.
    const coveredCents = giftCoverage.get(tr._id as string) ?? 0;
    const signed = coveredSignedBookCents(tr, coveredCents);
    // WHAT THIS ROW IS, in its own words. Without it the row fell through to
    // the page's `direction === "internal"` fallback and told every reader
    // "Money moved between our own accounts — nothing earned or spent" about
    // a donation (founder, 2026-08-14: "It's not internal transfer, it's a
    // gift. But it was received by ACH"). The zero is right; the sentence
    // explaining the zero was the opposite of the truth.
    //
    // A PARTLY matched deposit says exactly how much of it is giving, because
    // the rest still counts and still owes an answer.
    const giftLine =
      coveredCents <= 0
        ? undefined
        : signed === 0
          ? autoExplanationLine("gift_credit")
          : `${formatCents(coveredCents)} of this deposit is giving, counted once in the giving roll below. The rest is not yet accounted for.`;
    // Direction from the book-value sign where there is one; otherwise the row
    // moves cash without changing value, which is exactly `internal`.
    const direction: EntryDraft["direction"] =
      signed < 0 ? "out" : signed > 0 ? "in" : "internal";
    // A marked refund pair's legs COUNT AS NOTHING (Opus audit, 2026-08-13):
    // `signedBookCents` has no refund branch — the pair nets org-wide across
    // both legs — but per-budget published spend was still charged the
    // refunded amount and the credit inflated "other" income, while the
    // rows' own auto-explanation line promised "the two rows net to zero."
    // Both legs still PUBLISH (with that line); they just count toward no
    // total, exactly like an internal movement. Same treatment as
    // `isSpend`'s refund clause, one layer up. The personal-charge pair gets
    // the identical logic for the identical reason: `isSpend` already says a
    // personal charge is NOT org spend (it's a receivable being repaid), so
    // publishing it as expense — and its repayment as "other income" —
    // would both misstate; the two legs publish with their status lines and
    // count as nothing, netting by construction rather than across months.
    const autoKindForTotals = autoExplainedKind(tr);
    const countsAsNothing =
      autoKindForTotals === "refunded_charge" ||
      autoKindForTotals === "refund_credit" ||
      autoKindForTotals === "repayment_credit" ||
      autoKindForTotals === "personal";
    const countsInTotals = signed !== 0 && !countsAsNothing;

    const coding = await ctx.db
      .query("transactionCodings")
      .withIndex("by_transaction", (q) => q.eq("transactionId", tr._id))
      .unique();
    // ONLY AN APPROVED CODING PUBLISHES. A `submitted` one is real work in
    // flight and an unreviewed assertion; putting it on the public page would
    // publish something no second person has stood behind. The same line
    // `publishability.ts` draws for its coding axis.
    const approved = coding?.status === "approved" ? coding : null;

    const documentation = documentationState(
      tr.receiptStorageId != null,
      tr.approvedReceiptExceptionId != null,
    );
    const reconstructed = isReconstructedHistory(tr);

    // AUTO-EXPLAINED rows (founder directive, 2026-08-12): a processor fee or
    // a personal charge publishes WITH its own status line in place of a
    // coding — "maximum transparency" — and never counts as an unexplained
    // gap, because there is no explanation a human could add. The personal
    // line is derived from the linked repayment's real state, so it can never
    // claim "paid back" before the money arrived.
    const autoKind = autoKindForTotals;
    let autoLine: string | undefined;
    if (!approved && autoKind != null) {
      if (autoKind === "personal") {
        const repayment = tr.repaymentId ? await ctx.db.get(tr.repaymentId) : null;
        autoLine = autoExplanationLine(
          "personal",
          personalExpenseState(true, repayment?.status ?? null),
        );
      } else {
        // "fee" and "cashback" both — pass the kind through, never hardcode
        // one branch's line (the first version did, and the cashback class
        // arrived wearing the fee sentence).
        autoLine = autoExplanationLine(autoKind);
      }
    }

    const affiliationMix = approved
      ? affiliationCounts([...(approved.attendees ?? []), ...(approved.travelers ?? [])])
      : undefined;

    const categoryLabel = (await labels.category(tr.categoryId)) ?? UNCATEGORIZED;
    const projectLabel = await labels.project(tr.projectId);
    const eventLabel = await labels.event(tr.eventId);
    const budgetLabel = await labels.budget(tr.budgetId);

    entries.push({
      kind: "ledger",
      occurredAt: tr.postedAt,
      amountCents: tr.amountCents,
      direction,
      countsInTotals,
      bookLabel,
      // A GIVER IS NEVER NAMED HERE. Gifts publish as an anonymous roll, and
      // the page says so in as many words: "No names, no amounts tied to a
      // person, no way to work backwards to one." A wire's bank descriptor IS
      // the sender's name, so publishing this row's merchant printed a named
      // giver and their $7,000 two inches above that promise — breaking it on
      // the same screen that made it, and doing so precisely BECAUSE somebody
      // had done the right thing and recorded the deposit as giving.
      //
      // The row still publishes: the bank really received the money and a
      // reader following it should see it arrive. It just arrives unattributed,
      // which is the rule everywhere else giving appears.
      counterparty: coveredCents > 0 ? undefined : displayMerchantName(tr),
      // `publicPurpose ?? businessPurpose` — the approver's redaction wins
      // where one was written, and the author's own words publish otherwise.
      // Never both, and never a rewrite of the author's text; see
      // `schema/finances.ts#transactionCodings.publicPurpose`.
      purpose: approved
        ? (approved.publicPurpose ?? approved.businessPurpose)
        : (giftLine ?? autoLine),
      categoryLabel,
      fundLabel: await labels.fund(tr.fundId),
      budgetLabel,
      projectLabel,
      eventLabel,
      expenseType: approved?.expenseType,
      travelFrom: approved?.travelFrom,
      travelTo: approved?.travelTo,
      headcount: approved?.headcount,
      affiliationMix,
      groupDescription: approved?.groupDescription,
      documentation,
      reconstructed: reconstructed || undefined,
      // The shared predicate, not a fourth inline `feeOrigin` test — see
      // `@events-os/shared#isNonDiscretionaryFee` for why they were pulled
      // together.
      nonDiscretionaryFee: isNonDiscretionaryFee(tr) || undefined,
      sourceTransactionId: tr._id,
    });

    // ── Totals ──────────────────────────────────────────────────────────────
    if (direction === "out" && countsInTotals) {
      const magnitude = -signed;
      expenseCents += magnitude;
      bump(expenseByCategory, categoryLabel, magnitude);
      bump(
        expenseByProject,
        projectLabel ?? eventLabel ?? UNASSIGNED_PROJECT,
        magnitude,
      );

      // ── Spend against the plan ────────────────────────────────────────────
      // Keyed by id, so a rename between now and next month can't merge two
      // budgets into one published row. `NO_BUDGET_KEY` collects spend that
      // carried no budget at all — published plainly rather than dropped,
      // because "we spent this and it wasn't budgeted" is exactly the kind of
      // thing a reader is entitled to see.
      const budgetKey = tr.budgetId ?? NO_BUDGET_KEY;
      const existing = byBudget.get(budgetKey);
      if (existing) {
        existing.spentCents += magnitude;
        existing.count += 1;
      } else {
        byBudget.set(budgetKey, {
          label: budgetLabel ?? NO_BUDGET_LABEL,
          allocatedCents: tr.budgetId
            ? await labels.budgetCap(tr.budgetId)
            : undefined,
          spentCents: magnitude,
          count: 1,
        });
      }
    } else if (direction === "in" && countsInTotals) {
      // A ledger inflow that is NOT the arrival of already-counted revenue —
      // interest, a refund of earlier spend, a miscellaneous credit.
      // `signedBookCents` has already zeroed the payout deposits, so anything
      // still positive here genuinely belongs to `other`.
      addIncome("other", signed);
    }

    // ── Disclosures ─────────────────────────────────────────────────────────
    if (reconstructed) {
      reconstructedCount += 1;
      reconstructedCents += tr.amountCents;
    }
    // `isUndocumented` is the PUBLISHING predicate — status-blind, so a row a
    // treasurer quietly closed document-less years ago is disclosed rather
    // than dropping out. (`publishability.ts` makes this argument at length.)
    if (isUndocumented(tr)) {
      undocumentedCount += 1;
      undocumentedCents += tr.amountCents;
    }
    if (requiresCoding(tr, codingSinceMs) && tr.codingState !== "approved") {
      uncodedCount += 1;
      uncodedCents += tr.amountCents;
    }
    // What the READER sees, policy irrelevant. An auto-explained row (fee /
    // personal — see `autoExplainedKind`) already carries its own line, and a
    // row with no business purpose to give was never a gap.
    //
    // `canCarryExplanation` rather than `direction !== "internal"` (founder,
    // 2026-08-13: a $7,000 donation was disclosed on the PUBLISHED page as "1
    // line publishes with no written explanation of what it was for"). An
    // inflow's `direction` is `"in"`, not `"internal"`, so it passed that
    // guard — and the published ledger told readers the org couldn't explain a
    // gift it received. Nobody explains money arriving as spending; where a
    // gift came from is the giving layer's record. Same predicate the Explain
    // worklist and the coding panel read, so all three agree about which rows
    // owe an explanation.
    if (!approved && canCarryExplanation(tr) && autoKind == null) {
      unexplainedCount += 1;
      unexplainedCents += tr.amountCents;
    }
  }

  // ── Gifts (the anonymous roll + the giving total) ──────────────────────────
  // DISTINCT givers, keyed by the person BEHIND the donor row: a
  // `donorIdentities` id where one exists, else the `donors` id. Same grouping
  // rule `listOrgDonorsByIdentity` uses, so one human giving to two books is
  // one giver — a public "744 givers" that double-counted anyone across books
  // would be inflating the most quotable number on the page.
  //
  // A giver counts as a BACKER when any of their gifts in the period came
  // through a recurring pledge (`gifts.pledgeId`). Per-giver, not per-gift:
  // somebody with a monthly pledge who also gave a one-off is one backer.
  let giftCount = 0;
  const giverKeys = new Map<string, boolean>();
  if (!sandboxMode) {
    const rawGifts = await ctx.db
      .query("gifts")
      .withIndex("by_scope_and_received", (q) =>
        q.eq("scope", book).gte("receivedAt", start).lt("receivedAt", end),
      )
      .take(ROLLUP_SCAN_LIMIT);
    if (rawGifts.length === ROLLUP_SCAN_LIMIT) truncated = true;
    for (const gift of rawGifts) {
      if (!inPeriod(gift.receivedAt, year, month)) continue;
      giftCount += 1;
      addIncome("giving", gift.amountCents);
      const donor = await ctx.db.get(gift.donorId);
      // A gift whose donor row has vanished still counts as money and still
      // counts as A giver — keyed by the gift's own donor id, which is stable
      // even when the row is gone. Dropping it would understate the count.
      const giverKey = donor?.identityId ?? gift.donorId;
      giverKeys.set(
        giverKey,
        (giverKeys.get(giverKey) ?? false) || gift.pledgeId != null,
      );
      entries.push({
        kind: "gift",
        occurredAt: gift.receivedAt,
        // `amountCents` is what the donor MEANT to give; `feeCoverageCents`
        // is the extra they added so the processor's cut wouldn't come out of
        // it. Publishing the gift figure keeps the public total comparable
        // year on year as fee-coverage adoption changes — the invariant
        // `schema/givingPlatform.ts#gifts` exists to protect.
        amountCents: gift.amountCents,
        direction: "in",
        countsInTotals: true,
        bookLabel,
        method: publicGiftMethodLabel(gift.method),
        designation: await labels.event(gift.eventId),
      });
    }
  }

  // ── The other three revenue streams (totals only — see the module doc) ────
  if (!sandboxMode) {
    if (book !== CENTRAL) {
      const sales = await ctx.db
        .query("sales")
        .withIndex("by_chapter_and_soldAt", (q) =>
          q.eq("chapterId", book).gte("soldAt", start).lt("soldAt", end),
        )
        .take(ROLLUP_SCAN_LIMIT);
      if (sales.length === ROLLUP_SCAN_LIMIT) truncated = true;
      for (const sale of sales) {
        if (!inPeriod(sale.soldAt, year, month)) continue;
        // GROSS, like every other stream — the processor's fee is a separate
        // expense line, not a haircut on revenue.
        addIncome("sales", sale.grossCents);
      }

      // Ticket orders carry no time index (`by_chapter` only), so this is a
      // bounded book scan narrowed in memory. Same shape `computeBookBalances`
      // uses; if order volume ever makes it expensive, the fix is an index on
      // that table, not a different total here.
      const orders = await ctx.db
        .query("ticketOrders")
        .withIndex("by_chapter", (q) => q.eq("chapterId", book))
        .take(ROLLUP_SCAN_LIMIT);
      if (orders.length === ROLLUP_SCAN_LIMIT) truncated = true;
      for (const order of orders) {
        if (order.status !== "paid") continue;
        if (!inPeriod(order.createdAt, year, month)) continue;
        // `totalCents` is the ticket subtotal only — a bundled add-on donation
        // settles as a `donations` row → gift, and is already counted above.
        addIncome("tickets", order.totalCents);
      }
    }

    // Registrations are read at EVERY scope, central included — the one
    // revenue stream that is. See `computeBookBalances`' warning: central
    // really does run classes, and guarding this on `book !== CENTRAL` made
    // central registrations silently invisible once already.
    const regs = await ctx.db
      .query("registrations")
      .withIndex("by_chapter", (q) => q.eq("chapterId", book))
      .take(ROLLUP_SCAN_LIMIT);
    if (regs.length === ROLLUP_SCAN_LIMIT) truncated = true;
    for (const reg of regs) {
      if (reg.status !== "paid") continue;
      if (!inPeriod(reg.registeredAt, year, month)) continue;
      addIncome("registrations", reg.amountCents);
    }
  }

  entries.sort((a, b) => a.occurredAt - b.occurredAt);

  const incomeRows = INCOME_STREAMS.map((stream) => ({
    stream,
    cents: incomeByStream.get(stream)?.cents ?? 0,
    count: incomeByStream.get(stream)?.count ?? 0,
  })).filter((r) => r.count > 0);
  const incomeCents = incomeRows.reduce((t, r) => t + r.cents, 0);

  return {
    entries,
    incomeCents,
    expenseCents,
    netCents: incomeCents - expenseCents,
    incomeByStream: incomeRows,
    expenseByCategory: toSortedRows(expenseByCategory),
    expenseByProject: toSortedRows(expenseByProject),
    // Biggest spender first, and the unbudgeted catch-all always LAST
    // regardless of size — it is a different kind of row from the others, and
    // sorting it into the middle of a plan-vs-actual table reads as though it
    // were a plan.
    spendByBudget: [...byBudget.entries()]
      .map(([key, b]) => ({ ...b, isCatchAll: key === NO_BUDGET_KEY }))
      .sort((a, b) =>
        a.isCatchAll !== b.isCatchAll
          ? Number(a.isCatchAll) - Number(b.isCatchAll)
          : b.spentCents - a.spentCents,
      )
      .map(({ isCatchAll: _isCatchAll, ...row }) => row),
    entryCount: entries.length,
    giftCount,
    giverCount: giverKeys.size,
    backerCount: [...giverKeys.values()].filter(Boolean).length,
    giverKeys: [...giverKeys.entries()].map(([key, isBacker]) => ({
      key,
      isBacker,
    })),
    reconstructedCount,
    reconstructedCents,
    undocumentedCount,
    undocumentedCents,
    uncodedCount,
    uncodedCents,
    unexplainedCount,
    unexplainedCents,
    truncated,
    overCap: entries.length > MAX_PUBLISHED_ENTRIES,
  };
}

/** Count an attendee/traveler list by affiliation. NAMES ARE NEVER READ —
 *  this function takes the array only to count it, and the counts are the
 *  only thing that leaves. (`schema/finances.ts#transactionCodings` states the
 *  privacy rule; this is where it is honoured on the publishing path.) */
function affiliationCounts(
  people: readonly { affiliation: string }[],
): Record<string, number> | undefined {
  if (people.length === 0) return undefined;
  const mix: Record<string, number> = {};
  for (const p of people) mix[p.affiliation] = (mix[p.affiliation] ?? 0) + 1;
  return mix;
}
