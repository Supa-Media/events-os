/**
 * Pure helpers behind the org chart's powers picker and Powers directory —
 * search, per-power state on a seat, "who else holds this", and turning an
 * edited set back into the per-domain writes `seats.setSeatDomainPowers`
 * accepts. No React here, so the rules are testable on their own.
 *
 * Every question is asked of the EXPANDED set (`expandPowers` /
 * `powersAtScope`), never the stored array: seats store the minimal set, and
 * a seat storing `email.campaigns.approve` really does hold the two rungs
 * beneath it.
 */
import {
  POWERS,
  POWER_DEFS,
  POWER_DOMAINS,
  POWER_DOMAIN_DEFS,
  expandPowers,
  isPower,
  powersAtScope,
  type Power,
  type PowerDomain,
} from "@events-os/shared";

export type SeatChart = "central" | "chapter";

/** One row of `seats.powersDirectory`. */
export type DirectorySeat = {
  defId: string;
  slug: string;
  title: string;
  chart: SeatChart;
  capabilities: readonly string[];
};

/** The powers a seat on `chart` can meaningfully hold. A chapter seat never
 *  offers a power whose resource only exists centrally (the org's bank
 *  accounts) — see `PowerDef.scope`. */
export function offerablePowers(chart: SeatChart): Power[] {
  return POWERS.filter((p) => chart === "central" || POWER_DEFS[p].scope !== "central");
}

/** Case-insensitive match on label, description, domain name, and id. */
export function matchesQuery(power: Power, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const def = POWER_DEFS[power];
  const hay = `${def.label} ${def.description} ${POWER_DOMAIN_DEFS[def.domain].label} ${power}`;
  return hay.toLowerCase().includes(q);
}

/** Powers to list for a search + domain filter, in registry order. */
export function searchPowers(
  query: string,
  domain: PowerDomain | "all",
  chart: SeatChart,
): Power[] {
  return offerablePowers(chart).filter(
    (p) => (domain === "all" || POWER_DEFS[p].domain === domain) && matchesQuery(p, query),
  );
}

/** Group an ordered power list by domain, keeping registry domain order. */
export function groupByDomain(powers: readonly Power[]): { domain: PowerDomain; powers: Power[] }[] {
  return POWER_DOMAINS.map((domain) => ({
    domain,
    powers: powers.filter((p) => POWER_DEFS[p].domain === domain),
  })).filter((g) => g.powers.length > 0);
}

export type PowerState =
  | { kind: "granted" }
  | { kind: "included"; via: Power }
  | { kind: "off" };

/**
 * Where `power` stands on a seat storing `stored`: granted outright, included
 * because something stored implies it (naming the first such power, which is
 * enough to answer "why do I have this?"), or not held.
 */
export function powerState(stored: Iterable<string>, power: Power): PowerState {
  const direct = [...stored].filter(isPower);
  if (direct.includes(power)) return { kind: "granted" };
  for (const s of direct) {
    if (expandPowers([s]).has(power)) return { kind: "included", via: s };
  }
  return { kind: "off" };
}

/** Seats (other than `excludeDefId`) whose expanded powers include `power`,
 *  read at each seat's own scope, with the stored power that grants it. */
export function holdersOf(
  power: Power,
  seats: readonly DirectorySeat[],
  excludeDefId?: string,
): { seat: DirectorySeat; via: Power | null }[] {
  const out: { seat: DirectorySeat; via: Power | null }[] = [];
  for (const seat of seats) {
    if (seat.defId === excludeDefId) continue;
    if (!powersAtScope(seat.capabilities, seat.chart).includes(power)) continue;
    const state = powerState(seat.capabilities, power);
    out.push({ seat, via: state.kind === "included" ? state.via : null });
  }
  return out;
}

/** Per domain, how many of `chart`'s offerable powers the stored set grants. */
export function heldCountByDomain(
  stored: Iterable<string>,
  chart: SeatChart,
): Partial<Record<PowerDomain, number>> {
  const counts: Partial<Record<PowerDomain, number>> = {};
  for (const p of powersAtScope(stored, chart)) {
    const d = POWER_DEFS[p].domain;
    counts[d] = (counts[d] ?? 0) + 1;
  }
  return counts;
}

/**
 * The writes needed to take a seat from `before` to `after`: one entry per
 * domain whose STORED powers changed, carrying that domain's full new set.
 * `setSeatDomainPowers` replaces exactly one domain, so this is what keeps an
 * edit to Finance from ever touching an Emails power.
 */
export function domainWrites(
  before: Iterable<string>,
  after: Iterable<string>,
): { domain: PowerDomain; powers: Power[] }[] {
  const b = [...before].filter(isPower);
  const a = [...after].filter(isPower);
  const writes: { domain: PowerDomain; powers: Power[] }[] = [];
  for (const domain of POWER_DOMAINS) {
    const bd = b.filter((p) => POWER_DEFS[p].domain === domain).sort();
    const ad = a.filter((p) => POWER_DEFS[p].domain === domain).sort();
    if (bd.join() !== ad.join()) writes.push({ domain, powers: ad });
  }
  return writes;
}

/** Stored powers added and removed between two sets, for the save summary. */
export function powerDiff(
  before: Iterable<string>,
  after: Iterable<string>,
): { added: Power[]; removed: Power[] } {
  const b = new Set([...before].filter(isPower));
  const a = new Set([...after].filter(isPower));
  return {
    added: POWERS.filter((p) => a.has(p) && !b.has(p)),
    removed: POWERS.filter((p) => b.has(p) && !a.has(p)),
  };
}
