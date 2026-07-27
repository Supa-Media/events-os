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
  EmailCardContent,
  EmailDocument,
  EmailPollOption,
} from "./emailBlocks";
import { isAllowedImageUrl, isAllowedLinkUrl } from "./emailBlocks";
import type { EmailTheme, EmailThemeTokens } from "./emailTheme";
import { DEFAULT_EMAIL_THEME, normalizeEmailTheme, resolveDarkTheme } from "./emailTheme";
import { firstNameOf } from "./names";

export type CampaignRecipient = { name?: string | null; email: string };

export type RenderEmailOptions = {
  /** Hidden preheader text (the snippet inbox lists show after the subject). */
  subjectPreview?: string;
  recipient: CampaignRecipient;
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
// list lines. Operates on text that's already HTML-escaped, so it only ever
// wraps existing (safe) text in tags — it never needs to escape anything
// itself.

// One level of parenthesis-nesting inside a link URL — `[^()\s]` handles the
// ordinary case, `\([^()]*\)` lets a single balanced `(...)` pass through
// (e.g. a Wikipedia-style `https://en.wikipedia.org/wiki/Foo_(bar)`), which
// a plain `[^)]+` truncates at the URL's own first `)`.
const LINK_RE = /\[([^\]]+)\]\(((?:[^()\s]|\([^()]*\))+)\)/g;

function inlineMarkdown(escapedText: string, t: EmailTheme): string {
  let html = escapedText;
  html = html.replace(
    LINK_RE,
    (_m, label: string, url: string) =>
      `<a class="${CLS.link}" href="${safeEmailHref(url)}" style="color:${t.link};text-decoration:underline">${label}</a>`,
  );
  // Bold runs BEFORE italic, and non-greedily across ANY character (not just
  // non-`*` ones) — a greedy/`[^*]+`-style bold match can't span an embedded
  // single-`*` italic run (`**bold *italic* text**`: the content between the
  // outer `**` pair contains `*` characters a `[^*]+` class excludes), so it
  // simply fails to match and the whole thing falls through unrendered.
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  return html;
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
  colWrap: "pw-col-wrap",
  pollOpt: "pw-poll-opt",
} as const;

function textStyle(t: EmailTheme): string {
  return `margin:0 0 12px;font-family:${t.bodyFont};font-size:15px;line-height:1.6;color:${t.muted}`;
}

function listStyle(t: EmailTheme): string {
  return `margin:0 0 12px;padding-left:20px;font-family:${t.bodyFont};font-size:15px;line-height:1.6;color:${t.muted}`;
}

function markdownSubsetToHtml(escapedMarkdown: string, t: EmailTheme): string {
  const out: string[] = [];
  let paraLines: string[] = [];
  let listItems: string[] = [];

  const flushPara = () => {
    if (paraLines.length === 0) return;
    out.push(
      `<p class="${CLS.text}" style="${textStyle(t)}">${inlineMarkdown(paraLines.join(" "), t)}</p>`,
    );
    paraLines = [];
  };
  const flushList = () => {
    if (listItems.length === 0) return;
    const items = listItems.map((i) => `<li>${inlineMarkdown(i, t)}</li>`).join("");
    out.push(`<ul class="${CLS.text}" style="${listStyle(t)}">${items}</ul>`);
    listItems = [];
  };

  for (const rawLine of escapedMarkdown.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "") {
      flushPara();
      flushList();
      continue;
    }
    if (line.startsWith("- ")) {
      flushPara();
      listItems.push(line.slice(2));
      continue;
    }
    flushList();
    paraLines.push(line);
  }
  flushPara();
  flushList();
  return out.join("");
}

// ── Block → HTML ──────────────────────────────────────────────────────────

function renderHeadingBlock(
  block: Extract<EmailBlock, { kind: "heading" }>,
  recipient: CampaignRecipient,
  t: EmailTheme,
): string {
  const level = block.level ?? 1;
  const size = level === 2 ? 20 : 28;
  const cls = level === 2 ? CLS.heading : `${CLS.heading} ${CLS.h1}`;
  const text = substituteMergeTagsHtml(esc(block.text), recipient);
  return `<h${level} class="${cls}" style="margin:0 0 12px;font-size:${size}px;line-height:1.25;color:${t.ink};font-family:${t.headingFont};font-weight:700">${text}</h${level}>`;
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
  const width = block.width === "half" ? "50%" : "100%";
  const img = `<img src="${esc(safeImageSrc(block.url))}" alt="${esc(block.alt)}" style="display:block;width:${width};max-width:100%;border:0;border-radius:${t.radius}px;margin:0 0 16px" />`;
  if (!block.href) return img;
  return `<a href="${esc(safeEmailHref(block.href))}" style="display:block;text-decoration:none">${img}</a>`;
}

function renderButtonHtml(label: string, url: string, t: EmailTheme): string {
  return `<a class="${CLS.button}" href="${esc(safeEmailHref(url))}" style="display:inline-block;background:${t.accent};color:${t.accentInk};text-decoration:none;font-family:${t.bodyFont};font-weight:600;font-size:14px;padding:12px 24px;border-radius:999px">${label}</a>`;
}

function renderButtonBlock(
  block: Extract<EmailBlock, { kind: "button" }>,
  recipient: CampaignRecipient,
  t: EmailTheme,
): string {
  const label = substituteMergeTagsHtml(esc(block.label), recipient);
  const align = block.align === "left" ? "left" : "center";
  return `<div style="text-align:${align};margin:0 0 16px">${renderButtonHtml(label, block.url, t)}</div>`;
}

function renderDividerBlock(t: EmailTheme): string {
  return `<hr class="${CLS.rule}" style="border:none;border-top:1px solid ${t.border};margin:20px 0" />`;
}

const SPACER_HEIGHTS: Record<"sm" | "md" | "lg", number> = { sm: 12, md: 24, lg: 40 };

function renderSpacerBlock(block: Extract<EmailBlock, { kind: "spacer" }>): string {
  const h = SPACER_HEIGHTS[block.size] ?? SPACER_HEIGHTS.md;
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
  return `<div class="${CLS.eyebrow}" style="margin:0 0 10px;font-family:${t.bodyFont};font-weight:700;letter-spacing:0.1em;font-size:12px;text-transform:uppercase;color:${t.accent}">${icon}${text}</div>`;
}

/**
 * The inner parts of a card, in order, with no wrapper — shared verbatim by
 * the full-width `card` block and each column of a `columns` block so the two
 * cannot drift apart visually.
 */
function renderCardContent(
  content: EmailCardContent,
  recipient: CampaignRecipient,
  t: EmailTheme,
  opts: { headingSize: number },
): string {
  const parts: string[] = [];

  if (content.imageUrl) {
    parts.push(
      `<img src="${esc(safeImageSrc(content.imageUrl))}" alt="${esc(content.imageAlt ?? "")}" style="display:block;width:100%;max-width:100%;border:0;border-radius:${t.radius}px;margin:0 0 14px" />`,
    );
  }
  if (content.heading) {
    const heading = substituteMergeTagsHtml(esc(content.heading), recipient);
    parts.push(
      `<h3 class="${CLS.heading}" style="margin:0 0 8px;font-size:${opts.headingSize}px;line-height:1.3;color:${t.ink};font-family:${t.headingFont};font-weight:700">${heading}</h3>`,
    );
  }
  if (content.body) {
    parts.push(
      markdownSubsetToHtml(substituteMergeTagsHtml(esc(content.body), recipient), t),
    );
  }
  if (content.ctaLabel && content.ctaUrl) {
    const label = substituteMergeTagsHtml(esc(content.ctaLabel), recipient);
    parts.push(
      `<div style="margin:4px 0 0">${renderButtonHtml(label, content.ctaUrl, t)}</div>`,
    );
  }
  return parts.join("");
}

function renderCardBlock(
  block: Extract<EmailBlock, { kind: "card" }>,
  recipient: CampaignRecipient,
  t: EmailTheme,
): string {
  return `<div style="margin:0 0 20px">${renderCardContent(block, recipient, t, { headingSize: 20 })}</div>`;
}

/**
 * A responsive multi-column row.
 *
 * `<table>` rather than divs because Outlook's Word engine has no flex/grid.
 * Each `<td>` carries `pw-col`, which the `@media (max-width:450px)` rule
 * flips to `display:block;width:100%` — the same breakpoint the designer's
 * own newsletter stacks at. Clients that strip `<style>` keep the side-by-side
 * table, which is the correct desktop rendering anyway.
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
      const last = i === block.columns.length - 1;
      // Gutter as right-padding on every cell but the last — a `border-spacing`
      // or margin-based gutter is unreliable across Outlook and Gmail alike.
      const pad = last ? "0" : "0 16px 0 0";
      return `<td class="${CLS.col}" width="${pct}%" valign="top" style="width:${pct}%;padding:${pad};vertical-align:top">${renderCardContent(col, recipient, t, { headingSize: 17 })}</td>`;
    })
    .join("");
  return `<table class="${CLS.colWrap}" role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;border-collapse:collapse;margin:0 0 20px"><tr>${cells}</tr></table>`;
}

function renderQuoteBlock(
  block: Extract<EmailBlock, { kind: "quote" }>,
  recipient: CampaignRecipient,
  t: EmailTheme,
): string {
  const text = substituteMergeTagsHtml(esc(block.text), recipient);
  const attribution = block.attribution
    ? `<div class="${CLS.quoteAttr}" style="margin:10px 0 0;font-family:${t.bodyFont};font-size:13px;font-weight:600;letter-spacing:0.04em;color:${t.muted}">— ${substituteMergeTagsHtml(esc(block.attribution), recipient)}</div>`
    : "";
  return `<blockquote class="${CLS.quote}" style="margin:0 0 20px;padding:4px 0 4px 18px;border-left:3px solid ${t.accent}"><div class="${CLS.quoteText}" style="margin:0;font-family:${t.headingFont};font-size:19px;line-height:1.5;font-style:italic;color:${t.ink}">${text}</div>${attribution}</blockquote>`;
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
      const style = `display:block;margin:0 0 8px;padding:11px 16px;border:1px solid ${t.border};border-radius:999px;font-family:${t.bodyFont};font-size:14px;font-weight:600;color:${t.ink};text-decoration:none;text-align:center`;
      if (!opts.pollVoteUrl) {
        return `<span class="${CLS.pollOpt}" style="${style}">${label}</span>`;
      }
      const href = esc(safeEmailHref(opts.pollVoteUrl(block.id, opt.id)));
      return `<a class="${CLS.pollOpt}" href="${href}" style="${style}">${label}</a>`;
    })
    .join("");
  return `<div style="margin:0 0 20px"><div class="${CLS.heading}" style="margin:0 0 12px;font-family:${t.headingFont};font-size:18px;font-weight:700;line-height:1.35;color:${t.ink}">${question}</div>${optionHtml}</div>`;
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
  .${CLS.wrap} { padding:20px 10px !important; }
  .${CLS.card} { padding:24px 18px !important; border-radius:${Math.max(0, t.radius - 4)}px !important; }
  .${CLS.h1} { font-size:24px !important; line-height:1.2 !important; }
  .${CLS.button} { display:block !important; text-align:center !important; }
}

/* Stack columns. 450px is where two 240px-ish cards stop being readable —
   the same breakpoint the source newsletter stacks at. */
@media only screen and (max-width:450px) {
  .${CLS.col} {
    display:block !important;
    width:100% !important;
    max-width:100% !important;
    padding:0 0 20px 0 !important;
  }
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
export function renderCampaignEmail(
  doc: EmailDocument,
  opts: RenderEmailOptions,
): string {
  // Normalize at the EDGE, once. Everything downstream can then treat every
  // token as present and well-formed — no per-token fallbacks scattered
  // through the renderers, and a malformed stored theme degrades to on-brand
  // rather than painting "undefined" into a style attribute.
  const t = doc.theme ? normalizeEmailTheme(doc.theme) : DEFAULT_EMAIL_THEME;

  const bodyHtml = doc.blocks
    .map((b) => renderBlockHtml(b, opts.recipient, t, opts))
    .join("");
  const preview = opts.subjectPreview
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all">${esc(opts.subjectPreview)}</div>`
    : "";
  const addressLine = opts.orgAddress ? `<div>${esc(opts.orgAddress)}</div>` : "";
  const wordmark = t.wordmark
    ? `<div class="${CLS.mark}" style="text-align:center;padding-bottom:16px;font-family:${t.bodyFont};font-weight:700;letter-spacing:0.12em;font-size:12px;color:${t.accent}">${esc(t.wordmark)}</div>`
    : "";

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
${preview}<div class="${CLS.wrap}" style="margin:0;padding:32px 12px;background:${t.canvas};font-family:${t.bodyFont};color:${t.ink}">
  <div style="max-width:600px;margin:0 auto">
    ${wordmark}
    <div class="${CLS.card}" style="background:${t.surface};border:1px solid ${t.border};border-radius:${t.radius}px;padding:32px 28px">
      ${bodyHtml}
    </div>
    <div class="${CLS.foot}" style="text-align:center;padding-top:16px;font-family:${t.bodyFont};font-size:11px;line-height:1.5;color:${t.muted}">
      ${addressLine}
      <div>Sent with love by Public Worship · Chapter OS</div>
      <div style="padding-top:8px"><a href="${esc(opts.unsubscribeUrl)}" style="color:${t.muted};text-decoration:underline">Unsubscribe from all Public Worship emails</a></div>
    </div>
  </div>
</div>
</body>
</html>`;
}

// ── Block → plaintext ────────────────────────────────────────────────────

function stripMarkdownSubset(markdown: string): string {
  return markdown
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      return trimmed.startsWith("- ") ? `• ${trimmed.slice(2)}` : trimmed;
    })
    .join("\n")
    // Same link/bold fixes as `inlineMarkdown`'s `LINK_RE` / bold pass —
    // parenthesis-nesting and non-greedy bold, so plaintext strips the exact
    // same markdown the HTML render understands (a Wikipedia-style URL or a
    // `**bold *italic* text**` run shouldn't come out mangled here either).
    .replace(LINK_RE, "$1 ($2)")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1");
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
