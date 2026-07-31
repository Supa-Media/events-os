/**
 * Google Chat channels — superuser CRUD over the deployment-wide named-space
 * list + the public name-only list the Comms Schedule's send picker reads.
 * See `schema/googleChatChannels.ts`'s module doc for the write-only-secret
 * discipline this follows (same as `integrationSettings.ts`).
 */
import { query, mutation, internalQuery } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { Doc, Id } from "./_generated/dataModel";
import { requireUserId } from "./lib/context";
import { requireSuperuser } from "./lib/superuser";

const GOOGLE_CHAT_WEBHOOK_PREFIX = "https://chat.googleapis.com/";

/** Last 6 characters of a webhook URL, for display only — never the URL itself. */
function last6(url: string): string {
  return url.slice(-6);
}

function requireChannelName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: "Channel name can't be empty.",
    });
  }
  return trimmed;
}

function requireChannelWebhookUrl(webhookUrl: string): string {
  const trimmed = webhookUrl.trim();
  if (!trimmed.startsWith(GOOGLE_CHAT_WEBHOOK_PREFIX)) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: `Webhook URL must start with "${GOOGLE_CHAT_WEBHOOK_PREFIX}".`,
    });
  }
  return trimmed;
}

async function requireChannel(
  ctx: QueryCtx,
  channelId: Id<"googleChatChannels">,
): Promise<Doc<"googleChatChannels">> {
  const channel = await ctx.db.get(channelId);
  if (!channel) {
    throw new ConvexError({ code: "NOT_FOUND", message: "Channel not found." });
  }
  return channel;
}

/** Add a Google Chat channel. SUPERUSER-ONLY. */
export const addGoogleChatChannel = mutation({
  args: { name: v.string(), webhookUrl: v.string() },
  returns: v.id("googleChatChannels"),
  handler: async (ctx, { name, webhookUrl }) => {
    await requireSuperuser(ctx);
    const userId = (await requireUserId(ctx)) as Id<"users">;
    const now = Date.now();
    return await ctx.db.insert("googleChatChannels", {
      name: requireChannelName(name),
      webhookUrl: requireChannelWebhookUrl(webhookUrl),
      createdBy: userId,
      updatedBy: userId,
      createdAt: now,
      updatedAt: now,
    });
  },
});

/** Rename a Google Chat channel. SUPERUSER-ONLY. */
export const renameGoogleChatChannel = mutation({
  args: { channelId: v.id("googleChatChannels"), name: v.string() },
  returns: v.null(),
  handler: async (ctx, { channelId, name }) => {
    await requireSuperuser(ctx);
    const userId = (await requireUserId(ctx)) as Id<"users">;
    await requireChannel(ctx, channelId);
    await ctx.db.patch(channelId, {
      name: requireChannelName(name),
      updatedBy: userId,
      updatedAt: Date.now(),
    });
    return null;
  },
});

/** Replace a Google Chat channel's webhook URL. SUPERUSER-ONLY, write-only —
 *  the previous value is never returned, and the new one isn't either. */
export const updateGoogleChatChannelWebhook = mutation({
  args: { channelId: v.id("googleChatChannels"), webhookUrl: v.string() },
  returns: v.null(),
  handler: async (ctx, { channelId, webhookUrl }) => {
    await requireSuperuser(ctx);
    const userId = (await requireUserId(ctx)) as Id<"users">;
    await requireChannel(ctx, channelId);
    await ctx.db.patch(channelId, {
      webhookUrl: requireChannelWebhookUrl(webhookUrl),
      updatedBy: userId,
      updatedAt: Date.now(),
    });
    return null;
  },
});

/** Archive/restore a Google Chat channel. SUPERUSER-ONLY. Archived channels
 *  drop out of `listGoogleChatChannels` (the send picker) but stay visible,
 *  flagged, in `getGoogleChatChannelsStatus`. */
export const archiveGoogleChatChannel = mutation({
  args: { channelId: v.id("googleChatChannels"), archived: v.boolean() },
  returns: v.null(),
  handler: async (ctx, { channelId, archived }) => {
    await requireSuperuser(ctx);
    const userId = (await requireUserId(ctx)) as Id<"users">;
    await requireChannel(ctx, channelId);
    await ctx.db.patch(channelId, {
      archived,
      updatedBy: userId,
      updatedAt: Date.now(),
    });
    return null;
  },
});

/**
 * The public, name-only channel list — any signed-in caller (no special
 * power) can read it, the same way `previewBlastAudience` needs no power to
 * preview. NEVER returns `webhookUrl`. Excludes archived channels. Sorted by
 * name so the send picker reads predictably.
 */
export const listGoogleChatChannels = query({
  args: {},
  returns: v.array(v.object({ _id: v.id("googleChatChannels"), name: v.string() })),
  handler: async (ctx) => {
    await requireUserId(ctx);
    const channels = await ctx.db.query("googleChatChannels").collect();
    return channels
      .filter((c: Doc<"googleChatChannels">) => c.archived !== true)
      .sort((a: Doc<"googleChatChannels">, b: Doc<"googleChatChannels">) =>
        a.name.localeCompare(b.name),
      )
      .map((c: Doc<"googleChatChannels">) => ({ _id: c._id, name: c.name }));
  },
});

/**
 * Superuser status projection for Profile → Integrations: EVERY channel
 * (archived included), with a `urlSuffix` hint — never the full URL, never
 * `webhookUrl` itself.
 */
export const getGoogleChatChannelsStatus = query({
  args: {},
  returns: v.array(
    v.object({
      _id: v.id("googleChatChannels"),
      name: v.string(),
      urlSuffix: v.string(),
      archived: v.boolean(),
      updatedAt: v.number(),
    }),
  ),
  handler: async (ctx) => {
    await requireSuperuser(ctx);
    const channels = await ctx.db.query("googleChatChannels").collect();
    return channels.map((c: Doc<"googleChatChannels">) => ({
      _id: c._id,
      name: c.name,
      urlSuffix: last6(c.webhookUrl),
      archived: c.archived === true,
      updatedAt: c.updatedAt,
    }));
  },
});

/**
 * Action-facing read of the raw webhook URL (or `null` when the channel is
 * missing or archived). The ONLY place the raw URL ever leaves the table —
 * reachable solely from `commsSend.ts`'s delivery action. NEVER exposed as a
 * public function.
 */
export const readGoogleChatWebhookUrl = internalQuery({
  args: { channelId: v.id("googleChatChannels") },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, { channelId }) => {
    const channel = await ctx.db.get(channelId);
    if (!channel || channel.archived === true) return null;
    return channel.webhookUrl;
  },
});
