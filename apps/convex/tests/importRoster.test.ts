import { describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import { newT, run, setupChapter } from "./setup.helpers";

/**
 * Characterization test for `seed:importRoster` matching semantics: it adopts
 * an existing `people` row ONLY by strong identity (phone last-10, or
 * email/pwEmail) — NEVER by a case-folded name. A pre-seeded person whose NAME
 * collides with a roster entry, but whose phone/email do NOT, must be left
 * untouched, and the roster entry inserted as a separate new row.
 *
 * "AJ" is a real CORE_TEAM entry (email aj@publicworship.life, phone
 * +19174981017). We pre-seed a different person also named "AJ".
 */
describe("seed.importRoster name-match guard", () => {
  test("does NOT merge a roster entry into a same-named row with different identity", async () => {
    const t = newT();
    // setupChapter creates a chapter; importRoster matches a chapter named
    // "The New York Chapter" first, else falls back to the first chapter.
    const { userId } = await setupChapter(t, {
      chapterName: "The New York Chapter",
    });

    // Pre-seed a DIFFERENT person who happens to share the name "AJ".
    const decoyId = await run(t, async (ctx) => {
      const chapter = await ctx.db
        .query("chapters")
        .withIndex("by_name", (q) => q.eq("name", "The New York Chapter"))
        .first();
      return await ctx.db.insert("people", {
        chapterId: chapter!._id,
        name: "AJ",
        email: "different-aj@example.com",
        phone: "+15555550000",
        createdAt: Date.now(),
      });
    });

    await t.mutation(internal.seed.importRoster, {});

    // The decoy row is UNTOUCHED — its distinct phone/email survive (no
    // name-merge overwrote it with the roster "AJ").
    const decoy = await run(t, (ctx) => ctx.db.get(decoyId));
    expect(decoy!.email).toBe("different-aj@example.com");
    expect(decoy!.phone).toBe("+15555550000");

    // The roster "AJ" was inserted as a SEPARATE row (matched by its own
    // identity, not the decoy's name).
    const ajRows = await run(t, async (ctx) => {
      const chapter = await ctx.db
        .query("chapters")
        .withIndex("by_name", (q) => q.eq("name", "The New York Chapter"))
        .first();
      const all = await ctx.db
        .query("people")
        .withIndex("by_chapter", (q) => q.eq("chapterId", chapter!._id))
        .collect();
      return all.filter((p) => p.name === "AJ");
    });
    expect(ajRows.length).toBe(2);
    expect(
      ajRows.some((p) => p.email === "aj@publicworship.life"),
    ).toBe(true);
  });
});
