/**
 * THE RECURRING SECTION'S HEADLINE.
 *
 * The failure this guards against is the one the Budgets screen's file header
 * keeps warning about: a total that adds two different UNITS together and so
 * describes nothing on screen. Every test here is either "the units stayed
 * separate" or "the strip says exactly what the cards under it say".
 */
import {
  recurringWindowTotals,
  type RecurringRowLike,
} from "./recurringWindowTotals";

const row = (
  cadence: string,
  capCents: number,
  spentCents: number,
): RecurringRowLike => ({
  cadence,
  capCents,
  spentCents,
  // The server's own definition — the card prints this figure verbatim.
  remainingCents: capCents - spentCents,
});

describe("recurringWindowTotals", () => {
  it("sums each cadence into ITS OWN window row, never across cadences", () => {
    const totals = recurringWindowTotals([
      row("monthly", 50_000, 20_000),
      row("monthly", 30_000, 35_000),
      row("quarterly", 100_000, 40_000),
    ]);

    expect(totals.map((t) => t.label)).toEqual(["This month", "This quarter"]);
    // A month cap and a quarter cap never land in the same figure.
    expect(totals[0]).toMatchObject({
      cadence: "monthly",
      count: 2,
      capCents: 80_000,
      spentCents: 55_000,
      remainingCents: 25_000,
    });
    expect(totals[1]).toMatchObject({
      cadence: "quarterly",
      count: 1,
      capCents: 100_000,
      spentCents: 40_000,
      remainingCents: 60_000,
    });
  });

  it("renders no row for a cadence with no budgets", () => {
    // "This quarter · $0.00 of $0.00" reads as a quarter nobody spent in,
    // which is a different claim from "this chapter has no quarterly buckets".
    const totals = recurringWindowTotals([row("monthly", 50_000, 10_000)]);
    expect(totals).toHaveLength(1);
    expect(totals[0].cadence).toBe("monthly");
  });

  it("gives yearly buckets their own row rather than folding them in", () => {
    const totals = recurringWindowTotals([
      row("monthly", 50_000, 10_000),
      row("yearly", 1_200_000, 300_000),
    ]);
    expect(totals.map((t) => t.cadence)).toEqual(["monthly", "yearly"]);
    // The yearly cap did not leak into the month's number.
    expect(totals[0].capCents).toBe(50_000);
    expect(totals[1].capCents).toBe(1_200_000);
  });

  it("keeps the order monthly → quarterly → yearly whatever the rows' order", () => {
    const totals = recurringWindowTotals([
      row("yearly", 1_000, 0),
      row("quarterly", 2_000, 0),
      row("monthly", 3_000, 0),
    ]);
    expect(totals.map((t) => t.cadence)).toEqual([
      "monthly",
      "quarterly",
      "yearly",
    ]);
  });

  it("carries an over-budget bucket through as a NEGATIVE remainder", () => {
    // One bucket $150 over, one $100 under: the row is $50 over, and the strip
    // must be able to say so rather than showing an absolute value that reads
    // as room left.
    const totals = recurringWindowTotals([
      row("monthly", 10_000, 25_000),
      row("monthly", 20_000, 10_000),
    ]);
    expect(totals[0].remainingCents).toBe(-5_000);
  });

  it("sums the rows' OWN remaining figures, so the strip can't drift from the cards", () => {
    // A row whose `remainingCents` disagrees with cap − spent (the server's
    // definition changing under us) must still be reported as the cards below
    // report it. Recomputing here is how the two would silently diverge.
    const totals = recurringWindowTotals([
      { cadence: "monthly", capCents: 50_000, spentCents: 20_000, remainingCents: 1 },
    ]);
    expect(totals[0].remainingCents).toBe(1);
  });

  it("groups a non-repeating cadence on a recurring row instead of dropping it", () => {
    // `per_instance`/`one_off` on a recurring row is a data anomaly with no
    // named window. It still has a card on screen, so it still has to be in
    // the strip — just not counted as a month.
    const totals = recurringWindowTotals([
      row("monthly", 50_000, 10_000),
      row("per_instance", 7_000, 1_000),
      row("one_off", 3_000, 500),
    ]);
    expect(totals.map((t) => t.label)).toEqual(["This month", "This period"]);
    expect(totals[1]).toMatchObject({ count: 2, capCents: 10_000, spentCents: 1_500 });
  });

  it("produces no rows at all for an empty list", () => {
    expect(recurringWindowTotals([])).toEqual([]);
  });
});
