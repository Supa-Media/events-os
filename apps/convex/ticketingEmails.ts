/**
 * Ticketing transactional emails — RSVP confirmations and ticket delivery.
 *
 * Same Resend-over-fetch pattern as `guests.sendAccessGrantedEmail`: best
 * effort (log, never throw), no-op without RESEND_API_KEY (dev). All emails
 * carry the Public Worship look: cream card, deep-red accents.
 */
import { internalAction } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { eventPageUrl, siteUrl } from "./lib/siteUrl";

const ACCENT = "#D23B3A";
const INK = "#210909";
const CREAM = "#FDF6F6";
const MUTED = "#7A5A5A";

function formatWhen(ts: number | null): string {
  if (!ts) return "";
  return new Date(ts).toLocaleString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
  });
}

/** Shared shell: centered cream card on white with a red wordmark strip. */
export function emailShell(inner: string): string {
  return `<div style="margin:0;padding:32px 12px;background:#ffffff;font-family:Georgia,'Times New Roman',serif;color:${INK}">
  <div style="max-width:520px;margin:0 auto">
    <div style="text-align:center;padding-bottom:16px;font-family:-apple-system,'Segoe UI',Roboto,sans-serif;font-weight:700;letter-spacing:0.12em;font-size:12px;color:${ACCENT}">PUBLIC WORSHIP</div>
    <div style="background:${CREAM};border:1px solid #EFE0DC;border-radius:20px;padding:32px 28px">
      ${inner}
    </div>
    <div style="text-align:center;padding-top:16px;font-family:-apple-system,'Segoe UI',Roboto,sans-serif;font-size:11px;color:${MUTED}">Sent with love by Public Worship · Chapter OS</div>
  </div>
</div>`;
}

/**
 * Same best-effort send as `sendEmail`, but tells the caller whether delivery
 * actually landed — `true` only when `RESEND_API_KEY` was configured AND
 * Resend responded 2xx. Callers that need to report a delivery outcome
 * upstream (e.g. the Increase digital-wallet-authentication webhook) should
 * use this instead of `sendEmail`, which always resolves and never throws.
 */
export async function sendEmailReporting(
  to: string,
  subject: string,
  html: string,
): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.AUTH_EMAIL_FROM ?? "auth@events-os.com";
  if (!apiKey) {
    console.log(`[ticketing] email skipped (no RESEND_API_KEY): "${subject}" → ${to}`);
    return false;
  }
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from, to, subject, html }),
  });
  if (!response.ok) {
    console.error(`[ticketing] email failed ("${subject}"):`, await response.text());
    return false;
  }
  return true;
}

export async function sendEmail(to: string, subject: string, html: string) {
  await sendEmailReporting(to, subject, html);
}

/** The 6-digit email-verification code for an RSVP's email address. */
export const sendVerificationEmail = internalAction({
  args: { email: v.string(), code: v.string() },
  handler: async (_ctx, { email, code }) => {
    await sendEmail(
      email,
      `${code} is your verification code`,
      emailShell(`
      <h1 style="margin:0 0 12px;font-size:26px;line-height:1.2">Confirm your email</h1>
      <p style="margin:0 0 20px;font-family:-apple-system,'Segoe UI',Roboto,sans-serif;font-size:14px;line-height:1.6;color:${MUTED}">Enter this code on the event page so the host knows this address is really yours. It expires in 15 minutes.</p>
      <div style="background:#fff;border:1px dashed #E4CFCB;border-radius:14px;padding:18px;text-align:center;font-family:'SF Mono',Menlo,Consolas,monospace;font-size:32px;font-weight:700;letter-spacing:0.28em;color:${ACCENT}">${code}</div>
      <p style="margin:16px 0 0;font-family:-apple-system,'Segoe UI',Roboto,sans-serif;font-size:12px;line-height:1.6;color:${MUTED}">Didn't RSVP to a Public Worship event? You can safely ignore this email.</p>`),
    );
    return null;
  },
});

/** "You're in!" note after a public RSVP (going/maybe only). */
export const sendRsvpEmail = internalAction({
  args: {
    slug: v.string(),
    name: v.string(),
    email: v.string(),
    status: v.union(v.literal("going"), v.literal("maybe")),
  },
  handler: async (_ctx, { slug, name, email, status }) => {
    const url = eventPageUrl(slug);
    const firstName = name.split(/\s+/)[0];
    const heading =
      status === "going" ? `You're going, ${firstName} 🎉` : `Saved your maybe, ${firstName}`;
    const line =
      status === "going"
        ? "We can't wait to see you. The details live on the event page — check back for updates from the host."
        : "No pressure — you can change your RSVP any time on the event page.";
    await sendEmail(
      email,
      status === "going" ? "You're on the list 🎉" : "Got your RSVP",
      emailShell(`
      <h1 style="margin:0 0 12px;font-size:26px;line-height:1.2">${heading}</h1>
      <p style="margin:0 0 20px;font-family:-apple-system,'Segoe UI',Roboto,sans-serif;font-size:14px;line-height:1.6;color:${MUTED}">${line}</p>
      <a href="${url}" style="display:inline-block;background:${ACCENT};color:#fff;text-decoration:none;font-family:-apple-system,'Segoe UI',Roboto,sans-serif;font-weight:600;font-size:14px;padding:12px 24px;border-radius:999px">Open the event page</a>`),
    );
    return null;
  },
});

/** Ticket delivery after a paid (or free) order is fulfilled. */
export const sendTicketsEmail = internalAction({
  args: { orderId: v.id("ticketOrders") },
  handler: async (ctx, { orderId }) => {
    const payload = await ctx.runQuery(
      internal.ticketing.getOrderEmailPayload,
      { orderId },
    );
    if (!payload) return null;
    const { order, tickets, eventName, startDate, venueName, slug } = payload;
    const base = siteUrl();
    const when = formatWhen(startDate);
    const total =
      order.totalCents === 0
        ? "Free"
        : `$${(order.totalCents / 100).toFixed(2)}`;

    const ticketRows = tickets
      .map(
        (t) => `
      <a href="${base}/t/${t.code}" style="display:block;text-decoration:none;color:${INK};background:#fff;border:1px dashed #E4CFCB;border-radius:14px;padding:14px 18px;margin:0 0 10px">
        <div style="font-family:-apple-system,'Segoe UI',Roboto,sans-serif;font-size:11px;letter-spacing:0.08em;color:${MUTED};text-transform:uppercase">${t.ticketTypeName}</div>
        <div style="font-family:'SF Mono',Menlo,Consolas,monospace;font-size:20px;font-weight:700;letter-spacing:0.06em;color:${ACCENT};padding-top:2px">${t.code}</div>
      </a>`,
      )
      .join("");

    await sendEmail(
      order.email,
      `Your ticket${tickets.length === 1 ? "" : "s"} to ${eventName}`,
      emailShell(`
      <h1 style="margin:0 0 6px;font-size:26px;line-height:1.2">${eventName}</h1>
      <p style="margin:0 0 20px;font-family:-apple-system,'Segoe UI',Roboto,sans-serif;font-size:14px;line-height:1.6;color:${MUTED}">
        ${when}${venueName ? ` · ${venueName}` : ""}<br/>
        ${tickets.length} ticket${tickets.length === 1 ? "" : "s"} · ${total}
      </p>
      ${ticketRows}
      <p style="margin:16px 0 0;font-family:-apple-system,'Segoe UI',Roboto,sans-serif;font-size:12px;line-height:1.6;color:${MUTED}">Tap a ticket to open it — each has a QR code for the door. ${slug ? `Event details: <a href="${eventPageUrl(slug)}" style="color:${ACCENT}">${eventPageUrl(slug)}</a>` : ""}</p>`),
    );
    return null;
  },
});

/** Thank-you receipt after a paid card donation is fulfilled. */
export const sendDonationReceiptEmail = internalAction({
  args: { donationId: v.id("donations") },
  handler: async (ctx, { donationId }) => {
    const payload = await ctx.runQuery(
      internal.giving.getDonationEmailPayload,
      { donationId },
    );
    if (!payload) return null;
    const { email, name, amountCents, eventName, slug } = payload;
    const firstName = name.split(/\s+/)[0] || "friend";
    const amount = `$${(amountCents / 100).toFixed(amountCents % 100 === 0 ? 0 : 2)}`;
    await sendEmail(
      email,
      `Thank you for your gift to ${eventName}`,
      emailShell(`
      <h1 style="margin:0 0 12px;font-size:26px;line-height:1.2">Thank you, ${firstName} 🙏</h1>
      <p style="margin:0 0 20px;font-family:-apple-system,'Segoe UI',Roboto,sans-serif;font-size:14px;line-height:1.6;color:${MUTED}">Your gift of <b>${amount}</b> to <b>${eventName}</b> came through. It means the world — thank you for supporting the work.</p>
      <div style="background:#fff;border:1px dashed #E4CFCB;border-radius:14px;padding:18px;text-align:center;font-family:'SF Mono',Menlo,Consolas,monospace;font-size:28px;font-weight:700;color:${ACCENT}">${amount}</div>
      ${slug ? `<p style="margin:16px 0 0;font-family:-apple-system,'Segoe UI',Roboto,sans-serif;font-size:12px;line-height:1.6;color:${MUTED}">Event details: <a href="${eventPageUrl(slug)}" style="color:${ACCENT}">${eventPageUrl(slug)}</a></p>` : ""}`),
    );
    return null;
  },
});

/**
 * Monthly receipt after a backer's Stripe billing cycle is recorded
 * (F-6 P2 `invoice.paid`). Extends the donation-receipt pattern; copy speaks to
 * standing monthly support rather than a one-time gift. Reads its payload from
 * the gift written for the cycle.
 */
export const sendPledgeReceiptEmail = internalAction({
  args: { giftId: v.id("gifts") },
  handler: async (ctx, { giftId }) => {
    const payload = await ctx.runQuery(
      internal.givingPledges.getPledgeReceiptPayload,
      { giftId },
    );
    if (!payload) return null;
    const { email, name, amountCents, chapterName } = payload;
    const firstName = name.split(/\s+/)[0] || "friend";
    const amount = `$${(amountCents / 100).toFixed(amountCents % 100 === 0 ? 0 : 2)}`;
    const city = chapterName ?? "Public Worship";
    await sendEmail(
      email,
      `Your monthly gift to ${city}`,
      emailShell(`
      <h1 style="margin:0 0 12px;font-size:26px;line-height:1.2">Thank you, ${firstName} 🙏</h1>
      <p style="margin:0 0 20px;font-family:-apple-system,'Segoe UI',Roboto,sans-serif;font-size:14px;line-height:1.6;color:${MUTED}">Your monthly gift of <b>${amount}</b> to <b>${city}</b> came through. Backers like you are what make the work possible, month after month — thank you for standing with us.</p>
      <div style="background:#fff;border:1px dashed #E4CFCB;border-radius:14px;padding:18px;text-align:center;font-family:'SF Mono',Menlo,Consolas,monospace;font-size:28px;font-weight:700;color:${ACCENT}">${amount}<span style="font-size:14px;font-weight:400;color:${MUTED}"> / month</span></div>
      <p style="margin:16px 0 0;font-family:-apple-system,'Segoe UI',Roboto,sans-serif;font-size:12px;line-height:1.6;color:${MUTED}">Need to update your card or change your amount? Just reply to this email and we'll send you a secure link.</p>`),
    );
    return null;
  },
});
