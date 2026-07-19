/**
 * Giving-dashboard v2 Donors CRM — the PURE filter→query-arg mapping the
 * Donors screen's dropdowns feed into `givingPlatform.listDonors`. Kept
 * dependency-free (no `react-native`) so the mapping is unit-testable directly
 * under this package's jest config, mirroring the finance dashboard's
 * colocated pure-helper precedent (`fleetHealth.ts`, `compactCents.ts`).
 *
 * The option LABEL lists themselves stay on the screen (they mirror the convex
 * schema literals by hand — see `donors.tsx`); this module owns only the
 * "all" → undefined collapse, the lifetime-band → cents conversion, and the
 * scope selector → `{ scope, allScopes }` resolution.
 */

/** Lifetime bands (dollars) → the `minLifetimeCents` query arg. `undefined`
 *  (the "all" band) applies no floor. */
export const LIFETIME_BAND_CENTS: Record<string, number | undefined> = {
  all: undefined,
  "100": 100_00,
  "500": 500_00,
  "1000": 1_000_00,
};

/** The special scope selector value that means "merge every scope" (central
 *  only). Distinct from a real chapter id or the "central" scope. */
export const ALL_SCOPES_VALUE = "all";

export type DonorFilterSelection = {
  status: string; // "all" | donor status
  kind: string; // "all" | donor kind
  source: string; // "all" | donor source
  band: string; // "all" | a LIFETIME_BAND_CENTS key
};

export type ListDonorsArgs = {
  scope: string;
  status: string | undefined;
  kind: string | undefined;
  source: string | undefined;
  minLifetimeCents: number | undefined;
  allScopes: boolean | undefined;
};

/** Collapse a filter value to its query arg: the "all" sentinel → `undefined`,
 *  everything else passes through unchanged. */
export function filterArg(value: string): string | undefined {
  return value === "all" ? undefined : value;
}

/**
 * Build the `listDonors` args from the current filter + scope selection.
 *
 * `scopeSel` is the scope dropdown value: `ALL_SCOPES_VALUE` (central-only
 * "All chapters"), `"central"`, or a chapter id. In all-scopes mode the query
 * ignores `scope` but still validates central reach, so we pass `centralScope`
 * ("central") as the (ignored) scope arg and set `allScopes: true`.
 */
export function buildListDonorsArgs(
  filters: DonorFilterSelection,
  scopeSel: string,
  centralScope: string = "central",
): ListDonorsArgs {
  const allScopes = scopeSel === ALL_SCOPES_VALUE;
  return {
    scope: allScopes ? centralScope : scopeSel,
    status: filterArg(filters.status),
    kind: filterArg(filters.kind),
    source: filterArg(filters.source),
    minLifetimeCents: LIFETIME_BAND_CENTS[filters.band],
    allScopes: allScopes ? true : undefined,
  };
}

/** Whether any refining filter (not scope) is active — drives the empty-state
 *  copy ("no donors match" vs "no donors yet"). */
export function anyFilterActive(filters: DonorFilterSelection): boolean {
  return (
    filters.status !== "all" ||
    filters.kind !== "all" ||
    filters.source !== "all" ||
    filters.band !== "all"
  );
}
