/**
 * The "For" picker's RANKING (WP: reduce-the-scroll) — `rankForPicker` ranks
 * the picker's Events/Projects/Recurring candidates for ONE transaction so
 * the bookkeeper sees the likely home first instead of an unranked dump of
 * every budget-less task-shaped project (the owner's "very bad" report).
 *
 * OWNERSHIP: intentionally separate from `finances.ts` (whose budget/
 * transaction-write region is owned by a parallel WP) — mirrors `moneyViews.
 * ts`'s discipline: every read here either RE-DERIVES its own bounded index
 * scan (the candidate gather below duplicates `finances.forPickerOptions`'s
 * exact events/projects/budgets scan + one-budget-per-ref dedup so the
 * ranked list's candidates never drift from the base picker's) or imports an
 * already-exported, stable helper (`ROLLUP_SCAN_LIMIT`, `txnMatchesMode`).
 * READ-ONLY: this file never writes `transactions`/`budgets` — attribution
 * itself still only ever happens through `finances.categorizeTransaction` /
 * `summonBudgetForRef`, called by the client AFTER a pick (see `forPicker.ts`
 * on the mobile side). No ranking heuristic here moves money.
 *
 * ── The four tiers (owner spec, verbatim intent) ─────────────────────────
 *  1. The ref's linked budget already has a transaction posted within ±10
 *     days of this charge's date — "we've been spending around here lately."
 *  2. The ref's linked budget already has a SIMILAR transaction categorized
 *     to it (normalized merchant/description token overlap; an EXACT
 *     normalized-merchant match outranks a fuzzy token-overlap one).
 *  3. The ref's own date (an event's `eventDate`, a project's `deadline`) is
 *     within ±45 days of this charge's date, nearest first. Applies even to
 *     a BUDGET-LESS ref (summon-candidates still deserve a date-based rank).
 *  4. Everything else — the base grouped list (Events / Projects / Recurring
 *     · Chapter / Recurring · Central), budget-less refs demoted to a
 *     trailing "no budget yet" subsection PER GROUP (placement fix only —
 *     the summon-$0 flow stays available there, per the owner's "it's
 *     placement, not existence" framing).
 * A ref appears exactly once, in its BEST (lowest-numbered) tier.
 *
 * ── Search (owner addendum) ───────────────────────────────────────────────
 * An optional `search` arg filters the SAME candidate set server-side,
 * matching normalized tokens against the ref's label, date representations
 * (month name/abbrev, day, "m/d", "m/d/yyyy", year), the linked budget's own
 * label, and a type keyword ("event"/"project"/"recurring"). Matches are
 * ranked by match quality (label-prefix > token match > date-token match >
 * loose substring) then by the row's tier — a flat list, not sectioned (the
 * mobile side renders search results without the Suggested/grouped split).
 */
import { query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import { Doc, Id } from "./_generated/dataModel";
import {
  CENTRAL,
  FINANCE_TIMEZONE,
  BUDGET_TYPE_LABELS,
  type BudgetType,
} from "@events-os/shared";
import { getChapterIdOrNull } from "./lib/context";
import {
  requireFinanceRole,
  requireFinanceCentral,
  type FinanceScope,
} from "./lib/finance";
import { readSandbox } from "./financeSettings";
import { ROLLUP_SCAN_LIMIT, txnMatchesMode } from "./finances";

// ── Scan bounds ───────────────────────────────────────────────────────────
// Top-level events/projects/budgets scans mirror `forPickerOptions`'s own
// bound exactly (same constant) so the ranked candidate set is NEVER a
// subset/superset of the base picker's — every ref the base picker can show,
// this can rank, and vice versa.
const TOP_LEVEL_SCAN_LIMIT = ROLLUP_SCAN_LIMIT;
// Per-candidate-budget transaction scan (tier 1/2 evidence). Bounded —
// human-authored budgets/spend, never a synced feed at this per-budget
// granularity (mirrors `moneyViews.ts`'s own per-budget `SCAN_LIMIT` bound).
const TXN_PER_BUDGET_SCAN_LIMIT = 300;

const NEARBY_WINDOW_MS = 10 * 24 * 60 * 60 * 1000;
const DEADLINE_WINDOW_MS = 45 * 24 * 60 * 60 * 1000;

// ── Date / label formatting (mirrors `finances.ts#pickerRefLabel`'s output
// exactly — "Mon D, YYYY" — so a ranked row's label reads identically to the
// same ref's label in the base grouped list) ────────────────────────────────
function shortDateLabel(ts: number): string {
  return new Date(ts).toLocaleDateString("en-US", {
    timeZone: FINANCE_TIMEZONE,
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
function fullMonthName(ts: number): string {
  return new Date(ts).toLocaleDateString("en-US", {
    timeZone: FINANCE_TIMEZONE,
    month: "long",
  });
}
function pickerRefLabel(name: string, ts: number): string {
  return `${name} · ${shortDateLabel(ts)}`;
}

/** A budget's v2 `type`, tolerant of un-migrated legacy rows — mirrors
 *  `finances.ts#effectiveType` (not exported; re-derived here per the module
 *  doc's ownership discipline). */
function effectiveBudgetType(b: Doc<"budgets">): BudgetType {
  if (b.type) return b.type;
  return b.scope === "event" || b.scope === "project" ? "one_time" : "recurring";
}
/** Mirrors `finances.ts#budgetDisplayName` (not exported). */
function budgetDisplayName(b: Doc<"budgets">): string {
  return b.label?.trim() || BUDGET_TYPE_LABELS[effectiveBudgetType(b)];
}

// ── Candidate gather (mirrors `finances.forPickerOptions`'s exact scan +
// one-budget-per-ref dedup, so the ranked set never drifts from the base
// picker's — see the module doc) ────────────────────────────────────────────
type Candidate = {
  refKind: "event" | "project" | "recurring";
  refId: string;
  label: string;
  /** The ref's own date for TIER 3 ranking — event's `eventDate`, project's
   *  `deadline` ONLY (per owner spec, not the closer-of-start/deadline the
   *  base list's label uses). `null` for a recurring budget (no ref date) or
   *  a deadline-less project. */
  tier3Ts: number | null;
  budget: Doc<"budgets"> | null;
  level: "chapter" | "central" | null;
};

async function gatherCandidates(
  ctx: QueryCtx,
  homeChapterId: Id<"chapters">,
): Promise<Candidate[]> {
  const [events, projects, chapterBudgets, centralBudgets] = await Promise.all([
    ctx.db
      .query("events")
      .withIndex("by_chapter", (q) => q.eq("chapterId", homeChapterId))
      .take(TOP_LEVEL_SCAN_LIMIT),
    ctx.db
      .query("projects")
      .withIndex("by_chapter", (q) => q.eq("chapterId", homeChapterId))
      .take(TOP_LEVEL_SCAN_LIMIT),
    ctx.db
      .query("budgets")
      .withIndex("by_chapter", (q) => q.eq("chapterId", homeChapterId))
      .take(TOP_LEVEL_SCAN_LIMIT),
    ctx.db
      .query("budgets")
      .withIndex("by_chapter", (q) => q.eq("chapterId", CENTRAL))
      .take(TOP_LEVEL_SCAN_LIMIT),
  ]);
  if (
    events.length === TOP_LEVEL_SCAN_LIMIT ||
    projects.length === TOP_LEVEL_SCAN_LIMIT ||
    chapterBudgets.length === TOP_LEVEL_SCAN_LIMIT ||
    centralBudgets.length === TOP_LEVEL_SCAN_LIMIT
  ) {
    console.warn(
      `[reconcileSuggest] rankForPicker hit TOP_LEVEL_SCAN_LIMIT (${TOP_LEVEL_SCAN_LIMIT}) gathering candidates for chapter ${homeChapterId}; ranked list may be truncated.`,
    );
  }
  const projectIds = new Set(projects.map((p) => p._id as string));

  const eventBudgetByRef = new Map<string, Doc<"budgets">>();
  const projectBudgetByRef = new Map<string, Doc<"budgets">>();
  const recurring: { budget: Doc<"budgets">; level: "chapter" | "central" }[] = [];

  // Same "keep the OLDEST" dedup rule as `forPickerOptions` (a ref should
  // only ever have one budget — the D8 invariant — but legacy data can carry
  // a duplicate; this keeps the ranked pick's budgetId identical to the base
  // picker's, so the same ref never appears at two different budgetIds
  // across the two lists).
  const setPreferOldest = (
    map: Map<string, Doc<"budgets">>,
    key: string,
    candidate: Doc<"budgets">,
  ) => {
    const existing = map.get(key);
    if (!existing || candidate.createdAt < existing.createdAt) {
      map.set(key, candidate);
    }
  };

  for (const b of chapterBudgets) {
    if (b.type === "one_time" && b.refKind === "event" && b.scopeRefId) {
      setPreferOldest(eventBudgetByRef, b.scopeRefId, b);
    } else if (b.type === "one_time" && b.refKind === "project" && b.scopeRefId) {
      setPreferOldest(projectBudgetByRef, b.scopeRefId, b);
    } else {
      recurring.push({ budget: b, level: "chapter" });
    }
  }
  for (const b of centralBudgets) {
    if (
      b.type === "one_time" &&
      b.refKind === "project" &&
      b.scopeRefId &&
      projectIds.has(b.scopeRefId)
    ) {
      setPreferOldest(projectBudgetByRef, b.scopeRefId, b);
    } else {
      recurring.push({ budget: b, level: "central" });
    }
  }

  const candidates: Candidate[] = [];
  for (const e of events) {
    if (e.isTraining) continue;
    candidates.push({
      refKind: "event",
      refId: e._id,
      label: pickerRefLabel(e.name, e.eventDate),
      tier3Ts: e.eventDate,
      budget: eventBudgetByRef.get(e._id as string) ?? null,
      level: null,
    });
  }
  for (const p of projects) {
    candidates.push({
      refKind: "project",
      refId: p._id,
      label: pickerRefLabel(p.name, p.startDate ?? p.createdAt),
      tier3Ts: p.deadline ?? null,
      budget: projectBudgetByRef.get(p._id as string) ?? null,
      level: null,
    });
  }
  for (const r of recurring) {
    candidates.push({
      refKind: "recurring",
      refId: r.budget._id,
      label: budgetDisplayName(r.budget),
      tier3Ts: null,
      budget: r.budget,
      level: r.level,
    });
  }
  return candidates;
}

// ── Tier 1/2 evidence: a candidate's OWN budget's already-categorized spend
// (bounded per-budget `by_budget` index scan) ───────────────────────────────
const MERCHANT_STOPWORDS = new Set([
  "inc",
  "llc",
  "corp",
  "co",
  "the",
  "sq",
  "pos",
  "payment",
  "purchase",
  "store",
  "of",
  "and",
  "a",
  "an",
]);

function normalizeMerchantText(text: string | null | undefined): string {
  return (text ?? "").trim().toLowerCase();
}

/** Shared base tokenizer — lowercase, strip to alnum + space, split on
 *  whitespace. Deliberately applies NO stopword/length filtering: that's a
 *  policy decision each CALLER makes on top (merchant-similarity matching
 *  filters noise words to avoid false-positive fuzzy matches on things like
 *  "LLC"/"Inc"; label SEARCH must not — a literal word in an event/project
 *  name, even a common one like "The" or "And", still has to be matchable).
 *  Using one shared base keeps the two policies from silently drifting apart
 *  (the bug this fixes: label search used to reuse `merchantTokens`, which
 *  strips exactly the words a multi-word label match needed). */
function baseTokens(text: string | null | undefined): string[] {
  return (text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** Tier 2's OWN token policy (merchant/description similarity) — noise words
 *  and 1-char tokens filtered so "SQ *HOME DEPOT INC" fuzzy-matches "Home
 *  Depot Supply Co" without every merchant string spuriously overlapping on
 *  "inc"/"co"/"the". */
function merchantTokens(...texts: (string | null | undefined)[]): Set<string> {
  const combined = texts.filter(Boolean).join(" ");
  return new Set(
    baseTokens(combined).filter((t) => t.length > 1 && !MERCHANT_STOPWORDS.has(t)),
  );
}

/** Search's label-token policy — NO stopword/length filtering (see
 *  `baseTokens`'s doc comment). Used for the ref's own label + its linked
 *  budget's label, never for merchant similarity. */
function labelTokens(...texts: (string | null | undefined)[]): Set<string> {
  const combined = texts.filter(Boolean).join(" ");
  return new Set(baseTokens(combined));
}

/** Load a candidate budget's spend, capped + sandbox/excluded-filtered so
 *  tier 1/2 evidence only ever comes from txns actually visible on the
 *  reconcile surface — never a hidden-mode Increase sync row or an
 *  intentionally-excluded charge. NEWEST-first (`.order("desc")` — by the
 *  index's implicit `_creationTime` tiebreak): tier 1/2 evidence should
 *  reflect RECENT categorization behavior. Without this, a long-lived budget
 *  with more history than the per-budget cap would have its OLDEST rows win
 *  the cap (Convex's default index order is ascending), silently burying a
 *  txn from last week behind hundreds of rows from last year — exactly
 *  backwards for "is this where we've been spending lately." */
async function loadBudgetTxns(
  ctx: QueryCtx,
  budgetId: Id<"budgets">,
  sandboxMode: boolean,
): Promise<{ rows: Doc<"transactions">[]; truncated: boolean }> {
  const rows = await ctx.db
    .query("transactions")
    .withIndex("by_budget", (q) => q.eq("budgetId", budgetId))
    .order("desc")
    .take(TXN_PER_BUDGET_SCAN_LIMIT);
  const filtered = rows.filter(
    (t) => t.status !== "excluded" && txnMatchesMode(t, sandboxMode),
  );
  return { rows: filtered, truncated: rows.length === TXN_PER_BUDGET_SCAN_LIMIT };
}

function tier1Evidence(
  budgetTxns: Doc<"transactions">[],
  txn: Doc<"transactions">,
): { count: number } | null {
  const nearby = budgetTxns.filter(
    (t) =>
      t._id !== txn._id &&
      Math.abs(t.postedAt - txn.postedAt) <= NEARBY_WINDOW_MS,
  );
  return nearby.length > 0 ? { count: nearby.length } : null;
}

function tier2Evidence(
  budgetTxns: Doc<"transactions">[],
  txn: Doc<"transactions">,
): { exact: boolean; label: string } | null {
  const targetMerchant = normalizeMerchantText(txn.merchantName);
  const targetDesc = normalizeMerchantText(txn.description);
  const targetTokens = merchantTokens(txn.merchantName, txn.description);
  if (!targetMerchant && !targetDesc && targetTokens.size === 0) return null;

  let fuzzy: { exact: boolean; label: string } | null = null;
  for (const t of budgetTxns) {
    if (t._id === txn._id) continue;
    const candidateMerchant = normalizeMerchantText(t.merchantName);
    const candidateDesc = normalizeMerchantText(t.description);
    const isExact =
      (!!targetMerchant && targetMerchant === candidateMerchant) ||
      (!!targetDesc && targetDesc === candidateDesc);
    const label = t.merchantName ?? t.description ?? "";
    if (isExact) return { exact: true, label };
    if (!fuzzy) {
      const overlap = merchantTokens(t.merchantName, t.description);
      const shared = [...targetTokens].some((tok) => overlap.has(tok));
      if (shared) fuzzy = { exact: false, label };
    }
  }
  return fuzzy;
}

function tier1Reason(count: number, txnPostedAt: number): string {
  const month = fullMonthName(txnPostedAt);
  return `${count} transaction${count === 1 ? "" : "s"} nearby in ${month}`;
}
function tier2Reason(label: string): string {
  const clean = label.trim();
  return clean ? `Similar: '${clean}' coded here` : "Similar transaction coded here";
}
function tier3Reason(refKind: "event" | "project", diffDays: number): string {
  const noun = refKind === "event" ? "Event date" : "Project deadline";
  if (diffDays === 0) return `${noun} is today`;
  return `${noun} ${diffDays} day${diffDays === 1 ? "" : "s"} away`;
}

// ── The public row shape + query ─────────────────────────────────────────
const rankedRow = v.object({
  tier: v.union(v.literal(1), v.literal(2), v.literal(3), v.literal(4)),
  reason: v.union(v.string(), v.null()),
  refKind: v.union(v.literal("event"), v.literal("project"), v.literal("recurring")),
  refId: v.string(),
  label: v.string(),
  dateLabel: v.union(v.string(), v.null()),
  budgetId: v.union(v.id("budgets"), v.null()),
  level: v.union(v.literal("chapter"), v.literal("central"), v.null()),
  hasBudget: v.boolean(),
});

// Internal scratch shape carrying the sort keys the public row drops.
type ScoredRow = {
  tier: 1 | 2 | 3 | 4;
  reason: string | null;
  refKind: "event" | "project" | "recurring";
  refId: string;
  label: string;
  dateLabel: string | null;
  budgetId: Id<"budgets"> | null;
  level: "chapter" | "central" | null;
  hasBudget: boolean;
  // Sort-only:
  tier1Count: number;
  tier2ExactRank: number; // 0 = exact, 1 = fuzzy
  tier3DiffDays: number;
  groupOrder: number; // event=0, project=1, recurring-chapter=2, recurring-central=3
};

function groupOrderFor(c: Candidate): number {
  if (c.refKind === "event") return 0;
  if (c.refKind === "project") return 1;
  return c.level === "chapter" ? 2 : 3;
}

// ── Search matching (owner addendum) ────────────────────────────────────────
function normalizeSearchText(s: string): string {
  return s.trim().toLowerCase();
}
function tokenizeSearch(s: string): string[] {
  return normalizeSearchText(s)
    .replace(/[^a-z0-9\s/:-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}
/** Every date representation a search token might hit: month name/abbrev,
 *  day, year, "m/d", "m/d/yyyy" — plus a recurring budget's own `year`. */
function dateSearchTokens(ts: number | null, budget: Doc<"budgets"> | null): Set<string> {
  const tokens = new Set<string>();
  if (ts != null) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: FINANCE_TIMEZONE,
      year: "numeric",
      month: "long",
      day: "numeric",
    }).formatToParts(new Date(ts));
    const byType: Record<string, string> = {};
    for (const p of parts) byType[p.type] = p.value;
    const monthLong = (byType.month ?? "").toLowerCase();
    const monthShort = monthLong.slice(0, 3);
    const day = byType.day ?? "";
    const year = byType.year ?? "";
    const monthNum = new Intl.DateTimeFormat("en-US", {
      timeZone: FINANCE_TIMEZONE,
      month: "numeric",
    }).format(new Date(ts));
    if (monthLong) tokens.add(monthLong);
    if (monthShort) tokens.add(monthShort);
    if (day) tokens.add(day);
    if (year) tokens.add(year);
    if (monthNum && day) {
      tokens.add(`${monthNum}/${day}`);
      if (year) tokens.add(`${monthNum}/${day}/${year}`);
    }
  }
  if (budget) tokens.add(String(budget.year));
  return tokens;
}

/** Match quality bucket (lower = better), or `null` for no match at all. A
 *  multi-token query needs EVERY token accounted for by SOME signal (label
 *  token, date token, or type keyword) — an AND across tokens, not an OR. */
function matchBucket(
  candidate: Candidate,
  queryTokens: string[],
  normalizedQuery: string,
): number | null {
  const labelNorm = normalizeSearchText(candidate.label);
  if (labelNorm.startsWith(normalizedQuery)) return 0;

  // Label search uses `labelTokens` (NO stopword/length filtering) — NOT
  // `merchantTokens`, which would silently drop a legitimate word like "The"
  // or "And" from a multi-word event/project name (see `baseTokens`'s doc).
  const candidateLabelTokens = labelTokens(candidate.label, candidate.budget?.label);
  candidateLabelTokens.add(candidate.refKind); // type keyword: "event" / "project" / "recurring"
  const dTokens = dateSearchTokens(candidate.tier3Ts, candidate.budget);

  const coveredByLabel = queryTokens.every((t) => candidateLabelTokens.has(t));
  if (coveredByLabel) return 1;

  const coveredByEither = queryTokens.every((t) => candidateLabelTokens.has(t) || dTokens.has(t));
  const anyDateHit = queryTokens.some((t) => dTokens.has(t));
  if (coveredByEither && anyDateHit) return 2;

  if (labelNorm.includes(normalizedQuery)) return 3;
  return null;
}

export const rankForPicker = query({
  args: {
    transactionId: v.id("transactions"),
    search: v.optional(v.string()),
  },
  returns: v.object({
    rows: v.array(rankedRow),
    searching: v.boolean(),
    truncated: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const empty = { rows: [], searching: false, truncated: false };

    // Gate: mirrors `finances.listReconcile`'s exact resolution — a chapter
    // viewer for a chapter-owned txn, central reach for a central-owned one —
    // just derived from the TRANSACTION's own `chapterId` instead of a client
    // `scope` arg (this endpoint always ranks for one specific, already-known
    // txn).
    const homeChapterId = (await getChapterIdOrNull(ctx)) as Id<"chapters"> | null;
    if (!homeChapterId) return empty;
    const txn = await ctx.db.get(args.transactionId);
    if (!txn) return empty;
    let scope: FinanceScope;
    if (txn.chapterId === CENTRAL) {
      await requireFinanceCentral(ctx, homeChapterId);
      scope = CENTRAL;
    } else {
      await requireFinanceRole(ctx, homeChapterId, "viewer");
      if (txn.chapterId !== homeChapterId) return empty;
      scope = homeChapterId;
    }

    const allCandidates = await gatherCandidates(ctx, homeChapterId);
    // A CENTRAL-owned txn can only ever attribute to a central budget
    // (`categorizeTransaction`'s own gate) — mirrors the Reconcile grid's
    // existing client-side restriction (`reconcile.tsx`'s `centralScope`
    // branch): only "Recurring · Central" is offered, never events/projects
    // or a chapter budget.
    const candidates =
      scope === CENTRAL
        ? allCandidates.filter((c) => c.refKind === "recurring" && c.level === "central")
        : allCandidates;

    const sandboxMode = await readSandbox(ctx);
    let truncated = false;

    const scored = await Promise.all(
      candidates.map(async (c): Promise<ScoredRow> => {
        const base = {
          refKind: c.refKind,
          refId: c.refId,
          label: c.label,
          dateLabel: c.refKind === "recurring" ? null : c.tier3Ts != null ? shortDateLabel(c.tier3Ts) : null,
          budgetId: c.budget?._id ?? null,
          level: c.level,
          hasBudget: c.budget != null,
          groupOrder: groupOrderFor(c),
        };

        if (c.budget) {
          const { rows, truncated: t } = await loadBudgetTxns(ctx, c.budget._id, sandboxMode);
          if (t) truncated = true;
          const t1 = tier1Evidence(rows, txn);
          if (t1) {
            return {
              ...base,
              tier: 1,
              reason: tier1Reason(t1.count, txn.postedAt),
              tier1Count: t1.count,
              tier2ExactRank: 2,
              tier3DiffDays: Number.POSITIVE_INFINITY,
            };
          }
          const t2 = tier2Evidence(rows, txn);
          if (t2) {
            return {
              ...base,
              tier: 2,
              reason: tier2Reason(t2.label),
              tier1Count: 0,
              tier2ExactRank: t2.exact ? 0 : 1,
              tier3DiffDays: Number.POSITIVE_INFINITY,
            };
          }
        }

        if (c.tier3Ts != null) {
          const diffMs = Math.abs(c.tier3Ts - txn.postedAt);
          if (diffMs <= DEADLINE_WINDOW_MS) {
            const diffDays = Math.round(diffMs / (24 * 60 * 60 * 1000));
            return {
              ...base,
              tier: 3,
              reason: tier3Reason(c.refKind as "event" | "project", diffDays),
              tier1Count: 0,
              tier2ExactRank: 2,
              tier3DiffDays: diffDays,
            };
          }
        }

        return {
          ...base,
          tier: 4,
          reason: null,
          tier1Count: 0,
          tier2ExactRank: 2,
          tier3DiffDays: Number.POSITIVE_INFINITY,
        };
      }),
    );

    const searchRaw = args.search?.trim() ?? "";
    const queryTokens = searchRaw.length > 0 ? tokenizeSearch(searchRaw) : [];
    // A query with no matchable alnum content (e.g. "!!!") tokenizes to ZERO
    // tokens. Gating on `queryTokens.length` (not `searchRaw.length`) matters:
    // `matchBucket`'s `queryTokens.every(...)` is vacuously TRUE for an empty
    // array, which would otherwise match every candidate — the opposite of
    // "no matchable search text". Treat it as no search at all.
    if (queryTokens.length > 0) {
      const normalizedQuery = normalizeSearchText(searchRaw);
      const matched = scored
        .map((row) => {
          const candidate = candidates.find(
            (c) => c.refKind === row.refKind && c.refId === row.refId,
          )!;
          const bucket = matchBucket(candidate, queryTokens, normalizedQuery);
          return bucket == null ? null : { row, bucket };
        })
        .filter((x): x is { row: ScoredRow; bucket: number } => x != null)
        .sort((a, b) => a.bucket - b.bucket || a.row.tier - b.row.tier || a.row.label.localeCompare(b.row.label))
        .map((x) => x.row);
      return {
        rows: matched.map(toPublicRow),
        searching: true,
        truncated,
      };
    }

    scored.sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier;
      switch (a.tier) {
        case 1:
          return b.tier1Count - a.tier1Count || a.label.localeCompare(b.label);
        case 2:
          return a.tier2ExactRank - b.tier2ExactRank || a.label.localeCompare(b.label);
        case 3:
          return a.tier3DiffDays - b.tier3DiffDays || a.label.localeCompare(b.label);
        default:
          if (a.groupOrder !== b.groupOrder) return a.groupOrder - b.groupOrder;
          if (a.hasBudget !== b.hasBudget) return a.hasBudget ? -1 : 1;
          return a.label.localeCompare(b.label);
      }
    });

    return { rows: scored.map(toPublicRow), searching: false, truncated };
  },
});

function toPublicRow(r: ScoredRow): typeof rankedRow.type {
  return {
    tier: r.tier,
    reason: r.reason,
    refKind: r.refKind,
    refId: r.refId,
    label: r.label,
    dateLabel: r.dateLabel,
    budgetId: r.budgetId,
    level: r.level,
    hasBudget: r.hasBudget,
  };
}
