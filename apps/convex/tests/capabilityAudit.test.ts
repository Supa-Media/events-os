import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { runSeedSeatDefs } from "../migrations/0022_seed_seat_defs";

/**
 * `seats.capabilityAudit` — the read-only FLIP SIMULATION comparing TODAY's
 * effective outcome (the real gates' exact formulas, replicated) against
 * POST-FLIP's effective outcome (`max`/`OR` of seat-derived and today's
 * stored state — the planned flip's own union formula), plus the separate
 * legacyTitle/specializedRoles mirror integrity check (rule c).
 *
 * Covers: superuser gating on the audit ITSELF, a pinned "superuser bypass
 * still works with zero rows" test against the REAL gates (the audit can't
 * verify this — see `capabilityAudit`'s doc — so it's pinned independently),
 * seeded parity (`status: "clean"`), each flip-simulation dimension
 * (finance role / central reach / accounts access) independently, the
 * legacyTitle mirror check in both directions, and the residual-layer case
 * that used to be a false-clean hole (central bookkeeper/viewer) — now
 * correctly `"clean"` because the union formula preserves it, not because
 * the audit failed to look.
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
  opts?: { userId?: Id<"users"> },
): Promise<Id<"people">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId,
      name,
      createdAt: Date.now(),
      ...(opts?.userId ? { userId: opts.userId } : {}),
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
    expect(result.status).toBe("clean");
    expect(result.mismatches).toEqual([]);
  });
});

describe("seats.capabilityAudit — superuser short-circuit is OUTSIDE the audit (pinned separately)", () => {
  test("a superuser with ZERO seat/financeRoles/specializedRoles rows still passes the real gates today", async () => {
    // This is NOT exercising `capabilityAudit` — it pins the CURRENT
    // behavior of the real gates (`financeRoles.mySeats` /
    // `financeRoles.canViewAccounts`, both backed by `isSuperuser`'s
    // allowlist bypass) that the audit has no way to verify, per its doc
    // comment. If a future flip PR ever weakens this bypass, this test (not
    // the audit) is what catches it.
    const s = await superuserSetup();

    const seats = await s.as.query(api.financeRoles.mySeats, {});
    expect(seats).toEqual([
      expect.objectContaining({ scope: "central", role: "manager" }),
    ]);

    const canViewAccounts = await s.as.query(api.financeRoles.canViewAccounts, {});
    expect(canViewAccounts).toBe(true);
  });
});

describe("seats.capabilityAudit — seeded parity", () => {
  test("assigning seats the normal way (via assignSeat) produces status: clean", async () => {
    const s = await superuserSetup();

    const treasurerDef = await defBySlug(s, "treasurer");
    const fmDef = await defBySlug(s, "financial_manager");

    // FM holds a `finance.accounts`-carrying seat, so it needs a REAL
    // `userId` for `todaysAccountsAccessForPerson` to be able to resolve it
    // at all (mirrors `isCentralEdOrFm`'s requirement — a person with no
    // linked user can never be "the caller"). Treasurer doesn't carry that
    // capability, so it doesn't need one.
    //
    // NOTE: `executive_director` and (as of the finance.viewer PR,
    // 2026-07-17) `chapter_director` are deliberately NOT included here —
    // see the "flip-simulation drift" describe block below. Both carry a
    // seat capability (`finance.central` / `finance.viewer` respectively)
    // that `assignSpecializedRoleImpl` never bridges to a stored grant for a
    // LEADERSHIP-kind title (`president`/`executive_director`) — only
    // FINANCE-kind titles bridge (step 6: `if (kind === "finance")`). So
    // assigning either seat TODAY produces a genuine, pre-existing/by-design
    // gap between the seat template's capability and the current bridge,
    // unrelated to drift. It's exactly the kind of divergence
    // `flip_changes_central_reach` / `flip_changes_finance_role` exist to
    // surface, so each is covered by its own dedicated test instead of
    // polluting this "everything's in sync" baseline.
    const fmUserId = await run(s.t, (ctx) =>
      ctx.db.insert("users", { email: "fran@publicworship.life" }),
    );
    const treasurer = await makePerson(s, s.chapterId, "Tara Treasurer");
    const fm = await makePerson(s, s.chapterId, "Fran FM", { userId: fmUserId });

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

    const result = await audit(s);
    expect(result.status).toBe("clean");
    expect(result.mismatches).toEqual([]);
    expect(result.checkedPeople).toBeGreaterThanOrEqual(2);
  });
});

describe("seats.capabilityAudit — flip-simulation drift", () => {
  test("a treasurer seat assigned directly (bypassing assignSeat's write-through) is reported as flip_changes_finance_role + a legacy mirror gap", async () => {
    const s = await superuserSetup();
    const treasurerDef = await defBySlug(s, "treasurer");
    const person = await makePerson(s, s.chapterId, "Tara Treasurer");

    // Simulate drift (e.g. a migration writing `seatAssignments` directly):
    // the seat is assigned, but NEITHER the `financeRoles` bridge NOR the
    // `specializedRoles` mirror got written (both only happen through
    // `assignSeat`'s write-through, which this bypasses).
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
    const kinds = mine.map((m) => m.kind).sort();
    expect(kinds).toEqual(
      [
        "flip_changes_finance_role",
        "seat_legacy_title_missing_specializedRoles_mirror",
      ].sort(),
    );

    const roleMismatch = mine.find((m) => m.kind === "flip_changes_finance_role");
    expect(roleMismatch).toEqual({
      personId: person,
      scope: s.chapterId,
      kind: "flip_changes_finance_role",
      seatSide: "manager",
      storedSide: null,
    });
  });

  test("an executive_director seat (no finance.manager bridge) is reported as flip_changes_central_reach", async () => {
    const s = await superuserSetup();
    const edDef = await defBySlug(s, "executive_director");
    // A real `userId` so `todaysAccountsAccessForPerson` CAN resolve this
    // person — isolating the test to the central-reach dimension: the seat's
    // legacyTitle write-through DOES create the `specializedRoles` ED row
    // (so today's accountsAccess is already true, matching post-flip), but
    // it does NOT create a `financeRoles` row (leadership titles don't
    // bridge to finance — only `finance_manager` does).
    const userId = await run(s.t, (ctx) =>
      ctx.db.insert("users", { email: "eli@publicworship.life" }),
    );
    const person = await makePerson(s, s.chapterId, "Eli ED", { userId });

    // The REAL assignSeat write-through: executive_director is a LEADERSHIP
    // title, so it bridges to `specializedRoles` but NEVER to `financeRoles`
    // (only the `finance_manager` title's write-through does that — see
    // `assignSpecializedRoleImpl`). So today's stored `isCentral` for this
    // person stays false even though the seat carries `finance.central`.
    await s.as.mutation(api.seats.assignSeat, {
      seatDefId: edDef._id,
      scope: "central",
      personId: person,
    });

    const result = await audit(s);
    const mine = result.mismatches.filter((m) => m.personId === person);
    expect(mine).toEqual([
      {
        personId: person,
        scope: "central",
        kind: "flip_changes_central_reach",
        seatSide: "central-reach",
        storedSide: null,
      },
    ]);
  });

  test("a chapter_director seat (no finance.manager bridge) is reported as flip_changes_finance_role — the finance.viewer widening (owner decision, 2026-07-16)", async () => {
    const s = await superuserSetup();
    const cdDef = await defBySlug(s, "chapter_director");
    // chapter_director doesn't carry finance.accounts, so (unlike the ED
    // case above) no real userId is needed for this dimension.
    const person = await makePerson(s, s.chapterId, "Percy President");

    // The REAL assignSeat write-through: chapter_director's legacyTitle
    // ("president") is a LEADERSHIP title, so it bridges to
    // `specializedRoles` but NEVER to `financeRoles` (only `finance_manager`
    // does — see `assignSpecializedRoleImpl`). So today's stored finance
    // role for this person stays null even though the seat now carries
    // `finance.viewer` (added by the finance.viewer PR) — a genuine
    // post-flip widening from null to "viewer", exactly what this audit
    // exists to surface.
    await s.as.mutation(api.seats.assignSeat, {
      seatDefId: cdDef._id,
      scope: s.chapterId,
      personId: person,
    });

    const result = await audit(s);
    const mine = result.mismatches.filter((m) => m.personId === person);
    expect(mine).toEqual([
      {
        personId: person,
        scope: s.chapterId,
        kind: "flip_changes_finance_role",
        seatSide: "viewer",
        storedSide: null,
      },
    ]);
  });

  test("a financial_manager seat with its specializedRoles mirror deleted is reported as flip_changes_accounts_access + a legacy mirror gap (finance role and central reach stay in sync)", async () => {
    const s = await superuserSetup();
    const fmDef = await defBySlug(s, "financial_manager");
    const userId = await run(s.t, (ctx) => ctx.db.insert("users", { email: "fran@publicworship.life" }));
    const person = await makePerson(s, s.chapterId, "Fran FM", { userId });

    await s.as.mutation(api.seats.assignSeat, {
      seatDefId: fmDef._id,
      scope: "central",
      personId: person,
    });

    // Sever the write-through mirror directly (simulating drift that could
    // arise from a direct `specializedRoles` edit bypassing the seat layer).
    // The `financeRoles` manager grant (bridged at assignment time) is left
    // untouched.
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
    const kinds = mine.map((m) => m.kind).sort();
    expect(kinds).toEqual(
      [
        "flip_changes_accounts_access",
        "seat_legacy_title_missing_specializedRoles_mirror",
      ].sort(),
    );

    // Finance role + central reach are UNAFFECTED: the `financeRoles` grant
    // itself (the thing rule (a)/isCentral actually read) is untouched.
    expect(mine.some((m) => m.kind === "flip_changes_finance_role")).toBe(false);
    expect(mine.some((m) => m.kind === "flip_changes_central_reach")).toBe(false);

    const accountsMismatch = mine.find((m) => m.kind === "flip_changes_accounts_access");
    expect(accountsMismatch).toEqual({
      personId: person,
      scope: "central",
      kind: "flip_changes_accounts_access",
      seatSide: "accounts",
      storedSide: null,
    });
  });
});

describe("seats.capabilityAudit — orphan stored grants: legacy-mirror gap yes, flip-outcome mismatch no", () => {
  test("a central executive_director specializedRoles row with no seat is reported ONLY as a legacy mirror gap — NOT a flip-outcome mismatch (the union formula preserves it)", async () => {
    const s = await superuserSetup();
    const userId = await run(s.t, (ctx) => ctx.db.insert("users", { email: "xena@publicworship.life" }));
    const person = await makePerson(s, s.chapterId, "Xena ExecutiveDirector", { userId });

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
    // Today's accountsAccess is ALREADY true (the specializedRoles row is
    // there); post-flip it stays true (OR with seat-derived false). Same
    // outcome both sides → no flip_changes_accounts_access mismatch. Only
    // the legacy-mirror integrity check (a different question: "is the seat
    // layer consistent with the legacy layer") fires.
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

  test("a bare financeRoles manager grant with no seat produces NO mismatch (the flip keeps it via the residual/stored side)", async () => {
    const s = await superuserSetup();
    const person = await makePerson(s, s.chapterId, "Owen Orphan Manager");

    await run(s.t, (ctx) =>
      ctx.db.insert("financeRoles", {
        chapterId: s.chapterId,
        personId: person,
        role: "manager",
        scope: "chapter",
        createdAt: Date.now(),
      }),
    );

    const result = await audit(s);
    expect(result.mismatches.filter((m) => m.personId === person)).toEqual([]);
  });
});

describe("seats.capabilityAudit — internal ops twin (capabilityAuditSystem)", () => {
  test("capabilityAuditSystem (internalQuery, no caller identity) returns results identical to capabilityAudit for the same data", async () => {
    const s = await superuserSetup();
    const treasurerDef = await defBySlug(s, "treasurer");
    const person = await makePerson(s, s.chapterId, "Tara Treasurer");

    // Same drift setup as the "flip-simulation drift" describe block above —
    // proves parity on a non-trivial (mismatches-bearing) run, not just an
    // empty "clean" one.
    await run(s.t, (ctx) =>
      ctx.db.insert("seatAssignments", {
        seatDefId: treasurerDef._id,
        scope: s.chapterId,
        personId: person,
        createdAt: Date.now(),
      }),
    );

    const viaPublicQuery = await audit(s);
    // `capabilityAuditSystem` is an `internalQuery` — called directly via
    // `t.query(internal...)` (mirroring `npx convex run`'s admin access),
    // with NO superuser-authenticated `s.as` caller and no auth setup at
    // all. This is the whole point: ops can run it against prod where there
    // is no user identity for `requireSuperuser` to check.
    const viaInternalQuery = await s.t.query(
      internal.seats.capabilityAuditSystem,
      {},
    );

    expect(viaInternalQuery).toEqual(viaPublicQuery);
    expect(viaInternalQuery.status).toBe("mismatches");
    expect(viaInternalQuery.mismatches.length).toBeGreaterThan(0);
  });

  test("capabilityAuditSystem runs with no authenticated caller at all, unlike capabilityAudit which throws without superuser", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));

    // No `setupChapter`/`s.as` caller — nothing is signed in.
    const result = await t.query(internal.seats.capabilityAuditSystem, {});
    expect(result.status).toBe("clean");
    expect(result.checkedPeople).toBe(0);
  });
});

describe("seats.capabilityAudit — residual layer: the fixed false-clean hole", () => {
  test("a central-scoped bookkeeper grant with no finance.central seat is status: clean — isCentral survives the flip via the union formula", async () => {
    // This is the exact scenario the pre-rewrite audit was blind to: it
    // never compared `centralReach`/`isCentral` at all, so it couldn't tell
    // whether the flip would preserve this person's org-wide reach. Now it's
    // computed explicitly and confirmed to survive (todayIsCentral=true,
    // postFlipIsCentral = true || false = true — no regression) rather than
    // being silently unchecked.
    const s = await superuserSetup();
    const person = await makePerson(s, s.chapterId, "Bea Central Bookkeeper");

    await run(s.t, (ctx) =>
      ctx.db.insert("financeRoles", {
        chapterId: s.chapterId,
        personId: person,
        role: "bookkeeper",
        scope: "central",
        createdAt: Date.now(),
      }),
    );

    const result = await audit(s);
    expect(result.mismatches.filter((m) => m.personId === person)).toEqual([]);
  });

  test("a central-scoped viewer grant with no finance.central seat is ALSO status: clean", async () => {
    const s = await superuserSetup();
    const person = await makePerson(s, s.chapterId, "Vic Central Viewer");

    await run(s.t, (ctx) =>
      ctx.db.insert("financeRoles", {
        chapterId: s.chapterId,
        personId: person,
        role: "viewer",
        scope: "central",
        createdAt: Date.now(),
      }),
    );

    const result = await audit(s);
    expect(result.mismatches.filter((m) => m.personId === person)).toEqual([]);
  });

  test("residual grants still count toward checkedPeople even when clean", async () => {
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
    expect(result.status).toBe("clean");
  });
});
