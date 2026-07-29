import { describe, expect, test } from "@jest/globals";
import { hasEmailContent } from "./emailDocContent";

describe("hasEmailContent — the format-aware replacement for `doc.blocks.length > 0`", () => {
  describe("blocks format (docFormat absent or 'blocks')", () => {
    test("a doc with blocks has content", () => {
      expect(hasEmailContent({ doc: { blocks: [{ kind: "heading" }] } })).toBe(true);
    });

    test("a doc with an empty blocks array has no content", () => {
      expect(hasEmailContent({ doc: { blocks: [] } })).toBe(false);
    });

    test("a malformed/legacy doc degrades to 'no content' instead of throwing", () => {
      expect(() => hasEmailContent({ doc: {} })).not.toThrow();
      expect(hasEmailContent({ doc: {} })).toBe(false);
      expect(hasEmailContent({ doc: undefined })).toBe(false);
      expect(hasEmailContent({ doc: null })).toBe(false);
      expect(hasEmailContent({ doc: { blocks: "nope" } })).toBe(false);
    });

    test("docFormat explicitly 'blocks' behaves the same as absent", () => {
      expect(hasEmailContent({ doc: { blocks: [{ kind: "text" }] }, docFormat: "blocks" })).toBe(
        true,
      );
    });
  });

  describe("tiptap format — the exact regression that crashed production", () => {
    // Before this fix, every one of `CampaignStatusCard.tsx`'s three
    // `campaign.doc.blocks.length > 0` reads threw
    // `Cannot read properties of undefined (reading 'length')` on exactly
    // this shape: a `docFormat: "tiptap"` row whose `doc` has no `.blocks`.
    test("does not throw on a tiptap doc with no .blocks property", () => {
      const tiptapDoc = {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "Hello" }] }],
      };
      expect(() => hasEmailContent({ doc: tiptapDoc, docFormat: "tiptap" })).not.toThrow();
      expect(hasEmailContent({ doc: tiptapDoc, docFormat: "tiptap" })).toBe(true);
    });

    test("a genuinely empty tiptap doc has no content", () => {
      expect(hasEmailContent({ doc: { type: "doc" }, docFormat: "tiptap" })).toBe(false);
      expect(hasEmailContent({ doc: undefined, docFormat: "tiptap" })).toBe(false);
    });

    test("a tiptap doc with only empty paragraphs has no content", () => {
      expect(
        hasEmailContent({
          doc: { type: "doc", content: [{ type: "paragraph", content: [] }] },
          docFormat: "tiptap",
        }),
      ).toBe(false);
    });

    test("an atom node (image/button/poll) counts as content even with no nested text", () => {
      expect(
        hasEmailContent({
          doc: { type: "doc", content: [{ type: "button", attrs: { url: "x" } }] },
          docFormat: "tiptap",
        }),
      ).toBe(true);
    });
  });
});
