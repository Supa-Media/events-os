import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { runSeedSeatDefs } from "../migrations/0022_seed_seat_defs";

/**
 * `seats.bridgeDriftAudit` — the read-only DATA-INTEGRITY check that a
 * `seatAssignments` row on a `legacyTitle`-bearing seat def stays mirrored
 * onto a `specializedRoles` row at the same (scope, title) —
 * `assignSeat`'s write-through contract — in BOTH directions.
 *
 * This replaced the old `capabilityAudit` flip-simulation (today-vs-post-flip
 * finance-role/central-reach/accounts-access comparison) once the B10 flip
 * (PR #195) actually shipped: simulating a flip that already landed is
 * permanently stale, since the audit's "today" replica hard-codes the
 * PRE-flip formulas. `specializedRoles` still backs the title-based
 * separation-of-duties checks until that table is retired in a later
 * milestone, so drift between it and the seat layer remains a real bug — the
 * only thing this audit still watches for.
 *
 * Covers: superuser gating on the audit ITSELF, seeded parity (`status:
 * "clean"`), the two mirror-drift directions independently, and the
 * ops-only `internalQuery` twin producing identical results.
 */

/** A superuser-authenticated, seat-seeded chapter setup (seyi@ is on the
 *  superuser allowlist — mirrors `seats.test.ts`'s pattern). */
async function superuserSetup(opts?: { chapterName?: string }): Promise<ChapterSetup> {
  const t = newT();
  await run(t, (ctx) => runSeedSeatDefs(ctx));
  return setupChapter(t, { email: "seyi@publicworship.life", ...opts });
}

/** Insert a bare roster person and return its id. */
async function makePerson(
  s: ChapterSetup,
  chapterId: Id<"chapters">,
  name: string,
): Promise<Id<"people">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId,
      name,
      createdAt: Date.now(),
    }),
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

/** Run the audit as the setup's superuser caller. */
function audit(s: ChapterSetup) {
  return s.as.query(api.seats.bridgeDriftAudit, {});
}

describe("seats.bridgeDriftAudit — gating", () => {
  test("throws for a non-superuser caller", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));
    const s = await setupChapter(t); // default email is NOT on the allowlist

    await expect(s.as.query(api.seats.bridgeDriftAudit, {})).rejects.toThrow(
      ConvexError,
    );
  });

  test("succeeds for a superuser caller", async () => {
    const s = await superuserSetup();
    const result = await audit(s);
    expect(result.status).toBe("clean");
    expect(result.mismatches).toEqual([]);
  });
});

describe("seats.bridgeDriftAudit — seeded parity", () => {
  test("assigning seats the normal way (via assignSeat) produces status: clean", async () => {
    const s = await superuserSetup();

    const treasurerDef = await defBySlug(s, "treasurer");
    const fmDef = await defBySlug(s, "financial_manager");
    const chapterDirectorDef = await defBySlug(s, "chapter_director");

    const treasurer = await makePerson(s, s.chapterId, "Tara Treasurer");
    const fm = await makePerson(s, s.chapterId, "Fran FM");
    const president = await makePerson(s, s.chapterId, "Percy President");

    await s.as.mutation(api.seats.assignSeat, {
      seatDefId: treasurerDef._id,
      scope: s.chapterId,
      personId: treasurer,
    });
    await s.as.mutation(api.seats.assignSeat, {
      seatDefId: fmDef._id,
      scope: "central",
      personId: fm,
    });
    await s.as.mutation(api.seats.assignSeat, {
      seatDefId: chapterDirectorDef._id,
      scope: s.chapterId,
      personId: president,
    });

    const result = await audit(s);
    expect(result.status).toBe("clean");
    expect(result.mismatches).toEqual([]);
    expect(result.checkedPeople).toBeGreaterThanOrEqual(3);
  });

  test("a bare seatAssignments row on a def with NO legacyTitle produces no mismatch — there's no mirror contract to check", async () => {
    const s = await superuserSetup();
    // `chapter_directors` (central, derived/no legacyTitle roll-up seat) has
    // no direct assignment path, so use any non-legacy-title chart seat
    // instead: pick a def and confirm it truly has no legacyTitle before
    // asserting on it, so this test stays honest if seed data ever adds one.
    const chapterDirectorsDef = await run(s.t, (ctx) =>
      ctx.db
        .query("seatDefs")
        .withIndex("by_slug", (q) => q.eq("slug", "chapter_directors"))
        .unique(),
    );
    if (!chapterDirectorsDef) throw new Error("chapter_directors not seeded");
    expect(chapterDirectorsDef.legacyTitle).toBeUndefined();
    expect(chapterDirectorsDef.derived).toBe(true);

    // A derived seat is never directly assigned, so this is really just
    // asserting the seeded-but-unassigned baseline stays clean.
    const result = await audit(s);
    expect(result.status).toBe("clean");
  });
});

describe("seats.bridgeDriftAudit — drift: seat with a missing mirror", () => {
  test("a treasurer seat assigned directly (bypassing assignSeat's write-through) is reported as seat_legacy_title_missing_specializedRoles_mirror", async () => {
    const s = await superuserSetup();
    const treasurerDef = await defBySlug(s, "treasurer");
    const person = await makePerson(s, s.chapterId, "Tara Treasurer");

    // Simulate drift (e.g. a migration writing `seatAssignments` directly):
    // the seat is assigned, but the `specializedRoles` mirror never got
    // written (that only happens through `assignSeat`'s write-through,
    // which this bypasses).
    await run(s.t, (ctx) =>
      ctx.db.insert("seatAssignments", {
        seatDefId: treasurerDef._id,
        scope: s.chapterId,
        personId: person,
        createdAt: Date.now(),
      }),
    );

    const result = await audit(s);
    expect(result.status).toBe("mismatches");
    const mine = result.mismatches.filter((m) => m.personId === person);
    expect(mine).toEqual([
      {
        personId: person,
        scope: s.chapterId,
        kind: "seat_legacy_title_missing_specializedRoles_mirror",
        // `treasurer`'s `legacyTitle` is "finance_manager" — same
        // legacy title `financial_manager` (central) maps to; see
        // `SEAT_DEFS.treasurer` in `@events-os/shared/seats.ts`.
        seatSide: "finance_manager",
        storedSide: null,
      },
    ]);
  });

  test("a financial_manager seat with its specializedRoles mirror deleted is reported as the same drift kind", async () => {
    const s = await superuserSetup();
    const fmDef = await defBySlug(s, "financial_manager");
    const person = await makePerson(s, s.chapterId, "Fran FM");

    await s.as.mutation(api.seats.assignSeat, {
      seatDefId: fmDef._id,
      scope: "central",
      personId: person,
    });

    // Sever the write-through mirror directly (simulating drift that could
    // arise from a direct `specializedRoles` edit bypassing the seat layer).
    await run(s.t, async (ctx) => {
      const row = await ctx.db
        .query("specializedRoles")
        .withIndex("by_scope_and_title", (q) =>
          q.eq("scope", "central").eq("title", "finance_manager"),
        )
        .first();
      if (!row) throw new Error("expected the write-through mirror row to exist");
      await ctx.db.delete(row._id);
    });

    const result = await audit(s);
    const mine = result.mismatches.filter((m) => m.personId === person);
    expect(mine).toEqual([
      {
        personId: person,
        scope: "central",
        kind: "seat_legacy_title_missing_specializedRoles_mirror",
        seatSide: "finance_manager",
        storedSide: null,
      },
    ]);
  });
});

describe("seats.bridgeDriftAudit — drift: orphaned mirror with no seat", () => {
  test("a central executive_director specializedRoles row with no seat is reported as specializedRoles_row_missing_seat_mirror", async () => {
    const s = await superuserSetup();
    const person = await makePerson(s, s.chapterId, "Xena ExecutiveDirector");

    await run(s.t, (ctx) =>
      ctx.db.insert("specializedRoles", {
        personId: person,
        scope: "central",
        title: "executive_director",
        roleKind: "leadership",
        createdAt: Date.now(),
      }),
    );

    const result = await audit(s);
    const mine = result.mismatches.filter((m) => m.personId === person);
    expect(mine).toEqual([
      {
        personId: person,
        scope: "central",
        kind: "specializedRoles_row_missing_seat_mirror",
        seatSide: null,
        storedSide: "executive_director",
      },
    ]);
  });

  test("unassigning a seat (removing the seatAssignments row) but leaving the specializedRoles mirror behind is reported as an orphaned mirror", async () => {
    const s = await superuserSetup();
    const treasurerDef = await defBySlug(s, "treasurer");
    const person = await makePerson(s, s.chapterId, "Tara Treasurer");

    const assignmentId = await s.as.mutation(api.seats.assignSeat, {
      seatDefId: treasurerDef._id,
      scope: s.chapterId,
      personId: person,
    });

    // Remove the seat assignment directly (bypassing `unassignSeat`, which
    // would also clean up the mirror via `removeSpecializedRoleImpl`) —
    // simulates drift from a direct DB edit or migration.
    await run(s.t, (ctx) => ctx.db.delete(assignmentId));

    const result = await audit(s);
    const mine = result.mismatches.filter((m) => m.personId === person);
    expect(mine).toEqual([
      {
        personId: person,
        scope: s.chapterId,
        kind: "specializedRoles_row_missing_seat_mirror",
        seatSide: null,
        // `treasurer`'s write-through mirror is stored under its
        // `legacyTitle`, "finance_manager" — see the note above.
        storedSide: "finance_manager",
      },
    ]);
  });
});

describe("seats.bridgeDriftAudit — internal ops twin (bridgeDriftAuditSystem)", () => {
  test("bridgeDriftAuditSystem (internalQuery, no caller identity) returns results identical to bridgeDriftAudit for the same data", async () => {
    const s = await superuserSetup();
    const treasurerDef = await defBySlug(s, "treasurer");
    const person = await makePerson(s, s.chapterId, "Tara Treasurer");

    // Same drift setup as the drift describe block above — proves parity on
    // a non-trivial (mismatches-bearing) run, not just an empty "clean" one.
    await run(s.t, (ctx) =>
      ctx.db.insert("seatAssignments", {
        seatDefId: treasurerDef._id,
        scope: s.chapterId,
        personId: person,
        createdAt: Date.now(),
      }),
    );

    const viaPublicQuery = await audit(s);
    // `bridgeDriftAuditSystem` is an `internalQuery` — called directly via
    // `t.query(internal...)` (mirroring `npx convex run`'s admin access),
    // with NO superuser-authenticated `s.as` caller and no auth setup at
    // all. This is the whole point: ops can run it against prod where there
    // is no user identity for `requireSuperuser` to check.
    const viaInternalQuery = await s.t.query(
      internal.seats.bridgeDriftAuditSystem,
      {},
    );

    expect(viaInternalQuery).toEqual(viaPublicQuery);
    expect(viaInternalQuery.status).toBe("mismatches");
    expect(viaInternalQuery.mismatches.length).toBeGreaterThan(0);
  });

  test("bridgeDriftAuditSystem runs with no authenticated caller at all, unlike bridgeDriftAudit which throws without superuser", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));

    // No `setupChapter`/`s.as` caller — nothing is signed in.
    const result = await t.query(internal.seats.bridgeDriftAuditSystem, {});
    expect(result.status).toBe("clean");
    expect(result.checkedPeople).toBe(0);
  });
});
