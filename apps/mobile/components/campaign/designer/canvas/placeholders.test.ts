/**
 * THE EDITOR'S WORDS MUST NOT REACH THE APPROVER'S SCREEN — and must not
 * SHOUT at the author's.
 *
 * Two halves, and the leak needed both to be true at once:
 *
 *  1. every string in `CANVAS_PLACEHOLDERS` is chrome — `renderCampaignEmail`
 *     emits none of them for the document that provokes them;
 *  2. `emptySlotDraw` refuses to draw any of them on a canvas that isn't
 *     editable, which is exactly the state a locked campaign renders in.
 *
 * Together: a locked campaign's canvas and its send say the same thing.
 *
 * The third half, from the composer's first user: on the AUTHOR's canvas an
 * empty optional slot was drawn in its own type — "SMALL LINE ABOVE THE
 * HEADING" in the eyebrow's bold capitals — so selecting a hero card painted
 * copy into the design that the author then had to deal with. Optional slots
 * are hints; only a genuinely unfinished slot gets the assertive prompt.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "@jest/globals";
import { renderCampaignEmail, type EmailDocument } from "@events-os/shared";
import {
  CANVAS_PLACEHOLDERS,
  PROMPT_VOICE,
  emptySlotDraw,
  pollOptionPlaceholder,
  promptStyle,
  slotIsOptional,
  slotPrompt,
  type CanvasSlot,
} from "./placeholders";

/** A document of blocks whose every optional slot is EMPTY — a fresh card, a
 *  fresh two-column row, an image nobody has chosen yet. This is what a
 *  half-built campaign sitting in review actually looks like. */
const emptyish: EmailDocument = {
  blocks: [
    { id: "c1", kind: "card", variant: "feature", heading: "", body: undefined },
    {
      id: "col1",
      kind: "columns",
      columns: [
        { heading: "", body: undefined },
        { heading: "", body: undefined },
      ],
    },
    { id: "i1", kind: "image", url: "", alt: "" },
    { id: "t1", kind: "text", markdown: "" },
    { id: "f1", kind: "footer" },
  ],
};

const html = renderCampaignEmail(emptyish, {
  recipient: { name: "Ada Lovelace", email: "ada@example.com" },
  unsubscribeUrl: "https://example.test/u/1",
});

const allPlaceholders = [
  ...Object.values(CANVAS_PLACEHOLDERS),
  pollOptionPlaceholder(0),
];

/** Every slot the canvas can ask about, the catalogue's own keys plus the one
 *  slot that numbers its prompt. */
const allSlots: CanvasSlot[] = [
  ...(Object.keys(CANVAS_PLACEHOLDERS) as (keyof typeof CANVAS_PLACEHOLDERS)[]),
  "pollOption",
];

describe("the placeholders are chrome, not content", () => {
  test("the send contains none of them", () => {
    for (const text of allPlaceholders) {
      expect(html).not.toContain(text);
    }
  });

  test("the empty card the approver is looking at really is empty", () => {
    // No heading, no body, no margin for either — `cardTextHtml` skips a slot
    // it has nothing for. The canvas has to skip it in the same places.
    expect(html).not.toContain("<h3");
    expect(html).not.toContain(CANVAS_PLACEHOLDERS.cardBody);
    expect(html).not.toContain(CANVAS_PLACEHOLDERS.image);
  });

  test("every slot has a prompt, including the numbered one", () => {
    for (const slot of allSlots) {
      expect(slotPrompt(slot).length).toBeGreaterThan(0);
    }
    expect(slotPrompt("pollOption", 2)).toBe("Option 3");
    expect(slotPrompt("cardEyebrow")).toBe(CANVAS_PLACEHOLDERS.cardEyebrow);
  });
});

describe("emptySlotDraw", () => {
  test("a locked canvas draws NOTHING in an empty slot", () => {
    for (const slot of allSlots) {
      expect(emptySlotDraw(false, false, slot)).toBe("nothing");
      // Even if something upstream leaves a selection behind: locked is locked.
      expect(emptySlotDraw(false, true, slot)).toBe("nothing");
    }
  });

  test("an author's unselected block gets a wordless mark", () => {
    for (const slot of allSlots) {
      expect(emptySlotDraw(true, false, slot)).toBe("outline");
    }
  });

  test("selecting the block is what asks for the prompt", () => {
    expect(emptySlotDraw(true, true, "cardHeading")).toBe("placeholder");
    expect(emptySlotDraw(true, true, "cardBody")).toBe("placeholder");
    expect(emptySlotDraw(true, true, "buttonLabel")).toBe("placeholder");
  });

  test("an OPTIONAL slot gets a hint instead — the eyebrow that shouted", () => {
    // The two the report named, and the rest of the slots an email is
    // complete without.
    expect(emptySlotDraw(true, true, "cardEyebrow")).toBe("hint");
    expect(emptySlotDraw(true, true, "cardAttribution")).toBe("hint");
    expect(emptySlotDraw(true, true, "quoteAttribution")).toBe("hint");
    expect(emptySlotDraw(true, true, "cardCtaLabel")).toBe("hint");
    expect(emptySlotDraw(true, true, "footerNavLine")).toBe("hint");
  });

  test("a slot the block is unfinished without is NOT optional", () => {
    for (const slot of [
      "heading",
      "bodyMarkdown",
      // A standalone eyebrow BLOCK is only its eyebrow: empty, it is an
      // unfinished block, not an optional flourish on a finished one.
      "eyebrow",
      "cardHeading",
      "cardBody",
      "quote",
      "pollQuestion",
      "pollOption",
      "buttonLabel",
      "image",
    ] as CanvasSlot[]) {
      expect(slotIsOptional(slot)).toBe(false);
    }
  });
});

describe("a hint is quieter than real copy", () => {
  // 12px bold uppercase tracked-out accent type is what an eyebrow's COPY is
  // set in. Its prompt may not be.
  const eyebrow = { fontSize: 12, lineHeight: 16 };

  test("smaller, lighter, and out of the slot's capitals", () => {
    const hint = promptStyle("hint", eyebrow);
    expect(hint.opacity).toBeLessThan(PROMPT_VOICE.placeholder.opacity);
    expect(hint.fontSize).toBeLessThan(eyebrow.fontSize);
    expect(hint.fontWeight).toBe("400");
    expect(hint.textTransform).toBe("none");
    expect(hint.letterSpacing).toBe(0);
  });

  test("but still legible — a 12px slot's hint does not become 9px type", () => {
    expect(promptStyle("hint", eyebrow).fontSize).toBeGreaterThanOrEqual(
      PROMPT_VOICE.hint.minSize,
    );
  });

  test("it keeps the slot's LINE BOX, so selecting a block moves nothing", () => {
    // The wordless outline is exactly one line of the slot's type tall
    // (`CanvasText.tsx#EmptySlot`). A hint that set its own smaller line box
    // would make every empty optional slot jump the moment you selected the
    // block — which is the same class of bug as the collapsing editor.
    expect(promptStyle("hint", eyebrow).lineHeight).toBe(eyebrow.lineHeight);
    expect(promptStyle("hint", { fontSize: 38, lineHeight: 43 }).lineHeight).toBe(43);
  });

  test("a required slot keeps its own type, dimmed", () => {
    const required = promptStyle("placeholder", eyebrow);
    expect(required.opacity).toBe(PROMPT_VOICE.placeholder.opacity);
    expect(required.fontSize).toBeUndefined();
    expect(required.fontWeight).toBeUndefined();
  });
});

/**
 * The rule only holds if every prompt goes through it. These read the canvas's
 * own source: a placeholder typed straight into a block is one the catalogue
 * doesn't know about and the test above can't check.
 */
describe("every prompt comes from the catalogue", () => {
  const read = (file: string) =>
    fs.readFileSync(path.join(__dirname, file), "utf8");

  test("BlockView carries no placeholder copy of its own", () => {
    const src = read("BlockView.tsx");
    // The two that leaked, verbatim, are the canaries.
    expect(src).not.toContain(`"${CANVAS_PLACEHOLDERS.cardBody}"`);
    expect(src).not.toContain(`"${CANVAS_PLACEHOLDERS.image}"`);
    expect(src).not.toContain(`"${CANVAS_PLACEHOLDERS.bodyMarkdown}"`);
  });

  test("BlockView names SLOTS, so optionality is never decided at a call site", () => {
    const src = read("BlockView.tsx");
    // Every editable run passes a slot; nothing passes a bare prompt string
    // or its own "this one is optional" flag.
    expect(src).toContain('slot="cardEyebrow"');
    expect(src).toContain('slot="cardBody"');
    expect(src).not.toContain("optional={");
    expect(src).not.toMatch(/placeholder=\{P\./);
  });

  test("CanvasEditableText draws an empty slot only through the gate", () => {
    const src = read("CanvasText.tsx");
    expect(src).toContain("emptySlotDraw");
    // …and dresses the prompt only through the voice table.
    expect(src).toContain("promptStyle");
  });

  test("the footer joins its links the way the renderer does", () => {
    // The canvas used to draw one muted string joined by "  |  " — two spaces
    // each side, no underline, no link colour.
    const src = read("BlockView.tsx");
    expect(src).not.toContain('join("  |  ")');
    expect(src).toContain("FOOTER_LINK_SEPARATOR");
  });
});
