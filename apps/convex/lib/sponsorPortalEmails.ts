/**
 * The three notices a partner portal sends, as pure builders.
 *
 * Builders only — nothing here sends, queries, or touches `ctx`. The
 * `internalAction`s in `sponsorPortalNotices.ts` project the payload, call
 * these, and hand the HTML to Resend. That is the shape every notice in this
 * codebase has (`lib/contractorPaymentEmails.ts`,
 * `lib/reimbursementApprovedEmail.ts`), and keeping the wording in a pure
 * module is what makes it testable without a mailer.
 *
 * ── WHAT THESE MAY NOT CONTAIN ──────────────────────────────────────────────
 * The desk's own assessment of the partner. `dueDiligenceNotes` is where a
 * development director writes "pastor's statement of beliefs is thin, visited
 * in March, follow up before committing" — private, internal, and the single
 * worst thing that could reach a partner's inbox. It is unrepresentable in
 * every builder below, and the payload that feeds them does not carry it.
 *
 * The partner-facing notices also never name our internal owner, our pipeline
 * stage, or any other agreement. An email is the least controlled surface this
 * feature has: it gets forwarded, it sits in inboxes for years, and it is
 * covered by none of the access resolvers. So it carries the minimum that makes
 * the message actionable, and a link for everything else.
 */
import {
  emailButtonRow,
  emailHeading,
  emailPanel,
  emailParagraph,
} from "./emailShell";
import { escapeHtml } from "./html";

function usd(cents: number): string {
  return `$${((cents || 0) / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function shortDate(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "America/New_York",
  });
}

/**
 * The invitation — "here is what we agreed, read it and sign it".
 *
 * DOES NOT ASK FOR MONEY IN THE SUBJECT LINE, deliberately. The partner has
 * already said yes in a room; this email's job is to hand them the document,
 * and an invoice-shaped subject turns a partnership into a bill on the way to
 * an inbox it will be forwarded around.
 */
export function buildPortalInvite(args: {
  orgName: string;
  contactName: string | null;
  title: string;
  amountCents: number;
  portalUrl: string;
}): { subject: string; html: string } {
  const greeting = args.contactName
    ? `${escapeHtml(args.contactName)},`
    : `${escapeHtml(args.orgName)},`;
  return {
    subject: `Your partnership agreement — ${args.title}`,
    html: `
      ${emailHeading("Your partnership agreement")}
      ${emailParagraph(greeting)}
      ${emailParagraph(
        "Everything we agreed is on one page — what the partnership carries, what we deliver, and the terms. Read it, sign it there, and pay whenever suits you.",
      )}
      ${emailPanel(`
        ${emailParagraph(`<strong>${escapeHtml(args.title)}</strong>`, { margin: "0 0 6px" })}
        ${emailParagraph(usd(args.amountCents), { margin: "0" })}
      `)}
      ${emailButtonRow(args.portalUrl, "Open the agreement")}
      ${emailParagraph(
        "Nothing is binding until you sign it. If anything on the page doesn't match what we discussed, reply to this email and we'll fix it before you sign.",
        { size: 13 },
      )}
    `,
  };
}

/** The partner's own copy of "you signed it" — their receipt for the act. */
export function buildSignedReceipt(args: {
  orgName: string;
  title: string;
  signedName: string;
  signedAt: number;
  amountCents: number;
  balanceCents: number;
  portalUrl: string | null;
}): { subject: string; html: string } {
  const owed =
    args.balanceCents > 0
      ? emailParagraph(
          `Balance remaining: <strong>${usd(args.balanceCents)}</strong>. You can pay it from the same page, whenever suits you.`,
        )
      : emailParagraph(
          "Nothing is outstanding — the partnership is fully covered. Thank you.",
        );
  return {
    subject: `Signed — ${args.title}`,
    html: `
      ${emailHeading("Agreement signed")}
      ${emailParagraph(
        `Signed by ${escapeHtml(args.signedName)} on ${shortDate(args.signedAt)}. This email is your copy.`,
      )}
      ${emailPanel(`
        ${emailParagraph(`<strong>${escapeHtml(args.title)}</strong>`, { margin: "0 0 6px" })}
        ${emailParagraph(`${escapeHtml(args.orgName)} · ${usd(args.amountCents)}`, { margin: "0" })}
      `)}
      ${owed}
      ${args.portalUrl ? emailButtonRow(args.portalUrl, "Open the agreement") : ""}
    `,
  };
}

/**
 * The desk's own notice — "they signed".
 *
 * The one notice that goes INWARD, so it may name our owner and our figures.
 * It still does not carry the due-diligence note: internal or not, an email is
 * forwardable, and there is a whole app one click away for anything that isn't
 * the headline.
 */
export function buildSignedAlert(args: {
  orgName: string;
  title: string;
  signedName: string;
  signedTitle: string | null;
  signedAt: number;
  amountCents: number;
  balanceCents: number;
  appUrl: string | null;
}): { subject: string; html: string } {
  const who = args.signedTitle
    ? `${escapeHtml(args.signedName)} (${escapeHtml(args.signedTitle)})`
    : escapeHtml(args.signedName);
  return {
    subject: `${args.orgName} signed — ${usd(args.amountCents)}`,
    html: `
      ${emailHeading(`${escapeHtml(args.orgName)} signed`)}
      ${emailParagraph(`${who} signed <strong>${escapeHtml(args.title)}</strong> on ${shortDate(args.signedAt)}.`)}
      ${emailPanel(`
        ${emailParagraph(`Committed: <strong>${usd(args.amountCents)}</strong>`, { margin: "0 0 6px" })}
        ${emailParagraph(`Still owed: ${usd(args.balanceCents)}`, { margin: "0" })}
      `)}
      ${args.appUrl ? emailButtonRow(args.appUrl, "Open the agreement") : ""}
    `,
  };
}

/**
 * The payment receipt.
 *
 * SAYS WHAT WAS CHARGED AND WHAT IT COUNTED FOR, separately, whenever the
 * partner covered the processing fee. A receipt that quoted only the charge
 * would have them reading $3,505 against a $3,500 agreement and wondering which
 * number is wrong; one that quoted only the credit would not match their bank
 * statement. Both, or neither is trustworthy.
 */
export function buildPaymentReceipt(args: {
  orgName: string;
  title: string;
  creditedCents: number;
  chargedCents: number;
  feeCoverageCents: number;
  balanceCents: number;
  receivedAt: number;
  portalUrl: string | null;
}): { subject: string; html: string } {
  const feeLine =
    args.feeCoverageCents > 0
      ? emailParagraph(
          `Charged ${usd(args.chargedCents)}, which included ${usd(args.feeCoverageCents)} you added to cover the processing fee. ${usd(args.creditedCents)} counts toward the partnership.`,
          { size: 13 },
        )
      : "";
  const remaining =
    args.balanceCents > 0
      ? emailParagraph(`Balance remaining: <strong>${usd(args.balanceCents)}</strong>.`)
      : emailParagraph(
          "That closes it — the partnership is fully covered. Thank you for standing behind this work.",
        );
  return {
    subject: `Received — ${usd(args.creditedCents)} toward ${args.title}`,
    html: `
      ${emailHeading("Payment received")}
      ${emailParagraph(
        `Thank you. We received ${usd(args.creditedCents)} on ${shortDate(args.receivedAt)} toward <strong>${escapeHtml(args.title)}</strong>.`,
      )}
      ${feeLine}
      ${remaining}
      ${args.portalUrl ? emailButtonRow(args.portalUrl, "Open the agreement") : ""}
    `,
  };
}
