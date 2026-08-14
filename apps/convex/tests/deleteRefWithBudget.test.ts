import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { api } from "../_generated/api";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import type { Id } from "../_generated/dataModel";

/**
 * Deleting an event or a project takes its budget with it — unless money is
 * already coded there, in which case the delete is REFUSED.
 *
 * Both halves come from one production incident. "Love Thy Neighbor 2026" was a
 * $6,000 budget whose event had been deleted out from under it: the budget
 * survived, pointing at an id that resolves to nothing, and no screen in the
 * app could delete it (`finances.deleteBudget` has no caller) — it took a
 * one-off runner. Nothing cleans that up today, so every event/project deletion
 * can mint another orphan.
 *
 * Deleting the budget along with its event fixes that, but only for the empty
 * case. The same budget had carried a $325 receipted charge until days before,
 * and silently unlinking real spend because someone tidied up an event is a
 * worse outcome than the orphan — so spend blocks the whole delete and says
 * what to do about it (owner decision, 2026-08-14).
 */

async function seedEventType(s: ChapterSetup): Promise<Id<"eventTypes">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("eventTypes", {
      chapterId: s.chapterId,
      name: "Gathering",
      slug: "gathering",
      version: 1,
      isArchived: false,
      createdBy: s.userId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
}

/** An event plus the `one_time` budget the create-time hook links to it. */
async function seedEventWithBudget(
  s: ChapterSetup,
  amountCents = 600_000,
): Promise<{ eventId: Id<"events">; budgetId: Id<"budgets"> }> {
  const eventTypeId = await seedEventType(s);
  return await run(s.t, async (ctx) => {
    const eventId = await ctx.db.insert("events", {
      chapterId: s.chapterId,
      eventTypeId,
      templateVersion: 1,
      name: "Love Thy Neighbor",
      eventDate: Date.now(),
      status: "planning",
      createdBy: s.userId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const budgetId = await ctx.db.insert("budgets", {
      chapterId: s.chapterId,
      amountCents,
      type: "one_time",
      cadence: "per_instance",
      refKind: "event",
      scopeRefId: eventId,
      label: "Love Thy Neighbor 2026",
      year: 2026,
      approvalStatus: "approved",
      createdAt: Date.now(),
    });
    return { eventId, budgetId };
  });
}

async function seedProjectWithBudget(
  s: ChapterSetup,
): Promise<{ projectId: Id<"projects">; budgetId: Id<"budgets"> }> {
  return await run(s.t, async (ctx) => {
    const projectId = await ctx.db.insert("projects", {
      chapterId: s.chapterId,
      name: "Create sponsorship package for LTN",
      status: "in_progress",
      createdBy: s.userId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const budgetId = await ctx.db.insert("budgets", {
      chapterId: s.chapterId,
      amountCents: 50_000,
      type: "one_time",
      cadence: "per_instance",
      refKind: "project",
      scopeRefId: projectId,
      label: "Create sponsorship package for LTN",
      year: 2026,
      approvalStatus: "approved",
      createdAt: Date.now(),
    });
    return { projectId, budgetId };
  });
}

async function codeSpend(
  s: ChapterSetup,
  budgetId: Id<"budgets">,
  amountCents: number,
): Promise<void> {
  await run(s.t, async (ctx) => {
    await ctx.db.insert("transactions", {
      chapterId: s.chapterId,
      source: "relay_csv",
      flow: "outflow",
      amountCents,
      postedAt: Date.now(),
      status: "reconciled",
      budgetId,
      createdAt: Date.now(),
    });
  });
}

describe("events.remove — the budget goes with the event", () => {
  test("an empty budget is deleted along with its event", async () => {
    const s = await setupChapter(newT());
    const { eventId, budgetId } = await seedEventWithBudget(s);

    await s.as.mutation(api.events.remove, { eventId });

    const [event, budget] = await run(s.t, async (ctx) => [
      await ctx.db.get(eventId),
      await ctx.db.get(budgetId),
    ]);
    expect(event).toBeNull();
    // The whole point: no budget left pointing at an id that resolves to
    // nothing. This is the state the production one-off had to clean up.
    expect(budget).toBeNull();
  });

  test("the budget's tag links go too — no orphan rows behind it", async () => {
    const s = await setupChapter(newT());
    const { eventId, budgetId } = await seedEventWithBudget(s);
    await run(s.t, async (ctx) => {
      const tagId = await ctx.db.insert("budgetTags", {
        chapterId: s.chapterId,
        name: "Love Thy Neighbor",
        createdAt: Date.now(),
      });
      await ctx.db.insert("budgetTagLinks", {
        chapterId: s.chapterId,
        budgetId,
        tagId,
        createdAt: Date.now(),
      });
    });

    await s.as.mutation(api.events.remove, { eventId });

    const links = await run(s.t, (ctx) =>
      ctx.db
        .query("budgetTagLinks")
        .withIndex("by_budget", (q) => q.eq("budgetId", budgetId))
        .collect(),
    );
    expect(links).toEqual([]);
  });

  test("spend on the budget refuses the delete, and says what to do", async () => {
    const s = await setupChapter(newT());
    const { eventId, budgetId } = await seedEventWithBudget(s);
    await codeSpend(s, budgetId, 32_500);

    const err = await s.as
      .mutation(api.events.remove, { eventId })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConvexError);
    const data = (err as ConvexError<{ code: string; message: string }>).data;
    expect(data.code).toBe("BUDGET_HAS_SPEND");
    expect(data.message).toContain("$325.00");
    expect(data.message).toContain("Love Thy Neighbor 2026");
    expect(data.message).toContain("recode");
  });

  test("a refused delete leaves the event and everything on it intact", async () => {
    const s = await setupChapter(newT());
    const { eventId, budgetId } = await seedEventWithBudget(s);
    await codeSpend(s, budgetId, 32_500);
    const itemId = await run(s.t, (ctx) =>
      ctx.db.insert("eventItems", {
        eventId,
        chapterId: s.chapterId,
        module: "planning_doc",
        title: "Book the venue",
        order: 0,
      }),
    );

    await s.as.mutation(api.events.remove, { eventId }).catch(() => undefined);

    // The guard runs before the cascade, and the mutation is transactional
    // either way — a refusal must not half-delete the event.
    const [event, item, budget] = await run(s.t, async (ctx) => [
      await ctx.db.get(eventId),
      await ctx.db.get(itemId),
      await ctx.db.get(budgetId),
    ]);
    expect(event).not.toBeNull();
    expect(item).not.toBeNull();
    expect(budget).not.toBeNull();
  });

  test("an event with no budget at all still deletes", async () => {
    const s = await setupChapter(newT());
    const eventTypeId = await seedEventType(s);
    const eventId = await run(s.t, (ctx) =>
      ctx.db.insert("events", {
        chapterId: s.chapterId,
        eventTypeId,
        templateVersion: 1,
        name: "Training run",
        eventDate: Date.now(),
        status: "planning",
        isTraining: true,
        createdBy: s.userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );

    await s.as.mutation(api.events.remove, { eventId });

    expect(await run(s.t, (ctx) => ctx.db.get(eventId))).toBeNull();
  });
});

describe("projects.remove — the same rule, same reason", () => {
  test("an empty budget is deleted along with its project", async () => {
    const s = await setupChapter(newT());
    const { projectId, budgetId } = await seedProjectWithBudget(s);

    await s.as.mutation(api.projects.remove, { projectId });

    const [project, budget] = await run(s.t, async (ctx) => [
      await ctx.db.get(projectId),
      await ctx.db.get(budgetId),
    ]);
    expect(project).toBeNull();
    expect(budget).toBeNull();
  });

  test("spend on the budget refuses the delete", async () => {
    const s = await setupChapter(newT());
    const { projectId, budgetId } = await seedProjectWithBudget(s);
    await codeSpend(s, budgetId, 50_000);

    const err = await s.as
      .mutation(api.projects.remove, { projectId })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConvexError);
    const data = (err as ConvexError<{ code: string; message: string }>).data;
    expect(data.code).toBe("BUDGET_HAS_SPEND");
    expect(data.message).toContain("$500.00");
    expect(data.message).toContain("project");
  });
});
