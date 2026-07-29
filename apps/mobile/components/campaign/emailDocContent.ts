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
import { emailDocFormatOf } from "@events-os/shared";
import { isTiptapDocEmpty } from "./designer/mailyDoc";

/** The fields this module needs off a `campaigns` row (email or template
 *  kind — both share the table, so both share this shape) — deliberately
 *  narrow so a test doesn't have to fabricate a whole Convex document. */
export type EmailDocRow = { doc: unknown; docFormat?: string | null };

/**
 * True when `row.doc` has anything worth sending/approving. `"tiptap"` rows
 * defer entirely to `isTiptapDocEmpty` (the maily editor's own definition of
 * "empty," reused rather than re-derived); `"blocks"` rows (docFormat absent
 * or `"blocks"`) keep the original `.blocks.length > 0` read, now behind a
 * defensive shape check so a malformed/legacy value degrades to "empty"
 * instead of throwing — mirroring `templateBlockCount`'s same defensive read.
 */
export function hasEmailContent(row: EmailDocRow): boolean {
  if (emailDocFormatOf(row) === "tiptap") {
    return !isTiptapDocEmpty(row.doc as JSONContent | null | undefined);
  }
  const blocks = (row.doc as { blocks?: unknown } | null | undefined)?.blocks;
  return Array.isArray(blocks) && blocks.length > 0;
}
