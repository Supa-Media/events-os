import { describe, expect, test } from "vitest";
import { merchantMatch } from "../lib/merchantSimilarity";

/**
 * Unit tests for the shared merchant-similarity primitive
 * (`lib/merchantSimilarity.ts`) — no Convex harness needed.
 *
 * These lived in `codingEvidence.test.ts` until the AI coding-suggestion
 * pipeline (its only other consumer) was removed. `reconcileSuggest`'s tier-2
 * "we've coded a SIMILAR charge to this budget before" evidence still leans on
 * `merchantMatch`, and the exact/fuzzy/null grading is the whole of that
 * signal, so it keeps its own test rather than riding along in a caller's.
 */
describe("merchantMatch (shared similarity primitive)", () => {
  test("exact normalized-merchant match beats fuzzy", () => {
    expect(
      merchantMatch({ merchantName: "Office Depot" }, { merchantName: "office depot" }),
    ).toBe("exact");
  });
  test("token overlap (noise words stripped) is fuzzy", () => {
    expect(
      merchantMatch(
        { merchantName: "SQ *HOME DEPOT INC" },
        { merchantName: "Home Depot Supply Co" },
      ),
    ).toBe("fuzzy");
  });
  test("no shared tokens → null", () => {
    expect(
      merchantMatch({ merchantName: "Office Depot" }, { merchantName: "Delta Airlines" }),
    ).toBeNull();
  });
});
