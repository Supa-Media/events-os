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
