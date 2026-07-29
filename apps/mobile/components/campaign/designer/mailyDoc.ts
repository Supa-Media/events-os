/**
 * TIPTAP DOC HELPERS — the empty starting document every NEW email/template
 * seeds from (docs/plans/maily-editor-overhaul.md, "New template flow"), and
 * the "is there actually anything here" check the empty-state copy in
 * `MailyDocumentHost` reads.
 *
 * Deliberately dependency-free at runtime (only a type-only `@tiptap/core`
 * import, fully erased) so this loads under the repo's node-environment Jest
 * config the same way `targetingText.ts` does.
 *
 * `campaigns.createCampaign` / `campaignTemplates.createTemplate` both accept
 * a `docFormat` argument (WS2b) and dispatch validation on it —
 * `validateTiptapEmailDoc` for `docFormat: "tiptap"` — so seeding a brand-new
 * email or template with this module's starter doc, alongside
 * `docFormat: "tiptap"`, round-trips for real (`CampaignsListView.tsx`,
 * `CampaignTemplatesView.tsx`).
 */
import type { JSONContent } from "@tiptap/core";

/** A brand-new email/template's starting document: one heading, one empty
 *  paragraph to click into — "a sensible starter", not a blank white void
 *  that gives no hint the `+`/slash-command gutter is there to use. */
export function newTiptapDocSeed(): JSONContent {
  // A fresh object every call — two callers seeding two different rows must
  // never end up sharing (and mutating) the same in-memory node array.
  return {
    type: "doc",
    content: [
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Heading" }] },
      { type: "paragraph", content: [] },
    ],
  };
}

/**
 * True when a tiptap document has no content worth showing — `undefined`
 * (still loading), a bare `{ type: "doc" }` with no `content` array, or a
 * `content` array of only empty paragraphs/headings (what's left after
 * someone types everything and deletes it again, or the starter doc itself
 * before its heading is touched — deliberately NOT counted as "empty" here,
 * since "New email" is real placeholder content the composer shows).
 *
 * Mirrors `templateBlockCount`'s defensive read of `doc` in
 * `templateFields.ts`: the shape is enforced by the write gate, not by this
 * reader, so a malformed/legacy value degrades to "empty" instead of
 * throwing.
 */
export function isTiptapDocEmpty(doc: JSONContent | null | undefined): boolean {
  if (!doc) return true;
  const content = Array.isArray(doc.content) ? doc.content : [];
  if (content.length === 0) return true;
  return content.every((node) => nodeIsEmpty(node));
}

/** Text-bearing CONTAINER node types — these are only as "full" as whatever
 *  is nested inside them. Anything else (image, button, poll, horizontalRule,
 *  spacer, logo, …) is a leaf/atom node: reaching this function at all means
 *  it's present in the doc, which is real content regardless of `content`. */
const CONTAINER_NODE_TYPES = new Set([
  "doc",
  "paragraph",
  "heading",
  "blockquote",
  "bulletList",
  "orderedList",
  "listItem",
  "section",
  "columns",
  "column",
]);

function nodeIsEmpty(node: JSONContent): boolean {
  if (!CONTAINER_NODE_TYPES.has(node.type ?? "")) return false;
  const content = Array.isArray(node.content) ? node.content : [];
  if (content.length === 0) return true;
  return content.every((child) => {
    if (child.type === "text") return !(child.text ?? "").trim();
    return nodeIsEmpty(child);
  });
}
