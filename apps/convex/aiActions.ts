"use node";

/**
 * AI agent actions — the Node-runtime side of the AI spine, where the LLM /
 * network work happens.
 *
 * We talk to models through OpenRouter via RAW fetch (not an SDK): the
 * server-side web-search tool is OpenRouter-specific and only works on raw
 * chat-completions calls. The model is a swappable slug (see `@events-os/shared`).
 *
 * v1 feature — `fillSupplyPhotos`: for each Supplies item on an event with no
 * photo, the agent web-searches for a representative product image and saves it.
 * Every save is logged as an `aiChange`, so the whole run is one-click revertible.
 */
import { action } from "./_generated/server";
import { internal, api } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { v, ConvexError } from "convex/values";
import { aiCostUsd } from "@events-os/shared";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

/** Max model round-trips per item (search → set_photo → retries). */
const MAX_CALLS_PER_ITEM = 4;
/** Default cap on how many items one run will process. */
const DEFAULT_MAX_ITEMS = 12;

const SYSTEM_PROMPT =
  "You find a single representative product photo for a supplies/equipment " +
  "item used at an event. Search the web, then call set_photo exactly once " +
  "with a DIRECT image-file URL (jpg/png/webp). Prefer a clean product shot " +
  "on a plain background. If you truly can't find one, reply without calling " +
  "the tool.";

/** The tools we hand the model: OpenRouter server-side web search + set_photo. */
const TOOLS = [
  {
    type: "openrouter:web_search",
    parameters: { max_results: 5, search_context_size: "low" },
  },
  {
    type: "function",
    function: {
      name: "set_photo",
      description:
        "Save the chosen direct image URL as this supply item's photo. The " +
        "URL must point directly at an image file (jpg/png/webp), not a web page.",
      parameters: {
        type: "object",
        properties: { image_url: { type: "string" } },
        required: ["image_url"],
        additionalProperties: false,
      },
    },
  },
];

interface OpenRouterUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cost?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

/** Cost for one completion: prefer the gateway's exact cost, else estimate. */
function callCost(slug: string, usage: OpenRouterUsage): number {
  if (typeof usage.cost === "number") return usage.cost;
  return aiCostUsd(slug, {
    inputTokens: usage.prompt_tokens ?? 0,
    outputTokens: usage.completion_tokens ?? 0,
    cachedTokens: usage.prompt_tokens_details?.cached_tokens,
  });
}

/** One OpenRouter chat-completions call (raw fetch). */
async function openRouterCall(
  slug: string,
  messages: any[],
): Promise<{ message: any; usage: OpenRouterUsage }> {
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
      tools: TOOLS,
      tool_choice: "auto",
      max_tokens: 1024,
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

/**
 * Fill missing supply photos for an event. For each photoless Supplies item the
 * agent web-searches, picks a direct image URL, we fetch + store it, and log a
 * revertible change. Stops early if a budget cap is hit mid-run.
 */
export const fillSupplyPhotos = action({
  args: {
    eventId: v.id("events"),
    model: v.optional(v.string()),
    max: v.optional(v.number()),
  },
  handler: async (
    ctx,
    { eventId, model, max },
  ): Promise<{
    runId: Id<"aiRuns">;
    filled: number;
    total: number;
    costUsd: number;
  }> => {
    const { userId, chapterId } = await ctx.runQuery(
      internal.ai.myContext,
      {},
    );

    // Budget gate (start-of-run).
    const budget = await ctx.runQuery(api.ai.budgetStatus, {});
    if (budget.over) {
      throw new ConvexError({
        code: "AI_BUDGET",
        message: `AI budget reached (${budget.over}).`,
      });
    }

    if (!process.env.OPENROUTER_API_KEY) {
      throw new ConvexError({
        code: "NO_OPENROUTER_KEY",
        message: "OPENROUTER_API_KEY is not configured.",
      });
    }

    // Resolve the model: explicit arg wins, else the deployment's active model.
    const cfg = await ctx.runQuery(api.ai.aiConfig, {});
    const slug = model ?? cfg.activeModel;
    const allItems = await ctx.runQuery(internal.ai.suppliesNeedingPhotos, {
      eventId,
    });
    const items = allItems.slice(0, max ?? DEFAULT_MAX_ITEMS);

    const runId = await ctx.runMutation(internal.ai.startRun, {
      chapterId,
      userId,
      feature: "supply_photo_fill",
      eventId,
      model: slug,
    });

    let filled = 0;
    let totalCost = 0;

    try {
      for (const item of items) {
        // Re-check budget between items (not just at start).
        const mid = await ctx.runQuery(api.ai.budgetStatus, {});
        if (mid.over) break;

        const messages: any[] = [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: item.title },
        ];

        for (let call = 0; call < MAX_CALLS_PER_ITEM; call++) {
          const { message, usage } = await openRouterCall(slug, messages);

          const cost = callCost(slug, usage);
          totalCost += cost;
          await ctx.runMutation(internal.ai.logUsage, {
            chapterId,
            userId,
            runId,
            feature: "supply_photo_fill",
            model: slug,
            inputTokens: usage.prompt_tokens ?? 0,
            outputTokens: usage.completion_tokens ?? 0,
            cachedTokens: usage.prompt_tokens_details?.cached_tokens,
            costUsd: cost,
          });

          const toolCall = message?.tool_calls?.find(
            (t: any) => t.function?.name === "set_photo",
          );
          // No tool call → the model gave up on this item.
          if (!toolCall) break;

          // Always append the assistant message before the tool result.
          messages.push(message);

          let imageUrl: string | undefined;
          try {
            imageUrl = JSON.parse(toolCall.function.arguments)?.image_url;
          } catch {
            imageUrl = undefined;
          }

          const blob = imageUrl ? await fetchImageBlob(imageUrl) : null;
          if (blob) {
            const storageId = await ctx.storage.store(blob);
            await ctx.runMutation(internal.ai.applyPhotoChange, {
              runId,
              itemId: item._id,
              storageId,
            });
            filled++;
            messages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              content: JSON.stringify({ ok: true }),
            });
            break; // photo set for this item
          }

          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify({
              ok: false,
              error:
                "That URL was not a direct image file. Find a direct " +
                ".jpg/.png/.webp URL.",
            }),
          });
        }
      }

      await ctx.runMutation(internal.ai.finishRun, {
        runId,
        status: "done",
        itemsTouched: filled,
        costUsd: totalCost,
        summary: `Filled ${filled}/${items.length} photos`,
      });

      return { runId, filled, total: items.length, costUsd: totalCost };
    } catch (err) {
      await ctx.runMutation(internal.ai.finishRun, {
        runId,
        status: "error",
        itemsTouched: filled,
        costUsd: totalCost,
        summary: `Errored after filling ${filled}/${items.length}`,
      });
      throw err;
    }
  },
});
