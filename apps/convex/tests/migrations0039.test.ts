/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { runBackfillPersonEmails } from "../migrations/0039_backfill_person_emails";
import type { Doc, Id } from "../_generated/dataModel";

/**
 * Migration 0039 — backfills `personEmails` from `people.email`/`pwEmail`,
 * linked donors' emails, and linked rsvps' emails (person-centric audiences
 * Phase 2 item 1). Deterministic, auto-registered, idempotent.
 */

async function seedEvent(s: ChapterSetup): Promise<Id<"events">> {
  return await run(s.t, async (ctx) => {
    const now = Date.now();
    const eventTypeId = await ctx.db.insert("eventTypes", {
      chapterId: s.chapterId,
      name: "Worship Night",
      slug: `worship-night-${now}`,
      version: 1,
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
    });
    return await ctx.db.insert("events", {
      chapterId: s.chapterId,
      eventTypeId,
      templateVersion: 1,
      name: `Event ${now}`,
      eventDate: now + 14 * 24 * 60 * 60 * 1000,
      status: "planning",
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
    });
  });
}

async function personEmailsFor(s: ChapterSetup, personId: Id<"people">): Promise<Doc<"personEmails">[]> {
  return run(s.t, (ctx) =>
    ctx.db
      .query("personEmails")
      .withIndex("by_person", (q) => q.eq("personId", personId))
      .collect(),
  );
}

describe("migration 0039 — backfill person emails", () => {
  test("populates roster/pw/donor/rsvp rows and is idempotent", async () => {
    const t = newT();
    const s = await setupChapter(t);

    const personId = await run(s.t, (ctx) =>
      ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Full House",
        email: "Full@Example.com",
        pwEmail: "full@publicworship.life",
        createdAt: 1000,
      }),
    );
    await run(s.t, (ctx) =>
      ctx.db.insert("donors", {
        scope: s.chapterId,
        kind: "individual",
        name: "Full House",
        email: "full-donor@example.com",
        status: "prospect",
        lifetimeCents: 0,
        giftCount: 0,
        personId,
        createdAt: 2000,
      }),
    );
    const eventId = await seedEvent(s);
    await run(s.t, (ctx) =>
      ctx.db.insert("rsvps", {
        eventId,
        chapterId: s.chapterId,
        name: "Full House",
        email: "full-rsvp@example.com",
        status: "going",
        token: "tok-full",
        emailVerified: true,
        personId,
        createdAt: 3000,
        updatedAt: 3000,
      }),
    );

    const first = await run(s.t, (ctx) => runBackfillPersonEmails(ctx));
    expect(first.inserted).toBe(4); // roster + pw + donor + rsvp — four distinct addresses
    expect(first.alreadyPresent).toBe(0);

    const rows = await personEmailsFor(s, personId);
    const bySource = Object.fromEntries(rows.map((r) => [r.source, r]));
    expect(bySource.roster).toMatchObject({ email: "full@example.com", verified: true });
    expect(bySource.pw).toMatchObject({ email: "full@publicworship.life", verified: true });
    expect(bySource.donor).toMatchObject({ email: "full-donor@example.com", verified: true });
    expect(bySource.rsvp).toMatchObject({ email: "full-rsvp@example.com", verified: true });

    // Idempotent: a second run inserts nothing new.
    const second = await run(s.t, (ctx) => runBackfillPersonEmails(ctx));
    expect(second.inserted).toBe(0);
    expect(second.alreadyPresent).toBe(4);
    expect(await personEmailsFor(s, personId)).toHaveLength(4);
  });

  test("dedupe: the SAME normalized email from two sources keeps only the highest-trust row", async () => {
    const t = newT();
    const s = await setupChapter(t);

    // Roster email and donor email are the SAME address (case/whitespace
    // differs) — roster (rank 3) must beat donor (rank 2).
    const personId = await run(s.t, (ctx) =>
      ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Shared Address",
        email: "shared@example.com",
        createdAt: 1000,
      }),
    );
    await run(s.t, (ctx) =>
      ctx.db.insert("donors", {
        scope: s.chapterId,
        kind: "individual",
        name: "Shared Address",
        email: "Shared@Example.com",
        status: "prospect",
        lifetimeCents: 0,
        giftCount: 0,
        personId,
        createdAt: 2000,
      }),
    );

    const result = await run(s.t, (ctx) => runBackfillPersonEmails(ctx));
    expect(result.inserted).toBe(1); // one row, not two
    const rows = await personEmailsFor(s, personId);
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe("roster");
  });

  test("trust order: an unverified rsvp email loses to a verified donor email at the same address", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await run(s.t, (ctx) =>
      ctx.db.insert("people", { chapterId: s.chapterId, name: "Verify Trust", createdAt: 1000 }),
    );
    await run(s.t, (ctx) =>
      ctx.db.insert("donors", {
        scope: s.chapterId,
        kind: "individual",
        name: "Verify Trust",
        email: "trust@example.com",
        status: "prospect",
        lifetimeCents: 0,
        giftCount: 0,
        personId,
        createdAt: 2000,
      }),
    );
    const eventId = await seedEvent(s);
    // rsvp source normally OUTRANKS nothing, but here it's UNVERIFIED — even
    // though rsvp's rank is already the lowest, this proves verified is
    // checked FIRST (a verified low-rank source doesn't matter here since
    // donor already wins on rank too; the real assertion is the opposite
    // case below).
    await run(s.t, (ctx) =>
      ctx.db.insert("rsvps", {
        eventId,
        chapterId: s.chapterId,
        name: "Verify Trust",
        email: "trust@example.com",
        status: "going",
        token: "tok-trust",
        emailVerified: false,
        personId,
        createdAt: 3000,
        updatedAt: 3000,
      }),
    );

    const result = await run(s.t, (ctx) => runBackfillPersonEmails(ctx));
    expect(result.inserted).toBe(1);
    const rows = await personEmailsFor(s, personId);
    expect(rows[0]).toMatchObject({ source: "donor", verified: true });
  });

  test("verified is checked BEFORE source rank: two same-source rsvp rows at one address keep the verified one", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await run(s.t, (ctx) =>
      ctx.db.insert("people", { chapterId: s.chapterId, name: "Verified Wins", createdAt: 1000 }),
    );
    const eventId = await seedEvent(s);
    await run(s.t, (ctx) =>
      ctx.db.insert("rsvps", {
        eventId,
        chapterId: s.chapterId,
        name: "Verified Wins",
        email: "verified-wins@example.com",
        status: "going",
        token: "tok-a",
        emailVerified: true,
        personId,
        createdAt: 1000,
        updatedAt: 1000,
      }),
    );
    await run(s.t, (ctx) =>
      ctx.db.insert("rsvps", {
        eventId,
        chapterId: s.chapterId,
        name: "Verified Wins",
        email: "verified-wins@example.com",
        status: "going",
        token: "tok-b",
        emailVerified: false,
        personId,
        createdAt: 2000,
        updatedAt: 2000,
      }),
    );

    const result = await run(s.t, (ctx) => runBackfillPersonEmails(ctx));
    expect(result.inserted).toBe(1);
    const rows = await personEmailsFor(s, personId);
    expect(rows[0]).toMatchObject({ verified: true, addedAt: 1000 });
  });

  test("donors/rsvps with no personId are skipped entirely", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await run(s.t, (ctx) =>
      ctx.db.insert("donors", {
        scope: s.chapterId,
        kind: "individual",
        name: "Unlinked Donor",
        email: "unlinked-donor@example.com",
        status: "prospect",
        lifetimeCents: 0,
        giftCount: 0,
        createdAt: 1000,
      }),
    );
    const eventId = await seedEvent(s);
    await run(s.t, (ctx) =>
      ctx.db.insert("rsvps", {
        eventId,
        chapterId: s.chapterId,
        name: "Unlinked Guest",
        email: "unlinked-guest@example.com",
        status: "going",
        token: "tok-unlinked",
        createdAt: 1000,
        updatedAt: 1000,
      }),
    );

    const result = await run(s.t, (ctx) => runBackfillPersonEmails(ctx));
    expect(result.inserted).toBe(0);
    const all = await run(s.t, (ctx) => ctx.db.query("personEmails").collect());
    expect(all).toHaveLength(0);
  });

  test("a pre-existing write-through row is left untouched, not duplicated", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await run(s.t, (ctx) =>
      ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Pre Seeded",
        email: "pre-seeded@example.com",
        createdAt: 1000,
      }),
    );
    // Simulate a live write-through row already present (e.g. from
    // `people.update` running before this migration executes).
    await run(s.t, (ctx) =>
      ctx.db.insert("personEmails", {
        personId,
        email: "pre-seeded@example.com",
        source: "roster",
        verified: true,
        addedAt: 999,
      }),
    );

    const result = await run(s.t, (ctx) => runBackfillPersonEmails(ctx));
    expect(result.alreadyPresent).toBe(1);
    expect(result.inserted).toBe(0);
    const rows = await personEmailsFor(s, personId);
    expect(rows).toHaveLength(1);
    expect(rows[0].addedAt).toBe(999); // untouched, not re-inserted with a new addedAt
  });
});
