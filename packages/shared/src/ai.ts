/**
 * AI agent config — model registry, cost accounting, and usage budgets.
 *
 * We talk to models through OpenRouter (one OpenAI-compatible gateway over many
 * providers) so the model is just a swappable slug. Models are config, not code:
 * change DEFAULT_AI_MODEL or pass a different slug to switch providers entirely.
 *
 * "Deployment = one org" for budgeting: caps apply per user, per chapter, and
 * org-wide (the whole deployment). Budgets are dollar amounts over a rolling
 * monthly window; each call's token usage × the model's price → cost.
 */
import { DAY_MS } from "./index";

export interface AiModel {
  /** OpenRouter slug, e.g. "anthropic/claude-sonnet-latest". */
  slug: string;
  label: string;
  /** USD per 1M input / output tokens (for cost estimation when the gateway
   * doesn't return an exact cost). */
  inputPerMTok: number;
  outputPerMTok: number;
}

/**
 * The models offered in-app. Swap freely — anything OpenRouter serves works by
 * slug; these are the curated picks with known pricing for cost estimates.
 */
export const AI_MODELS: Record<string, AiModel> = {
  "anthropic/claude-sonnet-latest": {
    slug: "anthropic/claude-sonnet-latest",
    label: "Claude Sonnet",
    inputPerMTok: 3,
    outputPerMTok: 15,
  },
  "anthropic/claude-opus-latest": {
    slug: "anthropic/claude-opus-latest",
    label: "Claude Opus",
    inputPerMTok: 5,
    outputPerMTok: 25,
  },
  "anthropic/claude-haiku-latest": {
    slug: "anthropic/claude-haiku-latest",
    label: "Claude Haiku",
    inputPerMTok: 1,
    outputPerMTok: 5,
  },
  "openai/gpt-latest": {
    slug: "openai/gpt-latest",
    label: "GPT (latest)",
    inputPerMTok: 5,
    outputPerMTok: 15,
  },
  "google/gemini-2.5-flash": {
    slug: "google/gemini-2.5-flash",
    label: "Gemini 2.5 Flash",
    inputPerMTok: 0.3,
    outputPerMTok: 2.5,
  },
};

/**
 * Default model for agent tasks. Sonnet balances capability and cost for the
 * bulk, many-small-calls workloads (e.g. finding a photo per item). Switch to a
 * cheaper slug for large batches, or a stronger one for harder reasoning.
 */
export const DEFAULT_AI_MODEL = "anthropic/claude-sonnet-latest";

export interface AiUsageTokens {
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
  cacheWriteTokens?: number;
}

/**
 * Estimate USD cost from token usage + a model slug. Cached reads bill ~0.1×
 * input, cache writes ~1.25×. If the gateway returns an exact `cost`, prefer it
 * over this estimate (see the action).
 */
export function aiCostUsd(slug: string, u: AiUsageTokens): number {
  const m = AI_MODELS[slug];
  if (!m) return 0;
  const billableInput =
    (u.inputTokens ?? 0) +
    (u.cacheWriteTokens ?? 0) * 0.25 -
    (u.cachedTokens ?? 0) * 0.9;
  const inputCost = (Math.max(0, billableInput) * m.inputPerMTok) / 1_000_000;
  const outputCost = ((u.outputTokens ?? 0) * m.outputPerMTok) / 1_000_000;
  return inputCost + outputCost;
}

/** Dollar caps over the rolling window. Deployment = one org. */
export const AI_BUDGETS = {
  perUserUsd: 5,
  perChapterUsd: 50,
  orgUsd: 500,
};

/** Rolling budget window (30 days). */
export const AI_BUDGET_WINDOW_MS = 30 * DAY_MS;

export type AiBudgetScope = "user" | "chapter" | "org";

/** Which scope (if any) is over budget, given windowed spend totals. */
export function overBudgetScope(spend: {
  user: number;
  chapter: number;
  org: number;
}): AiBudgetScope | null {
  if (spend.user >= AI_BUDGETS.perUserUsd) return "user";
  if (spend.chapter >= AI_BUDGETS.perChapterUsd) return "chapter";
  if (spend.org >= AI_BUDGETS.orgUsd) return "org";
  return null;
}
