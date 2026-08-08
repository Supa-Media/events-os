import { describe, expect, test } from "vitest";
import { startOfNextEasternDay } from "@events-os/shared";
import { api } from "../_generated/api";
import {
  newT,
  run,
  setupChapter,
  storeBlob,
  type ChapterSetup,
} from "./setup.helpers";
import type { Id } from "../_generated/dataModel";

/**
 * The public "upcoming events" feed that powers the marketing site's Important
 * Links section: `api.ticketing.listPublishedUpcoming` and its HTTP wrapper
 * GET /api/events/upcoming. Pins the filtering (published + still on its
 * event day ET or later + non-training), soonest-first ordering, the limit,
 * and the JSON shape — plus the `startOfNextEasternDay` cutoff helper.
 */

const DAY = 24 * 60 * 60 * 1000;

describe("startOfNextEasternDay", () => {
  test("winter (EST, UTC-5): next ET midnight lands at 05:00 UTC", () => {
    // Jan 15 23:00 UTC = Jan 15 6 PM ET → next ET midnight = Jan 16 05:00 UTC.
    expect(startOfNextEasternDay(Date.UTC(2026, 0, 15, 23, 0))).toBe(
      Date.UTC(2026, 0, 16, 5, 0),
    );
  });

  test("summer (EDT, UTC-4): next ET midnight lands at 04:00 UTC", () => {
    // Jul 15 23:00 UTC = Jul 15 7 PM ET → next ET midnight = Jul 16 04:00 UTC.
    expect(startOfNextEasternDay(Date.UTC(2026, 6, 15, 23, 0))).toBe(
      Date.UTC(2026, 6, 16, 4, 0),
    );
  });

  test("exactly ET midnight rolls to the NEXT midnight (strictly after)", () => {
    expect(startOfNextEasternDay(Date.UTC(2026, 6, 16, 4, 0))).toBe(
      Date.UTC(2026, 6, 17, 4, 0),
    );
  });

  test("month rollover", () => {
    expect(startOfNextEasternDay(Date.UTC(2026, 6, 31, 23, 0))).toBe(
      Date.UTC(2026, 7, 1, 4, 0),
    );
  });
});

async function seedEvent(
  s: ChapterSetup,
  opts: { name: string; eventDate: number; isTraining?: boolean },
): Promise<Id<"events">> {
  return await run(s.t, async (ctx) => {
    const now = Date.now();
    const eventTypeId = await ctx.db.insert("eventTypes", {
      chapterId: s.chapterId,
      name: "Worship Night",
      slug: `worship-night-${opts.name.toLowerCase().replace(/\s+/g, "-")}`,
      version: 1,
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
    });
    return await ctx.db.insert("events", {
      chapterId: s.chapterId,
      eventTypeId,
      templateVersion: 1,
      name: opts.name,
      eventDate: opts.eventDate,
      ...(opts.isTraining ? { isTraining: true } : {}),
      status: "planning",
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
    });
  });
}

/** Create a page for an event; publish it unless `publish: false`. */
async function makePage(
  s: ChapterSetup,
  eventId: Id<"events">,
  opts: { publish?: boolean; cover?: boolean; endDate?: number } = {},
): Promise<string> {
  const pageId = (await s.as.mutation(api.ticketing.createPage, {
    eventId,
  })) as Id<"eventPages">;
  if (opts.publish !== false) {
    await s.as.mutation(api.ticketing.updatePage, {
      pageId,
      patch: { published: true },
    });
  }
  if (opts.cover || opts.endDate !== undefined) {
    const storageId = opts.cover ? await storeBlob(s.t) : undefined;
    await run(s.t, (ctx) =>
      ctx.db.patch(pageId, {
        ...(storageId ? { coverImage: storageId } : {}),
        ...(opts.endDate !== undefined ? { endDate: opts.endDate } : {}),
      }),
    );
  }
  const admin = await s.as.query(api.ticketing.getAdminPage, { eventId });
  return admin.page!.slug;
}

describe("listPublishedUpcoming", () => {
  test("returns only published, not-yet-over, non-training events, soonest first", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const now = Date.now();

    const soon = await seedEvent(s, { name: "Soon", eventDate: now + 3 * DAY });
    const later = await seedEvent(s, {
      name: "Later",
      eventDate: now + 30 * DAY,
    });
    const past = await seedEvent(s, { name: "Past", eventDate: now - 3 * DAY });
    const draft = await seedEvent(s, {
      name: "Draft",
      eventDate: now + 5 * DAY,
    });
    const training = await seedEvent(s, {
      name: "Training",
      eventDate: now + 1 * DAY,
      isTraining: true,
    });

    await makePage(s, later); // published, far out
    await makePage(s, soon); // published, near
    await makePage(s, past); // published but already over → excluded
    await makePage(s, draft, { publish: false }); // unpublished → excluded
    await makePage(s, training); // published but training → excluded

    const list = await t.query(api.ticketing.listPublishedUpcoming, {});
    expect(list.map((e) => e.eventName)).toEqual(["Soon", "Later"]);
  });

  test("keeps an event that already started — it stays up through its ET day", async () => {
    // The homepage-link regression: an event whose start time (or legacy
    // midnight anchor) has passed must NOT vanish while its event day is
    // still underway — people need the link on the day itself.
    const t = newT();
    const s = await setupChapter(t);
    const now = Date.now();
    const startedToday = await seedEvent(s, {
      name: "Tonight",
      eventDate: now - 1000, // started moments ago — same ET day as `now`
    });
    await makePage(s, startedToday);

    const list = await t.query(api.ticketing.listPublishedUpcoming, {});
    expect(list.map((e) => e.eventName)).toEqual(["Tonight"]);
  });

  test("keeps an in-progress event (started, endDate still ahead)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const now = Date.now();
    const ongoing = await seedEvent(s, {
      name: "Ongoing",
      eventDate: now - 2 * 60 * 60 * 1000, // started 2h ago
    });
    await makePage(s, ongoing, { endDate: now + 2 * 60 * 60 * 1000 });

    const list = await t.query(api.ticketing.listPublishedUpcoming, {});
    expect(list.map((e) => e.eventName)).toEqual(["Ongoing"]);
  });

  test("respects the limit", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const now = Date.now();
    for (let i = 0; i < 4; i++) {
      const id = await seedEvent(s, {
        name: `E${i}`,
        eventDate: now + (i + 1) * DAY,
      });
      await makePage(s, id);
    }
    const list = await t.query(api.ticketing.listPublishedUpcoming, {
      limit: 2,
    });
    expect(list.map((e) => e.eventName)).toEqual(["E0", "E1"]);
  });
});

describe("GET /api/events/upcoming", () => {
  test("returns JSON with hrefs and cover URLs only when a cover exists", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const now = Date.now();

    const withCover = await seedEvent(s, {
      name: "Flyer Night",
      eventDate: now + 2 * DAY,
    });
    const noCover = await seedEvent(s, {
      name: "Plain Night",
      eventDate: now + 4 * DAY,
    });
    const coverSlug = await makePage(s, withCover, { cover: true });
    const plainSlug = await makePage(s, noCover);

    const res = await t.fetch("/api/events/upcoming?limit=2", {});
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");

    const body = (await res.json()) as Array<{
      title: string;
      href: string;
      coverUrl: string | null;
    }>;
    expect(body).toEqual([
      {
        title: "Flyer Night",
        tagline: null,
        venueName: null,
        startDate: expect.any(Number),
        endDate: null,
        href: `/rsvp/${coverSlug}`,
        coverUrl: `/rsvp/${coverSlug}/cover`,
        // Default focal point (centered) — no crop set on these events.
        coverFocalX: 50,
        coverFocalY: 50,
      },
      {
        title: "Plain Night",
        tagline: null,
        venueName: null,
        startDate: expect.any(Number),
        endDate: null,
        href: `/rsvp/${plainSlug}`,
        coverUrl: null,
        coverFocalX: 50,
        coverFocalY: 50,
      },
    ]);
  });
});
