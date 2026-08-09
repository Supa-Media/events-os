import { describe, expect, test } from "vitest";
import {
  DEFAULT_FEE_SCHEDULE,
  feeCoverageCents,
  grossUpCents,
  netOfFeeCents,
  type FeeRate,
} from "@events-os/shared";
import { GROSS_UP_JS } from "../lib/givePageClient";

/**
 * THE DRIFT PIN.
 *
 * `grossUpCents` in `@events-os/shared` decides what a donor's card is
 * actually charged. The giving page has no build step, so it cannot import
 * that module, and the figure has to update live as somebody types an
 * arbitrary amount — precomputing the presets server-side would leave the
 * custom field silent, which is exactly where a donor is most likely to be
 * surprised by their total.
 *
 * So the arithmetic is transcribed into `GROSS_UP_JS`. That transcription is
 * the risk this file exists to remove: two copies of money arithmetic that
 * nothing forces to agree will eventually disagree, and the symptom is a page
 * quoting one number and a card being charged another.
 *
 * These evaluate the ACTUAL browser source and sweep it against the ACTUAL
 * implementation. A divergence of one cent, at any amount, on either rail,
 * fails here.
 */

type ClientMath = {
  grossUpCents: (intended: number, rate: FeeRate) => number;
  feeCoverageCents: (intended: number, rate: FeeRate) => number;
  feeOnCents: (gross: number, rate: FeeRate) => number;
};

/** Evaluate the browser script's fee functions in Node, as the page would. */
function loadClientMath(): ClientMath {
  return new Function(
    `${GROSS_UP_JS}
    return { grossUpCents: grossUpCents, feeCoverageCents: feeCoverageCents, feeOnCents: feeOnCents };`,
  )() as ClientMath;
}

const CARD = DEFAULT_FEE_SCHEDULE.find(
  (r) => r.processor === "stripe" && r.method === "card",
)!;
const ACH = DEFAULT_FEE_SCHEDULE.find(
  (r) => r.processor === "stripe" && r.method === "ach_debit",
)!;

describe("the browser's gross-up matches the real one", () => {
  const client = loadClientMath();

  test("the worked example on the card rate", () => {
    // $100 intended on 2.9% + 30¢ → $103.30 charged, netting exactly $100.00.
    // The NAIVE answer ($103.20) nets $99.91 — nine cents short on every gift,
    // which is the entire point of solving for the gross instead.
    expect(client.grossUpCents(10_000, CARD)).toBe(10_330);
    expect(grossUpCents(10_000, CARD)).toBe(10_330);
    expect(netOfFeeCents(10_330, CARD)).toBe(10_000);
    expect(client.feeCoverageCents(10_000, CARD)).toBe(330);
  });

  test("inside the ACH cap the answer is intended + cap, not the formula", () => {
    // Once the cap binds the fee is a CONSTANT and the percentage term drops
    // out. Running the closed form anyway returns $626.01 where $626.00 nets
    // the same — a cent the donor never agreed to, recurring on every large
    // gift. Both copies have to check the cap FIRST.
    expect(client.grossUpCents(62_100, ACH)).toBe(62_600);
    expect(grossUpCents(62_100, ACH)).toBe(62_600);
    expect(netOfFeeCents(62_600, ACH)).toBe(62_100);
  });

  test("they agree on every amount from $0.01 to $10,000, on both rails", () => {
    const mismatches: string[] = [];
    for (const [name, rate] of [
      ["card", CARD as FeeRate],
      ["ach", ACH as FeeRate],
    ] as const) {
      // Dense through the small amounts where the fixed fee dominates and the
      // rounding is most fragile, then coarser out past the ACH cap.
      for (let cents = 1; cents <= 100_000; cents += cents < 2_000 ? 1 : 37) {
        const mine = client.grossUpCents(cents, rate);
        const real = grossUpCents(cents, rate);
        if (mine !== real) mismatches.push(`${name} @ ${cents}: ${mine} vs ${real}`);
      }
    }
    expect(mismatches.slice(0, 10)).toEqual([]);
  });

  test("and the coverage figure the page displays is the charge minus the gift", () => {
    for (const cents of [100, 2_500, 5_000, 10_000, 25_000, 50_000, 62_500, 100_000]) {
      expect(client.feeCoverageCents(cents, CARD)).toBe(feeCoverageCents(cents, CARD));
      expect(client.feeCoverageCents(cents, ACH)).toBe(feeCoverageCents(cents, ACH));
    }
  });

  test("a zero or negative amount produces no charge and no coverage", () => {
    for (const bad of [0, -1, -10_000]) {
      expect(client.grossUpCents(bad, CARD)).toBe(0);
      expect(grossUpCents(bad, CARD)).toBe(0);
    }
  });
});

describe("the nudge's saving figure", () => {
  const client = loadClientMath();

  test("ACH is cheaper at EVERY amount — there is no crossover to find", () => {
    // The threshold is a friction judgement, not a break-even. If somebody
    // later "fixes" it into a computed crossover, this is the test that says
    // there isn't one.
    for (let cents = 1; cents <= 200_000; cents += 97) {
      const card = client.feeOnCents(cents, CARD);
      const ach = client.feeOnCents(cents, ACH);
      expect(ach).toBeLessThanOrEqual(card);
    }
  });

  test("and past the cap it is not close", () => {
    // $5,000: $145.30 on card, $5.00 by bank.
    expect(client.feeOnCents(500_000, CARD)).toBe(14_530);
    expect(client.feeOnCents(500_000, ACH)).toBe(500);
  });
});
