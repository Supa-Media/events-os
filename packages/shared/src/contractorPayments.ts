import { MIN_PURPOSE_LENGTH } from "./finance";

/**
 * Contractor payments — paying someone who is NOT reimbursable.
 *
 * A reimbursement pays back money a member already spent out of pocket; the
 * receipt is the substantiation and the money is not income. A contractor
 * payment is the opposite on both counts: nothing has been spent yet, there is
 * no receipt to file (the AGREEMENT is the substantiation), and the money IS
 * reportable income to the person receiving it. That is why this is its own
 * vocabulary rather than a `kind` on `REIMBURSEMENT_STATUSES` — see
 * `specs/contractor-payments-pm-spec.md` §2 for the full argument.
 *
 * Shared by both apps: the Convex schema builds its validators from these
 * tuples, the mobile screens render from the label maps, and the public
 * contractor page words its own status from the same strings. One tuple, so a
 * status can never mean one thing to the server and another on a screen.
 */

// ── The lifecycle ────────────────────────────────────────────────────────────
/**
 * Every state a contractor payment can be in, in lifecycle order.
 *
 * TWO ENTRY POINTS, ONE MACHINE (founder, 2026-08-14: a pre-filled agreement
 * you send out, and a blank request that asks to be approved). They are the
 * same record in different starting states rather than two systems:
 *
 *   staff pre-fills  → `draft` → `sent` → `submitted` → …
 *   blank request    →                    `submitted` → …
 *
 * `draft`/`sent` exist ONLY on the pre-filled path — a self-serve request is
 * born `submitted` because the person asking has already said everything they
 * have to say. From `submitted` on, the two are indistinguishable and take the
 * identical approval → payout route, which is the point: a treasurer reviews
 * one queue, not two.
 *
 * Terminal: `paid`, `rejected`, `canceled`. `failed` is terminal for the
 * PAYOUT but not the payment — a manager retries it, exactly as reimbursements
 * walk `paying → approved` back on a bounce (`lib/increasePayoutMachine.ts`).
 */
export const CONTRACTOR_PAYMENT_STATUSES = [
  // Staff is still filling in the terms. No link has been handed out, so the
  // contractor cannot see it and nothing has been promised to anyone.
  "draft",
  // The link exists and has been given to the contractor. The terms are FROZEN
  // to them (read-only on the public page, and the server ignores those keys on
  // submit) — they supply identity, tax document, and bank details only.
  "sent",
  // The contractor has completed their half, or a self-serve request has been
  // filed. This is the state that lands in the treasurer's queue.
  "submitted",
  // Sent BACK for revision rather than killed — "your W-9 is the wrong year",
  // "this needs to say which event it served". Distinct from `rejected`, which
  // is final, for the same reason reimbursements draw that line: most review
  // outcomes are "almost — fix this one thing", and a flow whose only send-back
  // is a rejection teaches people that review means losing their money.
  "changes_requested",
  "approved",
  "paying",
  "paid",
  "rejected",
  // The ACH bounced or Increase refused it. The payment walks back to
  // `approved` so a manager can retry; this state is what the payout wears.
  "failed",
  "canceled",
] as const;
export type ContractorPaymentStatus =
  (typeof CONTRACTOR_PAYMENT_STATUSES)[number];

export const CONTRACTOR_PAYMENT_STATUS_LABELS: Record<
  ContractorPaymentStatus,
  string
> = {
  draft: "Draft",
  sent: "Awaiting contractor",
  submitted: "Needs review",
  changes_requested: "Changes requested",
  approved: "Approved",
  paying: "Paying",
  paid: "Paid",
  rejected: "Rejected",
  failed: "Payment failed",
  canceled: "Canceled",
};

/** Statuses where nothing more will happen without a human starting something
 *  new — what a list view greys out and a queue count excludes. `failed` is
 *  deliberately NOT here: it is waiting on a retry, which is work. */
export const CONTRACTOR_PAYMENT_TERMINAL_STATUSES: ContractorPaymentStatus[] = [
  "paid",
  "rejected",
  "canceled",
];

/** Statuses that owe a treasurer a decision — the approval queue's filter and
 *  the set the reminder cron nags about. */
export const CONTRACTOR_PAYMENT_REVIEW_STATUSES: ContractorPaymentStatus[] = [
  "submitted",
];

/** Can the contractor still edit their half through the public link? `sent` is
 *  their first pass; `changes_requested` is the reviewer handing it back. Once
 *  it is `submitted` or beyond, the link renders read-only status instead — the
 *  server enforces this, the page merely reflects it. */
export function contractorCanEdit(status: ContractorPaymentStatus): boolean {
  return status === "sent" || status === "changes_requested";
}

// ── How the money is described ──────────────────────────────────────────────
/**
 * Where the record came from, which decides both the starting status and who
 * is allowed to change the terms.
 *
 * `staff_prefilled` — someone with compose rights wrote the terms (service,
 * date, amount, coding) and sent a link. The terms are the ORG's testimony and
 * the contractor may not touch them.
 *
 * `self_serve` — a blank request came in through `/payments`, terms and all,
 * asking to be approved. Nothing about it is pre-approved, and it arrives
 * UNCODED: `approve` refuses until a human has coded it, because a self-serve
 * row's own claim about which budget it belongs to is not evidence.
 */
export const CONTRACTOR_PAYMENT_ORIGINS = ["staff_prefilled", "self_serve"] as const;
export type ContractorPaymentOrigin =
  (typeof CONTRACTOR_PAYMENT_ORIGINS)[number];

export const CONTRACTOR_PAYMENT_ORIGIN_LABELS: Record<
  ContractorPaymentOrigin,
  string
> = {
  staff_prefilled: "Agreement sent",
  self_serve: "Payment requested",
};

// ── Tax documents ───────────────────────────────────────────────────────────
/**
 * Which tax form is on file. A US person or US entity files a W-9; a foreign
 * person files a W-8BEN and a foreign entity a W-8BEN-E.
 *
 * WE DO NOT STORE A TIN. The form is uploaded as a file and nothing parses it —
 * see `contractorTaxDocuments` in the schema for why (there is no field-level
 * encryption in this codebase, and the comparable secret — a card PAN — is
 * never stored at all). The consequence is honest and worth stating: 1099
 * aggregation at year-end keys on the PERSON, not on a TIN, so two rows for the
 * same human under different names will not self-combine. That is a reporting
 * chore, not a leak, and it is the trade we chose.
 */
export const CONTRACTOR_TAX_DOC_KINDS = ["w9", "w8ben", "w8bene"] as const;
export type ContractorTaxDocKind = (typeof CONTRACTOR_TAX_DOC_KINDS)[number];

export const CONTRACTOR_TAX_DOC_KIND_LABELS: Record<
  ContractorTaxDocKind,
  string
> = {
  w9: "W-9",
  w8ben: "W-8BEN",
  w8bene: "W-8BEN-E",
};

/** The W-8 forms, which mean the payee is NOT a US person. Approval is BLOCKED
 *  for these in v1: foreign payments can carry withholding obligations, and
 *  withholding is not something a form field can decide. The row is flagged for
 *  a human to handle off-platform rather than silently paid at 0%. */
export const FOREIGN_TAX_DOC_KINDS: ContractorTaxDocKind[] = ["w8ben", "w8bene"];

export function isForeignTaxDoc(kind: ContractorTaxDocKind): boolean {
  return FOREIGN_TAX_DOC_KINDS.includes(kind);
}

/**
 * How long a tax document is kept: through the end of the FOURTH year after
 * the LAST tax year it substantiates. The IRS wants employment-tax records for
 * four years after the tax is due or paid; keeping the form for the same window
 * and then destroying it is the whole point — an SSN we no longer hold is an
 * SSN that cannot leak.
 *
 * "LAST year it substantiates" is the 2026-08-15 correction, and it is the
 * whole reason reuse needed a schema change rather than a UI one. When one
 * document was pinned to one payment, its own service year was the only year
 * it answered for. A reused document answers for every payment that cites it,
 * so a clock started at the FIRST would destroy the evidence behind later
 * payments while they were still inside their own window — quietly, on a
 * four-year fuse, with nothing to notice at the time.
 */
export const CONTRACTOR_TAX_DOC_RETENTION_YEARS = 4;

/** The instant a document substantiating `taxYear` becomes eligible for the
 *  purge sweep — 1 Jan, `RETENTION_YEARS` after that tax year ends, UTC. */
export function taxDocPurgeAfter(taxYear: number): number {
  return Date.UTC(taxYear + 1 + CONTRACTOR_TAX_DOC_RETENTION_YEARS, 0, 1);
}

/**
 * The purge instant after a document is cited by a payment in `taxYear`.
 *
 * MONOTONIC BY CONSTRUCTION — it can only ever move later. Reuse for an earlier
 * year (a January payment for work done in December, or a backdated correction)
 * must not shorten a window already earned by a later payment. Expressing that
 * as a `Math.max` here, rather than as a rule each caller remembers, is what
 * makes "we never delete evidence early" a property of the arithmetic instead
 * of a property of everyone who touches it.
 */
export function extendedTaxDocPurgeAfter(
  currentPurgeAfter: number,
  taxYear: number,
): number {
  return Math.max(currentPurgeAfter, taxDocPurgeAfter(taxYear));
}

/**
 * How long we keep a tax document that no payment ever paid out.
 *
 * A form collected for a job that fell through is the one we have LEAST right
 * to hold: nothing was reported to anyone, no return depends on it, and the
 * four-year rule is about substantiating money that moved. So it gets a short
 * sliding window from its last activity instead, and the sweep takes it.
 */
export const CONTRACTOR_TAX_DOC_UNPAID_RETENTION_DAYS = 180;

export function unpaidTaxDocPurgeAfter(lastActivityAt: number): number {
  return (
    lastActivityAt + CONTRACTOR_TAX_DOC_UNPAID_RETENTION_DAYS * 24 * 60 * 60 * 1000
  );
}

// ── Is the form on file still good? ─────────────────────────────────────────
/**
 * WHEN A FORM STOPS COUNTING AS "ON FILE" — the rule that decides whether a
 * returning contractor is asked to upload again.
 *
 * A W-9 HAS NO EXPIRY. It stays valid until the information on it changes —
 * legal name, TIN, entity classification, exempt status, or backup-withholding
 * status. There is no interval after which the IRS considers one stale, so
 * expiring them on a timer would be inventing a rule and making returning
 * contractors re-upload for nothing. Instead we ask THEM, because the change is
 * something only they know about: an attestation each time, with an explicit
 * way to say "something changed" (`contractorCanReuseTaxDoc` returns true, and
 * the page still asks).
 *
 * A W-8 DOES EXPIRE, and this is the asymmetry worth getting right. A W-8BEN or
 * W-8BEN-E is valid from the date it was SIGNED through the last day of the
 * third succeeding calendar year — so one signed any time in 2026 lapses at the
 * end of 2029. That is why `contractorTaxDocuments.signedAt` exists and is
 * required for W-8 kinds: nothing parses the PDF, and deriving validity from
 * the upload date would silently over-grant it for a form signed years before
 * it reached us.
 */
export function w8ExpiresAt(signedAt: number): number {
  const signedYear = new Date(signedAt).getUTCFullYear();
  // Through the last day of the third succeeding calendar year — i.e. the
  // instant the fourth one begins.
  return Date.UTC(signedYear + 4, 0, 1);
}

/** Is a tax document still good as of `now`? W-9s always are; W-8s lapse. A
 *  W-8 with no `signedAt` is treated as EXPIRED rather than valid — an unknown
 *  signing date is not evidence of a current form. */
export function taxDocIsCurrent(
  doc: { kind: ContractorTaxDocKind; signedAt?: number },
  now: number = Date.now(),
): boolean {
  if (!isForeignTaxDoc(doc.kind)) return true;
  if (doc.signedAt == null) return false;
  return now < w8ExpiresAt(doc.signedAt);
}

/** Human sentence for why a form can't be reused, or `null` when it can. */
export function taxDocReuseProblem(
  doc: { kind: ContractorTaxDocKind; signedAt?: number },
  now: number = Date.now(),
): string | null {
  if (taxDocIsCurrent(doc, now)) return null;
  if (doc.signedAt == null) {
    return "We don't have a signing date for this form, so we can't tell whether it's still valid.";
  }
  return `This ${CONTRACTOR_TAX_DOC_KIND_LABELS[doc.kind]} expired at the end of ${
    new Date(w8ExpiresAt(doc.signedAt)).getUTCFullYear() - 1
  }.`;
}

// ── Tax classification ──────────────────────────────────────────────────────
/**
 * How the payee is organised, as the W-9 itself asks it.
 *
 * Collected once per contractor because it is the fact that decides whether a
 * payment is 1099-reportable at all — payments to a C or S corporation
 * generally are not. Without it, a year-end report can only list everyone we
 * paid and leave a human to work out who is exempt, which is the part of the
 * job that actually takes the time.
 *
 * `unknown` is a real, expected value: every contractor already on file
 * predates this question, and pretending otherwise would make the report
 * confidently wrong rather than visibly incomplete.
 */
export const CONTRACTOR_TAX_CLASSIFICATIONS = [
  "individual",
  "sole_proprietor",
  "single_member_llc",
  "partnership",
  "c_corporation",
  "s_corporation",
  "trust_estate",
  "other",
  "unknown",
] as const;
export type ContractorTaxClassification =
  (typeof CONTRACTOR_TAX_CLASSIFICATIONS)[number];

export const CONTRACTOR_TAX_CLASSIFICATION_LABELS: Record<
  ContractorTaxClassification,
  string
> = {
  individual: "An individual",
  sole_proprietor: "A sole proprietor",
  single_member_llc: "A single-member LLC",
  partnership: "A partnership or multi-member LLC",
  c_corporation: "A C corporation",
  s_corporation: "An S corporation",
  trust_estate: "A trust or estate",
  other: "Something else",
  unknown: "Not recorded",
};

/** Classifications generally NOT 1099-reportable. Deliberately a reporting
 *  HINT and never an automatic exclusion — the exceptions (legal services,
 *  medical payments) are real, so the year-end view flags these rather than
 *  dropping them. */
export const TAX_CLASSIFICATIONS_USUALLY_EXEMPT: ContractorTaxClassification[] = [
  "c_corporation",
  "s_corporation",
];

// ── What the public sees ────────────────────────────────────────────────────
/**
 * The counterparty label a contractor payment publishes on the public ledger.
 *
 * THE CONTRACTOR'S NAME DOES NOT PUBLISH (founder decision, 2026-08-14). The
 * ledger shows this constant, the service description, the amount, the date,
 * and the coding — enough for a reader to audit what the money bought, without
 * naming the individual who was paid.
 *
 * This is deliberately the CONSERVATIVE direction of a one-way door. Publishing
 * a name later is a change we can make; un-publishing one is not, because a
 * published statement can only ever be amended in public. If the org later
 * decides contractor names belong on the ledger (there is a real transparency
 * argument — the codebase's existing line is "publish who we PAY, never who
 * GIVES", see commit 8d0840a), the change is this constant plus a migration
 * decision about already-published months, NOT a re-plumbing.
 *
 * Note this differs from `lib/reimbursementTxnFields.ts`, which writes
 * "Reimbursement to <name>" into the same field. That is a member being made
 * whole, and the org publishes it. This is someone's livelihood.
 */
export const CONTRACTOR_LEDGER_COUNTERPARTY = "Contractor payment";

/**
 * Is this text safe to publish verbatim on the public ledger?
 *
 * The contractor writes (or, on the pre-filled path, reads and accepts) a
 * service description that goes public WORD FOR WORD and permanently. People
 * put their phone number and their home address in free-text boxes; a
 * disclosure banner asking them not to is necessary and completely
 * insufficient, so the server checks too.
 *
 * DELIBERATELY CRUDE. This catches the shapes that are unambiguous — an email
 * address, a long digit run that could be an SSN or an account number, a phone
 * number, a street address. It cannot catch "call me at my house on Elm", and
 * it is not trying to: the goal is to stop the accidental paste, not to
 * outsmart a determined user. False positives are handled by the person
 * rewording; a false negative is handled by `publicPurpose`, the treasurer's
 * audited redaction hatch, before the month publishes.
 *
 * Returns the problems in human words, ready to render next to the field.
 */
export function publicTextProblems(text: string): string[] {
  const problems: string[] = [];
  const t = text.trim();
  if (!t) return problems;

  if (/[\w.+-]+@[\w-]+\.[\w.]+/.test(t)) {
    problems.push("This looks like it contains an email address.");
  }
  // A phone number in any of the shapes people actually type. Requires a
  // separator or a leading +/( so it doesn't fire on a plain 10-digit invoice
  // number, which the SSN/account rule below covers on its own terms.
  if (/(\+\d{1,2}[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/.test(t)) {
    problems.push("This looks like it contains a phone number.");
  }
  // 123-45-6789, or any bare run of 9+ digits (SSN, EIN, bank account).
  if (/\b\d{3}-\d{2}-\d{4}\b/.test(t) || /\b\d{9,}\b/.test(t)) {
    problems.push(
      "This looks like it contains a Social Security, tax, or account number.",
    );
  }
  if (
    /\b\d{1,6}\s+([A-Za-z.'-]+\s+){0,3}(street|st|avenue|ave|road|rd|boulevard|blvd|lane|ln|drive|dr|court|ct|way|circle|cir|terrace|ter|place|pl)\b\.?/i.test(
      t,
    )
  ) {
    problems.push("This looks like it contains a street address.");
  }
  return problems;
}

/** The longest a public-facing service description may be. Long enough to say
 *  what the work was, short enough that the ledger row stays a ledger row. */
export const CONTRACTOR_SERVICE_DESCRIPTION_MAX = 280;

/**
 * The SHORTEST a service description may be — and it is not an arbitrary
 * minimum, it is the coding validator's.
 *
 * When a contractor payment is paid, its description is ported verbatim into
 * the payout transaction's coding as `businessPurpose`
 * (`lib/contractorTxnFields.ts`), where the shared `codingFieldProblems` rule
 * demands `MIN_PURPOSE_LENGTH`. Accepting anything shorter here builds a
 * payment that passes composition, contractor completion, AND approval, and
 * then fails at the moment the treasurer presses Pay — with a message about
 * "which org work it served" that makes no sense on a payout screen, and money
 * that does not move for a reason nobody can act on.
 *
 * So the same bar is enforced at the door, in words that fit where they are
 * read. Deriving it from `MIN_PURPOSE_LENGTH` rather than restating 20 is the
 * point: if the coding rule moves, this moves with it, and the two can never
 * drift into that trap again.
 */
export const CONTRACTOR_SERVICE_DESCRIPTION_MIN = MIN_PURPOSE_LENGTH;

/** Human problems with a proposed service description, empty when it is fine.
 *  Shared so the public page, the in-app composer and the server refuse the
 *  same strings — including the length the payout will later demand. */
export function contractorDescriptionProblems(text: string): string[] {
  const t = text.trim();
  if (t.length < CONTRACTOR_SERVICE_DESCRIPTION_MIN) {
    return [
      `Say what the work was in a bit more detail — at least ${CONTRACTOR_SERVICE_DESCRIPTION_MIN} characters. "Sound engineering for the spring concert", not "sound".`,
    ];
  }
  if (t.length > CONTRACTOR_SERVICE_DESCRIPTION_MAX) {
    return [
      `Keep it under ${CONTRACTOR_SERVICE_DESCRIPTION_MAX} characters — this is a ledger line, not a contract.`,
    ];
  }
  return publicTextProblems(t);
}

// ── Money bounds ────────────────────────────────────────────────────────────
/**
 * The most a single contractor payment may be, in cents. Not a policy limit —
 * a typo limit. The failure this exists for is a staffer typing an amount in
 * dollars into a field that means cents, or adding a zero; both produce a
 * number that is obviously wrong and that nobody wants discovered by an ACH
 * that already left. A genuinely larger engagement splits into milestones or
 * gets handled off-platform.
 */
export const CONTRACTOR_PAYMENT_MAX_CENTS = 50_000_00;

/** Human problems with a proposed amount, empty when it is fine. Shared so the
 *  public page, the in-app form, and the server all refuse the same numbers. */
export function contractorAmountProblems(amountCents: number): string[] {
  if (!Number.isFinite(amountCents) || !Number.isInteger(amountCents)) {
    return ["Enter an amount."];
  }
  if (amountCents <= 0) return ["The amount must be more than zero."];
  if (amountCents > CONTRACTOR_PAYMENT_MAX_CENTS) {
    return [
      `The amount can't be more than $${(
        CONTRACTOR_PAYMENT_MAX_CENTS / 100
      ).toLocaleString("en-US")}. Split a larger engagement into milestones.`,
    ];
  }
  return [];
}
