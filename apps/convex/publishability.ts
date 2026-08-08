/**
 * Publishability — what stands between a period and a public ledger.
 *
 * Public Worship is publishing every transaction. A period is publishable
 * only when all THREE axes are green for every row that owes anything:
 *
 *   documentation — a receipt, or an approved receipt exception
 *   coding        — an approved `transactionCodings` record (the what/why/who)
 *   review        — reconciled by a bookkeeper+
 *
 * This module reports the gap per period + book, so the close meeting has a
 * number instead of a feeling. See `docs/plans/transaction-coding.md`
 * (phase 4) and `docs/plans/receipt-exceptions.md`.
 *
 * ── Why the axes are reported separately, never summed ───────────────────────
 * The three overlap freely: one $58 charge with no receipt, no coding and no
 * review is open on all three. Adding the axis counts would report it three
 * times and produce a "problems: 3" that corresponds to nothing an ED can
 * act on — and the moment that number stops matching the rows, the report
 * stops being used. So this query publishes FOUR independent populations:
 * the three axis gaps (each the honest answer to "how many rows still owe a
 * receipt / a coding / a review"), and `blocked` — the UNION, the actual
 * "how far from publishable are we". `blocked <= documentation + coding +
 * review` always, and `overlap` says by how much (rows failing exactly one,
 * two, or all three axes), so the two views reconcile on screen instead of
 * looking like a contradiction.
 *
 * ── Why the predicates are not the reconcile-grid ones ───────────────────────
 * Documentation uses `isUndocumented` (not `needsDocumentation`) — the
 * PUBLISHING predicate, which deliberately ignores status, so a row a
 * treasurer quietly closed document-less years ago is loudly visible here
 * instead of dropping out of the chase. Coding uses `requiresCoding` +
 * `codingState !== "approved"` (not `isUncoded`) for exactly the same reason,
 * one axis over: `isUncoded` has CHASE semantics — it skips `reconciled` rows
 * (nobody left to nag) and skips codings sitting in review (waiting on the
 * treasurer, not the author). Neither of those is green, and a ledger that
 * counted them as green would be published against a number that was never
 * true. This is the `needsDocumentation` / `isUndocumented` distinction
 * repeated on the coding axis, and it is the whole reason this report exists
 * as its own query rather than a rollup of the grid's facet counts.
 *
 * ── Why pre-policy spend is called out rather than counted ───────────────────
 * Coding is required only for spend posted on/after `codingRequiredSinceMs`
 * (owner decision: 2026-09-01 — `lib/transactionCoding.ts#codingPolicy`).
 * Folding grandfathered history into the coding gap would report a 100%
 * backlog on every period before September and make the number useless the
 * first time anyone looked at it. `codingExempt` reports that spend on its own
 * line — visible, so the exemption is a stated fact rather than a silent
 * omission, and never part of the gap.
 *
 * ── Why reconstructed history gets its own line ──────────────────────────────
 * Rows carrying `historicalImportBatch` (or a `genesis-` external id) were
 * rebuilt from spreadsheets and documents rather than watched as they
 * happened — `isReconstructedHistory` (`@events-os/shared`). They can go green
 * on all three axes and still not be the same claim as a live-captured row. A
 * ledger that silently merges the two is overclaiming, which reads as LESS
 * credible, not more (the argument `docs/plans/receipt-exceptions.md` already
 * makes, and the reason `historicalImportBatch` exists at all). So they're
 * reported as their own `reconstructed` line — inside the totals, because they
 * are genuinely part of the period being published, but never invisible.
 *
 * PERFORMANCE: one bounded indexed range read per book over
 * `by_chapter_and_postedAt` (never an unbounded `.collect()`), and every
 * per-row predicate is computed ONCE and counted in a single pass — the
 * `listReconcile` pattern. Coding state is read off the denormalized
 * `transactions.codingState`, so there is no per-row join into
 * `transactionCodings`.
 */
import { query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { CENTRAL, easternParts, isReconstructedHistory } from "@events-os/shared";
import { getChapterIdOrNull } from "./lib/context";
import type { FinanceScope } from "./lib/finance";
import { listActiveChapters } from "./lib/chapters";
import { readSandbox } from "./financeSettings";
import {
  isSpend,
  isUndocumented,
  requiresCoding,
  txnMatchesMode,
  ROLLUP_SCAN_LIMIT,
} from "./finances";
import { codingPolicy } from "./lib/transactionCoding";
import {
  requirePublishabilityAllBooks,
  requirePublishabilityReport,
} from "./lib/publishabilityAccess";

const DAY_MS = 24 * 60 * 60 * 1000;

// ── Validators ───────────────────────────────────────────────────────────────

/** One measured population: how many rows, and how many dollars they carry.
 *  Every figure in this report is a count AND a dollar total, because a close
 *  meeting asks both ("11 rows" is triage effort; "$46,200" is exposure) and
 *  reporting one without the other invites the wrong conclusion. Cents are
 *  `amountCents` as stored — always non-negative, direction lives in `flow`. */
const gap = v.object({ count: v.number(), cents: v.number() });

const bookTotals = v.object({
  /** Every row in the period that owes ANYTHING — i.e. the ledger about to be
   *  published. `excluded` rows are not in it (an intentional exclusion is not
   *  a transaction the org is claiming), matching `isUndocumented`/`isSpend`,
   *  which both refuse to count them. */
  inScope: gap,
  /** All three axes green — the rows that could be published today. */
  publishable: gap,
  /** Open on AT LEAST ONE axis. The UNION of the three below, never their
   *  sum — see the module doc. `inScope = publishable + blocked`, exactly. */
  blocked: gap,
  axes: v.object({
    /** No receipt and no approved receipt exception (`isUndocumented`). */
    documentation: gap,
    /** Owes a coding under the policy date and doesn't have an approved one. */
    coding: gap,
    /** Not yet `reconciled`. */
    review: gap,
  }),
  /** How the blocked rows distribute across the axes, so `blocked` and `axes`
   *  visibly reconcile: `documentation + coding + review = oneAxis + 2·twoAxes
   *  + 3·threeAxes`, and `blocked = oneAxis + twoAxes + threeAxes`. */
  overlap: v.object({ oneAxis: gap, twoAxes: gap, threeAxes: gap }),
  /** Rows rebuilt from spreadsheets rather than observed
   *  (`isReconstructedHistory`) — counted inside the totals above AND broken
   *  out here, because "green" means something different for them. */
  reconstructed: v.object({
    inScope: gap,
    blocked: gap,
    publishable: gap,
  }),
  /** Spend the coding policy grandfathers — posted before
   *  `codingRequiredSinceMs`, therefore owing no coding at all. Never part of
   *  `axes.coding`; reported so the exemption is stated, not silent. */
  codingExempt: gap,
});

const publishabilityReport = v.object({
  period: v.object({
    year: v.number(),
    /** `null` = the whole year. */
    month: v.union(v.number(), v.null()),
    label: v.string(),
  }),
  /** The policy date in force for this read (`financeSettings`, else the
   *  shared 2026-09-01 default) — the report has to be able to SAY which line
   *  its coding gap was measured against. */
  codingPolicySinceMs: v.number(),
  /** A book's scan hit `ROLLUP_SCAN_LIMIT` and the figures below are
   *  truncated. Surfaced rather than swallowed: an understated close-gate
   *  number is worse than a loud one. */
  truncated: v.boolean(),
  /** Every book this report covers, merged. */
  totals: bookTotals,
  /** The same figures per book — the doc's "counts by axis, per chapter". One
   *  entry for a single-book scope. */
  byBook: v.array(
    v.object({
      id: v.union(v.id("chapters"), v.literal(CENTRAL)),
      name: v.string(),
      totals: bookTotals,
    }),
  ),
});

// ── Accumulator ──────────────────────────────────────────────────────────────

type Gap = { count: number; cents: number };
type Totals = typeof bookTotals.type;

const zeroGap = (): Gap => ({ count: 0, cents: 0 });

function zeroTotals(): Totals {
  return {
    inScope: zeroGap(),
    publishable: zeroGap(),
    blocked: zeroGap(),
    axes: {
      documentation: zeroGap(),
      coding: zeroGap(),
      review: zeroGap(),
    },
    overlap: { oneAxis: zeroGap(), twoAxes: zeroGap(), threeAxes: zeroGap() },
    reconstructed: {
      inScope: zeroGap(),
      blocked: zeroGap(),
      publishable: zeroGap(),
    },
    codingExempt: zeroGap(),
  };
}

/** Add one row to a bucket. Every figure in the report is accumulated through
 *  this, so a count can never drift from the dollars beside it. */
function add(bucket: Gap, cents: number): void {
  bucket.count += 1;
  bucket.cents += cents;
}

/**
 * Fold ONE transaction into every totals bucket it belongs to. Each predicate
 * is evaluated exactly ONCE per row here — the same compute-flags-once-then-
 * count-in-one-pass shape as `listReconcile`'s `flagsFor`, and the reason a
 * whole period costs one scan rather than one scan per figure.
 *
 * `sinks` is normally the row's own book totals PLUS the merged org-wide
 * totals: a row lands in both, and running the predicates once for the pair is
 * what keeps `scope:"all"` the same cost per row as a single book.
 */
function accumulate(
  sinks: Totals[],
  tr: Doc<"transactions">,
  codingSinceMs: number,
): void {
  const cents = tr.amountCents;

  // DOCUMENTATION — the publishing predicate, status-blind on purpose.
  const documentationOpen = isUndocumented(tr);
  // CODING — the obligation is the policy's (`requiresCoding`: spend posted
  // on/after the policy date, nothing else), and "green" is an APPROVED
  // coding. A `submitted`/`changes_requested` coding is real work in flight
  // and still not publishable substantiation.
  const owesCoding = requiresCoding(tr, codingSinceMs);
  const codingOpen = owesCoding && tr.codingState !== "approved";
  // REVIEW — a human closed the row.
  const reviewOpen = tr.status !== "reconciled";

  const openAxes =
    (documentationOpen ? 1 : 0) + (codingOpen ? 1 : 0) + (reviewOpen ? 1 : 0);
  const blocked = openAxes > 0;
  const reconstructed = isReconstructedHistory(tr);

  // Grandfathered spend: it IS spend, and the policy asks nothing of it. The
  // `!owesCoding` half is what keeps pre-policy history out of `axes.coding` —
  // `requiresCoding` is the single place that decision is made.
  const codingExempt = !owesCoding && isSpend(tr);

  for (const totals of sinks) {
    add(totals.inScope, cents);
    if (documentationOpen) add(totals.axes.documentation, cents);
    if (codingOpen) add(totals.axes.coding, cents);
    if (reviewOpen) add(totals.axes.review, cents);
    if (blocked) {
      add(totals.blocked, cents);
      if (openAxes === 1) add(totals.overlap.oneAxis, cents);
      else if (openAxes === 2) add(totals.overlap.twoAxes, cents);
      else add(totals.overlap.threeAxes, cents);
    } else {
      add(totals.publishable, cents);
    }
    if (reconstructed) {
      add(totals.reconstructed.inScope, cents);
      add(
        blocked ? totals.reconstructed.blocked : totals.reconstructed.publishable,
        cents,
      );
    }
    if (codingExempt) add(totals.codingExempt, cents);
  }
}

// ── Period scan ──────────────────────────────────────────────────────────────

/**
 * One book's transactions for the period, via the `by_chapter_and_postedAt`
 * range — bounded, never a table scan, and never `.collect()`. The UTC window
 * is padded a day on each side to cover the Eastern offset, then narrowed
 * precisely in memory with `easternParts` (the finance timezone is
 * America/New_York everywhere in this codebase).
 *
 * This is deliberately a LOCAL copy of `finances.ts#loadPeriodTxns` +
 * `inDashRange`, which are unexported and in a file this workstream must not
 * edit — the same duplicate-with-a-comment arrangement `dashboardDrill.ts`
 * documents. Keep it in lockstep with the originals; delete it in favor of
 * them if they're ever exported.
 */
async function loadPeriodRows(
  ctx: QueryCtx,
  book: FinanceScope,
  year: number,
  month: number | undefined,
  sandboxMode: boolean,
): Promise<{ rows: Doc<"transactions">[]; truncated: boolean }> {
  const startUtc =
    (month != null ? Date.UTC(year, month - 1, 1) : Date.UTC(year, 0, 1)) - DAY_MS;
  const endUtc =
    (month != null ? Date.UTC(year, month, 1) : Date.UTC(year + 1, 0, 1)) + DAY_MS;
  const raw = await ctx.db
    .query("transactions")
    .withIndex("by_chapter_and_postedAt", (q) =>
      q.eq("chapterId", book).gte("postedAt", startUtc).lt("postedAt", endUtc),
    )
    .take(ROLLUP_SCAN_LIMIT);
  const truncated = raw.length === ROLLUP_SCAN_LIMIT;
  if (truncated) {
    console.warn(
      `[publishability] period read hit ROLLUP_SCAN_LIMIT (${ROLLUP_SCAN_LIMIT}) for ${book} ${year}${month ? `-${month}` : ""}; report truncated.`,
    );
  }
  const rows = raw.filter((tr) => {
    if (!txnMatchesMode(tr, sandboxMode)) return false;
    // An intentionally-excluded charge is not part of the ledger being
    // published, so it neither owes anything nor counts as green.
    if (tr.status === "excluded") return false;
    const p = easternParts(tr.postedAt);
    if (p.year !== year) return false;
    return month == null || p.month === month;
  });
  return { rows, truncated };
}

/** "August 2026" / "2026" — the period the report is about, resolved once
 *  server-side so every surface (and any future export) prints it the same. */
function periodLabel(year: number, month: number | undefined): string {
  if (month == null) return String(year);
  const name = new Date(Date.UTC(year, month - 1, 1)).toLocaleString("en-US", {
    month: "long",
    timeZone: "UTC",
  });
  return `${name} ${year}`;
}

// ── The report ───────────────────────────────────────────────────────────────

/**
 * THE CLOSE-GATE ARTIFACT — for one period and one book (or every book the
 * caller can reach), what still stands between it and publication.
 *
 * Scopes mirror `listReconcile`'s exactly, so a number here and the grid the
 * ED drills into afterwards are talking about the same rows:
 *   - default            the caller's own chapter
 *   - `scope:"central"`  central-owned money
 *   - `scope:"all"`      central + every active chapter, merged (and per-book
 *                        in `byBook`)
 *   - `chapterId`        a central viewer looking at one specific chapter
 *
 * Authorization is `lib/publishabilityAccess.ts` — never an inline seat or
 * finance-role check here (CLAUDE.md's "gate it behind a power, even when it's
 * open today"). Returns `null` for a caller with no chapter yet, matching the
 * app-wide convention that a READ degrades to empty rather than throwing at a
 * pre-onboarding user; a caller who HAS a chapter but lacks the power gets the
 * resolver's `ConvexError` (the mobile card's `FinanceBoundary` renders
 * nothing).
 */
export const report = query({
  args: {
    year: v.number(),
    /** 1–12. Absent = the whole year (the annual close). */
    month: v.optional(v.number()),
    scope: v.optional(v.union(v.literal("central"), v.literal("all"))),
    chapterId: v.optional(v.id("chapters")),
  },
  returns: v.union(publishabilityReport, v.null()),
  handler: async (ctx, args) => {
    const homeChapterId = (await getChapterIdOrNull(ctx)) as Id<"chapters"> | null;
    if (!homeChapterId) return null;

    // Which BOOKS this report covers. A transaction's own `chapterId` IS its
    // book id (the `"central"` sentinel for central-owned money), so nothing
    // extra has to be threaded through the scan to know where a row came from.
    let books: FinanceScope[];
    if (args.scope === "all") {
      await requirePublishabilityAllBooks(ctx, homeChapterId);
      const chapters = await listActiveChapters(ctx, ROLLUP_SCAN_LIMIT);
      books = [CENTRAL, ...chapters.map((c) => c._id)];
    } else if (args.scope === "central") {
      await requirePublishabilityReport(ctx, homeChapterId, CENTRAL);
      books = [CENTRAL];
    } else {
      const book = args.chapterId ?? homeChapterId;
      await requirePublishabilityReport(ctx, homeChapterId, book);
      books = [book];
    }

    const sandboxMode = await readSandbox(ctx);
    // The policy date, read ONCE per query and consulted per row — the same
    // discipline `listReconcile` uses for its `uncoded` facet. Reading it per
    // book (let alone per row) would be a `financeSettings` query per row for
    // a value that cannot change mid-read.
    const { sinceMs: codingSinceMs } = await codingPolicy(ctx);

    const totals = zeroTotals();
    const byBook: (typeof publishabilityReport.type)["byBook"] = [];
    let truncated = false;

    for (const book of books) {
      const bookTotalsAcc = zeroTotals();
      const loaded = await loadPeriodRows(
        ctx,
        book,
        args.year,
        args.month,
        sandboxMode,
      );
      truncated = truncated || loaded.truncated;
      // One pass, two sinks: this book's own line and the merged totals.
      const sinks = [bookTotalsAcc, totals];
      for (const tr of loaded.rows) accumulate(sinks, tr, codingSinceMs);
      const name =
        book === CENTRAL ? "Central" : ((await ctx.db.get(book))?.name ?? "Chapter");
      byBook.push({ id: book, name, totals: bookTotalsAcc });
    }

    return {
      period: {
        year: args.year,
        month: args.month ?? null,
        label: periodLabel(args.year, args.month),
      },
      codingPolicySinceMs: codingSinceMs,
      truncated,
      totals,
      byBook,
    };
  },
});
