import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import { newT, run, setupChapter } from "./setup.helpers";
import type { Id } from "../_generated/dataModel";
import type { TestConvex } from "./setup.helpers";

/**
 * `revertAiRun` correctness across the edit-then-delete sequence.
 *
 * Changes are reverted newest-first, so a `__deleted` change re-inserts its
 * snapshot (under a FRESH id) BEFORE the same run's earlier change rows are
 * processed. Those earlier rows reference the OLD item id — the revert must
 * remap old→new so:
 *   - field edits from the same run are rolled back on the re-inserted row
 *     (Undo restores the ORIGINAL values, not the AI's edits), and
 *   - a created-then-deleted item is NOT resurrected (the `__created` revert
 *     deletes the re-inserted row).
 */

async function seedEventWithItem(
  t: TestConvex,
  chapterId: Id<"chapters">,
  userId: Id<"users">,
) {
  return await run(t, async (ctx) => {
    const now = Date.now();
    const eventTypeId = await ctx.db.insert("eventTypes", {
      chapterId,
      name: "T",
      slug: "t",
      version: 1,
      isArchived: false,
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    });
    const eventId = await ctx.db.insert("events", {
      chapterId,
      eventTypeId,
      templateVersion: 1,
      name: "Revert Event",
      eventDate: now + 7 * 24 * 3600 * 1000,
      status: "planning",
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    });
    const itemId = await ctx.db.insert("eventItems", {
      eventId,
      chapterId,
      module: "planning_doc",
      title: "Original title",
      order: 0,
      status: "todo",
      fields: { notes: "original note" },
    });
    const runId = await ctx.db.insert("aiRuns", {
      chapterId,
      userId,
      feature: "assistant",
      eventId,
      model: "test-model",
      status: "running",
      itemsTouched: 0,
      costUsd: 0,
      createdAt: now,
    });
    return { eventId, itemId, runId };
  });
}

describe("ai.revertAiRun edit-then-delete", () => {
  test("edit then delete then revert restores the ORIGINAL field values", async () => {
    const t = newT();
    const { as, chapterId, userId } = await setupChapter(t);
    const { eventId, itemId, runId } = await seedEventWithItem(
      t,
      chapterId,
      userId,
    );

    // The run edits the item (promoted + custom field), then deletes it.
    await t.mutation(internal.ai.applyItemPatch, {
      runId,
      itemId,
      chapterId,
      promoted: { title: "AI renamed", status: "done" },
      fields: { notes: "AI note" },
    });
    await t.mutation(internal.ai.removeItem, { runId, itemId, chapterId });

    const res = await as.mutation(api.ai.revertAiRun, { runId });
    expect(res.skipped).toBe(0);

    // Exactly one item survives, restored to its PRE-RUN values (not the
    // AI-edited snapshot the delete captured).
    const items = await run(t, (ctx) =>
      ctx.db
        .query("eventItems")
        .withIndex("by_event", (q) => q.eq("eventId", eventId))
        .collect(),
    );
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("Original title");
    expect(items[0].status).toBe("todo");
    expect(items[0].fields?.notes).toBe("original note");
  });

  test("create then delete then revert leaves no item", async () => {
    const t = newT();
    const { as, chapterId, userId } = await setupChapter(t);
    const { eventId, runId } = await seedEventWithItem(t, chapterId, userId);

    const createdId = (await t.mutation(internal.ai.createItem, {
      runId,
      eventId,
      chapterId,
      module: "planning_doc",
      title: "Ephemeral",
    })) as Id<"eventItems">;
    await t.mutation(internal.ai.removeItem, {
      runId,
      itemId: createdId,
      chapterId,
    });

    await as.mutation(api.ai.revertAiRun, { runId });

    // The __deleted revert re-inserts it, then the __created revert must find
    // the re-inserted row (via the id remap) and delete it again.
    const items = await run(t, (ctx) =>
      ctx.db
        .query("eventItems")
        .withIndex("by_event", (q) => q.eq("eventId", eventId))
        .collect(),
    );
    expect(items.filter((it) => it.title === "Ephemeral")).toHaveLength(0);
    // The pre-seeded item is untouched.
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("Original title");
  });
});
