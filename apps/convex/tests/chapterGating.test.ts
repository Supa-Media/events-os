/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api } from "../_generated/api";
import { runSeedSeatDefs } from "../migrations/0022_seed_seat_defs";
import type { Id } from "../_generated/dataModel";

/**
 * Territories P1: `isActive` gate for chapter-fleet enumerators.
 *
 * Prospect territories will soon pre-create "shadow" `chapters` rows
 * (`isActive: false`) before a city actually launches. This suite verifies
 * the ONE rule this PR enforces — "wherever chapters are queried we only
 * check isActive = true" — across the enumerators that list every chapter
 * for a fleet-wide surface: `financeRoles.listChaptersForPeek`,
 * `seats.chart` (full tree), `finances.dashboardCentral`,
 * `dashboardCharts.chapterHealth`, and `transfers.interScopeBalances`.
 *
 * Also asserts the house `isActive !== false` convention: a chapter with NO
 * `isActive` field at all (absent, not `false`) still counts as active — the
 * same convention `lib/chapters.ts#listActiveChapters` implements.
 */

async function makeChapter(
  s: ChapterSetup,
  name: string,
  isActive: boolean | undefined,
): Promise<Id<"chapters">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("chapters", {
      name,
      isActive,
      createdAt: Date.now(),
    }),
  );
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

/** A genuine central-scope finance manager (not the superuser short-circuit). */
async function asCentralManager(s: ChapterSetup): Promise<Id<"people">> {
  const personId = await seedSelfPerson(s);
  await run(s.t, (ctx) =>
    ctx.db.insert("financeRoles", {
      chapterId: s.chapterId,
      personId,
      role: "manager",
      scope: "central",
      createdAt: Date.now(),
    }),
  );
  return personId;
}

describe("chapter-fleet enumerators exclude isActive: false shadow chapters", () => {
  test("financeRoles.listChaptersForPeek", async () => {
    const t = newT();
    const s = await setupChapter(t, {
      email: "seyi@publicworship.life",
      chapterName: "New York",
    });
    const shadow = await makeChapter(s, "Shadow City", false);
    const noField = await makeChapter(s, "Boston", undefined);

    const chapters = await s.as.query(api.financeRoles.listChaptersForPeek, {});
    const ids = chapters.map((c) => c.chapterId);

    expect(ids).not.toContain(shadow);
    expect(ids).toContain(noField); // isActive absent = active
    expect(ids).toContain(s.chapterId);
    expect(chapters.map((c) => c.name)).not.toContain("Shadow City");
  });

  test("seats.chart full-tree read", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));
    const s = await setupChapter(t, { chapterName: "New York" });
    await makeChapter(s, "Shadow City", false);
    const noField = await makeChapter(s, "Boston", undefined);

    const result = await s.as.query(api.seats.chart, {});
    if (result.kind !== "full") throw new Error("expected full");

    const names = result.chapters.map((c) => c.chapterName);
    expect(names).not.toContain("Shadow City");
    expect(names).toContain("New York");
    expect(names).toContain("Boston");
    expect(result.chapters.map((c) => c.chapterId)).toContain(noField);
  });

  test("finances.dashboardCentral chapterRollup", async () => {
    const t = newT();
    const s = await setupChapter(t, {
      email: "seyi@publicworship.life",
      chapterName: "New York",
    });
    const shadow = await makeChapter(s, "Shadow City", false);
    const noField = await makeChapter(s, "Boston", undefined);

    const dash = await s.as.query(api.finances.dashboardCentral, {});
    const ids = dash.chapterRollup.map((c) => c.chapterId);

    expect(ids).not.toContain(shadow);
    expect(ids).toContain(noField);
    expect(ids).toContain(s.chapterId);
  });

  test("dashboardCharts.chapterHealth", async () => {
    const t = newT();
    const s = await setupChapter(t, { chapterName: "New York" });
    await asCentralManager(s);
    const shadow = await makeChapter(s, "Shadow City", false);
    const noField = await makeChapter(s, "Boston", undefined);

    const rows = await s.as.query(api.dashboardCharts.chapterHealth, {});
    const ids = rows.map((r) => r.chapterId);

    expect(ids).not.toContain(shadow);
    expect(ids).toContain(noField);
    expect(ids).toContain(s.chapterId);
  });

  test("transfers.interScopeBalances", async () => {
    const t = newT();
    const s = await setupChapter(t, { chapterName: "New York" });
    await asCentralManager(s);
    const shadow = await makeChapter(s, "Shadow City", false);
    const noField = await makeChapter(s, "Boston", undefined);

    const balances = await s.as.query(api.transfers.interScopeBalances, {});
    const ids = balances.map((b) => b.chapterId);

    expect(ids).not.toContain(shadow);
    expect(ids).toContain(noField);
    expect(ids).toContain(s.chapterId);
  });
});
