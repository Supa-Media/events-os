/**
 * Renders an `EmailDocument` (see `emailBlocks.ts`) into send-ready HTML and
 * plaintext for the in-app email-campaign designer. Pure TypeScript, zero
 * react/convex deps — runs in Convex's V8 action runtime (the actual send
 * path), plain Node (vitest), and the Expo app (live preview).
 *
 * Visual language matches `apps/convex/ticketingEmails.ts`'s `emailShell()`
 * exactly: centered 520px cream card, Georgia serif headings, deep-red
 * accents, "PUBLIC WORSHIP" wordmark strip. Everything is inlined — no
 * `<style>` blocks/classes — because email clients strip both unreliably.
 */

import type { EmailBlock, EmailDocument } from "./emailBlocks";
import { firstNameOf } from "./names";

// Same brand constants as ticketingEmails.ts's emailShell() — keep in sync.
const ACCENT = "#D23B3A";
const INK = "#210909";
const CREAM = "#FDF6F6";
const MUTED = "#7A5A5A";
const BORDER = "#EFE0DC";

const SANS = "-apple-system,'Segoe UI',Roboto,sans-serif";
const SERIF = "Georgia,'Times New Roman',serif";

export type CampaignRecipient = { name?: string | null; email: string };

export type RenderEmailOptions = {
  /** Hidden preheader text (the snippet inbox lists show after the subject). */
  subjectPreview?: string;
  recipient: CampaignRecipient;
  unsubscribeUrl: string;
  orgAddress?: string | null;
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

// ── Merge tags ────────────────────────────────────────────────────────────
// `{{tag}}` or `{{tag|fallback}}`. Supported tags: firstName, name (see
// `MERGE_TAGS` in emailBlocks.ts). Unrecognized tags, or a recognized tag
// with no resolvable value, fall back to the author's `|fallback` text (if
// given) or the word "friend".
const MERGE_TAG_RE = /\{\{\s*(\w+)(?:\|([^}]*))?\s*\}\}/g;

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

function inlineMarkdown(escapedText: string): string {
  let html = escapedText;
  html = html.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_m, label: string, url: string) =>
      `<a href="${url}" style="color:${ACCENT};text-decoration:underline">${label}</a>`,
  );
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  return html;
}

const TEXT_STYLE = `margin:0 0 12px;font-family:${SANS};font-size:14px;line-height:1.6;color:${MUTED}`;
const LIST_STYLE = `margin:0 0 12px;padding-left:20px;font-family:${SANS};font-size:14px;line-height:1.6;color:${MUTED}`;

function markdownSubsetToHtml(escapedMarkdown: string): string {
  const out: string[] = [];
  let paraLines: string[] = [];
  let listItems: string[] = [];

  const flushPara = () => {
    if (paraLines.length === 0) return;
    out.push(`<p style="${TEXT_STYLE}">${inlineMarkdown(paraLines.join(" "))}</p>`);
    paraLines = [];
  };
  const flushList = () => {
    if (listItems.length === 0) return;
    const items = listItems.map((i) => `<li>${inlineMarkdown(i)}</li>`).join("");
    out.push(`<ul style="${LIST_STYLE}">${items}</ul>`);
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
): string {
  const level = block.level ?? 1;
  const size = level === 2 ? 20 : 26;
  const text = substituteMergeTagsHtml(esc(block.text), recipient);
  return `<h${level} style="margin:0 0 12px;font-size:${size}px;line-height:1.25;color:${INK};font-family:${SERIF}">${text}</h${level}>`;
}

function renderTextBlock(
  block: Extract<EmailBlock, { kind: "text" }>,
  recipient: CampaignRecipient,
): string {
  const substituted = substituteMergeTagsHtml(esc(block.markdown), recipient);
  return markdownSubsetToHtml(substituted);
}

function renderImageBlock(block: Extract<EmailBlock, { kind: "image" }>): string {
  const width = block.width === "half" ? "50%" : "100%";
  return `<img src="${esc(block.url)}" alt="${esc(block.alt)}" style="display:block;width:${width};max-width:100%;border-radius:12px;margin:0 0 16px" />`;
}

function renderButtonBlock(
  block: Extract<EmailBlock, { kind: "button" }>,
  recipient: CampaignRecipient,
): string {
  const label = substituteMergeTagsHtml(esc(block.label), recipient);
  const align = block.align === "left" ? "left" : "center";
  return `<div style="text-align:${align};margin:0 0 16px"><a href="${esc(block.url)}" style="display:inline-block;background:${ACCENT};color:#fff;text-decoration:none;font-family:${SANS};font-weight:600;font-size:14px;padding:12px 24px;border-radius:999px">${label}</a></div>`;
}

function renderDividerBlock(): string {
  return `<hr style="border:none;border-top:1px solid ${BORDER};margin:20px 0" />`;
}

const SPACER_HEIGHTS: Record<"sm" | "md" | "lg", number> = { sm: 12, md: 24, lg: 40 };

function renderSpacerBlock(block: Extract<EmailBlock, { kind: "spacer" }>): string {
  const h = SPACER_HEIGHTS[block.size] ?? SPACER_HEIGHTS.md;
  return `<div style="height:${h}px;line-height:${h}px">&nbsp;</div>`;
}

/** Render one block to HTML. Unknown `kind` values render nothing — forward
 *  compat with documents written by a newer client. */
function renderBlockHtml(block: EmailBlock, recipient: CampaignRecipient): string {
  switch (block.kind) {
    case "heading":
      return renderHeadingBlock(block, recipient);
    case "text":
      return renderTextBlock(block, recipient);
    case "image":
      return renderImageBlock(block);
    case "button":
      return renderButtonBlock(block, recipient);
    case "divider":
      return renderDividerBlock();
    case "spacer":
      return renderSpacerBlock(block);
    default:
      return "";
  }
}

/**
 * Render a full campaign email document to a complete, email-client-safe
 * HTML document: table-free 520px centered card, all styles inlined, the
 * Public Worship look (cream card, Georgia serif, deep-red accents), and a
 * required visible unsubscribe link in the footer.
 */
export function renderCampaignEmail(
  doc: EmailDocument,
  opts: RenderEmailOptions,
): string {
  const bodyHtml = doc.blocks.map((b) => renderBlockHtml(b, opts.recipient)).join("");
  const preview = opts.subjectPreview
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all">${esc(opts.subjectPreview)}</div>`
    : "";
  const addressLine = opts.orgAddress
    ? `<div>${esc(opts.orgAddress)}</div>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Public Worship</title>
</head>
<body style="margin:0;padding:0;background:#ffffff">
${preview}<div style="margin:0;padding:32px 12px;background:#ffffff;font-family:${SERIF};color:${INK}">
  <div style="max-width:520px;margin:0 auto">
    <div style="text-align:center;padding-bottom:16px;font-family:${SANS};font-weight:700;letter-spacing:0.12em;font-size:12px;color:${ACCENT}">PUBLIC WORSHIP</div>
    <div style="background:${CREAM};border:1px solid ${BORDER};border-radius:20px;padding:32px 28px">
      ${bodyHtml}
    </div>
    <div style="text-align:center;padding-top:16px;font-family:${SANS};font-size:11px;color:${MUTED}">
      ${addressLine}
      <div>Sent with love by Public Worship · Chapter OS</div>
      <div style="padding-top:8px"><a href="${esc(opts.unsubscribeUrl)}" style="color:${MUTED};text-decoration:underline">Unsubscribe</a></div>
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
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1");
}

function renderBlockText(block: EmailBlock, recipient: CampaignRecipient): string | null {
  switch (block.kind) {
    case "heading":
      return substituteMergeTagsPlain(block.text, recipient);
    case "text":
      return stripMarkdownSubset(substituteMergeTagsPlain(block.markdown, recipient));
    case "button":
      return `${substituteMergeTagsPlain(block.label, recipient)}: ${block.url}`;
    case "divider":
      return "---";
    case "image":
    case "spacer":
      return null;
    default:
      return null;
  }
}

/**
 * Plaintext counterpart to `renderCampaignEmail`, for the Resend `text`
 * field. Headings and text blocks render as plain lines (markdown stripped),
 * a button becomes "Label: url", images/spacers are skipped, and the footer
 * always ends with an unsubscribe line.
 */
export function renderCampaignText(doc: EmailDocument, opts: RenderEmailOptions): string {
  const lines: string[] = [];
  for (const block of doc.blocks) {
    const rendered = renderBlockText(block, opts.recipient);
    if (rendered === null) continue;
    lines.push(rendered, "");
  }
  if (opts.orgAddress) lines.push(opts.orgAddress);
  lines.push("Sent with love by Public Worship · Chapter OS");
  lines.push(`Unsubscribe: ${opts.unsubscribeUrl}`);
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}
