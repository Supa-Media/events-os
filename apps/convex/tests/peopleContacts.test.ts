import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import type { Id } from "../_generated/dataModel";

/**
 * Person-centric audiences Phase 1 item 1 — the contact/roster discriminator
 * (`people.isContactOnly`). Roster-facing surfaces (the People tab's default
 * `people.list`, the org chart) exclude contact rows; identity matching
 * (`lib/org.ts#chapterRoster`, the primitive `linkDonorToPerson`/
 * `linkRsvpToPerson` build on) keeps seeing them so a repeat giver/guest never
 * spawns a duplicate. See `lib/org.ts#excludeContacts`'s doc for the full
 * call-site audit; `rsvpPeople.test.ts` covers the matching side directly.
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

describe("people.list — roster vs contacts", () => {
  test("default listing excludes contact-only rows", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedPerson(s, { name: "Real Teammate", isTeamMember: true });
    await seedPerson(s, { name: "A Contact", isContactOnly: true });

    const roster = await s.as.query(api.people.list, {});
    expect(roster.map((p) => p.name)).toEqual(["Real Teammate"]);
  });

  test("contactsOnly: true returns ONLY the contact rows", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedPerson(s, { name: "Real Teammate", isTeamMember: true });
    await seedPerson(s, { name: "A Contact", isContactOnly: true });

    const contacts = await s.as.query(api.people.list, { contactsOnly: true });
    expect(contacts.map((p) => p.name)).toEqual(["A Contact"]);
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

describe("org.overview — Team tab excludes contacts", () => {
  test("a contact-only row never appears in the Team roster slice", async () => {
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
