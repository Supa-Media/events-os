/**
 * THE WORDS THE CANVAS SAYS THAT THE EMAIL NEVER WILL — and the one rule that
 * decides when, and how loudly, it may say them.
 *
 * Every string in `CANVAS_PLACEHOLDERS` is EDITOR CHROME: prompts that tell an
 * author what belongs in an empty slot. None of them is in the document, so
 * none of them can reach an inbox — `emailRender.ts` skips an empty heading,
 * body, eyebrow, attribution or CTA entirely. A canvas that draws them anyway
 * is a canvas that shows copy the email does not contain, and the place that
 * costs is the APPROVER's screen: a locked campaign covered in
 * "Supports **bold**, *italic*…" where the newsletter's own words should be,
 * with no control on screen to explain why.
 *
 * ── The rule ───────────────────────────────────────────────────────────────
 * An empty slot draws one of four things, and `emptySlotDraw` is the only
 * place that decides which:
 *
 *   locked (`editable === false`)  → NOTHING. A read-only canvas is a picture
 *                                    of the email, and the email has nothing
 *                                    there.
 *   editable, block unselected     → an OUTLINE: a small neutral mark, no
 *                                    words. The author can still see and click
 *                                    an empty block (a block that vanishes is
 *                                    a block that can't be selected, deleted
 *                                    or filled), but nothing on the page reads
 *                                    as copy.
 *   editable, selected, REQUIRED   → the PLACEHOLDER itself, in the slot's own
 *                                    type at reduced opacity. The slot is
 *                                    genuinely unfinished — a card with no
 *                                    heading is not a card yet — so the prompt
 *                                    is allowed to be assertive.
 *   editable, selected, OPTIONAL   → a HINT: the same words, set small, light
 *                                    and untransformed. An eyebrow and an
 *                                    attribution are slots most cards never
 *                                    use, and drawn in their own type they are
 *                                    a bold SHOUTING LINE and a second byline
 *                                    that read as content the author has to
 *                                    deal with. ("Selecting the hero card
 *                                    paints SMALL LINE ABOVE THE HEADING into
 *                                    the design" is the report this answers.)
 *
 * That is what `BlockViewProps.selected`'s docstring has always promised —
 * "an unselected block draws only what the email will actually contain".
 *
 * Not in here, deliberately: the card's side-by-side "Image" tile and a bleed
 * banner's "Add artwork from the image library" band. `cardImageHtml` and
 * `renderBleedImage` emit those, word for word, into the real email — they are
 * content, not chrome, and the canvas draws them at every moment the email
 * would.
 */
import type { TextStyle } from "react-native";

/** What an empty slot draws. See the module doc. */
export type EmptySlotDraw = "nothing" | "outline" | "placeholder" | "hint";

/**
 * The prompts, in one table so that "is this string chrome or content?" has a
 * single answer a test can enumerate.
 */
export const CANVAS_PLACEHOLDERS = {
  heading: "Heading",
  bodyMarkdown: "Write your message… **bold**, *italic*, [links](https://…), - lists",
  eyebrow: "THIS MONTH",
  buttonLabel: "Click here",
  /** The standalone `image` block's empty tile. The renderer emits an `<img>`
   *  with an empty `src` for this block — no words, so neither has the canvas. */
  image: "Choose an image",
  quote: "The line worth pulling out",
  quoteAttribution: "Who said it",
  pollQuestion: "What should we do next?",
  cardEyebrow: "Small line above the heading",
  cardHeading: "Card heading",
  cardBody: "Supports **bold**, *italic*, [links](https://…) and - lists",
  cardAttribution: "Who said it",
  cardCtaLabel: "Read more",
  footerNavLine: "Sundays · 10am · The Old Fire Station",
} as const;

/**
 * A slot of the canvas, named. Every editable run on the canvas passes one of
 * these, and the table below is what makes "is this slot the author's problem
 * or the canvas's suggestion?" a single lookup rather than a judgement made
 * again at each of a dozen call sites.
 *
 * `pollOption` numbers its own prompt (`pollOptionPlaceholder`), so it is a
 * slot without a fixed string.
 */
export type CanvasSlot = keyof typeof CANVAS_PLACEHOLDERS | "pollOption";

/**
 * The slots that are an EXTRA PART of a block that exists for something else.
 *
 * A card with no eyebrow, no attribution and no CTA is still a card; a quote
 * with no attribution is still a quote; a footer with no nav line is still a
 * footer. `emailRender.ts` skips each of them without leaving a hole.
 *
 * Everything else is a slot its own block is unfinished without — a heading
 * block with no heading, a card with no body, a button with no label, a
 * standalone eyebrow block whose only content is the eyebrow — and those keep
 * the assertive prompt, because there the author really does have something
 * left to do.
 */
const OPTIONAL_SLOTS: ReadonlySet<CanvasSlot> = new Set<CanvasSlot>([
  "quoteAttribution",
  "cardEyebrow",
  "cardAttribution",
  "cardCtaLabel",
  "footerNavLine",
]);

export function slotIsOptional(slot: CanvasSlot): boolean {
  return OPTIONAL_SLOTS.has(slot);
}

/** The prompt for a slot. A poll option's is numbered rather than fixed, so it
 *  takes the option's index. */
export function slotPrompt(slot: CanvasSlot, pollIndex = 0): string {
  return slot === "pollOption"
    ? pollOptionPlaceholder(pollIndex)
    : CANVAS_PLACEHOLDERS[slot];
}

/**
 * The one decision. Takes the canvas's mode, the block's selection and which
 * slot is asking — and nothing else, because every further exception is
 * another field that leaks.
 */
export function emptySlotDraw(
  editable: boolean,
  selected: boolean,
  slot: CanvasSlot,
): EmptySlotDraw {
  if (!editable) return "nothing";
  if (!selected) return "outline";
  return slotIsOptional(slot) ? "hint" : "placeholder";
}

/**
 * How loudly a prompt is drawn, as a factor of the slot's own type.
 *
 * EDITOR CHROME, so these are the only numbers in this file — no email geometry
 * is invented here (`canvasStyles.ts` owns all of that, from
 * `EMAIL_GEOMETRY`). They live beside the rule rather than in the component so
 * that "quieter than real copy" is a thing a test can hold to.
 */
export const PROMPT_VOICE = {
  /** A required slot: the slot's own type, dimmed enough to read as a prompt. */
  placeholder: { opacity: 0.45, scale: 1 },
  /** An optional slot: small, light, and never in the slot's own weight or
   *  capitals. `minSize` keeps a 12px eyebrow's hint legible. */
  hint: { opacity: 0.32, scale: 0.8, minSize: 11 },
} as const;

/**
 * The type overrides a prompt is drawn with, on top of the slot's own style.
 *
 * A hint keeps the slot's LINE BOX (`lineHeight`) even though it sets smaller
 * type, so an empty optional slot occupies exactly the row its wordless
 * outline occupied — selecting a block reveals its slots without moving a
 * single pixel of the block.
 */
export function promptStyle(
  draw: "placeholder" | "hint",
  slot: { fontSize: number | undefined; lineHeight: number },
): TextStyle {
  if (draw === "placeholder") {
    return { opacity: PROMPT_VOICE.placeholder.opacity };
  }
  const size = typeof slot.fontSize === "number" ? slot.fontSize : slot.lineHeight;
  return {
    opacity: PROMPT_VOICE.hint.opacity,
    fontSize: Math.max(PROMPT_VOICE.hint.minSize, Math.round(size * PROMPT_VOICE.hint.scale)),
    lineHeight: slot.lineHeight,
    // An eyebrow is 700 and uppercase and tracked out; that treatment is for
    // COPY. Its prompt is a label about an empty slot, so it drops all three.
    fontWeight: "400",
    textTransform: "none",
    letterSpacing: 0,
  };
}

/** A poll option's prompt, which is numbered rather than fixed. */
export function pollOptionPlaceholder(index: number): string {
  return `Option ${index + 1}`;
}
