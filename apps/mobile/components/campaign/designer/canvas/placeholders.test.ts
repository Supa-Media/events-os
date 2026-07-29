/**
 * THE EDITOR'S WORDS MUST NOT REACH THE APPROVER'S SCREEN.
 *
 * Two halves, and the leak needed both to be true at once:
 *
 *  1. every string in `CANVAS_PLACEHOLDERS` is chrome — `renderCampaignEmail`
 *     emits none of them for the document that provokes them;
 *  2. `emptySlotDraw` refuses to draw any of them on a canvas that isn't
 *     editable, which is exactly the state a locked campaign renders in.
 *
 * Together: a locked campaign's canvas and its send say the same thing.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "@jest/globals";
import { renderCampaignEmail, type EmailDocument } from "@events-os/shared";
import {
  CANVAS_PLACEHOLDERS,
  emptySlotDraw,
  pollOptionPlaceholder,
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
});

describe("emptySlotDraw", () => {
  test("a locked canvas draws NOTHING in an empty slot", () => {
    expect(emptySlotDraw(false, false)).toBe("nothing");
    // Even if something upstream leaves a selection behind: locked is locked.
    expect(emptySlotDraw(false, true)).toBe("nothing");
  });

  test("an author's unselected block gets a wordless mark", () => {
    expect(emptySlotDraw(true, false)).toBe("outline");
  });

  test("selecting the block is what asks for the prompt", () => {
    expect(emptySlotDraw(true, true)).toBe("placeholder");
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

  test("CanvasEditableText draws an empty slot only through the gate", () => {
    const src = read("CanvasText.tsx");
    expect(src).toContain("emptySlotDraw");
  });

  test("the footer joins its links the way the renderer does", () => {
    // The canvas used to draw one muted string joined by "  |  " — two spaces
    // each side, no underline, no link colour.
    const src = read("BlockView.tsx");
    expect(src).not.toContain('join("  |  ")');
    expect(src).toContain("FOOTER_LINK_SEPARATOR");
  });
});
