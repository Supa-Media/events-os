/**
 * WS0 spike, Bet 2: "the vendored renderer renders in a Convex default-isolate".
 *
 * This suite runs under `environment: "edge-runtime"` (see `vitest.config.ts`
 * in this package), the same `@edge-runtime/vm` sandbox `apps/convex`'s own
 * `vitest.config.ts` uses for `convex-test` — Web APIs only, no Node globals
 * (no `fs`, no `process` beyond what `@edge-runtime/vm` shims). If `Maily`'s
 * `.render()` works here, it approximates working inside a real Convex
 * default-isolate action; see `docs/plans/maily-editor-overhaul.md`'s "The
 * spike verifies end-to-end render inside a Convex default-isolate action;
 * the known risk is `juice`… If the isolate fails, fallback is a `"use node"`
 * render action per batch."
 */
import { describe, expect, test } from "vitest";
import { Maily } from "./maily";
import type { JSONContent } from "@tiptap/core";

/**
 * One doc exercising every node type Bet 2 asked for: paragraph, heading,
 * a section with `backgroundColor`, an image, a button, and a `variable`
 * node substituted via `setVariableValues` (not the convenience `render()`
 * export, which per `render.ts`'s own note has no way to pass variables —
 * this is the real per-recipient send-loop shape the plan describes).
 */
const doc: JSONContent = {
  type: "doc",
  content: [
    {
      type: "heading",
      attrs: { level: 1 },
      content: [{ type: "text", text: "Hello, " }, { type: "variable", attrs: { id: "name", fallback: "friend" } }],
    },
    {
      type: "paragraph",
      content: [{ type: "text", text: "WS0 spike paragraph." }],
    },
    {
      type: "section",
      attrs: { backgroundColor: "#FEF08A" },
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Inside a yellow section." }],
        },
        {
          type: "image",
          attrs: { src: "https://example.com/logo.png", alt: "logo", width: 200 },
        },
        {
          type: "button",
          attrs: { text: "Click me", url: "https://example.com/click", variant: "filled" },
        },
      ],
    },
  ],
};

describe("WS0 spike Bet 2: vendored @events-os/email-render under edge-runtime", () => {
  test("renders HTML with variable substitution, section background, image, and button", async () => {
    const maily = new Maily(doc);
    maily.setVariableValues({ name: "John Doe" });
    const html = await maily.render();

    // Variable substitution.
    expect(html).toContain("Hello,");
    expect(html).toContain("John Doe");
    expect(html).not.toContain("{{name");

    // Section `backgroundColor` reached the output.
    expect(html).toContain("#FEF08A");

    // Image.
    expect(html).toContain("https://example.com/logo.png");
    expect(html).toContain('alt="logo"');

    // Button (react-email's <Button> renders an anchor styled as a button).
    expect(html).toContain("https://example.com/click");
    expect(html).toContain("Click me");

    // It's a full HTML document, not a fragment — this is what
    // `injectBeforeBodyClose`-style postprocessing (Bet 3) assumes.
    expect(html).toMatch(/<html/i);
    expect(html).toContain("</body>");
  });

  test("plainText: true produces a text part with variables substituted", async () => {
    const maily = new Maily(doc);
    maily.setVariableValues({ name: "John Doe" });
    const text = await maily.render({ plainText: true });

    // html-to-text (react-email's plain-text converter) uppercases <h1>
    // content by design — assert case-insensitively rather than assume HTML
    // casing survives into the text part.
    expect(text.toLowerCase()).toContain("hello,");
    expect(text.toLowerCase()).toContain("john doe");
    expect(text).not.toContain("{{name");
    // A plain-text part must not carry HTML markup.
    expect(text).not.toMatch(/<[a-z][\s\S]*>/i);
  });

  test("htmlCodeBlock (the only call site of `juice`) actually inlines CSS under edge-runtime", async () => {
    // The plan's stated risk is specifically juice "reaching for Node APIs" —
    // the two tests above only prove `import juice from "juice"` doesn't
    // throw at module load. This exercises the ONE method that calls
    // `juice(text)` (see maily.tsx's `htmlCodeBlock`), so a Node-API reach
    // inside juice's actual inlining logic (not just its module top level)
    // would surface here.
    const htmlCodeBlockDoc: JSONContent = {
      type: "doc",
      content: [
        {
          type: "htmlCodeBlock",
          content: [
            {
              type: "text",
              text: '<html><head><style>.pw { color: red; }</style></head><body><p class="pw">inlined?</p></body></html>',
            },
          ],
        },
      ],
    };

    const html = await new Maily(htmlCodeBlockDoc).render();

    // juice() must have moved the `.pw` rule from <style> onto the element's
    // `style` attribute — that's what "inlines CSS" means. If juice silently
    // no-op'd (or threw and got swallowed somewhere upstream) this would
    // fail; if it threw uncaught, this whole test would fail to complete.
    expect(html).toContain("inlined?");
    expect(html).toMatch(/style="[^"]*color:\s*red/);
  });
});
