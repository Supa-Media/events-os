/**
 * The compliance-footer + dark-mode-style content shared by every renderer
 * that produces a send-ready email (`renderEmail.ts`'s `renderEmailTiptap`,
 * `renderEmailHtml.ts`'s `renderEmailHtml`) — extracted (PR 2 of the
 * founder's editor feedback, "Paste HTML", 2026-07-30) so the "Paste HTML"
 * path reuses the EXACT footer markup/copy and dark-mode rules the maily
 * path already sends, rather than a second implementation that could drift.
 * See `renderEmail.ts`'s module doc for the full provenance/reasoning behind
 * this content — this file only holds the shared building blocks; the
 * per-format `render*` entry points own the post-processing PIPELINE (which
 * hooks get called, in what order) for their own output shape.
 */
import { DEFAULT_EMAIL_THEME, resolveDarkTheme, safeUnsubscribeHref } from "@events-os/shared";

/** Shared by every renderer that needs to escape untrusted strings into ITS
 *  OWN raw-string-built markup (the footer below) — never used on doc/HTML
 *  content itself, which each renderer handles on its own terms (React's
 *  text-child escaping for tiptap; the real sanitizer, upstream of this
 *  shell entirely, for pasted HTML). Same five-entity table used throughout
 *  this codebase (see `apps/convex/lib/html.ts`'s `escapeHtml()`). */
export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export const FOOTER_ID = "pw-compliance-footer";
export const SIGNOFF = "Sent with love by Public Worship · Chapter OS";

export type ComplianceFooterOptions = {
  /** The org's physical mailing address — CAN-SPAM requires this be visible
   *  on every bulk send. */
  orgAddress: string;
  /** The per-recipient `/unsubscribe/<token>` URL. Root-relative allowed —
   *  see `safeUnsubscribeHref`'s own doc before changing how this is
   *  sanitized. */
  unsubscribeUrl: string;
};

export function complianceFooterHtml(opts: ComplianceFooterOptions): string {
  const address = opts.orgAddress ? `<div>${esc(opts.orgAddress)}</div>` : "";
  const href = esc(safeUnsubscribeHref(opts.unsubscribeUrl));
  return `<div id="${FOOTER_ID}" style="text-align:center;font-family:Inter,Arial,sans-serif;font-size:11px;line-height:1.6;color:#64748B;padding:16px 24px 24px">${address}<div>${SIGNOFF}</div><div style="padding-top:6px"><a href="${href}" style="color:#64748B;text-decoration:underline">Unsubscribe</a> from all Public Worship emails.</div></div>`;
}

export function complianceFooterText(opts: ComplianceFooterOptions): string {
  const lines: string[] = [];
  if (opts.orgAddress) lines.push(opts.orgAddress);
  lines.push(SIGNOFF);
  lines.push(`Unsubscribe from all Public Worship emails: ${opts.unsubscribeUrl}`);
  return lines.join("\n");
}

/**
 * The dark-mode `<style>` block — see `renderEmail.ts`'s original doc
 * ("`darkModeStyle()` below…") for the full reasoning on scope (body
 * background/text + `.pw-container` only) and the dual `@media`/`[data-ogsc]`
 * emission shape. Renderer-agnostic: `renderEmailHtml.ts`'s pasted-HTML shell
 * doesn't emit a `.pw-container` element, so that rule is simply inert there
 * (matches nothing) — no per-caller variant needed.
 */
export function darkModeStyle(): string {
  const dark = resolveDarkTheme(DEFAULT_EMAIL_THEME);
  const rules: [string, string][] = [
    ["body", `background:${dark.canvas} !important; color:${dark.ink} !important;`],
    [".pw-container", `background:${dark.surface} !important;`],
  ];
  const media = rules.map(([sel, decls]) => `${sel} { ${decls} }`).join("\n");
  const ogsc = rules.map(([sel, decls]) => `[data-ogsc] ${sel} { ${decls} }`).join("\n");
  return `<style id="pw-dark-mode">\n@media (prefers-color-scheme: dark) {\n${media}\n}\n${ogsc}\n</style>`;
}
