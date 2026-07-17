/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

/**
 * `reconcileSuggest.rankForPicker` — the "For" picker's ranking (owner spec:
 * nearby-spend, then similar-merchant, then upcoming date, then everything
 * else). Pins each tier rule individually, the single-appearance invariant,
 * the gate (mirrors `listReconcile`), and the search addendum's match-quality
 * ordering.
 *
 * WP-wave4 (item 5, owner addendum 2026-07-17): a ref with no budget, or an
 * unapproved one, no longer ranks AT ALL (`isAttributableBudget` — see
 * `finances.ts`) — the old tier-4 "budget-less, demoted" behavior is retired.
 * `seedOneTimeBudget` never sets `approvalStatus`, so every fixture budget
 * here is GRANDFATHERED (`effectiveBudgetApprovalStatus` reads absent as
 * `"approved"`) — every test below that wants a ref to RANK seeds it a
 * budget for exactly that reason; a dedicated `describe` block pins the
 * budget-less/unapproved EXCLUSION itself.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
// A fixed "today" so ±10/±45-day windows are deterministic across runs.
const NOW = Date.UTC(2026, 5, 15, 17, 0, 0); // June 15, 2026

/** Mirrors `reconcileSuggest.ts#shortDateLabel` exactly (not exported —
 *  re-derived here so tests can assert the EXACT label text a row shows,
 *  which is how the "no fabricated date" regression tests catch a wrong
 *  source field). */
function shortDateLabel(ts: number): string {
  return new Date(ts).toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

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
  opts: {
    amountCents?: number;
    label?: string;
    createdAt?: number;
    /** WP-wave4: defaults to omitted (grandfathered → reads as "approved").
     *  Pass an explicit non-approved status to test the exclusion itself. */
    approvalStatus?: "draft" | "submitted" | "approved" | "changes_requested";
  } = {},
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
      approvalStatus: opts.approvalStatus,
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
  test("a BUDGETED event dated within ±45 days ranks tier 3", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterViewer(s);
    const eventId = await seedEvent(s, { name: "Upcoming Gala", eventDate: NOW + 10 * DAY_MS });
    await seedOneTimeBudget(s, s.chapterId, "event", eventId);
    const txnId = await seedSubjectTxn(s, s.chapterId);

    const result = await s.as.query(api.reconcileSuggest.rankForPicker, {
      transactionId: txnId,
    });
    const row = result.rows.find((r) => r.refId === (eventId as string));
    expect(row?.tier).toBe(3);
    expect(row?.reason).toContain("10 days away");
  });

  test("a project's DEADLINE (not startDate) drives tier 3 AND the displayed label/dateLabel", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterViewer(s);
    // startDate is far away; deadline is close — tier 3 must use the deadline.
    const deadlineTs = NOW + 3 * DAY_MS;
    const startDateTs = NOW + 500 * DAY_MS;
    const projectId = await seedProject(s, "Pitch Deck for EP", {
      startDate: startDateTs,
      deadline: deadlineTs,
    });
    await seedOneTimeBudget(s, s.chapterId, "project", projectId);
    const txnId = await seedSubjectTxn(s, s.chapterId);

    const result = await s.as.query(api.reconcileSuggest.rankForPicker, {
      transactionId: txnId,
    });
    const row = result.rows.find((r) => r.refId === (projectId as string))!;
    expect(row.tier).toBe(3);
    // The row's label AND dateLabel must come from `deadline` — never
    // `startDate` — so the displayed date always agrees with the reason.
    const deadlineLabel = shortDateLabel(deadlineTs);
    const startDateLabel = shortDateLabel(startDateTs);
    expect(row.label).toBe(`Pitch Deck for EP · ${deadlineLabel}`);
    expect(row.dateLabel).toBe(deadlineLabel);
    expect(row.label).not.toContain(startDateLabel);
  });

  test("a BUDGETED project with NO deadline never gets tier 3 (falls to tier 4) and shows NO date claim — bare name only, even though startDate/createdAt exist", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterViewer(s);
    const projectId = await seedProject(s, "Deadline-less Project", {
      startDate: NOW,
    });
    await seedOneTimeBudget(s, s.chapterId, "project", projectId);
    const txnId = await seedSubjectTxn(s, s.chapterId);

    const result = await s.as.query(api.reconcileSuggest.rankForPicker, {
      transactionId: txnId,
    });
    const row = result.rows.find((r) => r.refId === (projectId as string))!;
    expect(row.tier).toBe(4);
    // NO FABRICATED DATE: bare name, no "· <date>" suffix borrowed from
    // startDate/createdAt, and no dateLabel at all.
    expect(row.label).toBe("Deadline-less Project");
    expect(row.dateLabel).toBeNull();
  });

  test("a project's label shows its REAL deadline, never createdAt — even when the deadline itself falls outside both tier windows (tier 4)", async () => {
    // Regression for the live bug: "Love Wins · Jul 17, 2026 — Project
    // deadline 5 days away" where Jul 17 was TODAY (the row's `createdAt`,
    // via a `startDate ?? createdAt` label fallback), not the real March 28
    // deadline. `createdAt` here is the REAL wall-clock "now" (unrelated to
    // the `NOW` test fixture used for `deadlineTs`) — exactly reproducing
    // the shape of the bug: a fixed, meaningful deadline vs. today's date.
    const t = newT();
    const s = await setupChapter(t);
    await asChapterViewer(s);
    const deadlineTs = NOW + 200 * DAY_MS; // outside tier 3's ±45-day window
    const projectId = await seedProject(s, "Love Wins", { deadline: deadlineTs });
    await seedOneTimeBudget(s, s.chapterId, "project", projectId);
    const txnId = await seedSubjectTxn(s, s.chapterId);

    const result = await s.as.query(api.reconcileSuggest.rankForPicker, {
      transactionId: txnId,
    });
    const row = result.rows.find((r) => r.refId === (projectId as string))!;
    expect(row.tier).toBe(4);
    const deadlineLabel = shortDateLabel(deadlineTs);
    const todayLabel = shortDateLabel(Date.now());
    expect(row.label).toBe(`Love Wins · ${deadlineLabel}`);
    expect(row.dateLabel).toBe(deadlineLabel);
    expect(row.label).not.toContain(todayLabel);
  });

  test("an event's label/dateLabel always come from the real eventDate (required field — no fallback to audit)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterViewer(s);
    const eventDateTs = NOW + 200 * DAY_MS; // outside tier 3's window → tier 4
    const eventId = await seedEvent(s, { name: "Choir Gala", eventDate: eventDateTs });
    await seedOneTimeBudget(s, s.chapterId, "event", eventId);
    const txnId = await seedSubjectTxn(s, s.chapterId);

    const result = await s.as.query(api.reconcileSuggest.rankForPicker, {
      transactionId: txnId,
    });
    const row = result.rows.find((r) => r.refId === (eventId as string))!;
    const expectedLabel = shortDateLabel(eventDateTs);
    expect(row.label).toBe(`Choir Gala · ${expectedLabel}`);
    expect(row.dateLabel).toBe(expectedLabel);
  });

  test("a BUDGETED ref dated more than 45 days away does not rank tier 3", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterViewer(s);
    const eventId = await seedEvent(s, { name: "Distant Event", eventDate: NOW + 90 * DAY_MS });
    await seedOneTimeBudget(s, s.chapterId, "event", eventId);
    const txnId = await seedSubjectTxn(s, s.chapterId);

    const result = await s.as.query(api.reconcileSuggest.rankForPicker, {
      transactionId: txnId,
    });
    const row = result.rows.find((r) => r.refId === (eventId as string));
    expect(row?.tier).toBe(4);
  });
});

// ── Tier 4: everything else ────────────────────────────────────────────────

describe("reconcileSuggest.rankForPicker: tier 4 (everything else)", () => {
  test("a budgeted project with no other signal is tier 4", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterViewer(s);
    const projectId = await seedProject(s, "Zebra Project");
    await seedOneTimeBudget(s, s.chapterId, "project", projectId);
    const txnId = await seedSubjectTxn(s, s.chapterId);

    const result = await s.as.query(api.reconcileSuggest.rankForPicker, {
      transactionId: txnId,
    });
    const row = result.rows.find((r) => r.refId === (projectId as string));
    expect(row?.tier).toBe(4);
  });
});

// ── WP-wave4 (item 5): unbudgeted/unapproved exclusion ─────────────────────
// Owner addendum (2026-07-17): "only approved budgets can have charges
// attached" — a ref with no budget, or one still draft/submitted/
// changes_requested, must not rank AT ALL (not even demoted to tier 4, and
// not even via a search match) — see `finances.ts#isAttributableBudget`.

describe("reconcileSuggest.rankForPicker: unbudgeted/unapproved refs never rank", () => {
  test("a project with NO budget at all does not appear anywhere in the results", async () => {
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
    expect(result.rows.some((r) => r.refId === (budgetedProjectId as string))).toBe(true);
    expect(result.rows.some((r) => r.refId === (budgetlessProjectId as string))).toBe(false);
  });

  test("an event whose budget is still DRAFT does not rank", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterViewer(s);
    const eventId = await seedEvent(s, { name: "Draft-budget Gala", eventDate: NOW + 5 * DAY_MS });
    await seedOneTimeBudget(s, s.chapterId, "event", eventId, { approvalStatus: "draft" });
    const txnId = await seedSubjectTxn(s, s.chapterId);

    const result = await s.as.query(api.reconcileSuggest.rankForPicker, {
      transactionId: txnId,
    });
    expect(result.rows.some((r) => r.refId === (eventId as string))).toBe(false);
  });

  test("an event whose budget is SUBMITTED (not yet approved) does not rank", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterViewer(s);
    const eventId = await seedEvent(s, { name: "Submitted-budget Gala", eventDate: NOW + 5 * DAY_MS });
    await seedOneTimeBudget(s, s.chapterId, "event", eventId, { approvalStatus: "submitted" });
    const txnId = await seedSubjectTxn(s, s.chapterId);

    const result = await s.as.query(api.reconcileSuggest.rankForPicker, {
      transactionId: txnId,
    });
    expect(result.rows.some((r) => r.refId === (eventId as string))).toBe(false);
  });

  test("an event whose budget is APPROVED ranks normally", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterViewer(s);
    const eventId = await seedEvent(s, { name: "Approved-budget Gala", eventDate: NOW + 5 * DAY_MS });
    await seedOneTimeBudget(s, s.chapterId, "event", eventId, { approvalStatus: "approved" });
    const txnId = await seedSubjectTxn(s, s.chapterId);

    const result = await s.as.query(api.reconcileSuggest.rankForPicker, {
      transactionId: txnId,
    });
    expect(result.rows.some((r) => r.refId === (eventId as string))).toBe(true);
  });

  test("a search query never surfaces a budget-less ref, even on an exact label match", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterViewer(s);
    const eventId = await seedEvent(s, { name: "Unbudgeted Retreat", eventDate: NOW + 500 * DAY_MS });
    const txnId = await seedSubjectTxn(s, s.chapterId);

    const result = await s.as.query(api.reconcileSuggest.rankForPicker, {
      transactionId: txnId,
      search: "retreat",
    });
    expect(result.rows.some((r) => r.refId === (eventId as string))).toBe(false);
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
  test("evidence is taken NEWEST-first — a nearby transaction inserted LAST among 350 old ones still wins the 300-row cap and ranks tier 1", async () => {
    // This is the ordering-sensitive case: with Convex's default ASCENDING
    // index order, `.take(300)` over 351 rows would take the 350 OLD
    // (oldest-inserted) rows and silently drop the one nearby, recently-
    // inserted transaction — burying real, current evidence behind ancient
    // history. `loadBudgetTxns` must `.order("desc")` so the cap keeps the
    // NEWEST-inserted rows instead.
    const t = newT();
    const s = await setupChapter(t);
    await asChapterViewer(s);
    const eventId = await seedEvent(s, { name: "Busy Budget Event" });
    const budgetId = await seedOneTimeBudget(s, s.chapterId, "event", eventId);
    // 350 OLD transactions, far outside the ±10-day tier-1 window, inserted
    // FIRST (oldest by `_creationTime`).
    for (let i = 0; i < 350; i++) {
      await seedTxn(s, s.chapterId, {
        budgetId,
        postedAt: NOW - 400 * DAY_MS - i * 60_000,
      });
    }
    // The NEWEST-inserted transaction (highest `_creationTime`, seeded last)
    // IS within the ±10-day tier-1 window.
    await seedTxn(s, s.chapterId, { budgetId, postedAt: NOW - 3 * DAY_MS });
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
    await seedOneTimeBudget(s, s.chapterId, "event", eventId);
    const otherId = await seedEvent(s, { name: "Choir Concert", eventDate: NOW + 500 * DAY_MS });
    await seedOneTimeBudget(s, s.chapterId, "event", otherId);
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
    await seedOneTimeBudget(s, s.chapterId, "event", eventId);
    const otherId = await seedEvent(s, { name: "Some Other Event", eventDate: NOW + 500 * DAY_MS });
    await seedOneTimeBudget(s, s.chapterId, "event", otherId);
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
    await seedOneTimeBudget(s, s.chapterId, "project", projectId);
    const eventId = await seedEvent(s, { name: "Some Work Event", eventDate: NOW + 500 * DAY_MS });
    await seedOneTimeBudget(s, s.chapterId, "event", eventId);
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
    const eventId = await seedEvent(s, { name: "Sunday Gathering" });
    await seedOneTimeBudget(s, s.chapterId, "event", eventId);
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
    await seedOneTimeBudget(s, s.chapterId, "event", prefixEventId);
    // Looser match: "band" appears as a token but not a prefix.
    const tokenEventId = await seedEvent(s, { name: "Worship Band Retreat", eventDate: NOW + 500 * DAY_MS });
    await seedOneTimeBudget(s, s.chapterId, "event", tokenEventId);
    const txnId = await seedSubjectTxn(s, s.chapterId);

    const result = await s.as.query(api.reconcileSuggest.rankForPicker, {
      transactionId: txnId,
      search: "band",
    });
    const ids = result.rows.map((r) => r.refId);
    expect(ids.indexOf(prefixEventId as string)).toBeLessThan(ids.indexOf(tokenEventId as string));
  });

  test("a query with no matchable characters (e.g. '!!!') is treated as an EMPTY search — the default tiered view, never match-everything", async () => {
    // Regression: `matchBucket`'s `queryTokens.every(...)` is vacuously TRUE
    // for an empty token array, so a query that tokenizes to nothing (all
    // punctuation) used to match every candidate instead of none.
    const t = newT();
    const s = await setupChapter(t);
    await asChapterViewer(s);
    const eventId = await seedEvent(s, { name: "Sunday Gathering", eventDate: NOW + 5 * DAY_MS });
    await seedOneTimeBudget(s, s.chapterId, "event", eventId);
    const txnId = await seedSubjectTxn(s, s.chapterId);

    const withPunctuation = await s.as.query(api.reconcileSuggest.rankForPicker, {
      transactionId: txnId,
      search: "!!!",
    });
    const withoutSearch = await s.as.query(api.reconcileSuggest.rankForPicker, {
      transactionId: txnId,
    });
    expect(withPunctuation.searching).toBe(false);
    expect(withPunctuation.rows).toEqual(withoutSearch.rows);
    // Sanity: the event really is a live candidate — a vacuous "everything
    // matches" bug and a genuinely-empty candidate set look identical unless
    // we confirm there's something in the default view to (not) filter.
    expect(withoutSearch.rows.some((r) => r.refId === (eventId as string))).toBe(true);
  });

  test("a multi-word label match is not broken by the merchant-similarity stopword list (e.g. 'And')", async () => {
    // Regression: label search used to reuse `merchantTokens` (tier 2's
    // fuzzy-merchant-matching tokenizer), which strips common words like
    // "and" as noise. A query built from non-contiguous label tokens that
    // happen to include a stopword must still match via whole-token coverage
    // — not fall through to nothing just because "and" was silently dropped
    // from the candidate's own token set.
    const t = newT();
    const s = await setupChapter(t);
    await asChapterViewer(s);
    const eventId = await seedEvent(s, {
      name: "Youth And Young Adults Retreat",
      eventDate: NOW + 500 * DAY_MS,
    });
    await seedOneTimeBudget(s, s.chapterId, "event", eventId);
    const otherId = await seedEvent(s, { name: "Choir Concert", eventDate: NOW + 500 * DAY_MS });
    await seedOneTimeBudget(s, s.chapterId, "event", otherId);
    const txnId = await seedSubjectTxn(s, s.chapterId);

    // "and retreat" is NOT a contiguous substring of the label (word order
    // differs), so this can only match via whole-token-set coverage —
    // exercising exactly the path the stopword-filtering bug broke.
    const result = await s.as.query(api.reconcileSuggest.rankForPicker, {
      transactionId: txnId,
      search: "and retreat",
    });
    expect(result.rows.map((r) => r.refId)).toEqual([eventId as string]);
  });
});
