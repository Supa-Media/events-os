/**
 * The canonical column order: every grid leads with Title, Details (when the
 * module has one), Status, Timing (offset), Due — in that order — and the
 * rest of a module's columns follow. `canonicalColumnOrder` is the one
 * encoding of the rule; the DEFAULT_COLUMNS pin below makes a nonconforming
 * edit to the defaults fail loudly instead of shipping drift.
 */
import { describe, expect, test } from "vitest";
import {
  CANONICAL_LEADING_COLUMN_KEYS,
  canonicalColumnOrder,
  DEFAULT_COLUMNS,
  DEFAULT_CUSTOM_COLUMNS,
} from "@events-os/shared";

describe("canonicalColumnOrder", () => {
  const cols = (...keys: string[]) => keys.map((key) => ({ key }));
  const keysOf = (list: { key: string }[]) => list.map((c) => c.key);

  test("pulls the leading keys to the front, in their fixed order", () => {
    expect(
      keysOf(
        canonicalColumnOrder(
          cols("offset", "channel", "status", "title", "due_date", "notes"),
        ),
      ),
    ).toEqual(["title", "status", "offset", "due_date", "channel", "notes"]);
  });

  test("preserves the relative order of everything else", () => {
    expect(
      keysOf(
        canonicalColumnOrder(cols("title", "zebra", "status", "alpha", "mid")),
      ),
    ).toEqual(["title", "status", "zebra", "alpha", "mid"]);
  });

  test("is a no-op on an already-canonical list", () => {
    const input = cols("title", "details", "status", "offset", "due_date", "x");
    expect(canonicalColumnOrder(input)).toEqual(input);
  });
});

describe("DEFAULT_COLUMNS ship in canonical order", () => {
  test("every module's default set already satisfies the rule", () => {
    for (const [module, columns] of Object.entries(DEFAULT_COLUMNS)) {
      expect(
        columns.map((c) => c.key),
        `DEFAULT_COLUMNS.${module} is not in canonical order`,
      ).toEqual(canonicalColumnOrder(columns).map((c) => c.key));
    }
    expect(DEFAULT_CUSTOM_COLUMNS.map((c) => c.key)).toEqual(
      canonicalColumnOrder(DEFAULT_CUSTOM_COLUMNS).map((c) => c.key),
    );
  });

  test("the leading-keys constant matches what the grids actually use", () => {
    expect(CANONICAL_LEADING_COLUMN_KEYS).toEqual([
      "title",
      "details",
      "status",
      "offset",
      "due_date",
    ]);
  });
});
