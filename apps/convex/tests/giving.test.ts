import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import type { Id } from "../_generated/dataModel";

/**
 * Giving (donations) tests — mirror the ticket-order money machinery:
 *   - manual cash/other entry + rollup increment/decrement,
 *   - admin access gating,
 *   - amount + method validation,
 *   - the Stripe card flow: prepareDonation gating/validation, fulfillDonation
 *     idempotency + rollup, markDonationPaid by session (and its no-op safety
 *     for the shared webhook).
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

/** Create + publish a page, returning its id + slug. */
async function publishPage(s: ChapterSetup, eventId: Id<"events">) {
  const pageId = (await s.as.mutation(api.ticketing.createPage, {
    eventId,
  })) as Id<"eventPages">;
  const admin = await s.as.query(api.ticketing.getAdminPage, { eventId });
  await s.as.mutation(api.ticketing.updatePage, {
    pageId,
    patch: { published: true },
  });
  return { pageId, slug: admin.page!.slug };
}

/** Publish + turn Giving on, returning the slug. */
async function givingSetup(s: ChapterSetup, eventId: Id<"events">) {
  const { pageId, slug } = await publishPage(s, eventId);
  await s.as.mutation(api.ticketing.updatePage, {
    pageId,
    patch: { givingEnabled: true },
  });
  return { pageId, slug };
}

/** Read the (full) page row so tests can assert on the rollup counters. */
async function pageRow(s: ChapterSetup, eventId: Id<"events">) {
  const admin = await s.as.query(api.ticketing.getAdminPage, { eventId });
  return admin.page!;
}

describe("manual donations", () => {
  test("recordDonation inserts paid + bumps the rollup; remove decrements", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    await publishPage(s, eventId);

    const id1 = await s.as.mutation(api.giving.recordDonation, {
      eventId,
      amountCents: 2500,
      method: "cash",
      name: "Ada Donor",
      note: "merch table",
    });
    await s.as.mutation(api.giving.recordDonation, {
      eventId,
      amountCents: 1000,
      method: "other",
    });

    let page = await pageRow(s, eventId);
    expect(page.donationsCents).toBe(3500);
    expect(page.donationsCount).toBe(2);

    const list = await s.as.query(api.giving.listDonationsAdmin, { eventId });
    expect(list).toHaveLength(2);
    expect(list.every((d) => d.status === "paid")).toBe(true);

    // Remove the $25 one → rollup drops by exactly that.
    await s.as.mutation(api.giving.removeDonation, {
      donationId: id1 as Id<"donations">,
    });
    page = await pageRow(s, eventId);
    expect(page.donationsCents).toBe(1000);
    expect(page.donationsCount).toBe(1);
    expect(await s.as.query(api.giving.listDonationsAdmin, { eventId })).toHaveLength(1);
  });

  test("recordDonation rejects non-positive / non-integer cents and method=card", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    await publishPage(s, eventId);

    await expect(
      s.as.mutation(api.giving.recordDonation, {
        eventId,
        amountCents: 0,
        method: "cash",
      }),
    ).rejects.toThrow();
    await expect(
      s.as.mutation(api.giving.recordDonation, {
        eventId,
        amountCents: -500,
        method: "cash",
      }),
    ).rejects.toThrow();
    await expect(
      s.as.mutation(api.giving.recordDonation, {
        eventId,
        amountCents: 12.5,
        method: "cash",
      }),
    ).rejects.toThrow();
    // Card is Stripe-only — the validator forbids it here.
    await expect(
      s.as.mutation(api.giving.recordDonation, {
        eventId,
        amountCents: 1000,
        method: "card" as never,
      }),
    ).rejects.toThrow();

    // Nothing should have been recorded.
    expect(await s.as.query(api.giving.listDonationsAdmin, { eventId })).toHaveLength(0);
  });

  test("admin functions reject a non-member of the event's chapter", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    await publishPage(s, eventId);

    // A different chapter's admin can't touch this event.
    const other = await setupChapter(t, {
      email: "outsider@publicworship.life",
      chapterName: "Boston",
    });
    await expect(
      other.as.mutation(api.giving.recordDonation, {
        eventId,
        amountCents: 1000,
        method: "cash",
      }),
    ).rejects.toThrow();
    await expect(
      other.as.query(api.giving.listDonationsAdmin, { eventId }),
    ).rejects.toThrow();

    // Unauthenticated is rejected too.
    await expect(
      t.mutation(api.giving.recordDonation, {
        eventId,
        amountCents: 1000,
        method: "cash",
      }),
    ).rejects.toThrow();
  });
});

describe("card donations (Stripe flow)", () => {
  test("prepareDonation gates on published + givingEnabled + positive amount", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);

    // Page exists but is unpublished and giving is off.
    const { pageId, slug } = await publishPage(s, eventId);

    // Published but giving disabled → rejected.
    await expect(
      t.mutation(internal.giving.prepareDonation, {
        slug,
        name: "Ben",
        email: "ben@example.com",
        amountCents: 2000,
      }),
    ).rejects.toThrow();

    await s.as.mutation(api.ticketing.updatePage, {
      pageId,
      patch: { givingEnabled: true },
    });

    // Enabled but non-positive amount → rejected.
    await expect(
      t.mutation(internal.giving.prepareDonation, {
        slug,
        name: "Ben",
        email: "ben@example.com",
        amountCents: 0,
      }),
    ).rejects.toThrow();

    // Unknown / unpublished slug → rejected.
    await expect(
      t.mutation(internal.giving.prepareDonation, {
        slug: "does-not-exist",
        name: "Ben",
        email: "ben@example.com",
        amountCents: 2000,
      }),
    ).rejects.toThrow();
  });

  test("markDonationPaid fulfills, bumps the rollup, and is idempotent on redelivery", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    const { slug } = await givingSetup(s, eventId);

    const prepared = await t.mutation(internal.giving.prepareDonation, {
      slug,
      name: "Ben Buyer",
      email: "ben@example.com",
      amountCents: 5000,
    });
    expect(prepared.amountCents).toBe(5000);

    // Pending — no rollup yet.
    expect((await pageRow(s, eventId)).donationsCents ?? 0).toBe(0);

    await t.mutation(internal.giving.attachDonationSession, {
      donationId: prepared.donationId,
      sessionId: "cs_test_donation",
    });
    const first = await t.mutation(internal.giving.markDonationPaid, {
      sessionId: "cs_test_donation",
      paymentIntentId: "pi_gift",
    });
    expect(first).toBe(true);

    let page = await pageRow(s, eventId);
    expect(page.donationsCents).toBe(5000);
    expect(page.donationsCount).toBe(1);

    const list = await s.as.query(api.giving.listDonationsAdmin, { eventId });
    expect(list[0]).toMatchObject({
      status: "paid",
      method: "card",
      stripePaymentIntentId: "pi_gift",
    });

    // Duplicate webhook delivery must not double-count.
    const second = await t.mutation(internal.giving.markDonationPaid, {
      sessionId: "cs_test_donation",
      paymentIntentId: "pi_gift",
    });
    expect(second).toBe(true);
    page = await pageRow(s, eventId);
    expect(page.donationsCents).toBe(5000);
    expect(page.donationsCount).toBe(1);
  });

  test("markDonationPaid no-ops for an unknown session (shared webhook is safe)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    await givingSetup(s, eventId);

    const handled = await t.mutation(internal.giving.markDonationPaid, {
      sessionId: "cs_not_a_donation",
    });
    expect(handled).toBe(false);
    expect((await pageRow(s, eventId)).donationsCents ?? 0).toBe(0);
  });

  test("cancelPendingDonation expires a pending gift without bumping the rollup", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    const { slug } = await givingSetup(s, eventId);

    const prepared = await t.mutation(internal.giving.prepareDonation, {
      slug,
      name: "Cara",
      email: "cara@example.com",
      amountCents: 1500,
    });
    await t.mutation(internal.giving.attachDonationSession, {
      donationId: prepared.donationId,
      sessionId: "cs_test_expire",
    });
    await t.mutation(internal.giving.cancelPendingDonation, {
      sessionId: "cs_test_expire",
    });

    const list = await s.as.query(api.giving.listDonationsAdmin, { eventId });
    expect(list[0].status).toBe("expired");
    expect((await pageRow(s, eventId)).donationsCents ?? 0).toBe(0);
  });

  test("a manual and a card-fulfilled donation both appear in the ledger", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    const { slug } = await givingSetup(s, eventId);

    await s.as.mutation(api.giving.recordDonation, {
      eventId,
      amountCents: 1000,
      method: "cash",
      name: "Cash Gift",
    });
    const prepared = await t.mutation(internal.giving.prepareDonation, {
      slug,
      name: "Card Gift",
      email: "card@example.com",
      amountCents: 4000,
    });
    await t.mutation(internal.giving.attachDonationSession, {
      donationId: prepared.donationId,
      sessionId: "cs_ledger",
    });
    await t.mutation(internal.giving.markDonationPaid, { sessionId: "cs_ledger" });

    const list = await s.as.query(api.giving.listDonationsAdmin, { eventId });
    expect(list).toHaveLength(2);
    const methods = list.map((d) => d.method).sort();
    expect(methods).toEqual(["card", "cash"]);

    const page = await pageRow(s, eventId);
    expect(page.donationsCents).toBe(5000);
    expect(page.donationsCount).toBe(2);
  });
});
