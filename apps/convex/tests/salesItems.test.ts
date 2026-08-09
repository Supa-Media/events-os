import { describe, expect, test } from "vitest";
import {
  MAX_ITEM_LABEL_LENGTH,
  itemsFromDescription,
  itemsFromPrices,
  outranks,
  parseLineItemsMetadata,
  type ItemSource,
  type PriceRecord,
} from "../lib/salesItems";

/**
 * Reading what Stripe already said was sold.
 *
 * The fixtures below are VERBATIM from the live account (read 2026-08-09), not invented:
 * the five card-present charges of 2026-08-08 that booked as "unresolved" while Stripe
 * held the answer, plus a 2025 charge from before the payment app gained a catalogue.
 * Keeping the real payloads here is the point — the bug was that the sync was designed
 * against an assumption about the payload ("the amount is all we get") that had quietly
 * stopped being true, and a fixture invented from the same assumption would have
 * reproduced the blind spot instead of catching it.
 *
 * As with `salesCatalog.test.ts`, the tests that matter most are the REFUSALS. Turning a
 * description into an item is one bad regex away from inventing a SKU, which is the one
 * thing this whole area of the codebase exists to prevent.
 */

// ── The real payloads ────────────────────────────────────────────────────────

/** The four 2026-08-08 tee charges. Identical shape, so one stands for all four. */
const TEE_CHARGE = {
  id: "ch_3U2GadQv9S5xW6eK06WCzxum",
  amount: 3000,
  currency: "usd",
  description: "1x PW Tee",
  metadata: {
    amount: "3000",
    app_version: "13.3.19",
    device: "iPhone",
    device_charge_description: "Payment for Stripe App",
    from_app: "com.pocketvendor.payment",
    ios_version: "26.5.1",
    line_items: "price_1TcyNkQv9S5xW6eKGg8pQsVG:1",
    terminal_serial_number: "f534c915d30a6ccf5620ae1a52409b37023865db46f7e2970a6d3f5e5cdebec4",
  },
};

/** The fifth. $50, no `line_items`, and the description is the app naming itself. */
const UNLABELLED_CHARGE = {
  id: "ch_3U2EgzQv9S5xW6eK00dIIcJ9",
  amount: 5000,
  currency: "usd",
  description: "Payment for Stripe App",
  metadata: {
    amount: "5000",
    app_version: "13.3.19",
    device: "iPhone",
    device_charge_description: "Payment for Stripe App",
    from_app: "com.pocketvendor.payment",
    ios_version: "26.5.1",
    terminal_serial_number: "f534c915d30a6ccf5620ae1a52409b37023865db46f7e2970a6d3f5e5cdebec4",
  },
};

/** The real Price the tee charges point at, as Stripe returns it with the product
 *  expanded. `unit_amount` 3000 is what makes the arithmetic check pass. */
const PW_TEE_PRICE: PriceRecord = {
  unitAmountCents: 3000,
  currency: "usd",
  label: "PW Tee",
};
const PW_TEE_PRICE_ID = "price_1TcyNkQv9S5xW6eKGg8pQsVG";

const priced = (entries: Array<[string, PriceRecord | null]>) =>
  new Map<string, PriceRecord | null>(entries);

// ── The bug, stated as a test ────────────────────────────────────────────────

describe("2026-08-08 — the day that resolved to nothing", () => {
  test("the four tee charges resolve from Stripe's own price id", () => {
    const refs = parseLineItemsMetadata(TEE_CHARGE.metadata.line_items);
    expect(refs).toEqual([{ priceId: PW_TEE_PRICE_ID, quantity: 1 }]);

    const items = itemsFromPrices(
      TEE_CHARGE.amount,
      TEE_CHARGE.currency,
      refs!,
      priced([[PW_TEE_PRICE_ID, PW_TEE_PRICE]]),
    );
    expect(items).toEqual([
      { label: "PW Tee", quantity: 1, unitPriceCents: 3000, candidates: ["PW Tee"] },
    ]);
  });

  test("they also resolve from the description alone, if the price lookup can't run", () => {
    // The rung below rung 1 — this is what makes a day with no catalogue entry and no
    // reachable Stripe still readable.
    expect(
      itemsFromDescription(
        TEE_CHARGE.description,
        TEE_CHARGE.metadata.device_charge_description,
        TEE_CHARGE.amount,
      ),
    ).toEqual([
      { label: "PW Tee", quantity: 1, unitPriceCents: 3000, candidates: ["PW Tee"] },
    ]);
  });

  test("the fifth charge stays unresolved — 'Payment for Stripe App' is not a product", () => {
    // No line items at all…
    expect(parseLineItemsMetadata(
      (UNLABELLED_CHARGE.metadata as Record<string, string>).line_items,
    )).toBeNull();
    // …and the description is the device's own default, which the payload says outright.
    expect(
      itemsFromDescription(
        UNLABELLED_CHARGE.description,
        UNLABELLED_CHARGE.metadata.device_charge_description,
        UNLABELLED_CHARGE.amount,
      ),
    ).toBeNull();
  });

  test("the day's revenue is $170 whatever the breakdown says", () => {
    // The assertion that actually protects the books: resolving items must never be
    // able to change the money. Four charges gain a breakdown, one does not, and the
    // gross is untouched by either outcome.
    const day = [TEE_CHARGE, TEE_CHARGE, TEE_CHARGE, TEE_CHARGE, UNLABELLED_CHARGE];
    const gross = day.reduce((a, c) => a + c.amount, 0);
    expect(gross).toBe(17000);

    let resolvedCents = 0;
    let itemised = 0;
    for (const c of day) {
      const refs = parseLineItemsMetadata((c.metadata as Record<string, string>).line_items);
      const items = refs
        ? itemsFromPrices(c.amount, c.currency, refs, priced([[PW_TEE_PRICE_ID, PW_TEE_PRICE]]))
        : null;
      if (!items) continue;
      itemised++;
      resolvedCents += items.reduce((a, i) => a + i.quantity * i.unitPriceCents, 0);
    }
    expect(itemised).toBe(4);
    // Every itemised line adds back to exactly what was charged — no rounding, no drift.
    expect(resolvedCents).toBe(12000);
    // …and the unitemised $50 is still $50 of revenue.
    expect(gross - resolvedCents).toBe(5000);
  });
});

// ── parseLineItemsMetadata ───────────────────────────────────────────────────

describe("parseLineItemsMetadata", () => {
  test("reads a multi-item basket", () => {
    expect(parseLineItemsMetadata("price_abc123:2,price_def456:1")).toEqual([
      { priceId: "price_abc123", quantity: 2 },
      { priceId: "price_def456", quantity: 1 },
    ]);
  });

  test("one unparseable token rejects the WHOLE string", () => {
    // Half a basket is a basket whose money we can't account for. Better to fall to a
    // weaker rung than to report the part we happened to understand as the sale.
    expect(parseLineItemsMetadata("price_abc123:1,garbage")).toBeNull();
    expect(parseLineItemsMetadata("price_abc123:1,,price_def456:1")).toBeNull();
    expect(parseLineItemsMetadata("price_abc123:1,sku_def456:1")).toBeNull();
  });

  test("refuses anything that isn't a Stripe price id and a whole count", () => {
    expect(parseLineItemsMetadata("prod_abc123:1")).toBeNull();
    expect(parseLineItemsMetadata("price_abc123")).toBeNull();
    expect(parseLineItemsMetadata(":1")).toBeNull();
    expect(parseLineItemsMetadata("price_abc123:0")).toBeNull();
    expect(parseLineItemsMetadata("price_abc123:-1")).toBeNull();
    expect(parseLineItemsMetadata("price_abc123:1.5")).toBeNull();
    // `Number("0x10")` is 16 — a digits-only check is why that can't sneak through.
    expect(parseLineItemsMetadata("price_abc123:0x10")).toBeNull();
  });

  test("shrugs at absent or junk input rather than throwing", () => {
    expect(parseLineItemsMetadata(undefined)).toBeNull();
    expect(parseLineItemsMetadata(null)).toBeNull();
    expect(parseLineItemsMetadata("")).toBeNull();
    expect(parseLineItemsMetadata("   ")).toBeNull();
    expect(parseLineItemsMetadata(42)).toBeNull();
    expect(parseLineItemsMetadata({ price_abc: 1 })).toBeNull();
  });
});

// ── itemsFromPrices ──────────────────────────────────────────────────────────

describe("itemsFromPrices", () => {
  const refs = [{ priceId: PW_TEE_PRICE_ID, quantity: 2 }];
  const map = priced([[PW_TEE_PRICE_ID, PW_TEE_PRICE]]);

  test("two tees at $30 make a $60 charge", () => {
    expect(itemsFromPrices(6000, "usd", refs, map)).toEqual([
      { label: "PW Tee", quantity: 2, unitPriceCents: 3000, candidates: ["PW Tee"] },
    ]);
  });

  test("REFUSES when the lines don't add to the charge", () => {
    // The money assertion. $60 of tees against a $55 charge means the metadata is
    // describing something other than what was captured — a discount, a tip, a stale
    // price. Telling that story would contradict the bank.
    expect(itemsFromPrices(5500, "usd", refs, map)).toBeNull();
    expect(itemsFromPrices(6001, "usd", refs, map)).toBeNull();
  });

  test("declines a price it couldn't look up rather than dropping the line", () => {
    expect(itemsFromPrices(6000, "usd", refs, priced([]))).toBeNull();
    expect(itemsFromPrices(6000, "usd", refs, priced([[PW_TEE_PRICE_ID, null]]))).toBeNull();
  });

  test("declines a price with no single unit amount, or the wrong currency", () => {
    expect(
      itemsFromPrices(6000, "usd", refs, priced([[PW_TEE_PRICE_ID, { ...PW_TEE_PRICE, unitAmountCents: null }]])),
    ).toBeNull();
    expect(
      itemsFromPrices(6000, "gbp", refs, priced([[PW_TEE_PRICE_ID, PW_TEE_PRICE]])),
    ).toBeNull();
  });

  test("declines a price whose product has no name", () => {
    // A blank label would render as an empty row on the Sales tab — less useful than
    // saying plainly that we don't know.
    expect(
      itemsFromPrices(6000, "usd", refs, priced([[PW_TEE_PRICE_ID, { ...PW_TEE_PRICE, label: "  " }]])),
    ).toBeNull();
  });

  test("refuses an absurd basket, same ceiling as the decomposition", () => {
    const many = [{ priceId: "price_water", quantity: 40 }];
    const water: PriceRecord = { unitAmountCents: 100, currency: "usd", label: "Water" };
    expect(itemsFromPrices(4000, "usd", many, priced([["price_water", water]]))).toBeNull();
  });

  test("guards against nonsense amounts", () => {
    expect(itemsFromPrices(0, "usd", refs, map)).toBeNull();
    expect(itemsFromPrices(-6000, "usd", refs, map)).toBeNull();
    expect(itemsFromPrices(6000.5, "usd", refs, map)).toBeNull();
    expect(itemsFromPrices(6000, "usd", [], map)).toBeNull();
  });
});

// ── itemsFromDescription ─────────────────────────────────────────────────────

describe("itemsFromDescription — what counts as an item, and what is noise", () => {
  test("reads a receipt line and derives the unit price", () => {
    expect(itemsFromDescription("2x PW Tee", "Payment for Stripe App", 6000)).toEqual([
      { label: "PW Tee", quantity: 2, unitPriceCents: 3000, candidates: ["PW Tee"] },
    ]);
    // Spacing and the multiplication sign vary between apps; the shape does not.
    expect(itemsFromDescription("3 × Popcorn", null, 1500)?.[0]).toEqual({
      label: "Popcorn",
      quantity: 3,
      unitPriceCents: 500,
      candidates: ["Popcorn"],
    });
  });

  test("RULE 1 — a description equal to the device's own default is not a product", () => {
    // The payload names its own noise, so this needs no denylist. Case and surrounding
    // whitespace don't rescue it.
    expect(itemsFromDescription("Payment for Stripe App", "Payment for Stripe App", 5000)).toBeNull();
    expect(itemsFromDescription("  payment for stripe app ", "Payment for Stripe App", 5000)).toBeNull();
    // …and a device default that DOES look like a receipt line is still the default.
    expect(itemsFromDescription("1x Sale", "1x Sale", 5000)).toBeNull();
  });

  test("RULE 2 — free text is not evidence of a SKU, whatever the metadata says", () => {
    // Rule 2 stands alone, for the rail that sends no `device_charge_description`.
    expect(itemsFromDescription("Payment for Stripe App", null, 5000)).toBeNull();
    expect(itemsFromDescription("PW Tee", null, 3000)).toBeNull();
    expect(itemsFromDescription("Merch table", undefined, 5000)).toBeNull();
    expect(itemsFromDescription("Thanks!", null, 500)).toBeNull();
  });

  test("REFUSES a multi-item description rather than splitting the money by guess", () => {
    // "2x Tee, 1x Hoodie" against one total: dividing it between them is exactly the
    // invention `salesCatalog.ts` exists to prevent. Fall through instead.
    expect(itemsFromDescription("2x PW Tee, 1x Hoodie", null, 8500)).toBeNull();
    expect(itemsFromDescription("1x Tee + 2 x Water", null, 3200)).toBeNull();
  });

  test("REFUSES when the amount doesn't divide by the quantity", () => {
    // 3 tees out of $31 would claim a unit price of $10.33 that never existed.
    expect(itemsFromDescription("3x PW Tee", null, 3100)).toBeNull();
    expect(itemsFromDescription("2x PW Tee", null, 3001)).toBeNull();
  });

  test("refuses an absurd count and a label that is a sentence", () => {
    expect(itemsFromDescription("40x Water", null, 4000)).toBeNull();
    expect(itemsFromDescription("0x PW Tee", null, 3000)).toBeNull();
    expect(itemsFromDescription(`1x ${"a".repeat(MAX_ITEM_LABEL_LENGTH + 1)}`, null, 3000)).toBeNull();
    expect(itemsFromDescription("1x   ", null, 3000)).toBeNull();
  });

  test("a product name containing digits still reads", () => {
    // "2x4" has no space after the x, so the multi-item guard leaves it alone.
    expect(itemsFromDescription("1x 2x4 Lumber", null, 800)?.[0].label).toBe("2x4 Lumber");
    expect(itemsFromDescription("2x Size 10 Tee", null, 6000)?.[0].label).toBe("Size 10 Tee");
  });

  test("shrugs at absent or junk input rather than throwing", () => {
    expect(itemsFromDescription(null, null, 3000)).toBeNull();
    expect(itemsFromDescription(undefined, null, 3000)).toBeNull();
    expect(itemsFromDescription("", null, 3000)).toBeNull();
    expect(itemsFromDescription(7, null, 3000)).toBeNull();
    expect(itemsFromDescription("1x PW Tee", null, 0)).toBeNull();
    expect(itemsFromDescription("1x PW Tee", null, -3000)).toBeNull();
  });
});

// ── the ladder ───────────────────────────────────────────────────────────────

describe("outranks — a re-sync may only ever improve a row", () => {
  const ladder: ItemSource[] = [
    "unresolved",
    "amount_decomposition",
    "charge_description",
    "stripe_line_items",
  ];

  test("every source outranks everything below it and nothing above", () => {
    for (let i = 0; i < ladder.length; i++) {
      for (let j = 0; j < ladder.length; j++) {
        expect(outranks(ladder[i], ladder[j])).toBe(i > j);
      }
    }
  });

  test("nothing can demote a resolved row back to unresolved", () => {
    // The property that keeps the sync idempotent in the face of a Stripe blip: a run
    // that resolves LESS than a previous run must change nothing.
    for (const source of ladder) {
      expect(outranks("unresolved", source)).toBe(false);
    }
    expect(outranks("amount_decomposition", "stripe_line_items")).toBe(false);
    expect(outranks("charge_description", "stripe_line_items")).toBe(false);
  });
});
