import { describe, expect, test } from "vitest";
import type { Doc, Id } from "../_generated/dataModel";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { runSeedSeatDefs } from "../migrations/0022_seed_seat_defs";
import { runAddEventsCheckinDefaults } from "../migrations/0060_add_events_checkin_defaults";
import { hasCheckInAccess, requireCheckInAccess } from "../lib/ticketingAccess";

/**
 * `lib/ticketingAccess.ts` — the door check-in gate (`requireCheckInAccess`/
 * `hasCheckInAccess`) — and the `0060` backfill migration that carries the
 * `events.checkin` capability onto already-seeded orgs' live `seatDefs` rows.
 * Mirrors `campaignPower.test.ts`'s shape: seed helpers + `directlyAssign`
 * for seat-granted access, direct `ctx.db.insert` for the event-assigned
 * path. Resolver calls run through `s.as.run(...)` (an identity-scoped
 * `convex-test` client), which is the standard way this suite exercises a
 * lib function directly against a caller's auth — mirrors this file's own
 * "no isolated test file for `campaignsAccess.ts`" precedent by testing the
 * resolver's real behavior rather than a registered wrapper query.
 */

// ── Setup helpers (mirrors campaignPower.test.ts) ───────────────────────────

async function seatSetup(opts: { email?: string } = {}): Promise<ChapterSetup> {
  const t = newT();
  await run(t, (ctx) => runSeedSeatDefs(ctx));
  await run(t, (ctx) => runAddEventsCheckinDefaults(ctx));
  return setupChapter(t, opts);
}

async function defBySlug(s: ChapterSetup, slug: string): Promise<Doc<"seatDefs">> {
  const def = await run(s.t, (ctx) =>
    ctx.db.query("seatDefs").withIndex("by_slug", (q) => q.eq("slug", slug)).unique(),
  );
  if (!def) throw new Error(`${slug} not seeded`);
  return def;
}

async function seedSelfPerson(s: ChapterSetup, name = "Caller"): Promise<Id<"people">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name,
      userId: s.userId,
      createdAt: Date.now(),
    }),
  );
}

async function directlyAssign(
  s: ChapterSetup,
  slug: string,
  scope: Id<"chapters"> | "central",
  personId: Id<"people">,
): Promise<void> {
  const def = await defBySlug(s, slug);
  await run(s.t, (ctx) =>
    ctx.db.insert("seatAssignments", {
      seatDefId: def._id,
      scope,
      personId,
      createdAt: Date.now(),
    }),
  );
}

/** Minimal template + event so the resolver has a real target. */
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

/** Give `personId` a `roleAssignments` row on `eventId` (any role). */
async function assignToEventTeam(
  s: ChapterSetup,
  eventId: Id<"events">,
  personId: Id<"people">,
): Promise<void> {
  await run(s.t, async (ctx) => {
    const roleId = await ctx.db.insert("eventRoles", {
      eventId,
      key: "door",
      label: "Door",
      order: 0,
    });
    await ctx.db.insert("roleAssignments", {
      eventId,
      chapterId: s.chapterId,
      roleId,
      personId,
      createdAt: Date.now(),
    });
  });
}

// ── Access resolver ─────────────────────────────────────────────────────────

describe("requireCheckInAccess / hasCheckInAccess", () => {
  test("no seat, no role assignment on the event → denied", async () => {
    const s = await seatSetup();
    await seedSelfPerson(s);
    const eventId = await seedEvent(s);

    expect(await s.as.run((ctx) => hasCheckInAccess(ctx, eventId))).toBe(false);
    await expect(
      s.as.run((ctx) => requireCheckInAccess(ctx, eventId)),
    ).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
  });

  test("a caller holding event_organizers at the event's chapter is granted", async () => {
    const s = await seatSetup();
    const personId = await seedSelfPerson(s);
    await directlyAssign(s, "event_organizers", s.chapterId, personId);
    const eventId = await seedEvent(s);

    expect(await s.as.run((ctx) => hasCheckInAccess(ctx, eventId))).toBe(true);
    const event = await s.as.run((ctx) => requireCheckInAccess(ctx, eventId));
    expect(event._id).toBe(eventId);
  });

  test("a caller with no seat but a roleAssignments row on THIS event is granted", async () => {
    const s = await seatSetup();
    const personId = await seedSelfPerson(s);
    const eventId = await seedEvent(s);
    await assignToEventTeam(s, eventId, personId);

    expect(await s.as.run((ctx) => hasCheckInAccess(ctx, eventId))).toBe(true);
    const event = await s.as.run((ctx) => requireCheckInAccess(ctx, eventId));
    expect(event._id).toBe(eventId);
  });

  test("a seat capability at a DIFFERENT chapter than the event's does not grant access", async () => {
    const s = await seatSetup();
    const personId = await seedSelfPerson(s);
    const otherChapterId = await run(s.t, (ctx) =>
      ctx.db.insert("chapters", { name: "Other City", isActive: true, createdAt: Date.now() }),
    );
    await directlyAssign(s, "event_organizers", otherChapterId, personId);
    const eventId = await seedEvent(s); // event lives in s.chapterId, not otherChapterId

    expect(await s.as.run((ctx) => hasCheckInAccess(ctx, eventId))).toBe(false);
  });

  test("superuser bypasses both paths", async () => {
    const s = await seatSetup({ email: "seyi@publicworship.life" });
    const eventId = await seedEvent(s);
    expect(await s.as.run((ctx) => hasCheckInAccess(ctx, eventId))).toBe(true);
  });
});

// ── Migration 0060 — additive backfill, idempotent ──────────────────────────

describe("0060_add_events_checkin_defaults", () => {
  test("adds events.checkin to the four seats; second run is a no-op", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));

    // Simulate a PRE-migration deployment: strip the target seats back to
    // their old (pre-events.checkin) capability sets.
    const slugs = [
      "chapter_director",
      "event_lead",
      "event_organizers",
      "production_coordinator",
    ] as const;
    for (const slug of slugs) {
      await run(t, async (ctx) => {
        const def = await ctx.db.query("seatDefs").withIndex("by_slug", (q) => q.eq("slug", slug)).unique();
        if (!def) throw new Error(`${slug} missing`);
        await ctx.db.patch(def._id, {
          capabilities: def.capabilities.filter((c) => c !== "events.checkin"),
        });
      });
    }

    const first = await run(t, (ctx) => runAddEventsCheckinDefaults(ctx));
    expect(first.patched).toBe(4);
    expect(first.skipped).toBe(0);

    for (const slug of slugs) {
      const def = await run(t, (ctx) =>
        ctx.db.query("seatDefs").withIndex("by_slug", (q) => q.eq("slug", slug)).unique(),
      );
      expect(def!.capabilities).toContain("events.checkin");
    }

    // Idempotent: a second run touches nothing.
    const second = await run(t, (ctx) => runAddEventsCheckinDefaults(ctx));
    expect(second.patched).toBe(0);
    expect(second.skipped).toBe(4);
  });
});
