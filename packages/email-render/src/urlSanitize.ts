/**
 * WS1 addition (not upstream) — the RENDER-TIME URL scheme chokepoint.
 *
 * ── Why this file exists (HIGH finding, adversarial review 2026-07-29) ──────
 * `tiptapEmail.ts#checkUrlAttr` (the write gate, `@events-os/shared`)
 * correctly SKIPS its scheme allowlist whenever a node's `isXVariable` sibling
 * flag is `true` — in that case the doc attr holds a variable NAME
 * (`"firstName"`), not a literal URL, so there is nothing to scheme-check at
 * write time. The renderer resolves that name to a real value at render time
 * (`Maily#variableUrlValue`/`linkValues`, `maily.tsx`) — and until this file
 * existed, NONE of those resolutions were scheme-checked. The variable map a
 * real send builds (`apps/convex/lib/tiptapCampaignRender.ts#tiptapMergeVariables`)
 * includes `firstName`/`name` straight off the RECIPIENT's own profile — a
 * hostile recipient name (`"javascript:alert(1)"`, `"vbscript:msgbox(1)"`,
 * `"data:text/html,<script>…"`) lands in that map, and a campaign author only
 * has to mark ONE link/image `isUrlVariable`/`isSrcVariable` and reference
 * `firstName` for that hostile string to reach a real `href`/`src` in every
 * recipient's inbox. React-dom's own `javascript:` guard (`sanitizeUrl`) is
 * NOT a substitute for this — it throws on `javascript:` specifically and
 * passes every other scheme (`vbscript:`, `data:`, …) straight through
 * unchanged; see this package's tests for the proof.
 *
 * ── The chokepoint ───────────────────────────────────────────────────────────
 * Every href/src `maily.tsx` ever puts into real JSX — whether the doc attr
 * was a literal URL (redundant with the write gate, but see `tiptapEmail.ts`'s
 * own module doc: never trust that a stored value was written through the
 * gate) or a variable-resolved one (the actual gap) — is passed through
 * `safeRenderHref`/`safeRenderImageSrc` below, ONCE, immediately before it is
 * used as a prop. Nothing upstream of these two functions is trusted; nothing
 * downstream reads the raw value again. `pwBleedImage`'s pre-existing
 * post-resolution check (the one sink that already re-validated, see its own
 * doc in `maily.tsx`) is folded into this same chokepoint rather than left as
 * a second, slightly different implementation.
 *
 * ── Scheme semantics — mirrors `tiptapEmail.ts`'s write gate exactly ────────
 * `isAllowedLinkUrl`/`isAllowedImageUrl` (`@events-os/shared`, the exact
 * functions the write gate itself uses) are the scheme check: http/https/
 * mailto for anything that becomes an `href`, http/https only for anything
 * that becomes an image `src`. Both are already case/whitespace-insensitive at
 * the boundary (`urlScheme` lowercases and trims before matching) and FAIL
 * CLOSED — a string whose scheme prefix doesn't parse as a bare
 * `[a-zA-Z][a-zA-Z0-9+.-]*:` token has no recognized scheme at all, which is
 * rejected the same as an explicitly disallowed one, not treated as
 * implicitly safe. That fail-closed behavior is what defeats the classic
 * embedded-whitespace bypass (`"java\tscript:alert(1)"` — browsers' URL
 * parsers strip embedded tab/newline before resolving the scheme, so this
 * decodes to `javascript:` in an actual browser) WITHOUT this file needing its
 * own whitespace-stripping pass: the tab breaks the regex's contiguous
 * scheme-character match, `urlScheme` returns `null`, and `null` is rejected
 * exactly like a disallowed scheme — see `urlSanitize.test.ts` for the pinned
 * proof.
 *
 * ── The one addition beyond the write gate: root-relative paths ────────────
 * A subset of the values THIS renderer resolves are not author-typed at all —
 * they are server-BUILT (`apps/convex/campaigns.ts`'s per-recipient poll vote
 * URL, delivered through the exact same `variableValues` map as a hostile
 * recipient name). `lib/siteUrl.ts` returns `""` when neither
 * `PUBLIC_SITE_URL` nor `CONVEX_SITE_URL` is configured, so that URL is
 * legitimately root-relative (`/poll/<campaignId>/<token>/<blockId>/<optId>`)
 * in exactly that deployment state — the same situation
 * `packages/shared/src/emailRender.ts#safeUnsubscribeHref` was written to
 * handle for the blocks-format unsubscribe link, and this file matches that
 * function's reasoning (not its code — `emailRender.ts` is the OLD blocks
 * renderer's own render-time defense-in-depth layer, out of this package's
 * dependency graph on purpose, the same "ported, not imported" posture
 * `tiptapEmail.ts`'s own module doc explains for its copy of the scheme
 * allowlist) rather than depending on it: a value beginning with exactly one
 * `/` (not two, not `/\`) is passed through unchanged; `//evil.example` and
 * `/\evil.example` are PROTOCOL-RELATIVE (several URL parsers fold `/\` into
 * `//`) and resolve to an attacker's host, not a path on this one, so both
 * are rejected same as any other unrecognized scheme.
 *
 * Image `src`s do NOT get the root-relative allowance — nothing in this
 * codebase ever builds a root-relative image URL (uploaded artwork is always
 * an absolute `https://` storage URL), so extending the allowance there would
 * be new surface with no legitimate caller, not a fix for one.
 */
import { isAllowedImageUrl, isAllowedLinkUrl } from "@events-os/shared";

/** A leading single `/` not immediately followed by another `/` or a `\` —
 *  see this file's module doc, "The one addition beyond the write gate". */
function isRootRelativePath(value: string): boolean {
  return /^\/(?![/\\])/.test(value);
}

/**
 * Sanitize a fully-resolved value for use as a real `href` — the
 * post-resolution half of every link-bearing sink in `maily.tsx` (the `link`
 * mark, `button.url`, `linkCard.link`, `image`/`inlineImage`'s `externalLink`,
 * `logo`/`pwBleedImage`'s `href`, `pwPoll`'s per-option vote link). Not a
 * string, empty/blank, or an unrecognized/disallowed scheme all fall back to
 * `fallback` (default `"#"`, matching `packages/shared/src/emailRender.ts
 * #safeEmailHref`'s convention for the same failure) — NEVER the raw value.
 */
export function safeRenderHref(value: unknown, fallback = "#"): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (trimmed === "") return fallback;
  if (isRootRelativePath(trimmed)) return trimmed;
  return isAllowedLinkUrl(trimmed) ? trimmed : fallback;
}

/**
 * Sanitize a fully-resolved value for use as a real image `src` — the
 * post-resolution half of every image-bearing sink in `maily.tsx` (`image`/
 * `logo`/`inlineImage`/`pwBleedImage`'s `src`). Anything that isn't an
 * http(s) URL renders as an EMPTY string (no image request at all — the "no-
 * image path"), matching `emailRender.ts#safeImageSrc`'s convention, never
 * the raw value.
 */
export function safeRenderImageSrc(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (trimmed === "") return "";
  return isAllowedImageUrl(trimmed) ? trimmed : "";
}
