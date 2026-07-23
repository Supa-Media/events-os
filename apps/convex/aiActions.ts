"use node";

/**
 * AI assistant action — the Node-runtime side of the AI spine, where the LLM /
 * network work happens.
 *
 * `runAssistant` is a Notion-AI-style agent: given a user message on an event's
 * thread, it runs a multi-step tool-calling loop on a FREE OpenRouter model and
 * edits the event plan directly. Every step (the model's reasoning, each tool
 * call + result, the final reply) is streamed into `aiMessages` as it happens,
 * so the panel renders the agent's thinking live. Every edit is logged to
 * `aiChanges`, so the whole turn is one-click revertible.
 *
 * We talk to OpenRouter via RAW fetch (not an SDK) so reasoning + tool calls
 * pass through unmodified. The model is a swappable slug (see `@events-os/shared`).
 */
import { action } from "./_generated/server";
import { internal, api } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { v, ConvexError } from "convex/values";
import {
  aiCostUsd,
  ASSET_CONDITIONS,
  MODULE_KEYS,
  MODULE_LABELS,
  CORE_MODULE_KEYS,
  HOW_TO_SYSTEM_PROMPT,
  ASSISTANT_REASONING_EFFORT,
  FREE_MODEL_FALLBACKS,
  AI_MODELS,
  DEFAULT_AI_MODEL,
  OLLAMA_DEFAULT_CHAT_MODEL,
  PLAYBOOK_MD,
  dayKeyInTz,
  daysBetweenInTz,
  isFreeModelSlug,
  isOverChatBudget,
  tWindowLine,
  zonedParts,
  zonedTimeToUtc,
  type AiCatalogModel,
} from "@events-os/shared";
import {
  chatCompletion,
  resolveEngineModel,
  type AiEngineConfig,
  type NormalizedUsage,
} from "./lib/aiEngine";

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

/** Max model round-trips in one turn (each may carry several tool calls). */
const MAX_STEPS = 12;

/** Abort a single OpenRouter completion if it hangs longer than this. */
const OPENROUTER_TIMEOUT_MS = 60_000;

/**
 * Token headroom for the assistant. High-reasoning models emit a long thinking
 * trace BEFORE their tool calls; the old 1500 cap truncated that mid-plan, which
 * is why the agent looped without ever acting. 4000 leaves room to think AND act.
 */
const ASSISTANT_MAX_TOKENS = 4000;

/** Per-model retry attempts on a transient (429 / 5xx / timeout) failure. */
const RETRY_ATTEMPTS = 3;

/** Sleep helper for retry backoff (node action runtime). */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The editable fields of one item — shared by update_item and update_items. */
const ITEM_EDIT_PROPS = {
  item_id: { type: "string" },
  title: { type: "string" },
  status: { type: "string" },
  role: { type: "string", description: "Role label or key." },
  owner: { type: "string", description: "Person name, or 'none'." },
  offset_days: {
    type: "number",
    description: "Signed days from event date (negative = before).",
  },
  cost: { type: "number" },
  notes: { type: "string" },
  source: { type: "string", description: "Supplies only." },
  container: {
    type: "string",
    description: "Supplies: which container it travels in ('Packed in').",
  },
};

/** The tools the agent can call — all scoped to the current event, all revertible. */
const TOOLS = [
  {
    type: "function",
    function: {
      name: "update_items",
      description:
        "Edit MANY items at once — the efficient way to change multiple rows. " +
        "Pass an array of edits, each with an item_id plus only the fields to " +
        "change. ALWAYS prefer this over calling update_item repeatedly: to " +
        "change 8 items, make ONE update_items call with 8 edits. Each edit " +
        "may also carry any CUSTOM column key from the area's " +
        "allowed-values line (e.g. dispatch on retro rows) as an extra " +
        "property.",
      parameters: {
        type: "object",
        properties: {
          edits: {
            type: "array",
            items: {
              type: "object",
              properties: ITEM_EDIT_PROPS,
              required: ["item_id"],
              // Extra keys = custom column keys for that item's workstream
              // (validated at dispatch against the event's actual columns).
              additionalProperties: true,
            },
          },
        },
        required: ["edits"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_item",
      description:
        "Edit fields of ONE existing item. For multiple items use update_items " +
        "instead. Use the exact status/source/container VALUES and role labels " +
        "from the context. owner is a person's name, or 'none' to clear. You " +
        "may also pass any CUSTOM column key from the area's " +
        "allowed-values line (e.g. dispatch on retro rows) as an extra " +
        "property, with a value from that column's options.",
      parameters: {
        type: "object",
        properties: ITEM_EDIT_PROPS,
        required: ["item_id"],
        // Extra keys = custom column keys for that item's workstream
        // (validated at dispatch against the event's actual columns).
        additionalProperties: true,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_item",
      description:
        "Add a new item to an area. module is an area KEY from the " +
        "event context's AREAS list (core or custom). Provide a clear " +
        "title; other fields optional.",
      parameters: {
        type: "object",
        properties: {
          module: {
            type: "string",
            description: "An area key from the event context.",
          },
          title: { type: "string" },
          status: { type: "string" },
          role: { type: "string" },
          offset_days: { type: "number" },
          cost: { type: "number" },
          notes: { type: "string" },
        },
        required: ["module", "title"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_photos",
      description:
        "Find and attach a representative photo for one or more items by " +
        "searching free, openly-licensed image libraries. Pass an array of " +
        "{item_id, query}, where query is a short search phrase (e.g. 'Shure " +
        "SM58 microphone', 'folding table'). Use this whenever the user asks to " +
        "find or add photos online. To photo every item, pass them all at once.",
      parameters: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                item_id: { type: "string" },
                query: { type: "string" },
              },
              required: ["item_id", "query"],
              additionalProperties: false,
            },
          },
        },
        required: ["items"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_photo",
      description:
        "Set an item's photo from a DIRECT image-file URL (jpg/png/webp) the " +
        "user explicitly provided. To search for photos, use find_photos instead.",
      parameters: {
        type: "object",
        properties: {
          item_id: { type: "string" },
          image_url: { type: "string" },
        },
        required: ["item_id", "image_url"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_readiness",
      description:
        "READ the event's situational-awareness snapshot: phase scores, " +
        "days-to-event + current T-window, unassigned roles, areas " +
        "missing owners, per-area ready flags, overdue / due-in-3-days / " +
        "unowned items, placeholder crew still engaged, and engagement " +
        "invited/confirmed/declined counts. Call this FIRST in a working " +
        "session to build your opening briefing.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "remove_item",
      description:
        "DELETE an item by id. Destructive — only call when the user " +
        "explicitly asked for a deletion in this conversation. The delete is " +
        "revertible from the run's Undo.",
      parameters: {
        type: "object",
        properties: { item_id: { type: "string" } },
        required: ["item_id"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "assign_role",
      description:
        "Put a person in an event role. One person per role — assigning " +
        "replaces the current holder. role is a role label or key from the " +
        "context; person is a roster name.",
      parameters: {
        type: "object",
        properties: {
          role: { type: "string" },
          person: { type: "string" },
        },
        required: ["role", "person"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "unassign_role",
      description: "Clear an event role's assignment. role is a label or key.",
      parameters: {
        type: "object",
        properties: { role: { type: "string" } },
        required: ["role"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_engagement",
      description:
        "Engage a roster person on this event as crew (they start 'invited'). " +
        "type is volunteer or paid; teams are team VALUES from the " +
        "Crew Duties team column; call_time is a display string like " +
        "'7:30 AM'; amount_usd is the payment amount for PAID engagements. " +
        "If the person is already engaged, use update_engagement.",
      parameters: {
        type: "object",
        properties: {
          person: { type: "string" },
          type: { type: "string", enum: ["volunteer", "paid"] },
          teams: { type: "array", items: { type: "string" } },
          service: { type: "string" },
          call_time: { type: "string" },
          amount_usd: {
            type: "number",
            description: "Payment amount in US dollars (paid engagements).",
          },
        },
        required: ["person", "type"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_engagement",
      description:
        "Update a person's existing crew engagement on this event: status " +
        "(invited|confirmed|declined), teams, service, call_time, amount_usd " +
        "(payment, for paid engagements), and/or type (volunteer|paid). Pass " +
        "only the fields to change; pass null for service/call_time/amount_usd " +
        "to CLEAR them.",
      parameters: {
        type: "object",
        properties: {
          person: { type: "string" },
          status: {
            type: "string",
            enum: ["invited", "confirmed", "declined"],
          },
          teams: { type: "array", items: { type: "string" } },
          service: { type: ["string", "null"] },
          call_time: { type: ["string", "null"] },
          amount_usd: {
            type: ["number", "null"],
            description:
              "Payment amount in US dollars (paid engagements); null clears it.",
          },
          type: { type: "string", enum: ["volunteer", "paid"] },
        },
        required: ["person"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_person",
      description:
        "Add a new person to the chapter roster (so they can then be engaged " +
        "or assigned). Only name is required.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          email: { type: "string" },
          phone: { type: "string" },
        },
        required: ["name"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_workstream_owner",
      description:
        "Set which ROLE owns an area / workstream (accountability, not day-to-day " +
        "assignment). workstream is an area key or label from the context; role is " +
        "a role label/key, or 'none' to clear.",
      parameters: {
        type: "object",
        properties: {
          workstream: { type: "string" },
          role: { type: "string" },
        },
        required: ["workstream", "role"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "toggle_workstream",
      description:
        "Enable or disable a CORE area on this event (custom " +
        "areas can't be toggled). Disabling hides its surface — ask " +
        "the user before disabling anything with items in it.",
      parameters: {
        type: "object",
        properties: {
          workstream: { type: "string" },
          enabled: { type: "boolean" },
        },
        required: ["workstream", "enabled"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_custom_workstream",
      description:
        "Create a new custom area on this event (e.g. a merch stand or " +
        "food operation), with default columns seeded. owner_role is a role " +
        "label/key; offset_mode is none (default), days, or minutes.",
      parameters: {
        type: "object",
        properties: {
          label: { type: "string" },
          owner_role: { type: "string" },
          offset_mode: {
            type: "string",
            enum: ["none", "days", "minutes"],
          },
        },
        required: ["label"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "reschedule_event",
      description:
        "Move the event to a new date — only when the user explicitly asked. " +
        "date is an ISO date (YYYY-MM-DD keeps the current start time) or a " +
        "full ISO datetime. Every offset-derived due date is re-derived, and " +
        "the result reports how many tasks are now past due (feasibility).",
      parameters: {
        type: "object",
        properties: { date: { type: "string" } },
        required: ["date"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "diff_event_vs_template",
      description:
        "READ how this event has diverged from its template: items added/" +
        "modified/removed in the event (structure only — statuses and owners " +
        "never count), new custom areas, and column changes. Use it " +
        "during the debrief (playbook Window 5) or when the user asks what " +
        "should be promoted back to the template.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "promote_to_template",
      description:
        "WRITE approved changes from this event back into its template — the " +
        "institutional memory (playbook Philosophy 1). Only call after the " +
        "user approved the specific promotions in this conversation; template " +
        "edits affect every future event and are NOT covered by the run's " +
        "Undo. Promotes structure, never event state. Entries reference ids " +
        "from diff_event_vs_template.",
      parameters: {
        type: "object",
        properties: {
          promotions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                kind: {
                  type: "string",
                  enum: [
                    "add_item",
                    "update_item",
                    "remove_item",
                    "add_module",
                    "column",
                  ],
                },
                event_item_id: { type: "string" },
                template_item_id: { type: "string" },
                fields: { type: "array", items: { type: "string" } },
                module_key: { type: "string" },
                module: { type: "string" },
                key: { type: "string" },
              },
              required: ["kind"],
              additionalProperties: false,
            },
          },
        },
        required: ["promotions"],
        additionalProperties: false,
      },
    },
  },
];

interface OpenRouterUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  cost?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

/** One tool call the model emits (OpenAI/OpenRouter wire shape). */
interface ToolCall {
  id?: string;
  function?: { name?: string; arguments?: string };
}

/** The assistant message the model returns each round. */
interface ModelMessage {
  role?: string;
  content?: string | null;
  reasoning?: string | null;
  tool_calls?: ToolCall[];
}

/** A chat message we send to / push onto the OpenRouter conversation. */
type ChatMessage =
  | { role: "system" | "user" | "assistant"; content: string }
  | ({ role: "assistant" } & ModelMessage)
  | { role: "tool"; tool_call_id?: string; content: string };

/**
 * Parse a tool call's JSON arguments. Returns the parsed object, or null when
 * the model emitted malformed JSON — callers surface that instead of silently
 * dispatching with `{}` (which would no-op confusingly).
 */
function parseToolArgs(tc: ToolCall): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(tc.function?.arguments ?? "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return null;
  }
}

/** Cost for one completion: prefer the gateway's exact cost, else estimate ($0 free). */
function callCost(slug: string, usage: OpenRouterUsage): number {
  if (typeof usage.cost === "number") return usage.cost;
  return aiCostUsd(slug, {
    inputTokens: usage.prompt_tokens ?? 0,
    outputTokens: usage.completion_tokens ?? 0,
    cachedTokens: usage.prompt_tokens_details?.cached_tokens,
  });
}

/**
 * A failed OpenRouter completion, tagged with whether it's worth retrying.
 * `retryable` is true for rate limits (429), upstream 5xx, and timeouts — the
 * transient failures the resilient wrapper backs off / falls back on. A 4xx like
 * 400/401/403 is a hard error (bad request / bad key) — retrying won't help.
 */
class OpenRouterError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "OpenRouterError";
  }
}

/**
 * One OpenRouter chat-completions call (raw fetch), HIGH reasoning by default.
 *
 * Tool set is configurable: pass `opts.tools` (an array of tool defs) to enable
 * tool-calling with that exact set. Omit it for a plain completion (no tools).
 * Each agent passes its OWN tool set — the event agent passes `TOOLS`, the doc
 * agent passes `DOC_TOOLS`. Throws {@link OpenRouterError} on failure so the
 * resilient wrapper can tell a transient 429 apart from a hard 400.
 */
/** Map the engine's normalized usage back onto the `OpenRouterUsage` shape the
 *  cost/usage accounting in this file reads. `cost` is only present on
 *  OpenRouter; for Ollama it's undefined → `callCost` estimates $0 (subscription). */
function toActionsUsage(u: NormalizedUsage | undefined): OpenRouterUsage {
  if (!u) return {};
  return {
    prompt_tokens: u.promptTokens,
    completion_tokens: u.completionTokens,
    cost: u.costUsd,
    prompt_tokens_details:
      u.cachedTokens != null ? { cached_tokens: u.cachedTokens } : undefined,
  };
}

async function engineCall(
  config: AiEngineConfig,
  slug: string,
  messages: ChatMessage[],
  opts: { tools?: unknown[]; maxTokens?: number; effort?: string } = {},
): Promise<{ message: ModelMessage; usage: OpenRouterUsage }> {
  // Prompt caching: the system message is by far the largest block (playbook +
  // live snapshot) and is stable within a turn's tool loop. Send it as a text
  // block tagged `cache_control` so OpenRouter's pass-through caching (Anthropic
  // etc.) reuses it. ONLY for OpenRouter — Ollama has no such field, so it gets
  // the plain messages (identical OpenRouter behavior preserved).
  const wireMessages =
    config.provider === "openrouter"
      ? messages.map((m) =>
          m.role === "system" && typeof m.content === "string"
            ? {
                role: "system" as const,
                content: [
                  {
                    type: "text",
                    text: m.content,
                    cache_control: { type: "ephemeral" },
                  },
                ],
              }
            : m,
        )
      : messages;
  const result = await chatCompletion(config, {
    model: slug,
    messages: wireMessages,
    tools: opts.tools,
    maxTokens: opts.maxTokens ?? ASSISTANT_MAX_TOKENS,
    reasoningEffort: opts.effort ?? ASSISTANT_REASONING_EFFORT,
    timeoutMs: OPENROUTER_TIMEOUT_MS,
  });
  if (!result.ok) {
    // Re-wrap the typed engine error as OpenRouterError so `resilientCall`'s
    // retry/fallback logic (transient vs. hard) is UNCHANGED across providers.
    throw new OpenRouterError(result.message, result.status, result.retryable);
  }
  return { message: result.message as ModelMessage, usage: toActionsUsage(result.usage) };
}

/**
 * Resilient completion: try the chosen model, and when it's a FREE model that's
 * transiently failing (429 rate-limit / 5xx / timeout), retry with backoff and
 * then transparently fall back to the next free model. This is the fix for the
 * "assistant just dies on a 429" problem — free OpenRouter pools throttle
 * constantly, so one busy provider must not sink the turn.
 *
 * Paid models never fall back (the user chose+paid for that specific one) but
 * still get a couple of backed-off retries for a blip. A HARD error (bad key,
 * malformed request) surfaces immediately — retrying it is pointless. Returns
 * the actual model used, so cost is billed against what really ran.
 */
async function resilientCall(
  config: AiEngineConfig,
  slug: string,
  messages: ChatMessage[],
  opts: { tools?: unknown[]; maxTokens?: number; effort?: string } = {},
): Promise<{ message: ModelMessage; usage: OpenRouterUsage; slug: string }> {
  const candidates = [slug];
  // Free-model fallback is an OpenRouter concept (its shared free pools throttle
  // constantly, and `FREE_MODEL_FALLBACKS` are OpenRouter slugs). On Ollama there
  // is no fallback chain — just retry the chosen model.
  if (config.provider === "openrouter" && isFreeModelSlug(slug)) {
    for (const fallback of FREE_MODEL_FALLBACKS) {
      if (fallback !== slug) candidates.push(fallback);
    }
  }

  let lastErr: unknown;
  for (const model of candidates) {
    for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
      try {
        const { message, usage } = await engineCall(config, model, messages, opts);
        return { message, usage, slug: model };
      } catch (err) {
        lastErr = err;
        const retryable = err instanceof OpenRouterError && err.retryable;
        if (!retryable) {
          // Hard error (bad key / bad request) → surface NOW with its detail.
          // Re-wrap as a ConvexError so the callers' catch (which reads
          // `err.data.message`) shows the status/body instead of "Agent error."
          const message =
            err instanceof Error ? err.message : "OpenRouter request failed.";
          throw new ConvexError({ code: "OPENROUTER_ERROR", message });
        }
        // Backoff before the next attempt on this model (400ms, 800ms, …).
        if (attempt < RETRY_ATTEMPTS - 1) await sleep(400 * 2 ** attempt);
      }
    }
    // Exhausted retries on `model` → try the next free fallback (if any).
  }
  // Every candidate exhausted its retries — surface the last transient failure
  // as a ConvexError so the panel shows a clean message.
  const message =
    lastErr instanceof OpenRouterError
      ? lastErr.message
      : "OpenRouter is unavailable right now. Please try again shortly.";
  throw new ConvexError({ code: "OPENROUTER_ERROR", message });
}

/**
 * Map an OpenRouter `/models` catalog entry to the compact `AiCatalogModel` the
 * picker renders. Returns null for entries that can't tool-call (the agent needs
 * function calling, so a non-tool model would be useless here).
 */
function toCatalogModel(entry: any): AiCatalogModel | null {
  const slug = typeof entry?.id === "string" ? entry.id : null;
  if (!slug) return null;
  const params: string[] = Array.isArray(entry?.supported_parameters)
    ? entry.supported_parameters
    : [];
  const toolCalling = params.includes("tools");
  if (!toolCalling) return null;
  const promptPrice = parseFloat(entry?.pricing?.prompt ?? "0") || 0;
  const completionPrice = parseFloat(entry?.pricing?.completion ?? "0") || 0;
  const inputPerMTok = promptPrice * 1_000_000;
  const outputPerMTok = completionPrice * 1_000_000;
  return {
    slug,
    label: typeof entry?.name === "string" ? entry.name : slug,
    free: isFreeModelSlug(slug, { inputPerMTok, outputPerMTok }),
    inputPerMTok,
    outputPerMTok,
    contextLength:
      typeof entry?.context_length === "number" ? entry.context_length : null,
    toolCalling,
    reasoning: params.includes("reasoning") || !!entry?.reasoning,
  };
}

/** Curated fallback catalog (our seed models) when the live fetch fails. */
function curatedCatalog(): AiCatalogModel[] {
  return Object.values(AI_MODELS).map((m) => ({
    slug: m.slug,
    label: m.label,
    free: m.free,
    inputPerMTok: m.inputPerMTok,
    outputPerMTok: m.outputPerMTok,
    contextLength: null,
    toolCalling: true,
    reasoning: true,
  }));
}

/**
 * Fetch the live OpenRouter model catalog, keeping only tool-calling models,
 * sorted free-first then by name. Falls back to our curated list on any error,
 * so the picker always has something to show.
 */
async function fetchCatalog(): Promise<AiCatalogModel[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const res = await fetch(OPENROUTER_MODELS_URL, {
      signal: controller.signal,
      headers: {
        ...(process.env.OPENROUTER_API_KEY
          ? { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` }
          : {}),
        "HTTP-Referer": "https://events-os.app",
        "X-OpenRouter-Title": "Chapter OS",
      },
    });
    if (!res.ok) return curatedCatalog();
    const json: any = await res.json();
    const entries: any[] = Array.isArray(json?.data) ? json.data : [];
    const models = entries
      .map(toCatalogModel)
      .filter((m): m is AiCatalogModel => m !== null);
    if (models.length === 0) return curatedCatalog();
    return models.sort((a, b) => {
      if (a.free !== b.free) return a.free ? -1 : 1; // free first
      return a.label.localeCompare(b.label);
    });
  } catch {
    return curatedCatalog();
  } finally {
    clearTimeout(timer);
  }
}

const SEARCH_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/**
 * DuckDuckGo image search (no API key) — returns DIRECT image URLs for the
 * actual product (e.g. the specific ALTO speaker), like a real web image search.
 * Two-step: scrape a `vqd` token from the search page, then hit the i.js JSON
 * endpoint. Works well from the local dev backend (requests originate from the
 * developer's own IP); may rate-limit from cloud datacenter IPs.
 */
async function ddgImageUrls(query: string): Promise<string[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const tokenRes = await fetch(
      "https://duckduckgo.com/?ia=images&iax=images&q=" +
        encodeURIComponent(query),
      { signal: controller.signal, headers: { "User-Agent": SEARCH_UA } },
    );
    const html = await tokenRes.text();
    const vqd =
      html.match(/vqd=["']([^"']+)["']/)?.[1] ??
      html.match(/vqd=([0-9-]+)&/)?.[1] ??
      html.match(/vqd=([0-9-]+)/)?.[1];
    if (!vqd) return [];
    const apiRes = await fetch(
      `https://duckduckgo.com/i.js?l=us-en&o=json&q=${encodeURIComponent(
        query,
      )}&vqd=${encodeURIComponent(vqd)}&f=,,,,,&p=1`,
      {
        signal: controller.signal,
        headers: {
          "User-Agent": SEARCH_UA,
          Referer: "https://duckduckgo.com/",
          Accept: "application/json, text/javascript, */*; q=0.01",
        },
      },
    );
    if (!apiRes.ok) return [];
    const json: any = await apiRes.json();
    return ((json?.results ?? []) as any[])
      .map((r) => r.image)
      .filter((u): u is string => typeof u === "string" && u.length > 0);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** Openverse fallback (free, openly-licensed, no key) — used if DDG comes back empty. */
async function openverseImageUrls(query: string): Promise<string[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(
      "https://api.openverse.org/v1/images/?page_size=5&mature=false&q=" +
        encodeURIComponent(query),
      {
        signal: controller.signal,
        headers: { "User-Agent": "Chapter OS (https://events-os.app)" },
      },
    );
    if (!res.ok) return [];
    const json: any = await res.json();
    return ((json?.results ?? []) as any[])
      .map((r) => r.url)
      .filter((u): u is string => typeof u === "string" && u.length > 0);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Find candidate DIRECT image URLs for a query, best-first: real web image
 * search (DuckDuckGo) for exact products, falling back to Openverse.
 */
async function searchImageUrls(query: string): Promise<string[]> {
  const ddg = await ddgImageUrls(query);
  if (ddg.length) return ddg;
  return await openverseImageUrls(query);
}

/**
 * Free, no-key web TEXT search via DuckDuckGo's Instant Answer API — the doc
 * agent's research tool. Pulls the instant answer (`Abstract`/`Heading`) plus
 * the related-topics list, flattened into up to ~5 `{ title, snippet, url }`
 * results. Defensive: any error or empty response returns `[]`.
 */
async function webSearch(
  query: string,
): Promise<{ title: string; snippet: string; url?: string }[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(
      "https://api.duckduckgo.com/?q=" +
        encodeURIComponent(query) +
        "&format=json&no_redirect=1&no_html=1",
      { signal: controller.signal, headers: { "User-Agent": SEARCH_UA } },
    );
    if (!res.ok) return [];
    const json: any = await res.json();
    const results: { title: string; snippet: string; url?: string }[] = [];

    const abstract =
      (typeof json?.AbstractText === "string" && json.AbstractText) ||
      (typeof json?.Abstract === "string" && json.Abstract) ||
      "";
    if (abstract.trim()) {
      results.push({
        title:
          (typeof json?.Heading === "string" && json.Heading) || query,
        snippet: abstract.trim(),
        url:
          typeof json?.AbstractURL === "string" && json.AbstractURL
            ? json.AbstractURL
            : undefined,
      });
    }

    // RelatedTopics can be a flat list or nested groups ({ Topics: [...] }).
    const flatten = (topics: any[]): any[] =>
      topics.flatMap((t) =>
        Array.isArray(t?.Topics) ? flatten(t.Topics) : [t],
      );
    const related = Array.isArray(json?.RelatedTopics)
      ? flatten(json.RelatedTopics)
      : [];
    for (const t of related) {
      const text = typeof t?.Text === "string" ? t.Text.trim() : "";
      if (!text) continue;
      results.push({
        title: text.length > 60 ? text.slice(0, 60) + "…" : text,
        snippet: text,
        url:
          typeof t?.FirstURL === "string" && t.FirstURL ? t.FirstURL : undefined,
      });
      if (results.length >= 5) break;
    }

    return results.slice(0, 5);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * SSRF guard: reject any URL that isn't plain http(s) to a public host before
 * we fetch it. Image URLs here are model-emitted (find_photos) or user-supplied
 * (set_photo), so without this an attacker could make the Convex backend fetch
 * internal/metadata endpoints (cloud metadata, localhost, private LANs). We
 * only allow http/https and block loopback, link-local, and RFC1918/ULA hosts.
 */
function isSafePublicImageUrl(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;

  // Strip brackets from IPv6 literals; lowercase for matching.
  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host) return false;

  // Block obvious loopback / "any" / metadata hostnames outright.
  if (
    host === "localhost" ||
    host === "0.0.0.0" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    return false;
  }

  // IPv4 literal → reject loopback, link-local, and private ranges.
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const octets = ipv4.slice(1).map((n) => parseInt(n, 10));
    if (octets.some((n) => Number.isNaN(n) || n > 255)) return false; // malformed → unsafe
    const [a, b] = octets;
    if (a === 127 || a === 10 || a === 0) return false; // loopback / RFC1918 / "this host"
    if (a === 169 && b === 254) return false; // link-local (incl. cloud metadata 169.254.169.254)
    if (a === 172 && b >= 16 && b <= 31) return false; // RFC1918
    if (a === 192 && b === 168) return false; // RFC1918
    if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT (RFC6598)
    return true;
  }

  // IPv6 literal → reject loopback (::1), unspecified (::), link-local (fe80::),
  // unique-local (fc00::/7 → fc/fd), and IPv4-mapped private space.
  if (host.includes(":")) {
    if (host === "::1" || host === "::") return false;
    if (host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd"))
      return false;
    if (host.startsWith("::ffff:")) return false; // IPv4-mapped — can't vet the embedded v4 safely
    return true;
  }

  // Must be a normal public DNS name: a dot plus an alphabetic (or punycode)
  // TLD. This rejects ALTERNATE IP encodings that the fetch runtime would still
  // resolve to a raw address but the dotted-quad/IPv6 checks above miss —
  // decimal (2130706433), hex (0x7f000001), octal/short-form (0177.0.0.1,
  // 127.1) — none of which we could vet against the private ranges.
  // (DNS rebinding — a real hostname whose A record points at a private IP —
  // remains unhandled: Convex's fetch gives no resolved-IP hook. `redirect:
  // "error"` blocks the redirect variant; this is the documented residual risk.)
  const bareHost = host.replace(/\.$/, ""); // tolerate a trailing-dot FQDN
  const tld = bareHost.includes(".")
    ? bareHost.slice(bareHost.lastIndexOf(".") + 1)
    : "";
  if (!/^([a-z]{2,}|xn--[a-z0-9]+)$/.test(tld)) return false;
  return true;
}

/** Fetch an image URL with a ~10s timeout; return a Blob iff it's an image. */
async function fetchImageBlob(url: string): Promise<Blob | null> {
  // SSRF: never fetch a private/loopback/non-http(s) URL (see guard above).
  if (!isSafePublicImageUrl(url)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: "error" });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type");
    if (!ct?.startsWith("image/")) return null;
    return await res.blob();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The shape `internal.ai.eventContext` returns — the agent's working snapshot. */
interface EventCtx {
  event: {
    id: Id<"events">;
    name: string;
    date: number;
    budget: number | null;
    status: string;
    location: string | null;
  };
  roles: Array<{
    id: Id<"eventRoles">;
    key: string;
    label: string;
    person: string | null;
  }>;
  people: Array<{ id: Id<"people">; name: string }>;
  modules: Array<{
    key: string;
    label: string;
    surface: string;
    ownerRoleKey: string | null;
    ready: boolean;
  }>;
  optionsByModule: Record<string, Record<string, string[]>>;
  columnsByModule: Record<
    string,
    Array<{ key: string; kind: string; type: string; options: string[] | null }>
  >;
  items: Array<{
    id: Id<"eventItems">;
    module: string;
    title: string;
    status: string | null;
    role: string | null;
    offsetDays: number | null;
    source: string | null;
    container: string | null;
    /** Supplies: the Packing-checklist boolean (fields.packedIn). */
    packedIn: boolean;
    cost: unknown;
    notes: unknown;
    hasPhoto: boolean;
  }>;
}
type Ctx = EventCtx;

/** Resolve a role label/key to a roleId from the event context. */
function resolveRole(context: Ctx, raw: string): Id<"eventRoles"> | undefined {
  const needle = raw.trim().toLowerCase();
  const hit = context.roles.find(
    (r) => r.label.toLowerCase() === needle || r.key.toLowerCase() === needle,
  );
  return hit?.id as Id<"eventRoles"> | undefined;
}

/** Resolve a person name to a personId from the roster (case-insensitive). */
function resolveOwner(context: Ctx, raw: string): Id<"people"> | null | undefined {
  const needle = raw.trim().toLowerCase();
  if (needle === "none" || needle === "") return null; // explicit clear
  const hit = context.people.find((p) => p.name.toLowerCase() === needle);
  return (hit?.id as Id<"people">) ?? undefined;
}

/**
 * Resolve a person by name, STRICTLY: exact (case-insensitive) match first,
 * then a unique substring match. Ambiguity or a miss returns an error string
 * listing the candidates instead of silently picking one — the crew/role tools
 * must never guess a person.
 */
function resolvePersonStrict(
  context: Ctx,
  raw: string,
): { id: Id<"people">; name: string } | { error: string } {
  const needle = raw.trim().toLowerCase();
  if (!needle) return { error: "No person name given." };
  let matches = context.people.filter((p) => p.name.toLowerCase() === needle);
  if (matches.length === 0) {
    matches = context.people.filter((p) =>
      p.name.toLowerCase().includes(needle),
    );
  }
  if (matches.length === 0) {
    return {
      error: `No person named "${raw}" on the roster. Use add_person to add them first.`,
    };
  }
  if (matches.length > 1) {
    return {
      error: `"${raw}" is ambiguous — candidates: ${matches
        .map((m) => m.name)
        .join(", ")}. Use the full name.`,
    };
  }
  return { id: matches[0].id as Id<"people">, name: matches[0].name };
}

/** Resolve a workstream key or label to its module key (case-insensitive). */
function resolveWorkstream(context: Ctx, raw: string): string | undefined {
  const needle = raw.trim().toLowerCase();
  const hit = context.modules.find(
    (m) => m.key.toLowerCase() === needle || m.label.toLowerCase() === needle,
  );
  if (hit) return hit.key;
  // Core modules the event currently has toggled OFF still resolve, so
  // toggle_workstream can re-enable them.
  const core = (MODULE_KEYS as readonly string[]).find(
    (k) =>
      k === needle ||
      (MODULE_LABELS as Record<string, string>)[k]?.toLowerCase() === needle,
  );
  return core;
}

/** Resolve a role label/key to the role's KEY (for workstream ownership). */
function resolveRoleKey(context: Ctx, raw: string): string | undefined {
  const needle = raw.trim().toLowerCase();
  const hit = context.roles.find(
    (r) => r.label.toLowerCase() === needle || r.key.toLowerCase() === needle,
  );
  return hit?.key;
}

/**
 * Parse the reschedule_event date argument. A bare YYYY-MM-DD keeps the
 * event's current wall-clock time in the PLANNING timezone on the requested
 * local calendar date (events.reschedule expects a full timestamp); anything
 * else goes through Date.parse. Returns null when unparseable OR when the
 * calendar date is invalid — month/day out of range, or a rollover date like
 * 2026-06-31 that would silently land on July 1st.
 *
 * Exported for tests.
 */
export function parseRescheduleDate(
  raw: string,
  currentDate: number,
): number | null {
  const s = raw.trim();
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (dateOnly) {
    const year = parseInt(dateOnly[1], 10);
    const month = parseInt(dateOnly[2], 10);
    const day = parseInt(dateOnly[3], 10);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    // Keep the event's current local wall-clock time on the new local day.
    const wall = zonedParts(currentDate);
    const ts = zonedTimeToUtc({
      year,
      month,
      day,
      hour: wall.hour,
      minute: wall.minute,
    });
    // Round-trip verify: the constructed instant must land on the REQUESTED
    // local calendar day (rejects rollovers like Jun 31 → Jul 1).
    if (dayKeyInTz(ts) !== `${dateOnly[1]}-${dateOnly[2]}-${dateOnly[3]}`) {
      return null;
    }
    return ts;
  }
  const ts = Date.parse(s);
  return Number.isNaN(ts) ? null : ts;
}

/** The edit props update_item handles directly (see ITEM_EDIT_PROPS). Any
 * OTHER prop must match a custom column of the item's workstream. */
const KNOWN_EDIT_KEYS = new Set(Object.keys(ITEM_EDIT_PROPS));

/** Column types whose cell values are ids/artifacts (storage ids, doc ids,
 * people ids) that the model must not write raw strings into. */
const UNWRITABLE_COLUMN_TYPES = new Set([
  "photo",
  "person",
  "role",
  "how_to",
  "due_date",
]);

/** Apply one item edit (revertibly). Returns an error string, or null on success. */
async function applyOneEdit(
  ctx: any,
  runId: Id<"aiRuns">,
  chapterId: Id<"chapters">,
  context: Ctx,
  args: any,
): Promise<string | null> {
  const itemId = args.item_id as Id<"eventItems">;
  const item = context.items.find((it) => String(it.id) === String(itemId));
  if (!item) return `No item with id ${args.item_id}.`;
  const promoted: Record<string, any> = {};
  const fields: Record<string, any> = {};
  if (args.title !== undefined) promoted.title = args.title;
  if (args.status !== undefined) promoted.status = args.status;
  if (args.offset_days !== undefined) promoted.offsetDays = args.offset_days;
  if (args.role !== undefined) {
    const roleId = resolveRole(context, String(args.role));
    if (!roleId) return `Unknown role "${args.role}".`;
    promoted.roleId = roleId;
  }
  if (args.owner !== undefined) {
    const owner = resolveOwner(context, String(args.owner));
    if (owner === undefined) return `No person named "${args.owner}".`;
    promoted.ownerPersonId = owner; // null clears
  }
  if (args.cost !== undefined) fields.cost = args.cost;
  if (args.notes !== undefined) fields.notes = args.notes;
  if (args.source !== undefined) fields.source = args.source;
  if (args.container !== undefined) fields.container = args.container;

  // Any other prop must be a CUSTOM column of this item's workstream (e.g. the
  // retro `dispatch` column) — validated against the column's options and
  // written into the `fields` bag. A prop that matches nothing is an ERROR,
  // not a silent success.
  const columns = context.columnsByModule[item.module] ?? [];
  for (const [key, value] of Object.entries(args)) {
    if (KNOWN_EDIT_KEYS.has(key)) continue;
    const col = columns.find((c) => c.key === key && c.kind === "custom");
    if (!col) {
      const customKeys = columns
        .filter((c) => c.kind === "custom")
        .map((c) => c.key);
      return (
        `Unknown property "${key}" for this item` +
        (customKeys.length
          ? ` — its custom columns are: ${customKeys.join(", ")}.`
          : ".")
      );
    }
    if (UNWRITABLE_COLUMN_TYPES.has(col.type)) {
      return `The "${key}" column can't be set through update_item.`;
    }
    if (col.options && value !== null) {
      // select = one option value; multiselect = an array of them.
      const values = Array.isArray(value) ? value.map(String) : [String(value)];
      const bad = values.find((v) => !col.options!.includes(v));
      if (bad !== undefined) {
        return `"${bad}" isn't a valid ${key} value — options: ${col.options.join(", ")}.`;
      }
      fields[key] = col.type === "multiselect" ? values : values[0];
    } else {
      fields[key] = value; // null clears the cell
    }
  }

  await ctx.runMutation(internal.ai.applyItemPatch, {
    runId,
    itemId,
    chapterId,
    promoted,
    fields,
  });
  return null;
}

/**
 * Turn a template-sync failure into a tool-result summary the model can act
 * on. A ConvexError carries an application message (NO_TEMPLATE_MATCH,
 * NOT_FOUND, …) — surface it verbatim. Anything else is almost always a
 * hallucinated/stale id failing argument validation — say what to do instead.
 */
function toolErrorSummary(err: unknown, fallback: string): string {
  if (err instanceof ConvexError) {
    const data = err.data as any;
    const message =
      (typeof data === "object" && data !== null && data.message) ||
      (typeof data === "string" && data) ||
      null;
    if (message) return String(message);
  }
  return fallback;
}

/** Generic-but-actionable message for a promote/diff failure without a
 * ConvexError message — almost always a hallucinated or stale id. */
const BAD_PROMOTION_IDS_MSG =
  "One of the promotion ids wasn't valid — re-run diff_event_vs_template " +
  "and use its ids.";

/** Run one tool call; apply the edit(s) (revertibly) and return a short result.
 * Exported for tests. */
export async function dispatchTool(
  ctx: any,
  runId: Id<"aiRuns">,
  eventId: Id<"events">,
  chapterId: Id<"chapters">,
  context: Ctx,
  name: string,
  args: any,
): Promise<{ ok: boolean; summary: string; edits?: number }> {
  if (name === "update_item") {
    const err = await applyOneEdit(ctx, runId, chapterId, context, args);
    return err ? { ok: false, summary: err } : { ok: true, summary: "Updated.", edits: 1 };
  }

  if (name === "update_items") {
    const edits: any[] = Array.isArray(args.edits) ? args.edits : [];
    if (edits.length === 0) return { ok: false, summary: "No edits provided." };
    let done = 0;
    const errors: string[] = [];
    for (const e of edits) {
      const err = await applyOneEdit(ctx, runId, chapterId, context, e);
      if (err) errors.push(err);
      else done++;
    }
    const summary =
      errors.length === 0
        ? `Updated ${done} item(s).`
        : `Updated ${done}; skipped ${errors.length} (${errors[0]})`;
    return { ok: done > 0, summary, edits: done };
  }

  if (name === "add_item") {
    // Validate against the event's ACTUAL active workstreams (core + custom),
    // not the static core list — items must be addable to custom workstreams.
    const activeKeys = context.modules.map((m) => m.key);
    if (!activeKeys.includes(args.module))
      return {
        ok: false,
        summary:
          `Unknown workstream "${args.module}" — valid keys: ` +
          `${activeKeys.join(", ")}.`,
      };
    const roleId = args.role ? resolveRole(context, String(args.role)) : undefined;
    const fields: Record<string, any> = {};
    if (args.cost !== undefined) fields.cost = args.cost;
    if (args.notes !== undefined) fields.notes = args.notes;
    await ctx.runMutation(internal.ai.createItem, {
      runId,
      eventId,
      chapterId,
      module: args.module,
      title: String(args.title ?? "Untitled"),
      status: args.status,
      roleId,
      offsetDays: args.offset_days,
      fields: Object.keys(fields).length ? fields : undefined,
    });
    return { ok: true, summary: `Added "${args.title}".` };
  }

  if (name === "find_photos") {
    const reqs: any[] = Array.isArray(args.items) ? args.items : [];
    if (reqs.length === 0)
      return { ok: false, summary: "No items to illustrate." };
    let done = 0;
    let tried = 0;
    for (const r of reqs) {
      const itemId = r.item_id as Id<"eventItems">;
      const query = String(r.query ?? "").trim();
      if (!query || !context.items.some((it) => String(it.id) === String(itemId)))
        continue;
      tried++;
      const candidates = await searchImageUrls(query);
      for (const u of candidates.slice(0, 3)) {
        const blob = await fetchImageBlob(u);
        if (blob) {
          const storageId = await ctx.storage.store(blob);
          await ctx.runMutation(internal.ai.setItemPhoto, {
            runId,
            itemId,
            chapterId,
            storageId,
          });
          done++;
          break;
        }
      }
    }
    return {
      ok: done > 0,
      summary: `Added ${done}/${tried} photo(s) from free image libraries.`,
      edits: done,
    };
  }

  if (name === "set_photo") {
    const itemId = args.item_id as Id<"eventItems">;
    if (!context.items.some((it) => String(it.id) === String(itemId)))
      return { ok: false, summary: `No item with id ${args.item_id}.` };
    const blob = args.image_url ? await fetchImageBlob(String(args.image_url)) : null;
    if (!blob)
      return { ok: false, summary: "That URL wasn't a direct image file." };
    const storageId = await ctx.storage.store(blob);
    await ctx.runMutation(internal.ai.setItemPhoto, {
      runId,
      itemId,
      chapterId,
      storageId,
    });
    return { ok: true, summary: "Photo set." };
  }

  if (name === "get_readiness") {
    const summary = await ctx.runQuery(internal.ai.readinessSummary, {
      eventId,
      chapterId,
    });
    if (!summary)
      return { ok: false, summary: "Couldn't read the event.", edits: 0 };
    return { ok: true, summary: JSON.stringify(summary), edits: 0 };
  }

  if (name === "remove_item") {
    const itemId = args.item_id as Id<"eventItems">;
    const idx = context.items.findIndex(
      (it) => String(it.id) === String(itemId),
    );
    if (idx < 0)
      return { ok: false, summary: `No item with id ${args.item_id}.`, edits: 0 };
    const title = context.items[idx].title;
    await ctx.runMutation(internal.ai.removeItem, { runId, itemId, chapterId });
    context.items.splice(idx, 1);
    return { ok: true, summary: `Deleted "${title}".`, edits: 1 };
  }

  if (name === "assign_role") {
    const roleId = resolveRole(context, String(args.role ?? ""));
    if (!roleId)
      return { ok: false, summary: `Unknown role "${args.role}".`, edits: 0 };
    const person = resolvePersonStrict(context, String(args.person ?? ""));
    if ("error" in person) return { ok: false, summary: person.error, edits: 0 };
    await ctx.runMutation(internal.ai.assignRole, {
      eventId,
      chapterId,
      roleId,
      personId: person.id,
    });
    const role = context.roles.find((r) => String(r.id) === String(roleId));
    if (role) role.person = person.name;
    return {
      ok: true,
      summary: `Assigned ${person.name} to ${role?.label ?? args.role}.`,
      edits: 1,
    };
  }

  if (name === "unassign_role") {
    const roleId = resolveRole(context, String(args.role ?? ""));
    if (!roleId)
      return { ok: false, summary: `Unknown role "${args.role}".`, edits: 0 };
    await ctx.runMutation(internal.ai.unassignRole, {
      eventId,
      chapterId,
      roleId,
    });
    const role = context.roles.find((r) => String(r.id) === String(roleId));
    if (role) role.person = null;
    return {
      ok: true,
      summary: `Cleared ${role?.label ?? args.role}.`,
      edits: 1,
    };
  }

  if (name === "add_engagement") {
    const person = resolvePersonStrict(context, String(args.person ?? ""));
    if ("error" in person) return { ok: false, summary: person.error, edits: 0 };
    const type = args.type === "paid" ? ("paid" as const) : ("volunteer" as const);
    const res = await ctx.runMutation(internal.ai.addEngagement, {
      eventId,
      chapterId,
      personId: person.id,
      type,
      teams: Array.isArray(args.teams) ? args.teams.map(String) : undefined,
      service: args.service != null ? String(args.service) : undefined,
      callTime: args.call_time != null ? String(args.call_time) : undefined,
      amountUsd:
        typeof args.amount_usd === "number" ? args.amount_usd : undefined,
    });
    if (!res)
      return { ok: false, summary: "Couldn't engage — event not found.", edits: 0 };
    if (res.alreadyEngaged)
      return {
        ok: false,
        summary: `${person.name} is already engaged on this event — use update_engagement.`,
        edits: 0,
      };
    return {
      ok: true,
      summary: `Engaged ${person.name} as ${type} (status: invited).`,
      edits: 1,
    };
  }

  if (name === "update_engagement") {
    const person = resolvePersonStrict(context, String(args.person ?? ""));
    if ("error" in person) return { ok: false, summary: person.error, edits: 0 };
    const patch: Record<string, unknown> = {};
    if (args.status !== undefined) {
      if (!["invited", "confirmed", "declined"].includes(args.status))
        return { ok: false, summary: `Bad status "${args.status}".`, edits: 0 };
      patch.status = args.status;
    }
    if (args.type !== undefined) {
      if (!["volunteer", "paid"].includes(args.type))
        return { ok: false, summary: `Bad type "${args.type}".`, edits: 0 };
      patch.type = args.type;
    }
    if (args.teams !== undefined)
      patch.teams = Array.isArray(args.teams) ? args.teams.map(String) : null;
    // Explicit null CLEARS service / call_time / amount_usd.
    if (args.service !== undefined)
      patch.service = args.service === null ? null : String(args.service);
    if (args.call_time !== undefined)
      patch.callTime = args.call_time === null ? null : String(args.call_time);
    if (args.amount_usd !== undefined) {
      if (args.amount_usd !== null && typeof args.amount_usd !== "number")
        return {
          ok: false,
          summary: `Bad amount_usd "${args.amount_usd}" — pass a number or null.`,
          edits: 0,
        };
      patch.amountUsd = args.amount_usd;
    }
    if (Object.keys(patch).length === 0)
      return { ok: false, summary: "No engagement fields to change.", edits: 0 };
    const res = await ctx.runMutation(internal.ai.updateEngagement, {
      eventId,
      chapterId,
      personId: person.id,
      ...patch,
    });
    if (!res)
      return {
        ok: false,
        summary: `${person.name} has no engagement on this event — use add_engagement.`,
        edits: 0,
      };
    return { ok: true, summary: `Updated ${person.name}'s engagement.`, edits: 1 };
  }

  if (name === "add_person") {
    const personName = String(args.name ?? "").trim();
    if (!personName) return { ok: false, summary: "No name given.", edits: 0 };
    if (
      context.people.some(
        (p) => p.name.toLowerCase() === personName.toLowerCase(),
      )
    )
      return {
        ok: false,
        summary: `"${personName}" is already on the roster.`,
        edits: 0,
      };
    const personId = await ctx.runMutation(internal.ai.addPerson, {
      chapterId,
      name: personName,
      email: args.email !== undefined ? String(args.email) : undefined,
      phone: args.phone !== undefined ? String(args.phone) : undefined,
    });
    // Keep the turn's snapshot current so follow-up tools resolve the name.
    context.people.push({ id: personId, name: personName });
    return { ok: true, summary: `Added ${personName} to the roster.`, edits: 1 };
  }

  if (name === "set_workstream_owner") {
    const key = resolveWorkstream(context, String(args.workstream ?? ""));
    if (!key)
      return {
        ok: false,
        summary: `Unknown workstream "${args.workstream}".`,
        edits: 0,
      };
    const roleRaw = String(args.role ?? "").trim();
    let ownerRoleKey: string | null = null;
    if (roleRaw && roleRaw.toLowerCase() !== "none") {
      const rk = resolveRoleKey(context, roleRaw);
      if (!rk)
        return { ok: false, summary: `Unknown role "${args.role}".`, edits: 0 };
      ownerRoleKey = rk;
    }
    const res = await ctx.runMutation(internal.ai.setModuleOwner, {
      eventId,
      chapterId,
      key,
      ownerRoleKey,
    });
    if (!res)
      return {
        ok: false,
        summary: `Couldn't set an owner for "${args.workstream}".`,
        edits: 0,
      };
    const mod = context.modules.find((m) => m.key === key);
    if (mod) mod.ownerRoleKey = ownerRoleKey;
    return {
      ok: true,
      summary: ownerRoleKey
        ? `${mod?.label ?? key} is now owned by the ${roleRaw} role.`
        : `Cleared ${mod?.label ?? key}'s owner role.`,
      edits: 1,
    };
  }

  if (name === "toggle_workstream") {
    const key = resolveWorkstream(context, String(args.workstream ?? ""));
    if (!key)
      return {
        ok: false,
        summary: `Unknown workstream "${args.workstream}".`,
        edits: 0,
      };
    const enabled = args.enabled === true;
    const res = await ctx.runMutation(internal.ai.toggleModule, {
      eventId,
      chapterId,
      key,
      enabled,
    });
    if (!res)
      return {
        ok: false,
        summary: `Only core workstreams can be toggled — "${args.workstream}" is custom.`,
        edits: 0,
      };
    return {
      ok: true,
      summary: `${enabled ? "Enabled" : "Disabled"} the ${
        (MODULE_LABELS as Record<string, string>)[key] ?? key
      } area.`,
      edits: 1,
    };
  }

  if (name === "create_custom_workstream") {
    const label = String(args.label ?? "").trim();
    if (!label) return { ok: false, summary: "No label given.", edits: 0 };
    let ownerRoleKey: string | undefined;
    if (args.owner_role !== undefined && String(args.owner_role).trim()) {
      ownerRoleKey = resolveRoleKey(context, String(args.owner_role));
      if (!ownerRoleKey)
        return {
          ok: false,
          summary: `Unknown role "${args.owner_role}".`,
          edits: 0,
        };
    }
    const offsetMode = ["none", "days", "minutes"].includes(args.offset_mode)
      ? (args.offset_mode as "none" | "days" | "minutes")
      : undefined;
    const res = await ctx.runMutation(internal.ai.createCustomModule, {
      eventId,
      chapterId,
      label,
      ownerRoleKey,
      offsetMode,
    });
    if (!res)
      return { ok: false, summary: "Couldn't create the area.", edits: 0 };
    context.modules.push({
      key: res.key,
      label,
      surface: "grid",
      ownerRoleKey: ownerRoleKey ?? null,
      ready: false,
    });
    return {
      ok: true,
      summary: `Created area "${label}" (key=${res.key}) with default columns.`,
      edits: 1,
    };
  }

  if (name === "reschedule_event") {
    const ts = parseRescheduleDate(String(args.date ?? ""), context.event.date);
    if (ts == null)
      return {
        ok: false,
        summary: `Couldn't parse date "${args.date}" — use YYYY-MM-DD.`,
        edits: 0,
      };
    const res = await ctx.runMutation(internal.ai.rescheduleEvent, {
      eventId,
      chapterId,
      eventDate: ts,
    });
    if (!res)
      return { ok: false, summary: "Couldn't reschedule the event.", edits: 0 };
    context.event.date = ts;
    const feasibility =
      res.pastDueCount > 0
        ? ` FEASIBILITY WARNING: ${res.pastDueCount} incomplete task(s) now ` +
          `have past due dates (${res.pastDueTitles.slice(0, 5).join("; ")}) ` +
          `— replan, compress, or drop them with the user.`
        : " No incomplete tasks fell into the past.";
    return {
      ok: true,
      summary:
        `Event moved to ${new Date(ts).toISOString()}; ` +
        `${res.shifted} due date(s) re-derived.` +
        feasibility,
      edits: 1,
    };
  }

  if (name === "diff_event_vs_template") {
    // Defensive: a template-sync failure (e.g. the template was deleted) must
    // come back as a tool error the model can react to, not kill the run.
    let diff: any;
    try {
      diff = await ctx.runQuery(api.templateSync.diffEventAgainstTemplate, {
        eventId,
      });
    } catch (err) {
      return {
        ok: false,
        summary: toolErrorSummary(
          err,
          "Couldn't diff against the template — the event may no longer have one.",
        ),
        edits: 0,
      };
    }
    const total =
      diff.items.length + diff.modules.length + diff.columns.length;
    return {
      ok: true,
      summary:
        total === 0
          ? "No structural divergence — the event matches its template."
          : JSON.stringify(diff),
      edits: 0,
    };
  }

  if (name === "promote_to_template") {
    const raw = Array.isArray(args.promotions) ? args.promotions : [];
    if (raw.length === 0)
      return { ok: false, summary: "promotions[] is empty.", edits: 0 };
    const promotions: any[] = [];
    for (const p of raw) {
      const kind = String(p?.kind ?? "");
      if (kind === "add_item" && p.event_item_id) {
        promotions.push({ kind, eventItemId: p.event_item_id });
      } else if (kind === "update_item" && p.event_item_id) {
        promotions.push({
          kind,
          eventItemId: p.event_item_id,
          ...(Array.isArray(p.fields) && p.fields.length
            ? { fields: p.fields.map(String) }
            : {}),
          ...(p.template_item_id ? { templateItemId: p.template_item_id } : {}),
        });
      } else if (kind === "remove_item" && p.template_item_id) {
        promotions.push({ kind, templateItemId: p.template_item_id });
      } else if (kind === "add_module" && p.module_key) {
        promotions.push({ kind, moduleKey: String(p.module_key) });
      } else if (kind === "column" && p.module && p.key) {
        promotions.push({
          kind,
          module: String(p.module),
          key: String(p.key),
        });
      } else {
        return {
          ok: false,
          summary: `Malformed promotion entry: ${JSON.stringify(p)}.`,
          edits: 0,
        };
      }
    }
    // Defensive: a hallucinated/stale id (ArgumentValidationError) or a
    // template-sync ConvexError (NO_TEMPLATE_MATCH, NOT_FOUND) must come back
    // as a tool error the model can react to, not kill the run.
    let res: any;
    try {
      res = await ctx.runMutation(api.templateSync.promoteFromEvent, {
        eventId,
        promotions,
      });
    } catch (err) {
      return {
        ok: false,
        summary: toolErrorSummary(err, BAD_PROMOTION_IDS_MSG),
        edits: 0,
      };
    }
    return {
      ok: true,
      summary:
        `Promoted ${res.applied.length} change(s) to the template ` +
        `(version bumped). Future events created from it inherit them.`,
      edits: 0,
    };
  }

  return { ok: false, summary: `Unknown tool "${name}".` };
}

/**
 * Build the system prompt with a live snapshot of the event the agent edits.
 *
 * Items are grouped BY MODULE (Supplies, Planning Doc, Comms, …), each section
 * headed with that module's key + its allowed option values, then its rows. The
 * old flat, interleaved dump forced the model to mentally de-interleave every
 * module before it could reason about one — which is exactly what made it burn a
 * whole turn "parsing" instead of acting. Grouping lets it reason module by
 * module and see, per section, which items belong there and what values are legal.
 */
function systemPrompt(context: Ctx, now: number): string {
  const roleList =
    context.roles
      .map((r) => `${r.label}${r.person ? ` = ${r.person}` : " = UNASSIGNED"}`)
      .join(", ") || "(none)";
  const peopleList = context.people.map((p) => p.name).join(", ") || "(none)";

  // T-window awareness: where this event sits in the playbook's five windows.
  // Calendar days count in the chapter's PLANNING timezone — the server runs
  // UTC, so naive UTC day math puts an evening event a day late.
  const daysUntil = daysBetweenInTz(now, context.event.date);
  const timing =
    `TODAY: ${dayKeyInTz(now)}. EVENT DATE: ${dayKeyInTz(context.event.date)}. ` +
    `T-WINDOW: ${tWindowLine(daysUntil)}.`;

  // Workstream roster (core + custom), incl. owner roles and ready flags —
  // the setup surface the workstream tools edit.
  const workstreamLines = context.modules
    .map(
      (m) =>
        `- ${m.label} (key=${m.key}) owner_role=${m.ownerRoleKey ?? "NONE"}` +
        ` ready=${m.ready ? "yes" : "no"}`,
    )
    .join("\n");

  const renderItem = (it: Ctx["items"][number]): string =>
    `- [${it.id}] "${it.title}" status=${it.status ?? "-"} role=${it.role ?? "-"}` +
    (it.source ? ` source=${it.source}` : "") +
    (it.container ? ` container=${it.container}` : "") +
    (it.module === "supplies" ? ` packed=${it.packedIn ? "yes" : "no"}` : "") +
    (it.offsetDays != null ? ` offset_days=${it.offsetDays}` : "") +
    (it.cost != null ? ` cost=${it.cost}` : "") +
    (it.hasPhoto ? " photo=yes" : "");

  // Group items by module, then render modules in the canonical display order
  // (core modules first, any custom modules after), so the agent reads a stable,
  // sectioned view instead of an interleaved stream.
  const byModule = new Map<string, Ctx["items"]>();
  for (const it of context.items) {
    (byModule.get(it.module) ?? byModule.set(it.module, []).get(it.module)!).push(
      it,
    );
  }
  const moduleOrder = [
    ...CORE_MODULE_KEYS,
    ...[...byModule.keys()].filter(
      (k) => !(CORE_MODULE_KEYS as readonly string[]).includes(k),
    ),
  ];

  const sections: string[] = [];
  for (const mod of moduleOrder) {
    const rows = byModule.get(mod);
    if (!rows || rows.length === 0) continue;
    const label = (MODULE_LABELS as Record<string, string>)[mod] ?? mod;
    const cols = context.optionsByModule[mod];
    const vocab = cols
      ? Object.entries(cols)
          .map(([col, vals]) => `${col}=${(vals as string[]).join("|")}`)
          .join("  ")
      : "";
    sections.push(
      `## ${label}  (module=${mod}, ${rows.length} item(s))` +
        (vocab ? `\nallowed values → ${vocab}` : "") +
        "\n" +
        rows.map(renderItem).join("\n"),
    );
  }

  return [
    "You are the Chapter OS planning assistant for a church event team. You help",
    "plan and edit one event by calling tools. The north star: any plan must be",
    "runnable by one person alone, with zero tribal knowledge.",
    "",
    "THE PLAYBOOK — your philosophy and operating standards. Every nudge,",
    "proposal, and edit should be traceable to it:",
    "",
    PLAYBOOK_MD,
    "",
    "────────────────────────────────────────",
    "LIVE EVENT SNAPSHOT",
    "",
    timing,
    `EVENT: "${context.event.name}" — status=${context.event.status}` +
      (context.event.location ? `, location=${context.event.location}` : "") +
      (context.event.budget != null ? `, budget=$${context.event.budget}` : "") +
      ".",
    `ROLES (who holds each): ${roleList}.`,
    `PEOPLE (roster): ${peopleList}.`,
    "AREAS (the owned sections of the plan; tool args take the key):",
    workstreamLines || "(none)",
    "",
    "Below, each area with items is its own section with its allowed",
    "option values and its current items. To target an item, use its [id] with",
    "update_item / update_items / remove_item / set_photo. To add a new item,",
    "call add_item with the area KEY (its `module` argument) shown in the",
    "section header.",
    "",
    "CURRENT PLAN, BY AREA:",
    sections.length ? sections.join("\n\n") : "(no items yet)",
    "",
    "Rules:",
    "- VOCABULARY: in everything you SAY to the user, call these surfaces",
    '  "areas", never "modules" or "workstreams" (tool arguments still take',
    "  the module/workstream keys shown above).",
    "- BRIEFING FIRST (playbook Philosophy 11): when a session starts or the",
    "  user asks anything substantive about the plan, call get_readiness and",
    "  open your reply with a short situational briefing — the T-window and the",
    "  one or two things that matter most right now. A briefing, not a firehose.",
    "- Reason area by area. When a request implies items in one",
    "  area should exist or change in another (e.g. a planning task that",
    "  needs a supplies row), ADD or UPDATE those rows so each area is",
    "  fully built out.",
    "- Make every requested change with tool calls. CRITICAL FOR SPEED: when",
    "  changing MULTIPLE items, call update_items ONCE with all edits in its array;",
    "  never call update_item over and over.",
    "- Use the EXACT allowed values shown per area for status/source/",
    "  container, and the role labels / people names listed above. Reference",
    "  items by [id]; never invent ids or values.",
    "- SUPPLIES: status tracks ACQUISITION only and terminates at have_it;",
    "  whether an item is packed is the separate packed=yes/no signal (the",
    "  team's Packing checklist — you can read it, not set it). A supply's",
    "  offset_days is its have-it-by deadline (orders early enough to ship;",
    "  everything in hand by T-1). When an item reaches have_it, its",
    "  source/notes should say where it lives now so pack day isn't a",
    "  scavenger hunt. Buying feeds the Planning ring; packing feeds Day-of.",
    "- FREE HAND (no confirmation needed): adding/editing items, statuses,",
    "  offsets, owners, role assignments, crew engagements, adding roster",
    "  people, setting area owners. All logged; item edits revertible.",
    "- ASK FIRST — only call these when the user explicitly requested that",
    "  action in this conversation: remove_item (deleting anything),",
    "  reschedule_event (a date change is a plan change), toggling an area",
    "  off, marking areas/the event ready or changing event status,",
    "  promote_to_template (edits the template every future event inherits, and",
    "  is not undoable from this run), and anything volunteer- or public-facing.",
    "- DEBRIEF (playbook Window 5): after the event date passes, drive the",
    "  retro — interview the user, fill retro rows, then call",
    "  diff_event_vs_template and propose promotions line-by-line; every retro",
    "  row ends promoted, context, or dropped (its dispatch column).",
    "- To find/add photos online, call find_photos with a short search query per",
    "  item — pass every item in one call.",
    "- When done, reply with a SHORT summary of what changed, tied to the",
    "  T-window where useful. If the request is just a question, answer it",
    "  without calling tools. Be concise.",
  ].join("\n");
}

/**
 * Run one assistant turn on a thread: stream the user message, loop the model +
 * tools (recording reasoning, tool calls, results, and the final reply into the
 * thread), then close out the run. Errors are streamed as an error message and
 * the run is marked errored — the action resolves rather than throwing, so the
 * panel never crashes.
 */
export const runAssistant = action({
  args: {
    threadId: v.id("aiThreads"),
    eventId: v.id("events"),
    userText: v.string(),
  },
  handler: async (
    ctx,
    { threadId, eventId, userText },
  ): Promise<{ ok: boolean; runId?: Id<"aiRuns">; edits?: number }> => {
    const { userId, chapterId } = await ctx.runQuery(internal.ai.myContext, {});

    // Always record the user's message first so it shows immediately.
    await ctx.runMutation(internal.ai.appendMessage, {
      threadId,
      kind: "user",
      text: userText,
    });

    const budget = await ctx.runQuery(api.ai.budgetStatus, {});
    if (budget.over) {
      await ctx.runMutation(internal.ai.appendMessage, {
        threadId,
        kind: "error",
        text: `AI budget reached (${budget.over}).`,
      });
      return { ok: false };
    }
    // Resolve the active AI engine (provider + key + global model). No key for
    // the active provider → degrade with a clear message (was hardcoded to
    // OPENROUTER_API_KEY).
    const config = (await ctx.runQuery(
      internal.integrationSettings.readAiEngineConfig,
      {},
    )) as AiEngineConfig;
    if (!config.apiKey) {
      await ctx.runMutation(internal.ai.appendMessage, {
        threadId,
        kind: "error",
        text: `No API key is configured for the ${config.provider} AI provider.`,
      });
      return { ok: false };
    }

    // TENANT BOUNDARY: eventContext only returns a snapshot when the event is in
    // the caller's chapter (chapterId comes from myContext, never the client).
    // A null result means missing OR cross-chapter — either way we refuse to run
    // the agent loop, so a cross-tenant eventId can't drive the LLM.
    const context = (await ctx.runQuery(internal.ai.eventContext, {
      eventId,
      chapterId,
    })) as EventCtx | null;
    if (!context) {
      await ctx.runMutation(internal.ai.appendMessage, {
        threadId,
        kind: "error",
        text: "Event not found.",
      });
      return { ok: false };
    }

    // Per-chat model + spend cap. The chat runs on its own model (any free model
    // for anyone; a paid model a superuser set) or the deployment default, and a
    // superuser can cap this chat's total spend. Refuse a chat already at its cap.
    const chat = await ctx.runQuery(internal.ai.threadRunContext, {
      threadId,
      chapterId,
    });
    if (chat && isOverChatBudget(chat.spentUsd, chat.spendLimitUsd)) {
      await ctx.runMutation(internal.ai.appendMessage, {
        threadId,
        kind: "error",
        text: `This chat's spend limit ($${chat.spendLimitUsd?.toFixed(2)}) is reached.`,
      });
      return { ok: false };
    }
    // Model precedence: per-thread choice (the explicit per-call override) >
    // stored global `aiModel` > per-provider default.
    const slug = resolveEngineModel(config, {
      override: chat?.model,
      openrouterDefault: DEFAULT_AI_MODEL,
      ollamaDefault: OLLAMA_DEFAULT_CHAT_MODEL,
    });
    const spendLimitUsd = chat?.spendLimitUsd ?? null;
    let chatSpent = chat?.spentUsd ?? 0;

    // Conversation context = system (live snapshot) + prior user/assistant turns.
    const history = await ctx.runQuery(api.ai.listMessages, { threadId });
    const priorTurns = history
      .filter((m: any) => m.kind === "user" || m.kind === "assistant")
      .map((m: any) => ({
        role: m.kind === "user" ? ("user" as const) : ("assistant" as const),
        content: m.text ?? "",
      }));
    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt(context, Date.now()) },
      ...priorTurns,
    ];

    const runId = await ctx.runMutation(internal.ai.startRun, {
      chapterId,
      userId,
      feature: "assistant",
      eventId,
      threadId,
      model: slug,
    });

    let edits = 0;
    let totalCost = 0;
    let finished = false;

    try {
      for (let step = 0; step < MAX_STEPS; step++) {
        const {
          message,
          usage,
          slug: usedSlug,
        } = await resilientCall(config, slug, messages, { tools: TOOLS });

        const cost = callCost(usedSlug, usage);
        totalCost += cost;
        chatSpent += cost;
        await ctx.runMutation(internal.ai.logUsage, {
          chapterId,
          userId,
          runId,
          threadId,
          feature: "assistant",
          model: usedSlug,
          inputTokens: usage.prompt_tokens ?? 0,
          outputTokens: usage.completion_tokens ?? 0,
          cachedTokens: usage.prompt_tokens_details?.cached_tokens,
          costUsd: cost,
        });

        // Surface the reasoning trace, if the model returned one.
        const reasoning =
          (typeof message.reasoning === "string" && message.reasoning) || "";
        if (reasoning.trim()) {
          await ctx.runMutation(internal.ai.appendMessage, {
            threadId,
            runId,
            kind: "reasoning",
            text: reasoning.trim(),
          });
        }

        const toolCalls: ToolCall[] = message.tool_calls ?? [];
        if (toolCalls.length === 0) {
          // Final answer.
          const text =
            (typeof message.content === "string" && message.content.trim()) ||
            "Done.";
          await ctx.runMutation(internal.ai.appendMessage, {
            threadId,
            runId,
            kind: "assistant",
            text,
          });
          finished = true;
          break;
        }

        // Record the assistant turn (with tool_calls) for the next round.
        messages.push(message as ChatMessage);

        for (const tc of toolCalls) {
          const parsed = parseToolArgs(tc);
          if (parsed === null) {
            // Malformed tool-arg JSON: surface it instead of silently no-op'ing.
            const summary = "Couldn't parse the tool arguments (invalid JSON).";
            await ctx.runMutation(internal.ai.appendMessage, {
              threadId,
              runId,
              kind: "tool_result",
              toolName: tc.function?.name,
              toolOk: false,
              text: summary,
            });
            messages.push({
              role: "tool",
              tool_call_id: tc.id,
              content: JSON.stringify({ ok: false, summary }),
            });
            continue;
          }
          await ctx.runMutation(internal.ai.appendMessage, {
            threadId,
            runId,
            kind: "tool_call",
            toolName: tc.function?.name,
            toolArgs: parsed,
          });

          const result = await dispatchTool(
            ctx,
            runId,
            eventId,
            chapterId,
            context,
            tc.function?.name ?? "",
            parsed,
          );
          edits += result.edits ?? (result.ok ? 1 : 0);
          await ctx.runMutation(internal.ai.appendMessage, {
            threadId,
            runId,
            kind: "tool_result",
            toolName: tc.function?.name,
            toolOk: result.ok,
            text: result.summary,
          });
          messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: JSON.stringify(result),
          });
        }

        // Per-chat spend cap: if this chat has now spent its budget, stop before
        // spending on another round. (Only bites once a paid model is in play.)
        if (isOverChatBudget(chatSpent, spendLimitUsd)) {
          await ctx.runMutation(internal.ai.appendMessage, {
            threadId,
            runId,
            kind: "assistant",
            text: `Made ${edits} edit(s), then stopped — this chat hit its spend limit ($${spendLimitUsd?.toFixed(2)}).`,
          });
          finished = true;
          break;
        }
      }

      // Step cap hit mid-work → still leave a closing summary in the thread.
      if (!finished) {
        await ctx.runMutation(internal.ai.appendMessage, {
          threadId,
          runId,
          kind: "assistant",
          text: `Made ${edits} edit(s). Ask me to continue if there's more.`,
        });
      }

      await ctx.runMutation(internal.ai.finishRun, {
        runId,
        status: "done",
        itemsTouched: edits,
        costUsd: totalCost,
        summary: `${edits} edit(s)`,
      });
      return { ok: true, runId, edits };
    } catch (err) {
      const message =
        err instanceof ConvexError
          ? ((err.data as any)?.message ?? "Agent error.")
          : "Agent error.";
      await ctx.runMutation(internal.ai.appendMessage, {
        threadId,
        runId,
        kind: "error",
        text: message,
      });
      await ctx.runMutation(internal.ai.finishRun, {
        runId,
        status: "error",
        itemsTouched: edits,
        costUsd: totalCost,
        summary: `Errored after ${edits} edit(s)`,
      });
      return { ok: false };
    }
  },
});

/**
 * One-click per-row enrichment (the grid's ✨ Autofill button). From just the
 * item's name it fills, where the module has the column and it's still empty:
 *   - photo — best web-image match (DuckDuckGo → Openverse), fetched + stored
 *   - cost  — a typical US retail price estimate from the free model
 *   - link  — a Google Shopping search link for the item
 * Every change is logged to the run, so it's revertible from the assistant panel.
 */
export const autofillItem = action({
  args: { itemId: v.id("eventItems") },
  handler: async (
    ctx,
    { itemId },
  ): Promise<{ ok: boolean; filled: string[] }> => {
    const { userId, chapterId } = await ctx.runQuery(internal.ai.myContext, {});

    const budget = await ctx.runQuery(api.ai.budgetStatus, {});
    if (budget.over)
      throw new ConvexError({
        code: "AI_BUDGET",
        message: `AI budget reached (${budget.over}).`,
      });
    const engineConfig = (await ctx.runQuery(
      internal.integrationSettings.readAiEngineConfig,
      {},
    )) as AiEngineConfig;
    if (!engineConfig.apiKey)
      throw new ConvexError({
        code: "NO_AI_KEY",
        message: `No API key is configured for the ${engineConfig.provider} AI provider.`,
      });

    // TENANT BOUNDARY: itemForAutofill only returns when the item is in the
    // caller's chapter (chapterId from myContext, never the client). A null
    // result means missing OR cross-chapter — we refuse before any LLM/storage
    // work, so a cross-tenant itemId can't be read or enriched.
    const info = await ctx.runQuery(internal.ai.itemForAutofill, {
      itemId,
      chapterId,
    });
    if (!info)
      throw new ConvexError({ code: "NOT_FOUND", message: "Item not found." });

    const cfg = await ctx.runQuery(api.ai.aiConfig, {});
    // Model precedence: stored global `aiModel` > the deployment's active model
    // (OpenRouter) / Ollama's soft default.
    const slug = resolveEngineModel(engineConfig, {
      openrouterDefault: cfg.activeModel,
      ollamaDefault: OLLAMA_DEFAULT_CHAT_MODEL,
    });
    const has = (k: string) => info.columnKeys.includes(k);

    const runId = await ctx.runMutation(internal.ai.startRun, {
      chapterId,
      userId,
      feature: "autofill_item",
      eventId: info.eventId,
      model: slug,
    });

    const filled: string[] = [];
    let cost = 0;

    try {
      // Photo — exact-product web image.
      if (has("photo") && !info.fields.photo) {
        const urls = await searchImageUrls(info.title);
        for (const u of urls.slice(0, 4)) {
          const blob = await fetchImageBlob(u);
          if (blob) {
            const storageId = await ctx.storage.store(blob);
            await ctx.runMutation(internal.ai.setItemPhoto, {
              runId,
              itemId,
              chapterId,
              storageId,
            });
            filled.push("photo");
            break;
          }
        }
      }

      const fields: Record<string, any> = {};

      // Cost — typical retail price estimate from the model.
      if (has("cost") && info.fields.cost == null) {
        const { message, usage } = await engineCall(
          engineConfig,
          slug,
          [
            {
              role: "system",
              content:
                "You estimate typical US retail prices for event supplies and " +
                "services. Reply with ONLY a whole number of US dollars (no " +
                "symbols, no text). If the item isn't a purchasable thing, reply 0.",
            },
            { role: "user", content: info.title },
          ],
          // A one-shot price guess — low effort keeps this cheap and fast
          // (the assistant chat is where high reasoning matters, not here).
          { maxTokens: 16, effort: "low" },
        );
        cost += callCost(slug, usage);
        const n = parseFloat(String(message.content ?? "").replace(/[^0-9.]/g, ""));
        if (!Number.isNaN(n) && n > 0) fields.cost = Math.round(n);
      }

      // Link — a shopping search for the item (deterministic, never 404s).
      if (has("link") && !info.fields.link) {
        fields.link =
          "https://www.google.com/search?tbm=shop&q=" +
          encodeURIComponent(info.title);
      }

      if (Object.keys(fields).length) {
        await ctx.runMutation(internal.ai.applyItemPatch, {
          runId,
          itemId,
          chapterId,
          fields,
        });
        filled.push(...Object.keys(fields));
      }

      await ctx.runMutation(internal.ai.logUsage, {
        chapterId,
        userId,
        runId,
        feature: "autofill_item",
        model: slug,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: cost,
      });
      await ctx.runMutation(internal.ai.finishRun, {
        runId,
        status: "done",
        itemsTouched: filled.length,
        costUsd: cost,
        summary: `Autofilled ${filled.join(", ") || "nothing"}`,
      });
      return { ok: filled.length > 0, filled };
    } catch (err) {
      await ctx.runMutation(internal.ai.finishRun, {
        runId,
        status: "error",
        itemsTouched: filled.length,
        costUsd: cost,
        summary: "Autofill errored",
      });
      throw err;
    }
  },
});

/** The most recent thread turns, as plain chat messages for model context. */
function docHistoryTurns(
  history: Array<{ kind: string; text?: string | null }>,
): Array<{ role: "user" | "assistant"; content: string }> {
  return history
    .filter((m) => m.kind === "user" || m.kind === "assistant")
    .map((m) => ({
      role: m.kind === "user" ? ("user" as const) : ("assistant" as const),
      content: m.text ?? "",
    }));
}

/** Max model round-trips in one doc-assistant turn (research + write). */
const DOC_MAX_STEPS = 6;

/**
 * Token headroom for the doc writer. `write_doc` replaces the ENTIRE guide, so
 * its argument can be a long markdown body — and now that the writer runs HIGH
 * reasoning, the thinking trace shares this budget with that body. Generous so a
 * full-guide rewrite isn't truncated mid-document.
 */
const DOC_MAX_TOKENS = 6000;

/** The tools the doc assistant can call — research, then write the markdown. */
const DOC_TOOLS = [
  {
    type: "function",
    function: {
      name: "search_how_to_docs",
      description:
        "Search existing How-To guides written for OTHER templates and events " +
        "in this same community. Use this FIRST to reuse phrasing, steps, and " +
        "conventions the team already relies on. Pass a short query of key " +
        "terms describing the task.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Key terms for the task (e.g. 'sound check soundboard').",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description:
        "Search the public web for factual context, definitions, or best " +
        "practices to make the guide accurate and complete. Pass a short query.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "A short web search query." },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_doc",
      description:
        "Save the document. Pass the FULL revised guide in GitHub-Flavored " +
        "Markdown — it REPLACES the entire document, so include ALL content, " +
        "not just the part you changed. Do NOT wrap it in code fences. Call " +
        "this once you've gathered enough context and are ready to commit the " +
        "guide.",
      parameters: {
        type: "object",
        properties: {
          body: { type: "string", description: "The full markdown document." },
        },
        required: ["body"],
        additionalProperties: false,
      },
    },
  },
];

/** Compact text rendering of search_how_to_docs matches for the tool_result. */
function renderHowToMatches(
  matches: Array<{ title: string; body: string }>,
): string {
  if (!matches.length) return "No matching how-to guides found.";
  return matches
    .map((m) => {
      const body = m.body.length > 800 ? m.body.slice(0, 800) + "…" : m.body;
      return `## ${m.title}\n${body}`;
    })
    .join("\n\n");
}

/** Compact text rendering of web_search results for the tool_result. */
function renderWebResults(
  results: Array<{ title: string; snippet: string; url?: string }>,
): string {
  if (!results.length) return "No web results found.";
  return results
    .map(
      (r) =>
        `${r.title} — ${r.snippet}${r.url ? ` — ${r.url}` : ""}`,
    )
    .join("\n");
}

/**
 * Tool-using How-To author agent — one chat turn on a doc's thread.
 *
 * The doc-page counterpart to `runAssistant`: a multi-step tool loop on a FREE
 * OpenRouter model. The agent gathers context (`search_how_to_docs` reuses
 * guides from other templates/events; `web_search` pulls factual background),
 * then commits the FULL revised markdown via `write_doc` (→ `internal.docs.setBody`),
 * then gives the user a short final reply. Every step (user message, reasoning,
 * each tool call + result, final reply, errors) streams into `aiMessages`, so
 * the panel renders the agent's work live. The standard "explain it to a
 * no-context volunteer" voice (`HOW_TO_SYSTEM_PROMPT`) is the base of its
 * system prompt. Same budget gate + run/usage tracking as `runAssistant`.
 *
 * COW: writes to whatever `docId` it's given — the panel passes the forked copy.
 */
export const runDocAssistant = action({
  args: {
    threadId: v.id("aiThreads"),
    docId: v.id("docs"),
    userText: v.string(),
  },
  handler: async (
    ctx,
    { threadId, docId, userText },
  ): Promise<{ ok: boolean; runId?: Id<"aiRuns">; edited?: boolean }> => {
    const { userId, chapterId } = await ctx.runQuery(internal.ai.myContext, {});

    // Always record the user's message first so it shows immediately.
    await ctx.runMutation(internal.ai.appendMessage, {
      threadId,
      kind: "user",
      text: userText,
    });

    const budget = await ctx.runQuery(api.ai.budgetStatus, {});
    if (budget.over) {
      await ctx.runMutation(internal.ai.appendMessage, {
        threadId,
        kind: "error",
        text: `AI budget reached (${budget.over}).`,
      });
      return { ok: false };
    }
    const config = (await ctx.runQuery(
      internal.integrationSettings.readAiEngineConfig,
      {},
    )) as AiEngineConfig;
    if (!config.apiKey) {
      await ctx.runMutation(internal.ai.appendMessage, {
        threadId,
        kind: "error",
        text: `No API key is configured for the ${config.provider} AI provider.`,
      });
      return { ok: false };
    }

    // TENANT BOUNDARY: docs.forAi runs in the caller's auth context and returns
    // null unless the doc is in the caller's chapter (it does requireChapterId +
    // a chapterId equality check). So a null result means missing OR
    // cross-chapter — we refuse to run the agent loop, and write_doc below only
    // ever targets this same verified docId. A cross-tenant docId can't be
    // read or overwritten through this action.
    const doc = await ctx.runQuery(api.docs.forAi, { docId });
    if (!doc) {
      await ctx.runMutation(internal.ai.appendMessage, {
        threadId,
        kind: "error",
        text: "Doc not found.",
      });
      return { ok: false };
    }

    // PLATFORM GUIDE (slug set) → read-only. Refuse BEFORE the model loop:
    // docs.setBody would reject the write anyway, but only after tokens were
    // spent — and the throw would error the whole run. A friendly reply, not
    // an error. (ensureDocThread/newDocThread also refuse; this is the
    // belt-and-braces for pre-existing threads.)
    if (doc.slug != null) {
      await ctx.runMutation(internal.ai.appendMessage, {
        threadId,
        kind: "assistant",
        text:
          "This is a platform guide — it updates automatically with the " +
          "platform and is read-only, so I can't edit it. Put chapter " +
          "specifics in your own templates and how-to docs instead.",
      });
      return { ok: false };
    }

    // Per-chat model + spend cap (same as the event assistant): this doc chat
    // runs on its own model or the deployment default, and a superuser cap stops
    // it once spent.
    const chat = await ctx.runQuery(internal.ai.threadRunContext, {
      threadId,
      chapterId,
    });
    if (chat && isOverChatBudget(chat.spentUsd, chat.spendLimitUsd)) {
      await ctx.runMutation(internal.ai.appendMessage, {
        threadId,
        kind: "error",
        text: `This chat's spend limit ($${chat.spendLimitUsd?.toFixed(2)}) is reached.`,
      });
      return { ok: false };
    }
    const slug = resolveEngineModel(config, {
      override: chat?.model,
      openrouterDefault: DEFAULT_AI_MODEL,
      ollamaDefault: OLLAMA_DEFAULT_CHAT_MODEL,
    });

    const history = await ctx.runQuery(api.ai.listMessages, { threadId });
    const priorTurns = docHistoryTurns(history);

    const system = [
      HOW_TO_SYSTEM_PROMPT,
      "",
      "You are editing ONE markdown How-To document for a church events team by",
      "calling tools. Workflow:",
      "1. If it helps, gather context FIRST — call `search_how_to_docs` to reuse",
      "   guides the team already wrote for other templates/events, and/or",
      "   `web_search` for factual background. Skip research only for trivial",
      "   edits or pure questions.",
      "2. When you're ready to change the document, call `write_doc` with the",
      "   FULL revised guide in GitHub-Flavored Markdown — it REPLACES the whole",
      "   document, so include ALL content, not just the edited part.",
      "3. After your edits (or if the user only asked a question), reply with a",
      "   SHORT, friendly final message — no tool call — and the turn ends.",
      "",
      "If the user only asked a question, answer it directly without calling",
      "`write_doc`. Be concise in your final reply; the detail goes in the guide.",
      "",
      `DOCUMENT TITLE: "${doc.title}".`,
      "CURRENT DOCUMENT:",
      doc.body && doc.body.trim() ? doc.body : "(empty)",
    ].join("\n");

    const messages: ChatMessage[] = [
      { role: "system", content: system },
      ...priorTurns,
    ];

    const runId = await ctx.runMutation(internal.ai.startRun, {
      chapterId,
      userId,
      feature: "doc_assistant",
      threadId,
      model: slug,
    });

    let edited = false;
    let totalCost = 0;
    let finished = false;

    try {
      for (let step = 0; step < DOC_MAX_STEPS; step++) {
        const {
          message,
          usage,
          slug: usedSlug,
        } = await resilientCall(config, slug, messages, {
          tools: DOC_TOOLS,
          maxTokens: DOC_MAX_TOKENS,
        });

        const cost = callCost(usedSlug, usage);
        totalCost += cost;
        await ctx.runMutation(internal.ai.logUsage, {
          chapterId,
          userId,
          runId,
          threadId,
          feature: "doc_assistant",
          model: usedSlug,
          inputTokens: usage.prompt_tokens ?? 0,
          outputTokens: usage.completion_tokens ?? 0,
          cachedTokens: usage.prompt_tokens_details?.cached_tokens,
          costUsd: cost,
        });

        // Surface the reasoning trace, if the model returned one.
        const reasoning =
          (typeof message.reasoning === "string" && message.reasoning) || "";
        if (reasoning.trim()) {
          await ctx.runMutation(internal.ai.appendMessage, {
            threadId,
            runId,
            kind: "reasoning",
            text: reasoning.trim(),
          });
        }

        const toolCalls: ToolCall[] = message.tool_calls ?? [];
        if (toolCalls.length === 0) {
          // Final answer.
          const text =
            (typeof message.content === "string" && message.content.trim()) ||
            "Done.";
          await ctx.runMutation(internal.ai.appendMessage, {
            threadId,
            runId,
            kind: "assistant",
            text,
          });
          finished = true;
          break;
        }

        // Record the assistant turn (with tool_calls) for the next round.
        messages.push(message as ChatMessage);

        for (const tc of toolCalls) {
          const name = tc.function?.name;
          const parsed = parseToolArgs(tc);
          if (parsed === null) {
            // Malformed tool-arg JSON: surface it instead of silently no-op'ing.
            const failSummary =
              "Couldn't parse the tool arguments (invalid JSON).";
            await ctx.runMutation(internal.ai.appendMessage, {
              threadId,
              runId,
              kind: "tool_result",
              toolName: name,
              toolOk: false,
              text: failSummary,
            });
            messages.push({
              role: "tool",
              tool_call_id: tc.id,
              content: failSummary,
            });
            continue;
          }
          await ctx.runMutation(internal.ai.appendMessage, {
            threadId,
            runId,
            kind: "tool_call",
            toolName: name,
            toolArgs: parsed,
          });

          let ok = true;
          let summary = "";
          if (name === "search_how_to_docs") {
            const matches = (await ctx.runQuery(api.docs.searchForAi, {
              query: String(parsed.query ?? ""),
            })) as Array<{ title: string; body: string }>;
            ok = matches.length > 0;
            summary = renderHowToMatches(matches);
          } else if (name === "web_search") {
            const results = await webSearch(String(parsed.query ?? ""));
            ok = results.length > 0;
            summary = renderWebResults(results);
          } else if (name === "write_doc") {
            const body =
              typeof parsed.body === "string" ? parsed.body : "";
            if (!body.trim()) {
              ok = false;
              summary = "No document body provided.";
            } else {
              await ctx.runMutation(internal.docs.setBody, {
                docId,
                body,
                expectedChapterId: chapterId,
              });
              edited = true;
              ok = true;
              summary = "Document updated.";
            }
          } else {
            ok = false;
            summary = `Unknown tool "${name}".`;
          }

          await ctx.runMutation(internal.ai.appendMessage, {
            threadId,
            runId,
            kind: "tool_result",
            toolName: name,
            toolOk: ok,
            text: summary.length > 1200 ? summary.slice(0, 1200) + "…" : summary,
          });
          messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: summary,
          });
        }
      }

      // Step cap hit mid-work → still leave a closing summary in the thread.
      if (!finished) {
        await ctx.runMutation(internal.ai.appendMessage, {
          threadId,
          runId,
          kind: "assistant",
          text: edited
            ? "Updated the guide. Ask me to continue if there's more."
            : "Still working — ask me to continue.",
        });
      }

      await ctx.runMutation(internal.ai.finishRun, {
        runId,
        status: "done",
        itemsTouched: edited ? 1 : 0,
        costUsd: totalCost,
        summary: edited ? "Edited doc" : "Replied",
      });
      return { ok: true, runId, edited };
    } catch (err) {
      const text =
        err instanceof ConvexError
          ? ((err.data as any)?.message ?? "Agent error.")
          : "Agent error.";
      await ctx.runMutation(internal.ai.appendMessage, {
        threadId,
        runId,
        kind: "error",
        text,
      });
      await ctx.runMutation(internal.ai.finishRun, {
        runId,
        status: "error",
        itemsTouched: edited ? 1 : 0,
        costUsd: totalCost,
        summary: "Doc assistant errored",
      });
      return { ok: false };
    }
  },
});

// ── Inventory assistant (chapter-scoped gear registry agent) ─────────────────
/**
 * The tools the inventory agent can call — all chapter-scoped to the `assets`
 * registry, all revertible. No event/reservation editing: the agent keeps the
 * chapter's owned gear list accurate; reservations are an event-side concern.
 */
const INVENTORY_TOOLS = [
  {
    type: "function",
    function: {
      name: "list_assets",
      description:
        "READ the chapter's full inventory: every asset with its id, name, " +
        "tags, quantity, consumable flag, condition, acquired flag, and live " +
        "reservation load (reserved / available / overbooked). The current " +
        "inventory is already in your system prompt; call this only to re-check " +
        "state after edits.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_asset",
      description:
        "Add a NEW asset to the chapter inventory. name is required. tags is a " +
        "list of short labels (e.g. 'audio', 'cables'); quantity is how many " +
        "the chapter owns (default 0); consumable marks stock that gets used up " +
        "(batteries, gaffer tape) rather than durable gear.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          quantity: { type: "number" },
          consumable: { type: "boolean" },
        },
        required: ["name"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_asset",
      description:
        "Edit fields of ONE existing asset by asset_id. Pass ONLY the fields to " +
        "change. condition is one of ok|needs_attention|broken. acquired marks " +
        "whether the chapter physically has it yet. To change tags you may pass " +
        "tags here or use set_asset_tags. Pass note: null to clear the note.",
      parameters: {
        type: "object",
        properties: {
          asset_id: { type: "string" },
          name: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          quantity: { type: "number" },
          consumable: { type: "boolean" },
          condition: {
            type: "string",
            enum: ["ok", "needs_attention", "broken"],
          },
          acquired: { type: "boolean" },
          note: { type: ["string", "null"] },
        },
        required: ["asset_id"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_asset_tags",
      description:
        "Replace an asset's tags with a new list (the whole set, not a delta).",
      parameters: {
        type: "object",
        properties: {
          asset_id: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
        },
        required: ["asset_id", "tags"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "remove_asset",
      description:
        "DELETE an asset by id. Destructive — only call when the user " +
        "explicitly asked for a deletion in this conversation. Revertible from " +
        "the run's Undo.",
      parameters: {
        type: "object",
        properties: { asset_id: { type: "string" } },
        required: ["asset_id"],
        additionalProperties: false,
      },
    },
  },
];

/** One asset in the inventory agent's working snapshot (from `listAssets`). */
interface InventoryAsset {
  id: Id<"assets">;
  name: string;
  tags: string[];
  quantity: number;
  consumable: boolean;
  condition: string | null;
  acquired: boolean;
  note: string | null;
  reservedLive: number;
  available: number;
  overbooked: boolean;
  lowStock: boolean;
  outOfStock: boolean;
}
interface InventoryCtx {
  assets: InventoryAsset[];
}

/** Run one inventory tool call; apply the edit(s) (revertibly) + return a short
 * result. The asset-registry sibling of `dispatchTool`. Exported for tests. */
export async function dispatchInventoryTool(
  ctx: any,
  runId: Id<"aiRuns">,
  chapterId: Id<"chapters">,
  userId: Id<"users">,
  context: InventoryCtx,
  name: string,
  args: any,
): Promise<{ ok: boolean; summary: string; edits?: number }> {
  const findAsset = (id: unknown): InventoryAsset | undefined =>
    context.assets.find((a) => String(a.id) === String(id));

  if (name === "list_assets") {
    return { ok: true, summary: JSON.stringify(context.assets), edits: 0 };
  }

  if (name === "add_asset") {
    const nm = String(args.name ?? "").trim();
    if (!nm) return { ok: false, summary: "An asset needs a name.", edits: 0 };
    const tags = Array.isArray(args.tags) ? args.tags.map(String) : undefined;
    let quantity: number | undefined;
    if (args.quantity !== undefined) {
      if (
        typeof args.quantity !== "number" ||
        args.quantity < 0 ||
        !Number.isInteger(args.quantity)
      )
        return {
          ok: false,
          summary: "quantity must be a whole number (zero or more).",
          edits: 0,
        };
      quantity = args.quantity;
    }
    const consumable =
      typeof args.consumable === "boolean" ? args.consumable : undefined;
    const assetId = await ctx.runMutation(internal.ai.createAssetFromAgent, {
      runId,
      chapterId,
      userId,
      name: nm,
      tags,
      quantity,
      consumable,
    });
    // Keep the turn's snapshot current so follow-up tools resolve the new id.
    context.assets.push({
      id: assetId,
      name: nm,
      tags: tags ?? [],
      quantity: quantity ?? 0,
      consumable: consumable ?? false,
      condition: null,
      acquired: true,
      note: null,
      reservedLive: 0,
      available: quantity ?? 0,
      overbooked: false,
      lowStock: false,
      outOfStock: false,
    });
    return { ok: true, summary: `Added "${nm}".`, edits: 1 };
  }

  if (name === "update_asset") {
    const asset = findAsset(args.asset_id);
    if (!asset)
      return { ok: false, summary: `No asset with id ${args.asset_id}.`, edits: 0 };
    const patch: Record<string, any> = {};
    if (args.name !== undefined) {
      const nm = String(args.name).trim();
      if (!nm) return { ok: false, summary: "An asset needs a name.", edits: 0 };
      patch.name = nm;
    }
    if (args.tags !== undefined)
      patch.tags = Array.isArray(args.tags) ? args.tags.map(String) : [];
    if (args.quantity !== undefined) {
      if (
        typeof args.quantity !== "number" ||
        args.quantity < 0 ||
        !Number.isInteger(args.quantity)
      )
        return {
          ok: false,
          summary: "quantity must be a whole number (zero or more).",
          edits: 0,
        };
      patch.quantity = args.quantity;
    }
    if (args.consumable !== undefined) patch.consumable = args.consumable === true;
    if (args.acquired !== undefined) patch.acquired = args.acquired === true;
    if (args.condition !== undefined) {
      const c = String(args.condition);
      if (!(ASSET_CONDITIONS as readonly string[]).includes(c))
        return {
          ok: false,
          summary: `"${c}" isn't a valid condition — options: ${ASSET_CONDITIONS.join(", ")}.`,
          edits: 0,
        };
      patch.condition = c;
    }
    // note: explicit null CLEARS it (applyAssetPatch maps null → undefined).
    if (args.note !== undefined)
      patch.note = args.note === null ? null : String(args.note);
    if (Object.keys(patch).length === 0)
      return { ok: false, summary: "No asset fields to change.", edits: 0 };
    await ctx.runMutation(internal.ai.applyAssetPatch, {
      runId,
      assetId: asset.id,
      chapterId,
      patch,
    });
    // Keep the snapshot current for follow-up tools this turn.
    if (patch.name !== undefined) asset.name = patch.name;
    if (patch.tags !== undefined) asset.tags = patch.tags;
    if (patch.quantity !== undefined) {
      asset.quantity = patch.quantity;
      asset.available = Math.max(0, patch.quantity - asset.reservedLive);
      asset.overbooked = asset.reservedLive > patch.quantity;
    }
    if (patch.consumable !== undefined) asset.consumable = patch.consumable;
    if (patch.acquired !== undefined) asset.acquired = patch.acquired;
    if (patch.condition !== undefined) asset.condition = patch.condition;
    if (patch.note !== undefined) asset.note = patch.note ?? null;
    return { ok: true, summary: `Updated "${asset.name}".`, edits: 1 };
  }

  if (name === "set_asset_tags") {
    const asset = findAsset(args.asset_id);
    if (!asset)
      return { ok: false, summary: `No asset with id ${args.asset_id}.`, edits: 0 };
    const tags = Array.isArray(args.tags) ? args.tags.map(String) : [];
    await ctx.runMutation(internal.ai.applyAssetPatch, {
      runId,
      assetId: asset.id,
      chapterId,
      patch: { tags },
    });
    asset.tags = tags;
    return { ok: true, summary: `Set tags on "${asset.name}".`, edits: 1 };
  }

  if (name === "remove_asset") {
    const idx = context.assets.findIndex(
      (a) => String(a.id) === String(args.asset_id),
    );
    if (idx < 0)
      return { ok: false, summary: `No asset with id ${args.asset_id}.`, edits: 0 };
    const nm = context.assets[idx].name;
    await ctx.runMutation(internal.ai.removeAssetFromAgent, {
      runId,
      assetId: context.assets[idx].id,
      chapterId,
    });
    context.assets.splice(idx, 1);
    return { ok: true, summary: `Deleted "${nm}".`, edits: 1 };
  }

  return { ok: false, summary: `Unknown tool "${name}".` };
}

/** Build the inventory agent's system prompt with a live snapshot of the assets. */
function inventorySystemPrompt(context: InventoryCtx): string {
  const lines = context.assets.map(
    (a) =>
      `- [${a.id}] "${a.name}" qty=${a.quantity} acquired=${a.acquired ? "yes" : "no"}` +
      (a.consumable ? " consumable=yes" : "") +
      (a.condition ? ` condition=${a.condition}` : "") +
      ` reserved=${a.reservedLive} available=${a.available}` +
      (a.overbooked ? " OVERBOOKED" : "") +
      (a.tags.length ? ` tags=[${a.tags.join(", ")}]` : "") +
      (a.note ? ` note=${JSON.stringify(a.note)}` : ""),
  );
  return [
    "You are the Inventory assistant for a church events team's shared gear",
    "registry. You keep the chapter's INVENTORY accurate by calling tools. Assets",
    "are chapter-owned durable gear (speakers, tables, cables) or consumable stock",
    "(batteries, gaffer tape). Each asset has a quantity the chapter owns; events",
    "RESERVE assets, so `reserved`/`available` show the live load across events —",
    "you edit the registry itself, never the reservations.",
    "",
    "Rules:",
    "- Make every requested change with tool calls. Target an asset by its [id];",
    "  never invent ids or values.",
    "- add_asset for new gear; update_asset to change name / quantity / condition",
    "  / acquired / consumable / note; set_asset_tags to re-tag; remove_asset to",
    "  delete.",
    "- condition is one of ok|needs_attention|broken.",
    "- FREE HAND (no confirmation needed): adding assets, editing fields, tagging.",
    "  Everything is logged and revertible.",
    "- ASK FIRST — only when the user explicitly asked in this conversation:",
    "  remove_asset (deleting gear).",
    "- When done, reply with a SHORT summary of what changed. If the request is",
    "  just a question, answer it without calling tools. Be concise.",
    "",
    "CURRENT INVENTORY:",
    lines.length ? lines.join("\n") : "(no assets yet)",
  ].join("\n");
}

/**
 * Run one inventory-assistant turn on a chapter's inventory thread. The
 * chapter-scoped sibling of `runAssistant`: same budget / per-chat spend gates,
 * same resilient model loop, same live streaming into `aiMessages` and
 * revertible `aiChanges` — but it edits the chapter's `assets` registry (no
 * event context). Errors are streamed and the run marked errored; the action
 * resolves rather than throwing so the panel never crashes.
 */
export const runInventoryAssistant = action({
  args: {
    threadId: v.id("aiThreads"),
    userText: v.string(),
  },
  handler: async (
    ctx,
    { threadId, userText },
  ): Promise<{ ok: boolean; runId?: Id<"aiRuns">; edits?: number }> => {
    const { userId, chapterId } = await ctx.runQuery(internal.ai.myContext, {});

    // Always record the user's message first so it shows immediately.
    await ctx.runMutation(internal.ai.appendMessage, {
      threadId,
      kind: "user",
      text: userText,
    });

    const budget = await ctx.runQuery(api.ai.budgetStatus, {});
    if (budget.over) {
      await ctx.runMutation(internal.ai.appendMessage, {
        threadId,
        kind: "error",
        text: `AI budget reached (${budget.over}).`,
      });
      return { ok: false };
    }
    const config = (await ctx.runQuery(
      internal.integrationSettings.readAiEngineConfig,
      {},
    )) as AiEngineConfig;
    if (!config.apiKey) {
      await ctx.runMutation(internal.ai.appendMessage, {
        threadId,
        kind: "error",
        text: `No API key is configured for the ${config.provider} AI provider.`,
      });
      return { ok: false };
    }

    // TENANT BOUNDARY: threadRunContext returns null unless the thread is in the
    // caller's chapter (chapterId from myContext, never the client). A null
    // result means missing OR cross-chapter — refuse to run so a cross-tenant
    // threadId can't drive the LLM. It also carries the per-chat model + spend.
    const chat = await ctx.runQuery(internal.ai.threadRunContext, {
      threadId,
      chapterId,
    });
    if (!chat) {
      await ctx.runMutation(internal.ai.appendMessage, {
        threadId,
        kind: "error",
        text: "Chat not found.",
      });
      return { ok: false };
    }
    if (isOverChatBudget(chat.spentUsd, chat.spendLimitUsd)) {
      await ctx.runMutation(internal.ai.appendMessage, {
        threadId,
        kind: "error",
        text: `This chat's spend limit ($${chat.spendLimitUsd?.toFixed(2)}) is reached.`,
      });
      return { ok: false };
    }
    const slug = resolveEngineModel(config, {
      override: chat.model,
      openrouterDefault: DEFAULT_AI_MODEL,
      ollamaDefault: OLLAMA_DEFAULT_CHAT_MODEL,
    });
    const spendLimitUsd = chat.spendLimitUsd ?? null;
    let chatSpent = chat.spentUsd ?? 0;

    // Live inventory snapshot for the caller's chapter (reuses the enriched
    // listAssets rows: reservation load, stock flags, resolved photo url).
    const rows = await ctx.runQuery(api.inventory.listAssets, {});
    const context: InventoryCtx = {
      assets: rows.map((a: any) => ({
        id: a._id as Id<"assets">,
        name: a.name,
        tags: a.tags,
        quantity: a.quantity,
        consumable: a.consumable,
        condition: a.condition ?? null,
        acquired: a.acquired,
        note: a.note ?? null,
        reservedLive: a.reservedLive,
        available: a.available,
        overbooked: a.overbooked,
        lowStock: a.lowStock,
        outOfStock: a.outOfStock,
      })),
    };

    // Conversation context = system (live snapshot) + prior user/assistant turns.
    const history = await ctx.runQuery(api.ai.listMessages, { threadId });
    const priorTurns = history
      .filter((m: any) => m.kind === "user" || m.kind === "assistant")
      .map((m: any) => ({
        role: m.kind === "user" ? ("user" as const) : ("assistant" as const),
        content: m.text ?? "",
      }));
    const messages: ChatMessage[] = [
      { role: "system", content: inventorySystemPrompt(context) },
      ...priorTurns,
    ];

    const runId = await ctx.runMutation(internal.ai.startRun, {
      chapterId,
      userId,
      feature: "inventory_assistant",
      threadId,
      model: slug,
    });

    let edits = 0;
    let totalCost = 0;
    let finished = false;

    try {
      for (let step = 0; step < MAX_STEPS; step++) {
        const {
          message,
          usage,
          slug: usedSlug,
        } = await resilientCall(config, slug, messages, {
          tools: INVENTORY_TOOLS,
        });

        const cost = callCost(usedSlug, usage);
        totalCost += cost;
        chatSpent += cost;
        await ctx.runMutation(internal.ai.logUsage, {
          chapterId,
          userId,
          runId,
          threadId,
          feature: "inventory_assistant",
          model: usedSlug,
          inputTokens: usage.prompt_tokens ?? 0,
          outputTokens: usage.completion_tokens ?? 0,
          cachedTokens: usage.prompt_tokens_details?.cached_tokens,
          costUsd: cost,
        });

        // Surface the reasoning trace, if the model returned one.
        const reasoning =
          (typeof message.reasoning === "string" && message.reasoning) || "";
        if (reasoning.trim()) {
          await ctx.runMutation(internal.ai.appendMessage, {
            threadId,
            runId,
            kind: "reasoning",
            text: reasoning.trim(),
          });
        }

        const toolCalls: ToolCall[] = message.tool_calls ?? [];
        if (toolCalls.length === 0) {
          // Final answer.
          const text =
            (typeof message.content === "string" && message.content.trim()) ||
            "Done.";
          await ctx.runMutation(internal.ai.appendMessage, {
            threadId,
            runId,
            kind: "assistant",
            text,
          });
          finished = true;
          break;
        }

        // Record the assistant turn (with tool_calls) for the next round.
        messages.push(message as ChatMessage);

        for (const tc of toolCalls) {
          const parsed = parseToolArgs(tc);
          if (parsed === null) {
            // Malformed tool-arg JSON: surface it instead of silently no-op'ing.
            const summary = "Couldn't parse the tool arguments (invalid JSON).";
            await ctx.runMutation(internal.ai.appendMessage, {
              threadId,
              runId,
              kind: "tool_result",
              toolName: tc.function?.name,
              toolOk: false,
              text: summary,
            });
            messages.push({
              role: "tool",
              tool_call_id: tc.id,
              content: JSON.stringify({ ok: false, summary }),
            });
            continue;
          }
          await ctx.runMutation(internal.ai.appendMessage, {
            threadId,
            runId,
            kind: "tool_call",
            toolName: tc.function?.name,
            toolArgs: parsed,
          });

          const result = await dispatchInventoryTool(
            ctx,
            runId,
            chapterId,
            userId,
            context,
            tc.function?.name ?? "",
            parsed,
          );
          edits += result.edits ?? (result.ok ? 1 : 0);
          await ctx.runMutation(internal.ai.appendMessage, {
            threadId,
            runId,
            kind: "tool_result",
            toolName: tc.function?.name,
            toolOk: result.ok,
            text: result.summary,
          });
          messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: JSON.stringify(result),
          });
        }

        // Per-chat spend cap: stop before spending on another round.
        if (isOverChatBudget(chatSpent, spendLimitUsd)) {
          await ctx.runMutation(internal.ai.appendMessage, {
            threadId,
            runId,
            kind: "assistant",
            text: `Made ${edits} edit(s), then stopped — this chat hit its spend limit ($${spendLimitUsd?.toFixed(2)}).`,
          });
          finished = true;
          break;
        }
      }

      // Step cap hit mid-work → still leave a closing summary in the thread.
      if (!finished) {
        await ctx.runMutation(internal.ai.appendMessage, {
          threadId,
          runId,
          kind: "assistant",
          text: `Made ${edits} edit(s). Ask me to continue if there's more.`,
        });
      }

      await ctx.runMutation(internal.ai.finishRun, {
        runId,
        status: "done",
        itemsTouched: edits,
        costUsd: totalCost,
        summary: `${edits} edit(s)`,
      });
      return { ok: true, runId, edits };
    } catch (err) {
      const message =
        err instanceof ConvexError
          ? ((err.data as any)?.message ?? "Agent error.")
          : "Agent error.";
      await ctx.runMutation(internal.ai.appendMessage, {
        threadId,
        runId,
        kind: "error",
        text: message,
      });
      await ctx.runMutation(internal.ai.finishRun, {
        runId,
        status: "error",
        itemsTouched: edits,
        costUsd: totalCost,
        summary: `Errored after ${edits} edit(s)`,
      });
      return { ok: false };
    }
  },
});

// ── Model catalog + per-chat model selection ─────────────────────────────────
/**
 * The live OpenRouter model catalog for the chat's model picker: every
 * tool-calling model, free-first. `isSuperuser` rides along so the client can
 * hide paid models (and the spend-limit editor) from non-superusers — but the
 * real gate is server-side in `setThreadModel`, this flag is only cosmetic.
 *
 * Actions aren't reactive, so the panel calls this once when its settings open.
 * Falls back to the curated list if OpenRouter is unreachable.
 */
export const listModels = action({
  args: {},
  handler: async (
    ctx,
  ): Promise<{ models: AiCatalogModel[]; isSuperuser: boolean }> => {
    const cfg = await ctx.runQuery(api.ai.aiConfig, {});
    const models = await fetchCatalog();
    return { models, isSuperuser: cfg.isSuperuser };
  },
});

/**
 * Point a chat at a specific model (or clear the override with `slug: null` →
 * back to the deployment default). ANY free model is allowed for anyone; a PAID
 * model is superuser-only — the guardrail for real spend. We resolve free-vs-paid
 * from the live catalog (not the client's claim), and require the model to
 * actually support tool-calling, since the agent is useless without it.
 */
export const setThreadModel = action({
  args: {
    threadId: v.id("aiThreads"),
    slug: v.union(v.string(), v.null()),
  },
  handler: async (ctx, { threadId, slug }): Promise<{ ok: boolean }> => {
    const { chapterId } = await ctx.runQuery(internal.ai.myContext, {});

    // Clearing the override is always allowed (reverts to the free default).
    if (slug === null) {
      await ctx.runMutation(internal.ai.persistThreadModel, {
        threadId,
        chapterId,
        model: null,
      });
      return { ok: true };
    }

    // Resolve the model's free/paid status + tool-calling support from the live
    // catalog, falling back to our curated table for a known slug.
    const catalog = await fetchCatalog();
    const found =
      catalog.find((m) => m.slug === slug) ??
      (AI_MODELS[slug]
        ? {
            slug,
            label: AI_MODELS[slug].label,
            free: AI_MODELS[slug].free,
            inputPerMTok: AI_MODELS[slug].inputPerMTok,
            outputPerMTok: AI_MODELS[slug].outputPerMTok,
            contextLength: null,
            toolCalling: true,
            reasoning: true,
          }
        : null);

    if (!found) {
      // A `:free` slug is open to everyone and needs no paid-gate. If the live
      // catalog fetch degraded (curated fallback of a few models), don't block a
      // legitimately-free model the picker already showed — persist it as-is. A
      // truly bad slug just fails later with a clear per-turn error.
      if (isFreeModelSlug(slug)) {
        await ctx.runMutation(internal.ai.persistThreadModel, {
          threadId,
          chapterId,
          model: slug,
        });
        return { ok: true };
      }
      throw new ConvexError({
        code: "BAD_MODEL",
        message: "That model isn't available on OpenRouter.",
      });
    }
    if (!found.toolCalling) {
      throw new ConvexError({
        code: "NO_TOOL_CALLING",
        message: `${found.label} can't call tools, so the assistant can't use it.`,
      });
    }

    // PAID model → superuser only.
    const free = isFreeModelSlug(found.slug, {
      inputPerMTok: found.inputPerMTok,
      outputPerMTok: found.outputPerMTok,
    });
    if (!free) {
      const cfg = await ctx.runQuery(api.ai.aiConfig, {});
      if (!cfg.isSuperuser) {
        throw new ConvexError({
          code: "FORBIDDEN",
          message: "Only super admins can use paid models.",
        });
      }
    }

    await ctx.runMutation(internal.ai.persistThreadModel, {
      threadId,
      chapterId,
      model: found.slug,
    });
    return { ok: true };
  },
});
