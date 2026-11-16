/**
 * Telling the buyer their ticket was refunded.
 *
 * Scheduled by `saleRefunds.ts` the moment a refund first goes live (Stripe
 * accepted it), so a buyer hears from us once per refund — not on every
 * "Check with Stripe", and never for an attempt Stripe refused. Email always
 * (the order always has one); a text too when the buyer gave a phone number at
 * checkout (it lives on their RSVP).
 *
 * What it says is what a buyer actually asks next: how much, to which card,
 * and when they'll see it (5–10 business days is the bank's side of a card
 * refund, not ours). No "reply to this email" — the sending address isn't
 * read (see the backer-email rule); it points at the event page instead.
 *
 * Best effort, like every transactional send here: no email/SMS provider
 * configured → logged and skipped; a failed send never touches the refund.
 */
import { internalAction, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { formatCents, estimateSegments, SMS_SEGMENT_PRICE_USD_MICROS } from "@events-os/shared";
import { sendEmail } from "./ticketingEmails";
import { emailHeading, emailPanel, emailCode, emailParagraph, emailLink, emailShell } from "./lib/emailShell";
import { escapeHtml } from "./lib/html";
import { rsvpPageUrl } from "./lib/siteUrl";
import { normalizePhone, resolveTwilioCredentials, sendSms } from "./lib/twilio";

/** How long a card refund takes to show — the one sentence every notice carries. */
export const REFUND_TIMING = "Refunds usually show up on your statement within 5–10 business days, depending on your bank.";

export const refundNoticePayload = internalQuery({
  args: { refundId: v.id("saleRefunds") },
  returns: v.union(
    v.object({
      name: v.string(),
      email: v.string(),
      phone: v.union(v.string(), v.null()),
      amountCents: v.number(),
      eventName: v.string(),
      slug: v.union(v.string(), v.null()),
      chapterId: v.id("chapters"),
      eventId: v.id("events"),
    }),
    v.null(),
  ),
  handler: async (ctx, { refundId }) => {
    const refund = await ctx.db.get(refundId);
    if (!refund) return null;
    const order = await ctx.db.get(refund.ticketOrderId);
    if (!order) return null;
    const event = await ctx.db.get(order.eventId);
    const page = await ctx.db
      .query("eventPages")
      .withIndex("by_event", (q) => q.eq("eventId", order.eventId))
      .unique();
    const rsvp = order.rsvpId ? await ctx.db.get(order.rsvpId) : null;
    return {
      name: order.name,
      email: order.email,
      phone: rsvp?.phone ?? null,
      amountCents: refund.amountCents,
      eventName: event?.name ?? "your event",
      slug: page?.slug ?? null,
      chapterId: order.chapterId,
      eventId: order.eventId,
    };
  },
});

/** The email body — exported so the test can read what a buyer receives. */
export function refundEmailHtml(p: {
  name: string;
  amountCents: number;
  eventName: string;
  slug: string | null;
}): string {
  const firstName = p.name.split(/\s+/)[0] || "there";
  const amount = formatCents(p.amountCents);
  return emailShell(`
      ${emailHeading(`Your ticket was refunded, ${escapeHtml(firstName)}`, { size: 24 })}
      ${emailParagraph(
        `We've refunded <b>${amount}</b> to the card you used for <b>${escapeHtml(p.eventName)}</b>. Your ticket no longer works at the door.`,
        { margin: "0 0 20px" },
      )}
      ${emailPanel(emailCode(amount), { dashed: true, center: true, margin: "0" })}
      ${emailParagraph(REFUND_TIMING, { margin: "16px 0 0" })}
      ${p.slug ? emailParagraph(`Event details: ${emailLink(rsvpPageUrl(p.slug), escapeHtml(rsvpPageUrl(p.slug)))}`, { size: 12, margin: "16px 0 0" }) : ""}`);
}

export function refundSmsBody(p: { amountCents: number; eventName: string }): string {
  return `Public Worship: your ${formatCents(p.amountCents)} ticket for ${p.eventName} has been refunded to your card. It usually shows up within 5–10 business days, depending on your bank.`;
}

export const sendRefundNotice = internalAction({
  args: {
    refundId: v.id("saleRefunds"),
    /** Email only — for a one-off resend where only an email was asked for. */
    emailOnly: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, { refundId, emailOnly }) => {
    const p = await ctx.runQuery(internal.saleRefundNotices.refundNoticePayload, { refundId });
    if (!p) return null;

    await sendEmail(ctx, {
      to: p.email,
      subject: `Your ticket to ${p.eventName} was refunded`,
      html: refundEmailHtml(p),
    });

    if (emailOnly) return null;
    const to = p.phone ? normalizePhone(p.phone) : null;
    if (!to) return null;
    const creds = await resolveTwilioCredentials(ctx);
    if (!creds) {
      console.log("[refunds] refund SMS skipped (Twilio not configured)");
      return null;
    }
    const body = refundSmsBody(p);
    const segments = estimateSegments(body);
    let outcome: "sent" | "failed" = "sent";
    try {
      await sendSms(creds, { to, body });
    } catch (err) {
      console.error("[refunds] refund SMS failed:", String(err));
      outcome = "failed";
    }
    await ctx.runMutation(internal.smsUsage.recordUsageEvent, {
      chapterId: p.chapterId,
      purpose: "notice",
      eventId: p.eventId,
      phoneLast4: to.slice(-4),
      segments,
      costUsdMicros: outcome === "sent" ? segments * SMS_SEGMENT_PRICE_USD_MICROS : 0,
      outcome,
    });
    return null;
  },
});
