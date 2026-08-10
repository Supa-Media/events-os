import {
  refundsAreScholarships,
  registrationDayLabel,
  registrationStatusLabel,
} from "./registrationDisplay";

describe("registrationDayLabel", () => {
  /**
   * MIDNIGHT UTC — the value the backfill actually stores, and the ONLY fixture
   * that can catch the bug this function exists to avoid.
   *
   * The first version of this test used NOON UTC, which is the one part of the
   * day where the device zone and UTC agree about the date across the whole
   * Americas. It passed against a function that rendered every row a day early
   * on any US device. A test that cannot fail on the bug is worse than no test,
   * because it certifies the thing it never checked.
   */
  const jan26_2026 = Date.UTC(2026, 0, 26); // 2026-01-26T00:00:00.000Z
  const jan29_2026 = Date.UTC(2026, 0, 29);

  /** Run a case as if the phone were in New York (UTC−5 in January) — the zone
   *  the whole org is in, and the one that breaks a device-zone read. */
  function inZone<T>(tz: string, fn: () => T): T {
    const prev = process.env.TZ;
    process.env.TZ = tz;
    try {
      return fn();
    } finally {
      process.env.TZ = prev;
    }
  }

  it("drops the year inside the current year", () => {
    expect(registrationDayLabel(jan29_2026, Date.UTC(2026, 7, 10))).toBe("Jan 29");
  });

  it("keeps the year once the project outlives it", () => {
    expect(registrationDayLabel(jan29_2026, Date.UTC(2027, 0, 2))).toBe(
      "Jan 29, 2026",
    );
  });

  it("reads the stored UTC day, not the device's — a US phone must not show Jan 25", () => {
    // The regression. `Intl` honours `timeZone: "UTC"` regardless of process.env.TZ,
    // so this asserts the option is present rather than relying on the ambient zone.
    expect(registrationDayLabel(jan26_2026, Date.UTC(2026, 7, 10))).toBe("Jan 26");
    inZone("America/New_York", () => {
      expect(registrationDayLabel(jan26_2026, Date.UTC(2026, 7, 10))).toBe("Jan 26");
      expect(registrationDayLabel(jan29_2026, Date.UTC(2026, 7, 10))).toBe("Jan 29");
    });
    inZone("America/Los_Angeles", () => {
      expect(registrationDayLabel(jan26_2026, Date.UTC(2026, 7, 10))).toBe("Jan 26");
    });
    // …and east of Greenwich, where a naive read errs the other way.
    inZone("Asia/Tokyo", () => {
      expect(registrationDayLabel(jan26_2026, Date.UTC(2026, 7, 10))).toBe("Jan 26");
    });
  });

  it("the YEAR rule is UTC too — a Jan 1 UTC row is Dec 31 locally", () => {
    const jan1_2026 = Date.UTC(2026, 0, 1); // 2025-12-31T19:00 in New York
    // Same UTC year as `now` → no year suffix. A device-zone `getFullYear()`
    // would read 2025, disagree with `now`, and wrongly append ", 2026".
    expect(registrationDayLabel(jan1_2026, Date.UTC(2026, 5, 1))).toBe("Jan 1");
  });

  it("matches the six real registration dates exactly as the export states them", () => {
    // The whole point of the feature: these must read Jan 26 / Jan 29 to
    // whoever is holding the Givebutter export.
    inZone("America/New_York", () => {
      expect(registrationDayLabel(Date.parse("2026-01-26T00:00:00.000Z"), jan29_2026)).toBe(
        "Jan 26",
      );
      expect(registrationDayLabel(Date.parse("2026-01-29T00:00:00.000Z"), jan29_2026)).toBe(
        "Jan 29",
      );
    });
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
