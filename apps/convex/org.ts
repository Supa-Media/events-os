/**
 * Org hierarchy — the manager's view of their team.
 *
 * `overview` tells the client what the caller may manage: whether they're a
 * chapter admin, whether they have reports, and the slice of the roster their
 * Team view may show (whole chapter for admins, their own subtree for
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
import { getChapterIdOrNull } from "./lib/context";
import {
  isChapterAdmin,
  viewerPerson,
  chapterRoster,
  buildChildrenOf,
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

/** What the caller may manage, and the roster slice their Team view shows. */
export const overview = query({
  args: {},
  handler: async (ctx) => {
    const none = {
      isAdmin: false,
      selfPersonId: null as Id<"people"> | null,
      canManage: false,
      people: [] as Array<
        ReturnType<typeof slim> & { isTeamMember: boolean; imageUrl: string | null }
      >,
    };
    const chapterId = await getChapterIdOrNull(ctx);
    if (!chapterId) return none;

    const isAdmin = await isChapterAdmin(ctx);
    const roster = await chapterRoster(ctx, chapterId as Id<"chapters">);
    const childrenOf = buildChildrenOf(roster);
    const viewer = await viewerPerson(ctx, chapterId as Id<"chapters">);
    const hasReports =
      viewer != null && (childrenOf.get(viewer._id) ?? []).length > 0;
    const canManage = isAdmin || hasReports;

    let visible: Doc<"people">[] = [];
    if (isAdmin) {
      visible = roster;
    } else if (viewer && hasReports) {
      const ids = subtreeIds(childrenOf, viewer._id);
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

    const roster = await chapterRoster(ctx, chapterId as Id<"chapters">);
    const childrenOf = buildChildrenOf(roster);

    // Scope: admins may inspect anyone; others only their own subtree.
    if (!(await isChapterAdmin(ctx))) {
      const viewer = await viewerPerson(ctx, chapterId as Id<"chapters">);
      if (!viewer) return null;
      if (!subtreeIds(childrenOf, viewer._id).has(personId)) return null;
    }

    // BFS the subtree from the person following managerId edges, depth-tagged.
    const byName = (a: Doc<"people">, b: Doc<"people">) =>
      a.name.localeCompare(b.name);
    const subtree: { person: Doc<"people">; depth: number }[] = [];
    const visited = new Set<Id<"people">>([person._id]);
    const queue: { person: Doc<"people">; depth: number }[] = [
      { person, depth: 0 },
    ];
    while (queue.length > 0) {
      const node = queue.shift()!;
      subtree.push(node);
      for (const child of (childrenOf.get(node.person._id) ?? []).sort(byName)) {
        if (visited.has(child._id)) continue;
        visited.add(child._id);
        queue.push({ person: child, depth: node.depth + 1 });
      }
    }

    // Events owned by anyone in the subtree (one chapter-wide read, then split).
    const events = await ctx.db
      .query("events")
      .withIndex("by_chapter", (q) => q.eq("chapterId", person.chapterId))
      .collect();
    const eventById = new Map(events.map((e) => [e._id, e]));

    const members = await Promise.all(
      subtree.map(async ({ person: p, depth }) => {
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
              const role = await ctx.db.get(a.roleId);
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
    const reports = (childrenOf.get(person._id) ?? []).sort(byName);

    return {
      person: { ...slim(person), email: person.email ?? null },
      manager: manager ? slim(manager) : null,
      reports: reports.map((r) => ({
        ...slim(r),
        reportCount: (childrenOf.get(r._id) ?? []).length,
      })),
      members,
    };
  },
});
