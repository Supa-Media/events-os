/**
 * WS1: the compliance shell — the ONE entry point the backend calls to turn
 * a `docFormat: "tiptap"` campaign doc into a send-ready `{ html, text }`
 * pair (see `docs/plans/maily-editor-overhaul.md`, "Compliance stays ours,
 * wrapped around maily's output"). Wiring an actual send/preview path to
 * call this is a LATER lane's job (WS2's `docFormat` dispatch) — this file
 * only defines and tests the entry point itself.
 *
 * Maily's own output is a complete HTML document with NO injection hooks and
 * no CAN-SPAM/unsubscribe concept, and it force-declares `color-scheme:
 * light` (see `maily.tsx`'s `DEFAULT_META_TAGS`). Three post-processing
 * passes turn that into something this org can actually send, using the WS0
 * spike's proven hooks (`postprocess.ts`):
 *
 *   1. Inject the compliance footer (unsubscribe link + postal address)
 *      before `</body>` — visually/copy-consistent with the OLD renderer's
 *      footer (`apps/convex/lib/emailShell.ts`'s `BulkMailFooter` /
 *      `packages/shared/src/emailRender.ts`'s `renderCampaignEmail`
 *      fallback footer: address, "Sent with love by Public Worship ·
 *      Chapter OS", then the unsubscribe line) — a recipient who gets one
 *      email from each pipeline in the same inbox should not be able to
 *      tell they came from two different renderers.
 *   2. Override maily's forced `color-scheme: light` meta tags to
 *      `light dark` (`overrideColorSchemeMeta`).
 *   3. Append a conservative dark-mode `<style>` block before `</head>`,
 *      covering body background/text and the themed container's background
 *      — see `darkModeStyle`'s doc for why this is the practical minimum
 *      maily's (mostly class-less) emitted structure supports, and how it
 *      reuses `packages/shared/src/emailRender.ts`'s established
 *      `prefers-color-scheme` + `[data-ogsc]` dual-emission approach.
 *
 * Send-BLOCKING guarantees (a working unsubscribe link, a real postal
 * address) remain enforced upstream in `campaigns.ts`/`blasts.ts`, not here
 * — the editor changed, the law didn't. This shell's job is only to make
 * sure those two things are actually PRESENT and correctly formatted in the
 * output; it has no opinion on whether a send may proceed.
 */
import type { JSONContent } from "@tiptap/core";
import { DEFAULT_EMAIL_THEME, resolveDarkTheme, safeUnsubscribeHref } from "@events-os/shared";
import { Maily } from "./maily";
import { injectBeforeBodyClose, injectBeforeHeadClose, overrideColorSchemeMeta } from "./postprocess";

export type RenderEmailTiptapOptions = {
  /** Merge-tag values (`setVariableValues` — recipient name, per-recipient
   *  poll vote URLs keyed `pw_poll_<nodeId>_<optionId>_url`, anything else
   *  the doc references as a `variable` node or an `isXVariable`-flagged
   *  attr). Untrusted (a recipient's own name, in particular) — see
   *  `renderEmailTiptap`'s doc for why this is safe to pass through
   *  verbatim. */
  variables: Record<string, string>;
  /** The per-recipient `/unsubscribe/<token>` URL. Root-relative allowed —
   *  see `safeUnsubscribeHref`'s own doc (`packages/shared/src/emailRender.ts`)
   *  before changing how this is sanitized; it is NOT plain scheme-checking,
   *  on purpose. */
  unsubscribeUrl: string;
  /** The org's physical mailing address — CAN-SPAM requires this be visible
   *  on every bulk send. */
  orgAddress: string;
  /** Hidden preheader text (the inbox-list snippet after the subject). */
  preview?: string;
};

export type RenderedEmail = { html: string; text: string };

/** HTML-escape untrusted strings for element content/attributes — same
 *  five-entity table used throughout this codebase (see
 *  `packages/shared/src/emailRender.ts`'s `esc()` / `apps/convex/lib/html.ts`'s
 *  `escapeHtml()`). Only needed for the footer's OWN raw-string-built markup
 *  below; the doc's own variable substitution is handled by React's normal
 *  text-child escaping inside `Maily` itself (JSX text content is always
 *  entity-encoded — see `renderEmailTiptap`'s doc). */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const FOOTER_ID = "pw-compliance-footer";
const SIGNOFF = "Sent with love by Public Worship · Chapter OS";

function complianceFooterHtml(opts: RenderEmailTiptapOptions): string {
  const address = opts.orgAddress ? `<div>${esc(opts.orgAddress)}</div>` : "";
  const href = esc(safeUnsubscribeHref(opts.unsubscribeUrl));
  return `<div id="${FOOTER_ID}" style="text-align:center;font-family:Inter,Arial,sans-serif;font-size:11px;line-height:1.6;color:#64748B;padding:16px 24px 24px">${address}<div>${SIGNOFF}</div><div style="padding-top:6px"><a href="${href}" style="color:#64748B;text-decoration:underline">Unsubscribe</a> from all Public Worship emails.</div></div>`;
}

function complianceFooterText(opts: RenderEmailTiptapOptions): string {
  const lines: string[] = [];
  if (opts.orgAddress) lines.push(opts.orgAddress);
  lines.push(SIGNOFF);
  lines.push(`Unsubscribe from all Public Worship emails: ${opts.unsubscribeUrl}`);
  return lines.join("\n");
}

/**
 * The dark-mode `<style>` block. Maily's emitted structure carries almost NO
 * classes or ids of its own (`Container`/`Body`/`Section`/etc. all render as
 * bare `<table>`s with only inline styles — verified against the actual
 * output in this file's tests, not assumed) — the one exception is
 * `pw-container`, a class WS1 added to `maily.tsx`'s own themed `<Container>`
 * specifically so this shell would have something stable to target (see that
 * file's comment at the `className` prop). Given that, the CONSERVATIVE,
 * "won't break something we can't see" scope this covers is exactly the
 * plan doc's stated minimum: body background/text color, and the themed
 * container's own background — not per-node dark treatment (headings,
 * buttons, links, cards) the way the OLD renderer's `darkRules`
 * (`packages/shared/src/emailRender.ts`) can, because that renderer's every
 * element carries a `pw-*` class for exactly this purpose and maily's stock
 * nodes do not. Extending per-node dark coverage to the node pack (or
 * further) is a real, separate design decision for a later pass, not
 * something to bolt on silently here.
 *
 * Same dual-emission structure as the old renderer's `darkRules`/`styleBlock`
 * (`packages/shared/src/emailRender.ts`): once under `@media (prefers-color-
 * scheme: dark)` for clients that honor the media query, once prefixed
 * `[data-ogsc]` for Outlook.com and Android clients that rewrite the
 * document and key off that attribute instead — generated from ONE rule
 * list so the two can't drift the way `emailRender.ts`'s own header
 * describes them once having drifted.
 */
function darkModeStyle(): string {
  const dark = resolveDarkTheme(DEFAULT_EMAIL_THEME);
  const rules: [string, string][] = [
    ["body", `background:${dark.canvas} !important; color:${dark.ink} !important;`],
    [".pw-container", `background:${dark.surface} !important;`],
  ];
  const media = rules.map(([sel, decls]) => `${sel} { ${decls} }`).join("\n");
  const ogsc = rules.map(([sel, decls]) => `[data-ogsc] ${sel} { ${decls} }`).join("\n");
  return `<style id="pw-dark-mode">\n@media (prefers-color-scheme: dark) {\n${media}\n}\n${ogsc}\n</style>`;
}

/**
 * Render a `docFormat: "tiptap"` campaign doc to send-ready HTML + plaintext.
 *
 * Instantiates the vendored `Maily` class PER CALL — never a module-level
 * singleton — for the exact reason `maily.tsx`'s two "DEVIATION FROM
 * UPSTREAM" fixes exist: a shared instance across recipients would bleed one
 * recipient's/campaign's variables and theme into another's in a send loop
 * that renders many recipients from the same process.
 *
 * Hostile variable values (e.g. an HTML-bearing recipient name) are safe:
 * `Maily`'s `variable()` node renders `{formattedVariable}` as a JSX text
 * CHILD, never via `dangerouslySetInnerHTML` — React's own renderer entity-
 * encodes text children unconditionally, so `<script>` in a name becomes
 * `&lt;script&gt;` in the output with no extra handling needed here. This
 * file only has to escape its OWN raw-string-built footer markup (see `esc`
 * above), which is not doc content.
 */
export async function renderEmailTiptap(
  doc: JSONContent,
  opts: RenderEmailTiptapOptions,
): Promise<RenderedEmail> {
  const maily = new Maily(doc);
  maily.setVariableValues(opts.variables);
  if (opts.preview) maily.setPreviewText(opts.preview);

  const rawHtml = await maily.render();
  const rawText = await maily.render({ plainText: true });

  const withFooter = injectBeforeBodyClose(rawHtml, complianceFooterHtml(opts));
  const withMeta = overrideColorSchemeMeta(withFooter);
  const html = injectBeforeHeadClose(withMeta, darkModeStyle());

  const text = `${rawText.trim()}\n\n${complianceFooterText(opts)}\n`;

  return { html, text };
}
