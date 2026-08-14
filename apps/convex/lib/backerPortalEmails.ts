/**
 * The two emails the portal owns: a sign-in code, and the one that says a
 * payment didn't go through.
 *
 * PURE — payload in, `{ subject, html }` out, like `givingNotificationEmails.ts`
 * and `backerWelcomeEmail.ts`, so the copy is assertable character by character
 * without a database. Painted with `lib/emailShell.ts`.
 *
 * Both are TRANSACTIONAL: no unsubscribe footer, no `emailSuppressions` consult.
 * A sign-in code is not marketing, and neither is "your card was declined" —
 * the split is documented in `givingComms.ts`.
 */
import { formatCents } from "@events-os/shared";
import {
  emailButton,
  emailCode,
  emailHeading,
  emailPanel,
  emailParagraph,
  emailRule,
  emailShell,
} from "./emailShell";
import { escapeHtml } from "./html";

const esc = escapeHtml;

/**
 * The sign-in code.
 *
 * Deliberately says almost nothing else. This email is sent to whatever address
 * somebody typed into a public form, so it must not confirm anything about the
 * person it reaches — not their name, not that they're a backer, not what
 * they've given. Someone typing a stranger's address gets a bare code and no
 * information; the person who owns the address gets what they asked for.
 */
export function renderPortalCodeEmail(payload: { code: string }): {
  subject: string;
  html: string;
} {
  return {
    subject: `${payload.code} is your sign-in code`,
    html: emailShell(
      [
        emailHeading("Here's your sign-in code", { size: 24 }),
        emailParagraph(
          "Enter this on the page you just came from. It's good for 15 minutes.",
          { margin: "0 0 18px" },
        ),
        emailPanel(emailCode(esc(payload.code), { letterSpacing: "0.18em" }), {
          dashed: true,
          center: true,
          margin: "0 0 18px",
        }),
        emailParagraph(
          "If you didn't ask for this, you can ignore it — nothing has been shared and nobody has been signed in.",
          { size: 12, margin: "0" },
        ),
      ].join("\n"),
    ),
  };
}

export type PaymentFailedPayload = {
  /** First name, or "friend" — `greetingName` in `backerWelcomeEmail.ts`. */
  firstName: string;
  /** The monthly amount that failed to charge. */
  monthlyCents: number;
  /** The city they back, or `null` — the copy falls back to the org. */
  chapterName: string | null;
  /** The portal, when `APP_URL`/`SITE_URL` resolves. `null` degrades the CTA to
   *  a sentence rather than a dead link. */
  portalUrl: string | null;
};

/**
 * "Your payment didn't go through" — rung one of the dunning ladder.
 *
 * ── THIS EMAIL EXISTS BECAUSE THE SILENCE WAS THE BUG ──────────────────────
 * Before it, a declined card flipped `pledges.status` to `past_due`, dropped
 * the chapter's public backer count, moved its milestone ladder BACKWARDS on a
 * page anyone can read — and told the backer nothing at all. The first they'd
 * have known is a cancellation weeks later.
 *
 * ── THE REGISTER IS `givingComms.ts#onAchFailed`'s, ON PURPOSE ─────────────
 * A failed card is a typo or an expiry far more often than it is a decision,
 * and a person who has given every month for a year deserves the reading that
 * assumes the best. So: no "action required", no urgency theatre, no implied
 * accusation. It states what happened, that nothing has been cancelled, that
 * the bank will be tried again, and offers the one button that fixes it.
 *
 * Rungs 2–4 (weekly, escalating to "do you still want to back Brooklyn?") are
 * the owner's decision and are Phase 2 — a sequence needs a scheduler, a rung
 * stamp, and a re-read-status-at-send-time guard so a recovered payment can't
 * be followed by a nag. One honest email now beats a half-built ladder.
 */
export function renderPaymentFailedEmail(payload: PaymentFailedPayload): {
  subject: string;
  html: string;
} {
  const city = payload.chapterName ?? "Public Worship";
  const amount = formatCents(payload.monthlyCents);
  return {
    subject: `Your monthly gift to ${city} didn't go through`,
    html: emailShell(
      [
        emailHeading(`${esc(payload.firstName)}, your card was declined.`, {
          size: 26,
        }),
        emailParagraph(
          `Your ${esc(amount)} monthly gift to <b>${esc(city)}</b> didn't go through this month. ` +
            `It happens constantly — an expired card, a new number, a bank being cautious — and it says nothing about you.`,
          { margin: "0 0 16px" },
        ),
        emailPanel(
          emailParagraph(
            "<b>Nothing has been cancelled.</b> Your backing is still on, and the bank will be tried again automatically over the next few days. If the card is the problem, updating it fixes this straight away.",
            { margin: "0" },
          ),
          { margin: "0 0 20px" },
        ),
        payload.portalUrl
          ? emailButton(payload.portalUrl, "Update your card")
          : emailParagraph(
              "Reply to this email and we'll send you a secure link to update your card.",
              { margin: "0 0 16px" },
            ),
        emailRule(),
        emailParagraph(
          `And if now isn't the right time to keep giving, that's genuinely all right — reply and tell us, and we'll stop it. No hoops, and no hard feelings. ${esc(city)} is grateful for what you've already given.`,
          { size: 12, margin: "0" },
        ),
      ]
        .filter(Boolean)
        .join("\n"),
    ),
  };
}
