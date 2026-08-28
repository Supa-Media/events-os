/**
 * The brand kit and the design library.
 *
 * The rules worth pinning, in the order they'd hurt if they broke:
 *
 *  · READING IS UNGATED. A signed-in caller with no marketing seat at all still
 *    gets the whole kit, with `canEdit: false`. This is the feature
 *    (`marketing.designs.edit` has no `view` sibling), so a test has to say so
 *    out loud or the next person will "fix" it by adding a gate.
 *  · Every WRITE needs `marketing.designs.edit`.
 *  · A hex is a hex — `rgb()` and color names are refused, and two spellings of
 *    one color normalize to the same bytes.
 *  · Folders nest ONE level and no further, in both directions.
 *  · Deleting a folder never orphans a design invisibly: they move to Unfiled
 *    and the count comes back.
 *  · An omitted image field means KEEP. This is the bug that already shipped
 *    once in `marketingSite.ts#upsertLink`.
 *  · `embedUrl` is derived, so a Canva link embeds and a Dropbox link honestly
 *    doesn't.
 *  · The seed is idempotent, carries the newsletter's real red, and carries
 *    BOTH sides of the font conflict.
 */
import { describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import { PUBLIC_WORSHIP_THEME, SEAT_DEFS } from "@events-os/shared";
import type { Id } from "../_generated/dataModel";
import { newT, run, setupChapter, storeBlob, type ChapterSetup } from "./setup.helpers";

/** Give the test's user a seat carrying `capabilities`, on `chart`, held at
 *  `scope`. Same two-insert fixture `marketingSite.test.ts` uses — sharing it
 *  across files is not worth the coupling — generalized over chart/scope so a
 *  CHAPTER-chart seat held at a real chapter can be seeded, which is the whole
 *  question for `marketing.designs.edit` (see the chapter-scope describe
 *  block). Defaults are the central case every other test here wants. */
async function seedSeat(
  s: ChapterSetup,
  capabilities: readonly string[],
  opts: { chart?: "central" | "chapter"; scope?: "central" | Id<"chapters"> } = {},
): Promise<void> {
  const chart = opts.chart ?? "central";
  const scope = opts.scope ?? "central";
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
      slug: `test_designs_seat_${chart}`,
      title: "Test Designs Seat",
      chart,
      parentSlug: "root",
      maxHolders: 1,
      duties: [],
      capabilities: [...capabilities],
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("seatAssignments", {
      seatDefId,
      scope,
      personId,
      createdAt: now,
    });
  });
}

/** A signed-in user holding `marketing.designs.edit`. */
async function setupEditor(): Promise<ChapterSetup> {
  const t = newT();
  const s = await setupChapter(t);
  await seedSeat(s, ["marketing.designs.edit"]);
  return s;
}

describe("who can read and who can write", () => {
  test("a signed-in caller with no marketing seat reads the whole kit, read-only", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await t.mutation(internal.marketingDesigns.seedBrandKitIfEmpty, {});

    // The volunteer making a flyer at 11pm. No seat, no power — and the hex
    // code is right there, which is the entire argument for the ungated read.
    const lib = await s.as.query(api.marketingDesigns.library, {});
    expect(lib.canEdit).toBe(false);
    expect(lib.colors.find((c) => c.name === "PW Red")?.hex).toBe("#891d1a");
    expect(lib.folders.map((f) => f.name)).toContain("Logos");
  });

  test("but they cannot change anything", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedSeat(s, ["marketing.site.edit"]); // the site, not the kit
    await expect(
      s.as.mutation(api.marketingDesigns.upsertColor, {
        name: "Not our red",
        hex: "#ff0000",
      }),
    ).rejects.toThrow(/permission to change the brand kit/i);
    await expect(
      s.as.mutation(api.marketingDesigns.generateDesignUploadUrl, {}),
    ).rejects.toThrow(/permission to change the brand kit/i);
  });

  test("a holder sees canEdit", async () => {
    const s = await setupEditor();
    const lib = await s.as.query(api.marketingDesigns.library, {});
    expect(lib.canEdit).toBe(true);
  });

  test("ungated does not mean public — a signed-out caller is refused", async () => {
    const t = newT();
    await expect(t.query(api.marketingDesigns.library, {})).rejects.toThrow();
  });
});

describe("who may edit it — the ED, and a CHAPTER Director", () => {
  /**
   * The founder's instruction, 2026-08-28: "make sure that me as executive
   * director and even Chapter Directors can also edit [the brand kit]".
   *
   * These tests exist because the obvious way to satisfy that instruction does
   * NOT work. `marketing.designs.edit` was declared `scope: "central"`, and
   * `getSeatDerivedMarketingCapabilities` honored that by setting `designs`
   * only inside its central-scope branch — so putting the power on the
   * chapter-chart `chapter_director` seat would have produced a grant the org
   * chart printed and the gate ignored, silently, forever.
   *
   * So none of this asserts on a fixture flag. Each one seeds the REAL seat
   * definition's capability array, at a real scope, and drives a real mutation
   * through `requireDesignsEdit` — the derivation and the resolver both run.
   * Delete the `designs` line from that derivation and every test in this block
   * fails; that is the intended tripwire.
   */
  test("a Chapter Director, scoped to their own chapter, can change the kit", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedSeat(s, SEAT_DEFS.chapter_director.capabilities, {
      chart: "chapter",
      scope: s.chapterId,
    });

    // Not "a flag is set" — a real write through the real gate.
    await s.as.mutation(api.marketingDesigns.upsertColor, {
      name: "Approved by the CD",
      hex: "#123456",
    });
    const lib = await s.as.query(api.marketingDesigns.library, {});
    expect(lib.canEdit).toBe(true);
    expect(lib.colors.find((c) => c.name === "Approved by the CD")?.hex).toBe(
      "#123456",
    );
  });

  test("ONE BRAND still — the CD's edit lands in the org's single kit", async () => {
    // The invariant the scope change did NOT touch. There is no per-chapter
    // library, so a chapter-scoped editor and an ungated reader with no seat at
    // all are looking at the same rows.
    const t = newT();
    const s = await setupChapter(t);
    await seedSeat(s, SEAT_DEFS.chapter_director.capabilities, {
      chart: "chapter",
      scope: s.chapterId,
    });
    await s.as.mutation(api.marketingDesigns.upsertColor, {
      name: "One kit",
      hex: "#654321",
    });

    // Somebody in a DIFFERENT chapter, with no seat at all, reads the same row
    // back. `library` takes no scope argument — there is nothing to pass — and
    // this is that fact observed rather than asserted.
    const other = await setupChapter(t, {
      email: "denver@publicworship.life",
      chapterName: "Denver",
    });
    expect(other.chapterId).not.toBe(s.chapterId);
    const theirs = await other.as.query(api.marketingDesigns.library, {});
    expect(theirs.colors.map((c) => c.name)).toContain("One kit");
    expect(theirs.canEdit).toBe(false);
  });

  test("the Executive Director can change the kit", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedSeat(s, SEAT_DEFS.executive_director.capabilities);
    // Pinned rather than assumed: the ED's seat really does carry the power.
    expect(SEAT_DEFS.executive_director.capabilities).toContain(
      "marketing.designs.edit",
    );
    await s.as.mutation(api.marketingDesigns.upsertColor, {
      name: "Approved by the ED",
      hex: "#0f0f0f",
    });
    const lib = await s.as.query(api.marketingDesigns.library, {});
    expect(lib.canEdit).toBe(true);
  });

  test("it is the POWER doing the work, not the chapter scope", async () => {
    // The control. A chapter Marketing Lead sits at exactly the same scope as
    // the Chapter Director above and is refused — so the first test proves a
    // grant was honored, not that chapter scope became a free pass.
    const t = newT();
    const s = await setupChapter(t);
    expect(SEAT_DEFS.marketing_lead.capabilities).not.toContain(
      "marketing.designs.edit",
    );
    await seedSeat(s, SEAT_DEFS.marketing_lead.capabilities, {
      chart: "chapter",
      scope: s.chapterId,
    });
    await expect(
      s.as.mutation(api.marketingDesigns.upsertColor, {
        name: "Not theirs to make",
        hex: "#ff0000",
      }),
    ).rejects.toThrow(/permission to change the brand kit/i);
    // ...and reading is still wide open to them, which is the point.
    const lib = await s.as.query(api.marketingDesigns.library, {});
    expect(lib.canEdit).toBe(false);
  });

  test("widening the kit did NOT widen the homepage or the blog", async () => {
    // The founder asked about the brand kit only. `marketing.site.edit` and the
    // two blog powers are still `scope: "central"`, so a chapter-scope holder
    // of ALL of them still reaches none of them — the derivation's central
    // branch is intact.
    const t = newT();
    const s = await setupChapter(t);
    await seedSeat(
      s,
      ["marketing.site.edit", "marketing.blog.publish", "marketing.designs.edit"],
      { chart: "chapter", scope: s.chapterId },
    );
    const access = await s.as.query(api.marketingSite.myMarketingAccess, {});
    expect(access.canEditDesigns).toBe(true);
    expect(access.canEditSite).toBe(false);
  });
});

describe("colors", () => {
  test("a hex is a hex; rgb() and color names are refused", async () => {
    const s = await setupEditor();
    for (const hex of ["rgb(137,29,26)", "maroon", "891d1a", "#12345"]) {
      await expect(
        s.as.mutation(api.marketingDesigns.upsertColor, { name: "Bad", hex }),
      ).rejects.toThrow(/isn't a hex color/i);
    }
  });

  test("two spellings of one color become the same bytes", async () => {
    const s = await setupEditor();
    await s.as.mutation(api.marketingDesigns.upsertColor, {
      name: "Shouty",
      hex: "  #891D1A ",
    });
    await s.as.mutation(api.marketingDesigns.upsertColor, {
      name: "Short",
      hex: "#abc",
    });
    const lib = await s.as.query(api.marketingDesigns.library, {});
    expect(lib.colors.find((c) => c.name === "Shouty")?.hex).toBe("#891d1a");
    expect(lib.colors.find((c) => c.name === "Short")?.hex).toBe("#aabbcc");
  });

  test("a color needs a name, and the usage note is bounded", async () => {
    const s = await setupEditor();
    await expect(
      s.as.mutation(api.marketingDesigns.upsertColor, { name: "  ", hex: "#891d1a" }),
    ).rejects.toThrow(/needs a name/i);
    await expect(
      s.as.mutation(api.marketingDesigns.upsertColor, {
        name: "PW Red",
        hex: "#891d1a",
        usage: "x".repeat(201),
      }),
    ).rejects.toThrow(/too long/i);
  });

  test("swatches reorder as a whole list", async () => {
    const s = await setupEditor();
    const a = await s.as.mutation(api.marketingDesigns.upsertColor, {
      name: "A",
      hex: "#111111",
    });
    const b = await s.as.mutation(api.marketingDesigns.upsertColor, {
      name: "B",
      hex: "#222222",
    });
    await s.as.mutation(api.marketingDesigns.reorderColors, { colorIds: [b, a] });
    const lib = await s.as.query(api.marketingDesigns.library, {});
    expect(lib.colors.map((c) => c.name)).toEqual(["B", "A"]);
  });
});

describe("fonts", () => {
  test("two faces may share a role — the brand lesson promises this", async () => {
    const s = await setupEditor();
    await s.as.mutation(api.marketingDesigns.upsertFont, {
      name: "Times New Roman Condensed",
      role: "headline",
    });
    // Nothing refuses this, on purpose, and it is now a claim made in TRAINING:
    // `mktg-the-look` tells people "more than one face can share a job; the kit
    // shows you which". A uniqueness check added later would make that lesson a
    // lie and would also have the backend picking a side in a brand argument
    // that is explicitly the designer's to settle. See seed/brandKit.ts.
    await s.as.mutation(api.marketingDesigns.upsertFont, {
      name: "Inter",
      role: "headline",
    });
    const lib = await s.as.query(api.marketingDesigns.library, {});
    expect(lib.fonts.filter((f) => f.role === "headline")).toHaveLength(2);
  });

  test("the designer can re-role, reorder and remove a face without a deploy", async () => {
    // The other half of the same promise. The founder's instruction was "put
    // all of the fonts there and then make sure the designer can edit it when
    // they want", so the seeded list has to be fully mutable from the app —
    // not a fixed set with notes attached. Every verb the Designs tab offers is
    // exercised here against a seat that holds only `marketing.designs.edit`.
    const s = await setupEditor();
    const headline = await s.as.mutation(api.marketingDesigns.upsertFont, {
      name: "Times New Roman Condensed",
      role: "headline",
    });
    const body = await s.as.mutation(api.marketingDesigns.upsertFont, {
      name: "Inter",
      role: "body",
    });

    // Change what a face is FOR — the edit the font question in the lesson
    // describes ("they edit the fonts in Designs, and everyone sees the new
    // one"). Re-roling must not require deleting and re-adding.
    await s.as.mutation(api.marketingDesigns.upsertFont, {
      fontId: body,
      name: "Inter",
      role: "caption",
      notes: "Moved to captions by the designer.",
    });

    await s.as.mutation(api.marketingDesigns.reorderFonts, {
      fontIds: [body, headline],
    });
    await s.as.mutation(api.marketingDesigns.deleteFont, { fontId: headline });

    const lib = await s.as.query(api.marketingDesigns.library, {});
    expect(lib.fonts.map((f) => [f.name, f.role])).toEqual([
      ["Inter", "caption"],
    ]);
    expect(lib.fonts[0]?.notes).toBe("Moved to captions by the designer.");
  });

  test("a download link has to be a real link", async () => {
    const s = await setupEditor();
    await expect(
      s.as.mutation(api.marketingDesigns.upsertFont, {
        name: "Sketchy",
        role: "body",
        sourceUrl: "javascript:alert(1)",
      }),
    ).rejects.toThrow(/isn't one the kit can store/i);
  });
});

describe("folders nest exactly one level", () => {
  test("a child of a child is refused", async () => {
    const s = await setupEditor();
    const top = await s.as.mutation(api.marketingDesigns.upsertFolder, {
      name: "Social",
    });
    const child = await s.as.mutation(api.marketingDesigns.upsertFolder, {
      name: "Stories",
      parentId: top,
    });
    await expect(
      s.as.mutation(api.marketingDesigns.upsertFolder, {
        name: "Highlights",
        parentId: child,
      }),
    ).rejects.toThrow(/one level deep/i);
  });

  test("a folder that HAS children cannot itself be filed under one", async () => {
    const s = await setupEditor();
    const parent = await s.as.mutation(api.marketingDesigns.upsertFolder, {
      name: "Social",
    });
    await s.as.mutation(api.marketingDesigns.upsertFolder, {
      name: "Stories",
      parentId: parent,
    });
    const other = await s.as.mutation(api.marketingDesigns.upsertFolder, {
      name: "Print",
    });
    // The back door into grandchildren: checking only the proposed parent would
    // let this through and produce a tree nobody can navigate.
    await expect(
      s.as.mutation(api.marketingDesigns.upsertFolder, {
        folderId: parent,
        name: "Social",
        parentId: other,
      }),
    ).rejects.toThrow(/folders inside it/i);
  });

  test("a folder can't be its own parent", async () => {
    const s = await setupEditor();
    const f = await s.as.mutation(api.marketingDesigns.upsertFolder, { name: "Loop" });
    await expect(
      s.as.mutation(api.marketingDesigns.upsertFolder, {
        folderId: f,
        name: "Loop",
        parentId: f,
      }),
    ).rejects.toThrow(/inside itself/i);
  });

  test("renaming keeps the parent; clearParent is how you un-nest", async () => {
    const s = await setupEditor();
    const top = await s.as.mutation(api.marketingDesigns.upsertFolder, {
      name: "Social",
    });
    const child = await s.as.mutation(api.marketingDesigns.upsertFolder, {
      name: "Stories",
      parentId: top,
    });

    // The editor posts its whole form; an omitted parent must not re-file the
    // shelf and everything on it.
    await s.as.mutation(api.marketingDesigns.upsertFolder, {
      folderId: child,
      name: "Story overlays",
    });
    let lib = await s.as.query(api.marketingDesigns.library, {});
    expect(lib.folders.find((f) => f.id === child)?.parentId).toBe(top);

    await s.as.mutation(api.marketingDesigns.upsertFolder, {
      folderId: child,
      name: "Story overlays",
      clearParent: true,
    });
    lib = await s.as.query(api.marketingDesigns.library, {});
    expect(lib.folders.find((f) => f.id === child)?.parentId).toBeNull();
  });
});

describe("deleting a folder", () => {
  test("moves its designs to Unfiled and says how many", async () => {
    const s = await setupEditor();
    const folder = await s.as.mutation(api.marketingDesigns.upsertFolder, {
      name: "Flyers",
    });
    for (const title of ["Spring flyer", "Fall flyer"]) {
      await s.as.mutation(api.marketingDesigns.upsertDesign, {
        kind: "canva",
        title,
        folderId: folder,
        url: "https://www.canva.com/design/DAF123/abc/view",
      });
    }
    let lib = await s.as.query(api.marketingDesigns.library, {});
    expect(lib.folders.find((f) => f.id === folder)?.designCount).toBe(2);

    const result = await s.as.mutation(api.marketingDesigns.deleteFolder, {
      folderId: folder,
    });
    expect(result).toEqual({ movedDesigns: 2 });

    // Still there, still findable — the designs outlive the shelf.
    lib = await s.as.query(api.marketingDesigns.library, {});
    expect(lib.folders).toHaveLength(0);
    expect(lib.designs).toHaveLength(2);
    expect(lib.designs.every((d) => d.folderId === null)).toBe(true);
  });

  test("is refused while a sub-folder is still inside it", async () => {
    const s = await setupEditor();
    const parent = await s.as.mutation(api.marketingDesigns.upsertFolder, {
      name: "Social",
    });
    await s.as.mutation(api.marketingDesigns.upsertFolder, {
      name: "Stories",
      parentId: parent,
    });
    await expect(
      s.as.mutation(api.marketingDesigns.deleteFolder, { folderId: parent }),
    ).rejects.toThrow(/still has a folder inside it/i);
  });
});

describe("designs", () => {
  test("an omitted image means KEEP — the rename-deletes-the-artwork case", async () => {
    const s = await setupEditor();
    const storageId = await storeBlob(s.t);
    const designId = await s.as.mutation(api.marketingDesigns.upsertDesign, {
      kind: "image",
      title: "Logo lockup",
      imageStorage: storageId,
    });
    let lib = await s.as.query(api.marketingDesigns.library, {});
    const originalUrl = lib.designs[0].imageUrl;
    expect(originalUrl).toBeTruthy();

    // Retitle only. The form carries no bytes, so "not sent" can only mean
    // "unchanged" — `upsertLink` shipped the other way and cost a live logo.
    await s.as.mutation(api.marketingDesigns.upsertDesign, {
      designId,
      kind: "image",
      title: "Logo lockup (primary)",
    });
    lib = await s.as.query(api.marketingDesigns.library, {});
    expect(lib.designs[0].title).toBe("Logo lockup (primary)");
    expect(lib.designs[0].imageUrl).toBe(originalUrl);

    // Removing it is a deliberate act.
    await s.as.mutation(api.marketingDesigns.upsertDesign, {
      designId,
      kind: "link",
      title: "Logo lockup (primary)",
      url: "https://www.dropbox.com/scl/fo/logos",
      clearImage: true,
    });
    lib = await s.as.query(api.marketingDesigns.library, {});
    expect(lib.designs[0].imageUrl).toBeNull();
  });

  test("a thumbnail survives an edit too, and clears on request", async () => {
    const s = await setupEditor();
    const thumb = await storeBlob(s.t);
    const designId = await s.as.mutation(api.marketingDesigns.upsertDesign, {
      kind: "canva",
      title: "PW Flyer for Distribution",
      url: "https://www.canva.com/design/DAF123/abc/view",
      thumbnailStorage: thumb,
    });
    let lib = await s.as.query(api.marketingDesigns.library, {});
    expect(lib.designs[0].thumbnailUrl).toBeTruthy();

    await s.as.mutation(api.marketingDesigns.upsertDesign, {
      designId,
      kind: "canva",
      title: "PW Flyer",
      url: "https://www.canva.com/design/DAF123/abc/view",
    });
    lib = await s.as.query(api.marketingDesigns.library, {});
    expect(lib.designs[0].thumbnailUrl).toBeTruthy();

    await s.as.mutation(api.marketingDesigns.upsertDesign, {
      designId,
      kind: "canva",
      title: "PW Flyer",
      url: "https://www.canva.com/design/DAF123/abc/view",
      clearThumbnail: true,
    });
    lib = await s.as.query(api.marketingDesigns.library, {});
    expect(lib.designs[0].thumbnailUrl).toBeNull();
  });

  test("an upload that doesn't resolve is refused, not stored as a null URL", async () => {
    const s = await setupEditor();
    const storageId = await storeBlob(s.t);
    await run(s.t, (ctx) => ctx.storage.delete(storageId));
    // A row whose picture can never render is worse than no row — nobody
    // notices until the design is on a wall. (`emailImages.addImage`'s rule.)
    await expect(
      s.as.mutation(api.marketingDesigns.upsertDesign, {
        kind: "image",
        title: "Ghost",
        imageStorage: storageId,
      }),
    ).rejects.toThrow(/upload couldn't be found/i);
    const lib = await s.as.query(api.marketingDesigns.library, {});
    expect(lib.designs).toHaveLength(0);
  });

  test("embedUrl is derived: Canva embeds, Dropbox honestly doesn't", async () => {
    const s = await setupEditor();
    await s.as.mutation(api.marketingDesigns.upsertDesign, {
      kind: "canva",
      title: "Banner template",
      url: "https://www.canva.com/design/DAF123/abc/view",
    });
    await s.as.mutation(api.marketingDesigns.upsertDesign, {
      kind: "link",
      title: "Logos folder",
      url: "https://www.dropbox.com/scl/fo/logos",
    });
    const lib = await s.as.query(api.marketingDesigns.library, {});
    const canva = lib.designs.find((d) => d.kind === "canva");
    const dropbox = lib.designs.find((d) => d.kind === "link");
    expect(canva?.embedUrl).toBe(
      "https://www.canva.com/design/DAF123/abc/view?embed",
    );
    // Null, not a broken frame — every caller has to fall back to a plain link.
    expect(dropbox?.embedUrl).toBeNull();
  });

  test("a design has to be findable", async () => {
    const s = await setupEditor();
    await expect(
      s.as.mutation(api.marketingDesigns.upsertDesign, {
        kind: "canva",
        title: "Nowhere",
      }),
    ).rejects.toThrow(/needs a link/i);
    await expect(
      s.as.mutation(api.marketingDesigns.upsertDesign, {
        kind: "image",
        title: "Nothing",
      }),
    ).rejects.toThrow(/needs the picture itself/i);
  });

  test("a javascript: or data: URL is refused", async () => {
    const s = await setupEditor();
    for (const url of ["javascript:alert(1)", "data:text/html,x", "//evil.example"]) {
      await expect(
        s.as.mutation(api.marketingDesigns.upsertDesign, {
          kind: "link",
          title: "Bad",
          url,
        }),
      ).rejects.toThrow(/isn't one the library can store/i);
    }
  });

  test("moveDesignToFolder files and unfiles; omitting the folder unfiles", async () => {
    const s = await setupEditor();
    const folder = await s.as.mutation(api.marketingDesigns.upsertFolder, {
      name: "Banners",
    });
    const designId = await s.as.mutation(api.marketingDesigns.upsertDesign, {
      kind: "figma",
      title: "Stage banner",
      url: "https://www.figma.com/design/abc/Stage",
    });

    await s.as.mutation(api.marketingDesigns.moveDesignToFolder, {
      designId,
      folderId: folder,
    });
    let lib = await s.as.query(api.marketingDesigns.library, {});
    expect(lib.designs[0].folderId).toBe(folder);
    expect(lib.folders[0].designCount).toBe(1);

    await s.as.mutation(api.marketingDesigns.moveDesignToFolder, { designId });
    lib = await s.as.query(api.marketingDesigns.library, {});
    expect(lib.designs[0].folderId).toBeNull();
    expect(lib.folders[0].designCount).toBe(0);
  });

  test("editing a design does not move it — that's moveDesignToFolder's job", async () => {
    const s = await setupEditor();
    const folder = await s.as.mutation(api.marketingDesigns.upsertFolder, {
      name: "Signage",
    });
    const designId = await s.as.mutation(api.marketingDesigns.upsertDesign, {
      kind: "canva",
      title: "Door sign",
      folderId: folder,
      url: "https://www.canva.com/design/DAF999/xyz/view",
    });
    await s.as.mutation(api.marketingDesigns.upsertDesign, {
      designId,
      kind: "canva",
      title: "Door sign v2",
      url: "https://www.canva.com/design/DAF999/xyz/view",
    });
    const lib = await s.as.query(api.marketingDesigns.library, {});
    expect(lib.designs[0].folderId).toBe(folder);
  });

  test("designs reorder as a whole list", async () => {
    const s = await setupEditor();
    const a = await s.as.mutation(api.marketingDesigns.upsertDesign, {
      kind: "link",
      title: "A",
      url: "https://example.com/a",
    });
    const b = await s.as.mutation(api.marketingDesigns.upsertDesign, {
      kind: "link",
      title: "B",
      url: "https://example.com/b",
    });
    await s.as.mutation(api.marketingDesigns.reorderDesigns, { designIds: [b, a] });
    const lib = await s.as.query(api.marketingDesigns.library, {});
    expect(lib.designs.map((d) => d.title)).toEqual(["B", "A"]);
  });

  test("deleting a design drops its blobs with it", async () => {
    const s = await setupEditor();
    const storageId = await storeBlob(s.t);
    const designId = await s.as.mutation(api.marketingDesigns.upsertDesign, {
      kind: "image",
      title: "Retired mark",
      imageStorage: storageId,
    });
    await s.as.mutation(api.marketingDesigns.deleteDesign, { designId });

    // The blob is the point of a hard delete: leaving it would keep retired
    // artwork publicly fetchable at its URL forever.
    const url = await run(s.t, (ctx) => ctx.storage.getUrl(storageId));
    expect(url).toBeNull();
    // And a second delete is a no-op, not a throw.
    await s.as.mutation(api.marketingDesigns.deleteDesign, { designId });
  });
});

describe("the seed", () => {
  test("carries the newsletter's real colors and is idempotent", async () => {
    const t = newT();
    const first = await t.mutation(internal.marketingDesigns.seedBrandKitIfEmpty, {});
    expect(first).toEqual({ colors: 4, fonts: 4, folders: 5 });

    const second = await t.mutation(internal.marketingDesigns.seedBrandKitIfEmpty, {});
    expect(second).toEqual({ colors: 0, fonts: 0, folders: 0 });

    const s = await setupChapter(t);
    const lib = await s.as.query(api.marketingDesigns.library, {});
    // Read off `PUBLIC_WORSHIP_THEME` rather than retyped, so a palette change
    // in the email theme moves the kit with it instead of leaving two answers.
    expect(lib.colors.map((c) => c.hex)).toEqual([
      PUBLIC_WORSHIP_THEME.accent,
      PUBLIC_WORSHIP_THEME.ink,
      PUBLIC_WORSHIP_THEME.cream,
      PUBLIC_WORSHIP_THEME.link,
    ]);
    expect(lib.colors[0].name).toBe("PW Red");
    expect(lib.colors[0].usage).toMatch(/anything public-facing/i);
  });

  test("carries all four faces, with roles", async () => {
    const t = newT();
    await t.mutation(internal.marketingDesigns.seedBrandKitIfEmpty, {});
    const s = await setupChapter(t);
    const lib = await s.as.query(api.marketingDesigns.library, {});

    // Three faces come from the Academy's brand lesson, the fourth (Inter) from
    // the real newsletter. All four ship, by the founder's own call — "put all
    // of the fonts there" — rather than a seed silently settling a brand
    // question. If you are here because you want to delete one: do it in the
    // app, not in the seed. See lib/seed/brandKit.ts.
    expect(lib.fonts.map((f) => [f.name, f.role])).toEqual([
      ["Times New Roman Condensed", "headline"],
      ["Inter", "body"],
      ["SF Pro Display", "caption"],
      ["Barbra Condensed", "accent"],
    ]);
  });

  test("carries the five shelves from the lesson's asset table, flat", async () => {
    const t = newT();
    await t.mutation(internal.marketingDesigns.seedBrandKitIfEmpty, {});
    const s = await setupChapter(t);
    const lib = await s.as.query(api.marketingDesigns.library, {});
    expect(lib.folders.map((f) => f.name)).toEqual([
      "Logos",
      "Flyers",
      "Banners",
      "Social media overlays",
      "Signage",
    ]);
    expect(lib.folders.every((f) => f.parentId === null)).toBe(true);
    expect(lib.folders.every((f) => f.designCount === 0)).toBe(true);
  });

  test("leaves a table that already has rows completely alone", async () => {
    const s = await setupEditor();
    await s.as.mutation(api.marketingDesigns.upsertColor, {
      name: "Only ours",
      hex: "#123456",
    });
    const counts = await s.t.mutation(
      internal.marketingDesigns.seedBrandKitIfEmpty,
      {},
    );
    // Per-table, not per-row: re-seeding a color somebody deliberately retired
    // would be worse than an unseeded table.
    expect(counts.colors).toBe(0);
    expect(counts.fonts).toBe(4);
    const lib = await s.as.query(api.marketingDesigns.library, {});
    expect(lib.colors.map((c) => c.name)).toEqual(["Only ours"]);
  });
});

/** A superuser bypass exists everywhere in this repo; saying so here keeps the
 *  next reader from mistaking it for a hole in this desk's gate. */
describe("superuser", () => {
  test("edits without holding the power", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: "lkupo@publicworship.life" });
    const id: Id<"brandColors"> = await s.as.mutation(
      api.marketingDesigns.upsertColor,
      { name: "PW Red", hex: "#891d1a" },
    );
    expect(id).toBeTruthy();
  });
});

describe("design covers — captured from the tool's own og:image", () => {
  /**
   * The rule set (founder, 2026-08-28: "just save the first og image, and if
   * it expires we can click a button to refresh"): a linked design saved
   * without a cover captures one automatically from its page's og:image, as
   * BYTES in our storage (so nothing we render can expire); the automatic
   * path only ever fills a blank; Refresh is the explicit overwrite.
   *
   * `fetch` is stubbed per-URL: the design's page answers with og-tagged
   * HTML, the CDN answers with PNG bytes. Everything else is a test bug and
   * fails loudly rather than hitting the network.
   */
  const PAGE_URL = "https://www.canva.com/design/DAGtest123/view";
  const OEMBED_URL = `https://www.canva.com/_oembed/types/rich?url=${encodeURIComponent(PAGE_URL)}`;
  const IMG_URL = "https://media.example-cdn.com/covers/first.png";
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]);

  function stubFetch(overrides?: {
    html?: string;
    imageStatus?: number;
    imageType?: string;
    /** JSON body for the oEmbed endpoint; default is a 404, sending the
     *  pipeline down the page-scrape path most tests exercise. */
    oembed?: unknown;
    pageStatus?: number;
  }) {
    const html =
      overrides?.html ??
      `<html><head>
         <meta property="og:image" content="${IMG_URL}">
         <meta property="og:image" content="https://media.example-cdn.com/covers/second.png">
       </head><body></body></html>`;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === OEMBED_URL) {
        return overrides?.oembed !== undefined
          ? new Response(JSON.stringify(overrides.oembed), {
              status: 200,
              headers: { "content-type": "application/json" },
            })
          : new Response("not found", { status: 404 });
      }
      if (url === PAGE_URL) {
        return new Response(html, {
          status: overrides?.pageStatus ?? 200,
          headers: { "content-type": "text/html" },
        });
      }
      if (url === IMG_URL) {
        return new Response(PNG, {
          status: overrides?.imageStatus ?? 200,
          headers: { "content-type": overrides?.imageType ?? "image/png" },
        });
      }
      throw new Error(`unexpected fetch in test: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  async function designRow(s: ChapterSetup, designId: string) {
    return await run(s.t, async (ctx) => await ctx.db.get(asId(designId)));
  }
  const asId = (id: string) => id as unknown as Id<"designAssets">;

  test("a new Canva link captures the FIRST og:image as its cover", async () => {
    vi.useFakeTimers();
    try {
      const s = await setupEditor();
      const fetchMock = stubFetch();
      const designId = await s.as.mutation(api.marketingDesigns.upsertDesign, {
        kind: "canva",
        title: "PW Flyer",
        url: PAGE_URL,
      });
      await s.t.finishAllScheduledFunctions(vi.runAllTimers);

      const row = await designRow(s, String(designId));
      expect(row?.thumbnailStorage).toBeDefined();
      expect(row?.thumbnailUrl).toBeTruthy();
      // The oEmbed probe first (404 here), then the page once, then the FIRST
      // image — never the second.
      expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual([
        OEMBED_URL,
        PAGE_URL,
        IMG_URL,
      ]);
      // The bytes are OURS now: what the grid renders is our storage URL, not
      // the CDN address that will someday die.
      expect(row?.thumbnailUrl).not.toContain("example-cdn.com");
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  test("the automatic capture never overwrites a cover somebody chose", async () => {
    // The race the mutation decides atomically: capture is IN FLIGHT when a
    // human uploads their own cover. The human wins, and the captured blob is
    // discarded rather than leaked.
    vi.useFakeTimers();
    try {
      const s = await setupEditor();
      const fetchMock = stubFetch();
      const designId = await s.as.mutation(api.marketingDesigns.upsertDesign, {
        kind: "canva",
        title: "PW Flyer",
        url: PAGE_URL,
      });
      const manual = await storeBlob(s.t);
      await s.as.mutation(api.marketingDesigns.upsertDesign, {
        designId,
        kind: "canva",
        title: "PW Flyer",
        url: PAGE_URL,
        thumbnailStorage: manual,
      });
      await s.t.finishAllScheduledFunctions(vi.runAllTimers);

      const row = await designRow(s, String(designId));
      expect(String(row?.thumbnailStorage)).toBe(String(manual));
      // And the pending capture noticed BEFORE fetching anything — the early
      // exit is only an optimization (the atomic guard in `applyCover` is what
      // actually protects the cover, proven separately below), but an
      // optimization the org relies on to not hammer Canva deserves a pin.
      expect(fetchMock.mock.calls).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  test("the atomic half of never-overwrite: applyCover itself refuses a taken slot", async () => {
    // The capture pipeline has TWO guards against clobbering a human's cover:
    // the action's early exit (exercised by the scheduled-path test above) and
    // the mutation's atomic re-check, which exists for the race the action
    // cannot close — the cover chosen in the gap between the action's read and
    // its write. Sabotaging either one alone left the OTHER test green, which
    // is exactly the "two independent guards, one test" false-green from the
    // engineering notes — so the inner guard gets its own direct probe.
    const s = await setupEditor();
    const manual = await storeBlob(s.t);
    const designId = await s.as.mutation(api.marketingDesigns.upsertDesign, {
      kind: "canva",
      title: "PW Flyer",
      url: PAGE_URL,
      thumbnailStorage: manual,
    });
    const captured = await storeBlob(s.t);
    const result = await s.t.mutation(internal.marketingDesigns.applyCover, {
      designId,
      storageId: captured,
      onlyIfBare: true,
    });
    expect(result.applied).toBe(false);
    const row = await designRow(s, String(designId));
    expect(String(row?.thumbnailStorage)).toBe(String(manual));
    // The losing blob is discarded, not leaked: the action stored it before
    // the mutation could know it would refuse.
    expect(await run(s.t, (ctx) => ctx.storage.getUrl(captured))).toBeNull();
  });

  test("Refresh overwrites, and the replaced cover is really gone", async () => {
    vi.useFakeTimers();
    try {
      const s = await setupEditor();
      stubFetch();
      const manual = await storeBlob(s.t);
      const designId = await s.as.mutation(api.marketingDesigns.upsertDesign, {
        kind: "canva",
        title: "PW Flyer",
        url: PAGE_URL,
        thumbnailStorage: manual,
      });
      await s.t.finishAllScheduledFunctions(vi.runAllTimers); // nothing pending — thumb present

      await s.as.action(api.marketingDesigns.refreshCover, { designId });

      const row = await designRow(s, String(designId));
      expect(String(row?.thumbnailStorage)).not.toBe(String(manual));
      // Hard-deleted, same rule as removing an upload by hand: "replaced" must
      // mean gone, or the library keeps serving an image nothing points at.
      const oldUrl = await run(s.t, (ctx) => ctx.storage.getUrl(manual));
      expect(oldUrl).toBeNull();
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  test("Refresh without the seat is refused before any fetch happens", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const fetchMock = stubFetch();
    try {
      // A design exists (seeded by an editor elsewhere); a seatless caller
      // cannot re-capture it. The refusal must come from the gate, not from
      // the fetch failing — hence the call-count assertion.
      const editor = await setupEditor();
      const designId = await editor.as.mutation(api.marketingDesigns.upsertDesign, {
        kind: "canva",
        title: "PW Flyer",
        url: PAGE_URL,
        thumbnailStorage: await storeBlob(editor.t),
      });
      void designId;
      await expect(
        s.as.action(api.marketingDesigns.refreshCover, {
          designId: designId as never,
        }),
      ).rejects.toThrow();
      expect(
        fetchMock.mock.calls.filter((c) => String(c[0]) === PAGE_URL),
      ).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("a page with no preview is a plain answer, not a silent unchanged tile", async () => {
    vi.useFakeTimers();
    try {
      const s = await setupEditor();
      stubFetch({ html: "<html><head><title>private</title></head></html>" });
      const designId = await s.as.mutation(api.marketingDesigns.upsertDesign, {
        kind: "canva",
        title: "Private design",
        url: PAGE_URL,
      });
      // The automatic pass finds nothing and stays quiet — the tile keeps its
      // typographic placeholder, which is the designed no-cover state.
      await s.t.finishAllScheduledFunctions(vi.runAllTimers);
      expect((await designRow(s, String(designId)))?.thumbnailStorage).toBeUndefined();

      // The BUTTON is different: a human is waiting, so the same outcome is an
      // error with the likely cause (a Canva link not set to public).
      await expect(
        s.as.action(api.marketingDesigns.refreshCover, { designId }),
      ).rejects.toThrow(/didn't offer a preview/i);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});

describe("cover capture — the field failure and its fixes", () => {
  /**
   * The founder's first real press of Refresh, on the real PW Flyer, came back
   * "couldn't be reached". Two causes, both encoded here so they cannot
   * quietly return: the stored link was the /edit URL (which Canva never
   * serves anonymously — only the embed rewrite was normalizing it), and the
   * error flattened the HTTP status away, making the report undiagnosable.
   * The pipeline also now asks the tool's own oEmbed endpoint before scraping,
   * since that is the API that exists for third-party preview fetching.
   */
  const EDIT_URL = "https://www.canva.com/design/DAGtest123/edit";
  const VIEW_URL = "https://www.canva.com/design/DAGtest123/view";
  const VIEW_OEMBED = `https://www.canva.com/_oembed/types/rich?url=${encodeURIComponent(VIEW_URL)}`;
  const IMG = "https://media.example-cdn.com/covers/first.png";
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

  function stub(routes: Record<string, () => Response>) {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const handler = routes[String(input)];
      if (!handler) throw new Error(`unexpected fetch in test: ${String(input)}`);
      return handler();
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }
  const png = () =>
    new Response(PNG, { status: 200, headers: { "content-type": "image/png" } });

  test("an /edit link is captured via its /view page — the founder's exact case", async () => {
    vi.useFakeTimers();
    try {
      const s = await setupEditor();
      const fetchMock = stub({
        [VIEW_OEMBED]: () => new Response("nope", { status: 404 }),
        [VIEW_URL]: () =>
          new Response(
            `<head><meta property="og:image" content="${IMG}"></head>`,
            { status: 200, headers: { "content-type": "text/html" } },
          ),
        [IMG]: png,
      });
      const designId = await s.as.mutation(api.marketingDesigns.upsertDesign, {
        kind: "canva",
        title: "PW Flyer",
        url: EDIT_URL,
      });
      await s.t.finishAllScheduledFunctions(vi.runAllTimers);
      const row = await run(s.t, (ctx) => ctx.db.get(designId));
      expect(row?.thumbnailStorage).toBeDefined();
      // The stored link stays the marketer's /edit URL — normalization is a
      // FETCH-time concern, not a rewrite of what they saved.
      expect(row?.url).toBe(EDIT_URL);
      // And nothing ever requested the /edit page.
      const urls = fetchMock.mock.calls.map((c) => String(c[0]));
      expect(urls).not.toContain(EDIT_URL);
      expect(urls).toContain(VIEW_URL);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  test("the oEmbed thumbnail wins without the page ever being scraped", async () => {
    vi.useFakeTimers();
    try {
      const s = await setupEditor();
      const fetchMock = stub({
        [VIEW_OEMBED]: () =>
          new Response(JSON.stringify({ type: "rich", thumbnail_url: IMG }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        [IMG]: png,
      });
      const designId = await s.as.mutation(api.marketingDesigns.upsertDesign, {
        kind: "canva",
        title: "PW Flyer",
        url: VIEW_URL,
      });
      await s.t.finishAllScheduledFunctions(vi.runAllTimers);
      expect((await run(s.t, (ctx) => ctx.db.get(designId)))?.thumbnailStorage).toBeDefined();
      expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual([
        VIEW_OEMBED,
        IMG,
      ]);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  test("a 403 page tells the human it was REFUSED, with the status, not 'unreachable'", async () => {
    const s = await setupEditor();
    stub({
      [VIEW_OEMBED]: () => new Response("nope", { status: 404 }),
      [VIEW_URL]: () => new Response("forbidden", { status: 403 }),
    });
    try {
      const designId = await s.as.mutation(api.marketingDesigns.upsertDesign, {
        kind: "canva",
        title: "PW Flyer",
        url: VIEW_URL,
        thumbnailStorage: await storeBlob(s.t),
      });
      // The status travels into the message — the first field report was
      // undiagnosable precisely because it didn't.
      await expect(
        s.as.action(api.marketingDesigns.refreshCover, { designId }),
      ).rejects.toThrow(/refused.*403.*anyone with it can view/is);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
