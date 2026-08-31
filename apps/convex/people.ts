/**
 * People / Volunteer roster.
 *
 * Chapter-scoped roster CRUD. Every function resolves the caller's chapter via
 * `requireChapterId` and scopes reads/writes to it.
 */
import { query, QueryCtx } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { v, ConvexError } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { paginator } from "convex-helpers/server/pagination";
import schema from "./schema";
import {
  requireUserId,
  requireChapterId,
  requireOwned,
  getChapterIdOrNull,
} from "./lib/context";
import { isChapterAdmin } from "./lib/org";
import {
  composeName,
  firstNameForDesignatedLast,
  isCardEligible,
  nameHalvesPatch,
  splitPersonName,
  type Persona,
} from "@events-os/shared";
import { writePersonAudit, diffFields } from "./lib/givingAudit";
import { recordPersonEmail } from "./lib/personEmails";
import { assertServiceIdsInChapter, expandServiceIdsWithChildren } from "./lib/serviceCatalog";
import { resolvePersonaForRoster, resolvePersonaForPage } from "./lib/people";
import { requireGivingView, type GivingScope } from "./lib/givingAccess";
import { parsePeopleSearch, personMatchesSearch } from "./lib/peopleSearch";
// `mutation`/`internalMutation` come from the triggers-wrapped builders, NOT
// `./_generated/server`, because this file writes `people` directly
// (create/update/remove) — see `lib/peopleAggregate.ts`'s module doc.
import { mutation, internalMutation, peopleByPersona, isCountedInAggregate } from "./lib/peopleAggregate";

const personaFilter = v.union(
  v.literal("team"),
  v.literal("vendor"),
  v.literal("volunteer"),
  v.literal("guest"),
  v.literal("contact"),
  // Not a real persona — an explicit opt-IN to seeing everyone, contacts
  // included. See `list`'s doc for why the unfiltered default is NOT this.
  v.literal("all"),
);

const vettingStatus = v.union(
  v.literal("unvetted"),
  v.literal("pending"),
  v.literal("vetted"),
);

const rosterStatus = v.union(
  v.literal("active"),
  v.literal("inactive"),
  v.literal("transitioning_in"),
  v.literal("transitioning_out"),
  v.literal("unavailable"),
);

const gender = v.union(v.literal("male"), v.literal("female"), v.literal("na"));

/** Assert the caller may rewire the org tree (admins only). */
async function requireCanSetManager(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
): Promise<void> {
  if (!(await isChapterAdmin(ctx, chapterId))) {
    throw new ConvexError({
      code: "FORBIDDEN",
      message: "Only chapter admins can change who reports to whom.",
    });
  }
}

/**
 * Assert that making `managerId` the manager of `personId` keeps the org tree
 * acyclic: walk up the proposed manager's chain and throw if it passes through
 * the person (or the person IS the manager). Bounded so a corrupt chain can't
 * loop forever.
 */
async function assertNoManagerCycle(
  ctx: QueryCtx,
  personId: Id<"people">,
  managerId: Id<"people">,
): Promise<void> {
  let cur: Id<"people"> | undefined = managerId;
  for (let hops = 0; cur && hops < 100; hops++) {
    if (cur === personId) {
      throw new ConvexError({
        code: "MANAGER_CYCLE",
        message: "That would make someone their own manager (directly or through the chain).",
      });
    }
    const doc: Doc<"people"> | null = await ctx.db.get(cur);
    cur = doc?.managerId;
  }
}

/**
 * TRAINING-SANDBOX people scope. Pickers rendered inside an Academy training
 * event pass that event's id; when it really is a training event in the
 * caller's chapter, the roster collapses to the CALLER + PLACEHOLDER people
 * (the sandbox's sample bench) — never the real roster, so a learner can't
 * accidentally rope real teammates into a drill. Returns null for any
 * non-training event (normal scoping applies); enforced here server-side, not
 * in the picker UI.
 */
async function sandboxPeopleFilter(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
  eventId: Id<"events">,
): Promise<((p: Doc<"people">) => boolean) | null> {
  const event = await ctx.db.get(eventId);
  if (!event || event.chapterId !== chapterId || event.isTraining !== true) {
    return null;
  }
  const userId = await requireUserId(ctx);
  const mine = await ctx.db
    .query("people")
    .withIndex("by_user", (q) => q.eq("userId", userId as Id<"users">))
    .first();
  const meId = mine?.chapterId === chapterId ? mine._id : null;
  // THIS sandbox's own crew slots — placeholders engaged on this event. Other
  // events' placeholder stand-ins (real events', other learners' sandboxes')
  // must never surface here.
  const engaged = new Set(
    (
      await ctx.db
        .query("engagements")
        .withIndex("by_event", (q) => q.eq("eventId", eventId))
        .collect()
    ).map((e) => String(e.personId)),
  );
  return (p) =>
    (meId != null && p._id === meId) ||
    p.isSamplePerson === true ||
    (p.isPlaceholder === true && engaged.has(String(p._id)));
}

/**
 * List people in the chapter, sorted by name (excluding only
 * `isPlaceholder`/`isSamplePerson` rows, which aren't real humans). In a
 * training sandbox (`eventId` of a training event), lists only the caller +
 * placeholder people instead — see `sandboxPeopleFilter`.
 *
 * Founder's model (the fix for the People *tab* showing 164 of ~275 real
 * people): a person is never PERMANENTLY hidden by a stored flag; persona is
 * a FILTER, never a partition. But this query has ~11 callers beyond the
 * People tab — pickers, mention lists, duty/role assignment, receipt person
 * lookup — and every one of those was built assuming "the roster" (a real,
 * participating person), never a bare contact auto-created from a donor
 * gift/import/RSVP. Flipping the UNFILTERED default to "everyone" would
 * silently widen 8 of those callers to include contacts with no review.
 *
 * So the default stays CONSERVATIVE and unchanged from before this fix:
 *   - `persona` UNSET (the default): the ROSTER — everyone except the
 *     "contact" persona (no participation signal at all). This is
 *     `contactsOnly: false`'s old behavior, preserved exactly.
 *   - `persona: "all"`: literally everyone, contacts included — the explicit
 *     opt-in a caller must ask for (the People tab, audience-seeding, and
 *     donor↔person linking are the only three that do; see their own call
 *     sites for why).
 *   - `persona: "team" | "vendor" | "volunteer" | "guest" | "contact"`:
 *     narrows to exactly that rung of the ladder
 *     (`@events-os/shared#Persona`: team > vendor > volunteer > guest >
 *     contact) — `contactsOnly: true` is now `persona: "contact"`.
 * Every row carries the backend-derived `persona` field regardless of the
 * filter applied, resolved by `resolvePersonaForRoster` (batched, bounded
 * DB reads — never per-person), so callers that need the ladder (the People
 * tab's segmented control + counts) never have to re-derive it client-side.
 */
export const list = query({
  args: {
    eventId: v.optional(v.id("events")),
    persona: v.optional(personaFilter),
    /** Free-text search, applied SERVER-side (name / email / pwEmail / phone
     *  — `lib/peopleSearch.ts`, the same semantics as `listPaginated`).
     *  Omitted or blank returns the whole roster, exactly as before, so every
     *  existing caller is unaffected. A picker that has a search box should
     *  pass it rather than filtering the returned array: see
     *  `lib/peopleSearch.ts`'s module doc for why client-side filtering of a
     *  server-shaped roster is the wrong place for this. */
    search: v.optional(v.string()),
  },
  handler: async (ctx, { eventId, persona, search }) => {
    const chapterId = await getChapterIdOrNull(ctx);
    if (!chapterId) return [];
    const people = await ctx.db
      .query("people")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId as Id<"chapters">))
      .collect();
    const sandbox = eventId
      ? await sandboxPeopleFilter(ctx, chapterId as Id<"chapters">, eventId)
      : null;
    // Placeholders are PER-EVENT materialized copies of a template's crew
    // (the reusable definitions live on the template as `templatePeople` and
    // are never touched here) — event-scoped stand-ins, not real roster
    // members, so keep them out of the People roster. Replacing one only
    // consumes that event's copy. Inside a training sandbox the rule flips:
    // placeholders (+ the caller) are the ONLY people offered — sandbox mode
    // ignores `persona` (a training drill never classifies its sample bench).
    // Search narrows BEFORE persona resolution — `resolvePersonaForRoster` is
    // the expensive step here, and a searching picker only ever needs the
    // handful of rows it is about to render.
    const terms = parsePeopleSearch(search);
    const everyone = people
      .filter(sandbox ?? ((p) => p.isPlaceholder !== true && p.isSamplePerson !== true))
      .filter((p) => personMatchesSearch(p, terms));
    const personaByPerson = sandbox
      ? null
      : await resolvePersonaForRoster(ctx, chapterId as Id<"chapters">, everyone);
    // Sandbox mode short-circuits to `everyone` (its own restricted set) —
    // no persona filtering applies there, same as before. Outside sandbox:
    // an explicit persona narrows to that rung, "all" means literally
    // everyone, and the CONSERVATIVE DEFAULT (unset) is the roster — every
    // rung except "contact". See this query's doc for why that default is
    // deliberate.
    const filtered = !personaByPerson
      ? everyone
      : persona === "all"
        ? everyone
        : persona
          ? everyone.filter((p) => personaByPerson.get(p._id) === persona)
          : everyone.filter((p) => personaByPerson.get(p._id) !== "contact");
    const sorted = filtered.sort((a, b) => a.name.localeCompare(b.name));
    // Resolve each profile photo storageId to a servable URL for display.
    return await Promise.all(
      sorted.map(async (p) => ({
        ...p,
        imageUrl: p.image ? await ctx.storage.getUrl(p.image) : null,
        persona: (personaByPerson?.get(p._id) ?? null) as Persona | null,
      })),
    );
  },
});

// ── People-CRM overhaul (2026-07-27) ────────────────────────────────────────
//
// `list` above stays exactly as it was: ~11 callers (pickers, mentions,
// duty/role assignment, receipt person lookup, …) depend on its conservative
// unfiltered default and its plain-array shape, and a regression test guards
// that default — see `list`'s own doc. The People TAB, though, needs a
// fundamentally different shape: server-side search/filter/sort over a
// roster heading into the thousands, paginated, with counts that don't
// require holding everyone in memory. Rather than reshape `list` (which
// would ripple through every one of those callers), this is a dedicated
// query for the grid.

/** A grid row's persona narrows to exactly one rung — no "all" sentinel here
 *  (unlike `list`'s `persona` arg): this query's own unfiltered default
 *  already means "everyone, contacts included" (the CRM grid's whole point),
 *  so there's no separate opt-in needed. */
const gridPersonaFilter = v.union(
  v.literal("team"),
  v.literal("vendor"),
  v.literal("volunteer"),
  v.literal("guest"),
  v.literal("contact"),
);

const gridSortBy = v.union(v.literal("name"), v.literal("lastName"), v.literal("status"));
const gridSortDir = v.union(v.literal("asc"), v.literal("desc"));

/** Bound on `getGiverPersonIds`'s donor scan — mirrors
 *  `givingPlatform.ts#DONOR_LIST_LIMIT` (same table, same chapter-scale
 *  reasoning; the People grid only needs the id set, not the richer
 *  per-donor shape `givingPlatform.ts#giverMarks` returns). */
const GIVER_PERSON_IDS_SCAN_LIMIT = 500;

/**
 * The chapter's "givers" as a person-id set, for the grid's Givers filter —
 * same predicate as `givingPlatform.ts#giverMarks` (a linked donor with at
 * least one recorded gift). Quietly degrades to an empty set for a caller
 * with no giving access at this chapter (mirrors `giverMarks`'s no-throw
 * pattern), so the People grid doesn't blow up for a viewer who simply can't
 * see the giving desk.
 */
async function getGiverPersonIds(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
): Promise<Set<Id<"people">>> {
  try {
    await requireGivingView(ctx, chapterId as GivingScope);
  } catch {
    return new Set();
  }
  const donors = await ctx.db
    .query("donors")
    .withIndex("by_scope_and_lifetime", (q) => q.eq("scope", chapterId))
    .take(GIVER_PERSON_IDS_SCAN_LIMIT);
  const ids = new Set<Id<"people">>();
  for (const d of donors) {
    if (d.personId !== undefined && d.giftCount > 0) ids.add(d.personId);
  }
  return ids;
}

/** One indexed, sorted paginated read per `sortBy` column — a compound
 *  index per column (`schema/people.ts`) so the DB itself returns rows
 *  already in the requested order across the whole walk, cursor included.
 *  Written as an if/else over three concrete index names rather than one
 *  dynamic `withIndex(name, …)` call so each branch keeps full type
 *  inference on its own `q.eq`.
 *
 *  USES `convex-helpers`' `paginator`, NOT `ctx.db…paginate()`. `listPaginated`
 *  calls this repeatedly in ONE query to backfill a page that filtering shrank,
 *  and built-in `.paginate()` permits exactly one paginated query per function
 *  — the second call threw "This query or mutation function ran multiple
 *  paginated queries" and took the whole People tab down in production
 *  (2026-07-27). `paginator` is documented as safe to call multiple times in a
 *  single query. Do NOT swap this back to `ctx.db`. */
async function paginateSortedPeople(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
  sortBy: "name" | "lastName" | "status",
  order: "asc" | "desc",
  opts: { numItems: number; cursor: string | null },
) {
  if (sortBy === "lastName") {
    return await paginator(ctx.db, schema)
      .query("people")
      .withIndex("by_chapter_and_lastName", (q) => q.eq("chapterId", chapterId))
      .order(order)
      .paginate(opts);
  }
  if (sortBy === "status") {
    return await paginator(ctx.db, schema)
      .query("people")
      .withIndex("by_chapter_and_status", (q) => q.eq("chapterId", chapterId))
      .order(order)
      .paginate(opts);
  }
  return await paginator(ctx.db, schema)
    .query("people")
    .withIndex("by_chapter_and_name", (q) => q.eq("chapterId", chapterId))
    .order(order)
    .paginate(opts);
}

/** Safety bound on how many raw index batches `listPaginated` will re-walk
 *  in a SINGLE call to backfill a page that search/filter/persona shrank
 *  below `numItems` — never unbounded. Filtering after `.paginate()` is the
 *  standard Convex pattern for a query no built-in index can fully express
 *  (free-text substring search across name/email/phone); looping a bounded
 *  number of times inside the one call means a rare search still returns a
 *  full page in one round trip instead of forcing the client through a
 *  string of near-empty "load more" taps. */
const PEOPLE_PAGE_BATCH_LOOPS = 10;

/**
 * The People tab's grid data source: server-side search + filter + sort,
 * paginated. Replaces the old `people.list({persona:"all"})` +
 * client-side-filter-everything approach, which shipped every person to the
 * client on every load and re-derived persona for the WHOLE roster
 * (`resolvePersonaForRoster`) regardless of what was actually on screen.
 *
 * - `search`: case-insensitive substring match against name, email, pwEmail,
 *   OR phone (phone compared digits-only, mirrors the old client-side
 *   `personMatchesSearch`).
 * - `persona`: narrows to exactly that rung (no "all" — see
 *   `gridPersonaFilter`'s doc; omit the arg for everyone).
 * - `serviceIds`: multi-select, OR semantics — a person matches if their
 *   `serviceIds` intersects ANY selected id's expanded match set (itself +
 *   children), so picking a parent (e.g. "Vocals") also matches everyone
 *   tagged with a child (e.g. "Vocals:Tenor") — mirrors
 *   `lib/audienceTargeting.ts#buildServiceIndex`'s `has_service` rollup
 *   exactly (see `expandServiceIdsWithChildren`), so the grid and audience
 *   targeting never disagree about what selecting a service means.
 * - `status` / `giversOnly`: single-value / boolean overlays, same as
 *   before, just server-side now.
 *
 * Persona is derived PER PAGE (`resolvePersonaForPage`), never for the whole
 * roster — see that function's doc for why `resolvePersonaForRoster` would
 * be the wrong tool here. Placeholders/sample people are excluded, same as
 * `list`.
 */
export const listPaginated = query({
  args: {
    paginationOpts: paginationOptsValidator,
    search: v.optional(v.string()),
    persona: v.optional(gridPersonaFilter),
    serviceIds: v.optional(v.array(v.id("serviceOptions"))),
    status: v.optional(rosterStatus),
    giversOnly: v.optional(v.boolean()),
    sortBy: v.optional(gridSortBy),
    sortDir: v.optional(gridSortDir),
  },
  handler: async (ctx, args) => {
    const chapterId = await getChapterIdOrNull(ctx);
    if (!chapterId) {
      return { page: [], isDone: true, continueCursor: "" };
    }
    const cId = chapterId as Id<"chapters">;

    const serviceMatchSet =
      args.serviceIds && args.serviceIds.length > 0
        ? await expandServiceIdsWithChildren(ctx, args.serviceIds)
        : null;
    const giverIds = args.giversOnly ? await getGiverPersonIds(ctx, cId) : null;

    // The grid's search and every picker's search are the SAME predicate
    // (`lib/peopleSearch.ts`) — the People tab and a seat picker must never
    // disagree about what a query matches.
    const terms = parsePeopleSearch(args.search);

    // Every filter EXCEPT persona (which needs a derived value resolved
    // per-candidate below) — cheap field compares over an already-indexed,
    // already-sorted raw batch.
    function passesFieldFilters(p: Doc<"people">): boolean {
      if (p.isPlaceholder === true || p.isSamplePerson === true) return false;
      if (args.status && p.status !== args.status) return false;
      if (serviceMatchSet && !(p.serviceIds ?? []).some((id) => serviceMatchSet.has(id))) {
        return false;
      }
      if (giverIds && !giverIds.has(p._id)) return false;
      if (!personMatchesSearch(p, terms)) return false;
      return true;
    }

    const sortBy = args.sortBy ?? "name";
    const order = args.sortDir ?? "asc";

    let cursor: string | null = args.paginationOpts.cursor;
    let isDone = false;
    // `Omit<..., "persona">` — `Doc<"people">` now carries its OWN cached
    // `persona` field (`schema/people.ts`'s new Aggregate-backed cache), but
    // this result's `persona` is the freshly-computed, page-scoped value
    // from `resolvePersonaForPage` below, not that cache; omitting avoids
    // the two conflicting `persona` types colliding in the intersection.
    const page: Array<
      Omit<Doc<"people">, "persona"> & { imageUrl: string | null; persona: Persona | null }
    > = [];
    for (
      let loop = 0;
      loop < PEOPLE_PAGE_BATCH_LOOPS && page.length < args.paginationOpts.numItems && !isDone;
      loop++
    ) {
      const batch = await paginateSortedPeople(ctx, cId, sortBy, order, {
        numItems: args.paginationOpts.numItems,
        cursor,
      });
      isDone = batch.isDone;
      cursor = batch.continueCursor;
      const candidates = batch.page.filter(passesFieldFilters);
      if (candidates.length === 0) continue;
      const personaByPerson = await resolvePersonaForPage(ctx, candidates);
      for (const p of candidates) {
        const persona = personaByPerson.get(p._id) ?? null;
        if (args.persona && persona !== args.persona) continue;
        page.push({
          ...p,
          imageUrl: p.image ? await ctx.storage.getUrl(p.image) : null,
          persona,
        });
      }
    }
    return { page, isDone, continueCursor: cursor ?? "" };
  },
});

/** Bound on `repairPersonaAggregate`'s per-chapter roster scan — generous
 *  relative to a real chapter (heading into the thousands per the
 *  People-CRM overhaul brief). `counts` itself no longer scans anything (see
 *  below) — this bound only matters for the repair tool's from-scratch
 *  rebuild. */
const PEOPLE_COUNTS_SCAN_LIMIT = 20000;

/**
 * Persona-ladder counts (All / Team / Volunteers / Vendors / Guests /
 * Contacts) for the People grid's header. Previously a whole-chapter scan +
 * `resolvePersonaForRoster` on every call; now reads `peopleByPersona` (a
 * `TableAggregate` over `people.persona` — see `lib/peopleAggregate.ts`),
 * giving O(log n) counts instead of visiting every roster row. Same return
 * shape as before — the client is unaffected.
 */
export const counts = query({
  args: {},
  returns: v.object({
    all: v.number(),
    team: v.number(),
    vendor: v.number(),
    volunteer: v.number(),
    guest: v.number(),
    contact: v.number(),
  }),
  handler: async (ctx) => {
    const empty = { all: 0, team: 0, vendor: 0, volunteer: 0, guest: 0, contact: 0 };
    const chapterId = await getChapterIdOrNull(ctx);
    if (!chapterId) return empty;
    const cId = chapterId as Id<"chapters">;
    const [all, team, vendor, volunteer, guest, contact] = await peopleByPersona.countBatch(ctx, [
      { namespace: cId },
      { namespace: cId, bounds: { prefix: ["team"] } },
      { namespace: cId, bounds: { prefix: ["vendor"] } },
      { namespace: cId, bounds: { prefix: ["volunteer"] } },
      { namespace: cId, bounds: { prefix: ["guest"] } },
      { namespace: cId, bounds: { prefix: ["contact"] } },
    ]);
    return { all, team, vendor, volunteer, guest, contact };
  },
});

/**
 * Guard 1 — repair tool. Clears `peopleByPersona` and rebuilds it from
 * scratch, per chapter, by recomputing every eligible person's REAL persona
 * from source-of-truth signals (`resolvePersonaForRoster` — the same
 * whole-chapter batching `counts` used before this PR) and unconditionally
 * re-patching `persona`, even when the computed value matches what's already
 * stored. That "patch anyway" is deliberate: the cache field can be correct
 * while the AGGREGATE is still missing the row entirely (e.g. a write that
 * slipped through an un-wrapped mutation — see `lib/peopleAggregate.ts`'s
 * module doc), and only an actual patch fires the write-through trigger that
 * repopulates the aggregate. Safe to run any time drift is suspected; not on
 * a cron — this is a manually-invoked, superuser-triggered repair, not a
 * live code path.
 *
 * Run locally:   npx convex run people:repairPersonaAggregate
 * Run on prod:   npx convex run --prod people:repairPersonaAggregate
 */
export const repairPersonaAggregate = internalMutation({
  args: {},
  returns: v.object({ chaptersRepaired: v.number(), peopleRepaired: v.number() }),
  handler: async (ctx) => {
    await peopleByPersona.clearAll(ctx);
    const chapters = await ctx.db.query("chapters").take(1000);
    let peopleRepaired = 0;
    for (const chapter of chapters) {
      const roster = await ctx.db
        .query("people")
        .withIndex("by_chapter", (q) => q.eq("chapterId", chapter._id))
        .take(PEOPLE_COUNTS_SCAN_LIMIT);
      const eligible = roster.filter(isCountedInAggregate);
      const personaByPerson = await resolvePersonaForRoster(ctx, chapter._id, eligible);
      for (const p of eligible) {
        const persona = personaByPerson.get(p._id) ?? "contact";
        await ctx.db.patch(p._id, { persona });
        peopleRepaired++;
      }
    }
    return { chaptersRepaired: chapters.length, peopleRepaired };
  },
});

/** Bound generous relative to a real chapter's roster (heading into the
 *  thousands) — a lightweight `{_id, name}` PROJECTION, not full person
 *  docs, so this stays cheap even at that scale regardless of how many
 *  people exist. */
const PEOPLE_NAMES_SCAN_LIMIT = 20000;

/**
 * `{_id, name}` for every real person in the chapter — powers the People
 * grid's Manager-name column, which must resolve a name for ANY person in
 * the chapter regardless of which page of the (now paginated) grid happens
 * to be loaded. Never used to derive persona/filters/counts — just a name
 * lookup, which is why this stays cheap at roster scale where
 * `listPaginated`'s per-row cost would not.
 */
export const namesByChapter = query({
  args: {},
  returns: v.array(v.object({ _id: v.id("people"), name: v.string() })),
  handler: async (ctx) => {
    const chapterId = await getChapterIdOrNull(ctx);
    if (!chapterId) return [];
    const people = await ctx.db
      .query("people")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId as Id<"chapters">))
      .take(PEOPLE_NAMES_SCAN_LIMIT);
    return people
      .filter((p) => p.isPlaceholder !== true && p.isSamplePerson !== true)
      .map((p) => ({ _id: p._id, name: p.name }));
  },
});

/**
 * Card-eligible people — the chapter roster filtered to those with a Public
 * Worship email (`@publicworship.life`, via `isCardEligible`). Feeds the card
 * pickers (issue a card, link a legacy card), which may only target eligible
 * people. Same read shape as `people.list` (the person row + a resolved
 * `imageUrl`); placeholders + sample people are excluded like the roster list.
 */
export const cardEligible = query({
  args: {
    /** Free-text search, applied SERVER-side — see `list`'s `search` doc. */
    search: v.optional(v.string()),
  },
  handler: async (ctx, { search }) => {
    const chapterId = await getChapterIdOrNull(ctx);
    if (!chapterId) return [];
    const people = await ctx.db
      .query("people")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId as Id<"chapters">))
      .collect();
    const terms = parsePeopleSearch(search);
    const sorted = people
      .filter(
        (p) =>
          p.isPlaceholder !== true &&
          p.isSamplePerson !== true &&
          // Roster UX (card issuance is a team-member action) — see
          // `lib/org.ts#excludeContacts`'s doc. Belt-and-suspenders: a
          // contact-only row practically never carries a `pwEmail` anyway.
          p.isContactOnly !== true &&
          isCardEligible(p.pwEmail) &&
          personMatchesSearch(p, terms),
      )
      .sort((a, b) => a.name.localeCompare(b.name));
    return await Promise.all(
      sorted.map(async (p) => ({
        ...p,
        imageUrl: p.image ? await ctx.storage.getUrl(p.image) : null,
      })),
    );
  },
});

/**
 * Team members only — the people who can be event owners or hold lead roles
 * (they have, or will be granted, backend access). A person counts as a team
 * member if explicitly flagged OR already linked to a user account. In a
 * training sandbox (`eventId` of a training event), returns the caller +
 * placeholder people instead — the sandbox's sample bench holds the roles.
 */
export const teamMembers = query({
  args: {
    eventId: v.optional(v.id("events")),
    /** Free-text search, applied SERVER-side — see `list`'s `search` doc. */
    search: v.optional(v.string()),
  },
  handler: async (ctx, { eventId, search }) => {
    const chapterId = await getChapterIdOrNull(ctx);
    if (!chapterId) return [];
    const people = await ctx.db
      .query("people")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId as Id<"chapters">))
      .collect();
    const sandbox = eventId
      ? await sandboxPeopleFilter(ctx, chapterId as Id<"chapters">, eventId)
      : null;
    const terms = parsePeopleSearch(search);
    // No explicit `isContactOnly` check needed: a contact-only row is always
    // written with `isTeamMember: false` and no `userId` (see
    // `lib/rsvpPeople.ts`/`lib/givingDonors.ts`), so it already fails the
    // `isTeamMember === true || userId != null` test below.
    return people
      .filter(
        sandbox ??
          ((p) =>
            p.isSamplePerson !== true &&
            (p.isTeamMember === true || p.userId != null)),
      )
      .filter((p) => personMatchesSearch(p, terms))
      .sort((a, b) => a.name.localeCompare(b.name));
  },
});

/** Fetch a single person in the caller's chapter, with their profile photo
 *  storageId resolved to a servable `imageUrl` (mirrors `list`'s own
 *  resolution) — callers (the People-tab deep-link fallback,
 *  `PersonPreviewModal`) show a real photo instead of always falling back
 *  to initials. */
export const get = query({
  args: { personId: v.id("people") },
  handler: async (ctx, { personId }) => {
    const person = await requireOwned(ctx, "people", personId, "Person");
    return {
      ...person,
      imageUrl: person.image ? await ctx.storage.getUrl(person.image) : null,
    };
  },
});

/** How many person-audit breadcrumbs the detail renders (newest-first). */
const PERSON_AUDIT_READ_CAP = 100;

/**
 * A person's contact-edit audit trail (owner feedback #4), newest-first, with
 * the actor's display name resolved. Scoped to the caller's chapter via
 * `requireOwned`; bounded `by_person`.
 */
export const listPersonAudit = query({
  args: { personId: v.id("people") },
  handler: async (ctx, { personId }) => {
    await requireOwned(ctx, "people", personId, "Person");
    const rows = await ctx.db
      .query("personAudit")
      .withIndex("by_person", (q) => q.eq("personId", personId))
      .order("desc")
      .take(PERSON_AUDIT_READ_CAP);
    const actorNames = new Map<string, string>();
    for (const id of new Set(rows.map((a) => a.actorUserId))) {
      const profile = await ctx.db
        .query("userProfiles")
        .withIndex("by_userId", (q) => q.eq("userId", id))
        .unique();
      actorNames.set(
        id,
        profile?.name ?? (await ctx.db.get(id))?.email ?? "Someone",
      );
    }
    return rows.map((a) => ({
      _id: a._id,
      at: a.at,
      changes: a.changes,
      note: a.note ?? null,
      actorName: actorNames.get(a.actorUserId) ?? "Someone",
    }));
  },
});

/** Add a person to the chapter roster. */
export const create = mutation({
  args: {
    name: v.string(),
    // Explicit name halves (Add Person modal, specs/add-person-modal-fields.md)
    // — mirrors `update`'s own args: when either is sent, the halves are
    // authoritative and stored as given rather than re-derived from `name`
    // via `splitPersonName` (which refuses to guess past two tokens).
    firstName: v.optional(v.string()),
    lastName: v.optional(v.string()),
    email: v.optional(v.string()),
    phone: v.optional(v.string()),
    // Service Catalog ids (`serviceOptions`) — replaces the retired
    // `skills`/`services` free-text args. See `schema/people.ts`'s
    // deprecation comment on `services`.
    serviceIds: v.optional(v.array(v.id("serviceOptions"))),
    vettingStatus: v.optional(vettingStatus),
    status: v.optional(rosterStatus),
    role: v.optional(v.string()),
    gender: v.optional(gender),
    pocName: v.optional(v.string()),
    projects: v.optional(v.array(v.string())),
    commsPreferences: v.optional(v.array(v.string())),
    pwEmail: v.optional(v.string()),
    company: v.optional(v.string()),
    usualRateUsd: v.optional(v.number()),
    isTeamMember: v.optional(v.boolean()),
    image: v.optional(v.id("_storage")),
    socialLink: v.optional(v.string()),
    managerId: v.optional(v.id("people")),
    // Person-form-fields widening (Add Person modal) — the remaining columns
    // `update` already supports that `create` didn't, so the modal can set
    // everything it collects in one mutation instead of create-then-patch.
    location: v.optional(v.string()),
    referralSource: v.optional(v.string()),
    isVolunteer: v.optional(v.boolean()),
    marketingOptOut: v.optional(v.boolean()),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const chapterId = await requireChapterId(ctx);
    await requireUserId(ctx);
    if (args.managerId) {
      await requireCanSetManager(ctx, chapterId as Id<"chapters">);
      await requireOwned(ctx, "people", args.managerId, "Manager");
    }
    if (args.serviceIds && args.serviceIds.length > 0) {
      await assertServiceIdsInChapter(ctx, chapterId as Id<"chapters">, args.serviceIds);
    }
    const status = args.status ?? "active";
    const personId = await ctx.db.insert("people", {
      chapterId: chapterId as Id<"chapters">,
      name: args.name,
      // Structured halves: an explicit firstName/lastName (either one) is
      // authoritative, same rule `update` applies — otherwise fall back to
      // the automatic split when it's unambiguous (see
      // `@events-os/shared#names`, the one splitting rule migration 0043 and
      // every rename write-through share).
      ...(args.firstName !== undefined || args.lastName !== undefined
        ? { firstName: args.firstName, lastName: args.lastName }
        : (splitPersonName(args.name) ?? {})),
      email: args.email,
      phone: args.phone,
      serviceIds: args.serviceIds,
      vettingStatus: args.vettingStatus ?? "unvetted",
      status,
      role: args.role,
      gender: args.gender,
      pocName: args.pocName,
      projects: args.projects,
      commsPreferences: args.commsPreferences,
      pwEmail: args.pwEmail,
      company: args.company,
      usualRateUsd: args.usualRateUsd,
      isTeamMember: args.isTeamMember,
      image: args.image,
      socialLink: args.socialLink,
      managerId: args.managerId,
      location: args.location,
      referralSource: args.referralSource,
      isVolunteer: args.isVolunteer,
      marketingOptOut: args.marketingOptOut,
      notes: args.notes,
      createdAt: Date.now(),
    });
    // Person-centric audiences Phase 2 (specs/person-centric-audiences.md) —
    // write-through: a fresh roster row's own contact fields seed its
    // `personEmails` ledger immediately, same as every other automated
    // person-creation path (`linkDonorToPerson`/`linkRsvpToPerson`).
    if (args.email) {
      await recordPersonEmail(ctx, { personId, email: args.email, source: "roster", verified: true });
    }
    if (args.pwEmail) {
      await recordPersonEmail(ctx, { personId, email: args.pwEmail, source: "pw", verified: true });
    }
    return personId;
  },
});

/** Update a person's profile fields. */
export const update = mutation({
  args: {
    personId: v.id("people"),
    name: v.optional(v.string()),
    // Structured name halves (founder ask, 2026-07-25). When EITHER is
    // provided they are authoritative: both halves are stored as given
    // (null/empty clears one) and the display `name` is RECOMPOSED from
    // them ("First Last") whenever at least one is non-empty — this is how
    // an ambiguous name ("Mary Jo Van Der Berg") gets hand-corrected into
    // halves the automatic splitter refuses to guess. When only `name` is
    // sent, the halves are re-derived/cleared from it instead (see below).
    firstName: v.optional(v.union(v.string(), v.null())),
    lastName: v.optional(v.union(v.string(), v.null())),
    email: v.optional(v.string()),
    phone: v.optional(v.string()),
    // Service Catalog ids (`serviceOptions`) — replaces the retired
    // `skills`/`services` free-text args. See `schema/people.ts`'s
    // deprecation comment on `services`.
    serviceIds: v.optional(v.union(v.array(v.id("serviceOptions")), v.null())),
    usualRateUsd: v.optional(v.union(v.number(), v.null())),
    notes: v.optional(v.union(v.string(), v.null())),
    isTeamMember: v.optional(v.boolean()),
    vettingStatus: v.optional(vettingStatus),
    isActive: v.optional(v.boolean()),
    status: v.optional(rosterStatus),
    role: v.optional(v.union(v.string(), v.null())),
    gender: v.optional(gender),
    pocName: v.optional(v.union(v.string(), v.null())),
    projects: v.optional(v.union(v.array(v.string()), v.null())),
    commsPreferences: v.optional(v.union(v.array(v.string()), v.null())),
    pwEmail: v.optional(v.union(v.string(), v.null())),
    company: v.optional(v.union(v.string(), v.null())),
    image: v.optional(v.union(v.id("_storage"), v.null())),
    socialLink: v.optional(v.union(v.string(), v.null())),
    managerId: v.optional(v.union(v.id("people"), v.null())),
    // Person-centric audiences Phase 2 (specs/person-centric-audiences.md) —
    // the person-level marketing opt-out, layered over `emailSuppressions`.
    marketingOptOut: v.optional(v.boolean()),
    // Person-form-fields widening (`schema/people.ts`'s doc on each field) —
    // hand corrections to what the Google Form imports captured.
    // `consentedAt`/`consentSource` are deliberately NOT editable here: they
    // record an affirmative-consent EVENT with a timestamp, not a toggle a
    // staffer should casually flip; only the import write path sets them.
    location: v.optional(v.union(v.string(), v.null())),
    referralSource: v.optional(v.union(v.string(), v.null())),
    isVolunteer: v.optional(v.boolean()),
    // Owner feedback #4: optional "why", recorded on the person-audit breadcrumb
    // when a contact field (name/email/phone) changes.
    why: v.optional(v.string()),
  },
  handler: async (ctx, { personId, why, ...patch }) => {
    const person = await requireOwned(ctx, "people", personId, "Person");
    const actorUserId = (await requireUserId(ctx)) as Id<"users">;
    if (patch.managerId !== undefined) {
      // Setting AND clearing a manager both reshape the org tree — admin only.
      await requireCanSetManager(ctx, person.chapterId);
    }
    if (patch.managerId != null) {
      await requireOwned(ctx, "people", patch.managerId, "Manager");
      await assertNoManagerCycle(ctx, personId, patch.managerId);
    }
    if (patch.serviceIds != null && patch.serviceIds.length > 0) {
      await assertServiceIdsInChapter(ctx, person.chapterId, patch.serviceIds);
    }
    const fields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patch)) {
      // null = explicit clear (store undefined); undefined = leave unchanged.
      if (value !== undefined) fields[key] = value === null ? undefined : value;
    }
    // Person lifecycle lives on `status` only now; the legacy `isActive` flag is
    // no longer written (accept the arg from OTA-lagged clients, then drop it).
    delete fields.isActive;
    if (patch.firstName !== undefined || patch.lastName !== undefined) {
      // Halves are authoritative when sent (see the args doc): store them
      // and recompose the display name — unless the caller ALSO sent a
      // `name` in the same call, which would be two competing sources of
      // truth for the same string; reject that instead of guessing.
      if (patch.name !== undefined) {
        throw new ConvexError({
          code: "CONFLICTING_NAME",
          message: "Send either name or firstName/lastName, not both.",
        });
      }
      // Only the half that was actually SENT changes — sending one never
      // wipes the other (the People grid's cells commit one at a time).
      let first =
        patch.firstName !== undefined
          ? (fields.firstName as string | undefined)?.trim() || undefined
          : person.firstName;
      const last =
        patch.lastName !== undefined
          ? (fields.lastName as string | undefined)?.trim() || undefined
          : person.lastName;
      // Giving a surname to a person who has NO halves at all (an unsplit
      // mononym or 3+-token name — see `splitPersonName`). Composing from a
      // last name alone would overwrite the display name with just that
      // surname, wiping "Mary Jo Van Der Berg" down to "Van Der Berg", so the
      // first half is derived from the name already on the record. Only when
      // the caller didn't speak for `firstName` itself — an explicit half,
      // including an explicit clear, always wins — and only for a person with
      // NO stored halves, the exact case the grid used to render as a dead
      // dash. A record that already carries one half is left on its existing
      // path rather than having a first name invented for it.
      if (
        patch.firstName === undefined &&
        person.firstName === undefined &&
        person.lastName === undefined &&
        first === undefined &&
        last &&
        person.name
      ) {
        first = firstNameForDesignatedLast(person.name, last) || undefined;
      }
      fields.firstName = first;
      fields.lastName = last;
      const composed = composeName(first, last);
      if (composed) fields.name = composed;
    } else if (typeof fields.name === "string") {
      // A rename keeps the structured halves consistent: refreshed on a clean
      // split, EXPLICITLY CLEARED (undefined) on an ambiguous one — stale
      // halves from the previous name are wrong data, not missing data. See
      // `@events-os/shared#names#nameHalvesPatch`.
      const halves = nameHalvesPatch(fields.name);
      fields.firstName = halves.firstName;
      fields.lastName = halves.lastName;
    }
    await ctx.db.patch(personId, fields);

    // Person-centric audiences Phase 2 — write-through: a changed `email`/
    // `pwEmail` value (a real string) seeds/upgrades the `personEmails`
    // ledger. `pwEmail` can be explicitly cleared (`null`, this arg's own
    // union validator) — that's NOT treated as "forget this address" either:
    // the ledger keeps every address ever seen, so a cleared roster field
    // doesn't silently drop known provenance.
    if (typeof fields.email === "string" && fields.email) {
      await recordPersonEmail(ctx, { personId, email: fields.email, source: "roster", verified: true });
    }
    if (typeof fields.pwEmail === "string" && fields.pwEmail) {
      await recordPersonEmail(ctx, { personId, email: fields.pwEmail, source: "pw", verified: true });
    }

    // Owner feedback #4: narrate a name/email/phone change on the person audit
    // trail (cheap, additive — only the three contact fields, mirroring the
    // donor audit). `fields` holds the resolved values the patch actually wrote.
    const contactAfter = (key: "name" | "email" | "phone"): string | undefined =>
      key in fields ? (fields[key] as string | undefined) : (person as any)[key];
    const contactChanges = diffFields(
      { name: "Name", email: "Email", phone: "Phone" },
      { name: person.name, email: person.email, phone: person.phone },
      {
        name: contactAfter("name"),
        email: contactAfter("email"),
        phone: contactAfter("phone"),
      },
    );
    if (contactChanges.length > 0) {
      await writePersonAudit(ctx, {
        personId,
        chapterId: person.chapterId,
        actorUserId,
        changes: contactChanges,
        note: why,
      });
    }
    return personId;
  },
});

/** Remove a person from the roster, plus their event engagements. */
export const remove = mutation({
  args: { personId: v.id("people") },
  handler: async (ctx, { personId }) => {
    const person = await requireOwned(ctx, "people", personId, "Person");
    // Removing someone WITH reports rewires the org tree (their reports get a
    // new manager) — that's the admin-only operation, same as the Manager cell.
    const reports = await ctx.db
      .query("people")
      .withIndex("by_manager", (q) => q.eq("managerId", personId))
      .collect();
    if (reports.length > 0) {
      await requireCanSetManager(ctx, person.chapterId);
    }
    const engagements = await ctx.db
      .query("engagements")
      .withIndex("by_person", (q) => q.eq("personId", personId))
      .collect();
    for (const e of engagements) await ctx.db.delete(e._id);
    // Re-point direct reports at the removed person's own manager (or none) so
    // the org tree closes over the gap instead of stranding a subtree.
    for (const r of reports) {
      await ctx.db.patch(r._id, { managerId: person.managerId });
    }
    // Their projects roll up to their manager (so the work stays visible in
    // that manager's Team view); with no manager they go unowned, surfacing in
    // the admin-only "Unassigned" triage section.
    const owned = await ctx.db
      .query("projects")
      .withIndex("by_owner", (q) => q.eq("ownerPersonId", personId))
      .collect();
    for (const p of owned) {
      await ctx.db.patch(p._id, {
        ownerPersonId: person.managerId,
        updatedAt: Date.now(),
      });
    }
    // Strip them from direct responsibility assignments (no dangling '?' chips)
    // and delete the 1:1 record about them — it's unreachable once they're gone.
    const duties = await ctx.db
      .query("responsibilities")
      .withIndex("by_chapter", (q) => q.eq("chapterId", person.chapterId))
      .collect();
    for (const d of duties) {
      if (!d.assigneePersonIds?.includes(personId)) continue;
      const remaining = d.assigneePersonIds.filter((id) => id !== personId);
      await ctx.db.patch(d._id, {
        assigneePersonIds: remaining.length > 0 ? remaining : undefined,
        updatedAt: Date.now(),
      });
    }
    const theirCheckIns = await ctx.db
      .query("checkIns")
      .withIndex("by_person", (q) => q.eq("personId", personId))
      .collect();
    for (const c of theirCheckIns) await ctx.db.delete(c._id);
    await ctx.db.delete(personId);
    return personId;
  },
});
