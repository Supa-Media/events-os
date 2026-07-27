/**
 * EMAIL THEME EDITOR — the pure, dependency-free half of the campaign theme
 * screen (`app/(app)/campaigns/themes.tsx`).
 *
 * No react, no convex: the curated font list, the sample document the live
 * preview renders, and the dark-preview HTML rewrite are all plain data +
 * string functions, so they're unit-testable under this package's jest config
 * (the `lib/emailDesigner.ts` precedent) instead of only being exercisable by
 * mounting a screen.
 *
 * `packages/shared/src/emailTheme.ts` owns the MODEL (tokens, presets,
 * validation, contrast). Nothing here duplicates it — this file is only about
 * what the editing SURFACE needs on top of it.
 */
import {
  DEFAULT_EMAIL_THEME,
  EMAIL_THEME_PRESETS,
  newBlockId,
  resolveDarkTheme,
  type EmailDocument,
  type EmailTheme,
  type EmailThemeTokens,
} from "@events-os/shared";

// ── Font stacks ────────────────────────────────────────────────────────────

/**
 * The font stacks the designer can choose from.
 *
 * A CLOSED LIST, not a free-text field, and that's the point: `headingFont` /
 * `bodyFont` are raw CSS font stacks interpolated into a `style=` attribute
 * and a `<style>` block, so free text is both a footgun (one typo and every
 * recipient falls back to Times) and an injection surface the validator has
 * to police character by character. The designer is choosing a LOOK; the
 * stack is an implementation detail of that look.
 *
 * Every stack ends in a generic family, and every one is written with only
 * the characters `validateEmailTheme` allows — it rejects `; { } < > ( ) \`
 * outright, since a font stack is interpolated straight into CSS and those
 * are the characters that would let one break out of the declaration.
 */
export const FONT_STACKS: readonly { value: string; label: string }[] = [
  {
    label: "Inter (the newsletter's face)",
    value:
      "Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif",
  },
  {
    label: "Georgia (serif)",
    value: "Georgia,'Times New Roman',Times,serif",
  },
  {
    label: "System sans",
    value: "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif",
  },
  {
    label: "Helvetica (classic sans)",
    value: "'Helvetica Neue',Helvetica,Arial,sans-serif",
  },
  {
    label: "Monospace",
    value: "ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace",
  },
];

/**
 * Font `Select` options for `current`, appending a "Custom" entry when the
 * theme's stack isn't one of ours.
 *
 * Without this a theme authored before the curated list existed (or seeded
 * by a preset that later changed) would open with an EMPTY font picker, and
 * the first tap on any other control would look like it had silently blanked
 * her font. Showing the real stack as a selectable option keeps the edit
 * non-destructive.
 */
export function fontOptionsFor(current: string): { value: string; label: string }[] {
  const options = FONT_STACKS.map((f) => ({ ...f }));
  if (!options.some((o) => o.value === current) && current.trim()) {
    options.push({ value: current, label: `Custom — ${current.split(",")[0]}` });
  }
  return options;
}

// ── Token metadata ─────────────────────────────────────────────────────────

/** The eight hex-valued tokens — every `EmailThemeTokens` key except the two
 *  font stacks, the radius, and the wordmark. */
export type ColorTokenKey =
  | "accent"
  | "accentInk"
  | "canvas"
  | "surface"
  | "ink"
  | "muted"
  | "link"
  | "border";

/** The colour tokens, in the order the editor lists them, with the plain-
 *  English description of what each one paints. Ordered by how much of the
 *  email the token is responsible for, so the two that define the whole look
 *  (`accent`, `canvas`) come first. */
export const COLOR_TOKENS: readonly {
  key: ColorTokenKey;
  label: string;
  help: string;
}[] = [
  { key: "accent", label: "Accent", help: "Buttons, eyebrows, links, the wordmark." },
  { key: "accentInk", label: "Button label", help: "The text drawn on top of the accent." },
  { key: "canvas", label: "Page background", help: "Behind the card — the whole viewport." },
  { key: "surface", label: "Card", help: "The card itself. Most text sits on this." },
  { key: "ink", label: "Headings", help: "Headings and high-emphasis text." },
  { key: "muted", label: "Body text", help: "Paragraphs, captions, the footer." },
  { key: "link", label: "Links", help: "Inline links inside text blocks." },
  { key: "border", label: "Hairlines", help: "Dividers and the card's border." },
];

/**
 * Suggested swatches for a colour token — every value the built-in presets
 * use for that same token, de-duplicated.
 *
 * Deliberately drawn from the presets rather than from a generic colour
 * wheel: the useful suggestion when picking a `canvas` is "the cream the
 * other three themes use", not "#FF00FF".
 */
export function suggestedSwatches(key: ColorTokenKey): string[] {
  const out: string[] = [];
  for (const preset of EMAIL_THEME_PRESETS) {
    for (const tokens of [preset, resolveDarkTheme(preset)]) {
      const value = tokens[key];
      if (!out.includes(value)) out.push(value);
    }
  }
  return out;
}

// ── Dark-mode overrides ────────────────────────────────────────────────────

/** Which tokens the dark sub-editor exposes. Fonts and radius are NOT
 *  overridable in dark mode by design — a theme that changes typeface with
 *  the OS setting reads as two different brands. */
export const DARK_TOKEN_KEYS: ColorTokenKey[] = COLOR_TOKENS.map((t) => t.key);

/**
 * Seed a `dark` override from the theme's own light values — the "start from
 * the light values" button.
 *
 * It intentionally produces a light-looking dark mode (identical to the
 * light theme) rather than guessing an inversion. `resolveDarkTheme`'s own
 * doc explains why: an auto-inversion produces exactly the muddy, off-brand
 * result the designer complained about. This gives her every token
 * pre-filled and editable, which is a starting point, not an answer.
 */
export function darkFromLight(theme: EmailTheme): Partial<EmailThemeTokens> {
  const seeded: Partial<EmailThemeTokens> = {};
  for (const key of DARK_TOKEN_KEYS) seeded[key] = theme[key];
  return seeded;
}

// ── Live preview ───────────────────────────────────────────────────────────

/** The marker `emailRender.ts` wraps its dark-mode overrides in. */
const DARK_MEDIA_QUERY = "@media (prefers-color-scheme: dark) {";

/**
 * Rewrite a rendered campaign email so its DARK rendering is what's shown,
 * regardless of the previewing device's colour scheme.
 *
 * ── Why this is needed at all ──────────────────────────────────────────────
 * The preview is hosted in a sandboxed `<iframe srcDoc>` on web and a
 * `react-native-webview` on native. Neither can be told "pretend the user
 * prefers dark": `prefers-color-scheme` resolves against the OS/browser
 * setting, and the iframe is `sandbox=""` (no scripts, no same-origin), so
 * there's nothing to reach in and toggle either. Forcing `color-scheme: dark`
 * on the frame doesn't help either — that changes how the BROWSER paints form
 * controls and scrollbars, not how a media query evaluates.
 *
 * ── What this does instead ─────────────────────────────────────────────────
 * It turns the media query itself into an unconditional one (`@media all`).
 * The dark block's rules are already `!important` overrides of the inline
 * light styles, so un-gating them makes the dark rendering the ONLY rendering
 * — and it's the renderer's REAL dark CSS being exercised, not a re-render
 * with the dark tokens swapped in. That distinction matters: the whole reason
 * the designer asked for this toggle is that emails were breaking in dark
 * mode, and a preview that re-renders with dark tokens would look perfect
 * even if the dark CSS were missing a selector.
 *
 * `<body>` carries its light background as an INLINE style, which nothing in
 * the dark block overrides (the `.wrap` div covers the content area but not
 * necessarily the full frame height), so the dark canvas is also pinned via
 * an appended `<style>`. `canvas` is a validated hex token, but it's checked
 * against a strict pattern here anyway — this string is being spliced into
 * CSS, and "it was validated upstream" is not something a sink should trust.
 *
 * Returns the HTML unchanged when the marker isn't found, so a future
 * renderer refactor degrades to "the light preview" rather than to a
 * corrupted document.
 */
export function forceDarkEmailPreview(html: string, darkCanvas: string): string {
  if (!html.includes(DARK_MEDIA_QUERY)) return html;
  const forced = html.replace(DARK_MEDIA_QUERY, "@media all {");
  const safeCanvas = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(darkCanvas.trim())
    ? darkCanvas.trim()
    : null;
  if (!safeCanvas) return forced;
  const pin = `<style>html,body{background:${safeCanvas} !important;}</style>`;
  return forced.includes("</head>")
    ? forced.replace("</head>", `${pin}</head>`)
    : `${pin}${forced}`;
}

/**
 * The document the theme preview renders — one of every block the theme
 * visibly changes: eyebrow, heading, body text with a link, a button, a card
 * with a CTA, and a quote.
 *
 * Built fresh per call (rather than as a module constant) because every block
 * needs an id and `newBlockId` is non-deterministic; the ids are never
 * persisted — this document exists only to be rendered.
 */
export function themeSampleDocument(theme: EmailTheme): EmailDocument {
  return {
    theme,
    blocks: [
      { id: newBlockId(), kind: "eyebrow", text: "THIS MONTH", icon: "◆" },
      { id: newBlockId(), kind: "heading", text: "A night of worship", level: 1 },
      {
        id: newBlockId(),
        kind: "text",
        markdown:
          "Body copy sits on the card in the **muted** tone, with [a link](https://publicworship.life) showing the link colour. This paragraph is here to show how a full line of text reads at real length.",
      },
      {
        id: newBlockId(),
        kind: "button",
        label: "Reserve a seat",
        url: "https://publicworship.life",
        align: "left",
      },
      {
        id: newBlockId(),
        kind: "card",
        heading: "Song of the month",
        body: "A card shows a heading, body copy, and its own call to action.",
        ctaLabel: "Listen",
        ctaUrl: "https://publicworship.life",
      },
      {
        id: newBlockId(),
        kind: "quote",
        text: "Sing to the Lord a new song.",
        attribution: "Psalm 96",
      },
    ],
  };
}

/** A safe starting theme for a brand-new custom theme. */
export function blankTheme(name: string): EmailTheme {
  return { ...DEFAULT_EMAIL_THEME, name };
}
