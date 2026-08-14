/**
 * What a NEW BACKER hears from us, the moment they become one.
 *
 * ── WHY THIS EXISTS AS ITS OWN EMAIL ───────────────────────────────────────
 * Before this, becoming a backer produced exactly one piece of mail: the
 * ordinary monthly receipt (`ticketingEmails.sendPledgeReceiptEmail`), the same
 * one that lands on cycle 24 — "Your monthly gift to Brooklyn came through."
 * A person who has just decided to fund this work every month from now on got a
 * transaction record, indistinguishable from routine, and nothing that said the
 * decision itself mattered. That is the biggest single thing anyone does on the
 * giving side of this org and it read as a card statement.
 *
 * So the FIRST cycle gets this email instead of the receipt (see
 * `givingPledges.recordPledgeInvoice` — the two are alternatives, never both,
 * because two emails in the same minute about the same $50 is worse than
 * either). Every cycle after it gets the ordinary receipt, unchanged: a welcome
 * that arrives monthly stops being a welcome.
 *
 * ── WHAT IT HAS TO DO ──────────────────────────────────────────────────────
 * Four things the owner named, in this order:
 *  1. Thank them, without hedging or corporate distance.
 *  2. Say what backing actually makes possible — concretely, not "your support
 *     matters".
 *  3. Promise to keep them in the loop, because a backer is in the room now.
 *  4. Confirm the money facts (amount, when it recurs, how to change it), so it
 *     also works as the receipt it is replacing.
 *
 * PURE — payload in, `{ subject, html }` out, like `givingNotificationEmails.ts`
 * next door, so the copy can be asserted character by character in a test
 * without a database. Painted with `lib/emailShell.ts` so it sits in the inbox
 * looking like everything else this backend sends.
 *
 * TRANSACTIONAL, not marketing: it acknowledges a payment the person just
 * authorised, so it carries no unsubscribe footer and consults no suppression
 * list — the same call `givingComms.ts` documents for the ACH receipts.
 */
import { formatCents } from "@events-os/shared";
import {
  emailButton,
  emailHeading,
  emailLink,
  emailList,
  emailPanel,
  emailParagraph,
  emailRule,
  emailShell,
  emailSubheading,
} from "./emailShell";
import { escapeHtml } from "./html";

const esc = escapeHtml;

export type BackerWelcomePayload = {
  /** The backer's name as they gave it. Escaped at render — it comes off the
   *  public backing form. */
  name: string;
  /** Their monthly pledge, in integer cents. */
  monthlyCents: number;
  /** The city they're backing, or `null` when the chapter is gone — the copy
   *  falls back to the org rather than printing a hole. */
  chapterName: string | null;
  /**
   * The pledge clears the $50/mo BACKER floor (`BACKER_UNIT_CENTS`), so the
   * word "backer" is literally true of them.
   *
   * Below it the copy says "giving monthly" instead. The pledge floor is $5 and
   * the backer floor is $50, and a chapter's public backer count — the number on
   * its `/give` page, the one its milestone ladder is measured against — counts
   * only the second. Calling a $10/month giver a backer would be a promise about
   * a page they don't appear on, discovered by the person least able to shrug it
   * off. The warmth is identical either way; only the noun moves.
   */
  isBacker: boolean;
  /** The public page for their city, when it has one — where the backer
   *  milestones they just moved are rendered. `null` degrades to no button
   *  rather than a dead link. */
  givePageUrl: string | null;
  /** Their own portal — where they manage the card, the amount, and read their
   *  giving. Named here rather than assumed, so a deployment with no site URL
   *  degrades to the reply-to-us sentence instead of a dead button. */
  portalUrl: string | null;
};

/**
 * The first name to greet someone by, or "friend".
 *
 * Same fallback `sendPledgeReceiptEmail` has always used, kept because the
 * alternative — a bare "Thank you," — reads colder than the generic word does,
 * and the name is missing only when somebody typed nothing but spaces.
 */
export function greetingName(name: string): string {
  return name.trim().split(/\s+/)[0] || "friend";
}

/**
 * The welcome. One page, no navigation, nothing to click except their city.
 *
 * ── THE ANNUAL FIGURE IS DELIBERATELY *NOT* IN HERE ────────────────────────
 * The staff-side email leads with "$600 a year" because a fundraising team is
 * weighing this against a one-time gift. Saying it back to the DONOR reads as an
 * invoice for eleven payments they haven't made yet, and the one thing this
 * email must not do is make a generous decision feel like a debt. They see the
 * monthly amount, which is the only number they agreed to.
 */
export function renderBackerWelcomeEmail(payload: BackerWelcomePayload): {
  subject: string;
  html: string;
} {
  const first = greetingName(payload.name);
  const amount = formatCents(payload.monthlyCents);
  const city = payload.chapterName ?? "Public Worship";
  const subject = payload.isBacker
    ? `You're a backer of ${city} 🎉`
    : `You're giving monthly to ${city} 🎉`;

  const inner = [
    emailHeading(`Thank you, ${esc(first)}.`, { size: 28, margin: "0 0 12px" }),
    emailParagraph(
      (payload.isBacker
        ? `You just became a <b>backer of ${esc(city)}</b> — and that word means something specific around here. `
        : `You just started <b>giving monthly to ${esc(city)}</b>, and that means something specific around here. `) +
        `Monthly givers are the reason Public Worship exists. Not a nice-to-have, not a supplement to something else that ` +
        `funds us: the monthly giving of people like you <b>is</b> the funding. It's what lets us plan past this month.`,
      { margin: "0 0 16px" },
    ),
    emailPanel(
      [
        emailSubheading(payload.isBacker ? "Your backing" : "Your monthly giving", {
          size: 14,
          margin: "0 0 8px",
        }),
        emailParagraph(
          `<b>${esc(amount)} a month</b>, to ${esc(city)}, starting today. ` +
            `Your first month has been received — you'll get a short receipt each month from here on, ` +
            `and nothing else to do.`,
          { margin: "0" },
        ),
      ].join(""),
      { margin: "0 0 20px" },
    ),
    emailSubheading("What this actually does", { size: 16, margin: "0 0 8px" }),
    emailParagraph(
      "Because this giving is monthly and dependable rather than one-time and hoped-for, it's the only kind we can commit against. It pays for:",
      { margin: "0 0 12px" },
    ),
    emailList([
      "<b>Worship in the room, every month</b> — the nights themselves, and the people and gear it takes to put one on.",
      "<b>A team on the ground in a city</b>, rather than an event that visits one and leaves.",
      "<b>The next city</b> — a place on the map opens when enough backers stand behind it, so you've just moved a real number on a real page.",
    ]),
    emailParagraph(
      "We'll keep you in the loop — where the nights are happening, what your city is up to, what the giving is unlocking, and the honest version when something's hard. You're in the room now, not on a mailing list.",
      { margin: "0 0 20px" },
    ),
    payload.portalUrl
      ? emailButton(payload.portalUrl, "See your giving")
      : "",
    payload.givePageUrl
      ? emailParagraph(
          `Or see what ${esc(city)} is building: ${emailLink(payload.givePageUrl, payload.givePageUrl)}`,
          { size: 12, margin: "12px 0 0" },
        )
      : "",
    emailRule(),
    // THE PORTAL, NAMED. This sentence used to be "reply to this email and
    // we'll send you a secure link" — a manual process standing in for a page
    // that now exists. A welcome email is the single best place a backer will
    // ever learn the portal is there, so it says so plainly and keeps the
    // human offer underneath rather than instead.
    payload.portalUrl
      ? emailParagraph(
          `Change your amount, update your card, or stop any time — it's all on your own page: ${emailLink(payload.portalUrl, payload.portalUrl)}. Prefer a person? Reply to this email and one will read it.`,
          { size: 12, margin: "0 0 8px" },
        )
      : emailParagraph(
          "Need to change your amount, update your card, or stop your monthly gift? Just reply to this email — a person reads it, and we'll send you a secure link. No hoops, ever.",
          { size: 12, margin: "0 0 8px" },
        ),
    emailParagraph(
      "Thank you for standing with us. Genuinely — this is the biggest thing anyone does here.",
      { size: 12, margin: "0" },
    ),
  ]
    .filter(Boolean)
    .join("\n");

  return { subject, html: emailShell(inner) };
}
