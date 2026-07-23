"use node";

/**
 * AI auto-coding — the ACTION side (Node runtime).
 *
 * `suggestCoding` proposes how ONE incoming transaction should be coded
 * (fund / category / project / event link) from its merchant, amount, time, and
 * the week's calendar of events. It writes only `transactions.aiSuggestion`; a
 * human accepts it later via `aiCodingData.acceptSuggestion`. The model NEVER
 * moves money, changes links, or advances status on its own.
 *
 * We talk to OpenRouter via RAW fetch (mirroring `aiActions.ts`: same base
 * URL, auth header, and model conventions — no SDK), on a PAID model —
 * `codingModel()` below, config not code — CONDITIONAL on the audit trail
 * this file also writes: every call (success or failure) is logged to
 * `aiUsageEvents` via `aiCodingData.recordUsageEvent`, reviewable on the
 * Accounts tab's "AI usage" section. If `OPENROUTER_API_KEY` is unset we
 * DEGRADE GRACEFULLY: log and return null without writing anything (and
 * without an audit-trail row — no call was made), so the finance flow works
 * with no AI configured.
 *
 * The DB reads/writes live in the non-node `aiCodingData.ts` (an action has no
 * `ctx.db`); this file reaches them via `ctx.runQuery` / `ctx.runMutation`.
 */
import { action, internalAction } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { Id } from "./_generated/dataModel";
import { aiCostUsd, type TransactionStatus } from "@events-os/shared";

/**
 * The OpenRouter model finance auto-coding calls on. Config, not code:
 * override via the `OPENROUTER_MODEL` env var (see `docs/secrets.md`'s
 * Secret Update Flow); defaults to a paid Claude Sonnet model now that the
 * audit trail (`aiUsageEvents`) makes a paid model an owner-approved choice.
 * Read per-call (not hoisted to a module-level const) so tests can toggle the
 * env var between cases without re-importing the module.
 */
function codingModel(): string {
  return process.env.OPENROUTER_MODEL || "anthropic/claude-sonnet-5";
}

/** The OpenRouter response `usage` shape we read (mirrors `aiActions.ts`'s
 *  `OpenRouterUsage`) — `cost` and `prompt_tokens_details.cached_tokens` are
 *  only present when the request asks for exact accounting (`usage: {
 *  include: true }`, set below). */
interface OpenRouterUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  cost?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

/**
 * Write one `aiUsageEvents` row for this OpenRouter call — the audit trail
 * that is the owner's CONDITION for allowing a paid model here. Called for
 * EVERY attempt (success or failure), never just the happy path, so spend is
 * never silently unaccounted for. Cost prefers the gateway's exact billed
 * `usage.cost` (via the `usage: { include: true }` request flag); else it's
 * estimated from the curated `AI_MODELS` price table (which now carries a
 * real paid-model entry for `codingModel()`'s default); else 0 — the raw
 * usage payload is kept in `rawUsage` either way so nothing is silently lost.
 * Best-effort: an audit-log write must never crash the coding attempt itself.
 */
async function logUsageEvent(
  ctx: ActionCtx,
  p: {
    chapterId: Id<"chapters">;
    transactionId: Id<"transactions">;
    cardholderPersonId: Id<"people"> | undefined;
    triggeredBy: TriggeredBy;
    model: string;
    outcome: "suggested" | "failed" | "no_suggestion";
    usage: OpenRouterUsage | undefined;
  },
): Promise<void> {
  const promptTokens = p.usage?.prompt_tokens ?? 0;
  const completionTokens = p.usage?.completion_tokens ?? 0;
  const costUsd =
    typeof p.usage?.cost === "number"
      ? p.usage.cost
      : aiCostUsd(p.model, {
          inputTokens: promptTokens,
          outputTokens: completionTokens,
          cachedTokens: p.usage?.prompt_tokens_details?.cached_tokens,
        });
  try {
    await ctx.runMutation(internal.aiCodingData.recordUsageEvent, {
      feature: "finance_auto_coding",
      chapterId: p.chapterId,
      triggeredBy: p.triggeredBy,
      subjectTransactionId: p.transactionId,
      cardholderPersonId: p.cardholderPersonId,
      model: p.model,
      promptTokens,
      completionTokens,
      costUsdMicros: Math.round(costUsd * 1_000_000),
      rawUsage: p.usage,
      outcome: p.outcome,
    });
  } catch (err) {
    console.log(`[aiCoding] Failed to write aiUsageEvents row: ${String(err)}`);
  }
}

/**
 * The coding context `loadForSuggestion`/`loadForSuggestionSystem` return.
 * Annotated locally so the `ctx.runQuery` call doesn't create a circular type
 * reference through `_generated/api` (the same-deployment inference limitation
 * the Convex guidelines call out).
 */
interface SuggestionContext {
  transaction: {
    _id: Id<"transactions">;
    chapterId: Id<"chapters">;
    amountCents: number;
    flow: string;
    postedAt: number;
    merchantName?: string;
    merchantCategory?: string;
    description?: string;
    // The txn's OWN coding fields as read HERE, before the OpenRouter call —
    // threaded into `writeSuggestion`'s `baseline` (PR fix-suggest-broaden) so
    // `acceptSuggestion` can detect a manual edit that raced this suggestion,
    // not just used for prompting.
    status: TransactionStatus;
    fundId?: Id<"funds">;
    categoryId?: Id<"budgetCategories">;
    budgetId?: Id<"budgets">;
  };
  funds: { _id: Id<"funds">; name: string; restriction: string }[];
  categories: {
    _id: Id<"budgetCategories">;
    name: string;
    fundId: Id<"funds">;
    kind: string;
  }[];
  // Ranked nearest-`transaction.postedAt`-first (R2) — the model should weigh
  // earlier entries more heavily, not treat this as a flat/unordered list.
  // WP-U (one home per dollar): `budgetId` is `null` for a budget-less
  // event/project — the model must NEVER propose one of those (it has
  // nowhere to attach yet; only a human picking it in the "For" picker
  // summons its budget).
  events: {
    _id: Id<"events">;
    name: string;
    eventDate: number;
    budgetId: Id<"budgets"> | null;
  }[];
  projects: {
    _id: Id<"projects">;
    name: string;
    status: string;
    budgetId: Id<"budgets"> | null;
  }[];
  // The cardholder (R2), when `transaction.personId`/`cardId` resolves to one
  // — their own roster info plus the events/projects THEY'RE associated with
  // (also ranked nearest-first). Absent when neither resolves to a person.
  person?: {
    _id: Id<"people">;
    role?: string;
    isTeamMember?: boolean;
    events: {
      _id: Id<"events">;
      name: string;
      eventDate: number;
      budgetId: Id<"budgets"> | null;
    }[];
    projects: {
      _id: Id<"projects">;
      name: string;
      status: string;
      budgetId: Id<"budgets"> | null;
    }[];
  };
  // Grounding evidence from the chapter's recent HUMAN decisions (see
  // `aiCodingData.gatherCodingEvidence` / `lib/codingEvidence.ts`). Labels are
  // pre-resolved on the DB side — this action has no `ctx.db`. Rendered into
  // its own prompt section below; never used to sanitize (the model must still
  // echo a real id from the funds/categories/events/projects lists).
  evidence: {
    merchantHistory: {
      kind: "category" | "budget";
      label: string;
      count: number;
      exact: boolean;
    }[];
    candidateBudgetSpend: {
      label: string;
      nearbyCount: number;
      similarMerchant: boolean;
    }[];
  };
}

/** How a coding attempt originated — threaded through to the `aiUsageEvents`
 *  audit trail. "sweep" = the hourly cron backstop; "ingest" = the debounced
 *  sweep that fires soon after a new transaction lands
 *  (`aiCodingData.ingestSuggestionSweep`); "manual" = a bookkeeper tapping
 *  the Reconcile grid's per-row "Suggest" button. */
type TriggeredBy = "sweep" | "ingest" | "manual";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

/** Abort a hung completion — a coding suggestion is best-effort, never a stall. */
const OPENROUTER_TIMEOUT_MS = 30_000;

/** The suggestion `suggestCoding` returns (and persists). WP-U: the model
 *  proposes a BUDGET directly (one home per dollar) — no separate
 *  project/event link. */
const suggestionValidator = v.object({
  fundId: v.optional(v.id("funds")),
  categoryId: v.optional(v.id("budgetCategories")),
  budgetId: v.optional(v.id("budgets")),
  confidence: v.optional(v.number()),
  rationale: v.optional(v.string()),
  model: v.optional(v.string()),
  suggestedAt: v.number(),
});

/**
 * A failed-attempt marker persisted to `writeSuggestion` when the OpenRouter
 * call itself fails (bad response, network error, unparseable JSON) — never
 * for a legitimate model reply. Carries no links/confidence/rationale beyond
 * a short note, so it can never surface as an Accept-able suggestion in
 * Reconcile (every display path there already gates on "has a link"). Its
 * only job is to give the hourly sweep a timestamp to cool down against
 * instead of resubmitting the same failing transaction every run forever.
 */
async function recordFailedAttempt(
  ctx: ActionCtx,
  transactionId: Id<"transactions">,
  reason: string,
  model: string,
): Promise<null> {
  await ctx.runMutation(internal.aiCodingData.writeSuggestion, {
    transactionId,
    rationale: reason.slice(0, 200),
    model,
    failed: true,
  });
  return null;
}

/** Clamp a model-proposed confidence into [0, 1]; drop anything non-numeric. */
function cleanConfidence(raw: unknown): number | undefined {
  if (typeof raw !== "number" || Number.isNaN(raw)) return undefined;
  return Math.max(0, Math.min(1, raw));
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A short "+3d"/"-12d"/"same day" label for how far `ts` sits from the
 * charge's `postedAt` (R2) — makes the nearest-first ranking legible to the
 * model in the prompt itself, not just implicit in list order.
 */
function relativeDayLabel(postedAt: number, ts: number): string {
  const days = Math.round((ts - postedAt) / DAY_MS);
  if (days === 0) return "same day";
  return days > 0 ? `+${days}d` : `${days}d`;
}

/**
 * Extract the first balanced JSON object from a model reply. Models often wrap
 * JSON in prose or ```json fences; slicing from the first `{` to the last `}`
 * tolerates that. Returns null on anything unparseable.
 */
function parseModelJson(content: string): Record<string, unknown> | null {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(content.slice(start, end + 1));
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * The shared core: given an already-loaded coding context, call OpenRouter,
 * sanitize the proposal against that context, persist it via `writeSuggestion`,
 * and return it. Both `suggestCoding` (human-triggered — Reconcile's per-row
 * "Suggest" button, bookkeeper-gated by its `loadForSuggestion` query) and
 * `suggestCodingSystem` (system-triggered — either the hourly cron or the
 * debounced on-ingest sweep, no caller identity) share this — the only
 * difference between them is which loader gathered `context`.
 */
async function codeTransaction(
  ctx: ActionCtx,
  transactionId: Id<"transactions">,
  context: SuggestionContext,
  triggeredBy: TriggeredBy,
): Promise<null | {
  fundId: Id<"funds"> | undefined;
  categoryId: Id<"budgetCategories"> | undefined;
  budgetId: Id<"budgets"> | undefined;
  confidence: number | undefined;
  rationale: string | undefined;
  model: string;
  suggestedAt: number;
}> {
  // No key → degrade gracefully: no network, no write, no suggestion.
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.log(
      "[aiCoding] OPENROUTER_API_KEY unset — skipping AI coding suggestion.",
    );
    return null;
  }

  const { transaction, funds, categories, events, projects, person, evidence } =
    context;

  // Compact, id-labelled context so the model can only echo REAL ids back.
  const fundLines = funds
    .map((f) => `- fundId=${f._id} name="${f.name}" (${f.restriction})`)
    .join("\n");
  const categoryLines = categories
    .map(
      (c) =>
        `- categoryId=${c._id} name="${c.name}" fundId=${c.fundId} (${c.kind})`,
    )
    .join("\n");
  // WP-U (one home per dollar): the model proposes a BUDGET id directly. An
  // event/project WITHOUT one yet shows `budgetId=(none — do not select)` —
  // still useful context for name/date matching, but never a valid pick (it
  // has nowhere to attach until a human summons its budget in the "For"
  // picker).
  const eventLines = events
    .map(
      (e) =>
        `- budgetId=${e.budgetId ?? "(none — do not select)"} name="${e.name}" ` +
        `date=${new Date(e.eventDate).toISOString()} ` +
        `(${relativeDayLabel(transaction.postedAt, e.eventDate)})`,
    )
    .join("\n");
  const projectLines = projects
    .map(
      (p) =>
        `- budgetId=${p.budgetId ?? "(none — do not select)"} name="${p.name}" (${p.status})`,
    )
    .join("\n");

  // The cardholder (R2) — resolved from `transaction.personId`/`cardId`. Their
  // OWN associated events/projects are a strong signal (a videographer's card
  // charge during THEIR shoot is likelier coded to that event than a same-
  // week event they have nothing to do with), so surface it as its own
  // section rather than folding it into the general lists above.
  // PII minimization: the cardholder's NAME is deliberately withheld from this
  // external payload — referred to generically as "the cardholder" — since
  // their role + associations carry the categorization signal, not their
  // identity. Full minimization scope (what else should be withheld) and the
  // model-tier/retention question for this OpenRouter call are tracked for
  // the owner to decide.
  const personSection = person
    ? [
        `role: ${person.role ?? "(none)"}`,
        `on core team: ${person.isTeamMember ? "yes" : "no"}`,
        `associated events:\n${
          person.events
            .map(
              (e) =>
                `  - budgetId=${e.budgetId ?? "(none — do not select)"} name="${e.name}" ` +
                `date=${new Date(e.eventDate).toISOString()} ` +
                `(${relativeDayLabel(transaction.postedAt, e.eventDate)})`,
            )
            .join("\n") || "  (none)"
        }`,
        `associated projects:\n${
          person.projects
            .map(
              (p) =>
                `  - budgetId=${p.budgetId ?? "(none — do not select)"} name="${p.name}" (${p.status})`,
            )
            .join("\n") || "  (none)"
        }`,
      ].join("\n")
    : "(no cardholder on file for this transaction)";

  // EVIDENCE from the chapter's recent HUMAN decisions (merchant history) +
  // tier-1/2 corroborating spend on the candidate budgets (see
  // `aiCodingData.gatherCodingEvidence`). This is the strongest signal the
  // model gets — "a human coded a charge like this one to X before" beats a
  // same-name-only guess. Bounded upstream (top-k per signal) and hard-capped
  // here so it can never dominate the prompt.
  const EVIDENCE_CHAR_CAP = 1500;
  const merchantHistoryLines = evidence.merchantHistory.map((e) => {
    const times = `${e.count} time${e.count === 1 ? "" : "s"}`;
    const how = e.exact ? "exact merchant match" : "similar merchant";
    return `  - ${e.kind} "${e.label}" (${times}, ${how})`;
  });
  const candidateSpendLines = evidence.candidateBudgetSpend.map((e) => {
    const bits: string[] = [];
    if (e.nearbyCount > 0)
      bits.push(
        `${e.nearbyCount} charge${e.nearbyCount === 1 ? "" : "s"} nearby in time`,
      );
    if (e.similarMerchant) bits.push("a similar merchant was coded here");
    return `  - budget "${e.label}": ${bits.join("; ")}`;
  });
  const hasEvidence =
    merchantHistoryLines.length > 0 || candidateSpendLines.length > 0;
  const evidenceSection = (
    hasEvidence
      ? [
          merchantHistoryLines.length > 0
            ? `charges like this were previously coded, BY A HUMAN, to:\n${merchantHistoryLines.join("\n")}`
            : "",
          candidateSpendLines.length > 0
            ? `corroborating spend on candidate budgets:\n${candidateSpendLines.join("\n")}`
            : "",
        ]
          .filter(Boolean)
          .join("\n")
      : "(no comparable past charges found in recent history)"
  ).slice(0, EVIDENCE_CHAR_CAP);

  const systemPrompt =
    "You are a nonprofit bookkeeper's assistant. Given ONE card transaction, " +
    "the chapter's funds/budget categories, and its events/projects (each " +
    "ranked NEAREST the charge's posted date first — weigh an earlier entry " +
    "more than a later one, they are not a flat unordered list), plus the " +
    "CARDHOLDER's own roster info and the events/projects THEY'RE personally " +
    "associated with (when known), propose how to CODE the charge. Attribution " +
    'is to a BUDGET, not an event/project directly: each event/project line ' +
    'shows its `budgetId` — copy that exact value into your `budgetId` field. ' +
    'An event/project whose line says `budgetId=(none — do not select)` has NO ' +
    "budget yet and must NEVER be proposed — it's still useful context (a " +
    "close-in-time or cardholder-associated match is a strong signal even " +
    "without a budget), just not a valid `budgetId` value. A match to the " +
    "cardholder's own event/project, or a candidate close in time to the " +
    "charge, is a strong signal — weigh both over a same-name-only guess that " +
    "is neither. The EVIDENCE section is your STRONGEST signal: it reports how " +
    "a HUMAN coded charges like this one before (same/similar merchant) plus " +
    "recent corroborating spend on candidate budgets — prefer a category/" +
    "budget with real evidence over a plausible-looking guess with none, and " +
    "lower your confidence when the evidence is thin or absent. Only ever " +
    "reference ids that appear in the provided lists — " +
    'never invent an id. Reply with a SINGLE JSON object and nothing else: ' +
    '{"fundId"?, "categoryId"?, "budgetId"?, "confidence" (0-1), "rationale"}. ' +
    "Omit a field when you have no good match. You never move money — a " +
    "human confirms your proposal.";

  const userPrompt = [
    "TRANSACTION",
    `merchant: ${transaction.merchantName ?? "(unknown)"}`,
    `merchantCategory: ${transaction.merchantCategory ?? "(unknown)"}`,
    `description: ${transaction.description ?? "(none)"}`,
    `amount: ${(transaction.amountCents / 100).toFixed(2)} (${transaction.flow})`,
    `postedAt: ${new Date(transaction.postedAt).toISOString()}`,
    "",
    `EVIDENCE (from this chapter's recent HUMAN codings — weigh heavily)\n${evidenceSection}`,
    "",
    `CARDHOLDER\n${personSection}`,
    "",
    `FUNDS\n${fundLines || "(none)"}`,
    "",
    `CATEGORIES\n${categoryLines || "(none)"}`,
    "",
    `PROJECTS (ranked, most relevant first)\n${projectLines || "(none)"}`,
    "",
    `EVENTS (ranked nearest the charge date first)\n${eventLines || "(none)"}`,
  ].join("\n");

  // Raw OpenRouter fetch (mirrors aiActions.ts). Best-effort: ANY network /
  // parse failure returns null rather than throwing into the caller.
  const model = codingModel();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OPENROUTER_TIMEOUT_MS);
  let content: string;
  let usage: OpenRouterUsage | undefined;
  try {
    const res = await fetch(OPENROUTER_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://events-os.app",
        "X-OpenRouter-Title": "Chapter OS",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        response_format: { type: "json_object" },
        max_tokens: 500,
        // Ask the gateway to return the exact billed cost + token details, so
        // the audit trail (`aiUsageEvents`) accounts real numbers, not just
        // an estimate — same flag `aiActions.ts` uses for the assistant.
        usage: { include: true },
      }),
    });
    if (!res.ok) {
      console.log(`[aiCoding] OpenRouter call failed (${res.status}).`);
      await logUsageEvent(ctx, {
        chapterId: transaction.chapterId,
        transactionId,
        cardholderPersonId: person?._id,
        triggeredBy,
        model,
        outcome: "failed",
        usage: undefined,
      });
      return await recordFailedAttempt(
        ctx,
        transactionId,
        `OpenRouter call failed (${res.status}).`,
        model,
      );
    }
    const json: any = await res.json();
    content = json?.choices?.[0]?.message?.content ?? "";
    usage = json?.usage as OpenRouterUsage | undefined;
  } catch (err) {
    console.log(`[aiCoding] OpenRouter request errored: ${String(err)}`);
    await logUsageEvent(ctx, {
      chapterId: transaction.chapterId,
      transactionId,
      cardholderPersonId: person?._id,
      triggeredBy,
      model,
      outcome: "failed",
      usage: undefined,
    });
    return await recordFailedAttempt(
      ctx,
      transactionId,
      `OpenRouter request errored: ${String(err)}`,
      model,
    );
  } finally {
    clearTimeout(timer);
  }

  const proposal = parseModelJson(content);
  if (!proposal) {
    console.log("[aiCoding] Could not parse a JSON proposal from the model.");
    // A 200 was returned (real tokens were billed) even though the reply
    // didn't parse — log the actual usage, not a zeroed-out row.
    await logUsageEvent(ctx, {
      chapterId: transaction.chapterId,
      transactionId,
      cardholderPersonId: person?._id,
      triggeredBy,
      model,
      outcome: "failed",
      usage,
    });
    return await recordFailedAttempt(
      ctx,
      transactionId,
      "Could not parse a JSON proposal from the model.",
      model,
    );
  }

  // Sanitize: keep only ids that appear in the loaded context (drop any
  // hallucinated / out-of-chapter ids). writeSuggestion re-validates too.
  // The cardholder's OWN associated events/projects (`person.events`/
  // `person.projects`) are unioned in here too: the prompt explicitly tells
  // the model to weigh a match to the cardholder's own event/project as a
  // strong signal, but that event/project can fall outside the chapter-wide
  // 50-nearest window (`EVENT_LIMIT`/`CONTEXT_LIMIT`) — without this union, a
  // correct proposal following that exact instruction gets silently dropped
  // here as if it were hallucinated. WP-U (one home per dollar): the valid set
  // is every event's/project's `budgetId` — a budget-less ref's `null` is
  // filtered out, so the model can't accidentally "propose" a non-id.
  const fundIds = new Set(funds.map((f) => String(f._id)));
  const categoryIds = new Set(categories.map((c) => String(c._id)));
  const budgetIds = new Set(
    [
      ...events.map((e) => e.budgetId),
      ...projects.map((p) => p.budgetId),
      ...(person?.events.map((e) => e.budgetId) ?? []),
      ...(person?.projects.map((p) => p.budgetId) ?? []),
    ]
      .filter((id): id is Id<"budgets"> => id != null)
      .map(String),
  );

  const fundId =
    typeof proposal.fundId === "string" && fundIds.has(proposal.fundId)
      ? (proposal.fundId as any)
      : undefined;
  const categoryId =
    typeof proposal.categoryId === "string" &&
    categoryIds.has(proposal.categoryId)
      ? (proposal.categoryId as any)
      : undefined;
  const budgetId =
    typeof proposal.budgetId === "string" && budgetIds.has(proposal.budgetId)
      ? (proposal.budgetId as any)
      : undefined;
  const confidence = cleanConfidence(proposal.confidence);
  const rationale =
    typeof proposal.rationale === "string"
      ? proposal.rationale.slice(0, 1000)
      : undefined;

  // Log the audit-trail row BEFORE writeSuggestion — matches every failure
  // branch above (log first, act second): the OpenRouter call is already
  // billed at this point, so the usage row must exist even if the
  // subsequent writeSuggestion mutation throws (e.g. a dangling/foreign id
  // slipping past sanitization). logUsageEvent is itself best-effort
  // (try/catch inside), so it can never be the thing that prevents the
  // suggestion from being written.
  await logUsageEvent(ctx, {
    chapterId: transaction.chapterId,
    transactionId,
    cardholderPersonId: person?._id,
    triggeredBy,
    model,
    outcome: "suggested",
    usage,
  });

  await ctx.runMutation(internal.aiCodingData.writeSuggestion, {
    transactionId,
    fundId,
    categoryId,
    budgetId,
    confidence,
    rationale,
    model,
    // Snapshot of what THIS txn looked like when we read it (before the
    // OpenRouter call above) — `acceptSuggestion`'s staleness gate.
    baseline: {
      status: transaction.status,
      fundId: transaction.fundId ?? null,
      categoryId: transaction.categoryId ?? null,
      budgetId: transaction.budgetId ?? null,
    },
  });

  return {
    fundId,
    categoryId,
    budgetId,
    confidence,
    rationale,
    model,
    suggestedAt: Date.now(),
  };
}

export const suggestCoding = action({
  args: { transactionId: v.id("transactions") },
  returns: v.union(v.null(), suggestionValidator),
  handler: async (ctx, args) => {
    // Load the transaction + its chapter's funds/categories/projects + the
    // week's events. Bookkeeper-gated (the query throws if the caller isn't).
    const context: SuggestionContext = await ctx.runQuery(
      internal.aiCodingData.loadForSuggestion,
      { transactionId: args.transactionId },
    );
    return await codeTransaction(ctx, args.transactionId, context, "manual");
  },
});

/**
 * The SYSTEM (cron/ingest-triggered) counterpart to `suggestCoding` — no
 * caller identity, so it loads context via `loadForSuggestionSystem` (no
 * bookkeeper gate) instead. Only reachable internally, via
 * `aiCodingData.runSuggestionSweep` — scheduled either by the hourly cron
 * (`sweepUnsuggestedTransactions`) or the debounced on-ingest sweep
 * (`ingestSuggestionSweep`). `triggeredBy` distinguishes the two for the
 * audit trail only (defaults to `"sweep"` for any caller that omits it —
 * there is none today, but this keeps the arg backwards-compatible);
 * eligibility and behavior are otherwise identical either way.
 */
export const suggestCodingSystem = internalAction({
  args: {
    transactionId: v.id("transactions"),
    triggeredBy: v.optional(v.union(v.literal("sweep"), v.literal("ingest"))),
  },
  returns: v.union(v.null(), suggestionValidator),
  handler: async (ctx, args) => {
    const context: SuggestionContext = await ctx.runQuery(
      internal.aiCodingData.loadForSuggestionSystem,
      { transactionId: args.transactionId },
    );
    return await codeTransaction(
      ctx,
      args.transactionId,
      context,
      args.triggeredBy ?? "sweep",
    );
  },
});
