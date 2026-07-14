import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import { newT, run, setupChapter } from "./setup.helpers";
import type { Id } from "../_generated/dataModel";
import type { TestConvex } from "./setup.helpers";

/**
 * The inventory assistant's revertible ASSET edits. The `assets` table has no
 * `fields` bag, so every change is logged by a promoted field name (or the
 * `__created`/`__deleted` markers) and `revertAiRun` restores it — the
 * chapter-scoped sibling of the event-item revert path.
 */

async function seedAssetWithRun(
  t: TestConvex,
  chapterId: Id<"chapters">,
  userId: Id<"users">,
) {
  return await run(t, async (ctx) => {
    const now = Date.now();
    const assetId = await ctx.db.insert("assets", {
      chapterId,
      name: "Original speaker",
      tags: ["audio"],
      quantity: 2,
      acquired: true,
      order: 0,
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    });
    const runId = await ctx.db.insert("aiRuns", {
      chapterId,
      userId,
      feature: "inventory_assistant",
      model: "test-model",
      status: "running",
      itemsTouched: 0,
      costUsd: 0,
      createdAt: now,
    });
    return { assetId, runId };
  });
}

describe("inventory assistant asset revert", () => {
  test("applyAssetPatch then revert restores the ORIGINAL field values", async () => {
    const t = newT();
    const { as, chapterId, userId } = await setupChapter(t);
    const { assetId, runId } = await seedAssetWithRun(t, chapterId, userId);

    await t.mutation(internal.ai.applyAssetPatch, {
      runId,
      assetId,
      chapterId,
      patch: { name: "AI renamed", quantity: 9, condition: "broken" },
    });

    let asset = await run(t, (ctx) => ctx.db.get(assetId));
    expect(asset?.name).toBe("AI renamed");
    expect(asset?.quantity).toBe(9);
    expect(asset?.condition).toBe("broken");

    const res = await as.mutation(api.ai.revertAiRun, { runId });
    expect(res.skipped).toBe(0);

    asset = await run(t, (ctx) => ctx.db.get(assetId));
    expect(asset?.name).toBe("Original speaker");
    expect(asset?.quantity).toBe(2);
    expect(asset?.condition).toBeUndefined();
  });

  test("create then delete then revert leaves no asset", async () => {
    const t = newT();
    const { as, chapterId, userId } = await setupChapter(t);
    const { runId } = await seedAssetWithRun(t, chapterId, userId);

    const createdId = (await t.mutation(internal.ai.createAssetFromAgent, {
      runId,
      chapterId,
      userId,
      name: "Ephemeral cable",
      quantity: 3,
    })) as Id<"assets">;

    await t.mutation(internal.ai.removeAssetFromAgent, {
      runId,
      assetId: createdId,
      chapterId,
    });

    await as.mutation(api.ai.revertAiRun, { runId });

    // The pre-seeded asset survives; the created-then-deleted one does not
    // resurrect (the __deleted revert re-inserts it, then __created deletes it).
    const assets = await run(t, (ctx) =>
      ctx.db
        .query("assets")
        .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
        .collect(),
    );
    expect(assets.filter((a) => a.name === "Ephemeral cable")).toHaveLength(0);
    expect(assets).toHaveLength(1);
    expect(assets[0].name).toBe("Original speaker");
  });
});
