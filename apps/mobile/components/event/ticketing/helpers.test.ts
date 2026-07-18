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

import { eventPageUrl } from "./helpers";

/**
 * The client mirror of the backend `eventPageUrl`: it composes the admin
 * "share this link" string off `publicSiteUrl()` + the public "/event/" path
 * segment. This change switched that segment from the terse "/e/" to "/event/"
 * (the "/e/" prefix stays alive server-side as a backward-compat alias).
 *
 * Note: `EXPO_PUBLIC_*` vars are inlined at build time by babel-preset-expo, so
 * the base-URL half (`publicSiteUrl`, unchanged by this PR) can't be varied at
 * test runtime here — this pins the part this change actually introduced: the
 * path segment.
 */
describe("eventPageUrl", () => {
  test("uses the /event/<slug> segment, not the legacy /e/", () => {
    const url = eventPageUrl("summer-night");
    expect(url).toContain("/event/summer-night");
    expect(url).not.toContain("/e/summer-night");
    expect(url.endsWith("/event/summer-night")).toBe(true);
  });
});
