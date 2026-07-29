/**
 * WS0 spike, Bet 3 — see `postprocess.ts`'s module doc.
 */
import { describe, expect, test } from "vitest";
import { Maily } from "./maily";
import { injectBeforeBodyClose, overrideColorSchemeMeta } from "./postprocess";
import type { JSONContent } from "@tiptap/core";

const doc: JSONContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "Bet 3 body." }] }],
};

describe("WS0 spike Bet 3: post-processing hooks on maily's output", () => {
  test("a footer survives injection before the last </body>", async () => {
    const html = await new Maily(doc).render();
    const footer = '<div id="pw-footer">123 Main St · <a href="https://example.com/u/abc">Unsubscribe</a></div>';

    const withFooter = injectBeforeBodyClose(html, footer);

    expect(withFooter).toContain(footer);
    // Landed INSIDE the document, not appended after </html>.
    expect(withFooter.indexOf(footer)).toBeLessThan(withFooter.lastIndexOf("</body>") + "</body>".length);
    expect(withFooter.indexOf(footer)).toBeGreaterThan(withFooter.indexOf("<body"));
    // Exactly one </body> still present (we inserted before it, not a second one).
    expect(withFooter.match(/<\/body>/g)).toHaveLength(1);
  });

  test("color-scheme: light metas become light dark and survive", async () => {
    const html = await new Maily(doc).render();
    expect(html).toContain('<meta name="color-scheme" content="light"/>');
    expect(html).toContain('<meta name="supported-color-schemes" content="light"/>');

    const patched = overrideColorSchemeMeta(html);

    expect(patched).toContain('<meta name="color-scheme" content="light dark"/>');
    expect(patched).toContain('<meta name="supported-color-schemes" content="light dark"/>');
    // The bare `content="light"` (unpatched) form is gone.
    expect(patched).not.toMatch(/name="color-scheme" content="light"/);
    expect(patched).not.toMatch(/name="supported-color-schemes" content="light"/);
  });

  test("both hooks compose: footer injection + meta override survive together", async () => {
    const html = await new Maily(doc).render();
    const footer = '<div id="pw-footer">footer text</div>';

    const result = overrideColorSchemeMeta(injectBeforeBodyClose(html, footer));

    expect(result).toContain(footer);
    expect(result).toContain('content="light dark"');
  });
});
