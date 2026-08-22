// No @types/jest / ambient globals configured for this package — import test
// globals explicitly from @jest/globals instead of adding a new dependency.
import { describe, expect, test } from "@jest/globals";
import {
  applyDisplayEdit,
  buildMentionDisplay,
  displayPosToRaw,
  posTouchesMention,
} from "./mentionDisplay.logic";

/**
 * The edit-mode display projection: the stored string keeps full
 * `@[Label](mention:type:id)` tokens, the input shows/edits `@Label`, and
 * every display edit maps back onto the raw string with mentions behaving
 * as atomic chips.
 */

const ABIGAIL = "@[Abigail Sekyere](mention:person:md70610gbehfmx3p3zypd599hs8c3j3j)";
const TREASURER = "@[Treasurer](mention:seat:seat123)";

describe("buildMentionDisplay", () => {
  test("projects a token to @Label and keeps surrounding text", () => {
    const { display, spans } = buildMentionDisplay(`Ask ${ABIGAIL} today`);
    expect(display).toBe("Ask @Abigail Sekyere today");
    expect(spans).toHaveLength(3);
    expect(spans[1]).toMatchObject({ mention: true, dStart: 4, dEnd: 20 });
  });

  test("plain text with no tokens projects to itself", () => {
    const { display, spans } = buildMentionDisplay("just a note");
    expect(display).toBe("just a note");
    expect(spans).toEqual([
      { dStart: 0, dEnd: 11, rStart: 0, rEnd: 11, mention: false },
    ]);
  });

  test("empty string projects to empty", () => {
    expect(buildMentionDisplay("")).toEqual({ display: "", spans: [] });
  });

  test("adjacent tokens each get their own span", () => {
    const { display, spans } = buildMentionDisplay(`${ABIGAIL} ${TREASURER}`);
    expect(display).toBe("@Abigail Sekyere @Treasurer");
    expect(spans.filter((s) => s.mention)).toHaveLength(2);
  });
});

describe("displayPosToRaw", () => {
  const raw = `Ask ${ABIGAIL} today`;
  const projection = buildMentionDisplay(raw);

  test("maps positions in plain text 1:1", () => {
    expect(displayPosToRaw(projection, 0)).toBe(0);
    expect(displayPosToRaw(projection, 4)).toBe(4); // token start boundary
  });

  test("maps the position after a token to the raw token end", () => {
    // display "Ask @Abigail Sekyere| today" → raw position after the ")".
    expect(displayPosToRaw(projection, 20)).toBe(4 + ABIGAIL.length);
  });

  test("end of display maps to end of raw", () => {
    expect(displayPosToRaw(projection, projection.display.length)).toBe(raw.length);
  });
});

describe("applyDisplayEdit", () => {
  test("typing after a mention edits only the raw text (the reported bug)", () => {
    const raw = `${ABIGAIL} `;
    const prev = buildMentionDisplay(raw).display; // "@Abigail Sekyere "
    const result = applyDisplayEdit(raw, prev, `${prev}o`);
    expect(result.raw).toBe(`${ABIGAIL} o`);
    expect(result.display).toBe("@Abigail Sekyere o");
    expect(result.cursorNeedsForce).toBe(false);
  });

  test("typing before a mention leaves the token intact", () => {
    const raw = ABIGAIL;
    const prev = buildMentionDisplay(raw).display;
    const result = applyDisplayEdit(raw, prev, `x${prev}`);
    expect(result.raw).toBe(`x${ABIGAIL}`);
    expect(result.cursor).toBe(1);
  });

  test("one backspace after a mention deletes the WHOLE token", () => {
    const raw = `Ask ${ABIGAIL}`;
    const prev = buildMentionDisplay(raw).display; // "Ask @Abigail Sekyere"
    const result = applyDisplayEdit(raw, prev, prev.slice(0, -1));
    expect(result.raw).toBe("Ask ");
    expect(result.display).toBe("Ask ");
    expect(result.cursor).toBe(4);
    expect(result.cursorNeedsForce).toBe(true);
  });

  test("typing inside a mention replaces the whole atomic token", () => {
    const raw = ABIGAIL;
    const prev = buildMentionDisplay(raw).display; // "@Abigail Sekyere"
    // Insert "x" mid-label: "@Abigxail Sekyere"
    const next = `${prev.slice(0, 5)}x${prev.slice(5)}`;
    const result = applyDisplayEdit(raw, prev, next);
    expect(result.raw).toBe("x");
    expect(result.cursor).toBe(1);
    expect(result.cursorNeedsForce).toBe(true);
  });

  test("a selection spanning text and a mention deletes both fully", () => {
    const raw = `Ask ${ABIGAIL} today`;
    const prev = buildMentionDisplay(raw).display;
    // Select "sk @Abigail Sek" (display [1, 16)) and delete it.
    const result = applyDisplayEdit(raw, prev, `A${prev.slice(16)}`);
    expect(result.raw).toBe("A today");
    expect(result.cursorNeedsForce).toBe(true);
  });

  test("editing plain text between two mentions touches neither token", () => {
    const raw = `${ABIGAIL} and ${TREASURER}`;
    const prev = buildMentionDisplay(raw).display;
    const next = prev.replace(" and ", " with ");
    const result = applyDisplayEdit(raw, prev, next);
    expect(result.raw).toBe(`${ABIGAIL} with ${TREASURER}`);
  });

  test("typing into an empty value works from a cold start", () => {
    const result = applyDisplayEdit("", "", "h");
    expect(result.raw).toBe("h");
    expect(result.cursor).toBe(1);
    expect(result.cursorNeedsForce).toBe(false);
  });
});

describe("posTouchesMention", () => {
  const projection = buildMentionDisplay(`Ask ${ABIGAIL}`);

  test("true at the token's @ and inside the label", () => {
    expect(posTouchesMention(projection.spans, 4)).toBe(true);
    expect(posTouchesMention(projection.spans, 10)).toBe(true);
  });

  test("false in plain text and just past the token", () => {
    expect(posTouchesMention(projection.spans, 0)).toBe(false);
    expect(posTouchesMention(projection.spans, 20)).toBe(false);
  });
});
