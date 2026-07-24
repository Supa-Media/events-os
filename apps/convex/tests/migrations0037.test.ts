import { describe, expect, test } from "vitest";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { linkRsvpPeoplePage } from "../migrations/0037_link_rsvp_people";
import type { Doc, Id } from "../_generated/dataModel";

/**
 * Migration 0037 — the rsvp↔people backfill (person-centric audiences Phase 1
 * item 3). Dry-run vs execute, idempotence, cross-event dedupe (same email on
 * N events → ONE person, N linked rsvps), and the divergent-name safety guard
 * (a shared/household email with more than one distinct attendee name links
 * only the majority name, leaving the rest unlinked).
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
 *  already link at write time) — simulates a PRE-EXISTING, pre-Phase-1 row. */
async function seedRsvp(
  s: ChapterSetup,
  eventId: Id<"events">,
  fields: {
    name: string;
    email?: string;
    phone?: string;
    createdAt?: number;
  },
): Promise<Id<"rsvps">> {
  const now = fields.createdAt ?? Date.now();
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

function allPeople(s: ChapterSetup): Promise<Doc<"people">[]> {
  return run(s.t, (ctx) => ctx.db.query("people").collect());
}

function getRsvp(s: ChapterSetup, id: Id<"rsvps">): Promise<Doc<"rsvps"> | null> {
  return run(s.t, (ctx) => ctx.db.get(id));
}

describe("migration 0037 — link rsvp people backfill", () => {
  test("dry run writes nothing; execute links and is idempotent", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s, "Solo Night");
    const rsvpId = await seedRsvp(s, eventId, {
      name: "Solo Guest",
      email: "solo@example.com",
    });

    const dry = await run(s.t, (ctx) =>
      linkRsvpPeoplePage(ctx, { execute: false, cursor: null }),
    );
    expect(dry.linked).toBeGreaterThanOrEqual(1);
    // Dry run writes NOTHING.
    expect((await getRsvp(s, rsvpId))?.personId).toBeUndefined();
    expect(await allPeople(s)).toHaveLength(0);

    const first = await run(s.t, (ctx) =>
      linkRsvpPeoplePage(ctx, { execute: true, cursor: null }),
    );
    expect(first.linked).toBeGreaterThanOrEqual(1);
    const linkedRsvp = await getRsvp(s, rsvpId);
    expect(linkedRsvp?.personId).toBeTruthy();
    const person = await run(s.t, (ctx) => ctx.db.get(linkedRsvp!.personId!));
    expect(person).toMatchObject({ name: "Solo Guest", isContactOnly: true });

    // Idempotent: a second execute run touches nothing new (already-linked
    // rows are skipped outright).
    const second = await run(s.t, (ctx) =>
      linkRsvpPeoplePage(ctx, { execute: true, cursor: null }),
    );
    expect(second.linked).toBe(0);
    expect(await allPeople(s)).toHaveLength(1); // no duplicate
  });

  test("cross-event dedupe: the same email on 3 events maps to ONE person, 3 linked rsvps", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const e1 = await seedEvent(s, "Event One");
    const e2 = await seedEvent(s, "Event Two");
    const e3 = await seedEvent(s, "Event Three");
    const r1 = await seedRsvp(s, e1, { name: "Repeat Attendee", email: "repeat@example.com", createdAt: 1000 });
    const r2 = await seedRsvp(s, e2, { name: "Repeat Attendee", email: "repeat@example.com", createdAt: 2000 });
    const r3 = await seedRsvp(s, e3, { name: "Repeat Attendee", email: "repeat@example.com", createdAt: 3000 });

    await run(s.t, (ctx) => linkRsvpPeoplePage(ctx, { execute: true, cursor: null }));

    const [rsvp1, rsvp2, rsvp3] = await Promise.all([
      getRsvp(s, r1),
      getRsvp(s, r2),
      getRsvp(s, r3),
    ]);
    expect(rsvp1?.personId).toBeTruthy();
    expect(rsvp2?.personId).toBe(rsvp1?.personId);
    expect(rsvp3?.personId).toBe(rsvp1?.personId);

    const everyone = await allPeople(s);
    expect(everyone.filter((p) => p.email === "repeat@example.com")).toHaveLength(1);
  });

  test("divergent names on a shared email: only the majority name links, the rest stay unlinked", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const e1 = await seedEvent(s, "House A");
    const e2 = await seedEvent(s, "House B");
    const e3 = await seedEvent(s, "House C");
    // "Jane" appears twice, "John" once, on the SAME shared inbox.
    const jane1 = await seedRsvp(s, e1, { name: "Jane Doe", email: "family@example.com", createdAt: 1000 });
    const jane2 = await seedRsvp(s, e2, { name: "Jane Doe", email: "family@example.com", createdAt: 2000 });
    const john = await seedRsvp(s, e3, { name: "John Doe", email: "family@example.com", createdAt: 1500 });

    const res = await run(s.t, (ctx) =>
      linkRsvpPeoplePage(ctx, { execute: true, cursor: null }),
    );
    expect(res.divergentGroups).toBeGreaterThanOrEqual(1);
    expect(res.skippedDivergentName).toBeGreaterThanOrEqual(1);

    const [jane1Row, jane2Row, johnRow] = await Promise.all([
      getRsvp(s, jane1),
      getRsvp(s, jane2),
      getRsvp(s, john),
    ]);
    // The majority name (Jane, 2 rows) is linked to ONE person.
    expect(jane1Row?.personId).toBeTruthy();
    expect(jane2Row?.personId).toBe(jane1Row?.personId);
    // The minority name (John) is left unlinked — never merged, never guessed.
    expect(johnRow?.personId).toBeUndefined();

    const person = await run(s.t, (ctx) => ctx.db.get(jane1Row!.personId!));
    expect(person?.name).toBe("Jane Doe");

    // Re-running doesn't spontaneously resolve John — an intentional skip,
    // not a transient one; a human resolves it from the People tab.
    const rerun = await run(s.t, (ctx) =>
      linkRsvpPeoplePage(ctx, { execute: true, cursor: null }),
    );
    expect(rerun.skippedDivergentName).toBeGreaterThanOrEqual(1);
    expect((await getRsvp(s, john))?.personId).toBeUndefined();
  });

  test("never overwrites an existing person's fields from rsvp data", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s, "Overwrite Guard");
    const existingId = await run(s.t, (ctx) =>
      ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Canonical Name",
        email: "canon@example.com",
        role: "Usher",
        isTeamMember: true,
        createdAt: Date.now(),
      }),
    );
    // The rsvp carries a DIFFERENT (e.g. informally typed) name for the same
    // email — matching must link, never rewrite the roster row's own name/role.
    await seedRsvp(s, eventId, { name: "canon nickname", email: "canon@example.com" });

    await run(s.t, (ctx) => linkRsvpPeoplePage(ctx, { execute: true, cursor: null }));

    const person = await run(s.t, (ctx) => ctx.db.get(existingId));
    expect(person).toMatchObject({
      name: "Canonical Name",
      role: "Usher",
      isTeamMember: true,
    });
  });

  test("rows with no email and no phone are skipped (nothing to match or create from)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s, "Name Only Event");
    const rsvpId = await seedRsvp(s, eventId, { name: "Name Only" });

    const res = await run(s.t, (ctx) =>
      linkRsvpPeoplePage(ctx, { execute: true, cursor: null }),
    );
    expect(res.skippedNoIdentifier).toBeGreaterThanOrEqual(1);
    expect((await getRsvp(s, rsvpId))?.personId).toBeUndefined();
    expect(await allPeople(s)).toHaveLength(0);
  });
});
