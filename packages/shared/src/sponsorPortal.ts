/**
 * PARTNER PORTAL — the sponsor's own side of a sponsorship agreement.
 *
 * A `sponsorPackages` tier is a PRICE LIST: "LTN Production Partner, $3,500,
 * these four benefits." A real partnership is never only that. The Ignite deal
 * (2026-08-20) is the case that forced this file into existence: a Production
 * Partner spot at $3,500 whose actual terms are unique to that partner — a
 * hosted Worship with Strangers thrown in on their anniversary weekend, an
 * in-kind production credit that offsets part of the cash, and a promise about
 * how they are introduced from stage. None of that fits in a tier's `benefits`
 * array, because none of it is true of the next partner who buys the same tier.
 *
 * So an agreement carries its OWN proposal — a title, a free-form body, its own
 * benefit/commitment lines, its own terms — that STARTS as the tier's copy and
 * diverges from it the moment a deal is actually negotiated. This module is the
 * vocabulary and the arithmetic both sides of that share: the Convex schema
 * builds validators from these tuples, the server-rendered portal words itself
 * from these labels, and the staff composer previews with the same prose parser
 * the portal renders with. One implementation, so the page the sponsor signs
 * and the page the staffer wrote can never disagree.
 *
 * ── WHY THE RAIL IS A FIELD AND NOT A PREFERENCE ────────────────────────────
 * Founder, 2026-08-20: "for things like this, we should only allow bank ACH as
 * a method of payment because it's just like a big payment, and we don't want
 * more than a five dollar charge on it."
 *
 * That is an instruction about MONEY, not about UI. A $3,500 card payment costs
 * $101.80 in Stripe fees; the same payment by bank debit costs $5.00, because
 * Stripe's ACH rate is 0.8% CAPPED at $5 (see `processorFees.ts`). $96.80 is
 * three percent of a partnership — real money, taken out of a free event in a
 * park. So the allowed rails are stored ON THE AGREEMENT, defaulted to
 * bank-only, and enforced server-side. A portal that merely *defaulted* to ACH
 * while leaving a card button on the page would lose that money to the first
 * partner who found the button convenient.
 *
 * `CARD_RAIL_MAX_CENTS` is the guardrail underneath the default: above it, card
 * is refused even if somebody ticks the box, because the point was never the
 * default — it was the ceiling on what a fee is allowed to cost us.
 */

import { type FeeRate, feeCoverageCents } from "./processorFees";

// ── Rails ────────────────────────────────────────────────────────────────────

/**
 * How a partner may pay through the portal.
 *
 * `"ach"` is Stripe Checkout pinned to `us_bank_account`; `"card"` is Stripe's
 * default set (which also carries the wallets — Apple/Google Pay — that cost
 * the same as a card, so pinning it would only remove options at no saving).
 * The same two strings `personalRepayments.method` uses, deliberately: the fee
 * lookup (`lib/repaymentFees.ts#feeMethodFor`) maps both vocabularies onto
 * `FEE_METHODS` already, and a third spelling of "bank transfer" is how a
 * quoted price and a charged price start to differ.
 */
export const SPONSOR_PAYMENT_RAILS = ["ach", "card"] as const;
export type SponsorPaymentRail = (typeof SPONSOR_PAYMENT_RAILS)[number];

export const SPONSOR_RAIL_LABELS: Record<SponsorPaymentRail, string> = {
  ach: "Bank transfer (ACH)",
  card: "Card",
};

/** The one-line explanation each rail owes the partner before they pick it. */
export const SPONSOR_RAIL_BLURBS: Record<SponsorPaymentRail, string> = {
  ach: "Lowest cost to the mission — the processing fee is capped at $5 no matter the amount. Takes about 4 business days to clear.",
  card: "Instant, but the processor takes about 3% of the whole amount.",
};

/**
 * What every new agreement's portal allows unless a manager says otherwise.
 *
 * ACH ALONE, and that is the founder's instruction rather than a taste: see the
 * module doc's arithmetic. A manager can add card in the composer for a small
 * spot where four days of clearing is the bigger cost — but they have to type
 * it, and above `CARD_RAIL_MAX_CENTS` they cannot.
 */
export const DEFAULT_SPONSOR_RAILS: SponsorPaymentRail[] = ["ach"];

/**
 * The most a CARD payment may settle through the portal ($1,000).
 *
 * Above this the fee stops being a rounding error and starts being a line item
 * somebody should have to justify — $29.30 at $1,000, $101.80 at $3,500 — so
 * the server refuses the rail rather than the manager having to remember. Bank
 * debit has no such ceiling: its fee is capped in absolute dollars, so it is
 * the cheap rail precisely where the money is big.
 */
export const CARD_RAIL_MAX_CENTS = 100_000;

/** Whether `rail` may be offered at all for an agreement of `amountCents`. */
export function railAllowedAtAmount(
  rail: SponsorPaymentRail,
  amountCents: number,
): boolean {
  return rail === "ach" || amountCents <= CARD_RAIL_MAX_CENTS;
}

/** The rails a manager is allowed to tick for an agreement of this size, in
 *  display order. Bank first: it is both the default and the cheap one. */
export function selectableRails(amountCents: number): SponsorPaymentRail[] {
  return SPONSOR_PAYMENT_RAILS.filter((r) => railAllowedAtAmount(r, amountCents));
}

/** Why card isn't on offer, in a sentence a manager can act on. Null when it
 *  is on offer. */
export function cardRailBlockedReason(amountCents: number): string | null {
  if (amountCents <= CARD_RAIL_MAX_CENTS) return null;
  return `Card isn't available above ${money(CARD_RAIL_MAX_CENTS)} — the processor's cut would be about ${money(
    Math.round(amountCents * 0.029) + 30,
  )}. Bank transfer caps the fee at $5.00.`;
}

// ── The agreement's money ────────────────────────────────────────────────────

/**
 * One thing a partner is giving us that ISN'T cash, valued in cents.
 *
 * The Ignite deal's "production proposal" path is exactly this: their team
 * carries backline, AV, engineers, transport and power, we value that against
 * OUR OWN itemized budget lines (never their rate card), and the value counts
 * against the spot like cash. The proposal deck promises "every line of the
 * review is shown to you", so each credit carries its own label and the portal
 * lists them — a single lumped "in-kind: $2,500" would break that promise.
 *
 * NOT A GIFT ROW. In-kind credits reduce what the partner still OWES; they are
 * not money that arrived, and nothing here touches `gifts`. Recording an in-kind
 * gift in the ledger is a separate, deliberate act by a manager
 * (`recordSponsorshipGift` with `method: "in_kind"`), and doing it as a side
 * effect of a credit would double-count the same donated work — once as a
 * balance reduction, once as revenue.
 */
export interface SponsorInKindCredit {
  label: string;
  amountCents: number;
  note?: string;
}

/** At most this many credit lines on one agreement — a reviewed production
 *  proposal is a handful of lines, not a general ledger. */
export const MAX_IN_KIND_CREDITS = 20;

/**
 * How many events one partnership may cover.
 *
 * A partnership is routinely more than one date — the Ignite agreement stands
 * behind Love Thy Neighbor on Sept 26 AND the hosted Worship with Strangers on
 * Sept 18 — so this is a season's worth of events, not the whole calendar.
 *
 * Lives here rather than in `apps/convex/sponsorships.ts` (its original, private
 * home) because BOTH the pipeline's `upsertSponsorship` and the portal's
 * `saveProposal` write this list now, and a bound enforced at one writer and
 * not the other is a bound that isn't one.
 */
export const MAX_SPONSORSHIP_EVENTS = 20;

/** The shape every surface renders an agreement's money from. */
export interface SponsorBalance {
  /** What the partner agreed to carry, in total. */
  committedCents: number;
  /** Reviewed in-kind value counting against it. */
  inKindCents: number;
  /** Cash that has actually landed (settled `gifts` rows). */
  paidCents: number;
  /** in-kind + cash — everything covered by anything. */
  coveredCents: number;
  /** What is still owed. Never negative: an overpayment is a generous partner,
   *  not a debt we owe them, and a negative "balance due" on a portal page
   *  reads as an invoice for money going the other way. */
  balanceCents: number;
  /** 0–100, rounded. 100 the moment nothing is owed. */
  percentCovered: number;
  /** Nothing left to pay. */
  settled: boolean;
}

/**
 * The one place an agreement's balance is computed.
 *
 * Every input is clamped at 0 rather than trusted: these numbers arrive from a
 * summed gift query and a hand-entered credit list, and a single bad row must
 * degrade a figure, never invert the page's meaning ("you are owed $500").
 */
export function sponsorBalance(input: {
  committedCents: number;
  inKindCents?: number;
  paidCents?: number;
}): SponsorBalance {
  const committedCents = Math.max(0, Math.round(input.committedCents || 0));
  const inKindCents = Math.max(0, Math.round(input.inKindCents || 0));
  const paidCents = Math.max(0, Math.round(input.paidCents || 0));
  const coveredCents = inKindCents + paidCents;
  const balanceCents = Math.max(0, committedCents - coveredCents);
  const percentCovered =
    committedCents <= 0
      ? 100
      : Math.min(100, Math.round((coveredCents / committedCents) * 100));
  return {
    committedCents,
    inKindCents,
    paidCents,
    coveredCents,
    balanceCents,
    percentCovered,
    settled: balanceCents === 0,
  };
}

/** Sum a credit list, ignoring malformed rows rather than NaN-ing the page. */
export function inKindTotalCents(credits: SponsorInKindCredit[] | undefined) {
  return (credits ?? []).reduce(
    (sum, c) => sum + (Number.isFinite(c.amountCents) ? Math.max(0, Math.round(c.amountCents)) : 0),
    0,
  );
}

/**
 * What covering the processor's fee adds to a portal payment, and the charge
 * that results.
 *
 * Deliberately the same GROSS-UP the repayment rails use (`feeCoverageCents`)
 * rather than a naive percentage on top: the rail charges its cut on whatever
 * it settles, INCLUDING the part covering its own cut, so `intended + fee` nets
 * less than `intended`. On the capped ACH rail the two happen to agree once the
 * cap binds, which is most sponsorship-sized payments — but the agreement only
 * holds at these amounts, and hard-coding it would break the first $400
 * Community spot that pays through the same page.
 */
export function sponsorFeeQuote(
  intendedCents: number,
  rate: FeeRate | null,
): { feeCents: number; chargeCents: number } {
  if (!rate || intendedCents <= 0) {
    return { feeCents: 0, chargeCents: Math.max(0, intendedCents) };
  }
  const feeCents = feeCoverageCents(intendedCents, rate);
  return { feeCents, chargeCents: intendedCents + feeCents };
}

// ── Field bounds ─────────────────────────────────────────────────────────────
// Everything a manager types lands on a page a partner reads, so each cap is
// "longer than any real one, shorter than a denial-of-service". They are shared
// so the composer's counter and the server's rejection agree on the number.

export const SPONSOR_TITLE_MAX = 140;
export const SPONSOR_SUMMARY_MAX = 6_000;
export const SPONSOR_TERMS_MAX = 12_000;
export const SPONSOR_LINE_MAX = 300;
export const SPONSOR_CONTACT_NAME_MAX = 160;
export const SPONSOR_CREDIT_LABEL_MAX = 160;
export const SPONSOR_SIGNATURE_MAX = 160;
/** A partnership is a big number, but not an unbounded one — this is the same
 *  order of magnitude `CONTRACTOR_PAYMENT_MAX_CENTS` uses, and it exists so a
 *  mistyped amount is caught at the composer rather than on a portal page. */
export const SPONSOR_AMOUNT_MAX_CENTS = 50_000_000; // $500,000

/**
 * Is this typed name a signature we would be willing to show a judge?
 *
 * The same bar `contractorPayments` sets, and for the same reason: a signature
 * is evidence or it is decoration. Two characters and a space is the floor —
 * initials with a period pass, an empty box and a single keystroke do not.
 */
export function sponsorSignatureProblems(signature: string): string[] {
  const trimmed = signature.trim();
  if (trimmed.length < 2) {
    return ["Type your full name to sign."];
  }
  if (trimmed.length > SPONSOR_SIGNATURE_MAX) {
    return [`Keep the signature under ${SPONSOR_SIGNATURE_MAX} characters.`];
  }
  return [];
}

/** Problems with an agreed amount, in sentences a manager can act on. */
export function sponsorAmountProblems(amountCents: number): string[] {
  if (!Number.isInteger(amountCents)) {
    return ["Enter a whole-cent amount."];
  }
  if (amountCents <= 0) return ["Enter an amount greater than zero."];
  if (amountCents > SPONSOR_AMOUNT_MAX_CENTS) {
    return [`That's above the ${money(SPONSOR_AMOUNT_MAX_CENTS)} ceiling — check the figure.`];
  }
  return [];
}

// ── The free-form body ───────────────────────────────────────────────────────

/**
 * A block of the agreement's prose. The founder asked for "a free form type of
 * thing" — somewhere to paste the shape of a deal that no form anticipated —
 * and the honest answer to that is a text box. But a text box rendered straight
 * into HTML is either unsafe or unreadable, so this is the smallest grammar
 * that keeps a pasted proposal looking like a proposal:
 *
 *   `## Heading`   → a heading
 *   `- item`       → a bullet (consecutive lines group into one list)
 *   blank line     → a paragraph break
 *   anything else  → a paragraph
 *
 * NO INLINE MARKUP, deliberately. No links, no images, no raw HTML, no bold
 * syntax — the parser emits plain strings that every renderer escapes, so the
 * worst a pasted-in `<script>` can do is appear on the page as the characters
 * somebody typed. A partnership agreement gains nothing from italics and loses
 * a great deal from an injection surface.
 */
export type SponsorProseBlock =
  | { kind: "heading"; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "bullets"; items: string[] };

/** Parse an agreement's free-form body into blocks. Total input is bounded by
 *  the caller's cap; this is linear and allocation-light either way. */
export function parseSponsorProse(input: string | null | undefined): SponsorProseBlock[] {
  const source = (input ?? "").replace(/\r\n?/g, "\n");
  const blocks: SponsorProseBlock[] = [];
  let paragraph: string[] = [];
  let bullets: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length) {
      blocks.push({ kind: "paragraph", text: paragraph.join(" ").trim() });
      paragraph = [];
    }
  };
  const flushBullets = () => {
    if (bullets.length) {
      blocks.push({ kind: "bullets", items: bullets });
      bullets = [];
    }
  };

  for (const rawLine of source.split("\n")) {
    const line = rawLine.trim();
    if (!line) {
      flushBullets();
      flushParagraph();
      continue;
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      flushBullets();
      flushParagraph();
      const text = heading[1].trim();
      if (text) blocks.push({ kind: "heading", text });
      continue;
    }
    // "- ", "* " and "• " all mean the same thing to somebody pasting from a
    // deck, an email, or a Google Doc. Accepting all three costs one character
    // class and saves the manager from learning our syntax.
    const bullet = /^[-*•]\s+(.*)$/.exec(line);
    if (bullet) {
      flushParagraph();
      const text = bullet[1].trim();
      if (text) bullets.push(text);
      continue;
    }
    flushBullets();
    paragraph.push(line);
  }
  flushBullets();
  flushParagraph();
  return blocks;
}

// ── Portal status vocabulary ─────────────────────────────────────────────────

/**
 * What the portal itself is doing — derived, never stored.
 *
 * DERIVED ON PURPOSE. Every input (is there a live token? is the signature
 * against the current terms? is anything still owed?) is already a field with
 * its own writer, and a stored copy would be a fifth thing to keep in step with
 * the four that decide it. The bug that costs money here is a portal that says
 * "signed" against terms nobody signed, and the only way to be sure of that is
 * to recompute it every read.
 */
export const SPONSOR_PORTAL_STATES = [
  /** No live link — nothing has been sent, or it was revoked. */
  "unissued",
  /** Link is live, the partner hasn't signed the current terms yet. */
  "awaiting_signature",
  /** Signed, money still owed. */
  "awaiting_payment",
  /** Signed, a bank debit is authorised and still clearing. */
  "payment_clearing",
  /** Signed and fully covered by cash and/or reviewed in-kind value. */
  "settled",
] as const;
export type SponsorPortalState = (typeof SPONSOR_PORTAL_STATES)[number];

export const SPONSOR_PORTAL_STATE_LABELS: Record<SponsorPortalState, string> = {
  unissued: "No live link",
  awaiting_signature: "Awaiting signature",
  awaiting_payment: "Awaiting payment",
  payment_clearing: "Bank transfer clearing",
  settled: "Complete",
};

/**
 * Resolve the portal's state from the four facts that decide it.
 *
 * `signedTermsVersion` vs `termsVersion` is the load-bearing comparison, and it
 * is why the version pair exists at all: editing what a partner agreed to has
 * to walk the agreement back to unsigned, or we are holding a signature against
 * terms nobody read (exactly `contractorPayments.updateTerms`'s rule).
 */
export function sponsorPortalState(input: {
  hasLiveLink: boolean;
  termsVersion: number;
  signedTermsVersion?: number | null;
  balanceCents: number;
  pendingCents?: number;
}): SponsorPortalState {
  if (!input.hasLiveLink) return "unissued";
  if (
    input.signedTermsVersion == null ||
    input.signedTermsVersion !== input.termsVersion
  ) {
    return "awaiting_signature";
  }
  if (input.balanceCents <= 0) return "settled";
  if ((input.pendingCents ?? 0) > 0) return "payment_clearing";
  return "awaiting_payment";
}

// ── Small shared formatter ───────────────────────────────────────────────────

/** `$3,500.00`. Local to this module rather than imported so the portal's HTML
 *  renderer (which runs inside Convex, with no app helpers) can use it. */
function money(cents: number): string {
  return `$${((cents || 0) / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export { money as sponsorMoney };
