/**
 * THE WORDS THE CANVAS SAYS THAT THE EMAIL NEVER WILL — and the one rule that
 * decides when it may say them.
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
 * An empty slot draws one of three things, and `emptySlotDraw` is the only
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
 *   editable, block selected       → the PLACEHOLDER itself, in the slot's own
 *                                    type at reduced opacity. This is the
 *                                    affordance: you asked about this block,
 *                                    so here is what goes in it.
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

/** What an empty slot draws. See the module doc. */
export type EmptySlotDraw = "nothing" | "outline" | "placeholder";

/**
 * The one decision. Takes the canvas's mode and the block's selection, and
 * nothing else — no per-field exceptions, because every exception is another
 * field that leaks.
 */
export function emptySlotDraw(editable: boolean, selected: boolean): EmptySlotDraw {
  if (!editable) return "nothing";
  return selected ? "placeholder" : "outline";
}

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

/** A poll option's prompt, which is numbered rather than fixed. */
export function pollOptionPlaceholder(index: number): string {
  return `Option ${index + 1}`;
}
