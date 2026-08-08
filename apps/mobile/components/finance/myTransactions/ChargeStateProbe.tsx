/**
 * ChargeStateProbe — an invisible subscriber that tells My Transactions what
 * one charge's coding and documentation state is.
 *
 * WHY THIS EXISTS. `finances.personTransactions` projects `txnSummary`, which
 * carries neither `transactions.codingState` nor the documentation state — so
 * the list query cannot say which charges still owe something. This screen has
 * to know that for EVERY row before it renders ANY row: it sorts the
 * actionable ones to the top and `?filter=uncoded` (the reminder email's deep
 * link) shows only those. A `useQuery` living inside a row component would
 * learn it too late and only for the rows that survived the filter — so the
 * subscription lives here, always mounted, reporting up to the parent, which
 * owns the ordering.
 *
 * BACKEND GAP, CLOSED FROM THE CLIENT: adding `codingState` + `documentation`
 * to `personTransactions` (as `listReconcile`'s `reconcileRow` already does
 * for the grid) makes this component and its callback disappear, and turns N
 * subscriptions into zero. That's a backend change; this PR is frontend-only.
 * Probes are mounted ONLY for rows that could plausibly owe something
 * (`isSpendCharge`), so N is the member's open spend, not their whole ledger.
 *
 * Both queries are member-safe on the caller's OWN rows by construction:
 * `transactionCodings.getForTransaction` is read-gated by the SUBMIT resolver
 * and `receiptExceptions.listForTransaction` by the ATTEST resolver — both of
 * which allow the transaction's own person precisely so a cardholder can read
 * the note explaining what to fix.
 */
import { useEffect } from "react";
import { useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import type { ChargeCodingState } from "./chargeTodo";

export function ChargeStateProbe({
  transactionId,
  hasReceipt,
  onResolved,
}: {
  transactionId: Id<"transactions">;
  /** A receipt outranks an exception, so there's nothing to ask about — same
   *  skip `ReceiptExceptionSection` applies. */
  hasReceipt: boolean;
  onResolved: (transactionId: string, state: ChargeCodingState) => void;
}) {
  const coding = useQuery(api.transactionCodings.getForTransaction, {
    transactionId,
  });
  const exceptions = useQuery(
    api.receiptExceptions.listForTransaction,
    hasReceipt ? "skip" : { transactionId },
  );

  const codingStatus = coding?.coding?.status ?? null;
  const reviewNote = coding?.coding?.reviewNote ?? null;
  const hasApprovedException =
    exceptions?.some((e) => e.status === "approved") ?? false;
  const hasPendingException =
    exceptions?.some((e) => e.status === "pending") ?? false;

  // Depend on the PRIMITIVES, not the query results: Convex hands back a new
  // object identity on every push, so an effect keyed on `coding` would report
  // up (and re-sort the list) on pushes that changed nothing.
  useEffect(() => {
    if (coding === undefined) return;
    onResolved(transactionId, {
      codingStatus,
      reviewNote,
      hasApprovedException,
      hasPendingException,
    });
  }, [
    coding,
    transactionId,
    codingStatus,
    reviewNote,
    hasApprovedException,
    hasPendingException,
    onResolved,
  ]);

  return null;
}
