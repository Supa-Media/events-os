/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { runSeedSeatDefs } from "../migrations/0022_seed_seat_defs";
import { linkDonorToPerson } from "../lib/givingDonors";
import { PROJECT_STATUSES, RESPONSIBILITY_CADENCES, CARD_TYPES, CARD_STATUSES } from "@events-os/shared";
import type { Doc, Id } from "../_generated/dataModel";

/**
 * Attendance C — data hygiene: duplicate detection, people + donor merge, and
 * the no-identifier creation guard.
 */

// ── shared helpers ────────────────────────────────────────────────────────────

async function seedPerson(
  s: ChapterSetup,
  fields: Partial<Doc<"people">> & { name: string },
): Promise<Id<"people">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("people", { chapterId: s.chapterId, createdAt: Date.now(), ...fields }),
  );
}

async function allPeople(s: ChapterSetup): Promise<Doc<"people">[]> {
  return run(s.t, (ctx) =>
    ctx.db.query("people").withIndex("by_chapter", (q) => q.eq("chapterId", s.chapterId)).collect(),
  );
}

/** Seat the caller as development director at central — full giving.manage at
 *  every scope (mirrors donorPeople.test.ts). */
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

// ═══════════════════════════════════════════════════════════════════════════
// DETECTION
// ═══════════════════════════════════════════════════════════════════════════

describe("listPeopleDuplicates", () => {
  test("groups by email, phone (format-insensitive), and name (lower confidence); excludes placeholder/sample", async () => {
    const s = await setupChapter(t_setup());
    // email group (different case).
    await seedPerson(s, { name: "Ann One", email: "dup@example.com" });
    await seedPerson(s, { name: "Ann Two", email: "DUP@example.com" });
    // phone group (different formatting).
    await seedPerson(s, { name: "Bob One", phone: "(555) 123-4567" });
    await seedPerson(s, { name: "Bob Two", phone: "555-123-4567" });
    // name-only group (no email/phone).
    await seedPerson(s, { name: "Cara  Zed!" });
    await seedPerson(s, { name: "cara zed" });
    // placeholder + sample sharing an identifier must NOT surface.
    const placeholderId = await seedPerson(s, { name: "Ghost", email: "dup@example.com", isPlaceholder: true });
    const sampleId = await seedPerson(s, { name: "Maya Sample", phone: "5551234567", isSamplePerson: true });

    const { groups } = await s.as.query(api.dataHygiene.listPeopleDuplicates, {
      chapterId: s.chapterId,
    });

    const kinds = groups.map((g) => g.matchKind);
    // email/phone groups rank ahead of the name group.
    expect(kinds.indexOf("name")).toBeGreaterThan(kinds.indexOf("email"));
    expect(kinds.indexOf("name")).toBeGreaterThan(kinds.indexOf("phone"));

    const email = groups.find((g) => g.matchKind === "email")!;
    expect(email.people).toHaveLength(2);
    const phone = groups.find((g) => g.matchKind === "phone")!;
    expect(phone.people).toHaveLength(2);
    const name = groups.find((g) => g.matchKind === "name")!;
    expect(name.people).toHaveLength(2);

    // Placeholder/sample rows never appear in any group.
    const allIds = groups.flatMap((g) => g.people.map((p) => p._id));
    expect(allIds).not.toContain(placeholderId);
    expect(allIds).not.toContain(sampleId);
  });

  test("refuses a non-admin caller", async () => {
    const s = await setupChapter(t_setup());
    const outsiderId = await run(s.t, (ctx) =>
      ctx.db.insert("users", { email: "outsider@publicworship.life" }),
    );
    const outsider = s.t.withIdentity({ subject: `${outsiderId}|session`, issuer: "test" });
    await expect(
      outsider.query(api.dataHygiene.listPeopleDuplicates, { chapterId: s.chapterId }),
    ).rejects.toThrow();
  });
});

// A fresh convex-test client per detection test.
function t_setup() {
  return newT();
}

// ═══════════════════════════════════════════════════════════════════════════
// MERGE PEOPLE
// ═══════════════════════════════════════════════════════════════════════════

describe("mergePeople", () => {
  test("re-points every reference, fills blanks, audits notes, deletes the duplicate", async () => {
    const s = await setupChapter(newT());

    const survivorId = await seedPerson(s, {
      name: "Real Person",
      email: "real@example.com",
      notes: "known donor",
    });
    const duplicateId = await seedPerson(s, {
      name: "Real Person Dup",
      phone: "555-000-1111", // survivor has no phone → should fill
      notes: "met at event",
    });

    // References pointing at the DUPLICATE, across every re-point mechanism.
    const donorId = await run(s.t, (ctx) =>
      ctx.db.insert("donors", {
        scope: s.chapterId,
        kind: "individual",
        name: "Real Person",
        status: "prospect",
        personId: duplicateId, // donor↔person link (donors scan)
        lifetimeCents: 0,
        giftCount: 0,
        createdAt: Date.now(),
      }),
    );
    const projectId = await run(s.t, (ctx) =>
      ctx.db.insert("projects", {
        chapterId: s.chapterId,
        name: "A project",
        status: PROJECT_STATUSES[0],
        ownerPersonId: duplicateId, // ownerPersonId pointer (idx by_owner)
        createdBy: s.userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    const childId = await seedPerson(s, { name: "Report", managerId: duplicateId }); // managerId child (idx by_manager)
    const cardId = await run(s.t, (ctx) =>
      ctx.db.insert("cards", {
        chapterId: s.chapterId,
        cardholderPersonId: duplicateId, // idx by_cardholder
        type: CARD_TYPES[0],
        status: CARD_STATUSES[0],
        createdAt: Date.now(),
      }),
    );
    const progressId = await run(s.t, (ctx) =>
      ctx.db.insert("academyProgress", {
        chapterId: s.chapterId,
        personId: duplicateId, // idx by_chapter_and_person
        sectionSlug: "some-slug",
      }),
    );
    const docId = await run(s.t, (ctx) =>
      ctx.db.insert("docs", {
        chapterId: s.chapterId,
        kind: "note",
        title: "A note",
        shareId: "share-abc",
        createdBy: duplicateId, // chapter scan
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    const dutyId = await run(s.t, (ctx) =>
      ctx.db.insert("responsibilities", {
        chapterId: s.chapterId,
        title: "A duty",
        cadence: RESPONSIBILITY_CADENCES[0],
        assigneePersonIds: [duplicateId], // id-array scan
        createdBy: s.userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );

    const result = await s.as.mutation(api.dataHygiene.mergePeople, {
      chapterId: s.chapterId,
      survivorId,
      duplicateId,
    });

    // Every reference now points at the survivor.
    const get = <T>(id: Id<any>) => run(s.t, (ctx) => ctx.db.get(id)) as Promise<T>;
    expect((await get<Doc<"donors">>(donorId)).personId).toBe(survivorId);
    expect((await get<Doc<"projects">>(projectId)).ownerPersonId).toBe(survivorId);
    expect((await get<Doc<"people">>(childId)).managerId).toBe(survivorId);
    expect((await get<Doc<"cards">>(cardId)).cardholderPersonId).toBe(survivorId);
    expect((await get<Doc<"academyProgress">>(progressId)).personId).toBe(survivorId);
    expect((await get<Doc<"docs">>(docId)).createdBy).toBe(survivorId);
    expect((await get<Doc<"responsibilities">>(dutyId)).assigneePersonIds).toEqual([survivorId]);

    // The duplicate row is gone.
    expect(await get(duplicateId)).toBeNull();

    // Field-merge: survivor kept its email, filled the blank phone, audited notes.
    const survivor = await get<Doc<"people">>(survivorId);
    expect(survivor.email).toBe("real@example.com");
    expect(survivor.phone).toBe("555-000-1111");
    expect(survivor.notes).toContain("known donor");
    expect(survivor.notes).toContain("met at event");
    expect(survivor.notes).toMatch(/\[merged from Real Person Dup, .*\]/);
    expect(result.fieldsFilled).toContain("phone");

    // Summary counts the touched tables.
    expect(result.repointed.projects).toBe(1);
    expect(result.repointed.people).toBe(1); // the managerId child
    expect(result.repointed.donors).toBe(1);
  });

  test("clears a self-manage edge created by the merge (no person is their own manager)", async () => {
    const s = await setupChapter(newT());
    const survivorId = await seedPerson(s, { name: "Boss", email: "boss@example.com" });
    // Survivor was managed BY the duplicate → after merge that would be self.
    const duplicateId = await seedPerson(s, { name: "Boss Dup" });
    await run(s.t, (ctx) => ctx.db.patch(survivorId, { managerId: duplicateId }));

    await s.as.mutation(api.dataHygiene.mergePeople, {
      chapterId: s.chapterId,
      survivorId,
      duplicateId,
    });
    const survivor = (await run(s.t, (ctx) => ctx.db.get(survivorId))) as Doc<"people">;
    expect(survivor.managerId).toBeUndefined();
  });

  test("refuses when both people hold different real accounts", async () => {
    const s = await setupChapter(newT());
    const otherUser = await run(s.t, (ctx) =>
      ctx.db.insert("users", { email: "second@publicworship.life" }),
    );
    const survivorId = await seedPerson(s, { name: "Acct A", email: "a@example.com", userId: s.userId });
    const duplicateId = await seedPerson(s, { name: "Acct B", email: "b@example.com", userId: otherUser });
    await expect(
      s.as.mutation(api.dataHygiene.mergePeople, {
        chapterId: s.chapterId,
        survivorId,
        duplicateId,
      }),
    ).rejects.toThrow(/different sign-in accounts/);
  });

  test("refuses a cross-chapter merge", async () => {
    const s = await setupChapter(newT());
    const otherChapter = await run(s.t, (ctx) =>
      ctx.db.insert("chapters", { name: "Other", isActive: true, createdAt: Date.now() }),
    );
    const survivorId = await seedPerson(s, { name: "Here", email: "here@example.com" });
    const duplicateId = await run(s.t, (ctx) =>
      ctx.db.insert("people", { chapterId: otherChapter, name: "There", createdAt: Date.now() }),
    );
    await expect(
      s.as.mutation(api.dataHygiene.mergePeople, {
        chapterId: s.chapterId,
        survivorId,
        duplicateId,
      }),
    ).rejects.toThrow(/belong to this chapter/);
  });

  // Person-centric audiences Phase 2 (specs/person-centric-audiences.md) —
  // `personEmails` write-through gap fix: blank-filling email/pwEmail onto
  // the survivor must record it, and the duplicate's OWN ledger rows must be
  // re-pointed (deduped on collision, `isPrimary` cleared) rather than left
  // dangling on the deleted duplicate.
  test("blank-filling email/pwEmail onto the survivor records personEmails write-through", async () => {
    const s = await setupChapter(newT());
    const survivorId = await seedPerson(s, { name: "No Email Yet" }); // blank email + pwEmail
    const duplicateId = await seedPerson(s, {
      name: "Has Both",
      email: "personal@example.com",
      pwEmail: "team@publicworship.life",
    });

    await s.as.mutation(api.dataHygiene.mergePeople, {
      chapterId: s.chapterId,
      survivorId,
      duplicateId,
    });

    const rows = await run(s.t, (ctx) =>
      ctx.db.query("personEmails").withIndex("by_person", (q) => q.eq("personId", survivorId)).collect(),
    );
    const bySource = Object.fromEntries(rows.map((r) => [r.source, r]));
    expect(bySource.roster).toMatchObject({ email: "personal@example.com", verified: true });
    expect(bySource.pw).toMatchObject({ email: "team@publicworship.life", verified: true });
  });

  test("repoints the duplicate's personEmails rows onto the survivor: no orphaned personId, dedupe on collision, at most one isPrimary", async () => {
    const s = await setupChapter(newT());
    const survivorId = await seedPerson(s, { name: "Survivor" });
    const duplicateId = await seedPerson(s, { name: "Duplicate" });

    // Survivor already knows "shared@example.com" via a TRUSTED donor row,
    // marked as its chosen primary.
    const survivorSharedRowId = await run(s.t, (ctx) =>
      ctx.db.insert("personEmails", {
        personId: survivorId,
        email: "shared@example.com",
        source: "donor",
        verified: true,
        isPrimary: true,
        addedAt: 1000,
      }),
    );
    // The duplicate knows the SAME address, but via a weaker, unverified rsvp
    // row — the survivor's row must win the collision; the duplicate's must
    // be deleted (not left dangling on the now-gone duplicateId).
    await run(s.t, (ctx) =>
      ctx.db.insert("personEmails", {
        personId: duplicateId,
        email: "shared@example.com",
        source: "rsvp",
        verified: false,
        addedAt: 2000,
      }),
    );
    // The duplicate ALSO knows a UNIQUE address the survivor has never seen,
    // marked primary on the duplicate's own (now-irrelevant) side — this must
    // move onto the survivor with `isPrimary` cleared, never creating a
    // second primary row.
    const duplicateUniqueRowId = await run(s.t, (ctx) =>
      ctx.db.insert("personEmails", {
        personId: duplicateId,
        email: "unique@example.com",
        source: "roster",
        verified: true,
        isPrimary: true,
        addedAt: 3000,
      }),
    );

    await s.as.mutation(api.dataHygiene.mergePeople, {
      chapterId: s.chapterId,
      survivorId,
      duplicateId,
    });

    const survivorRows = await run(s.t, (ctx) =>
      ctx.db.query("personEmails").withIndex("by_person", (q) => q.eq("personId", survivorId)).collect(),
    );
    expect(survivorRows.map((r) => r.email).sort()).toEqual([
      "shared@example.com",
      "unique@example.com",
    ]);
    // The collision kept the survivor's ALREADY-TRUSTED row (donor, verified)
    // — the duplicate's weaker rsvp row was deleted, not merely re-pointed.
    const sharedRow = survivorRows.find((r) => r.email === "shared@example.com")!;
    expect(sharedRow._id).toBe(survivorSharedRowId);
    expect(sharedRow).toMatchObject({ source: "donor", verified: true, isPrimary: true });
    // The unique row moved over, but its `isPrimary` was cleared on repoint.
    const uniqueRow = survivorRows.find((r) => r.email === "unique@example.com")!;
    expect(uniqueRow._id).toBe(duplicateUniqueRowId);
    expect(uniqueRow.personId).toBe(survivorId);
    expect(uniqueRow.isPrimary).toBeUndefined();

    // No orphaned row still points at the deleted duplicate.
    const allRows = await run(s.t, (ctx) => ctx.db.query("personEmails").collect());
    expect(allRows.some((r) => r.personId === duplicateId)).toBe(false);
    // At most one isPrimary row for the survivor.
    expect(survivorRows.filter((r) => r.isPrimary === true)).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// MERGE DONORS
// ═══════════════════════════════════════════════════════════════════════════

async function scopeRollup(s: ChapterSetup, scope: Id<"chapters"> | "central") {
  const row = await run(s.t, (ctx) =>
    ctx.db.query("givingScopeRollups").withIndex("by_scope", (q) => q.eq("scope", scope)).unique(),
  );
  if (!row) return null;
  const { _id, _creationTime, updatedAt, ...rest } = row as any;
  return rest;
}

describe("mergeDonors", () => {
  test("re-points gifts/pledges/sponsorships, recomputes rollups, and the scope rollup nets exactly", async () => {
    const s = await devDirectorSetup();
    const scope = s.chapterId;

    const survivorId = (await s.as.mutation(api.givingPlatform.upsertDonor, {
      scope,
      name: "Survivor",
      email: "surv@example.com",
    })) as Id<"donors">;
    await s.as.mutation(api.givingPlatform.recordGift, { donorId: survivorId, amountCents: 5000, method: "cash" });

    const duplicateId = (await s.as.mutation(api.givingPlatform.upsertDonor, {
      scope,
      name: "Survivor Dup",
      email: "dup@example.com",
    })) as Id<"donors">;
    await s.as.mutation(api.givingPlatform.recordGift, { donorId: duplicateId, amountCents: 3000, method: "cash" });

    // A pledge + sponsorship on the DUPLICATE (re-point coverage; neither
    // touches the giving scope rollup).
    const pledgeId = await run(s.t, (ctx) =>
      ctx.db.insert("pledges", {
        donorId: duplicateId,
        scope,
        amountCents: 5000,
        status: "active",
        origin: "stripe",
        createdAt: Date.now(),
      }),
    );
    const packageId = await run(s.t, (ctx) =>
      ctx.db.insert("sponsorPackages", {
        name: "Gold",
        tierRank: 1,
        audience: "any",
        pricing: { kind: "annual", amountCents: 100000 },
        scope: { kind: "annual" },
        benefits: ["logo"],
        commitments: ["mention"],
        active: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        updatedBy: s.userId,
      }),
    );
    const sponsorshipId = await run(s.t, (ctx) =>
      ctx.db.insert("sponsorships", {
        donorId: duplicateId,
        packageId,
        status: "prospect",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );

    const before = await scopeRollup(s, scope);

    const result = await s.as.mutation(api.dataHygiene.mergeDonors, {
      scope,
      survivorId,
      duplicateId,
    });

    // Re-pointed.
    expect((await run(s.t, (ctx) => ctx.db.get(pledgeId)) as Doc<"pledges">).donorId).toBe(survivorId);
    expect((await run(s.t, (ctx) => ctx.db.get(sponsorshipId)) as Doc<"sponsorships">).donorId).toBe(survivorId);
    expect(result.repointed.gifts).toBe(1);
    expect(result.repointed.pledges).toBe(1);
    expect(result.repointed.sponsorships).toBe(1);

    // Duplicate deleted; survivor rollups recomputed from both gifts.
    expect(await run(s.t, (ctx) => ctx.db.get(duplicateId))).toBeNull();
    const survivor = (await run(s.t, (ctx) => ctx.db.get(survivorId))) as Doc<"donors">;
    expect(survivor.lifetimeCents).toBe(8000);
    expect(survivor.giftCount).toBe(2);
    expect(survivor.status).toBe("active");

    // Scope rollup nets EXACTLY: donorCount −1, activeCount −1 (two active → one),
    // lifetimeCents/giftCount unchanged (gifts only moved donors).
    const after = await scopeRollup(s, scope);
    expect(after.donorCount).toBe(before.donorCount - 1);
    expect(after.activeCount).toBe(before.activeCount - 1);
    expect(after.lifetimeCents).toBe(before.lifetimeCents);
    expect(after.giftCount).toBe(before.giftCount);
    expect(after.prospectCount).toBe(before.prospectCount);
    expect(after.lapsedCount).toBe(before.lapsedCount);
  });

  test("gift launch-pot flags survive the merge untouched", async () => {
    const s = await devDirectorSetup();
    const scope = s.chapterId;
    const mk = (name: string, email: string) =>
      run(s.t, (ctx) =>
        ctx.db.insert("donors", {
          scope,
          kind: "individual",
          name,
          email,
          status: "active",
          lifetimeCents: 0,
          giftCount: 0,
          createdAt: Date.now(),
        }),
      );
    const survivorId = await mk("Keep", "keep@example.com");
    const duplicateId = await mk("Drop", "drop@example.com");

    const flaggedGiftId = await run(s.t, (ctx) =>
      ctx.db.insert("gifts", {
        donorId: duplicateId,
        scope,
        amountCents: 4000,
        currency: "usd",
        receivedAt: Date.now(),
        method: "cash",
        countedInLaunchFund: true,
        createdAt: Date.now(),
      }),
    );

    await s.as.mutation(api.dataHygiene.mergeDonors, { scope, survivorId, duplicateId });

    const gift = (await run(s.t, (ctx) => ctx.db.get(flaggedGiftId))) as Doc<"gifts">;
    expect(gift.donorId).toBe(survivorId);
    expect(gift.countedInLaunchFund).toBe(true); // untouched
  });

  test("refuses a cross-scope merge", async () => {
    const s = await devDirectorSetup();
    const chapterDonor = await run(s.t, (ctx) =>
      ctx.db.insert("donors", {
        scope: s.chapterId,
        kind: "individual",
        name: "Chapter",
        status: "prospect",
        lifetimeCents: 0,
        giftCount: 0,
        createdAt: Date.now(),
      }),
    );
    const centralDonor = await run(s.t, (ctx) =>
      ctx.db.insert("donors", {
        scope: "central",
        kind: "individual",
        name: "Central",
        status: "prospect",
        lifetimeCents: 0,
        giftCount: 0,
        createdAt: Date.now(),
      }),
    );
    await expect(
      s.as.mutation(api.dataHygiene.mergeDonors, {
        scope: s.chapterId,
        survivorId: chapterDonor,
        duplicateId: centralDonor,
      }),
    ).rejects.toThrow(/belong to this scope/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// CREATION GUARD (no-identifier owner rule)
// ═══════════════════════════════════════════════════════════════════════════

describe("no-identifier creation guard", () => {
  test("linkDonorToPerson never inserts a roster row for an identifier-less donor", async () => {
    const s = await devDirectorSetup();
    const before = (await allPeople(s)).length;

    // A name-only donor (no email, no phone) that matches no roster row.
    const donorId = await run(s.t, (ctx) =>
      ctx.db.insert("donors", {
        scope: s.chapterId,
        kind: "individual",
        name: "Nameless Guest",
        status: "prospect",
        lifetimeCents: 0,
        giftCount: 0,
        createdAt: Date.now(),
      }),
    );
    const linked = await run(s.t, async (ctx) => {
      const donor = (await ctx.db.get(donorId))!;
      return linkDonorToPerson(ctx, donor);
    });

    expect(linked).toBeNull();
    expect((await run(s.t, (ctx) => ctx.db.get(donorId)) as Doc<"donors">).personId).toBeUndefined();
    // No new roster row was created.
    expect((await allPeople(s)).length).toBe(before);
  });

  test("an import contact row without email or phone reports no-identifier and creates nothing", async () => {
    const s = await devDirectorSetup();
    const before = (await allPeople(s)).length;

    const preview = await s.as.query(api.givingImport.previewImport, {
      scope: s.chapterId,
      rows: [{ rowType: "contact", name: "Name Only Guest" }],
    });
    expect(preview.rows[0].disposition).toBe("no-identifier");

    const result = await s.as.mutation(api.givingImport.importCanonical, {
      scope: s.chapterId,
      rows: [{ rowType: "contact", name: "Name Only Guest" }],
    });
    expect(result.imported.people).toBe(0);
    expect(result.skippedNoIdentifier).toBe(1);
    expect((await allPeople(s)).length).toBe(before); // nothing created
  });

  test("an import contact row WITH an email still creates a roster contact", async () => {
    const s = await devDirectorSetup();
    const before = (await allPeople(s)).length;
    const result = await s.as.mutation(api.givingImport.importCanonical, {
      scope: s.chapterId,
      rows: [{ rowType: "contact", name: "Has Email", email: "hasemail@example.com" }],
    });
    expect(result.imported.people).toBe(1);
    expect((await allPeople(s)).length).toBe(before + 1);
  });
});
