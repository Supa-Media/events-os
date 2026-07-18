import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import {
  newT,
  run,
  setupChapter,
  storeBlob,
  type ChapterSetup,
  type TestConvex,
} from "./setup.helpers";
import type { Id } from "../_generated/dataModel";

/**
 * HTTP integration for the public event page routes. The page is served under
 * the branded "/event/" prefix; the legacy "/e/" prefix is kept as an alias so
 * already-shared links (and OG-cached cover URLs) never break. Both prefixes
 * hit the same handler, so these tests pin that both resolve identically and
 * that unpublished/garbage slugs 404.
 */

async function seedEvent(s: ChapterSetup): Promise<Id<"events">> {
  return await run(s.t, async (ctx) => {
    const now = Date.now();
    const eventTypeId = await ctx.db.insert("eventTypes", {
      chapterId: s.chapterId,
      name: "Worship Night",
      slug: "worship-night",
      version: 1,
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
    });
    return await ctx.db.insert("events", {
      chapterId: s.chapterId,
      eventTypeId,
      templateVersion: 1,
      name: "Worship Night on the Pier",
      eventDate: now + 14 * 24 * 60 * 60 * 1000,
      status: "planning",
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
    });
  });
}

/** Create + publish a page (optionally with a cover), returning its slug. */
async function publishPage(
  s: ChapterSetup,
  eventId: Id<"events">,
  withCover = false,
): Promise<string> {
  const pageId = (await s.as.mutation(api.ticketing.createPage, {
    eventId,
  })) as Id<"eventPages">;
  const admin = await s.as.query(api.ticketing.getAdminPage, { eventId });
  await s.as.mutation(api.ticketing.updatePage, {
    pageId,
    patch: { published: true },
  });
  if (withCover) {
    const storageId = await storeBlob(s.t);
    await run(s.t, (ctx) => ctx.db.patch(pageId, { coverImage: storageId }));
  }
  return admin.page!.slug;
}

async function seedPublishedPage(withCover = false): Promise<{
  t: TestConvex;
  slug: string;
}> {
  const t = newT();
  const s = await setupChapter(t);
  const eventId = await seedEvent(s);
  const slug = await publishPage(s, eventId, withCover);
  return { t, slug };
}

describe("public event page routes", () => {
  for (const prefix of ["/event", "/e"] as const) {
    test(`${prefix}/<slug> serves the landing page HTML`, async () => {
      const { t, slug } = await seedPublishedPage();
      const res = await t.fetch(`${prefix}/${slug}`, {});
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(await res.text()).toContain("Worship Night on the Pier");
    });

    test(`${prefix}/<slug>/cover returns the image bytes`, async () => {
      const { t, slug } = await seedPublishedPage(true);
      const res = await t.fetch(`${prefix}/${slug}/cover`, {});
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("image/");
    });

    test(`${prefix}/<slug>/calendar.ics returns a calendar`, async () => {
      const { t, slug } = await seedPublishedPage();
      const res = await t.fetch(`${prefix}/${slug}/calendar.ics`, {});
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/calendar");
      expect(await res.text()).toContain("BEGIN:VCALENDAR");
    });
  }

  test("unpublished slug 404s under /event/", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    await s.as.mutation(api.ticketing.createPage, { eventId });
    const admin = await s.as.query(api.ticketing.getAdminPage, { eventId });
    const res = await t.fetch(`/event/${admin.page!.slug}`, {});
    expect(res.status).toBe(404);
  });

  test("garbage slug 404s under both prefixes", async () => {
    const t = newT();
    await setupChapter(t);
    expect((await t.fetch("/event/nope-nope", {})).status).toBe(404);
    expect((await t.fetch("/e/nope-nope", {})).status).toBe(404);
  });
});
