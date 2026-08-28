/**
 * The og:image extractor behind design-cover capture.
 *
 * Not a sanitizer — nothing here is ever rendered — but it IS the thing that
 * decides which URL our backend fetches next, so the tests lean on the two
 * spots that matter: the FIRST og:image wins (the founder's literal
 * instruction, and what every unfurler shows), and the returned URL is one the
 * pipeline is willing to fetch (https, real hostname, no IP literals).
 */
import { describe, expect, test } from "vitest";
import {
  extractOgImageUrl,
  isFetchableImageUrl,
  HEAD_SCAN_LIMIT,
} from "../lib/ogImage";

const PAGE = "https://www.canva.com/design/DAG123/view";

function metaHtml(tags: string): string {
  return `<!doctype html><html><head>${tags}</head><body></body></html>`;
}

describe("extractOgImageUrl", () => {
  test("the FIRST og:image wins when the page publishes several", () => {
    const html = metaHtml(
      `<meta property="og:image" content="https://cdn.example.com/cover-large.png">
       <meta property="og:image" content="https://cdn.example.com/cover-small.png">`,
    );
    expect(extractOgImageUrl(html, PAGE)).toBe(
      "https://cdn.example.com/cover-large.png",
    );
  });

  test("attribute order and quote style don't matter — generators vary", () => {
    const html = metaHtml(
      `<meta content='https://cdn.example.com/c.png' property='og:image'>`,
    );
    expect(extractOgImageUrl(html, PAGE)).toBe("https://cdn.example.com/c.png");
  });

  test("&amp; in the content attribute decodes — signed CDN URLs carry query pairs", () => {
    const html = metaHtml(
      `<meta property="og:image" content="https://cdn.example.com/c.png?sig=a&amp;exp=b">`,
    );
    expect(extractOgImageUrl(html, PAGE)).toBe(
      "https://cdn.example.com/c.png?sig=a&exp=b",
    );
  });

  test("falls back to og:image:secure_url, then twitter:image", () => {
    expect(
      extractOgImageUrl(
        metaHtml(
          `<meta property="og:image:secure_url" content="https://cdn.example.com/s.png">`,
        ),
        PAGE,
      ),
    ).toBe("https://cdn.example.com/s.png");
    expect(
      extractOgImageUrl(
        metaHtml(`<meta name="twitter:image" content="https://cdn.example.com/t.png">`),
        PAGE,
      ),
    ).toBe("https://cdn.example.com/t.png");
  });

  test("a relative content resolves against the page's own URL", () => {
    const html = metaHtml(`<meta property="og:image" content="/previews/c.png">`);
    expect(extractOgImageUrl(html, PAGE)).toBe(
      "https://www.canva.com/previews/c.png",
    );
  });

  test("an http (not https) first image is passed over for a later https one", () => {
    // Refusing the insecure one must not mean giving up: the next candidate
    // still gets its turn, same shape as a stale pin being skipped.
    const html = metaHtml(
      `<meta property="og:image" content="http://cdn.example.com/insecure.png">
       <meta property="og:image" content="https://cdn.example.com/secure.png">`,
    );
    expect(extractOgImageUrl(html, PAGE)).toBe(
      "https://cdn.example.com/secure.png",
    );
  });

  test("a page with no preview tags is null, not an invented URL", () => {
    expect(extractOgImageUrl(metaHtml(`<title>Untitled</title>`), PAGE)).toBeNull();
  });

  test("tags beyond the head-scan limit are not found — unfurlers make the same call", () => {
    const html =
      metaHtml("") +
      " ".repeat(HEAD_SCAN_LIMIT) +
      `<meta property="og:image" content="https://cdn.example.com/late.png">`;
    expect(extractOgImageUrl(html, PAGE)).toBeNull();
  });
});

describe("isFetchableImageUrl — what our backend will fetch on a page's say-so", () => {
  test("https with a real hostname passes", () => {
    expect(isFetchableImageUrl("https://cdn.example.com/x.png")).toBe(true);
  });
  test.each([
    ["http", "http://cdn.example.com/x.png"],
    ["an IPv4 literal", "https://10.0.0.1/x.png"],
    ["localhost", "https://localhost/x.png"],
    ["a .local name", "https://printer.local/x.png"],
    ["a dotless host", "https://intranet/x.png"],
    ["not a URL at all", "definitely not"],
  ])("%s is refused", (_label, url) => {
    // The URL under test was authored by whatever served the page, not by our
    // marketer — refusing it costs a missing thumbnail, fetching it costs more.
    expect(isFetchableImageUrl(url)).toBe(false);
  });
});
