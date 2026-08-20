/**
 * The partner portal's outbound mail — three scheduled actions, each a thin
 * projector over `sponsorPortal.noticePayload` and the pure builders in
 * `lib/sponsorPortalEmails.ts`.
 *
 * SEPARATE FILE FROM `sponsorPortal.ts` on purpose: everything here is an
 * `internalAction` (network I/O), everything there is a query or mutation, and
 * a mutation that could accidentally `await` a mailer is a mutation that can
 * fail a money write because Resend was slow. Same split
 * `contractorPayments.ts` makes, one file later.
 *
 * EVERY HANDLER SWALLOWS ITS OWN FAILURE. These run scheduled, after the write
 * they describe has already committed: a signature is on file whether or not
 * the confirmation reached an inbox, and re-throwing here would put a red
 * scheduled-function failure next to a perfectly good agreement. The console
 * error is the breadcrumb.
 */
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import { appUrl } from "./lib/siteUrl";
import {
  buildPaymentReceipt,
  buildPortalInvite,
  buildSignedAlert,
  buildSignedReceipt,
} from "./lib/sponsorPortalEmails";
import { sendEmail, emailShell } from "./ticketingEmails";

/** Where a staffer lands when they follow an internal notice. Null when APP_URL
 *  is unset, per `appUrl`'s contract — the button is omitted rather than dead. */
function agreementAppUrl(sponsorshipId: string): string | null {
  return appUrl(`/giving/sponsorship/${sponsorshipId}`);
}

/** "Here is your agreement" — sent to the contact when a manager presses Send. */
export const sendInvite = internalAction({
  args: { sponsorshipId: v.id("sponsorships") },
  returns: v.null(),
  handler: async (ctx, { sponsorshipId }) => {
    try {
      const p = await ctx.runQuery(internal.sponsorPortal.noticePayload, {
        sponsorshipId,
      });
      if (!p || !p.contactEmail || !p.portalUrl) return null;
      const { subject, html } = buildPortalInvite({
        orgName: p.orgName,
        contactName: p.contactName,
        title: p.title,
        amountCents: p.amountCents,
        portalUrl: p.portalUrl,
      });
      await sendEmail(ctx, {
        to: p.contactEmail,
        subject,
        html: emailShell(html),
      });
    } catch (err) {
      console.error("[sponsorPortal] invite email failed", err);
    }
    return null;
  },
});

/**
 * The partner signed: their copy, and the desk's alert.
 *
 * ONE ACTION for both so they cannot drift — an agreement that emailed the
 * partner "signed!" while telling nobody on our side is the failure this
 * feature would actually be blamed for (the same argument
 * `contractorPayments.sendSubmittedNotices` makes).
 */
export const onSigned = internalAction({
  args: { sponsorshipId: v.id("sponsorships") },
  returns: v.null(),
  handler: async (ctx, { sponsorshipId }) => {
    try {
      const p = await ctx.runQuery(internal.sponsorPortal.noticePayload, {
        sponsorshipId,
      });
      if (!p || p.signedAt == null || !p.signedName) return null;

      const partnerEmail = p.signedEmail ?? p.contactEmail;
      if (partnerEmail) {
        const { subject, html } = buildSignedReceipt({
          orgName: p.orgName,
          title: p.title,
          signedName: p.signedName,
          signedAt: p.signedAt,
          amountCents: p.amountCents,
          balanceCents: p.balanceCents,
          portalUrl: p.portalUrl,
        });
        await sendEmail(ctx, { to: partnerEmail, subject, html: emailShell(html) });
      }

      if (p.ownerEmail) {
        const { subject, html } = buildSignedAlert({
          orgName: p.orgName,
          title: p.title,
          signedName: p.signedName,
          signedTitle: null,
          signedAt: p.signedAt,
          amountCents: p.amountCents,
          balanceCents: p.balanceCents,
          appUrl: agreementAppUrl(sponsorshipId),
        });
        await sendEmail(ctx, { to: p.ownerEmail, subject, html: emailShell(html) });
      }
    } catch (err) {
      console.error("[sponsorPortal] signed notices failed", err);
    }
    return null;
  },
});

/**
 * A portal payment settled — the partner's receipt.
 *
 * Fires from `recordPortalPaymentPaid`, which runs on BOTH the card path
 * (`checkout.session.completed`) and the bank path
 * (`checkout.session.async_payment_succeeded`, days later). That mutation is
 * idempotent on the session id and only schedules this when it actually books
 * a gift, so a Stripe redelivery cannot produce a second receipt for one
 * payment.
 */
export const onPaymentSettled = internalAction({
  args: { sponsorshipId: v.id("sponsorships"), giftId: v.id("gifts") },
  returns: v.null(),
  handler: async (ctx, { sponsorshipId, giftId }) => {
    try {
      const [p, receipt] = await Promise.all([
        ctx.runQuery(internal.sponsorPortal.noticePayload, { sponsorshipId }),
        ctx.runQuery(internal.sponsorPortal.paymentReceiptPayload, { giftId }),
      ]);
      if (!p || !receipt) return null;
      const to = p.signedEmail ?? p.contactEmail;
      if (!to) return null;
      const { subject, html } = buildPaymentReceipt({
        orgName: p.orgName,
        title: p.title,
        creditedCents: receipt.amountCents,
        chargedCents: receipt.chargedCents,
        feeCoverageCents: receipt.feeCoverageCents,
        balanceCents: p.balanceCents,
        receivedAt: receipt.receivedAt,
        portalUrl: p.portalUrl,
      });
      await sendEmail(ctx, { to, subject, html: emailShell(html) });
    } catch (err) {
      console.error("[sponsorPortal] payment receipt failed", err);
    }
    return null;
  },
});
