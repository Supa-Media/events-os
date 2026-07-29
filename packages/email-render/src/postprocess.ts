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
