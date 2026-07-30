import { describe, expect, test } from "vitest";
import { sniffImageMime } from "../lib/imageSniff";

/**
 * `lib/imageSniff.ts` — the byte-level "is this actually an image?" check that
 * replaced the import action's `content-type` header check (founder bug,
 * 2026-07-30: "the images aren't loading" — Canva's own CDN serves real PNGs
 * with no content-type header at all, so every image failed). See that file's
 * module doc for why bytes, not headers, and why SVG is deliberately absent.
 */

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

function ascii(text: string, padTo = 0): Uint8Array {
  const encoded = Array.from(text, (char) => char.charCodeAt(0));
  while (encoded.length < padTo) encoded.push(0);
  return new Uint8Array(encoded);
}

describe("sniffImageMime — recognizes what a design-tool export actually contains", () => {
  test("PNG", () => {
    expect(sniffImageMime(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0))).toBe(
      "image/png",
    );
  });

  test("JPEG", () => {
    expect(sniffImageMime(bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0))).toBe("image/jpeg");
  });

  test("GIF (both 87a and 89a — an animated Canva GIF is 89a)", () => {
    expect(sniffImageMime(ascii("GIF89a....", 12))).toBe("image/gif");
    expect(sniffImageMime(ascii("GIF87a....", 12))).toBe("image/gif");
  });

  test("WebP — needs BOTH the RIFF prefix and the WEBP tag at offset 8", () => {
    const webp = new Uint8Array(16);
    webp.set(ascii("RIFF"), 0);
    webp.set([0x10, 0, 0, 0], 4); // chunk size — arbitrary
    webp.set(ascii("WEBP"), 8);
    expect(sniffImageMime(webp)).toBe("image/webp");

    // RIFF alone is a container format (WAV, AVI) — not an image.
    const wav = new Uint8Array(16);
    wav.set(ascii("RIFF"), 0);
    wav.set(ascii("WAVE"), 8);
    expect(sniffImageMime(wav)).toBeNull();
  });

  test("BMP", () => {
    expect(sniffImageMime(ascii("BM..........", 12))).toBe("image/bmp");
  });
});

describe("sniffImageMime — refuses everything else", () => {
  test("an HTML error page a CDN served with a 200", () => {
    expect(sniffImageMime(ascii("<html><body>Not found</body></html>", 40))).toBeNull();
  });

  test("an all-zero buffer (a plausible-looking body that is not an image)", () => {
    expect(sniffImageMime(new Uint8Array(2048))).toBeNull();
  });

  test("an SVG — a script-bearing document, deliberately not re-hostable", () => {
    expect(sniffImageMime(ascii('<svg xmlns="http://www.w3.org/2000/svg"></svg>', 48))).toBeNull();
  });

  test("empty, and shorter than any signature", () => {
    expect(sniffImageMime(new Uint8Array(0))).toBeNull();
    expect(sniffImageMime(bytes(0x89, 0x50))).toBeNull();
  });

  test("an image signature that appears LATER in the body doesn't count", () => {
    const late = new Uint8Array(32);
    late.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 16);
    expect(sniffImageMime(late)).toBeNull();
  });
});
