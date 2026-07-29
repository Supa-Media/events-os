/**
 * Proves the bug `pwDocAttrs.ts`'s module doc describes, then proves the fix:
 * without a declared attr, `doc.attrs.pwCanvasColor`/`pwFontFamily` are
 * silently DROPPED by the schema's own `Node.fromJSON`/`toJSON` — so opening
 * a document that has one set and letting even one autosave fire would erase
 * it. `getSchema([...]).nodeFromJSON(...)`/`.toJSON()` is the same real
 * ProseMirror parse/serialize round-trip `<Editor contentJson={doc}>` and
 * `editor.getJSON()` use — see `pwNodePack.test.ts`'s own doc for why a
 * minimal stand-in `doc`/`paragraph` schema (not maily's real bundle) is used
 * under Jest here.
 */
import { Node, getSchema } from "@tiptap/core";
import { PwDocAttrsExtension } from "./pwDocAttrs";

const StubParagraph = Node.create({ name: "paragraph", group: "block", content: "inline*" });
const StubText = Node.create({ name: "text", group: "inline" });

const DOC_WITH_ATTRS = {
  type: "doc",
  attrs: { pwCanvasColor: "#f0f1f5", pwFontFamily: "serif" },
  content: [{ type: "paragraph", content: [{ type: "text", text: "hello" }] }],
};

describe("doc.attrs round-trip", () => {
  test("WITHOUT PwDocAttrsExtension, pwCanvasColor/pwFontFamily are silently dropped — the bug", () => {
    // `Document` here is `@tiptap/core`'s own default (no `addAttributes`),
    // matching maily's `MailyKit`'s `Document.extend({ content: … })`, which
    // likewise never declares any doc attrs — see this file's own module doc.
    const StubDoc = Node.create({ name: "doc", topNode: true, content: "block+" });
    const schema = getSchema([StubDoc, StubParagraph, StubText]);
    const parsed = schema.nodeFromJSON(DOC_WITH_ATTRS as never);
    expect(parsed.attrs).toEqual({});
    expect(parsed.toJSON().attrs).toBeUndefined();
  });

  test("WITH PwDocAttrsExtension, both attrs survive parse AND re-serialize — the fix", () => {
    const StubDoc = Node.create({ name: "doc", topNode: true, content: "block+" });
    const schema = getSchema([StubDoc, StubParagraph, StubText, PwDocAttrsExtension]);
    const parsed = schema.nodeFromJSON(DOC_WITH_ATTRS as never);

    expect(parsed.attrs.pwCanvasColor).toBe("#f0f1f5");
    expect(parsed.attrs.pwFontFamily).toBe("serif");

    // The actual round-trip a real autosave performs: parse, then serialize
    // back to JSON — not just "the parsed node object has the field".
    const reserialized = parsed.toJSON() as { attrs?: Record<string, unknown> };
    expect(reserialized.attrs?.pwCanvasColor).toBe("#f0f1f5");
    expect(reserialized.attrs?.pwFontFamily).toBe("serif");

    // The doc's real content is untouched — this extension only adds attrs,
    // it doesn't reshape anything else about the node.
    expect(parsed.textBetween(0, parsed.content.size, " ")).toBe("hello");
  });

  test("a document with NEITHER attr set round-trips to both explicitly null — a declared attr's `default` ALWAYS materializes (this is what `validateDocAttrs`'s own doc/tests treat as the real editor's round-trip shape, not a bug)", () => {
    const StubDoc = Node.create({ name: "doc", topNode: true, content: "block+" });
    const schema = getSchema([StubDoc, StubParagraph, StubText, PwDocAttrsExtension]);
    const bareDoc = { type: "doc", content: DOC_WITH_ATTRS.content };
    const parsed = schema.nodeFromJSON(bareDoc as never);
    expect(parsed.toJSON().attrs).toEqual({ pwCanvasColor: null, pwFontFamily: null });
  });
});
