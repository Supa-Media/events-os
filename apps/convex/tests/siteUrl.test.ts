import { afterEach, describe, expect, test } from "vitest";
import { eventPageUrl, eventPath, siteUrl } from "../lib/siteUrl";

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

describe("eventPath / eventPageUrl", () => {
  test("eventPath builds the /event/<slug> relative path", () => {
    expect(eventPath("summer-night")).toBe("/event/summer-night");
    expect(eventPath("summer-night", "cover")).toBe("/event/summer-night/cover");
    expect(eventPath("summer-night", "calendar.ics")).toBe(
      "/event/summer-night/calendar.ics",
    );
  });

  test("eventPageUrl composes the absolute branded URL under PUBLIC_SITE_URL", () => {
    process.env.PUBLIC_SITE_URL = "https://publicworship.life";
    expect(eventPageUrl("summer-night")).toBe(
      "https://publicworship.life/event/summer-night",
    );
    expect(eventPageUrl("summer-night", "cover")).toBe(
      "https://publicworship.life/event/summer-night/cover",
    );
  });

  test("eventPageUrl trims a trailing slash on the base (no //event/)", () => {
    process.env.PUBLIC_SITE_URL = "https://publicworship.life/";
    expect(eventPageUrl("summer-night")).toBe(
      "https://publicworship.life/event/summer-night",
    );
  });
});
