import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import type { Id } from "../_generated/dataModel";

/**
 * RSVP page title font + organizer links through `ticketing.updatePage` and
 * back out of `getPublicPage`: URLs are normalized on write, non-http(s)
 * links are refused, empty editor rows are dropped, and the list is capped.
 */

async function makePublishedPage(s: ChapterSetup) {
  const eventId = await run(s.t, async (ctx) => {
    const now = Date.now();
    const eventTypeId = await ctx.db.insert("eventTypes", {
      chapterId: s.chapterId,
      name: "Talent Show",
      slug: "talent-show",
      version: 1,
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
    });
    return await ctx.db.insert("events", {
      chapterId: s.chapterId,
      eventTypeId,
      templateVersion: 1,
      name: "Brooklyn's Got Talent",
      eventDate: now + 7 * 24 * 60 * 60 * 1000,
      status: "planning",
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
    });
  });
  const pageId = (await s.as.mutation(api.ticketing.createPage, {
    eventId,
  })) as Id<"eventPages">;
  await s.as.mutation(api.ticketing.updatePage, {
    pageId,
    patch: { published: true },
  });
  const slug = (await run(s.t, (ctx) => ctx.db.get(pageId)))!.slug;
  return { pageId, slug };
}

describe("RSVP page title font + links", () => {
  test("stores the font and normalized links; the public page returns them", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const { pageId, slug } = await makePublishedPage(s);

    await s.as.mutation(api.ticketing.updatePage, {
      pageId,
      patch: {
        titleFont: "helvetica",
        links: [
          { label: " Talent questionnaire ", url: "forms.gle/abc" },
          { label: "", url: "" },
          { label: "", url: "https://www.example.org/signup" },
        ],
      },
    });

    const pub = await t.query(api.ticketing.getPublicPage, { slug });
    expect(pub?.titleFont).toBe("helvetica");
    expect(pub?.links).toEqual([
      { label: "Talent questionnaire", url: "https://forms.gle/abc" },
      { label: "example.org", url: "https://www.example.org/signup" },
    ]);
  });

  test("refuses a non-http link", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const { pageId } = await makePublishedPage(s);
    await expect(
      s.as.mutation(api.ticketing.updatePage, {
        pageId,
        patch: { links: [{ label: "x", url: "javascript:alert(1)" }] },
      }),
    ).rejects.toThrow(/isn't a web link/);
  });

  test("caps the number of links", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const { pageId } = await makePublishedPage(s);
    const links = Array.from({ length: 7 }, (_, i) => ({
      label: `Link ${i}`,
      url: `https://example.org/${i}`,
    }));
    await expect(
      s.as.mutation(api.ticketing.updatePage, { pageId, patch: { links } }),
    ).rejects.toThrow(/at most 6 links/);
  });

  test("an empty list clears the links", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const { pageId, slug } = await makePublishedPage(s);
    await s.as.mutation(api.ticketing.updatePage, {
      pageId,
      patch: { links: [{ label: "A", url: "https://example.org" }] },
    });
    await s.as.mutation(api.ticketing.updatePage, {
      pageId,
      patch: { links: [] },
    });
    const pub = await t.query(api.ticketing.getPublicPage, { slug });
    expect(pub?.links).toEqual([]);
  });
});
