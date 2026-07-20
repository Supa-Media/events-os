import { describe, expect, test } from "vitest";
import type { EmailBlock, EmailDocument } from "./emailBlocks";
import { renderCampaignEmail, renderCampaignText } from "./emailRender";

const baseOpts = {
  recipient: { name: "Alex Rivera", email: "alex@example.com" },
  unsubscribeUrl: "https://example.com/unsub/abc123",
};

function doc(blocks: EmailBlock[]): EmailDocument {
  return { blocks };
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
