import { describe, expect, test } from "@jest/globals";
import { emptyDocHint, hasEmailContent } from "./emailDocContent";

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

  // ── The founder's "I have HTML content, but it's saying I have no blocks"
  // (2026-07-30). A `docFormat: "html"` row's doc is `{ html }` with no
  // `.blocks`, so it fell through to the blocks branch and reported EMPTY —
  // "The design is empty — add at least one block", Request approval
  // disabled, no way forward, on a campaign carrying a whole imported
  // newsletter. The BACKEND gate (`campaigns.ts#currentDocIsEmpty`) always
  // dispatched "html" correctly; only the client refused.
  describe("html format — pasted HTML is content", () => {
    const pasted = { html: '<table><tr><td>Welcome to our newsletter</td></tr></table>' };

    test("a pasted-HTML doc has content", () => {
      expect(hasEmailContent({ doc: pasted, docFormat: "html" })).toBe(true);
    });

    test("does not throw on a doc with no .blocks property", () => {
      expect(() => hasEmailContent({ doc: pasted, docFormat: "html" })).not.toThrow();
    });

    test("an empty/whitespace-only paste still counts as empty", () => {
      expect(hasEmailContent({ doc: { html: "" }, docFormat: "html" })).toBe(false);
      expect(hasEmailContent({ doc: { html: "   \n  " }, docFormat: "html" })).toBe(false);
    });

    test("a malformed html doc degrades to 'no content' instead of throwing", () => {
      expect(hasEmailContent({ doc: {}, docFormat: "html" })).toBe(false);
      expect(hasEmailContent({ doc: null, docFormat: "html" })).toBe(false);
      expect(hasEmailContent({ doc: { html: 42 }, docFormat: "html" })).toBe(false);
    });
  });

  describe("emptyDocHint — advice in the format's own vocabulary", () => {
    test("never tells a pasted-HTML author to add a block", () => {
      const hint = emptyDocHint({ doc: { html: "" }, docFormat: "html" });
      expect(hint).not.toContain("block");
      expect(hint).toContain("paste");
    });

    test("blocks and tiptap keep their own wording", () => {
      expect(emptyDocHint({ doc: { blocks: [] } })).toContain("block");
      expect(emptyDocHint({ doc: {}, docFormat: "tiptap" })).not.toContain("block");
    });
  });
});
