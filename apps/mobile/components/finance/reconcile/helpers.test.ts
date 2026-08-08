// No @types/jest / ambient globals configured for this package — import test
// globals explicitly from @jest/globals (mirrors `forPicker.test.ts`).
import { describe, expect, test } from "@jest/globals";
import { filterReconcileRows, type TxnRow } from "./helpers";

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
