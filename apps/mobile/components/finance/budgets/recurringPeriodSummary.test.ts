/**
 * THE SUMMARY LINE UNDER A RECURRING BUCKET'S WINDOW STRIP.
 *
 * The founder asked for "all the past months… and predict how much we will
 * spend based on previous spending". The prediction is the dangerous half: it
 * sits in the same sentence as real spend, in the same units, and if the two
 * are ever added into the same figure the app tells a chapter it has spent
 * money it hasn't. Every test here is about that boundary.
 */
import {
  recurringPeriodSummary,
  windowsPerYear,
  type PeriodLike,
} from "./recurringPeriodSummary";

const past = (spentCents: number): PeriodLike => ({ spentCents, state: "past" });
const current = (spentCents: number): PeriodLike => ({
  spentCents,
  state: "current",
});
const projected = (spentCents: number): PeriodLike => ({
  spentCents,
  state: "projected",
});

describe("windowsPerYear", () => {
  it("knows the two cadences that have windows", () => {
    expect(windowsPerYear("monthly", 99)).toBe(12);
    expect(windowsPerYear("quarterly", 99)).toBe(4);
  });

  it("falls back for anything else rather than inventing a denominator", () => {
    // A yearly bucket never reaches this code (it carries no periods at all),
    // but a denominator guessed from a cadence nobody has added yet would be
    // silently wrong instead of visibly absent.
    expect(windowsPerYear("yearly", 3)).toBe(3);
  });
});

describe("recurringPeriodSummary", () => {
  it("keeps projected windows OUT of spend-to-date and IN the year forecast", () => {
    const s = recurringPeriodSummary(
      [past(10_000), past(20_000), current(5_000), projected(15_000), projected(15_000)],
      50_000,
      "monthly",
    );
    // Real money only — the two projected windows are not in this number.
    expect(s.spentToDateCents).toBe(35_000);
    // …and they are in this one.
    expect(s.projectedYearCents).toBe(65_000);
    expect(s.elapsedCount).toBe(3);
    expect(s.projectedCount).toBe(2);
  });

  it("counts COMPLETED windows separately from elapsed ones", () => {
    // The projection's sample excludes the current window (partial by
    // definition), so the sentence "an estimate from the N completed months"
    // has to say N, not N+1.
    const s = recurringPeriodSummary(
      [past(1_000), past(2_000), current(500)],
      10_000,
      "monthly",
    );
    expect(s.elapsedCount).toBe(3);
    expect(s.completedCount).toBe(2);
  });

  it("with nothing projected, the forecast IS the spend", () => {
    // January, or Q1: the server withholds projection entirely. The two
    // figures must coincide, because the client decides whether to render the
    // "on track for" line at all from `projectedCount`.
    const s = recurringPeriodSummary([current(4_000)], 50_000, "monthly");
    expect(s.projectedYearCents).toBe(s.spentToDateCents);
    expect(s.projectedCount).toBe(0);
    expect(s.completedCount).toBe(0);
  });

  it("scales the year cap by the CADENCE, not by how many windows were sent", () => {
    // Quarterly, in Q2, projection withheld: three of four windows are absent
    // from the array. The year's cap is still four quarters' worth.
    const s = recurringPeriodSummary([past(1_000), current(2_000)], 40_000, "quarterly");
    expect(s.yearCapCents).toBe(160_000);
    // Monthly with a partial array is the same story.
    expect(
      recurringPeriodSummary([past(1_000)], 50_000, "monthly").yearCapCents,
    ).toBe(600_000);
  });

  it("reports an overage only when the forecast passes the year's cap", () => {
    const under = recurringPeriodSummary(
      [past(10_000), current(10_000), projected(10_000)],
      50_000,
      "quarterly",
    );
    expect(under.overYearCents).toBe(0);

    const over = recurringPeriodSummary(
      [past(90_000), current(90_000), projected(90_000), projected(90_000)],
      50_000,
      "quarterly",
    );
    // $3,600 forecast against a $2,000 year — $1,600 over.
    expect(over.projectedYearCents).toBe(360_000);
    expect(over.yearCapCents).toBe(200_000);
    expect(over.overYearCents).toBe(160_000);
  });

  it("an empty strip produces zeroes, not NaN", () => {
    const s = recurringPeriodSummary([], 50_000, "monthly");
    expect(s.spentToDateCents).toBe(0);
    expect(s.projectedYearCents).toBe(0);
    expect(s.overYearCents).toBe(0);
  });
});
