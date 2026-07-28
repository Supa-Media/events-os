// No @types/jest / ambient globals configured for this package — import test
// globals explicitly from @jest/globals (mirrors `lib/emailDesigner.test.ts`).
import { describe, expect, test } from "@jest/globals";
import {
  DEFAULT_EMAIL_THEME,
  EMAIL_THEME_PRESETS,
  renderCampaignEmail,
  resolveDarkTheme,
  validateEmailDocument,
  validateEmailTheme,
  type EmailTheme,
} from "@events-os/shared";
import {
  COLOR_TOKENS,
  DARK_TOKEN_KEYS,
  FONT_STACKS,
  darkFromLight,
  fontOptionsFor,
  forceDarkEmailPreview,
  hexFromDraft,
  suggestedSwatches,
  themeSampleDocument,
} from "./emailThemeEditor";

const RECIPIENT = { name: "Ada Lovelace", email: "ada@example.com" };

function render(theme: EmailTheme): string {
  return renderCampaignEmail(themeSampleDocument(theme), {
    recipient: RECIPIENT,
    unsubscribeUrl: "#",
  });
}

describe("FONT_STACKS", () => {
  test("every curated stack survives the theme write gate", () => {
    // These are interpolated straight into CSS, and `validateEmailTheme`
    // rejects the characters that could break out of the declaration. A stack
    // this picker offers must never be one the save then refuses.
    for (const stack of FONT_STACKS) {
      const result = validateEmailTheme({
        ...DEFAULT_EMAIL_THEME,
        headingFont: stack.value,
        bodyFont: stack.value,
      });
      expect([stack.label, result.ok]).toEqual([stack.label, true]);
    }
  });
});

describe("fontOptionsFor", () => {
  test("returns the curated list unchanged for a known stack", () => {
    const options = fontOptionsFor(FONT_STACKS[0].value);
    expect(options).toHaveLength(FONT_STACKS.length);
  });

  test("appends the theme's own stack when it isn't one of ours", () => {
    const options = fontOptionsFor("Papyrus,fantasy");
    expect(options).toHaveLength(FONT_STACKS.length + 1);
    expect(options[options.length - 1].value).toBe("Papyrus,fantasy");
    // Non-destructive: opening a theme on an unknown font must not present an
    // empty picker that silently blanks it on the next unrelated edit.
    expect(options.some((o) => o.value === "Papyrus,fantasy")).toBe(true);
  });

  test("ignores an empty stack rather than adding a blank option", () => {
    expect(fontOptionsFor("")).toHaveLength(FONT_STACKS.length);
  });
});

describe("suggestedSwatches", () => {
  test("offers only real hex values drawn from the presets", () => {
    for (const token of COLOR_TOKENS) {
      const swatches = suggestedSwatches(token.key);
      expect(swatches.length).toBeGreaterThan(0);
      expect(new Set(swatches).size).toBe(swatches.length);
      for (const hex of swatches) expect(hex).toMatch(/^#[0-9a-fA-F]{3,6}$/);
    }
  });

  test("includes both the light and the dark value of a preset token", () => {
    const accents = suggestedSwatches("accent");
    expect(accents).toContain(EMAIL_THEME_PRESETS[0].accent);
    expect(accents).toContain(resolveDarkTheme(EMAIL_THEME_PRESETS[0]).accent);
  });
});

describe("darkFromLight", () => {
  test("seeds every editable dark token from the light side", () => {
    const seeded = darkFromLight(DEFAULT_EMAIL_THEME);
    for (const key of DARK_TOKEN_KEYS) {
      expect(seeded[key]).toBe(DEFAULT_EMAIL_THEME[key]);
    }
  });

  test("produces a theme that still passes the write gate", () => {
    const result = validateEmailTheme({
      ...DEFAULT_EMAIL_THEME,
      dark: darkFromLight(DEFAULT_EMAIL_THEME),
    });
    expect(result.ok).toBe(true);
  });

  test("touches no font or radius token — a theme must not change face in dark", () => {
    const seeded = darkFromLight(DEFAULT_EMAIL_THEME) as Record<string, unknown>;
    expect(seeded.headingFont).toBeUndefined();
    expect(seeded.bodyFont).toBeUndefined();
    expect(seeded.radius).toBeUndefined();
  });
});

describe("themeSampleDocument", () => {
  test("is a valid document carrying the theme under edit", () => {
    const theme: EmailTheme = { ...DEFAULT_EMAIL_THEME, name: "Advent" };
    const doc = themeSampleDocument(theme);
    const result = validateEmailDocument(doc);
    expect(result.ok ? null : result.error).toBeNull();
    expect(doc.theme?.name).toBe("Advent");
  });

  test("exercises every block kind the theme visibly changes", () => {
    const kinds = themeSampleDocument(DEFAULT_EMAIL_THEME).blocks.map((b) => b.kind);
    for (const kind of ["eyebrow", "heading", "text", "button", "card", "quote"]) {
      expect(kinds).toContain(kind);
    }
  });

  test("gives every block a distinct id", () => {
    const ids = themeSampleDocument(DEFAULT_EMAIL_THEME).blocks.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("forceDarkEmailPreview", () => {
  const theme = DEFAULT_EMAIL_THEME;
  const dark = resolveDarkTheme(theme);

  test("un-gates the renderer's dark rules so they always apply", () => {
    const html = render(theme);
    expect(html).toContain("@media (prefers-color-scheme: dark) {");

    const forced = forceDarkEmailPreview(html, dark.canvas);
    expect(forced).not.toContain("@media (prefers-color-scheme: dark) {");
    expect(forced).toContain("@media all {");
    // The dark values themselves are untouched — this rewrites the CONDITION,
    // not the declarations, so what's previewed is the real dark CSS a
    // recipient's client would apply rather than a re-render with dark tokens.
    expect(forced).toContain(dark.surface);
  });

  test("pins the frame background so the light body doesn't show through", () => {
    const forced = forceDarkEmailPreview(render(theme), dark.canvas);
    expect(forced).toContain(`html,body{background:${dark.canvas} !important;}`);
    expect(forced.indexOf("</head>")).toBeGreaterThan(
      forced.indexOf(`html,body{background:${dark.canvas}`),
    );
  });

  test("refuses to splice a non-hex value into the stylesheet", () => {
    // Defense in depth: the caller passes a validated token, but this string
    // lands in CSS and a sink must not trust its input.
    const forced = forceDarkEmailPreview(render(theme), "red; } body { display:none");
    expect(forced).not.toContain("display:none");
    // The media-query rewrite still happened — only the background pin is
    // dropped.
    expect(forced).toContain("@media all {");
  });

  test("returns the HTML untouched when the marker is gone", () => {
    // A future renderer refactor must degrade to "the light preview", never to
    // a corrupted document.
    const plain = "<html><head></head><body>hi</body></html>";
    expect(forceDarkEmailPreview(plain, dark.canvas)).toBe(plain);
  });

  test("every preset's dark rendering differs from its light one", () => {
    for (const preset of EMAIL_THEME_PRESETS) {
      const light = render(preset);
      const forcedDark = forceDarkEmailPreview(light, resolveDarkTheme(preset).canvas);
      expect([preset.name, forcedDark === light]).toEqual([preset.name, false]);
    }
  });
});

describe("hexFromDraft", () => {
  test("commits a complete colour, with or without the leading #", () => {
    expect(hexFromDraft("#891d1a")).toBe("#891d1a");
    expect(hexFromDraft("891d1a")).toBe("#891d1a");
    expect(hexFromDraft("  #891D1A  ")).toBe("#891D1A");
    expect(hexFromDraft("#fff")).toBe("#fff");
  });

  test("holds a half-typed draft back", () => {
    for (const draft of ["", "#", "#8", "#89", "#891d", "#891d1", "8", "89"]) {
      expect([draft, hexFromDraft(draft)]).toEqual([draft, null]);
    }
  });

  test("never commits a PREFIX of the colour being typed", () => {
    // The regression: `891d1a` typed one character at a time passed through
    // `891`, and `isHexColor("#891")` is true — so the field committed #891,
    // a different colour, and rewrote itself to it under the caret. If the
    // designer looked away there, #891 is what the theme saved.
    const target = "891d1a";
    const committed: string[] = [];
    for (let i = 1; i <= target.length; i++) {
      const hex = hexFromDraft(target.slice(0, i));
      if (hex !== null) committed.push(hex);
    }
    expect(committed).toEqual(["#891d1a"]);
  });

  test("an explicitly typed 3-digit hex is still a complete colour", () => {
    // Shorthand exists to be used; only the hash-LESS 3-character form is
    // ambiguous with a half-typed 6.
    expect(hexFromDraft("#abc")).toBe("#abc");
    expect(hexFromDraft("abc")).toBeNull();
  });

  test("rejects anything that isn't hex at all", () => {
    for (const draft of ["rgb(1,2,3)", "#89 1d1a", "#891d1a1", "zzzzzz", "#gggggg"]) {
      expect([draft, hexFromDraft(draft)]).toEqual([draft, null]);
    }
  });

  test("every value the swatch rows offer round-trips unchanged", () => {
    // A suggestion the field would then call incomplete would be absurd.
    for (const token of COLOR_TOKENS) {
      for (const hex of suggestedSwatches(token.key)) {
        expect([hex, hexFromDraft(hex)]).toEqual([hex, hex]);
      }
    }
  });
});
