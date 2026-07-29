/**
 * Reproduces, then closes, the production defect: opening the built-in
 * "Monthly newsletter" in the maily editor rendered BLANK.
 *
 * ── Root cause ───────────────────────────────────────────────────────────────
 * `@maily-to/core`'s `<Editor>` is real Tiptap/ProseMirror. Loading a document
 * goes through `@tiptap/core`'s `createDocument` → `schema.nodeFromJSON`,
 * which THROWS `RangeError: Unknown node type: …` the instant it meets a node
 * type the schema doesn't recognize. `createNodeFromContent` (`@tiptap/core`)
 * catches that internally, `console.warn`s, and falls back to an EMPTY
 * document — so ONE unknown node type discards the WHOLE doc, silently.
 * `MailyDocumentHost.web.tsx` never passed the Public Worship node pack
 * (`pwHeading`/`pwParagraph`/`pwBleedImage`/`pwPoll`) into `<Editor
 * extensions={...}>`, and the shipped newsletter (`tiptapNewsletterTemplate
 * .ts`) is built almost entirely from those types — hence blank.
 *
 * ── Why this test doesn't import `@maily-to/core`'s real `MailyKit` ────────
 * `@maily-to/core@0.3.7`'s `./extensions` subpath's CJS build has its own,
 * unrelated packaging bug — `require()`-ing it (exactly what this repo's
 * babel-jest transform does under the hood) throws `import_extension_color
 * .default.extend is not a function`, a `@tiptap/extension-color` CJS/ESM
 * interop mismatch inside `@maily-to/core`'s own bundle. Verified NOT to
 * affect the real app: the same import resolved and built a working schema
 * fine under Node's actual ESM loader (`node --experimental-vm-modules`, the
 * resolution path Metro/webpack's real `import` uses in production) — this
 * is purely a Jest/CJS-transform-only landmine in a third-party package, not
 * a bug in our code or a real production risk, so it must not gate this
 * test. This file instead stubs the handful of stock maily node types the
 * real newsletter also uses (section/columns/column/button/footer/image/
 * variable/horizontalRule/text/doc) as minimal local extensions, matching
 * `@maily-to/core@0.3.7`'s real `name`/`group`/`content`/`atom` specs
 * (verified by reading `node_modules/@maily-to/core/dist/index.mjs`,
 * cited inline below) — so the test still runs the REAL, shipped
 * `PUBLIC_WORSHIP_NEWSLETTER_TIPTAP` doc and the REAL `PW_NODE_PACK_EXTENSIONS`
 * this app ships, only swapping out the unrelated third-party stock nodes for
 * schema-shaped stand-ins.
 */
import { Mark, Node, getSchema } from "@tiptap/core";
import { PUBLIC_WORSHIP_NEWSLETTER_TIPTAP } from "@events-os/shared";
import { PW_NODE_PACK_EXTENSIONS } from "./pwNodePack";

// ── Stand-ins for the stock maily/tiptap node types the shipped newsletter
// uses ALONGSIDE the Public Worship node pack (established by walking
// `PUBLIC_WORSHIP_NEWSLETTER_TIPTAP` itself — see this file's sibling test
// output history). `group`/`content`/`atom` mirror `@maily-to/core`'s real
// specs exactly (`dist/index.mjs`, line numbers as of 0.3.7):
//   - doc content "(block|columns)+"   (MailyKit's `Document.extend`, ~10719)
//   - section: group "block", content "(block|columns)+"        (~5126)
//   - columns: group "columns", content "column+"                (~9082)
//   - column: content "block+", no group (referenced by NAME)     (~154)
//   - button: group "block", atom                                 (~9998)
//   - footer: group "block", content "inline*"                    (~10464)
//   - image: group "block" (extends `@tiptap/extension-image`)    (~10151)
//   - horizontalRule: group "block", atom (extends stock HR)       (~9187)
//   - variable: group "inline", inline, atom                       (~7539)
const StubDoc = Node.create({ name: "doc", topNode: true, content: "(block|columns)+" });
const StubText = Node.create({ name: "text", group: "inline" });
const StubVariable = Node.create({ name: "variable", group: "inline", inline: true, atom: true });
const StubSection = Node.create({ name: "section", group: "block", content: "(block|columns)+" });
const StubColumns = Node.create({ name: "columns", group: "columns", content: "column+" });
const StubColumn = Node.create({ name: "column", content: "block+" });
const StubButton = Node.create({ name: "button", group: "block", atom: true });
const StubFooter = Node.create({ name: "footer", group: "block", content: "inline*" });
const StubImage = Node.create({ name: "image", group: "block", atom: true });
const StubHorizontalRule = Node.create({ name: "horizontalRule", group: "block", atom: true });

// Marks the shipped newsletter carries (`italic`, `link`, `textStyle` — see
// this file's module doc). Unlike an extra/unknown ATTR (silently dropped by
// ProseMirror), an unknown MARK TYPE also throws at parse time, so these need
// stand-ins too.
const StubItalic = Mark.create({ name: "italic" });
const StubLink = Mark.create({ name: "link" });
const StubTextStyle = Mark.create({ name: "textStyle" });

const STOCK_STAND_INS = [
  StubDoc,
  StubText,
  StubVariable,
  StubSection,
  StubColumns,
  StubColumn,
  StubButton,
  StubFooter,
  StubImage,
  StubHorizontalRule,
  StubItalic,
  StubLink,
  StubTextStyle,
];

describe("the built-in newsletter, loaded through the real editor schema", () => {
  test("WITHOUT the Public Worship node pack, parsing the shipped newsletter throws — this is the blank-editor bug", () => {
    const schema = getSchema(STOCK_STAND_INS);
    expect(() => schema.nodeFromJSON(PUBLIC_WORSHIP_NEWSLETTER_TIPTAP as never)).toThrow(
      /Unknown node type/,
    );
  });

  test("WITH the Public Worship node pack, the shipped newsletter parses intact — the fix", () => {
    const schema = getSchema([...STOCK_STAND_INS, ...PW_NODE_PACK_EXTENSIONS]);
    const parsed = schema.nodeFromJSON(PUBLIC_WORSHIP_NEWSLETTER_TIPTAP as never);

    // Not just "didn't throw" — the real content is actually there, not a
    // trivially-empty doc that happened to validate.
    expect(parsed.content.childCount).toBe(PUBLIC_WORSHIP_NEWSLETTER_TIPTAP.content.length);

    const text = parsed.textBetween(0, parsed.content.size, " ");
    expect(text).toContain("it's officially summer");
    expect(text).toContain("Open with the month in two or three sentences");

    // The masthead's `pwBleedImage` (first top-level node) carries its
    // `pwSlot` through untouched — proves attrs round-trip, not just node
    // types.
    let firstNodeType = "";
    let firstNodeSlot: unknown;
    const masthead = parsed.content.firstChild;
    if (masthead) {
      firstNodeType = masthead.type.name;
      firstNodeSlot = masthead.attrs.pwSlot;
    }
    expect(firstNodeType).toBe("pwBleedImage");
    expect(firstNodeSlot).toBe("nl-masthead");
  });
});
