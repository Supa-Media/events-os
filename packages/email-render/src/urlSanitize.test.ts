/**
 * Unit tests for the render-time URL scheme chokepoint (`urlSanitize.ts`) —
 * see that file's module doc for why it exists. `maily.urlSanitize.test.ts`
 * covers the same ground through the full `Maily` renderer, at every actual
 * sink; this file pins the two functions' OWN contract in isolation.
 */
import { describe, expect, test } from "vitest";
import { safeRenderHref, safeRenderImageSrc } from "./urlSanitize";

describe("safeRenderHref", () => {
  test("allows http:, https:, and mailto:", () => {
    expect(safeRenderHref("http://example.com")).toBe("http://example.com");
    expect(safeRenderHref("https://example.com/a?b=c")).toBe("https://example.com/a?b=c");
    expect(safeRenderHref("mailto:hello@example.com")).toBe("mailto:hello@example.com");
  });

  test("allows a single-leading-slash root-relative path (server-built unsubscribe/poll URLs)", () => {
    expect(safeRenderHref("/unsubscribe/tok123")).toBe("/unsubscribe/tok123");
    expect(safeRenderHref("/poll/campaign1/tok123/poll1/opt_a")).toBe("/poll/campaign1/tok123/poll1/opt_a");
  });

  test("rejects protocol-relative `//` — resolves to an attacker's host, not a path on ours", () => {
    expect(safeRenderHref("//evil.example/phish")).toBe("#");
  });

  test("rejects `/\\` — several URL parsers fold this into `//` (protocol-relative)", () => {
    expect(safeRenderHref("/\\evil.example/phish")).toBe("#");
  });

  for (const scheme of ["javascript:", "vbscript:", "data:", "file:", "ftp:"]) {
    test(`rejects ${scheme} — never a raw value, falls back to "#"`, () => {
      expect(safeRenderHref(`${scheme}alert(1)`)).toBe("#");
    });
  }

  test("proven hostile payloads from the adversarial review land safe, not raw", () => {
    expect(safeRenderHref("javascript:alert(document.cookie)")).toBe("#");
    expect(safeRenderHref("vbscript:msgbox(1)")).toBe("#");
    expect(safeRenderHref("data:text/html,<script>alert(1)</script>")).toBe("#");
  });

  test("case-insensitive scheme match", () => {
    expect(safeRenderHref("JAVASCRIPT:alert(1)")).toBe("#");
    expect(safeRenderHref("JavaScript:alert(1)")).toBe("#");
    expect(safeRenderHref("HTTPS://example.com")).toBe("HTTPS://example.com");
  });

  test("whitespace-insensitive at the boundary (leading/trailing)", () => {
    expect(safeRenderHref("   javascript:alert(1)")).toBe("#");
    expect(safeRenderHref("\tjavascript:alert(1)")).toBe("#");
    expect(safeRenderHref("\njavascript:alert(1)  ")).toBe("#");
    expect(safeRenderHref("  https://example.com  ")).toBe("https://example.com");
  });

  test("embedded-whitespace scheme obfuscation fails CLOSED (not merely fails to bypass)", () => {
    // Browsers' own URL parsers strip embedded tab/newline before resolving
    // a scheme (`new URL("java\tscript:x").protocol === "javascript:"` in
    // Node/V8) — the classic bypass for a naive "does this literally start
    // with an allowed scheme" check. This function never special-cases that:
    // the embedded control character breaks the contiguous scheme match, so
    // no scheme is recognized at all, and "no recognized scheme" is REJECTED
    // exactly like an explicit `javascript:` — see `urlSanitize.ts`'s module
    // doc for why fail-closed makes this safe without extra stripping logic.
    expect(safeRenderHref("java\tscript:alert(1)")).toBe("#");
    expect(safeRenderHref("java\nscript:alert(1)")).toBe("#");
  });

  test("non-string, empty, and blank values fall back", () => {
    expect(safeRenderHref(undefined)).toBe("#");
    expect(safeRenderHref(null)).toBe("#");
    expect(safeRenderHref(42)).toBe("#");
    expect(safeRenderHref({})).toBe("#");
    expect(safeRenderHref("")).toBe("#");
    expect(safeRenderHref("   ")).toBe("#");
  });

  test("scheme-less relative strings (no leading slash) are not implicitly safe", () => {
    expect(safeRenderHref("example.com")).toBe("#");
    expect(safeRenderHref("#anchor")).toBe("#");
  });

  test("a custom fallback is honored (image-wrap sinks pass '' so an invalid link is treated as absent)", () => {
    expect(safeRenderHref("javascript:alert(1)", "")).toBe("");
    expect(safeRenderHref(undefined, "")).toBe("");
    expect(safeRenderHref("https://example.com", "")).toBe("https://example.com");
  });
});

describe("safeRenderImageSrc", () => {
  test("allows http: and https:", () => {
    expect(safeRenderImageSrc("http://example.com/a.png")).toBe("http://example.com/a.png");
    expect(safeRenderImageSrc("https://example.com/a.png")).toBe("https://example.com/a.png");
  });

  test("rejects mailto: — never a legitimate image scheme", () => {
    expect(safeRenderImageSrc("mailto:hello@example.com")).toBe("");
  });

  test("does NOT extend the root-relative allowance to images — no legitimate caller builds one", () => {
    expect(safeRenderImageSrc("/uploads/a.png")).toBe("");
  });

  for (const scheme of ["javascript:", "vbscript:", "data:", "file:"]) {
    test(`rejects ${scheme} — falls back to the empty "no-image" src`, () => {
      expect(safeRenderImageSrc(`${scheme}alert(1)`)).toBe("");
    });
  }

  test("proven hostile payloads land safe", () => {
    expect(safeRenderImageSrc("data:text/html,<script>alert(1)</script>")).toBe("");
    expect(safeRenderImageSrc("javascript:alert(1)")).toBe("");
  });

  test("case/whitespace-insensitive", () => {
    expect(safeRenderImageSrc("JAVASCRIPT:alert(1)")).toBe("");
    expect(safeRenderImageSrc("  javascript:alert(1)")).toBe("");
    expect(safeRenderImageSrc("java\tscript:alert(1)")).toBe("");
  });

  test("non-string, empty, and blank values fall back to the empty src", () => {
    expect(safeRenderImageSrc(undefined)).toBe("");
    expect(safeRenderImageSrc(null)).toBe("");
    expect(safeRenderImageSrc(7)).toBe("");
    expect(safeRenderImageSrc("")).toBe("");
    expect(safeRenderImageSrc("   ")).toBe("");
  });
});
