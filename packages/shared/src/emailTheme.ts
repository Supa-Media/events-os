/**
 * The theme model for campaign email — the design tokens `emailRender.ts`
 * paints every block with. Pure TypeScript, zero react/convex deps, so it
 * runs unchanged in Convex's V8 runtime, plain Node (vitest), and the Expo
 * app (live preview), exactly like `emailBlocks.ts`.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * The renderer used to hardcode a palette (`#D23B3A` red, `#FDF6F6` cream,
 * Georgia) that was never Public Worship's actual brand — it was invented
 * before anyone had the real newsletter to compare against. Public Worship's
 * newsletter is maroon `#891d1a` on warm cream `#fff9ee`, Inter, not Georgia.
 * Rather than swap one hardcoded palette for another, the tokens are now
 * DATA: presets live here, orgs store their own in `emailThemes` (see
 * `schema/campaigns.ts`), and the designer edits them in-app whenever the
 * brand moves — monthly, seasonally, or never.
 *
 * ── Design rules (each is load-bearing) ────────────────────────────────────
 *  - THEME-LEVEL ONLY. Blocks inherit; no block carries its own colour. A
 *    rebrand is one edit, not fifty, and a non-designer can't drift a single
 *    campaign off-brand. This is the designer's own stated model.
 *  - EVERY token is required (no optional colour fields). A partially-filled
 *    theme means the renderer needs per-token fallbacks scattered through it;
 *    instead `normalizeEmailTheme` fills gaps ONCE, at the edge.
 *  - `dark` is a PARTIAL override, not a second theme. Most themes only need
 *    to move 3-4 tokens for dark mode, and a partial keeps them in lockstep
 *    when the light side changes. `resolveDarkTheme` materializes it.
 *  - Fonts are full CSS stacks, not family names — email clients have no
 *    webfont guarantee, so the stack's FALLBACKS are what most recipients
 *    actually see. Inter is named first for the clients that do have it.
 */

/** A colour as authored: `#rgb` or `#rrggbb`, case-insensitive. Email clients
 *  are unreliable with `rgb()`/`hsl()`/named colours (and Outlook's Word
 *  renderer worst of all), so hex is the only accepted form. */
const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** True iff `value` is a `#rgb`/`#rrggbb` hex colour. */
export function isHexColor(value: string): boolean {
  return HEX_RE.test(value.trim());
}

/**
 * The full token set every campaign email is painted with.
 *
 * Semantic names, not literal ones (`accent`, not `maroon`) — a seasonal
 * theme swaps the VALUE and every block follows; a literal name would be a
 * lie the first time the brand moved.
 */
export type EmailThemeTokens = {
  /** Brand colour: buttons, eyebrows, links, the wordmark strip. */
  accent: string;
  /** Text drawn ON `accent` (button labels). Must clear contrast vs `accent`. */
  accentInk: string;
  /** Headings and high-emphasis body text, drawn on `surface`. */
  ink: string;
  /** Secondary/body text, drawn on `surface`. */
  muted: string;
  /** The page behind the card (the mail client's viewport background). */
  canvas: string;
  /** The card itself — what most text actually sits on. */
  surface: string;
  /** Hairlines: dividers, card borders. Decorative; exempt from contrast. */
  border: string;
  /** Inline links inside text blocks. */
  link: string;
  /** CSS font stack for headings. */
  headingFont: string;
  /** CSS font stack for body copy, buttons, and the footer. */
  bodyFont: string;
  /** Card corner radius in px. 0 = square. */
  radius: number;
  /** The small all-caps strip above the card. Empty string = no wordmark. */
  wordmark: string;
};

/** A named, storable theme. `dark` overrides only the tokens that must move
 *  under `prefers-color-scheme: dark` — see `resolveDarkTheme`. */
export type EmailTheme = EmailThemeTokens & {
  /** Human label shown in the theme picker ("Public Worship", "Advent"). */
  name: string;
  dark?: Partial<EmailThemeTokens>;
};

// ── Font stacks ────────────────────────────────────────────────────────────
// Inter is Public Worship's newsletter face. Email clients won't fetch a
// webfont reliably (Gmail strips @font-face outright), so the stack degrades
// through the system UI faces that look closest before hitting sans-serif.

const INTER =
  "Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const SERIF = "Georgia,'Times New Roman',Times,serif";

// ── Presets ────────────────────────────────────────────────────────────────
// `publicWorship` is the DEFAULT and the source of truth for the brand: these
// exact values are read off Public Worship's own monthly newsletter, not
// invented. The seasonal three are variations the designer asked for — same
// structure, shifted accent/surface — and are meant to be edited in-app, not
// treated as sacred.

/** Public Worship's real brand — the default every org starts on. */
export const PUBLIC_WORSHIP_THEME: EmailTheme = {
  name: "Public Worship",
  accent: "#891d1a",
  accentInk: "#fff9ee",
  ink: "#210706",
  muted: "#6b4a44",
  canvas: "#fff9ee",
  surface: "#ffffff",
  border: "#e8d9c8",
  link: "#891d1a",
  headingFont: INTER,
  bodyFont: INTER,
  radius: 16,
  wordmark: "PUBLIC WORSHIP",
  dark: {
    // The card inverts to a deep warm brown rather than pure black — a cream
    // brand going to #000 reads as a different organisation. `accent` lifts
    // because #891d1a on a dark card falls under 4.5:1.
    accent: "#e8736e",
    accentInk: "#210706",
    ink: "#fff9ee",
    muted: "#d8c3ba",
    canvas: "#170504",
    surface: "#241110",
    border: "#3d201d",
    link: "#e8736e",
  },
};

/** Warm, high-summer variation — brighter accent, sun-bleached canvas. */
export const SUMMER_THEME: EmailTheme = {
  name: "Summer",
  // `#bb4f18`, not the more obvious `#c2541b`: that lighter orange puts the
  // button label at 4.41:1, just under AA. `emailThemeContrastWarnings` caught
  // it — the preset is held to the same bar the editor holds the designer to.
  accent: "#bb4f18",
  accentInk: "#fffaf2",
  ink: "#2b1408",
  muted: "#7a5340",
  canvas: "#fff6e8",
  surface: "#ffffff",
  border: "#f0dcc4",
  link: "#bb4f18",
  headingFont: INTER,
  bodyFont: INTER,
  radius: 16,
  wordmark: "PUBLIC WORSHIP",
  dark: {
    accent: "#f0956a",
    accentInk: "#2b1408",
    ink: "#fff6e8",
    muted: "#dcc0aa",
    canvas: "#1a0d05",
    surface: "#291710",
    border: "#43281c",
    link: "#f0956a",
  },
};

/** Deeper, harvest variation — the newsletter's autumn dress. */
export const FALL_THEME: EmailTheme = {
  name: "Fall",
  accent: "#7a3410",
  accentInk: "#fdf3e7",
  ink: "#241207",
  muted: "#6d4c39",
  canvas: "#fdf3e7",
  surface: "#fffdfa",
  border: "#e6d2ba",
  link: "#7a3410",
  headingFont: SERIF,
  bodyFont: INTER,
  radius: 12,
  wordmark: "PUBLIC WORSHIP",
  dark: {
    accent: "#d98b5c",
    accentInk: "#241207",
    ink: "#fdf3e7",
    muted: "#d5bda8",
    canvas: "#150a04",
    surface: "#25150d",
    border: "#3d2618",
    link: "#d98b5c",
  },
};

/** Cool, restrained variation — Advent/winter. The one preset that leaves the
 *  warm-cream family, so its `border`/`muted` are re-tuned rather than reused. */
export const WINTER_THEME: EmailTheme = {
  name: "Winter",
  accent: "#1f4a63",
  accentInk: "#f4f9fc",
  ink: "#0e1c24",
  muted: "#4e6672",
  canvas: "#f4f9fc",
  surface: "#ffffff",
  border: "#d3e2ea",
  link: "#1f4a63",
  headingFont: SERIF,
  bodyFont: INTER,
  radius: 8,
  wordmark: "PUBLIC WORSHIP",
  dark: {
    accent: "#7db6d6",
    accentInk: "#0e1c24",
    ink: "#f4f9fc",
    muted: "#a9c1cd",
    canvas: "#060f14",
    surface: "#10222c",
    border: "#1f3945",
    link: "#7db6d6",
  },
};

/** Every built-in preset, in picker order. The first entry is the default. */
export const EMAIL_THEME_PRESETS: readonly EmailTheme[] = [
  PUBLIC_WORSHIP_THEME,
  SUMMER_THEME,
  FALL_THEME,
  WINTER_THEME,
];

/** The theme used when a campaign names none — Public Worship's real brand. */
export const DEFAULT_EMAIL_THEME: EmailTheme = PUBLIC_WORSHIP_THEME;

/** Look up a preset by name (exact, case-sensitive), or null. */
export function emailThemePreset(name: string): EmailTheme | null {
  return EMAIL_THEME_PRESETS.find((t) => t.name === name) ?? null;
}

// ── Normalization ──────────────────────────────────────────────────────────

const TOKEN_KEYS = [
  "accent",
  "accentInk",
  "ink",
  "muted",
  "canvas",
  "surface",
  "border",
  "link",
] as const;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Strip anything that could break out of a `font-family:` declaration.
 *
 * The RENDER-time half of the same defense-in-depth `emailRender.ts`'s
 * `safeEmailHref`/`safeImageSrc` provide for URLs: `validateEmailTheme` already
 * rejects these characters at the WRITE gate, but a theme written before that
 * gate existed — or via a direct DB write / import script — must still not be
 * able to inject a `}` and escape into arbitrary CSS. Font stacks are
 * interpolated into BOTH a `style=` attribute and a `<style>` block, and HTML
 * entities are not decoded inside `<style>`, so escaping is not an option here
 * — stripping is.
 *
 * Returns `null` when nothing usable survives, so the caller falls back to a
 * known-good stack rather than emitting an empty `font-family:`.
 */
export function safeFontStack(stack: string): string | null {
  const cleaned = stack.replace(FONT_STACK_FORBIDDEN_G, "").trim();
  return cleaned.length > 0 ? cleaned : null;
}

/** Global twin of `FONT_STACK_FORBIDDEN` — the validator only needs to know
 *  IF a bad character is present; the sanitizer needs to remove them all. */
const FONT_STACK_FORBIDDEN_G = /[;{}<>()\\]/g;

/** Read a hex token off an unknown object, falling back to the default theme's
 *  value when absent/malformed. The renderer must never emit `undefined` into
 *  a style attribute — a broken token should degrade to on-brand, not to a
 *  literal "undefined" in the CSS. */
function hexToken(
  source: Record<string, unknown>,
  key: (typeof TOKEN_KEYS)[number],
  fallback: EmailThemeTokens,
): string {
  const raw = source[key];
  return typeof raw === "string" && isHexColor(raw) ? raw.trim() : fallback[key];
}

/**
 * Coerce anything (a stored `emailThemes` row, a doc's inline theme, a
 * hand-written object, `undefined`) into a complete `EmailTheme`.
 *
 * Total by construction — never throws, always returns something renderable.
 * `validateEmailTheme` is the strict WRITE gate; this is the permissive READ
 * edge, the same split `validateEmailDocument` / forward-compatible rendering
 * already uses in `emailBlocks.ts`/`emailRender.ts`.
 */
export function normalizeEmailTheme(
  input: unknown,
  base: EmailTheme = DEFAULT_EMAIL_THEME,
): EmailTheme {
  if (!isPlainObject(input)) return base;

  const tokens = {} as Record<string, string | number>;
  for (const key of TOKEN_KEYS) tokens[key] = hexToken(input, key, base);

  const headingFont =
    (typeof input.headingFont === "string" ? safeFontStack(input.headingFont) : null) ??
    base.headingFont;
  const bodyFont =
    (typeof input.bodyFont === "string" ? safeFontStack(input.bodyFont) : null) ??
    base.bodyFont;
  const radius =
    typeof input.radius === "number" && Number.isFinite(input.radius)
      ? Math.max(0, Math.min(40, Math.round(input.radius)))
      : base.radius;
  const wordmark =
    typeof input.wordmark === "string" ? input.wordmark.trim() : base.wordmark;
  const name =
    typeof input.name === "string" && input.name.trim()
      ? input.name.trim()
      : base.name;

  const dark = isPlainObject(input.dark)
    ? normalizeDarkOverride(input.dark, base)
    : base.dark;

  return {
    name,
    ...(tokens as unknown as Pick<EmailThemeTokens, (typeof TOKEN_KEYS)[number]>),
    headingFont,
    bodyFont,
    radius,
    wordmark,
    ...(dark ? { dark } : {}),
  };
}

/** Normalize a `dark` partial — unlike the light side, a missing token stays
 *  MISSING (it means "don't override"), so this can't reuse `hexToken`'s
 *  fill-from-base behavior. */
function normalizeDarkOverride(
  input: Record<string, unknown>,
  base: EmailTheme,
): Partial<EmailThemeTokens> | undefined {
  const out: Partial<EmailThemeTokens> = {};
  for (const key of TOKEN_KEYS) {
    const raw = input[key];
    if (typeof raw === "string" && isHexColor(raw)) out[key] = raw.trim();
  }
  for (const key of ["headingFont", "bodyFont"] as const) {
    const raw = input[key];
    if (typeof raw !== "string") continue;
    const cleaned = safeFontStack(raw);
    if (cleaned) out[key] = cleaned;
  }
  if (Object.keys(out).length > 0) return out;
  return base.dark;
}

/**
 * Materialize the dark-mode token set: the theme's own values with `dark`
 * layered on top.
 *
 * When a theme declares NO `dark` overrides at all, this returns the light
 * tokens unchanged — deliberately. A theme with no dark intent renders
 * identically in both schemes, which is exactly what
 * `color-scheme: light dark` + no override should mean. Inventing an
 * auto-inversion here would produce the muddy, off-brand result the designer
 * was worried about in the first place.
 */
export function resolveDarkTheme(theme: EmailTheme): EmailThemeTokens {
  const { name: _name, dark, ...light } = theme;
  return { ...light, ...(dark ?? {}) };
}

// ── Contrast (WCAG 2.1) ────────────────────────────────────────────────────
// The composer warns the designer when a theme she's editing would render
// text that's hard to read. This is advisory in the UI (she can ship a
// warned theme — it's her brand), but it's the difference between "the cream
// looked fine on my monitor" and knowing a recipient on a phone in sunlight
// can't read the body copy.

function expandHex(hex: string): string {
  const h = hex.trim().replace("#", "");
  if (h.length === 3) return h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  return h;
}

/** sRGB channel → linear, per WCAG 2.1's relative-luminance definition. */
function channelLuminance(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** WCAG relative luminance of a hex colour (0 = black, 1 = white). Returns 0
 *  for a malformed colour — a caller should gate on `isHexColor` first. */
export function relativeLuminance(hex: string): number {
  const h = expandHex(hex);
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return 0;
  const r = channelLuminance(parseInt(h.slice(0, 2), 16));
  const g = channelLuminance(parseInt(h.slice(2, 4), 16));
  const b = channelLuminance(parseInt(h.slice(4, 6), 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two hex colours — 1 (identical) to 21
 *  (black on white). 4.5 is the AA threshold for body text, 3.0 for large. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/** WCAG AA minimum for normal-size body text. */
export const AA_CONTRAST_BODY = 4.5;
/** WCAG AA minimum for large text (≥18.66px bold / ≥24px regular). Headings
 *  in every preset are ≥20px, so they're judged against this, not 4.5. */
export const AA_CONTRAST_LARGE = 3;

export type ContrastWarning = {
  /** Machine-readable pair id, e.g. `"muted-on-surface"`. */
  id: string;
  /** What the designer sees: "Body text on the card". */
  label: string;
  ratio: number;
  required: number;
  /** Which scheme this pair was measured in. */
  scheme: "light" | "dark";
};

const CONTRAST_PAIRS: readonly {
  id: string;
  label: string;
  fg: (typeof TOKEN_KEYS)[number];
  bg: (typeof TOKEN_KEYS)[number];
  required: number;
}[] = [
  {
    id: "ink-on-surface",
    label: "Headings on the card",
    fg: "ink",
    bg: "surface",
    required: AA_CONTRAST_LARGE,
  },
  {
    id: "muted-on-surface",
    label: "Body text on the card",
    fg: "muted",
    bg: "surface",
    required: AA_CONTRAST_BODY,
  },
  {
    id: "link-on-surface",
    label: "Links in body text",
    fg: "link",
    bg: "surface",
    required: AA_CONTRAST_BODY,
  },
  {
    id: "accentInk-on-accent",
    label: "Button label on the button",
    fg: "accentInk",
    bg: "accent",
    required: AA_CONTRAST_BODY,
  },
  {
    id: "accent-on-canvas",
    label: "Wordmark on the page background",
    fg: "accent",
    bg: "canvas",
    required: AA_CONTRAST_LARGE,
  },
];

/**
 * Every text/background pair in `theme` that falls below its WCAG AA
 * threshold, measured in BOTH schemes (a theme can be perfectly legible in
 * light and unreadable in dark — that's the specific failure mode the
 * designer flagged).
 *
 * Advisory, not a write gate: `validateEmailTheme` accepts a theme with
 * warnings. Legibility is a judgement call the designer owns; a hard block
 * would just teach her to fight the tool.
 */
export function emailThemeContrastWarnings(theme: EmailTheme): ContrastWarning[] {
  const out: ContrastWarning[] = [];
  const schemes: { scheme: "light" | "dark"; tokens: EmailThemeTokens }[] = [
    { scheme: "light", tokens: theme },
    { scheme: "dark", tokens: resolveDarkTheme(theme) },
  ];
  for (const { scheme, tokens } of schemes) {
    for (const pair of CONTRAST_PAIRS) {
      const ratio = contrastRatio(tokens[pair.fg], tokens[pair.bg]);
      if (ratio + 0.005 < pair.required) {
        out.push({
          id: `${pair.id}-${scheme}`,
          label: pair.label,
          ratio: Math.round(ratio * 100) / 100,
          required: pair.required,
          scheme,
        });
      }
    }
  }
  return out;
}

// ── Validation (WRITE gate) ────────────────────────────────────────────────

export type ValidateEmailThemeResult =
  | { ok: true; theme: EmailTheme }
  | { ok: false; error: string };

/** Cap on a font stack — long enough for a real stack with quoted families,
 *  short enough that the field can't smuggle a stylesheet into every send. */
const MAX_FONT_STACK = 240;
const MAX_WORDMARK = 48;
const MAX_THEME_NAME = 60;

/** A font stack may not contain the characters that would let it break out of
 *  the `font-family:` declaration it's interpolated into (`emailRender.ts`
 *  writes it straight into a `style=` attribute and a `<style>` block).
 *  Quotes are escaped at render time, but `;`/`{`/`}`/`<` have no business in
 *  a font stack at all and are rejected outright rather than escaped. */
const FONT_STACK_FORBIDDEN = /[;{}<>()\\]/;

/**
 * Strict validation for the write path — an org's stored theme and a doc's
 * inline theme both go through this before they land in the DB.
 *
 * Rejects (rather than silently repairs) so a designer who typos a hex gets
 * told, instead of watching her colour quietly revert to the default. The
 * permissive counterpart is `normalizeEmailTheme`, used at render time.
 */
export function validateEmailTheme(input: unknown): ValidateEmailThemeResult {
  if (!isPlainObject(input)) return { ok: false, error: "theme must be an object" };

  if (typeof input.name !== "string" || input.name.trim().length === 0) {
    return { ok: false, error: 'theme "name" must be a non-empty string' };
  }
  if (input.name.trim().length > MAX_THEME_NAME) {
    return { ok: false, error: `theme "name" must be ${MAX_THEME_NAME} characters or fewer` };
  }

  for (const key of TOKEN_KEYS) {
    const raw = input[key];
    if (typeof raw !== "string" || !isHexColor(raw)) {
      return { ok: false, error: `theme "${key}" must be a hex colour like #891d1a` };
    }
  }

  for (const key of ["headingFont", "bodyFont"] as const) {
    const raw = input[key];
    if (typeof raw !== "string" || raw.trim().length === 0) {
      return { ok: false, error: `theme "${key}" must be a non-empty CSS font stack` };
    }
    if (raw.length > MAX_FONT_STACK) {
      return { ok: false, error: `theme "${key}" must be ${MAX_FONT_STACK} characters or fewer` };
    }
    if (FONT_STACK_FORBIDDEN.test(raw)) {
      return { ok: false, error: `theme "${key}" contains characters not allowed in a font stack` };
    }
  }

  if (
    typeof input.radius !== "number" ||
    !Number.isFinite(input.radius) ||
    input.radius < 0 ||
    input.radius > 40
  ) {
    return { ok: false, error: 'theme "radius" must be a number between 0 and 40' };
  }

  if (typeof input.wordmark !== "string") {
    return { ok: false, error: 'theme "wordmark" must be a string (empty for none)' };
  }
  if (input.wordmark.length > MAX_WORDMARK) {
    return { ok: false, error: `theme "wordmark" must be ${MAX_WORDMARK} characters or fewer` };
  }

  if (input.dark !== undefined) {
    if (!isPlainObject(input.dark)) {
      return { ok: false, error: 'theme "dark" must be an object' };
    }
    for (const key of TOKEN_KEYS) {
      const raw = input.dark[key];
      if (raw === undefined) continue;
      if (typeof raw !== "string" || !isHexColor(raw)) {
        return { ok: false, error: `theme "dark.${key}" must be a hex colour like #e8736e` };
      }
    }
    for (const key of ["headingFont", "bodyFont"] as const) {
      const raw = input.dark[key];
      if (raw === undefined) continue;
      if (typeof raw !== "string" || raw.trim().length === 0) {
        return { ok: false, error: `theme "dark.${key}" must be a non-empty CSS font stack` };
      }
      if (raw.length > MAX_FONT_STACK || FONT_STACK_FORBIDDEN.test(raw)) {
        return { ok: false, error: `theme "dark.${key}" is not a valid font stack` };
      }
    }
  }

  return { ok: true, theme: normalizeEmailTheme(input) };
}
