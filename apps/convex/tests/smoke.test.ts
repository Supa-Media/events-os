import { expect, test } from "vitest";
import { api } from "../_generated/api";
import { newT, setupChapter } from "./setup.helpers";

/**
 * A smoke test for the shared test harness itself (`setupChapter` / `newT`
 * in `setup.helpers.ts`), not for `eventTypes`. Every other Convex suite
 * builds on `setupChapter` to get an authed, chapter-scoped client — if the
 * harness's auth + chapter + allowlist wiring ever breaks, this is the test
 * that should fail first and point straight at the harness instead of a
 * confusing failure in an unrelated suite.
 */

test("setupChapter yields an authed client that resolves a chapter", async () => {
  const t = newT();
  const { as } = await setupChapter(t);
  // eventTypes.list returns [] for a fresh chapter — proves auth + chapter resolve.
  const types = await as.query(api.eventTypes.list, {});
  expect(types).toEqual([]);
});
