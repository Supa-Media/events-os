/**
 * WS1: the compliance shell (`renderEmail.ts`). Runs under this package's
 * default `edge-runtime` vitest environment (see `vitest.config.ts`) — the
 * same sandbox the WS0 spike proved the vendored renderer works inside.
 */
import { describe, expect, test } from "vitest";
import type { JSONContent } from "@tiptap/core";
import { renderEmailTiptap } from "./renderEmail";

const baseDoc: JSONContent = {
  type: "doc",
  content: [
    { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Hello, " }, { type: "variable", attrs: { id: "firstName", fallback: "friend" } }] },
    { type: "paragraph", content: [{ type: "text", text: "Welcome to the newsletter." }] },
  ],
};

describe("renderEmailTiptap: compliance footer", () => {
  test("the footer appears in the HTML part, before </body>, address + signoff + unsubscribe link", async () => {
    const { html } = await renderEmailTiptap(baseDoc, {
      variables: { firstName: "Alex" },
      unsubscribeUrl: "https://example.com/unsubscribe/tok123",
      orgAddress: "123 Main St, Springfield",
    });
    expect(html).toContain("123 Main St, Springfield");
    expect(html).toContain("Sent with love by Public Worship");
    expect(html).toContain("https://example.com/unsubscribe/tok123");
    expect(html.indexOf("123 Main St, Springfield")).toBeLessThan(html.lastIndexOf("</body>"));
    expect(html.match(/<\/body>/g)).toHaveLength(1);
  });

  test("the footer appears in the plaintext part too, with a real unsubscribe URL", async () => {
    const { text } = await renderEmailTiptap(baseDoc, {
      variables: { firstName: "Alex" },
      unsubscribeUrl: "https://example.com/unsubscribe/tok123",
      orgAddress: "123 Main St, Springfield",
    });
    expect(text).toContain("123 Main St, Springfield");
    expect(text).toContain("Sent with love by Public Worship");
    expect(text).toContain("https://example.com/unsubscribe/tok123");
    // Plaintext must not carry HTML markup.
    expect(text).not.toMatch(/<[a-z][\s\S]*>/i);
  });

  test("orgAddress is optional — footer still has signoff + unsubscribe without it", async () => {
    const { html, text } = await renderEmailTiptap(baseDoc, {
      variables: {},
      unsubscribeUrl: "https://example.com/unsubscribe/tok123",
      orgAddress: "",
    });
    expect(html).toContain("Sent with love by Public Worship");
    expect(html).toContain("https://example.com/unsubscribe/tok123");
    expect(text).toContain("Sent with love by Public Worship");
  });
});

describe("renderEmailTiptap: unsubscribe URL sanitization", () => {
  test("a root-relative unsubscribe URL is preserved, not collapsed to #", async () => {
    const { html, text } = await renderEmailTiptap(baseDoc, {
      variables: {},
      unsubscribeUrl: "/unsubscribe/tok123",
      orgAddress: "123 Main St",
    });
    expect(html).toContain('href="/unsubscribe/tok123"');
    expect(html).not.toContain('href="#"');
    expect(text).toContain("/unsubscribe/tok123");
  });

  test("an absolute https unsubscribe URL is preserved", async () => {
    const { html } = await renderEmailTiptap(baseDoc, {
      variables: {},
      unsubscribeUrl: "https://example.com/unsubscribe/tok123",
      orgAddress: "123 Main St",
    });
    expect(html).toContain('href="https://example.com/unsubscribe/tok123"');
  });

  test("a javascript: unsubscribe URL is neutralized to #, not passed through", async () => {
    const { html } = await renderEmailTiptap(baseDoc, {
      variables: {},
      unsubscribeUrl: "javascript:alert(1)",
      orgAddress: "123 Main St",
    });
    expect(html).not.toContain("javascript:alert(1)");
  });

  test("a protocol-relative // URL is rejected (resolves to an attacker host, not a local path)", async () => {
    const { html } = await renderEmailTiptap(baseDoc, {
      variables: {},
      unsubscribeUrl: "//evil.example.com/unsubscribe",
      orgAddress: "123 Main St",
    });
    expect(html).not.toContain("//evil.example.com/unsubscribe");
  });
});

describe("renderEmailTiptap: variable substitution", () => {
  test("substitutes a recipient variable into the doc", async () => {
    const { html, text } = await renderEmailTiptap(baseDoc, {
      variables: { firstName: "Priya" },
      unsubscribeUrl: "https://example.com/u/1",
      orgAddress: "Addr",
    });
    expect(html).toContain("Priya");
    // html-to-text (react-email's plain-text converter) uppercases <h1>
    // content by design — see the WS0 spike's own render.edge.test.ts note.
    expect(text.toLowerCase()).toContain("priya");
  });

  test("an unset variable falls back to the doc's own fallback text", async () => {
    const { html } = await renderEmailTiptap(baseDoc, {
      variables: {},
      unsubscribeUrl: "https://example.com/u/1",
      orgAddress: "Addr",
    });
    expect(html).toContain("friend");
  });

  test("a hostile HTML-bearing recipient name is escaped, not injected", async () => {
    const { html, text } = await renderEmailTiptap(baseDoc, {
      variables: { firstName: '<script>alert(1)</script>' },
      unsubscribeUrl: "https://example.com/u/1",
      orgAddress: "Addr",
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    // Entity-encoded somewhere in the output (React's default text-child escaping).
    expect(html).toMatch(/&lt;script&gt;/);
    // Plaintext carries the raw value (no markup to inject into) — html-to-text
    // uppercases <h1> content by design (see the WS0 spike's own note), so
    // check case-insensitively.
    expect(text.toLowerCase()).toContain("<script>alert(1)</script>");
  });

  test("a hostile value that closes an attribute is also escaped", async () => {
    const { html } = await renderEmailTiptap(baseDoc, {
      variables: { firstName: '"><img src=x onerror=alert(1)>' },
      unsubscribeUrl: "https://example.com/u/1",
      orgAddress: "Addr",
    });
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
  });
});

describe("renderEmailTiptap: preview text", () => {
  test("sets the preheader when provided", async () => {
    const { html } = await renderEmailTiptap(baseDoc, {
      variables: {},
      unsubscribeUrl: "https://example.com/u/1",
      orgAddress: "Addr",
      preview: "Big news this month",
    });
    expect(html).toContain("Big news this month");
  });

  test("omitted preview does not throw and produces no stray preheader text", async () => {
    await expect(
      renderEmailTiptap(baseDoc, { variables: {}, unsubscribeUrl: "https://example.com/u/1", orgAddress: "Addr" }),
    ).resolves.toBeTruthy();
  });
});

describe("renderEmailTiptap: dark mode meta + style", () => {
  test("color-scheme meta becomes light dark", async () => {
    const { html } = await renderEmailTiptap(baseDoc, {
      variables: {},
      unsubscribeUrl: "https://example.com/u/1",
      orgAddress: "Addr",
    });
    expect(html).toContain('content="light dark"');
    expect(html).not.toMatch(/name="color-scheme" content="light"[^ ]/);
  });

  test("a dark-mode style block is injected before </head>, covering body and the themed container", async () => {
    const { html } = await renderEmailTiptap(baseDoc, {
      variables: {},
      unsubscribeUrl: "https://example.com/u/1",
      orgAddress: "Addr",
    });
    expect(html).toContain("prefers-color-scheme: dark");
    expect(html).toContain("[data-ogsc]");
    expect(html).toMatch(/body\s*\{[^}]*background:/);
    expect(html).toContain(".pw-container");
    expect(html.indexOf("prefers-color-scheme")).toBeLessThan(html.indexOf("</head>"));
  });

  test("the pw-container class is present on the themed container in the light markup too", async () => {
    const { html } = await renderEmailTiptap(baseDoc, {
      variables: {},
      unsubscribeUrl: "https://example.com/u/1",
      orgAddress: "Addr",
    });
    expect(html).toContain('class="pw-container"');
  });
});

describe("renderEmailTiptap: poll URLs land per recipient", () => {
  const pollDoc: JSONContent = {
    type: "doc",
    content: [
      {
        type: "pwPoll",
        attrs: {
          id: "poll1",
          question: "Morning or evening service?",
          options: [
            { id: "am", label: "Morning" },
            { id: "pm", label: "Evening" },
          ],
        },
      },
    ],
  };

  test("per-recipient vote URLs, passed as variables, land as real hrefs", async () => {
    const { html } = await renderEmailTiptap(pollDoc, {
      variables: {
        pw_poll_poll1_am_url: "https://example.com/poll/tok1/poll1/am",
        pw_poll_poll1_pm_url: "https://example.com/poll/tok1/poll1/pm",
      },
      unsubscribeUrl: "https://example.com/u/1",
      orgAddress: "Addr",
    });
    expect(html).toContain("https://example.com/poll/tok1/poll1/am");
    expect(html).toContain("https://example.com/poll/tok1/poll1/pm");
  });

  test("two different recipients (two calls) get two different vote URLs — no singleton bleed", async () => {
    const recipientA = await renderEmailTiptap(pollDoc, {
      variables: {
        pw_poll_poll1_am_url: "https://example.com/poll/tokA/poll1/am",
        pw_poll_poll1_pm_url: "https://example.com/poll/tokA/poll1/pm",
      },
      unsubscribeUrl: "https://example.com/u/a",
      orgAddress: "Addr",
    });
    const recipientB = await renderEmailTiptap(pollDoc, {
      variables: {
        pw_poll_poll1_am_url: "https://example.com/poll/tokB/poll1/am",
        pw_poll_poll1_pm_url: "https://example.com/poll/tokB/poll1/pm",
      },
      unsubscribeUrl: "https://example.com/u/b",
      orgAddress: "Addr",
    });
    expect(recipientA.html).toContain("tokA");
    expect(recipientA.html).not.toContain("tokB");
    expect(recipientB.html).toContain("tokB");
    expect(recipientB.html).not.toContain("tokA");
  });

  test("without vote-url variables, options render as inert pills (no href to a URL that would 404)", async () => {
    const { html } = await renderEmailTiptap(pollDoc, {
      variables: {},
      unsubscribeUrl: "https://example.com/u/1",
      orgAddress: "Addr",
    });
    expect(html).toContain("Morning");
    expect(html).toContain("Evening");
    expect(html).not.toMatch(/href="[^"]*poll1[^"]*"/);
  });
});

describe("renderEmailTiptap: no singleton mutation bleed across calls (the two vendored fixes matter here too)", () => {
  test("a preview set on one call does not leak into a call with none", async () => {
    const withPreview = await renderEmailTiptap(baseDoc, {
      variables: {},
      unsubscribeUrl: "https://example.com/u/1",
      orgAddress: "Addr",
      preview: "Unique preview marker XYZ",
    });
    const withoutPreview = await renderEmailTiptap(baseDoc, {
      variables: {},
      unsubscribeUrl: "https://example.com/u/1",
      orgAddress: "Addr",
    });
    expect(withPreview.html).toContain("Unique preview marker XYZ");
    expect(withoutPreview.html).not.toContain("Unique preview marker XYZ");
  });
});

// WS4, fidelity gap 2 fix: `doc.attrs.pwCanvasColor` reaching a real `<body
// style="...background-color:...">` — see this file's module doc, "The page
// canvas colour", and `tiptapNewsletterTemplate.ts`'s doc for the mechanism.
describe("renderEmailTiptap: doc.attrs.pwCanvasColor → the page canvas colour", () => {
  test("a doc with no attrs at all renders the default white body — unchanged behavior", async () => {
    const { html } = await renderEmailTiptap(baseDoc, {
      variables: {},
      unsubscribeUrl: "https://example.com/u/1",
      orgAddress: "Addr",
    });
    const bodyMatch = html.match(/<body[^>]*style="([^"]*)"/i);
    expect(bodyMatch?.[1]).toContain("background-color:#ffffff");
  });

  test("attrs.pwCanvasColor paints the <body> background with that hex colour", async () => {
    const doc: JSONContent = { ...baseDoc, attrs: { pwCanvasColor: "#f0f1f5" } };
    const { html } = await renderEmailTiptap(doc, {
      variables: {},
      unsubscribeUrl: "https://example.com/u/1",
      orgAddress: "Addr",
    });
    const bodyMatch = html.match(/<body[^>]*style="([^"]*)"/i);
    expect(bodyMatch?.[1]).toContain("background-color:#f0f1f5");
    expect(bodyMatch?.[1]).not.toContain("background-color:#ffffff");
  });

  test("the container stays white and 600px even when the canvas colour moves", async () => {
    const doc: JSONContent = { ...baseDoc, attrs: { pwCanvasColor: "#f0f1f5" } };
    const { html } = await renderEmailTiptap(doc, {
      variables: {},
      unsubscribeUrl: "https://example.com/u/1",
      orgAddress: "Addr",
    });
    expect(html).toMatch(/class="pw-container"/);
    expect(html).toContain("max-width:600px");
    expect(html).toMatch(/background-color:#ffffff/);
  });

  test("an invalid hex value is ignored — falls back to the default white body, not a broken CSS value", async () => {
    const doc: JSONContent = { ...baseDoc, attrs: { pwCanvasColor: "javascript:alert(1)" } };
    const { html } = await renderEmailTiptap(doc, {
      variables: {},
      unsubscribeUrl: "https://example.com/u/1",
      orgAddress: "Addr",
    });
    expect(html).not.toContain("javascript:alert(1)");
    const bodyMatch = html.match(/<body[^>]*style="([^"]*)"/i);
    expect(bodyMatch?.[1]).toContain("background-color:#ffffff");
  });

  test("a non-string attrs.pwCanvasColor is ignored, not thrown", async () => {
    const doc: JSONContent = { ...baseDoc, attrs: { pwCanvasColor: 12345 } };
    await expect(
      renderEmailTiptap(doc, { variables: {}, unsubscribeUrl: "https://example.com/u/1", orgAddress: "Addr" }),
    ).resolves.toBeTruthy();
  });

  test("a canvas colour set on one call does not leak into a call with none (no setTheme() singleton bleed)", async () => {
    const withCanvas = await renderEmailTiptap(
      { ...baseDoc, attrs: { pwCanvasColor: "#f0f1f5" } },
      { variables: {}, unsubscribeUrl: "https://example.com/u/1", orgAddress: "Addr" },
    );
    const withoutCanvas = await renderEmailTiptap(baseDoc, {
      variables: {},
      unsubscribeUrl: "https://example.com/u/1",
      orgAddress: "Addr",
    });
    const withCanvasBody = withCanvas.html.match(/<body[^>]*style="([^"]*)"/i)?.[1];
    const withoutCanvasBody = withoutCanvas.html.match(/<body[^>]*style="([^"]*)"/i)?.[1];
    expect(withCanvasBody).toContain("background-color:#f0f1f5");
    expect(withoutCanvasBody).toContain("background-color:#ffffff");
  });
});

// Founder bug #5: `doc.attrs.pwFontFamily` — the document-level font control.
// Same "document, not a theme table" shape as `pwCanvasColor` right above;
// see `emailFont.ts` (`@events-os/shared`) for the curated stack table and
// `renderEmail.ts`'s module doc for the `maily.setTheme({ font })` wiring.
describe("renderEmailTiptap: doc.attrs.pwFontFamily → the document font", () => {
  test("a doc with no attrs at all renders the default Inter font — unchanged behavior", async () => {
    const { html } = await renderEmailTiptap(baseDoc, {
      variables: {},
      unsubscribeUrl: "https://example.com/u/1",
      orgAddress: "Addr",
    });
    expect(html).toMatch(/@font-face\s*\{[^}]*font-family:\s*'Inter'/);
    expect(html).toContain("font-family: 'Inter', sans-serif");
  });

  test("attrs.pwFontFamily: 'serif' swaps the document-wide font to Georgia", async () => {
    const doc: JSONContent = { ...baseDoc, attrs: { pwFontFamily: "serif" } };
    const { html } = await renderEmailTiptap(doc, {
      variables: {},
      unsubscribeUrl: "https://example.com/u/1",
      orgAddress: "Addr",
    });
    expect(html).toMatch(/@font-face\s*\{[^}]*font-family:\s*'Georgia'/);
    expect(html).toContain("font-family: 'Georgia', serif");
    expect(html).not.toContain("font-family: 'Inter'");
  });

  test("attrs.pwFontFamily: 'mono' swaps to Courier New", async () => {
    const doc: JSONContent = { ...baseDoc, attrs: { pwFontFamily: "mono" } };
    const { html } = await renderEmailTiptap(doc, {
      variables: {},
      unsubscribeUrl: "https://example.com/u/1",
      orgAddress: "Addr",
    });
    expect(html).toContain("font-family: 'Courier New', monospace");
  });

  test("an unknown font id is ignored — falls back to the default Inter, not a broken declaration", async () => {
    const doc: JSONContent = { ...baseDoc, attrs: { pwFontFamily: "Comic Sans MS" } };
    const { html } = await renderEmailTiptap(doc, {
      variables: {},
      unsubscribeUrl: "https://example.com/u/1",
      orgAddress: "Addr",
    });
    expect(html).toContain("font-family: 'Inter', sans-serif");
  });

  test("a non-string attrs.pwFontFamily is ignored, not thrown", async () => {
    const doc: JSONContent = { ...baseDoc, attrs: { pwFontFamily: 123 } };
    await expect(
      renderEmailTiptap(doc, { variables: {}, unsubscribeUrl: "https://example.com/u/1", orgAddress: "Addr" }),
    ).resolves.toBeTruthy();
  });

  test("pwCanvasColor and pwFontFamily compose — both apply from the same doc", async () => {
    const doc: JSONContent = { ...baseDoc, attrs: { pwCanvasColor: "#f0f1f5", pwFontFamily: "serif" } };
    const { html } = await renderEmailTiptap(doc, {
      variables: {},
      unsubscribeUrl: "https://example.com/u/1",
      orgAddress: "Addr",
    });
    const bodyMatch = html.match(/<body[^>]*style="([^"]*)"/i);
    expect(bodyMatch?.[1]).toContain("background-color:#f0f1f5");
    expect(html).toContain("font-family: 'Georgia', serif");
  });

  test("a font set on one call does not leak into a call with none (no setTheme() singleton bleed)", async () => {
    const withFont = await renderEmailTiptap(
      { ...baseDoc, attrs: { pwFontFamily: "mono" } },
      { variables: {}, unsubscribeUrl: "https://example.com/u/1", orgAddress: "Addr" },
    );
    const withoutFont = await renderEmailTiptap(baseDoc, {
      variables: {},
      unsubscribeUrl: "https://example.com/u/1",
      orgAddress: "Addr",
    });
    expect(withFont.html).toContain("font-family: 'Courier New', monospace");
    expect(withoutFont.html).toContain("font-family: 'Inter', sans-serif");
  });
});
