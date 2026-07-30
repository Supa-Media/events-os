import { describe, expect, test } from "vitest";
import { decodeCssObfuscation, hasCssHazard } from "./emailHtmlCss";

describe("decodeCssObfuscation", () => {
  test("decodes a hex escape with a trailing space consumed", () => {
    expect(decodeCssObfuscation("@\\69 mport")).toBe("@import");
  });

  test("decodes a hex escape with no trailing whitespace before a non-hex char", () => {
    expect(decodeCssObfuscation("\\69mport")).toBe("import");
  });

  test("decodes a literal backslash-escaped character", () => {
    expect(decodeCssObfuscation("\\@import")).toBe("@import");
  });

  test("strips CSS comments", () => {
    expect(decodeCssObfuscation("@im/* hi */port")).toBe("@import");
  });

  test("leaves ordinary text untouched", () => {
    expect(decodeCssObfuscation("color:#891D1A;font-weight:bold")).toBe(
      "color:#891D1A;font-weight:bold",
    );
  });

  test("decodes multiple escapes in one string", () => {
    expect(decodeCssObfuscation("\\65\\78pression(1)")).toBe("expression(1)");
  });
});

describe("hasCssHazard", () => {
  test.each([
    ["@import url(https://evil/x.css)", true],
    ["expression(alert(1))", true],
    ["-moz-binding:url(evil.xml)", true],
    ["behavior:url(evil.htc)", true],
    ["background:url(javascript:alert(1))", true],
    ["background:url(VBScript:msgbox(1))", true],
    ["background:url(data:text/html;base64,x)", true],
    ["background:url(//tracker.example.com/pixel.gif)", true],
    ["color:#891D1A;font-weight:bold", false],
    ["background:url(https://cdn.example.com/a.png)", false],
    ["background:url(data:image/png;base64,x)", false],
  ] as const)("%s => %s", (css, expected) => {
    expect(hasCssHazard(css)).toBe(expected);
  });

  test("catches @import only after decoding an obfuscated escape (raw text alone wouldn't match)", () => {
    const raw = "@\\69 mport url(https://evil/x.css)";
    expect(hasCssHazard(raw)).toBe(false); // the raw regex alone doesn't see it
    expect(hasCssHazard(decodeCssObfuscation(raw))).toBe(true); // decoded, it does
  });
});
