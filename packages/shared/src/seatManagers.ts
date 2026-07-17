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
 * MUTUAL-SEAT CYCLE TIE-BREAK (2026-07-17, post-#205 regression fix — see
 * `orgSeatManagers.test.ts`'s "multi-seat mutual pair" describe block):
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
 *  Fix: after collecting the raw per-seat-derived candidate set, filter it to
 *  keep only candidates who are ACTUALLY more senior than the person overall
 *  — "the central-chart-root-closer person wins as the parent." Seniority is
 *  a person's STRUCTURAL distance to the central chart's root (`depthOf`,
 *  below): 0 for the central root seat, +1 per `parentSlug` hop, chapter
 *  seats crossing into the central chart via `chapterRollupParentSlug` like
 *  the main walk does. A person's overall seniority is the MIN depth across
 *  every seat they hold (their single most-senior seat), not the depth of
 *  whichever seat is currently being walked — that's what makes this
 *  hierarchy-wide rather than a narrow "just this one pair" patch: a
 *  candidate is kept as a manager only if their best seat is STRICTLY closer
 *  to the root than the person's own best seat. Depth strictly decreases
 *  along every surviving edge, so the resulting graph can never contain a
 *  cycle of any length, not just 2-cycles.
 *
 *  In the ED/expansion-director example: the ED's overall depth is 0 (their
 *  `executive_director` seat), so a candidate at depth 1 (`expansion_director`)
 *  fails the strict-improvement check and is dropped — the ED has no manager,
 *  correctly. The expansion director's overall depth is 1, and the ED's is 0,
 *  which strictly improves on it — kept. Net: expansion director reports to
 *  the ED, never the reverse, regardless of which of their several seats
 *  produced the raw edge.
 *
 *  Equal-depth ties (not expected in the current acyclic seat taxonomy — every
 *  real ancestor relationship strictly decreases depth — but kept as a
 *  defensive fallback) are broken by comparing person ids lexicographically,
 *  so exactly one direction survives instead of either both or neither.
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
        : 1; // dangling rollup target — defensive
    }
  } else {
    const parent = index.defBySlug.get(chartSlugKey(def.chart, def.parentSlug));
    depth = parent
      ? seatDepth(index, parent.seatDefId, chapterRollupParentSlug, memo, guard + 1) + 1
      : 0; // dangling parentSlug — defensive
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

  // Mutual-seat cycle tie-break: keep a candidate only if THEY are strictly
  // more senior overall than `personId` — see the module header's
  // "MUTUAL-SEAT CYCLE TIE-BREAK" section. Ties (not expected in the current
  // taxonomy) break deterministically by id so exactly one direction survives.
  const depthMemo = new Map<SeatDefId, number>();
  const ownDepth = personSeatDepth(index, personId, chapterRollupParentSlug, depthMemo);
  const filtered = [...out].filter((candidateId) => {
    const candidateDepth = personSeatDepth(index, candidateId, chapterRollupParentSlug, depthMemo);
    if (candidateDepth !== ownDepth) return candidateDepth < ownDepth;
    return candidateId < personId;
  });
  return filtered;
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
