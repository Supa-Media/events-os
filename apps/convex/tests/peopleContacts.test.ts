import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { runSeedSeatDefs } from "../migrations/0022_seed_seat_defs";
import type { Id } from "../_generated/dataModel";

/**
 * Person-centric audiences Phase 1 item 1 — the contact/roster discriminator
 * (`people.isContactOnly`).
 *
 * `isContactOnly` used to be a read-time PARTITION on `people.list`
 * (unset/false = the roster, `contactsOnly: true` = only the contact rows) —
 * that partition is exactly what hid ~111 real people from the founder's
 * People tab (auto-created contacts stayed permanently roster-side once
 * `notes` drifted off the migration's exact-match strings). `people.list`
 * now ALWAYS returns everyone; the "contact" persona
 * (`@events-os/shared#Persona`) is derived from having no participation
 * signal at all (see `peoplePersona.test.ts` for the full ladder), never
 * from this stored flag. `isContactOnly` itself is UNCHANGED here — it's
 * still stamped at insert by the two auto-creation paths below, purely as
 * provenance; identity matching (`lib/org.ts#chapterRoster`, the primitive
 * `linkDonorToPerson`/`linkRsvpToPerson` build on) keeps seeing these rows so
 * a repeat giver/guest never spawns a duplicate — that part is untouched.
 * See `lib/org.ts#excludeContacts`'s doc for the roster-UX call-site audit;
 * `rsvpPeople.test.ts` covers the matching side directly.
 */

async function seedPerson(
  s: ChapterSetup,
  fields: { name: string; isContactOnly?: boolean; isTeamMember?: boolean; email?: string },
): Promise<Id<"people">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      createdAt: Date.now(),
      ...fields,
    }),
  );
}

/** A superuser-seat-seeded chapter with the caller seated as development
 *  director at central (full giving.manage everywhere) — mirrors
 *  `donorPeople.test.ts`'s own helper, so `upsertDonor` (a REAL creation
 *  path, not a synthetically-seeded row) is reachable here too. */
async function devDirectorSetup(): Promise<ChapterSetup> {
  const t = newT();
  await run(t, (ctx) => runSeedSeatDefs(ctx));
  const s = await setupChapter(t);
  await run(s.t, async (ctx) => {
    const personId = await ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Seated Caller",
      userId: s.userId,
      createdAt: Date.now(),
    });
    const def = await ctx.db
      .query("seatDefs")
      .withIndex("by_slug", (q) => q.eq("slug", "development_director"))
      .unique();
    if (!def) throw new Error("development_director not seeded");
    await ctx.db.insert("seatAssignments", {
      seatDefId: def._id,
      scope: "central",
      personId,
      createdAt: Date.now(),
    });
  });
  return s;
}

describe("people.list — everyone, with an optional persona filter", () => {
  test("the default list includes contact-only rows (no more read-time partition)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedPerson(s, { name: "Real Teammate", isTeamMember: true });
    await seedPerson(s, { name: "A Contact", isContactOnly: true });

    const everyone = await s.as.query(api.people.list, {});
    expect(everyone.map((p) => p.name).sort()).toEqual([
      "A Contact",
      "Real Teammate",
    ]);
    // The stored flag is provenance only now — persona (no participation
    // signal) is what actually classifies "A Contact".
    expect(everyone.find((p) => p.name === "A Contact")?.persona).toBe(
      "contact",
    );
  });

  test("persona: 'contact' returns ONLY the no-participation rows", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedPerson(s, { name: "Real Teammate", isTeamMember: true });
    await seedPerson(s, { name: "A Contact", isContactOnly: true });

    const contacts = await s.as.query(api.people.list, { persona: "contact" });
    expect(contacts.map((p) => p.name)).toEqual(["A Contact"]);
  });

  test("a REAL donor-created contact (linkDonorToPerson, no pre-existing match) appears in the default list, classifies as 'contact', and is still identity-matchable", async () => {
    const s = await devDirectorSetup();

    const donorId = (await s.as.mutation(api.givingPlatform.upsertDonor, {
      scope: s.chapterId,
      name: "New Giver",
      email: "newgiver@example.com",
    })) as Id<"donors">;
    const donor = await run(s.t, (ctx) => ctx.db.get(donorId));
    expect(donor?.personId).toBeDefined();

    // Stamped isContactOnly: true at INSERT time (not just by the one-time
    // 0038 backfill) — see `lib/givingDonors.ts#linkDonorToPerson`. This is
    // pure provenance now; it no longer decides list membership.
    const created = await run(s.t, (ctx) => ctx.db.get(donor!.personId!));
    expect(created?.isContactOnly).toBe(true);

    // Appears in the default (everyone) list, classified by persona.
    const everyone = await s.as.query(api.people.list, {});
    expect(everyone.map((p) => p.name)).toContain("New Giver");
    expect(everyone.find((p) => p.name === "New Giver")?.persona).toBe(
      "contact",
    );

    // And still findable under the deliberate Contacts persona filter.
    const contacts = await s.as.query(api.people.list, { persona: "contact" });
    expect(contacts.map((p) => p.name)).toContain("New Giver");

    // And still identity-matchable: a SECOND donor sharing the same email
    // (case-insensitive) matches the SAME donor (and therefore the same
    // contact row) rather than spawning a duplicate — `donorPeople.test.ts`
    // covers the full match-order matrix directly; this just proves a
    // contact-only row specifically doesn't break that path.
    const rematchedDonorId = (await s.as.mutation(api.givingPlatform.upsertDonor, {
      scope: s.chapterId,
      name: "New Giver",
      email: "NewGiver@Example.com",
    })) as Id<"donors">;
    expect(rematchedDonorId).toBe(donorId);
    const allRows = await run(s.t, (ctx) =>
      ctx.db
        .query("people")
        .withIndex("by_chapter", (q) => q.eq("chapterId", s.chapterId))
        .collect(),
    );
    expect(allRows.filter((p) => p.email === "newgiver@example.com")).toHaveLength(1);
  });

  test("cardEligible never offers a contact row even with a matching pwEmail", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await run(s.t, (ctx) =>
      ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Contact With PW Email",
        isContactOnly: true,
        pwEmail: "contact@publicworship.life",
        createdAt: Date.now(),
      }),
    );
    const eligible = await s.as.query(api.people.cardEligible, {});
    expect(eligible).toHaveLength(0);
  });
});

describe("org.overview — Team tab excludes no-participation rows", () => {
  test("a contact-only row with no participation signal never appears in the Team roster slice", async () => {
    const t = newT();
    const s = await setupChapter(t);
    // The caller's own roster row (so `overview` returns a non-empty slice).
    await run(s.t, (ctx) =>
      ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Caller",
        userId: s.userId,
        isTeamMember: true,
        createdAt: Date.now(),
      }),
    );
    await seedPerson(s, { name: "Contact Row", isContactOnly: true });

    const overview = await s.as.query(api.org.overview, {});
    expect(overview.people.map((p) => p.name)).not.toContain("Contact Row");
  });
});
