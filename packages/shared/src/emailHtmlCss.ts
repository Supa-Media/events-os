/**
 * CSS de-obfuscation + hazard detection shared by BOTH "Paste HTML" safety
 * layers — the REAL sanitizer (`apps/convex/lib/emailHtmlSanitize.ts`,
 * which uses this to decide what to STRIP) and the write-time regex
 * backstop (`emailHtmlDoc.ts`, this same package, which uses this to decide
 * what to REJECT). One place, so the two can't drift on what counts as a
 * CSS-level hazard — an adversarial-review finding (2026-07-30) caught
 * exactly that kind of drift: the write-time backstop's hazard list didn't
 * cover what the real sanitizer was already handling.
 *
 * ── Why de-obfuscation is needed at all ─────────────────────────────────────
 * CSS allows escaping ANY character with a backslash — either a hex code
 * point (`\69` = "i", optionally followed by ONE whitespace character that's
 * consumed as part of the escape) or a literal backslash-escaped character
 * (`\@` = "@"). `@\69 mport url(...)` is byte-for-byte `@import url(...)`
 * to any real CSS parser, but a naive `/@import/` regex never matches it. A
 * CSS comment split across the keyword achieves the same trick.
 * `decodeCssObfuscation` collapses both (strip comments, decode escapes)
 * BEFORE any hazard regex runs, so hiding a keyword behind CSS's own escape
 * syntax doesn't work here either.
 *
 * This is deliberately NOT a CSS parser — it doesn't understand selectors,
 * declarations, or values structurally, only enough string-level
 * de-obfuscation to make regex hazard-matching escape-aware. See
 * `emailHtmlSanitize.ts`'s own doc for how the sanitizer turns a "hazard
 * found" verdict into an actual removal (drop the whole `<style>` block or
 * `style="..."` attribute containing it, never a surgical in-place edit of
 * decoded text back onto the original string).
 */

/** Strip CSS comments, then decode CSS backslash escapes (hex or literal).
 *  Pure string manipulation — safe to run on arbitrary text (HTML doesn't
 *  use backslash escapes at all, so this only ever ADDS matches within CSS
 *  content, never mangles surrounding markup meaningfully for a
 *  detection-only pass). */
export function decodeCssObfuscation(css: string): string {
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  // Hex escape: backslash + 1-6 hex digits + an OPTIONAL single trailing
  // whitespace char, consumed as part of the escape per the CSS spec.
  const hexDecoded = noComments.replace(
    /\\([0-9a-fA-F]{1,6})[ \t\n\r\f]?/g,
    (_match, hex: string) => {
      try {
        return String.fromCodePoint(parseInt(hex, 16));
      } catch {
        return "";
      }
    },
  );
  // Any other backslash-escaped character is just that character, literally.
  return hexDecoded.replace(/\\(.)/g, "$1");
}

/** Tested against DE-OBFUSCATED text (`decodeCssObfuscation`'s output),
 *  never raw/possibly-escaped text directly — see this file's module doc.
 *
 *   - `@import` — could pull in an attacker-controlled stylesheet.
 *   - `expression(` — legacy IE "CSS as code execution".
 *   - `-moz-binding:` / `behavior:` — legacy Gecko/IE "CSS as code
 *     execution" via an external XML/HTC behavior file.
 *   - `url(javascript:…)` / `url(vbscript:…)` — a CSS value context where a
 *     script URL has no legitimate use.
 *   - `url(data:…)` for a non-image MIME type — the same non-image-`data:`
 *     concern `emailHtmlSanitize.ts`'s `<img src>` `exclusiveFilter` already
 *     covers for the tag context; covered here for the CSS-value context
 *     too, since sanitize-html doesn't parse `style` attribute values.
 *   - `url(//…)` protocol-relative — a real "Paste HTML" re-host pipeline
 *     (`emailHtmlImport.ts`) always resolves every discovered image
 *     reference to either a re-hosted absolute URL or an inert local
 *     placeholder before this ever runs; a protocol-relative reference
 *     surviving to this point is either a hand-crafted bypass attempt or a
 *     pipeline bug, and either way should never ship. */
const CSS_HAZARD_PATTERNS: readonly RegExp[] = [
  /@\s*import/i,
  /expression\s*\(/i,
  /-moz-binding\s*:/i,
  /behavior\s*:/i,
  /url\(\s*['"]?\s*(javascript|vbscript)\s*:/i,
  /url\(\s*['"]?\s*data\s*:(?!image\/)/i,
  /url\(\s*['"]?\s*\/\//i,
];

/** True iff `decoded` (already run through `decodeCssObfuscation`) contains
 *  any known CSS-level hazard. */
export function hasCssHazard(decoded: string): boolean {
  return CSS_HAZARD_PATTERNS.some((re) => re.test(decoded));
}
