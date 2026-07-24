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
  /** Free tier (`:free` slug, $0 to run). Paid models are superuser-only. */
  free: boolean;
}

/**
 * The curated in-app model menu — a small, known-good SEED/fallback list.
 *
 * The live picker fetches the full OpenRouter catalog at runtime (see
 * `listModels`), so users aren't limited to this list — they can pick ANY free
 * model, and superusers any paid one. This constant is what we fall back to when
 * the catalog fetch fails, and the source of truth for cost estimation of these
 * slugs. Free models cost $0; the paid entries carry real per-token prices so
 * the budget math (and per-chat spend caps) work when a superuser opts into one.
 */
export const AI_MODELS: Record<string, AiModel> = {
  // ── Free (open to everyone) ────────────────────────────────────────────────
  "openai/gpt-oss-120b:free": {
    slug: "openai/gpt-oss-120b:free",
    label: "GPT-OSS 120B (free)",
    inputPerMTok: 0,
    outputPerMTok: 0,
    free: true,
  },
  "nvidia/nemotron-3-super-120b-a12b:free": {
    slug: "nvidia/nemotron-3-super-120b-a12b:free",
    label: "Nemotron 3 Super (free)",
    inputPerMTok: 0,
    outputPerMTok: 0,
    free: true,
  },
  "deepseek/deepseek-r1:free": {
    slug: "deepseek/deepseek-r1:free",
    label: "DeepSeek R1 (free)",
    inputPerMTok: 0,
    outputPerMTok: 0,
    free: true,
  },
  "meta-llama/llama-3.3-70b-instruct:free": {
    slug: "meta-llama/llama-3.3-70b-instruct:free",
    label: "Llama 3.3 70B (free)",
    inputPerMTok: 0,
    outputPerMTok: 0,
    free: true,
  },
  "qwen/qwen3-coder:free": {
    slug: "qwen/qwen3-coder:free",
    label: "Qwen3 Coder (free)",
    inputPerMTok: 0,
    outputPerMTok: 0,
    free: true,
  },
  // ── Paid (superuser-only; prices are per-1M-token estimates for budgeting) ──
  "anthropic/claude-sonnet-5": {
    slug: "anthropic/claude-sonnet-5",
    label: "Claude Sonnet 5",
    inputPerMTok: 3,
    outputPerMTok: 15,
    free: false,
  },
  "openai/gpt-5.6-luna": {
    slug: "openai/gpt-5.6-luna",
    label: "GPT-5.6 Luna",
    inputPerMTok: 1,
    outputPerMTok: 6,
    free: false,
  },
};

/**
 * Default model for the assistant when a chat hasn't picked its own. GPT-OSS
 * 120B is free, reliable at tool-calling, AND streams a reasoning trace (so
 * "see its thinking" works out of the box). Every chat can override this with
 * any free model; superusers can point a chat at a paid model.
 */
export const DEFAULT_AI_MODEL = "openai/gpt-oss-120b:free";

// ── Switchable AI engine (provider) ──────────────────────────────────────────
// The whole app's AI can run against OpenRouter (the historical default) OR
// Ollama's cloud service — both speak the OpenAI chat-completions wire format,
// so the provider only decides the base URL + auth header + a couple of
// provider-specific request extras (see `apps/convex/lib/aiEngine.ts`). The
// active provider, its key/base URL, and a GLOBAL default model are configured
// in-app on the integrations screen (superuser only) via `integrationSettings`.

/** The AI providers the engine can target. Tuple → the Convex schema/module
 *  turn it into a `v.union(...map(v.literal))` validator (the `EVENT_STATUSES`
 *  pattern), and the mobile provider toggle iterates it. */
export const AI_ENGINE_PROVIDERS = ["openrouter", "ollama"] as const;
export type AiEngineProvider = (typeof AI_ENGINE_PROVIDERS)[number];

export const AI_ENGINE_PROVIDER_LABELS: Record<AiEngineProvider, string> = {
  openrouter: "OpenRouter",
  ollama: "Ollama",
};

/** Provider when none is stored — absent `aiProvider` means "openrouter", for
 *  full back-compat with every deployment that predates the switch. */
export const DEFAULT_AI_PROVIDER: AiEngineProvider = "openrouter";

/** Ollama cloud origin. Stored `ollamaBaseUrl` overrides this so the owner can
 *  point at a self-hosted Ollama later; the engine appends `/v1/...`. */
export const DEFAULT_OLLAMA_BASE_URL = "https://ollama.com";

/** OpenRouter origin (the `/v1/...` suffix is appended by the engine). Fixed —
 *  there's no in-app base-URL field for OpenRouter. */
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api";

/**
 * SOFT model defaults for Ollama when no global `aiModel` is configured yet —
 * clearly fallbacks, not a curated catalog (the live `/v1/models` list is
 * authoritative for the picker; these families postdate this code's training
 * data). `gemma4` is a capable vision/tools/thinking family, confirmed
 * CLOUD-HOSTED and vision-capable on ollama.com (it correctly read a receipt
 * photo end to end), used for both the OCR default and the coding + assistant
 * call sites. `glm-ocr` — Ollama's dedicated multimodal document-OCR model —
 * is LOCAL-only: it carries no "cloud" tag on ollama.com, so it 404s for any
 * account running against Ollama's cloud service (the default base URL —
 * see `DEFAULT_OLLAMA_BASE_URL`). Do not reinstate it as a default without
 * confirming cloud availability first. Exact cloud model IDs (tag suffixes
 * etc.) vary — if one of these isn't in the account's live list the chat call
 * surfaces a typed error naming the model, never a silent failure, so the
 * owner picks the right id from the dropdown.
 */
export const OLLAMA_DEFAULT_OCR_MODEL = "gemma4";
export const OLLAMA_DEFAULT_CHAT_MODEL = "gemma4";

/**
 * Fallback chain the agent walks when its chosen FREE model is rate-limited
 * upstream (OpenRouter 429). Free models share heavily throttled upstream pools,
 * so a single provider being busy must not kill the turn — we transparently try
 * the next free model. Paid models never fall back (the user picked+paid for a
 * specific one), so this list is free-only. The chosen model is always tried
 * first regardless of its place here.
 */
export const FREE_MODEL_FALLBACKS = [
  "openai/gpt-oss-120b:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
  "deepseek/deepseek-r1:free",
  "meta-llama/llama-3.3-70b-instruct:free",
] as const;

/**
 * Reasoning effort for the assistant — always HIGH. These are hard, multi-step
 * "reason across every module and edit the plan" tasks; low effort was the root
 * cause of the agent under-planning and looping. OpenRouter maps this onto each
 * model's own reasoning knob (or ignores it for non-reasoning models).
 */
export const ASSISTANT_REASONING_EFFORT = "high" as const;

/**
 * A single model as the live picker shows it — the projection of an OpenRouter
 * catalog entry (see `listModels`) the UI needs: identity, whether it's free
 * (→ open to all) or paid (→ superuser-only), its per-token price for budgeting,
 * and whether it can actually tool-call (we only offer models that can).
 */
export interface AiCatalogModel {
  slug: string;
  label: string;
  free: boolean;
  inputPerMTok: number;
  outputPerMTok: number;
  contextLength: number | null;
  toolCalling: boolean;
  reasoning: boolean;
}

/**
 * Is this slug a FREE model? Free when the slug carries the `:free` suffix, or
 * (when pricing is known) both per-token prices are zero. Used to gate paid
 * models behind superuser and to decide fallback eligibility.
 */
export function isFreeModelSlug(
  slug: string,
  pricing?: { inputPerMTok: number; outputPerMTok: number },
): boolean {
  if (slug.endsWith(":free")) return true;
  if (pricing) return pricing.inputPerMTok === 0 && pricing.outputPerMTok === 0;
  return AI_MODELS[slug]?.free ?? false;
}

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

// ── T-windows (the playbook's five lifecycle windows) ────────────────────────
// The playbook (docs/agent.md, Part III) divides an event's life into five
// windows keyed off days-until-event. The assistant states the current window
// in its system prompt so every nudge is tied to where the event actually is.
// Self-contained day math on purpose (this file must not import ./index).

export type EventWindowKey = "kickoff" | "build" | "lock" | "dayOf" | "debrief";

export interface EventWindow {
  key: EventWindowKey;
  label: string;
  /** The window's T-range as the playbook writes it, e.g. "T-7→T-1". */
  range: string;
}

/** The five playbook windows, in lifecycle order. */
export const EVENT_WINDOWS: EventWindow[] = [
  { key: "kickoff", label: "Kickoff", range: "T-∞→T-14" },
  { key: "build", label: "Build", range: "T-14→T-7" },
  { key: "lock", label: "Lock", range: "T-7→T-1" },
  { key: "dayOf", label: "Day-of", range: "T-0" },
  { key: "debrief", label: "Debrief", range: "T+1→T+7" },
];

/**
 * Which playbook window a whole-day countdown falls in. `daysUntil` is the
 * signed whole-day delta to the event (positive before, 0 = event day,
 * negative after — i.e. `offsetDaysBetween(now, eventDate)`). Boundary days
 * belong to the earlier window's end per the playbook ranges (T-14 is the last
 * Kickoff day, T-7 the last Build day). Past T+7 the debrief window has closed
 * but the stance is the same (close the loop), so it still returns "debrief".
 */
export function eventWindowFor(daysUntil: number): EventWindow {
  if (daysUntil >= 14) return EVENT_WINDOWS[0]; // kickoff
  if (daysUntil >= 7) return EVENT_WINDOWS[1]; // build
  if (daysUntil >= 1) return EVENT_WINDOWS[2]; // lock
  if (daysUntil === 0) return EVENT_WINDOWS[3]; // dayOf
  return EVENT_WINDOWS[4]; // debrief (T+1 onward)
}

/** "T-9" / "T-0" / "T+3" for a signed days-until-event. */
export function tNotation(daysUntil: number): string {
  return daysUntil >= 0 ? `T-${daysUntil}` : `T+${-daysUntil}`;
}

/**
 * The one-line T-window statement the assistant's system prompt carries, e.g.
 * "T-9 — Build window (T-14→T-7); next: Lock (T-7→T-1)". Includes the next
 * window so the agent nudges toward upcoming checkpoints, not just the current
 * ones.
 */
export function tWindowLine(daysUntil: number): string {
  const current = eventWindowFor(daysUntil);
  const idx = EVENT_WINDOWS.findIndex((w) => w.key === current.key);
  const next = idx >= 0 && idx < EVENT_WINDOWS.length - 1 ? EVENT_WINDOWS[idx + 1] : null;
  const head = `${tNotation(daysUntil)} — ${current.label} window (${current.range})`;
  return next && daysUntil > 0
    ? `${head}; next: ${next.label} (${next.range})`
    : head;
}

// ── Planning timezone (calendar-day math for the agent) ──────────────────────
// Event timestamps are stored as absolute ms; the SERVER runs in UTC while the
// team plans in local wall-clock time. Naive UTC day math makes an evening
// event (11 PM ET, stored as 03:00Z the NEXT day) look one calendar day late —
// so days-to-event, T-windows, and overdue checks must count days in the
// chapter's operating timezone, not the server's.

/**
 * The chapter's operating timezone. Single-valued for now — every chapter
 * plans in Eastern time; a multi-TZ deployment gets a `timezone` field on
 * chapters as a future follow-up, at which point call sites thread it through.
 */
export const PLANNING_TIME_ZONE = "America/New_York";

/** Wall-clock date+time parts of a timestamp, in a target timezone. */
export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number; // 0-59
}

const ZONED_DAY_MS = 24 * 60 * 60 * 1000; // self-contained (no ./index import)

/**
 * Decompose a timestamp into its wall-clock parts in `timeZone`, via
 * `Intl.DateTimeFormat` (available in the Convex runtime, Node, and
 * RN/Hermes) — dependency-free on purpose.
 */
export function zonedParts(
  ts: number,
  timeZone: string = PLANNING_TIME_ZONE,
): ZonedParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(ts)) parts[p.type] = p.value;
  return {
    year: parseInt(parts.year, 10),
    month: parseInt(parts.month, 10),
    day: parseInt(parts.day, 10),
    // Some engines render midnight as "24" despite h23 — normalize to 0.
    hour: parseInt(parts.hour, 10) % 24,
    minute: parseInt(parts.minute, 10),
  };
}

/** The "YYYY-MM-DD" calendar day a timestamp falls on in `timeZone`. */
export function dayKeyInTz(
  ts: number,
  timeZone: string = PLANNING_TIME_ZONE,
): string {
  const p = zonedParts(ts, timeZone);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/**
 * Signed whole-calendar-day delta between two timestamps in `timeZone`:
 * positive when `toTs` falls on a later local calendar day than `fromTs`,
 * 0 when they share a day. The TZ-aware sibling of `offsetDaysBetween` —
 * `daysBetweenInTz(now, eventDate)` is the agent's days-to-event.
 */
export function daysBetweenInTz(
  fromTs: number,
  toTs: number,
  timeZone: string = PLANNING_TIME_ZONE,
): number {
  const a = zonedParts(fromTs, timeZone);
  const b = zonedParts(toTs, timeZone);
  return Math.round(
    (Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) /
      ZONED_DAY_MS,
  );
}

/**
 * The UTC timestamp of a wall-clock date+time in `timeZone` (the inverse of
 * {@link zonedParts}). Uses the Intl offset-probe technique: start from the
 * parts read as UTC, then correct by however far the rendered wall clock is
 * off — two iterations converge across DST transitions. For a nonexistent
 * local time (spring-forward gap) this lands on the closest valid instant.
 */
export function zonedTimeToUtc(
  parts: { year: number; month: number; day: number; hour?: number; minute?: number },
  timeZone: string = PLANNING_TIME_ZONE,
): number {
  const { year, month, day, hour = 0, minute = 0 } = parts;
  const asUtc = Date.UTC(year, month - 1, day, hour, minute);
  let ts = asUtc;
  for (let i = 0; i < 2; i++) {
    const p = zonedParts(ts, timeZone);
    const rendered = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    ts += asUtc - rendered;
  }
  return ts;
}

export interface AiUsageTokens {
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
  cacheWriteTokens?: number;
}

/**
 * Estimate USD cost from token usage + per-1M-token prices. Cached reads bill
 * ~0.1× input, cache writes ~1.25×. If the gateway returns an exact `cost`,
 * prefer it over this estimate (see the action).
 */
export function costFromPricing(
  price: { inputPerMTok: number; outputPerMTok: number },
  u: AiUsageTokens,
): number {
  const billableInput =
    (u.inputTokens ?? 0) +
    (u.cacheWriteTokens ?? 0) * 0.25 -
    (u.cachedTokens ?? 0) * 0.9;
  const inputCost = (Math.max(0, billableInput) * price.inputPerMTok) / 1_000_000;
  const outputCost = ((u.outputTokens ?? 0) * price.outputPerMTok) / 1_000_000;
  return inputCost + outputCost;
}

/**
 * Estimate USD cost from token usage + a model slug, using our curated price
 * table. Unknown slugs (a free catalog model we don't list) estimate to $0 —
 * for paid catalog models the gateway's exact `cost` is used instead, and the
 * action can pass live pricing to {@link costFromPricing} directly.
 */
export function aiCostUsd(slug: string, u: AiUsageTokens): number {
  const m = AI_MODELS[slug];
  if (!m) return 0;
  return costFromPricing(m, u);
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

// ── Per-chat spend limits ─────────────────────────────────────────────────────
// A superuser can put a hard dollar cap on a single CHAT (thread) — the guardrail
// for pointing a chat at a paid model. Unlike the rolling per-user/chapter/org
// caps, this is a LIFETIME cap on that one thread's total spend. A free chat
// costs $0 so its cap never trips; the plumbing only bites once a paid model is
// selected for the chat.

/** Reasonable default cap to pre-fill when a superuser first caps a paid chat. */
export const DEFAULT_CHAT_SPEND_LIMIT_USD = 5;

/**
 * Has this chat hit its per-chat spend cap? False when there's no cap set
 * (`null`/`undefined` → uncapped) or spend is still under it. The action checks
 * this BEFORE each turn (so a capped chat stops accepting messages once spent)
 * and the panel renders spend-vs-cap from the same rule.
 */
export function isOverChatBudget(
  spentUsd: number,
  limitUsd: number | null | undefined,
): boolean {
  if (limitUsd == null) return false;
  return spentUsd >= limitUsd;
}
