/**
 * Job listings — the postings on `/team`, now managed from the OS.
 *
 * The rules worth pinning: only a manager writes; a first save is a private
 * draft; publishing is refused until the listing is complete (the old
 * content-collection `.min(1)` moved to the moment it matters); the public
 * feed shows published rows only; slugs are unique and stable; and the one-time
 * seed is idempotent.
 */
import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";

/** Give the test's user a central seat carrying `capabilities`. Mirrors the
 *  helper in `hiring.test.ts` (kept local rather than shared — a seat fixture
 *  is two inserts and coupling the two files is not worth it). */
async function seedSeat(s: ChapterSetup, capabilities: string[]): Promise<void> {
  const now = Date.now();
  await run(s.t, async (ctx) => {
    const personId = await ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Seat Holder",
      email: "seat@publicworship.life",
      userId: s.userId,
      createdAt: now,
    });
    const seatDefId = await ctx.db.insert("seatDefs", {
      slug: "test_people_seat",
      title: "Test People Seat",
      chart: "central",
      parentSlug: "root",
      maxHolders: 1,
      duties: [],
      capabilities,
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("seatAssignments", {
      seatDefId,
      scope: "central",
      personId,
      createdAt: now,
    });
  });
}

/** A complete listing's args — enough that publishing passes. */
function completeArgs(overrides: Record<string, unknown> = {}) {
  return {
    title: "Chapter Director",
    team: "Chapters",
    location: "NYC",
    hoursPerWeek: 10,
    reportsTo: "People Director",
    summary: "Lead a chapter.",
    whyThisSeatExists: "Chapters need a leader.",
    outcomes: [{ outcome: "A launched chapter", doneWhen: "It gathers monthly" }],
    authority: ["Call launch readiness"],
    responsibilities: [{ area: "Launch", items: ["Recruit the team"] }],
    rhythms: ["Weekly 1:1"],
    firstNinetyDays: ["Meet the team"],
    required: ["Rooted in a local church"],
    notThisRole: ["Not central finance"],
    successLooks: ["A healthy chapter"],
    ...overrides,
  };
}

describe("job listings", () => {
  test("a non-manager cannot create a listing", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedSeat(s, ["hiring.view"]); // view only
    await expect(
      s.as.mutation(api.listings.upsertListing, { title: "Nope" }),
    ).rejects.toThrow(/permission to manage job listings/i);
  });

  test("a first save is a private draft, off the public feed", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedSeat(s, ["hiring.edit"]);

    const id = await s.as.mutation(api.listings.upsertListing, {
      title: "People Director",
    });
    const row = await run(t, (ctx) => ctx.db.get(id));
    expect(row?.published).toBe(false);
    expect(row?.slug).toBe("people-director");
    // Draft never reaches the public feed.
    const feed = await t.query(internal.listings.publicListings, {});
    expect(feed).toEqual([]);
  });

  test("publishing is refused until the listing is complete", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedSeat(s, ["hiring.edit"]);

    const id = await s.as.mutation(api.listings.upsertListing, {
      title: "Half a role",
    });
    await expect(
      s.as.mutation(api.listings.setListingPublished, {
        listingId: id,
        published: true,
      }),
    ).rejects.toThrow(/still needs/i);

    // Fill it in, then publishing succeeds and it appears on the feed.
    await s.as.mutation(api.listings.upsertListing, {
      listingId: id,
      ...completeArgs({ title: "A complete role", status: "open" }),
    });
    await s.as.mutation(api.listings.setListingPublished, {
      listingId: id,
      published: true,
    });
    const feed = await t.query(internal.listings.publicListings, {});
    expect(feed).toHaveLength(1);
    expect(feed[0]).toMatchObject({ title: "A complete role", status: "open" });
    // Dates are serialized as ISO strings, not ms.
    expect(feed[0].postedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("editing a live listing incomplete drops it back to draft", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedSeat(s, ["hiring.edit"]);

    // Publish a complete listing.
    const id = await s.as.mutation(api.listings.upsertListing, completeArgs());
    await s.as.mutation(api.listings.setListingPublished, {
      listingId: id,
      published: true,
    });
    expect(await t.query(internal.listings.publicListings, {})).toHaveLength(1);

    // Clear a required section — the listing must fall off the public feed
    // rather than render an empty headed block.
    await s.as.mutation(api.listings.upsertListing, {
      listingId: id,
      authority: [],
    });
    const row = await run(t, (ctx) => ctx.db.get(id));
    expect(row?.published).toBe(false);
    expect(await t.query(internal.listings.publicListings, {})).toEqual([]);
  });

  test("a partial edit leaves the rest of the listing intact", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedSeat(s, ["hiring.edit"]);

    const id = await s.as.mutation(api.listings.upsertListing, completeArgs());
    // Edit only the status; everything else must survive.
    await s.as.mutation(api.listings.setListingStatus, {
      listingId: id,
      status: "closed",
    });
    const row = await run(t, (ctx) => ctx.db.get(id));
    expect(row?.status).toBe("closed");
    expect(row?.authority).toEqual(["Call launch readiness"]);
    expect(row?.outcomes).toHaveLength(1);
  });

  test("slugs are unique across same-titled roles", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedSeat(s, ["hiring.edit"]);
    const a = await s.as.mutation(api.listings.upsertListing, {
      title: "Chapter Director",
    });
    const b = await s.as.mutation(api.listings.upsertListing, {
      title: "Chapter Director",
    });
    const [ra, rb] = await run(t, async (ctx) => [
      await ctx.db.get(a),
      await ctx.db.get(b),
    ]);
    expect(ra?.slug).toBe("chapter-director");
    expect(rb?.slug).toBe("chapter-director-2");
  });

  test("deleting a listing removes it but not its applications", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedSeat(s, ["hiring.edit"]);
    const id = await s.as.mutation(api.listings.upsertListing, completeArgs());
    await s.as.mutation(api.listings.deleteListing, { listingId: id });
    const gone = await run(t, (ctx) => ctx.db.get(id));
    expect(gone).toBeNull();
    // Deleting again is a no-op, not an error.
    await s.as.mutation(api.listings.deleteListing, { listingId: id });
  });

  test("the one-time seed is idempotent", async () => {
    const t = newT();
    const first = await t.mutation(internal.listings.seedListingsIfEmpty, {});
    expect(first).toEqual({ inserted: 1 });
    const second = await t.mutation(internal.listings.seedListingsIfEmpty, {});
    expect(second).toEqual({ inserted: 0 });
    const feed = await t.query(internal.listings.publicListings, {});
    expect(feed).toHaveLength(1);
    expect(feed[0].slug).toBe("people-director");
  });
});
