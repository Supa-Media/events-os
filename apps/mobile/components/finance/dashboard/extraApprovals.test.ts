import { describe, expect, test } from "@jest/globals";
import { extraApprovalsCount } from "./extraApprovals";

describe("extraApprovalsCount", () => {
  test("0 when there is no chapter-wide budget_approvals attention item", () => {
    expect(extraApprovalsCount([], 0)).toBe(0);
  });

  test("0 when every chapter-wide pending approval is already visible in-period", () => {
    const attention = [{ kind: "budget_approvals", badgeCount: 2 }];
    expect(extraApprovalsCount(attention, 2)).toBe(0);
  });

  test("a submitted budget dated NEXT YEAR still produces the rail count", () => {
    // chapterAttentionQueue counts pending budgets chapter-WIDE with no
    // year/month filter, so a budget submitted for next year still bumps its
    // badgeCount even though it can never appear in this period's
    // oneTimeBudgets/recurringBudgets (dashboardChapter queries eq("year", year)).
    const attention = [{ kind: "budget_approvals", badgeCount: 1 }];
    expect(extraApprovalsCount(attention, 0)).toBe(1);
  });

  test("a submitted budget dated a future month (same year) also produces the count", () => {
    const attention = [{ kind: "budget_approvals", badgeCount: 3 }];
    // 1 of the 3 is visible in the current month view (pinned in-table).
    expect(extraApprovalsCount(attention, 1)).toBe(2);
  });

  test("never goes negative even on a stale/inconsistent read", () => {
    const attention = [{ kind: "budget_approvals", badgeCount: 1 }];
    expect(extraApprovalsCount(attention, 3)).toBe(0);
  });

  test("ignores other attention kinds", () => {
    const attention = [
      { kind: "reimbursements", badgeCount: 5 },
      { kind: "budget_approvals", badgeCount: 2 },
    ];
    expect(extraApprovalsCount(attention, 0)).toBe(2);
  });
});
