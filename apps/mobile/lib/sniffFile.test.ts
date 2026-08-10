// No @types/jest / ambient globals configured for this package — import test
// globals explicitly from @jest/globals (mirrors `receiptsTab/helpers.test.ts`).
import { describe, expect, test } from "@jest/globals";
import { kindFromMagicBytes } from "./sniffFile";

/**
 * The last-resort detector: what a file IS, read from its own bytes.
 *
 * This is the answer to "what about historical rows that carry neither a
 * content type nor a filename?" — rather than a backfill that could only fix
 * the rows existing on the day it ran, the viewer asks the file itself, and
 * only when the optimistic image render has already failed.
 */
const bytes = (...vals: (number | string)[]) => {
  const out: number[] = [];
  for (const v of vals) {
    if (typeof v === "number") out.push(v);
    else for (const ch of v) out.push(ch.charCodeAt(0));
  }
  return new Uint8Array(out);
};

describe("kindFromMagicBytes", () => {
  test("a PDF, whatever its metadata claimed", () => {
    expect(kindFromMagicBytes(bytes("%PDF-1.7\n%"))).toBe("pdf");
  });

  test("the image formats a receipt actually arrives as", () => {
    expect(kindFromMagicBytes(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe("image"); // JPEG
    expect(kindFromMagicBytes(bytes(0x89, "PNG", 0x0d, 0x0a))).toBe("image");
    expect(kindFromMagicBytes(bytes("GIF89a"))).toBe("image");
    expect(kindFromMagicBytes(bytes("BM", 0x36, 0x00))).toBe("image");
    expect(kindFromMagicBytes(bytes("RIFF", 0, 0, 0, 0, "WEBP"))).toBe("image");
    expect(kindFromMagicBytes(bytes(0x49, 0x49, 0x2a, 0x00))).toBe("image"); // TIFF LE
    expect(kindFromMagicBytes(bytes(0x4d, 0x4d, 0x00, 0x2a))).toBe("image"); // TIFF BE
  });

  test("an iPhone HEIC — the single most likely unlabelled receipt", () => {
    expect(kindFromMagicBytes(bytes(0, 0, 0, 0x18, "ftyp", "heic"))).toBe("image");
    expect(kindFromMagicBytes(bytes(0, 0, 0, 0x18, "ftyp", "mif1"))).toBe("image");
    expect(kindFromMagicBytes(bytes(0, 0, 0, 0x18, "ftyp", "avif"))).toBe("image");
  });

  test("an emailed body", () => {
    expect(kindFromMagicBytes(bytes("<!DOCTYPE html>"))).toBe("document");
    expect(kindFromMagicBytes(bytes("<html>"))).toBe("document");
    expect(kindFromMagicBytes(bytes("From: a@b.com"))).toBe("document");
  });

  test("an unrecognised video container is NOT called an image just for ftyp", () => {
    expect(kindFromMagicBytes(bytes(0, 0, 0, 0x18, "ftyp", "mp42"))).toBe("unknown");
  });

  test("genuinely unrecognisable bytes say so rather than guessing", () => {
    expect(kindFromMagicBytes(bytes(0x00, 0x01, 0x02, 0x03))).toBe("unknown");
    expect(kindFromMagicBytes(new Uint8Array())).toBe("unknown");
  });
});
