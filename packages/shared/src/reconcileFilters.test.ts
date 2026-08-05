import { describe, expect, test } from "vitest";
import {
  RECONCILE_FILTER_GROUPS,
  RECONCILE_FILTER_KEYS,
  RECONCILE_FILTER_LABELS,
  countsTowardFacet,
  matchesReconcileFilters,
  parseReconcileFilters,
  reconcileFilterGroupOf,
  serializeReconcileFilters,
  type ReconcileFilterKey,
} from "./reconcileFilters";

/** A row's predicate results, defaulting to false. */
function flags(
  on: Partial<Record<ReconcileFilterKey, boolean>> = {},
): Record<ReconcileFilterKey, boolean> {
  const base = Object.fromEntries(
    RECONCILE_FILTER_KEYS.map((k) => [k, false]),
  ) as Record<ReconcileFilterKey, boolean>;
  return { ...base, ...on };
}

describe("grouping integrity", () => {
  test("every selectable key sits in exactly one group", () => {
    const grouped = RECONCILE_FILTER_GROUPS.flatMap((g) => [...g.keys]);
    expect([...grouped].sort()).toEqual([...RECONCILE_FILTER_KEYS].sort());
    expect(new Set(grouped).size).toBe(grouped.length);
  });

  test("every key has a label", () => {
    for (const key of RECONCILE_FILTER_KEYS) {
      expect(RECONCILE_FILTER_LABELS[key]).toBeTruthy();
    }
  });

  test("group ids are unique", () => {
    const ids = RECONCILE_FILTER_GROUPS.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("matchesReconcileFilters — OR within a group, AND across groups", () => {
  test("no selection matches everything", () => {
    expect(matchesReconcileFilters(flags(), [])).toBe(true);
    expect(matchesReconcileFilters(flags({ spend: true }), [])).toBe(true);
  });

  test("two keys in the SAME group widen (OR)", () => {
    const selected: ReconcileFilterKey[] = ["missing_receipt", "needs_budget"];
    // "anything that still needs something" — either one qualifies.
    expect(matchesReconcileFilters(flags({ missing_receipt: true }), selected)).toBe(true);
    expect(matchesReconcileFilters(flags({ needs_budget: true }), selected)).toBe(true);
    expect(matchesReconcileFilters(flags({ to_review: true }), selected)).toBe(false);
  });

  test("two keys in DIFFERENT groups narrow (AND)", () => {
    const selected: ReconcileFilterKey[] = ["spend", "missing_receipt"];
    // "the spend that's missing receipts" — needs both.
    expect(
      matchesReconcileFilters(flags({ spend: true, missing_receipt: true }), selected),
    ).toBe(true);
    expect(matchesReconcileFilters(flags({ spend: true }), selected)).toBe(false);
    expect(matchesReconcileFilters(flags({ missing_receipt: true }), selected)).toBe(false);
  });

  test("a widened group still ANDs against another group", () => {
    // Spend rows that need EITHER a receipt or a budget.
    const selected: ReconcileFilterKey[] = ["spend", "missing_receipt", "needs_budget"];
    expect(
      matchesReconcileFilters(flags({ spend: true, needs_budget: true }), selected),
    ).toBe(true);
    expect(
      matchesReconcileFilters(flags({ transfers: true, needs_budget: true }), selected),
    ).toBe(false);
  });
});

describe("countsTowardFacet — the number you see is the number you'd get", () => {
  test("with nothing selected, a facet count is the plain global count", () => {
    expect(countsTowardFacet(flags({ missing_receipt: true }), [], "missing_receipt")).toBe(
      true,
    );
    expect(countsTowardFacet(flags({ spend: true }), [], "missing_receipt")).toBe(false);
  });

  test("another group's selection narrows the count", () => {
    // "Spend" is picked; a receiptless TRANSFER must not be counted under
    // "Missing receipt", because selecting it could never surface that row.
    const selected: ReconcileFilterKey[] = ["spend"];
    expect(
      countsTowardFacet(flags({ spend: true, missing_receipt: true }), selected, "missing_receipt"),
    ).toBe(true);
    expect(
      countsTowardFacet(
        flags({ transfers: true, missing_receipt: true }),
        selected,
        "missing_receipt",
      ),
    ).toBe(false);
  });

  test("a key's OWN group's selections are ignored, so siblings stay comparable", () => {
    // With "Missing receipt" already on, "Needs budget" still reports every
    // budget-less row — not just the ones that also lack a receipt. Otherwise
    // the two numbers in one dropdown couldn't be read against each other.
    const selected: ReconcileFilterKey[] = ["missing_receipt"];
    expect(countsTowardFacet(flags({ needs_budget: true }), selected, "needs_budget")).toBe(
      true,
    );
    expect(
      countsTowardFacet(flags({ missing_receipt: true }), selected, "missing_receipt"),
    ).toBe(true);
  });

  test("a row that doesn't have the flag never counts", () => {
    expect(countsTowardFacet(flags({ spend: true }), [], "payouts")).toBe(false);
  });
});

describe("URL round-trip", () => {
  test("parses a comma list, dropping unknowns and duplicates", () => {
    expect(parseReconcileFilters("spend,missing_receipt")).toEqual([
      "spend",
      "missing_receipt",
    ]);
    expect(parseReconcileFilters("spend,nonsense,spend")).toEqual(["spend"]);
    expect(parseReconcileFilters("")).toEqual([]);
    expect(parseReconcileFilters(undefined)).toEqual([]);
  });

  test("the retired `all` is an empty selection, not a key", () => {
    expect(parseReconcileFilters("all")).toEqual([]);
    expect(parseReconcileFilters("all,spend")).toEqual(["spend"]);
  });

  test("pre-rename spellings still land where they meant", () => {
    expect(parseReconcileFilters("uncategorized")).toEqual(["to_review"]);
    expect(parseReconcileFilters("ready")).toEqual(["reconciled"]);
  });

  test("serialize is the inverse, and empty means no param at all", () => {
    const selected: ReconcileFilterKey[] = ["spend", "to_review"];
    const raw = serializeReconcileFilters(selected);
    expect(raw).toBe("spend,to_review");
    expect(parseReconcileFilters(raw)).toEqual(selected);
    expect(serializeReconcileFilters([])).toBeUndefined();
  });
});

describe("reconcileFilterGroupOf", () => {
  test("places each key in its declared group", () => {
    expect(reconcileFilterGroupOf("spend")).toBe("kind");
    expect(reconcileFilterGroupOf("payouts")).toBe("kind");
    expect(reconcileFilterGroupOf("to_review")).toBe("state");
    expect(reconcileFilterGroupOf("reconciled")).toBe("state");
  });
});
