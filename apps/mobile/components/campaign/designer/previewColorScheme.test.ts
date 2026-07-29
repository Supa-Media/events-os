import { forceIframeColorScheme } from "./previewColorScheme";

const DOC_ATTRS =
  '<meta name="color-scheme" content="light dark"/><meta name="supported-color-schemes" content="light dark"/>';

function fixtureHtml(darkStyleBlock: string): string {
  return (
    `<!DOCTYPE html><html><head>${DOC_ATTRS}` +
    `${darkStyleBlock}</head><body><p>Hello</p></body></html>`
  );
}

const DARK_BLOCK =
  '<style id="pw-dark-mode">\n' +
  "@media (prefers-color-scheme: dark) {\n" +
  "body { background:#0d0d10 !important; color:#f5f5f5 !important; }\n" +
  ".pw-container { background:#1a1a1f !important; }\n" +
  "}\n" +
  "[data-ogsc] body { background:#0d0d10 !important; color:#f5f5f5 !important; }\n" +
  "[data-ogsc] .pw-container { background:#1a1a1f !important; }\n" +
  "</style>";

describe("forceIframeColorScheme", () => {
  it("passes through HTML with no pw-dark-mode block unchanged (fail open)", () => {
    const html = "<html><head></head><body>plain</body></html>";
    expect(forceIframeColorScheme(html, "light")).toBe(html);
    expect(forceIframeColorScheme(html, "dark")).toBe(html);
  });

  describe("scheme: light", () => {
    it("removes the dark-mode style block entirely — nothing left for any media query to match", () => {
      const html = fixtureHtml(DARK_BLOCK);
      const result = forceIframeColorScheme(html, "light");
      expect(result).not.toContain("pw-dark-mode");
      expect(result).not.toContain("prefers-color-scheme: dark");
      expect(result).not.toContain("#0d0d10");
    });

    it("forces the color-scheme meta tags to light", () => {
      const result = forceIframeColorScheme(fixtureHtml(DARK_BLOCK), "light");
      expect(result).toContain('<meta name="color-scheme" content="light"/>');
      expect(result).toContain('<meta name="supported-color-schemes" content="light"/>');
    });

    it("leaves the rest of the document untouched", () => {
      const result = forceIframeColorScheme(fixtureHtml(DARK_BLOCK), "light");
      expect(result).toContain("<p>Hello</p>");
    });
  });

  describe("scheme: dark", () => {
    it("unwraps the dark rules from their @media guard so they apply unconditionally", () => {
      const result = forceIframeColorScheme(fixtureHtml(DARK_BLOCK), "dark");
      expect(result).not.toContain("@media (prefers-color-scheme: dark)");
      expect(result).toContain("body { background:#0d0d10 !important; color:#f5f5f5 !important; }");
      expect(result).toContain(".pw-container { background:#1a1a1f !important; }");
    });

    it("forces the color-scheme meta tags to dark", () => {
      const result = forceIframeColorScheme(fixtureHtml(DARK_BLOCK), "dark");
      expect(result).toContain('<meta name="color-scheme" content="dark"/>');
      expect(result).toContain('<meta name="supported-color-schemes" content="dark"/>');
    });

    it("still contains the [data-ogsc] fallback lines, untouched", () => {
      const result = forceIframeColorScheme(fixtureHtml(DARK_BLOCK), "dark");
      expect(result).toContain("[data-ogsc] body");
    });
  });

  it("is idempotent-safe: forcing light then reading it again is still light (no pw-dark-mode block left to re-toggle)", () => {
    const once = forceIframeColorScheme(fixtureHtml(DARK_BLOCK), "light");
    const twice = forceIframeColorScheme(once, "dark");
    // Nothing left to unwrap — fails open, unchanged.
    expect(twice).toBe(once);
  });
});
