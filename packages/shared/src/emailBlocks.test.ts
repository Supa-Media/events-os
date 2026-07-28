import { describe, expect, test } from "vitest";
import {
  isAllowedImageUrl,
  isAllowedLinkUrl,
  isKnownMergeTag,
  MERGE_TAGS,
  newBlockId,
  validateEmailDocument,
  type EmailDocument,
} from "./emailBlocks";
import { PUBLIC_WORSHIP_THEME } from "./emailTheme";

describe("MERGE_TAGS", () => {
  test("includes firstName and name", () => {
    const tags = MERGE_TAGS.map((t) => t.tag);
    expect(tags).toContain("firstName");
    expect(tags).toContain("name");
  });

  test("isKnownMergeTag matches MERGE_TAGS entries only", () => {
    expect(isKnownMergeTag("firstName")).toBe(true);
    expect(isKnownMergeTag("name")).toBe(true);
    expect(isKnownMergeTag("bogus")).toBe(false);
  });
});

describe("newBlockId", () => {
  test("two calls without a seed produce different ids", () => {
    expect(newBlockId()).not.toBe(newBlockId());
  });

  test("a seed produces a deterministic id", () => {
    expect(newBlockId("abc")).toBe(newBlockId("abc"));
    expect(newBlockId(1)).toBe(newBlockId(1));
  });

  test("ids are non-empty strings", () => {
    const id = newBlockId();
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });
});

describe("validateEmailDocument", () => {
  test("accepts an empty block list", () => {
    const result = validateEmailDocument({ blocks: [] });
    expect(result.ok).toBe(true);
  });

  test("accepts one of every block kind", () => {
    const doc: EmailDocument = {
      blocks: [
        { id: "1", kind: "heading", text: "Hi", level: 1 },
        { id: "2", kind: "text", markdown: "**hello**" },
        { id: "3", kind: "image", url: "https://x.test/a.png", alt: "alt", width: "full" },
        { id: "4", kind: "button", label: "Go", url: "https://x.test", align: "center" },
        { id: "5", kind: "divider" },
        { id: "6", kind: "spacer", size: "md" },
      ],
    };
    const result = validateEmailDocument(doc);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.doc.blocks).toHaveLength(6);
  });

  test("accepts blocks with optional fields omitted", () => {
    const doc: EmailDocument = {
      blocks: [
        { id: "1", kind: "heading", text: "Hi" },
        { id: "2", kind: "image", url: "https://x.test/a.png", alt: "alt" },
        { id: "3", kind: "button", label: "Go", url: "https://x.test" },
      ],
    };
    expect(validateEmailDocument(doc).ok).toBe(true);
  });

  test("rejects a non-object document", () => {
    expect(validateEmailDocument(null).ok).toBe(false);
    expect(validateEmailDocument("blocks").ok).toBe(false);
    expect(validateEmailDocument([]).ok).toBe(false);
  });

  test("rejects a document whose blocks field isn't an array", () => {
    const result = validateEmailDocument({ blocks: "nope" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/blocks/);
  });

  test("rejects a block missing an id", () => {
    const result = validateEmailDocument({
      blocks: [{ kind: "divider" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/id/);
  });

  test("rejects an unknown block kind", () => {
    const result = validateEmailDocument({
      blocks: [{ id: "1", kind: "video", url: "https://x.test" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/unknown block kind/);
  });

  test("rejects a heading with a bad level", () => {
    const result = validateEmailDocument({
      blocks: [{ id: "1", kind: "heading", text: "Hi", level: 3 }],
    });
    expect(result.ok).toBe(false);
  });

  test("rejects an image missing a url", () => {
    const result = validateEmailDocument({
      blocks: [{ id: "1", kind: "image", alt: "alt" }],
    });
    expect(result.ok).toBe(false);
  });

  test("rejects a spacer with an invalid size", () => {
    const result = validateEmailDocument({
      blocks: [{ id: "1", kind: "spacer", size: "xl" }],
    });
    expect(result.ok).toBe(false);
  });

  test("rejects duplicate block ids", () => {
    const result = validateEmailDocument({
      blocks: [
        { id: "1", kind: "divider" },
        { id: "1", kind: "spacer", size: "sm" },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/duplicate id/);
  });

  // ── URL scheme allowlist (SECURITY write gate) ───────────────────────────

  test("rejects a javascript: button url", () => {
    const result = validateEmailDocument({
      blocks: [{ id: "1", kind: "button", label: "Go", url: "javascript:alert(1)" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/http:, https:, or mailto:/);
  });

  test("rejects a data: image url", () => {
    const result = validateEmailDocument({
      blocks: [{ id: "1", kind: "image", url: "data:image/png;base64,xxx", alt: "x" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/http: or https:/);
  });

  test("accepts a mailto: button url", () => {
    const result = validateEmailDocument({
      blocks: [{ id: "1", kind: "button", label: "Email us", url: "mailto:hello@example.com" }],
    });
    expect(result.ok).toBe(true);
  });

  test("rejects a mailto: image url (images are http/https only)", () => {
    const result = validateEmailDocument({
      blocks: [{ id: "1", kind: "image", url: "mailto:hello@example.com", alt: "x" }],
    });
    expect(result.ok).toBe(false);
  });
});

describe("isAllowedLinkUrl / isAllowedImageUrl (unit)", () => {
  test("isAllowedLinkUrl allows http/https/mailto, case-insensitive", () => {
    expect(isAllowedLinkUrl("https://x.test")).toBe(true);
    expect(isAllowedLinkUrl("HTTP://x.test")).toBe(true);
    expect(isAllowedLinkUrl("mailto:a@b.com")).toBe(true);
    expect(isAllowedLinkUrl("javascript:alert(1)")).toBe(false);
    expect(isAllowedLinkUrl("JavaScript:alert(1)")).toBe(false);
    expect(isAllowedLinkUrl("not-a-url")).toBe(false);
  });

  test("isAllowedImageUrl allows only http/https", () => {
    expect(isAllowedImageUrl("https://x.test/a.png")).toBe(true);
    expect(isAllowedImageUrl("http://x.test/a.png")).toBe(true);
    expect(isAllowedImageUrl("mailto:a@b.com")).toBe(false);
    expect(isAllowedImageUrl("data:image/png;base64,xxx")).toBe(false);
  });
});

describe("validateEmailDocument — composed block kinds", () => {
  test("accepts one of every new kind", () => {
    const doc: EmailDocument = {
      blocks: [
        { id: "1", kind: "eyebrow", text: "What's on", icon: "◆" },
        {
          id: "2",
          kind: "card",
          imageUrl: "https://x.test/hero.png",
          imageAlt: "Hero art",
          heading: "Help us",
          body: "**Concrete** beats general.",
          ctaLabel: "Give",
          ctaUrl: "https://x.test/give",
        },
        {
          id: "3",
          kind: "columns",
          columns: [
            { heading: "First", ctaLabel: "RSVP", ctaUrl: "https://x.test/a" },
            { heading: "Second" },
          ],
        },
        { id: "4", kind: "quote", text: "It changed the room.", attribution: "Carla" },
        {
          id: "5",
          kind: "poll",
          question: "Which night?",
          options: [
            { id: "a", label: "Friday" },
            { id: "b", label: "Saturday" },
          ],
        },
        {
          id: "6",
          kind: "image",
          url: "https://x.test/art.png",
          alt: "Artwork",
          href: "https://x.test/listen",
        },
      ],
    };
    const result = validateEmailDocument(doc);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.doc.blocks).toHaveLength(6);
  });

  test("accepts the composed kinds with every optional field omitted", () => {
    const result = validateEmailDocument({
      blocks: [
        { id: "1", kind: "eyebrow", text: "What's on" },
        { id: "2", kind: "card" },
        { id: "3", kind: "columns", columns: [{}, {}] },
        { id: "4", kind: "quote", text: "Words." },
      ],
    });
    expect(result.ok).toBe(true);
  });

  test("rejects an eyebrow with empty text", () => {
    const result = validateEmailDocument({
      blocks: [{ id: "1", kind: "eyebrow", text: "" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/eyebrow "text"/);
  });

  test("rejects a non-string eyebrow icon", () => {
    const result = validateEmailDocument({
      blocks: [{ id: "1", kind: "eyebrow", text: "Hi", icon: 5 }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/eyebrow "icon"/);
  });

  test("rejects a quote with empty text", () => {
    const result = validateEmailDocument({
      blocks: [{ id: "1", kind: "quote", text: "" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/quote "text"/);
  });
});

describe("validateEmailDocument — card content", () => {
  test("rejects a card with an imageUrl but NO imageAlt (a blocked image would show nothing)", () => {
    const result = validateEmailDocument({
      blocks: [{ id: "1", kind: "card", imageUrl: "https://x.test/a.png" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/"imageAlt" is required/);
  });

  test('accepts a card with imageAlt: "" — the explicit "decorative" value', () => {
    const result = validateEmailDocument({
      blocks: [{ id: "1", kind: "card", imageUrl: "https://x.test/a.png", imageAlt: "" }],
    });
    expect(result.ok).toBe(true);
  });

  test("rejects a card ctaLabel with no ctaUrl (a dead button)", () => {
    const result = validateEmailDocument({
      blocks: [{ id: "1", kind: "card", ctaLabel: "Give" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/"ctaLabel" and "ctaUrl" must be set together/);
  });

  test("rejects a card ctaUrl with no ctaLabel (an invisible button)", () => {
    const result = validateEmailDocument({
      blocks: [{ id: "1", kind: "card", ctaUrl: "https://x.test/give" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/"ctaLabel" and "ctaUrl" must be set together/);
  });

  test("(SECURITY) rejects a card ctaUrl with a disallowed scheme", () => {
    const result = validateEmailDocument({
      blocks: [
        { id: "1", kind: "card", ctaLabel: "Click", ctaUrl: "javascript:alert(1)" },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/"ctaUrl" must start with http:, https:, or mailto:/);
  });

  test("(SECURITY) rejects a card imageUrl with a disallowed scheme", () => {
    const result = validateEmailDocument({
      blocks: [
        { id: "1", kind: "card", imageUrl: "data:image/png;base64,xxx", imageAlt: "x" },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/"imageUrl" must start with http: or https:/);
  });

  test("the same card rules apply inside a columns entry, and the error names the column", () => {
    const result = validateEmailDocument({
      blocks: [
        {
          id: "1",
          kind: "columns",
          columns: [{ heading: "ok" }, { imageUrl: "https://x.test/a.png" }],
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/columns\[1\]/);
  });
});

describe("validateEmailDocument — card presentation fields", () => {
  test("accepts every variant, image side, alignment and CTA style", () => {
    const result = validateEmailDocument({
      blocks: [
        { id: "1", kind: "card", variant: "plain" },
        { id: "2", kind: "card", variant: "hero", align: "center", ctaStyle: "filled" },
        { id: "3", kind: "card", variant: "feature", imageSide: "left", imageWidthPct: 44 },
        { id: "4", kind: "card", variant: "outlined", imageSide: "right", ctaStyle: "outline" },
        { id: "5", kind: "card", variant: "testimonial", attribution: "Carla", align: "left" },
        { id: "6", kind: "card", imageSide: "top", eyebrow: "THIS MONTH" },
      ],
    });
    expect(result.ok).toBe(true);
  });

  test("rejects an unknown variant rather than falling through to plain", () => {
    const result = validateEmailDocument({
      blocks: [{ id: "1", kind: "card", variant: "fancy" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/"variant" must be/);
      // The message names every accepted value, so the author isn't guessing.
      expect(result.error).toMatch(/"testimonial"/);
    }
  });

  test("rejects an unknown imageSide, align and ctaStyle", () => {
    for (const [key, bad] of [
      ["imageSide", "bottom"],
      ["align", "justify"],
      ["ctaStyle", "ghost"],
    ] as const) {
      const result = validateEmailDocument({
        blocks: [{ id: "1", kind: "card", [key]: bad }],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(new RegExp(`"${key}" must be`));
    }
  });

  test("imageWidthPct is held to 20-80 (a thumbnail, or no room for a line of copy)", () => {
    for (const pct of [20, 44, 52, 80]) {
      expect(
        validateEmailDocument({ blocks: [{ id: "1", kind: "card", imageWidthPct: pct }] }).ok,
      ).toBe(true);
    }
    for (const pct of [19, 81, 0, 100, Number.NaN]) {
      const result = validateEmailDocument({
        blocks: [{ id: "1", kind: "card", imageWidthPct: pct }],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/"imageWidthPct" must be a number between 20 and 80/);
    }
  });

  test("rejects a non-number imageWidthPct (a percent typed as a string)", () => {
    const result = validateEmailDocument({
      blocks: [{ id: "1", kind: "card", imageWidthPct: "44" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/"imageWidthPct"/);
  });

  test("rejects a non-string eyebrow or attribution", () => {
    for (const key of ["eyebrow", "attribution"] as const) {
      const result = validateEmailDocument({
        blocks: [{ id: "1", kind: "card", [key]: 5 }],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(new RegExp(`"${key}" must be a string`));
    }
  });

  test("the presentation rules apply inside a columns entry too", () => {
    const result = validateEmailDocument({
      blocks: [
        { id: "1", kind: "columns", columns: [{ variant: "hero" }, { variant: "nope" }] },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/columns\[1\]: "variant" must be/);
  });
});

describe("validateEmailDocument — button variant", () => {
  test("accepts filled and outline", () => {
    for (const variant of ["filled", "outline"]) {
      expect(
        validateEmailDocument({
          blocks: [{ id: "1", kind: "button", label: "Go", url: "https://x.test", variant }],
        }).ok,
      ).toBe(true);
    }
  });

  test("rejects any other variant", () => {
    const result = validateEmailDocument({
      blocks: [{ id: "1", kind: "button", label: "Go", url: "https://x.test", variant: "ghost" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/button "variant" must be "filled" or "outline"/);
  });
});

describe("validateEmailDocument — bleed_image", () => {
  test("accepts a filled slot, with and without a link", () => {
    const result = validateEmailDocument({
      blocks: [
        { id: "1", kind: "bleed_image", url: "https://x.test/masthead.png", alt: "Masthead" },
        {
          id: "2",
          kind: "bleed_image",
          url: "https://x.test/song.png",
          alt: "Song artwork",
          href: "https://x.test/listen",
          inset: true,
        },
      ],
    });
    expect(result.ok).toBe(true);
  });

  test("accepts an UNFILLED slot — absent or empty url", () => {
    // The built-in template ships its masthead and banners empty so the layout
    // is right from the first open without naming a URL this deployment may
    // not own; the renderer draws a placeholder band and requests nothing.
    expect(
      validateEmailDocument({
        blocks: [{ id: "1", kind: "bleed_image", alt: "Masthead" }],
      }).ok,
    ).toBe(true);
    expect(
      validateEmailDocument({
        blocks: [{ id: "1", kind: "bleed_image", url: "", alt: "Masthead" }],
      }).ok,
    ).toBe(true);
  });

  test("alt stays REQUIRED even for an unfilled slot", () => {
    const result = validateEmailDocument({
      blocks: [{ id: "1", kind: "bleed_image" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/bleed_image "alt"/);
  });

  test('accepts alt: "" — the explicit "decorative" value', () => {
    expect(
      validateEmailDocument({
        blocks: [{ id: "1", kind: "bleed_image", url: "https://x.test/a.png", alt: "" }],
      }).ok,
    ).toBe(true);
  });

  test("(SECURITY) a non-empty url with a disallowed scheme is still rejected", () => {
    for (const url of ["data:image/png;base64,xxx", "javascript:alert(1)", "/local.png"]) {
      const result = validateEmailDocument({
        blocks: [{ id: "1", kind: "bleed_image", url, alt: "x" }],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/bleed_image "url" must start with http: or https:/);
    }
  });

  test("(SECURITY) rejects a disallowed href scheme", () => {
    const result = validateEmailDocument({
      blocks: [
        {
          id: "1",
          kind: "bleed_image",
          url: "https://x.test/a.png",
          alt: "x",
          href: "javascript:alert(1)",
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/bleed_image "href"/);
  });

  test("rejects a non-boolean inset", () => {
    const result = validateEmailDocument({
      blocks: [{ id: "1", kind: "bleed_image", alt: "x", inset: "yes" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/bleed_image "inset" must be a boolean/);
  });

  test("rejects a non-string url", () => {
    const result = validateEmailDocument({
      blocks: [{ id: "1", kind: "bleed_image", url: 5, alt: "x" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/bleed_image "url"/);
  });
});

describe("validateEmailDocument — hairline", () => {
  test("accepts a bare hairline (it carries no fields)", () => {
    expect(validateEmailDocument({ blocks: [{ id: "1", kind: "hairline" }] }).ok).toBe(true);
  });

  test("still requires an id, like every other block", () => {
    const result = validateEmailDocument({ blocks: [{ kind: "hairline" }] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/"id" must be a non-empty string/);
  });
});

describe("validateEmailDocument — footer", () => {
  test("accepts a bare footer and a fully-populated one", () => {
    const result = validateEmailDocument({
      blocks: [
        { id: "1", kind: "footer" },
        {
          id: "2",
          kind: "footer",
          logoUrl: "https://x.test/logo.png",
          logoAlt: "Public Worship",
          navLine: "Events · Giving · Contact",
          links: [
            { label: "Instagram", url: "https://instagram.com/x" },
            { label: "Email us", url: "mailto:hi@x.test" },
          ],
        },
      ],
    });
    expect(result.ok).toBe(true);
  });

  test("logoAlt is REQUIRED once a logoUrl is set (the card-image rule)", () => {
    const result = validateEmailDocument({
      blocks: [{ id: "1", kind: "footer", logoUrl: "https://x.test/logo.png" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/footer "logoAlt" is required/);
  });

  test('accepts logoAlt: "" — the explicit "decorative" value', () => {
    expect(
      validateEmailDocument({
        blocks: [
          { id: "1", kind: "footer", logoUrl: "https://x.test/logo.png", logoAlt: "" },
        ],
      }).ok,
    ).toBe(true);
  });

  test("(SECURITY) rejects a logoUrl with a disallowed scheme", () => {
    const result = validateEmailDocument({
      blocks: [
        {
          id: "1",
          kind: "footer",
          logoUrl: "data:image/png;base64,xxx",
          logoAlt: "x",
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/footer "logoUrl" must start with http: or https:/);
  });

  test("(SECURITY) rejects a link with a disallowed scheme, naming the index", () => {
    const result = validateEmailDocument({
      blocks: [
        {
          id: "1",
          kind: "footer",
          links: [
            { label: "ok", url: "https://x.test" },
            { label: "bad", url: "javascript:alert(1)" },
          ],
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/footer links\[1\] "url"/);
  });

  test("rejects a link with an empty label (an invisible link)", () => {
    const result = validateEmailDocument({
      blocks: [{ id: "1", kind: "footer", links: [{ label: "", url: "https://x.test" }] }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/footer links\[0\] "label"/);
  });

  test("caps the link row at eight, and accepts exactly eight", () => {
    const link = (i: number) => ({ label: `L${i}`, url: `https://x.test/${i}` });
    const eight = Array.from({ length: 8 }, (_, i) => link(i));
    expect(
      validateEmailDocument({ blocks: [{ id: "1", kind: "footer", links: eight }] }).ok,
    ).toBe(true);

    const nine = Array.from({ length: 9 }, (_, i) => link(i));
    const result = validateEmailDocument({
      blocks: [{ id: "1", kind: "footer", links: nine }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/footer must have 8 links or fewer/);
  });

  test("rejects a non-array links and a non-object entry", () => {
    expect(
      validateEmailDocument({ blocks: [{ id: "1", kind: "footer", links: "x" }] }).ok,
    ).toBe(false);
    const result = validateEmailDocument({
      blocks: [{ id: "1", kind: "footer", links: ["https://x.test"] }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/footer links\[0\] must be an object/);
  });

  test("rejects a non-string navLine", () => {
    const result = validateEmailDocument({
      blocks: [{ id: "1", kind: "footer", navLine: 5 }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/footer "navLine" must be a string/);
  });
});

describe("validateEmailDocument — columns bounds", () => {
  test("rejects a single-column row (that's a card)", () => {
    const result = validateEmailDocument({
      blocks: [{ id: "1", kind: "columns", columns: [{ heading: "Only" }] }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/columns must have 2-3 columns/);
  });

  test("rejects four columns (unreadably narrow on a phone)", () => {
    const result = validateEmailDocument({
      blocks: [
        { id: "1", kind: "columns", columns: [{}, {}, {}, {}] },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/columns must have 2-3 columns/);
  });

  test("accepts the 2- and 3-column boundaries", () => {
    expect(
      validateEmailDocument({ blocks: [{ id: "1", kind: "columns", columns: [{}, {}] }] }).ok,
    ).toBe(true);
    expect(
      validateEmailDocument({ blocks: [{ id: "1", kind: "columns", columns: [{}, {}, {}] }] }).ok,
    ).toBe(true);
  });

  test("rejects a columns block whose columns field isn't an array", () => {
    const result = validateEmailDocument({
      blocks: [{ id: "1", kind: "columns", columns: "two" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/columns "columns" must be an array/);
  });
});

describe("validateEmailDocument — poll", () => {
  function poll(options: unknown) {
    return { blocks: [{ id: "1", kind: "poll", question: "Which night?", options }] };
  }

  test("rejects a single option (that isn't a choice)", () => {
    const result = validateEmailDocument(poll([{ id: "a", label: "Friday" }]));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/poll must have 2-6 options/);
  });

  test("rejects seven options (taller than the email that contains it)", () => {
    const seven = Array.from({ length: 7 }, (_, i) => ({ id: `o${i}`, label: `Option ${i}` }));
    const result = validateEmailDocument(poll(seven));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/poll must have 2-6 options/);
  });

  test("accepts the 2- and 6-option boundaries", () => {
    const two = Array.from({ length: 2 }, (_, i) => ({ id: `o${i}`, label: `Option ${i}` }));
    const six = Array.from({ length: 6 }, (_, i) => ({ id: `o${i}`, label: `Option ${i}` }));
    expect(validateEmailDocument(poll(two)).ok).toBe(true);
    expect(validateEmailDocument(poll(six)).ok).toBe(true);
  });

  test("rejects duplicate option ids — a duplicate would silently merge two tallies", () => {
    const result = validateEmailDocument(
      poll([
        { id: "a", label: "Friday" },
        { id: "a", label: "Saturday" },
      ]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/duplicate id "a"/);
  });

  test("rejects an option with a blank id or label", () => {
    const blankId = validateEmailDocument(
      poll([
        { id: "", label: "Friday" },
        { id: "b", label: "Saturday" },
      ]),
    );
    expect(blankId.ok).toBe(false);
    if (!blankId.ok) expect(blankId.error).toMatch(/options\[0\] "id"/);

    const blankLabel = validateEmailDocument(
      poll([
        { id: "a", label: "" },
        { id: "b", label: "Saturday" },
      ]),
    );
    expect(blankLabel.ok).toBe(false);
    if (!blankLabel.ok) expect(blankLabel.error).toMatch(/options\[0\] "label"/);
  });

  test("rejects a poll with an empty question", () => {
    const result = validateEmailDocument({
      blocks: [
        {
          id: "1",
          kind: "poll",
          question: "",
          options: [
            { id: "a", label: "A" },
            { id: "b", label: "B" },
          ],
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/poll "question"/);
  });
});

describe("validateEmailDocument — linked images", () => {
  test("accepts an image with an allowed href", () => {
    const result = validateEmailDocument({
      blocks: [
        {
          id: "1",
          kind: "image",
          url: "https://x.test/art.png",
          alt: "Artwork",
          href: "https://x.test/listen",
        },
      ],
    });
    expect(result.ok).toBe(true);
  });

  test("(SECURITY) rejects a javascript: image href at the write gate", () => {
    const result = validateEmailDocument({
      blocks: [
        {
          id: "1",
          kind: "image",
          url: "https://x.test/art.png",
          alt: "Artwork",
          href: "javascript:alert(1)",
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/image "href" must start with http:, https:, or mailto:/);
  });

  test("rejects an empty image href", () => {
    const result = validateEmailDocument({
      blocks: [
        { id: "1", kind: "image", url: "https://x.test/art.png", alt: "a", href: "" },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/image "href"/);
  });
});

describe("validateEmailDocument — embedded theme", () => {
  test("accepts a document carrying a valid theme", () => {
    const result = validateEmailDocument({
      blocks: [{ id: "1", kind: "heading", text: "Hi" }],
      theme: PUBLIC_WORSHIP_THEME,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.doc.theme?.accent).toBe("#891d1a");
  });

  test("a document with no theme is still valid (themes are additive)", () => {
    const result = validateEmailDocument({ blocks: [{ id: "1", kind: "divider" }] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.doc.theme).toBeUndefined();
  });

  test("rejects a malformed theme and prefixes the error with 'theme:'", () => {
    const result = validateEmailDocument({
      blocks: [],
      theme: { ...PUBLIC_WORSHIP_THEME, accent: "maroon" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/^theme: /);
      expect(result.error).toMatch(/"accent"/);
    }
  });

  test("rejects a half-filled theme — the renderer would paint 'undefined' on a real send", () => {
    const result = validateEmailDocument({ blocks: [], theme: { name: "Half", accent: "#891d1a" } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/^theme: /);
  });

  test("rejects a non-object theme", () => {
    const result = validateEmailDocument({ blocks: [], theme: "Public Worship" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/^theme: .*must be an object/);
  });

  test("(SECURITY) rejects a theme whose font stack could escape the CSS context", () => {
    const result = validateEmailDocument({
      blocks: [],
      theme: { ...PUBLIC_WORSHIP_THEME, bodyFont: "Inter}</style><script>alert(1)</script>" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/^theme: .*"bodyFont"/);
  });
});
