import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import type { Id } from "../_generated/dataModel";

/**
 * Follow-up fixes from the live walkthrough:
 *   1. Holding a valid ticket unlocks the gated address/activity on its own —
 *      a signed-in ticket-holder whose RSVP isn't "going" was still locked out.
 *   3. Receipt reminders send ONE digest per cardholder (grouping all their
 *      still-missing-receipt charges) instead of one email per charge.
 * (The multi-ticket guest-card change is pure client rendering; the `ticketCount`
 *  payload it consumes is covered by ticketingActivityFixes.test.ts.)
 */

async function seedEvent(s: ChapterSetup): Promise<Id<"events">> {
  return run(s.t, async (ctx) => {
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
    return ctx.db.insert("events", {
      chapterId: s.chapterId,
      eventTypeId,
      templateVersion: 1,
      name: "Field Day",
      eventDate: now + 14 * 24 * 60 * 60 * 1000,
      status: "planning",
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
    });
  });
}

describe("address unlocks for a ticket-holder even if their RSVP isn't going", () => {
  test("a valid ticket unlocks the gated address; no token stays locked", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    const pageId = (await s.as.mutation(api.ticketing.createPage, {
      eventId,
    })) as Id<"eventPages">;
    await s.as.mutation(api.ticketing.updatePage, {
      pageId,
      patch: { published: true, ticketsEnabled: true },
    });
    const admin = await s.as.query(api.ticketing.getAdminPage, { eventId });
    const slug = admin.page!.slug;
    // Gate the address behind access, and give it a value to reveal.
    await run(t, (ctx) =>
      ctx.db.patch(pageId, {
        addressVisibility: "after_rsvp",
        address: "123 Prospect Park",
      }),
    );
    const freeId = (await s.as.mutation(api.ticketing.createTicketType, {
      eventId,
      name: "General Admission",
      priceCents: 0,
    })) as Id<"ticketTypes">;

    // A buyer completes a (free) order → issued ticket + a "going" RSVP.
    const prepared = await t.mutation(internal.ticketing.prepareOrder, {
      slug,
      name: "Sayo Olujide",
      email: "sayo@example.com",
      phone: "5551234567",
      items: [{ ticketTypeId: freeId, quantity: 1 }],
    });
    await t.mutation(internal.ticketing.fulfillOrder, { orderId: prepared.orderId });

    const holder = await run(t, (ctx) =>
      ctx.db
        .query("rsvps")
        .withIndex("by_event_status", (q) =>
          q.eq("eventId", eventId).eq("status", "going"),
        )
        .first(),
    );
    expect(holder).not.toBeNull();
    const token = holder!.token;

    // The edge case: their RSVP is somehow NOT "going" (e.g. a GB-synced or
    // never-flipped placeholder), yet they hold a valid ticket.
    await run(t, (ctx) => ctx.db.patch(holder!._id, { status: "not_going" }));

    const asHolder = await t.query(api.ticketing.getPublicPage, { slug, token });
    expect(asHolder!.addressLocked).toBe(false);
    expect(asHolder!.address).toBe("123 Prospect Park");

    // A visitor with no token (no RSVP, no ticket) stays gated.
    const anon = await t.query(api.ticketing.getPublicPage, { slug });
    expect(anon!.addressLocked).toBe(true);
    expect(anon!.address).toBeNull();
  });
});

describe("receipt reminders: one digest per cardholder", () => {
  async function seedHolder(
    s: ChapterSetup,
    name: string,
    pwEmail: string | null,
  ): Promise<{ personId: Id<"people">; cardId: Id<"cards"> }> {
    return run(s.t, async (ctx) => {
      const personId = await ctx.db.insert("people", {
        chapterId: s.chapterId,
        name,
        pwEmail: pwEmail ?? undefined,
        isTeamMember: true,
        createdAt: Date.now(),
      });
      const cardId = await ctx.db.insert("cards", {
        chapterId: s.chapterId,
        cardholderPersonId: personId,
        type: "virtual",
        status: "active",
        createdAt: Date.now(),
      });
      return { personId, cardId };
    });
  }

  async function seedCharge(
    s: ChapterSetup,
    cardId: Id<"cards">,
    amountCents: number,
    merchant: string,
  ): Promise<Id<"transactions">> {
    return run(s.t, (ctx) =>
      ctx.db.insert("transactions", {
        chapterId: s.chapterId,
        source: "manual",
        flow: "outflow",
        amountCents,
        postedAt: Date.now(),
        cardId,
        merchantName: merchant,
        status: "unreviewed",
        createdAt: Date.now(),
      }),
    );
  }

  test("groups a cardholder's charges into one digest; tags escalated; drops no-email", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const a = await seedHolder(s, "Ada", "ada@publicworship.life");
    const b = await seedHolder(s, "Ben", "ben@publicworship.life");
    const c = await seedHolder(s, "No Email", null);

    const a1 = await seedCharge(s, a.cardId, 15600, "Target");
    const a2 = await seedCharge(s, a.cardId, 1294, "Dig Inn");
    const bEsc = await seedCharge(s, b.cardId, 3380, "Costco");
    const cCharge = await seedCharge(s, c.cardId, 500, "Deli");

    const digests = await t.query(internal.cards.getReceiptReminderDigests, {
      flagged: [a1, a2, cCharge],
      escalated: [bEsc],
    });

    // Two cardholders with a reachable email → two digests (the no-email one dropped).
    expect(digests).toHaveLength(2);
    const ada = digests.find((d) => d.email === "ada@publicworship.life")!;
    expect(ada.charges).toHaveLength(2);
    expect(ada.anyEscalated).toBe(false);
    expect(ada.charges.map((ch) => ch.amountCents).sort()).toEqual([1294, 15600]);

    const ben = digests.find((d) => d.email === "ben@publicworship.life")!;
    expect(ben.charges).toHaveLength(1);
    expect(ben.anyEscalated).toBe(true);
    expect(ben.charges[0].escalated).toBe(true);
    expect(ben.charges[0].merchantName).toBe("Costco");
  });
});
