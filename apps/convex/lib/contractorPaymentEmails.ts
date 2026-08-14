/**
 * The notices a contractor payment sends, as pure builders.
 *
 * Builders only — nothing here sends, queries, or touches `ctx`. The
 * `internalAction`s in `contractorPayments.ts` project the payload, call these,
 * and hand the HTML to Resend, which is the shape every notice in this codebase
 * has (`lib/reimbursementApprovedEmail.ts`, `lib/reimbursementPaidEmail.ts`).
 * Keeping the wording in a pure module is what makes it testable without a
 * mailer.
 *
 * WHAT THESE EMAILS MAY NOT CONTAIN: the contractor's bank details beyond a
 * last-four they typed themselves, anything from their tax document, and — in
 * the treasurer-facing notices — any of the payee's contact details beyond
 * their name. An email is the least controlled surface this feature has; it
 * gets forwarded, it sits in inboxes for years, and it is not covered by any of
 * the access resolvers. So it carries the minimum that makes the message
 * actionable and a link to the app for everything else.
 */
import {
  emailHeading,
  emailParagraph,
  emailButtonRow,
  emailPanel,
} from "./emailShell";
import { escapeHtml } from "./html";
import {
  CONTRACTOR_LEDGER_COUNTERPARTY,
  type ContractorPaymentOrigin,
} from "@events-os/shared";

function usd(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function shortDate(ms: number | undefined): string {
  if (ms == null) return "—";
  return new Date(ms).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * The terms block, rendered the same way in every email that shows terms so a
 * contractor comparing the invitation against the confirmation sees the
 * identical four facts in the identical order.
 */
function termsPanel(args: {
  serviceDescription: string;
  serviceDate?: number;
  amountCents: number;
  chapterName: string;
}): string {
  return emailPanel(`
    ${emailParagraph(`<strong>What for:</strong> ${escapeHtml(args.serviceDescription)}`, { margin: "0 0 8px" })}
    ${emailParagraph(`<strong>Date of service:</strong> ${shortDate(args.serviceDate)}`, { margin: "0 0 8px" })}
    ${emailParagraph(`<strong>Amount:</strong> ${usd(args.amountCents)}`, { margin: "0 0 8px" })}
    ${emailParagraph(`<strong>Paid by:</strong> ${escapeHtml(args.chapterName)}`, { margin: "0" })}
  `);
}

/**
 * "Here is what we agreed — fill in your details."
 *
 * The invitation the contractor gets when staff sends them a pre-filled
 * agreement. Leads with the terms because that is what they are being asked to
 * agree to; the call to action is second. Says plainly what the link will ask
 * for, so opening it is not a surprise — a stranger being asked for a Social
 * Security number and a bank account deserves to know that before they click.
 */
export function buildAgreementInvite(args: {
  payeeName: string;
  chapterName: string;
  serviceDescription: string;
  serviceDate?: number;
  amountCents: number;
  url: string;
  isResend: boolean;
}): { subject: string; html: string } {
  const subject = args.isResend
    ? `Updated: your agreement with ${args.chapterName}`
    : `${args.chapterName} would like to pay you ${usd(args.amountCents)}`;
  const html = `
    ${emailHeading(args.isResend ? "The terms changed" : "You're being paid for your work", { size: 26 })}
    ${emailParagraph(
      args.isResend
        ? `Hi ${escapeHtml(args.payeeName)} — ${escapeHtml(args.chapterName)} updated the terms below, so we need you to look them over and accept again.`
        : `Hi ${escapeHtml(args.payeeName)} — ${escapeHtml(args.chapterName)} has set up a payment for you. Here are the terms:`,
      { margin: "0 0 16px" },
    )}
    ${termsPanel(args)}
    ${emailParagraph(
      "To get paid, open the link below and add your details: your name and email, a completed W-9, and the bank account the money should go to. It takes a few minutes.",
      { margin: "16px 0" },
    )}
    ${emailButtonRow(args.url, args.isResend ? "Review the new terms" : "Complete your details")}
    ${emailParagraph(
      "This link is private to you — anyone with it can fill in your payment details, so please don't forward it.",
      { margin: "16px 0 0" },
    )}
  `;
  return { subject, html };
}

/**
 * "We got it, here's what happens next."
 *
 * Sent to the contractor on submission. THE PUBLIC-LEDGER DISCLOSURE LIVES
 * HERE as well as on the form, and that repetition is deliberate: the form is
 * where they consented, and this is the copy they still have next month when
 * they wonder what the org published. It shows the rendered ledger row — the
 * exact three facts that go public — because describing a disclosure is not the
 * same as showing it.
 */
export function buildSubmittedReceipt(args: {
  payeeName: string;
  chapterName: string;
  reference: string;
  serviceDescription: string;
  serviceDate?: number;
  amountCents: number;
  bankAccountLast4?: string;
  origin: ContractorPaymentOrigin;
}): { subject: string; html: string } {
  const subject = `We got your details — ${args.reference}`;
  const html = `
    ${emailHeading("Thanks — we have everything we need", { size: 26 })}
    ${emailParagraph(
      args.origin === "self_serve"
        ? `Hi ${escapeHtml(args.payeeName)} — your payment request is with ${escapeHtml(args.chapterName)}'s treasurer for approval. We'll email you when there's a decision.`
        : `Hi ${escapeHtml(args.payeeName)} — your details are in and your agreement is with ${escapeHtml(args.chapterName)}'s treasurer for approval. We'll email you when it's approved and again when the money is sent.`,
      { margin: "0 0 16px" },
    )}
    ${termsPanel(args)}
    ${
      args.bankAccountLast4
        ? emailParagraph(
            `The money will go to the account ending <strong>${escapeHtml(args.bankAccountLast4)}</strong>. If that's wrong, reply to this email before it's paid.`,
            { margin: "16px 0" },
          )
        : ""
    }
    ${emailHeading("What becomes public", { size: 18 })}
    ${emailParagraph(
      `${escapeHtml(args.chapterName)} publishes a public ledger of what it spends. This payment will appear on it like this:`,
      { margin: "0 0 12px" },
    )}
    ${emailPanel(`
      ${emailParagraph(`<strong>${escapeHtml(CONTRACTOR_LEDGER_COUNTERPARTY)}</strong> — ${escapeHtml(args.serviceDescription)}`, { margin: "0 0 4px" })}
      ${emailParagraph(`${usd(args.amountCents)} · ${shortDate(args.serviceDate)}`, { margin: "0" })}
    `)}
    ${emailParagraph(
      "Your name, your email, your tax form, and your bank details are <strong>not</strong> published and are never shown publicly. Only the description of the work and the amount appear.",
      { margin: "12px 0 0" },
    )}
    ${emailParagraph(
      "Your tax form is kept securely, is visible only to the finance team, and is destroyed four years after the tax year it covers.",
      { margin: "12px 0 0" },
    )}
    ${emailParagraph(`Reference: ${escapeHtml(args.reference)}`, {
      margin: "16px 0 0",
    })}
  `;
  return { subject, html };
}

/** "A treasurer needs you to change something." */
export function buildChangesRequestedNotice(args: {
  payeeName: string;
  chapterName: string;
  reference: string;
  note: string;
  url: string;
}): { subject: string; html: string } {
  return {
    subject: `One thing to fix — ${args.reference}`,
    html: `
      ${emailHeading("We need one change", { size: 26 })}
      ${emailParagraph(
        `Hi ${escapeHtml(args.payeeName)} — ${escapeHtml(args.chapterName)}'s treasurer looked at your payment and asked for this:`,
        { margin: "0 0 16px" },
      )}
      ${emailPanel(emailParagraph(escapeHtml(args.note), { margin: "0" }))}
      ${emailParagraph("Open your link, make the change, and send it back.", {
        margin: "16px 0",
      })}
      ${emailButtonRow(args.url, "Update your details")}
    `,
  };
}

/** "You're approved — the money is on its way." Deliberately does NOT promise a
 *  date: an ACH lands when it lands, and a promise we can't keep is worse than
 *  no promise. */
export function buildApprovedNotice(args: {
  payeeName: string;
  chapterName: string;
  reference: string;
  amountCents: number;
  bankAccountLast4?: string;
}): { subject: string; html: string } {
  return {
    subject: `Approved: ${usd(args.amountCents)} from ${args.chapterName}`,
    html: `
      ${emailHeading("Your payment is approved", { size: 26 })}
      ${emailParagraph(
        `Hi ${escapeHtml(args.payeeName)} — ${escapeHtml(args.chapterName)} approved ${usd(args.amountCents)}${
          args.bankAccountLast4
            ? ` to the account ending ${escapeHtml(args.bankAccountLast4)}`
            : ""
        }. It'll be sent by bank transfer, and we'll email you once it's on its way.`,
        { margin: "0 0 16px" },
      )}
      ${emailParagraph(`Reference: ${escapeHtml(args.reference)}`, {
        margin: "16px 0 0",
      })}
    `,
  };
}

/** "The money has been sent." */
export function buildPaidNotice(args: {
  payeeName: string;
  chapterName: string;
  reference: string;
  amountCents: number;
  bankAccountLast4?: string;
  paidAt: number;
}): { subject: string; html: string } {
  return {
    subject: `Sent: ${usd(args.amountCents)} from ${args.chapterName}`,
    html: `
      ${emailHeading("Your money is on its way", { size: 26 })}
      ${emailParagraph(
        `Hi ${escapeHtml(args.payeeName)} — ${escapeHtml(args.chapterName)} sent ${usd(args.amountCents)}${
          args.bankAccountLast4
            ? ` to the account ending ${escapeHtml(args.bankAccountLast4)}`
            : ""
        } on ${shortDate(args.paidAt)}. Bank transfers usually arrive within a couple of business days.`,
        { margin: "0 0 16px" },
      )}
      ${emailParagraph(
        "If it hasn't arrived within five business days, reply to this email and we'll look into it.",
        { margin: "0 0 16px" },
      )}
      ${emailParagraph(`Reference: ${escapeHtml(args.reference)}`, {
        margin: "16px 0 0",
      })}
    `,
  };
}

/**
 * The treasurer's task email — "here is a thing waiting on you."
 *
 * The founder asked for this by name: emailing treasurers about what they need
 * to do. Written as a task, not a notification: it says what it is, what it
 * costs, and what the recipient's next action is, and it links straight to the
 * row rather than to a dashboard they then have to search.
 *
 * CARRIES NO PAYEE CONTACT DETAILS — just the name, the work, and the amount.
 * A treasurer deciding whether to approve does not need the person's email in
 * their inbox, and this message is forwardable.
 */
export function buildReviewTask(args: {
  reference: string;
  payeeName: string;
  serviceDescription: string;
  amountCents: number;
  origin: ContractorPaymentOrigin;
  url: string | null;
  escalated: boolean;
  waitingDays?: number;
}): { subject: string; html: string } {
  const what =
    args.origin === "self_serve"
      ? "Someone has asked to be paid"
      : "A contractor has completed their agreement";
  const subject = args.escalated
    ? `Still waiting (${args.waitingDays ?? 7} days): ${args.reference} — ${usd(args.amountCents)}`
    : `Needs your approval: ${usd(args.amountCents)} to ${args.payeeName}`;
  return {
    subject,
    html: `
      ${emailHeading(args.escalated ? "This has been waiting a while" : "A payment needs your approval", { size: 26 })}
      ${emailParagraph(
        args.escalated
          ? `${escapeHtml(args.reference)} has been waiting ${args.waitingDays ?? 7} days for a decision. Someone is waiting on this money.`
          : `${what} and it needs a treasurer to approve it before the money can go out.`,
        { margin: "0 0 16px" },
      )}
      ${emailPanel(`
        ${emailParagraph(`<strong>${escapeHtml(args.payeeName)}</strong> — ${escapeHtml(args.serviceDescription)}`, { margin: "0 0 4px" })}
        ${emailParagraph(`${usd(args.amountCents)} · ${escapeHtml(args.reference)}`, { margin: "0" })}
      `)}
      ${
        args.origin === "self_serve"
          ? emailParagraph(
              "This one came in as a blank request, so nothing about it is pre-approved — you'll need to say which budget it belongs to before you can approve it.",
              { margin: "16px 0" },
            )
          : ""
      }
      ${args.url ? emailButtonRow(args.url, "Review it") : ""}
    `,
  };
}
