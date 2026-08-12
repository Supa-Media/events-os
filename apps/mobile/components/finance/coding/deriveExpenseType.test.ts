import { describe, expect, test } from "@jest/globals";
import {
  deriveExpenseTypeFromCategory,
  initialExpenseTypeChipState,
  overrideExpenseType,
  type ExpenseTypeChipState,
} from "./deriveExpenseType";

describe("initialExpenseTypeChipState", () => {
  test("a fresh coding with a hinted category starts following it, not overridden", () => {
    expect(
      initialExpenseTypeChipState({ categoryHint: "travel" }),
    ).toEqual<ExpenseTypeChipState>({ expenseType: "travel", overridden: false });
  });

  test("a fresh coding with no category (or a hint-less one) starts unselected", () => {
    expect(initialExpenseTypeChipState({})).toEqual<ExpenseTypeChipState>({
      expenseType: null,
      overridden: false,
    });
    expect(
      initialExpenseTypeChipState({ categoryHint: null }),
    ).toEqual<ExpenseTypeChipState>({ expenseType: null, overridden: false });
  });

  test("revising an EXISTING coding is always sticky, regardless of the category's hint", () => {
    expect(
      initialExpenseTypeChipState({
        existingExpenseType: "meal",
        categoryHint: "travel",
      }),
    ).toEqual<ExpenseTypeChipState>({ expenseType: "meal", overridden: true });
  });
});

describe("deriveExpenseTypeFromCategory", () => {
  test("follows a fresh category's hint when not overridden", () => {
    const state: ExpenseTypeChipState = { expenseType: null, overridden: false };
    expect(deriveExpenseTypeFromCategory(state, "meal")).toEqual({
      expenseType: "meal",
      overridden: false,
    });
  });

  test("re-derives again on a SECOND category change, still not overridden", () => {
    const afterFirst = deriveExpenseTypeFromCategory(
      { expenseType: null, overridden: false },
      "meal",
    );
    expect(deriveExpenseTypeFromCategory(afterFirst, "travel")).toEqual({
      expenseType: "travel",
      overridden: false,
    });
  });

  test("a category with NO hint clears the chips back to unselected", () => {
    const afterHint = deriveExpenseTypeFromCategory(
      { expenseType: null, overridden: false },
      "meal",
    );
    expect(deriveExpenseTypeFromCategory(afterHint, null)).toEqual({
      expenseType: null,
      overridden: false,
    });
  });

  test("an OVERRIDDEN state is untouched by any later category change", () => {
    const overridden: ExpenseTypeChipState = {
      expenseType: "lodging",
      overridden: true,
    };
    expect(deriveExpenseTypeFromCategory(overridden, "travel")).toBe(overridden);
    expect(deriveExpenseTypeFromCategory(overridden, null)).toBe(overridden);
  });

  test("a no-op change (same hint again) returns the identical state object", () => {
    const state: ExpenseTypeChipState = { expenseType: "meal", overridden: false };
    expect(deriveExpenseTypeFromCategory(state, "meal")).toBe(state);
  });
});

describe("overrideExpenseType", () => {
  test("a manual tap always sets overridden, even matching the current hint", () => {
    const state: ExpenseTypeChipState = { expenseType: "travel", overridden: false };
    expect(overrideExpenseType(state, "travel")).toEqual({
      expenseType: "travel",
      overridden: true,
    });
  });

  test("a manual tap replaces whatever was there, overridden or not", () => {
    const overridden: ExpenseTypeChipState = {
      expenseType: "meal",
      overridden: true,
    };
    expect(overrideExpenseType(overridden, "general")).toEqual({
      expenseType: "general",
      overridden: true,
    });
  });

  test("once overridden, a later category change never wins back the chips", () => {
    let state: ExpenseTypeChipState = { expenseType: null, overridden: false };
    state = deriveExpenseTypeFromCategory(state, "travel"); // follows the category
    state = overrideExpenseType(state, "lodging"); // person taps "Overnight stay"
    state = deriveExpenseTypeFromCategory(state, "meal"); // category changes again
    expect(state).toEqual({ expenseType: "lodging", overridden: true });
  });
});
