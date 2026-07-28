/**
 * The reusable illustration library the campaign composer's image picker reads
 * (`schema/campaigns.ts#emailImages`). CENTRAL-only
 * (`lib/campaignsAccess.ts`).
 *
 * ── Who can do what here ───────────────────────────────────────────────────
 * `listImages` is a plain desk READ (`requireCampaignsAccess`) — a composer
 * has to be able to pick a picture. Every WRITE requires the named
 * `campaigns.design` power (`requireCampaignDesign`), because the library is
 * shared and `deleteImage` is a HARD delete of the blob: one careless call
 * breaks the artwork in every campaign that already embedded that URL.
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
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { requireUserId } from "./lib/context";
import { requireCampaignDesign, requireCampaignsAccess } from "./lib/campaignsAccess";
import { SUPERUSER_EMAILS } from "./lib/superuser";

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
    await requireCampaignDesign(ctx);
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
    await requireCampaignDesign(ctx);
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
    await requireCampaignDesign(ctx);
    const existing = await ctx.db.get(imageId);
    if (!existing) return null; // already gone — deleting is idempotent
    await ctx.storage.delete(existing.storageId);
    await ctx.db.delete(imageId);
    return null;
  },
});

// ── One-time newsletter artwork import (migrations/0052) ────────────────────
// These back `0052_import_newsletter_images.ts`. They live here rather than in
// the migration file so the table's write rules stay in one module, and they
// are `internal*` because the import is a human-run operation, not something
// a client may trigger.

/** Which `sourceKey`s are already on file for a scope — the idempotency read
 *  for the import. Bounded by the same limit `listImages` uses. */
export const listImportedSourceKeys = internalQuery({
  args: { scope: scopeValidator },
  returns: v.array(v.string()),
  handler: async (ctx, { scope }) => {
    const rows = await ctx.db
      .query("emailImages")
      .withIndex("by_scope", (q) => q.eq("scope", scope))
      .take(IMAGE_SCAN_LIMIT);
    return rows
      .map((r) => r.sourceKey)
      .filter((k): k is string => typeof k === "string" && k.length > 0);
  },
});

/**
 * Insert one imported asset. Re-checks the `sourceKey` inside the mutation
 * rather than trusting the action's earlier read: the action fetches over the
 * network between the two, which is ample time for a concurrent run (or a
 * human re-running the import) to have written the same key.
 *
 * `alt` is deliberately NOT taken from the caller — every imported asset
 * starts with empty alt because the artwork carries text nobody has
 * transcribed. See `NEWSLETTER_ASSETS`'s doc.
 */
export const insertImportedImage = internalMutation({
  args: {
    scope: scopeValidator,
    sourceKey: v.string(),
    storageId: v.id("_storage"),
    url: v.string(),
    label: v.string(),
    createdBy: v.id("users"),
  },
  returns: v.union(v.id("emailImages"), v.null()),
  handler: async (ctx, { scope, sourceKey, storageId, url, label, createdBy }) => {
    const existing = await ctx.db
      .query("emailImages")
      .withIndex("by_scope", (q) => q.eq("scope", scope))
      .take(IMAGE_SCAN_LIMIT);
    if (existing.some((r) => r.sourceKey === sourceKey)) {
      // Lost the race — drop the blob we just stored so it doesn't leak.
      await ctx.storage.delete(storageId);
      return null;
    }
    return await ctx.db.insert("emailImages", {
      scope,
      storageId,
      url,
      alt: "",
      label,
      sourceKey,
      createdBy,
      createdAt: Date.now(),
    });
  },
});

/** The user an imported row is attributed to: earliest superuser, else
 *  earliest user. Mirrors migration 0049's resolution exactly. */
export const resolveImportOwner = internalQuery({
  args: {},
  returns: v.union(v.id("users"), v.null()),
  handler: async (ctx) => {
    const users = await ctx.db.query("users").take(200);
    if (users.length === 0) return null;
    const superuser = users.find(
      (u) => !!u.email && SUPERUSER_EMAILS.includes(u.email.trim().toLowerCase()),
    );
    return (superuser ?? users[0])._id;
  },
});
