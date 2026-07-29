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
 * TODO(WS2b): `campaigns.createCampaign` / `campaignTemplates.createTemplate`
 * both still run `validateEmailDocument`/`assertValidDoc` — the OLD blocks
 * validator — against whatever `doc` they're handed. Seeding a brand-new
 * email or template with `TIPTAP_STARTER_DOC` (below) will therefore throw
 * `INVALID_DOC` server-side, and neither mutation yet accepts a `docFormat`
 * argument to say "this one's tiptap" (the arg validators are strict, so
 * passing one today is also a `tsc` error, not just a runtime one). This
 * module is written CORRECTLY against the target contract regardless —
 * `packages/shared/src/emailDocFormat.ts`'s "new documents are maily-format
 * from now on" — so the call sites (`CampaignsListView.tsx`,
 * `CampaignTemplatesView.tsx`) need no further change once WS2b lands
 * format-aware validation dispatch.
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
