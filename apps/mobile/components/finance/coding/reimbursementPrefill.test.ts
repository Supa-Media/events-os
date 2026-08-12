/**
 * The prefill plan is the whole safety story of the 2026-08-12 owner
 * directive ("auto populate with request purpose notes that we already
 * have"): what carries, and — just as important — what deliberately does
 * NOT. These tests pin the boundary: full substantiation only for a lone,
 * fully-declared line; purpose-only otherwise; nothing when the claimant
 * wrote nothing.
 */
import { describe, expect, it } from "@jest/globals";
import {
  reimbursementPrefillPlan,
  type PrefillContext,
} from "./reimbursementPrefill";

function line(
  overrides: Partial<PrefillContext["lines"][number]> = {},
): PrefillContext["lines"][number] {
  return {
    expenseType: null,
    businessPurpose: null,
    travelFrom: null,
    travelTo: null,
    headcount: null,
    attendees: null,
    groupDescription: null,
    ...overrides,
  };
}

describe("reimbursementPrefillPlan", () => {
  it("returns null for a missing context (most charges aren't reimbursement payouts)", () => {
    expect(reimbursementPrefillPlan(null)).toBeNull();
    expect(reimbursementPrefillPlan(undefined)).toBeNull();
  });

  it("carries the full substantiation for exactly one fully-declared line", () => {
    const plan = reimbursementPrefillPlan({
      purpose: "Filming trip",
      lines: [
        line({
          expenseType: "travel",
          businessPurpose: "  Travel to NY to film the Eden event  ",
          travelFrom: "Boston",
          travelTo: "New York",
        }),
      ],
    });
    expect(plan).toEqual({
      kind: "line",
      line: {
        expenseType: "travel",
        businessPurpose: "Travel to NY to film the Eden event",
        travelFrom: "Boston",
        travelTo: "New York",
        headcount: null,
        attendees: undefined,
        groupDescription: null,
      },
    });
  });

  it("carries meal attendees and headcount on a lone meal line", () => {
    const plan = reimbursementPrefillPlan({
      purpose: null,
      lines: [
        line({
          expenseType: "meal",
          businessPurpose: "Meal for volunteers producing the album",
          headcount: 3,
          attendees: [
            { name: "A", affiliation: "team" },
            { name: "B", affiliation: "volunteer" },
          ],
        }),
      ],
    });
    expect(plan?.kind).toBe("line");
    if (plan?.kind !== "line") throw new Error("expected line plan");
    expect(plan.line.headcount).toBe(3);
    expect(plan.line.attendees).toEqual([
      { name: "A", affiliation: "team" },
      { name: "B", affiliation: "volunteer" },
    ]);
  });

  it("falls back to the request purpose when there are several lines — the machine must not guess between them", () => {
    const plan = reimbursementPrefillPlan({
      purpose: "Supplies and travel for the retreat",
      lines: [
        line({ expenseType: "general", businessPurpose: "Supplies" }),
        line({ expenseType: "travel", businessPurpose: "Bus tickets" }),
      ],
    });
    expect(plan).toEqual({
      kind: "purpose",
      purpose: "Supplies and travel for the retreat",
    });
  });

  it("falls back to the request purpose when the lone line never declared a type", () => {
    const plan = reimbursementPrefillPlan({
      purpose: "Printer ink for the office",
      lines: [line({ businessPurpose: "Ink cartridges" })],
    });
    expect(plan).toEqual({
      kind: "purpose",
      purpose: "Printer ink for the office",
    });
  });

  it("uses the lone line's own words when the request has no purpose", () => {
    const plan = reimbursementPrefillPlan({
      purpose: "   ",
      lines: [line({ businessPurpose: "Ink cartridges" })],
    });
    expect(plan).toEqual({ kind: "purpose", purpose: "Ink cartridges" });
  });

  it("returns null when the claimant wrote nothing usable — the form starts blank as before", () => {
    expect(
      reimbursementPrefillPlan({ purpose: null, lines: [line(), line()] }),
    ).toBeNull();
    expect(
      reimbursementPrefillPlan({ purpose: "", lines: [line({ expenseType: "travel" })] }),
    ).toBeNull();
    expect(reimbursementPrefillPlan({ purpose: undefined, lines: [] })).toBeNull();
  });

  it("treats a lone line with a type but whitespace-only purpose as not fully declared", () => {
    const plan = reimbursementPrefillPlan({
      purpose: "Team retreat costs",
      lines: [line({ expenseType: "lodging", businessPurpose: "  " })],
    });
    expect(plan).toEqual({ kind: "purpose", purpose: "Team retreat costs" });
  });
});
