import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { internal } from "../_generated/api";
import { newT, run, setupChapter } from "./setup.helpers";
import type { Id } from "../_generated/dataModel";

/**
 * SECURITY characterization tests for the AI internal fns' tenant boundary.
 *
 * These are `internalQuery`/`internalMutation`s reachable from an action that
 * accepts arbitrary resource ids. They MUST confirm the resource's chapter
 * matches the `chapterId` threaded in from `myContext`:
 *   - reads (`eventContext`, `itemForAutofill`) return null on cross-chapter.
 *   - writes (`applyItemPatch`, `createItem`, `setItemPhoto`) THROW a
 *     ConvexError(FORBIDDEN) on cross-chapter.
 * Same-chapter calls succeed.
 */

/** Seed an event + one planning_doc item + an aiRun, all in `chapterId`. */
async function seedEventWithItem(
  t: ReturnType<typeof newT>,
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
      name: "Tenant Event",
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
      title: "A task",
      order: 0,
      status: "todo",
    });
    const runId = await ctx.db.insert("aiRuns", {
      chapterId,
      userId,
      feature: "test",
      eventId,
      model: "test-model",
      status: "running",
      itemsTouched: 0,
      costUsd: 0,
      createdAt: now,
    });
    const storageId = await (
      ctx.storage as unknown as {
        store: (b: Blob) => Promise<Id<"_storage">>;
      }
    ).store(new Blob(["x"], { type: "image/png" }));
    return { eventId, itemId, runId, storageId };
  });
}

describe("ai.eventContext (read) tenant boundary", () => {
  test("same-chapter → returns the event context", async () => {
    const t = newT();
    const { chapterId, userId } = await setupChapter(t);
    const { eventId } = await seedEventWithItem(t, chapterId, userId);

    const ctx = await t.query(internal.ai.eventContext, { eventId, chapterId });
    expect(ctx).not.toBeNull();
    expect(ctx!.event.id).toBe(eventId);
    expect(ctx!.items).toHaveLength(1);
  });

  test("cross-chapter → returns null", async () => {
    const t = newT();
    const a = await setupChapter(t, { email: "a@publicworship.life" });
    const b = await setupChapter(t, {
      email: "b@publicworship.life",
      chapterName: "Other Chapter",
    });
    const { eventId } = await seedEventWithItem(t, a.chapterId, a.userId);

    // Event belongs to chapter A, but we pass chapter B's id.
    const ctx = await t.query(internal.ai.eventContext, {
      eventId,
      chapterId: b.chapterId,
    });
    expect(ctx).toBeNull();
  });

  test("the assignable-people vocabulary excludes placeholders, sample people, and contact-only rows", async () => {
    const t = newT();
    const { chapterId, userId } = await setupChapter(t);
    const { eventId } = await seedEventWithItem(t, chapterId, userId);
    const now = Date.now();
    await run(t, async (ctx) => {
      await ctx.db.insert("people", {
        chapterId,
        name: "Real Volunteer",
        createdAt: now,
      });
      await ctx.db.insert("people", {
        chapterId,
        name: "A Placeholder",
        isPlaceholder: true,
        createdAt: now,
      });
      await ctx.db.insert("people", {
        chapterId,
        name: "A Sample Person",
        isSamplePerson: true,
        createdAt: now,
      });
      // Person-centric audiences Phase 1 — auto-created from a donor gift, an
      // import, or a public RSVP; never a real assignee for `assign_role`/
      // `set_workstream_owner`.
      await ctx.db.insert("people", {
        chapterId,
        name: "Auto-created Contact",
        isContactOnly: true,
        createdAt: now,
      });
    });

    const ctx = await t.query(internal.ai.eventContext, { eventId, chapterId });
    expect(ctx).not.toBeNull();
    const names = (ctx as any).people.map((p: any) => p.name);
    expect(names).toContain("Real Volunteer");
    expect(names).not.toContain("A Placeholder");
    expect(names).not.toContain("A Sample Person");
    expect(names).not.toContain("Auto-created Contact");
  });
});

describe("ai.itemForAutofill (read) tenant boundary", () => {
  test("same-chapter → returns the item; cross-chapter → null", async () => {
    const t = newT();
    const a = await setupChapter(t, { email: "a2@publicworship.life" });
    const b = await setupChapter(t, {
      email: "b2@publicworship.life",
      chapterName: "Other 2",
    });
    const { itemId } = await seedEventWithItem(t, a.chapterId, a.userId);

    const ok = await t.query(internal.ai.itemForAutofill, {
      itemId,
      chapterId: a.chapterId,
    });
    expect(ok).not.toBeNull();
    expect(ok!.title).toBe("A task");

    const cross = await t.query(internal.ai.itemForAutofill, {
      itemId,
      chapterId: b.chapterId,
    });
    expect(cross).toBeNull();
  });
});

describe("ai.applyItemPatch (write) tenant boundary", () => {
  test("same-chapter → patches the item", async () => {
    const t = newT();
    const { chapterId, userId } = await setupChapter(t);
    const { itemId, runId } = await seedEventWithItem(t, chapterId, userId);

    await t.mutation(internal.ai.applyItemPatch, {
      runId,
      itemId,
      chapterId,
      promoted: { title: "Renamed" },
    });
    const item = await run(t, (ctx) => ctx.db.get(itemId));
    expect(item!.title).toBe("Renamed");
  });

  test("cross-chapter → throws FORBIDDEN", async () => {
    const t = newT();
    const a = await setupChapter(t, { email: "a3@publicworship.life" });
    const b = await setupChapter(t, {
      email: "b3@publicworship.life",
      chapterName: "Other 3",
    });
    const { itemId, runId } = await seedEventWithItem(t, a.chapterId, a.userId);

    await expect(
      t.mutation(internal.ai.applyItemPatch, {
        runId,
        itemId,
        chapterId: b.chapterId,
        promoted: { title: "Hijacked" },
      }),
    ).rejects.toThrow(ConvexError);
    // Item is untouched.
    const item = await run(t, (ctx) => ctx.db.get(itemId));
    expect(item!.title).toBe("A task");
  });
});

describe("ai.createItem (write) tenant boundary", () => {
  test("same-chapter → creates an item; cross-chapter → throws FORBIDDEN", async () => {
    const t = newT();
    const a = await setupChapter(t, { email: "a4@publicworship.life" });
    const b = await setupChapter(t, {
      email: "b4@publicworship.life",
      chapterName: "Other 4",
    });
    const { eventId, runId } = await seedEventWithItem(t, a.chapterId, a.userId);

    const newItemId = await t.mutation(internal.ai.createItem, {
      runId,
      eventId,
      chapterId: a.chapterId,
      module: "planning_doc",
      title: "AI added",
    });
    expect(newItemId).not.toBeNull();

    await expect(
      t.mutation(internal.ai.createItem, {
        runId,
        eventId,
        chapterId: b.chapterId,
        module: "planning_doc",
        title: "Cross-tenant add",
      }),
    ).rejects.toThrow(ConvexError);
  });
});

describe("ai.setItemPhoto (write) tenant boundary", () => {
  test("same-chapter → sets photo; cross-chapter → throws FORBIDDEN", async () => {
    const t = newT();
    const a = await setupChapter(t, { email: "a5@publicworship.life" });
    const b = await setupChapter(t, {
      email: "b5@publicworship.life",
      chapterName: "Other 5",
    });
    const { itemId, runId, storageId } = await seedEventWithItem(
      t,
      a.chapterId,
      a.userId,
    );

    await t.mutation(internal.ai.setItemPhoto, {
      runId,
      itemId,
      chapterId: a.chapterId,
      storageId,
    });
    const item = await run(t, (ctx) => ctx.db.get(itemId));
    expect(item!.fields?.photo).toBe(storageId);

    await expect(
      t.mutation(internal.ai.setItemPhoto, {
        runId,
        itemId,
        chapterId: b.chapterId,
        storageId,
      }),
    ).rejects.toThrow(ConvexError);
  });
});
