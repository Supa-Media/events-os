/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { instantiateEvent } from "../lib/templates";

/**
 * `backfillEventBudgets` (internal, no-auth): create a one_time budget for every
 * existing event so the finance dashboard's "Events & Projects" section
 * populates and charges roll up per event. Bounded + idempotent.
 */

function tsInMonth(year: number, month: number): number {
  return Date.UTC(year, month - 1, 15, 17, 0, 0);
}

/** A timestamp on a specific Eastern calendar day (17:00 UTC = early PM ET). */
function tsOnDay(year: number, month: number, day: number): number {
  return Date.UTC(year, month - 1, day, 17, 0, 0);
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

  test("owner rule: skips an event with no budget — no budget object at all", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const { eventId } = await seedEvent(s, { budget: undefined });

    const result = await t.mutation(internal.finances.backfillEventBudgets, {});
    expect(result.created).toBe(0);
    expect(result.skipped).toBe(1);

    expect(await eventBudgetsFor(s, eventId)).toEqual([]);
  });

  test("owner rule: skips an event with budget 0 or negative — no budget object", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const { eventId: zeroId } = await seedEvent(s, { name: "Zero Budget Event", budget: 0 });
    const { eventId: negId } = await seedEvent(s, { name: "Negative Budget Event", budget: -20 });

    const result = await t.mutation(internal.finances.backfillEventBudgets, {});
    expect(result.created).toBe(0);
    expect(result.skipped).toBe(2);

    expect(await eventBudgetsFor(s, zeroId)).toEqual([]);
    expect(await eventBudgetsFor(s, negId)).toEqual([]);
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

  test("names a created event budget after its event (unique name → bare name, not 'One-time')", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const { eventId } = await seedEvent(s, {
      name: "Summer Retreat",
      budget: 100,
    });

    const result = await t.mutation(internal.finances.backfillEventBudgets, {});
    expect(result.created).toBe(1);
    expect(result.relabeled).toBe(0);

    const [row] = await eventBudgetsFor(s, eventId);
    expect(row.budget.label).toBe("Summer Retreat");
  });

  test("same name in DIFFERENT months → each budget's label is suffixed with month + year", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const { eventId: marId } = await seedEvent(s, {
      name: "Field Day",
      eventDate: tsInMonth(2026, 3),
      budget: 100,
    });
    const { eventId: aprId } = await seedEvent(s, {
      name: "Field Day",
      eventDate: tsInMonth(2026, 4),
      budget: 100,
    });

    const result = await t.mutation(internal.finances.backfillEventBudgets, {});
    expect(result.created).toBe(2);

    const [marRow] = await eventBudgetsFor(s, marId);
    const [aprRow] = await eventBudgetsFor(s, aprId);
    expect(marRow.budget.label).toBe("Field Day · March 2026");
    expect(aprRow.budget.label).toBe("Field Day · April 2026");
  });

  test("same name in the SAME month → each budget's label is suffixed with the full date", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const { eventId: firstId } = await seedEvent(s, {
      name: "Field Day",
      eventDate: tsOnDay(2026, 3, 15),
      budget: 100,
    });
    const { eventId: secondId } = await seedEvent(s, {
      name: "Field Day",
      eventDate: tsOnDay(2026, 3, 22),
      budget: 100,
    });

    const result = await t.mutation(internal.finances.backfillEventBudgets, {});
    expect(result.created).toBe(2);

    const [firstRow] = await eventBudgetsFor(s, firstId);
    const [secondRow] = await eventBudgetsFor(s, secondId);
    expect(firstRow.budget.label).toBe("Field Day · Mar 15, 2026");
    expect(secondRow.budget.label).toBe("Field Day · Mar 22, 2026");
  });

  test("re-run relabels an existing UNLABELED event budget; a labeled one is untouched", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const { eventId: unlabeledEventId } = await seedEvent(s, {
      name: "Fall Gathering",
      budget: 100,
    });
    const { eventId: labeledEventId } = await seedEvent(s, {
      name: "Winter Gala",
      typeName: "Gala",
      budget: 200,
    });

    // Simulate the pre-fix budgets: an event budget created WITHOUT a label,
    // and one already carrying a custom label.
    const { unlabeledBudgetId, labeledBudgetId } = await run(s.t, async (ctx) => {
      const unlabeledBudgetId = await ctx.db.insert("budgets", {
        chapterId: s.chapterId,
        amountCents: 10000,
        type: "one_time",
        refKind: "event",
        scopeRefId: unlabeledEventId,
        cadence: "per_instance",
        year: 2026,
        month: 5,
        createdAt: Date.now(),
      });
      const labeledBudgetId = await ctx.db.insert("budgets", {
        chapterId: s.chapterId,
        amountCents: 20000,
        label: "Hand-picked name",
        type: "one_time",
        refKind: "event",
        scopeRefId: labeledEventId,
        cadence: "per_instance",
        year: 2026,
        month: 5,
        createdAt: Date.now(),
      });
      return { unlabeledBudgetId, labeledBudgetId };
    });

    const result = await t.mutation(internal.finances.backfillEventBudgets, {});
    // Both events already have a budget → nothing created; both skipped; only
    // the unlabeled one is relabeled.
    expect(result.created).toBe(0);
    expect(result.skipped).toBe(2);
    expect(result.relabeled).toBe(1);

    const { unlabeled, labeled } = await run(s.t, async (ctx) => ({
      unlabeled: await ctx.db.get(unlabeledBudgetId),
      labeled: await ctx.db.get(labeledBudgetId),
    }));
    expect(unlabeled?.label).toBe("Fall Gathering");
    expect(labeled?.label).toBe("Hand-picked name");

    // A settled re-run relabels nothing.
    const second = await t.mutation(internal.finances.backfillEventBudgets, {});
    expect(second.relabeled).toBe(0);
  });
});

describe("createBudget: event budgets default their label to the event name", () => {
  test("no explicit label, unique name → label defaults to the bare event name", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: "seyi@publicworship.life" });
    const { eventId } = await seedEvent(s, { name: "Launch Night", budget: 300 });

    const budgetId = await s.as.mutation(api.finances.createBudget, {
      amountCents: 30000,
      type: "one_time",
      refKind: "event",
      cadence: "per_instance",
      year: 2026,
      scopeRefId: eventId,
    });

    const budget = await run(s.t, (ctx) => ctx.db.get(budgetId));
    expect(budget?.label).toBe("Launch Night");
  });

  test("same name in DIFFERENT months → label is suffixed with month + year", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: "seyi@publicworship.life" });
    const { eventId: marId } = await seedEvent(s, {
      name: "Field Day",
      eventDate: tsInMonth(2026, 3),
      budget: 100,
    });
    await seedEvent(s, {
      name: "Field Day",
      eventDate: tsInMonth(2026, 4),
      budget: 100,
    });

    const budgetId = await s.as.mutation(api.finances.createBudget, {
      amountCents: 10000,
      type: "one_time",
      refKind: "event",
      cadence: "per_instance",
      year: 2026,
      scopeRefId: marId,
    });

    const budget = await run(s.t, (ctx) => ctx.db.get(budgetId));
    expect(budget?.label).toBe("Field Day · March 2026");
  });

  test("same name in the SAME month → label is suffixed with the full date", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: "seyi@publicworship.life" });
    const { eventId: firstId } = await seedEvent(s, {
      name: "Field Day",
      eventDate: tsOnDay(2026, 3, 15),
      budget: 100,
    });
    await seedEvent(s, {
      name: "Field Day",
      eventDate: tsOnDay(2026, 3, 22),
      budget: 100,
    });

    const budgetId = await s.as.mutation(api.finances.createBudget, {
      amountCents: 10000,
      type: "one_time",
      refKind: "event",
      cadence: "per_instance",
      year: 2026,
      scopeRefId: firstId,
    });

    const budget = await run(s.t, (ctx) => ctx.db.get(budgetId));
    expect(budget?.label).toBe("Field Day · Mar 15, 2026");
  });

  test("an explicit label is preserved (not overridden by the event name)", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: "seyi@publicworship.life" });
    const { eventId } = await seedEvent(s, { name: "Launch Night", budget: 300 });

    const budgetId = await s.as.mutation(api.finances.createBudget, {
      amountCents: 30000,
      type: "one_time",
      refKind: "event",
      cadence: "per_instance",
      year: 2026,
      scopeRefId: eventId,
      label: "VIP night",
    });

    const budget = await run(s.t, (ctx) => ctx.db.get(budgetId));
    expect(budget?.label).toBe("VIP night");
  });
});

describe("instantiateEvent: events-parity create-time hook (WP-3.4)", () => {
  test("createFromTemplate with a positive budget summons the event's budget immediately", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventTypeId = (await s.as.mutation(api.eventTypes.create, {
      name: "Spring Retreat Template",
    })) as Id<"eventTypes">;

    const eventId = (await s.as.mutation(api.events.createFromTemplate, {
      eventTypeId,
      name: "Spring Retreat",
      eventDate: tsInMonth(2026, 5),
      budget: 600,
    })) as Id<"events">;

    const [row] = await eventBudgetsFor(s, eventId);
    expect(row).toBeDefined();
    expect(row.budget.type).toBe("one_time");
    expect(row.budget.refKind).toBe("event");
    expect(row.budget.amountCents).toBe(60000);
    expect(row.budget.label).toBe("Spring Retreat");
    expect(row.tagKinds).toEqual(["events", "template"]);
  });

  test("owner rule: no budget, 0, or negative given at creation → no budget object", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventTypeId = (await s.as.mutation(api.eventTypes.create, {
      name: "Casual Meetup Template",
    })) as Id<"eventTypes">;

    const noBudgetId = (await s.as.mutation(api.events.createFromTemplate, {
      eventTypeId,
      name: "No Budget Meetup",
      eventDate: tsInMonth(2026, 6),
    })) as Id<"events">;
    const zeroId = (await s.as.mutation(api.events.createFromTemplate, {
      eventTypeId,
      name: "Zero Budget Meetup",
      eventDate: tsInMonth(2026, 6),
      budget: 0,
    })) as Id<"events">;

    expect(await eventBudgetsFor(s, noBudgetId)).toEqual([]);
    expect(await eventBudgetsFor(s, zeroId)).toEqual([]);
  });

  test("isTraining events never get a budget, even with a positive budget (Academy sandbox)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventTypeId = (await s.as.mutation(api.eventTypes.create, {
      name: "Academy Template",
    })) as Id<"eventTypes">;

    const eventId = await run(s.t, async (ctx) => {
      const eventType = await ctx.db.get(eventTypeId);
      return await instantiateEvent(ctx, {
        eventType,
        chapterId: s.chapterId,
        userId: s.userId,
        name: "Academy Sandbox Event",
        eventDate: tsInMonth(2026, 5),
        budget: 500,
        isTraining: true,
      });
    });

    expect(await eventBudgetsFor(s, eventId)).toEqual([]);
  });
});

describe("events.updateDetails: edit-path trigger summons a budget on 0 → positive budget", () => {
  test("editing a budget-less event to a positive budget summons its budget", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const { eventId } = await seedEvent(s, { name: "Starts Free", budget: undefined });
    expect(await eventBudgetsFor(s, eventId)).toEqual([]);

    await s.as.mutation(api.events.updateDetails, { eventId, budget: 350 });

    const [row] = await eventBudgetsFor(s, eventId);
    expect(row).toBeDefined();
    expect(row.budget.amountCents).toBe(35000);
    expect(row.budget.label).toBe("Starts Free");
  });

  test("raising budget from 0 to positive also summons the budget", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const { eventId } = await seedEvent(s, { name: "Starts At Zero", budget: 0 });
    expect(await eventBudgetsFor(s, eventId)).toEqual([]);

    await s.as.mutation(api.events.updateDetails, { eventId, budget: 250 });

    const [row] = await eventBudgetsFor(s, eventId);
    expect(row.budget.amountCents).toBe(25000);
  });

  test("training events never summon a budget via updateDetails, even given a positive budget", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const { eventId } = await seedEvent(s, {
      name: "Academy Practice",
      isTraining: true,
      budget: undefined,
    });

    await s.as.mutation(api.events.updateDetails, { eventId, budget: 999 });

    expect(await eventBudgetsFor(s, eventId)).toEqual([]);
  });

  test("clearing budget back to null never deletes an existing budget", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const { eventId } = await seedEvent(s, { name: "Funded Then Cleared", budget: 100 });
    await t.mutation(internal.finances.backfillEventBudgets, {});
    expect((await eventBudgetsFor(s, eventId)).length).toBe(1);

    await s.as.mutation(api.events.updateDetails, { eventId, budget: null });

    // The budget object stays; only the event's own `budget` estimate clears.
    expect((await eventBudgetsFor(s, eventId)).length).toBe(1);
    const ev = await run(s.t, (ctx) => ctx.db.get(eventId));
    expect(ev?.budget).toBeUndefined();
  });

  test("does not create a duplicate budget when one already exists (by_ref check) — WP-U2: the edit writes THROUGH to the existing row instead", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const { eventId } = await seedEvent(s, { name: "Pre-existing Event Budget", budget: undefined });
    // Simulate an event that pre-dates the owner rule: a zero-amount budget
    // already attached (e.g. from the pre-fix #125 backfill).
    await run(s.t, (ctx) =>
      ctx.db.insert("budgets", {
        chapterId: s.chapterId,
        amountCents: 0,
        type: "one_time",
        refKind: "event",
        scopeRefId: eventId,
        cadence: "per_instance",
        year: 2026,
        createdAt: Date.now(),
      }),
    );

    await s.as.mutation(api.events.updateDetails, { eventId, budget: 700 });

    const rows = await eventBudgetsFor(s, eventId);
    expect(rows.length).toBe(1); // no duplicate created
    // WP-U2: the budgets row is the single source of truth — the edit writes
    // THROUGH to the pre-existing row instead of leaving it untouched.
    expect(rows[0].budget.amountCents).toBe(70000);
    const ev = await run(s.t, (ctx) => ctx.db.get(eventId));
    expect(ev?.budget).toBe(700); // mirrored back onto the entity field
  });
});
