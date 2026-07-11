import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { api } from "../_generated/api";
import { newT, run, setupChapter } from "./setup.helpers";
import type { Id } from "../_generated/dataModel";
import type { TestConvex } from "./setup.helpers";

/**
 * Platform guides (docs with `slug` set) are read-only — `docs.setBody`
 * rejects writes. The assistant must refuse UP FRONT: `ensureDocThread` /
 * `newDocThread` throw for a slug-bearing doc so a chat can't even open
 * (otherwise the model loop burns budget before failing on write_doc).
 */

async function seedDocs(t: TestConvex, chapterId: Id<"chapters">) {
  return await run(t, async (ctx) => {
    const now = Date.now();
    const personId = await ctx.db.insert("people", {
      chapterId,
      name: "Author",
      vettingStatus: "unvetted",
      status: "active",
      isActive: true,
      createdAt: now,
    });
    const guideId = await ctx.db.insert("docs", {
      chapterId,
      kind: "markdown",
      title: "So You Own a Workstream",
      body: "Platform guide body.",
      shareId: "guide-share",
      slug: "so-you-own-a-workstream",
      createdBy: personId,
      createdAt: now,
      updatedAt: now,
    });
    const normalDocId = await ctx.db.insert("docs", {
      chapterId,
      kind: "markdown",
      title: "Our Sound Check How-To",
      body: "Chapter-owned guide.",
      shareId: "howto-share",
      createdBy: personId,
      createdAt: now,
      updatedAt: now,
    });
    return { guideId, normalDocId };
  });
}

describe("doc assistant platform-guide guard", () => {
  test("ensureDocThread on a slug-bearing doc throws PLATFORM_GUIDE_READONLY", async () => {
    const t = newT();
    const { as, chapterId } = await setupChapter(t);
    const { guideId } = await seedDocs(t, chapterId);

    await expect(
      as.mutation(api.ai.ensureDocThread, { docId: guideId }),
    ).rejects.toThrow(ConvexError);
    await expect(
      as.mutation(api.ai.ensureDocThread, { docId: guideId }),
    ).rejects.toThrow(/read-only/i);
  });

  test("newDocThread on a slug-bearing doc throws; a normal doc still works", async () => {
    const t = newT();
    const { as, chapterId } = await setupChapter(t);
    const { guideId, normalDocId } = await seedDocs(t, chapterId);

    await expect(
      as.mutation(api.ai.newDocThread, { docId: guideId }),
    ).rejects.toThrow(ConvexError);

    const threadId = await as.mutation(api.ai.ensureDocThread, {
      docId: normalDocId,
    });
    expect(threadId).toBeDefined();
  });

  test("docs.forAi surfaces the slug so the action can refuse too", async () => {
    const t = newT();
    const { as, chapterId } = await setupChapter(t);
    const { guideId, normalDocId } = await seedDocs(t, chapterId);

    const guide = await as.query(api.docs.forAi, { docId: guideId });
    expect(guide!.slug).toBe("so-you-own-a-workstream");
    const doc = await as.query(api.docs.forAi, { docId: normalDocId });
    expect(doc!.slug).toBeNull();
  });
});
