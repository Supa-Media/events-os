/**
 * AI agent spine — queries + mutations (NO "use node"; the network/LLM work
 * lives in `aiActions.ts`).
 *
 * This is the reusable backbone behind every agent feature:
 *   - `aiRuns`    — one invocation of a feature (running / done / error / reverted)
 *   - `aiChanges` — a per-run log of field edits, so any run is one-click revertible
 *   - `aiUsage`   — token + dollar accounting for the rolling budget windows
 *
 * Budgets are dollar caps over a rolling 30-day window, applied per user, per
 * chapter, and org-wide ("deployment = one org"). See `@events-os/shared`.
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
  overBudgetScope,
} from "@events-os/shared";

/** Round a USD amount to whole cents. */
function toCents(usd: number): number {
  return Math.round(usd * 100) / 100;
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

/** Supply items on an event with no photo yet — the agent's work list. */
export const suppliesNeedingPhotos = internalQuery({
  args: { eventId: v.id("events") },
  handler: async (ctx, { eventId }) => {
    const items = await ctx.db
      .query("eventItems")
      .withIndex("by_event_module", (q: any) =>
        q.eq("eventId", eventId).eq("module", "supplies"),
      )
      .collect();
    return items
      .filter((it: any) => !it.fields?.photo)
      .map((it: any) => ({ _id: it._id as Id<"eventItems">, title: it.title }));
  },
});

// ── Internal: run lifecycle + change/usage logging ───────────────────────────
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

/** Record a photo edit to an item AND log the before/after change for revert. */
export const applyPhotoChange = internalMutation({
  args: {
    runId: v.id("aiRuns"),
    itemId: v.id("eventItems"),
    storageId: v.id("_storage"),
  },
  handler: async (ctx, { runId, itemId, storageId }) => {
    const item = await ctx.db.get(itemId);
    if (!item) return;
    const before = item.fields?.photo;
    await ctx.db.patch(itemId, {
      fields: { ...(item.fields ?? {}), photo: storageId },
    });
    await ctx.db.insert("aiChanges", {
      runId,
      chapterId: item.chapterId,
      eventId: item.eventId,
      itemId,
      key: "photo",
      before,
      after: storageId,
    });
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
 * Undo every not-yet-reverted change of a run, in reverse insertion order. A
 * change is only restored if the item's current value still equals what the
 * agent set (`after`) — so manual edits made since aren't clobbered.
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
      const current = item?.fields?.[change.key];
      // Only restore if unchanged since the agent set it.
      if (item && current === change.after) {
        const fields = { ...(item.fields ?? {}) };
        if (change.before === undefined) delete fields[change.key];
        else fields[change.key] = change.before;
        await ctx.db.patch(change.itemId, { fields });
        await ctx.db.patch(change._id, { revertedAt: Date.now() });
        reverted++;
      } else {
        skipped++;
      }
    }

    await ctx.db.patch(runId, { status: "reverted" });
    return { reverted, skipped };
  },
});
