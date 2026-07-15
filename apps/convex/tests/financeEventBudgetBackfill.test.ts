/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

/**
 * `backfillEventBudgets` (internal, no-auth): create a one_time budget for every
 * existing event so the finance dashboard's "Events & Projects" section
 * populates and charges roll up per event. Bounded + idempotent.
 */

function tsInMonth(year: number, month: number): number {
  return Date.UTC(year, month - 1, 15, 17, 0, 0);
}

/** Seed an eventType + event; returns ids + the type name. */
async function seedEvent(
  s: ChapterSetup,
  opts: {
    name?: string;
    typeName?: string;
    eventDate?: number;
    budget?: number;
    isTraining?: boolean;
  } = {},
): Promise<{ eventId: Id<"events">; eventTypeId: Id<"eventTypes">; typeName: string }> {
  const typeName = opts.typeName ?? "Worship with Strangers";
  return await run(s.t, async (ctx) => {
    const eventTypeId = await ctx.db.insert("eventTypes", {
      chapterId: s.chapterId,
      name: typeName,
      slug: "wws",
      version: 1,
      createdBy: s.userId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const eventId = await ctx.db.insert("events", {
      chapterId: s.chapterId,
      eventTypeId,
      templateVersion: 1,
      name: opts.name ?? "May Worship",
      eventDate: opts.eventDate ?? tsInMonth(2026, 5),
      budget: opts.budget,
      isTraining: opts.isTraining,
      status: "planning",
      createdBy: s.userId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    return { eventId, eventTypeId, typeName };
  });
}

/** The event budgets that exist for a chapter, with their linked tag kinds. */
async function eventBudgetsFor(s: ChapterSetup, eventId: Id<"events">) {
  return await run(s.t, async (ctx) => {
    const rows = (
      await ctx.db
        .query("budgets")
        .withIndex("by_chapter", (q) => q.eq("chapterId", s.chapterId))
        .collect()
    ).filter((b) => b.scopeRefId === eventId);
    const withTags = [];
    for (const b of rows) {
      const links = await ctx.db
        .query("budgetTagLinks")
        .withIndex("by_budget", (q) => q.eq("budgetId", b._id))
        .collect();
      const kinds: string[] = [];
      for (const l of links) {
        const tag = await ctx.db.get(l.tagId);
        if (tag) kinds.push(tag.kind ?? "");
      }
      withTags.push({ budget: b, tagKinds: kinds.sort() });
    }
    return withTags;
  });
}

describe("backfillEventBudgets (internal)", () => {
  test("creates a one_time event budget with the right refs, dating, and tags", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const { eventId, typeName } = await seedEvent(s, {
      eventDate: tsInMonth(2026, 5),
      budget: 400, // dollars
    });

    const result = await t.mutation(internal.finances.backfillEventBudgets, {});
    expect(result.created).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.tagsLinked).toBe(2); // template + events

    const [row] = await eventBudgetsFor(s, eventId);
    expect(row.budget.type).toBe("one_time");
    expect(row.budget.refKind).toBe("event");
    expect(row.budget.scopeRefId).toBe(eventId);
    expect(row.budget.cadence).toBe("per_instance");
    expect(row.budget.chapterId).toBe(s.chapterId);
    // budget × 100 → integer cents; year/month from eventDate (Eastern).
    expect(row.budget.amountCents).toBe(40000);
    expect(Number.isInteger(row.budget.amountCents)).toBe(true);
    expect(row.budget.year).toBe(2026);
    expect(row.budget.month).toBe(5);
    // Auto-tagged with the eventType template tag + the "events" tag.
    expect(row.tagKinds).toEqual(["events", "template"]);

    const templateTag = await run(s.t, async (ctx) => {
      const links = await ctx.db
        .query("budgetTagLinks")
        .withIndex("by_budget", (q) => q.eq("budgetId", row.budget._id))
        .collect();
      for (const l of links) {
        const tag = await ctx.db.get(l.tagId);
        if (tag?.kind === "template") return tag;
      }
      return null;
    });
    expect(templateTag?.name).toBe(typeName);
  });

  test("uses amountCents 0 when the event carries no budget", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const { eventId } = await seedEvent(s, { budget: undefined });

    const result = await t.mutation(internal.finances.backfillEventBudgets, {});
    expect(result.created).toBe(1);

    const [row] = await eventBudgetsFor(s, eventId);
    expect(row.budget.amountCents).toBe(0);
  });

  test("is idempotent — a second run creates nothing and skips the event", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedEvent(s, { budget: 100 });

    const first = await t.mutation(internal.finances.backfillEventBudgets, {});
    expect(first.created).toBe(1);
    expect(first.skipped).toBe(0);

    const second = await t.mutation(internal.finances.backfillEventBudgets, {});
    expect(second.created).toBe(0);
    expect(second.skipped).toBe(1);
    expect(second.tagsLinked).toBe(0);

    // Exactly one budget for the event — no duplicate.
    const rows = await run(s.t, (ctx) =>
      ctx.db
        .query("budgets")
        .withIndex("by_chapter", (q) => q.eq("chapterId", s.chapterId))
        .collect(),
    );
    expect(rows.length).toBe(1);
  });

  test("skips an event that already has a budget (created via createBudget)", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: "seyi@publicworship.life" });
    const { eventId } = await seedEvent(s, { budget: 250 });

    // A pre-existing budget attached to the event.
    await s.as.mutation(api.finances.createBudget, {
      amountCents: 25000,
      type: "one_time",
      refKind: "event",
      cadence: "per_instance",
      year: 2026,
      scopeRefId: eventId,
    });

    const result = await t.mutation(internal.finances.backfillEventBudgets, {});
    expect(result.created).toBe(0);
    expect(result.skipped).toBe(1);

    const rows = await run(s.t, (ctx) =>
      ctx.db
        .query("budgets")
        .withIndex("by_chapter", (q) => q.eq("chapterId", s.chapterId))
        .collect(),
    );
    expect(rows.filter((b) => b.scopeRefId === eventId).length).toBe(1);
  });

  test("skips training events (never pollute finance rollups)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const { eventId: realId } = await seedEvent(s, { budget: 100 });
    const { eventId: trainingId } = await seedEvent(s, {
      name: "Academy Practice",
      isTraining: true,
      budget: 999,
    });

    const result = await t.mutation(internal.finances.backfillEventBudgets, {});
    expect(result.created).toBe(1);
    expect(result.skipped).toBe(1);

    expect((await eventBudgetsFor(s, realId)).length).toBe(1);
    expect((await eventBudgetsFor(s, trainingId)).length).toBe(0);
  });

  test("scopes to a single chapter when chapterId is passed", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const { eventId } = await seedEvent(s, { budget: 100 });

    const result = await t.mutation(internal.finances.backfillEventBudgets, {
      chapterId: s.chapterId,
    });
    expect(result.created).toBe(1);
    expect((await eventBudgetsFor(s, eventId)).length).toBe(1);
  });
});
