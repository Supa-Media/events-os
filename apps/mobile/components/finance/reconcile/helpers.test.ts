// No @types/jest / ambient globals configured for this package — import test
// globals explicitly from @jest/globals (mirrors `forPicker.test.ts`).
import { describe, expect, test } from "@jest/globals";
import { isSuggestible, type TxnRow } from "./helpers";

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
