/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

/**
 * Central (org-level) budgets + explicit budget attribution (PR 2).
 *
 * Covers: central-budget create is gated on central access (a chapter manager is
 * rejected) and stores `chapterId:"central"`; `listBudgets` tags every row's
 * `level`; categorize accepts a central budgetId from a chapter txn but rejects
 * another chapter's budget; an explicit `budgetId` makes a txn count toward THAT
 * budget only while unlinked txns keep deriving; and `dashboardCentral` rolls a
 * central budget's actuals up across chapters without polluting per-chapter
 * allocations.
 *
 * A superuser (`seyi@publicworship.life`) is an implicit CENTRAL manager; a plain
 * chapter caller with a `manager` grant is chapter-only.
 */

function tsInMonth(year: number, month: number): number {
  return Date.UTC(year, month - 1, 15, 17, 0, 0);
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

/** A chapter-only manager (person + manager grant, scope chapter). */
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

describe("central budgets: create gating + storage", () => {
  test("createBudget central:true is rejected for a chapter-only manager", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    await expect(
      s.as.mutation(api.finances.createBudget, {
        amountCents: 100000,
        type: "recurring",
        cadence: "yearly",
        year: 2026,
        central: true,
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("a central user creates a central budget stored as chapterId:'central'", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: "seyi@publicworship.life" });
    const budgetId = await s.as.mutation(api.finances.createBudget, {
      amountCents: 500000,
      type: "recurring",
      cadence: "yearly",
      year: 2026,
      central: true,
      label: "Org Marketing",
    });
    const doc = await run(s.t, (ctx) => ctx.db.get(budgetId));
    expect(doc?.chapterId).toBe("central");
  });
});

describe("listBudgets: chapter + central, level-tagged", () => {
  test("returns both the caller's chapter budgets and central budgets, each tagged", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: "seyi@publicworship.life" });
    const chapterBudget = await s.as.mutation(api.finances.createBudget, {
      amountCents: 100000,
      type: "recurring",
      cadence: "yearly",
      year: 2026,
      label: "NY Ops",
    });
    const centralBudget = await s.as.mutation(api.finances.createBudget, {
      amountCents: 500000,
      type: "recurring",
      cadence: "yearly",
      year: 2026,
      central: true,
      label: "Org",
    });
    const budgets = await s.as.query(api.finances.listBudgets, {});
    expect(budgets.find((b) => b.id === chapterBudget)?.level).toBe("chapter");
    expect(budgets.find((b) => b.id === centralBudget)?.level).toBe("central");
  });
});

describe("categorize: budget attribution tenancy", () => {
  test("accepts a central budgetId from a chapter txn; null clears; another chapter's is rejected", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: "seyi@publicworship.life" });
    const centralBudget = await s.as.mutation(api.finances.createBudget, {
      amountCents: 500000,
      type: "recurring",
      cadence: "yearly",
      year: 2026,
      central: true,
    });
    const txnId = await s.as.mutation(api.finances.createManualTransaction, {
      flow: "outflow",
      amountCents: 5000,
      postedAt: Date.now(),
    });

    // A chapter txn may point at a central budget.
    await s.as.mutation(api.finances.categorizeTransaction, {
      transactionId: txnId,
      budgetId: centralBudget,
    });
    expect(
      (await run(s.t, (ctx) => ctx.db.get(txnId)))?.budgetId,
    ).toBe(centralBudget);

    // `null` clears the attribution.
    await s.as.mutation(api.finances.categorizeTransaction, {
      transactionId: txnId,
      budgetId: null,
    });
    expect(
      (await run(s.t, (ctx) => ctx.db.get(txnId)))?.budgetId,
    ).toBeUndefined();

    // Another chapter's budget is out of tenancy → rejected.
    const foreignBudget = await run(t, async (ctx) => {
      const other = await ctx.db.insert("chapters", {
        name: "Boston",
        isActive: true,
        createdAt: Date.now(),
      });
      return ctx.db.insert("budgets", {
        chapterId: other,
        amountCents: 1000,
        scope: "chapter",
        cadence: "yearly",
        year: 2026,
        createdAt: Date.now(),
      });
    });
    await expect(
      s.as.mutation(api.finances.categorizeTransaction, {
        transactionId: txnId,
        budgetId: foreignBudget,
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });
});

describe("budget attribution: explicit link wins, unlinked still derives", () => {
  test("an explicit budgetId counts toward that budget only; unlinked txns derive-match both", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    const year = 2026;
    const month = 3;

    const fundId = await s.as.mutation(api.finances.createFund, {
      name: "General",
      restriction: "unrestricted",
    });
    const categoryId = await s.as.mutation(api.finances.createCategory, {
      fundId,
      name: "Food",
      kind: "lineItem",
    });
    // Two budgets that BOTH derive-match a Food/March spend.
    const budgetA = await s.as.mutation(api.finances.createBudget, {
      amountCents: 100000,
      type: "recurring",
      cadence: "monthly",
      year,
      month,
      fundId,
      categoryId,
      label: "A",
    });
    const budgetB = await s.as.mutation(api.finances.createBudget, {
      amountCents: 100000,
      type: "recurring",
      cadence: "monthly",
      year,
      month,
      fundId,
      categoryId,
      label: "B",
    });

    // txn1 ($100): explicitly linked to A.
    const txn1 = await s.as.mutation(api.finances.createManualTransaction, {
      flow: "outflow",
      amountCents: 10000,
      postedAt: tsInMonth(year, month),
      fundId,
      categoryId,
    });
    await s.as.mutation(api.finances.categorizeTransaction, {
      transactionId: txn1,
      budgetId: budgetA,
    });
    // txn2 ($50): unlinked → derive-matches both A and B.
    await s.as.mutation(api.finances.createManualTransaction, {
      flow: "outflow",
      amountCents: 5000,
      postedAt: tsInMonth(year, month),
      fundId,
      categoryId,
    });

    const rows = await s.as.query(api.finances.budgetVsActual, { year, month });
    // A: linked $100 + derived $50; B: only the unlinked $50 (never the linked one).
    expect(rows.find((r) => r.budgetId === budgetA)?.actualCents).toBe(15000);
    expect(rows.find((r) => r.budgetId === budgetB)?.actualCents).toBe(5000);
  });
});

describe("budget attribution: an explicit link still buckets by the budget's period", () => {
  test("a txn linked to a MONTHLY budget counts in its posted month, not another month", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    const year = 2026;

    // A recurring "$1,000/mo" budget carries no stored `month`, so its period is
    // the dashboard's queried month (`budgetEffectivePeriod`).
    const monthly = await s.as.mutation(api.finances.createBudget, {
      amountCents: 100000,
      type: "recurring",
      cadence: "monthly",
      year,
      label: "Monthly",
    });

    // $80 posted in MARCH, explicitly linked to the monthly budget.
    const txn = await s.as.mutation(api.finances.createManualTransaction, {
      flow: "outflow",
      amountCents: 8000,
      postedAt: tsInMonth(year, 3),
    });
    await s.as.mutation(api.finances.categorizeTransaction, {
      transactionId: txn,
      budgetId: monthly,
    });

    // March: the linked txn lands in the budget's March window → counts.
    const march = await s.as.query(api.finances.budgetVsActual, { year, month: 3 });
    expect(march.find((r) => r.budgetId === monthly)?.actualCents).toBe(8000);

    // April: the same budget's window is April, where the txn does NOT fall →
    // the explicit link must not drag March spend into April.
    const april = await s.as.query(api.finances.budgetVsActual, { year, month: 4 });
    expect(april.find((r) => r.budgetId === monthly)?.actualCents).toBe(0);
  });
});

describe("dashboardCentral: central budgets roll up org-wide", () => {
  test("sums a central budget's actuals across chapters; per-chapter allocation excludes it", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: "seyi@publicworship.life" });
    const year = 2026;
    const month = 5;
    const when = tsInMonth(year, month);

    const centralBudget = await s.as.mutation(api.finances.createBudget, {
      amountCents: 500000,
      type: "recurring",
      cadence: "yearly",
      year,
      central: true,
      label: "Org Ads",
    });

    // NY: a $70 spend linked to the central budget.
    await run(t, (ctx) =>
      ctx.db.insert("transactions", {
        chapterId: s.chapterId,
        source: "manual",
        flow: "outflow",
        amountCents: 7000,
        postedAt: when,
        budgetId: centralBudget,
        status: "categorized",
        createdAt: Date.now(),
      }),
    );
    // Boston: a $30 spend linked to the SAME central budget.
    await run(t, async (ctx) => {
      const boston = await ctx.db.insert("chapters", {
        name: "Boston",
        isActive: true,
        createdAt: Date.now(),
      });
      await ctx.db.insert("transactions", {
        chapterId: boston,
        source: "manual",
        flow: "outflow",
        amountCents: 3000,
        postedAt: when,
        budgetId: centralBudget,
        status: "categorized",
        createdAt: Date.now(),
      });
    });

    const dash = await s.as.query(api.finances.dashboardCentral, { year, month });
    const cb = dash.centralBudgets.find((b) => b.id === centralBudget);
    expect(cb?.spentCents).toBe(10000); // 7000 + 3000, org-wide
    expect(cb?.budgetCents).toBe(500000);

    // NY has no chapter budget of its own, so its allocation must be 0 — the
    // central budget never leaks into a per-chapter rollup.
    const ny = dash.chapterRollup.find((c) => c.chapterName === "New York");
    expect(ny?.budgetCents).toBe(0);
    expect(ny?.spentCents).toBe(7000);
  });
});

// ── Budgets v2: types + multi-tag ────────────────────────────────────────────

/** Seed an eventType + event in a chapter; returns their ids + the type name. */
async function seedEvent(
  s: ChapterSetup,
  chapterId: Id<"chapters">,
  opts: { name?: string; typeName?: string; eventDate?: number } = {},
): Promise<{ eventId: Id<"events">; eventTypeId: Id<"eventTypes">; typeName: string }> {
  const typeName = opts.typeName ?? "Worship with Strangers";
  return await run(s.t, async (ctx) => {
    const eventTypeId = await ctx.db.insert("eventTypes", {
      chapterId,
      name: typeName,
      slug: "wws",
      version: 1,
      createdBy: s.userId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const eventId = await ctx.db.insert("events", {
      chapterId,
      eventTypeId,
      templateVersion: 1,
      name: opts.name ?? "May Worship",
      eventDate: opts.eventDate ?? tsInMonth(2026, 5),
      status: "planning",
      createdBy: s.userId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    return { eventId, eventTypeId, typeName };
  });
}

describe("budgets v2: create by type + auto-tag", () => {
  test("a one_time EVENT budget auto-tags the template tag + an events tag", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    const { eventId, typeName } = await seedEvent(s, s.chapterId);

    const budgetId = await s.as.mutation(api.finances.createBudget, {
      amountCents: 40000,
      type: "one_time",
      refKind: "event",
      cadence: "per_instance",
      year: 2026,
      scopeRefId: eventId,
    });

    const budgets = await s.as.query(api.finances.listBudgets, {});
    const row = budgets.find((b) => b.id === budgetId);
    expect(row?.type).toBe("one_time");
    expect(row?.refKind).toBe("event");
    const kinds = (row?.tags ?? []).map((tg) => tg.kind).sort();
    expect(kinds).toEqual(["events", "template"]);
    const templateTag = row?.tags.find((tg) => tg.kind === "template");
    expect(templateTag?.name).toBe(typeName);
  });

  test("a recurring budget carries no instance ref and no auto-tags", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    const budgetId = await s.as.mutation(api.finances.createBudget, {
      amountCents: 200000,
      type: "recurring",
      cadence: "monthly",
      year: 2026,
      label: "Ops",
    });
    const budgets = await s.as.query(api.finances.listBudgets, {});
    const row = budgets.find((b) => b.id === budgetId);
    expect(row?.type).toBe("recurring");
    expect(row?.refKind).toBeNull();
    expect(row?.scopeRefId).toBeNull();
    expect(row?.tags).toEqual([]);
  });
});

describe("budgets v2: multi-tag rollups", () => {
  test("a budget with two tags appears in both tag rollups; each sums its linked-txn actuals", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    const year = 2026;
    const month = 3;

    // Two custom tags at the chapter level.
    const tagX = await s.as.mutation(api.finances.createBudgetTag, {
      name: "Marketing",
      kind: "custom",
    });
    const tagY = await s.as.mutation(api.finances.createBudgetTag, {
      name: "Q1",
      kind: "custom",
    });

    // One recurring budget carrying BOTH tags.
    const budgetId = await s.as.mutation(api.finances.createBudget, {
      amountCents: 100000,
      type: "recurring",
      cadence: "monthly",
      year,
      month,
      tagIds: [tagX, tagY],
    });

    // $60 spend explicitly linked to the budget.
    const txnId = await s.as.mutation(api.finances.createManualTransaction, {
      flow: "outflow",
      amountCents: 6000,
      postedAt: tsInMonth(year, month),
    });
    await s.as.mutation(api.finances.categorizeTransaction, {
      transactionId: txnId,
      budgetId,
    });

    const dash = await s.as.query(api.finances.dashboardChapter, { year, month });
    const rollX = dash.tagRollups.find((r) => r.tagId === tagX);
    const rollY = dash.tagRollups.find((r) => r.tagId === tagY);
    expect(rollX?.spentCents).toBe(6000);
    expect(rollY?.spentCents).toBe(6000);
    expect(rollX?.budgetCents).toBe(100000);
    expect(rollY?.budgetCents).toBe(100000);
  });
});

describe("budgets v2: tag CRUD gating + delete-in-use", () => {
  test("a central tag needs central reach; a chapter manager is rejected", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    // Chapter tag: fine.
    await s.as.mutation(api.finances.createBudgetTag, { name: "Ops", kind: "custom" });
    // Central tag: rejected for a chapter-only manager.
    await expect(
      s.as.mutation(api.finances.createBudgetTag, {
        name: "Org",
        kind: "custom",
        central: true,
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("deleting a tag still carried by a budget is blocked", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    const tagId = await s.as.mutation(api.finances.createBudgetTag, {
      name: "InUse",
      kind: "custom",
    });
    await s.as.mutation(api.finances.createBudget, {
      amountCents: 1000,
      type: "recurring",
      cadence: "yearly",
      year: 2026,
      tagIds: [tagId],
    });
    await expect(
      s.as.mutation(api.finances.deleteBudgetTag, { tagId }),
    ).rejects.toBeInstanceOf(ConvexError);
  });
});

describe("budgets v2: matchesBudget by type", () => {
  test("a one_time event budget matches only its event's spend; a recurring matches by period", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    const year = 2026;
    const month = 4;
    const { eventId } = await seedEvent(s, s.chapterId, {
      eventDate: tsInMonth(year, month),
    });

    const oneTime = await s.as.mutation(api.finances.createBudget, {
      amountCents: 50000,
      type: "one_time",
      refKind: "event",
      cadence: "per_instance",
      year,
      scopeRefId: eventId,
    });
    const recurring = await s.as.mutation(api.finances.createBudget, {
      amountCents: 50000,
      type: "recurring",
      cadence: "monthly",
      year,
      month,
      label: "Ops",
    });

    // $80 ON the event, and $20 with no event.
    await s.as.mutation(api.finances.createManualTransaction, {
      flow: "outflow",
      amountCents: 8000,
      postedAt: tsInMonth(year, month),
      eventId,
    });
    await s.as.mutation(api.finances.createManualTransaction, {
      flow: "outflow",
      amountCents: 2000,
      postedAt: tsInMonth(year, month),
    });

    const rows = await s.as.query(api.finances.budgetVsActual, { year, month });
    // one_time: only the $80 on its event (never the $20 unattached spend).
    expect(rows.find((r) => r.budgetId === oneTime)?.actualCents).toBe(8000);
    // recurring: both period spends ($80 + $20) — no instance filter.
    expect(rows.find((r) => r.budgetId === recurring)?.actualCents).toBe(10000);
  });
});

describe("budgets v2: scope→type migration", () => {
  test("team→recurring+team tag, event→one_time+refKind+tags, and it re-runs idempotently", async () => {
    const t = newT();
    // Superuser gates the migration wrapper.
    const s = await setupChapter(t, { email: "seyi@publicworship.life" });
    const { eventId, eventTypeId, typeName } = await seedEvent(s, s.chapterId);

    // A legacy TEAM budget + a legacy EVENT budget (raw inserts, `scope`, no `type`).
    const { teamBudget, eventBudget, teamId } = await run(t, async (ctx) => {
      const teamId = await ctx.db.insert("financeTeams", {
        chapterId: s.chapterId,
        name: "Development",
        sortOrder: 0,
        createdAt: Date.now(),
      });
      const teamBudget = await ctx.db.insert("budgets", {
        chapterId: s.chapterId,
        amountCents: 200000,
        scope: "team",
        teamId,
        cadence: "monthly",
        year: 2026,
        createdAt: Date.now(),
      });
      const eventBudget = await ctx.db.insert("budgets", {
        chapterId: s.chapterId,
        amountCents: 40000,
        scope: "event",
        scopeRefId: eventId,
        cadence: "per_instance",
        year: 2026,
        createdAt: Date.now(),
      });
      return { teamBudget, eventBudget, teamId };
    });

    const first = await s.as.mutation(api.finances.migrateBudgetScopesToTypes, {});
    expect(first.migrated).toBe(2);
    expect(first.skipped).toBe(0);

    const budgets = await s.as.query(api.finances.listBudgets, {});
    const team = budgets.find((b) => b.id === teamBudget);
    expect(team?.type).toBe("recurring");
    const teamTag = team?.tags.find((tg) => tg.kind === "team");
    expect(teamTag?.name).toBe("Development");

    const ev = budgets.find((b) => b.id === eventBudget);
    expect(ev?.type).toBe("one_time");
    expect(ev?.refKind).toBe("event");
    const evKinds = (ev?.tags ?? []).map((tg) => tg.kind).sort();
    expect(evKinds).toEqual(["events", "template"]);
    expect(ev?.tags.find((tg) => tg.kind === "template")?.name).toBe(typeName);

    // Idempotent re-run: both rows already have `type` → skipped, no new tags.
    const evTagCountBefore = ev?.tags.length ?? 0;
    const second = await s.as.mutation(api.finances.migrateBudgetScopesToTypes, {});
    expect(second.migrated).toBe(0);
    expect(second.skipped).toBe(2);
    const budgets2 = await s.as.query(api.finances.listBudgets, {});
    expect(budgets2.find((b) => b.id === eventBudget)?.tags.length).toBe(
      evTagCountBefore,
    );
    // The template tag deduped against the eventType (`by_chapter_and_ref`).
    void eventTypeId;
    void teamId;
  });
});
