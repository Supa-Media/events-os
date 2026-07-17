import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
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
import { CENTRAL } from "@events-os/shared";

/**
 * WP-wave4 (item 1) — central budget EDIT widened for the ED seat.
 *
 * Empirically proven gap: `executive_director`'s seat carries `finance.central`
 * (so `requireFinanceCentral`'s reach-only check already passes for an
 * ED-seat-only holder — used by `createBudget`/`updateBudget`'s central
 * branch) but deliberately NOT `finance.manager` (see `SEAT_DEFS` in
 * `@events-os/shared`) — so `getSeatDerivedCapabilities` never derives a
 * graded role for them. `budgetLines.ts`'s central read/write gate
 * (`requireCentralFinanceRole`, central reach AND bookkeeper+ rank) is the
 * one path that DID block a pure ED-seat holder: `access.role` stays `null`
 * with no other grant, and `financeRoleAtLeast(null, "bookkeeper")` always
 * fails.
 *
 * The fix: `lib/finance.ts#requireCentralFinanceRoleOrEdSeat` — accepts
 * EITHER central reach at the graded rank (unchanged — Treasurer/FM path) OR
 * the caller holding a central-chart seat carrying `finance.approve` (today
 * only `executive_director`). `budgetLines.ts`'s `requireLineReadAccess`/
 * `requireLineWriteAccess` central branches now call it. This is the EDIT
 * surface, distinct from the approval DECISION
 * (`loadBudgetForApprovalDecision` stays on `requireCentralEdOrFm`,
 * title-based, unchanged — covered by `cdBudgetApproval.test.ts`'s own
 * "central approval still requires the ED/FM title" regression).
 */

async function seatSetup(
  opts: { email?: string; chapterName?: string } = {},
): Promise<ChapterSetup> {
  const t = newT();
  await run(t, (ctx) => runSeedSeatDefs(ctx));
  return setupChapter(t, opts);
}

async function seedSelfPerson(s: ChapterSetup, name = "Caller"): Promise<Id<"people">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name,
      userId: s.userId,
      isTeamMember: true,
      createdAt: Date.now(),
    }),
  );
}

async function grantRole(
  s: ChapterSetup,
  personId: Id<"people">,
  role: "viewer" | "bookkeeper" | "manager",
  scope: "chapter" | "central" = "chapter",
): Promise<void> {
  await run(s.t, (ctx) =>
    ctx.db.insert("financeRoles", {
      chapterId: s.chapterId,
      personId,
      role,
      scope,
      createdAt: Date.now(),
    }),
  );
}

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

/** A central budget, created by `s.as` after granting it a stored central
 *  manager role for JUST this creation call (unrelated identity to the
 *  ED-seat holder under test — mirrors `createChapterBudget`'s role in
 *  `cdBudgetApproval.test.ts`). */
async function createCentralBudget(s: ChapterSetup, amountCents = 100000): Promise<Id<"budgets">> {
  const creatorPersonId = await seedSelfPerson(s, "Creator");
  await grantRole(s, creatorPersonId, "manager", "central");
  return s.as.mutation(api.finances.createBudget, {
    amountCents,
    type: "recurring",
    cadence: "yearly",
    year: 2026,
    central: true,
    label: "Central Ops",
  });
}

async function getBudget(s: ChapterSetup, budgetId: Id<"budgets">) {
  return run(s.t, (ctx) => ctx.db.get(budgetId));
}

describe("ED seat edits central budgets — the positive fix (WP-wave4 item 1)", () => {
  test("an ED-seat-only holder (no manager rank, no other grant) can add a budget LINE to a central budget", async () => {
    const s = await seatSetup();
    const budgetId = await createCentralBudget(s);

    const ed = await addMember(s, { email: "ed@publicworship.life", name: "ED" });
    await assignSeatDirect(s, ed.personId, "executive_director", CENTRAL);
    // Deliberately NO financeRoles grant of any kind — the seat alone.

    const lineId = await ed.as.mutation(api.budgetLines.addLine, {
      budgetId,
      description: "Facebook Ads",
      plannedCents: 40000,
    });
    expect(lineId).toBeDefined();

    const lines = await ed.as.query(api.budgetLines.listLines, { budgetId });
    expect(lines.map((l) => l.id)).toContain(lineId);
  });

  test("an ED-seat-only holder can update and remove a central budget's line", async () => {
    const s = await seatSetup();
    const budgetId = await createCentralBudget(s);

    const ed = await addMember(s, { email: "ed@publicworship.life", name: "ED" });
    await assignSeatDirect(s, ed.personId, "executive_director", CENTRAL);

    const lineId = await ed.as.mutation(api.budgetLines.addLine, {
      budgetId,
      description: "Venue",
      plannedCents: 20000,
    });
    await ed.as.mutation(api.budgetLines.updateLine, {
      lineId,
      patch: { plannedCents: 25000 },
    });
    let lines = await ed.as.query(api.budgetLines.listLines, { budgetId });
    expect(lines.find((l) => l.id === lineId)?.plannedCents).toBe(25000);

    await ed.as.mutation(api.budgetLines.removeLine, { lineId });
    lines = await ed.as.query(api.budgetLines.listLines, { budgetId });
    expect(lines.some((l) => l.id === lineId)).toBe(false);
  });

  test("an ED-seat-only holder can edit the central budget's own amount via updateBudget (already worked — the reach-only gate, unaffected)", async () => {
    const s = await seatSetup();
    const budgetId = await createCentralBudget(s, 100000);

    const ed = await addMember(s, { email: "ed@publicworship.life", name: "ED" });
    await assignSeatDirect(s, ed.personId, "executive_director", CENTRAL);

    await ed.as.mutation(api.finances.updateBudget, {
      budgetId,
      patch: { amountCents: 150000 },
    });
    const doc = await getBudget(s, budgetId);
    expect(doc?.amountCents).toBe(150000);
  });

  test("an ED-seat-only holder can send their own central draft for review (submitBudgetForApproval widened too)", async () => {
    const s = await seatSetup();
    const ed = await addMember(s, { email: "ed@publicworship.life", name: "ED" });
    await assignSeatDirect(s, ed.personId, "executive_director", CENTRAL);

    const budgetId = await ed.as.mutation(api.finances.createBudget, {
      amountCents: 50000,
      type: "recurring",
      cadence: "yearly",
      year: 2026,
      central: true,
      label: "ED's own budget",
    });
    const doc0 = await getBudget(s, budgetId);
    expect(doc0?.approvalStatus).toBe("draft");

    await ed.as.mutation(api.finances.submitBudgetForApproval, { budgetId });
    const doc = await getBudget(s, budgetId);
    expect(doc?.approvalStatus).toBe("submitted");
  });
});

describe("ED seat still cannot self-approve — SoD unchanged (WP-wave4 item 1)", () => {
  test("an ED who submits their own central budget cannot approve it themselves", async () => {
    const s = await seatSetup();
    const ed = await addMember(s, { email: "ed@publicworship.life", name: "ED" });
    await assignSeatDirect(s, ed.personId, "executive_director", CENTRAL);

    const budgetId = await ed.as.mutation(api.finances.createBudget, {
      amountCents: 50000,
      type: "recurring",
      cadence: "yearly",
      year: 2026,
      central: true,
      label: "ED's own budget",
    });
    await ed.as.mutation(api.finances.submitBudgetForApproval, { budgetId });

    // The ED's seat DOES carry `finance.approve` (they'd otherwise be able to
    // approve at all — see `loadBudgetForApprovalDecision`'s title-based
    // `requireCentralEdOrFm`, unchanged), but identity SoD still blocks
    // approving their OWN submission regardless of role/seat.
    await expect(
      ed.as.mutation(api.finances.approveBudget, { budgetId }),
    ).rejects.toBeInstanceOf(ConvexError);

    const doc = await getBudget(s, budgetId);
    expect(doc?.approvalStatus).toBe("submitted");
  });
});

describe("a chapter Chapter Director's seat never widens central access (WP-wave4 item 1)", () => {
  test("a CD-seat-only holder (their OWN chapter) cannot add a line to a central budget", async () => {
    const s = await seatSetup();
    const budgetId = await createCentralBudget(s);

    const cd = await addMember(s, { email: "cd@publicworship.life", name: "CD" });
    await assignSeatDirect(s, cd.personId, "chapter_director", s.chapterId);
    // A chapter_director seat's scope is the CALLER's own chapter — never
    // "central" — so `holdsApprovalSeatAt(ctx, personId, "central")` must
    // never see it.

    await expect(
      cd.as.mutation(api.budgetLines.addLine, {
        budgetId,
        description: "Should be rejected",
        plannedCents: 1000,
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("a CD-seat-only holder cannot read a central budget's lines either", async () => {
    const s = await seatSetup();
    const budgetId = await createCentralBudget(s);

    const cd = await addMember(s, { email: "cd@publicworship.life", name: "CD" });
    await assignSeatDirect(s, cd.personId, "chapter_director", s.chapterId);

    await expect(
      cd.as.query(api.budgetLines.listLines, { budgetId }),
    ).rejects.toBeInstanceOf(ConvexError);
  });
});

describe("regression — the manager-rank path is unchanged (WP-wave4 item 1)", () => {
  test("a central financeRoles manager (no seat at all — the FM/Treasurer path) still edits central budget lines", async () => {
    const s = await seatSetup();
    const budgetId = await createCentralBudget(s);

    const fm = await addMember(s, { email: "fm@publicworship.life", name: "FM" });
    await grantRole(s, fm.personId, "manager", "central"); // stored grant, NO seat

    const lineId = await fm.as.mutation(api.budgetLines.addLine, {
      budgetId,
      description: "Ops",
      plannedCents: 10000,
    });
    expect(lineId).toBeDefined();
  });

  test("a central VIEWER (rank too low, no ED seat) is still rejected from writing a line", async () => {
    const s = await seatSetup();
    const budgetId = await createCentralBudget(s);

    const viewer = await addMember(s, { email: "viewer@publicworship.life", name: "Viewer" });
    await grantRole(s, viewer.personId, "viewer", "central");

    await expect(
      viewer.as.mutation(api.budgetLines.addLine, {
        budgetId,
        description: "Should be rejected",
        plannedCents: 1000,
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("a plain member with no seat and no grant cannot touch a central budget's lines", async () => {
    const s = await seatSetup();
    const budgetId = await createCentralBudget(s);

    const plain = await addMember(s, { email: "plain@publicworship.life", name: "Plain" });
    await expect(
      plain.as.query(api.budgetLines.listLines, { budgetId }),
    ).rejects.toBeInstanceOf(ConvexError);
  });
});
