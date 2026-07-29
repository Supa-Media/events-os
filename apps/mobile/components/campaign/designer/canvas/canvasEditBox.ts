/**
 * THE BOX THE IN-PLACE EDITOR SITS IN — the geometry that keeps clicking a
 * word from moving the document.
 *
 * `CanvasEditableText` swaps a static render (a `<Text>`, or several of them
 * for a markdown body) for a `TextInput` carrying the same type styles. Same
 * type is not the same BOX: a multiline input on web is a `<textarea>` whose
 * natural height is its own default row count, so a three-paragraph hero body
 * collapsed to a two-line field the moment it was clicked and every block
 * below it jumped up the page. That is the "the inline editor is weird,
 * clicking on the text collapses it" the composer's first user reported.
 *
 * So the editor is given a FLOOR: the height the static render actually
 * occupied. Two sources, in order of trust:
 *
 *  1. `measured` — what `onLayout` reported for the static render, wrapping and
 *     all. Truth, when the slot has been drawn once (which it always has: you
 *     have to click the words to start editing them).
 *  2. `staticTextHeight` — the same height DERIVED from the value, for the
 *     first frame of a slot that has not been measured yet. It walks the same
 *     `parseMarkdownSubset` the canvas renders from, so a three-paragraph body
 *     is three line boxes plus three paragraph gaps rather than one line.
 *
 * Pure and React-free — plain `.ts` so this package's node-environment jest can
 * load it (importing `react-native` in a test file fails here; `import type` is
 * erased). Same reason `canvasStyles.ts` and `lib/emailDesigner.ts` are.
 *
 * NO EMAIL GEOMETRY IS INVENTED HERE. Every px this module works in — the line
 * box, the paragraph gap — is passed in by the caller from `canvasStyles.ts`,
 * which reads `EMAIL_GEOMETRY`. The single number below is editor chrome.
 */
import { parseMarkdownSubset } from "@events-os/shared";
import type { TextStyle, ViewStyle } from "react-native";

/**
 * The line box assumed for a type style that declares neither `lineHeight` nor
 * `fontSize`. Chrome, not email geometry: it exists so an unstyled slot still
 * gets a clickable row rather than a zero-height one, and nothing that ships in
 * an email is measured with it.
 */
export const FALLBACK_LINE_HEIGHT = 16;

/** One line of a slot's own type — `lineHeight` if the style sets one, its
 *  `fontSize` if not (RN's own default for a text run with no line-height). */
export function slotLineHeight(
  lineHeight: number | undefined,
  fontSize: number | undefined,
): number {
  if (typeof lineHeight === "number" && lineHeight > 0) return lineHeight;
  if (typeof fontSize === "number" && fontSize > 0) return fontSize;
  return FALLBACK_LINE_HEIGHT;
}

export type StaticTextMetrics = {
  /** What the slot holds — the RAW markdown for a body, plain text otherwise. */
  value: string;
  /** One line of this slot's type, from `slotLineHeight`. */
  lineHeight: number;
  /**
   * The gap the static render leaves under each paragraph or list —
   * `BODY_PARAGRAPH_SPACING` for a markdown slot, 0 for one drawn as a single
   * run. See `canvasStyles.ts#bodyParagraphSpacing`: the renderer stamps that
   * margin onto EVERY paragraph including the last, so the count is blocks,
   * not gaps between blocks.
   */
  paragraphSpacing: number;
  /** Whether this slot is a multiline one. A single-line slot is one line of
   *  type however long its text is — it cannot hold paragraphs. */
  multiline: boolean;
};

/**
 * The height the STATIC render of `value` occupies, ignoring wrapping.
 *
 * A LOWER BOUND on purpose: it counts the blocks `parseMarkdownSubset` finds
 * (a list contributes one line per item, exactly as `CanvasMarkdown` draws it)
 * and cannot know how many extra lines a long paragraph wraps into at this
 * slot's width. Wrapping only ever makes the real box taller, so using this as
 * a floor can never push the document DOWN — and where a measurement exists,
 * it wins.
 */
export function staticTextHeight({
  value,
  lineHeight,
  paragraphSpacing,
  multiline,
}: StaticTextMetrics): number {
  if (!multiline) return lineHeight;
  const blocks = parseMarkdownSubset(value);
  // An empty slot is one clickable line, not nothing: it is about to be typed
  // into.
  if (blocks.length === 0) return lineHeight;
  let lines = 0;
  for (const block of blocks) {
    lines += block.kind === "list" ? Math.max(1, block.items.length) : 1;
  }
  return lines * lineHeight + blocks.length * paragraphSpacing;
}

export type EditBoxInput = StaticTextMetrics & {
  /** The static render's own height, from `onLayout`. Null before it has been
   *  drawn (and after nothing but a placeholder has been). */
  measured: number | null;
  /** What the input says its content needs, from `onContentSizeChange`. Null
   *  until it reports. */
  contentHeight: number | null;
  /**
   * Whether a multiline input on THIS platform grows with its own content.
   * React Native's does; a web `<textarea>` does not — it scrolls — so on web
   * the reported content height has to be written back as an explicit height.
   */
  selfSizing: boolean;
};

export type EditBoxGeometry = {
  /**
   * `minHeight` for the view standing in for the static render's box. This is
   * what holds the document still: the block keeps the height it had, so
   * nothing below it moves when the caret lands.
   */
  wrapperMinHeight: number;
  /**
   * `minHeight` for the input itself — set only when it is MULTILINE, so it
   * fills the box and grows from it. A single-line input must never get one: a
   * web `<input>` centres its text vertically in whatever height it is given,
   * so a two-line heading would drop its words half a line down the page. Left
   * at its natural one line at the top of the box, they stay put.
   */
  inputMinHeight: number | undefined;
  /** An explicit height, only where the platform's multiline input will not
   *  grow by itself and its content has outgrown the floor. */
  inputHeight: number | undefined;
};

/** The floor: the tallest of what was measured, what the value implies, and
 *  one line. Never below the height the static text occupied. */
export function editingBoxMinHeight(input: EditBoxInput): number {
  const measured =
    input.measured !== null && Number.isFinite(input.measured) && input.measured > 0
      ? input.measured
      : 0;
  return Math.max(measured, staticTextHeight(input), input.lineHeight);
}

/**
 * The whole box, ready to be spread into styles.
 *
 * Growth is the other half of the promise: as the author types, the input
 * reports its content and the document reflows around it — but never back
 * below the floor, so the words that were on screen when the caret landed stay
 * on screen.
 */
export function editingBoxGeometry(input: EditBoxInput): EditBoxGeometry {
  const floor = editingBoxMinHeight(input);
  if (!input.multiline) {
    return { wrapperMinHeight: floor, inputMinHeight: undefined, inputHeight: undefined };
  }
  const content =
    input.contentHeight !== null &&
    Number.isFinite(input.contentHeight) &&
    input.contentHeight > floor
      ? input.contentHeight
      : null;
  return {
    wrapperMinHeight: floor,
    inputMinHeight: floor,
    inputHeight: input.selfSizing || content === null ? undefined : content,
  };
}

/** The style keys that describe a text run's OUTER box rather than its type.
 *  RN accepts every one of these on a `View`. */
const BOX_KEYS = [
  "margin",
  "marginTop",
  "marginRight",
  "marginBottom",
  "marginLeft",
  "marginHorizontal",
  "marginVertical",
  "marginStart",
  "marginEnd",
] as const;

/**
 * A slot's type style, split into the BOX it occupies and the TYPE it is set
 * in.
 *
 * Every state of a slot then wears the box on its outermost view and the type
 * on the run inside it, which is what makes the three renders — locked,
 * clickable, focused — the same shape.
 *
 * It also fixes a real drift: RN Web draws a nested `<Text>` as an inline
 * `<span>`, and CSS ignores a vertical margin on an inline box. A heading's
 * `marginBottom` was therefore drawn on a LOCKED canvas (where the run is a
 * direct child of the block's view) and dropped on an editable one — and then
 * reappeared the moment the run was replaced by a `TextInput`, which is a real
 * block box. Clicking a heading pushed everything under it down by its own
 * margin. Hoisting the margins out of the type answers all three cases at once.
 */
export function splitTextBox(style: TextStyle): { box: ViewStyle; type: TextStyle } {
  const box: Record<string, unknown> = {};
  const type: Record<string, unknown> = { ...style };
  for (const key of BOX_KEYS) {
    if (type[key] !== undefined) {
      box[key] = type[key];
      delete type[key];
    }
  }
  return { box: box as ViewStyle, type: type as TextStyle };
}
