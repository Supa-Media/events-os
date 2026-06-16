/**
 * File storage — upload URLs and display URL resolution.
 *
 * Photos (and other uploaded files) live in Convex file storage. Clients ask
 * for a short-lived upload URL, POST the file directly, then store the returned
 * `storageId` in their field. `getUrl` resolves a `storageId` back to a
 * servable URL for display.
 */
import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { requireUserId } from "./lib/context";

/** Generate a short-lived URL the client can POST a file to. */
export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    await requireUserId(ctx);
    return await ctx.storage.generateUploadUrl();
  },
});

/**
 * Resolve a stored file's id to a servable URL (null if missing).
 *
 * Auth-gated: a stored URL is directly servable, so a logged-out caller must
 * never be able to resolve an arbitrary `_storage` id into a fetchable file.
 */
export const getUrl = query({
  args: { storageId: v.id("_storage") },
  handler: async (ctx, { storageId }) => {
    await requireUserId(ctx);
    return await ctx.storage.getUrl(storageId);
  },
});
