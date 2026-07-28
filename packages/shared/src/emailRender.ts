/**
 * Renders an `EmailDocument` (see `emailBlocks.ts`) into send-ready HTML and
 * plaintext for the in-app email-campaign designer. Pure TypeScript, zero
 * react/convex deps — runs in Convex's V8 action runtime (the actual send
 * path), plain Node (vitest), and the Expo app (live preview).
 *
 * ── Theming ────────────────────────────────────────────────────────────────
 * Every colour, font, and radius comes from the document's `theme` (see
 * `emailTheme.ts`); a document without one renders on `DEFAULT_EMAIL_THEME`,
 * Public Worship's real brand. Nothing in this file hardcodes a brand value —
 * that was the previous design's central mistake, and it produced a palette
 * that had never matched the actual newsletter.
 *
 * ── Why there IS a `<style>` block now ─────────────────────────────────────
 * This file used to inline everything and emit no `<style>` at all, on the
 * reasoning that clients strip both classes and style blocks unreliably. That
 * reasoning is right about what you can DEPEND on and wrong about what you can
 * ADD. Two things are impossible to express inline — `@media` (responsive) and
 * `prefers-color-scheme` (dark mode) — and both were real defects: a fixed
 * 520px card with no breakpoints, and a cream card that a client's forced dark
 * mode inverts into mud.
 *
 * So the rule here is BOTH, layered, never either/or:
 *  - Inline styles carry the complete LIGHT rendering. A client that strips
 *    `<style>` (Gmail's classic clipped view, some corporate gateways) gets
 *    exactly what it got before this change — nothing regresses.
 *  - The `<style>` block only ever OVERRIDES, using `!important` (the one
 *    thing that outranks an inline style) and never introduces layout a
 *    stripping client would miss.
 *
 * ── Outlook ────────────────────────────────────────────────────────────────
 * The multi-column layout is a `<table>`, not flex/grid, because Outlook's
 * Word rendering engine supports neither. Columns collapse to full width via
 * a `@media` rule that Word ignores — Word gets the desktop table, which is
 * correct there since Outlook desktop is never narrow.
 */

import type {
  EmailBlock,
  EmailButtonVariant,
  EmailCardContent,
  EmailDocument,
  EmailPollOption,
} from "./emailBlocks";
import { isAllowedImageUrl, isAllowedLinkUrl } from "./emailBlocks";
// The SHAPE of every block — container width, gutters, type scale, paddings,
// and the per-variant card treatments — lives in `emailGeometry.ts`, which the
// designer's canvas renderer reads too. Two copies of these numbers would
// drift the moment either surface was tuned; see that file's header.
import {
  EMAIL_CARD_SPECS,
  EMAIL_CARD_IMAGE_GAP_PCT,
  EMAIL_GEOMETRY as G,
  EMAIL_SPACER_HEIGHTS,
  clampEmailImageWidthPct,
  emailCardFill,
  emailCardTextColor,
  type EmailCardSpec,
} from "./emailGeometry";
import type { MarkdownInlineNode } from "./emailMarkdown";
import { parseInlineMarkdown, parseMarkdownSubset } from "./emailMarkdown";
import type { EmailTheme, EmailThemeTokens } from "./emailTheme";
import { DEFAULT_EMAIL_THEME, normalizeEmailTheme, resolveDarkTheme } from "./emailTheme";
import { firstNameOf } from "./names";

export type CampaignRecipient = { name?: string | null; email: string };

export type RenderEmailOptions = {
  /** Hidden preheader text (the snippet inbox lists show after the subject). */
  subjectPreview?: string;
  recipient: CampaignRecipient;
  /** The per-recipient `/unsubscribe/<token>` URL. Sanitized at render like
   *  every other href in this file, via `safeUnsubscribeHref` (see there for
   *  why it is not plain `safeEmailHref`): it is built from `siteUrl()` at
   *  every call site today, but "the caller built it safely" is not a property
   *  this layer can verify, and it was the one href here that skipped the
   *  scheme check entirely. */
  unsubscribeUrl: string;
  orgAddress?: string | null;
  /**
   * Builds the per-recipient vote URL for one poll option. Absent in the
   * composer preview and in `sendTest`, where there's no recipient token to
   * key a vote to — poll options then render as inert, unclickable pills
   * rather than as links to a URL that would 404.
   */
  pollVoteUrl?: (blockId: string, optionId: string) => string;
};

/** HTML-escape untrusted strings for element content / attributes — same
 *  five-entity table as `apps/convex/lib/landingPage.ts`'s `esc()`. */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ── URL sanitization (SECURITY) ──────────────────────────────────────────
// `validateEmailDocument` (emailBlocks.ts) already rejects a disallowed
// button/image URL scheme at the WRITE gate, but these are the render-time
// half of the same defense-in-depth — they cover any document written
// before that gate existed, or by a path that bypassed it (e.g. a direct DB
// write, an import script). Never trust that a stored `url` is safe just
// because it once passed validation.

/** Sanitize a URL for use as an href — http:, https:, and mailto: are the
 *  only allowed schemes (case-insensitive, trimmed); anything else (a
 *  `javascript:` XSS payload, `data:`, `vbscript:`, a malformed string)
 *  renders as an inert `#` instead of the raw value. */
export function safeEmailHref(url: string): string {
  return isAllowedLinkUrl(url) ? url.trim() : "#";
}

/** Sanitize a URL for use as an image `src` — http:/https: only. Anything
 *  else renders as an EMPTY src (no image loads) rather than a
 *  dangerous/broken one. */
export function safeImageSrc(url: string): string {
  return isAllowedImageUrl(url) ? url.trim() : "";
}

/**
 * Sanitize the UNSUBSCRIBE url — `safeEmailHref` plus root-relative paths.
 *
 * This href used to be escaped but never scheme-checked, on both of its paths
 * here and in `emailShell.ts`'s bulk footer, so `javascript:` reached it while
 * every other href in this file went through `safeEmailHref`. It cannot simply
 * BE `safeEmailHref`, though: `lib/siteUrl.ts` returns `""` when neither
 * `PUBLIC_SITE_URL` nor `CONVEX_SITE_URL` is set, so the call sites legitimately
 * produce the root-relative `/unsubscribe/<token>` — and `safeEmailHref` treats
 * a scheme-less string as unsafe. Collapsing that to `#` would delete the
 * visible opt-out CAN-SPAM requires from exactly the deployment that is already
 * misconfigured.
 *
 * So a path beginning with a single `/` is passed through, and everything else
 * must clear the normal scheme allowlist. The single-slash rule matters: `//`
 * (and `/\`, which several URL parsers fold into it) is PROTOCOL-RELATIVE and
 * resolves to an attacker's host, not to a path on ours.
 */
export function safeUnsubscribeHref(url: string): string {
  const trimmed = url.trim();
  if (/^\/(?![/\\])/.test(trimmed)) return trimmed;
  return safeEmailHref(trimmed);
}

/**
 * Clamp an authored `align` to the two values the design has (SECURITY).
 *
 * `content.align` was the one authored string this file interpolated into a
 * `style="…"` attribute raw — every sibling is escaped (`esc(...)`), clamped
 * (`imageWidthPct`), or used as a lookup key into a table (`variant`,
 * `imageSide`, `ctaStyle`). Raw meant an align of
 * `left" onmouseover="alert(1)` closed the attribute and added an event
 * handler to the `<h3>`; the same string reached the eyebrow, body and
 * attribution rows, and `columns[].align` through the same function.
 *
 * `validateCardContent` restricts `align` at every write today, so this is
 * not reachable through the product — but that is exactly the guarantee the
 * header above says this layer may not rely on. VALIDATING beats escaping
 * here: `align` is an enum, not free-form text, so an unknown value should
 * fall back to the variant's own default rather than render as a quoted
 * nonsense CSS value.
 */
function safeAlign(value: unknown, fallback: "left" | "center"): "left" | "center" {
  return value === "left" || value === "center" ? value : fallback;
}

// ── Merge tags ────────────────────────────────────────────────────────────
// `{{tag}}` or `{{tag|fallback}}`. Supported tags: firstName, name (see
// `MERGE_TAGS` in emailBlocks.ts). Unrecognized tags, or a recognized tag
// with no resolvable value, fall back to the author's `|fallback` text (if
// given) or the word "friend".
//
// The fallback group allows a single `}` as long as it isn't immediately
// followed by another `}` (`\}(?!\})`, a lookahead — no lookbehind needed, so
// this stays safe on Hermes/React Native's regex engine) — a plain `[^}]*`
// can't match a fallback that itself contains a literal `}`, e.g.
// `{{firstName|Hi}there}}`, and would leave the raw tag un-substituted in
// the sent email.
const MERGE_TAG_RE = /\{\{\s*(\w+)(?:\|((?:[^}]|\}(?!\}))*))?\s*\}\}/g;

function resolveMergeTagValue(
  tag: string,
  recipient: CampaignRecipient,
): string | null {
  if (tag === "firstName") {
    return recipient.name?.trim() ? firstNameOf(recipient.name) : null;
  }
  if (tag === "name") {
    return recipient.name?.trim() ? recipient.name.trim() : null;
  }
  return null;
}

/**
 * Substitute merge tags into `escapedText` — text that has ALREADY been run
 * through `esc()`. `{{`, `}}`, and `|` all survive HTML-escaping untouched,
 * so this is safe to run as a second pass over already-escaped text. The
 * RESOLVED value is escaped here, not earlier — the only way a recipient's
 * name (arbitrary user data) reaches the output, so this is the one place an
 * XSS attempt (e.g. a guest named `<script>alert(1)</script>`) must be
 * neutralized. An author's literal `|fallback` text was already escaped in
 * the first pass, so it's used as-is.
 */
function substituteMergeTagsHtml(
  escapedText: string,
  recipient: CampaignRecipient,
): string {
  return escapedText.replace(MERGE_TAG_RE, (_match, tag: string, fallback?: string) => {
    const resolved = resolveMergeTagValue(tag, recipient);
    if (resolved !== null) return esc(resolved);
    if (fallback !== undefined) return fallback.trim();
    return "friend";
  });
}

/** Plaintext counterpart: no escaping (there's no markup to inject into). */
function substituteMergeTagsPlain(text: string, recipient: CampaignRecipient): string {
  return text.replace(MERGE_TAG_RE, (_match, tag: string, fallback?: string) => {
    const resolved = resolveMergeTagValue(tag, recipient);
    if (resolved !== null) return resolved;
    if (fallback !== undefined) return fallback.trim();
    return "friend";
  });
}

// ── Markdown subset (text blocks) ────────────────────────────────────────
// **bold**, *italic*, [text](url), blank-line-separated paragraphs, "- "
// list lines. The PARSE lives in `emailMarkdown.ts` (shared with the
// designer's canvas renderer, so the two can't disagree about what is bold);
// this file only walks the resulting tree into HTML.
//
// It walks text that's already HTML-escaped, so it only ever wraps existing
// (safe) text in tags — it never needs to escape anything itself.

function inlineMarkdownHtml(nodes: MarkdownInlineNode[], t: EmailTheme): string {
  return nodes
    .map((node) => {
      switch (node.kind) {
        case "text":
          return node.text;
        case "strong":
          return `<strong>${inlineMarkdownHtml(node.children, t)}</strong>`;
        case "em":
          return `<em>${inlineMarkdownHtml(node.children, t)}</em>`;
        case "link":
          return `<a class="${CLS.link}" href="${safeEmailHref(node.href)}" style="color:${t.link};text-decoration:underline">${inlineMarkdownHtml(node.children, t)}</a>`;
      }
    })
    .join("");
}

// ── Class names ───────────────────────────────────────────────────────────
// The ONLY purpose of these is to give the `<style>` block something to
// override for dark mode and responsive breakpoints. Every element carrying
// one also carries the complete inline light style — see the module doc.
const CLS = {
  wrap: "pw-wrap",
  card: "pw-card",
  heading: "pw-h",
  h1: "pw-h1",
  text: "pw-t",
  link: "pw-a",
  button: "pw-btn",
  mark: "pw-mark",
  eyebrow: "pw-eyebrow",
  rule: "pw-hr",
  quote: "pw-quote",
  // The quote's text carries its OWN class rather than being targeted as
  // `.pw-quote div`: that descendant selector (specificity 0,1,1) also matched
  // the attribution div and outranked `.pw-quote-attr` (0,1,0), so the
  // attribution silently rendered at full `ink` in dark mode instead of
  // `muted`, losing its de-emphasis.
  quoteText: "pw-quote-text",
  quoteAttr: "pw-quote-attr",
  foot: "pw-foot",
  col: "pw-col",
  colGap: "pw-col-gap",
  colWrap: "pw-col-wrap",
  cardPlain: "pw-card-plain",
  cardHero: "pw-card-hero",
  cardFeature: "pw-card-feature",
  cardOutlined: "pw-card-outlined",
  cardTestimonial: "pw-card-testimonial",
  pollOpt: "pw-poll-opt",
} as const;

function textStyle(t: EmailTheme): string {
  return `margin:0 0 ${G.body.marginBottom}px;font-family:${t.bodyFont};font-size:${G.body.size}px;line-height:${G.body.line};letter-spacing:${t.bodyTracking};color:${t.muted}`;
}

function listStyle(t: EmailTheme): string {
  return `margin:0 0 ${G.body.marginBottom}px;padding-left:${G.body.listIndent}px;font-family:${t.bodyFont};font-size:${G.body.size}px;line-height:${G.body.line};letter-spacing:${t.bodyTracking};color:${t.muted}`;
}

function markdownSubsetToHtml(
  escapedMarkdown: string,
  t: EmailTheme,
  color?: string,
): string {
  const paraStyle = color ? `${textStyle(t)};color:${color}` : textStyle(t);
  return parseMarkdownSubset(escapedMarkdown)
    .map((block) => {
      if (block.kind === "paragraph") {
        return `<p class="${CLS.text}" style="${paraStyle}">${inlineMarkdownHtml(block.content, t)}</p>`;
      }
      const items = block.items
        .map((item) => `<li>${inlineMarkdownHtml(item, t)}</li>`)
        .join("");
      return `<ul class="${CLS.text}" style="${listStyle(t)}">${items}</ul>`;
    })
    .join("");
}

// ── Block → HTML ──────────────────────────────────────────────────────────

function renderHeadingBlock(
  block: Extract<EmailBlock, { kind: "heading" }>,
  recipient: CampaignRecipient,
  t: EmailTheme,
): string {
  const level = block.level ?? 1;
  const size = level === 2 ? G.heading.level2Size : G.heading.level1Size;
  const cls = level === 2 ? CLS.heading : `${CLS.heading} ${CLS.h1}`;
  const text = substituteMergeTagsHtml(esc(block.text), recipient);
  // `letter-spacing` is NOT optional here. Card headings get
  // `headingTracking`, so a standalone heading block without it renders
  // visibly looser than every card around it in the same email — the kind of
  // inconsistency that reads as sloppiness rather than as a bug.
  return `<h${level} class="${cls}" style="margin:0 0 ${G.heading.marginBottom}px;font-size:${size}px;line-height:${G.heading.line};letter-spacing:${t.headingTracking};color:${t.ink};font-family:${t.headingFont};font-weight:700">${text}</h${level}>`;
}

function renderTextBlock(
  block: Extract<EmailBlock, { kind: "text" }>,
  recipient: CampaignRecipient,
  t: EmailTheme,
): string {
  const substituted = substituteMergeTagsHtml(esc(block.markdown), recipient);
  return markdownSubsetToHtml(substituted, t);
}

function renderImageBlock(
  block: Extract<EmailBlock, { kind: "image" }>,
  t: EmailTheme,
): string {
  const width = block.width === "half" ? `${G.image.halfPct}%` : "100%";
  const img = `<img src="${esc(safeImageSrc(block.url))}" alt="${esc(block.alt)}" style="display:block;width:${width};max-width:100%;border:0;border-radius:${t.radius}px;margin:0 0 ${G.image.marginBottom}px" />`;
  if (!block.href) return img;
  return `<a href="${esc(safeEmailHref(block.href))}" style="display:block;text-decoration:none">${img}</a>`;
}

// Per-variant card geometry. Aliased rather than re-declared so every
// reference below reads as it always did while there is only ONE table (see
// the import block, and `emailGeometry.ts`'s header for why).
type CardSpec = EmailCardSpec;
const CARD_SPECS = EMAIL_CARD_SPECS;
const cardFill = emailCardFill;
const cardTextColor = emailCardTextColor;

function renderButtonHtml(
  label: string,
  url: string,
  t: EmailTheme,
  variant: EmailButtonVariant = "filled",
  maxWidth: number | null = null,
): string {
  // Outline is transparent with a 1px rule and ink-coloured text; filled is
  // the near-black pill. The newsletter uses both and picking one made every
  // CTA look identical.
  const bg = variant === "outline" ? "transparent" : t.contrast;
  const fg = variant === "outline" ? t.ink : t.contrastInk;
  const border =
    variant === "outline"
      ? `${G.button.borderWidth}px solid ${t.border}`
      : `${G.button.borderWidth}px solid transparent`;
  const width = maxWidth ? `max-width:${maxWidth}px;width:100%;` : "";
  return `<a class="${CLS.button}" href="${esc(safeEmailHref(url))}" style="display:inline-block;box-sizing:border-box;${width}background:${bg};color:${fg};border:${border};text-decoration:none;font-family:${t.bodyFont};font-weight:700;font-size:${G.button.size}px;letter-spacing:${t.bodyTracking};padding:${G.button.padY}px ${G.button.padX}px;border-radius:${G.button.radius}px;text-align:center">${label}</a>`;
}

function renderButtonBlock(
  block: Extract<EmailBlock, { kind: "button" }>,
  recipient: CampaignRecipient,
  t: EmailTheme,
): string {
  const label = substituteMergeTagsHtml(esc(block.label), recipient);
  const align = safeAlign(block.align, "center");
  return `<div style="text-align:${align};margin:0 0 ${G.button.marginBottom}px">${renderButtonHtml(label, block.url, t, block.variant ?? "filled")}</div>`;
}

/**
 * The image half of a card.
 *
 * An empty slot returns a neutral tile rather than nothing, so a card that
 * DECLARES a side-by-side layout keeps that geometry before its artwork is
 * attached. Returning "" instead silently collapsed the built-in template to
 * a stack of text, which is how the layout stopped being visible at all.
 */
function cardImageHtml(content: EmailCardContent, t: EmailTheme): string {
  const radius = Math.max(0, t.radius - G.card.imageRadiusInset);
  if (!content.imageUrl) {
    const sideways = content.imageSide === "left" || content.imageSide === "right";
    if (!sideways) return "";
    return `<div style="background:${t.cream};border:1px dashed ${t.hairline};border-radius:${radius}px;padding:${G.card.placeholder.padY}px ${G.card.placeholder.padX}px;text-align:center;font-family:${t.bodyFont};font-size:${G.card.placeholder.size}px;letter-spacing:${G.tracking.placeholder};text-transform:uppercase;color:${t.muted}">Image</div>`;
  }
  return `<img src="${esc(safeImageSrc(content.imageUrl))}" alt="${esc(content.imageAlt ?? "")}" style="display:block;width:100%;max-width:100%;border:0;border-radius:${radius}px" />`;
}

/**
 * The text half of a card: eyebrow, heading, body, attribution, CTA — painted
 * per the variant's `CardSpec` rather than one fixed treatment.
 */
function cardTextHtml(
  content: EmailCardContent,
  spec: CardSpec,
  t: EmailTheme,
  recipient: CampaignRecipient,
): string {
  const fg = cardTextColor(spec, t);
  const align = safeAlign(content.align, spec.align);
  const parts: string[] = [];

  if (content.eyebrow) {
    parts.push(
      `<div class="${CLS.eyebrow}" style="margin:0 0 ${G.card.eyebrowMarginBottom}px;font-family:${t.bodyFont};font-weight:700;letter-spacing:${G.tracking.eyebrow};font-size:${G.card.eyebrowSize}px;text-transform:uppercase;color:${fg};text-align:${align}">${substituteMergeTagsHtml(esc(content.eyebrow), recipient)}</div>`,
    );
  }
  if (content.heading) {
    parts.push(
      `<h3 class="${CLS.heading}" style="margin:0 0 ${G.card.headingMarginBottom}px;font-family:${t.headingFont};font-size:${spec.headingSize}px;line-height:${spec.headingLine};letter-spacing:${t.headingTracking};font-weight:700;color:${fg};text-align:${align}">${substituteMergeTagsHtml(esc(content.heading), recipient)}</h3>`,
    );
  }
  if (content.body) {
    const italic = content.variant === "testimonial" ? "font-style:italic;" : "";
    const size =
      content.variant === "testimonial" ? G.card.testimonialBodySize : G.card.bodySize;
    parts.push(
      `<div class="${CLS.text}" style="margin:0 0 ${G.card.bodyMarginBottom}px;font-family:${t.bodyFont};font-size:${size}px;line-height:${G.card.bodyLine};letter-spacing:${t.bodyTracking};${italic}color:${fg};text-align:${align}">${markdownSubsetToHtml(substituteMergeTagsHtml(esc(content.body), recipient), t, fg)}</div>`,
    );
  }
  if (content.attribution) {
    parts.push(
      `<div class="${CLS.quoteAttr}" style="margin:0 0 ${G.card.attributionMarginBottom}px;font-family:${t.bodyFont};font-size:${G.card.attributionSize}px;font-weight:700;letter-spacing:${t.bodyTracking};color:${fg};text-align:${align}">${substituteMergeTagsHtml(esc(content.attribution), recipient)}</div>`,
    );
  }
  if (content.ctaLabel && content.ctaUrl) {
    const label = substituteMergeTagsHtml(esc(content.ctaLabel), recipient);
    parts.push(
      `<div style="text-align:${spec.ctaAlign};margin:${G.card.ctaMarginTop}px 0 0">${renderButtonHtml(label, content.ctaUrl, t, content.ctaStyle ?? spec.cta, spec.ctaMaxWidth)}</div>`,
    );
  }
  return parts.join("");
}

/**
 * A card's interior — stacked when the image is on top (or absent), a
 * two-column table when it sits beside the text.
 *
 * The columns are ASYMMETRIC by default (`imageWidthPct`), because the source
 * newsletter's rows are 44/56 and 52/48. Forcing 50/50 is one of the specific
 * things that made the first rebuild read as generic.
 */
function renderCardInner(
  content: EmailCardContent,
  spec: CardSpec,
  t: EmailTheme,
  recipient: CampaignRecipient,
): string {
  const image = cardImageHtml(content, t);
  const text = cardTextHtml(content, spec, t, recipient);
  const side = content.imageSide ?? "top";

  if (!image || side === "top") {
    return `${image ? `<div style="margin:0 0 ${G.card.imageMarginBottom}px">${image}</div>` : ""}${text}`;
  }

  const imgPct = clampEmailImageWidthPct(content.imageWidthPct);
  const textPct = 100 - imgPct;
  const imgCell = `<td class="${CLS.col}" width="${imgPct}%" valign="top" style="width:${imgPct}%;vertical-align:top;padding:0">${image}</td>`;
  const gapPct = EMAIL_CARD_IMAGE_GAP_PCT;
  const gap = `<td class="${CLS.colGap}" width="${gapPct}%" style="width:${gapPct}%;font-size:0">&nbsp;</td>`;
  const textCell = `<td class="${CLS.col}" width="${textPct - gapPct}%" valign="top" style="width:${textPct - gapPct}%;vertical-align:top;padding:0">${text}</td>`;
  const cells = side === "left" ? `${imgCell}${gap}${textCell}` : `${textCell}${gap}${imgCell}`;
  return `<table class="${CLS.colWrap}" role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;border-collapse:collapse"><tr>${cells}</tr></table>`;
}

function renderCardBlock(
  block: Extract<EmailBlock, { kind: "card" }>,
  recipient: CampaignRecipient,
  t: EmailTheme,
): string {
  const variant = block.variant ?? "plain";
  const spec = CARD_SPECS[variant] ?? CARD_SPECS.plain;
  const fill = cardFill(spec, t);
  const inner = renderCardInner(block, spec, t, recipient);

  if (variant === "plain") {
    return `<div class="${CLS.cardPlain}" style="margin:0 0 ${G.card.plainMarginBottom}px">${inner}</div>`;
  }
  const bg = fill ? `background:${fill};` : "";
  const border = spec.bordered ? `border:1px solid ${t.border};` : "";
  const cls =
    variant === "hero"
      ? CLS.cardHero
      : variant === "feature"
        ? CLS.cardFeature
        : variant === "testimonial"
          ? CLS.cardTestimonial
          : CLS.cardOutlined;
  return `<div class="${cls}" style="${bg}${border}border-radius:${t.radius}px;padding:${spec.padY}px ${spec.padX}px;margin:0 0 ${G.card.marginBottom}px">${inner}</div>`;
}

/**
 * A responsive multi-column row.
 *
 * `<table>` rather than divs because Outlook's Word engine has no flex/grid.
 * Each `<td>` carries `pw-col`, which the `@media (max-width:450px)` rule
 * flips to `display:block;width:100%` — the same breakpoint the designer's
 * own newsletter stacks at.
 */
function renderColumnsBlock(
  block: Extract<EmailBlock, { kind: "columns" }>,
  recipient: CampaignRecipient,
  t: EmailTheme,
): string {
  const count = block.columns.length || 1;
  const pct = Math.floor(100 / count);
  const cells = block.columns
    .map((col, i) => {
      const spec = CARD_SPECS[col.variant ?? "plain"] ?? CARD_SPECS.plain;
      const fill = cardFill(spec, t);
      const bg = fill ? `background:${fill};` : "";
      const border = spec.bordered ? `border:1px solid ${t.border};` : "";
      const pad = spec.padY ? `padding:${spec.padY}px ${spec.padX}px;` : "";
      const radius = fill || spec.bordered ? `border-radius:${t.radius}px;` : "";
      const last = i === block.columns.length - 1;
      const gutter = last ? "0" : `0 ${G.columns.gutter}px 0 0`;
      return `<td class="${CLS.col}" width="${pct}%" valign="top" style="width:${pct}%;padding:${gutter};vertical-align:top"><div style="${bg}${border}${radius}${pad}">${renderCardInner(col, spec, t, recipient)}</div></td>`;
    })
    .join("");
  return `<table class="${CLS.colWrap}" role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;border-collapse:collapse;margin:0 0 ${G.columns.marginBottom}px"><tr>${cells}</tr></table>`;
}

/** Edge-to-edge image — the masthead and the section banners. Rendered with
 *  NO container padding (see `blockPadding`), because in this design the
 *  banner IS the section heading and a 24px inset reads as a mistake. */
function renderBleedImage(
  block: Extract<EmailBlock, { kind: "bleed_image" }>,
  t: EmailTheme,
): string {
  // An UNFILLED slot draws a neutral band from theme tokens rather than
  // requesting anything. A template must be able to say "the masthead goes
  // here" without naming a URL the deployment may not own — a placeholder
  // pointing at a guessed path is how you ship broken images to real inboxes.
  if (!block.url) {
    const label = block.alt || "Add artwork from the image library";
    return `<div style="background:${t.cream};border:1px dashed ${t.hairline};border-radius:${Math.max(0, t.radius - G.bleedImage.radiusInset)}px;padding:${G.bleedImage.placeholderPadY}px ${G.bleedImage.placeholderPadX}px;text-align:center;font-family:${t.bodyFont};font-size:${G.bleedImage.placeholderSize}px;letter-spacing:${G.tracking.placeholder};text-transform:uppercase;color:${t.muted}">${esc(label)}</div>`;
  }
  const img = `<img src="${esc(safeImageSrc(block.url))}" alt="${esc(block.alt)}" width="${G.container.width}" style="display:block;width:100%;max-width:100%;border:0" />`;
  return block.href
    ? `<a href="${esc(safeEmailHref(block.href))}" style="display:block;text-decoration:none">${img}</a>`
    : img;
}

function renderHairline(t: EmailTheme): string {
  return `<div class="${CLS.rule}" style="height:${G.hairline.height}px;line-height:${G.hairline.height}px;font-size:0;background:${t.hairline};border-radius:999px;margin:${G.hairline.marginTop}px 0 ${G.hairline.marginBottom}px">&nbsp;</div>`;
}

/** The sign-off card: logo, nav line, links, and the required legal row. */
function renderFooterBlock(
  block: Extract<EmailBlock, { kind: "footer" }>,
  t: EmailTheme,
  opts: RenderEmailOptions,
): string {
  const parts: string[] = [];
  if (block.logoUrl) {
    parts.push(
      `<div style="text-align:center;margin:0 0 ${G.footer.logoMarginBottom}px"><img src="${esc(safeImageSrc(block.logoUrl))}" alt="${esc(block.logoAlt ?? "")}" style="display:inline-block;max-width:${G.footer.logoMaxWidth}px;width:100%;border:0" /></div>`,
    );
  }
  if (block.navLine) {
    parts.push(
      `<div style="text-align:center;margin:0 0 ${G.footer.navMarginBottom}px;font-family:${t.bodyFont};font-size:${G.footer.navSize}px;font-weight:700;letter-spacing:${t.bodyTracking};color:${t.ink}">${esc(block.navLine)}</div>`,
    );
  }
  if (block.links?.length) {
    const links = block.links
      .map(
        (l) =>
          `<a class="${CLS.link}" href="${esc(safeEmailHref(l.url))}" style="color:${t.link};text-decoration:underline">${esc(l.label)}</a>`,
      )
      .join(`<span style="color:${t.muted}"> | </span>`);
    parts.push(
      `<div style="text-align:center;margin:0 0 ${G.footer.linksMarginBottom}px;font-family:${t.bodyFont};font-size:${G.footer.linksSize}px;color:${t.muted}">${links}</div>`,
    );
  }
  const address = opts.orgAddress ? `<div>${esc(opts.orgAddress)}</div>` : "";
  parts.push(
    `<div class="${CLS.foot}" style="text-align:center;font-family:${t.bodyFont};font-size:${G.footer.legalSize}px;line-height:${G.footer.legalLine};color:${t.muted}">${address}<div><a href="${esc(safeUnsubscribeHref(opts.unsubscribeUrl))}" style="color:${t.muted};text-decoration:underline">Unsubscribe</a> from all Public Worship emails.</div></div>`,
  );
  return `<div class="${CLS.cardFeature}" style="background:${t.cream};border-radius:${t.radius}px;padding:${G.footer.padY}px ${G.footer.padX}px;margin:0 0 ${G.footer.marginBottom}px">${parts.join("")}</div>`;
}

function renderDividerBlock(t: EmailTheme): string {
  return `<hr class="${CLS.rule}" style="border:none;border-top:${G.divider.borderWidth}px solid ${t.border};margin:${G.divider.marginY}px 0" />`;
}

function renderSpacerBlock(block: Extract<EmailBlock, { kind: "spacer" }>): string {
  const h = EMAIL_SPACER_HEIGHTS[block.size] ?? EMAIL_SPACER_HEIGHTS.md;
  return `<div style="height:${h}px;line-height:${h}px">&nbsp;</div>`;
}

function renderEyebrowBlock(
  block: Extract<EmailBlock, { kind: "eyebrow" }>,
  recipient: CampaignRecipient,
  t: EmailTheme,
): string {
  const text = substituteMergeTagsHtml(esc(block.text), recipient);
  // The glyph is separated by a real non-breaking space rather than padding —
  // Outlook drops inline padding on inline elements.
  const icon = block.icon ? `${esc(block.icon)}&nbsp;&nbsp;` : "";
  return `<div class="${CLS.eyebrow}" style="margin:0 0 ${G.eyebrow.marginBottom}px;font-family:${t.bodyFont};font-weight:700;letter-spacing:${G.tracking.eyebrow};font-size:${G.eyebrow.size}px;text-transform:uppercase;color:${t.accent}">${icon}${text}</div>`;
}

function renderQuoteBlock(
  block: Extract<EmailBlock, { kind: "quote" }>,
  recipient: CampaignRecipient,
  t: EmailTheme,
): string {
  const text = substituteMergeTagsHtml(esc(block.text), recipient);
  const attribution = block.attribution
    ? `<div class="${CLS.quoteAttr}" style="margin:${G.quote.attributionMarginTop}px 0 0;font-family:${t.bodyFont};font-size:${G.quote.attributionSize}px;font-weight:600;letter-spacing:${G.tracking.quoteAttribution};color:${t.muted}">— ${substituteMergeTagsHtml(esc(block.attribution), recipient)}</div>`
    : "";
  return `<blockquote class="${CLS.quote}" style="margin:0 0 ${G.quote.marginBottom}px;padding:${G.quote.padY}px 0 ${G.quote.padY}px ${G.quote.padLeft}px;border-left:${G.quote.barWidth}px solid ${t.accent}"><div class="${CLS.quoteText}" style="margin:0;font-family:${t.headingFont};font-size:${G.quote.textSize}px;line-height:${G.quote.textLine};letter-spacing:${t.bodyTracking};font-style:italic;color:${t.ink}">${text}</div>${attribution}</blockquote>`;
}

/**
 * An inline poll. Each option is a link to a per-recipient vote URL built by
 * `opts.pollVoteUrl`; that URL lands on a CONFIRM page (a GET never records a
 * vote) because Apple Mail Privacy Protection and corporate link scanners
 * fetch every href in a message before a human ever sees it — recording on
 * first fetch would give every option a phantom vote at delivery time. This is
 * the same GET-reads/POST-writes split `/unsubscribe/<token>` already uses.
 *
 * With no builder (composer preview, `sendTest`) the options render as inert
 * pills — visually identical, but not links to a URL that would 404.
 */
function renderPollBlock(
  block: Extract<EmailBlock, { kind: "poll" }>,
  recipient: CampaignRecipient,
  t: EmailTheme,
  opts: RenderEmailOptions,
): string {
  const question = substituteMergeTagsHtml(esc(block.question), recipient);
  const optionHtml = block.options
    .map((opt: EmailPollOption) => {
      // Merge tags substitute here too. Every other authored string in the
      // renderer supports them, and the composer offers the tag chips at
      // SCREEN level with nothing marking the poll-option field as the one
      // input where they silently wouldn't work — so a raw `{{firstName}}`
      // would have shipped to real inboxes.
      const label = substituteMergeTagsHtml(esc(opt.label), recipient);
      const style = `display:block;margin:0 0 ${G.poll.optionMarginBottom}px;padding:${G.poll.optionPadY}px ${G.poll.optionPadX}px;border:${G.poll.optionBorderWidth}px solid ${t.border};border-radius:${G.poll.optionRadius}px;font-family:${t.bodyFont};font-size:${G.poll.optionSize}px;font-weight:600;color:${t.ink};text-decoration:none;text-align:center`;
      if (!opts.pollVoteUrl) {
        return `<span class="${CLS.pollOpt}" style="${style}">${label}</span>`;
      }
      const href = esc(safeEmailHref(opts.pollVoteUrl(block.id, opt.id)));
      return `<a class="${CLS.pollOpt}" href="${href}" style="${style}">${label}</a>`;
    })
    .join("");
  return `<div style="margin:0 0 ${G.poll.marginBottom}px"><div class="${CLS.heading}" style="margin:0 0 ${G.poll.questionMarginBottom}px;font-family:${t.headingFont};font-size:${G.poll.questionSize}px;font-weight:700;line-height:${G.poll.questionLine};color:${t.ink}">${question}</div>${optionHtml}</div>`;
}

/** Render one block to HTML. Unknown `kind` values render nothing — forward
 *  compat with documents written by a newer client. */
function renderBlockHtml(
  block: EmailBlock,
  recipient: CampaignRecipient,
  t: EmailTheme,
  opts: RenderEmailOptions,
): string {
  switch (block.kind) {
    case "heading":
      return renderHeadingBlock(block, recipient, t);
    case "text":
      return renderTextBlock(block, recipient, t);
    case "image":
      return renderImageBlock(block, t);
    case "button":
      return renderButtonBlock(block, recipient, t);
    case "divider":
      return renderDividerBlock(t);
    case "spacer":
      return renderSpacerBlock(block);
    case "eyebrow":
      return renderEyebrowBlock(block, recipient, t);
    case "card":
      return renderCardBlock(block, recipient, t);
    case "columns":
      return renderColumnsBlock(block, recipient, t);
    case "quote":
      return renderQuoteBlock(block, recipient, t);
    case "poll":
      return renderPollBlock(block, recipient, t, opts);
    case "bleed_image":
      return renderBleedImage(block, t);
    case "hairline":
      return renderHairline(t);
    case "footer":
      return renderFooterBlock(block, t, opts);
    default:
      return "";
  }
}

// ── The <style> block ─────────────────────────────────────────────────────

/**
 * Responsive + dark-mode overrides. Everything here is `!important` because
 * it must outrank the inline styles that carry the light rendering — and
 * everything here is an OVERRIDE of something already rendered inline, never
 * the only source of a style.
 */
/**
 * The dark-mode overrides, as (selector, declarations) pairs.
 *
 * ONE list, emitted twice — once inside `@media (prefers-color-scheme: dark)`
 * and once prefixed with `[data-ogsc]` for the clients that rewrite the
 * document instead of honouring the media query. Written out separately they
 * drifted, and the drift was invisible in every client that DOES honour the
 * media query, so nothing caught it.
 *
 * Every selector here is a single class, which is what makes the naive
 * `[data-ogsc] <sel>` prefix correct for all of them.
 */
function darkRules(d: EmailThemeTokens): [string, string][] {
  return [
    // `body` as well as the wrapper: the wrapper is only as tall as its
    // content, so a short email would show a light strip beneath the card.
    ["body", `background:${d.canvas} !important;`],
    [`.${CLS.wrap}`, `background:${d.canvas} !important;`],
    [
      `.${CLS.card}`,
      `background:${d.surface} !important; border-color:${d.border} !important;`,
    ],
    [`.${CLS.heading}`, `color:${d.ink} !important;`],
    [`.${CLS.text}`, `color:${d.muted} !important;`],
    [`.${CLS.link}`, `color:${d.link} !important;`],
    [
      `.${CLS.button}`,
      `background:${d.accent} !important; color:${d.accentInk} !important;`,
    ],
    [`.${CLS.mark}`, `color:${d.accent} !important;`],
    [`.${CLS.eyebrow}`, `color:${d.accent} !important;`],
    [`.${CLS.rule}`, `border-top-color:${d.border} !important;`],
    [`.${CLS.quote}`, `border-left-color:${d.accent} !important;`],
    [`.${CLS.quoteText}`, `color:${d.ink} !important;`],
    [`.${CLS.quoteAttr}`, `color:${d.muted} !important;`],
    [
      `.${CLS.pollOpt}`,
      `border-color:${d.border} !important; color:${d.ink} !important;`,
    ],
    [`.${CLS.cardHero}`, `background:${d.accent} !important;`],
    [`.${CLS.cardFeature}`, `background:${d.cream} !important;`],
    [
      `.${CLS.cardOutlined}`,
      `background:${d.surface} !important; border-color:${d.border} !important;`,
    ],
    [`.${CLS.cardTestimonial}`, `background:${d.contrast} !important;`],
    [`.${CLS.foot}`, `color:${d.muted} !important;`],
    [`.${CLS.foot} a`, `color:${d.muted} !important;`],
  ];
}

function styleBlock(t: EmailTheme): string {
  const d: EmailThemeTokens = resolveDarkTheme(t);
  return `
:root { color-scheme: light dark; supported-color-schemes: light dark; }
body { margin:0; padding:0; width:100% !important; -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%; }
img { -ms-interpolation-mode:bicubic; }
a { text-decoration:underline; }

@media only screen and (max-width:599px) {
  .${CLS.card} { width:100% !important; max-width:100% !important; }
  .${CLS.h1} { font-size:26px !important; line-height:1.15 !important; }
  .${CLS.cardHero} { padding:28px 18px !important; }
  .${CLS.cardHero} .${CLS.heading} { font-size:30px !important; }
  .${CLS.cardFeature}, .${CLS.cardOutlined}, .${CLS.cardTestimonial} { padding:20px 18px !important; }
}

/* Stack columns. 450px is where two 240px-ish cards stop being readable —
   the same breakpoint the source newsletter stacks at. */
@media only screen and (max-width:450px) {
  .${CLS.col} {
    display:block !important;
    width:100% !important;
    max-width:100% !important;
    padding:0 0 16px 0 !important;
  }
  /* The inter-column spacer must vanish, not become a 16px-tall empty row. */
  .${CLS.colGap} { display:none !important; width:0 !important; }
}

@media (prefers-color-scheme: dark) {
${darkRules(d).map(([sel, decls]) => `  ${sel} { ${decls} }`).join("\n")}
}

/* Outlook.com and some Android clients never evaluate prefers-color-scheme —
   they rewrite the document and key off [data-ogsc] instead. Generated from
   the SAME rule list rather than hand-maintained: these were originally
   written out twice and the attribute copy drifted into a strict subset,
   leaving the quote text and every poll option at full-strength ink on a
   forced-dark card (1.06:1 — invisible) in exactly the clients that need the
   fallback most. */
${darkRules(d).map(([sel, decls]) => `[data-ogsc] ${sel} { ${decls} }`).join("\n")}
`.trim();
}

/**
 * Render a full campaign email document to a complete, email-client-safe
 * HTML document: a centered, responsive 600px card themed by the document's
 * own `theme` (or Public Worship's brand when it has none), with a required
 * visible unsubscribe link in the footer.
 */
/**
 * Which blocks bleed to the container edge. The masthead and the section
 * banners are artwork that CARRIES the heading — inset by the usual 24px they
 * read as a mistake rather than a design.
 */
function blockPadding(block: EmailBlock): string {
  if (block.kind !== "bleed_image") return `0 ${G.container.gutterX}px`;
  // An unfilled slot keeps the normal inset so the dashed band reads as a
  // placeholder inside the layout rather than a full-width grey stripe.
  return block.inset || !block.url ? `0 ${G.container.gutterX}px` : "0";
}

/**
 * Render a full campaign email document to a complete, email-client-safe
 * HTML document.
 *
 * Structure follows the real newsletter: a COOL GREY page (`canvas`) behind a
 * 600px WHITE container (`surface`), with each block supplying its own fill.
 * The previous version had this inverted — a cream page behind a white card —
 * which is why applying the right hex values still didn't look like the brand.
 */
export function renderCampaignEmail(
  doc: EmailDocument,
  opts: RenderEmailOptions,
): string {
  // Normalize at the EDGE, once. Everything downstream can then treat every
  // token as present and well-formed.
  const t = doc.theme ? normalizeEmailTheme(doc.theme) : DEFAULT_EMAIL_THEME;

  const rows = doc.blocks
    .map((b) => {
      const html = renderBlockHtml(b, opts.recipient, t, opts);
      if (!html) return "";
      return `<tr><td style="padding:${blockPadding(b)}">${html}</td></tr>`;
    })
    .join("");

  const preview = opts.subjectPreview
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all">${esc(opts.subjectPreview)}</div>`
    : "";
  const wordmark = t.wordmark
    ? `<tr><td class="${CLS.mark}" style="padding:${G.wordmark.padTop}px ${G.wordmark.padX}px ${G.wordmark.padBottom}px;text-align:center;font-family:${t.bodyFont};font-weight:700;letter-spacing:${G.tracking.wordmark};font-size:${G.wordmark.size}px;color:${t.accent}">${esc(t.wordmark)}</td></tr>`
    : "";

  // The unsubscribe link is REQUIRED on every send. A document carrying a
  // `footer` block renders it there; one without still gets this fallback, so
  // it can never go out missing.
  const hasFooter = doc.blocks.some((b) => b.kind === "footer");
  const address = opts.orgAddress ? `<div>${esc(opts.orgAddress)}</div>` : "";
  const fallbackFooter = hasFooter
    ? ""
    : `<tr><td class="${CLS.foot}" style="padding:${G.fallbackFooter.padTop}px ${G.fallbackFooter.padX}px ${G.fallbackFooter.padBottom}px;text-align:center;font-family:${t.bodyFont};font-size:${G.fallbackFooter.size}px;line-height:${G.fallbackFooter.line};color:${t.muted}">${address}<div>Sent with love by Public Worship · Chapter OS</div><div style="padding-top:6px"><a href="${esc(safeUnsubscribeHref(opts.unsubscribeUrl))}" style="color:${t.muted};text-decoration:underline">Unsubscribe from all Public Worship emails</a></div></td></tr>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${esc(t.name)}</title>
<style>${styleBlock(t)}</style>
</head>
<body style="margin:0;padding:0;background:${t.canvas}">
${preview}<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" class="${CLS.wrap}" style="width:100%;border-collapse:collapse;background:${t.canvas};padding:0">
  <tr><td align="center" style="padding:0">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="${G.container.width}" class="${CLS.card}" style="width:${G.container.width}px;max-width:${G.container.width}px;border-collapse:collapse;background:${t.surface};font-family:${t.bodyFont};color:${t.ink}">
      ${wordmark}
      ${rows}
      ${fallbackFooter}
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

// ── Block → plaintext ────────────────────────────────────────────────────

/** One inline tree, flattened to plaintext: marks disappear, and a link keeps
 *  its address alongside the label because a plaintext part has nowhere else
 *  to put it. */
function inlineMarkdownText(nodes: MarkdownInlineNode[]): string {
  return nodes
    .map((node) => {
      if (node.kind === "text") return node.text;
      const inner = inlineMarkdownText(node.children);
      return node.kind === "link" ? `${inner} (${node.href})` : inner;
    })
    .join("");
}

/**
 * Strip the markdown subset for the plaintext part.
 *
 * Line structure is preserved (a `- ` line becomes a bullet) rather than
 * reflowed into paragraphs the way `parseMarkdownSubset` does for the visual
 * renderers — a plaintext email has no other way to show shape.
 *
 * What is NOT preserved is line-by-line parsing. The two alternatives of one
 * email have to agree about what is markup, so the unit of parsing here is
 * the same BLOCK `parseMarkdownSubset` gives the HTML side — one paragraph,
 * or one run of `- ` lines — with its lines still separated by newlines
 * instead of joined by spaces.
 *
 * Both halves of that matter. Parsing one line at a time left the raw
 * `[the full\nstory](https://…)` sitting in the text/plain part of an email
 * whose text/html rendered it as a link. Parsing the whole body at once
 * instead makes the opposite mistake: a stray `**` would reach across the
 * blank line between two paragraphs, which the HTML side would never do.
 */
function stripMarkdownSubset(markdown: string): string {
  const out: string[] = [];
  let block: string[] = [];
  let blockIsList = false;

  const flush = () => {
    if (block.length === 0) return;
    // A list's ITEMS are parsed one at a time and a paragraph's lines all
    // together — mirroring `parseMarkdownSubset` exactly, so markup can reach
    // across a soft wrap in both parts of the email and across a list-item
    // boundary in neither.
    out.push(
      blockIsList
        ? block.map((item) => inlineMarkdownText(parseInlineMarkdown(item))).join("\n")
        : inlineMarkdownText(parseInlineMarkdown(block.join("\n"))),
    );
    block = [];
  };

  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "") {
      flush();
      out.push("");
      continue;
    }
    const isList = line.startsWith("- ");
    // A list starting or ending closes the block before it, exactly as it
    // does for the visual renderers.
    if (isList !== blockIsList) flush();
    blockIsList = isList;
    block.push(isList ? `• ${line.slice(2)}` : line);
  }
  flush();
  return out.join("\n");
}

/** Plaintext for one card's parts — shared by `card` and `columns` for the
 *  same no-drift reason as `renderCardContent`. */
function cardContentText(
  content: EmailCardContent,
  recipient: CampaignRecipient,
): string | null {
  const parts: string[] = [];
  // The image's alt text carries real content in this design — the seeded
  // newsletter tells the author to make these cards image-led — so omitting
  // it left an image-only card contributing NOTHING to the plaintext part. A
  // near-empty text/plain alternative is both a spam-filter signal and a dead
  // end for anyone reading in plaintext.
  if (content.imageUrl && content.imageAlt) parts.push(`[${content.imageAlt}]`);
  if (content.heading) parts.push(substituteMergeTagsPlain(content.heading, recipient));
  if (content.body) {
    parts.push(stripMarkdownSubset(substituteMergeTagsPlain(content.body, recipient)));
  }
  if (content.ctaLabel && content.ctaUrl) {
    parts.push(`${substituteMergeTagsPlain(content.ctaLabel, recipient)}: ${content.ctaUrl}`);
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

function renderBlockText(
  block: EmailBlock,
  recipient: CampaignRecipient,
  opts: RenderEmailOptions,
): string | null {
  switch (block.kind) {
    case "heading":
      return substituteMergeTagsPlain(block.text, recipient);
    case "text":
      return stripMarkdownSubset(substituteMergeTagsPlain(block.markdown, recipient));
    case "button":
      return `${substituteMergeTagsPlain(block.label, recipient)}: ${block.url}`;
    case "divider":
      return "---";
    case "eyebrow":
      return substituteMergeTagsPlain(block.text, recipient).toUpperCase();
    case "card":
      return cardContentText(block, recipient);
    case "columns": {
      const cols = block.columns
        .map((c) => cardContentText(c, recipient))
        .filter((c): c is string => c !== null);
      return cols.length > 0 ? cols.join("\n\n") : null;
    }
    case "quote": {
      const quote = `"${substituteMergeTagsPlain(block.text, recipient)}"`;
      return block.attribution
        ? `${quote}\n— ${substituteMergeTagsPlain(block.attribution, recipient)}`
        : quote;
    }
    case "poll": {
      const lines = [substituteMergeTagsPlain(block.question, recipient)];
      for (const opt of block.options) {
        // Without a URL builder the plaintext lists the options as a bulleted
        // set rather than inventing a link that goes nowhere.
        lines.push(
          opts.pollVoteUrl
            ? `• ${opt.label}: ${opts.pollVoteUrl(block.id, opt.id)}`
            : `• ${opt.label}`,
        );
      }
      return lines.join("\n");
    }
    case "image": {
      // An image with a link is a real destination a plaintext reader would
      // otherwise never see; a bare decorative image still contributes nothing.
      if (block.href) return `${block.alt || "Image"}: ${block.href}`;
      return null;
    }
    case "bleed_image":
      // The banners carry the section headings as artwork — dropping them
      // leaves the plaintext with no section structure at all.
      if (!block.url) return null;
      if (block.href) return `${block.alt || "Image"}: ${block.href}`;
      return block.alt ? block.alt : null;
    case "hairline":
      return "---";
    case "footer": {
      const lines: string[] = [];
      if (block.navLine) lines.push(block.navLine);
      for (const l of block.links ?? []) lines.push(`${l.label}: ${l.url}`);
      return lines.length > 0 ? lines.join("\n") : null;
    }
    case "spacer":
      return null;
    default:
      return null;
  }
}

/**
 * Plaintext counterpart to `renderCampaignEmail`, for the Resend `text`
 * field. Headings and text blocks render as plain lines (markdown stripped),
 * a button becomes "Label: url", spacers are skipped, and the footer
 * always ends with an unsubscribe line.
 */
export function renderCampaignText(doc: EmailDocument, opts: RenderEmailOptions): string {
  const lines: string[] = [];
  for (const block of doc.blocks) {
    const rendered = renderBlockText(block, opts.recipient, opts);
    if (rendered === null) continue;
    lines.push(rendered, "");
  }
  if (opts.orgAddress) lines.push(opts.orgAddress);
  lines.push("Sent with love by Public Worship · Chapter OS");
  lines.push(`Unsubscribe from all Public Worship emails: ${opts.unsubscribeUrl}`);
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}
