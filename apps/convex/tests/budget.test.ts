import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import {
  newT,
  run,
  setupChapter,
  storeBlob,
  type ChapterSetup,
} from "./setup.helpers";
import type { Id } from "../_generated/dataModel";

/**
 * Budget (line-item) tests — the typed per-line budget (Budget v1):
 *   - add / update / remove line items,
 *   - budgetSummary rollups: Σ planned, Σ actual, income = revenue + donations,
 *     net = income − actual (incl. the no-line-items zero case),
 *   - setReceipt attach + clear (with URL resolution),
 *   - cents validation rejects negative / non-integer planned + actual,
 *   - access gating rejects a non-member, a cross-chapter admin, and an
 *     unauthenticated caller.
 */

/** Minimal template + event so chapter-scoped admin functions have a target. */
async function seedEvent(s: ChapterSetup): Promise<Id<"events">> {
  return await run(s.t, async (ctx) => {
    const now = Date.now();
    const eventTypeId = await ctx.db.insert("eventTypes", {
      chapterId: s.chapterId,
      name: "Worship Night",
      slug: "worship-night",
      version: 1,
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
    });
    return await ctx.db.insert("events", {
      chapterId: s.chapterId,
      eventTypeId,
      templateVersion: 1,
      name: "Worship Night on the Pier",
      eventDate: now + 14 * 24 * 60 * 60 * 1000,
      status: "planning",
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
    });
  });
}

/** Create the event page and force its money-IN rollups to known amounts. */
async function seedIncome(
  s: ChapterSetup,
  eventId: Id<"events">,
  revenueCents: number,
  donationsCents: number,
) {
  await s.as.mutation(api.ticketing.createPage, { eventId });
  await run(s.t, async (ctx) => {
    const page = await ctx.db
      .query("eventPages")
      .withIndex("by_event", (q) => q.eq("eventId", eventId))
      .unique();
    if (page) await ctx.db.patch(page._id, { revenueCents, donationsCents });
  });
}

describe("budget line items", () => {
  test("add / update / remove; summary rolls up planned + actual", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);

    const venue = (await s.as.mutation(api.budget.addLineItem, {
      eventId,
      label: "Venue rental",
      category: "venue",
      plannedCents: 50000,
    })) as Id<"budgetLineItems">;
    await s.as.mutation(api.budget.addLineItem, {
      eventId,
      label: "Flyers",
      category: "marketing",
      plannedCents: 5000,
      note: "double-sided",
    });

    let summary = await s.as.query(api.budget.budgetSummary, { eventId });
    expect(summary.lineItems).toHaveLength(2);
    // order is append order.
    expect(summary.lineItems.map((l) => l.label)).toEqual([
      "Venue rental",
      "Flyers",
    ]);
    expect(summary.plannedCents).toBe(55000);
    expect(summary.actualCents).toBe(0);
    // No page → income 0, net = 0 − 0.
    expect(summary.incomeCents).toBe(0);
    expect(summary.netCents).toBe(0);

    // Record an actual on the venue line + re-plan it + change category.
    await s.as.mutation(api.budget.updateLineItem, {
      lineItemId: venue,
      plannedCents: 48000,
      actualCents: 47250,
      category: "production",
      label: "Venue + PA",
    });
    summary = await s.as.query(api.budget.budgetSummary, { eventId });
    const venueRow = summary.lineItems.find((l) => l._id === venue)!;
    expect(venueRow.label).toBe("Venue + PA");
    expect(venueRow.category).toBe("production");
    expect(venueRow.plannedCents).toBe(48000);
    expect(venueRow.actualCents).toBe(47250);
    expect(summary.plannedCents).toBe(53000);
    expect(summary.actualCents).toBe(47250);

    // Clear the actual back out with the null sentinel.
    await s.as.mutation(api.budget.updateLineItem, {
      lineItemId: venue,
      actualCents: null,
    });
    summary = await s.as.query(api.budget.budgetSummary, { eventId });
    expect(
      summary.lineItems.find((l) => l._id === venue)!.actualCents,
    ).toBeUndefined();
    expect(summary.actualCents).toBe(0);

    // Remove the venue line.
    await s.as.mutation(api.budget.removeLineItem, { lineItemId: venue });
    summary = await s.as.query(api.budget.budgetSummary, { eventId });
    expect(summary.lineItems).toHaveLength(1);
    expect(summary.plannedCents).toBe(5000);
  });

  test("budgetSummary reconciles income = revenue + donations, net = income − actual", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    await seedIncome(s, eventId, 30000, 12000); // revenue 300, donations 120

    await s.as.mutation(api.budget.addLineItem, {
      eventId,
      label: "Catering",
      category: "food",
      plannedCents: 20000,
    });
    await s.as.mutation(api.budget.addLineItem, {
      eventId,
      label: "Permit fee",
      category: "permits",
      plannedCents: 10000,
    });
    // Two actuals: 180 + 60 = 240.
    const rows = (await s.as.query(api.budget.budgetSummary, { eventId }))
      .lineItems;
    await s.as.mutation(api.budget.updateLineItem, {
      lineItemId: rows[0]._id,
      actualCents: 18000,
    });
    await s.as.mutation(api.budget.updateLineItem, {
      lineItemId: rows[1]._id,
      actualCents: 6000,
    });

    const summary = await s.as.query(api.budget.budgetSummary, { eventId });
    expect(summary.plannedCents).toBe(30000);
    expect(summary.actualCents).toBe(24000);
    expect(summary.incomeCents).toBe(42000); // 30000 + 12000
    expect(summary.netCents).toBe(18000); // 42000 − 24000
  });

  test("summary with no line items is zeros but still reads income", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    await seedIncome(s, eventId, 7500, 0);

    const summary = await s.as.query(api.budget.budgetSummary, { eventId });
    expect(summary.lineItems).toHaveLength(0);
    expect(summary.plannedCents).toBe(0);
    expect(summary.actualCents).toBe(0);
    expect(summary.incomeCents).toBe(7500);
    expect(summary.netCents).toBe(7500);
  });

  test("setReceipt attaches a storageId (resolved to a URL) and clears with null", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    const lineItemId = (await s.as.mutation(api.budget.addLineItem, {
      eventId,
      label: "Transport",
      category: "transport",
      plannedCents: 8000,
    })) as Id<"budgetLineItems">;

    const storageId = await storeBlob(t);
    await s.as.mutation(api.budget.setReceipt, {
      lineItemId,
      receiptStorageId: storageId,
    });
    let row = (await s.as.query(api.budget.budgetSummary, { eventId }))
      .lineItems[0];
    expect(row.receiptStorageId).toBe(storageId);
    expect(row.receiptUrl).toBeTruthy();

    await s.as.mutation(api.budget.setReceipt, {
      lineItemId,
      receiptStorageId: null,
    });
    row = (await s.as.query(api.budget.budgetSummary, { eventId }))
      .lineItems[0];
    expect(row.receiptStorageId).toBeUndefined();
    expect(row.receiptUrl).toBeNull();
  });
});

describe("cents validation", () => {
  test("addLineItem rejects negative / non-integer / missing-label planned", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);

    await expect(
      s.as.mutation(api.budget.addLineItem, {
        eventId,
        label: "Bad",
        category: "other",
        plannedCents: -100,
      }),
    ).rejects.toThrow();
    await expect(
      s.as.mutation(api.budget.addLineItem, {
        eventId,
        label: "Bad",
        category: "other",
        plannedCents: 12.5,
      }),
    ).rejects.toThrow();
    await expect(
      s.as.mutation(api.budget.addLineItem, {
        eventId,
        label: "   ",
        category: "other",
        plannedCents: 100,
      }),
    ).rejects.toThrow();

    // Zero IS allowed (a freebie held on the plan).
    await s.as.mutation(api.budget.addLineItem, {
      eventId,
      label: "Donated PA",
      category: "production",
      plannedCents: 0,
    });
    const summary = await s.as.query(api.budget.budgetSummary, { eventId });
    expect(summary.lineItems).toHaveLength(1);
    expect(summary.plannedCents).toBe(0);
  });

  test("updateLineItem rejects negative / non-integer planned + actual", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    const lineItemId = (await s.as.mutation(api.budget.addLineItem, {
      eventId,
      label: "Line",
      category: "other",
      plannedCents: 1000,
    })) as Id<"budgetLineItems">;

    await expect(
      s.as.mutation(api.budget.updateLineItem, { lineItemId, actualCents: -1 }),
    ).rejects.toThrow();
    await expect(
      s.as.mutation(api.budget.updateLineItem, { lineItemId, actualCents: 9.9 }),
    ).rejects.toThrow();
    await expect(
      s.as.mutation(api.budget.updateLineItem, {
        lineItemId,
        plannedCents: -5,
      }),
    ).rejects.toThrow();
    // The line stayed unchanged.
    const summary = await s.as.query(api.budget.budgetSummary, { eventId });
    expect(summary.plannedCents).toBe(1000);
    expect(summary.actualCents).toBe(0);
  });
});

describe("access gating", () => {
  test("rejects a non-member, a cross-chapter admin, and an unauthenticated caller", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    const lineItemId = (await s.as.mutation(api.budget.addLineItem, {
      eventId,
      label: "Line",
      category: "other",
      plannedCents: 1000,
    })) as Id<"budgetLineItems">;

    // A different chapter's admin can't read or write this event's budget.
    const other = await setupChapter(t, {
      email: "outsider@publicworship.life",
      chapterName: "Boston",
    });
    await expect(
      other.as.query(api.budget.budgetSummary, { eventId }),
    ).rejects.toThrow();
    await expect(
      other.as.mutation(api.budget.addLineItem, {
        eventId,
        label: "Sneaky",
        category: "other",
        plannedCents: 100,
      }),
    ).rejects.toThrow();
    await expect(
      other.as.mutation(api.budget.updateLineItem, {
        lineItemId,
        actualCents: 500,
      }),
    ).rejects.toThrow();
    await expect(
      other.as.mutation(api.budget.removeLineItem, { lineItemId }),
    ).rejects.toThrow();

    // Unauthenticated is rejected too.
    await expect(
      t.query(api.budget.budgetSummary, { eventId }),
    ).rejects.toThrow();
    await expect(
      t.mutation(api.budget.addLineItem, {
        eventId,
        label: "Anon",
        category: "other",
        plannedCents: 100,
      }),
    ).rejects.toThrow();

    // The line item is still intact and untouched.
    const summary = await s.as.query(api.budget.budgetSummary, { eventId });
    expect(summary.lineItems).toHaveLength(1);
    expect(summary.lineItems[0].actualCents).toBeUndefined();
  });
});
