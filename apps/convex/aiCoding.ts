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
 * We talk to OpenRouter via RAW fetch on a FREE model (mirroring `aiActions.ts`:
 * same base URL, auth header, and model conventions — no SDK). If
 * `OPENROUTER_API_KEY` is unset we DEGRADE GRACEFULLY: log and return null
 * without writing anything, so the finance flow works with no AI configured.
 *
 * The DB reads/writes live in the non-node `aiCodingData.ts` (an action has no
 * `ctx.db`); this file reaches them via `ctx.runQuery` / `ctx.runMutation`.
 */
import { action, internalAction } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { Id } from "./_generated/dataModel";
import { DEFAULT_AI_MODEL } from "@events-os/shared";

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
  };
  funds: { _id: Id<"funds">; name: string; restriction: string }[];
  categories: {
    _id: Id<"budgetCategories">;
    name: string;
    fundId: Id<"funds">;
    kind: string;
  }[];
  events: { _id: Id<"events">; name: string; eventDate: number }[];
  projects: { _id: Id<"projects">; name: string; status: string }[];
}

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

/** Abort a hung completion — a coding suggestion is best-effort, never a stall. */
const OPENROUTER_TIMEOUT_MS = 30_000;

/** The suggestion `suggestCoding` returns (and persists). */
const suggestionValidator = v.object({
  fundId: v.optional(v.id("funds")),
  categoryId: v.optional(v.id("budgetCategories")),
  projectId: v.optional(v.id("projects")),
  eventId: v.optional(v.id("events")),
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
): Promise<null> {
  await ctx.runMutation(internal.aiCodingData.writeSuggestion, {
    transactionId,
    rationale: reason.slice(0, 200),
    model: DEFAULT_AI_MODEL,
    failed: true,
  });
  return null;
}

/** Clamp a model-proposed confidence into [0, 1]; drop anything non-numeric. */
function cleanConfidence(raw: unknown): number | undefined {
  if (typeof raw !== "number" || Number.isNaN(raw)) return undefined;
  return Math.max(0, Math.min(1, raw));
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
 * and return it. Both `suggestCoding` (human-triggered, bookkeeper-gated by its
 * `loadForSuggestion` query) and `suggestCodingSystem` (cron-triggered, no
 * caller identity) share this — the only difference between them is which
 * loader gathered `context`.
 */
async function codeTransaction(
  ctx: ActionCtx,
  transactionId: Id<"transactions">,
  context: SuggestionContext,
): Promise<null | {
  fundId: Id<"funds"> | undefined;
  categoryId: Id<"budgetCategories"> | undefined;
  projectId: Id<"projects"> | undefined;
  eventId: Id<"events"> | undefined;
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

  const { transaction, funds, categories, events, projects } = context;

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
  const eventLines = events
    .map(
      (e) =>
        `- eventId=${e._id} name="${e.name}" date=${new Date(
          e.eventDate,
        ).toISOString()}`,
    )
    .join("\n");
  const projectLines = projects
    .map((p) => `- projectId=${p._id} name="${p.name}" (${p.status})`)
    .join("\n");

  const systemPrompt =
    "You are a nonprofit bookkeeper's assistant. Given ONE card transaction " +
    "and the chapter's funds, budget categories, projects, and the events " +
    "happening that week, propose how to CODE the charge. Only ever reference " +
    "ids that appear in the provided lists — never invent an id. Reply with a " +
    'SINGLE JSON object and nothing else: {"fundId"?, "categoryId"?, ' +
    '"projectId"?, "eventId"?, "confidence" (0-1), "rationale"}. Omit a field ' +
    "when you have no good match. You never move money — a human confirms " +
    "your proposal.";

  const userPrompt = [
    "TRANSACTION",
    `merchant: ${transaction.merchantName ?? "(unknown)"}`,
    `merchantCategory: ${transaction.merchantCategory ?? "(unknown)"}`,
    `description: ${transaction.description ?? "(none)"}`,
    `amount: ${(transaction.amountCents / 100).toFixed(2)} (${transaction.flow})`,
    `postedAt: ${new Date(transaction.postedAt).toISOString()}`,
    "",
    `FUNDS\n${fundLines || "(none)"}`,
    "",
    `CATEGORIES\n${categoryLines || "(none)"}`,
    "",
    `PROJECTS\n${projectLines || "(none)"}`,
    "",
    `EVENTS THAT WEEK\n${eventLines || "(none)"}`,
  ].join("\n");

  // Raw OpenRouter fetch (mirrors aiActions.ts). Best-effort: ANY network /
  // parse failure returns null rather than throwing into the caller.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OPENROUTER_TIMEOUT_MS);
  let content: string;
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
        model: DEFAULT_AI_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        response_format: { type: "json_object" },
        max_tokens: 500,
      }),
    });
    if (!res.ok) {
      console.log(`[aiCoding] OpenRouter call failed (${res.status}).`);
      return await recordFailedAttempt(
        ctx,
        transactionId,
        `OpenRouter call failed (${res.status}).`,
      );
    }
    const json: any = await res.json();
    content = json?.choices?.[0]?.message?.content ?? "";
  } catch (err) {
    console.log(`[aiCoding] OpenRouter request errored: ${String(err)}`);
    return await recordFailedAttempt(
      ctx,
      transactionId,
      `OpenRouter request errored: ${String(err)}`,
    );
  } finally {
    clearTimeout(timer);
  }

  const proposal = parseModelJson(content);
  if (!proposal) {
    console.log("[aiCoding] Could not parse a JSON proposal from the model.");
    return await recordFailedAttempt(
      ctx,
      transactionId,
      "Could not parse a JSON proposal from the model.",
    );
  }

  // Sanitize: keep only ids that appear in the loaded context (drop any
  // hallucinated / out-of-chapter ids). writeSuggestion re-validates too.
  const fundIds = new Set(funds.map((f) => String(f._id)));
  const categoryIds = new Set(categories.map((c) => String(c._id)));
  const eventIds = new Set(events.map((e) => String(e._id)));
  const projectIds = new Set(projects.map((p) => String(p._id)));

  const fundId =
    typeof proposal.fundId === "string" && fundIds.has(proposal.fundId)
      ? (proposal.fundId as any)
      : undefined;
  const categoryId =
    typeof proposal.categoryId === "string" &&
    categoryIds.has(proposal.categoryId)
      ? (proposal.categoryId as any)
      : undefined;
  const rawEventId =
    typeof proposal.eventId === "string" && eventIds.has(proposal.eventId)
      ? (proposal.eventId as any)
      : undefined;
  const projectId =
    typeof proposal.projectId === "string" && projectIds.has(proposal.projectId)
      ? (proposal.projectId as any)
      : undefined;
  // At most one of project/event: every manual coding path (createManualTransaction,
  // categorizeTransaction) treats them as alternatives, and proposing both would
  // double-count the charge into both the event AND project actuals rollups. Prefer
  // the project — mirrors the Reconcile grid's project-over-event display
  // precedence (`resolveLinkLabel` in finances.ts).
  const eventId = projectId ? undefined : rawEventId;
  const confidence = cleanConfidence(proposal.confidence);
  const rationale =
    typeof proposal.rationale === "string"
      ? proposal.rationale.slice(0, 1000)
      : undefined;

  await ctx.runMutation(internal.aiCodingData.writeSuggestion, {
    transactionId,
    fundId,
    categoryId,
    projectId,
    eventId,
    confidence,
    rationale,
    model: DEFAULT_AI_MODEL,
  });

  return {
    fundId,
    categoryId,
    projectId,
    eventId,
    confidence,
    rationale,
    model: DEFAULT_AI_MODEL,
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
    return await codeTransaction(ctx, args.transactionId, context);
  },
});

/**
 * The SYSTEM (cron-triggered) counterpart to `suggestCoding` — no caller
 * identity, so it loads context via `loadForSuggestionSystem` (no bookkeeper
 * gate) instead. Only reachable internally, via the daily sweep in
 * `aiCodingData.sweepUnsuggestedTransactions`.
 */
export const suggestCodingSystem = internalAction({
  args: { transactionId: v.id("transactions") },
  returns: v.union(v.null(), suggestionValidator),
  handler: async (ctx, args) => {
    const context: SuggestionContext = await ctx.runQuery(
      internal.aiCodingData.loadForSuggestionSystem,
      { transactionId: args.transactionId },
    );
    return await codeTransaction(ctx, args.transactionId, context);
  },
});
