/**
 * Ticketing transactional emails — RSVP confirmations and ticket delivery.
 *
 * `sendEmail`/`sendEmailReporting` are the shared chokepoint every email in
 * this codebase sends through — including `accessAllowlist.ts`'s
 * access-granted mailer, `reminders.ts`, `reimbursements.ts`, `cards.ts`, and
 * `blasts.ts`. No-op when no Resend key resolves (dev). Best effort against a
 * REJECTED response (a bad address, an invalid domain — logged, returns
 * `false`, never throws), but a genuine transport failure (Resend fully down)
 * PROPAGATES out of both — that distinction matters to `blasts.ts`'s
 * per-recipient delivery loop, which needs a real throw to count a failure
 * instead of quietly marking a blast "sent" during an outage.
 *
 * Every email here is painted by `lib/emailShell.ts`, which reads its tokens
 * off `DEFAULT_EMAIL_THEME` — the SAME theme campaign email renders on. There
 * is exactly one brand palette in this codebase (`emailTheme.ts` in
 * `@events-os/shared`); nothing in this file may hardcode a colour.
 * `emailShell` is re-exported below purely so the ~20 existing
 * `from "./ticketingEmails"` imports keep working.
 *
 * The Resend key/from-address come from `lib/resend.ts`'s
 * `resolveResendSettings` — the in-app superuser setting
 * (`integrationSettings.setResendSettings`, profile > integrations) first,
 * falling back to the deployment `RESEND_API_KEY`/`AUTH_EMAIL_FROM` env vars.
 * That's why both helpers take `ctx` as their first argument now — resolving
 * the stored setting needs `ctx.runQuery`.
 */
import { internalAction } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { rsvpPageUrl, siteUrl } from "./lib/siteUrl";
import { resolveResendSettings, sendResendEmail } from "./lib/resend";
import { escapeHtml } from "./lib/html";
import {
  EMAIL_CLS,
  EMAIL_THEME,
  emailButton,
  emailCode,
  emailEyebrow,
  emailHeading,
  emailLink,
  emailPanel,
  emailParagraph,
  emailShell,
  emailTextStyle,
} from "./lib/emailShell";

/** Re-export so the existing `import { emailShell } from "./ticketingEmails"`
 *  call sites (reminders, cards, reimbursements, blasts, budget/campaign
 *  approvals, finances) keep working. The implementation — and the theme it
 *  reads — lives in `lib/emailShell.ts`. */
export { emailShell };

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

/**
 * Same send as `sendEmail`, but tells the caller whether delivery actually
 * landed — `true` only when a Resend key resolved (stored setting or
 * `RESEND_API_KEY` env) AND Resend responded 2xx. Callers that need to report
 * a delivery outcome upstream (e.g. the Increase digital-wallet-authentication
 * webhook, or `blasts.ts`'s per-recipient send loop) should use this instead
 * of `sendEmail`.
 *
 * A non-2xx Resend response resolves to `false` (logged by
 * `sendResendEmail`, never thrown) — a single bounced/rejected address isn't
 * a system failure. A genuine transport error (network down, Resend
 * unreachable) is deliberately NOT caught here: it propagates to the caller,
 * so a full Resend outage surfaces as a real failure instead of silently
 * resolving `false` alongside an ordinary bounce.
 *
 * `ctx` is the minimal shape `resolveResendSettings` needs (`runQuery`) —
 * every call site already has a real `ActionCtx` in scope.
 */
export async function sendEmailReporting(
  ctx: Pick<ActionCtx, "runQuery">,
  { to, subject, html }: { to: string; subject: string; html: string },
): Promise<boolean> {
  const settings = await resolveResendSettings(ctx);
  if (!settings) {
    console.log(`[ticketing] email skipped (no Resend key configured): "${subject}" → ${to}`);
    return false;
  }
  const result = await sendResendEmail(settings, { to, subject, html });
  return result.ok;
}

/** Best-effort against a rejected Resend response (returns without throwing —
 *  see `sendEmailReporting`), but a transport-level failure (Resend
 *  unreachable) still throws out of here, same as it does out of
 *  `sendEmailReporting`. Every current caller besides `blasts.ts` is a
 *  scheduled `internalAction` where an uncaught throw just fails that one
 *  scheduled run (no retry storm) rather than looking like a delivered
 *  email. */
export async function sendEmail(
  ctx: Pick<ActionCtx, "runQuery">,
  args: { to: string; subject: string; html: string },
) {
  await sendEmailReporting(ctx, args);
}

/** The 6-digit email-verification code for an RSVP's email address. */
export const sendVerificationEmail = internalAction({
  args: { email: v.string(), code: v.string() },
  handler: async (ctx, { email, code }) => {
    await sendEmail(ctx, {
      to: email,
      subject: `${code} is your verification code`,
      html: emailShell(`
      ${emailHeading("Confirm your email", { size: 26 })}
      ${emailParagraph(
        "Enter this code on the RSVP page so the host knows this address is really yours. It expires in 15 minutes.",
        { margin: "0 0 20px" },
      )}
      ${emailPanel(emailCode(escapeHtml(code), { size: 32, letterSpacing: "0.28em" }), {
        dashed: true,
        center: true,
        margin: "0",
      })}
      ${emailParagraph(
        "Didn't RSVP to a Public Worship event? You can safely ignore this email.",
        { size: 12, margin: "16px 0 0" },
      )}`),
    });
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
  handler: async (ctx, { slug, name, email, status }) => {
    const url = rsvpPageUrl(slug);
    const firstName = name.split(/\s+/)[0];
    const heading =
      status === "going" ? `You're going, ${firstName} 🎉` : `Saved your maybe, ${firstName}`;
    const line =
      status === "going"
        ? "We can't wait to see you. The details live on the RSVP page — check back for updates from the host."
        : "No pressure — you can change your RSVP any time on the RSVP page.";
    await sendEmail(ctx, {
      to: email,
      subject: status === "going" ? "You're on the list 🎉" : "Got your RSVP",
      html: emailShell(`
      ${emailHeading(escapeHtml(heading), { size: 26 })}
      ${emailParagraph(line, { margin: "0 0 20px" })}
      ${emailButton(url, "Open the RSVP page")}`),
    });
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
      .map((t) =>
        emailPanel(
          `${emailEyebrow(escapeHtml(t.ticketTypeName), { margin: "0" })}
        ${t.attendeeName ? `<div class="${EMAIL_CLS.text}" style="${emailTextStyle({ margin: "2px 0 0", strong: true })};font-weight:600">${escapeHtml(t.attendeeName)}</div>` : ""}
        <div style="padding-top:2px">${emailCode(escapeHtml(t.code), { size: 20, letterSpacing: "0.06em" })}</div>`,
          { dashed: true, margin: "0 0 10px", href: `${base}/t/${t.code}` },
        ),
      )
      .join("");

    await sendEmail(ctx, {
      to: order.email,
      subject: `Your ticket${tickets.length === 1 ? "" : "s"} to ${eventName}`,
      html: emailShell(`
      ${emailHeading(escapeHtml(eventName), { size: 26, margin: "0 0 6px" })}
      ${emailParagraph(
        `${escapeHtml(when)}${venueName ? ` · ${escapeHtml(venueName)}` : ""}<br/>${tickets.length} ticket${tickets.length === 1 ? "" : "s"} · ${total}`,
        { margin: "0 0 20px" },
      )}
      ${ticketRows}
      ${emailParagraph(
        `Tap a ticket to open it — each has a QR code for the door. ${slug ? `Event details: ${emailLink(rsvpPageUrl(slug), escapeHtml(rsvpPageUrl(slug)))}` : ""}`,
        { size: 12, margin: "16px 0 0" },
      )}`),
    });
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
    await sendEmail(ctx, {
      to: email,
      subject: `Thank you for your gift to ${eventName}`,
      html: emailShell(`
      ${emailHeading(`Thank you, ${escapeHtml(firstName)} 🙏`, { size: 26 })}
      ${emailParagraph(
        `Your gift of <b>${amount}</b> to <b>${escapeHtml(eventName)}</b> came through. It means the world — thank you for supporting the work.`,
        { margin: "0 0 20px" },
      )}
      ${emailPanel(emailCode(amount), { dashed: true, center: true, margin: "0" })}
      ${slug ? emailParagraph(`Event details: ${emailLink(rsvpPageUrl(slug), escapeHtml(rsvpPageUrl(slug)))}`, { size: 12, margin: "16px 0 0" }) : ""}`),
    });
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
    await sendEmail(ctx, {
      to: email,
      subject: `Your monthly gift to ${city}`,
      html: emailShell(`
      ${emailHeading(`Thank you, ${escapeHtml(firstName)} 🙏`, { size: 26 })}
      ${emailParagraph(
        `Your monthly gift of <b>${amount}</b> to <b>${escapeHtml(city)}</b> came through. Backers like you are what make the work possible, month after month — thank you for standing with us.`,
        { margin: "0 0 20px" },
      )}
      ${emailPanel(
        `${emailCode(amount)}<span class="${EMAIL_CLS.text}" style="font-family:${EMAIL_THEME.bodyFont};font-size:14px;color:${EMAIL_THEME.muted}"> / month</span>`,
        { dashed: true, center: true, margin: "0" },
      )}
      ${emailParagraph(
        "Need to update your card or change your amount? Just reply to this email and we'll send you a secure link.",
        { size: 12, margin: "16px 0 0" },
      )}`),
    });
    return null;
  },
});
