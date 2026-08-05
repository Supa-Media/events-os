/// <reference types="vite/client" />
import { afterEach, describe, expect, test, vi } from "vitest";
import { ConvexError } from "convex/values";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { CENTRAL, countsAsSpend } from "@events-os/shared";

/**
 * The generic manual central↔chapter transfer (retired 2026-07-26: the
 * skim/launch-grant/settlement automation collapsed into ONE
 * `recordTransfer` mutation — see `transfers.ts`'s header comment for the
 * full history and rationale).
 *
 * A transfer is still a PAIR of `flow:"transfer"` transactions linked by a
 * shared `transferGroupId`; excluded from spend everywhere; integer cents.
 * Unlike the retired kinds, there's no natural per-period dedup key — a
 * chapter can be transferred to/from as many times as a treasurer likes, any
 * day — so `transferGroupId` is random-but-explicit
 * (`transfer-<chapter>-<postedAt>-<8 hex>`), and `ALREADY_RECORDED` is tested
 * here as defense-in-depth against a genuine collision (mocked), not as the
 * "same month twice" guard the old tests exercised.
 *
 * Historical `source:"skim"`/`"launch_grant"`/`"settlement"` rows (written
 * before the collapse) are simulated here with raw `ctx.db.insert` calls —
 * there's no mutation left that writes those sources — to prove
 * `dashboardCentral.cityLaunchFund` and `interScopeBalances` still net them
 * correctly alongside new `"transfer"` rows.
 */

function seedSelfPerson(s: ChapterSetup): Promise<Id<"people">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Caller",
      userId: s.userId,
      isTeamMember: true,
      createdAt: Date.now(),
    }),
  );
}

/** A central-scope finance role at a chosen rank (person owned by the caller). */
async function asCentral(
  s: ChapterSetup,
  role: "viewer" | "bookkeeper" | "manager",
): Promise<Id<"people">> {
  const personId = await seedSelfPerson(s);
  await run(s.t, (ctx) =>
    ctx.db.insert("financeRoles", {
      chapterId: s.chapterId,
      personId,
      role,
      scope: "central",
      createdAt: Date.now(),
    }),
  );
  return personId;
}

/** A central ED/FM — the seat `recordTransfer` requires for the
 *  `central_to_chapter` direction (money LEAVING central), preserving the
 *  retired launch grant's #149 gate. Layered ON TOP of a central finance
 *  grant, since the mutation also resolves a central finance role. */
async function asCentralEdOrFm(s: ChapterSetup): Promise<Id<"people">> {
  const personId = await asCentral(s, "bookkeeper");
  await run(s.t, (ctx) =>
    ctx.db.insert("specializedRoles", {
      personId,
      title: "executive_director",
      roleKind: "leadership",
      scope: "central",
      createdAt: Date.now(),
    }),
  );
  return personId;
}

/** A chapter-only manager (person + manager grant, chapter scope). */
async function asChapterManager(s: ChapterSetup): Promise<Id<"people">> {
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
  return personId;
}

async function makeChapter(s: ChapterSetup, name: string): Promise<Id<"chapters">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("chapters", { name, isActive: true, createdAt: Date.now() }),
  );
}

/** Insert an ACTIVE production Increase account for a scope (still used by
 *  `transferReadiness`, which is kept — see `transfers.ts`'s doc comment). */
async function seedActiveAccount(
  s: ChapterSetup,
  scope: Id<"chapters"> | typeof CENTRAL,
  increaseAccountId: string,
): Promise<void> {
  await run(s.t, (ctx) =>
    ctx.db.insert("increaseAccounts", {
      chapterId: scope,
      sandbox: false,
      increaseAccountId,
      increaseEntityId: "entity_shared",
      onboardingStatus: "active",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
}

function legsFor(s: ChapterSetup, transferGroupId: string) {
  return run(s.t, (ctx) =>
    ctx.db
      .query("transactions")
      .withIndex("by_transfer_group", (q) =>
        q.eq("transferGroupId", transferGroupId),
      )
      .collect(),
  );
}

/**
 * Insert a HISTORICAL transfer leg directly (bypassing the mutation layer,
 * since no mutation writes these sources anymore) — simulates a row written
 * before the 2026-07-26 collapse, to prove read paths (`dashboardCentral`,
 * `interScopeBalances`) still handle it.
 */
async function insertHistoricalLeg(
  s: ChapterSetup,
  args: {
    chapterId: Id<"chapters"> | typeof CENTRAL;
    source: "skim" | "launch_grant" | "settlement" | "transfer";
    amountCents: number;
    postedAt: number;
    transferGroupId: string;
    transferDirection?: "central_to_chapter" | "chapter_to_central";
    externalId?: string;
  },
): Promise<Id<"transactions">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("transactions", {
      chapterId: args.chapterId,
      source: args.source,
      flow: "transfer",
      amountCents: args.amountCents,
      currency: "usd",
      postedAt: args.postedAt,
      transferGroupId: args.transferGroupId,
      transferDirection: args.transferDirection,
      externalId: args.externalId,
      status: "reconciled",
      createdAt: Date.now(),
    }),
  );
}

const MARCH_2026 = Date.UTC(2026, 2, 10, 16); // noon-ish ET, March 10 2026
const APRIL_2026 = Date.UTC(2026, 3, 10, 16);

// ── recordTransfer — the ledger pair ──────────────────────────────────────────

describe("recordTransfer — the ledger pair", () => {
  test("chapter_to_central: chapter outflow → central inflow", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentral(s, "bookkeeper");

    const res = await s.as.mutation(api.transfers.recordTransfer, {
      direction: "chapter_to_central",
      chapterId: s.chapterId,
      amountCents: 42_000,
      postedAt: MARCH_2026,
      note: "March skim commitment",
    });
    expect(res.amountCents).toBe(42_000);

    const legs = await legsFor(s, res.transferGroupId);
    expect(legs.length).toBe(2);
    for (const leg of legs) {
      expect(leg.flow).toBe("transfer");
      expect(leg.source).toBe("transfer");
      expect(leg.amountCents).toBe(42_000);
      expect(leg.transferDirection).toBe("chapter_to_central");
      expect(countsAsSpend(leg.flow)).toBe(false);
    }
    const chapterLeg = legs.find((l) => l.chapterId === s.chapterId);
    const centralLeg = legs.find((l) => l.chapterId === CENTRAL);
    expect(chapterLeg?._id).toBe(res.outflowId); // the chapter pays out
    expect(centralLeg?._id).toBe(res.inflowId); // central receives
  });

  test("central_to_chapter: central outflow → chapter inflow (e.g. a launch grant)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentralEdOrFm(s);
    const newChapter = await makeChapter(s, "Boston");

    const res = await s.as.mutation(api.transfers.recordTransfer, {
      direction: "central_to_chapter",
      chapterId: newChapter,
      amountCents: 780_000,
      postedAt: MARCH_2026,
      note: "Launch grant — equipment + training trip",
    });

    const legs = await legsFor(s, res.transferGroupId);
    expect(legs.length).toBe(2);
    const centralLeg = legs.find((l) => l.chapterId === CENTRAL);
    const chapterLeg = legs.find((l) => l.chapterId === newChapter);
    expect(centralLeg?._id).toBe(res.outflowId); // central pays out
    expect(chapterLeg?._id).toBe(res.inflowId); // the new chapter receives
    for (const leg of legs) {
      expect(leg.source).toBe("transfer");
      expect(leg.transferDirection).toBe("central_to_chapter");
    }
  });

  test("rejects a non-positive or fractional amount", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentral(s, "bookkeeper");
    await expect(
      s.as.mutation(api.transfers.recordTransfer, {
        direction: "chapter_to_central",
        chapterId: s.chapterId,
        amountCents: 0,
        postedAt: MARCH_2026,
      }),
    ).rejects.toThrow(ConvexError);
    await expect(
      s.as.mutation(api.transfers.recordTransfer, {
        direction: "chapter_to_central",
        chapterId: s.chapterId,
        amountCents: 100.5,
        postedAt: MARCH_2026,
      }),
    ).rejects.toThrow(ConvexError);
  });

  test("rejects an invalid postedAt", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentral(s, "bookkeeper");
    await expect(
      s.as.mutation(api.transfers.recordTransfer, {
        direction: "chapter_to_central",
        chapterId: s.chapterId,
        amountCents: 10_000,
        postedAt: 0,
      }),
    ).rejects.toThrow(ConvexError);
  });

  test("no natural period key: the SAME chapter can be transferred to/from twice in one day", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentral(s, "bookkeeper");
    const first = await s.as.mutation(api.transfers.recordTransfer, {
      direction: "chapter_to_central",
      chapterId: s.chapterId,
      amountCents: 5_000,
      postedAt: MARCH_2026,
    });
    const second = await s.as.mutation(api.transfers.recordTransfer, {
      direction: "chapter_to_central",
      chapterId: s.chapterId,
      amountCents: 7_000,
      postedAt: MARCH_2026,
    });
    expect(first.transferGroupId).not.toBe(second.transferGroupId);
    expect((await legsFor(s, first.transferGroupId)).length).toBe(2);
    expect((await legsFor(s, second.transferGroupId)).length).toBe(2);
  });

  test("idempotency: a genuine transferGroupId collision is REJECTED (defense in depth)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentral(s, "bookkeeper");
    // Force `crypto.randomUUID()` to return the same value twice so the two
    // calls collide on the SAME `transferGroupId` — this is the scenario
    // `recordTransferPair`'s `ALREADY_RECORDED` guard defends against, even
    // though a real collision is astronomically unlikely in production.
    const spy = vi
      .spyOn(crypto, "randomUUID")
      .mockReturnValue("00000000-0000-0000-0000-000000000000");
    try {
      const args = {
        direction: "chapter_to_central" as const,
        chapterId: s.chapterId,
        amountCents: 10_000,
        postedAt: MARCH_2026,
      };
      const first = await s.as.mutation(api.transfers.recordTransfer, args);
      await expect(
        s.as.mutation(api.transfers.recordTransfer, args),
      ).rejects.toThrow(/already been recorded/i);
      // Still exactly one pair (two legs) — the reject didn't add a third leg.
      const legs = await legsFor(s, first.transferGroupId);
      expect(legs.length).toBe(2);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("recordTransfer — excluded from spend + drives the City Launch Fund position", () => {
  test("a transfer never counts as spend", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentral(s, "bookkeeper");

    await s.as.mutation(api.transfers.recordTransfer, {
      direction: "chapter_to_central",
      chapterId: s.chapterId,
      amountCents: 40_000,
      postedAt: MARCH_2026,
    });

    const dash = await s.as.query(api.finances.dashboardCentral, {
      year: 2026,
      month: 3,
    });
    expect(dash.totalMonthSpendCents).toBe(0);
    expect(dash.orgUnattributedCents).toBe(0);
  });
});

describe("recordTransfer — authz", () => {
  test("chapter manager (no central reach) is FORBIDDEN, either direction", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    await expect(
      s.as.mutation(api.transfers.recordTransfer, {
        direction: "chapter_to_central",
        chapterId: s.chapterId,
        amountCents: 10_000,
        postedAt: MARCH_2026,
      }),
    ).rejects.toThrow(/FORBIDDEN/);
    await expect(
      s.as.mutation(api.transfers.recordTransfer, {
        direction: "central_to_chapter",
        chapterId: s.chapterId,
        amountCents: 10_000,
        postedAt: MARCH_2026,
      }),
    ).rejects.toThrow(/FORBIDDEN/);
  });

  test("central VIEWER is FORBIDDEN on the write (needs bookkeeper+)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentral(s, "viewer");
    await expect(
      s.as.mutation(api.transfers.recordTransfer, {
        direction: "chapter_to_central",
        chapterId: s.chapterId,
        amountCents: 10_000,
        postedAt: MARCH_2026,
      }),
    ).rejects.toThrow(ConvexError);
  });

  test("central bookkeeper CAN record chapter_to_central (money arriving)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentral(s, "bookkeeper");
    await expect(
      s.as.mutation(api.transfers.recordTransfer, {
        direction: "chapter_to_central",
        chapterId: s.chapterId,
        amountCents: 37_500,
        postedAt: MARCH_2026,
        note: "The 15% commitment, moved by hand",
      }),
    ).resolves.toBeTruthy();
  });

  // The collapse to one mutation must NOT weaken the strongest gate any of the
  // three retired variants had: the launch grant (central → chapter) required
  // central ED/FM (#149). A bookkeeper could never move money OUT of central.
  test("central bookkeeper is FORBIDDEN on central_to_chapter (money leaving central needs ED/FM)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentral(s, "bookkeeper");
    const newChapter = await makeChapter(s, "Boston");
    await expect(
      s.as.mutation(api.transfers.recordTransfer, {
        direction: "central_to_chapter",
        chapterId: newChapter,
        amountCents: 780_000,
        postedAt: MARCH_2026,
        note: "Launch grant",
      }),
    ).rejects.toThrow();
  });

  test("central ED/FM CAN record central_to_chapter (the retired launch grant's own gate)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentralEdOrFm(s);
    const newChapter = await makeChapter(s, "Boston");
    await expect(
      s.as.mutation(api.transfers.recordTransfer, {
        direction: "central_to_chapter",
        chapterId: newChapter,
        amountCents: 780_000,
        postedAt: MARCH_2026,
        note: "Launch grant",
      }),
    ).resolves.toBeTruthy();
  });
});

// ── dashboardCentral.cityLaunchFund — position tracking ───────────────────────

describe("dashboardCentral.cityLaunchFund — generic transfer + historical sources", () => {
  test("chapter_to_central transfers count as received; central_to_chapter as made", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentralEdOrFm(s);
    const newChapter = await makeChapter(s, "Boston");

    await s.as.mutation(api.transfers.recordTransfer, {
      direction: "chapter_to_central",
      chapterId: s.chapterId,
      amountCents: 900_000,
      postedAt: MARCH_2026,
    });
    await s.as.mutation(api.transfers.recordTransfer, {
      direction: "central_to_chapter",
      chapterId: newChapter,
      amountCents: 500_000,
      postedAt: MARCH_2026,
    });

    const dash = await s.as.query(api.finances.dashboardCentral, {
      year: 2026,
      month: 3,
    });
    expect(dash.cityLaunchFund.skimsReceivedCents).toBe(900_000);
    expect(dash.cityLaunchFund.launchGrantsMadeCents).toBe(500_000);
    expect(dash.cityLaunchFund.positionCents).toBe(400_000);
    expect(dash.totalMonthSpendCents).toBe(0);
  });

  test("historical skim/launch_grant rows (pre-collapse) still net into the position", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentral(s, "bookkeeper");

    await insertHistoricalLeg(s, {
      chapterId: CENTRAL,
      source: "skim",
      amountCents: 20_000,
      postedAt: MARCH_2026,
      transferGroupId: "skim-legacy-2026-03",
    });
    await insertHistoricalLeg(s, {
      chapterId: CENTRAL,
      source: "launch_grant",
      amountCents: 8_000,
      postedAt: MARCH_2026,
      transferGroupId: "launch-legacy",
    });
    // A NEW generic transfer alongside the historical rows.
    await s.as.mutation(api.transfers.recordTransfer, {
      direction: "chapter_to_central",
      chapterId: s.chapterId,
      amountCents: 5_000,
      postedAt: MARCH_2026,
    });

    const dash = await s.as.query(api.finances.dashboardCentral, {
      year: 2026,
      month: 3,
    });
    expect(dash.cityLaunchFund.skimsReceivedCents).toBe(25_000); // 20_000 legacy + 5_000 new
    expect(dash.cityLaunchFund.launchGrantsMadeCents).toBe(8_000);
    expect(dash.cityLaunchFund.positionCents).toBe(17_000);
  });

  test("historical settlement rows are excluded from the fund position (as before)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentral(s, "bookkeeper");
    await insertHistoricalLeg(s, {
      chapterId: CENTRAL,
      source: "settlement",
      amountCents: 15_000,
      postedAt: MARCH_2026,
      transferGroupId: "settle-legacy-2026-03",
      transferDirection: "chapter_to_central",
    });
    const dash = await s.as.query(api.finances.dashboardCentral, {
      year: 2026,
      month: 3,
    });
    expect(dash.cityLaunchFund.skimsReceivedCents).toBe(0);
    expect(dash.cityLaunchFund.launchGrantsMadeCents).toBe(0);
    expect(dash.cityLaunchFund.positionCents).toBe(0);
  });
});

// ── Inter-scope balances ──────────────────────────────────────────────────────

/** WP-wave4 (item 5): a transaction can only attribute to an APPROVED budget
 *  now — every helper below approves directly, bypassing the submit+approve
 *  workflow (this file exercises inter-scope balance MATH, not the approval
 *  gate). */
async function approveBudgetDirect(s: ChapterSetup, budgetId: Id<"budgets">): Promise<void> {
  await run(s.t, (ctx) => ctx.db.patch(budgetId, { approvalStatus: "approved" }));
}

async function makeChapterBudget(
  s: ChapterSetup,
  amountCents: number,
  year = 2026,
): Promise<Id<"budgets">> {
  const budgetId = await s.as.mutation(api.finances.createBudget, {
    amountCents,
    type: "recurring",
    cadence: "monthly",
    year,
  });
  await approveBudgetDirect(s, budgetId);
  return budgetId;
}

async function makeCentralBudget(
  s: ChapterSetup,
  amountCents: number,
  year = 2026,
): Promise<Id<"budgets">> {
  const budgetId = await s.as.mutation(api.finances.createBudget, {
    amountCents,
    type: "recurring",
    cadence: "monthly",
    year,
    central: true,
  });
  await approveBudgetDirect(s, budgetId);
  return budgetId;
}

async function chapterSpendLinkedTo(
  s: ChapterSetup,
  budgetId: Id<"budgets">,
  amountCents: number,
  postedAt: number,
): Promise<void> {
  await s.as.mutation(api.finances.createManualTransaction, {
    flow: "outflow",
    amountCents,
    postedAt,
    budgetId,
  });
}

describe("interScopeBalances — direction (a): chapter spend linked to a CENTRAL budget", () => {
  test("nets as 'central owes the chapter', all-time + this period", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentral(s, "bookkeeper");
    const centralBudgetId = await makeCentralBudget(s, 100_000);
    await chapterSpendLinkedTo(s, centralBudgetId, 12_000, MARCH_2026);

    const march = await s.as.query(api.transfers.interScopeBalances, {
      year: 2026,
      month: 3,
    });
    const row = march.find((b) => b.chapterId === s.chapterId);
    expect(row?.netCents).toBe(12_000);
    expect(row?.periodNetCents).toBe(12_000);

    const april = await s.as.query(api.transfers.interScopeBalances, {
      year: 2026,
      month: 4,
    });
    const rowApril = april.find((b) => b.chapterId === s.chapterId);
    expect(rowApril?.netCents).toBe(12_000);
    expect(rowApril?.periodNetCents).toBe(0);
  });

  test("a chapter's own-budget spend never contributes (only central-linked spend does)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentral(s, "manager");
    const chapterBudgetId = await makeChapterBudget(s, 50_000);
    await chapterSpendLinkedTo(s, chapterBudgetId, 9_000, MARCH_2026);

    const balances = await s.as.query(api.transfers.interScopeBalances, {
      year: 2026,
      month: 3,
    });
    const row = balances.find((b) => b.chapterId === s.chapterId);
    expect(row?.netCents).toBe(0);
    expect(row?.periodNetCents).toBe(0);
  });
});

describe("interScopeBalances — direction (b): central fronts a chapter's spend", () => {
  // Cross-book attribution went LIVE 2026-08-05 (founder request). This
  // `describe` used to be titled "verified NOT attributable today" and its
  // first test asserted the write was REJECTED — that rejection was the thing
  // being removed, so the test is inverted here rather than deleted: the same
  // call now succeeds and produces a real balance.
  test("a central txn CAN attribute to a chapter budget, and it books the debt", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentral(s, "manager");
    const chapterBudgetId = await makeChapterBudget(s, 10_000);
    const txnId = await s.as.mutation(api.finances.createManualTransaction, {
      flow: "outflow",
      amountCents: 500,
      postedAt: MARCH_2026,
      budgetId: chapterBudgetId,
      central: true,
    });

    // Custody is UNCHANGED — central's account really did pay. Only the
    // budget says whose programme it belongs to.
    const txn = await run(s.t, (ctx) => ctx.db.get(txnId));
    expect(txn?.chapterId).toBe(CENTRAL);
    expect(txn?.budgetId).toBe(chapterBudgetId);

    // ...and the chapter now owes central for it (negative = chapter owes).
    const balances = await s.as.query(api.transfers.interScopeBalances, {
      year: 2026,
      month: 3,
    });
    const row = balances.find((b) => b.chapterId === s.chapterId);
    expect(row?.netCents).toBe(-500);
    expect(row?.periodNetCents).toBe(-500);
  });

  test("a chapter-only treasurer cannot charge central's card to their own budget", async () => {
    // The gate is `requireCrossBookAttribution` (central reach today). A
    // chapter manager can't write a central-owned txn at all, so this is
    // belt-and-braces on the outer gate rather than a new hole.
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    const chapterBudgetId = await run(s.t, (ctx) =>
      ctx.db.insert("budgets", {
        chapterId: s.chapterId,
        amountCents: 10_000,
        type: "recurring",
        cadence: "monthly",
        year: 2026,
        approvalStatus: "approved",
        createdAt: Date.now(),
      }),
    );
    await expect(
      s.as.mutation(api.finances.createManualTransaction, {
        flow: "outflow",
        amountCents: 500,
        postedAt: MARCH_2026,
        budgetId: chapterBudgetId,
        central: true,
      }),
    ).rejects.toThrow(ConvexError);
  });

  test("query math IS correct for direction (b) when the row is written directly", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentral(s, "bookkeeper");
    const chapterBudgetId = await run(s.t, (ctx) =>
      ctx.db.insert("budgets", {
        chapterId: s.chapterId,
        amountCents: 10_000,
        type: "recurring",
        cadence: "monthly",
        year: 2026,
        createdAt: Date.now(),
      }),
    );
    await run(s.t, (ctx) =>
      ctx.db.insert("transactions", {
        chapterId: CENTRAL,
        source: "manual",
        flow: "outflow",
        amountCents: 8_000,
        currency: "usd",
        postedAt: MARCH_2026,
        budgetId: chapterBudgetId,
        status: "categorized",
        createdAt: Date.now(),
      }),
    );

    const balances = await s.as.query(api.transfers.interScopeBalances, {
      year: 2026,
      month: 3,
    });
    const row = balances.find((b) => b.chapterId === s.chapterId);
    expect(row?.netCents).toBe(-8_000);
    expect(row?.periodNetCents).toBe(-8_000);
  });
});

describe("interScopeBalances — authz", () => {
  test("chapter manager (no central reach) is FORBIDDEN", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    await expect(
      s.as.query(api.transfers.interScopeBalances, {}),
    ).rejects.toThrow(/FORBIDDEN/);
  });

  test("central VIEWER can read (query is viewer+, not a write)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentral(s, "viewer");
    const balances = await s.as.query(api.transfers.interScopeBalances, {});
    expect(Array.isArray(balances)).toBe(true);
  });
});

describe("recordTransfer — nets out interScopeBalances (the old settlement's job)", () => {
  test("a central_to_chapter transfer books central outflow → chapter inflow and fully nets the balance", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentralEdOrFm(s);
    const centralBudgetId = await makeCentralBudget(s, 100_000);
    await chapterSpendLinkedTo(s, centralBudgetId, 20_000, MARCH_2026);

    let balances = await s.as.query(api.transfers.interScopeBalances, {
      year: 2026,
      month: 3,
    });
    expect(balances.find((b) => b.chapterId === s.chapterId)?.netCents).toBe(
      20_000,
    );

    const res = await s.as.mutation(api.transfers.recordTransfer, {
      direction: "central_to_chapter",
      chapterId: s.chapterId,
      amountCents: 20_000,
      postedAt: MARCH_2026,
      note: "Settling March's inter-scope balance",
    });

    const legs = await legsFor(s, res.transferGroupId);
    expect(legs.length).toBe(2);
    const chapterLeg = legs.find((l) => l.chapterId === s.chapterId);
    const centralLeg = legs.find((l) => l.chapterId === CENTRAL);
    expect(centralLeg?._id).toBe(res.outflowId);
    expect(chapterLeg?._id).toBe(res.inflowId);
    for (const leg of legs) {
      expect(leg.source).toBe("transfer");
      expect(leg.flow).toBe("transfer");
      expect(leg.transferDirection).toBe("central_to_chapter");
      expect(countsAsSpend(leg.flow)).toBe(false);
    }

    balances = await s.as.query(api.transfers.interScopeBalances, {
      year: 2026,
      month: 3,
    });
    expect(balances.find((b) => b.chapterId === s.chapterId)?.netCents).toBe(
      0,
    );
  });

  test("a chapter_to_central transfer books chapter outflow → central inflow", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentral(s, "bookkeeper");
    const res = await s.as.mutation(api.transfers.recordTransfer, {
      direction: "chapter_to_central",
      chapterId: s.chapterId,
      amountCents: 7_000,
      postedAt: MARCH_2026,
    });
    const legs = await legsFor(s, res.transferGroupId);
    const chapterLeg = legs.find((l) => l.chapterId === s.chapterId);
    const centralLeg = legs.find((l) => l.chapterId === CENTRAL);
    expect(chapterLeg?._id).toBe(res.outflowId);
    expect(centralLeg?._id).toBe(res.inflowId);
    for (const leg of legs) {
      expect(leg.flow).toBe("transfer");
      expect(leg.transferDirection).toBe("chapter_to_central");
    }
  });

  test("historical settlement rows still net alongside new generic transfers", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentralEdOrFm(s);
    const centralBudgetId = await makeCentralBudget(s, 100_000);
    await chapterSpendLinkedTo(s, centralBudgetId, 30_000, MARCH_2026);

    // A HISTORICAL settlement leg partially pays it down.
    await insertHistoricalLeg(s, {
      chapterId: CENTRAL,
      source: "settlement",
      amountCents: 10_000,
      postedAt: MARCH_2026,
      transferGroupId: "settle-legacy-2026-03",
      transferDirection: "central_to_chapter",
    });
    await insertHistoricalLeg(s, {
      chapterId: s.chapterId,
      source: "settlement",
      amountCents: 10_000,
      postedAt: MARCH_2026,
      transferGroupId: "settle-legacy-2026-03",
      transferDirection: "central_to_chapter",
    });

    let balances = await s.as.query(api.transfers.interScopeBalances, {
      year: 2026,
      month: 3,
    });
    expect(balances.find((b) => b.chapterId === s.chapterId)?.netCents).toBe(
      20_000,
    );

    // A NEW generic transfer pays down the rest.
    await s.as.mutation(api.transfers.recordTransfer, {
      direction: "central_to_chapter",
      chapterId: s.chapterId,
      amountCents: 20_000,
      postedAt: MARCH_2026,
    });

    balances = await s.as.query(api.transfers.interScopeBalances, {
      year: 2026,
      month: 3,
    });
    expect(balances.find((b) => b.chapterId === s.chapterId)?.netCents).toBe(
      0,
    );
  });
});

// ── interScopeBalanceContributors ────────────────────────────────────────────

describe("interScopeBalanceContributors", () => {
  test("contributor rows' signed sum reconciles exactly to interScopeBalances' netCents", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentralEdOrFm(s);
    const centralBudgetId = await makeCentralBudget(s, 100_000);
    await chapterSpendLinkedTo(s, centralBudgetId, 12_000, MARCH_2026);
    await chapterSpendLinkedTo(s, centralBudgetId, 8_000, MARCH_2026 + 86_400_000);
    await s.as.mutation(api.transfers.recordTransfer, {
      direction: "central_to_chapter",
      chapterId: s.chapterId,
      amountCents: 6_000,
      postedAt: MARCH_2026 + 2 * 86_400_000, // newest of the three
    });

    const balances = await s.as.query(api.transfers.interScopeBalances, {
      year: 2026,
      month: 3,
    });
    const netCents = balances.find((b) => b.chapterId === s.chapterId)?.netCents;
    expect(netCents).toBe(12_000 + 8_000 - 6_000); // 14_000

    const contributors = await s.as.query(
      api.transfers.interScopeBalanceContributors,
      { chapterId: s.chapterId },
    );
    expect(contributors).toHaveLength(3);
    const signedSum = contributors.reduce((sum, row) => {
      if (row.direction === "central_owes_chapter") return sum + row.amountCents;
      if (row.direction === "settlement_central_to_chapter") return sum - row.amountCents;
      if (row.direction === "chapter_owes_central") return sum - row.amountCents;
      return sum + row.amountCents;
    }, 0);
    expect(signedSum).toBe(netCents);
    expect(
      contributors.filter((r) => r.direction === "central_owes_chapter"),
    ).toHaveLength(2);
    expect(
      contributors.filter((r) => r.direction === "settlement_central_to_chapter"),
    ).toHaveLength(1);
    expect(contributors[0].amountCents).toBe(6_000); // newest-first
  });

  test("a chapter with no inter-scope activity returns an empty list", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentral(s, "viewer");
    const contributors = await s.as.query(
      api.transfers.interScopeBalanceContributors,
      { chapterId: s.chapterId },
    );
    expect(contributors).toEqual([]);
  });

  test("authz: chapter manager (no central reach) is FORBIDDEN; central viewer can read", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    await expect(
      s.as.query(api.transfers.interScopeBalanceContributors, {
        chapterId: s.chapterId,
      }),
    ).rejects.toThrow(/FORBIDDEN/);

    const t2 = newT();
    const s2 = await setupChapter(t2);
    await asCentral(s2, "viewer");
    const contributors = await s2.as.query(
      api.transfers.interScopeBalanceContributors,
      { chapterId: s2.chapterId },
    );
    expect(Array.isArray(contributors)).toBe(true);
  });
});

// ── transferReadiness (kept — see transfers.ts's doc comment) ─────────────────

describe("transferReadiness", () => {
  test("false without accounts, true once both are active", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentral(s, "bookkeeper");
    const before = await s.as.query(api.transfers.transferReadiness, {
      chapterId: s.chapterId,
    });
    expect(before.canMoveReal).toBe(false);

    await seedActiveAccount(s, s.chapterId, "account_ch");
    await seedActiveAccount(s, CENTRAL, "account_central");
    const after = await s.as.query(api.transfers.transferReadiness, {
      chapterId: s.chapterId,
    });
    expect(after.canMoveReal).toBe(true);
  });
});

// ── removeChapterAccount — sandbox transfer-leg cascade ───────────────────────
// No mutation writes a real (`externalId`-stamped) transfer leg anymore — the
// Increase auto-initiate path is deleted (see `transfers.ts`'s header
// comment) — so a sandbox real leg is simulated with a raw insert, standing
// in for a row written before that removal.

describe("removeChapterAccount — sandbox transfer-leg cascade", () => {
  test("deletes the removed chapter's sandbox transfer leg; a manual leg survives", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentral(s, "manager");

    await run(s.t, (ctx) =>
      ctx.db.insert("financeSettings", {
        sandboxMode: true,
        updatedAt: Date.now(),
      }),
    );
    await run(s.t, (ctx) =>
      ctx.db.insert("increaseAccounts", {
        chapterId: s.chapterId,
        sandbox: true,
        increaseAccountId: "sandbox_acct_test",
        increaseEntityId: "entity_sandbox",
        onboardingStatus: "active",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );

    await insertHistoricalLeg(s, {
      chapterId: s.chapterId,
      source: "transfer",
      amountCents: 10_000,
      postedAt: MARCH_2026,
      transferGroupId: "transfer-sandbox-test",
      transferDirection: "chapter_to_central",
      externalId: "sandbox_account_transfer_9",
    });
    const manual = await s.as.mutation(api.transfers.recordTransfer, {
      direction: "chapter_to_central",
      chapterId: s.chapterId,
      amountCents: 5_000,
      postedAt: APRIL_2026,
    });

    await s.as.mutation(api.increaseAccounts.removeChapterAccount, {});

    const sandboxLegs = await legsFor(s, "transfer-sandbox-test");
    expect(sandboxLegs.find((l) => l.chapterId === s.chapterId)).toBeUndefined();

    const manualLegs = await legsFor(s, manual.transferGroupId);
    expect(manualLegs.length).toBe(2);
  });
});
