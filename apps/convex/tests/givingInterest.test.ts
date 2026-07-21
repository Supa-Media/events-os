import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { api } from "../_generated/api";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { runSeedSeatDefs } from "../migrations/0022_seed_seat_defs";
import type { Id } from "../_generated/dataModel";

/**
 * Interest capture + suggest-a-space (`schema/givingInterest.ts` +
 * `givingInterest.ts`) — the `/give` redesign's lead-capture inbox:
 *  - `submitInterest` (public, no auth) rejects an all-empty submission and
 *    accepts a valid one;
 *  - `publicInterestStats` counts correctly and returns no PII;
 *  - `listInterest` requires central `giving.view` and returns full rows for a
 *    seated dev director;
 *  - `setInterestStatus` updates status + stamps the actor, and requires
 *    central `giving.manage`.
 */

/** Copied from `territories.test.ts`'s convention: link a `people` row to the
 *  caller's user + seat them (requires seeded seatDefs). */
async function seatCaller(
  s: ChapterSetup,
  slug: string,
  scope: Id<"chapters"> | "central",
): Promise<void> {
  await run(s.t, async (ctx) => {
    const personId = await ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Seated Caller",
      userId: s.userId,
      createdAt: Date.now(),
    });
    const def = await ctx.db
      .query("seatDefs")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .unique();
    if (!def) throw new Error(`${slug} not seeded`);
    await ctx.db.insert("seatAssignments", {
      seatDefId: def._id,
      scope,
      personId,
      createdAt: Date.now(),
    });
  });
}

/** A chapter with the caller seated as development director at central (full
 *  `giving.manage`/`giving.view` over central) — copied from
 *  `territories.test.ts`. */
async function devDirectorSetup(): Promise<ChapterSetup> {
  const t = newT();
  await run(t, (ctx) => runSeedSeatDefs(ctx));
  const s = await setupChapter(t);
  await seatCaller(s, "development_director", "central");
  return s;
}

// ── submitInterest ───────────────────────────────────────────────────────────

describe("submitInterest", () => {
  test("rejects an all-empty submission", async () => {
    const t = newT();
    await expect(
      t.mutation(api.givingInterest.submitInterest, {
        kind: "want_in_city",
      }),
    ).rejects.toBeInstanceOf(ConvexError);

    // Whitespace-only fields count as empty too.
    await expect(
      t.mutation(api.givingInterest.submitInterest, {
        kind: "volunteer",
        name: "   ",
        email: "  ",
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("accepts a valid submission with just one field set", async () => {
    const t = newT();
    await t.mutation(api.givingInterest.submitInterest, {
      kind: "want_in_city",
      email: "fan@example.com",
    });
    const row = await run(t, (ctx) => ctx.db.query("givingInterest").first());
    expect(row?.kind).toBe("want_in_city");
    expect(row?.email).toBe("fan@example.com");
    expect(row?.status).toBe("new");
    expect(typeof row?.createdAt).toBe("number");
    expect(row?.name).toBeUndefined();
  });

  test("accepts every kind, trims fields, and caps message/location length", async () => {
    const t = newT();
    await t.mutation(api.givingInterest.submitInterest, {
      kind: "suggest_space",
      name: "  Jamie  ",
      location: "  Queens, NY  ",
      message: "  We have a backyard that fits 40  ",
      territorySlug: "queens-ny",
    });
    const row = await run(t, (ctx) => ctx.db.query("givingInterest").first());
    expect(row?.name).toBe("Jamie");
    expect(row?.location).toBe("Queens, NY");
    expect(row?.message).toBe("We have a backyard that fits 40");
    expect(row?.territorySlug).toBe("queens-ny");

    await expect(
      t.mutation(api.givingInterest.submitInterest, {
        kind: "fund",
        message: "x".repeat(2001),
      }),
    ).rejects.toBeInstanceOf(ConvexError);
    await expect(
      t.mutation(api.givingInterest.submitInterest, {
        kind: "join_team",
        location: "x".repeat(201),
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });
});

// ── publicInterestStats ──────────────────────────────────────────────────────

describe("publicInterestStats", () => {
  test("counts correctly and returns no PII", async () => {
    const t = newT();
    await t.mutation(api.givingInterest.submitInterest, {
      kind: "want_in_city",
      email: "a@example.com",
    });
    await t.mutation(api.givingInterest.submitInterest, {
      kind: "want_in_city",
      email: "b@example.com",
    });
    await t.mutation(api.givingInterest.submitInterest, {
      kind: "volunteer",
      name: "Volunteer Vera",
    });

    const stats = await t.query(api.givingInterest.publicInterestStats, {});
    expect(stats).toEqual({ total: 3, wantInCity: 2 });
    expect(Object.keys(stats).sort()).toEqual(["total", "wantInCity"].sort());
  });

  test("returns zeros with no submissions", async () => {
    const t = newT();
    expect(await t.query(api.givingInterest.publicInterestStats, {})).toEqual({
      total: 0,
      wantInCity: 0,
    });
  });
});

// ── listInterest ─────────────────────────────────────────────────────────────

describe("listInterest", () => {
  test("an un-seated caller is rejected", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));
    const s = await setupChapter(t);
    await expect(
      s.as.query(api.givingInterest.listInterest, {}),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("a chapter-scope giving seat isn't enough — central only", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));
    const s = await setupChapter(t);
    await seatCaller(s, "chapter_director", s.chapterId);
    await expect(
      s.as.query(api.givingInterest.listInterest, {}),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("a seated dev director sees full rows, newest first", async () => {
    const s = await devDirectorSetup();
    await s.t.mutation(api.givingInterest.submitInterest, {
      kind: "want_in_city",
      email: "first@example.com",
    });
    await s.t.mutation(api.givingInterest.submitInterest, {
      kind: "suggest_space",
      name: "Second Person",
      location: "Columbus, OH",
      message: "We have a hall",
    });

    const rows = await s.as.query(api.givingInterest.listInterest, {});
    expect(rows).toHaveLength(2);
    // Newest first.
    expect(rows[0].name).toBe("Second Person");
    expect(rows[0].location).toBe("Columbus, OH");
    expect(rows[0].message).toBe("We have a hall");
    expect(rows[0].status).toBe("new");
    expect(rows[1].email).toBe("first@example.com");
  });
});

// ── setInterestStatus ────────────────────────────────────────────────────────

describe("setInterestStatus", () => {
  test("updates status + stamps handledAt/handledBy; requires giving.manage", async () => {
    const s = await devDirectorSetup();
    await s.t.mutation(api.givingInterest.submitInterest, {
      kind: "volunteer",
      email: "vol@example.com",
    });
    const row = await run(s.t, (ctx) => ctx.db.query("givingInterest").first());
    expect(row?.status).toBe("new");

    await s.as.mutation(api.givingInterest.setInterestStatus, {
      id: row!._id,
      status: "contacted",
    });
    const updated = await run(s.t, (ctx) => ctx.db.get(row!._id));
    expect(updated?.status).toBe("contacted");
    expect(typeof updated?.handledAt).toBe("number");
    expect(updated?.handledBy).toBe(s.userId);

    await s.as.mutation(api.givingInterest.setInterestStatus, {
      id: row!._id,
      status: "archived",
    });
    expect((await run(s.t, (ctx) => ctx.db.get(row!._id)))?.status).toBe(
      "archived",
    );
  });

  test("a view-only (non-manage) caller is rejected", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));
    const s = await setupChapter(t);
    await t.mutation(api.givingInterest.submitInterest, {
      kind: "fund",
      email: "f@example.com",
    });
    const row = await run(t, (ctx) => ctx.db.query("givingInterest").first());
    await expect(
      s.as.mutation(api.givingInterest.setInterestStatus, {
        id: row!._id,
        status: "contacted",
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });
});
