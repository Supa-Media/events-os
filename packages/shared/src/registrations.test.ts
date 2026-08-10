import { describe, expect, it } from "vitest";
import {
  netCostCents,
  registrationCountLine,
  summarizeRegistrations,
  type RegistrationLike,
} from "./registrations";

/** The real Worship Beyond The Walls cohort: six $50 places, three refunded
 *  as scholarships. Every assertion below is in CENTS, never a formatted
 *  string — a money test that compares "$150.00" passes when the arithmetic is
 *  right AND when the formatter is wrong. */
const WBTW: RegistrationLike[] = [
  { amountCents: 5_000, status: "paid" },
  { amountCents: 5_000, status: "paid" },
  { amountCents: 5_000, status: "paid" },
  { amountCents: 5_000, status: "refunded" },
  { amountCents: 5_000, status: "refunded" },
  { amountCents: 5_000, status: "refunded" },
];

describe("summarizeRegistrations", () => {
  it("counts only paid rows as collected", () => {
    const s = summarizeRegistrations(WBTW);
    expect(s.collectedCents).toBe(15_000);
    expect(s.paidCount).toBe(3);
    expect(s.refundedCount).toBe(3);
    expect(s.compedCount).toBe(0);
  });

  it("a refunded registration contributes nothing, however large", () => {
    expect(
      summarizeRegistrations([{ amountCents: 1_000_000, status: "refunded" }])
        .collectedCents,
    ).toBe(0);
  });

  it("a comped registration contributes nothing but is still counted", () => {
    const s = summarizeRegistrations([{ amountCents: 5_000, status: "comped" }]);
    expect(s.collectedCents).toBe(0);
    expect(s.compedCount).toBe(1);
  });

  it("is empty-safe", () => {
    expect(summarizeRegistrations([])).toEqual({
      collectedCents: 0,
      paidCount: 0,
      refundedCount: 0,
      compedCount: 0,
    });
  });
});

describe("registrationCountLine", () => {
  it("says scholarship when the refunds were scholarships", () => {
    expect(registrationCountLine(summarizeRegistrations(WBTW), true)).toBe(
      "3 paid, 3 scholarship",
    );
  });

  it("says refunded when they weren't", () => {
    expect(registrationCountLine(summarizeRegistrations(WBTW), false)).toBe(
      "3 paid, 3 refunded",
    );
  });

  it("omits the zero buckets", () => {
    expect(
      registrationCountLine(
        summarizeRegistrations([{ amountCents: 5_000, status: "paid" }]),
        false,
      ),
    ).toBe("1 paid");
  });

  it("names comped places", () => {
    expect(
      registrationCountLine(
        summarizeRegistrations([
          { amountCents: 5_000, status: "paid" },
          { amountCents: 5_000, status: "comped" },
        ]),
        false,
      ),
    ).toBe("1 paid, 1 comped");
  });

  it("is empty for an empty cohort, so the caller renders nothing", () => {
    expect(registrationCountLine(summarizeRegistrations([]), false)).toBe("");
  });
});

describe("netCostCents", () => {
  it("is spend minus income — the real Worship Beyond The Walls figures", () => {
    expect(netCostCents(67_172, 15_000)).toBe(52_172);
  });

  it("goes negative when a project took in more than it spent", () => {
    expect(netCostCents(10_000, 15_000)).toBe(-5_000);
  });

  it("NEVER touches the budget cap — net cost is derived, not stored", () => {
    // The guard this test exists for: someone "improving" the budget bar by
    // netting income into the cap. `netCostCents` takes SPEND and INCOME and
    // knows nothing about a cap, so a cap can never leak into it. If this
    // function ever grows a third argument named like a budget, that change
    // is the bug — see the doc comment on `netCostCents`.
    expect(netCostCents.length).toBe(2);
  });
});
