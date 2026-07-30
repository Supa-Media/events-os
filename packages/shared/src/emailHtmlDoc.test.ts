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
