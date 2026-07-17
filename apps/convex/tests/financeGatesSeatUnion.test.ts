import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { runSeedSeatDefs } from "../migrations/0022_seed_seat_defs";

/**
 * `lib/finance.ts#getFinanceRole` / `#isCentralEdOrFm` — the B10
 * seat-derived UNION flip. Effective finance role/reach is now
 * `max`/`OR` of the org chart's seat-derived opinion
 * (`lib/seats.ts#getSeatDerivedCapabilities`) and the stored
 * `financeRoles`/`specializedRoles` ladder — never a replacement.
 *
 * Exercised at the GATE level via real exported queries/mutations, not by
 * calling the lib functions directly (`getFinanceRole`/`isCentralEdOrFm`
 * both need a real `ctx.auth` identity, which only a
 * `t.withIdentity(...).query/mutation` call provides):
 *
 *  - `stripeFinance.canConnectAccount` returns `getFinanceRole(...).isCentral`
 *    verbatim — the surface for the central-reach union.
 *  - `financeRoles.grantFinanceRole` is gated by `requireFinanceManager`
 *    (`getFinanceRole(...).role === "manager"` rank) — the surface for the
 *    graded-role union.
 *  - `financeRoles.canViewAccounts` returns `isCentralEdOrFm(...)` verbatim.
 *
 * Every scenario here mirrors a `seats.ts#capabilityAudit` drift case (see
 * `capabilityAudit.test.ts`) — this file proves the audit's PREDICTED
 * post-flip outcome is what the REAL gates now do. The production audit run
 * ahead of this flip found exactly ONE delta (an `executive_director`
 * holder gaining central reach — the first describe block below) and ZERO
 * narrowing deltas; every other scenario here is a "stays exactly the same"
 * pin, not a behavior change.
 */

async function seatSetup(
  opts: { email?: string; chapterName?: string } = {},
): Promise<ChapterSetup> {
  const t = newT();
  await run(t, (ctx) => runSeedSeatDefs(ctx));
  return setupChapter(t, opts);
}

async function seedSelfPerson(
  s: ChapterSetup,
  opts?: { isPlaceholder?: boolean },
): Promise<Id<"people">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Caller",
      userId: s.userId,
      isTeamMember: true,
      createdAt: Date.now(),
      ...(opts?.isPlaceholder ? { isPlaceholder: true } : {}),
    }),
  );
}

async function makeTargetPerson(s: ChapterSetup): Promise<Id<"people">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Target",
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

/** Insert a `seatAssignments` row directly (bypassing `assignSeat`'s
 *  write-through), exactly mirroring `capabilityAudit.test.ts`'s drift
 *  fixtures — isolates "what the chart alone implies" from the stored
 *  bridge/mirror rows a real assignment would also create. */
async function assignSeatDirect(
  s: ChapterSetup,
  personId: Id<"people">,
  slug: string,
  scope: Id<"chapters"> | "central",
): Promise<void> {
  const def = await defBySlug(s, slug);
  await run(s.t, (ctx) =>
    ctx.db.insert("seatAssignments", {
      seatDefId: def._id,
      scope,
      personId,
      createdAt: Date.now(),
    }),
  );
}

describe("getFinanceRole — central reach union (via stripeFinance.canConnectAccount)", () => {
  test("an executive_director seat with NO stored central financeRoles grant now yields central reach — the pre-flagged gap the prod audit confirmed as the one intended widening", async () => {
    const s = await seatSetup();
    const personId = await seedSelfPerson(s);
    await assignSeatDirect(s, personId, "executive_director", "central");

    expect(await s.as.query(api.stripeFinance.canConnectAccount, {})).toBe(
      true,
    );
  });

  test("a bare central financeRoles bookkeeper grant with no seat still yields central reach — the residual layer survives the union", async () => {
    const s = await seatSetup();
    const personId = await seedSelfPerson(s);
    await run(s.t, (ctx) =>
      ctx.db.insert("financeRoles", {
        chapterId: "central",
        personId,
        role: "bookkeeper",
        scope: "central",
        createdAt: Date.now(),
      }),
    );

    expect(await s.as.query(api.stripeFinance.canConnectAccount, {})).toBe(
      true,
    );
  });

  test("a bare central financeRoles viewer grant with no seat also still yields central reach", async () => {
    const s = await seatSetup();
    const personId = await seedSelfPerson(s);
    await run(s.t, (ctx) =>
      ctx.db.insert("financeRoles", {
        chapterId: "central",
        personId,
        role: "viewer",
        scope: "central",
        createdAt: Date.now(),
      }),
    );

    expect(await s.as.query(api.stripeFinance.canConnectAccount, {})).toBe(
      true,
    );
  });

  test("no seat and no grant at all still yields false — no widening for a plain member", async () => {
    const s = await seatSetup();
    await seedSelfPerson(s);

    expect(await s.as.query(api.stripeFinance.canConnectAccount, {})).toBe(
      false,
    );
  });

  test("a placeholder holding the executive_director seat still yields false — pins the viewerPerson exclusion getFinanceRole relies on (assignSeat itself refuses to seat a placeholder in the real path)", async () => {
    const s = await seatSetup();
    const personId = await seedSelfPerson(s, { isPlaceholder: true });
    await assignSeatDirect(s, personId, "executive_director", "central");

    expect(await s.as.query(api.stripeFinance.canConnectAccount, {})).toBe(
      false,
    );
  });
});

describe("getFinanceRole — graded role union (via financeRoles.grantFinanceRole, manager-gated)", () => {
  test("a treasurer seat assigned directly (bypassing the financeRoles bridge) now clears the manager gate — the flip_changes_finance_role drift capabilityAudit predicted", async () => {
    const s = await seatSetup();
    const personId = await seedSelfPerson(s);
    await assignSeatDirect(s, personId, "treasurer", s.chapterId);
    const targetPersonId = await makeTargetPerson(s);

    // Would have thrown FORBIDDEN pre-flip (the stored role was null).
    await expect(
      s.as.mutation(api.financeRoles.grantFinanceRole, {
        personId: targetPersonId,
        role: "viewer",
        scope: "chapter",
      }),
    ).resolves.toBeDefined();
  });

  test("no seat and no stored grant still throws — no widening for a plain member", async () => {
    const s = await seatSetup();
    await seedSelfPerson(s);
    const targetPersonId = await makeTargetPerson(s);

    await expect(
      s.as.mutation(api.financeRoles.grantFinanceRole, {
        personId: targetPersonId,
        role: "viewer",
        scope: "chapter",
      }),
    ).rejects.toThrow();
  });

  test("a stored chapter viewer grant with no seat still throws — the residual layer never widens past its own rank", async () => {
    const s = await seatSetup();
    const personId = await seedSelfPerson(s);
    await run(s.t, (ctx) =>
      ctx.db.insert("financeRoles", {
        chapterId: s.chapterId,
        personId,
        role: "viewer",
        scope: "chapter",
        createdAt: Date.now(),
      }),
    );
    const targetPersonId = await makeTargetPerson(s);

    await expect(
      s.as.mutation(api.financeRoles.grantFinanceRole, {
        personId: targetPersonId,
        role: "viewer",
        scope: "chapter",
      }),
    ).rejects.toThrow();
  });

  test("an executive_director seat (no finance.manager capability) does NOT clear the manager gate — a seat only ever derives central reach + accounts here, never the graded role", async () => {
    const s = await seatSetup();
    const personId = await seedSelfPerson(s);
    await assignSeatDirect(s, personId, "executive_director", "central");
    const targetPersonId = await makeTargetPerson(s);

    await expect(
      s.as.mutation(api.financeRoles.grantFinanceRole, {
        personId: targetPersonId,
        role: "viewer",
        scope: "chapter",
      }),
    ).rejects.toThrow();
  });
});

describe("isCentralEdOrFm — accounts-access union (via financeRoles.canViewAccounts)", () => {
  test("a financial_manager seat, with the specializedRoles mirror a real assignment would also write DELETED, still sees Accounts — seat-derived accountsAccess survives the mirror gap (the flip_changes_accounts_access drift capabilityAudit predicted)", async () => {
    const s = await seatSetup();
    const personId = await seedSelfPerson(s);

    // Replicate exactly what `assignSeat`'s real write-through creates for a
    // `financial_manager` assignment (the seat row + the bridged central
    // `financeRoles` manager grant + the `specializedRoles` mirror) — done
    // directly here (rather than via the superuser-gated `assignSeat`
    // mutation, which would need a second caller identity) so this test can
    // then delete JUST the mirror, simulating drift, exactly like
    // `capabilityAudit.test.ts`'s matching scenario.
    await assignSeatDirect(s, personId, "financial_manager", "central");
    await run(s.t, (ctx) =>
      ctx.db.insert("financeRoles", {
        chapterId: "central",
        personId,
        role: "manager",
        scope: "central",
        createdAt: Date.now(),
      }),
    );
    const mirrorId = await run(s.t, (ctx) =>
      ctx.db.insert("specializedRoles", {
        personId,
        scope: "central",
        title: "finance_manager",
        roleKind: "finance",
        createdAt: Date.now(),
      }),
    );
    await run(s.t, (ctx) => ctx.db.delete(mirrorId));

    expect(await s.as.query(api.financeRoles.canViewAccounts, {})).toBe(true);
  });

  test("no seat and no specializedRoles title still sees false — no widening for a plain member", async () => {
    const s = await seatSetup();
    await seedSelfPerson(s);

    expect(await s.as.query(api.financeRoles.canViewAccounts, {})).toBe(
      false,
    );
  });

  test("a placeholder holding the executive_director seat AND its specializedRoles title still sees false — the sibling-walk's placeholder skip runs BEFORE the new seat-derived check", async () => {
    const s = await seatSetup();
    const personId = await seedSelfPerson(s, { isPlaceholder: true });
    await assignSeatDirect(s, personId, "executive_director", "central");
    await run(s.t, (ctx) =>
      ctx.db.insert("specializedRoles", {
        personId,
        scope: "central",
        title: "executive_director",
        roleKind: "leadership",
        createdAt: Date.now(),
      }),
    );

    expect(await s.as.query(api.financeRoles.canViewAccounts, {})).toBe(
      false,
    );
  });

  test("a chapter-scoped treasurer seat (finance.manager only, no finance.accounts) does NOT grant Accounts", async () => {
    const s = await seatSetup();
    const personId = await seedSelfPerson(s);
    await assignSeatDirect(s, personId, "treasurer", s.chapterId);

    expect(await s.as.query(api.financeRoles.canViewAccounts, {})).toBe(
      false,
    );
  });
});

describe("superuser short-circuit — UNCHANGED by the flip", () => {
  test("a superuser with zero seatAssignments/financeRoles/specializedRoles rows still has central reach + Accounts", async () => {
    const s = await seatSetup({ email: "seyi@publicworship.life" });

    expect(await s.as.query(api.stripeFinance.canConnectAccount, {})).toBe(
      true,
    );
    expect(await s.as.query(api.financeRoles.canViewAccounts, {})).toBe(true);
  });
});
