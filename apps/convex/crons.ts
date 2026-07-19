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

// Daily 07:00 UTC: backstop pull of Stripe Financial Connections transactions
// for every connected legacy account, in case a refresh webhook was missed.
// No-ops per account when STRIPE_SECRET_KEY is unset (local/dev).
crons.cron(
  "stripe FC transaction sync backstop",
  "0 7 * * *",
  internal.stripeFinance.syncAllAccounts,
  {},
);

// Daily 13:00 UTC = 9am EDT: nudge on stale reimbursement requests (still
// awaiting approval, or lines missing receipts). No-ops when RESEND_API_KEY
// is unset (local/dev).
crons.cron(
  "reimbursement reminders",
  "0 13 * * *",
  internal.reimbursements.sendReimbursementReminders,
  {},
);

// Daily 11:00 UTC = 7am EDT: auto-lock member cards whose receipt grace window
// (>7 days late) has lapsed with a receipt still missing. Uploading a receipt
// unlocks the card.
crons.cron(
  "card receipt auto-lock",
  "0 11 * * *",
  internal.cards.autoLockOverdueCards,
  {},
);

// Daily 11:30 UTC = 7:30am EDT: advance the receipt-reminder timeline (day-1
// flag / day-3 escalate) for card charges still missing a receipt, emailing
// the cardholder when a charge crosses a checkpoint. Terminal day-7 handling
// stays in the auto-lock cron above; uploading a receipt unlocks/clears the
// timeline immediately via `attachReceipt`, well ahead of either sweep.
crons.cron(
  "card receipt reminder sweep",
  "30 11 * * *",
  internal.cards.sendReceiptReminders,
  {},
);

// Daily 08:00 UTC: backstop pull of Increase card charges/refunds for every
// provisioned account, in case a `transaction.created` webhook was dropped
// (e.g. a swallowed error in `ingestIncreaseCardTransaction` — that path never
// throws out of the webhook, so a missed charge leaves no other trace). Mirrors
// the Stripe FC sync backstop above; safe to run repeatedly since it dedups on
// `by_external_id`. No-ops per account when its environment's Increase API key
// is unset (local/dev).
crons.cron(
  "increase card-charge reconciliation backstop",
  "0 8 * * *",
  internal.increase.backfillIncreaseCardTransactions,
  {},
);

// Daily 05:00 UTC: sweep rate-limit "attempt" rows older than their 1-hour
// window from reimbursementSubmitAttempts (#134) and cardDetailsRevealAttempts
// (#161) — both tables only ever grow otherwise.
crons.cron(
  "sweep rate-limit attempt tables",
  "0 5 * * *",
  internal.maintenance.sweepRateLimitAttempts,
  {},
);

// Hourly: AI auto-coding sweep — a QUIET BACKSTOP. New transactions get a
// suggestion within seconds of arriving via the debounced on-ingest sweep
// (`aiCodingData.scheduleSuggestionOnIngest`, called from the Increase
// webhook apply path and the manual-add mutation), so this hourly run
// usually finds nothing left to do. It still exists to catch anything ingest
// missed — a burst larger than the per-run batch cap, or a transaction that
// predates this feature — for newly-synced, still-`unreviewed` transactions
// with no `aiSuggestion` yet, schedule `aiCoding.suggestCodingSystem`
// (bounded batch, idempotent). No-ops when OPENROUTER_API_KEY is unset, matching
// aiCoding.ts's degrade pattern. The model only ever proposes a coding — a human
// accepts it in Reconcile (or requests one on demand via the grid's "Suggest"
// button).
crons.interval(
  "ai auto-coding sweep",
  { hours: 1 },
  internal.aiCodingData.sweepUnsuggestedTransactions,
  {},
);

// Every 15 min: poll Givebutter for new/checked-in tickets on every event whose
// campaign is still live (its event ended <7 days ago) and mirror them into the
// native tickets/RSVPs/rollups. Poll-only (Givebutter has no ticket webhook);
// idempotent via `ticketOrders.by_external_ref`. No-ops when GIVEBUTTER_API_KEY
// is unset (local/dev). The manual "Sync now" button keeps working past the
// 7-day cutoff for backfilling old campaigns.
crons.interval(
  "givebutter ticket sync",
  { minutes: 15 },
  internal.givebutterSync.syncAllGivebutterCampaigns,
  {},
);

export default crons;
