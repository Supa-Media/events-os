/**
 * MY TRANSACTIONS — "what does this charge still owe?", as a pure function.
 *
 * Phase 2 of `docs/plans/transaction-coding.md` makes My Transactions the
 * cardholder's whole job: the reminder email ("you have 3 charges to code")
 * deep-links straight here with `?filter=uncoded`, so the screen has to sort
 * the rows somebody must act on to the top and be able to show only those.
 * Both decisions have to be made BEFORE a row renders — which is why this is
 * a pure function over facts rather than something each row works out for
 * itself.
 *
 * THE WORDS ARE THE EMAIL'S WORDS. `apps/convex/lib/codingReminders.ts#outstandingLabel`
 * phrases the digest ("needs coding and a receipt", "sent back — needs your
 * edit"); a person who clicked a link that said that must find those exact
 * words waiting here, or they'll think they're on the wrong screen. If that
 * helper's phrasing moves, move this with it.
 *
 * THE PREDICATES ARE THE SERVER'S PREDICATES. `isSpendCharge` /
 * `codingRequired` mirror `finances.ts#isSpend` / `requiresCoding` /
 * `isUncoded` field for field, so this screen can never tell a cardholder a
 * charge is finished that the `CODING_REQUIRED` reconcile gate would refuse.
 *
 * Everything it reads now arrives on the list row itself (`codingState` and
 * `hasApprovedException` joined `txnSummary`), so ranking the whole list costs
 * zero extra reads. What deliberately does NOT arrive is the reviewer's
 * send-back NOTE: it matters only once somebody opens the charge, so the row
 * shows the STATE ("sent back — needs your edit") and `FinishChargeSheet`
 * fetches the words themselves for the one row being looked at.
 */
import type { FunctionReturnType } from "convex/server";
import { api } from "@events-os/convex/_generated/api";
import type { TransactionCodingStatus } from "@events-os/shared";
import type { BadgeTone } from "../../ui";

/** One row of the member's own ledger — the exact `personTransactions`
 *  projection (`txnSummary`), which now carries `codingState` and
 *  `hasApprovedException` off their denormalized columns, so this screen
 *  needs no per-row query to rank a row. */
export type MyTxnRow =
  FunctionReturnType<typeof api.finances.personTransactions>[number];

/** The facts `chargeTodo` reasons over — all of them straight off the list
 *  row. Deliberately a plain structural type rather than `MyTxnRow` itself:
 *  what the ranking depends on should be readable in one place, and the tests
 *  shouldn't have to fabricate thirty irrelevant fields to exercise it. */
export interface ChargeFacts {
  postedAt: number;
  flow: "inflow" | "outflow" | "transfer";
  status: string;
  isPersonal: boolean;
  hasReceipt: boolean;
  /** An APPROVED receipt exception documents a row exactly as a receipt does
   *  (`documentationState`) — nagging for a receipt anyway would be nagging
   *  for something the org already decided it doesn't need. */
  hasApprovedException?: boolean;
  /** `null` = no coding has ever been submitted. There is no "uncoded"
   *  literal — absence IS the uncoded state, on the wire and here. */
  codingStatus?: TransactionCodingStatus | null;
}

export type ChargeTodoKind =
  | "sent_back"
  | "needs_coding"
  | "needs_receipt"
  | "in_review"
  | "settled";

export interface ChargeTodo {
  kind: ChargeTodoKind;
  /** Badge text — the digest's vocabulary (see module doc). */
  label: string;
  tone: BadgeTone;
  /** Sort key, lower first: everything waiting on the cardholder outranks
   *  everything waiting on somebody else. */
  rank: number;
  /** Waiting on the CARDHOLDER — what `?filter=uncoded` narrows to. */
  actionable: boolean;
  /** Which steps of the sheet still have work in them, in the order the sheet
   *  asks for them. */
  outstanding: ("coding" | "receipt")[];
}

/** Mirrors `finances.ts#isSpend`: an outflow that isn't excluded and isn't a
 *  personal charge. A marked transfer already carries `flow: "transfer"`, so
 *  it falls out here without a separate test. */
export function isSpendCharge(f: ChargeFacts): boolean {
  return f.flow === "outflow" && f.status !== "excluded" && !f.isPersonal;
}

/** Mirrors `finances.ts#requiresCoding`: spend posted on/after the org's
 *  policy date (`financeSettings.codingRequiredSinceMs`, owner-decided
 *  2026-09-01). Pre-policy history is the voluntary on-ramp — it may carry a
 *  coding, it is never chased for one. */
export function codingRequired(f: ChargeFacts, sinceMs: number): boolean {
  return isSpendCharge(f) && f.postedAt >= sinceMs;
}

/**
 * What this charge still owes, and how loudly. Chase semantics, like the
 * server's `isUncoded`: a `reconciled` row has nobody left to chase, and a
 * coding sitting in review is waiting on the treasurer, not on the cardholder.
 */
export function chargeTodo(f: ChargeFacts, sinceMs: number): ChargeTodo {
  const closed = f.status === "reconciled";
  const documented = f.hasReceipt || f.hasApprovedException === true;
  const needsCoding =
    codingRequired(f, sinceMs) &&
    !closed &&
    (f.codingStatus == null || f.codingStatus === "changes_requested");
  const needsReceipt = isSpendCharge(f) && !closed && !documented;
  const outstanding: ("coding" | "receipt")[] = [
    ...(needsCoding ? (["coding"] as const) : []),
    ...(needsReceipt ? (["receipt"] as const) : []),
  ];

  // A send-back outranks everything: somebody read this charge, said what was
  // wrong with it, and is waiting. It is the one state where the cardholder
  // knows exactly what to do and nobody else can do it for them.
  if (f.codingStatus === "changes_requested" && !closed) {
    return {
      kind: "sent_back",
      label: "Sent back — needs your edit",
      tone: "danger",
      rank: 0,
      actionable: true,
      outstanding,
    };
  }
  if (needsCoding) {
    return {
      kind: "needs_coding",
      label: needsReceipt ? "Needs coding and a receipt" : "Needs coding",
      tone: "warn",
      rank: 1,
      actionable: true,
      outstanding,
    };
  }
  if (needsReceipt) {
    return {
      kind: "needs_receipt",
      label: "Needs a receipt",
      tone: "warn",
      rank: 2,
      actionable: true,
      outstanding,
    };
  }
  if (f.codingStatus === "submitted") {
    return {
      kind: "in_review",
      label: "Awaiting review",
      tone: "info",
      rank: 3,
      actionable: false,
      outstanding,
    };
  }
  if (f.codingStatus === "approved") {
    return {
      kind: "settled",
      label: "Done",
      tone: "success",
      rank: 4,
      actionable: false,
      outstanding,
    };
  }
  return {
    kind: "settled",
    label: documented ? "Documented" : "Nothing needed",
    tone: "neutral",
    rank: 5,
    actionable: false,
    outstanding,
  };
}

/** Actionable first (by rank), then newest first — the order somebody who
 *  followed the reminder email needs, without hiding the rest of their
 *  ledger. Stable: never mutates the input. */
export function sortByTodo<T>(
  rows: readonly T[],
  of: (row: T) => { rank: number; postedAt: number },
): T[] {
  return [...rows].sort((a, b) => {
    const x = of(a);
    const y = of(b);
    return x.rank - y.rank || y.postedAt - x.postedAt;
  });
}

export const CHARGE_FILTERS = ["all", "uncoded"] as const;
export type ChargeFilter = (typeof CHARGE_FILTERS)[number];

/**
 * The `?filter=` URL param the reminder email deep-links with
 * (`appUrl("/finances/my-transactions?filter=uncoded")`). Anything we don't
 * recognise falls back to "all" — a mistyped link must land somebody on their
 * transactions, never on an empty screen that reads as "you have none".
 */
export function parseChargeFilter(
  raw: string | string[] | undefined,
): ChargeFilter {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === "uncoded" ? "uncoded" : "all";
}
