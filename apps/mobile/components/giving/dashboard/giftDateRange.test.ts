import { describe, expect, test } from "@jest/globals";
import { resolveGiftDateRange } from "./giftDateRange";

// A fixed instant so every assertion is deterministic: 2026-07-19T12:00:00Z.
const NOW = Date.UTC(2026, 6, 19, 12, 0, 0);
const DAY_MS = 24 * 60 * 60 * 1000;

describe("resolveGiftDateRange", () => {
  test("'all' is a fully open range", () => {
    expect(resolveGiftDateRange("all", NOW)).toEqual({ from: undefined, to: undefined });
  });

  test("'30d' floors at 30 days ago, open end", () => {
    const { from, to } = resolveGiftDateRange("30d", NOW);
    expect(from).toBe(NOW - 30 * DAY_MS);
    expect(to).toBeUndefined();
  });

  test("'90d' floors at 90 days ago, open end", () => {
    const { from, to } = resolveGiftDateRange("90d", NOW);
    expect(from).toBe(NOW - 90 * DAY_MS);
    expect(to).toBeUndefined();
  });

  test("'ytd' floors at Jan 1 of the current (local) year, open end", () => {
    const { from, to } = resolveGiftDateRange("ytd", NOW);
    expect(from).toBe(new Date(new Date(NOW).getFullYear(), 0, 1).getTime());
    expect(to).toBeUndefined();
  });

  test("'custom' passes the caller's own bounds through untouched", () => {
    expect(resolveGiftDateRange("custom", NOW, { from: 100, to: 200 })).toEqual({
      from: 100,
      to: 200,
    });
  });

  test("'custom' with no bounds supplied is an open range", () => {
    expect(resolveGiftDateRange("custom", NOW)).toEqual({ from: undefined, to: undefined });
  });

  test("'custom' with only a lower bound leaves the upper bound open", () => {
    expect(resolveGiftDateRange("custom", NOW, { from: 100 })).toEqual({
      from: 100,
      to: undefined,
    });
  });
});
