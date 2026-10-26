import { describe, expect, test } from "@jest/globals";
import { cleanConvexMessage } from "./convexErrorText";

describe("cleanConvexMessage", () => {
  test("a redacted prod server error has no readable reason", () => {
    expect(
      cleanConvexMessage(
        "[CONVEX A(auth:signIn)] [Request ID: ce88ecb6b91e4773] Server Error\n  Called by client",
      ),
    ).toBeNull();
  });

  test("a dev uncaught error keeps only the reason", () => {
    expect(
      cleanConvexMessage(
        "[CONVEX M(cards:save)] [Request ID: abc] Uncaught Error: Amount must be positive\n    at handler (../cards.ts:12:9)\n  Called by client",
      ),
    ).toBe("Amount must be positive");
  });

  test("a message that isn't from Convex is left alone", () => {
    expect(cleanConvexMessage("Network request failed")).toBe("Network request failed");
  });
});
