/**
 * Date/time formatting helpers. All date display in the app routes through here
 * so formatting stays consistent. Timestamps are epoch milliseconds.
 */
import { zonedParts, zonedTimeToUtc } from "@events-os/shared";

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** e.g. "Mar 14, 2026" */
export function formatDate(ts: number): string {
  const d = new Date(ts);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

/** e.g. "9:05 AM" (12h with AM/PM). */
export function formatTime(ts: number): string {
  const d = new Date(ts);
  const h24 = d.getHours();
  const ampm = h24 >= 12 ? "PM" : "AM";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${h12}:${mm} ${ampm}`;
}

/** e.g. "Mar 14, 2026 · 09:05" */
export function formatDateTime(ts: number): string {
  return `${formatDate(ts)} · ${formatTime(ts)}`;
}

/* ── Zoned formatting ────────────────────────────────────────────────────────
 * The formatters above read the DEVICE's clock, which is right for "sent 3
 * minutes ago" and wrong for anything that belongs to an event: a run sheet is
 * a fact about where the event happens, so it must read the same on every
 * screen in the room. Those callers pass an explicit zone, which they get from
 * `eventTimeZone(event)` in `@events-os/shared` — never a literal, and never
 * the device.
 */

/** True when this runtime can actually pin formatting to `timeZone` (IANA
 *  timezone data present). When false, the zoned formatters below fall back to
 *  device-local time — callers must label times accordingly, never claim a pin
 *  that isn't in effect. */
export function canFormatZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** e.g. "7:05 PM" in `timeZone`, whatever the device timezone. Falls back to
 *  device-local `formatTime` on runtimes without timezone data (see
 *  {@link canFormatZone}). */
export function formatTimeInZone(ts: number, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(ts);
  } catch {
    return formatTime(ts);
  }
}

/**
 * e.g. "Mar 14, 2026" in `timeZone` — the date-only sibling of
 * {@link formatTimeInZone}.
 *
 * A date is not a weaker version of a time: it is the SAME question with the
 * answer rounded, and it flips a whole day for an evening event read from a
 * zone ahead of it. A 7 PM Eastern event is already tomorrow in Tokyo, so a
 * device-local "Aug 30" on a list that the crew calls the 29th is a worse
 * error than an hour, not a smaller one.
 */
export function formatDateInZone(ts: number, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone,
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(ts);
  } catch {
    return formatDate(ts);
  }
}

/** e.g. "Sat, Mar 14" in `timeZone` — the weekday-led short form door lists use
 *  to let someone pick tonight's event off a phone at a venue entrance. */
export function formatWeekdayDateInZone(ts: number, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "short",
      month: "short",
      day: "numeric",
    }).format(ts);
  } catch {
    return formatDate(ts);
  }
}

/** e.g. "Mar 14, 2026 · 7:05 PM" in `timeZone` — the header companion to
 *  {@link formatTimeInZone}, so one page never shows two disagreeing clocks. */
export function formatDateTimeInZone(ts: number, timeZone: string): string {
  try {
    return `${formatDateInZone(ts, timeZone)} · ${formatTimeInZone(ts, timeZone)}`;
  } catch {
    return formatDateTime(ts);
  }
}

/**
 * The short zone name at `ts` — "EDT" in July, "EST" in January, "JST" in
 * Tokyo. Screens print it beside a clock so a leader who has travelled can see
 * at a glance WHOSE clock they are reading; without it, "5:00 PM" pinned to the
 * event's zone is indistinguishable from "5:00 PM" on their own phone, and the
 * fix would be invisible exactly to the person it protects. Empty string when
 * the runtime has no timezone data (nothing truthful to claim).
 */
export function zoneAbbreviation(ts: number, timeZone: string): string {
  try {
    const part = new Intl.DateTimeFormat("en-US", {
      timeZone,
      timeZoneName: "short",
    })
      .formatToParts(ts)
      .find((p) => p.type === "timeZoneName");
    return part?.value ?? "";
  } catch {
    return "";
  }
}

/** True when the timestamp is in the past (relative to now). */
export function isOverdue(ts: number): boolean {
  return ts < Date.now();
}

/**
 * Convert a YYYY-MM-DD input string into an epoch-ms timestamp (local midnight),
 * or null if it isn't a valid date. Used by date TextInputs.
 */
export function parseDateInput(str: string): number | null {
  const trimmed = str.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;
  const [y, m, d] = trimmed.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  if (Number.isNaN(date.getTime())) return null;
  return date.getTime();
}

/**
 * Combine a `YYYY-MM-DD` date string with a `HH:mm` (24-hour) time string into a
 * single epoch-ms timestamp, reading those parts as wall clock **in
 * `timeZone`** — or null if either part is malformed.
 *
 * `timeZone` is REQUIRED, and that is the whole point. This builds the event
 * start anchor every run-of-show time is derived from; when it used
 * `new Date(y, mo, da, h, mi)` a leader on a Pacific phone typing "7:00 PM"
 * created an event at 10:00 PM Eastern — the event silently moved, and nobody
 * in the org's own timezone could see it happen. A required argument means a
 * new call site cannot forget: it is a compile error, not a wrong timestamp.
 * Callers get the zone from `eventTimeZone(event)` in `@events-os/shared`.
 */
export function parseDateTimeInput(
  dateStr: string,
  timeStr: string,
  timeZone: string,
): number | null {
  const d = dateStr.trim();
  const t = timeStr.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  if (!/^\d{1,2}:\d{2}$/.test(t)) return null;
  const [y, mo, da] = d.split("-").map(Number);
  const [h, mi] = t.split(":").map(Number);
  if (h > 23 || mi > 59) return null;
  if (mo < 1 || mo > 12 || da < 1 || da > 31) return null;
  const ts = zonedTimeToUtc({ year: y, month: mo, day: da, hour: h, minute: mi }, timeZone);
  return Number.isNaN(ts) ? null : ts;
}

/* ── The Calendar bridge ─────────────────────────────────────────────────────
 * `Calendar` speaks one coordinate system: a day is the DEVICE-local midnight
 * of that day. That is right for it — it is a month grid, not a clock, and the
 * DUE-date cell and other callers rely on it. Rather than teach a presentation
 * component about timezones, event pickers translate at the boundary with the
 * two functions below, which are exact inverses of each other.
 */

/** The device-local midnight `Calendar` uses to mean "the calendar day `ts`
 *  falls on **in `timeZone`**". Without this an 11 PM ET event highlights the
 *  NEXT day on a Tokyo phone. */
export function zonedDayToCalendarMs(ts: number, timeZone: string): number {
  const p = zonedParts(ts, timeZone);
  return new Date(p.year, p.month - 1, p.day).getTime();
}

/** The inverse: a day `Calendar` emitted plus a wall-clock time, read as an
 *  instant in `timeZone`. */
export function calendarMsToZonedTs(
  dayMs: number,
  hour: number,
  minute: number,
  timeZone: string,
): number {
  const d = new Date(dayMs);
  return zonedTimeToUtc(
    { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(), hour, minute },
    timeZone,
  );
}

/** Replace the time-of-day of `ts` with `hour:minute` **in `timeZone`**,
 *  keeping the event-zone calendar day. The zoned sibling of
 *  `d.setHours(h, m)`. */
export function withZonedTime(
  ts: number,
  hour: number,
  minute: number,
  timeZone: string,
): number {
  const p = zonedParts(ts, timeZone);
  return zonedTimeToUtc(
    { year: p.year, month: p.month, day: p.day, hour, minute },
    timeZone,
  );
}

/** Render an epoch-ms timestamp as a YYYY-MM-DD string for date inputs. */
export function toDateInput(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Render an epoch-ms timestamp for a `<input type="datetime-local">` value. */
export function toDateTimeLocal(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(
    d.getDate(),
  )}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Parse a `datetime-local` value ("YYYY-MM-DDTHH:mm") into epoch ms, or null. */
export function fromDateTimeLocal(str: string): number | null {
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, y, mo, da, h, mi] = m.map(Number);
  const d = new Date(y, mo - 1, da, h, mi);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

/**
 * Parse a comma-separated list into trimmed, de-duped values, PRESERVING
 * case. The shared editor behind chip cells (People projects/comms,
 * Responsibilities roles) — one implementation so fan-out matching never
 * depends on which grid a value was typed in.
 */
export function parseList(raw: string): string[] {
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const s = part.trim();
    if (s) seen.add(s);
  }
  return Array.from(seen);
}
