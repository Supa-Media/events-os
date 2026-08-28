/**
 * THE BRAND KIT AND THE DESIGN LIBRARY — the Marketing desk's Designs tab.
 *
 * Read `schema/marketingDesigns.ts` for the tables and `@events-os/shared`'s
 * `marketingDesigns.ts` for the vocabulary, the bounds, and the wire contract.
 * This module is the functions: what the tab reads, what a holder may change,
 * and the serializers that turn rows into `DesignLibrary`.
 *
 * ── The shape this copies ───────────────────────────────────────────────────
 * `marketingSite.ts`, deliberately and closely: `clean()`/`requireWithin()`
 * input hygiene, sparse `ORDER_STEP`-spaced ordering, whole-list `reorder*`
 * mutations rather than move-one-row deltas, a `seed*IfEmpty` internalMutation,
 * and a power-scoped upload URL. Two sibling tabs on one desk that behave
 * differently for no reason is a tax the marketer pays, not us.
 *
 * ── THE ONE PLACE IT DIVERGES: reading is ungated ───────────────────────────
 * `siteContent` opens with `requireSiteEdit`. `library` opens with
 * `requireUserId` and nothing else, and that is the feature rather than an
 * oversight. `marketing.designs.edit` has no `view` sibling and
 * `lib/marketingAccess.ts` deliberately ships no `requireDesignsView` — a
 * chapter volunteer making a flyer at 11pm needs the hex code and the logo, and
 * a brand kit behind a permission is a brand kit people work around, which is
 * the exact inconsistency the kit exists to prevent. `canEdit` on the payload
 * is how the tab renders read-only instead of refusing.
 *
 * Every WRITE goes through `requireDesignsEdit`. Nothing in this file checks a
 * seat, a title, or a chapter inline.
 *
 * ── Two rules that already cost this repo something ─────────────────────────
 *  1. KEEP-IF-NOT-RESENT on every image field. `upsertLink`'s `clearThumbnail`
 *     doc has the incident: the editor posts its whole form on every save and
 *     carries no file bytes, so "not sent" meaning "delete" turned a rename
 *     into silent artwork loss with no way back from inside the app. Removing
 *     an image here is always an explicit `clearImage`/`clearThumbnail`.
 *  2. NEVER store a third party's CDN URL as artwork. `*.canva-cdn.email`
 *     image URLs EXPIRE — pasted newsletter designs went blank weeks later and
 *     had to be re-hosted, which is part of why `emailHtmlImport.ts` exists. A
 *     design's `url` is the stable share/edit link; its picture is always an
 *     upload we host, resolved through `ctx.storage`.
 */
import { ConvexError, v } from "convex/values";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import {
  BRAND_COLOR_MAX_COUNT,
  BRAND_COLOR_NAME_MAX,
  BRAND_COLOR_USAGE_MAX,
  BRAND_FONT_MAX_COUNT,
  BRAND_FONT_NAME_MAX,
  BRAND_FONT_NOTES_MAX,
  BRAND_FONT_ROLES,
  DESIGN_FOLDER_MAX_COUNT,
  DESIGN_FOLDER_NAME_MAX,
  DESIGN_KINDS,
  DESIGN_MAX_COUNT,
  DESIGN_NOTES_MAX,
  DESIGN_TITLE_MAX,
  designEmbedUrl,
  isAllowedDesignUrl,
  isBrandHex,
  normalizeBrandHex,
  type BrandColor,
  type BrandFont,
  type DesignAsset,
  type DesignFolder,
  type DesignLibrary,
} from "@events-os/shared";
import { requireDesignsEdit, resolveMarketingAccess } from "./lib/marketingAccess";
import {
  PAGE_FETCH_HEADERS,
  coverPageUrl,
  extractOgImageUrl,
  isFetchableImageUrl,
  oembedEndpointFor,
  oembedThumbnailUrl,
} from "./lib/ogImage";
import { requireUserId } from "./lib/context";
import {
  BRAND_COLOR_SEED,
  BRAND_FONT_SEED,
  DESIGN_FOLDER_SEED,
} from "./lib/seed/brandKit";

/**
 * Order values are spaced this far apart so a reorder rewrites the rows that
 * moved rather than every row after them. Same constant, same reason, as
 * `marketingSite.ts`.
 */
const ORDER_STEP = 100;

const fontRoleValidator = v.union(...BRAND_FONT_ROLES.map((r) => v.literal(r)));
const designKindValidator = v.union(...DESIGN_KINDS.map((k) => v.literal(k)));

// ── input hygiene ────────────────────────────────────────────────────────────
// Lifted verbatim from `marketingSite.ts`. Not shared into a helper module: two
// four-line functions with identical bodies are cheaper to read in place than
// an import that makes the reader open another file to learn that `clean`
// trims.

/** Trim; treat an empty string as "not set" so a cleared field stops being
 *  stored at all rather than persisting as `""` every reader special-cases. */
function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Enforce a length bound, naming the field.
 *
 * A throw rather than a truncation, for the same reason `marketingSite.ts`
 * gives: silently cutting a title publishes something nobody wrote. Here it
 * also protects the library's scannability — a 400-character "title" turns the
 * grid into a wall.
 */
function requireWithin(
  value: string | undefined,
  max: number,
  field: string,
): void {
  if (value !== undefined && value.length > max) {
    throw new ConvexError({
      code: "TOO_LONG",
      message: `${field} is too long — keep it under ${max} characters.`,
    });
  }
}

/**
 * Resolve an uploaded blob to the public URL we cache alongside its storage id,
 * refusing one that does not resolve.
 *
 * Both halves are `emailImages.ts`'s pattern and both are load-bearing. The
 * CACHE is why `library` can list five hundred designs without paying five
 * hundred `ctx.storage.getUrl` round trips inside one query. The REFUSAL is
 * because a row whose picture can never render is worse than no row at all —
 * nobody notices a null URL until the design is on a wall.
 */
async function resolveUpload(
  ctx: MutationCtx,
  storageId: Id<"_storage">,
): Promise<string> {
  const url = await ctx.storage.getUrl(storageId);
  if (!url) {
    throw new ConvexError({
      code: "UPLOAD_NOT_FOUND",
      message: "That upload couldn't be found — try adding the file again.",
    });
  }
  return url;
}

/**
 * The whole-list reorder every `reorder*` mutation here runs.
 *
 * Whole-list rather than a move-one-row delta because the caller is a
 * drag-and-drop list that already knows the final order, and because rewriting
 * `order` from a list the caller supplies cannot leave two rows claiming one
 * slot. Ids the caller omits keep their relative place AFTER everything named,
 * so a stale client that forgets a row appends it instead of losing it. A row
 * deleted mid-drag is skipped rather than failing the whole move.
 *
 * Generic over the four ordered tables rather than copied four times: unlike
 * `clean`, the body is long enough that four drifting copies is a real risk,
 * and every one of these tables carries the same `order`/`updatedAt`/`updatedBy`
 * triple. The `Id<"brandColors">` casts are a TYPE-LEVEL convenience only —
 * `ctx.db.get`/`patch` resolve the id's real table at runtime, and the four
 * tables' `order`/`updatedAt`/`updatedBy` columns are identical, which is the
 * precondition the `OrderedTable` union documents.
 */
type OrderedTable = "brandColors" | "brandFonts" | "designFolders" | "designAssets";

async function applyOrder(
  ctx: MutationCtx,
  table: OrderedTable,
  ids: Id<OrderedTable>[],
  scanLimit: number,
  userId: Id<"users">,
): Promise<void> {
  const now = Date.now();
  const patch = (id: Id<OrderedTable>, order: number) =>
    ctx.db.patch(id as Id<"brandColors">, {
      order,
      updatedAt: now,
      updatedBy: userId,
    });

  let order = ORDER_STEP;
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(String(id))) continue;
    seen.add(String(id));
    const doc = await ctx.db.get(id as Id<"brandColors">);
    if (!doc) continue; // deleted mid-drag — skip, don't fail the whole move
    await patch(id, order);
    order += ORDER_STEP;
  }
  // The tail — rows the caller did not name — keeps its RELATIVE order, which
  // means reading it through `by_order` rather than the table's creation order.
  // A bare `ctx.db.query(table)` returns rows oldest-first, so a row added
  // while the drag was in flight would be interleaved by age instead of
  // appended, silently reshuffling a list the caller thought it had fixed.
  const rest = await ctx.db.query(table).withIndex("by_order").take(scanLimit);
  for (const doc of rest) {
    if (seen.has(String(doc._id))) continue;
    await patch(doc._id, order);
    order += ORDER_STEP;
  }
}

/**
 * Delete the storage blobs a save has just orphaned.
 *
 * Called after the row is patched, with the storage ids that SURVIVED. Anything
 * the old row pointed at that the new one does not is now unreachable through
 * the library — and a Convex blob with no row pointing at it is not garbage
 * collected, it is simply a file at a permanent, unauthenticated URL that
 * somebody may still have.
 *
 * That URL is the whole reason this exists. `ctx.storage.getUrl` returns an
 * address that never rotates and never expires, and the library caches it on
 * the row precisely so a picker does not pay a round trip per image — so a
 * "removed" background that only had its id unset stays fetchable by anyone
 * who ever loaded the desk. `deleteDesign` already hard-deletes for this
 * reason; leaving replace and clear behind would mean the same button taught
 * two different things about what "remove" does.
 *
 * Best-effort per blob: a storage id that is already gone (a double-save, a
 * hand-cleaned deployment) must not fail a save that has otherwise committed.
 */
async function dropOrphanedBlobs(
  ctx: MutationCtx,
  previous: Doc<"designAssets">,
  keptImage: Id<"_storage"> | undefined,
  keptThumbnail: Id<"_storage"> | undefined,
): Promise<void> {
  const kept = new Set(
    [keptImage, keptThumbnail].filter(Boolean).map((id) => String(id)),
  );
  for (const old of [previous.imageStorage, previous.thumbnailStorage]) {
    if (!old || kept.has(String(old))) continue;
    try {
      await ctx.storage.delete(old);
    } catch {
      // Already gone. Nothing to clean up, and nothing worth failing over.
    }
  }
}

/** The next free slot at the end of a list, from rows already read. */
function nextOrder(rows: { order: number }[]): number {
  return rows.reduce((max, r) => Math.max(max, r.order), 0) + ORDER_STEP;
}

// ── serialization ────────────────────────────────────────────────────────────

function serializeColor(doc: Doc<"brandColors">): BrandColor {
  return {
    id: String(doc._id),
    name: doc.name,
    hex: doc.hex,
    usage: doc.usage ?? null,
    order: doc.order,
  };
}

function serializeFont(doc: Doc<"brandFonts">): BrandFont {
  return {
    id: String(doc._id),
    name: doc.name,
    role: doc.role,
    sourceUrl: doc.sourceUrl ?? null,
    notes: doc.notes ?? null,
    order: doc.order,
  };
}

function serializeFolder(
  doc: Doc<"designFolders">,
  designCount: number,
): DesignFolder {
  return {
    id: String(doc._id),
    name: doc.name,
    parentId: doc.parentId ? String(doc.parentId) : null,
    order: doc.order,
    designCount,
  };
}

/**
 * One design row as the tab renders it.
 *
 * `embedUrl` is COMPUTED here, never stored — `designEmbedUrl`'s doc explains
 * why (fixing the embed rule then fixes every existing row, and a stored embed
 * URL is a second copy of the link that can disagree with the first). The image
 * URLs, by contrast, ARE stored: they are the resolution of a blob we own, not
 * a rewriting of something the user typed.
 */
function serializeDesign(doc: Doc<"designAssets">): DesignAsset {
  return {
    id: String(doc._id),
    kind: doc.kind,
    title: doc.title,
    folderId: doc.folderId ? String(doc.folderId) : null,
    url: doc.url ?? null,
    embedUrl: designEmbedUrl(doc.url),
    imageUrl: doc.imageUrl ?? null,
    thumbnailUrl: doc.thumbnailUrl ?? null,
    notes: doc.notes ?? null,
    order: doc.order,
    updatedAt: doc.updatedAt,
  };
}

// ── The read ─────────────────────────────────────────────────────────────────

/**
 * Everything the Designs tab renders, in one document.
 *
 * UNGATED beyond being signed in — see this module's doc, and
 * `marketing.designs.edit`'s. `requireUserId` is the only check, so a signed-out
 * caller still gets an honest "sign in" rather than a silently empty kit.
 *
 * One read rather than four paged ones because the whole library is bounded by
 * the contract's `*_MAX_COUNT` constants (24 colors, 12 fonts, 60 folders, 500
 * designs) — small enough that paging it would be more code than it saves, and
 * the tab wants all of it at once anyway to group designs under their folders.
 *
 * `designCount` is computed here from the designs already in hand rather than
 * stored on the folder row: a stored counter is a second source of truth, and
 * it goes wrong the first time a design moves by a path that forgets to
 * decrement it.
 */
export const library = query({
  args: {},
  handler: async (ctx): Promise<DesignLibrary> => {
    await requireUserId(ctx);
    const access = await resolveMarketingAccess(ctx);

    const colors = await ctx.db
      .query("brandColors")
      .withIndex("by_order")
      .take(BRAND_COLOR_MAX_COUNT);
    const fonts = await ctx.db
      .query("brandFonts")
      .withIndex("by_order")
      .take(BRAND_FONT_MAX_COUNT);
    const folders = await ctx.db
      .query("designFolders")
      .withIndex("by_order")
      .take(DESIGN_FOLDER_MAX_COUNT);
    const designs = await ctx.db
      .query("designAssets")
      .withIndex("by_order")
      .take(DESIGN_MAX_COUNT);

    const counts = new Map<string, number>();
    for (const design of designs) {
      if (!design.folderId) continue;
      const key = String(design.folderId);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    return {
      colors: colors.map(serializeColor),
      fonts: fonts.map(serializeFont),
      folders: folders.map((f) =>
        serializeFolder(f, counts.get(String(f._id)) ?? 0),
      ),
      designs: designs.map(serializeDesign),
      canEdit: access.canEditDesigns,
    };
  },
});

// ── Colors ───────────────────────────────────────────────────────────────────

/**
 * Add or edit one brand color. A new color lands at the end of the swatch row.
 *
 * The hex is validated with `isBrandHex` and stored with `normalizeBrandHex`,
 * so `#891D1A`, `#891d1a`, and (for a three-digit color) `#abc` cannot become
 * two entries for one color. `rgb()`, `hsl()`, and named colors are refused
 * rather than converted — `isBrandHex`'s doc has the argument: a kit's whole
 * job is that two people typing the same color get the same bytes.
 */
export const upsertColor = mutation({
  args: {
    colorId: v.optional(v.id("brandColors")),
    name: v.string(),
    hex: v.string(),
    usage: v.optional(v.string()),
  },
  returns: v.id("brandColors"),
  handler: async (ctx, args) => {
    await requireDesignsEdit(ctx);
    const userId = (await requireUserId(ctx)) as Id<"users">;

    const name = clean(args.name);
    const usage = clean(args.usage);
    if (!name) {
      throw new ConvexError({
        code: "INCOMPLETE",
        message: "A color needs a name — what does the team call it?",
      });
    }
    requireWithin(name, BRAND_COLOR_NAME_MAX, "The color's name");
    requireWithin(usage, BRAND_COLOR_USAGE_MAX, "The usage note");

    if (!isBrandHex(args.hex)) {
      throw new ConvexError({
        code: "INVALID_HEX",
        message:
          "That isn't a hex color. Use a code like #891d1a (or #abc) — not rgb(), hsl(), or a color name.",
      });
    }
    const hex = normalizeBrandHex(args.hex);

    const now = Date.now();
    if (args.colorId) {
      const existing = await ctx.db.get(args.colorId);
      if (!existing) {
        throw new ConvexError({
          code: "NOT_FOUND",
          message: "That color is no longer in the kit.",
        });
      }
      await ctx.db.patch(args.colorId, {
        name,
        hex,
        usage,
        updatedAt: now,
        updatedBy: userId,
      });
      return args.colorId;
    }

    const rows = await ctx.db.query("brandColors").take(BRAND_COLOR_MAX_COUNT);
    if (rows.length >= BRAND_COLOR_MAX_COUNT) {
      throw new ConvexError({
        code: "TOO_MANY",
        message: `The kit holds at most ${BRAND_COLOR_MAX_COUNT} colors. A palette longer than that stops being a palette — retire one first.`,
      });
    }
    return await ctx.db.insert("brandColors", {
      name,
      hex,
      usage,
      order: nextOrder(rows),
      createdAt: now,
      updatedAt: now,
      updatedBy: userId,
    });
  },
});

/** Remove a color. Idempotent — a second delete is a no-op, not an error,
 *  because two people clearing the same swatch is a race nobody should see. */
export const deleteColor = mutation({
  args: { colorId: v.id("brandColors") },
  returns: v.null(),
  handler: async (ctx, { colorId }) => {
    await requireDesignsEdit(ctx);
    const existing = await ctx.db.get(colorId);
    if (existing) await ctx.db.delete(colorId);
    return null;
  },
});

/** Reorder the swatch row. Whole-list contract — see `applyOrder`. */
export const reorderColors = mutation({
  args: { colorIds: v.array(v.id("brandColors")) },
  returns: v.null(),
  handler: async (ctx, { colorIds }) => {
    await requireDesignsEdit(ctx);
    const userId = (await requireUserId(ctx)) as Id<"users">;
    await applyOrder(ctx, "brandColors", colorIds, BRAND_COLOR_MAX_COUNT, userId);
    return null;
  },
});

// ── Fonts ────────────────────────────────────────────────────────────────────

/**
 * Add or edit one typeface.
 *
 * SEVERAL FONTS MAY SHARE A ROLE, on purpose. The kit ships with both the
 * Academy lesson's three faces and the newsletter's Inter because the repo
 * genuinely says both (see `lib/seed/brandKit.ts`'s doc), and a uniqueness
 * check here would have forced a seed to pick a winner in a brand argument it
 * has no standing to settle. The roles sort the kit; they do not police it.
 *
 * `sourceUrl` is validated with the same `isAllowedDesignUrl` a design's link
 * is, rather than a looser check: it is a link a volunteer will click while
 * looking for a font file, and there is no reason for it to be anything but
 * https (or a `mailto:` to whoever has the licence).
 */
export const upsertFont = mutation({
  args: {
    fontId: v.optional(v.id("brandFonts")),
    name: v.string(),
    role: fontRoleValidator,
    sourceUrl: v.optional(v.string()),
    notes: v.optional(v.string()),
  },
  returns: v.id("brandFonts"),
  handler: async (ctx, args) => {
    await requireDesignsEdit(ctx);
    const userId = (await requireUserId(ctx)) as Id<"users">;

    const name = clean(args.name);
    const sourceUrl = clean(args.sourceUrl);
    const notes = clean(args.notes);
    if (!name) {
      throw new ConvexError({
        code: "INCOMPLETE",
        message: "A font needs its real name — the one you'd search for.",
      });
    }
    requireWithin(name, BRAND_FONT_NAME_MAX, "The font's name");
    requireWithin(notes, BRAND_FONT_NOTES_MAX, "The note");
    if (sourceUrl && !isAllowedDesignUrl(sourceUrl)) {
      throw new ConvexError({
        code: "INVALID_URL",
        message:
          "That download link isn't one the kit can store. Use a full https:// address, or an email link.",
      });
    }

    const now = Date.now();
    if (args.fontId) {
      const existing = await ctx.db.get(args.fontId);
      if (!existing) {
        throw new ConvexError({
          code: "NOT_FOUND",
          message: "That font is no longer in the kit.",
        });
      }
      await ctx.db.patch(args.fontId, {
        name,
        role: args.role,
        sourceUrl,
        notes,
        updatedAt: now,
        updatedBy: userId,
      });
      return args.fontId;
    }

    const rows = await ctx.db.query("brandFonts").take(BRAND_FONT_MAX_COUNT);
    if (rows.length >= BRAND_FONT_MAX_COUNT) {
      throw new ConvexError({
        code: "TOO_MANY",
        message: `The kit holds at most ${BRAND_FONT_MAX_COUNT} fonts. If you need a thirteenth, one of the twelve isn't a brand font.`,
      });
    }
    return await ctx.db.insert("brandFonts", {
      name,
      role: args.role,
      sourceUrl,
      notes,
      order: nextOrder(rows),
      createdAt: now,
      updatedAt: now,
      updatedBy: userId,
    });
  },
});

/** Remove a font. Idempotent, like `deleteColor`. */
export const deleteFont = mutation({
  args: { fontId: v.id("brandFonts") },
  returns: v.null(),
  handler: async (ctx, { fontId }) => {
    await requireDesignsEdit(ctx);
    const existing = await ctx.db.get(fontId);
    if (existing) await ctx.db.delete(fontId);
    return null;
  },
});

/** Reorder the font list. Whole-list contract — see `applyOrder`. */
export const reorderFonts = mutation({
  args: { fontIds: v.array(v.id("brandFonts")) },
  returns: v.null(),
  handler: async (ctx, { fontIds }) => {
    await requireDesignsEdit(ctx);
    const userId = (await requireUserId(ctx)) as Id<"users">;
    await applyOrder(ctx, "brandFonts", fontIds, BRAND_FONT_MAX_COUNT, userId);
    return null;
  },
});

// ── Folders ──────────────────────────────────────────────────────────────────

/**
 * Assert that filing `folderId` under `parentId` keeps the library one level
 * deep.
 *
 * The rule is `schema/services.ts#serviceOptions`', copied because the reason
 * is identical: a row may point at a parent, but a row that HAS a parent may
 * never be pointed at as someone else's parent. Convex has no cross-row schema
 * constraint, so the only place "no grandparents" can live is write time —
 * which means BOTH directions have to be checked here:
 *
 *   · the proposed parent must not itself be a child, and
 *   · the folder being re-filed must not already have children of its own.
 *
 * Checking only the first is the bug this comment exists to prevent: it lets a
 * top-level folder WITH children be dragged under another folder, which
 * produces grandchildren by the back door and a tree the next reader cannot
 * explain.
 */
async function requireOneLevelDeep(
  ctx: MutationCtx,
  parentId: Id<"designFolders">,
  folderId: Id<"designFolders"> | undefined,
): Promise<void> {
  if (folderId && String(parentId) === String(folderId)) {
    throw new ConvexError({
      code: "INVALID_PARENT",
      message: "A folder can't be inside itself.",
    });
  }
  const parent = await ctx.db.get(parentId);
  if (!parent) {
    throw new ConvexError({
      code: "NOT_FOUND",
      message: "That parent folder no longer exists.",
    });
  }
  if (parent.parentId) {
    throw new ConvexError({
      code: "TOO_DEEP",
      message: `Folders only nest one level deep. "${parent.name}" is already inside another folder — pick a top-level folder instead.`,
    });
  }
  if (folderId) {
    const children = await ctx.db
      .query("designFolders")
      .withIndex("by_parent", (q) => q.eq("parentId", folderId))
      .take(1);
    if (children.length > 0) {
      throw new ConvexError({
        code: "TOO_DEEP",
        message:
          "This folder has folders inside it, so it can't be moved into another one. Move or delete its sub-folders first.",
      });
    }
  }
}

/**
 * Add or edit one folder. A new folder lands at the end of the list.
 *
 * `parentId` is KEEP-IF-NOT-RESENT on an update, and un-nesting is the explicit
 * `clearParent` flag — the same discipline the image fields use, for the same
 * reason: an editor that posts its whole form must not be able to silently
 * re-file a shelf (and everything on it) by omitting a field. On CREATE there
 * is nothing to keep, so an omitted `parentId` simply means top-level.
 */
export const upsertFolder = mutation({
  args: {
    folderId: v.optional(v.id("designFolders")),
    name: v.string(),
    parentId: v.optional(v.id("designFolders")),
    /** Move this folder back to the top level. See the mutation's doc. */
    clearParent: v.optional(v.boolean()),
  },
  returns: v.id("designFolders"),
  handler: async (ctx, args) => {
    await requireDesignsEdit(ctx);
    const userId = (await requireUserId(ctx)) as Id<"users">;

    const name = clean(args.name);
    if (!name) {
      throw new ConvexError({
        code: "INCOMPLETE",
        message: "A folder needs a name.",
      });
    }
    requireWithin(name, DESIGN_FOLDER_NAME_MAX, "The folder name");

    const now = Date.now();
    if (args.folderId) {
      const existing = await ctx.db.get(args.folderId);
      if (!existing) {
        throw new ConvexError({
          code: "NOT_FOUND",
          message: "That folder no longer exists.",
        });
      }
      const parentId = args.clearParent
        ? undefined
        : (args.parentId ?? existing.parentId);
      if (parentId) await requireOneLevelDeep(ctx, parentId, args.folderId);
      await ctx.db.patch(args.folderId, {
        name,
        parentId,
        updatedAt: now,
        updatedBy: userId,
      });
      return args.folderId;
    }

    if (args.parentId) await requireOneLevelDeep(ctx, args.parentId, undefined);
    const rows = await ctx.db.query("designFolders").take(DESIGN_FOLDER_MAX_COUNT);
    if (rows.length >= DESIGN_FOLDER_MAX_COUNT) {
      throw new ConvexError({
        code: "TOO_MANY",
        message: `The library holds at most ${DESIGN_FOLDER_MAX_COUNT} folders. Past that it's a filing system nobody else can navigate.`,
      });
    }
    return await ctx.db.insert("designFolders", {
      name,
      parentId: args.parentId,
      order: nextOrder(rows),
      createdAt: now,
      updatedAt: now,
      updatedBy: userId,
    });
  },
});

/**
 * Delete a folder, moving anything filed in it to Unfiled.
 *
 * DESIGNS ARE NEVER ORPHANED INVISIBLY. Deleting the row without touching its
 * designs would leave them pointing at a folder that no longer exists: `library`
 * would file them under a folder it cannot name, and to the marketer they would
 * simply be gone — which is the worst possible outcome for the one surface whose
 * entire job is "I know we made a flyer for this". So they move to Unfiled,
 * where they are still visible and re-filable, and the return value SAYS HOW
 * MANY moved so the tab can tell the human ("Deleted Flyers — 12 designs moved
 * to Unfiled") instead of leaving them to discover it.
 *
 * A folder with a sub-folder is refused rather than cascaded. A cascade here
 * would delete a shelf the person deleting may never have opened; making them
 * empty it first is one extra click and no surprises.
 */
export const deleteFolder = mutation({
  args: { folderId: v.id("designFolders") },
  returns: v.object({ movedDesigns: v.number() }),
  handler: async (ctx, { folderId }) => {
    await requireDesignsEdit(ctx);
    const userId = (await requireUserId(ctx)) as Id<"users">;

    const existing = await ctx.db.get(folderId);
    // Idempotent, like the other deletes — a second call reports an honest zero
    // rather than throwing at somebody who double-tapped.
    if (!existing) return { movedDesigns: 0 };

    const children = await ctx.db
      .query("designFolders")
      .withIndex("by_parent", (q) => q.eq("parentId", folderId))
      .take(DESIGN_FOLDER_MAX_COUNT);
    if (children.length > 0) {
      throw new ConvexError({
        code: "HAS_CHILDREN",
        message: `"${existing.name}" still has ${children.length === 1 ? "a folder" : `${children.length} folders`} inside it. Delete or move ${children.length === 1 ? "it" : "them"} first.`,
      });
    }

    const designs = await ctx.db
      .query("designAssets")
      .withIndex("by_folder", (q) => q.eq("folderId", folderId))
      .take(DESIGN_MAX_COUNT);
    const now = Date.now();
    for (const design of designs) {
      await ctx.db.patch(design._id, {
        folderId: undefined,
        updatedAt: now,
        updatedBy: userId,
      });
    }

    await ctx.db.delete(folderId);
    return { movedDesigns: designs.length };
  },
});

/** Reorder the folder list. Whole-list contract — see `applyOrder`. Order is
 *  flat across every folder, parents and children alike; the tab nests them for
 *  display using `parentId`, so one sequence keeps a child next to its parent
 *  after a drag instead of splitting the pair. */
export const reorderFolders = mutation({
  args: { folderIds: v.array(v.id("designFolders")) },
  returns: v.null(),
  handler: async (ctx, { folderIds }) => {
    await requireDesignsEdit(ctx);
    const userId = (await requireUserId(ctx)) as Id<"users">;
    await applyOrder(
      ctx,
      "designFolders",
      folderIds,
      DESIGN_FOLDER_MAX_COUNT,
      userId,
    );
    return null;
  },
});

// ── Designs ──────────────────────────────────────────────────────────────────

/**
 * Add or edit one design.
 *
 * ── KEEP-IF-NOT-RESENT, on every image field ────────────────────────────────
 * `imageStorage` and `thumbnailStorage` omitted means KEEP. Removing artwork is
 * always the explicit `clearImage` / `clearThumbnail` flag. This is not a
 * hypothetical: `marketingSite.ts#upsertLink` shipped the other way and a
 * rename silently stripped the logo off a live card with no way to put it back
 * from inside the app. The editor posts its whole form on every save and cannot
 * carry the file bytes, so "not sent" can only ever mean "unchanged".
 *
 * `folderId` follows the same rule and for the same reason — omitting it keeps
 * the design where it is. Moving a design (or unfiling it) is
 * `moveDesignToFolder`, which is a one-argument mutation precisely so the drag
 * that moves a design cannot also rewrite its title.
 *
 * ── What a row must have ────────────────────────────────────────────────────
 * A design has to be findable: an `image` needs an upload (or a link), and
 * every other kind needs a URL. A row with neither is a title in a grid, which
 * is worse than nothing because it looks like the file exists.
 *
 * ── What is NOT checked, deliberately ───────────────────────────────────────
 * `kind` is not verified against the URL's host. A Canva FOLDER link, or a
 * Figma team page, is a legitimate row that `designEmbedUrl` will (correctly)
 * refuse to embed — and forcing those to be filed as `link` would throw away
 * the one thing the marketer was trying to record, which is what tool the file
 * is in. Embedding is best-effort by contract: `embedUrl` is null and the tab
 * falls back to a plain link.
 */
export const upsertDesign = mutation({
  args: {
    designId: v.optional(v.id("designAssets")),
    kind: designKindValidator,
    title: v.string(),
    folderId: v.optional(v.id("designFolders")),
    url: v.optional(v.string()),
    notes: v.optional(v.string()),
    imageStorage: v.optional(v.id("_storage")),
    thumbnailStorage: v.optional(v.id("_storage")),
    /** Remove the uploaded artwork. See this mutation's keep-if-not-resent doc. */
    clearImage: v.optional(v.boolean()),
    /** Remove the hosted preview. Same rule. */
    clearThumbnail: v.optional(v.boolean()),
  },
  returns: v.id("designAssets"),
  handler: async (ctx, args) => {
    await requireDesignsEdit(ctx);
    const userId = (await requireUserId(ctx)) as Id<"users">;

    const title = clean(args.title);
    const url = clean(args.url);
    const notes = clean(args.notes);
    if (!title) {
      throw new ConvexError({
        code: "INCOMPLETE",
        message: "A design needs a title — what would you search for to find it?",
      });
    }
    requireWithin(title, DESIGN_TITLE_MAX, "The title");
    requireWithin(notes, DESIGN_NOTES_MAX, "The note");
    if (url && !isAllowedDesignUrl(url)) {
      throw new ConvexError({
        code: "INVALID_URL",
        message:
          "That link isn't one the library can store. Use a full https:// address (the Canva or Figma share link), or an email link.",
      });
    }

    const existing = args.designId ? await ctx.db.get(args.designId) : null;
    if (args.designId && !existing) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "That design is no longer in the library.",
      });
    }

    // Resolve the two uploads FIRST, so a bad storage id fails before anything
    // is written — a half-saved design with the new title and the old picture
    // is a state nobody asked for.
    //
    // Whatever this save orphans is hard-deleted at the end, after the row is
    // written. Unsetting the id alone leaves the blob fetchable at the URL the
    // library already handed out, which is the exact outcome `deleteDesign`
    // hard-deletes to prevent — "removed" has to mean removed, or the two
    // paths teach different things about the same button.
    const image = args.clearImage
      ? { storage: undefined, url: undefined }
      : args.imageStorage
        ? {
            storage: args.imageStorage,
            url: await resolveUpload(ctx, args.imageStorage),
          }
        : { storage: existing?.imageStorage, url: existing?.imageUrl };
    const thumbnail = args.clearThumbnail
      ? { storage: undefined, url: undefined }
      : args.thumbnailStorage
        ? {
            storage: args.thumbnailStorage,
            url: await resolveUpload(ctx, args.thumbnailStorage),
          }
        : { storage: existing?.thumbnailStorage, url: existing?.thumbnailUrl };

    if (args.kind === "image") {
      if (!image.storage && !url) {
        throw new ConvexError({
          code: "INCOMPLETE",
          message: "An image design needs the picture itself — upload a file, or add a link to it.",
        });
      }
    } else if (!url) {
      throw new ConvexError({
        code: "INCOMPLETE",
        message: "A design needs a link — paste the Canva, Figma, or file URL.",
      });
    }

    const now = Date.now();
    const fields = {
      kind: args.kind,
      title,
      url,
      notes,
      imageStorage: image.storage,
      imageUrl: image.url,
      thumbnailStorage: thumbnail.storage,
      thumbnailUrl: thumbnail.url,
      updatedAt: now,
      updatedBy: userId,
    };

    if (args.designId && existing) {
      await ctx.db.patch(args.designId, {
        ...fields,
        // Keep-if-not-resent — moving is `moveDesignToFolder`'s job.
        folderId: args.folderId ?? existing.folderId,
      });
      // AFTER the row is written, never before: if the patch failed we would
      // have deleted the blob a still-live row points at.
      await dropOrphanedBlobs(ctx, existing, image.storage, thumbnail.storage);
      if (url && !thumbnail.storage) {
        // A linked design saved without a cover gets one captured from its own
        // page (see the covers section below). `onlyIfBare` makes this safe to
        // schedule redundantly: it fills a blank and never overwrites.
        await ctx.scheduler.runAfter(0, internal.marketingDesigns.captureCover, {
          designId: args.designId,
          onlyIfBare: true,
        });
      }
      return args.designId;
    }

    if (args.folderId && !(await ctx.db.get(args.folderId))) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "That folder no longer exists — pick another one.",
      });
    }
    const rows = await ctx.db.query("designAssets").take(DESIGN_MAX_COUNT);
    if (rows.length >= DESIGN_MAX_COUNT) {
      throw new ConvexError({
        code: "TOO_MANY",
        message: `The library holds at most ${DESIGN_MAX_COUNT} designs. Delete something retired before adding another.`,
      });
    }
    const designId = await ctx.db.insert("designAssets", {
      ...fields,
      folderId: args.folderId,
      order: nextOrder(rows),
      createdAt: now,
    });
    if (url && !thumbnail.storage) {
      // Same capture as the edit path — a brand-new Canva link should get its
      // real cover without anyone screenshotting anything.
      await ctx.scheduler.runAfter(0, internal.marketingDesigns.captureCover, {
        designId,
        onlyIfBare: true,
      });
    }
    return designId;
  },
});

/**
 * Remove a design, and the blobs behind it.
 *
 * A HARD delete of the uploads, matching `emailImages.deleteImage`: the file is
 * the point, and leaving the blob behind would keep the artwork publicly
 * fetchable at its URL forever, which is exactly what somebody deleting a
 * design is trying to prevent. The blobs go first — if a storage delete fails,
 * the row survives and a human still has something to retry on; the reverse
 * order would orphan a blob with nothing left pointing at it.
 *
 * The linked Canva/Figma file is untouched, obviously. This deletes the
 * library's card, not the org's design.
 */
export const deleteDesign = mutation({
  args: { designId: v.id("designAssets") },
  returns: v.null(),
  handler: async (ctx, { designId }) => {
    await requireDesignsEdit(ctx);
    const existing = await ctx.db.get(designId);
    if (!existing) return null; // already gone — deleting is idempotent
    if (existing.imageStorage) await ctx.storage.delete(existing.imageStorage);
    if (existing.thumbnailStorage) {
      await ctx.storage.delete(existing.thumbnailStorage);
    }
    await ctx.db.delete(designId);
    return null;
  },
});

/** Reorder the library. Whole-list contract — see `applyOrder`. One sequence
 *  across every folder, because a design that moves shelves keeps a coherent
 *  position instead of landing at an arbitrary point in its new folder. */
export const reorderDesigns = mutation({
  args: { designIds: v.array(v.id("designAssets")) },
  returns: v.null(),
  handler: async (ctx, { designIds }) => {
    await requireDesignsEdit(ctx);
    const userId = (await requireUserId(ctx)) as Id<"users">;
    await applyOrder(ctx, "designAssets", designIds, DESIGN_MAX_COUNT, userId);
    return null;
  },
});

/**
 * File a design on a different shelf, or take it off all of them.
 *
 * Its own mutation rather than a field on `upsertDesign` because the caller is
 * a drag between folders, which knows the design and the destination and
 * nothing else. Making it post the whole form to move one card is how a drag
 * ends up overwriting a title somebody edited in another tab.
 *
 * An omitted `folderId` UNFILES — here, and only here, "not sent" means
 * "remove", because that is the entire argument the caller is making.
 */
export const moveDesignToFolder = mutation({
  args: {
    designId: v.id("designAssets"),
    /** Omit to unfile. */
    folderId: v.optional(v.id("designFolders")),
  },
  returns: v.null(),
  handler: async (ctx, { designId, folderId }) => {
    await requireDesignsEdit(ctx);
    const userId = (await requireUserId(ctx)) as Id<"users">;

    const existing = await ctx.db.get(designId);
    if (!existing) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "That design is no longer in the library.",
      });
    }
    if (folderId && !(await ctx.db.get(folderId))) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "That folder no longer exists — pick another one.",
      });
    }
    await ctx.db.patch(designId, {
      folderId,
      updatedAt: Date.now(),
      updatedBy: userId,
    });
    return null;
  },
});

// ── Uploads ──────────────────────────────────────────────────────────────────

/**
 * An upload URL for design artwork or a thumbnail.
 *
 * Gated on `marketing.designs.edit` rather than reusing the general
 * `storage.generateUploadUrl`, which ANY signed-in user can call. Reading this
 * library is ungated on purpose; writing to the org's blob store through the
 * Designs tab is not, and a desk's uploads should carry the desk's power. Same
 * arrangement as `marketingSite.generateLinkImageUploadUrl`.
 */
export const generateDesignUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    await requireDesignsEdit(ctx);
    return await ctx.storage.generateUploadUrl();
  },
});

// ── Seed ─────────────────────────────────────────────────────────────────────

/**
 * Put the brand kit's known contents into an empty deployment — the colors off
 * the real newsletter, the fonts and folders off the Academy's brand lesson.
 * See `lib/seed/brandKit.ts` for where every row came from, and for the font
 * conflict it deliberately does not resolve.
 *
 * Idempotent and ALL-OR-NOTHING PER TABLE, exactly like
 * `marketingSite.seedSiteContentIfEmpty`: a table that already has a single row
 * is left completely alone. Per-row "insert if missing" was the alternative and
 * is worse — it would resurrect a color somebody deliberately retired, every
 * time the seed ran.
 *
 * RUN AT DEPLOY, not by hand. The sibling site-content seed shipped as a
 * "run this after deploy" step and the desk was empty on the founder's first
 * look — a tab with no rows reads as broken, not as unseeded, and the real
 * cause is invisible from inside the app. So the body lives in `seedBrandKit`
 * and migration `0080` calls it; the internal mutation stays for a manual
 * re-run.
 */
export async function seedBrandKit(
  ctx: MutationCtx,
): Promise<{ colors: number; fonts: number; folders: number }> {
  {
    const now = Date.now();
    let colors = 0;
    let fonts = 0;
    let folders = 0;

    if (!(await ctx.db.query("brandColors").first())) {
      for (const row of BRAND_COLOR_SEED) {
        await ctx.db.insert("brandColors", { ...row, createdAt: now, updatedAt: now });
        colors++;
      }
    }
    if (!(await ctx.db.query("brandFonts").first())) {
      for (const row of BRAND_FONT_SEED) {
        await ctx.db.insert("brandFonts", { ...row, createdAt: now, updatedAt: now });
        fonts++;
      }
    }
    if (!(await ctx.db.query("designFolders").first())) {
      for (const row of DESIGN_FOLDER_SEED) {
        await ctx.db.insert("designFolders", {
          ...row,
          createdAt: now,
          updatedAt: now,
        });
        folders++;
      }
    }
    return { colors, fonts, folders };
  }
}

export const seedBrandKitIfEmpty = internalMutation({
  args: {},
  returns: v.object({
    colors: v.number(),
    fonts: v.number(),
    folders: v.number(),
  }),
  handler: async (ctx: MutationCtx) => await seedBrandKit(ctx),
});

// ── Covers: the tile picture, captured from the design tool itself ──────────
//
// The library never renders a third party's image URL (they expire — the
// pasted-newsletter lesson), which left every linked design's tile as a
// typographic placeholder unless a human uploaded a screenshot. Nobody does
// that. But Canva and Figma already publish the picture we want: the
// `og:image` on a share link is the cover the tool itself renders for link
// unfurls, kept current by the tool. So:
//
//   · Saving a linked design with NO thumbnail schedules a capture — fetch the
//     page, take the FIRST og:image (the founder's call, 2026-08-28), store
//     the BYTES in our storage, write it as the thumbnail. Bytes, not the URL:
//     what we host cannot expire, so "expiry" stops being a failure mode.
//   · "Refresh cover" in the viewer re-captures on demand — for when the
//     design has been reworked in Canva and the tile still shows the old art.
//     A refresh OVERWRITES; the automatic capture only ever fills a blank, so
//     it can never clobber a cover somebody chose by hand.
//
// The pipeline is an action (it fetches the outside world); every database
// step lives in the internal query/mutation pair so the decisions that must be
// atomic — "is the row still bare?", "which blob is now orphaned?" — happen
// inside a transaction, not in the action's racy gap.

/** Reject a page or image response bigger than this. A cover is a preview;
 *  anything larger than 8MB is not a preview, and the action's memory is the
 *  budget being protected. */
const COVER_IMAGE_MAX_BYTES = 8 * 1024 * 1024;

/** What the capture pipeline needs to know about a design, read atomically. */
export const coverTarget = internalQuery({
  args: { designId: v.id("designAssets") },
  returns: v.union(
    v.object({
      url: v.union(v.string(), v.null()),
      hasThumbnail: v.boolean(),
    }),
    v.null(),
  ),
  handler: async (ctx, { designId }) => {
    const design = await ctx.db.get(designId);
    if (!design) return null;
    return {
      url: design.url ?? null,
      hasThumbnail: design.thumbnailStorage !== undefined,
    };
  },
});

/**
 * Write a captured cover onto the design — or refuse it, atomically.
 *
 * The action stored the blob BEFORE this runs, so every refusal path must
 * delete that blob or it leaks: the row may have been deleted, or (for the
 * automatic capture) may have grown a hand-picked thumbnail in the gap between
 * scheduling and running. `onlyIfBare` is the automatic path's promise that it
 * never clobbers a human's choice; the Refresh button passes false.
 */
export const applyCover = internalMutation({
  args: {
    designId: v.id("designAssets"),
    storageId: v.id("_storage"),
    onlyIfBare: v.boolean(),
  },
  returns: v.object({ applied: v.boolean() }),
  handler: async (ctx, { designId, storageId, onlyIfBare }) => {
    const design = await ctx.db.get(designId);
    if (!design || (onlyIfBare && design.thumbnailStorage !== undefined)) {
      try {
        await ctx.storage.delete(storageId);
      } catch {
        // Already gone — the leak this branch exists to prevent isn't there.
      }
      return { applied: false };
    }
    await ctx.db.patch(designId, {
      thumbnailStorage: storageId,
      thumbnailUrl: await resolveUpload(ctx, storageId),
      updatedAt: Date.now(),
    });
    // AFTER the patch, same rule as `upsertDesign`: the replaced thumbnail is
    // orphaned only once the row no longer points at it.
    await dropOrphanedBlobs(ctx, design, design.imageStorage, storageId);
    return { applied: true };
  },
});

/**
 * Fetch the design's page, take its advertised og:image, host the bytes.
 *
 * Runs with no caller identity (the scheduler drops it), which is why it is
 * internal and why its writes go through `applyCover` rather than any public
 * mutation. Failures are deliberately quiet on the automatic path — a design
 * whose page offers no preview simply keeps its typographic tile — and loud on
 * the Refresh path, where a human is waiting for an answer.
 */
export const captureCover = internalAction({
  args: { designId: v.id("designAssets"), onlyIfBare: v.boolean() },
  returns: v.object({ applied: v.boolean(), reason: v.optional(v.string()) }),
  handler: async (
    ctx,
    { designId, onlyIfBare },
  ): Promise<{ applied: boolean; reason?: string }> => {
    // The explicit return type (and the ones on `target`/`result` below) break
    // the type cycle a same-module `internal.marketingDesigns.*` call creates —
    // without them the whole generated `api` type collapses to `any`.
    const target: { url: string | null; hasThumbnail: boolean } | null =
      await ctx.runQuery(internal.marketingDesigns.coverTarget, {
        designId,
      });
    if (!target) return { applied: false, reason: "gone" };
    if (onlyIfBare && target.hasThumbnail) return { applied: false, reason: "kept" };
    if (!target.url) return { applied: false, reason: "no-link" };

    // Normalize away forms never served anonymously (Canva /edit → /view).
    // The founder's first real Refresh failed on exactly this: the stored link
    // was the /edit URL, which only the embed rewrite was normalizing.
    const pageUrl = coverPageUrl(target.url);

    // FIRST ask the tool's own oEmbed endpoint — the API that exists for
    // third-party preview fetching, served to plain server-side requests that
    // the design page's bot wall may refuse. Every failure here falls through
    // to the page scrape, so a wrong endpoint costs one request, never the
    // cover.
    let imageUrl: string | null = null;
    const oembedUrl = oembedEndpointFor(pageUrl);
    if (oembedUrl) {
      try {
        const oembedRes = await fetch(oembedUrl, {
          redirect: "follow",
          headers: { ...PAGE_FETCH_HEADERS, accept: "application/json" },
        });
        if (oembedRes.ok) {
          imageUrl = oembedThumbnailUrl(await oembedRes.json());
        }
      } catch {
        // Fall through to the page scrape.
      }
    }

    if (!imageUrl) {
      let pageRes: Response;
      try {
        pageRes = await fetch(pageUrl, {
          redirect: "follow",
          headers: PAGE_FETCH_HEADERS,
        });
      } catch {
        return { applied: false, reason: "page-unreachable" };
      }
      if (!pageRes.ok) {
        // The status IS the diagnosis — 403 is a bot wall or a private link,
        // 404 a dead one — so it travels in the reason instead of being
        // flattened to "unreachable", which is what made the first field
        // failure report undiagnosable.
        return {
          applied: false,
          reason:
            pageRes.status === 401 || pageRes.status === 403
              ? `page-blocked:${pageRes.status}`
              : `page-unreachable:${pageRes.status}`,
        };
      }
      imageUrl = extractOgImageUrl(await pageRes.text(), pageUrl);
    }

    if (!imageUrl || !isFetchableImageUrl(imageUrl)) {
      return { applied: false, reason: "no-preview" };
    }

    let imageRes: Response;
    try {
      imageRes = await fetch(imageUrl, { redirect: "follow" });
    } catch {
      return { applied: false, reason: "image-unreachable" };
    }
    const contentType = imageRes.headers.get("content-type") ?? "";
    if (!imageRes.ok || !contentType.startsWith("image/")) {
      return { applied: false, reason: "no-preview" };
    }
    const blob = await imageRes.blob();
    if (blob.size === 0 || blob.size > COVER_IMAGE_MAX_BYTES) {
      return { applied: false, reason: "no-preview" };
    }

    const storageId = await ctx.storage.store(blob);
    const result: { applied: boolean } = await ctx.runMutation(
      internal.marketingDesigns.applyCover,
      { designId, storageId, onlyIfBare },
    );
    return { applied: result.applied, reason: result.applied ? undefined : "kept" };
  },
});

/** The auth gate for `refreshCover`, split out because an action has no `db`
 *  of its own — the resolver runs inside a query with the caller's identity. */
export const assertCanEditDesigns = internalQuery({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    await requireDesignsEdit(ctx);
    return null;
  },
});

/**
 * The Refresh button: re-capture this design's cover from its page, now.
 *
 * Overwrites whatever thumbnail is there — that is the button's meaning ("the
 * art changed; update the tile"), and it is explicit where the automatic
 * capture is conservative. Errors are thrown, not swallowed: a human pressed
 * this and deserves to know that the Canva link isn't public, not a silent
 * unchanged tile.
 */
export const refreshCover = action({
  args: { designId: v.id("designAssets") },
  returns: v.null(),
  handler: async (ctx, { designId }): Promise<null> => {
    await ctx.runQuery(internal.marketingDesigns.assertCanEditDesigns, {});
    const result: { applied: boolean; reason?: string } = await ctx.runAction(
      internal.marketingDesigns.captureCover,
      { designId, onlyIfBare: false },
    );
    if (result.applied) return null;
    const reason = result.reason ?? "";
    const status = reason.includes(":") ? ` (HTTP ${reason.split(":")[1]})` : "";
    const message =
      reason === "no-link"
        ? "This design has no link to capture a cover from — upload a picture instead."
        : reason === "gone"
          ? "That design is no longer in the library."
          : reason.startsWith("page-blocked")
            ? `The design tool refused to show the page to the app${status}. Make sure the link is a share link set so anyone with it can view — an /edit link only works for people signed in to Canva.`
            : reason.startsWith("page-unreachable")
              ? `The design's page couldn't be reached${status}. Check the link still works.`
              : "The page didn't offer a preview image. For Canva, make sure the link is set so anyone with it can view; or upload a cover by hand.";
    throw new ConvexError({ code: "NO_COVER", message });
  },
});
