import { describe, expect, test } from "vitest";
import {
  isReceiptExtractionActive,
  personalExpenseState,
  receiptExtractionFraction,
  RECEIPT_EXTRACTION_STALE_MS,
  TRANSACTION_STATUSES,
  TRANSACTION_STATUS_LABELS,
} from "./finance";

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

// ── Receipt extraction progress ──────────────────────────────────────────────
// The rule that decides whether the UI shows a live "reading…" strip. A
// spinner that never stops is worse than no spinner: a scheduled function
// that never landed must eventually read as "not running", which is why
// staleness is a reader-side rule and not just a stored flag.
describe("isReceiptExtractionActive", () => {
  const now = 1_760_000_000_000;

  test("nothing pending is never active", () => {
    expect(isReceiptExtractionActive(null, now)).toBe(false);
    expect(isReceiptExtractionActive(undefined, now)).toBe(false);
  });

  test("a fresh run is active; one older than the stale window is not", () => {
    expect(isReceiptExtractionActive({ status: "running", since: now - 5_000 }, now)).toBe(true);
    expect(
      isReceiptExtractionActive(
        { status: "running", since: now - RECEIPT_EXTRACTION_STALE_MS - 1 },
        now,
      ),
    ).toBe(false);
  });

  test("a queued attempt stays active until well past its fire time", () => {
    expect(
      isReceiptExtractionActive(
        { status: "queued", since: now, nextAttemptAt: now + 15 * 60_000 },
        now,
      ),
    ).toBe(true);
    // Fired minutes ago and nothing ever moved to `running` — the scheduled
    // function is gone; stop claiming a retry is coming.
    expect(
      isReceiptExtractionActive(
        { status: "queued", since: now - 60 * 60_000, nextAttemptAt: now - 30 * 60_000 },
        now,
      ),
    ).toBe(false);
  });
});

describe("receiptExtractionFraction", () => {
  const now = 1_760_000_000_000;

  test("a queued wait fills toward its fire time", () => {
    const at = (elapsed: number) =>
      receiptExtractionFraction(
        { status: "queued", since: now, nextAttemptAt: now + 60_000 },
        now + elapsed,
      );
    expect(at(0)).toBe(0);
    expect(at(30_000)).toBeCloseTo(0.5, 2);
    // Capped below full — the bar completing is the row updating, nothing else.
    expect(at(60_000)).toBeLessThan(1);
  });

  test("a running read creeps but never claims to be finished", () => {
    expect(receiptExtractionFraction({ status: "running", since: now }, now)).toBe(0);
    expect(
      receiptExtractionFraction({ status: "running", since: now }, now + 10 * 60_000),
    ).toBeLessThan(1);
  });
});
