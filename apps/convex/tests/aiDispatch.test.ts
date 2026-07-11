import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import { dispatchTool, parseRescheduleDate } from "../aiActions";
import { newT, run, setupChapter } from "./setup.helpers";
import type { ChapterSetup, TestConvex } from "./setup.helpers";
import type { Id } from "../_generated/dataModel";

/**
 * The agent's tool dispatch — resilience + capability fixes:
 *   - promote_to_template with a hallucinated id returns ok:false (the run
 *     continues) instead of throwing and erroring the whole run.
 *   - add_item accepts the event's ACTUAL workstreams, including custom ones;
 *     a bogus key errors listing the valid keys.
 *   - update_item can write CUSTOM columns (e.g. retro `dispatch`) into the
 *     fields bag, validates select values, and errors on unknown props
 *     instead of silently succeeding.
 *   - add_engagement carries amount_usd through to the engagement row.
 *   - parseRescheduleDate rejects rollover/invalid calendar dates.
 */

/** dispatchTool expects an ACTION ctx; route its calls through the test client. */
function actionCtx(as: ChapterSetup["as"]) {
  return {
    runQuery: (ref: unknown, args: unknown) => (as.query as any)(ref, args),
    runMutation: (ref: unknown, args: unknown) =>
      (as.mutation as any)(ref, args),
  } as any;
}

async function seed(
  t: TestConvex,
  chapterId: Id<"chapters">,
  userId: Id<"users">,
) {
  return await run(t, async (ctx) => {
    const now = Date.now();
    const eventTypeId = await ctx.db.insert("eventTypes", {
      chapterId,
      name: "T",
      slug: "t",
      version: 1,
      isArchived: false,
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    });
    const eventId = await ctx.db.insert("events", {
      chapterId,
      eventTypeId,
      templateVersion: 1,
      name: "Dispatch Event",
      eventDate: now + 7 * 24 * 3600 * 1000,
      status: "planning",
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    });
    // A retro row + the retro dispatch select column (the DEBRIEF flow).
    const retroItemId = await ctx.db.insert("eventItems", {
      eventId,
      chapterId,
      module: "retro",
      title: "Sound check ran late",
      order: 0,
    });
    await ctx.db.insert("eventColumns", {
      eventId,
      module: "retro",
      key: "dispatch",
      label: "Dispatch",
      kind: "custom",
      type: "select",
      options: [
        { value: "promoted", label: "Promoted" },
        { value: "context", label: "Context" },
        { value: "dropped", label: "Dropped" },
      ],
      isVisible: true,
      order: 0,
    });
    // A custom (agent- or user-created) workstream.
    await ctx.db.insert("eventModules", {
      eventId,
      key: "merch",
      label: "Merch Stand",
      order: 0,
    });
    const personId = await ctx.db.insert("people", {
      chapterId,
      name: "Ana Diaz",
      vettingStatus: "unvetted",
      status: "active",
      isActive: true,
      createdAt: now,
    });
    const runId = await ctx.db.insert("aiRuns", {
      chapterId,
      userId,
      feature: "assistant",
      eventId,
      model: "test-model",
      status: "running",
      itemsTouched: 0,
      costUsd: 0,
      createdAt: now,
    });
    return { eventId, retroItemId, personId, runId };
  });
}

async function setup() {
  const t = newT();
  const { as, chapterId, userId } = await setupChapter(t);
  const seeded = await seed(t, chapterId, userId);
  const context = await as.query(internal.ai.eventContext, {
    eventId: seeded.eventId,
    chapterId,
  });
  expect(context).not.toBeNull();
  return { t, as, chapterId, ...seeded, context: context as any };
}

describe("promote_to_template resilience", () => {
  test("a bogus promotion id yields ok:false — no throw, run continues", async () => {
    const { as, chapterId, eventId, runId, context } = await setup();
    // Hallucinated id: fails v.id("eventItems") validation inside the
    // mutation — the dispatch must catch it and answer as a tool error.
    const res = await dispatchTool(
      actionCtx(as),
      runId,
      eventId,
      chapterId,
      context,
      "promote_to_template",
      {
        promotions: [{ kind: "update_item", event_item_id: "not-a-real-id" }],
      },
    );
    expect(res.ok).toBe(false);
    expect(res.summary).toMatch(/diff_event_vs_template|template/i);
  });
});

describe("add_item workstream validation", () => {
  test("adding into a CUSTOM workstream succeeds", async () => {
    const { t, as, chapterId, eventId, runId, context } = await setup();
    const res = await dispatchTool(
      actionCtx(as),
      runId,
      eventId,
      chapterId,
      context,
      "add_item",
      { module: "merch", title: "T-shirts (M)" },
    );
    expect(res.ok).toBe(true);
    const items = await run(t, (ctx) =>
      ctx.db
        .query("eventItems")
        .withIndex("by_event_module", (q) =>
          q.eq("eventId", eventId).eq("module", "merch"),
        )
        .collect(),
    );
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("T-shirts (M)");
  });

  test("a bogus workstream key errors, listing the valid keys", async () => {
    const { as, chapterId, eventId, runId, context } = await setup();
    const res = await dispatchTool(
      actionCtx(as),
      runId,
      eventId,
      chapterId,
      context,
      "add_item",
      { module: "nonexistent", title: "Nope" },
    );
    expect(res.ok).toBe(false);
    expect(res.summary).toContain("merch");
    expect(res.summary).toContain("planning_doc");
  });
});

describe("update_item custom columns", () => {
  test("writes the retro dispatch column into fields", async () => {
    const { t, as, chapterId, eventId, runId, retroItemId, context } =
      await setup();
    const res = await dispatchTool(
      actionCtx(as),
      runId,
      eventId,
      chapterId,
      context,
      "update_item",
      { item_id: retroItemId, dispatch: "promoted" },
    );
    expect(res.ok).toBe(true);
    const item = await run(t, (ctx) => ctx.db.get(retroItemId));
    expect(item!.fields?.dispatch).toBe("promoted");
  });

  test("an unknown prop returns an error naming it (no silent success)", async () => {
    const { t, as, chapterId, eventId, runId, retroItemId, context } =
      await setup();
    const res = await dispatchTool(
      actionCtx(as),
      runId,
      eventId,
      chapterId,
      context,
      "update_item",
      { item_id: retroItemId, frobnicate: "yes" },
    );
    expect(res.ok).toBe(false);
    expect(res.summary).toContain("frobnicate");
    const item = await run(t, (ctx) => ctx.db.get(retroItemId));
    expect(item!.fields?.frobnicate).toBeUndefined();
  });

  test("an invalid select value errors, listing the options", async () => {
    const { as, chapterId, eventId, runId, retroItemId, context } =
      await setup();
    const res = await dispatchTool(
      actionCtx(as),
      runId,
      eventId,
      chapterId,
      context,
      "update_item",
      { item_id: retroItemId, dispatch: "bogus" },
    );
    expect(res.ok).toBe(false);
    expect(res.summary).toContain("promoted");
    expect(res.summary).toContain("dropped");
  });
});

describe("add_engagement amount_usd", () => {
  test("creates a paid engagement carrying the amount", async () => {
    const { t, as, chapterId, eventId, runId, personId, context } =
      await setup();
    const res = await dispatchTool(
      actionCtx(as),
      runId,
      eventId,
      chapterId,
      context,
      "add_engagement",
      { person: "Ana Diaz", type: "paid", amount_usd: 250 },
    );
    expect(res.ok).toBe(true);
    const eng = await run(t, async (ctx) =>
      (
        await ctx.db
          .query("engagements")
          .withIndex("by_person", (q) => q.eq("personId", personId))
          .collect()
      ).find((e) => e.eventId === eventId),
    );
    expect(eng).toBeDefined();
    expect(eng!.type).toBe("paid");
    expect(eng!.amountUsd).toBe(250);
    expect(eng!.paymentStatus).toBe("unpaid");
  });
});

describe("parseRescheduleDate calendar validation", () => {
  const currentDate = Date.UTC(2026, 0, 10, 17, 0); // noon ET
  test("a rollover date (June 31st) returns null", () => {
    expect(parseRescheduleDate("2026-06-31", currentDate)).toBeNull();
  });
  test("an out-of-range month returns null", () => {
    expect(parseRescheduleDate("2026-13-05", currentDate)).toBeNull();
  });
  test("the reschedule tool answers \"couldn't parse\" for a rollover date", async () => {
    const { as, chapterId, eventId, runId, context } = await setup();
    const res = await dispatchTool(
      actionCtx(as),
      runId,
      eventId,
      chapterId,
      context,
      "reschedule_event",
      { date: "2026-06-31" },
    );
    expect(res.ok).toBe(false);
    expect(res.summary).toMatch(/couldn't parse/i);
  });
});
