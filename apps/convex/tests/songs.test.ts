import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { api } from "../_generated/api";
import { newT, run, setupChapter } from "./setup.helpers";
import type { Id } from "../_generated/dataModel";

/**
 * Characterization tests for the Songs module.
 *
 * Covers the end-to-end loop: build a library + setlist (authed), the anonymous
 * public request flow, the single-current invariant, the closed-requests gate,
 * and the cross-tenant guard on a publicly-supplied songId.
 */

/** Insert a minimal event in `chapterId` and return its id. */
async function makeEvent(
  t: ReturnType<typeof newT>,
  chapterId: Id<"chapters">,
  userId: Id<"users">,
): Promise<Id<"events">> {
  return await run(t, async (ctx) => {
    const now = Date.now();
    const eventTypeId = await ctx.db.insert("eventTypes", {
      chapterId,
      name: "Worship",
      slug: "worship",
      version: 1,
      isArchived: false,
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    });
    return await ctx.db.insert("events", {
      chapterId,
      eventTypeId,
      templateVersion: 1,
      name: "Sunday Gathering",
      eventDate: now + 7 * 24 * 3600 * 1000,
      status: "planning",
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    });
  });
}

test("setlist + public request loop, with single-current invariant", async () => {
  const t = newT();
  const { as, chapterId, userId } = await setupChapter(t);
  const eventId = await makeEvent(t, chapterId, userId);

  // Library: a doxology + a hymn.
  const doxId = (await as.mutation(api.songs.create, {
    title: "Doxology",
    tags: ["doxology"],
    lyrics: "Praise God…",
  })) as Id<"songs">;
  const hymnId = (await as.mutation(api.songs.create, {
    title: "Holy, Holy, Holy",
    tags: ["hymn"],
  })) as Id<"songs">;

  // Add both to the setlist; mark the hymn current.
  await as.mutation(api.setlists.addSong, { eventId, songId: doxId });
  const hymnEntry = (await as.mutation(api.setlists.addSong, {
    eventId,
    songId: hymnId,
  })) as Id<"setlistEntries">;
  await as.mutation(api.setlists.setCurrent, { eventId, entryId: hymnEntry });

  // Public board reflects the current song + suggestions (no auth needed).
  const board = await t.query(api.setlists.publicBoard, { eventId });
  expect(board?.currentSong?.title).toBe("Holy, Holy, Holy");
  expect(board?.requestsOpen).toBe(true);
  expect(board?.suggestions.map((s) => s.title)).toContain("Doxology");

  // Anonymous request for the doxology (suggested) + a free-text one.
  await t.mutation(api.setlists.submitRequest, { eventId, songId: doxId });
  await t.mutation(api.setlists.submitRequest, {
    eventId,
    songTitle: "Way Maker",
    requesterName: "Guest",
  });

  // Counts roll up on the authed setlist view.
  const forEvent = await as.query(api.setlists.forEvent, { eventId });
  const doxRow = forEvent.songs.find((s) => s.songId === doxId);
  expect(doxRow?.requestCount).toBe(1);

  const queue = await as.query(api.setlists.requests, { eventId });
  expect(queue).toHaveLength(2);
  expect(queue.map((r) => r.songTitle)).toContain("Way Maker");

  // Single-current invariant: switching current clears the previous one.
  const entries = forEvent.songs;
  const doxEntry = entries.find((s) => s.songId === doxId)!.entryId;
  await as.mutation(api.setlists.setCurrent, {
    eventId,
    entryId: doxEntry as Id<"setlistEntries">,
  });
  const after = await as.query(api.setlists.forEvent, { eventId });
  expect(after.songs.filter((s) => s.isCurrent)).toHaveLength(1);
  expect(after.songs.find((s) => s.isCurrent)?.songId).toBe(doxId);
});

test("a named offer to sing is recorded; an anonymous one is not", async () => {
  const t = newT();
  const { as, chapterId, userId } = await setupChapter(t);
  const eventId = await makeEvent(t, chapterId, userId);

  // Named volunteer → willSing sticks.
  await t.mutation(api.setlists.submitRequest, {
    eventId,
    songTitle: "10,000 Reasons",
    requesterName: "Sam",
    willSing: true,
  });
  // No name → an "I'll sing" offer is dropped (useless without a name).
  await t.mutation(api.setlists.submitRequest, {
    eventId,
    songTitle: "Cornerstone",
    willSing: true,
  });

  const queue = await as.query(api.setlists.requests, { eventId });
  const sam = queue.find((r) => r.songTitle === "10,000 Reasons");
  const anon = queue.find((r) => r.songTitle === "Cornerstone");
  expect(sam?.willSing).toBe(true);
  expect(sam?.requesterName).toBe("Sam");
  expect(anon?.willSing).toBe(false);
});

test("closed requests reject anonymous submissions", async () => {
  const t = newT();
  const { as, chapterId, userId } = await setupChapter(t);
  const eventId = await makeEvent(t, chapterId, userId);

  await as.mutation(api.setlists.setRequestsOpen, { eventId, open: false });

  await expect(
    t.mutation(api.setlists.submitRequest, { eventId, songTitle: "Anything" }),
  ).rejects.toThrow(ConvexError);
});

test("public request ignores a cross-chapter songId", async () => {
  const t = newT();
  const a = await setupChapter(t, {
    email: "a@publicworship.life",
    chapterName: "Chapter A",
  });
  const b = await setupChapter(t, {
    email: "b@publicworship.life",
    chapterName: "Chapter B",
  });
  const eventA = await makeEvent(t, a.chapterId, a.userId);

  // A song that lives in chapter B must NOT attach to a request on A's event.
  const foreignSong = (await b.as.mutation(api.songs.create, {
    title: "Foreign Song",
  })) as Id<"songs">;

  await t.mutation(api.setlists.submitRequest, {
    eventId: eventA,
    songId: foreignSong,
    songTitle: "Foreign Song",
  });

  const queue = await a.as.query(api.setlists.requests, { eventId: eventA });
  expect(queue).toHaveLength(1);
  // The title is kept (free text), but the cross-chapter songId is dropped.
  expect(queue[0].songId).toBeNull();
});

describe("library guards", () => {
  test("create rejects an empty title", async () => {
    const t = newT();
    const { as } = await setupChapter(t);
    await expect(
      as.mutation(api.songs.create, { title: "   " }),
    ).rejects.toThrow(ConvexError);
  });

  test("deleting a song cascades to its setlist entries", async () => {
    const t = newT();
    const { as, chapterId, userId } = await setupChapter(t);
    const eventId = await makeEvent(t, chapterId, userId);
    const songId = (await as.mutation(api.songs.create, {
      title: "Temp",
    })) as Id<"songs">;
    await as.mutation(api.setlists.addSong, { eventId, songId });
    await as.mutation(api.songs.remove, { songId });
    const forEvent = await as.query(api.setlists.forEvent, { eventId });
    expect(forEvent.songs).toHaveLength(0);
  });
});
