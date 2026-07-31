/**
 * Comms Schedule → Google Chat send — the in-app "Send" button next to a
 * comms row's saved copy (the "COPY" box on the day-panel card). Follows the
 * SAME mutation-validates → scheduled internal action → finalize-mutation
 * shape `blasts.ts#sendBlast`/`deliverBlast`/`finishBlast` establishes for
 * every other outbound send in this codebase.
 *
 * Sends the row's ALREADY-SAVED copy (`fields.notes`, via the item's
 * `title`/`fields` at send time) — never an in-flight unsaved draft — to
 * exactly one Google Chat channel (`googleChatChannels.ts`), restricted to
 * `module === "comms"` rows. On success the item's `status` flips to `"sent"`
 * and `fields.lastGoogleChatSend` records the outcome; a failure leaves
 * `status` untouched and records `{status:"failed", error}` instead.
 */
import {
  internalAction,
  internalMutation,
  mutation,
} from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { requireCommsSend } from "./lib/commsAccess";
import { buildGoogleChatMessage, postGoogleChatMessage } from "./lib/googleChat";
import { mergeFields } from "./items";

/**
 * Validate + schedule a comms send. Loads the item, refuses anything that
 * isn't a comms-module row, gates on `requireCommsSend` (event/chapter
 * membership), refuses an empty message and an unknown/archived channel, then
 * hands delivery off to `deliverCommsSend`.
 */
export const sendCommsToGoogleChat = mutation({
  args: {
    itemId: v.id("eventItems"),
    channelId: v.id("googleChatChannels"),
    message: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, { itemId, channelId, message }) => {
    const item = await ctx.db.get(itemId);
    if (!item) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Item not found." });
    }
    if (item.module !== "comms") {
      throw new ConvexError({
        code: "NOT_COMMS",
        message: "Only Comms Schedule rows can be sent to Google Chat.",
      });
    }
    const event = await requireCommsSend(ctx, item.eventId);

    const trimmed = message.trim();
    if (!trimmed) {
      throw new ConvexError({ code: "EMPTY", message: "Write the copy first." });
    }

    const channel = await ctx.db.get(channelId);
    if (!channel || channel.archived === true) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Google Chat channel not found.",
      });
    }

    await ctx.scheduler.runAfter(0, internal.commsSend.deliverCommsSend, {
      itemId,
      channelId,
      channelName: channel.name,
      eventName: event.name,
      itemTitle: item.title,
      message: trimmed,
    });
    return null;
  },
});

/** POST the message to the channel's webhook, then finalize the row. */
export const deliverCommsSend = internalAction({
  args: {
    itemId: v.id("eventItems"),
    channelId: v.id("googleChatChannels"),
    channelName: v.string(),
    eventName: v.string(),
    itemTitle: v.string(),
    message: v.string(),
  },
  handler: async (ctx, { itemId, channelId, channelName, eventName, itemTitle, message }) => {
    const webhookUrl = await ctx.runQuery(
      internal.googleChatChannels.readGoogleChatWebhookUrl,
      { channelId },
    );
    if (!webhookUrl) {
      await ctx.runMutation(internal.commsSend.finishCommsSend, {
        itemId,
        channelId,
        channelName,
        ok: false,
        error: "Google Chat channel is no longer configured.",
      });
      return null;
    }

    try {
      const text = buildGoogleChatMessage({ eventName, itemTitle, copy: message });
      await postGoogleChatMessage(webhookUrl, text);
      await ctx.runMutation(internal.commsSend.finishCommsSend, {
        itemId,
        channelId,
        channelName,
        ok: true,
      });
    } catch (err) {
      await ctx.runMutation(internal.commsSend.finishCommsSend, {
        itemId,
        channelId,
        channelName,
        ok: false,
        error: String(err),
      });
    }
    return null;
  },
});

/** Record a send outcome on the item. Status flips to `"sent"` ONLY on
 *  success — a failure leaves it exactly as it was before the send. */
export const finishCommsSend = internalMutation({
  args: {
    itemId: v.id("eventItems"),
    channelId: v.id("googleChatChannels"),
    channelName: v.string(),
    ok: v.boolean(),
    error: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { itemId, channelId, channelName, ok, error }) => {
    const item = await ctx.db.get(itemId);
    if (!item) return null;

    const fields = mergeFields(item.fields, {
      lastGoogleChatSend: {
        channelId: String(channelId),
        channelName,
        status: ok ? "sent" : "failed",
        error: ok ? undefined : error,
        sentAt: Date.now(),
      },
    });
    await ctx.db.patch(itemId, {
      fields,
      ...(ok ? { status: "sent" } : {}),
    });
    return null;
  },
});
