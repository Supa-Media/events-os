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
      phone: "5551234567",
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
      phone: "5551234567",
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

describe("event mode (RSVP vs ticketed are exclusive)", () => {
  test("switching to ticketed archives free RSVPs, keeps buyers, blocks switch-back once sold", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    const { pageId, slug } = await publishPage(s, eventId);

    // Two free RSVPs while the event is in RSVP mode (the default).
    await t.mutation(api.ticketing.submitRsvp, {
      slug,
      name: "Rita RSVP",
      email: "rita@example.com",
      status: "going",
    });
    await t.mutation(api.ticketing.submitRsvp, {
      slug,
      name: "Maya Maybe",
      email: "maya@example.com",
      status: "maybe",
    });
    let pub = await t.query(api.ticketing.getPublicPage, { slug });
    expect(pub?.counts).toMatchObject({ going: 1, maybe: 1 });
    expect(pub?.guests).toHaveLength(2);

    // Enabling tickets flips the event to ticketed mode: RSVP is turned off and
    // the free-RSVP guests are archived out of the counts, guest list, and feed.
    await s.as.mutation(api.ticketing.updatePage, {
      pageId,
      patch: { ticketsEnabled: true },
    });
    pub = await t.query(api.ticketing.getPublicPage, { slug });
    expect(pub?.rsvpEnabled).toBe(false);
    expect(pub?.counts).toMatchObject({ going: 0, maybe: 0 });
    expect(pub?.guests).toHaveLength(0);
    // The rows are archived (recoverable), not deleted.
    const admin = await s.as.query(api.ticketing.listRsvpsAdmin, { eventId });
    expect(admin).toHaveLength(0);
    const stillThere = await run(s.t, (ctx) =>
      ctx.db
        .query("rsvps")
        .withIndex("by_event", (q) => q.eq("eventId", eventId))
        .collect(),
    );
    expect(stillThere).toHaveLength(2);
    expect(stillThere.every((r) => r.archivedAt != null)).toBe(true);

    // A ticket buyer is kept — never archived.
    const freeId = (await s.as.mutation(api.ticketing.createTicketType, {
      eventId,
      name: "Community",
      priceCents: 0,
    })) as Id<"ticketTypes">;
    const prepared = await t.mutation(internal.ticketing.prepareOrder, {
      slug,
      name: "Ben Buyer",
      email: "ben@example.com",
      phone: "5551234567",
      items: [{ ticketTypeId: freeId, quantity: 1 }],
    });
    await t.mutation(internal.ticketing.fulfillOrder, {
      orderId: prepared.orderId,
    });
    pub = await t.query(api.ticketing.getPublicPage, { slug });
    expect(pub?.counts).toMatchObject({ going: 1, ticketsSold: 1 });
    expect(pub?.guests).toHaveLength(1);

    // Once a ticket has sold, the event can't be switched back to RSVP.
    await expect(
      s.as.mutation(api.ticketing.updatePage, {
        pageId,
        patch: { rsvpEnabled: true },
      }),
    ).rejects.toThrow();
  });

  test("enabling both RSVP and tickets at once is rejected", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    const { pageId } = await publishPage(s, eventId);
    await expect(
      s.as.mutation(api.ticketing.updatePage, {
        pageId,
        patch: { rsvpEnabled: true, ticketsEnabled: true },
      }),
    ).rejects.toThrow();
  });
});

describe("stripe webhook fulfillment", () => {
  /** Publish a page with a paid tier and return its slug + ticket type id. */
  async function paidSetup(s: ChapterSetup, eventId: Id<"events">) {
    const { pageId, slug } = await publishPage(s, eventId);
    await s.as.mutation(api.ticketing.updatePage, {
      pageId,
      patch: { ticketsEnabled: true },
    });
    const paidId = await s.as.mutation(api.ticketing.createTicketType, {
      eventId,
      name: "Supporter",
      priceCents: 2500,
    });
    return { slug, paidId: paidId as Id<"ticketTypes"> };
  }

  test("markSessionPaid issues tickets, marks paid, and is idempotent on redelivery", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    const { slug, paidId } = await paidSetup(s, eventId);

    const prepared = await t.mutation(internal.ticketing.prepareOrder, {
      slug,
      name: "Ben Buyer",
      email: "ben@example.com",
      phone: "5551234567",
      items: [{ ticketTypeId: paidId, quantity: 2 }],
    });
    expect(prepared.totalCents).toBe(5000);

    // Paid carts wait for Stripe — no tickets until the webhook fires.
    expect(
      await s.as.query(api.ticketing.listTicketsAdmin, { eventId }),
    ).toHaveLength(0);

    await t.mutation(internal.ticketing.attachStripeSession, {
      orderId: prepared.orderId,
      sessionId: "cs_test_webhook",
    });
    await t.mutation(internal.ticketing.markSessionPaid, {
      sessionId: "cs_test_webhook",
      paymentIntentId: "pi_123",
    });

    const tickets = await s.as.query(api.ticketing.listTicketsAdmin, { eventId });
    expect(tickets).toHaveLength(2);
    const orders = await s.as.query(api.ticketing.listOrdersAdmin, { eventId });
    expect(orders[0]).toMatchObject({
      status: "paid",
      stripePaymentIntentId: "pi_123",
    });
    const pub = await t.query(api.ticketing.getPublicPage, {
      slug,
      token: prepared.guestToken,
    });
    expect(pub?.counts).toMatchObject({ going: 1, ticketsSold: 2 });
    expect(pub?.viewer?.status).toBe("going");

    // A duplicate webhook delivery must not double-issue.
    await t.mutation(internal.ticketing.markSessionPaid, {
      sessionId: "cs_test_webhook",
      paymentIntentId: "pi_123",
    });
    expect(
      await s.as.query(api.ticketing.listTicketsAdmin, { eventId }),
    ).toHaveLength(2);
  });

  test("combined checkout: paid order with an add-on donation splits revenue vs. giving on fulfillment", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    const { slug, paidId } = await paidSetup(s, eventId);

    const prepared = await t.mutation(internal.ticketing.prepareOrder, {
      slug,
      name: "Ben Buyer",
      email: "ben@example.com",
      phone: "5551234567",
      items: [{ ticketTypeId: paidId, quantity: 1 }],
      donationCents: 1500,
    });
    expect(prepared.totalCents).toBe(2500);
    expect(prepared.donationCents).toBe(1500);

    await t.mutation(internal.ticketing.attachStripeSession, {
      orderId: prepared.orderId,
      sessionId: "cs_test_combined",
    });
    await t.mutation(internal.ticketing.markSessionPaid, {
      sessionId: "cs_test_combined",
      paymentIntentId: "pi_combined",
    });

    // Ticket revenue and the donation rollup land in their own buckets — the
    // money invariant never mixes them.
    const admin = await s.as.query(api.ticketing.getAdminPage, { eventId });
    expect(admin.page?.revenueCents).toBe(2500);
    expect(admin.page?.donationsCents).toBe(1500);
    expect(admin.page?.donationsCount).toBe(1);

    const donations = await s.as.query(api.giving.listDonationsAdmin, {
      eventId,
    });
    expect(donations).toHaveLength(1);
    expect(donations[0]).toMatchObject({
      amountCents: 1500,
      status: "paid",
      method: "card",
      email: "ben@example.com",
    });

    // Dual-written into the donor CRM (gifts ledger), not hand-rolled.
    const gift = await run(t, async (ctx) =>
      ctx.db
        .query("gifts")
        .withIndex("by_donation", (q) => q.eq("donationId", donations[0]._id))
        .first(),
    );
    expect(gift?.amountCents).toBe(1500);

    // A duplicate webhook delivery must not double-create the donation (the
    // order's own `status === "paid"` guard short-circuits `fulfill`).
    await t.mutation(internal.ticketing.markSessionPaid, {
      sessionId: "cs_test_combined",
      paymentIntentId: "pi_combined",
    });
    expect(
      await s.as.query(api.giving.listDonationsAdmin, { eventId }),
    ).toHaveLength(1);
    const adminAfter = await s.as.query(api.ticketing.getAdminPage, {
      eventId,
    });
    expect(adminAfter.page?.donationsCents).toBe(1500);
  });

  test("prepareOrder rejects a negative or fractional donationCents", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    const { slug, paidId } = await paidSetup(s, eventId);

    await expect(
      t.mutation(internal.ticketing.prepareOrder, {
        slug,
        name: "Ben Buyer",
        email: "ben@example.com",
        items: [{ ticketTypeId: paidId, quantity: 1 }],
        donationCents: -100,
      }),
    ).rejects.toThrow();
    await expect(
      t.mutation(internal.ticketing.prepareOrder, {
        slug,
        name: "Ben Buyer",
        email: "ben@example.com",
        items: [{ ticketTypeId: paidId, quantity: 1 }],
        donationCents: 12.5,
      }),
    ).rejects.toThrow();
  });

  test("prepareOrder requires a phone; a returning guest reuses one on file", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    const { slug, paidId } = await paidSetup(s, eventId);

    // No phone at all → rejected.
    await expect(
      t.mutation(internal.ticketing.prepareOrder, {
        slug,
        name: "No Phone",
        email: "nophone@example.com",
        items: [{ ticketTypeId: paidId, quantity: 1 }],
      }),
    ).rejects.toThrow();

    // A number that can't be normalized → rejected.
    await expect(
      t.mutation(internal.ticketing.prepareOrder, {
        slug,
        name: "Bad Phone",
        email: "bad@example.com",
        phone: "123",
        items: [{ ticketTypeId: paidId, quantity: 1 }],
      }),
    ).rejects.toThrow();

    // A valid number is normalized to E.164 and stored on the buyer's rsvp.
    const prepared = await t.mutation(internal.ticketing.prepareOrder, {
      slug,
      name: "Pat Phone",
      email: "pat@example.com",
      phone: "(555) 867-5309",
      items: [{ ticketTypeId: paidId, quantity: 1 }],
    });
    const rsvp = await run(t, async (ctx) =>
      ctx.db
        .query("rsvps")
        .withIndex("by_token", (q) => q.eq("token", prepared.guestToken))
        .unique(),
    );
    expect(rsvp?.phone).toBe("+15558675309");

    // The returning guest (same token) can buy again WITHOUT re-entering it.
    const again = await t.mutation(internal.ticketing.prepareOrder, {
      slug,
      name: "Pat Phone",
      email: "pat@example.com",
      token: prepared.guestToken,
      items: [{ ticketTypeId: paidId, quantity: 1 }],
    });
    expect(again.orderId).toBeDefined();
  });

  test("cancelPendingOrder expires an unpaid order without issuing tickets", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    const { slug, paidId } = await paidSetup(s, eventId);

    const prepared = await t.mutation(internal.ticketing.prepareOrder, {
      slug,
      name: "Cara",
      email: "cara@example.com",
      phone: "5559990000",
      items: [{ ticketTypeId: paidId, quantity: 1 }],
    });
    await t.mutation(internal.ticketing.attachStripeSession, {
      orderId: prepared.orderId,
      sessionId: "cs_test_expire",
    });
    await t.mutation(internal.ticketing.cancelPendingOrder, {
      sessionId: "cs_test_expire",
    });

    const orders = await s.as.query(api.ticketing.listOrdersAdmin, { eventId });
    expect(orders[0].status).toBe("expired");
    expect(
      await s.as.query(api.ticketing.listTicketsAdmin, { eventId }),
    ).toHaveLength(0);
  });
});
