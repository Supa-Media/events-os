/**
 * Reconstructing what was sold from a bare card charge.
 *
 * THE PROBLEM. In-person sales were taken through a third-party Tap-to-Pay app
 * (`com.pocketvendor.payment`) that only ever sends Stripe an AMOUNT — 177 of 178 taps
 * carry no line item and no price id. The product catalogue exists in Stripe because
 * the operator set it up; the app simply never used it. So the amount is the only
 * surviving evidence of the item.
 *
 * WHY THE OBVIOUS APPROACH IS WRONG. A greedy largest-first decomposition always finds
 * *an* exact answer, and that is not the same as the right one. Reading $60 at Eden
 * greedily gives "$50 hoodie + $5 popcorn + $5 popcorn" when the truth is two $30 tees —
 * it invented three products that were never sold. Where several exact decompositions
 * exist, picking one is guessing, and a ledger should not guess about what it sold.
 *
 * SO: enumerate EVERY decomposition and only assert items when there is exactly ONE.
 * More than one, or none, resolves to `unresolved` — the sale still books its revenue
 * and its event, which is what actually corrects the books; only the item breakdown is
 * absent, and absent is recoverable where a fabricated SKU is not.
 *
 * THE CATALOGUE IS PER EVENT, because that is what collapses the ambiguity. Only PW
 * Tees were sold at Eden, so $30 and $60 are unambiguous there while against the full
 * catalogue they are not. At Pop The Balloon the snack prices ($1/$2/$3/$5) genuinely
 * overlap — $5 alone has six readings — so most of that event stays unresolved, and
 * that is the honest outcome rather than a failure of this module.
 *
 * A FROZEN SNAPSHOT, not a live Stripe read: these are historical sales, and re-pricing
 * a product in Stripe later must not retroactively change what a 2025 charge meant.
 */

/** One purchasable unit. `candidates` has >1 entry only when products share a price. */
export type CatalogUnit = {
  unitPriceCents: number;
  /** Product name, or a price-point label when several products share the price. */
  label: string;
  /** Every product this price could be. One entry = unambiguous. */
  candidates: string[];
};

/** What was actually on sale at one event. */
export type EventCatalog = {
  /** Matches the event's `name`; the sync resolves the event by name + date. */
  eventName: string;
  /** UTC `YYYY-MM-DD` days this catalogue applies to. */
  days: string[];
  units: CatalogUnit[];
};

/**
 * Per-event catalogues for the 2025–26 in-person sales.
 *
 * Eden carries ONLY the tee (owner, 2026-08-07: "for Eden we didn't sell anything
 * other than the PW Tees"), which is what makes its $60 taps readable as two tees.
 * Pop The Balloon carries the snack line; the hoodie prices are included because the
 * products existed then, though nothing at that event resolves to one.
 */
export const EVENT_CATALOGS: EventCatalog[] = [
  {
    eventName: "Pop The Balloon",
    days: ["2025-12-06", "2025-12-07"],
    units: [
      { unitPriceCents: 100, label: "Water", candidates: ["Water"] },
      { unitPriceCents: 200, label: "$2 item", candidates: ["Candy", "Izze", "Pringles"] },
      { unitPriceCents: 300, label: "$3 item", candidates: ["Candy", "Snapple"] },
      { unitPriceCents: 500, label: "Popcorn", candidates: ["Popcorn"] },
      { unitPriceCents: 2500, label: "Made To Worship Hoodie", candidates: ["Made To Worship Hoodie"] },
      { unitPriceCents: 5000, label: "Made To Worship Hoodie", candidates: ["Made To Worship Hoodie"] },
    ],
  },
  {
    eventName: "Eden",
    days: ["2026-05-31"],
    units: [{ unitPriceCents: 3000, label: "PW Tee", candidates: ["PW Tee"] }],
  },
];

/** A hand-typed total far past this is a mis-key, not a basket — and 40 phantom waters
 *  is a worse answer than "unresolved". Also bounds the enumeration below. */
export const MAX_UNITS_PER_CHARGE = 12;
/** Enumeration bails past this many solutions; anything that branchy is ambiguous
 *  regardless, and we only ever care whether the count is exactly 1. */
const MAX_SOLUTIONS = 8;

export type DecomposedLine = { unit: CatalogUnit; quantity: number };

/**
 * Every exact way `amountCents` can be made from `units`, capped. Order within a
 * solution is largest-unit-first so the headline item of a basket reads first.
 */
export function allDecompositions(
  amountCents: number,
  units: CatalogUnit[],
): DecomposedLine[][] {
  if (!Number.isInteger(amountCents) || amountCents <= 0 || units.length === 0) return [];
  const sorted = [...units].sort((a, b) => b.unitPriceCents - a.unitPriceCents);
  const out: DecomposedLine[][] = [];
  const walk = (i: number, remaining: number, acc: DecomposedLine[], used: number): void => {
    if (out.length >= MAX_SOLUTIONS || used > MAX_UNITS_PER_CHARGE) return;
    if (remaining === 0) { out.push(acc.map((l) => ({ ...l }))); return; }
    if (i >= sorted.length) return;
    const unit = sorted[i];
    const most = Math.floor(remaining / unit.unitPriceCents);
    for (let q = most; q >= 0; q--) {
      if (q > 0) acc.push({ unit, quantity: q });
      walk(i + 1, remaining - unit.unitPriceCents * q, acc, used + q);
      if (q > 0) acc.pop();
    }
  };
  walk(0, amountCents, [], 0);
  return out;
}

export type Resolution =
  | { kind: "resolved"; lines: DecomposedLine[] }
  /** Several exact readings, or none — the caller records revenue without items. */
  | { kind: "unresolved"; reason: "ambiguous" | "no_match"; waysFound: number };

/**
 * Resolve a charge to its items, or decline to. Exactly one decomposition is asserted;
 * anything else is `unresolved`, which is a legitimate outcome and not an error.
 */
export function resolveCharge(amountCents: number, units: CatalogUnit[]): Resolution {
  const ways = allDecompositions(amountCents, units);
  if (ways.length === 1) return { kind: "resolved", lines: ways[0] };
  return {
    kind: "unresolved",
    reason: ways.length === 0 ? "no_match" : "ambiguous",
    waysFound: ways.length,
  };
}

/** The catalogue in force on a given UTC `YYYY-MM-DD`, or null if none is defined. */
export function catalogForDay(dayISO: string): EventCatalog | null {
  return EVENT_CATALOGS.find((c) => c.days.includes(dayISO)) ?? null;
}
