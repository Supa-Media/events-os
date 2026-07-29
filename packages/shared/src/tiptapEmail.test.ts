import { describe, expect, test } from "vitest";
import {
  EMAIL_TIPTAP_MARK_TYPES,
  EMAIL_TIPTAP_MAX_ATTR_STRING_LENGTH,
  EMAIL_TIPTAP_MAX_DEPTH,
  EMAIL_TIPTAP_MAX_NODES,
  EMAIL_TIPTAP_MAX_SERIALIZED_BYTES,
  EMAIL_TIPTAP_MAX_TEXT_LENGTH,
  EMAIL_TIPTAP_NODE_TYPES,
  findPollNodes,
  validateTiptapEmailDoc,
} from "./tiptapEmail";

// ── Happy paths ──────────────────────────────────────────────────────────

describe("validateTiptapEmailDoc: happy paths", () => {
  test("accepts an empty doc", () => {
    expect(validateTiptapEmailDoc({ type: "doc", content: [] })).toEqual({ ok: true });
  });

  test("accepts a paragraph with plain text", () => {
    const doc = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "Hello." }] }],
    };
    expect(validateTiptapEmailDoc(doc)).toEqual({ ok: true });
  });

  test("accepts every stock node type in one doc", () => {
    const doc = {
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Hi" }] },
        { type: "paragraph", content: [{ type: "text", text: "Body" }] },
        { type: "variable", attrs: { id: "firstName", fallback: "friend" } },
        { type: "horizontalRule" },
        {
          type: "orderedList",
          content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }] }],
        },
        {
          type: "bulletList",
          content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }] }],
        },
        { type: "button", attrs: { text: "Go", url: "https://example.com" } },
        { type: "spacer", attrs: { height: 20 } },
        { type: "hardBreak" },
        { type: "logo", attrs: { src: "https://example.com/logo.png", alt: "Logo" } },
        { type: "image", attrs: { src: "https://example.com/i.png", alt: "img" } },
        { type: "footer", content: [{ type: "paragraph", content: [{ type: "text", text: "bye" }] }] },
        { type: "blockquote", content: [{ type: "paragraph", content: [{ type: "text", text: "quote" }] }] },
        { type: "linkCard", attrs: { title: "Card", link: "https://example.com/card" } },
        {
          type: "section",
          attrs: { backgroundColor: "#fff" },
          content: [{ type: "paragraph", content: [{ type: "text", text: "in section" }] }],
        },
        {
          type: "columns",
          content: [
            { type: "column", attrs: { width: 50 }, content: [{ type: "paragraph", content: [{ type: "text", text: "a" }] }] },
            { type: "column", attrs: { width: 50 }, content: [{ type: "paragraph", content: [{ type: "text", text: "b" }] }] },
          ],
        },
        { type: "repeat", attrs: { each: "items" }, content: [{ type: "paragraph", content: [{ type: "text", text: "row" }] }] },
        { type: "for", attrs: { each: "items" }, content: [{ type: "paragraph", content: [{ type: "text", text: "row" }] }] },
        { type: "inlineImage", attrs: { src: "https://example.com/inline.png" } },
        {
          type: "pwHeading",
          attrs: { level: 2, fontSize: 28, lineHeight: 34, letterSpacing: "0.02em", color: "#111" },
          content: [{ type: "text", text: "PW heading" }],
        },
        {
          type: "pwParagraph",
          attrs: { fontSize: 20, lineHeight: "1.4" },
          content: [{ type: "text", text: "PW paragraph" }],
        },
        { type: "pwBleedImage", attrs: { src: "https://example.com/bleed.png", alt: "Bleed" } },
        {
          type: "pwPoll",
          attrs: {
            id: "poll1",
            question: "Favorite?",
            options: [
              { id: "a", label: "A" },
              { id: "b", label: "B" },
            ],
          },
        },
      ],
    };
    expect(validateTiptapEmailDoc(doc)).toEqual({ ok: true });
  });

  test("accepts marks: bold, italic, underline, strike, textStyle (+letterSpacing), link, code", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "bold", marks: [{ type: "bold" }] },
            { type: "text", text: "italic", marks: [{ type: "italic" }] },
            { type: "text", text: "under", marks: [{ type: "underline" }] },
            { type: "text", text: "strike", marks: [{ type: "strike" }] },
            { type: "text", text: "tracked", marks: [{ type: "textStyle", attrs: { letterSpacing: "0.1em", color: "#000" } }] },
            { type: "text", text: "link", marks: [{ type: "link", attrs: { href: "https://example.com" } }] },
            { type: "text", text: "mailto", marks: [{ type: "link", attrs: { href: "mailto:a@b.com" } }] },
            { type: "text", text: "code", marks: [{ type: "code" }] },
          ],
        },
      ],
    };
    expect(validateTiptapEmailDoc(doc)).toEqual({ ok: true });
  });

  test("accepts a variable-flagged url without scheme-checking it", () => {
    const doc = {
      type: "doc",
      content: [{ type: "button", attrs: { text: "Go", url: "someVariableName", isUrlVariable: true } }],
    };
    expect(validateTiptapEmailDoc(doc)).toEqual({ ok: true });
  });

  test("accepts button maxWidth as a number", () => {
    const doc = {
      type: "doc",
      content: [{ type: "button", attrs: { text: "Go", url: "https://example.com", maxWidth: 280 } }],
    };
    expect(validateTiptapEmailDoc(doc)).toEqual({ ok: true });
  });
});

// WS4, fidelity gap 2 fix: `doc.attrs.pwCanvasColor` — the page canvas
// colour, authored on the document instead of a theme table. See
// `validateDocAttrs` (this file) and `renderEmailTiptap`'s doc
// (`packages/email-render/src/renderEmail.ts`) for the read side.
describe("validateTiptapEmailDoc: doc.attrs.pwCanvasColor", () => {
  test("a doc with no attrs at all is accepted", () => {
    expect(validateTiptapEmailDoc({ type: "doc", content: [] })).toEqual({ ok: true });
  });

  test("attrs with no pwCanvasColor key is accepted", () => {
    expect(validateTiptapEmailDoc({ type: "doc", attrs: {}, content: [] })).toEqual({ ok: true });
  });

  test("a valid 6-digit hex colour is accepted", () => {
    expect(validateTiptapEmailDoc({ type: "doc", attrs: { pwCanvasColor: "#f0f1f5" }, content: [] })).toEqual({
      ok: true,
    });
  });

  test("a valid 3-digit hex colour is accepted", () => {
    expect(validateTiptapEmailDoc({ type: "doc", attrs: { pwCanvasColor: "#fff" }, content: [] })).toEqual({
      ok: true,
    });
  });

  test("rejects a non-hex string", () => {
    const result = validateTiptapEmailDoc({ type: "doc", attrs: { pwCanvasColor: "grey" }, content: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("pwCanvasColor");
  });

  test("rejects a javascript: value (this attr becomes a real CSS background, not an href/src, but still hostile input)", () => {
    const result = validateTiptapEmailDoc({
      type: "doc",
      attrs: { pwCanvasColor: "javascript:alert(1)" },
      content: [],
    });
    expect(result.ok).toBe(false);
  });

  test("rejects a non-string value", () => {
    const result = validateTiptapEmailDoc({ type: "doc", attrs: { pwCanvasColor: 12345 }, content: [] });
    expect(result.ok).toBe(false);
  });

  test("rejects attrs that isn't an object", () => {
    const result = validateTiptapEmailDoc({ type: "doc", attrs: "nope", content: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('"attrs" must be an object');
  });

  test("an unrelated doc-level attr is tolerated (validator only inspects pwCanvasColor)", () => {
    expect(
      validateTiptapEmailDoc({ type: "doc", attrs: { someOtherThing: "whatever" }, content: [] }),
    ).toEqual({ ok: true });
  });
});

// ── Hostile input ────────────────────────────────────────────────────────

describe("validateTiptapEmailDoc: hostile input", () => {
  test("rejects null", () => {
    expect(validateTiptapEmailDoc(null)).toEqual({ ok: false, error: "document must be an object" });
  });

  test("rejects an array as the doc", () => {
    const result = validateTiptapEmailDoc([{ type: "doc" }]);
    expect(result.ok).toBe(false);
  });

  test("rejects a doc missing type: doc", () => {
    const result = validateTiptapEmailDoc({ type: "paragraph", content: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('"type" must be "doc"');
  });

  test("rejects content that isn't an array", () => {
    const result = validateTiptapEmailDoc({ type: "doc", content: "nope" });
    expect(result.ok).toBe(false);
  });

  test("rejects an unknown top-level node type", () => {
    const result = validateTiptapEmailDoc({ type: "doc", content: [{ type: "htmlCodeBlock", content: [] }] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('unknown node type "htmlCodeBlock"');
  });

  test("rejects an unknown nested node type", () => {
    const doc = {
      type: "doc",
      content: [{ type: "section", content: [{ type: "totallyMadeUp" }] }],
    };
    const result = validateTiptapEmailDoc(doc);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('unknown node type "totallyMadeUp"');
  });

  test("rejects an unknown mark type", () => {
    const doc = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "x", marks: [{ type: "blink" }] }] }],
    };
    const result = validateTiptapEmailDoc(doc);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('unknown mark type "blink"');
  });

  test("a node that isn't an object", () => {
    const result = validateTiptapEmailDoc({ type: "doc", content: [null] });
    expect(result.ok).toBe(false);
  });

  describe("javascript: hrefs/srcs, in every position marks and attrs can carry them", () => {
    test("link mark href", () => {
      const doc = {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "x", marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }] }] }],
      };
      expect(validateTiptapEmailDoc(doc).ok).toBe(false);
    });

    test("button url", () => {
      const doc = { type: "doc", content: [{ type: "button", attrs: { text: "Go", url: "javascript:alert(1)" } }] };
      expect(validateTiptapEmailDoc(doc).ok).toBe(false);
    });

    test("image src", () => {
      const doc = { type: "doc", content: [{ type: "image", attrs: { src: "javascript:alert(1)" } }] };
      expect(validateTiptapEmailDoc(doc).ok).toBe(false);
    });

    test("image externalLink", () => {
      const doc = {
        type: "doc",
        content: [{ type: "image", attrs: { src: "https://example.com/i.png", externalLink: "javascript:alert(1)" } }],
      };
      expect(validateTiptapEmailDoc(doc).ok).toBe(false);
    });

    test("logo src", () => {
      const doc = { type: "doc", content: [{ type: "logo", attrs: { src: "javascript:alert(1)" } }] };
      expect(validateTiptapEmailDoc(doc).ok).toBe(false);
    });

    test("linkCard link (no isVariable escape hatch)", () => {
      const doc = { type: "doc", content: [{ type: "linkCard", attrs: { link: "javascript:alert(1)" } }] };
      expect(validateTiptapEmailDoc(doc).ok).toBe(false);
    });

    test("inlineImage src and externalLink", () => {
      expect(
        validateTiptapEmailDoc({ type: "doc", content: [{ type: "inlineImage", attrs: { src: "javascript:x" } }] }).ok,
      ).toBe(false);
      expect(
        validateTiptapEmailDoc({
          type: "doc",
          content: [{ type: "inlineImage", attrs: { src: "https://example.com/i.png", externalLink: "javascript:x" } }],
        }).ok,
      ).toBe(false);
    });

    test("pwBleedImage src and href", () => {
      expect(
        validateTiptapEmailDoc({ type: "doc", content: [{ type: "pwBleedImage", attrs: { src: "javascript:x", alt: "" } }] }).ok,
      ).toBe(false);
      expect(
        validateTiptapEmailDoc({
          type: "doc",
          content: [{ type: "pwBleedImage", attrs: { src: "https://example.com/b.png", alt: "", href: "javascript:x" } }],
        }).ok,
      ).toBe(false);
    });

    test("data: scheme on an image is rejected the same as javascript:", () => {
      const doc = { type: "doc", content: [{ type: "image", attrs: { src: "data:text/html,<script>1</script>" } }] };
      expect(validateTiptapEmailDoc(doc).ok).toBe(false);
    });

    test("isUrlVariable/isSrcVariable true skips the scheme check (a variable NAME, not a URL)", () => {
      const doc = {
        type: "doc",
        content: [
          { type: "button", attrs: { text: "Go", url: "javascript:alert(1)", isUrlVariable: true } },
          { type: "image", attrs: { src: "javascript:alert(1)", isSrcVariable: true } },
        ],
      };
      // These are treated as variable NAMES, not literal hrefs — validation
      // must not scheme-check them (matches maily's own `variableUrlValue`
      // branch, which never treats the string as a URL in this case).
      expect(validateTiptapEmailDoc(doc)).toEqual({ ok: true });
    });
  });

  describe("heading level — the destructure-throw guard", () => {
    test("level 4 is rejected (would throw at render: headings['h4'] is undefined)", () => {
      const doc = { type: "doc", content: [{ type: "heading", attrs: { level: 4 }, content: [] }] };
      const result = validateTiptapEmailDoc(doc);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("level");
    });

    test("level 0 is safe (coerces to 1, the default)", () => {
      const doc = { type: "doc", content: [{ type: "heading", attrs: { level: 0 }, content: [] }] };
      expect(validateTiptapEmailDoc(doc)).toEqual({ ok: true });
    });

    test("a negative level is rejected", () => {
      const doc = { type: "doc", content: [{ type: "heading", attrs: { level: -1 }, content: [] }] };
      expect(validateTiptapEmailDoc(doc).ok).toBe(false);
    });

    test("a non-integer level is rejected", () => {
      const doc = { type: "doc", content: [{ type: "heading", attrs: { level: 2.5 }, content: [] }] };
      expect(validateTiptapEmailDoc(doc).ok).toBe(false);
    });

    test("levels 1-3 are all accepted", () => {
      for (const level of [1, 2, 3]) {
        const doc = { type: "doc", content: [{ type: "heading", attrs: { level }, content: [] }] };
        expect(validateTiptapEmailDoc(doc)).toEqual({ ok: true });
      }
    });

    test("pwHeading gets the same guard", () => {
      const doc = { type: "doc", content: [{ type: "pwHeading", attrs: { level: 9 }, content: [] }] };
      expect(validateTiptapEmailDoc(doc).ok).toBe(false);
    });

    test("no level at all is safe (defaults to 1)", () => {
      const doc = { type: "doc", content: [{ type: "heading", content: [] }] };
      expect(validateTiptapEmailDoc(doc)).toEqual({ ok: true });
    });
  });

  describe("pwPoll — missing/malformed fields", () => {
    test("missing id", () => {
      const doc = { type: "doc", content: [{ type: "pwPoll", attrs: { question: "Q?", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] } }] };
      expect(validateTiptapEmailDoc(doc).ok).toBe(false);
    });

    test("missing question", () => {
      const doc = { type: "doc", content: [{ type: "pwPoll", attrs: { id: "p1", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] } }] };
      expect(validateTiptapEmailDoc(doc).ok).toBe(false);
    });

    test("options not an array", () => {
      const doc = { type: "doc", content: [{ type: "pwPoll", attrs: { id: "p1", question: "Q?", options: "nope" } }] };
      expect(validateTiptapEmailDoc(doc).ok).toBe(false);
    });

    test("too few options", () => {
      const doc = { type: "doc", content: [{ type: "pwPoll", attrs: { id: "p1", question: "Q?", options: [{ id: "a", label: "A" }] } }] };
      expect(validateTiptapEmailDoc(doc).ok).toBe(false);
    });

    test("too many options", () => {
      const options = Array.from({ length: 8 }, (_, i) => ({ id: `o${i}`, label: `Option ${i}` }));
      const doc = { type: "doc", content: [{ type: "pwPoll", attrs: { id: "p1", question: "Q?", options } }] };
      expect(validateTiptapEmailDoc(doc).ok).toBe(false);
    });

    test("option missing label", () => {
      const doc = {
        type: "doc",
        content: [{ type: "pwPoll", attrs: { id: "p1", question: "Q?", options: [{ id: "a" }, { id: "b", label: "B" }] } }],
      };
      expect(validateTiptapEmailDoc(doc).ok).toBe(false);
    });

    test("option missing id", () => {
      const doc = {
        type: "doc",
        content: [{ type: "pwPoll", attrs: { id: "p1", question: "Q?", options: [{ label: "A" }, { id: "b", label: "B" }] } }],
      };
      expect(validateTiptapEmailDoc(doc).ok).toBe(false);
    });

    test("duplicate option id", () => {
      const doc = {
        type: "doc",
        content: [
          {
            type: "pwPoll",
            attrs: { id: "p1", question: "Q?", options: [{ id: "a", label: "A" }, { id: "a", label: "A again" }] },
          },
        ],
      };
      expect(validateTiptapEmailDoc(doc).ok).toBe(false);
    });

    test("a non-object option", () => {
      const doc = { type: "doc", content: [{ type: "pwPoll", attrs: { id: "p1", question: "Q?", options: [null, { id: "b", label: "B" }] } }] };
      expect(validateTiptapEmailDoc(doc).ok).toBe(false);
    });
  });

  describe("depth and node-count caps", () => {
    function deepDoc(depth: number) {
      let node: unknown = { type: "text", text: "leaf" };
      for (let i = 0; i < depth; i++) {
        node = { type: "paragraph", content: [node] };
      }
      return { type: "doc", content: [node] };
    }

    test("a doc within the depth cap is accepted", () => {
      expect(validateTiptapEmailDoc(deepDoc(EMAIL_TIPTAP_MAX_DEPTH - 2)).ok).toBe(true);
    });

    test("a doc past the depth cap is rejected, not stack-overflowing", () => {
      expect(() => validateTiptapEmailDoc(deepDoc(EMAIL_TIPTAP_MAX_DEPTH + 50))).not.toThrow();
      expect(validateTiptapEmailDoc(deepDoc(EMAIL_TIPTAP_MAX_DEPTH + 50)).ok).toBe(false);
    });

    test("a very deep doc (thousands of levels) does not stack-overflow the validator", () => {
      expect(() => validateTiptapEmailDoc(deepDoc(50_000))).not.toThrow();
    });

    test("a cyclic-ish object graph is rejected, not infinite-looped", () => {
      const cyclic: Record<string, unknown> = { type: "paragraph" };
      cyclic.content = [cyclic];
      const doc = { type: "doc", content: [cyclic] };
      expect(() => validateTiptapEmailDoc(doc)).not.toThrow();
      expect(validateTiptapEmailDoc(doc).ok).toBe(false);
    });

    test("a doc past the node-count cap is rejected", () => {
      const content = Array.from({ length: EMAIL_TIPTAP_MAX_NODES + 10 }, () => ({ type: "hardBreak" }));
      const doc = { type: "doc", content };
      expect(validateTiptapEmailDoc(doc).ok).toBe(false);
    });

    test("a doc within the node-count cap is accepted", () => {
      const content = Array.from({ length: 100 }, () => ({ type: "hardBreak" }));
      const doc = { type: "doc", content };
      expect(validateTiptapEmailDoc(doc)).toEqual({ ok: true });
    });
  });

  describe("string-length and total-size caps (byte-bomb defense)", () => {
    test("a text node within the cap is accepted", () => {
      const doc = {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "x".repeat(EMAIL_TIPTAP_MAX_TEXT_LENGTH) }] }],
      };
      expect(validateTiptapEmailDoc(doc)).toEqual({ ok: true });
    });

    test("a single text node one char over the cap is rejected", () => {
      const doc = {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "x".repeat(EMAIL_TIPTAP_MAX_TEXT_LENGTH + 1) }] },
        ],
      };
      expect(validateTiptapEmailDoc(doc).ok).toBe(false);
    });

    test("a single 10MB text node is rejected outright, not silently accepted", () => {
      const bigText = "A".repeat(10 * 1024 * 1024);
      const doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: bigText }] }] };
      const result = validateTiptapEmailDoc(doc);
      expect(result.ok).toBe(false);
    });

    test("an attr string (e.g. a button's authored 'text') within the cap is accepted", () => {
      const doc = {
        type: "doc",
        content: [
          { type: "button", attrs: { text: "x".repeat(EMAIL_TIPTAP_MAX_ATTR_STRING_LENGTH), url: "https://example.com" } },
        ],
      };
      expect(validateTiptapEmailDoc(doc)).toEqual({ ok: true });
    });

    test("an attr string over the cap is rejected", () => {
      const doc = {
        type: "doc",
        content: [
          {
            type: "button",
            attrs: { text: "x".repeat(EMAIL_TIPTAP_MAX_ATTR_STRING_LENGTH + 1), url: "https://example.com" },
          },
        ],
      };
      expect(validateTiptapEmailDoc(doc).ok).toBe(false);
    });

    test("an oversized mark attr string (link href, well past the URL scheme rejects it anyway) — pinned via textStyle.letterSpacing instead, which has no scheme check to short-circuit on first", () => {
      const doc = {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "hi",
                marks: [{ type: "textStyle", attrs: { letterSpacing: "x".repeat(EMAIL_TIPTAP_MAX_ATTR_STRING_LENGTH + 1) } }],
              },
            ],
          },
        ],
      };
      expect(validateTiptapEmailDoc(doc).ok).toBe(false);
    });

    test("pwPoll question/option id/label each independently capped", () => {
      const tooLong = "x".repeat(EMAIL_TIPTAP_MAX_ATTR_STRING_LENGTH + 1);
      const base = { id: "p1", question: "Q?", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] };

      expect(
        validateTiptapEmailDoc({
          type: "doc",
          content: [{ type: "pwPoll", attrs: { ...base, question: tooLong } }],
        }).ok,
      ).toBe(false);

      expect(
        validateTiptapEmailDoc({
          type: "doc",
          content: [
            {
              type: "pwPoll",
              attrs: { ...base, options: [{ id: "a", label: tooLong }, { id: "b", label: "B" }] },
            },
          ],
        }).ok,
      ).toBe(false);

      expect(
        validateTiptapEmailDoc({
          type: "doc",
          content: [{ type: "pwPoll", attrs: base }],
        }),
      ).toEqual({ ok: true });
    });

    test("2000 text nodes each just under the attr cap (the 'many small strings' byte-bomb shape) trips the total-size cap even though no single node trips the per-node caps", () => {
      const content = Array.from({ length: EMAIL_TIPTAP_MAX_NODES }, () => ({
        type: "paragraph",
        content: [{ type: "text", text: "x".repeat(EMAIL_TIPTAP_MAX_TEXT_LENGTH) }],
      }));
      const doc = { type: "doc", content };
      // 2000 * 20_000 chars is ~40MB of text alone — far past the 1MB total
      // cap despite every single node individually passing its own check.
      const result = validateTiptapEmailDoc(doc);
      expect(result.ok).toBe(false);
    });

    test("a doc within the total-size cap is accepted", () => {
      const doc = {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "x".repeat(1000) }] }],
      };
      expect(JSON.stringify(doc).length).toBeLessThan(EMAIL_TIPTAP_MAX_SERIALIZED_BYTES);
      expect(validateTiptapEmailDoc(doc)).toEqual({ ok: true });
    });

    test("a doc just over the total-size cap is rejected even when built from many small, individually-valid nodes", () => {
      // Each node is well under BOTH per-node caps; only the aggregate trips.
      const content = Array.from({ length: 1500 }, () => ({
        type: "paragraph",
        content: [{ type: "text", text: "x".repeat(900) }],
      }));
      const doc = { type: "doc", content };
      expect(JSON.stringify(doc).length).toBeGreaterThan(EMAIL_TIPTAP_MAX_SERIALIZED_BYTES);
      expect(validateTiptapEmailDoc(doc).ok).toBe(false);
    });

    test("total-size cap is measured BEFORE the per-node walk — a cyclic doc still fails cleanly (never throws)", () => {
      const cyclic: Record<string, unknown> = { type: "paragraph" };
      cyclic.content = [cyclic];
      const doc = { type: "doc", content: [cyclic] };
      expect(() => validateTiptapEmailDoc(doc)).not.toThrow();
      expect(validateTiptapEmailDoc(doc).ok).toBe(false);
    });
  });
});

// ── EMAIL_TIPTAP_NODE_TYPES / MARK_TYPES sanity ─────────────────────────────

describe("EMAIL_TIPTAP_NODE_TYPES / EMAIL_TIPTAP_MARK_TYPES", () => {
  test("node types and mark types never overlap", () => {
    const nodeSet = new Set<string>(EMAIL_TIPTAP_NODE_TYPES);
    for (const mark of EMAIL_TIPTAP_MARK_TYPES) {
      expect(nodeSet.has(mark)).toBe(false);
    }
  });

  test("includes the PW node pack", () => {
    for (const t of ["pwHeading", "pwParagraph", "pwBleedImage", "pwPoll"]) {
      expect(EMAIL_TIPTAP_NODE_TYPES as readonly string[]).toContain(t);
    }
  });

  test("excludes htmlCodeBlock (raw-HTML injection escape hatch — see module doc)", () => {
    expect(EMAIL_TIPTAP_NODE_TYPES as readonly string[]).not.toContain("htmlCodeBlock");
  });

  test("has no duplicate entries", () => {
    expect(new Set(EMAIL_TIPTAP_NODE_TYPES).size).toBe(EMAIL_TIPTAP_NODE_TYPES.length);
    expect(new Set(EMAIL_TIPTAP_MARK_TYPES).size).toBe(EMAIL_TIPTAP_MARK_TYPES.length);
  });
});

// ── findPollNodes — format duality ───────────────────────────────────────

describe("findPollNodes", () => {
  test("null/non-object input returns []", () => {
    expect(findPollNodes(null)).toEqual([]);
    expect(findPollNodes(undefined)).toEqual([]);
    expect(findPollNodes("nope")).toEqual([]);
    expect(findPollNodes(42)).toEqual([]);
    expect(findPollNodes([])).toEqual([]);
  });

  test("a doc with neither blocks nor tiptap shape returns []", () => {
    expect(findPollNodes({ foo: "bar" })).toEqual([]);
  });

  describe("blocks format", () => {
    test("finds a top-level poll block", () => {
      const doc = {
        blocks: [
          { id: "blk1", kind: "heading", text: "Hi" },
          {
            id: "blk2",
            kind: "poll",
            question: "Favorite color?",
            options: [
              { id: "opt1", label: "Red" },
              { id: "opt2", label: "Blue" },
            ],
          },
        ],
      };
      expect(findPollNodes(doc)).toEqual([
        {
          id: "blk2",
          question: "Favorite color?",
          options: [
            { id: "opt1", label: "Red" },
            { id: "opt2", label: "Blue" },
          ],
        },
      ]);
    });

    test("multiple polls, in document order", () => {
      const doc = {
        blocks: [
          { id: "p1", kind: "poll", question: "Q1", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] },
          { id: "p2", kind: "poll", question: "Q2", options: [{ id: "c", label: "C" }, { id: "d", label: "D" }] },
        ],
      };
      const polls = findPollNodes(doc);
      expect(polls.map((p) => p.id)).toEqual(["p1", "p2"]);
    });

    test("no blocks array yields []", () => {
      expect(findPollNodes({ blocks: "nope" })).toEqual([]);
    });

    test("malformed poll block (no id) is skipped, not thrown", () => {
      const doc = { blocks: [{ kind: "poll", question: "Q", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }] };
      expect(findPollNodes(doc)).toEqual([]);
    });

    test("malformed option inside an otherwise-valid poll block is dropped, not the whole poll", () => {
      const doc = {
        blocks: [
          {
            id: "p1",
            kind: "poll",
            question: "Q",
            options: [{ id: "a", label: "A" }, { id: 123, label: "bad id type" }, { id: "b", label: "B" }],
          },
        ],
      };
      expect(findPollNodes(doc)).toEqual([
        { id: "p1", question: "Q", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] },
      ]);
    });
  });

  describe("tiptap format", () => {
    test("finds a top-level pwPoll node", () => {
      const doc = {
        type: "doc",
        content: [
          { type: "heading", content: [] },
          {
            type: "pwPoll",
            attrs: {
              id: "poll1",
              question: "Favorite season?",
              options: [
                { id: "s1", label: "Summer" },
                { id: "s2", label: "Winter" },
              ],
            },
          },
        ],
      };
      expect(findPollNodes(doc)).toEqual([
        {
          id: "poll1",
          question: "Favorite season?",
          options: [
            { id: "s1", label: "Summer" },
            { id: "s2", label: "Winter" },
          ],
        },
      ]);
    });

    test("finds a pwPoll nested inside a section/columns layout", () => {
      const doc = {
        type: "doc",
        content: [
          {
            type: "section",
            content: [
              {
                type: "columns",
                content: [
                  {
                    type: "column",
                    content: [
                      {
                        type: "pwPoll",
                        attrs: { id: "nested", question: "Nested?", options: [{ id: "y", label: "Yes" }, { id: "n", label: "No" }] },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      };
      expect(findPollNodes(doc)).toEqual([{ id: "nested", question: "Nested?", options: [{ id: "y", label: "Yes" }, { id: "n", label: "No" }] }]);
    });

    test("empty content yields []", () => {
      expect(findPollNodes({ type: "doc", content: [] })).toEqual([]);
    });

    test("malformed pwPoll (missing question) is skipped", () => {
      const doc = { type: "doc", content: [{ type: "pwPoll", attrs: { id: "p1", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] } }] };
      expect(findPollNodes(doc)).toEqual([]);
    });

    test("a cyclic-ish tiptap doc does not throw or infinite-loop", () => {
      const cyclic: Record<string, unknown> = { type: "section" };
      cyclic.content = [cyclic];
      const doc = { type: "doc", content: [cyclic] };
      expect(() => findPollNodes(doc)).not.toThrow();
    });
  });

  test("blocks format takes precedence when a doc somehow has both shapes", () => {
    const doc = {
      blocks: [{ id: "b1", kind: "poll", question: "Blocks Q", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }],
      type: "doc",
      content: [{ type: "pwPoll", attrs: { id: "t1", question: "Tiptap Q", options: [{ id: "c", label: "C" }, { id: "d", label: "D" }] } }],
    };
    const polls = findPollNodes(doc);
    expect(polls).toEqual([{ id: "b1", question: "Blocks Q", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }]);
  });
});
