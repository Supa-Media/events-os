import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  newT,
  run,
  setupChapter,
  type ChapterSetup,
  type TestConvex,
} from "./setup.helpers";
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

/** A second, real member identity on the SAME chapter — mirrors
 *  `financeBudgetApproval.test.ts`'s `addMember` helper. Needed so a scenario
 *  can have a MANAGER create/submit a budget or transaction while the
 *  CALLER identity (`s.as`) is the chapter_director seat holder under test —
 *  `s.as`/`s.userId` alone can't play both roles at once. */
async function addMember(
  s: ChapterSetup,
  opts: { email: string; name: string },
): Promise<{
  as: ReturnType<TestConvex["withIdentity"]>;
  userId: Id<"users">;
  personId: Id<"people">;
}> {
  const userId = await run(s.t, (ctx) => ctx.db.insert("users", { email: opts.email }));
  await run(s.t, (ctx) =>
    ctx.db.insert("userChapters", {
      userId,
      chapterId: s.chapterId,
      role: "member",
      isActive: true,
      joinedAt: Date.now(),
    }),
  );
  const personId = await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: opts.name,
      userId,
      isTeamMember: true,
      createdAt: Date.now(),
    }),
  );
  const as = s.t.withIdentity({ subject: `${userId}|session`, issuer: "test" });
  return { as, userId, personId };
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

/** A second, superuser-authenticated client on the SAME `convex-test`
 *  instance — needed to call `assignSeat`/`unassignSeat` themselves (both
 *  superuser-gated), independent of whichever identity `s.as` represents. No
 *  chapter membership needed: `requireSuperuser` only checks the allowlisted
 *  email on the `users` row, never chapter access. */
async function superuserIdentity(
  s: ChapterSetup,
): Promise<ReturnType<TestConvex["withIdentity"]>> {
  const superuserId = await run(s.t, (ctx) =>
    ctx.db.insert("users", { email: "seyi@publicworship.life" }),
  );
  return s.t.withIdentity({ subject: `${superuserId}|session`, issuer: "test" });
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

describe("seat-derived union — invariant pins (from Opus review of #195)", () => {
  test("cross-chapter isolation — a treasurer seat at chapter A grants nothing at chapter B for the same person", async () => {
    const s = await seatSetup(); // home chapter ("New York") = "chapter B" below
    await seedSelfPerson(s); // the caller's OWN roster row at chapter B — no seat, no grant

    // A second chapter, with a SEPARATE roster row for the SAME userId —
    // exactly `financeSeats.test.ts`'s (g) "dual-chapter person" shape.
    const chapterA = await run(s.t, (ctx) =>
      ctx.db.insert("chapters", {
        name: "Chapter A",
        isActive: true,
        createdAt: Date.now(),
      }),
    );
    const personAtChapterA = await run(s.t, (ctx) =>
      ctx.db.insert("people", {
        chapterId: chapterA,
        name: "Caller (Chapter A)",
        userId: s.userId,
        isTeamMember: true,
        createdAt: Date.now(),
      }),
    );
    await assignSeatDirect(s, personAtChapterA, "treasurer", chapterA);

    // The caller's ACTIVE chapter (`requireChapterId`, via `userChapters`)
    // is still chapter B — their chapter-A treasurer seat must not leak in.
    const targetPersonId = await makeTargetPerson(s);
    await expect(
      s.as.mutation(api.financeRoles.grantFinanceRole, {
        personId: targetPersonId,
        role: "viewer",
        scope: "chapter",
      }),
    ).rejects.toThrow();
  });

  test("unassignSeat drops access from BOTH the seat-derived source and its bridged financeRoles grant", async () => {
    const s = await seatSetup();
    const personId = await seedSelfPerson(s);
    const treasurerDef = await defBySlug(s, "treasurer");
    const superuserAs = await superuserIdentity(s);

    // The REAL write-through: treasurer's `legacyTitle` is `finance_manager`
    // (a finance-kind title), so this ALSO bridges a stored chapter
    // `financeRoles` manager grant — both `assignSeat`/`unassignSeat` are
    // superuser-gated, hence the separate `superuserAs` identity.
    const assignmentId = await superuserAs.mutation(api.seats.assignSeat, {
      seatDefId: treasurerDef._id,
      scope: s.chapterId,
      personId,
    });

    const targetPersonId = await makeTargetPerson(s);
    // Gate passes while the seat (+ its bridge) is live.
    await expect(
      s.as.mutation(api.financeRoles.grantFinanceRole, {
        personId: targetPersonId,
        role: "viewer",
        scope: "chapter",
      }),
    ).resolves.toBeDefined();

    await superuserAs.mutation(api.seats.unassignSeat, { assignmentId });

    // Gate now rejects — neither the seat-derived source nor the bridged
    // stored grant survive the unassign.
    const targetPersonId2 = await makeTargetPerson(s);
    await expect(
      s.as.mutation(api.financeRoles.grantFinanceRole, {
        personId: targetPersonId2,
        role: "viewer",
        scope: "chapter",
      }),
    ).rejects.toThrow();
  });

  test("a chapter_director seat (finance.approve + finance.viewer, no finance.manager) does NOT clear the manager-rank gate", async () => {
    const s = await seatSetup();
    const personId = await seedSelfPerson(s);
    await assignSeatDirect(s, personId, "chapter_director", s.chapterId);
    const targetPersonId = await makeTargetPerson(s);

    await expect(
      s.as.mutation(api.financeRoles.grantFinanceRole, {
        personId: targetPersonId,
        role: "viewer",
        scope: "chapter",
      }),
    ).rejects.toThrow();
  });

  test("a stored chapter manager grant with NO seat at all still clears the manager-rank gate — the residual side, pinned positively", async () => {
    const s = await seatSetup();
    const personId = await seedSelfPerson(s);
    await run(s.t, (ctx) =>
      ctx.db.insert("financeRoles", {
        chapterId: s.chapterId,
        personId,
        role: "manager",
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
    ).resolves.toBeDefined();
  });
});

describe("chapter_director finance.viewer — SEE, never RECORD/RECONCILE-write (owner decision, 2026-07-16)", () => {
  // Owner's verbatim intent: "Chapter Director does have financial powers,
  // they approve budgets, they can also see spending... they should see how
  // the money is spent as well. But they still need to get their things
  // reconciled by their treasurer or financial manager." This block pins the
  // SoD boundary that decision implies: `chapter_director` now derives
  // `financeRole: "viewer"` at its own chapter (a pure widening from `null`
  // — see `financeGatesSeatUnion`'s framing at the top of this file), which
  // clears every VIEWER-rank read gate but NONE of the BOOKKEEPER/MANAGER-
  // rank write gates.

  test("a chapter_director seat alone now clears dashboardChapter's viewer gate (previously null role, previously threw)", async () => {
    const s = await seatSetup();
    const cdPersonId = await seedSelfPerson(s);
    await assignSeatDirect(s, cdPersonId, "chapter_director", s.chapterId);

    await expect(
      s.as.query(api.finances.dashboardChapter, {}),
    ).resolves.toBeDefined();
  });

  test("a chapter_director seat alone now clears listReconcile's viewer gate — CD can see the reconcile grid", async () => {
    const s = await seatSetup();
    const cdPersonId = await seedSelfPerson(s);
    await assignSeatDirect(s, cdPersonId, "chapter_director", s.chapterId);

    await expect(
      s.as.query(api.finances.listReconcile, {}),
    ).resolves.toBeDefined();
  });

  test("a chapter_director seat does NOT clear the bookkeeper-rank write gate — setTransactionNote (reconcile-write) stays blocked", async () => {
    const s = await seatSetup();
    // A separate, ACTUAL bookkeeper records a transaction to annotate — the
    // CD identity (s.as) can't do this itself (createManualTransaction needs
    // bookkeeper+, which finance.viewer never grants).
    const bookkeeper = await addMember(s, {
      email: "bookkeeper@publicworship.life",
      name: "Bookkeeper",
    });
    await run(s.t, (ctx) =>
      ctx.db.insert("financeRoles", {
        chapterId: s.chapterId,
        personId: bookkeeper.personId,
        role: "bookkeeper",
        scope: "chapter",
        createdAt: Date.now(),
      }),
    );
    const txnId = await bookkeeper.as.mutation(api.finances.createManualTransaction, {
      flow: "outflow",
      amountCents: 4200,
      postedAt: Date.now(),
      merchantName: "Coffee Shop",
    });

    const cdPersonId = await seedSelfPerson(s);
    await assignSeatDirect(s, cdPersonId, "chapter_director", s.chapterId);

    await expect(
      s.as.mutation(api.finances.setTransactionNote, {
        transactionId: txnId,
        note: "CD trying to annotate — should be blocked",
      }),
    ).rejects.toThrow(/Bookkeeper finance role/);
  });

  test("a chapter_director seat does NOT clear the manager-rank gate — updateBudget stays blocked beyond what finance.approve allows", async () => {
    const s = await seatSetup();
    const manager = await addMember(s, {
      email: "manager@publicworship.life",
      name: "Manager",
    });
    await run(s.t, (ctx) =>
      ctx.db.insert("financeRoles", {
        chapterId: s.chapterId,
        personId: manager.personId,
        role: "manager",
        scope: "chapter",
        createdAt: Date.now(),
      }),
    );
    const budgetId = await manager.as.mutation(api.finances.createBudget, {
      amountCents: 100000,
      type: "recurring",
      cadence: "yearly",
      year: 2026,
      label: "Ops",
    });

    const cdPersonId = await seedSelfPerson(s);
    await assignSeatDirect(s, cdPersonId, "chapter_director", s.chapterId);

    await expect(
      s.as.mutation(api.finances.updateBudget, {
        budgetId,
        patch: { amountCents: 200000 },
      }),
    ).rejects.toThrow(/Manager finance role/);
  });

  test("KNOWN GAP, pre-existing and OUT OF SCOPE for this PR: a chapter_director seat ALONE still cannot approveBudget", async () => {
    // The owner's decision names approval as something CD "does have" today
    // — this test exists to actually VERIFY that claim against the real
    // gate, not just assume it. It does NOT hold: `president` (chapter_
    // director's `legacyTitle`) is a LEADERSHIP-kind specializedRoles title,
    // and `specializedRoles.ts`'s write-through only bridges a stored
    // `financeRoles` MANAGER grant for FINANCE-kind titles
    // (`bridgeFinanceManagerGrant` — see its module doc: "Leadership titles
    // (ED/president) ... do NOT themselves grant finance write capability" —
    // and its own TODO: "wire president/ED into approval flows ... out of
    // scope for this backend phase"). `finances.approveBudget`'s chapter path
    // gates on `requireFinanceManager` (manager rank) via
    // `loadBudgetForApprovalDecision`, NOT on `finance.approve` — and
    // `finance.approve` is explicitly documented (`lib/seats.ts`'s "Out of
    // scope" section) as NOT part of the graded ladder this file derives.
    // So a chapter_director holder with no OTHER grant fails this gate today,
    // seat or no seat — `finance.viewer` (this PR) doesn't change that; it
    // only widens READS. Wiring the president/ED bridge into approveBudget is
    // a separate, pre-existing TODO this PR deliberately does not touch
    // (out of ownership: `finances.ts`/`specializedRoles.ts`). This test pins
    // TODAY's real behavior so a future PR that adds that wiring trips this
    // test loudly, as a reminder to update it, instead of silently.
    const s = await seatSetup();
    const manager = await addMember(s, {
      email: "manager2@publicworship.life",
      name: "Manager",
    });
    await run(s.t, (ctx) =>
      ctx.db.insert("financeRoles", {
        chapterId: s.chapterId,
        personId: manager.personId,
        role: "manager",
        scope: "chapter",
        createdAt: Date.now(),
      }),
    );
    const budgetId = await manager.as.mutation(api.finances.createBudget, {
      amountCents: 100000,
      type: "recurring",
      cadence: "yearly",
      year: 2026,
      label: "Ops",
    });
    await manager.as.mutation(api.finances.submitBudgetForApproval, { budgetId });

    const cdPersonId = await seedSelfPerson(s);
    await assignSeatDirect(s, cdPersonId, "chapter_director", s.chapterId);

    await expect(
      s.as.mutation(api.finances.approveBudget, { budgetId }),
    ).rejects.toThrow(/Manager finance role/);
  });

  test("treasurer's derived role is unaffected by chapter_director's new capability — still manager-rank, no viewer bleed", async () => {
    const s = await seatSetup();
    const treasurerPersonId = await seedSelfPerson(s);
    await assignSeatDirect(s, treasurerPersonId, "treasurer", s.chapterId);

    await expect(
      s.as.query(api.finances.dashboardChapter, {}),
    ).resolves.toBeDefined();
    const targetPersonId = await makeTargetPerson(s);
    await expect(
      s.as.mutation(api.financeRoles.grantFinanceRole, {
        personId: targetPersonId,
        role: "viewer",
        scope: "chapter",
      }),
    ).resolves.toBeDefined(); // manager rank still clears the manager gate
  });

  test("a bare central financeRoles viewer grant with no seat — the residual layer — is unaffected by this change", async () => {
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
