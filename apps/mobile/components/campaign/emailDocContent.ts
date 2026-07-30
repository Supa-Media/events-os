/**
 * FORMAT-AWARE "is there anything here" CHECK — the one place that answers
 * "does this document have content worth showing/sending" for BOTH
 * `docFormat`s, shared by `CampaignStatusCard.tsx` (gates "Request
 * approval"/"Send" and the reviewer's empty-state) and, indirectly via
 * `isTiptapDocEmpty`, `templateFields.ts`'s block summary.
 *
 * Before this existed, three call sites in `CampaignStatusCard.tsx` read
 * `campaign.doc.blocks.length > 0` directly — correct for a `"blocks"`-format
 * row, but `campaign.doc` on a `"tiptap"`-format row has no `.blocks` at all,
 * so every one of those reads threw `Cannot read properties of undefined
 * (reading 'map')`/`(reading 'length')` the instant a fresh tiptap email
 * reached its record page. New rows are seeded `docFormat: "tiptap"` by
 * default (`packages/shared/src/emailDocFormat.ts`), so this was not an edge
 * case — it was every new email.
 *
 * Pure, dependency-free (only a type-only `@tiptap/core` import, fully
 * erased) so it loads under the repo's node-environment Jest config the same
 * way `targetingText.ts`/`mailyDoc.ts` do — see `emailDocContent.test.ts`.
 */
import type { JSONContent } from "@tiptap/core";
import { emailDocFormatOf, emailHtmlDocContentIsEmpty } from "@events-os/shared";
import { isTiptapDocEmpty } from "./designer/mailyDoc";

/** The fields this module needs off a `campaigns` row (email or template
 *  kind — both share the table, so both share this shape) — deliberately
 *  narrow so a test doesn't have to fabricate a whole Convex document. */
export type EmailDocRow = { doc: unknown; docFormat?: string | null };

/**
 * True when `row.doc` has anything worth sending/approving. `"tiptap"` rows
 * defer entirely to `isTiptapDocEmpty` (the maily editor's own definition of
 * "empty," reused rather than re-derived); `"html"` rows defer to
 * `@events-os/shared`'s `emailHtmlDocContentIsEmpty`, the SAME predicate
 * `campaigns.ts#currentDocIsEmpty` uses server-side, so the client's "can I
 * submit this" and the backend's "will I accept this" can't disagree;
 * `"blocks"` rows (docFormat absent or `"blocks"`) keep the original
 * `.blocks.length > 0` read, behind a defensive shape check so a
 * malformed/legacy value degrades to "empty" instead of throwing — mirroring
 * `templateBlockCount`'s same defensive read.
 *
 * ── The `"html"` branch (founder bug, 2026-07-30) ──────────────────────────
 * It was missing, and a `"html"` doc (`{ html }`, no `.blocks`) therefore fell
 * through to the blocks branch and reported EMPTY — so a campaign with a fully
 * imported Canva newsletter in it showed "The design is empty" and had
 * "Request approval" disabled, with no way forward. The backend's own gate
 * (`submitForApproval`/`send`) has always dispatched `"html"` correctly; this
 * was purely the client refusing to let a valid document through. Any format
 * added here in future must land in this function too — it is the only
 * client-side answer to "is there content".
 */
export function hasEmailContent(row: EmailDocRow): boolean {
  const format = emailDocFormatOf(row);
  if (format === "tiptap") {
    return !isTiptapDocEmpty(row.doc as JSONContent | null | undefined);
  }
  if (format === "html") {
    return !emailHtmlDocContentIsEmpty(row.doc);
  }
  const blocks = (row.doc as { blocks?: unknown } | null | undefined)?.blocks;
  return Array.isArray(blocks) && blocks.length > 0;
}

/**
 * The "there's nothing here yet" warning, in the vocabulary of the format the
 * row actually uses — "add at least one block" is meaningless advice for a
 * pasted-HTML email, which has no blocks and no block editor.
 */
export function emptyDocHint(row: EmailDocRow): string {
  switch (emailDocFormatOf(row)) {
    case "html":
      return "Nothing pasted yet — paste your HTML before requesting approval.";
    case "tiptap":
      return "The design is empty — write something first.";
    default:
      return "The design is empty — add at least one block.";
  }
}
