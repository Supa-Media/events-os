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
  isHexColor,
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

/** The twelve hex-valued tokens — every `EmailThemeTokens` key except the two
 *  font stacks, the two letter-spacings, the radius, and the wordmark. */
export type ColorTokenKey =
  | "accent"
  | "accentInk"
  | "canvas"
  | "surface"
  | "cream"
  | "contrast"
  | "contrastInk"
  | "ink"
  | "muted"
  | "link"
  | "hairline"
  | "border";

export type ColorToken = { key: ColorTokenKey; label: string; help: string };

/**
 * The colour tokens, GROUPED by the part of the email they paint.
 *
 * Twelve swatches in one flat column is a wall: `cream` and `contrast` read
 * as two more arbitrary colours rather than as the third and fourth SURFACE
 * the design is built from, and `hairline`/`border` — which differ only in
 * weight — end up ten rows apart. Grouping states the model instead: the
 * design has four fills (page, card, cream, near-black), each with the text
 * colour that sits on it, and two weights of rule.
 *
 * Each fill keeps its own ink beside it (`accent`+`accentInk`,
 * `contrast`+`contrastInk`) rather than being filed under a single "text"
 * group: those pairs are what the contrast warnings measure, and moving one
 * without looking at the other is the mistake the grouping exists to prevent.
 */
export const COLOR_TOKEN_GROUPS: readonly {
  title: string;
  help: string;
  tokens: readonly ColorToken[];
}[] = [
  {
    title: "Page & container",
    help: "The two layers everything else sits on.",
    tokens: [
      {
        key: "canvas",
        label: "Page background",
        help: "The whole viewport, behind the email. Cool grey in the real newsletter — not the cream.",
      },
      {
        key: "surface",
        label: "Container",
        help: "The email itself. White in the real newsletter; most text sits on this.",
      },
    ],
  },
  {
    title: "Card fills",
    help: "The design uses three distinct card colours, each with its own text colour.",
    tokens: [
      { key: "accent", label: "Accent", help: "The brand colour: hero card, eyebrows, the wordmark." },
      { key: "accentInk", label: "Text on accent", help: "Drawn on top of the accent fill." },
      { key: "cream", label: "Cream card", help: "The warm fill used by the feature card and the footer." },
      { key: "contrast", label: "Near-black card", help: "The testimonial card and filled buttons." },
      { key: "contrastInk", label: "Text on near-black", help: "Testimonial copy and filled-button labels." },
    ],
  },
  {
    title: "Text",
    help: "Drawn on the container and the cream card.",
    tokens: [
      { key: "ink", label: "Headings", help: "Headings, poll options, high-emphasis text." },
      { key: "muted", label: "Body text", help: "Paragraphs, captions, the legal footer." },
      { key: "link", label: "Links", help: "Inline links inside text blocks." },
    ],
  },
  {
    title: "Lines",
    help: "Decorative — exempt from the contrast checks below.",
    tokens: [
      { key: "hairline", label: "Section rule", help: "The thin full-width rule between sections. Lighter than the border." },
      { key: "border", label: "Borders", help: "Dividers, the outlined card's border, outline buttons." },
    ],
  },
];

/** Every colour token, flattened, in the order the editor lists them. Kept as
 *  the flat list for anything that just needs "all of them" (the dark
 *  overrides, the swatch tests) — `COLOR_TOKEN_GROUPS` is the source. */
export const COLOR_TOKENS: readonly ColorToken[] = COLOR_TOKEN_GROUPS.flatMap(
  (group) => group.tokens,
);

// ── Letter-spacing ─────────────────────────────────────────────────────────

/**
 * The letter-spacing values the two tracking tokens can be set to.
 *
 * A CLOSED LIST for the same reason the fonts are one: these strings are
 * interpolated straight into a `style="…"` attribute, `validateEmailTheme`
 * rejects anything that isn't a bare number-plus-unit, and the designer is
 * choosing a LOOK ("tight, like the newsletter") rather than authoring CSS.
 * Free text here buys nothing and can reject the save on a typo.
 *
 * The range stops at -0.04em because that's what Public Worship's headings
 * actually use; past it the letters start colliding at heading sizes.
 */
export const TRACKING_PRESETS: readonly { value: string; label: string }[] = [
  { value: "normal", label: "Normal" },
  { value: "-0.01em", label: "Slightly tight (-0.01em)" },
  { value: "-0.02em", label: "Tight (-0.02em)" },
  { value: "-0.03em", label: "Tighter (-0.03em)" },
  { value: "-0.04em", label: "Tightest (-0.04em) — the newsletter's headings" },
];

/** Tracking `Select` options for `current`, appending the theme's own value
 *  when it isn't one of ours — the same non-destructive rule `fontOptionsFor`
 *  follows, and for the same reason: a theme seeded before this list existed
 *  must not open with an empty picker that blanks its tracking on the next
 *  unrelated edit. */
export function trackingOptionsFor(current: string): { value: string; label: string }[] {
  const options = TRACKING_PRESETS.map((t) => ({ ...t }));
  if (!options.some((o) => o.value === current) && current.trim()) {
    options.push({ value: current, label: `Custom — ${current}` });
  }
  return options;
}

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

/**
 * The colour a half-typed hex field should COMMIT to, or null while it isn't
 * one yet. `ColorField`'s only rule about when to push a value upstream.
 *
 * The subtlety this exists for: `isHexColor` alone is not a "finished typing"
 * test. Typing `891d1a` (no leading `#`, the way it's written on a brand
 * sheet) passes through the intermediate `891` — and `#891` is a perfectly
 * valid 3-digit hex, a DIFFERENT colour. Committing it means the live preview
 * jumps to the wrong colour, the field rewrites itself to `#891` under the
 * caret, and if the designer looks away at that moment `#891` is what the
 * theme saves. So:
 *
 *  - With an explicit `#`, `isHexColor`'s own rule stands (4 or 7 characters,
 *    3- or 6-digit): someone who typed `#891` typed a complete colour, and
 *    honouring it is the whole reason shorthand hex exists.
 *  - WITHOUT the `#`, only the full 6-digit form commits. A bare 3-character
 *    run is indistinguishable from the first half of a 6-character one, and
 *    guessing wrong silently ships the wrong brand colour. (`ColorField`
 *    already renders a hash-less draft as not-a-colour-yet, so this only
 *    makes the field's two halves agree.)
 *
 * Paste is unaffected in every form that carries its `#`, and hash-less
 * `891d1a` — the case the leading-`#`-optional affordance was written for —
 * still commits on the last character.
 */
export function hexFromDraft(draft: string): string | null {
  const candidate = draft.trim();
  if (candidate.startsWith("#")) return isHexColor(candidate) ? candidate : null;
  const hashed = `#${candidate}`;
  return candidate.length === 6 && isHexColor(hashed) ? hashed : null;
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
 * visibly changes.
 *
 * It has to cover every EDITABLE token, not just the common ones: `cream`,
 * `contrast`/`contrastInk` and `hairline` are only ever painted by the
 * feature card, the testimonial card, the footer and the section rule, so a
 * sample without those four blocks leaves a third of the colour form driving
 * nothing the designer can see. Turning a knob with no visible effect reads
 * as a broken control, not as a subtle one.
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
      { id: newBlockId(), kind: "hairline" },
      {
        id: newBlockId(),
        kind: "card",
        variant: "feature",
        eyebrow: "SONG OF THE MONTH",
        heading: "Song of the month",
        body: "The feature card is the cream one. It carries a heading, body copy, and its own call to action.",
        ctaLabel: "Listen",
        ctaUrl: "https://publicworship.life",
      },
      {
        id: newBlockId(),
        kind: "card",
        variant: "outlined",
        heading: "What's on",
        body: "The outlined card is the only place the border colour shows, and its button is the outline one.",
        ctaLabel: "See the dates",
        ctaUrl: "https://publicworship.life",
        ctaStyle: "outline",
      },
      {
        id: newBlockId(),
        kind: "card",
        variant: "testimonial",
        body: "The testimonial card is near-black, so it shows the contrast pair on its own.",
        attribution: "A member of the congregation",
      },
      {
        id: newBlockId(),
        kind: "quote",
        text: "Sing to the Lord a new song.",
        attribution: "Psalm 96",
      },
      {
        id: newBlockId(),
        kind: "footer",
        navLine: "Public Worship",
        links: [{ label: "Instagram", url: "https://publicworship.life" }],
      },
    ],
  };
}

/** A safe starting theme for a brand-new custom theme. */
export function blankTheme(name: string): EmailTheme {
  return { ...DEFAULT_EMAIL_THEME, name };
}
