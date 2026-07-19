/**
 * Curated one-time backfill data from Partiful/Givebutter exports (2026-07-19).
 * Contains contact PII — private repo; trimmed to needed fields.
 *
 * The dataset → native-event mapping table, owner-confirmed from screenshots
 * on 2026-07-19. `historicalBackfill.runAttendanceBackfill` uses it as a SAFETY
 * NET: the caller passes an explicit `eventId` (chosen from
 * `listEventsForMapping`'s discovery output), and the runner verifies that
 * event's name + date actually match this table before writing anything —
 * throwing `MAPPING_MISMATCH` otherwise, so a mis-picked event can't be
 * back-filled with the wrong guest list.
 *
 * `ptb` and `ptb_gb_tickets` intentionally map to the SAME event (Pop The
 * Balloon) — the Partiful guest list first, then the Givebutter ticket buyers;
 * both are idempotent, so running them in either order converges.
 *
 * The donor scope for the GIVING backfill (`runGivingBackfill`) is the NY
 * chapter, resolved by slug — see `NEW_YORK_CHAPTER_SLUG`.
 */

/** The NY chapter's slug — the owner-confirmed donor scope + the chapter whose
 *  events the attendance datasets map onto. Matches `seed.ts`'s own constant. */
export const NEW_YORK_CHAPTER_SLUG = "new-york";

/** The six attendance datasets, as string literals for an arg validator. */
export const ATTENDANCE_DATASETS = [
  "ltn",
  "nye",
  "eden",
  "ptb",
  "ptb_gb_tickets",
  "fieldday_tickets",
] as const;

export type AttendanceDataset = (typeof ATTENDANCE_DATASETS)[number];

/** One dataset's owner-confirmed native event: the exact name to match and the
 *  event's calendar date (UTC `YYYY-MM-DD`). */
export type EventMapping = {
  /** Exact event name to match (compared trimmed, case-insensitive). */
  eventName: string;
  /** UTC calendar date `YYYY-MM-DD` the event is expected to fall on. */
  eventDate: string;
};

/** dataset → native event. Confirmed by the owner 2026-07-19. */
export const MAPPING: Record<AttendanceDataset, EventMapping> = {
  ltn: { eventName: "Love Thy Neighbor 2025", eventDate: "2025-09-20" },
  nye: { eventName: "Crossover Night 2026", eventDate: "2025-12-31" },
  eden: { eventName: "Eden", eventDate: "2026-05-31" },
  ptb: { eventName: "Pop The Balloon", eventDate: "2025-12-06" },
  ptb_gb_tickets: { eventName: "Pop The Balloon", eventDate: "2025-12-06" },
  fieldday_tickets: { eventName: "Field Day", eventDate: "2026-08-08" },
};
