import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { api, internal } from "../_generated/api";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import type { Id } from "../_generated/dataModel";

/**
 * Blasts — host announcements. Covers the two things that decide who gets a
 * message: audience → recipient-set resolution (with email de-dup), and the
 * guardrails on sending (SMS not wired, empty body rejected).
 */

async function seedEventWithGuests(s: ChapterSetup): Promise<Id<"events">> {
  return await run(s.t, async (ctx) => {
    const now = Date.now();
    const eventTypeId = await ctx.db.insert("eventTypes", {
      chapterId: s.chapterId,
      name: "Night",
      slug: "night",
      version: 1,
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
    });
    const eventId = await ctx.db.insert("events", {
      chapterId: s.chapterId,
      eventTypeId,
      templateVersion: 1,
      name: "Night",
      eventDate: now,
      status: "planning",
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
    });
    const rsvp = (
      name: string,
      email: string,
      status: "going" | "maybe" | "not_going",
      source: "rsvp" | "ticket",
    ) =>
      ctx.db.insert("rsvps", {
        eventId,
        chapterId: s.chapterId,
        name,
        email,
        status,
        token: `tok-${name}`,
        source,
        createdAt: now,
        updatedAt: now,
      });
    await rsvp("Ann", "ann@example.com", "going", "rsvp");
    await rsvp("Ben", "ben@example.com", "going", "ticket");
    await rsvp("Cat", "cat@example.com", "maybe", "rsvp");
    await rsvp("Dan", "dan@example.com", "not_going", "rsvp");
    await rsvp("Ann2", "ann@example.com", "going", "ticket"); // duplicate email
    return eventId;
  });
}

async function insertBlast(
  s: ChapterSetup,
  eventId: Id<"events">,
  audience: "everyone" | "going" | "maybe" | "ticket_holders",
): Promise<Id<"blasts">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("blasts", {
      eventId,
      chapterId: s.chapterId,
      channel: "email",
      body: "hello",
      audience,
      status: "sending",
      createdBy: s.userId,
      createdAt: Date.now(),
    }),
  );
}

async function recipientsFor(
  s: ChapterSetup,
  eventId: Id<"events">,
  audience: "everyone" | "going" | "maybe" | "ticket_holders",
): Promise<string[]> {
  const blastId = await insertBlast(s, eventId, audience);
  const payload = await s.t.query(internal.blasts.getBlastPayload, { blastId });
  return (payload?.emails ?? []).sort();
}

describe("blast audience resolution", () => {
  test("'everyone' reaches every RSVP, de-duped by email", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEventWithGuests(s);
    expect(await recipientsFor(s, eventId, "everyone")).toEqual([
      "ann@example.com",
      "ben@example.com",
      "cat@example.com",
      "dan@example.com",
    ]);
  });

  test("'going' reaches only confirmed guests", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEventWithGuests(s);
    expect(await recipientsFor(s, eventId, "going")).toEqual([
      "ann@example.com",
      "ben@example.com",
    ]);
  });

  test("'maybe' reaches only maybes", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEventWithGuests(s);
    expect(await recipientsFor(s, eventId, "maybe")).toEqual(["cat@example.com"]);
  });

  test("'ticket_holders' reaches only ticket buyers", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEventWithGuests(s);
    expect(await recipientsFor(s, eventId, "ticket_holders")).toEqual([
      "ann@example.com",
      "ben@example.com",
    ]);
  });
});

describe("sendBlast guardrails", () => {
  test("rejects the SMS channel until Twilio is connected", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEventWithGuests(s);
    await expect(
      s.as.mutation(api.blasts.sendBlast, {
        eventId,
        channel: "sms",
        body: "hi",
        audience: "everyone",
      }),
    ).rejects.toThrow(ConvexError);
  });

  test("rejects an empty body", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEventWithGuests(s);
    await expect(
      s.as.mutation(api.blasts.sendBlast, {
        eventId,
        channel: "email",
        body: "   ",
        audience: "everyone",
      }),
    ).rejects.toThrow(ConvexError);
  });

  test("a valid email blast records a 'sending' row", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEventWithGuests(s);
    await s.as.mutation(api.blasts.sendBlast, {
      eventId,
      channel: "email",
      subject: "Doors at 6",
      body: "See you soon",
      audience: "going",
    });
    const history = await s.as.query(api.blasts.listBlasts, { eventId });
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      subject: "Doors at 6",
      audience: "going",
    });
  });
});
