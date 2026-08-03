import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Google Chat channels — a small, DEPLOYMENT-WIDE admin-managed list of named
 * spaces (each backed by a Google Chat Incoming Webhook), mirroring how the
 * Twilio/Resend/Givebutter credentials in `integrationSettings` are ALSO one
 * shared deployment-wide setting: this app is one Google Workspace shared
 * across chapters, not a per-chapter list. See `commsSend.ts` for the send
 * flow this powers.
 *
 * `webhookUrl` is the SECRET — it carries the space's auth token in the URL
 * itself, so it gets the SAME write-only discipline as
 * `integrationSettings`'s keys: settable by a superuser
 * (`googleChatChannels.ts`'s add/update mutations), never returned to a
 * client (`listGoogleChatChannels`/`getGoogleChatChannelsStatus` project only
 * name/status), readable in full ONLY through `readGoogleChatWebhookUrl`
 * (an internalQuery reachable solely from `commsSend.ts`'s delivery action).
 *
 * `archived` channels drop out of the public `listGoogleChatChannels` (so
 * they stop appearing in the send picker) but stay visible — flagged — in the
 * superuser-only `getGoogleChatChannelsStatus` projection.
 */
export const googleChatChannels = defineTable({
  name: v.string(),
  webhookUrl: v.string(),
  archived: v.optional(v.boolean()),
  createdBy: v.id("users"),
  updatedBy: v.id("users"),
  createdAt: v.number(),
  updatedAt: v.number(),
});
