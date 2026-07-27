import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import type { Doc, Id } from "../_generated/dataModel";
import { resolvePersonaForRoster } from "../lib/people";

/**
 * The full persona ladder (`@events-os/shared#Persona`:
 * team > vendor > volunteer > guest > contact) and `people.list`'s `persona`
 * filter — the founder-model fix for `people.list` hiding ~111 real people
 * behind the old `isContactOnly` read-time partition (see
 * `peopleContacts.test.ts`'s doc for the root cause).
 *
 * `personaOf` (packages/shared) stays the pure, DB-free team/vendor-only
 * classifier. `resolvePersonaForRoster` (`lib/people.ts`) is its full-ladder
 * companion: it batches the participation reads (engagements,
 * roleAssignments, rsvps) for a WHOLE roster in three bounded, chapter-scoped
 * queries — never a per-person query in a loop — and is what actually backs
 * `people.list`'s `persona` field/filter and the (former `isContactOnly`-
 * based) `lib/org.ts#excludeContacts` roster-UX call sites.
 */

async function seedPerson(
  s: ChapterSetup,
  fields: Partial<Doc<"people">> & { name: string },
): Promise<Id<"people">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      createdAt: Date.now(),
      ...fields,
    }),
  );
}

/** A minimal real event — just enough to hang engagements/roleAssignments/
 *  rsvps rows off of; the template plumbing is irrelevant to persona tests. */
async function seedEvent(s: ChapterSetup): Promise<Id<"events">> {
  return await run(s.t, async (ctx) => {
    const now = Date.now();
    const eventTypeId = await ctx.db.insert("eventTypes", {
      chapterId: s.chapterId,
      name: "Worship Night",
      slug: `worship-night-${now}-${Math.random().toString(36).slice(2)}`,
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

async function insertRsvp(
  s: ChapterSetup,
  opts: {
    eventId: Id<"events">;
    personId: Id<"people">;
    token: string;
    archivedAt?: number;
  },
): Promise<void> {
  await run(s.t, (ctx) =>
    ctx.db.insert("rsvps", {
      eventId: opts.eventId,
      chapterId: s.chapterId,
      name: "Guest",
      status: "going",
      token: opts.token,
      personId: opts.personId,
      archivedAt: opts.archivedAt,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
}

describe("persona ladder — people.list", () => {
  test("team beats every other signal", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedPerson(s, {
      name: "Team + Vendor",
      isTeamMember: true,
      usualRateUsd: 200,
    });

    const rows = await s.as.query(api.people.list, {});
    expect(rows.find((p) => p.name === "Team + Vendor")?.persona).toBe(
      "team",
    );
  });

  test("vendor beats a volunteer engagement", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedPerson(s, {
      name: "Vendor Who Also Volunteers",
      usualRateUsd: 150,
    });
    const eventId = await seedEvent(s);
    await run(s.t, (ctx) =>
      ctx.db.insert("engagements", {
        chapterId: s.chapterId,
        eventId,
        personId,
        type: "volunteer",
        status: "confirmed",
        createdAt: Date.now(),
      }),
    );

    const rows = await s.as.query(api.people.list, {});
    expect(rows.find((p) => p._id === personId)?.persona).toBe("vendor");
  });

  test("a volunteer `engagements` row classifies as volunteer", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedPerson(s, { name: "Genuine Volunteer" });
    const eventId = await seedEvent(s);
    await run(s.t, (ctx) =>
      ctx.db.insert("engagements", {
        chapterId: s.chapterId,
        eventId,
        personId,
        type: "volunteer",
        status: "confirmed",
        createdAt: Date.now(),
      }),
    );

    const volunteers = await s.as.query(api.people.list, {
      persona: "volunteer",
    });
    expect(volunteers.map((p) => p.name)).toEqual(["Genuine Volunteer"]);
  });

  test("a PAID engagement (no volunteer row) does NOT count as a volunteer signal", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedPerson(s, { name: "Paid Only" });
    const eventId = await seedEvent(s);
    await run(s.t, (ctx) =>
      ctx.db.insert("engagements", {
        chapterId: s.chapterId,
        eventId,
        personId,
        type: "paid",
        status: "confirmed",
        amountUsd: 100,
        createdAt: Date.now(),
      }),
    );

    const rows = await s.as.query(api.people.list, {});
    // No usualRateUsd on the person row itself, and a one-off paid
    // engagement isn't a volunteer signal — this falls through to "contact".
    expect(rows.find((p) => p._id === personId)?.persona).toBe("contact");
  });

  test("a `roleAssignments` row (holding an event role, no engagement) also classifies as volunteer", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedPerson(s, { name: "Role Holder" });
    const eventId = await seedEvent(s);
    const roleId = await run(s.t, (ctx) =>
      ctx.db.insert("eventRoles", {
        eventId,
        key: "event_lead",
        label: "Event Lead / PM",
        description: "Owns the planning doc.",
        order: 0,
      }),
    );
    await run(s.t, (ctx) =>
      ctx.db.insert("roleAssignments", {
        eventId,
        chapterId: s.chapterId,
        roleId,
        personId,
        createdAt: Date.now(),
      }),
    );

    const volunteers = await s.as.query(api.people.list, {
      persona: "volunteer",
    });
    expect(volunteers.map((p) => p.name)).toContain("Role Holder");
  });

  test("an explicit `isVolunteer` flag (read defensively — ships on sibling branch feat/person-form-fields) also classifies as volunteer", async () => {
    // `isVolunteer` isn't a schema field on THIS branch yet (convex-test
    // enforces the schema on every DB write, so it can't be persisted here) —
    // it ships on the sibling `feat/person-form-fields` branch. Exercise
    // `resolvePersonaForRoster`'s defensive read directly against an
    // in-memory row shaped like a future person doc, instead of round-
    // tripping through the DB.
    const t = newT();
    const s = await setupChapter(t);
    const realPersonId = await seedPerson(s, { name: "Real Row" });
    const realPerson = await run(s.t, (ctx) => ctx.db.get(realPersonId));
    const fakeFlaggedPerson = {
      ...realPerson,
      _id: "fake_flagged_person_id" as Id<"people">,
      name: "Flagged Volunteer",
      isVolunteer: true,
    } as unknown as Doc<"people">;

    // `run`'s result round-trips through Convex's value encoding (a `Map`
    // isn't a supported Convex type), so pull the one value out inside the
    // callback rather than returning the Map itself.
    const persona = await run(s.t, async (ctx) => {
      const personas = await resolvePersonaForRoster(ctx, s.chapterId, [
        fakeFlaggedPerson,
      ]);
      return personas.get(fakeFlaggedPerson._id) ?? null;
    });
    expect(persona).toBe("volunteer");
  });

  test("guest/contact boundary: a non-archived RSVP with no volunteering is 'guest', not 'contact'", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedPerson(s, { name: "Guest Only" });
    const eventId = await seedEvent(s);
    await insertRsvp(s, { eventId, personId, token: "tok-guest-only" });

    const rows = await s.as.query(api.people.list, {});
    expect(rows.find((p) => p._id === personId)?.persona).toBe("guest");

    const guests = await s.as.query(api.people.list, { persona: "guest" });
    expect(guests.map((p) => p.name)).toEqual(["Guest Only"]);
  });

  test("guest/contact boundary: an ARCHIVED rsvp is not a guest signal — falls through to 'contact'", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedPerson(s, { name: "Archived Guest" });
    const eventId = await seedEvent(s);
    await insertRsvp(s, {
      eventId,
      personId,
      token: "tok-archived",
      archivedAt: Date.now(),
    });

    const rows = await s.as.query(api.people.list, {});
    expect(rows.find((p) => p._id === personId)?.persona).toBe("contact");
  });

  test("ladder precedence: volunteering AND having attended still reads as 'volunteer', not 'guest'", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedPerson(s, {
      name: "Volunteer Who Also Attends",
    });
    const eventId = await seedEvent(s);
    await run(s.t, (ctx) =>
      ctx.db.insert("engagements", {
        chapterId: s.chapterId,
        eventId,
        personId,
        type: "volunteer",
        status: "confirmed",
        createdAt: Date.now(),
      }),
    );
    await insertRsvp(s, { eventId, personId, token: "tok-both" });

    const rows = await s.as.query(api.people.list, {});
    expect(rows.find((p) => p._id === personId)?.persona).toBe("volunteer");
  });

  test("no participation signal at all reads as 'contact', and still appears in the DEFAULT (everyone) list", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedPerson(s, { name: "Nobody Signal" });

    const everyone = await s.as.query(api.people.list, {});
    const row = everyone.find((p) => p.name === "Nobody Signal");
    expect(row).toBeDefined();
    expect(row?.persona).toBe("contact");

    const contacts = await s.as.query(api.people.list, { persona: "contact" });
    expect(contacts.map((p) => p.name)).toEqual(["Nobody Signal"]);
  });

  test("the full list still excludes placeholders and Academy sample people", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedPerson(s, { name: "Real Person" });
    await seedPerson(s, { name: "Placeholder Crew", isPlaceholder: true });
    await seedPerson(s, { name: "Academy Sample", isSamplePerson: true });

    const everyone = await s.as.query(api.people.list, {});
    expect(everyone.map((p) => p.name)).toEqual(["Real Person"]);
  });
});

describe("the former excludeContacts call sites still exclude non-participants (persona-based now)", () => {
  test("org.overview excludes a contact-persona row but includes a guest-persona row", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await run(s.t, (ctx) =>
      ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Caller",
        userId: s.userId,
        isTeamMember: true,
        createdAt: Date.now(),
      }),
    );
    await seedPerson(s, { name: "No Signal" });
    const guestId = await seedPerson(s, { name: "Attended Only" });
    const eventId = await seedEvent(s);
    await insertRsvp(s, { eventId, personId: guestId, token: "tok-overview" });

    const overview = await s.as.query(api.org.overview, {});
    const names = overview.people.map((p) => p.name);
    expect(names).not.toContain("No Signal");
    expect(names).toContain("Attended Only");
  });

  test("org.workload's subtree excludes a contact-persona report but includes a guest-persona report", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const adminPersonId = await run(s.t, (ctx) =>
      ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Admin Self",
        userId: s.userId,
        isTeamMember: true,
        createdAt: Date.now(),
      }),
    );
    await seedPerson(s, { name: "No Signal Report", managerId: adminPersonId });
    const guestId = await seedPerson(s, {
      name: "Guest Report",
      managerId: adminPersonId,
    });
    const eventId = await seedEvent(s);
    await insertRsvp(s, { eventId, personId: guestId, token: "tok-workload" });

    const workload = await s.as.query(api.org.workload, {
      personId: adminPersonId,
    });
    const memberNames = (workload?.members ?? []).map(
      (m: { name: string }) => m.name,
    );
    expect(memberNames).not.toContain("No Signal Report");
    expect(memberNames).toContain("Guest Report");
  });

  test("checkIns.listForSubtree excludes a contact-persona member's entry but includes a guest-persona member's", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const managerId = await run(s.t, (ctx) =>
      ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Manager",
        userId: s.userId,
        isTeamMember: true,
        createdAt: Date.now(),
      }),
    );
    const contactId = await seedPerson(s, {
      name: "No Signal Report",
      managerId,
    });
    const guestId = await seedPerson(s, {
      name: "Guest Report",
      managerId,
    });
    const eventId = await seedEvent(s);
    await insertRsvp(s, { eventId, personId: guestId, token: "tok-checkins" });
    await run(s.t, (ctx) =>
      ctx.db.insert("checkIns", {
        chapterId: s.chapterId,
        personId: contactId,
        managerPersonId: managerId,
        type: "checkin",
        createdBy: s.userId,
        createdAt: Date.now(),
      }),
    );
    await run(s.t, (ctx) =>
      ctx.db.insert("checkIns", {
        chapterId: s.chapterId,
        personId: guestId,
        managerPersonId: managerId,
        type: "checkin",
        createdBy: s.userId,
        createdAt: Date.now(),
      }),
    );

    const result = await s.as.query(api.checkIns.listForSubtree, {
      personId: managerId,
    });
    const subjectIds = (result?.entries ?? []).map((e: { personId: unknown }) =>
      String(e.personId),
    );
    expect(subjectIds).not.toContain(String(contactId));
    expect(subjectIds).toContain(String(guestId));
  });

  test("academy.chapterProgress excludes a contact-persona row from 'who's trained'", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedPerson(s, { name: "No Signal" });
    const guestId = await seedPerson(s, { name: "Guest Trainee" });
    const eventId = await seedEvent(s);
    await insertRsvp(s, { eventId, personId: guestId, token: "tok-academy" });

    const progress = await s.as.query(api.academy.chapterProgress, {});
    const names = (progress?.people ?? []).map((p) => p.name);
    expect(names).not.toContain("No Signal");
    expect(names).toContain("Guest Trainee");
  });
});
