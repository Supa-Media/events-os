import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Mailchimp audience sync — the local MIRROR of what we have told Mailchimp,
 * and the log of each sync run.
 *
 * ── Where this sits ─────────────────────────────────────────────────────────
 * Bulk email moved to Mailchimp on 2026-08-19 (`docs/plans/email-desk-parked.md`).
 * events-os no longer sends the newsletter; it keeps Mailchimp's list honest.
 * Two directions, and only these two:
 *
 *   PUSH  `mailchimpSync.ts#syncMailchimpAudience` → every eligible person is
 *         upserted onto the configured audience with merge fields (chapter,
 *         backer standing, role). A person who has BECOME ineligible — opted
 *         out, suppressed, lost their address — is pushed as `unsubscribed`
 *         rather than dropped, because dropping them from the payload would
 *         leave Mailchimp happily mailing them forever.
 *
 *   PULL  `http.ts`'s `/mailchimp/webhook` → an unsubscribe, a cleaned
 *         address, or a spam complaint IN MAILCHIMP writes a row into
 *         `emailSuppressions` (the same deployment-wide do-not-email ledger
 *         `schema/campaigns.ts` defines). That is the whole point of the
 *         pull-back: someone who unsubscribes from the newsletter must also
 *         stop receiving event blasts, and `blasts.ts` already reads that
 *         ledger. Without this the two systems would disagree and the app
 *         would be the one in the wrong.
 *
 * Campaign content, sends, opens and clicks live in Mailchimp and are NOT
 * mirrored here. This app deliberately does not become a reporting surface for
 * an email tool it doesn't run — see the gap list for why that was the
 * expensive half in the first place.
 */

/** How this integration may leave a member in Mailchimp. `"pending"` (double
 *  opt-in) is deliberately absent — see `@events-os/shared`'s
 *  `MailchimpMemberStatus`. */
export const MAILCHIMP_MEMBER_STATUSES = ["subscribed", "unsubscribed"] as const;

/**
 * One address we have pushed, and the state we last left it in.
 *
 * ── Why mirror at all, rather than just re-pushing everyone ─────────────────
 * Two jobs neither Mailchimp nor the `people` table can do alone:
 *
 *  1. **Find the leavers.** "Who did we tell Mailchimp about, who is no longer
 *     eligible?" is a set difference against the LAST push. Without a local
 *     record the only alternative is downloading the whole Mailchimp audience
 *     on every run.
 *  2. **Survive an address change.** When a person's address changes, the OLD
 *     address is still subscribed in Mailchimp under a row that no longer
 *     matches any person. Keyed by `email` (not by `personId`), this table
 *     still holds that row, so the old address gets unsubscribed on the next
 *     run instead of quietly receiving mail forever.
 *
 * `personId` is optional because the webhook writes rows for addresses that
 * may have no roster match at all (someone who signed up through a Mailchimp
 * form). Such a row exists purely so a later sync doesn't resurrect them.
 */
export const mailchimpMembers = defineTable({
  /** Normalized lowercase — the dedup key, matching `emailSuppressions.email`
   *  and `personEmails.email` so the three ledgers join on the same string. */
  email: v.string(),
  personId: v.optional(v.id("people")),
  status: v.union(...MAILCHIMP_MEMBER_STATUSES.map((s) => v.literal(s))),
  /** Why this address is `unsubscribed`, when we were the ones who set it —
   *  "opted out of marketing", "suppressed", "no deliverable address". Absent
   *  on a subscribed row, and on a row whose status came from Mailchimp's own
   *  webhook (the suppression ledger is the record there). */
  unsubscribeReason: v.optional(v.string()),
  lastSyncedAt: v.number(),
  /** Mailchimp's per-member rejection from the last batch (a role-based
   *  address, a previously-unsubscribed member Mailchimp refuses to re-add
   *  without their own consent, a malformed address). Cleared on the next
   *  successful push. Kept per-member because a batch of 500 succeeds as a
   *  whole while individual members inside it fail. */
  lastError: v.optional(v.string()),
})
  .index("by_email", ["email"])
  .index("by_person", ["personId"]);

/** Terminal + in-flight states of one sync run. */
export const MAILCHIMP_SYNC_STATUSES = ["running", "succeeded", "failed"] as const;

/**
 * One sync run — the "when did this last work, and what did it do" record the
 * integrations screen reads. Modelled on the shape `givebutterSync.ts` reports
 * after a sweep, kept as rows rather than a singleton so a failure is still
 * visible after the next run succeeds.
 */
export const mailchimpSyncRuns = defineTable({
  startedAt: v.number(),
  finishedAt: v.optional(v.number()),
  status: v.union(...MAILCHIMP_SYNC_STATUSES.map((s) => v.literal(s))),
  /** People who resolved to a deliverable, mailable address this run. */
  eligible: v.number(),
  /** Members upserted as `subscribed`. */
  pushed: v.number(),
  /** Previously-synced members flipped to `unsubscribed` this run. */
  unsubscribed: v.number(),
  /** Members Mailchimp rejected individually (see `mailchimpMembers.lastError`). */
  failed: v.number(),
  /** Whole-run failure (auth, network, a 4xx on the batch itself). */
  error: v.optional(v.string()),
  /** Absent when the nightly cron started it; set when a human pressed
   *  "Sync now" — the `givebutterSync.requestGivebutterSync` precedent. */
  triggeredByUserId: v.optional(v.id("users")),
}).index("by_startedAt", ["startedAt"]);
