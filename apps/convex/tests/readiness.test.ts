import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import { newT, run, setupChapter } from "./setup.helpers";
import type { Id } from "../_generated/dataModel";

/**
 * Characterization tests for the readiness math (`statusCountsFor` →
 * `events.eventReadiness` / `moduleSummaries`). An item is "done" when its
 * status matches a status-column option flagged `isComplete`. With no status
 * column, done is 0.
 */

const STATUS_OPTIONS = [
  { value: "todo", label: "To do", isComplete: false },
  { value: "doing", label: "Doing", isComplete: false },
  { value: "done", label: "Done", isComplete: true },
];

/**
 * Seed a minimal event with a planning_doc module, optionally with a status
 * column, and a set of items with the given statuses.
 */
async function seedEvent(
  t: ReturnType<typeof newT>,
  chapterId: Id<"chapters">,
  userId: Id<"users">,
  opts: { withStatusColumn: boolean; statuses: (string | undefined)[] },
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
      name: "My Event",
      eventDate: now + 7 * 24 * 3600 * 1000,
      status: "planning",
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    });
    if (opts.withStatusColumn) {
      await ctx.db.insert("eventColumns", {
        eventId,
        module: "planning_doc",
        key: "status",
        label: "Status",
        kind: "system",
        type: "status",
        options: STATUS_OPTIONS,
        isVisible: true,
        order: 0,
      });
    }
    let order = 0;
    for (const status of opts.statuses) {
      await ctx.db.insert("eventItems", {
        eventId,
        chapterId,
        module: "planning_doc",
        title: `Item ${order}`,
        order: order++,
        status,
      });
    }
    return { eventId };
  });
}

describe("event readiness (statusCountsFor via events.get)", () => {
  test("done-count + percentage with a status column and mixed statuses", async () => {
    const t = newT();
    const { as, chapterId, userId } = await setupChapter(t);
    // 4 items: 2 done, 1 doing, 1 todo → 2/4 = 50%.
    const { eventId } = await seedEvent(t, chapterId, userId, {
      withStatusColumn: true,
      statuses: ["done", "done", "doing", "todo"],
    });

    const result = await as.query(api.events.get, { eventId });
    expect(result).not.toBeNull();
    expect(result!.taskTotal).toBe(4);
    expect(result!.taskDone).toBe(2);
    expect(result!.readiness).toBe(50);
  });

  test("all done → 100%", async () => {
    const t = newT();
    const { as, chapterId, userId } = await setupChapter(t);
    const { eventId } = await seedEvent(t, chapterId, userId, {
      withStatusColumn: true,
      statuses: ["done", "done"],
    });
    const result = await as.query(api.events.get, { eventId });
    expect(result!.taskTotal).toBe(2);
    expect(result!.taskDone).toBe(2);
    expect(result!.readiness).toBe(100);
  });

  test("no status column → done is 0 even with items present", async () => {
    const t = newT();
    const { as, chapterId, userId } = await setupChapter(t);
    const { eventId } = await seedEvent(t, chapterId, userId, {
      withStatusColumn: false,
      statuses: ["done", "done", "todo"],
    });
    const result = await as.query(api.events.get, { eventId });
    expect(result!.taskTotal).toBe(3);
    expect(result!.taskDone).toBe(0);
    expect(result!.readiness).toBe(0);
  });

  test("no items → readiness 0, total 0", async () => {
    const t = newT();
    const { as, chapterId, userId } = await setupChapter(t);
    const { eventId } = await seedEvent(t, chapterId, userId, {
      withStatusColumn: true,
      statuses: [],
    });
    const result = await as.query(api.events.get, { eventId });
    expect(result!.taskTotal).toBe(0);
    expect(result!.taskDone).toBe(0);
    expect(result!.readiness).toBe(0);
  });
});

describe("phase readiness — supplies acquisition vs packing (via events.get)", () => {
  const SUPPLY_OPTIONS = [
    { value: "need_to_order", label: "Need to order", isComplete: false },
    { value: "have_it", label: "Have it", isComplete: true },
  ];

  /** An event with ONLY supplies rows: statuses + fields.packedIn. */
  async function seedSupplies(
    t: ReturnType<typeof newT>,
    chapterId: Id<"chapters">,
    userId: Id<"users">,
    items: { status: string; packedIn: boolean }[],
  ) {
    return await run(t, async (ctx) => {
      const now = Date.now();
      // Only the supplies tab is active, so the phase math reads one module.
      const onlySupplies = [
        "planning_doc",
        "comms",
        "run_of_show",
        "volunteer_expectations",
        "permits",
        "retro",
      ];
      const eventTypeId = await ctx.db.insert("eventTypes", {
        chapterId,
        name: "S",
        slug: "s",
        version: 1,
        isArchived: false,
        disabledCoreModules: onlySupplies,
        createdBy: userId,
        createdAt: now,
        updatedAt: now,
      });
      const eventId = await ctx.db.insert("events", {
        chapterId,
        eventTypeId,
        templateVersion: 1,
        name: "Supplies Event",
        eventDate: now + 7 * 24 * 3600 * 1000,
        status: "planning",
        // Events carry their own module deltas (not read from the type here).
        disabledCoreModules: onlySupplies,
        // Mark the supplies ready gate met so it doesn't dilute the planning
        // average — these tests isolate the item-level acquisition/packing math.
        moduleReadiness: [{ key: "supplies", ready: true }],
        createdBy: userId,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("eventColumns", {
        eventId,
        module: "supplies",
        key: "status",
        label: "Status",
        kind: "system",
        type: "status",
        options: SUPPLY_OPTIONS,
        isVisible: true,
        order: 0,
      });
      let order = 0;
      for (const it of items) {
        await ctx.db.insert("eventItems", {
          eventId,
          chapterId,
          module: "supplies",
          title: `Supply ${order}`,
          order: order++,
          status: it.status,
          fields: { packedIn: it.packedIn },
        });
      }
      return { eventId };
    });
  }

  test("statuses feed Planning; the packedIn checklist feeds Day-of", async () => {
    const t = newT();
    const { as, chapterId, userId } = await setupChapter(t);
    // Both in hand, one packed: acquisition is 100% planning-side, and the
    // Day-of ring reads exactly the packing checklist (1 of 2).
    const { eventId } = await seedSupplies(t, chapterId, userId, [
      { status: "have_it", packedIn: true },
      { status: "have_it", packedIn: false },
    ]);
    const result = await as.query(api.events.get, { eventId });
    expect(result!.phases.planning).toBe(1);
    expect(result!.phases.dayOf).toBeCloseTo(0.5);
  });

  test("an unpacked but fully-acquired plan shows a Day-of gap, not Planning", async () => {
    const t = newT();
    const { as, chapterId, userId } = await setupChapter(t);
    const { eventId } = await seedSupplies(t, chapterId, userId, [
      { status: "need_to_order", packedIn: false },
      { status: "have_it", packedIn: false },
    ]);
    const result = await as.query(api.events.get, { eventId });
    // Acquisition half-way (partial + complete), nothing packed.
    expect(result!.phases.planning).toBeGreaterThan(0);
    expect(result!.phases.planning).toBeLessThan(1);
    expect(result!.phases.dayOf).toBe(0);
  });
});

describe("moduleSummaries (statusCountsFor per active module)", () => {
  test("planning_doc summary reports total/done/hasStatus from the status column", async () => {
    const t = newT();
    const { as, chapterId, userId } = await setupChapter(t);
    const { eventId } = await seedEvent(t, chapterId, userId, {
      withStatusColumn: true,
      statuses: ["done", "todo", "todo"],
    });

    const summaries = await as.query(api.events.moduleSummaries, { eventId });
    expect(summaries).not.toBeNull();
    const planning = summaries!.find((m) => m.module === "planning_doc");
    expect(planning).toBeDefined();
    expect(planning!.total).toBe(3);
    expect(planning!.done).toBe(1);
    expect(planning!.hasStatus).toBe(true);
    expect(planning!.readiness).toBe(Math.round((1 / 3) * 100));
  });
});
