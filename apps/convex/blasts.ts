/**
 * Blasts — host announcements to attendees. Email delivers now (Resend);
 * `channel: "sms"` is accepted by the schema but refused here until Twilio
 * is connected, so the UI can show the toggle without dead sends.
 *
 * Lifecycle: `sendBlast` (admin mutation) inserts a `sending` row and
 * schedules `deliverBlast` (internal action) which emails every recipient in
 * the audience and finalizes the row via `finishBlast`.
 */
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { requireEvent, requireUserId } from "./lib/context";
import { siteUrl } from "./lib/siteUrl";
import { emailShell, sendEmail } from "./ticketingEmails";

const audienceValidator = v.union(
  v.literal("everyone"),
  v.literal("going"),
  v.literal("maybe"),
  v.literal("ticket_holders"),
);

export const listBlasts = query({
  args: { eventId: v.id("events") },
  handler: async (ctx, { eventId }) => {
    await requireEvent(ctx, eventId);
    return await ctx.db
      .query("blasts")
      .withIndex("by_event", (q) => q.eq("eventId", eventId))
      .order("desc")
      .take(100);
  },
});

/** Fire a blast (admin). Inserts the row and schedules delivery. */
export const sendBlast = mutation({
  args: {
    eventId: v.id("events"),
    channel: v.union(v.literal("email"), v.literal("sms")),
    subject: v.optional(v.string()),
    body: v.string(),
    audience: audienceValidator,
  },
  handler: async (ctx, args) => {
    const event = await requireEvent(ctx, args.eventId);
    const userId = await requireUserId(ctx);
    if (args.channel === "sms") {
      throw new ConvexError({
        code: "SMS_NOT_CONNECTED",
        message: "Text blasts need Twilio connected — email is live today.",
      });
    }
    const body = args.body.trim();
    if (!body) {
      throw new ConvexError({ code: "EMPTY", message: "Write the blast first." });
    }
    const blastId = await ctx.db.insert("blasts", {
      eventId: args.eventId,
      chapterId: event.chapterId,
      channel: args.channel,
      subject: args.subject?.trim() || undefined,
      body,
      audience: args.audience,
      status: "sending",
      createdBy: userId as Id<"users">,
      createdAt: Date.now(),
    });
    await ctx.scheduler.runAfter(0, internal.blasts.deliverBlast, { blastId });
    return blastId;
  },
});

/** Everything delivery needs in one read: blast + event + recipient emails. */
export const getBlastPayload = internalQuery({
  args: { blastId: v.id("blasts") },
  handler: async (ctx, { blastId }) => {
    const blast = await ctx.db.get(blastId);
    if (!blast) return null;
    const event = await ctx.db.get(blast.eventId);
    const page = await ctx.db
      .query("eventPages")
      .withIndex("by_event", (q) => q.eq("eventId", blast.eventId))
      .unique();

    const rows =
      blast.audience === "going" || blast.audience === "maybe"
        ? await ctx.db
            .query("rsvps")
            .withIndex("by_event_status", (q) =>
              q.eq("eventId", blast.eventId).eq("status", blast.audience as "going" | "maybe"),
            )
            .take(2000)
        : await ctx.db
            .query("rsvps")
            .withIndex("by_event", (q) => q.eq("eventId", blast.eventId))
            .take(2000);

    const inAudience =
      blast.audience === "ticket_holders"
        ? rows.filter((r) => r.source === "ticket")
        : rows;
    // Skip addresses that failed to verify (undefined = legacy = verified).
    const filtered = inAudience.filter((r) => r.emailVerified !== false);

    // One email per address (an attendee can RSVP + buy).
    const emails = [...new Set(filtered.map((r) => r.email))];
    return {
      blast,
      emails,
      eventName: event?.name ?? "Event",
      slug: page?.slug ?? null,
      hostName: page?.hostName ?? "Public Worship",
    };
  },
});

export const finishBlast = internalMutation({
  args: {
    blastId: v.id("blasts"),
    recipientCount: v.number(),
    sentCount: v.number(),
    error: v.optional(v.string()),
  },
  handler: async (ctx, { blastId, recipientCount, sentCount, error }) => {
    await ctx.db.patch(blastId, {
      status: error && sentCount === 0 ? "failed" : "sent",
      recipientCount,
      sentCount,
      error,
      sentAt: Date.now(),
    });
    return null;
  },
});

/** Deliver a blast: one branded email per recipient, best-effort per send. */
export const deliverBlast = internalAction({
  args: { blastId: v.id("blasts") },
  handler: async (ctx, { blastId }) => {
    const payload = await ctx.runQuery(internal.blasts.getBlastPayload, {
      blastId,
    });
    if (!payload) return null;
    const { blast, emails, eventName, slug, hostName } = payload;
    const site = siteUrl();
    const subject = blast.subject || `An update on ${eventName}`;
    const paragraphs = blast.body
      .split(/\n{2,}/)
      .map(
        (p) =>
          `<p style="margin:0 0 14px;font-family:-apple-system,'Segoe UI',Roboto,sans-serif;font-size:15px;line-height:1.65;color:#210909">${p.replace(/\n/g, "<br/>")}</p>`,
      )
      .join("");
    const html = emailShell(`
      <div style="font-family:-apple-system,'Segoe UI',Roboto,sans-serif;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:#7A5A5A;margin-bottom:8px">${hostName} · ${eventName}</div>
      <h1 style="margin:0 0 16px;font-size:24px;line-height:1.25">${subject}</h1>
      ${paragraphs}
      ${slug ? `<a href="${site}/e/${slug}" style="display:inline-block;margin-top:6px;background:#D23B3A;color:#fff;text-decoration:none;font-family:-apple-system,'Segoe UI',Roboto,sans-serif;font-weight:600;font-size:14px;padding:12px 24px;border-radius:999px">View event</a>` : ""}`);

    let sent = 0;
    let lastError: string | undefined;
    for (const email of emails) {
      try {
        await sendEmail(email, subject, html);
        sent++;
      } catch (err) {
        lastError = String(err);
      }
    }
    await ctx.runMutation(internal.blasts.finishBlast, {
      blastId,
      recipientCount: emails.length,
      sentCount: sent,
      error: lastError,
    });
    return null;
  },
});
