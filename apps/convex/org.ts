/**
 * Org hierarchy — the manager's view of their team.
 *
 * `nav` is the cheap gate the app shell polls on every screen: just "can this
 * caller manage anyone?" with no roster payload.
 *
 * `overview` tells the Team screen what the caller may manage: whether they're
 * a chapter admin, whether they have reports, and the slice of the roster
 * their Team view may show (whole chapter for admins, their own subtree for
 * managers, nothing otherwise).
 *
 * `workload` answers "what is everyone under this person working on?" in one
 * query: the person's manager + direct reports, plus every member of their
 * subtree (themselves included) with the events they own and the event roles
 * they hold. Manual projects ride along via `api.projects.list` on the client
 * so both stay independently reactive. Access is scoped like `overview`:
 * admins can inspect anyone; everyone else only people in their own subtree.
 */
import { query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { isOperationalEvent, responsibilityAppliesTo } from "@events-os/shared";
import { getChapterIdOrNull } from "./lib/context";
import {
  isChapterAdmin,
  viewerPerson,
  viewerFromRoster,
  chapterRoster,
  buildChildrenOf,
  subtreeNodes,
  subtreeIds,
} from "./lib/org";

/** The slim person shape the org surfaces render (no contact details). */
function slim(p: Doc<"people">) {
  return {
    _id: p._id,
    name: p.name,
    role: p.role ?? null,
    managerId: p.managerId ?? null,
  };
}

/**
 * The tier a caller lands in — the app's derived lobby. Ordered strongest →
 * weakest: an admin outranks a lead outranks a member outranks a volunteer.
 * The nav shows/hides tabs by tier and volunteers are redirected to /briefing.
 */
export const TIER_VALIDATOR = v.union(
  v.literal("admin"),
  v.literal("lead"),
  v.literal("member"),
  v.literal("volunteer"),
);
export type Tier = "admin" | "lead" | "member" | "volunteer";

const NAV_RETURNS = v.object({
  isAdmin: v.boolean(),
  canManage: v.boolean(),
  teamView: v.union(v.literal("org"), v.literal("self"), v.null()),
  selfPersonId: v.union(v.id("people"), v.null()),
  tier: TIER_VALIDATOR,
  tierReasons: v.array(v.string()),
  /** The chapter's display name — the shell shows who you're operating as. */
  chapterName: v.union(v.string(), v.null()),
  /**
   * Whether the Finances tab should show in the nav. True for the `admin`/
   * `lead` tiers (the transition grandfather — nobody loses the tab while
   * seats roll out, an explicit owner decision) OR when the caller holds ANY
   * seat (any scope — central or a chapter) whose `capabilities` include
   * `"nav.finances"`. This is nav VISIBILITY only, not access control: the
   * in-screen finance guards (already seat-aware) stay the real gate.
   */
  showFinances: v.boolean(),
});

/**
 * Seat defs `self` holds that are relevant to duties in `chapterId`: their
 * own chapter-chart seats (`scope === chapterId`) plus every central-chart
 * seat they hold (`scope === "central"`, chapter-independent) — same
 * resolution `responsibilities.chapterSeatHoldings` uses, inlined here via
 * the `by_person` index since this only needs ONE person's holdings, not the
 * whole chapter's roster.
 */
async function selfSeatIds(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
  selfId: Id<"people">,
): Promise<Id<"seatDefs">[]> {
  const rows = await ctx.db
    .query("seatAssignments")
    .withIndex("by_person", (q) => q.eq("personId", selfId))
    .collect();
  return rows
    .filter((r) => r.scope === "central" || r.scope === chapterId)
    .map((r) => r.seatDefId);
}

/** Bound on how many seat assignments a single person can hold, mirroring
 *  `selfSeatIds`/`lib/seats.ts`'s same-purpose limits — generous for a real
 *  person's small handful of seats. */
const PERSON_SEAT_ASSIGNMENT_LIMIT = 200;

/**
 * True iff `personId` holds ANY seat assignment — at ANY scope, central or
 * every chapter, unlike `selfSeatIds`'s chapter-scoped resolution — whose
 * seat def carries the `"nav.finances"` capability. This is a pure nav-
 * visibility check (see `showFinances`'s doc on `NAV_RETURNS`); it does not
 * gate money access anywhere.
 *
 * PERSON-KEYED, not user-keyed like `lib/finance.ts#isCentralEdOrFm` — this
 * only ever gets called with `nav`'s own `self` (the caller's HOME-chapter
 * `people` row from `viewerPerson`), not every `people` row the caller's
 * `userId` owns. `isCentralEdOrFm` deliberately walks every row for the
 * user (mirroring `financeRoles.mySeats`) specifically so a seat on a
 * non-home row still counts; this helper inherits `nav`'s existing
 * home-chapter-only scoping instead of introducing a different one for just
 * this field. Practically: a genuinely multi-chapter user whose
 * `nav.finances` seat hangs off a `people` row OTHER than their home-chapter
 * one won't see it here and falls back to the tier grandfather (still true
 * for admin/lead). This is the same latent gap `lib/context.ts`'s
 * `requireChapterId` doc tracks as `TODO(latent, #143)` — every
 * `viewerPerson`-derived read in `nav`/`lib/org.ts`/`lib/finance.ts`
 * (`tier`, `canManage`, `teamView`, `getFinanceRole`) already only acts on
 * the home-chapter row, so this isn't a new restriction, just one more read
 * that inherits it. Not a bug to fix here — see that TODO for the real fix.
 */
async function hasFinancesNavSeat(
  ctx: QueryCtx,
  personId: Id<"people">,
): Promise<boolean> {
  const assignments = await ctx.db
    .query("seatAssignments")
    .withIndex("by_person", (q) => q.eq("personId", personId))
    .take(PERSON_SEAT_ASSIGNMENT_LIMIT);
  for (const assignment of assignments) {
    const def = await ctx.db.get(assignment.seatDefId);
    if (def?.capabilities.includes("nav.finances")) return true;
  }
  return false;
}

/**
 * Derive the caller's tier by short-circuit — each step a bounded read, the
 * first that matches wins. `tierReasons` collects the short human strings the
 * UI shows in a "why do I see this?" line.
 */
async function deriveTier(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
  isAdmin: boolean,
  canManage: boolean,
  self: Doc<"people"> | null,
): Promise<{ tier: Tier; tierReasons: string[] }> {
  if (isAdmin)
    return { tier: "admin", tierReasons: ["You're a chapter admin"] };
  if (canManage)
    return { tier: "lead", tierReasons: ["You manage direct reports"] };

  if (self) {
    // Owns a duty? Chapter-scoped, small — a bounded read, tested against the
    // caller's roster row exactly as the Duties grid fans them out. `seatIds`
    // is CRITICAL here: a seat-mapped duty ignores its legacy `assigneeRoles`
    // entirely (see `responsibilityAppliesTo`), so without it a caller who
    // owns a duty purely via a held seat would silently fall through to
    // "member" tier instead of "lead".
    const duties = await ctx.db
      .query("responsibilities")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
      .take(500);
    const seatIds = await selfSeatIds(ctx, chapterId, self._id);
    const owned = duties.find((r) =>
      responsibilityAppliesTo(r, { ...self, seatIds }),
    );
    if (owned)
      return {
        tier: "lead",
        tierReasons: [`You own the duty "${owned.title}"`],
      };

    if (self.isTeamMember === true)
      return { tier: "member", tierReasons: ["You're a core team member"] };

    const anyRole = await ctx.db
      .query("roleAssignments")
      .withIndex("by_person", (q) => q.eq("personId", self._id))
      .first();
    if (anyRole !== null)
      return { tier: "member", tierReasons: ["You hold a role on an event"] };

    const anyEngagement = await ctx.db
      .query("engagements")
      .withIndex("by_person", (q) => q.eq("personId", self._id))
      .first();
    if (anyEngagement !== null)
      return {
        tier: "volunteer",
        tierReasons: ["You're signed up to volunteer"],
      };
  }

  return { tier: "member", tierReasons: ["Default team access"] };
}

/**
 * The cheap manage-gate for navigation: no roster payload, no storage URLs.
 * The app shell subscribes to this on every screen, so it reads only the
 * caller's membership, their own roster row, and whether one report exists.
 * Also carries the derived `tier` + `tierReasons` the lobby switches on.
 */
export const nav = query({
  args: {},
  returns: NAV_RETURNS,
  handler: async (ctx) => {
    const chapterId = await getChapterIdOrNull(ctx);
    if (!chapterId) {
      return {
        isAdmin: false,
        canManage: false,
        teamView: null,
        selfPersonId: null,
        tier: "member" as const,
        tierReasons: ["You're not in a chapter yet"],
        chapterName: null,
        showFinances: false,
      };
    }
    const chapter = await ctx.db.get(chapterId as Id<"chapters">);
    const isAdmin = await isChapterAdmin(ctx, chapterId as Id<"chapters">);
    const self = await viewerPerson(ctx, chapterId as Id<"chapters">);
    let canManage = isAdmin;
    if (!canManage && self) {
      const firstReport = await ctx.db
        .query("people")
        .withIndex("by_manager", (q) => q.eq("managerId", self._id))
        .first();
      canManage = firstReport !== null;
    }
    // Team-surface policy, stated ONCE for every client. Read is transparent:
    // the whole org view for admins, managers, AND every roster member (so
    // everyone can see the reporting chain they're in and the team's workload).
    // Only a caller with no roster row (and not an admin) gets nothing. The
    // legacy "self" value is retired — the org view leads with the caller's own
    // work either way. AppShell and the Team tab both switch on this.
    const teamView: "org" | "self" | null =
      canManage || self ? "org" : null;
    const { tier, tierReasons } = await deriveTier(
      ctx,
      chapterId as Id<"chapters">,
      isAdmin,
      canManage,
      self,
    );
    // Finances tab visibility: tier admin/lead (transition grandfather — see
    // `showFinances`'s doc) OR a held `nav.finances` seat. Placeholder rows
    // never reach here as `self` — `viewerPerson` already excludes them.
    const showFinances =
      tier === "admin" ||
      tier === "lead" ||
      (self != null && (await hasFinancesNavSeat(ctx, self._id)));
    return {
      isAdmin,
      canManage,
      teamView,
      selfPersonId: self?._id ?? null,
      tier,
      tierReasons,
      chapterName: chapter?.name ?? null,
      showFinances,
    };
  },
});

/** What the caller may manage, and the roster slice their Team view shows. */
export const overview = query({
  args: {},
  handler: async (ctx) => {
    const chapterId = await getChapterIdOrNull(ctx);
    if (!chapterId) {
      return {
        isAdmin: false,
        selfPersonId: null,
        canManage: false,
        people: [],
      };
    }

    const [isAdmin, roster] = await Promise.all([
      isChapterAdmin(ctx, chapterId as Id<"chapters">),
      chapterRoster(ctx, chapterId as Id<"chapters">),
    ]);
    const childrenOf = buildChildrenOf(roster);
    const viewer = await viewerFromRoster(ctx, roster);
    const hasReports =
      viewer != null && (childrenOf.get(viewer._id) ?? []).length > 0;
    const canManage = isAdmin || hasReports;

    // Read-transparency: the whole team may see the whole org — admins and
    // every roster member get the full chapter roster (managing still gates on
    // `canManage`). Only a caller with no roster row (and not an admin) sees
    // nothing to show.
    const visible: Doc<"people">[] = isAdmin || viewer ? roster : [];

    return {
      isAdmin,
      selfPersonId: viewer?._id ?? null,
      canManage,
      people: await Promise.all(
        visible.map(async (p) => ({
          ...slim(p),
          isTeamMember: p.isTeamMember === true || p.userId != null,
          imageUrl: p.image ? await ctx.storage.getUrl(p.image) : null,
        })),
      ),
    };
  },
});

export const workload = query({
  args: { personId: v.id("people") },
  handler: async (ctx, { personId }) => {
    // Null (not a throw) when missing OR out of the caller's scope, so the
    // page shows a calm "not found" state and existence isn't leaked.
    const chapterId = await getChapterIdOrNull(ctx);
    if (!chapterId) return null;
    const person = await ctx.db.get(personId);
    if (!person || person.chapterId !== chapterId) return null;

    const [isAdmin, roster] = await Promise.all([
      isChapterAdmin(ctx, chapterId as Id<"chapters">),
      chapterRoster(ctx, chapterId as Id<"chapters">),
    ]);
    const childrenOf = buildChildrenOf(roster);

    // READ scope (transparency): admins and every roster member may inspect
    // anyone in the chapter — the whole team sees the whole workload. A caller
    // with no roster row (and not an admin) gets null.
    const viewer = await viewerFromRoster(ctx, roster);
    if (!isAdmin && !viewer) return null;

    // MANAGE scope stays tight: admins may manage anyone (`manageReach` null =
    // unrestricted); everyone else only their own manager subtree (themselves
    // included). This drives owner-editing, quick-add and 1:1 affordances.
    const manageReach: Set<Id<"people">> | null = isAdmin
      ? null
      : subtreeIds(childrenOf, viewer!);
    const caller = {
      personId: viewer?._id ?? null,
      // Whether the caller is a manager or admin — the capability that gates
      // duty editing (chapter-wide) and owner reassignment. A report-less
      // member's subtree is just themselves (size 1), so they're not a manager.
      canManage: manageReach === null || manageReach.size > 1,
      // The people the caller may MANAGE (null = admin/all): their own subtree,
      // themselves included. The client gates per-person project affordances
      // (add project, editable vs read-only cards) on membership here.
      manageableIds: manageReach === null ? null : [...manageReach],
    };

    // Events owned by anyone in the subtree (one chapter-wide read, then
    // split). Academy training sandboxes are filtered out up front, which
    // also drops role-assignment rows pointing at them (their event lookup
    // below misses) — a learner's practice run is not Team workload.
    const events = (
      await ctx.db
        .query("events")
        .withIndex("by_chapter", (q) => q.eq("chapterId", person.chapterId))
        .collect()
    ).filter(isOperationalEvent);
    const eventById = new Map(events.map((e) => [e._id, e]));
    // Role docs are shared across assignments — fetch each unique role once.
    const roleCache = new Map<Id<"eventRoles">, Doc<"eventRoles"> | null>();
    const getRole = async (roleId: Id<"eventRoles">) => {
      if (!roleCache.has(roleId))
        roleCache.set(roleId, await ctx.db.get(roleId));
      return roleCache.get(roleId) ?? null;
    };

    const members = await Promise.all(
      subtreeNodes(childrenOf, person).map(async ({ person: p, depth }) => {
        const ownedEvents = events
          .filter((e) => e.ownerPersonId === p._id)
          .sort((a, b) => b.eventDate - a.eventDate)
          .map((e) => ({
            _id: e._id,
            name: e.name,
            eventDate: e.eventDate,
            status: e.status,
          }));

        // Event roles this person holds (module leadership lives here).
        const assignments = await ctx.db
          .query("roleAssignments")
          .withIndex("by_person", (q) => q.eq("personId", p._id))
          .collect();
        const roles = (
          await Promise.all(
            assignments.map(async (a) => {
              const event = eventById.get(a.eventId);
              const role = await getRole(a.roleId);
              if (!event || !role) return null;
              return {
                eventId: a.eventId,
                eventName: event.name,
                eventDate: event.eventDate,
                roleLabel: role.label,
              };
            }),
          )
        )
          .filter((r): r is NonNullable<typeof r> => r !== null)
          .sort((a, b) => b.eventDate - a.eventDate);

        return {
          ...slim(p),
          depth,
          isSelf: p._id === person._id,
          events: ownedEvents,
          roles,
        };
      }),
    );

    const manager = person.managerId
      ? (roster.find((p) => p._id === person.managerId) ?? null)
      : null;
    const reports = (childrenOf.get(person._id) ?? []).sort((a, b) =>
      a.name.localeCompare(b.name),
    );

    return {
      person: { ...slim(person), email: person.email ?? null },
      caller,
      manager: manager
        ? {
            ...slim(manager),
            // Read is transparent now — anyone on the roster may open the
            // manager's own workload page, so the link is always live.
            viewable: true,
          }
        : null,
      reports: reports.map((r) => ({
        ...slim(r),
        reportCount: (childrenOf.get(r._id) ?? []).length,
      })),
      members,
    };
  },
});
