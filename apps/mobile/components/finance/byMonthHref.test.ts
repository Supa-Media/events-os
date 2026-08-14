// No @types/jest / ambient globals configured for this package — import test
// globals explicitly from @jest/globals (mirrors `bookScope.test.ts`).
import { describe, expect, test } from "@jest/globals";
import { byMonthHref, BY_MONTH_VIEW_QUERY } from "./byMonthHref";

describe("byMonthHref", () => {
  test("always sets the three axes that make the grid ask the publishing question", () => {
    // Not asserted as a whole string on purpose — these four are the contract,
    // and a test that pinned the exact concatenation would fail on a reorder
    // that changed nothing.
    expect(BY_MONTH_VIEW_QUERY).toContain("filters=needs_explaining");
    expect(BY_MONTH_VIEW_QUERY).toContain("sort=amount");
    expect(BY_MONTH_VIEW_QUERY).toContain("dir=desc");
    expect(BY_MONTH_VIEW_QUERY).toContain("group=month");
  });

  test("with no period, bands the whole book rather than narrowing to a month", () => {
    const href = byMonthHref({});
    expect(href).toBe(`/finances/reconcile?${BY_MONTH_VIEW_QUERY}`);
    expect(href).not.toContain("year=");
    expect(href).not.toContain("month=");
  });

  test("narrows to ONE month, never the whole year", () => {
    const href = byMonthHref({ period: { year: 2025, month: 3 } });
    expect(href).toContain("year=2025");
    expect(href).toContain("month=3");
    // Without `period=month` the grid reads the whole year — a different
    // question with a much larger answer.
    expect(href).toContain("period=month");
  });

  test("sends central to ?scope= and a chapter id to ?chapterId=", () => {
    // THE TRANSLATION THAT MATTERS. The grid's `?scope=` takes three words and
    // a chapter id is none of them: forwarding one there falls back to the
    // caller's own desk and silently shows a different book than the link
    // promised.
    expect(byMonthHref({ scope: "central" })).toContain("scope=central");
    expect(byMonthHref({ scope: "central" })).not.toContain("chapterId=");

    const chapter = byMonthHref({ scope: "k17abcdef" });
    expect(chapter).toContain("chapterId=k17abcdef");
    expect(chapter).not.toContain("scope=");
  });

  test("drops an absent scope rather than guessing one", () => {
    // An unscoped link has always meant "the caller's own desk". Picking
    // central on their behalf would point a chapter treasurer at a book that
    // isn't theirs.
    expect(byMonthHref({ scope: null })).not.toContain("scope=");
    expect(byMonthHref({ scope: undefined })).not.toContain("chapterId=");
  });

  test("escapes the chapter id it puts in the query string", () => {
    expect(byMonthHref({ scope: "a b&c" })).toContain("chapterId=a%20b%26c");
  });
});
