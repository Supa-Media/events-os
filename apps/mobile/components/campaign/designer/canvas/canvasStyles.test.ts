import { beforeAll, afterAll, describe, expect, test } from "@jest/globals";
// React Native's OWN style validator, not a transcription of it — the point of
// the native tests below is that they fail if RN's rules change under us.
// `jest.config.js` transforms `react-native` so this single pure helper is
// importable from a node-environment test.
// @ts-expect-error — an RN internal, shipped as Flow with no .d.ts. Reaching
// past the package's public surface is the point: the public `StyleSheet` has
// no way to ask "would a dev build accept this transformOrigin?".
import processTransformOrigin from "react-native/Libraries/StyleSheet/processTransformOrigin";
import {
  DEFAULT_EMAIL_THEME,
  EMAIL_CARD_SPECS,
  EMAIL_GEOMETRY,
  EMAIL_SPACER_HEIGHTS,
  renderCampaignEmail,
  type EmailBlock,
  type EmailDocument,
} from "@events-os/shared";
import {
  BUTTON_DEFAULT_ALIGN,
  CANVAS_WIDTH,
  FALLBACK_FOOTER_PADDING,
  FOOTER_LINK_SEPARATOR,
  QUOTE_ATTRIBUTION_PREFIX,
  blockGutter,
  bodyParagraphSpacing,
  buttonAlign,
  canvasFontFamily,
  canvasScale,
  canvasTheme,
  cardAlign,
  cardBoxStyle,
  cardColumnSplit,
  cardHeadingStyle,
  cardSpecFor,
  fallbackFooterTextStyle,
  footerLinksStyle,
  headingStyle,
  linkTextStyle,
  spacerHeight,
  trackingPx,
  transformOrigin,
} from "./canvasStyles";

const t = DEFAULT_EMAIL_THEME;

/** The document as the inbox will get it — the arbiter every "does the canvas
 *  agree?" test below is measured against. */
const html = (blocks: EmailBlock[]): string =>
  renderCampaignEmail({ blocks } as EmailDocument, {
    recipient: { name: "Ada Lovelace", email: "ada@example.com" },
    unsubscribeUrl: "https://example.test/u/1",
  });

describe("canvasScale", () => {
  test("never magnifies — 600px IS the design", () => {
    expect(canvasScale(1200)).toBe(1);
    expect(canvasScale(600)).toBe(1);
  });

  test("shrinks proportionally below 600, so the layout still matches the inbox", () => {
    expect(canvasScale(300)).toBe(0.5);
    expect(canvasScale(450)).toBe(0.75);
  });

  test("survives the first render, when nothing has been measured yet", () => {
    expect(canvasScale(0)).toBe(1);
    expect(canvasScale(Number.NaN)).toBe(1);
  });
});

describe("trackingPx", () => {
  test("converts the theme's em tracking to the px RN needs", () => {
    expect(trackingPx("-0.04em", 38)).toBeCloseTo(-1.52);
    expect(trackingPx("0.1em", 12)).toBeCloseTo(1.2);
  });

  test("an unparseable value contributes nothing rather than NaN", () => {
    // A NaN letterSpacing blanks the whole text run on native.
    expect(trackingPx("normal", 16)).toBe(0);
    expect(trackingPx("", 16)).toBe(0);
  });
});

describe("the canvas reads the SAME geometry table as the email renderer", () => {
  test("a card's box is exactly its variant's spec", () => {
    for (const [variant, spec] of Object.entries(EMAIL_CARD_SPECS)) {
      const style = cardBoxStyle(t, cardSpecFor(variant as never));
      expect(style.paddingVertical).toBe(spec.padY);
      expect(style.paddingHorizontal).toBe(spec.padX);
      expect(style.borderWidth).toBe(spec.bordered ? 1 : undefined);
    }
  });

  test("a card heading takes its size and line-height from the spec", () => {
    const spec = cardSpecFor("hero");
    const style = cardHeadingStyle(t, spec, "#fff", true);
    expect(style.fontSize).toBe(spec.headingSize);
    expect(style.lineHeight).toBeCloseTo(spec.headingSize * spec.headingLine);
  });

  test("a plain card keeps the pre-variant trailing margin", () => {
    expect(cardBoxStyle(t, cardSpecFor("plain")).marginBottom).toBe(
      EMAIL_GEOMETRY.card.plainMarginBottom,
    );
    expect(cardBoxStyle(t, cardSpecFor("hero")).marginBottom).toBe(
      EMAIL_GEOMETRY.card.marginBottom,
    );
  });

  test("a column cell paints its fill but leaves the row to space it", () => {
    expect(cardBoxStyle(t, cardSpecFor("feature"), { bare: true }).marginBottom).toBeUndefined();
  });

  test("heading sizes are the renderer's own", () => {
    expect(headingStyle(t, 1, true).fontSize).toBe(EMAIL_GEOMETRY.heading.level1Size);
    expect(headingStyle(t, 2, true).fontSize).toBe(EMAIL_GEOMETRY.heading.level2Size);
  });

  test("spacer heights are the renderer's own", () => {
    expect(spacerHeight("sm")).toBe(EMAIL_SPACER_HEIGHTS.sm);
    expect(spacerHeight("lg")).toBe(EMAIL_SPACER_HEIGHTS.lg);
  });

  test("the canvas is laid out at the container's real width", () => {
    expect(CANVAS_WIDTH).toBe(EMAIL_GEOMETRY.container.width);
  });
});

describe("cardColumnSplit", () => {
  test("defaults to the renderer's own asymmetric split, not 50/50", () => {
    const split = cardColumnSplit({});
    expect(split.imagePct).toBe(EMAIL_GEOMETRY_DEFAULT_IMAGE_PCT);
    expect(split.imagePct + split.gapPct + split.textPct).toBe(100);
  });

  test("clamps to the range the write gate accepts", () => {
    expect(cardColumnSplit({ imageWidthPct: 5 }).imagePct).toBe(20);
    expect(cardColumnSplit({ imageWidthPct: 95 }).imagePct).toBe(80);
  });

  test("the gap comes out of the TEXT column, as the HTML does", () => {
    const split = cardColumnSplit({ imageWidthPct: 44 });
    expect(split.imagePct).toBe(44);
    expect(split.textPct).toBe(100 - 44 - split.gapPct);
  });
});

/** The renderer's `content.imageWidthPct ?? 45`. */
const EMAIL_GEOMETRY_DEFAULT_IMAGE_PCT = 45;

describe("blockGutter", () => {
  test("every ordinary block sits inside the container's gutter", () => {
    const block: EmailBlock = { id: "1", kind: "heading", text: "Hi" };
    expect(blockGutter(block)).toBe(EMAIL_GEOMETRY.container.gutterX);
  });

  test("a filled banner bleeds to the edge; an unfilled or inset one does not", () => {
    expect(blockGutter({ id: "1", kind: "bleed_image", url: "https://x/a.png", alt: "" })).toBe(0);
    expect(blockGutter({ id: "1", kind: "bleed_image", alt: "" })).toBe(
      EMAIL_GEOMETRY.container.gutterX,
    );
    expect(
      blockGutter({ id: "1", kind: "bleed_image", url: "https://x/a.png", alt: "", inset: true }),
    ).toBe(EMAIL_GEOMETRY.container.gutterX);
  });
});

describe("cardAlign", () => {
  test("the author's alignment wins, and the variant's is the fallback", () => {
    expect(cardAlign({}, cardSpecFor("hero"))).toBe("center");
    expect(cardAlign({}, cardSpecFor("feature"))).toBe("left");
    expect(cardAlign({ align: "left" }, cardSpecFor("hero"))).toBe("left");
  });

  test("an unknown alignment falls back rather than reaching a style", () => {
    expect(cardAlign({ align: "middle" } as never, cardSpecFor("hero"))).toBe("center");
  });
});

/**
 * THE NATIVE BRANCH — the one jest doesn't take by default, which is exactly
 * why a crash-on-mount shipped in it.
 *
 * Every style helper here is written `isWeb ? … : …`, and the whole mobile
 * suite runs as web. `transformOrigin` was `[0, 0] as unknown as string` on
 * native: RN's `processTransformOrigin` asserts three elements under `__DEV__`,
 * so opening the designer on a dev client was an immediate red screen — on the
 * scaled container of EVERY document, not some rare block.
 *
 * These tests take the NATIVE branch and hand the result to RN's real
 * validator, with `__DEV__` on, so the assertion is the one a dev build makes.
 */
describe("transformOrigin on NATIVE", () => {
  const globals = globalThis as unknown as { __DEV__?: boolean };
  let previousDev: boolean | undefined;

  beforeAll(() => {
    // Metro defines this true in a dev build, and it is the flag that turns on
    // `_validateTransformOrigin`. Without it these tests would assert nothing.
    previousDev = globals.__DEV__;
    globals.__DEV__ = true;
  });
  afterAll(() => {
    globals.__DEV__ = previousDev;
  });

  test("__DEV__ really is on, so RN really is validating", () => {
    // Guard the guard: if this ever stops being true the tests below pass
    // vacuously, which is the failure mode that let the bug through.
    expect(globals.__DEV__).toBe(true);
    expect(() => processTransformOrigin([0, 0])).toThrow(
      /Transform origin must have exactly 3 values/,
    );
  });

  test("both corners survive RN's validator instead of crashing on mount", () => {
    expect(() => processTransformOrigin(transformOrigin("top-left", false))).not.toThrow();
    expect(() => processTransformOrigin(transformOrigin("top-right", false))).not.toThrow();
  });

  test("the native tuples MEAN what the web strings mean", () => {
    // Not merely three-element: `[1, 0, 0]` would also pass the length check
    // and anchor the counter-scaled warning badge 1 PIXEL from the block's
    // LEFT edge instead of at its right. The proof is RN's own parse of the
    // equivalent CSS.
    expect(processTransformOrigin(transformOrigin("top-left", false))).toEqual(
      processTransformOrigin(transformOrigin("top-left", true) as string),
    );
    expect(processTransformOrigin(transformOrigin("top-right", false))).toEqual(
      processTransformOrigin(transformOrigin("top-right", true) as string),
    );
  });

  test("the corners are the corners — top-right is a percentage, not a pixel", () => {
    expect(transformOrigin("top-left", false)).toEqual([0, 0, 0]);
    expect(transformOrigin("top-right", false)).toEqual(["100%", 0, 0]);
    expect(transformOrigin("top-left", true)).toBe("0 0");
    expect(transformOrigin("top-right", true)).toBe("100% 0");
  });
});

/**
 * P1-4 and its neighbours: a default the canvas states for itself is a default
 * that will one day disagree with the send.
 */
describe("canvas defaults are the RENDERER's defaults", () => {
  /** The alignment the email actually SENDS a standalone button at — read off
   *  the wrapper `renderButtonBlock` emits, not the first `text-align` in the
   *  document (the fallback footer has one of those too). */
  const sentButtonAlign = (block: EmailBlock): string | undefined =>
    /<div style="text-align:(left|center);margin:0 0 \d+px">\s*<a /.exec(html([block]))?.[1];

  /** …and the alignment a card sends its heading at. */
  const sentCardHeadingAlign = (block: EmailBlock): string | undefined =>
    /<h3 class="[^"]*"[^>]*text-align:(left|center)"/.exec(html([block]))?.[1];

  test("a button with no align of its own draws where it sends", () => {
    // `defaultBlockFor("button")` sets no `align`, so this is EVERY freshly
    // added button. The canvas drew it left, the inbox centred it, and the
    // inspector asserted "Left".
    const sent = sentButtonAlign({ id: "b", kind: "button", label: "Give", url: "https://x.test" });
    expect(sent).toBe(BUTTON_DEFAULT_ALIGN);
    expect(buttonAlign(undefined)).toBe(sent);
  });

  test("an explicit alignment still wins, both ways", () => {
    expect(buttonAlign("left")).toBe("left");
    expect(buttonAlign("center")).toBe("center");
    expect(buttonAlign("middle" as never)).toBe(BUTTON_DEFAULT_ALIGN);
    for (const align of ["left", "center"] as const) {
      const block: EmailBlock = {
        id: "b",
        kind: "button",
        label: "Give",
        url: "https://x.test",
        align,
      };
      expect(sentButtonAlign(block)).toBe(align);
      expect(buttonAlign(align)).toBe(align);
    }
  });

  test("every card variant's default alignment matches what it sends", () => {
    // The other shape with an `align`: a card takes its variant's when the
    // author hasn't chosen one.
    for (const variant of Object.keys(EMAIL_CARD_SPECS) as (keyof typeof EMAIL_CARD_SPECS)[]) {
      const sent = sentCardHeadingAlign({ id: "c", kind: "card", variant, heading: "Heading" });
      expect({ variant, sent }).toEqual({ variant, sent: cardAlign({}, cardSpecFor(variant)) });
    }
  });
});

/** The small fidelity drifts — each pinned against the real rendered HTML
 *  rather than against a number typed twice. */
describe("canvas geometry agrees with the rendered email", () => {
  test("EVERY paragraph of a body carries the trailing gap, including the last", () => {
    const out = html([{ id: "t", kind: "text", markdown: "One.\n\nTwo." }]);
    const paragraphs = out.match(/<p class="pw-t"[^>]*>/g) ?? [];
    expect(paragraphs).toHaveLength(2);
    const margin = `margin:0 0 ${EMAIL_GEOMETRY.body.marginBottom}px`;
    // The renderer strips it off nothing — so neither may the canvas.
    expect(paragraphs.every((p) => p.includes(margin))).toBe(true);
    expect(bodyParagraphSpacing(false)).toBe(EMAIL_GEOMETRY.body.marginBottom);
    expect(bodyParagraphSpacing(true)).toBe(bodyParagraphSpacing(false));
  });

  test("the em dash in front of a quote's attribution is the RENDERER's", () => {
    const out = html([{ id: "q", kind: "quote", text: "A line.", attribution: "Ada" }]);
    // The canvas draws the prefix and edits the bare name; a placeholder
    // carrying the dash got one typed into the value and sent "— — Ada".
    expect(out).toContain(`>${QUOTE_ATTRIBUTION_PREFIX}Ada<`);
  });

  test("the fallback footer is drawn from its OWN geometry entry", () => {
    // `G.fallbackFooter` coincides with `G.footer.legal*` today; reading the
    // footer's numbers for it is a canvas that silently drifts the first time
    // one moves without the other.
    const out = html([{ id: "h", kind: "heading", text: "Hi" }]);
    const g = EMAIL_GEOMETRY.fallbackFooter;
    expect(out).toContain(`padding:${g.padTop}px ${g.padX}px ${g.padBottom}px`);
    expect(out).toContain(`font-size:${g.size}px;line-height:${g.line}`);
    expect(FALLBACK_FOOTER_PADDING).toEqual({
      paddingTop: g.padTop,
      paddingHorizontal: g.padX,
      paddingBottom: g.padBottom,
    });
    const style = fallbackFooterTextStyle(t, true);
    expect(style.fontSize).toBe(g.size);
    expect(style.lineHeight).toBeCloseTo(g.size * g.line);
  });

  test("a document WITH a footer block gets no fallback row", () => {
    const out = html([{ id: "f", kind: "footer", navLine: "Public Worship" }]);
    expect(out).not.toContain("Sent with love by Public Worship");
  });

  test("footer links send as underlined link-coloured anchors joined by ' | '", () => {
    const out = html([
      {
        id: "f",
        kind: "footer",
        links: [
          { label: "Instagram", url: "https://ig.test" },
          { label: "Give", url: "https://g.test" },
        ],
      },
    ]);
    // The anchors: the theme's LINK colour, underlined — not the muted body
    // colour the canvas used to paint the whole row in.
    expect(out).toContain(`style="color:${t.link};text-decoration:underline">Instagram</a>`);
    const link = linkTextStyle(t);
    expect(link.color).toBe(t.link);
    expect(link.textDecorationLine).toBe("underline");
    // The separator, pinned: one space each side, and muted like the row.
    expect(out).toContain(
      `<span style="color:${t.muted}">${FOOTER_LINK_SEPARATOR}</span>`,
    );
    expect(footerLinksStyle(t, true).color).toBe(t.muted);
  });
});

describe("canvasFontFamily", () => {
  test("web gets the whole CSS stack; native gets the system face", () => {
    expect(canvasFontFamily(t.bodyFont, true)).toBe(t.bodyFont);
    expect(canvasFontFamily(t.bodyFont, false)).toBeUndefined();
  });
});

describe("canvasTheme", () => {
  test("an untouched document renders on the real brand", () => {
    expect(canvasTheme({ blocks: [] })).toBe(DEFAULT_EMAIL_THEME);
    expect(canvasTheme(undefined)).toBe(DEFAULT_EMAIL_THEME);
  });

  test("a document's own theme is normalized at the edge, once", () => {
    const themed = canvasTheme({
      blocks: [],
      theme: { ...DEFAULT_EMAIL_THEME, name: "Advent", accent: "#123456" },
    });
    expect(themed.accent).toBe("#123456");
    expect(themed.name).toBe("Advent");
  });
});
