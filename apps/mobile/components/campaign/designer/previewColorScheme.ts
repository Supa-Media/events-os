/**
 * PREVIEW COLOR SCHEME — the designer's Light/Dark toggle on the maily
 * preview pane (founder bug #3: "the preview is always dark mode").
 *
 * ── Root cause (seen in the harness, `__adv__/harness/`) ───────────────────
 * `renderEmailTiptap` (`packages/email-render/src/renderEmail.ts`) correctly
 * emits BOTH a light and a dark treatment for a real send — that's required,
 * unchanged by this fix (see this file's own constraint below): it overrides
 * maily's forced `<meta name="color-scheme" content="light">` to `"light
 * dark"`, and appends `<style id="pw-dark-mode">@media (prefers-color-
 * scheme: dark) { … }</style>` before `</head>`. That's exactly right for an
 * actual recipient's mail client, which resolves `prefers-color-scheme`
 * against ITS OWN OS/app setting. But `EmailHtmlPreview.web.tsx` drops that
 * same HTML into an `<iframe srcDoc>` inside OUR app, which resolves
 * `prefers-color-scheme` against the DESIGNER'S browser/OS setting — so
 * anyone previewing on a dark-mode machine saw the preview render dark by
 * default, with no way to see (or force) the light version, and no way to
 * confirm dark short of changing their OS setting.
 *
 * ── Why this can't be fixed with CSS alone ──────────────────────────────────
 * There is no standards-track way to make an `@media (prefers-color-scheme)`
 * query resolve differently INSIDE one iframe than the environment's actual
 * preference — the `color-scheme` CSS property/meta tag only changes the
 * browser's own default UI-widget rendering (form controls, scrollbar), not
 * media-query evaluation. So this is a POST-PROCESS of the rendered HTML: for
 * a forced "light" preview, delete the injected dark rules outright (nothing
 * left for any media query to match); for a forced "dark" preview, unwrap the
 * SAME rules from their `@media` guard so they apply unconditionally. Either
 * way, the untouched send-time HTML (`renderEmailTiptap`'s real output) never
 * changes — this only rewrites the STRING the preview iframe is handed,
 * exactly the "preview toggle is a VIEW control; the sent email keeps its
 * real light+dark behavior" constraint.
 *
 * ── Why regex, not DOMParser ─────────────────────────────────────────────
 * `renderEmail.ts#darkModeStyle` always emits ONE specific, single-level
 * block (`<style id="pw-dark-mode">…</style>`, no nested braces) — a targeted
 * string rewrite of that known shape is simpler and has no jsdom/DOMParser
 * environment dependency (this module is imported by both a `.web.tsx` file
 * and, indirectly, its Jest tests). Anything that doesn't match the expected
 * shape is passed through UNCHANGED (fail open) rather than throwing or
 * mangling the document — a preview that's occasionally still OS-themed is
 * far better than one that silently renders blank.
 */

const DARK_STYLE_RE = /<style id="pw-dark-mode">([\s\S]*?)<\/style>/;
// `darkModeStyle()` (`renderEmail.ts`) emits potentially SEVERAL rules inside
// the `@media` block (one per dark-mode target — currently `body` and
// `.pw-container`, more later is plausible), each ending in its own `}`. A
// naive lazy match up to the FIRST `}` (or first `}\n`) only captures the
// FIRST rule and silently drops the rest — caught by this file's own test
// the moment a second rule existed. The lookahead disambiguates the TRUE
// outer close (always immediately followed by the `[data-ogsc]` fallback
// block, or the end of the style tag if that's ever absent) from an inner
// rule's own closing brace, which is followed by more media-block content
// instead.
const MEDIA_BLOCK_RE = /@media \(prefers-color-scheme: dark\) \{\n([\s\S]*?)\n\}\n(?=\[data-ogsc\]|$)/;
const COLOR_SCHEME_META_RE = /(<meta name="color-scheme" content=")[^"]*(")/;
const SUPPORTED_SCHEMES_META_RE = /(<meta name="supported-color-schemes" content=")[^"]*(")/;

/**
 * Rewrite a `renderEmailTiptap`-produced HTML string so it resolves to
 * exactly `scheme` inside a preview iframe, regardless of the viewer's own
 * OS/browser dark-mode preference. Pure and total: an HTML string that
 * doesn't contain the expected `pw-dark-mode` block (a fetch that predates
 * this fix, a non-tiptap render path, a malformed string) is returned as-is.
 */
export function forceIframeColorScheme(html: string, scheme: "light" | "dark"): string {
  const match = html.match(DARK_STYLE_RE);
  if (!match) return html;

  const styleBlock = match[0];
  const rulesSource = match[1];

  let replacement: string;
  if (scheme === "light") {
    // No dark rules at all left to match ANY media query — the only way to
    // guarantee light regardless of the viewer's own OS preference.
    replacement = "";
  } else {
    // Unwrap the `@media (prefers-color-scheme: dark) { … }` guard so the
    // same rules apply unconditionally; leave the `[data-ogsc]` lines (an
    // Outlook/Android hook that nothing in a plain iframe ever sets, so they
    // don't hurt) untouched. `.replace` here only touches the matched WRAPPER
    // span (the `@media { … }` prelude/rules/close) — whatever came before or
    // after it in `rulesSource` (the `[data-ogsc]` fallback lines) is left
    // exactly where it was, not rebuilt from just the capture group.
    const unwrapped = rulesSource.replace(MEDIA_BLOCK_RE, "$1\n");
    replacement = `<style id="pw-dark-mode">\n${unwrapped}\n</style>`;
  }

  let out = html.slice(0, match.index) + replacement + html.slice((match.index ?? 0) + styleBlock.length);
  out = out.replace(COLOR_SCHEME_META_RE, `$1${scheme}$2`);
  out = out.replace(SUPPORTED_SCHEMES_META_RE, `$1${scheme}$2`);
  return out;
}
