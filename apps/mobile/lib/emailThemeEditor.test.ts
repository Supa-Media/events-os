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
  COLOR_TOKEN_GROUPS,
  DARK_TOKEN_KEYS,
  FONT_STACKS,
  TRACKING_PRESETS,
  darkFromLight,
  fontOptionsFor,
  forceDarkEmailPreview,
  hexFromDraft,
  suggestedSwatches,
  themeSampleDocument,
  trackingOptionsFor,
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

describe("COLOR_TOKEN_GROUPS", () => {
  test("covers every hex token in the theme, exactly once", () => {
    // The form is the only way to edit these, so a token missing from the
    // groups is a token nobody can change — and one listed twice is two
    // fields fighting over the same value. `EmailThemeTokens` minus the two
    // font stacks, the two letter-spacings, the radius and the wordmark.
    const themeKeys = Object.keys(DEFAULT_EMAIL_THEME).filter(
      (k) =>
        !["name", "dark", "headingFont", "bodyFont", "radius", "wordmark",
          "headingTracking", "bodyTracking"].includes(k),
    );
    const grouped = COLOR_TOKENS.map((t) => t.key);
    expect(grouped.length).toBe(new Set(grouped).size);
    expect([...grouped].sort()).toEqual([...themeKeys].sort());
  });

  test("every grouped token is a real hex value on every preset", () => {
    for (const preset of EMAIL_THEME_PRESETS) {
      for (const token of COLOR_TOKENS) {
        expect([preset.name, token.key, preset[token.key]]).toEqual([
          preset.name,
          token.key,
          expect.stringMatching(/^#[0-9a-fA-F]{3,6}$/),
        ]);
      }
    }
  });

  test("the dark sub-editor covers the same tokens as the light form", () => {
    // A dark editor missing a token is how a theme ends up with a cream card
    // that stays cream on a black screen.
    expect([...DARK_TOKEN_KEYS].sort()).toEqual([...COLOR_TOKENS.map((t) => t.key)].sort());
  });

  test("every group is labelled and non-empty", () => {
    for (const group of COLOR_TOKEN_GROUPS) {
      expect(group.title.length).toBeGreaterThan(0);
      expect(group.tokens.length).toBeGreaterThan(0);
    }
  });
});

describe("TRACKING_PRESETS", () => {
  test("every preset survives the theme write gate", () => {
    // These are interpolated into a style attribute, and `validateEmailTheme`
    // holds them to `safeTracking`'s shape. A value the picker offers must
    // never be one the save then refuses.
    for (const option of TRACKING_PRESETS) {
      const result = validateEmailTheme({
        ...DEFAULT_EMAIL_THEME,
        headingTracking: option.value,
        bodyTracking: option.value,
      });
      expect([option.value, result.ok]).toEqual([option.value, true]);
    }
  });

  test("covers the values the built-in themes actually use", () => {
    // Otherwise opening a preset would show it as "Custom — …", which reads
    // as the theme having drifted off the supported set when it hasn't.
    const offered = TRACKING_PRESETS.map((t) => t.value);
    for (const preset of EMAIL_THEME_PRESETS) {
      expect([preset.name, offered.includes(preset.headingTracking)]).toEqual([
        preset.name,
        true,
      ]);
      expect([preset.name, offered.includes(preset.bodyTracking)]).toEqual([
        preset.name,
        true,
      ]);
    }
  });
});

describe("trackingOptionsFor", () => {
  test("returns the curated list unchanged for a known value", () => {
    expect(trackingOptionsFor(TRACKING_PRESETS[0].value)).toHaveLength(
      TRACKING_PRESETS.length,
    );
  });

  test("appends the theme's own value when it isn't one of ours", () => {
    // Non-destructive, exactly like `fontOptionsFor`: a theme stored with
    // `0.05em` must not open on an empty picker that blanks its tracking the
    // next time any unrelated control is touched.
    const options = trackingOptionsFor("0.05em");
    expect(options).toHaveLength(TRACKING_PRESETS.length + 1);
    expect(options[options.length - 1].value).toBe("0.05em");
  });

  test("ignores an empty value rather than adding a blank option", () => {
    expect(trackingOptionsFor("")).toHaveLength(TRACKING_PRESETS.length);
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
    for (const kind of [
      "eyebrow",
      "heading",
      "text",
      "button",
      "card",
      "quote",
      // The blocks that carry `cream`, `contrast`/`contrastInk` and
      // `hairline`. Without them a third of the colour form drives nothing
      // the designer can see, which reads as broken controls.
      "hairline",
      "footer",
    ]) {
      expect(kinds).toContain(kind);
    }
  });

  test("paints every colour token somewhere in the preview", () => {
    // The point of the sample: each swatch in the form has to change
    // something visible. A token that appears nowhere in the rendered HTML is
    // a control with no effect.
    const html = render(DEFAULT_EMAIL_THEME);
    for (const token of COLOR_TOKENS) {
      const value = DEFAULT_EMAIL_THEME[token.key];
      expect([token.key, html.includes(value)]).toEqual([token.key, true]);
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
    // Asserted against the PAYLOAD and against the pin's own signature, not
    // against `display:none` on its own — the renderer emits that legitimately
    // in its stacked-column rules, so the old proxy assertion started failing
    // for a reason that had nothing to do with this function.
    expect(forced).not.toContain("red; }");
    expect(forced).not.toContain("html,body{background:");
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
