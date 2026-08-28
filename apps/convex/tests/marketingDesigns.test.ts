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
import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import { PUBLIC_WORSHIP_THEME } from "@events-os/shared";
import type { Id } from "../_generated/dataModel";
import { newT, run, setupChapter, storeBlob, type ChapterSetup } from "./setup.helpers";

/** Give the test's user a central seat carrying `capabilities`. Same two-insert
 *  fixture `marketingSite.test.ts` uses — sharing it across files is not worth
 *  the coupling. */
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
      slug: "test_designs_seat",
      title: "Test Designs Seat",
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
