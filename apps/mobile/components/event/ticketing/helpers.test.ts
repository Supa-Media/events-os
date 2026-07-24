// No @types/jest / ambient globals configured for this package — import test
// globals explicitly from @jest/globals (mirrors the sibling colocated tests).
import { describe, expect, jest, test } from "@jest/globals";

// helpers.ts imports `react-native` (Alert/Platform) for confirmAction; this
// pure-node jest config doesn't transform node_modules, so stub it out — the
// URL helper under test doesn't touch it.
jest.mock("react-native", () => ({
  Platform: { OS: "web" },
  Alert: { alert: () => {} },
}));

import { rsvpPageUrl, resolvePublicSiteUrl } from "./helpers";

/**
 * `resolvePublicSiteUrl` is the pure core of `publicSiteUrl()` — it picks the
 * public-page base URL from the (explicit) site-URL override and the Convex URL.
 * It's tested directly because babel-preset-expo inlines `EXPO_PUBLIC_*` at build
 * time, so `publicSiteUrl()` itself can't be exercised with test-time env.
 */
describe("resolvePublicSiteUrl", () => {
  test("an explicit EXPO_PUBLIC_SITE_URL override always wins (trailing slash trimmed)", () => {
    expect(
      resolvePublicSiteUrl(
        "https://custom.example.com/",
        "https://vivid-rhinoceros-688.convex.cloud",
      ),
    ).toBe("https://custom.example.com");
  });

  test("prod: the prod Convex deployment maps to the branded domain with no override", () => {
    expect(
      resolvePublicSiteUrl("", "https://vivid-rhinoceros-688.convex.cloud"),
    ).toBe("https://publicworship.life");
  });

  test("other cloud deployments derive the .convex.site host", () => {
    expect(
      resolvePublicSiteUrl("", "https://sunny-otter-123.convex.cloud"),
    ).toBe("https://sunny-otter-123.convex.site");
  });

  test("local backend serves http routes on the next port up", () => {
    expect(resolvePublicSiteUrl("", "http://127.0.0.1:3210")).toBe(
      "http://127.0.0.1:3211",
    );
  });
});

/**
 * The client mirror of the backend `rsvpPageUrl`: it composes the admin
 * "share this link" string off `publicSiteUrl()` + the canonical public
 * "/rsvp/" path segment (the "/r/", "/event/" and "/e/" prefixes stay alive
 * server-side as aliases so already-shared links never break).
 */
describe("rsvpPageUrl", () => {
  test("uses the canonical /rsvp/<slug> segment", () => {
    const url = rsvpPageUrl("summer-night");
    expect(url).toContain("/rsvp/summer-night");
    expect(url.endsWith("/rsvp/summer-night")).toBe(true);
  });
});
