/**
 * The blog's backend — posts as rows.
 *
 * What this pins, in the order it matters:
 *  - the TWO gates. Writing needs `marketing.blog.edit`; publishing and taking
 *    down need `marketing.blog.publish`, and a writer who holds only the first
 *    is refused at exactly one function.
 *  - the SLUG FREEZE. A published post's slug survives a retitle, because
 *    `blogReactions` counts against it and shared links are forever. A draft's
 *    does not, because nobody holds it yet.
 *  - the three states, and the transitions that are refused: no walking a
 *    public post back to "draft", no deleting one at all.
 *  - the completeness gate at publish, which names everything missing at once.
 *  - what the PUBLIC queries do and do not reveal — the whole point of the
 *    preview token is that a draft without one is indistinguishable from a
 *    post that was never written.
 *  - the seed's fidelity and its idempotence: the migrated post keeps the URL
 *    strangers already hold.
 */
import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { newT, run, setupChapter, storeBlob, type ChapterSetup } from "./setup.helpers";
import { DOXOLOGY_BODY, DOXOLOGY_POST } from "../lib/seed/blogPosts";

type PostId = Id<"blogPosts">;

/** Give the test's user a central seat carrying `capabilities`. Mirrors the
 *  helper in `marketingSite.test.ts` — a seat fixture is three inserts and
 *  sharing it across files is not worth the coupling. */
async function seedSeat(s: ChapterSetup, capabilities: string[]): Promise<void> {
  const now = Date.now();
  await run(s.t, async (ctx) => {
    const personId = await ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Seat Holder",
      email: "seat@publicworship.life",
      userId: s.userId,
      createdAt: now,
    });
    const seatDefId = await ctx.db.insert("seatDefs", {
      slug: "test_blog_seat",
      title: "Test Blog Seat",
      chart: "central",
      parentSlug: "root",
      maxHolders: 1,
      duties: [],
      capabilities,
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("seatAssignments", {
      seatDefId,
      scope: "central",
      personId,
      createdAt: now,
    });
  });
}

/**
 * A SECOND identity inside an existing test database, holding its own seat.
 *
 * `writer()` and `publisher()` each stand up a fresh `newT()`, which is right
 * for a test about one caller and wrong for any test about two — a post
 * created by one would be invisible to the other, and a refusal would be
 * indistinguishable from a missing row.
 */
async function addSeatHolder(
  s: ChapterSetup,
  email: string,
  capabilities: string[],
): Promise<ChapterSetup["as"]> {
  const now = Date.now();
  const userId = await run(s.t, async (ctx) => {
    const userId = await ctx.db.insert("users", { email });
    const personId = await ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: email,
      email,
      userId,
      createdAt: now,
    });
    const seatDefId = await ctx.db.insert("seatDefs", {
      slug: `test_blog_seat_${email}`,
      title: "Test Blog Seat",
      chart: "central",
      parentSlug: "root",
      maxHolders: 1,
      duties: [],
      capabilities,
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("seatAssignments", {
      seatDefId,
      scope: "central",
      personId,
      createdAt: now,
    });
    return userId;
  });
  return s.t.withIdentity({ subject: `${userId}|session` });
}

/** A writer (`marketing.blog.edit` only) — the seat an associate holds. */
async function writer(): Promise<ChapterSetup> {
  const t = newT();
  const s = await setupChapter(t);
  await seedSeat(s, ["marketing.blog.edit"]);
  return s;
}

/**
 * A publisher — someone who can both write and put a post on the internet.
 *
 * Both strings are listed even though `marketing.blog.publish` now implies
 * `marketing.blog.edit`, so this fixture is explicit about the reach it grants
 * rather than depending on an implication rule these tests are not about.
 * (That implication was MISSING when this file was written — the ladder rule
 * grants only `.view`, so the ED and the Marketing Director, who hold the
 * publish string alone, could publish a post they could not save. It is fixed
 * on the `publish` def, and `powers.test.ts` now fails for any approve/publish
 * power lacking its own area's edit.)
 */
async function publisher(): Promise<ChapterSetup> {
  const t = newT();
  const s = await setupChapter(t);
  await seedSeat(s, ["marketing.blog.publish", "marketing.blog.edit"]);
  return s;
}

async function newPost(
  s: ChapterSetup,
  fields: Record<string, unknown> = {},
): Promise<PostId> {
  return (await s.as.mutation(api.marketingBlog.upsertPost, {
    title: "A Post About Singing",
    description: "What we sing and why.",
    body: "## First\n\nSome words.",
    ...fields,
  })) as PostId;
}

/** Create and publish, which needs the publisher's gate. */
async function livePost(
  s: ChapterSetup,
  fields: Record<string, unknown> = {},
): Promise<PostId> {
  const postId = await newPost(s, fields);
  await s.as.mutation(api.marketingBlog.setPostStatus, {
    postId,
    status: "published",
  });
  return postId;
}

// ── Gates ────────────────────────────────────────────────────────────────────

describe("access", () => {
  test("a signed-in user with no marketing seat cannot read or write", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await expect(s.as.query(api.marketingBlog.listPosts, {})).rejects.toThrow(
      ConvexError,
    );
    await expect(
      s.as.mutation(api.marketingBlog.upsertPost, { title: "Nope" }),
    ).rejects.toThrow(ConvexError);
  });

  test("a writer may write but may not publish or take down", async () => {
    const s = await writer();
    const postId = await newPost(s);
    await expect(
      s.as.mutation(api.marketingBlog.setPostStatus, {
        postId,
        status: "published",
      }),
    ).rejects.toThrow(ConvexError);
    await expect(
      s.as.mutation(api.marketingBlog.setPostStatus, {
        postId,
        status: "archived",
      }),
    ).rejects.toThrow(ConvexError);
  });

  test("a publisher may do both", async () => {
    const s = await publisher();
    const postId = await livePost(s);
    const post = await s.as.query(api.marketingBlog.getPost, { postId });
    expect(post?.status).toBe("published");
  });

  test("the hero upload URL is behind the desk's power, not 'any signed-in user'", async () => {
    const t = newT();
    const stranger = await setupChapter(t);
    await expect(
      stranger.as.mutation(api.marketingBlog.generateHeroUploadUrl, {}),
    ).rejects.toThrow(ConvexError);
    const s = await writer();
    await expect(
      s.as.mutation(api.marketingBlog.generateHeroUploadUrl, {}),
    ).resolves.toBeTruthy();
  });

  test("rotating a preview token is a WRITER's action — revocation must not need a director", async () => {
    const s = await writer();
    const postId = await newPost(s);
    const before = (await s.as.query(api.marketingBlog.getPost, { postId }))!
      .previewToken;
    const after = await s.as.mutation(api.marketingBlog.rotatePreviewToken, {
      postId,
    });
    expect(after).not.toBe(before);
    expect(after).toMatch(/^[0-9a-f]{32}$/);
  });
});

// ── Create / edit ────────────────────────────────────────────────────────────

describe("upsertPost", () => {
  test("a new post is born a draft with a token, whatever else was sent", async () => {
    const s = await publisher();
    const postId = await newPost(s);
    const post = (await s.as.query(api.marketingBlog.getPost, { postId }))!;
    expect(post.status).toBe("draft");
    expect(post.publishedAt).toBeNull();
    expect(post.updatedAt).toBeNull();
    expect(post.previewToken).toMatch(/^[0-9a-f]{32}$/);
    expect(post.slug).toBe("a-post-about-singing");
    expect(post.author).toBe("The Public Worship Team");
    expect(post.reactionsEnabled).toBe(true);
  });

  test("a title with nothing usable in a URL is refused, with the rule in the message", async () => {
    const s = await writer();
    await expect(
      s.as.mutation(api.marketingBlog.upsertPost, { title: "!!! ???" }),
    ).rejects.toThrow(ConvexError);
    await expect(
      s.as.mutation(api.marketingBlog.upsertPost, { title: "   " }),
    ).rejects.toThrow(ConvexError);
  });

  test("two posts with the same title get different addresses", async () => {
    const s = await writer();
    const a = await newPost(s);
    const b = await newPost(s);
    const slugs = await Promise.all(
      [a, b].map(async (id) =>
        (await s.as.query(api.marketingBlog.getPost, { postId: id }))!.slug,
      ),
    );
    expect(slugs[0]).toBe("a-post-about-singing");
    expect(slugs[1]).toBe("a-post-about-singing-2");
  });

  test("an omitted field is left alone; an emptied one is a real edit", async () => {
    const s = await writer();
    const postId = await newPost(s, { subtitle: "A standfirst" });
    await s.as.mutation(api.marketingBlog.upsertPost, {
      postId,
      title: "A Post About Singing",
    });
    expect(
      (await s.as.query(api.marketingBlog.getPost, { postId }))!.subtitle,
    ).toBe("A standfirst");
    await s.as.mutation(api.marketingBlog.upsertPost, { postId, subtitle: "" });
    expect(
      (await s.as.query(api.marketingBlog.getPost, { postId }))!.subtitle,
    ).toBeNull();
  });

  test("bounds are enforced on every text field", async () => {
    const s = await writer();
    const postId = await newPost(s);
    for (const field of ["title", "description", "subtitle", "audience", "author"]) {
      await expect(
        s.as.mutation(api.marketingBlog.upsertPost, {
          postId,
          [field]: "x".repeat(1000),
        }),
      ).rejects.toThrow(ConvexError);
    }
    await expect(
      s.as.mutation(api.marketingBlog.upsertPost, {
        postId,
        body: "x".repeat(200_001),
      }),
    ).rejects.toThrow(ConvexError);
  });

  test("tags are trimmed, de-duplicated case-insensitively, and bounded", async () => {
    const s = await writer();
    const postId = await newPost(s, {
      tags: ["  Worship ", "worship", "", "Songwriting"],
    });
    expect((await s.as.query(api.marketingBlog.getPost, { postId }))!.tags).toEqual(
      ["Worship", "Songwriting"],
    );
    await expect(
      s.as.mutation(api.marketingBlog.upsertPost, {
        postId,
        tags: Array.from({ length: 9 }, (_, i) => `tag${i}`),
      }),
    ).rejects.toThrow(ConvexError);
    await expect(
      s.as.mutation(api.marketingBlog.upsertPost, {
        postId,
        tags: ["x".repeat(31)],
      }),
    ).rejects.toThrow(ConvexError);
  });

  test("the hero is three-state: set, clear, and leave alone", async () => {
    const s = await writer();
    const storageId = await storeBlob(s.t);
    const postId = await newPost(s, { heroStorage: storageId });
    const withHero = (await s.as.query(api.marketingBlog.getPost, { postId }))!;
    expect(withHero.heroImageUrl).toBeTruthy();

    // A save that does not mention the hero keeps it — the form never learns
    // the bytes behind a saved image, so "not sent" MUST mean keep.
    await s.as.mutation(api.marketingBlog.upsertPost, { postId, title: "Renamed" });
    expect(
      (await s.as.query(api.marketingBlog.getPost, { postId }))!.heroImageUrl,
    ).toBeTruthy();

    await s.as.mutation(api.marketingBlog.upsertPost, { postId, clearHero: true });
    expect(
      (await s.as.query(api.marketingBlog.getPost, { postId }))!.heroImageUrl,
    ).toBeNull();
  });

  test("editing a draft does not stamp the public 'updated' line", async () => {
    const s = await writer();
    const postId = await newPost(s);
    await s.as.mutation(api.marketingBlog.upsertPost, { postId, body: "More." });
    expect(
      (await s.as.query(api.marketingBlog.getPost, { postId }))!.updatedAt,
    ).toBeNull();
  });

  test("editing a PUBLISHED post does — that is what 'Updated' on the page means", async () => {
    const s = await publisher();
    const postId = await livePost(s);
    await s.as.mutation(api.marketingBlog.upsertPost, { postId, body: "Revised." });
    expect(
      (await s.as.query(api.marketingBlog.getPost, { postId }))!.updatedAt,
    ).toBeGreaterThan(0);
  });
});

// ── The slug freeze ──────────────────────────────────────────────────────────

describe("the slug rule", () => {
  test("a DRAFT's slug follows its title — nobody holds the link yet", async () => {
    const s = await writer();
    const postId = await newPost(s);
    await s.as.mutation(api.marketingBlog.upsertPost, {
      postId,
      title: "Something Else Entirely",
    });
    expect((await s.as.query(api.marketingBlog.getPost, { postId }))!.slug).toBe(
      "something-else-entirely",
    );
  });

  test("a PUBLISHED post's slug survives a retitle", async () => {
    const s = await publisher();
    const postId = await livePost(s);
    await s.as.mutation(api.marketingBlog.upsertPost, {
      postId,
      title: "A Much Better Headline",
    });
    const post = (await s.as.query(api.marketingBlog.getPost, { postId }))!;
    expect(post.title).toBe("A Much Better Headline");
    expect(post.slug).toBe("a-post-about-singing");
  });

  test("the freeze survives archiving — an archived post's URL still resolves", async () => {
    const s = await publisher();
    const postId = await livePost(s);
    await s.as.mutation(api.marketingBlog.setPostStatus, {
      postId,
      status: "archived",
    });
    await s.as.mutation(api.marketingBlog.upsertPost, {
      postId,
      title: "Renamed After Takedown",
    });
    expect((await s.as.query(api.marketingBlog.getPost, { postId }))!.slug).toBe(
      "a-post-about-singing",
    );
  });

  test("a frozen slug keeps its reactions reachable", async () => {
    // The concrete reason for the rule: `blogReactions` keys on the string.
    const s = await publisher();
    const postId = await livePost(s);
    await run(s.t, async (ctx) => {
      await ctx.db.insert("blogReactions", {
        slug: "a-post-about-singing",
        emoji: "🙏",
        actorKey: "abcd1234efgh5678",
        createdAt: Date.now(),
      });
    });
    await s.as.mutation(api.marketingBlog.upsertPost, {
      postId,
      title: "Completely Different",
    });
    const slug = (await s.as.query(api.marketingBlog.getPost, { postId }))!.slug;
    const reactions = await s.t.query(api.blog.getReactions, { slug });
    // `counts` is an ordered array, not an emoji-keyed object (see
    // lib/blogReactions.ts) — the tap is still there because the address is.
    expect(reactions.counts.reduce((sum, c) => sum + c.count, 0)).toBe(1);
  });
});

// ── Status transitions ───────────────────────────────────────────────────────

describe("setPostStatus", () => {
  test("publishing an incomplete post is refused, naming everything missing at once", async () => {
    const s = await publisher();
    const postId = (await s.as.mutation(api.marketingBlog.upsertPost, {
      title: "Just A Title",
    })) as PostId;
    let message = "";
    try {
      await s.as.mutation(api.marketingBlog.setPostStatus, {
        postId,
        status: "published",
      });
    } catch (err) {
      message = String((err as ConvexError<{ message: string }>).data.message);
    }
    expect(message).toContain("a description");
    expect(message).toContain("something in the body");
  });

  test("publishing stamps the date once, and re-publishing does not re-date it", async () => {
    const s = await publisher();
    const postId = await livePost(s);
    const first = (await s.as.query(api.marketingBlog.getPost, { postId }))!
      .publishedAt;
    expect(first).toBeGreaterThan(0);
    await s.as.mutation(api.marketingBlog.setPostStatus, {
      postId,
      status: "archived",
    });
    await s.as.mutation(api.marketingBlog.setPostStatus, {
      postId,
      status: "published",
    });
    expect(
      (await s.as.query(api.marketingBlog.getPost, { postId }))!.publishedAt,
    ).toBe(first);
  });

  test("taking a post down is never blocked, even when it is incomplete", async () => {
    const s = await publisher();
    const postId = await livePost(s);
    // Empty the description AFTER it went live — archiving must still work.
    await s.as.mutation(api.marketingBlog.upsertPost, { postId, description: "" });
    await s.as.mutation(api.marketingBlog.setPostStatus, {
      postId,
      status: "archived",
    });
    expect((await s.as.query(api.marketingBlog.getPost, { postId }))!.status).toBe(
      "archived",
    );
  });

  test("a post that has been public cannot go back to being a draft", async () => {
    const s = await publisher();
    const postId = await livePost(s);
    await s.as.mutation(api.marketingBlog.setPostStatus, {
      postId,
      status: "archived",
    });
    await expect(
      s.as.mutation(api.marketingBlog.setPostStatus, { postId, status: "draft" }),
    ).rejects.toThrow(ConvexError);
  });

  test("a missing post is a NOT_FOUND, not a crash", async () => {
    const s = await publisher();
    const postId = await newPost(s);
    await s.as.mutation(api.marketingBlog.deletePost, { postId });
    await expect(
      s.as.mutation(api.marketingBlog.setPostStatus, { postId, status: "published" }),
    ).rejects.toThrow(ConvexError);
  });
});

// ── Delete ───────────────────────────────────────────────────────────────────

describe("deletePost", () => {
  test("a draft deletes cleanly", async () => {
    const s = await writer();
    const postId = await newPost(s);
    await s.as.mutation(api.marketingBlog.deletePost, { postId });
    expect(await s.as.query(api.marketingBlog.getPost, { postId })).toBeNull();
  });

  test("a PUBLISHED post refuses, and the refusal says to archive instead", async () => {
    const s = await publisher();
    const postId = await livePost(s);
    let message = "";
    try {
      await s.as.mutation(api.marketingBlog.deletePost, { postId });
    } catch (err) {
      message = String((err as ConvexError<{ message: string }>).data.message);
    }
    expect(message).toMatch(/archive/i);
    expect(await s.as.query(api.marketingBlog.getPost, { postId })).not.toBeNull();
  });

  test("an ARCHIVED post deletes — a second, deliberate decision", async () => {
    const s = await publisher();
    const postId = await livePost(s);
    await s.as.mutation(api.marketingBlog.setPostStatus, {
      postId,
      status: "archived",
    });
    await s.as.mutation(api.marketingBlog.deletePost, { postId });
    expect(await s.as.query(api.marketingBlog.getPost, { postId })).toBeNull();
  });

  test("deleting twice is not an error", async () => {
    const s = await writer();
    const postId = await newPost(s);
    await s.as.mutation(api.marketingBlog.deletePost, { postId });
    await expect(
      s.as.mutation(api.marketingBlog.deletePost, { postId }),
    ).resolves.toBeNull();
  });
});

// ── The desk list ────────────────────────────────────────────────────────────

describe("what a writer may undo, and what only a publisher may", () => {
  test("a post archived from DRAFT can go back to draft", async () => {
    const s = await publisher();
    const postId = await newPost(s);
    // Never published, so there is no link out there to protect. Refusing this
    // left a mis-clicked draft stuck forever behind a message that was false
    // about its own case ("a post that has been public…").
    await s.as.mutation(api.marketingBlog.setPostStatus, {
      postId,
      status: "archived",
    });
    await s.as.mutation(api.marketingBlog.setPostStatus, {
      postId,
      status: "draft",
    });
    const post = await s.as.query(api.marketingBlog.getPost, { postId });
    expect(post?.status).toBe("draft");
  });

  test("a post archived from PUBLISHED still cannot", async () => {
    const s = await publisher();
    const postId = await livePost(s);
    await s.as.mutation(api.marketingBlog.setPostStatus, {
      postId,
      status: "archived",
    });
    await expect(
      s.as.mutation(api.marketingBlog.setPostStatus, { postId, status: "draft" }),
    ).rejects.toThrow(/its link is out there/i);
  });

  test("deleting an ARCHIVED once-public post needs the publish power", async () => {
    // Taking it down needed `blog.publish`; erasing that it ever existed must
    // not need less. Otherwise a writer undoes a Director's decision one screen
    // later, which is the shape of every separation-of-duties bug.
    //
    // Both identities live in ONE database — `writer()`/`publisher()` each
    // call `newT()`, so using them together would put the post in a database
    // the second caller cannot see, and the refusal under test would be
    // indistinguishable from "no such post".
    const pub = await publisher();
    const postId = await livePost(pub);
    await pub.as.mutation(api.marketingBlog.setPostStatus, {
      postId,
      status: "archived",
    });

    const writerOnly = await addSeatHolder(pub, "writer@publicworship.life", [
      "marketing.blog.edit",
    ]);
    await expect(
      writerOnly.mutation(api.marketingBlog.deletePost, { postId }),
    ).rejects.toThrow(/publish/i);

    // The row survived the refusal, so its URL still resolves.
    expect(await pub.as.query(api.marketingBlog.getPost, { postId })).not.toBeNull();

    // And a publisher may finish the job.
    await pub.as.mutation(api.marketingBlog.deletePost, { postId });
    expect(await pub.as.query(api.marketingBlog.getPost, { postId })).toBeNull();
  });

  test("deleting a never-published draft still needs only the write power", async () => {
    const s = await writer();
    const postId = await newPost(s);
    await s.as.mutation(api.marketingBlog.deletePost, { postId });
    expect(await s.as.query(api.marketingBlog.getPost, { postId })).toBeNull();
  });
});

describe("listPosts", () => {
  test("shows every status, carries reading minutes, and never carries a token", async () => {
    const s = await publisher();
    await livePost(s, { title: "Live One" });
    await newPost(s, { title: "Draft One" });
    const rows = await s.as.query(api.marketingBlog.listPosts, {});
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.status).sort()).toEqual(["draft", "published"]);
    expect(rows.every((r) => typeof r.readingMinutes === "number")).toBe(true);
    // The body is not on this wire (fifty posts must not ship fifty essays),
    // and neither is the preview secret.
    for (const row of rows) {
      expect(row).not.toHaveProperty("body");
      expect(row).not.toHaveProperty("previewToken");
    }
  });
});

// ── The public surface ───────────────────────────────────────────────────────

describe("publicPostList", () => {
  test("published posts only, newest first, with no bodies", async () => {
    const s = await publisher();
    await newPost(s, { title: "A Draft" });
    const older = await livePost(s, { title: "Older Post" });
    await run(s.t, async (ctx) => {
      await ctx.db.patch(older, { publishedAt: Date.UTC(2020, 0, 1) });
    });
    await livePost(s, { title: "Newer Post" });

    const list = await s.t.query(internal.marketingBlog.publicPostList, {});
    expect(list.map((p) => p.title)).toEqual(["Newer Post", "Older Post"]);
    for (const post of list) expect(post).not.toHaveProperty("body");
  });

  test("an archived post leaves the index, the feed, and the sitemap", async () => {
    const s = await publisher();
    const postId = await livePost(s);
    expect(await s.t.query(internal.marketingBlog.publicPostList, {})).toHaveLength(1);
    await s.as.mutation(api.marketingBlog.setPostStatus, {
      postId,
      status: "archived",
    });
    expect(await s.t.query(internal.marketingBlog.publicPostList, {})).toHaveLength(0);
  });
});

describe("publicPost", () => {
  test("a published post resolves with rendered HTML and its headings", async () => {
    const s = await publisher();
    await livePost(s, {
      body: "## The word\n\nSome **words**.\n\n### Deeper\n\nMore.",
    });
    const result = await s.t.query(internal.marketingBlog.publicPost, {
      slug: "a-post-about-singing",
    });
    expect(result).not.toBeNull();
    expect(result!.html).toContain("<strong>words</strong>");
    expect(result!.headings).toEqual([
      { depth: 2, text: "The word", id: "the-word" },
      { depth: 3, text: "Deeper", id: "deeper" },
    ]);
    // The contract the page depends on: every heading's anchor exists.
    for (const h of result!.headings) {
      expect(result!.html).toContain(`id="${h.id}"`);
    }
  });

  test("a draft is invisible without its token, and indistinguishable from nothing", async () => {
    const s = await writer();
    const postId = await newPost(s);
    const slug = (await s.as.query(api.marketingBlog.getPost, { postId }))!.slug;
    expect(
      await s.t.query(internal.marketingBlog.publicPost, { slug }),
    ).toBeNull();
    expect(
      await s.t.query(internal.marketingBlog.publicPost, {
        slug: "never-written",
      }),
    ).toBeNull();
  });

  test("a draft resolves with the RIGHT token and only that one", async () => {
    const s = await writer();
    const postId = await newPost(s);
    const post = (await s.as.query(api.marketingBlog.getPost, { postId }))!;
    expect(
      await s.t.query(internal.marketingBlog.publicPost, {
        slug: post.slug,
        previewToken: post.previewToken,
      }),
    ).not.toBeNull();
    expect(
      await s.t.query(internal.marketingBlog.publicPost, {
        slug: post.slug,
        previewToken: "0".repeat(32),
      }),
    ).toBeNull();
    expect(
      await s.t.query(internal.marketingBlog.publicPost, {
        slug: post.slug,
        previewToken: "",
      }),
    ).toBeNull();
  });

  test("rotating the token revokes every link already handed out", async () => {
    const s = await writer();
    const postId = await newPost(s);
    const post = (await s.as.query(api.marketingBlog.getPost, { postId }))!;
    await s.as.mutation(api.marketingBlog.rotatePreviewToken, { postId });
    expect(
      await s.t.query(internal.marketingBlog.publicPost, {
        slug: post.slug,
        previewToken: post.previewToken,
      }),
    ).toBeNull();
  });

  test("an archived post RESOLVES and reports its status — a 404 is a worse answer", async () => {
    const s = await publisher();
    const postId = await livePost(s);
    await s.as.mutation(api.marketingBlog.setPostStatus, {
      postId,
      status: "archived",
    });
    const result = await s.t.query(internal.marketingBlog.publicPost, {
      slug: "a-post-about-singing",
    });
    expect(result).not.toBeNull();
    expect(result!.post.status).toBe("archived");
  });

  test("a post's raw HTML is sanitized on the way out, not on the way in", async () => {
    // Stored verbatim (a writer's draft is theirs), rendered inert.
    const s = await publisher();
    await livePost(s, {
      body: 'Words.\n\n<div class="pw-note"><script>alert(1)</script>Safe.</div>',
    });
    const postId = (await s.as.query(api.marketingBlog.listPosts, {}))[0].id;
    const stored = (await s.as.query(api.marketingBlog.getPost, {
      postId: postId as PostId,
    }))!;
    expect(stored.body).toContain("<script>");

    const result = await s.t.query(internal.marketingBlog.publicPost, {
      slug: "a-post-about-singing",
    });
    expect(result!.html).not.toContain("<script");
    expect(result!.html).not.toContain("alert(1)");
    expect(result!.html).toContain('<div class="pw-note">');
    expect(result!.html).toContain("Safe.");
  });
});

// ── The migration ────────────────────────────────────────────────────────────

describe("seedBlogPostsIfEmpty", () => {
  test("inserts the migrated post verbatim, at the URL people already hold", async () => {
    const t = newT();
    expect(
      await t.mutation(internal.marketingBlog.seedBlogPostsIfEmpty, {}),
    ).toEqual({ inserted: 1 });

    const list = await t.query(internal.marketingBlog.publicPostList, {});
    expect(list).toHaveLength(1);
    const post = list[0];
    expect(post.slug).toBe("doxology");
    expect(post.title).toBe("Why We Sing What We Sing");
    expect(post.status).toBe("published");
    expect(post.publishedAt).toBe(Date.UTC(2026, 7, 25));
    expect(post.author).toBe("The Public Worship Team");
    expect(post.audience).toBe("everyone who worships with us");
    expect(post.tags).toEqual(["Songwriting", "Song Selection", "Worship"]);
    expect(post.subtitle).toContain("What you should expect");

    const full = await t.query(internal.marketingBlog.publicPost, {
      slug: "doxology",
    });
    expect(full!.post.body).toBe(DOXOLOGY_BODY);
  });

  test("the migrated post renders its raw-HTML table and its headings", async () => {
    const t = newT();
    await t.mutation(internal.marketingBlog.seedBlogPostsIfEmpty, {});
    const full = (await t.query(internal.marketingBlog.publicPost, {
      slug: "doxology",
    }))!;
    // The two shapes the real post depends on and no synthetic fixture has.
    expect(full.html).toContain('<div class="pw-scroll">');
    expect(full.html).toContain('<div class="pw-note">');
    expect(full.html).toContain("<th>Verdict</th>");
    expect(full.html).toContain("&ldquo;");
    expect(full.html).toContain("<blockquote>");
    // The Astro layout's table of contents was h2-only; these are the h2s.
    expect(full.headings.filter((h) => h.depth === 2).map((h) => h.text)).toEqual([
      "The word: doxology",
      "Why we build on it",
      "The test",
      "The five shapes we welcome",
      "Where good songs drift",
      "What we sing but do not build on",
      "How we hold ourselves to this",
      "An invitation",
      "Further reading",
    ]);
    for (const h of full.headings) expect(full.html).toContain(`id="${h.id}"`);
  });

  test("running it twice inserts nothing the second time", async () => {
    const t = newT();
    await t.mutation(internal.marketingBlog.seedBlogPostsIfEmpty, {});
    expect(
      await t.mutation(internal.marketingBlog.seedBlogPostsIfEmpty, {}),
    ).toEqual({ inserted: 0 });
    expect(await t.query(internal.marketingBlog.publicPostList, {})).toHaveLength(1);
  });

  test("it never touches a table someone has written to", async () => {
    const s = await writer();
    await newPost(s, { title: "Written In The OS" });
    expect(
      await s.t.mutation(internal.marketingBlog.seedBlogPostsIfEmpty, {}),
    ).toEqual({ inserted: 0 });
    expect(await s.as.query(api.marketingBlog.listPosts, {})).toHaveLength(1);
  });

  test("the seeded slug is the one the reactions table already counts against", () => {
    // Not derived from the title on purpose — `blogSlugFromTitle` would say
    // `why-we-sing-what-we-sing`, which would 404 every shared link.
    expect(DOXOLOGY_POST.slug).toBe("doxology");
  });
});
