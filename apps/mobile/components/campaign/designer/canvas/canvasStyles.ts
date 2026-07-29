/**
 * CANVAS GEOMETRY — `EMAIL_GEOMETRY` + an `EmailTheme`, projected into React
 * Native styles.
 *
 * The designer's canvas draws real RN views at the email's own 600px scale, so
 * that clicking a heading selects THE HEADING rather than a form field labelled
 * "Heading text". That makes it a second renderer of the same document, and
 * the failure mode of any second renderer is drift — the canvas says one thing
 * and the inbox shows another.
 *
 * So NOTHING here invents a number. Every padding, size and line-height is
 * read from `@events-os/shared`'s `EMAIL_GEOMETRY` / `EMAIL_CARD_SPECS`, which
 * `emailRender.ts` reads too (see `packages/shared/src/emailGeometry.ts`). A
 * fidelity fix is one edit there and both surfaces move together. If you find
 * yourself typing a px value into this file, it belongs in that table instead.
 *
 * Pure and React-free — `import type` for RN's style types is fully erased —
 * so it runs under this package's node-environment jest, where importing
 * `react-native` for real would fail. Same reason `targetingText.ts` and
 * `lib/emailDesigner.ts` are plain `.ts` modules.
 */
import type { TextStyle, ViewStyle } from "react-native";
import {
  DEFAULT_EMAIL_THEME,
  EMAIL_CARD_IMAGE_GAP_PCT,
  EMAIL_CARD_SPECS,
  EMAIL_GEOMETRY as G,
  EMAIL_SPACER_HEIGHTS,
  clampEmailImageWidthPct,
  emailCardFill,
  emailCardTextColor,
  normalizeEmailTheme,
  type EmailBlock,
  type EmailCardContent,
  type EmailCardSpec,
  type EmailCardVariant,
  type EmailDocument,
  type EmailTheme,
} from "@events-os/shared";

/** The width the document is laid out at, always — the canvas SCALES rather
 *  than reflows, so what you edit is the geometry that will send. */
export const CANVAS_WIDTH = G.container.width;

/**
 * How much to shrink the 600px document to fit `availableWidth`.
 *
 * Never above 1: a 900px-wide editor column shows the email at its true size
 * rather than a blown-up one, because 600px IS the design. Below 600 it scales
 * down proportionally, so the LAYOUT a phone shows is still the layout an
 * inbox will show — reflowing to the phone's width instead would quietly make
 * the canvas a different document from the email.
 */
export function canvasScale(availableWidth: number): number {
  if (!Number.isFinite(availableWidth) || availableWidth <= 0) return 1;
  return Math.min(1, availableWidth / CANVAS_WIDTH);
}

/**
 * `transformOrigin`, in the form the CURRENT PLATFORM actually accepts.
 *
 * RN Web takes the CSS string. Native takes a THREE-element `[x, y, z]` tuple
 * and `processTransformOrigin` asserts `length === 3` under `__DEV__` — a
 * two-element tuple is an immediate red screen on a dev client, which is
 * exactly what a `[0, 0] as unknown as string` cast bought us here before.
 *
 * The tuples are what `processTransformOrigin` itself derives from the
 * equivalent CSS strings, percentages included: `["100%", 0, 0]` is the
 * block's RIGHT edge, whereas the bare number `1` would be one PIXEL from its
 * left — a counter-scaled badge anchored 1px from the wrong edge, and nothing
 * on web to notice it by. `canvasStyles.test.ts` pins both against the real
 * RN implementation.
 */
export type CanvasCorner = "top-left" | "top-right";

export function transformOrigin(
  corner: CanvasCorner,
  isWeb: boolean,
): string | (string | number)[] {
  if (corner === "top-right") return isWeb ? "100% 0" : ["100%", 0, 0];
  return isWeb ? "0 0" : [0, 0, 0];
}

/** The document's theme, normalized exactly as the HTML renderer normalizes
 *  it — at the edge, once, so everything downstream can assume every token. */
export function canvasTheme(doc: EmailDocument | undefined): EmailTheme {
  return doc?.theme ? normalizeEmailTheme(doc.theme) : DEFAULT_EMAIL_THEME;
}

/**
 * A CSS font STACK ("Inter,-apple-system,…") is what the theme carries,
 * because that is what a mail client needs. RN Web passes it straight through
 * to CSS and picks the first available family; native takes a single family
 * name and has none of these installed, so it gets `undefined` (the system
 * face, which is what the stack's own fallbacks resolve to there anyway).
 */
export function canvasFontFamily(stack: string, isWeb: boolean): string | undefined {
  return isWeb ? stack : undefined;
}

/**
 * The theme's letter-spacing is authored in `em` (a brand decision that has to
 * scale with the type); RN wants absolute px. `-0.04em` at 38px is -1.52px.
 * An unparseable value contributes nothing rather than NaN — a NaN
 * letterSpacing blanks the whole text run on native.
 */
export function trackingPx(tracking: string, fontSize: number): number {
  const match = /^(-?\d*\.?\d+)em$/.exec(tracking.trim());
  if (!match) return 0;
  const em = Number(match[1]);
  return Number.isFinite(em) ? em * fontSize : 0;
}

/** RN needs an absolute line-height; the geometry table carries the unitless
 *  CSS ratio. */
function linePx(fontSize: number, ratio: number): number {
  return Math.round(fontSize * ratio * 100) / 100;
}

// ── Document furniture ─────────────────────────────────────────────────────

/** The page behind the container — the mail client's viewport background. */
export function pageStyle(t: EmailTheme): ViewStyle {
  return { backgroundColor: t.canvas };
}

/** The 600px container every block sits in. */
export function containerStyle(t: EmailTheme): ViewStyle {
  return { width: CANVAS_WIDTH, backgroundColor: t.surface };
}

/**
 * A block's horizontal inset. Mirrors `emailRender.ts#blockPadding`: an
 * edge-to-edge banner bleeds, an unfilled or explicitly inset one does not.
 */
export function blockGutter(block: EmailBlock): number {
  if (block.kind !== "bleed_image") return G.container.gutterX;
  return block.inset || !block.url ? G.container.gutterX : 0;
}

export function wordmarkStyle(t: EmailTheme, isWeb: boolean): TextStyle {
  return {
    fontFamily: canvasFontFamily(t.bodyFont, isWeb),
    fontSize: G.wordmark.size,
    fontWeight: "700",
    letterSpacing: trackingPx(G.tracking.wordmark, G.wordmark.size),
    textTransform: "uppercase",
    color: t.accent,
    textAlign: "center",
  };
}

export const WORDMARK_PADDING = {
  paddingTop: G.wordmark.padTop,
  paddingHorizontal: G.wordmark.padX,
  paddingBottom: G.wordmark.padBottom,
} as const;

// ── Standalone blocks ──────────────────────────────────────────────────────

export function headingStyle(t: EmailTheme, level: 1 | 2, isWeb: boolean): TextStyle {
  const size = level === 2 ? G.heading.level2Size : G.heading.level1Size;
  return {
    fontFamily: canvasFontFamily(t.headingFont, isWeb),
    fontSize: size,
    lineHeight: linePx(size, G.heading.line),
    letterSpacing: trackingPx(t.headingTracking, size),
    fontWeight: "700",
    color: t.ink,
    marginBottom: G.heading.marginBottom,
  };
}

/** Body copy — the markdown subset's paragraphs and list items. `color`
 *  overrides the default `muted` for card interiors, matching the HTML
 *  renderer's own `color` argument to `markdownSubsetToHtml`. */
export function bodyTextStyle(
  t: EmailTheme,
  isWeb: boolean,
  color?: string,
  size: number = G.body.size,
  line: number = G.body.line,
): TextStyle {
  return {
    fontFamily: canvasFontFamily(t.bodyFont, isWeb),
    fontSize: size,
    lineHeight: linePx(size, line),
    letterSpacing: trackingPx(t.bodyTracking, size),
    color: color ?? t.muted,
  };
}

export const BODY_PARAGRAPH_SPACING = G.body.marginBottom;
export const BODY_LIST_INDENT = G.body.listIndent;

/**
 * The trailing gap under one paragraph (or list) of a body.
 *
 * Takes `isLast` and ignores it, ON PURPOSE: `emailRender.ts` stamps
 * `margin:0 0 ${G.body.marginBottom}px` onto EVERY `<p>` and `<ul>` it emits,
 * with nothing stripping it off the final child, so a canvas that zeroed the
 * last one drew every body 12px shorter than it sends. The parameter stays so
 * that the next person to think "surely the last paragraph shouldn't have a
 * margin" finds this comment instead of the renderer's inbox.
 */
export function bodyParagraphSpacing(_isLast: boolean): number {
  return BODY_PARAGRAPH_SPACING;
}

export function linkTextStyle(t: EmailTheme): TextStyle {
  return { color: t.link, textDecorationLine: "underline" };
}

export function eyebrowStyle(t: EmailTheme, isWeb: boolean): TextStyle {
  return {
    fontFamily: canvasFontFamily(t.bodyFont, isWeb),
    fontSize: G.eyebrow.size,
    fontWeight: "700",
    letterSpacing: trackingPx(G.tracking.eyebrow, G.eyebrow.size),
    textTransform: "uppercase",
    color: t.accent,
  };
}

export const EYEBROW_MARGIN_BOTTOM = G.eyebrow.marginBottom;

export function dividerStyle(t: EmailTheme): ViewStyle {
  return {
    borderTopWidth: G.divider.borderWidth,
    borderTopColor: t.border,
    marginVertical: G.divider.marginY,
  };
}

export function hairlineStyle(t: EmailTheme): ViewStyle {
  return {
    height: G.hairline.height,
    backgroundColor: t.hairline,
    borderRadius: 999,
    marginTop: G.hairline.marginTop,
    marginBottom: G.hairline.marginBottom,
  };
}

export function spacerHeight(size: "sm" | "md" | "lg"): number {
  return EMAIL_SPACER_HEIGHTS[size] ?? EMAIL_SPACER_HEIGHTS.md;
}

export function imageStyle(t: EmailTheme, width: "full" | "half" | undefined): ViewStyle {
  return {
    width: width === "half" ? `${G.image.halfPct}%` : "100%",
    borderRadius: t.radius,
    marginBottom: G.image.marginBottom,
  };
}

// ── Buttons ────────────────────────────────────────────────────────────────

export function buttonBoxStyle(
  t: EmailTheme,
  variant: "filled" | "outline",
  maxWidth: number | null,
): ViewStyle {
  return {
    backgroundColor: variant === "outline" ? "transparent" : t.contrast,
    borderWidth: G.button.borderWidth,
    borderColor: variant === "outline" ? t.border : "transparent",
    borderRadius: G.button.radius,
    paddingVertical: G.button.padY,
    paddingHorizontal: G.button.padX,
    ...(maxWidth === null ? {} : { maxWidth, width: "100%" as const }),
  };
}

export function buttonLabelStyle(
  t: EmailTheme,
  variant: "filled" | "outline",
  isWeb: boolean,
): TextStyle {
  return {
    fontFamily: canvasFontFamily(t.bodyFont, isWeb),
    fontSize: G.button.size,
    fontWeight: "700",
    letterSpacing: trackingPx(t.bodyTracking, G.button.size),
    color: variant === "outline" ? t.ink : t.contrastInk,
    textAlign: "center",
  };
}

export const BUTTON_MARGIN_BOTTOM = G.button.marginBottom;

/** What a `button` block with no `align` of its own actually sends. Read from
 *  the geometry table rather than restated, because the canvas and the
 *  inspector both have to agree with `renderButtonBlock` — see
 *  `EMAIL_GEOMETRY.button.defaultAlign`. */
export const BUTTON_DEFAULT_ALIGN: "left" | "center" = G.button.defaultAlign;

/** The alignment a standalone button actually renders at — the author's
 *  `align` when set, otherwise the renderer's default. The canvas twin of
 *  `safeAlign(block.align, G.button.defaultAlign)`. */
export function buttonAlign(align: "left" | "center" | undefined): "left" | "center" {
  return align === "left" || align === "center" ? align : BUTTON_DEFAULT_ALIGN;
}

// ── Cards and columns ──────────────────────────────────────────────────────

/** The variant's treatment — the SAME table `emailRender.ts` paints from. */
export function cardSpecFor(variant: EmailCardVariant | undefined): EmailCardSpec {
  return EMAIL_CARD_SPECS[variant ?? "plain"] ?? EMAIL_CARD_SPECS.plain;
}

/** A card's own box. `bare` is the `columns` case, where the row supplies the
 *  trailing margin and each cell only paints its fill. */
export function cardBoxStyle(
  t: EmailTheme,
  spec: EmailCardSpec,
  opts: { bare?: boolean } = {},
): ViewStyle {
  const fill = emailCardFill(spec, t);
  const plain = spec.fill === "none" && !spec.bordered;
  const style: ViewStyle = {
    ...(fill ? { backgroundColor: fill } : null),
    ...(spec.bordered ? { borderWidth: 1, borderColor: t.border } : null),
    ...(fill || spec.bordered ? { borderRadius: t.radius } : null),
    paddingVertical: spec.padY,
    paddingHorizontal: spec.padX,
  };
  if (opts.bare) return style;
  return {
    ...style,
    marginBottom: plain ? G.card.plainMarginBottom : G.card.marginBottom,
  };
}

/** The alignment a card's content actually renders at — the author's `align`
 *  when set, otherwise the variant's own. Mirrors `safeAlign`. */
export function cardAlign(
  content: EmailCardContent,
  spec: EmailCardSpec,
): "left" | "center" {
  return content.align === "left" || content.align === "center"
    ? content.align
    : spec.align;
}

export function cardTextColorFor(spec: EmailCardSpec, t: EmailTheme): string {
  return emailCardTextColor(spec, t);
}

export function cardEyebrowStyle(
  t: EmailTheme,
  color: string,
  isWeb: boolean,
): TextStyle {
  return {
    fontFamily: canvasFontFamily(t.bodyFont, isWeb),
    fontSize: G.card.eyebrowSize,
    fontWeight: "700",
    letterSpacing: trackingPx(G.tracking.eyebrow, G.card.eyebrowSize),
    textTransform: "uppercase",
    color,
    marginBottom: G.card.eyebrowMarginBottom,
  };
}

export function cardHeadingStyle(
  t: EmailTheme,
  spec: EmailCardSpec,
  color: string,
  isWeb: boolean,
): TextStyle {
  return {
    fontFamily: canvasFontFamily(t.headingFont, isWeb),
    fontSize: spec.headingSize,
    lineHeight: linePx(spec.headingSize, spec.headingLine),
    letterSpacing: trackingPx(t.headingTracking, spec.headingSize),
    fontWeight: "700",
    color,
    marginBottom: G.card.headingMarginBottom,
  };
}

/** A card's body size depends on the variant: the testimonial's quote is set
 *  larger and italic, everything else takes the standard 16px. */
export function cardBodyStyle(
  t: EmailTheme,
  variant: EmailCardVariant | undefined,
  color: string,
  isWeb: boolean,
): TextStyle {
  const testimonial = variant === "testimonial";
  const size = testimonial ? G.card.testimonialBodySize : G.card.bodySize;
  return {
    ...bodyTextStyle(t, isWeb, color, size, G.card.bodyLine),
    ...(testimonial ? { fontStyle: "italic" as const } : null),
  };
}

export const CARD_BODY_MARGIN_BOTTOM = G.card.bodyMarginBottom;
export const CARD_IMAGE_MARGIN_BOTTOM = G.card.imageMarginBottom;
export const CARD_CTA_MARGIN_TOP = G.card.ctaMarginTop;

export function cardAttributionStyle(
  t: EmailTheme,
  color: string,
  isWeb: boolean,
): TextStyle {
  return {
    fontFamily: canvasFontFamily(t.bodyFont, isWeb),
    fontSize: G.card.attributionSize,
    fontWeight: "700",
    letterSpacing: trackingPx(t.bodyTracking, G.card.attributionSize),
    color,
    marginBottom: G.card.attributionMarginBottom,
  };
}

/** A card's image corners are softened LESS than the card's own, so the
 *  artwork doesn't read as a bubble inside a bubble. */
export function cardImageRadius(t: EmailTheme): number {
  return Math.max(0, t.radius - G.card.imageRadiusInset);
}

/** The neutral tile a card draws where its artwork will go — the same
 *  "declare the geometry before the image arrives" behaviour the HTML
 *  renderer has. */
export function cardPlaceholderStyle(t: EmailTheme): ViewStyle {
  return {
    backgroundColor: t.cream,
    borderWidth: 1,
    borderColor: t.hairline,
    borderStyle: "dashed",
    borderRadius: cardImageRadius(t),
    paddingVertical: G.card.placeholder.padY,
    paddingHorizontal: G.card.placeholder.padX,
    alignItems: "center",
  };
}

export function placeholderLabelStyle(
  t: EmailTheme,
  size: number,
  isWeb: boolean,
): TextStyle {
  return {
    fontFamily: canvasFontFamily(t.bodyFont, isWeb),
    fontSize: size,
    letterSpacing: trackingPx(G.tracking.placeholder, size),
    textTransform: "uppercase",
    color: t.muted,
    textAlign: "center",
  };
}

export const CARD_PLACEHOLDER_LABEL_SIZE = G.card.placeholder.size;

/**
 * The two-column split of a card whose image sits beside its text, as
 * fractions of the card's interior. The gap column is the renderer's own
 * `EMAIL_CARD_IMAGE_GAP_PCT`, taken out of the TEXT side exactly as the HTML
 * does (`width:${textPct - gapPct}%`).
 */
export function cardColumnSplit(content: EmailCardContent): {
  imagePct: number;
  gapPct: number;
  textPct: number;
} {
  const imagePct = clampEmailImageWidthPct(content.imageWidthPct);
  const gapPct = EMAIL_CARD_IMAGE_GAP_PCT;
  return { imagePct, gapPct, textPct: 100 - imagePct - gapPct };
}

export const COLUMNS_GUTTER = G.columns.gutter;
export const COLUMNS_MARGIN_BOTTOM = G.columns.marginBottom;

// ── Quote ──────────────────────────────────────────────────────────────────

export function quoteBoxStyle(t: EmailTheme): ViewStyle {
  return {
    borderLeftWidth: G.quote.barWidth,
    borderLeftColor: t.accent,
    paddingLeft: G.quote.padLeft,
    paddingVertical: G.quote.padY,
    marginBottom: G.quote.marginBottom,
  };
}

export function quoteTextStyle(t: EmailTheme, isWeb: boolean): TextStyle {
  return {
    fontFamily: canvasFontFamily(t.headingFont, isWeb),
    fontSize: G.quote.textSize,
    lineHeight: linePx(G.quote.textSize, G.quote.textLine),
    letterSpacing: trackingPx(t.bodyTracking, G.quote.textSize),
    fontStyle: "italic",
    color: t.ink,
  };
}

/**
 * The em dash the RENDERER puts in front of a quote's attribution
 * (`emailRender.ts#renderQuoteBlock` emits `— ${attribution}`).
 *
 * A string rather than a number, so it can't live in `EMAIL_GEOMETRY` — but it
 * is drift of exactly the same kind, so `canvasStyles.test.ts` pins it against
 * the real rendered HTML. The canvas draws it and the field edits the bare
 * name: showing a dash in the PLACEHOLDER instead is what got one typed into
 * the value, sending "— — Ada".
 */
export const QUOTE_ATTRIBUTION_PREFIX = "— ";

export function quoteAttributionStyle(t: EmailTheme, isWeb: boolean): TextStyle {
  return {
    fontFamily: canvasFontFamily(t.bodyFont, isWeb),
    fontSize: G.quote.attributionSize,
    fontWeight: "600",
    letterSpacing: trackingPx(G.tracking.quoteAttribution, G.quote.attributionSize),
    color: t.muted,
    marginTop: G.quote.attributionMarginTop,
  };
}

// ── Poll ───────────────────────────────────────────────────────────────────

export function pollQuestionStyle(t: EmailTheme, isWeb: boolean): TextStyle {
  return {
    fontFamily: canvasFontFamily(t.headingFont, isWeb),
    fontSize: G.poll.questionSize,
    lineHeight: linePx(G.poll.questionSize, G.poll.questionLine),
    fontWeight: "700",
    color: t.ink,
    marginBottom: G.poll.questionMarginBottom,
  };
}

export function pollOptionBoxStyle(t: EmailTheme): ViewStyle {
  return {
    borderWidth: G.poll.optionBorderWidth,
    borderColor: t.border,
    borderRadius: G.poll.optionRadius,
    paddingVertical: G.poll.optionPadY,
    paddingHorizontal: G.poll.optionPadX,
    marginBottom: G.poll.optionMarginBottom,
  };
}

export function pollOptionLabelStyle(t: EmailTheme, isWeb: boolean): TextStyle {
  return {
    fontFamily: canvasFontFamily(t.bodyFont, isWeb),
    fontSize: G.poll.optionSize,
    fontWeight: "600",
    color: t.ink,
    textAlign: "center",
  };
}

export const POLL_MARGIN_BOTTOM = G.poll.marginBottom;

// ── Banner ─────────────────────────────────────────────────────────────────

export function bleedPlaceholderStyle(t: EmailTheme): ViewStyle {
  return {
    backgroundColor: t.cream,
    borderWidth: 1,
    borderColor: t.hairline,
    borderStyle: "dashed",
    borderRadius: Math.max(0, t.radius - G.bleedImage.radiusInset),
    paddingVertical: G.bleedImage.placeholderPadY,
    paddingHorizontal: G.bleedImage.placeholderPadX,
    alignItems: "center",
  };
}

export const BLEED_PLACEHOLDER_LABEL_SIZE = G.bleedImage.placeholderSize;

// ── Footer ─────────────────────────────────────────────────────────────────

export function footerBoxStyle(t: EmailTheme): ViewStyle {
  return {
    backgroundColor: t.cream,
    borderRadius: t.radius,
    paddingVertical: G.footer.padY,
    paddingHorizontal: G.footer.padX,
    marginBottom: G.footer.marginBottom,
  };
}

export function footerNavStyle(t: EmailTheme, isWeb: boolean): TextStyle {
  return {
    fontFamily: canvasFontFamily(t.bodyFont, isWeb),
    fontSize: G.footer.navSize,
    fontWeight: "700",
    letterSpacing: trackingPx(t.bodyTracking, G.footer.navSize),
    color: t.ink,
    textAlign: "center",
    marginBottom: G.footer.navMarginBottom,
  };
}

export function footerLinksStyle(t: EmailTheme, isWeb: boolean): TextStyle {
  return {
    fontFamily: canvasFontFamily(t.bodyFont, isWeb),
    fontSize: G.footer.linksSize,
    color: t.muted,
    textAlign: "center",
    marginBottom: G.footer.linksMarginBottom,
  };
}

/**
 * What the RENDERER puts between two footer links: a muted `" | "`, ONE space
 * each side (`renderFooterBlock` joins its anchors with
 * `<span style="color:…"> | </span>`).
 *
 * A string rather than a number, so — like `QUOTE_ATTRIBUTION_PREFIX` — it
 * can't live in `EMAIL_GEOMETRY`, and `canvasStyles.test.ts` pins it against
 * the real rendered HTML instead. The canvas used two spaces each side and
 * drew the labels muted and un-underlined, which turned a row of links into
 * what looked like a caption; the links themselves take `linkTextStyle`.
 */
export const FOOTER_LINK_SEPARATOR = " | ";

export function footerLegalStyle(t: EmailTheme, isWeb: boolean): TextStyle {
  return {
    fontFamily: canvasFontFamily(t.bodyFont, isWeb),
    fontSize: G.footer.legalSize,
    lineHeight: linePx(G.footer.legalSize, G.footer.legalLine),
    color: t.muted,
    textAlign: "center",
  };
}

export const FOOTER_LOGO = {
  maxWidth: G.footer.logoMaxWidth,
  marginBottom: G.footer.logoMarginBottom,
} as const;

// ── The fallback footer ────────────────────────────────────────────────────
//
// The unsubscribe row `renderCampaignEmail` appends when the document carries
// no `footer` block of its own. It is renderer furniture with nothing to edit,
// but it is part of the email's real height, so the canvas draws it — from
// `G.fallbackFooter`, which is its OWN entry in the geometry table. It happens
// to coincide with `G.footer.legalSize`/`legalLine` today; reading those
// instead would make the canvas silently wrong the first time a designer
// changed one without the other.

export const FALLBACK_FOOTER_PADDING = {
  paddingTop: G.fallbackFooter.padTop,
  paddingHorizontal: G.fallbackFooter.padX,
  paddingBottom: G.fallbackFooter.padBottom,
} as const;

export function fallbackFooterTextStyle(t: EmailTheme, isWeb: boolean): TextStyle {
  return {
    fontFamily: canvasFontFamily(t.bodyFont, isWeb),
    fontSize: G.fallbackFooter.size,
    lineHeight: linePx(G.fallbackFooter.size, G.fallbackFooter.line),
    color: t.muted,
    textAlign: "center",
  };
}
