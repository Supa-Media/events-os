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
import { aiCostUsd, MODULE_KEYS } from "@events-os/shared";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

/** Max model round-trips in one turn (each may carry several tool calls). */
const MAX_STEPS = 12;

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
  container: { type: "string", description: "Supplies: where it's packed." },
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
        "change 8 items, make ONE update_items call with 8 edits.",
      parameters: {
        type: "object",
        properties: {
          edits: {
            type: "array",
            items: {
              type: "object",
              properties: ITEM_EDIT_PROPS,
              required: ["item_id"],
              additionalProperties: false,
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
        "from the context. owner is a person's name, or 'none' to clear.",
      parameters: {
        type: "object",
        properties: ITEM_EDIT_PROPS,
        required: ["item_id"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_item",
      description:
        "Add a new item to a module. module is one of: " +
        MODULE_KEYS.join(", ") +
        ". Provide a clear title; other fields optional.",
      parameters: {
        type: "object",
        properties: {
          module: { type: "string", enum: MODULE_KEYS as unknown as string[] },
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
];

interface OpenRouterUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  cost?: number;
  prompt_tokens_details?: { cached_tokens?: number };
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

/** One OpenRouter chat-completions call (raw fetch). Tools/reasoning on by default. */
async function openRouterCall(
  slug: string,
  messages: any[],
  opts: { tools?: boolean; maxTokens?: number } = {},
): Promise<{ message: any; usage: OpenRouterUsage }> {
  const useTools = opts.tools ?? true;
  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://events-os.app",
      "X-OpenRouter-Title": "Events OS",
    },
    body: JSON.stringify({
      model: slug,
      messages,
      ...(useTools ? { tools: TOOLS, tool_choice: "auto" } : {}),
      reasoning: { effort: "low" },
      max_tokens: opts.maxTokens ?? 1500,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ConvexError({
      code: "OPENROUTER_ERROR",
      message: `OpenRouter call failed (${res.status}): ${body.slice(0, 300)}`,
    });
  }
  const json: any = await res.json();
  return {
    message: json?.choices?.[0]?.message ?? { role: "assistant", content: "" },
    usage: (json?.usage ?? {}) as OpenRouterUsage,
  };
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
        headers: { "User-Agent": "Events OS (https://events-os.app)" },
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

/** Fetch an image URL with a ~10s timeout; return a Blob iff it's an image. */
async function fetchImageBlob(url: string): Promise<Blob | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(url, { signal: controller.signal });
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
  event: { id: Id<"events">; name: string; date: number; budget: number | null };
  roles: Array<{ id: Id<"eventRoles">; key: string; label: string }>;
  people: Array<{ id: Id<"people">; name: string }>;
  optionsByModule: Record<string, Record<string, string[]>>;
  items: Array<{
    id: Id<"eventItems">;
    module: string;
    title: string;
    status: string | null;
    role: string | null;
    offsetDays: number | null;
    source: string | null;
    container: string | null;
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

/** Apply one item edit (revertibly). Returns an error string, or null on success. */
async function applyOneEdit(
  ctx: any,
  runId: Id<"aiRuns">,
  context: Ctx,
  args: any,
): Promise<string | null> {
  const itemId = args.item_id as Id<"eventItems">;
  if (!context.items.some((it) => String(it.id) === String(itemId)))
    return `No item with id ${args.item_id}.`;
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
  await ctx.runMutation(internal.ai.applyItemPatch, {
    runId,
    itemId,
    promoted,
    fields,
  });
  return null;
}

/** Run one tool call; apply the edit(s) (revertibly) and return a short result. */
async function dispatchTool(
  ctx: any,
  runId: Id<"aiRuns">,
  eventId: Id<"events">,
  context: Ctx,
  name: string,
  args: any,
): Promise<{ ok: boolean; summary: string; edits?: number }> {
  if (name === "update_item") {
    const err = await applyOneEdit(ctx, runId, context, args);
    return err ? { ok: false, summary: err } : { ok: true, summary: "Updated.", edits: 1 };
  }

  if (name === "update_items") {
    const edits: any[] = Array.isArray(args.edits) ? args.edits : [];
    if (edits.length === 0) return { ok: false, summary: "No edits provided." };
    let done = 0;
    const errors: string[] = [];
    for (const e of edits) {
      const err = await applyOneEdit(ctx, runId, context, e);
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
    if (!(MODULE_KEYS as readonly string[]).includes(args.module))
      return { ok: false, summary: `Unknown module "${args.module}".` };
    const roleId = args.role ? resolveRole(context, String(args.role)) : undefined;
    const fields: Record<string, any> = {};
    if (args.cost !== undefined) fields.cost = args.cost;
    if (args.notes !== undefined) fields.notes = args.notes;
    await ctx.runMutation(internal.ai.createItem, {
      runId,
      eventId,
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
    await ctx.runMutation(internal.ai.setItemPhoto, { runId, itemId, storageId });
    return { ok: true, summary: "Photo set." };
  }

  return { ok: false, summary: `Unknown tool "${name}".` };
}

/** Build the system prompt with a live snapshot of the event the agent edits. */
function systemPrompt(context: Ctx): string {
  const roleList = context.roles.map((r) => r.label).join(", ");
  const peopleList = context.people.map((p) => p.name).join(", ") || "(none)";
  const vocab = Object.entries(context.optionsByModule)
    .map(([mod, cols]) =>
      Object.entries(cols)
        .map(([col, vals]) => `${mod}.${col}: ${(vals as string[]).join(" | ")}`)
        .join("\n"),
    )
    .join("\n");
  const items = context.items
    .map(
      (it) =>
        `- [${it.id}] (${it.module}) "${it.title}" status=${it.status ?? "-"} ` +
        `role=${it.role ?? "-"}` +
        (it.source ? ` source=${it.source}` : "") +
        (it.container ? ` packed_in=${it.container}` : "") +
        (it.cost != null ? ` cost=${it.cost}` : ""),
    )
    .join("\n");

  return [
    "You are the Events OS planning assistant for a church event team. You help",
    "edit an event plan by calling tools. The north star: any plan must be",
    "runnable by one person alone, with zero tribal knowledge.",
    "",
    `EVENT: "${context.event.name}".`,
    `ROLES: ${roleList}.`,
    `PEOPLE: ${peopleList}.`,
    "",
    "Allowed option VALUES (use these exact values for status/source/container):",
    vocab || "(none)",
    "",
    "CURRENT ITEMS (use the [id] to target update_item / set_photo):",
    items || "(no items yet)",
    "",
    "Rules: make every requested change with tool calls. CRITICAL FOR SPEED —",
    "when changing MULTIPLE items, call update_items ONCE with all the edits in",
    "its array; never call update_item over and over. Reference items by their",
    "[id]; never invent ids. To find/add photos online, call find_photos with a",
    "short search query per item (e.g. supply title + a type word) — pass every",
    "item in one call. Once your edits are done, reply with a SHORT summary of",
    "what changed. If the request is just a question, answer it without calling",
    "tools. Be concise.",
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
    if (!process.env.OPENROUTER_API_KEY) {
      await ctx.runMutation(internal.ai.appendMessage, {
        threadId,
        kind: "error",
        text: "OPENROUTER_API_KEY is not configured.",
      });
      return { ok: false };
    }

    const context = (await ctx.runQuery(internal.ai.eventContext, {
      eventId,
    })) as EventCtx | null;
    if (!context) {
      await ctx.runMutation(internal.ai.appendMessage, {
        threadId,
        kind: "error",
        text: "Event not found.",
      });
      return { ok: false };
    }

    const cfg = await ctx.runQuery(api.ai.aiConfig, {});
    const slug = cfg.activeModel;

    // Conversation context = system (live snapshot) + prior user/assistant turns.
    const history = await ctx.runQuery(api.ai.listMessages, { threadId });
    const priorTurns = history
      .filter((m: any) => m.kind === "user" || m.kind === "assistant")
      .map((m: any) => ({
        role: m.kind === "user" ? "user" : "assistant",
        content: m.text ?? "",
      }));
    const messages: any[] = [
      { role: "system", content: systemPrompt(context) },
      ...priorTurns,
    ];

    const runId = await ctx.runMutation(internal.ai.startRun, {
      chapterId,
      userId,
      feature: "assistant",
      eventId,
      model: slug,
    });

    let edits = 0;
    let totalCost = 0;
    let finished = false;

    try {
      for (let step = 0; step < MAX_STEPS; step++) {
        const { message, usage } = await openRouterCall(slug, messages);

        const cost = callCost(slug, usage);
        totalCost += cost;
        await ctx.runMutation(internal.ai.logUsage, {
          chapterId,
          userId,
          runId,
          feature: "assistant",
          model: slug,
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

        const toolCalls: any[] = message.tool_calls ?? [];
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
        messages.push(message);

        for (const tc of toolCalls) {
          let parsed: any = {};
          try {
            parsed = JSON.parse(tc.function?.arguments ?? "{}");
          } catch {
            parsed = {};
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
            context,
            tc.function?.name,
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
    if (!process.env.OPENROUTER_API_KEY)
      throw new ConvexError({
        code: "NO_OPENROUTER_KEY",
        message: "OPENROUTER_API_KEY is not configured.",
      });

    const info = await ctx.runQuery(internal.ai.itemForAutofill, { itemId });
    if (!info)
      throw new ConvexError({ code: "NOT_FOUND", message: "Item not found." });

    const cfg = await ctx.runQuery(api.ai.aiConfig, {});
    const slug = cfg.activeModel;
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
        const { message, usage } = await openRouterCall(
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
          { tools: false, maxTokens: 16 },
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
        await ctx.runMutation(internal.ai.applyItemPatch, { runId, itemId, fields });
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
