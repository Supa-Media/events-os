/**
 * Test suite for migration 0034: merging the 4 Field Day duplicate guest rows
 * created when the live Givebutter sync matched buyers on a DIFFERENT email
 * than the historical CSV backfill used (see the migration's doc comment).
 *
 * Only one of the 4 hardcoded pairs is seeded per test (the others are
 * naturally absent, so they fall out as `skippedMissing` — proving the
 * migration tolerates partial state, e.g. a re-run after only some pairs have
 * synced).
 */
import { describe, expect, test } from "vitest";
import type { Id } from "../_generated/dataModel";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { runMergeDuplicateGbGuests } from "../migrations/0034_merge_duplicate_gb_guests";

const TARGET_CAMPAIGN_ID = "686283";
// The first of the 4 hardcoded pairs (Deandre Brown).
const STALE_EMAIL = "deanb1262@gmail.com";
const LIVE_EMAIL = "drelandstar943@gmail.com";
const STALE_NOTE = "General Admission; $25.00";
const STALE_PHONE = "19296152964";

async function seedEventWithPage(
  s: ChapterSetup,
  opts: { campaignId?: string; goingCount?: number } = {},
): Promise<{ eventId: Id<"events">; pageId: Id<"eventPages"> }> {
  return run(s.t, async (ctx) => {
    const now = Date.now();
    const eventTypeId = await ctx.db.insert("eventTypes", {
      chapterId: s.chapterId,
      name: "Field Day",
      slug: "field-day",
      version: 1,
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
    });
    const eventId = await ctx.db.insert("events", {
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
    const pageId = await ctx.db.insert("eventPages", {
      eventId,
      chapterId: s.chapterId,
      slug: "field-day",
      published: true,
      hostName: "Public Worship",
      addressVisibility: "public",
      rsvpEnabled: true,
      ticketsEnabled: true,
      showGuestList: true,
      activityRestricted: true,
      goingCount: opts.goingCount ?? 2,
      maybeCount: 0,
      notGoingCount: 0,
      ticketsSoldCount: 1,
      revenueCents: 2500,
      givebutterCampaignId: opts.campaignId ?? TARGET_CAMPAIGN_ID,
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
    });
    return { eventId, pageId };
  });
}

async function insertRsvp(
  s: ChapterSetup,
  eventId: Id<"events">,
  opts: {
    email: string;
    name?: string;
    phone?: string;
    note?: string;
    status?: "going" | "maybe" | "not_going";
  },
): Promise<Id<"rsvps">> {
  return run(s.t, (ctx) => {
    const now = Date.now();
    return ctx.db.insert("rsvps", {
      eventId,
      chapterId: s.chapterId,
      name: opts.name ?? "Deandre Brown",
      email: opts.email,
      phone: opts.phone,
      status: opts.status ?? "going",
      token: `tok-${Math.random().toString(36).slice(2)}`,
      source: "ticket",
      emailVerified: true,
      note: opts.note,
      createdAt: now,
      updatedAt: now,
    });
  });
}

async function insertOrder(
  s: ChapterSetup,
  eventId: Id<"events">,
  rsvpId: Id<"rsvps"> | undefined,
) {
  return run(s.t, (ctx) => {
    const now = Date.now();
    return ctx.db.insert("ticketOrders", {
      eventId,
      chapterId: s.chapterId,
      rsvpId,
      name: "Deandre Brown",
      email: "drelandstar943@gmail.com",
      items: [],
      totalCents: 2500,
      currency: "usd",
      status: "paid",
      externalProvider: "givebutter",
      externalRef: "gb:ticket:1",
      createdAt: now,
      updatedAt: now,
    });
  });
}

describe("0034_merge_duplicate_gb_guests", () => {
  test("merges the pair: stale deleted, live gains phone/note and keeps its order, goingCount decremented", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const { eventId, pageId } = await seedEventWithPage(s);
    const staleId = await insertRsvp(s, eventId, {
      email: STALE_EMAIL,
      phone: STALE_PHONE,
      note: STALE_NOTE,
      status: "going",
    });
    const liveId = await insertRsvp(s, eventId, {
      email: LIVE_EMAIL,
      status: "going",
    });
    const orderId = await insertOrder(s, eventId, liveId);

    const result = await run(t, (ctx) => runMergeDuplicateGbGuests(ctx));
    expect(result).toEqual({
      merged: 1,
      skippedMissing: 3,
      skippedReferenced: 0,
    });

    const [stale, live, order, page] = await run(t, async (ctx) => [
      await ctx.db.get(staleId),
      await ctx.db.get(liveId),
      await ctx.db.get(orderId),
      await ctx.db.get(pageId),
    ]);
    expect(stale).toBeNull();
    expect(live?.phone).toBe(STALE_PHONE);
    expect(live?.note).toBe(STALE_NOTE);
    expect(order?.rsvpId).toBe(liveId); // live's order survives untouched.
    expect(page?.goingCount).toBe(1); // was 2, stale ("going") decremented.
  });

  test("idempotent: a second run merges nothing further", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const { eventId, pageId } = await seedEventWithPage(s);
    const staleId = await insertRsvp(s, eventId, {
      email: STALE_EMAIL,
      phone: STALE_PHONE,
      note: STALE_NOTE,
      status: "going",
    });
    const liveId = await insertRsvp(s, eventId, {
      email: LIVE_EMAIL,
      status: "going",
    });
    await insertOrder(s, eventId, liveId);

    const first = await run(t, (ctx) => runMergeDuplicateGbGuests(ctx));
    expect(first.merged).toBe(1);

    const pageAfterFirst = await run(t, (ctx) => ctx.db.get(pageId));

    const second = await run(t, (ctx) => runMergeDuplicateGbGuests(ctx));
    expect(second).toEqual({
      merged: 0,
      skippedMissing: 4,
      skippedReferenced: 0,
    });

    const [stale, live, pageAfterSecond] = await run(t, async (ctx) => [
      await ctx.db.get(staleId),
      await ctx.db.get(liveId),
      await ctx.db.get(pageId),
    ]);
    expect(stale).toBeNull();
    expect(live?.phone).toBe(STALE_PHONE);
    expect(live?.note).toBe(STALE_NOTE);
    expect(pageAfterSecond?.goingCount).toBe(pageAfterFirst?.goingCount);
  });

  test("a stale row with an order attached is left alone (not actually order-less)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const { eventId, pageId } = await seedEventWithPage(s);
    const staleId = await insertRsvp(s, eventId, {
      email: STALE_EMAIL,
      phone: STALE_PHONE,
      note: STALE_NOTE,
      status: "going",
    });
    const liveId = await insertRsvp(s, eventId, {
      email: LIVE_EMAIL,
      status: "going",
    });
    // The "stale" row is actually referenced by a real order — must be
    // skipped, never deleted.
    await insertOrder(s, eventId, staleId);

    const result = await run(t, (ctx) => runMergeDuplicateGbGuests(ctx));
    expect(result).toEqual({
      merged: 0,
      skippedMissing: 3,
      skippedReferenced: 1,
    });

    const [stale, live, page] = await run(t, async (ctx) => [
      await ctx.db.get(staleId),
      await ctx.db.get(liveId),
      await ctx.db.get(pageId),
    ]);
    expect(stale).not.toBeNull();
    expect(live?.phone).toBeUndefined(); // untouched — no merge happened.
    expect(page?.goingCount).toBe(2); // unchanged.
  });

  test("missing live row → skip (idempotent re-run before the sync has matched this buyer)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const { eventId, pageId } = await seedEventWithPage(s, { goingCount: 1 });
    const staleId = await insertRsvp(s, eventId, {
      email: STALE_EMAIL,
      phone: STALE_PHONE,
      note: STALE_NOTE,
      status: "going",
    });
    // No live row inserted at all.

    const result = await run(t, (ctx) => runMergeDuplicateGbGuests(ctx));
    expect(result).toEqual({
      merged: 0,
      skippedMissing: 4,
      skippedReferenced: 0,
    });

    const [stale, page] = await run(t, async (ctx) => [
      await ctx.db.get(staleId),
      await ctx.db.get(pageId),
    ]);
    expect(stale).not.toBeNull();
    expect(page?.goingCount).toBe(1);
  });

  test("no page with the target campaign id → no-op", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedEventWithPage(s, { campaignId: "some-other-campaign" });

    const result = await run(t, (ctx) => runMergeDuplicateGbGuests(ctx));
    expect(result).toEqual({ merged: 0, skippedMissing: 0, skippedReferenced: 0 });
  });

  test("a stale row referenced only by an eventComment is left alone", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const { eventId, pageId } = await seedEventWithPage(s);
    const staleId = await insertRsvp(s, eventId, {
      email: STALE_EMAIL,
      phone: STALE_PHONE,
      note: STALE_NOTE,
      status: "going",
    });
    await insertRsvp(s, eventId, { email: LIVE_EMAIL, status: "going" });
    await run(t, (ctx) =>
      ctx.db.insert("eventComments", {
        eventId,
        chapterId: s.chapterId,
        replyToRsvpId: staleId,
        authorName: "Someone",
        body: "Welcome!",
        createdAt: Date.now(),
      }),
    );

    const result = await run(t, (ctx) => runMergeDuplicateGbGuests(ctx));
    expect(result).toEqual({
      merged: 0,
      skippedMissing: 3,
      skippedReferenced: 1,
    });

    const [stale, page] = await run(t, async (ctx) => [
      await ctx.db.get(staleId),
      await ctx.db.get(pageId),
    ]);
    expect(stale).not.toBeNull();
    expect(page?.goingCount).toBe(2);
  });

  test("a stale row referenced only by a pageReaction is left alone", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const { eventId, pageId } = await seedEventWithPage(s);
    const staleId = await insertRsvp(s, eventId, {
      email: STALE_EMAIL,
      phone: STALE_PHONE,
      note: STALE_NOTE,
      status: "going",
    });
    await insertRsvp(s, eventId, { email: LIVE_EMAIL, status: "going" });
    await run(t, (ctx) =>
      ctx.db.insert("pageReactions", {
        eventId,
        chapterId: s.chapterId,
        targetType: "rsvp",
        targetId: String(staleId),
        emoji: "🎉",
        actorKey: String(staleId),
        createdAt: Date.now(),
      }),
    );

    const result = await run(t, (ctx) => runMergeDuplicateGbGuests(ctx));
    expect(result).toEqual({
      merged: 0,
      skippedMissing: 3,
      skippedReferenced: 1,
    });

    const [stale, page] = await run(t, async (ctx) => [
      await ctx.db.get(staleId),
      await ctx.db.get(pageId),
    ]);
    expect(stale).not.toBeNull();
    expect(page?.goingCount).toBe(2);
  });
});
