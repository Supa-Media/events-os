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
 *
 * ── The page canvas colour (WS4, fidelity gap 2 fix, 2026-07-29) ───────────
 * Public Worship's newsletter is a grey `#f0f1f5` page behind the white
 * 600px container — until this fix, nothing here ever called `maily.
 * setTheme()`, so every tiptap send rendered `DEFAULT_RENDERER_THEME`'s
 * white body regardless of brand (see `newsletter.fidelity.test.ts`'s
 * former `FIDELITY GAP` pin, now flipped).
 *
 * Themes-the-system are dead — a founder decision, and this repo's standing
 * one: no theme table, no token system for campaign send. So the canvas
 * colour does NOT come from a config object here; it comes from the DOCUMENT
 * itself — `doc.attrs.pwCanvasColor`, a plain hex string on the tiptap doc's
 * own top-level `attrs` (write-gated by `validateTiptapEmailDoc`'s
 * `validateDocAttrs`, `@events-os/shared`'s `tiptapEmail.ts`) — so the colour
 * travels with duplication and templates exactly like every other authored
 * value in the doc, with no second place to keep it in sync. `resolveCanvas
 * Color` below re-validates it as defense-in-depth (the same "checked at the
 * write gate AND at render" posture as `pwBleedImage`'s URL checks) and
 * FAILS OPEN to `undefined` — a missing or invalid value renders exactly
 * today's default (white), never a broken CSS value or a thrown error.
 * Only `body`'s background moves; the container stays white/600px
 * (`DEFAULT_RENDERER_THEME.container`'s own defaults, untouched) — the
 * design constraint is "grey page, white card", not "recolour everything".
 *
 * `darkModeStyle()` below is unaffected by this: its `body { background: … }`
 * rule already carries `!important` and targets the SAME `<body>` tag
 * `bodyStyles` (in `maily.tsx`'s `markup()`) sets `backgroundColor` on
 * inline, dark-mode override semantics this fix doesn't change — a light
 * canvas colour is exactly the kind of light-mode-only style dark mode is
 * meant to override, same as it always did against the previous white
 * default.
 */
import type { JSONContent } from "@tiptap/core";
import { isHexColor, isPwFontStackId, PW_FONT_STACKS, type PwFontStackId } from "@events-os/shared";
import { Maily } from "./maily";
import { injectBeforeBodyClose, injectBeforeHeadClose, overrideColorSchemeMeta } from "./postprocess";
import { complianceFooterHtml, complianceFooterText, darkModeStyle } from "./complianceShell";

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

// `esc`/`complianceFooterHtml`/`complianceFooterText`/`darkModeStyle` used to
// live here as private helpers; extracted to `complianceShell.ts` (PR 2,
// "Paste HTML", 2026-07-30) so `renderEmailHtml.ts` reuses the EXACT same
// footer markup/copy and dark-mode rules rather than a second
// implementation that could drift — see that file's module doc for the full
// reasoning. Their doc comments (why this footer copy, why this dark-mode
// scope) now live there too.

/**
 * Read `doc.attrs.pwCanvasColor` off a tiptap doc, re-validated as defense-
 * in-depth on top of the write gate (`validateTiptapEmailDoc`'s
 * `validateDocAttrs`, `@events-os/shared`) — see this file's module doc, "The
 * page canvas colour". Anything not a valid hex string (absent, wrong type,
 * malformed) resolves to `undefined` rather than throwing or passing a bad
 * value through to a real CSS `background` — the caller then simply doesn't
 * call `maily.setTheme()`, which is exactly today's white-canvas default.
 */
function resolveCanvasColor(doc: JSONContent): string | undefined {
  const attrs = doc.attrs;
  if (!attrs || typeof attrs !== "object") return undefined;
  const value = (attrs as Record<string, unknown>).pwCanvasColor;
  return typeof value === "string" && isHexColor(value) ? value : undefined;
}

/**
 * Read `doc.attrs.pwFontFamily` off a tiptap doc (WS4, founder bug #5) —
 * same re-validated-as-defense-in-depth, fail-to-`undefined` posture as
 * `resolveCanvasColor` right above (the write gate already checked this at
 * save time; this is the render-time backstop, never a thrown error). An
 * absent/invalid value resolves to `undefined`, and the caller then simply
 * doesn't call `maily.setTheme({ font })` — exactly today's default (Inter,
 * unchanged) rather than a broken font declaration.
 */
function resolveFontStackId(doc: JSONContent): PwFontStackId | undefined {
  const attrs = doc.attrs;
  if (!attrs || typeof attrs !== "object") return undefined;
  const value = (attrs as Record<string, unknown>).pwFontFamily;
  return isPwFontStackId(value) ? value : undefined;
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

  // Only `body`'s background moves — the container stays white/600px (its
  // own `DEFAULT_RENDERER_THEME` defaults, left untouched by this partial
  // `setTheme()` merge). See this file's module doc, "The page canvas
  // colour", for why this reads off the DOCUMENT rather than a theme config.
  const canvasColor = resolveCanvasColor(doc);
  if (canvasColor) {
    maily.setTheme({ body: { backgroundColor: canvasColor } });
  }

  // The document FONT (WS4, founder bug #5) — same "document, not a theme
  // table" posture as the canvas colour right above. `PW_FONT_STACKS[id]`
  // is a `{fontFamily, fallbackFontFamily, webFont?}` triple maily's own
  // `<Font>` tag turns into a document-wide `* { font-family: … }` rule
  // (`maily.tsx`'s `markup()`) — see `emailFont.ts`'s module doc for why
  // these three stacks specifically.
  const fontStackId = resolveFontStackId(doc);
  if (fontStackId) {
    maily.setTheme({ font: PW_FONT_STACKS[fontStackId] });
  }

  const rawHtml = await maily.render();
  const rawText = await maily.render({ plainText: true });

  const withFooter = injectBeforeBodyClose(rawHtml, complianceFooterHtml(opts));
  const withMeta = overrideColorSchemeMeta(withFooter);
  const html = injectBeforeHeadClose(withMeta, darkModeStyle());

  const text = `${rawText.trim()}\n\n${complianceFooterText(opts)}\n`;

  return { html, text };
}
