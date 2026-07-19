/**
 * Giving-dashboard v2 fleet "Needs attention" rail — derives the actionable
 * attention items for the CENTRAL lens from `givingPlatform.dashboardFleet`'s
 * rollups-only signals (mirrors finance's `fleetHealth.ts` precedent: the
 * server sends cheap flags/counts, the client derives the verdict/rail).
 *
 * Two kinds, both pointing at ONE scope the caller can jump into:
 *  - `lapsed` — a scope has lapsed donors to reactivate (`hasLapsed`).
 *  - `backer_gap` — a chapter's backers sit below its territory goal
 *    (`backersBelowTarget`).
 *
 * Dependency-free (no `react-native` import) so it's unit-testable directly
 * under this package's jest config — same reason `fleetHealth.ts`/`compactCents.ts`
 * stay dependency-free.
 */

/** The subset of a `dashboardFleet` scope row this derivation needs. */
export type FleetScopeSignal = {
  scope: string; // a chapter id, or "central"
  name: string;
  lapsedCount: number;
  hasLapsed: boolean;
  backerCount: number | null;
  targetBackers: number | null;
  backersBelowTarget: boolean;
};

export type FleetAttentionKind = "lapsed" | "backer_gap";

export type FleetAttentionItem = {
  scope: string;
  name: string;
  kind: FleetAttentionKind;
  /** Lapsed donor count, or the backers-below-goal gap. */
  count: number;
  title: string;
  detail: string;
};

/**
 * Fleet attention items, in the owner's stated order: lapsed reactivation
 * queues first, then backer gaps — each group sorted by severity (biggest
 * count first). A clean fleet yields `[]` (the rail renders an "all clear"
 * state).
 */
export function deriveFleetAttention(
  scopes: FleetScopeSignal[],
): FleetAttentionItem[] {
  const lapsed: FleetAttentionItem[] = [];
  const gaps: FleetAttentionItem[] = [];

  for (const s of scopes) {
    if (s.hasLapsed && s.lapsedCount > 0) {
      lapsed.push({
        scope: s.scope,
        name: s.name,
        kind: "lapsed",
        count: s.lapsedCount,
        title: `${s.name} · ${s.lapsedCount} lapsed`,
        detail: "Reactivate lapsed donors",
      });
    }
    if (
      s.backersBelowTarget &&
      s.backerCount != null &&
      s.targetBackers != null
    ) {
      const gap = s.targetBackers - s.backerCount;
      gaps.push({
        scope: s.scope,
        name: s.name,
        kind: "backer_gap",
        count: gap,
        title: `${s.name} · ${gap} to backer goal`,
        detail: `${s.backerCount}/${s.targetBackers} backers`,
      });
    }
  }

  lapsed.sort((a, b) => b.count - a.count);
  gaps.sort((a, b) => b.count - a.count);
  return [...lapsed, ...gaps];
}
