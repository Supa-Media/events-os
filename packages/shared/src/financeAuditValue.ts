/**
 * financeAuditValue — the KEY side of the finance audit trail, and the ONE
 * renderer that turns a key back into words.
 *
 * ── THE BUG THIS CLOSES ──────────────────────────────────────────────────────
 * `financeAuditLog.before`/`.after` were free-text display labels, frozen at
 * write time. When `reconciled`'s label changed from "Reconciled" to "Closed"
 * (#717 — the STORED value never moved, only the word on the screen), the trail
 * went half one word and half the other: rows written before the rename kept
 * saying "Reconciled" forever, next to rows saying "Closed" about the identical
 * state. The founder asked to backdate the strings; he agreed to this instead,
 * verbatim: "Store the status key and render the label. That'll be great."
 *
 * So a row now carries the KEY (`"reconciled"`) alongside the words, and the
 * words are produced HERE, at read time, from whatever the vocabulary says
 * today. History then reads consistently without falsifying anything — the row's
 * state genuinely was `reconciled` and still is; only our word for it changed.
 * The next rename costs nothing.
 *
 * ── WHAT GETS A KEY, AND WHAT DOESN'T ────────────────────────────────────────
 * Not every audit row has a state on each side. A `note_edit` row's `before` is
 * a sentence somebody typed; a `recode` row's is a category NAME; a
 * `budget_amount_change` row's is a dollar figure. Those are FREE TEXT — there
 * is no vocabulary to render them from, and inventing a fake key for them
 * ("note_changed"?) would delete the only record of what actually changed. They
 * keep exactly the shape they always had.
 *
 * The line is: a side is KEYED when it names a member of a CLOSED vocabulary the
 * app can rename tomorrow. An entity's own name (a category, a budget, a
 * merchant, an event, a sale basket) is not a state — it's a name the org chose,
 * and nobody "renames" it out from under the trail; it changes because a human
 * changed it, which is precisely what the row is recording. Absence sentinels
 * beside those names ("None", "Unattributed", "Unresolved") stay free text with
 * them, because splitting one field across two representations to key the word
 * "None" buys nothing and costs a branch at every read.
 *
 * ── WHY THE FROZEN STRING STAYS ──────────────────────────────────────────────
 * `before`/`after` are KEPT, not replaced, for three reasons and one rule:
 *   1. Most rows are free text and the string IS the record. Dropping the
 *      column would delete most of the trail to fix a minority of it.
 *   2. It is the fallback when a key names a state the vocabulary has since
 *      dropped. A retired status has no label to render; the frozen word is
 *      then the only surviving evidence of what the row meant.
 *   3. It is the record of what the SCREEN SAID at the time, which is what a
 *      person's memory of a decision is actually anchored to. "I marked it
 *      Reconciled" is a true sentence about 2026-07, and this table is the only
 *      place that sentence survives.
 * And the rule: `financeAuditLog` is APPEND-ONLY — "NEVER updated or deleted
 * once written" is its schema contract. Adding a key column is additive;
 * overwriting the words somebody saw would be the very falsification the
 * founder was talked out of.
 *
 * ── WHY THERE IS NO STORED `valueKind` COLUMN ────────────────────────────────
 * Which vocabulary a row's keys belong to is already determined by its `action`
 * (plus `field`, for the one action that carries two different kinds). Storing
 * it as well would be a second copy of a fact the row already has, and two
 * copies drift. `financeAuditValueKind` derives it, and derives it the same way
 * for the writer, the reader, and the backfill.
 */
import {
  PAYOUT_PROCESSORS,
  PAYOUT_PROCESSOR_LABELS,
  RECEIPT_EXCEPTION_REASONS,
  RECEIPT_EXCEPTION_REASON_LABELS,
  TRANSACTION_FLOWS,
  TRANSACTION_FLOW_LABELS,
  TRANSACTION_STATUSES,
  TRANSACTION_STATUS_LABELS,
  TRANSACTION_CODING_STATUS_LABELS,
  type FinanceAuditAction,
  type PayoutProcessor,
  type ReceiptExceptionReason,
  type TransactionFlow,
  type TransactionStatus,
} from "./finance";

/**
 * The closed vocabularies an audit row's two sides can name. One entry per
 * DISTINCT state machine, not per action — `receipt_attach` and
 * `receipt_detach` describe the same two states from opposite directions and
 * share `receipt_state`, which is exactly what makes "Attached" impossible to
 * spell two ways.
 */
export const FINANCE_AUDIT_VALUE_KINDS = [
  "transaction_status", // setTransactionStatus — the one that started this
  "transaction_flow", // markAsTransfer / unmarkTransfer
  "receipt_state", // attachReceipt / linkReceipt / unlinkReceipt
  "personal_flag", // cards.flagPersonalCharge / unflagPersonalCharge
  "payer_attribution", // the `personId` half of the same flag
  "refund_state", // markAsRefund / unmarkRefund / the Increase auto-pairer
  "payout_processor", // markAsPayout / unmarkPayout
  "coding_state", // transactionCodings submit / approve / requestChanges
  "receipt_exception", // receiptExceptions attest / decide / withdraw
] as const;
export type FinanceAuditValueKind = (typeof FINANCE_AUDIT_VALUE_KINDS)[number];

// ── The vocabularies that have no home elsewhere ─────────────────────────────
// Each of these was, until now, spelled as an English literal at the write
// site — three copies of "Attached" in three files, two of "Not personal". A
// label with three spellings is a label that can be renamed in two of them.

/** Does this transaction have a receipt on it. */
export const RECEIPT_STATE_LABELS = {
  attached: "Attached",
  none: "None",
} as const;
export type ReceiptState = keyof typeof RECEIPT_STATE_LABELS;

/** Is this charge the cardholder's own money. */
export const PERSONAL_FLAG_LABELS = {
  personal: "Personal",
  not_personal: "Not personal",
} as const;
export type PersonalFlagState = keyof typeof PERSONAL_FLAG_LABELS;

/** Who a personal charge is billed to — the `personId` half of flagging. */
export const PAYER_ATTRIBUTION_LABELS = {
  unattributed: "Unattributed",
  billed_to_payer: "Billed to the named payer",
} as const;
export type PayerAttributionState = keyof typeof PAYER_ATTRIBUTION_LABELS;

/**
 * Refund pairing. The lowercase wording is the wording these rows have always
 * carried, kept verbatim: this change de-freezes labels, it does not restyle
 * them. Restyling is a separate decision, and making it here would have hidden
 * itself inside a migration.
 */
export const REFUND_STATE_LABELS = {
  none: "none",
  refunded: "refunded",
  refunded_auto: "refunded (auto-paired via Increase card_payment_id)",
} as const;
export type RefundState = keyof typeof REFUND_STATE_LABELS;

/**
 * The coding lifecycle AS THE TRAIL TELLS IT. A superset of
 * `TRANSACTION_CODING_STATUSES` by exactly two members, both of which are
 * events the stored status cannot express on its own:
 *   - `uncoded` — there was no coding row at all before this submission.
 *   - `resubmitted` — the row lands back in `submitted`, but arriving there
 *     after a send-back is a different fact from arriving there the first time,
 *     and the revision history is the whole point of these rows.
 * The three real statuses read their words from `TRANSACTION_CODING_STATUS_LABELS`
 * rather than restating them, so a rename there lands here for free.
 */
export const CODING_AUDIT_STATE_LABELS = {
  uncoded: "Uncoded",
  submitted: TRANSACTION_CODING_STATUS_LABELS.submitted,
  resubmitted: "Resubmitted",
  changes_requested: TRANSACTION_CODING_STATUS_LABELS.changes_requested,
  approved: TRANSACTION_CODING_STATUS_LABELS.approved,
} as const;
export type CodingAuditState = keyof typeof CODING_AUDIT_STATE_LABELS;

/**
 * Receipt exceptions are the ONE kind whose key carries a parameter, because
 * the thing a human reads is genuinely two facts: what happened to the
 * exception, and which reason it was filed under. The grammar is
 * `<state>` or `<state>:<reason>`, and it is closed — these seven forms are all
 * of them:
 *
 *   filed:<reason>              → the reason's own label ("Receipt lost")
 *   pending                     → "Awaiting approval"
 *   approved                    → "Approved"
 *   approved:<reason>           → "Approved — Receipt lost"
 *   rejected                    → "Rejected"
 *   withdrawn                   → "Withdrawn"
 *   withdrawn_amount_corrected  → the correction path's longer sentence
 *
 * `filed:<reason>` renders as the bare reason label on purpose: at filing time
 * the reason IS the whole statement, and that is what these rows have always
 * shown. The alternative — prefixing "Filed —" — would have been a copy change
 * smuggled in under a migration.
 */
export const RECEIPT_EXCEPTION_AUDIT_STATES = [
  "pending",
  "approved",
  "rejected",
  "withdrawn",
  "withdrawn_amount_corrected",
] as const;
export type ReceiptExceptionAuditState =
  (typeof RECEIPT_EXCEPTION_AUDIT_STATES)[number];

const RECEIPT_EXCEPTION_AUDIT_STATE_LABELS: Record<
  ReceiptExceptionAuditState,
  string
> = {
  pending: "Awaiting approval",
  approved: "Approved",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
  withdrawn_amount_corrected:
    "Withdrawn — amount corrected, re-file at the true amount",
};

/** The key for "an exception filed under this reason". */
export function receiptExceptionFiledKey(
  reason: ReceiptExceptionReason,
): string {
  return `filed:${reason}`;
}

/** The key for "an approver said yes to an exception filed under this reason". */
export function receiptExceptionApprovedKey(
  reason: ReceiptExceptionReason,
): string {
  return `approved:${reason}`;
}

// ── action (+ field) → which vocabulary ──────────────────────────────────────

/**
 * Which closed vocabulary this row's `beforeKey`/`afterKey` belong to, or
 * `null` when the row's two sides are genuinely free text.
 *
 * Derived rather than stored — see this file's header. `field` matters for
 * exactly one action: `personal_flag` writes TWO rows per flag, one about the
 * boolean and one about who the charge is billed to, and they are different
 * state machines that happen to share a verb.
 */
export function financeAuditValueKind(
  action: FinanceAuditAction,
  field: string | null | undefined,
): FinanceAuditValueKind | null {
  switch (action) {
    case "status_change":
      return "transaction_status";
    case "transfer_mark":
      return "transaction_flow";
    case "receipt_attach":
    case "receipt_detach":
      return "receipt_state";
    case "personal_flag":
      return field === "personId" ? "payer_attribution" : "personal_flag";
    case "refund_mark":
    case "refund_mark_auto":
      return "refund_state";
    case "payout_mark":
      return "payout_processor";
    case "coding_submit":
    case "coding_decide":
      return "coding_state";
    case "receipt_exception_attest":
    case "receipt_exception_decide":
    case "receipt_exception_withdraw":
      return "receipt_exception";
    // FREE TEXT, deliberately. `recode` (a category/budget NAME), `correction`
    // (an amount, a date, a merchant string, a description), `note_edit`,
    // `merchant_rename`, `coding_redact` (two published sentences),
    // `coding_amend` (a budget or category name, a route, an expense type),
    // `manual_create`, `budget_amount_change`, `budget_delete`,
    // `sale_items_set` (a composed basket), `sale_event_set` (an event's name).
    // See the header for why keying an entity's own name would be worse than
    // leaving it alone.
    default:
      return null;
  }
}

// ── The renderer ─────────────────────────────────────────────────────────────

function labelForKey(kind: FinanceAuditValueKind, key: string): string | null {
  switch (kind) {
    case "transaction_status":
      return TRANSACTION_STATUS_LABELS[key as TransactionStatus] ?? null;
    case "transaction_flow":
      return TRANSACTION_FLOW_LABELS[key as TransactionFlow] ?? null;
    case "receipt_state":
      return RECEIPT_STATE_LABELS[key as ReceiptState] ?? null;
    case "personal_flag":
      return PERSONAL_FLAG_LABELS[key as PersonalFlagState] ?? null;
    case "payer_attribution":
      return PAYER_ATTRIBUTION_LABELS[key as PayerAttributionState] ?? null;
    case "refund_state":
      return REFUND_STATE_LABELS[key as RefundState] ?? null;
    case "payout_processor":
      return PAYOUT_PROCESSOR_LABELS[key as PayoutProcessor] ?? null;
    case "coding_state":
      return CODING_AUDIT_STATE_LABELS[key as CodingAuditState] ?? null;
    case "receipt_exception": {
      const [state, reason] = key.split(":") as [string, string | undefined];
      if (reason !== undefined) {
        const reasonLabel =
          RECEIPT_EXCEPTION_REASON_LABELS[reason as ReceiptExceptionReason];
        if (!reasonLabel) return null;
        if (state === "filed") return reasonLabel;
        if (state === "approved") return `Approved — ${reasonLabel}`;
        return null;
      }
      return (
        RECEIPT_EXCEPTION_AUDIT_STATE_LABELS[
          state as ReceiptExceptionAuditState
        ] ?? null
      );
    }
  }
}

/**
 * THE ONE PLACE an audit row's before/after becomes words. Every surface that
 * shows this trail goes through here (via `finances.financeAuditTrail`, which
 * renders server-side so no client ever holds a key it could spell its own
 * way) — a label cannot be produced two ways if there is only one producer.
 *
 * Falls back to the frozen string whenever the key can't be resolved, which
 * covers the two cases that actually happen: a row written before this shipped
 * and never backfilled, and a key naming a state the vocabulary has since
 * retired. `key` alone is the last resort — better a raw `"reconciled"` on
 * screen than a blank where a fact used to be.
 */
export function financeAuditValueLabel(
  kind: FinanceAuditValueKind | null | undefined,
  key: string | null | undefined,
  frozen: string | null | undefined,
): string | null {
  if (kind && key) {
    const rendered = labelForKey(kind, key);
    if (rendered !== null) return rendered;
    return frozen ?? key;
  }
  return frozen ?? null;
}

// ── label → key, for the one-time backfill ───────────────────────────────────

/**
 * Every label each vocabulary has EVER shown, paired with the key it meant.
 * The backfill (`financeAuditKeyBackfill.ts`) reads legacy rows through this
 * table; nothing else should.
 *
 * HISTORICAL LABELS ARE INCLUDED, and that is the whole reason this table
 * exists rather than inverting `*_LABELS` at runtime: `"Reconciled"` is not any
 * status's label any more, and it is exactly the string most of the backlog
 * carries.
 *
 * Stored as PAIRS, not an object literal, on purpose: an object literal with a
 * repeated label would silently keep the last one and the ambiguity would never
 * surface. `assertUnambiguous` below refuses to build the lookup if two states
 * in one vocabulary ever shared a word — which is the claim the backfill's
 * safety rests on, checked rather than assumed.
 */
export const FINANCE_AUDIT_LABEL_ALIASES: Record<
  FinanceAuditValueKind,
  readonly (readonly [label: string, key: string])[]
> = {
  transaction_status: [
    ...TRANSACTION_STATUSES.map(
      (s) => [TRANSACTION_STATUS_LABELS[s], s] as const,
    ),
    // #717 — `reconciled` was called this until 2026-08-14. The single reason
    // this whole file exists.
    ["Reconciled", "reconciled"] as const,
  ],
  transaction_flow: [
    // These rows never held a label at all: `markAsTransfer` wrote the raw
    // enum into the display field, so the trail has been showing bookkeepers
    // the word "outflow" since the day it shipped. The keys were already
    // right; only the rendering was missing.
    ...TRANSACTION_FLOWS.map((f) => [f as string, f as string] as const),
    // …and the labels they render as from today on, so a row written after
    // this shipped is still mappable if it ever loses its key.
    ...TRANSACTION_FLOWS.map((f) => [TRANSACTION_FLOW_LABELS[f], f] as const),
  ],
  receipt_state: Object.entries(RECEIPT_STATE_LABELS).map(
    ([k, l]) => [l, k] as const,
  ),
  personal_flag: Object.entries(PERSONAL_FLAG_LABELS).map(
    ([k, l]) => [l, k] as const,
  ),
  payer_attribution: Object.entries(PAYER_ATTRIBUTION_LABELS).map(
    ([k, l]) => [l, k] as const,
  ),
  refund_state: Object.entries(REFUND_STATE_LABELS).map(
    ([k, l]) => [l, k] as const,
  ),
  payout_processor: PAYOUT_PROCESSORS.map(
    (p) => [PAYOUT_PROCESSOR_LABELS[p], p] as const,
  ),
  coding_state: Object.entries(CODING_AUDIT_STATE_LABELS).map(
    ([k, l]) => [l, k] as const,
  ),
  receipt_exception: [
    ...RECEIPT_EXCEPTION_REASONS.flatMap(
      (r) =>
        [
          [
            RECEIPT_EXCEPTION_REASON_LABELS[r],
            receiptExceptionFiledKey(r),
          ] as const,
          [
            `Approved — ${RECEIPT_EXCEPTION_REASON_LABELS[r]}`,
            receiptExceptionApprovedKey(r),
          ] as const,
        ] as const,
    ),
    ...RECEIPT_EXCEPTION_AUDIT_STATES.map(
      (s) => [RECEIPT_EXCEPTION_AUDIT_STATE_LABELS[s], s] as const,
    ),
  ],
};

/**
 * Build one vocabulary's label → key lookup, refusing to build it at all if a
 * label ever meant two different things. Two labels mapping to ONE key is fine
 * and expected — that is what a rename looks like ("Reconciled" and "Closed"
 * are both `reconciled`). One label mapping to TWO keys is the case that makes
 * a backfill a guess, and there is no honest way to guess it, so this throws
 * instead and the migration stops before it starts.
 */
function assertUnambiguous(
  kind: FinanceAuditValueKind,
  pairs: readonly (readonly [string, string])[],
): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const [label, key] of pairs) {
    const seen = out.get(label);
    if (seen !== undefined && seen !== key) {
      throw new Error(
        `financeAuditValue: "${label}" is ambiguous in the ${kind} vocabulary ` +
          `— it has meant both "${seen}" and "${key}". A legacy audit row ` +
          `carrying that word cannot be keyed without guessing which state it ` +
          `recorded, so the backfill must handle this case explicitly rather ` +
          `than pick one.`,
      );
    }
    out.set(label, key);
  }
  return out;
}

const LABEL_LOOKUP: Record<
  FinanceAuditValueKind,
  ReadonlyMap<string, string>
> = Object.fromEntries(
  FINANCE_AUDIT_VALUE_KINDS.map((kind) => [
    kind,
    assertUnambiguous(kind, FINANCE_AUDIT_LABEL_ALIASES[kind]),
  ]),
) as Record<FinanceAuditValueKind, ReadonlyMap<string, string>>;

/**
 * The key a legacy row's frozen label meant, or `null` when this vocabulary has
 * never shown that word. `null` is a real answer, not a failure: a row written
 * by a writer that has since changed its wording is left exactly as it is,
 * still rendering its frozen string, rather than being keyed to a state nobody
 * can prove it recorded.
 */
export function financeAuditKeyFromLabel(
  kind: FinanceAuditValueKind,
  label: string | null | undefined,
): string | null {
  if (label == null) return null;
  return LABEL_LOOKUP[kind].get(label) ?? null;
}
