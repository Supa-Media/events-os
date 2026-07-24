import { describe, expect, test } from "vitest";
import { encodeMention, splitMentionSegments } from "./mentions";

/**
 * Mentions are encoded directly inside a plain-text `notes` string as a
 * markdown-link-shaped token (`@[label](mention:type:id)`) — no schema
 * change. These tests pin the encode/decode round-trip plus the parser's
 * behavior on adjacent, absent, and malformed tokens, since every caller
 * (resolution, rendering) trusts `splitMentionSegments` to never swallow or
 * merge text it shouldn't.
 */
describe("encodeMention", () => {
  test("encodes a person mention", () => {
    expect(encodeMention("person", "p1", "Jordan")).toBe(
      "@[Jordan](mention:person:p1)",
    );
  });

  test("encodes a seat mention", () => {
    expect(encodeMention("seat", "s1", "Music Director")).toBe(
      "@[Music Director](mention:seat:s1)",
    );
  });
});

describe("splitMentionSegments", () => {
  test("splits text around a single mention", () => {
    expect(splitMentionSegments("Hi @[Jordan](mention:person:p1) bye")).toEqual([
      { kind: "text", text: "Hi " },
      {
        kind: "mention",
        token: { type: "person", id: "p1", label: "Jordan" },
      },
      { kind: "text", text: " bye" },
    ]);
  });

  test("keeps two adjacent mentions as two segments with no empty text between", () => {
    const text =
      "@[Jordan](mention:person:p1)@[Music Director](mention:seat:s1)";
    expect(splitMentionSegments(text)).toEqual([
      {
        kind: "mention",
        token: { type: "person", id: "p1", label: "Jordan" },
      },
      {
        kind: "mention",
        token: { type: "seat", id: "s1", label: "Music Director" },
      },
    ]);
  });

  test("a plain string with no markup yields exactly one text segment", () => {
    expect(splitMentionSegments("just a note")).toEqual([
      { kind: "text", text: "just a note" },
    ]);
  });

  test("a malformed token (no closing paren) yields a single unmodified text segment", () => {
    const text = "Hi @[Jordan](mention:person:p1 bye";
    expect(splitMentionSegments(text)).toEqual([{ kind: "text", text }]);
  });
});
