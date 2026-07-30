/**
 * "Paste HTML" (PR 2 of the founder's editor feedback, 2026-07-30) — the
 * pure, ctx-free half of `emailHtmlImport.ts`'s import action: finding
 * external image URLs in pasted HTML, rewriting them to re-hosted URLs, and
 * the REAL sanitizer pass. Split out of the "use node" action file so these
 * are unit-testable with plain vitest (no Convex runtime, no network) — the
 * action itself only adds the ctx-dependent parts (fetching each image,
 * `ctx.storage.store`) around these pure functions.
 *
 * ── Two sanitization layers — see `@events-os/shared`'s `emailHtmlDoc.ts`
 * module doc for the full picture. This file is the REAL one: a real parser
 * (`sanitize-html`, built on `htmlparser2`) that strips `<script>`, event
 * handlers, `javascript:`/non-image `data:` URLs, `<iframe>`/`<object>`/
 * `<embed>` — while KEEPING the tables + inline styles emails depend on.
 * `@events-os/shared`'s `findHtmlDocHazard` is the separate, coarse regex
 * backstop that runs at every WRITE regardless of how the doc got there;
 * this is the one place that actually EARNS pasted HTML's presence in a
 * sent/previewed email.
 *
 * ── Order of operations (`importPastedHtml` in `emailHtmlImport.ts`) ───────
 *  1. `findImageUrls` — scan the RAW pasted HTML for external image
 *     references (`<img src>`, CSS `url(...)` in `style=`/`<style>`,
 *     legacy `background=`) BEFORE any sanitization, so a URL that would
 *     otherwise get stripped (e.g. inside a `<style>` block) still gets a
 *     chance to be found and re-hosted.
 *  2. The action fetches each into Convex storage (ctx-dependent, not here).
 *  3. `rewriteImageUrls` — plain string substitution of every ORIGINAL URL
 *     that was successfully re-hosted, on the raw HTML.
 *  4. `sanitizeEmailHtml` — the real sanitizer pass, LAST, so whatever
 *     ended up in the HTML after rewriting is what actually gets judged
 *     safe or stripped — nothing rewritten in step 3 bypasses this.
 */
import sanitizeHtml from "sanitize-html";

// ── Image discovery ─────────────────────────────────────────────────────────

/** Matches `<img ... src="URL" ...>` (single or double quotes). */
const IMG_SRC_RE = /<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)')/gi;
/** Matches legacy `background="URL"` table/body attributes. */
const BACKGROUND_ATTR_RE = /\bbackground\s*=\s*(?:"([^"]+)"|'([^']+)')/gi;
/** Matches CSS `url(...)` — inline `style="background-image:url(...)"` AND
 *  `<style>` block rules alike; quotes optional per the CSS spec. */
const CSS_URL_RE = /url\(\s*(?:"([^"]+)"|'([^']+)'|([^'")\s]+))\s*\)/gi;

/** Bound on how many DISTINCT image URLs one paste can ask this action to
 *  fetch — an abuse/cost backstop, not a realistic ceiling for a real
 *  newsletter (a Canva export rarely carries more than a handful). */
export const MAX_IMAGE_URLS = 40;

/**
 * Every DISTINCT `http(s)://` image URL referenced in `html` — `<img src>`,
 * CSS `url(...)` (inline `style=` or a `<style>` block), and legacy
 * `background=` attributes — in FIRST-SEEN order, capped at
 * `MAX_IMAGE_URLS`. `data:`/`cid:`/relative references are deliberately
 * excluded: a `data:` URL is already self-contained (nothing to re-host),
 * and a bare relative path has no base to resolve against a Canva/CDN
 * export never provides one anyway — re-hosting only ever matters for
 * absolute external URLs, which is exactly the "Canva URLs expire/block
 * hotlinking" problem this exists to solve.
 */
export function findImageUrls(html: string): string[] {
  const found = new Set<string>();
  for (const re of [IMG_SRC_RE, BACKGROUND_ATTR_RE, CSS_URL_RE]) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(html))) {
      const url = (match[1] ?? match[2] ?? match[3] ?? "").trim();
      if (/^https?:\/\//i.test(url)) found.add(url);
      if (found.size >= MAX_IMAGE_URLS) return Array.from(found);
    }
  }
  return Array.from(found);
}

/**
 * Rewrite every occurrence of a re-hosted URL's ORIGINAL string to its new
 * one — plain `split`/`join` (not a regex) so a URL's own special
 * characters (`?`, `(`, `.`, …) never need escaping. Every occurrence of a
 * given original URL is rewritten, even if it appears more than once (a
 * masthead image reused in a header and a footer, say) — `urlMap` is
 * keyed by the exact string `findImageUrls` returned, so this only ever
 * touches URLs this import actually resolved.
 */
export function rewriteImageUrls(html: string, urlMap: ReadonlyMap<string, string>): string {
  let rewritten = html;
  for (const [original, replacement] of urlMap) {
    if (!original || original === replacement) continue;
    rewritten = rewritten.split(original).join(replacement);
  }
  return rewritten;
}

// ── The real sanitizer ───────────────────────────────────────────────────────

/** Coarse, belt-and-suspenders pre-pass over KNOWN legacy CSS attack
 *  patterns `sanitize-html` doesn't parse CSS deeply enough to catch on its
 *  own (it treats a `style` attribute's VALUE as an opaque string when
 *  `parseStyleAttributes` is off — deliberately off here, see this file's
 *  "why not `parseStyleAttributes`" note below): old-IE `expression()` and
 *  `-moz-binding`/`behavior:url(...)` "CSS as code execution" tricks, plus
 *  `@import` (which could pull in an attacker stylesheet) and `javascript:`
 *  inside a CSS `url(...)`. Runs on the WHOLE string, before the real
 *  sanitizer, so a hit here never survives into the parsed tree at all. */
const CSS_HAZARD_PATTERNS: RegExp[] = [
  /expression\s*\(/gi,
  /-moz-binding\s*:/gi,
  /behavior\s*:/gi,
  /@import/gi,
];

function stripCssHazards(html: string): string {
  let result = html;
  for (const re of CSS_HAZARD_PATTERNS) {
    result = result.replace(re, "");
  }
  return result;
}

/** Tags kept beyond `sanitize-html`'s own conservative default list — every
 *  one of these is either structural table/layout markup real emails
 *  (including Canva exports) depend on, or head/meta content the
 *  compliance shell's post-processing hooks need real anchor points for
 *  (`<head>`, `<style>`, the `color-scheme` `<meta>` pair). Deliberately
 *  does NOT include `<script>`/`<iframe>`/`<object>`/`<embed>`/`<form>` —
 *  those stay on `sanitize-html`'s default-disallowed list. */
const ALLOWED_TAGS = [
  "html",
  "head",
  "body",
  "meta",
  "title",
  "style",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "td",
  "th",
  "div",
  "span",
  "p",
  "a",
  "img",
  "br",
  "hr",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "li",
  "strong",
  "b",
  "em",
  "i",
  "u",
  "s",
  "small",
  "blockquote",
  "center",
  "font",
  "sup",
  "sub",
  "pre",
  "code",
];

/** `*` attributes: layout/typography attributes every table-based email
 *  leans on (`align`/`valign`/`width`/`height`/`bgcolor`/`border`/
 *  `cellpadding`/`cellspacing`/`colspan`/`rowspan`) plus `style`/`class` —
 *  deliberately NOT `id` (an attacker-controlled `id` could collide with
 *  this app's own `pw-compliance-footer`/`pw-dark-mode` ids the compliance
 *  shell injects, letting a paste's CSS target and hide/alter them). No
 *  `on*` handler is ever in this list, which is what actually removes them
 *  — `sanitize-html` drops any attribute not explicitly allowed. */
const ALLOWED_ATTRIBUTES: sanitizeHtml.IOptions["allowedAttributes"] = {
  "*": [
    "style",
    "class",
    "align",
    "valign",
    "width",
    "height",
    "bgcolor",
    "border",
    "cellpadding",
    "cellspacing",
    "colspan",
    "rowspan",
    "dir",
    "lang",
    "background",
  ],
  a: ["href", "target", "rel", "name"],
  img: ["src", "alt", "width", "height", "style", "border"],
  meta: ["name", "content", "charset", "http-equiv"],
};

/**
 * The real sanitizer. `html` should already have gone through
 * `rewriteImageUrls` (re-hosting) — this doesn't rewrite anything, it only
 * judges what survives.
 *
 * ── Why not `parseStyleAttributes` ──────────────────────────────────────
 * `sanitize-html` can deep-parse `style` attribute VALUES (via `postcss`)
 * when `parseStyleAttributes: true`, restricting individual CSS
 * properties/values. Left OFF here on purpose — CLAUDE.md's "keep deps
 * minimal, prefer libs known to bundle in Convex node actions" — the
 * coarse `stripCssHazards` pre-pass above plus the tag/attribute allowlist
 * (`<script>`/`on*`/`javascript:`/non-image `data:` all excluded
 * elsewhere) already cover the shapes that matter for email HTML; a deep
 * CSS AST walk is more machinery than this surface needs and doesn't
 * change which of THIS file's adversarial tests pass.
 *
 * ── `data:` URLs ─────────────────────────────────────────────────────────
 * `allowedSchemesByTag.img` includes `data:` (a self-contained inline
 * image is legitimate and needs no re-hosting) but `exclusiveFilter` drops
 * any `<img>` whose `src` is a `data:` URL that ISN'T `data:image/...` —
 * `sanitize-html`'s own scheme allowlist can't discriminate by MIME type
 * within one scheme, so this is the one place that distinction is made.
 * `<a href>` never allows `data:`/`javascript:`/`vbscript:` at all (not in
 * `allowedSchemes`).
 */
export function sanitizeEmailHtml(html: string): string {
  const precleaned = stripCssHazards(html);
  return sanitizeHtml(precleaned, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: ALLOWED_ATTRIBUTES,
    allowedSchemes: ["http", "https", "mailto", "tel"],
    allowedSchemesByTag: { img: ["http", "https", "data"] },
    allowProtocolRelative: false,
    // `style`/`head`/`meta`/`title` are flagged "vulnerable" by
    // sanitize-html's own defaults (arbitrary CSS/meta content) — we WANT
    // them (see `ALLOWED_TAGS`'s doc) and cover the actual risk ourselves
    // (`stripCssHazards`, the tag/attribute allowlist, the exfil concern
    // being solved by image re-hosting one layer up).
    allowVulnerableTags: true,
    exclusiveFilter: (frame) => {
      if (frame.tag === "img") {
        const src = frame.attribs.src ?? "";
        return /^data:/i.test(src) && !/^data:image\//i.test(src);
      }
      return false;
    },
    // Discard (not escape) disallowed tags' CONTENT too — a stripped
    // `<script>` must not leave its JS body sitting in the output as
    // visible-but-inert text, and definitely not as escaped-but-later-
    // unescaped markup.
    disallowedTagsMode: "discard",
  });
}
