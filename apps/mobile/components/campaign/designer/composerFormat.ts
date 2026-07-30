/**
 * THE FORMAT SWITCH — which composer host `DocumentComposer` mounts for a
 * given row.
 *
 * `emailDocFormatOf` (`@events-os/shared`) is the one true resolver for
 * "blocks" vs "tiptap" vs "html" — this module only turns that into the host
 * name and keeps the decision testable as plain data (no React, no Convex
 * client) so `DocumentComposer.tsx` stays a three-way `if`.
 *
 * `campaigns.docFormat` is a real, optional column (`schema/campaigns.ts`,
 * WS2b) — absent (every pre-2026-07-29 row) resolves to `"blocks"`, a row
 * created with `docFormat: "tiptap"` resolves here for real, and
 * `docFormat: "html"` (PR 2, "Paste HTML", 2026-07-30) resolves to the
 * `HtmlPasteComposer` host.
 */
import { emailDocFormatOf, type EmailDocFormat } from "@events-os/shared";

export type ComposerHost = "blocks" | "tiptap" | "html";

/** Pure: `EmailDocFormat` → which host renders it. The whole switch, in one
 *  place, so a test can pin it without mounting either host. */
export function composerHostForFormat(docFormat: EmailDocFormat): ComposerHost {
  if (docFormat === "tiptap") return "tiptap";
  if (docFormat === "html") return "html";
  return "blocks";
}

/** Convenience: resolve straight from a row (or `undefined` while it's still
 *  loading, which stays on the safe/existing "blocks" host rather than
 *  flashing a different editor once the query resolves). */
export function composerHostForRow(
  row: { docFormat?: string | null } | null | undefined,
): ComposerHost {
  if (!row) return "blocks";
  return composerHostForFormat(emailDocFormatOf(row));
}
