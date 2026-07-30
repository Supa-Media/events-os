/**
 * "Paste HTML" (PR 2 of the founder's editor feedback, 2026-07-30, verbatim:
 * "there should be an option to forgo the email editor entirely and just use
 * a html paste from things like canva to send the email. We do have to make
 * sure the images are hosted reliably though") — the `docFormat: "html"`
 * twin of `renderEmail.ts`'s `renderEmailTiptap`. THE ONE entry point the
 * backend calls to turn a `docFormat: "html"` campaign doc into a send-ready
 * `{ html, text }` pair.
 *
 * `html` here is ALREADY sanitized and image-re-hosted — that work happens
 * exactly once, upstream, in `apps/convex/emailHtmlImport.ts`'s "use node"
 * import action (the only place untrusted paste content is ever accepted at
 * the string level; see that file's module doc). This function's only job is
 * the SAME compliance-shell wrapping `renderEmailTiptap` does — reusing the
 * identical building blocks (`complianceShell.ts`) rather than a second
 * implementation, so a recipient who gets one tiptap-authored email and one
 * pasted-HTML email in the same inbox can't tell they came from two
 * different renderers:
 *
 *   0. Re-establish the document basics the sanitizer necessarily removed —
 *      a standards-mode doctype and a `<meta charset="utf-8">`
 *      (`ensureDoctype`/`ensureCharsetMeta`; `sanitize-html` discards the
 *      doctype, and the `<meta http-equiv>` it strips for security is the
 *      only place a Canva export declares its encoding).
 *   1. Inject the compliance footer (unsubscribe link + postal address)
 *      before `</body>`.
 *   2. Override any `color-scheme`/`supported-color-schemes` meta tags the
 *      pasted document already carries from `light` to `light dark`.
 *   3. Append the same conservative dark-mode `<style>` block before
 *      `</head>`.
 *
 * Unlike `renderEmailTiptap`, there is no merge-tag/variable substitution —
 * a pasted-HTML email has no editor to insert a `{firstName}` token into, so
 * `RenderEmailHtmlOptions` carries no `variables` field. The `unsubscribeUrl`/
 * `orgAddress`/`preview` contract is otherwise identical.
 *
 * ── Bare fragments ───────────────────────────────────────────────────────
 * A Canva (or similar) export is very often a `<table>`-based FRAGMENT with
 * no `<html>`/`<head>`/`<body>` wrapper at all. `ensureDocumentShell` below
 * wraps a fragment in a minimal document (charset + viewport + the SAME
 * `content="light"` meta pair `overrideColorSchemeMeta` expects to find and
 * flip to `light dark`) so this renderer's compliance/dark-mode hooks have
 * somewhere real to land, and so recipients get correct charset/viewport
 * handling regardless of what the paste itself declared. A document that
 * ALREADY has an `<html>` root is passed through untouched — this never
 * double-wraps.
 */
import {
  ensureCharsetMeta,
  ensureDoctype,
  injectBeforeBodyClose,
  injectBeforeHeadClose,
  overrideColorSchemeMeta,
} from "./postprocess";
import { complianceFooterHtml, complianceFooterText, darkModeStyle, esc } from "./complianceShell";
import type { RenderedEmail } from "./renderEmail";

export type RenderEmailHtmlOptions = {
  /** The per-recipient `/unsubscribe/<token>` URL. */
  unsubscribeUrl: string;
  /** The org's physical mailing address — CAN-SPAM requires this be visible
   *  on every bulk send. */
  orgAddress: string;
  /** Hidden preheader text (the inbox-list snippet after the subject) — only
   *  applied when the input needed wrapping (see module doc); a document
   *  that already declares its own `<head>` keeps whatever preheader markup
   *  it pasted in with, exactly like the rest of its markup. */
  preview?: string;
};

const HTML_ROOT_RE = /<html[\s>]/i;

function ensureDocumentShell(html: string, preview: string | undefined): string {
  if (HTML_ROOT_RE.test(html)) return html;
  const preheader = preview
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all">${esc(preview)}</div>`
    : "";
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">` +
    `</head><body>${preheader}${html}</body></html>`
  );
}

/** Crude tag-stripping HTML→text fallback for the plaintext part of the
 *  email — pasted HTML has no structured doc model to walk the way
 *  `maily.render({ plainText: true })` does for tiptap, so this is
 *  deliberately simple: drop `<script>`/`<style>` ENTIRELY (their content is
 *  never prose), turn block-level closers into line breaks so paragraphs/
 *  table rows don't run together, strip every remaining tag, decode the
 *  handful of entities email HTML actually uses, then collapse runs of
 *  blank lines. Not a fidelity claim — a best-effort plaintext alternative,
 *  same spirit as every other renderer's `text` output existing mainly for
 *  clients that render HTML poorly or not at all. */
function htmlToPlainText(html: string): string {
  const withoutNonContent = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  const withBreaks = withoutNonContent
    .replace(/<(br|\/p|\/div|\/tr|\/h[1-6]|\/li)\s*\/?>/gi, "\n")
    .replace(/<(p|div|tr|h[1-6]|li)[^>]*>/gi, "");
  const stripped = withBreaks.replace(/<[^>]+>/g, "");
  const decoded = stripped
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  return decoded
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Render a `docFormat: "html"` campaign doc (`{ html }`, already sanitized +
 * image-re-hosted) to send-ready HTML + plaintext. See module doc for the
 * full pipeline.
 */
export async function renderEmailHtml(
  html: string,
  opts: RenderEmailHtmlOptions,
): Promise<RenderedEmail> {
  // A paste that already had its own `<html>` root keeps it — but the real
  // sanitizer upstream drops the doctype and (with `http-equiv`) the only
  // charset declaration a design tool emits, so both are re-established here
  // regardless of which branch produced the document. See `postprocess.ts`.
  const shell = ensureCharsetMeta(ensureDoctype(ensureDocumentShell(html, opts.preview)));

  const withFooter = injectBeforeBodyClose(shell, complianceFooterHtml(opts));
  const withMeta = overrideColorSchemeMeta(withFooter);
  const renderedHtml = injectBeforeHeadClose(withMeta, darkModeStyle());

  const text = `${htmlToPlainText(html)}\n\n${complianceFooterText(opts)}\n`;

  return { html: renderedHtml, text };
}
