/**
 * The leads inbox's weekly recruiting digest counts only this week's rows.
 */
import { describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import { newT, run } from "./setup.helpers";

const DAY = 24 * 60 * 60 * 1000;

async function seed(t: ReturnType<typeof newT>, now: number) {
  await run(t, async (ctx) => {
    for (const [createdAt, areas] of [
      [now - 1 * DAY, ["setup", "welcome"]],
      [now - 3 * DAY, ["setup"]],
      [now - 9 * DAY, ["setup"]], // last week — not counted
    ] as const) {
      await ctx.db.insert("volunteerSignups", {
        name: "V",
        email: `v${createdAt}@example.com`,
        areas: [...areas],
        stage: "new",
        stageChangedAt: createdAt,
        createdAt,
        updatedAt: createdAt,
      });
    }
    await ctx.db.insert("jobApplications", {
      roleSlug: "people-director",
      roleTitle: "People Director",
      name: "A",
      email: "a@example.com",
      answers: {},
      stage: "applied",
      stageChangedAt: now - 2 * DAY,
      source: "public_call",
      createdAt: now - 2 * DAY,
      updatedAt: now - 2 * DAY,
    });
  });
}

describe("recruiting digest", () => {
  test("counts the last seven days, grouped by area and role", async () => {
    const t = newT();
    const now = Date.now();
    await seed(t, now);
    const summary = await t.query(internal.recruitingDigest.weekSummary, {
      since: now - 7 * DAY,
    });
    expect(summary.volunteers).toBe(2);
    expect(summary.applications).toBe(1);
    expect(summary.capped).toBe(false);
    expect(summary.byRole).toEqual([{ label: "People Director", count: 1 }]);
    expect(summary.byArea[0]).toEqual({ label: "Setup & breakdown", count: 2 });
    expect(summary.byArea).toHaveLength(2);
  });
});
