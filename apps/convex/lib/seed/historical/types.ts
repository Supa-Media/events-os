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
