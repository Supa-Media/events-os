/**
 * WS1: functional tests for the Public Worship node pack — `pwHeading`,
 * `letterSpacing` (textStyle mark), `pwParagraph`, `button.maxWidth`,
 * `pwBleedImage`, `pwPoll` — plus the `heading()` level-clamp fix and the
 * `renderSegmentedBody` restructuring's backward-compat guarantee.
 */
import { describe, expect, test } from "vitest";
import type { JSONContent } from "@tiptap/core";
import { Maily } from "./maily";

describe("pwHeading", () => {
  test("falls back to the stock heading's size/weight when unset", async () => {
    const stock: JSONContent = {
      type: "doc",
      content: [{ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Hi" }] }],
    };
    const pw: JSONContent = {
      type: "doc",
      content: [{ type: "pwHeading", attrs: { level: 2 }, content: [{ type: "text", text: "Hi" }] }],
    };
    const stockHtml = await new Maily(stock).render();
    const pwHtml = await new Maily(pw).render();
    // Both should carry the SAME h2 default size/weight (30px / 700).
    expect(stockHtml).toContain("30px");
    expect(pwHtml).toContain("30px");
    expect(pwHtml).toContain("font-weight:700");
  });

  test("free fontSize/lineHeight/letterSpacing/color override the default", async () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        {
          type: "pwHeading",
          attrs: { level: 2, fontSize: 42, lineHeight: 48, letterSpacing: "0.08em", color: "#FF00AA" },
          content: [{ type: "text", text: "Custom" }],
        },
      ],
    };
    const html = await new Maily(doc).render();
    expect(html).toContain("42px");
    expect(html).toContain("48px");
    expect(html).toContain("0.08em");
    expect(html).toContain("#FF00AA");
    expect(html).toContain("Custom");
  });

  test("an out-of-range level does not throw — clamps instead", async () => {
    const doc: JSONContent = {
      type: "doc",
      content: [{ type: "pwHeading", attrs: { level: 99 }, content: [{ type: "text", text: "x" }] }],
    };
    await expect(new Maily(doc).render()).resolves.toContain("x");
  });

  test("default level (unset) is h2", async () => {
    const doc: JSONContent = { type: "doc", content: [{ type: "pwHeading", content: [{ type: "text", text: "x" }] }] };
    const html = await new Maily(doc).render();
    expect(html).toMatch(/<h2[\s>]/);
  });
});

describe("heading() level-clamp fix (upstream bug #3)", () => {
  test("an out-of-range level does not throw at render (upstream would destructure undefined)", async () => {
    const doc: JSONContent = {
      type: "doc",
      content: [{ type: "heading", attrs: { level: 7 }, content: [{ type: "text", text: "x" }] }],
    };
    await expect(new Maily(doc).render()).resolves.toContain("x");
  });

  test("a negative level does not throw", async () => {
    const doc: JSONContent = {
      type: "doc",
      content: [{ type: "heading", attrs: { level: -3 }, content: [{ type: "text", text: "x" }] }],
    };
    await expect(new Maily(doc).render()).resolves.toContain("x");
  });

  test("levels 1-3 still render their normal distinct sizes", async () => {
    const sizes = ["36px", "30px", "24px"];
    for (const [i, level] of [1, 2, 3].entries()) {
      const doc: JSONContent = {
        type: "doc",
        content: [{ type: "heading", attrs: { level }, content: [{ type: "text", text: "x" }] }],
      };
      const html = await new Maily(doc).render();
      expect(html).toContain(sizes[i]);
    }
  });
});

describe("letterSpacing (textStyle mark)", () => {
  test("applies when set", async () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "tracked", marks: [{ type: "textStyle", attrs: { letterSpacing: "0.15em" } }] }],
        },
      ],
    };
    const html = await new Maily(doc).render();
    expect(html).toContain("0.15em");
  });

  test("absent when unset — byte-for-byte unchanged from before the WS1 extension", async () => {
    const doc: JSONContent = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "plain", marks: [{ type: "textStyle" }] }] }],
    };
    const html = await new Maily(doc).render();
    expect(html).not.toContain("letter-spacing");
  });
});

describe("pwParagraph", () => {
  test("free fontSize/lineHeight override the theme default", async () => {
    const doc: JSONContent = {
      type: "doc",
      content: [{ type: "pwParagraph", attrs: { fontSize: 20, lineHeight: 28 }, content: [{ type: "text", text: "Testimonial" }] }],
    };
    const html = await new Maily(doc).render();
    expect(html).toContain("20px");
    expect(html).toContain("28px");
    expect(html).toContain("Testimonial");
  });

  test("unset falls back to the theme's paragraph size (15px default)", async () => {
    const doc: JSONContent = { type: "doc", content: [{ type: "pwParagraph", content: [{ type: "text", text: "Body" }] }] };
    const html = await new Maily(doc).render();
    expect(html).toContain("15px");
  });
});

describe("button maxWidth", () => {
  test("caps the button width when set", async () => {
    const doc: JSONContent = {
      type: "doc",
      content: [{ type: "button", attrs: { text: "Go", url: "https://example.com", maxWidth: 280 } }],
    };
    const html = await new Maily(doc).render();
    expect(html).toMatch(/max-width:\s*280px/);
  });

  test("unset adds no PIXEL max-width (react-email's Button primitive itself always emits max-width:100%, unrelated to this feature)", async () => {
    const doc: JSONContent = {
      type: "doc",
      content: [{ type: "button", attrs: { text: "Go", url: "https://example.com", variant: "filled" } }],
    };
    const html = await new Maily(doc).render();
    const buttonMatch = html.match(/<a[^>]*href="https:\/\/example\.com"[^>]*>/);
    expect(buttonMatch).not.toBeNull();
    expect(buttonMatch?.[0]).not.toMatch(/max-width:\d+px/);
  });

  test("a non-positive/garbage maxWidth is ignored, not thrown", async () => {
    const doc: JSONContent = {
      type: "doc",
      content: [{ type: "button", attrs: { text: "Go", url: "https://example.com", maxWidth: -10 } }],
    };
    await expect(new Maily(doc).render()).resolves.toContain("Go");
  });
});

describe("pwBleedImage", () => {
  test("renders a full-width table with a zero-padding cell, outside the theme container padding", async () => {
    const doc: JSONContent = {
      type: "doc",
      content: [{ type: "pwBleedImage", attrs: { src: "https://example.com/masthead.png", alt: "Masthead" } }],
    };
    const html = await new Maily(doc).render();
    expect(html).toContain("https://example.com/masthead.png");
    expect(html).toContain('alt="Masthead"');
    // A zero-padding cell somewhere in the output — the bleed row's own <td>.
    expect(html).toMatch(/padding:0(px)?[^-]/);
  });

  test("wraps in a link when href is set", async () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        {
          type: "pwBleedImage",
          attrs: { src: "https://example.com/masthead.png", alt: "Masthead", href: "https://example.com/click" },
        },
      ],
    };
    const html = await new Maily(doc).render();
    expect(html).toContain("https://example.com/click");
  });

  test("a javascript: src is dropped (defense-in-depth; the write gate should already reject it)", async () => {
    const doc: JSONContent = { type: "doc", content: [{ type: "pwBleedImage", attrs: { src: "javascript:alert(1)", alt: "x" } }] };
    const html = await new Maily(doc).render();
    expect(html).not.toContain("javascript:alert(1)");
  });

  // WS4, fidelity gap 1 fix: an empty/invalid `src` used to return an empty
  // fragment (dropping the whole section silently) — see this method's own
  // doc comment for why. It now draws a visible placeholder band.
  describe("unfilled placeholder (WS4, fidelity gap 1 fix)", () => {
    test("no src at all: renders a table carrying the alt text, no <img>", async () => {
      const doc: JSONContent = { type: "doc", content: [{ type: "pwBleedImage", attrs: { alt: "What's On" } }] };
      const html = await new Maily(doc).render();
      expect(html).toContain("What&#x27;s On");
      expect(html).not.toMatch(/<img/);
    });

    test("empty string src: same placeholder treatment as absent", async () => {
      const doc: JSONContent = { type: "doc", content: [{ type: "pwBleedImage", attrs: { src: "", alt: "Masthead" } }] };
      const html = await new Maily(doc).render();
      expect(html).toContain("Masthead");
      expect(html).not.toMatch(/<img/);
    });

    test("an invalid (javascript:) src also falls back to the placeholder, not an empty fragment", async () => {
      const doc: JSONContent = {
        type: "doc",
        content: [{ type: "pwBleedImage", attrs: { src: "javascript:alert(1)", alt: "Banner" } }],
      };
      const html = await new Maily(doc).render();
      expect(html).toContain("Banner");
      expect(html).not.toMatch(/<img/);
    });

    test("empty alt falls back to the generic 'Artwork slot' label, not a blank band", async () => {
      const doc: JSONContent = { type: "doc", content: [{ type: "pwBleedImage", attrs: { src: "", alt: "" } }] };
      const html = await new Maily(doc).render();
      expect(html).toContain("Artwork slot");
    });

    test("no alt attr at all also falls back to 'Artwork slot'", async () => {
      const doc: JSONContent = { type: "doc", content: [{ type: "pwBleedImage", attrs: {} }] };
      const html = await new Maily(doc).render();
      expect(html).toContain("Artwork slot");
    });

    test("renders a real table (Outlook-safe), not a div/span", async () => {
      const doc: JSONContent = { type: "doc", content: [{ type: "pwBleedImage", attrs: { alt: "Banner" } }] };
      const html = await new Maily(doc).render();
      expect(html).toMatch(/<table[^>]*role="presentation"[^>]*>[\s\S]*<\/table>/);
    });

    test("interleaved with ordinary content: the placeholder still renders in document order", async () => {
      const doc: JSONContent = {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "Before" }] },
          { type: "pwBleedImage", attrs: { alt: "Between" } },
          { type: "paragraph", content: [{ type: "text", text: "After" }] },
        ],
      };
      const html = await new Maily(doc).render();
      const beforeIdx = html.indexOf("Before");
      const betweenIdx = html.indexOf("Between");
      const afterIdx = html.indexOf("After");
      expect(beforeIdx).toBeGreaterThan(-1);
      expect(betweenIdx).toBeGreaterThan(beforeIdx);
      expect(afterIdx).toBeGreaterThan(betweenIdx);
    });
  });

  test("a javascript: href is dropped, image still renders unlinked", async () => {
    const doc: JSONContent = {
      type: "doc",
      content: [{ type: "pwBleedImage", attrs: { src: "https://example.com/m.png", alt: "x", href: "javascript:alert(1)" } }],
    };
    const html = await new Maily(doc).render();
    expect(html).toContain("https://example.com/m.png");
    expect(html).not.toContain("javascript:alert(1)");
  });

  test("interleaved with ordinary content: everything still renders, in order", async () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Before" }] },
        { type: "pwBleedImage", attrs: { src: "https://example.com/banner.png", alt: "Banner" } },
        { type: "paragraph", content: [{ type: "text", text: "After" }] },
      ],
    };
    const html = await new Maily(doc).render();
    const beforeIdx = html.indexOf("Before");
    const bannerIdx = html.indexOf("banner.png");
    const afterIdx = html.indexOf("After");
    expect(beforeIdx).toBeGreaterThan(-1);
    expect(bannerIdx).toBeGreaterThan(beforeIdx);
    expect(afterIdx).toBeGreaterThan(bannerIdx);
  });

  test("a doc with no pwBleedImage node renders through exactly one Container, as before", async () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "One" }] },
        { type: "paragraph", content: [{ type: "text", text: "Two" }] },
      ],
    };
    const html = await new Maily(doc).render();
    // The old, single-Container structure has exactly one <table> wrapping
    // the body content at the top level (react-email's Container renders a
    // <table style="...max-width...">). This is a coarse but stable signal
    // that the segmentation refactor didn't fragment ordinary documents.
    expect(html).toContain("One");
    expect(html).toContain("Two");
  });
});

describe("pwPoll", () => {
  const pollDoc = (question = "Favorite service?"): JSONContent => ({
    type: "doc",
    content: [
      {
        type: "pwPoll",
        attrs: {
          id: "poll1",
          question,
          options: [
            { id: "morning", label: "Morning" },
            { id: "evening", label: "Evening" },
          ],
        },
      },
    ],
  });

  test("renders the question and both option labels", async () => {
    const html = await new Maily(pollDoc()).render();
    expect(html).toContain("Favorite service?");
    expect(html).toContain("Morning");
    expect(html).toContain("Evening");
  });

  test("with setVariableValues, each option links to its per-recipient vote URL", async () => {
    const maily = new Maily(pollDoc());
    maily.setVariableValues({
      pw_poll_poll1_morning_url: "https://example.com/poll/abc/poll1/morning",
      pw_poll_poll1_evening_url: "https://example.com/poll/abc/poll1/evening",
    });
    const html = await maily.render();
    expect(html).toContain("https://example.com/poll/abc/poll1/morning");
    expect(html).toContain("https://example.com/poll/abc/poll1/evening");
  });

  test("without variables (composer preview), options render as inert pills, not links to a 404", async () => {
    const html = await new Maily(pollDoc()).render();
    expect(html).not.toContain("pw_poll_poll1_morning_url");
    expect(html).not.toMatch(/href="[^"]*poll1[^"]*"/);
  });

  test("plaintext part includes the question and option labels", async () => {
    const text = await new Maily(pollDoc()).render({ plainText: true });
    expect(text).toContain("Favorite service?");
    expect(text.toLowerCase()).toContain("morning");
    expect(text.toLowerCase()).toContain("evening");
  });

  test("malformed options are skipped rather than thrown", async () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        {
          type: "pwPoll",
          attrs: {
            id: "poll2",
            question: "Q",
            options: [null, { id: "a" }, { label: "no id" }, { id: "ok", label: "OK" }],
          },
        },
      ],
    };
    const html = await new Maily(doc).render();
    expect(html).toContain("OK");
  });
});

describe("cross-node-pack: everything in one document renders without throwing", () => {
  test("a full document exercising every PW node pack addition alongside stock nodes", async () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        { type: "pwHeading", attrs: { level: 1, fontSize: 40 }, content: [{ type: "text", text: "Newsletter" }] },
        { type: "pwBleedImage", attrs: { src: "https://example.com/masthead.png", alt: "Masthead" } },
        {
          type: "pwParagraph",
          attrs: { fontSize: 20 },
          content: [{ type: "text", text: "A testimonial", marks: [{ type: "textStyle", attrs: { letterSpacing: "0.02em" } }] }],
        },
        { type: "button", attrs: { text: "RSVP", url: "https://example.com/rsvp", variant: "filled", maxWidth: 240 } },
        {
          type: "pwPoll",
          attrs: {
            id: "p1",
            question: "Join us?",
            options: [
              { id: "y", label: "Yes" },
              { id: "n", label: "No" },
            ],
          },
        },
      ],
    };
    const maily = new Maily(doc);
    maily.setVariableValues({ pw_poll_p1_y_url: "https://example.com/vote/y", pw_poll_p1_n_url: "https://example.com/vote/n" });
    const html = await maily.render();
    expect(html).toContain("Newsletter");
    expect(html).toContain("masthead.png");
    expect(html).toContain("A testimonial");
    expect(html).toContain("RSVP");
    expect(html).toContain("Join us?");
    expect(html).toContain("https://example.com/vote/y");
  });
});

// WS4, fidelity gap 3 fix: an authored `alt: ""` (the write gate's legal
// "decorative, on purpose" value — see `tiptapEmail.ts`'s module doc) must
// survive as `alt=""`, not be overridden with the literal word "Image"/"Logo"
// the way an genuinely ABSENT alt still is.
describe("stock image/logo: authored empty alt is preserved (WS4, fidelity gap 3 fix)", () => {
  test("image(): an authored empty alt renders alt=\"\", not alt=\"Image\"", async () => {
    const doc: JSONContent = {
      type: "doc",
      content: [{ type: "image", attrs: { src: "https://example.com/photo.png", alt: "" } }],
    };
    const html = await new Maily(doc).render();
    expect(html).toMatch(/alt=""/);
    expect(html).not.toContain('alt="Image"');
  });

  test("image(): a genuinely absent alt still falls back to title, or 'Image'", async () => {
    const doc: JSONContent = {
      type: "doc",
      content: [{ type: "image", attrs: { src: "https://example.com/photo.png" } }],
    };
    const html = await new Maily(doc).render();
    expect(html).toContain('alt="Image"');
  });

  test("image(): an absent alt with a title falls back to the title, not 'Image'", async () => {
    const doc: JSONContent = {
      type: "doc",
      content: [{ type: "image", attrs: { src: "https://example.com/photo.png", title: "A real title" } }],
    };
    const html = await new Maily(doc).render();
    expect(html).toContain('alt="A real title"');
  });

  test("logo(): an authored empty alt renders alt=\"\", not alt=\"Logo\"", async () => {
    const doc: JSONContent = {
      type: "doc",
      content: [{ type: "logo", attrs: { src: "https://example.com/logo.png", alt: "", size: "md" } }],
    };
    const html = await new Maily(doc).render();
    expect(html).toMatch(/alt=""/);
    expect(html).not.toContain('alt="Logo"');
  });

  test("logo(): a genuinely absent alt still falls back to title, or 'Logo'", async () => {
    const doc: JSONContent = {
      type: "doc",
      content: [{ type: "logo", attrs: { src: "https://example.com/logo.png", size: "md" } }],
    };
    const html = await new Maily(doc).render();
    expect(html).toContain('alt="Logo"');
  });
});
