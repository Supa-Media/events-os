/**
 * THE BIGGEST NUMBER ON THE BUDGETS TAB.
 *
 * Two failures are guarded here, and they pull in opposite directions:
 *
 *  1. UNDER-COUNTING — a budget that is on the page but not in the headline.
 *     That is the bug that prompted this file ("the top is just false"): the
 *     strip covered one-time budgets only, so four standing buckets were
 *     rendered as cards and silently left out of the total above them.
 *  2. OVER-COUNTING — a PROJECTED window reaching the spend figure. The server
 *     pads `periods` with forecast windows to draw the faded bars, and folding
 *     those into "spent" would tell a chapter it had spent money it hasn't.
 *
 * The headline test reproduces the founder's real 2026 page end to end, so a
 * regression fails as the screen they were looking at rather than as an
 * abstraction.
 */
import { annualBudgetTotals, type AnnualRowLike } from "./annualBudgetTotals";
import type { PeriodState } from "./recurringPeriodSummary";

/** A one-time budget (or anything else the server sends with no `periods`). */
const oneTime = (capCents: number, spentCents: number): AnnualRowLike => ({
  cadence: "one_off",
  capCents,
  spentCents,
});

/** A repeating bucket: `capCents` is ONE window's cap, and `elapsed` is the
 *  real spend per finished/current window. `projected` are the server's
 *  forecast windows — money nobody has spent. */
const repeating = (
  cadence: string,
  capCents: number,
  elapsed: number[],
  projected: number[] = [],
): AnnualRowLike => ({
  cadence,
  capCents,
  // The current-window figures the card header prints. Deliberately NOT the
  // year's — using these directly is exactly the under-count being guarded.
  spentCents: elapsed[elapsed.length - 1] ?? 0,
  periods: [
    ...elapsed.map((spentCents, i) => ({
      spentCents,
      state: (i === elapsed.length - 1 ? "current" : "past") as PeriodState,
    })),
    ...projected.map((spentCents) => ({ spentCents, state: "projected" as const })),
  ],
});

describe("annualBudgetTotals", () => {
  it("annualises a monthly bucket's cap and sums only elapsed spend", () => {
    // $500/mo = $6,000 for the year. Eight months have happened.
    const totals = annualBudgetTotals([
      repeating("monthly", 50_000, [30_000, 20_000, 40_000], [45_000, 45_000]),
    ]);
    expect(totals.capCents).toBe(600_000);
    // 300 + 200 + 400 — the two projected windows are excluded.
    expect(totals.spentCents).toBe(90_000);
    expect(totals.remainingCents).toBe(510_000);
  });

  it("annualises a quarterly bucket by four, not twelve", () => {
    const totals = annualBudgetTotals([
      repeating("quarterly", 40_000, [10_000, 20_000], [15_000, 15_000]),
    ]);
    expect(totals.capCents).toBe(160_000);
    expect(totals.spentCents).toBe(30_000);
  });

  it("leaves a row with no periods exactly as the server sent it", () => {
    // Covers both a one-time budget and a `yearly` bucket: the window already
    // IS the year, so multiplying by a window count would inflate it.
    expect(annualBudgetTotals([oneTime(500_000, 5_050)])).toMatchObject({
      capCents: 500_000,
      spentCents: 5_050,
    });
    expect(
      annualBudgetTotals([{ cadence: "yearly", capCents: 100_000, spentCents: 97_878 }]),
    ).toMatchObject({ capCents: 100_000, spentCents: 97_878 });
  });

  it("does not annualise an unknown cadence it can't reason about", () => {
    // `windowsPerYear` falls back to the periods length, so a two-window
    // anomaly contributes 2× its cap rather than 12× — degrading toward the
    // data present instead of toward a month count that doesn't apply.
    const totals = annualBudgetTotals([repeating("per_instance", 1_000, [400, 300])]);
    expect(totals.capCents).toBe(2_000);
    expect(totals.spentCents).toBe(700);
  });

  it("reports a negative remainder when the year is overspent", () => {
    // $10/mo = $120 for the year; $250 has already gone out the door. Note the
    // cap is 12× regardless of how many windows have elapsed — a known cadence
    // annualises by the calendar, not by how far into the year we are.
    const totals = annualBudgetTotals([repeating("monthly", 1_000, [15_000, 10_000])]);
    expect(totals.capCents).toBe(12_000);
    expect(totals.spentCents).toBe(25_000);
    expect(totals.remainingCents).toBe(-13_000);
  });

  it("counts every row, so the headline can say what it summed", () => {
    expect(annualBudgetTotals([oneTime(1, 0), oneTime(2, 0)]).count).toBe(2);
    expect(annualBudgetTotals([])).toEqual({
      capCents: 0,
      spentCents: 0,
      remainingCents: 0,
      count: 0,
    });
  });

  /**
   * The founder's own 2026 page, figure for figure. Ten event budgets totalling
   * $13,800, plus the four standing buckets that were missing from the top.
   */
  it("reproduces the real 2026 page: $22,900 budgeted, $10,853.99 spent", () => {
    const events = [
      oneTime(500_000, 5_050), // Love Thy Neighbor 2026
      oneTime(200_000, 183_205), // Field Day
      oneTime(50_000, 31_372), // Worship With Strangers Aug
      oneTime(50_000, 24_957), // Create sponsorship packages
      oneTime(50_000, 27_011), // Worship With Strangers Jun
      oneTime(200_000, 181_976), // Eden 2026
      oneTime(50_000, 27_917), // Worship With Strangers Apr
      oneTime(100_000, 92_500), // Love Wins
      oneTime(50_000, 25_243), // Worship With Strangers Feb
      oneTime(130_000, 67_172), // Worship Beyond the walls
    ];
    const eventsOnly = annualBudgetTotals(events);
    expect(eventsOnly.capCents).toBe(1_380_000);
    expect(eventsOnly.spentCents).toBe(666_403);

    const standing: AnnualRowLike[] = [
      // Operating Expenses — $500/mo, $2,496.50 across 8 months.
      repeating(
        "monthly",
        50_000,
        [20_000, 30_000, 40_000, 25_000, 35_000, 30_000, 45_229, 24_421],
        [30_000, 30_000, 30_000, 30_000],
      ),
      // Culture Fund — $400/qtr, $698.32 across 3 quarters.
      repeating("quarterly", 40_000, [20_000, 16_489, 33_343], [23_277]),
      // Equipment Repairs & Upgrades and Education & Growth — yearly buckets.
      { cadence: "yearly", capCents: 100_000, spentCents: 97_878 },
      { cadence: "yearly", capCents: 50_000, spentCents: 1_636 },
    ];

    const totals = annualBudgetTotals([...events, ...standing]);
    // $13,800 + $6,000 + $1,600 + $1,000 + $500.
    expect(totals.capCents).toBe(2_290_000);
    // $6,664.03 + $2,496.50 + $698.32 + $978.78 + $16.36.
    expect(totals.spentCents).toBe(1_085_399);
    expect(totals.remainingCents).toBe(1_204_601);
    expect(totals.count).toBe(14);

    // The whole point: the standing buckets moved the headline. A regression
    // that quietly drops them again lands right back on the old $13,800.
    expect(totals.capCents).toBeGreaterThan(eventsOnly.capCents);
  });
});
