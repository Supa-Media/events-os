/**
 * Giving notification rules — "tell me when money comes in."
 *
 * One row is one standing instruction: *these people* hear about *these gifts*
 * at *this frequency*. Nothing here decides what a gift IS; eligibility is
 * deliberately total — every row `lib/givingDonors.ts#recordGiftForDonor`
 * writes is a candidate, including an add-on gift bundled into a ticket order
 * (which settles `donations` → gift) and an in-kind gift (a purchase made on
 * the org's behalf). A rule narrows that set by scope and by amount, and by
 * nothing else, because "which gifts count" is a question the giving ledger
 * already answers and this table has no business answering it twice.
 *
 * ── Scope carries an explicit sentinel, never a null ────────────────────────
 * `scope` is `"all" | "central" | Id<"chapters">`. The neighbouring giving
 * tables (`donors.scope`, `gifts.scope`) use the two-way
 * `Id<"chapters"> | "central"` union; a rule needs a third state — "every
 * book" — and that state is a STRING, not an absent field. A nullable
 * `chapterId` would make "central" and "everywhere" indistinguishable at the
 * validator, and every read would have to re-derive the difference from
 * context. See `lib/givingAccess.ts#GivingScope` for the two-way twin.
 *
 * ── `isActive`, never a delete ──────────────────────────────────────────────
 * The giving desk soft-deactivates everywhere (`sponsorPackages.active`,
 * `pledges.status`) and offers reactivation. A rule that fired for six months
 * is a record of who was told what, so it is turned OFF, not removed.
 *
 * ── Send-time fields ───────────────────────────────────────────────────────
 * `sendHourLocal`/`sendWeekday` are meaningless for `cadence: "immediate"` and
 * are simply ignored there. Both are in the org's timezone
 * (`America/New_York`, the same one `reminders.ts` and `crons.ts` reason in) —
 * a fundraising team reading "the Monday morning email" means Monday morning
 * where they are, not 08:00 UTC.
 *
 * `lastSentAt` is the digest watermark AND the idempotency key: a digest run
 * collects gifts created since it, and stamps it on success. See
 * `lib/givingNotificationRules.ts` for the window arithmetic and for why an
 * empty DAILY digest deliberately leaves the watermark alone.
 */
import { defineTable } from "convex/server";
import { v } from "convex/values";

/** How often a rule's recipients hear from it. */
export const GIVING_NOTIFICATION_CADENCES = [
  "immediate",
  "daily",
  "weekly",
] as const;

export type GivingNotificationCadence =
  (typeof GIVING_NOTIFICATION_CADENCES)[number];

/** A rule's reach: every book, the central book, or one chapter's book. */
export const givingNotificationScope = v.union(
  v.literal("all"),
  v.literal("central"),
  v.id("chapters"),
);

export const givingNotificationRules = defineTable({
  /** Human label — "Every gift to the dev team", "Big gifts to Shay + AJ". */
  name: v.string(),
  /** Lowercased, de-duplicated email addresses. Never empty (enforced at the
   *  mutation; a validator can't express "at least one"). */
  recipients: v.array(v.string()),
  cadence: v.union(
    ...GIVING_NOTIFICATION_CADENCES.map((c) => v.literal(c)),
  ),
  /** Floor in integer cents, INCLUSIVE — a rule set to $500 fires on a gift of
   *  exactly $500. Absent means every gift, at any amount. */
  minAmountCents: v.optional(v.number()),
  scope: givingNotificationScope,
  isActive: v.boolean(),
  /** 0–23 in `America/New_York`. Daily/weekly only; defaults to 8. */
  sendHourLocal: v.optional(v.number()),
  /** 0 = Sunday … 6 = Saturday, in `America/New_York`. Weekly only; defaults
   *  to 1 (Monday). */
  sendWeekday: v.optional(v.number()),
  /**
   * The digest watermark — the instant the last digest REPORTED up to. Absent
   * until the first digest sends. Never set for `immediate` rules.
   *
   * A fact about MONEY: the next window opens here, so it only ever moves when
   * gifts have actually been reported (or when a truncated read has consumed
   * them up to a known point). It is deliberately NOT the "already ran today"
   * marker — see `lastRunDayKey`.
   */
  lastSentAt: v.optional(v.number()),
  /**
   * True iff the run that set `lastSentAt` had to CUT its window short — so
   * that mark is a bookmark part-way through a period, not the edge of one.
   *
   * It exists because the window start is `min(now − period, lastSentAt)`: a
   * digest always covers at least its trailing period, however recent the
   * watermark is (see `lib/givingNotificationRules.ts#digestWindowStart`).
   * Applied to a mid-drain bookmark that floor is a WEDGE — the next run
   * reaches back past the cut, re-reads the very gifts that caused it, cuts at
   * the same instant, and mails the same 750 gifts again on every hourly tick
   * until the import ages out of the period. A week of duplicate digests from
   * one CSV.
   *
   * So the flag says which kind of mark this is, and a drain resumes from
   * exactly where it stopped. Cleared the moment a window completes, and by
   * every path that re-stamps `lastSentAt` as a fresh boundary (resume, cadence
   * change) — a stale `true` would pin a rule's window to its watermark and
   * quietly cost it the trailing-period floor.
   */
  lastWindowTruncated: v.optional(v.boolean()),
  /**
   * The instant an email from this rule was last actually DELIVERED to at
   * least one recipient. Absent until one has been.
   *
   * A fact about EMAIL — the third question this row has to answer, and the
   * one a human reading the desk actually asks ("has this thing ever gone
   * out?"). It exists because `lastSentAt` could not answer it without lying:
   * that field is a WATERMARK, and `setRuleActive` and a cadence change both
   * stamp it to `now` deliberately, so that resuming a rule reports from there
   * rather than replaying the backlog. Correct for the window; catastrophic as
   * a claim, because it made a rule that had never sent a single email display
   * "Last sent" with today's date the moment somebody paused and resumed it.
   *
   * This is the same split `lastRunDayKey` already made out of the same field,
   * for the same reason: one timestamp cannot be both a bookkeeping mark and an
   * assertion about the world. Only a `sendEmailReporting` that returned true
   * moves this one — a Resend outage, a missing key, or a released digest
   * leaves it exactly where it was.
   */
  lastDeliveredAt: v.optional(v.number()),
  /**
   * The local day-key (`YYYY-MM-DD`, `America/New_York`) of the last run that
   * CONSIDERED this rule, sent or not.
   *
   * A fact about SCHEDULING, and separate from `lastSentAt` on purpose. The
   * hourly sweep matches "at or after the send hour" so a dropped cron tick
   * can still catch up later the same day; that makes a rule due for every
   * remaining hour, and this is what stops it running twenty times. A skipped
   * empty daily stamps this and not `lastSentAt`, so the window carries
   * forward while the rule stops re-scanning.
   */
  lastRunDayKey: v.optional(v.string()),
  createdBy: v.id("users"),
  /**
   * Who last CHANGED this rule. Optional only because rules predate the field;
   * every write path sets it (`saveRule` on create and edit, `setRuleActive` on
   * both directions).
   *
   * `createdBy` alone was a misattribution waiting to happen once the gate
   * widened to `giving.view` (2026-08-10): a rule authored by the development
   * director and later re-pointed at somebody else's inbox still named the
   * director, and the desk had no field that disagreed. This is the "who
   * touched it last" the list renders; `givingNotificationRuleAudit` below is
   * the trail that survives the NEXT edit, because a single field is overwritten
   * by exactly the person you would want to catch.
   */
  updatedBy: v.optional(v.id("users")),
  createdAt: v.number(),
  updatedAt: v.number(),
})
  // The digest sweep's read: "every rule on this cadence" (a handful of rows).
  .index("by_cadence", ["cadence"])
  // The desk's list, and the immediate path's "which rules could care about a
  // gift in this book" — rules are per-scope and there are few of them.
  .index("by_scope", ["scope"])
  // The desk's list reads NEWEST first through this. Without it the list was an
  // unindexed scan taking the OLDEST rows, so past the cap a freshly created
  // rule was invisible in the UI — and therefore un-deactivatable — while it
  // carried on sending. (`saveRule` also refuses to create past `MAX_RULES`,
  // so the cap can't be reached in the first place; this is the second half of
  // the same fix.)
  .index("by_createdAt", ["createdAt"]);

/** What a breadcrumb records. `edited` carries the field diff; the two
 *  switch actions carry none, because the action IS the change. */
export const GIVING_NOTIFICATION_RULE_AUDIT_ACTIONS = [
  "created",
  "edited",
  "activated",
  "deactivated",
] as const;

/**
 * One immutable breadcrumb per HUMAN change to a notification rule — the
 * `giftAudit`/`donorAudit` shape, applied to the thing that decides who reads
 * donor names and gift amounts in their inbox.
 *
 * ── WHY A RULE NEEDS A TRAIL AND NOT JUST AN `updatedBy` ───────────────────
 * A rule is the one row on the giving desk that keeps acting on its own after
 * the person who wrote it is gone. The send paths bound each email by the
 * RULE's scope, never by the current reach of whoever authored it, and they do
 * not re-check anyone's access at send time — correctly, since a cron has no
 * caller. So a rule quietly re-pointed at a personal address goes on mailing
 * donor PII after that person's seat is revoked, and `updatedBy` would by then
 * name whoever edited it next.
 *
 * That risk existed before the gate widened to `giving.view` (2026-08-10) and
 * was survivable while only three seats could reach these mutations. Widening
 * the population is what made it worth a table.
 *
 * `changes` is a compact, display-ready field-level diff — pre-formatted
 * strings ("$500.00", "New York", "shay@x.org, aj@x.org"), never raw ids —
 * following `giftAudit.changes` exactly, so the trail still reads years later
 * without joining back to rows that may be gone. RECIPIENTS are diffed in full
 * on purpose: "who did this start mailing" is the whole question.
 *
 * Immutable — never patched, never deleted. Rules are never deleted either
 * (`isActive`), so these are never orphaned.
 */
export const givingNotificationRuleAudit = defineTable({
  ruleId: v.id("givingNotificationRules"),
  /** The rule's scope AT THE TIME of the change — the book whose gifts it could
   *  reach then. A `scope` change writes the row with the OLD one, so the trail
   *  reads "it was New York's, and here is it becoming central's". */
  scope: givingNotificationScope,
  actorUserId: v.id("users"),
  at: v.number(),
  action: v.union(
    ...GIVING_NOTIFICATION_RULE_AUDIT_ACTIONS.map((a) => v.literal(a)),
  ),
  changes: v.optional(
    v.array(
      v.object({
        field: v.string(),
        from: v.optional(v.string()),
        to: v.optional(v.string()),
      }),
    ),
  ),
})
  // The rule's own history, newest first.
  .index("by_rule", ["ruleId"])
  // "What has been done to the mailers lately", org-wide — the question asked
  // when a seat is revoked and somebody needs to know what that person aimed
  // where. NO QUERY READS EITHER INDEX YET: the trail is written now and read
  // from the Convex dashboard, because the record has to exist BEFORE the
  // incident that wants it, and a desk UI for it is a separate piece of work
  // nobody has asked for. Both indexes are here so that work is a read, not a
  // migration. Rules are few, so this stays small.
  .index("by_at", ["at"]);
