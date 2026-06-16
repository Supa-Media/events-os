import { expect, test } from "vitest";
import { api } from "../_generated/api";
import { newT, setupChapter } from "./setup.helpers";

test("setupChapter yields an authed client that resolves a chapter", async () => {
  const t = newT();
  const { as } = await setupChapter(t);
  // eventTypes.list returns [] for a fresh chapter — proves auth + chapter resolve.
  const types = await as.query(api.eventTypes.list, {});
  expect(types).toEqual([]);
});
