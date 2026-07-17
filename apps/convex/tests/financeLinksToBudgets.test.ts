/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { easternParts } from "@events-os/shared";

/**
 * WP-U — "one home per dollar": budgetId subsumes the old eventId/projectId
 * link. Phase A (this PR) stops WRITING the FKs and switches reads to
 * budget-first, but doesn't drop the FK columns yet.
 *
 * Covers the net-new surface:
 *  - `forPickerOptions` — the "For" picker's option groups (events/projects,
 *    budgeted + summon-candidates, plus recurring budgets by level).
 *  - `summonBudgetForRef` — get-or-create the one_time budget for a ref,
 *    idempotently, at $0. Gated at BOOKKEEPER (not manager) — pinned deliberately.
 *  - `migrateLinksToBudgets` — the phase-A backfill migration (absent →
 *    backfilled + summoned; present-and-different → kept, logged as a
 *    STRUCTURED conflict — not a bare id — with the ref name, both budgets'
 *    display names, and a sentence-level implication; idempotent re-run;
 *    chapter-scoped runs; central rows skipped; PAGINATED via native
 *    `.paginate()` — re-invoke with `continueCursor` until `isDone` proves
 *    every row was examined; see `docs/plans/link-migration-runbook.md`).
 *  - `eventActuals`/`projectActuals` are budget-first: a legacy eventId-only
 *    txn contributes NOTHING until the migration backfills its budgetId. A
 *    conflict-residue txn stays ABSENT from its ref's actuals post-migration
 *    (present under whatever budget the human explicitly kept it on) — the
 *    parity claim's deliberate exception, pinned here.
 *  - `createBudget` rejects a second one_time budget for the same ref (D8:
 *    one budget per ref); `actualsForRef` sums across ALL `by_ref` budgets so
 *    a legacy duplicate already in data still counts in full.
 */

const SUPER = "seyi@publicworship.life";

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

/** A bookkeeper-graded caller — one rung below manager on the finance-role
 *  ladder (viewer < bookkeeper < manager). `summonBudgetForRef` deliberately
 *  gates at "bookkeeper" (not "manager", unlike full budget CRUD) since
 *  summoning a ref's budget is part of ordinary reconcile/categorize work. */
async function asBookkeeper(s: ChapterSetup): Promise<Id<"people">> {
  const personId = await seedSelfPerson(s);
  await run(s.t, (ctx) =>
    ctx.db.insert("financeRoles", {
      chapterId: s.chapterId,
      personId,
      role: "bookkeeper",
      scope: "chapter",
      createdAt: Date.now(),
    }),
  );
  return personId;
}

async function seedEvent(
  s: ChapterSetup,
  chapterId: Id<"chapters">,
  opts: { name?: string; eventDate?: number } = {},
): Promise<Id<"events">> {
  return await run(s.t, async (ctx) => {
    const eventTypeId = await ctx.db.insert("eventTypes", {
      chapterId,
      name: "Service",
      slug: "service",
      version: 1,
      createdBy: s.userId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    return await ctx.db.insert("events", {
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

async function seedProject(
  s: ChapterSetup,
  chapterId: Id<"chapters">,
  name: string,
  opts: { deadline?: number; startDate?: number; createdAt?: number } = {},
): Promise<Id<"projects">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("projects", {
      chapterId,
      name,
      status: "in_progress",
      deadline: opts.deadline,
      startDate: opts.startDate,
      createdBy: s.userId,
      createdAt: opts.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    }),
  );
}

const MONTH_NAMES_FOR_TEST = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** Mirrors `finances.ts#pickerRefLabel` exactly (not exported — re-derived
 *  here, via the SAME exported `easternParts`, so a test can assert the
 *  EXACT label text a row shows — the only way to catch a wrong SOURCE FIELD
 *  for the date, not just a wrong tier/group). */
function pickerRefLabelForTest(name: string, ts: number): string {
  const p = easternParts(ts);
  const monthName = MONTH_NAMES_FOR_TEST[p.month - 1].slice(0, 3);
  return `${name} · ${monthName} ${p.day}, ${p.year}`;
}

/** Raw-insert a "legacy" transaction carrying ONLY the pre-WP-U FK (no
 *  `budgetId`) — simulates a row written before this PR. */
async function seedLegacyTxn(
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
      postedAt: Date.now(),
      status: "unreviewed",
      createdAt: Date.now(),
      ...fields,
    }),
  );
}

// ── forPickerOptions ──────────────────────────────────────────────────────────

describe("forPickerOptions — the 'For' picker's option groups", () => {
  test("groups events/projects (budgeted + summon-candidates) and recurring budgets by level", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);

    const budgetedEventId = await seedEvent(s, s.chapterId, { name: "Budgeted Event" });
    const bareEventId = await seedEvent(s, s.chapterId, { name: "Bare Event" });
    const eventBudgetId = await s.as.mutation(api.finances.createBudget, {
      amountCents: 40000,
      type: "one_time",
      refKind: "event",
      cadence: "per_instance",
      year: 2026,
      scopeRefId: budgetedEventId,
    });

    const budgetedProjectId = await seedProject(s, s.chapterId, "Budgeted Project");
    const bareProjectId = await seedProject(s, s.chapterId, "Bare Project");
    const projectBudgetId = await s.as.mutation(api.finances.createBudget, {
      amountCents: 20000,
      type: "one_time",
      refKind: "project",
      cadence: "per_instance",
      year: 2026,
      scopeRefId: budgetedProjectId,
    });

    const recurringChapterBudgetId = await s.as.mutation(api.finances.createBudget, {
      amountCents: 100000,
      type: "recurring",
      cadence: "monthly",
      year: 2026,
      month: 1,
      label: "Ops",
    });

    const options = await s.as.query(api.finances.forPickerOptions, {});

    const eventRow = options.events.find((e) => e.eventId === budgetedEventId);
    expect(eventRow?.budgetId).toBe(eventBudgetId);
    const bareEventRow = options.events.find((e) => e.eventId === bareEventId);
    expect(bareEventRow).toBeDefined();
    expect(bareEventRow?.budgetId).toBeNull();

    const projectRow = options.projects.find((p) => p.projectId === budgetedProjectId);
    expect(projectRow?.budgetId).toBe(projectBudgetId);
    const bareProjectRow = options.projects.find((p) => p.projectId === bareProjectId);
    expect(bareProjectRow).toBeDefined();
    expect(bareProjectRow?.budgetId).toBeNull();

    const recurringRow = options.recurring.find((r) => r.budgetId === recurringChapterBudgetId);
    expect(recurringRow?.level).toBe("chapter");
    // The one_time budgets are NOT also listed under recurring.
    expect(options.recurring.some((r) => r.budgetId === eventBudgetId)).toBe(false);
    expect(options.recurring.some((r) => r.budgetId === projectBudgetId)).toBe(false);
  });

  // ── No fabricated dates (identical fix to #219's reconcileSuggest.ts) ─────

  test("a project's label derives its date from `deadline` — never `startDate` — even when both are set", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    const deadlineTs = Date.now() + 3 * 24 * 60 * 60 * 1000;
    const startDateTs = Date.now() + 500 * 24 * 60 * 60 * 1000;
    const projectId = await seedProject(s, s.chapterId, "Pitch Deck for EP", {
      deadline: deadlineTs,
      startDate: startDateTs,
    });

    const options = await s.as.query(api.finances.forPickerOptions, {});
    const row = options.projects.find((p) => p.projectId === projectId)!;
    expect(row.label).toBe(pickerRefLabelForTest("Pitch Deck for EP", deadlineTs));
    expect(row.label).not.toBe(pickerRefLabelForTest("Pitch Deck for EP", startDateTs));
  });

  test("a project with NO deadline shows its bare name — no date claim borrowed from startDate or createdAt", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    const startDateTs = Date.now() + 500 * 24 * 60 * 60 * 1000;
    const projectId = await seedProject(s, s.chapterId, "Deadline-less Project", {
      startDate: startDateTs,
    });

    const options = await s.as.query(api.finances.forPickerOptions, {});
    const row = options.projects.find((p) => p.projectId === projectId)!;
    expect(row.label).toBe("Deadline-less Project");
  });

  test("a project's label shows its REAL deadline, never createdAt (the live 'Love Wins' bug: createdAt is real wall-clock 'now', deadline is a fixed unrelated date)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    const deadlineTs = Date.now() + 200 * 24 * 60 * 60 * 1000; // a fixed, far-off real deadline
    const projectId = await seedProject(s, s.chapterId, "Love Wins", {
      deadline: deadlineTs,
      createdAt: Date.now(), // real wall-clock "today" — the fabricated-date bug's source
    });

    const options = await s.as.query(api.finances.forPickerOptions, {});
    const row = options.projects.find((p) => p.projectId === projectId)!;
    const deadlineLabel = pickerRefLabelForTest("Love Wins", deadlineTs);
    const todayLabel = pickerRefLabelForTest("Love Wins", Date.now());
    expect(row.label).toBe(deadlineLabel);
    expect(row.label).not.toBe(todayLabel);
  });

  test("an event's label is always pinned to its (required) eventDate — unaffected by this fix, audited and unchanged", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    const eventDate = Date.now() + 10 * 24 * 60 * 60 * 1000;
    const eventId = await seedEvent(s, s.chapterId, { name: "Sunday Gathering", eventDate });

    const options = await s.as.query(api.finances.forPickerOptions, {});
    const row = options.events.find((e) => e.eventId === eventId)!;
    expect(row.label).toBe(pickerRefLabelForTest("Sunday Gathering", eventDate));
  });

  test("a project's budget that moved to central still appears in the projects group (by_ref discovery), not recurring", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: SUPER });
    const projectId = await seedProject(s, s.chapterId, "Music Recording");
    const budgetId = await s.as.mutation(api.finances.createBudget, {
      amountCents: 30000,
      type: "one_time",
      refKind: "project",
      cadence: "per_instance",
      year: 2026,
      scopeRefId: projectId,
    });
    await s.as.mutation(api.finances.transferProjectScope, {
      projectId,
      target: "central",
    });

    const options = await s.as.query(api.finances.forPickerOptions, {});
    const projectRow = options.projects.find((p) => p.projectId === projectId);
    expect(projectRow?.budgetId).toBe(budgetId);
    expect(options.recurring.some((r) => r.budgetId === budgetId)).toBe(false);
  });

  test("a central recurring budget shows up with level:'central' for any chapter caller", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: SUPER });
    const centralBudgetId = await s.as.mutation(api.finances.createBudget, {
      amountCents: 500000,
      type: "recurring",
      cadence: "yearly",
      year: 2026,
      central: true,
      label: "City Launch Fund",
    });

    const options = await s.as.query(api.finances.forPickerOptions, {});
    const row = options.recurring.find((r) => r.budgetId === centralBudgetId);
    expect(row?.level).toBe("central");
  });
});

// ── summonBudgetForRef ────────────────────────────────────────────────────────

describe("summonBudgetForRef — the 'For' picker's summon-on-pick", () => {
  test("creates a $0 one_time budget for a budget-less event, and is idempotent", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    const eventId = await seedEvent(s, s.chapterId, { name: "Fresh Event" });

    const budgetId = await s.as.mutation(api.finances.summonBudgetForRef, {
      refKind: "event",
      scopeRefId: eventId,
    });
    const budget = await run(t, (ctx) => ctx.db.get(budgetId));
    expect(budget?.amountCents).toBe(0);
    expect(budget?.type).toBe("one_time");
    expect(budget?.refKind).toBe("event");
    expect(budget?.scopeRefId).toBe(eventId);
    expect(budget?.chapterId).toBe(s.chapterId);

    // Idempotent: a second call returns the SAME budget — no duplicate.
    const again = await s.as.mutation(api.finances.summonBudgetForRef, {
      refKind: "event",
      scopeRefId: eventId,
    });
    expect(again).toBe(budgetId);
    const all = await run(t, (ctx) =>
      ctx.db
        .query("budgets")
        .withIndex("by_ref", (q) => q.eq("refKind", "event").eq("scopeRefId", eventId))
        .collect(),
    );
    expect(all.length).toBe(1);
  });

  test("creates a $0 one_time budget for a budget-less project", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    const projectId = await seedProject(s, s.chapterId, "Fresh Project");

    const budgetId = await s.as.mutation(api.finances.summonBudgetForRef, {
      refKind: "project",
      scopeRefId: projectId,
    });
    const budget = await run(t, (ctx) => ctx.db.get(budgetId));
    expect(budget?.amountCents).toBe(0);
    expect(budget?.refKind).toBe("project");
    expect(budget?.scopeRefId).toBe(projectId);
  });

  test("a summoned budget survives removeEmptyAutoBudgets once it has linked spend", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    const eventId = await seedEvent(s, s.chapterId);
    const budgetId = await s.as.mutation(api.finances.summonBudgetForRef, {
      refKind: "event",
      scopeRefId: eventId,
    });
    const txnId = await s.as.mutation(api.finances.createManualTransaction, {
      flow: "outflow",
      amountCents: 1000,
      postedAt: Date.now(),
      budgetId,
    });
    void txnId;

    await t.mutation(internal.finances.removeEmptyAutoBudgets, {
      chapterId: s.chapterId,
    });
    expect(await run(t, (ctx) => ctx.db.get(budgetId))).not.toBeNull();
  });

  test("rejects a ref from another chapter", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    const other = await setupChapter(t, { email: "other@publicworship.life" });
    const foreignEventId = await seedEvent(other, other.chapterId);

    await expect(
      s.as.mutation(api.finances.summonBudgetForRef, {
        refKind: "event",
        scopeRefId: foreignEventId,
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("a BOOKKEEPER (not manager) can summon a budget via the picker", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asBookkeeper(s);
    const eventId = await seedEvent(s, s.chapterId, { name: "Bookkeeper-summoned Event" });

    const budgetId = await s.as.mutation(api.finances.summonBudgetForRef, {
      refKind: "event",
      scopeRefId: eventId,
    });
    const budget = await run(t, (ctx) => ctx.db.get(budgetId));
    expect(budget?.refKind).toBe("event");
    expect(budget?.scopeRefId).toBe(eventId);
  });
});

// ── migrateLinksToBudgets (phase-A backfill) ─────────────────────────────────

describe("migrateLinksToBudgets — WP-U phase A backfill", () => {
  test("backfills budgetId when absent, summoning the ref's budget", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s, s.chapterId, { name: "Legacy Event" });
    const txnId = await seedLegacyTxn(s, s.chapterId, { eventId });

    const result = await t.mutation(internal.finances.migrateLinksToBudgets, {});
    expect(result.scanned).toBe(1);
    expect(result.backfilled).toBe(1);
    expect(result.budgetsSummoned).toBe(1);
    expect(result.conflictCount).toBe(0);
    expect(result.conflicts).toEqual([]);
    expect(result.skipped).toBe(0);
    // A single-row chapter fits in one page — the operator's completeness proof.
    expect(result.isDone).toBe(true);

    const txn = await run(t, (ctx) => ctx.db.get(txnId));
    expect(txn?.budgetId).toBeDefined();
    const budget = await run(t, (ctx) => ctx.db.get(txn!.budgetId!));
    expect(budget?.refKind).toBe("event");
    expect(budget?.scopeRefId).toBe(eventId);
    expect(budget?.amountCents).toBe(0);
    // The legacy FK is untouched (phase A clears nothing).
    expect(txn?.eventId).toBe(eventId);

    // Idempotent re-run: nothing left to backfill or summon.
    const second = await t.mutation(internal.finances.migrateLinksToBudgets, {});
    expect(second.scanned).toBe(1);
    expect(second.backfilled).toBe(0);
    expect(second.alreadySet).toBe(1);
    expect(second.budgetsSummoned).toBe(0);
  });

  test("reuses an EXISTING ref budget instead of summoning a duplicate", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    const projectId = await seedProject(s, s.chapterId, "Legacy Project");
    const existingBudgetId = await s.as.mutation(api.finances.createBudget, {
      amountCents: 75000,
      type: "one_time",
      refKind: "project",
      cadence: "per_instance",
      year: 2026,
      scopeRefId: projectId,
    });
    const txnId = await seedLegacyTxn(s, s.chapterId, { projectId });

    const result = await t.mutation(internal.finances.migrateLinksToBudgets, {});
    expect(result.backfilled).toBe(1);
    expect(result.budgetsSummoned).toBe(0); // reused, not summoned

    const txn = await run(t, (ctx) => ctx.db.get(txnId));
    expect(txn?.budgetId).toBe(existingBudgetId);
  });

  test("preserves a conflicting explicit budgetId — never overwrites a human's later re-code — and reports it as an actionable structured conflict", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s, s.chapterId, { name: "Legacy Event" });
    const otherBudgetId = await run(t, (ctx) =>
      ctx.db.insert("budgets", {
        chapterId: s.chapterId,
        amountCents: 100000,
        type: "recurring",
        cadence: "yearly",
        year: 2026,
        label: "Ops Fund",
        createdAt: Date.now(),
      }),
    );
    const txnId = await seedLegacyTxn(s, s.chapterId, {
      eventId,
      budgetId: otherBudgetId,
      status: "categorized",
      merchantName: "Guitar Center",
      amountCents: 15000,
    });

    const result = await t.mutation(internal.finances.migrateLinksToBudgets, {});
    expect(result.conflictCount).toBe(1);
    expect(result.backfilled).toBe(0);

    // Structured — not a bare id — so a reviewer can act on the CLI/log
    // output alone: which txn, which ref, its ref-budget vs. the CURRENT
    // budget it's attributed to, and the sentence-level implication.
    expect(result.conflicts).toHaveLength(1);
    const conflict = result.conflicts[0];
    expect(conflict.transactionId).toBe(txnId);
    expect(conflict.merchantName).toBe("Guitar Center");
    expect(conflict.amountCents).toBe(15000);
    expect(conflict.refKind).toBe("event");
    expect(conflict.refId).toBe(eventId);
    expect(conflict.refName).toBe("Legacy Event");
    expect(conflict.currentBudgetId).toBe(otherBudgetId);
    expect(conflict.currentBudgetLabel).toBe("Ops Fund");
    // The ref's own (summoned) budget — what this txn would have been
    // attributed to had the migration not deferred to the human's re-code.
    expect(conflict.refBudgetId).not.toBe(otherBudgetId);
    expect(conflict.message).toContain("Legacy Event");
    expect(conflict.message).toContain("Ops Fund");

    const txn = await run(t, (ctx) => ctx.db.get(txnId));
    expect(txn?.budgetId).toBe(otherBudgetId); // kept, not clobbered
  });

  test("skips a central-owned row defensively (central never legitimately carries these FKs)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s, s.chapterId);
    const txnId = await seedLegacyTxn(s, "central", { eventId });

    const result = await t.mutation(internal.finances.migrateLinksToBudgets, {});
    expect(result.scanned).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.backfilled).toBe(0);

    const txn = await run(t, (ctx) => ctx.db.get(txnId));
    expect(txn?.budgetId).toBeUndefined();
  });

  test("a stale FK pointing at a deleted event is skipped, not thrown", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s, s.chapterId);
    const txnId = await seedLegacyTxn(s, s.chapterId, { eventId });
    await run(t, (ctx) => ctx.db.delete(eventId));

    const result = await t.mutation(internal.finances.migrateLinksToBudgets, {});
    expect(result.skipped).toBe(1);
    expect(result.backfilled).toBe(0);
    const txn = await run(t, (ctx) => ctx.db.get(txnId));
    expect(txn?.budgetId).toBeUndefined();
  });

  test("a chapterId-scoped run only touches that chapter's transactions", async () => {
    const t = newT();
    const s1 = await setupChapter(t, { chapterName: "A" });
    const s2 = await setupChapter(t, { email: "b@publicworship.life", chapterName: "B" });
    const event1 = await seedEvent(s1, s1.chapterId);
    const event2 = await seedEvent(s2, s2.chapterId);
    await seedLegacyTxn(s1, s1.chapterId, { eventId: event1 });
    await seedLegacyTxn(s2, s2.chapterId, { eventId: event2 });

    const result = await t.mutation(internal.finances.migrateLinksToBudgets, {
      chapterId: s1.chapterId,
    });
    expect(result.scanned).toBe(1);
    expect(result.backfilled).toBe(1);
  });

  test("paginates across multiple pages and proves completeness via isDone/continueCursor", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s, s.chapterId, { name: "Recurring Legacy Event" });
    // 5 legacy txns, all pointing at the SAME event — a small `numItems` forces
    // more than one page, exercising the exact re-invoke-with-cursor path the
    // runbook documents (`.take(ROLLUP_SCAN_LIMIT)` would have silently read
    // all 5 in one shot and never surfaced this).
    const txnIds = await Promise.all(
      Array.from({ length: 5 }, () => seedLegacyTxn(s, s.chapterId, { eventId })),
    );

    let cursor: string | null = null;
    let pages = 0;
    let totalScanned = 0;
    let totalBackfilled = 0;
    let isDone = false;
    while (!isDone) {
      const page: {
        scanned: number;
        backfilled: number;
        isDone: boolean;
        continueCursor: string;
      } = await t.mutation(internal.finances.migrateLinksToBudgets, {
        paginationOpts: { numItems: 2, cursor },
      });
      pages++;
      totalScanned += page.scanned;
      totalBackfilled += page.backfilled;
      isDone = page.isDone;
      cursor = page.continueCursor;
      // Guard against an infinite loop if pagination ever regressed.
      expect(pages).toBeLessThan(10);
    }

    // 5 rows at numItems:2 takes at least 3 pages to reach isDone.
    expect(pages).toBeGreaterThanOrEqual(3);
    expect(totalScanned).toBe(5);
    expect(totalBackfilled).toBe(5);

    for (const txnId of txnIds) {
      const txn = await run(t, (ctx) => ctx.db.get(txnId));
      expect(txn?.budgetId).toBeDefined();
    }
    // Only ONE budget was summoned for the shared ref across every page —
    // `ensureBudgetForRef`'s get-or-create holds across page boundaries.
    const budgets = await run(t, (ctx) =>
      ctx.db
        .query("budgets")
        .withIndex("by_ref", (q) => q.eq("refKind", "event").eq("scopeRefId", eventId))
        .collect(),
    );
    expect(budgets).toHaveLength(1);
  });
});

// ── eventActuals/projectActuals are budget-first ─────────────────────────────

describe("eventActuals/projectActuals are budget-first and agree post-migration", () => {
  test("a legacy eventId-only txn contributes to eventActuals ONLY after migrateLinksToBudgets backfills its budget", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    const eventId = await seedEvent(s, s.chapterId, { name: "Legacy Worship" });
    const txnId = await seedLegacyTxn(s, s.chapterId, { eventId, amountCents: 12000 });

    // Pre-migration: budget-first eventActuals sees nothing (no budgetId yet).
    let actuals = await s.as.query(api.finances.eventActuals, { eventId });
    expect(actuals.totalCents).toBe(0);
    expect(actuals.transactions).toHaveLength(0);

    await t.mutation(internal.finances.migrateLinksToBudgets, {});

    // Post-migration: the backfilled budgetId makes it count.
    actuals = await s.as.query(api.finances.eventActuals, { eventId });
    expect(actuals.totalCents).toBe(12000);
    expect(actuals.transactions.map((tr) => tr.id)).toEqual([txnId]);
  });

  test("a legacy projectId-only txn contributes to projectActuals ONLY after migration", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    const projectId = await seedProject(s, s.chapterId, "Legacy Project");
    const txnId = await seedLegacyTxn(s, s.chapterId, { projectId, amountCents: 8000 });

    let actuals = await s.as.query(api.finances.projectActuals, { projectId });
    expect(actuals.totalCents).toBe(0);

    await t.mutation(internal.finances.migrateLinksToBudgets, {});

    actuals = await s.as.query(api.finances.projectActuals, { projectId });
    expect(actuals.totalCents).toBe(8000);
    expect(actuals.transactions.map((tr) => tr.id)).toEqual([txnId]);
  });

  test("an event/project with no budget at all reports zero actuals (no crash on a missing ref)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    const eventId = await seedEvent(s, s.chapterId);

    const actuals = await s.as.query(api.finances.eventActuals, { eventId });
    expect(actuals.totalCents).toBe(0);
    expect(actuals.transactions).toEqual([]);
  });

  test("a conflict-residue txn is ABSENT from eventActuals(E) post-migration and PRESENT under its kept budget — the parity claim's deliberate exception", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    const eventId = await seedEvent(s, s.chapterId, { name: "Conflict Event" });
    const keptBudgetId = await s.as.mutation(api.finances.createBudget, {
      amountCents: 100000,
      type: "recurring",
      cadence: "monthly",
      year: 2026,
      month: new Date().getUTCMonth() + 1,
      label: "General Ops",
    });
    const txnId = await seedLegacyTxn(s, s.chapterId, {
      eventId,
      budgetId: keptBudgetId,
      status: "categorized",
      amountCents: 6000,
    });

    const result = await t.mutation(internal.finances.migrateLinksToBudgets, {});
    expect(result.conflictCount).toBe(1);

    // ABSENT from the event's own actuals — the migration never redirects a
    // human's explicit re-code, so E's summoned budget has no linked spend.
    const eventActuals = await s.as.query(api.finances.eventActuals, { eventId });
    expect(eventActuals.totalCents).toBe(0);
    expect(eventActuals.transactions.map((tr) => tr.id)).not.toContain(txnId);

    // PRESENT under the budget the human actually kept it on — findable via
    // the SAME `by_budget` index `actualsForRef`/the dashboard rollups read.
    const txn = await run(t, (ctx) => ctx.db.get(txnId));
    expect(txn?.budgetId).toBe(keptBudgetId);
    const keptBudgetTxns = await run(t, (ctx) =>
      ctx.db
        .query("transactions")
        .withIndex("by_budget", (q) => q.eq("budgetId", keptBudgetId))
        .collect(),
    );
    expect(keptBudgetTxns.map((tr) => tr._id)).toContain(txnId);
  });
});

// ── createBudget dedup + actualsForRef summing legacy duplicates ────────────
// (Important-2: `actualsForRef`'s old `by_ref .first()` undercounted a ref
// with 2+ one_time budgets. Fixed both ends — creation-time dedup so a NEW
// duplicate is rejected outright, and a summing fix so any duplicate already
// in legacy data still counts in full.)

describe("createBudget rejects a second one_time budget for the same ref (D8 invariant)", () => {
  test("rejects with a ConvexError pointing at the existing budget", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    const eventId = await seedEvent(s, s.chapterId, { name: "Single-budget Event" });
    await s.as.mutation(api.finances.createBudget, {
      amountCents: 40000,
      type: "one_time",
      refKind: "event",
      cadence: "per_instance",
      year: 2026,
      label: "First Budget",
      scopeRefId: eventId,
    });

    await expect(
      s.as.mutation(api.finances.createBudget, {
        amountCents: 5000,
        type: "one_time",
        refKind: "event",
        cadence: "per_instance",
        year: 2026,
        label: "Second Budget",
        scopeRefId: eventId,
      }),
    ).rejects.toBeInstanceOf(ConvexError);

    const budgets = await run(t, (ctx) =>
      ctx.db
        .query("budgets")
        .withIndex("by_ref", (q) => q.eq("refKind", "event").eq("scopeRefId", eventId))
        .collect(),
    );
    expect(budgets).toHaveLength(1);
    expect(budgets[0].label).toBe("First Budget");
  });

  test("also rejects a duplicate PROJECT budget", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    const projectId = await seedProject(s, s.chapterId, "Single-budget Project");
    await s.as.mutation(api.finances.createBudget, {
      amountCents: 20000,
      type: "one_time",
      refKind: "project",
      cadence: "per_instance",
      year: 2026,
      scopeRefId: projectId,
    });

    await expect(
      s.as.mutation(api.finances.createBudget, {
        amountCents: 1000,
        type: "one_time",
        refKind: "project",
        cadence: "per_instance",
        year: 2026,
        scopeRefId: projectId,
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });
});

describe("actualsForRef sums across ALL by_ref budgets — legacy duplicates still count in full", () => {
  test("two one_time budgets for the same event both contribute to eventActuals", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    const eventId = await seedEvent(s, s.chapterId, { name: "Duplicated Event" });

    // Simulate a pre-existing legacy duplicate (raw-inserted — createBudget's
    // dedup guard only stops NEW duplicates from being created going forward).
    const firstBudgetId = await run(t, (ctx) =>
      ctx.db.insert("budgets", {
        chapterId: s.chapterId,
        amountCents: 40000,
        type: "one_time",
        refKind: "event",
        scopeRefId: eventId,
        cadence: "per_instance",
        year: 2026,
        createdAt: 1000,
      }),
    );
    const secondBudgetId = await run(t, (ctx) =>
      ctx.db.insert("budgets", {
        chapterId: s.chapterId,
        amountCents: 10000,
        type: "one_time",
        refKind: "event",
        scopeRefId: eventId,
        cadence: "per_instance",
        year: 2026,
        createdAt: 2000,
      }),
    );
    const txn1 = await s.as.mutation(api.finances.createManualTransaction, {
      flow: "outflow",
      amountCents: 3000,
      postedAt: Date.now(),
      budgetId: firstBudgetId,
    });
    const txn2 = await s.as.mutation(api.finances.createManualTransaction, {
      flow: "outflow",
      amountCents: 4000,
      postedAt: Date.now(),
      budgetId: secondBudgetId,
    });

    const actuals = await s.as.query(api.finances.eventActuals, { eventId });
    // BOTH budgets' spend counts — the old `.first()` would have undercounted
    // by only summing whichever budget the index scan returned first.
    expect(actuals.totalCents).toBe(7000);
    expect(actuals.transactions.map((tr) => tr.id).sort()).toEqual([txn1, txn2].sort());
  });
});

// ── dashboardChapter's "recent transactions" card is budget-first too ───────

describe("dashboardChapter recentTransactions.codedTo is budget-first", () => {
  test("resolves the event's own name via the txn's budget, not a legacy eventId FK", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    const eventId = await seedEvent(s, s.chapterId, { name: "Fall Retreat Worship" });
    const budgetId = await s.as.mutation(api.finances.createBudget, {
      amountCents: 40000,
      type: "one_time",
      refKind: "event",
      cadence: "per_instance",
      year: 2026,
      scopeRefId: eventId,
    });
    const txnId = await s.as.mutation(api.finances.createManualTransaction, {
      flow: "outflow",
      amountCents: 4000,
      postedAt: Date.now(),
      budgetId,
    });

    const dash = await s.as.query(api.finances.dashboardChapter, {});
    const card = dash.recentTransactions.find((r) => r.id === txnId);
    expect(card?.codedTo?.projectOrEvent).toBe("Fall Retreat Worship");
  });

  test("falls back to the budget's own display name for a recurring-budget-coded txn", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    const budgetId = await s.as.mutation(api.finances.createBudget, {
      amountCents: 100000,
      type: "recurring",
      cadence: "monthly",
      year: 2026,
      month: new Date().getUTCMonth() + 1,
      label: "Ops",
    });
    const txnId = await s.as.mutation(api.finances.createManualTransaction, {
      flow: "outflow",
      amountCents: 2000,
      postedAt: Date.now(),
      budgetId,
    });

    const dash = await s.as.query(api.finances.dashboardChapter, {});
    const card = dash.recentTransactions.find((r) => r.id === txnId);
    expect(card?.codedTo?.projectOrEvent).toBe("Ops");
  });
});
