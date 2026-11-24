/**
 * The "your card is locked" email to a CARDHOLDER — subject + HTML, composed
 * here so both lock paths tell the same story.
 *
 * Requested 2026-11-24: "when someone's card is locked could you please send
 * them an email". Two locks reach a cardholder without them doing anything:
 *
 *  - `manager` — a finance manager pressed Lock card (`cards.ts#lockCard`).
 *    Only a manager can lift it, so the email says who to ask. It does NOT
 *    guess at a reason (the app stores none) and does NOT promise a reply time.
 *  - `receipt` — the daily receipt sweep (`cards.ts#autoLockOverdueCards`)
 *    locked it because a charge went `RECEIPT_GRACE_DAYS` without a receipt.
 *    Adding the receipt unlocks it (`unlockCardIfReceiptsResolved` re-runs the
 *    check on upload), so the email points at the coding page.
 *
 * A holder's own freeze sends nothing: they did it themselves.
 *
 * Pure: no ctx, no db, no network.
 */
import { RECEIPT_GRACE_DAYS } from "@events-os/shared";
import { escapeHtml } from "./html";
import { emailButtonRow, emailHeading, emailParagraph, emailShell } from "./emailShell";

export type CardLockReason = "manager" | "receipt";

export interface CardLockedEmailInput {
  reason: CardLockReason;
  cardholderName: string;
  /** Last four digits of the card, when known. */
  last4: string | null;
  /** The manager who locked it (manager locks only), when known. */
  lockedByName: string | null;
  /** Absolute link for the call to action, or null when APP_URL is unset. */
  link: string | null;
}

export function buildCardLockedEmail(input: CardLockedEmailInput): {
  subject: string;
  html: string;
} {
  const card = input.last4
    ? `your Public Worship card ending in ${escapeHtml(input.last4)}`
    : "your Public Worship card";
  const hi = `Hi ${escapeHtml(input.cardholderName)},`;

  if (input.reason === "manager") {
    const who = input.lockedByName
      ? escapeHtml(input.lockedByName)
      : "A finance manager";
    const subject = "Your Public Worship card has been locked";
    const body = [
      emailParagraph(`${hi} ${who} locked ${card}. Purchases on it will be declined until it's unlocked.`),
      emailParagraph(
        `If you're not sure why, or you need it turned back on, talk to ${input.lockedByName ? escapeHtml(input.lockedByName) : "your finance manager"}. Only a finance manager can unlock it.`,
      ),
      input.link ? emailButtonRow(input.link, "View your card →") : "",
    ].join("");
    return {
      subject,
      html: emailShell(`${emailHeading(escapeHtml(subject))}${body}`),
    };
  }

  const subject = "Your card is locked until you add a receipt";
  const body = [
    emailParagraph(
      `${hi} ${card} is locked because a charge on it has gone ${RECEIPT_GRACE_DAYS} days without a receipt. Purchases on it will be declined for now.`,
    ),
    emailParagraph(
      "Add the missing receipt and the card unlocks on its own.",
    ),
    input.link
      ? emailButtonRow(input.link, "Add the receipt →")
      : emailParagraph("Open the app to add the receipt.", {
          size: 12,
          margin: "0",
        }),
  ].join("");
  return {
    subject,
    html: emailShell(`${emailHeading(escapeHtml(subject))}${body}`),
  };
}
