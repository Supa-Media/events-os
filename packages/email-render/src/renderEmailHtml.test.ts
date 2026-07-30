import { describe, expect, test } from "vitest";
import { renderEmailHtml } from "./renderEmailHtml";

/**
 * `renderEmailHtml` — the `docFormat: "html"` ("Paste HTML") twin of
 * `renderEmail.test.ts`'s `renderEmailTiptap` suite. Mirrors that file's
 * compliance/dark-mode assertions on purpose: the whole point of
 * `complianceShell.ts` is that both renderers produce byte-identical footer
 * markup and dark-mode rules.
 */

const FRAGMENT = '<table width="600"><tr><td>Hello from Canva</td></tr></table>';
const FULL_DOC =
  '<html><head><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"></head><body><p>Hi</p></body></html>';

describe("renderEmailHtml: compliance footer", () => {
  test("the footer appears in the HTML part, before </body>, address + signoff + unsubscribe link", async () => {
    const { html } = await renderEmailHtml(FRAGMENT, {
      unsubscribeUrl: "https://example.com/unsubscribe/tok123",
      orgAddress: "123 Main St, Springfield",
    });
    expect(html).toContain("123 Main St, Springfield");
    expect(html).toContain("Sent with love by Public Worship");
    expect(html).toContain("https://example.com/unsubscribe/tok123");
    expect(html.indexOf("Sent with love")).toBeLessThan(html.indexOf("</body>"));
  });

  test("the footer appears in the plaintext part too, with a real unsubscribe URL", async () => {
    const { text } = await renderEmailHtml(FRAGMENT, {
      unsubscribeUrl: "https://example.com/unsubscribe/tok123",
      orgAddress: "123 Main St, Springfield",
    });
    expect(text).toContain("123 Main St, Springfield");
    expect(text).toContain("https://example.com/unsubscribe/tok123");
  });

  test("orgAddress is optional — footer still has signoff + unsubscribe without it", async () => {
    const { html } = await renderEmailHtml(FRAGMENT, {
      unsubscribeUrl: "https://example.com/unsubscribe/tok123",
      orgAddress: "",
    });
    expect(html).toContain("https://example.com/unsubscribe/tok123");
    expect(html).toContain("Sent with love by Public Worship");
  });

  test("a javascript: unsubscribe URL is neutralized, not passed through — same sanitizer as renderEmailTiptap", async () => {
    const { html } = await renderEmailHtml(FRAGMENT, {
      unsubscribeUrl: "javascript:alert(1)",
      orgAddress: "123 Main St",
    });
    expect(html).not.toContain("javascript:alert(1)");
  });
});

describe("renderEmailHtml: bare fragment vs full document", () => {
  test("a bare fragment (no <html>) is wrapped in a minimal document shell", async () => {
    const { html } = await renderEmailHtml(FRAGMENT, {
      unsubscribeUrl: "https://example.com/u/1",
      orgAddress: "Addr",
    });
    expect(html).toMatch(/<html[\s>]/i);
    expect(html).toMatch(/<head>/i);
    expect(html).toContain(FRAGMENT);
  });

  test("a document that already has <html> is not double-wrapped", async () => {
    const { html } = await renderEmailHtml(FULL_DOC, {
      unsubscribeUrl: "https://example.com/u/1",
      orgAddress: "Addr",
    });
    expect(html.match(/<html[\s>]/gi)?.length).toBe(1);
    expect(html).toContain("<p>Hi</p>");
  });

  test("preview text is injected as a hidden preheader for a bare fragment", async () => {
    const { html } = await renderEmailHtml(FRAGMENT, {
      unsubscribeUrl: "https://example.com/u/1",
      orgAddress: "Addr",
      preview: "Your monthly update",
    });
    expect(html).toContain("Your monthly update");
    expect(html).toContain("display:none");
  });

  test("preview text is HTML-escaped in the preheader (defense in depth)", async () => {
    const { html } = await renderEmailHtml(FRAGMENT, {
      unsubscribeUrl: "https://example.com/u/1",
      orgAddress: "Addr",
      preview: '<img src=x onerror="alert(1)">',
    });
    expect(html).not.toContain('<img src=x onerror="alert(1)">');
    expect(html).toContain("&lt;img");
  });
});

describe("renderEmailHtml: dark mode meta + style", () => {
  test("color-scheme meta becomes light dark on a full document", async () => {
    const { html } = await renderEmailHtml(FULL_DOC, {
      unsubscribeUrl: "https://example.com/u/1",
      orgAddress: "Addr",
    });
    expect(html).toContain('content="light dark"');
    expect(html).not.toMatch(/content="light"/);
  });

  test("a wrapped fragment also gets light dark (the shell's own meta tags flip)", async () => {
    const { html } = await renderEmailHtml(FRAGMENT, {
      unsubscribeUrl: "https://example.com/u/1",
      orgAddress: "Addr",
    });
    expect(html).toContain('content="light dark"');
  });

  test("a dark-mode style block is injected before </head>", async () => {
    const { html } = await renderEmailHtml(FULL_DOC, {
      unsubscribeUrl: "https://example.com/u/1",
      orgAddress: "Addr",
    });
    expect(html).toContain("pw-dark-mode");
    expect(html).toContain("@media (prefers-color-scheme: dark)");
    expect(html.indexOf("pw-dark-mode")).toBeLessThan(html.indexOf("</head>"));
  });
});

describe("renderEmailHtml: plaintext fallback", () => {
  test("strips tags and preserves prose", async () => {
    const { text } = await renderEmailHtml(
      "<p>Hello <strong>friend</strong></p><table><tr><td>Row one</td></tr></table>",
      { unsubscribeUrl: "https://example.com/u/1", orgAddress: "Addr" },
    );
    expect(text).toContain("Hello friend");
    expect(text).toContain("Row one");
    expect(text).not.toContain("<p>");
    expect(text).not.toContain("<td>");
  });

  test("drops <script>/<style> content entirely from the plaintext part", async () => {
    const { text } = await renderEmailHtml(
      '<style>body{color:red}</style><script>alert(1)</script><p>Real content</p>',
      { unsubscribeUrl: "https://example.com/u/1", orgAddress: "Addr" },
    );
    expect(text).toContain("Real content");
    expect(text).not.toContain("color:red");
    expect(text).not.toContain("alert(1)");
  });
});

describe("renderEmailHtml: passes through the pasted content byte-for-byte (no re-sanitizing here)", () => {
  test("the input html is not altered besides the shell/footer/meta additions", async () => {
    const distinctiveMarkup = '<table><tr><td style="color:#123456">Distinctive Row</td></tr></table>';
    const { html } = await renderEmailHtml(distinctiveMarkup, {
      unsubscribeUrl: "https://example.com/u/1",
      orgAddress: "Addr",
    });
    expect(html).toContain(distinctiveMarkup);
  });
});

/**
 * The founder's "the spacing is off" (2026-07-30), second half. The real
 * sanitizer must strip `<meta http-equiv>` (an open-redirect vector) — but
 * that is the ONLY place a Canva export declares its encoding, and
 * `sanitize-html` drops the doctype too. Without both restored here, the
 * rendered email loses standards mode and, anywhere the transport doesn't
 * supply `charset=utf-8`, renders `’` as `â€™` and every `&nbsp;` spacer as a
 * visible `Â`.
 */
describe("renderEmailHtml: document basics the sanitizer necessarily removed", () => {
  /** What a Canva export looks like AFTER `sanitizeEmailHtml`: `<html>` root
   *  kept, doctype gone, and the charset stranded inside a `content` value
   *  whose `http-equiv` was stripped. */
  const SANITIZED_CANVA =
    '<html><head><meta name="viewport" content="width=device-width, initial-scale=1.0">' +
    '<meta content="text/html; charset=UTF-8"></head>' +
    "<body><table><tr><td>Manhattan’s busiest landmark</td></tr></table></body></html>";

  const OPTS = { unsubscribeUrl: "https://example.com/unsubscribe/t", orgAddress: "1 Main St" };

  test("adds a standards-mode doctype to a document that kept its <html> root", async () => {
    const { html } = await renderEmailHtml(SANITIZED_CANVA, OPTS);
    expect(html.toLowerCase().startsWith("<!doctype html>")).toBe(true);
  });

  test("declares utf-8 — a stranded charset= inside a content VALUE is not a declaration", async () => {
    const { html } = await renderEmailHtml(SANITIZED_CANVA, OPTS);
    expect(html).toContain('<meta charset="utf-8">');
    // Early enough to be honored at all (a <meta charset> past 1024 bytes is ignored).
    expect(html.indexOf('<meta charset="utf-8">')).toBeLessThan(1024);
  });

  test("does not double-declare when the paste already has a real <meta charset>", async () => {
    const { html } = await renderEmailHtml(
      '<html><head><meta charset="utf-8"></head><body><p>Hi</p></body></html>',
      OPTS,
    );
    expect(html.match(/<meta charset=/gi)).toHaveLength(1);
  });

  test("respects a legacy http-equiv content-type pair, if one somehow survives", async () => {
    const { html } = await renderEmailHtml(
      '<html><head><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"></head><body><p>Hi</p></body></html>',
      OPTS,
    );
    expect(html).not.toContain('<meta charset="utf-8">');
  });

  test("a bare fragment still gets exactly one doctype and one charset", async () => {
    const { html } = await renderEmailHtml(FRAGMENT, OPTS);
    expect(html.toLowerCase().match(/<!doctype/g)).toHaveLength(1);
    expect(html.match(/charset=/gi)).toHaveLength(1);
  });
});
