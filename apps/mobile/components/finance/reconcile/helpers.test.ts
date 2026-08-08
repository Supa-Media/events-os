// No @types/jest / ambient globals configured for this package — import test
// globals explicitly from @jest/globals (mirrors `forPicker.test.ts`).
import { describe, expect, test } from "@jest/globals";
import { filterReconcileRows, isSuggestible, type TxnRow } from "./helpers";

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

// A renamed row must be findable by BOTH names. "Costco" has to find it
// because that's what the grid now calls it; the bank's own
// `IC* COSTCO BY IN CAR` has to keep finding it because someone reconciling
// against a statement is reading the provider's string, and a rename must
// never make a row unfindable by what the statement calls it.
describe("filterReconcileRows — a rename doesn't hide a row", () => {
  const searchRow = (
    overrides: Partial<
      Pick<TxnRow, "merchantNameOverride" | "merchantName" | "description">
    >,
  ): TxnRow =>
    ({
      merchantNameOverride: null,
      merchantName: null,
      description: null,
      cardholder: null,
      cardLast4: null,
      book: { name: "New York" },
      amountCents: 12994,
      ...overrides,
    }) as unknown as TxnRow;

  const renamed = searchRow({
    merchantNameOverride: "Costco",
    merchantName: "IC* COSTCO BY IN CAR",
  });

  test("finds it by the new name", () => {
    expect(filterReconcileRows([renamed], "costco")).toEqual([renamed]);
  });

  test("still finds it by the bank's own string", () => {
    expect(filterReconcileRows([renamed], "IC* COSTCO")).toEqual([renamed]);
  });

  test("doesn't match an unrelated row", () => {
    const other = searchRow({ merchantName: "AMAZON MKTPL*56OXD2TB2" });
    expect(filterReconcileRows([renamed, other], "amazon")).toEqual([other]);
  });
});
