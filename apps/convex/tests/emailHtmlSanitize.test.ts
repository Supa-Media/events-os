import { describe, expect, test } from "vitest";
import {
  findImageUrls,
  MAX_IMAGE_URLS,
  preserveFailedImageAspect,
  resolveImageFetchUrl,
  rewriteImageUrls,
  sanitizeEmailHtml,
} from "../lib/emailHtmlSanitize";

/**
 * `lib/emailHtmlSanitize.ts` — the pure half of "Paste HTML" import
 * (`emailHtmlImport.ts`). Adversarial by design per CLAUDE.md's brief:
 * prove every hostile construct is neutralized while legitimate
 * table/style markup a real Canva/newsletter export depends on survives.
 */

// ── findImageUrls ────────────────────────────────────────────────────────────

describe("findImageUrls", () => {
  test("finds an <img src>", () => {
    expect(findImageUrls('<img src="https://cdn.example.com/a.png">')).toEqual([
      "https://cdn.example.com/a.png",
    ]);
  });

  test("finds single-quoted <img src>", () => {
    expect(findImageUrls("<img src='https://cdn.example.com/a.png'>")).toEqual([
      "https://cdn.example.com/a.png",
    ]);
  });

  test("finds a CSS background-image url() in an inline style", () => {
    const html = '<div style="background-image:url(https://cdn.example.com/bg.jpg)"></div>';
    expect(findImageUrls(html)).toEqual(["https://cdn.example.com/bg.jpg"]);
  });

  test("finds a CSS url() inside a <style> block", () => {
    const html = "<style>.hero{background:url('https://cdn.example.com/hero.png') no-repeat}</style>";
    expect(findImageUrls(html)).toEqual(["https://cdn.example.com/hero.png"]);
  });

  test("finds a legacy background= table attribute", () => {
    const html = '<table background="https://cdn.example.com/table-bg.gif"><tr><td>x</td></tr></table>';
    expect(findImageUrls(html)).toEqual(["https://cdn.example.com/table-bg.gif"]);
  });

  test("dedupes repeated URLs", () => {
    const html =
      '<img src="https://cdn.example.com/a.png"><img src="https://cdn.example.com/a.png">';
    expect(findImageUrls(html)).toEqual(["https://cdn.example.com/a.png"]);
  });

  test("ignores data: URLs — nothing to re-host", () => {
    expect(findImageUrls('<img src="data:image/png;base64,iVBORw0KGgo=">')).toEqual([]);
  });

  test("ignores relative/root-relative paths — no base to resolve against", () => {
    expect(findImageUrls('<img src="/assets/logo.png">')).toEqual([]);
    expect(findImageUrls('<img src="logo.png">')).toEqual([]);
  });

  test("caps at MAX_IMAGE_URLS distinct URLs", () => {
    const many = Array.from({ length: MAX_IMAGE_URLS + 20 }, (_, i) => `https://cdn.example.com/${i}.png`);
    const html = many.map((u) => `<img src="${u}">`).join("");
    expect(findImageUrls(html).length).toBe(MAX_IMAGE_URLS);
  });

  test("finds multiple images across mixed sources in encounter order", () => {
    const html =
      '<img src="https://cdn.example.com/one.png">' +
      '<div style="background-image:url(https://cdn.example.com/two.png)"></div>';
    expect(findImageUrls(html)).toEqual([
      "https://cdn.example.com/one.png",
      "https://cdn.example.com/two.png",
    ]);
  });

  // Adversarial-review finding (2026-07-30, HIGH): protocol-relative image
  // refs used to be neither re-hosted nor blocked — silently shipped as a
  // live third-party reference. `findImageUrls` must now capture them.
  describe("protocol-relative URLs (adversarial-review finding, HIGH)", () => {
    test("captures a protocol-relative CSS url() reference", () => {
      const html = '<div style="background:url(//tracker.example.com/pixel.gif)">x</div>';
      expect(findImageUrls(html)).toEqual(["//tracker.example.com/pixel.gif"]);
    });

    test("captures a protocol-relative <img src>", () => {
      expect(findImageUrls('<img src="//tracker.example.com/pixel.gif">')).toEqual([
        "//tracker.example.com/pixel.gif",
      ]);
    });

    test("captures a protocol-relative legacy background= attribute", () => {
      expect(findImageUrls('<table background="//tracker.example.com/bg.gif"><tr><td>x</td></tr></table>')).toEqual([
        "//tracker.example.com/bg.gif",
      ]);
    });

    test("a bare // with no host is not treated as a reference", () => {
      expect(findImageUrls('<img src="//">')).toEqual([]);
    });
  });
});

describe("resolveImageFetchUrl", () => {
  test("resolves a protocol-relative reference to https:", () => {
    expect(resolveImageFetchUrl("//tracker.example.com/pixel.gif")).toBe(
      "https://tracker.example.com/pixel.gif",
    );
  });

  test("leaves an already-absolute https URL unchanged", () => {
    expect(resolveImageFetchUrl("https://cdn.example.com/a.png")).toBe("https://cdn.example.com/a.png");
  });

  test("leaves an already-absolute http URL unchanged (the SSRF/scheme guard is the import action's job, not this resolver's)", () => {
    expect(resolveImageFetchUrl("http://cdn.example.com/a.png")).toBe("http://cdn.example.com/a.png");
  });
});

// ── rewriteImageUrls ─────────────────────────────────────────────────────────

describe("rewriteImageUrls", () => {
  test("rewrites every occurrence of a mapped URL", () => {
    const html =
      '<img src="https://cdn.example.com/a.png"><div style="background-image:url(https://cdn.example.com/a.png)"></div>';
    const map = new Map([["https://cdn.example.com/a.png", "https://storage.example/rehosted-1"]]);
    const result = rewriteImageUrls(html, map);
    expect(result).not.toContain("cdn.example.com");
    expect(result.match(/storage\.example\/rehosted-1/g)?.length).toBe(2);
  });

  test("leaves unmapped URLs untouched (a failed re-host)", () => {
    const html = '<img src="https://cdn.example.com/dead.png">';
    const result = rewriteImageUrls(html, new Map());
    expect(result).toBe(html);
  });

  test("URL special characters (query strings) don't need escaping", () => {
    const original = "https://cdn.example.com/a.png?token=abc&size=200";
    const html = `<img src="${original}">`;
    const map = new Map([[original, "https://storage.example/rehosted-2"]]);
    expect(rewriteImageUrls(html, map)).toBe('<img src="https://storage.example/rehosted-2">');
  });
});

// ── sanitizeEmailHtml — adversarial ──────────────────────────────────────────

describe("sanitizeEmailHtml — hostile input is neutralized", () => {
  test("strips <script> tags AND their content", () => {
    const out = sanitizeEmailHtml('<p>hi</p><script>alert(document.cookie)</script>');
    expect(out).not.toContain("<script");
    expect(out).not.toContain("alert(document.cookie)");
    expect(out).toContain("hi");
  });

  test("strips <img onerror=> — the handler attribute, keeping the image", () => {
    const out = sanitizeEmailHtml('<img src="https://cdn.example.com/a.png" onerror="alert(1)">');
    expect(out).not.toContain("onerror");
    expect(out).not.toContain("alert(1)");
    expect(out).toContain("https://cdn.example.com/a.png");
  });

  test("strips every on* event handler generically", () => {
    const out = sanitizeEmailHtml(
      '<div onclick="steal()" onmouseover="steal()" onload="steal()">text</div>',
    );
    expect(out).not.toMatch(/on(click|mouseover|load)=/);
    expect(out).toContain("text");
  });

  test("strips javascript: href, keeping the link text", () => {
    const out = sanitizeEmailHtml('<a href="javascript:alert(1)">click me</a>');
    expect(out).not.toContain("javascript:");
    expect(out).toContain("click me");
  });

  test("strips vbscript: href", () => {
    const out = sanitizeEmailHtml('<a href="VBScript:msgbox(1)">click</a>');
    expect(out.toLowerCase()).not.toContain("vbscript:");
  });

  test("strips <iframe> entirely", () => {
    const out = sanitizeEmailHtml('<p>before</p><iframe src="https://evil.example"></iframe><p>after</p>');
    expect(out).not.toContain("<iframe");
    expect(out).not.toContain("evil.example");
    expect(out).toContain("before");
    expect(out).toContain("after");
  });

  test("strips <object> and <embed>", () => {
    const out = sanitizeEmailHtml('<object data="evil.swf"></object><embed src="evil.swf">');
    expect(out).not.toContain("<object");
    expect(out).not.toContain("<embed");
  });

  test("strips a non-image data: URL on <img src>", () => {
    const out = sanitizeEmailHtml('<img src="data:text/html;base64,PHNjcmlwdD4=" alt="x">');
    expect(out).not.toContain("data:text/html");
  });

  test("keeps a legitimate data: image URL on <img src>", () => {
    const out = sanitizeEmailHtml('<img src="data:image/png;base64,iVBORw0KGgo=" alt="x">');
    expect(out).toContain("data:image/png;base64,iVBORw0KGgo=");
  });

  test("strips malformed/unclosed HTML without throwing", () => {
    expect(() =>
      sanitizeEmailHtml('<table><tr><td>unclosed<img src="https://cdn.example.com/a.png">'),
    ).not.toThrow();
    const out = sanitizeEmailHtml('<div><p>unclosed<script>alert(1)</div>');
    expect(out).not.toContain("alert(1)");
  });

  test("strips CSS expression() (legacy IE code-execution vector) from a style attribute", () => {
    const out = sanitizeEmailHtml('<div style="width:expression(alert(1))">x</div>');
    expect(out).not.toContain("expression(");
  });

  test("strips -moz-binding and behavior: CSS attack vectors", () => {
    const out = sanitizeEmailHtml('<div style="-moz-binding:url(evil.xml)">x</div>');
    expect(out).not.toContain("-moz-binding");
    const out2 = sanitizeEmailHtml('<div style="behavior:url(evil.htc)">x</div>');
    expect(out2).not.toContain("behavior:");
  });

  test("strips @import from a <style> block", () => {
    const out = sanitizeEmailHtml('<style>@import url(https://evil.example/steal.css);</style>');
    expect(out).not.toContain("@import");
  });

  // ── Adversarial-review findings, 2026-07-30 — each proven live before the
  // fix, regression-tested with the EXACT reported payload. ──────────────────

  test("[finding #1, CRITICAL] strips <meta http-equiv=\"refresh\"> — an open-redirect a mail client renders live", () => {
    const out = sanitizeEmailHtml(
      '<html><head><meta http-equiv="refresh" content="0;url=https://evil/phish"></head><body>hi</body></html>',
    );
    // `http-equiv` is what gives a `<meta>` its live/executable meaning
    // (browsers and mail clients ignore a bare `content` with no
    // `http-equiv`/`name` pairing — it's inert data, same as any other
    // unrecognized attribute) — stripping it is what neutralizes the
    // redirect. The leftover `content="0;url=…"` string sitting on an
    // otherwise-meaningless attribute is not itself live/dangerous.
    expect(out).not.toContain("http-equiv");
    expect(out).not.toMatch(/http-equiv\s*=\s*["']?refresh/i);
  });

  test("[finding #1] strips http-equiv on <meta> generally, not just refresh", () => {
    const out = sanitizeEmailHtml('<meta http-equiv="content-type" content="text/html; charset=evil">');
    expect(out).not.toContain("http-equiv");
  });

  test("[finding #2, exact payload] neutralizes javascript: inside a CSS url() in a style attribute", () => {
    const out = sanitizeEmailHtml('<div style="background:url(javascript:alert(1))">x</div>');
    expect(out).not.toContain("javascript:");
    expect(out).not.toContain("alert(1)");
  });

  test("[finding #2] neutralizes vbscript: inside a CSS url()", () => {
    const out = sanitizeEmailHtml('<div style="background:url(vbscript:msgbox(1))">x</div>');
    expect(out.toLowerCase()).not.toContain("vbscript:");
  });

  test("[finding #2] neutralizes javascript: inside a CSS url() in a <style> block", () => {
    const out = sanitizeEmailHtml('<style>.x{background:url(javascript:alert(1))}</style>');
    expect(out).not.toContain("javascript:");
  });

  test("[finding #4, exact payload] catches @import obfuscated behind a CSS hex escape (@\\69mport === @import)", () => {
    const out = sanitizeEmailHtml("<style>@\\69 mport url(https://evil/x.css)</style>");
    expect(out).not.toContain("evil/x.css");
    // The whole hazardous style block is dropped, not surgically edited —
    // no residual "mport" text or escape fragment left behind either.
    expect(out).not.toMatch(/import/i);
  });

  test("[finding #4] catches @import hidden behind a CSS comment splitting the keyword", () => {
    const out = sanitizeEmailHtml("<style>@im/**/port url(https://evil/x.css)</style>");
    expect(out).not.toContain("evil/x.css");
  });

  test("[finding #4] catches expression() obfuscated behind a CSS escape", () => {
    const out = sanitizeEmailHtml('<div style="width:expr\\65ssion(alert(1))">x</div>');
    expect(out).not.toContain("alert(1)");
  });

  test("a legitimate style block/attribute with none of the above survives untouched", () => {
    const html =
      '<style>.hero{color:#891D1A;font-weight:bold}</style>' +
      '<div style="padding:16px;background:#fff">Hello</div>';
    const out = sanitizeEmailHtml(html);
    expect(out).toContain(".hero{color:#891D1A;font-weight:bold}");
    expect(out).toContain('style="padding:16px;background:#fff"');
  });
});

describe("sanitizeEmailHtml — legitimate email markup survives", () => {
  test("keeps table structure and inline styles a real newsletter depends on", () => {
    const html =
      '<table width="600" cellpadding="0" cellspacing="0" style="background:#fff"><tr>' +
      '<td align="center" style="padding:16px;font-family:Arial,sans-serif">' +
      '<h1 style="color:#111">Hello</h1>' +
      '<p style="font-size:14px">Body copy</p>' +
      '<img src="https://cdn.example.com/photo.jpg" alt="A photo" width="200">' +
      '</td></tr></table>';
    const out = sanitizeEmailHtml(html);
    expect(out).toContain("<table");
    expect(out).toContain('width="600"');
    expect(out).toContain('style="background:#fff"');
    expect(out).toContain('align="center"');
    expect(out).toContain("Hello");
    expect(out).toContain("Body copy");
    expect(out).toContain("https://cdn.example.com/photo.jpg");
    expect(out).toContain('alt="A photo"');
  });

  test("keeps a <style> block for media queries (a common Canva export pattern)", () => {
    const html = "<style>@media (max-width:600px){.hero{width:100%!important}}</style><div class=\"hero\">x</div>";
    const out = sanitizeEmailHtml(html);
    expect(out).toContain("<style>");
    expect(out).toContain("@media");
    expect(out).toContain('class="hero"');
  });

  test("keeps mailto: and tel: links", () => {
    const out = sanitizeEmailHtml('<a href="mailto:hi@example.com">Email us</a><a href="tel:+15551234567">Call</a>');
    expect(out).toContain("mailto:hi@example.com");
    expect(out).toContain("tel:+15551234567");
  });

  test("keeps ordinary https links", () => {
    const out = sanitizeEmailHtml('<a href="https://example.com/rsvp">RSVP</a>');
    expect(out).toContain('href="https://example.com/rsvp"');
  });

  test("keeps head/meta content (charset, viewport) when present", () => {
    const html =
      '<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head><body><p>hi</p></body></html>';
    const out = sanitizeEmailHtml(html);
    expect(out).toContain('charset="utf-8"');
    expect(out).toContain("width=device-width");
  });
});

// ── preserveFailedImageAspect ────────────────────────────────────────────────

/**
 * The founder's "the spacing is off" (2026-07-30). An unfetchable image is
 * rewritten to a 1×1 transparent GIF; a design-tool export sizes its images
 * with `style="width:600px;height:auto"`, so `height:auto` resolves against
 * the placeholder's 1:1 ratio and every missing image becomes a giant blank
 * square — eleven of them roughly doubled the real newsletter's height.
 */
describe("preserveFailedImageAspect", () => {
  const PH = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";

  test("stamps the declared ratio onto a placeholder image", () => {
    const out = preserveFailedImageAspect(
      `<img src="${PH}" width="600" height="62" style="display:block;width:600px;height:auto">`,
      PH,
    );
    expect(out).toContain("aspect-ratio:600/62");
    expect(out).toContain("display:block;width:600px;height:auto;aspect-ratio:600/62");
  });

  test("leaves real (re-hosted) images completely alone", () => {
    const html = '<img src="https://storage.example.com/abc" width="600" height="62" style="width:600px;height:auto">';
    expect(preserveFailedImageAspect(html, PH)).toBe(html);
  });

  test("no-ops when the html has no placeholder at all", () => {
    const html = '<p>Hello</p><img src="https://cdn.example.com/x.png" width="10" height="10" style="width:10px">';
    expect(preserveFailedImageAspect(html, PH)).toBe(html);
  });

  test("skips an image with no usable width/height pair — nothing to derive a ratio from", () => {
    const html = `<img src="${PH}" style="width:100%;height:auto">`;
    expect(preserveFailedImageAspect(html, PH)).toBe(html);
    const percentage = `<img src="${PH}" width="100%" height="auto" style="width:100%;height:auto">`;
    expect(preserveFailedImageAspect(percentage, PH)).toBe(percentage);
  });

  test("reads the real width/height, not a `data-width` that merely ends in one", () => {
    const out = preserveFailedImageAspect(
      `<img src="${PH}" data-width="9" data-height="9" width="600" height="62" style="max-width:100%;width:600px">`,
      PH,
    );
    expect(out).toContain("aspect-ratio:600/62");
  });

  test("never fights an explicit author aspect-ratio", () => {
    const html = `<img src="${PH}" width="600" height="62" style="aspect-ratio:2/1;width:600px">`;
    expect(preserveFailedImageAspect(html, PH)).toBe(html);
  });

  test("keeps the author's quote style and survives a `$` in the existing CSS", () => {
    const out = preserveFailedImageAspect(
      `<img src='${PH}' width='4' height='2' style='font-family:"A$B";width:4px'>`,
      PH,
    );
    expect(out).toContain(`style='font-family:"A$B";width:4px;aspect-ratio:4/2'`);
  });

  test("handles several images independently, and a trailing semicolon", () => {
    const out = preserveFailedImageAspect(
      `<img src="${PH}" width="600" height="62" style="width:600px;">` +
        `<img src="https://ok.example.com/a.png" width="1" height="1" style="width:1px">` +
        `<img src="${PH}" width="540" height="329" style="width:540px">`,
      PH,
    );
    expect(out).toContain('style="width:600px;aspect-ratio:600/62"');
    expect(out).toContain('style="width:1px"');
    expect(out).toContain('style="width:540px;aspect-ratio:540/329"');
  });

  test("the stamped declaration survives the real sanitizer", () => {
    const out = sanitizeEmailHtml(
      preserveFailedImageAspect(
        `<img src="${PH}" width="600" height="62" style="width:600px;height:auto">`,
        PH,
      ),
    );
    expect(out).toContain("aspect-ratio:600/62");
  });
});
