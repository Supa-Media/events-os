/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

/**
 * `reconcileSuggest.rankForPicker` — the "For" picker's ranking (owner spec:
 * nearby-spend, then similar-merchant, then upcoming date, then everything
 * else with budget-less refs demoted). Pins each tier rule individually, the
 * single-appearance invariant, the gate (mirrors `listReconcile`), and the
 * search addendum's match-quality ordering.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
// A fixed "today" so ±10/±45-day windows are deterministic across runs.
const NOW = Date.UTC(2026, 5, 15, 17, 0, 0); // June 15, 2026

async function seedSelfPerson(s: ChapterSetup): Promise<Id<"people">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Caller",
      userId: s.userId,
      isTeamMember: true,
      createdAt: Date.now(),
    }),
  );
}

async function asChapterViewer(s: ChapterSetup): Promise<Id<"people">> {
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
  return personId;
}

async function asCentralManager(s: ChapterSetup): Promise<Id<"people">> {
  const personId = await seedSelfPerson(s);
  await run(s.t, (ctx) =>
    ctx.db.insert("financeRoles", {
      chapterId: s.chapterId,
      personId,
      role: "manager",
      scope: "central",
      createdAt: Date.now(),
    }),
  );
  return personId;
}

async function seedEvent(
  s: ChapterSetup,
  opts: { name?: string; eventDate?: number; isTraining?: boolean } = {},
): Promise<Id<"events">> {
  return await run(s.t, async (ctx) => {
    const eventTypeId = await ctx.db.insert("eventTypes", {
      chapterId: s.chapterId,
      name: "Service",
      slug: `service-${Date.now()}-${Math.random()}`,
      version: 1,
      createdBy: s.userId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    return await ctx.db.insert("events", {
      chapterId: s.chapterId,
      eventTypeId,
      templateVersion: 1,
      name: opts.name ?? "Sunday Gathering",
      eventDate: opts.eventDate ?? NOW,
      status: "planning",
      isTraining: opts.isTraining,
      createdBy: s.userId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
}

async function seedProject(
  s: ChapterSetup,
  name: string,
  opts: { deadline?: number; startDate?: number } = {},
): Promise<Id<"projects">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("projects", {
      chapterId: s.chapterId,
      name,
      status: "in_progress",
      deadline: opts.deadline,
      startDate: opts.startDate,
      createdBy: s.userId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
}

async function seedOneTimeBudget(
  s: ChapterSetup,
  chapterId: Id<"chapters"> | "central",
  refKind: "event" | "project",
  scopeRefId: string,
  opts: { amountCents?: number; label?: string; createdAt?: number } = {},
): Promise<Id<"budgets">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("budgets", {
      chapterId,
      amountCents: opts.amountCents ?? 100000,
      label: opts.label,
      type: "one_time",
      refKind,
      scopeRefId,
      cadence: "per_instance",
      year: 2026,
      createdBy: s.userId,
      createdAt: opts.createdAt ?? Date.now(),
    }),
  );
}

async function seedRecurringBudget(
  s: ChapterSetup,
  chapterId: Id<"chapters"> | "central",
  opts: { label?: string; year?: number } = {},
): Promise<Id<"budgets">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("budgets", {
      chapterId,
      amountCents: 500000,
      label: opts.label ?? "Ops",
      type: "recurring",
      cadence: "monthly",
      year: opts.year ?? 2026,
      createdBy: s.userId,
      createdAt: Date.now(),
    }),
  );
}

async function seedTxn(
  s: ChapterSetup,
  chapterId: Id<"chapters"> | "central",
  fields: Record<string, unknown> = {},
): Promise<Id<"transactions">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("transactions", {
      chapterId,
      source: "manual",
      flow: "outflow",
      amountCents: 5000,
      postedAt: NOW,
      status: "categorized",
      createdAt: Date.now(),
      ...fields,
    }),
  );
}

/** The subject txn we're ranking FOR — always `unreviewed`/no budget yet. */
async function seedSubjectTxn(
  s: ChapterSetup,
  chapterId: Id<"chapters"> | "central",
  fields: Record<string, unknown> = {},
): Promise<Id<"transactions">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("transactions", {
      chapterId,
      source: "manual",
      flow: "outflow",
      amountCents: 4200,
      postedAt: NOW,
      status: "unreviewed",
      createdAt: Date.now(),
      ...fields,
    }),
  );
}

// ── Gate ──────────────────────────────────────────────────────────────────

describe("reconcileSuggest.rankForPicker: gate", () => {
  test("a chapter viewer CAN rank their own chapter's txn", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterViewer(s);
    const txnId = await seedSubjectTxn(s, s.chapterId);

    const result = await s.as.query(api.reconcileSuggest.rankForPicker, {
      transactionId: txnId,
    });
    expect(result.rows).toEqual([]);
  });

  test("a caller with NO finance role at all CANNOT rank (mirrors listReconcile)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const txnId = await seedSubjectTxn(s, s.chapterId);

    await expect(
      s.as.query(api.reconcileSuggest.rankForPicker, { transactionId: txnId }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("a chapter viewer ranking a CENTRAL txn is rejected (needs central reach)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterViewer(s);
    const txnId = await seedSubjectTxn(s, "central");

    await expect(
      s.as.query(api.reconcileSuggest.rankForPicker, { transactionId: txnId }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("a central manager CAN rank a central txn, offered only Recurring · Central candidates", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentralManager(s);
    const eventId = await seedEvent(s);
    void eventId; // events are chapter-only — must never surface for a central txn
    const centralBudgetId = await seedRecurringBudget(s, "central", { label: "City Launch Fund" });
    const txnId = await seedSubjectTxn(s, "central");

    const result = await s.as.query(api.reconcileSuggest.rankForPicker, {
      transactionId: txnId,
    });
    expect(result.rows.every((r) => r.refKind === "recurring" && r.level === "central")).toBe(true);
    expect(result.rows.some((r) => r.budgetId === centralBudgetId)).toBe(true);
  });

  test("a chapter viewer CANNOT rank a foreign chapter's txn (soft-empty, not a throw)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterViewer(s);
    const boston = await run(s.t, (ctx) =>
      ctx.db.insert("chapters", { name: "Boston", isActive: true, createdAt: Date.now() }),
    );
    const txnId = await seedSubjectTxn(s, boston);

    const result = await s.as.query(api.reconcileSuggest.rankForPicker, {
      transactionId: txnId,
    });
    expect(result.rows).toEqual([]);
  });
});

// ── Tier 1: nearby spend ──────────────────────────────────────────────────

describe("reconcileSuggest.rankForPicker: tier 1 (nearby spend)", () => {
  test("a budget with a transaction posted within ±10 days ranks TIER 1", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterViewer(s);
    const eventId = await seedEvent(s, { name: "Pitch Deck Launch" });
    const budgetId = await seedOneTimeBudget(s, s.chapterId, "event", eventId);
    await seedTxn(s, s.chapterId, {
      budgetId,
      postedAt: NOW - 5 * DAY_MS,
      merchantName: "Office Depot",
    });
    const txnId = await seedSubjectTxn(s, s.chapterId);

    const result = await s.as.query(api.reconcileSuggest.rankForPicker, {
      transactionId: txnId,
    });
    const row = result.rows.find((r) => r.refId === (eventId as string));
    expect(row?.tier).toBe(1);
    expect(row?.reason).toContain("nearby in June");
  });

  test("a nearby transaction OUTSIDE ±10 days does NOT trigger tier 1", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterViewer(s);
    const eventId = await seedEvent(s, { name: "Far Event", eventDate: NOW + 200 * DAY_MS });
    const budgetId = await seedOneTimeBudget(s, s.chapterId, "event", eventId);
    await seedTxn(s, s.chapterId, { budgetId, postedAt: NOW - 20 * DAY_MS });
    const txnId = await seedSubjectTxn(s, s.chapterId);

    const result = await s.as.query(api.reconcileSuggest.rankForPicker, {
      transactionId: txnId,
    });
    const row = result.rows.find((r) => r.refId === (eventId as string));
    expect(row?.tier).not.toBe(1);
  });
});

// ── Tier 2: similar merchant ──────────────────────────────────────────────

describe("reconcileSuggest.rankForPicker: tier 2 (similar merchant)", () => {
  test("an EXACT normalized-merchant match ranks tier 2, above a fuzzy match", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterViewer(s);

    const exactEventId = await seedEvent(s, {
      name: "Retreat",
      eventDate: NOW + 300 * DAY_MS, // well outside tier 3's window
    });
    const exactBudgetId = await seedOneTimeBudget(s, s.chapterId, "event", exactEventId);
    // Far outside tier 1's ±10-day window, but SAME normalized merchant.
    await seedTxn(s, s.chapterId, {
      budgetId: exactBudgetId,
      postedAt: NOW - 100 * DAY_MS,
      merchantName: "  Home Depot  ",
    });

    const fuzzyEventId = await seedEvent(s, { name: "Build Day", eventDate: NOW + 310 * DAY_MS });
    const fuzzyBudgetId = await seedOneTimeBudget(s, s.chapterId, "event", fuzzyEventId);
    await seedTxn(s, s.chapterId, {
      budgetId: fuzzyBudgetId,
      postedAt: NOW - 110 * DAY_MS,
      merchantName: "Home Depot Supply Co",
    });

    const txnId = await seedSubjectTxn(s, s.chapterId, { merchantName: "HOME DEPOT" });

    const result = await s.as.query(api.reconcileSuggest.rankForPicker, {
      transactionId: txnId,
    });
    const exactRow = result.rows.find((r) => r.refId === (exactEventId as string));
    const fuzzyRow = result.rows.find((r) => r.refId === (fuzzyEventId as string));
    expect(exactRow?.tier).toBe(2);
    expect(fuzzyRow?.tier).toBe(2);
    expect(exactRow?.reason).toContain("Home Depot");
    // Exact ranks strictly before fuzzy within tier 2.
    const exactIdx = result.rows.indexOf(exactRow!);
    const fuzzyIdx = result.rows.indexOf(fuzzyRow!);
    expect(exactIdx).toBeLessThan(fuzzyIdx);
  });

  test("an unrelated merchant does not trigger tier 2", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterViewer(s);
    const eventId = await seedEvent(s, { name: "Retreat", eventDate: NOW + 300 * DAY_MS });
    const budgetId = await seedOneTimeBudget(s, s.chapterId, "event", eventId);
    await seedTxn(s, s.chapterId, {
      budgetId,
      postedAt: NOW - 100 * DAY_MS,
      merchantName: "Costco",
    });
    const txnId = await seedSubjectTxn(s, s.chapterId, { merchantName: "Shell Gas Station" });

    const result = await s.as.query(api.reconcileSuggest.rankForPicker, {
      transactionId: txnId,
    });
    const row = result.rows.find((r) => r.refId === (eventId as string));
    expect(row?.tier).toBe(4);
  });
});

// ── Tier 3: upcoming date ─────────────────────────────────────────────────

describe("reconcileSuggest.rankForPicker: tier 3 (event/deadline proximity)", () => {
  test("an event dated within ±45 days ranks tier 3 (budget-less events still rank)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterViewer(s);
    const eventId = await seedEvent(s, { name: "Upcoming Gala", eventDate: NOW + 10 * DAY_MS });
    const txnId = await seedSubjectTxn(s, s.chapterId);

    const result = await s.as.query(api.reconcileSuggest.rankForPicker, {
      transactionId: txnId,
    });
    const row = result.rows.find((r) => r.refId === (eventId as string));
    expect(row?.tier).toBe(3);
    expect(row?.hasBudget).toBe(false);
    expect(row?.reason).toContain("10 days away");
  });

  test("a project's DEADLINE (not startDate) drives tier 3", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterViewer(s);
    // startDate is far away; deadline is close — tier 3 must use the deadline.
    const projectId = await seedProject(s, "Pitch Deck for EP", {
      startDate: NOW + 500 * DAY_MS,
      deadline: NOW + 3 * DAY_MS,
    });
    const txnId = await seedSubjectTxn(s, s.chapterId);

    const result = await s.as.query(api.reconcileSuggest.rankForPicker, {
      transactionId: txnId,
    });
    const row = result.rows.find((r) => r.refId === (projectId as string));
    expect(row?.tier).toBe(3);
  });

  test("a project with NO deadline never gets tier 3 (falls to tier 4)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterViewer(s);
    const projectId = await seedProject(s, "Deadline-less Project", {
      startDate: NOW,
    });
    const txnId = await seedSubjectTxn(s, s.chapterId);

    const result = await s.as.query(api.reconcileSuggest.rankForPicker, {
      transactionId: txnId,
    });
    const row = result.rows.find((r) => r.refId === (projectId as string));
    expect(row?.tier).toBe(4);
  });

  test("a date more than 45 days away does not rank tier 3", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterViewer(s);
    const eventId = await seedEvent(s, { name: "Distant Event", eventDate: NOW + 90 * DAY_MS });
    const txnId = await seedSubjectTxn(s, s.chapterId);

    const result = await s.as.query(api.reconcileSuggest.rankForPicker, {
      transactionId: txnId,
    });
    const row = result.rows.find((r) => r.refId === (eventId as string));
    expect(row?.tier).toBe(4);
  });
});

// ── Tier 4: everything else, budget-less demoted ──────────────────────────

describe("reconcileSuggest.rankForPicker: tier 4 (the rest, budget-less demoted)", () => {
  test("a budget-less project with no other signal is tier 4 and sorts AFTER budgeted tier-4 refs in its group", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterViewer(s);
    const budgetedProjectId = await seedProject(s, "Zebra Project"); // sorts last alphabetically
    await seedOneTimeBudget(s, s.chapterId, "project", budgetedProjectId);
    const budgetlessProjectId = await seedProject(s, "Aardvark Project"); // sorts first alphabetically
    const txnId = await seedSubjectTxn(s, s.chapterId);

    const result = await s.as.query(api.reconcileSuggest.rankForPicker, {
      transactionId: txnId,
    });
    const budgeted = result.rows.find((r) => r.refId === (budgetedProjectId as string))!;
    const budgetless = result.rows.find((r) => r.refId === (budgetlessProjectId as string))!;
    expect(budgeted.tier).toBe(4);
    expect(budgetless.tier).toBe(4);
    expect(budgeted.hasBudget).toBe(true);
    expect(budgetless.hasBudget).toBe(false);
    // Despite "Aardvark" sorting alphabetically first, the budgeted ref
    // (Zebra) is NOT demoted — budget-less refs trail even out of A-Z order.
    const budgetedIdx = result.rows.indexOf(budgeted);
    const budgetlessIdx = result.rows.indexOf(budgetless);
    expect(budgetedIdx).toBeLessThan(budgetlessIdx);
  });
});

// ── Single-appearance invariant ───────────────────────────────────────────

describe("reconcileSuggest.rankForPicker: single appearance", () => {
  test("a ref that qualifies for tier 1 (via its budget) does NOT also appear at tier 3 (its event is also nearby)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterViewer(s);
    const eventId = await seedEvent(s, { name: "Dual Signal Event", eventDate: NOW + 5 * DAY_MS });
    const budgetId = await seedOneTimeBudget(s, s.chapterId, "event", eventId);
    await seedTxn(s, s.chapterId, { budgetId, postedAt: NOW - 2 * DAY_MS });
    const txnId = await seedSubjectTxn(s, s.chapterId);

    const result = await s.as.query(api.reconcileSuggest.rankForPicker, {
      transactionId: txnId,
    });
    const matches = result.rows.filter((r) => r.refId === (eventId as string));
    expect(matches).toHaveLength(1);
    expect(matches[0].tier).toBe(1); // the BEST (lowest-numbered) tier wins
  });
});

// ── Bounded reads ─────────────────────────────────────────────────────────

describe("reconcileSuggest.rankForPicker: bounded reads", () => {
  test("a budget with more than the per-budget txn scan cap still resolves tier 1 and reports truncated", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterViewer(s);
    const eventId = await seedEvent(s, { name: "Busy Budget Event" });
    const budgetId = await seedOneTimeBudget(s, s.chapterId, "event", eventId);
    // 301 transactions on one budget — over the 300-row per-budget scan cap.
    for (let i = 0; i < 301; i++) {
      await seedTxn(s, s.chapterId, {
        budgetId,
        postedAt: NOW - 5 * DAY_MS - i * 60_000,
      });
    }
    const txnId = await seedSubjectTxn(s, s.chapterId);

    const result = await s.as.query(api.reconcileSuggest.rankForPicker, {
      transactionId: txnId,
    });
    const row = result.rows.find((r) => r.refId === (eventId as string));
    expect(row?.tier).toBe(1);
    expect(result.truncated).toBe(true);
  });
});

// ── Search (owner addendum) ───────────────────────────────────────────────

describe("reconcileSuggest.rankForPicker: search", () => {
  test("a name-token query matches by whole label token", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterViewer(s);
    const eventId = await seedEvent(s, { name: "Youth Retreat", eventDate: NOW + 500 * DAY_MS });
    await seedEvent(s, { name: "Choir Concert", eventDate: NOW + 500 * DAY_MS });
    const txnId = await seedSubjectTxn(s, s.chapterId);

    const result = await s.as.query(api.reconcileSuggest.rankForPicker, {
      transactionId: txnId,
      search: "retreat",
    });
    expect(result.searching).toBe(true);
    expect(result.rows.map((r) => r.refId)).toEqual([eventId as string]);
  });

  test("a date-token query ('jul 6') matches an event dated July 6, 2026", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterViewer(s);
    const julyTs = Date.UTC(2026, 6, 6, 17, 0, 0);
    const eventId = await seedEvent(s, { name: "Pitch Deck Design for EP", eventDate: julyTs });
    await seedEvent(s, { name: "Some Other Event", eventDate: NOW + 500 * DAY_MS });
    const txnId = await seedSubjectTxn(s, s.chapterId);

    const result = await s.as.query(api.reconcileSuggest.rankForPicker, {
      transactionId: txnId,
      search: "jul 6",
    });
    expect(result.rows.map((r) => r.refId)).toContain(eventId as string);
  });

  test("a type-keyword query ('project') matches only projects, not events", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterViewer(s);
    const projectId = await seedProject(s, "Some Work");
    await seedEvent(s, { name: "Some Work Event", eventDate: NOW + 500 * DAY_MS });
    const txnId = await seedSubjectTxn(s, s.chapterId);

    const result = await s.as.query(api.reconcileSuggest.rankForPicker, {
      transactionId: txnId,
      search: "project",
    });
    expect(result.rows.map((r) => r.refId)).toEqual([projectId as string]);
  });

  test("a query matching nothing returns an empty result, not an error", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterViewer(s);
    await seedEvent(s, { name: "Sunday Gathering" });
    const txnId = await seedSubjectTxn(s, s.chapterId);

    const result = await s.as.query(api.reconcileSuggest.rankForPicker, {
      transactionId: txnId,
      search: "zzzznonexistentquery",
    });
    expect(result.rows).toEqual([]);
    expect(result.searching).toBe(true);
  });

  test("within matches, a label-prefix hit ranks before a looser token match, tier breaking further ties", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterViewer(s);
    // Prefix match: label STARTS WITH "band".
    const prefixEventId = await seedEvent(s, { name: "Band Practice", eventDate: NOW + 500 * DAY_MS });
    // Looser match: "band" appears as a token but not a prefix.
    const tokenEventId = await seedEvent(s, { name: "Worship Band Retreat", eventDate: NOW + 500 * DAY_MS });
    const txnId = await seedSubjectTxn(s, s.chapterId);

    const result = await s.as.query(api.reconcileSuggest.rankForPicker, {
      transactionId: txnId,
      search: "band",
    });
    const ids = result.rows.map((r) => r.refId);
    expect(ids.indexOf(prefixEventId as string)).toBeLessThan(ids.indexOf(tokenEventId as string));
  });
});
