/**
 * Org chart (seats) — read queries.
 *
 * The chart is deliberately ORG-TRANSPARENT: any signed-in member may read
 * it, including the FULL cross-chapter tree (every chapter's seat occupancy
 * at once) — this is an explicit OWNER PRODUCT DECISION (2026-07-16): the Org
 * Chart is a tab visible to everybody, org-transparent by design, unlike the
 * finance surfaces (which DO scope reads to the caller's own
 * chapter/central reach). All three reads below (`chart`, `seatDetail`,
 * `mySeatAssignments`) are gated only by `requireAccess` — no chapter- or
 * central-scoping check beyond that. (A follow-up nuance — guest-allowlisted
 * accounts sitting at the same trust tier as domain members for this read —
 * has been raised with the owner separately; no code change pending that.)
 * This PR is schema + seed + reads only — no assignment mutations (a later
 * PR) and no capability enforcement changes.
 *
 * The chapter chart is defined ONCE and shared by every chapter (same
 * shape/duties/capabilities everywhere) — only OCCUPANCY (`seatAssignments`)
 * is per-chapter. The central chart's `chapter_directors` seat is `derived`:
 * its "holders" are computed by rolling up every chapter's `chapter_director`
 * (the chapter chart's root seat), never assigned directly.
 */
import { query, mutation } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx, MutationCtx } from "./_generated/server";
import {
  SEAT_CHARTS,
  SEAT_CAPABILITIES,
  SEAT_ROOT,
  MULTI_HOLDER_CAP,
  SEAT_IDS,
  SEAT_DEFS,
  titleKind,
} from "@events-os/shared";
import { requireAccess, requireUserId } from "./lib/context";
import { requireSuperuser } from "./lib/superuser";
import { ROLLUP_SCAN_LIMIT } from "./finances";
import {
  assignSpecializedRoleImpl,
  removeSpecializedRoleImpl,
} from "./specializedRoles";

const seatChartValidator = v.union(...SEAT_CHARTS.map((c) => v.literal(c)));
const seatCapabilityValidator = v.union(
  ...SEAT_CAPABILITIES.map((c) => v.literal(c)),
);

/** Bounded cap on how many seatDefs a chart read scans — well above the
 *  template's 27 rows, room for the later runtime editor to add more. */
const MAX_CHART_SEATS = 300;

const chartHolderValidator = v.object({
  personId: v.id("people"),
  name: v.string(),
  imageUrl: v.union(v.string(), v.null()),
});

const seatNodeValidator = v.object({
  defId: v.id("seatDefs"),
  slug: v.string(),
  title: v.string(),
  parentSlug: v.string(),
  maxHolders: v.number(),
  derived: v.boolean(),
  sortOrder: v.number(),
  holders: v.array(chartHolderValidator),
  vacant: v.boolean(),
});

const chapterSubtreeValidator = v.object({
  chapterId: v.id("chapters"),
  chapterName: v.string(),
  seats: v.array(seatNodeValidator),
});

// ── Internal helpers ─────────────────────────────────────────────────────────

type DetailedHolder = {
  personId: Id<"people">;
  name: string;
  imageUrl: string | null;
  createdAt: number;
  grantedBy: Id<"users"> | null;
};

/** Resolve a `people` row to its display name/image, skipping placeholders
 *  (mirrors `financeRoles.mySeats`' `isPlaceholder !== true` filter). Returns
 *  `null` for a missing or placeholder person. `nameSuffix` labels a derived
 *  rollup holder with its source chapter (e.g. "Ada Lee (New York)"). */
async function resolvePerson(
  ctx: QueryCtx,
  personId: Id<"people">,
  nameSuffix?: string,
): Promise<{ name: string; imageUrl: string | null } | null> {
  const person = await ctx.db.get(personId);
  if (!person || person.isPlaceholder === true) return null;
  return {
    name: nameSuffix ? `${person.name} (${nameSuffix})` : person.name,
    imageUrl: person.image ? await ctx.storage.getUrl(person.image) : null,
  };
}

/** A seat's holders at one scope, bounded at `MULTI_HOLDER_CAP` (the
 *  template's own ceiling on a "*" seat's holder count). */
async function detailedHoldersForScope(
  ctx: QueryCtx,
  scope: Id<"chapters"> | "central",
  seatDefId: Id<"seatDefs">,
  nameSuffix?: string,
): Promise<DetailedHolder[]> {
  const rows = await ctx.db
    .query("seatAssignments")
    .withIndex("by_scope_and_seat", (q) =>
      q.eq("scope", scope).eq("seatDefId", seatDefId),
    )
    .take(MULTI_HOLDER_CAP);
  const out: DetailedHolder[] = [];
  for (const row of rows) {
    const resolved = await resolvePerson(ctx, row.personId, nameSuffix);
    if (!resolved) continue;
    out.push({
      personId: row.personId,
      ...resolved,
      createdAt: row.createdAt,
      grantedBy: row.grantedBy ?? null,
    });
  }
  return out;
}

/** The SHARED chapter-chart `seatDefs`, sorted by `sortOrder`. Callers that
 *  need this for more than one chapter (a full-tree read, or deriving the
 *  chapter-chart root) should fetch it ONCE and reuse the result — the whole
 *  point of hoisting this out is that the 9 rows are IDENTICAL across every
 *  chapter, so re-querying per chapter is pure waste. */
async function fetchChapterChartDefs(ctx: QueryCtx): Promise<Doc<"seatDefs">[]> {
  return (
    await ctx.db
      .query("seatDefs")
      .withIndex("by_chart", (q) => q.eq("chart", "chapter"))
      .take(MAX_CHART_SEATS)
  ).sort((a, b) => a.sortOrder - b.sortOrder);
}

/** The chapter chart's ROOT seat def (`parentSlug === SEAT_ROOT`) — the seat
 *  whose per-chapter holder (the chapter director) rolls up into the central
 *  `chapter_directors` derived seat. `null` only if the chapter chart hasn't
 *  been seeded yet. */
function findChapterRootDef(
  chapterChartDefs: Doc<"seatDefs">[],
): Doc<"seatDefs"> | null {
  return chapterChartDefs.find((d) => d.parentSlug === SEAT_ROOT) ?? null;
}

/** Every chapter, bounded the same way `org.listChaptersForPeek` bounds its
 *  scan. `context` names the caller for the truncation warning, mirroring
 *  the `[finances]`-prefixed `ROLLUP_SCAN_LIMIT` logging convention used
 *  throughout `finances.ts`/`transfers.ts`/`financeRoles.ts`. */
async function boundedChapters(
  ctx: QueryCtx,
  context: string,
): Promise<Doc<"chapters">[]> {
  const chapters = await ctx.db.query("chapters").take(ROLLUP_SCAN_LIMIT);
  if (chapters.length === ROLLUP_SCAN_LIMIT) {
    console.warn(
      `[seats] ${context} hit ROLLUP_SCAN_LIMIT (${ROLLUP_SCAN_LIMIT}) chapters; results truncated until paginated chapter enumeration lands.`,
    );
  }
  return chapters;
}

/** A derived seat's computed holders: every chapter's holder(s) of the
 *  chapter chart's root seat, each labeled with its chapter's name. Takes
 *  the chapter list as a parameter so callers that already have it (a
 *  full-tree read) don't re-scan the `chapters` table. */
async function detailedDerivedHolders(
  ctx: QueryCtx,
  chapterRootDefId: Id<"seatDefs">,
  chapters: Doc<"chapters">[],
): Promise<DetailedHolder[]> {
  const out: DetailedHolder[] = [];
  for (const chapter of chapters) {
    out.push(
      ...(await detailedHoldersForScope(
        ctx,
        chapter._id,
        chapterRootDefId,
        chapter.name,
      )),
    );
  }
  return out;
}

function toChartHolder(h: DetailedHolder) {
  return { personId: h.personId, name: h.name, imageUrl: h.imageUrl };
}

function buildNode(
  def: Doc<"seatDefs">,
  holders: ReturnType<typeof toChartHolder>[],
) {
  return {
    defId: def._id,
    slug: def.slug,
    title: def.title,
    parentSlug: def.parentSlug,
    maxHolders: def.maxHolders,
    derived: def.derived === true,
    sortOrder: def.sortOrder,
    holders,
    vacant: holders.length === 0,
  };
}

/** Every central-chart seat, sorted by `sortOrder`, with holders resolved —
 *  the derived `chapter_directors` seat via rollup, every other seat via its
 *  own `"central"`-scoped assignments.
 *
 *  `opts` lets a caller that ALREADY has the chapter-chart defs and/or the
 *  chapters list (a full-tree read) pass them in, so this never re-scans
 *  either table on top of the caller's own reads. Standalone callers
 *  (`scope: "central"`) omit `opts` and this fetches what it needs itself. */
async function centralSeats(
  ctx: QueryCtx,
  opts?: { chapterChartDefs?: Doc<"seatDefs">[]; chapters?: Doc<"chapters">[] },
) {
  const defs = (
    await ctx.db
      .query("seatDefs")
      .withIndex("by_chart", (q) => q.eq("chart", "central"))
      .take(MAX_CHART_SEATS)
  ).sort((a, b) => a.sortOrder - b.sortOrder);

  const chapterChartDefs = opts?.chapterChartDefs ?? (await fetchChapterChartDefs(ctx));
  const chapterRootDef = findChapterRootDef(chapterChartDefs);
  const chapters = chapterRootDef
    ? (opts?.chapters ?? (await boundedChapters(ctx, "central chart derived-seat rollup")))
    : [];

  const nodes = [];
  for (const def of defs) {
    const holders =
      def.derived === true
        ? chapterRootDef
          ? await detailedDerivedHolders(ctx, chapterRootDef._id, chapters)
          : []
        : await detailedHoldersForScope(ctx, "central", def._id);
    nodes.push(buildNode(def, holders.map(toChartHolder)));
  }
  return nodes;
}

/** One chapter's chart: the SHARED chapter-chart seat defs (fetched ONCE by
 *  the caller and passed in — never re-queried per chapter), each resolved
 *  against THIS chapter's own occupancy. */
async function chapterSeats(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
  chapterChartDefs: Doc<"seatDefs">[],
) {
  const nodes = [];
  for (const def of chapterChartDefs) {
    const holders = await detailedHoldersForScope(ctx, chapterId, def._id);
    nodes.push(buildNode(def, holders.map(toChartHolder)));
  }
  return nodes;
}

// ── Queries ──────────────────────────────────────────────────────────────────

/**
 * The org chart, at one of three granularities:
 *  - `scope: "central"` → just the central chart's seats.
 *  - `scope: <chapterId>` → just that chapter's chart (shared shape, its own
 *    occupancy).
 *  - `scope` omitted → the FULL tree: the central chart plus every chapter's
 *    subtree (chapter enumeration bounded like `org.listChaptersForPeek`).
 */
export const chart = query({
  args: {
    scope: v.optional(v.union(v.id("chapters"), v.literal("central"))),
  },
  returns: v.union(
    v.object({ kind: v.literal("central"), seats: v.array(seatNodeValidator) }),
    v.object({
      kind: v.literal("chapter"),
      chapterId: v.id("chapters"),
      chapterName: v.string(),
      seats: v.array(seatNodeValidator),
    }),
    v.object({
      kind: v.literal("full"),
      central: v.array(seatNodeValidator),
      chapters: v.array(chapterSubtreeValidator),
    }),
  ),
  handler: async (ctx, { scope }) => {
    await requireAccess(ctx);

    if (scope === "central") {
      return { kind: "central" as const, seats: await centralSeats(ctx) };
    }

    if (scope !== undefined) {
      const chapter = await ctx.db.get(scope);
      if (!chapter) {
        throw new ConvexError({
          code: "NOT_FOUND",
          message: "That chapter doesn't exist.",
        });
      }
      const chapterChartDefs = await fetchChapterChartDefs(ctx);
      return {
        kind: "chapter" as const,
        chapterId: chapter._id,
        chapterName: chapter.name,
        seats: await chapterSeats(ctx, chapter._id, chapterChartDefs),
      };
    }

    // Full tree: hoist the chapter-chart defs (shared, identical across every
    // chapter) and the chapters list to a SINGLE fetch each, reused by every
    // chapter's subtree below AND by `centralSeats`' derived-seat rollup —
    // avoids the N+1 fan-out / duplicate table scan a naive per-chapter call
    // to `chapterSeats`/`centralSeats` would otherwise do.
    const chapterChartDefs = await fetchChapterChartDefs(ctx);
    const chapters = await boundedChapters(ctx, "full-tree chart read");
    const central = await centralSeats(ctx, { chapterChartDefs, chapters });
    const chapterNodes = await Promise.all(
      [...chapters]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(async (c) => ({
          chapterId: c._id,
          chapterName: c.name,
          seats: await chapterSeats(ctx, c._id, chapterChartDefs),
        })),
    );
    return { kind: "full" as const, central, chapters: chapterNodes };
  },
});

/** One seat's full detail (duties/capabilities/holders) at a scope. For a
 *  `derived` seat the `scope` argument is accepted (so callers can pass the
 *  scope they clicked from a `chart()` node uniformly) but ignored — its
 *  holders always come from the cross-chapter rollup. */
export const seatDetail = query({
  args: {
    defId: v.id("seatDefs"),
    scope: v.union(v.id("chapters"), v.literal("central")),
  },
  returns: v.union(
    v.null(),
    v.object({
      defId: v.id("seatDefs"),
      slug: v.string(),
      title: v.string(),
      chart: seatChartValidator,
      duties: v.array(v.string()),
      capabilities: v.array(seatCapabilityValidator),
      maxHolders: v.number(),
      derived: v.boolean(),
      holders: v.array(
        v.object({
          personId: v.id("people"),
          name: v.string(),
          imageUrl: v.union(v.string(), v.null()),
          createdAt: v.number(),
          grantedBy: v.union(v.id("users"), v.null()),
        }),
      ),
      createdAt: v.number(),
      updatedAt: v.number(),
    }),
  ),
  handler: async (ctx, { defId, scope }) => {
    await requireAccess(ctx);

    const def = await ctx.db.get(defId);
    if (!def) return null;

    const isDerived = def.derived === true;
    if (!isDerived) {
      // Guard against a scope/chart mismatch (e.g. passing a chapter id for a
      // central-chart seat) — a caller error, not silently-empty holders.
      if (def.chart === "central" && scope !== "central") {
        throw new ConvexError({
          code: "INVALID_SCOPE",
          message: "This seat belongs to the central chart.",
        });
      }
      if (def.chart === "chapter" && scope === "central") {
        throw new ConvexError({
          code: "INVALID_SCOPE",
          message: "This seat belongs to a chapter chart — pass a chapter id.",
        });
      }
    }

    const holders = isDerived
      ? (async () => {
          const chapterRootDef = findChapterRootDef(
            await fetchChapterChartDefs(ctx),
          );
          if (!chapterRootDef) return [];
          const chapters = await boundedChapters(
            ctx,
            "seat detail derived-seat rollup",
          );
          return await detailedDerivedHolders(ctx, chapterRootDef._id, chapters);
        })()
      : detailedHoldersForScope(ctx, scope, defId);

    return {
      defId: def._id,
      slug: def.slug,
      title: def.title,
      chart: def.chart,
      duties: def.duties,
      capabilities: def.capabilities,
      maxHolders: def.maxHolders,
      derived: isDerived,
      holders: await holders,
      createdAt: def.createdAt,
      updatedAt: def.updatedAt,
    };
  },
});

/**
 * The caller's own seat assignments, across every roster (`people`) row tied
 * to their user — mirrors `financeRoles.mySeats`' user→people walk, skipping
 * placeholder rows. Unlike `mySeats` (which resolves the strongest role PER
 * scope), this returns every individual assignment row: a person can hold
 * several distinct seats at once (e.g. `treasurer` and `event_organizers`).
 */
export const mySeatAssignments = query({
  args: {},
  returns: v.array(
    v.object({
      assignmentId: v.id("seatAssignments"),
      seatDefId: v.id("seatDefs"),
      slug: v.string(),
      title: v.string(),
      chart: seatChartValidator,
      scope: v.union(v.id("chapters"), v.literal("central")),
      scopeName: v.string(),
      createdAt: v.number(),
    }),
  ),
  handler: async (ctx) => {
    // Aligns with `chart`/`seatDetail`: every read here is gated ONLY by
    // `requireAccess` (org-transparent), never a bare `requireUserId` — a
    // signed-in-but-unapproved caller (Convex auth has no framework-level
    // domain restriction; see `lib/access.ts`) must not slip through.
    await requireAccess(ctx);
    const userId = (await requireUserId(ctx)) as Id<"users">;
    const peopleRows = await ctx.db
      .query("people")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    const realPeople = peopleRows.filter((p) => p.isPlaceholder !== true);

    const assignments = (
      await Promise.all(
        realPeople.map((p) =>
          ctx.db
            .query("seatAssignments")
            .withIndex("by_person", (q) => q.eq("personId", p._id))
            .collect(),
        ),
      )
    ).flat();

    const results = [];
    for (const a of assignments) {
      const def = await ctx.db.get(a.seatDefId);
      if (!def) continue; // stale assignment on a deleted def

      let scopeName: string;
      if (a.scope === "central") {
        scopeName = "Central";
      } else {
        const chapter = await ctx.db.get(a.scope);
        if (!chapter) continue; // stale assignment on a deleted chapter
        scopeName = chapter.name;
      }

      results.push({
        assignmentId: a._id,
        seatDefId: def._id,
        slug: def.slug,
        title: def.title,
        chart: def.chart,
        scope: a.scope,
        scopeName,
        createdAt: a.createdAt,
      });
    }
    results.sort((a, b) => a.createdAt - b.createdAt);
    return results;
  },
});

// ── Write mutations (assign / unassign) ─────────────────────────────────────
//
// Super-admin gated (v1 — mirrors `specializedRoles.ts`'s gating; a later PR
// may widen this to seat-capability-gated self-service delegation). A seat
// with a `legacyTitle` write-throughs to the legacy `specializedRoles` table
// (+ its finance bridge) via the SHARED implementation extracted above, so
// every existing finance gate that reads `specializedRoles`/`financeRoles`
// keeps seeing exactly the rows it sees today — assigning a seat and assigning
// the equivalent specialized role produce byte-for-byte the same legacy state.

/** Bounded read of a (scope, seatDefId) slot's occupants — `MULTI_HOLDER_CAP`
 *  is the hard ceiling on any seat's holder count (single-holder seats never
 *  have more than one row in practice, but this bound is universal). */
const MAX_SLOT_READ = MULTI_HOLDER_CAP + 1;

/**
 * Org-chart SoD groups: the "approve-side" (leadership: ED / chapter director)
 * and "record-side" (finance: financial manager / treasurer) seats — derived
 * from `SEAT_DEFS`' `legacyTitle` + `titleKind`, NOT hardcoded string pairs, so
 * the grouping can never drift from the legacy taxonomy it mirrors. A person
 * may not hold seats from both groups in the SAME scope (mirrors
 * `specializedRoles`' scope-local leadership/finance SoD rule exactly).
 */
const APPROVE_SEAT_SLUGS: ReadonlySet<string> = new Set(
  SEAT_IDS.filter((id) => {
    const legacy = SEAT_DEFS[id].legacyTitle;
    return legacy !== undefined && titleKind(legacy) === "leadership";
  }),
);
const RECORD_SEAT_SLUGS: ReadonlySet<string> = new Set(
  SEAT_IDS.filter((id) => {
    const legacy = SEAT_DEFS[id].legacyTitle;
    return legacy !== undefined && titleKind(legacy) === "finance";
  }),
);

// Fail LOUDLY at module load, not silently at runtime, if a future edit to
// the shared seat template changes this shape (e.g. drops a `legacyTitle`, or
// `titleKind` stops mapping one of them to leadership/finance). Today there
// are exactly 2 seats per group (executive_director/chapter_director;
// financial_manager/treasurer) — if that ever isn't true, `seatSodGroup()`
// would silently return `null` more (or differently) than intended and SoD
// enforcement would quietly weaken. Throwing here instead trips on deploy.
if (APPROVE_SEAT_SLUGS.size !== 2) {
  throw new Error(
    `seats.ts: expected exactly 2 approve-side SoD seats, found ${APPROVE_SEAT_SLUGS.size} (${[...APPROVE_SEAT_SLUGS].join(", ")}). The shared seat template's legacyTitle/titleKind shape changed — update the SoD grouping deliberately.`,
  );
}
if (RECORD_SEAT_SLUGS.size !== 2) {
  throw new Error(
    `seats.ts: expected exactly 2 record-side SoD seats, found ${RECORD_SEAT_SLUGS.size} (${[...RECORD_SEAT_SLUGS].join(", ")}). The shared seat template's legacyTitle/titleKind shape changed — update the SoD grouping deliberately.`,
  );
}

/** Which SoD group (if any) a seat def belongs to. Only the 4 seats bridging
 *  to a leadership/finance `specializedRoles` title participate — every other
 *  seat (no `legacyTitle`, or a `legacyTitle` outside those groups) is `null`. */
function seatSodGroup(def: Doc<"seatDefs">): "approve" | "record" | null {
  if (APPROVE_SEAT_SLUGS.has(def.slug)) return "approve";
  if (RECORD_SEAT_SLUGS.has(def.slug)) return "record";
  return null;
}

/** True iff `personId` already holds some OTHER seat in `group` at `scope`. */
async function personHoldsOtherGroupSeatInScope(
  ctx: MutationCtx,
  personId: Id<"people">,
  scope: Id<"chapters"> | "central",
  group: "approve" | "record",
): Promise<boolean> {
  const assignments = await ctx.db
    .query("seatAssignments")
    .withIndex("by_person", (q) => q.eq("personId", personId))
    .take(200);
  for (const a of assignments) {
    if (a.scope !== scope) continue;
    const otherDef = await ctx.db.get(a.seatDefId);
    if (!otherDef) continue;
    if (seatSodGroup(otherDef) === group) return true;
  }
  return false;
}

/**
 * Reverse a seat's write-through: if `def` has a `legacyTitle`, find the
 * corresponding `specializedRoles` slot (one holder per (scope, title)) and,
 * IF it's still held by the SAME person being removed from the seat, remove
 * it through `removeSpecializedRoleImpl` — which itself only revokes the
 * finance bridge if no other finance specialized role at that scope should
 * keep it alive (the "only-revoke-if-no-other-source" guard). Skips silently
 * if the legacy slot has already diverged (e.g. reassigned directly through
 * `specializedRoles`) — a seat unassign should never delete someone ELSE's
 * legacy role row.
 */
async function reverseSeatWriteThrough(
  ctx: MutationCtx,
  def: Doc<"seatDefs">,
  scope: Id<"chapters"> | "central",
  personId: Id<"people">,
): Promise<void> {
  if (!def.legacyTitle) return;
  const row = await ctx.db
    .query("specializedRoles")
    .withIndex("by_scope_and_title", (q) =>
      q.eq("scope", scope).eq("title", def.legacyTitle!),
    )
    .first();
  if (row && row.personId === personId) {
    await removeSpecializedRoleImpl(ctx, row._id);
  }
}

/** Delete a seat assignment row and reverse its write-through, if any. */
async function deleteSeatAssignment(
  ctx: MutationCtx,
  assignment: Doc<"seatAssignments">,
  def: Doc<"seatDefs">,
): Promise<void> {
  await ctx.db.delete(assignment._id);
  await reverseSeatWriteThrough(ctx, def, assignment.scope, assignment.personId);
}

/**
 * Assign a person to a seat, at a scope. Super-admin only.
 *
 *  - Rejects a `derived` seat (its holders are computed, never assigned).
 *  - Rejects a chart/scope mismatch (central seat ⇔ `scope === "central"`;
 *    chapter seat ⇔ `scope` is a real chapter id).
 *  - Rejects a placeholder or nonexistent person.
 *  - Scope-local SoD: rejects if the person already holds a seat from the
 *    OTHER org-chart group (approve vs record) at this SAME scope.
 *  - `maxHolders === 1`: replaces the incumbent (today's `specializedRoles`
 *    slot semantics), reversing their write-through too. Assigning the
 *    CURRENT holder again is an idempotent no-op (re-affirms the bridge).
 *  - `maxHolders > 1`: rejects at cap; idempotent no-op if already a holder.
 *  - Write-through: a seat with a `legacyTitle` upserts the matching
 *    `specializedRoles` row (+ finance bridge) via the shared helper. Seats
 *    without a `legacyTitle` write nothing to legacy tables.
 *
 * CAVEAT — the "idempotent no-op" re-affirm can still mutate legacy tables
 * under DIVERGENCE. "Idempotent" describes `seatAssignments`: no new row, same
 * assignment id returned. But the re-affirm still calls
 * `assignSpecializedRoleImpl` for the seat's own holder, and that helper
 * enforces "one holder per (scope, legacyTitle) slot" — so if the legacy slot
 * has drifted to a DIFFERENT person B (e.g. reassigned directly through
 * `specializedRoles.assignSpecializedRole` after this seat was assigned to A),
 * re-affirming A's seat EVICTS B from the legacy slot and revokes B's finance
 * bridge, even though nothing changed in `seatAssignments`. This is
 * intentional "seat wins" write-through semantics (the seat is the source of
 * truth once assigned) and it preserves read-parity between the two tables —
 * but it means a caller relying on the no-op label to mean "no legacy-table
 * side effects" would be wrong under divergence. Divergence itself should be
 * rare/transient (both paths write through the same helper), but it IS
 * reachable, e.g. by another actor calling `specializedRoles.
 * assignSpecializedRole` directly on a slot this seat already occupies.
 */
export const assignSeat = mutation({
  args: {
    seatDefId: v.id("seatDefs"),
    scope: v.union(v.id("chapters"), v.literal("central")),
    personId: v.id("people"),
  },
  returns: v.id("seatAssignments"),
  handler: async (ctx, { seatDefId, scope, personId }) => {
    await requireSuperuser(ctx);
    const userId = (await requireUserId(ctx)) as Id<"users">;

    const def = await ctx.db.get(seatDefId);
    if (!def) {
      throw new ConvexError({ code: "NOT_FOUND", message: "That seat doesn't exist." });
    }
    if (def.derived === true) {
      throw new ConvexError({
        code: "DERIVED_SEAT",
        message: "This seat's holders are computed automatically and can't be assigned directly.",
      });
    }

    const scopeIsCentral = scope === "central";
    if (def.chart === "central" && !scopeIsCentral) {
      throw new ConvexError({
        code: "INVALID_SCOPE",
        message: "This seat belongs to the central chart.",
      });
    }
    if (def.chart === "chapter" && scopeIsCentral) {
      throw new ConvexError({
        code: "INVALID_SCOPE",
        message: "This seat belongs to a chapter chart — pass a chapter id.",
      });
    }
    if (!scopeIsCentral) {
      const chapter = await ctx.db.get(scope as Id<"chapters">);
      if (!chapter) {
        throw new ConvexError({ code: "NOT_FOUND", message: "That chapter doesn't exist." });
      }
    }

    const person = await ctx.db.get(personId);
    if (!person) {
      throw new ConvexError({ code: "NOT_FOUND", message: "That person doesn't exist." });
    }
    if (person.isPlaceholder === true) {
      throw new ConvexError({
        code: "INVALID_PERSON",
        message: "A placeholder person can't be assigned a seat.",
      });
    }

    // Existing occupants of this exact (scope, seatDefId) slot.
    const existing = await ctx.db
      .query("seatAssignments")
      .withIndex("by_scope_and_seat", (q) =>
        q.eq("scope", scope).eq("seatDefId", seatDefId),
      )
      .take(MAX_SLOT_READ);
    const sameHolder = existing.find((a) => a.personId === personId);

    // Scope-local SoD — skipped for the idempotent same-holder case (no NEW
    // conflict is introduced by reaffirming a seat someone already holds).
    if (!sameHolder) {
      const group = seatSodGroup(def);
      if (group) {
        const otherGroup = group === "approve" ? "record" : "approve";
        if (await personHoldsOtherGroupSeatInScope(ctx, personId, scope, otherGroup)) {
          throw new ConvexError({
            code: "SOD_VIOLATION",
            message:
              "Separation of duties: one person can't hold both an approve-side and a record-side seat in the same scope.",
          });
        }
      }
    }

    if (sameHolder) {
      // Idempotent no-op for `seatAssignments` — but re-affirm the
      // write-through, mirroring `assignSpecializedRoleImpl`'s own idempotent
      // re-affirm. NOTE: if the legacy (scope, legacyTitle) slot has diverged
      // to a DIFFERENT person, this re-affirm call evicts them and revokes
      // their finance bridge (one-holder-per-slot) — see the CAVEAT on this
      // mutation's doc comment. Legacy tables are NOT guaranteed no-op here.
      if (def.legacyTitle) {
        await assignSpecializedRoleImpl(ctx, userId, {
          personId,
          scope,
          title: def.legacyTitle,
        });
      }
      return sameHolder._id;
    }

    if (def.maxHolders === 1) {
      // Replace the incumbent (today's specializedRoles slot semantics),
      // reversing their write-through the same way `unassignSeat` would.
      for (const incumbent of existing) {
        await deleteSeatAssignment(ctx, incumbent, def);
      }
    } else if (existing.length >= def.maxHolders) {
      throw new ConvexError({
        code: "SEAT_FULL",
        message: `This seat already has its maximum of ${def.maxHolders} holders.`,
      });
    }

    const assignmentId = await ctx.db.insert("seatAssignments", {
      seatDefId,
      scope,
      personId,
      grantedBy: userId,
      createdAt: Date.now(),
    });

    if (def.legacyTitle) {
      await assignSpecializedRoleImpl(ctx, userId, {
        personId,
        scope,
        title: def.legacyTitle,
      });
    }

    return assignmentId;
  },
});

/**
 * Unassign a seat holder. Super-admin only. Deletes the assignment and
 * reverses its write-through (if the seat has a `legacyTitle`) through the
 * same shared helper `assignSeat`'s incumbent-replacement path uses.
 */
export const unassignSeat = mutation({
  args: { assignmentId: v.id("seatAssignments") },
  returns: v.null(),
  handler: async (ctx, { assignmentId }) => {
    await requireSuperuser(ctx);

    const assignment = await ctx.db.get(assignmentId);
    if (!assignment) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "That seat assignment doesn't exist.",
      });
    }

    const def = await ctx.db.get(assignment.seatDefId);
    if (!def) {
      // Stale assignment on a deleted def — nothing to write-through-reverse.
      await ctx.db.delete(assignmentId);
      return null;
    }

    await deleteSeatAssignment(ctx, assignment, def);
    return null;
  },
});
