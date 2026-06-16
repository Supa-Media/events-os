/**
 * AI assistant spine — queries + mutations (NO "use node"; the network/LLM work
 * lives in `aiActions.ts`).
 *
 * This is the reusable backbone behind the in-app assistant:
 *   - `aiThreads` / `aiMessages` — a Notion-AI-style conversation per event;
 *     reasoning + tool calls stream in as rows so the panel renders reactively.
 *   - `aiRuns`    — one assistant turn (running / done / error / reverted).
 *   - `aiChanges` — a per-run log of every edit, so any turn is one-click revertible.
 *   - `aiUsage`   — token + dollar accounting for the rolling budget windows.
 *
 * Budgets are dollar caps over a rolling 30-day window, applied per user, per
 * chapter, and org-wide ("deployment = one org"). With free models spend is $0,
 * so caps never trip — the plumbing stays for the day we re-add paid models.
 */
import {
  query,
  mutation,
  internalQuery,
  internalMutation,
} from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { v, ConvexError } from "convex/values";
import {
  requireUserId,
  requireChapterId,
  getChapterIdOrNull,
  requireInChapter,
} from "./lib/context";
import { isSuperuser } from "./lib/superuser";
import {
  AI_BUDGETS,
  AI_BUDGET_WINDOW_MS,
  AI_MODELS,
  DEFAULT_AI_MODEL,
  computeDueDate,
  DAY_OFFSET_MODULES,
  overBudgetScope,
  type ModuleKey,
} from "@events-os/shared";

/** Round a USD amount to whole cents. */
function toCents(usd: number): number {
  return Math.round(usd * 100) / 100;
}

function isDayOffsetModule(module: string): boolean {
  return DAY_OFFSET_MODULES.includes(module as ModuleKey);
}

// ── Internal: context the action needs (reads ctx.db) ────────────────────────
/** The caller's userId + chapterId, resolved inside a query the action calls. */
export const myContext = internalQuery({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    const chapterId = await requireChapterId(ctx);
    return {
      userId: userId as Id<"users">,
      chapterId: chapterId as Id<"chapters">,
    };
  },
});

/**
 * A compact snapshot of an event the agent reasons over: every item (with its
 * id, module, title, status, role, owner, cost, notes), plus the vocab it needs
 * to make valid edits (each module's column option-sets, the chapter's roles,
 * and the roster). Re-fetched every turn, so the agent always sees live state.
 */
export const eventContext = internalQuery({
  args: { eventId: v.id("events"), chapterId: v.id("chapters") },
  handler: async (ctx, { eventId, chapterId }) => {
    const event = await ctx.db.get(eventId);
    // TENANT BOUNDARY: this is an internal fn reachable from an action that
    // accepts an arbitrary eventId arg. We MUST confirm the event belongs to
    // the caller's chapter (threaded in from myContext) — otherwise any
    // authenticated user could read another chapter's event by passing its id.
    // Mirror docs.forAi: return null on missing OR cross-chapter.
    if (!event || event.chapterId !== chapterId) return null;

    const roles = (
      await ctx.db
        .query("eventRoles")
        .withIndex("by_event", (q: any) => q.eq("eventId", eventId))
        .collect()
    )
      .sort((a: any, b: any) => a.order - b.order)
      .map((r: any) => ({ id: r._id, key: r.key, label: r.label }));

    const people = (
      await ctx.db
        .query("people")
        .withIndex("by_chapter", (q: any) => q.eq("chapterId", event.chapterId))
        .collect()
    ).map((p: any) => ({ id: p._id, name: p.name }));

    const columns = await ctx.db
      .query("eventColumns")
      .withIndex("by_event", (q: any) => q.eq("eventId", eventId))
      .collect();

    // Per-module: the select/status options agents may assign by value.
    const optionsByModule: Record<string, Record<string, string[]>> = {};
    for (const c of columns) {
      if (Array.isArray(c.options) && c.options.length) {
        (optionsByModule[c.module] ??= {})[c.key] = c.options.map(
          (o: any) => o.value,
        );
      }
    }

    const rawItems = await ctx.db
      .query("eventItems")
      .withIndex("by_event", (q: any) => q.eq("eventId", eventId))
      .collect();

    const roleLabel = new Map(roles.map((r) => [String(r.id), r.label]));
    const items = rawItems
      .sort((a: any, b: any) => a.order - b.order)
      .map((it: any) => ({
        id: it._id,
        module: it.module,
        title: it.title,
        status: it.status ?? null,
        role: it.roleId ? (roleLabel.get(String(it.roleId)) ?? null) : null,
        offsetDays: it.offsetDays ?? null,
        source: it.fields?.source ?? null,
        container: it.fields?.container ?? null,
        cost: it.fields?.cost ?? null,
        notes: it.fields?.notes ?? null,
        hasPhoto: !!it.fields?.photo,
      }));

    return {
      event: {
        id: event._id,
        name: event.name,
        date: event.eventDate,
        budget: event.budget ?? null,
      },
      roles,
      people,
      optionsByModule,
      items,
    };
  },
});

/** One item + which columns its module shows — for the per-row Autofill button. */
export const itemForAutofill = internalQuery({
  args: { itemId: v.id("eventItems"), chapterId: v.id("chapters") },
  handler: async (ctx, { itemId, chapterId }) => {
    const item = await ctx.db.get(itemId);
    // TENANT BOUNDARY: itemId is an arbitrary arg from an action. Confirm the
    // item is in the caller's chapter before returning anything about it —
    // otherwise Autofill could read/enrich another chapter's item. Return null
    // on missing OR cross-chapter (the action surfaces "Item not found").
    if (!item || item.chapterId !== chapterId) return null;
    const cols = await ctx.db
      .query("eventColumns")
      .withIndex("by_event_module", (q: any) =>
        q.eq("eventId", item.eventId).eq("module", item.module),
      )
      .collect();
    return {
      eventId: item.eventId as Id<"events">,
      title: item.title,
      module: item.module,
      fields: (item.fields ?? {}) as Record<string, any>,
      columnKeys: cols
        .filter((c: any) => c.isVisible)
        .map((c: any) => c.key as string),
    };
  },
});

// ── Internal: run lifecycle ──────────────────────────────────────────────────
export const startRun = internalMutation({
  args: {
    chapterId: v.id("chapters"),
    userId: v.id("users"),
    feature: v.string(),
    eventId: v.optional(v.id("events")),
    model: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("aiRuns", {
      chapterId: args.chapterId,
      userId: args.userId,
      feature: args.feature,
      eventId: args.eventId,
      model: args.model,
      status: "running",
      itemsTouched: 0,
      costUsd: 0,
      createdAt: Date.now(),
    });
  },
});

export const finishRun = internalMutation({
  args: {
    runId: v.id("aiRuns"),
    status: v.union(
      v.literal("running"),
      v.literal("done"),
      v.literal("error"),
      v.literal("reverted"),
    ),
    itemsTouched: v.number(),
    costUsd: v.number(),
    summary: v.optional(v.string()),
  },
  handler: async (ctx, { runId, ...patch }) => {
    await ctx.db.patch(runId, patch);
  },
});

export const logUsage = internalMutation({
  args: {
    chapterId: v.id("chapters"),
    userId: v.id("users"),
    runId: v.optional(v.id("aiRuns")),
    feature: v.string(),
    model: v.string(),
    inputTokens: v.number(),
    outputTokens: v.number(),
    cachedTokens: v.optional(v.number()),
    costUsd: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("aiUsage", { ...args, createdAt: Date.now() });
  },
});

// ── Internal: thread messages (the stream the panel renders) ─────────────────
/** Append a message to a thread (auto-incrementing order) and bump the thread. */
export const appendMessage = internalMutation({
  args: {
    threadId: v.id("aiThreads"),
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
  },
  handler: async (ctx, args) => {
    const thread = await ctx.db.get(args.threadId);
    if (!thread) throw new ConvexError({ code: "NOT_FOUND", message: "Thread gone." });
    const last = await ctx.db
      .query("aiMessages")
      .withIndex("by_thread", (q: any) => q.eq("threadId", args.threadId))
      .order("desc")
      .first();
    const order = (last?.order ?? -1) + 1;
    const id = await ctx.db.insert("aiMessages", {
      threadId: args.threadId,
      chapterId: thread.chapterId,
      runId: args.runId,
      kind: args.kind,
      text: args.text,
      toolName: args.toolName,
      toolArgs: args.toolArgs,
      toolOk: args.toolOk,
      order,
      createdAt: Date.now(),
    });
    await ctx.db.patch(args.threadId, { updatedAt: Date.now() });
    return id;
  },
});

// ── Internal: revertible item edits (the agent's write tools) ────────────────
/** The promoted item fields the agent may set directly (not in the `fields` bag). */
const PROMOTED_KEYS = [
  "title",
  "status",
  "roleId",
  "ownerPersonId",
  "offsetDays",
  "offsetMinutes",
] as const;

/**
 * Apply a multi-field patch to an event item and log every change for revert.
 * Promoted fields are logged by name; custom fields under "fields.<key>". When
 * `offsetDays` changes on a day-offset module, the due date is re-derived.
 */
export const applyItemPatch = internalMutation({
  args: {
    runId: v.id("aiRuns"),
    itemId: v.id("eventItems"),
    chapterId: v.id("chapters"),
    promoted: v.optional(v.record(v.string(), v.any())),
    fields: v.optional(v.record(v.string(), v.any())),
  },
  handler: async (ctx, { runId, itemId, chapterId, promoted, fields }) => {
    const item = await ctx.db.get(itemId);
    // TENANT BOUNDARY: a write tool reachable from an action with an arbitrary
    // itemId. Refuse to patch an item that isn't in the caller's chapter — a
    // cross-tenant id must NOT be editable. Throw (not silent return) so a
    // mismatch surfaces loudly rather than masquerading as a no-op success.
    if (!item) return;
    if (item.chapterId !== chapterId) {
      throw new ConvexError({
        code: "FORBIDDEN",
        message: "Item is not in your chapter.",
      });
    }
    const event = await ctx.db.get(item.eventId);
    if (!event) return;

    const patch: Record<string, any> = {};

    for (const [key, after] of Object.entries(promoted ?? {})) {
      if (!(PROMOTED_KEYS as readonly string[]).includes(key)) continue;
      const before = (item as any)[key] ?? undefined;
      const value = after ?? undefined;
      patch[key] = value;
      await ctx.db.insert("aiChanges", {
        runId,
        chapterId: item.chapterId,
        eventId: item.eventId,
        itemId,
        key,
        before,
        after: value,
      });
      if (key === "offsetDays" && isDayOffsetModule(item.module)) {
        patch.dueDate =
          value === undefined ? undefined : computeDueDate(event.eventDate, value);
      }
    }

    if (fields && Object.keys(fields).length) {
      const merged = { ...(item.fields ?? {}) };
      for (const [key, after] of Object.entries(fields)) {
        const before = merged[key];
        if (after === null || after === undefined) delete merged[key];
        else merged[key] = after;
        await ctx.db.insert("aiChanges", {
          runId,
          chapterId: item.chapterId,
          eventId: item.eventId,
          itemId,
          key: `fields.${key}`,
          before,
          after: after ?? undefined,
        });
      }
      patch.fields = merged;
    }

    if (Object.keys(patch).length) await ctx.db.patch(itemId, patch);
  },
});

/** Create a new event item and log it as a revertible creation (Undo deletes it). */
export const createItem = internalMutation({
  args: {
    runId: v.id("aiRuns"),
    eventId: v.id("events"),
    chapterId: v.id("chapters"),
    module: v.string(),
    title: v.string(),
    status: v.optional(v.string()),
    roleId: v.optional(v.id("eventRoles")),
    offsetDays: v.optional(v.number()),
    fields: v.optional(v.record(v.string(), v.any())),
  },
  handler: async (ctx, args) => {
    const event = await ctx.db.get(args.eventId);
    // TENANT BOUNDARY: eventId is an arbitrary arg from an action. Refuse to
    // create an item under an event that isn't in the caller's chapter — a
    // cross-tenant id must NOT be writable. Throw so the mismatch is loud.
    if (!event) return null;
    if (event.chapterId !== args.chapterId) {
      throw new ConvexError({
        code: "FORBIDDEN",
        message: "Event is not in your chapter.",
      });
    }
    const siblings = await ctx.db
      .query("eventItems")
      .withIndex("by_event_module", (q: any) =>
        q.eq("eventId", args.eventId).eq("module", args.module),
      )
      .collect();
    const order = siblings.reduce((m: number, it: any) => Math.max(m, it.order), -1) + 1;
    const dueDate =
      isDayOffsetModule(args.module) && args.offsetDays !== undefined
        ? computeDueDate(event.eventDate, args.offsetDays)
        : undefined;
    const itemId = await ctx.db.insert("eventItems", {
      eventId: args.eventId,
      chapterId: event.chapterId,
      module: args.module,
      title: args.title,
      order,
      offsetDays: args.offsetDays,
      dueDate,
      status: args.status,
      roleId: args.roleId,
      fields: args.fields,
    });
    await ctx.db.insert("aiChanges", {
      runId: args.runId,
      chapterId: event.chapterId,
      eventId: args.eventId,
      itemId,
      key: "__created",
      before: undefined,
      after: null,
    });
    return itemId;
  },
});

/** Store a fetched photo on an item and log the change (Undo clears it). */
export const setItemPhoto = internalMutation({
  args: {
    runId: v.id("aiRuns"),
    itemId: v.id("eventItems"),
    chapterId: v.id("chapters"),
    storageId: v.id("_storage"),
  },
  handler: async (ctx, { runId, itemId, chapterId, storageId }) => {
    const item = await ctx.db.get(itemId);
    // TENANT BOUNDARY: itemId is an arbitrary arg from an action. Refuse to
    // attach a photo to an item outside the caller's chapter — a cross-tenant
    // id must NOT be writable. Throw so the mismatch is loud, not a silent skip.
    if (!item) return;
    if (item.chapterId !== chapterId) {
      throw new ConvexError({
        code: "FORBIDDEN",
        message: "Item is not in your chapter.",
      });
    }
    const before = item.fields?.photo;
    await ctx.db.patch(itemId, {
      fields: { ...(item.fields ?? {}), photo: storageId },
    });
    await ctx.db.insert("aiChanges", {
      runId,
      chapterId: item.chapterId,
      eventId: item.eventId,
      itemId,
      key: "fields.photo",
      before,
      after: storageId,
    });
  },
});

// ── Public: assistant threads ────────────────────────────────────────────────
/** The most recent thread for an event, creating one if none exists. */
export const ensureThread = mutation({
  args: { eventId: v.id("events") },
  handler: async (ctx, { eventId }) => {
    const chapterId = await requireChapterId(ctx);
    const event = await ctx.db.get(eventId);
    await requireInChapter(ctx, chapterId, event, "Event");
    const existing = await ctx.db
      .query("aiThreads")
      .withIndex("by_event", (q: any) => q.eq("eventId", eventId))
      .order("desc")
      .first();
    if (existing) return existing._id;
    const userId = (await requireUserId(ctx)) as Id<"users">;
    return await ctx.db.insert("aiThreads", {
      chapterId: chapterId as Id<"chapters">,
      eventId,
      userId,
      title: "New chat",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  },
});

/** Start a fresh thread for an event (the "New chat" button). */
export const newThread = mutation({
  args: { eventId: v.id("events") },
  handler: async (ctx, { eventId }) => {
    const chapterId = await requireChapterId(ctx);
    const event = await ctx.db.get(eventId);
    await requireInChapter(ctx, chapterId, event, "Event");
    const userId = (await requireUserId(ctx)) as Id<"users">;
    return await ctx.db.insert("aiThreads", {
      chapterId: chapterId as Id<"chapters">,
      eventId,
      userId,
      title: "New chat",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  },
});

/** The most recent thread for a How-To doc, creating one if none exists. */
export const ensureDocThread = mutation({
  args: { docId: v.id("docs") },
  handler: async (ctx, { docId }) => {
    const chapterId = await requireChapterId(ctx);
    const doc = await ctx.db.get(docId);
    await requireInChapter(ctx, chapterId, doc, "Doc");
    const existing = await ctx.db
      .query("aiThreads")
      .withIndex("by_doc", (q: any) => q.eq("docId", docId))
      .order("desc")
      .first();
    if (existing) return existing._id;
    const userId = (await requireUserId(ctx)) as Id<"users">;
    return await ctx.db.insert("aiThreads", {
      chapterId: chapterId as Id<"chapters">,
      docId,
      userId,
      title: "New chat",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  },
});

/** Start a fresh thread for a How-To doc (the "New chat" button). */
export const newDocThread = mutation({
  args: { docId: v.id("docs") },
  handler: async (ctx, { docId }) => {
    const chapterId = await requireChapterId(ctx);
    const doc = await ctx.db.get(docId);
    await requireInChapter(ctx, chapterId, doc, "Doc");
    const userId = (await requireUserId(ctx)) as Id<"users">;
    return await ctx.db.insert("aiThreads", {
      chapterId: chapterId as Id<"chapters">,
      docId,
      userId,
      title: "New chat",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  },
});

/** Messages in a thread, oldest-first — the panel's reactive feed. */
export const listMessages = query({
  args: { threadId: v.optional(v.id("aiThreads")) },
  handler: async (ctx, { threadId }) => {
    if (!threadId) return [];
    const chapterId = await getChapterIdOrNull(ctx);
    if (!chapterId) return [];
    const thread = await ctx.db.get(threadId);
    if (!thread || thread.chapterId !== chapterId) return [];
    return (
      await ctx.db
        .query("aiMessages")
        .withIndex("by_thread", (q: any) => q.eq("threadId", threadId))
        .collect()
    ).sort((a: any, b: any) => a.order - b.order);
  },
});

// ── Public: budget status ────────────────────────────────────────────────────
/**
 * Windowed AI spend for the caller's user, chapter, and the whole org, vs. the
 * configured caps. `over` names the first scope (if any) at/over its cap.
 */
export const budgetStatus = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    const chapterId = await getChapterIdOrNull(ctx);
    const since = Date.now() - AI_BUDGET_WINDOW_MS;

    const userRows = await ctx.db
      .query("aiUsage")
      .withIndex("by_user_time", (q: any) =>
        q.eq("userId", userId).gte("createdAt", since),
      )
      .collect();
    const userSpent = userRows.reduce((s, r) => s + r.costUsd, 0);

    const chapterRows = chapterId
      ? await ctx.db
          .query("aiUsage")
          .withIndex("by_chapter_time", (q: any) =>
            q.eq("chapterId", chapterId).gte("createdAt", since),
          )
          .collect()
      : [];
    const chapterSpent = chapterRows.reduce((s, r) => s + r.costUsd, 0);

    // Org = the whole deployment: every usage row in the window.
    const orgRows = await ctx.db
      .query("aiUsage")
      .filter((q: any) => q.gte(q.field("createdAt"), since))
      .collect();
    const orgSpent = orgRows.reduce((s, r) => s + r.costUsd, 0);

    const over = overBudgetScope({
      user: userSpent,
      chapter: chapterSpent,
      org: orgSpent,
    });

    return {
      user: { spent: toCents(userSpent), cap: AI_BUDGETS.perUserUsd },
      chapter: { spent: toCents(chapterSpent), cap: AI_BUDGETS.perChapterUsd },
      org: { spent: toCents(orgSpent), cap: AI_BUDGETS.orgUsd },
      over,
    };
  },
});

// ── Public: AI model config (active model + superuser gate) ───────────────────
/**
 * The deployment-wide active AI model, the full model menu, and whether the
 * caller is a superuser (so the client can show an editable picker). The active
 * model lives in the singleton `aiSettings` row; it falls back to
 * `DEFAULT_AI_MODEL` if unset or pointing at a model that no longer exists.
 */
export const aiConfig = query({
  args: {},
  handler: async (
    ctx,
  ): Promise<{
    activeModel: string;
    isSuperuser: boolean;
    models: Array<{ slug: string; label: string }>;
  }> => {
    const settings = await ctx.db.query("aiSettings").first();
    const stored = settings?.activeModel;
    const activeModel =
      stored && AI_MODELS[stored] ? stored : DEFAULT_AI_MODEL;
    return {
      activeModel,
      isSuperuser: await isSuperuser(ctx),
      models: Object.values(AI_MODELS).map((m) => ({
        slug: m.slug,
        label: m.label,
      })),
    };
  },
});

/**
 * Set the deployment-wide active AI model. Superuser-only; rejects unknown
 * slugs. Upserts the singleton `aiSettings` row.
 */
export const setActiveModel = mutation({
  args: { slug: v.string() },
  handler: async (ctx, { slug }) => {
    if (!(await isSuperuser(ctx))) {
      throw new ConvexError({
        code: "FORBIDDEN",
        message: "Only superusers can change the AI model.",
      });
    }
    if (!AI_MODELS[slug]) {
      throw new ConvexError({ code: "BAD_MODEL", message: "Unknown model." });
    }
    const updatedBy = (await requireUserId(ctx)) as Id<"users">;
    const existing = await ctx.db.query("aiSettings").first();
    if (existing) {
      await ctx.db.patch(existing._id, {
        activeModel: slug,
        updatedBy,
        updatedAt: Date.now(),
      });
    } else {
      await ctx.db.insert("aiSettings", {
        activeModel: slug,
        updatedBy,
        updatedAt: Date.now(),
      });
    }
    return null;
  },
});

// ── Public: list runs (for the Undo UI) ──────────────────────────────────────
/** Recent agent runs in the caller's chapter, with change counts for Undo. */
export const listRuns = query({
  args: { eventId: v.optional(v.id("events")) },
  handler: async (ctx, { eventId }) => {
    const chapterId = await getChapterIdOrNull(ctx);
    if (!chapterId) return [];
    const runs = (
      await ctx.db
        .query("aiRuns")
        .withIndex("by_chapter_time", (q: any) =>
          q.eq("chapterId", chapterId),
        )
        .order("desc")
        .take(40)
    )
      .filter((r: any) => (eventId ? r.eventId === eventId : true))
      .slice(0, 20);

    return await Promise.all(
      runs.map(async (run: any) => {
        const changes = await ctx.db
          .query("aiChanges")
          .withIndex("by_run", (q: any) => q.eq("runId", run._id))
          .collect();
        return {
          ...run,
          changeCount: changes.length,
          revertableCount: changes.filter((c: any) => c.revertedAt == null)
            .length,
        };
      }),
    );
  },
});

// ── Public: revert a run ──────────────────────────────────────────────────────
/**
 * Undo every not-yet-reverted change of a run, in reverse insertion order:
 *   - "__created"    → delete the item the run created.
 *   - "fields.<key>" → restore the custom-field value in the `fields` bag.
 *   - promoted field → restore the top-level field (re-deriving due date).
 * A field edit is only restored if the item's current value still equals what
 * the agent set (`after`), so manual edits made since aren't clobbered.
 */
export const revertAiRun = mutation({
  args: { runId: v.id("aiRuns") },
  handler: async (ctx, { runId }) => {
    const chapterId = await requireChapterId(ctx);
    const run = await ctx.db.get(runId);
    await requireInChapter(ctx, chapterId, run, "AI run");

    const changes = (
      await ctx.db
        .query("aiChanges")
        .withIndex("by_run", (q: any) => q.eq("runId", runId))
        .collect()
    )
      .filter((c: any) => c.revertedAt == null)
      .reverse();

    let reverted = 0;
    let skipped = 0;
    for (const change of changes) {
      const item = await ctx.db.get(change.itemId);

      if (change.key === "__created") {
        // Created by the run → undo means delete (if still present).
        if (item) await ctx.db.delete(change.itemId);
        await ctx.db.patch(change._id, { revertedAt: Date.now() });
        reverted++;
        continue;
      }

      if (!item) {
        skipped++;
        continue;
      }

      if (change.key.startsWith("fields.")) {
        const key = change.key.slice("fields.".length);
        const current = item.fields?.[key];
        if (current !== change.after) {
          skipped++;
          continue;
        }
        const fields = { ...(item.fields ?? {}) };
        if (change.before === undefined) delete fields[key];
        else fields[key] = change.before;
        await ctx.db.patch(change.itemId, { fields });
      } else {
        // Promoted top-level field.
        const current = (item as any)[change.key] ?? undefined;
        if (current !== change.after) {
          skipped++;
          continue;
        }
        const patch: Record<string, any> = { [change.key]: change.before };
        if (change.key === "offsetDays") {
          const event = await ctx.db.get(item.eventId);
          patch.dueDate =
            event && isDayOffsetModule(item.module) && change.before != null
              ? computeDueDate(event.eventDate, change.before)
              : undefined;
        }
        await ctx.db.patch(change.itemId, patch);
      }

      await ctx.db.patch(change._id, { revertedAt: Date.now() });
      reverted++;
    }

    await ctx.db.patch(runId, { status: "reverted" });
    return { reverted, skipped };
  },
});
