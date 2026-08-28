/**
 * The homepage's OS-managed content.
 *
 * The rules worth pinning: only a `marketing.site.edit` holder writes; the
 * public feed shows published rows only and never leaks a draft; a copy slot
 * cleared to empty falls back to the shipped default rather than blanking the
 * page; a card must go somewhere or copy something, and its URL cannot be a
 * `javascript:` scheme; the events row honors count, pins, and hides — with
 * hide beating pin — and cannot be deleted; and the one-time seed is
 * idempotent.
 */
import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import { SITE_COPY_DEFS } from "@events-os/shared";
import type { Id } from "../_generated/dataModel";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";

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
