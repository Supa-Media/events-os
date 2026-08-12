import { describe, expect, test } from "@jest/globals";
import { planCategoryEdit, type CategoryEditPlan } from "./categoryEditPlan";
import type { Id } from "@events-os/convex/_generated/dataModel";

const CAT_A = "cat_a" as Id<"budgetCategories">;
const CAT_B = "cat_b" as Id<"budgetCategories">;

describe("planCategoryEdit", () => {
  test("a non-card charge never attempts a category edit, regardless of ownership or a real change", () => {
    const want: CategoryEditPlan = { kind: "none" };
    expect(
      planCategoryEdit({
        isCardCharge: false,
        ownCharge: true,
        draftCategoryId: CAT_A,
        currentCategoryId: null,
      }),
    ).toEqual(want);
    expect(
      planCategoryEdit({
        isCardCharge: false,
        ownCharge: false,
        draftCategoryId: CAT_A,
        currentCategoryId: CAT_B,
      }),
    ).toEqual(want);
  });

  test("an UNCHANGED category is a no-op, own or not", () => {
    const want: CategoryEditPlan = { kind: "none" };
    expect(
      planCategoryEdit({
        isCardCharge: true,
        ownCharge: true,
        draftCategoryId: CAT_A,
        currentCategoryId: CAT_A,
      }),
    ).toEqual(want);
    expect(
      planCategoryEdit({
        isCardCharge: true,
        ownCharge: false,
        draftCategoryId: null,
        currentCategoryId: null,
      }),
    ).toEqual(want);
  });

  test("own charge, changed category -> submitOwnCharge's plan", () => {
    expect(
      planCategoryEdit({
        isCardCharge: true,
        ownCharge: true,
        draftCategoryId: CAT_B,
        currentCategoryId: CAT_A,
      }),
    ).toEqual({ kind: "own", categoryId: CAT_B });
  });

  test("THE REVIEW FINDING'S SHAPE: not-own, changed category -> the bookkeeper plan, never 'own'", () => {
    expect(
      planCategoryEdit({
        isCardCharge: true,
        ownCharge: false,
        draftCategoryId: CAT_B,
        currentCategoryId: CAT_A,
      }),
    ).toEqual({ kind: "bookkeeper", categoryId: CAT_B });
  });

  test("clearing a category to null still counts as a change", () => {
    expect(
      planCategoryEdit({
        isCardCharge: true,
        ownCharge: false,
        draftCategoryId: null,
        currentCategoryId: CAT_A,
      }),
    ).toEqual({ kind: "bookkeeper", categoryId: null });
  });
});
