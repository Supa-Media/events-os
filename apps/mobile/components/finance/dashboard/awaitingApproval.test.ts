// No @types/jest / ambient globals configured for this package — import test
// globals explicitly (mirrors `components/finance/reconcile/forPicker.test.ts`).
import { describe, expect, test } from "@jest/globals";
import { awaitingApprovalZeroCapDisplay } from "./awaitingApproval";

/**
 * WP-wave4 (item 6, owner addendum 2026-07-17) — "awaiting-approval card
 * treatment": a budget awaiting a decision with a $0 approved cap must show
 * spend vs REQUESTED (never the nonsense "100% / danger-red" the raw $0 cap
 * produces), while a genuinely unfunded APPROVED budget with spend stays
 * loud/red exactly as before.
 */
describe("awaitingApprovalZeroCapDisplay", () => {
  test("a SUBMITTED budget with $0 approved and a real request shows spend vs REQUESTED, never danger-red", () => {
    const result = awaitingApprovalZeroCapDisplay({
      approvalStatus: "submitted",
      approvedCents: 0,
      requestedCents: 150000, // $1,500 requested
      spentCents: 92500, // $925 spent
      budgetCents: 0, // the raw $0 effective cap
      pct: 100, // the raw (nonsense) pct the $0 cap produces
      status: "warn",
    });
    expect(result.isAwaitingApproval).toBe(true);
    expect(result.budgetCents).toBe(150000);
    expect(result.pct).toBe(62); // round(92500 / 150000 * 100)
    expect(result.status).toBe("ok"); // < 80% of requested
  });

  test("a DRAFT INCREASE with $0 approved and a real request gets the same treatment", () => {
    const result = awaitingApprovalZeroCapDisplay({
      approvalStatus: "draft",
      approvedCents: 0,
      requestedCents: 100000,
      spentCents: 85000,
      budgetCents: 0,
      pct: 100,
      status: "warn",
    });
    expect(result.isAwaitingApproval).toBe(true);
    expect(result.pct).toBe(85);
    expect(result.status).toBe("warn"); // >= 80% of requested still reads warn (amber), never danger
  });

  test("a genuinely UNFUNDED APPROVED budget with spend stays the loud red 100% state — untouched", () => {
    const result = awaitingApprovalZeroCapDisplay({
      approvalStatus: "approved",
      approvedCents: 0,
      requestedCents: 0,
      spentCents: 5000,
      budgetCents: 0,
      pct: 100,
      status: "warn",
    });
    expect(result.isAwaitingApproval).toBe(false);
    expect(result.budgetCents).toBe(0);
    expect(result.pct).toBe(100);
    expect(result.status).toBe("warn");
  });

  test("a normal approved budget with a real cap is untouched", () => {
    const result = awaitingApprovalZeroCapDisplay({
      approvalStatus: "approved",
      approvedCents: 100000,
      requestedCents: 100000,
      spentCents: 40000,
      budgetCents: 100000,
      pct: 40,
      status: "ok",
    });
    expect(result.isAwaitingApproval).toBe(false);
    expect(result).toMatchObject({ budgetCents: 100000, pct: 40, status: "ok" });
  });

  test("a submitted DRAFT-INCREASE budget whose approvedCents is still null (a brand-new draft, never approved before) is untouched — the $0 case is specifically approvedCents===0, not null", () => {
    const result = awaitingApprovalZeroCapDisplay({
      approvalStatus: "draft",
      approvedCents: null,
      requestedCents: 50000,
      spentCents: 0,
      budgetCents: 50000,
      pct: 0,
      status: "ok",
    });
    expect(result.isAwaitingApproval).toBe(false);
  });
});
