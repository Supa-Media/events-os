/**
 * Curated one-time backfill data from Partiful/Givebutter exports (2026-07-19).
 * Contains contact PII — private repo; trimmed to needed fields.
 *
 * Row TYPES for the historical backfill seed modules. Both are derived from the
 * canonical import validators (via `Infer`) so the embedded data can never
 * drift from what `historicalBackfill.ts` feeds into the shared commit logic —
 * a change to either validator breaks the build here until the data matches.
 */
import type { Infer } from "convex/values";
import type { canonicalImportRowValidator } from "../../../givingImport";
import type { attendanceRowValidator } from "../../../eventAttendanceImport";

/** A giving.json row — the canonical import shape (gift/ticket/recurring),
 *  plus the optional mailing `address` the backfill plumbs onto donors. */
export type GivingBackfillRow = Infer<typeof canonicalImportRowValidator>;

/** A Partiful/Givebutter attendance row — the event-attendance import shape. */
export type AttendanceBackfillRow = Infer<typeof attendanceRowValidator>;

/**
 * One row of the org's genesis Relay bank history (Kansi's hand-categorized
 * export). Faithful to the source: `amountCents` stays SIGNED (deposits
 * positive, withdrawals negative) — `financeGenesisBackfill.runFinanceGenesisBackfill`
 * derives the txn `flow` + the non-negative stored amount from the sign. The
 * `category` is carried verbatim into the txn note; the app's `budgetCategories`
 * is a structured, fund-nested taxonomy the backfill deliberately does NOT
 * invent into.
 */
export type GenesisBankRow = {
  /** Human date, "Jun 9, 2025" style (America/New_York calendar day). */
  date: string;
  /** Month bucket label, "Jun 2025" style (display only). */
  month: string;
  /** The bank's own merchant/description string. */
  description: string;
  /** Payment rail: "ACH" | "VISA" | "Wire" | "" (unknown). */
  method: string;
  /** Direction as the financial manager labeled it. */
  type: "Deposit" | "Withdrawal";
  /** The financial manager's hand-assigned category, carried verbatim. */
  category: string;
  /** SIGNED integer cents: deposits > 0, withdrawals < 0. */
  amountCents: number;
};

/**
 * One owner-paid Love Thy Neighbor expense (a personal Zelle payment made on
 * the org's behalf). `amountCents` is a NON-NEGATIVE integer (these are always
 * expenses/outflows); `conf` is the Zelle confirmation code (the unique
 * idempotency key the runner turns into `genesis-ltn:<conf>`).
 */
export type GenesisLtnRow = {
  /** Human date, "Aug 24, 2025" style (America/New_York calendar day). */
  date: string;
  /** What the payment was for (becomes the txn description). */
  description: string;
  /** Non-negative integer cents. */
  amountCents: number;
  /** Zelle confirmation code — unique, the dedup key. */
  conf: string;
};
