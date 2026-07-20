/**
 * Blasts — host announcements to attendees, over email (Resend) or SMS
 * (Twilio, Attendance F).
 *
 * Lifecycle: `sendBlast` (admin mutation) inserts a `sending` row and
 * schedules `deliverBlast` (internal action) which reaches every recipient in
 * the audience — emails for `channel:"email"`, texts for `channel:"sms"` — and
 * finalizes the row via `finishBlast`. SMS degrades to a recorded error when
 * Twilio isn't configured (setting → `TWILIO_*` env → not configured); the
 * composer previews this via `previewBlastAudience.smsConfigured`.
 *
 * Audiences resolve identically for both channels; SMS just targets the rows
 * that carry a phone whose `phoneVerified !== false` (the mirror of the email
 * verification gate), de-duped by normalized phone. Email-less phone-only
 * imported guests — unreachable by email — ARE reached by SMS.
 */
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import type { ActionCtx, QueryCtx } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { requireEvent, requireUserId } from "./lib/context";
import { rsvpPageUrl } from "./lib/siteUrl";
import { emailShell, sendEmail } from "./ticketingEmails";
import {
  normalizePhone,
  resolveTwilioCredentials,
  sendSms,
} from "./lib/twilio";

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
    // SMS is no longer refused here — `deliverBlast` records a clear error if
    // Twilio isn't configured (and the composer previews availability), so a
    // send is never silently dropped.
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

type Audience = "everyone" | "going" | "maybe" | "ticket_holders";

/** What `deliverBlast` fans out from — blast row + resolved recipient lists. */
type BlastPayload = {
  blast: Doc<"blasts">;
  emails: string[];
  phones: string[];
  eventName: string;
  slug: string | null;
  hostName: string;
} | null;

/** Read the RSVP rows that fall inside an audience (bounded, index-only). */
async function audienceRsvps(
  ctx: QueryCtx,
  eventId: Id<"events">,
  audience: Audience,
): Promise<Doc<"rsvps">[]> {
  const rows =
    audience === "going" || audience === "maybe"
      ? await ctx.db
          .query("rsvps")
          .withIndex("by_event_status", (q) =>
            q.eq("eventId", eventId).eq("status", audience),
          )
          .take(2000)
      : await ctx.db
          .query("rsvps")
          .withIndex("by_event", (q) => q.eq("eventId", eventId))
          .take(2000);
  return audience === "ticket_holders"
    ? rows.filter((r) => r.source === "ticket")
    : rows;
}

/**
 * The email recipient set for an audience: rows with an email that didn't fail
 * to verify (undefined = legacy = verified), de-duped by address (an attendee
 * can RSVP + buy). Email-less imported rows drop out here — SMS reclaims them.
 */
function emailRecipients(rows: Doc<"rsvps">[]): string[] {
  const filtered = rows.filter(
    (r): r is Doc<"rsvps"> & { email: string } =>
      !!r.email && r.emailVerified !== false,
  );
  return [...new Set(filtered.map((r) => r.email))];
}

/**
 * The SMS recipient set for an audience: rows with a parseable phone whose
 * `phoneVerified !== false` (the mirror of the email gate — undefined =
 * imported/synced = reachable), de-duped by NORMALIZED phone so "(917)
 * 555-0000" and "9175550000" collapse to one text. Phone-only imported guests
 * with no email ARE included — the payoff of the SMS channel.
 */
function phoneRecipients(rows: Doc<"rsvps">[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of rows) {
    if (!r.phone || r.phoneVerified === false) continue;
    const normalized = normalizePhone(r.phone);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

/** Everything delivery needs in one read: blast + event + recipient lists. */
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

    const rows = await audienceRsvps(ctx, blast.eventId, blast.audience);
    return {
      blast,
      emails: emailRecipients(rows),
      phones: phoneRecipients(rows),
      eventName: event?.name ?? "Event",
      slug: page?.slug ?? null,
      hostName: page?.hostName ?? "Public Worship",
    };
  },
});

/**
 * Whether SMS blasts can send right now — the Twilio trio is configured via
 * the in-app superuser setting OR the `TWILIO_*` env vars. Boolean only (no
 * secret leaves the table), so the event-admin composer can hint at Profile →
 * Integrations without being a superuser itself.
 */
function smsConfigured(settings: Doc<"integrationSettings"> | null): boolean {
  const setting =
    !!settings?.twilioAccountSid &&
    !!settings?.twilioAuthToken &&
    !!settings?.twilioMessagingServiceSid;
  const env =
    !!process.env.TWILIO_ACCOUNT_SID &&
    !!process.env.TWILIO_AUTH_TOKEN &&
    !!process.env.TWILIO_MESSAGING_SERVICE_SID;
  return setting || env;
}

/**
 * Composer preview: recipient counts per channel for an audience, plus whether
 * SMS can send. Event-gated (any admin), never returns addresses/numbers.
 */
export const previewBlastAudience = query({
  args: { eventId: v.id("events"), audience: audienceValidator },
  returns: v.object({
    emailRecipients: v.number(),
    smsRecipients: v.number(),
    smsConfigured: v.boolean(),
  }),
  handler: async (ctx, { eventId, audience }) => {
    await requireEvent(ctx, eventId);
    const rows = await audienceRsvps(ctx, eventId, audience);
    const settings = await ctx.db.query("integrationSettings").first();
    return {
      emailRecipients: emailRecipients(rows).length,
      smsRecipients: phoneRecipients(rows).length,
      smsConfigured: smsConfigured(settings),
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

/** Deliver an email blast: one branded email per recipient, best-effort. */
async function deliverEmailBlast(
  ctx: ActionCtx,
  payload: NonNullable<BlastPayload>,
): Promise<{ recipientCount: number; sentCount: number; error?: string }> {
  const { blast, emails, eventName, slug, hostName } = payload;
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
      ${slug ? `<a href="${rsvpPageUrl(slug)}" style="display:inline-block;margin-top:6px;background:#D23B3A;color:#fff;text-decoration:none;font-family:-apple-system,'Segoe UI',Roboto,sans-serif;font-weight:600;font-size:14px;padding:12px 24px;border-radius:999px">View event</a>` : ""}`);

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
  return { recipientCount: emails.length, sentCount: sent, error: lastError };
}

/** Deliver an SMS blast: one text per normalized phone, best-effort. */
async function deliverSmsBlast(
  ctx: ActionCtx,
  payload: NonNullable<BlastPayload>,
): Promise<{ recipientCount: number; sentCount: number; error?: string }> {
  const { blast, phones } = payload;
  const creds = await resolveTwilioCredentials(ctx);
  if (!creds) {
    // Recorded, not thrown — the row lands `failed` with a clear reason.
    return {
      recipientCount: phones.length,
      sentCount: 0,
      error: "Twilio isn't connected — configure it in Profile → Integrations.",
    };
  }
  // Marketing bodies carry the opt-out line. STOP itself is honored by the
  // Twilio Messaging Service automatically (Advanced Opt-Out); this suffix is
  // the visible disclosure carriers/A2P registration expect. Transactional
  // verification codes (ticketingSms.ts) deliberately omit it.
  const body = `${blast.body}\n\nReply STOP to opt out.`;

  let sent = 0;
  let lastError: string | undefined;
  for (const to of phones) {
    try {
      await sendSms(creds, { to, body });
      sent++;
    } catch (err) {
      lastError = String(err);
    }
  }
  return { recipientCount: phones.length, sentCount: sent, error: lastError };
}

/** Deliver a blast over its channel, then finalize the row. */
export const deliverBlast = internalAction({
  args: { blastId: v.id("blasts") },
  handler: async (ctx, { blastId }) => {
    const payload = await ctx.runQuery(internal.blasts.getBlastPayload, {
      blastId,
    });
    if (!payload) return null;
    const result =
      payload.blast.channel === "sms"
        ? await deliverSmsBlast(ctx, payload)
        : await deliverEmailBlast(ctx, payload);
    await ctx.runMutation(internal.blasts.finishBlast, {
      blastId,
      recipientCount: result.recipientCount,
      sentCount: result.sentCount,
      error: result.error,
    });
    return null;
  },
});
