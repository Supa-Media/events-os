/**
 * The "you paid this off" PAYMENT RECEIPT email to the PAYER of a
 * personal-charge repayment — subject + HTML, composed here so the ONE seam
 * that actually settles a payment (`cards.ts#applyRepaymentPaidFromStripe`
 * for BOTH Stripe Checkout rails — card and bank debit — and
 * `cards.ts#applyRepaymentPaid` for the Increase ACH direct-debit rail) can
 * never drift into two different stories about the same payment.
 *
 * Pure: no ctx, no db, no network. Everything it needs is passed in, so it's
 * directly unit-testable and both settlement paths stay thin.
 *
 * Founder, 2026-08-14: "When people pay what they owe, we need to make sure
 * we send them an email saying, like, hey, thanks for paying this off. This
 * is your receipt, and then just send them the stripe receipt, and then the
 * line item, just so that they have that for their records of like, hey, I
 * paid this back, just in case they need a receipt for showing that they did
 * the payment."
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT THIS EMAIL IS ALLOWED TO CLAIM, and what it is not.
 *
 *  - It is EVIDENCE OF A PAYMENT, nothing more: what was paid, when it
 *    settled, and which charge(s) it cleared. A payer forwarding this to
 *    their own records — or to anyone asking "did you pay that back?" —
 *    should be able to read the whole story off this one email, with nothing
 *    else to look up.
 *  - This is a REPAYMENT of a personal charge, not a gift and not a purchase.
 *    It must NEVER use donation language ("thank you for your generosity"
 *    and its relatives), and it must NEVER say or imply the payment is
 *    TAX-DEDUCTIBLE. The surrounding flow
 *    (`cards.ts#notifyPersonalChargeFlagged`) already invokes IRS
 *    accountable-plan reasoning to explain WHY the debt existed in the first
 *    place; this email's only job is to confirm it is now settled, not to
 *    re-litigate or extend that reasoning. Getting this wrong has real tax
 *    consequences for the payer, not just a copy-editing problem.
 *  - When the payer covered Stripe's processing fee on top of their debt
 *    (checkout metadata's `repaymentFeeCents`, threaded through as
 *    `feeCoveredCents`), that fee is named SEPARATELY from the itemized
 *    charges below it — never silently folded into "you paid $X" when part
 *    of $X was never money the payer owed.
 *  - It ALWAYS renders a complete receipt on its own — total, date, method,
 *    and one line per charge — whether or not a Stripe charge exists behind
 *    the payment. The Increase ACH direct-debit rail has no Stripe charge at
 *    all, and the live Stripe expand call can fail even on the two rails
 *    that do have one; either way this is never a dangling "receipt
 *    unavailable" or an empty button — see `stripeReceiptUrl`'s doc below,
 *    the field that makes the Stripe button purely additive.
 * ────────────────────────────────────────────────────────────────────────────
 */
import { escapeHtml } from "./html";
import {
  emailButtonRow,
  emailHeading,
  emailList,
  emailParagraph,
  emailShell,
} from "./emailShell";
import { formatCents, formatNoticeDate } from "./reimbursementApprovedEmail";

/** How this payment was made — the same vocabulary the repayments page uses.
 *  Uniform across every line in one receipt: a bundled Checkout is one rail
 *  for every charge it settles in that payment. */
export type RepaymentReceiptMethod = "card" | "ach";

/** One charge this payment cleared. */
export interface RepaymentReceiptLine {
  /** What the original charge was for, as the payer would recognize it.
   *  `null` falls back to `description`, then to a generic phrase — most
   *  charges carry a merchant name, but a legacy or manually-entered one may
   *  not. */
  merchantName: string | null;
  description: string | null;
  /** When the ORIGINAL personal charge posted (ms) — not when it was repaid.
   *  `null` for a legacy charge with no posted date on file. */
  chargeDate: number | null;
  amountCents: number;
}

/** Everything the receipt needs. Every figure is read off the settled
 *  repayment row(s) + the underlying charge transaction(s), so there is
 *  nothing here a caller has to invent. */
export interface RepaymentReceiptInput {
  /** The payer's display name. */
  payerName: string;
  /** When THIS payment settled (ms) — the whole point of the receipt. */
  paidAt: number;
  /** One line per repayment this payment cleared. Length 1 for the Increase
   *  rail (it always settles one repayment at a time); length ≥1 for a
   *  bundled Stripe Checkout that paid off several charges in one payment. */
  lines: RepaymentReceiptLine[];
  /** Sum of `lines[].amountCents` — what was actually owed and paid off.
   *  Passed rather than summed here so a caller's rounding can never
   *  silently disagree with what the copy tells the payer. */
  totalCents: number;
  method: RepaymentReceiptMethod;
  /** The Stripe processing fee the PAYER opted to cover on top of their
   *  debt. `null` (or ≤ 0) when nobody covered a fee — the common case, and
   *  always true on the Increase rail, which carries no such option. Named
   *  separately in the copy; see this file's header for why. */
  feeCoveredCents: number | null;
  /** Stripe's own hosted receipt for the charge behind this payment — an
   *  absolute `https://` URL, fetched LIVE at send time (the Checkout
   *  Session / PaymentIntent's `latest_charge.receipt_url`, which Stripe
   *  never includes unexpanded). `null` in every case that isn't "a live
   *  Stripe charge with a receipt URL Stripe actually returned": the
   *  Increase rail (no Stripe charge exists at all), a Stripe fetch that
   *  failed, or a charge Stripe hasn't attached a receipt to yet. The email
   *  is a COMPLETE receipt either way — this only adds a second,
   *  Stripe-hosted copy when one is genuinely available, never a
   *  precondition for the email making sense. */
  stripeReceiptUrl: string | null;
  /** Deep link to the payer's repayments page. `null` when `APP_URL` isn't
   *  configured — the CTA degrades to a sentence rather than a dead button
   *  (see `lib/siteUrl.ts#appUrl` and its call-site convention). */
  link: string | null;
}

export interface RepaymentReceipt {
  subject: string;
  html: string;
}

function formatLine(line: RepaymentReceiptLine): string {
  const what = escapeHtml(
    line.merchantName ?? line.description ?? "a charge on your card",
  );
  const when = line.chargeDate
    ? `, ${escapeHtml(formatNoticeDate(line.chargeDate))}`
    : "";
  return `${what}${when} — <b>${escapeHtml(formatCents(line.amountCents))}</b>`;
}

export function buildRepaymentReceipt(
  input: RepaymentReceiptInput,
): RepaymentReceipt {
  const total = formatCents(input.totalCents);
  const when = formatNoticeDate(input.paidAt);
  const methodLabel = input.method === "card" ? "card" : "bank transfer";
  const plural = input.lines.length > 1;

  const subject = `Receipt: you paid back ${total}`;

  const opening = `Hi ${escapeHtml(input.payerName)} — thanks for paying this off. This is your receipt: you paid <b>${escapeHtml(total)}</b> by ${methodLabel} on ${escapeHtml(when)}, for the charge${plural ? "s" : ""} below. Keep this for your records — it's proof the payment went through.`;

  const itemized = emailList(input.lines.map(formatLine));

  // See this file's header: never folded into the total above.
  const feeNote =
    input.feeCoveredCents && input.feeCoveredCents > 0
      ? emailParagraph(
          `You also covered <b>${escapeHtml(formatCents(input.feeCoveredCents))}</b> in card-processing fees so the full ${escapeHtml(total)} reached Public Worship — that fee wasn't part of what you owed, and it isn't one of the charges itemized above.`,
          { size: 12, margin: "0 0 20px" },
        )
      : "";

  // Purely additive — see `stripeReceiptUrl`'s doc. `null` covers the
  // Increase rail AND a failed/empty Stripe fetch identically; the email
  // above is already a complete receipt without it.
  const stripeRow = input.stripeReceiptUrl
    ? emailButtonRow(input.stripeReceiptUrl, "View your Stripe receipt →")
    : "";

  // KNOWN REPO TRAP (see `cards.ts#notifyPersonalChargeFlagged`): a
  // `link ? <a> : ""` pattern would silently ship a CTA-less email whenever
  // APP_URL is unset. Always render SOME actionable text instead.
  const ctaHtml = input.link
    ? emailButtonRow(input.link, "View your repayments →")
    : emailParagraph(
        "Open Finances → Reimbursements in the app to see your repayment history.",
        { size: 12, margin: "0" },
      );

  const html = emailShell(`
        ${emailHeading("Payment received")}
        ${emailParagraph(opening)}
        ${itemized}
        ${feeNote}
        ${stripeRow}
        ${ctaHtml}`);

  return { subject, html };
}
