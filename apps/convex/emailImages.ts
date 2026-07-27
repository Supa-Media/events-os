/**
 * The reusable illustration library the campaign composer's image picker reads
 * (`schema/campaigns.ts#emailImages`). CENTRAL-only, gated exactly like the
 * rest of the campaigns desk (`lib/campaignsAccess.ts`).
 *
 * Modelled on `schema/finances.ts#receipts` / `receipts.ts`: the file itself
 * lives in Convex storage and the row carries its `storageId` PLUS the
 * resolved public `url`. Caching the URL is deliberate — an email's `<img src>`
 * has to be a plain, long-lived absolute URL (a mail client fetches it days
 * later, from a machine that never talked to this backend), and a picker
 * listing fifty images shouldn't pay fifty `ctx.storage.getUrl` round trips to
 * render.
 *
 * `alt` is REQUIRED (the empty string is the legitimate "decorative" value).
 * Gmail and Outlook block remote images by default, so for a large share of
 * recipients the alt text IS the image — the same reason
 * `emailBlocks.ts#validateCardContent` refuses an `imageUrl` without one.
 */
import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { requireUserId } from "./lib/context";
import { requireCampaignsAccess } from "./lib/campaignsAccess";

const scopeValidator = v.union(v.id("chapters"), v.literal("central"));

/** Bound on one scope's library — the never-scan-unbounded discipline every
 *  other list surface here uses. */
const IMAGE_SCAN_LIMIT = 500;

export const listImages = query({
  args: { scope: v.optional(scopeValidator) },
  handler: async (ctx, { scope }) => {
    await requireCampaignsAccess(ctx);
    return scope
      ? await ctx.db
          .query("emailImages")
          .withIndex("by_scope", (q) => q.eq("scope", scope))
          .order("desc")
          .take(IMAGE_SCAN_LIMIT)
      : await ctx.db.query("emailImages").order("desc").take(IMAGE_SCAN_LIMIT);
  },
});

/**
 * Add an already-uploaded blob to the library. The client uploads to a Convex
 * upload URL first (the house pattern everywhere else in this app) and hands
 * the resulting `storageId` here; this resolves it to a public URL and stores
 * both.
 *
 * A `storageId` that doesn't resolve is rejected rather than stored with a
 * null URL — a library row whose image can never render is worse than no row,
 * because it lands in a real send before anyone notices.
 */
export const addImage = mutation({
  args: {
    scope: scopeValidator,
    storageId: v.id("_storage"),
    alt: v.string(),
    label: v.optional(v.string()),
  },
  returns: v.id("emailImages"),
  handler: async (ctx, { scope, storageId, alt, label }) => {
    await requireCampaignsAccess(ctx);
    const userId = (await requireUserId(ctx)) as Id<"users">;

    const url = await ctx.storage.getUrl(storageId);
    if (!url) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "That upload couldn't be found — try uploading the image again.",
      });
    }

    return await ctx.db.insert("emailImages", {
      scope,
      storageId,
      url,
      alt: alt.trim(),
      label: label?.trim() || undefined,
      createdBy: userId,
      createdAt: Date.now(),
    });
  },
});

/** Rename / re-describe a library image. The blob and its URL are immutable —
 *  replacing the picture means adding a new row, so that a campaign already
 *  referencing this URL can never have its artwork swapped underneath it. */
export const updateImage = mutation({
  args: {
    imageId: v.id("emailImages"),
    alt: v.optional(v.string()),
    // `null` clears the label; `undefined` leaves it untouched — the
    // `previewText` null-sentinel convention from `campaigns.ts`.
    label: v.optional(v.union(v.string(), v.null())),
  },
  returns: v.null(),
  handler: async (ctx, { imageId, alt, label }) => {
    await requireCampaignsAccess(ctx);
    const existing = await ctx.db.get(imageId);
    if (!existing) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Image not found." });
    }
    const patch: Record<string, unknown> = {};
    if (alt !== undefined) patch.alt = alt.trim();
    if (label !== undefined) patch.label = label?.trim() || undefined;
    await ctx.db.patch(imageId, patch);
    return null;
  },
});

/**
 * Remove an image from the library AND delete the stored blob — a HARD delete,
 * not the soft-archive the other tables here use, because the file itself is
 * the point: leaving the blob behind would keep the image publicly fetchable
 * at its URL forever, which is exactly what someone deleting a photo is trying
 * to prevent.
 *
 * The blob goes first: if the storage delete fails the row survives, so the
 * library still shows something a human can retry on. The reverse order could
 * orphan a blob with nothing left pointing at it.
 *
 * Any campaign that already embedded this image keeps the raw URL in its
 * document (documents store URLs, never library ids) — that link goes dead,
 * which is the intended and unavoidable consequence of deleting the file.
 */
export const deleteImage = mutation({
  args: { imageId: v.id("emailImages") },
  returns: v.null(),
  handler: async (ctx, { imageId }) => {
    await requireCampaignsAccess(ctx);
    const existing = await ctx.db.get(imageId);
    if (!existing) return null; // already gone — deleting is idempotent
    await ctx.storage.delete(existing.storageId);
    await ctx.db.delete(imageId);
    return null;
  },
});
