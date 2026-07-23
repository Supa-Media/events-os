import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * AI usage event — one row per OpenRouter call an AI-coding feature makes.
 * This is the audit trail the owner made a hard CONDITION of allowing PAID
 * OpenRouter models for finance auto-coding (see `aiCoding.ts`): every call
 * is logged — success AND failure — with who/what triggered it, which model,
 * and its token/cost accounting, so spend can be reviewed (the "AI usage"
 * section on the Accounts tab, ED/FM-gated same as the rest of that screen).
 *
 * Distinct from the `aiUsage` table in `schema/ai.ts`: that one tracks the
 * Notion-AI-style event/doc ASSISTANT's per-user/chapter/org budget windows.
 * This table is the finance auto-coding audit log — a different feature,
 * different shape (chapter-OR-central scope, transaction/cardholder subject,
 * accept-rate tracking), so it gets its own table rather than overloading
 * that one.
 *
 * `feature` is a closed union with exactly one member today. Kept a
 * `v.literal` (not a bare `v.string()`) so a FUTURE AI-coding feature that
 * wants this same audit trail is a one-line union extension here, and every
 * existing row stays a valid member of the new type.
 */
export const aiUsageEvents = defineTable({
  feature: v.literal("finance_auto_coding"),
  // The scope this call was made for: a real chapter, or the `"central"`
  // string sentinel (this repo never uses null sentinels for scope — see
  // CLAUDE.md). Finance auto-coding only ever codes chapter-owned
  // transactions today (`aiCodingData.ts` rejects central ones before
  // context-loading), so every row currently carries a real chapter id; the
  // union just keeps this table ready for a future central-scoped caller
  // without a schema migration.
  chapterId: v.union(v.id("chapters"), v.literal("central")),
  // How the call originated: the hourly cron sweep
  // (`sweepUnsuggestedTransactions`, now mostly a backstop), the DEBOUNCED
  // on-ingest sweep that fires soon after a new transaction lands
  // (`ingestSuggestionSweep` — see `aiCodingData.ts`'s "ON-INGEST HOOK" doc
  // comment), or a bookkeeper manually requesting a suggestion via the
  // Reconcile grid's per-row "Suggest" button (`suggestCoding`). "sweep" and
  // "ingest" share the exact same eligibility rule and model-call cap
  // (`runSuggestionSweep`) — this field is purely for the audit trail so the
  // two triggers show up distinctly in the Accounts tab's AI usage log.
  triggeredBy: v.union(
    v.literal("sweep"),
    v.literal("ingest"),
    v.literal("manual"),
  ),
  // The transaction this call was coding, when the call was transaction-scoped
  // (always true for `finance_auto_coding` today, but optional so the shape
  // holds for a future feature-level call with no single subject).
  subjectTransactionId: v.optional(v.id("transactions")),
  // Whose card/txn this was, when the context resolved a cardholder. Recorded
  // here for the audit trail even though the cardholder's NAME is
  // deliberately withheld from the OpenRouter payload itself (PII
  // minimization — see `aiCoding.ts`); this id is never sent to OpenRouter.
  cardholderPersonId: v.optional(v.id("people")),
  model: v.string(),
  promptTokens: v.number(),
  completionTokens: v.number(),
  // USD cost in MICRO-dollars (1e-6 USD) so small per-call costs don't round
  // to zero as a float — sum and divide by 1_000_000 for display. Computed
  // from OpenRouter's response `usage` + the model's per-token pricing when
  // available; 0 when usage couldn't be determined (e.g. a network failure
  // before any response body arrived), with the raw response kept in
  // `rawUsage` instead of silently discarded.
  costUsdMicros: v.number(),
  rawUsage: v.optional(v.any()),
  // "suggested" — the model returned a proposal (which may itself carry zero
  //   fund/category/budget picks; a real reply either way).
  // "no_suggestion" — reserved for a well-formed reply that explicitly
  //   proposed nothing; not produced by the current `codeTransaction` (which
  //   records every parseable reply as "suggested"), but modeled here so a
  //   future stricter classification doesn't need a schema change.
  // "failed" — the OpenRouter call itself failed (network error, non-200, or
  //   an unparseable reply) — mirrors `aiSuggestion.failed` on the txn.
  outcome: v.union(
    v.literal("suggested"),
    v.literal("failed"),
    v.literal("no_suggestion"),
  ),
  // Backfilled to `true` when a human later accepts the suggestion this call
  // produced (`acceptSuggestion`), so the "AI usage" section can show an
  // accept rate. Left `undefined` (never explicitly `false`) until accepted —
  // there is no reliable "the bookkeeper looked and declined" signal today
  // (a manual re-code overwrites the suggestion rather than rejecting it).
  suggestionAccepted: v.optional(v.boolean()),
  createdAt: v.number(),
})
  .index("by_chapter_and_time", ["chapterId", "createdAt"])
  .index("by_transaction", ["subjectTransactionId"]);

/**
 * ONE-ROW debounce mutex for the on-ingest suggestion trigger (see
 * `aiCodingData.ts`'s `scheduleSuggestionOnIngest` / `ingestSuggestionSweep`).
 * A transaction-creating mutation (the Increase webhook apply path, the
 * manual-add path) flips `pending` to `true` and schedules
 * `ingestSuggestionSweep` ONLY when no sweep is already scheduled — every
 * other arrival within that window is absorbed into the same pending sweep
 * instead of scheduling its own. This is what turns a burst of N
 * near-simultaneous transaction arrivals (e.g. several webhook redeliveries,
 * or a bookkeeper bulk-adding manual entries) into ONE batched sweep call
 * rather than N parallel OpenRouter calls.
 *
 * Deployment-wide, not chapter-scoped — one pending sweep covers every
 * chapter's newly-arrived transactions, mirroring the hourly cron's own
 * deployment-wide scan. Concurrent writers racing the read-then-write below
 * are safe: Convex's OCC serializes writes to this single document, so a
 * losing mutation retries, re-reads `pending: true` (already flipped by the
 * winner), and no-ops rather than double-scheduling.
 */
export const aiCodingIngestState = defineTable({
  pending: v.boolean(),
  // Informational only (debugging/observability) — when the currently-
  // pending sweep (if any) was scheduled.
  scheduledAt: v.optional(v.number()),
});

/**
 * APPEND-ONLY outcome log for finance AI coding suggestions — the measurement
 * substrate for "how good are the suggestions, really?" (the founder's
 * "mostly wrong" report). One row is written the moment a human RESOLVES a
 * transaction that carried a live suggestion:
 *  - `accepted` — the human tapped Accept, taking the whole suggestion
 *    (`aiCodingData.acceptSuggestion`);
 *  - `overridden` — the human instead coded the row by hand (picked a
 *    Category / For value) while a suggestion was on screen
 *    (`aiCodingData.recordCodingOverride`, called from the Reconcile grid).
 *
 * Both the suggestion's proposed ids and the human's CHOSEN ids are snapshotted
 * so precision is computable PER DIMENSION (fund / category / budget):
 *  - an ACCEPT confirms every dimension the suggestion proposed (correct),
 *  - an OVERRIDE resolves exactly ONE dimension by hand (`overriddenDimension`)
 *    — correct if the human's chosen value for it equals the suggested value,
 *    incorrect otherwise (a different pick OR a clear); dimensions the human
 *    did NOT touch contribute nothing (unknown, not counted).
 * `overriddenDimension` is what disambiguates "the human cleared this
 * dimension" (a confirmed miss) from "the human never touched it" (unknown) —
 * a cleared field leaves no `chosen*` id, so without the marker the two would
 * be indistinguishable. Append-only (never updated/deleted) so the record is
 * an honest audit trail — `aiCodingData.codingPrecision` reads it. Distinct
 * from `aiUsageEvents` (which logs every OpenRouter CALL + a coarse accept
 * flag); this logs the human DECISION with enough shape to measure quality.
 */
export const aiCodingOutcomes = defineTable({
  chapterId: v.id("chapters"),
  transactionId: v.id("transactions"),
  outcome: v.union(v.literal("accepted"), v.literal("overridden")),
  // What the suggestion proposed (only the dimensions it actually carried).
  suggestedFundId: v.optional(v.id("funds")),
  suggestedCategoryId: v.optional(v.id("budgetCategories")),
  suggestedBudgetId: v.optional(v.id("budgets")),
  // What the human's coding became. For an ACCEPT, mirrors the applied links.
  // For an OVERRIDE, carries the new id of the resolved dimension (absent when
  // the human cleared it — see `overriddenDimension`).
  chosenFundId: v.optional(v.id("funds")),
  chosenCategoryId: v.optional(v.id("budgetCategories")),
  chosenBudgetId: v.optional(v.id("budgets")),
  // OVERRIDE rows only: the single dimension the human resolved by hand in this
  // action, so a clear-to-nothing still counts as a decision on that dimension.
  overriddenDimension: v.optional(
    v.union(v.literal("fund"), v.literal("category"), v.literal("budget")),
  ),
  // Carried from the suggestion for slicing precision by model / confidence.
  confidence: v.optional(v.number()),
  model: v.optional(v.string()),
  createdAt: v.number(),
})
  .index("by_chapter_and_time", ["chapterId", "createdAt"])
  .index("by_transaction", ["transactionId"]);
