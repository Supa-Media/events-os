import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { resolvePersonaForRoster } from "../lib/people";
import { RSVP_STATUSES } from "../schema/ticketing";
import type { Id } from "../_generated/dataModel";

/**
 * Guard 2 — the consistency test that proves the `peopleByPersona` Aggregate
 * (`lib/peopleAggregate.ts`) never drifts from a from-scratch scan, across
 * EVERY write path this feature wrapped with the triggers-based
 * `mutation`/`internalMutation`. This is the test that matters: a missed
 * write site desyncs the aggregate silently, and this test is what would
 * actually catch that — every other test in this file exercises a real
 * mutation, never a raw `ctx.db` write, specifically so a regression here
 * means a real user-facing mutation broke the cache.
 *
 * `tallyFromScratch` is a deliberately independent re-implementation of what
 * `people.ts#counts` computed BEFORE this PR (a whole-chapter scan +
 * `resolvePersonaForRoster`) — comparing the Aggregate-backed `counts` query
 * against this ground truth after every step is the actual assertion.
 */
async function tallyFromScratch(t: ReturnType<typeof newT>, chapterId: Id<"chapters">) {
  return run(t, async (ctx) => {
    const people = await ctx.db
      .query("people")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
      .collect();
    const everyone = people.filter((p) => p.isPlaceholder !== true && p.isSamplePerson !== true);
    const personaByPerson = await resolvePersonaForRoster(ctx, chapterId, everyone);
    const tally = { all: everyone.length, team: 0, vendor: 0, volunteer: 0, guest: 0, contact: 0 };
    for (const p of everyone) {
      const persona = personaByPerson.get(p._id);
      if (persona) tally[persona] += 1;
    }
    return tally;
  });
}

/** Asserts the Aggregate-backed `people.ts#counts` agrees EXACTLY with a
 *  fresh from-scratch scan — call after every write in the scenario below. */
async function expectCountsMatchScratch(s: ChapterSetup) {
  const [counts, scratch] = await Promise.all([
    s.as.query(api.people.counts, {}),
    tallyFromScratch(s.t, s.chapterId),
  ]);
  expect(counts).toEqual(scratch);
}

async function seedEventWithRole(s: ChapterSetup) {
  return run(s.t, async (ctx) => {
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
    const eventId = await ctx.db.insert("events", {
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
    const roleId = await ctx.db.insert("eventRoles", {
      eventId,
      key: "event_lead",
      label: "Event Lead",
      order: 0,
    });
    return { eventId, roleId };
  });
}

async function publishRsvpPage(s: ChapterSetup, eventId: Id<"events">) {
  const pageId = (await s.as.mutation(api.ticketing.createPage, { eventId })) as Id<"eventPages">;
  const admin = await s.as.query(api.ticketing.getAdminPage, { eventId });
  await s.as.mutation(api.ticketing.updatePage, { pageId, patch: { published: true } });
  return admin.page!.slug as string;
}

describe("peopleByPersona Aggregate consistency", () => {
  test("stays in sync with a from-scratch scan across every wrapped write path", async () => {
    const t = newT();
    const s = await setupChapter(t);

    // Baseline: an empty chapter agrees trivially.
    await expectCountsMatchScratch(s);

    // ── create person (people.ts#create) — team, vendor, plain (contact) ──
    await s.as.mutation(api.people.create, { name: "Tara Teammate", isTeamMember: true });
    await expectCountsMatchScratch(s);

    await s.as.mutation(api.people.create, { name: "Val Vendor", usualRateUsd: 250 });
    await expectCountsMatchScratch(s);

    const volunteerCandidateId = (await s.as.mutation(api.people.create, {
      name: "Pat Plain",
    })) as Id<"people">;
    await expectCountsMatchScratch(s);

    const roleCandidateId = (await s.as.mutation(api.people.create, {
      name: "Rae Roleless",
    })) as Id<"people">;
    await expectCountsMatchScratch(s);

    const guestCandidateId = (await s.as.mutation(api.people.create, {
      name: "Gia Guest",
      email: "gia@example.com",
    })) as Id<"people">;
    await expectCountsMatchScratch(s);

    const { eventId, roleId } = await seedEventWithRole(s);

    // ── add engagement (engagements.ts#add) — flips contact → volunteer ──
    await s.as.mutation(api.engagements.add, {
      eventId,
      personId: volunteerCandidateId,
      type: "volunteer",
    });
    await expectCountsMatchScratch(s);

    // ── add roleAssignment (roleAssignments.ts#assign) — contact → volunteer ──
    await s.as.mutation(api.roleAssignments.assign, {
      eventId,
      roleId,
      personId: roleCandidateId,
    });
    await expectCountsMatchScratch(s);

    // ── add rsvp (ticketing.ts#submitRsvp) — matches by email → contact → guest ──
    const slug = await publishRsvpPage(s, eventId);
    await s.as.mutation(api.ticketing.submitRsvp, {
      slug,
      name: "Gia Guest",
      email: "gia@example.com",
      status: RSVP_STATUSES[0],
    });
    await expectCountsMatchScratch(s);

    // ── merge two people (dataHygiene.ts#mergePeople) ──
    const survivorId = (await s.as.mutation(api.people.create, {
      name: "Survivor",
      isTeamMember: true,
    })) as Id<"people">;
    const duplicateId = (await s.as.mutation(api.people.create, { name: "Duplicate" })) as Id<"people">;
    await expectCountsMatchScratch(s);
    await s.as.mutation(api.dataHygiene.mergePeople, {
      chapterId: s.chapterId,
      survivorId,
      duplicateId,
    });
    await expectCountsMatchScratch(s);

    // ── delete (people.ts#remove) ──
    await s.as.mutation(api.people.remove, { personId: guestCandidateId });
    await expectCountsMatchScratch(s);
  });

  test("identity.ts guest-link and guest-merge queue paths stay in sync too", async () => {
    // #451 added a second, human-driven merge/link surface
    // (`identity.ts#linkGuestToPerson`/`mergeDuplicatePeople`) alongside
    // `dataHygiene.ts#mergePeople` — this exercises both.
    const t = newT();
    const s = await setupChapter(t);

    const { eventId } = await seedEventWithRole(s);
    const contactId = (await s.as.mutation(api.people.create, { name: "Nia Nameonly" })) as Id<"people">;
    await expectCountsMatchScratch(s);

    // An unlinked name-only rsvp for the SAME name — the guest-identity
    // queue's bucket-2 scenario. Raw-inserted (there's no public mutation
    // that creates a bare name-only rsvp without an email/phone) — the
    // WRITE under test is `linkGuestToPerson`'s `personId` patch below, via
    // the trigger-wrapped `identity.ts` mutation.
    await run(s.t, (ctx) =>
      ctx.db.insert("rsvps", {
        chapterId: s.chapterId,
        eventId,
        name: "Nia Nameonly",
        status: RSVP_STATUSES[0],
        token: `tok-${Date.now()}`,
        emailVerified: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );

    await s.as.mutation(api.identity.linkGuestToPerson, {
      chapterId: s.chapterId,
      guestNameKey: "nia nameonly",
      personId: contactId,
    });
    await expectCountsMatchScratch(s);

    // `identity.ts#mergeDuplicatePeople` — the "anyone on the team" merge
    // path distinct from `dataHygiene.ts#mergePeople`'s admin-gated one.
    const survivorId = (await s.as.mutation(api.people.create, { name: "Survivor Two" })) as Id<"people">;
    const duplicateId = (await s.as.mutation(api.people.create, {
      name: "Duplicate Two",
      usualRateUsd: 50,
    })) as Id<"people">;
    await expectCountsMatchScratch(s);
    await s.as.mutation(api.identity.mergeDuplicatePeople, {
      chapterId: s.chapterId,
      fromId: duplicateId,
      toId: survivorId,
    });
    await expectCountsMatchScratch(s);
  });
});
