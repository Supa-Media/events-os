import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { api } from "../_generated/api";
import { newT, run, setupChapter } from "./setup.helpers";
import {
  BLOG_REACTION_EMOJIS,
  countOf,
  emptyCounts,
  normalizeActorKey,
  normalizeSlug,
  tally,
} from "../lib/blogReactions";

/**
 * Blog reactions (the emoji bar under each post on publicworship.life):
 *  - the input rules in lib/blogReactions.ts — slug/actorKey/emoji are all
 *    bounded, because every one of them arrives from an anonymous stranger,
 *  - toggle semantics: a second tap removes the row rather than adding one,
 *    which is the whole reason an anonymous counter is survivable,
 *  - per-reader isolation: two browsers both count; one's un-react doesn't
 *    take the other's tap with it,
 *  - the staff gate (lib/blogAccess.ts) on the summary + clear functions.
 */

const ACTOR = "abcd1234efgh5678";
const OTHER_ACTOR = "zyxw9876vuts5432";
const SLUG = "doxological-worship";

// ── Input rules ──────────────────────────────────────────────────────────────

describe("normalizeSlug", () => {
  test("trims surrounding slashes and lowercases", () => {
    expect(normalizeSlug("/Doxological-Worship/")).toBe("doxological-worship");
  });

  test("allows one level of nesting", () => {
    expect(normalizeSlug("series/part-one")).toBe("series/part-one");
  });

  test.each(["", "   ", "../../etc/passwd", "has spaces", "a".repeat(129)])(
    "rejects %p",
    (bad) => {
      expect(() => normalizeSlug(bad)).toThrow(ConvexError);
    },
  );
});

describe("normalizeActorKey", () => {
  test("accepts a browser-minted id", () => {
    expect(normalizeActorKey(ACTOR)).toBe(ACTOR);
  });

  test.each(["short", "a".repeat(65), "has spaces", "emoji🙏key"])(
    "rejects %p",
    (bad) => {
      expect(() => normalizeActorKey(bad)).toThrow(ConvexError);
    },
  );
});

describe("tally", () => {
  test("zero-fills every allowlisted emoji, in display order, so the bar renders in full", () => {
    expect(tally([])).toEqual(emptyCounts());
    expect(tally([]).map((c) => c.emoji)).toEqual([...BLOG_REACTION_EMOJIS]);
  });

  test("ignores an emoji that is no longer on the allowlist", () => {
    // Retiring an emoji must not break a post that already has rows for it.
    const counts = tally([{ emoji: "🙏" }, { emoji: "🦄" }]);
    expect(countOf(counts, "🙏")).toBe(1);
    expect(counts.some((c) => c.emoji === "🦄")).toBe(false);
  });
});

// ── Public read + toggle ─────────────────────────────────────────────────────

describe("getReactions", () => {
  test("an untouched post returns zeroed counts and no reaction of mine", async () => {
    const t = newT();
    const state = await t.query(api.blog.getReactions, {
      slug: SLUG,
      actorKey: ACTOR,
    });
    expect(state.counts).toEqual(emptyCounts());
    expect(state.mine).toEqual([]);
    expect(state.emojis).toEqual([...BLOG_REACTION_EMOJIS]);
  });

  test("a junk actorKey still returns counts — a bad key must not blank the page", async () => {
    const t = newT();
    await t.mutation(api.blog.toggleReaction, {
      slug: SLUG,
      emoji: "🙏",
      actorKey: ACTOR,
    });
    const state = await t.query(api.blog.getReactions, {
      slug: SLUG,
      actorKey: "!!",
    });
    expect(countOf(state.counts, "🙏")).toBe(1);
    expect(state.mine).toEqual([]);
  });

  test("reactions are scoped to their own post", async () => {
    const t = newT();
    await t.mutation(api.blog.toggleReaction, {
      slug: SLUG,
      emoji: "🔥",
      actorKey: ACTOR,
    });
    const other = await t.query(api.blog.getReactions, {
      slug: "another-post",
      actorKey: ACTOR,
    });
    expect(countOf(other.counts, "🔥")).toBe(0);
  });
});

describe("toggleReaction", () => {
  test("first tap counts it and marks it mine", async () => {
    const t = newT();
    const state = await t.mutation(api.blog.toggleReaction, {
      slug: SLUG,
      emoji: "🙏",
      actorKey: ACTOR,
    });
    expect(countOf(state.counts, "🙏")).toBe(1);
    expect(state.mine).toEqual(["🙏"]);
  });

  test("second tap removes it — no double count, and the row is gone", async () => {
    const t = newT();
    await t.mutation(api.blog.toggleReaction, {
      slug: SLUG,
      emoji: "🙏",
      actorKey: ACTOR,
    });
    const state = await t.mutation(api.blog.toggleReaction, {
      slug: SLUG,
      emoji: "🙏",
      actorKey: ACTOR,
    });
    expect(countOf(state.counts, "🙏")).toBe(0);
    expect(state.mine).toEqual([]);
    const rows = await run(t, (ctx) => ctx.db.query("blogReactions").collect());
    expect(rows).toHaveLength(0);
  });

  test("one reader may leave several different emoji", async () => {
    const t = newT();
    for (const emoji of ["🙏", "❤️", "🔥"]) {
      await t.mutation(api.blog.toggleReaction, {
        slug: SLUG,
        emoji,
        actorKey: ACTOR,
      });
    }
    const state = await t.query(api.blog.getReactions, {
      slug: SLUG,
      actorKey: ACTOR,
    });
    expect(state.mine.sort()).toEqual(["❤️", "🔥", "🙏"].sort());
    expect(countOf(state.counts, "🙏")).toBe(1);
  });

  test("two readers both count, and one un-reacting leaves the other's tap", async () => {
    const t = newT();
    await t.mutation(api.blog.toggleReaction, {
      slug: SLUG,
      emoji: "🙌",
      actorKey: ACTOR,
    });
    await t.mutation(api.blog.toggleReaction, {
      slug: SLUG,
      emoji: "🙌",
      actorKey: OTHER_ACTOR,
    });
    let state = await t.query(api.blog.getReactions, { slug: SLUG });
    expect(countOf(state.counts, "🙌")).toBe(2);

    state = await t.mutation(api.blog.toggleReaction, {
      slug: SLUG,
      emoji: "🙌",
      actorKey: ACTOR,
    });
    expect(countOf(state.counts, "🙌")).toBe(1);
    expect(state.mine).toEqual([]);

    const theirs = await t.query(api.blog.getReactions, {
      slug: SLUG,
      actorKey: OTHER_ACTOR,
    });
    expect(theirs.mine).toEqual(["🙌"]);
  });

  test("an emoji off the allowlist is refused — nothing is written", async () => {
    const t = newT();
    await expect(
      t.mutation(api.blog.toggleReaction, {
        slug: SLUG,
        emoji: "💀",
        actorKey: ACTOR,
      }),
    ).rejects.toBeInstanceOf(ConvexError);
    const rows = await run(t, (ctx) => ctx.db.query("blogReactions").collect());
    expect(rows).toHaveLength(0);
  });

  test("an unbounded slug is refused — the table is not free storage", async () => {
    const t = newT();
    await expect(
      t.mutation(api.blog.toggleReaction, {
        slug: "x".repeat(200),
        emoji: "🙏",
        actorKey: ACTOR,
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });
});

// ── The staff gate ───────────────────────────────────────────────────────────

describe("reactionSummary / clearReactions are gated by lib/blogAccess", () => {
  test("a signed-out visitor cannot read the summary or clear a post", async () => {
    const t = newT();
    await t.mutation(api.blog.toggleReaction, {
      slug: SLUG,
      emoji: "🙏",
      actorKey: ACTOR,
    });
    await expect(t.query(api.blog.reactionSummary, {})).rejects.toBeInstanceOf(
      ConvexError,
    );
    await expect(
      t.mutation(api.blog.clearReactions, { slug: SLUG }),
    ).rejects.toBeInstanceOf(ConvexError);
    // The refusal left the rows alone.
    const rows = await run(t, (ctx) => ctx.db.query("blogReactions").collect());
    expect(rows).toHaveLength(1);
  });

  test("a chapter member sees per-post totals, busiest first", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await t.mutation(api.blog.toggleReaction, {
      slug: "quiet-post",
      emoji: "🙏",
      actorKey: ACTOR,
    });
    for (const actorKey of [ACTOR, OTHER_ACTOR]) {
      for (const emoji of ["🙏", "🔥"]) {
        await t.mutation(api.blog.toggleReaction, {
          slug: SLUG,
          emoji,
          actorKey,
        });
      }
    }

    const summary = await s.as.query(api.blog.reactionSummary, {});
    expect(summary.map((r) => r.slug)).toEqual([SLUG, "quiet-post"]);
    expect(summary[0]).toMatchObject({ total: 4, reactors: 2 });
    expect(countOf(summary[0].counts, "🔥")).toBe(2);
  });

  test("a chapter member can clear one post without touching another", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await t.mutation(api.blog.toggleReaction, {
      slug: SLUG,
      emoji: "🙏",
      actorKey: ACTOR,
    });
    await t.mutation(api.blog.toggleReaction, {
      slug: "other-post",
      emoji: "🙏",
      actorKey: ACTOR,
    });

    expect(await s.as.mutation(api.blog.clearReactions, { slug: SLUG })).toEqual(
      { slug: SLUG, removed: 1, readsRemoved: 0 },
    );
    const remaining = await run(t, (ctx) =>
      ctx.db.query("blogReactions").collect(),
    );
    expect(remaining.map((r) => r.slug)).toEqual(["other-post"]);
  });
});

// ── Reads ────────────────────────────────────────────────────────────────────

describe("recordRead", () => {
  test("first open counts the browser; refreshes don't", async () => {
    const t = newT();
    let state = await t.mutation(api.blog.recordRead, {
      slug: SLUG,
      actorKey: ACTOR,
    });
    expect(state.readers).toBe(1);
    // A refresh, a back-button, a re-shared link — same browser, same count.
    state = await t.mutation(api.blog.recordRead, {
      slug: SLUG,
      actorKey: ACTOR,
    });
    expect(state.readers).toBe(1);
    const rows = await run(t, (ctx) => ctx.db.query("blogReads").collect());
    expect(rows).toHaveLength(1);
  });

  test("two browsers are two readers, scoped per post", async () => {
    const t = newT();
    await t.mutation(api.blog.recordRead, { slug: SLUG, actorKey: ACTOR });
    const state = await t.mutation(api.blog.recordRead, {
      slug: SLUG,
      actorKey: OTHER_ACTOR,
    });
    expect(state.readers).toBe(2);
    const other = await t.query(api.blog.getReactions, { slug: "other-post" });
    expect(other.readers).toBe(0);
  });

  test("returns the full reaction state, so page load is one round trip", async () => {
    const t = newT();
    await t.mutation(api.blog.toggleReaction, {
      slug: SLUG,
      emoji: "🙏",
      actorKey: ACTOR,
    });
    const state = await t.mutation(api.blog.recordRead, {
      slug: SLUG,
      actorKey: ACTOR,
    });
    expect(countOf(state.counts, "🙏")).toBe(1);
    expect(state.mine).toEqual(["🙏"]);
    expect(state.emojis).toEqual([...BLOG_REACTION_EMOJIS]);
  });

  test("a junk actorKey is refused — the count can't be scripted with garbage", async () => {
    const t = newT();
    await expect(
      t.mutation(api.blog.recordRead, { slug: SLUG, actorKey: "!!" }),
    ).rejects.toBeInstanceOf(ConvexError);
  });
});

describe("reads in the staff surface", () => {
  test("summary reports readers, including posts nobody has reacted to", async () => {
    const t = newT();
    const s = await setupChapter(t);
    // Read but never reacted-to — must still appear in the summary.
    await t.mutation(api.blog.recordRead, { slug: "read-only-post", actorKey: ACTOR });
    await t.mutation(api.blog.recordRead, { slug: SLUG, actorKey: ACTOR });
    await t.mutation(api.blog.recordRead, { slug: SLUG, actorKey: OTHER_ACTOR });
    await t.mutation(api.blog.toggleReaction, {
      slug: SLUG,
      emoji: "🙏",
      actorKey: ACTOR,
    });

    const summary = await s.as.query(api.blog.reactionSummary, {});
    const bySlug = Object.fromEntries(summary.map((r) => [r.slug, r]));
    expect(bySlug[SLUG]).toMatchObject({ readers: 2, reactors: 1, total: 1 });
    expect(bySlug["read-only-post"]).toMatchObject({ readers: 1, total: 0 });
  });

  test("clearReactions resets the whole post — reactions and reads together", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await t.mutation(api.blog.recordRead, { slug: SLUG, actorKey: ACTOR });
    await t.mutation(api.blog.toggleReaction, {
      slug: SLUG,
      emoji: "🙏",
      actorKey: ACTOR,
    });
    expect(
      await s.as.mutation(api.blog.clearReactions, { slug: SLUG }),
    ).toEqual({ slug: SLUG, removed: 1, readsRemoved: 1 });
    const state = await t.query(api.blog.getReactions, { slug: SLUG });
    expect(state.readers).toBe(0);
  });
});
