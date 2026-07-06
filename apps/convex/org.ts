/**
 * Org hierarchy — the manager's view of their team.
 *
 * `workload` answers "what is everyone under this person working on?" in one
 * query: the person's manager + direct reports, plus every member of their
 * subtree (themselves included) with the events they own and the event roles
 * they hold. Manual projects ride along via `api.projects.list` on the client
 * so both stay independently reactive.
 */
import { query } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { getChapterIdOrNull } from "./lib/context";

/** The slim person shape the org surfaces render (no contact details). */
function slim(p: Doc<"people">) {
  return {
    _id: p._id,
    name: p.name,
    role: p.role ?? null,
    managerId: p.managerId ?? null,
  };
}

export const workload = query({
  args: { personId: v.id("people") },
  handler: async (ctx, { personId }) => {
    // Null (not a throw) when missing, so the page can show a calm
    // "no longer exists" state after a deletion instead of an error boundary.
    const chapterId = await getChapterIdOrNull(ctx);
    if (!chapterId) return null;
    const person = await ctx.db.get(personId);
    if (!person || person.chapterId !== chapterId) return null;

    const everyone = await ctx.db
      .query("people")
      .withIndex("by_chapter", (q) => q.eq("chapterId", person.chapterId))
      .collect();
    const roster = everyone.filter((p) => p.isPlaceholder !== true);

    // BFS the subtree from the person following managerId edges. Visited-set
    // guarded so a (theoretically impossible) cycle can't hang the query.
    const childrenOf = new Map<Id<"people">, Doc<"people">[]>();
    for (const p of roster) {
      if (!p.managerId) continue;
      const list = childrenOf.get(p.managerId) ?? [];
      list.push(p);
      childrenOf.set(p.managerId, list);
    }
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
