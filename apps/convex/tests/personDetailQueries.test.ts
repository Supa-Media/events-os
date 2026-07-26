/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { api } from "../_generated/api";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import type { Id } from "../_generated/dataModel";

/**
 * People-CRM UX — the two new person-detail read surfaces:
 *  - `ticketing.guestHistoryForPerson` ("Guest history": attended/registered
 *    as a guest, via `rsvps.by_person` — distinct from
 *    `engagements.historyForPerson`'s "worked/volunteered" history).
 *  - `personEmails.listForPerson` (the known-emails ledger, primary first).
 * Both are gated exactly like `people.get`/`historyForPerson`
 * (`requireOwned` — chapter membership via the linked person).
 */

async function seedEvent(
  s: ChapterSetup,
  opts: { name?: string; eventDate?: number } = {},
): Promise<Id<"events">> {
  return await run(s.t, async (ctx) => {
    const now = Date.now();
    const eventTypeId = await ctx.db.insert("eventTypes", {
      chapterId: s.chapterId,
      name: "Worship Night",
      slug: `worship-night-${now}-${Math.random()}`,
      version: 1,
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
    });
    return await ctx.db.insert("events", {
      chapterId: s.chapterId,
      eventTypeId,
      templateVersion: 1,
      name: opts.name ?? `Event ${now}`,
      eventDate: opts.eventDate ?? now + 14 * 24 * 60 * 60 * 1000,
      status: "planning",
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
    });
  });
}

async function seedPerson(s: ChapterSetup, name = "Guest Person"): Promise<Id<"people">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("people", { chapterId: s.chapterId, name, createdAt: Date.now() }),
  );
}

// ── ticketing.guestHistoryForPerson ─────────────────────────────────────────

describe("ticketing.guestHistoryForPerson", () => {
  test("returns rsvp rows for the person, newest event first, with event name/date/status", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedPerson(s, "Riley Roster");

    const olderEvent = await seedEvent(s, { name: "Old Gathering", eventDate: 1_000 });
    const newerEvent = await seedEvent(s, { name: "New Gathering", eventDate: 2_000 });

    await run(s.t, (ctx) =>
      ctx.db.insert("rsvps", {
        eventId: olderEvent,
        chapterId: s.chapterId,
        name: "Riley Roster",
        email: "riley@example.com",
        status: "going",
        token: "tok-old",
        personId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    await run(s.t, (ctx) =>
      ctx.db.insert("rsvps", {
        eventId: newerEvent,
        chapterId: s.chapterId,
        name: "Riley Roster",
        email: "riley@example.com",
        status: "maybe",
        token: "tok-new",
        personId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );

    const result = await s.as.query(api.ticketing.guestHistoryForPerson, { personId });
    expect(result.count).toBe(2);
    expect(result.history.map((h) => h.eventName)).toEqual(["New Gathering", "Old Gathering"]);
    expect(result.history[0]).toMatchObject({ status: "maybe", eventDate: 2_000 });
    expect(result.history[1]).toMatchObject({ status: "going", eventDate: 1_000 });
  });

  test("excludes archived rsvp rows", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedPerson(s);
    const eventId = await seedEvent(s);
    await run(s.t, (ctx) =>
      ctx.db.insert("rsvps", {
        eventId,
        chapterId: s.chapterId,
        name: "Archived Guest",
        status: "going",
        token: "tok-archived",
        personId,
        archivedAt: Date.now(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );

    const result = await s.as.query(api.ticketing.guestHistoryForPerson, { personId });
    expect(result.count).toBe(0);
  });

  test("a person with no rsvps returns an empty history, not an error", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedPerson(s);
    const result = await s.as.query(api.ticketing.guestHistoryForPerson, { personId });
    expect(result).toEqual({ count: 0, history: [] });
  });

  test("gated like historyForPerson — a caller outside the chapter is rejected", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedPerson(s, "Chapter-Owned Person");

    const other = await setupChapter(t, { email: "other@publicworship.life" });
    await expect(
      other.as.query(api.ticketing.guestHistoryForPerson, { personId }),
    ).rejects.toThrow(ConvexError);
  });
});

// ── personEmails.listForPerson ──────────────────────────────────────────────

describe("personEmails.listForPerson", () => {
  test("lists every known email, primary first", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = (await s.as.mutation(api.people.create, {
      name: "Prima Ry",
      email: "prima@example.com",
      pwEmail: "prima@publicworship.life",
    })) as Id<"people">;

    const before = await s.as.query(api.personEmails.listForPerson, { personId });
    expect(before).toHaveLength(2);
    expect(before.every((r) => r.isPrimary === false)).toBe(true);
    const roster = before.find((r) => r.source === "roster")!;

    await s.as.mutation(api.personEmails.setPrimaryEmail, { personEmailId: roster._id });

    const after = await s.as.query(api.personEmails.listForPerson, { personId });
    expect(after).toHaveLength(2);
    expect(after[0]).toMatchObject({ address: "prima@example.com", isPrimary: true });
    expect(after.map((r) => r.isPrimary)).toEqual([true, false]);
  });

  test("a person with no known emails returns an empty list", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedPerson(s, "No Email Person");
    const rows = await s.as.query(api.personEmails.listForPerson, { personId });
    expect(rows).toEqual([]);
  });

  test("gated like setPrimaryEmail — a caller outside the chapter is rejected", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = (await s.as.mutation(api.people.create, {
      name: "Outsider Target",
      email: "outsider-target@example.com",
    })) as Id<"people">;

    const other = await setupChapter(t, { email: "other@publicworship.life" });
    await expect(
      other.as.query(api.personEmails.listForPerson, { personId }),
    ).rejects.toThrow(ConvexError);
  });
});
