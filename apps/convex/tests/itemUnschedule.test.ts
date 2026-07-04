import { describe, expect, test } from "vitest";
import { computeDueDate } from "@events-os/shared";
import { api } from "../_generated/api";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import type { Id } from "../_generated/dataModel";

/**
 * Characterization tests for scheduling / unscheduling a calendar item via
 * `items.updateEventItem`. An item's timing is a signed `offsetDays` from the
 * event; the `dueDate` is a DERIVED cache (`computeDueDate(eventDate,
 * offsetDays)`) the calendar buckets on. The subtle contract added for
 * drag-to-reschedule + the day panel's "Unschedule":
 *   - a numeric offset persists AND recomputes the derived dueDate,
 *   - `offsetDays: null` UNSCHEDULES — it clears both the offset and the derived
 *     dueDate (patch `undefined`), so the item drops out of the day buckets,
 *   - re-scheduling from null recomputes the dueDate again,
 *   - OMITTING offsetDays leaves an existing schedule untouched.
 */

// A deliberately awkward event time so any time-of-day leak into dueDate shows.
const EVENT_DATE = new Date(2026, 6, 27, 17, 5).getTime(); // Jul 27 2026, 17:05

async function seedEventItem(
  setup: ChapterSetup,
): Promise<Id<"eventItems">> {
  const { t, chapterId, userId } = setup;
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
      name: "Field Day",
      eventDate: EVENT_DATE,
      status: "planning",
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    });
    return await ctx.db.insert("eventItems", {
      eventId,
      chapterId,
      // planning_doc is a day-offset module, so dueDate derives from offsetDays.
      module: "planning_doc",
      title: "Confirm venue + file permits",
      order: 0,
    });
  });
}

describe("updateEventItem scheduling", () => {
  test("a numeric offset persists and derives the due date", async () => {
    const t = newT();
    const setup = await setupChapter(t);
    const itemId = await seedEventItem(setup);

    await setup.as.mutation(api.items.updateEventItem, {
      itemId,
      offsetDays: -21,
    });

    const item = await run(t, (ctx) => ctx.db.get(itemId));
    expect(item?.offsetDays).toBe(-21);
    expect(item?.dueDate).toBe(computeDueDate(EVENT_DATE, -21));
  });

  test("offsetDays: null unschedules — clears the offset AND the due date", async () => {
    const t = newT();
    const setup = await setupChapter(t);
    const itemId = await seedEventItem(setup);

    await setup.as.mutation(api.items.updateEventItem, {
      itemId,
      offsetDays: -21,
    });
    await setup.as.mutation(api.items.updateEventItem, {
      itemId,
      offsetDays: null,
    });

    const item = await run(t, (ctx) => ctx.db.get(itemId));
    expect(item?.offsetDays).toBeUndefined();
    expect(item?.dueDate).toBeUndefined();
  });

  test("re-scheduling from unscheduled recomputes the due date", async () => {
    const t = newT();
    const setup = await setupChapter(t);
    const itemId = await seedEventItem(setup);

    await setup.as.mutation(api.items.updateEventItem, {
      itemId,
      offsetDays: -21,
    });
    await setup.as.mutation(api.items.updateEventItem, {
      itemId,
      offsetDays: null,
    });
    await setup.as.mutation(api.items.updateEventItem, {
      itemId,
      offsetDays: 3,
    });

    const item = await run(t, (ctx) => ctx.db.get(itemId));
    expect(item?.offsetDays).toBe(3);
    expect(item?.dueDate).toBe(computeDueDate(EVENT_DATE, 3));
  });

  test("omitting offsetDays leaves an existing schedule untouched", async () => {
    const t = newT();
    const setup = await setupChapter(t);
    const itemId = await seedEventItem(setup);

    await setup.as.mutation(api.items.updateEventItem, {
      itemId,
      offsetDays: -7,
    });
    // A later edit that only renames must not disturb the schedule.
    await setup.as.mutation(api.items.updateEventItem, {
      itemId,
      title: "Renamed",
    });

    const item = await run(t, (ctx) => ctx.db.get(itemId));
    expect(item?.offsetDays).toBe(-7);
    expect(item?.dueDate).toBe(computeDueDate(EVENT_DATE, -7));
    expect(item?.title).toBe("Renamed");
  });
});
