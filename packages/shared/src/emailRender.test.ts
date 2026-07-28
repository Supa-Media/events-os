import { describe, expect, test } from "vitest";
import type { EmailBlock, EmailDocument } from "./emailBlocks";
import {
  renderCampaignEmail,
  renderCampaignText,
  safeEmailHref,
  safeImageSrc,
  safeUnsubscribeHref,
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

/** The inline `style="…"` of the first element carrying `cls`. Several fills
 *  (`surface`, `contrastInk`) are plain white, so "the document contains this
 *  hex somewhere" proves nothing — these assertions have to look at the
 *  element that is supposed to be painted. */
function styleOfClass(html: string, cls: string): string {
  return new RegExp(`class="${cls}"[^>]*?\\sstyle="([^"]*)"`).exec(html)?.[1] ?? "";
}

/** Every `width:NN%` on a column cell, in document order. */
function columnWidths(html: string): string[] {
  return [...html.matchAll(/class="pw-col" width="([^"]*)"/g)].map((m) => m[1]);
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
    { id: "12", kind: "bleed_image", url: "https://x.test/bleed.png", alt: "a banner" },
    { id: "13", kind: "hairline" },
    {
      id: "14",
      kind: "footer",
      navLine: "Footer nav line",
      links: [{ label: "Footer link", url: "https://x.test/social" }],
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
    expect(html).toContain("https://x.test/bleed.png");
    expect(html).toContain("a banner");
    // The hairline is a 1px filled band, distinct from `divider`'s <hr>.
    expect(html).toContain("height:1px;line-height:1px");
    expect(html).toContain("Footer nav line");
    expect(html).toContain("Footer link");
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

  // The unsubscribe href was the ONE href in this file that was escaped but
  // never scheme-checked, on both of its two paths (the `footer` block's own
  // legal row, and the fallback footer a document without a footer block
  // gets). Escaping stops the attribute break-out; it does nothing about
  // `javascript:`, which survived intact into the href.
  const unsubBlocks: Array<[string, EmailBlock[]]> = [
    ["the fallback footer", []],
    ["a footer block", [{ id: "f", kind: "footer", navLine: "Events" }]],
  ];
  for (const [label, blocks] of unsubBlocks) {
    test(`a javascript: unsubscribeUrl renders as an inert '#' in ${label}`, () => {
      const html = renderCampaignEmail(doc(blocks), {
        ...baseOpts,
        unsubscribeUrl: "javascript:alert(1)",
      });
      expect(html).not.toContain("javascript:");
      expect(html).toContain('href="#"');
    });

    test(`a normal unsubscribeUrl is untouched in ${label}`, () => {
      const html = renderCampaignEmail(doc(blocks), baseOpts);
      expect(html).toContain(`href="${baseOpts.unsubscribeUrl}"`);
    });

    test(`a ROOT-RELATIVE unsubscribeUrl survives in ${label}`, () => {
      // `lib/siteUrl.ts` returns "" with no PUBLIC_SITE_URL/CONVEX_SITE_URL,
      // so the call sites really do produce `/unsubscribe/<token>`. Collapsing
      // that to "#" would delete the legally required visible opt-out.
      const html = renderCampaignEmail(doc(blocks), {
        ...baseOpts,
        unsubscribeUrl: "/unsubscribe/tok123",
      });
      expect(html).toContain('href="/unsubscribe/tok123"');
    });

    test(`a PROTOCOL-relative unsubscribeUrl is rejected in ${label}`, () => {
      // `//evil.test/x` looks like a path and resolves to another host.
      for (const url of ["//evil.test/u", "/\\evil.test/u"]) {
        const html = renderCampaignEmail(doc(blocks), { ...baseOpts, unsubscribeUrl: url });
        expect(html).not.toContain("evil.test");
        expect(html).toContain('href="#"');
      }
    });
  }
});

describe("safeUnsubscribeHref (unit)", () => {
  test("passes through the schemes safeEmailHref allows", () => {
    expect(safeUnsubscribeHref("https://x.test/u")).toBe("https://x.test/u");
    expect(safeUnsubscribeHref(" http://x.test/u ")).toBe("http://x.test/u");
  });

  test("passes through a single-slash root-relative path", () => {
    expect(safeUnsubscribeHref("/unsubscribe/tok")).toBe("/unsubscribe/tok");
  });

  test("rejects protocol-relative and dangerous schemes", () => {
    expect(safeUnsubscribeHref("//evil.test/u")).toBe("#");
    expect(safeUnsubscribeHref("/\\evil.test/u")).toBe("#");
    expect(safeUnsubscribeHref("javascript:alert(1)")).toBe("#");
    expect(safeUnsubscribeHref("data:text/html,x")).toBe("#");
    expect(safeUnsubscribeHref("unsubscribe/tok")).toBe("#");
  });
});

describe("renderCampaignEmail — card align injection (SECURITY)", () => {
  // `content.align` was the one authored string interpolated into a `style="…"`
  // attribute raw — every sibling is escaped, clamped, or a lookup key. It
  // reaches the eyebrow, heading, body and attribution rows, and `columns[]`
  // through the same function. `validateCardContent` restricts it at every
  // write today, so this covers a document written before that gate or by a
  // path that bypassed it — which is precisely what this render layer is for.
  const attackAlign = 'https://ok.test/a" onmouseover="alert(1)' as unknown as "left";

  const evilCard = {
    id: "1",
    kind: "card",
    heading: "h",
    eyebrow: "e",
    body: "b",
    attribution: "a",
    align: attackAlign,
  } as unknown as EmailBlock;

  const evilColumns = {
    id: "2",
    kind: "columns",
    columns: [{ heading: "h", align: attackAlign }],
  } as unknown as EmailBlock;

  for (const [label, block] of [
    ["a card", evilCard],
    ["a column", evilColumns],
  ] as const) {
    test(`${label}'s align cannot add an event handler`, () => {
      const html = renderCampaignEmail(doc([block]), baseOpts);
      expect(html).not.toContain("onmouseover");
      expect(html).not.toContain("alert(1)");
    });

    test(`${label}'s align falls back to the variant default, not a quoted value`, () => {
      const html = renderCampaignEmail(doc([block]), baseOpts);
      // Nothing anywhere in the document may reach `text-align:` but the two
      // legal keywords — and no style attribute may grow a quote or a `<`.
      for (const value of html.match(/text-align:[^;"]*/g) ?? []) {
        expect(["text-align:left", "text-align:center"]).toContain(value);
      }
      for (const styleAttr of html.match(/style="[^"]*"/g) ?? []) {
        expect(styleAttr).not.toContain("<");
      }
      // The `plain` variant aligns left; the injected string must not survive.
      expect(styleOfClass(html, "pw-h")).toContain("text-align:left");
    });
  }

  test("a legitimate align still wins over the variant default", () => {
    const html = renderCampaignEmail(
      doc([{ id: "1", kind: "card", heading: "h", align: "center" }]),
      baseOpts,
    );
    expect(styleOfClass(html, "pw-h")).toContain("text-align:center");
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

  test("carries the shell's footer copy", () => {
    const html = renderCampaignEmail(doc([]), baseOpts);
    expect(html).toContain("Sent with love by Public Worship");
  });

  test("the brand ships NO text wordmark — the masthead is artwork", () => {
    // The old shell typeset "PUBLIC WORSHIP" above the card. The real
    // newsletter opens with a full-bleed masthead IMAGE, so the strip is off
    // by default (`wordmark: ""`) rather than duplicating the artwork in type.
    const html = renderCampaignEmail(doc([]), baseOpts);
    expect(DEFAULT_EMAIL_THEME.wordmark).toBe("");
    expect(html).not.toContain("PUBLIC WORSHIP");
    expect(withoutStyleBlock(html)).not.toContain('class="pw-mark"');
  });

  test("a grey page carries a white 600px container — two different surfaces", () => {
    // The structural invariant of the whole design: `canvas` is the PAGE and
    // `surface` is the CONTAINER on top of it. The first rebuild had these
    // inverted (cream page, white card), which is why the correct hex values
    // still didn't look like the brand.
    const html = renderCampaignEmail(doc([]), baseOpts);
    expect(DEFAULT_EMAIL_THEME.canvas).not.toBe(DEFAULT_EMAIL_THEME.surface);
    expect(html).toContain(`<body style="margin:0;padding:0;background:${DEFAULT_EMAIL_THEME.canvas}"`);
    expect(styleOfClass(html, "pw-wrap")).toContain(`background:${DEFAULT_EMAIL_THEME.canvas}`);
    const container = styleOfClass(html, "pw-card");
    expect(container).toContain("width:600px");
    expect(container).toContain(`background:${DEFAULT_EMAIL_THEME.surface}`);
    expect(container).not.toContain(`background:${DEFAULT_EMAIL_THEME.canvas}`);
  });

  test("each block gets its own table row, inset by the container's 24px gutter", () => {
    const html = renderCampaignEmail(
      doc([
        { id: "1", kind: "heading", text: "One" },
        { id: "2", kind: "heading", text: "Two" },
      ]),
      baseOpts,
    );
    expect(html.match(/<tr><td style="padding:0 24px">/g)).toHaveLength(2);
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
    // A hero card, because the accent is a card FILL in this design rather
    // than something the shell paints on its own — a bare heading would only
    // prove the ink colour.
    const html = renderCampaignEmail(
      doc([{ id: "1", kind: "card", variant: "hero", heading: "Hello" }]),
      baseOpts,
    );
    expect(html).toContain("#891d1a");
    expect(html).toContain(DEFAULT_EMAIL_THEME.canvas);
    expect(styleOfClass(html, "pw-card-hero")).toContain(
      `background:${DEFAULT_EMAIL_THEME.accent}`,
    );
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
      themedDoc(
        [{ id: "1", kind: "card", variant: "hero", heading: "Go" }],
        WINTER_THEME,
      ),
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
    // A filled CTA is the near-black `contrast` pill. The accent is a card
    // FILL in this design, not the button colour.
    expect(styleOfClass(html, "pw-btn")).toContain(
      `background:${DEFAULT_EMAIL_THEME.contrast}`,
    );
    expect(styleOfClass(html, "pw-btn")).toContain(
      `color:${DEFAULT_EMAIL_THEME.contrastInk}`,
    );
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

// ── Card variants ─────────────────────────────────────────────────────────
//
// The four variants are what turn a stack of cards into the newsletter's
// actual sections, and the thing that distinguishes them is the FILL. Each of
// these asserts against the variant's own element rather than "the document
// contains this hex somewhere": `surface` and `contrastInk` are both plain
// white in the default theme, so a document-wide `toContain` would pass no
// matter which element got painted.

describe("renderCampaignEmail — card variants", () => {
  function variantCard(variant: "hero" | "feature" | "outlined" | "testimonial"): EmailBlock {
    return { id: "1", kind: "card", variant, heading: "Section", body: "Copy." };
  }

  test("a hero card is filled with the accent", () => {
    const html = renderCampaignEmail(doc([variantCard("hero")]), baseOpts);
    expect(styleOfClass(html, "pw-card-hero")).toContain(
      `background:${DEFAULT_EMAIL_THEME.accent}`,
    );
  });

  test("a feature card is filled with the cream, not the container's white", () => {
    const html = renderCampaignEmail(doc([variantCard("feature")]), baseOpts);
    const style = styleOfClass(html, "pw-card-feature");
    expect(style).toContain(`background:${DEFAULT_EMAIL_THEME.cream}`);
    expect(style).not.toContain(`background:${DEFAULT_EMAIL_THEME.surface}`);
  });

  test("an outlined card is the container's white with a 1px border", () => {
    const html = renderCampaignEmail(doc([variantCard("outlined")]), baseOpts);
    const style = styleOfClass(html, "pw-card-outlined");
    expect(style).toContain(`background:${DEFAULT_EMAIL_THEME.surface}`);
    expect(style).toContain(`border:1px solid ${DEFAULT_EMAIL_THEME.border}`);
  });

  test("a testimonial card is filled with the near-black contrast and inverts its text", () => {
    const html = renderCampaignEmail(doc([variantCard("testimonial")]), baseOpts);
    expect(styleOfClass(html, "pw-card-testimonial")).toContain(
      `background:${DEFAULT_EMAIL_THEME.contrast}`,
    );
    expect(styleOfClass(html, "pw-h")).toContain(`color:${DEFAULT_EMAIL_THEME.contrastInk}`);
  });

  test("the four variants paint four different fills", () => {
    // Written as one assertion because the failure mode this guards is a
    // variant quietly falling through to another's spec — individually each
    // card would still look fine, and only the sameness would be wrong.
    const fills = (["hero", "feature", "outlined", "testimonial"] as const).map((v) => {
      const html = renderCampaignEmail(doc([variantCard(v)]), baseOpts);
      return /background:(#[0-9a-f]{3,6})/i.exec(styleOfClass(html, `pw-card-${v}`))?.[1];
    });
    expect(fills.every(Boolean)).toBe(true);
    expect(new Set(fills).size).toBe(4);
  });

  test("a plain card keeps its pre-variant look — no fill, no border", () => {
    const html = renderCampaignEmail(
      doc([{ id: "1", kind: "card", heading: "Section" }]),
      baseOpts,
    );
    const style = styleOfClass(html, "pw-card-plain");
    expect(style).toBe("margin:0 0 20px");
  });

  test("the theme's headingTracking reaches the card heading's letter-spacing", () => {
    const html = renderCampaignEmail(doc([variantCard("feature")]), baseOpts);
    expect(DEFAULT_EMAIL_THEME.headingTracking).toBe("-0.04em");
    expect(styleOfClass(html, "pw-h")).toContain(
      `letter-spacing:${DEFAULT_EMAIL_THEME.headingTracking}`,
    );
  });

  test("the theme's bodyTracking reaches the card body's letter-spacing", () => {
    const html = renderCampaignEmail(doc([variantCard("feature")]), baseOpts);
    expect(styleOfClass(html, "pw-t")).toContain(
      `letter-spacing:${DEFAULT_EMAIL_THEME.bodyTracking}`,
    );
  });

  test("an eyebrow inside a card renders above its heading", () => {
    const html = renderCampaignEmail(
      doc([
        {
          id: "1",
          kind: "card",
          variant: "feature",
          eyebrow: "What's on",
          heading: "Section",
        },
      ]),
      baseOpts,
    );
    expect(html.indexOf("What's on")).toBeLessThan(html.indexOf("Section"));
  });

  test("a testimonial's attribution renders under the quote", () => {
    const html = renderCampaignEmail(
      doc([
        {
          id: "1",
          kind: "card",
          variant: "testimonial",
          body: "It changed the room.",
          attribution: "Carla, volunteer",
        },
      ]),
      baseOpts,
    );
    expect(html.indexOf("Carla, volunteer")).toBeGreaterThan(
      html.indexOf("It changed the room."),
    );
  });
});

describe("renderCampaignEmail — asymmetric cards", () => {
  test("imageSide + imageWidthPct renders two cells of UNEQUAL width", () => {
    // The source newsletter's rows are 44/56 and 40/60. A forced 50/50 is one
    // of the specific things that made an earlier rebuild read as generic.
    const html = renderCampaignEmail(
      doc([
        {
          id: "1",
          kind: "card",
          variant: "feature",
          imageSide: "right",
          imageWidthPct: 44,
          imageUrl: "https://x.test/a.png",
          imageAlt: "art",
          heading: "Brief headline",
        },
      ]),
      baseOpts,
    );
    const widths = columnWidths(html);
    expect(widths).toHaveLength(2);
    expect(widths[0]).not.toBe(widths[1]);
    expect(widths).toContain("44%");
  });

  test("imageSide 'left' puts the image cell first, 'right' puts it last", () => {
    const base = {
      id: "1",
      kind: "card",
      variant: "outlined",
      imageWidthPct: 40,
      imageUrl: "https://x.test/a.png",
      imageAlt: "art",
      heading: "Copy about support",
    } as const;
    const left = renderCampaignEmail(doc([{ ...base, imageSide: "left" }]), baseOpts);
    const right = renderCampaignEmail(doc([{ ...base, imageSide: "right" }]), baseOpts);
    expect(left.indexOf("https://x.test/a.png")).toBeLessThan(
      left.indexOf("Copy about support"),
    );
    expect(right.indexOf("https://x.test/a.png")).toBeGreaterThan(
      right.indexOf("Copy about support"),
    );
  });

  test("a card that DECLARES a side-by-side layout keeps it before its artwork is attached", () => {
    // Returning nothing for an empty image slot collapsed the built-in
    // template to a stack of text, which is how the layout stopped being
    // visible at all. The geometry has to survive an unfilled slot.
    const html = renderCampaignEmail(
      doc([
        {
          id: "1",
          kind: "card",
          variant: "outlined",
          imageSide: "left",
          imageWidthPct: 40,
          heading: "Copy about support",
        },
      ]),
      baseOpts,
    );
    expect(columnWidths(html)).toHaveLength(2);
    expect(html).toContain('class="pw-col-gap"');
    // …and it does it without requesting anything.
    expect(html).not.toContain("<img");
  });

  test("an inter-column spacer cell separates the two halves", () => {
    const html = renderCampaignEmail(
      doc([
        {
          id: "1",
          kind: "card",
          variant: "feature",
          imageSide: "right",
          imageUrl: "https://x.test/a.png",
          imageAlt: "art",
          heading: "Brief headline",
        },
      ]),
      baseOpts,
    );
    expect(html.match(/class="pw-col-gap"/g)).toHaveLength(1);
    // It must vanish when the columns stack, not become an empty 16px row.
    expect(styleBlockOf(html)).toContain(".pw-col-gap { display:none !important;");
  });
});

describe("renderCampaignEmail — button variants", () => {
  function buttonDoc(variant?: "filled" | "outline") {
    return doc([{ id: "1", kind: "button", label: "Give", url: "https://x.test/go", variant }]);
  }

  test("a filled button is the near-black contrast pill", () => {
    const style = styleOfClass(renderCampaignEmail(buttonDoc("filled"), baseOpts), "pw-btn");
    expect(style).toContain(`background:${DEFAULT_EMAIL_THEME.contrast}`);
    expect(style).toContain(`color:${DEFAULT_EMAIL_THEME.contrastInk}`);
  });

  test("an outline button is transparent with a 1px rule", () => {
    const style = styleOfClass(renderCampaignEmail(buttonDoc("outline"), baseOpts), "pw-btn");
    expect(style).toContain("background:transparent");
    expect(style).toContain(`border:1px solid ${DEFAULT_EMAIL_THEME.border}`);
    expect(style).toContain(`color:${DEFAULT_EMAIL_THEME.ink}`);
  });

  test("a button with no variant stays filled — documents written before variants are unchanged", () => {
    expect(styleOfClass(renderCampaignEmail(buttonDoc(), baseOpts), "pw-btn")).toBe(
      styleOfClass(renderCampaignEmail(buttonDoc("filled"), baseOpts), "pw-btn"),
    );
  });

  test("an outlined card's CTA defaults to the outline treatment", () => {
    const html = renderCampaignEmail(
      doc([
        {
          id: "1",
          kind: "card",
          variant: "outlined",
          heading: "Serve with us!",
          ctaLabel: "Get in touch",
          ctaUrl: "https://x.test/go",
        },
      ]),
      baseOpts,
    );
    expect(styleOfClass(html, "pw-btn")).toContain("background:transparent");
  });

  test("ctaStyle overrides the variant's default treatment", () => {
    const html = renderCampaignEmail(
      doc([
        {
          id: "1",
          kind: "card",
          variant: "outlined",
          ctaStyle: "filled",
          heading: "Serve with us!",
          ctaLabel: "Get in touch",
          ctaUrl: "https://x.test/go",
        },
      ]),
      baseOpts,
    );
    expect(styleOfClass(html, "pw-btn")).toContain(
      `background:${DEFAULT_EMAIL_THEME.contrast}`,
    );
  });
});

describe("renderCampaignEmail — bleed_image", () => {
  test("a filled slot renders edge to edge — its row carries no side padding", () => {
    const html = renderCampaignEmail(
      doc([{ id: "1", kind: "bleed_image", url: "https://x.test/masthead.png", alt: "Masthead" }]),
      baseOpts,
    );
    expect(html).toContain('<tr><td style="padding:0"><img');
    expect(html).toContain('src="https://x.test/masthead.png"');
    expect(html).toContain('alt="Masthead"');
  });

  test("an inset slot keeps the container's 24px gutter", () => {
    const html = renderCampaignEmail(
      doc([
        {
          id: "1",
          kind: "bleed_image",
          url: "https://x.test/song.png",
          alt: "Song of the month",
          inset: true,
        },
      ]),
      baseOpts,
    );
    expect(html).toContain('<tr><td style="padding:0 24px"><img');
  });

  test("an UNFILLED slot makes no external request at all", () => {
    // The guarantee: a template can say "the masthead goes here" without
    // naming a URL this deployment may not own. A guessed path is how you
    // ship broken images to real inboxes.
    const html = renderCampaignEmail(
      doc([{ id: "1", kind: "bleed_image", alt: "" }]),
      baseOpts,
    );
    expect(html).not.toContain("<img");
    expect(html).not.toContain("src=");
  });

  test("an unfilled slot still draws a placeholder band, so the layout is visible", () => {
    const html = renderCampaignEmail(
      doc([{ id: "1", kind: "bleed_image", alt: "" }]),
      baseOpts,
    );
    expect(html).toContain(`border:1px dashed ${DEFAULT_EMAIL_THEME.hairline}`);
    expect(html).toContain("Add artwork from the image library");
    // A placeholder is inset like any other block — a full-width grey stripe
    // would read as a rendering fault rather than an empty slot.
    expect(html).toContain('<tr><td style="padding:0 24px">');
  });

  test("an unfilled slot's alt text names the slot for the author", () => {
    const html = renderCampaignEmail(
      doc([{ id: "1", kind: "bleed_image", alt: "Song of the month" }]),
      baseOpts,
    );
    expect(html).toContain("Song of the month");
  });

  test("a linked bleed image wraps the artwork in an anchor", () => {
    const html = renderCampaignEmail(
      doc([
        {
          id: "1",
          kind: "bleed_image",
          url: "https://x.test/song.png",
          alt: "Song of the month",
          href: "https://open.spotify.com/",
        },
      ]),
      baseOpts,
    );
    expect(html).toContain('<a href="https://open.spotify.com/"');
  });

  test("(SECURITY) a javascript: href on a bleed image renders as an inert '#'", () => {
    const html = renderCampaignEmail(
      doc([
        {
          id: "1",
          kind: "bleed_image",
          url: "https://x.test/song.png",
          alt: "Song",
          href: "javascript:alert(1)",
        },
      ]),
      baseOpts,
    );
    expect(html).toContain('href="#"');
    expect(html).not.toContain("javascript:");
  });
});

describe("renderCampaignEmail — footer block", () => {
  const footer: EmailBlock = {
    id: "1",
    kind: "footer",
    navLine: "Events | Supply",
    links: [
      { label: "TikTok", url: "https://tiktok.test/pw" },
      { label: "Instagram", url: "https://instagram.test/pw" },
    ],
  };

  test("it renders its nav line and every link", () => {
    const html = renderCampaignEmail(doc([footer]), baseOpts);
    expect(html).toContain("Events | Supply");
    expect(html).toContain(">TikTok<");
    expect(html).toContain('href="https://tiktok.test/pw"');
    expect(html).toContain(">Instagram<");
    expect(html).toContain('href="https://instagram.test/pw"');
  });

  test("it is the cream sign-off card, not bare text on the container", () => {
    const html = renderCampaignEmail(doc([footer]), baseOpts);
    expect(styleOfClass(html, "pw-card-feature")).toContain(
      `background:${DEFAULT_EMAIL_THEME.cream}`,
    );
  });

  test("the unsubscribe link survives WITH a footer block", () => {
    const html = renderCampaignEmail(doc([footer]), baseOpts);
    expect(html).toContain(baseOpts.unsubscribeUrl);
    expect(html.toLowerCase()).toContain("unsubscribe");
  });

  test("the unsubscribe link survives WITHOUT a footer block", () => {
    // Both paths, because the fallback is the only thing standing between a
    // document that forgot its footer and an unlawful send.
    const html = renderCampaignEmail(
      doc([{ id: "1", kind: "heading", text: "No footer here" }]),
      baseOpts,
    );
    expect(html).toContain(baseOpts.unsubscribeUrl);
    expect(html.toLowerCase()).toContain("unsubscribe");
  });

  test("a footer block suppresses the shell fallback — one unsubscribe link, not two", () => {
    const html = renderCampaignEmail(doc([footer]), baseOpts);
    expect(html.split(baseOpts.unsubscribeUrl)).toHaveLength(2);
    expect(html).not.toContain("Sent with love by Public Worship");
  });

  test("the org address renders inside the footer block when set", () => {
    const html = renderCampaignEmail(doc([footer]), {
      ...baseOpts,
      orgAddress: "123 Main St, Springfield",
    });
    expect(html).toContain("123 Main St, Springfield");
  });

  test("a footer logo carries its alt text", () => {
    const html = renderCampaignEmail(
      doc([{ ...footer, logoUrl: "https://x.test/logo.png", logoAlt: "Public Worship" }]),
      baseOpts,
    );
    expect(html).toContain('src="https://x.test/logo.png"');
    expect(html).toContain('alt="Public Worship"');
  });
});

describe("renderCampaignEmail — hairline", () => {
  test("it draws a filled 1px band in the hairline token, not a bordered <hr>", () => {
    const html = renderCampaignEmail(doc([{ id: "1", kind: "hairline" }]), baseOpts);
    expect(html).toContain(`background:${DEFAULT_EMAIL_THEME.hairline}`);
    expect(html).not.toContain("<hr");
  });

  test("it is distinct from `divider`, which is still a bordered <hr>", () => {
    const html = renderCampaignEmail(doc([{ id: "1", kind: "divider" }]), baseOpts);
    expect(html).toContain("<hr");
    expect(html).toContain(`border-top:1px solid ${DEFAULT_EMAIL_THEME.border}`);
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
    // Counted by class, not by `<td `: the shell itself is a table now, so
    // the document contains rows that have nothing to do with this block.
    const html = renderCampaignEmail(doc([columns]), baseOpts);
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
    expect(html.match(/class="pw-col"/g)).toHaveLength(3);
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

describe("renderCampaignEmail — typography consistency (regression)", () => {
  test("a standalone heading block gets the theme's headingTracking", () => {
    // Card headings always carried it; a standalone `heading` block did not,
    // so an author dropping one into a document got a visibly looser headline
    // than the cards around it in the same email.
    const html = renderCampaignEmail(doc([{ id: "h", kind: "heading", text: "Hello" }]), baseOpts);
    const tag = html.match(/<h1[^>]*>/)?.[0] ?? "";
    expect(tag).toContain(`letter-spacing:${DEFAULT_EMAIL_THEME.headingTracking}`);
  });

  test("a standalone text block gets the theme's bodyTracking", () => {
    const html = renderCampaignEmail(doc([{ id: "t", kind: "text", markdown: "Hi." }]), baseOpts);
    const tag = html.match(/<p class="pw-t"[^>]*>/)?.[0] ?? "";
    expect(tag).toContain(`letter-spacing:${DEFAULT_EMAIL_THEME.bodyTracking}`);
  });

  test("a heading block and a card heading track identically", () => {
    const html = renderCampaignEmail(
      doc([
        { id: "h", kind: "heading", text: "Standalone" },
        { id: "c", kind: "card", variant: "feature", heading: "In a card" },
      ]),
      baseOpts,
    );
    const standalone = html.match(/<h1[^>]*>/)?.[0] ?? "";
    const inCard = html.match(/<h3[^>]*>/)?.[0] ?? "";
    const track = (tag: string) => tag.match(/letter-spacing:([^;"]+)/)?.[1];
    expect(track(standalone)).toBeDefined();
    expect(track(standalone)).toBe(track(inCard));
  });
});
