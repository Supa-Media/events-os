/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { runSeedSeatDefs } from "../migrations/0022_seed_seat_defs";
import { runLinkDonorPeople } from "../migrations/0032_link_donor_people";
import type { Doc, Id } from "../_generated/dataModel";
import { BACKER_UNIT_CENTS } from "@events-os/shared";

/**
 * Territories P5 — donor↔people link, giver marks, CRM filters:
 *   - `linkDonorToPerson` match order (email → phone → name) on donor
 *     create/edit, never duplicating an existing roster row,
 *   - no match → a minimal non-team roster row is created ("Added from
 *     Giving"),
 *   - central-scope donors never link (no chapter roster to link into),
 *   - placeholder/sample roster rows are never matched (or created as one),
 *   - migration 0032 backfills existing unlinked chapter donors and is
 *     idempotent,
 *   - `giverMarks` surfaces only gifted, linked donors as a bare
 *     `{personId, donorId, isBacker}` projection — NO money field on the
 *     wire (owner privacy request) — derives `isBacker` from the same
 *     active-pledge-at/above-`BACKER_UNIT_CENTS` predicate as
 *     `givingPledges.recomputeChapterBackerCount`, and degrades quietly
 *     (never throws) for a caller with no giving access,
 *   - `listDonors`' new status/kind/source/minLifetimeCents filters compose.
 */

/** Seat the caller as development director at central (full giving.manage
 *  at every scope, mirroring `givingPlatform.test.ts`'s helper). */
async function seatDevDirector(s: ChapterSetup): Promise<void> {
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
}

async function devDirectorSetup(): Promise<ChapterSetup> {
  const t = newT();
  await run(t, (ctx) => runSeedSeatDefs(ctx));
  const s = await setupChapter(t);
  await seatDevDirector(s);
  return s;
}

/** Insert a roster person directly (bypassing `people.create`'s mutation, so
 *  tests can set fields — `isPlaceholder`/`isSamplePerson` — that mutation
 *  doesn't expose). */
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

async function donorRow(s: ChapterSetup, donorId: Id<"donors">) {
  return run(s.t, (ctx) => ctx.db.get(donorId));
}

/** The chapter roster, unfiltered (includes placeholders/sample rows) —
 *  for asserting no duplicate/unwanted rows were created. */
async function allPeopleInChapter(s: ChapterSetup): Promise<Doc<"people">[]> {
  return run(s.t, (ctx) =>
    ctx.db
      .query("people")
      .withIndex("by_chapter", (q) => q.eq("chapterId", s.chapterId))
      .collect(),
  );
}

// ── link-on-create ───────────────────────────────────────────────────────────

describe("linkDonorToPerson via upsertDonor (create)", () => {
  test("email match links to the existing roster person (no duplicate)", async () => {
    const s = await devDirectorSetup();
    const personId = await seedPerson(s, {
      name: "Abby Roster",
      email: "abby@example.com",
    });

    const donorId = (await s.as.mutation(api.givingPlatform.upsertDonor, {
      scope: s.chapterId,
      name: "Abby Donor",
      email: "Abby@Example.com", // different case — normalized both sides
    })) as Id<"donors">;

    const donor = await donorRow(s, donorId);
    expect(donor?.personId).toBe(personId);

    // No duplicate row was created for the match.
    const everyone = await allPeopleInChapter(s);
    const abbys = everyone.filter((p) => p.email === "abby@example.com");
    expect(abbys).toHaveLength(1);
  });

  test("phone match links when no email matches", async () => {
    const s = await devDirectorSetup();
    const personId = await seedPerson(s, {
      name: "Phil Roster",
      phone: "555-123-4567",
    });

    const donorId = (await s.as.mutation(api.givingPlatform.upsertDonor, {
      scope: s.chapterId,
      name: "Phil Donor",
      phone: "555-123-4567",
    })) as Id<"donors">;

    const donor = await donorRow(s, donorId);
    expect(donor?.personId).toBe(personId);

    const everyone = await allPeopleInChapter(s);
    expect(everyone.filter((p) => p.phone === "555-123-4567")).toHaveLength(1);
  });

  test("exact trimmed name is the last-resort match", async () => {
    const s = await devDirectorSetup();
    const personId = await seedPerson(s, { name: "Nora Nameonly" });

    const donorId = (await s.as.mutation(api.givingPlatform.upsertDonor, {
      scope: s.chapterId,
      name: "Nora Nameonly",
    })) as Id<"donors">;

    const donor = await donorRow(s, donorId);
    expect(donor?.personId).toBe(personId);
  });

  test("no match creates a minimal non-team roster row", async () => {
    const s = await devDirectorSetup();

    const donorId = (await s.as.mutation(api.givingPlatform.upsertDonor, {
      scope: s.chapterId,
      name: "Brand New Giver",
      email: "bng@example.com",
    })) as Id<"donors">;

    const donor = await donorRow(s, donorId);
    expect(donor?.personId).toBeDefined();

    const created = await run(s.t, (ctx) => ctx.db.get(donor!.personId!));
    expect(created?.name).toBe("Brand New Giver");
    expect(created?.email).toBe("bng@example.com");
    expect(created?.isTeamMember).toBe(false);
    expect(created?.notes).toBe("Added from Giving");
    // Person-centric audiences Phase 1 — stamped at INSERT time, not just by
    // the one-time 0038 backfill migration.
    expect(created?.isContactOnly).toBe(true);
  });

  test("central-scope donors are never linked", async () => {
    const s = await devDirectorSetup();

    const donorId = (await s.as.mutation(api.givingPlatform.upsertDonor, {
      scope: "central",
      name: "Central Only Donor",
      email: "central@example.com",
    })) as Id<"donors">;

    const donor = await donorRow(s, donorId);
    expect(donor?.personId).toBeUndefined();
  });

  test("placeholder and sample roster rows are never matched (a fresh row is made instead)", async () => {
    const s = await devDirectorSetup();
    const placeholderId = await seedPerson(s, {
      name: "Placeholder Crew",
      email: "shared@example.com",
      isPlaceholder: true,
    });
    const sampleId = await seedPerson(s, {
      name: "Sample Person",
      phone: "555-999-0000",
      isSamplePerson: true,
    });

    const emailDonorId = (await s.as.mutation(api.givingPlatform.upsertDonor, {
      scope: s.chapterId,
      name: "Real Giver One",
      email: "shared@example.com",
    })) as Id<"donors">;
    const phoneDonorId = (await s.as.mutation(api.givingPlatform.upsertDonor, {
      scope: s.chapterId,
      name: "Real Giver Two",
      phone: "555-999-0000",
    })) as Id<"donors">;

    const emailDonor = await donorRow(s, emailDonorId);
    const phoneDonor = await donorRow(s, phoneDonorId);
    expect(emailDonor?.personId).not.toBe(placeholderId);
    expect(phoneDonor?.personId).not.toBe(sampleId);
    expect(emailDonor?.personId).toBeDefined();
    expect(phoneDonor?.personId).toBeDefined();
  });

  test("an edited, still-unlinked donor retries the link (backfill on phone edit)", async () => {
    const s = await devDirectorSetup();
    const personId = await seedPerson(s, {
      name: "Later Match",
      phone: "555-222-3333",
    });

    // A brand-new create always resolves a link immediately (match or a fresh
    // roster row) — the "still unlinked, retry on edit" path is really for
    // donors that predate `personId` (pre-P5 data / mid-migration). Simulate
    // that directly, the same shape migration 0032 backfills.
    const donorId = await run(s.t, (ctx) =>
      ctx.db.insert("donors", {
        scope: s.chapterId,
        kind: "individual",
        name: "Later Match Donor",
        status: "prospect",
        lifetimeCents: 0,
        giftCount: 0,
        createdAt: Date.now(),
      }),
    );
    expect((await donorRow(s, donorId))?.personId).toBeUndefined();

    // Editing in the matching phone retries the link.
    await s.as.mutation(api.givingPlatform.upsertDonor, {
      scope: s.chapterId,
      donorId,
      name: "Later Match Donor",
      phone: "555-222-3333",
    });
    expect((await donorRow(s, donorId))?.personId).toBe(personId);
  });
});

// ── migration 0032 ────────────────────────────────────────────────────────────

describe("migration 0032 — link donor people backfill", () => {
  test("links existing unlinked chapter donors and is idempotent", async () => {
    const s = await devDirectorSetup();
    const personId = await seedPerson(s, {
      name: "Backfill Match",
      email: "backfill@example.com",
    });

    // Insert a donor directly (bypassing the write-path link) to simulate a
    // pre-existing row from before `personId` shipped.
    const donorId = await run(s.t, (ctx) =>
      ctx.db.insert("donors", {
        scope: s.chapterId,
        kind: "individual",
        name: "Backfill Donor",
        email: "backfill@example.com",
        status: "prospect",
        lifetimeCents: 0,
        giftCount: 0,
        createdAt: Date.now(),
      }),
    );
    const centralDonorId = await run(s.t, (ctx) =>
      ctx.db.insert("donors", {
        scope: "central",
        kind: "individual",
        name: "Central Backfill Donor",
        status: "prospect",
        lifetimeCents: 0,
        giftCount: 0,
        createdAt: Date.now(),
      }),
    );

    const first = await run(s.t, (ctx) => runLinkDonorPeople(ctx));
    expect(first.linked).toBeGreaterThanOrEqual(1);
    expect(first.skippedCentral).toBeGreaterThanOrEqual(1);

    expect((await donorRow(s, donorId))?.personId).toBe(personId);
    expect((await donorRow(s, centralDonorId))?.personId).toBeUndefined();

    // No duplicate roster row from the backfill.
    const everyone = await allPeopleInChapter(s);
    expect(
      everyone.filter((p) => p.email === "backfill@example.com"),
    ).toHaveLength(1);

    // Re-run: already-linked donors are skipped, nothing changes.
    const second = await run(s.t, (ctx) => runLinkDonorPeople(ctx));
    expect(second.linked).toBe(0);
    expect(second.alreadyLinked).toBeGreaterThanOrEqual(1);
    expect((await donorRow(s, donorId))?.personId).toBe(personId);
  });
});

// ── giverMarks ─────────────────────────────────────────────────────────────────

describe("giverMarks", () => {
  test("returns only linked donors who have actually given, with no money field on the wire", async () => {
    const s = await devDirectorSetup();

    // A giver: linked + gifted.
    const giverDonorId = (await s.as.mutation(api.givingPlatform.upsertDonor, {
      scope: s.chapterId,
      name: "Gifted Giver",
      email: "gifted@example.com",
    })) as Id<"donors">;
    await s.as.mutation(api.givingPlatform.recordGift, {
      donorId: giverDonorId,
      amountCents: 5000,
      method: "cash",
    });

    // A prospect: linked, but has never given — must NOT appear.
    await s.as.mutation(api.givingPlatform.upsertDonor, {
      scope: s.chapterId,
      name: "Never Gave",
      email: "nevergave@example.com",
    });

    const marks = await s.as.query(api.givingPlatform.giverMarks, {
      chapterId: s.chapterId,
    });
    expect(marks).toHaveLength(1);
    expect(marks[0].donorId).toBe(giverDonorId);
    expect(marks[0].isBacker).toBe(false);
    // Owner privacy request: the wire projection carries no money fields.
    expect(marks[0]).not.toHaveProperty("lifetimeCents");
    expect(marks[0]).not.toHaveProperty("lastGiftAt");
    expect(marks[0]).not.toHaveProperty("status");
    expect(Object.keys(marks[0]).sort()).toEqual(
      ["donorId", "isBacker", "personId"].sort(),
    );
  });

  test("isBacker is true for a donor with an active pledge at/above BACKER_UNIT_CENTS, false otherwise", async () => {
    const s = await devDirectorSetup();

    // A backer: gifted + an ACTIVE pledge at the backer unit.
    const backerDonorId = (await s.as.mutation(api.givingPlatform.upsertDonor, {
      scope: s.chapterId,
      name: "Backer Donor",
      email: "backer@example.com",
    })) as Id<"donors">;
    await s.as.mutation(api.givingPlatform.recordGift, {
      donorId: backerDonorId,
      amountCents: 1000,
      method: "cash",
    });
    await run(s.t, (ctx) =>
      ctx.db.insert("pledges", {
        donorId: backerDonorId,
        scope: s.chapterId,
        amountCents: BACKER_UNIT_CENTS,
        status: "active",
        origin: "stripe",
        createdAt: Date.now(),
      }),
    );

    // A giver with a pledge BELOW the backer unit — still a giver, not a backer.
    const smallPledgeDonorId = (await s.as.mutation(
      api.givingPlatform.upsertDonor,
      { scope: s.chapterId, name: "Small Pledge Donor", email: "small@example.com" },
    )) as Id<"donors">;
    await s.as.mutation(api.givingPlatform.recordGift, {
      donorId: smallPledgeDonorId,
      amountCents: 1000,
      method: "cash",
    });
    await run(s.t, (ctx) =>
      ctx.db.insert("pledges", {
        donorId: smallPledgeDonorId,
        scope: s.chapterId,
        amountCents: BACKER_UNIT_CENTS - 1000,
        status: "active",
        origin: "stripe",
        createdAt: Date.now(),
      }),
    );

    // A giver with a qualifying pledge that is CANCELED — not a backer.
    const canceledPledgeDonorId = (await s.as.mutation(
      api.givingPlatform.upsertDonor,
      {
        scope: s.chapterId,
        name: "Canceled Pledge Donor",
        email: "canceled@example.com",
      },
    )) as Id<"donors">;
    await s.as.mutation(api.givingPlatform.recordGift, {
      donorId: canceledPledgeDonorId,
      amountCents: 1000,
      method: "cash",
    });
    await run(s.t, (ctx) =>
      ctx.db.insert("pledges", {
        donorId: canceledPledgeDonorId,
        scope: s.chapterId,
        amountCents: BACKER_UNIT_CENTS,
        status: "canceled",
        origin: "stripe",
        createdAt: Date.now(),
        canceledAt: Date.now(),
      }),
    );

    // A plain giver with no pledge at all — not a backer.
    const plainGiverDonorId = (await s.as.mutation(
      api.givingPlatform.upsertDonor,
      { scope: s.chapterId, name: "Plain Giver", email: "plain@example.com" },
    )) as Id<"donors">;
    await s.as.mutation(api.givingPlatform.recordGift, {
      donorId: plainGiverDonorId,
      amountCents: 1000,
      method: "cash",
    });

    const marks = await s.as.query(api.givingPlatform.giverMarks, {
      chapterId: s.chapterId,
    });
    const byDonor = new Map(marks.map((m) => [m.donorId, m.isBacker]));
    expect(byDonor.get(backerDonorId)).toBe(true);
    expect(byDonor.get(smallPledgeDonorId)).toBe(false);
    expect(byDonor.get(canceledPledgeDonorId)).toBe(false);
    expect(byDonor.get(plainGiverDonorId)).toBe(false);
  });

  test("degrades quietly (empty array, no throw) for a caller with no giving access", async () => {
    const s = await devDirectorSetup();
    const donorId = (await s.as.mutation(api.givingPlatform.upsertDonor, {
      scope: s.chapterId,
      name: "Some Giver",
      email: "someone@example.com",
    })) as Id<"donors">;
    await s.as.mutation(api.givingPlatform.recordGift, {
      donorId,
      amountCents: 2500,
      method: "check",
    });

    // An authenticated caller with no giving seat anywhere.
    const outsiderUserId = await run(s.t, (ctx) =>
      ctx.db.insert("users", { email: "outsider@publicworship.life" }),
    );
    const outsider = s.t.withIdentity({
      subject: `${outsiderUserId}|session`,
      issuer: "test",
    });

    await expect(
      outsider.query(api.givingPlatform.giverMarks, { chapterId: s.chapterId }),
    ).resolves.toEqual([]);
  });
});

// ── listDonors filters ────────────────────────────────────────────────────────

describe("listDonors filters", () => {
  test("status/kind/source/minLifetimeCents compose within the bounded window", async () => {
    const s = await devDirectorSetup();

    const activeChurch = (await s.as.mutation(api.givingPlatform.upsertDonor, {
      scope: "central",
      name: "First Church",
      kind: "church",
      source: "manual",
    })) as Id<"donors">;
    await s.as.mutation(api.givingPlatform.recordGift, {
      donorId: activeChurch,
      amountCents: 150_00,
      method: "check",
    });

    const activeIndividualSmall = (await s.as.mutation(
      api.givingPlatform.upsertDonor,
      { scope: "central", name: "Small Giver", kind: "individual", source: "manual" },
    )) as Id<"donors">;
    await s.as.mutation(api.givingPlatform.recordGift, {
      donorId: activeIndividualSmall,
      amountCents: 10_00,
      method: "cash",
    });

    await s.as.mutation(api.givingPlatform.upsertDonor, {
      scope: "central",
      name: "Untouched Prospect",
      kind: "individual",
      source: "map",
    });

    // status filter: only prospects.
    const prospects = await s.as.query(api.givingPlatform.listDonors, {
      scope: "central",
      status: "prospect",
    });
    expect(prospects.map((d) => d.name)).toEqual(["Untouched Prospect"]);

    // kind filter: only the church.
    const churches = await s.as.query(api.givingPlatform.listDonors, {
      scope: "central",
      kind: "church",
    });
    expect(churches.map((d) => d._id)).toEqual([activeChurch]);

    // source filter.
    const mapSourced = await s.as.query(api.givingPlatform.listDonors, {
      scope: "central",
      source: "map",
    });
    expect(mapSourced.map((d) => d.name)).toEqual(["Untouched Prospect"]);

    // minLifetimeCents band ($100+ excludes the small giver + the prospect).
    const bigGivers = await s.as.query(api.givingPlatform.listDonors, {
      scope: "central",
      minLifetimeCents: 100_00,
    });
    expect(bigGivers.map((d) => d._id)).toEqual([activeChurch]);

    // Combination: active + individual excludes the church (not individual)
    // and the untouched prospect (not active).
    const activeIndividuals = await s.as.query(api.givingPlatform.listDonors, {
      scope: "central",
      status: "active",
      kind: "individual",
    });
    expect(activeIndividuals.map((d) => d._id)).toEqual([activeIndividualSmall]);
  });
});
