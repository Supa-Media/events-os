/**
 * AI auto-coding — the DATA side (default Convex runtime, NO "use node").
 *
 * The `suggestCoding` action in `aiCoding.ts` runs the LLM in the Node runtime,
 * which has no `ctx.db`. This file holds the database halves it calls across the
 * runtime boundary:
 *
 *  - `loadForSuggestion` (internalQuery) — gather the coding context for one
 *    transaction: the transaction itself plus its chapter's funds/categories,
 *    the events and projects RANKED by proximity to the charge's date (R2 —
 *    nearest-first, not a flat list), and — when the txn has a cardholder
 *    (`personId` directly, or via `cardId` → `cards.cardholderPersonId`) —
 *    that person's own roster info plus the events/projects THEY'RE
 *    associated with. No auth — internal, called only by the action.
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
import { CENTRAL } from "@events-os/shared";

/** Cap on how many of each context list we hand the model — keeps reads bounded. */
const CONTEXT_LIMIT = 100;
/**
 * Cap on calendar events considered: this many are scanned on EACH side
 * (before, after) of the charge's `postedAt` via the `by_chapter_date` index,
 * then the merged set is ranked by proximity and cut back down to this same
 * count (R2 — see `sortByProximity`). No hard day-window: a plausible match
 * 200 days out still surfaces, just ranked behind anything closer in time.
 */
const EVENT_LIMIT = 50;
/**
 * Cap on a cardholder's OWN associated events/projects (R2). Kept small —
 * this is color that helps the model weigh a match to the person, not a
 * primary candidate list, so it doesn't need `CONTEXT_LIMIT`'s headroom.
 */
const PERSON_LINK_LIMIT = 20;

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
  // The cardholder (R2): resolved from `transaction.personId`, else via
  // `transaction.cardId` → `cards.cardholderPersonId`. Absent when the txn
  // carries neither (e.g. a synced feed txn nobody's claimed yet).
  person: v.optional(
    v.object({
      _id: v.id("people"),
      name: v.string(),
      role: v.optional(v.string()),
      isTeamMember: v.optional(v.boolean()),
      // This person's OWN events/projects — from `engagements` (volunteer/paid),
      // `roleAssignments`, and events/projects they OWN (`ownerPersonId`).
      // Ranked nearest-`postedAt`-first, same as the chapter-wide lists.
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
    }),
  ),
});

/** The resolved context type both loaders return (matches the validator). */
type SuggestionContext = typeof suggestionContextValidator.type;

/**
 * Sort candidates NEAREST-`postedAt`-FIRST (R2), so a flat chapter-wide list
 * becomes one the model can trust to read top-down. `getTimestamp` may return
 * `undefined` (e.g. a project with no date fields at all) — those sort last,
 * after every dated candidate, in their original relative order.
 */
function sortByProximity<T>(
  items: T[],
  postedAt: number,
  getTimestamp: (item: T) => number | undefined,
): T[] {
  return [...items].sort((a, b) => {
    const da = getTimestamp(a);
    const db = getTimestamp(b);
    if (da === undefined && db === undefined) return 0;
    if (da === undefined) return 1;
    if (db === undefined) return -1;
    return Math.abs(da - postedAt) - Math.abs(db - postedAt);
  });
}

/** A project's own closest date to weigh proximity by: the nearer of its
 *  `startDate`/`deadline` to `postedAt`, or `undefined` if it has neither. */
function projectProximityTimestamp(
  project: Doc<"projects">,
  postedAt: number,
): number | undefined {
  const candidates = [project.startDate, project.deadline].filter(
    (d): d is number => d !== undefined,
  );
  if (candidates.length === 0) return undefined;
  return candidates.reduce((closest, d) =>
    Math.abs(d - postedAt) < Math.abs(closest - postedAt) ? d : closest,
  );
}

/** Dedup a list of docs by `_id`, keeping the first occurrence. */
function dedupeById<T extends { _id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const key = String(item._id);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/**
 * Resolve the transaction's cardholder: `personId` directly when set, else
 * (R2) the card's own `cardholderPersonId` via `transaction.cardId`. Returns
 * `undefined` when neither is set, or the referenced card is missing/foreign
 * (defense in depth — never trust a cross-chapter card).
 */
async function resolveCardholderPersonId(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
  txn: Doc<"transactions">,
): Promise<Id<"people"> | undefined> {
  if (txn.personId) return txn.personId;
  if (!txn.cardId) return undefined;
  const card = await ctx.db.get(txn.cardId);
  if (!card || card.chapterId !== chapterId) return undefined;
  return card.cardholderPersonId;
}

/**
 * The cardholder's OWN associated events/projects (R2) — grounded in the
 * linking tables that actually exist:
 *  - `engagements` (volunteer/paid involvement in an event) and
 *    `roleAssignments` (a rostered role on an event), both indexed `by_person`.
 *  - Events/projects this person OWNS (`events`/`projects.ownerPersonId`).
 * NOT included (no cheap/real link exists): `eventItems.ownerPersonId` (item-
 * level ownership has no `by_person` index — a chapter-wide scan to find it
 * would blow past `CONTEXT_LIMIT` for a "nice to have"), and `people.projects`
 * (a free-text label array — "Eden", "Love Thy Neighbor" — not `Id<"projects">`
 * references, so it can't be resolved to real project docs).
 */
async function resolvePersonContext(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
  personId: Id<"people">,
  postedAt: number,
): Promise<SuggestionContext["person"]> {
  const person = await ctx.db.get(personId);
  if (!person || person.chapterId !== chapterId) return undefined;

  const [engagements, roleAssignments, ownedEvents, ownedProjects] =
    await Promise.all([
      ctx.db
        .query("engagements")
        .withIndex("by_person", (q) => q.eq("personId", personId))
        .take(PERSON_LINK_LIMIT),
      ctx.db
        .query("roleAssignments")
        .withIndex("by_person", (q) => q.eq("personId", personId))
        .take(PERSON_LINK_LIMIT),
      ctx.db
        .query("events")
        .withIndex("by_chapter_and_ownerPersonId", (q) =>
          q.eq("chapterId", chapterId).eq("ownerPersonId", personId),
        )
        .take(PERSON_LINK_LIMIT),
      ctx.db
        .query("projects")
        .withIndex("by_owner", (q) => q.eq("ownerPersonId", personId))
        .take(PERSON_LINK_LIMIT),
    ]);

  const linkedEventIds = dedupeById(
    [...engagements, ...roleAssignments].map((r) => ({ _id: r.eventId })),
  ).map((r) => r._id);
  const linkedEvents = (
    await Promise.all(linkedEventIds.map((id) => ctx.db.get(id)))
  ).filter((e): e is Doc<"events"> => e !== null && e.chapterId === chapterId);

  const events = sortByProximity(
    dedupeById([...ownedEvents, ...linkedEvents]),
    postedAt,
    (e) => e.eventDate,
  ).slice(0, PERSON_LINK_LIMIT);

  const projects = sortByProximity(
    dedupeById(ownedProjects.filter((p) => p.chapterId === chapterId)),
    postedAt,
    (p) => projectProximityTimestamp(p, postedAt),
  ).slice(0, PERSON_LINK_LIMIT);

  return {
    _id: person._id,
    name: person.name,
    role: person.role,
    isTeamMember: person.isTeamMember,
    events: events.map((e) => ({ _id: e._id, name: e.name, eventDate: e.eventDate })),
    projects: projects.map((p) => ({ _id: p._id, name: p.name, status: p.status })),
  };
}

/**
 * Gather the coding context for one transaction: the chapter's funds and
 * budget categories, the events/projects it can attach to (R2 — ranked
 * nearest-`postedAt`-first, not a flat list), and — when there's a resolvable
 * cardholder — their own roster info + associated events/projects. Pure
 * reads — the auth gate lives in the caller so the same body serves both the
 * human-triggered (`loadForSuggestion`) and system/cron-triggered
 * (`loadForSuggestionSystem`) paths.
 */
async function gatherSuggestionContext(
  ctx: QueryCtx,
  txn: Doc<"transactions">,
  // The txn's REAL chapter (WP-2.1): the loaders reject central-owned txns
  // before calling this — auto-coding is chapter-only (no central funds/
  // categories/projects/events), so a `Id<"chapters">` is passed after that
  // guard has narrowed the sentinel out. The context reads + the returned
  // `transaction.chapterId` (validated as `v.id("chapters")`) use it.
  chapterId: Id<"chapters">,
): Promise<SuggestionContext> {
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

  // R2: rank chapter events by proximity to the charge instead of a flat,
  // fixed-window list. Scan `EVENT_LIMIT` on each side of `postedAt` via the
  // date index (bounded reads, same spirit as `CONTEXT_LIMIT`), merge, then
  // sort by |eventDate - postedAt| and cut back to `EVENT_LIMIT` — so an
  // event 3 days out always outranks one 200 days out, without a hard cutoff
  // that would hide it entirely.
  const [eventsOnOrAfter, eventsBefore] = await Promise.all([
    ctx.db
      .query("events")
      .withIndex("by_chapter_date", (q) =>
        q.eq("chapterId", chapterId).gte("eventDate", txn.postedAt),
      )
      .order("asc")
      .take(EVENT_LIMIT),
    ctx.db
      .query("events")
      .withIndex("by_chapter_date", (q) =>
        q.eq("chapterId", chapterId).lt("eventDate", txn.postedAt),
      )
      .order("desc")
      .take(EVENT_LIMIT),
  ]);
  const events = sortByProximity(
    [...eventsOnOrAfter, ...eventsBefore],
    txn.postedAt,
    (e) => e.eventDate,
  ).slice(0, EVENT_LIMIT);

  // Same ranking for projects, off whichever of `startDate`/`deadline` is
  // closer; projects with neither date sort last (no query-level date index
  // exists for projects, so this ranks the already-bounded `CONTEXT_LIMIT`
  // chapter-wide fetch above rather than requiring a second read).
  const rankedProjects = sortByProximity(projects, txn.postedAt, (p) =>
    projectProximityTimestamp(p, txn.postedAt),
  );

  const personId = await resolveCardholderPersonId(ctx, chapterId, txn);
  const person = personId
    ? await resolvePersonContext(ctx, chapterId, personId, txn.postedAt)
    : undefined;

  return {
    transaction: {
      _id: txn._id,
      chapterId,
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
    projects: rankedProjects.map((p) => ({
      _id: p._id,
      name: p.name,
      status: p.status,
    })),
    person,
  };
}

/**
 * Load one transaction plus the coding context for it: the chapter's funds,
 * budget categories, and events/projects ranked by proximity to the charge's
 * date, plus the cardholder's own roster info + associations (R2 — see
 * `gatherSuggestionContext`). Throws if the transaction doesn't exist.
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
    // Central-owned txns (WP-2.1) aren't auto-coded: central has no funds/
    // categories/projects/events for the model to reason over. Reject before
    // the chapter gate (this also narrows the sentinel out of `chapterId`).
    if (txn.chapterId === CENTRAL) {
      throw new ConvexError({
        code: "UNSUPPORTED",
        message: "Central transactions aren't auto-coded.",
      });
    }
    // Manual invocation is bookkeeper+ only (in the txn's chapter).
    await requireFinanceRole(ctx, txn.chapterId, "bookkeeper");
    return await gatherSuggestionContext(ctx, txn, txn.chapterId);
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
    // Central-owned txns aren't auto-coded (see `loadForSuggestion`); the sweep
    // already skips them, this is the defense-in-depth guard + type narrowing.
    if (txn.chapterId === CENTRAL) {
      throw new ConvexError({
        code: "UNSUPPORTED",
        message: "Central transactions aren't auto-coded.",
      });
    }
    return await gatherSuggestionContext(ctx, txn, txn.chapterId);
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
      // Central-owned txns (WP-2.1) aren't auto-coded — central has no funds/
      // categories/projects/events context. Skip them (the loaders reject them
      // too, this avoids scheduling a doomed suggestion action).
      if (tr.chapterId === CENTRAL) return false;
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
    // Central-owned txns are never auto-coded (the loaders + sweep skip them),
    // so a suggestion should never target one — reject + narrow the sentinel out.
    if (txn.chapterId === CENTRAL) {
      throw new ConvexError({
        code: "UNSUPPORTED",
        message: "Central transactions aren't auto-coded.",
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
