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
 * THREE TRIGGERS feed the same `suggestCodingSystem`/`suggestCoding` core
 * (`aiCoding.ts`'s `codeTransaction`), all funneling through
 * `runSuggestionSweep` or `loadForSuggestion` below:
 *  - on-ingest (PRIMARY) — `scheduleSuggestionOnIngest`, called from
 *    `increase.applyIncreaseCardTransaction` and
 *    `finances.createManualTransaction` right after a new transaction is
 *    inserted, debounces into `ingestSuggestionSweep` within seconds.
 *  - hourly cron (BACKSTOP) — `sweepUnsuggestedTransactions`, mops up
 *    anything ingest's batch cap left behind.
 *  - on-demand (MANUAL) — a bookkeeper taps "Suggest" in Reconcile on a row
 *    that still has none; calls the public `suggestCoding` action directly.
 *
 * Convention (mirrors `finances.ts`): every client-supplied id is verified to
 * live in the caller's chapter; failures throw `ConvexError`; reads are bounded.
 */
import {
  internalQuery,
  internalMutation,
  mutation,
  query,
} from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { requireChapterId, requireInChapter } from "./lib/context";
import { requireFinanceRole, requireCentralEdOrFm } from "./lib/finance";
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
 * Sweep sizing — shared by BOTH triggers that run `runSuggestionSweep` (the
 * hourly cron backstop and the debounced on-ingest sweep, see below):
 * `SWEEP_SCAN` newest transactions are examined; of those, the unreviewed +
 * unsuggested ones (up to `SWEEP_BATCH`) get a suggestion scheduled. Both
 * bounds keep a sweep cheap and rate-limit how many OpenRouter calls a single
 * run can fan out — the on-ingest debounce (below) is what keeps a burst of
 * arrivals from turning into a burst of SWEEPS, so reusing these same caps
 * for it rather than inventing a smaller pair keeps there being exactly one
 * throttle to reason about.
 */
const SWEEP_SCAN = 200;
const SWEEP_BATCH = 25;

/**
 * Delay before the debounced on-ingest sweep actually runs (see
 * `scheduleSuggestionOnIngest` / `ingestSuggestionSweep` below) — batches a
 * burst of near-simultaneous transaction arrivals (several webhook
 * redeliveries, a bookkeeper bulk-adding manual entries) into ONE sweep call
 * instead of one per arrival. Long enough to catch a realistic burst window;
 * short enough that "suggestions on arrival" still reads as immediate next
 * to the old hourly-only cron.
 */
const INGEST_SWEEP_DELAY_MS = 10_000;

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
      // WP-U (one home per dollar): the event's one_time budget, when it has
      // one — `null` marks a budget-less event the model must NOT propose (it
      // has nowhere to attach yet; only a human picking it in the "For"
      // picker summons its budget).
      budgetId: v.union(v.id("budgets"), v.null()),
    }),
  ),
  projects: v.array(
    v.object({
      _id: v.id("projects"),
      name: v.string(),
      status: v.string(),
      budgetId: v.union(v.id("budgets"), v.null()),
    }),
  ),
  // The cardholder (R2): resolved from `transaction.personId`, else via
  // `transaction.cardId` → `cards.cardholderPersonId`. Absent when the txn
  // carries neither (e.g. a synced feed txn nobody's claimed yet).
  person: v.optional(
    v.object({
      _id: v.id("people"),
      // NOT `name` — deliberately dropped (PII minimization, see aiCoding.ts)
      // since nothing downstream (prompt or UI) reads it off this context.
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
          budgetId: v.union(v.id("budgets"), v.null()),
        }),
      ),
      projects: v.array(
        v.object({
          _id: v.id("projects"),
          name: v.string(),
          status: v.string(),
          budgetId: v.union(v.id("budgets"), v.null()),
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
/**
 * The chapter's one_time event/project budgets, keyed by `scopeRefId` (WP-U:
 * one home per dollar) — a SINGLE bounded scan (mirrors `finances.
 * forPickerOptions`'s approach) so every event/project in the context can be
 * annotated with its `budgetId` without an N+1 `by_ref` lookup per row. Scoped
 * to the chapter's OWN budgets only — a project whose budget has since moved
 * to central (`transferProjectScope`) is out of scope for AI auto-coding, same
 * as central funds/categories are (auto-coding is chapter-only).
 */
async function loadRefBudgetMaps(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
): Promise<{
  eventBudgetByRef: Map<string, Id<"budgets">>;
  projectBudgetByRef: Map<string, Id<"budgets">>;
}> {
  const budgets = await ctx.db
    .query("budgets")
    .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
    .take(CONTEXT_LIMIT);
  const eventBudgetByRef = new Map<string, Id<"budgets">>();
  const projectBudgetByRef = new Map<string, Id<"budgets">>();
  for (const b of budgets) {
    if (b.type !== "one_time" || !b.scopeRefId) continue;
    if (b.refKind === "event") eventBudgetByRef.set(b.scopeRefId, b._id);
    else if (b.refKind === "project") projectBudgetByRef.set(b.scopeRefId, b._id);
  }
  return { eventBudgetByRef, projectBudgetByRef };
}

async function resolvePersonContext(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
  personId: Id<"people">,
  postedAt: number,
  eventBudgetByRef: Map<string, Id<"budgets">>,
  projectBudgetByRef: Map<string, Id<"budgets">>,
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
    role: person.role,
    isTeamMember: person.isTeamMember,
    events: events.map((e) => ({
      _id: e._id,
      name: e.name,
      eventDate: e.eventDate,
      budgetId: eventBudgetByRef.get(e._id as string) ?? null,
    })),
    projects: projects.map((p) => ({
      _id: p._id,
      name: p.name,
      status: p.status,
      budgetId: projectBudgetByRef.get(p._id as string) ?? null,
    })),
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

  const { eventBudgetByRef, projectBudgetByRef } = await loadRefBudgetMaps(ctx, chapterId);

  const personId = await resolveCardholderPersonId(ctx, chapterId, txn);
  const person = personId
    ? await resolvePersonContext(
        ctx,
        chapterId,
        personId,
        txn.postedAt,
        eventBudgetByRef,
        projectBudgetByRef,
      )
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
      budgetId: eventBudgetByRef.get(e._id as string) ?? null,
    })),
    projects: rankedProjects.map((p) => ({
      _id: p._id,
      name: p.name,
      status: p.status,
      budgetId: projectBudgetByRef.get(p._id as string) ?? null,
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
 * True when a transaction is a candidate for an AI coding suggestion: still
 * `unreviewed`, chapter-owned (central txns are never auto-coded — central
 * has no funds/categories/projects/events context, same reason the loaders
 * above reject them), and either never attempted (no `aiSuggestion` at all)
 * or its last attempt was a failed-attempt marker that's past
 * `FAILED_ATTEMPT_COOLDOWN_MS`. Shared by BOTH triggers that call
 * `runSuggestionSweep` (the hourly cron and the debounced on-ingest sweep)
 * AND the on-ingest hook itself (`scheduleSuggestionOnIngest`), so all three
 * apply the exact same "who's eligible" rule.
 */
function isEligibleForSuggestion(tr: Doc<"transactions">, now: number): boolean {
  if (tr.status !== "unreviewed") return false;
  if (tr.chapterId === CENTRAL) return false;
  const ai = tr.aiSuggestion;
  if (ai === undefined) return true;
  if (!ai.failed) return false;
  return now - (ai.suggestedAt ?? 0) > FAILED_ATTEMPT_COOLDOWN_MS;
}

/**
 * Shared batch core for BOTH triggers that make AI auto-coding actually run:
 * the hourly cron (`sweepUnsuggestedTransactions`, now mostly a quiet
 * backstop since ingest covers new arrivals) and the debounced on-ingest
 * sweep (`ingestSuggestionSweep`, scheduled by `scheduleSuggestionOnIngest`
 * soon after a new transaction lands). Scans the newest `SWEEP_SCAN`
 * transactions deployment-wide and, for each still-eligible one
 * (`isEligibleForSuggestion`), schedules a system coding suggestion — up to
 * `SWEEP_BATCH` per run. Idempotent: a txn that already carries a suggestion
 * is skipped, so re-running (from either trigger) never re-suggests or
 * stacks. `triggeredBy` is threaded through to `suggestCodingSystem` purely
 * for the `aiUsageEvents` audit trail — the eligibility rule and model-call
 * cap are IDENTICAL for both triggers, only the label differs.
 *
 * DEGRADE: when `OPENROUTER_API_KEY` is unset the whole feature is off — we log
 * and schedule nothing rather than fan out a batch of no-op actions. (The action
 * itself also degrades, so this is purely to avoid pointless scheduling.)
 */
async function runSuggestionSweep(
  ctx: MutationCtx,
  triggeredBy: "sweep" | "ingest",
): Promise<{ scheduled: number }> {
  if (!process.env.OPENROUTER_API_KEY) {
    console.log(
      `[aiCoding] OPENROUTER_API_KEY unset — ${triggeredBy} sweep scheduling nothing.`,
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
  const pending = recent
    .filter((tr) => isEligibleForSuggestion(tr, now))
    .slice(0, SWEEP_BATCH);

  for (const tr of pending) {
    await ctx.scheduler.runAfter(0, internal.aiCoding.suggestCodingSystem, {
      transactionId: tr._id,
      triggeredBy,
    });
  }
  return { scheduled: pending.length };
}

/**
 * Hourly cron trigger (see `crons.ts`'s "ai auto-coding sweep"). Now mostly a
 * quiet BACKSTOP: `scheduleSuggestionOnIngest` (below) covers newly-arriving
 * transactions within seconds, so by the time this runs there's usually
 * nothing left — it only finds something when ingest's own `SWEEP_BATCH` cap
 * was exceeded by a large burst, or a transaction predates this feature.
 */
export const sweepUnsuggestedTransactions = internalMutation({
  args: {},
  returns: v.object({ scheduled: v.number() }),
  handler: async (ctx) => runSuggestionSweep(ctx, "sweep"),
});

/**
 * ON-INGEST HOOK — call from a transaction-creating mutation (the Increase
 * webhook apply path, `increase.applyIncreaseCardTransaction`; the manual-add
 * path, `finances.createManualTransaction`) with the just-inserted doc, in
 * the SAME transaction as the insert. No-ops for anything the sweep would
 * skip anyway (central-owned, or already categorized on entry — e.g. a
 * manual entry submitted with a category/budget already picked), so those
 * never wake the debounce for nothing.
 *
 * DEGRADE EARLY (mirrors `runSuggestionSweep`'s own key check): when
 * `OPENROUTER_API_KEY` is unset the whole feature is off, so this returns
 * before touching the debounce mutex or scheduling anything — there's no
 * point waking a sweep that would just no-op `INGEST_SWEEP_DELAY_MS` later
 * anyway. This also means the many existing tests for the two ingest paths
 * above (which don't set the key) never acquire a scheduled function to
 * drain — only tests that specifically exercise AI coding do, and they set
 * the key deliberately.
 */
export async function scheduleSuggestionOnIngest(
  ctx: MutationCtx,
  txn: Doc<"transactions">,
): Promise<void> {
  if (!process.env.OPENROUTER_API_KEY) return;
  if (!isEligibleForSuggestion(txn, Date.now())) return;
  await scheduleIngestSweep(ctx);
}

/**
 * Debounce: schedule `ingestSuggestionSweep` at most once per
 * `INGEST_SWEEP_DELAY_MS` window, via the single-row `aiCodingIngestState`
 * mutex (see its schema doc comment). Concurrent ingest mutations racing this
 * read-then-write are safe — Convex's OCC serializes writes to the same
 * document, so a losing mutation retries, re-reads `pending: true` (already
 * flipped by the winner), and no-ops instead of scheduling a second sweep.
 * This is what turns "N transactions land in a burst" into ONE batched sweep
 * call (itself still capped at `SWEEP_BATCH` model calls via
 * `runSuggestionSweep`) instead of N parallel OpenRouter calls.
 */
async function scheduleIngestSweep(ctx: MutationCtx): Promise<void> {
  const state = await ctx.db.query("aiCodingIngestState").first();
  if (state?.pending) return; // already scheduled — it'll pick this txn up too
  if (state) {
    await ctx.db.patch(state._id, { pending: true, scheduledAt: Date.now() });
  } else {
    await ctx.db.insert("aiCodingIngestState", {
      pending: true,
      scheduledAt: Date.now(),
    });
  }
  await ctx.scheduler.runAfter(
    INGEST_SWEEP_DELAY_MS,
    internal.aiCodingData.ingestSuggestionSweep,
    {},
  );
}

/**
 * The debounced on-ingest sweep itself — fires `INGEST_SWEEP_DELAY_MS` after
 * `scheduleIngestSweep` first schedules it. Clears the mutex BEFORE scanning
 * (not after) so a transaction that lands concurrently with this run — after
 * the scan already started — schedules a FRESH follow-up sweep rather than
 * silently falling into a gap between "this run's scan" and "the mutex
 * clearing". Delegates to the same `runSuggestionSweep` core the hourly cron
 * uses, labelled `"ingest"` for the audit trail.
 */
export const ingestSuggestionSweep = internalMutation({
  args: {},
  returns: v.object({ scheduled: v.number() }),
  handler: async (ctx) => {
    const state = await ctx.db.query("aiCodingIngestState").first();
    if (state) await ctx.db.patch(state._id, { pending: false });
    return await runSuggestionSweep(ctx, "ingest");
  },
});

/**
 * Assert a proposed link id exists AND belongs to `chapterId`. The action already
 * filters ids against the loaded context, but a suggestion write must never trust
 * that — an id from another chapter is a hard error, not a silent write.
 */
async function assertLinkInChapter<
  T extends "funds" | "budgetCategories" | "budgets",
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
    // WP-U (one home per dollar): the model proposes a BUDGET directly — the
    // old separate `projectId`/`eventId` args are gone. `writeSuggestion`
    // never invents a budget; it only ever echoes back a `budgetId` the
    // context already exposed (an event/project WITH a budget — see
    // `aiCoding.ts`'s sanitize step), so this never summons one.
    budgetId: v.optional(v.id("budgets")),
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
    if (args.budgetId)
      await assertLinkInChapter(ctx, chapterId, "budgets", args.budgetId, "Budget");

    const aiSuggestion: Doc<"transactions">["aiSuggestion"] = {
      fundId: args.fundId,
      categoryId: args.categoryId,
      budgetId: args.budgetId,
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
    // it onto the transaction. WP-U: `budgetId` is the ONLY link the
    // suggestion carries now (subsumes the old separate project/event link).
    const patch: Partial<Doc<"transactions">> = {};
    if (suggestion.fundId !== undefined && (await ctx.db.get(suggestion.fundId)))
      patch.fundId = suggestion.fundId;
    if (
      suggestion.categoryId !== undefined &&
      (await ctx.db.get(suggestion.categoryId))
    )
      patch.categoryId = suggestion.categoryId;
    if (
      suggestion.budgetId !== undefined &&
      (await ctx.db.get(suggestion.budgetId))
    )
      patch.budgetId = suggestion.budgetId;

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
    // Best-effort audit-trail backfill: mark the latest aiUsageEvents row for
    // this transaction as accepted, so the "AI usage" section can show an
    // accept rate. A missing usage event (e.g. a suggestion seeded directly
    // in a test, or written before this audit trail existed) is fine — the
    // accept itself still succeeds either way.
    await backfillUsageEventAccepted(ctx, args.transactionId);
    return null;
  },
});

/**
 * Mark the latest `aiUsageEvents` row for `transactionId` as accepted (see
 * `acceptSuggestion` above). "Latest" because a transaction can accumulate
 * more than one attempt (a failed sweep run followed by a later successful
 * manual one) — only the call that actually produced the accepted suggestion
 * should get credit.
 */
async function backfillUsageEventAccepted(
  ctx: MutationCtx,
  transactionId: Id<"transactions">,
): Promise<void> {
  const latest = await ctx.db
    .query("aiUsageEvents")
    .withIndex("by_transaction", (q) =>
      q.eq("subjectTransactionId", transactionId),
    )
    .order("desc")
    .first();
  if (latest) {
    await ctx.db.patch(latest._id, { suggestionAccepted: true });
  }
}

/**
 * Persist one AI-usage audit-trail row (see `schema/aiUsage.ts`). Called by
 * `aiCoding.ts`'s `codeTransaction` for EVERY OpenRouter attempt — success or
 * failure — so paid-model spend is never silently unaccounted for. Internal
 * only: the action is the sole caller, there's no client-facing write path.
 */
export const recordUsageEvent = internalMutation({
  args: {
    feature: v.literal("finance_auto_coding"),
    chapterId: v.union(v.id("chapters"), v.literal(CENTRAL)),
    triggeredBy: v.union(
      v.literal("sweep"),
      v.literal("ingest"),
      v.literal("manual"),
    ),
    subjectTransactionId: v.optional(v.id("transactions")),
    cardholderPersonId: v.optional(v.id("people")),
    model: v.string(),
    promptTokens: v.number(),
    completionTokens: v.number(),
    costUsdMicros: v.number(),
    rawUsage: v.optional(v.any()),
    outcome: v.union(
      v.literal("suggested"),
      v.literal("failed"),
      v.literal("no_suggestion"),
    ),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert("aiUsageEvents", { ...args, createdAt: Date.now() });
    return null;
  },
});

/** Bounded scan for the usage summary below — a low-volume audit surface,
 *  not a paginated ledger, so a generous newest-first window (same spirit as
 *  `SWEEP_SCAN`) stands in for a full-table aggregate. */
const USAGE_SCAN_LIMIT = 2000;
/** How many individual events the "AI usage" section's recent list shows. */
const USAGE_RECENT_LIMIT = 25;

/** The UTC calendar-month boundary `ts` falls in. This is an ORG-WIDE
 *  aggregate across every chapter (no single chapter-local timezone applies),
 *  so it deliberately uses UTC rather than the chapter-planning-timezone math
 *  in `@events-os/shared` (`daysBetweenInTz` et al.) — "month to date" here
 *  only needs to be a stable, roughly-right boundary for a spend dashboard,
 *  not calendar-exact per viewer. */
function startOfMonthUtc(ts: number): number {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

/**
 * "AI usage" section data for the Accounts tab (`apps/mobile/app/(app)/
 * finances/accounts.tsx`) — month-to-date call count / estimated cost /
 * accept rate, plus a compact recent-events list. ED/FM-only, same gate as
 * the rest of that screen (`requireCentralEdOrFm` — see `increase.
 * listAccountsStatus` for the identical pattern).
 */
export const getUsageSummary = query({
  args: {},
  returns: v.object({
    monthToDate: v.object({
      calls: v.number(),
      costUsdMicros: v.number(),
      // null when no call has produced an acceptable ("suggested") outcome
      // yet this month — there's no rate to show, not a 0% rate.
      acceptRate: v.union(v.number(), v.null()),
    }),
    recentEvents: v.array(
      v.object({
        id: v.id("aiUsageEvents"),
        createdAt: v.number(),
        triggeredBy: v.union(
          v.literal("sweep"),
          v.literal("ingest"),
          v.literal("manual"),
        ),
        model: v.string(),
        outcome: v.union(
          v.literal("suggested"),
          v.literal("failed"),
          v.literal("no_suggestion"),
        ),
        costUsdMicros: v.number(),
        cardholderName: v.union(v.string(), v.null()),
        merchantName: v.union(v.string(), v.null()),
        suggestionAccepted: v.optional(v.boolean()),
      }),
    ),
  }),
  handler: async (ctx) => {
    await requireCentralEdOrFm(ctx);

    const recent = await ctx.db
      .query("aiUsageEvents")
      .order("desc")
      .take(USAGE_SCAN_LIMIT);

    const monthStart = startOfMonthUtc(Date.now());
    const thisMonth = recent.filter((e) => e.createdAt >= monthStart);
    const suggested = thisMonth.filter((e) => e.outcome === "suggested");
    const accepted = thisMonth.filter((e) => e.suggestionAccepted === true);

    const monthToDate = {
      calls: thisMonth.length,
      costUsdMicros: thisMonth.reduce((sum, e) => sum + e.costUsdMicros, 0),
      acceptRate:
        suggested.length > 0 ? accepted.length / suggested.length : null,
    };

    const recentEvents = await Promise.all(
      recent.slice(0, USAGE_RECENT_LIMIT).map(async (e) => {
        const [cardholder, txn] = await Promise.all([
          e.cardholderPersonId ? ctx.db.get(e.cardholderPersonId) : null,
          e.subjectTransactionId ? ctx.db.get(e.subjectTransactionId) : null,
        ]);
        return {
          id: e._id,
          createdAt: e.createdAt,
          triggeredBy: e.triggeredBy,
          model: e.model,
          outcome: e.outcome,
          costUsdMicros: e.costUsdMicros,
          cardholderName: cardholder?.name ?? null,
          merchantName: txn?.merchantName ?? null,
          suggestionAccepted: e.suggestionAccepted,
        };
      }),
    );

    return { monthToDate, recentEvents };
  },
});
