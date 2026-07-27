import { describe, expect, test } from "vitest";
import { personalExpenseState, TRANSACTION_STATUSES, TRANSACTION_STATUS_LABELS } from "./finance";

/**
 * `personalExpenseState` — the derived (NOT persisted) personal-expense
 * lifecycle: not_personal → personal_unpaid → personal_reimbursed. See the
 * function's own doc comment in `finance.ts` for the full design rationale
 * (why this is derived from `isPersonal` + a linked repayment's status rather
 * than a new persisted field).
 */
describe("personalExpenseState", () => {
  test("not personal regardless of any stray repaymentStatus value", () => {
    expect(personalExpenseState(false, null)).toBe("not_personal");
    expect(personalExpenseState(undefined, null)).toBe("not_personal");
    expect(personalExpenseState(null, "paid")).toBe("not_personal");
  });

  test("personal + no/pending repayment reads unpaid", () => {
    expect(personalExpenseState(true, null)).toBe("personal_unpaid");
    expect(personalExpenseState(true, undefined)).toBe("personal_unpaid");
    expect(personalExpenseState(true, "pending")).toBe("personal_unpaid");
  });

  test("a failed repayment attempt still reads unpaid — the debt is still owed", () => {
    expect(personalExpenseState(true, "failed")).toBe("personal_unpaid");
  });

  test("only a paid repayment reads reimbursed", () => {
    expect(personalExpenseState(true, "paid")).toBe("personal_reimbursed");
  });

  // ── §2 invariant: this derived state can NEVER represent "personal" in a
  // way `isSpend` (finances.ts) would disagree with. `isSpend` excludes a
  // transaction from spend whenever `isPersonal === true` — full stop,
  // regardless of repayment status. Both `personal_unpaid` AND
  // `personal_reimbursed` correspond to `isPersonal === true`, so BOTH must
  // be excluded from spend; only `not_personal` corresponds to `isPersonal
  // !== true`, which is the one case `isSpend` does NOT exclude on this
  // axis. This table-driven check pins that correspondence for every
  // (isPersonal, repaymentStatus) combination the type allows, mirroring
  // `finances.ts#isSpend`'s own `tr.isPersonal !== true` clause exactly so a
  // future edit to either side that breaks the correspondence fails HERE.
  test("invariant: personalExpenseState !== 'not_personal' iff isSpend would exclude on isPersonal", () => {
    const isPersonalValues = [true, false, undefined, null] as const;
    const repaymentStatusValues = ["pending", "paid", "failed", null, undefined] as const;
    for (const isPersonal of isPersonalValues) {
      for (const repaymentStatus of repaymentStatusValues) {
        const state = personalExpenseState(isPersonal, repaymentStatus);
        const isSpendExcludesOnPersonal = isPersonal === true; // mirrors `finances.ts#isSpend`
        expect(state !== "not_personal").toBe(isSpendExcludesOnPersonal);
      }
    }
  });
});

// ── §7 (moneyViews dedup): TRANSACTION_STATUSES stays the single source for
// any hand-written status union — pinned here as a companion to the moneyViews
// fix so a status added/removed from the tuple is caught wherever a consumer
// still hand-lists literals instead of deriving from the tuple.
describe("TRANSACTION_STATUSES / TRANSACTION_STATUS_LABELS stay in lock-step", () => {
  test("every status has a label and vice versa", () => {
    for (const status of TRANSACTION_STATUSES) {
      expect(TRANSACTION_STATUS_LABELS[status]).toBeTruthy();
    }
    expect(Object.keys(TRANSACTION_STATUS_LABELS).sort()).toEqual(
      [...TRANSACTION_STATUSES].sort(),
    );
  });
});
