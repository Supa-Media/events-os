/**
 * The transactional-email shell and its themed building blocks.
 *
 * ── One source of truth for the brand ──────────────────────────────────────
 * Every colour, font, and radius here comes from `DEFAULT_EMAIL_THEME`
 * (`@events-os/shared`'s `emailTheme.ts`) — the SAME theme the campaign
 * renderer (`emailRender.ts`) paints newsletters with. Transactional mail
 * (ticket confirmations, RSVP notes, receipts, reminders, budget/campaign
 * approval notices, card alerts, reimbursements) and campaign mail therefore
 * cannot drift apart: a rebrand is one edit in `emailTheme.ts`, not a
 * find-and-replace across a dozen Convex modules.
 *
 * This file used to be a hand-duplicated copy of an INVENTED palette
 * (`#D23B3A` red on `#FDF6F6` pink-cream, Georgia) that had never matched
 * Public Worship's actual newsletter. `emailRender.ts` carried a second copy
 * of the same constants under a "keep in sync with ticketingEmails.ts"
 * comment. Both are gone; there is no palette to keep in sync any more.
 *
 * ── The `<style>` seam ─────────────────────────────────────────────────────
 * `emailShell` used to return a bare `<div>` FRAGMENT, which every caller
 * handed straight to Resend as the message `html`. A fragment cannot express
 * `@media` or `prefers-color-scheme`, so it could never be responsive or
 * dark-mode aware. It now returns a COMPLETE `<!doctype html>` document with a
 * `<head><style>` — the same shape `renderCampaignEmail` returns, and the
 * shape a mail client would have synthesized around the fragment anyway. The
 * exported signature is unchanged (`string` in, `string` out), so all ~20 call
 * sites keep working untouched.
 *
 * Same layering rule as the campaign renderer, and for the same reason:
 *  - inline styles carry the COMPLETE light rendering, so a client that
 *    strips `<style>` (Gmail's clipped view, corporate gateways) sees exactly
 *    what it saw before this change — nothing regresses;
 *  - the `<style>` block only ever OVERRIDES, via `!important` (the one thing
 *    that outranks an inline style), and never introduces layout that a
 *    stripping client would miss.
 *
 * The helpers below (`emailHeading`, `emailParagraph`, `emailButton`, …) exist
 * so a fragment built in another module (`reminders.ts`, `cards.ts`,
 * `reimbursements.ts`, …) gets BOTH the inline light style and the class name
 * the dark-mode rules key off. Building a `<p style="…color:#7A5A5A">` by hand
 * is exactly how the second palette got here in the first place.
 */
import type { EmailTheme, EmailThemeTokens } from "@events-os/shared";
import { DEFAULT_EMAIL_THEME, resolveDarkTheme } from "@events-os/shared";
import { escapeHtml } from "./html";

/** The theme every transactional email renders on — Public Worship's real
 *  brand, shared verbatim with campaign email. Read tokens off this rather
 *  than writing a hex into a template string. */
export const EMAIL_THEME: EmailTheme = DEFAULT_EMAIL_THEME;

/** The same theme's DARK tokens, materialized (`dark` layered over the light
 *  side). Exported for the surfaces that build their own stylesheet rather
 *  than using `emailShell` — currently `lib/unsubscribePage.ts`, the page an
 *  email's unsubscribe link lands on. */
export const EMAIL_DARK: EmailThemeTokens = resolveDarkTheme(DEFAULT_EMAIL_THEME);

/**
 * Class names the `<style>` block targets. Identical prefix to the campaign
 * renderer's (`pw-*`) on purpose: a recipient who gets a receipt and a
 * newsletter in the same inbox should not be able to tell that two different
 * renderers produced them.
 */
export const EMAIL_CLS = {
  wrap: "pw-wrap",
  card: "pw-card",
  heading: "pw-h",
  h1: "pw-h1",
  text: "pw-t",
  link: "pw-a",
  button: "pw-btn",
  outline: "pw-btn-o",
  mark: "pw-mark",
  eyebrow: "pw-eyebrow",
  rule: "pw-hr",
  panel: "pw-panel",
  code: "pw-code",
  foot: "pw-foot",
} as const;

/** Monospace stack for the one thing that genuinely needs it: a code/amount a
 *  recipient reads back character by character. Not a brand token — it carries
 *  no colour and never changes with the theme. */
const MONO = "'SF Mono',Menlo,Consolas,monospace";

// ── Fragment builders ──────────────────────────────────────────────────────
// Every one takes ALREADY-ESCAPED html for its content (call sites interpolate
// their own `escapeHtml(...)`), and returns markup carrying both the inline
// light style and the dark-mode class.

/** The email's main headline. `size` defaults to 24px (26 for the
 *  guest-facing confirmations that lead with an event name). */
export function emailHeading(
  html: string,
  opts: { size?: number; margin?: string; theme?: EmailTheme } = {},
): string {
  const t = opts.theme ?? EMAIL_THEME;
  const size = opts.size ?? 24;
  const margin = opts.margin ?? "0 0 12px";
  return `<h1 class="${EMAIL_CLS.heading} ${EMAIL_CLS.h1}" style="margin:${margin};font-family:${t.headingFont};font-size:${size}px;line-height:1.25;font-weight:700;color:${t.ink}">${html}</h1>`;
}

/** A secondary heading inside the card (a section label, a sub-headline). */
export function emailSubheading(
  html: string,
  opts: { size?: number; margin?: string; theme?: EmailTheme } = {},
): string {
  const t = opts.theme ?? EMAIL_THEME;
  const size = opts.size ?? 18;
  const margin = opts.margin ?? "0 0 8px";
  return `<h2 class="${EMAIL_CLS.heading}" style="margin:${margin};font-family:${t.headingFont};font-size:${size}px;line-height:1.3;font-weight:700;color:${t.ink}">${html}</h2>`;
}

/** Body copy. `strong` promotes it from `muted` to `ink` — for the one line in
 *  a message that must not read as secondary. */
export function emailParagraph(
  html: string,
  opts: {
    size?: number;
    margin?: string;
    strong?: boolean;
    theme?: EmailTheme;
  } = {},
): string {
  const t = opts.theme ?? EMAIL_THEME;
  const size = opts.size ?? 14;
  const margin = opts.margin ?? "0 0 16px";
  const color = opts.strong ? t.ink : t.muted;
  return `<p class="${EMAIL_CLS.text}" style="margin:${margin};font-family:${t.bodyFont};font-size:${size}px;line-height:1.6;color:${color}">${html}</p>`;
}

/** The style string for a `<div>`/`<span>` of body copy — for the call sites
 *  that need a block element other than `<p>`. Pair it with
 *  `class="${EMAIL_CLS.text}"` so dark mode still reaches it. */
export function emailTextStyle(
  opts: { size?: number; margin?: string; strong?: boolean; theme?: EmailTheme } = {},
): string {
  const t = opts.theme ?? EMAIL_THEME;
  const size = opts.size ?? 14;
  const margin = opts.margin ?? "0";
  const color = opts.strong ? t.ink : t.muted;
  return `margin:${margin};font-family:${t.bodyFont};font-size:${size}px;line-height:1.6;color:${color}`;
}

/** A bulleted list of body copy. */
export function emailList(
  itemsHtml: string[],
  opts: { margin?: string; theme?: EmailTheme } = {},
): string {
  const t = opts.theme ?? EMAIL_THEME;
  const margin = opts.margin ?? "0 0 16px";
  const items = itemsHtml.map((i) => `<li>${i}</li>`).join("");
  return `<ul class="${EMAIL_CLS.text}" style="margin:${margin};padding-left:18px;font-family:${t.bodyFont};font-size:14px;line-height:1.7;color:${t.muted}">${items}</ul>`;
}

/**
 * The primary call-to-action pill. `href` is interpolated raw — every call
 * site builds it from `appUrl`/`siteUrl`, never from user input.
 *
 * The `<style>` block makes it full-width below 600px, so a thumb on a phone
 * gets a real target rather than a 120px pill.
 */
export function emailButton(
  href: string,
  label: string,
  opts: { theme?: EmailTheme } = {},
): string {
  const t = opts.theme ?? EMAIL_THEME;
  return `<a class="${EMAIL_CLS.button}" href="${href}" style="display:inline-block;background:${t.accent};color:${t.accentInk};text-decoration:none;font-family:${t.bodyFont};font-weight:600;font-size:14px;padding:12px 24px;border-radius:999px;border:1px solid ${t.accent}">${label}</a>`;
}

/** A compact CTA row — the small pill the notification emails use under a
 *  paragraph, rather than the full-size guest-facing button. */
export function emailButtonRow(
  href: string,
  label: string,
  opts: { theme?: EmailTheme } = {},
): string {
  const t = opts.theme ?? EMAIL_THEME;
  return `<div style="font-family:${t.bodyFont};font-size:12px;font-weight:600"><a class="${EMAIL_CLS.button}" href="${href}" style="color:${t.accentInk};background:${t.accent};text-decoration:none;border:1px solid ${t.accent};border-radius:999px;padding:6px 12px;display:inline-block">${label}</a></div>`;
}

/** A secondary, outlined pill — a lower-emphasis action sitting beside the
 *  primary one (reminders' "mark in progress" / "mark blocked"). */
export function emailOutlineButton(
  href: string,
  label: string,
  opts: { theme?: EmailTheme } = {},
): string {
  const t = opts.theme ?? EMAIL_THEME;
  return `<a class="${EMAIL_CLS.outline}" href="${href}" style="color:${t.muted};text-decoration:none;border:1px solid ${t.border};border-radius:999px;padding:5px 10px;display:inline-block;margin:0 4px 4px 0">${label}</a>`;
}

/** A plain accent-coloured text link (an "Open →" affordance). */
export function emailLink(
  href: string,
  label: string,
  opts: { theme?: EmailTheme } = {},
): string {
  const t = opts.theme ?? EMAIL_THEME;
  return `<a class="${EMAIL_CLS.link}" href="${href}" style="color:${t.link};text-decoration:underline">${label}</a>`;
}

/**
 * An inset panel on the card — the box a ticket, a code, an amount, or a
 * reviewer's note sits in. `dashed` is the "detachable stub" treatment
 * (tickets, codes); solid is everything else.
 *
 * The panel background is `canvas`, not a hardcoded `#fff`: on a white card it
 * reads as a warm inset, and in dark mode it inverts with the theme instead of
 * staying a blinding white rectangle.
 */
export function emailPanel(
  html: string,
  opts: {
    dashed?: boolean;
    center?: boolean;
    margin?: string;
    href?: string;
    theme?: EmailTheme;
  } = {},
): string {
  const t = opts.theme ?? EMAIL_THEME;
  const margin = opts.margin ?? "0 0 16px";
  const stroke = opts.dashed ? "dashed" : "solid";
  const align = opts.center ? "text-align:center;" : "";
  const style = `${align}background:${t.canvas};border:1px ${stroke} ${t.border};border-radius:${Math.max(0, t.radius - 4)}px;padding:14px 18px;margin:${margin}`;
  if (opts.href) {
    return `<a class="${EMAIL_CLS.panel}" href="${opts.href}" style="display:block;text-decoration:none;color:${t.ink};${style}">${html}</a>`;
  }
  return `<div class="${EMAIL_CLS.panel}" style="${style}">${html}</div>`;
}

/** A monospace code/amount — the one place a non-brand font is correct
 *  (a verification code read back digit by digit). */
export function emailCode(
  text: string,
  opts: { size?: number; letterSpacing?: string; theme?: EmailTheme } = {},
): string {
  const t = opts.theme ?? EMAIL_THEME;
  const size = opts.size ?? 28;
  const ls = opts.letterSpacing ? `letter-spacing:${opts.letterSpacing};` : "";
  return `<span class="${EMAIL_CLS.code}" style="font-family:${MONO};font-size:${size}px;font-weight:700;${ls}color:${t.accent}">${text}</span>`;
}

/** The small all-caps label above a heading. */
export function emailEyebrow(
  html: string,
  opts: { margin?: string; theme?: EmailTheme } = {},
): string {
  const t = opts.theme ?? EMAIL_THEME;
  const margin = opts.margin ?? "0 0 10px";
  return `<div class="${EMAIL_CLS.eyebrow}" style="margin:${margin};font-family:${t.bodyFont};font-weight:700;letter-spacing:0.1em;font-size:11px;text-transform:uppercase;color:${t.accent}">${html}</div>`;
}

/** A hairline divider. */
export function emailRule(opts: { margin?: string; theme?: EmailTheme } = {}): string {
  const t = opts.theme ?? EMAIL_THEME;
  const margin = opts.margin ?? "24px 0";
  return `<hr class="${EMAIL_CLS.rule}" style="border:none;border-top:1px solid ${t.border};margin:${margin}" />`;
}

// ── The <style> block ──────────────────────────────────────────────────────

/**
 * Responsive + dark-mode overrides. Deliberately a near-twin of
 * `emailRender.ts`'s `styleBlock` — the two shells must degrade identically,
 * and the small extra surface here (`.pw-panel`, `.pw-code`, `.pw-btn-o`)
 * covers the elements only transactional mail has.
 */
function styleBlock(t: EmailTheme): string {
  const d: EmailThemeTokens = resolveDarkTheme(t);
  return `
:root { color-scheme: light dark; supported-color-schemes: light dark; }
body { margin:0; padding:0; width:100% !important; -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%; }
img { -ms-interpolation-mode:bicubic; }

@media only screen and (max-width:599px) {
  .${EMAIL_CLS.wrap} { padding:20px 10px !important; }
  .${EMAIL_CLS.card} { padding:24px 18px !important; border-radius:${Math.max(0, t.radius - 4)}px !important; }
  .${EMAIL_CLS.h1} { font-size:22px !important; line-height:1.2 !important; }
  .${EMAIL_CLS.button} { display:block !important; text-align:center !important; }
}

@media (prefers-color-scheme: dark) {
  .${EMAIL_CLS.wrap} { background:${d.canvas} !important; color:${d.ink} !important; }
  .${EMAIL_CLS.card} { background:${d.surface} !important; border-color:${d.border} !important; }
  .${EMAIL_CLS.heading} { color:${d.ink} !important; }
  .${EMAIL_CLS.text} { color:${d.muted} !important; }
  .${EMAIL_CLS.link} { color:${d.link} !important; }
  .${EMAIL_CLS.button} { background:${d.accent} !important; border-color:${d.accent} !important; color:${d.accentInk} !important; }
  .${EMAIL_CLS.outline} { border-color:${d.border} !important; color:${d.muted} !important; }
  .${EMAIL_CLS.mark}, .${EMAIL_CLS.eyebrow} { color:${d.accent} !important; }
  .${EMAIL_CLS.rule} { border-top-color:${d.border} !important; }
  .${EMAIL_CLS.panel} { background:${d.canvas} !important; border-color:${d.border} !important; color:${d.ink} !important; }
  .${EMAIL_CLS.code} { color:${d.accent} !important; }
  .${EMAIL_CLS.foot}, .${EMAIL_CLS.foot} a { color:${d.muted} !important; }
}

/* Outlook.com / some Android clients rewrite to [data-ogsc] instead of
   honouring the media query — same overrides through the attribute they add. */
[data-ogsc] .${EMAIL_CLS.card} { background:${d.surface} !important; }
[data-ogsc] .${EMAIL_CLS.heading} { color:${d.ink} !important; }
[data-ogsc] .${EMAIL_CLS.text} { color:${d.muted} !important; }
[data-ogsc] .${EMAIL_CLS.panel} { background:${d.canvas} !important; color:${d.ink} !important; }
[data-ogsc] .${EMAIL_CLS.button} { background:${d.accent} !important; color:${d.accentInk} !important; }
`.trim();
}

/**
 * The BULK-MAIL footer furniture — an unsubscribe link and the sender's
 * physical postal address, the two things US CAN-SPAM requires of every
 * commercial/promotional message and RFC 8058 pairs with the
 * `List-Unsubscribe` header.
 *
 * ── Why both fields are REQUIRED together ──────────────────────────────────
 * `emailShell` is shared by TRANSACTIONAL mail (ticket receipts, RSVP
 * confirmations, verification codes, approval notices) and BULK mail (event
 * blasts). Transactional mail must NOT carry an unsubscribe link — an opt-out
 * from "here is the ticket you just bought" is meaningless, and offering one
 * invites a recipient to suppress the address their own receipts arrive at.
 * So the furniture is OPT-IN per call site: omit this argument and the footer
 * is byte-for-byte what it has always been.
 *
 * `orgAddress` is not optional WITHIN the object on purpose. The campaign
 * renderer's `opts.orgAddress ? … : ""` is exactly the silent degrade this
 * repo warns about for email links — an unset org address quietly produced a
 * footer missing its legally required line. Here the type makes "bulk mail
 * with no postal address" unrepresentable, and the call sites
 * (`blasts.ts#sendBlast`, `campaigns.ts#send`/`#submitForApproval`) refuse the
 * send outright rather than rendering a footer without one.
 */
export type BulkMailFooter = {
  /** Absolute `/unsubscribe/<token>` URL — PER RECIPIENT, never shared. */
  unsubscribeUrl: string;
  /** The org's physical mailing address (`integrationSettings.orgMailingAddress`). */
  orgAddress: string;
};

/**
 * Wrap a fragment in the branded transactional shell: a centered card on the
 * theme's canvas, under the theme's wordmark, above the standard footer.
 *
 * Returns a COMPLETE HTML document (see the module doc for why). `theme`
 * defaults to `DEFAULT_EMAIL_THEME` — the parameter exists so a future
 * per-org transactional theme (the same `emailThemes` row campaigns already
 * read) can be threaded through without touching a single call site.
 *
 * `bulk`, when passed, appends the unsubscribe link + postal address to the
 * footer — see `BulkMailFooter` for why that's opt-in and why both halves
 * travel together.
 */
export function emailShell(
  inner: string,
  theme: EmailTheme = EMAIL_THEME,
  bulk?: BulkMailFooter,
): string {
  const t = theme;
  const wordmark = t.wordmark
    ? `<div class="${EMAIL_CLS.mark}" style="text-align:center;padding-bottom:16px;font-family:${t.bodyFont};font-weight:700;letter-spacing:0.12em;font-size:12px;color:${t.accent}">${escapeHtml(t.wordmark)}</div>`
    : "";
  // `href` is interpolated raw for the same reason `emailButton`'s is: every
  // call site builds it from `siteUrl()` + a minted token, never user input.
  const bulkFooter = bulk
    ? `<div style="margin-top:6px">${escapeHtml(bulk.orgAddress)}</div>` +
      `<div style="margin-top:4px"><a href="${bulk.unsubscribeUrl}" style="color:${t.muted};text-decoration:underline">Unsubscribe</a> from Public Worship announcements.</div>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<style>${styleBlock(t)}</style>
</head>
<body style="margin:0;padding:0;background:${t.canvas}">
<div class="${EMAIL_CLS.wrap}" style="margin:0;padding:32px 12px;background:${t.canvas};font-family:${t.bodyFont};color:${t.ink}">
  <div style="max-width:600px;margin:0 auto">
    ${wordmark}
    <div class="${EMAIL_CLS.card}" style="background:${t.surface};border:1px solid ${t.border};border-radius:${t.radius}px;padding:32px 28px">
      ${inner}
    </div>
    <div class="${EMAIL_CLS.foot}" style="text-align:center;padding-top:16px;font-family:${t.bodyFont};font-size:11px;line-height:1.5;color:${t.muted}">Sent with love by Public Worship · Chapter OS${bulkFooter}</div>
  </div>
</div>
</body>
</html>`;
}
