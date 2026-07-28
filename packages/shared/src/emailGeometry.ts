/**
 * EMAIL GEOMETRY — the one table of SHAPE for a campaign email.
 *
 * The theme (`emailTheme.ts`) supplies every colour, font and radius. This
 * file supplies everything else: the container width, the gutters, the type
 * scale, the paddings, and the per-variant card treatments read off Public
 * Worship's real newsletter.
 *
 * ── Why it is its own module ───────────────────────────────────────────────
 * There are now TWO renderers of an `EmailDocument`:
 *
 *   1. `emailRender.ts` — the send-ready HTML a mail client shows.
 *   2. the designer's CANVAS (`apps/mobile/components/campaign/designer/canvas/`)
 *      — real React Native views the designer edits directly.
 *
 * That is the tax any WYSIWYG editor pays, and the failure mode is drift: the
 * canvas says one thing, the inbox shows another, and the designer stops
 * trusting the editor. (PR #460 was pure fidelity tuning against her actual
 * newsletter — an earlier rebuild was rejected as "nothing like this".) So the
 * numbers live HERE, once, and both renderers interpolate them. A change to a
 * padding is a one-line edit that moves both surfaces together; there is no
 * second copy to forget.
 *
 * Everything is plain data with zero dependencies beyond the block/theme
 * types, so it runs unchanged in Convex's V8 runtime, vitest, jest and Expo.
 */
import type { EmailButtonVariant, EmailCardVariant } from "./emailBlocks";
import type { EmailTheme } from "./emailTheme";

/**
 * Per-variant card geometry, read off the real newsletter rather than
 * invented. The theme supplies every COLOUR; this supplies the SHAPE — fill
 * ROLE (a token name, never a hex), padding, type scale, alignment and CTA
 * treatment — which is what actually distinguishes the four cards.
 *
 * `fill` and `bodyColor` are token ROLES, resolved against a theme by
 * {@link emailCardFill} / {@link emailCardTextColor}. That indirection is what
 * keeps the theme-level-only colour rule (`emailTheme.ts`) intact: a card
 * names the role it plays, never a colour.
 */
export type EmailCardSpec = {
  fill: "accent" | "cream" | "surface" | "contrast" | "none";
  bordered: boolean;
  padY: number;
  padX: number;
  headingSize: number;
  headingLine: number;
  bodyColor: "ink" | "accentInk" | "contrastInk";
  align: "left" | "center";
  cta: EmailButtonVariant;
  ctaAlign: "left" | "center";
  ctaMaxWidth: number | null;
};

export const EMAIL_CARD_SPECS: Record<EmailCardVariant, EmailCardSpec> = {
  // Big maroon opener: image over a tight 38px headline, centred, near-black
  // pill. line-height 0.9 rather than the source's 0.6 — 0.6 clips descenders
  // on any headline that wraps, which the source avoids only by hand-breaking
  // every line, and a template can't rely on the author doing that.
  hero: {
    fill: "accent", bordered: false, padY: 42, padX: 20,
    headingSize: 38, headingLine: 0.9, bodyColor: "accentInk",
    align: "center", cta: "filled", ctaAlign: "center", ctaMaxWidth: 242,
  },
  feature: {
    fill: "cream", bordered: false, padY: 26, padX: 26,
    headingSize: 27, headingLine: 1, bodyColor: "ink",
    align: "left", cta: "filled", ctaAlign: "left", ctaMaxWidth: 190,
  },
  outlined: {
    fill: "surface", bordered: true, padY: 26, padX: 26,
    headingSize: 21, headingLine: 1.06, bodyColor: "ink",
    align: "left", cta: "outline", ctaAlign: "left", ctaMaxWidth: 140,
  },
  testimonial: {
    fill: "contrast", bordered: false, padY: 28, padX: 28,
    headingSize: 21, headingLine: 1.06, bodyColor: "contrastInk",
    align: "center", cta: "filled", ctaAlign: "center", ctaMaxWidth: null,
  },
  // The pre-variant behaviour, kept so a document written before variants
  // existed renders exactly as it did.
  plain: {
    fill: "none", bordered: false, padY: 0, padX: 0,
    headingSize: 20, headingLine: 1.3, bodyColor: "ink",
    align: "left", cta: "filled", ctaAlign: "left", ctaMaxWidth: null,
  },
};

/** Resolve a card spec's fill ROLE against a theme. `null` is "no fill" —
 *  the plain card, which paints nothing behind its content. */
export function emailCardFill(spec: EmailCardSpec, t: EmailTheme): string | null {
  switch (spec.fill) {
    case "accent": return t.accent;
    case "cream": return t.cream;
    case "surface": return t.surface;
    case "contrast": return t.contrast;
    default: return null;
  }
}

/** Resolve a card spec's text-colour ROLE against a theme. */
export function emailCardTextColor(spec: EmailCardSpec, t: EmailTheme): string {
  return spec.bodyColor === "accentInk"
    ? t.accentInk
    : spec.bodyColor === "contrastInk"
      ? t.contrastInk
      : t.ink;
}

/** Spacer heights, by the size the block names. */
export const EMAIL_SPACER_HEIGHTS: Record<"sm" | "md" | "lg", number> = {
  sm: 12,
  md: 24,
  lg: 40,
};

/**
 * Bounds and default for a card's image column (`imageWidthPct`).
 *
 * The newsletter's own rows are deliberately asymmetric (44/56, 52/48);
 * forcing 50/50 is one of the specific things that made the first rebuild read
 * as generic. `validateCardContent` enforces the same 20-80 range at the write
 * gate — `apps/mobile/lib/emailDesigner.ts` mirrors it for the editor controls
 * and pins both against the real validator in its tests.
 */
export const EMAIL_IMAGE_WIDTH_PCT = { min: 20, max: 80, default: 45 } as const;

/** The gap column between a card's image and its text, as a percentage. */
export const EMAIL_CARD_IMAGE_GAP_PCT = 4;

/**
 * Everything else the two renderers both need, grouped by what it paints.
 *
 * Only NUMBERS live here (px, unitless line-heights, percentages). Colours,
 * fonts and the corner radius come from the theme; letter-spacing likewise
 * (`headingTracking`/`bodyTracking`), because it is a brand decision rather
 * than geometry.
 *
 * `marginBottom` values are the block's own trailing gap in the flowed
 * document — the HTML renderer emits them as `margin:0 0 Npx`, the canvas as
 * a `marginBottom`.
 */
export const EMAIL_GEOMETRY = {
  /** The container: a 600px card centred on the page, with the standard
   *  gutter every block except an edge-to-edge banner sits inside. */
  container: { width: 600, gutterX: 24 },
  /** The small all-caps strip above the container (theme `wordmark`). */
  wordmark: { size: 12, padTop: 18, padX: 24, padBottom: 6 },
  /** Standalone `heading` blocks. Card headings use their variant's spec. */
  heading: { level1Size: 28, level2Size: 20, line: 1.2, marginBottom: 12 },
  /** Body copy — the markdown subset's paragraphs and lists. */
  body: { size: 16, line: 1.35, marginBottom: 12, listIndent: 20 },
  /** The `image` block. `half` is 50% of the container's content width. */
  image: { marginBottom: 16, halfPct: 50 },
  /** Every button, standalone or a card's CTA.
   *
   *  `defaultAlign` is what a standalone `button` block with no `align` of its
   *  own actually SENDS (`emailRender.ts#renderButtonBlock`'s
   *  `safeAlign(block.align, …)`), and `defaultBlockFor("button")` sets no
   *  align — so it is the alignment of every freshly added button. It lives
   *  here because the canvas and the inspector each have to answer the same
   *  question, and a third and fourth hardcoded copy is exactly how the canvas
   *  came to draw a new button left while the inbox centred it. A card's CTA
   *  is NOT this: it takes its variant's `ctaAlign` from `EMAIL_CARD_SPECS`. */
  button: {
    size: 15, padY: 11, padX: 22, radius: 999, borderWidth: 1, marginBottom: 16,
    defaultAlign: "center",
  },
  /** The `eyebrow` block (the card's own eyebrow line is `card.eyebrow`). */
  eyebrow: { size: 12, marginBottom: 10 },
  /** `divider` — an in-flow rule with generous air either side. */
  divider: { borderWidth: 1, marginY: 20 },
  /** `hairline` — the thin section rule, tighter than a divider. */
  hairline: { height: 1, marginTop: 8, marginBottom: 16 },
  /** The interior of a card / one column, on top of its variant's spec. */
  card: {
    /** How much the image's corners are softened relative to the theme
     *  radius — a full-radius image inside a radiused card reads as a bubble. */
    imageRadiusInset: 8,
    imageMarginBottom: 16,
    eyebrowSize: 12,
    eyebrowMarginBottom: 8,
    headingMarginBottom: 12,
    bodySize: 16,
    /** The testimonial's quote is set larger and italic. */
    testimonialBodySize: 20,
    bodyLine: 1.35,
    bodyMarginBottom: 14,
    attributionSize: 13,
    attributionMarginBottom: 14,
    ctaMarginTop: 2,
    /** The neutral tile a card draws where its artwork will go, so a card that
     *  DECLARES a side-by-side layout keeps that geometry before the image is
     *  attached. */
    placeholder: { padY: 34, padX: 10, size: 11 },
    plainMarginBottom: 20,
    marginBottom: 16,
  },
  /** The `columns` row. */
  columns: { gutter: 14, marginBottom: 16 },
  /** The `quote` block. */
  quote: {
    barWidth: 3,
    padLeft: 18,
    padY: 4,
    textSize: 20,
    textLine: 1.35,
    attributionSize: 13,
    attributionMarginTop: 10,
    marginBottom: 20,
  },
  /** The `poll` block. */
  poll: {
    questionSize: 18,
    questionLine: 1.35,
    questionMarginBottom: 12,
    optionSize: 14,
    optionPadY: 11,
    optionPadX: 16,
    optionRadius: 999,
    optionBorderWidth: 1,
    optionMarginBottom: 8,
    marginBottom: 20,
  },
  /** The `bleed_image` banner and its unfilled placeholder band. */
  bleedImage: { placeholderPadY: 22, placeholderPadX: 16, placeholderSize: 12, radiusInset: 12 },
  /** The `footer` card. */
  footer: {
    padY: 26,
    padX: 24,
    marginBottom: 8,
    logoMaxWidth: 210,
    logoMarginBottom: 14,
    navSize: 17,
    navMarginBottom: 12,
    linksSize: 13,
    linksMarginBottom: 12,
    legalSize: 12,
    legalLine: 1.6,
  },
  /** The unsubscribe row the renderer appends when the document has no
   *  `footer` block of its own. */
  fallbackFooter: { padTop: 8, padX: 24, padBottom: 24, size: 12, line: 1.6 },
  /** Letter-spacing that is GEOMETRY rather than brand: the all-caps micro
   *  labels, whose tracking is what makes them legible at 11-12px. */
  tracking: { eyebrow: "0.1em", placeholder: "0.08em", wordmark: "0.12em", quoteAttribution: "0.04em" },
} as const;

/** Clamp a card's image-column width into the range the write gate accepts. */
export function clampEmailImageWidthPct(pct: number | undefined): number {
  const value = pct ?? EMAIL_IMAGE_WIDTH_PCT.default;
  if (!Number.isFinite(value)) return EMAIL_IMAGE_WIDTH_PCT.default;
  return Math.min(
    EMAIL_IMAGE_WIDTH_PCT.max,
    Math.max(EMAIL_IMAGE_WIDTH_PCT.min, value),
  );
}
