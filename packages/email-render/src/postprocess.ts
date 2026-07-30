/**
 * WS0 SPIKE, Bet 3: "output post-processing works". Proves maily's rendered
 * HTML has somewhere to hook our compliance/dark shell onto — it does NOT
 * itself have an unsubscribe/postal-footer concept and force-declares
 * `color-scheme: light` (see `theme.ts`'s `DEFAULT_META_TAGS` equivalent in
 * `maily.tsx`). Per the plan doc: "Our shell post-processes the returned
 * HTML: inject the unsubscribe + postal footer before `</body>` … override
 * the meta tags, append our dark-mode `<style>`/`[data-ogsc]` rules." The
 * REAL compliance/dark shell (footer content, `[data-ogsc]` rules, etc.) is
 * WS1's job, using `packages/shared/src/emailRender.ts`'s existing
 * `styleBlock`/dark-theme machinery as precedent — this file only proves the
 * two hooks it will need exist on maily's output.
 */

/**
 * Insert `insert` immediately BEFORE the LAST `</body>` in `html`.
 *
 * PROVENANCE: the exact approach used in production today for the OLD
 * block-based renderer's reviewer footer — see `injectBeforeBodyClose` in
 * `apps/convex/campaignApprovalEmails.ts` (read, not copied verbatim, since
 * that file is outside this spike's surface; the algorithm and its
 * `lastIndexOf`-not-`indexOf` reasoning are identical). `lastIndexOf` so this
 * is correct even if the document's own content happens to contain the
 * literal string `</body>` in escaped/quoted form.
 */
export function injectBeforeBodyClose(html: string, insert: string): string {
  const idx = html.lastIndexOf("</body>");
  if (idx === -1) return html + insert;
  return html.slice(0, idx) + insert + html.slice(idx);
}

/**
 * Maily's `DEFAULT_META_TAGS` (see `maily.tsx`) force-declares
 * `<meta name="color-scheme" content="light"/>` and
 * `<meta name="supported-color-schemes" content="light"/>` — hardcoding out
 * exactly the dark-mode support `packages/shared/src/emailRender.ts`'s
 * `styleBlock` already emits for the old renderer (`content="light dark"` on
 * both). This finds those two meta tags by `name` attribute (not by matching
 * `content="light"` generically, which could false-positive on some other
 * tag) and rewrites `content="light"` → `content="light dark"` in place.
 */
export function overrideColorSchemeMeta(html: string): string {
  return html.replace(
    /(<meta[^>]*\bname="(?:color-scheme|supported-color-schemes)"[^>]*\bcontent=")light("[^>]*\/?>)/g,
    "$1light dark$2",
  );
}

/**
 * WS1 addition (compliance/dark shell, `renderEmail.ts`): insert `insert`
 * immediately BEFORE the FIRST `</head>` in `html` — the dark-mode `<style>`
 * block's landing spot, alongside the meta-tag override above. `indexOf`
 * (not `lastIndexOf`, unlike `injectBeforeBodyClose`): a document has
 * exactly one `<head>`, and nothing legitimate in maily's own `<head>`
 * output (fonts, meta tags, its own `<style>`) contains the literal string
 * `</head>`, so the first occurrence IS the real one — using `lastIndexOf`
 * here would only matter if something upstream of it could inject a fake
 * `</head>` substring, which nothing in this pipeline does.
 */
export function injectBeforeHeadClose(html: string, insert: string): string {
  const idx = html.indexOf("</head>");
  if (idx === -1) return html + insert;
  return html.slice(0, idx) + insert + html.slice(idx);
}

/**
 * "Paste HTML" addition (2026-07-30): guarantee a standards-mode doctype.
 *
 * A pasted document arrives here having been through the real sanitizer
 * (`apps/convex/lib/emailHtmlSanitize.ts`), and `sanitize-html` DISCARDS the
 * doctype — a Canva export's `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0
 * Transitional//EN" …>` comes out the other side as a bare `<html>`, which
 * renders in QUIRKS mode wherever the HTML is loaded as a document. Restoring
 * it is cheap and removes a whole class of "it looked fine in one client and
 * wrong in another" difference. No-ops when a doctype is already present
 * (`renderEmailHtml`'s own fragment shell emits one).
 */
export function ensureDoctype(html: string): string {
  return /^\s*<!doctype/i.test(html) ? html : `<!doctype html>${html}`;
}

const META_TAG_RE = /<meta\b[^>]*>/gi;
const HEAD_OPEN_RE = /<head\b[^>]*>/i;
const HTML_OPEN_RE = /<html\b[^>]*>/i;

/**
 * True iff some `<meta>` really DECLARES an encoding — either the short form
 * (`<meta charset="utf-8">`) or the legacy `http-equiv` pair.
 *
 * Deliberately not a plain `/<meta[^>]*charset=/` test: the sanitizer leaves
 * Canva's stripped tag behind as `<meta content="text/html; charset=UTF-8">`,
 * where `charset=` survives INSIDE the `content` VALUE while the `http-equiv`
 * that gave it meaning is gone. That declares nothing, and treating it as a
 * declaration is exactly how the mojibake would have survived this fix. So
 * attribute VALUES are blanked before looking for an attribute NAME.
 */
function declaresCharset(html: string): boolean {
  for (const tag of html.match(META_TAG_RE) ?? []) {
    const attributeNames = tag.replace(/=\s*"[^"]*"/g, "=").replace(/=\s*'[^']*'/g, "=");
    if (/\bcharset\s*=/i.test(attributeNames)) return true;
    if (/\bhttp-equiv\s*=/i.test(attributeNames) && /\bcharset\s*=/i.test(tag)) return true;
  }
  return false;
}

/**
 * "Paste HTML" addition (2026-07-30): guarantee a `<meta charset="utf-8">`.
 *
 * The sanitizer strips `<meta http-equiv>` outright (an open-redirect vector
 * — see `ALLOWED_ATTRIBUTES` in `emailHtmlSanitize.ts`), and `http-equiv`
 * happens to be the ONLY way a Canva export declares its encoding
 * (`<meta http-equiv="Content-Type" content="text/html; charset=UTF-8">`).
 * Stripping it left the document with no encoding declaration at all, so any
 * consumer that doesn't get `charset=utf-8` from the transport instead
 * defaults to windows-1252: every curly quote becomes `â€™`, and every
 * `&nbsp;` spacer cell renders a visible `Â`. Re-declaring it in the
 * sanitizer-approved short form keeps the security fix and the encoding.
 *
 * Injected immediately after `<head>` (well inside the first 1024 bytes,
 * which is where a `<meta charset>` has to appear to be honored at all).
 */
export function ensureCharsetMeta(html: string, charset = "utf-8"): string {
  if (declaresCharset(html)) return html;
  const meta = `<meta charset="${charset}">`;
  const headOpen = html.match(HEAD_OPEN_RE);
  if (headOpen?.index !== undefined) {
    const at = headOpen.index + headOpen[0].length;
    return html.slice(0, at) + meta + html.slice(at);
  }
  // No `<head>` to land in: put it right after `<html>` (browsers and mail
  // clients hoist a stray `<meta>` into the implied head), or at the very
  // front for a bare fragment.
  const htmlOpen = html.match(HTML_OPEN_RE);
  if (htmlOpen?.index !== undefined) {
    const at = htmlOpen.index + htmlOpen[0].length;
    return html.slice(0, at) + meta + html.slice(at);
  }
  return meta + html;
}
