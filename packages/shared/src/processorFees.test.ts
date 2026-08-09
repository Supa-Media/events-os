import { describe, expect, test } from "vitest";
import {
  ACH_NUDGE_THRESHOLD_CENTS,
  DEFAULT_FEE_SCHEDULE,
  achSavingCents,
  defaultFeeRate,
  describeFeeRate,
  effectiveRateBps,
  feeCoverageCents,
  feeOnCents,
  feeRateProblems,
  grossUpCents,
  netOfFeeCents,
  type FeeRate,
} from "./processorFees";

/**
 * The fee schedule and, above all, THE GROSS-UP.
 *
 * "Cover the processing fees" is the single most commonly mis-implemented
 * donation feature there is, and it fails silently: the org quietly nets a few
 * cents less than intended on every gift and nobody notices for a year. So the
 * central assertion in this file is not a set of expected numbers — it is the
 * INVARIANT, swept across hundreds of amounts on every rail:
 *
 *     net(grossUp(intended)) >= intended,  and it is the SMALLEST such gross.
 *
 * The named cases below then pin the specific numbers a human would check by
 * hand, including the two places the algebra changes shape (the fixed fee
 * dominating a tiny gift, and the ACH cap).
 */

const CARD = defaultFeeRate("stripe", "card")!;
const ACH = defaultFeeRate("stripe", "ach_debit")!;
const CASH_APP = defaultFeeRate("cash_app", "wallet")!;

describe("the schedule itself", () => {
  test("the published rates are what Stripe and Cash App charge", () => {
    expect(CARD).toEqual({ percentBps: 290, fixedCents: 30 });
    expect(ACH).toEqual({ percentBps: 80, fixedCents: 0, capCents: 500 });
    expect(CASH_APP).toEqual({ percentBps: 260, fixedCents: 15 });
  });

  test("a rail the codebase doesn't have has no rate — it is never invented", () => {
    expect(defaultFeeRate("cash_app", "ach_debit")).toBeNull();
    expect(defaultFeeRate("stripe", "wallet")).toBeNull();
  });

  test("every shipped rate is a usable one", () => {
    for (const rail of DEFAULT_FEE_SCHEDULE) {
      expect(feeRateProblems(rail)).toEqual([]);
    }
  });

  test("rates that would break the arithmetic are rejected", () => {
    // At or above 100% there is no gross that nets the intended amount.
    expect(feeRateProblems({ percentBps: 10_000, fixedCents: 0 })).toHaveLength(1);
    expect(feeRateProblems({ percentBps: -1, fixedCents: 0 })).toHaveLength(1);
    expect(feeRateProblems({ percentBps: 290, fixedCents: -5 })).toHaveLength(1);
    expect(feeRateProblems({ percentBps: 290, fixedCents: 30, capCents: 0 })).toHaveLength(1);
    expect(feeRateProblems({ percentBps: 2.5, fixedCents: 0 })).toHaveLength(1);
  });

  test("a rate reads the way a person would say it", () => {
    expect(describeFeeRate(CARD)).toBe("2.9% + $0.30");
    expect(describeFeeRate(ACH)).toBe("0.8%, capped at $5.00");
    expect(describeFeeRate(CASH_APP)).toBe("2.6% + $0.15");
  });
});

describe("feeOnCents", () => {
  test("card: 2.9% + 30¢, rounded per payment", () => {
    expect(feeOnCents(10_000, CARD)).toBe(320); // $100.00 → $3.20
    expect(feeOnCents(2_500, CARD)).toBe(103); // $25.00 → $1.03
    expect(feeOnCents(100, CARD)).toBe(33); // $1.00 → $0.33 (the fixed fee dominates)
  });

  test("Cash App reproduces the owner's own payment-detail screens", () => {
    expect(feeOnCents(5_000, CASH_APP)).toBe(145); // $50.00 → $1.45
    expect(feeOnCents(10_000, CASH_APP)).toBe(275); // $100.00 → $2.75
  });

  test("ACH: 0.8%, and the cap BINDS above $625", () => {
    expect(feeOnCents(10_000, ACH)).toBe(80); // $100 → $0.80
    expect(feeOnCents(62_500, ACH)).toBe(500); // $625.00 → exactly the cap
    expect(feeOnCents(62_600, ACH)).toBe(500); // a cent more costs nothing more
    expect(feeOnCents(500_000, ACH)).toBe(500); // $5,000 → still $5.00
    expect(feeOnCents(10_000_000, ACH)).toBe(500); // $100,000 → still $5.00
  });

  test("nothing is charged on nothing", () => {
    expect(feeOnCents(0, CARD)).toBe(0);
    expect(feeOnCents(-100, CARD)).toBe(0);
  });
});

describe("grossUpCents — the number the donor is actually charged", () => {
  /**
   * THE TEST TABLE. Each row is `[label, intended, rate, expected gross]`,
   * hand-checkable against `G = (intended + fixed) / (1 - percent)`.
   */
  const TABLE: [string, number, FeeRate, number][] = [
    // ── The headline case ────────────────────────────────────────────────────
    // (10000 + 30) / (1 - 0.029) = 10329.55… → 10330. NOT 10320, which is what
    // "add the fee to the intended amount" gives and which nets only $99.91.
    ["$100 on card", 10_000, CARD, 10_330],
    ["$25 on card", 2_500, CARD, 2_606],
    ["$500 on card", 50_000, CARD, 51_524],
    ["$5,000 on card", 500_000, CARD, 514_964],

    // ── Small amounts, where the FIXED fee dominates ─────────────────────────
    // A $1 gift costs 33¢ to take; covering it is a 34% uplift, and the
    // percentage term is almost irrelevant. (100 + 30) / 0.971 = 133.88 → 134.
    ["$1 on card", 100, CARD, 134],
    ["$2 on card", 200, CARD, 237],
    ["$5 on card", 500, CARD, 546],
    ["$0.50 on card", 50, CARD, 82],

    // ── Cash App ─────────────────────────────────────────────────────────────
    ["$50 on Cash App", 5_000, CASH_APP, 5_149],
    ["$100 on Cash App", 10_000, CASH_APP, 10_282],

    // ── ACH below the cap: ordinary algebra ──────────────────────────────────
    ["$100 by ACH", 10_000, ACH, 10_081],
    ["$500 by ACH", 50_000, ACH, 50_403],

    // ── ACH AT the cap boundary ($625 gross is exactly $5.00) ────────────────
    ["$620 by ACH (just under the cap)", 62_000, ACH, 62_500],

    // ── ACH ABOVE the cap: THE ALGEBRA CHANGES SHAPE ─────────────────────────
    // The fee is a constant here, so the answer is intended + cap and the
    // percentage term drops out. Running the closed form anyway returns 62601
    // for the first of these — a cent of overcharge, on every gift over $625.
    ["$621 by ACH (cap binds)", 62_100, ACH, 62_600],
    ["$1,000 by ACH", 100_000, ACH, 100_500],
    ["$5,000 by ACH", 500_000, ACH, 500_500],
    ["$100,000 by ACH", 10_000_000, ACH, 10_000_500],
  ];

  test.each(TABLE)("%s", (_label, intended, rate, expected) => {
    expect(grossUpCents(intended, rate)).toBe(expected);
  });

  test("THE INVARIANT: across every amount and rail, the net is never short — and never over-charged", () => {
    const rails: [string, FeeRate][] = [
      ["card", CARD],
      ["ach", ACH],
      ["cash_app", CASH_APP],
      // A rate with no fixed component and no cap, and one that is nothing but
      // a fixed fee — the two degenerate shapes.
      ["percent-only", { percentBps: 500, fixedCents: 0 }],
      ["fixed-only", { percentBps: 0, fixedCents: 45 }],
      // A cap so low it binds from the very first cent.
      ["always-capped", { percentBps: 290, fixedCents: 30, capCents: 25 }],
    ];
    const amounts = [
      ...Array.from({ length: 200 }, (_, i) => i + 1), // 1¢ … $2.00
      ...Array.from({ length: 120 }, (_, i) => 60_000 + i * 100), // around the ACH cap
      ...[1_000, 5_000, 12_345, 99_999, 250_000, 1_000_000, 9_999_999],
    ];

    for (const [name, rate] of rails) {
      for (const intended of amounts) {
        const gross = grossUpCents(intended, rate);
        const net = netOfFeeCents(gross, rate);
        expect(
          net,
          `${name} @ ${intended}¢ netted ${net}¢ from a ${gross}¢ charge — SHORT`,
        ).toBeGreaterThanOrEqual(intended);
        // And it is the SMALLEST such charge: one cent less would fall short.
        expect(
          netOfFeeCents(gross - 1, rate),
          `${name} @ ${intended}¢ charged ${gross}¢ when ${gross - 1}¢ would have done`,
        ).toBeLessThan(intended);
      }
    }
  });

  test("the coverage figure and the gross can never disagree", () => {
    for (const intended of [100, 2_500, 10_000, 62_100, 500_000]) {
      for (const rate of [CARD, ACH, CASH_APP]) {
        expect(intended + feeCoverageCents(intended, rate)).toBe(
          grossUpCents(intended, rate),
        );
      }
    }
  });

  test("covering $100 on card costs the donor $3.30, and the ministry receives $100.00", () => {
    const gross = grossUpCents(10_000, CARD);
    expect(gross).toBe(10_330);
    expect(feeCoverageCents(10_000, CARD)).toBe(330);
    expect(netOfFeeCents(gross, CARD)).toBe(10_000);
    // The naive answer, for the record: $103.20 charged nets $99.91 — nine
    // cents short, every time.
    expect(netOfFeeCents(10_320, CARD)).toBe(9_991);
  });

  test("nothing to gross up is nothing", () => {
    expect(grossUpCents(0, CARD)).toBe(0);
    expect(grossUpCents(-500, CARD)).toBe(0);
  });
});

describe("the ACH nudge", () => {
  test("ACH is cheaper than card at EVERY amount — the threshold is not a crossover", () => {
    for (const cents of [1, 50, 100, 2_500, 10_000, 62_500, 500_000]) {
      expect(achSavingCents(cents, CARD, ACH)).toBeGreaterThan(0);
    }
  });

  test("the saving is what makes the ask worth making at all", () => {
    // $25: 83¢ saved — not worth interrupting anyone over.
    expect(achSavingCents(2_500, CARD, ACH)).toBe(83);
    // $500: $10.80 saved — proportionate to the ask.
    expect(achSavingCents(50_000, CARD, ACH)).toBe(1_080);
    // $5,000: $145.30 vs $5.00 — the number that justifies the whole feature.
    expect(feeOnCents(500_000, CARD)).toBe(14_530);
    expect(feeOnCents(500_000, ACH)).toBe(500);
    expect(achSavingCents(500_000, CARD, ACH)).toBe(14_030);
  });

  test("the threshold is a product judgement, and it is $500", () => {
    expect(ACH_NUDGE_THRESHOLD_CENTS).toBe(50_000);
  });
});

describe("effectiveRateBps — the monitor's signal", () => {
  test("fees over volume, in basis points", () => {
    expect(effectiveRateBps(320, 10_000)).toBe(320); // 3.20%
    expect(effectiveRateBps(27_554, 1_000_000)).toBe(276); // 2.76%
  });

  test("a period that processed nothing has NO rate — not a rate of zero", () => {
    // Charting 0% for an empty month draws a cliff that never happened.
    expect(effectiveRateBps(0, 0)).toBeNull();
    expect(effectiveRateBps(500, 0)).toBeNull();
  });
});
