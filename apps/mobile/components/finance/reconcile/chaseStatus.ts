/**
 * The one-line answer, under a cardholder's Chase button in the Book, to
 * "did the daily reminders actually go out?" Founder, 2026-11-08: "how do I
 * know that you chased them yesterday" — the follow-ups (`chaseFollowUps.ts`)
 * ran, but nothing in the app said so.
 *
 * Times are Eastern, like the 9am run that sends them.
 */
export type ChaseFollowUpStatus = {
  chasedAt: number;
  lastRemindedAt?: number;
  reminderCount: number;
  chaserTold: boolean;
};

const TIME_ZONE = "America/New_York";

function when(ts: number, now: number): string {
  const day = (t: number) =>
    new Date(t).toLocaleDateString("en-US", { timeZone: TIME_ZONE });
  const time = new Date(ts)
    .toLocaleTimeString("en-US", { timeZone: TIME_ZONE, hour: "numeric", minute: "2-digit" })
    // Some ICU builds put a narrow no-break space before AM/PM; \s covers it.
    .replace(/\s*AM$/, "am")
    .replace(/\s*PM$/, "pm");
  if (day(ts) === day(now)) return `today ${time}`;
  if (day(ts) === day(now - 24 * 60 * 60 * 1000)) return `yesterday ${time}`;
  const weekday = new Date(ts).toLocaleDateString("en-US", {
    timeZone: TIME_ZONE,
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  return `${weekday} ${time}`;
}

export function chaseStatusLine(s: ChaseFollowUpStatus, now: number): string {
  const chased = `Chased ${when(s.chasedAt, now)}`;
  if (s.reminderCount === 0 || s.lastRemindedAt == null) {
    return `${chased} · daily reminders start the next morning`;
  }
  const times = s.reminderCount === 1 ? "1 reminder" : `${s.reminderCount} reminders`;
  const told = s.chaserTold ? " · chaser emailed" : "";
  return `${chased} · ${times}, last ${when(s.lastRemindedAt, now)}${told}`;
}
