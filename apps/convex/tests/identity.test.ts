/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import { newT, run, setupChapter, type ChapterSetup, type TestConvex } from "./setup.helpers";
import { normName } from "../dataHygiene";
import type { Doc, Id } from "../_generated/dataModel";

/**
 * Guest Identity review queue — suppression/resurfacing, the name-match link
 * mutation, and the "anyone on the team" access split from the admin-gated
 * `dataHygiene.mergePeople`.
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

async function seedRsvp(
  s: ChapterSetup,
  eventId: Id<"events">,
  fields: { name: string; email?: string; phone?: string; createdAt?: number },
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

async function seedPerson(
  s: ChapterSetup,
  fields: Partial<Doc<"people">> & { name: string },
): Promise<Id<"people">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("people", { chapterId: s.chapterId, createdAt: Date.now(), ...fields }),
  );
}

function getRsvp(s: ChapterSetup, id: Id<"rsvps">): Promise<Doc<"rsvps"> | null> {
  return run(s.t, (ctx) => ctx.db.get(id));
}

function getPerson(s: ChapterSetup, id: Id<"people">): Promise<Doc<"people"> | null> {
  return run(s.t, (ctx) => ctx.db.get(id));
}

function decisionCount(s: ChapterSetup): Promise<number> {
  return run(s.t, (ctx) => ctx.db.query("identityDecisions").collect()).then((r) => r.length);
}

/** A SECOND team member in the SAME chapter with a non-admin role ("member"
 *  — production onboarding's default, per `lib/org.ts#isChapterAdmin`'s doc),
 *  so tests can prove the guest-identity queue's "anyone on the team" gate is
 *  strictly looser than `dataHygiene.mergePeople`'s admin-only gate. */
async function addNonAdminMember(
  s: ChapterSetup,
  email = "member@publicworship.life",
): Promise<ReturnType<TestConvex["withIdentity"]>> {
  const userId = await run(s.t, (ctx) => ctx.db.insert("users", { email }));
  await run(s.t, (ctx) =>
    ctx.db.insert("userChapters", {
      userId,
      chapterId: s.chapterId,
      role: "member",
      isActive: true,
      joinedAt: Date.now(),
    }),
  );
  return s.t.withIdentity({ subject: `${userId}|session`, issuer: "test" });
}

describe("listNameMatchCandidates — suppression / resurfacing", () => {
  test("a 'different' verdict suppresses the pair; the pair RESURFACES once the candidate gains an identifier", async () => {
    const s = await setupChapter(newT());
    const eventId = await seedEvent(s, "Coffee Hour");

    // Candidate person has ONLY a name — thin evidence, exactly the case the
    // resurfacing contract exists for.
    const personId = await seedPerson(s, { name: "Jamie Guest" });
    await seedRsvp(s, eventId, { name: "Jamie Guest" }); // name-only, unlinked

    const before = await s.as.query(api.identity.listNameMatchCandidates, { chapterId: s.chapterId });
    expect(before).toHaveLength(1);
    expect(before[0].candidate._id).toBe(personId);
    const guestNameKey = before[0].guestNameKey;
    expect(guestNameKey).toBe(normName("Jamie Guest"));

    // Human says "different" — suppress.
    await s.as.mutation(api.identity.recordDecision, {
      chapterId: s.chapterId,
      kind: "guest_link",
      subjectKey: guestNameKey,
      candidatePersonId: personId,
      verdict: "different",
    });
    const suppressed = await s.as.query(api.identity.listNameMatchCandidates, { chapterId: s.chapterId });
    expect(suppressed).toHaveLength(0);

    // New information arrives: the candidate gains an email → the stored
    // evidence hash no longer matches current evidence → RESURFACE.
    await run(s.t, (ctx) => ctx.db.patch(personId, { email: "jamie@example.com" }));
    const resurfaced = await s.as.query(api.identity.listNameMatchCandidates, { chapterId: s.chapterId });
    expect(resurfaced).toHaveLength(1);
    expect(resurfaced[0].candidate._id).toBe(personId);
  });

  test("recordDecision writes exactly one row per call; nothing is ever written for a mere queue read (the 'not sure' no-op)", async () => {
    const s = await setupChapter(newT());
    const eventId = await seedEvent(s, "Coffee Hour");
    const personId = await seedPerson(s, { name: "Alex Guest" });
    await seedRsvp(s, eventId, { name: "Alex Guest" });

    expect(await decisionCount(s)).toBe(0);
    // Reading the queue (as a client would, e.g. to let a user skip to "not
    // sure") never itself writes anything.
    await s.as.query(api.identity.listNameMatchCandidates, { chapterId: s.chapterId });
    expect(await decisionCount(s)).toBe(0);

    await s.as.mutation(api.identity.recordDecision, {
      chapterId: s.chapterId,
      kind: "guest_link",
      subjectKey: normName("Alex Guest"),
      candidatePersonId: personId,
      verdict: "different",
    });
    expect(await decisionCount(s)).toBe(1);

    // There is no server-side path for "same" or "not sure" through this
    // mutation — its validator only accepts the literal "different".
    await expect(
      s.as.mutation(api.identity.recordDecision, {
        chapterId: s.chapterId,
        kind: "guest_link",
        subjectKey: normName("Alex Guest"),
        candidatePersonId: personId,
        // @ts-expect-error — "same" is intentionally not a legal verdict here.
        verdict: "same",
      }),
    ).rejects.toThrow();
    expect(await decisionCount(s)).toBe(1);
  });
});

describe("listUnidentifiedGuests — bucket 4 ordering", () => {
  test("orders by event count descending", async () => {
    const s = await setupChapter(newT());
    const eventId = await seedEvent(s, "Big Event");

    // "Popular" appears at 3 events, "Occasional" at 2, "OneTimer" at 1 — none
    // of these names match any existing person, so all three land in bucket 4.
    for (let i = 0; i < 3; i++) await seedRsvp(s, eventId, { name: "Popular Guest" });
    for (let i = 0; i < 2; i++) await seedRsvp(s, eventId, { name: "Occasional Guest" });
    await seedRsvp(s, eventId, { name: "OneTimer Guest" });

    const result = await s.as.query(api.identity.listUnidentifiedGuests, {
      chapterId: s.chapterId,
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(result.page.map((g) => g.displayName)).toEqual([
      "Popular Guest",
      "Occasional Guest",
      "OneTimer Guest",
    ]);
    expect(result.page[0].eventCount).toBe(3);
    expect(result.isDone).toBe(true);
    expect(result.totalCount).toBe(3);
  });

  test("totalCount reflects the full distinct-name-group count, not just this page's length", async () => {
    const s = await setupChapter(newT());
    const eventId = await seedEvent(s, "Big Event");
    for (const name of ["Guest A", "Guest B", "Guest C"]) {
      await seedRsvp(s, eventId, { name });
    }

    const firstPage = await s.as.query(api.identity.listUnidentifiedGuests, {
      chapterId: s.chapterId,
      paginationOpts: { numItems: 1, cursor: null },
    });
    expect(firstPage.page).toHaveLength(1);
    expect(firstPage.isDone).toBe(false);
    expect(firstPage.totalCount).toBe(3);
  });
});

describe("linkGuestToPerson", () => {
  test("repoints EVERY unlinked rsvp sharing the normalized name, not just one", async () => {
    const s = await setupChapter(newT());
    const eventA = await seedEvent(s, "Event A");
    const eventB = await seedEvent(s, "Event B");
    const eventC = await seedEvent(s, "Event C");
    const personId = await seedPerson(s, { name: "Jordan Guest" });

    const r1 = await seedRsvp(s, eventA, { name: "Jordan Guest" });
    const r2 = await seedRsvp(s, eventB, { name: "  jordan   guest  " }); // same after normalization
    const r3 = await seedRsvp(s, eventC, { name: "Someone Else" }); // must NOT be touched

    const guestNameKey = normName("Jordan Guest");
    const result = await s.as.mutation(api.identity.linkGuestToPerson, {
      chapterId: s.chapterId,
      guestNameKey,
      personId,
    });
    expect(result.repointed).toBe(2);
    expect((await getRsvp(s, r1))?.personId).toBe(personId);
    expect((await getRsvp(s, r2))?.personId).toBe(personId);
    expect((await getRsvp(s, r3))?.personId).toBeUndefined();

    const decisions = await run(s.t, (ctx) => ctx.db.query("identityDecisions").collect());
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ kind: "guest_link", subjectKey: guestNameKey, candidatePersonId: personId, verdict: "same" });
  });
});

describe("mergeDuplicatePeople — shares dataHygiene's merge core, looser gate", () => {
  test("repoints rsvps.personId (the dataHygiene.ts fix) and is callable by a NON-admin, unlike the public mergePeople", async () => {
    const s = await setupChapter(newT());
    const member = await addNonAdminMember(s);

    const survivorId = await seedPerson(s, { name: "Real Person", email: "real@example.com" });
    const duplicateId = await seedPerson(s, { name: "Real Person Dup" });
    const eventId = await seedEvent(s, "Some Event");
    const rsvpId = await seedRsvp(s, eventId, { name: "Real Person Dup" });
    await run(s.t, (ctx) => ctx.db.patch(rsvpId, { personId: duplicateId }));

    // A non-admin CANNOT call the public, admin-gated mergePeople.
    await expect(
      member.mutation(api.dataHygiene.mergePeople, {
        chapterId: s.chapterId,
        survivorId,
        duplicateId,
      }),
    ).rejects.toThrow();

    // The SAME non-admin CAN call mergeDuplicatePeople — "anyone on the team".
    const result = await member.mutation(api.identity.mergeDuplicatePeople, {
      chapterId: s.chapterId,
      fromId: duplicateId,
      toId: survivorId,
    });

    // Proves the rsvps repoint fix: the duplicate's rsvp now points at the
    // survivor instead of being orphaned.
    expect((await getRsvp(s, rsvpId))?.personId).toBe(survivorId);
    expect(result.repointed.rsvps).toBe(1);
    expect(await getPerson(s, duplicateId)).toBeNull();

    const decisions = await run(s.t, (ctx) => ctx.db.query("identityDecisions").collect());
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      kind: "person_merge",
      subjectKey: String(duplicateId),
      candidatePersonId: survivorId,
      verdict: "same",
    });
  });
});

describe("createPersonFromGuest", () => {
  test("creates a new person and repoints matching unlinked rsvps onto it", async () => {
    const s = await setupChapter(newT());
    const eventId = await seedEvent(s, "New Faces");
    const rsvpId = await seedRsvp(s, eventId, { name: "Brand New Guest", email: undefined });

    const guestNameKey = normName("Brand New Guest");
    const result = await s.as.mutation(api.identity.createPersonFromGuest, {
      chapterId: s.chapterId,
      guestNameKey,
      name: "Brand New Guest",
      email: "brandnew@example.com",
    });
    expect(result.repointed).toBe(1);
    expect((await getRsvp(s, rsvpId))?.personId).toBe(result.personId);
    const person = await getPerson(s, result.personId);
    expect(person).toMatchObject({ name: "Brand New Guest", email: "brandnew@example.com" });
  });
});
