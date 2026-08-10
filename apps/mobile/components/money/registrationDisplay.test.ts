import {
  refundsAreScholarships,
  registrationDayLabel,
  registrationStatusLabel,
} from "./registrationDisplay";

describe("registrationDayLabel", () => {
  const jan29_2026 = Date.UTC(2026, 0, 29, 12);

  it("drops the year inside the current year", () => {
    expect(registrationDayLabel(jan29_2026, Date.UTC(2026, 7, 10))).toBe("Jan 29");
  });

  it("keeps the year once the project outlives it", () => {
    expect(registrationDayLabel(jan29_2026, Date.UTC(2027, 0, 2))).toBe(
      "Jan 29, 2026",
    );
  });
});

describe("registrationStatusLabel", () => {
  it("is a bare 'paid' for money kept", () => {
    expect(registrationStatusLabel({ status: "paid", refundReason: null })).toBe(
      "paid",
    );
  });

  it("carries the reason so a scholarship reads as one", () => {
    expect(
      registrationStatusLabel({ status: "refunded", refundReason: "scholarship" }),
    ).toBe("refunded — scholarship");
  });

  it("falls back to the bare status when nobody wrote a reason", () => {
    expect(
      registrationStatusLabel({ status: "refunded", refundReason: null }),
    ).toBe("refunded");
  });

  it("never invents a reason for a comped place", () => {
    expect(registrationStatusLabel({ status: "comped", refundReason: null })).toBe(
      "comped",
    );
  });
});

describe("refundsAreScholarships", () => {
  const scholarship = { status: "refunded" as const, refundReason: "scholarship" };
  const paid = { status: "paid" as const, refundReason: null };

  it("is true when every refund was a scholarship", () => {
    expect(refundsAreScholarships([paid, scholarship, scholarship])).toBe(true);
  });

  it("is false when there are no refunds at all", () => {
    expect(refundsAreScholarships([paid, paid])).toBe(false);
  });

  it("one ordinary cancellation makes the whole line say refunded", () => {
    expect(
      refundsAreScholarships([
        scholarship,
        scholarship,
        { status: "refunded", refundReason: "changed their mind" },
      ]),
    ).toBe(false);
  });

  it("a refund with no reason at all is not a scholarship", () => {
    expect(refundsAreScholarships([{ status: "refunded", refundReason: null }])).toBe(
      false,
    );
  });

  it("comped places don't make the refund line say anything", () => {
    expect(
      refundsAreScholarships([{ status: "comped", refundReason: null }]),
    ).toBe(false);
  });
});
