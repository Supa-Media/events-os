import { describe, expect, test } from "vitest";
import type { EmailTheme } from "@events-os/shared";
import { DEFAULT_EMAIL_THEME } from "@events-os/shared";
import { emailShell, emailParagraph } from "../lib/emailShell";

/**
 * `emailShell` is the transactional/bulk shell every non-campaign email is
 * wrapped in. Its two untrusted seams:
 *
 *  1. `bulk.unsubscribeUrl` — interpolated into an `href`. It used to be
 *     interpolated RAW, sitting on the line beside a correctly-escaped
 *     `orgAddress`, and was strictly weaker than the `emailButton` href it was
 *     modelled on: that one is a constant a developer writes three lines up,
 *     this one carries a minted token and travels through `blasts.ts`.
 *  2. `theme` — an `EmailTheme` PARAMETER whose own docstring invites threading
 *     a per-org `emailThemes` DB ROW through it. `EmailTheme` describes a row's
 *     shape; it does not enforce it. Every token lands in either a `style="…"`
 *     attribute or the `<style>` block, where HTML entities are NOT decoded and
 *     escaping is no defense — so the shell must NORMALIZE, exactly as
 *     `renderCampaignEmail` does with `doc.theme`.
 */

const inner = emailParagraph("Hello");

/** Every `style="…"` attribute in the document. */
function styleAttrs(html: string): string[] {
  return html.match(/style="[^"]*"/g) ?? [];
}

/** Just the `<style>` block's contents. */
function styleBlockOf(html: string): string {
  return /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? "";
}

describe("emailShell — bulk unsubscribe href (SECURITY)", () => {
  const orgAddress = "1 Example St, London";

  test("a url that closes the attribute cannot produce a <script> element", () => {
    const html = emailShell(inner, DEFAULT_EMAIL_THEME, {
      unsubscribeUrl: 'https://ok.test/u"><script>PWNED</script><a href="',
      orgAddress,
    });
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("PWNED</script>");
    // The break-out characters survive only as entities.
    expect(html).toContain("&quot;&gt;&lt;script&gt;");
  });

  test("a javascript: url never reaches the href", () => {
    const html = emailShell(inner, DEFAULT_EMAIL_THEME, {
      unsubscribeUrl: "javascript:alert(1)",
      orgAddress,
    });
    expect(html).not.toContain("javascript:");
    expect(html).toContain('href="#"');
  });

  test("a normal per-recipient url is untouched", () => {
    const html = emailShell(inner, DEFAULT_EMAIL_THEME, {
      unsubscribeUrl: "https://app.example.com/unsubscribe/tok123",
      orgAddress,
    });
    expect(html).toContain('href="https://app.example.com/unsubscribe/tok123"');
    expect(html).toContain(orgAddress);
  });

  test("the root-relative url an unconfigured siteUrl() yields still renders", () => {
    // `blasts.ts` builds `${siteUrl()}/unsubscribe/${token}`, and `siteUrl()`
    // is "" with neither PUBLIC_SITE_URL nor CONVEX_SITE_URL set. Sanitizing
    // that away would drop the opt-out CAN-SPAM requires.
    const html = emailShell(inner, DEFAULT_EMAIL_THEME, {
      unsubscribeUrl: "/unsubscribe/tok123",
      orgAddress,
    });
    expect(html).toContain('href="/unsubscribe/tok123"');
  });

  test("a protocol-relative url pointing at another host is rejected", () => {
    const html = emailShell(inner, DEFAULT_EMAIL_THEME, {
      unsubscribeUrl: "//evil.test/unsubscribe",
      orgAddress,
    });
    expect(html).not.toContain("evil.test");
    expect(html).toContain('href="#"');
  });

  test("omitting `bulk` still emits no unsubscribe furniture at all", () => {
    const html = emailShell(inner);
    expect(html.toLowerCase()).not.toContain("unsubscribe");
  });
});

describe("emailShell — theme normalization (SECURITY)", () => {
  /** The shape a hand-written or hand-edited `emailThemes` row can take: the
   *  right keys, values that were never validated. */
  const maliciousTheme = {
    ...DEFAULT_EMAIL_THEME,
    canvas: '#ffffff" onload="alert(1)',
    surface: "#000 !important} body{display:none",
    bodyFont: "Inter;}</style><script>PWNED</script>{x:y",
    headingFont: "Georgia;}body{display:none",
    muted: "#fff;}*{display:none",
  } as unknown as EmailTheme;

  test("a malicious token cannot break out of a style attribute", () => {
    const html = emailShell(inner, maliciousTheme);
    for (const attr of styleAttrs(html)) {
      expect(attr).not.toContain("{");
      expect(attr).not.toContain("}");
      expect(attr).not.toContain("<");
      expect(attr).not.toContain("onload");
    }
    expect(html).not.toContain("onload=");
  });

  test("a malicious token cannot open a second CSS rule in the <style> block", () => {
    const html = emailShell(inner, maliciousTheme);
    // Exactly one style element, and no script element — the font stack cannot
    // close the block. (`safeFontStack` strips the punctuation and keeps the
    // letters, so the WORD "script" surviving as a nonsense font name is the
    // documented, inert outcome; a `<script>` TAG is not.)
    expect(html.match(/<style>/g)).toHaveLength(1);
    expect(html.match(/<\/style>/g)).toHaveLength(1);
    expect(html).not.toContain("<script");
    expect(html).not.toContain("</script");
    // And the hex tokens cannot inject a rule of their own.
    expect(styleBlockOf(html)).not.toContain("display:none");
    expect(styleBlockOf(html)).not.toContain("!important}");
  });

  test("an unusable token degrades to the brand's value, not to 'undefined'", () => {
    const html = emailShell(inner, maliciousTheme);
    expect(html).not.toContain("undefined");
    expect(html).toContain(`background:${DEFAULT_EMAIL_THEME.canvas}`);
    expect(html).toContain(`background:${DEFAULT_EMAIL_THEME.surface}`);
  });

  test("a partial/garbage theme is survivable rather than fatal", () => {
    const html = emailShell(inner, { name: "Nope" } as unknown as EmailTheme);
    expect(html).toContain("<!doctype html>");
    expect(html).not.toContain("undefined");
  });

  test("a LEGITIMATE custom theme still paints the email", () => {
    // Normalizing must not mean ignoring: a valid per-org row still wins.
    const custom = {
      ...DEFAULT_EMAIL_THEME,
      name: "Advent",
      canvas: "#f4f9fc",
      surface: "#eef2ff",
      wordmark: "ADVENT",
    };
    const html = emailShell(inner, custom);
    expect(html).toContain("background:#f4f9fc");
    expect(html).toContain("background:#eef2ff");
    expect(html).toContain("ADVENT");
  });
});
