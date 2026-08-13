// No @types/jest / ambient globals configured for this package — import test
// globals explicitly (mirrors `myTransactions/chargeTodo.test.ts`).
import { describe, expect, test } from "@jest/globals";
import { bookScopeNotice, resolveBookScope } from "./bookScope";

/** Real-shaped Convex chapter ids (32 chars, lowercase base32). */
const NYC = "kh73xrr66rxt2wzr3ny5c2c4kh88n06n";
const LDN = "kh92abc11defg2hijk3lmn4opq5rst6u";

describe("resolveBookScope", () => {
  describe("the live bug: the grid's merged queue", () => {
    test('"all" never reaches the query — it degrades to the desk', () => {
      expect(resolveBookScope("all", "central")).toEqual({
        scope: "central",
        refused: { value: "all", reason: "multi_book" },
      });
    });

    test('"all" with a chapter desk degrades to that chapter', () => {
      expect(resolveBookScope("all", NYC).scope).toBe(NYC);
    });

    test('"all" with no desk yet omits the arg entirely (server fallback)', () => {
      expect(resolveBookScope("all", null)).toEqual({
        scope: null,
        refused: { value: "all", reason: "multi_book" },
      });
    });
  });

  describe("scopes a single-book query accepts", () => {
    test("central passes through untouched, unrefused", () => {
      expect(resolveBookScope("central", NYC)).toEqual({
        scope: "central",
        refused: null,
      });
    });

    test("an explicit chapter id wins over the desk", () => {
      expect(resolveBookScope(LDN, NYC)).toEqual({ scope: LDN, refused: null });
    });
  });

  describe("nothing asked for is not a refusal", () => {
    test("absent falls back to the desk silently", () => {
      expect(resolveBookScope(undefined, "central")).toEqual({
        scope: "central",
        refused: null,
      });
    });

    test('an empty "?scope=" is treated as absent, not as junk', () => {
      expect(resolveBookScope("", NYC)).toEqual({ scope: NYC, refused: null });
    });

    test("absent with no desk omits the arg", () => {
      expect(resolveBookScope(null, null)).toEqual({ scope: null, refused: null });
    });
  });

  describe("everything else that would fail v.id() validation", () => {
    test.each([
      ["chapter"], // the grid's RELATIVE word — not an id
      ["undefined"], // a template literal that stringified a missing value
      ["null"],
      ["Central"], // wrong case: the sentinel is lowercase
      ["kh73xrr"], // truncated id
      ["../../etc/passwd"],
      ["kh73xrr66rxt2wzr3ny5c2c4kh88n06n!"], // an id with junk appended
    ])("%p degrades to the desk and is reported", (value) => {
      expect(resolveBookScope(value, "central")).toEqual({
        scope: "central",
        refused: { value, reason: "not_a_book" },
      });
    });
  });

  describe("the desk is sanitized too", () => {
    test("an unusable desk value can never become the scope", () => {
      // `ChapterContext` can't produce "all" today; this pins that the
      // fallback path has no second, laxer idea of what a book is.
      expect(resolveBookScope(undefined, "all").scope).toBeNull();
    });
  });
});

describe("bookScopeNotice", () => {
  test("names both ends of the substitution for the merged queue", () => {
    expect(bookScopeNotice({ value: "all", reason: "multi_book" }, "Central")).toBe(
      "“All books” isn’t a single book — showing Central.",
    );
  });

  test("quotes what was actually asked for when it isn't a book", () => {
    expect(
      bookScopeNotice({ value: "chapter", reason: "not_a_book" }, "New York"),
    ).toBe("“chapter” isn’t a book this screen can open — showing New York.");
  });
});
