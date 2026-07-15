/**
 * AI auto-coding — the DATA side (default Convex runtime, NO "use node").
 *
 * The `suggestCoding` action in `aiCoding.ts` runs the LLM in the Node runtime,
 * which has no `ctx.db`. This file holds the database halves it calls across the
 * runtime boundary:
 *
 *  - `loadForSuggestion` (internalQuery) — gather the coding context for one
 *    transaction: the transaction itself plus its chapter's funds/categories and
 *    the events around the charge's date (the "week's calendar" the model reasons
 *    over). No auth — internal, called only by the action.
 *  - `writeSuggestion` (internalMutation) — persist the model's PROPOSAL onto
 *    `transactions.aiSuggestion`. Every proposed id is re-validated to belong to
 *    the transaction's chapter before it's written. The model NEVER moves money.
 *  - `acceptSuggestion` (PUBLIC mutation) — a human (bookkeeper+) applies a stored
 *    suggestion: its present links are copied onto the transaction and the status
 *    advances to `categorized`. This is the only place a suggestion touches the
 *    real categorization.
 *
 * Convention (mirrors `finances.ts`): every client-supplied id is verified to
 * live in the caller's chapter; failures throw `ConvexError`; reads are bounded.
 */
import { internalQuery, internalMutation, mutation } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { Doc, Id } from "./_generated/dataModel";
import { requireChapterId, requireInChapter } from "./lib/context";
import { requireFinanceRole } from "./lib/finance";

/** ± window (7 days) around a charge used to pull the "week's calendar" events. */
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Cap on how many of each context list we hand the model — keeps reads bounded. */
const CONTEXT_LIMIT = 100;
/** Cap on calendar events in the window. */
const EVENT_LIMIT = 50;

/** The shape the action reasons over. Ids are strings on the wire. */
const suggestionContextValidator = v.object({
  transaction: v.object({
    _id: v.id("transactions"),
    chapterId: v.id("chapters"),
    amountCents: v.number(),
    flow: v.string(),
    postedAt: v.number(),
    merchantName: v.optional(v.string()),
    merchantCategory: v.optional(v.string()),
    description: v.optional(v.string()),
  }),
  funds: v.array(
    v.object({
      _id: v.id("funds"),
      name: v.string(),
      restriction: v.string(),
    }),
  ),
  categories: v.array(
    v.object({
      _id: v.id("budgetCategories"),
      name: v.string(),
      fundId: v.id("funds"),
      kind: v.string(),
    }),
  ),
  events: v.array(
    v.object({
      _id: v.id("events"),
      name: v.string(),
      eventDate: v.number(),
    }),
  ),
});

/**
 * Load one transaction plus the coding context for it: the chapter's funds and
 * budget categories, and the events within a week of the charge. Throws if the
 * transaction doesn't exist.
 *
 * This is ALSO the auth gate for the manual `suggestCoding` action: the caller
 * must hold at least the `bookkeeper` finance role in the transaction's chapter.
 * Gating here (rather than in the action) means the action and the gate share a
 * single chapter resolution — an internalQuery still carries the invoking
 * caller's identity through `ctx.runQuery`. A later phase can add a separate
 * internalAction path for system/webhook-triggered suggestions that skips this.
 */
export const loadForSuggestion = internalQuery({
  args: { transactionId: v.id("transactions") },
  returns: suggestionContextValidator,
  handler: async (ctx, args) => {
    const txn = await ctx.db.get(args.transactionId);
    if (!txn) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Transaction not found.",
      });
    }
    const chapterId = txn.chapterId;
    // Manual invocation is bookkeeper+ only (in the txn's chapter).
    await requireFinanceRole(ctx, chapterId, "bookkeeper");

    const funds = await ctx.db
      .query("funds")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
      .take(CONTEXT_LIMIT);

    const categories = await ctx.db
      .query("budgetCategories")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
      .take(CONTEXT_LIMIT);

    const events = await ctx.db
      .query("events")
      .withIndex("by_chapter_date", (q) =>
        q
          .eq("chapterId", chapterId)
          .gte("eventDate", txn.postedAt - WEEK_MS)
          .lte("eventDate", txn.postedAt + WEEK_MS),
      )
      .take(EVENT_LIMIT);

    return {
      transaction: {
        _id: txn._id,
        chapterId: txn.chapterId,
        amountCents: txn.amountCents,
        flow: txn.flow,
        postedAt: txn.postedAt,
        merchantName: txn.merchantName,
        merchantCategory: txn.merchantCategory,
        description: txn.description,
      },
      funds: funds.map((f) => ({
        _id: f._id,
        name: f.name,
        restriction: f.restriction,
      })),
      categories: categories.map((c) => ({
        _id: c._id,
        name: c.name,
        fundId: c.fundId,
        kind: c.kind,
      })),
      events: events.map((e) => ({
        _id: e._id,
        name: e.name,
        eventDate: e.eventDate,
      })),
    };
  },
});

/**
 * Assert a proposed link id exists AND belongs to `chapterId`. The action already
 * filters ids against the loaded context, but a suggestion write must never trust
 * that — an id from another chapter is a hard error, not a silent write.
 */
async function assertLinkInChapter<
  T extends "funds" | "budgetCategories" | "projects" | "events",
>(
  ctx: MutationCtx | QueryCtx,
  chapterId: Id<"chapters">,
  table: T,
  id: Id<T>,
  label: string,
): Promise<void> {
  const doc = (await ctx.db.get(id)) as { chapterId?: Id<"chapters"> } | null;
  if (!doc || doc.chapterId !== chapterId) {
    throw new ConvexError({
      code: "NOT_FOUND",
      message: `${label} not found in this chapter.`,
    });
  }
}

/**
 * Persist the model's proposal onto `transactions.aiSuggestion`. Only the fields
 * the model actually proposed are stored; each proposed id is re-validated to
 * belong to the transaction's chapter. Never patches money, links, or status.
 */
export const writeSuggestion = internalMutation({
  args: {
    transactionId: v.id("transactions"),
    fundId: v.optional(v.id("funds")),
    categoryId: v.optional(v.id("budgetCategories")),
    projectId: v.optional(v.id("projects")),
    eventId: v.optional(v.id("events")),
    confidence: v.optional(v.number()),
    rationale: v.optional(v.string()),
    model: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const txn = await ctx.db.get(args.transactionId);
    if (!txn) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Transaction not found.",
      });
    }
    const chapterId = txn.chapterId;

    if (args.fundId)
      await assertLinkInChapter(ctx, chapterId, "funds", args.fundId, "Fund");
    if (args.categoryId)
      await assertLinkInChapter(
        ctx,
        chapterId,
        "budgetCategories",
        args.categoryId,
        "Category",
      );
    if (args.projectId)
      await assertLinkInChapter(
        ctx,
        chapterId,
        "projects",
        args.projectId,
        "Project",
      );
    if (args.eventId)
      await assertLinkInChapter(ctx, chapterId, "events", args.eventId, "Event");

    const aiSuggestion: Doc<"transactions">["aiSuggestion"] = {
      fundId: args.fundId,
      categoryId: args.categoryId,
      projectId: args.projectId,
      eventId: args.eventId,
      confidence: args.confidence,
      rationale: args.rationale,
      model: args.model,
      suggestedAt: Date.now(),
    };
    await ctx.db.patch(args.transactionId, { aiSuggestion });
    return null;
  },
});

/**
 * Apply a transaction's stored AI suggestion (a human confirming the model's
 * proposal). Bookkeeper+ only. Copies the suggestion's present links onto the
 * transaction and advances it to `categorized`. Throws when there's no
 * suggestion to apply. The model itself never reaches this path.
 */
export const acceptSuggestion = mutation({
  args: { transactionId: v.id("transactions") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireFinanceRole(ctx, chapterId, "bookkeeper");

    const txn = await ctx.db.get(args.transactionId);
    await requireInChapter(
      ctx,
      chapterId,
      txn as { chapterId?: string } | null,
      "Transaction",
    );
    // requireInChapter throws when txn is null; the guard narrows for TS.
    if (!txn) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Transaction not found in your chapter.",
      });
    }

    const suggestion = txn.aiSuggestion;
    if (!suggestion) {
      throw new ConvexError({
        code: "NO_SUGGESTION",
        message: "This transaction has no AI suggestion to accept.",
      });
    }

    // Copy only the links the suggestion actually carries; leave the rest alone.
    const patch: Partial<Doc<"transactions">> = { status: "categorized" };
    if (suggestion.fundId !== undefined) patch.fundId = suggestion.fundId;
    if (suggestion.categoryId !== undefined)
      patch.categoryId = suggestion.categoryId;
    if (suggestion.projectId !== undefined)
      patch.projectId = suggestion.projectId;
    if (suggestion.eventId !== undefined) patch.eventId = suggestion.eventId;

    await ctx.db.patch(args.transactionId, patch);
    return null;
  },
});
