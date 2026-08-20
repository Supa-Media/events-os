// No @types/jest / ambient globals configured for this package — import test
// globals explicitly from @jest/globals instead of adding a new dependency.
import { describe, expect, jest, test } from "@jest/globals";
import { addPersonAndGetOpenId } from "./addPerson.logic";

/**
 * `addPersonAndGetOpenId` decides what the Add Person modal does with the
 * `create` mutation's outcome: hand back the new id (so the caller opens its
 * detail sheet) on success, or hand back the caught error (so the caller can
 * surface it) on failure — the rejection must never escape uncaught. It hands
 * the caller's fully-built args straight through to `create`, rather than
 * defaulting a bare name (see `addPersonForm.logic.ts#buildAddPersonArgs`,
 * which builds those args).
 */
describe("addPersonAndGetOpenId", () => {
  test("returns the new person's id on success", async () => {
    const create = jest.fn(async () => "person123");
    await expect(
      addPersonAndGetOpenId(create, { name: "Ada Lovelace" }),
    ).resolves.toEqual({ id: "person123" });
  });

  test("catches a rejection and returns it as an error instead of throwing", async () => {
    const failure = new Error("network hiccup");
    const create = jest.fn(async () => {
      throw failure;
    });
    await expect(
      addPersonAndGetOpenId(create, { name: "Ada Lovelace" }),
    ).resolves.toEqual({ error: failure });
  });

  test("passes the given args through to create verbatim", async () => {
    const create = jest.fn(async () => "person123");
    const args = { name: "Ada Lovelace", email: "ada@example.com" };
    await addPersonAndGetOpenId(create, args);
    expect(create).toHaveBeenCalledWith(args);
  });
});
