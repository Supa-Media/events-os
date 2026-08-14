/**
 * Shared finance domain model for Chapter OS.
 *
 * Pure constants + helpers used by BOTH the Convex backend and the Expo app so
 * the finance enums, role grading, and money formatting never drift between the
 * two. Every status/enum below is a readonly tuple; the Convex schema turns each
 * into a validator with `v.union(...TUPLE.map((s) => v.literal(s)))` (the
 * `EVENT_STATUSES` pattern), so the schema and app stay in lock-step without
 * pulling `convex/values` in here.
 *
 * MONEY IS ALWAYS INTEGER CENTS (USD) — never floats. Mirrors ticketing's
 * `priceCents`. `formatCents` is the single place cents become a display string.
 */

// ── Funds ────────────────────────────────────────────────────────────────────
// A fund is the top bucket money lives in. "unrestricted" is general operating
// money; "designated" money is earmarked for a purpose (a grant, a designated
// gift) and may only be spent against that purpose.
export const FUND_RESTRICTIONS = ["unrestricted", "designated"] as const;
export type FundRestriction = (typeof FUND_RESTRICTIONS)[number];

export const FUND_RESTRICTION_LABELS: Record<FundRestriction, string> = {
  unrestricted: "Unrestricted",
  designated: "Designated",
};

// ── Budget categories ────────────────────────────────────────────────────────
// Categories nest under a fund (self-nesting via parentCategoryId, kept
// acyclic). A "category" groups line items; a "lineItem" is a leaf you budget /
// spend against (Food, Ad spend, Software…).
export const BUDGET_CATEGORY_KINDS = ["category", "lineItem"] as const;
export type BudgetCategoryKind = (typeof BUDGET_CATEGORY_KINDS)[number];

// ── Budgets: type × cadence × tags (v2) ──────────────────────────────────────
// A budget v2 has three axes: its TYPE (one_time vs recurring — the source of
// truth, replacing the 6-value `scope`), its LEVEL (a real chapter or the
// `"central"` sentinel, stored in `chapterId`), and MULTIPLE managed TAGS (the
// flexible filter + rollup dimension). It still carries a CADENCE and optionally
// narrows to a fund + category.
export const BUDGET_TYPES = ["one_time", "recurring"] as const;
export type BudgetType = (typeof BUDGET_TYPES)[number];

export const BUDGET_TYPE_LABELS: Record<BudgetType, string> = {
  one_time: "One-time",
  recurring: "Recurring",
};

// A one_time budget points at a specific event or project (its `scopeRefId` is
// that instance's id); `refKind` says which table the ref points at.
export const BUDGET_REF_KINDS = ["event", "project"] as const;
export type BudgetRefKind = (typeof BUDGET_REF_KINDS)[number];

// Managed budget tags. `team`/`template` tags carry a `refId` (a financeTeams /
// eventType id) for auto-tag dedup; `events` is the auto-applied catch-all for
// event budgets; `custom` is a free author-created tag.
export const BUDGET_TAG_KINDS = [
  "team",
  "template",
  "events",
  "custom",
] as const;
export type BudgetTagKind = (typeof BUDGET_TAG_KINDS)[number];

// A budget is a flexible allocation. Its SCOPE says what it's attached to, its
// CADENCE says how often it recurs, and it optionally narrows to a fund +
// category. Any scope can take any cadence ("Development team = $2,000/mo",
// "Equipment = $4,000/yr", "Worship w/ Strangers = $500/instance").
/**
 * @deprecated Budgets v2 uses `BUDGET_TYPES` + multiple `BUDGET_TAG_KINDS` tags.
 * `scope` survives only as an optional legacy column + the migration mapping;
 * new code must switch on `type`, never `scope`.
 */
export const BUDGET_SCOPES = [
  "event", // one specific event instance
  "project", // one specific project
  "template", // every instance of an event template
  "team", // a finance team / department (Development, Marketing…)
  "bucket", // a general recurring bucket (a category over time)
  "chapter", // the whole chapter / org
] as const;
export type BudgetScope = (typeof BUDGET_SCOPES)[number];

/** @deprecated Legacy scope labels — kept for the migration + legacy column. */
export const BUDGET_SCOPE_LABELS: Record<BudgetScope, string> = {
  event: "Event",
  project: "Project",
  template: "Template",
  team: "Team",
  bucket: "Bucket",
  chapter: "Chapter",
};

export const BUDGET_CADENCES = [
  "per_instance",
  "monthly",
  "quarterly",
  "yearly",
  "one_off",
] as const;
export type BudgetCadence = (typeof BUDGET_CADENCES)[number];

export const BUDGET_CADENCE_LABELS: Record<BudgetCadence, string> = {
  per_instance: "Per instance",
  monthly: "Monthly",
  quarterly: "Quarterly",
  yearly: "Yearly",
  one_off: "One-off",
};

// Rollover policy is DEFERRED for v1 (spent-vs-allocated per period only, no
// rollover math). The tuple exists so the schema can carry an optional per-budget
// toggle now and the behavior can be built later without a migration.
export const BUDGET_ROLLOVER_POLICIES = ["none", "accumulate"] as const;
export type BudgetRolloverPolicy = (typeof BUDGET_ROLLOVER_POLICIES)[number];

// ── Budget approval workflow (WP-3.2) ────────────────────────────────────────
// State machine: draft → submitted → approved | changes_requested. A budget
// created before this feature shipped carries NO `approvalStatus` at all
// (`undefined`, not one of these four literals) — GRANDFATHERED, treated as
// "approved at its current amount" for display + cap purposes
// (`effectiveBudgetApprovalStatus`/`effectiveCapCents` in `finances.ts`) with
// zero workflow friction UNTIL its first edit: it can't be manually
// re-submitted, and a DECREASE never touches it. But an amount INCREASE
// retriggers on its FIRST occurrence (I1, review) exactly like a literally
// `"approved"` budget crossing its cap — `setBudgetAmount` stamps
// `approvedCents` at the pre-edit amount and flips it to `"submitted"`,
// joining the real workflow from then on. This is deliberate — shipping the
// feature must not suddenly gate hundreds of existing prod budgets that are
// never touched again, but the owner's "raising a cap needs a fresh look"
// rule still has to apply the moment one IS touched.
export const BUDGET_APPROVAL_STATUSES = [
  "draft",
  "submitted",
  "approved",
  "changes_requested",
] as const;
export type BudgetApprovalStatus = (typeof BUDGET_APPROVAL_STATUSES)[number];

export const BUDGET_APPROVAL_STATUS_LABELS: Record<BudgetApprovalStatus, string> = {
  draft: "Draft",
  submitted: "Awaiting approval",
  approved: "Approved",
  changes_requested: "Changes requested",
};

/** A budget's EFFECTIVE approval status: the stored value, or `"approved"` for
 *  a grandfathered legacy row that predates this feature (see the tuple's doc
 *  comment above). Display + cap resolution both go through this — never read
 *  `budget.approvalStatus` raw for either purpose. */
export function effectiveBudgetApprovalStatus(
  status: BudgetApprovalStatus | undefined,
): BudgetApprovalStatus {
  return status ?? "approved";
}

// ── Transactions ─────────────────────────────────────────────────────────────
// The unified ACTUAL spend/inflow record — the ONLY table summed for "actual".
// Estimated money (budgets, projects.budgetUsd, events.budget, item costs,
// engagement amounts) is never summed with this (anti-double-count).
export const TRANSACTION_SOURCES = [
  "increase_card", // a charge on an Increase-issued member card
  "increase_ach", // a non-card entry on the chapter's (or central's) Increase
  // account — ACH in/out, wires, check deposits, fees, interest. Synced by
  // `increaseLedger.ts` (webhook + daily backfill) so every account entry
  // reaches Reconcile; card charges use `increase_card` instead.
  "stripe_fc", // synced from a legacy external account via Stripe FC
  "relay_csv", // imported from a Relay monthly-statement CSV (full history)
  "manual", // hand-entered
  "reimbursement", // the payout leg of an approved reimbursement (a transfer)
  "repayment", // an offsetting credit from a personal-charge repayment
  "skim", // HISTORICAL (WP-4.1, retired) — a leg of the automated monthly
  // chapter→central City Launch Fund skim. No code writes this anymore
  // (owner decision 2026-07-26: "just 1 chapter, not a lot of backers, it
  // feels unnecessarily complex" — see `transfers.ts`'s header comment); kept
  // ONLY so prod rows recorded before the collapse keep validating. Never
  // migrated/rewritten — a read path that still cares can treat it as a
  // `"transfer"` alias (both are `flow:"transfer"` legs).
  "launch_grant", // HISTORICAL (WP-4.2, retired) — a leg of a one-time
  // central→chapter launch grant, same retirement as `"skim"` above.
  "settlement", // HISTORICAL (WP-4.5, retired) — a leg of a monthly
  // central↔chapter inter-scope settlement, same retirement as `"skim"`
  // above.
  "transfer", // a leg of a generic manual central↔chapter transfer — the ONE
  // kind every NEW transfer writes today (skim commitment, launch grant, or
  // inter-scope settlement are now all just "a transfer" with a free-text
  // `note` explaining why; see `transfers.ts#recordTransfer`). Direction
  // lives in `transactions.transferDirection`, not a separate source value.
] as const;
export type TransactionSource = (typeof TRANSACTION_SOURCES)[number];

/**
 * WHICH RAIL CARRIED THE ROW, in words a treasurer uses.
 *
 * The enum values are internal plumbing names and two of them are actively
 * misleading on a screen: `stripe_fc` is the RELAY bank feed (Stripe Financial
 * Connections is only the pipe we read it through, and the money never touched
 * Stripe), and `relay_csv` is the historical Relay statement import rather than
 * anything live. The owner, reading the book-value audit page: "I just see like
 * stripe rows and stuff like that." He was looking at his own bank.
 *
 * Named here, beside the tuple, for the same reason `TRANSACTION_STATUS_LABELS`
 * is: an enum that reaches a screen needs exactly one English spelling.
 */
export const TRANSACTION_SOURCE_LABELS: Record<TransactionSource, string> = {
  increase_card: "Increase card",
  increase_ach: "Increase account",
  stripe_fc: "Relay bank feed",
  relay_csv: "Relay statement import",
  manual: "Entered by hand",
  reimbursement: "Reimbursement payout",
  repayment: "Personal-charge repayment",
  skim: "City Launch Fund skim (historical)",
  launch_grant: "Launch grant (historical)",
  settlement: "Inter-scope settlement (historical)",
  transfer: "Recorded transfer",
};

/** The rail's name, tolerant of a value this map hasn't been taught — a source
 *  added tomorrow renders as words rather than disappearing. */
export function transactionSourceLabel(source: string): string {
  return (
    TRANSACTION_SOURCE_LABELS[source as TransactionSource] ??
    source.replace(/_/g, " ")
  );
}

// ── Why a ledger row contributed nothing to book value ──────────────────────
/**
 * The vocabulary of `apps/convex/lib/bookBalance.ts`, as codes a screen can
 * render. THAT FILE IS THE AUTHORITY — this list adds no rule and decides
 * nothing; it only lets the audit page name the branch a row fell down, in the
 * same order `signedBookCents` tests them.
 *
 * It exists because the page used to give every zero the same sentence
 * ("Transfer with no recorded direction"), which is false for most of them — a
 * marked bank transfer and a balance settlement are zero for reasons that have
 * nothing to do with a missing direction, and telling a treasurer to go
 * "categorise" them sends him after work that isn't there.
 *
 * Two of the eight have no branch in `signedBookCents` at all, for opposite
 * reasons. `linked_gift` is decided BEFORE it is asked — the query skips those
 * rows because the gift layer already counted that money. It means FULLY
 * counted: one deposit can carry several gifts (`lib/giftCoverage.ts`), and a
 * deposit only partly matched keeps its unclaimed remainder and stays on the
 * page rather than vanishing behind this code. `zero_amount` is
 * decided AFTER: a $0.00 row goes down an ordinary inflow/outflow branch and
 * signs to zero arithmetically, so it is not a rule at all, just a row with
 * nothing in it. Naming it separately keeps it out of
 * `unknown_transfer_shape`, which is the only code that means "go fix
 * something".
 */
export const BOOK_VALUE_ZERO_REASONS = [
  "linked_gift",
  "excluded",
  "payout_deposit",
  "payout_allocation",
  "balance_settlement",
  "marked_transfer",
  "zero_amount",
  "unknown_transfer_shape",
] as const;
export type BookValueZeroReason = (typeof BOOK_VALUE_ZERO_REASONS)[number];

export const BOOK_VALUE_ZERO_REASON_LABELS: Record<
  BookValueZeroReason,
  string
> = {
  linked_gift: "Counted once, at the gift or gifts this bank row belongs to",
  excluded: "Excluded by hand — out of every total",
  payout_deposit:
    "A processor payout arriving — already counted at the gift, ticket, sale or registration",
  payout_allocation:
    "A payout being split between books — the revenue is already on the right book",
  balance_settlement:
    "Cash delivered to a book that had already earned it — it moves money, not value",
  marked_transfer:
    "Marked as a transfer between our own accounts — that moves cash, not value",
  zero_amount: "A zero-amount row",
  unknown_transfer_shape:
    "A transfer with no recorded direction — counted as nothing rather than guessed at",
};

// Direction of money. `transfer` is money moving without being category spend
// (e.g. a reimbursement payout) — excluded from category/budget spend totals.
export const TRANSACTION_FLOWS = ["outflow", "inflow", "transfer"] as const;
export type TransactionFlow = (typeof TRANSACTION_FLOWS)[number];

export const TRANSACTION_STATUSES = [
  "unreviewed", // just synced/created, needs a human
  "categorized", // fund/category assigned
  "reconciled", // matched to a receipt + confirmed
  "excluded", // intentionally left out of totals (personal, duplicate…)
] as const;
export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];

// LABELS ONLY. The stored values above never change — `"reconciled"` is still
// the string in the schema, in filter keys, in URL params and in Convex args.
// The founder's words on the deployed grid were "I don't even know what
// reconciled is", so the STATE is shown as "Closed", pairing with the
// "Ready to close" filter that already funnels rows toward it.
export const TRANSACTION_STATUS_LABELS: Record<TransactionStatus, string> = {
  unreviewed: "Unreviewed",
  categorized: "Categorized",
  reconciled: "Closed",
  excluded: "Excluded",
};

// ── Finance audit log (field-change trail) ───────────────────────────────────
// One append-only row per meaningful FIELD CHANGE on a transaction or budget —
// "who altered a value from X to Y." Distinct from `approvals` (APPROVAL
// DECISIONS: who approved/rejected/paid a reimbursement/payout/budget) and from
// `budgetApprovalLog`/`reattributionAudit` (their own narrower append-only
// trails — a budget approval decision or a bulk cross-scope reattribution is
// NEVER double-logged here; see each mutation's own comment). See
// `schema/finances.ts`'s `financeAuditLog` table doc for the full shape.
export const FINANCE_AUDIT_ACTIONS = [
  "status_change", // setTransactionStatus (the headline: excluding requires a reason)
  "recode", // categorizeTransaction / bulkCategorize / setTransactionCategory
  "receipt_attach", // attachReceipt / receipts.linkReceipt
  "receipt_detach", // receipts.unlinkReceipt
  "receipt_exception_attest", // receiptExceptions.attest / attestBulk
  "receipt_exception_decide", // receiptExceptions.approve / reject
  "receipt_exception_withdraw", // receiptExceptions.withdraw
  "correction", // finances.correctTransaction (amount/date/merchant/description)
  "personal_flag", // cards.flagPersonalCharge / cards.unflagPersonalCharge
  "transfer_mark", // finances.markAsTransfer / unmarkTransfer (BOTH legs logged)
  "refund_mark", // finances.markAsRefund / unmarkRefund (BOTH rows logged)
  // The Increase ingester auto-pairing a `card_refund` against its
  // `card_settlement` under the same `cardPaymentId` — SAME pairing writes as
  // `refund_mark` (via `lib/refundPair.ts`, shared, never a looser copy), but
  // no human clicked anything, so it gets its own action rather than
  // impersonating one. No `actorUserId` on these rows — see
  // `financeAuditLog.actorUserId`'s schema doc for why that's the ONE
  // sanctioned exception.
  "refund_mark_auto", // increaseLedger.ts auto-pairer (BOTH rows logged)
  "payout_mark", // finances.markAsPayout / unmarkPayout
  "note_edit", // setTransactionNote
  "manual_create", // createManualTransaction
  "budget_amount_change", // updateBudget (amountCents only)
  "budget_delete", // deleteBudget
  "coding_submit", // transactionCodings.submit — initial submission AND each resubmission after a send-back (the revision history)
  "coding_decide", // transactionCodings.approve / requestChanges
  // An approver rewrote the PUBLISHED wording of a coding — stripping a name
  // or other personal detail out of the sentence that goes on the public
  // ledger. REDACTION, NOT FALSIFICATION: the author's original
  // `businessPurpose` is retained and stays internally readable; this action
  // records who wrote the public version and when. `before`/`after` carry the
  // two published strings, so the trail reads as a revision history.
  "coding_redact", // transactionCodings.setPublicPurpose
  "merchant_rename", // finances.renameMerchant / clearMerchantRename (display name only — the provider's own string is never touched)
  // SALES (subjectType "sale"). A sale's money is never editable — gross and fee
  // come from the processor and stay there. What a human can settle is the two
  // things the card reader never told us: WHICH ITEMS the amount was, and WHICH
  // EVENT it happened at. Both are judgement calls made from memory, so both are
  // exactly the kind of thing a trail has to be able to attribute later.
  "sale_items_set", // sales.setSaleItems — a basket picked (or cleared back to unresolved)
  "sale_event_set", // sales.setSaleEvent — an orphan sale attributed to an event (or detached)
] as const;
export type FinanceAuditAction = (typeof FINANCE_AUDIT_ACTIONS)[number];

export const FINANCE_AUDIT_ACTION_LABELS: Record<FinanceAuditAction, string> = {
  status_change: "Status changed",
  recode: "Recoded",
  receipt_attach: "Receipt attached",
  receipt_detach: "Receipt detached",
  receipt_exception_attest: "Receipt exception filed",
  receipt_exception_decide: "Receipt exception decided",
  receipt_exception_withdraw: "Receipt exception withdrawn",
  correction: "Corrected",
  personal_flag: "Personal flag changed",
  transfer_mark: "Internal transfer marking changed",
  refund_mark: "Refund marking changed",
  refund_mark_auto: "Refund auto-paired (Increase)",
  payout_mark: "Processor payout marking changed",
  note_edit: "Note edited",
  manual_create: "Created manually",
  budget_amount_change: "Budget amount changed",
  budget_delete: "Budget deleted",
  coding_submit: "Coding submitted",
  coding_decide: "Coding decided",
  coding_redact: "Published wording edited",
  merchant_rename: "Merchant renamed",
  sale_items_set: "Sale items set",
  sale_event_set: "Sale event set",
};

// ── Inbound email receipts (backfill pipeline) ───────────────────────────────
// The lifecycle of ONE inbound email routed to the receipt-ingest webhook
// (reply.publicworship.life via Resend). A row is created the moment a signed
// `email.received` webhook lands and advances through OCR → match; its terminal
// state is either an auto-attach (`matched`) or a human touch-point
// (`needs_review`) / a dead end (`no_match`/`ignored`/`error`).
export const INBOUND_RECEIPT_STATUSES = [
  "pending", // received + deduped; OCR/match not run yet (scheduled)
  // CAPTURED, filed to the sender's own receipt library with its candidate
  // charges kept as suggestions — the terminal state of a healthy inbound
  // receipt since the pipeline stopped attaching on its own (owner decision,
  // 2026-08-08: "they should just upload the receipt when coding"). NOT a
  // bookkeeper task: nobody is blocked, and the cardholder confirms the match
  // in one tap while coding the charge. Kept OUT of the review queue for
  // exactly that reason — a queue that fills up with successes is a queue
  // people stop reading.
  "suggested",
  "matched", // HISTORICAL — auto-attached to exactly one transaction. No code
  // writes this any more (see `receiptInbox.ts`/`smsReceipts.ts`); kept so the
  // rows recorded while the pipeline still stapled receipts unattended keep
  // validating and keep saying honestly what happened to them.
  "needs_review", // OCR'd but something a HUMAN must resolve (unreadable, a
  // duplicate, an unknown sender) — the queue's real population now
  "no_match", // OCR'd, a clean amount read, but no unreceipted txn fits at all
  "ignored", // sender not on the roster, or nothing to OCR (no attachment/body)
  "error", // the pipeline threw (fetch/OCR/store) — retriable
] as const;
export type InboundReceiptStatus = (typeof INBOUND_RECEIPT_STATUSES)[number];

// ── Receipts (first-class receipt documents) ─────────────────────────────────
// A `receipts` row is a first-class receipt DOCUMENT, linked many-to-many to
// `transactions` via `receiptLinks`. `RECEIPT_SOURCES` is how the document
// itself entered the system: from an inbound `email` (the OCR pipeline), an
// inbound `sms`/MMS text (the Twilio pipeline, `smsReceipts.ts` — the SAME
// OCR→match→auto-attach policy, just fed by a text instead of an email), or a
// direct in-app `upload` (the mobile attach path + the backfill of legacy
// `transactions.receiptStorageId` documents).
export const RECEIPT_SOURCES = ["email", "sms", "upload"] as const;
export type ReceiptSource = (typeof RECEIPT_SOURCES)[number];

// How a SINGLE receipt↔transaction link was made (`receiptLinks.source`):
//  - `auto_email`: the email→OCR pipeline auto-matched a unique candidate,
//  - `auto_sms`: the SMS/MMS→OCR pipeline auto-matched a unique candidate
//    (`smsReceipts.ts`) — kept distinct from `auto_email` so the provenance
//    of an auto-attach is never misattributed to the wrong channel,
//  - `manual`: a bookkeeper picked the transaction by hand,
//  - `upload`: created alongside a direct in-app receipt upload,
//  - `backfill`: reconstructed from a legacy `transactions.receiptStorageId`
//    by the receipts-foundation migration.
export const RECEIPT_LINK_SOURCES = [
  "auto_email",
  "auto_sms",
  "manual",
  "upload",
  "backfill",
] as const;
export type ReceiptLinkSource = (typeof RECEIPT_LINK_SOURCES)[number];

// How much a receipt sender is trusted — the axis both the email and SMS OCR
// pipelines' AUTOMATION policy keys off (never a permission grant). Both
// inbound endpoints are public, so a `From:`/phone number is spoofable: only a
// `team`/`roster` sender (one that resolves to a known `people` row) may EVER
// trigger an auto-attach; every other class is always routed to human review,
// never auto-attached and never reconciled.
//  - `team`: resolves to a `people` row flagged `isTeamMember`,
//  - `roster`: resolves to a `people` row (not core team),
//  - `internal`: EMAIL ONLY — no person match, but the address is on the org
//    email domain (`ALLOWED_EMAIL_DOMAIN`). A phone number has no equivalent
//    "org domain" to trust, so `smsReceipts.ts#classifySmsSender` never
//    returns this class — an unresolved phone is always `external`,
//  - `external`: everything else (a stranger).
export const RECEIPT_SENDER_CLASSES = [
  "team",
  "roster",
  "internal",
  "external",
] as const;
export type ReceiptSenderClass = (typeof RECEIPT_SENDER_CLASSES)[number];

/** True iff a receipt-email sender is trusted enough to trigger an auto-attach
 *  (a resolved roster/team member). `internal`/`external` senders are always
 *  routed to human review — a spoofable From: must never move money. */
export function receiptSenderCanAutoAttach(
  senderClass: ReceiptSenderClass,
): boolean {
  return senderClass === "team" || senderClass === "roster";
}

// ── Receipt exceptions (documented "there is no receipt") ────────────────────
// The documentation of record when no receipt can be produced. Publishing the
// ledger is what forces this to exist: today the only way to close a
// receipt-less row is `reconciled`/`excluded`, and a published ledger can't
// tell a properly-documented transaction from one somebody quietly closed.
//
// An exception is NOT an absence — it's a SUBSTITUTE DOCUMENT: a named person
// stating on the record what the spend was for and why no receipt exists,
// approved by someone else. See `docs/plans/receipt-exceptions.md`.
//
// "Missing" and "unattainable" are deliberately NOT two states — they're two
// values of this one reason axis, so the ledger can say WHY rather than just
// "no".
export const RECEIPT_EXCEPTION_REASONS = [
  "no_receipt_issued", // there never was one — cash tip, meter, donation box
  "lost", // we had it; it's gone
  "predates_policy", // before the org ran cards + receipts this way
  "vendor_unreachable", // asked the vendor; they can't reproduce it
  "bank_record_only", // the statement line is the only evidence that exists
] as const;
export type ReceiptExceptionReason = (typeof RECEIPT_EXCEPTION_REASONS)[number];

export const RECEIPT_EXCEPTION_REASON_LABELS: Record<
  ReceiptExceptionReason,
  string
> = {
  no_receipt_issued: "No receipt was issued",
  lost: "Receipt lost",
  predates_policy: "Predates the receipt policy",
  vendor_unreachable: "Vendor can't reproduce it",
  bank_record_only: "Bank record only",
};

/** The one-line "when do I pick this" hint the attest form shows under each
 *  reason — the difference between an honest exception and a shrug is whether
 *  the filer picked the reason that's actually true. */
export const RECEIPT_EXCEPTION_REASON_HINTS: Record<
  ReceiptExceptionReason,
  string
> = {
  no_receipt_issued:
    "A cash tip, a parking meter, a donation box — nothing was ever printed or emailed.",
  lost: "A receipt existed and can't be found now.",
  predates_policy:
    "The charge is from before we ran cards and receipts this way.",
  vendor_unreachable:
    "You asked the vendor for a copy and they can't produce one.",
  bank_record_only:
    "The bank/statement line is the only record that exists anywhere.",
};

// An exception's own lifecycle. `pending` is the only OPEN state; the other
// three are terminal for that row (re-filing means a NEW row, so a rejected
// attestation is never silently edited into an approved one).
export const RECEIPT_EXCEPTION_STATUSES = [
  "pending", // attested, awaiting a decision
  "approved", // stands as this transaction's documentation
  "rejected", // an approver said no — the row still owes a receipt
  "withdrawn", // the filer pulled it (usually because the receipt turned up)
] as const;
export type ReceiptExceptionStatus =
  (typeof RECEIPT_EXCEPTION_STATUSES)[number];

export const RECEIPT_EXCEPTION_STATUS_LABELS: Record<
  ReceiptExceptionStatus,
  string
> = {
  pending: "Awaiting approval",
  approved: "Approved",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
};

/** The attestation note is the SUBSTITUTE for the document — "what was this
 *  for" is the entire public value of an exception, so a blank or one-word
 *  note is refused. Shared by the server mutation and the form's validation so
 *  the two can't drift. */
export const MIN_EXCEPTION_NOTE_LENGTH = 12;

// ── Real friction before "the receipt is lost" ───────────────────────────────
//
// Owner, 2026-08-09: *"I want to create a lot of friction for someone to say
// no receipt… a couple of stage processes: did you try going to the website
// portal to see if the receipt's there? Yes or no. Did you try calling the
// local store and asking them to reproduce the receipt? Yes or no. And if it's
// no, then hey, you can't mark it as lost — go do the work to fish out the
// receipt. Another one is: did you check all your email inboxes including your
// spam folders."*
//
// THE REASON BRANCHES FIRST, and only `lost` gets this (owner, same day:
// *"This should only be if they say the receipt was lost. If they say no
// receipt issued, then it's just no receipt issued."*). Chasing a receipt that
// cannot exist — a subway fare, a vending machine, a donation box — is pure
// friction with no yield, so those file on an explanation alone.
//
// UNIFORM AT EVERY AMOUNT (owner: *"I feel like you should keep your receipts,
// and it doesn't take much to take a picture of it when you are spending
// money."*). The $75 line
// (`DEFAULT_EXCEPTION_APPROVAL_THRESHOLD_CENTS`) is a separate control and
// governs only who must APPROVE — it does not modulate this.
//
// ## What this achieves, honestly
//
// Someone can click "yes" three times and lie, and no copy anywhere should
// imply the system checked. It didn't. What it actually buys is two real
// things: it prompts recall of the two paths people genuinely forget (the spam
// folder and the vendor's order history are where the receipt usually turns
// out to be), and it turns the answers into an ATTESTED RECORD an approver can
// weigh — which is the point. *"This just gives the approver a lot of context
// information for what was going on that we don't have a receipt."*
export const LOST_RECEIPT_CHECKS = [
  {
    key: "vendor_portal",
    prompt:
      "Did you check the vendor's website or your account with them? (Order history, past orders, billing.)",
    /** Shown when they answer no — the block is the point, so it has to say
     *  what to go and do rather than just refusing. */
    blockedHint:
      "Most online and card purchases sit in an order history forever. Check there first — it's usually the fastest place to find it.",
  },
  {
    key: "merchant_asked",
    prompt:
      "Did you contact the merchant and ask them to reproduce it?",
    blockedHint:
      "Shops and restaurants can normally reprint from the card's last four and the date. Ask before filing this.",
  },
  {
    key: "inboxes_searched",
    prompt:
      "Did you search ALL your email inboxes — including spam — for an automatic receipt?",
    blockedHint:
      "Automatic receipts land in spam constantly. Search every address you might have used, spam included.",
  },
] as const;
export type LostReceiptCheckKey = (typeof LOST_RECEIPT_CHECKS)[number]["key"];

// The two questions that come BEFORE "no receipt was issued" is accepted.
//
// Owner: *"Sometimes no receipt was issued because no receipt was ASKED for.
// So we need to ask: does this store do receipts? Did you remember to ask? And
// if they say no, they forgot to ask — then that's the end of the question…
// and then we take them essentially to the lost-receipt flow."*
//
// So this is a CLASSIFIER, not a punishment: "I forgot to ask" is not "no
// receipt was issued", it's a receipt that existed and wasn't kept — which is
// what `lost` means and what the checks above are for. The copy says that
// plainly and without shaming; the point is that the record ends up true.
export const NOT_ISSUED_CHECKS = [
  {
    key: "merchant_issues_receipts",
    prompt: "Does this merchant issue receipts at all?",
    /** Answering NO is the honest end of it — a parking meter issues nothing. */
    noEndsIt: true,
  },
  {
    key: "asked_for_receipt",
    prompt: "Did you ask for one?",
    /** Answering NO reroutes to `lost` — see this block's doc. */
    noEndsIt: false,
  },
] as const;
export type NotIssuedCheckKey = (typeof NOT_ISSUED_CHECKS)[number]["key"];

/** One recorded yes/no, stored WITH the question it answered so the record
 *  stays legible even if the wording later changes, and so an approver reads
 *  what was actually asked rather than a bare key. */
export interface ExceptionAttestation {
  key: string;
  prompt: string;
  answer: boolean;
}

/**
 * Is this attestation set complete enough to file a `lost` exception?
 *
 * Every check must be present AND answered yes. Shared by the server guard and
 * the form so the two can't disagree about what "you did the work" means.
 * Returns the FIRST unmet check, or null.
 */
export function lostReceiptBlocker(
  attestations: readonly ExceptionAttestation[] | undefined,
): (typeof LOST_RECEIPT_CHECKS)[number] | null {
  for (const check of LOST_RECEIPT_CHECKS) {
    const answered = attestations?.find((a) => a.key === check.key);
    if (!answered || answered.answer !== true) return check;
  }
  return null;
}
/** Same cap + rationale as `MAX_NOTE_LENGTH` — an attestation is a short
 *  justification, not a document. */
export const MAX_EXCEPTION_NOTE_LENGTH = 2000;

/** Cap on evidence files per exception (owner decision, 2026-08-05). Enough
 *  for the normal shape — a few photos of what was bought, plus a statement
 *  line or a confirmation email — and low enough that filing stays a decision
 *  about the best proof rather than an upload of everything on the camera
 *  roll. Shared by the server guard and the picker, so the two can't drift. */
export const MAX_EXCEPTION_EVIDENCE = 5;

/** Default second-approver threshold: the IRS accountable-plan substantiation
 *  line ($75). At or above it an exception needs a DIFFERENT person to
 *  approve; below it a bookkeeper+ may approve their own attestation — the
 *  small-dollar long tail is where a two-name ceremony buys nothing. Stored
 *  as `financeSettings.receiptExceptionApprovalThresholdCents` so the org can
 *  move it; this is only the fallback when it's unset. */
export const DEFAULT_EXCEPTION_APPROVAL_THRESHOLD_CENTS = 7_500;

/** True iff an exception of this size needs an approver who is NOT the person
 *  who attested it. Separation of duties is what keeps the forward
 *  no-receipt-is-personal policy from being self-served into irrelevance —
 *  see `docs/plans/receipt-exceptions.md`. */
export function exceptionNeedsSecondApprover(
  amountCents: number,
  thresholdCents: number = DEFAULT_EXCEPTION_APPROVAL_THRESHOLD_CENTS,
): boolean {
  return Math.abs(amountCents) >= thresholdCents;
}

// ── Documentation state (derived — the PUBLISHED truth) ──────────────────────
// What backs this transaction up, deliberately independent of `status`. This
// is the predicate the public ledger renders, and the reason it has THREE
// values rather than two: an approved exception is a signed statement by a
// named person, not a hole. A ledger claiming zero exceptions across years of
// history reads as less credible, not more.
//
// Distinct from `needsDocumentation` (`apps/convex/finances.ts`), which is the
// CHASE WORKLIST and legitimately stops chasing a `reconciled` row. This one
// never consults status, so a legacy row closed document-less still reads
// `undocumented` — which is exactly the backlog that has to reach zero before
// a period is publishable.
export const DOCUMENTATION_STATES = [
  "receipt", // a receipt document is attached
  "exception", // an approved, attested exception stands in for one
  "undocumented", // neither
] as const;
export type DocumentationState = (typeof DOCUMENTATION_STATES)[number];

export const DOCUMENTATION_STATE_LABELS: Record<DocumentationState, string> = {
  receipt: "Receipt attached",
  exception: "Documented exception",
  undocumented: "Undocumented",
};

/**
 * Derive a transaction's documentation state. A receipt outranks an exception:
 * if the document turned up after an exception was approved, the receipt is
 * the better answer and the row should read as receipted.
 *
 * Takes primitives rather than a `Doc<"transactions">` so it stays usable from
 * the shared package (same shape as `personalExpenseState` above).
 */
export function documentationState(
  hasReceipt: boolean,
  hasApprovedException: boolean,
): DocumentationState {
  if (hasReceipt) return "receipt";
  if (hasApprovedException) return "exception";
  return "undocumented";
}

// ── Rows that owe no documentation at all ────────────────────────────────────
// `documentationState` above answers "what backs this row up". This answers the
// question that comes BEFORE it: is anything owed in the first place?
//
// It exists because the two were being conflated on screen. A processor fee, a
// marked payout and a marked internal transfer all owe nothing
// (`finances.ts#owesDocumentation`), and every COUNT in the app already knew
// that — but the Documentation cell only knew "no receipt, no exception", so it
// rendered an upload affordance and the words "No receipt" on rows the same
// screen had already dropped from the backlog. Founder, 2026-08-14: "For Stripe
// payouts it's saying no receipts still, but it should literally show that it's
// a payout — bank record only."
//
// SO THE EXEMPTION IS A VALUE, NOT AN ABSENCE. `finances.ts#documentationExemption`
// returns one of these keys, `owesDocumentation` is defined as "no key", and the
// cell renders that key's label. ONE list decides both, so "this row owes
// nothing" and "here is why" cannot drift apart — which is precisely how the
// grid came to contradict its own counts.
//
// NO NEW VOCABULARY. Each key resolves to something the app already says out
// loud: `bank_record_only` and `no_receipt_issued` are two of the five
// `RECEIPT_EXCEPTION_REASONS` a human can attest by hand, and the fee sentence
// is the one the public ledger already prints (`autoExplanationLine("fee")`). A
// row exempt BY CONSTRUCTION should read exactly like one somebody attested —
// the difference is who had to do the work, not what is true about the money.
export const DOCUMENTATION_EXEMPTIONS = [
  "processor_fee", // `feeOrigin` — charged, not chosen; the processor's ledger is the record
  "processor_payout", // a marked settlement deposit — already-counted revenue arriving
  "internal_transfer", // a marked internal transfer — our own money between our own accounts
] as const;
export type DocumentationExemption = (typeof DOCUMENTATION_EXEMPTIONS)[number];

/** The one-line label the Documentation cell shows in place of an upload
 *  affordance the row could never satisfy. */
export const DOCUMENTATION_EXEMPTION_LABELS: Record<
  DocumentationExemption,
  string
> = {
  processor_fee: RECEIPT_EXCEPTION_REASON_LABELS.no_receipt_issued,
  processor_payout: RECEIPT_EXCEPTION_REASON_LABELS.bank_record_only,
  internal_transfer: RECEIPT_EXCEPTION_REASON_LABELS.bank_record_only,
};

/** The full sentence behind that label — the row explaining itself, for a
 *  screen reader and for anywhere with room to print it. Derived from
 *  structured state, never composed testimony (the same rule
 *  {@link autoExplanationLine} follows — and its fee sentence is reused
 *  verbatim here rather than written a second time, where it could drift from
 *  the one the public page prints). */
export function documentationExemptionLine(
  kind: DocumentationExemption,
): string {
  if (kind === "processor_fee") return autoExplanationLine("fee");
  if (kind === "processor_payout") {
    return "A processor payout — donation and ticket money the org already counted, arriving in one batch. Nobody bought anything, so there is no receipt to produce; the bank record is the evidence, alongside the processor's own settlement report.";
  }
  return "An internal transfer between the org's own accounts. No purchase and no outside counterparty — the bank record on both legs is the evidence.";
}

// ── Transaction coding (IRS-grade substantiation) ────────────────────────────
// A CODING is the structured, human-authored, reviewed answer to "what was
// this, why, and who was involved" — the §274(d) substantiation elements a
// receipt alone doesn't carry. One `transactionCodings` row per transaction,
// with its own review lifecycle, orthogonal to `TRANSACTION_STATUSES` (same
// argument that kept receipt exceptions out of that enum) and to
// documentation state. See `docs/plans/transaction-coding.md`.
//
// NO AI ANYWHERE IN THIS FLOW (owner decision, 2026-08-08): every field is the
// spender's own words. The reviewer-side AI budget/category hints that used to
// sit beside this in Reconcile were a different feature, never wrote into a
// coding, and have since been removed outright.

/** Which substantiation fields a coding must carry. NOT a category taxonomy —
 *  funds/categories/budgets own that; this exists ONLY to drive the §274(d)
 *  required-elements branch (travel wants a route, a meal wants who ate). */
export const EXPENSE_TYPES = ["general", "travel", "meal", "lodging"] as const;
export type ExpenseType = (typeof EXPENSE_TYPES)[number];

export const EXPENSE_TYPE_LABELS: Record<ExpenseType, string> = {
  general: "General",
  travel: "Travel",
  meal: "Meal",
  lodging: "Lodging",
};

/** The business-relationship element for a meal attendee — the taxonomy the
 *  public ledger speaks ("5 volunteers, 3 community members, 2 contractors").
 *  Names never publish; these do (owner decision, 2026-08-08). */
export const ATTENDEE_AFFILIATIONS = [
  "team",
  "volunteer",
  "community_member",
  "contractor",
  "guest",
  "other",
] as const;
export type AttendeeAffiliation = (typeof ATTENDEE_AFFILIATIONS)[number];

export const ATTENDEE_AFFILIATION_LABELS: Record<AttendeeAffiliation, string> =
  {
    team: "Team member",
    volunteer: "Volunteer",
    community_member: "Community member",
    contractor: "Contractor",
    guest: "Guest",
    other: "Other",
  };

// A coding's review lifecycle. ONE row per transaction, revised in place — the
// send-back loop ("receipt must show exact amount") is an EDIT conversation,
// not a re-file, so `changes_requested` returns to `submitted` on resubmit.
// Revision history lives in `financeAuditLog` (`coding_submit` per round).
// There is deliberately no server-side `draft`: an unsubmitted coding is
// simply an uncoded transaction.
export const TRANSACTION_CODING_STATUSES = [
  "submitted", // authored + submitted, awaiting review
  "changes_requested", // a reviewer sent it back with a note
  "approved", // stands as this transaction's substantiation of record
] as const;
export type TransactionCodingStatus =
  (typeof TRANSACTION_CODING_STATUSES)[number];

export const TRANSACTION_CODING_STATUS_LABELS: Record<
  TransactionCodingStatus,
  string
> = {
  submitted: "Awaiting review",
  changes_requested: "Changes requested",
  approved: "Approved",
};

/** The business purpose is the sentence behind what the public ledger prints
 *  — "travel to NY to film Eden event", never "bus to NY". Length-floored so a
 *  shrug can't submit; the reviewer is the real quality gate. (What actually
 *  prints is `publishedPurpose` below, which prefers an approver's redacted
 *  rewrite when one exists.) */
export const MIN_PURPOSE_LENGTH = 20;

/**
 * WHAT THE PUBLIC LEDGER PRINTS. The single place that decision lives, so the
 * ledger renderer (a separate scope, not built yet) cannot get it wrong.
 *
 * An approver may write a public-facing version of a coding's purpose —
 * stripping a name or other personal detail out of a sentence that is about to
 * be published. That rewrite is stored SEPARATELY (`publicPurpose`); the
 * author's own `businessPurpose` is retained untouched, because this is
 * substantiation for an IRS accountable plan and what actually happened has to
 * survive. Redaction, not falsification.
 *
 * So: publish the approver's version when there is one, the author's otherwise
 * — and never resolve this at the call site.
 */
export function publishedPurpose(coding: {
  businessPurpose: string;
  publicPurpose?: string | null;
}): string {
  const redacted = coding.publicPurpose?.trim();
  return redacted ? redacted : coding.businessPurpose;
}
/** Same cap + rationale as `MAX_NOTE_LENGTH` — a purpose is a sentence or
 *  three, not a document. */
export const MAX_PURPOSE_LENGTH = 2000;
/** Cap for travel from/to and each attendee name — short identifiers, and the
 *  route publishes at city level. */
export const MAX_CODING_PLACE_LENGTH = 200;

/**
 * HOW MANY CHARGES ONE BULK EXPLANATION MAY COVER
 * (`transactionCodings.submitBulk`).
 *
 * Shared because BOTH halves have to state the same number: the mutation
 * refuses a longer selection, and the bulk sheet has to say so BEFORE somebody
 * writes the sentence. A local copy on either side drifts and then either
 * blocks a legal selection or promises one the server refuses — the same class
 * of client/server disagreement the coding surfaces already have scars from.
 *
 * The value is a Convex transaction budget, not a UI preference. One mutation
 * is one transaction, and each row costs roughly 15 document reads (chapter +
 * finance role re-resolved per row, the existing coding, its receipt
 * exceptions) and 3 writes (the coding, the `codingState` denorm, the audit
 * row). 100 rows ≈ 1,500 reads / 300 writes — comfortably inside the budget,
 * with headroom for a book whose access resolution is heavier than today's.
 *
 * It is REFUSED, never truncated: doing the first 100 of 140 and staying quiet
 * about the rest would hand back "100 applied" while 40 rows the person
 * selected and believed they had done sat untouched.
 */
export const MAX_BULK_EXPLANATION_ROWS = 100;

/**
 * HOW LONG AN APPROVAL MAY BE UNDONE FOR
 * (`transactionCodings.undoApproval`).
 *
 * THE WINDOW IS A SERVER GUARANTEE, not a UI timer. The panel shows a ~10
 * second toast, but a paused tab, a slow render or a client with a stopped
 * clock must not be able to widen it — so the mutation reads the approval's
 * own `decidedAt` and refuses past this, pointing the caller at
 * `requestChanges` (the audited, notified, any-time reopen) instead.
 *
 * Two minutes, deliberately much longer than the toast. The window exists to
 * cover "I hit the wrong button", which is noticed in seconds; the slack is
 * for a slow round trip and for somebody who tapped Undo just as it faded —
 * not for a change of mind an hour later. That is a different act, it means
 * something was actually wrong with the coding, and it should reach the author
 * with a note.
 *
 * Shared so the mobile toast can be pinned BELOW it by a test rather than by
 * hope: a toast outliving the server's window would offer an Undo that
 * refuses.
 */
export const UNDO_APPROVAL_WINDOW_MS = 2 * 60 * 1000;

/** Meal names threshold (owner decision, 2026-08-08): 15 or fewer attendees →
 *  every name + affiliation; more than 15 → headcount + an identifiable group
 *  description ("volunteers writing and producing the album"). A HEADCOUNT
 *  threshold, not a dollar one — a $40 pizza for 16 volunteers gets a
 *  headcount, a $400 dinner for 4 gets four names. Stored as
 *  `financeSettings.mealAttendeeNamesMaxHeadcount`; this is the fallback. */
export const DEFAULT_MEAL_ATTENDEE_NAMES_MAX_HEADCOUNT = 15;

/** Policy start (owner decision, 2026-08-08): coding is REQUIRED — the
 *  reconcile gate refuses `reconciled` on an uncoded row, the `uncoded` facet
 *  counts it, the digest asks for it — for spend posted at/after the day the
 *  policy was ratified, **August 8, 2026 UTC**.
 *
 *  THE REQUIREMENT AND THE CONSEQUENCE ARE TWO DATES, NOT ONE (owner
 *  clarification, 2026-08-09: *"make it live now, but only implement the
 *  non-coded results in personal payments after Sept 1st"*). This constant is
 *  only the requirement. The punitive half — an uncoded charge being billed
 *  back to the cardholder as a personal repayment — has its own later date,
 *  `DEFAULT_CODING_CONVERSION_SINCE_MS`, and both must be satisfied before a
 *  charge can convert. They shipped as ONE constant, which meant "live now"
 *  could not be expressed without also arming the consequence a month early;
 *  splitting them is what lets the ask be honoured exactly.
 *
 *  Grandfathering is unchanged and is the reason this is the ratification date
 *  rather than "everything": spend posted BEFORE it never lights up, so years
 *  of history don't become an overnight backlog. Cleaning up history stays a
 *  deliberate, separate effort (`historicalImportBatch`).
 *
 *  Stored as `financeSettings.codingRequiredSinceMs`; this is the fallback, so
 *  the policy arms itself with no runtime config step. Moving it is a
 *  deliberate central-finance act, not an "off" switch. */
export const DEFAULT_CODING_REQUIRED_SINCE_MS = Date.UTC(2026, 7, 8);

/** The date the CONSEQUENCE arms: **September 1, 2026 UTC** (owner decision,
 *  2026-08-08, preserved verbatim when the requirement moved earlier).
 *
 *  A charge only auto-converts to a personal repayment — real money the
 *  cardholder owes back — when BOTH are true: it owes a coding under
 *  `codingRequiredSinceMs` above, AND it posted at/after this date. Two
 *  independent conditions on purpose. The requirement is a request for an
 *  account of the money and can be live immediately; billing someone is a
 *  consequence, and a consequence applied to spending that happened before
 *  anyone was asked to explain it is a bill nobody could have avoided.
 *
 *  Note the 60-day clock (`DEFAULT_CODING_OVERDUE_DAYS`) runs ON TOP of this,
 *  so the earliest any charge can actually convert is 60 days after the
 *  earliest eligible posting: **October 31, 2026**.
 *
 *  Stored as `financeSettings.codingConversionSinceMs`; this is the fallback,
 *  and — like every date in this family — it is a fallback, not an "off"
 *  switch. Moving it is a deliberate central-finance act. */
export const DEFAULT_CODING_CONVERSION_SINCE_MS = Date.UTC(2026, 8, 1);

/** The accountable-plan substantiation deadline, in days after the charge
 *  posts. 60 days is the IRS safe harbor for substantiating an expense
 *  (Treas. Reg. §1.62-2(g)) — past it, spend nobody has substantiated is,
 *  by law, taxable wages to whoever spent it. So the org's own escalation
 *  ends one step earlier than the law does: at this mark an uncoded charge
 *  auto-converts to a personal repayment (the cardholder owes it back),
 *  which is the "return of excess" condition being met rather than broken.
 *
 *  Stored as `financeSettings.codingOverdueDays`; this is the fallback when
 *  it's unset — deliberately NOT an "off" switch, same posture as the
 *  receipt-exception threshold. */
export const DEFAULT_CODING_OVERDUE_DAYS = 60;

/** True iff a meal of this size must name every attendee (vs. headcount +
 *  group description). Shared by the server guard and the form. */
export function mealNamesRequired(
  headcount: number,
  namesMaxHeadcount: number = DEFAULT_MEAL_ATTENDEE_NAMES_MAX_HEADCOUNT,
): boolean {
  return headcount <= namesMaxHeadcount;
}

/** One meal attendee, in the filer's words. `personId` (a `people` row id,
 *  kept as a plain string here so the shared package stays server-agnostic)
 *  when the typeahead matched; free text for genuine guests. */
export interface CodingAttendee {
  personId?: string;
  name: string;
  affiliation: AttendeeAffiliation;
}

/** The author-editable substance of a coding — what `codingFieldProblems`
 *  validates and what the submit mutation accepts. */
export interface TransactionCodingFields {
  expenseType: ExpenseType;
  businessPurpose: string;
  travelFrom?: string;
  travelTo?: string;
  headcount?: number;
  attendees?: CodingAttendee[];
  groupDescription?: string;
}

export interface CodingProblem {
  /** Stable machine code — the server throws it as a `ConvexError` code. */
  code:
    | "PURPOSE_REQUIRED"
    | "PURPOSE_TOO_LONG"
    | "TRAVEL_ROUTE_REQUIRED"
    | "LODGING_PLACE_REQUIRED"
    | "PLACE_TOO_LONG"
    | "HEADCOUNT_REQUIRED"
    | "ATTENDEES_REQUIRED"
    | "ATTENDEE_COUNT_MISMATCH"
    | "ATTENDEE_NAME_REQUIRED"
    | "ATTENDEES_OVER_THRESHOLD"
    | "GROUP_DESCRIPTION_REQUIRED";
  message: string;
}

/**
 * Every problem with a coding's fields, in display order — the form renders
 * the whole list in place (submit stays disabled until it's empty) and the
 * server throws the FIRST one, so client and server can never disagree about
 * what a complete coding is. Pure, so it's testable and usable from the app
 * without a server round-trip.
 */
export function codingFieldProblems(
  fields: TransactionCodingFields,
  namesMaxHeadcount: number = DEFAULT_MEAL_ATTENDEE_NAMES_MAX_HEADCOUNT,
): CodingProblem[] {
  const problems: CodingProblem[] = [];
  const purpose = fields.businessPurpose.trim();
  if (purpose.length < MIN_PURPOSE_LENGTH) {
    problems.push({
      code: "PURPOSE_REQUIRED",
      message: `Say what this was for and which org work it served — at least ${MIN_PURPOSE_LENGTH} characters. "Travel to NY to film Eden event", not "bus to NY". This description will appear on the public ledger.`,
    });
  } else if (purpose.length > MAX_PURPOSE_LENGTH) {
    problems.push({
      code: "PURPOSE_TOO_LONG",
      message: `Keep the business purpose under ${MAX_PURPOSE_LENGTH} characters.`,
    });
  }

  if (fields.expenseType === "travel") {
    const from = fields.travelFrom?.trim() ?? "";
    const to = fields.travelTo?.trim() ?? "";
    if (!from || !to) {
      problems.push({
        code: "TRAVEL_ROUTE_REQUIRED",
        message:
          "Travel needs a route — where from and where to (city level is enough).",
      });
    } else if (
      from.length > MAX_CODING_PLACE_LENGTH ||
      to.length > MAX_CODING_PLACE_LENGTH
    ) {
      problems.push({
        code: "PLACE_TOO_LONG",
        message: `Keep each place under ${MAX_CODING_PLACE_LENGTH} characters.`,
      });
    }
  } else if (fields.expenseType === "lodging") {
    // FINDING 2 (founder-flagged UX audit, 2026-08-12): lodging used to ask
    // for a ROUTE (from AND to), which makes no sense for a stay — nobody
    // "traveled from" a hotel. It needs exactly ONE place: where you stayed.
    // Persisted in `travelTo` (the same column travel's destination uses, so
    // nothing new on the wire); `travelFrom` is optional/unused for lodging
    // from here on — a historical row that still carries both keeps
    // validating (reading is unaffected; only the REQUIREMENT changed).
    const to = fields.travelTo?.trim() ?? "";
    if (!to) {
      problems.push({
        code: "LODGING_PLACE_REQUIRED",
        message: "An overnight stay needs a place — the city is enough.",
      });
    } else if (to.length > MAX_CODING_PLACE_LENGTH) {
      problems.push({
        code: "PLACE_TOO_LONG",
        message: `Keep the place under ${MAX_CODING_PLACE_LENGTH} characters.`,
      });
    }
  }

  if (fields.expenseType === "meal") {
    const headcount = fields.headcount;
    if (
      headcount == null ||
      !Number.isInteger(headcount) ||
      headcount < 1
    ) {
      problems.push({
        code: "HEADCOUNT_REQUIRED",
        message: "How many people had this meal?",
      });
    } else if (mealNamesRequired(headcount, namesMaxHeadcount)) {
      const attendees = fields.attendees ?? [];
      if (attendees.length === 0) {
        problems.push({
          code: "ATTENDEES_REQUIRED",
          message: `A meal for ${namesMaxHeadcount} or fewer people needs every attendee named, with how they relate to the org — the IRS business-relationship element. Names stay internal; only the breakdown publishes.`,
        });
      } else if (attendees.length !== headcount) {
        problems.push({
          code: "ATTENDEE_COUNT_MISMATCH",
          message: `Headcount says ${headcount} but ${attendees.length} ${attendees.length === 1 ? "person is" : "people are"} listed — ${headcount} people means ${headcount} names.`,
        });
      } else if (
        attendees.some(
          (a) =>
            !a.name.trim() || a.name.trim().length > MAX_CODING_PLACE_LENGTH,
        )
      ) {
        problems.push({
          code: "ATTENDEE_NAME_REQUIRED",
          message: "Every attendee needs a (reasonably short) name.",
        });
      }
    } else {
      // Over the threshold: a group is described, never enumerated — keeps
      // the row bounded and matches the decided policy (names ≤ threshold).
      if ((fields.attendees?.length ?? 0) > 0) {
        problems.push({
          code: "ATTENDEES_OVER_THRESHOLD",
          message: `Over ${namesMaxHeadcount} people, describe the group instead of listing names.`,
        });
      }
      const group = fields.groupDescription?.trim() ?? "";
      if (!group) {
        problems.push({
          code: "GROUP_DESCRIPTION_REQUIRED",
          message:
            'Describe the group so it\'s identifiable — "volunteers writing and producing the album", not "some people".',
        });
      } else if (group.length > MAX_PURPOSE_LENGTH) {
        problems.push({
          code: "PURPOSE_TOO_LONG",
          message: `Keep the group description under ${MAX_PURPOSE_LENGTH} characters.`,
        });
      }
    }
  }

  return problems;
}

/** The affiliation breakdown a coding publishes in place of names —
 *  `{ volunteer: 5, community_member: 3, contractor: 2 }`. */
export function attendeeAffiliationBreakdown(
  attendees: readonly CodingAttendee[],
): Partial<Record<AttendeeAffiliation, number>> {
  const out: Partial<Record<AttendeeAffiliation, number>> = {};
  for (const a of attendees) {
    out[a.affiliation] = (out[a.affiliation] ?? 0) + 1;
  }
  return out;
}

// ── Receipt extraction progress ──────────────────────────────────────────────
/** A receipt's in-flight extraction, as stored on `receipts.extraction` — see
 *  that field's doc in `schema/finances.ts`. */
export interface ReceiptExtractionProgress {
  status: "queued" | "running";
  since: number;
  attempt?: number | null;
  maxAttempts?: number | null;
  nextAttemptAt?: number | null;
}

/** How long a `running` extraction may go unfinished before readers stop
 *  believing it. Generous: a scanned multi-page PDF render plus a slow vision
 *  call is minutes, not seconds. Past this, a lost scheduled function is the
 *  likelier explanation than a still-working one, and a spinner that never
 *  stops is worse than none. */
export const RECEIPT_EXTRACTION_STALE_MS = 10 * 60_000;
/** Same idea for a `queued` attempt: the fire time came and went this long
 *  ago and nothing ever moved to `running`. */
export const RECEIPT_EXTRACTION_QUEUE_STALE_MS = 10 * 60_000;

/**
 * True iff this extraction should still be shown as in-progress. The stored
 * value is cleared by both commit mutations, so a stale one means the
 * scheduled work never landed — never leave a receipt spinning on it.
 */
export function isReceiptExtractionActive(
  extraction: ReceiptExtractionProgress | null | undefined,
  now: number,
): boolean {
  if (!extraction) return false;
  if (extraction.status === "running") {
    return now - extraction.since < RECEIPT_EXTRACTION_STALE_MS;
  }
  const dueAt = extraction.nextAttemptAt ?? extraction.since;
  return now - dueAt < RECEIPT_EXTRACTION_QUEUE_STALE_MS;
}

/**
 * The 0..1 fill for a progress bar over this extraction — determinate while
 * an attempt is QUEUED (the wait has a known end), and an elapsed-time creep
 * that asymptotes below full while one is RUNNING (the read has no honest
 * percentage, and a bar that sits at 100% while nothing has happened is a
 * lie). Never returns 1: the bar completing is what the row updating means.
 */
export function receiptExtractionFraction(
  extraction: ReceiptExtractionProgress | null | undefined,
  now: number,
): number {
  if (!extraction) return 0;
  if (extraction.status === "queued" && extraction.nextAttemptAt != null) {
    const total = Math.max(1, extraction.nextAttemptAt - extraction.since);
    return Math.max(0, Math.min(0.95, (now - extraction.since) / total));
  }
  // A typical vision read lands in ~15s; creep toward (never to) full.
  const elapsed = Math.max(0, now - extraction.since);
  return Math.min(0.9, elapsed / 15_000);
}

// Flows that DON'T count toward category / budget spend. A `transfer` is money
// MOVING (chapter ↔ central skims/grants/settlements, a personal-charge
// repayment netting its own charge, or an INTERNAL BANK TRANSFER a bookkeeper
// marked in Reconcile — see `PAYOUT_PROCESSORS` below for the case that is
// deliberately NOT this) — both legs exist in the ledger, so counting either as
// spend would double-count real expenses that are already booked elsewhere.
//
// NOT in here: a reimbursement payout. That money leaves the org for a
// purchase someone made out of pocket, and no other row books it, so it posts
// as a plain `outflow` (see `increase.ts#postReimbursementSpend`).
export const NON_SPEND_FLOWS: readonly TransactionFlow[] = ["transfer"];

/** True iff a transaction's flow counts toward category/budget spend. */
export function countsAsSpend(flow: TransactionFlow): boolean {
  return !NON_SPEND_FLOWS.includes(flow);
}

// ── Processor payouts ────────────────────────────────────────────────────────
// A settlement deposit from a donation processor: Givebutter/Stripe batch the
// donations they collected and wire the net to the bank, so ONE inflow lands
// covering many gifts.
//
// A payout is NOT an internal transfer, and marking one must never set
// `flow:"transfer"` — a transfer is money between two of the org's own
// accounts, and this money arrived from outside. A marked payout stays a
// plain `inflow` and gains a `payoutProcessor` LABEL saying where it came
// from.
//
// WHAT THE LABEL MEANS FOR BOOK VALUE (model revised 2026-08-07, founder):
// the org counts its revenue at the GIVING layer — `gifts` (every donation
// channel dual-writes there) plus paid ticket orders — and the accounts
// page's book value is that revenue minus the reconcile ledger's spend
// (`apps/convex/lib/bookBalance.ts`). A LABELED payout deposit is therefore
// the arrival of already-counted revenue and contributes ZERO to book value;
// an UNMARKED deposit still counts as plain inflow (and double-counts
// against its gifts) until a human marks it — marking is the fix, and the
// morning engine marks Stripe's automatically. The label also still matters
// to spend/rollup surfaces exactly as before: the row is income-shaped, not
// a transfer, and stays out of no ledger total.
export const PAYOUT_PROCESSORS = ["givebutter", "stripe", "other"] as const;
export type PayoutProcessor = (typeof PAYOUT_PROCESSORS)[number];

export const PAYOUT_PROCESSOR_LABELS: Record<PayoutProcessor, string> = {
  givebutter: "Givebutter",
  stripe: "Stripe",
  other: "Other processor",
};

// ── Morning reconciliation engine ────────────────────────────────────────────
// The daily engine (`apps/convex/reconciliation.ts`) books central↔chapter
// transfer pairs AUTOMATICALLY for two well-defined reasons, and stamps each
// pair's legs with `transactions.transferOrigin` so every reader can tell an
// engine-booked pair from a human-recorded one. ABSENT = a manual transfer
// (every pre-engine row, and every `recordTransfer` the finance desk records
// by hand). The two origins are deliberately excluded from the City Launch
// Fund position (they're revenue distribution / cash true-up, not
// skims/grants), and `payout_allocation` pairs are excluded from
// `interScopeBalances`' settling legs (they distribute revenue; they don't pay
// down a card-spend imbalance — `auto_settlement` pairs are what do that).
export const AUTO_TRANSFER_ORIGINS = [
  // A chapter's share of a Stripe payout that landed in central's bank
  // account: donations, ticket sales, and gifts that belong to a chapter's
  // book, net of Stripe's fees. Direction is central→chapter (or
  // chapter→central when refunds outweigh revenue in a payout).
  "payout_allocation",
  // The daily true-up of `interScopeBalances` — cross-book card spend ("your
  // card determines whose account paid; reconcile determines whose budget it
  // was") settled by the engine instead of waiting for a human to record it.
  "auto_settlement",
  // The daily true-up of a chapter's CASH against its BOOK. Every payout lands
  // in central's account, so central holds money the chapters have earned; this
  // moves each chapter the difference between what its book says it's worth and
  // what its bank actually holds.
  //
  // It replaced `payout_allocation` (founder decision, 2026-08-08). Attributing
  // a payout per-chapter meant tracing every balance transaction back to the
  // record that earned it — fragile (it fails outright on manually-initiated
  // payouts, which Stripe won't itemise), impossible for Givebutter (no API),
  // and redundant, because gifts, ticket orders and sales are already
  // chapter-scoped before a payout exists. The allocation legs also contributed
  // ZERO to book value, so all that machinery made no number correct.
  "balance_settlement",
] as const;
export type AutoTransferOrigin = (typeof AUTO_TRANSFER_ORIGINS)[number];

// -- Non-discretionary fee origins -------------------------------------------
// A per-transaction cut taken by a payment rail — CHARGED, never chosen.
//
// A budget is a control on choice. These aren't choices: the fee is
// mechanically a percentage of money the org already decided to accept, and it
// cannot be declined without declining the gift. So a `transactions` row
// carrying one of these is never asked which budget it belongs to
// (`finances.ts#needsBudget`). It stays spend everywhere else — the money left.
//
// SCOPE IS THE PER-PAYMENT CUT, and nothing wider. A monthly platform
// subscription, a paid Givebutter tier, an accounting service: those are real
// decisions somebody makes, and they stay budgeted even when they book to the
// same "Bank & Fees" category. The exemption is by ORIGIN, never by category.
export const NON_DISCRETIONARY_FEE_ORIGINS = [
  // Stripe's cut, swept from its balance-transaction ledger by
  // `processorFees.ts` — both the per-payment fee and the fees Stripe bills on
  // its own account (Terminal readers, payout and account fees).
  "stripe_processing",
  // Cash App's 2.6% + $0.15, reconstructed per payment by a 2026-08 backfill
  // (a one-off since removed).
  "cash_app_processing",
  // Givebutter's cut, swept from `amount - payout` per transaction by
  // `processorFees.ts`. Only ever non-zero where the giver did NOT cover the
  // fee — on this deployment that is one transaction in 263.
  "givebutter_processing",
] as const;
export type NonDiscretionaryFeeOrigin =
  (typeof NON_DISCRETIONARY_FEE_ORIGINS)[number];

// There was a NON_DISCRETIONARY_FEE_ORIGIN_LABELS map here. It had no readers
// anywhere in the repo, and the strings it held were a second copy of
// `processorFees.ts#FEE_RAIL`'s `description` — which is what actually names a
// fee row. Two places to spell "Givebutter processing fees" is one too many on
// a money path, so the one nothing read is gone rather than grown a third entry.

export const AUTO_TRANSFER_ORIGIN_LABELS: Record<AutoTransferOrigin, string> = {
  payout_allocation: "Payout allocation",
  balance_settlement: "Balance settlement",
  auto_settlement: "Auto settlement",
};

// Our processing state for one detected Stripe payout (NOT Stripe's own payout
// status, which is stored alongside as `stripeStatus`).
//
// ALL THREE VALUES ARE NOW HISTORY. They described the per-payout ALLOCATION
// step — itemise the payout at Stripe, work out each chapter's share, book a
// transfer pair — which #553 removed. Chapter attribution comes from the
// revenue layer instead, and a payout's only remaining job is to find and label
// its bank deposit (`stripePayouts.matchedTransactionId`).
//
// The values are kept so existing rows still validate, and nothing writes
// "failed" any more. The accounts page deliberately does NOT render them: it
// badges a payout from Stripe's own status plus whether the deposit was
// labelled, which are the two facts that still mean something. Reading a stored
// "failed" as a live problem is exactly the false alarm this comment exists to
// prevent — see `stripePayouts.automatic` in the schema for the one real case.
//  - pending   → detected (the state every new payout is written in)
//  - allocated → historical: its per-scope breakdown was computed pre-#553
//  - failed    → historical: allocation errored pre-#553. Obsolete, and healed
//                back to "pending" the next time the engine sees the payout.
export const STRIPE_PAYOUT_PROCESS_STATES = [
  "pending",
  "allocated",
  "failed",
] as const;
export type StripePayoutProcessState =
  (typeof STRIPE_PAYOUT_PROCESS_STATES)[number];

/**
 * Plain-English names for Increase's Pending Transaction categories — what the
 * "Pending" column on the accounts page is actually made of.
 *
 * Only the categories this org can plausibly produce are named; anything else
 * falls back to the raw category with underscores stripped, so a category
 * Increase adds tomorrow still renders as words rather than disappearing.
 * Deliberately describes the MONEY, not the API object: "Waiting on an
 * inbound ACH to clear" tells a treasurer what to do with the number, where
 * "inbound_funds_hold" does not.
 */
export const INCREASE_PENDING_CATEGORY_LABELS: Record<string, string> = {
  card_authorization: "Card spend, not yet settled",
  ach_transfer_instruction: "ACH payment on its way out",
  check_transfer_instruction: "Check sent, not yet cashed",
  wire_transfer_instruction: "Wire on its way out",
  real_time_payments_transfer_instruction: "Instant payment on its way out",
  fednow_transfer_instruction: "Instant payment on its way out",
  account_transfer_instruction: "Moving between our own accounts",
  check_deposit_instruction: "Check deposited, not yet cleared",
  inbound_funds_hold: "Money in, held until it can't be clawed back",
  inbound_wire_transfer_reversal: "Inbound wire being reversed",
  user_initiated_hold: "Held on purpose by us",
  card_push_transfer_instruction: "Push-to-card payment on its way out",
  other: "Other",
};

/** `card_authorization` → "Card spend, not yet settled"; unknown → "Inbound
 *  funds hold"-style title case of whatever Increase sent. */
export function increasePendingCategoryLabel(category: string): string {
  const known = INCREASE_PENDING_CATEGORY_LABELS[category];
  if (known) return known;
  const words = category.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// How one payout item (one Stripe balance transaction) was attributed to a
// book. `unmapped` is the loud bucket: money we could not trace to an order /
// donation / gift / repayment stays on central's book and is surfaced for the
// Financial Manager instead of being silently absorbed.
export const PAYOUT_ITEM_KINDS = [
  "ticket_order", // a paid ticket order (maps via session metadata.orderId)
  "event_donation", // an event-page donation (metadata.donationId)
  "give_donation", // a one-time /give gift (gifts.by_externalRef "give:<session>")
  "pledge_cycle", // a backer subscription cycle (charge.invoice → gifts.by_stripeInvoice)
  "repayment", // a personal-charge repayment (metadata.repaymentIds) — cash
  // returning to the org; the chapter's book was already credited at settle
  // (`cards.ts`), so the engine books NO allocation transfer for these.
  "refund", // a refund of any of the above (negative, netted against its scope)
  "unmapped", // couldn't be traced — stays central, surfaced loudly
] as const;
export type PayoutItemKind = (typeof PAYOUT_ITEM_KINDS)[number];

// A Financial Manager's audit flag on an engine artifact (a transfer pair or a
// detected payout): "this needs a human decision." Resolution is a note — the
// ledger fix itself is an offsetting entry per docs/plans/transfers-ops-notes.md.
export const RECONCILIATION_FLAG_KINDS = ["transfer", "payout"] as const;
export type ReconciliationFlagKind = (typeof RECONCILIATION_FLAG_KINDS)[number];

export const RECONCILIATION_FLAG_STATUSES = ["open", "resolved"] as const;
export type ReconciliationFlagStatus =
  (typeof RECONCILIATION_FLAG_STATUSES)[number];

// ── Reimbursements ───────────────────────────────────────────────────────────
// Public-form submissions (accountless, secret token). Optional pre-approval
// gate, then the approval → payout lifecycle. Terminal: paid / rejected /
// failed / canceled.
export const REIMBURSEMENT_STATUSES = [
  "pending_preapproval",
  "preapproved",
  "submitted",
  // A reviewer sent it BACK for revision rather than killing it —
  // "receipt must show exact amount", "say which event this served". The
  // claimant edits their lines and resubmits (→ `submitted` again).
  // Deliberately distinct from `rejected`, which reads as final and is: a
  // rejected request is over, while most real review outcomes are "almost —
  // fix this one thing." Without this state the only send-back was a
  // rejection, which taught claimants that review meant losing their money
  // (see `docs/plans/transaction-coding.md`, phase 3).
  "changes_requested",
  "approved",
  "paying",
  "paid",
  "rejected",
  "failed",
  "canceled",
] as const;
export type ReimbursementStatus = (typeof REIMBURSEMENT_STATUSES)[number];

export const REIMBURSEMENT_STATUS_LABELS: Record<ReimbursementStatus, string> = {
  pending_preapproval: "Pending pre-approval",
  preapproved: "Pre-approved",
  submitted: "Submitted",
  changes_requested: "Changes requested",
  approved: "Approved",
  paying: "Paying",
  paid: "Paid",
  rejected: "Rejected",
  failed: "Failed",
  canceled: "Canceled",
};

/** Statuses at which a reimbursement is finished (no further transitions). */
export const REIMBURSEMENT_TERMINAL_STATUSES: readonly ReimbursementStatus[] = [
  "paid",
  "rejected",
  "canceled",
];

// ── Cards (person-owned) ─────────────────────────────────────────────────────
export const CARD_TYPES = ["virtual", "physical"] as const;
export type CardType = (typeof CARD_TYPES)[number];

export const CARD_STATUSES = ["active", "locked", "canceled"] as const;
export type CardStatus = (typeof CARD_STATUSES)[number];

// Where a card came from. A NATIVE card is issued on Increase (`increase`, the
// default when the marker is absent); a LEGACY card is an external/Relay card
// linked by its last-4 (no Increase object) so its transactions can be
// attributed to a person. Legacy cards carry no Increase controls.
export const CARD_SOURCES = ["increase", "legacy"] as const;
export type CardSource = (typeof CARD_SOURCES)[number];

/** Late-receipt auto-lock window: a card locks if a receipt is >7 days late. */
export const RECEIPT_GRACE_DAYS = 7;

/** Escalation checkpoint ahead of the day-7 auto-lock: a card charge still
 *  missing its receipt past this many days gets nudged harder (a "day-3"
 *  reminder timeline stage + email), before the terminal auto-lock at
 *  `RECEIPT_GRACE_DAYS`. */
export const RECEIPT_ESCALATE_DAYS = 3;

/** R1a — a transaction note is a short "who/why" justification, not a
 *  document: capped so a runaway paste can't bloat the row. Shared by
 *  `finances.setTransactionNote` (server-side enforcement) and
 *  `TransactionNoteModal` (the `TextField`'s `maxLength`) so the two never
 *  drift apart. */
export const MAX_NOTE_LENGTH = 2000;

// ── Merchant display name (the bookkeeper's readable rename) ─────────────────
/**
 * A bank feed's merchant string is a machine artifact, not a name a human
 * would use — `IC* COSTCO BY IN CAR`, `AMAZON MKTPL*56OXD2TB2`,
 * `Purchase from AMAZON.COM*569A3 | Address: SEATTLE, WA, US | **8728`. A
 * bookkeeper needs to call the row what it actually was.
 *
 * THE RENAME IS A SEPARATE FIELD, NEVER AN OVERWRITE. `transactions.
 * merchantName` and `.description` are the provider's own claim about money
 * that moved; they are provenance and it is not ours to destroy. An auditor
 * asking "what did the statement say" must always be able to get the original
 * back, and no rename may be able to launder a row into looking like something
 * else. So the human name lives in `transactions.merchantNameOverride`, every
 * reader resolves it through `displayMerchantName` below, and un-naming a row
 * is simply clearing the override — the history is intact BY CONSTRUCTION
 * rather than by discipline.
 *
 * Capped for the same reason `MAX_NOTE_LENGTH` is (a runaway paste must not
 * bloat a row); shorter, because this is a label rendered in one grid cell.
 * Shared by `finances.renameMerchant` (server-side enforcement) and the
 * mobile editor's `maxLength` so the two can never drift apart.
 */
export const MAX_MERCHANT_NAME_LENGTH = 120;

/** The provider-sourced strings a display name is resolved from, plus the
 *  bookkeeper's override. Structural so any projection carrying these fields
 *  can be passed straight in. */
export interface MerchantNameSource {
  /** The bookkeeper's readable rename. Null/undefined when never renamed (or
   *  cleared), which is when the provider's own value shows through. */
  merchantNameOverride?: string | null;
  /** The provider's merchant string. NEVER written by a rename. */
  merchantName?: string | null;
  /** The provider's (or the reconciliation engine's) description. Also never
   *  written by a rename — see `renameMerchant`'s doc comment on why an
   *  engine-written sentence keeps showing here after a row is renamed. */
  description?: string | null;
  /** `transactions.payoutProcessor` — set once a deposit is MARKED as a
   *  processor settlement (`finances.markAsPayout`, or the morning engine for
   *  Stripe). Optional so a projection that doesn't carry it keeps the plain
   *  provider chain; see `displayMerchantName` for what it changes. */
  payoutProcessor?: PayoutProcessor | null;
}

/**
 * WHAT A MARKED PAYOUT ROW IS CALLED — "Stripe payout", "Givebutter payout",
 * "Processor payout".
 *
 * Not a new convention: this is the phrase `markAsPayout` already writes into
 * the allocation leg's note ("Stripe payout allocated to Central"), built from
 * the same {@link PAYOUT_PROCESSOR_LABELS} the row's own badge renders. "Other
 * processor" is special-cased because "Other processor payout" reads as a
 * different processor rather than an unnamed one.
 */
export function payoutRowName(processor: PayoutProcessor): string {
  return processor === "other"
    ? "Processor payout"
    : `${PAYOUT_PROCESSOR_LABELS[processor]} payout`;
}

/**
 * What to SHOW in a merchant slot: the bookkeeper's rename if there is one,
 * then — on a MARKED PAYOUT — what the row actually is, else the provider's
 * merchant string, else its description, else `fallback`.
 *
 * The provider fallback chain is exactly what every merchant-rendering call
 * site already did by hand (`merchantName ?? description ?? "…"`); the only
 * new thing in front of it is the override. Centralized so "renamed rows show
 * their new name" is one decision rather than one decision per screen.
 *
 * ── WHY A PAYOUT OUTRANKS THE PROVIDER STRING ────────────────────────────────
 * Founder, 2026-08-14: *"Stripe payouts still have my name — the merchant is
 * being called Oluseyi Olujide as a default… I know I'm the one that initiated
 * the payout, but come on, that can't mean I'm the merchant."*
 *
 * Nothing in this app ever wrote that name. A Stripe payout arrives as an
 * inbound ACH credit, and the bank feed hands us the ORIGINATOR as the
 * counterparty — `originator_company_name` / `originator_name` on Increase's
 * `inbound_ach_transfer` (`lib/increaseExtract.ts`), the statement string on
 * the Relay/FC feeds. For a Stripe account whose payouts originate under the
 * account holder rather than a company descriptor, that string is a PERSON'S
 * NAME. It is a true record of what the statement said and a false answer to
 * "who is the merchant on this row", because a payout has no merchant: it is
 * the processor handing over money the org already earned.
 *
 * So this is fixed HERE, at the display layer, and deliberately not by
 * rewriting the row. `merchantName` is the provider's own claim and this
 * module's opening comment forbids destroying it ("an auditor asking 'what did
 * the statement say' must always be able to get the original back"); the
 * `payoutProcessor` marking is also reversible, and `unmarkPayout` has to
 * restore the bank's own string without a second write. Un-naming stays
 * "clear the override", provenance stays intact BY CONSTRUCTION, and
 * {@link providerMerchantName} — the rename editor and the audit trail — still
 * reports exactly what the bank said.
 *
 * THE RENAME STILL WINS. A bookkeeper who typed a name over a payout row meant
 * it; this only replaces the string nobody chose.
 */
/**
 * Strip the STRUCTURAL noise a card descriptor carries without touching the
 * merchant's identity: "Purchase from GIVEBUTTER | Address: GIVEBUTTER.CO,
 * DE, US | **9370" is one merchant and two pieces of metadata the row already
 * shows elsewhere (the address is noise, the card suffix renders in the
 * subtitle). Only the recognized structured shapes are cleaned — a plain
 * bank string like "IC* COSTCO BY IN CAR" passes through verbatim, because
 * rewriting free-form provider text is what renames are for (owner report,
 * 2026-08-11: rows reading "Purchase from X | Address: …" made the coding
 * list "look so bad").
 */
function cleanCardDescriptor(name: string): string {
  let out = name.trim();
  const purchase = /^purchase from\s+(.+)$/i.exec(out);
  if (purchase) out = purchase[1];
  const parts = out.split("|").map((p) => p.trim());
  const kept = parts.filter(
    (p, i) =>
      i === 0 || !(/^address:/i.test(p) || /^\*+\s*\d{2,4}$/.test(p)),
  );
  const cleaned = kept.join(" | ").trim();
  return cleaned || name;
}

export function displayMerchantName(
  row: MerchantNameSource,
  fallback = "Unlabeled charge",
): string {
  if (row.merchantNameOverride != null) return row.merchantNameOverride;
  if (row.payoutProcessor != null) return payoutRowName(row.payoutProcessor);
  if (row.merchantName != null) return cleanCardDescriptor(row.merchantName);
  return row.description ?? fallback;
}

/**
 * The RAW bank/processor description, worth showing BENEATH the cleaned
 * merchant name — but only when it says something the clean name doesn't
 * already say. `null` when there's nothing raw to show, or it would just
 * repeat the clean name verbatim.
 *
 * FINDING 5 (UX audit, 2026-08-12): "the raw bank line dropped when the
 * panel opens" — a coder who only ever sees "Amazon" loses the "AMAZON
 * MKTPL*56OXD2TB2" the actual charge carried, which is sometimes the only
 * way to tell two same-named purchases apart, or to recognize a charge the
 * cleaned name obscures entirely.
 */
export function rawBankLine(row: MerchantNameSource): string | null {
  const raw = row.description?.trim();
  if (!raw) return null;
  const clean = displayMerchantName(row, "").trim();
  if (!clean || raw === clean) return null;
  return raw;
}

/**
 * The provider's own name for a row, ignoring any rename AND ignoring the
 * payout label {@link displayMerchantName} puts in front of it — what the
 * statement says, full stop. Used by the rename editor (to show what is being
 * renamed FROM) and by the audit trail's `before` on a first rename, so the
 * trail's opening line is always the original rather than "—".
 */
export function providerMerchantName(
  row: MerchantNameSource,
  fallback = "Unlabeled charge",
): string {
  return row.merchantName ?? row.description ?? fallback;
}

// ── Naming a book-value row ─────────────────────────────────────────────────
/** Everything the title chain and the rail name are resolved from. */
export interface BookValueRowLabelSource extends MerchantNameSource {
  /** The bookkeeper's freeform "who was this for and why". */
  note?: string | null;
  /** `transactions.source` — the rail. */
  source: string;
  /** `transactions.transferOrigin`, when the engine wrote the row. */
  transferOrigin?: string | null;
}

/**
 * WHICH RAIL CARRIED THE ROW, for a row that may be an engine transfer.
 *
 * An engine-written leg names the engine STEP it came from ("Auto
 * settlement"), because its `source` is the generic `"transfer"` every one of
 * them carries and that says nothing about why the row exists.
 *
 * Here rather than in the mobile screen because the SERVER names rows too —
 * the "same amount, same day" members are labelled in the query — and the two
 * paths disagreeing means one settlement row reads "Auto settlement" on one
 * tab and "Recorded transfer" on the next.
 */
export function bookValueRailLabel(row: BookValueRowLabelSource): string {
  const origin = row.transferOrigin;
  if (origin && origin in AUTO_TRANSFER_ORIGIN_LABELS) {
    return AUTO_TRANSFER_ORIGIN_LABELS[origin as AutoTransferOrigin];
  }
  return transactionSourceLabel(row.source);
}

/**
 * WHAT THIS ROW IS, in the order a reader would accept an answer: the
 * bookkeeper's rename, then the provider's own strings, then the bookkeeper's
 * note, and only then a generic that at least names the rail.
 *
 * NOT `displayMerchantName` with a fallback. That chains on `??`, and a
 * projection that normalizes `description` to `""` (both book-value queries
 * do, so the field can be a plain `v.string()`) makes the empty string a
 * "value" — the fallback becomes unreachable and an unlabeled row renders as
 * nothing at all. That is exactly the bug this whole area exists to fix, so
 * every candidate here is TRIMMED and an empty one is not an answer.
 */
export function bookValueLineTitle(row: BookValueRowLabelSource): string {
  return (
    firstNonBlank(row.merchantNameOverride, row.merchantName, row.description, row.note) ??
    `Unlabeled ${bookValueRailLabel(row).toLowerCase()} row`
  );
}

/** True when `bookValueLineTitle` fell back to the note, so a caller doesn't
 *  print the same sentence twice. */
export function bookValueTitleUsedNote(row: BookValueRowLabelSource): boolean {
  return (
    firstNonBlank(row.merchantNameOverride, row.merchantName, row.description) == null &&
    firstNonBlank(row.note) != null
  );
}

function firstNonBlank(...values: (string | null | undefined)[]): string | null {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

// ── Card requests (WP-C.1: request-a-card) ──────────────────────────────────
// A member's request for a card, decided by an FM/Treasurer (never self-serve).
// "requested" is the only OPEN state — a person may hold at most one at a time
// (`cards.requestCard` enforces it). Terminal: "approved" (issues the card via
// the existing `issueCard` flow) or "denied".
export const CARD_REQUEST_STATUSES = ["requested", "approved", "denied"] as const;
export type CardRequestStatus = (typeof CARD_REQUEST_STATUSES)[number];

// ── Card eligibility + last-4 extraction ─────────────────────────────────────
// Cards (native + legacy) are restricted to Public Worship staff — people with
// an `@publicworship.life` email. `isCardEligible` is the single gate the card
// pickers + issuance/link mutations share so the rule can't drift.

/** True iff a Public Worship email makes a person eligible to hold a card. */
export function isCardEligible(pwEmail?: string | null): boolean {
  return (
    !!pwEmail && pwEmail.trim().toLowerCase().endsWith("@publicworship.life")
  );
}

/**
 * Parse a card's last-4 out of a synced transaction description. FC-synced rows
 * carry the card only inside the merchant/description string (e.g.
 * `"POS PURCHASE … | **2702"`) — there's no structured field. Matches the
 * `**NNNN` masked-card pattern and returns the LAST (trailing) 4-digit group,
 * which is where the card number sits when a description holds several numbers.
 * Returns null when no masked last-4 is present.
 */
export function extractCardLast4(text?: string | null): string | null {
  if (!text) return null;
  const re = /\*{2,}\s*(\d{4})(?!\d)/g;
  let last: string | null = null;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    last = match[1];
  }
  return last;
}

// ── Relay statement CSV import ────────────────────────────────────────────────
/**
 * Parse a Relay monthly-statement `Reference` string into its cardholder
 * attribution. A CARD charge's reference is
 * `"<Person Name> - <last4> (<Card Name>)"`
 * (e.g. `"Oluseyi Olujide - 2702 (Seyi's PW Card)"`) — the last-4 + trailing
 * `(Card Name)` are the tell. A PAYOUT/transfer reference is
 * `"<recipient> - <memo> - Sent By <person>"` with NO ` - <digits> (…)` tail, so
 * it never matches and returns `null` (no card attribution — Relay payouts are
 * non-card money movements).
 *
 * Returns `{ personName, cardLast4, cardName }` for a card charge, or `null` for
 * a payout-style / unparseable reference. `person` is non-greedy so a hyphenated
 * name (`"Agujudah Okey-Uche - 2588 (AJ's Card)"`) still splits at the ` - NNNN `
 * boundary, not the intra-name hyphen (which carries no surrounding spaces).
 */
export function parseRelayReference(
  ref?: string | null,
): { personName?: string; cardLast4?: string; cardName?: string } | null {
  if (!ref) return null;
  const match = ref.trim().match(/^(.+?)\s+-\s+(\d{3,4})\s+\((.+)\)\s*$/);
  if (!match) return null;
  return {
    personName: match[1].trim(),
    cardLast4: match[2],
    cardName: match[3].trim(),
  };
}

// ── Personal-charge repayment ────────────────────────────────────────────────
export const REPAYMENT_METHODS = ["card", "ach"] as const;

/**
 * How long a reminder about an outstanding personal charge silences the next
 * one (`cards.nudgeOutstandingRepayments`).
 *
 * The number is a JUDGEMENT about tone, not a technical limit. These are
 * volunteers who put a $14 coffee run on the wrong card, not delinquent
 * accounts; a reminder every three days reads as help, and a reminder every
 * day reads as an accusation. Three days also means a manager who presses
 * "Send reminders" twice in one sitting — the single likeliest misuse — sends
 * one email, not two.
 */
export const REPAYMENT_NUDGE_COOLDOWN_DAYS = 3;
export const REPAYMENT_NUDGE_COOLDOWN_MS =
  REPAYMENT_NUDGE_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
export type RepaymentMethod = (typeof REPAYMENT_METHODS)[number];

/**
 * `processing` (added 2026-08-14 with the Stripe ACH repayment rail) is the
 * state a bank debit sits in for the ~4 business days between the payer
 * authorising it and the money arriving. It is deliberately NOT `paid`: a
 * debit can be refused, and marking the debt settled on authorisation would
 * clear a flag against money that may never exist — the exact class of bug the
 * giving side already refuses to ship (`http.ts#checkoutSessionHasSettled`).
 *
 * It is also not `pending`, which would be worse in the other direction: a
 * payer looking at a charge they authorised yesterday, still reading "you owe
 * this", pays it a second time.
 *
 * `personalExpenseState` treats it as UNPAID, alongside `pending` and
 * `failed` — the debt is genuinely still outstanding until the bank says
 * otherwise, and only a `paid` repayment reads as reimbursed.
 */
export const REPAYMENT_STATUSES = [
  "pending",
  "processing",
  "paid",
  "failed",
] as const;
export type RepaymentStatus = (typeof REPAYMENT_STATUSES)[number];

/** Outstanding: the payer still owes this. Everything that isn't settled —
 *  never authored as `!== "paid"` at a call site, so a status added to the
 *  union above has to be classified here rather than silently reading as
 *  outstanding (or, worse, as settled). */
export function isRepaymentOutstanding(status: RepaymentStatus): boolean {
  return status !== "paid";
}

/** In flight through a rail: authorised, not yet arrived. The payer should be
 *  told to wait rather than invited to pay again. */
export function isRepaymentInFlight(status: RepaymentStatus): boolean {
  return status === "processing";
}

// ── Personal expense state (derived — deliberately NOT a persisted field) ───
// Founder ask: mark a charge as a personal expense / needing repayment,
// separate from `status` — a discarded earlier attempt added a 5th
// TRANSACTION_STATUS for this and was rejected, because a transaction must be
// able to be BOTH `"reconciled"` AND an unpaid personal expense at the same
// time, which one status column can't represent.
//
// DESIGN CALL: no new persisted field either. `transactions.isPersonal`
// (boolean) already existed as the ONE thing `finances.ts#isSpend` excludes
// on. Adding a second "is this personal" field next to it would recreate the
// exact two-representations-that-can-drift trap this design had to avoid —
// imagine a write that sets one but not the other, or a migration that misses
// a legacy row. Instead the full 3-state lifecycle (not-personal → personal &
// unpaid → reimbursed) is DERIVED from two fields that are already written
// together, atomically, by the ONE code path that ever changes either
// (`cards.ts#convertChargeToPersonalRepayment`): `transactions.isPersonal`
// and the linked `personalRepayments` row's `status`
// (`transactions.repaymentId` → `personalRepayments.status`). Because there is
// no second writer, this derived state can never disagree with `isPersonal` —
// see the invariant test in `finances.personalExpenseState.test.ts`.
export const PERSONAL_EXPENSE_STATES = [
  "not_personal",
  "personal_unpaid",
  "personal_reimbursed",
] as const;
export type PersonalExpenseState = (typeof PERSONAL_EXPENSE_STATES)[number];

/**
 * Derive a transaction's personal-expense lifecycle state from its
 * `isPersonal` flag and its linked repayment's status (`null`/`undefined`
 * when unflagged, or a flagged row whose repayment can't be resolved). A
 * `"failed"` repayment attempt still reads as `"personal_unpaid"` — the debt
 * stays outstanding either way; only `"paid"` clears it. So does
 * `"processing"`, an ACH debit still clearing: the payer has authorised it and
 * the money has not arrived, and a ledger that called that reimbursed would be
 * describing money the org does not have.
 */
export function personalExpenseState(
  isPersonal: boolean | null | undefined,
  repaymentStatus: RepaymentStatus | null | undefined,
): PersonalExpenseState {
  if (isPersonal !== true) return "not_personal";
  return repaymentStatus === "paid" ? "personal_reimbursed" : "personal_unpaid";
}

/**
 * MAY A ROW IN THIS PERSONAL-EXPENSE STATE BE CLOSED? — the policy half of the
 * pair above, kept next to it so the state and the rule about the state are
 * read together.
 *
 * Founder ask, 2026-08-13: "make sure to have business logic so that no rows
 * that are personal expenses that need to be repaid can be closed." A charge
 * somebody still owes the org money for is not a finished piece of
 * bookkeeping — closing it says the treasurer is done with it, and it isn't
 * done until the money comes back or the flag comes off.
 *
 * ## THIS DOES NOT CONTRADICT THE `PERSONAL_EXPENSE_STATES` DECISION ABOVE
 *
 * The block above records why personal state is DERIVED from two fields
 * instead of being a 5th `TRANSACTION_STATUS`: "a transaction must be able to
 * be BOTH `reconciled` AND an unpaid personal expense at the same time, which
 * one status column can't represent." That is an argument about
 * REPRESENTATION — what the data model has to be able to say — and it still
 * stands, unchanged and load-bearing:
 *
 *  - A row CLOSED FIRST and flagged personal AFTERWARDS is genuinely both, and
 *    stays expressible. Nothing here rewrites it, re-opens it, or invalidates
 *    it: `personalExpenseState` still returns `personal_unpaid` for a
 *    `reconciled` row, every read path still renders that pair, and the
 *    legacy rows already in it are untouched.
 *  - What this adds is a guard on ONE TRANSITION — going TO `reconciled`
 *    while unpaid. A transition rule is not an invariant. An invariant would
 *    say the pair may never exist, which would collapse the representation
 *    the block above deliberately kept (and would need a migration that
 *    rewrote real history).
 *
 * So: never author this as `state !== "personal_unpaid"` at a call site, and
 * never let it grow into a read-path filter. It answers exactly one question,
 * asked in exactly one place — `finances.ts#requireRepaidBeforeClose`, called
 * from `setTransactionStatus`.
 */
export function personalStateBlocksClose(state: PersonalExpenseState): boolean {
  return state === "personal_unpaid";
}

// ── Auto-explained rows (founder directive, 2026-08-12) ─────────────────────
// "only things that actually need explaining should show up here, so I can
// attack this month by month." Two row classes publish on the ledger but
// carry their OWN explanation, so no human should ever be asked to code them
// or chase a receipt for them:
//
//  - a processor FEE row (`feeOrigin` — see `finances.ts#isNonDiscretionaryFee`
//    and `processorFees.ts`): a cost of the rail, not a purchase anyone made.
//    There is no receipt and never will be; the processor's own ledger
//    (`processorFeeEntries`) is the record.
//  - a PERSONAL charge (`isPersonal`): not org spend — the repayment is its
//    explanation. Founder's exact ledger wording: "accidental personal
//    charge, paid back (if paid), and awaiting repayment (if we are waiting
//    for repayment)".
//
//  - a CASHBACK payment (`sourceCategory === "cashback_payment"` — the bank's
//    own classification, stored verbatim at ingestion): the card program
//    handing back a slice of card spend. Owner, 2026-08-13: "there's
//    literally nothing for me to code there. It's just money back… auto code
//    these ones as well."
//  - a REFUND pair (`refundedByTransactionId` on the charge /
//    `refundsTransactionId` on the credit — both written by one human act,
//    `finances.markAsRefund`, FULL refunds only): the purchase un-happened.
//    Owner, 2026-08-13: "if something's refunded, why are we coding it and
//    categorizing it? Doesn't really make sense."
//
// Internal movements (transfers, payout deposits) are another self-explaining
// class, but they already sign to zero (`signedBookCents`) and are excluded
// by the `direction !== "internal"` / `signed === 0` checks everywhere — this
// classification covers the classes that carry real signed money and so
// can't be caught by the zero test.
export type AutoExplainedKind =
  | "fee"
  | "personal"
  | "cashback"
  | "refunded_charge"
  | "refund_credit"
  | "repayment_credit"
  | "interest";

/** Increase's `source.category` values the classification keys on — POSITIVE
 *  markers stored verbatim at ingestion, never description-text inferences
 *  (`processorFees.ts`'s `feeOrigin` rule). */
export const CASHBACK_SOURCE_CATEGORY = "cashback_payment";
export const INTEREST_SOURCE_CATEGORY = "interest_payment";

/**
 * True iff this row is a per-transaction processor or bank fee — a cost that
 * was CHARGED, not chosen. THE single definition: `finances.ts` re-exports it
 * under the same name, and every fee carve-out in the app reads this one
 * function.
 *
 * ## Why it lives here and not next to its callers
 *
 * It was written in `finances.ts` and then hand-copied — as `feeOrigin == null`
 * inside `transactionCodings.getForTransaction`'s `requiresCoding` mirror, as
 * `feeOrigin != null` in the public-ledger snapshot, and NOT AT ALL into
 * `lib/codingReminders.ts`. That last omission is the one that shipped a bug:
 * the cardholder chase (`chargeOutstanding` → `receiptChase`, the reconcile
 * `chaseCount`, the reminder digests) took only the POLICY-DATE half of
 * `requiresCoding` and dropped the fee exemption, so Stripe/Givebutter fee rows
 * were chased for receipts that cannot exist. `lib/codingReminders.ts` cannot
 * import `finances.ts` — finances imports `chargeOutstanding` FROM it, so that
 * edge would close a cycle — and this package is the one place all of the
 * callers already import. Same consolidation #702 did for
 * `explanationPopulation`: share the predicate, don't copy the carve-out.
 *
 * ## What it means
 *
 * Written by `processorFees.ts` (sweeping Stripe's balance transactions) and
 * `givebutterSync.ts`, and read everywhere else. A POSITIVE MARKER, never an
 * inference: the alternative was matching on the `stripe-fees:` external-id
 * prefix, which would silently miss Cash App's rows (a different prefix) and
 * would break the moment a key format changed.
 *
 * DELIBERATELY NARROW — the exemption is by ORIGIN, not by category. It marks
 * the fee taken out of an individual payment, nothing else. A monthly platform
 * subscription, a paid Givebutter tier, an accounting service — those are real
 * decisions somebody made, they belong to whoever decided, and they stay
 * budgeted, coded and chased for a receipt even though they land in the same
 * "Bank & Fees" category. Being coded there does not exempt anything; carrying
 * a `feeOrigin` does.
 */
export function isNonDiscretionaryFee(tr: { feeOrigin?: unknown }): boolean {
  return tr.feeOrigin != null;
}

export function autoExplainedKind(tr: {
  feeOrigin?: unknown;
  isPersonal?: boolean;
  source?: string;
  sourceCategory?: string | null;
  refundedByTransactionId?: unknown;
  refundsTransactionId?: unknown;
}): AutoExplainedKind | null {
  if (isNonDiscretionaryFee(tr)) return "fee";
  // Refund outranks personal ON PURPOSE: a personal-flagged charge the
  // merchant then refunded in full has un-happened — "refunded" is the truer
  // headline, and the repayment record (whose state a human still settles)
  // keeps its own books either way.
  if (tr.refundedByTransactionId != null) return "refunded_charge";
  if (tr.refundsTransactionId != null) return "refund_credit";
  // The settled offsetting credit of a personal charge (`source:"repayment"`
  // — `cards.ts#settleRepayment` is its single writer): machine-posted from
  // a settled payment rail, never a judgement call. Its counterpart charge
  // is already auto-explained as `personal`.
  if (tr.source === "repayment") return "repayment_credit";
  if (tr.isPersonal === true) return "personal";
  if (tr.sourceCategory === CASHBACK_SOURCE_CATEGORY) return "cashback";
  // Bank interest on the account balance — same shape as cashback: nobody
  // chose it, there is no receipt, the bank's ledger is the record.
  if (tr.sourceCategory === INTEREST_SOURCE_CATEGORY) return "interest";
  return null;
}

/** The sentence the public ledger prints in place of a coding for an
 *  auto-explained row — derived from structured state, never composed
 *  testimony (the no-AI-in-coding rule is about authorship of a human's
 *  account; a status label is the product describing its own records). */
export function autoExplanationLine(
  kind: AutoExplainedKind,
  personalState?: PersonalExpenseState,
): string {
  if (kind === "fee") {
    return "Payment processing fees — charged by the processor on money already accepted, itemized in the processor's own ledger. Not a purchase anyone made, so there is no receipt.";
  }
  if (kind === "cashback") {
    return "Card cashback paid by the bank — a slice of card spend returned by the card program. Not a sale and not anyone's purchase.";
  }
  if (kind === "refunded_charge") {
    return "Refunded in full — the money came back on a paired credit, and the two rows net to zero.";
  }
  if (kind === "refund_credit") {
    return "A refund received — reverses its paired charge in full.";
  }
  if (kind === "repayment_credit") {
    return "Repayment received for an accidental personal charge — the offsetting credit; the charge it settles publishes alongside it.";
  }
  if (kind === "interest") {
    return "Interest paid by the bank on the account balance. Not a gift and not a sale.";
  }
  return personalState === "personal_reimbursed"
    ? "Accidental personal charge — paid back."
    : "Accidental personal charge — awaiting repayment.";
}

// ── ACH destination capture (Increase External Accounts) ─────────────────────
// The funding-type Increase records on an External Account (`POST
// /external_accounts`). Increase itself also allows `general_ledger`/`other`,
// but those never apply to a person's personal bank account, so capture is
// restricted to the two a human actually has.
export const EXTERNAL_ACCOUNT_FUNDINGS = ["checking", "savings"] as const;
export type ExternalAccountFunding = (typeof EXTERNAL_ACCOUNT_FUNDINGS)[number];

// ── Payouts (ACH from the chapter's Increase account) ────────────────────────
export const PAYOUT_PROVIDERS = ["increase", "manual"] as const;
export type PayoutProvider = (typeof PAYOUT_PROVIDERS)[number];

export const PAYOUT_STATUSES = [
  "pending",
  "processing",
  "paid",
  "failed",
  "returned",
  "canceled",
] as const;
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];

// ── Sandbox ↔ production environment hygiene ─────────────────────────────────
// Increase objects created in the SANDBOX come back with ids prefixed
// `sandbox_` (accounts, cards, transfers, real-time decisions); production ids
// have no such prefix. The environment lives ENTIRELY in that id prefix —
// nothing is stored per-record. A record with a NULL/empty Increase id is a
// manual/degraded record (no vendor object) and is environment-NEUTRAL: it must
// show in BOTH modes.
/** True iff an Increase object id is a sandbox object (prefixed `sandbox_`). */
export function isSandboxObjectId(id?: string | null): boolean {
  return !!id?.startsWith("sandbox_");
}

/**
 * Whether a record carrying `increaseId` should be VISIBLE in the current mode.
 * A null/empty id is env-neutral (manual/degraded) → ALWAYS visible. Otherwise
 * it shows only when its sandbox-ness matches the mode: in production
 * (`sandboxMode === false`) non-sandbox + null ids show and `sandbox_` ids hide;
 * in sandbox mode the inverse.
 */
export function matchesMode(
  increaseId: string | null | undefined,
  sandboxMode: boolean,
): boolean {
  if (!increaseId) return true; // env-neutral (manual/degraded) — always show
  return isSandboxObjectId(increaseId) === sandboxMode;
}

// ── Increase account onboarding (one Account per chapter PER ENVIRONMENT) ────
// A chapter may hold BOTH a sandbox and a production Increase account (up to one
// per environment). Each finance view acts on the account matching the current
// `sandboxMode`; the off-mode account is hidden.
export const INCREASE_ONBOARDING_STATUSES = [
  "not_started",
  "pending",
  "active",
  "disabled",
] as const;
export type IncreaseOnboardingStatus =
  (typeof INCREASE_ONBOARDING_STATUSES)[number];

/**
 * Which environment an `increaseAccounts` row belongs to. The explicit
 * `sandbox` field (stamped at provision time from the mode) is the source of
 * truth. LEGACY rows provisioned before the field existed have it unset — for
 * those we fall back to the `sandbox_` id prefix (`isSandboxObjectId`). A
 * null/pending id with no field defaults to production (`false`). The backfill
 * (`increase:runBackfillIncreaseAccountEnv`) stamps the field on legacy rows so
 * the prefix fallback is only ever a transient safety net.
 */
export function accountIsSandbox(account: {
  sandbox?: boolean | null;
  increaseAccountId?: string | null;
}): boolean {
  if (account.sandbox != null) return account.sandbox;
  return isSandboxObjectId(account.increaseAccountId);
}

// ── Legacy external accounts (Stripe Financial Connections read-sync) ────────
export const LEGACY_ACCOUNT_STATUSES = [
  "active",
  "disconnected",
  "error",
] as const;
export type LegacyAccountStatus = (typeof LEGACY_ACCOUNT_STATUSES)[number];

// ── Finance roles (graded) ───────────────────────────────────────────────────
// A graded capability ladder, evaluated by RANK. Superusers + chapter admins
// are implicitly `manager`. A separate central/org tier (financeRoles.scope
// === "central") layers org-wide roll-up access on top.
export const FINANCE_ROLES = ["viewer", "bookkeeper", "manager"] as const;
export type FinanceRole = (typeof FINANCE_ROLES)[number];

export const FINANCE_ROLE_LABELS: Record<FinanceRole, string> = {
  viewer: "Viewer",
  bookkeeper: "Bookkeeper",
  manager: "Manager",
};

/** Numeric rank for the graded ladder (higher = more capable). */
export const FINANCE_ROLE_RANK: Record<FinanceRole, number> = {
  viewer: 1,
  bookkeeper: 2,
  manager: 3,
};

/** True iff `role` is at least as capable as `min` on the graded ladder. */
export function financeRoleAtLeast(
  role: FinanceRole | null | undefined,
  min: FinanceRole,
): boolean {
  if (!role) return false;
  return FINANCE_ROLE_RANK[role] >= FINANCE_ROLE_RANK[min];
}

/** Whether a finance role grants org-wide (central) reach. */
export const FINANCE_ROLE_SCOPES = ["chapter", "central"] as const;
export type FinanceRoleScope = (typeof FINANCE_ROLE_SCOPES)[number];

// ── Central (org-level) sentinel ─────────────────────────────────────────────
// The org level ("central") is represented by the string literal `"central"`
// stored in a `chapterId` field — NEVER null/absent, and NOT a real `chapters`
// row. The value is self-describing. On the Convex side a chapter-or-central
// scope is `Id<"chapters"> | typeof CENTRAL`; we never import Convex `Id` here.
/** The org level ("central") as a chapterId sentinel — see finance-handoff. */
// ── Correcting a transaction (reconstructed history) ─────────────────────────
// Owner ask (2026-08-05): "a lot of these purchases were added by another agent
// by reading historical CSVs / Notion docs, and it did some things wrong… I
// should be able to edit the manually imported ones. Obviously we shouldn't be
// able to edit actual transactions that came from Relay or Increase."
//
// The gate is a property of the ROW, not of the person editing it. A row synced
// from a bank feed is a THIRD PARTY'S CLAIM about money that actually moved:
// editing it means the ledger no longer reconciles against a statement, which
// is the single property that makes the whole thing believable. A `manual` row
// is a HUMAN ASSERTION, and assertions get corrected.
//
// This is deliberately narrower than "not a bank feed". `reimbursement`,
// `repayment` and `transfer` rows are system-written LEGS tied to another
// record (a payout, a repayment, a paired transfer) — editing one in isolation
// would silently desync it from its counterpart. Only `manual` is a standalone
// human claim about the world, and only `manual` is correctable.
//
// The retired `skim`/`launch_grant`/`settlement` legs are excluded for the same
// reason as `transfer`: they are paired legs, just historical ones.
export const CORRECTABLE_TRANSACTION_SOURCES: readonly TransactionSource[] = [
  "manual",
];

/** True iff a transaction's SOURCE permits correcting its amount/date/merchant.
 *  The safety half of the gate — the authorization half lives in
 *  `apps/convex/lib/financeEditAccess.ts`. Pure, so both sides share it. */
export function isCorrectableSource(source: TransactionSource): boolean {
  return CORRECTABLE_TRANSACTION_SOURCES.includes(source);
}

/** Every `externalId` the genesis backfill wrote starts with this, across all
 *  three of its datasets (`genesis-bank:`, `genesis-ltn:`,
 *  `genesis-inkind-exp:`) — see `apps/convex/financeGenesisBackfill.ts`. It is
 *  the provenance handle that already exists in production data, which is why
 *  reconstructed rows need no migration to be recognizable. */
export const GENESIS_IMPORT_PREFIX = "genesis-";

/**
 * True iff this row is RECONSTRUCTED HISTORY — loaded from a spreadsheet,
 * export or document rather than observed as it happened.
 *
 * Two ways to be one, on purpose. `historicalImportBatch` is the explicit
 * marker every FUTURE import stamps; the `genesis-` prefix recognizes the rows
 * already in production from the original backfill, so nothing has to be
 * migrated to be labelled honestly today.
 *
 * This does NOT gate editing (`isCorrectableSource` does). It exists so the
 * ledger can SAY which of its rows are reconstructions — a published ledger
 * that silently mixes "we watched this happen" with "we rebuilt this from a
 * Notion doc" is overclaiming, and the distinction costs nothing to keep.
 */
export function isReconstructedHistory(row: {
  externalId?: string | null;
  historicalImportBatch?: string | null;
}): boolean {
  if (row.historicalImportBatch) return true;
  return row.externalId?.startsWith(GENESIS_IMPORT_PREFIX) === true;
}

export const CENTRAL = "central" as const;
export type Central = typeof CENTRAL;
/** True iff a chapterId field points at the org (central) level. */
export function isCentral(chapterId: string | null | undefined): boolean {
  return chapterId === CENTRAL;
}

// ── Specialized roles (leadership + finance, at central/chapter scope) ───────
// Super-admin-managed org roles layered on top of the graded finance ladder.
// A TITLE has a fixed KIND (leadership vs finance) and a valid SCOPE constraint
// (central-only, chapter-only, or either). Leadership titles (ED/president) drive
// oversight + the scope-local separation-of-duties constraint; the finance title
// (finance_manager) additionally BRIDGES to a `financeRoles` manager grant, so it
// confers real finance-write capability. Stored on `specializedRoles` with the
// `"central"` sentinel for org scope (never null), mirroring the finance layer.
export const SPECIALIZED_ROLE_TITLES = [
  "executive_director",
  "president",
  "finance_manager",
] as const;
export type SpecializedRoleTitle = (typeof SPECIALIZED_ROLE_TITLES)[number];

export const SPECIALIZED_ROLE_KINDS = ["leadership", "finance"] as const;
export type SpecializedRoleKind = (typeof SPECIALIZED_ROLE_KINDS)[number];

// Which scope(s) a title may be assigned at: only the org level, only a chapter,
// or either. Central is the `"central"` sentinel; a chapter is a real chapter id.
export type SpecializedRoleScopeConstraint = "central" | "chapter" | "any";

export interface SpecializedRoleMeta {
  /** The kind this title belongs to (drives SoD + the finance bridge). */
  kind: SpecializedRoleKind;
  /** The scope(s) this title may be assigned at. */
  scope: SpecializedRoleScopeConstraint;
  /** Human-readable label for governance surfaces. */
  label: string;
}

export const SPECIALIZED_ROLE_META: Record<
  SpecializedRoleTitle,
  SpecializedRoleMeta
> = {
  executive_director: {
    kind: "leadership",
    scope: "central",
    label: "Executive Director",
  },
  president: {
    kind: "leadership",
    scope: "chapter",
    // Owner-approved naming (WP-1.1): the org chart calls this seat "Chapter
    // Director" — the owner says "president" verbally, but that's not what
    // ships in UI copy. The identifier stays `president` (schema/authz
    // untouched); only the display label changed.
    label: "Chapter Director",
  },
  finance_manager: {
    kind: "finance",
    scope: "any",
    label: "Finance Manager",
  },
};

/** The kind (leadership | finance) a specialized-role title belongs to. */
export function titleKind(title: SpecializedRoleTitle): SpecializedRoleKind {
  return SPECIALIZED_ROLE_META[title].kind;
}

/**
 * WP-1.1: the single source of truth for a specialized-role title's org-chart
 * display name — SCOPE-aware, because `finance_manager` is one title/grant
 * assigned at either level (`scope: "any"`) but reads differently depending
 * on which: "Finance Manager" at central, "Treasurer" at a chapter (the PRD's
 * seat-table mapping — treasurer IS the chapter finance_manager seat, not a
 * parallel title). Every other title's label is scope-invariant, so this
 * falls back to `SPECIALIZED_ROLE_META[title].label` for those.
 */
export function specializedRoleLabel(
  title: SpecializedRoleTitle,
  scopeIsCentral: boolean,
): string {
  if (title === "finance_manager" && !scopeIsCentral) return "Treasurer";
  return SPECIALIZED_ROLE_META[title].label;
}

/**
 * True iff `title` may be assigned at the given scope. `scopeIsCentral` is true
 * for the org level (`"central"`), false for a chapter. `"any"` titles fit both.
 */
export function titleAllowsScope(
  title: SpecializedRoleTitle,
  scopeIsCentral: boolean,
): boolean {
  const constraint = SPECIALIZED_ROLE_META[title].scope;
  if (constraint === "any") return true;
  return scopeIsCentral ? constraint === "central" : constraint === "chapter";
}

// ── Money formatting (single source of truth) ────────────────────────────────
/**
 * Format integer cents as a USD string. `cents` is always an integer amount in
 * cents (never a float dollar value). Defaults to no decimal places when the
 * amount is a whole number of dollars and `compact` is set, else 2 dp.
 */
export function formatCents(
  cents: number,
  opts: { showCents?: boolean } = {},
): string {
  const showCents = opts.showCents ?? true;
  const dollars = cents / 100;
  return dollars.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: showCents ? 2 : 0,
    maximumFractionDigits: showCents ? 2 : 0,
  });
}

/** Sum a list of integer-cent amounts (guards against float drift). */
export function sumCents(amounts: readonly number[]): number {
  return amounts.reduce((total, c) => total + Math.round(c), 0);
}

// ── Period bucketing (America/New_York) ──────────────────────────────────────
// Budgets bucket by month / quarter / year in the chapter's home timezone
// (America/New_York), then convert to UTC ms for range indexes on transactions.
// These helpers derive the (year, month, quarter) a timestamp falls in when
// read in Eastern time, so a late-night charge doesn't slip into the wrong month.
export const FINANCE_TIMEZONE = "America/New_York";

/** The Eastern-time calendar parts (year, 1-based month, day) of a timestamp. */
export function easternParts(ts: number): {
  year: number;
  month: number;
  day: number;
} {
  // `en-CA` yields ISO-ish `YYYY-MM-DD`, which is trivial to split.
  const s = new Date(ts).toLocaleDateString("en-CA", {
    timeZone: FINANCE_TIMEZONE,
  });
  const [year, month, day] = s.split("-").map((n) => parseInt(n, 10));
  return { year, month, day };
}

/** The 1-based quarter (1–4) a month (1-based) falls in. */
export function quarterOfMonth(month: number): number {
  return Math.floor((month - 1) / 3) + 1;
}

// ── Split reattribution heuristics (WP-2.2) ──────────────────────────────────
// The playbook's boundary rules for the retroactive split (Phase 2). These are
// SUGGESTION heuristics only — `suggestSplitAssignments` uses them to bucket a
// chapter's history into "likely central" vs "likely chapter"; a human always
// confirms before `reassignTransactions` moves anything. Kept here (not inline)
// so the boundary list is one editable constant the owner can tune per the
// City Launch Playbook, never a magic string buried in a query.

/**
 * Merchant-name keywords that suggest a CENTRAL charge (org-wide spend the
 * playbook keeps at central: expansion, conference, brand). A case-insensitive
 * substring match on `transactions.merchantName` (or `description`) proposes
 * "central". Editable — add the org's real recurring central merchants here.
 */
export const CENTRAL_MERCHANT_KEYWORDS: readonly string[] = [
  "expansion",
  "conference",
  "brand",
  "city launch",
  "training",
];

/**
 * Project-name keywords that mark a project as CENTRAL-owned (owner decision #2,
 * 2026-07-16): the Music/recording project is organized ACROSS chapters, so it's
 * central — the one explicit exception to "all NY projects transfer to the
 * chapter". A case-insensitive substring match on the project name proposes
 * "central" for that project's txns; every other project defaults to "chapter".
 * The UI exposes the full project list so a human can override per-project.
 */
export const CENTRAL_PROJECT_KEYWORDS: readonly string[] = ["music", "record"];

/** Case-insensitive: does `text` contain ANY of `keywords`? (Empty → false.) */
export function matchesAnyKeyword(
  text: string | null | undefined,
  keywords: readonly string[],
): boolean {
  if (!text) return false;
  const haystack = text.toLowerCase();
  return keywords.some((k) => haystack.includes(k.toLowerCase()));
}

/** The max number of transaction ids one bulk-reattribution call accepts. The
 *  UI paginates larger split runs; a hard cap keeps a single mutation bounded
 *  (invariant: reads/writes stay bounded). */
export const REASSIGN_BATCH_CAP = 200;

// ── Affordability (WP-4.3: "can we afford this event?") ─────────────────────
// The City Launch Playbook's chapter-affordability model (PRD §0.1): a manual
// backer HEADCOUNT (never dollars — the future Giving page, F-6, is the real
// backer platform) drives monthly revenue → a tier label → the monthly
// operating floor → the central skim → what's left over (discretionary).
// Every constant below is a playbook fact, kept here (not inline in a query or
// component) so the owner can tune it in one place.

/** One backer's monthly pledge, in cents ($50/mo). Headcount × this = revenue.
 *  Mirrors the playbook's "$50/mo" backer unit — never a floating dollar. */
export const BACKER_UNIT_CENTS = 5000;

/** The chapter → central "City Launch Fund" skim, as a fraction of a chapter's
 *  monthly backer revenue. Playbook: flat 15%, owner-confirmed 2026-07-16 (§3.3
 *  — "Skim: flat 15% confirmed"). Modeled as a `flow:"transfer"` pair once
 *  accounts are live (WP-4.1); this constant is the one place both the
 *  affordability header and the transfer automation read the rate from. */
export const CENTRAL_SKIM_PCT = 0.15;

/** Monthly operating floor's FIXED (headcount-independent) component, in cents
 *  ($570). The City Launch Playbook's "fixed base": WWS film $200 · WWS event
 *  food $160 · equipment transport $100 · storage $60 · software $50. Meeting
 *  food is the PER-TEAMMATE component below (it scales with team size), not part
 *  of this base. (Updated 2026-07-21 to the leaner software stack — was $520
 *  with a $150 software line and meeting food folded into the base.) */
export const OPERATING_FLOOR_FIXED_CENTS = 57_000;

/** Monthly operating floor's PER-TEAMMATE component, in cents ($20/teammate) —
 *  the monthly team-meeting meal at $20/person. Sanity check against the
 *  playbook's stated $670 floor for a 5-person team:
 *  `OPERATING_FLOOR_FIXED_CENTS + 5 * OPERATING_FLOOR_PER_TEAMMATE_CENTS`
 *  = $570 + 5×$20 = $670. ✓ (30 backers/~6 team → $690; 50/~7 → $710.) */
export const OPERATING_FLOOR_PER_TEAMMATE_CENTS = 2000;

/**
 * Backer-count tier thresholds (the playbook's deep-dive numbers, owner-
 * confirmed 2026-07-16 — supersedes the stale one-pager's 25/50/75). Ordered
 * HIGHEST THRESHOLD FIRST — `affordabilityTierLabel` walks it top-down and
 * returns the first threshold met.
 */
export const AFFORDABILITY_TIERS: readonly {
  minBackers: number;
  label: string;
}[] = [
  { minBackers: 50, label: "+LTN" },
  { minBackers: 30, label: "+Eden" },
  { minBackers: 20, label: "WWS" },
];

// ── City Launch Playbook: public transparency breakdowns ─────────────────────
// Single-sourced figures for the public `/give` page's "where your giving goes"
// sections, so the page can NEVER drift from the real model. Every number below
// is from the City Launch Playbook (Backer Model, Chapter Budget & Finances,
// Chapter Team & Roles). Amounts are integer cents. Keep these truthful — the
// giving page renders them verbatim.

/** One labeled money line in a transparency breakdown. */
export interface MoneyLine {
  label: string;
  amountCents: number;
  note?: string;
}

/**
 * The ~$670/mo monthly operating floor for a 5-person, 20-backer chapter — what
 * recurring backers sustain every month. Sums to
 * `OPERATING_FLOOR_FIXED_CENTS + 5 * OPERATING_FLOOR_PER_TEAMMATE_CENTS` = $670.
 */
export const MONTHLY_OPERATING_LINES: readonly MoneyLine[] = [
  { label: "Film crew & editing (Worship With Strangers)", amountCents: 20_000 },
  { label: "Food — team, musicians & volunteers", amountCents: 16_000 },
  { label: "Equipment transport (gas + rideshare)", amountCents: 10_000 },
  { label: "Monthly team-meeting meal ($20 × 5)", amountCents: 10_000 },
  { label: "Storage unit (5×5)", amountCents: 6_000 },
  { label: "Software & subscriptions", amountCents: 5_000 },
];

/**
 * The one-time starter EQUIPMENT package (~$4,287) the central City Launch Fund
 * buys so a new city owns its production kit from day one — the "what we're
 * trying to buy" list. Durable, one-time; the chapter keeps it for years.
 */
export const LAUNCH_EQUIPMENT_LINES: readonly MoneyLine[] = [
  { label: "4× Shure SM58 microphones", amountCents: 44_000 },
  { label: "Keyboard", amountCents: 50_000 },
  { label: "Guitar", amountCents: 50_000 },
  { label: "Mixer", amountCents: 50_000 },
  { label: "2× Speakers", amountCents: 100_000 },
  { label: "200W battery", amountCents: 20_000 },
  { label: "2000W battery", amountCents: 50_000 },
  { label: "XLR cables, ties & accessories", amountCents: 20_000 },
  { label: "Storage racks", amountCents: 10_000 },
  { label: "Tax & shipping (est.)", amountCents: 34_700 },
];

/**
 * The one-time NYC TRAINING TRIP (~$3,700) — the founding team of five comes to
 * the mothership to learn the model firsthand before launching locally. Carried
 * by central, never the new city's monthly budget.
 */
export const LAUNCH_TRAINING_TRIP_LINES: readonly MoneyLine[] = [
  { label: "Flights (5 × ~$300 round-trip)", amountCents: 150_000 },
  { label: "Lodging (shared, ~4 nights)", amountCents: 120_000 },
  { label: "Local transit & meals (5 people)", amountCents: 100_000 },
];

/** A public backer tier — the canon event(s) a chapter GUARANTEES its backers at
 *  each headcount, and the monthly revenue that headcount represents. */
export interface PublicBackerTier {
  minBackers: number;
  monthlyCents: number;
  commitment: string;
}

/**
 * The three backer tiers as guarantees (not ceilings): the canon Public Worship
 * identity a chapter commits to deliver at each backer headcount. 20 → WWS,
 * 30 → +Eden, 50 → +Love Thy Neighbor. Monthly = headcount × `BACKER_UNIT_CENTS`.
 */
export const PUBLIC_BACKER_TIERS: readonly PublicBackerTier[] = [
  { minBackers: 20, monthlyCents: 100_000, commitment: "Worship With Strangers, every month" },
  { minBackers: 30, monthlyCents: 150_000, commitment: "+ Eden, the annual worship-and-picnic gathering" },
  { minBackers: 50, monthlyCents: 250_000, commitment: "+ Love Thy Neighbor, the neighborhood block party" },
];

/** A chapter's 5-person volunteer core-team role and what it owns. */
export interface ChapterCoreRole {
  role: string;
  owns: string;
}

/**
 * The 5-person volunteer core team every chapter runs on — each role mirrors a
 * central director. Leadership is volunteer; there is no chapter-level payroll.
 * Grows to ~10 (adds +3 events, +2 music) for Eden / Love Thy Neighbor scale.
 */
export const CHAPTER_CORE_ROLES: readonly ChapterCoreRole[] = [
  { role: "Chapter Director", owns: "Vision, alignment, leadership, fundraising & backers" },
  { role: "Music Lead", owns: "Worship, musicians, sound" },
  { role: "Event / Production Lead", owns: "Logistics, production, run of show" },
  { role: "Marketing Lead", owns: "Reach, content, turnout" },
  { role: "Treasurer", owns: "Budget, records, reimbursements" },
];

/** Tier label shown below the lowest threshold in `AFFORDABILITY_TIERS`
 *  (or the lowest threshold of whatever `tiers` array is in play). */
export const PRE_TIER_LABEL = "Pre-tier";

/** The `{minBackers, label}` shape a tier ladder needs — matches
 *  `AFFORDABILITY_TIERS`'s element type and the `backerMilestones` table's
 *  own two fields, so a Convex-side caller can map its rows straight into
 *  this without re-declaring the shape. */
export interface TierLike {
  minBackers: number;
  label: string;
}

/**
 * The tier label for a given backer count: the HIGHEST `minBackers`
 * threshold met in `tiers`, else `PRE_TIER_LABEL`. Order-independent (finds
 * the max qualifying threshold rather than walking in array order), so it
 * behaves the same whether `tiers` is sorted ascending (as
 * `backerMilestones` rows come back) or descending (as `AFFORDABILITY_TIERS`
 * is declared).
 *
 * `tiers` defaults to `AFFORDABILITY_TIERS` — the giving-platform PRD §3
 * milestone ladder (`apps/convex/backerMilestones.ts`) is configurable, but
 * this constant stays the fallback so finance never breaks if that config is
 * empty. Every existing call site (omitting `tiers`) is unchanged.
 */
export function affordabilityTierLabel(
  backerCount: number,
  tiers: readonly TierLike[] = AFFORDABILITY_TIERS,
): string {
  let label = PRE_TIER_LABEL;
  let bestMinBackers = -Infinity;
  for (const tier of tiers) {
    if (backerCount >= tier.minBackers && tier.minBackers > bestMinBackers) {
      bestMinBackers = tier.minBackers;
      label = tier.label;
    }
  }
  return label;
}

/** The full WP-4.3 computation's shape — see `chapterAffordability`. */
export interface ChapterAffordability {
  monthlyRevenueCents: number;
  tierLabel: string;
  floorCents: number;
  skimCents: number;
  /** `monthlyRevenueCents - floorCents - skimCents`. May be NEGATIVE (spend
   *  commitments exceed what backer revenue covers after the floor + skim) —
   *  callers clamp the DISPLAY ("under water by $X"), never this raw value. */
  discretionaryCents: number;
}

/**
 * The WP-4.3 "can we afford this?" computation: backers → revenue → tier →
 * operating floor → central skim → discretionary. Pure (no ctx, no rounding
 * surprises beyond the skim's cent rounding) so it's testable without
 * convex-test and reusable by both the `chapterAffordability` query and any
 * future consumer (e.g. an event's "can we afford this?" check).
 *
 * `backerCount` is the chapter's MANUAL entry (§0.1 — no Giving page yet).
 * `teammateCount` is the chapter's active team-member headcount; see
 * `finances.chapterAffordability` in the Convex backend for exactly which
 * roster rows count (documented there since it queries `people`, which this
 * pure module can't reach). `tiers` (giving-platform PRD §3) optionally
 * overrides the milestone ladder used for `tierLabel`; omitted, it defaults
 * to `AFFORDABILITY_TIERS` via `affordabilityTierLabel` — every existing call
 * site is unchanged.
 */
export function chapterAffordability(
  backerCount: number,
  teammateCount: number,
  tiers?: readonly TierLike[],
): ChapterAffordability {
  const monthlyRevenueCents = backerCount * BACKER_UNIT_CENTS;
  const floorCents =
    OPERATING_FLOOR_FIXED_CENTS +
    teammateCount * OPERATING_FLOOR_PER_TEAMMATE_CENTS;
  const skimCents = Math.round(monthlyRevenueCents * CENTRAL_SKIM_PCT);
  const discretionaryCents = monthlyRevenueCents - floorCents - skimCents;
  return {
    monthlyRevenueCents,
    tierLabel: affordabilityTierLabel(backerCount, tiers),
    floorCents,
    skimCents,
    discretionaryCents,
  };
}

// ── The City Launch Fund money flows ──────────────────────────────────────────
// The playbook models money moving BOTH ways between a chapter and central (PRD
// §0.1): UP is the ~15% skim commitment (chapter → central City Launch Fund);
// DOWN is a one-time launch grant (central → a new chapter, equipment +
// training trip). Both are recorded as a PAIR of `flow:"transfer"`
// transactions — an outflow leg on the source scope + an inflow leg on the
// destination scope — linked by a shared `transactions.transferGroupId`.
// Transfers never count as spend (`countsAsSpend`), so they distort no
// budget/category rollup.
//
// RETIRED (owner decision 2026-07-26): the WP-4.1/4.2/4.5 automation that used
// to compute a skim amount from revenue, stamp a launch chapter's budget
// automatically, and (optionally) fire a real Increase transfer is GONE — "we
// just have 1 chapter and not a lot of backers, it feels unnecessarily
// complex... it could be just a manual transfer." Every transfer, of every
// kind, is now recorded by a human via ONE generic mutation
// (`apps/convex/transfers.ts#recordTransfer`) with a free-text `note`
// explaining what it was for. `skimAmountCents`/`skimTransferGroupId`/
// `launchTransferGroupId`/`settlementTransferGroupId`/`TRANSFER_KINDS` are
// deleted along with that automation; `CENTRAL_SKIM_PCT` stays (see the
// Affordability section above) because the 15% commitment is still the real,
// donor-promised number — it's just honored by hand now, not computed here.
//
// NOTE: `BACKER_UNIT_CENTS` and `CENTRAL_SKIM_PCT` are defined once, above, in
// the Affordability (WP-4.3) section.

/** One planned line of a new chapter's one-time launch budget (equipment +
 *  training trip) — see `LAUNCH_BUDGET_TEMPLATE`. */
export interface LaunchBudgetLine {
  label: string;
  amountCents: number;
}

/**
 * The City Launch Playbook's one-time launch budget (PRD §0.1: equipment
 * ~$4,300 + an NYC training trip ~$3,500–4,000, ~$7,800–8,300/city total).
 * Editable product constant — feeds `launchTemplateTotalCents()` below, which
 * is the launch-fund TARGET amount shown on a territory's public pot
 * (`territories.ts`, `lib/givePage.ts`) and recorded as a chapter's launch
 * grant (`transfers.ts#recordTransfer`, a manual `central_to_chapter`
 * transfer — see that file's header comment). Retired (2026-07-26): this used
 * to also auto-stamp one `one_time` budget per nonzero line on the receiving
 * chapter the moment a launch grant was recorded; that side effect went away
 * with the launch-grant automation, so a chapter's launch budgets are now
 * created the normal manual way, same as any other budget.
 */
export const LAUNCH_BUDGET_TEMPLATE: readonly LaunchBudgetLine[] = [
  { label: "Launch equipment", amountCents: 430_000 },
  { label: "Training trip — travel", amountCents: 200_000 },
  { label: "Training trip — lodging", amountCents: 120_000 },
  { label: "Training trip — meals & local transport", amountCents: 50_000 },
];

/** The default launch-grant amount: the sum of the template's nonzero lines. */
export function launchTemplateTotalCents(): number {
  return LAUNCH_BUDGET_TEMPLATE.reduce(
    (sum, line) => sum + Math.max(0, line.amountCents),
    0,
  );
}

// ── Inter-scope settlement balances ───────────────────────────────────────────
// Owner policy: "Your card determines whose account paid; reconcile determines
// whose budget it was; Central settles the difference." Cards stay
// account-scoped (cash physics) but attribution (a txn's `budgetId`) crosses
// scopes freely — a chapter's card can pay for a central budget line. That
// creates a net CASH imbalance between the two accounts, corrected by
// recording a generic transfer in the direction that pays it down. See
// `apps/convex/transfers.ts#interScopeBalances` for the ledger-derived balance
// computation (RETIRED `settlementTransferGroupId`'s deterministic
// one-per-month id is gone with the settlement-specific automation — a
// generic transfer's id is `apps/convex/transfers.ts#genericTransferGroupId`).

// ── Money-page unification (WP-money-unify PR1) ───────────────────────────────
// A cost-bearing row (`eventItems`, `engagements`) now carries an OPTIONAL
// `budgetCategoryId` override (see `schema/events.ts#eventItems` /
// `schema/people.ts#engagements`). When it's unset, a read-side consumer (the
// Money-page plan view, landing in a follow-up PR) falls back to a sensible
// DEFAULT category per module — good-enough categorization out of the box
// without forcing every row to be hand-categorized.

/**
 * Default budget-category NAME per module key, keyed by the item's `module`
 * string (`eventItems.module` — see `MODULE_KEYS` in `./index`). A module not
 * listed here (e.g. `volunteer_expectations`, `retro` — not typically
 * cost-bearing) or any future/custom module key falls back to `"Other"` at
 * the consumer.
 *
 * Names MUST match a chapter's seeded category names EXACTLY —
 * `DEFAULT_EXPENSE_CATEGORIES` in `apps/convex/lib/seed/finance.ts:28-42`
 * (Convex-side; not importable from this package) is the source of truth. A
 * unit test pins this coupling by comparing the two lists directly.
 */
export const MODULE_DEFAULT_CATEGORY_NAMES: Record<string, string> = {
  supplies: "Supplies",
  comms: "Marketing & Advertising",
  planning_doc: "Other",
  permits: "Other",
  run_of_show: "Other",
};

/**
 * Default budget-category name for a paid `engagements` row (a vendor) with
 * no `budgetCategoryId` override. Must also match a name in
 * `DEFAULT_EXPENSE_CATEGORIES` — see `MODULE_DEFAULT_CATEGORY_NAMES` above.
 */
export const VENDOR_DEFAULT_CATEGORY_NAME = "Professional Services";
