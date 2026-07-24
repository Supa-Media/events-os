/**
 * Dev-only demo seed for the ticketing feature. Run from the CLI:
 *
 *   npx convex run seedTicketing:seedTicketingDemo
 *   npx convex run seedTicketing:seedTicketingCover   (adds a cover photo)
 *
 * Grabs the first event in the database, dresses it with a published public
 * page, ticket tiers, RSVPs, comments and reactions so /rsvp/<slug> renders a
 * fully-populated Posh/Partiful-style RSVP page (the older /event/<slug> and
 * legacy /e/<slug> aliases still resolve). Idempotent by slug.
 */
import { internalAction, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";

const SLUG = "worship-on-the-water";

export const seedTicketingDemo = internalMutation({
  args: {},
  handler: async (ctx) => {
    const existing = await ctx.db
      .query("eventPages")
      .withIndex("by_slug", (q) => q.eq("slug", SLUG))
      .unique();
    if (existing) return { slug: SLUG, note: "already seeded" };

    const event = await ctx.db.query("events").first();
    if (!event) throw new Error("Seed the main demo data first (no events).");
    const user = await ctx.db.query("users").first();
    if (!user) throw new Error("Sign in once first (no users).");

    const now = Date.now();
    const pageId = await ctx.db.insert("eventPages", {
      eventId: event._id,
      chapterId: event.chapterId,
      slug: SLUG,
      published: true,
      tagline: "Golden hour, open air, and a night of worship on the pier.",
      description:
        "Bring a friend and a blanket — we're taking worship outside while the sun goes down over the East River.\n\nDoors at 6:30. Music from 7 until the candles burn out. Free water & snacks; dinner from the food trucks next door.\n\nCome early, the rooftop fills up fast.",
      hostName: "Public Worship",
      venueName: "The Rooftop at Pier 17",
      address: "89 South St, New York, NY 10038",
      addressVisibility: "after_rsvp",
      rsvpEnabled: true,
      ticketsEnabled: true,
      showGuestList: true,
      activityRestricted: true,
      capacity: 150,
      goingCount: 0,
      maybeCount: 0,
      notGoingCount: 0,
      ticketsSoldCount: 0,
      revenueCents: 0,
      createdBy: user._id as Id<"users">,
      createdAt: now,
      updatedAt: now,
    });

    // Ticket tiers.
    const tiers = [
      {
        name: "Community (Free)",
        description: "Just come — seats up front for first-timers.",
        priceCents: 0,
        capacity: 100,
        maxPerOrder: 2,
      },
      {
        name: "Early Bird",
        description: "First 50 through the door. Includes a candle.",
        priceCents: 1500,
        capacity: 50,
        maxPerOrder: 4,
      },
      {
        name: "Supporter",
        description: "Covers you + sponsors a seat for someone else.",
        priceCents: 2500,
        capacity: undefined as number | undefined,
        maxPerOrder: 6,
      },
    ];
    for (let i = 0; i < tiers.length; i++) {
      const t = tiers[i];
      await ctx.db.insert("ticketTypes", {
        eventId: event._id,
        chapterId: event.chapterId,
        name: t.name,
        description: t.description,
        priceCents: t.priceCents,
        currency: "usd",
        capacity: t.capacity,
        soldCount: t.name === "Early Bird" ? 43 : 0, // demo "Only 7 left"
        maxPerOrder: t.maxPerOrder,
        sortOrder: i,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      });
    }

    // Guests + activity.
    const guests: Array<{ n: string; s: "going" | "maybe"; c?: string }> = [
      { n: "Charisma Okoro", s: "going" },
      { n: "Azalia Reyes", s: "maybe" },
      { n: "Princess Adeyemi", s: "maybe" },
      { n: "Takida J", s: "going", c: "What should I bring?" },
      { n: "Zayy Powell", s: "going" },
      { n: "Emmanuella Nnuji-John", s: "going" },
      { n: "Seyi Alao", s: "going", c: "Been waiting for this one 🙌" },
      { n: "Marcus Lee", s: "going" },
      { n: "Naomi Chen", s: "maybe" },
    ];
    let going = 0;
    let maybe = 0;
    const rsvpIds: Id<"rsvps">[] = [];
    for (let i = 0; i < guests.length; i++) {
      const g = guests[i];
      const ts = now - (guests.length - i) * 47 * 60 * 1000;
      const id = await ctx.db.insert("rsvps", {
        eventId: event._id,
        chapterId: event.chapterId,
        name: g.n,
        email: `${g.n.toLowerCase().replace(/[^a-z]+/g, ".")}@example.com`,
        status: g.s,
        token: `demo-${SLUG}-${i}-${Math.random().toString(36).slice(2, 10)}`,
        source: "rsvp",
        createdAt: ts,
        updatedAt: ts,
      });
      rsvpIds.push(id);
      if (g.s === "going") going++;
      else maybe++;
      if (g.c) {
        await ctx.db.insert("eventComments", {
          eventId: event._id,
          chapterId: event.chapterId,
          replyToRsvpId: id,
          rsvpId: id,
          authorName: g.n,
          body: g.c,
          createdAt: ts + 3 * 60 * 1000,
        });
      }
    }
    // A top-level comment thread.
    const host = await ctx.db.insert("eventComments", {
      eventId: event._id,
      chapterId: event.chapterId,
      rsvpId: rsvpIds[5],
      authorName: "Emmanuella Nnuji-John",
      body: "Sunset is at 8:21 that night — bring layers, it gets breezy up there 🌇",
      createdAt: now - 30 * 60 * 1000,
    });
    await ctx.db.insert("eventComments", {
      eventId: event._id,
      chapterId: event.chapterId,
      parentId: host,
      rsvpId: rsvpIds[3],
      authorName: "Takida J",
      body: "Say less. Bringing the picnic blanket 😂",
      createdAt: now - 22 * 60 * 1000,
    });
    // Reactions.
    const sprinkle: Array<[Id<"rsvps"> | typeof host, "rsvp" | "comment", string, number]> = [
      [rsvpIds[5], "rsvp", "🔥", 3],
      [rsvpIds[0], "rsvp", "❤️", 2],
      [host, "comment", "🙌", 4],
      [rsvpIds[6], "rsvp", "🎉", 2],
    ];
    for (const [targetId, targetType, emoji, count] of sprinkle) {
      for (let i = 0; i < count; i++) {
        await ctx.db.insert("pageReactions", {
          eventId: event._id,
          chapterId: event.chapterId,
          targetType,
          targetId: String(targetId),
          emoji,
          actorKey: String(rsvpIds[(i * 2 + 1) % rsvpIds.length]),
          createdAt: now - i * 9 * 60 * 1000,
        });
      }
    }

    await ctx.db.patch(pageId, {
      goingCount: going,
      maybeCount: maybe,
      ticketsSoldCount: 43,
      revenueCents: 43 * 1500,
    });
    return { slug: SLUG, url: `/rsvp/${SLUG}`, going, maybe };
  },
});

/** Fetch a demo cover photo and attach it to the seeded page. */
export const seedTicketingCover = internalAction({
  args: { imageUrl: v.optional(v.string()) },
  handler: async (ctx, { imageUrl }) => {
    const url =
      imageUrl ?? "https://picsum.photos/seed/publicworship/1200/1500";
    const res = await fetch(url);
    if (!res.ok) throw new Error(`cover fetch failed: ${res.status}`);
    const blob = await res.blob();
    const storageId = await ctx.storage.store(blob);
    await ctx.runMutation(internal.seedTicketing.attachCover, { storageId });
    return { storageId };
  },
});

/**
 * Dev helper: clear pending OTP rows. Double-tapping "Send code" leaves two
 * `authVerificationCodes` rows and @convex-dev/auth's `unique()` then fails
 * every verify until they expire. Run when local login gets stuck:
 *
 *   npx convex run seedTicketing:devClearAuthCodes
 */
export const devClearAuthCodes = internalMutation({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("authVerificationCodes").take(100);
    for (const row of rows) await ctx.db.delete(row._id);
    return { cleared: rows.length };
  },
});

export const attachCover = internalMutation({
  args: { storageId: v.id("_storage") },
  handler: async (ctx, { storageId }) => {
    const page = await ctx.db
      .query("eventPages")
      .withIndex("by_slug", (q) => q.eq("slug", SLUG))
      .unique();
    if (!page) throw new Error("Run seedTicketingDemo first.");
    await ctx.db.patch(page._id, { coverImage: storageId, updatedAt: Date.now() });
    return null;
  },
});
