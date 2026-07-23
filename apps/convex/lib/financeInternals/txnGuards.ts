import { ConvexError } from "convex/values";
import { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { CENTRAL, countsAsSpend, easternParts, quarterOfMonth, matchesMode } from "@events-os/shared";
import type { FinanceScope } from "../finance";
import { getChapterIdOrNull } from "../context";
import { ROLLUP_SCAN_LIMIT, DAY_MS } from "./constants";

/**
 * Enforce the non-negative-integer-cents invariant the validator can't.
 * Exported (review fix) so the entity-side no-row branches
 * (`events.updateDetails` / `projects.update`) can validate BEFORE writing
 * straight to the field — the same check the row branch already gets for
 * free via `setBudgetAmount`.
 */
export function assertIntegerCents(amountCents: number, label = "Amount"): void {
  if (!Number.isInteger(amountCents) || amountCents < 0) {
    throw new ConvexError({
      code: "INVALID_AMOUNT",
      message: `${label} must be a non-negative whole number of cents.`,
    });
  }
}

/**
 * Load a document by id and assert it belongs to the caller's chapter. When
 * `allowCentral`, an org-level doc passes too: a central budget (`chapterId ===
 * "central"`, the CENTRAL sentinel) or a central finance team (absent
 * `chapterId`, the legacy financeTeams convention, kept until its own PR).
 */
export async function requireInCallerChapter<T extends "funds" | "budgetCategories" | "financeTeams" | "budgets" | "budgetTags" | "transactions" | "events" | "projects" | "people">(
  ctx: QueryCtx,
  // A real chapter, or the org level (`"central"`) for a central-scoped verify
  // (e.g. attributing a central-owned txn to a central budget) — WP-2.1.
  chapterId: FinanceScope,
  table: T,
  id: Id<T>,
  label: string,
  opts: { allowCentral?: boolean } = {},
): Promise<Doc<T>> {
  const doc = await ctx.db.get(id);
  const docChapter = (doc as { chapterId?: Id<"chapters"> | typeof CENTRAL } | null)?.chapterId;
  const isCentralDoc = docChapter === CENTRAL || docChapter === undefined;
  if (!doc || (docChapter !== chapterId && !(opts.allowCentral && isCentralDoc))) {
    throw new ConvexError({
      code: "NOT_FOUND",
      message: `${label} not found in your chapter.`,
    });
  }
  return doc as Doc<T>;
}

/** True iff a transaction contributes to category / budget / actual SPEND.
 *  Exported for `transfers.ts#interScopeBalances` (WP-4.5), which reuses this
 *  exact gate when summing cross-scope-attributed spend. */
export function isSpend(tr: Doc<"transactions">): boolean {
  return (
    tr.flow === "outflow" &&
    countsAsSpend(tr.flow) &&
    tr.status !== "excluded" &&
    tr.isPersonal !== true
  );
}

/** True iff a spend transaction still needs a budget attached — the
 *  Reconcile "needs budget" soft-attribution signal (never a hard block).
 *  Exported so `aiCodingData.ts` can gate AI-suggestion eligibility off the
 *  EXACT same predicate the grid's own `needs_budget` filter/badge use
 *  (single source of truth — see `isSuggestible` below). */
export function needsBudget(tr: Doc<"transactions">): boolean {
  return isSpend(tr) && tr.budgetId == null;
}

/**
 * True iff a transaction is a candidate for an AI coding suggestion (the
 * Reconcile grid's per-row "Suggest" button, the on-demand `suggestCoding`
 * gate, and the on-ingest/hourly sweep all share this ONE predicate — PR
 * fix-suggest-broaden). A row qualifies either:
 *  - it's still `unreviewed` (never reviewed at all — the original rule), OR
 *  - it's `categorized` but STILL `needsBudget` (a human coded the category
 *    but the row never got a budget attached — the majority of the
 *    "Needs budget" backlog the owner reported this button was missing on).
 * `reconciled` (treasurer-closed) and `excluded`/personal/non-spend rows are
 * never suggestible, regardless of budget state — they fall outside both
 * branches above by construction.
 */
export function isSuggestible(tr: Doc<"transactions">): boolean {
  if (tr.status === "unreviewed") return true;
  return tr.status === "categorized" && needsBudget(tr);
}

// ── Period helpers (Eastern-time bucketing) ──────────────────────────────────
/** True iff a timestamp falls in the given Eastern year (+ optional month/quarter).
 *  Exported for `transfers.ts#interScopeBalances` (WP-4.5). */
export function inPeriod(
  postedAt: number,
  year: number,
  month?: number,
  quarter?: number,
): boolean {
  const p = easternParts(postedAt);
  if (p.year !== year) return false;
  if (month != null && p.month !== month) return false;
  if (quarter != null && quarterOfMonth(p.month) !== quarter) return false;
  return true;
}

/**
 * Read the chapter's transactions for a year (optionally a single month),
 * bounded via the `by_chapter_and_postedAt` range. The UTC window is padded a
 * day on each side to cover the Eastern offset; callers narrow precisely with
 * `inPeriod`.
 *
 * NOTE (scale): the read is capped at `ROLLUP_SCAN_LIMIT`. Past that many
 * transactions in one period the aggregate is truncated (a non-silent
 * `console.warn` fires). Accurate aggregation at high sync volume lands with the
 * Increase/Stripe sync phases (denormalized counters), not now.
 */
export async function loadPeriodTxns(
  ctx: QueryCtx,
  // A real chapter, or `"central"` to read CENTRAL-owned txns (WP-2.1). The
  // `by_chapter_and_postedAt` index keys on the string, so the sentinel reads
  // back exactly the central-owned rows and nothing else.
  chapterId: FinanceScope,
  year: number,
  sandboxMode: boolean,
  month?: number,
): Promise<Doc<"transactions">[]> {
  const startUtc =
    (month != null ? Date.UTC(year, month - 1, 1) : Date.UTC(year, 0, 1)) -
    DAY_MS;
  const endUtc =
    (month != null ? Date.UTC(year, month, 1) : Date.UTC(year + 1, 0, 1)) +
    DAY_MS;
  const rows = await ctx.db
    .query("transactions")
    .withIndex("by_chapter_and_postedAt", (q) =>
      q.eq("chapterId", chapterId).gte("postedAt", startUtc).lt("postedAt", endUtc),
    )
    .take(ROLLUP_SCAN_LIMIT);
  if (rows.length === ROLLUP_SCAN_LIMIT) {
    console.warn(
      `[finances] period read hit ROLLUP_SCAN_LIMIT (${ROLLUP_SCAN_LIMIT}) for chapter ${chapterId} ${year}${month ? `-${month}` : ""}; aggregate truncated until sync-volume counters land.`,
    );
  }
  return rows.filter((tr) => txnMatchesMode(tr, sandboxMode));
}

/**
 * Defensive environment filter for transaction reads. Drops `increase_card` /
 * `increase_ach` txns whose Increase external/source id belongs to the OTHER
 * environment than the current mode (a `sandbox_` id while in production, or
 * vice-versa). A null id, or any non-Increase source (manual / reimbursement /
 * repayment / stripe_fc), is environment-NEUTRAL and always kept.
 *
 * NOTE: no code inserts `increase_*` transactions yet, so this is a LATENT-leak
 * guard — a no-op today, in place before the Increase sync phase lands.
 *
 * Exported for `transfers.ts#interScopeBalances` (WP-4.5), which applies this
 * same gate to the underlying card/ACH spend it cross-attributes.
 */
export function txnMatchesMode(tr: Doc<"transactions">, sandboxMode: boolean): boolean {
  if (tr.source !== "increase_card" && tr.source !== "increase_ach") return true;
  return matchesMode(tr.externalId ?? tr.sourceAccountId ?? null, sandboxMode);
}

/** Translate a client patch: `null` clears the field, `undefined` is untouched. */
export function cleanPatch(patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(patch)) {
    if (val === undefined) continue;
    out[k] = val === null ? undefined : val;
  }
  return out;
}

/** Resolve the caller's chapter for a READ (null → empty result, no throw). */
export async function readChapterId(
  ctx: QueryCtx,
): Promise<Id<"chapters"> | null> {
  const id = await getChapterIdOrNull(ctx);
  return (id as Id<"chapters"> | null) ?? null;
}

/** The next sort order for a chapter-scoped list (max existing + 1). */
export async function nextSortOrder(
  ctx: MutationCtx,
  rows: { sortOrder?: number }[],
): Promise<number> {
  let max = -1;
  for (const r of rows) if ((r.sortOrder ?? 0) > max) max = r.sortOrder ?? 0;
  return max + 1;
}
