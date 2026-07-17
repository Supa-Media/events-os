import { describe, expect, test } from "vitest";
import {
  MODULE_DEFAULT_CATEGORY_NAMES,
  VENDOR_DEFAULT_CATEGORY_NAME,
} from "@events-os/shared";
import { DEFAULT_EXPENSE_CATEGORIES } from "../lib/seed/finance";

/**
 * Pins the coupling between `MODULE_DEFAULT_CATEGORY_NAMES` /
 * `VENDOR_DEFAULT_CATEGORY_NAME` (packages/shared/src/finance.ts) and the
 * chapter's actually-seeded category names (`DEFAULT_EXPENSE_CATEGORIES`,
 * lib/seed/finance.ts). If either list drifts, a Money-page read-side
 * consumer (a follow-up PR) would fall back to categorizing a row against a
 * name no chapter's seeded category tree actually has.
 */
describe("module default category names match the seeded defaults", () => {
  test("every MODULE_DEFAULT_CATEGORY_NAMES value is a real seeded category", () => {
    for (const [module, name] of Object.entries(MODULE_DEFAULT_CATEGORY_NAMES)) {
      expect(
        DEFAULT_EXPENSE_CATEGORIES as readonly string[],
        `module "${module}" maps to "${name}", which is not in DEFAULT_EXPENSE_CATEGORIES`,
      ).toContain(name);
    }
  });

  test("VENDOR_DEFAULT_CATEGORY_NAME is a real seeded category", () => {
    expect(DEFAULT_EXPENSE_CATEGORIES as readonly string[]).toContain(
      VENDOR_DEFAULT_CATEGORY_NAME,
    );
  });
});
