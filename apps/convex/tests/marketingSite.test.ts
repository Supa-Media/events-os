/**
 * The homepage's OS-managed content.
 *
 * The rules worth pinning: only a `marketing.site.edit` holder writes; the
 * public feed shows published rows only and never leaks a draft; a copy slot
 * cleared to empty falls back to the shipped default rather than blanking the
 * page; a card must go somewhere or copy something, and its URL cannot be a
 * `javascript:` scheme; the events row honors count, pins, and hides — with
 * hide beating pin — and cannot be deleted; the POSTS row obeys the same four
 * rules over published blog posts, is a singleton, and is undeletable too; and
 * the one-time seed is idempotent.
 */
import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import { SITE_COPY_DEFS, SITE_LINK_MAX_POSTS_CAP } from "@events-os/shared";
import type { Id } from "../_generated/dataModel";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { ensurePostsRow } from "../marketingSite";

/** Give the test's user a central seat carrying `capabilities`. Mirrors the
 *  helper in `listings.test.ts` / `hiring.test.ts` — a seat fixture is two
 *  inserts and sharing it across files is not worth the coupling. */
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
      slug: "test_marketing_seat",
      title: "Test Marketing Seat",
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

/** A published event page, so the events row has something to select. */
async function seedEvent(
  s: ChapterSetup,
  args: { slug: string; name: string; daysOut: number },
): Promise<void> {
  const now = Date.now();
  const eventDate = now + args.daysOut * 24 * 60 * 60 * 1000;
  await run(s.t, async (ctx) => {
    const eventTypeId = await ctx.db.insert("eventTypes", {
      chapterId: s.chapterId,
      name: args.name,
      slug: `${args.slug}-type`,
      version: 1,
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
    });
    const eventId = await ctx.db.insert("events", {
      chapterId: s.chapterId,
      eventTypeId,
      templateVersion: 1,
      name: args.name,
      eventDate,
      status: "planning",
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("eventPages", {
      eventId,
      chapterId: s.chapterId,
      slug: args.slug,
      published: true,
      addressVisibility: "public",
      rsvpEnabled: true,
      ticketsEnabled: false,
      showGuestList: false,
      goingCount: 0,
      maybeCount: 0,
      notGoingCount: 0,
      ticketsSoldCount: 0,
      revenueCents: 0,
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
    });
  });
}

/**
 * A blog post row, inserted directly.
 *
 * Going through `marketingBlog`'s mutations would need a second seat and four
 * calls per post to say one thing — "this post is public, and it went up on
 * this date". The ordering under test is the index's, and the index reads
 * `status` + `publishedAt`, both of which are set here exactly as
 * `setPostStatus` sets them.
 */
async function seedPost(
  s: ChapterSetup,
  args: {
    slug: string;
    title?: string;
    status?: "draft" | "published" | "archived";
    daysAgo?: number;
    description?: string;
  },
): Promise<void> {
  const now = Date.now();
  const status = args.status ?? "published";
  await run(s.t, async (ctx) => {
    await ctx.db.insert("blogPosts", {
      slug: args.slug,
      status,
      title: args.title ?? args.slug,
      description: args.description ?? `About ${args.slug}.`,
      author: "Public Worship",
      body: "# Body",
      tags: [],
      reactionsEnabled: true,
      previewToken: `token-${args.slug}`,
      // A draft has never been published, so it carries no date — the same
      // shape `upsertPost` leaves a draft in.
      publishedAt:
        status === "draft"
          ? undefined
          : now - (args.daysAgo ?? 1) * 24 * 60 * 60 * 1000,
      createdAt: now,
      updatedAt: now,
    });
  });
}

/** The posts row, published and showing `maxPosts`. Created through the same
 *  mutation the desk uses, so these tests exercise the write path's validation
 *  rather than a hand-built row. */
async function seedPostsRow(
  s: ChapterSetup,
  args: { maxPosts: number; pinned?: string[]; hidden?: string[] },
): Promise<Id<"siteLinks">> {
  return await s.as.mutation(api.marketingSite.upsertLink, {
    kind: "posts",
    title: "Latest blog posts",
    align: "center",
    published: true,
    maxPosts: args.maxPosts,
    pinnedPostSlugs: args.pinned,
    hiddenPostSlugs: args.hidden,
  });
}

describe("site copy", () => {
  test("a caller without marketing.site.edit cannot write", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedSeat(s, ["marketing.list.view"]); // the list, not the site
    await expect(
      s.as.mutation(api.marketingSite.setCopy, {
        key: "hero.headingLead",
        value: "Nope",
      }),
    ).rejects.toThrow(/permission to edit the public site/i);
  });

  test("an unset slot renders its shipped default", async () => {
    const t = newT();
    const content = await t.query(internal.marketingSite.publicSiteContent, {});
    expect(content.copy["hero.headingLead"]).toBe(
      SITE_COPY_DEFS["hero.headingLead"].defaultValue,
    );
  });

  test("a written slot wins, and clearing it restores the default", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedSeat(s, ["marketing.site.edit"]);

    await s.as.mutation(api.marketingSite.setCopy, {
      key: "hero.headingLead",
      value: "Come and worship",
    });
    let content = await t.query(internal.marketingSite.publicSiteContent, {});
    expect(content.copy["hero.headingLead"]).toBe("Come and worship");

    // Empty is "clear this", not "blank the page" — the row goes away and the
    // shipped words come back.
    await s.as.mutation(api.marketingSite.setCopy, {
      key: "hero.headingLead",
      value: "   ",
    });
    content = await t.query(internal.marketingSite.publicSiteContent, {});
    expect(content.copy["hero.headingLead"]).toBe(
      SITE_COPY_DEFS["hero.headingLead"].defaultValue,
    );
  });

  test("a slot longer than its layout bound is refused, not truncated", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedSeat(s, ["marketing.site.edit"]);
    await expect(
      s.as.mutation(api.marketingSite.setCopy, {
        key: "hero.eyebrow",
        value: "x".repeat(SITE_COPY_DEFS["hero.eyebrow"].maxLen + 1),
      }),
    ).rejects.toThrow(/too long/i);
  });
});

describe("link cards", () => {
  test("a card needs somewhere to go or something to copy", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedSeat(s, ["marketing.site.edit"]);
    await expect(
      s.as.mutation(api.marketingSite.upsertLink, {
        title: "Dead tile",
        align: "center",
        published: true,
      }),
    ).rejects.toThrow(/somewhere to go/i);
  });

  test("a copy-only card (the Zelle case) is allowed with no URL", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedSeat(s, ["marketing.site.edit"]);
    const id = await s.as.mutation(api.marketingSite.upsertLink, {
      title: "Donate Through Zelle",
      copy: "give@publicworship.life",
      cta: "(Click to Copy)",
      align: "center",
      published: true,
    });
    const row = await run(t, (ctx) => ctx.db.get(id));
    expect(row?.url).toBeUndefined();
    expect(row?.copy).toBe("give@publicworship.life");
  });

  test("a javascript: or protocol-relative URL is refused", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedSeat(s, ["marketing.site.edit"]);
    for (const url of ["javascript:alert(1)", "//evil.example", "data:text/html,x"]) {
      await expect(
        s.as.mutation(api.marketingSite.upsertLink, {
          title: "Bad",
          url,
          align: "center",
          published: true,
        }),
      ).rejects.toThrow(/isn't one the site can use/i);
    }
  });

  test("editing a card keeps its image — the rename-deletes-the-logo case", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedSeat(s, ["marketing.site.edit"]);
    await t.mutation(internal.marketingSite.seedSiteContentIfEmpty, {});

    const instagram = await run(t, async (ctx) => {
      const rows = await ctx.db.query("siteLinks").collect();
      return rows.find((r) => r.title === "Instagram")!;
    });
    expect(instagram.thumbnailPath).toBe("/links/instagram-photo.png");

    // The editor posts the whole form and carries no image path, so "not sent"
    // must mean KEEP — otherwise a rename silently strips the logo off the live
    // site with no way back from inside the app.
    await s.as.mutation(api.marketingSite.upsertLink, {
      linkId: instagram._id,
      title: "Instagram (renamed)",
      url: instagram.url,
      align: "center",
      published: true,
    });
    const after = await run(t, (ctx) => ctx.db.get(instagram._id));
    expect(after?.thumbnailPath).toBe("/links/instagram-photo.png");

    // Removing it is a deliberate act, and it clears BOTH forms of the field.
    await s.as.mutation(api.marketingSite.upsertLink, {
      linkId: instagram._id,
      title: "Instagram",
      url: instagram.url,
      align: "center",
      published: true,
      clearThumbnail: true,
    });
    const cleared = await run(t, (ctx) => ctx.db.get(instagram._id));
    expect(cleared?.thumbnailPath).toBeUndefined();
    expect(cleared?.thumbnailStorage).toBeUndefined();
  });

  test("a card cannot carry both a link and copy text", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedSeat(s, ["marketing.site.edit"]);
    // `LinkCard` renders any card with `copy` as a button, so the link would
    // never fire — refused rather than silently resolved by precedence.
    await expect(
      s.as.mutation(api.marketingSite.upsertLink, {
        title: "Both",
        url: "/give",
        copy: "give@publicworship.life",
        align: "center",
        published: true,
      }),
    ).rejects.toThrow(/not both/i);
  });

  test("the public feed never carries the events row's hide list", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedSeat(s, ["marketing.site.edit"]);
    await seedEvent(s, { slug: "team-only-retreat", name: "Team retreat", daysOut: 3 });
    await s.as.mutation(api.marketingSite.setEventsRow, {
      maxEvents: 2,
      hiddenEventSlugs: ["team-only-retreat"],
    });

    // The hide list is an inventory of gatherings we deliberately did not
    // advertise, and the page never needed it — the OS already resolved the
    // selection into `events`.
    const feed = await t.query(internal.marketingSite.publicSiteContent, {});
    expect(JSON.stringify(feed)).not.toContain("team-only-retreat");
    const eventsRow = feed.links.find((l) => l.kind === "events");
    expect(eventsRow?.hiddenEventSlugs).toBeNull();
    expect(eventsRow?.maxEvents).toBeNull();

    // The DESK still sees the controls — it has to, to render them.
    const desk = await s.as.query(api.marketingSite.siteContent, {});
    const deskRow = desk.links.find((l) => l.kind === "events");
    expect(deskRow?.hiddenEventSlugs).toEqual(["team-only-retreat"]);
    expect(deskRow?.maxEvents).toBe(2);
  });

  test("an unpublished card never reaches the public feed", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedSeat(s, ["marketing.site.edit"]);

    await s.as.mutation(api.marketingSite.upsertLink, {
      title: "Draft card",
      url: "/give",
      align: "center",
      published: false,
    });
    const feed = await t.query(internal.marketingSite.publicSiteContent, {});
    expect(feed.links).toEqual([]);

    // The DESK still sees it — that is the whole point of a draft.
    const desk = await s.as.query(api.marketingSite.siteContent, {});
    expect(desk.links.map((l) => l.title)).toEqual(["Draft card"]);
  });

  test("reordering rewrites the whole grid's order", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedSeat(s, ["marketing.site.edit"]);

    const a = await s.as.mutation(api.marketingSite.upsertLink, {
      title: "A",
      url: "/a",
      align: "center",
      published: true,
    });
    const b = await s.as.mutation(api.marketingSite.upsertLink, {
      title: "B",
      url: "/b",
      align: "center",
      published: true,
    });
    let feed = await t.query(internal.marketingSite.publicSiteContent, {});
    expect(feed.links.map((l) => l.title)).toEqual(["A", "B"]);

    await s.as.mutation(api.marketingSite.reorderLinks, { linkIds: [b, a] });
    feed = await t.query(internal.marketingSite.publicSiteContent, {});
    expect(feed.links.map((l) => l.title)).toEqual(["B", "A"]);
  });
});

describe("the live-events row", () => {
  test("count, pins, and hides all apply — and hide beats pin", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedSeat(s, ["marketing.site.edit"]);
    await seedEvent(s, { slug: "soon", name: "Soon", daysOut: 2 });
    await seedEvent(s, { slug: "later", name: "Later", daysOut: 20 });
    await seedEvent(s, { slug: "private", name: "Team only", daysOut: 5 });

    // Default: soonest first.
    await s.as.mutation(api.marketingSite.setEventsRow, { maxEvents: 3 });
    let feed = await t.query(internal.marketingSite.publicSiteContent, {});
    expect(feed.events.map((e) => e.slug)).toEqual(["soon", "private", "later"]);

    // Lead with the far-off one, and keep the team-only page off the homepage.
    await s.as.mutation(api.marketingSite.setEventsRow, {
      maxEvents: 3,
      pinnedEventSlugs: ["later"],
      hiddenEventSlugs: ["private"],
    });
    feed = await t.query(internal.marketingSite.publicSiteContent, {});
    expect(feed.events.map((e) => e.slug)).toEqual(["later", "soon"]);
    expect(feed.events[0].pinned).toBe(true);

    // Hide wins over pin — the later, narrower "no".
    await s.as.mutation(api.marketingSite.setEventsRow, {
      maxEvents: 3,
      pinnedEventSlugs: ["later"],
      hiddenEventSlugs: ["later"],
    });
    feed = await t.query(internal.marketingSite.publicSiteContent, {});
    expect(feed.events.map((e) => e.slug)).toEqual(["soon", "private"]);

    // The count caps it.
    await s.as.mutation(api.marketingSite.setEventsRow, { maxEvents: 1 });
    feed = await t.query(internal.marketingSite.publicSiteContent, {});
    expect(feed.events.map((e) => e.slug)).toEqual(["soon"]);
  });

  test("a pin naming nothing publishable is skipped, not rendered", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedSeat(s, ["marketing.site.edit"]);
    await seedEvent(s, { slug: "soon", name: "Soon", daysOut: 2 });

    await s.as.mutation(api.marketingSite.setEventsRow, {
      maxEvents: 2,
      pinnedEventSlugs: ["deleted-last-year", "soon"],
    });
    const feed = await t.query(internal.marketingSite.publicSiteContent, {});
    expect(feed.events.map((e) => e.slug)).toEqual(["soon"]);
  });

  test("the events row is not deletable — only hideable", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedSeat(s, ["marketing.site.edit"]);
    const rowId = await s.as.mutation(api.marketingSite.setEventsRow, {
      maxEvents: 2,
    });
    await expect(
      s.as.mutation(api.marketingSite.deleteLink, { linkId: rowId }),
    ).rejects.toThrow(/can't be deleted/i);

    await seedEvent(s, { slug: "soon", name: "Soon", daysOut: 2 });
    await s.as.mutation(api.marketingSite.setLinkPublished, {
      linkId: rowId,
      published: false,
    });
    const feed = await t.query(internal.marketingSite.publicSiteContent, {});
    expect(feed.events).toEqual([]);
  });

  test("it cannot be edited as an ordinary card", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedSeat(s, ["marketing.site.edit"]);
    const rowId = await s.as.mutation(api.marketingSite.setEventsRow, {
      maxEvents: 2,
    });
    await expect(
      s.as.mutation(api.marketingSite.upsertLink, {
        linkId: rowId,
        title: "Hijacked",
        url: "/nope",
        align: "center",
        published: true,
      }),
    ).rejects.toThrow(/Events section/i);
  });
});

describe("the latest-posts row", () => {
  test("published posts render newest first", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedSeat(s, ["marketing.site.edit"]);
    await seedPost(s, { slug: "oldest", daysAgo: 30 });
    await seedPost(s, { slug: "newest", daysAgo: 1 });
    await seedPost(s, { slug: "middle", daysAgo: 10 });
    await seedPostsRow(s, { maxPosts: 3 });

    const feed = await t.query(internal.marketingSite.publicSiteContent, {});
    expect(feed.posts.map((p) => p.slug)).toEqual(["newest", "middle", "oldest"]);
  });

  test("a card carries the post's own description, path, and date", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedSeat(s, ["marketing.site.edit"]);
    await seedPost(s, {
      slug: "doxological-worship",
      title: "Doxological Worship",
      description: "What it means to worship in spirit and in truth.",
      daysAgo: 2,
    });
    await seedPostsRow(s, { maxPosts: 1 });

    const feed = await t.query(internal.marketingSite.publicSiteContent, {});
    expect(feed.posts).toHaveLength(1);
    const card = feed.posts[0];
    // The SAME sentence the post's own page shows — not a second summary, and
    // not a truncation of it.
    expect(card.description).toBe(
      "What it means to worship in spirit and in truth.",
    );
    // The shared `blogPostPath` helper's answer, not a retyped string.
    expect(card.href).toBe("/blog/doxological-worship");
    expect(card.publishedAt).toBeGreaterThan(0);
    expect(card.coverUrl).toBeNull();
    expect(card.pinned).toBe(false);
  });

  test("maxPosts caps the row, and 0 shows nothing while keeping it", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedSeat(s, ["marketing.site.edit"]);
    await seedPost(s, { slug: "a", daysAgo: 1 });
    await seedPost(s, { slug: "b", daysAgo: 2 });
    await seedPost(s, { slug: "c", daysAgo: 3 });
    const rowId = await seedPostsRow(s, { maxPosts: 2 });

    let feed = await t.query(internal.marketingSite.publicSiteContent, {});
    expect(feed.posts.map((p) => p.slug)).toEqual(["a", "b"]);

    // 0 is "show none", which is NOT the same as unpublishing: the row keeps
    // its place in the grid and the marketer can see the choice is deliberate.
    await s.as.mutation(api.marketingSite.upsertLink, {
      linkId: rowId,
      title: "Latest blog posts",
      align: "center",
      published: true,
      maxPosts: 0,
    });
    feed = await t.query(internal.marketingSite.publicSiteContent, {});
    expect(feed.posts).toEqual([]);
    expect(feed.links.some((l) => l.kind === "posts")).toBe(true);
  });

  test("a count above the cap is refused, not silently clamped", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedSeat(s, ["marketing.site.edit"]);
    await expect(
      seedPostsRow(s, { maxPosts: SITE_LINK_MAX_POSTS_CAP + 1 }),
    ).rejects.toThrow(/between 0 and/i);
  });

  test("a row written above the cap is still clamped on the way out", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedSeat(s, ["marketing.site.edit"]);
    for (const slug of ["a", "b", "c", "d"]) {
      await seedPost(s, { slug, daysAgo: ["a", "b", "c", "d"].indexOf(slug) + 1 });
    }
    const rowId = await seedPostsRow(s, { maxPosts: SITE_LINK_MAX_POSTS_CAP });
    // The write path refuses this; a row that predates a LOWERED cap would not
    // have, so the reader clamps too rather than trusting the stored number.
    await run(t, (ctx) => ctx.db.patch(rowId, { maxPosts: 99 }));

    const feed = await t.query(internal.marketingSite.publicSiteContent, {});
    expect(feed.posts).toHaveLength(SITE_LINK_MAX_POSTS_CAP);
  });

  test("a pin leads the row, in the marketer's order", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedSeat(s, ["marketing.site.edit"]);
    await seedPost(s, { slug: "newest", daysAgo: 1 });
    await seedPost(s, { slug: "evergreen", daysAgo: 400 });
    await seedPostsRow(s, { maxPosts: 2, pinned: ["evergreen"] });

    const feed = await t.query(internal.marketingSite.publicSiteContent, {});
    expect(feed.posts.map((p) => p.slug)).toEqual(["evergreen", "newest"]);
    expect(feed.posts[0].pinned).toBe(true);
    expect(feed.posts[1].pinned).toBe(false);
  });

  test("a pin naming a draft, an archived post, or nothing is skipped", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedSeat(s, ["marketing.site.edit"]);
    await seedPost(s, { slug: "live", daysAgo: 1 });
    await seedPost(s, { slug: "in-progress", status: "draft" });
    await seedPost(s, { slug: "taken-down", status: "archived", daysAgo: 5 });
    await seedPostsRow(s, {
      maxPosts: 3,
      pinned: ["in-progress", "taken-down", "never-existed", "live"],
    });

    // A pin is an INTENT, not a reference: a stale one costs nothing, and a pin
    // can only ever reorder what is already public — never put a 404 on the
    // front page.
    const feed = await t.query(internal.marketingSite.publicSiteContent, {});
    expect(feed.posts.map((p) => p.slug)).toEqual(["live"]);
  });

  test("hide beats pin", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedSeat(s, ["marketing.site.edit"]);
    await seedPost(s, { slug: "newest", daysAgo: 1 });
    await seedPost(s, { slug: "not-front-page", daysAgo: 2 });
    await seedPostsRow(s, {
      maxPosts: 3,
      pinned: ["not-front-page"],
      hidden: ["not-front-page"],
    });

    const feed = await t.query(internal.marketingSite.publicSiteContent, {});
    expect(feed.posts.map((p) => p.slug)).toEqual(["newest"]);
  });

  test("the public feed never carries the posts row's hide list", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedSeat(s, ["marketing.site.edit"]);
    await seedPost(s, { slug: "newest", daysAgo: 1 });
    await seedPost(s, { slug: "internal-memo", daysAgo: 2 });
    await seedPostsRow(s, { maxPosts: 1, hidden: ["internal-memo"] });

    // "Published, but not something we put on the front page" is a judgment
    // about our own writing, and `GET /api/site/home` is read by anyone.
    const feed = await t.query(internal.marketingSite.publicSiteContent, {});
    expect(JSON.stringify(feed)).not.toContain("internal-memo");
    const publicRow = feed.links.find((l) => l.kind === "posts");
    expect(publicRow?.hiddenPostSlugs).toBeNull();
    expect(publicRow?.pinnedPostSlugs).toBeNull();
    expect(publicRow?.maxPosts).toBeNull();

    // The DESK sees the controls — it has to, to render them.
    const desk = await s.as.query(api.marketingSite.siteContent, {});
    const deskRow = desk.links.find((l) => l.kind === "posts");
    expect(deskRow?.hiddenPostSlugs).toEqual(["internal-memo"]);
    expect(deskRow?.maxPosts).toBe(1);
  });

  test("the desk's preview and the public feed agree", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedSeat(s, ["marketing.site.edit"]);
    await seedPost(s, { slug: "newest", daysAgo: 1 });
    await seedPost(s, { slug: "evergreen", daysAgo: 400 });
    await seedPost(s, { slug: "hidden-one", daysAgo: 2 });
    const rowId = await seedPostsRow(s, {
      maxPosts: 2,
      pinned: ["evergreen"],
      hidden: ["hidden-one"],
    });

    const feed = await t.query(internal.marketingSite.publicSiteContent, {});
    let desk = await s.as.query(api.marketingSite.siteContent, {});
    // One resolver, so the preview cannot lie about what the page will show.
    expect(desk.postPreview).toEqual(feed.posts);

    // Unpublishing takes the cards off the PAGE but not out of the preview —
    // the marketer needs to see what turning the row back on would do.
    await s.as.mutation(api.marketingSite.setLinkPublished, {
      linkId: rowId,
      published: false,
    });
    const dark = await t.query(internal.marketingSite.publicSiteContent, {});
    expect(dark.posts).toEqual([]);
    desk = await s.as.query(api.marketingSite.siteContent, {});
    expect(desk.postPreview.map((p) => p.slug)).toEqual(["evergreen", "newest"]);
  });

  test("post settings are refused on an ordinary card", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedSeat(s, ["marketing.site.edit"]);
    await expect(
      s.as.mutation(api.marketingSite.upsertLink, {
        title: "Donate",
        url: "/give",
        align: "center",
        published: true,
        maxPosts: 2,
      }),
    ).rejects.toThrow(/only the latest-posts row/i);
  });

  test("a second posts row is refused", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedSeat(s, ["marketing.site.edit"]);
    await seedPostsRow(s, { maxPosts: 1 });
    // Two placeholders for one list of cards, and no rule for which the page
    // honors.
    await expect(seedPostsRow(s, { maxPosts: 1 })).rejects.toThrow(
      /already a latest-posts row/i,
    );
  });

  test("the posts row is not deletable — only hideable", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedSeat(s, ["marketing.site.edit"]);
    const rowId = await seedPostsRow(s, { maxPosts: 1 });
    await expect(
      s.as.mutation(api.marketingSite.deleteLink, { linkId: rowId }),
    ).rejects.toThrow(/can't be deleted/i);
  });

  test("editing the row's title keeps its pins and hides", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedSeat(s, ["marketing.site.edit"]);
    await seedPost(s, { slug: "evergreen", daysAgo: 400 });
    const rowId = await seedPostsRow(s, {
      maxPosts: 2,
      pinned: ["evergreen"],
      hidden: ["internal-memo"],
    });

    // The row editor does not carry the pickers' lists, so "not sent" must mean
    // KEEP — the same rule the image fields follow, and the same bug otherwise.
    await s.as.mutation(api.marketingSite.upsertLink, {
      linkId: rowId,
      title: "From the blog",
      align: "center",
      published: true,
    });
    const desk = await s.as.query(api.marketingSite.siteContent, {});
    const row = desk.links.find((l) => l.kind === "posts");
    expect(row?.title).toBe("From the blog");
    expect(row?.pinnedPostSlugs).toEqual(["evergreen"]);
    expect(row?.hiddenPostSlugs).toEqual(["internal-memo"]);
    expect(row?.maxPosts).toBe(2);
  });
});

describe("the posts pickers", () => {
  test("setPostsRow creates the row when there is none, then edits it", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedSeat(s, ["marketing.site.edit"]);
    await seedPost(s, { slug: "newest", daysAgo: 1 });
    await seedPost(s, { slug: "evergreen", daysAgo: 400 });

    const rowId = await s.as.mutation(api.marketingSite.setPostsRow, {
      maxPosts: 2,
      pinnedPostSlugs: ["evergreen"],
    });
    let feed = await t.query(internal.marketingSite.publicSiteContent, {});
    expect(feed.posts.map((p) => p.slug)).toEqual(["evergreen", "newest"]);

    // Same row, not a second one — and an omitted list HERE means "cleared",
    // because this mutation is the pickers' own save button.
    const again = await s.as.mutation(api.marketingSite.setPostsRow, {
      maxPosts: 1,
    });
    expect(again).toBe(rowId);
    feed = await t.query(internal.marketingSite.publicSiteContent, {});
    expect(feed.posts.map((p) => p.slug)).toEqual(["newest"]);
    expect(feed.links.filter((l) => l.kind === "posts")).toHaveLength(1);
  });

  test("the picker still lists a taken-down post, so its hide can be lifted", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedSeat(s, ["marketing.site.edit"]);
    await seedPost(s, { slug: "live", daysAgo: 1 });
    await seedPost(s, { slug: "taken-down", status: "archived", daysAgo: 5 });
    await seedPost(s, { slug: "in-progress", status: "draft" });
    await seedPostsRow(s, { maxPosts: 1, hidden: ["taken-down"] });

    const options = await s.as.query(api.marketingSite.pinnablePosts, {});
    expect(options.map((p) => p.slug)).toEqual(["live", "taken-down"]);
    expect(options.find((p) => p.slug === "taken-down")?.isPublished).toBe(false);
    expect(options.find((p) => p.slug === "live")?.onPageNow).toBe(true);
  });
});

describe("ensurePostsRow", () => {
  test("adds the row to an already-seeded deployment, once", async () => {
    const t = newT();
    await t.mutation(internal.marketingSite.seedSiteContentIfEmpty, {});
    // Stand in for a database seeded before the posts row existed.
    await run(t, async (ctx) => {
      const rows = await ctx.db.query("siteLinks").collect();
      for (const row of rows) if (row.kind === "posts") await ctx.db.delete(row._id);
    });

    expect(await run(t, (ctx) => ensurePostsRow(ctx))).toEqual({ inserted: true });
    // Idempotent, because the migration that calls it runs on every deploy.
    expect(await run(t, (ctx) => ensurePostsRow(ctx))).toEqual({ inserted: false });

    const feed = await t.query(internal.marketingSite.publicSiteContent, {});
    expect(feed.links.filter((l) => l.kind === "posts")).toHaveLength(1);
    // Directly after the events row, wherever that row happens to be.
    const kinds = feed.links.map((l) => l.kind);
    expect(kinds.indexOf("posts")).toBe(kinds.indexOf("events") + 1);
  });
});

describe("impact stats", () => {
  test("a card needs both a number and a label", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedSeat(s, ["marketing.site.edit"]);
    await expect(
      s.as.mutation(api.marketingSite.upsertStat, { value: "700,000+", label: "" }),
    ).rejects.toThrow(/both a number and a label/i);
  });

  test("cards render in order and reorder as a whole list", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedSeat(s, ["marketing.site.edit"]);
    const a = await s.as.mutation(api.marketingSite.upsertStat, {
      value: "1",
      label: "First",
    });
    const b = await s.as.mutation(api.marketingSite.upsertStat, {
      value: "2",
      label: "Second",
    });
    await s.as.mutation(api.marketingSite.reorderStats, { statIds: [b, a] });
    const feed = await t.query(internal.marketingSite.publicSiteContent, {});
    expect(feed.stats.map((x) => x.label)).toEqual(["Second", "First"]);
  });
});

describe("the seed", () => {
  test("restores the shipped cards and numbers, and is idempotent", async () => {
    const t = newT();
    const first = await t.mutation(
      internal.marketingSite.seedSiteContentIfEmpty,
      {},
    );
    expect(first.links).toBeGreaterThan(0);
    expect(first.stats).toBe(3);

    const second = await t.mutation(
      internal.marketingSite.seedSiteContentIfEmpty,
      {},
    );
    expect(second).toEqual({ links: 0, stats: 0 });

    const feed = await t.query(internal.marketingSite.publicSiteContent, {});
    // The events row keeps the position it had when it was hardcoded: after
    // Donate, before the socials.
    expect(feed.links.map((l) => l.kind)).toEqual([
      "link",
      "events",
      "posts",
      "link",
      "link",
      "link",
    ]);
    expect(feed.stats.map((s) => s.value)).toEqual(["700,000+", "15+", "10+"]);
  });
});

/** A superuser bypass exists everywhere in this repo; the desk's gate is no
 *  exception, and a test that did not say so would leave the next reader
 *  wondering whether it was an oversight. */
describe("access", () => {
  test("a caller with no seat at all sees no desk", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const access = await s.as.query(api.marketingSite.myMarketingAccess, {});
    expect(access).toEqual({
      canViewDesk: false,
      canEditSite: false,
      canEditDesigns: false,
      canEditBlog: false,
      canPublishBlog: false,
      canViewList: false,
      canEditList: false,
    });
  });

  test("marketing.list.edit implies list.view but grants nothing on the site", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedSeat(s, ["marketing.list.edit"]);
    const access = await s.as.query(api.marketingSite.myMarketingAccess, {});
    expect(access.canViewList).toBe(true);
    expect(access.canEditList).toBe(true);
    expect(access.canEditSite).toBe(false);
    expect(access.canViewDesk).toBe(true);
  });

  test("marketing.site.edit at a CHAPTER scope reaches nothing", async () => {
    const t = newT();
    const s = await setupChapter(t);
    // The power is declared `scope: "central"` — the org has one homepage — so
    // a chapter grant must be inert in the enforcement path, not merely
    // rendered honestly on the org chart.
    const now = Date.now();
    await run(t, async (ctx) => {
      const personId = await ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Chapter Marketing Lead",
        userId: s.userId,
        createdAt: now,
      });
      const seatDefId = await ctx.db.insert("seatDefs", {
        slug: "test_chapter_marketing",
        title: "Chapter Marketing Lead",
        chart: "chapter",
        parentSlug: "root",
        maxHolders: 1,
        duties: [],
        capabilities: ["marketing.site.edit"],
        sortOrder: 0,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("seatAssignments", {
        seatDefId,
        scope: s.chapterId as Id<"chapters">,
        personId,
        createdAt: now,
      });
    });
    const access = await s.as.query(api.marketingSite.myMarketingAccess, {});
    expect(access.canEditSite).toBe(false);
  });
});
