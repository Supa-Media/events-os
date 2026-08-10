/**
 * Display rules for the project money page's Registrations section.
 *
 * Separate from `RegistrationsSection.tsx` because this app has NO rendered-
 * component tests — `jest.config.js` is `testEnvironment: "node"` — so the only
 * way to cover display logic is to keep it pure and import it from a sibling
 * test (the pattern `components/giving/csv.test.ts` established). Everything
 * here is a decision about what words appear on screen; nothing here touches
 * money arithmetic, which lives in `@events-os/shared`'s `registrations.ts`.
 */

export type RegistrationStatusLabelRow = {
  status: "paid" | "refunded" | "comped";
  refundReason: string | null;
};

/**
 * "Jan 29" for a registration in the current year, "Jan 29, 2024" otherwise.
 * A money row whose date could be any of three years is not a date, and a
 * course project can easily run in more than one.
 *
 * ── READ IN UTC, DELIBERATELY, AND NOT NEGOTIABLE ───────────────────────────
 * `registrations.registeredAt` is a UTC MIDNIGHT. The source is a Givebutter
 * export that states a DAY and no time, so the backfill parses
 * `YYYY-MM-DDT00:00:00.000Z` rather than invent an hour
 * (`lib/projectRegistrationBackfill.ts#utcDay`).
 *
 * Format that in the DEVICE's zone and every row renders a day early west of
 * Greenwich: `2026-01-26T00:00:00Z` is 7pm on Jan 25 in New York. The section
 * would have shown Jan 25 / Jan 28 while the export the reader is holding says
 * Jan 26 / Jan 29 — to the one person whose entire job is tying those six rows
 * back to that export. A date with no time carries no zone, so the only honest
 * way to render it is the zone it was stored in.
 *
 * `getUTCFullYear` for the same reason: a Jan 1 UTC registration is Dec 31
 * locally, so a device-zone year check flips the year label on exactly the
 * rows where being wrong is most confusing.
 *
 * This is NOT the app's usual rule. Event times use `formatDateInZone` with the
 * EVENT's zone (`lib/format.ts`) because an event happens somewhere. A
 * registration is a date on a receipt; it happened in UTC because that is where
 * we wrote it down.
 *
 * `now` is injectable so the test doesn't change answer on New Year's Day.
 */
export function registrationDayLabel(ts: number, now: number = Date.now()): string {
  const d = new Date(ts);
  const sameYear = d.getUTCFullYear() === new Date(now).getUTCFullYear();
  return d.toLocaleString("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/**
 * The status column: "paid", or "refunded — scholarship" when there's a reason.
 * One place beats a badge plus a footnote — the reason IS the status here, and
 * "refunded" without it reads like the class fell through.
 */
export function registrationStatusLabel(row: RegistrationStatusLabelRow): string {
  if (row.status === "paid") return "paid";
  return row.refundReason ? `${row.status} — ${row.refundReason}` : row.status;
}

/**
 * Whether the count line may say "scholarship" instead of "refunded".
 *
 * True only when there is at least one refund AND every refunded row says
 * scholarship. A single ordinary cancellation in the cohort makes the whole
 * line read "refunded" — better flatly accurate for all six than selectively
 * flattering for five, because the number next to the word is a money figure
 * and the word is what tells a reader where the money went.
 */
export function refundsAreScholarships(
  rows: readonly RegistrationStatusLabelRow[],
): boolean {
  const refunded = rows.filter((r) => r.status === "refunded");
  if (refunded.length === 0) return false;
  return refunded.every((r) => /scholarship/i.test(r.refundReason ?? ""));
}
