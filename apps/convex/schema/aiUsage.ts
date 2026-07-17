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
  // How the call originated: the hourly cron sweep (`sweepUnsuggestedTransactions`)
  // or a bookkeeper manually requesting a suggestion (`suggestCoding`).
  triggeredBy: v.union(v.literal("sweep"), v.literal("manual")),
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
