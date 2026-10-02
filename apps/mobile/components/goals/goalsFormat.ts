/**
 * Small display helpers shared by the Goals screens. Due dates are stored at
 * noon UTC on their calendar day (see `@events-os/shared#seedDueToMs`), so
 * they are read and written in UTC here and show the same day everywhere.
 */
import type { KeyResultStatus } from "@events-os/shared";
import type { BadgeTone } from "../ui";

export function keyResultTone(status: KeyResultStatus): BadgeTone {
  switch (status) {
    case "done":
      return "success";
    case "on_track":
      return "info";
    case "at_risk":
      return "warn";
    case "behind":
      return "danger";
    default:
      return "neutral";
  }
}

/** "Mar 31, 2027" for a stored due date. */
export function formatDue(ts: number): string {
  return new Date(ts).toLocaleDateString("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** A stored due date as the YYYY-MM-DD a text field shows. */
export function dueToInput(ts: number | undefined): string {
  if (ts == null) return "";
  return new Date(ts).toISOString().slice(0, 10);
}

/** Parse a typed YYYY-MM-DD into a stored due date; `null` if blank,
 *  `undefined` if it isn't a real date. */
export function inputToDue(raw: string): number | null | undefined {
  const s = raw.trim();
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return undefined;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ts = Date.UTC(y, mo - 1, d, 12);
  const back = new Date(ts);
  if (back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return undefined;
  return ts;
}

/** Parse a typed number ("12,000", "$5k" is not supported); `null` if blank. */
export function parseNumber(raw: string): number | null | undefined {
  const s = raw.replace(/[$,%\s]/g, "");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}
