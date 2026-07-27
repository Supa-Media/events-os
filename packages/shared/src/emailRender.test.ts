import { describe, expect, test } from "vitest";
import type { EmailBlock, EmailDocument } from "./emailBlocks";
import {
  renderCampaignEmail,
  renderCampaignText,
  safeEmailHref,
  safeImageSrc,
} from "./emailRender";
import type { EmailTheme } from "./emailTheme";
import { DEFAULT_EMAIL_THEME, WINTER_THEME } from "./emailTheme";

const baseOpts = {
  recipient: { name: "Alex Rivera", email: "alex@example.com" },
  unsubscribeUrl: "https://example.com/unsub/abc123",
};

function doc(blocks: EmailBlock[]): EmailDocument {
  return { blocks };
}

/** A document carrying an explicit theme — the shape `campaigns.ts` stores
 *  once the org's theme has been resolved into the doc. */
function themedDoc(blocks: EmailBlock[], theme: EmailTheme): EmailDocument {
  return { blocks, theme };
}

/** The rendered HTML with the entire `<style>` block removed — what a client
 *  that strips style blocks (Gmail's clipped view, some corporate gateways)
 *  actually shows the recipient. */
function withoutStyleBlock(html: string): string {
  return html.replace(/<style>[\s\S]*?<\/style>/g, "");
}

/** Just the `<style>` block's contents. */
function styleBlockOf(html: string): string {
  return /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? "";
}

describe("renderCampaignEmail — merge tags", () => {
  test("{{firstName}} substitutes the recipient's first name", () => {
    const html = renderCampaignEmail(
      doc([{ id: "1", kind: "heading", text: "Hi {{firstName}}" }]),
      baseOpts,
    );
    expect(html).toContain("Hi Alex");
  });

  test("{{name}} substitutes the recipient's full name", () => {
    const html = renderCampaignEmail(
      doc([{ id: "1", kind: "heading", text: "Hi {{name}}" }]),
      baseOpts,
    );
    expect(html).toContain("Hi Alex Rivera");
  });

  test("missing name falls back to the default 'friend'", () => {
    const html = renderCampaignEmail(
      doc([{ id: "1", kind: "heading", text: "Hi {{firstName}}" }]),
      { ...baseOpts, recipient: { name: null, email: "x@example.com" } },
    );
    expect(html).toContain("Hi friend");
  });

  test("missing name with a custom fallback uses it instead of 'friend'", () => {
    const html = renderCampaignEmail(
      doc([{ id: "1", kind: "heading", text: "Hi {{firstName|there}}" }]),
      { ...baseOpts, recipient: { name: undefined, email: "x@example.com" } },
    );
    expect(html).toContain("Hi there");
    expect(html).not.toContain("friend");
  });

  test("a custom fallback is ignored when the name IS present", () => {
    const html = renderCampaignEmail(
      doc([{ id: "1", kind: "heading", text: "Hi {{firstName|there}}" }]),
      baseOpts,
    );
    expect(html).toContain("Hi Alex");
    expect(html).not.toContain("there");
  });

  test("a fallback containing a literal '}' still substitutes fully — no raw tag leaks", () => {
    const html = renderCampaignEmail(
      doc([{ id: "1", kind: "heading", text: "{{firstName|Hi}there}}" }]),
      { ...baseOpts, recipient: { name: null, email: "x@example.com" } },
    );
    expect(html).toContain("Hi}there");
    expect(html).not.toContain("{{firstName");
  });

  test("an XSS attempt in the recipient name is escaped, not injected", () => {
    const html = renderCampaignEmail(
      doc([{ id: "1", kind: "heading", text: "Hi {{name}}" }]),
      { ...baseOpts, recipient: { name: "<script>alert(1)</script>", email: "x@example.com" } },
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("an XSS attempt in author-written markdown is escaped", () => {
    const html = renderCampaignEmail(
      doc([{ id: "1", kind: "text", markdown: "<img src=x onerror=alert(1)>" }]),
      baseOpts,
    );
    expect(html).not.toContain("<img src=x onerror=alert(1)>");
    expect(html).toContain("&lt;img");
  });

  test("merge tags substitute in button labels too", () => {
    const html = renderCampaignEmail(
      doc([{ id: "1", kind: "button", label: "Hi {{firstName}}, click", url: "https://x.test" }]),
      baseOpts,
    );
    expect(html).toContain("Hi Alex, click");
  });
});

describe("renderCampaignEmail — markdown subset", () => {
  test("bold", () => {
    const html = renderCampaignEmail(doc([{ id: "1", kind: "text", markdown: "**bold**" }]), baseOpts);
    expect(html).toContain("<strong>bold</strong>");
  });

  test("italic", () => {
    const html = renderCampaignEmail(doc([{ id: "1", kind: "text", markdown: "*italic*" }]), baseOpts);
    expect(html).toContain("<em>italic</em>");
  });

  test("link", () => {
    const html = renderCampaignEmail(
      doc([{ id: "1", kind: "text", markdown: "[click here](https://x.test/go)" }]),
      baseOpts,
    );
    expect(html).toContain('href="https://x.test/go"');
    expect(html).toContain(">click here<");
  });

  test("a link URL with one level of balanced parens isn't truncated (Wikipedia-style)", () => {
    const html = renderCampaignEmail(
      doc([
        {
          id: "1",
          kind: "text",
          markdown: "[wiki](https://en.wikipedia.org/wiki/Foo_(bar))",
        },
      ]),
      baseOpts,
    );
    expect(html).toContain('href="https://en.wikipedia.org/wiki/Foo_(bar)"');
  });

  test("nested italic inside bold renders correctly", () => {
    const html = renderCampaignEmail(
      doc([{ id: "1", kind: "text", markdown: "**bold *italic* text**" }]),
      baseOpts,
    );
    expect(html).toContain("<strong>bold <em>italic</em> text</strong>");
  });

  test("a simple '- ' list becomes a <ul>", () => {
    const html = renderCampaignEmail(
      doc([{ id: "1", kind: "text", markdown: "- one\n- two\n- three" }]),
      baseOpts,
    );
    expect(html).toContain("<ul");
    expect(html).toContain("<li>one</li>");
    expect(html).toContain("<li>two</li>");
    expect(html).toContain("<li>three</li>");
  });

  test("blank-line-separated paragraphs render as separate <p> tags", () => {
    const html = renderCampaignEmail(
      doc([{ id: "1", kind: "text", markdown: "First para.\n\nSecond para." }]),
      baseOpts,
    );
    const firstIdx = html.indexOf("First para.");
    const secondIdx = html.indexOf("Second para.");
    expect(firstIdx).toBeGreaterThan(-1);
    expect(secondIdx).toBeGreaterThan(firstIdx);
    expect(html.match(/<p /g)?.length).toBe(2);
  });
});

describe("renderCampaignEmail — every block kind", () => {
  const allKinds: EmailBlock[] = [
    { id: "1", kind: "heading", text: "Heading text", level: 2 },
    { id: "2", kind: "text", markdown: "Some text" },
    { id: "3", kind: "image", url: "https://x.test/img.png", alt: "an image", width: "half" },
    { id: "4", kind: "button", label: "Press me", url: "https://x.test/btn", align: "left" },
    { id: "5", kind: "divider" },
    { id: "6", kind: "spacer", size: "lg" },
    { id: "7", kind: "eyebrow", text: "Eyebrow text", icon: "◆" },
    {
      id: "8",
      kind: "card",
      heading: "Card heading",
      body: "Card body",
      ctaLabel: "Card CTA",
      ctaUrl: "https://x.test/card",
    },
    {
      id: "9",
      kind: "columns",
      columns: [{ heading: "Column one" }, { heading: "Column two" }],
    },
    { id: "10", kind: "quote", text: "Quote text", attribution: "Quote source" },
    {
      id: "11",
      kind: "poll",
      question: "Poll question",
      options: [
        { id: "o1", label: "Option one" },
        { id: "o2", label: "Option two" },
      ],
    },
  ];

  test("each known kind produces visible output", () => {
    const html = renderCampaignEmail(doc(allKinds), baseOpts);
    expect(html).toContain("Heading text");
    expect(html).toContain("Some text");
    expect(html).toContain("https://x.test/img.png");
    expect(html).toContain("an image");
    expect(html).toContain("Press me");
    expect(html).toContain("https://x.test/btn");
    expect(html).toContain("<hr");
    expect(html).toContain("Eyebrow text");
    expect(html).toContain("Card heading");
    expect(html).toContain("Card body");
    expect(html).toContain("Card CTA");
    expect(html).toContain("Column one");
    expect(html).toContain("Column two");
    expect(html).toContain("Quote text");
    expect(html).toContain("Quote source");
    expect(html).toContain("Poll question");
    expect(html).toContain("Option one");
    expect(html).toContain("Option two");
  });

  test("an unknown block kind renders nothing (forward compat)", () => {
    const withUnknown = [
      ...allKinds,
      { id: "7", kind: "video", url: "https://x.test/v.mp4" } as unknown as EmailBlock,
    ];
    const withKnownOnly = renderCampaignEmail(doc(allKinds), baseOpts);
    const withExtra = renderCampaignEmail(doc(withUnknown), baseOpts);
    expect(withExtra).toBe(withKnownOnly);
    expect(withExtra).not.toContain("v.mp4");
  });
});

describe("renderCampaignEmail — URL scheme allowlist (SECURITY)", () => {
  test("a javascript: button href renders as an inert '#'", () => {
    const html = renderCampaignEmail(
      doc([{ id: "1", kind: "button", label: "Click", url: "javascript:alert(1)" }]),
      baseOpts,
    );
    expect(html).toContain('href="#"');
    expect(html).not.toContain("javascript:");
  });

  test("a data: image src renders with an empty src (no image loads)", () => {
    const html = renderCampaignEmail(
      doc([
        {
          id: "1",
          kind: "image",
          url: "data:text/html,<script>alert(1)</script>",
          alt: "x",
        },
      ]),
      baseOpts,
    );
    expect(html).toContain('src=""');
    expect(html).not.toContain("data:text/html");
  });

  test("scheme matching is case-insensitive — 'JavaScript:' is still blocked", () => {
    const html = renderCampaignEmail(
      doc([{ id: "1", kind: "button", label: "Click", url: "JavaScript:alert(1)" }]),
      baseOpts,
    );
    expect(html).toContain('href="#"');
  });

  test("mailto: is allowed for a button link", () => {
    const html = renderCampaignEmail(
      doc([{ id: "1", kind: "button", label: "Email us", url: "mailto:hello@example.com" }]),
      baseOpts,
    );
    expect(html).toContain('href="mailto:hello@example.com"');
  });
});

describe("safeEmailHref / safeImageSrc (unit)", () => {
  test("safeEmailHref allows http/https/mailto, case-insensitive, trimmed", () => {
    expect(safeEmailHref(" https://x.test ")).toBe("https://x.test");
    expect(safeEmailHref("HTTP://x.test")).toBe("HTTP://x.test");
    expect(safeEmailHref("mailto:a@b.com")).toBe("mailto:a@b.com");
  });

  test("safeEmailHref rejects anything else", () => {
    expect(safeEmailHref("javascript:alert(1)")).toBe("#");
    expect(safeEmailHref("data:text/html,x")).toBe("#");
    expect(safeEmailHref("vbscript:x")).toBe("#");
    expect(safeEmailHref("not-a-url")).toBe("#");
  });

  test("safeImageSrc allows only http/https", () => {
    expect(safeImageSrc("https://x.test/a.png")).toBe("https://x.test/a.png");
    expect(safeImageSrc("http://x.test/a.png")).toBe("http://x.test/a.png");
    expect(safeImageSrc("mailto:a@b.com")).toBe("");
    expect(safeImageSrc("data:image/png;base64,xxx")).toBe("");
  });
});

describe("renderCampaignEmail — shell / footer", () => {
  test("unsubscribe link is always present", () => {
    const html = renderCampaignEmail(doc([]), baseOpts);
    expect(html).toContain(baseOpts.unsubscribeUrl);
    expect(html.toLowerCase()).toContain("unsubscribe");
  });

  test("org address renders when set", () => {
    const html = renderCampaignEmail(doc([]), { ...baseOpts, orgAddress: "123 Main St, Springfield" });
    expect(html).toContain("123 Main St, Springfield");
  });

  test("no address line junk when orgAddress is omitted", () => {
    const html = renderCampaignEmail(doc([]), baseOpts);
    expect(html).not.toContain("undefined");
    expect(html).not.toContain("null");
  });

  test("carries the Public Worship wordmark and footer copy", () => {
    const html = renderCampaignEmail(doc([]), baseOpts);
    expect(html).toContain("PUBLIC WORSHIP");
    expect(html).toContain("Sent with love by Public Worship");
  });
});

describe("renderCampaignText", () => {
  test("unsubscribe line is always present", () => {
    const text = renderCampaignText(doc([]), baseOpts);
    expect(text).toContain(baseOpts.unsubscribeUrl);
    expect(text.toLowerCase()).toContain("unsubscribe");
  });

  test("org address renders when set", () => {
    const text = renderCampaignText(doc([]), { ...baseOpts, orgAddress: "123 Main St" });
    expect(text).toContain("123 Main St");
  });

  test("heading renders as a plain line with merge tags substituted", () => {
    const text = renderCampaignText(doc([{ id: "1", kind: "heading", text: "Hi {{firstName}}" }]), baseOpts);
    expect(text).toContain("Hi Alex");
  });

  test("text block strips markdown formatting", () => {
    const text = renderCampaignText(
      doc([{ id: "1", kind: "text", markdown: "**bold** and *italic* and [a link](https://x.test)" }]),
      baseOpts,
    );
    expect(text).toContain("bold and italic and a link (https://x.test)");
    expect(text).not.toContain("**");
    expect(text).not.toContain("[a link]");
  });

  test("a button renders as 'Label: url'", () => {
    const text = renderCampaignText(
      doc([{ id: "1", kind: "button", label: "Click here", url: "https://x.test/go" }]),
      baseOpts,
    );
    expect(text).toContain("Click here: https://x.test/go");
  });

  test("images and spacers are skipped", () => {
    const text = renderCampaignText(
      doc([
        { id: "1", kind: "image", url: "https://x.test/a.png", alt: "alt text" },
        { id: "2", kind: "spacer", size: "md" },
      ]),
      baseOpts,
    );
    expect(text).not.toContain("https://x.test/a.png");
    expect(text).not.toContain("alt text");
  });

  test("no HTML entities leak into plaintext for a name with special characters", () => {
    const text = renderCampaignText(
      doc([{ id: "1", kind: "heading", text: "Hi {{name}}" }]),
      { ...baseOpts, recipient: { name: "A & B", email: "x@example.com" } },
    );
    expect(text).toContain("Hi A & B");
    expect(text).not.toContain("&amp;");
  });
});

// ── Theming ────────────────────────────────────────────────────────────────

describe("renderCampaignEmail — theming", () => {
  test("a document with NO theme renders Public Worship's real brand", () => {
    const html = renderCampaignEmail(
      doc([{ id: "1", kind: "heading", text: "Hello" }]),
      baseOpts,
    );
    expect(html).toContain("#891d1a");
    expect(html).toContain(DEFAULT_EMAIL_THEME.canvas);
  });

  test("the old invented palette is gone entirely (it was never the real brand)", () => {
    const html = renderCampaignEmail(
      doc([
        { id: "1", kind: "heading", text: "Hello" },
        { id: "2", kind: "button", label: "Go", url: "https://x.test" },
      ]),
      baseOpts,
    );
    expect(html).not.toMatch(/#d23b3a/i);
    expect(html).not.toMatch(/#fdf6f6/i);
  });

  test("a document WITH a theme renders that theme's accent and not the default's", () => {
    const html = renderCampaignEmail(
      themedDoc([{ id: "1", kind: "button", label: "Go", url: "https://x.test" }], WINTER_THEME),
      baseOpts,
    );
    expect(html).toContain(WINTER_THEME.accent);
    expect(html).toContain(WINTER_THEME.canvas);
    expect(html).not.toContain(DEFAULT_EMAIL_THEME.accent);
  });

  test("the theme's name titles the document", () => {
    const html = renderCampaignEmail(doc([]), baseOpts);
    expect(html).toContain(`<title>${DEFAULT_EMAIL_THEME.name}</title>`);
  });

  test("an empty wordmark renders no wordmark strip at all", () => {
    const html = renderCampaignEmail(
      themedDoc([], { ...DEFAULT_EMAIL_THEME, wordmark: "" }),
      baseOpts,
    );
    expect(html).not.toContain("PUBLIC WORSHIP");
    // The dark-mode rule for `.pw-mark` still exists in the <style> block;
    // what must be absent is the element that would carry it.
    expect(withoutStyleBlock(html)).not.toContain('class="pw-mark"');
  });

  test("a malformed stored theme degrades to on-brand rather than painting 'undefined'", () => {
    const html = renderCampaignEmail(
      themedDoc(
        [{ id: "1", kind: "heading", text: "Hello" }],
        { accent: "not-a-colour" } as unknown as EmailTheme,
      ),
      baseOpts,
    );
    expect(html).not.toContain("undefined");
    expect(html).toContain(DEFAULT_EMAIL_THEME.accent);
  });
});

describe("renderCampaignEmail — dark mode", () => {
  test("the <style> block carries a prefers-color-scheme: dark section", () => {
    const style = styleBlockOf(renderCampaignEmail(doc([]), baseOpts));
    expect(style).toContain("prefers-color-scheme: dark");
  });

  test("the dark section uses the theme's dark accent, not its light one", () => {
    const style = styleBlockOf(
      renderCampaignEmail(themedDoc([], WINTER_THEME), baseOpts),
    );
    const dark = style.slice(style.indexOf("prefers-color-scheme: dark"));
    expect(dark).toContain(WINTER_THEME.dark?.accent as string);
    expect(dark).toContain(WINTER_THEME.dark?.surface as string);
  });

  test("<meta name=\"color-scheme\" content=\"light dark\"> is declared", () => {
    const html = renderCampaignEmail(doc([]), baseOpts);
    expect(html).toContain('<meta name="color-scheme" content="light dark">');
    expect(html).toContain('<meta name="supported-color-schemes" content="light dark">');
  });

  test("[data-ogsc] fallbacks are emitted for clients that rewrite instead of matching the media query", () => {
    const style = styleBlockOf(renderCampaignEmail(doc([]), baseOpts));
    expect(style).toContain("[data-ogsc]");
  });

  test("every dark override is !important so it outranks the inline light style", () => {
    const style = styleBlockOf(renderCampaignEmail(doc([]), baseOpts));
    const dark = style
      .slice(style.indexOf("prefers-color-scheme: dark"), style.indexOf("[data-ogsc]"))
      .replace(/\/\*[\s\S]*?\*\//g, "");
    // Every `prop: value;` inside a rule body, comments removed.
    const declarations = dark.match(/[a-z-]+\s*:[^;{}]+;/g) ?? [];
    expect(declarations.length).toBeGreaterThan(5);
    for (const decl of declarations) {
      expect(decl, decl).toContain("!important");
    }
  });
});

describe("renderCampaignEmail — responsive", () => {
  test("breakpoints are declared for the card and for column stacking", () => {
    const style = styleBlockOf(renderCampaignEmail(doc([]), baseOpts));
    expect(style).toContain("@media only screen and (max-width:599px)");
    expect(style).toContain("@media only screen and (max-width:450px)");
  });

  test("the narrow breakpoint stacks columns to full width", () => {
    const style = styleBlockOf(renderCampaignEmail(doc([]), baseOpts));
    const stack = style.slice(style.indexOf("@media only screen and (max-width:450px)"));
    expect(stack).toContain(".pw-col");
    expect(stack).toMatch(/display:block !important/);
    expect(stack).toMatch(/width:100% !important/);
  });
});

describe("renderCampaignEmail — the inline light rendering stands alone", () => {
  const richDoc = doc([
    { id: "1", kind: "heading", text: "A heading", level: 1 },
    { id: "2", kind: "text", markdown: "Body copy with a [link](https://x.test)." },
    { id: "3", kind: "button", label: "Go", url: "https://x.test" },
    { id: "4", kind: "quote", text: "A quote", attribution: "Someone" },
    { id: "5", kind: "divider" },
  ]);

  test("a client that strips <style> still gets every theme colour inline", () => {
    const stripped = withoutStyleBlock(renderCampaignEmail(richDoc, baseOpts));
    expect(stripped).not.toContain("<style>");
    expect(stripped).toContain(DEFAULT_EMAIL_THEME.accent);
    expect(stripped).toContain(DEFAULT_EMAIL_THEME.ink);
    expect(stripped).toContain(DEFAULT_EMAIL_THEME.surface);
    expect(stripped).toContain(DEFAULT_EMAIL_THEME.canvas);
    expect(stripped).toContain(DEFAULT_EMAIL_THEME.muted);
    expect(stripped).toContain(DEFAULT_EMAIL_THEME.border);
  });

  test("a stripping client still gets the full body content and the unsubscribe link", () => {
    const stripped = withoutStyleBlock(renderCampaignEmail(richDoc, baseOpts));
    expect(stripped).toContain("A heading");
    expect(stripped).toContain("Body copy with a");
    expect(stripped).toContain("A quote");
    expect(stripped).toContain(baseOpts.unsubscribeUrl);
  });

  test("a custom theme's colours are inline too, not only in the <style> block", () => {
    const stripped = withoutStyleBlock(
      renderCampaignEmail(themedDoc(richDoc.blocks, WINTER_THEME), baseOpts),
    );
    expect(stripped).toContain(WINTER_THEME.accent);
    expect(stripped).toContain(WINTER_THEME.ink);
    expect(stripped).toContain(WINTER_THEME.surface);
  });
});

// ── Composed blocks ────────────────────────────────────────────────────────

describe("renderCampaignEmail — eyebrow", () => {
  test("renders as an uppercase accent strip", () => {
    const html = renderCampaignEmail(
      doc([{ id: "1", kind: "eyebrow", text: "This month" }]),
      baseOpts,
    );
    expect(html).toContain("This month");
    expect(html).toContain("text-transform:uppercase");
    expect(html).toContain(`color:${DEFAULT_EMAIL_THEME.accent}`);
  });

  test("an icon glyph renders before the text", () => {
    const html = renderCampaignEmail(
      doc([{ id: "1", kind: "eyebrow", text: "This month", icon: "◆" }]),
      baseOpts,
    );
    expect(html).toContain("◆");
    expect(html.indexOf("◆")).toBeLessThan(html.indexOf("This month"));
  });

  test("(SECURITY) an icon containing markup is escaped, not injected", () => {
    const html = renderCampaignEmail(
      doc([{ id: "1", kind: "eyebrow", text: "Hi", icon: "<img src=x onerror=alert(1)>" }]),
      baseOpts,
    );
    expect(html).not.toContain("<img src=x onerror=alert(1)>");
    expect(html).toContain("&lt;img");
  });

  test("merge tags substitute in eyebrow text", () => {
    const html = renderCampaignEmail(
      doc([{ id: "1", kind: "eyebrow", text: "For {{firstName}}" }]),
      baseOpts,
    );
    expect(html).toContain("For Alex");
  });
});

describe("renderCampaignEmail — card", () => {
  const card: EmailBlock = {
    id: "1",
    kind: "card",
    imageUrl: "https://x.test/hero.png",
    imageAlt: "Hero art",
    heading: "Help us keep the room open",
    body: "What giving pays for.",
    ctaLabel: "Give",
    ctaUrl: "https://x.test/give",
  };

  test("image, heading, body and CTA render in that order", () => {
    const html = renderCampaignEmail(doc([card]), baseOpts);
    const image = html.indexOf("https://x.test/hero.png");
    const heading = html.indexOf("Help us keep the room open");
    const body = html.indexOf("What giving pays for.");
    const cta = html.indexOf(">Give<");
    expect(image).toBeGreaterThan(-1);
    expect(heading).toBeGreaterThan(image);
    expect(body).toBeGreaterThan(heading);
    expect(cta).toBeGreaterThan(body);
  });

  test("the CTA renders as a themed button linking to ctaUrl", () => {
    const html = renderCampaignEmail(doc([card]), baseOpts);
    expect(html).toContain('href="https://x.test/give"');
    expect(html).toContain(`background:${DEFAULT_EMAIL_THEME.accent}`);
  });

  test("a card with only a heading renders just that — no empty image or dead button", () => {
    const html = renderCampaignEmail(
      doc([{ id: "1", kind: "card", heading: "Just a heading" }]),
      baseOpts,
    );
    expect(html).toContain("Just a heading");
    expect(html).not.toContain('<img src=""');
  });

  test("the image carries its alt text (clients block remote images by default)", () => {
    const html = renderCampaignEmail(doc([card]), baseOpts);
    expect(html).toContain('alt="Hero art"');
  });

  test("merge tags substitute in the card heading and body", () => {
    const html = renderCampaignEmail(
      doc([
        {
          id: "1",
          kind: "card",
          heading: "Hi {{firstName}}",
          body: "Thanks, {{name}}.",
        },
      ]),
      baseOpts,
    );
    expect(html).toContain("Hi Alex");
    expect(html).toContain("Thanks, Alex Rivera.");
  });

  test("(SECURITY) a card ctaUrl with a bad scheme renders as an inert '#'", () => {
    const html = renderCampaignEmail(
      doc([
        {
          id: "1",
          kind: "card",
          heading: "Card",
          ctaLabel: "Click",
          ctaUrl: "javascript:alert(1)",
        },
      ]),
      baseOpts,
    );
    expect(html).toContain('href="#"');
    expect(html).not.toContain("javascript:");
  });

  test("(SECURITY) a card imageUrl with a bad scheme renders an empty src", () => {
    const html = renderCampaignEmail(
      doc([
        {
          id: "1",
          kind: "card",
          imageUrl: "data:text/html,<script>alert(1)</script>",
          imageAlt: "x",
        },
      ]),
      baseOpts,
    );
    expect(html).toContain('src=""');
    expect(html).not.toContain("data:text/html");
  });
});

describe("renderCampaignEmail — columns", () => {
  const columns: EmailBlock = {
    id: "1",
    kind: "columns",
    columns: [
      { heading: "First event", body: "Friday." },
      { heading: "Second event", body: "Sunday." },
    ],
  };

  test("renders a presentation table (Outlook's Word engine has no flex/grid)", () => {
    const html = renderCampaignEmail(doc([columns]), baseOpts);
    expect(html).toContain("<table");
    expect(html).toContain('role="presentation"');
  });

  test("one <td> per column, each carrying the stacking class", () => {
    const html = renderCampaignEmail(doc([columns]), baseOpts);
    expect(html.match(/<td /g)).toHaveLength(2);
    expect(html.match(/class="pw-col"/g)).toHaveLength(2);
  });

  test("a three-column row renders three cells", () => {
    const html = renderCampaignEmail(
      doc([
        {
          id: "1",
          kind: "columns",
          columns: [{ heading: "A" }, { heading: "B" }, { heading: "C" }],
        },
      ]),
      baseOpts,
    );
    expect(html.match(/<td /g)).toHaveLength(3);
  });

  test("each column's content renders in order", () => {
    const html = renderCampaignEmail(doc([columns]), baseOpts);
    expect(html.indexOf("First event")).toBeLessThan(html.indexOf("Second event"));
    expect(html).toContain("Friday.");
    expect(html).toContain("Sunday.");
  });

  test("a column CTA renders as a themed button", () => {
    const html = renderCampaignEmail(
      doc([
        {
          id: "1",
          kind: "columns",
          columns: [
            { heading: "A", ctaLabel: "RSVP", ctaUrl: "https://x.test/a" },
            { heading: "B", ctaLabel: "RSVP", ctaUrl: "https://x.test/b" },
          ],
        },
      ]),
      baseOpts,
    );
    expect(html).toContain('href="https://x.test/a"');
    expect(html).toContain('href="https://x.test/b"');
  });
});

describe("renderCampaignEmail — quote", () => {
  test("the attribution renders with an em-dash", () => {
    const html = renderCampaignEmail(
      doc([{ id: "1", kind: "quote", text: "It changed the room.", attribution: "Carla" }]),
      baseOpts,
    );
    expect(html).toContain("It changed the room.");
    expect(html).toContain("— Carla");
  });

  test("no attribution renders no dangling dash", () => {
    const html = renderCampaignEmail(
      doc([{ id: "1", kind: "quote", text: "Just the words." }]),
      baseOpts,
    );
    expect(html).toContain("Just the words.");
    expect(withoutStyleBlock(html)).not.toContain("—");
    expect(html).not.toContain("pw-quote-attr\" style");
  });

  test("renders as a blockquote with an accent rule", () => {
    const html = renderCampaignEmail(
      doc([{ id: "1", kind: "quote", text: "Words." }]),
      baseOpts,
    );
    expect(html).toContain("<blockquote");
    expect(html).toContain(`border-left:3px solid ${DEFAULT_EMAIL_THEME.accent}`);
  });

  test("merge tags substitute in quote text and attribution", () => {
    const html = renderCampaignEmail(
      doc([{ id: "1", kind: "quote", text: "For {{firstName}}", attribution: "{{name}}" }]),
      baseOpts,
    );
    expect(html).toContain("For Alex");
    expect(html).toContain("— Alex Rivera");
  });
});

describe("renderCampaignEmail — poll", () => {
  const poll: EmailBlock = {
    id: "p1",
    kind: "poll",
    question: "Which night works?",
    options: [
      { id: "a", label: "Friday" },
      { id: "b", label: "Saturday" },
    ],
  };

  test("the question and one element per option render", () => {
    const html = renderCampaignEmail(doc([poll]), baseOpts);
    expect(html).toContain("Which night works?");
    expect(html.match(/class="pw-poll-opt"/g)).toHaveLength(2);
    expect(html).toContain("Friday");
    expect(html).toContain("Saturday");
  });

  test("options are INERT spans when no vote-URL builder is supplied (composer preview)", () => {
    const html = renderCampaignEmail(doc([poll]), baseOpts);
    expect(html).toContain('<span class="pw-poll-opt"');
    expect(html).not.toContain('<a class="pw-poll-opt"');
  });

  test("options become links when a vote-URL builder IS supplied", () => {
    const html = renderCampaignEmail(doc([poll]), {
      ...baseOpts,
      pollVoteUrl: (blockId, optionId) => `https://x.test/vote/${blockId}/${optionId}`,
    });
    expect(html).toContain('<a class="pw-poll-opt"');
    expect(html).not.toContain('<span class="pw-poll-opt"');
    expect(html).toContain('href="https://x.test/vote/p1/a"');
    expect(html).toContain('href="https://x.test/vote/p1/b"');
  });

  test("the builder is called once per option with (blockId, optionId)", () => {
    const calls: [string, string][] = [];
    renderCampaignEmail(doc([poll]), {
      ...baseOpts,
      pollVoteUrl: (blockId, optionId) => {
        calls.push([blockId, optionId]);
        return `https://x.test/v/${optionId}`;
      },
    });
    expect(calls).toEqual([
      ["p1", "a"],
      ["p1", "b"],
    ]);
  });

  test("(SECURITY) a builder returning a javascript: URL renders as an inert '#'", () => {
    const html = renderCampaignEmail(doc([poll]), {
      ...baseOpts,
      pollVoteUrl: () => "javascript:alert(1)",
    });
    expect(html).toContain('href="#"');
    expect(html).not.toContain("javascript:");
  });

  test("merge tags substitute in the poll question", () => {
    const html = renderCampaignEmail(
      doc([{ ...poll, question: "{{firstName}}, which night?" } as EmailBlock]),
      baseOpts,
    );
    expect(html).toContain("Alex, which night?");
  });
});

describe("renderCampaignEmail — linked images", () => {
  test("an image with href is wrapped in an anchor", () => {
    const html = renderCampaignEmail(
      doc([
        {
          id: "1",
          kind: "image",
          url: "https://x.test/art.png",
          alt: "Song artwork",
          href: "https://x.test/listen",
        },
      ]),
      baseOpts,
    );
    expect(html).toMatch(/<a href="https:\/\/x\.test\/listen"[^>]*><img /);
  });

  test("an image WITHOUT href is not wrapped in an anchor", () => {
    const html = renderCampaignEmail(
      doc([{ id: "1", kind: "image", url: "https://x.test/art.png", alt: "Song artwork" }]),
      baseOpts,
    );
    expect(html).toContain("<img ");
    expect(html).not.toMatch(/<a [^>]*><img /);
  });

  test("(SECURITY) a javascript: image href renders as an inert '#'", () => {
    const html = renderCampaignEmail(
      doc([
        {
          id: "1",
          kind: "image",
          url: "https://x.test/art.png",
          alt: "art",
          href: "javascript:alert(1)",
        },
      ]),
      baseOpts,
    );
    expect(html).toMatch(/<a href="#"[^>]*><img /);
    expect(html).not.toContain("javascript:");
  });
});

describe("renderCampaignEmail — theme injection (SECURITY)", () => {
  /** A theme that bypassed `validateEmailTheme` (a direct DB write, an import
   *  script, a document written before the gate existed). The renderer must
   *  still not let it escape either the `style=` attribute or the `<style>`
   *  block, where HTML entities are NOT decoded and escaping is no defense. */
  const maliciousTheme = {
    ...DEFAULT_EMAIL_THEME,
    bodyFont: "Inter;}</style><script>alert(1)</script>{x:y",
    headingFont: "Georgia;}body{display:none",
  } as unknown as EmailTheme;

  test("a malicious font stack cannot close the <style> block", () => {
    const html = renderCampaignEmail(
      themedDoc([{ id: "1", kind: "heading", text: "Hi" }], maliciousTheme),
      baseOpts,
    );
    expect(html.match(/<style>/g)).toHaveLength(1);
    expect(html.match(/<\/style>/g)).toHaveLength(1);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("alert(1)");
  });

  test("a malicious font stack cannot open a new CSS rule inside a style attribute", () => {
    const html = renderCampaignEmail(
      themedDoc([{ id: "1", kind: "heading", text: "Hi" }], maliciousTheme),
      baseOpts,
    );
    for (const styleAttr of html.match(/style="[^"]*"/g) ?? []) {
      expect(styleAttr).not.toContain("{");
      expect(styleAttr).not.toContain("}");
      expect(styleAttr).not.toContain("<");
    }
  });

  test("a malicious wordmark is HTML-escaped in the strip", () => {
    const html = renderCampaignEmail(
      themedDoc([], {
        ...DEFAULT_EMAIL_THEME,
        wordmark: "<script>alert(1)</script>",
      }),
      baseOpts,
    );
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

// ── Plaintext for the composed blocks ──────────────────────────────────────

describe("renderCampaignText — composed blocks", () => {
  test("an eyebrow renders uppercased", () => {
    const text = renderCampaignText(
      doc([{ id: "1", kind: "eyebrow", text: "What's on", icon: "◆" }]),
      baseOpts,
    );
    expect(text).toContain("WHAT'S ON");
  });

  test("a card renders heading, body and 'CTA: url'", () => {
    const text = renderCampaignText(
      doc([
        {
          id: "1",
          kind: "card",
          imageUrl: "https://x.test/hero.png",
          imageAlt: "Hero",
          heading: "Help us",
          body: "**Concrete** beats general.",
          ctaLabel: "Give",
          ctaUrl: "https://x.test/give",
        },
      ]),
      baseOpts,
    );
    expect(text).toContain("Help us");
    expect(text).toContain("Concrete beats general.");
    expect(text).not.toContain("**");
    expect(text).toContain("Give: https://x.test/give");
    // The card's decorative image isn't a destination a reader can act on.
    expect(text).not.toContain("https://x.test/hero.png");
  });

  test("an empty card contributes nothing rather than a blank line", () => {
    const text = renderCampaignText(doc([{ id: "1", kind: "card" }]), baseOpts);
    expect(text).not.toContain("undefined");
    expect(text).not.toContain("null");
  });

  test("columns render one after another, in order", () => {
    const text = renderCampaignText(
      doc([
        {
          id: "1",
          kind: "columns",
          columns: [
            { heading: "First event", body: "Friday." },
            { heading: "Second event", body: "Sunday." },
          ],
        },
      ]),
      baseOpts,
    );
    expect(text.indexOf("First event")).toBeLessThan(text.indexOf("Second event"));
    expect(text).toContain("Friday.");
    expect(text).toContain("Sunday.");
  });

  test("a quote renders in quotation marks with an em-dashed attribution", () => {
    const text = renderCampaignText(
      doc([{ id: "1", kind: "quote", text: "It changed the room.", attribution: "Carla" }]),
      baseOpts,
    );
    expect(text).toContain('"It changed the room."');
    expect(text).toContain("— Carla");
  });

  test("a poll lists its options WITHOUT urls when no builder is given", () => {
    const text = renderCampaignText(
      doc([
        {
          id: "p1",
          kind: "poll",
          question: "Which night?",
          options: [
            { id: "a", label: "Friday" },
            { id: "b", label: "Saturday" },
          ],
        },
      ]),
      baseOpts,
    );
    expect(text).toContain("Which night?");
    expect(text).toContain("• Friday");
    expect(text).toContain("• Saturday");
    // No invented vote link — the only URL in the message is the unsubscribe.
    expect(text).not.toMatch(/• (Friday|Saturday):/);
    expect(text.match(/https?:\/\//g)).toHaveLength(1);
  });

  test("a poll lists its options WITH urls when a builder is given", () => {
    const text = renderCampaignText(
      doc([
        {
          id: "p1",
          kind: "poll",
          question: "Which night?",
          options: [
            { id: "a", label: "Friday" },
            { id: "b", label: "Saturday" },
          ],
        },
      ]),
      {
        ...baseOpts,
        pollVoteUrl: (blockId, optionId) => `https://x.test/vote/${blockId}/${optionId}`,
      },
    );
    expect(text).toContain("• Friday: https://x.test/vote/p1/a");
    expect(text).toContain("• Saturday: https://x.test/vote/p1/b");
  });

  test("a LINKED image contributes its destination — a plaintext reader would otherwise never see it", () => {
    const text = renderCampaignText(
      doc([
        {
          id: "1",
          kind: "image",
          url: "https://x.test/art.png",
          alt: "Song artwork",
          href: "https://x.test/listen",
        },
      ]),
      baseOpts,
    );
    expect(text).toContain("Song artwork: https://x.test/listen");
  });

  test("a bare image still contributes nothing", () => {
    const text = renderCampaignText(
      doc([{ id: "1", kind: "image", url: "https://x.test/art.png", alt: "Song artwork" }]),
      baseOpts,
    );
    expect(text).not.toContain("Song artwork");
    expect(text).not.toContain("https://x.test/art.png");
  });

  test("merge tags substitute inside the composed blocks", () => {
    const text = renderCampaignText(
      doc([
        { id: "1", kind: "eyebrow", text: "for {{firstName}}" },
        { id: "2", kind: "card", heading: "Hi {{firstName}}", body: "Thanks {{name}}." },
        { id: "3", kind: "quote", text: "Said to {{firstName}}", attribution: "{{name}}" },
      ]),
      baseOpts,
    );
    expect(text).toContain("FOR ALEX");
    expect(text).toContain("Hi Alex");
    expect(text).toContain("Thanks Alex Rivera.");
    expect(text).toContain("Said to Alex");
    expect(text).toContain("— Alex Rivera");
  });

  test("an unknown block kind contributes nothing to plaintext (forward compat)", () => {
    const known = renderCampaignText(doc([{ id: "1", kind: "divider" }]), baseOpts);
    const withUnknown = renderCampaignText(
      doc([
        { id: "1", kind: "divider" },
        { id: "2", kind: "video", url: "https://x.test/v.mp4" } as unknown as EmailBlock,
      ]),
      baseOpts,
    );
    expect(withUnknown).toBe(known);
  });
});
