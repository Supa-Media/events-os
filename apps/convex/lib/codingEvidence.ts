/**
 * Coding-evidence builder — turns a bounded window of the chapter's RECENT
 * transactions into two compact, grounded signals the LLM auto-coding prompt
 * can weigh (see `aiCodingData.gatherSuggestionContext` for the DB read that
 * feeds it, and `aiCoding.ts` for how the action renders it into the prompt):
 *
 *  1. MERCHANT HISTORY — "a charge that looks like this one (same/similar
 *     merchant) was previously coded, by a human, to category/budget X, n
 *     times." Drawn ONLY from human-confirmed codings (a transaction a human
 *     categorized, or whose AI suggestion a human accepted — both land as a
 *     `categorized`/`reconciled` row carrying a real category/budget), never
 *     from another un-accepted AI suggestion. This is the strongest signal we
 *     have and it was previously absent from the prompt entirely.
 *  2. CANDIDATE-BUDGET SPEND — the `reconcileSuggest` tier-1/tier-2 evidence
 *     ("we've been spending on this budget lately" / "a similar merchant was
 *     coded here"), but computed for the event/project budgets already in the
 *     model's context so it can prefer a budget with real corroborating spend.
 *
 * PURE — no Convex imports, so it's unit-tested directly (`codingEvidence.
 * test.ts`) and the DB read stays a thin adapter around it. All merchant
 * comparison goes through `lib/merchantSimilarity` so "similar merchant" means
 * exactly what the "For" picker's ranker means by it.
 */
import { merchantMatch, type MerchantLike } from "./merchantSimilarity";

/** The subset of a transaction the evidence builder reasons over. Ids are
 *  plain strings here (the pure layer is id-type-agnostic); the caller passes
 *  the real `Id<...>` values and resolves them back to docs/names. */
export interface EvidenceTxn extends MerchantLike {
  id: string;
  postedAt: number;
  status: string;
  categoryId?: string | null;
  budgetId?: string | null;
}

/** One "this merchant was previously coded to X" row, keyed by the dimension
 *  (`category` or `budget`) and the target id. `exact` is true when at least
 *  one contributing prior charge was an EXACT merchant match (a stronger
 *  signal than fuzzy token overlap). */
export interface MerchantHistoryEntry {
  kind: "category" | "budget";
  id: string;
  count: number;
  exact: boolean;
}

/** Tier-1/tier-2 corroboration for ONE candidate budget already in context. */
export interface CandidateBudgetEvidence {
  budgetId: string;
  /** Tier-1: prior charges on this budget within `nearbyWindowMs` of the
   *  subject's `postedAt` ("spending here lately"). */
  nearbyCount: number;
  /** Tier-2: a prior charge on this budget with a similar merchant. */
  similarMerchant: boolean;
}

export interface CodingEvidence {
  merchantHistory: MerchantHistoryEntry[];
  candidateBudgetEvidence: CandidateBudgetEvidence[];
}

/** A human-confirmed coding is a `categorized`/`reconciled` row that actually
 *  carries a category or budget — the states `acceptSuggestion` and the manual
 *  `categorizeTransaction` path both produce. An `unreviewed` row (even one
 *  carrying an un-accepted `aiSuggestion`) is explicitly NOT evidence: the
 *  whole point is to learn from HUMAN decisions, not from the model's own
 *  prior guesses. */
function isHumanCoded(t: EvidenceTxn): boolean {
  const settled = t.status === "categorized" || t.status === "reconciled";
  return settled && (t.categoryId != null || t.budgetId != null);
}

/**
 * Build the two evidence signals for one subject charge from `priorTxns` (a
 * bounded, already-filtered recent window — the caller drops the subject
 * itself, excluded/personal rows, and applies the sandbox-mode filter).
 * Deterministic ordering (count desc, exact-first, then id) so the prompt is
 * stable across runs and the unit tests can pin it.
 */
export function buildCodingEvidence(params: {
  subject: MerchantLike & { postedAt: number };
  priorTxns: EvidenceTxn[];
  candidateBudgetIds: Set<string>;
  nearbyWindowMs: number;
  /** Max entries per signal handed to the model — keeps the prompt bounded. */
  topK: number;
}): CodingEvidence {
  const { subject, priorTxns, candidateBudgetIds, nearbyWindowMs, topK } =
    params;

  // ── Signal 1: merchant history from human-confirmed codings ──────────────
  const catAgg = new Map<string, { count: number; exact: boolean }>();
  const budgetAgg = new Map<string, { count: number; exact: boolean }>();
  const bump = (
    agg: Map<string, { count: number; exact: boolean }>,
    id: string,
    exact: boolean,
  ) => {
    const cur = agg.get(id) ?? { count: 0, exact: false };
    cur.count += 1;
    cur.exact = cur.exact || exact;
    agg.set(id, cur);
  };

  for (const t of priorTxns) {
    if (!isHumanCoded(t)) continue;
    const match = merchantMatch(subject, t);
    if (!match) continue;
    const exact = match === "exact";
    if (t.categoryId != null) bump(catAgg, t.categoryId, exact);
    if (t.budgetId != null) bump(budgetAgg, t.budgetId, exact);
  }

  const merchantHistory: MerchantHistoryEntry[] = [
    ...[...catAgg].map(
      ([id, v]): MerchantHistoryEntry => ({ kind: "category", id, ...v }),
    ),
    ...[...budgetAgg].map(
      ([id, v]): MerchantHistoryEntry => ({ kind: "budget", id, ...v }),
    ),
  ]
    .sort(
      (a, b) =>
        b.count - a.count ||
        Number(b.exact) - Number(a.exact) ||
        a.id.localeCompare(b.id),
    )
    .slice(0, topK);

  // ── Signal 2: tier-1/tier-2 spend on candidate budgets ───────────────────
  const budgetEvidence = new Map<
    string,
    { nearbyCount: number; similarMerchant: boolean }
  >();
  for (const t of priorTxns) {
    if (t.budgetId == null || !candidateBudgetIds.has(t.budgetId)) continue;
    const cur = budgetEvidence.get(t.budgetId) ?? {
      nearbyCount: 0,
      similarMerchant: false,
    };
    if (Math.abs(t.postedAt - subject.postedAt) <= nearbyWindowMs) {
      cur.nearbyCount += 1;
    }
    if (merchantMatch(subject, t) != null) cur.similarMerchant = true;
    budgetEvidence.set(t.budgetId, cur);
  }

  const candidateBudgetEvidence: CandidateBudgetEvidence[] = [...budgetEvidence]
    .map(
      ([budgetId, v]): CandidateBudgetEvidence => ({ budgetId, ...v }),
    )
    .filter((e) => e.nearbyCount > 0 || e.similarMerchant)
    .sort(
      (a, b) =>
        Number(b.similarMerchant) - Number(a.similarMerchant) ||
        b.nearbyCount - a.nearbyCount ||
        a.budgetId.localeCompare(b.budgetId),
    )
    .slice(0, topK);

  return { merchantHistory, candidateBudgetEvidence };
}
