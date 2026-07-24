import { describe, expect, test } from "vitest";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { runBackfillContactOnlyPeople } from "../migrations/0038_backfill_contact_only_people";
import type { Id } from "../_generated/dataModel";

/**
 * Migration 0038 — flags EXISTING donor/import-auto-created roster rows
 * (person-centric audiences Phase 1 item 1) as `isContactOnly: true`. Exact
 * string match on `notes` + `isTeamMember === false`, idempotent, and never
 * touches a row a human has since edited or promoted to the real team.
 */

async function seedPerson(
  s: ChapterSetup,
  fields: {
    name: string;
    isTeamMember?: boolean;
    notes?: string;
    isContactOnly?: boolean;
  },
): Promise<Id<"people">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      createdAt: Date.now(),
      ...fields,
    }),
  );
}

describe("migration 0038 — backfill contact-only people", () => {
  test("flags donor- and import-created contacts, leaves everyone else alone, and is idempotent", async () => {
    const t = newT();
    const s = await setupChapter(t);

    const givingContact = await seedPerson(s, {
      name: "Giving Contact",
      isTeamMember: false,
      notes: "Added from Giving",
    });
    const importContact = await seedPerson(s, {
      name: "Import Contact",
      isTeamMember: false,
      notes: "Added from import",
    });
    const realVolunteer = await seedPerson(s, {
      name: "Real Volunteer",
      isTeamMember: false,
      // No auto-contact note — a genuine manually-added volunteer.
    });
    const teamMember = await seedPerson(s, {
      name: "Team Member",
      isTeamMember: true,
      notes: "Added from Giving", // isTeamMember true → never auto-contact-noted in practice, but prove the flag wins
    });
    const editedNote = await seedPerson(s, {
      name: "Edited Note",
      isTeamMember: false,
      notes: "Added from Giving — verified by Jamie", // human-edited, no longer an EXACT match
    });
    const alreadyFlagged = await seedPerson(s, {
      name: "Already Flagged",
      isTeamMember: false,
      notes: "Added from Giving",
      isContactOnly: true,
    });

    const first = await run(s.t, (ctx) => runBackfillContactOnlyPeople(ctx));
    expect(first.flagged).toBe(2); // givingContact + importContact
    expect(first.alreadyFlagged).toBe(1); // alreadyFlagged

    const get = (id: Id<"people">) => run(s.t, (ctx) => ctx.db.get(id));
    expect((await get(givingContact))?.isContactOnly).toBe(true);
    expect((await get(importContact))?.isContactOnly).toBe(true);
    expect((await get(realVolunteer))?.isContactOnly).toBeUndefined();
    expect((await get(teamMember))?.isContactOnly).toBeUndefined();
    expect((await get(editedNote))?.isContactOnly).toBeUndefined();
    expect((await get(alreadyFlagged))?.isContactOnly).toBe(true);

    // Idempotent: a second run flags nothing new.
    const second = await run(s.t, (ctx) => runBackfillContactOnlyPeople(ctx));
    expect(second.flagged).toBe(0);
    expect(second.alreadyFlagged).toBe(3); // all three now already flagged
  });
});
