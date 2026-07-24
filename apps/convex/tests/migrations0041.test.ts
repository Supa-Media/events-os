/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import {
  runMigrateGuestAudiences,
  runMigrateGuestAudiencesPage,
} from "../migrations/0041_migrate_guest_audiences";
import { resolveAudienceRecipients } from "../lib/audienceResolve";
import type { Doc, Id } from "../_generated/dataModel";

/**
 * Migration 0041 — legacy "guests" audiences that carry a specific
 * `filters.eventId` → `person_filters` {attendedEventId}, now that 0037's
 * rsvp→people backfill has run in prod (see the migration's own doc for the
 * full rationale, the "eventId unset" gap that's deliberately left
 * unmigrated, and the unlinked-guest residue counter).
 *
 * Mirrors `tests/migrations0040.test.ts`'s shape: deterministic,
 * auto-registered, idempotent, single-`.paginate()`-per-call.
 */

async function seedAudience(
  s: ChapterSetup,
  opts: {
    source: "guests" | "donors" | "people" | "person_filters";
    scope?: Id<"chapters"> | "central";
    name?: string;
    filters?: Record<string, unknown>;
    includePersonIds?: Id<"people">[];
    excludePersonIds?: Id<"people">[];
    archived?: boolean;
  },
): Promise<Id<"audiences">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("audiences", {
      scope: opts.scope ?? "central",
      name: opts.name ?? `Aud ${opts.source}`,
      source: opts.source,
      filters: opts.filters ?? {},
      includePersonIds: opts.includePersonIds,
      excludePersonIds: opts.excludePersonIds,
      archived: opts.archived,
      createdBy: s.userId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
}

async function getAudience(s: ChapterSetup, id: Id<"audiences">): Promise<Doc<"audiences">> {
  return run(s.t, (ctx) => ctx.db.get(id)) as Promise<Doc<"audiences">>;
}

async function seedEvent(s: ChapterSetup): Promise<Id<"events">> {
  return run(s.t, async (ctx) => {
    const now = Date.now();
    const eventTypeId = await ctx.db.insert("eventTypes", {
      chapterId: s.chapterId,
      name: "Night",
      slug: `night-${now}-${Math.random()}`,
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
}

async function seedPerson(s: ChapterSetup, name: string): Promise<Id<"people">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name,
      status: "active",
      createdAt: Date.now(),
    }),
  );
}

async function seedRsvp(
  s: ChapterSetup,
  eventId: Id<"events">,
  opts: {
    name?: string;
    email?: string;
    emailVerified?: boolean;
    personId?: Id<"people">;
    status?: "going" | "maybe" | "not_going";
  } = {},
): Promise<Id<"rsvps">> {
  const now = Date.now();
  return run(s.t, (ctx) =>
    ctx.db.insert("rsvps", {
      eventId,
      chapterId: s.chapterId,
      name: opts.name ?? "Guest",
      email: opts.email,
      emailVerified: opts.emailVerified,
      personId: opts.personId,
      status: opts.status ?? "going",
      token: `tok-${Math.random()}`,
      createdAt: now,
      updatedAt: now,
    }),
  );
}

describe("migration 0041 — migrate guest audiences to person_filters", () => {
  test("'guests' with an eventId becomes person_filters {attendedEventId}, preserving chapterId", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    const id = await seedAudience(s, {
      source: "guests",
      filters: { eventId, chapterId: s.chapterId },
    });

    const result = await run(s.t, (ctx) => runMigrateGuestAudiences(ctx));
    expect(result.migratedFromGuests).toBe(1);
    expect(result.skippedGuestsUnscoped).toBe(0);

    const audience = await getAudience(s, id);
    expect(audience.source).toBe("person_filters");
    expect(audience.filters).toEqual({ chapterId: s.chapterId, attendedEventId: eventId });
  });

  test("'guests' with an eventId but no chapterId migrates without inventing one", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    const id = await seedAudience(s, { source: "guests", filters: { eventId } });

    await run(s.t, (ctx) => runMigrateGuestAudiences(ctx));
    const audience = await getAudience(s, id);
    expect(audience.source).toBe("person_filters");
    expect(audience.filters).toEqual({ attendedEventId: eventId });
  });

  test("'guests' with NO eventId ('attended anything, ever') is deliberately left unmigrated", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const id = await seedAudience(s, { source: "guests", filters: {} });

    const result = await run(s.t, (ctx) => runMigrateGuestAudiences(ctx));
    expect(result.skippedGuestsUnscoped).toBe(1);
    expect(result.migratedFromGuests).toBe(0);

    const audience = await getAudience(s, id);
    expect(audience.source).toBe("guests");
    expect(audience.filters).toEqual({});
  });

  test("'guests' with a chapterId but no eventId still counts as unscoped (chapterId alone never narrows to one event)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const id = await seedAudience(s, { source: "guests", filters: { chapterId: s.chapterId } });

    const result = await run(s.t, (ctx) => runMigrateGuestAudiences(ctx));
    expect(result.skippedGuestsUnscoped).toBe(1);
    const audience = await getAudience(s, id);
    expect(audience.source).toBe("guests");
  });

  test("non-'guests' rows (already person_filters, or a leftover people/donors row) are left untouched", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const pfId = await seedAudience(s, { source: "person_filters", filters: { teamOnly: true } });
    const peopleId = await seedAudience(s, { source: "people", filters: {} });

    const result = await run(s.t, (ctx) => runMigrateGuestAudiences(ctx));
    expect(result.skippedOther).toBe(2);
    expect((await getAudience(s, pfId)).source).toBe("person_filters");
    expect((await getAudience(s, peopleId)).source).toBe("people");
  });

  test("name, scope, archive state, and hand-pick exclusions are preserved verbatim (patch only touches source/filters)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const person = await seedPerson(s, "Handpicked");
    const eventId = await seedEvent(s);
    const id = await seedAudience(s, {
      source: "guests",
      scope: s.chapterId,
      name: "VIP guests",
      filters: { eventId },
      includePersonIds: [person],
      excludePersonIds: [],
      archived: true,
    });

    await run(s.t, (ctx) => runMigrateGuestAudiences(ctx));
    const audience = await getAudience(s, id);
    expect(audience.name).toBe("VIP guests");
    expect(audience.scope).toBe(s.chapterId);
    expect(audience.archived).toBe(true);
    expect(audience.includePersonIds).toEqual([person]);
  });

  test("idempotent: a second run touches nothing further", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    await seedAudience(s, { source: "guests", filters: { eventId } });
    await seedAudience(s, { source: "guests", filters: {} });
    await seedAudience(s, { source: "person_filters", filters: {} });

    const first = await run(s.t, (ctx) => runMigrateGuestAudiences(ctx));
    expect(first.migratedFromGuests).toBe(1);
    expect(first.skippedGuestsUnscoped).toBe(1);
    expect(first.skippedOther).toBe(1);

    const second = await run(s.t, (ctx) => runMigrateGuestAudiences(ctx));
    expect(second.migratedFromGuests).toBe(0);
    expect(second.skippedGuestsUnscoped).toBe(1); // still deliberately skipped every run
    expect(second.skippedOther).toBe(2); // the now-migrated row + the always-was-person_filters row
  });

  test("residue: rsvps with an email but no personId are counted, and don't block migration", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    const person = await seedPerson(s, "Linked Guest");
    // Linked — not residue.
    await seedRsvp(s, eventId, { email: "linked@example.com", personId: person });
    // Unlinked but has an email, not explicitly unverified — residue.
    await seedRsvp(s, eventId, { email: "unlinked1@example.com" });
    await seedRsvp(s, eventId, { email: "unlinked2@example.com" });
    // Unverified — resolveGuests would have excluded this one too, so it's
    // not part of the "legacy resolver reached them" residue.
    await seedRsvp(s, eventId, { email: "unverified@example.com", emailVerified: false });
    // No email at all — was never reachable by the legacy resolver either.
    await seedRsvp(s, eventId, { email: undefined });

    const id = await seedAudience(s, { source: "guests", filters: { eventId } });
    const result = await run(s.t, (ctx) => runMigrateGuestAudiences(ctx));

    expect(result.migratedFromGuests).toBe(1);
    expect(result.unlinkedGuestResidue).toBe(2);
    expect(result.unlinkedGuestResidueIsLowerBound).toBe(false);
    expect((await getAudience(s, id)).source).toBe("person_filters");
  });

  test("semantic preservation for a LINKED guest: migrated audience resolves the same recipient as before", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    const person = await seedPerson(s, "Linked Guest");
    await run(s.t, (ctx) =>
      ctx.db.insert("personEmails", {
        personId: person,
        email: "linked@example.com",
        source: "rsvp",
        verified: true,
        isPrimary: true,
        addedAt: Date.now(),
      }),
    );
    await seedRsvp(s, eventId, { email: "linked@example.com", personId: person });

    const id = await seedAudience(s, { source: "guests", scope: s.chapterId, filters: { eventId } });

    const before = await run(s.t, (ctx) =>
      resolveAudienceRecipients(ctx, { scope: s.chapterId, source: "guests", filters: { eventId } }),
    );
    expect(before.recipients.map((r) => r.email)).toEqual(["linked@example.com"]);

    await run(s.t, (ctx) => runMigrateGuestAudiences(ctx));
    const migrated = await getAudience(s, id);
    const after = await run(s.t, (ctx) => resolveAudienceRecipients(ctx, migrated));
    expect(after.recipients.map((r) => r.email)).toEqual(["linked@example.com"]);
  });

  test("known-drift: an email-but-unlinked guest is reached by legacy resolveGuests but NOT by the migrated filter", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    // No personId — the divergent-name-group shape 0037 deliberately left unlinked.
    await seedRsvp(s, eventId, { name: "Shared Inbox Guest", email: "shared@example.com" });

    const id = await seedAudience(s, { source: "guests", scope: s.chapterId, filters: { eventId } });

    const before = await run(s.t, (ctx) =>
      resolveAudienceRecipients(ctx, { scope: s.chapterId, source: "guests", filters: { eventId } }),
    );
    expect(before.recipients.map((r) => r.email)).toEqual(["shared@example.com"]);

    const result = await run(s.t, (ctx) => runMigrateGuestAudiences(ctx));
    expect(result.unlinkedGuestResidue).toBe(1);

    const migrated = await getAudience(s, id);
    const after = await run(s.t, (ctx) => resolveAudienceRecipients(ctx, migrated));
    // The gap this migration is honest about: the unlinked guest is gone
    // from the migrated resolution.
    expect(after.recipients).toEqual([]);
  });

  /**
   * hotfix 0037-single-paginate sweep: drives `runMigrateGuestAudiencesPage`
   * the way the scheduler continuation does in production — separate `run()`
   * calls (each its own execution) threading `continueCursor` — forced
   * across THREE pages via `pageSize: 1`, and asserts every row lands
   * correctly with never more than one `.paginate()` per call.
   */
  test("runner invocation pattern: single paginate per call across pages", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    const scopedId = await seedAudience(s, { source: "guests", filters: { eventId } });
    const unscopedId = await seedAudience(s, { source: "guests", filters: {} });
    const pfId = await seedAudience(s, { source: "person_filters", filters: {} });

    const call1 = await run(s.t, (ctx) => runMigrateGuestAudiencesPage(ctx, null, 1));
    expect(call1.scanned).toBe(1);
    expect(call1.isDone).toBe(false);
    expect(call1.continueCursor).toBeTruthy();

    const call2 = await run(s.t, (ctx) =>
      runMigrateGuestAudiencesPage(ctx, call1.continueCursor, 1),
    );
    expect(call2.scanned).toBe(1);
    expect(call2.isDone).toBe(false);

    const call3 = await run(s.t, (ctx) =>
      runMigrateGuestAudiencesPage(ctx, call2.continueCursor, 1),
    );
    expect(call3.scanned).toBe(1);
    expect(call3.isDone).toBe(true);
    expect(call3.continueCursor).toBeNull();

    expect(
      call1.migratedFromGuests + call2.migratedFromGuests + call3.migratedFromGuests,
    ).toBe(1);
    expect(
      call1.skippedGuestsUnscoped + call2.skippedGuestsUnscoped + call3.skippedGuestsUnscoped,
    ).toBe(1);
    expect(call1.skippedOther + call2.skippedOther + call3.skippedOther).toBe(1);

    expect((await getAudience(s, scopedId)).source).toBe("person_filters");
    expect((await getAudience(s, unscopedId)).source).toBe("guests");
    expect((await getAudience(s, pfId)).source).toBe("person_filters");
  });
});
