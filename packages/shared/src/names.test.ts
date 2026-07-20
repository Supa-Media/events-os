import { describe, expect, test } from "vitest";
import { displayNameOf, firstNameOf } from "./names";

describe("firstNameOf", () => {
  test("returns the first token of a multi-word name", () => {
    expect(firstNameOf("Alex Rivera")).toBe("Alex");
  });

  test("a single-word name returns unchanged", () => {
    expect(firstNameOf("Cher")).toBe("Cher");
  });

  test("trims surrounding whitespace before splitting", () => {
    expect(firstNameOf("  Alex Rivera  ")).toBe("Alex");
  });

  test("collapses extra internal whitespace between words", () => {
    expect(firstNameOf("Alex   Rivera")).toBe("Alex");
  });

  test("null falls back to the default", () => {
    expect(firstNameOf(null)).toBe("friend");
  });

  test("undefined falls back to the default", () => {
    expect(firstNameOf(undefined)).toBe("friend");
  });

  test("empty string falls back to the default", () => {
    expect(firstNameOf("")).toBe("friend");
  });

  test("whitespace-only string falls back to the default", () => {
    expect(firstNameOf("   ")).toBe("friend");
  });

  test("a custom fallback is honored", () => {
    expect(firstNameOf(null, "there")).toBe("there");
    expect(firstNameOf("", "there")).toBe("there");
  });
});

describe("displayNameOf", () => {
  test("returns the trimmed name when present", () => {
    expect(displayNameOf("  Alex Rivera  ", "alex@example.com")).toBe("Alex Rivera");
  });

  test("falls back to the email local part when name is null", () => {
    expect(displayNameOf(null, "alex@example.com")).toBe("alex");
  });

  test("falls back to the email local part when name is undefined", () => {
    expect(displayNameOf(undefined, "alex@example.com")).toBe("alex");
  });

  test("falls back to the email local part when name is empty/whitespace", () => {
    expect(displayNameOf("   ", "alex@example.com")).toBe("alex");
  });

  test("falls back to the raw email when it has no local part before @", () => {
    expect(displayNameOf(null, "@example.com")).toBe("@example.com");
  });

  test("falls back to the raw email when there's no @ at all", () => {
    expect(displayNameOf(null, "not-an-email")).toBe("not-an-email");
  });
});
