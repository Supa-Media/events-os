import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { api } from "../_generated/api";
import { newT, setupChapter, storeBlob } from "./setup.helpers";

/**
 * Characterization test for `storage.getUrl` auth gating. A stored URL is
 * directly servable, so a logged-out caller must NOT be able to resolve an
 * arbitrary `_storage` id — the query throws on an unauthenticated call.
 */
describe("storage.getUrl auth gating", () => {
  test("unauthenticated call throws", async () => {
    const t = newT();
    const storageId = await storeBlob(t);
    // No withIdentity → requireUserId throws.
    await expect(t.query(api.storage.getUrl, { storageId })).rejects.toThrow(
      ConvexError,
    );
  });

  test("authenticated call resolves the stored id to a URL", async () => {
    const t = newT();
    const { as } = await setupChapter(t);
    const storageId = await storeBlob(t);
    const url = await as.query(api.storage.getUrl, { storageId });
    expect(url).toBeTruthy();
  });
});
