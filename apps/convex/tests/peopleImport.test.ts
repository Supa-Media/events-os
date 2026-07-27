/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { api } from "../_generated/api";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { CONTACTS_IMPORT_BATCH_LIMIT } from "../peopleImport";

/**
 * People-tab contacts import (`peopleImport.ts`) — the roster-facing home for
 * bulk contact onboarding: preview dispositions (new / matched /
 * no-identifier, with same-paste duplicates matching in-simulation), commit
 * via the SAME `matchOrCreatePersonContact` machinery the giving import uses
 * (contact-only rows, structured halves, `personEmails` write-through),
 * chapter-membership gating (no giving power needed), and the batch cap.
 */

async function seedRosterPerson(s: ChapterSetup, name: string, email?: string) {
  return run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name,
      ...(email ? { email } : {}),
      status: "active",
      createdAt: Date.now(),
    }),
  );
}

describe("previewContactsImport", () => {
  test("new / matched / no-identifier dispositions; a same-paste duplicate previews as matched", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedRosterPerson(s, "Existing Member", "existing@example.com");

    const preview = await s.as.query(api.peopleImport.previewContactsImport, {
      rows: [
        { name: "Existing Member", email: "existing@example.com" },
        { name: "Brand New", email: "new@example.com" },
        // Duplicate of the row above WITHIN this paste — must preview matched.
        { name: "Brand New", email: "new@example.com" },
        { name: "Name Only" },
      ],
    });
    expect(preview.rows.map((r) => r.disposition)).toEqual([
      "matched",
      "new",
      "matched",
      "no-identifier",
    ]);
    expect(preview.newCount).toBe(1);
    expect(preview.matchedCount).toBe(2);
    expect(preview.noIdentifierCount).toBe(1);
    // Read-only: nothing was created by previewing.
    const people = await run(s.t, (ctx) =>
      ctx.db
        .query("people")
        .withIndex("by_chapter", (q) => q.eq("chapterId", s.chapterId))
        .collect(),
    );
    expect(people.filter((p) => p.email === "new@example.com")).toHaveLength(0);
  });
});

describe("importContacts", () => {
  test("creates contact-only rows with halves + personEmails; matches instead of duplicating; idempotent re-run", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedRosterPerson(s, "Existing Member", "existing@example.com");

    const rows = [
      { name: "Existing Member", email: "existing@example.com" },
      {
        name: "Shante Evans",
        firstName: "Shante",
        lastName: "Evans",
        email: "shante@example.com",
        phone: "13102903015",
      },
      // Same-paste duplicate — must match the row above, not double-create.
      { name: "Shante Evans", email: "shante@example.com" },
      { name: "Name Only" },
    ];
    const result = await s.as.mutation(api.peopleImport.importContacts, { rows });
    expect(result).toEqual({ created: 1, matched: 2, skippedNoIdentifier: 1 });

    const people = await run(s.t, (ctx) =>
      ctx.db
        .query("people")
        .withIndex("by_chapter", (q) => q.eq("chapterId", s.chapterId))
        .collect(),
    );
    const shante = people.find((p) => p.email === "shante@example.com")!;
    expect(shante).toMatchObject({
      firstName: "Shante",
      lastName: "Evans",
      isContactOnly: true,
      notes: "Added from import",
    });
    const emails = await run(s.t, (ctx) =>
      ctx.db
        .query("personEmails")
        .withIndex("by_person", (q) => q.eq("personId", shante._id))
        .collect(),
    );
    expect(emails).toMatchObject([
      { email: "shante@example.com", verified: false, source: "manual" },
    ]);

    // Re-running the whole paste creates nothing new.
    const second = await s.as.mutation(api.peopleImport.importContacts, { rows });
    expect(second.created).toBe(0);
    expect(second.matched).toBe(3);
  });

  test("rejects an oversized batch outright", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const rows = Array.from({ length: CONTACTS_IMPORT_BATCH_LIMIT + 1 }, (_, i) => ({
      name: `P ${i}`,
      email: `p${i}@example.com`,
    }));
    await expect(s.as.mutation(api.peopleImport.importContacts, { rows })).rejects.toThrow(
      ConvexError,
    );
  });
});

describe("importContacts — person-form-fields widening", () => {
  test("a CREATE row writes location/referralSource/consent/isVolunteer/serviceIds through", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const serviceId = await run(s.t, (ctx) =>
      ctx.db.insert("serviceOptions", {
        chapterId: s.chapterId,
        name: "Greeter",
        isActive: true,
        createdAt: Date.now(),
      }),
    );

    const consentedAt = Date.now();
    await s.as.mutation(api.peopleImport.importContacts, {
      rows: [
        {
          name: "New Signup",
          email: "new-signup@example.com",
          location: "Nyack NY",
          referralSource: "Instagram",
          consentedAt,
          consentSource: "Contact Information form import, 2026-07",
          isVolunteer: true,
          serviceIds: [serviceId],
        },
      ],
    });

    const people = await run(s.t, (ctx) =>
      ctx.db
        .query("people")
        .withIndex("by_chapter", (q) => q.eq("chapterId", s.chapterId))
        .collect(),
    );
    const created = people.find((p) => p.email === "new-signup@example.com")!;
    expect(created).toMatchObject({
      location: "Nyack NY",
      referralSource: "Instagram",
      consentedAt,
      consentSource: "Contact Information form import, 2026-07",
      isVolunteer: true,
      serviceIds: [serviceId],
    });
  });

  test("a MATCHED row fills BLANK fields only — never overwrites a value already on file", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const oldServiceId = await run(s.t, (ctx) =>
      ctx.db.insert("serviceOptions", {
        chapterId: s.chapterId,
        name: "Audio",
        isActive: true,
        createdAt: Date.now(),
      }),
    );
    const newServiceId = await run(s.t, (ctx) =>
      ctx.db.insert("serviceOptions", {
        chapterId: s.chapterId,
        name: "Video",
        isActive: true,
        createdAt: Date.now(),
      }),
    );
    const existingConsentedAt = Date.now() - 1000;
    const personId = await run(s.t, (ctx) =>
      ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Existing Member",
        email: "existing@example.com",
        // Already has a value — the import row below must NOT touch this.
        location: "Existing City NY",
        consentedAt: existingConsentedAt,
        consentSource: "Prior consent capture",
        serviceIds: [oldServiceId],
        status: "active",
        createdAt: Date.now(),
      }),
    );

    // Matches by email; carries a DIFFERENT location + consent + serviceIds,
    // plus referralSource/isVolunteer the roster row has never had.
    await s.as.mutation(api.peopleImport.importContacts, {
      rows: [
        {
          name: "Existing Member",
          email: "existing@example.com",
          location: "Somewhere Else NJ",
          referralSource: "Family or friend",
          consentedAt: Date.now(),
          consentSource: "Should never be written",
          isVolunteer: true,
          serviceIds: [newServiceId],
        },
      ],
    });

    const after = await run(s.t, (ctx) => ctx.db.get(personId));
    expect(after).toMatchObject({
      // Untouched — already had a value.
      location: "Existing City NY",
      consentedAt: existingConsentedAt,
      consentSource: "Prior consent capture",
      serviceIds: [oldServiceId],
      // Filled — was blank before.
      referralSource: "Family or friend",
      isVolunteer: true,
    });
  });
});

describe("people.update — structured halves", () => {
  test("halves are authoritative and recompose the display name; name+halves together is rejected", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedRosterPerson(s, "Mary Jo Van Der Berg");

    await s.as.mutation(api.people.update, {
      personId,
      firstName: "Mary Jo",
      lastName: "Van Der Berg",
    });
    expect(await run(s.t, (ctx) => ctx.db.get(personId))).toMatchObject({
      firstName: "Mary Jo",
      lastName: "Van Der Berg",
      name: "Mary Jo Van Der Berg",
    });

    await expect(
      s.as.mutation(api.people.update, {
        personId,
        name: "Someone Else",
        firstName: "Someone",
      }),
    ).rejects.toThrow(ConvexError);

    // A plain rename still re-derives (and here, re-splits cleanly).
    await s.as.mutation(api.people.update, { personId, name: "Mary Berg" });
    expect(await run(s.t, (ctx) => ctx.db.get(personId))).toMatchObject({
      firstName: "Mary",
      lastName: "Berg",
    });

    // The grid's cells commit ONE half at a time — the unsent half must be
    // preserved, never wiped (people.update's one-at-a-time rule).
    await s.as.mutation(api.people.update, { personId, firstName: "Maria" });
    expect(await run(s.t, (ctx) => ctx.db.get(personId))).toMatchObject({
      firstName: "Maria",
      lastName: "Berg",
      name: "Maria Berg",
    });
  });
});
