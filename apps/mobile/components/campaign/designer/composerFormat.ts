/**
 * THE FORMAT SWITCH — which composer host `DocumentComposer` mounts for a
 * given row.
 *
 * `emailDocFormatOf` (`@events-os/shared`) is the one true resolver for
 * "blocks" vs "tiptap" — this module only turns that into the host name and
 * keeps the decision testable as plain data (no React, no Convex client) so
 * `DocumentComposer.tsx` stays a two-line `if`.
 *
 * `campaigns.docFormat` is a real, optional column (`schema/campaigns.ts`,
 * WS2b) — absent (every pre-2026-07-29 row) resolves to `"blocks"`, and a
 * row created with `docFormat: "tiptap"` resolves here for real.
 */
import { emailDocFormatOf, type EmailDocFormat } from "@events-os/shared";

export type ComposerHost = "blocks" | "tiptap";

/** Pure: `EmailDocFormat` → which host renders it. The whole switch, in one
 *  place, so a test can pin it without mounting either host. */
export function composerHostForFormat(docFormat: EmailDocFormat): ComposerHost {
  return docFormat === "tiptap" ? "tiptap" : "blocks";
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
