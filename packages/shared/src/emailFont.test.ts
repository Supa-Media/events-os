import { describe, expect, test } from "vitest";
import {
  DEFAULT_PW_FONT_STACK_ID,
  PW_FONT_STACKS,
  PW_FONT_STACK_IDS,
  isPwFontStackId,
  pwFontFamilyCss,
} from "./emailFont";

describe("isPwFontStackId", () => {
  test.each(PW_FONT_STACK_IDS)("accepts %s", (id) => {
    expect(isPwFontStackId(id)).toBe(true);
  });

  test("rejects an arbitrary string", () => {
    expect(isPwFontStackId("Comic Sans MS")).toBe(false);
  });

  test("rejects non-strings", () => {
    expect(isPwFontStackId(123)).toBe(false);
    expect(isPwFontStackId(null)).toBe(false);
    expect(isPwFontStackId(undefined)).toBe(false);
  });
});

describe("pwFontFamilyCss", () => {
  test("returns the default stack's css for null/undefined/unknown", () => {
    const defaultCss = `${PW_FONT_STACKS[DEFAULT_PW_FONT_STACK_ID].fontFamily}, ${PW_FONT_STACKS[DEFAULT_PW_FONT_STACK_ID].fallbackFontFamily}`;
    expect(pwFontFamilyCss(null)).toBe(defaultCss);
    expect(pwFontFamilyCss(undefined)).toBe(defaultCss);
    expect(pwFontFamilyCss("not-a-real-stack")).toBe(defaultCss);
  });

  test("returns the requested stack's family + fallback", () => {
    expect(pwFontFamilyCss("serif")).toBe("Georgia, serif");
    expect(pwFontFamilyCss("mono")).toBe("Courier New, monospace");
  });
});

describe("PW_FONT_STACKS", () => {
  test("every id in PW_FONT_STACK_IDS has a stack entry with a label", () => {
    for (const id of PW_FONT_STACK_IDS) {
      expect(PW_FONT_STACKS[id].label.length).toBeGreaterThan(0);
      expect(PW_FONT_STACKS[id].fontFamily.length).toBeGreaterThan(0);
      expect(PW_FONT_STACKS[id].fallbackFontFamily.length).toBeGreaterThan(0);
    }
  });
});
