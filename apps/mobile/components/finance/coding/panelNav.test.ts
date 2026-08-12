// No @types/jest / ambient globals configured for this package — import test
// globals explicitly (mirrors `myTransactions/chargeTodo.test.ts`).
import { describe, expect, test } from "@jest/globals";
import { indexOfSelected, panelPosition, stepSelection } from "./panelNav";

const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];

describe("indexOfSelected", () => {
  test("finds the row", () => {
    expect(indexOfSelected(rows, "b")).toBe(1);
  });
  test("is -1 for null", () => {
    expect(indexOfSelected(rows, null)).toBe(-1);
  });
  test("is -1 for a row not in the list", () => {
    expect(indexOfSelected(rows, "z")).toBe(-1);
  });
});

describe("stepSelection", () => {
  test("steps forward", () => {
    expect(stepSelection(rows, "a", 1)).toBe("b");
    expect(stepSelection(rows, "b", 1)).toBe("c");
  });
  test("steps backward", () => {
    expect(stepSelection(rows, "c", -1)).toBe("b");
    expect(stepSelection(rows, "b", -1)).toBe("a");
  });
  test("does not wrap past the last row", () => {
    expect(stepSelection(rows, "c", 1)).toBeNull();
  });
  test("does not wrap before the first row", () => {
    expect(stepSelection(rows, "a", -1)).toBeNull();
  });
  test("is null with no selection", () => {
    expect(stepSelection(rows, null, 1)).toBeNull();
  });
  test("is null for a selection no longer in the list", () => {
    expect(stepSelection(rows, "z", 1)).toBeNull();
  });
  test("is null on an empty list", () => {
    expect(stepSelection([], "a", 1)).toBeNull();
  });
});

describe("panelPosition", () => {
  test("is 1-based", () => {
    expect(panelPosition(rows, "a")).toEqual({ index: 1, total: 3 });
    expect(panelPosition(rows, "c")).toEqual({ index: 3, total: 3 });
  });
  test("is null with no selection", () => {
    expect(panelPosition(rows, null)).toBeNull();
  });
  test("is null for a selection no longer in the list", () => {
    expect(panelPosition(rows, "z")).toBeNull();
  });
});
