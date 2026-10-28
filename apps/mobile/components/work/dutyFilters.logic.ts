/**
 * The Duties page's filter / sort / group rules, kept free of React and
 * Convex imports so they can be unit tested (see `jest.config.js`: this app
 * has no component test runtime, only node).
 *
 * The screen flattens each duty into a `DutyFacts` record first (seat holder
 * counts, how many people it reaches, whether a how-to exists), then runs the
 * same three steps on every render: `filterDuties` → `sortDuties` →
 * `groupDuties`. Every filter is an AND; the cadence chips are an OR among
 * themselves ("weekly or monthly").
 */

export const DUTY_CADENCES = [
  "daily",
  "weekly",
  "biweekly",
  "monthly",
  "quarterly",
  "yearly",
  "ad_hoc",
] as const;
export type DutyCadence = (typeof DUTY_CADENCES)[number];

export type DutySeatFact = {
  id: string;
  title: string;
  chart: "central" | "chapter";
  /** How many people hold this seat right now. 0 = vacant. */
  holders: number;
};

export type DutyFacts = {
  id: string;
  title: string;
  cadence: DutyCadence;
  seats: DutySeatFact[];
  /** People assigned directly, outside any seat. */
  directCount: number;
  /** Pre-seat role strings still on an unmapped duty. */
  legacyRoles: string[];
  hasHowTo: boolean;
  /** How many people this duty reaches today (seats + legacy roles + direct). */
  holders: number;
  /** Lowercased text the search box matches against. */
  searchText: string;
};

/** The tabs across the top of the page. */
export type DutyView = "all" | "attention" | "mine" | "howto";

export type DutyFilters = {
  view: DutyView;
  query: string;
  /** Empty = any cadence. */
  cadences: DutyCadence[];
  seatId: string | null;
  chart: "central" | "chapter" | null;
  vacantOnly: boolean;
  noHowTo: boolean;
  directOnly: boolean;
};

export const EMPTY_DUTY_FILTERS: DutyFilters = {
  view: "all",
  query: "",
  cadences: [],
  seatId: null,
  chart: null,
  vacantOnly: false,
  noHowTo: false,
  directOnly: false,
};

export type DutySort = "title" | "cadence" | "most" | "fewest";
export type DutyGroupBy = "none" | "cadence" | "seat";

export function vacantSeats(d: DutyFacts): DutySeatFact[] {
  return d.seats.filter((s) => s.holders === 0);
}

/**
 * Why a duty needs a manager's attention, or null when it doesn't. One reason
 * is enough to flag it; the most actionable one wins.
 */
export function attentionReason(d: DutyFacts): string | null {
  if (d.seats.length === 0 && d.directCount === 0 && d.legacyRoles.length === 0) {
    return "Not assigned to anyone";
  }
  const vacant = vacantSeats(d);
  if (vacant.length === 1) return `${vacant[0].title} is vacant`;
  if (vacant.length > 1) return `${vacant.length} vacant seats`;
  if (d.seats.length === 0 && d.legacyRoles.length > 0) return "Not mapped to a seat yet";
  if (d.holders === 0) return "Nobody is doing this";
  return null;
}

export function inView(
  d: DutyFacts,
  view: DutyView,
  mySeatIds: ReadonlySet<string>,
): boolean {
  switch (view) {
    case "attention":
      return attentionReason(d) !== null;
    case "mine":
      return d.seats.some((s) => mySeatIds.has(s.id));
    case "howto":
      return !d.hasHowTo;
    default:
      return true;
  }
}

export function filterDuties(
  duties: DutyFacts[],
  f: DutyFilters,
  mySeatIds: ReadonlySet<string>,
): DutyFacts[] {
  const q = f.query.trim().toLowerCase();
  return duties.filter((d) => {
    if (!inView(d, f.view, mySeatIds)) return false;
    if (q && !d.searchText.includes(q)) return false;
    if (f.cadences.length > 0 && !f.cadences.includes(d.cadence)) return false;
    if (f.seatId && !d.seats.some((s) => s.id === f.seatId)) return false;
    if (f.chart && !d.seats.some((s) => s.chart === f.chart)) return false;
    if (f.vacantOnly && vacantSeats(d).length === 0) return false;
    if (f.noHowTo && d.hasHowTo) return false;
    if (f.directOnly && d.directCount === 0) return false;
    return true;
  });
}

const byTitle = (a: DutyFacts, b: DutyFacts) =>
  a.title.localeCompare(b.title, undefined, { sensitivity: "base" });

export function sortDuties(duties: DutyFacts[], sort: DutySort): DutyFacts[] {
  const out = [...duties];
  out.sort((a, b) => {
    if (sort === "cadence") {
      return (
        DUTY_CADENCES.indexOf(a.cadence) - DUTY_CADENCES.indexOf(b.cadence) ||
        byTitle(a, b)
      );
    }
    if (sort === "most") return b.holders - a.holders || byTitle(a, b);
    if (sort === "fewest") return a.holders - b.holders || byTitle(a, b);
    return byTitle(a, b);
  });
  return out;
}

export type DutyGroup = {
  key: string;
  /** Null for the single ungrouped bucket. */
  label: string | null;
  /** Group-by-seat only: the seat has no holder. */
  vacant: boolean;
  items: DutyFacts[];
};

/**
 * Buckets already-sorted duties. Grouping by seat lists a duty under EVERY
 * seat it maps to, so each group reads as "everything this seat owns"; duties
 * with no seat land in a trailing "No seat" group.
 */
export function groupDuties(
  duties: DutyFacts[],
  groupBy: DutyGroupBy,
  cadenceLabel: (c: DutyCadence) => string,
): DutyGroup[] {
  if (groupBy === "cadence") {
    return DUTY_CADENCES.map((c) => ({
      key: c,
      label: cadenceLabel(c),
      vacant: false,
      items: duties.filter((d) => d.cadence === c),
    })).filter((g) => g.items.length > 0);
  }
  if (groupBy === "seat") {
    const seats = new Map<string, DutySeatFact>();
    for (const d of duties) for (const s of d.seats) seats.set(s.id, s);
    const groups: DutyGroup[] = [...seats.values()]
      .sort((a, b) => a.title.localeCompare(b.title))
      .map((s) => ({
        key: s.id,
        label: s.title,
        vacant: s.holders === 0,
        items: duties.filter((d) => d.seats.some((x) => x.id === s.id)),
      }));
    const noSeat = duties.filter((d) => d.seats.length === 0);
    if (noSeat.length > 0) {
      groups.push({ key: "no-seat", label: "No seat", vacant: false, items: noSeat });
    }
    return groups;
  }
  return [{ key: "all", label: null, vacant: false, items: duties }];
}

/** True when anything beyond the view tab narrows the list. */
export function hasActiveFilters(f: DutyFilters): boolean {
  return (
    f.query.trim() !== "" ||
    f.cadences.length > 0 ||
    f.seatId !== null ||
    f.chart !== null ||
    f.vacantOnly ||
    f.noHowTo ||
    f.directOnly
  );
}
