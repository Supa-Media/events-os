import { describe, expect, test } from "vitest";
import { resolveBudgetTitles, type BudgetTitleInput } from "./budgetTitles";

/**
 * Budget titles come from the EVENT TEMPLATE, with exactly as much date as it
 * takes to tell two apart (founder, 2026-08-14).
 *
 * The interesting property is restraint: a chapter with one Genesis budget
 * should read "Genesis", not "Genesis Oct 2026". Precision that isn't earned
 * is noise, and a list where every row carries a date is a list nobody scans.
 */

/** Eastern-noon on a day — the rule buckets by Eastern, so noon keeps the day
 *  unambiguous either side of DST. */
function on(year: number, month: number, day = 15): number {
  return Date.parse(
    `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T16:00:00Z`,
  );
}

function row(
  key: string,
  templateName: string | null,
  date: number | null,
  fallbackName = `fallback-${key}`,
): BudgetTitleInput {
  return { key, templateName, fallbackName, date };
}

describe("resolveBudgetTitles", () => {
  test("one budget on a template is just the template name — no date", () => {
    const titles = resolveBudgetTitles([row("a", "Genesis", on(2026, 10))]);
    expect(titles.get("a")).toBe("Genesis");
  });

  test("several across different years are distinguished by year alone", () => {
    const titles = resolveBudgetTitles([
      row("a", "Genesis", on(2025, 3)),
      row("b", "Genesis", on(2026, 10)),
    ]);
    expect(titles.get("a")).toBe("Genesis 2025");
    expect(titles.get("b")).toBe("Genesis 2026");
  });

  test("several within one year get the month too", () => {
    const titles = resolveBudgetTitles([
      row("a", "Genesis", on(2026, 3)),
      row("b", "Genesis", on(2026, 10)),
    ]);
    expect(titles.get("a")).toBe("Genesis Mar 2026");
    expect(titles.get("b")).toBe("Genesis Oct 2026");
  });

  test("precision is per YEAR, not per template", () => {
    // 2025 has one; 2026 has two. The 2025 row must not be dragged into
    // showing a month just because a different year collided — disambiguation
    // is a property of the collision.
    const titles = resolveBudgetTitles([
      row("a", "Genesis", on(2025, 6)),
      row("b", "Genesis", on(2026, 3)),
      row("c", "Genesis", on(2026, 10)),
    ]);
    expect(titles.get("a")).toBe("Genesis 2025");
    expect(titles.get("b")).toBe("Genesis Mar 2026");
    expect(titles.get("c")).toBe("Genesis Oct 2026");
  });

  test("different templates never collide with each other", () => {
    const titles = resolveBudgetTitles([
      row("a", "Genesis", on(2026, 3)),
      row("b", "Love Thy Neighbor", on(2026, 3)),
    ]);
    expect(titles.get("a")).toBe("Genesis");
    expect(titles.get("b")).toBe("Love Thy Neighbor");
  });

  test("a budget with no template keeps its own name", () => {
    // Projects, recurring buckets, standalone labels — this function never
    // invents a name for something that isn't template-linked.
    const titles = resolveBudgetTitles([
      row("a", null, on(2026, 3), "Website rebuild"),
      row("b", null, null, "Coffee"),
    ]);
    expect(titles.get("a")).toBe("Website rebuild");
    expect(titles.get("b")).toBe("Coffee");
  });

  test("a dateless row in a colliding group falls back to its own name", () => {
    // Two identical "Genesis" entries would be worse than one "Genesis" and
    // one messy-but-distinct event name.
    const titles = resolveBudgetTitles([
      row("a", "Genesis", on(2026, 3)),
      row("b", "Genesis", null, "genesis night 3"),
    ]);
    expect(titles.get("a")).toBe("Genesis");
    expect(titles.get("b")).toBe("genesis night 3");
  });

  test("a lone dateless templated budget still gets the template name", () => {
    const titles = resolveBudgetTitles([row("a", "Genesis", null, "whatever")]);
    expect(titles.get("a")).toBe("Genesis");
  });

  test("whitespace-only template names are treated as absent", () => {
    const titles = resolveBudgetTitles([row("a", "   ", on(2026, 3), "Fallback")]);
    expect(titles.get("a")).toBe("Fallback");
  });

  test("every input key comes back, always", () => {
    // The caller indexes by key; a missing entry would render an empty title.
    const rows = [
      row("a", "Genesis", on(2026, 3)),
      row("b", "Genesis", on(2026, 4)),
      row("c", null, null),
      row("d", "Genesis", null),
      row("e", "Eden", on(2025, 1)),
    ];
    const titles = resolveBudgetTitles(rows);
    for (const r of rows) expect(titles.has(r.key)).toBe(true);
  });

  test("a group where NOTHING has a date falls back all round", () => {
    // Every row keeps its own name, and — the reason this case is worth a
    // test — the disambiguation pass must not index into an empty set of
    // dated rows on the way there.
    const titles = resolveBudgetTitles([
      row("a", "Genesis", null, "genesis one"),
      row("b", "Genesis", null, "genesis two"),
    ]);
    expect(titles.get("a")).toBe("genesis one");
    expect(titles.get("b")).toBe("genesis two");
  });

  test("an empty list is an empty map, not a throw", () => {
    expect(resolveBudgetTitles([]).size).toBe(0);
  });

  test("a January Eastern date doesn't slide into the previous year", () => {
    // Jan 1 in Eastern is still Jan 1 UTC-5, but the same instant is already
    // Jan 2 in UTC+ zones — bucketing by anything but Eastern would put this
    // budget in the wrong year and disambiguate against the wrong siblings.
    const titles = resolveBudgetTitles([
      row("a", "Genesis", Date.parse("2026-01-01T18:00:00Z")),
      row("b", "Genesis", on(2025, 6)),
    ]);
    expect(titles.get("a")).toBe("Genesis 2026");
    expect(titles.get("b")).toBe("Genesis 2025");
  });
});
