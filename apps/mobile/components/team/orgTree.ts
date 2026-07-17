/**
 * Work tab tree builder — pure client-side roots/children/rollup logic over
 * `org.overview`'s people list, dependency-free from React so it's directly
 * unit-testable (mirrors `components/orgchart/treeUtils.ts`'s pattern).
 *
 * Extracted from `team.tsx`'s `org` useMemo unchanged (see git history) after
 * the PR #205 regression (multi-seat holders producing a mutual manager
 * cycle server-side made this filter drop entire subtrees — fixed at the
 * source in `@events-os/shared`'s `deriveSeatManagerIds`, see that module's
 * "MUTUAL-SEAT CYCLE TIE-BREAK" doc). `effectiveManagerIds` arriving here is
 * expected to already be cycle-free (server-guaranteed: every edge strictly
 * decreases seat seniority depth) — the `visited`-guarded rollup below is
 * defense in depth, not the primary correctness mechanism.
 */
import type { Id } from "@events-os/convex/_generated/dataModel";

/** The minimal shape this module needs from a roster row — `team.tsx`'s
 *  `OrgPerson` (roster person + display title) satisfies this structurally. */
export type OrgTreePerson = {
  _id: Id<"people">;
  name: string;
  effectiveManagerIds: Id<"people">[];
  isTeamMember: boolean;
};

export type OrgTree<P extends OrgTreePerson> = {
  included: P[];
  includedIds: Set<Id<"people">>;
  childrenOf: Map<Id<"people">, P[]>;
  roots: P[];
  teamSize: Map<Id<"people">, number>;
};

/**
 * Build the Work tab's roots/children/rollup structure from a roster.
 *
 * Included: team members, plus anyone wired into a manager relationship (a
 * report who isn't flagged Team yet, or a manager of someone who is) — so a
 * seat-derived edge always shows up even if neither end is `isTeamMember`.
 *
 * Parenting: a person with multiple effective managers (a multi-holder parent
 * seat) nests under ONE parent — the first entry, deterministically, matching
 * the order `org.workload`'s "Reports to" line resolves them in (both read
 * `effectiveManagerIds`/`personEffectiveManagerIds` the same way). A manager
 * not in `included` (out of roster, or filtered out) makes the person a root.
 */
export function buildOrgTree<P extends OrgTreePerson>(roster: P[]): OrgTree<P> {
  const managerIds = new Set(roster.flatMap((p) => p.effectiveManagerIds));
  const included = roster.filter(
    (p) => p.isTeamMember || p.effectiveManagerIds.length > 0 || managerIds.has(p._id),
  );
  const includedIds = new Set(included.map((p) => p._id));
  const childrenOf = new Map<Id<"people">, P[]>();
  for (const p of included) {
    const managerId = p.effectiveManagerIds[0];
    if (!managerId || !includedIds.has(managerId)) continue;
    const list = childrenOf.get(managerId) ?? [];
    list.push(p);
    childrenOf.set(managerId, list);
  }
  const roots = included.filter((p) => {
    const managerId = p.effectiveManagerIds[0];
    return !managerId || !includedIds.has(managerId);
  });

  // Subtree sizes (people below each node), cycle-safe via visited set — see
  // the module header: defense in depth, the server no longer emits cycles.
  const teamSize = new Map<Id<"people">, number>();
  const sizeOf = (id: Id<"people">, visited: Set<Id<"people">>): number => {
    if (visited.has(id)) return 0;
    visited.add(id);
    let n = 0;
    for (const child of childrenOf.get(id) ?? []) {
      n += 1 + sizeOf(child._id, visited);
    }
    teamSize.set(id, n);
    return n;
  };
  for (const r of roots) sizeOf(r._id, new Set());

  roots.sort(
    (a, b) => (teamSize.get(b._id) ?? 0) - (teamSize.get(a._id) ?? 0) || a.name.localeCompare(b.name),
  );
  for (const list of childrenOf.values()) {
    list.sort(
      (a, b) => (teamSize.get(b._id) ?? 0) - (teamSize.get(a._id) ?? 0) || a.name.localeCompare(b.name),
    );
  }
  return { included, includedIds, childrenOf, roots, teamSize };
}
