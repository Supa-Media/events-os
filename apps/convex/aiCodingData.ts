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
import { internal } from "./_generated/api";
import { requireChapterId, requireInChapter } from "./lib/context";
import { requireFinanceRole } from "./lib/finance";

/** ± window (7 days) around a charge used to pull the "week's calendar" events. */
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Cap on how many of each context list we hand the model — keeps reads bounded. */
const CONTEXT_LIMIT = 100;
/** Cap on calendar events in the window. */
const EVENT_LIMIT = 50;

/**
 * Sweep sizing (the hourly cron). `SWEEP_SCAN` newest transactions are examined;
 * of those, the unreviewed + unsuggested ones (up to `SWEEP_BATCH`) get a
 * suggestion scheduled. Both bounds keep the cron cheap and rate-limit how many
 * OpenRouter calls a single sweep can fan out.
 */
const SWEEP_SCAN = 200;
const SWEEP_BATCH = 25;

/**
 * Cooldown before the sweep retries a transaction whose last suggestion attempt
 * failed (OpenRouter errored/non-200'd, or its reply didn't parse). Without this,
 * a systematic outage would resubmit the same failing transactions every hourly
 * run forever. `aiSuggestion.failed` + `suggestedAt` (set unconditionally by
 * `writeSuggestion`) give the sweep a timestamp to cool down against.
 */
const FAILED_ATTEMPT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

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
  projects: v.array(
    v.object({
      _id: v.id("projects"),
      name: v.string(),
      status: v.string(),
    }),
  ),
});

/** The resolved context type both loaders return (matches the validator). */
type SuggestionContext = typeof suggestionContextValidator.type;

/**
 * Gather the coding context for one transaction: the chapter's funds and budget
 * categories, the projects it can attach to, and the events within a week of the
 * charge. Pure reads — the auth gate lives in the caller so the same body serves
 * both the human-triggered (`loadForSuggestion`) and system/cron-triggered
 * (`loadForSuggestionSystem`) paths.
 */
async function gatherSuggestionContext(
  ctx: QueryCtx,
  txn: Doc<"transactions">,
): Promise<SuggestionContext> {
  const chapterId = txn.chapterId;

  const funds = await ctx.db
    .query("funds")
    .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
    .take(CONTEXT_LIMIT);

  const categories = await ctx.db
    .query("budgetCategories")
    .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
    .take(CONTEXT_LIMIT);

  const projects = await ctx.db
    .query("projects")
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
    projects: projects.map((p) => ({
      _id: p._id,
      name: p.name,
      status: p.status,
    })),
  };
}

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
    // Manual invocation is bookkeeper+ only (in the txn's chapter).
    await requireFinanceRole(ctx, txn.chapterId, "bookkeeper");
    return await gatherSuggestionContext(ctx, txn);
  },
});

/**
 * The SYSTEM (no-auth) coding-context loader for cron/webhook-triggered
 * suggestions. Identical reads to `loadForSuggestion`, but WITHOUT the bookkeeper
 * gate — the daily sweep runs with no caller identity. It's internal-only, so the
 * only way to reach it is the trusted `suggestCodingSystem` action the sweep
 * schedules; the model still never moves money (it only writes `aiSuggestion`).
 */
export const loadForSuggestionSystem = internalQuery({
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
    return await gatherSuggestionContext(ctx, txn);
  },
});

/**
 * Hourly sweep (the cron trigger that makes AI auto-coding actually run). Scans
 * the newest `SWEEP_SCAN` transactions deployment-wide and, for each that is
 * still `unreviewed` and has NO `aiSuggestion` yet, schedules a system coding
 * suggestion (up to `SWEEP_BATCH` per run). Idempotent: a txn that already
 * carries a suggestion is skipped, so re-running never re-suggests or stacks.
 *
 * DEGRADE: when `OPENROUTER_API_KEY` is unset the whole feature is off — we log
 * and schedule nothing rather than fan out a batch of no-op actions. (The action
 * itself also degrades, so this is purely to avoid pointless scheduling.)
 */
export const sweepUnsuggestedTransactions = internalMutation({
  args: {},
  returns: v.object({ scheduled: v.number() }),
  handler: async (ctx) => {
    if (!process.env.OPENROUTER_API_KEY) {
      console.log(
        "[aiCoding] OPENROUTER_API_KEY unset — sweep scheduling nothing.",
      );
      return { scheduled: 0 };
    }

    // Newest-first across the deployment (default creation-time index). We only
    // ever look at the freshest window — old un-coded charges are the bookkeeper's
    // manual backlog, not something to keep re-scanning forever.
    const recent = await ctx.db
      .query("transactions")
      .order("desc")
      .take(SWEEP_SCAN);

    const now = Date.now();
    // Eligible: never attempted (no `aiSuggestion` at all), OR the last attempt
    // was a failed-attempt marker that's past the cooldown — anything else (a
    // real proposal, or a failure still within cooldown) is skipped.
    const isEligible = (tr: Doc<"transactions">): boolean => {
      if (tr.status !== "unreviewed") return false;
      const ai = tr.aiSuggestion;
      if (ai === undefined) return true;
      if (!ai.failed) return false;
      return now - (ai.suggestedAt ?? 0) > FAILED_ATTEMPT_COOLDOWN_MS;
    };

    const pending = recent.filter(isEligible).slice(0, SWEEP_BATCH);

    for (const tr of pending) {
      await ctx.scheduler.runAfter(
        0,
        internal.aiCoding.suggestCodingSystem,
        { transactionId: tr._id },
      );
    }
    return { scheduled: pending.length };
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
    // Set when this write is a failed-attempt marker (the OpenRouter call
    // errored/non-200'd, or its reply didn't parse) rather than a real
    // proposal — see `FAILED_ATTEMPT_COOLDOWN_MS` above.
    failed: v.optional(v.boolean()),
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
      failed: args.failed,
    };
    await ctx.db.patch(args.transactionId, { aiSuggestion });
    return null;
  },
});

/**
 * Apply a transaction's stored AI suggestion (a human confirming the model's
 * proposal). Bookkeeper+ only. Copies the suggestion's present links onto the
 * transaction and advances it to `categorized`. Throws when there's no
 * suggestion at all, when the suggestion carries no applicable links (so a
 * confidence/rationale-only suggestion never falsely marks a txn coded), or
 * when the transaction has already moved past `unreviewed` — a manual edit or
 * an earlier Accept means the stored suggestion is stale and must never
 * clobber whatever a human has since done. The suggestion is cleared once
 * applied, so accepting the same transaction twice is a no-op (the second
 * call hits `NO_SUGGESTION`, not a second overwrite). The model itself never
 * reaches this path.
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

    // The suggestion is only safe to apply while the txn is still exactly as
    // it was when the model looked at it. If a human already categorized it
    // (or already accepted this same suggestion once), the stored proposal is
    // stale — applying it now would silently clobber whatever they did.
    if (txn.status !== "unreviewed") {
      throw new ConvexError({
        code: "ALREADY_REVIEWED",
        message:
          "This transaction was already reviewed manually; the stored AI suggestion is stale and can no longer be accepted.",
      });
    }

    // Copy only the links the suggestion actually carries; leave the rest
    // alone. Each id was validated against the chapter at write time (see
    // `writeSuggestion`), but the referenced doc can vanish between then and
    // now (e.g. the WP-1.4 fund-merge migration deleting an extra fund) —
    // re-check existence here and skip a now-dangling id rather than writing
    // it onto the transaction.
    const patch: Partial<Doc<"transactions">> = {};
    if (suggestion.fundId !== undefined && (await ctx.db.get(suggestion.fundId)))
      patch.fundId = suggestion.fundId;
    if (
      suggestion.categoryId !== undefined &&
      (await ctx.db.get(suggestion.categoryId))
    )
      patch.categoryId = suggestion.categoryId;
    if (
      suggestion.projectId !== undefined &&
      (await ctx.db.get(suggestion.projectId))
    )
      patch.projectId = suggestion.projectId;
    if (
      suggestion.eventId !== undefined &&
      (await ctx.db.get(suggestion.eventId))
    )
      patch.eventId = suggestion.eventId;

    // A suggestion of only confidence/rationale (no links) has nothing to apply
    // — never mark a transaction "categorized" when no coding was actually set.
    if (Object.keys(patch).length === 0) {
      throw new ConvexError({
        code: "EMPTY_SUGGESTION",
        message: "This suggestion has nothing to apply.",
      });
    }

    patch.status = "categorized";
    // Clear the stored suggestion now that it's applied — an explicit
    // `undefined` unsets the field (mirrors `cleanPatch` in finances.ts).
    // Without this, accepting the same transaction again (or a later manual
    // edit racing this one) could re-copy the same stale links.
    patch.aiSuggestion = undefined;
    await ctx.db.patch(args.transactionId, patch);
    return null;
  },
});
