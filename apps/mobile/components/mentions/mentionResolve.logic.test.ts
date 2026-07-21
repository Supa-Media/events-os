// No @types/jest / ambient globals configured for this package — import test
// globals explicitly from @jest/globals instead of adding a new dependency.
import { describe, expect, test } from "@jest/globals";
import { resolveMentionToken } from "./mentionResolve.logic";

/**
 * `resolveMentionToken` turns a parsed mention token into "who to link to,
 * right now" against data the Duties grid already has on the client
 * (`people`, `chapterSeatHoldings`). A role mention resolves via a live
 * lookup, not a stored id, so the link stays correct as a seat changes
 * hands — these tests pin both the happy path and every dangling-reference
 * case (deleted person, vacant seat, data-integrity mismatch) that must
 * degrade to `null` rather than throw.
 */
describe("resolveMentionToken", () => {
  test("resolves a person token against people", () => {
    expect(
      resolveMentionToken(
        { type: "person", id: "p1", label: "Jordan" },
        { people: [{ _id: "p1", name: "Jordan Kupo" }], seatHoldings: [] },
      ),
    ).toEqual({ personId: "p1", displayName: "Jordan Kupo" });
  });

  test("a person token whose id isn't in people resolves to null", () => {
    expect(
      resolveMentionToken(
        { type: "person", id: "p1", label: "Jordan" },
        { people: [], seatHoldings: [] },
      ),
    ).toBeNull();
  });

  test("resolves a seat token to its current holder", () => {
    expect(
      resolveMentionToken(
        { type: "seat", id: "s1", label: "Music Director" },
        {
          people: [{ _id: "p2", name: "Alex" }],
          seatHoldings: [{ personId: "p2", seatDefId: "s1" }],
        },
      ),
    ).toEqual({ personId: "p2", displayName: "Alex" });
  });

  test("a seat token with no matching holding (vacant seat) resolves to null", () => {
    expect(
      resolveMentionToken(
        { type: "seat", id: "s1", label: "Music Director" },
        { people: [{ _id: "p2", name: "Alex" }], seatHoldings: [] },
      ),
    ).toBeNull();
  });

  test("a seat token whose holding's personId isn't in people resolves to null, not a throw", () => {
    expect(
      resolveMentionToken(
        { type: "seat", id: "s1", label: "Music Director" },
        {
          people: [],
          seatHoldings: [{ personId: "p2", seatDefId: "s1" }],
        },
      ),
    ).toBeNull();
  });
});
