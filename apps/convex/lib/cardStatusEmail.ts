/**
 * The "your card was locked / unlocked / canceled" emails to a CARDHOLDER —
 * subject + HTML, composed here so every path that changes a card's status
 * tells the same story.
 *
 * Requested 2026-11-24: "when someone's card is locked could you please send
 * them an email", then yes to unlock and cancel too. The events:
 *
 *  - `locked_manager` — a finance manager pressed Lock card
 *    (`cards.ts#lockCard`). Only a manager can lift it, so the email says who
 *    to ask. It does NOT guess at a reason (the app stores none) and does NOT
 *    promise a reply time.
 *  - `locked_receipt` — the daily receipt sweep
 *    (`cards.ts#autoLockOverdueCards`) locked it because a charge went
 *    `RECEIPT_GRACE_DAYS` without a receipt. Adding the receipt unlocks it
 *    (`unlockCardIfReceiptsResolved` re-runs the check on upload), so the
 *    email points at the coding page.
 *  - `unlocked_manager` — a finance manager pressed Unlock card.
 *  - `unlocked_receipt` — the receipt lock cleared (receipt added).
 *  - `canceled` — a finance manager canceled the card for good.
 *
 * A holder's own freeze/unfreeze sends nothing: they did it themselves.
 *
 * Pure: no ctx, no db, no network.
 */
import { RECEIPT_GRACE_DAYS } from "@events-os/shared";
import { escapeHtml } from "./html";
import { emailButtonRow, emailHeading, emailParagraph, emailShell } from "./emailShell";

export const CARD_STATUS_EVENTS = [
  "locked_manager",
  "locked_receipt",
  "unlocked_manager",
  "unlocked_receipt",
  "canceled",
] as const;
export type CardStatusEvent = (typeof CARD_STATUS_EVENTS)[number];

/** The card status each event leaves behind — the notifier sends only while
 *  the card is still in it (an unlock right after a lock cancels the lock
 *  email, and vice versa). */
export function statusAfter(event: CardStatusEvent): "locked" | "active" | "canceled" {
  if (event === "locked_manager" || event === "locked_receipt") return "locked";
  if (event === "canceled") return "canceled";
  return "active";
}

/** Where each email's button goes (an app path, made absolute by `appUrl`). */
export function linkPathFor(event: CardStatusEvent): string {
  return event === "locked_receipt" ? "/code?filter=uncoded" : "/finances/cards";
}

export interface CardStatusEmailInput {
  event: CardStatusEvent;
  cardholderName: string;
  /** Last four digits of the card, when known. */
  last4: string | null;
  /** The manager who made the change (manager events only), when known. */
  actorName: string | null;
  /** Absolute link for the call to action, or null when APP_URL is unset. */
  link: string | null;
}

export function buildCardStatusEmail(input: CardStatusEmailInput): {
  subject: string;
  html: string;
} {
  const card = input.last4
    ? `your Public Worship card ending in ${escapeHtml(input.last4)}`
    : "your Public Worship card";
  const hi = `Hi ${escapeHtml(input.cardholderName)},`;
  const actor = input.actorName ? escapeHtml(input.actorName) : null;
  const button = (label: string) =>
    input.link
      ? emailButtonRow(input.link, label)
      : emailParagraph("Open the app to see your card.", { size: 12, margin: "0" });

  let subject: string;
  let body: string[];
  switch (input.event) {
    case "locked_manager":
      subject = "Your Public Worship card has been locked";
      body = [
        emailParagraph(`${hi} ${actor ?? "A finance manager"} locked ${card}. Purchases on it will be declined until it's unlocked.`),
        emailParagraph(
          `If you're not sure why, or you need it turned back on, talk to ${actor ?? "your finance manager"}. Only a finance manager can unlock it.`,
        ),
        button("View your card →"),
      ];
      break;
    case "locked_receipt":
      subject = "Your card is locked until you add a receipt";
      body = [
        emailParagraph(
          `${hi} ${card} is locked because a charge on it has gone ${RECEIPT_GRACE_DAYS} days without a receipt. Purchases on it will be declined for now.`,
        ),
        emailParagraph("Add the missing receipt and the card unlocks on its own."),
        input.link
          ? emailButtonRow(input.link, "Add the receipt →")
          : emailParagraph("Open the app to add the receipt.", { size: 12, margin: "0" }),
      ];
      break;
    case "unlocked_manager":
      subject = "Your Public Worship card is unlocked";
      body = [
        emailParagraph(`${hi} ${actor ?? "A finance manager"} unlocked ${card}. You can use it again.`),
        button("View your card →"),
      ];
      break;
    case "unlocked_receipt":
      subject = "Your Public Worship card is unlocked";
      body = [
        emailParagraph(`${hi} thanks for adding the receipt. ${card.charAt(0).toUpperCase()}${card.slice(1)} is unlocked and you can use it again.`),
        button("View your card →"),
      ];
      break;
    case "canceled":
      subject = "Your Public Worship card has been canceled";
      body = [
        emailParagraph(`${hi} ${actor ?? "A finance manager"} canceled ${card}. It can't be used again, and any purchase on it will be declined.`),
        emailParagraph(
          `If you think this is a mistake or you need a new card, talk to ${actor ?? "your finance manager"}.`,
        ),
        button("View your card →"),
      ];
      break;
  }
  return {
    subject,
    html: emailShell(`${emailHeading(escapeHtml(subject))}${body.join("")}`),
  };
}
