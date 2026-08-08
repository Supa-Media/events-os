// No @types/jest / ambient globals configured for this package — import test
// globals explicitly (mirrors `reconcile/helpers.test.ts`).
import { describe, expect, test } from "@jest/globals";
import {
  chargeTodo,
  codingRequired,
  isSpendCharge,
  parseChargeFilter,
  sortByTodo,
  type ChargeFacts,
} from "./chargeTodo";

// The owner-decided policy date (2026-09-01 UTC) — the fixture uses a charge
// on either side of it, because "is this row even chased for a coding" is the
// first branch every case below runs through.
const SINCE = Date.UTC(2026, 8, 1);
const AFTER = Date.UTC(2026, 8, 15);
const BEFORE = Date.UTC(2026, 7, 15);

function charge(overrides: Partial<ChargeFacts> = {}): ChargeFacts {
  return {
    postedAt: AFTER,
    flow: "outflow",
    status: "unreviewed",
    isPersonal: false,
    hasReceipt: false,
    ...overrides,
  };
}

describe("isSpendCharge / codingRequired", () => {
  test("mirrors the server: outflow, not excluded, not personal", () => {
    expect(isSpendCharge(charge())).toBe(true);
    expect(isSpendCharge(charge({ flow: "inflow" }))).toBe(false);
    expect(isSpendCharge(charge({ flow: "transfer" }))).toBe(false);
    expect(isSpendCharge(charge({ status: "excluded" }))).toBe(false);
    expect(isSpendCharge(charge({ isPersonal: true }))).toBe(false);
  });

  test("pre-policy spend is never chased for a coding", () => {
    expect(codingRequired(charge({ postedAt: BEFORE }), SINCE)).toBe(false);
    expect(codingRequired(charge({ postedAt: SINCE }), SINCE)).toBe(true);
  });
});

describe("chargeTodo", () => {
  test("a send-back outranks everything and carries the danger tone", () => {
    const todo = chargeTodo(charge({ codingStatus: "changes_requested" }), SINCE);
    expect(todo.kind).toBe("sent_back");
    expect(todo.rank).toBe(0);
    expect(todo.tone).toBe("danger");
    expect(todo.actionable).toBe(true);
    expect(todo.outstanding).toEqual(["coding", "receipt"]);
  });

  test("uncoded and undocumented reads as the digest phrases it", () => {
    expect(chargeTodo(charge(), SINCE).label).toBe("Needs coding and a receipt");
    expect(chargeTodo(charge({ hasReceipt: true }), SINCE).label).toBe(
      "Needs coding",
    );
    expect(
      chargeTodo(charge({ codingStatus: "approved" }), SINCE).label,
    ).toBe("Needs a receipt");
  });

  test("an APPROVED exception documents the row as well as a receipt does", () => {
    const todo = chargeTodo(
      charge({ codingStatus: "approved", hasApprovedException: true }),
      SINCE,
    );
    expect(todo.kind).toBe("settled");
    expect(todo.actionable).toBe(false);
    expect(todo.outstanding).toEqual([]);
  });

  test("submitted waits on the treasurer, not on the cardholder", () => {
    const todo = chargeTodo(
      charge({ codingStatus: "submitted", hasReceipt: true }),
      SINCE,
    );
    expect(todo.kind).toBe("in_review");
    expect(todo.actionable).toBe(false);
  });

  test("a reconciled row has nobody left to chase", () => {
    const todo = chargeTodo(charge({ status: "reconciled" }), SINCE);
    expect(todo.actionable).toBe(false);
    expect(todo.outstanding).toEqual([]);
  });

  test("pre-policy spend is only ever chased for its receipt", () => {
    expect(chargeTodo(charge({ postedAt: BEFORE }), SINCE).label).toBe(
      "Needs a receipt",
    );
    expect(
      chargeTodo(charge({ postedAt: BEFORE, hasReceipt: true }), SINCE).kind,
    ).toBe("settled");
  });

  test("non-spend rows ask for nothing", () => {
    expect(chargeTodo(charge({ flow: "inflow" }), SINCE).label).toBe(
      "Nothing needed",
    );
    expect(chargeTodo(charge({ isPersonal: true }), SINCE).actionable).toBe(
      false,
    );
  });

  test("an absent coding IS the uncoded state — there is no 'uncoded' literal", () => {
    // `null` on the wire and an omitted field must rank identically.
    expect(
      chargeTodo(charge({ hasReceipt: true, codingStatus: null }), SINCE).label,
    ).toBe("Needs coding");
    expect(chargeTodo(charge({ hasReceipt: true }), SINCE).label).toBe(
      "Needs coding",
    );
  });
});

describe("sortByTodo", () => {
  test("actionable first, then newest first, without mutating the input", () => {
    const rows = [
      { id: "old-done", rank: 4, postedAt: 1 },
      { id: "new-done", rank: 4, postedAt: 9 },
      { id: "sent-back", rank: 0, postedAt: 2 },
      { id: "needs-receipt", rank: 2, postedAt: 5 },
    ];
    const frozen = [...rows];
    expect(sortByTodo(rows, (r) => r).map((r) => r.id)).toEqual([
      "sent-back",
      "needs-receipt",
      "new-done",
      "old-done",
    ]);
    expect(rows).toEqual(frozen);
  });
});

describe("parseChargeFilter", () => {
  test("reads the reminder email's deep link", () => {
    expect(parseChargeFilter("uncoded")).toBe("uncoded");
    expect(parseChargeFilter(["uncoded"])).toBe("uncoded");
  });

  test("anything unrecognised lands on the full list, never an empty one", () => {
    expect(parseChargeFilter(undefined)).toBe("all");
    expect(parseChargeFilter("")).toBe("all");
    expect(parseChargeFilter("uncodedd")).toBe("all");
  });
});
