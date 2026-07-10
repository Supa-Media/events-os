import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * AI agent run — one invocation of an agent feature (e.g. "fill supply
 * photos"). Carries status, how many items it touched, and total USD cost. A
 * run owns a set of `aiChanges`, which makes every run one-click revertible.
 */
export const aiRuns = defineTable({
  chapterId: v.id("chapters"),
  userId: v.id("users"),
  feature: v.string(),
  eventId: v.optional(v.id("events")),
  // The chat this run belongs to (assistant runs). Lets us total a single
  // chat's spend for its per-chat cap. Optional: autofill runs have no thread.
  threadId: v.optional(v.id("aiThreads")),
  model: v.string(),
  status: v.union(
    v.literal("running"),
    v.literal("done"),
    v.literal("error"),
    v.literal("reverted"),
  ),
  itemsTouched: v.number(),
  costUsd: v.number(),
  summary: v.optional(v.string()),
  createdAt: v.number(),
})
  .index("by_chapter", ["chapterId"])
  .index("by_chapter_time", ["chapterId", "createdAt"]);

/**
 * AI change — one revertible edit an agent run made to an item. The generic
 * key/before/after shape is intentional: any agent edit to any field reuses
 * this same log, and Undo restores `before`.
 *
 * `key` is interpreted by the revert logic:
 *   - "__created"      → the run CREATED this item; Undo deletes it.
 *   - "fields.<key>"   → a custom-column value in the item's `fields` bag.
 *   - any other string → a promoted top-level field (title, status, roleId…).
 */
export const aiChanges = defineTable({
  runId: v.id("aiRuns"),
  chapterId: v.id("chapters"),
  eventId: v.optional(v.id("events")),
  itemId: v.id("eventItems"),
  key: v.string(),
  before: v.optional(v.any()),
  after: v.optional(v.any()),
  revertedAt: v.optional(v.number()),
}).index("by_run", ["runId"]);

/**
 * AI assistant thread — a Notion-AI-style conversation pinned to one event OR
 * one How-To doc. Exactly one of `eventId` / `docId` is set: event threads drive
 * the event-page agent, doc threads drive the doc editor's chat. Messages stream
 * into `aiMessages` as the agent works, so the panel renders reasoning + tool
 * calls reactively.
 */
export const aiThreads = defineTable({
  chapterId: v.id("chapters"),
  eventId: v.optional(v.id("events")),
  docId: v.optional(v.id("docs")),
  userId: v.id("users"),
  title: v.string(),
  // Per-chat AI overrides (all optional; unset → deployment default).
  //   model         — the OpenRouter slug THIS chat runs on (any free model for
  //                   anyone; a paid slug only a superuser can set).
  //   spendLimitUsd — a hard lifetime USD cap on this chat's spend; once total
  //                   spend reaches it the chat stops accepting messages. The
  //                   guardrail for a chat pointed at a paid model.
  model: v.optional(v.string()),
  spendLimitUsd: v.optional(v.number()),
  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index("by_event", ["eventId"])
  .index("by_doc", ["docId"])
  .index("by_chapter", ["chapterId"]);

/**
 * AI assistant message — one entry in a thread. `kind` distinguishes the
 * user's prompt, the agent's reasoning trace, each tool call + its result, the
 * final assistant reply, and errors — so the panel can render each distinctly
 * (collapsible reasoning, tool-call chips, etc.). `order` is monotonic within
 * a thread for stable display.
 */
export const aiMessages = defineTable({
  threadId: v.id("aiThreads"),
  chapterId: v.id("chapters"),
  runId: v.optional(v.id("aiRuns")),
  kind: v.union(
    v.literal("user"),
    v.literal("assistant"),
    v.literal("reasoning"),
    v.literal("tool_call"),
    v.literal("tool_result"),
    v.literal("error"),
  ),
  text: v.optional(v.string()),
  toolName: v.optional(v.string()),
  toolArgs: v.optional(v.any()),
  toolOk: v.optional(v.boolean()),
  order: v.number(),
  createdAt: v.number(),
}).index("by_thread", ["threadId"]);

/**
 * AI usage — token + dollar accounting per completion call, for the rolling
 * per-user / per-chapter / org budget windows.
 */
export const aiUsage = defineTable({
  chapterId: v.id("chapters"),
  userId: v.id("users"),
  runId: v.optional(v.id("aiRuns")),
  // The chat this call was billed to (assistant calls) — indexed so a single
  // chat's lifetime spend totals cheaply for its per-chat cap.
  threadId: v.optional(v.id("aiThreads")),
  feature: v.string(),
  model: v.string(),
  inputTokens: v.number(),
  outputTokens: v.number(),
  cachedTokens: v.optional(v.number()),
  costUsd: v.number(),
  createdAt: v.number(),
})
  .index("by_chapter_time", ["chapterId", "createdAt"])
  .index("by_user_time", ["userId", "createdAt"])
  .index("by_thread", ["threadId"]);

/**
 * AI settings — a single-row (singleton) table holding the deployment-wide
 * active model every run uses. Only superusers can change it. Read via
 * `.first()`; no index needed.
 */
export const aiSettings = defineTable({
  activeModel: v.string(),
  updatedBy: v.optional(v.id("users")),
  updatedAt: v.number(),
});
