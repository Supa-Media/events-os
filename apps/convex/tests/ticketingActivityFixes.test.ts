import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import type { Id } from "../_generated/dataModel";

/**
 * Regression suite for three public-event-page fixes:
 *   1. An abandoned/pending ticket checkout leaves a status:"maybe" placeholder
 *      RSVP — it must never read as a guest or as "bought a ticket", and
 *      cancelling the order must reconcile the counter it inflated.
 *   2. A multi-ticket buyer surfaces `ticketCount > 1` in the public guests.
 *   3. A ticket purchase's activity timestamp is STABLE (the order's purchase
 *      time), so a later updatedAt bump (guest sign-in) or a Givebutter re-sync
 *      can't re-float an old purchase to the top of the feed; a first-ever
 *      Givebutter import uses the real GB purchase time, not "now".
 * Plus the idempotent, dry-run-safe counters backfill.
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

/**
 * Publish a TICKETED page with an open activity feed (so the public feed is
 * readable without a guest token) and one paid tier. Returns slug + ids.
 */
async function ticketedSetup(s: ChapterSetup, eventId: Id<"events">) {
  const pageId = (await s.as.mutation(api.ticketing.createPage, {
    eventId,
  })) as Id<"eventPages">;
  await s.as.mutation(api.ticketing.updatePage, {
    pageId,
    patch: { published: true, ticketsEnabled: true, activityRestricted: false },
  });
  const admin = await s.as.query(api.ticketing.getAdminPage, { eventId });
  const paidId = (await s.as.mutation(api.ticketing.createTicketType, {
    eventId,
    name: "Supporter",
    priceCents: 2500,
  })) as Id<"ticketTypes">;
  return { pageId, slug: admin.page!.slug, paidId };
}

type RsvpItem = { type: string; source?: string; createdAt: number };
function rsvpItems(activity: unknown[] | null | undefined): RsvpItem[] {
  return ((activity ?? []) as RsvpItem[]).filter((a) => a.type === "rsvp");
}

describe("abandoned ticket checkout (maybe placeholder)", () => {
  test("never a guest or 'bought a ticket'; cancel reconciles the maybe counter", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    const { slug, paidId } = await ticketedSetup(s, eventId);

    const prepared = await t.mutation(internal.ticketing.prepareOrder, {
      slug,
      name: "Abby Abandon",
      email: "abby@example.com",
      phone: "5551234567",
      items: [{ ticketTypeId: paidId, quantity: 1 }],
    });
    await t.mutation(internal.ticketing.attachStripeSession, {
      orderId: prepared.orderId,
      sessionId: "cs_abandon",
    });

    // Pre-cancel: the placeholder inflated maybeCount (documented drift) but is
    // NOT a guest and does NOT appear as a ticket purchase in the feed.
    let pub = await t.query(api.ticketing.getPublicPage, { slug });
    expect(pub?.counts).toMatchObject({ going: 0, maybe: 1, ticketsSold: 0 });
    expect(pub?.guests).toHaveLength(0);
    expect(rsvpItems(pub?.activity)).toHaveLength(0);

    // Cancelling the abandoned order reverts the placeholder + its counter.
    await t.mutation(internal.ticketing.cancelPendingOrder, {
      sessionId: "cs_abandon",
    });
    pub = await t.query(api.ticketing.getPublicPage, { slug });
    expect(pub?.counts).toMatchObject({ going: 0, maybe: 0, ticketsSold: 0 });
    expect(pub?.guests).toHaveLength(0);

    const rows = await run(t, (ctx) =>
      ctx.db
        .query("rsvps")
        .withIndex("by_event", (q) => q.eq("eventId", eventId))
        .collect(),
    );
    expect(rows).toHaveLength(0); // placeholder deleted
    const orders = await s.as.query(api.ticketing.listOrdersAdmin, { eventId });
    expect(orders[0].status).toBe("expired");
  });

  test("cancel leaves a legitimate pre-existing RSVP and a buyer with paid tickets untouched", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    // RSVP-enabled page: a real "maybe" RSVP is source "rsvp", never touched.
    const pageId = (await s.as.mutation(api.ticketing.createPage, {
      eventId,
    })) as Id<"eventPages">;
    await s.as.mutation(api.ticketing.updatePage, {
      pageId,
      patch: { published: true },
    });
    const admin = await s.as.query(api.ticketing.getAdminPage, { eventId });
    const slug = admin.page!.slug;

    const legit = await t.mutation(api.ticketing.submitRsvp, {
      slug,
      name: "Mia Maybe",
      email: "mia@example.com",
      status: "maybe",
    });
    // A stray expired order pointing at the legit RSVP must NOT delete it.
    await run(t, async (ctx) => {
      const rsvp = await ctx.db
        .query("rsvps")
        .withIndex("by_token", (q) => q.eq("token", legit.token))
        .unique();
      await ctx.db.insert("ticketOrders", {
        eventId,
        chapterId: s.chapterId,
        rsvpId: rsvp!._id,
        name: "Mia Maybe",
        email: "mia@example.com",
        items: [],
        totalCents: 0,
        currency: "usd",
        status: "pending",
        stripeCheckoutSessionId: "cs_stray",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });
    await t.mutation(internal.ticketing.cancelPendingOrder, {
      sessionId: "cs_stray",
    });
    const still = await run(t, (ctx) =>
      ctx.db
        .query("rsvps")
        .withIndex("by_event", (q) => q.eq("eventId", eventId))
        .collect(),
    );
    expect(still).toHaveLength(1);
    expect(still[0].source ?? "rsvp").toBe("rsvp");
    const pub = await t.query(api.ticketing.getPublicPage, { slug });
    expect(pub?.counts).toMatchObject({ maybe: 1 });
  });
});

describe("multi-ticket buyer in the public guest list", () => {
  test("a 4-ticket buyer reads ticketCount 4; a plain RSVP reads 0", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    const { slug, paidId } = await ticketedSetup(s, eventId);

    const prepared = await t.mutation(internal.ticketing.prepareOrder, {
      slug,
      name: "Sayo Olujide",
      email: "sayo@example.com",
      phone: "5551234567",
      items: [{ ticketTypeId: paidId, quantity: 4 }],
    });
    await t.mutation(internal.ticketing.attachStripeSession, {
      orderId: prepared.orderId,
      sessionId: "cs_multi",
    });
    await t.mutation(internal.ticketing.markSessionPaid, {
      sessionId: "cs_multi",
      paymentIntentId: "pi_multi",
    });

    const pub = await t.query(api.ticketing.getPublicPage, { slug });
    expect(pub?.guests).toHaveLength(1);
    expect(pub?.guests[0]).toMatchObject({
      name: "Sayo Olujide",
      status: "going",
      ticketCount: 4,
    });
    expect(pub?.counts).toMatchObject({ ticketsSold: 4 });
  });
});

describe("activity timestamp is the purchase time, not a later bump", () => {
  test("a sign-in updatedAt bump does not re-float a native purchase", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    const { slug, paidId } = await ticketedSetup(s, eventId);

    const prepared = await t.mutation(internal.ticketing.prepareOrder, {
      slug,
      name: "Tim Ticket",
      email: "tim@example.com",
      phone: "5551234567",
      items: [{ ticketTypeId: paidId, quantity: 1 }],
    });
    await t.mutation(internal.ticketing.attachStripeSession, {
      orderId: prepared.orderId,
      sessionId: "cs_stamp",
    });
    await t.mutation(internal.ticketing.markSessionPaid, {
      sessionId: "cs_stamp",
      paymentIntentId: "pi_stamp",
    });

    const order = await run(t, (ctx) =>
      ctx.db
        .query("ticketOrders")
        .withIndex("by_event", (q) => q.eq("eventId", eventId))
        .first(),
    );
    const purchaseTime = order!.createdAt;

    // Simulate a much-later guest sign-in / verification bumping updatedAt.
    const bumped = purchaseTime + 5_000_000;
    await run(t, async (ctx) => {
      const rsvp = await ctx.db
        .query("rsvps")
        .withIndex("by_event", (q) => q.eq("eventId", eventId))
        .first();
      await ctx.db.patch(rsvp!._id, { updatedAt: bumped });
    });

    const pub = await t.query(api.ticketing.getPublicPage, { slug });
    const items = rsvpItems(pub?.activity);
    expect(items).toHaveLength(1);
    expect(items[0].source).toBe("ticket");
    // The feed timestamp is the STABLE purchase time, not the bumped updatedAt.
    expect(items[0].createdAt).toBe(purchaseTime);
    expect(items[0].createdAt).not.toBe(bumped);
  });

  test("a first-ever Givebutter import stamps the RSVP with the GB purchase time", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    const pageId = (await s.as.mutation(api.ticketing.createPage, {
      eventId,
    })) as Id<"eventPages">;
    await s.as.mutation(api.ticketing.updatePage, {
      pageId,
      patch: { published: true, activityRestricted: false },
    });
    const admin = await s.as.query(api.ticketing.getAdminPage, { eventId });
    const slug = admin.page!.slug;

    const gbTime = Date.now() - 30 * 24 * 60 * 60 * 1000; // a month ago
    await t.mutation(internal.givebutterSync.applyGivebutterTickets, {
      eventId,
      tickets: [
        {
          externalId: "gbtix-1",
          ticketTypeName: "General Admission",
          attendeeName: "Old Buyer",
          email: "old@example.com",
          phone: null,
          priceCents: 2500,
          checkedInAt: null,
          createdAt: gbTime,
        },
      ],
    });

    const rsvp = await run(t, (ctx) =>
      ctx.db
        .query("rsvps")
        .withIndex("by_event", (q) => q.eq("eventId", eventId))
        .first(),
    );
    // The synced RSVP carries the real purchase time, not "now".
    expect(rsvp!.createdAt).toBe(gbTime);
    expect(rsvp!.updatedAt).toBe(gbTime);

    // And the feed reflects that old time (doesn't post as "just now").
    const pub = await t.query(api.ticketing.getPublicPage, { slug });
    const items = rsvpItems(pub?.activity);
    expect(items).toHaveLength(1);
    expect(items[0].createdAt).toBe(gbTime);
  });
});

describe("counters backfill (idempotent + dry-run safe)", () => {
  test("reconciles an orphaned maybe placeholder and drifted counters", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    const { pageId, slug, paidId } = await ticketedSetup(s, eventId);

    // Manufacture historical drift: a pending order whose placeholder RSVP was
    // never reconciled (the order silently went "expired" without the fix).
    const prepared = await t.mutation(internal.ticketing.prepareOrder, {
      slug,
      name: "Ghost Guest",
      email: "ghost@example.com",
      phone: "5551234567",
      items: [{ ticketTypeId: paidId, quantity: 1 }],
    });
    await run(t, async (ctx) => {
      await ctx.db.patch(prepared.orderId, { status: "expired" });
    });
    // Now: maybeCount === 1 but the placeholder is orphaned (no live order).
    let page = await run(t, (ctx) => ctx.db.get(pageId));
    expect(page!.maybeCount).toBe(1);

    // Dry run writes NOTHING but reports what a real run would do.
    const dry = await t.mutation(
      internal.ticketingCountersBackfill.backfillTicketingCounters,
      { execute: false },
    );
    expect(dry.patchedPages).toBe(1);
    expect(dry.orphansRemoved).toBe(1);
    page = await run(t, (ctx) => ctx.db.get(pageId));
    expect(page!.maybeCount).toBe(1); // unchanged by dry run
    const stillOrphan = await run(t, (ctx) =>
      ctx.db
        .query("rsvps")
        .withIndex("by_event", (q) => q.eq("eventId", eventId))
        .collect(),
    );
    expect(stillOrphan).toHaveLength(1);

    // Execute run reconciles: maybeCount → 0, orphan deleted.
    const run1 = await t.mutation(
      internal.ticketingCountersBackfill.backfillTicketingCounters,
      { execute: true },
    );
    expect(run1.patchedPages).toBe(1);
    expect(run1.orphansRemoved).toBe(1);
    page = await run(t, (ctx) => ctx.db.get(pageId));
    expect(page!.maybeCount).toBe(0);
    const afterRows = await run(t, (ctx) =>
      ctx.db
        .query("rsvps")
        .withIndex("by_event", (q) => q.eq("eventId", eventId))
        .collect(),
    );
    expect(afterRows).toHaveLength(0);

    // Idempotent: a second execute run finds everything already consistent.
    const run2 = await t.mutation(
      internal.ticketingCountersBackfill.backfillTicketingCounters,
      { execute: true },
    );
    expect(run2.patchedPages).toBe(0);
    expect(run2.orphansRemoved).toBe(0);
  });

  test("recomputes counters from real rows for a paid buyer without touching them", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    const { pageId, slug, paidId } = await ticketedSetup(s, eventId);

    const prepared = await t.mutation(internal.ticketing.prepareOrder, {
      slug,
      name: "Paid Pat",
      email: "pat@example.com",
      phone: "5551234567",
      items: [{ ticketTypeId: paidId, quantity: 2 }],
    });
    await t.mutation(internal.ticketing.attachStripeSession, {
      orderId: prepared.orderId,
      sessionId: "cs_bf_paid",
    });
    await t.mutation(internal.ticketing.markSessionPaid, {
      sessionId: "cs_bf_paid",
      paymentIntentId: "pi_bf_paid",
    });

    // Counters are already correct → the backfill patches nothing.
    const res = await t.mutation(
      internal.ticketingCountersBackfill.backfillTicketingCounters,
      { execute: true },
    );
    expect(res.patchedPages).toBe(0);
    expect(res.orphansRemoved).toBe(0);
    const page = await run(t, (ctx) => ctx.db.get(pageId));
    expect(page!.goingCount).toBe(1);
    expect(page!.maybeCount).toBe(0);
    expect(page!.ticketsSoldCount).toBe(2);
  });
});
