import type { MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { Migration } from "./index";
import {
  BRAND_COLOR_MAX_COUNT,
  BRAND_FONT_MAX_COUNT,
  DESIGN_FOLDER_MAX_COUNT,
  DESIGN_MAX_COUNT,
} from "@events-os/shared";

/**
 * Make the folder the primitive: give every design its `folderIds` array, and
 * turn the two hard-coded brand-kit sections into pinned folders holding the
 * rows they used to render.
 *
 * ── What changes under the tab ──────────────────────────────────────────────
 * A design used to point at one folder (`folderId`); colors and faces could not
 * be filed at all, because "Colors" and "Faces" were sections in a screen
 * rather than rows in a table. After this, all three item types carry
 * `folderIds` and a folder may hold any mix of them — so "Easter 2026" can be
 * the red, the face and the posters, which is the whole point of the change.
 *
 * ── Why the tab looks IDENTICAL the moment this runs ────────────────────────
 * That is the design goal, not a coincidence. This migration creates a pinned
 * "Colors" folder holding every existing color and a pinned "Faces" folder
 * holding every existing font, ordered ahead of the marketer's own folders. The
 * screen then renders those two folders as sections — the same swatch wall and
 * specimen wall, in the same order, under the same headings — except that they
 * are now ordinary folders somebody can rename, reorder, unpin or delete.
 *
 * A migration that left the palette unfiled would have been much less code and
 * would have emptied the brand kit on sight.
 *
 * ── Idempotent, and safe to run late ────────────────────────────────────────
 * Every step is keyed off "has this row been converted yet":
 *
 *  · a design is converted only while it still has the dead `folderId`, and the
 *    conversion clears it, so a second run sees nothing to do;
 *  · a color or face is filed only while it is in NO folder at all, so somebody
 *    who has already filed one into their own folder between the deploy and
 *    this line running does not get "Colors" forced onto it as well;
 *  · the two kit folders are matched BY NAME before being created, so a
 *    half-finished run, or a marketer who made their own "Colors" folder first,
 *    produces one folder rather than two.
 *
 * And it creates neither folder on a deployment that has no colors or no fonts
 * to put in it — an empty pinned section is worse than no section.
 */

/** The names the two seeded kit folders get. Matched case-insensitively when
 *  looking for one that already exists. */
const COLORS_FOLDER_NAME = "Colors";
const FACES_FOLDER_NAME = "Faces";

/** How far ahead of the marketer's own folders the kit folders sort. The seed
 *  spaces folders 100 apart, so two steps of 100 leaves room between them. */
const ORDER_STEP = 100;

function dedupe(ids: Id<"designFolders">[]): Id<"designFolders">[] {
  const seen = new Set<string>();
  const out: Id<"designFolders">[] = [];
  for (const id of ids) {
    const key = String(id);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(id);
  }
  return out;
}

/** True when a row has no folder membership at all — the only state this
 *  migration will file into a kit folder. */
function unfiled(row: { folderIds?: Id<"designFolders">[] }): boolean {
  return !row.folderIds || row.folderIds.length === 0;
}

/**
 * The pinned kit folder of that name — the one that already exists (pinning it
 * if somebody made it themselves), or a new one sorted ahead of everything.
 */
async function pinnedFolderNamed(
  ctx: MutationCtx,
  folders: Doc<"designFolders">[],
  name: string,
  order: number,
): Promise<Id<"designFolders">> {
  const now = Date.now();
  const existing = folders.find(
    (f) => f.name.trim().toLowerCase() === name.toLowerCase(),
  );
  if (existing) {
    if (!existing.pinned) {
      await ctx.db.patch(existing._id, { pinned: true, updatedAt: now });
    }
    return existing._id;
  }
  return await ctx.db.insert("designFolders", {
    name,
    pinned: true,
    order,
    createdAt: now,
    updatedAt: now,
  });
}

export const foldersAsPrimitive: Migration = {
  name: "0085_folders_as_primitive",
  run: async (ctx: MutationCtx) => {
    const now = Date.now();

    // ── Designs: the single folder becomes an array of one ──────────────────
    const designs = await ctx.db.query("designAssets").take(DESIGN_MAX_COUNT);
    let designsConverted = 0;
    for (const design of designs) {
      if (!design.folderId) continue;
      const next = dedupe([...(design.folderIds ?? []), design.folderId]);
      await ctx.db.patch(design._id, {
        folderIds: next,
        // Clearing it is what makes this idempotent, and what lets a later
        // change drop the column from the schema entirely.
        folderId: undefined,
        updatedAt: now,
      });
      designsConverted += 1;
    }

    // ── The brand kit becomes two pinned folders ────────────────────────────
    const folders = await ctx.db
      .query("designFolders")
      .take(DESIGN_FOLDER_MAX_COUNT);
    const colors = await ctx.db.query("brandColors").take(BRAND_COLOR_MAX_COUNT);
    const fonts = await ctx.db.query("brandFonts").take(BRAND_FONT_MAX_COUNT);

    const looseColors = colors.filter(unfiled);
    const looseFonts = fonts.filter(unfiled);

    // Sort ahead of whatever the marketer already has, so the palette and the
    // typefaces stay at the top of the tab where they have always been.
    const firstOrder = folders.reduce(
      (min, f) => Math.min(min, f.order),
      ORDER_STEP,
    );

    let colorsFiled = 0;
    if (looseColors.length > 0) {
      const colorsFolder = await pinnedFolderNamed(
        ctx,
        folders,
        COLORS_FOLDER_NAME,
        firstOrder - ORDER_STEP * 2,
      );
      for (const color of looseColors) {
        await ctx.db.patch(color._id, {
          folderIds: [colorsFolder],
          updatedAt: now,
        });
        colorsFiled += 1;
      }
    }

    let fontsFiled = 0;
    if (looseFonts.length > 0) {
      const facesFolder = await pinnedFolderNamed(
        ctx,
        folders,
        FACES_FOLDER_NAME,
        firstOrder - ORDER_STEP,
      );
      for (const font of looseFonts) {
        await ctx.db.patch(font._id, {
          folderIds: [facesFolder],
          updatedAt: now,
        });
        fontsFiled += 1;
      }
    }

    return { designsConverted, colorsFiled, fontsFiled };
  },
};
