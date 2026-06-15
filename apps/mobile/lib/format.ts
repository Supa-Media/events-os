/**
 * Date/time formatting helpers. All date display in the app routes through here
 * so formatting stays consistent. Timestamps are epoch milliseconds.
 */

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
