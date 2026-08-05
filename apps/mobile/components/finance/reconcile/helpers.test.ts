// No @types/jest / ambient globals configured for this package — import test
// globals explicitly from @jest/globals (mirrors `forPicker.test.ts`).
import { describe, expect, test } from "@jest/globals";
import {
  FILTERS,
  FILTER_GROUPS,
  isSuggestible,
  parseFilterParam,
  type TxnRow,
} from "./helpers";

// PR fix-suggest-broaden: the owner-reported bug was that a "Categorized" row
// still showing "Needs budget" got no "Suggest" button, just a bare "—" — the
// button's old condition was solely `row.status === "unreviewed"`.
// `isSuggestible` is the client mirror of the server's `finances.isSuggestible`
// (single source of truth — also gates the on-demand `suggestCoding` action
// and the on-ingest/hourly sweep). Only the fields this predicate reads
// (`status`, `needsBudget`) are populated below — the rest of `TxnRow` is
// irrelevant to it.
function row(overrides: Partial<Pick<TxnRow, "status" | "needsBudget">>): TxnRow {
  return {
    status: "unreviewed",
    needsBudget: false,
    ...overrides,
  } as TxnRow;
}

describe("isSuggestible", () => {
  test("an unreviewed row is suggestible regardless of needsBudget", () => {
    expect(isSuggestible(row({ status: "unreviewed", needsBudget: true }))).toBe(true);
    expect(isSuggestible(row({ status: "unreviewed", needsBudget: false }))).toBe(true);
  });

  test("a categorized row is suggestible only while it still needs a budget", () => {
    expect(isSuggestible(row({ status: "categorized", needsBudget: true }))).toBe(true);
    expect(isSuggestible(row({ status: "categorized", needsBudget: false }))).toBe(false);
  });

  test("a reconciled row is never suggestible, even if it somehow still needs a budget", () => {
    expect(isSuggestible(row({ status: "reconciled", needsBudget: true }))).toBe(false);
    expect(isSuggestible(row({ status: "reconciled", needsBudget: false }))).toBe(false);
  });

  test("an excluded row is never suggestible (needsBudget is already false for it server-side)", () => {
    expect(isSuggestible(row({ status: "excluded", needsBudget: false }))).toBe(false);
  });
});

describe("FILTER_GROUPS", () => {
  // The dropdown is now the ONLY way to reach a filter — the chip row it
  // replaced is gone. So a filter missing from a group isn't a cosmetic gap:
  // it's unreachable, and its count disappears from the UI entirely. That's
  // the exact "a number with nowhere to go" failure this whole run of work
  // set out to remove, so it gets an assert rather than a convention.
  test("covers every filter exactly once", () => {
    const grouped = FILTER_GROUPS.flatMap((g) => g.keys);
    expect([...grouped].sort()).toEqual(FILTERS.map((f) => f.key).sort());
    expect(new Set(grouped).size).toBe(grouped.length);
  });

  test("group headings are unique, so they can key a menu row", () => {
    const titles = FILTER_GROUPS.map((g) => g.title).filter(
      (t): t is string => t != null,
    );
    expect(new Set(titles).size).toBe(titles.length);
  });
});

describe("parseFilterParam", () => {
  test("maps the pre-rename spellings so old deep links still land", () => {
    expect(parseFilterParam("uncategorized")).toBe("to_review");
    expect(parseFilterParam("ready")).toBe("reconciled");
  });

  test("passes through a current key, and rejects anything unknown", () => {
    expect(parseFilterParam("to_review")).toBe("to_review");
    expect(parseFilterParam("nonsense")).toBeNull();
    expect(parseFilterParam(undefined)).toBeNull();
  });
});
