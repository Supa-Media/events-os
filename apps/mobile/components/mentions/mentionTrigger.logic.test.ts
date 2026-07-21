// No @types/jest / ambient globals configured for this package — import test
// globals explicitly from @jest/globals instead of adding a new dependency.
import { describe, expect, test } from "@jest/globals";
import { detectMentionTrigger } from "./mentionTrigger.logic";

/**
 * `detectMentionTrigger` decides whether the cursor sits inside an
 * in-progress `@query` that should open the mention picker. It must only
 * fire for an `@` at the very start of the text or preceded by whitespace
 * (never mid-word, so `user@example.com` never opens a picker while typing
 * regular text into Notes), and must stop tracking the moment a space ends
 * the `@word`.
 */
describe("detectMentionTrigger", () => {
  test("detects an in-progress @query", () => {
    expect(detectMentionTrigger("Hi @jo", 6)).toEqual({ query: "jo", start: 3 });
  });

  test("detects a bare @ at the very start", () => {
    expect(detectMentionTrigger("@", 1)).toEqual({ query: "", start: 0 });
  });

  test("does not trigger inside an email address (@ not preceded by whitespace)", () => {
    expect(detectMentionTrigger("user@example.com", 17)).toBeNull();
  });

  test("stops triggering once a space ends the @word before the cursor", () => {
    expect(detectMentionTrigger("@foo bar", 8)).toBeNull();
  });

  test("no @ sign at all", () => {
    expect(detectMentionTrigger("no at sign here", 5)).toBeNull();
  });
});
