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
import { Doc, Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { isOperationalEvent } from "@events-os/shared";
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
 * The cheap manage-gate for navigation: no roster payload, no storage URLs.
 * The app shell subscribes to this on every screen, so it reads only the
 * caller's membership, their own roster row, and whether one report exists.
 */
export const nav = query({
  args: {},
  handler: async (ctx) => {
    const chapterId = await getChapterIdOrNull(ctx);
    if (!chapterId) {
      return { isAdmin: false, canManage: false, selfPersonId: null };
    }
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
    // The three-way Team-surface policy, stated ONCE for every client: the
    // org view for managers/admins, your own workload with a roster row,
    // nothing otherwise. AppShell and the Team tab both switch on this.
    const teamView: "org" | "self" | null = canManage
      ? "org"
      : self
        ? "self"
        : null;
    return { isAdmin, canManage, teamView, selfPersonId: self?._id ?? null };
  },
});

/** What the caller may manage, and the roster slice their Team view shows. */
export const overview = query({
  args: {},
  handler: async (ctx) => {
    const chapterId = await getChapterIdOrNull(ctx);
    if (!chapterId) {
      return { isAdmin: false, selfPersonId: null, canManage: false, people: [] };
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

    let visible: Doc<"people">[] = [];
    if (isAdmin) {
      visible = roster;
    } else if (viewer && hasReports) {
      const ids = subtreeIds(childrenOf, viewer);
      visible = roster.filter((p) => ids.has(p._id));
    }

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

    // Scope: admins may inspect anyone; others only their own subtree. The
    // caller's reach also decides whether the manager link is tappable and
    // whether owner-editing affordances render (canManage).
    const viewer = await viewerFromRoster(ctx, roster);
    let callerReach: Set<Id<"people">> | null = null; // null = unrestricted
    if (!isAdmin) {
      if (!viewer) return null;
      callerReach = subtreeIds(childrenOf, viewer);
      if (!callerReach.has(personId)) return null;
    }
    const caller = {
      personId: viewer?._id ?? null,
      // Admins, or anyone whose subtree extends beyond themselves.
      canManage: isAdmin || (callerReach !== null && callerReach.size > 1),
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
      if (!roleCache.has(roleId)) roleCache.set(roleId, await ctx.db.get(roleId));
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

        return { ...slim(p), depth, isSelf: p._id === person._id, events: ownedEvents, roles };
      }),
    );

    const manager = person.managerId
      ? roster.find((p) => p._id === person.managerId) ?? null
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
            // Whether the CALLER may open the manager's own workload page —
            // false for a non-admin viewing their own boss.
            viewable: callerReach === null || callerReach.has(manager._id),
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
