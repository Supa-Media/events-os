import { afterEach, describe, expect, test } from "vitest";
import { rsvpPageUrl, rsvpPath, siteUrl } from "../lib/siteUrl";

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
    process.env.PUBLIC_SITE_URL = "https://publicworship.life";
    process.env.CONVEX_SITE_URL = "https://something.convex.site";
    expect(siteUrl()).toBe("https://publicworship.life");
  });

  test("falls back to CONVEX_SITE_URL when no custom domain is set", () => {
    delete process.env.PUBLIC_SITE_URL;
    process.env.CONVEX_SITE_URL = "https://something.convex.site";
    expect(siteUrl()).toBe("https://something.convex.site");
  });

  test("strips trailing slashes so callers can append paths", () => {
    process.env.PUBLIC_SITE_URL = "https://publicworship.life/";
    expect(siteUrl()).toBe("https://publicworship.life");
  });
});

describe("rsvpPath / rsvpPageUrl", () => {
  test("rsvpPath builds the /rsvp/<slug> relative path", () => {
    expect(rsvpPath("summer-night")).toBe("/rsvp/summer-night");
    expect(rsvpPath("summer-night", "cover")).toBe("/rsvp/summer-night/cover");
    expect(rsvpPath("summer-night", "calendar.ics")).toBe(
      "/rsvp/summer-night/calendar.ics",
    );
  });

  test("rsvpPageUrl composes the absolute branded URL under PUBLIC_SITE_URL", () => {
    process.env.PUBLIC_SITE_URL = "https://publicworship.life";
    expect(rsvpPageUrl("summer-night")).toBe(
      "https://publicworship.life/rsvp/summer-night",
    );
    expect(rsvpPageUrl("summer-night", "cover")).toBe(
      "https://publicworship.life/rsvp/summer-night/cover",
    );
  });

  test("rsvpPageUrl trims a trailing slash on the base (no //rsvp/)", () => {
    process.env.PUBLIC_SITE_URL = "https://publicworship.life/";
    expect(rsvpPageUrl("summer-night")).toBe(
      "https://publicworship.life/rsvp/summer-night",
    );
  });
});
