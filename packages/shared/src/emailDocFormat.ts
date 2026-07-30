/**
 * The contract between the maily editor (mobile), the vendored renderer
 * (packages/email-render), and the send/preview path (apps/convex) during the
 * blocks → tiptap transition. Written FIRST, by the orchestrator, so the two
 * build lanes share a file instead of a description of one.
 *
 * ── Format discriminator ───────────────────────────────────────────────────
 * Lives on the CAMPAIGNS ROW (`campaigns.docFormat`), not inside the doc.
 * Absent means `"blocks"` — every row written before 2026-07-29. Old sent
 * campaigns keep rendering through the legacy block renderer forever; new
 * documents authored in the maily editor are `"tiptap"`. No in-place
 * conversion: converting a pending/approved doc would change its approval
 * snapshot hash and burn its approval.
 *
 * `"html"` (2026-07-30, PR 2 of the founder's editor feedback — "an option
 * to forgo the email editor entirely and just use a html paste from things
 * like canva to send the email") is the third leg: `doc` is
 * `{ html: string }`, the doc that made it through the "Paste HTML" import
 * action (`apps/convex/emailHtmlImport.ts`) — sanitized for XSS and with
 * every external image re-hosted into Convex storage. See
 * `emailHtmlDoc.ts`'s module doc for the doc shape's own contract and
 * `packages/email-render/src/renderEmailHtml.ts` for how it renders. Like
 * `"tiptap"`, an `"html"`-format row is NOT block-editable — re-pasting
 * (the same import action, called again) is the only way to change it, and
 * `docFormat` stays IMMUTABLE per row once created.
 *
 * ── Preview contract (WS3 depends on WS1 providing this) ───────────────────
 * The mobile bundle deliberately does NOT ship packages/email-render (Metro
 * weight; see the WS0 spike report). Tiptap-format previews are rendered
 * server-side by a Convex action:
 *
 *   api.emailPreview.renderCampaignPreview({ campaignId })
 *     → { html: string, text: string }
 *
 * Gated by requireCampaignsAccess (a preview is a read). It renders the SAVED
 * doc with the same sample-recipient variables the old client-side preview
 * used, the compliance footer injected, and dark-mode meta restored — the
 * preview must show what actually sends, per the standing rule. Blocks-format
 * docs keep their existing client-side preview; the action throws
 * WRONG_FORMAT for them rather than half-supporting both.
 */

/** Values of `campaigns.docFormat`. Absent on the row = "blocks". */
export const EMAIL_DOC_FORMATS = ["blocks", "tiptap", "html"] as const;
export type EmailDocFormat = (typeof EMAIL_DOC_FORMATS)[number];

/** Total resolver — the ONE way to read a row's format. */
export function emailDocFormatOf(row: {
  docFormat?: string | null;
}): EmailDocFormat {
  if (row.docFormat === "tiptap") return "tiptap";
  if (row.docFormat === "html") return "html";
  return "blocks";
}
