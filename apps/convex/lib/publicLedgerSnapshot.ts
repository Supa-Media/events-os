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
  CENTRAL,
  displayMerchantName,
  documentationState,
  easternParts,
  formatCents,
  INCOME_STREAMS,
  isReconstructedHistory,
  MAX_PUBLISHED_ENTRIES,
  parsePeriodKey,
  publicGiftMethodLabel,
  type DocumentationState,
  type ExpenseType,
  type IncomeStream,
} from "@events-os/shared";
import {
  isUndocumented,
  requiresCoding,
  txnMatchesMode,
  ROLLUP_SCAN_LIMIT,
} from "../finances";
import { signedBookCents } from "./bookBalance";
import { codingPolicy } from "./transactionCoding";
import type { FinanceScope } from "./finance";

const DAY_MS = 24 * 60 * 60 * 1000;

/** What a category with no category is called. Named plainly rather than
 *  hidden — a transparency page that quietly drops what it can't classify is
 *  the wrong kind of tidy. */
const UNCATEGORIZED = "Uncategorized";
/** Ditto for spend that attached to no project or event. */
const UNASSIGNED_PROJECT = "General operations";

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
  entryCount: number;
  giftCount: number;
  reconstructedCount: number;
  reconstructedCents: number;
  undocumentedCount: number;
  undocumentedCents: number;
  uncodedCount: number;
  uncodedCents: number;
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
  let expenseCents = 0;
  let reconstructedCount = 0;
  let reconstructedCents = 0;
  let undocumentedCount = 0;
  let undocumentedCents = 0;
  let uncodedCount = 0;
  let uncodedCents = 0;

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

  for (const tr of rawTxns) {
    if (!txnMatchesMode(tr, sandboxMode)) continue;
    // An intentional exclusion is the org asserting this is NOT a transaction
    // (a duplicate, a bank error). Publishing it as one would mislead.
    if (tr.status === "excluded") continue;
    if (!inPeriod(tr.postedAt, year, month)) continue;

    const signed = signedBookCents(tr);
    // Direction from the book-value sign where there is one; otherwise the row
    // moves cash without changing value, which is exactly `internal`.
    const direction: EntryDraft["direction"] =
      signed < 0 ? "out" : signed > 0 ? "in" : "internal";
    const countsInTotals = signed !== 0;

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

    const affiliationMix = approved
      ? affiliationCounts([...(approved.attendees ?? []), ...(approved.travelers ?? [])])
      : undefined;

    const categoryLabel = (await labels.category(tr.categoryId)) ?? UNCATEGORIZED;
    const projectLabel = await labels.project(tr.projectId);
    const eventLabel = await labels.event(tr.eventId);

    entries.push({
      kind: "ledger",
      occurredAt: tr.postedAt,
      amountCents: tr.amountCents,
      direction,
      countsInTotals,
      bookLabel,
      counterparty: displayMerchantName(tr),
      // `publicPurpose ?? businessPurpose` — the approver's redaction wins
      // where one was written, and the author's own words publish otherwise.
      // Never both, and never a rewrite of the author's text; see
      // `schema/finances.ts#transactionCodings.publicPurpose`.
      purpose: approved
        ? (approved.publicPurpose ?? approved.businessPurpose)
        : undefined,
      categoryLabel,
      fundLabel: await labels.fund(tr.fundId),
      budgetLabel: await labels.budget(tr.budgetId),
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
      nonDiscretionaryFee: tr.feeOrigin != null || undefined,
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
  }

  // ── Gifts (the anonymous roll + the giving total) ──────────────────────────
  let giftCount = 0;
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
    entryCount: entries.length,
    giftCount,
    reconstructedCount,
    reconstructedCents,
    undocumentedCount,
    undocumentedCents,
    uncodedCount,
    uncodedCents,
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
