import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import type { Id } from "../_generated/dataModel";

/**
 * Ticketing flow tests: page lifecycle (create → publish → public read),
 * RSVP identity + counters, activity gating (comments/reactions behind a
 * guest token), and order fulfillment (free carts issuing tickets, counters,
 * capacity enforcement, check-in).
 */

/** Minimal template + event so chapter-scoped admin functions have a target. */
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

/** Create + publish a page, returning its slug. */
async function publishPage(s: ChapterSetup, eventId: Id<"events">) {
  const pageId = await s.as.mutation(api.ticketing.createPage, { eventId });
  const admin = await s.as.query(api.ticketing.getAdminPage, { eventId });
  await s.as.mutation(api.ticketing.updatePage, {
    pageId: pageId as Id<"eventPages">,
    patch: { published: true },
  });
  return { pageId: pageId as Id<"eventPages">, slug: admin.page!.slug };
}

describe("event pages", () => {
  test("createPage is idempotent and slugs derive from the event name", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    const first = await s.as.mutation(api.ticketing.createPage, { eventId });
    const second = await s.as.mutation(api.ticketing.createPage, { eventId });
    expect(first).toEqual(second);
    const admin = await s.as.query(api.ticketing.getAdminPage, { eventId });
    expect(admin.page?.slug).toBe("worship-night-on-the-pier");
    expect(admin.page?.published).toBe(false);
  });

  test("unpublished pages are invisible publicly; published ones render", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    await s.as.mutation(api.ticketing.createPage, { eventId });
    const admin = await s.as.query(api.ticketing.getAdminPage, { eventId });
    const slug = admin.page!.slug;

    expect(await t.query(api.ticketing.getPublicPage, { slug })).toBeNull();

    await s.as.mutation(api.ticketing.updatePage, {
      pageId: admin.page!._id,
      patch: { published: true, tagline: "Come thru" },
    });
    const pub = await t.query(api.ticketing.getPublicPage, { slug });
    expect(pub?.eventName).toBe("Worship Night on the Pier");
    expect(pub?.tagline).toBe("Come thru");
    expect(pub?.activityLocked).toBe(true);
    expect(pub?.activity).toBeNull();
  });
});

describe("rsvps", () => {
  test("submit → counters, email dedupe, status change via token", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    const { slug } = await publishPage(s, eventId);

    const first = await t.mutation(api.ticketing.submitRsvp, {
      slug,
      name: "Ada Guest",
      email: "Ada@Example.com",
      status: "going",
    });
    expect(first.token).toBeTruthy();

    // Same email again (no token) updates the same row.
    await t.mutation(api.ticketing.submitRsvp, {
      slug,
      name: "Ada Guest",
      email: "ada@example.com",
      status: "maybe",
    });
    let pub = await t.query(api.ticketing.getPublicPage, { slug });
    expect(pub?.counts).toMatchObject({ going: 0, maybe: 1 });

    // Token-only status flip (no name/email resent).
    await t.mutation(api.ticketing.submitRsvp, {
      slug,
      token: first.token,
      status: "going",
    });
    pub = await t.query(api.ticketing.getPublicPage, {
      slug,
      token: first.token,
    });
    expect(pub?.counts).toMatchObject({ going: 1, maybe: 0 });
    expect(pub?.viewer).toMatchObject({ name: "Ada Guest", status: "going" });
    expect(pub?.activityLocked).toBe(false);
  });

  test("comments and reactions require an RSVP token", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    const { slug } = await publishPage(s, eventId);

    await expect(
      t.mutation(api.ticketing.addComment, {
        slug,
        token: "nope",
        body: "hi",
      }),
    ).rejects.toThrow();

    const { token } = await t.mutation(api.ticketing.submitRsvp, {
      slug,
      name: "Ada Guest",
      email: "ada@example.com",
      status: "going",
    });
    await t.mutation(api.ticketing.addComment, {
      slug,
      token,
      body: "What should I bring?",
    });

    let pub = await t.query(api.ticketing.getPublicPage, { slug, token });
    const comment = pub?.activity?.find(
      (a) => (a as { type: string }).type === "comment",
    ) as { id: string; body: string } | undefined;
    expect(comment?.body).toBe("What should I bring?");

    // React, then toggle off.
    const on = await t.mutation(api.ticketing.toggleReaction, {
      slug,
      token,
      targetType: "comment",
      targetId: comment!.id,
      emoji: "🔥",
    });
    expect(on.reacted).toBe(true);
    pub = await t.query(api.ticketing.getPublicPage, { slug, token });
    const withReact = pub?.activity?.find(
      (a) => (a as { id: string }).id === comment!.id,
    ) as { reactions: Array<{ emoji: string; count: number; mine: boolean }> };
    expect(withReact.reactions).toEqual([
      { emoji: "🔥", count: 1, mine: true },
    ]);
    const off = await t.mutation(api.ticketing.toggleReaction, {
      slug,
      token,
      targetType: "comment",
      targetId: comment!.id,
      emoji: "🔥",
    });
    expect(off.reacted).toBe(false);
  });
});

describe("orders & tickets", () => {
  async function setupTickets(s: ChapterSetup, eventId: Id<"events">) {
    const { pageId, slug } = await publishPage(s, eventId);
    await s.as.mutation(api.ticketing.updatePage, {
      pageId,
      patch: { ticketsEnabled: true },
    });
    const freeId = await s.as.mutation(api.ticketing.createTicketType, {
      eventId,
      name: "Community",
      priceCents: 0,
      capacity: 2,
    });
    return { slug, freeId: freeId as Id<"ticketTypes"> };
  }

  test("free order fulfills: tickets issued, counters bumped, buyer goes 'going'", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    const { slug, freeId } = await setupTickets(s, eventId);

    const prepared = await t.mutation(internal.ticketing.prepareOrder, {
      slug,
      name: "Ben Buyer",
      email: "ben@example.com",
      items: [{ ticketTypeId: freeId, quantity: 2 }],
    });
    expect(prepared.totalCents).toBe(0);
    await t.mutation(internal.ticketing.fulfillOrder, {
      orderId: prepared.orderId,
    });

    const tickets = await s.as.query(api.ticketing.listTicketsAdmin, {
      eventId,
    });
    expect(tickets).toHaveLength(2);
    expect(tickets[0].code).toMatch(/^PW-[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/);

    const pub = await t.query(api.ticketing.getPublicPage, {
      slug,
      token: prepared.guestToken,
    });
    expect(pub?.counts).toMatchObject({ going: 1, ticketsSold: 2 });
    expect(pub?.viewer?.status).toBe("going");

    // Sold out now (capacity 2).
    await expect(
      t.mutation(internal.ticketing.prepareOrder, {
        slug,
        name: "Cara Late",
        email: "cara@example.com",
        items: [{ ticketTypeId: freeId, quantity: 1 }],
      }),
    ).rejects.toThrow();

    // Fulfillment is idempotent.
    await t.mutation(internal.ticketing.fulfillOrder, {
      orderId: prepared.orderId,
    });
    expect(
      await s.as.query(api.ticketing.listTicketsAdmin, { eventId }),
    ).toHaveLength(2);
  });

  test("check-in transitions valid → checked_in → already", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    const { slug, freeId } = await setupTickets(s, eventId);
    const prepared = await t.mutation(internal.ticketing.prepareOrder, {
      slug,
      name: "Ben Buyer",
      email: "ben@example.com",
      items: [{ ticketTypeId: freeId, quantity: 1 }],
    });
    await t.mutation(internal.ticketing.fulfillOrder, {
      orderId: prepared.orderId,
    });
    const [ticket] = await s.as.query(api.ticketing.listTicketsAdmin, {
      eventId,
    });

    const ok = await s.as.mutation(api.ticketing.checkInTicket, {
      eventId,
      code: ticket.code.toLowerCase(),
    });
    expect(ok.result).toBe("ok");
    const again = await s.as.mutation(api.ticketing.checkInTicket, {
      eventId,
      code: ticket.code,
    });
    expect(again.result).toBe("already");
    const missing = await s.as.mutation(api.ticketing.checkInTicket, {
      eventId,
      code: "PW-XXXX-XXXX",
    });
    expect(missing.result).toBe("not_found");
  });
});
