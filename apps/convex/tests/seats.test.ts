import { describe, expect, test } from "vitest";
import { SEAT_IDS, SEAT_DEFS } from "@events-os/shared";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { newT, run, setupChapter } from "./setup.helpers";
import { runSeedSeatDefs } from "../migrations/0022_seed_seat_defs";

/**
 * Org chart (seats) — schema seed + read queries.
 *
 *  - `runSeedSeatDefs` (migration 0022): idempotent, edit-preserving seed.
 *  - `seats.chart`: central / chapter / full-tree reads, all-vacant post-seed,
 *    per-scope holder resolution, derived `chapter_directors` rollup.
 *  - `seats.mySeatAssignments`: the caller's own assignments across their
 *    roster rows.
 */

const CENTRAL_COUNT = SEAT_IDS.filter((id) => SEAT_DEFS[id].chart === "central")
  .length;
const CHAPTER_COUNT = SEAT_IDS.filter((id) => SEAT_DEFS[id].chart === "chapter")
  .length;

describe("0022_seed_seat_defs", () => {
  test("seeds every template seat exactly once", async () => {
    const t = newT();
    const res = await run(t, (ctx) => runSeedSeatDefs(ctx));
    expect(res.inserted).toBe(SEAT_IDS.length);
    expect(res.skipped).toBe(0);

    const rows = await run(t, (ctx) => ctx.db.query("seatDefs").collect());
    expect(rows).toHaveLength(SEAT_IDS.length);
    expect(new Set(rows.map((r) => r.slug)).size).toBe(SEAT_IDS.length);
  });

  test("is idempotent: a second run inserts nothing", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));
    const res2 = await run(t, (ctx) => runSeedSeatDefs(ctx));
    expect(res2.inserted).toBe(0);
    expect(res2.skipped).toBe(SEAT_IDS.length);

    const rows = await run(t, (ctx) => ctx.db.query("seatDefs").collect());
    expect(rows).toHaveLength(SEAT_IDS.length);
  });

  test("a re-run never overwrites a runtime edit to an existing row", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));

    const edited = await run(t, async (ctx) => {
      const row = await ctx.db
        .query("seatDefs")
        .withIndex("by_slug", (q) => q.eq("slug", "treasurer"))
        .unique();
      if (!row) throw new Error("treasurer not seeded");
      await ctx.db.patch(row._id, {
        title: "Chief Money Officer",
        duties: ["A custom runtime duty"],
        updatedAt: Date.now(),
      });
      return row._id;
    });

    await run(t, (ctx) => runSeedSeatDefs(ctx));

    const row = await run(t, (ctx) => ctx.db.get(edited));
    expect(row?.title).toBe("Chief Money Officer");
    expect(row?.duties).toEqual(["A custom runtime duty"]);
  });
});

describe("seats.chart", () => {
  test("central scope returns all 18 central defs, all vacant", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));
    const s = await setupChapter(t);

    const result = await s.as.query(api.seats.chart, { scope: "central" });
    expect(result.kind).toBe("central");
    if (result.kind !== "central") throw new Error("expected central");
    expect(result.seats).toHaveLength(CENTRAL_COUNT);
    expect(CENTRAL_COUNT).toBe(18);
    expect(result.seats.every((n) => n.vacant)).toBe(true);
    expect(result.seats.every((n) => n.holders.length === 0)).toBe(true);
    // Sorted by declaration order.
    expect(result.seats[0]!.slug).toBe("executive_director");
  });

  test("a chapter scope returns all 9 chapter defs, all vacant", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));
    const s = await setupChapter(t);

    const result = await s.as.query(api.seats.chart, { scope: s.chapterId });
    expect(result.kind).toBe("chapter");
    if (result.kind !== "chapter") throw new Error("expected chapter");
    expect(result.chapterName).toBe("New York"); // setupChapter's default name
    expect(result.seats).toHaveLength(CHAPTER_COUNT);
    expect(CHAPTER_COUNT).toBe(9);
    expect(result.seats.every((n) => n.vacant)).toBe(true);
  });

  test("no scope returns the full tree: central + every chapter's subtree", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));
    const s = await setupChapter(t, { chapterName: "New York" });
    await run(t, (ctx) =>
      ctx.db.insert("chapters", {
        name: "Chicago",
        isActive: true,
        createdAt: Date.now(),
      }),
    );

    const result = await s.as.query(api.seats.chart, {});
    expect(result.kind).toBe("full");
    if (result.kind !== "full") throw new Error("expected full");
    expect(result.central).toHaveLength(CENTRAL_COUNT);
    expect(result.chapters).toHaveLength(2);
    expect(result.chapters.map((c) => c.chapterName)).toEqual([
      "Chicago",
      "New York",
    ]);
    for (const c of result.chapters) {
      expect(c.seats).toHaveLength(CHAPTER_COUNT);
    }
  });

  test("resolves a directly-assigned holder at its own scope only", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));
    const s = await setupChapter(t);
    const otherChapterId = await run(t, (ctx) =>
      ctx.db.insert("chapters", {
        name: "Chicago",
        isActive: true,
        createdAt: Date.now(),
      }),
    );

    const { treasurerDefId, personId } = await run(t, async (ctx) => {
      const treasurerDef = await ctx.db
        .query("seatDefs")
        .withIndex("by_slug", (q) => q.eq("slug", "treasurer"))
        .unique();
      if (!treasurerDef) throw new Error("treasurer not seeded");
      const personId = await ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Jordan Treasurer",
        userId: s.userId,
        createdAt: Date.now(),
      });
      await ctx.db.insert("seatAssignments", {
        seatDefId: treasurerDef._id,
        scope: s.chapterId,
        personId,
        createdAt: Date.now(),
      });
      return { treasurerDefId: treasurerDef._id, personId };
    });

    const home = await s.as.query(api.seats.chart, { scope: s.chapterId });
    if (home.kind !== "chapter") throw new Error("expected chapter");
    const treasurerNode = home.seats.find((n) => n.slug === "treasurer")!;
    expect(treasurerNode.vacant).toBe(false);
    expect(treasurerNode.holders).toHaveLength(1);
    expect(treasurerNode.holders[0]!.personId).toBe(personId);
    expect(treasurerNode.holders[0]!.name).toBe("Jordan Treasurer");

    // The SAME shared seat def, read at a DIFFERENT chapter's scope, is vacant.
    const other = await s.as.query(api.seats.chart, { scope: otherChapterId });
    if (other.kind !== "chapter") throw new Error("expected chapter");
    const otherTreasurer = other.seats.find((n) => n.slug === "treasurer")!;
    expect(otherTreasurer.defId).toBe(treasurerDefId);
    expect(otherTreasurer.vacant).toBe(true);

    // seatDetail agrees.
    const detail = await s.as.query(api.seats.seatDetail, {
      defId: treasurerDefId,
      scope: s.chapterId,
    });
    expect(detail?.holders).toHaveLength(1);
    expect(detail?.holders[0]!.personId).toBe(personId);
  });

  test("the derived chapter_directors seat aggregates across two chapters", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));
    const s = await setupChapter(t, { chapterName: "New York" });
    const chicagoId = await run(t, (ctx) =>
      ctx.db.insert("chapters", {
        name: "Chicago",
        isActive: true,
        createdAt: Date.now(),
      }),
    );

    await run(t, async (ctx) => {
      const chapterDirectorDef = await ctx.db
        .query("seatDefs")
        .withIndex("by_slug", (q) => q.eq("slug", "chapter_director"))
        .unique();
      if (!chapterDirectorDef) throw new Error("chapter_director not seeded");

      const nyPersonId = await ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Nia NY",
        createdAt: Date.now(),
      });
      await ctx.db.insert("seatAssignments", {
        seatDefId: chapterDirectorDef._id,
        scope: s.chapterId,
        personId: nyPersonId,
        createdAt: Date.now(),
      });

      const chiPersonId = await ctx.db.insert("people", {
        chapterId: chicagoId,
        name: "Cole Chicago",
        createdAt: Date.now(),
      });
      await ctx.db.insert("seatAssignments", {
        seatDefId: chapterDirectorDef._id,
        scope: chicagoId,
        personId: chiPersonId,
        createdAt: Date.now(),
      });
    });

    const central = await s.as.query(api.seats.chart, { scope: "central" });
    if (central.kind !== "central") throw new Error("expected central");
    const derivedNode = central.seats.find((n) => n.slug === "chapter_directors")!;
    expect(derivedNode.derived).toBe(true);
    expect(derivedNode.vacant).toBe(false);
    expect(derivedNode.holders).toHaveLength(2);
    const names = derivedNode.holders.map((h) => h.name).sort();
    expect(names).toEqual(["Cole Chicago (Chicago)", "Nia NY (New York)"]);

    // seatDetail on the derived seat aggregates the same way regardless of
    // the (ignored) scope argument.
    const detail = await s.as.query(api.seats.seatDetail, {
      defId: derivedNode.defId,
      scope: "central",
    });
    expect(detail?.holders).toHaveLength(2);
  });

  test("a placeholder person never counts as a holder", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));
    const s = await setupChapter(t);

    await run(t, async (ctx) => {
      const def = await ctx.db
        .query("seatDefs")
        .withIndex("by_slug", (q) => q.eq("slug", "event_lead"))
        .unique();
      if (!def) throw new Error("event_lead not seeded");
      const placeholderId = await ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Placeholder Person",
        isPlaceholder: true,
        createdAt: Date.now(),
      });
      await ctx.db.insert("seatAssignments", {
        seatDefId: def._id,
        scope: s.chapterId,
        personId: placeholderId,
        createdAt: Date.now(),
      });
    });

    const result = await s.as.query(api.seats.chart, { scope: s.chapterId });
    if (result.kind !== "chapter") throw new Error("expected chapter");
    const node = result.seats.find((n) => n.slug === "event_lead")!;
    expect(node.vacant).toBe(true);
    expect(node.holders).toHaveLength(0);
  });
});

describe("seats.mySeatAssignments", () => {
  test("returns the caller's assignments across their roster rows", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));
    const s = await setupChapter(t);

    const { musicLeadDefId, personId } = await run(t, async (ctx) => {
      const musicLeadDef = await ctx.db
        .query("seatDefs")
        .withIndex("by_slug", (q) => q.eq("slug", "music_lead"))
        .unique();
      if (!musicLeadDef) throw new Error("music_lead not seeded");
      const personId = await ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Sam Self",
        userId: s.userId,
        createdAt: Date.now(),
      });
      await ctx.db.insert("seatAssignments", {
        seatDefId: musicLeadDef._id,
        scope: s.chapterId,
        personId,
        createdAt: Date.now(),
      });
      return { musicLeadDefId: musicLeadDef._id, personId };
    });

    const mine = await s.as.query(api.seats.mySeatAssignments, {});
    expect(mine).toHaveLength(1);
    expect(mine[0]!.seatDefId).toBe(musicLeadDefId);
    expect(mine[0]!.slug).toBe("music_lead");
    expect(mine[0]!.scope).toBe(s.chapterId);
    expect(mine[0]!.scopeName).toBe("New York");
    void personId;
  });

  test("returns nothing for a caller with no roster row", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));
    const s = await setupChapter(t);

    const mine = await s.as.query(api.seats.mySeatAssignments, {});
    expect(mine).toEqual([]);
  });
});
