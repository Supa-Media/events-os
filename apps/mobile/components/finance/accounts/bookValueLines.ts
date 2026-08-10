/**
 * READING ONE LINE OF A BOOK'S VALUE — every string the audit page prints.
 *
 * The owner, on 2026-08-10, looking at CENTRAL — EVERY LINE: "it doesn't even
 * give me like exacts of the transactions posted to it or sort of like the
 * coded rows and stuff like that… I just see like stripe rows and stuff like
 * that. Also, to understand why there's a huge $2,000 charge on it, are we
 * including transfers in this? I'm confused."
 *
 * Three separate failures, all of them this module's job:
 *
 *  1. "(no description)" on 7 of 13 rows. `description` is empty on every
 *     Relay-feed and Increase-card row; the merchant string lives in
 *     `merchantName`, and the card's last four, the cardholder and the
 *     bookkeeper's note are all right there too. `lineTitle` walks that chain
 *     and, when a row genuinely carries nothing, names the RAIL — "Unlabeled
 *     Relay bank feed row" at least says which statement to open.
 *  2. `stripe_fc` on screen. It is a source enum, it means the Relay bank feed
 *     read through Stripe Financial Connections, and no treasurer has ever
 *     called it that. `transactionSourceLabel` (shared, beside the enum) is the
 *     one spelling.
 *  3. The transfer question, which is the real one. The page's own explainer
 *     says internal transfers move cash rather than value, and then a
 *     -$2,003.95 "Internal transfer" sits in the ledger reducing book value.
 *     Both are true and the screen never said which was which. `transferNote`
 *     marks a transfer that counts and says why it is the exception.
 *
 * ── THE VOCABULARY IS `apps/convex/lib/bookBalance.ts`'s ────────────────────
 * That file decides what counts; this one only reads back its reasoning. Every
 * sentence here traces to a branch of `signedBookCents`, and nothing here
 * classifies anything — `transferNote` is handed the SIGNED amount the server
 * already computed and reads its sign, rather than working the side out again
 * from `transferDirection`. Two implementations of that rule is exactly the
 * bug this screen exists to catch.
 *
 * Pure, and in `.ts` rather than the screen, because `jest.config.js` is
 * `testEnvironment: "node"` — nothing here renders, so all of it is tested
 * (`bookValueLines.test.ts`) the way `components/giving/csv.ts` is.
 */
import {
  BOOK_VALUE_ZERO_REASON_LABELS,
  TRANSACTION_STATUS_LABELS,
  AUTO_TRANSFER_ORIGIN_LABELS,
  formatCents,
  transactionSourceLabel,
  type AutoTransferOrigin,
  type BookValueZeroReason,
  type TransactionStatus,
} from "@events-os/shared";

/**
 * The identity fields a book-value row carries. Structural so every list that
 * shows one passes straight in: `bookValueLines`' ledger and ignored rows, and
 * `bookValueBreakdown`'s inflows and double-count suspicions one rung up.
 *
 * The last two are optional because the grouped breakdown resolves no person
 * — everything above it is already on the transaction document and costs
 * nothing to carry.
 */
export interface BookValueLineIdentity {
  description: string;
  merchantName: string | null;
  merchantNameOverride: string | null;
  note: string | null;
  source: string;
  transferOrigin: string | null;
  cardLast4?: string | null;
  personName?: string | null;
}

/**
 * WHAT THIS ROW IS, in the order a reader would accept an answer.
 *
 * The bookkeeper's rename first, then the provider's own strings (the same
 * chain `displayMerchantName` resolves — the rename never overwrites
 * provenance), then the bookkeeper's note, and only then a generic that at
 * least names the rail. "(no description)" was none of those: it described the
 * app's own gap and told the reader nothing about the money.
 */
export function lineTitle(row: BookValueLineIdentity): string {
  const provided =
    trimmed(row.merchantNameOverride) ??
    trimmed(row.merchantName) ??
    trimmed(row.description) ??
    trimmed(row.note);
  if (provided) return provided;
  return `Unlabeled ${railLabel(row).toLowerCase()} row`;
}

/** True when `lineTitle` fell back to the note, so the detail line doesn't
 *  print the same sentence twice. */
export function titleUsedNote(row: BookValueLineIdentity): boolean {
  return (
    trimmed(row.merchantNameOverride) == null &&
    trimmed(row.merchantName) == null &&
    trimmed(row.description) == null &&
    trimmed(row.note) != null
  );
}

/**
 * WHICH RAIL CARRIED IT. An engine-written transfer names the engine step it
 * came from ("Auto settlement") rather than its `source`, which for every one
 * of them is the generic `"transfer"` and would tell a reader nothing about
 * why the row exists.
 */
export function railLabel(row: BookValueLineIdentity): string {
  const origin = row.transferOrigin;
  if (origin && origin in AUTO_TRANSFER_ORIGIN_LABELS) {
    return AUTO_TRANSFER_ORIGIN_LABELS[origin as AutoTransferOrigin];
  }
  return transactionSourceLabel(row.source);
}

/** The rail, then the review state — the two facts that say where to go look.
 *  Replaces `category · source · status`; the coding moved to its own line
 *  because it is the answer to a different question. */
export function railAndStatus(
  row: BookValueLineIdentity & { status?: string },
): string {
  const status = row.status;
  const statusLabel =
    status && status in TRANSACTION_STATUS_LABELS
      ? TRANSACTION_STATUS_LABELS[status as TransactionStatus]
      : status;
  return [railLabel(row), statusLabel].filter(Boolean).join(" · ");
}

/** The physical facts that pick this charge out of a statement when the
 *  merchant string didn't: whose card, which card, and whether there is
 *  paperwork behind it. Empty string when the row has none of them. */
export function lineIdentity(
  row: BookValueLineIdentity & { hasDocumentation?: boolean },
): string {
  return [
    row.cardLast4 ? `Card ···${row.cardLast4}` : null,
    row.personName,
    row.hasDocumentation ? "Receipt on file" : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * WHAT IT WAS CODED TO — the thing the owner asked for by name ("the coded
 * rows"). Category and budget are two different assertions (what KIND of
 * spend, and which pot it comes out of), so both are named, and a row missing
 * either says so rather than leaving a blank a reader has to interpret.
 */
export function codingLine(row: {
  category?: string;
  budgetName: string | null;
}): string {
  const category =
    row.category && row.category !== "Uncategorised" ? row.category : null;
  if (!category && !row.budgetName) return "Not coded to a category or budget";
  if (!row.budgetName) return `${category} · no budget named`;
  if (!category) return `No category · ${row.budgetName}`;
  return `${category} · ${row.budgetName}`;
}

/**
 * WHY A TRANSFER COUNTED, when the page's own explainer says transfers move
 * cash rather than value. Both statements are true, and until now the screen
 * never said which applied to the row in front of you.
 *
 * `signedBookCents` zeroes most transfer shapes — a payout allocation, a
 * balance settlement, a human-marked bank transfer, a payout deposit. What
 * reaches the ledger list is the handful it deliberately SIGNS, and each is a
 * different kind of exception, so each gets its own sentence.
 *
 * The side is read off the sign of the amount the server already computed.
 * Deriving it again here from `transferDirection` would be a second copy of
 * the rule, and a screen whose whole job is catching a book-value error is the
 * last place to keep one.
 *
 * Returns null for anything that isn't a transfer leg: ordinary spend needs no
 * explanation, and a badge on every row is a badge on none.
 */
export function transferNote(row: {
  flow: string;
  source: string;
  transferOrigin: string | null;
  amountCents: number;
  counterpartyName: string | null;
}): { badge: string; sentence: string } | null {
  if (row.flow !== "transfer") return null;
  const paid = row.amountCents < 0;
  const badge = paid ? "Counts against book value" : "Counts toward book value";
  const other = row.counterpartyName ?? "the other book";

  if (row.transferOrigin === "auto_settlement") {
    return {
      badge,
      sentence:
        `Cross-book card spend settled with ${other}. A settlement corrects who BORE a cost — ` +
        `one book's card paid for the other's spending — so it moves real weight, not just cash. ` +
        `That is why it counts here when an ordinary internal transfer does not.`,
    };
  }
  if (row.source === "repayment") {
    return {
      badge,
      sentence:
        "The offsetting credit for a personal charge. The charge really took money out of this " +
        "book; the repayment brings it back.",
    };
  }
  if (row.source === "reimbursement") {
    return {
      badge,
      sentence:
        "A legacy reimbursement payout leg. Reimbursements have posted as ordinary spend since " +
        "migration 0044 — this row predates that.",
    };
  }
  return {
    badge,
    sentence:
      `A recorded transfer ${paid ? "to" : "from"} ${other}, with a direction on it. ` +
      `A directed transfer between the books moves value from the side that gave to the side ` +
      `that received; only transfers between accounts we already own count as nothing.`,
  };
}

/** How much of the ledger tab is transfers, so the tab's explainer can say
 *  "one of these thirteen" instead of leaving the reader to spot it. */
export function countingTransfers(rows: { flow: string }[]): number {
  return rows.filter((r) => r.flow === "transfer").length;
}

/** The sentence behind a zero. A code, not a string, comes off the wire —
 *  see `BOOK_VALUE_ZERO_REASONS` for why the old single sentence was wrong. */
export function zeroReasonLabel(reason: BookValueZeroReason): string {
  return BOOK_VALUE_ZERO_REASON_LABELS[reason];
}

/** A signed book-value figure with its sign shown. `formatCents` renders a
 *  negative as `-$80.85` already; a positive gets a `+` so a credit sitting in
 *  a column of debits reads as one at a glance. */
export function signedAmount(cents: number): string {
  return cents > 0 ? `+${formatCents(cents)}` : formatCents(cents);
}

function trimmed(value: string | null | undefined): string | null {
  const t = value?.trim();
  return t ? t : null;
}
