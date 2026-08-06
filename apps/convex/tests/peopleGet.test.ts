import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import { newT, run, setupChapter, storeBlob } from "./setup.helpers";

describe("people.get", () => {
  test("resolves a stored photo to imageUrl, and null when there is none", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const storageId = await storeBlob(t);

    const withPhoto = await s.as.mutation(api.people.create, {
      name: "Ada Okafor",
      image: storageId,
    });
    const withoutPhoto = await s.as.mutation(api.people.create, {
      name: "No Photo",
    });

    const a = await s.as.query(api.people.get, { personId: withPhoto });
    const b = await s.as.query(api.people.get, { personId: withoutPhoto });

    expect(typeof a.imageUrl).toBe("string");
    expect(b.imageUrl).toBeNull();
  });
});
