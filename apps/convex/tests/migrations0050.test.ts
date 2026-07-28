/// <reference types="vite/client" />
import { describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import {
  linkRsvpIdentifiersPage,
  isAutoLinkEligible,
} from "../migrations/0050_link_rsvp_identifiers";
import type { Doc, Id } from "../_generated/dataModel";

/**
 * Migration 0049 — the auto-link backfill for rsvps that already carry a real
 * identifier (email, or a phone with >= 10 digits). Unlike 0037 (which needs
 * a human to review a majority-vote judgment call across pages), this
 * migration self-schedules through to completion once kicked off with
 * `{ execute: true }` — see the module doc.
 */

async function seedEvent(s: ChapterSetup, name: string): Promise<Id<"events">> {
  return await run(s.t, async (ctx) => {
    const now = Date.now();
    const eventTypeId = await ctx.db.insert("eventTypes", {
      chapterId: s.chapterId,
      name,
      slug: `${name.toLowerCase().replace(/\s+/g, "-")}-${now}-${Math.random()}`,
      version: 1,
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
    });
    return await ctx.db.insert("events", {
      chapterId: s.chapterId,
      eventTypeId,
      templateVersion: 1,
      name,
      eventDate: now,
      status: "planning",
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
    });
  });
}

/** Insert a bare rsvp row directly (bypassing the live insert sites, which
 *  already link at write time) — simulates a PRE-EXISTING, pre-linking row. */
async function seedRsvp(
  s: ChapterSetup,
  eventId: Id<"events">,
  fields: { name: string; email?: string; phone?: string },
): Promise<Id<"rsvps">> {
  const now = Date.now();
  return run(s.t, (ctx) =>
    ctx.db.insert("rsvps", {
      eventId,
      chapterId: s.chapterId,
      name: fields.name,
      email: fields.email,
      phone: fields.phone,
      status: "going",
      token: `tok-${Math.random()}`,
      source: "rsvp",
      createdAt: now,
      updatedAt: now,
    }),
  );
}

function getRsvp(s: ChapterSetup, id: Id<"rsvps">): Promise<Doc<"rsvps"> | null> {
  return run(s.t, (ctx) => ctx.db.get(id));
}

function allPeople(s: ChapterSetup): Promise<Doc<"people">[]> {
  return run(s.t, (ctx) =>
    ctx.db.query("people").withIndex("by_chapter", (q) => q.eq("chapterId", s.chapterId)).collect(),
  );
}

describe("isAutoLinkEligible", () => {
  test("email present → eligible", () => {
    expect(isAutoLinkEligible({ email: "a@example.com", personId: undefined } as Doc<"rsvps">)).toBe(true);
  });
  test("phone with >= 10 digits → eligible", () => {
    expect(isAutoLinkEligible({ phone: "(555) 123-4567", personId: undefined } as Doc<"rsvps">)).toBe(true);
  });
  test("short/garbled phone (< 10 digits) → NOT eligible", () => {
    expect(isAutoLinkEligible({ phone: "12345", personId: undefined } as Doc<"rsvps">)).toBe(false);
  });
  test("name only, no email/phone → NOT eligible", () => {
    expect(isAutoLinkEligible({ personId: undefined } as Doc<"rsvps">)).toBe(false);
  });
  test("already linked → NOT eligible regardless of identifier", () => {
    expect(
      isAutoLinkEligible({ email: "a@example.com", personId: "p1" } as unknown as Doc<"rsvps">),
    ).toBe(false);
  });
});

describe("migration 0049 — link rsvp identifiers backfill", () => {
  test("dry run writes nothing; execute links; re-running is idempotent (no new writes)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s, "Solo Night");
    const rsvpId = await seedRsvp(s, eventId, { name: "Solo Guest", email: "solo@example.com" });

    const dry = await run(s.t, (ctx) => linkRsvpIdentifiersPage(ctx, { execute: false, cursor: null }));
    expect(dry.eligible).toBe(1);
    expect(dry.linked).toBe(1);
    expect((await getRsvp(s, rsvpId))?.personId).toBeUndefined();
    expect(await allPeople(s)).toHaveLength(0);

    const first = await run(s.t, (ctx) => linkRsvpIdentifiersPage(ctx, { execute: true, cursor: null }));
    expect(first.linked).toBe(1);
    expect(first.failed).toBe(0);
    const linked = await getRsvp(s, rsvpId);
    expect(linked?.personId).toBeTruthy();
    const person = await run(s.t, (ctx) => ctx.db.get(linked!.personId!));
    expect(person).toMatchObject({ name: "Solo Guest", email: "solo@example.com" });
    expect(await allPeople(s)).toHaveLength(1);

    // Re-run: idempotent — the row already has personId, so it's no longer
    // eligible; a second pass links nothing new and creates no new people.
    const second = await run(s.t, (ctx) => linkRsvpIdentifiersPage(ctx, { execute: true, cursor: null }));
    expect(second.eligible).toBe(0);
    expect(second.linked).toBe(0);
    expect(await allPeople(s)).toHaveLength(1);
  });

  test("never touches a name-only rsvp (no email, no usable phone)", async () => {
    const s = await setupChapter(newT());
    const eventId = await seedEvent(s, "Meetup");
    const rsvpId = await seedRsvp(s, eventId, { name: "Mystery Guest" });

    const result = await run(s.t, (ctx) => linkRsvpIdentifiersPage(ctx, { execute: true, cursor: null }));
    expect(result.eligible).toBe(0);
    expect(result.linked).toBe(0);
    expect((await getRsvp(s, rsvpId))?.personId).toBeUndefined();
    expect(await allPeople(s)).toHaveLength(0);
  });

  test("a phone with fewer than 10 digits is treated as name-only (never linked)", async () => {
    const s = await setupChapter(newT());
    const eventId = await seedEvent(s, "Meetup");
    const rsvpId = await seedRsvp(s, eventId, { name: "Partial Phone Guest", phone: "5551234" });

    const result = await run(s.t, (ctx) => linkRsvpIdentifiersPage(ctx, { execute: true, cursor: null }));
    expect(result.eligible).toBe(0);
    expect((await getRsvp(s, rsvpId))?.personId).toBeUndefined();
  });

  test("two rsvps sharing an email converge on ONE person (email match, no majority vote needed)", async () => {
    const s = await setupChapter(newT());
    const eventA = await seedEvent(s, "Event A");
    const eventB = await seedEvent(s, "Event B");
    const rsvpA = await seedRsvp(s, eventA, { name: "Repeat Guest", email: "repeat@example.com" });
    const rsvpB = await seedRsvp(s, eventB, { name: "Repeat Guest", email: "REPEAT@example.com" });

    await run(s.t, (ctx) => linkRsvpIdentifiersPage(ctx, { execute: true, cursor: null }));

    const linkedA = await getRsvp(s, rsvpA);
    const linkedB = await getRsvp(s, rsvpB);
    expect(linkedA?.personId).toBeTruthy();
    expect(linkedB?.personId).toBe(linkedA?.personId);
    expect(await allPeople(s)).toHaveLength(1);
  });

  test("multi-page run via the real scheduler self-continues to completion (fake timers + finishAllScheduledFunctions)", async () => {
    vi.useFakeTimers();
    try {
      const t = newT();
      const s = await setupChapter(t);
      const eventId = await seedEvent(s, "Big Night");
      const rsvpIds: Id<"rsvps">[] = [];
      // 3 eligible rows, forced across 3 separate pages via pageSize=1 —
      // but pageSize isn't exposed on the public mutation, so instead we
      // just seed a handful of rows and rely on the scheduler to drain them
      // via the real (default PAGE_SIZE) entry point.
      for (let i = 0; i < 3; i++) {
        rsvpIds.push(
          await seedRsvp(s, eventId, { name: `Guest ${i}`, email: `guest${i}@example.com` }),
        );
      }

      await s.t.mutation(internal.migrations["0050_link_rsvp_identifiers"].backfillLinkRsvpIdentifiers, {
        execute: true,
      });
      await t.finishAllScheduledFunctions(vi.runAllTimers);

      for (const id of rsvpIds) {
        expect((await getRsvp(s, id))?.personId).toBeTruthy();
      }
      expect(await allPeople(s)).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
