/**
 * The "apply by" day a job listing can carry (`jobListings.applyBy`), and how
 * the public `/team` pages word it. Kept apart from `hiring.ts` so the landing
 * bundle can import it on its own.
 */

/** The timezone an "apply by" day is read in. The org runs on Eastern time. */
const APPLY_BY_TIME_ZONE = "America/New_York";

/** True for a real calendar day written `YYYY-MM-DD` — the one shape a
 *  listing's `applyBy` is stored in. */
export function isValidApplyBy(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === mo - 1 &&
    date.getUTCDate() === d
  );
}

/**
 * The line a seat shows for its "apply by" date — "Apply by Nov 1" — or null
 * when there is none to show.
 *
 * Display only: nothing closes when the day passes. Once it has passed (in
 * Eastern time) the line simply disappears rather than telling people they are
 * late for a seat that is still open. The year is spelled out only when it
 * isn't the current one.
 */
export function applyByNotice(
  applyBy: string | undefined,
  now: Date = new Date(),
): string | null {
  if (!applyBy || !isValidApplyBy(applyBy)) return null;
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: APPLY_BY_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  if (applyBy < today) return null;
  const [y, mo, d] = applyBy.split("-").map(Number);
  const day = new Date(Date.UTC(y, mo - 1, d));
  const label = day.toLocaleDateString("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    ...(today.slice(0, 4) === applyBy.slice(0, 4) ? {} : { year: "numeric" }),
  });
  return `Apply by ${label}`;
}
