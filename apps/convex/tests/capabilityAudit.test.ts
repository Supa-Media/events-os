import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { runSeedSeatDefs } from "../migrations/0022_seed_seat_defs";

/**
 * `seats.capabilityAudit` — the read-only shadow audit diffing seat-derived
 * finance capability (`lib/seats.ts#getSeatDerivedCapabilities`) against the
 * stored `financeRoles`/`specializedRoles` tables.
 *
 * Covers: superuser gating, seeded parity (every drift rule agrees when a
 * seat is assigned the normal way, through `assignSeat`'s write-through),
 * and each of the three drift rules independently — plus the
 * bookkeeper/viewer residual-layer exclusion.
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
    ctx.db.insert("people", { chapterId, name, createdAt: Date.now() }),
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
  return s.as.query(api.seats.capabilityAudit, {});
}

describe("seats.capabilityAudit — gating", () => {
  test("throws for a non-superuser caller", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));
    const s = await setupChapter(t); // default email is NOT on the allowlist

    await expect(s.as.query(api.seats.capabilityAudit, {})).rejects.toThrow(
      ConvexError,
    );
  });

  test("succeeds for a superuser caller", async () => {
    const s = await superuserSetup();
    const result = await audit(s);
    expect(result.mismatches).toEqual([]);
    expect(result.truncated).toBe(false);
  });
});

describe("seats.capabilityAudit — seeded parity", () => {
  test("assigning seats the normal way (via assignSeat) produces zero mismatches", async () => {
    const s = await superuserSetup();

    const treasurerDef = await defBySlug(s, "treasurer");
    const edDef = await defBySlug(s, "executive_director");
    const fmDef = await defBySlug(s, "financial_manager");
    const chapterDirectorDef = await defBySlug(s, "chapter_director");

    const treasurer = await makePerson(s, s.chapterId, "Tara Treasurer");
    const ed = await makePerson(s, s.chapterId, "Eli ED");
    const fm = await makePerson(s, s.chapterId, "Fran FM");
    const president = await makePerson(s, s.chapterId, "Percy President");

    await s.as.mutation(api.seats.assignSeat, {
      seatDefId: treasurerDef._id,
      scope: s.chapterId,
      personId: treasurer,
    });
    await s.as.mutation(api.seats.assignSeat, {
      seatDefId: edDef._id,
      scope: "central",
      personId: ed,
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
    expect(result.mismatches).toEqual([]);
    expect(result.truncated).toBe(false);
    expect(result.checkedPeople).toBeGreaterThanOrEqual(4);
  });
});

describe("seats.capabilityAudit — drift detection", () => {
  test("a financeRoles manager grant with no seat is reported as stored_manager_with_no_seat", async () => {
    const s = await superuserSetup();
    const orphan = await makePerson(s, s.chapterId, "Orphan Manager");

    await run(s.t, (ctx) =>
      ctx.db.insert("financeRoles", {
        chapterId: s.chapterId,
        personId: orphan,
        role: "manager",
        scope: "chapter",
        createdAt: Date.now(),
      }),
    );

    const result = await audit(s);
    const mine = result.mismatches.filter((m) => m.personId === orphan);
    expect(mine).toEqual([
      {
        personId: orphan,
        scope: s.chapterId,
        kind: "stored_manager_with_no_seat",
        seatSide: null,
        storedSide: "manager",
      },
    ]);
  });

  test("a treasurer seat with its specializedRoles mirror deleted is reported as seat_legacy_title_missing_specializedRoles_mirror", async () => {
    const s = await superuserSetup();
    const treasurerDef = await defBySlug(s, "treasurer");
    const person = await makePerson(s, s.chapterId, "Tessa Treasurer");

    await s.as.mutation(api.seats.assignSeat, {
      seatDefId: treasurerDef._id,
      scope: s.chapterId,
      personId: person,
    });

    // Sever the write-through mirror directly (simulating drift that could
    // arise from a direct `specializedRoles` edit bypassing the seat layer).
    await run(s.t, async (ctx) => {
      const row = await ctx.db
        .query("specializedRoles")
        .withIndex("by_scope_and_title", (q) =>
          q.eq("scope", s.chapterId).eq("title", "finance_manager"),
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
        scope: s.chapterId,
        kind: "seat_legacy_title_missing_specializedRoles_mirror",
        seatSide: "finance_manager",
        storedSide: null,
      },
    ]);

    // The financeRoles grant itself was left untouched, so rule (a) sees
    // seat-derived "manager" matching the still-present stored "manager" —
    // no additional mismatch from that rule.
    const financeMismatch = mine.find(
      (m) => m.kind === "seat_implies_manager_but_stored_missing",
    );
    expect(financeMismatch).toBeUndefined();
  });

  test("a central specializedRoles title with no seat is reported as both an accounts mismatch and a mirror mismatch", async () => {
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
    const kinds = mine.map((m) => m.kind).sort();
    // Two independent rules both fire off the same underlying drift (a
    // central ED/FM title with no backing seat): rule (b) flags that the
    // title grants accounts access with no seat behind it, rule (c) flags
    // the missing seat mirror.
    expect(kinds).toEqual(
      [
        "specialized_title_grants_accounts_with_no_seat",
        "specializedRoles_row_missing_seat_mirror",
      ].sort(),
    );

    const accountsMismatch = mine.find(
      (m) => m.kind === "specialized_title_grants_accounts_with_no_seat",
    );
    expect(accountsMismatch).toEqual({
      personId: person,
      scope: "central",
      kind: "specialized_title_grants_accounts_with_no_seat",
      seatSide: null,
      storedSide: "accounts",
    });

    const mirrorMismatch = mine.find(
      (m) => m.kind === "specializedRoles_row_missing_seat_mirror",
    );
    expect(mirrorMismatch).toEqual({
      personId: person,
      scope: "central",
      kind: "specializedRoles_row_missing_seat_mirror",
      seatSide: null,
      storedSide: "executive_director",
    });
  });
});

describe("seats.capabilityAudit — residual layer exclusion", () => {
  test("a bare bookkeeper grant with no seat is NOT reported", async () => {
    const s = await superuserSetup();
    const person = await makePerson(s, s.chapterId, "Bea Bookkeeper");

    await run(s.t, (ctx) =>
      ctx.db.insert("financeRoles", {
        chapterId: s.chapterId,
        personId: person,
        role: "bookkeeper",
        scope: "chapter",
        createdAt: Date.now(),
      }),
    );

    const result = await audit(s);
    expect(result.mismatches.filter((m) => m.personId === person)).toEqual([]);
  });

  test("a bare viewer grant with no seat is NOT reported", async () => {
    const s = await superuserSetup();
    const person = await makePerson(s, s.chapterId, "Vic Viewer");

    await run(s.t, (ctx) =>
      ctx.db.insert("financeRoles", {
        chapterId: s.chapterId,
        personId: person,
        role: "viewer",
        scope: "chapter",
        createdAt: Date.now(),
      }),
    );

    const result = await audit(s);
    expect(result.mismatches.filter((m) => m.personId === person)).toEqual([]);
  });

  test("residual grants still count toward checkedPeople", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));
    const s = await setupChapter(t, { email: "seyi@publicworship.life" });
    const person = await makePerson(s, s.chapterId, "Solo Viewer");

    await run(s.t, (ctx) =>
      ctx.db.insert("financeRoles", {
        chapterId: s.chapterId,
        personId: person,
        role: "viewer",
        scope: "chapter",
        createdAt: Date.now(),
      }),
    );

    const result = await audit(s);
    expect(result.checkedPeople).toBe(1);
    expect(result.mismatches).toEqual([]);
  });
});
