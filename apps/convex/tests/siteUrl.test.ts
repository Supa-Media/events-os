import { afterEach, describe, expect, test } from "vitest";
import { siteUrl } from "../lib/siteUrl";

/**
 * siteUrl() picks the base for every guest-facing link (pages, OG tags,
 * Stripe return URLs, emails): the custom domain when configured, else the
 * deployment's built-in .convex.site domain.
 */

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("siteUrl", () => {
  test("prefers PUBLIC_SITE_URL (custom domain) over CONVEX_SITE_URL", () => {
    process.env.PUBLIC_SITE_URL = "https://rsvp.publicworship.life";
    process.env.CONVEX_SITE_URL = "https://something.convex.site";
    expect(siteUrl()).toBe("https://rsvp.publicworship.life");
  });

  test("falls back to CONVEX_SITE_URL when no custom domain is set", () => {
    delete process.env.PUBLIC_SITE_URL;
    process.env.CONVEX_SITE_URL = "https://something.convex.site";
    expect(siteUrl()).toBe("https://something.convex.site");
  });

  test("strips trailing slashes so callers can append paths", () => {
    process.env.PUBLIC_SITE_URL = "https://rsvp.publicworship.life/";
    expect(siteUrl()).toBe("https://rsvp.publicworship.life");
  });
});
