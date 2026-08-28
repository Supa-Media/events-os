/**
 * BLOG MARKDOWN → HTML. The renderer behind every `/blog/<slug>` page.
 *
 * A post's `body` is stored as markdown and rendered at request time
 * (`marketingBlog.ts`'s `BlogPost.body` doc says why: a fix here fixes every
 * post that ever existed, not only the ones written afterwards). This module
 * is that renderer, plus the table-of-contents extractor the page's sidebar
 * needs, plus the sanitizer that makes raw-HTML passthrough survivable.
 *
 * ── Why a hand-written parser and not a library ─────────────────────────────
 * There is no markdown library in this repo, and the Convex V8 runtime is
 * where this has to run — `publicPost` renders inside a query, not a node
 * action. Adding `marked`/`markdown-it` to that bundle for one page is a
 * dependency the deploy has to carry forever, and every one of them ships its
 * own HTML-passthrough behavior that would then need auditing anyway. So:
 * zero dependencies, same portability contract as `emailMarkdown.ts` (Convex
 * V8, vitest, jest, Expo).
 *
 * This is NOT `emailMarkdown.ts`. That one is a deliberately tiny subset
 * (bold, italic, links, paragraphs, `- ` lists) because a campaign email is a
 * few sentences and every mail client renders HTML differently. A blog post is
 * an essay with headings, tables, callouts and pull quotes — the one real post
 * (`doxology.md`) uses all of them — so the two could not share a parser
 * without one of them lying about what it accepts.
 *
 * ── How this relates to `apps/convex/lib/emailHtmlSanitize.ts` ──────────────
 * That file is this repo's other HTML sanitizer, and it is NOT reused here.
 * Three reasons, in order of weight:
 *
 *   1. It is built on the `sanitize-html` npm package, which exists in the
 *      bundle only because its caller (`emailHtmlImport.ts`) is a `"use node"`
 *      action. This renderer runs in a V8 query. Pulling a parser dependency
 *      into that bundle is exactly the cost this module was written to avoid.
 *   2. It sanitizes for a fundamentally different threat model: PASTED HTML
 *      from a stranger's design tool, going into an inbox, where inline
 *      `style` and table-layout attributes must survive because email clients
 *      have no CSS of their own. So it ALLOWS `<style>`, `style="…"`,
 *      `bgcolor`, `background`, `<font>`, `<center>` — and then needs a whole
 *      CSS-hazard de-obfuscation pass (`neutralizeCssHazards`) to make that
 *      safe. This surface has none of that: a post's raw HTML is written by a
 *      trusted seat against the site's OWN stylesheet (the existing post
 *      styles its table with `class="pw-scroll"` and its callout with
 *      `class="pw-note"`), so `style` and `<style>` are simply refused and the
 *      entire class of CSS attacks — `expression()`, `@import` exfil,
 *      `url(javascript:)` — never has to be defended against here.
 *   3. It is HTML-in-HTML-out. This module has to interleave sanitizing with
 *      markdown inline parsing (a raw `<abbr>` mid-sentence), which a
 *      whole-document sanitizer pass cannot do without re-parsing the output.
 *
 * What IS borrowed from it, deliberately: the allowlist posture (nothing is
 * kept unless named), dropping disallowed tags' CONTENT rather than escaping
 * it, and refusing `id` on author HTML — see `GLOBAL_ATTRS`.
 *
 * ── The security contract, stated once ──────────────────────────────────────
 * The author is a trusted seat (`marketing.blog.edit`). The READER is the open
 * internet, and the post is served from the org's own origin next to a signed
 * -in OS on the same domain family. So "the author is trusted" buys nothing:
 * a compromised account, a pasted snippet, or an honest mistake all end up as
 * script on a page the public loads. Everything below is therefore allowlist-
 * only:
 *
 *   • Tags not in `ALLOWED_TAGS` are dropped. Their text content survives,
 *     EXCEPT for `DROP_WITH_CONTENT` tags (`<script>`, `<style>`, `<iframe>`,
 *     …) whose content is discarded too — a stripped `<script>` must not leave
 *     its body sitting on the page as visible text.
 *   • Attributes not in `GLOBAL_ATTRS` / `TAG_ATTRS` are dropped, which is
 *     what actually removes every `on*` handler (there is a redundant explicit
 *     `on*` check as well, so a future widening of the allowlist cannot
 *     silently re-admit them).
 *   • Every URL-bearing attribute goes through `isSafeUrl`, which decodes HTML
 *     entities and strips control characters BEFORE looking at the scheme, so
 *     `&#106;avascript:`, `java\tscript:` and `JaVaScRiPt:` are all refused.
 *     Allowed schemes: http, https, mailto, tel, and relative URLs. `data:`
 *     is refused outright — a hero image goes through Convex storage, and
 *     there is no legitimate reason for a post to inline base64.
 *   • Text is escaped, with ONE exception: a well-formed HTML entity
 *     (`&mdash;`, `&#8212;`) is passed through rather than double-escaped,
 *     because the existing post writes `&ldquo;`/`&mdash;` in its prose and
 *     escaping those would render the literal characters `&mdash;` to readers.
 *     Entities cannot express markup, so this is safe; `<` and `>` are always
 *     escaped.
 *   • Tag nesting is balanced by a stack. A raw block that forgets its
 *     `</div>` gets one appended rather than swallowing the rest of the page.
 *
 * ── What it supports ────────────────────────────────────────────────────────
 * ATX headings `#`–`######` (with slug `id`s, so the TOC can link to them),
 * paragraphs, `**bold**`, `*italic*`, `***both***`, `~~strike~~`, `` `code` ``,
 * fenced code blocks (``` and ~~~, with a language class), `[text](url)`,
 * `![alt](src)`, unordered and ordered lists including nesting, blockquotes,
 * `---` thematic breaks, GFM pipe tables with alignment, hard line breaks
 * (two trailing spaces), backslash escapes, and raw HTML — block-level and
 * inline — subject to the contract above.
 *
 * ── What it deliberately refuses ────────────────────────────────────────────
 * Setext headings (`===` under a line) — `#` is unambiguous and the existing
 * post never used them. Reference-style links and footnotes — nobody has
 * asked, and each is a second pass over the document. Indented (4-space) code
 * blocks — they collide with list continuation lines far more often than
 * anyone writes them on purpose; use a fence. Inline `style` and `<style>` —
 * see reason 2 above. `id` on author HTML — see `GLOBAL_ATTRS`. Media embeds
 * (`<iframe>`, `<video>`, `<audio>`) — an embed is a third-party script on our
 * page; when a post genuinely needs one, add the specific provider here as a
 * named, attribute-locked case rather than opening the tag.
 */

import { blogSlugFromTitle } from "./marketingBlog";

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/** One heading, for the table of contents. `text` is the heading's plain text
 *  (inline markup stripped) and MAY contain HTML entities — escape it the same
 *  entity-preserving way this module does, or write it into a text node. `id`
 *  is already safe to use verbatim in `href="#…"`. */
export interface BlogHeading {
  /** 1–6, matching `#`–`######`. The Astro layout showed `h2`s only; the
   *  caller filters, because a post that grows sub-sections should be able to
   *  show them without a change here. */
  depth: number;
  text: string;
  id: string;
}

/** Render a post's markdown body to HTML. Total function: any input produces
 *  a string, and no input produces script. */
export function renderBlogMarkdown(markdown: string): string {
  const blocks = parseDocument(markdown);
  assignHeadingIds(blocks);
  return renderBlocks(blocks, true);
}

/**
 * Every ATX heading in the post, in document order, with the SAME `id` the
 * rendered HTML gives it — the two walk one parser, so a TOC link can never
 * point at an anchor the page doesn't have.
 *
 * Headings inside fenced code are not headings (a `# comment` in a shell
 * snippet is not a section) and are excluded. Headings written as raw HTML
 * (`<h2>`) are also excluded: they carry no `id` in the output either, so
 * including them would produce exactly the broken anchors this shares a
 * parser to prevent.
 */
export function extractHeadings(markdown: string): BlogHeading[] {
  const blocks = parseDocument(markdown);
  assignHeadingIds(blocks);
  const found: BlogHeading[] = [];
  walkHeadings(blocks, (h) => {
    found.push({ depth: h.depth, text: inlinePlainText(h.text), id: h.id });
  });
  return found;
}

/**
 * The sanitizer, exported so it can be tested directly and so a future caller
 * with already-HTML content (an imported post, say) can reuse the same
 * judgment instead of writing a second one. `renderBlogMarkdown` runs every
 * raw-HTML block through this.
 */
export function sanitizeBlogHtml(html: string): string {
  return sanitizeFragment(html);
}

// ─────────────────────────────────────────────────────────────────────────────
// Escaping
// ─────────────────────────────────────────────────────────────────────────────

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
};

/** A well-formed HTML entity reference: named, decimal, or hex. */
const ENTITY_SOURCE =
  "&(?:[a-zA-Z][a-zA-Z0-9]{1,31}|#\\d{1,7}|#[xX][0-9a-fA-F]{1,6});";

/** Escape prose. Entities survive (see the module doc's "Text is escaped, with
 *  ONE exception"); everything that could open a tag does not. The entity
 *  alternative is FIRST so it wins the match. `"` is NOT escaped here — a
 *  quotation mark in a text node cannot escape anything, and the one real post
 *  is full of them; `escapeAttr` is the one that has to care. */
function escapeText(s: string): string {
  return s.replace(
    new RegExp(`${ENTITY_SOURCE}|[&<>]`, "g"),
    (m) => (m.length > 1 ? m : ESCAPES[m]),
  );
}

/** Escape an attribute VALUE. Same entity exception (a `&amp;` in a query
 *  string must stay one), plus `"` — which is what actually keeps a value
 *  inside its quotes. */
function escapeAttr(s: string): string {
  return s.replace(
    new RegExp(`${ENTITY_SOURCE}|[&<>"]`, "g"),
    (m) => (m.length > 1 ? m : ESCAPES[m]),
  );
}

/** Escape code. No entity exception — inside a code span or a fence, `&amp;`
 *  is four characters the author typed and must be shown as four characters,
 *  which is also what CommonMark says. */
function escapeStrict(s: string): string {
  return s.replace(/[&<>"]/g, (m) => ESCAPES[m]);
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  colon: ":",
  sol: "/",
  tab: "\t",
  newline: "\n",
  nbsp: " ",
};

/**
 * Decode entities well enough to JUDGE a URL — not to display one.
 *
 * Only the entities that can smuggle a scheme past a naive check are handled
 * (`&#106;`, `&colon;`, `&Tab;`, `&NewLine;`). This is deliberately a probe:
 * its output is never emitted, only inspected by `isSafeUrl`, so an entity it
 * fails to decode makes the check STRICTER (an undecoded `&…;` is not a valid
 * scheme character and the URL still reads as relative or is rejected), never
 * looser.
 */
function decodeForUrlProbe(url: string): string {
  return url.replace(
    new RegExp(ENTITY_SOURCE, "g"),
    (m) => {
      const body = m.slice(1, -1);
      if (body[0] === "#") {
        const code =
          body[1] === "x" || body[1] === "X"
            ? parseInt(body.slice(2), 16)
            : parseInt(body.slice(1), 10);
        return Number.isFinite(code) && code >= 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : m;
      }
      return NAMED_ENTITIES[body.toLowerCase()] ?? m;
    },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// URL safety
// ─────────────────────────────────────────────────────────────────────────────

const ALLOWED_SCHEMES = new Set(["http", "https", "mailto", "tel"]);

/**
 * Whether a URL may be emitted into an `href`/`src`.
 *
 * Order matters and is the whole point: DECODE entities, then STRIP every
 * control character and space, and only THEN look for a scheme. A browser
 * does all three before dispatching, so a check that runs in any other order
 * is checking a string no browser will ever see —
 * `&#106;avascript&colon;alert(1)` and `java\tscript:alert(1)` are the two
 * shapes that get past every naive `startsWith("javascript:")`.
 *
 * A URL with no scheme (`/blog/x`, `#anchor`, `image.png`) is relative and
 * fine. A protocol-relative `//host/x` is NOT: it inherits the page's scheme
 * and is a third-party reference wearing a relative URL's clothes — the same
 * finding `emailHtmlSanitize.ts` records.
 */
function isSafeUrl(raw: string): boolean {
  const probe = decodeForUrlProbe(raw)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0020\u007f\u00a0\u2028\u2029]+/g, "")
    .toLowerCase();
  if (probe === "") return false;
  if (probe.startsWith("//")) return false;
  const colon = probe.indexOf(":");
  if (colon === -1) return true; // relative
  const firstPathish = probe.search(/[/?#]/);
  // A colon AFTER the first `/`, `?` or `#` is inside a path or query
  // (`/a/b:c`), not a scheme.
  if (firstPathish !== -1 && firstPathish < colon) return true;
  const scheme = probe.slice(0, colon);
  if (!/^[a-z][a-z0-9+.-]*$/.test(scheme)) return false;
  return ALLOWED_SCHEMES.has(scheme);
}

// ─────────────────────────────────────────────────────────────────────────────
// The HTML allowlist
// ─────────────────────────────────────────────────────────────────────────────

/** Tags a post may use. Structural, textual, and tabular markup only — see
 *  the module doc for why no media embeds and no `<style>`. */
const ALLOWED_TAGS = new Set([
  "p", "br", "hr", "div", "span", "section", "article", "aside",
  "figure", "figcaption", "header", "footer", "main", "nav",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "ul", "ol", "li", "dl", "dt", "dd",
  "blockquote", "pre", "code", "kbd", "samp", "var",
  "strong", "b", "em", "i", "u", "s", "del", "ins", "mark", "small",
  "sub", "sup", "abbr", "cite", "q", "time", "ruby", "rt", "rp", "bdi", "bdo",
  "a", "img",
  "table", "caption", "colgroup", "col", "thead", "tbody", "tfoot",
  "tr", "th", "td",
  "details", "summary",
]);

/** Tags whose CONTENT is discarded along with the tag. A stripped `<script>`
 *  must not leave its body on the page as visible text (and definitely not as
 *  escaped markup something downstream might unescape) — the same
 *  `disallowedTagsMode: "discard"` posture `emailHtmlSanitize.ts` takes. */
const DROP_WITH_CONTENT = new Set([
  "script", "style", "iframe", "object", "embed", "noscript", "template",
  "form", "input", "button", "select", "option", "optgroup", "textarea",
  "label", "fieldset", "legend", "svg", "math", "canvas", "audio", "video",
  "source", "track", "map", "area", "applet", "frame", "frameset", "base",
  "link", "meta", "title", "xmp", "plaintext", "listing", "marquee",
  "dialog", "portal", "slot", "param",
]);

/** Tags with no closing half — never pushed onto the balance stack. */
const VOID_TAGS = new Set(["br", "hr", "img", "col", "wbr"]);

/**
 * Attributes any allowed tag may carry.
 *
 * `id` is NOT here, on purpose, and this is the one exclusion worth defending:
 * this renderer MINTS `id`s for every heading so the table of contents can
 * link to them, and the page around it has ids of its own. An author-supplied
 * `id` can collide with either — silently redirecting a TOC link, or letting a
 * post's markup be targeted by page CSS meant for chrome. `emailHtmlSanitize`
 * excludes `id` for the same class of reason. `class` IS allowed, because the
 * site's own stylesheet is how a post styles anything (`pw-scroll`,
 * `pw-note`) and that is exactly the mechanism this keeps instead of `style`.
 */
const GLOBAL_ATTRS = new Set(["class", "title", "lang", "dir", "role"]);

/** Per-tag additions. Every entry here is either semantic or layout-neutral;
 *  nothing takes a URL that `URL_ATTRS` doesn't also cover. */
const TAG_ATTRS: Record<string, string[]> = {
  a: ["href", "target", "rel", "name", "download"],
  img: ["src", "alt", "width", "height", "loading", "decoding", "srcset", "sizes"],
  ol: ["start", "reversed", "type"],
  li: ["value"],
  td: ["colspan", "rowspan", "headers", "align", "valign"],
  th: ["colspan", "rowspan", "headers", "scope", "align", "valign"],
  col: ["span", "width"],
  colgroup: ["span"],
  table: ["align"],
  time: ["datetime"],
  details: ["open"],
  blockquote: ["cite"],
  q: ["cite"],
  del: ["cite", "datetime"],
  ins: ["cite", "datetime"],
  bdo: ["dir"],
};

/** Attributes whose value is a URL and therefore goes through `isSafeUrl`. */
const URL_ATTRS = new Set(["href", "src", "cite", "srcset", "download"]);

// ─────────────────────────────────────────────────────────────────────────────
// Tag scanning
// ─────────────────────────────────────────────────────────────────────────────

type ParsedTag =
  | { type: "skip"; end: number }
  | {
      type: "tag";
      name: string;
      closing: boolean;
      selfClosing: boolean;
      attrs: Array<[string, string | null]>;
      end: number;
    };

/**
 * Parse one `<…>` starting at `start`, or return null if what's there is not a
 * tag at all (a bare `<` in prose, an unterminated tag running off the end).
 *
 * Hand-written rather than regex: attribute values can contain `>` inside
 * quotes, which is the exact case a `/<[^>]*>/` gets wrong and an attacker
 * reaches for first.
 */
function parseTagAt(s: string, start: number): ParsedTag | null {
  if (s[start] !== "<") return null;
  if (s.startsWith("<!--", start)) {
    const end = s.indexOf("-->", start + 4);
    return { type: "skip", end: end === -1 ? s.length : end + 3 };
  }
  if (s.startsWith("<!", start) || s.startsWith("<?", start)) {
    const end = s.indexOf(">", start);
    return { type: "skip", end: end === -1 ? s.length : end + 1 };
  }

  let i = start + 1;
  let closing = false;
  if (s[i] === "/") {
    closing = true;
    i++;
  }
  const nameStart = i;
  if (!/[a-zA-Z]/.test(s[i] ?? "")) return null;
  // Hyphens are part of the NAME (custom elements are `<my-thing>`) — reading
  // them as the start of an attribute would make `<marquee-ish>` parse as a
  // `<marquee>`, which is a real tag with real behavior.
  while (i < s.length && /[a-zA-Z0-9-]/.test(s[i])) i++;
  const name = s.slice(nameStart, i).toLowerCase();

  const attrs: Array<[string, string | null]> = [];
  let selfClosing = false;
  let terminated = false;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;
    if (s[i] === ">") {
      i++;
      terminated = true;
      break;
    }
    if (s[i] === "/" && s[i + 1] === ">") {
      selfClosing = true;
      i += 2;
      terminated = true;
      break;
    }
    if (s[i] === "/" || s[i] === "=") {
      // A stray `/` or a value with no name — skip the character rather than
      // abandoning the tag, so `<br/ >` and `<a =x href="…">` still parse.
      i++;
      continue;
    }
    const attrStart = i;
    while (i < s.length && !/[\s=>/]/.test(s[i])) i++;
    const attrName = s.slice(attrStart, i).toLowerCase();
    while (i < s.length && /\s/.test(s[i])) i++;
    let value: string | null = null;
    if (s[i] === "=") {
      i++;
      while (i < s.length && /\s/.test(s[i])) i++;
      const quote = s[i];
      if (quote === '"' || quote === "'") {
        const end = s.indexOf(quote, i + 1);
        if (end === -1) return null; // unterminated quoted value → not a tag
        value = s.slice(i + 1, end);
        i = end + 1;
      } else {
        const valueStart = i;
        while (i < s.length && !/[\s>]/.test(s[i])) i++;
        value = s.slice(valueStart, i);
      }
    }
    if (attrName) attrs.push([attrName, value]);
  }
  if (!terminated) return null;
  return { type: "tag", name, closing, selfClosing, attrs, end: i };
}

/** Everything from `from` up to and including the matching `</name>`, skipped.
 *  A tag that never closes swallows the rest of the fragment — the safe
 *  direction, since the alternative is emitting a `<script>` body as text. */
function skipToClose(s: string, from: number, name: string): number {
  const needle = `</${name}`;
  const lower = s.toLowerCase();
  const at = lower.indexOf(needle, from);
  if (at === -1) return s.length;
  const gt = s.indexOf(">", at);
  return gt === -1 ? s.length : gt + 1;
}

/** Serialize an allowed opening tag, keeping only allowed attributes with
 *  values that survive their own check. */
function renderOpenTag(tag: Extract<ParsedTag, { type: "tag" }>): string {
  const allowed = TAG_ATTRS[tag.name] ?? [];
  const parts: string[] = [tag.name];
  let sawTarget = false;
  let rel: string | null = null;

  for (const [name, rawValue] of tag.attrs) {
    // Redundant with the allowlist below — kept so that widening
    // `GLOBAL_ATTRS`/`TAG_ATTRS` later can never re-admit a handler by
    // accident. A handler attribute is the one thing that must fail twice.
    if (name.startsWith("on")) continue;
    if (!GLOBAL_ATTRS.has(name) && !allowed.includes(name)) continue;
    const value = rawValue ?? "";
    if (URL_ATTRS.has(name)) {
      // `srcset` is a comma-separated candidate list; every candidate has to
      // clear the same bar, and one bad candidate voids the attribute.
      const candidates =
        name === "srcset"
          ? value.split(",").map((c) => c.trim().split(/\s+/)[0] ?? "")
          : [value];
      if (candidates.some((c) => !isSafeUrl(c))) continue;
    }
    if (name === "target") sawTarget = true;
    if (name === "rel") rel = value;
    if (rawValue === null) {
      parts.push(name);
    } else {
      parts.push(`${name}="${escapeAttr(value)}"`);
    }
  }

  // `target="_blank"` without `rel="noopener"` hands the opened tab a
  // `window.opener` reference back to the post. Modern browsers imply it, old
  // ones do not, and the fix costs one attribute.
  if (tag.name === "a" && sawTarget) {
    const needed = ["noopener", "noreferrer"];
    const have = new Set((rel ?? "").toLowerCase().split(/\s+/).filter(Boolean));
    const missing = needed.filter((n) => !have.has(n));
    if (missing.length > 0) {
      const merged = [...have, ...missing].join(" ");
      const at = parts.findIndex((p) => p === "rel" || p.startsWith("rel="));
      if (at === -1) parts.push(`rel="${merged}"`);
      else parts[at] = `rel="${merged}"`;
    }
  }

  return VOID_TAGS.has(tag.name)
    ? `<${parts.join(" ")} />`
    : `<${parts.join(" ")}>`;
}

/**
 * Sanitize a raw HTML fragment: allowlist the tags, allowlist their
 * attributes, escape everything else, and keep the nesting balanced.
 *
 * The balance stack is what stops a post that forgets a `</div>` from
 * swallowing the page furniture below it. It closes greedily on a stray close
 * tag (closing anything still open above the match) rather than trying to
 * repair misnesting — the output is then always well-formed, which is the
 * property the page actually needs.
 */
function sanitizeFragment(html: string): string {
  let out = "";
  const open: string[] = [];
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      out += escapeText(html.slice(i));
      break;
    }
    out += escapeText(html.slice(i, lt));
    const tag = parseTagAt(html, lt);
    if (!tag) {
      out += "&lt;";
      i = lt + 1;
      continue;
    }
    if (tag.type === "skip") {
      i = tag.end;
      continue;
    }
    if (DROP_WITH_CONTENT.has(tag.name)) {
      i = tag.closing ? tag.end : skipToClose(html, tag.end, tag.name);
      continue;
    }
    if (!ALLOWED_TAGS.has(tag.name)) {
      // Drop the tag, keep the words inside it.
      i = tag.end;
      continue;
    }
    if (tag.closing) {
      const at = open.lastIndexOf(tag.name);
      if (at !== -1) while (open.length > at) out += `</${open.pop()}>`;
      i = tag.end;
      continue;
    }
    out += renderOpenTag(tag);
    if (!VOID_TAGS.has(tag.name) && !tag.selfClosing) open.push(tag.name);
    i = tag.end;
  }
  while (open.length > 0) out += `</${open.pop()}>`;
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Block parsing
// ─────────────────────────────────────────────────────────────────────────────

type Align = "left" | "center" | "right" | null;

type Block =
  | { kind: "heading"; depth: number; text: string; id: string }
  | { kind: "paragraph"; text: string }
  | { kind: "code"; lang: string | null; code: string }
  | { kind: "html"; html: string }
  | { kind: "rule" }
  | { kind: "quote"; children: Block[] }
  | {
      kind: "list";
      ordered: boolean;
      start: number;
      tight: boolean;
      items: Block[][];
    }
  | { kind: "table"; head: string[]; aligns: Align[]; rows: string[][] };

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^`\r\n]*?)[ \t]*$/;
const HEADING_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*(?:[ \t]#+)?[ \t]*$/;
const RULE_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE_RE = /^ {0,3}>[ \t]?/;
const BULLET_RE = /^([ ]*)([-*+])([ ]+|$)(.*)$/;
const ORDERED_RE = /^([ ]*)(\d{1,9})([.)])([ ]+|$)(.*)$/;
const TABLE_DELIM_RE =
  /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

/** Sentinel for a hard line break (two trailing spaces). Chosen because NUL is
 *  stripped from the input first, so it can never come from the author. */
const HARD_BREAK = "\u0000";

/** Block-level tag names that make a line start a raw HTML block. Broader than
 *  `ALLOWED_TAGS` on purpose — `<script>` has to be RECOGNIZED as a block so
 *  the sanitizer gets a chance to discard it, rather than being parsed as
 *  paragraph text and escaped into visible junk. */
const HTML_BLOCK_TAGS = new Set([
  ...ALLOWED_TAGS,
  ...DROP_WITH_CONTENT,
  "html", "head", "body", "center", "font", "menu", "picture", "address",
]);

function expandTabs(line: string): string {
  let out = "";
  for (const ch of line) {
    if (ch === "\t") out += " ".repeat(4 - (out.length % 4));
    else out += ch;
  }
  return out;
}

function leadingSpaces(line: string): number {
  let n = 0;
  while (line[n] === " ") n++;
  return n;
}

interface ItemMatch {
  ordered: boolean;
  number: number;
  indent: number;
  contentIndent: number;
  rest: string;
}

function matchItem(line: string): ItemMatch | null {
  const bullet = BULLET_RE.exec(line);
  if (bullet) {
    const indent = bullet[1].length;
    const gap = bullet[3].length || 1;
    return {
      ordered: false,
      number: 1,
      indent,
      contentIndent: indent + 1 + gap,
      rest: bullet[4],
    };
  }
  const ordered = ORDERED_RE.exec(line);
  if (ordered) {
    const indent = ordered[1].length;
    const gap = ordered[4].length || 1;
    return {
      ordered: true,
      number: parseInt(ordered[2], 10),
      indent,
      contentIndent: indent + ordered[2].length + 1 + gap,
      rest: ordered[5],
    };
  }
  return null;
}

function htmlBlockTagOf(line: string): string | null {
  if (/^ {0,3}<!--/.test(line)) return "!--";
  const m = /^ {0,3}<\/?([a-zA-Z][a-zA-Z0-9-]*)/.exec(line);
  if (!m) return null;
  const name = m[1].toLowerCase();
  return HTML_BLOCK_TAGS.has(name) ? name : null;
}

/**
 * Whether this line begins a block that a paragraph or a list item cannot
 * absorb as a continuation line.
 *
 * A list marker counts — otherwise `- a` followed by an indented `- a1` never
 * nests, because the item's own paragraph swallows the child list. An ORDERED
 * marker only counts when it is `1.`, which is CommonMark's rule and exists
 * for a good reason: prose wraps onto a line beginning "2020. The year we…"
 * far more often than anyone starts a list at 2.
 */
function startsNewBlock(line: string): boolean {
  const item = matchItem(line);
  if (item && (!item.ordered || item.number === 1)) return true;
  return (
    FENCE_RE.test(line) ||
    RULE_RE.test(line) ||
    HEADING_RE.test(line) ||
    QUOTE_RE.test(line) ||
    htmlBlockTagOf(line) !== null
  );
}

/**
 * Split the raw body into lines, dropping a leading YAML frontmatter block.
 *
 * The frontmatter guard exists because posts are MIGRATING from
 * `apps/landing/src/content/blog/*.md`, and the obvious way for an editor to
 * start a new post is to paste an old file in — frontmatter and all. Rendering
 * `title: "…"` as the post's first paragraph is a worse failure than the
 * vanishingly rare post that genuinely opens with a thematic break.
 */
function toLines(markdown: string): string[] {
  const lines = markdown
    .replace(/\u0000/g, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map(expandTabs);
  if (lines[0]?.trim() === "---") {
    const close = lines.findIndex((l, idx) => idx > 0 && l.trim() === "---");
    if (close > 0) return lines.slice(close + 1);
  }
  return lines;
}

function parseDocument(markdown: string): Block[] {
  return parseBlocks(toLines(markdown));
}

function parseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Fenced code — first, because everything inside a fence is literal.
    const fence = FENCE_RE.exec(line);
    if (fence) {
      const marker = fence[1];
      const lang = fence[2].trim() || null;
      const body: string[] = [];
      i++;
      while (i < lines.length) {
        const closer = FENCE_RE.exec(lines[i]);
        if (
          closer &&
          closer[1][0] === marker[0] &&
          closer[1].length >= marker.length &&
          closer[2].trim() === ""
        ) {
          i++;
          break;
        }
        body.push(lines[i]);
        i++;
      }
      blocks.push({ kind: "code", lang, code: body.join("\n") });
      continue;
    }

    if (RULE_RE.test(line)) {
      blocks.push({ kind: "rule" });
      i++;
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      blocks.push({
        kind: "heading",
        depth: heading[1].length,
        text: (heading[2] ?? "").trim(),
        id: "",
      });
      i++;
      continue;
    }

    // Raw HTML block. CommonMark's "type 6" rule: it runs to the next blank
    // line. The one real post's `<div class="pw-scroll">…</div>` table and its
    // `<div class="pw-note">` callout are both written that way, and the rule
    // has the useful property that a post can NEVER accidentally put the rest
    // of the document inside a raw block.
    if (htmlBlockTagOf(line) !== null) {
      const body: string[] = [];
      while (i < lines.length && lines[i].trim() !== "") {
        body.push(lines[i]);
        i++;
      }
      blocks.push({ kind: "html", html: body.join("\n") });
      continue;
    }

    if (QUOTE_RE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && QUOTE_RE.test(lines[i])) {
        inner.push(lines[i].replace(QUOTE_RE, ""));
        i++;
      }
      blocks.push({ kind: "quote", children: parseBlocks(inner) });
      continue;
    }

    if (matchItem(line)) {
      const parsed = parseList(lines, i);
      blocks.push(parsed.block);
      i = parsed.next;
      continue;
    }

    if (
      i + 1 < lines.length &&
      line.includes("|") &&
      TABLE_DELIM_RE.test(lines[i + 1]) &&
      lines[i + 1].includes("-")
    ) {
      const parsed = parseTable(lines, i);
      if (parsed) {
        blocks.push(parsed.block);
        i = parsed.next;
        continue;
      }
    }

    // Paragraph: everything up to a blank line or the start of another block.
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() !== "" && !(para.length > 0 && startsNewBlock(lines[i]))) {
      para.push(/ {2,}$/.test(lines[i]) ? `${lines[i].trimEnd()}${HARD_BREAK}` : lines[i].trim());
      i++;
    }
    blocks.push({ kind: "paragraph", text: para.join("\n") });
  }

  return blocks;
}

/**
 * One list, with nesting.
 *
 * The rule that makes nesting work without a second pass: a line whose indent
 * is at least the CURRENT item's content indent belongs to that item, dedented
 * by exactly that much — so a nested `  - b` under `- a` arrives at the
 * recursive `parseBlocks` as a plain `- b` and becomes a list on its own.
 * Anything shallower that still looks like an item is a sibling; anything
 * shallower that doesn't is either a lazy continuation of the item's paragraph
 * or, if a blank line came first, the end of the list.
 */
function parseList(lines: string[], start: number): { block: Block; next: number } {
  const first = matchItem(lines[start])!;
  const ordered = first.ordered;
  const items: Block[][] = [];
  const rawItems: string[][] = [];
  let current: string[] = [first.rest];
  rawItems.push(current);
  let contentIndent = first.contentIndent;
  let tight = true;
  let pendingBlank = false;
  let i = start + 1;

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      pendingBlank = true;
      i++;
      continue;
    }
    const indent = leadingSpaces(line);
    const item = matchItem(line);

    if (item && indent < contentIndent) {
      // A sibling — unless the marker flipped kind, which starts a new list.
      if (item.ordered !== ordered) break;
      if (pendingBlank) tight = false;
      current = [item.rest];
      rawItems.push(current);
      contentIndent = item.contentIndent;
      pendingBlank = false;
      i++;
      continue;
    }

    if (indent >= contentIndent) {
      if (pendingBlank) {
        tight = false;
        current.push("");
      }
      current.push(line.slice(contentIndent));
      pendingBlank = false;
      i++;
      continue;
    }

    // Shallower than the item's content and not a marker.
    if (pendingBlank) break;
    if (startsNewBlock(line)) break;
    current.push(line.trim()); // lazy paragraph continuation
    i++;
  }

  for (const raw of rawItems) items.push(parseBlocks(raw));
  return {
    block: {
      kind: "list",
      ordered,
      start: ordered ? first.number : 1,
      tight,
      items,
    },
    next: i,
  };
}

/** Split a table row on unescaped pipes, dropping the outer ones. */
function splitRow(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "\\" && line[i + 1] === "|") {
      cell += "|";
      i++;
      continue;
    }
    if (ch === "|") {
      cells.push(cell);
      cell = "";
      continue;
    }
    cell += ch;
  }
  cells.push(cell);
  if (cells.length > 0 && cells[0].trim() === "") cells.shift();
  if (cells.length > 0 && cells[cells.length - 1].trim() === "") cells.pop();
  return cells.map((c) => c.trim());
}

function parseTable(
  lines: string[],
  start: number,
): { block: Block; next: number } | null {
  const head = splitRow(lines[start]);
  const delim = splitRow(lines[start + 1]);
  // A delimiter row that doesn't line up with the header isn't a table — it's
  // a paragraph that happens to contain pipes and dashes.
  if (head.length === 0 || head.length !== delim.length) return null;
  const aligns: Align[] = delim.map((d) => {
    const left = d.startsWith(":");
    const right = d.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    if (left) return "left";
    return null;
  });
  const rows: string[][] = [];
  let i = start + 2;
  while (i < lines.length && lines[i].trim() !== "" && lines[i].includes("|")) {
    const cells = splitRow(lines[i]);
    while (cells.length < head.length) cells.push("");
    rows.push(cells.slice(0, head.length));
    i++;
  }
  return { block: { kind: "table", head, aligns, rows }, next: i };
}

// ─────────────────────────────────────────────────────────────────────────────
// Heading ids
// ─────────────────────────────────────────────────────────────────────────────

function walkHeadings(
  blocks: Block[],
  visit: (h: Extract<Block, { kind: "heading" }>) => void,
): void {
  for (const block of blocks) {
    if (block.kind === "heading") visit(block);
    else if (block.kind === "quote") walkHeadings(block.children, visit);
    else if (block.kind === "list") {
      for (const item of block.items) walkHeadings(item, visit);
    }
  }
}

/** Stamp every heading with its anchor id, in document order. Collisions get
 *  `-2`, `-3` … — two sections can honestly share a title ("The test") and the
 *  TOC still has to be able to point at each. */
function assignHeadingIds(blocks: Block[]): void {
  const used = new Map<string, number>();
  let n = 0;
  walkHeadings(blocks, (heading) => {
    n++;
    const base = blogSlugFromTitle(inlinePlainText(heading.text)) || `section-${n}`;
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    heading.id = seen === 0 ? base : `${base}-${seen + 1}`;
  });
}

/** A heading's text with inline markup removed, for the TOC label and the
 *  slug. Entities are left alone — see `BlogHeading.text`. */
function inlinePlainText(src: string): string {
  return src
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]*>/g, "")
    .replace(/[*_~]{1,3}/g, "")
    .replace(/\\([\\`*_{}[\]()#+\-.!>~|])/g, "$1")
    .replace(new RegExp(HARD_BREAK, "g"), " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Rendering
// ─────────────────────────────────────────────────────────────────────────────

function renderBlocks(blocks: Block[], separate: boolean): string {
  const out = blocks.map(renderBlock).filter((s) => s !== "");
  return out.join(separate ? "\n" : "");
}

function renderBlock(block: Block): string {
  switch (block.kind) {
    case "heading":
      return `<h${block.depth} id="${escapeAttr(block.id)}">${renderInline(block.text)}</h${block.depth}>`;
    case "paragraph": {
      const html = renderInline(block.text);
      return html.trim() === "" ? "" : `<p>${html}</p>`;
    }
    case "code": {
      // The language is a CSS class, not markup — restrict it to what a class
      // name can be rather than escaping whatever arrives.
      const lang = block.lang?.match(/^[a-zA-Z0-9_+#-]{1,32}/)?.[0] ?? null;
      const attr = lang ? ` class="language-${lang}"` : "";
      return `<pre><code${attr}>${escapeStrict(block.code)}</code></pre>`;
    }
    case "html":
      return sanitizeFragment(block.html);
    case "rule":
      return "<hr />";
    case "quote":
      return `<blockquote>${renderBlocks(block.children, true)}</blockquote>`;
    case "list": {
      const tag = block.ordered ? "ol" : "ul";
      const startAttr =
        block.ordered && block.start !== 1 ? ` start="${block.start}"` : "";
      const items = block.items
        .map((item) => `<li>${renderItem(item, block.tight)}</li>`)
        .join("");
      return `<${tag}${startAttr}>${items}</${tag}>`;
    }
    case "table": {
      const head = block.head
        .map((c, idx) => `<th${alignAttr(block.aligns[idx])}>${renderInline(c)}</th>`)
        .join("");
      const body = block.rows
        .map(
          (row) =>
            `<tr>${row
              .map((c, idx) => `<td${alignAttr(block.aligns[idx])}>${renderInline(c)}</td>`)
              .join("")}</tr>`,
        )
        .join("");
      return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
    }
  }
}

function alignAttr(align: Align): string {
  return align ? ` style="text-align:${align}"` : "";
}

/** A list item's contents. In a TIGHT list the item's own paragraphs are
 *  unwrapped — that is what tight means, and a `<p>` inside every `<li>` is
 *  what makes a plain bulleted list render with paragraph spacing. */
function renderItem(blocks: Block[], tight: boolean): string {
  if (!tight) return renderBlocks(blocks, false);
  return blocks
    .map((b) => (b.kind === "paragraph" ? renderInline(b.text) : renderBlock(b)))
    .filter((s) => s !== "")
    .join("");
}

// ─────────────────────────────────────────────────────────────────────────────
// Inline rendering
// ─────────────────────────────────────────────────────────────────────────────

const ESCAPABLE = /[\\`*_{}[\]()#+\-.!>~|<>&"]/;

/**
 * Render one run of inline markdown.
 *
 * A single left-to-right scan rather than a delimiter-run stack (CommonMark's
 * algorithm): the cases that need the full stack are pathological
 * (`*a **b* c**`), and the scan is auditable line by line — which matters more
 * here than spec conformance, because the `<` branch is a security boundary.
 */
function renderInline(src: string): string {
  let out = "";
  let i = 0;

  while (i < src.length) {
    const ch = src[i];

    if (ch === HARD_BREAK) {
      out += "<br />";
      i++;
      continue;
    }

    if (ch === "\\" && i + 1 < src.length && ESCAPABLE.test(src[i + 1])) {
      out += escapeStrict(src[i + 1]);
      i += 2;
      continue;
    }

    if (ch === "`") {
      const run = runLength(src, i, "`");
      const close = findBacktickRun(src, i + run, run);
      if (close !== -1) {
        let code = src.slice(i + run, close);
        if (code.length > 2 && code.startsWith(" ") && code.endsWith(" ")) {
          code = code.slice(1, -1);
        }
        out += `<code>${escapeStrict(code.replace(/\n/g, " "))}</code>`;
        i = close + run;
        continue;
      }
      out += escapeStrict(src.slice(i, i + run));
      i += run;
      continue;
    }

    if (ch === "<") {
      const tag = parseTagAt(src, i);
      if (!tag) {
        out += "&lt;";
        i++;
        continue;
      }
      if (tag.type === "skip") {
        i = tag.end;
        continue;
      }
      if (DROP_WITH_CONTENT.has(tag.name)) {
        i = tag.closing ? tag.end : skipToClose(src, tag.end, tag.name);
        continue;
      }
      if (!ALLOWED_TAGS.has(tag.name)) {
        i = tag.end;
        continue;
      }
      // No balance stack inline — the block sanitizer owns that, and an
      // inline `<em>` that spans a paragraph boundary is the author's
      // problem, not a security one.
      out += tag.closing ? `</${tag.name}>` : renderOpenTag(tag);
      i = tag.end;
      continue;
    }

    if (ch === "!" && src[i + 1] === "[") {
      const link = parseLinkAt(src, i + 1);
      if (link) {
        const src_ = isSafeUrl(link.dest) ? link.dest : "";
        if (src_ === "") {
          // An image whose source we refuse still has its alt text, which is
          // the words the author wrote — keep them rather than a hole.
          out += escapeText(inlinePlainText(link.label));
        } else {
          const title = link.title ? ` title="${escapeAttr(link.title)}"` : "";
          out += `<img src="${escapeAttr(src_)}" alt="${escapeAttr(inlinePlainText(link.label))}"${title} loading="lazy" />`;
        }
        i = link.end;
        continue;
      }
    }

    if (ch === "[") {
      const link = parseLinkAt(src, i);
      if (link) {
        const inner = renderInline(link.label);
        if (isSafeUrl(link.dest)) {
          const title = link.title ? ` title="${escapeAttr(link.title)}"` : "";
          out += `<a href="${escapeAttr(link.dest)}"${title}>${inner}</a>`;
        } else {
          // A refused destination drops the anchor, never the sentence.
          out += inner;
        }
        i = link.end;
        continue;
      }
    }

    if (ch === "~" && src[i + 1] === "~") {
      const close = findDelimiter(src, i + 2, "~", 2);
      if (close !== -1) {
        out += `<del>${renderInline(src.slice(i + 2, close))}</del>`;
        i = close + 2;
        continue;
      }
    }

    if (ch === "*" || ch === "_") {
      const emphasis = parseEmphasisAt(src, i, ch);
      if (emphasis) {
        out += emphasis.html;
        i = emphasis.end;
        continue;
      }
    }

    if (ch === "&") {
      const entity = new RegExp(`^${ENTITY_SOURCE}`).exec(src.slice(i));
      if (entity) {
        out += entity[0];
        i += entity[0].length;
        continue;
      }
      out += "&amp;";
      i++;
      continue;
    }

    // Not `ESCAPES[ch]` — `"` is deliberately absent from text escaping (see
    // `escapeText`), and `&` was handled above.
    out += ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch;
    i++;
  }

  return out;
}

function runLength(src: string, at: number, ch: string): number {
  let n = 0;
  while (src[at + n] === ch) n++;
  return n;
}

/** The next run of EXACTLY `n` backticks at or after `from`. */
function findBacktickRun(src: string, from: number, n: number): number {
  let i = from;
  while (i < src.length) {
    if (src[i] === "`") {
      const run = runLength(src, i, "`");
      if (run === n) return i;
      i += run;
      continue;
    }
    i++;
  }
  return -1;
}

/** The next run of at least `n` copies of `ch` whose left neighbour is not
 *  whitespace — a closing delimiter has to hug the text it closes. */
function findDelimiter(src: string, from: number, ch: string, n: number): number {
  let i = from;
  while (i < src.length) {
    if (src[i] === "\\") {
      i += 2;
      continue;
    }
    if (src[i] === ch) {
      const run = runLength(src, i, ch);
      if (run >= n && i > from && !/\s/.test(src[i - 1])) return i;
      i += run;
      continue;
    }
    i++;
  }
  return -1;
}

/**
 * `*`/`**`/`***` (and the `_` spellings) starting at `at`, or null if this
 * delimiter never closes and is therefore literal punctuation.
 *
 * `_` additionally has to sit on a word boundary: `snake_case_names` and
 * `__init__` appear in this org's own writing about code, and treating them as
 * emphasis mangles them. `*` has no such rule, which is why it is the spelling
 * to prefer.
 */
function parseEmphasisAt(
  src: string,
  at: number,
  ch: string,
): { html: string; end: number } | null {
  const run = Math.min(runLength(src, at, ch), 3);
  const after = src[at + run];
  if (after === undefined || /\s/.test(after)) return null;
  if (ch === "_") {
    const before = src[at - 1];
    if (before !== undefined && /[A-Za-z0-9]/.test(before)) return null;
  }
  const close = findDelimiter(src, at + run, ch, run);
  if (close === -1) return null;
  if (ch === "_") {
    const after2 = src[close + run];
    if (after2 !== undefined && /[A-Za-z0-9]/.test(after2)) return null;
  }
  const inner = renderInline(src.slice(at + run, close));
  const html =
    run >= 3
      ? `<strong><em>${inner}</em></strong>`
      : run === 2
        ? `<strong>${inner}</strong>`
        : `<em>${inner}</em>`;
  return { html, end: close + run };
}

interface ParsedLink {
  label: string;
  dest: string;
  title: string | null;
  end: number;
}

/** `[label](dest "title")` starting at the `[`. Balanced brackets in the label
 *  and one level of balanced parens in the destination, matching the rule
 *  `emailMarkdown.ts` documents for Wikipedia-style URLs. */
function parseLinkAt(src: string, at: number): ParsedLink | null {
  if (src[at] !== "[") return null;
  let depth = 0;
  let i = at;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) break;
    }
  }
  if (depth !== 0 || src[i] !== "]" || src[i + 1] !== "(") return null;
  const label = src.slice(at + 1, i);

  let j = i + 2;
  while (j < src.length && /\s/.test(src[j])) j++;
  let dest = "";
  if (src[j] === "<") {
    const end = src.indexOf(">", j + 1);
    if (end === -1) return null;
    dest = src.slice(j + 1, end);
    j = end + 1;
  } else {
    let parens = 0;
    const startDest = j;
    for (; j < src.length; j++) {
      const ch = src[j];
      if (ch === "\\") {
        j++;
        continue;
      }
      if (ch === "(") parens++;
      else if (ch === ")") {
        if (parens === 0) break;
        parens--;
      } else if (/\s/.test(ch)) break;
    }
    dest = src.slice(startDest, j);
  }

  while (j < src.length && /\s/.test(src[j])) j++;
  let title: string | null = null;
  const quote = src[j];
  if (quote === '"' || quote === "'") {
    const end = src.indexOf(quote, j + 1);
    if (end === -1) return null;
    title = src.slice(j + 1, end);
    j = end + 1;
    while (j < src.length && /\s/.test(src[j])) j++;
  }
  if (src[j] !== ")") return null;
  return { label, dest: dest.replace(/\\(.)/g, "$1"), title, end: j + 1 };
}
