/**
 * Recurring jobs. Convex cron expressions run in UTC; the team lives in
 * America/New_York, so the hours below are chosen for Eastern DAYLIGHT time
 * and land one hour earlier on the clock during standard time — acceptable
 * for both jobs (neither is minute-sensitive).
 */
import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Sunday 18:00 UTC = 2pm EDT (1pm EST): the week-ahead digest, timed for
// "Sunday after church, while people set up their week".
crons.cron(
  "weekly work digest",
  "0 18 * * 0",
  internal.reminders.sendWeeklyDigests,
  {},
);

// Daily 12:00 UTC = 8am EDT (7am EST): the due-today / due-tomorrow nudge.
crons.cron(
  "daily due-date reminders",
  "0 12 * * *",
  internal.reminders.sendDueReminders,
  {},
);

// Daily 09:00 UTC: sweep expired project email-action tokens (30-day TTL).
crons.cron(
  "purge expired email-action tokens",
  "0 9 * * *",
  internal.projectActions.purgeExpiredTokens,
  {},
);

export default crons;
