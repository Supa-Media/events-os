/**
 * What Stripe ITSELF says was sold, before anything is deduced from the amount.
 *
 * THE MISTAKE THIS CORRECTS. `lib/salesCatalog.ts` reconstructs items by decomposing the
 * charge AMOUNT against a hand-typed per-event price list. That was written when the
 * amount really was the only surviving evidence — 177 of 178 taps in 2025 carried nothing
 * else. It has since stopped being true, and the sync never noticed: the Tap-to-Pay app
 * (`com.pocketvendor.payment`) gained a catalogue feature, and from 2026-05-31 onward the
 * charges it writes carry the SKU outright. Reading the 2026-08-08 charges back out of
 * Stripe:
 *
 *     description: "1x PW Tee"
 *     metadata.line_items: "price_1TcyNkQv9S5xW6eKGg8pQsVG:1"
 *     metadata.device_charge_description: "Payment for Stripe App"
 *
 * Four of that day's five charges look exactly like that. The sync ignored all of it and
 * fell through to a catalogue with no 2026-08-08 entry, so $170 of tees booked as
 * "unresolved" while Stripe was holding the answer in two separate fields.
 *
 * THE ORDER OF EVIDENCE, strongest first. Each rung is a strictly better class of claim
 * than the one under it, which is why `itemSource` names which rung a row came from —
 * a reader deciding how far to trust "PW Tee ×2" needs to know whether Stripe stated it
 * or we inferred it.
 *
 *   1. `stripe_line_items` — `metadata.line_items` names real Stripe Price objects. We
 *      resolve each one and require that Σ(unit_amount × qty) equals the charge to the
 *      cent. Both the SKU and its price come from Stripe; the arithmetic then proves the
 *      two agree. Nothing here is inferred.
 *   2. `charge_description` — the point of sale wrote down what it rang up ("1x PW Tee").
 *      A statement by the seller, not a deduction: it survives days no catalogue covers,
 *      which is the whole failure being fixed. Weaker than (1) because the unit price is
 *      derived by dividing the amount rather than read.
 *   3. `amount_decomposition` — `salesCatalog.ts`. An INFERENCE from a curated price
 *      list, asserted only when exactly one basket makes the total. Unchanged, and
 *      deliberately so: its refusal to pick between equally-exact readings is the
 *      property that keeps invented SKUs out of the ledger.
 *   4. `unresolved` — the honest answer. Revenue is exact either way; only the breakdown
 *      is missing, and a blank is recoverable where a fabricated SKU is not.
 *
 * WHAT COUNTS AS A DESCRIPTION AND WHAT IS NOISE. This is the delicate part, because a
 * bad rule here manufactures a SKU — precisely what `salesCatalog.ts` was written to
 * refuse. Every charge from this app also carries
 * `metadata.device_charge_description: "Payment for Stripe App"`, and when the operator
 * rings up a catalogue item the top-level `description` is replaced by the item line
 * while that metadata key keeps the generic string. So the payload NAMES ITS OWN NOISE,
 * and the primary rule needs no denylist: a description equal to the device's own
 * default is the app naming itself, not a product. The second rule is structural — an
 * item description must have the shape `<qty>x <label>`, the form a receipt line takes,
 * which "Payment for Stripe App" fails on its own merits. Free text is not evidence of a
 * SKU. Either rule alone rejects the one non-item description on 2026-08-08; both are
 * kept because each covers the other's blind spot (a device default that happens to look
 * like a receipt line; a missing metadata key on some future rail).
 *
 * PURE ON PURPOSE. Everything here is a total function over values the caller already
 * holds, including the price lookups — `salesSync.ts` does the fetching so this module
 * can be tested against the real observed payloads with no network. It also means a
 * Stripe outage degrades to a lower rung instead of failing a run: an unresolved price is
 * just a `null` in the map, and `itemsFromPrices` declines.
 */

import { MAX_UNITS_PER_CHARGE } from "./salesCatalog";

/** One line of a sale, in the shape the `sales` table stores. */
export type SaleItem = {
  label: string;
  quantity: number;
  unitPriceCents: number;
  /** Every product this line could be. One entry means it is not a guess. */
  candidates: string[];
};

/** How a row's breakdown was arrived at, best evidence first. Mirrors the schema union. */
export type ItemSource =
  | "stripe_line_items"
  | "charge_description"
  | "amount_decomposition"
  | "unresolved";

/**
 * Strength order, and the reason `upsertSales` can safely re-visit a row it already
 * imported: a re-run may only ever move a sale UP this ladder. Without a rank, a Stripe
 * hiccup (price lookup fails → falls to `unresolved`) would overwrite a good breakdown
 * with a blank, and an idempotent sync would have become lossy.
 */
const ITEM_SOURCE_RANK: Record<ItemSource, number> = {
  unresolved: 0,
  amount_decomposition: 1,
  charge_description: 2,
  stripe_line_items: 3,
};

/** True when `next` is better evidence than `current` — never merely different. */
export function outranks(next: ItemSource, current: ItemSource): boolean {
  return ITEM_SOURCE_RANK[next] > ITEM_SOURCE_RANK[current];
}

// ── Rung 1: Stripe Price objects named in the charge's metadata ──────────────

/** One `priceId:quantity` pair out of `metadata.line_items`. */
export type LineItemRef = { priceId: string; quantity: number };

/** The Stripe fields we need off a Price. `label` is the product name (or the price's
 *  nickname when the product carries none). `unitAmountCents` is null for tiered and
 *  customer-chosen prices, which carry no single unit amount and are declined below. */
export type PriceRecord = {
  unitAmountCents: number | null;
  currency: string;
  label: string;
};

const PRICE_ID = /^price_[A-Za-z0-9]+$/;

/**
 * Parse `metadata.line_items`. Every value observed in this account is a single
 * `price_…:1`, so the multi-item separator is inferred rather than known — which is
 * exactly why this is all-or-nothing: ANY token that doesn't parse rejects the whole
 * string. A partially-understood basket is a basket whose money we cannot account for,
 * and reporting half of one as if it were the sale would be worse than reporting none.
 */
export function parseLineItemsMetadata(raw: unknown): LineItemRef[] | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const refs: LineItemRef[] = [];
  for (const token of trimmed.split(",")) {
    const t = token.trim();
    // An empty token means something was dropped and we can't say what.
    if (!t) return null;
    const split = t.lastIndexOf(":");
    if (split <= 0) return null;
    const priceId = t.slice(0, split);
    const qtyRaw = t.slice(split + 1);
    if (!PRICE_ID.test(priceId)) return null;
    // Digits only — `Number()` would happily read "0x10" as 16.
    if (!/^\d+$/.test(qtyRaw)) return null;
    const quantity = Number(qtyRaw);
    if (quantity < 1) return null;
    refs.push({ priceId, quantity });
  }
  return refs.length ? refs : null;
}

/**
 * Turn resolved Price objects into sale lines — or decline.
 *
 * THE MONEY ASSERTION is the last check and the point of the whole rung: the lines must
 * add to the charge exactly. If they don't, the metadata is describing something other
 * than what was actually captured (a discount, a tip, a stale price id, a partial
 * capture) and the breakdown would be a story that contradicts the money sitting in the
 * bank. We decline and let a weaker rung try. This is what makes `stripe_line_items` the
 * one source that cannot silently misreport a sale.
 */
export function itemsFromPrices(
  amountCents: number,
  currency: string,
  refs: LineItemRef[],
  prices: ReadonlyMap<string, PriceRecord | null>,
): SaleItem[] | null {
  if (!Number.isInteger(amountCents) || amountCents <= 0) return null;
  if (!refs.length) return null;

  const items: SaleItem[] = [];
  let total = 0;
  let units = 0;

  for (const ref of refs) {
    // `undefined` = never looked up; `null` = looked up and Stripe couldn't say.
    const price = prices.get(ref.priceId);
    if (!price) return null;
    const unit = price.unitAmountCents;
    if (unit == null || !Number.isInteger(unit) || unit <= 0) return null;
    // A price in another currency cannot be summed against this charge's cents.
    if (price.currency.toLowerCase() !== currency.toLowerCase()) return null;
    const label = price.label.trim();
    if (!label) return null;

    total += unit * ref.quantity;
    units += ref.quantity;
    items.push({
      label,
      quantity: ref.quantity,
      unitPriceCents: unit,
      // Stripe named the product, so there is exactly one thing this can be.
      candidates: [label],
    });
  }

  // The same mis-key ceiling the decomposition uses — 40 units is a typo, not a basket.
  if (units > MAX_UNITS_PER_CHARGE) return null;
  if (total !== amountCents) return null;
  return items;
}

// ── Rung 2: the charge's own description ─────────────────────────────────────

/** A receipt line: a count, an `x`, a product. Anything else is prose. */
const RECEIPT_LINE = /^(\d{1,3})\s*[x×]\s*(.+)$/i;
/** A second `Nx …` inside the label means several products — see below. */
const FURTHER_RECEIPT_LINE = /\d+\s*[x×]\s/i;
/** A SKU is a name, not a sentence. Bounds what can land in `items[].label`. */
export const MAX_ITEM_LABEL_LENGTH = 60;

/**
 * Read the item out of `charge.description`, or decline.
 *
 * `deviceDefaultDescription` is `metadata.device_charge_description` — the app's own
 * generic label for a charge it has nothing to say about. Passing it in is what lets
 * this be a rule rather than a denylist: we reject the noise because the payload
 * identified it as noise, not because we recognised the string.
 *
 * MULTI-ITEM DESCRIPTIONS ARE REFUSED, not split. "2x Tee, 1x Hoodie" names two products
 * whose prices we do not have, and the only way to divide one total between them is to
 * guess — the exact move `salesCatalog.ts` exists to prevent. Such a charge falls
 * through to the decomposition, which may or may not resolve it, and that is correct.
 * (A multi-item charge that also carries `metadata.line_items` never reaches here: rung
 * 1 has the real prices and handles it properly.)
 */
export function itemsFromDescription(
  description: unknown,
  deviceDefaultDescription: unknown,
  amountCents: number,
): SaleItem[] | null {
  if (typeof description !== "string") return null;
  const text = description.trim();
  if (!text) return null;

  // Rule 1 — the payload names its own noise.
  if (typeof deviceDefaultDescription === "string") {
    const generic = deviceDefaultDescription.trim();
    if (generic && text.toLowerCase() === generic.toLowerCase()) return null;
  }

  // Rule 2 — an item description has the shape of a receipt line.
  const match = RECEIPT_LINE.exec(text);
  if (!match) return null;
  const quantity = Number(match[1]);
  const label = match[2].trim();

  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_UNITS_PER_CHARGE) return null;
  if (!label || label.length > MAX_ITEM_LABEL_LENGTH) return null;
  if (FURTHER_RECEIPT_LINE.test(label)) return null;

  // The unit price is DERIVED here rather than read, so it must divide exactly —
  // otherwise the line would claim a per-unit price that never existed.
  if (!Number.isInteger(amountCents) || amountCents <= 0) return null;
  if (amountCents % quantity !== 0) return null;

  return [
    {
      label,
      quantity,
      unitPriceCents: amountCents / quantity,
      // The seller named the product; there is nothing else it could be.
      candidates: [label],
    },
  ];
}
