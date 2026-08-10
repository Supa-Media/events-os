/**
 * WHAT IS THIS FILE, REALLY — read from the bytes, not the metadata.
 *
 * `receiptFileKind` (@events-os/shared) answers from the stored content type
 * and filename, which is right for ~every row and costs nothing. This is the
 * fallback for the rows where BOTH of those are silent — historical receipts
 * uploaded before their path recorded anything, and files whose content type
 * a client set to `application/octet-stream` because it couldn't work it out
 * either.
 *
 * WHY SNIFFING RATHER THAN A BACKFILL: a data migration can only fix the rows
 * that exist when it runs, and it would have to open every stored file to work
 * out what to write anyway. Sniffing does that same read, lazily, only for the
 * files that actually need it, and it stays correct for anything that arrives
 * mislabelled in future. Nothing has to be written to the database at all.
 *
 * WHEN IT RUNS: only after an optimistic image render has already FAILED. The
 * common path — a photo, or anything with a usable content type — never
 * touches this, so it costs nothing in the case that matters for speed.
 *
 * It also answers the question `<Image onError>` cannot: "did that fail
 * because the file isn't an image, or because there is no file?" Those need
 * different words on screen, and telling them apart is what stops a missing
 * file from rendering as an empty frame.
 */
import type { ReceiptFileKind } from "@events-os/shared";

/** `"missing"` = the bytes could not be fetched at all (deleted, expired,
 *  offline). Distinct from every real file kind, and worth saying out loud. */
export type SniffedKind = ReceiptFileKind | "missing";

/** How many leading bytes are enough to recognise every signature below. */
export const SNIFF_BYTES = 16;

/**
 * Classify a file from its leading bytes. Pure and synchronous so the
 * signature table is directly testable without a network.
 */
export function kindFromMagicBytes(bytes: Uint8Array): ReceiptFileKind {
  const b = bytes;
  const at = (i: number) => b[i] ?? -1;
  const ascii = (start: number, text: string) =>
    [...text].every((ch, i) => at(start + i) === ch.charCodeAt(0));

  // %PDF
  if (ascii(0, "%PDF")) return "pdf";

  // JPEG (FF D8 FF), PNG (89 P N G), GIF8, BMP (BM)
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image";
  if (at(0) === 0x89 && ascii(1, "PNG")) return "image";
  if (ascii(0, "GIF8")) return "image";
  if (ascii(0, "BM")) return "image";
  // RIFF....WEBP
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "image";
  // TIFF, both byte orders
  if (at(0) === 0x49 && at(1) === 0x49 && at(2) === 0x2a && at(3) === 0x00) return "image";
  if (at(0) === 0x4d && at(1) === 0x4d && at(2) === 0x00 && at(3) === 0x2a) return "image";
  // ISO-BMFF brands: HEIC/HEIF/AVIF all start `....ftyp<brand>`
  if (ascii(4, "ftyp")) {
    const brand = String.fromCharCode(at(8), at(9), at(10), at(11));
    if (["heic", "heix", "hevc", "mif1", "msf1", "heif", "avif"].includes(brand)) {
      return "image";
    }
  }

  // Text-ish: an HTML/plain email body. Checked last so a binary format that
  // happens to start with a `<` can't be mistaken for one.
  if (at(0) === 0x3c) return "document"; // '<'
  if (ascii(0, "From:") || ascii(0, "Return-Path")) return "document"; // .eml

  return "unknown";
}

/**
 * Fetch just the head of `url` and classify it. Returns `"missing"` when the
 * bytes can't be read at all.
 *
 * Asks for a byte RANGE so a 40MB scan doesn't get pulled down to answer a
 * 16-byte question; a server that ignores `Range` simply answers 200 and we
 * read the first bytes off what arrives.
 */
export async function sniffFileKind(url: string): Promise<SniffedKind> {
  try {
    const res = await fetch(url, {
      headers: { Range: `bytes=0-${SNIFF_BYTES - 1}` },
    });
    if (!res.ok && res.status !== 206) return "missing";
    const buf = await res.arrayBuffer();
    if (buf.byteLength === 0) return "missing";
    return kindFromMagicBytes(new Uint8Array(buf.slice(0, SNIFF_BYTES)));
  } catch {
    return "missing";
  }
}
