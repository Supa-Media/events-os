/**
 * Test suite for migration 0085: folders become the primitive.
 *
 * The migration has to do two things to a deployment that has been live since
 * before folders held anything but design files:
 *
 *  1. convert every design's single `folderId` into the `folderIds` array, and
 *     clear the dead field, and
 *  2. put the palette and the typefaces into two PINNED folders, "Colors" and
 *     "Faces", so the tab still opens on the sections it has always had.
 *
 * The rows below are inserted directly rather than through `upsertDesign`,
 * because the point is to simulate documents written by the PREVIOUS version of
 * the schema — which is exactly what the current mutations can no longer
 * produce.
 */
import { describe, expect, test } from "vitest";
import { newT, run } from "./setup.helpers";
import { foldersAsPrimitive } from "../migrations/0085_folders_as_primitive";
import type { MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";

type T = ReturnType<typeof newT>;

const runMigration = (t: T) =>
  run(t, (ctx) => foldersAsPrimitive.run(ctx as unknown as MutationCtx));

/** A folder, as any version of this schema writes one. */
async function seedFolder(t: T, name: string, pinned?: boolean) {
  const now = Date.now();
  return run(t, (ctx) =>
    ctx.db.insert("designFolders", {
      name,
      ...(pinned === undefined ? {} : { pinned }),
      order: 100,
      createdAt: now,
      updatedAt: now,
    }),
  );
}

/** A design as the PRE-0085 schema wrote it: one folder, no array. */
async function seedOldDesign(
  t: T,
  title: string,
  folderId?: Id<"designFolders">,
) {
  const now = Date.now();
  return run(t, (ctx) =>
    ctx.db.insert("designAssets", {
      kind: "canva",
      title,
      ...(folderId ? { folderId } : {}),
      url: "https://www.canva.com/design/DAF1/abc/view",
      order: 100,
      createdAt: now,
      updatedAt: now,
    }),
  );
}

async function seedOldColor(t: T, name: string, hex: string) {
  const now = Date.now();
  return run(t, (ctx) =>
    ctx.db.insert("brandColors", {
      name,
      hex,
      order: 100,
      createdAt: now,
      updatedAt: now,
    }),
  );
}

async function seedOldFont(t: T, name: string) {
  const now = Date.now();
  return run(t, (ctx) =>
    ctx.db.insert("brandFonts", {
      name,
      role: "headline" as const,
      order: 100,
      createdAt: now,
      updatedAt: now,
    }),
  );
}

const folders = (t: T) =>
  run(t, (ctx) => ctx.db.query("designFolders").collect());
const designs = (t: T) =>
  run(t, (ctx) => ctx.db.query("designAssets").collect());
const colorRows = (t: T) =>
  run(t, (ctx) => ctx.db.query("brandColors").collect());
const fontRows = (t: T) => run(t, (ctx) => ctx.db.query("brandFonts").collect());

describe("0085: designs", () => {
  test("the single folder becomes an array of one, and the dead field is cleared", async () => {
    const t = newT();
    const logos = await seedFolder(t, "Logos");
    await seedOldDesign(t, "PW wordmark", logos);

    const result = await runMigration(t);
    expect(result).toMatchObject({ designsConverted: 1 });

    const [design] = await designs(t);
    expect(design.folderIds).toEqual([logos]);
    // Cleared, so the column can be dropped from the schema later and so a
    // second run has nothing to do.
    expect(design.folderId).toBeUndefined();
  });

  test("an unfiled design is left alone", async () => {
    const t = newT();
    await seedOldDesign(t, "Loose flyer");
    await runMigration(t);

    const [design] = await designs(t);
    expect(design.folderIds ?? []).toEqual([]);
  });

  test("running it twice converts nothing the second time", async () => {
    const t = newT();
    const logos = await seedFolder(t, "Logos");
    await seedOldDesign(t, "PW wordmark", logos);

    await runMigration(t);
    const second = await runMigration(t);
    expect(second).toMatchObject({
      designsConverted: 0,
      colorsFiled: 0,
      fontsFiled: 0,
    });
    const [design] = await designs(t);
    expect(design.folderIds).toEqual([logos]);
  });
});

describe("0085: the brand kit becomes two pinned folders", () => {
  test("creates them, files the palette and the faces, and sorts them first", async () => {
    const t = newT();
    await seedFolder(t, "Logos");
    await seedOldColor(t, "PW Red", "#891d1a");
    await seedOldColor(t, "Cream", "#fff9ee");
    await seedOldFont(t, "Inter");

    const result = await runMigration(t);
    expect(result).toMatchObject({ colorsFiled: 2, fontsFiled: 1 });

    const rows = await folders(t);
    const colorsFolder = rows.find((f) => f.name === "Colors");
    const facesFolder = rows.find((f) => f.name === "Faces");
    const logos = rows.find((f) => f.name === "Logos");
    expect(colorsFolder?.pinned).toBe(true);
    expect(facesFolder?.pinned).toBe(true);

    // Ahead of the marketer's own folders, so the kit stays at the top of the
    // tab where it has always been.
    expect(colorsFolder!.order).toBeLessThan(facesFolder!.order);
    expect(facesFolder!.order).toBeLessThan(logos!.order);

    for (const color of await colorRows(t)) {
      expect(color.folderIds).toEqual([colorsFolder!._id]);
    }
    for (const font of await fontRows(t)) {
      expect(font.folderIds).toEqual([facesFolder!._id]);
    }
  });

  test("adopts a folder somebody already made rather than adding a second one", async () => {
    const t = newT();
    // Made by hand, not pinned — the marketer got there first.
    const mine = await seedFolder(t, "colors", false);
    await seedOldColor(t, "PW Red", "#891d1a");

    await runMigration(t);

    const rows = await folders(t);
    expect(rows.filter((f) => f.name.toLowerCase() === "colors")).toHaveLength(1);
    expect(rows.find((f) => f._id === mine)?.pinned).toBe(true);
    expect((await colorRows(t))[0].folderIds).toEqual([mine]);
  });

  test("leaves a color somebody already filed exactly where they put it", async () => {
    const t = newT();
    const easter = await seedFolder(t, "Easter 2026");
    const now = Date.now();
    await run(t, (ctx) =>
      ctx.db.insert("brandColors", {
        name: "PW Red",
        hex: "#891d1a",
        folderIds: [easter],
        order: 100,
        createdAt: now,
        updatedAt: now,
      }),
    );

    const result = await runMigration(t);
    expect(result).toMatchObject({ colorsFiled: 0 });
    // No "Colors" folder is invented for a palette that is already filed, and
    // the person's own filing is not added to.
    expect((await folders(t)).map((f) => f.name)).toEqual(["Easter 2026"]);
    expect((await colorRows(t))[0].folderIds).toEqual([easter]);
  });

  test("creates neither folder on a deployment with nothing to put in one", async () => {
    const t = newT();
    const result = await runMigration(t);
    expect(result).toEqual({
      designsConverted: 0,
      colorsFiled: 0,
      fontsFiled: 0,
    });
    expect(await folders(t)).toEqual([]);
  });
});
