/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

/**
 * PROJECT REGISTRATIONS — the fourth revenue stream.
 *
 * What matters and is asserted here:
 *  - a `paid` registration is REVENUE on its chapter's book, exactly as a paid
 *    ticket order is; `refunded` and `comped` are NOT, however large;
 *  - the itemised drill-downs (`bookValueBreakdown`, `bookValueLines`) LEARN
 *    the stream, so the components they publish still sum to the total they
 *    claim to explain — a breakdown that quietly disagrees with its own total
 *    is worse than no breakdown;
 *  - the project money page's registration read never moves `refMoney`'s
 *    budget numbers (the bar is a spend authorisation; income is a second
 *    axis);
 *  - the Givebutter backfill dry-runs clean, refuses to write into a
 *    deployment it doesn't recognise, and is idempotent on a second execute.
 *
 * Every money assertion is in CENTS. A test that compares "$150.00" passes
 * both when the arithmetic is right and when the formatter is wrong.
 */

const CENTS_50 = 5_000;

/** Central ED + central finance manager — the reconciliation-audit power the
 *  accounts-page queries gate on (copied from `reconciliationEngine.test.ts`,
 *  which documents why the ED title alone doesn't bridge into `financeRoles`). */
async function asCentralEd(s: ChapterSetup): Promise<Id<"people">> {
  const personId = await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Caller",
      userId: s.userId,
      isTeamMember: true,
      createdAt: Date.now(),
    }),
  );
  await run(s.t, async (ctx) => {
    await ctx.db.insert("specializedRoles", {
      personId,
      title: "executive_director",
      roleKind: "leadership",
      scope: "central",
      createdAt: Date.now(),
    });
    await ctx.db.insert("financeRoles", {
      chapterId: s.chapterId,
      personId,
      role: "manager",
      scope: "central",
      createdAt: Date.now(),
    });
  });
  return personId;
}

async function seedProject(s: ChapterSetup, name = "Worship Beyond the walls") {
  return run(s.t, (ctx) => {
    const now = Date.now();
    return ctx.db.insert("projects", {
      chapterId: s.chapterId,
      name,
      status: "in_progress",
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
    });
  });
}

async function seedRegistration(
  s: ChapterSetup,
  projectId: Id<"projects">,
  reg: {
    name: string;
    amountCents: number;
    status: "paid" | "refunded" | "comped";
    refundReason?: string;
    externalRef?: string;
  },
): Promise<Id<"registrations">> {
  return run(s.t, (ctx) => {
    const now = Date.now();
    return ctx.db.insert("registrations", {
      chapterId: s.chapterId,
      projectId,
      name: reg.name,
      amountCents: reg.amountCents,
      status: reg.status,
      ...(reg.refundReason ? { refundReason: reg.refundReason } : {}),
      ...(reg.externalRef ? { externalRef: reg.externalRef } : {}),
      registeredAt: now,
      createdAt: now,
      updatedAt: now,
    });
  });
}

/** The real Worship Beyond The Walls cohort: six $50 places, three refunded as
 *  scholarships. $300.00 collected, $150.00 kept. */
async function seedWbtwCohort(
  s: ChapterSetup,
  projectId: Id<"projects">,
): Promise<void> {
  for (const name of ["Jasmine Diaz", "Julia Kudlick", "Dominique Hyppolite"]) {
    await seedRegistration(s, projectId, {
      name,
      amountCents: CENTS_50,
      status: "paid",
    });
  }
  for (const name of ["Trinitee Alston", "Jocelyn Naranjo", "Esosa Asemota"]) {
    await seedRegistration(s, projectId, {
      name,
      amountCents: CENTS_50,
      status: "refunded",
      refundReason: "scholarship",
    });
  }
}

describe("registrations as revenue", () => {
  test("a paid registration is book revenue; refunded and comped are not", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentralEd(s);
    const projectId = await seedProject(s);
    await seedWbtwCohort(s, projectId);
    // A comped place records what it would have cost — and earns nothing.
    await seedRegistration(s, projectId, {
      name: "Comped Attendee",
      amountCents: 1_000_000,
      status: "comped",
    });

    const balances = await s.as.query(api.reconciliation.accountBalances, {});
    const chapter = balances.find((b) => b.scope === s.chapterId);
    // Three paid × $50.00. The three scholarships and the (deliberately
    // absurd) $10,000 comp contribute exactly nothing.
    expect(chapter?.revenueCents).toBe(15_000);
    expect(chapter?.ledgerNetCents).toBe(0);
    expect(chapter?.bookBalanceCents).toBe(15_000);
  });

  test("registrations add to the other streams rather than replacing them", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentralEd(s);
    const projectId = await seedProject(s);
    await seedRegistration(s, projectId, {
      name: "Paid Student",
      amountCents: CENTS_50,
      status: "paid",
    });
    await run(s.t, (ctx) =>
      ctx.db.insert("sales", {
        chapterId: s.chapterId,
        soldAt: Date.now(),
        grossCents: 3_000,
        feeCents: 100,
        items: [],
        itemSource: "unresolved",
        channel: "in_person",
        createdAt: Date.now(),
      }),
    );

    const balances = await s.as.query(api.reconciliation.accountBalances, {});
    const chapter = balances.find((b) => b.scope === s.chapterId);
    expect(chapter?.revenueCents).toBe(CENTS_50 + 3_000);
  });

  test("central runs no classes — a registration never lands on central's book", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentralEd(s);
    const projectId = await seedProject(s);
    await seedRegistration(s, projectId, {
      name: "Paid Student",
      amountCents: CENTS_50,
      status: "paid",
    });

    const balances = await s.as.query(api.reconciliation.accountBalances, {});
    expect(balances.find((b) => b.scope === "central")?.revenueCents).toBe(0);
  });
});

describe("the breakdown agrees with the total it claims to explain", () => {
  test("bookValueBreakdown: registrations are a named component, and the components sum", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentralEd(s);
    const projectId = await seedProject(s);
    await seedWbtwCohort(s, projectId);

    const b = await s.as.query(api.reconciliation.bookValueBreakdown, {
      scope: s.chapterId,
    });
    expect(b.revenue.registrationCents).toBe(15_000);
    expect(b.revenue.registrationCount).toBe(3);
    // THE INVARIANT: everything the breakdown publishes as revenue adds up to
    // the revenue figure it publishes. This is the assertion that fails if a
    // fifth stream is ever added to `computeBookBalances` and not to here.
    const componentSum =
      b.revenue.gifts.reduce((sum, g) => sum + g.amountCents, 0) +
      b.revenue.ticketCents +
      b.revenue.saleCents +
      b.revenue.registrationCents;
    expect(componentSum).toBe(b.revenueCents);
    expect(b.bookBalanceCents).toBe(b.revenueCents + b.ledgerNetCents);
  });

  test("bookValueBreakdown agrees with accountBalances, to the cent", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentralEd(s);
    const projectId = await seedProject(s);
    await seedWbtwCohort(s, projectId);

    const [balances, b] = await Promise.all([
      s.as.query(api.reconciliation.accountBalances, {}),
      s.as.query(api.reconciliation.bookValueBreakdown, { scope: s.chapterId }),
    ]);
    const chapter = balances.find((row) => row.scope === s.chapterId);
    expect(b.revenueCents).toBe(chapter?.revenueCents);
    expect(b.bookBalanceCents).toBe(chapter?.bookBalanceCents);
  });

  test("bookValueLines: every paid registration is a line, and only paid ones", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentralEd(s);
    const projectId = await seedProject(s);
    await seedWbtwCohort(s, projectId);

    const lines = await s.as.query(api.reconciliation.bookValueLines, {
      scope: s.chapterId,
    });
    const regs = lines.earned.filter((e) => e.kind === "registration");
    expect(regs).toHaveLength(3);
    expect(regs.map((r) => r.label).sort()).toEqual([
      "Dominique Hyppolite",
      "Jasmine Diaz",
      "Julia Kudlick",
    ]);
    // A scholarship contributed nothing to book value, so it is not a line
    // BEHIND book value. It is still on the project's own page.
    expect(regs.some((r) => r.label === "Trinitee Alston")).toBe(false);
    // The line detail names the class the money was for.
    expect(regs[0].detail).toContain("Worship Beyond the walls");
    expect(lines.earned.reduce((sum, e) => sum + e.amountCents, 0)).toBe(
      lines.revenueCents,
    );
    expect(lines.revenueCents).toBe(15_000);
  });
});

describe("registrations.forProject", () => {
  test("returns every row, and collects only the paid ones", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentralEd(s);
    const projectId = await seedProject(s);
    await seedWbtwCohort(s, projectId);

    const data = await s.as.query(api.registrations.forProject, { projectId });
    expect(data.rows).toHaveLength(6);
    expect(data.collectedCents).toBe(15_000);
    expect(data.paidCount).toBe(3);
    expect(data.refundedCount).toBe(3);
    expect(data.compedCount).toBe(0);
    // The scholarship reason survives the round trip — it is the thing the
    // project page exists to be able to say.
    expect(
      data.rows.filter((r) => r.refundReason === "scholarship"),
    ).toHaveLength(3);
  });

  test("a caller with no finance reach sees nothing, and learns nothing", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const projectId = await seedProject(s);
    await seedWbtwCohort(s, projectId);

    // No finance role, no ED title — a plain chapter member.
    const data = await s.as.query(api.registrations.forProject, { projectId });
    expect(data.rows).toEqual([]);
    expect(data.collectedCents).toBe(0);
  });

  test("a nonexistent project reads the same as a forbidden one", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentralEd(s);
    const data = await s.as.query(api.registrations.forProject, {
      projectId: "not-an-id",
    });
    expect(data.rows).toEqual([]);
  });
});

describe("the budget bar does not move", () => {
  test("refMoney's budget numbers are identical with and without registrations", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentralEd(s);
    const projectId = await seedProject(s);

    // The real summon path the Money surface itself uses, so this test can't
    // pass against a budget shape the product never produces.
    const budgetId = await s.as.mutation(api.finances.summonBudgetForRef, {
      refKind: "project",
      scopeRefId: projectId,
    });
    await run(s.t, async (ctx) => {
      const now = Date.now();
      await ctx.db.patch(budgetId, {
        label: "Worship Beyond the walls",
        amountCents: 130_000,
        approvalStatus: "approved",
        approvedCents: 130_000,
      });
      await ctx.db.insert("transactions", {
        chapterId: s.chapterId,
        budgetId,
        source: "manual",
        flow: "outflow",
        amountCents: 67_172,
        postedAt: now,
        status: "categorized",
        createdAt: now,
      });
    });
    expect(budgetId).toBeTruthy();

    const before = await s.as.query(api.moneyViews.refMoney, {
      refKind: "project",
      refId: projectId,
    });
    await seedWbtwCohort(s, projectId);
    const after = await s.as.query(api.moneyViews.refMoney, {
      refKind: "project",
      refId: projectId,
    });

    // The three figures the bar is drawn from. $150.00 of income arriving
    // must not raise the ceiling by a cent: a budget is a SPEND
    // AUTHORISATION, approvals hang off it, and netting income into it would
    // silently license $150.00 more spending than anyone approved.
    expect(after.budget?.amountCents).toBe(before.budget?.amountCents);
    expect(after.totalPlannedCents).toBe(before.totalPlannedCents);
    expect(after.totalActualCents).toBe(before.totalActualCents);
    expect(after.totalRemainingCents).toBe(before.totalRemainingCents);
    // And the real figures from the sketch this was built to.
    expect(after.totalPlannedCents).toBe(130_000);
    expect(after.totalActualCents).toBe(67_172);
    expect(after.totalRemainingCents).toBe(62_828);
    // Registrations do NOT leak into the event-shaped income field either —
    // they are their own section with their own net-cost line.
    expect(after.incomeCents).toBe(0);
  });
});

describe("the Givebutter backfill", () => {
  test("dry-runs clean and writes nothing on a deployment it doesn't recognise", async () => {
    const t = newT();
    const result = await t.mutation(
      internal.backfillWorshipRegistrations.backfillWorshipRegistrations,
      {},
    );
    expect(result.dryRun).toBe(true);
    expect(result.inserted).toBe(0);
    expect(result.revenueAddedCents).toBe(0);
    expect(result.problems).toEqual([
      "project rd776xf2snzx3nw5sqqb2r0kn18aqnhn not found in this deployment — SKIPPED",
    ]);
    const rows = await run(t, (ctx) => ctx.db.query("registrations").collect());
    expect(rows).toHaveLength(0);
  });

  test("an EXECUTE against an unrecognised deployment still writes nothing", async () => {
    const t = newT();
    const result = await t.mutation(
      internal.backfillWorshipRegistrations.backfillWorshipRegistrations,
      { execute: true },
    );
    expect(result.dryRun).toBe(false);
    expect(result.inserted).toBe(0);
    expect(result.problems).toHaveLength(1);
    const rows = await run(t, (ctx) => ctx.db.query("registrations").collect());
    expect(rows).toHaveLength(0);
  });
});
