// No @types/jest / ambient globals configured for this package — import test
// globals explicitly from @jest/globals instead of adding a new dependency.
import { describe, expect, jest, test } from "@jest/globals";
import { addPersonAndGetOpenId } from "./addPerson.logic";

/**
 * `addPersonAndGetOpenId` decides what the "Add person" row does with the
 * `create` mutation's outcome: hand back the new id (so the caller opens its
 * detail sheet) on success, or hand back the caught error (so the caller can
 * surface it) on failure — the rejection must never escape uncaught.
 */
describe("addPersonAndGetOpenId", () => {
  test("returns the new person's id on success", async () => {
    const create = jest.fn(async () => "person123");
    await expect(addPersonAndGetOpenId(create)).resolves.toEqual({ id: "person123" });
  });

  test("catches a rejection and returns it as an error instead of throwing", async () => {
    const failure = new Error("network hiccup");
    const create = jest.fn(async () => {
      throw failure;
    });
    await expect(addPersonAndGetOpenId(create)).resolves.toEqual({ error: failure });
  });

  test("calls create with the default 'New person' name", async () => {
    const create = jest.fn(async () => "person123");
    await addPersonAndGetOpenId(create);
    expect(create).toHaveBeenCalledWith({ name: "New person" });
  });
});
