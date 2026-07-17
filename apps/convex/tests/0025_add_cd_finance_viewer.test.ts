/**
 * Test suite for migration 0025: patching the live `chapter_director`
 * `seatDefs` row to add `finance.viewer` (owner decision, 2026-07-16 — CD
 * sees chapter spending, but reconcile/record stays the Treasurer's job).
 *
 * `seatDefs` is a GLOBAL chart — `runSeedSeatDefs` (0022) seeds exactly one
 * row per `SEAT_IDS` entry, not one per chapter. As of THIS PR the shared
 * template (`SEAT_DEFS.chapter_director`) already carries `finance.viewer`,
 * so a FRESH `0022` seed (a brand-new deploy, or any org/chapter stamped
 * after this ships) already has it — 0025 is a no-op there. The migration
 * exists for the row that's ALREADY LIVE from before this PR: `0022` only
 * inserts a `chapter_director` row if `by_slug` finds none, so a pre-existing
 * live row is never re-seeded from the updated template and needs this
 * explicit backfill. Tests below simulate that "pre-PR" live row by
 * inserting it directly with the OLD capability set, rather than going
 * through `runSeedSeatDefs` (which would already include `finance.viewer`).
 */
import { describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import { newT, run } from "./setup.helpers";
import { runSeedSeatDefs } from "../migrations/0022_seed_seat_defs";
import { runAddCdFinanceViewer } from "../migrations/0025_add_cd_finance_viewer";

async function chapterDirectorDef(t: ReturnType<typeof newT>) {
  return run(t, (ctx) =>
    ctx.db
      .query("seatDefs")
      .withIndex("by_slug", (q) => q.eq("slug", "chapter_director"))
      .unique(),
  );
}

/** Insert the `chapter_director` row exactly as it exists in a LIVE deploy
 *  seeded BEFORE this PR (capabilities from the old template, no
 *  `finance.viewer`) — bypassing `runSeedSeatDefs` so this stays independent
 *  of the (now-updated) shared template. */
async function seedPrePrChapterDirectorRow(t: ReturnType<typeof newT>) {
  const now = Date.now();
  return run(t, (ctx) =>
    ctx.db.insert("seatDefs", {
      slug: "chapter_director",
      title: "Chapter Director",
      chart: "chapter",
      parentSlug: "root",
      maxHolders: 1,
      duties: [
        "Run the chapter day-to-day",
        "Own chapter budget approval",
        "Report up to central",
      ],
      capabilities: ["finance.approve", "nav.finances"],
      sortOrder: 18,
      legacyTitle: "president",
      createdAt: now,
      updatedAt: now,
    }),
  );
}

describe("0025_add_cd_finance_viewer", () => {
  test("adds finance.viewer to a pre-PR live chapter_director row, preserving its other capabilities", async () => {
    const t = newT();
    await seedPrePrChapterDirectorRow(t);

    const before = await chapterDirectorDef(t);
    expect(before?.capabilities).toEqual(["finance.approve", "nav.finances"]);

    const result = await run(t, (ctx) => runAddCdFinanceViewer(ctx));
    expect(result).toEqual({ patched: 1, skipped: 0 });

    const after = await chapterDirectorDef(t);
    expect(after?.capabilities).toEqual([
      "finance.approve",
      "nav.finances",
      "finance.viewer",
    ]);
    expect(after?.updatedAt).toBeTypeOf("number");
  });

  test("idempotent: a second run patches nothing", async () => {
    const t = newT();
    await seedPrePrChapterDirectorRow(t);
    await run(t, (ctx) => runAddCdFinanceViewer(ctx));

    const second = await run(t, (ctx) => runAddCdFinanceViewer(ctx));
    expect(second).toEqual({ patched: 0, skipped: 1 });

    const after = await chapterDirectorDef(t);
    expect(after?.capabilities).toEqual([
      "finance.approve",
      "nav.finances",
      "finance.viewer",
    ]);
  });

  test("a fresh 0022 seed (post-PR template) already carries finance.viewer, so 0025 is a no-op", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));

    const seeded = await chapterDirectorDef(t);
    expect(seeded?.capabilities).toEqual([
      "finance.approve",
      "finance.viewer",
      "nav.finances",
    ]);

    const result = await run(t, (ctx) => runAddCdFinanceViewer(ctx));
    expect(result).toEqual({ patched: 0, skipped: 1 });
  });

  test("never touches any other seat — treasurer's record/reconcile-write side stays exactly as-is", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));

    const treasurerBefore = await run(t, (ctx) =>
      ctx.db
        .query("seatDefs")
        .withIndex("by_slug", (q) => q.eq("slug", "treasurer"))
        .unique(),
    );

    await run(t, (ctx) => runAddCdFinanceViewer(ctx));

    const treasurerAfter = await run(t, (ctx) =>
      ctx.db
        .query("seatDefs")
        .withIndex("by_slug", (q) => q.eq("slug", "treasurer"))
        .unique(),
    );
    expect(treasurerAfter?.capabilities).toEqual(treasurerBefore?.capabilities);
    expect(treasurerAfter?.updatedAt).toBe(treasurerBefore?.updatedAt);
  });

  test("no-op (not a throw) if run before any seatDefs row exists", async () => {
    const t = newT();
    const result = await run(t, (ctx) => runAddCdFinanceViewer(ctx));
    expect(result).toEqual({ patched: 0, skipped: 0 });
  });

  test("via the real runPending registry (fresh DB, post-PR template): chapter_director ends up with finance.viewer", async () => {
    const t = newT();
    await t.mutation(internal.migrations.runPending, {});

    const def = await chapterDirectorDef(t);
    expect(def?.capabilities).toEqual([
      "finance.approve",
      "finance.viewer",
      "nav.finances",
    ]);
  });
});
