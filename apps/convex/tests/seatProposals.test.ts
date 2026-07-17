import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { runSeedSeatDefs } from "../migrations/0022_seed_seat_defs";

/**
 * `seatProposals.ts` — two-party seat-change proposals.
 *
 * Covers: below-your-seat validation (descendant OK, sibling/above rejected,
 * cross-chapter via the central rollup bridge), the ED-subject rejection,
 * duplicate-pending rejection, decline/cancel, and decider-eligibility
 * resolution (above the proposer, never the proposer, multi-holder parent —
 * any holder decides, vacant ancestors skipped upward). Decider eligibility
 * is exercised through `decline` (NOT `approve` — see the file-level BLOCKED
 * doc comment in `seatProposals.ts`: `approve`'s actual seat-change execution
 * needs a small auth-free export from `seats.ts` that doesn't exist yet, and
 * this suite must not duplicate `seats.ts`'s validated assign/unassign logic
 * to fake it). `decline` shares the exact same `resolveEligibleDeciders`
 * helper `approve` will use once wired, so this is full coverage of the
 * authorization logic itself, just not of seat-change execution.
 */

// ── Setup helpers ────────────────────────────────────────────────────────────

/** A seat-defs-seeded chapter, with a caller on the allowed domain (no
 *  superuser needed — `seatProposals` mutations gate on `requireAccess`). */
async function baseSetup(opts?: { chapterName?: string }): Promise<ChapterSetup> {
  const t = newT();
  await run(t, (ctx) => runSeedSeatDefs(ctx));
  return setupChapter(t, opts);
}

/** Insert a bare `users` row and return a client authenticated as them
 *  (mirrors `seats.test.ts`'s `signInAs`). */
async function signInAs(t: ReturnType<typeof newT>, email: string) {
  const userId = await run(t, (ctx) => ctx.db.insert("users", { email }));
  const as = t.withIdentity({ subject: `${userId}|session`, issuer: "test" });
  return { as, userId: userId as Id<"users"> };
}

/** A full "actor": a signed-in client + their own roster (`people`) row,
 *  tied to a fresh `users` row. `chapterId` is just the roster row's home
 *  chapter — unrelated to which seat SCOPE they end up holding. */
async function personActor(
  s: ChapterSetup,
  chapterId: Id<"chapters">,
  name: string,
  email: string,
) {
  const { as, userId } = await signInAs(s.t, email);
  const personId = await run(s.t, (ctx) =>
    ctx.db.insert("people", { chapterId, name, userId, createdAt: Date.now() }),
  );
  return { as, userId, personId };
}

/** Insert a bare roster person (no linked user) and return its id. */
async function makePerson(
  s: ChapterSetup,
  chapterId: Id<"chapters">,
  name: string,
): Promise<Id<"people">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("people", { chapterId, name, createdAt: Date.now() }),
  );
}

/** Insert a placeholder roster person and return its id. */
async function makePlaceholderPerson(
  s: ChapterSetup,
  chapterId: Id<"chapters">,
  name: string,
): Promise<Id<"people">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId,
      name,
      isPlaceholder: true,
      createdAt: Date.now(),
    }),
  );
}

/** Insert a second chapter and return its id. */
async function makeChapter(s: ChapterSetup, name: string): Promise<Id<"chapters">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("chapters", { name, isActive: true, createdAt: Date.now() }),
  );
}

/** The seatDef row seeded for a template `slug`. */
async function defBySlug(s: ChapterSetup, slug: string) {
  const def = await run(s.t, (ctx) =>
    ctx.db
      .query("seatDefs")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .unique(),
  );
  if (!def) throw new Error(`${slug} not seeded`);
  return def;
}

/** Insert a RUNTIME (non-template) seatDef row directly — exercises the
 *  "walk the live `seatDefs` rows, not the static template" requirement. */
async function insertSeatDef(
  s: ChapterSetup,
  opts: {
    slug: string;
    chart: "central" | "chapter";
    parentSlug: string;
    maxHolders: number;
  },
): Promise<Id<"seatDefs">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("seatDefs", {
      slug: opts.slug,
      title: opts.slug,
      chart: opts.chart,
      parentSlug: opts.parentSlug,
      maxHolders: opts.maxHolders,
      duties: [],
      capabilities: [],
      sortOrder: 999,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
}

/** Directly seat `personId` at (scope, defId) — bypasses `seats.assignSeat`
 *  (super-admin gated, not under test here) the same way `seats.test.ts`
 *  seeds occupancy directly for its read-query tests. */
async function seat(
  s: ChapterSetup,
  defId: Id<"seatDefs">,
  scope: Id<"chapters"> | "central",
  personId: Id<"people">,
) {
  await run(s.t, (ctx) =>
    ctx.db.insert("seatAssignments", { seatDefId: defId, scope, personId, createdAt: Date.now() }),
  );
}

// ── propose — below-your-seat validation ────────────────────────────────────

describe("seatProposals.propose — below-your-seat validation", () => {
  test("a holder may propose for a strict descendant of their own seat", async () => {
    const s = await baseSetup();
    const cdDef = await defBySlug(s, "chapter_director");
    const musicLeadDef = await defBySlug(s, "music_lead");
    const { as, personId: cdPersonId } = await personActor(s, s.chapterId, "CD", "cd@publicworship.life");
    await seat(s, cdDef._id, s.chapterId, cdPersonId);
    const subject = await makePerson(s, s.chapterId, "Subject");

    const proposalId = await as.mutation(api.seatProposals.propose, {
      seatDefId: musicLeadDef._id,
      scope: s.chapterId,
      action: "fill",
      subjectPersonId: subject,
    });
    expect(proposalId).toBeDefined();

    const mine = await as.query(api.seatProposals.myProposals, {});
    expect(mine).toHaveLength(1);
    expect(mine[0]!.proposedByPersonId).toBe(cdPersonId);
    expect(mine[0]!.status).toBe("pending");
  });

  test("a sibling seat is rejected (not a descendant)", async () => {
    const s = await baseSetup();
    const ddDef = await defBySlug(s, "development_director");
    const mdDef = await defBySlug(s, "music_director"); // sibling: both children of executive_director
    const { as, personId } = await personActor(s, s.chapterId, "DD", "dd@publicworship.life");
    await seat(s, ddDef._id, "central", personId);
    const subject = await makePerson(s, s.chapterId, "Subject");

    await expect(
      as.mutation(api.seatProposals.propose, {
        seatDefId: mdDef._id,
        scope: "central",
        action: "fill",
        subjectPersonId: subject,
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("your own PARENT seat is rejected (above you, not below)", async () => {
    const s = await baseSetup();
    const treasurerDef = await defBySlug(s, "treasurer");
    const cdDef = await defBySlug(s, "chapter_director");
    const { as, personId } = await personActor(s, s.chapterId, "Treasurer", "treas@publicworship.life");
    await seat(s, treasurerDef._id, s.chapterId, personId);
    const subject = await makePerson(s, s.chapterId, "Subject");

    await expect(
      as.mutation(api.seatProposals.propose, {
        seatDefId: cdDef._id,
        scope: s.chapterId,
        action: "fill",
        subjectPersonId: subject,
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("a central holder can propose into a chapter via the CHAPTER_ROLLUP_PARENT bridge", async () => {
    const s = await baseSetup();
    const expansionDef = await defBySlug(s, "expansion_director");
    const treasurerDef = await defBySlug(s, "treasurer");
    const { as, personId } = await personActor(s, s.chapterId, "Expansion", "expansion@publicworship.life");
    await seat(s, expansionDef._id, "central", personId);
    const chapterB = await makeChapter(s, "Boston");
    const subject = await makePerson(s, chapterB, "Subject");

    const proposalId = await as.mutation(api.seatProposals.propose, {
      seatDefId: treasurerDef._id,
      scope: chapterB,
      action: "fill",
      subjectPersonId: subject,
    });

    const mine = await as.query(api.seatProposals.myProposals, {});
    expect(mine.find((p) => p.proposalId === proposalId)?.proposedByPersonId).toBe(personId);
  });

  test("a caller with no qualifying seat is rejected", async () => {
    const s = await baseSetup();
    const musicLeadDef = await defBySlug(s, "music_lead");
    const { as } = await personActor(s, s.chapterId, "Nobody", "nobody@publicworship.life");
    const subject = await makePerson(s, s.chapterId, "Subject");

    await expect(
      as.mutation(api.seatProposals.propose, {
        seatDefId: musicLeadDef._id,
        scope: s.chapterId,
        action: "fill",
        subjectPersonId: subject,
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });
});

// ── propose — structural validation ─────────────────────────────────────────

describe("seatProposals.propose — structural validation", () => {
  test("rejects the ED seat as a subject (nobody is above it)", async () => {
    const s = await baseSetup();
    const edDef = await defBySlug(s, "executive_director");
    const subject = await makePerson(s, s.chapterId, "Subject");
    // Even an unrelated caller with no qualifying seat gets the specific
    // NO_APPROVER rejection, not the generic below-your-seat FORBIDDEN — the
    // check runs before the caller's own holdings are even inspected.
    await expect(
      s.as.mutation(api.seatProposals.propose, {
        seatDefId: edDef._id,
        scope: "central",
        action: "fill",
        subjectPersonId: subject,
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("rejects a derived seat (chapter_directors)", async () => {
    const s = await baseSetup();
    const derivedDef = await defBySlug(s, "chapter_directors");
    const subject = await makePerson(s, s.chapterId, "Subject");
    await expect(
      s.as.mutation(api.seatProposals.propose, {
        seatDefId: derivedDef._id,
        scope: "central",
        action: "fill",
        subjectPersonId: subject,
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("rejects a chart/scope mismatch", async () => {
    const s = await baseSetup();
    const edDef = await defBySlug(s, "executive_director");
    const subject = await makePerson(s, s.chapterId, "Subject");
    await expect(
      s.as.mutation(api.seatProposals.propose, {
        seatDefId: edDef._id,
        scope: s.chapterId,
        action: "fill",
        subjectPersonId: subject,
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("rejects a nonexistent chapter scope", async () => {
    const s = await baseSetup();
    const treasurerDef = await defBySlug(s, "treasurer");
    const subject = await makePerson(s, s.chapterId, "Subject");
    const staleChapterId = await run(s.t, async (ctx) => {
      const id = await ctx.db.insert("chapters", { name: "Gone", isActive: true, createdAt: Date.now() });
      await ctx.db.delete(id);
      return id;
    });
    await expect(
      s.as.mutation(api.seatProposals.propose, {
        seatDefId: treasurerDef._id,
        scope: staleChapterId,
        action: "fill",
        subjectPersonId: subject,
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("rejects a placeholder subject", async () => {
    const s = await baseSetup();
    const cdDef = await defBySlug(s, "chapter_director");
    const musicLeadDef = await defBySlug(s, "music_lead");
    const { as, personId } = await personActor(s, s.chapterId, "CD", "cd2@publicworship.life");
    await seat(s, cdDef._id, s.chapterId, personId);
    const placeholder = await makePlaceholderPerson(s, s.chapterId, "Ghost");

    await expect(
      as.mutation(api.seatProposals.propose, {
        seatDefId: musicLeadDef._id,
        scope: s.chapterId,
        action: "fill",
        subjectPersonId: placeholder,
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("'vacate' rejects a subject who doesn't currently hold the seat", async () => {
    const s = await baseSetup();
    const cdDef = await defBySlug(s, "chapter_director");
    const musicLeadDef = await defBySlug(s, "music_lead");
    const { as, personId } = await personActor(s, s.chapterId, "CD", "cd3@publicworship.life");
    await seat(s, cdDef._id, s.chapterId, personId);
    const notAHolder = await makePerson(s, s.chapterId, "NotAHolder");

    await expect(
      as.mutation(api.seatProposals.propose, {
        seatDefId: musicLeadDef._id,
        scope: s.chapterId,
        action: "vacate",
        subjectPersonId: notAHolder,
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("'vacate' succeeds structurally for the seat's actual current holder", async () => {
    const s = await baseSetup();
    const cdDef = await defBySlug(s, "chapter_director");
    const musicLeadDef = await defBySlug(s, "music_lead");
    const { as, personId } = await personActor(s, s.chapterId, "CD", "cd4@publicworship.life");
    await seat(s, cdDef._id, s.chapterId, personId);
    const holder = await makePerson(s, s.chapterId, "Holder");
    await seat(s, musicLeadDef._id, s.chapterId, holder);

    const proposalId = await as.mutation(api.seatProposals.propose, {
      seatDefId: musicLeadDef._id,
      scope: s.chapterId,
      action: "vacate",
      subjectPersonId: holder,
    });
    expect(proposalId).toBeDefined();
  });

  test("rejects a duplicate pending proposal for the exact same (seat, scope, action, subject)", async () => {
    const s = await baseSetup();
    const cdDef = await defBySlug(s, "chapter_director");
    const musicLeadDef = await defBySlug(s, "music_lead");
    const { as, personId } = await personActor(s, s.chapterId, "CD", "cd5@publicworship.life");
    await seat(s, cdDef._id, s.chapterId, personId);
    const subject = await makePerson(s, s.chapterId, "Subject");

    await as.mutation(api.seatProposals.propose, {
      seatDefId: musicLeadDef._id,
      scope: s.chapterId,
      action: "fill",
      subjectPersonId: subject,
    });
    await expect(
      as.mutation(api.seatProposals.propose, {
        seatDefId: musicLeadDef._id,
        scope: s.chapterId,
        action: "fill",
        subjectPersonId: subject,
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });
});

// ── decline — decider-eligibility resolution (shared with `approve`) ───────

describe("seatProposals.decline — decider eligibility", () => {
  test("a holder of the proposer's occupied parent seat may decline", async () => {
    const s = await baseSetup();
    const cdDef = await defBySlug(s, "chapter_director");
    const musicLeadDef = await defBySlug(s, "music_lead");
    const { as: cdAs, personId: cdPersonId } = await personActor(s, s.chapterId, "CD", "cd6@publicworship.life");
    await seat(s, cdDef._id, s.chapterId, cdPersonId);
    const { as: leaderAs, personId: leaderPersonId } = await personActor(
      s,
      s.chapterId,
      "MusicLead",
      "musiclead@publicworship.life",
    );
    await seat(s, musicLeadDef._id, s.chapterId, leaderPersonId);
    const subject = await makePerson(s, s.chapterId, "Subject");

    const proposalId = await leaderAs.mutation(api.seatProposals.propose, {
      seatDefId: (await defBySlug(s, "vocal_lead"))._id,
      scope: s.chapterId,
      action: "fill",
      subjectPersonId: subject,
    });

    await cdAs.mutation(api.seatProposals.decline, { proposalId });
    const mine = await leaderAs.query(api.seatProposals.myProposals, {});
    const decided = mine.find((p) => p.proposalId === proposalId)!;
    expect(decided.status).toBe("declined");
    expect(decided.decidedByPersonId).toBe(cdPersonId);
  });

  test("the proposer can never decide their own proposal", async () => {
    const s = await baseSetup();
    const cdDef = await defBySlug(s, "chapter_director");
    const musicLeadDef = await defBySlug(s, "music_lead");
    const { as, personId } = await personActor(s, s.chapterId, "CD", "cd7@publicworship.life");
    await seat(s, cdDef._id, s.chapterId, personId);
    const subject = await makePerson(s, s.chapterId, "Subject");

    const proposalId = await as.mutation(api.seatProposals.propose, {
      seatDefId: musicLeadDef._id,
      scope: s.chapterId,
      action: "fill",
      subjectPersonId: subject,
    });
    await expect(as.mutation(api.seatProposals.decline, { proposalId })).rejects.toBeInstanceOf(
      ConvexError,
    );
  });

  test("someone NOT above the proposer is rejected", async () => {
    const s = await baseSetup();
    const cdDef = await defBySlug(s, "chapter_director");
    const musicLeadDef = await defBySlug(s, "music_lead");
    const { as: cdAs, personId: cdPersonId } = await personActor(s, s.chapterId, "CD", "cd8@publicworship.life");
    await seat(s, cdDef._id, s.chapterId, cdPersonId);
    const subject = await makePerson(s, s.chapterId, "Subject");
    const proposalId = await cdAs.mutation(api.seatProposals.propose, {
      seatDefId: musicLeadDef._id,
      scope: s.chapterId,
      action: "fill",
      subjectPersonId: subject,
    });

    // An unrelated bystander, holding a seat elsewhere in the tree, is not
    // "above" this proposer.
    const treasurerDef = await defBySlug(s, "treasurer");
    const { as: bystanderAs, personId: bystanderPersonId } = await personActor(
      s,
      s.chapterId,
      "Bystander",
      "bystander@publicworship.life",
    );
    await seat(s, treasurerDef._id, s.chapterId, bystanderPersonId);

    await expect(
      bystanderAs.mutation(api.seatProposals.decline, { proposalId }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("vacant ancestors are skipped upward until an occupied one is found", async () => {
    const s = await baseSetup();
    const cdDef = await defBySlug(s, "chapter_director");
    const regionalLead = await insertSeatDef(s, {
      slug: "regional_lead_vacant_test",
      chart: "chapter",
      parentSlug: "chapter_director",
      maxHolders: 5,
    });
    const regionalScout = await insertSeatDef(s, {
      slug: "regional_scout_vacant_test",
      chart: "chapter",
      parentSlug: "regional_lead_vacant_test",
      maxHolders: 1,
    });
    const regionalVolunteer = await insertSeatDef(s, {
      slug: "regional_volunteer_vacant_test",
      chart: "chapter",
      parentSlug: "regional_scout_vacant_test",
      maxHolders: 1,
    });
    // regional_lead is left VACANT — nobody seated there.
    const { as: cdAs, personId: cdPersonId } = await personActor(s, s.chapterId, "CD", "cd9@publicworship.life");
    await seat(s, cdDef._id, s.chapterId, cdPersonId);
    const { as: scoutAs, personId: scoutPersonId } = await personActor(
      s,
      s.chapterId,
      "Scout",
      "scout@publicworship.life",
    );
    await seat(s, regionalScout, s.chapterId, scoutPersonId);
    const subject = await makePerson(s, s.chapterId, "Subject");

    const proposalId = await scoutAs.mutation(api.seatProposals.propose, {
      seatDefId: regionalVolunteer,
      scope: s.chapterId,
      action: "fill",
      subjectPersonId: subject,
    });

    // regional_lead has no holder — resolution must climb past it to
    // chapter_director, whose holder can decide.
    await cdAs.mutation(api.seatProposals.decline, { proposalId });
    const mine = await scoutAs.query(api.seatProposals.myProposals, {});
    expect(mine.find((p) => p.proposalId === proposalId)?.status).toBe("declined");
    void regionalLead;
  });

  test("a multi-holder parent seat: ANY of its holders may decide", async () => {
    const s = await baseSetup();
    const cdDef = await defBySlug(s, "chapter_director");
    await insertSeatDef(s, {
      slug: "regional_lead_multi_test",
      chart: "chapter",
      parentSlug: "chapter_director",
      maxHolders: 5,
    });
    const regionalLeadDef = await defBySlugRuntime(s, "regional_lead_multi_test");
    const regionalScout = await insertSeatDef(s, {
      slug: "regional_scout_multi_test",
      chart: "chapter",
      parentSlug: "regional_lead_multi_test",
      maxHolders: 1,
    });
    const regionalVolunteerA = await insertSeatDef(s, {
      slug: "regional_volunteer_multi_test_a",
      chart: "chapter",
      parentSlug: "regional_scout_multi_test",
      maxHolders: 1,
    });
    const regionalVolunteerB = await insertSeatDef(s, {
      slug: "regional_volunteer_multi_test_b",
      chart: "chapter",
      parentSlug: "regional_scout_multi_test",
      maxHolders: 1,
    });
    void cdDef;

    const { as: leadAAs, personId: leadHolderA } = await personActor(s, s.chapterId, "LeadA", "leada@publicworship.life");
    const { as: leadBAs, personId: leadHolderB } = await personActor(s, s.chapterId, "LeadB", "leadb@publicworship.life");
    await seat(s, regionalLeadDef._id, s.chapterId, leadHolderA);
    await seat(s, regionalLeadDef._id, s.chapterId, leadHolderB);

    const { as: scoutAs, personId: scoutPersonId } = await personActor(
      s,
      s.chapterId,
      "Scout2",
      "scout2@publicworship.life",
    );
    await seat(s, regionalScout, s.chapterId, scoutPersonId);
    const subjectA = await makePerson(s, s.chapterId, "SubjectA");
    const subjectB = await makePerson(s, s.chapterId, "SubjectB");

    const proposalA = await scoutAs.mutation(api.seatProposals.propose, {
      seatDefId: regionalVolunteerA,
      scope: s.chapterId,
      action: "fill",
      subjectPersonId: subjectA,
    });
    const proposalB = await scoutAs.mutation(api.seatProposals.propose, {
      seatDefId: regionalVolunteerB,
      scope: s.chapterId,
      action: "fill",
      subjectPersonId: subjectB,
    });

    // Holder A decides proposal A; holder B (a DIFFERENT holder of the same
    // multi-holder parent seat) decides proposal B — both are eligible.
    await leadAAs.mutation(api.seatProposals.decline, { proposalId: proposalA });
    await leadBAs.mutation(api.seatProposals.decline, { proposalId: proposalB });

    const mine = await scoutAs.query(api.seatProposals.myProposals, {});
    expect(mine.find((p) => p.proposalId === proposalA)?.status).toBe("declined");
    expect(mine.find((p) => p.proposalId === proposalB)?.status).toBe("declined");
  });
});

/** The seatDef row for a runtime-inserted slug. */
async function defBySlugRuntime(s: ChapterSetup, slug: string) {
  const def = await run(s.t, (ctx) =>
    ctx.db
      .query("seatDefs")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .unique(),
  );
  if (!def) throw new Error(`${slug} not found`);
  return def;
}

// ── decline / cancel — lifecycle ────────────────────────────────────────────

describe("seatProposals.decline / cancel — lifecycle", () => {
  test("decline rejects a proposal that's already been decided", async () => {
    const s = await baseSetup();
    const cdDef = await defBySlug(s, "chapter_director");
    const musicLeadDef = await defBySlug(s, "music_lead");
    const { as, personId } = await personActor(s, s.chapterId, "CD", "cd10@publicworship.life");
    await seat(s, cdDef._id, s.chapterId, personId);
    const subject = await makePerson(s, s.chapterId, "Subject");
    const proposalId = await as.mutation(api.seatProposals.propose, {
      seatDefId: musicLeadDef._id,
      scope: s.chapterId,
      action: "fill",
      subjectPersonId: subject,
    });
    await as.mutation(api.seatProposals.cancel, { proposalId });

    await expect(as.mutation(api.seatProposals.decline, { proposalId })).rejects.toBeInstanceOf(
      ConvexError,
    );
  });

  test("cancel: the proposer can cancel their own pending proposal", async () => {
    const s = await baseSetup();
    const cdDef = await defBySlug(s, "chapter_director");
    const musicLeadDef = await defBySlug(s, "music_lead");
    const { as, personId } = await personActor(s, s.chapterId, "CD", "cd11@publicworship.life");
    await seat(s, cdDef._id, s.chapterId, personId);
    const subject = await makePerson(s, s.chapterId, "Subject");
    const proposalId = await as.mutation(api.seatProposals.propose, {
      seatDefId: musicLeadDef._id,
      scope: s.chapterId,
      action: "fill",
      subjectPersonId: subject,
    });

    await as.mutation(api.seatProposals.cancel, { proposalId });
    const mine = await as.query(api.seatProposals.myProposals, {});
    const decided = mine.find((p) => p.proposalId === proposalId)!;
    expect(decided.status).toBe("cancelled");
    expect(decided.decidedByPersonId).toBe(personId);
  });

  test("cancel rejects a non-proposer, even an eligible decider", async () => {
    const s = await baseSetup();
    const cdDef = await defBySlug(s, "chapter_director");
    const musicLeadDef = await defBySlug(s, "music_lead");
    const { as: cdAs, personId: cdPersonId } = await personActor(s, s.chapterId, "CD", "cd12@publicworship.life");
    await seat(s, cdDef._id, s.chapterId, cdPersonId);
    const { as: leaderAs, personId: leaderPersonId } = await personActor(
      s,
      s.chapterId,
      "MusicLead2",
      "musiclead2@publicworship.life",
    );
    await seat(s, musicLeadDef._id, s.chapterId, leaderPersonId);
    const subject = await makePerson(s, s.chapterId, "Subject");
    const proposalId = await leaderAs.mutation(api.seatProposals.propose, {
      seatDefId: (await defBySlug(s, "vocal_lead"))._id,
      scope: s.chapterId,
      action: "fill",
      subjectPersonId: subject,
    });

    await expect(cdAs.mutation(api.seatProposals.cancel, { proposalId })).rejects.toBeInstanceOf(
      ConvexError,
    );
  });
});

// ── pendingProposals / myProposals — visibility ─────────────────────────────

describe("seatProposals queries — visibility", () => {
  test("pendingProposals shows the proposer their own proposal and the eligible decider theirs — but not a bystander", async () => {
    const s = await baseSetup();
    const cdDef = await defBySlug(s, "chapter_director");
    const musicLeadDef = await defBySlug(s, "music_lead");
    const { as: cdAs, personId: cdPersonId } = await personActor(s, s.chapterId, "CD", "cd13@publicworship.life");
    await seat(s, cdDef._id, s.chapterId, cdPersonId);
    const { as: leaderAs, personId: leaderPersonId } = await personActor(
      s,
      s.chapterId,
      "MusicLead3",
      "musiclead3@publicworship.life",
    );
    await seat(s, musicLeadDef._id, s.chapterId, leaderPersonId);
    const subject = await makePerson(s, s.chapterId, "Subject");
    const proposalId = await leaderAs.mutation(api.seatProposals.propose, {
      seatDefId: (await defBySlug(s, "vocal_lead"))._id,
      scope: s.chapterId,
      action: "fill",
      subjectPersonId: subject,
    });

    const proposerView = await leaderAs.query(api.seatProposals.pendingProposals, {});
    expect(proposerView.map((p) => p.proposalId)).toContain(proposalId);

    const deciderView = await cdAs.query(api.seatProposals.pendingProposals, {});
    expect(deciderView.map((p) => p.proposalId)).toContain(proposalId);

    const treasurerDef = await defBySlug(s, "treasurer");
    const { as: bystanderAs, personId: bystanderPersonId } = await personActor(
      s,
      s.chapterId,
      "Bystander2",
      "bystander2@publicworship.life",
    );
    await seat(s, treasurerDef._id, s.chapterId, bystanderPersonId);
    const bystanderView = await bystanderAs.query(api.seatProposals.pendingProposals, {});
    expect(bystanderView.map((p) => p.proposalId)).not.toContain(proposalId);
  });

  test("pendingProposals({scope}) narrows to that scope only", async () => {
    const s = await baseSetup();
    const expansionDef = await defBySlug(s, "expansion_director");
    const treasurerDef = await defBySlug(s, "treasurer");
    const { as, personId } = await personActor(s, s.chapterId, "Expansion2", "expansion2@publicworship.life");
    await seat(s, expansionDef._id, "central", personId);
    const chapterB = await makeChapter(s, "Denver");
    const subject = await makePerson(s, chapterB, "Subject");
    const proposalId = await as.mutation(api.seatProposals.propose, {
      seatDefId: treasurerDef._id,
      scope: chapterB,
      action: "fill",
      subjectPersonId: subject,
    });

    const scoped = await as.query(api.seatProposals.pendingProposals, { scope: chapterB });
    expect(scoped.map((p) => p.proposalId)).toContain(proposalId);
    const otherScoped = await as.query(api.seatProposals.pendingProposals, { scope: s.chapterId });
    expect(otherScoped.map((p) => p.proposalId)).not.toContain(proposalId);
  });

  test("myProposals returns only proposals the caller made, across every status, newest first", async () => {
    const s = await baseSetup();
    const cdDef = await defBySlug(s, "chapter_director");
    const musicLeadDef = await defBySlug(s, "music_lead");
    const vocalLeadDef = await defBySlug(s, "vocal_lead");
    const { as, personId } = await personActor(s, s.chapterId, "CD2", "cd14@publicworship.life");
    await seat(s, cdDef._id, s.chapterId, personId);
    const subject1 = await makePerson(s, s.chapterId, "Subject1");
    const subject2 = await makePerson(s, s.chapterId, "Subject2");

    const first = await as.mutation(api.seatProposals.propose, {
      seatDefId: musicLeadDef._id,
      scope: s.chapterId,
      action: "fill",
      subjectPersonId: subject1,
    });
    // A tiny real delay so the two proposals don't land in the same
    // millisecond — `createdAt` (Date.now()) is the sort key, mirroring
    // every other `createdAt`-sorted read in this backend (e.g.
    // `seats.mySeatAssignments`), so a same-millisecond tie is a test
    // artifact, not something `myProposals` needs to defend against.
    await new Promise((resolve) => setTimeout(resolve, 2));
    const second = await as.mutation(api.seatProposals.propose, {
      seatDefId: vocalLeadDef._id,
      scope: s.chapterId,
      action: "fill",
      subjectPersonId: subject2,
    });
    await as.mutation(api.seatProposals.cancel, { proposalId: first });

    const mine = await as.query(api.seatProposals.myProposals, {});
    expect(mine).toHaveLength(2);
    expect(mine[0]!.proposalId).toBe(second); // newest first
    expect(mine.find((p) => p.proposalId === first)?.status).toBe("cancelled");
    expect(mine.find((p) => p.proposalId === second)?.status).toBe("pending");
  });
});

// ── access control ───────────────────────────────────────────────────────────

describe("seatProposals access control", () => {
  test("propose/decline/cancel/pendingProposals/myProposals reject a fully signed-out caller", async () => {
    const s = await baseSetup();
    const musicLeadDef = await defBySlug(s, "music_lead");
    const subject = await makePerson(s, s.chapterId, "Subject");

    await expect(
      s.t.mutation(api.seatProposals.propose, {
        seatDefId: musicLeadDef._id,
        scope: s.chapterId,
        action: "fill",
        subjectPersonId: subject,
      }),
    ).rejects.toBeInstanceOf(ConvexError);
    await expect(s.t.query(api.seatProposals.pendingProposals, {})).rejects.toBeInstanceOf(
      ConvexError,
    );
    await expect(s.t.query(api.seatProposals.myProposals, {})).rejects.toBeInstanceOf(ConvexError);
  });

  test("propose/pendingProposals/myProposals reject a signed-in-but-unapproved caller", async () => {
    const s = await baseSetup();
    const { as } = await signInAs(s.t, "not-approved@gmail.com");
    const musicLeadDef = await defBySlug(s, "music_lead");
    const subject = await makePerson(s, s.chapterId, "Subject");

    await expect(
      as.mutation(api.seatProposals.propose, {
        seatDefId: musicLeadDef._id,
        scope: s.chapterId,
        action: "fill",
        subjectPersonId: subject,
      }),
    ).rejects.toBeInstanceOf(ConvexError);
    await expect(as.query(api.seatProposals.pendingProposals, {})).rejects.toBeInstanceOf(
      ConvexError,
    );
    await expect(as.query(api.seatProposals.myProposals, {})).rejects.toBeInstanceOf(ConvexError);
  });
});

// ── approve — BLOCKED ────────────────────────────────────────────────────────
//
// `approve` (execute the change atomically via `seats.assignSeat`/
// `unassignSeat`'s validated path) is NOT YET SHIPPED — see the file-level
// doc comment in `seatProposals.ts` for the precise ~15-line export needed
// from `seats.ts` (out of scope: `seats.ts` is owned by other in-flight
// branches). These stubs document the intended coverage so it isn't lost;
// `.skip` keeps the suite green without asserting anything false.
describe.skip("seatProposals.approve — BLOCKED on a seats.ts export (see seatProposals.ts doc comment)", () => {
  test.todo("approval executes the seat change with full assignSeat parity (maxHolders replace)");
  test.todo("a SoD violation at execution time fails the approval as a proposal failure, not a silent skip");
  test.todo("approval reverses/creates the specializedRoles write-through exactly like assignSeat/unassignSeat");
  test.todo("approving flips status to \"approved\" and sets decidedByPersonId/decidedAt atomically with the seat change");
});
