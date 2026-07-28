import { describe, expect, test } from "@jest/globals";
import {
  DEFAULT_EMAIL_THEME,
  EMAIL_CARD_SPECS,
  EMAIL_GEOMETRY,
  EMAIL_SPACER_HEIGHTS,
  type EmailBlock,
} from "@events-os/shared";
import {
  CANVAS_WIDTH,
  blockGutter,
  canvasFontFamily,
  canvasScale,
  canvasTheme,
  cardAlign,
  cardBoxStyle,
  cardColumnSplit,
  cardHeadingStyle,
  cardSpecFor,
  headingStyle,
  spacerHeight,
  trackingPx,
} from "./canvasStyles";

const t = DEFAULT_EMAIL_THEME;

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
