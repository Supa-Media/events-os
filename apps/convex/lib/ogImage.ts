/**
 * Pull the preview image a page ADVERTISES about itself — its `og:image`.
 *
 * ── Why this is the right source for design covers ──────────────────────────
 * The Designs library's rule is that we never render a third party's image URL
 * (they expire — the `emailHtmlImport.ts` lesson), which left every Canva and
 * Figma tile as a typographic placeholder unless somebody hand-uploaded a
 * screenshot. Nobody was going to do that. But the design tools already
 * publish exactly the picture we want: the `og:image` on a share link is the
 * cover Canva renders for iMessage and Slack unfurls, kept current by the tool
 * itself. So the capture flow (`marketingDesigns.ts`) fetches the page once,
 * takes that image, and stores the BYTES in our own storage — the founder's
 * call, 2026-08-28: save the first og image; a Refresh button re-captures when
 * the design has changed. Because we keep bytes rather than the URL, the
 * expiring-CDN problem never applies to what the grid renders.
 *
 * ── Why a regex scan and not a DOM ──────────────────────────────────────────
 * Same constraint as `blogMarkdown.ts`: no HTML parser exists in the Convex
 * bundle and none may enter it. This is not a sanitizer — nothing extracted
 * here is ever rendered as HTML; the output is a URL we then fetch and
 * content-type-check — so a tag scan over the head is the honest tool. It
 * scans only the first `HEAD_SCAN_LIMIT` bytes: og tags live in `<head>`, and
 * a page that puts them later has effectively not published them (unfurlers
 * make the same call).
 */

/** How much of the page to scan. Canva's view pages carry their og tags well
 *  inside the first 100KB; the cap is a memory bound, not a parser rule. */
export const HEAD_SCAN_LIMIT = 200_000;

/** `&amp;` etc. as they appear inside attribute values. Only the five basic
 *  entities — an og:image URL needing more than these is not a URL. */
function decodeAttr(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'");
}

/**
 * All `<meta ...>` tags whose property/name matches `key`, in document order,
 * yielding their `content`. Handles either attribute order (`content` before
 * `property` is common in generated pages) and either quote style.
 */
function metaContents(html: string, key: string): string[] {
  const out: string[] = [];
  const tag = /<meta\s[^>]*>/gi;
  const keyRe = new RegExp(
    `(?:property|name)\\s*=\\s*["']${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`,
    "i",
  );
  const contentRe = /content\s*=\s*(?:"([^"]*)"|'([^']*)')/i;
  for (const m of html.matchAll(tag)) {
    if (!keyRe.test(m[0])) continue;
    const c = contentRe.exec(m[0]);
    const raw = c?.[1] ?? c?.[2];
    if (raw !== undefined) out.push(decodeAttr(raw.trim()));
  }
  return out;
}

/**
 * Whether `url` is one the capture pipeline may fetch. Stricter than the
 * library's own link rule on purpose: this URL was authored by whatever served
 * the page, not by our marketer, and the fetch runs from our backend — so
 * https only, a real hostname (never an IP literal or localhost), and nothing
 * else. Refusing oddballs costs a missing thumbnail; fetching them costs more.
 */
export function isFetchableImageUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  const host = parsed.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    return false;
  }
  // IPv4 literal or bracketed IPv6 — a page pointing its own preview at a bare
  // address is not a case worth serving.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":")) return false;
  return host.includes(".");
}

/**
 * The page's advertised preview image, as an absolute https URL — or null.
 *
 * THE FIRST `og:image` WINS. The spec allows several and Canva emits several
 * sizes; the first is the canonical cover, and it is what every unfurler
 * shows. `og:image:secure_url` and `twitter:image` are fallbacks for pages
 * that publish one of those and not the plain form. A relative `content`
 * resolves against `pageUrl`, because a handful of generators emit them that
 * way and a relative URL is not wrong, only lazy.
 */
export function extractOgImageUrl(html: string, pageUrl: string): string | null {
  const head = html.slice(0, HEAD_SCAN_LIMIT);
  const candidates = [
    ...metaContents(head, "og:image"),
    ...metaContents(head, "og:image:secure_url"),
    ...metaContents(head, "twitter:image"),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    let absolute: string;
    try {
      absolute = new URL(candidate, pageUrl).toString();
    } catch {
      continue;
    }
    if (isFetchableImageUrl(absolute)) return absolute;
  }
  return null;
}

// ── Where to actually ASK for a cover ────────────────────────────────────────
//
// The first shipped capture fetched the STORED link verbatim, announcing
// itself as "ChapterOS-LinkPreview/1.0" — and the founder's first real press
// of Refresh came back "couldn't be reached". Two causes, both fixed here and
// both invisible from a test suite that stubs fetch:
//
//   1. The stored link was the /edit URL. Canva never serves /edit to an
//      anonymous request — the PANEL still worked because `designEmbedUrl`
//      rewrites edit→view before embedding, and the capture pipeline was the
//      one caller using the link raw.
//   2. A custom bot UA from a datacenter IP is the exact signature WAFs
//      reject. The page every unfurler successfully reads is served to
//      requests that look like a page load, so the pipeline now sends a plain
//      browser UA — and, before scraping at all, asks the tool's own oEmbed
//      endpoint, the API that EXISTS for third-party preview fetching and sits
//      outside the bot wall.
//
// NOTE (2026-08-28): this sandbox's egress policy blocks canva.com entirely,
// so the two endpoints below are from the tools' published oEmbed
// registrations and could not be re-verified live from here. Both are
// fail-soft — a 404 from either simply falls through to the page scrape — and
// the capture's error now carries the HTTP status precisely so the next
// real-world failure names itself.

/** What a page-load-shaped request sends. A named bot UA is honest but is
 *  also exactly what bot walls refuse; the og tags are public content served
 *  to every browser, and this fetches them the way a browser would. */
export const PAGE_FETCH_HEADERS: Record<string, string> = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
};

/**
 * The URL whose PAGE carries the cover — normalized away from forms that are
 * never served anonymously. Mirrors `designEmbedUrl`'s canva edit→view rewrite
 * (`@events-os/shared`), which is why the viewer embed worked while the
 * capture failed: the embed normalized and the capture did not. Everything
 * that isn't a Canva design link passes through untouched.
 */
export function coverPageUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return raw;
  }
  const host = u.hostname.replace(/^www\./, "").toLowerCase();
  if (
    (host === "canva.com" || host.endsWith(".canva.com")) &&
    u.pathname.startsWith("/design/")
  ) {
    const base = `https://www.canva.com${u.pathname.replace(/\/?$/, "")}`;
    return base.replace(/\/(view|edit)$/, "/view");
  }
  return raw;
}

/**
 * The tool's own oEmbed endpoint for this link, or null for hosts that have
 * none. oEmbed is the mechanism BUILT for "some other server wants a preview
 * of this URL" — WordPress, Notion and Slack all consume it — so it is served
 * to plain server-side fetches that the design page itself may refuse.
 */
export function oembedEndpointFor(pageUrl: string): string | null {
  let u: URL;
  try {
    u = new URL(pageUrl);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\./, "").toLowerCase();
  const encoded = encodeURIComponent(u.toString());
  if (host === "canva.com" || host.endsWith(".canva.com")) {
    return `https://www.canva.com/_oembed/types/rich?url=${encoded}`;
  }
  if (host === "figma.com" || host.endsWith(".figma.com")) {
    return `https://www.figma.com/api/oembed?url=${encoded}`;
  }
  return null;
}

/** The image an oEmbed document offers, if it offers one we may fetch. */
export function oembedThumbnailUrl(doc: unknown): string | null {
  if (!doc || typeof doc !== "object") return null;
  const url = (doc as { thumbnail_url?: unknown }).thumbnail_url;
  if (typeof url !== "string") return null;
  return isFetchableImageUrl(url) ? url : null;
}
