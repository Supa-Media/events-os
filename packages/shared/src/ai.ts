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
// NOTE: self-contained on purpose — importing from "./index" (which re-exports
// this file) creates a circular dependency and a temporal-dead-zone crash
// ("Cannot access 'DAY_MS' before initialization") at app load.

export interface AiModel {
  /** OpenRouter slug, e.g. "openai/gpt-oss-120b:free". */
  slug: string;
  label: string;
  /** USD per 1M input / output tokens (for cost estimation when the gateway
   * doesn't return an exact cost). */
  inputPerMTok: number;
  outputPerMTok: number;
}

/**
 * The models offered in-app — FREE OpenRouter models only (`:free` slugs), so
 * running the assistant costs nothing. All are tool-calling capable; the ones
 * marked below also stream a reasoning trace, which the panel renders so you can
 * watch the agent think. `inputPerMTok`/`outputPerMTok` are 0 (free tier) — the
 * budget plumbing stays in place for the day we add paid models back.
 */
export const AI_MODELS: Record<string, AiModel> = {
  "openai/gpt-oss-120b:free": {
    slug: "openai/gpt-oss-120b:free",
    label: "GPT-OSS 120B (free)",
    inputPerMTok: 0,
    outputPerMTok: 0,
  },
  "nvidia/nemotron-3-super-120b-a12b:free": {
    slug: "nvidia/nemotron-3-super-120b-a12b:free",
    label: "Nemotron 3 Super (free)",
    inputPerMTok: 0,
    outputPerMTok: 0,
  },
  "meta-llama/llama-3.3-70b-instruct:free": {
    slug: "meta-llama/llama-3.3-70b-instruct:free",
    label: "Llama 3.3 70B (free)",
    inputPerMTok: 0,
    outputPerMTok: 0,
  },
  "qwen/qwen3-coder:free": {
    slug: "qwen/qwen3-coder:free",
    label: "Qwen3 Coder (free)",
    inputPerMTok: 0,
    outputPerMTok: 0,
  },
};

/**
 * Default model for the assistant. GPT-OSS 120B is free, reliable at
 * tool-calling, AND streams a reasoning trace (so "see its thinking" works out
 * of the box). Superusers can swap to any slug above.
 */
export const DEFAULT_AI_MODEL = "openai/gpt-oss-120b:free";

/**
 * The standard "voice" for every How-To guide the doc assistant writes.
 *
 * The reader is a brand-new volunteer with ZERO prior context — no domain
 * knowledge, no history with the organization, no idea what the jargon means.
 * The guide has to carry them from nothing to "task done" on its own. This block
 * is the reusable base of the doc assistant's system prompt; the action appends
 * the specific document + tool instructions after it.
 */
export const HOW_TO_SYSTEM_PROMPT = [
  "You are writing a How-To guide for a brand-new volunteer who has ZERO prior",
  "context and ZERO domain knowledge about this task or this organization.",
  "Assume they have never done this before and know none of the local jargon,",
  "people, tools, or shorthand.",
  "",
  "Write thorough, concrete, step-by-step instructions that assume no",
  "background. Specifically:",
  "- Define any jargon, acronym, or insider term the first time it appears.",
  "- Spell out EVERY step, in order — never skip a step because it seems",
  "  'obvious'. The reader cannot fill in gaps.",
  "- Start with what they need beforehand: tools, access, materials, who to ask,",
  "  and any prerequisites.",
  "- State clearly what 'done' looks like, so they know when they've succeeded.",
  "- Call out common gotchas, mistakes, and what to do if something goes wrong.",
  "",
  "Format for skimmability: prefer numbered steps for sequences, short sections",
  "with clear headings, and short sentences. Avoid walls of text. Be concrete",
  "and specific rather than vague.",
].join("\n");

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

/** Rolling budget window (30 days, in ms). */
export const AI_BUDGET_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

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
