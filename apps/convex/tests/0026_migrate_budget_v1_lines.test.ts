/**
 * Test suite for migration 0026: drain Budget v1 (`budgetLineItems`, the
 * legacy per-event line-item budget) onto the v2 finance plan (`budgetLines`)
 * so `schema/budget.ts` can be removed — see the migration's own doc comment
 * for the full mapping rules (category-name best-effort match, $0 lines
 * skipped, actuals/receipts counted-not-migrated, training-event rows
 * DROPPED — never migrated, but always deleted so the table always ends up
 * fully empty, satisfying the same-PR schema-drop precondition).
 *
 * `budgetLineItems` is undeclared in THIS branch's schema (deleted alongside
 * `schema/budget.ts` in the same PR) — seeded here via `(ctx.db as any)`,
 * mirroring the migration's own `guestAllowlist`-precedent read.
 */
import { describe, expect, test } from "vitest";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import type { Id } from "../_generated/dataModel";
import { runMigrateBudgetV1Lines } from "../migrations/0026_migrate_budget_v1_lines";

async function seedEvent(
  s: ChapterSetup,
  opts: { name?: string; isTraining?: boolean } = {},
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
      eventDate: Date.now(),
      status: "planning",
      isTraining: opts.isTraining,
      createdBy: s.userId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
}

async function seedFund(s: ChapterSetup): Promise<Id<"funds">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("funds", {
      chapterId: s.chapterId,
      name: "General Fund",
      restriction: "unrestricted",
      sortOrder: 0,
      isActive: true,
      createdAt: Date.now(),
    }),
  );
}

async function seedCategory(
  s: ChapterSetup,
  fundId: Id<"funds">,
  name: string,
): Promise<Id<"budgetCategories">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("budgetCategories", {
      chapterId: s.chapterId,
      fundId,
      name,
      kind: "lineItem",
      isActive: true,
      createdAt: Date.now(),
    }),
  );
}

/** Seed a raw v1 `budgetLineItems` row — the table this migration drains. */
async function seedV1Line(
  s: ChapterSetup,
  eventId: Id<"events">,
  opts: {
    label?: string;
    category?: string;
    plannedCents?: number;
    actualCents?: number;
    receiptStorageId?: Id<"_storage">;
    order?: number;
  } = {},
): Promise<string> {
  return await run(s.t, (ctx) =>
    (ctx.db as any).insert("budgetLineItems", {
      eventId,
      chapterId: s.chapterId,
      label: opts.label ?? "PA rental",
      category: opts.category ?? "production",
      plannedCents: opts.plannedCents ?? 20000,
      actualCents: opts.actualCents,
      receiptStorageId: opts.receiptStorageId,
      order: opts.order ?? 0,
      createdBy: s.userId,
      createdAt: Date.now(),
    }),
  );
}

async function countV1Lines(t: ReturnType<typeof newT>): Promise<number> {
  const rows = await run(
    t,
    (ctx) => (ctx.db as any).query("budgetLineItems").collect() as Promise<unknown[]>,
  );
  return rows.length;
}

async function budgetLinesForEvent(s: ChapterSetup, eventId: Id<"events">) {
  return run(s.t, async (ctx) => {
    const budget = await ctx.db
      .query("budgets")
      .withIndex("by_ref", (q) => q.eq("refKind", "event").eq("scopeRefId", eventId))
      .first();
    if (!budget) return { budget: null, lines: [] };
    const lines = await ctx.db
      .query("budgetLines")
      .withIndex("by_budget", (q) => q.eq("budgetId", budget._id))
      .collect();
    return { budget, lines: lines.sort((a, b) => a.sortOrder - b.sortOrder) };
  });
}

describe("0026_migrate_budget_v1_lines", () => {
  test("migrates a v1 line onto a summoned v2 budget, matching its category by name", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const fundId = await seedFund(s);
    await seedCategory(s, fundId, "Production");
    const eventId = await seedEvent(s, { name: "Worship Night" });
    await seedV1Line(s, eventId, { label: "PA rental", category: "production", plannedCents: 20000 });

    const result = await run(t, (ctx) => runMigrateBudgetV1Lines(ctx));
    expect(result).toMatchObject({
      events: 1,
      linesMigrated: 1,
      actualsSkipped: 0,
      receiptsSkipped: 0,
      zeroPlannedSkipped: 0,
      trainingEventsSkipped: 0,
      trainingRowsDropped: 0,
      budgetLineItemsDeleted: 1,
    });

    const { budget, lines } = await budgetLinesForEvent(s, eventId);
    expect(budget).not.toBeNull();
    expect(lines).toHaveLength(1);
    expect(lines[0].description).toBe("PA rental");
    expect(lines[0].plannedCents).toBe(20000);
    expect(lines[0].sortOrder).toBe(0);
    // Matched "Production" by case-insensitive name.
    const category = await run(s.t, (ctx) => ctx.db.get(lines[0].categoryId!));
    expect(category?.name).toBe("Production");

    // Drained: nothing left in the legacy table.
    expect(await countV1Lines(t)).toBe(0);
  });

  test("no matching chapter category → categoryId left uncategorized (never fabricates a new category)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s, { name: "Worship Night" });
    // No "Production" category exists in this chapter.
    await seedV1Line(s, eventId, { category: "production" });

    await run(t, (ctx) => runMigrateBudgetV1Lines(ctx));

    const { lines } = await budgetLinesForEvent(s, eventId);
    expect(lines).toHaveLength(1);
    expect(lines[0].categoryId).toBeUndefined();
  });

  test("v1 \"other\" category always lands uncategorized, even if a chapter has a category literally named \"Other\"", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const fundId = await seedFund(s);
    await seedCategory(s, fundId, "Other");
    const eventId = await seedEvent(s);
    await seedV1Line(s, eventId, { category: "other" });

    await run(t, (ctx) => runMigrateBudgetV1Lines(ctx));

    const { lines } = await budgetLinesForEvent(s, eventId);
    expect(lines[0].categoryId).toBeUndefined();
  });

  test("a $0 planned v1 line is SKIPPED (v2 plannedCents must be positive), not inserted as a rule-violating 0", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    await seedV1Line(s, eventId, { label: "Freebie", plannedCents: 0 });

    const result = await run(t, (ctx) => runMigrateBudgetV1Lines(ctx));
    expect(result.linesMigrated).toBe(0);
    expect(result.zeroPlannedSkipped).toBe(1);
    expect(result.budgetLineItemsDeleted).toBe(1); // still drained

    const { lines } = await budgetLinesForEvent(s, eventId);
    expect(lines).toHaveLength(0);
  });

  test("actuals + receipts are counted but NOT migrated — nothing silently vanishes", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    // A fake storage id — never dereferenced by the migration (it only checks
    // presence to count `receiptsSkipped`, never resolves a URL from it).
    const storageId = "kg2fake000000000000000000" as Id<"_storage">;
    await seedV1Line(s, eventId, {
      plannedCents: 15000,
      actualCents: 14500,
      receiptStorageId: storageId,
    });

    const result = await run(t, (ctx) => runMigrateBudgetV1Lines(ctx));
    expect(result.linesMigrated).toBe(1); // the plan line itself DOES migrate
    expect(result.actualsSkipped).toBe(1);
    expect(result.receiptsSkipped).toBe(1);
  });

  test("preserves v1 `order` as v2 `sortOrder`, ordered ascending", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    await seedV1Line(s, eventId, { label: "Second", plannedCents: 1000, order: 1 });
    await seedV1Line(s, eventId, { label: "First", plannedCents: 500, order: 0 });

    await run(t, (ctx) => runMigrateBudgetV1Lines(ctx));

    const { lines } = await budgetLinesForEvent(s, eventId);
    expect(lines.map((l) => l.description)).toEqual(["First", "Second"]);
    expect(lines.map((l) => l.sortOrder)).toEqual([0, 1]);
  });

  test("appends after any lines already on the summoned budget, never overwriting existing sortOrder", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);

    // A budget + a real v2 line already exist for this event (e.g. someone
    // already used Finances' native planner before this migration ran).
    const budgetId = await run(s.t, (ctx) =>
      ctx.db.insert("budgets", {
        chapterId: s.chapterId,
        amountCents: 50000,
        type: "one_time",
        refKind: "event",
        scopeRefId: eventId,
        cadence: "per_instance",
        year: 2026,
        createdBy: s.userId,
        createdAt: Date.now(),
      }),
    );
    await run(s.t, (ctx) =>
      ctx.db.insert("budgetLines", {
        budgetId,
        description: "Already planned",
        plannedCents: 5000,
        sortOrder: 0,
        createdBy: s.userId,
        createdAt: Date.now(),
      }),
    );
    await seedV1Line(s, eventId, { label: "Migrated line", plannedCents: 1000 });

    await run(t, (ctx) => runMigrateBudgetV1Lines(ctx));

    const { budget, lines } = await budgetLinesForEvent(s, eventId);
    expect(budget?._id).toBe(budgetId); // reused the existing budget, not a new one
    expect(lines.map((l) => l.description)).toEqual(["Already planned", "Migrated line"]);
    expect(lines[1].sortOrder).toBe(1);
  });

  test("a training event's v1 lines are DROPPED (never migrated — never gets a v2 budget, #172 — but always deleted), counted not silently dropped", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s, { name: "Training Sandbox", isTraining: true });
    await seedV1Line(s, eventId, { label: "First", order: 0 });
    await seedV1Line(s, eventId, { label: "Second", order: 1 });

    const result = await run(t, (ctx) => runMigrateBudgetV1Lines(ctx));
    expect(result.trainingEventsSkipped).toBe(1);
    expect(result.trainingRowsDropped).toBe(2);
    expect(result.events).toBe(0);
    expect(result.linesMigrated).toBe(0);
    // Opus review (PR #214): training rows are now ALWAYS deleted too, so the
    // table always ends up fully drained — the same-PR schema drop's
    // "table must be empty" precondition holds on every deployment, not just
    // ones with zero training-event v1 rows.
    expect(result.budgetLineItemsDeleted).toBe(2);

    const { budget } = await budgetLinesForEvent(s, eventId);
    expect(budget).toBeNull(); // #172 invariant never violated — no budget summoned
    expect(await countV1Lines(t)).toBe(0); // drained, not left in place
  });

  test("an orphaned line (event since deleted) is drained with no budget summoned", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    await seedV1Line(s, eventId);
    await run(s.t, (ctx) => ctx.db.delete(eventId));

    const result = await run(t, (ctx) => runMigrateBudgetV1Lines(ctx));
    expect(result.events).toBe(0);
    expect(result.linesMigrated).toBe(0);
    expect(result.budgetLineItemsDeleted).toBe(1);
    expect(await countV1Lines(t)).toBe(0);
  });

  test("multiple events each get their own migrated lines, independently ordered", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventA = await seedEvent(s, { name: "Event A" });
    const eventB = await seedEvent(s, { name: "Event B" });
    await seedV1Line(s, eventA, { label: "A1", plannedCents: 1000 });
    await seedV1Line(s, eventB, { label: "B1", plannedCents: 2000 });
    await seedV1Line(s, eventB, { label: "B2", plannedCents: 3000, order: 1 });

    const result = await run(t, (ctx) => runMigrateBudgetV1Lines(ctx));
    expect(result.events).toBe(2);
    expect(result.linesMigrated).toBe(3);

    const a = await budgetLinesForEvent(s, eventA);
    const b = await budgetLinesForEvent(s, eventB);
    expect(a.lines.map((l) => l.description)).toEqual(["A1"]);
    expect(b.lines.map((l) => l.description)).toEqual(["B1", "B2"]);
  });

  test("idempotent: a second run finds nothing left to migrate", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    await seedV1Line(s, eventId, { plannedCents: 5000 });

    await run(t, (ctx) => runMigrateBudgetV1Lines(ctx));
    const second = await run(t, (ctx) => runMigrateBudgetV1Lines(ctx));
    expect(second).toEqual({
      events: 0,
      linesMigrated: 0,
      actualsSkipped: 0,
      receiptsSkipped: 0,
      zeroPlannedSkipped: 0,
      trainingEventsSkipped: 0,
      trainingRowsDropped: 0,
      budgetLineItemsDeleted: 0,
    });

    const { lines } = await budgetLinesForEvent(s, eventId);
    expect(lines).toHaveLength(1); // unchanged, not duplicated
  });

  test("a clean DB (nothing to migrate) is a true no-op", async () => {
    const t = newT();
    const result = await run(t, (ctx) => runMigrateBudgetV1Lines(ctx));
    expect(result).toEqual({
      events: 0,
      linesMigrated: 0,
      actualsSkipped: 0,
      receiptsSkipped: 0,
      zeroPlannedSkipped: 0,
      trainingEventsSkipped: 0,
      trainingRowsDropped: 0,
      budgetLineItemsDeleted: 0,
    });
  });

  test("idempotent: a second run after a training event's rows were already dropped finds nothing left (table stays empty)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s, { name: "Training Sandbox", isTraining: true });
    await seedV1Line(s, eventId);

    await run(t, (ctx) => runMigrateBudgetV1Lines(ctx));
    expect(await countV1Lines(t)).toBe(0);

    const second = await run(t, (ctx) => runMigrateBudgetV1Lines(ctx));
    expect(second.trainingEventsSkipped).toBe(0); // no rows left to find
    expect(second.trainingRowsDropped).toBe(0);
    expect(second.budgetLineItemsDeleted).toBe(0);
  });
});
