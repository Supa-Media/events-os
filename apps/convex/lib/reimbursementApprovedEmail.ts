/**
 * The "your reimbursement was approved" notice to the CLAIMANT — subject + HTML,
 * composed here so the LIVE path (`reimbursements.sendReimbursementApprovedEmail`,
 * scheduled off `approve`) and the one-shot catch-up sweep
 * (`reimbursementApprovedNoticeBackfill`) can never drift into telling the same
 * person two different stories about the same money.
 *
 * Pure: no ctx, no db, no network. Everything it needs is passed in, so it's
 * directly unit-testable and both callers stay thin.
 *
 * WHAT THIS EMAIL IS ALLOWED TO CLAIM. Approved and paid are DIFFERENT states
 * (`REIMBURSEMENT_STATUSES`: … approved → paying → paid), and at approval time
 * no money has moved: `approve` patches the request and records the decision,
 * and the payout is a separate act — the manager queue follows a successful
 * approve with `increasePayouts.payReimbursement` when the chapter's
 * `approvalPolicy.autoPayOnApproval` is on AND the chapter has an Increase
 * account, and otherwise a treasurer sends it by hand
 * (`increasePayouts.markPaidManually`). So the copy says "approved", names the
 * amount, and describes the payout as the NEXT step — it never says the money
 * is on its way today, and it never promises a date. The one thing it does
 * promise is the escape hatch: if nothing lands, talk to your treasurer.
 *
 * PARTIAL APPROVAL is first-class here: `approve` supports approving a SUBSET
 * of lines, so `approvedCents` can be less than `totalCents`. An email that
 * quoted the submitted total would be telling a claimant they're owed money a
 * reviewer explicitly declined, so the copy names both figures whenever they
 * differ and points at the treasurer for the "why" (the reviewer's reasoning
 * lives in `approvals`/`financeAuditLog`, not on the row).
 */
import { escapeHtml } from "./html";
import {
  emailButtonRow,
  emailHeading,
  emailParagraph,
  emailShell,
} from "./emailShell";

/**
 * Which of the two notices to write.
 *  - `live`: sent seconds after the decision. Present tense, "here's what
 *    happens next".
 *  - `catch_up`: the one-shot sweep for everything approved BEFORE this email
 *    existed. Past tense, and it opens by owning the miss — the founder's own
 *    framing ("we forgot to send the email, but this was approved, you should
 *    have seen it by this date"). Honest, not defensive, and it never pretends
 *    the notice is timely.
 */
export type ApprovedNoticeKind = "live" | "catch_up";

/** Everything the notice needs. Every field is read off the request row (plus
 *  the CTA link the caller resolves), so there is nothing here a caller has to
 *  invent. */
export interface ApprovedNoticeInput {
  kind: ApprovedNoticeKind;
  /** The claimant's display name from the request. */
  payeeName: string;
  /** `RB-XXXXXX`, the same reference every other reimbursement screen shows. */
  reference: string;
  /** What the reviewer actually approved (integer cents). */
  approvedCents: number;
  /** What the claimant submitted (integer cents) — quoted only when it differs. */
  totalCents: number;
  /** When it was approved (ms). The whole point of the catch-up notice. */
  approvedAt: number;
  /** The request's status RIGHT NOW — a catch-up notice for a request that has
   *  since been PAID must not say "your money is coming". */
  status: string;
  /** When the payout settled (ms), when it has. */
  paidAt: number | null;
  /** Display-only last 4 of the destination account, when the row carries it. */
  bankAccountLast4: string | null;
  /** Where to send them to see it — their Reimbursements tab (in-app member) or
   *  their token status page (accountless claimant). `null` when neither URL
   *  can be built, in which case the CTA degrades to a sentence. */
  link: string | null;
}

/** Integer cents as `$1,234.56`. */
export function formatCents(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** A ms timestamp as a long human date, in the team's timezone — the same
 *  formatting `reimbursements.ts`'s other email copy uses. */
export function formatNoticeDate(ts: number): string {
  return new Date(ts).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "America/New_York",
  });
}

/** The composed notice. */
export interface ApprovedNotice {
  subject: string;
  html: string;
}

export function buildApprovedNotice(input: ApprovedNoticeInput): ApprovedNotice {
  const approved = formatCents(input.approvedCents);
  const partial = input.approvedCents < input.totalCents;
  const settled = input.status === "paid" && input.paidAt !== null;
  const destination = input.bankAccountLast4
    ? ` the bank account ending in ${escapeHtml(input.bankAccountLast4)}`
    : " the bank account on your request";

  // What was approved, and — when a reviewer approved only some of the lines —
  // what wasn't. Never quote the submitted total as if it were the payout.
  const amountLine = partial
    ? `${escapeHtml(approved)} of the ${escapeHtml(formatCents(input.totalCents))} you submitted was approved. A reviewer didn't approve the rest — your treasurer can tell you which lines and why.`
    : `${escapeHtml(approved)} was approved — the full amount you submitted.`;

  const opening =
    input.kind === "live"
      ? `Hi ${escapeHtml(input.payeeName)} — your reimbursement has been approved. ${amountLine}`
      : `Hi ${escapeHtml(input.payeeName)} — we owe you this notice. Your reimbursement was approved on ${escapeHtml(formatNoticeDate(input.approvedAt))}, and we weren't sending approval emails back then, so you never heard it from us. Sorry about that. ${amountLine}`;

  // "What happens next", and it has to be TRUE for the state the row is in
  // right now. See this file's header: approved is not paid.
  let next: string;
  if (settled) {
    next = `It was paid on ${escapeHtml(formatNoticeDate(input.paidAt!))}, to${destination}. If you never saw that money arrive, contact your treasurer — that's a gap worth chasing, however long ago it was.`;
  } else if (input.status === "paying") {
    next = `The payout is already on its way to${destination}. Bank transfers take a few business days to land.`;
  } else if (input.kind === "catch_up") {
    next = `It hasn't been marked paid yet. If the money reached you anyway, nothing is wrong — the record just needs catching up, and your treasurer can do that. If it never arrived, contact your treasurer and they'll chase it.`;
  } else {
    next = `Approved isn't paid yet — sending the money is the next step, and it goes to${destination}. Bank transfers take a few business days to land once they're sent, and this reimbursement moves to <b>Paid</b> when the money settles.`;
  }

  const closing =
    settled || input.kind === "catch_up"
      ? null
      : "If nothing has landed within a week or so, contact your treasurer — that's the right person to ask, and asking is welcome.";

  const subject =
    input.kind === "live"
      ? `Approved: your reimbursement ${input.reference} (${approved})`
      : `Your reimbursement ${input.reference} was approved — a notice we owe you`;

  const html = emailShell(`
        ${emailHeading(`Reimbursement ${escapeHtml(input.reference)}`)}
        ${emailParagraph(opening)}
        ${emailParagraph(next)}
        ${closing ? emailParagraph(closing, { size: 12, margin: "0 0 20px" }) : ""}
        ${
          input.link
            ? emailButtonRow(input.link, "View your reimbursement →")
            : emailParagraph(
                "Open your reimbursement to see its current status.",
                { size: 12, margin: "0" },
              )
        }`);

  return { subject, html };
}
