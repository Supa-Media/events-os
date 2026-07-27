import { describe, expect, test } from "vitest";
import {
  AA_CONTRAST_BODY,
  contrastRatio,
  DEFAULT_EMAIL_THEME,
  emailThemeContrastWarnings,
  emailThemePreset,
  EMAIL_THEME_PRESETS,
  FALL_THEME,
  isHexColor,
  normalizeEmailTheme,
  PUBLIC_WORSHIP_THEME,
  relativeLuminance,
  resolveDarkTheme,
  safeFontStack,
  SUMMER_THEME,
  validateEmailTheme,
  WINTER_THEME,
  type EmailTheme,
} from "./emailTheme";

/** Every colour token, in the order `validateEmailTheme` checks them — the
 *  test-side twin of the module's private `TOKEN_KEYS`. */
const COLOR_TOKENS = [
  "accent",
  "accentInk",
  "ink",
  "muted",
  "canvas",
  "surface",
  "border",
  "link",
] as const;

/** Every key a rendered theme must carry a defined value for. The renderer
 *  interpolates each of these straight into a `style=` attribute, so an
 *  `undefined` here is a literal "undefined" in a real send. */
const ALL_TOKEN_KEYS = [
  ...COLOR_TOKENS,
  "headingFont",
  "bodyFont",
  "radius",
  "wordmark",
] as const;

/** A minimal, valid theme to mutate one field of at a time. */
function theme(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...PUBLIC_WORSHIP_THEME, ...overrides };
}

describe("presets", () => {
  test("EMAIL_THEME_PRESETS lists all four, Public Worship first", () => {
    expect(EMAIL_THEME_PRESETS.map((t) => t.name)).toEqual([
      "Public Worship",
      "Summer",
      "Fall",
      "Winter",
    ]);
  });

  test("DEFAULT_EMAIL_THEME is Public Worship's real brand, not the old invented palette", () => {
    expect(DEFAULT_EMAIL_THEME).toBe(PUBLIC_WORSHIP_THEME);
    expect(DEFAULT_EMAIL_THEME.accent).toBe("#891d1a");
    expect(DEFAULT_EMAIL_THEME.canvas).toBe("#fff9ee");
    // The palette this feature replaced. If it ever comes back, it comes back
    // as a deliberate edit that has to delete this assertion.
    expect(DEFAULT_EMAIL_THEME.accent.toLowerCase()).not.toBe("#d23b3a");
  });

  test("emailThemePreset looks a preset up by exact name", () => {
    expect(emailThemePreset("Public Worship")).toBe(PUBLIC_WORSHIP_THEME);
    expect(emailThemePreset("Winter")).toBe(WINTER_THEME);
  });

  test("emailThemePreset is case-sensitive and returns null for an unknown name", () => {
    expect(emailThemePreset("public worship")).toBeNull();
    expect(emailThemePreset("Advent")).toBeNull();
  });

  for (const preset of EMAIL_THEME_PRESETS) {
    test(`the "${preset.name}" preset passes the write gate`, () => {
      const result = validateEmailTheme(preset);
      expect(result.ok).toBe(true);
      if (!result.ok) expect(result.error).toBe("");
    });

    // This is the assertion that would have caught the original invented
    // palette: a preset shipped as a built-in must be legible in BOTH schemes
    // before anyone can pick it. A failure here is a palette bug, not a test
    // that needs loosening.
    test(`the "${preset.name}" preset is WCAG AA clean in both light and dark`, () => {
      expect(emailThemeContrastWarnings(preset)).toEqual([]);
    });
  }
});

describe("isHexColor", () => {
  test("accepts 3- and 6-digit hex in either case, with surrounding space", () => {
    expect(isHexColor("#891d1a")).toBe(true);
    expect(isHexColor("#891D1A")).toBe(true);
    expect(isHexColor("#abc")).toBe(true);
    expect(isHexColor("  #fff  ")).toBe(true);
  });

  test("rejects anything an email client renders unreliably", () => {
    expect(isHexColor("891d1a")).toBe(false);
    expect(isHexColor("#89d1a")).toBe(false);
    expect(isHexColor("#891d1a1")).toBe(false);
    expect(isHexColor("rgb(137,29,26)")).toBe(false);
    expect(isHexColor("maroon")).toBe(false);
    expect(isHexColor("")).toBe(false);
  });
});

describe("contrastRatio / relativeLuminance", () => {
  test("black on white is the 21:1 maximum", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
  });

  test("a colour against itself is exactly 1", () => {
    expect(contrastRatio("#891d1a", "#891d1a")).toBe(1);
    expect(contrastRatio("#ffffff", "#ffffff")).toBe(1);
  });

  test("the ratio is symmetric — argument order doesn't change legibility", () => {
    expect(contrastRatio("#891d1a", "#fff9ee")).toBe(contrastRatio("#fff9ee", "#891d1a"));
    expect(contrastRatio("#000", "#fff")).toBe(contrastRatio("#fff", "#000"));
  });

  test("3-digit hex expands to the same ratio as its 6-digit form", () => {
    expect(contrastRatio("#000", "#fff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#abc", "#fff")).toBeCloseTo(
      contrastRatio("#aabbcc", "#ffffff"),
      10,
    );
  });

  test("relativeLuminance spans 0 (black) to 1 (white)", () => {
    expect(relativeLuminance("#000000")).toBe(0);
    expect(relativeLuminance("#ffffff")).toBeCloseTo(1, 10);
  });

  test("relativeLuminance returns 0 for a malformed colour rather than NaN", () => {
    expect(relativeLuminance("not-a-colour")).toBe(0);
    expect(relativeLuminance("")).toBe(0);
  });
});

describe("normalizeEmailTheme — totality (the permissive READ edge)", () => {
  /** Assert `t` is complete enough to render: every token defined, and every
   *  colour actually a hex the renderer can paint with. */
  function expectComplete(t: EmailTheme) {
    for (const key of ALL_TOKEN_KEYS) {
      expect(t[key], `token "${key}"`).toBeDefined();
    }
    for (const key of COLOR_TOKENS) {
      expect(isHexColor(t[key]), `token "${key}" = ${t[key]}`).toBe(true);
    }
    expect(typeof t.radius).toBe("number");
    expect(typeof t.name).toBe("string");
    expect(t.name.length).toBeGreaterThan(0);
  }

  const junk: [string, unknown][] = [
    ["undefined", undefined],
    ["null", null],
    ["an empty object", {}],
    ["an array", ["#891d1a"]],
    ["a string", "Public Worship"],
    ["a number", 42],
    ["a boolean", true],
  ];

  for (const [label, input] of junk) {
    test(`${label} normalizes to a complete theme without throwing`, () => {
      const t = normalizeEmailTheme(input);
      expectComplete(t);
    });
  }

  test("a theme with a malformed hex falls back to the default for that token only", () => {
    const t = normalizeEmailTheme(theme({ accent: "not-a-colour", ink: "#111111" }));
    expectComplete(t);
    expect(t.accent).toBe(DEFAULT_EMAIL_THEME.accent);
    expect(t.ink).toBe("#111111");
  });

  test("a theme with a missing font falls back to the default stack", () => {
    const t = normalizeEmailTheme(theme({ headingFont: undefined, bodyFont: null }));
    expectComplete(t);
    expect(t.headingFont).toBe(DEFAULT_EMAIL_THEME.headingFont);
    expect(t.bodyFont).toBe(DEFAULT_EMAIL_THEME.bodyFont);
  });

  test("a theme whose font stack sanitizes away entirely falls back rather than emitting an empty stack", () => {
    const t = normalizeEmailTheme(theme({ bodyFont: "{};<>()" }));
    expect(t.bodyFont).toBe(DEFAULT_EMAIL_THEME.bodyFont);
    expect(t.bodyFont.length).toBeGreaterThan(0);
  });

  test("a partially-filled theme is completed from the base, never left with holes", () => {
    const t = normalizeEmailTheme({ accent: "#123456" });
    expectComplete(t);
    expect(t.accent).toBe("#123456");
    expect(t.surface).toBe(DEFAULT_EMAIL_THEME.surface);
  });
});

describe("normalizeEmailTheme — preserving custom values", () => {
  const custom: EmailTheme = {
    name: "Advent",
    accent: "#123456",
    accentInk: "#fefefe",
    ink: "#010203",
    muted: "#445566",
    canvas: "#f0f1f2",
    surface: "#fdfdfd",
    border: "#dddddd",
    link: "#0055aa",
    headingFont: "Fraunces,Georgia,serif",
    bodyFont: "Inter,Arial,sans-serif",
    radius: 4,
    wordmark: "ADVENT",
  };

  test("every valid custom token survives normalization untouched", () => {
    expect(normalizeEmailTheme(custom)).toMatchObject(custom);
  });

  test("a custom theme is not silently rewritten to the default brand", () => {
    const t = normalizeEmailTheme(custom);
    expect(t.accent).not.toBe(DEFAULT_EMAIL_THEME.accent);
    expect(t.canvas).not.toBe(DEFAULT_EMAIL_THEME.canvas);
    expect(t.name).toBe("Advent");
  });

  test("a 3-digit hex is preserved as authored, not expanded or normalized away", () => {
    expect(normalizeEmailTheme(theme({ accent: "#abc" })).accent).toBe("#abc");
  });

  test("radius is clamped into the renderable 0-40 range and rounded", () => {
    expect(normalizeEmailTheme(theme({ radius: -5 })).radius).toBe(0);
    expect(normalizeEmailTheme(theme({ radius: 999 })).radius).toBe(40);
    expect(normalizeEmailTheme(theme({ radius: 12.4 })).radius).toBe(12);
    expect(normalizeEmailTheme(theme({ radius: Number.NaN })).radius).toBe(
      DEFAULT_EMAIL_THEME.radius,
    );
  });

  test("an explicitly empty wordmark is preserved (it means 'no wordmark')", () => {
    expect(normalizeEmailTheme(theme({ wordmark: "" })).wordmark).toBe("");
  });

  test("a valid dark override is preserved token for token", () => {
    const t = normalizeEmailTheme(theme({ dark: { accent: "#ff0000", ink: "#ffffff" } }));
    expect(t.dark).toMatchObject({ accent: "#ff0000", ink: "#ffffff" });
  });

  test("an explicit base overrides the default brand as the fill source", () => {
    const t = normalizeEmailTheme({ accent: "#123456" }, WINTER_THEME);
    expect(t.accent).toBe("#123456");
    expect(t.surface).toBe(WINTER_THEME.surface);
    expect(t.headingFont).toBe(WINTER_THEME.headingFont);
  });
});

describe("resolveDarkTheme", () => {
  test("dark overrides are layered on top of the light tokens", () => {
    const d = resolveDarkTheme(PUBLIC_WORSHIP_THEME);
    expect(d.accent).toBe(PUBLIC_WORSHIP_THEME.dark?.accent);
    expect(d.surface).toBe(PUBLIC_WORSHIP_THEME.dark?.surface);
  });

  test("tokens the dark partial doesn't mention keep their light values", () => {
    const d = resolveDarkTheme(PUBLIC_WORSHIP_THEME);
    // `dark` moves no fonts or radius, so those come straight from the light side.
    expect(d.headingFont).toBe(PUBLIC_WORSHIP_THEME.headingFont);
    expect(d.bodyFont).toBe(PUBLIC_WORSHIP_THEME.bodyFont);
    expect(d.radius).toBe(PUBLIC_WORSHIP_THEME.radius);
    expect(d.wordmark).toBe(PUBLIC_WORSHIP_THEME.wordmark);
  });

  test("a theme with NO dark section renders identically in both schemes (deliberate — no auto-inversion)", () => {
    const { dark: _dark, name: _name, ...lightTokens } = PUBLIC_WORSHIP_THEME;
    const noDark: EmailTheme = { name: "No dark", ...lightTokens };
    expect(resolveDarkTheme(noDark)).toEqual(lightTokens);
  });

  test("the resolved dark tokens carry no name field (they're tokens, not a theme)", () => {
    expect(resolveDarkTheme(PUBLIC_WORSHIP_THEME)).not.toHaveProperty("name");
  });

  test("resolving does not mutate the theme it was given", () => {
    const before = JSON.stringify(FALL_THEME);
    resolveDarkTheme(FALL_THEME);
    expect(JSON.stringify(FALL_THEME)).toBe(before);
  });
});

describe("safeFontStack", () => {
  test("a normal CSS stack passes through unchanged", () => {
    expect(safeFontStack("Inter,Helvetica,Arial,sans-serif")).toBe(
      "Inter,Helvetica,Arial,sans-serif",
    );
  });

  test("quoted family names survive — they're legitimate CSS", () => {
    expect(safeFontStack("Inter,'Segoe UI',sans-serif")).toBe("Inter,'Segoe UI',sans-serif");
  });

  test("(SECURITY) every character that could break out of font-family is stripped", () => {
    const cleaned = safeFontStack("Inter;}</style><script>alert(1)</script>");
    expect(cleaned).not.toBeNull();
    for (const bad of [";", "{", "}", "<", ">", "(", ")", "\\"]) {
      expect(cleaned).not.toContain(bad);
    }
  });

  test("returns null when nothing usable survives, so the caller can fall back", () => {
    expect(safeFontStack(";{}<>()\\")).toBeNull();
    expect(safeFontStack("   ")).toBeNull();
    expect(safeFontStack("")).toBeNull();
  });
});

describe("emailThemeContrastWarnings", () => {
  test("a low-contrast body colour is reported against the card it sits on", () => {
    const warnings = emailThemeContrastWarnings({
      ...PUBLIC_WORSHIP_THEME,
      muted: "#eeeeee",
      surface: "#ffffff",
    });
    const light = warnings.find((w) => w.id === "muted-on-surface-light");
    expect(light).toBeDefined();
    expect(light?.required).toBe(AA_CONTRAST_BODY);
    expect(light?.scheme).toBe("light");
    expect(light?.ratio).toBeLessThan(AA_CONTRAST_BODY);
  });

  test("a theme legible in light but not in dark is caught in the dark scheme", () => {
    const warnings = emailThemeContrastWarnings({
      ...PUBLIC_WORSHIP_THEME,
      dark: { ...PUBLIC_WORSHIP_THEME.dark, muted: "#2a2a2a", surface: "#241110" },
    });
    expect(warnings.some((w) => w.scheme === "dark")).toBe(true);
    expect(warnings.every((w) => w.scheme === "dark")).toBe(true);
  });

  test("every warning carries a designer-readable label and a machine id", () => {
    const warnings = emailThemeContrastWarnings({
      ...PUBLIC_WORSHIP_THEME,
      muted: "#f5f5f5",
    });
    expect(warnings.length).toBeGreaterThan(0);
    for (const w of warnings) {
      expect(w.label.length).toBeGreaterThan(0);
      expect(w.id).toMatch(/-(light|dark)$/);
      expect(Number.isFinite(w.ratio)).toBe(true);
    }
  });
});

describe("validateEmailTheme — the strict WRITE gate", () => {
  test("accepts a complete, well-formed theme and returns it normalized", () => {
    const result = validateEmailTheme(theme());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.theme.accent).toBe("#891d1a");
  });

  test("rejects a non-object", () => {
    for (const bad of [null, undefined, "theme", 7, ["#891d1a"]]) {
      const result = validateEmailTheme(bad);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/must be an object/);
    }
  });

  test("rejects a missing or blank name", () => {
    for (const bad of [undefined, "", "   ", 12]) {
      const result = validateEmailTheme(theme({ name: bad }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/"name"/);
    }
  });

  test("rejects an over-long name", () => {
    const result = validateEmailTheme(theme({ name: "A".repeat(61) }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/"name" must be 60 characters or fewer/);
  });

  for (const token of COLOR_TOKENS) {
    test(`rejects a non-hex "${token}" and names the offending field`, () => {
      for (const bad of ["red", "rgb(1,2,3)", "#12", "", 16, null]) {
        const result = validateEmailTheme(theme({ [token]: bad }));
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toMatch(new RegExp(`"${token}"`));
      }
    });
  }

  test("(SECURITY) rejects a font stack containing a CSS-escaping character", () => {
    for (const key of ["headingFont", "bodyFont"] as const) {
      const result = validateEmailTheme(theme({ [key]: "Inter}</style><script>x" }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(new RegExp(`"${key}"`));
        expect(result.error).toMatch(/not allowed in a font stack/);
      }
    }
  });

  test("rejects a blank or non-string font stack", () => {
    for (const bad of ["", "   ", undefined, 12]) {
      const result = validateEmailTheme(theme({ bodyFont: bad }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/"bodyFont"/);
    }
  });

  test("rejects an over-long font stack (a field is not a stylesheet)", () => {
    const result = validateEmailTheme(theme({ headingFont: `${"Inter,".repeat(50)}serif` }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/"headingFont" must be 240 characters or fewer/);
    }
  });

  test("rejects a radius outside 0-40 or of the wrong type", () => {
    for (const bad of [-1, 41, "16", undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = validateEmailTheme(theme({ radius: bad }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/"radius" must be a number between 0 and 40/);
      }
    }
  });

  test("accepts the radius boundaries themselves", () => {
    expect(validateEmailTheme(theme({ radius: 0 })).ok).toBe(true);
    expect(validateEmailTheme(theme({ radius: 40 })).ok).toBe(true);
  });

  test("rejects a non-string wordmark but accepts an empty one", () => {
    const bad = validateEmailTheme(theme({ wordmark: null }));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toMatch(/"wordmark"/);
    expect(validateEmailTheme(theme({ wordmark: "" })).ok).toBe(true);
  });

  test("rejects an over-long wordmark", () => {
    const result = validateEmailTheme(theme({ wordmark: "W".repeat(49) }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/"wordmark" must be 48 characters or fewer/);
  });

  test("rejects a non-object dark section", () => {
    const result = validateEmailTheme(theme({ dark: "invert" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/"dark" must be an object/);
  });

  test("rejects a dark partial with a bad hex and names the dark field", () => {
    const result = validateEmailTheme(theme({ dark: { accent: "salmon" } }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/"dark\.accent"/);
  });

  test("rejects a dark partial with a malicious font stack", () => {
    const result = validateEmailTheme(theme({ dark: { bodyFont: "Inter}<script>" } }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/"dark\.bodyFont"/);
  });

  test("accepts a dark partial that overrides only some tokens", () => {
    expect(validateEmailTheme(theme({ dark: { accent: "#ff0000" } })).ok).toBe(true);
  });

  test("accepts a theme with contrast warnings — legibility is advisory, not a gate", () => {
    const lowContrast = theme({ muted: "#f2f2f2", surface: "#ffffff" });
    // Precondition: this theme really is warned about, so the assertion below
    // is proving acceptance-despite-warnings rather than passing vacuously.
    expect(emailThemeContrastWarnings(lowContrast as unknown as EmailTheme).length)
      .toBeGreaterThan(0);
    expect(validateEmailTheme(lowContrast).ok).toBe(true);
  });

  test("accepts every seasonal preset unchanged (round-trips through the gate)", () => {
    for (const preset of [SUMMER_THEME, FALL_THEME, WINTER_THEME]) {
      const result = validateEmailTheme(preset);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.theme).toMatchObject({ name: preset.name });
    }
  });
});
