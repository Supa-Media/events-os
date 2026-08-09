import { describe, expect, test } from "vitest";
import {
  composeName,
  displayNameOf,
  firstNameForDesignatedLast,
  firstNameOf,
  nameHalvesPatch,
  splitPersonName,
} from "./names";

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

describe("splitPersonName / composeName", () => {
  test("splits exactly two tokens and refuses anything else", () => {
    expect(splitPersonName("Ada Lovelace")).toEqual({ firstName: "Ada", lastName: "Lovelace" });
    expect(splitPersonName("Cher")).toBeNull();
    expect(splitPersonName("Mary Jo Van Der Berg")).toBeNull();
    expect(splitPersonName("   ")).toBeNull();
  });

  test("composes the display convention and drops absent halves", () => {
    expect(composeName("Ada", "Lovelace")).toBe("Ada Lovelace");
    expect(composeName("Cher", undefined)).toBe("Cher");
    expect(composeName(null, "Lovelace")).toBe("Lovelace");
    expect(composeName(undefined, null)).toBe("");
  });

  test("a rename write-through clears halves it can't derive honestly", () => {
    expect(nameHalvesPatch("Ada Lovelace")).toEqual({ firstName: "Ada", lastName: "Lovelace" });
    expect(nameHalvesPatch("Mary Jo Van Der Berg")).toEqual({
      firstName: undefined,
      lastName: undefined,
    });
  });
});

/**
 * Both the People grid's Last Name cell (via `people.update` on the server)
 * and the detail sheet's Name section (in the browser, to preview what will
 * be saved) run THIS function. They must agree, which is why it lives here
 * rather than in `apps/convex`.
 */
describe("firstNameForDesignatedLast", () => {
  test("designating an existing tail leaves the head as the first name", () => {
    expect(firstNameForDesignatedLast("Mary Jo Van Der Berg", "Van Der Berg")).toBe("Mary Jo");
    expect(firstNameForDesignatedLast("Ama (Gina) Oppong Asante", "Asante")).toBe(
      "Ama (Gina) Oppong",
    );
  });

  test("matching the tail is case-insensitive", () => {
    expect(firstNameForDesignatedLast("Ama Oppong ASANTE", "asante")).toBe("Ama Oppong");
  });

  test("a surname the name doesn't end with is an addition, not a designation", () => {
    expect(firstNameForDesignatedLast("Cher", "Sarkisian")).toBe("Cher");
    expect(firstNameForDesignatedLast("Mary Jo Van Der Berg", "Smith")).toBe(
      "Mary Jo Van Der Berg",
    );
  });

  test("matching is token-aligned, so a surname can't eat part of a word", () => {
    // "Vanderberg" ENDS WITH the letters "berg", but they aren't a token —
    // treating that as a designation would leave a first name of "Vander".
    expect(firstNameForDesignatedLast("Vanderberg", "berg")).toBe("Vanderberg");
  });

  test("a surname spanning the whole name is an addition, never an empty head", () => {
    expect(firstNameForDesignatedLast("Asante", "Asante")).toBe("Asante");
    expect(firstNameForDesignatedLast("Van Der Berg", "Van Der Berg")).toBe("Van Der Berg");
  });

  test("surrounding whitespace never leaks into the derived half", () => {
    expect(firstNameForDesignatedLast("  Mary Jo Van Der Berg  ", "  Van Der Berg ")).toBe(
      "Mary Jo",
    );
  });

  test("the detail sheet's preview matches what the server will store", () => {
    // NameFieldsSection composes `firstNameForDesignatedLast(name, last)` with
    // the typed surname; `people.update` does the same. Same inputs, same
    // string — that agreement is the whole point of sharing the rule.
    const name = "Mary Jo Van Der Berg";
    const typedLast = "Van Der Berg";
    expect(composeName(firstNameForDesignatedLast(name, typedLast), typedLast)).toBe(name);
  });
});
