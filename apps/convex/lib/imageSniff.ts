/**
 * Byte-level image sniffing for the "Paste HTML" import pipeline
 * (`emailHtmlImport.ts`). Pure and dependency-free so it's unit-testable
 * without the Convex runtime, same split as `emailHtmlSanitize.ts`.
 *
 * ── Why this exists (2026-07-30 founder bug: "the images aren't loading") ──
 * The import action used to decide "is this actually an image?" from the
 * response's `content-type` header alone. That rejected EVERY image in a real
 * Canva export: Canva serves an emailed design's assets from
 * `<hash>.canva-cdn.email` behind Cloudflare, which returns the PNG/GIF body
 * with `cache-control`, `content-length` — and NO `content-type` header at
 * all. Every image "failed", every reference was rewritten to the inert 1×1
 * placeholder, and the newsletter arrived blank (and mis-spaced — see
 * `preserveFailedImageAspect`).
 *
 * A missing/wrong `content-type` is a transport detail; the BYTES are the
 * truth. So the check moved here, and it is strictly STRONGER than the header
 * check it replaced: a response now has to actually BE one of the raster
 * formats below to get re-hosted, no matter what its header claims. A server
 * that says `image/png` and returns HTML is refused, where before it was
 * stored and re-served from our own storage domain.
 *
 * ── Why raster-only (no SVG) ────────────────────────────────────────────────
 * An SVG is a script-bearing document, not a bitmap — re-hosting one would
 * put attacker-authored markup on a URL we serve, which is exactly the
 * confused-deputy shape the rest of this pipeline exists to avoid. No design
 * tool's HTML export needs it (Canva rasterizes everything), so SVG is not on
 * the list and an SVG reference simply fails the import like any other
 * unfetchable image. This is a deliberate tightening of the previous
 * header-only behavior, which WOULD have accepted `content-type:
 * image/svg+xml`.
 */

/** The raster formats a mail client can be relied on to render inline, and
 *  the MIME type each one is stored/served as. */
export type SniffedImageMime =
  | "image/png"
  | "image/jpeg"
  | "image/gif"
  | "image/webp"
  | "image/bmp";

/** Longest prefix any signature below needs (WebP's `RIFF….WEBP` = 12). */
const MAX_SIGNATURE_BYTES = 12;

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  for (let i = 0; i < signature.length; i++) {
    if (bytes[offset + i] !== signature[i]) return false;
  }
  return true;
}

/** ASCII helper — every signature here is ASCII-or-binary, never Unicode. */
function ascii(text: string): number[] {
  return Array.from(text, (char) => char.charCodeAt(0));
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];
const GIF87A = ascii("GIF87a");
const GIF89A = ascii("GIF89a");
const RIFF = ascii("RIFF");
const WEBP = ascii("WEBP"); // at offset 8, after `RIFF` + 4 size bytes
const BMP = ascii("BM");

/**
 * The image MIME type `bytes` actually is, or `null` if the bytes don't match
 * any format this pipeline re-hosts. Only the first
 * `MAX_SIGNATURE_BYTES` matter — pass the whole body or just its head.
 */
export function sniffImageMime(bytes: Uint8Array): SniffedImageMime | null {
  const head = bytes.length > MAX_SIGNATURE_BYTES ? bytes.subarray(0, MAX_SIGNATURE_BYTES) : bytes;
  if (startsWith(head, PNG)) return "image/png";
  if (startsWith(head, JPEG)) return "image/jpeg";
  if (startsWith(head, GIF87A) || startsWith(head, GIF89A)) return "image/gif";
  if (startsWith(head, RIFF) && startsWith(head, WEBP, 8)) return "image/webp";
  if (startsWith(head, BMP)) return "image/bmp";
  return null;
}
