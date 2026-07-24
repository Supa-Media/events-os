/**
 * The switchable AI engine — ONE OpenAI-compatible chat-completions client that
 * both OpenRouter and Ollama's cloud service speak. The provider only decides
 * the base URL, the auth header, and a couple of request extras; the wire shape
 * is identical, so the abstraction here is deliberately thin.
 *
 * Callers resolve an {@link AiEngineConfig} per call (via
 * `integrationSettings.readAiEngineConfig`, stored-first → env fallback) and
 * pass it to {@link chatCompletion} / {@link listModels} / {@link testConnection}.
 *
 * FAILURES ARE VALUES, NOT THROWS. Every helper returns a typed result — a
 * success or a {@link ChatCompletionError} carrying `{status, message,
 * bodySnippet}` — so callers can persist a human-readable failure reason (the
 * owner's complaint was that failures were silent). The one exception is
 * `aiActions.ts`, which re-wraps the typed error as its existing
 * `OpenRouterError` so its retry/fallback loop is unchanged on OpenRouter.
 *
 * NOTE: no `"use node"` — `fetch` works in the default Convex runtime, and this
 * module is imported by `receiptInbox.ts` (which also exports queries/mutations,
 * so it can't be a node file). Node-runtime callers (`aiCoding.ts`,
 * `aiActions.ts`) import it fine.
 */
import {
  DEFAULT_OLLAMA_BASE_URL,
  OPENROUTER_BASE_URL,
  type AiEngineProvider,
} from "@events-os/shared";

/** The resolved engine config for one call. `apiKey`/`model` may be null when
 *  nothing is configured (the call then degrades to a typed error). */
export interface AiEngineConfig {
  provider: AiEngineProvider;
  /** Origin WITHOUT the `/v1` suffix, e.g. `https://ollama.com` or
   *  `https://openrouter.ai/api`. The engine appends `/v1/chat/completions`
   *  and `/v1/models`. */
  baseUrl: string;
  apiKey: string | null;
  /** The global default model for the active provider, or null when unset. */
  model: string | null;
}

/** A normalized token-usage read (provider-agnostic). `costUsd` is only present
 *  when the gateway itself reported an exact billed cost (OpenRouter's
 *  `usage.cost` via `usage:{include:true}`); Ollama is subscription-based and
 *  reports no cost. `raw` keeps the original payload so nothing is lost. */
export interface NormalizedUsage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens?: number;
  costUsd?: number;
  raw?: unknown;
}

/** One tool call the model emitted (OpenAI/OpenRouter/Ollama wire shape). */
export interface NormalizedToolCall {
  id?: string;
  function?: { name?: string; arguments?: string };
}

/** A successful completion, normalized across providers. `message` is the raw
 *  assistant message object so a tool-calling loop can push it straight back
 *  onto the conversation. */
export interface ChatCompletionSuccess {
  ok: true;
  content: string;
  reasoning: string | null;
  toolCalls?: NormalizedToolCall[];
  usage?: NormalizedUsage;
  message: Record<string, unknown>;
  model: string;
}

export type ChatErrorKind = "no_key" | "http" | "network" | "timeout" | "parse";

/** A typed failure — never thrown, always returned. `retryable` marks the
 *  transient failures (429 / 5xx / timeout) an aiActions-style loop backs off
 *  on; `message` is human-readable and NAMES the model + provider so a persisted
 *  failure reason is actionable ("model X not available", not "AI error"). */
export interface ChatCompletionError {
  ok: false;
  kind: ChatErrorKind;
  status: number | null;
  message: string;
  bodySnippet?: string;
  retryable: boolean;
}

export type ChatCompletionResult = ChatCompletionSuccess | ChatCompletionError;

/** The request the engine sends. `messages`/`tools` are passed through as the
 *  OpenAI-compat wire shape (the caller builds them); the engine only layers on
 *  provider-specific extras. */
export interface ChatCompletionRequest {
  model: string;
  messages: unknown[];
  tools?: unknown[];
  toolChoice?: "auto" | "none";
  responseFormat?: { type: "json_object" };
  maxTokens?: number;
  /** Reasoning effort, sent as `reasoning:{effort}` (OpenRouter maps it onto
   *  each model's own knob; Ollama ignores an unknown field). */
  reasoningEffort?: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/** Read an error Response body defensively — a real `Response` always has
 *  `.text()`, but be tolerant of a minimal stub so a failed call still yields a
 *  message rather than throwing while building the error. */
async function safeText(res: Response): Promise<string> {
  if (typeof res.text !== "function") return "";
  try {
    return await res.text();
  } catch {
    return "";
  }
}

/** Trim a trailing slash so `${base}/v1/...` never doubles up. */
function origin(config: AiEngineConfig): string {
  return config.baseUrl.replace(/\/+$/, "");
}

function chatUrl(config: AiEngineConfig): string {
  return `${origin(config)}/v1/chat/completions`;
}

function modelsUrl(config: AiEngineConfig): string {
  return `${origin(config)}/v1/models`;
}

/** Auth + provider-specific headers. Only OpenRouter wants the referer/title
 *  attribution headers; Ollama needs none beyond the bearer key. */
function requestHeaders(config: AiEngineConfig): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
  if (config.provider === "openrouter") {
    headers["HTTP-Referer"] = "https://events-os.app";
    headers["X-OpenRouter-Title"] = "Chapter OS";
  }
  return headers;
}

/** A short human label for the provider, used in error messages. */
function providerLabel(provider: AiEngineProvider): string {
  return provider === "ollama" ? "Ollama" : "OpenRouter";
}

/**
 * One chat-completions call against the active provider. Returns a normalized
 * success or a typed error — NEVER throws for an API/network failure. A missing
 * key short-circuits to a `no_key` error (no fetch).
 */
export async function chatCompletion(
  config: AiEngineConfig,
  request: ChatCompletionRequest,
): Promise<ChatCompletionResult> {
  const label = providerLabel(config.provider);
  if (!config.apiKey) {
    return {
      ok: false,
      kind: "no_key",
      status: null,
      retryable: false,
      message: `No API key is configured for the ${label} AI provider.`,
    };
  }

  const body: Record<string, unknown> = {
    model: request.model,
    messages: request.messages,
  };
  if (request.tools && request.tools.length > 0) {
    body.tools = request.tools;
    body.tool_choice = request.toolChoice ?? "auto";
  }
  if (request.responseFormat) body.response_format = request.responseFormat;
  if (request.maxTokens != null) body.max_tokens = request.maxTokens;
  if (request.reasoningEffort) body.reasoning = { effort: request.reasoningEffort };
  // OpenRouter-only extra: ask the gateway to return the exact billed cost +
  // token details so the audit trail accounts real numbers. Ollama has no such
  // flag (subscription-based; no per-call cost).
  if (config.provider === "openrouter") body.usage = { include: true };

  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(chatUrl(config), {
      method: "POST",
      signal: controller.signal,
      headers: requestHeaders(config),
      body: JSON.stringify(body),
    });
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      kind: aborted ? "timeout" : "network",
      status: null,
      retryable: true,
      message: aborted
        ? `The ${label} request timed out after ${Math.round(timeoutMs / 1000)}s.`
        : `The ${label} request failed to reach the server (${String(err)}).`,
    };
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const bodyText = await safeText(res);
    const retryable = res.status === 429 || res.status >= 500;
    return {
      ok: false,
      kind: "http",
      status: res.status,
      retryable,
      bodySnippet: bodyText.slice(0, 300),
      message: `${label} returned ${res.status} for model "${request.model}": ${
        bodyText.slice(0, 200) || "(no body)"
      }`,
    };
  }

  let json: any;
  try {
    json = await res.json();
  } catch {
    return {
      ok: false,
      kind: "parse",
      status: res.status,
      retryable: false,
      message: `Could not parse the ${label} response as JSON.`,
    };
  }

  const message: Record<string, unknown> =
    (json?.choices?.[0]?.message as Record<string, unknown>) ?? {
      role: "assistant",
      content: "",
    };
  const usageRaw = json?.usage;
  const usage: NormalizedUsage | undefined = usageRaw
    ? {
        promptTokens: usageRaw.prompt_tokens ?? 0,
        completionTokens: usageRaw.completion_tokens ?? 0,
        cachedTokens: usageRaw.prompt_tokens_details?.cached_tokens,
        costUsd: typeof usageRaw.cost === "number" ? usageRaw.cost : undefined,
        raw: usageRaw,
      }
    : undefined;

  return {
    ok: true,
    content: typeof message.content === "string" ? message.content : "",
    reasoning: typeof message.reasoning === "string" ? message.reasoning : null,
    toolCalls: Array.isArray(message.tool_calls)
      ? (message.tool_calls as NormalizedToolCall[])
      : undefined,
    usage,
    message,
    model: request.model,
  };
}

/** Success of {@link listModels} — the raw model ids the provider returns, in
 *  the order returned (authoritative for the picker; never filtered here). */
export interface ListModelsSuccess {
  ok: true;
  models: string[];
}

/**
 * Fetch the provider's live model catalog (`GET {base}/v1/models`) and return
 * the raw model ids. Both providers return `{data:[{id:...}]}`. Ollama requires
 * the bearer key; OpenRouter's list works without one (but we send it when
 * present). Returns a typed error on no-key/unreachable so the picker can show a
 * graceful message.
 */
export async function listModels(
  config: AiEngineConfig,
  opts: { timeoutMs?: number } = {},
): Promise<ListModelsSuccess | ChatCompletionError> {
  const label = providerLabel(config.provider);
  // Ollama's model list needs the key; OpenRouter's is public.
  if (!config.apiKey && config.provider !== "openrouter") {
    return {
      ok: false,
      kind: "no_key",
      status: null,
      retryable: false,
      message: `No API key is configured for the ${label} AI provider.`,
    };
  }

  const timeoutMs = opts.timeoutMs ?? 12_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(modelsUrl(config), {
      method: "GET",
      signal: controller.signal,
      headers: requestHeaders(config),
    });
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      kind: aborted ? "timeout" : "network",
      status: null,
      retryable: true,
      message: aborted
        ? `The ${label} model list timed out after ${Math.round(timeoutMs / 1000)}s.`
        : `Couldn't reach ${label} to list models (${String(err)}).`,
    };
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const bodyText = await safeText(res);
    return {
      ok: false,
      kind: "http",
      status: res.status,
      retryable: res.status === 429 || res.status >= 500,
      bodySnippet: bodyText.slice(0, 300),
      message: `${label} returned ${res.status} listing models: ${
        bodyText.slice(0, 200) || "(no body)"
      }`,
    };
  }

  let json: any;
  try {
    json = await res.json();
  } catch {
    return {
      ok: false,
      kind: "parse",
      status: res.status,
      retryable: false,
      message: `Could not parse the ${label} model list as JSON.`,
    };
  }

  const data: any[] = Array.isArray(json?.data) ? json.data : [];
  const models = data
    .map((m) => (typeof m?.id === "string" ? m.id : null))
    .filter((id): id is string => !!id);
  return { ok: true, models };
}

/**
 * The "Test connection" probe: hit `/v1/models` and report `{ok, modelCount?,
 * error?}`. This is how the owner validates a live key from the app (the dev
 * environment can't reach the providers).
 */
export async function testConnection(
  config: AiEngineConfig,
): Promise<{ ok: boolean; modelCount?: number; error?: string }> {
  const res = await listModels(config);
  if (res.ok) return { ok: true, modelCount: res.models.length };
  return { ok: false, error: res.message };
}

/**
 * Per-call model resolution, shared by every call site so the precedence is
 * uniform: explicit per-call OVERRIDE (a retry-UI hook — plumbed now) > stored
 * global `aiModel` (`config.model`) > the per-feature default. The per-feature
 * default is provider-split: `openrouterDefault` already encodes "env var →
 * hardcoded" for OpenRouter, while Ollama uses its own soft default (the
 * OpenRouter env slugs are meaningless there). If the resolved id isn't in the
 * account's live list, the chat call surfaces a typed error naming it.
 */
export function resolveEngineModel(
  config: Pick<AiEngineConfig, "provider" | "model">,
  opts: {
    override?: string | null;
    openrouterDefault: string;
    ollamaDefault: string;
  },
): string {
  if (opts.override && opts.override.trim()) return opts.override.trim();
  if (config.model && config.model.trim()) return config.model.trim();
  return config.provider === "ollama" ? opts.ollamaDefault : opts.openrouterDefault;
}

/** Convenience: the fixed origin for a provider (OpenRouter is not configurable;
 *  Ollama defaults to the cloud origin but a stored `ollamaBaseUrl` overrides). */
export function providerOrigin(
  provider: AiEngineProvider,
  ollamaBaseUrl?: string | null,
): string {
  if (provider === "ollama") return ollamaBaseUrl?.trim() || DEFAULT_OLLAMA_BASE_URL;
  return OPENROUTER_BASE_URL;
}
