/**
 * The published month as a CSV — the download the owner described as the
 * point of the whole exercise: "it'll literally just be the same thing as the
 * CSV, with all the different columns we'd want."
 *
 * Two files per month, matching the page's two tabs:
 *   `/finances/<YYYY-MM>.csv`         the ledger
 *   `/finances/<YYYY-MM>/giving.csv`  the anonymous giving roll
 *
 * ── THE CSV IS THE COMPLETE ONE ──────────────────────────────────────────────
 * The HTML page caps how many lines it renders (`PUBLIC_PAGE_ENTRY_LIMIT`) so
 * a shared link can't take thirty seconds to paint. The CSV has no cap. If
 * those two ever disagree about what a month contained, the CSV is the
 * authority and the page says so — which is why the page's truncation notice
 * points here rather than paginating.
 *
 * Serialization goes through `@events-os/shared/csv`, which is
 * formula-injection-safe (a purpose beginning `=` is a real possibility in
 * free text, and a public download that executes in somebody's spreadsheet is
 * a genuine attack, not a hypothetical). One implementation for every export
 * in the app; this one does not get its own.
 */
import {
  ATTENDEE_AFFILIATION_LABELS,
  DOCUMENTATION_STATE_LABELS,
  EXPENSE_TYPE_LABELS,
  formatAffiliationMix,
  PUBLIC_GIFT_COLUMNS,
  PUBLIC_LEDGER_COLUMNS,
  toCsv,
  type CsvValue,
} from "@events-os/shared";
import type { PublicLedgerEntry, PublicLedgerGift } from "./publicLedgerPage";

const TZ = "America/New_York";

/** ISO-ish `YYYY-MM-DD` in the finance timezone — sortable, unambiguous, and
 *  the one date format a spreadsheet won't reinterpret by locale. */
function isoDate(ts: number): string {
  return new Date(ts).toLocaleDateString("en-CA", { timeZone: TZ });
}

/** Dollars as a plain decimal (`1234.56`), NOT `$1,234.56`. A currency-
 *  formatted string imports as text and can't be summed, which defeats the
 *  reason somebody downloads a ledger. The page renders the pretty version;
 *  the file renders the usable one. */
function dollars(cents: number): string {
  return (cents / 100).toFixed(2);
}

const DIRECTION_LABELS: Record<PublicLedgerEntry["direction"], string> = {
  out: "Out",
  in: "In",
  // Spelled out rather than "Internal": the column has to be legible to
  // somebody who opened the file with no idea what our conventions are.
  internal: "Not counted (internal)",
};

/** The ledger CSV. Column order is `PUBLIC_LEDGER_COLUMNS`, single-sourced
 *  with the page's table so the two can't drift. */
export function ledgerCsv(entries: PublicLedgerEntry[]): string {
  const rows: CsvValue[][] = entries.map((e) => [
    isoDate(e.occurredAt),
    DIRECTION_LABELS[e.direction],
    dollars(e.amountCents),
    e.counterparty ?? "",
    e.purpose ?? "",
    e.categoryLabel ?? "",
    e.fundLabel ?? "",
    e.budgetLabel ?? "",
    e.projectLabel ?? "",
    e.eventLabel ?? "",
    e.bookLabel,
    e.expenseType ? EXPENSE_TYPE_LABELS[e.expenseType] : "",
    e.travelFrom ?? "",
    e.travelTo ?? "",
    e.headcount ?? "",
    // NAMES ARE NOT AVAILABLE HERE AND THAT IS STRUCTURAL — the published row
    // never carried them (`schema/publicLedger.ts`). This column is the
    // affiliation mix, or the description of a group too large to enumerate.
    formatAffiliationMix(e.affiliationMix, ATTENDEE_AFFILIATION_LABELS) ??
      e.groupDescription ??
      "",
    e.documentation ? DOCUMENTATION_STATE_LABELS[e.documentation] : "",
    e.reconstructed
      ? "Rebuilt from records"
      : e.nonDiscretionaryFee
        ? "Processor fee"
        : "Captured live",
  ]);
  return toCsv([...PUBLIC_LEDGER_COLUMNS], rows);
}

/** The giving roll CSV. Four columns and a book, because there is genuinely
 *  nothing else in a published gift entry — see `schema/publicLedger.ts` on
 *  why no donor field is written in the first place. */
export function givingCsv(gifts: PublicLedgerGift[]): string {
  const rows: CsvValue[][] = gifts.map((g) => [
    isoDate(g.occurredAt),
    dollars(g.amountCents),
    g.method ?? "",
    g.designation ?? "",
    g.bookLabel,
  ]);
  return toCsv([...PUBLIC_GIFT_COLUMNS], rows);
}
