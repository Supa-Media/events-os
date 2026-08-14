// No @types/jest / ambient globals configured for this package — import test
// globals explicitly from @jest/globals (mirrors the sibling colocated tests).
import { describe, expect, jest, test } from "@jest/globals";

// The site-base resolver reads build-time-inlined `EXPO_PUBLIC_*` env, which a
// test can't set meaningfully (see `ticketing/helpers.test.ts`'s note) — and it
// isn't what's under test here. Pin it so the assertions are about the URL
// SHAPE, which is the thing a contractor actually receives.
jest.mock("../components/event/ticketing/helpers", () => ({
  publicSiteUrl: () => "https://publicworship.life",
}));

import { contractLinkFor, slugifyChapterName } from "./contractLinkUrl";

/**
 * The shape has to match `apps/convex/contractorPayments.ts#contractUrl`
 * exactly: the app's "copy link" and the server's agreement email must hand the
 * same person the same string, or one of them is wrong and nobody finds out
 * until a contractor says the link doesn't work.
 */
describe("contractLinkFor", () => {
  test("builds `<site>/contract/<slug>?token=<token>`", () => {
    expect(contractLinkFor("new-york", "abc-123")).toBe(
      "https://publicworship.life/contract/new-york?token=abc-123",
    );
  });

  test("percent-encodes both halves", () => {
    expect(contractLinkFor("new york", "a b&c")).toBe(
      "https://publicworship.life/contract/new%20york?token=a%20b%26c",
    );
  });

  test("refuses to build a half-link when either half is missing", () => {
    expect(contractLinkFor("", "abc")).toBeNull();
    expect(contractLinkFor("new-york", "")).toBeNull();
  });
});

describe("slugifyChapterName", () => {
  test("matches how chapter slugs are minted", () => {
    expect(slugifyChapterName("New York")).toBe("new-york");
    expect(slugifyChapterName("  Queens, NY  ")).toBe("queens-ny");
  });

  test("an unsluggable name yields an empty candidate, never a bad one", () => {
    expect(slugifyChapterName("!!!")).toBe("");
  });
});
