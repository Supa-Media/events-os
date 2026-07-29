/**
 * Extraction of ledger-postable facts from a fetched Increase `Transaction`
 * object — the pure half of transaction ingestion (`increaseLedger.ts` does
 * the fetch + DB apply). Two extractors cover the WHOLE object space:
 *
 *  - `extractCardCharge` — a settled member-card charge/refund
 *    (`source.category` = `card_settlement` / `card_refund`) → an
 *    `increase_card` ledger row with card attribution.
 *  - `extractAccountActivity` — EVERYTHING ELSE that moves money on the
 *    account (inbound/outbound ACH, wires, check deposits, fees, interest,
 *    account transfers, …) → an `increase_ach` ledger row. Before this
 *    extractor existed, non-card activity was silently skipped — so an
 *    inbound transfer (e.g. Relay → the chapter's Increase account) never
 *    appeared in Reconcile and its two legs could not be marked as a
 *    transfer. Every Increase transaction now lands in the ledger exactly
 *    once (dedup + already-booked guards live in the DB apply).
 *
 * Ground truth (verified against the real Increase API — increase.com/documentation
 * + the increase-node SDK types):
 *  - `Transaction.amount` is a SIGNED integer in the currency's minor unit
 *    (cents): NEGATIVE for money leaving → `outflow`, POSITIVE for money
 *    arriving → `inflow`. Direction lives in `transactions.flow`;
 *    `amountCents` is the abs.
 *  - `source` is a discriminated union: `source.category` names the ONE
 *    populated sub-object (`source[category]`), e.g. a
 *    `category:"inbound_ach_transfer"` transaction carries
 *    `source.inbound_ach_transfer`.
 *  - The sub-objects for transfers WE initiated via the API
 *    (`ach_transfer_intention`, `account_transfer_intention`, …) carry a
 *    `transfer_id` linking back to the originating transfer object — the DB
 *    apply uses it to skip activity already booked by the payout/repayment
 *    state machines (see `increaseLedger.applyIncreaseAccountTransaction`).
 *
 * PURE HELPERS ONLY — nothing in `lib/` registers Convex functions.
 */

/** The card-charge source categories `extractCardCharge` ingests; every other
 *  category on a `transaction.created` is account activity. */
export const CARD_SOURCE_CATEGORIES = ["card_settlement", "card_refund"] as const;

/** The card_settlement / card_refund sub-object (merchant + the card-payment link). */
export interface IncreaseCardSourceLite {
  card_payment_id?: string;
  merchant_name?: string;
  merchant_category_code?: string;
}

/** The subset of a fetched Increase `Transaction` object we read. `source` is
 *  indexable by category so `extractAccountActivity` can reach the ONE
 *  populated sub-object without enumerating every category Increase defines. */
export interface IncreaseTransactionLite {
  id?: string;
  account_id?: string;
  amount?: number; // signed minor units (negative = money leaving)
  created_at?: string;
  currency?: string;
  description?: string;
  source?: {
    category?: string;
    card_settlement?: IncreaseCardSourceLite | null;
    card_refund?: IncreaseCardSourceLite | null;
  } & Record<string, unknown>;
}

/** The extracted, provider-agnostic card charge we hand to the DB apply. */
export interface ExtractedCardCharge {
  externalId: string;
  accountId: string;
  flow: "outflow" | "inflow";
  amountCents: number;
  postedAt: number;
  merchantName?: string;
  merchantCategory?: string;
  cardPaymentId?: string;
}

/** The extracted non-card account activity we hand to the DB apply. */
export interface ExtractedAccountActivity {
  externalId: string;
  accountId: string;
  flow: "outflow" | "inflow";
  amountCents: number;
  postedAt: number;
  /** Increase's own `Transaction.description` — the provider-sourced string
   *  Reconcile falls back to when there's no merchant/counterparty name. */
  description?: string;
  /** The `source.category` (e.g. `inbound_ach_transfer`), kept for logging. */
  category: string;
  /** A human counterparty name when the sub-object carries one (e.g. an
   *  inbound ACH's originator) — lands in `merchantName` for display. */
  counterpartyName?: string;
  /** The originating transfer object's id, when this activity came from a
   *  transfer WE (or someone in the Increase dashboard) initiated — the DB
   *  apply uses it to skip activity the app already booked elsewhere. */
  transferId?: string;
}

/** Shared id/account/amount guards; null when the object can't be posted. */
function extractMoneyFacts(txn: IncreaseTransactionLite): {
  externalId: string;
  accountId: string;
  flow: "outflow" | "inflow";
  amountCents: number;
  postedAt: number;
} | null {
  const externalId = txn.id;
  const accountId = txn.account_id;
  if (!externalId || !accountId) return null;
  if (typeof txn.amount !== "number" || !Number.isFinite(txn.amount)) {
    return null;
  }
  const amountCents = Math.abs(Math.round(txn.amount));
  if (amountCents === 0) {
    // A $0 entry carries no ledger meaning — skipped, but logged so it's
    // traceable during reconciliation (rather than silently vanishing).
    console.debug(
      `[increase] ingestion: skipping $0 transaction ${txn.id ?? "<unknown>"}`,
    );
    return null;
  }
  const postedAt = txn.created_at ? Date.parse(txn.created_at) : NaN;
  return {
    externalId,
    accountId,
    flow: txn.amount < 0 ? "outflow" : "inflow",
    amountCents,
    postedAt: Number.isFinite(postedAt) ? postedAt : Date.now(),
  };
}

/**
 * Pull the card-charge fields out of a fetched Increase `Transaction`, or null if
 * it isn't a settled card charge/refund we should ingest (wrong source category,
 * missing id/account, or a $0 settlement). Flow + amount come from the SIGNED
 * top-level `amount` (negative = outflow); the merchant + card-payment link come
 * from the matching `card_settlement` / `card_refund` sub-object.
 */
export function extractCardCharge(
  txn: IncreaseTransactionLite,
): ExtractedCardCharge | null {
  const category = txn.source?.category;
  if (
    !category ||
    !(CARD_SOURCE_CATEGORIES as readonly string[]).includes(category)
  ) {
    return null;
  }
  const facts = extractMoneyFacts(txn);
  if (!facts) return null;

  const card =
    category === "card_settlement"
      ? txn.source?.card_settlement
      : txn.source?.card_refund;

  return {
    ...facts,
    merchantName: card?.merchant_name ?? undefined,
    merchantCategory: card?.merchant_category_code ?? undefined,
    cardPaymentId: card?.card_payment_id ?? undefined,
  };
}

/** Read a string field off an unknown sub-object, defensively. */
function readString(sub: unknown, field: string): string | undefined {
  if (typeof sub !== "object" || sub === null) return undefined;
  const value = (sub as Record<string, unknown>)[field];
  return typeof value === "string" && value ? value : undefined;
}

/**
 * Pull the account-activity fields out of a fetched Increase `Transaction`
 * that ISN'T a card charge/refund (those go through `extractCardCharge`), or
 * null when it's a card category / missing id/account / $0. Reads the ONE
 * populated `source[category]` sub-object generically:
 *  - `transfer_id` — present on the `*_intention` categories (a transfer we
 *    or the dashboard initiated); threaded through for the already-booked
 *    guards in the DB apply.
 *  - a counterparty name — best-effort across the fields the common
 *    categories carry (an inbound ACH's `originator_company_name` /
 *    `originator_name`, a wire's `originator_name`); absent ones fall back
 *    to the transaction `description` at display time.
 */
export function extractAccountActivity(
  txn: IncreaseTransactionLite,
): ExtractedAccountActivity | null {
  const category = txn.source?.category;
  if (
    !category ||
    (CARD_SOURCE_CATEGORIES as readonly string[]).includes(category)
  ) {
    return null;
  }
  const facts = extractMoneyFacts(txn);
  if (!facts) return null;

  const sub = txn.source?.[category];
  return {
    ...facts,
    description: txn.description || undefined,
    category,
    counterpartyName:
      readString(sub, "originator_company_name") ??
      readString(sub, "originator_name") ??
      readString(sub, "creditor_name") ??
      undefined,
    transferId: readString(sub, "transfer_id"),
  };
}
