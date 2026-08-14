/**
 * The "your reimbursement was paid" notice to the CLAIMANT — subject + HTML,
 * composed here so the LIVE path (`reimbursements.sendReimbursementPaidEmail`,
 * scheduled off `settleReimbursementPaid`) and the one-shot catch-up sweep
 * (`reimbursementPaidNoticeBackfill`) can never drift into telling the same
 * person two different stories about the same money.
 *
 * The approval notice's twin — `lib/reimbursementApprovedEmail.ts` — and
 * deliberately built the same way: pure (no ctx, no db, no network), a `live` /
 * `catch_up` split, and every figure passed in off the row. Founder,
 * 2026-08-14: "let's also send emails when we actually pay people — this is
 * really important to them. Email when approved and email when paid."
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT THIS EMAIL IS ALLOWED TO CLAIM — the mirror image of the approval
 * notice's rule. There, the trap was promising money that hadn't moved. Here it
 * is the reverse: this notice must not hedge about money that HAS moved. The
 * row is `paid` with a `paidAt`, so the copy says paid, past tense, with the
 * date. It does NOT say "on its way", "should arrive soon" or anything else
 * that reads as still-pending.
 *
 * What it must still be honest about is that "paid" is our word for SENT, not
 * for "landed in your account":
 *  - ACH (`provider:"increase"`). `payoutTargetFor` maps Increase's
 *    `submitted` to our `paid` — for an outbound ACH credit that IS the
 *    terminal success, there is no later "settled" event — so the money is
 *    irrevocably out of the chapter's account, but the receiving bank still
 *    takes a business day or two to post it. The copy says sent on this date,
 *    to this account, and gives that landing window.
 *  - MANUAL (`provider:"manual"`, or no payout row at all). A treasurer moved
 *    the money outside the app and recorded it here. We genuinely do not know
 *    the rail — check, Zelle, cash, a transfer from another account — so the
 *    copy says the treasurer recorded the payment and names the date, and it
 *    does NOT invent an arrival window it can't stand behind.
 *
 * And it always carries the escape hatch, because a "paid" record and money in
 * a claimant's account are not the same fact: if it never shows up, tell your
 * treasurer.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * THE AMOUNT, AND WHY THERE IS NO SUCH THING AS A PARTIAL PAYMENT HERE. This is
 * the figure most likely to be wrong, so it is worth being exact about the
 * model:
 *  - A reimbursement is paid in ONE lump. `payouts` is keyed "at most one live
 *    payout per reimbursement"; `markPaidManually` / `beginPayout` size it at
 *    `approvedCents ?? totalCents`; and `postReimbursementSpend` posts at most
 *    one ledger row per reimbursement (`by_reimbursement`, no status filter).
 *    There is no schema, no mutation and no UI for paying half a claim.
 *  - PARTIAL APPROVAL, however, is first-class — `approve` can approve a subset
 *    of lines, so `approvedCents` can be less than `totalCents`. That is a
 *    smaller payment, not a first instalment, and the copy has to say so or a
 *    claimant will read "$120 paid" against their $200 receipt as a short
 *    payment with more to come. So whenever the paid figure is under the
 *    submitted total, this notice names both and says plainly that the rest is
 *    not coming.
 *  - `paidCents` is therefore read off the PAYOUT that settled it — the money
 *    that actually moved — not off the request's own totals. The caller falls
 *    back to `approvedCents ?? totalCents` only for a legacy row with no payout
 *    document.
 *
 * SO CAN ONE REIMBURSEMENT SEND TWO PAID NOTICES? Yes, in exactly one
 * situation, and it should. An ACH credit can be `returned` days after Increase
 * reported `submitted`; `reverseSettledPayout` then walks the row back to
 * `approved`, deletes the ledger row, and clears `paidNoticeSentAt`. A manager
 * retries, the retry settles, and the claimant gets a second notice — because
 * the first payment was undone and this one is a different, real payment on a
 * later date. The alternative (keep the stamp) leaves somebody whose money
 * bounced holding an email that says they were paid, and silence about the
 * payment that actually reached them. Every other path is single-notice: the
 * claim in `markPaidNoticeSent` sees a stamp and refuses.
 */
import { escapeHtml } from "./html";
import {
  emailButtonRow,
  emailHeading,
  emailParagraph,
  emailShell,
} from "./emailShell";
import { formatCents, formatNoticeDate } from "./reimbursementApprovedEmail";

/**
 * Which of the two notices to write — the same split
 * `lib/reimbursementApprovedEmail.ts` documents.
 *  - `live`: sent seconds after the payout settles.
 *  - `catch_up`: the one-shot sweep for everything paid BEFORE this email
 *    existed. It opens by owning the miss, in the founder's own register from
 *    the approval catch-up, and never pretends to be timely.
 */
export type PaidNoticeKind = "live" | "catch_up";

/** How the money left, when the settling `payouts` row tells us. `null` for a
 *  legacy paid row that has no payout document to read. */
export type PaidMethod = "ach" | "manual";

/** Everything the notice needs. Every field is read off the request row and the
 *  payout that settled it (plus the CTA link the caller resolves), so there is
 *  nothing here a caller has to invent. */
export interface PaidNoticeInput {
  kind: PaidNoticeKind;
  /** The claimant's display name from the request. */
  payeeName: string;
  /** `RB-XXXXXX`, the same reference every other reimbursement screen shows. */
  reference: string;
  /** What actually moved (integer cents) — the settling payout's amount. */
  paidCents: number;
  /** What the claimant submitted (integer cents) — quoted only when it differs
   *  from `paidCents`, i.e. when a reviewer approved only some of the lines. */
  totalCents: number;
  /** When the payout settled (ms). The whole point of this notice. */
  paidAt: number;
  /** How it was sent, when the payout row says. `null` = unknown (legacy row). */
  method: PaidMethod | null;
  /** Display-only last 4 of the destination account, when we have it. */
  bankAccountLast4: string | null;
  /** Where to send them to see it — `reimbursements.claimantStatusLink`.
   *  `null` when no URL can be built; the CTA degrades to a sentence. */
  link: string | null;
}

/** The composed notice. */
export interface PaidNotice {
  subject: string;
  html: string;
}

export function buildPaidNotice(input: PaidNoticeInput): PaidNotice {
  const paid = formatCents(input.paidCents);
  const when = formatNoticeDate(input.paidAt);
  // Under the submitted total = a reviewer approved only some of the lines.
  // See this file's header: that is a smaller payment, NOT a first instalment,
  // and saying so is the whole job of this sentence.
  const partial = input.paidCents < input.totalCents;
  const destination = input.bankAccountLast4
    ? ` the bank account ending in ${escapeHtml(input.bankAccountLast4)}`
    : " the bank account on your request";

  const amountLine = partial
    ? `${escapeHtml(paid)} was paid — that's the amount a reviewer approved, out of the ${escapeHtml(formatCents(input.totalCents))} you submitted. The rest wasn't approved and isn't coming separately; your treasurer can tell you which lines and why.`
    : `${escapeHtml(paid)} was paid — the full amount that was approved.`;

  const opening =
    input.kind === "live"
      ? `Hi ${escapeHtml(input.payeeName)} — your reimbursement has been paid. ${amountLine}`
      : `Hi ${escapeHtml(input.payeeName)} — we owe you this notice. Your reimbursement was paid on ${escapeHtml(when)}, and we weren't sending payment emails back then, so you never heard it from us. Sorry about that. ${amountLine}`;

  // HOW and WHEN it left, and what "paid" does and doesn't guarantee about the
  // money being visible to them yet. See this file's header.
  let howItWent: string;
  if (input.method === "ach") {
    howItWent =
      input.kind === "live"
        ? `It went out by bank transfer on ${escapeHtml(when)}, to${destination}. The money has left Public Worship's account; most banks post a transfer like this within a business day or two, so give it a moment before you go looking.`
        : `It went out by bank transfer on ${escapeHtml(when)}, to${destination}.`;
  } else if (input.method === "manual") {
    howItWent =
      input.kind === "live"
        ? `Your treasurer sent this one themselves, outside the app, and recorded it here on ${escapeHtml(when)} — so how quickly it reaches you depends on how they sent it. If you're not sure what to expect, ask them.`
        : `Your treasurer sent this one themselves, outside the app, and recorded it here on ${escapeHtml(when)}.`;
  } else {
    // A legacy row with no payout document — we know the date and nothing else,
    // so we say only that.
    howItWent = `It was marked paid on ${escapeHtml(when)}.`;
  }

  // The escape hatch. "Paid" is a record of a payment being sent, which is not
  // the same fact as money in somebody's account — and on the catch-up notice
  // this line is the entire point of writing at all.
  const closing =
    input.kind === "live"
      ? "If it doesn't turn up, contact your treasurer — they can see exactly what was sent and chase it. Asking is welcome."
      : "If that money never actually reached you, contact your treasurer — that's a gap worth chasing, however long ago it was, and they can see exactly what was sent.";

  const subject =
    input.kind === "live"
      ? `Paid: your reimbursement ${input.reference} (${paid})`
      : `Your reimbursement ${input.reference} was paid — a notice we owe you`;

  const html = emailShell(`
        ${emailHeading(`Reimbursement ${escapeHtml(input.reference)}`)}
        ${emailParagraph(opening)}
        ${emailParagraph(howItWent)}
        ${emailParagraph(closing, { size: 12, margin: "0 0 20px" })}
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
