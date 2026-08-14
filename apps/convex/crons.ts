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

// Daily 10:00 UTC = 6am EDT: convert UNSUBSTANTIATED card charges into
// personal repayments — two clocks, one sweep. Still missing a receipt past
// the org-wide no-receipt deadline (`financeSettings.noReceiptAutoConvertDays`,
// off by default until central finance sets a number), OR still UNCODED past
// the accountable-plan deadline (`codingOverdueDays`, default 60 — the IRS
// safe harbor, which has no off switch). Runs BEFORE the auto-lock below so a
// just-converted charge — now a personal repayment, excluded from the
// missing-receipt set — no longer counts toward that card's lock in the same
// daily pass.
crons.cron(
  "no-receipt personal-charge auto-convert",
  "0 10 * * *",
  internal.cards.autoConvertOverdueReceipts,
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

// Daily 11:30 UTC = 7:30am EDT: advance the reminder timeline (day-1 flag /
// day-3 escalate) for card charges that still owe their cardholder something
// — a coding, a receipt, or an answer to a reviewer's send-back — emailing
// each cardholder ONE digest ("you have N charges to code") when a charge
// crosses a checkpoint. Terminal day-7 handling stays in the auto-lock cron
// above; uploading a receipt unlocks/clears the timeline immediately via
// `attachReceipt`, well ahead of either sweep.
crons.cron(
  "card receipt reminder sweep",
  "30 11 * * *",
  internal.cards.sendReceiptReminders,
  {},
);

// Daily 12:00 UTC = 8:00am EDT: the OTHER half of the coding loop. Everything
// above chases the person who spent the money; this one tells the people who
// can APPROVE what they spent it on that a queue is waiting. Nothing did
// before — `notifyCodingSentBack` mails the author when a coding comes back,
// and that was the whole notification surface, which is how six submitted
// codings sat unreviewed with zero approvals ever recorded.
//
// Deliberately AFTER the cardholder sweep at 11:30: if a charge gets coded
// this morning, the reviewer hears about it tomorrow rather than being nudged
// about a queue that is still being filled. Batched (one email per reviewer,
// never one per submission), capped at REMINDER_BATCH_LIMIT codings per run,
// and seed-only on first touch past REMINDER_SEED_ONLY_DAYS so arming it can
// never mail anyone about months of history.
crons.cron(
  "coding review reminder sweep",
  "0 12 * * *",
  internal.cards.sendCodingReviewReminders,
  {},
);

// Daily 08:00 UTC: backstop pull of Increase transactions — card charges AND
// all other account activity (inbound/outbound ACH, wires, fees, interest) —
// for every provisioned account (chapters + central), in case a
// `transaction.created` webhook was dropped (e.g. a swallowed error in
// `ingestIncreaseTransaction` — that path never throws out of the webhook, so
// a missed entry leaves no other trace). Mirrors the Stripe FC sync backstop
// above; safe to run repeatedly since it dedups on `by_external_id`. No-ops
// per account when its environment's Increase API key is unset (local/dev).
crons.cron(
  "increase transaction reconciliation backstop",
  "0 8 * * *",
  internal.increaseLedger.backfillIncreaseTransactions,
  {},
);

// Daily 09:30 UTC = 5:30am EDT: the MORNING RECONCILIATION ENGINE — detect
// Stripe payouts, book each chapter's share of the deposit as
// `payout_allocation` transfer pairs (net of fees), label the bank deposit,
// settle cross-book card spend (`auto_settlement`), and snapshot Increase
// bank balances — so every book reflects its true value by the time anyone
// wakes up. Deliberately AFTER the two bank-feed backstops above (Stripe FC
// 07:00, Increase 08:00) so the deposits it matches against have synced in.
// Ledger writes only — never real bank movement. Idempotent (deterministic
// transfer group ids); no-ops per part when its vendor key is unset;
// pausable from the accounts page (`financeSettings.autoReconciliationPaused`).
crons.cron(
  "morning reconciliation engine",
  "30 9 * * *",
  internal.reconciliation.runMorningReconciliation,
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

// Every 15 min: poll Givebutter for new/checked-in tickets on every event whose
// campaign is still live (its event ended <7 days ago) and mirror them into the
// native tickets/RSVPs/rollups. Poll-only (Givebutter has no ticket webhook);
// idempotent via `ticketOrders.by_external_ref`. No-ops when no API key is
// configured (in-app superuser setting or the GIVEBUTTER_API_KEY env var; see
// givebutterSync.ts's resolveGivebutterApiKey). The manual "Sync now" button
// keeps working past the 7-day cutoff for backfilling old campaigns.
crons.interval(
  "givebutter ticket sync",
  { minutes: 15 },
  internal.givebutterSync.syncAllGivebutterCampaigns,
  {},
);

// Hourly: the giving that belongs to NO event — the org's own Givebutter
// campaign, where recurring givers land. The sweep above only ever looked at
// campaigns an event page claims, so a donation to the general Public Worship
// campaign was never booked, while its money still counted on the cash side of
// the reconciliation (that figure is derived from Givebutter's transactions,
// not from ours). $50.00 of real recurring giving sat on the accounts page as
// "unaccounted for" with nothing naming it.
//
// HOURLY, not every 15 minutes. It reads Givebutter's whole transaction feed
// rather than one campaign's, and recurring giving arrives on a monthly
// schedule — a quarter-hour cadence would be four times the API traffic to
// find the same nothing. Idempotent (dedup on the Givebutter transaction id),
// so a missed hour costs nothing but an hour.
crons.interval(
  "givebutter general giving sync",
  { hours: 1 },
  internal.givebutterSync.syncGeneralGivebutterGiving,
  {},
);

// Every 15 min: safety net for stuck email-campaign sends
// (`campaigns.ts#sweepStuckSends`) — reschedules any campaign still
// "sending" whose `updatedAt` has gone quiet for 10+ minutes (a crash inside
// `materializeRecipients`/`deliverCampaignBatch` before it ever reached a
// mutation, the one gap the pipeline's own atomic-continuation scheduling
// can't close on its own). Idempotent either direction: re-materializing
// clears stale rows first, re-delivering is entirely "queued"-row-driven.
crons.interval(
  "stuck campaign send sweep",
  { minutes: 15 },
  internal.campaigns.sweepStuckSends,
  {},
);

// Hourly: get the Public Worship newsletter artwork into the campaign image
// library and thence into the built-in template — the half of that feature
// that otherwise only ever ran if a human typed `npx convex run --prod`.
//
// A cron rather than a registered migration ON PURPOSE (the reasoning is
// written out in full in `migrations/0052_import_newsletter_images.ts`'s
// header): the source is a per-send CDN that is expected to die, so the run
// MUST be retryable, and a ledgered migration is by definition a thing that
// happens exactly once. It also keeps eleven third-party HTTP requests out of
// the post-deploy `migrations:runPending` step, where a CDN outage would take
// a production deploy red.
//
// Costs one bounded indexed read per hour once complete — it checks the
// eleven `sourceKey`s are on file and returns without fetching or writing
// (Convex crons can't unregister themselves; this is the equivalent). While
// incomplete it re-fetches only the missing assets and logs LOUDLY on
// failure, which is the signal to upload those files by hand.
crons.interval(
  "newsletter artwork import",
  { hours: 1 },
  internal.migrations["0052_import_newsletter_images"]
    .ensureNewsletterImagesImported,
  {},
);

// Daily 06:00 UTC: Data Export sweep — purge storage blobs for `ready` jobs
// past their `expiresAt` (files.storageId cleared, status -> "expired"; the
// job ROW is never deleted — it's the extraction audit trail, see
// `schema/dataExports.ts`'s module doc) AND fail any `running` job that's
// gone quiet for 2+ hours (the runner action died without throwing, so
// nothing else would ever move it out of "running" — see
// `lib/exportRunner.ts`'s module doc). Bounded per run, safe to re-run.
crons.cron(
  "data export expiry + stuck-job sweep",
  "0 6 * * *",
  internal.lib.exportRunner.sweepExpiredExports,
  {},
);

// HOURLY on the hour: the giving-notification digest sweep. Every OTHER cron
// in this file names one UTC hour because it serves one audience; this one
// can't — a rule carries the local hour ITS recipients want (and a weekly rule
// its weekday), so the sweep has to look every hour and ask each rule whether
// its moment in America/New_York has arrived. `crons.cron("0 * * * *")` rather
// than `crons.interval({ hours: 1 })` deliberately: an interval is measured
// from deploy time and would drift off the hour boundary the local-hour match
// depends on.
//
// Idempotent: `claimDigest` moves a rule's marks in the same transaction it
// reads its window in, so a second pass inside the same local hour claims
// nothing. An empty DAILY digest is skipped (and leaves the watermark alone);
// an empty WEEKLY digest is sent on purpose — see
// `lib/givingNotificationRules.ts`. Returns before claiming ANYTHING when no
// Resend key resolves (local/dev), so an unmailable sweep can never eat a
// window; otherwise it costs one bounded indexed read per cadence per tick when
// no rule is due.
crons.cron(
  "giving notification digests",
  "0 * * * *",
  internal.givingNotificationDigests.sendGivingDigests,
  {},
);

// Daily 07:00 UTC: age out `pendingGifts` — debits that were authorised and
// never resolved (Stripe stops retrying after ~3 days and a longer outage loses
// the event entirely), plus the failed-debit tombstones kept to recognise a
// resent webhook. Without this a donor's name sits in a table no screen shows,
// forever. See `givingPending.MAX_PENDING_AGE_MS`.
//
// BELT AND BRACES, not a required ordering. This runs before the DEFAULT 08:00
// digest hour, but that is not a guarantee worth leaning on: `sendHourLocal` is
// user-settable and LOCAL, and the digest sweep is hourly, so a rule can fire
// ahead of this. It doesn't matter — `collectWindowPending` applies the same
// ceiling on the read, so an aged row is already uncountable whether or not
// this cron has run. This only keeps the table tidy.
crons.cron(
  "stranded pending-ACH sweep",
  "0 7 * * *",
  internal.givingPending.sweepStrandedPendingGifts,
  {},
);

// Daily 08:00 UTC: does Stripe still SEND us the events `http.ts` handles?
// A handler branch for an event nobody subscribed to fails silently — it
// raises nothing, logs nothing, and passes every test, because the tests call
// the handler directly. Production ran for a stretch with only the two
// `checkout.session.*` events enabled while six other branches sat dead (the
// 2026-08-09 audit; loss was $0 only because the recurring-giving path had
// never been used). This logs LOUDLY when a handled event has no enabled
// endpoint behind it. Read-only, and a no-op when STRIPE_SECRET_KEY is unset.
crons.cron(
  "stripe webhook coverage check",
  "0 8 * * *",
  internal.stripeWebhookCoverage.checkCoverage,
  {},
);

// Daily 13:00 UTC = 9am EDT: contractor payments waiting on a treasurer.
//
// Nudges at 3 days, escalates to central at 7, and NEVER auto-cancels. The
// asymmetry is deliberate: the cost of nagging an internal queue is mild
// annoyance, and the cost of silently killing a payment is that somebody who
// did the work doesn't get paid and nobody finds out until they ask. Each row
// is stamped when nudged (`reviewNudgeSentAt` / `reviewEscalatedAt`) so this
// gets louder on a schedule rather than every single run.
//
// Same hour as the reimbursement reminders above, on purpose — a treasurer
// gets one morning's worth of "here is what's waiting on you", not two.
crons.cron(
  "contractor payment review reminders",
  "0 13 * * *",
  internal.contractorPayments.sweepPendingReviews,
  {},
);

// Daily 04:00 UTC: destroy tax documents past their retention window.
//
// THE HALF OF THE RETENTION PROMISE THAT ACTUALLY PROTECTS ANYBODY. A policy
// that says "we keep W-9s for four years" and never deletes one is just an SSN
// sitting in a bucket forever. Deletes the FILE from storage and then the row,
// batched and self-scheduling; the sweep is a single indexed range scan over
// `by_purge_after`, so it costs nothing on the overwhelming majority of days
// when nothing is due.
crons.cron(
  "contractor tax document retention purge",
  "0 4 * * *",
  internal.contractorPayments.purgeExpiredTaxDocuments,
  {},
);

export default crons;
