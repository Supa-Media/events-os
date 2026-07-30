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
 * handlers, `javascript:`/non-image `data:` URLs (both in tag attributes AND
 * — via `neutralizeCssHazards` below — inside CSS `url(...)`),
 * `<iframe>`/`<object>`/`<embed>`/`<form>`/`<link>`/`<base>`, and a
 * `<meta http-equiv>` (an open-redirect vector no mail client sandboxes) —
 * while KEEPING the tables + inline styles emails depend on.
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
 *  3b. `preserveFailedImageAspect` — an image that could NOT be re-hosted is
 *     now pointing at a 1×1 placeholder, whose square intrinsic ratio would
 *     inflate every `height:auto` image into a giant blank block; stamp the
 *     declared `width`/`height` back on as an `aspect-ratio`.
 *  4. `sanitizeEmailHtml` — the real sanitizer pass, LAST, so whatever
 *     ended up in the HTML after rewriting is what actually gets judged
 *     safe or stripped — nothing rewritten in step 3 bypasses this.
 */
import sanitizeHtml from "sanitize-html";
import { decodeCssObfuscation, hasCssHazard } from "@events-os/shared";

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

/** A bare `//host/path` protocol-relative reference — a real browser (and a
 *  real mail client) resolves this against whatever scheme the surrounding
 *  document loaded over, i.e. it's just as "external" as an explicit
 *  `https://host/path`. Adversarial-review finding (2026-07-30, HIGH):
 *  `findImageUrls` used to only match `https?://`, so `url(//host/track.gif)`
 *  was neither re-hosted NOR blocked — silently shipped as a live
 *  third-party reference. Requires at least one non-slash character after
 *  `//` (a real host), so a bare `//` (or `///path`, which browsers treat as
 *  an empty-host edge case, never a real reference) doesn't false-positive. */
const PROTOCOL_RELATIVE_RE = /^\/\/[^/]/;

/** True iff `url` is an ABSOLUTE external reference this import pipeline
 *  must account for — either `http(s)://…` or bare protocol-relative
 *  `//host/…`. `data:`/`cid:`/relative-path references are excluded: a
 *  `data:` URL is already self-contained (nothing to re-host), and a bare
 *  relative path has no base to resolve against a Canva/CDN export never
 *  provides one anyway. */
function isExternalImageRef(url: string): boolean {
  return /^https?:\/\//i.test(url) || PROTOCOL_RELATIVE_RE.test(url);
}

/**
 * Every DISTINCT external image URL referenced in `html` — `<img src>`, CSS
 * `url(...)` (inline `style=` or a `<style>` block), and legacy
 * `background=` attributes — in FIRST-SEEN order, capped at
 * `MAX_IMAGE_URLS`. Returned EXACTLY as written in the source (an
 * `https://…` URL as `https://…`, a protocol-relative `//host/…` reference
 * as `//host/…`) — `rewriteImageUrls` string-matches against the literal
 * source text, so the caller (`emailHtmlImport.ts`) is the one that resolves
 * a protocol-relative reference to an absolute URL for the actual FETCH.
 */
export function findImageUrls(html: string): string[] {
  const found = new Set<string>();
  for (const re of [IMG_SRC_RE, BACKGROUND_ATTR_RE, CSS_URL_RE]) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(html))) {
      const url = (match[1] ?? match[2] ?? match[3] ?? "").trim();
      if (isExternalImageRef(url)) found.add(url);
      if (found.size >= MAX_IMAGE_URLS) return Array.from(found);
    }
  }
  return Array.from(found);
}

/** Resolve a URL `findImageUrls` returned to something `fetch()` can
 *  actually be given — a protocol-relative reference resolves to `https:`
 *  (never `http:`, regardless of what the surrounding document might imply
 *  — this app never wants to fetch plaintext over the open internet for a
 *  server-side import). An already-absolute `http(s)://` URL passes
 *  through unchanged. */
export function resolveImageFetchUrl(url: string): string {
  return PROTOCOL_RELATIVE_RE.test(url) ? `https:${url}` : url;
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

// ── Keeping a failed image's layout box ─────────────────────────────────────

/** Matches a whole `<img …>` tag (self-closing or not). */
const IMG_TAG_RE = /<img\b[^>]*>/gi;
/** A numeric `width`/`height` ATTRIBUTE (`width="600"`), which is what every
 *  design-tool export emits alongside its inline styles. Percentages and
 *  other non-integer values don't describe a ratio, so they don't match.
 *  Anchored on preceding WHITESPACE, not `\b`: inside a tag, attributes are
 *  whitespace-separated, and a `\b` would also match the tail of
 *  `data-width="…"` (and of `max-width` in any attribute value that happened
 *  to use `=`). */
const NUMERIC_DIM_ATTR = (name: "width" | "height") =>
  new RegExp(`\\s${name}\\s*=\\s*(?:"(\\d+)"|'(\\d+)'|(\\d+))`, "i");
const STYLE_ATTR_IN_TAG_RE = /\sstyle\s*=\s*("([^"]*)"|'([^']*)')/i;

function numericAttr(tag: string, name: "width" | "height"): number | null {
  const match = tag.match(NUMERIC_DIM_ATTR(name));
  if (!match) return null;
  const value = Number(match[1] ?? match[2] ?? match[3]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Stamp `aspect-ratio: W / H` (from the image's OWN `width`/`height`
 * attributes) onto every `<img>` whose `src` is `placeholderSrc` — the inert
 * 1×1 GIF `emailHtmlImport.ts` rewrites an unfetchable image to.
 *
 * ── Why (2026-07-30 founder bug: "the spacing is off") ─────────────────────
 * A design-tool export sizes images with an inline
 * `style="width:600px;height:auto;max-width:100%"` and a matching
 * `width="600" height="62"` attribute pair. Swap the `src` for a 1×1 GIF and
 * `height:auto` resolves against the PLACEHOLDER's 1:1 intrinsic ratio, so a
 * 600×62 masthead becomes a 600×600 white square and a 540×329 hero becomes
 * 540×540. Eleven of those roughly DOUBLED the document height and pushed
 * every section off its designed rhythm — the reported "spacing" bug was
 * never spacing markup at all, it was failed images inflating.
 *
 * `aspect-ratio` makes `height:auto` resolve against the ratio the design
 * actually declared, so a missing image leaves a correctly-sized gap instead
 * of a square. Clients too old to support `aspect-ratio` (Outlook's Word
 * engine) fall back to the `height` ATTRIBUTE, which says the same thing.
 *
 * Skipped when the tag has no usable numeric `width`/`height` pair, or
 * already declares its own `aspect-ratio` (never fight an explicit author
 * declaration). Pure string work on the raw html — must run BEFORE
 * `sanitizeEmailHtml`, whose output re-quotes attributes.
 */
export function preserveFailedImageAspect(html: string, placeholderSrc: string): string {
  if (!placeholderSrc || !html.includes(placeholderSrc)) return html;
  return html.replace(IMG_TAG_RE, (tag) => {
    if (!tag.includes(placeholderSrc)) return tag;
    const width = numericAttr(tag, "width");
    const height = numericAttr(tag, "height");
    if (width === null || height === null) return tag;

    const declaration = `aspect-ratio:${width}/${height}`;
    const styleMatch = tag.match(STYLE_ATTR_IN_TAG_RE);
    if (!styleMatch) {
      // No style attribute at all — the sizing came from the attributes
      // alone, which already imply the right box. Nothing to correct.
      return tag;
    }
    const existing = styleMatch[2] ?? styleMatch[3] ?? "";
    if (/\baspect-ratio\s*:/i.test(existing)) return tag;
    // Keep the author's own quote character, and use a replacer FUNCTION so
    // a `$` anywhere in the existing CSS is never read as a substitution.
    const quote = styleMatch[1].startsWith("'") ? "'" : '"';
    const separator = existing.trim() === "" || existing.trim().endsWith(";") ? "" : ";";
    return tag.replace(
      STYLE_ATTR_IN_TAG_RE,
      () => ` style=${quote}${existing}${separator}${declaration}${quote}`,
    );
  });
}

// ── The real sanitizer ───────────────────────────────────────────────────────

/** Matches a `<style>…</style>` block (content in group 1). Non-greedy so a
 *  document with multiple `<style>` blocks is handled one at a time, not as
 *  one giant match spanning all of them. */
const STYLE_TAG_RE = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi;
/** Matches a `style="…"`/`style='…'` attribute (quoted value in group 1,
 *  INCLUDING its quotes) — deliberately simple (no escaped-quote handling):
 *  a `style` attribute value is CSS, which has no quote-escaping convention
 *  of its own, so a real one never contains an unescaped matching quote
 *  mid-value. */
const STYLE_ATTR_RE = /\sstyle\s*=\s*("[^"]*"|'[^']*')/gi;

/**
 * Neutralize CSS-level hazards (`@import`, `expression(`, `-moz-binding:`,
 * `behavior:`, `url(javascript:…)`/`url(vbscript:…)`, `url()` pointing at a
 * non-image `data:` or a protocol-relative host) `sanitize-html` doesn't
 * parse CSS deeply enough to catch on its own (it treats a `style`
 * attribute's VALUE — and a `<style>` block's text content — as an opaque
 * string when `parseStyleAttributes` is off; see this file's "why not
 * `parseStyleAttributes`" note below for why that's deliberate).
 *
 * Adversarial-review finding (2026-07-30): the PRIOR version of this pass
 * ran plain-text `@import`/`expression(`/etc. regexes directly against the
 * whole html string — which (a) never caught `url(javascript:…)` at all
 * (the doc comment CLAIMED it did; it didn't) and (b) was defeated by any
 * CSS escape/comment obfuscation (`@\69mport` decodes to `@import` in any
 * real CSS parser, but never matched a plain `/@import/`).
 *
 * Fixed shape: isolate each `<style>` block and each `style="…"` attribute
 * value, DE-OBFUSCATE it (`decodeCssObfuscation` — strips comments, decodes
 * CSS backslash escapes; shared with `emailHtmlDoc.ts`'s write-time
 * backstop so the two can't drift again), and if THAT decoded text matches
 * any hazard (`hasCssHazard`), drop the WHOLE block/attribute — never a
 * surgical in-place edit of decoded text back onto the original string
 * (which has no reliable position mapping once escapes have been decoded
 * away). A false positive here just means one style region gets dropped
 * instead of kept — the safe failure direction for a security pass.
 */
function neutralizeCssHazards(html: string): string {
  let result = html.replace(STYLE_TAG_RE, (full, content: string) => {
    return hasCssHazard(decodeCssObfuscation(content)) ? "" : full;
  });
  result = result.replace(STYLE_ATTR_RE, (full, quoted: string) => {
    const raw = quoted.slice(1, -1); // strip the surrounding quote chars
    return hasCssHazard(decodeCssObfuscation(raw)) ? "" : full;
  });
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
  // NOT `http-equiv` — adversarial-review finding (2026-07-30, CRITICAL):
  // `<meta http-equiv="refresh" content="0;url=https://evil/phish">` is a
  // live, mail-client-rendered open redirect (no sandboxing the way the
  // composer's own preview iframe has). Nothing this doc format needs
  // legitimately uses `http-equiv` — `charset`/the compliance shell's
  // `color-scheme` meta pair both go through `content`/`name`/`charset`
  // only — so the attribute is dropped outright rather than allow-listed
  // down to just `refresh` (a narrower allowlist a future edit could widen
  // back without re-deriving why `refresh` specifically was excluded).
  meta: ["name", "content", "charset"],
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
 * `neutralizeCssHazards` pre-pass above plus the tag/attribute allowlist
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
  const precleaned = neutralizeCssHazards(html);
  return sanitizeHtml(precleaned, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: ALLOWED_ATTRIBUTES,
    allowedSchemes: ["http", "https", "mailto", "tel"],
    allowedSchemesByTag: { img: ["http", "https", "data"] },
    allowProtocolRelative: false,
    // `style`/`head`/`meta`/`title` are flagged "vulnerable" by
    // sanitize-html's own defaults (arbitrary CSS/meta content) — we WANT
    // them (see `ALLOWED_TAGS`'s doc) and cover the actual risk ourselves
    // (`neutralizeCssHazards`, the tag/attribute allowlist, the exfil
    // concern being solved by image re-hosting one layer up).
    allowVulnerableTags: true,
    exclusiveFilter: (frame) => {
      if (frame.tag === "img") {
        const src = frame.attribs.src ?? "";
        return /^data:/i.test(src) && !/^data:image\//i.test(src);
      }
      // Belt-and-suspenders on top of `ALLOWED_ATTRIBUTES.meta` already
      // excluding `http-equiv` entirely — if that allowlist is ever widened
      // back for a legitimate reason (e.g. `content-type`), a `refresh`
      // value specifically stays blocked here regardless.
      if (frame.tag === "meta") {
        return typeof frame.attribs["http-equiv"] === "string";
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
