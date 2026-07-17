/**
 * Seat-derived manager relationships — a pure algorithm over the org chart's
 * shape (seat defs) and occupancy (seat assignments), independent of Convex so
 * it's directly unit-testable and reusable by any future non-Convex caller.
 * Mirrors `apps/mobile/components/orgchart/treeUtils.ts`'s `computeReportsTo`
 * EXACTLY (the Org Chart tab's client-side "reports to" walk) — but answers
 * "who manages this PERSON" rather than "what does this SEAT node report to".
 *
 * Owner-approved semantics (2026-07-17):
 *  - A person's managers come from EVERY seat they hold: walk up each seat's
 *    `parentSlug` chain, using THAT SEAT's own current holder set (not just
 *    this person — a seat can have co-holders) as the set to exclude, exactly
 *    like the client's `ownHolderIds`.
 *  - The nearest ancestor seat whose holders are NOT fully identical to the
 *    starting seat's holder set wins. A vacant ancestor (no holders) is
 *    trivially "identical to a subset of nothing" so the walk continues past
 *    it; an ancestor held by exactly the SAME person(s) is skipped too — you
 *    don't report to yourself.
 *  - A chapter chart's ROOT seat (`chapter_director`) has no parent within
 *    its own chart. Once the walk exhausts a chapter chart, it crosses into
 *    the CENTRAL chart at `chapterRollupParentSlug` (today
 *    `expansion_director`) — mirroring the server's chapter→central rollup.
 *  - A multi-holder parent seat's ENTIRE holder list are all managers — there
 *    is no stored "primary" pick.
 *  - The true top of the org (the central chart's root) has no manager. This
 *    is a REAL, terminal answer — never a signal to fall back to something
 *    else.
 *  - A person who holds NO seat at all returns `null` — distinct from "holds
 *    a seat but has zero seat-derived managers" — so a caller can fall back
 *    to a pre-seat manager signal (this repo: `people.managerId`) only for
 *    people the seat tree has no opinion about.
 *
 * MUTUAL-SEAT CYCLE TIE-BREAK (2026-07-17, post-#205 regression fix, revised
 * 2026-07-17 after adversarial review — see `orgSeatManagers.test.ts`'s
 * "multi-seat mutual pair" and "cycle-scoped tie-break" describe blocks):
 *
 *  A person who holds MULTIPLE seats gets a candidate manager from EACH seat's
 *  independent walk, unioned together. When two people each hold a senior
 *  central seat AND a junior seat that rolls up through the other's senior
 *  seat, the per-seat walks can produce a genuine two-way edge — e.g. the
 *  Executive Director also holds a chapter's `chapter_director` seat, which
 *  rolls up to the Expansion Director; the Expansion Director also holds
 *  `event_lead` in that same chapter, which rolls up (via `chapter_director`)
 *  back to the Executive Director. Each is correctly derived as a candidate
 *  manager of the other. Left as a mutual edge, EVERY consumer that walks this
 *  as a tree (`buildEffectiveChildrenOf`, the Work tab's client-side
 *  roots/children builder in `team.tsx`) treats "my manager is included in
 *  the roster" as "I am not a root" for BOTH people — so neither becomes a
 *  root, and the entire subtree hanging off them (which, for an ED/expansion-
 *  director pair, is most of the org) never gets attached to anything and
 *  silently vanishes from the tree. Only people with no seat-derived manager
 *  at all (nothing feeding their `out` set) survive as visible roots.
 *
 *  Fix: this is a graph-cycle problem, so it's fixed as one. `deriveSeatManagerIds`
 *  is no longer a purely per-person computation — it consults a RESOLVED
 *  manager graph built once per `(index, centralScope, chapterRollupParentSlug)`
 *  (`buildResolvedManagerGraph`, cached in `resolvedGraphCache`):
 *
 *   1. Compute the RAW per-seat-derived candidate set for every seat-holding
 *      person (`rawSeatManagerIds` — the walk, unfiltered).
 *   2. Find strongly-connected components (Tarjan's algorithm, `tarjanSCCs`)
 *      over that raw graph. Only an SCC of size > 1 is an actual cycle.
 *   3. For every edge `child -> parent` INSIDE such an SCC (both endpoints in
 *      the same cycle), drop the edge unless `parent` is STRICTLY more senior
 *      than `child` — "the central-chart-root-closer person wins as the
 *      parent." Seniority is a person's structural distance to the central
 *      chart's root (`seatDepth`), minimized across EVERY seat they hold, not
 *      just the seat that produced this one edge. Equal-depth ties (not
 *      expected in the current acyclic taxonomy) break deterministically by
 *      comparing person ids. Edges that leave the SCC, or that never touched
 *      a cycle at all, are left completely untouched.
 *
 *  Scoping the filter to cycle-internal edges (rather than a blanket
 *  "candidate must be senior to my BEST seat" compare over every candidate,
 *  which an earlier version of this fix did) matters: a person can
 *  legitimately hold one senior, unrelated central seat (e.g. Development
 *  Director) AND a junior chapter seat whose REAL, non-cyclic manager is
 *  someone with no seat anywhere near as senior (e.g. an NY Event Lead they
 *  volunteer under as an `event_organizers` co-holder). That edge never
 *  participates in a cycle — nothing points back from the Event Lead into the
 *  Development Director — so it must survive untouched. A blanket seniority
 *  compare wrongly drops it (the person's unrelated central seat "outranks"
 *  their real chapter manager), which silently strips that manager's
 *  `buildEffectiveChildrenOf`-derived write authority (`checkIns.log`,
 *  `responsibilities.*` via `requireManagerOrAdmin`) over them. Because every
 *  edge inside a resolved SCC still strictly decreases in seniority once
 *  broken (a residual cycle would require seniority to strictly decrease all
 *  the way around and back to the start, which is impossible for a finite
 *  order), one pass over each SCC is sufficient — no iteration to fixpoint
 *  needed.
 *
 *  In the ED/expansion-director example: the ED (depth 0) and the expansion
 *  director (depth 1) form a 2-node SCC. The ED's edge to the expansion
 *  director fails (the expansion director isn't senior to the ED) and is
 *  dropped — the ED has no manager. The expansion director's edge to the ED
 *  succeeds and is kept. Net: expansion director reports to the ED, never the
 *  reverse — the SAME outcome as the original fix for this case, just no
 *  longer at the cost of dropping unrelated, non-cyclic edges elsewhere.
 */

import { SEAT_ROOT } from "./seats";

/** String sentinel for "this seat IS its chart's root" — re-exported so
 *  callers of this module don't also need to import `seats.ts` directly. Same
 *  value as `SEAT_ROOT` in `seats.ts` (imported, not duplicated, so the two
 *  can never drift). */
export const SEAT_ROOT_SENTINEL: typeof SEAT_ROOT = SEAT_ROOT;

export type SeatChartKind = "central" | "chapter";

export interface SeatManagerSeatDef<SeatDefId extends string> {
  seatDefId: SeatDefId;
  chart: SeatChartKind;
  slug: string;
  parentSlug: string;
}

export interface SeatManagerAssignment<
  SeatDefId extends string,
  PersonId extends string,
  Scope extends string,
> {
  seatDefId: SeatDefId;
  scope: Scope;
  personId: PersonId;
}

/** Precomputed lookup structure — build once per chapter-scoped read, reuse
 *  across every person the caller needs a manager answer for. */
export interface SeatManagerIndex<
  SeatDefId extends string,
  PersonId extends string,
  Scope extends string,
> {
  defById: Map<SeatDefId, SeatManagerSeatDef<SeatDefId>>;
  defBySlug: Map<string, SeatManagerSeatDef<SeatDefId>>;
  holdersByScopeSeat: Map<string, PersonId[]>;
  seatsByPerson: Map<PersonId, { seatDefId: SeatDefId; scope: Scope }[]>;
}

function scopeSeatKey(scope: string, seatDefId: string): string {
  return `${scope}::${seatDefId}`;
}

function chartSlugKey(chart: SeatChartKind, slug: string): string {
  return `${chart}::${slug}`;
}

export function buildSeatManagerIndex<
  SeatDefId extends string,
  PersonId extends string,
  Scope extends string,
>(
  seatDefs: SeatManagerSeatDef<SeatDefId>[],
  seatAssignments: SeatManagerAssignment<SeatDefId, PersonId, Scope>[],
): SeatManagerIndex<SeatDefId, PersonId, Scope> {
  const defById = new Map<SeatDefId, SeatManagerSeatDef<SeatDefId>>();
  const defBySlug = new Map<string, SeatManagerSeatDef<SeatDefId>>();
  for (const def of seatDefs) {
    defById.set(def.seatDefId, def);
    defBySlug.set(chartSlugKey(def.chart, def.slug), def);
  }

  const holdersByScopeSeat = new Map<string, PersonId[]>();
  const seatsByPerson = new Map<PersonId, { seatDefId: SeatDefId; scope: Scope }[]>();
  for (const a of seatAssignments) {
    const key = scopeSeatKey(a.scope, a.seatDefId);
    holdersByScopeSeat.set(key, [...(holdersByScopeSeat.get(key) ?? []), a.personId]);
    seatsByPerson.set(a.personId, [
      ...(seatsByPerson.get(a.personId) ?? []),
      { seatDefId: a.seatDefId, scope: a.scope },
    ]);
  }

  return { defById, defBySlug, holdersByScopeSeat, seatsByPerson };
}

/**
 * `null` — the person holds no seat; the caller should fall back to its own
 * pre-seat manager signal. A (possibly empty) array — the person DOES hold a
 * seat, so this is the AUTHORITATIVE answer (an empty array is real: e.g. the
 * top of the org has no manager).
 */
export type SeatManagerResult<PersonId extends string> = PersonId[] | null;

/** Bounded walk guard — the shared taxonomy is acyclic (see `seats.test.ts`),
 *  this only guards a future DB-editable chart from hanging on a loop. */
const WALK_GUARD = 30;

/** The two index fields seat-depth needs — a structural (chart+slug) lookup,
 *  never occupancy — so it type-checks against a `SeatManagerIndex` of any
 *  `PersonId`/`Scope` without a cast (those type params don't appear here). */
type SeatDefLookup<SeatDefId extends string> = Pick<
  SeatManagerIndex<SeatDefId, string, string>,
  "defById" | "defBySlug"
>;

/**
 * A seat's STRUCTURAL distance to the central chart's root — 0 for the
 * central root itself, +1 per `parentSlug` hop, crossing chapter→central at
 * `chapterRollupParentSlug` exactly like the manager walk. Purely a function
 * of the seat TAXONOMY (chart + slug), never occupancy — every chapter shares
 * the same chapter-chart seat defs, so this is scope-independent and safe to
 * memoize once per index. See the module header's "MUTUAL-SEAT CYCLE
 * TIE-BREAK" section for why this exists.
 */
function seatDepth<SeatDefId extends string>(
  index: SeatDefLookup<SeatDefId>,
  seatDefId: SeatDefId,
  chapterRollupParentSlug: string,
  memo: Map<SeatDefId, number>,
  guard = 0,
): number {
  const cached = memo.get(seatDefId);
  if (cached !== undefined) return cached;
  if (guard >= WALK_GUARD) return Infinity; // defensive — see WALK_GUARD

  const def = index.defById.get(seatDefId);
  if (!def) return Infinity; // dangling — defensive, shouldn't happen

  let depth: number;
  if (def.parentSlug === SEAT_ROOT_SENTINEL) {
    if (def.chart === "central") {
      depth = 0; // the true top of the org
    } else {
      const rollupParent = index.defBySlug.get(
        chartSlugKey("central", chapterRollupParentSlug),
      );
      depth = rollupParent
        ? seatDepth(index, rollupParent.seatDefId, chapterRollupParentSlug, memo, guard + 1) + 1
        : Infinity; // dangling rollup target — defensive, same fail-safe as a dangling seatDefId (least-senior, never wins a manager slot)
    }
  } else {
    const parent = index.defBySlug.get(chartSlugKey(def.chart, def.parentSlug));
    depth = parent
      ? seatDepth(index, parent.seatDefId, chapterRollupParentSlug, memo, guard + 1) + 1
      : Infinity; // dangling parentSlug — defensive, same fail-safe as above (was `0`/most-senior — fail-open bug; a seat structurally cut off from any root must never silently outrank everyone)
  }
  memo.set(seatDefId, depth);
  return depth;
}

/** A person's overall seniority: the shallowest (most senior) of every seat
 *  they hold. `Infinity` for a seatless person — never actually compared
 *  against, since only seat holders can appear as seat-derived candidates. */
function personSeatDepth<SeatDefId extends string, PersonId extends string>(
  index: SeatDefLookup<SeatDefId> & Pick<SeatManagerIndex<SeatDefId, PersonId, string>, "seatsByPerson">,
  personId: PersonId,
  chapterRollupParentSlug: string,
  memo: Map<SeatDefId, number>,
): number {
  const heldSeats = index.seatsByPerson.get(personId);
  if (!heldSeats || heldSeats.length === 0) return Infinity;
  return Math.min(
    ...heldSeats.map((h) => seatDepth(index, h.seatDefId, chapterRollupParentSlug, memo)),
  );
}

/**
 * The RAW per-seat-derived candidate managers for one person — every seat
 * they hold, walked and unioned, with NO cycle-break filtering applied. This
 * is the graph's edge set BEFORE `buildResolvedManagerGraph` prunes
 * cycle-internal backward edges; `deriveSeatManagerIds` never calls this
 * directly (it reads the resolved graph instead) — it exists so the graph
 * builder can compute every seat-holder's raw edges the same way.
 */
function rawSeatManagerIds<
  SeatDefId extends string,
  PersonId extends string,
  Scope extends string,
>(
  index: SeatManagerIndex<SeatDefId, PersonId, Scope>,
  personId: PersonId,
  centralScope: Scope,
  chapterRollupParentSlug: string,
): PersonId[] {
  const heldSeats = index.seatsByPerson.get(personId);
  if (!heldSeats || heldSeats.length === 0) return [];

  const out = new Set<PersonId>();
  for (const held of heldSeats) {
    const seat = index.defById.get(held.seatDefId);
    if (!seat) continue;
    const ownHolderIds = new Set(
      index.holdersByScopeSeat.get(scopeSeatKey(held.scope, held.seatDefId)) ?? [],
    );

    let chart: SeatChartKind = seat.chart;
    let scope: Scope = held.scope;
    let parentSlug = seat.parentSlug;

    for (let guard = 0; guard < WALK_GUARD; guard++) {
      if (parentSlug === SEAT_ROOT_SENTINEL) {
        if (chart === "central") break; // true top of the org
        chart = "central";
        scope = centralScope;
        parentSlug = chapterRollupParentSlug;
        continue;
      }
      const parent = index.defBySlug.get(chartSlugKey(chart, parentSlug));
      if (!parent) break; // dangling parentSlug — defensive, shouldn't happen
      const parentHolders =
        index.holdersByScopeSeat.get(scopeSeatKey(scope, parent.seatDefId)) ?? [];
      const hasNewHolder = parentHolders.some((id) => !ownHolderIds.has(id));
      if (hasNewHolder) {
        // Show ALL of the parent's holders, not just the "new" ones — a
        // multi-holder parent's full roster is what "reports to" means here
        // (matches `treeUtils.ts`'s `computeReportsTo`).
        for (const id of parentHolders) out.add(id);
        break;
      }
      parentSlug = parent.parentSlug;
    }
  }
  return [...out];
}

/**
 * Strongly-connected components of a directed graph (Tarjan's algorithm),
 * over a `PersonId -> PersonId[]` "my managers" adjacency. A component of
 * size 1 is just an ordinary node (no cycle); size > 1 means every member is
 * mutually reachable from every other — a genuine cycle. The seat-manager
 * graph is small (bounded by roster size), so plain recursion is fine.
 */
function tarjanSCCs<PersonId extends string>(
  nodeIds: PersonId[],
  edges: Map<PersonId, PersonId[]>,
): PersonId[][] {
  let counter = 0;
  const indexOf = new Map<PersonId, number>();
  const lowlink = new Map<PersonId, number>();
  const onStack = new Set<PersonId>();
  const stack: PersonId[] = [];
  const components: PersonId[][] = [];

  function strongConnect(v: PersonId) {
    indexOf.set(v, counter);
    lowlink.set(v, counter);
    counter++;
    stack.push(v);
    onStack.add(v);

    for (const w of edges.get(v) ?? []) {
      if (!indexOf.has(w)) {
        strongConnect(w);
        lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v)!, indexOf.get(w)!));
      }
    }

    if (lowlink.get(v) === indexOf.get(v)) {
      const component: PersonId[] = [];
      let w: PersonId;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      components.push(component);
    }
  }

  for (const v of nodeIds) {
    if (!indexOf.has(v)) strongConnect(v);
  }
  return components;
}

/**
 * The resolved manager graph for every seat-holding person in `index`: raw
 * edges (`rawSeatManagerIds`) with cycle-internal backward edges pruned — see
 * the module header's "MUTUAL-SEAT CYCLE TIE-BREAK" section for the full
 * algorithm and why it's scoped to cycle-internal edges only.
 */
function buildResolvedManagerGraph<
  SeatDefId extends string,
  PersonId extends string,
  Scope extends string,
>(
  index: SeatManagerIndex<SeatDefId, PersonId, Scope>,
  centralScope: Scope,
  chapterRollupParentSlug: string,
): Map<PersonId, PersonId[]> {
  const personIds = [...index.seatsByPerson.keys()];

  const raw = new Map<PersonId, PersonId[]>();
  for (const personId of personIds) {
    raw.set(personId, rawSeatManagerIds(index, personId, centralScope, chapterRollupParentSlug));
  }

  const depthMemo = new Map<SeatDefId, number>();
  const seniority = new Map<PersonId, number>();
  for (const personId of personIds) {
    seniority.set(personId, personSeatDepth(index, personId, chapterRollupParentSlug, depthMemo));
  }

  const resolved = new Map<PersonId, Set<PersonId>>();
  for (const [id, managerIds] of raw) resolved.set(id, new Set(managerIds));

  for (const component of tarjanSCCs(personIds, raw)) {
    if (component.length < 2) continue; // a singleton is never a cycle
    const inCycle = new Set(component);
    for (const child of component) {
      const managerIds = resolved.get(child);
      if (!managerIds) continue;
      const childRank = seniority.get(child) ?? Infinity;
      for (const parent of [...managerIds]) {
        if (!inCycle.has(parent)) continue; // edge leaves the cycle — untouched
        const parentRank = seniority.get(parent) ?? Infinity;
        const parentIsMoreSenior =
          parentRank !== childRank ? parentRank < childRank : parent < child;
        if (!parentIsMoreSenior) managerIds.delete(parent);
      }
    }
  }

  const out = new Map<PersonId, PersonId[]>();
  for (const [id, managerIds] of resolved) out.set(id, [...managerIds]);
  return out;
}

/** Caches `buildResolvedManagerGraph` per index object (a fresh index is built
 *  once per chapter-scoped read — see `lib/org.ts`'s `loadSeatManagerIndex` —
 *  and then queried per-person many times over, so this turns an O(roster ×
 *  seats) rebuild into a one-time cost per read). Keyed additionally by
 *  `centralScope`/`chapterRollupParentSlug` since those are call-supplied,
 *  not part of the index itself — defensive, since every real caller passes
 *  the same constants for a given index. */
const resolvedGraphCache = new WeakMap<
  SeatManagerIndex<string, string, string>,
  Map<string, Map<string, string[]>>
>();

function getResolvedManagerGraph<
  SeatDefId extends string,
  PersonId extends string,
  Scope extends string,
>(
  index: SeatManagerIndex<SeatDefId, PersonId, Scope>,
  centralScope: Scope,
  chapterRollupParentSlug: string,
): Map<PersonId, PersonId[]> {
  const cacheKey = `${String(centralScope)} ${chapterRollupParentSlug}`;
  const indexKey = index as unknown as SeatManagerIndex<string, string, string>;
  let byKey = resolvedGraphCache.get(indexKey);
  if (!byKey) {
    byKey = new Map();
    resolvedGraphCache.set(indexKey, byKey);
  }
  let graph = byKey.get(cacheKey);
  if (!graph) {
    graph = buildResolvedManagerGraph(
      index,
      centralScope,
      chapterRollupParentSlug,
    ) as unknown as Map<string, string[]>;
    byKey.set(cacheKey, graph);
  }
  return graph as unknown as Map<PersonId, PersonId[]>;
}

export function deriveSeatManagerIds<
  SeatDefId extends string,
  PersonId extends string,
  Scope extends string,
>(
  index: SeatManagerIndex<SeatDefId, PersonId, Scope>,
  personId: PersonId,
  centralScope: Scope,
  chapterRollupParentSlug: string,
): SeatManagerResult<PersonId> {
  const heldSeats = index.seatsByPerson.get(personId);
  if (!heldSeats || heldSeats.length === 0) return null;

  const graph = getResolvedManagerGraph(index, centralScope, chapterRollupParentSlug);
  return graph.get(personId) ?? [];
}

/** Seat-derived managers if the person holds any seat; otherwise the stored
 *  `managerId` fallback (single-item array, or empty if unset). The phased
 *  rollout: seat truth REPLACES the stored signal per-person the moment a
 *  seat is held, but never removes/ignores it for people who hold none. */
export function effectiveManagerIds<
  SeatDefId extends string,
  PersonId extends string,
  Scope extends string,
>(
  index: SeatManagerIndex<SeatDefId, PersonId, Scope>,
  personId: PersonId,
  storedManagerId: PersonId | null,
  centralScope: Scope,
  chapterRollupParentSlug: string,
): PersonId[] {
  const seatDerived = deriveSeatManagerIds(
    index,
    personId,
    centralScope,
    chapterRollupParentSlug,
  );
  if (seatDerived !== null) return seatDerived;
  return storedManagerId ? [storedManagerId] : [];
}
