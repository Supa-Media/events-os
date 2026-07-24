/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import type { Doc, Id } from "../_generated/dataModel";
import { runWrapTargetingPage } from "../migrations/0042_wrap_targeting";

/**
 * Migration 0042 — targeting-v2 wrap (`specs/audience-targeting-v2.md`
 * "Schema/migration"): stamp a translated `targeting` block onto every
 * audience row that lacks one. Covers the shape translations
 * (person_filters criteria → one include group, effective excludeFilters →
 * one exclude group, unscoped "guests" → attended_any), the
 * in-flight-approval skip, the defensive skippedOther bucket, idempotence,
 * and resolution equivalence for a wrapped row.
 */

const SUPERUSER_EMAIL = "seyi@publicworship.life";

async function asSuperuser(t: ReturnType<typeof newT>): Promise<ChapterSetup> {
  return setupChapter(t, { email: SUPERUSER_EMAIL });
}

async function seedAudienceRow(
  s: ChapterSetup,
  opts: Partial<Doc<"audiences">> & { name: string; source: Doc<"audiences">["source"] },
): Promise<Id<"audiences">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("audiences", {
      scope: s.chapterId,
      filters: {},
      createdBy: s.userId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...opts,
    }),
  );
}

async function wrapAll(s: ChapterSetup) {
  return run(s.t, (ctx) => runWrapTargetingPage(ctx, null));
}

describe("0042 — shape translations", () => {
  test("person_filters criteria fold into one include group (attendance qualifiers joint on one condition); excludeFilters → one exclude group without verifiedEmailOnly", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const eventId = await run(s.t, async (ctx) => {
      const now = Date.now();
      const eventTypeId = await ctx.db.insert("eventTypes", {
        chapterId: s.chapterId,
        name: "Night",
        slug: `night-${now}`,
        version: 1,
        createdBy: s.userId,
        createdAt: now,
        updatedAt: now,
      });
      return ctx.db.insert("events", {
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
    });

    const audienceId = await seedAudienceRow(s, {
      name: "Engaged donors",
      source: "person_filters",
      filters: {
        donorStatus: "active",
        givingLifetimeMinCents: 10_000,
        attendedEventId: eventId,
        rsvpStatus: "going",
        attendedWithinDays: 90,
      },
      excludeFilters: { teamOnly: true, verifiedEmailOnly: true },
    });

    const result = await wrapAll(s);
    expect(result.wrappedPersonFilters).toBe(1);
    expect(result.isDone).toBe(true);

    const row = (await run(s.t, (ctx) => ctx.db.get(audienceId)))!;
    expect(row.targeting).toEqual({
      groups: [
        {
          conditions: [
            { field: "donor_status", op: "is", status: "active" },
            { field: "giving_lifetime", op: "gte", cents: 10_000 },
            {
              field: "attended_event",
              op: "has",
              eventId,
              rsvpStatus: "going",
              withinDays: 90,
            },
          ],
        },
      ],
      // `verifiedEmailOnly` is dropped on the exclude side (never evaluated
      // there in the legacy model) — only the effective criterion remains.
      excludeGroups: [{ conditions: [{ field: "kind", op: "is", kind: "team" }] }],
    });
    // Legacy fields left in place (rollback = stop reading `targeting`).
    expect(row.source).toBe("person_filters");
    expect(row.filters.donorStatus).toBe("active");
  });

  test("wrapped empty person_filters resolves identically (everyone group), and the wrap is idempotent", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    await run(s.t, (ctx) =>
      ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Someone",
        email: "someone@example.com",
        status: "active",
        createdAt: Date.now(),
      }),
    );
    const audienceId = await seedAudienceRow(s, { name: "Everyone", source: "person_filters" });

    const before = await run(s.t, async (ctx) => {
      const { resolveAudienceRecipients } = await import("../lib/audienceResolve");
      const r = await resolveAudienceRecipients(ctx, (await ctx.db.get(audienceId))!);
      return r.recipients;
    });
    const first = await wrapAll(s);
    expect(first.wrappedPersonFilters).toBe(1);
    const after = await run(s.t, async (ctx) => {
      const { resolveAudienceRecipients } = await import("../lib/audienceResolve");
      const r = await resolveAudienceRecipients(ctx, (await ctx.db.get(audienceId))!);
      return r.recipients;
    });
    expect(after).toEqual(before);

    const row = (await run(s.t, (ctx) => ctx.db.get(audienceId)))!;
    expect(row.targeting).toEqual({ groups: [{ conditions: [] }] });

    const second = await wrapAll(s);
    expect(second.skippedAlreadyWrapped).toBe(1);
    expect(second.wrappedPersonFilters).toBe(0);
  });

  test("unscoped guests → attended_any (carrying the chapter filter); guests WITH an eventId and leftover legacy sources are skippedOther", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const eventId = await run(s.t, async (ctx) => {
      const now = Date.now();
      const eventTypeId = await ctx.db.insert("eventTypes", {
        chapterId: s.chapterId,
        name: "Night",
        slug: `night-${now}`,
        version: 1,
        createdBy: s.userId,
        createdAt: now,
        updatedAt: now,
      });
      return ctx.db.insert("events", {
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
    });
    const unscoped = await seedAudienceRow(s, {
      name: "All past guests",
      source: "guests",
      filters: { chapterId: s.chapterId },
    });
    await seedAudienceRow(s, {
      name: "Guests of one event (0041's job)",
      source: "guests",
      filters: { eventId },
    });
    await seedAudienceRow(s, { name: "Leftover people row", source: "people" });

    const result = await wrapAll(s);
    expect(result.wrappedGuests).toBe(1);
    expect(result.skippedOther).toBe(2);

    const row = (await run(s.t, (ctx) => ctx.db.get(unscoped)))!;
    expect(row.targeting).toEqual({
      groups: [
        { conditions: [{ field: "attended_any", op: "has", chapterId: s.chapterId }] },
      ],
    });
  });
});

describe("0042 — in-flight approvals", () => {
  test("an audience referenced by a pending_approval or approved campaign is skipped (hash must not drift from a deploy)", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    const pendingAudience = await seedAudienceRow(s, { name: "Pending", source: "person_filters" });
    const freeAudience = await seedAudienceRow(s, { name: "Free", source: "person_filters" });
    await run(s.t, (ctx) =>
      ctx.db.insert("campaigns", {
        scope: "central",
        name: "In flight",
        subject: "Hi",
        audienceId: pendingAudience,
        doc: { blocks: [] },
        status: "pending_approval",
        createdBy: s.userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );

    const result = await wrapAll(s);
    expect(result.skippedPendingApproval).toBe(1);
    expect(result.wrappedPersonFilters).toBe(1);
    expect((await run(s.t, (ctx) => ctx.db.get(pendingAudience)))!.targeting).toBeUndefined();
    expect((await run(s.t, (ctx) => ctx.db.get(freeAudience)))!.targeting).toBeDefined();

    // Once the campaign lands (sent), the manual re-run picks the row up.
    const campaigns = await run(s.t, (ctx) => ctx.db.query("campaigns").collect());
    await run(s.t, (ctx) => ctx.db.patch(campaigns[0]._id, { status: "sent" }));
    const rerun = await wrapAll(s);
    expect(rerun.wrappedPersonFilters).toBe(1);
    expect((await run(s.t, (ctx) => ctx.db.get(pendingAudience)))!.targeting).toBeDefined();
  });
});

describe("0042 — pagination", () => {
  test("a forced page boundary schedules the continuation and finishes the scan", async () => {
    const t = newT();
    const s = await asSuperuser(t);
    for (let i = 0; i < 3; i++) {
      await seedAudienceRow(s, { name: `A${i}`, source: "person_filters" });
    }
    const first = await run(s.t, (ctx) => runWrapTargetingPage(ctx, null, 2));
    expect(first.isDone).toBe(false);
    expect(first.scanned).toBe(2);
    const second = await run(s.t, (ctx) => runWrapTargetingPage(ctx, first.continueCursor, 2));
    expect(second.isDone).toBe(true);
    expect(first.wrappedPersonFilters + second.wrappedPersonFilters).toBe(3);
  });
});
