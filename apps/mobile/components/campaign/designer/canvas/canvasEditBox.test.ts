/**
 * CLICKING TEXT MUST NOT MOVE THE DOCUMENT.
 *
 * The bug this pins: a three-paragraph hero body, clicked, collapsed into a
 * two-line box and every block below it jumped up the page ("the inline editor
 * is weird, clicking on the text collapses it"). The editing render is a
 * `TextInput`, and nothing told it how tall the words it replaced had been.
 *
 * So the floor is asserted here in the numbers the canvas actually uses —
 * `EMAIL_GEOMETRY`'s body size, line ratio and paragraph margin, via
 * `canvasStyles.ts` — rather than in round numbers that could drift away from
 * the type on screen.
 */
import { describe, expect, test } from "@jest/globals";
import { DEFAULT_EMAIL_THEME } from "@events-os/shared";
import {
  BODY_PARAGRAPH_SPACING,
  bodyTextStyle,
  cardEyebrowStyle,
  headingStyle,
} from "./canvasStyles";
import {
  FALLBACK_LINE_HEIGHT,
  editingBoxGeometry,
  editingBoxMinHeight,
  slotLineHeight,
  splitTextBox,
  staticTextHeight,
} from "./canvasEditBox";

const t = DEFAULT_EMAIL_THEME;
/** The body copy the canvas really sets a `text` block in. */
const BODY = bodyTextStyle(t, true);
const BODY_LINE = slotLineHeight(BODY.lineHeight, BODY.fontSize);

const body = (value: string) => ({
  value,
  lineHeight: BODY_LINE,
  paragraphSpacing: BODY_PARAGRAPH_SPACING,
  multiline: true,
});

describe("slotLineHeight", () => {
  test("the style's own line box wins", () => {
    expect(slotLineHeight(26, 16)).toBe(26);
  });

  test("a style with no line-height falls back to its type size", () => {
    // An eyebrow sets none — `EMAIL_GEOMETRY` gives it no line ratio.
    const eyebrow = cardEyebrowStyle(t, "#000", true);
    expect(eyebrow.lineHeight).toBeUndefined();
    expect(slotLineHeight(eyebrow.lineHeight, eyebrow.fontSize)).toBe(eyebrow.fontSize);
  });

  test("and a style with neither still occupies a clickable row", () => {
    expect(slotLineHeight(undefined, undefined)).toBe(FALLBACK_LINE_HEIGHT);
    expect(slotLineHeight(0, 0)).toBe(FALLBACK_LINE_HEIGHT);
  });
});

describe("staticTextHeight — the shape the words already had", () => {
  test("one line of type for a single-line slot, however long its text", () => {
    const long = "A headline long enough that it certainly wraps on a 600px page";
    expect(
      staticTextHeight({ ...body(long), multiline: false }),
    ).toBe(BODY_LINE);
  });

  test("THE REPORTED CASE: three paragraphs are three lines and three gaps", () => {
    const three = "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.";
    expect(staticTextHeight(body(three))).toBe(
      3 * BODY_LINE + 3 * BODY_PARAGRAPH_SPACING,
    );
    // And that is nothing like one line, which is what the input took before.
    expect(staticTextHeight(body(three))).toBeGreaterThan(BODY_LINE * 2.5);
  });

  test("a paragraph's own newlines are ONE paragraph — the parser joins them", () => {
    // `parseMarkdownSubset` joins consecutive non-blank lines with a space,
    // exactly as `CanvasMarkdown` then draws them, so a soft-wrapped source
    // line is not a second paragraph.
    expect(staticTextHeight(body("one line\nstill the same paragraph"))).toBe(
      BODY_LINE + BODY_PARAGRAPH_SPACING,
    );
  });

  test("a list is one line per item, plus the block's own gap", () => {
    expect(staticTextHeight(body("- one\n- two\n- three"))).toBe(
      3 * BODY_LINE + BODY_PARAGRAPH_SPACING,
    );
  });

  test("a paragraph and a list beneath it are both counted", () => {
    expect(staticTextHeight(body("Intro line\n\n- one\n- two"))).toBe(
      3 * BODY_LINE + 2 * BODY_PARAGRAPH_SPACING,
    );
  });

  test("an empty slot is one clickable line, not nothing", () => {
    expect(staticTextHeight(body(""))).toBe(BODY_LINE);
    expect(staticTextHeight(body("   \n\n  "))).toBe(BODY_LINE);
  });

  test("the mark-up itself never inflates the box", () => {
    // `**bold**` is one paragraph whether or not it carries markers — the
    // estimate walks the parsed blocks, not the raw characters.
    expect(staticTextHeight(body("**bold** and *italic*"))).toBe(
      staticTextHeight(body("bold and italic")),
    );
  });
});

describe("editingBoxMinHeight — the floor the input may not fall below", () => {
  const three = "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.";

  test("a measured static render is the truth, wrapping and all", () => {
    // 214 is what `onLayout` saw: three paragraphs that each wrapped twice.
    expect(
      editingBoxMinHeight({
        ...body(three),
        measured: 214,
        contentHeight: null,
        selfSizing: false,
      }),
    ).toBe(214);
  });

  test("with nothing measured yet it still refuses to collapse", () => {
    expect(
      editingBoxMinHeight({
        ...body(three),
        measured: null,
        contentHeight: null,
        selfSizing: false,
      }),
    ).toBe(3 * BODY_LINE + 3 * BODY_PARAGRAPH_SPACING);
  });

  test("a stale measurement never shrinks the box below the current value", () => {
    // Measured while the body was one line; the author has since pasted three
    // paragraphs. The floor follows the value.
    const floor = editingBoxMinHeight({
      ...body(three),
      measured: BODY_LINE,
      contentHeight: null,
      selfSizing: false,
    });
    expect(floor).toBe(3 * BODY_LINE + 3 * BODY_PARAGRAPH_SPACING);
  });

  test("a nonsense measurement is ignored rather than believed", () => {
    for (const measured of [0, -12, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        editingBoxMinHeight({
          ...body("One line."),
          measured,
          contentHeight: null,
          selfSizing: false,
        }),
      ).toBe(BODY_LINE + BODY_PARAGRAPH_SPACING);
    }
  });

  test("a single-line slot is floored at the box it was measured in", () => {
    // A hero heading that wrapped to two lines: the block keeps that height.
    const h1 = headingStyle(t, 1, true);
    const line = slotLineHeight(h1.lineHeight, h1.fontSize);
    expect(
      editingBoxMinHeight({
        value: "A headline that wrapped",
        lineHeight: line,
        paragraphSpacing: 0,
        multiline: false,
        measured: line * 2,
        contentHeight: null,
        selfSizing: false,
      }),
    ).toBe(line * 2);
  });
});

describe("editingBoxGeometry — what each view is actually given", () => {
  const three = "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.";
  const measured = 3 * BODY_LINE + 3 * BODY_PARAGRAPH_SPACING;

  test("a single-line slot floors the WRAPPER and never the input", () => {
    // A web `<input>` centres its text in whatever height it is given, so
    // holding the box on the input itself would drop a heading's words half a
    // line down the page. The wrapper holds it; the input stays one line, at
    // the top, exactly where the words were.
    const g = editingBoxGeometry({
      value: "Heading",
      lineHeight: 43,
      paragraphSpacing: 0,
      multiline: false,
      measured: 86,
      contentHeight: null,
      selfSizing: false,
    });
    expect(g.wrapperMinHeight).toBe(86);
    expect(g.inputMinHeight).toBeUndefined();
    expect(g.inputHeight).toBeUndefined();
  });

  test("a multiline slot fills the box it inherited", () => {
    const g = editingBoxGeometry({
      ...body(three),
      measured,
      contentHeight: null,
      selfSizing: false,
    });
    expect(g.wrapperMinHeight).toBe(measured);
    expect(g.inputMinHeight).toBe(measured);
    expect(g.inputHeight).toBeUndefined();
  });

  test("on web, content taller than the floor is written back as a height", () => {
    // The raw markdown is taller than its rendered self (blank lines, `**`),
    // and the author keeps typing. A textarea does not grow on its own.
    const g = editingBoxGeometry({
      ...body(three),
      measured,
      contentHeight: measured + 60,
      selfSizing: false,
    });
    expect(g.inputHeight).toBe(measured + 60);
    expect(g.wrapperMinHeight).toBe(measured);
  });

  test("content SHORTER than the floor is ignored — the box never shrinks", () => {
    const g = editingBoxGeometry({
      ...body(three),
      measured,
      contentHeight: BODY_LINE,
      selfSizing: false,
    });
    expect(g.inputHeight).toBeUndefined();
    expect(g.inputMinHeight).toBe(measured);
  });

  test("on native nothing is written back — RN's own input already grows", () => {
    const g = editingBoxGeometry({
      ...body(three),
      measured,
      contentHeight: measured + 60,
      selfSizing: true,
    });
    expect(g.inputHeight).toBeUndefined();
    expect(g.inputMinHeight).toBe(measured);
  });

  test("every number handed to a style is a finite one", () => {
    // A NaN in a style value is a red screen on a dev client, not a fallback.
    for (const contentHeight of [null, Number.NaN, Number.POSITIVE_INFINITY, -5]) {
      const g = editingBoxGeometry({
        ...body(three),
        measured: Number.NaN,
        contentHeight,
        selfSizing: false,
      });
      for (const v of [g.wrapperMinHeight, g.inputMinHeight, g.inputHeight]) {
        if (v !== undefined) expect(Number.isFinite(v)).toBe(true);
      }
      expect(g.wrapperMinHeight).toBe(measured);
    }
  });
});

describe("splitTextBox — one shape in all three states", () => {
  test("margins go to the box, type stays with the words", () => {
    const h1 = headingStyle(t, 1, true);
    const { box, type } = splitTextBox(h1);
    // `EMAIL_GEOMETRY.heading.marginBottom` — the gap under a heading.
    expect(box.marginBottom).toBe(h1.marginBottom);
    expect(box.marginBottom).toBeGreaterThan(0);
    expect(type.marginBottom).toBeUndefined();
    // Everything that decides how the words LOOK is untouched, so nothing
    // moves, resizes or changes colour when the input takes over.
    expect(type.fontSize).toBe(h1.fontSize);
    expect(type.lineHeight).toBe(h1.lineHeight);
    expect(type.color).toBe(h1.color);
    expect(type.letterSpacing).toBe(h1.letterSpacing);
    expect(type.fontWeight).toBe(h1.fontWeight);
  });

  test("a style with no margins is left alone", () => {
    const { box, type } = splitTextBox(BODY);
    expect(box).toEqual({});
    expect(type).toEqual(BODY);
  });

  test("it does not mutate the style it was handed", () => {
    const h1 = headingStyle(t, 1, true);
    const before = { ...h1 };
    splitTextBox(h1);
    expect(h1).toEqual(before);
  });

  test("every margin form is hoisted, not just the one used today", () => {
    const { box, type } = splitTextBox({
      marginTop: 1,
      marginHorizontal: 2,
      marginStart: 3,
      fontSize: 4,
    });
    expect(box).toEqual({ marginTop: 1, marginHorizontal: 2, marginStart: 3 });
    expect(type).toEqual({ fontSize: 4 });
  });
});
