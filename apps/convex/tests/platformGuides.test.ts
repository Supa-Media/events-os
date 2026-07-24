/**
 * Platform guide seeding — upserting docs/guides/*.md (compiled into
 * lib/guides.ts) into a chapter's `docs` table.
 *
 * Covers the ownership semantics from the training-and-enablement plan (Q1):
 * guides are PLATFORM-OWNED and never forked —
 *   - first seed creates one markdown doc per guide, keyed by (chapter, slug)
 *   - re-seeding always overwrites drift back to the latest platform version
 *   - user-facing writes (docs.update, the assistant's setBody path) are
 *     rejected with PLATFORM_GUIDE_READONLY; normal docs stay writable
 * plus the `getGuideBySlug` lookup that powers the "How this works" links.
 */
import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { PLATFORM_GUIDES } from "../lib/guides";
import { seedPlatformGuidesForChapter } from "../lib/platformGuides";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";

/** A roster person for `createdBy` attribution (linked to the chapter user). */
async function addPerson(s: ChapterSetup): Promise<Id<"people">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Ada Okafor",
      userId: s.userId,
      isTeamMember: true,
      createdAt: Date.now(),
    }),
  );
}

const GUIDE_V1 = {
  slug: "so-you-own-an-area",
  title: "So you own an area",
  body: "# So you own an area\n\nOriginal platform content.\n",
};
const GUIDE_V2 = {
  ...GUIDE_V1,
  body: "# So you own an area\n\nUpdated platform content.\n",
};

describe("platform guide seeding", () => {
  test("first seed creates one markdown doc per guide, keyed by slug", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await addPerson(s);

    const results = await t.mutation(internal.docs.seedPlatformGuides, {
      chapterId: s.chapterId,
    });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      seeded: true,
      created: PLATFORM_GUIDES.length,
      updated: 0,
      unchanged: 0,
    });

    const docs = await run(t, (ctx) =>
      ctx.db
        .query("docs")
        .withIndex("by_chapter", (q) => q.eq("chapterId", s.chapterId))
        .collect(),
    );
    expect(docs).toHaveLength(PLATFORM_GUIDES.length);
    for (const guide of PLATFORM_GUIDES) {
      const doc = docs.find((d) => d.slug === guide.slug);
      expect(doc).toBeDefined();
      expect(doc).toMatchObject({
        kind: "markdown",
        title: guide.title,
        body: guide.body,
        createdBy: personId,
      });
      expect(doc!.shareId).toBeTruthy();
    }
  });

  test("author fallback skips contact-only rows — picks a real 'anyone' over an auto-created contact", async () => {
    const t = newT();
    const s = await setupChapter(t);
    // No login-linked person, no team member — only a contact-only row (would
    // have been picked by the old unconditional `people[0]` fallback, since it
    // sorts oldest-first) and a genuine (if unremarkable) roster person.
    await run(s.t, (ctx) =>
      ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Auto-created Contact",
        isContactOnly: true,
        createdAt: 1,
      }),
    );
    const realPersonId = await run(s.t, (ctx) =>
      ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Just Some Volunteer",
        createdAt: 2,
      }),
    );

    const results = await t.mutation(internal.docs.seedPlatformGuides, {
      chapterId: s.chapterId,
    });
    expect(results[0]?.seeded).toBe(true);

    const docs = await run(t, (ctx) =>
      ctx.db
        .query("docs")
        .withIndex("by_chapter", (q) => q.eq("chapterId", s.chapterId))
        .collect(),
    );
    expect(docs.every((d) => d.createdBy === realPersonId)).toBe(true);
  });

  test("a contacts-only chapter has no eligible author — seeding no-ops", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await run(s.t, (ctx) =>
      ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Auto-created Contact",
        isContactOnly: true,
        createdAt: Date.now(),
      }),
    );

    const results = await t.mutation(internal.docs.seedPlatformGuides, {
      chapterId: s.chapterId,
    });
    expect(results[0]).toMatchObject({ seeded: false });
  });

  test("re-seed is idempotent and always overwrites drift with the platform version", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await addPerson(s);

    // Seed v1 of two guides.
    const other = {
      slug: "so-you-own-an-event",
      title: "So you own an event",
      body: "# So you own an event\n\nEvent-owner content.\n",
    };
    await run(t, (ctx) =>
      seedPlatformGuidesForChapter(ctx, s.chapterId, [GUIDE_V1, other]),
    );

    // Re-seeding identical content is a no-op.
    const again = await run(t, (ctx) =>
      seedPlatformGuidesForChapter(ctx, s.chapterId, [GUIDE_V1, other]),
    );
    expect(again).toMatchObject({ created: 0, updated: 0, unchanged: 2 });

    // ONE doc drifts from the platform version (raw write — the user-facing
    // mutations reject guide edits, see the read-only test below; this covers
    // legacy rows edited before guides became read-only).
    const driftedDoc = await run(t, (ctx) =>
      ctx.db
        .query("docs")
        .withIndex("by_chapter_and_slug", (q) =>
          q.eq("chapterId", s.chapterId).eq("slug", GUIDE_V1.slug),
        )
        .unique(),
    );
    await run(t, (ctx) =>
      ctx.db.patch(driftedDoc!._id, {
        body: "My chapter's own take on owning an area.",
      }),
    );

    // Platform ships v2 of one guide. Re-seed overwrites BOTH the drifted doc
    // and nothing else: guides are platform-owned, never forked.
    const reseed = await run(t, (ctx) =>
      seedPlatformGuidesForChapter(ctx, s.chapterId, [GUIDE_V2, other]),
    );
    expect(reseed).toMatchObject({
      created: 0,
      updated: 1, // the drifted guide was reset to the platform version
      unchanged: 1,
    });

    const [reset, untouched] = await run(t, async (ctx) => {
      const bySlug = (slug: string) =>
        ctx.db
          .query("docs")
          .withIndex("by_chapter_and_slug", (q) =>
            q.eq("chapterId", s.chapterId).eq("slug", slug),
          )
          .unique();
      return [await bySlug(GUIDE_V1.slug), await bySlug(other.slug)];
    });
    // The drifted edit is gone — the platform version always wins, in place
    // (same row, so shareId/links survive)…
    expect(reset!.body).toBe(GUIDE_V2.body);
    expect(reset!._id).toBe(driftedDoc!._id);
    // …and identical docs are left alone.
    expect(untouched!.body).toBe(other.body);
  });

  test("platform guides are read-only: update and the assistant's setBody reject; normal docs unaffected", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await addPerson(s);
    await run(t, (ctx) =>
      seedPlatformGuidesForChapter(ctx, s.chapterId, [GUIDE_V1]),
    );
    const guide = await run(t, (ctx) =>
      ctx.db
        .query("docs")
        .withIndex("by_chapter_and_slug", (q) =>
          q.eq("chapterId", s.chapterId).eq("slug", GUIDE_V1.slug),
        )
        .unique(),
    );

    // The user-facing update mutation refuses every field, not just body.
    await expect(
      s.as.mutation(api.docs.update, {
        docId: guide!._id,
        body: "chapter-specific edits",
      }),
    ).rejects.toThrow(/PLATFORM_GUIDE_READONLY/);
    await expect(
      s.as.mutation(api.docs.update, {
        docId: guide!._id,
        title: "Our area guide",
      }),
    ).rejects.toThrow(ConvexError);

    // The doc assistant's write primitive refuses guides too (the seeder
    // writes through ctx.db directly, so seeding keeps its access).
    await expect(
      t.mutation(internal.docs.setBody, {
        docId: guide!._id,
        body: "AI rewrite",
        expectedChapterId: s.chapterId,
      }),
    ).rejects.toThrow(/PLATFORM_GUIDE_READONLY/);

    // Nothing landed.
    const after = await run(t, (ctx) => ctx.db.get(guide!._id));
    expect(after!.title).toBe(GUIDE_V1.title);
    expect(after!.body).toBe(GUIDE_V1.body);

    // A normal (slug-less) doc is unaffected by the guard.
    const { _id: normalId } = await s.as.mutation(api.docs.create, {
      kind: "markdown",
      title: "Our own how-to",
      body: "original",
    });
    await s.as.mutation(api.docs.update, {
      docId: normalId as Id<"docs">,
      body: "edited freely",
      title: "Our own how-to v2",
    });
    await t.mutation(internal.docs.setBody, {
      docId: normalId as Id<"docs">,
      body: "AI rewrite ok",
      expectedChapterId: s.chapterId,
    });
    const normal = await run(t, (ctx) => ctx.db.get(normalId as Id<"docs">));
    expect(normal!.title).toBe("Our own how-to v2");
    expect(normal!.body).toBe("AI rewrite ok");
  });

  test("skips a chapter with no roster person to attribute authorship to", async () => {
    const t = newT();
    const s = await setupChapter(t);

    const res = await run(t, (ctx) =>
      seedPlatformGuidesForChapter(ctx, s.chapterId, [GUIDE_V1]),
    );
    expect(res).toMatchObject({ seeded: false, created: 0 });

    const docs = await run(t, (ctx) =>
      ctx.db
        .query("docs")
        .withIndex("by_chapter", (q) => q.eq("chapterId", s.chapterId))
        .collect(),
    );
    expect(docs).toHaveLength(0);
  });

  test("listGuides returns only the guide docs, even among many non-guide docs", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await addPerson(s);

    const other = {
      slug: "so-you-own-an-event",
      title: "So you own an event",
      body: "# So you own an event\n\nEvent-owner content.\n",
    };
    await run(t, (ctx) =>
      seedPlatformGuidesForChapter(ctx, s.chapterId, [GUIDE_V1, other]),
    );

    // A pile of ordinary (slug-less) how-to docs in the same chapter — the
    // indexed slug range must skip straight past all of them.
    for (let i = 0; i < 25; i++) {
      await s.as.mutation(api.docs.create, {
        kind: "markdown",
        title: `How-to ${i}`,
        body: `body ${i}`,
      });
    }

    const guides = await s.as.query(api.docs.listGuides, {});
    expect(guides).toEqual([
      expect.objectContaining({ slug: GUIDE_V1.slug, title: GUIDE_V1.title }),
      expect.objectContaining({ slug: other.slug, title: other.title }),
    ]);
  });

  // NOTE: the `docs.clearSeedHash` maintenance test was removed in Deploy C —
  // `docs.seedHash` was dropped from the schema, so a `seedHash` row can no
  // longer be seeded (convex-test validates against the schema) and the field
  // is gone from the typed doc. The mutation is kept as a now-no-op shim.

  test("getGuideBySlug resolves the caller's chapter's copy (and null when missing)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await addPerson(s);
    await run(t, (ctx) =>
      seedPlatformGuidesForChapter(ctx, s.chapterId, [GUIDE_V1]),
    );

    const hit = await s.as.query(api.docs.getGuideBySlug, {
      slug: GUIDE_V1.slug,
    });
    expect(hit).toMatchObject({ title: GUIDE_V1.title });
    expect(hit!._id).toBeTruthy();

    const miss = await s.as.query(api.docs.getGuideBySlug, {
      slug: "owning-the-planning-doc",
    });
    expect(miss).toBeNull();

    // Another chapter doesn't see this chapter's guide docs.
    const s2 = await setupChapter(t, {
      email: "other@publicworship.life",
      chapterName: "Boston",
    });
    const crossChapter = await s2.as.query(api.docs.getGuideBySlug, {
      slug: GUIDE_V1.slug,
    });
    expect(crossChapter).toBeNull();
  });
});
