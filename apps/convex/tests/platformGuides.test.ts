/**
 * Platform guide seeding — upserting docs/guides/*.md (compiled into
 * lib/guides.ts) into a chapter's `docs` table.
 *
 * Covers the fork semantics from the training-and-enablement plan:
 *   - first seed creates one markdown doc per guide, keyed by (chapter, slug)
 *   - re-seeding an UNEDITED doc overwrites it with new platform content
 *   - a doc the chapter edited is left alone (their fork keeps its edits)
 * plus the `getGuideBySlug` lookup that powers the "How this works" links.
 */
import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { PLATFORM_GUIDES } from "../lib/guides";
import { seedPlatformGuidesForChapter } from "../lib/platformGuides";
import { sha256Hex } from "../lib/sha256";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";

/** A roster person for `createdBy` attribution (linked to the chapter user). */
async function addPerson(s: ChapterSetup): Promise<Id<"people">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Ada Okafor",
      userId: s.userId,
      isTeamMember: true,
      isActive: true,
      createdAt: Date.now(),
    }),
  );
}

const GUIDE_V1 = {
  slug: "so-you-own-a-workstream",
  title: "So you own a workstream",
  body: "# So you own a workstream\n\nOriginal platform content.\n",
};
const GUIDE_V2 = {
  ...GUIDE_V1,
  body: "# So you own a workstream\n\nUpdated platform content.\n",
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
      skippedEdited: 0,
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
        seedHash: sha256Hex(guide.body),
      });
      expect(doc!.shareId).toBeTruthy();
    }
  });

  test("re-seed is idempotent, updates unedited docs, and leaves edited docs alone", async () => {
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
    expect(again).toMatchObject({
      created: 0,
      updated: 0,
      unchanged: 2,
      skippedEdited: 0,
    });

    // The chapter edits ONE doc (as a user would, via docs.update).
    const editedDoc = await run(t, (ctx) =>
      ctx.db
        .query("docs")
        .withIndex("by_chapter_and_slug", (q) =>
          q.eq("chapterId", s.chapterId).eq("slug", GUIDE_V1.slug),
        )
        .unique(),
    );
    await s.as.mutation(api.docs.update, {
      docId: editedDoc!._id,
      body: "My chapter's own take on owning a workstream.",
    });

    // Platform ships v2 of both guides.
    const reseed = await run(t, (ctx) =>
      seedPlatformGuidesForChapter(ctx, s.chapterId, [
        GUIDE_V2,
        { ...other, body: other.body + "\nMore platform wisdom.\n" },
      ]),
    );
    expect(reseed).toMatchObject({
      created: 0,
      updated: 1, // the unedited guide took the update…
      unchanged: 0,
      skippedEdited: 1, // …the edited one kept the chapter's fork
    });

    const [forked, followed] = await run(t, async (ctx) => {
      const bySlug = (slug: string) =>
        ctx.db
          .query("docs")
          .withIndex("by_chapter_and_slug", (q) =>
            q.eq("chapterId", s.chapterId).eq("slug", slug),
          )
          .unique();
      return [await bySlug(GUIDE_V1.slug), await bySlug(other.slug)];
    });
    expect(forked!.body).toBe("My chapter's own take on owning a workstream.");
    expect(followed!.body).toBe(other.body + "\nMore platform wisdom.\n");
    expect(followed!.seedHash).toBe(sha256Hex(followed!.body!));
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
