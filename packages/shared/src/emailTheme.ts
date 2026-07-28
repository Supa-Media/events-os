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
  /** The page behind the container (the mail client's viewport background).
   *  In the real newsletter this is a COOL GREY, not the cream — the cream is
   *  a card colour, not the page. */
  canvas: string;
  /** The email container — what most content sits on. White in the real
   *  newsletter; the cream sits on top of it in specific cards. */
  surface: string;
  /** The warm card background used by the feature card and the footer block
   *  (`#fff9ee`). A THIRD surface, not a variant of `surface` — the design
   *  uses white, cream and near-black as three distinct card fills. */
  cream: string;
  /** The near-black used for filled buttons and the testimonial card
   *  (`#210706`). Named for its role, not its colour. */
  contrast: string;
  /** Text drawn on `contrast` (filled button labels, testimonial copy). */
  contrastInk: string;
  /** The thin rule between sections (`#bfc3c8`) — lighter than `border`. */
  hairline: string;
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
  /** Heading letter-spacing, e.g. "-0.04em". The real newsletter sets its
   *  headings TIGHT; leaving this at browser default is a large part of why
   *  a copy of the palette still doesn't look like the brand. */
  headingTracking: string;
  /** Body letter-spacing, e.g. "-0.01em". */
  bodyTracking: string;
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
  accentInk: "#ffffff",
  ink: "#210706",
  muted: "#210706",
  canvas: "#f0f1f5",
  surface: "#ffffff",
  cream: "#fff9ee",
  contrast: "#210706",
  contrastInk: "#ffffff",
  hairline: "#bfc3c8",
  border: "#000000",
  link: "#1a62ff",
  headingFont: INTER,
  bodyFont: INTER,
  radius: 21,
  headingTracking: "-0.04em",
  bodyTracking: "-0.01em",
  wordmark: "",
  dark: {
    // The card inverts to a deep warm brown rather than pure black — a cream
    // brand going to #000 reads as a different organisation. `accent` lifts
    // because #891d1a on a dark card falls under 4.5:1.
    accent: "#e8736e",
    accentInk: "#210706",
    ink: "#fff9ee",
    muted: "#e6dcd6",
    canvas: "#0d0d10",
    surface: "#1a1412",
    cream: "#241d16",
    contrast: "#efe6dd",
    contrastInk: "#1a1412",
    hairline: "#3d3733",
    border: "#4a423d",
    link: "#8fb4ff",
  },
};

/** Warm, high-summer variation — brighter accent, sun-bleached canvas. */
export const SUMMER_THEME: EmailTheme = {
  name: "Summer",
  // `#bb4f18`, not the more obvious `#c2541b`: that lighter orange puts the
  // button label at 4.41:1, just under AA. `emailThemeContrastWarnings` caught
  // it — the preset is held to the same bar the editor holds the designer to.
  accent: "#bb4f18",
  accentInk: "#ffffff",
  ink: "#2b1408",
  muted: "#2b1408",
  canvas: "#f3f1ee",
  surface: "#ffffff",
  cream: "#fff6e8",
  contrast: "#2b1408",
  contrastInk: "#ffffff",
  hairline: "#cfc7bd",
  border: "#2b1408",
  link: "#1a62ff",
  headingFont: INTER,
  bodyFont: INTER,
  radius: 21,
  headingTracking: "-0.04em",
  bodyTracking: "-0.01em",
  wordmark: "",
  dark: {
    accent: "#f0956a",
    accentInk: "#2b1408",
    ink: "#fff6e8",
    muted: "#efe2d8",
    canvas: "#100c08",
    surface: "#1d1510",
    cream: "#281d15",
    contrast: "#f3e7dc",
    contrastInk: "#1d1510",
    hairline: "#403830",
    border: "#4d443b",
    link: "#8fb4ff",
  },
};

/** Deeper, harvest variation — the newsletter's autumn dress. */
export const FALL_THEME: EmailTheme = {
  name: "Fall",
  accent: "#7a3410",
  accentInk: "#ffffff",
  ink: "#241207",
  muted: "#241207",
  canvas: "#f1efec",
  surface: "#ffffff",
  cream: "#fdf3e7",
  contrast: "#241207",
  contrastInk: "#ffffff",
  hairline: "#cbc3b8",
  border: "#241207",
  link: "#1a62ff",
  headingFont: SERIF,
  bodyFont: INTER,
  radius: 21,
  headingTracking: "-0.03em",
  bodyTracking: "-0.01em",
  wordmark: "",
  dark: {
    accent: "#d98b5c",
    accentInk: "#241207",
    ink: "#fdf3e7",
    muted: "#ece0d4",
    canvas: "#0f0b07",
    surface: "#1c1410",
    cream: "#261c14",
    contrast: "#f0e6da",
    contrastInk: "#1c1410",
    hairline: "#3e352d",
    border: "#4b4139",
    link: "#8fb4ff",
  },
};

/** Cool, restrained variation — Advent/winter. The one preset that leaves the
 *  warm-cream family, so its `border`/`muted` are re-tuned rather than reused. */
export const WINTER_THEME: EmailTheme = {
  name: "Winter",
  accent: "#1f4a63",
  accentInk: "#ffffff",
  ink: "#0e1c24",
  muted: "#0e1c24",
  canvas: "#eef1f3",
  surface: "#ffffff",
  cream: "#f4f9fc",
  contrast: "#0e1c24",
  contrastInk: "#ffffff",
  hairline: "#c2ccd2",
  border: "#0e1c24",
  link: "#1a62ff",
  headingFont: SERIF,
  bodyFont: INTER,
  radius: 21,
  headingTracking: "-0.03em",
  bodyTracking: "-0.01em",
  wordmark: "",
  dark: {
    accent: "#7db6d6",
    accentInk: "#0e1c24",
    ink: "#f4f9fc",
    muted: "#dde7ec",
    canvas: "#05090c",
    surface: "#0f1a20",
    cream: "#16242c",
    contrast: "#e6eef2",
    contrastInk: "#0f1a20",
    hairline: "#2b3a43",
    border: "#3a4a54",
    link: "#8fb4ff",
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
  "cream",
  "contrast",
  "contrastInk",
  "hairline",
  "border",
  "link",
] as const;

/** Non-colour string tokens that normalize/validate the same way as the font
 *  stacks — letter-spacing values written straight into a style attribute. */
const TRACKING_KEYS = ["headingTracking", "bodyTracking"] as const;

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
 * able to break out of the declaration it lands in.
 *
 * A font stack is interpolated raw into a double-quoted `style="…"` attribute
 * (the `<style>` block interpolates only hex tokens and the radius, never a
 * font). Stripping rather than escaping, for two reasons: entities are not
 * decoded inside a `<style>` block, so escaping would be the wrong tool if a
 * font ever does land there; and no legitimate font stack contains any of
 * these characters, so there is nothing to preserve.
 *
 * Returns `null` when nothing usable survives, so the caller falls back to a
 * known-good stack rather than emitting an empty `font-family:`.
 */
export function safeFontStack(stack: string): string | null {
  const cleaned = stack.replace(FONT_STACK_FORBIDDEN_G, "").trim();
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * Sanitize a letter-spacing value. It lands in the same `style="…"` attribute
 * a font stack does, so it gets the same treatment — but the grammar is far
 * narrower (a signed number plus a unit), so it is validated by SHAPE rather
 * than by blocklist. Returns null when it isn't one.
 */
export function safeTracking(value: string): string | null {
  const v = value.trim();
  return /^-?(?:\d+)?(?:\.\d+)?(?:em|rem|px)$|^normal$|^0$/.test(v) ? v : null;
}

/** Global twin of `FONT_STACK_FORBIDDEN` — the validator only needs to know
 *  IF a bad character is present; the sanitizer needs to remove them all. */
const FONT_STACK_FORBIDDEN_G = /[;{}<>()\\"/*]/g;

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
  const tracking = {} as Record<string, string>;
  for (const key of TRACKING_KEYS) {
    const raw = input[key];
    tracking[key] =
      typeof raw === "string" && safeTracking(raw) !== null
        ? (safeTracking(raw) as string)
        : base[key];
  }

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

  // ABSENCE IS MEANINGFUL — never inherit `dark` from `base`.
  //
  // Filling a missing `dark` from the base theme means a Winter theme that
  // declares no dark intent renders Public Worship's MAROON dark mode: a blue
  // brand turning maroon at night, which is the exact off-brand failure this
  // module exists to prevent. It also silently contradicts `resolveDarkTheme`,
  // which documents that a theme with no `dark` renders identically in both
  // schemes — that promise is unkeepable if normalization invents one first.
  //
  // The cost is that a genuinely PARTIAL input (a few tokens meant to merge
  // onto `base`) no longer inherits the base's dark overrides. That's the
  // right trade: the worst case here is a theme that doesn't darken, which a
  // designer can see and fix, versus one that darkens to another brand's
  // colours, which only a recipient sees.
  const dark = isPlainObject(input.dark) ? normalizeDarkOverride(input.dark) : undefined;

  return {
    name,
    ...(tokens as unknown as Pick<EmailThemeTokens, (typeof TOKEN_KEYS)[number]>),
    headingFont,
    bodyFont,
    radius,
    ...(tracking as unknown as Pick<EmailThemeTokens, (typeof TRACKING_KEYS)[number]>),
    wordmark,
    ...(dark ? { dark } : {}),
  };
}

/** Normalize a `dark` partial — unlike the light side, a missing token stays
 *  MISSING (it means "don't override"), so this can't reuse `hexToken`'s
 *  fill-from-base behavior. An override object with nothing usable in it
 *  returns `undefined` (i.e. "no dark intent"), never the base's overrides —
 *  see the note at the call site. */
function normalizeDarkOverride(
  input: Record<string, unknown>,
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
  return Object.keys(out).length > 0 ? out : undefined;
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
    // Judged at the BODY bar, not the large-text one. `ink` was originally
    // held to 3:1 on the reasoning that "headings in every preset are ≥20px"
    // — true when written, false now: poll option labels render `ink` at
    // 14px/600, which is not WCAG large text (that needs ≥18.66px bold). A
    // theme with `ink` near 3:1 would have passed every warning while
    // shipping sub-AA poll options.
    id: "ink-on-surface",
    label: "Headings and poll options on the card",
    fg: "ink",
    bg: "surface",
    required: AA_CONTRAST_BODY,
  },
  {
    // Body copy on the cream card (the event card and the footer block).
    id: "ink-on-cream",
    label: "Text on the cream card",
    fg: "ink",
    bg: "cream",
    required: AA_CONTRAST_BODY,
  },
  {
    // The testimonial card is near-black with light copy — its own pair,
    // because nothing else in the theme measures that combination.
    id: "contrastInk-on-contrast",
    label: "Testimonial copy and filled-button labels",
    fg: "contrastInk",
    bg: "contrast",
    required: AA_CONTRAST_BODY,
  },
  {
    // The footer and the unsubscribe link sit on `canvas`, not `surface`, and
    // had no pair at all — the one piece of text every send is legally
    // required to carry was the one nothing checked.
    id: "muted-on-canvas",
    label: "Footer and unsubscribe link",
    fg: "muted",
    bg: "canvas",
    required: AA_CONTRAST_BODY,
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

/**
 * Characters a font stack may not contain, because `emailRender.ts`
 * interpolates it RAW into a double-quoted `style="…"` attribute.
 *
 * `"` is the load-bearing one and was originally missed. Two distinct
 * failures came from that, and the boring one is the more likely:
 *  - A designer pasting the CONVENTIONAL form of a stack,
 *    `Inter,"Segoe UI",sans-serif`, terminates the style attribute at its
 *    own second quote — every element silently loses every declaration
 *    after `font-family`, and the email renders unstyled with no warning.
 *  - The same gap lets an author inject arbitrary HTML attributes
 *    (`Inter" onmouseover="…`) into essentially every element of a real
 *    send. Assignment syntax needs none of the other forbidden characters.
 * A single quote is NOT forbidden — it is the safe way to quote a family
 * inside a double-quoted attribute, and every preset relies on it
 * (`'Segoe UI'`).
 *
 * `/` and `*` are forbidden because `Inter/*` opens a CSS comment that eats
 * the rest of the declaration list — the same silent-unstyling failure by
 * another route. No real font family contains either.
 *
 * These are REJECTED rather than escaped: entities are not decoded inside a
 * `<style>` block, so escaping would be wrong in the one context where this
 * value may also land, and no legitimate font stack needs them anywhere.
 */
const FONT_STACK_FORBIDDEN = /[;{}<>()\\"/*]/;

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

  for (const key of TRACKING_KEYS) {
    const raw = input[key];
    if (typeof raw !== "string" || safeTracking(raw) === null) {
      return {
        ok: false,
        error: `theme "${key}" must be a letter-spacing value like -0.04em`,
      };
    }
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
