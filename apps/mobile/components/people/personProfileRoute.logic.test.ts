// No @types/jest / ambient globals configured for this package — import test
// globals explicitly from @jest/globals instead of adding a new dependency.
import { describe, expect, test } from "@jest/globals";
import { personProfileRoute } from "./personProfileRoute.logic";

/**
 * `personProfileRoute` centralizes the `/people?openId=<id>` deep-link
 * contract so the one remaining navigation caller — PersonDetailModal's
 * "View full profile" button — can't drift from what the People tab's
 * `useLocalSearchParams` consumes.
 */
describe("personProfileRoute", () => {
  test("builds the People tab deep link for a person id", () => {
    expect(personProfileRoute("p1")).toBe("/people?openId=p1");
  });
});
