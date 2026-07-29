/**
 * DOCUMENT-LEVEL ATTRS — `doc.attrs.pwCanvasColor` / `doc.attrs.pwFontFamily`
 * survive an editor round-trip.
 *
 * ── The bug this closes ─────────────────────────────────────────────────────
 * `@maily-to/core`'s `MailyKit` declares its own `Document` node
 * (`Document.extend({ content: "(block|columns)+" })`) with NO `addAttributes`
 * of its own — so the ProseMirror schema's "doc" node type has NO attrs at
 * all. `Node.fromJSON`/`toJSON` only round-trip attrs the schema actually
 * DECLARES for a node type; anything else in the source JSON's `attrs` is
 * silently DROPPED the moment `<Editor contentJson={doc}>` parses it. Before
 * this file, opening ANY document that already had `pwCanvasColor` set and
 * letting autosave fire even once would silently erase it — the exact
 * "undeclared attr gets silently dropped" failure mode `pwNodePack.ts`'s own
 * module doc calls out for node attrs, just one level up, on the doc itself.
 * `pwFontFamily` (founder bug #5) needs the SAME survival, which is what
 * surfaced this while wiring the font control.
 *
 * ── Why `addGlobalAttributes`, not another `Document.extend(...)` ──────────
 * A second `Node.create({ name: "doc", ... })` would have to ALSO restate
 * `content: "(block|columns)+"` (and win a same-name schema merge against
 * MailyKit's own `Document.extend`, which is fragile to depend on). A plain
 * `Extension` with `addGlobalAttributes` is the documented Tiptap mechanism
 * for adding attrs to an EXISTING node type without touching anything else
 * about it — no schema-merge ordering to reason about.
 *
 * ── Why no `renderHTML`/`parseHTML` per attr ─────────────────────────────────
 * These attrs live only on the root `doc` node, which ProseMirror never
 * serializes to an HTML tag of its own — `Node.toJSON()`/`fromJSON()` carry
 * `attrs` as plain data regardless, so nothing else is needed for them to
 * round-trip through `editor.getJSON()` (proven in this file's own test by
 * parsing a doc with both attrs set through the real schema and reading them
 * back).
 */
import { Extension } from "@tiptap/core";

export const PwDocAttrsExtension = Extension.create({
  name: "pwDocAttrs",
  addGlobalAttributes() {
    return [
      {
        types: ["doc"],
        attributes: {
          pwCanvasColor: { default: null },
          pwFontFamily: { default: null },
        },
      },
    ];
  },
});
