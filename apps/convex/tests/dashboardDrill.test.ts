/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { CENTRAL } from "@events-os/shared";
import { runSeedSeatDefs } from "../migrations/0022_seed_seat_defs";

/**
 * `dashboardDrill.ts` — the three central-dashboard drilldowns (queries a + b
 * here; `interScopeBalanceContributors` is covered in `transfers.test.ts`
 * since it lives in `transfers.ts`).
 */

async function seedSelfPerson(s: ChapterSetup): Promise<Id<"people">> {
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

/** A central-scope finance role at a chosen rank (mirrors transfers.test.ts). */
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

/** `setupChapter`, but with the `seatDefs` table seeded first (mirrors
 *  `financeGatesSeatUnion.test.ts#seatSetup`) — needed for `assignSeatDirect`
 *  below to resolve a def by slug. */
async function seatSetup(
  opts: { email?: string; chapterName?: string } = {},
): Promise<ChapterSetup> {
  const t = newT();
  await run(t, (ctx) => runSeedSeatDefs(ctx));
  return setupChapter(t, opts);
}

/** The seatDef row seeded for a template `slug` (mirrors
 *  `financeGatesSeatUnion.test.ts#defBySlug`). */
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

/** Insert a `seatAssignments` row directly, bypassing `assignSeat`'s
 *  write-through — isolates "what the org chart alone implies" (mirrors
 *  `financeGatesSeatUnion.test.ts#assignSeatDirect`). Used here to construct
 *  the review-fix persona: an `executive_director` seat carries
 *  `finance.central` but NOT `finance.manager` (see `SEAT_DEFS` in
 *  `@events-os/shared`), so `getFinanceRole` derives `isCentral: true` with
 *  `role: null` for this caller — `requireFinanceCentral` (central reach
 *  only) passes; the stricter `requireCentralFinanceRole(..., "viewer")`
 *  this file's queries used to gate on would NOT (a null role never clears
 *  `financeRoleAtLeast`), which is exactly the gap PR #231's review caught. */
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

async function seedEvent(
  s: ChapterSetup,
  chapterId: Id<"chapters">,
  opts: { name?: string; eventDate?: number } = {},
): Promise<Id<"events">> {
  return run(s.t, async (ctx) => {
    const eventTypeId = await ctx.db.insert("eventTypes", {
      chapterId,
      name: "Service",
      slug: "service",
      version: 1,
      createdBy: s.userId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    return ctx.db.insert("events", {
      chapterId,
      eventTypeId,
      templateVersion: 1,
      name: opts.name ?? "Sunday Gathering",
      eventDate: opts.eventDate ?? Date.now(),
      status: "planning",
      createdBy: s.userId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
}

/** Insert a `budgets` row directly (bypassing `createBudget`) for full control
 *  over `approvalStatus`/`submittedAt` without going through the
 *  submit-workflow mutation (which schedules `notifyBudgetApprovers` — see
 *  `transfers.test.ts#approveBudgetDirect` for the same pattern applied to
 *  "approved"). */
async function insertBudget(
  s: ChapterSetup,
  fields: {
    chapterId: Id<"chapters"> | typeof CENTRAL;
    amountCents: number;
    approvalStatus?: "draft" | "submitted" | "approved" | "changes_requested";
    submittedAt?: number;
    label?: string;
    type?: "one_time" | "recurring";
    refKind?: "event" | "project";
    scopeRefId?: string;
  },
): Promise<Id<"budgets">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("budgets", {
      chapterId: fields.chapterId,
      amountCents: fields.amountCents,
      cadence: "monthly",
      year: 2026,
      createdAt: Date.now(),
      approvalStatus: fields.approvalStatus,
      submittedAt: fields.submittedAt,
      label: fields.label,
      type: fields.type,
      refKind: fields.refKind,
      scopeRefId: fields.scopeRefId,
    }),
  );
}

/** Insert a `transactions` row directly, bypassing auth/gating — this file
 *  tests the READ side only. Defaults to a plain, unlinked spend row. */
async function insertTxn(
  s: ChapterSetup,
  fields: {
    chapterId: Id<"chapters"> | typeof CENTRAL;
    amountCents: number;
    postedAt: number;
    flow?: "outflow" | "inflow" | "transfer";
    status?: "unreviewed" | "categorized" | "reconciled" | "excluded";
    budgetId?: Id<"budgets">;
    isPersonal?: boolean;
    description?: string;
    merchantName?: string;
  },
): Promise<Id<"transactions">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("transactions", {
      chapterId: fields.chapterId,
      source: "manual",
      flow: fields.flow ?? "outflow",
      amountCents: fields.amountCents,
      postedAt: fields.postedAt,
      status: fields.status ?? "unreviewed",
      budgetId: fields.budgetId,
      isPersonal: fields.isPersonal,
      description: fields.description,
      merchantName: fields.merchantName,
      createdAt: Date.now(),
    }),
  );
}

const MARCH_2026 = Date.UTC(2026, 2, 10, 16); // noon-ish ET, March 10 2026
const FEB_2026 = Date.UTC(2026, 1, 10, 16);

// ── pendingBudgetApprovals ────────────────────────────────────────────────────

describe("pendingBudgetApprovals", () => {
  test("returns central + chapter submitted budgets, oldest-first, with correct chapter labels", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentral(s, "viewer");
    const otherChapter = await makeChapter(s, "Austin");

    const centralBudgetId = await insertBudget(s, {
      chapterId: CENTRAL,
      amountCents: 50_000,
      approvalStatus: "submitted",
      submittedAt: 300,
      label: "Central ops",
    });
    const chapterBudgetId = await insertBudget(s, {
      chapterId: s.chapterId,
      amountCents: 10_000,
      approvalStatus: "submitted",
      submittedAt: 100,
      label: "NY ops",
    });
    const otherChapterBudgetId = await insertBudget(s, {
      chapterId: otherChapter,
      amountCents: 20_000,
      approvalStatus: "submitted",
      submittedAt: 200,
      label: "Austin ops",
    });
    // A draft and an approved budget must NOT appear.
    await insertBudget(s, { chapterId: s.chapterId, amountCents: 1, approvalStatus: "draft" });
    await insertBudget(s, { chapterId: s.chapterId, amountCents: 1, approvalStatus: "approved" });

    const rows = await s.as.query(api.dashboardDrill.pendingBudgetApprovals, {});
    expect(rows.map((r) => r.budgetId)).toEqual([
      chapterBudgetId,
      otherChapterBudgetId,
      centralBudgetId,
    ]);
    expect(rows.find((r) => r.budgetId === centralBudgetId)).toMatchObject({
      chapterId: CENTRAL,
      chapterName: "Central",
      name: "Central ops",
      amountCents: 50_000,
    });
    expect(rows.find((r) => r.budgetId === chapterBudgetId)).toMatchObject({
      chapterId: s.chapterId,
      chapterName: "New York",
      name: "NY ops",
    });
    expect(rows.find((r) => r.budgetId === otherChapterBudgetId)).toMatchObject({
      chapterId: otherChapter,
      chapterName: "Austin",
    });
  });

  test("resolves the live event name for a one_time budget, falling back to label/type otherwise", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentral(s, "viewer");
    const eventId = await seedEvent(s, s.chapterId, { name: "Spring Retreat" });

    const linkedBudgetId = await insertBudget(s, {
      chapterId: s.chapterId,
      amountCents: 5_000,
      approvalStatus: "submitted",
      type: "one_time",
      refKind: "event",
      scopeRefId: eventId,
      label: "stale stored label",
    });
    const labeledBudgetId = await insertBudget(s, {
      chapterId: s.chapterId,
      amountCents: 5_000,
      approvalStatus: "submitted",
      label: "Youth Ministry",
    });
    const unlabeledBudgetId = await insertBudget(s, {
      chapterId: s.chapterId,
      amountCents: 5_000,
      approvalStatus: "submitted",
      type: "recurring",
    });

    const rows = await s.as.query(api.dashboardDrill.pendingBudgetApprovals, {});
    // The live event name wins over the stale stored label.
    expect(rows.find((r) => r.budgetId === linkedBudgetId)?.name).toBe("Spring Retreat");
    expect(rows.find((r) => r.budgetId === labeledBudgetId)?.name).toBe("Youth Ministry");
    expect(rows.find((r) => r.budgetId === unlabeledBudgetId)?.name).toBe("Recurring");
  });

  test("row count matches dashboardCentral.pendingBudgetApprovalsCount for the same fixture", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentral(s, "viewer");
    await insertBudget(s, { chapterId: CENTRAL, amountCents: 1, approvalStatus: "submitted" });
    await insertBudget(s, { chapterId: s.chapterId, amountCents: 1, approvalStatus: "submitted" });
    await insertBudget(s, { chapterId: s.chapterId, amountCents: 1, approvalStatus: "submitted" });

    const rows = await s.as.query(api.dashboardDrill.pendingBudgetApprovals, {});
    const dash = await s.as.query(api.finances.dashboardCentral, {});
    expect(rows.length).toBe(dash.pendingBudgetApprovalsCount);
    expect(rows.length).toBe(3);
  });

  test("authz: chapter manager (no central reach) is FORBIDDEN; central viewer succeeds", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    await expect(
      s.as.query(api.dashboardDrill.pendingBudgetApprovals, {}),
    ).rejects.toThrow(/central/i);

    const t2 = newT();
    const s2 = await setupChapter(t2);
    await asCentral(s2, "viewer");
    const rows = await s2.as.query(api.dashboardDrill.pendingBudgetApprovals, {});
    expect(Array.isArray(rows)).toBe(true);
  });

  test("review fix: an executive_director seat with NO stored central role (isCentral true, role null) succeeds — matches dashboardCentral's own gate", async () => {
    const s = await seatSetup();
    const personId = await seedSelfPerson(s);
    await assignSeatDirect(s, personId, "executive_director", "central");

    const rows = await s.as.query(api.dashboardDrill.pendingBudgetApprovals, {});
    expect(Array.isArray(rows)).toBe(true);
  });
});

// ── orgUnattributedTransactions ──────────────────────────────────────────────

describe("orgUnattributedTransactions", () => {
  test("includes chapter-owned AND central-owned unattributed spend in period; excludes linked/excluded/personal rows", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentral(s, "viewer");
    const otherChapter = await makeChapter(s, "Austin");

    const chapterTxnId = await insertTxn(s, {
      chapterId: s.chapterId,
      amountCents: 4_000,
      postedAt: MARCH_2026,
      description: "Unlinked chapter spend",
    });
    const centralTxnId = await insertTxn(s, {
      chapterId: CENTRAL,
      amountCents: 9_000,
      postedAt: MARCH_2026,
      description: "Unlinked central spend",
    });
    const otherChapterTxnId = await insertTxn(s, {
      chapterId: otherChapter,
      amountCents: 1_500,
      postedAt: MARCH_2026,
      description: "Unlinked Austin spend",
    });

    // Explicitly linked — excluded from "unattributed" (needs a real budget id
    // to satisfy the validator; use a throwaway approved budget).
    const linkedBudgetId = await insertBudget(s, {
      chapterId: s.chapterId,
      amountCents: 100_000,
      approvalStatus: "approved",
    });
    await insertTxn(s, {
      chapterId: s.chapterId,
      amountCents: 2_000,
      postedAt: MARCH_2026,
      budgetId: linkedBudgetId,
    });
    // Excluded status.
    await insertTxn(s, {
      chapterId: s.chapterId,
      amountCents: 2_000,
      postedAt: MARCH_2026,
      status: "excluded",
    });
    // Personal charge.
    await insertTxn(s, {
      chapterId: s.chapterId,
      amountCents: 2_000,
      postedAt: MARCH_2026,
      isPersonal: true,
    });
    // Inflow — never spend.
    await insertTxn(s, {
      chapterId: s.chapterId,
      amountCents: 2_000,
      postedAt: MARCH_2026,
      flow: "inflow",
    });
    // Out of period (February, month-mode query below asks for March).
    await insertTxn(s, {
      chapterId: s.chapterId,
      amountCents: 2_000,
      postedAt: FEB_2026,
    });

    const result = await s.as.query(api.dashboardDrill.orgUnattributedTransactions, {
      year: 2026,
      month: 3,
      period: "month",
    });
    expect(result.totalCount).toBe(3);
    const ids = result.rows.map((r) => r.id);
    expect(ids).toEqual(
      expect.arrayContaining([chapterTxnId, centralTxnId, otherChapterTxnId]),
    );
    expect(result.rows.find((r) => r.id === centralTxnId)).toMatchObject({
      chapterId: CENTRAL,
      chapterName: "Central",
      amountCents: 9_000,
    });
    expect(result.rows.find((r) => r.id === chapterTxnId)).toMatchObject({
      chapterId: s.chapterId,
      chapterName: "New York",
    });
    expect(result.rows.find((r) => r.id === otherChapterTxnId)).toMatchObject({
      chapterId: otherChapter,
      chapterName: "Austin",
    });
  });

  test("YTD mode widens the window to Jan..throughMonth", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentral(s, "viewer");
    await insertTxn(s, { chapterId: s.chapterId, amountCents: 1_000, postedAt: FEB_2026 });
    await insertTxn(s, { chapterId: s.chapterId, amountCents: 1_000, postedAt: MARCH_2026 });

    const monthResult = await s.as.query(api.dashboardDrill.orgUnattributedTransactions, {
      year: 2026,
      month: 3,
      period: "month",
    });
    expect(monthResult.totalCount).toBe(1);

    const ytdResult = await s.as.query(api.dashboardDrill.orgUnattributedTransactions, {
      year: 2026,
      month: 3,
      period: "ytd",
    });
    expect(ytdResult.totalCount).toBe(2);
  });

  test("caps returned rows at 200 but reports the full totalCount", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentral(s, "viewer");
    for (let i = 0; i < 205; i++) {
      await insertTxn(s, {
        chapterId: s.chapterId,
        amountCents: 100 + i,
        postedAt: MARCH_2026 + i * 1000,
      });
    }
    const result = await s.as.query(api.dashboardDrill.orgUnattributedTransactions, {
      year: 2026,
      month: 3,
      period: "month",
    });
    expect(result.rows.length).toBe(200);
    expect(result.totalCount).toBe(205);
  });

  test("authz: chapter manager (no central reach) is FORBIDDEN; central viewer succeeds", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    await expect(
      s.as.query(api.dashboardDrill.orgUnattributedTransactions, {}),
    ).rejects.toThrow(/central/i);

    const t2 = newT();
    const s2 = await setupChapter(t2);
    await asCentral(s2, "viewer");
    const result = await s2.as.query(api.dashboardDrill.orgUnattributedTransactions, {});
    expect(Array.isArray(result.rows)).toBe(true);
  });

  test("review fix: an executive_director seat with NO stored central role (isCentral true, role null) succeeds — matches dashboardCentral's own gate", async () => {
    const s = await seatSetup();
    const personId = await seedSelfPerson(s);
    await assignSeatDirect(s, personId, "executive_director", "central");

    const result = await s.as.query(api.dashboardDrill.orgUnattributedTransactions, {});
    expect(Array.isArray(result.rows)).toBe(true);
  });

  test("parity: the sum of rows' amountCents (uncapped fixture) equals dashboardCentral.orgUnattributedCents", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentral(s, "viewer");
    const otherChapter = await makeChapter(s, "Austin");

    await insertTxn(s, { chapterId: s.chapterId, amountCents: 4_000, postedAt: MARCH_2026 });
    await insertTxn(s, { chapterId: CENTRAL, amountCents: 9_000, postedAt: MARCH_2026 });
    await insertTxn(s, { chapterId: otherChapter, amountCents: 1_500, postedAt: MARCH_2026 });
    await insertTxn(s, { chapterId: s.chapterId, amountCents: 750, postedAt: MARCH_2026 });
    // A linked txn and an excluded one, so the parity check isn't trivially
    // "every row counts" — both must stay OUT of both sides equally.
    const linkedBudgetId = await insertBudget(s, {
      chapterId: s.chapterId,
      amountCents: 100_000,
      approvalStatus: "approved",
    });
    await insertTxn(s, {
      chapterId: s.chapterId,
      amountCents: 2_000,
      postedAt: MARCH_2026,
      budgetId: linkedBudgetId,
    });
    await insertTxn(s, {
      chapterId: s.chapterId,
      amountCents: 2_000,
      postedAt: MARCH_2026,
      status: "excluded",
    });

    const result = await s.as.query(api.dashboardDrill.orgUnattributedTransactions, {
      year: 2026,
      month: 3,
      period: "month",
    });
    const dash = await s.as.query(api.finances.dashboardCentral, {
      year: 2026,
      month: 3,
      period: "month",
    });
    expect(result.rows.length).toBeLessThan(200); // uncapped — the cap isn't masking anything
    const sum = result.rows.reduce((s2, r) => s2 + r.amountCents, 0);
    expect(sum).toBe(dash.orgUnattributedCents);
    expect(sum).toBe(4_000 + 9_000 + 1_500 + 750);
  });
});
