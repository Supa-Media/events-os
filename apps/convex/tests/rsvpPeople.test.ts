import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import type { Doc, Id } from "../_generated/dataModel";
import { findPersonMatch, linkRsvpToPerson, linkRsvpToPersonWithRoster } from "../lib/rsvpPeople";

/**
 * Person-centric audiences Phase 1 item 2 — `lib/rsvpPeople.ts#linkRsvpToPerson`
 * (the guest↔people match-or-create primitive, mirroring
 * `lib/givingDonors.ts#linkDonorToPerson`) and its wiring into the six rsvp
 * insert sites named in specs/person-centric-audiences.md: `submitRsvp`,
 * `prepareOrder` (ticketing.ts), `applyGivebutterTickets` ×2 (email +
 * email-less), `prepareDonation` (giving.ts), and `commitAttendanceImport`
 * (covered separately in eventAttendanceImport.test.ts).
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

async function publishPage(s: ChapterSetup, eventId: Id<"events">) {
  const pageId = (await s.as.mutation(api.ticketing.createPage, {
    eventId,
  })) as Id<"eventPages">;
  const admin = await s.as.query(api.ticketing.getAdminPage, { eventId });
  await s.as.mutation(api.ticketing.updatePage, {
    pageId,
    patch: { published: true },
  });
  return { pageId, slug: admin.page!.slug };
}

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

function rsvpByEmail(
  s: ChapterSetup,
  eventId: Id<"events">,
  email: string,
): Promise<Doc<"rsvps"> | null> {
  return run(s.t, (ctx) =>
    ctx.db
      .query("rsvps")
      .withIndex("by_event_email", (q) => q.eq("eventId", eventId).eq("email", email))
      .first(),
  );
}

// ── findPersonMatch / linkRsvpToPerson (direct, unit-level) ────────────────

describe("findPersonMatch", () => {
  test("match order: email, then phone, then exact trimmed name", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const byEmail = await seedPerson(s, { name: "Email Match", email: "e@example.com" });
    const byPhone = await seedPerson(s, { name: "Phone Match", phone: "5551112222" });
    const byName = await seedPerson(s, { name: "Exact Name Match" });
    const roster = await run(s.t, (ctx) =>
      ctx.db.query("people").withIndex("by_chapter", (q) => q.eq("chapterId", s.chapterId)).collect(),
    );

    expect(findPersonMatch(roster, { email: "E@Example.com" })?._id).toBe(byEmail);
    expect(findPersonMatch(roster, { phone: "5551112222" })?._id).toBe(byPhone);
    expect(findPersonMatch(roster, { name: "Exact Name Match" })?._id).toBe(byName);
    expect(findPersonMatch(roster, { name: "Nobody Here" })).toBeNull();
  });

  test("email wins over a phone/name that would match a DIFFERENT row", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const emailRow = await seedPerson(s, {
      name: "Wrong Name",
      email: "shared@example.com",
      phone: "5559998888",
    });
    const roster = await run(s.t, (ctx) =>
      ctx.db.query("people").withIndex("by_chapter", (q) => q.eq("chapterId", s.chapterId)).collect(),
    );
    // Email present → matches on email regardless of a differing name/phone arg.
    expect(
      findPersonMatch(roster, {
        email: "shared@example.com",
        phone: "0000000000",
        name: "Totally Different",
      })?._id,
    ).toBe(emailRow);
  });
});

describe("linkRsvpToPerson", () => {
  test("no identifier (name-only) never inserts and never links", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    const rsvpId = await run(s.t, (ctx) =>
      ctx.db.insert("rsvps", {
        eventId,
        chapterId: s.chapterId,
        name: "Name Only Guest",
        status: "going",
        token: "tok-1",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    const result = await run(s.t, (ctx) =>
      linkRsvpToPerson(ctx, {
        rsvpId,
        chapterId: s.chapterId,
        name: "Name Only Guest",
      }),
    );
    expect(result).toBeNull();
    const rsvp = await run(s.t, (ctx) => ctx.db.get(rsvpId));
    expect(rsvp?.personId).toBeUndefined();
    const people = await run(s.t, (ctx) => ctx.db.query("people").collect());
    expect(people).toHaveLength(0);
  });

  test("no match, has email → inserts a contact-only row noted 'Added from RSVP'", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    const rsvpId = await run(s.t, (ctx) =>
      ctx.db.insert("rsvps", {
        eventId,
        chapterId: s.chapterId,
        name: "Fresh Guest",
        email: "fresh@example.com",
        status: "going",
        token: "tok-2",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    const personId = await run(s.t, (ctx) =>
      linkRsvpToPerson(ctx, {
        rsvpId,
        chapterId: s.chapterId,
        name: "Fresh Guest",
        email: "fresh@example.com",
      }),
    );
    expect(personId).toBeTruthy();
    const person = await run(s.t, (ctx) => ctx.db.get(personId!));
    expect(person).toMatchObject({
      name: "Fresh Guest",
      email: "fresh@example.com",
      isTeamMember: false,
      isContactOnly: true,
      notes: "Added from RSVP",
    });
    const rsvp = await run(s.t, (ctx) => ctx.db.get(rsvpId));
    expect(rsvp?.personId).toBe(personId);
  });

  test("matches an existing roster row (including a contact row) by email — no duplicate", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    const contactId = await seedPerson(s, {
      name: "Prior Contact",
      email: "repeat@example.com",
      isContactOnly: true,
      notes: "Added from RSVP",
    });
    const rsvpId = await run(s.t, (ctx) =>
      ctx.db.insert("rsvps", {
        eventId,
        chapterId: s.chapterId,
        name: "Prior Contact",
        email: "Repeat@Example.com",
        status: "going",
        token: "tok-3",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    const personId = await run(s.t, (ctx) =>
      linkRsvpToPerson(ctx, {
        rsvpId,
        chapterId: s.chapterId,
        name: "Prior Contact",
        email: "Repeat@Example.com",
      }),
    );
    expect(personId).toBe(contactId);
    const everyone = await run(s.t, (ctx) => ctx.db.query("people").collect());
    expect(everyone).toHaveLength(1); // no duplicate created
  });

  test("a matching failure never throws (best-effort)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    // A structurally valid but NONEXISTENT rsvp id (inserted then deleted) —
    // `ctx.db.patch` on it throws "no document", which the helper must
    // swallow and return `null` rather than propagate.
    const ghostId = await run(s.t, async (ctx) => {
      const id = await ctx.db.insert("rsvps", {
        eventId,
        chapterId: s.chapterId,
        name: "Ghost",
        email: "ghost@example.com",
        status: "going",
        token: "tok-4",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      await ctx.db.delete(id);
      return id;
    });

    const result = await run(s.t, (ctx) =>
      linkRsvpToPerson(ctx, {
        rsvpId: ghostId,
        chapterId: s.chapterId,
        name: "Guest",
        email: "guest@example.com",
      }),
    );
    // A person MAY still have been inserted (the failure is the patch back
    // onto the deleted rsvp, not the person creation) — what matters is that
    // the call resolved instead of throwing.
    expect(result === null || typeof result === "string").toBe(true);
  });
});

/**
 * hotfix 0037-roster-reads (prod incident, 2026-07-24) — the preloaded-roster
 * variant a batch caller (`migrations/0037_link_rsvp_people.ts`) uses so a
 * chapter's roster is read from storage at most once per invocation instead
 * of once per row. See `lib/rsvpPeople.ts`'s "PRELOADED-ROSTER VARIANT" doc
 * banner for the full incident writeup.
 */
describe("linkRsvpToPersonWithRoster", () => {
  test("matches ONLY against the passed roster array — never falls back to a fresh DB load", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    // A real person exists in the DB for this email, but is DELIBERATELY left
    // OUT of the array passed to the function — proving the function trusts
    // its caller's cache instead of silently re-querying `chapterRoster`.
    await seedPerson(s, { name: "DB-Only Person", email: "dbonly@example.com" });
    const rsvpId = await run(s.t, (ctx) =>
      ctx.db.insert("rsvps", {
        eventId,
        chapterId: s.chapterId,
        name: "DB-Only Person",
        email: "dbonly@example.com",
        status: "going",
        token: "tok-roster-1",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );

    const staleRoster: Doc<"people">[] = []; // deliberately missing the DB row above
    const result = await run(s.t, (ctx) =>
      linkRsvpToPersonWithRoster(
        ctx,
        { rsvpId, chapterId: s.chapterId, name: "DB-Only Person", email: "dbonly@example.com" },
        staleRoster,
      ),
    );
    expect(result.status).toBe("linked");
    // Since the passed-in roster didn't contain the existing person, this
    // created a SECOND (duplicate) contact rather than matching it — proof
    // the match was decided purely from `staleRoster`, not a fresh reload.
    const everyone = await run(s.t, (ctx) => ctx.db.query("people").collect());
    expect(everyone).toHaveLength(2);
  });

  test("a freshly created contact is appended to the passed roster in place, so a later call sees it without a reload", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    const r1 = await run(s.t, (ctx) =>
      ctx.db.insert("rsvps", {
        eventId,
        chapterId: s.chapterId,
        name: "Shared Inbox",
        email: "shared-page@example.com",
        status: "going",
        token: "tok-roster-2a",
        createdAt: 1000,
        updatedAt: 1000,
      }),
    );
    const r2 = await run(s.t, (ctx) =>
      ctx.db.insert("rsvps", {
        eventId,
        chapterId: s.chapterId,
        name: "Shared Inbox",
        email: "shared-page@example.com",
        status: "going",
        token: "tok-roster-2b",
        createdAt: 2000,
        updatedAt: 2000,
      }),
    );

    const roster: Doc<"people">[] = []; // simulates a page-level cache, starts empty
    const first = await run(s.t, (ctx) =>
      linkRsvpToPersonWithRoster(
        ctx,
        { rsvpId: r1, chapterId: s.chapterId, name: "Shared Inbox", email: "shared-page@example.com" },
        roster,
      ),
    );
    expect(first.status).toBe("linked");
    expect(roster).toHaveLength(1); // appended in place — no second DB read needed

    // SAME roster array reference, no reload — a second row for the SAME
    // email must MATCH the just-created person, not create a duplicate.
    const second = await run(s.t, (ctx) =>
      linkRsvpToPersonWithRoster(
        ctx,
        { rsvpId: r2, chapterId: s.chapterId, name: "Shared Inbox", email: "shared-page@example.com" },
        roster,
      ),
    );
    expect(second.status).toBe("linked");
    if (first.status === "linked" && second.status === "linked") {
      expect(second.personId).toBe(first.personId);
    }
    expect(roster).toHaveLength(1); // still one — the second call matched, didn't append
    const everyone = await run(s.t, (ctx) => ctx.db.query("people").collect());
    expect(everyone).toHaveLength(1); // no duplicate
  });

  test("discriminated result: 'skipped' (no identifier) is never confused with 'failed' (an actual exception)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    const nameOnlyId = await run(s.t, (ctx) =>
      ctx.db.insert("rsvps", {
        eventId,
        chapterId: s.chapterId,
        name: "Name Only",
        status: "going",
        token: "tok-roster-3",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    const skipped = await run(s.t, (ctx) =>
      linkRsvpToPersonWithRoster(ctx, { rsvpId: nameOnlyId, chapterId: s.chapterId, name: "Name Only" }, []),
    );
    expect(skipped.status).toBe("skipped");

    // Same ghost-rsvp-id pattern as `linkRsvpToPerson`'s "never throws" test —
    // here it must come back `status: "failed"`, not `"skipped"`.
    const ghostId = await run(s.t, async (ctx) => {
      const id = await ctx.db.insert("rsvps", {
        eventId,
        chapterId: s.chapterId,
        name: "Ghost",
        email: "ghost-roster@example.com",
        status: "going",
        token: "tok-roster-4",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      await ctx.db.delete(id);
      return id;
    });
    const failed = await run(s.t, (ctx) =>
      linkRsvpToPersonWithRoster(
        ctx,
        { rsvpId: ghostId, chapterId: s.chapterId, name: "Ghost", email: "ghost-roster@example.com" },
        [],
      ),
    );
    expect(failed.status).toBe("failed");
    if (failed.status === "failed") {
      expect(failed.error).toBeTruthy();
    }
  });
});

// ── Wiring: each live insert site links ─────────────────────────────────────

describe("submitRsvp links", () => {
  test("a fresh RSVP with an email links to a new contact", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    const { slug } = await publishPage(s, eventId);

    await t.mutation(api.ticketing.submitRsvp, {
      slug,
      name: "Ada Guest",
      email: "ada@example.com",
      status: "going",
    });

    const rsvp = await rsvpByEmail(s, eventId, "ada@example.com");
    expect(rsvp?.personId).toBeTruthy();
    const person = await run(s.t, (ctx) => ctx.db.get(rsvp!.personId!));
    expect(person).toMatchObject({ name: "Ada Guest", isContactOnly: true });
  });

  test("an RSVP matching an existing roster teammate links WITHOUT flipping them to a contact", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    const { slug } = await publishPage(s, eventId);
    const teamPersonId = await seedPerson(s, {
      name: "Team Ada",
      email: "team-ada@example.com",
      isTeamMember: true,
    });

    await t.mutation(api.ticketing.submitRsvp, {
      slug,
      name: "Team Ada",
      email: "team-ada@example.com",
      status: "going",
    });

    const rsvp = await rsvpByEmail(s, eventId, "team-ada@example.com");
    expect(rsvp?.personId).toBe(teamPersonId);
    const person = await run(s.t, (ctx) => ctx.db.get(teamPersonId));
    expect(person?.isTeamMember).toBe(true); // untouched — matching never mutates the matched row
  });
});

describe("prepareOrder links", () => {
  test("a fresh ticket buyer links to a new contact", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    const { pageId, slug } = await publishPage(s, eventId);
    await s.as.mutation(api.ticketing.updatePage, { pageId, patch: { ticketsEnabled: true } });
    const freeId = (await s.as.mutation(api.ticketing.createTicketType, {
      eventId,
      name: "GA",
      priceCents: 0,
      capacity: 10,
    })) as Id<"ticketTypes">;

    await t.mutation(internal.ticketing.prepareOrder, {
      slug,
      name: "Ben Buyer",
      email: "ben@example.com",
      phone: "5551234567",
      items: [{ ticketTypeId: freeId, quantity: 1 }],
    });

    const rsvp = await rsvpByEmail(s, eventId, "ben@example.com");
    expect(rsvp?.personId).toBeTruthy();
    const person = await run(s.t, (ctx) => ctx.db.get(rsvp!.personId!));
    expect(person?.isContactOnly).toBe(true);
  });
});

describe("applyGivebutterTickets links", () => {
  async function seedGbEvent(s: ChapterSetup) {
    const eventId = await seedEvent(s);
    await s.as.mutation(api.ticketing.createPage, { eventId });
    return eventId;
  }

  test("an emailed Givebutter ticket links to a new contact", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedGbEvent(s);

    await t.mutation(internal.givebutterSync.applyGivebutterTickets, {
      eventId,
      tickets: [
        {
          externalId: "gb-1",
          ticketTypeName: "GA",
          attendeeName: "Gia Buyer",
          email: "gia@example.com",
          phone: null,
          priceCents: 2500,
          checkedInAt: null,
          createdAt: Date.now(),
        },
      ],
    });

    const rsvp = await rsvpByEmail(s, eventId, "gia@example.com");
    expect(rsvp?.personId).toBeTruthy();
    const person = await run(s.t, (ctx) => ctx.db.get(rsvp!.personId!));
    expect(person).toMatchObject({ name: "Gia Buyer", isContactOnly: true });
  });

  test("an email-less Givebutter ticket links by phone", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedGbEvent(s);
    const contactId = await seedPerson(s, {
      name: "Phone Only Buyer",
      phone: "5556667777",
      isContactOnly: true,
    });

    await t.mutation(internal.givebutterSync.applyGivebutterTickets, {
      eventId,
      tickets: [
        {
          externalId: "gb-2",
          ticketTypeName: "GA",
          attendeeName: "Phone Only Buyer",
          email: null,
          phone: "5556667777",
          priceCents: 0,
          checkedInAt: null,
          createdAt: Date.now(),
        },
      ],
    });

    const rsvps = await run(s.t, (ctx) =>
      ctx.db.query("rsvps").withIndex("by_event", (q) => q.eq("eventId", eventId)).collect(),
    );
    const rsvp = rsvps.find((r) => r.name === "Phone Only Buyer");
    expect(rsvp?.personId).toBe(contactId); // matched, not duplicated
    const everyone = await run(s.t, (ctx) => ctx.db.query("people").collect());
    expect(everyone).toHaveLength(1);
  });
});

describe("prepareDonation (giving.ts guest capture) links", () => {
  test("a fresh donor-guest links to a new contact", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    const { pageId, slug } = await publishPage(s, eventId);
    await s.as.mutation(api.ticketing.updatePage, { pageId, patch: { givingEnabled: true } });

    await t.mutation(internal.giving.prepareDonation, {
      slug,
      name: "Dana Donor",
      email: "dana@example.com",
      amountCents: 2500,
    });

    const rsvp = await rsvpByEmail(s, eventId, "dana@example.com");
    expect(rsvp?.personId).toBeTruthy();
    const person = await run(s.t, (ctx) => ctx.db.get(rsvp!.personId!));
    expect(person?.isContactOnly).toBe(true);
  });
});
